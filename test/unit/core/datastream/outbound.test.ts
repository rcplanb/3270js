import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import {
  Command,
  Order,
  commandKind,
  decodeWcc,
  processOutbound,
  type OutboundResult,
} from '../../../../src/core/datastream/index.js';
import {
  AddressMode,
  AttributeType as AT,
  CharacterSet,
  Color,
  Highlighting,
  Screen,
  encodeAddress,
} from '../../../../src/core/screen/index.js';

const GEOMETRY = { default: { rows: 24, cols: 80 }, alternate: { rows: 27, cols: 132 } };
const t = (s: string) => [...cp037.encode(s)];
const at = (a: number) => encodeAddress(a, AddressMode.Coded12);
const { SF, SFE, SBA, IC, PT, RA, EUA, GE, SA, MF } = Order;

// WCC values as hosts send them (graphic-converted).
const WCC_NONE = 0x40;
const WCC_RESTORE = 0xc2; // keyboard restore
const WCC_RESET_MDT = 0xc1;

function run(screen: Screen, ...bytes: (number | number[])[]): OutboundResult {
  return processOutbound(screen, Uint8Array.from(bytes.flat()), GEOMETRY);
}
function fresh(): Screen {
  return new Screen(24, 80);
}
function text(screen: Screen, address: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = screen.charAt((address + i) % screen.size);
    s += b === 0 ? '·' : cp037.toUnicode(b);
  }
  return s;
}

describe('commands (GA23-0059 §3.1)', () => {
  it('recognises local and SNA command codes', () => {
    expect(commandKind(0xf1)).toBe('W');
    expect(commandKind(0x01)).toBe('W');
    expect(commandKind(0xf5)).toBe('EW');
    expect(commandKind(0x05)).toBe('EW');
    expect(commandKind(0x7e)).toBe('EWA');
    expect(commandKind(0x0d)).toBe('EWA');
    expect(commandKind(0x6f)).toBe('EAU');
    expect(commandKind(0x0f)).toBe('EAU');
    expect(commandKind(0xf3)).toBe('WSF');
    expect(commandKind(0x11)).toBe('WSF');
    expect(commandKind(0xf2)).toBe('RB');
    expect(commandKind(0x02)).toBe('RB');
    expect(commandKind(0xf6)).toBe('RM');
    expect(commandKind(0x06)).toBe('RM');
    expect(commandKind(0x6e)).toBe('RMA');
    expect(commandKind(0x0e)).toBe('RMA');
    expect(commandKind(0x03)).toBe('NOP');
    expect(commandKind(0x99)).toBeUndefined();
    expect(Command.EW).toBe(0xf5);
  });

  it('reports an empty record and an unknown command', () => {
    expect(run(fresh()).errors).toEqual([expect.stringMatching(/empty/)]);
    const r = run(fresh(), 0x99);
    expect(r.command).toBeUndefined();
    expect(r.errors).toEqual([expect.stringMatching(/unknown command X'99'/)]);
  });

  it('asks for inbound reads', () => {
    expect(run(fresh(), 0xf2).read).toBe('buffer');
    expect(run(fresh(), 0xf6).read).toBe('modified');
    expect(run(fresh(), 0x6e).read).toBe('modifiedAll');
  });

  it('hands structured fields back unparsed', () => {
    const r = run(fresh(), 0xf3, 0x00, 0x05, 0x01, 0xff, 0x02);
    expect(r.command).toBe('WSF');
    expect([...r.structuredFields!]).toEqual([0x00, 0x05, 0x01, 0xff, 0x02]);
  });

  it('does nothing for NOP', () => {
    expect(run(fresh(), 0x03)).toMatchObject({ command: 'NOP', errors: [] });
  });
});

describe('WCC (GA23-0059 §3.4)', () => {
  it('decodes each bit', () => {
    expect(decodeWcc(0xc3)).toEqual({
      reset: true,
      startPrinter: false,
      soundAlarm: false,
      keyboardRestore: true,
      resetMdt: true,
    });
    expect(decodeWcc(0x4c)).toMatchObject({ startPrinter: true, soundAlarm: true });
  });

  it('reports keyboard restore and alarm to the caller', () => {
    expect(run(fresh(), 0xf1, WCC_RESTORE)).toMatchObject({ keyboardRestore: true, alarm: false });
    expect(run(fresh(), 0xf1, 0x44)).toMatchObject({ keyboardRestore: false, alarm: true });
  });

  it('resets MDTs before processing orders', () => {
    const s = fresh();
    s.startField(10, 0x41);
    run(s, 0xf1, WCC_RESET_MDT, SBA, at(20), SF, 0x41);
    expect(s.fieldAttributeAt(10)).toBe(0x00);
    expect(s.fieldAttributeAt(20)).toBe(0x01); // set by this write, after the reset
  });

  it('reports a write with no WCC', () => {
    expect(run(fresh(), 0xf1).errors).toEqual([expect.stringMatching(/WCC/)]);
  });
});

