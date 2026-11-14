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

const RECORDING_FORMAT = 'portscope-recording';
const RECORDING_VERSION = 1;

/** 单份录制的最大事件数，约 20 万条 ≈ 数十 MB */
export const MAX_RECORDING_EVENTS = 200_000;

/** 导入文件的大小上限。超过这个量级基本可以确定不是正常录制 */
export const MAX_RECORDING_FILE_BYTES = 32 * 1024 * 1024;

/** 回放时空闲间隔的压缩上限 */
export const REPLAY_MAX_GAP_MS = 500;

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
  private truncated = false;

  get isActive(): boolean {
    return this.active;
  }

  get count(): number {
    return this.events.length;
  }

  /** 是否因为超出条数上限而丢弃过事件 */
  get isTruncated(): boolean {
    return this.truncated;
  }

  start(parserId: string, baud: number, now = performance.now()): void {
    this.events = [];
    this.t0 = now;
    this.active = true;
    this.parserId = parserId;
    this.baud = baud;
    this.createdAt = new Date().toISOString();
    this.truncated = false;
  }

  record(dir: Direction, bytes: Uint8Array, now = performance.now()): void {
    if (!this.active) return;
    if (this.events.length >= MAX_RECORDING_EVENTS) {
      // 不再静默丢弃：把截断状态暴露出去，界面上要能提示用户
      this.truncated = true;
      return;
    }
    this.events.push({ t: Math.round(now - this.t0), dir, hex: toHex(bytes, '').toLowerCase() });
  }

  stop(): Recording | null {
    this.active = false;
    if (this.events.length === 0) return null;
    return {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: this.createdAt,
      parser: this.parserId,
      baud: this.baud,
      events: this.events.slice(),
    };
  }

  clear(): void {
    this.events = [];
    this.active = false;
    this.truncated = false;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  // 奇数长度说明数据被截断了，丢掉最后一个半字节而不是让 parseInt 返回 NaN
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const n = clean.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isNaN(v) ? 0 : v;
  }
  return out;
}

/**
 * 严格校验录制文件。
 *
 * 光看 format 和 events 是不是数组是不够的——回放会把 hex 字段直接喂给
 * 解析器，一条非法记录就能让界面停在半渲染状态。所以每个事件的
 * 时间戳、方向、hex 内容都要逐个检查。
 */
export function isRecording(value: unknown): value is Recording {
  if (!value || typeof value !== 'object') return false;

  const v = value as Partial<Recording>;
  if (v.format !== RECORDING_FORMAT) return false;
  if (v.version !== RECORDING_VERSION) return false;
  if (!Array.isArray(v.events)) return false;
  if (v.events.length > MAX_RECORDING_EVENTS) return false;
  if (typeof v.createdAt !== 'string') return false;
  if (typeof v.parser !== 'string') return false;
  if (typeof v.baud !== 'number' || !Number.isFinite(v.baud) || v.baud <= 0) return false;

  let prevT = -1;
  for (const raw of v.events) {
    if (!raw || typeof raw !== 'object') return false;
    const e = raw as Partial<RecordedEvent>;
    if (typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) return false;
    if (e.t < prevT) return false; // 时间戳必须非递减，否则回放会乱序
    prevT = e.t;
    if (e.dir !== 'rx' && e.dir !== 'tx') return false;
    if (typeof e.hex !== 'string') return false;
    if (e.hex.length % 2 !== 0) return false;
    if (!/^[0-9a-fA-F]*$/.test(e.hex)) return false;
  }

  return true;
}

/**
 * 按原始时间间隔回放。
 *
 * 关键点：用**一个**定时器串行推进，每次的等待时间相对「上一条事件」，
 * 而不是给每条事件各开一个相对「现在」的定时器。
 *
 * 后者看起来更直观，但 setTimeout 的延时都是相对调用时刻的，于是
 * 事件 t=0/100/200 会被排成 0ms、100ms、100ms 三个定时器，第 2、3 条
 * 同时触发，节奏完全错乱。而且一万条事件就是一万个定时器，主线程
 * 光管理它们就卡住了。
 *
 * 超过 REPLAY_MAX_GAP_MS 的空闲会被压缩，免得录了一段挂机会话要等十分钟。
 * 同一毫秒内的连续分片会批量放行，避免大量 0ms 定时器。
 */
export function replay(
  recording: Recording,
  onEvent: (event: RecordedEvent) => void,
  onDone: () => void,
  speed = 1,
): () => void {
  const events = recording.events;
  const rate = Number.isFinite(speed) ? Math.max(0.1, speed) : 1;

  let index = 0;
  let prevT = 0;
  let cancelled = false;
  let finished = false;
  let timer: number | undefined;

  const cancel = (): void => {
    cancelled = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const finish = (): void => {
    if (finished || cancelled) return;
    finished = true;
    onDone();
  };

  /** 同一毫秒内的连续事件直接放行，不进定时器 */
  const drainZeroGap = (): void => {
    while (!cancelled && index < events.length) {
      const next = events[index];
      if (next.t - prevT > 0) break;
      onEvent(next);
      prevT = next.t;
      index++;
    }
  };

  const schedule = (): void => {
    if (cancelled) return;
    if (index >= events.length) {
      finish();
      return;
    }

    const event = events[index];
    const gap = Math.max(0, event.t - prevT);
    const wait = Math.min(gap, REPLAY_MAX_GAP_MS) / rate;

    timer = window.setTimeout(() => {
      timer = undefined;
      if (cancelled) return;

      onEvent(event);
      prevT = event.t;
      index++;

      drainZeroGap();
      schedule();
    }, wait);
  };

  // 空录制也必须回调 onDone，否则调用方会一直停在「回放中」的状态
  if (events.length === 0) {
    timer = window.setTimeout(() => {
      timer = undefined;
      finish();
    }, 0);
    return cancel;
  }

  drainZeroGap();

  if (index >= events.length) {
    timer = window.setTimeout(() => {
      timer = undefined;
      finish();
    }, 0);
  } else {
    schedule();
  }

  return cancel;
}
