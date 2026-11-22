/**
 * Terminal over TN3270E: BIND, UNBIND, responses and SSCP-LU, replaying the
 * records OS/390 2.10's TN3270E server sent during a TSO logon.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '../../../src/core/terminal.js';
import { FakeHost, frame } from '../../helpers/fake-host.js';

const ascii = (t: string) => Buffer.from(t, 'latin1').toString('hex');
/** OS/390's negotiation: SEND, IS (LU SC0TCP01), FUNCTIONS IS BIND-IMAGE RESPONSES SYSREQ. */
const NEGOTIATION = [
  'fffd28',
  'fffa280802fff0',
  `fffa280204${ascii('IBM-3278-2-E')}01${ascii('SC0TCP01')}fff0`,
  'fffa280304000204fff0',
];
// Recorded from OS/390 2.10 (the screens are not needed here).
const UNBIND = '040000000001';
const TSO_BIND =
  '030000000031010303b1903080008787f88000028000000000185000007e000008c1f0f6e3e2d6f0f10005007f4a67e008e2c3f0e3c3d7f0f1';
/** TSO's first write (EW, no keyboard restore), asking ALWAYS-RESPONSE with seq 1. */
const TSO_WRITE = '0000020001f5c1115d7f1d4011404013';
const TELNET_BIND =
  '03000000003101030391903080008487f88000028000000000185000007e000006e3c5d3d5c5e300';

function connected() {
  const host = new FakeHost();
  const term = new Terminal({ model: 2, color: true });
  void term.connect(host);
  for (const c of NEGOTIATION) host.write(c);
  expect(term.tn3270e?.luName).toBe('SC0TCP01');
  host.takeSent();
  return { host, term };
}

describe('Terminal over TN3270E (OS/390 2.10 records)', () => {
  it('is unbound until a BIND, and ignores 3270 data before it', () => {
    const { host, term } = connected();
    expect(term.sessionMode).toBe('unbound');
    host.write(frame('000000000005c3' + 'c8c5d3d3d6')); // EW "HELLO"
    expect(term.text[0]!.trim()).toBe('');
    host.write(frame(TELNET_BIND));
    expect(term.bindInfo).toMatchObject({
      plu: 'TELNET',
      defaultSize: { rows: 24, cols: 80 },
      alternateSize: { rows: 24, cols: 80 },
    });
    host.write(frame('000000000005c3' + 'c8c5d3d3d6')); // SNA EW code 05
    expect(term.text[0]!.trim()).toBe('HELLO');
    expect(term.sessionMode).toBe('lu-lu');
  });

  it("answers TSO's ALWAYS-RESPONSE write with a positive response (the X SYSTEM hang)", () => {
    const { host, term } = connected();
    host.write(frame(TELNET_BIND));
    host.write(frame('000000000005c3' + 'c8c5d3d3d6'));
    const binds: string[] = [];
    const unbinds: unknown[] = [];
    term.on('bind', (b) => binds.push(b.plu ?? ''));
    term.on('unbind', (u) => unbinds.push(u));

    host.write(frame(UNBIND));
    expect(unbinds).toEqual([{ reason: 1 }]);
    expect(term.sessionMode).toBe('unbound');
    expect(term.text[0]!.trim()).toBe(''); // UNBIND clears the screen

    host.write(frame(TSO_BIND));
    expect(binds).toEqual(['A06TSO01']);
    host.write(frame(TSO_WRITE));
    // RESPONSE, POSITIVE, seq 1, device end.
    expect(host.takeSent()).toBe('0200000001' + '00' + 'ffef');
  });

  it('sends no positive response when the write produced a reply of its own', () => {
    const { host } = connected();
    host.write(frame(TELNET_BIND));
    host.write(frame('0000020007' + 'f6')); // Read Modified, ALWAYS-RESPONSE
    const sent = host.takeSent();
    expect(sent.startsWith('0000000000')).toBe(true); // the 3270-DATA reply
    expect(sent).not.toContain('0200000007');
  });

  it('sends a negative response: operation check for a bad address, command reject otherwise', () => {
    const { host } = connected();
    host.write(frame(TELNET_BIND));
    host.write(frame('0000010003' + 'f5c3117f7fc8')); // ERROR-RESPONSE, SBA past the end
    expect(host.takeSent()).toBe('0200010003' + '02' + 'ffef');
    host.write(frame('0000010004' + '99')); // unknown command
    expect(host.takeSent()).toBe('0200010004' + '00' + 'ffef');
    host.write(frame('0000010005' + 'f5c3c8')); // ERROR-RESPONSE, no error: silent
    expect(host.takeSent()).toBe('');
  });

  it('shows SSCP-LU text, sends Enter input as SSCP-LU-DATA, and clears locally', () => {
    const { host, term } = connected();
    // "USS" NL "READY" (NL = 0x15)
    host.write(frame('0700000000' + 'e4e2e2' + '15' + 'd9c5c1c4e8'));
    expect(term.sessionMode).toBe('sscp-lu');
    expect(term.text.slice(0, 2).map((l) => l.trimEnd())).toEqual(['USS', 'READY']);
    expect(term.keyboard.isLocked).toBe(false);
    term.type('LOGON');
    expect(term.aid('ENTER').accepted).toBe(true);
    // Only the typed text, no AID or cursor address.
    expect(host.takeSent()).toBe('0700000000' + 'd3d6c7d6d5' + 'ffef');
    expect(term.screen.cursor).toBe(2 * 80); // the next line
    expect(term.aid('PF3').accepted).toBe(false);
    term.aid('CLEAR');
    expect(host.takeSent()).toBe('');
    expect(term.text[0]!.trim()).toBe('');
  });
});
