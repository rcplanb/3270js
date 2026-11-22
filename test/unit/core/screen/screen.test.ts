import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import {
  Color,
  FieldAttribute as FA,
  Highlighting,
  MODELS,
  Screen,
  decodeFieldAttribute,
} from '../../../../src/core/screen/index.js';

const C = (s: string) => [...cp037.encode(s)];

function write(screen: Screen, address: number, text: string) {
  C(text).forEach((b, i) => screen.writeChar((address + i) % screen.size, b));
}

describe('models', () => {
  it('defines the four standard 3278/3279 sizes', () => {
    expect(MODELS[2]).toEqual({ rows: 24, cols: 80 });
    expect(MODELS[3]).toEqual({ rows: 32, cols: 80 });
    expect(MODELS[4]).toEqual({ rows: 43, cols: 80 });
    expect(MODELS[5]).toEqual({ rows: 27, cols: 132 });
  });
});

describe('decodeFieldAttribute (GA23-0059 §4.2)', () => {
  it('decodes each bit', () => {
    expect(decodeFieldAttribute(0x60)).toMatchObject({
      protected: true,
      numeric: false,
      autoskip: false,
      display: 'normal',
      detectable: false,
      modified: false,
    });
    expect(decodeFieldAttribute(0xf0)).toMatchObject({ protected: true, autoskip: true });
    expect(decodeFieldAttribute(0x50)).toMatchObject({ protected: false, numeric: true });
    expect(decodeFieldAttribute(0xe8)).toMatchObject({
      display: 'intensified',
      detectable: true,
    });
    expect(decodeFieldAttribute(0x44)).toMatchObject({ display: 'normal', detectable: true });
    expect(decodeFieldAttribute(0x4c)).toMatchObject({ display: 'hidden', detectable: false });
    expect(decodeFieldAttribute(0xc1)).toMatchObject({ modified: true });
  });
});

