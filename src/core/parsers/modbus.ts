import { isCrcValid, withCrc } from '../crc';
import type { ByteQueue } from '../byte-queue';
import type { DecodedFrame, Field, FrameStatus, ParseStep, Parser, SeriesPoint } from '../types';

/** RTU 帧的理论上限：256 字节。超过它还没对上，说明帧头本身就是噪声 */
const MAX_MODBUS_FRAME = 256;

/** 数据流空闲超过这个时间就认为当前帧已中断 */
const RTU_IDLE_RESYNC_MS = 20;

const FUNC_NAMES: Record<number, string> = {
  0x01: '读线圈',
  0x02: '读离散输入',
  0x03: '读保持寄存器',
  0x04: '读输入寄存器',
  0x05: '写单线圈',
  0x06: '写单寄存器',
  0x0f: '写多线圈',
  0x10: '写多寄存器',
};

const EXC_NAMES: Record<number, string> = {
  1: '非法功能',
  2: '非法数据地址',
  3: '非法数据值',
  4: '从站设备故障',
  5: '确认',
  6: '从站忙',
};

const hex = (n: number, width = 2): string => n.toString(16).toUpperCase().padStart(width, '0');

function decodeModbus(frame: Uint8Array): DecodedFrame {
  const addr = frame[0];
  const func = frame[1];
  const base = func & 0x7f;
  const crcOk = isCrcValid(frame);
  const fields: Field[] = [{ k: '从站', v: `${addr} (0x${hex(addr)})` }];
  const series: SeriesPoint[] = [];
  let title = FUNC_NAMES[base] ?? `功能 0x${hex(func)}`;

  if (func & 0x80) {
    const code = frame[2] ?? 0;
    title = `异常响应 ${EXC_NAMES[code] ?? `0x${hex(code)}`}`;
    fields.push({ k: '功能码', v: `0x${hex(func)} · ${FUNC_NAMES[base] ?? '未知'}` });
    fields.push({ k: '异常码', v: `${code} ${EXC_NAMES[code] ?? ''}`, tone: 'err' });
  } else if (base === 3 || base === 4) {
    const bc = frame[2] ?? 0;
    const isResponse = frame.length === 5 + bc && bc % 2 === 0 && bc <= 250;
    if (isResponse) {
      const count = bc / 2;
      title = `${FUNC_NAMES[base]} · ${count} 个寄存器`;
      fields.push({ k: '功能码', v: `0x${hex(base)} ${FUNC_NAMES[base]}` });
      fields.push({ k: '字节数', v: String(bc) });
      for (let i = 0; i < count; i++) {
        const v = (frame[3 + i * 2] << 8) | frame[4 + i * 2];
        fields.push({ k: `R${i}`, v: `${v} · 0x${hex(v, 4)}` });
        series.push({ label: `R${i}`, value: v });
      }
    } else {
      const start = (frame[2] << 8) | frame[3];
      const qty = (frame[4] << 8) | frame[5];
      title = `${FUNC_NAMES[base]} 请求 · ${qty} 个寄存器`;
      fields.push({ k: '功能码', v: `0x${hex(base)} ${FUNC_NAMES[base]}` });
      fields.push({ k: '起始地址', v: `${start} · 0x${hex(start, 4)}` });
      fields.push({ k: '数量', v: String(qty) });
    }
  } else if (base === 1 || base === 2) {
    const bc = frame[2] ?? 0;
    const isResponse = frame.length === 5 + bc && bc >= 1 && bc <= 250;
    if (isResponse) {
      title = `${FUNC_NAMES[base]} · ${bc * 8} 位`;
      fields.push({ k: '字节数', v: String(bc) });
      for (let i = 0; i < bc; i++) {
        fields.push({ k: `B${i}`, v: `0x${hex(frame[3 + i] ?? 0)}` });
      }
    } else {
      const start = (frame[2] << 8) | frame[3];
      const qty = (frame[4] << 8) | frame[5];
      title = `${FUNC_NAMES[base]} 请求 · ${qty} 位`;
      fields.push({ k: '起始地址', v: `${start} · 0x${hex(start, 4)}` });
      fields.push({ k: '数量', v: String(qty) });
    }
  } else if (base === 5 || base === 6) {
    const reg = (frame[2] << 8) | frame[3];
    const val = (frame[4] << 8) | frame[5];
    title = `${FUNC_NAMES[base]} · 寄存器 ${reg}`;
    fields.push({ k: '寄存器', v: `${reg} · 0x${hex(reg, 4)}` });
    fields.push({ k: '写入值', v: `${val} · 0x${hex(val, 4)}` });
  } else if (base === 15 || base === 16) {
    const reg = (frame[2] << 8) | frame[3];
    const qty = (frame[4] << 8) | frame[5];
    const isRequest = frame.length > 8;
    title = `${FUNC_NAMES[base]}${isRequest ? ' 请求' : ' 响应'} · ${qty} 个`;
    fields.push({ k: '起始地址', v: `${reg} · 0x${hex(reg, 4)}` });
    fields.push({ k: '数量', v: String(qty) });

    if (isRequest) {
      const bc = frame[6] ?? 0;
      fields.push({ k: '字节数', v: String(bc) });

      if (base === 15) {
        /*
         * 写多线圈是按位打包的：一个字节装 8 个线圈，最高位对应最小地址。
         * 早期版本把这里当寄存器解析（每 2 字节一个值），线圈数为奇数时
         * 会多读一个不存在的高字节，界面上显示的值全是错的。
         */
        for (let i = 0; i < bc; i++) {
          const byte = frame[7 + i] ?? 0;
          fields.push({
            k: `B${i}`,
            v: `0x${hex(byte)} · ${byte.toString(2).padStart(8, '0')}`,
          });
        }
      } else {
        for (let i = 0; i + 1 < bc; i += 2) {
          const v = (frame[7 + i] << 8) | frame[8 + i];
          fields.push({ k: `R${i / 2}`, v: String(v) });
          series.push({ label: `R${i / 2}`, value: v });
        }
      }
    }
  }

  fields.push({ k: 'CRC', v: crcOk ? '校验通过' : '校验错误', tone: crcOk ? 'ok' : 'err' });

  /*
   * 优先级：CRC 不过时整帧都不可信，连异常码都不能当真，
   * 所以 crc-error 排在最前面。
   */
  const status: FrameStatus = !crcOk ? 'crc-error' : (func & 0x80) !== 0 ? 'exception' : 'ok';

  return { protocol: 'Modbus RTU', title, fields, series, status };
}

