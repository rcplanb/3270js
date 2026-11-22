/**
 * TSO and ISPF on MVS (TK5) and OS/390: logon, back to the ISPF primary
 * menu, logoff. The recovery steps were learned on real systems (see the
 * README's "What Phase 1 taught us"):
 * - VTAM may not repaint a terminal after a session ended badly: Clear wakes it.
 * - A dropped session waits for RECONNECT; PA2 then redraws its panel.
 * - A reconnected session can be on any panel, even in a stale editor: CANCEL
 *   leaves an editor without saving, END and =X back out of the rest.
 */
import { recognise } from '../core/recognise/index.js';
import { ScriptError, type Session } from './session.js';

const READY = /^\s*READY\s*$/m;
const IN_USE = /IN USE/;
const RECONNECTED = /RECONNECT SUCCESSFUL/;
const EDITOR = /^\s*(REVEDIT|EDIT)\s[\s\S]*TOP OF DATA/m;

/** Wait for VTAM's logon screen, pressing Clear once if VTAM doesn't repaint. */
export async function waitForLogonScreen(s: Session, timeoutMs = 5_000): Promise<void> {
  try {
    await s.waitFor('vtam-logon', { timeoutMs });
  } catch (e) {
    if (!(e instanceof ScriptError) || !e.message.startsWith('timed out')) throw e;
    await s.press('CLEAR', 'vtam-logon', { what: 'the logon screen after Clear' });
  }
}

export interface LogonOptions {
  user: string;
  password: string;
}

/**
 * Log on from VTAM's logon screen and page through to ISPF or READY.
 * Reconnects to a session left waiting, and backs out of whatever panel it
 * was on (`reconnected` says so). The password is typed into the
 * non-display field TSO provides.
 */
export async function tsoLogon(s: Session, o: LogonOptions): Promise<{ reconnected: boolean }> {
  // VTAM leaves the cursor in its logon field (TK5) or on its USS screen (OS/390).
  s.type(o.user);
  await s.press('ENTER', (t) => recognise(t).kind === 'password' || IN_USE.test(t.text.join('\n')));
  const reconnected = IN_USE.test(s.screen);
  if (reconnected) {
    // TSO takes the next line as a LOGON command; RECONNECT reattaches the waiting session.
    s.type(`LOGON ${o.user} RECONNECT`);
    await s.press('ENTER', 'password');
  }
  if (recognise(s.term).kind !== 'password') throw new ScriptError('no password prompt');
  s.type(o.password);
  await s.press('ENTER');
  if (RECONNECTED.test(s.screen)) {
    // The application doesn't know its screen was lost: Enter through "***",
    // then PA2 (reshow) repaints whatever panel it was on.
    for (let i = 0; i < 3 && RECONNECTED.test(s.screen); i++) {
      await s.press(recognise(s.term).kind === 'more' ? 'ENTER' : 'PA2');
    }
    await toIspfPrimary(s);
  }
  await s.pageThrough((t) => {
    const k = recognise(t).kind;
    return k === 'ispf-primary' || k === 'tso-ready';
  });
  return { reconnected };
}

/** From any ISPF panel (or a stale editor), back to the ISPF primary menu, or to READY. */
export async function toIspfPrimary(s: Session, limit = 8): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const kind = recognise(s.term).kind;
    if (kind === 'ispf-primary' || kind === 'tso-ready') return;
    if (kind === 'more') await s.press('ENTER');
    else if (EDITOR.test(s.screen)) await s.command('CANCEL');
    else if (i % 3 === 2) await s.command('=X');
    else await s.press('PF3');
  }
}

/** Leave ISPF (=X, PF3 as a fallback) to READY, then LOGOFF, back to the logon screen. */
export async function tsoLogoff(s: Session, limit = 8): Promise<void> {
  if (s.term.keyboard.isLocked) s.term.press({ type: 'reset' });
  for (let i = 0; i < limit && !READY.test(s.screen); i++) {
    const kind = recognise(s.term).kind;
    if (kind === 'vtam-logon') return; // already off
    if (kind === 'more') await s.press('ENTER');
    else if (EDITOR.test(s.screen)) await s.command('CANCEL');
    else if (i < 3) await s.command('=X');
    else await s.press('PF3');
  }
  if (!READY.test(s.screen)) throw new ScriptError(`not at READY:\n${s.screen}`);
  s.type('LOGOFF');
  await s.press('ENTER', 'vtam-logon');
}
