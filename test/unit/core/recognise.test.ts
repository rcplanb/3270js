/** Screen recognisers on the screens of recorded TK5 and OS/390 sessions. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionObserver } from '../../../src/core/observer/index.js';
import { fieldAfter, match, recognise, screenState } from '../../../src/core/recognise/index.js';
import type { Trace } from '../../../src/core/trace/index.js';
import { frame } from '../../helpers/fake-host.js';

/** The observer after each host record of a trace. */
function* screens(name: string) {
  const t = JSON.parse(
    readFileSync(new URL(`../../traces/${name}.json`, import.meta.url), 'utf8'),
  ) as Trace;
  const o = new SessionObserver({ model: t.meta.model });
  for (const e of t.events) {
    const b = Uint8Array.from(Buffer.from(e.kind === 'record' ? frame(e.hex) : e.hex, 'hex'));
    if (e.dir === 'terminal') o.terminal(b);
    else {
      o.host(b);
      if (e.kind === 'record') yield o;
    }
  }
}
/** Apply `fn` to each screen as it goes by (the observer is reused between them). */
function each<T>(name: string, fn: (o: SessionObserver) => T): T[] {
  const out: T[] = [];
  for (const o of screens(name)) out.push(fn(o));
  return out;
}
const kinds = (name: string) => each(name, (o) => recognise(o).kind);
const states = (name: string) => each(name, (o) => screenState(o, o.keyboardLocked));

describe('recognise (TK5)', () => {
  it('follows a logon: logo, VTAM logon, password, ***, ISPF, READY, logon again', () => {
    const k = kinds('tk5/tso-logon');
    expect(k[0]).toBe('hercules');
    expect(k[1]).toBe('vtam-logon');
    expect(k[4]).toBe('password');
    expect(k[8]).toBe('more');
    expect(k[12]).toBe('more');
    expect(k[14]).toBe('ispf-primary');
    expect(k[16]).toBe('tso-ready');
    expect(k[19]).toBe('vtam-logon');
  });

  it('names ISPF panels and finds their command lines', () => {
    const st = states('tk5/ispf-tour');
    expect(st[14]).toMatchObject({ kind: 'ispf-primary', title: 'ISPF Primary Option Menu' });
    expect(st[15]).toMatchObject({ kind: 'ispf-panel', title: 'RFE DSLIST' });
    expect(st[22]).toMatchObject({ kind: 'ispf-panel', title: 'Utility selection menu' });
    expect(st[25]).toMatchObject({ kind: 'ispf-panel', title: 'LIBRARY UTILITY' });
    expect(st[26]).toMatchObject({ kind: 'ispf-panel', title: 'TSO COMMAND PROCESSOR' });
    expect(st[28]!.kind).toBe('more'); // "*** e command C6TUTOR ..." over the panel
    // The command field is the one after "Option ===>" on the primary menu.
    const cf = st[14]!.commandField!;
    expect(st[14]!.text[Math.floor(cf.dataStart / 80)]).toMatch(/Option\s+===>/);
  });

  it('gives a plain state for the Docent: labels, and never a hidden value', () => {
    const st = states('tk5/tso-logon');
    const logon = st[1]!;
    expect(logon.ready).toBe(true);
    const input = logon.fields.find((f) => f.index === 0)!;
    expect(input.label).toMatch(/Logon ===>/);
    const pw = st[4]!;
    expect(pw.password).toBe(true);
    expect(pw.fields.filter((f) => f.hidden).every((f) => f.value === '')).toBe(true);
    expect(st[5]!.ready).toBe(false); // locked after the password was sent
  });
});

describe('recognise (OS/390 2.10)', () => {
  it('recognises the USS logon screen', () => {
    expect(kinds('os390/uss-screen').at(-1)).toBe('vtam-logon');
  });
});

describe('matchers', () => {
  it('combine', () => {
    const results = each('tk5/tso-logon', (s) => ({
      ispf: match.text(/ISPF primary option menu/i)(s),
      lastRow: match.row(-1, 'nothing here')(s),
      both: match.all(match.text('Option'), match.not(match.cursorInHiddenField()))(s),
      either: match.any(match.text('zzz'), match.text('Option'))(s),
      none: fieldAfter(s, 'No such label'),
    }));
    const s14 = results[14]!;
    expect(s14).toEqual({ ispf: true, lastRow: false, both: true, either: true, none: undefined });
  });
});

describe('recognise on a Terminal (OS/390-style ISPF screen)', () => {
  it('finds the primary menu and its Option field', async () => {
    const { Terminal } = await import('../../../src/core/terminal.js');
    const { FakeHost, HERCULES_NEGOTIATION } = await import('../../helpers/fake-host.js');
    const { cp037 } = await import('../../../src/core/codepage/index.js');
    const e = (t: string) => Buffer.from(cp037.encode(t)).toString('hex');
    const term = new Terminal();
    const host = new FakeHost();
    const ready = term.connect(host);
    for (const c of HERCULES_NEGOTIATION) host.write(c);
    await ready;
    // Row 0: protected title; row 1: "Option ===>" then an input field.
    host.write(
      frame(
        'f5c3' +
          '1d60' +
          e('   Menu  Utilities  Help') +
          '11c150' +
          '1d60' +
          e('Option ===>') +
          '1d40' +
          '13' +
          '11c260' +
          '1d60' +
          e('         ISPF Primary Option Menu'),
      ),
    );
    const r = recognise(term);
    expect(r.kind).toBe('ispf-primary');
    expect(r.commandField?.dataStart).toBe(80 + 13);
    expect(screenState(term, term.keyboard.isLocked).ready).toBe(true);
  });
});
