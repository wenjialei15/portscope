import { toHex } from './bytes';
import type { Direction } from './types';

export interface RecordedEvent {
  /** 相对录制开始的毫秒数 */
  t: number;
  dir: Direction;
  hex: string;
}

export interface Recording {
  format: 'portscope-recording';
  version: 1;
  createdAt: string;
  parser: string;
  baud: number;
  events: RecordedEvent[];
}

/**
 * 会话录制。存的是原始字节和相对时间戳，而不是解析后的结果——
 * 这样同一份录制换个解析器还能重新分析，回放也能真实复现分片时序。
 */
export class Recorder {
  private events: RecordedEvent[] = [];
  private t0 = 0;
  private active = false;
  private parserId = 'modbus';
  private baud = 115200;
  private createdAt = '';

  get isActive(): boolean {
    return this.active;
  }

  get count(): number {
    return this.events.length;
  }

  start(parserId: string, baud: number, now = performance.now()): void {
    this.events = [];
    this.t0 = now;
    this.active = true;
    this.parserId = parserId;
    this.baud = baud;
    this.createdAt = new Date().toISOString();
  }

  record(dir: Direction, bytes: Uint8Array, now = performance.now()): void {
    if (!this.active) return;
    // 长时间录制下限制条数，防止内存无限增长（约 20 万条 ≈ 数十 MB）。
    if (this.events.length > 200_000) return;
    this.events.push({ t: Math.round(now - this.t0), dir, hex: toHex(bytes, '').toLowerCase() });
  }

  stop(): Recording | null {
    this.active = false;
    if (this.events.length === 0) return null;
    return {
      format: 'portscope-recording',
      version: 1,
      createdAt: this.createdAt,
      parser: this.parserId,
      baud: this.baud,
      events: this.events.slice(),
    };
  }

  clear(): void {
    this.events = [];
    this.active = false;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isRecording(value: unknown): value is Recording {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Recording>;
  return v.format === 'portscope-recording' && Array.isArray(v.events);
}

/**
 * 按原始时间间隔回放。超过 500ms 的空闲会被压缩，
 * 免得录了一段长时间挂机的会话要等十分钟。
 */
export function replay(
  recording: Recording,
  onEvent: (event: RecordedEvent) => void,
  onDone: () => void,
  speed = 1,
): () => void {
  let cancelled = false;
  const timers: number[] = [];
  let prev = 0;

  recording.events.forEach((event, index) => {
    const gap = Math.max(0, event.t - prev);
    prev = event.t;
    const wait = Math.min(gap, 500) / Math.max(0.1, speed);
    const id = window.setTimeout(() => {
      if (cancelled) return;
      onEvent(event);
      if (index === recording.events.length - 1) onDone();
    }, wait);
    timers.push(id);
  });

  return () => {
    cancelled = true;
    for (const id of timers) window.clearTimeout(id);
  };
}
