import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import { Order, processOutbound } from '../../../../src/core/datastream/index.js';
import {
  Aid,
  aidForKey,
  isShortReadAid,
  parseInbound,
  readBuffer,
  readModified,
} from '../../../../src/core/inbound/index.js';
import {
  AddressMode,
  CharacterSet,
  Screen,
  encodeAddress,
} from '../../../../src/core/screen/index.js';

const t = (s: string) => [...cp037.encode(s)];
const at = (a: number) => encodeAddress(a, AddressMode.Coded12);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const { SBA, SF, GE } = Order;

/** A login-style screen: protected label at 0, unprotected field at 10 (data 11..19), protected at 20. */
function form(): Screen {
  const s = new Screen(24, 80);
  s.startField(0, 0x60);
  t('USERID').forEach((b, i) => s.writeChar(1 + i, b));
  s.startField(10, 0x40);
  s.startField(20, 0x60);
  s.startField(30, 0x40);
  return s;
}

function type(s: Screen, address: number, text: string) {
  t(text).forEach((b, i) => s.writeChar(address + i, b));
  s.setModified(s.fieldAt(address)!.start, true);
}

describe('AIDs (GA23-0059 §3.5.6)', () => {
  it('has the standard values', () => {
    expect(Aid).toMatchObject({
      NONE: 0x60,
      ENTER: 0x7d,
      CLEAR: 0x6d,
      PA1: 0x6c,
      PA2: 0x6e,
      PA3: 0x6b,
      PF1: 0xf1,
      PF9: 0xf9,
      PF10: 0x7a,
      PF12: 0x7c,
      PF13: 0xc1,
      PF21: 0xc9,
      PF22: 0x4a,
      PF24: 0x4c,
      SYSREQ: 0xf0,
      STRUCTURED_FIELD: 0x88,
    });
  });

  it('maps key names to AIDs', () => {
    expect(aidForKey('ENTER')).toBe(0x7d);
    expect(aidForKey('PF5')).toBe(0xf5);
    expect(aidForKey('PF24')).toBe(0x4c);
    expect(aidForKey('PA2')).toBe(0x6e);
  });

  it('knows which AIDs are short reads', () => {
    for (const a of [Aid.PA1, Aid.PA2, Aid.PA3, Aid.CLEAR]) expect(isShortReadAid(a)).toBe(true);
    for (const a of [Aid.ENTER, Aid.PF1, Aid.NONE]) expect(isShortReadAid(a)).toBe(false);
  });
});

describe('readModified (GA23-0059 §3.6.2)', () => {
  it('sends AID, cursor, and SBA + data for each modified field only', () => {
    const s = form();
    type(s, 11, 'HERC01');
    type(s, 31, 'X');
    s.cursor = 17;
    const out = readModified(s, Aid.ENTER);
    expect([...out]).toEqual([
      0x7d,
      ...at(17),
      SBA,
      ...at(11),
      ...t('HERC01'),
      SBA,
      ...at(31),
      ...t('X'),
    ]);
  });

  it('suppresses nulls', () => {
    const s = form();
    s.writeChar(11, t('A')[0]!);
    s.writeChar(13, t('B')[0]!);
    s.setModified(10, true);
    expect([...readModified(s, Aid.ENTER)]).toEqual([0x7d, ...at(0), SBA, ...at(11), ...t('AB')]);
  });

  it('sends an SBA alone for a modified field with no data', () => {
    const s = form();
    s.setModified(10, true);
    expect([...readModified(s, Aid.PF3)]).toEqual([0xf3, ...at(0), SBA, ...at(11)]);
  });

  it('includes modified protected fields', () => {
    const s = form();
    s.setModified(0, true);
    expect([...readModified(s, Aid.ENTER)]).toEqual([
      0x7d,
      ...at(0),
      SBA,
      ...at(1),
      ...t('USERID'),
    ]);
  });

  it('sends only the AID for PA keys and Clear (short read)', () => {
    const s = form();
    type(s, 11, 'HERC01');
    for (const aid of [Aid.PA1, Aid.PA2, Aid.PA3, Aid.CLEAR]) {
      expect([...readModified(s, aid)]).toEqual([aid]);
    }
  });

  it('Read Modified All sends data even for short-read AIDs', () => {
    const s = form();
    type(s, 11, 'A');
    expect([...readModified(s, Aid.PA1, { all: true })]).toEqual([
      0x6c,
      ...at(0),
      SBA,
      ...at(11),
      ...t('A'),
    ]);
  });

  it('sends every non-null character, without SBA, from an unformatted screen', () => {
    const s = new Screen(24, 80);
    s.writeChar(0, t('A')[0]!);
    s.writeChar(1900, t('Z')[0]!);
    s.cursor = 1901;
    expect([...readModified(s, Aid.ENTER)]).toEqual([0x7d, ...at(1901), ...t('AZ')]);
  });

  it('prefixes APL characters with GE', () => {
    const s = form();
    s.writeChar(11, 0xad, { charset: CharacterSet.APL });
    s.writeChar(12, t('B')[0]!);
    s.setModified(10, true);
    expect([...readModified(s, Aid.ENTER)]).toEqual([
      0x7d,
      ...at(0),
      SBA,
      ...at(11),
      GE,
      0xad,
      ...t('B'),
    ]);
  });

  it('handles a modified field that wraps past the end of the buffer', () => {
    const s = new Screen(24, 80);
    s.startField(1917, 0x41);
    s.startField(5, 0x60);
    t('ABCDE').forEach((b, i) => s.writeChar((1918 + i) % 1920, b));
    expect([...readModified(s, Aid.ENTER)]).toEqual([
      0x7d,
      ...at(0),
      SBA,
      ...at(1918),
      ...t('ABCDE'),
    ]);
  });

  it('uses 14-bit addresses for buffers over 4096 cells', () => {
    const s = new Screen(62, 80);
    s.startField(4900, 0x41);
    s.cursor = 4500;
    const out = readModified(s, Aid.ENTER);
    expect(hex(out.subarray(0, 6))).toBe('7d1194111325');
  });

  it('sends a SYSREQ test request header followed by modified fields', () => {
    const s = form();
    type(s, 11, 'X');
    expect([...readModified(s, Aid.SYSREQ)]).toEqual([
      0x01,
      0x6c,
      0x61,
      0x02,
      SBA,
      ...at(11),
      ...t('X'),
    ]);
  });

  it('matches what s3270 sent to TK5 after typing on the logon screen', () => {
    const logon = JSON.parse(
      readFileSync(new URL('../../../fixtures/datastream/tk5-logon.json', import.meta.url), 'utf8'),
    ) as { records: string[] };
    const inbound = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/datastream/tk5-inbound.json', import.meta.url),
        'utf8',
      ),
    ) as { typed: string; enter: string; pa1: string };
    const s = new Screen(24, 80);
    const geometry = { default: { rows: 24, cols: 80 }, alternate: { rows: 24, cols: 80 } };
    for (const r of logon.records)
      processOutbound(s, Uint8Array.from(Buffer.from(r, 'hex')), geometry);

    const start = s.cursor;
    type(s, start, inbound.typed);
    s.cursor = start + inbound.typed.length;

    expect(hex(readModified(s, Aid.ENTER))).toBe(inbound.enter);
    expect(hex(readModified(s, Aid.PA1))).toBe(inbound.pa1);
  });
});

