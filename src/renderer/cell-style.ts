/**
 * How each cell looks, independent of how it is drawn. Shared by the DOM and
 * canvas renderers.
 */
import type { CodePage } from '../core/codepage/index.js';
import { displayChar } from '../core/codepage/index.js';
import { Highlighting, type Screen } from '../core/screen/index.js';
import type { ColorSlot } from './theme.js';

/**
 * `monochrome` looks like a 3278: one colour, brighter when intensified.
 * `color` looks like a 3279: extended colours when the host sends them,
 * otherwise base colours derived from each field's protection and intensity.
 */
export type DisplayMode = 'monochrome' | 'color';

export interface CellStyleOptions {
  codePage: CodePage;
  displayMode: DisplayMode;
}

export interface CellStyle {
  /** What to draw: one character, possibly with a combining overline. */
  char: string;
  fg: ColorSlot;
  bg: ColorSlot;
  reverse: boolean;
  underscore: boolean;
  blink: boolean;
  /**
   * Field outlining (GA23-0059, attribute X'C2'): lines over and under every
   * character of the field, left of its first character and right of its last.
   * Bitmask of the OUTLINE values; 0 for none.
   */
  outline: number;
  /** This cell holds a field attribute (always drawn blank). */
  fieldAttribute: boolean;
}

/** Outline sides in `CellStyle.outline`. */
export const OUTLINE = { BOTTOM: 0x01, RIGHT: 0x02, TOP: 0x04, LEFT: 0x08 } as const;

/** Transparency values (attribute X'46') that let what is behind show through. */
const TRANSPARENT = new Set([0xf0, 0xf1, 0xf2]);

const COLOR_SLOTS: Record<number, ColorSlot> = {
  0xf0: 'neutralBlack',
  0xf1: 'blue',
  0xf2: 'red',
  0xf3: 'pink',
  0xf4: 'green',
  0xf5: 'turquoise',
  0xf6: 'yellow',
  0xf7: 'neutralWhite',
  0xf8: 'black',
  0xf9: 'deepBlue',
  0xfa: 'orange',
  0xfb: 'purple',
  0xfc: 'paleGreen',
  0xfd: 'paleTurquoise',
  0xfe: 'grey',
  0xff: 'white',
};

const OVERLINE = '̅';
const DUP = 0x1c;
const FM = 0x1e;

export function cellStyle(screen: Screen, address: number, o: CellStyleOptions): CellStyle {
  const field = screen.fieldAt(address);
  const isFa = screen.isFieldAttribute(address);
  const cell = screen.attributesAt(address);
  const byte = screen.charAt(address);

  const protectedField = field?.protected ?? false;
  const hidden = field?.display === 'hidden';
  const highlighting = (!isFa && cell.highlighting) || field?.highlighting || 0;
  const intensified = field?.display === 'intensified' || highlighting === Highlighting.INTENSIFY;

  let char = ' ';
  if (!isFa && !hidden) {
    if (byte === DUP) char = '*' + OVERLINE;
    else if (byte === FM) char = ';' + OVERLINE;
    else char = displayChar(byte, cell.charset, o.codePage) ?? ' ';
  }

  let fg: ColorSlot;
  let bg: ColorSlot = 'background';
  if (o.displayMode === 'monochrome') {
    fg = intensified ? 'intensified' : 'default';
  } else {
    const fgValue = (!isFa && cell.foreground) || field?.foreground || 0;
    const bgValue = (!isFa && cell.background) || field?.background || 0;
    fg = COLOR_SLOTS[fgValue] ?? baseColor(protectedField, intensified);
    bg = COLOR_SLOTS[bgValue] ?? 'background';
  }
  // Transparent: nothing lies behind a character cell (no graphics), so the
  // cell's own background colour is simply not painted.
  const transparency = (!isFa && cell.transparency) || field?.transparency || 0;
  if (TRANSPARENT.has(transparency)) bg = 'background';

  let outline = 0;
  if (field && !isFa && field.outlining && field.length > 0) {
    const last = (field.dataStart + field.length - 1) % screen.size;
    outline = field.outlining & (OUTLINE.TOP | OUTLINE.BOTTOM);
    if (address === field.dataStart) outline |= field.outlining & OUTLINE.LEFT;
    if (address === last) outline |= field.outlining & OUTLINE.RIGHT;
  }

  return {
    char,
    fg,
    bg,
    reverse: highlighting === Highlighting.REVERSE,
    underscore: highlighting === Highlighting.UNDERSCORE,
    blink: highlighting === Highlighting.BLINK,
    outline,
    fieldAttribute: isFa,
  };
}

/** 3279 base colour mode: colour from protection and intensity. */
function baseColor(protectedField: boolean, intensified: boolean): ColorSlot {
  if (protectedField) return intensified ? 'white' : 'blue';
  return intensified ? 'red' : 'green';
}

/** A horizontal run of cells that share a style. */
export interface Run {
  /** First column. */
  start: number;
  /** Number of cells (text may be longer: overlines are combining characters). */
  length: number;
  text: string;
  style: Omit<CellStyle, 'char' | 'fieldAttribute'>;
}

/** Split one row into runs of identically styled cells. */
export function rowRuns(screen: Screen, row: number, o: CellStyleOptions): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;
  let key = '';
  for (let col = 0; col < screen.cols; col++) {
    const { char, fg, bg, reverse, underscore, blink, outline } = cellStyle(
      screen,
      row * screen.cols + col,
      o,
    );
    const style = { fg, bg, reverse, underscore, blink, outline };
    const k = `${style.fg}|${style.bg}|${style.reverse}|${style.underscore}|${style.blink}|${style.outline}`;
    if (current && k === key) {
      current.text += char;
      current.length++;
    } else {
      current = { start: col, length: 1, text: char, style };
      key = k;
      runs.push(current);
    }
  }
  return runs;
}
