import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../src/core/byte-queue';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('ByteQueue', () => {
  it('按顺序写入与读取', () => {
    const q = new ByteQueue(64);
    q.push(bytes(1, 2, 3));
    q.push(bytes(4, 5));

    expect(q.size).toBe(5);
    expect(q.at(0)).toBe(1);
    expect(q.at(4)).toBe(5);
    expect(Array.from(q.slice(1, 3))).toEqual([2, 3, 4]);
  });

  it('discard 前进读指针且不残留旧数据', () => {
    const q = new ByteQueue(64);
    q.push(bytes(1, 2, 3, 4));
    q.discard(2);

    expect(q.size).toBe(2);
    expect(q.at(0)).toBe(3);
    expect(Array.from(q.toArray())).toEqual([3, 4]);
  });

  it('跨过内部末尾后仍能正确续写（环形回绕）', () => {
    const q = new ByteQueue(16);
    q.push(new Uint8Array(12).fill(0xaa));
    q.discard(10);
    q.push(bytes(9, 9, 9, 9, 9, 9, 9, 9));

    expect(q.size).toBe(10);
    expect(q.at(0)).toBe(0xaa);
    expect(q.at(1)).toBe(0xaa);
    expect(q.at(9)).toBe(9);
  });

  it('超出容量时丢弃最旧数据而不是抛错', () => {
    const q = new ByteQueue(8);
    q.push(bytes(1, 2, 3, 4, 5, 6));
    q.push(bytes(7, 8, 9, 10));

    expect(q.size).toBe(8);
    expect(q.droppedBytes).toBe(2);
    expect(Array.from(q.toArray())).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('单次写入超过容量时只保留尾部', () => {
    const q = new ByteQueue(4);
    q.push(bytes(1, 2, 3, 4, 5, 6));
    expect(Array.from(q.toArray())).toEqual([3, 4, 5, 6]);
  });

  it('clear 后回到初始状态', () => {
    const q = new ByteQueue(8);
    q.push(bytes(1, 2, 3));
    q.clear();
    expect(q.size).toBe(0);
    expect(q.at(0)).toBe(0);
  });

  it('slice 返回拷贝，不受后续写入影响', () => {
    const q = new ByteQueue(16);
    q.push(bytes(1, 2, 3, 4));
    const frame = q.slice(0, 4);
    q.push(bytes(5, 6, 7, 8));
    q.clear();
    expect(Array.from(frame)).toEqual([1, 2, 3, 4]);
  });
});
