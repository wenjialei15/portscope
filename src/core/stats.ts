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
  /** CRC 校验失败的帧：说明链路上有噪声或波特率不对 */
  crcErrors: number;
  /** Modbus 异常响应：链路正常，设备明确回了错误码 */
  exceptions: number;
  /** 因缓冲区容量上限被丢弃的字节 */
  droppedBytes: number;
  rxRate: number;
  frameRate: number;
}

/**
 * 会话级统计。
 *
 * 三类「异常」必须分开计数，因为排查方向完全不同：
 * - CRC 错误 → 查接线、波特率、终端电阻
 * - 异常响应 → 查从站地址、寄存器地址、寄存器数量
 * - 丢弃字节 → 查解析器是否卡住、缓冲区是否太小
 *
 * 早期版本把前两者都记进一个 badFrames，结果看到"异常帧 12"根本
 * 不知道是线缆问题还是请求参数写错了。
 */
export class Stats {
  rxBytes = 0;
  txBytes = 0;
  rxFrames = 0;
  txFrames = 0;
  crcErrors = 0;
  exceptions = 0;
  droppedBytes = 0;

  private readonly rxByteRate = new RateMeter();
  private readonly rxFrameRate = new RateMeter();

  /** 兼容旧字段：协议层面的问题总数（CRC 错误 + 异常响应） */
  get badFrames(): number {
    return this.crcErrors + this.exceptions;
  }

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

  addCrcError(): void {
    this.crcErrors += 1;
  }

  addException(): void {
    this.exceptions += 1;
  }

  addDropped(n: number): void {
    if (n > 0) this.droppedBytes += n;
  }

  snapshot(now = performance.now()): StatsSnapshot {
    return {
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      rxFrames: this.rxFrames,
      txFrames: this.txFrames,
      crcErrors: this.crcErrors,
      exceptions: this.exceptions,
      droppedBytes: this.droppedBytes,
      rxRate: this.rxByteRate.rate(now),
      frameRate: this.rxFrameRate.rate(now),
    };
  }

  reset(): void {
    this.rxBytes = 0;
    this.txBytes = 0;
    this.rxFrames = 0;
    this.txFrames = 0;
    this.crcErrors = 0;
    this.exceptions = 0;
    this.droppedBytes = 0;
    this.rxByteRate.reset();
    this.rxFrameRate.reset();
  }
}
