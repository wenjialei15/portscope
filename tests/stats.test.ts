import { describe, expect, it } from 'vitest';
import { Stats } from '../src/core/stats';

describe('统计分类', () => {
  it('CRC 错误与异常响应分开计数', () => {
    const s = new Stats();
    s.addCrcError();
    s.addCrcError();
    s.addException();

    const snap = s.snapshot();
    expect(snap.crcErrors).toBe(2);
    expect(snap.exceptions).toBe(1);
  });

  it('badFrames 保留为两者之和，兼容旧调用方', () => {
    const s = new Stats();
    s.addCrcError();
    s.addException();
    s.addException();

    expect(s.badFrames).toBe(3);
  });

  it('丢弃字节单独统计，不影响帧计数', () => {
    const s = new Stats();
    s.addRx(100);
    s.addDropped(16);

    const snap = s.snapshot();
    expect(snap.rxBytes).toBe(100);
    expect(snap.droppedBytes).toBe(16);
    expect(snap.rxFrames).toBe(0);
  });

  it('丢弃字节忽略非正数', () => {
    const s = new Stats();
    s.addDropped(0);
    s.addDropped(-5);
    expect(s.snapshot().droppedBytes).toBe(0);
  });

  it('reset 清零所有计数器', () => {
    const s = new Stats();
    s.addRx(10);
    s.addTx(20);
    s.addRxFrame();
    s.addTxFrame();
    s.addCrcError();
    s.addException();
    s.addDropped(5);

    s.reset();

    const snap = s.snapshot();
    expect(snap.rxBytes).toBe(0);
    expect(snap.txBytes).toBe(0);
    expect(snap.rxFrames).toBe(0);
    expect(snap.txFrames).toBe(0);
    expect(snap.crcErrors).toBe(0);
    expect(snap.exceptions).toBe(0);
    expect(snap.droppedBytes).toBe(0);
  });
});
