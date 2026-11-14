import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../src/core/byte-queue';
import { withCrc } from '../src/core/crc';
import { modbusParser, buildReadHolding } from '../src/core/parsers/modbus';

function queueOf(bytes: number[]): ByteQueue {
  const q = new ByteQueue(4096);
  q.push(new Uint8Array(bytes));
  return q;
}

/** 一直解析直到切出第一帧，返回帧或 null */
function parseUntilFrame(q: ByteQueue) {
  for (let guard = 0; guard < 600; guard++) {
    const step = modbusParser.parse(q);
    if (step) {
      if (step.kind === 'frame') return step;
      q.discard(step.count);
      continue;
    }

    /*
     * 解析器在等一个「也许永远不会来的更长候选帧」。
     * 真机上由空闲定时器触发 onIdle，这里手动模拟一次超时重同步。
     */
    const idle = modbusParser.onIdle?.(q, 50) ?? null;
    if (!idle) return null;
    if (idle.kind === 'frame') return idle;
    q.discard(idle.count);
  }
  return null;
}

describe('Modbus 错帧恢复', () => {
  it('CRC 错误的帧不会阻塞后面的有效帧', () => {
    const bad = withCrc(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]));
    bad[bad.length - 1] ^= 0xff; // 破坏 CRC

    const good = buildReadHolding(1, 0, 4);
    const q = new ByteQueue(4096);
    q.push(bad);
    q.push(good);

    const step = parseUntilFrame(q);
    expect(step).not.toBeNull();
    expect(step?.decoded.status).toBe('ok');
    expect(step?.decoded.title).toContain('读保持寄存器');
  });

  it('噪声前缀不会让解析器误判', () => {
    const q = queueOf([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, ...Array.from(buildReadHolding(1, 0, 2))]);

    const step = parseUntilFrame(q);
    expect(step).not.toBeNull();
    expect(step?.decoded.status).toBe('ok');
  });

  it('数据不足时返回 null，不丢数据', () => {
    const frame = buildReadHolding(1, 0, 4);
    const q = new ByteQueue(4096);
    q.push(frame.slice(0, 5));

    expect(modbusParser.parse(q)).toBeNull();
    expect(q.size).toBe(5);
  });

  it('缓冲区堆满垃圾时不会无限等待', () => {
    const q = new ByteQueue(4096);
    // 400 字节纯噪声：所有候选长度都凑不出合法 CRC
    const noise = new Uint8Array(400);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) & 0xff;
    q.push(noise);

    const step = modbusParser.parse(q);
    // 关键：不能返回 null（那意味着永远等下去），必须给出 skip
    expect(step).toEqual({ kind: 'skip', count: 1 });
  });

  it('空闲超时后丢弃队首字节重同步', () => {
    const q = new ByteQueue(4096);
    // 队首是噪声，被猜出一个还要 132 字节的候选长度
    q.push(new Uint8Array([0x00, 0x01, 0x84, 0xf5, 0x01, 0x03]));

    // 数据刚到，还在等那个"更长的帧"
    expect(modbusParser.parse(q)).toBeNull();
    // 空闲还没到阈值，不应该急着丢
    expect(modbusParser.onIdle?.(q, 5)).toBeNull();
    // 超过阈值：放弃当前帧头
    expect(modbusParser.onIdle?.(q, 50)).toEqual({ kind: 'skip', count: 1 });
  });

  it('连续两帧粘连时逐帧切分', () => {
    const first = buildReadHolding(1, 0, 4);
    const second = buildReadHolding(2, 0, 2);
    const q = new ByteQueue(4096);
    q.push(first);
    q.push(second);

    const a = modbusParser.parse(q);
    expect(a?.kind).toBe('frame');
    if (a?.kind !== 'frame') return;
    q.discard(a.consumed);

    const b = modbusParser.parse(q);
    expect(b?.kind).toBe('frame');
    if (b?.kind !== 'frame') return;
    expect(b.decoded.fields.some((f) => f.k === '从站' && f.v.startsWith('2'))).toBe(true);
  });
});

describe('Modbus 帧状态分类', () => {
  it('异常响应被标为 exception，而不是 CRC 错误', () => {
    const exception = withCrc(new Uint8Array([0x01, 0x83, 0x02]));
    const q = new ByteQueue(64);
    q.push(exception);

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.decoded.status).toBe('exception');
    expect(step.decoded.title).toContain('异常响应');
  });

  it('正常响应标为 ok', () => {
    const resp = withCrc(
      new Uint8Array([0x01, 0x03, 0x08, 0x00, 0xfa, 0x02, 0x2a, 0x04, 0xb3, 0x00, 0x56]),
    );
    const q = new ByteQueue(64);
    q.push(resp);

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.decoded.status).toBe('ok');
  });
});

describe('写多个线圈 / 寄存器', () => {
  it('0x0F 按位打包解析，不是按寄存器', () => {
    // 写 10 个线圈到地址 0：0xCD 0x01 → 1100 1101, 0000 0001
    const frame = withCrc(
      new Uint8Array([0x01, 0x0f, 0x00, 0x00, 0x00, 0x0a, 0x02, 0xcd, 0x01]),
    );
    const q = new ByteQueue(64);
    q.push(frame);

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;

    const keys = step.decoded.fields.map((f) => f.k);
    expect(keys).toContain('B0');
    expect(keys).toContain('B1');
    // 不该出现寄存器字段
    expect(keys).not.toContain('R0');
    // 位展开后应当能看到 11001101
    expect(step.decoded.fields.some((f) => f.k === 'B0' && f.v.includes('11001101'))).toBe(true);
  });

  it('0x10 按 16 位寄存器解析', () => {
    // 写 2 个寄存器到地址 0：0x0032, 0x0064
    const frame = withCrc(
      new Uint8Array([0x01, 0x10, 0x00, 0x00, 0x00, 0x02, 0x04, 0x00, 0x32, 0x00, 0x64]),
    );
    const q = new ByteQueue(64);
    q.push(frame);

    const step = modbusParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;

    const r0 = step.decoded.fields.find((f) => f.k === 'R0');
    const r1 = step.decoded.fields.find((f) => f.k === 'R1');
    expect(r0?.v).toBe('50');
    expect(r1?.v).toBe('100');
  });
});
