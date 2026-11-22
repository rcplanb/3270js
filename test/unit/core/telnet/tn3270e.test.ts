/** TN3270E negotiation and framing (RFC 2355), byte for byte. */
import { describe, expect, it } from 'vitest';
import {
  Telnet,
  TelnetOption,
  Tn3270eFunction as Fn,
  Tn3270eOp as Op,
  Tn3270eReason,
  createTelnetSession,
  type TelnetEvent,
} from '../../../../src/core/telnet/index.js';

const { IAC, DO, DONT, WILL, WONT, SB, SE, EOR } = Telnet;
const { TN3270E, TTYPE } = TelnetOption;
const ascii = (t: string) => Array.from(t, (c) => c.charCodeAt(0));
const sent = (events: TelnetEvent[]) =>
  events.flatMap((e) => (e.type === 'send' ? [...e.data] : []));
const sb = (...body: number[]) => Uint8Array.of(IAC, SB, TN3270E, ...body, IAC, SE);

function session(luName?: string) {
  return createTelnetSession({
    terminalType: 'IBM-3279-2-E',
    tn3270e: { deviceType: 'IBM-3278-2-E', ...(luName ? { luName } : {}) },
  });
}

/** Negotiate to completion; the host assigns LU00001 and accepts our functions. */
function negotiated() {
  const t = session();
  t.receive(Uint8Array.of(IAC, DO, TN3270E));
  t.receive(sb(Op.SEND, Op.DEVICE_TYPE));
  t.receive(sb(Op.DEVICE_TYPE, Op.IS, ...ascii('IBM-3278-2-E'), Op.CONNECT, ...ascii('LU00001')));
  t.receive(sb(Op.FUNCTIONS, Op.IS, Fn.BIND_IMAGE, Fn.RESPONSES, Fn.SYSREQ));
  expect(t.tn3270e).toBe(true);
  return t;
}

