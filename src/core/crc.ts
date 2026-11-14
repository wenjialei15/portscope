/**
 * CRC-16/MODBUS：反射多项式 0xA001，初值 0xFFFF，低字节先发。
 * 用查表法而不是逐位移位，1KB 的帧也不会成为瓶颈。
 */
const TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

export function crc16Modbus(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xff];
  }
  return crc & 0xffff;
}

/** 校验末两字节是否为前面数据的 CRC（Modbus 低字节在前）。 */
export function isCrcValid(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const expected = crc16Modbus(frame, 0, frame.length - 2);
  const actual = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return expected === actual;
}

/** 在 payload 末尾追加 CRC。 */
export function withCrc(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 2);
  out.set(payload);
  const crc = crc16Modbus(out, 0, payload.length);
  out[payload.length] = crc & 0xff;
  out[payload.length + 1] = (crc >>> 8) & 0xff;
  return out;
}
