import { describe, expect, it } from 'vitest';
import {
  Ebcdic,
  cp037,
  createCodePage,
  getCodePage,
  isGraphic,
  listCodePages,
  registerCodePage,
} from '../../../../src/core/codepage/index.js';

describe('cp037', () => {
  it('maps the letters and digits', () => {
    expect(cp037.toUnicode(0xc1)).toBe('A');
    expect(cp037.toUnicode(0xc9)).toBe('I');
    expect(cp037.toUnicode(0xd1)).toBe('J');
    expect(cp037.toUnicode(0xe2)).toBe('S');
    expect(cp037.toUnicode(0xe9)).toBe('Z');
    expect(cp037.toUnicode(0x81)).toBe('a');
    expect(cp037.toUnicode(0xa9)).toBe('z');
    expect(cp037.toUnicode(0xf0)).toBe('0');
    expect(cp037.toUnicode(0xf9)).toBe('9');
  });

  it('maps the characters that differ between EBCDIC code pages', () => {
    // These are the classic CP037 positions; CP1047 and CP500 differ here.
    expect(cp037.toUnicode(0x40)).toBe(' ');
    expect(cp037.toUnicode(0x4a)).toBe('¢');
    expect(cp037.toUnicode(0x4f)).toBe('|');
    expect(cp037.toUnicode(0x5a)).toBe('!');
    expect(cp037.toUnicode(0x5f)).toBe('¬');
    expect(cp037.toUnicode(0x5b)).toBe('$');
    expect(cp037.toUnicode(0x7b)).toBe('#');
    expect(cp037.toUnicode(0x7c)).toBe('@');
    expect(cp037.toUnicode(0xb0)).toBe('^');
    expect(cp037.toUnicode(0xba)).toBe('[');
    expect(cp037.toUnicode(0xbb)).toBe(']');
    expect(cp037.toUnicode(0x41)).toBe(' '); // required space
  });

  it('is a bijection over all 256 bytes', () => {
    const seen = new Set<string>();
    for (let b = 0; b < 256; b++) {
      const ch = cp037.toUnicode(b);
      expect(ch).toHaveLength(1);
      seen.add(ch);
      expect(cp037.fromUnicode(ch)).toBe(b);
    }
    expect(seen.size).toBe(256);
  });

  it('returns undefined for characters outside the code page', () => {
    expect(cp037.fromUnicode('€')).toBeUndefined();
    expect(cp037.fromUnicode('é')).toBe(0x51);
    expect(cp037.fromUnicode('漢')).toBeUndefined();
  });

  it('rejects anything that is not exactly one character', () => {
    expect(cp037.fromUnicode('')).toBeUndefined();
    expect(cp037.fromUnicode('AB')).toBeUndefined();
  });

  it('rejects out-of-range bytes', () => {
    expect(() => cp037.toUnicode(256)).toThrow(RangeError);
    expect(() => cp037.toUnicode(-1)).toThrow(RangeError);
    expect(() => cp037.toUnicode(1.5)).toThrow(RangeError);
  });

  it('converts whole strings', () => {
    const bytes = cp037.encode('LOGON HERC01');
    expect([...bytes]).toEqual([
      0xd3, 0xd6, 0xc7, 0xd6, 0xd5, 0x40, 0xc8, 0xc5, 0xd9, 0xc3, 0xf0, 0xf1,
    ]);
    expect(cp037.decode(bytes)).toBe('LOGON HERC01');
  });

  it('encode reports the first unmappable character', () => {
    expect(() => cp037.encode('A€B')).toThrow(/U\+20AC.*index 1/);
  });
});