/**
 * Modbus RTU 没有长度字段，帧长由功能码决定；而同一功能码的请求和响应
 * 长度不同，所以无法只看方向定界。这里枚举所有可能的长度，用 CRC 校验
 * 逐个试探——CRC 本身就是最好的帧同步标记。全部失败且数据已够长时，
 * 丢弃 1 字节重试（重同步），这比丢弃整帧更不容易丢真数据。
 */
function parseModbus(queue: ByteQueue): ParseStep | null {
  if (queue.size < 4) return null;

  const func = queue.at(1);
  const base = func & 0x7f;
  const candidates: number[] = [];

  if (func & 0x80) {
    candidates.push(5);
  } else if (base >= 1 && base <= 4) {
    candidates.push(8);
    if (queue.size >= 3) candidates.push(5 + queue.at(2));
  } else if (base === 5 || base === 6) {
    candidates.push(8);
  } else if (base === 15 || base === 16) {
    candidates.push(8);
    if (queue.size >= 7) candidates.push(9 + queue.at(6));
  } else {
    return { kind: 'skip', count: 1 };
  }

  const unique = [...new Set(candidates)].filter((n) => n >= 5 && n <= MAX_MODBUS_FRAME).sort((a, b) => a - b);
  let waiting = false;

  for (const len of unique) {
    if (queue.size < len) {
      waiting = true;
      continue;
    }
    const frame = queue.slice(0, len);
    if (isCrcValid(frame)) {
      return { kind: 'frame', frame, consumed: len, decoded: decodeModbus(frame) };
    }
  }

  /*
   * 这里是最容易踩的坑：queue.size < len 只是「数据还没到齐」，
   * 但如果当前字节根本就是噪声，那个更长的候选帧永远不会来，
   * 解析器就会一直等下去，后面所有有效帧都被堵在缓冲区里。
   *
   * 所以加一个硬边界：缓存已经攒到 RTU 最大帧长（256 字节）还没对上，
   * 就认为当前帧头不成立，丢 1 字节重同步。
   */
  if (waiting && queue.size < MAX_MODBUS_FRAME) {
    return null;
  }

  return { kind: 'skip', count: 1 };
}

/** 构造「读保持寄存器」请求，供快捷指令与模拟器使用。 */
export function buildReadHolding(slave: number, start: number, count: number): Uint8Array {
  return withCrc(
    new Uint8Array([slave & 0xff, 0x03, (start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff]),
  );
}

/** 构造「写单寄存器」请求。 */
export function buildWriteRegister(slave: number, reg: number, value: number): Uint8Array {
  return withCrc(
    new Uint8Array([slave & 0xff, 0x06, (reg >> 8) & 0xff, reg & 0xff, (value >> 8) & 0xff, value & 0xff]),
  );
}

export const modbusParser: Parser = {
  id: 'modbus',
  name: 'Modbus RTU',
  hint: 'CRC 定界，自动识别请求 / 响应 / 异常帧',
  parse: parseModbus,

  /*
   * RTU 靠帧间静默（≥3.5 字符时间）判断一帧结束。如果数据停了这么久
   * 还切不出帧，说明当前帧头是噪声凑出来的，那个"更长的候选帧"永远
   * 不会来——必须丢掉队首 1 字节重同步，否则后面的有效帧全被堵住。
   *
   * 115200 下 3.5 字符约 0.3ms，这里取 20ms 是为了容忍 USB 转串口的
   * 批量上报和慢速波特率，不至于把正常分片误判成断帧。
   */
  onIdle(queue: ByteQueue, idleMs: number): ParseStep | null {
    if (queue.size === 0) return null;
    if (idleMs < RTU_IDLE_RESYNC_MS) return null;
    return { kind: 'skip', count: 1 };
  },
};

export { decodeModbus as decodeModbusFrame };
