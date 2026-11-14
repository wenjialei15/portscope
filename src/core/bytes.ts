/** 字节与文本之间的转换，供解析器和界面共用。 */

export function toHex(bytes: Uint8Array, sep = ' '): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(sep);
}

export function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/** 不可打印字节显示为 `.`，避免控制字符破坏布局。 */
export function toText(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d) continue;
    if (b === 0x0a) {
      out += '⏎';
      continue;
    }
    if (b === 0x09) {
      out += ' ';
      continue;
    }
    out += isPrintable(b) ? String.fromCharCode(b) : '·';
  }
  return out;
}

/** 解析用户输入的 HEX 字符串，容忍空格、逗号、0x 前缀和换行。 */
export function parseHexInput(input: string): Uint8Array | null {
  const cleaned = input
    .replace(/0x/gi, ' ')
    .replace(/[,;:\s]+/g, ' ')
    .trim();
  if (!cleaned) return new Uint8Array(0);

  let body = cleaned.replace(/ /g, '');
  if (body.length % 2 !== 0) body = body.padStart(body.length + 1, '0');
  if (!/^[0-9a-fA-F]*$/.test(body)) return null;

  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 时间戳格式化为 HH:MM:SS.mmm。 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