describe('3270 control characters (GA23-0059 §3.2)', () => {
  it('has the documented byte values', () => {
    expect(Ebcdic).toMatchObject({
      NUL: 0x00,
      SUB: 0x3f,
      DUP: 0x1c,
      FM: 0x1e,
      FF: 0x0c,
      CR: 0x0d,
      NL: 0x15,
      EM: 0x19,
      EO: 0xff,
      SPACE: 0x40,
    });
  });

  it('classifies graphic (displayable) codes as X40–XFE', () => {
    expect(isGraphic(0x3f)).toBe(false);
    expect(isGraphic(0x40)).toBe(true);
    expect(isGraphic(0xc1)).toBe(true);
    expect(isGraphic(0xfe)).toBe(true);
    expect(isGraphic(0xff)).toBe(false);
    expect(isGraphic(0x00)).toBe(false);
  });
});

describe('registry', () => {
  it('finds cp037 by id and aliases, case-insensitively', () => {
    expect(getCodePage('cp037')).toBe(cp037);
    expect(getCodePage('CP037')).toBe(cp037);
    expect(getCodePage('037')).toBe(cp037);
    expect(getCodePage('ibm-037')).toBe(cp037);
    expect(getCodePage('cp9999')).toBeUndefined();
    expect(listCodePages()).toContain('cp037');
  });

  it('accepts user-supplied code pages', () => {
    const table = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    const identity = createCodePage({ id: 'test-identity', name: 'Identity', table });
    registerCodePage(identity);
    expect(getCodePage('TEST-IDENTITY')).toBe(identity);
    expect(identity.fromUnicode('A')).toBe(0x41);
  });

  it('refuses to replace an existing code page or alias', () => {
    expect(() => registerCodePage(cp037)).toThrow(/already registered/);
  });

  it('validates tables', () => {
    expect(() => createCodePage({ id: 'short', name: 'Short', table: 'abc' })).toThrow(/256/);
    const dup = 'A'.repeat(256);
    expect(() => createCodePage({ id: 'dup', name: 'Dup', table: dup })).toThrow(/duplicate/);
  });
});

describe('more code pages (Phase 2)', () => {
  const pages = [
    // id, byte, character, CGCSGID
    ['cp1047', 0xad, '[', [697, 1047]],
    ['cp1047', 0x5f, '^', [697, 1047]],
    ['cp500', 0x4a, '[', [697, 500]],
    ['cp500', 0x4f, '!', [697, 500]],
    ['cp285', 0x5b, '£', [697, 285]],
    ['cp285', 0x4a, '$', [697, 285]],
    ['cp1140', 0x9f, '€', [695, 1140]],
  ] as const;

  it.each(pages)("%s: X'%s' is the right character", (id, byte, char, cgcsgid) => {
    const cp = getCodePage(id)!;
    expect(cp.toUnicode(byte)).toBe(char);
    expect(cp.fromUnicode(char)).toBe(byte);
    expect(cp.cgcsgid).toEqual(cgcsgid);
  });

  it('round-trips every byte, and answers to its aliases', () => {
    for (const id of ['cp1047', 'cp500', 'cp285', 'cp1140']) {
      const cp = getCodePage(id)!;
      const all = Uint8Array.from({ length: 256 }, (_, b) => b);
      expect([...cp.encode(cp.decode(all))]).toEqual([...all]);
      expect(getCodePage(id.slice(2))).toBe(cp); // e.g. "1047"
      expect(getCodePage(`IBM-${id.slice(2)}`)).toBe(cp);
    }
  });

  it('differs from CP037 only where it should', () => {
    const differing = (id: string) =>
      Array.from({ length: 256 }, (_, b) => b).filter(
        (b) => getCodePage(id)!.toUnicode(b) !== cp037.toUnicode(b),
      );
    expect(differing('cp1140')).toEqual([0x9f]); // the euro replaces ¤
    expect(differing('cp1047')).toEqual([0x5f, 0xad, 0xb0, 0xba, 0xbb, 0xbd]);
    expect(differing('cp285')).toEqual([0x4a, 0x5b, 0xa1, 0xb0, 0xb1, 0xba, 0xbc]);
  });

  it('lists all five', () => {
    expect(listCodePages()).toEqual(
      expect.arrayContaining(['cp037', 'cp1047', 'cp500', 'cp285', 'cp1140']),
    );
  });
});
