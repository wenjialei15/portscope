import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../src/core/byte-queue';
import { lineParser, rawParser } from '../src/core/parsers/raw';
import { getParser, PARSERS } from '../src/core/parsers';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('文本行解析器', () => {
  it('按换行切分并保留行内容', () => {
    const q = new ByteQueue(4096);
    q.push(ascii('temp=25.3,hum=55\r\n'));

    const step = lineParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.consumed).toBe(18);
    expect(step.decoded.title).toContain('temp=25.3');
  });

  it('从 key=value 中提取数值供波形使用', () => {
    const q = new ByteQueue(4096);
    q.push(ascii('temp=25.3 hum=55.5 volt=12.06\n'));

    const step = lineParser.parse(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.decoded.series).toEqual([
      { label: 'temp', value: 25.3 },
      { label: 'hum', value: 55.5 },
      { label: 'volt', value: 12.06 },
    ]);
  });

  it('没有换行时返回 null 继续等待', () => {
    const q = new ByteQueue(4096);
    q.push(ascii('partial line'));
    expect(lineParser.parse(q)).toBeNull();
  });

  it('连续多行逐帧产出', () => {
    const q = new ByteQueue(4096);
    q.push(ascii('a=1\nb=2\nc=3\n'));

    const titles: string[] = [];
    for (let i = 0; i < 3; i++) {
      const step = lineParser.parse(q);
      if (step?.kind !== 'frame') break;
      titles.push(step.decoded.title);
      q.discard(step.consumed);
    }
    expect(titles).toEqual(['a=1', 'b=2', 'c=3']);
  });
});

describe('原始流解析器', () => {
  it('flush 时把缓冲区全部作为一帧并清空', () => {
    const q = new ByteQueue(4096);
    q.push(new Uint8Array([1, 2, 3, 4, 5]));

    expect(rawParser.parse(q)).toBeNull();

    const step = rawParser.flush?.(q);
    expect(step?.kind).toBe('frame');
    if (step?.kind !== 'frame') return;
    expect(step.frame.length).toBe(5);
    expect(q.size).toBe(0);
  });

  it('空缓冲区不产出帧', () => {
    expect(rawParser.flush?.(new ByteQueue(64))).toBeNull();
  });

  it('统计可打印字符比例', () => {
    const q = new ByteQueue(64);
    q.push(ascii('AB'));
    const step = rawParser.flush?.(q);
    if (step?.kind !== 'frame') throw new Error('应有帧');
    expect(step.decoded.fields.find((f) => f.k === '可打印')?.v).toBe('100%');
  });
});

describe('解析器注册表', () => {
  it('包含三个内置解析器且 id 唯一', () => {
    const ids = PARSERS.map((p) => p.id);
    expect(ids).toEqual(['modbus', 'line', 'raw']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('未知 id 回退到第一个解析器', () => {
    expect(getParser('不存在').id).toBe('modbus');
  });
});
