/**
 * Checkpoint B: log on to TSO on a real TK5 system using only 3270js, reach
 * ISPF, exit to READY, log off. Prints every screen as text.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Terminal } from '../../src/core/terminal.js';
import { createTraceRecorder } from '../../src/core/trace/index.js';
import { TcpTransport } from '../../src/node.js';

const host = process.env.HERCULES_HOST;
const port = Number(process.env.HERCULES_PORT ?? 3270);
const user = process.env.TSO_USER ?? 'HERC01';
const password = process.env.TSO_PASSWORD;

const term = new Terminal();
let loggedOn = false;

/** Set RECORD_TRACE=path to save a (redacted) trace of the session. */
const tracePath = process.env.RECORD_TRACE;
const recorder = tracePath
  ? createTraceRecorder({
      meta: {
        terminalType: term.terminalType,
        model: term.model,
        codePage: term.codePage.id,
        description: 'TSO logon to ISPF, =X to READY, LOGOFF (test/live/tso-logon.test.ts)',
        recorded: new Date().toISOString(),
      },
    })
  : undefined;
recorder?.attach(term);

/** Resolve once `cond` holds and the host has been quiet for `quietMs`. */
function waitFor(
  cond: (screen: string) => boolean,
  what: string,
  timeoutMs = 30_000,
  quietMs = 400,
) {
  return new Promise<void>((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (!term.keyboard.isLocked && cond(screenText())) finish();
      }, quietMs);
    };
    const off = term.on('render', check);
    const offOia = term.on('oia', check);
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`timed out waiting for ${what}. Screen:\n${screenText()}`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(quiet);
      clearTimeout(timer);
      off();
      offOia();
      resolve();
    };
    check();
  });
}

const screenText = () => term.text.join('\n');
const has = (text: string) => (s: string) => s.includes(text);
const show = (label: string) =>
  console.log(`\n===== ${label}\n${term.text.filter((l) => l.trim()).join('\n')}`);

function enter(text?: string) {
  if (text !== undefined) expect(term.type(text).accepted).toBe(true);
  expect(term.aid('ENTER').accepted).toBe(true);
}

/** Press Enter through "***" continuation prompts until `cond` holds. */
async function pageUntil(cond: (s: string) => boolean, what: string) {
  for (let i = 0; i < 10 && !cond(screenText()); i++) {
    if (!/\*\*\*\s*$/m.test(screenText())) break;
    enter();
    await waitFor((s) => cond(s) || /\*\*\*\s*$/m.test(s), what);
  }
  expect(cond(screenText()), `expected ${what}`).toBe(true);
}

describe.skipIf(!host || !password)(`TSO logon on ${host ?? '(no host)'}`, () => {
  afterAll(async () => {
    if (loggedOn && term.connected) {
      // Best effort: never leave the session waiting for reconnect.
      if (term.keyboard.isLocked) term.press({ type: 'reset' });
      for (const cmd of ['=X', 'LOGOFF']) {
        term.type(cmd);
        term.aid('ENTER');
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    term.disconnect();
    if (recorder && tracePath) {
      mkdirSync(dirname(tracePath), { recursive: true });
      writeFileSync(tracePath, JSON.stringify(recorder.trace(), null, 1) + '\n');
      console.log(`trace written to ${tracePath}`);
    }
  });

  it('connects and shows the VTAM logon screen', async () => {
    await term.connect(new TcpTransport({ host: host!, port }));
    expect(term.terminalType).toBe('IBM-3278-2-E');
    try {
      await waitFor(has('Logon ===>'), 'the logon screen', 5_000);
    } catch {
      // After an abnormal session end VTAM may not repaint; Clear wakes it, as at a real terminal.
      term.aid('CLEAR');
      await waitFor(has('Logon ===>'), 'the logon screen after Clear');
    }
    show('logon screen');
  });

  it('logs on to TSO', async () => {
    enter(user);
    await waitFor((s) => s.includes('PASSWORD') || s.includes('IN USE'), 'password prompt');
    show(`after userid ${user}`);
    let reconnect = false;
    if (screenText().includes('IN USE')) {
      // A previous session is waiting for reconnect.
      await waitFor(has('ENTER LOGON OR LOGOFF'), 'logon prompt');
      enter(`LOGON ${user} RECONNECT`);
      await waitFor(has('PASSWORD'), 'password prompt');
      reconnect = true;
    }
    enter(password);
    loggedOn = true;
    await waitFor(
      (s) => /\*\*\*\s*$/m.test(s) || s.includes('ISPF') || s.includes('READY'),
      'logon messages',
    );
    show(reconnect ? 'after password (reconnect)' : 'after password');
    expect(screenText()).not.toContain(password!); // non-display field
    await pageUntil(
      (s) => s.includes('ISPF primary option menu') || /^\s*READY/m.test(s),
      'ISPF or READY',
    );
    show('ISPF');
    expect(screenText()).toContain('ISPF primary option menu');
    expect(screenText()).toMatch(new RegExp(`USERID\\s+:\\s+${user}`));
  });

  it('exits ISPF to READY and logs off', async () => {
    enter('=X');
    await pageUntil(() => false, 'READY').catch(() => undefined);
    await waitFor((s) => /^\s*READY/m.test(s), 'READY');
    show('READY');
    enter('LOGOFF');
    await waitFor(has('Logon ===>'), 'the logon screen after LOGOFF');
    loggedOn = false;
    show('after LOGOFF');
  });
});
