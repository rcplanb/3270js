/**
 * The status line (OIA) as a row of cells: glyphs and characters at the 3174
 * column positions, using x3270's symbol sequences (x3270/status.c).
 * Render-neutral: the DOM and canvas renderers both draw from this.
 */
import type { OiaState } from '../core/oia/index.js';
import type { OiaGlyph } from './oia-glyphs.js';

export type OiaCell = { glyph: OiaGlyph } | { char: string } | null;

export interface OiaLayoutOptions {
  cols: number;
  /** Shift or Caps Lock is down (the upshift arrow). */
  shift?: boolean;
}

const g = (glyph: OiaGlyph): OiaCell => ({ glyph });
const text = (s: string): OiaCell[] => [...s].map((char) => (char === ' ' ? null : { char }));

/** The input-inhibited area, starting at column 8. */
function lockCells(state: OiaState): OiaCell[] {
  const lock = state.lock;
  if (!lock) return [];
  const X = [g('lock'), null];
  switch (lock.symbol) {
    case 'notConnected':
      return state.connection === 'connecting'
        ? [...X, ...text('[TELNET]')]
        : [...X, g('commHi'), g('badCommHi'), g('commHi'), g('commJag'), g('commLo')];
    case 'system':
      return lock.reason === 'awaitingFirst'
        ? [...X, ...text('[Field]')]
        : [...X, ...text('SYSTEM')];
    case 'clock':
      return [...X, g('clockLeft'), g('clockRight')];
    case 'doNotEnter':
      return [...X, g('leftArrow'), g('human'), g('rightArrow')];
    case 'numeric':
      return [...X, g('human'), ...text('NUM')];
    case 'tooMuch':
      return [...X, g('human'), ...text('>')];
  }
}

/** Plain-language description of the status line, for assistive technology. */
export function oiaDescription(state: OiaState): string {
  const lock = state.lock;
  const parts = [
    state.connection === 'connected'
      ? 'Connected'
      : state.connection === 'connecting'
        ? 'Connecting'
        : 'Not connected',
  ];
  if (lock) {
    parts.push(
      {
        system:
          lock.reason === 'awaitingFirst'
            ? 'input inhibited, waiting for the host'
            : 'input inhibited by the system',
        clock: 'input inhibited, waiting for the host',
        notConnected: 'input inhibited, not connected',
        doNotEnter: 'input inhibited: protected field, go elsewhere',
        numeric: 'input inhibited: numeric field',
        tooMuch: 'input inhibited: too much input for the field',
      }[lock.symbol],
    );
  }
  if (state.insert) parts.push('insert mode');
  parts.push(`row ${state.cursor.row + 1}, column ${state.cursor.col + 1}`);
  return parts.join('; ');
}

export function oiaCells(state: OiaState, o: OiaLayoutOptions): OiaCell[] {
  const { cols } = o;
  const cells: OiaCell[] = Array.from({ length: cols }, () => null);
  const put = (at: number, items: OiaCell[]) =>
    items.forEach((c, i) => at + i < cols && (cells[at + i] = c));

  // Columns 0-2: controller ready, session type (A = TN3270, B = TN3270E), owner.
  if (state.connection === 'connected') put(0, [g('box4'), g('underA'), g('boxSolid')]);
  else if (state.connection === 'connecting') put(0, [g('box4'), null, g('boxQuestion')]);

  put(8, lockCells(state));
  if (o.shift) put(cols - 39, [g('upShift')]);
  if (state.insert) put(cols - 29, [g('insert')]);
  const pos = (n: number) => String(n + 1).padStart(3, '0');
  put(cols - 7, text(`${pos(state.cursor.row)}/${pos(state.cursor.col)}`));
  return cells;
}
