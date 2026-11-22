import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CODES,
  AddressMode,
  addressModeFor,
  decodeAddress,
  encodeAddress,
  isValidAddress,
  nextAddress,
  prevAddress,
  toAddress,
  toRowCol,
} from '../../../../src/core/screen/address.js';

describe('6-bit address code table (GA23-0059 §3.3, Figure "Buffer address codes")', () => {
  it('has 64 entries whose low six bits are their own index', () => {
    expect(ADDRESS_CODES).toHaveLength(64);
    ADDRESS_CODES.forEach((code, i) => expect(code & 0x3f).toBe(i));
  });

  it('uses only graphic EBCDIC characters, so addresses survive as text', () => {
    expect(ADDRESS_CODES[0]).toBe(0x40);
    expect(ADDRESS_CODES[1]).toBe(0xc1);
    expect(ADDRESS_CODES[10]).toBe(0x4a);
    expect(ADDRESS_CODES[16]).toBe(0x50);
    expect(ADDRESS_CODES[33]).toBe(0x61);
    expect(ADDRESS_CODES[48]).toBe(0xf0);
    expect(ADDRESS_CODES[63]).toBe(0x7f);
    for (const c of ADDRESS_CODES) expect(c).toBeGreaterThanOrEqual(0x40);
  });
});

describe('decodeAddress', () => {
  it('decodes 12-bit coded addresses', () => {
    expect(decodeAddress(0x40, 0x40)).toBe(0);
    expect(decodeAddress(0x40, 0xc1)).toBe(1);
    expect(decodeAddress(0xc1, 0x50)).toBe(80); // row 1, col 0 on an 80-column screen
    expect(decodeAddress(0x5d, 0x7f)).toBe(1919); // last cell of model 2
    expect(decodeAddress(0x7f, 0x7f)).toBe(4095);
  });

  it('treats B10 in the top bits as 12-bit too (reserved; hosts do not send it)', () => {
    expect(decodeAddress(0x81, 0x50)).toBe(80);
  });

  it('decodes 14-bit binary addresses when the top two bits are B00', () => {
    expect(decodeAddress(0x00, 0x00)).toBe(0);
    expect(decodeAddress(0x00, 0x50)).toBe(80);
    expect(decodeAddress(0x07, 0x7f)).toBe(1919);
    expect(decodeAddress(0x3f, 0xff)).toBe(16383);
  });

  it('decodes the TK5 logon cursor position', () => {
    // s3270 reported the TK5 logon cursor at row 22, col 11 (zero-origin) on 24x80.
    expect(decodeAddress(0x5b, 0x6b)).toBe(22 * 80 + 11);
  });
});

describe('encodeAddress', () => {
  it('encodes 12-bit coded addresses', () => {
    expect([...encodeAddress(0, AddressMode.Coded12)]).toEqual([0x40, 0x40]);
    expect([...encodeAddress(80, AddressMode.Coded12)]).toEqual([0xc1, 0x50]);
    expect([...encodeAddress(1919, AddressMode.Coded12)]).toEqual([0x5d, 0x7f]);
    expect([...encodeAddress(4095, AddressMode.Coded12)]).toEqual([0x7f, 0x7f]);
  });

  it('encodes 14-bit binary addresses', () => {
    expect([...encodeAddress(80, AddressMode.Binary14)]).toEqual([0x00, 0x50]);
    expect([...encodeAddress(16383, AddressMode.Binary14)]).toEqual([0x3f, 0xff]);
  });

  it('round-trips every address in both modes', () => {
    for (let a = 0; a < 4096; a++) {
      const [b1, b2] = encodeAddress(a, AddressMode.Coded12);
      expect(decodeAddress(b1, b2)).toBe(a);
    }
    for (let a = 0; a < 16384; a++) {
      const [b1, b2] = encodeAddress(a, AddressMode.Binary14);
      expect(decodeAddress(b1, b2)).toBe(a);
    }
  });

  it('rejects addresses the mode cannot represent', () => {
    expect(() => encodeAddress(4096, AddressMode.Coded12)).toThrow(RangeError);
    expect(() => encodeAddress(16384, AddressMode.Binary14)).toThrow(RangeError);
    expect(() => encodeAddress(-1, AddressMode.Coded12)).toThrow(RangeError);
    expect(() => encodeAddress(1.5, AddressMode.Coded12)).toThrow(RangeError);
  });
});

describe('addressModeFor', () => {
  it('uses 12-bit coding for every buffer that fits in 4096 cells', () => {
    expect(addressModeFor(24 * 80)).toBe(AddressMode.Coded12); // model 2
    expect(addressModeFor(27 * 132)).toBe(AddressMode.Coded12); // model 5
    expect(addressModeFor(4096)).toBe(AddressMode.Coded12);
  });

  it('uses 14-bit binary for larger buffers', () => {
    expect(addressModeFor(4097)).toBe(AddressMode.Binary14);
    expect(addressModeFor(62 * 160)).toBe(AddressMode.Binary14);
  });
});

describe('address arithmetic', () => {
  const size = 1920;

  it('validates against the buffer size', () => {
    expect(isValidAddress(0, size)).toBe(true);
    expect(isValidAddress(1919, size)).toBe(true);
    expect(isValidAddress(1920, size)).toBe(false);
    expect(isValidAddress(-1, size)).toBe(false);
  });

  it('wraps forwards and backwards', () => {
    expect(nextAddress(0, size)).toBe(1);
    expect(nextAddress(1919, size)).toBe(0);
    expect(prevAddress(1, size)).toBe(0);
    expect(prevAddress(0, size)).toBe(1919);
  });

  it('converts between addresses and row/column', () => {
    expect(toRowCol(0, 80)).toEqual({ row: 0, col: 0 });
    expect(toRowCol(1691, 80)).toEqual({ row: 21, col: 11 });
    expect(toRowCol(3563, 132)).toEqual({ row: 26, col: 131 });
    expect(toAddress(21, 11, 80)).toBe(1691);
    expect(toAddress(26, 131, 132)).toBe(3563);
  });
});