describe('readBuffer (GA23-0059 §3.6.1)', () => {
  it('sends AID, cursor, then every cell: SF + attribute, and characters including nulls', () => {
    const s = new Screen(1, 6);
    s.startField(0, 0x60);
    s.writeChar(1, t('A')[0]!);
    s.startField(3, 0x41);
    s.cursor = 4;
    const out = readBuffer(s, Aid.NONE);
    // Attribute bytes are sent as graphic characters (the address code table).
    expect([...out]).toEqual([0x60, ...at(4), SF, 0x60, t('A')[0], 0x00, SF, 0xc1, 0x00, 0x00]);
  });

  it('prefixes APL characters with GE', () => {
    const s = new Screen(1, 2);
    s.writeChar(0, 0xad, { charset: CharacterSet.APL });
    expect([...readBuffer(s, Aid.NONE)]).toEqual([0x60, ...at(0), GE, 0xad, 0x00]);
  });
});

describe('parseInbound', () => {
  it('parses an AID, cursor and field data', () => {
    const s = form();
    type(s, 11, 'HERC01');
    type(s, 31, 'X');
    s.cursor = 17;
    expect(parseInbound(readModified(s, Aid.ENTER), s.size)).toEqual({
      aid: Aid.ENTER,
      cursor: 17,
      fields: [
        { address: 11, data: Uint8Array.from(t('HERC01')) },
        { address: 31, data: Uint8Array.from(t('X')) },
      ],
      fieldAttributes: [],
      errors: [],
    });
  });

  it('parses a short read', () => {
    expect(parseInbound(Uint8Array.of(Aid.PA2), 1920)).toEqual({
      aid: Aid.PA2,
      fields: [],
      fieldAttributes: [],
      errors: [],
    });
  });

  it('parses unformatted data as starting at address 0', () => {
    const r = parseInbound(Uint8Array.of(0x7d, ...at(5), ...t('HI')), 1920);
    expect(r.fields).toEqual([{ address: 0, data: Uint8Array.from(t('HI')) }]);
  });

  it('parses a Read Buffer reply, including field attributes and GE', () => {
    const s = new Screen(1, 6);
    s.startField(0, 0x60);
    s.writeChar(1, 0xad, { charset: CharacterSet.APL });
    s.startField(3, 0x41);
    const r = parseInbound(readBuffer(s, Aid.NONE), s.size);
    expect(r.fieldAttributes).toEqual([
      { address: 0, attribute: 0x20 },
      { address: 3, attribute: 0x01 },
    ]);
    expect(r.fields).toEqual([
      { address: 1, data: Uint8Array.of(0xad, 0x00) },
      { address: 4, data: Uint8Array.of(0x00, 0x00) },
    ]);
  });

  it('reports malformed records', () => {
    expect(parseInbound(new Uint8Array(0), 1920).errors).toEqual(['empty record']);
    expect(parseInbound(Uint8Array.of(0x7d, 0x40), 1920).errors[0]).toMatch(/cursor/);
    expect(parseInbound(Uint8Array.of(0x7d, ...at(0), SBA, 0x40), 1920).errors[0]).toMatch(/SBA/);
    expect(parseInbound(Uint8Array.of(0x7d, ...at(0), SF), 1920).errors[0]).toMatch(/SF/);
    expect(parseInbound(Uint8Array.of(0x7d, ...at(0), GE), 1920).errors[0]).toMatch(/GE/);
    expect(parseInbound(Uint8Array.of(0x7d, ...at(0), SBA, 0x7f, 0x7f), 1920).errors[0]).toMatch(
      /4095/,
    );
  });
});
