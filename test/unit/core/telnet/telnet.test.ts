import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Telnet,
  TelnetOption,
  createTelnetSession,
  type TelnetEvent,
} from '../../../../src/core/telnet/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/telnet/tk5-negotiation.json', import.meta.url), 'utf8'),
) as { terminalType: string; host: string[]; s3270Replies: string[] };

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sends = (events: TelnetEvent[]) =>
  events.flatMap((e) => (e.type === 'send' ? [toHex(e.data)] : [])).join('');
const records = (events: TelnetEvent[]) =>
  events.flatMap((e) => (e.type === 'record' ? [e.data] : []));

const { IAC, DO, DONT, WILL, WONT, SB, SE, EOR } = Telnet;
const { BINARY, TTYPE, EOR: OPT_EOR, NAWS, ECHO, TN3270E } = TelnetOption;

/** A session already in 3270 mode, the way TK5 leaves it. */
function negotiated() {
  const t = createTelnetSession({ terminalType: 'IBM-3279-2-E' });
  for (const c of fixture.host.slice(0, 3)) t.receive(hex(c));
  t.receive(Uint8Array.of(IAC, WILL, OPT_EOR, IAC, DO, OPT_EOR));
  expect(t.in3270).toBe(true);
  return t;
}

describe('TK5 negotiation (captured from Hercules 4.9.1)', () => {
  it('sends the same bytes s3270 sent, and yields the first screen', () => {
    const t = createTelnetSession({ terminalType: fixture.terminalType });
    const events = fixture.host.flatMap((c) => t.receive(hex(c)));

    expect(sends(events)).toBe(fixture.s3270Replies.join(''));
    expect(t.in3270).toBe(true);

    const recs = records(events);
    expect(recs).toHaveLength(1);
    expect(toHex(recs[0]!.subarray(0, 5))).toBe('f542114040'); // EW, WCC, SBA 0
    expect(recs[0]).toHaveLength(1535 - 6); // between the 6 negotiation bytes and IAC EOR
  });

  it('enters 3270 mode before delivering the record that follows in the same read', () => {
    const t = createTelnetSession({ terminalType: fixture.terminalType });
    const events = fixture.host.flatMap((c) => t.receive(hex(c)));
    const modeAt = events.findIndex((e) => e.type === 'mode' && e.in3270);
    const recordAt = events.findIndex((e) => e.type === 'record');
    expect(modeAt).toBeGreaterThanOrEqual(0);
    expect(modeAt).toBeLessThan(recordAt);
    expect(events.filter((e) => e.type === 'nvt')).toEqual([]);
  });

  it('gives identical results when fed one byte at a time', () => {
    const whole = createTelnetSession({ terminalType: fixture.terminalType });
    const a = fixture.host.flatMap((c) => whole.receive(hex(c)));

    const bytewise = createTelnetSession({ terminalType: fixture.terminalType });
    const b = fixture.host.flatMap((c) =>
      [...hex(c)].flatMap((byte) => bytewise.receive(Uint8Array.of(byte))),
    );

    expect(sends(b)).toBe(sends(a));
    expect(records(b).map(toHex)).toEqual(records(a).map(toHex));
  });
});

describe('option negotiation', () => {
  it('answers TERMINAL-TYPE SEND with the configured type in ASCII', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    t.receive(Uint8Array.of(IAC, DO, TTYPE));
    const ev = t.receive(Uint8Array.of(IAC, SB, TTYPE, 0x01, IAC, SE));
    expect(sends(ev)).toBe('fffa1800' + toHex(new TextEncoder().encode('IBM-3278-2')) + 'fff0');
  });

  it('ignores TERMINAL-TYPE SEND unless it agreed to WILL TERMINAL-TYPE', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    expect(sends(t.receive(Uint8Array.of(IAC, SB, TTYPE, 0x01, IAC, SE)))).toBe('');
  });

  it('refuses options it does not support', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    expect(sends(t.receive(Uint8Array.of(IAC, DO, NAWS)))).toBe('fffc1f');
    expect(sends(t.receive(Uint8Array.of(IAC, WILL, ECHO)))).toBe('fffe01');
    expect(sends(t.receive(Uint8Array.of(IAC, DO, TN3270E)))).toBe('fffc28'); // Phase 2
    expect(t.isEnabled('local', NAWS)).toBe(false);
  });

  it('does not reply to a request for a state it is already in (no negotiation loops)', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    expect(sends(t.receive(Uint8Array.of(IAC, DO, BINARY)))).toBe('fffb00');
    expect(sends(t.receive(Uint8Array.of(IAC, DO, BINARY)))).toBe('');
    expect(sends(t.receive(Uint8Array.of(IAC, WILL, BINARY)))).toBe('fffd00');
    expect(sends(t.receive(Uint8Array.of(IAC, WILL, BINARY)))).toBe('');
    expect(t.isEnabled('remote', BINARY)).toBe(true);
    expect(sends(t.receive(Uint8Array.of(IAC, DONT, NAWS)))).toBe('');
    expect(sends(t.receive(Uint8Array.of(IAC, WONT, ECHO)))).toBe('');
  });

  it('turns an option off when asked and leaves 3270 mode', () => {
    const t = negotiated();
    const ev = t.receive(Uint8Array.of(IAC, DONT, BINARY));
    expect(sends(ev)).toBe('fffc00');
    expect(ev).toContainEqual({ type: 'mode', in3270: false });
    expect(t.in3270).toBe(false);
    expect(sends(t.receive(Uint8Array.of(IAC, WONT, OPT_EOR)))).toBe('fffe19');
  });

  it('reports option changes', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    expect(t.receive(Uint8Array.of(IAC, WILL, BINARY))).toContainEqual({
      type: 'option',
      side: 'remote',
      option: BINARY,
      enabled: true,
    });
  });

  it('handles a subnegotiation split across reads', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    t.receive(Uint8Array.of(IAC, DO, TTYPE));
    expect(sends(t.receive(Uint8Array.of(IAC, SB, TTYPE)))).toBe('');
    expect(sends(t.receive(Uint8Array.of(0x01, IAC)))).toBe('');
    expect(sends(t.receive(Uint8Array.of(SE)))).toMatch(/^fffa1800/);
  });

  it('ignores unknown subnegotiations and bare commands', () => {
    const t = negotiated();
    const ev = t.receive(Uint8Array.of(IAC, SB, NAWS, 1, 2, IAC, IAC, 3, IAC, SE, IAC, Telnet.NOP));
    expect(ev).toEqual([]);
  });

  it('reports a malformed subnegotiation and recovers', () => {
    const t = negotiated();
    const ev = t.receive(Uint8Array.of(IAC, SB, TTYPE, 0x01, IAC, DO, BINARY, 0xf5, IAC, EOR));
    expect(ev.find((e) => e.type === 'error')).toBeDefined();
    expect(records(ev).map(toHex)).toEqual(['f5']);
  });

  it('caps the subnegotiation buffer', () => {
    const t = negotiated();
    const big = new Uint8Array(5000).fill(0x41);
    const ev = t.receive(Uint8Array.of(IAC, SB, TTYPE, ...big, IAC, IAC, IAC, SE, 0xf1, IAC, EOR));
    expect(ev.find((e) => e.type === 'error')).toBeDefined();
    expect(records(ev).map(toHex)).toEqual(['f1']);
  });
});

