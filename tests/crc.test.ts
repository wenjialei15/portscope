import { describe, expect, it } from 'vitest';
import { crc16Modbus, isCrcValid, withCrc } from '../src/core/crc';

describe('crc16Modbus', () => {
  it('匹配 Modbus 规范的经典样例', () => {
    // 01 03 00 00 00 01 -> CRC 0x0A84，线上低字节在前
    const frame = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]);
    expect(crc16Modbus(frame)).toBe(0x0a84);
  });

  it('对空输入返回初值', () => {
    expect(crc16Modbus(new Uint8Array([]))).toBe(0xffff);
  });

  it('withCrc 追加低字节在前的校验码', () => {
    const frame = withCrc(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]));
    expect(frame.length).toBe(8);
    expect(frame[6]).toBe(0x84);
    expect(frame[7]).toBe(0x0a);
    expect(isCrcValid(frame)).toBe(true);
  });

  it('篡改任意字节后校验失败', () => {
    const frame = withCrc(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x04]));
    const tampered = frame.slice();
    tampered[3] = 0x01;
    expect(isCrcValid(tampered)).toBe(false);
  });

  it('过短的帧一律判为无效', () => {
    expect(isCrcValid(new Uint8Array([0x01, 0x03]))).toBe(false);
  });
});
