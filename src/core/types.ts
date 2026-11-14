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

export type FrameStatus = 'ok' | 'crc-error' | 'exception';

export interface DecodedFrame {
  protocol: string;
  title: string;
  fields: Field[];
  series: SeriesPoint[];
  /**
   * 帧级状态，供统计使用。
   *
   * 不能靠「fields 里有没有 tone:'err'」来判断——Modbus 的异常响应
   * 既是「运行期错误」又是「协议上完全合法的响应」，把它和 CRC 校验
   * 失败算成一类，会让「链路有问题」和「设备回了错误码」这两件
   * 完全不同的故障混在一个数字里。
   */
  status?: FrameStatus;
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
  /**
   * 数据流空闲时调用，用于「帧头看起来还有希望、但永远等不到」的情况。
   *
   * Modbus 的候选帧长是从字节流里猜出来的：噪声很容易凑出一个
   * 「还要 137 字节」的长度，解析器就会一直等下去，后面所有有效帧
   * 都被堵在缓冲区里。RTU 规定帧间空闲超过 3.5 个字符时间就说明
   * 这一帧已经断了，所以空闲超时后应当丢 1 字节重新同步。
   */
  onIdle?(queue: ByteQueue, idleMs: number): ParseStep | null;
}
