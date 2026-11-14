/** 滑动窗口速率计。用 100ms 分桶，避免每帧都做一次完整数组遍历。 */
export class RateMeter {
  private buckets = new Map<number, number>();

  constructor(private readonly bucketMs = 100) {}

  add(n = 1, now = performance.now()): void {
    const key = Math.floor(now / this.bucketMs) * this.bucketMs;
    this.buckets.set(key, (this.buckets.get(key) ?? 0) + n);
    if (this.buckets.size > 60) this.evict(now);
  }

  rate(now = performance.now(), windowMs = 2000): number {
    const from = now - windowMs;
    let total = 0;
    for (const [key, value] of this.buckets) {
      if (key >= from) total += value;
    }
    return total / (windowMs / 1000);
  }

  reset(): void {
    this.buckets.clear();
  }

  private evict(now: number): void {
    const cutoff = now - 6000;
    for (const key of this.buckets.keys()) {
      if (key < cutoff) this.buckets.delete(key);
    }
  }
}

export interface StatsSnapshot {
  rxBytes: number;
  txBytes: number;
  rxFrames: number;
  txFrames: number;
  badFrames: number;
  rxRate: number;
  frameRate: number;
}

/** 会话级统计：累计量 + 实时速率。 */
export class Stats {
  rxBytes = 0;
  txBytes = 0;
  rxFrames = 0;
  txFrames = 0;
  badFrames = 0;

  private readonly rxByteRate = new RateMeter();
  private readonly rxFrameRate = new RateMeter();

  addRx(bytes: number, now = performance.now()): void {
    this.rxBytes += bytes;
    this.rxByteRate.add(bytes, now);
  }

  addTx(bytes: number): void {
    this.txBytes += bytes;
  }

  addRxFrame(now = performance.now()): void {
    this.rxFrames += 1;
    this.rxFrameRate.add(1, now);
  }

  addTxFrame(): void {
    this.txFrames += 1;
  }

  addBadFrame(): void {
    this.badFrames += 1;
  }

  snapshot(now = performance.now()): StatsSnapshot {
    return {
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      rxFrames: this.rxFrames,
      txFrames: this.txFrames,
      badFrames: this.badFrames,
      rxRate: this.rxByteRate.rate(now),
      frameRate: this.rxFrameRate.rate(now),
    };
  }

  reset(): void {
    this.rxBytes = 0;
    this.txBytes = 0;
    this.rxFrames = 0;
    this.txFrames = 0;
    this.badFrames = 0;
    this.rxByteRate.reset();
    this.rxFrameRate.reset();
  }
}
