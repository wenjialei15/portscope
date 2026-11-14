import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replay } from '../src/core/recorder';
import type { Recording } from '../src/core/recorder';

/** node 环境下没有 window，产品代码用的是 window.setTimeout */
beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeRecording(events: Array<{ t: number; hex?: string; dir?: 'rx' | 'tx' }>): Recording {
  return {
    format: 'portscope-recording',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    parser: 'modbus',
    baud: 115200,
    events: events.map((e) => ({ t: e.t, dir: e.dir ?? 'rx', hex: e.hex ?? 'aa' })),
  };
}

describe('回放时序', () => {
  it('按累计间隔依次触发，而不是同一时刻全部触发', () => {
    const seen: number[] = [];
    const done = vi.fn();

    replay(makeRecording([{ t: 0 }, { t: 100 }, { t: 200 }]), (e) => seen.push(e.t), done);

    // t=0 的事件同步放行
    expect(seen).toEqual([0]);

    vi.advanceTimersByTime(99);
    expect(seen).toEqual([0]);

    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 100]);

    vi.advanceTimersByTime(100);
    expect(seen).toEqual([0, 100, 200]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('空录制也要回调 onDone，否则调用方永远停在回放中', () => {
    const done = vi.fn();
    replay(makeRecording([]), () => {}, done);

    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('超过 500ms 的空闲被压缩', () => {
    const seen: number[] = [];
    replay(makeRecording([{ t: 0 }, { t: 60_000 }]), (e) => seen.push(e.t), () => {});

    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(499);
    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 60_000]);
  });

  it('速度倍率按比例缩短等待', () => {
    const seen: number[] = [];
    replay(makeRecording([{ t: 0 }, { t: 100 }]), (e) => seen.push(e.t), () => {}, 2);

    vi.advanceTimersByTime(49);
    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 100]);
  });

  it('同一毫秒的连续事件批量放行，不排大量 0ms 定时器', () => {
    const seen: number[] = [];
    const events = Array.from({ length: 500 }, () => ({ t: 0 }));
    replay(makeRecording(events), (e) => seen.push(e.t), () => {});

    expect(seen).toHaveLength(500);
  });

  it('取消后不再触发任何事件，也不回调 onDone', () => {
    const seen: number[] = [];
    const done = vi.fn();

    const cancel = replay(makeRecording([{ t: 0 }, { t: 100 }, { t: 200 }]), (e) => seen.push(e.t), done);
    cancel();

    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([0]);
    expect(done).not.toHaveBeenCalled();
  });

  it('回放结束后重复推进定时器不会重复回调', () => {
    const done = vi.fn();
    replay(makeRecording([{ t: 0 }]), () => {}, done);

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(5_000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('事件按原始顺序回放', () => {
    const seen: string[] = [];
    const recording = makeRecording([
      { t: 0, hex: '01' },
      { t: 10, hex: '02' },
      { t: 10, hex: '03' },
      { t: 20, hex: '04' },
    ]);
    replay(recording, (e) => seen.push(e.hex), () => {});

    vi.advanceTimersByTime(100);
    expect(seen).toEqual(['01', '02', '03', '04']);
  });
});
