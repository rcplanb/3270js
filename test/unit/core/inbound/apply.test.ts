/** applyInbound: the operator's input put back on a screen built from the host's records. */
import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import { Aid, applyInbound, isOperatorInput } from '../../../../src/core/inbound/index.js';
import type { InboundRecord } from '../../../../src/core/inbound/index.js';
import { FieldAttribute, Screen } from '../../../../src/core/screen/index.js';

/** Row 0: "Name:" protected, an 8-cell input at 7, a hidden 8-cell field at 17, protected after. */
function screen(): Screen {
  const s = new Screen(24, 80);
  s.startField(0, FieldAttribute.PROTECTED);
  cp037.encode('Name:').forEach((b, i) => s.writeChar(1 + i, b));
  s.startField(6, 0); // input: 7..14
  s.startField(15, FieldAttribute.PROTECTED);
  s.startField(16, FieldAttribute.DISPLAY_HIDDEN); // password: 17..24
  s.startField(25, FieldAttribute.PROTECTED);
  cp037.encode('OLDTEXT').forEach((b, i) => s.writeChar(7 + i, b));
  return s;
}
const input = (
  fields: { address: number; text: string }[],
  aid: number = Aid.ENTER,
  cursor = 11,
): InboundRecord => ({
  aid,
  cursor,
  fields: fields.map((f) => ({ address: f.address, data: cp037.encode(f.text) })),
  fieldAttributes: [],
  errors: [],
});
const row0 = (s: Screen) => s.toText(cp037)[0]!;

describe('applyInbound', () => {
  it('puts the typed field on the screen, clears the rest of the field, and moves the cursor', () => {
    const s = screen();
    expect(applyInbound(s, input([{ address: 7, text: 'BOB' }]))).toBe(true);
    expect(row0(s).slice(0, 16)).toBe(' Name: BOB      ');
    expect(s.cursor).toBe(11);
  });

  it('never writes into a hidden field or a protected one', () => {
    const s = screen();
    const hiddenBefore = [17, 18, 19].map((a) => s.charAt(a));
    applyInbound(
      s,
      input([
        { address: 17, text: '****' },
        { address: 1, text: 'XX' },
      ]),
    );
    expect([17, 18, 19].map((a) => s.charAt(a))).toEqual(hiddenBefore);
    expect(row0(s).slice(0, 6)).toBe(' Name:');
  });

  it('ignores replies the host asked for, and unformatted screens', () => {
    const s = screen();
    expect(applyInbound(s, input([{ address: 7, text: 'BOB' }], Aid.QUERY_REPLY))).toBe(false);
    expect(isOperatorInput(input([], Aid.NONE))).toBe(false);
    expect(isOperatorInput({ ...input([]), errors: ['bad'] })).toBe(false);
    const plain = new Screen(24, 80);
    expect(applyInbound(plain, input([{ address: 0, text: 'HELLO' }]))).toBe(false);
    expect(plain.charAt(0)).toBe(0);
  });

  it('puts text typed after empty cells just before the cursor (TSO line mode)', () => {
    // READY on row 0, then one input field from row 0 col 8 to the end, all nulls;
    // the operator types TIME on row 1. Read Modified drops the nulls: "TIME" at 8.
    const s = new Screen(24, 80);
    s.startField(0, 0);
    cp037.encode('READY').forEach((b, i) => s.writeChar(1 + i, b));
    s.startField(7, 0);
    applyInbound(s, input([{ address: 8, text: 'TIME' }], Aid.ENTER, 84));
    const text = s.toText(cp037);
    expect(text[0]!.trimEnd()).toBe(' READY');
    expect(text[1]!.slice(0, 4)).toBe('TIME');
  });

  it('keeps the field start when the cells before the cursor are not empty', () => {
    const s = screen(); // the input field holds OLDTEXT
    applyInbound(s, input([{ address: 7, text: 'BO' }], Aid.ENTER, 14));
    expect(row0(s).slice(0, 16)).toBe(' Name: BO       ');
  });

  it('reports no change when the screen already shows the input', () => {
    const s = screen();
    applyInbound(s, input([{ address: 7, text: 'BOB' }]));
    expect(applyInbound(s, input([{ address: 7, text: 'BOB' }]))).toBe(false);
  });
});
