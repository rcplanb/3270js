import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../src/core/codepage/index.js';
import { Color, Highlighting, Screen } from '../../../src/core/screen/index.js';
import { OUTLINE, cellStyle, rowRuns } from '../../../src/renderer/cell-style.js';

const t = (s: string) => [...cp037.encode(s)];
const mono = { codePage: cp037, displayMode: 'monochrome' as const };
const color = { codePage: cp037, displayMode: 'color' as const };

function screen(): Screen {
  const s = new Screen(2, 20);
  s.startField(0, 0x60); // protected, normal
  t('LABEL').forEach((b, i) => s.writeChar(1 + i, b));
  s.startField(6, 0x40); // unprotected, normal
  t('in').forEach((b, i) => s.writeChar(7 + i, b));
  s.startField(10, 0x68); // protected, intensified
  t('HI').forEach((b, i) => s.writeChar(11 + i, b));
  s.startField(14, 0x4c); // unprotected, hidden
  t('PW').forEach((b, i) => s.writeChar(15 + i, b));
  s.startField(18, 0x48); // unprotected, intensified
  return s;
}

describe('cellStyle', () => {
  it('shows characters through the code page', () => {
    expect(cellStyle(screen(), 1, mono)).toMatchObject({ char: 'L', fieldAttribute: false });
  });

  it('draws Graphic Escape (APL set) cells from code page 310, as ISPF box lines', () => {
    const s = new Screen(1, 4);
    // ISPF: GE X'C5' ┌, GE X'A2' ─, GE X'D5' ┐; a plain X'A2' is "s" in CP037.
    [0xc5, 0xa2, 0xd5].forEach((b, i) => s.writeChar(i, b, { charset: 0xf1 }));
    s.writeChar(3, 0xa2);
    expect([0, 1, 2, 3].map((a) => cellStyle(s, a, mono).char).join('')).toBe('┌─┐s');
    expect(s.toText(cp037)).toEqual(['┌─┐s']);
  });

  it('outlines a field: over and under every character, left and right at its ends', () => {
    const s = new Screen(1, 12);
    s.startField(0, 0x40, { outlining: 0x0f }); // all four sides
    t('ABCD').forEach((b, i) => s.writeChar(1 + i, b));
    s.startField(5, 0x60);
    const o = (a: number) => cellStyle(s, a, color).outline;
    expect(o(0)).toBe(0); // the attribute cell itself
    expect(o(1)).toBe(OUTLINE.TOP | OUTLINE.BOTTOM | OUTLINE.LEFT);
    expect(o(2)).toBe(OUTLINE.TOP | OUTLINE.BOTTOM);
    expect(o(4)).toBe(OUTLINE.TOP | OUTLINE.BOTTOM | OUTLINE.RIGHT);
    expect(o(6)).toBe(0); // the next field has none
  });

  it('does not paint the background of transparent cells', () => {
    const s = new Screen(1, 6);
    s.startField(0, 0x60, { background: 0xf2 });
    s.writeChar(1, 0xc1);
    s.startField(2, 0x60, { background: 0xf2, transparency: 0xf0 });
    s.writeChar(3, 0xc1);
    s.writeChar(4, 0xc1, { transparency: 0xff }); // opaque on the character overrides nothing here
    expect(cellStyle(s, 1, color).bg).toBe('red');
    expect(cellStyle(s, 3, color).bg).toBe('background');
  });

  it('draws field attribute cells as blanks', () => {
    expect(cellStyle(screen(), 0, mono)).toMatchObject({ char: ' ', fieldAttribute: true });
  });

  it('blanks hidden fields, nulls and control characters', () => {
    const s = screen();
    expect(cellStyle(s, 15, mono).char).toBe(' ');
    expect(cellStyle(s, 9, mono).char).toBe(' '); // null
    s.writeChar(9, 0x15); // NL
    expect(cellStyle(s, 9, mono).char).toBe(' ');
  });

  it('shows DUP and Field Mark as overscored * and ; (GA23-0059 §3.2)', () => {
    const s = screen();
    s.writeChar(7, 0x1c);
    s.writeChar(8, 0x1e);
    expect(cellStyle(s, 7, mono).char).toBe('*̅');
    expect(cellStyle(s, 8, mono).char).toBe(';̅');
  });

  describe('monochrome (3278)', () => {
    it('uses the default colour, bright for intensified fields', () => {
      const s = screen();
      expect(cellStyle(s, 1, mono).fg).toBe('default');
      expect(cellStyle(s, 11, mono).fg).toBe('intensified');
      expect(cellStyle(s, 19, mono).fg).toBe('intensified');
    });

    it('ignores extended colours but honours highlighting', () => {
      const s = screen();
      s.writeChar(1, t('L')[0]!, { foreground: Color.RED, highlighting: Highlighting.REVERSE });
      expect(cellStyle(s, 1, mono)).toMatchObject({ fg: 'default', reverse: true });
    });
  });

  describe('colour (3279)', () => {
    it('uses base colours from the field attribute when the host sends none', () => {
      const s = screen();
      expect(cellStyle(s, 1, color).fg).toBe('blue'); // protected normal
      expect(cellStyle(s, 7, color).fg).toBe('green'); // unprotected normal
      expect(cellStyle(s, 11, color).fg).toBe('white'); // protected intensified
      expect(cellStyle(s, 19, color).fg).toBe('red'); // unprotected intensified
    });

    it('uses the field’s extended colour, overridden by the character’s', () => {
      const s = screen();
      s.modifyField(6, { foreground: Color.TURQUOISE });
      expect(cellStyle(s, 7, color).fg).toBe('turquoise');
      s.writeChar(8, t('n')[0]!, { foreground: Color.YELLOW });
      expect(cellStyle(s, 8, color).fg).toBe('yellow');
    });

    it('maps every 3279 and extended colour value', () => {
      const s = new Screen(1, 20);
      const values = [
        0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe,
        0xff,
      ];
      values.forEach((v, i) => s.writeChar(i, 0xc1, { foreground: v, background: v }));
      expect(values.map((_, i) => cellStyle(s, i, color).fg)).toEqual([
        'neutralBlack',
        'blue',
        'red',
        'pink',
        'green',
        'turquoise',
        'yellow',
        'neutralWhite',
        'black',
        'deepBlue',
        'orange',
        'purple',
        'paleGreen',
        'paleTurquoise',
        'grey',
        'white',
      ]);
      expect(cellStyle(s, 1, color).bg).toBe('blue');
      expect(cellStyle(s, 1, mono).bg).toBe('background');
    });
  });

  it('applies field highlighting, overridden by character highlighting', () => {
    const s = screen();
    s.modifyField(6, { highlighting: Highlighting.UNDERSCORE });
    expect(cellStyle(s, 7, mono)).toMatchObject({ underscore: true, reverse: false, blink: false });
    s.writeChar(8, t('n')[0]!, { highlighting: Highlighting.BLINK });
    expect(cellStyle(s, 8, mono)).toMatchObject({ underscore: false, blink: true });
    s.writeChar(8, t('n')[0]!, { highlighting: Highlighting.INTENSIFY });
    expect(cellStyle(s, 8, mono).fg).toBe('intensified');
  });

  it('works on an unformatted screen', () => {
    const s = new Screen(1, 4);
    s.writeChar(0, t('A')[0]!);
    expect(cellStyle(s, 0, mono)).toMatchObject({ char: 'A', fg: 'default' });
    expect(cellStyle(s, 0, color).fg).toBe('green');
  });
});

describe('rowRuns', () => {
  it('groups a row into runs of identically styled text', () => {
    const runs = rowRuns(screen(), 0, color);
    expect(runs.map((r) => [r.start, r.text, r.style.fg])).toEqual([
      [0, ' LABEL', 'blue'],
      [6, ' in ', 'green'],
      [10, ' HI ', 'white'],
      [14, '    ', 'green'],
      [18, '  ', 'red'],
    ]);
  });

  it('covers every column exactly once', () => {
    const s = screen();
    for (const mode of [mono, color]) {
      const runs = rowRuns(s, 1, mode);
      expect(runs.reduce((n, r) => n + r.length, 0)).toBe(20);
    }
  });

  it('keeps combining overlines inside their cell', () => {
    const s = new Screen(1, 3);
    s.writeChar(0, 0x1c);
    s.writeChar(1, t('A')[0]!);
    const [run] = rowRuns(s, 0, mono);
    expect(run!.length).toBe(3);
    expect(run!.text).toBe('*̅A ');
  });
});
