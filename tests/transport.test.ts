import { describe, expect, it } from 'vitest';
import { WebSerialTransport } from '../src/core/transport';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 最小可用的假串口。用真实的 ReadableStream / WritableStream 实现，
 * 这样 Web Serial 的流锁语义（getWriter 冲突、cancel 触发 cancel 回调）
 * 都会被如实复现——用简单对象 mock 是测不出这些问题的。
 */
class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  cancelCount = 0;
  closeCount = 0;
  written: number[] = [];

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(private readonly writeDelayMs = 0) {
    this.install();
  }

  private install(): void {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
      cancel: () => {
        this.cancelCount += 1;
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        this.written.push(chunk.length);
        if (this.writeDelayMs > 0) await tick(this.writeDelayMs);
      },
    });
  }

  push(bytes: Uint8Array): void {
    this.controller?.enqueue(bytes);
  }

  fail(err: unknown): void {
    this.controller?.error(err);
  }

  async open(): Promise<void> {
    this.install();
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.readable = null;
    this.writable = null;
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
}

function makeTransport(port: FakePort): WebSerialTransport {
  return new WebSerialTransport(port as unknown as SerialPort, { baudRate: 115200 });
}

describe('串口生命周期', () => {
  it('打开后能收到数据', async () => {
    const port = new FakePort();
    const t = makeTransport(port);
    const sizes: number[] = [];

    t.setHandlers({ onData: (c) => sizes.push(c.length), onClose: () => {} });
    await t.open();
    await tick();

    port.push(new Uint8Array([1, 2, 3]));
    await tick(10);

    expect(sizes).toEqual([3]);
    await t.close();
  });

  it('关闭时先取消 reader，否则 port.close() 会一直等锁', async () => {
    const port = new FakePort();
    const t = makeTransport(port);

    await t.open();
    await tick();
    await t.close();

    expect(port.cancelCount).toBe(1);
    expect(port.closeCount).toBe(1);
  });

  it('并发写入被串行化，不会因流锁冲突而失败', async () => {
    const port = new FakePort(5);
    const t = makeTransport(port);

    await t.open();
    await tick();

    await Promise.all([t.write(new Uint8Array([1])), t.write(new Uint8Array([2, 3]))]);

    expect(port.written).toEqual([1, 2]);
    await t.close();
  });

  it('关闭后可以重新连接', async () => {
    const port = new FakePort();
    const t = makeTransport(port);
    const sizes: number[] = [];

    t.setHandlers({ onData: (c) => sizes.push(c.length), onClose: () => {} });

    await t.open();
    await tick();
    await t.close();

    await t.open();
    await tick();
    port.push(new Uint8Array([9, 9]));
    await tick(10);

    expect(sizes).toEqual([2]);
    await t.close();
  });

  it('设备异常断开时上报原因，而不是静默卡住', async () => {
    const port = new FakePort();
    const t = makeTransport(port);
    const reasons: string[] = [];

    t.setHandlers({ onData: () => {}, onClose: (r) => reasons.push(r ?? '') });
    await t.open();
    await tick();

    port.fail(new Error('设备已断开'));
    await tick(10);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('设备已断开');

    await t.close();
  });
});
