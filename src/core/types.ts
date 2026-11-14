import type { ByteQueue } from './byte-queue';

export type Direction = 'rx' | 'tx';

export interface Field {
  k: string;
  v: string;
  tone?: 'ok' | 'err' | 'warn';
}

/** 解析器从一帧里提取出的数值序列，用于波形通道。 */
export interface SeriesPoint {
  label: string;
  value: number;
}

export interface DecodedFrame {
  protocol: string;
  title: string;
  fields: Field[];
  series: SeriesPoint[];
}

/**
 * 解析器每一步的决策：
 * - frame：切出一帧
 * - skip：当前字节无法作为帧首，丢弃若干个重新同步
 * - null：数据不足，继续等待
 */
export type ParseStep =
  | { kind: 'frame'; frame: Uint8Array; consumed: number; decoded: DecodedFrame }
  | { kind: 'skip'; count: number };

/**
 * 协议解析器。实现这个接口并注册到 PARSERS 即可扩展，不需要改主流程。
 */
export interface Parser {
  id: string;
  name: string;
  hint: string;
  /** 尝试从缓冲区切出下一帧。 */
  parse(queue: ByteQueue): ParseStep | null;
  /** 无法自定界的协议（如原始流）用空闲超时收尾。 */
  flush?(queue: ByteQueue): ParseStep | null;
}