describe('TN3270E negotiation', () => {
  it('accepts DO TN3270E only when configured', () => {
    expect(sent(session().receive(Uint8Array.of(IAC, DO, TN3270E)))).toEqual([IAC, WILL, TN3270E]);
    const plain = createTelnetSession({ terminalType: 'IBM-3279-2-E' });
    expect(sent(plain.receive(Uint8Array.of(IAC, DO, TN3270E)))).toEqual([IAC, WONT, TN3270E]);
  });

  it('answers SEND DEVICE-TYPE with REQUEST, plus CONNECT for a named LU', () => {
    const t = session('MYLU01');
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    expect(sent(t.receive(sb(Op.SEND, Op.DEVICE_TYPE)))).toEqual([
      ...[IAC, SB, TN3270E, Op.DEVICE_TYPE, Op.REQUEST],
      ...ascii('IBM-3278-2-E'),
      Op.CONNECT,
      ...ascii('MYLU01'),
      ...[IAC, SE],
    ]);
  });

  it('answers DEVICE-TYPE IS with FUNCTIONS REQUEST and completes on FUNCTIONS IS', () => {
    const t = session();
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    const is = t.receive(
      sb(Op.DEVICE_TYPE, Op.IS, ...ascii('IBM-3278-2-E'), Op.CONNECT, ...ascii('LU00042')),
    );
    expect(sent(is)).toEqual([IAC, SB, TN3270E, Op.FUNCTIONS, Op.REQUEST, 0, 2, 4, IAC, SE]);
    expect(t.in3270).toBe(false);
    const done = t.receive(sb(Op.FUNCTIONS, Op.IS, 0, 2, 4));
    expect(sent(done)).toEqual([]);
    expect(done).toContainEqual({
      type: 'tn3270e',
      deviceType: 'IBM-3278-2-E',
      luName: 'LU00042',
      functions: [0, 2, 4],
    });
    expect(done).toContainEqual({ type: 'mode', in3270: true, tn3270e: true });
    expect([...t.functions]).toEqual([0, 2, 4]);
  });

  it('counters a REQUEST that adds functions with the intersection, then accepts a subset', () => {
    const t = session();
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    t.receive(sb(Op.DEVICE_TYPE, Op.IS, ...ascii('IBM-3278-2-E')));
    // The host adds SCS-CTL-CODES and drops SYSREQ.
    expect(sent(t.receive(sb(Op.FUNCTIONS, Op.REQUEST, 0, 2, 3)))).toEqual([
      ...[IAC, SB, TN3270E, Op.FUNCTIONS, Op.REQUEST, 0, 2, IAC, SE],
    ]);
    // A list that adds nothing is accepted with IS, echoing it.
    expect(sent(t.receive(sb(Op.FUNCTIONS, Op.REQUEST, 0)))).toEqual([
      ...[IAC, SB, TN3270E, Op.FUNCTIONS, Op.IS, 0, IAC, SE],
    ]);
    expect(t.tn3270e).toBe(true);
    expect([...t.functions]).toEqual([0]);
  });

  it('accepts basic TN3270E (no functions)', () => {
    const t = session();
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    t.receive(sb(Op.DEVICE_TYPE, Op.IS, ...ascii('IBM-3278-2-E')));
    expect(sent(t.receive(sb(Op.FUNCTIONS, Op.REQUEST)))).toEqual([
      ...[IAC, SB, TN3270E, Op.FUNCTIONS, Op.IS, IAC, SE],
    ]);
    expect(t.in3270).toBe(true);
  });

  it('falls back to plain TN3270 when the device type is rejected', () => {
    const t = session();
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    const r = t.receive(sb(Op.DEVICE_TYPE, Op.REJECT, Op.REASON, Tn3270eReason.INV_NAME));
    expect(sent(r)).toEqual([IAC, WONT, TN3270E]);
    expect(r).toContainEqual({
      type: 'error',
      message: 'TN3270E refused: device type rejected (INV-NAME); using TN3270',
    });
    // Refused for the rest of the connection; plain negotiation then works.
    expect(sent(t.receive(Uint8Array.of(IAC, DO, TN3270E)))).toEqual([IAC, WONT, TN3270E]);
    t.receive(Uint8Array.of(IAC, DO, TTYPE));
    expect(sent(t.receive(Uint8Array.of(IAC, SB, TTYPE, 1, IAC, SE)))).toEqual([
      ...[IAC, SB, TTYPE, 0],
      ...ascii('IBM-3279-2-E'),
      ...[IAC, SE],
    ]);
  });

  it('refuses TN3270E when the host answers IS with functions we never asked for', () => {
    const t = session();
    t.receive(Uint8Array.of(IAC, DO, TN3270E));
    t.receive(sb(Op.DEVICE_TYPE, Op.IS, ...ascii('IBM-3278-2-E')));
    expect(sent(t.receive(sb(Op.FUNCTIONS, Op.IS, 0, 3)))).toEqual([IAC, WONT, TN3270E]);
    expect(t.tn3270e).toBe(false);
  });

  it('leaves TN3270E mode on DONT TN3270E', () => {
    const t = negotiated();
    const r = t.receive(Uint8Array.of(IAC, DONT, TN3270E));
    expect(sent(r)).toEqual([IAC, WONT, TN3270E]);
    expect(t.tn3270e).toBe(false);
    expect(t.in3270).toBe(false);
  });

  it('rejects device types and LU names that are not printable ASCII', () => {
    expect(() =>
      createTelnetSession({ terminalType: 'X', tn3270e: { deviceType: 'IBM 3278' } }),
    ).toThrow(/device type/);
    expect(() =>
      createTelnetSession({ terminalType: 'X', tn3270e: { deviceType: 'D', luName: 'Aé' } }),
    ).toThrow(/LU name/);
  });
});

describe('TN3270E framing', () => {
  it('splits the header off each record, undoubling IAC in the sequence number', () => {
    const t = negotiated();
    const r = t.receive(Uint8Array.of(0, 0, 2, 0x00, IAC, IAC, 0xf5, 0xc3, IAC, EOR));
    expect(r).toEqual([
      {
        type: 'record',
        header: { dataType: 0, requestFlag: 0, responseFlag: 2, seq: 0xff },
        data: Uint8Array.of(0xf5, 0xc3),
      },
    ]);
  });

  it('drops a record shorter than the header', () => {
    const t = negotiated();
    expect(t.receive(Uint8Array.of(0, 0, IAC, EOR))).toEqual([
      { type: 'error', message: 'TN3270E record shorter than its header; dropped' },
    ]);
  });

  it('prefixes the header when framing, doubling IAC in it', () => {
    const t = negotiated();
    const framed = t.frameRecord(Uint8Array.of(0x7d), {
      dataType: 2,
      requestFlag: 0,
      responseFlag: 0,
      seq: 0x00ff,
    });
    expect([...framed]).toEqual([2, 0, 0, 0, IAC, IAC, 0x7d, IAC, EOR]);
  });
});
