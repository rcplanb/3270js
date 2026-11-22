/**
 * The character a cell shows: its byte in the session's code page, or in
 * code page 310 when the cell uses the APL / Graphic Escape character set
 * (character-set attribute X'F1', e.g. ISPF's box-drawing lines).
 */
import { CP310 } from './apl.js';
import type { CodePage } from './codepage.js';
import { isGraphic } from './ebcdic.js';

/** Character-set attribute value for APL / Graphic Escape. */
const APL = 0xf1;

/** The Unicode text for a cell, or undefined if it shows nothing (a null or control). */
export function displayChar(byte: number, charset: number, codePage: CodePage): string | undefined {
  if (charset === APL) return CP310.get(byte);
  return isGraphic(byte) ? codePage.toUnicode(byte) : undefined;
}