describe('Screen', () => {
  it('starts cleared and unformatted', () => {
    const s = new Screen(24, 80);
    expect(s.size).toBe(1920);
    expect(s.cursor).toBe(0);
    expect(s.charAt(0)).toBe(0);
    expect(s.isFormatted).toBe(false);
    expect(s.fields).toEqual([]);
    expect(s.fieldAt(100)).toBeUndefined();
  });

  it('stores characters with their own attributes', () => {
    const s = new Screen(24, 80);
    s.writeChar(5, 0xc1, { foreground: Color.RED, highlighting: Highlighting.REVERSE });
    expect(s.charAt(5)).toBe(0xc1);
    expect(s.attributesAt(5)).toEqual({
      foreground: Color.RED,
      background: 0,
      highlighting: Highlighting.REVERSE,
      charset: 0,
      transparency: 0,
    });
    s.writeChar(5, 0xc2);
    expect(s.attributesAt(5).foreground).toBe(0); // a plain write resets them
  });

  it('rejects invalid addresses and cursor positions', () => {
    const s = new Screen(24, 80);
    expect(() => s.writeChar(1920, 0x40)).toThrow(RangeError);
    expect(() => s.charAt(-1)).toThrow(RangeError);
    expect(() => {
      s.cursor = 1920;
    }).toThrow(RangeError);
    s.cursor = 1919;
    expect(s.cursor).toBe(1919);
  });

  describe('fields', () => {
    it('derives fields from field attribute cells', () => {
      const s = new Screen(24, 80);
      s.startField(0, 0x60); // protected label
      write(s, 1, 'USERID');
      s.startField(10, 0x40); // unprotected input
      s.startField(19, 0x60);

      expect(s.isFormatted).toBe(true);
      expect(s.fields.map((f) => [f.start, f.length, f.protected])).toEqual([
        [0, 9, true],
        [10, 8, false],
        [19, 1900, true], // wraps to the end of the buffer
      ]);
      expect(s.fields[1]!.dataStart).toBe(11);
      expect(s.isFieldAttribute(10)).toBe(true);
      expect(s.charAt(10)).toBe(0); // FA cells hold no character
    });

    it('wraps the last field around the end of the buffer', () => {
      const s = new Screen(24, 80);
      s.startField(5, 0x40);
      s.startField(1900, 0x60);
      expect(s.fields.map((f) => [f.start, f.length])).toEqual([
        [5, 1894],
        [1900, 24], // 1901..1919 plus 0..4
      ]);
      expect(s.fieldAt(2)!.start).toBe(1900);
      expect(s.fieldAt(1919)!.start).toBe(1900);
      expect(s.fieldAt(6)!.start).toBe(5);
    });

    it('treats a single field as covering the whole buffer', () => {
      const s = new Screen(24, 80);
      s.startField(100, 0x40);
      expect(s.fields).toHaveLength(1);
      expect(s.fields[0]!.length).toBe(1919);
      expect(s.fieldAt(99)!.start).toBe(100);
    });

    it('handles adjacent field attributes (zero-length fields)', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x60);
      s.startField(11, 0x40);
      expect(s.fields[0]).toMatchObject({ start: 10, length: 0 });
    });

    it('returns the field itself for its attribute cell', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x40);
      s.startField(20, 0x60);
      expect(s.fieldAt(20)!.start).toBe(20);
    });

    it('removes a field when its attribute cell is overwritten by a character', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x40);
      s.startField(20, 0x60);
      s.writeChar(20, 0xc1);
      expect(s.isFieldAttribute(20)).toBe(false);
      expect(s.fields.map((f) => f.start)).toEqual([10]);
    });

    it('keeps field extended attributes on the attribute cell', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x40, { foreground: Color.TURQUOISE, validation: 0x02 });
      expect(s.fields[0]).toMatchObject({ foreground: Color.TURQUOISE, validation: 0x02 });
      expect(s.attributesAt(10).foreground).toBe(Color.TURQUOISE);
    });

    it('stores only the meaningful attribute bits', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0xc5); // graphic-converted: bits 0-1 set
      expect(s.fieldAttributeAt(10)).toBe(0x05);
      expect(s.fieldAttributeAt(11)).toBeUndefined();
    });
  });

  describe('replaceChar and modifyField', () => {
    it('replaceChar keeps colour and highlighting but resets the character set', () => {
      const s = new Screen(24, 80);
      s.writeChar(5, 0xc1, {
        foreground: Color.RED,
        highlighting: Highlighting.BLINK,
        charset: 0xf1,
      });
      s.replaceChar(5, 0x00);
      expect(s.charAt(5)).toBe(0);
      expect(s.attributesAt(5)).toMatchObject({
        foreground: Color.RED,
        highlighting: Highlighting.BLINK,
        charset: 0,
      });
    });

    it('modifyField changes only what it is given', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x40, { foreground: Color.GREEN, validation: 0x02 });
      s.modifyField(10, { attribute: 0x60, highlighting: Highlighting.REVERSE });
      expect(s.fields[0]).toMatchObject({
        protected: true,
        foreground: Color.GREEN,
        highlighting: Highlighting.REVERSE,
        validation: 0x02,
      });
      s.modifyField(10, {
        background: Color.BLUE,
        charset: 0xf1,
        transparency: 0xf0,
        outlining: 0x01,
        foreground: Color.RED,
        validation: 0,
      });
      expect(s.fields[0]).toMatchObject({
        attribute: 0x20,
        background: Color.BLUE,
        charset: 0xf1,
        transparency: 0xf0,
        outlining: 0x01,
        foreground: Color.RED,
        validation: 0,
      });
    });

    it('modifyField refuses non-attribute cells', () => {
      const s = new Screen(24, 80);
      expect(() => s.modifyField(3, { attribute: 0x60 })).toThrow(/not a field attribute/);
    });
  });

  describe('modified data tags', () => {
    it('sets and clears a field’s MDT', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x40);
      s.setModified(10, true);
      expect(s.fields[0]!.modified).toBe(true);
      expect(s.fieldAttributeAt(10)).toBe(0x00 | FA.MDT);
      s.setModified(10, false);
      expect(s.fields[0]!.modified).toBe(false);
    });

    it('resets every MDT at once (WCC reset MDT)', () => {
      const s = new Screen(24, 80);
      s.startField(10, 0x41);
      s.startField(30, 0xc1);
      s.resetModified();
      expect(s.fields.every((f) => !f.modified)).toBe(true);
    });

    it('refuses to set an MDT on a non-attribute cell', () => {
      const s = new Screen(24, 80);
      expect(() => s.setModified(5, true)).toThrow(/not a field attribute/);
    });
  });

  describe('clear and resize', () => {
    it('clears everything, including attributes and the cursor', () => {
      const s = new Screen(24, 80);
      s.startField(0, 0x40, { foreground: Color.RED });
      s.writeChar(5, 0xc1, { highlighting: Highlighting.BLINK });
      s.cursor = 50;
      s.clear();
      expect(s.charAt(5)).toBe(0);
      expect(s.attributesAt(5).highlighting).toBe(0);
      expect(s.isFieldAttribute(0)).toBe(false);
      expect(s.attributesAt(0).foreground).toBe(0);
      expect(s.cursor).toBe(0);
      expect(s.isFormatted).toBe(false);
    });

    it('rejects impossible geometries', () => {
      expect(() => new Screen(0, 80)).toThrow(RangeError);
      expect(() => new Screen(24, 80.5)).toThrow(RangeError);
    });

    it('resizes to a new geometry and clears', () => {
      const s = new Screen(24, 80);
      s.writeChar(5, 0xc1);
      s.resize(27, 132);
      expect([s.rows, s.cols, s.size]).toEqual([27, 132, 3564]);
      expect(s.charAt(5)).toBe(0);
      s.writeChar(3563, 0xc1);
      expect(s.charAt(3563)).toBe(0xc1);
    });
  });

  describe('change tracking', () => {
    it('reports dirty rows once', () => {
      const s = new Screen(24, 80);
      s.takeDirtyRows();
      s.writeChar(85, 0xc1); // row 1
      s.writeChar(1919, 0xc1); // row 23
      expect(s.takeDirtyRows()).toEqual([1, 23]);
      expect(s.takeDirtyRows()).toEqual([]);
    });

    it('marks every row dirty when the field layout changes', () => {
      const s = new Screen(24, 80);
      s.takeDirtyRows();
      s.startField(10, 0x4c); // a hidden field changes how later rows look
      expect(s.takeDirtyRows()).toHaveLength(24);
    });

    it('bumps the version on every change', () => {
      const s = new Screen(24, 80);
      const v0 = s.version;
      s.writeChar(0, 0xc1);
      const v1 = s.version;
      s.cursor = 5;
      expect(v1).toBeGreaterThan(v0);
      expect(s.version).toBeGreaterThan(v1);
    });
  });

  describe('toText', () => {
    it('renders rows as Unicode, with blanks for nulls and attribute cells', () => {
      const s = new Screen(2, 10);
      s.startField(0, 0x60);
      write(s, 1, 'LOGON');
      s.startField(10, 0x40);
      write(s, 11, 'HERC01');
      expect(s.toText(cp037)).toEqual([' LOGON    ', ' HERC01   ']);
    });

    it('hides non-display fields unless asked', () => {
      const s = new Screen(1, 10);
      s.startField(0, 0x4c);
      write(s, 1, 'SECRET');
      expect(s.toText(cp037)).toEqual(['          ']);
      expect(s.toText(cp037, { showHidden: true })).toEqual([' SECRET   ']);
    });

    it('blanks control characters', () => {
      const s = new Screen(1, 4);
      s.writeChar(0, 0x1c); // DUP
      s.writeChar(1, 0xc1);
      s.writeChar(2, 0x15); // NL
      s.writeChar(3, 0xff); // EO
      expect(s.toText(cp037)).toEqual([' A  ']);
    });
  });
});
