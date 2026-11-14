import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../src/core/byte-queue';
import { modbusParser, buildReadHolding, buildWriteRegister } from '../src/core/parsers/modbus';
import { withCrc } from '../src/core/crc';

const feed = (...chunks: number[][]): ByteQueue => {
  const q = new ByteQueue(4096);
  for (const chunk of chunks) q.push(new Uint8Array(chunk));
  return q;
};

const readResp = (): Uint8Array =>
  withCrc(new Uint8Array([0x01, 0x03, 0x08, 0x00, 0xfa, 0x02, 0x2a, 0x04, 0xb3, 0x00, 0x56]));

describe('Modbus RTU 帧切分', () => {
  it('识别读保持寄存器请求', () => {
    const q = new ByteQueue(64);
    q.push(buildReadHolding(1, 0, 4));

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.consumed).toBe(8);
    expect(step.decoded.title).toContain('读保持寄存器');
    expect(step.decoded.fields.some((f) => f.k === '数量' && f.v === '4')).toBe(true);
  });

  it('识别响应并提取 4 个寄存器通道', () => {
    const q = new ByteQueue(64);
    q.push(readResp());

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.consumed).toBe(13);
    expect(step.decoded.series).toHaveLength(4);
    expect(step.decoded.series.map((s) => s.value)).toEqual([0x00fa, 0x022a, 0x04b3, 0x0056]);
  });

  it('数据不足时返回 null，补齐后仍能切出完整帧', () => {
    const frame = readResp();
    const q = new ByteQueue(64);
    q.push(frame.slice(0, 5));

    expect(modbusParser.parse(q)).toBeNull();

    q.push(frame.slice(5));
    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.frame.length).toBe(13);
  });

  it('任意位置分片都不会拼错帧', () => {
    const frame = readResp();
    const q = new ByteQueue(64);
    let step = null;
    for (let i = 0; i < frame.length; i++) {
      q.push(frame.slice(i, i + 1));
      const result = modbusParser.parse(q);
      if (result?.kind === 'frame') step = result;
    }
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(Array.from(step.frame)).toEqual(Array.from(frame));
  });

  it('遇到噪声字节时逐字节重同步', () => {
    const q = feed([0xaa], Array.from(buildReadHolding(1, 0, 4)));

    const first = modbusParser.parse(q);
    expect(first).toEqual({ kind: 'skip', count: 1 });
    if (first?.kind !== 'skip') return;
    q.discard(first.count);

    const second = modbusParser.parse(q);
    expect(second?.kind).toBe('frame');
  });

  it('解析异常响应', () => {
    const q = new ByteQueue(64);
    q.push(withCrc(new Uint8Array([0x01, 0x83, 0x02])));

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.decoded.title).toContain('异常');
    expect(step.decoded.fields.some((f) => f.tone === 'err')).toBe(true);
  });

  it('解析写单寄存器请求', () => {
    const q = new ByteQueue(64);
    q.push(buildWriteRegister(1, 0, 500));

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.decoded.fields.some((f) => f.k === '写入值' && f.v.startsWith('500'))).toBe(true);
  });

  it('CRC 错误时不产出帧', () => {
    const frame = buildReadHolding(1, 0, 4);
    frame[frame.length - 1] ^= 0xff;
    const q = new ByteQueue(64);
    q.push(frame);

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('skip');
  });

  it('未知功能码直接跳过', () => {
    const q = feed([0x01, 0x63, 0x00, 0x00]);
    expect(modbusParser.parse(q)).toEqual({ kind: 'skip', count: 1 });
  });
});
