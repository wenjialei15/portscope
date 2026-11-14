import { describe, expect, it } from 'vitest';
import { hexToBytes, isRecording } from '../src/core/recorder';

describe('录制数据处理', () => {
  it('hexToBytes 与录制格式往返一致', () => {
    const bytes = hexToBytes('0103000000044409');
    expect(Array.from(bytes)).toEqual([0x01, 0x03, 0x00, 0x00, 0x00, 0x04, 0x44, 0x09]);
  });

  it('拒绝伪造的录制文件', () => {
    expect(isRecording(null)).toBe(false);
    expect(isRecording({})).toBe(false);
    expect(isRecording({ format: 'other', events: [] })).toBe(false);
  });

  it('接受合法录制文件', () => {
    const value = {
      format: 'portscope-recording',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      parser: 'modbus',
      baud: 115200,
      events: [{ t: 0, dir: 'rx', hex: '0103' }],
    };
    expect(isRecording(value)).toBe(true);
  });
});