describe('Erase/Write and Write', () => {
  it('EW clears the buffer and writes from address 0', () => {
    const s = fresh();
    s.writeChar(500, 0xc1);
    s.cursor = 300;
    run(s, 0xf5, WCC_NONE, t('HI'));
    expect(text(s, 0, 3)).toBe('HI·');
    expect(s.charAt(500)).toBe(0);
    expect(s.cursor).toBe(0);
  });

  it('W writes from the cursor and leaves it there without IC', () => {
    const s = fresh();
    s.writeChar(500, 0xc1);
    s.cursor = 100;
    run(s, 0xf1, WCC_NONE, t('AB'));
    expect(text(s, 100, 2)).toBe('AB');
    expect(s.charAt(500)).toBe(0xc1);
    expect(s.cursor).toBe(100);
  });

  it('EWA switches to the alternate size and EW back to the default', () => {
    const s = fresh();
    const r = run(s, 0x7e, WCC_NONE, SBA, at(3563), t('Z'));
    expect(r.alternate).toBe(true);
    expect([s.rows, s.cols]).toEqual([27, 132]);
    expect(s.charAt(3563)).toBe(t('Z')[0]);
    run(s, 0xf5, WCC_NONE);
    expect([s.rows, s.cols]).toEqual([24, 80]);
  });

  it('writes characters, wrapping at the end of the buffer', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, SBA, at(1918), t('ABC'));
    expect(text(s, 1918, 3)).toBe('ABC');
  });

  it('stores format control characters as data (GA23-0059 §4.3.1)', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, 0x1c, 0x1e, 0x0c, 0x0d, 0x15, 0x19, 0x3f, 0x25, 0xff, 0x00);
    expect([...Array(10).keys()].map((a) => s.charAt(a))).toEqual([
      0x1c, 0x1e, 0x0c, 0x0d, 0x15, 0x19, 0x3f, 0x25, 0xff, 0x00,
    ]);
  });

  it('skips unsupported order codes with a warning', () => {
    const s = fresh();
    const r = run(s, 0xf5, WCC_NONE, 0x2b, t('A'));
    expect(s.charAt(0)).toBe(t('A')[0]);
    expect(r.warnings).toEqual([expect.stringMatching(/X'2B'/)]);
    expect(r.errors).toEqual([]);
  });
});

