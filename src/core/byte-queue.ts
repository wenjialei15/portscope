/**
 * 环形字节队列。
 *
 * 串口是字节流，协议解析需要「攒够再切」，所以必须有一个可增长的
 * 线性可读缓冲。这里用固定容量 + 读写指针的环形缓冲实现，容量上限
 * 保证长时间运行不会吃光内存：溢出时丢弃最旧的数据（对抓包工具而言，
 * 丢旧数据比 OOM 更合理）。
 */
export class ByteQueue {
  private buf: Uint8Array;
  private head = 0;
  private len = 0;
  private dropped = 0;

  constructor(readonly capacity = 1 << 20) {
    this.buf = new Uint8Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  /** 因容量上限被丢弃的字节数，用于在界面上提示数据不完整。 */
  get droppedBytes(): number {
    return this.dropped;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    if (chunk.length > this.capacity) {
      chunk = chunk.subarray(chunk.length - this.capacity);
    }

    if (this.len + chunk.length > this.capacity) {
      const overflow = this.len + chunk.length - this.capacity;
      this.dropped += overflow;
      this.discard(overflow);
    }

    if (this.head + this.len + chunk.length > this.buf.length) {
      this.compact();
    }

    this.buf.set(chunk, this.head + this.len);
    this.len += chunk.length;
  }

  /** 读取第 i 个字节（相对队首）。越界返回 0。 */
  at(i: number): number {
    return i >= 0 && i < this.len ? this.buf[this.head + i] : 0;
  }

  /** 只读视图，用于即时判断；不要长期持有。 */
  peek(n: number): Uint8Array {
    return this.buf.subarray(this.head, this.head + Math.min(n, this.len));
  }

  /** 拷贝一段数据。解析出的帧必须用 slice，避免被后续 push 覆盖。 */
  slice(start: number, count: number): Uint8Array {
    const from = this.head + Math.min(start, this.len);
    const to = Math.min(from + count, this.head + this.len);
    return this.buf.slice(from, to);
  }

  discard(n: number): void {
    const k = Math.min(n, this.len);
    this.head += k;
    this.len -= k;
    if (this.len === 0) this.head = 0;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }

  toArray(): Uint8Array {
    return this.slice(0, this.len);
  }

  private compact(): void {
    if (this.head === 0) return;
    this.buf.copyWithin(0, this.head, this.head + this.len);
    this.head = 0;
  }
}
