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

  it('sends the positive response before a reply the record produced (as s3270 4.5)', () => {
    const { host } = connected();
    host.write(frame(TELNET_BIND));
    host.write(frame('0000020007' + 'f6')); // Read Modified, ALWAYS-RESPONSE
    const sent = host.takeSent();
    expect(sent.startsWith('0200000007' + '00' + 'ffef' + '0000000000')).toBe(true);
  });

  it("answers ISPF's Outbound 3270DS + Read Partition Query (the X-clock hang)", () => {
    const { host, term } = connected();
    host.write(frame(TSO_BIND));
    host.write(frame('0000000000' + 'f5c3' + 'c8')); // EW, keyboard restored
    term.aid('ENTER'); // the operator presses Enter: X clock until the host restores it
    expect(term.keyboard.isLocked).toBe(true);
    host.takeSent();
    // Recorded from OS/390 2.10 ISPF, seq 11: WSF { Outbound 3270DS: W, WCC restore } { Query }.
    host.write(frame('000002000b' + 'f300064000f1c3000501ff02'));
    const sent = host.takeSent();
    expect(sent.startsWith('020000000b' + '00' + 'ffef')).toBe(true); // response first
    expect(sent.slice(16, 28)).toBe('000000000188'); // then the Query Reply (seq 1: Enter was 0)
    expect(term.keyboard.isLocked).toBe(false); // the Outbound 3270DS write restored it
  });

  it('rejects an unsupported structured field with a negative response', () => {
    const { host } = connected();
    host.write(frame(TELNET_BIND));
    host.write(frame('0000010009' + 'f30004' + '7700')); // unknown SF X'77'
    expect(host.takeSent()).toBe('0200010009' + '00' + 'ffef');
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
    expect(term.aid('PF3').accepted).toBe(false); // X -f
    expect(term.oia.state.lock?.symbol).toBe('minusFunction');
    expect(term.aid('CLEAR').accepted).toBe(false); // ignored until Reset
    term.press({ type: 'reset' });
    expect(term.aid('CLEAR').accepted).toBe(true);
    expect(host.takeSent()).toBe('');
    expect(term.text[0]!.trim()).toBe('');
  });
});

describe('the status line over TN3270E', () => {
  it('shows B, the LU, and the owner moving from unbound to the application', () => {
    const { host, term } = connected();
    expect(term.oia.state).toMatchObject({ tn3270e: true, owner: 'unbound', luName: 'SC0TCP01' });
    host.write(frame(TELNET_BIND));
    host.write(frame('000000000005c3' + 'c8c5d3d3d6'));
    expect(term.oia.state.owner).toBe('lu-lu');
    host.write(frame(UNBIND));
    expect(term.oia.state.owner).toBe('unbound');
    host.write(frame('0700000000' + 'e4e2e2'));
    expect(term.oia.state.owner).toBe('sscp');
  });

  it('is plain A with no LU on a TN3270 session', () => {
    const host = new FakeHost();
    const term = new Terminal({ tn3270e: false });
    void term.connect(host);
    for (const c of ['fffd18', 'fffa1801fff0', 'fffb00fffd00', 'fffb19fffd19']) host.write(c);
    expect(term.oia.state).toMatchObject({
      connection: 'connected',
      tn3270e: false,
      owner: 'lu-lu',
    });
    expect(term.oia.state.luName).toBeUndefined();
  });
});

describe('asking for an LU on plain TN3270', () => {
  it('sends type@LU in TERMINAL-TYPE (RFC 1646), and shows the LU', () => {
    const host = new FakeHost();
    const term = new Terminal({ color: true, luName: 'CONS0010', tn3270e: false });
    void term.connect(host);
    host.write('fffd18');
    host.takeSent();
    host.write('fffa1801fff0');
    expect(Buffer.from(host.takeSent(), 'hex').toString('latin1')).toContain(
      'IBM-3279-2-E@CONS0010',
    );
    for (const c of ['fffb00fffd00', 'fffb19fffd19']) host.write(c);
    expect(term.oia.state).toMatchObject({ tn3270e: false, luName: 'CONS0010' });
  });
});

describe('a refused LU on plain TN3270', () => {
  it('disconnects with the reason when the host asks for the terminal type again (as OS/390 does)', async () => {
    const host = new FakeHost();
    const term = new Terminal({ luName: 'SC0TCP03', tn3270e: false });
    const reasons: (string | undefined)[] = [];
    term.on('disconnect', (d) => reasons.push(d.reason));
    const connected = term.connect(host);
    host.write('fffd18');
    host.write('fffa1801fff0'); // we send type@SC0TCP03
    host.write('fffa1801fff0'); // OS/390: try another LU
    await expect(connected).rejects.toThrow('the host refused LU SC0TCP03');
    expect(reasons).toEqual(['the host refused LU SC0TCP03']);
    expect(host.closed).toBe(true);
  });
});

describe('Attn and SysReq over TN3270E', () => {
  it('Attn is X -f until a BIND, then telnet IP', () => {
    const { host, term } = connected();
    expect(term.press({ type: 'attn' }).accepted).toBe(false);
    expect(term.oia.state.lock?.symbol).toBe('minusFunction');
    expect(host.takeSent()).toBe('');
    term.press({ type: 'reset' });
    host.write(frame(TELNET_BIND));
    host.write(frame('000000000005c3' + 'c8c5d3d3d6'));
    expect(term.press({ type: 'attn' }).accepted).toBe(true);
    expect(host.takeSent()).toBe('fff4');
  });

  it('SysReq is telnet AO in an application or SSCP session, nothing while unbound', () => {
    const { host, term } = connected();
    expect(term.aid('SYSREQ').accepted).toBe(false);
    expect(host.takeSent()).toBe('');
    host.write(frame(TSO_BIND));
    host.write(frame('000000000005c3' + 'c8c5d3d3d6'));
    expect(term.aid('SYSREQ').accepted).toBe(true);
    expect(host.takeSent()).toBe('fff5');
    host.write(frame('0700000000' + 'e4e2e2')); // the server switched us to the SSCP
    expect(term.aid('SYSREQ').accepted).toBe(true);
    expect(host.takeSent()).toBe('fff5');
  });

  it('SysReq does nothing without the SYSREQ function', () => {
    const host = new FakeHost();
    const term = new Terminal();
    void term.connect(host);
    for (const c of [
      'fffd28',
      'fffa280802fff0',
      `fffa280204${ascii('IBM-3278-2-E')}fff0`,
      'fffa2803040002fff0', // BIND-IMAGE and RESPONSES only
    ])
      host.write(c);
    host.write(frame(TSO_BIND));
    host.write(frame('000000000005c3' + 'c8'));
    host.takeSent();
    expect(term.aid('SYSREQ').accepted).toBe(false);
    expect(host.takeSent()).toBe('');
  });
});
