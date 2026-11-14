import type { Parser } from '../types';
import { modbusParser } from './modbus';
import { lineParser, rawParser } from './raw';

/**
 * 解析器注册表。新增协议只需实现 Parser 接口并加进这个数组，
 * 主流程和界面会自动出现这个选项。
 */
export const PARSERS: Parser[] = [modbusParser, lineParser, rawParser];

export function getParser(id: string): Parser {
  return PARSERS.find((p) => p.id === id) ?? PARSERS[0];
}

export { modbusParser, lineParser, rawParser };
