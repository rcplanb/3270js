import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import { Terminal } from '../../../../src/core/terminal.js';
import {
  TelnetFramer,
  createTraceRecorder,
  redactInbound,
  replayTrace,
  type Trace,
} from '../../../../src/core/trace/index.js';
import { AddressMode, encodeAddress } from '../../../../src/core/screen/index.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../../helpers/fake-host.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const at = (a: number) => Buffer.from(encodeAddress(a, AddressMode.Coded12)).toString('hex');
const ebc = (s: string) => hex(cp037.encode(s));

describe('TelnetFramer', () => {
  it('splits records on IAC EOR and passes telnet commands through raw', () => {
    const f = new TelnetFramer();
    expect(f.push(bytes('fffd18' + 'f1ff' + 'ff40' + 'ffeff5'))).toEqual([
      { kind: 'telnet', data: bytes('fffd18') },
      { kind: 'record', data: bytes('f1ff40') },
    ]);
    expect(f.push(bytes('c3ff'))).toEqual([]);
    expect(f.push(bytes('efff'))).toEqual([{ kind: 'record', data: bytes('f5c3') }]);
    expect(f.push(bytes('fa1801fff0'))).toEqual([{ kind: 'telnet', data: bytes('fffa1801fff0') }]);
    expect(f.push(bytes('fff1'))).toEqual([{ kind: 'telnet', data: bytes('fff1') }]);
  });

  it('keeps IAC IAC inside subnegotiations', () => {
    const f = new TelnetFramer();
    expect(f.push(bytes('fffa18ffff01fff0'))).toEqual([
      { kind: 'telnet', data: bytes('fffa18ffff01fff0') },
    ]);
  });
});

describe('redactInbound', () => {
  it('replaces data addressed to hidden cells with asterisks, keeping the length', () => {
    const rec = bytes(
      '7d' + at(20) + '11' + at(11) + ebc('HERC01') + '11' + at(31) + ebc('SECRET'),
    );
    const out = redactInbound(rec, 1920, (a) => a >= 31 && a < 40);
    expect(hex(out)).toBe(
      '7d' + at(20) + '11' + at(11) + ebc('HERC01') + '11' + at(31) + ebc('******'),
    );
  });

  it('leaves short reads, Query Replies and unparseable records alone', () => {
    expect(hex(redactInbound(bytes('6c'), 1920, () => true))).toBe('6c');
    expect(hex(redactInbound(bytes('88000c8180'), 1920, () => true))).toBe('88000c8180');
    expect(hex(redactInbound(bytes('7d40'), 1920, () => true))).toBe('7d40');
  });

  it('handles GE-prefixed characters', () => {
    const rec = bytes('7d' + at(0) + '11' + at(5) + '08ad');
    expect(hex(redactInbound(rec, 1920, () => true))).toBe('7d' + at(0) + '11' + at(5) + '085c');
  });
});

/** Record a session between a Terminal and a scripted host. */
async function recordSession() {
  const term = new Terminal();
  const host = new FakeHost();
  let now = 1000;
  const recorder = createTraceRecorder({
    meta: { terminalType: term.terminalType, model: 2, codePage: 'cp037', description: 'test' },
    clock: () => now,
  });
  recorder.attach(term);
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  now += 50;
  // Logon panel: label, visible userid field (10..29), hidden password field (40..59).
  host.write(
    frame(
      'f5c3' +
        '1d60' +
        ebc('USER') +
        '11' +
        at(10) +
        '1d40' +
        '11' +
        at(30) +
        '1d60' +
        ebc('PW') +
        '11' +
        at(40) +
        '1d4c' +
        '11' +
        at(60) +
        '1d60' +
        '11' +
        at(11) +
        '13',
    ),
  );
  term.type('HERC01');
  term.fillField(1, 'CUL8TR');
  now += 50;
  term.aid('ENTER');
  host.write(frame('f5c3' + ebc('READY')));
  return { recorder, term };
}

describe('trace recorder', () => {
  it('records both directions with timestamps and metadata', async () => {
    const { recorder } = await recordSession();
    const trace = recorder.trace();
    expect(trace).toMatchObject({
      format: '3270js-trace',
      version: 1,
      meta: { model: 2, codePage: 'cp037' },
    });
    expect(trace.events[0]).toEqual({ t: 0, dir: 'host', kind: 'telnet', hex: 'fffd18' });
    expect(trace.events.some((e) => e.dir === 'terminal' && e.kind === 'telnet')).toBe(true);
    expect(trace.events.filter((e) => e.kind === 'record').map((e) => e.t)).toEqual([50, 100, 100]);
  });

  it('redacts what was typed into non-display fields', async () => {
    const { recorder } = await recordSession();
    const json = JSON.stringify(recorder.trace());
    expect(json).toContain(ebc('HERC01'));
    expect(json).not.toContain(ebc('CUL8TR'));
    expect(json).toContain(ebc('******'));
  });

  it('stores the final screen', async () => {
    const { recorder } = await recordSession();
    expect(recorder.trace().final!.text[0]!.startsWith('READY')).toBe(true);
  });

  it('can be fed raw traffic directly (as from the proxy)', () => {
    const r = createTraceRecorder({
      meta: { terminalType: 'IBM-3278-2-E', model: 2, codePage: 'cp037' },
    });
    r.host(bytes('fffd18'));
    r.terminal(bytes('fffb18'));
    r.host(bytes(frame('f5c2' + ebc('HI'))));
    expect(r.trace().events.map((e) => [e.dir, e.kind])).toEqual([
      ['host', 'telnet'],
      ['terminal', 'telnet'],
      ['host', 'record'],
    ]);
    expect(r.trace().final!.text[0]!.startsWith('HI')).toBe(true);
  });
});

describe('replayTrace', () => {
  it('reproduces the recorded final screen', async () => {
    const { recorder } = await recordSession();
    const trace = recorder.trace();
    const result = replayTrace(trace);
    expect(result.final.text).toEqual(trace.final!.text);
    expect(result.screens.length).toBe(2); // one per host write
    expect(result.screens[0]!.text[0]!.startsWith(' USER')).toBe(true); // FA cell first
  });

  it('rejects traces in an unknown format', () => {
    expect(() => replayTrace({ format: 'other' } as unknown as Trace)).toThrow(/format/);
  });
});

describe('committed traces', () => {
  it('the TK5 TSO logon trace replays to its recorded final screen', () => {
    const trace = JSON.parse(
      readFileSync(new URL('../../../traces/tk5/tso-logon.json', import.meta.url), 'utf8'),
    ) as Trace;
    const result = replayTrace(trace);
    expect(result.final.text).toEqual(trace.final!.text);
    expect(
      result.screens.some((s) => s.text.some((l) => l.includes('ISPF primary option menu'))),
    ).toBe(true);
  });
});
