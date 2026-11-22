import { describe, expect, it } from 'vitest';
import { CP310, cp037, displayChar } from '../../../../src/core/codepage/index.js';

describe('code page 310 (APL / Graphic Escape)', () => {
  it('maps the box-drawing characters ISPF uses', () => {
    const box = { 0xa2: '─', 0x85: '│', 0xc5: '┌', 0xd5: '┐', 0xc4: '└', 0xd4: '┘' };
    for (const [b, ch] of Object.entries(box)) expect(CP310.get(Number(b))).toBe(ch);
  });

  it('maps APL symbols, and shows underlined letters as plain ones', () => {
    expect(CP310.get(0xb0)).toBe('⍺');
    expect(CP310.get(0xb2)).toBe('⍳');
    expect(CP310.get(0xba)).toBe('∇');
    expect(CP310.get(0x41)).toBe('A');
    expect(CP310.get(0x69)).toBe('Z');
  });

  it('displayChar picks the code page by character set', () => {
    expect(displayChar(0xa2, 0, cp037)).toBe('s');
    expect(displayChar(0xa2, 0xf1, cp037)).toBe('─');
    expect(displayChar(0x00, 0, cp037)).toBeUndefined();
    expect(displayChar(0x01, 0xf1, cp037)).toBeUndefined();
  });
});
