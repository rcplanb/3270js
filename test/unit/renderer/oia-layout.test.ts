import { describe, expect, it } from 'vitest';
import type { OiaState } from '../../../src/core/oia/index.js';
import { OIA_GLYPHS, OIA_GLYPH_SIZE } from '../../../src/renderer/oia-glyphs.js';
import { oiaCells, oiaDescription, type OiaCell } from '../../../src/renderer/oia-layout.js';

const base: OiaState = {
  connection: 'connected',
  lock: undefined,
  insert: false,
  cursor: { row: 22, col: 11 },
  model: '3278-2',
};
const show = (cells: OiaCell[], from: number, n: number) =>
  cells
    .slice(from, from + n)
    .map((c) => (c === null ? ' ' : 'glyph' in c ? `<${c.glyph}>` : c.char))
    .join('');

describe('OIA glyphs (from x3270 3270-20.bdf)', () => {
  it('are SVG paths of unit rectangles inside a 10x20 cell', () => {
    expect(OIA_GLYPH_SIZE).toEqual({ width: 10, height: 20 });
    for (const [name, d] of Object.entries(OIA_GLYPHS)) {
      expect(d, name).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
      for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
        expect(Number(m[1]) + Number(m[3]), name).toBeLessThanOrEqual(10);
        expect(Number(m[2]), name).toBeLessThan(20);
      }
    }
  });
});

describe('oiaCells (3174 layout, x3270 symbol sequences)', () => {
  it('shows the controller boxes, and the cursor at the right as rrr/ccc', () => {
    const c = oiaCells(base, { cols: 80 });
    expect(c).toHaveLength(80);
    expect(show(c, 0, 3)).toBe('<box4><underA><boxSolid>');
    expect(show(c, 73, 7)).toBe('023/012');
  });

  it('shows a boxed question mark while connecting, and nothing when disconnected', () => {
    expect(show(oiaCells({ ...base, connection: 'connecting' }, { cols: 80 }), 0, 3)).toBe(
      '<box4> <boxQuestion>',
    );
    expect(show(oiaCells({ ...base, connection: 'disconnected' }, { cols: 80 }), 0, 3)).toBe('   ');
  });

  it.each([
    [{ symbol: 'system', reason: 'system' }, '<lock> SYSTEM'],
    [{ symbol: 'system', reason: 'awaitingFirst' }, '<lock> [Field]'],
    [{ symbol: 'clock', reason: 'wait' }, '<lock> <clockLeft><clockRight>'],
    [{ symbol: 'doNotEnter', reason: 'protected' }, '<lock> <leftArrow><human><rightArrow>'],
    [{ symbol: 'numeric', reason: 'numeric' }, '<lock> <human>NUM'],
    [{ symbol: 'tooMuch', reason: 'overflow' }, '<lock> <human>>'],
  ] as const)('shows %o as x3270 does', (lock, expected) => {
    const c = oiaCells({ ...base, lock }, { cols: 80 });
    expect(show(c, 8, 12).trimEnd()).toBe(expected);
  });

  it('shows broken communication when not connected, [TELNET] while negotiating', () => {
    const lock = { symbol: 'notConnected', reason: 'notConnected' } as const;
    expect(show(oiaCells({ ...base, connection: 'disconnected', lock }, { cols: 80 }), 8, 7)).toBe(
      '<lock> <commHi><badCommHi><commHi><commJag><commLo>',
    );
    expect(show(oiaCells({ ...base, connection: 'connecting', lock }, { cols: 80 }), 8, 10)).toBe(
      '<lock> [TELNET]',
    );
  });

  it('shows insert mode at column 51 and shift at column 41', () => {
    const c = oiaCells({ ...base, insert: true }, { cols: 80, shift: true });
    expect(c[51]).toEqual({ glyph: 'insert' });
    expect(c[41]).toEqual({ glyph: 'upShift' });
  });

  it('positions relative to the right edge on wide models', () => {
    const c = oiaCells({ ...base, insert: true }, { cols: 132 });
    expect(c[103]).toEqual({ glyph: 'insert' });
    expect(show(c, 125, 7)).toBe('023/012');
  });
});

describe('oiaDescription', () => {
  it('describes the status line in words', () => {
    expect(
      oiaDescription({
        ...base,
        insert: true,
        lock: { symbol: 'doNotEnter', reason: 'protected' },
      }),
    ).toBe(
      'Connected; input inhibited: protected field, go elsewhere; insert mode; row 23, column 12',
    );
    expect(oiaDescription({ ...base, connection: 'connecting' })).toMatch(/^Connecting/);
    expect(oiaDescription({ ...base, connection: 'disconnected' })).toMatch(/^Not connected/);
  });
});