describe('orders', () => {
  it('SF starts a field and advances', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, SF, 0x60, t('LABEL'), SF, 0x40);
    expect(s.fieldAttributeAt(0)).toBe(0x20);
    expect(text(s, 1, 5)).toBe('LABEL');
    expect(s.fieldAttributeAt(6)).toBe(0x00);
  });

  it('SBA moves the buffer address; an out-of-range SBA aborts the write', () => {
    const s = fresh();
    const r = run(
      s,
      0xf5,
      WCC_NONE,
      SBA,
      at(80),
      t('A'),
      SBA,
      encodeAddress(1920, AddressMode.Coded12),
      t('B'),
    );
    expect(s.charAt(80)).toBe(t('A')[0]);
    expect(r.errors).toEqual([expect.stringMatching(/SBA address 1920/)]);
    expect(s.charAt(1920 % 1920)).toBe(0); // B was not written anywhere
  });

  it('IC places the cursor; the last IC wins', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, SBA, at(100), IC, SBA, at(200), IC, t('X'));
    expect(s.cursor).toBe(200);
  });

  it('applies IC even when a later order aborts the write', () => {
    const s = fresh();
    const r = run(s, 0xf5, WCC_RESTORE, SBA, at(100), IC, SBA, 0x7f);
    expect(r.errors).toHaveLength(1);
    expect(s.cursor).toBe(100);
    expect(r.keyboardRestore).toBe(true);
  });

  describe('RA', () => {
    it('repeats a character up to (not including) the address', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SBA, at(10), RA, at(15), t('-'), t('X'));
      expect(text(s, 9, 7)).toBe('·-----X');
    });

    it('fills the whole buffer when the address equals the current one', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SBA, at(5), RA, at(5), t('*'));
      expect(text(s, 0, 1920)).toBe('*'.repeat(1920));
    });

    it('wraps past the end of the buffer', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SBA, at(1918), RA, at(2), t('='));
      expect(text(s, 1917, 6)).toBe('·====·');
    });

    it('repeats a graphic-escape character in the APL set', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, RA, at(3), GE, 0xad);
      expect(s.charAt(2)).toBe(0xad);
      expect(s.attributesAt(2).charset).toBe(CharacterSet.APL);
    });

    it('rejects an out-of-range address and truncated forms', () => {
      expect(run(fresh(), 0xf5, WCC_NONE, RA, 0x7f, 0x7f, 0x40).errors[0]).toMatch(/RA address/);
      expect(run(fresh(), 0xf5, WCC_NONE, RA, at(3)).errors[0]).toMatch(/too short/);
      expect(run(fresh(), 0xf5, WCC_NONE, RA, at(3), GE).errors[0]).toMatch(/too short/);
    });
  });

  describe('EUA', () => {
    it('nulls unprotected characters up to the address, leaving protected ones', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SF, 0x60, t('PROT'), SF, 0x40, t('DATA'), SF, 0x60, t('KEEP'));
      run(s, 0xf1, WCC_NONE, SBA, at(0), EUA, at(15));
      expect(text(s, 1, 4)).toBe('PROT');
      expect(text(s, 6, 4)).toBe('····');
      expect(text(s, 11, 4)).toBe('KEEP');
      expect(s.isFieldAttribute(5)).toBe(true);
    });

    it('starts from the field containing the current address', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SF, 0x40, t('ABCDEF'));
      run(s, 0xf1, WCC_NONE, SBA, at(3), EUA, at(5));
      expect(text(s, 1, 6)).toBe('AB··EF');
    });

    it('nulls everything on an unformatted screen', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, t('ABCDEF'));
      run(s, 0xf1, WCC_NONE, SBA, at(1), EUA, at(4));
      expect(text(s, 0, 6)).toBe('A···EF');
    });

    it('rejects an out-of-range address', () => {
      expect(run(fresh(), 0xf5, WCC_NONE, EUA, 0x7f, 0x7f).errors[0]).toMatch(/EUA address/);
    });
  });

  describe('PT (GA23-0059 §4.3.5)', () => {
    // Fields: protected at 0, unprotected at 10 (data 11..19), protected at 20,
    // unprotected at 30 (data 31..).
    function formatted() {
      const s = fresh();
      run(
        s,
        0xf5,
        WCC_NONE,
        SF,
        0x60,
        SBA,
        at(10),
        SF,
        0x40,
        SBA,
        at(20),
        SF,
        0x60,
        SBA,
        at(30),
        SF,
        0x40,
      );
      return s;
    }

    it('after an order, moves to the next unprotected field without nulling', () => {
      const s = formatted();
      run(s, 0xf1, WCC_NONE, SBA, at(12), t('ABCDEF'), SBA, at(12), PT, t('X'));
      expect(text(s, 12, 6)).toBe('ABCDEF');
      expect(s.charAt(31)).toBe(t('X')[0]);
    });

    it('after text, nulls to the end of the current field first', () => {
      const s = formatted();
      run(s, 0xf1, WCC_NONE, SBA, at(11), t('ABCDEFGH'), SBA, at(11), t('Q'), PT, t('X'));
      expect(text(s, 11, 9)).toBe('Q········');
      expect(s.charAt(31)).toBe(t('X')[0]);
    });

    it('on an unprotected field attribute, advances just one position', () => {
      const s = formatted();
      run(s, 0xf1, WCC_NONE, SBA, at(10), PT, t('X'));
      expect(s.charAt(11)).toBe(t('X')[0]);
    });

    it('goes to address 0 when the next unprotected field is behind it', () => {
      const s = formatted();
      run(s, 0xf1, WCC_NONE, SBA, at(40), PT, t('X'));
      expect(s.isFieldAttribute(0)).toBe(false); // X overwrote the attribute at 0
      expect(s.charAt(0)).toBe(t('X')[0]);
    });

    it('goes to address 0 on a screen with no unprotected fields', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SBA, at(50), SF, 0x60);
      s.cursor = 100;
      run(s, 0xf1, WCC_NONE, SBA, at(60), PT, IC);
      expect(s.cursor).toBe(0);
    });
  });

  describe('SFE (GA23-0059 §4.3.2)', () => {
    it('starts a field with extended attributes', () => {
      const s = fresh();
      run(
        s,
        0xf5,
        WCC_NONE,
        SFE,
        3,
        AT.FIELD_ATTRIBUTE,
        0x60,
        AT.FOREGROUND,
        Color.YELLOW,
        AT.HIGHLIGHTING,
        Highlighting.REVERSE,
      );
      expect(s.fields[0]).toMatchObject({
        start: 0,
        protected: true,
        foreground: Color.YELLOW,
        highlighting: Highlighting.REVERSE,
      });
    });

    it('defaults the field attribute to unprotected/normal when none is given', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SFE, 1, AT.BACKGROUND, Color.BLUE, t('A'));
      expect(s.fields[0]).toMatchObject({ attribute: 0, protected: false, background: Color.BLUE });
      expect(s.charAt(1)).toBe(t('A')[0]);
    });

    it('stores validation, outlining, charset and transparency; ignores unknown types', () => {
      const s = fresh();
      run(
        s,
        0xf5,
        WCC_NONE,
        SFE,
        5,
        AT.VALIDATION,
        0x04,
        AT.OUTLINING,
        0x0f,
        AT.CHARSET,
        0xf1,
        AT.TRANSPARENCY,
        0xf1,
        0x99,
        0x01,
      );
      expect(s.fields[0]).toMatchObject({
        validation: 0x04,
        outlining: 0x0f,
        charset: 0xf1,
        transparency: 0xf1,
      });
    });

    it('rejects truncated forms', () => {
      expect(run(fresh(), 0xf5, WCC_NONE, SFE).errors[0]).toMatch(/too short/);
      expect(run(fresh(), 0xf5, WCC_NONE, SFE, 2, AT.FOREGROUND).errors[0]).toMatch(/too short/);
    });
  });

  describe('SA (GA23-0059 §4.3.6)', () => {
    it('applies character attributes to following characters until reset', () => {
      const s = fresh();
      run(
        s,
        0xf5,
        WCC_NONE,
        SA,
        AT.FOREGROUND,
        Color.RED,
        SA,
        AT.HIGHLIGHTING,
        Highlighting.UNDERSCORE,
        t('AB'),
        SA,
        AT.ALL,
        0x00,
        t('C'),
      );
      expect(s.attributesAt(0)).toMatchObject({
        foreground: Color.RED,
        highlighting: Highlighting.UNDERSCORE,
      });
      expect(s.attributesAt(1).foreground).toBe(Color.RED);
      expect(s.attributesAt(2)).toMatchObject({ foreground: 0, highlighting: 0 });
    });

    it('persists across SF but not across writes', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SA, AT.BACKGROUND, Color.PINK, SF, 0x40, t('A'));
      expect(s.attributesAt(1).background).toBe(Color.PINK);
      expect(s.attributesAt(0).background).toBe(0); // the attribute cell itself
      run(s, 0xf1, WCC_NONE, SBA, at(5), t('B'));
      expect(s.attributesAt(5).background).toBe(0);
    });

    it('sets the character set and transparency', () => {
      const s = fresh();
      run(
        s,
        0xf5,
        WCC_NONE,
        SA,
        AT.CHARSET,
        0xf1,
        SA,
        AT.TRANSPARENCY,
        0xf2,
        t('A'),
        SA,
        0x99,
        0x01,
      );
      expect(s.attributesAt(0)).toMatchObject({ charset: 0xf1, transparency: 0xf2 });
    });

    it('rejects a truncated SA', () => {
      expect(run(fresh(), 0xf5, WCC_NONE, SA, AT.FOREGROUND).errors[0]).toMatch(/too short/);
    });
  });

  describe('MF (GA23-0059 §4.3.7)', () => {
    it('modifies the field at the current address and advances', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SFE, 2, AT.FIELD_ATTRIBUTE, 0x40, AT.FOREGROUND, Color.GREEN);
      run(
        s,
        0xf1,
        WCC_NONE,
        SBA,
        at(0),
        MF,
        2,
        AT.FIELD_ATTRIBUTE,
        0x60,
        AT.HIGHLIGHTING,
        Highlighting.BLINK,
        t('A'),
      );
      expect(s.fields[0]).toMatchObject({
        protected: true,
        foreground: Color.GREEN,
        highlighting: Highlighting.BLINK,
      });
      expect(s.charAt(1)).toBe(t('A')[0]);
    });

    it('modifies colours, charset, validation and outlining', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SF, 0x40);
      run(
        s,
        0xf1,
        WCC_NONE,
        SBA,
        at(0),
        MF,
        7,
        AT.FOREGROUND,
        Color.RED,
        AT.BACKGROUND,
        Color.BLUE,
        AT.CHARSET,
        0xf1,
        AT.VALIDATION,
        0x02,
        AT.OUTLINING,
        0x01,
        AT.TRANSPARENCY,
        0xf0,
        0x99,
        0x00,
      );
      expect(s.fields[0]).toMatchObject({
        foreground: Color.RED,
        background: Color.BLUE,
        charset: 0xf1,
        validation: 0x02,
        outlining: 0x01,
        transparency: 0xf0,
      });
    });

    it('skips its pairs without moving when there is no field attribute there', () => {
      const s = fresh();
      run(s, 0xf5, WCC_NONE, SBA, at(5), MF, 1, AT.FOREGROUND, Color.RED, t('A'));
      expect(s.charAt(5)).toBe(t('A')[0]);
      expect(s.isFormatted).toBe(false);
    });

    it('rejects truncated forms', () => {
      expect(run(fresh(), 0xf5, WCC_NONE, MF).errors[0]).toMatch(/too short/);
      expect(
        run(fresh(), 0xf5, WCC_NONE, SF, 0x40, SBA, at(0), MF, 1, AT.FOREGROUND).errors[0],
      ).toMatch(/too short/);
    });
  });

  it('GE writes one character from the APL set', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, GE, 0xc5, t('A'));
    expect(s.charAt(0)).toBe(0xc5);
    expect(s.attributesAt(0).charset).toBe(CharacterSet.APL);
    expect(s.attributesAt(1).charset).toBe(0);
    expect(run(fresh(), 0xf5, WCC_NONE, GE).errors[0]).toMatch(/too short/);
  });

  it('reports truncated SF, SBA and EUA', () => {
    expect(run(fresh(), 0xf5, WCC_NONE, SF).errors[0]).toMatch(/too short/);
    expect(run(fresh(), 0xf5, WCC_NONE, SBA, 0x40).errors[0]).toMatch(/too short/);
    expect(run(fresh(), 0xf5, WCC_NONE, EUA, 0x40).errors[0]).toMatch(/too short/);
  });
});

