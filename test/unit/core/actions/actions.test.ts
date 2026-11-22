import { describe, expect, it } from 'vitest';
import { applyAction, parseAction, type DocentAction } from '../../../../src/core/actions/index.js';
import { cp037 } from '../../../../src/core/codepage/index.js';
import { Terminal } from '../../../../src/core/terminal.js';
import { Session } from '../../../../src/script/index.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../../helpers/fake-host.js';

const e = (t: string) => Buffer.from(cp037.encode(t)).toString('hex');
const sba = (row: number, col: number) => {
  const a = row * 80 + col;
  const code = (n: number) =>
    [
      0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
      0x4f, 0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d,
      0x5e, 0x5f, 0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c,
      0x6d, 0x6e, 0x6f, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b,
      0x7c, 0x7d, 0x7e, 0x7f,
    ][n]!;
  return '11' + code(a >> 6).toString(16) + code(a & 0x3f).toString(16);
};

/**
 * Row 0: "Option ===>" + an input field (cursor there).
 * Row 2: "Data set ===>" + input; row 3: "Password ===>" + hidden input;
 * row 4: "Volume ===>" + a protected field.
 */
const FORM =
  'f5c3' +
  sba(0, 0) +
  '1d60' +
  e('Option ===>') +
  '1d40' +
  '13' +
  sba(0, 40) +
  '1d60' +
  sba(2, 0) +
  '1d60' +
  e('Data set ===>') +
  '1d40' +
  sba(2, 40) +
  '1d60' +
  sba(3, 0) +
  '1d60' +
  e('Password ===>') +
  '1d4c' +
  sba(3, 30) +
  '1d60' +
  sba(4, 0) +
  '1d60' +
  e('Volume ===>') +
  '1d60' +
  e('TK5RES');

async function connected(screen = FORM) {
  const host = new FakeHost();
  const term = new Terminal();
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  host.write(frame(screen));
  host.takeSent();
  return { host, term };
}

describe('applyAction', () => {
  it('fills fields by label and by index, then presses the key', async () => {
    const { host, term } = await connected();
    const r = applyAction(term, {
      fill: [
        { field: 'Data set ===>', text: 'SYS1.PROCLIB' },
        { field: 0, text: '3.4' },
      ],
      aid: 'ENTER',
    });
    expect(r).toEqual({ ok: true, aid: 'ENTER' });
    const sent = host.takeSent();
    expect(sent.startsWith('7d')).toBe(true);
    expect(sent).toContain(e('SYS1.PROCLIB'));
    expect(sent).toContain(e('3.4'));
  });

  it('types a command on the command line and presses Enter by default', async () => {
    const { host, term } = await connected();
    term.moveCursor(2 * 80 + 14); // the cursor elsewhere: the command still goes to Option ===>
    expect(applyAction(term, { command: '=X' })).toEqual({ ok: true, aid: 'ENTER' });
    expect(term.text[0]).toContain('Option ===> =X');
    expect(host.takeSent()).toContain(e('=X'));
  });

  it('types a command at the cursor at TSO READY (no fields), not at the top', async () => {
    const { host, term } = await connected('f5c3' + e(' READY') + sba(1, 0) + '13');
    expect(applyAction(term, { command: 'LISTCAT' })).toEqual({ ok: true, aid: 'ENTER' });
    expect(term.text[0]).toContain('READY');
    expect(term.text[1]!.trim()).toBe('LISTCAT');
    expect(host.takeSent()).toContain(e('LISTCAT'));
  });

  it('presses PF3 alone', async () => {
    const { host, term } = await connected();
    expect(applyAction(term, { aid: 'PF3' })).toEqual({ ok: true, aid: 'PF3' });
    expect(host.takeSent().startsWith('f3')).toBe(true);
  });

  const refusals: [string, DocentAction, string][] = [
    ['a password field (by label)', { fill: [{ field: 'Password ===>', text: 'x' }] }, 'password'],
    ['a password field (by index)', { fill: [{ field: 2, text: 'x' }] }, 'password'],
    ['a protected field', { fill: [{ field: 'Volume ===>', text: 'x' }] }, 'protected'],
    ['a missing field', { fill: [{ field: 'Nope ===>', text: 'x' }] }, 'no-field'],
    ['text too long', { fill: [{ field: 0, text: 'x'.repeat(60) }] }, 'too-long'],
  ];
  it.each(refusals)('refuses %s, changing nothing', async (_, action, reason) => {
    const { host, term } = await connected();
    const before = term.text.join('\n');
    const r = applyAction(term, {
      fill: [{ field: 'Data set ===>', text: 'CHANGED' }, ...action.fill!],
      aid: 'ENTER',
    });
    expect(r).toMatchObject({ ok: false, error: 'injection_blocked', reason });
    expect(term.text.join('\n')).toBe(before); // not even the first fill
    expect(host.takeSent()).toBe('');
  });

  it('refuses while the keyboard is locked, and a command at a password prompt', async () => {
    const { term } = await connected();
    term.aid('ENTER'); // now waiting for the host
    expect(applyAction(term, { command: 'X' })).toMatchObject({ reason: 'locked' });
    const pw = await connected(
      'f5c3' + e('ENTER PASSWORD') + sba(1, 0) + '1d4c' + '13' + sba(1, 20) + '1d60',
    );
    expect(applyAction(pw.term, { command: 'secret' })).toMatchObject({ reason: 'password' });
    expect(pw.host.takeSent()).toBe('');
  });

  it('refuses characters the code page lacks', async () => {
    const { term } = await connected();
    expect(applyAction(term, { command: 'café €' })).toMatchObject({
      ok: false,
      error: 'invalid_action',
    });
  });
});

describe('parseAction (untrusted JSON)', () => {
  it('accepts a well-formed action', () => {
    expect(parseAction({ fill: [{ field: 'Option ===>', text: '2' }], aid: 'PF3' })).toEqual({
      action: { fill: [{ field: 'Option ===>', text: '2' }], aid: 'PF3' },
    });
  });

  it.each([
    [null, 'invalid_action'],
    [[], 'invalid_action'],
    [{}, 'invalid_action'],
    [{ run: 'rm -rf' }, 'invalid_action'],
    [{ fill: 'x' }, 'invalid_action'],
    [{ fill: [{ field: -1, text: 'x' }] }, 'invalid_action'],
    [{ fill: [{ field: 0, text: 7 }] }, 'invalid_action'],
    [{ command: '' }, 'invalid_action'],
    [{ aid: 'SYSREQ' }, 'injection_blocked'],
    [{ aid: 'ATTN' }, 'injection_blocked'],
    [{ aid: { toString: 1 } }, 'injection_blocked'],
  ])('rejects %j', (json, error) => {
    const r = parseAction(json);
    expect('error' in r && r.error).toMatchObject({ ok: false, error });
  });
});

describe('Session.command at TSO READY', () => {
  it('types at the cursor, not at the top of the screen', async () => {
    const { host, term } = await connected('f5c3' + e(' READY') + sba(1, 0) + '13');
    const s = new Session(term, { quietMs: 10, timeoutMs: 200 });
    const done = s.command('TIME').catch(() => undefined); // the fake host never answers
    expect(term.text[0]).toContain('READY');
    expect(host.takeSent()).toContain(e('TIME'));
    await done;
  });
});
