import { crc16Modbus } from '../crc';
import { isPrintable, toText } from '../bytes';
import type { Parser } from '../types';

/**
 * 原始流解析器：不假设任何协议结构。
 * 用空闲间隔切帧——串口上两帧之间通常有毫秒级静默，
 * 这是唯一对任意私有协议都成立的假设。
 */
export const rawParser: Parser = {
  id: 'raw',
  name: '原始流',
  hint: '不做协议假设，按空闲间隔切帧',
  parse: () => null,
  flush(queue) {
    if (queue.size === 0) return null;
    const frame = queue.toArray();
    queue.clear();

    let printable = 0;
    for (let i = 0; i < frame.length; i++) if (isPrintable(frame[i])) printable++;

    const fields = [
      { k: '长度', v: `${frame.length} 字节` },
      { k: '可打印', v: `${Math.round((printable / frame.length) * 100)}%` },
      {
        k: 'CRC16',
        v: `0x${crc16Modbus(frame).toString(16).toUpperCase().padStart(4, '0')}`,
      },
    ];

    return {
      kind: 'frame',
      frame,
      consumed: frame.length,
      decoded: {
        protocol: 'Raw',
        title: `原始数据 ${frame.length} 字节`,
        fields,
        series: [],
      },
    };
  },
};

/**
 * 文本行解析器：按 LF 切分，并尝试从 `key=value` 中提取数值，
 * 让 AT 日志、调试打印也能直接画曲线。
 */
export const lineParser: Parser = {
  id: 'line',
  name: '文本行',
  hint: '按换行切分，自动提取 key=value 数值',
  parse(queue) {
    for (let i = 0; i < queue.size; i++) {
      if (queue.at(i) === 0x0a) {
        const frame = queue.slice(0, i);
        const text = toText(frame);
        return {
          kind: 'frame',
          frame,
          consumed: i + 1,
          decoded: {
            protocol: 'Text',
            title: text.slice(0, 60) || '(空行)',
            fields: [{ k: '长度', v: `${frame.length} 字节` }],
            series: extractNumbers(text),
          },
        };
      }
    }

    // 没有换行的超长输入：强制切块，避免缓冲区无限增长。
    if (queue.size > 4096) {
      const frame = queue.slice(0, 512);
      const text = toText(frame);
      return {
        kind: 'frame',
        frame,
        consumed: 512,
        decoded: {
          protocol: 'Text',
          title: text.slice(0, 60),
          fields: [
            { k: '长度', v: '512 字节（超长行强制切分）', tone: 'warn' as const },
          ],
          series: extractNumbers(text),
        },
      };
    }

    return null;
  },
};

const KV = /([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(-?\d+(?:\.\d+)?)/g;

function extractNumbers(text: string): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  KV.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KV.exec(text)) !== null) {
    const v = Number(m[2]);
    if (Number.isFinite(v)) out.push({ label: m[1], value: v });
    if (out.length >= 6) break;
  }
  return out;
}
