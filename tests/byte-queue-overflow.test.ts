import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../src/core/byte-queue';

describe('缓冲区溢出统计', () => {
  it('单次 push 超过容量时，被截掉的部分要计入丢弃字节', () => {
    const q = new ByteQueue(8);
    const data = new Uint8Array(20);
    for (let i = 0; i < data.length; i++) data[i] = i;
    q.push(data);

    expect(q.size).toBe(8);
    // 20 - 8 = 12 字节在这一步就被丢掉了
    expect(q.droppedBytes).toBe(12);
    // 保留的是最后 8 字节
    expect(Array.from(q.toArray())).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('多次溢出时累计丢弃字节', () => {
    const q = new ByteQueue(8);
    q.push(new Uint8Array(10)); // 截断丢 2
    expect(q.droppedBytes).toBe(2);

    q.push(new Uint8Array(12)); // 截断丢 4，容量已满再丢 8
    expect(q.droppedBytes).toBe(14);
    expect(q.size).toBe(8);
  });

  it('resetDropped 只清计数，不动数据', () => {
    const q = new ByteQueue(8);
    q.push(new Uint8Array(10));
    expect(q.droppedBytes).toBe(2);

    q.resetDropped();
    expect(q.droppedBytes).toBe(0);
    expect(q.size).toBe(8);
  });

  it('丢弃后仍保持数据顺序', () => {
    const q = new ByteQueue(4);
    q.push(new Uint8Array([1, 2, 3, 4, 5, 6]));

    expect(Array.from(q.toArray())).toEqual([3, 4, 5, 6]);
  });
});
