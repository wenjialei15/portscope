import { isCrcValid, withCrc } from './crc';

export interface TransportHandlers {
  onData: (chunk: Uint8Array) => void;
  onClose: (reason?: string) => void;
}

export interface Transport {
  readonly kind: 'serial' | 'mock';
  readonly label: string;
  setHandlers(handlers: TransportHandlers): void;
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/** 真实串口。数据按 chunk 到达，分片边界由驱动决定，解析器必须能容忍。 */
export class WebSerialTransport implements Transport {
  readonly kind = 'serial' as const;
  readonly label: string;
  private handlers: TransportHandlers = { onData: () => {}, onClose: () => {} };
  private closing = false;

  constructor(
    private readonly port: SerialPort,
    private readonly options: SerialOptions,
  ) {
    const info = port.getInfo();
    this.label = info.usbVendorId !== undefined
      ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}`
      : '串口设备';
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  async open(): Promise<void> {
    await this.port.open(this.options);
    this.closing = false;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const port = this.port;
    while (port.readable) {
      const reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) this.handlers.onData(value);
        }
      } catch (err) {
        if (!this.closing) this.handlers.onClose(describe(err));
        break;
      } finally {
        reader.releaseLock();
      }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const writable = this.port.writable;
    if (!writable) throw new Error('串口不可写，可能已断开');
    const writer = writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.port.close();
    } catch {
      // 设备可能已被拔出，忽略关闭错误
    }
  }
}

/**
 * 模拟设备：一个在浏览器里跑的 Modbus 从站，8 个保持寄存器，
 * 前 4 个是随时间变化的传感器值。
 *
 * 存在的理由很简单——GitHub Pages 上的访客手里没有开发板，
 * 如果必须先接线才能看到界面有什么用，这个项目在别人眼里就是一片空白。
 * 它同时充当解析器的集成测试：响应会刻意拆成两个 chunk 发出。
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly label = '模拟设备 · Modbus 从站 #1';
  private handlers: TransportHandlers = { onData: () => {}, onClose: () => {} };
  private regs = new Uint16Array(8);
  private timer: number | undefined;
  private running = false;
  private t0 = 0;

  constructor(private readonly baudProvider: () => number = () => 115200) {}

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  async open(): Promise<void> {
    this.running = true;
    this.t0 = performance.now();
    this.updateRegisters();
    this.timer = window.setInterval(() => this.updateRegisters(), 100);
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.running) throw new Error('模拟设备未启动');
    if (bytes.length < 4) return;

    // 和真实从站一致：CRC 错的请求直接丢弃，不回任何东西。
    if (!isCrcValid(bytes)) return;

    const response = this.respond(bytes);
    if (!response) return;

    const baud = Math.max(9600, this.baudProvider());
    const wireMs = ((bytes.length + response.length) * 10 * 1000) / baud;
    const delay = Math.min(400, Math.max(14, wireMs + 10));

    window.setTimeout(() => {
      if (!this.running) return;
      const split = Math.max(1, Math.floor(response.length / 2));
      this.handlers.onData(response.slice(0, split));
      window.setTimeout(() => {
        if (this.running) this.handlers.onData(response.slice(split));
      }, 2);
    }, delay);
  }

  private respond(req: Uint8Array): Uint8Array | null {
    const addr = req[0];
    const func = req[1];
    const base = func & 0x7f;

    if (base === 0x03 || base === 0x04) {
      const start = (req[2] << 8) | req[3];
      const qty = (req[4] << 8) | req[5];
      if (qty < 1 || qty > 125 || start + qty > this.regs.length) {
        return this.exception(addr, base, 2);
      }
      const out = new Uint8Array(3 + qty * 2);
      out[0] = addr;
      out[1] = base;
      out[2] = qty * 2;
      for (let i = 0; i < qty; i++) {
        const v = this.regs[start + i];
        out[3 + i * 2] = (v >> 8) & 0xff;
        out[4 + i * 2] = v & 0xff;
      }
      return withCrc(out);
    }

    if (base === 0x06) {
      const reg = (req[2] << 8) | req[3];
      const val = (req[4] << 8) | req[5];
      if (reg >= this.regs.length) return this.exception(addr, base, 2);
      this.regs[reg] = val;
      return req.slice();
    }

    return this.exception(addr, base, 1);
  }

  private exception(addr: number, func: number, code: number): Uint8Array {
    return withCrc(new Uint8Array([addr, func | 0x80, code]));
  }

  private updateRegisters(): void {
    const t = (performance.now() - this.t0) / 1000;
    const noise = (amp: number): number => (Math.random() - 0.5) * amp;
    const clamp = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));

    this.regs[0] = clamp((25 + Math.sin(t / 6) * 3 + noise(0.4)) * 10); // 温度 ℃ ×10
    this.regs[1] = clamp((55 + Math.sin(t / 11 + 1) * 9 + noise(1.2)) * 10); // 湿度 % ×10
    this.regs[2] = clamp((12 + Math.sin(t / 4 + 2) * 0.25 + noise(0.05)) * 100); // 电压 V ×100
    this.regs[3] = clamp((0.8 + Math.sin(t / 3.3 + 0.5) * 0.3 + noise(0.04)) * 100); // 电流 A ×100
  }
}