describe('Erase All Unprotected (GA23-0059 §3.5.5)', () => {
  it('nulls unprotected fields, resets their MDTs, homes the cursor, restores the keyboard', () => {
    const s = fresh();
    run(
      s,
      0xf5,
      WCC_NONE,
      SF,
      0x60,
      t('NAME'),
      SF,
      0x41,
      t('JOHN'),
      SF,
      0x60,
      t('X'),
      SF,
      0x41,
      t('SMITH'),
    );
    s.cursor = 1000;
    const r = run(s, 0x6f);
    expect(r).toMatchObject({ command: 'EAU', keyboardRestore: true });
    expect(text(s, 1, 4)).toBe('NAME');
    expect(text(s, 6, 4)).toBe('····');
    expect(text(s, 13, 5)).toBe('·····');
    expect(s.fields.every((f) => !f.modified)).toBe(true);
    expect(s.cursor).toBe(6);
  });

  it('homes the cursor to 0 when there are no unprotected fields', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, SF, 0x60, t('ALL PROTECTED'));
    s.cursor = 50;
    run(s, 0x6f);
    expect(s.cursor).toBe(0);
    expect(text(s, 1, 3)).toBe('ALL');
  });

  it('clears an unformatted screen', () => {
    const s = fresh();
    run(s, 0xf5, WCC_NONE, t('HELLO'));
    s.cursor = 3;
    run(s, 0x6f);
    expect(text(s, 0, 5)).toBe('·····');
    expect(s.cursor).toBe(0);
  });
});

describe('TK5 logon screen (captured from Hercules 4.9.1)', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../../fixtures/datastream/tk5-logon.json', import.meta.url), 'utf8'),
  ) as { records: string[]; expectedText: string[]; expectedCursor: [number, number] };

  it('renders the same text and cursor that s3270 showed', () => {
    const s = fresh();
    for (const rec of fixture.records) {
      const r = processOutbound(s, Uint8Array.from(Buffer.from(rec, 'hex')), GEOMETRY);
      expect(r.errors).toEqual([]);
    }
    expect(s.toText(cp037)).toEqual(fixture.expectedText);
    expect(s.cursor).toBe(fixture.expectedCursor[0] * 80 + fixture.expectedCursor[1]);
  });
});