describe('records', () => {
  it('undoubles IAC in record data', () => {
    const t = negotiated();
    const ev = t.receive(Uint8Array.of(0xf1, IAC, IAC, 0x40, IAC, EOR));
    expect(records(ev).map(toHex)).toEqual(['f1ff40']);
  });

  it('keeps a partial record across reads', () => {
    const t = negotiated();
    expect(records(t.receive(Uint8Array.of(0xf5, 0xc3)))).toEqual([]);
    expect(records(t.receive(Uint8Array.of(0x40, IAC)))).toEqual([]);
    expect(records(t.receive(Uint8Array.of(EOR))).map(toHex)).toEqual(['f5c340']);
  });

  it('delivers several records from one read, in order', () => {
    const t = negotiated();
    const ev = t.receive(Uint8Array.of(0xf1, IAC, EOR, 0xf5, IAC, EOR));
    expect(records(ev).map(toHex)).toEqual(['f1', 'f5']);
  });

  it('skips empty records', () => {
    const t = negotiated();
    expect(t.receive(Uint8Array.of(IAC, EOR))).toEqual([]);
  });

  it('drops an over-long record, reports it once, and resumes at the next one', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2', maxRecordLength: 4 });
    for (const c of fixture.host.slice(0, 3)) t.receive(hex(c));
    t.receive(Uint8Array.of(IAC, WILL, OPT_EOR, IAC, DO, OPT_EOR));
    const ev = t.receive(Uint8Array.of(1, 2, 3, 4, 5, 6, IAC, EOR, 0xf1, IAC, EOR));
    expect(ev.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(records(ev).map(toHex)).toEqual(['f1']);
  });

  it('frames outgoing records: doubles IAC and appends IAC EOR', () => {
    const t = negotiated();
    expect(toHex(t.frameRecord(Uint8Array.of(0x7d, 0xff, 0x40)))).toBe('7dffff40ffef');
    expect(toHex(t.frameRecord(new Uint8Array(0)))).toBe('ffef');
  });

  it('discards a partial record when 3270 mode ends', () => {
    const t = negotiated();
    t.receive(Uint8Array.of(0xf5, 0xc3));
    t.receive(Uint8Array.of(IAC, DONT, BINARY));
    t.receive(Uint8Array.of(IAC, DO, BINARY));
    expect(records(t.receive(Uint8Array.of(0xf1, IAC, EOR))).map(toHex)).toEqual(['f1']);
  });
});

describe('NVT data', () => {
  it('passes data outside 3270 mode through as NVT text', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    const ev = t.receive(Uint8Array.of(0x48, 0x69, IAC, IAC, IAC, DO, TTYPE, 0x21));
    expect(ev.filter((e) => e.type === 'nvt').map((e) => toHex(e.data))).toEqual(['4869ff', '21']);
  });
});

describe('commands', () => {
  it('encodes Attn as Interrupt Process', () => {
    const t = createTelnetSession({ terminalType: 'IBM-3278-2' });
    expect(toHex(t.command('IP'))).toBe('fff4');
    expect(toHex(t.command('BREAK'))).toBe('fff3');
  });
});

describe('configuration', () => {
  it('rejects terminal types that are not printable ASCII', () => {
    expect(() => createTelnetSession({ terminalType: '' })).toThrow();
    expect(() => createTelnetSession({ terminalType: 'IBM-3279-2-É' })).toThrow();
    expect(() => createTelnetSession({ terminalType: 'IBM 3278' })).toThrow();
  });
});
