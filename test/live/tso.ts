/** Shared helpers for live TSO tests: a Terminal session with robust logon/logoff and optional tracing. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import type { AidKey } from '../../src/core/inbound/index.js';
import { Terminal } from '../../src/core/terminal.js';
import { createTraceRecorder, type TraceRecorder } from '../../src/core/trace/index.js';
import { TcpTransport } from '../../src/node.js';

export const env = {
  host: process.env.HERCULES_HOST,
  port: Number(process.env.HERCULES_PORT ?? 3270),
  user: process.env.TSO_USER ?? 'HERC01',
  password: process.env.TSO_PASSWORD,
};
export const liveEnabled = Boolean(env.host && env.password);

const CONTINUE = /\*\*\*\s*$/m;
const READY = /^\s*READY\s*$/m;

export class TsoSession {
  readonly term = new Terminal();
  readonly recorder: TraceRecorder | undefined;
  loggedOn = false;

  constructor(
    readonly name: string,
    readonly tracePath = process.env.RECORD_TRACE,
  ) {
    if (tracePath) {
      this.recorder = createTraceRecorder({
        meta: {
          terminalType: this.term.terminalType,
          model: this.term.model,
          codePage: this.term.codePage.id,
          description: name,
          recorded: new Date().toISOString(),
        },
      });
      this.recorder.attach(this.term);
    }
  }

  get screen(): string {
    return this.term.text.join('\n');
  }

  show(label: string): void {
    console.log(`\n===== ${label}\n${this.term.text.filter((l) => l.trim()).join('\n')}`);
  }

  /** Resolve once `cond` holds, the keyboard is unlocked and the host has been quiet for `quietMs`. */
  waitFor(cond: (screen: string) => boolean, what: string, timeoutMs = 30_000, quietMs = 400) {
    const term = this.term;
    return new Promise<void>((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(timer);
        offRender();
        offOia();
      };
      const check = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          if (!term.keyboard.isLocked && cond(this.screen)) {
            finish();
            resolve();
          }
        }, quietMs);
      };
      const offRender = term.on('render', check);
      const offOia = term.on('oia', check);
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`timed out waiting for ${what}. Screen:\n${this.screen}`));
      }, timeoutMs);
      check();
    });
  }

  /** Type text at the cursor (if given) and press an AID key, then wait for the host. */
  async key(aid: AidKey, text?: string, until: (s: string) => boolean = () => true, what = 'host') {
    if (text !== undefined) expect(this.term.type(text).accepted, `typing ${text}`).toBe(true);
    expect(this.term.aid(aid).accepted, `pressing ${aid}`).toBe(true);
    await this.waitFor(until, what);
    if (process.env.LIVE_VERBOSE)
      this.show(`${text === env.password ? '<password>' : (text ?? '')} ${aid}`);
  }

  /** Press Enter through "***" continuation prompts until `cond` holds. */
  async pageUntil(cond: (s: string) => boolean, what: string) {
    for (let i = 0; i < 10 && !cond(this.screen) && CONTINUE.test(this.screen); i++) {
      await this.key('ENTER', undefined, (s) => cond(s) || CONTINUE.test(s), what);
    }
    expect(cond(this.screen), `expected ${what}`).toBe(true);
  }

  async connect() {
    await this.term.connect(new TcpTransport({ host: env.host!, port: env.port }));
    try {
      await this.waitFor((s) => s.includes('Logon ===>'), 'the logon screen', 5_000);
    } catch {
      // After an abnormal session end VTAM may not repaint; Clear wakes it, as at a real terminal.
      this.term.aid('CLEAR');
      await this.waitFor((s) => s.includes('Logon ===>'), 'the logon screen after Clear');
    }
  }

  /** Log on and page through to ISPF. Reconnects if a previous session is waiting. */
  async logon() {
    await this.key(
      'ENTER',
      env.user,
      (s) => s.includes('PASSWORD') || s.includes('IN USE'),
      'password prompt',
    );
    if (this.screen.includes('IN USE')) {
      // TSO takes the next line as a LOGON command; RECONNECT reattaches the waiting session.
      await this.key(
        'ENTER',
        `LOGON ${env.user} RECONNECT`,
        (s) => s.includes('PASSWORD'),
        'password prompt',
      );
    }
    await this.key(
      'ENTER',
      env.password,
      (s) =>
        CONTINUE.test(s) ||
        s.includes('ISPF') ||
        READY.test(s) ||
        s.includes('RECONNECT SUCCESSFUL'),
      'logon messages',
    );
    this.loggedOn = true;
    expect(this.screen).not.toContain(env.password!); // typed into a non-display field
    if (this.screen.includes('RECONNECT SUCCESSFUL')) {
      // The reconnected application doesn't know its screen was lost: Enter
      // through "***", then PA2 (reshow) repaints whatever panel it was on.
      for (let i = 0; i < 3 && this.screen.includes('RECONNECT SUCCESSFUL'); i++) {
        await this.key(CONTINUE.test(this.screen) ? 'ENTER' : 'PA2');
      }
      // A reconnected session may be on any panel: END back to the primary menu.
      for (
        let i = 0;
        i < 6 && !this.screen.includes('ISPF primary option menu') && !READY.test(this.screen);
        i++
      ) {
        if (CONTINUE.test(this.screen)) await this.key('ENTER');
        else await this.command('END');
      }
    }
    await this.pageUntil(
      (s) => s.includes('ISPF primary option menu') || READY.test(s),
      'ISPF or READY',
    );
  }

  /**
   * Enter an ISPF command from any panel: Home to the command line, Erase EOF,
   * type. On scrollable panels also send a valid Scroll amount (the next
   * field): RFE refuses every command while the host holds an invalid one, and
   * merely erasing the field wouldn't send anything.
   */
  async command(text: string) {
    this.term.press({ type: 'home' });
    this.term.press({ type: 'eraseEof' });
    expect(this.term.type(text).accepted).toBe(true);
    if (this.screen.includes('Scroll ===>')) {
      this.term.press({ type: 'tab' });
      this.term.press({ type: 'eraseEof' });
      this.term.type('CSR');
    }
    await this.key('ENTER');
  }

  /** Leave ISPF (=X from any panel, PF3 as a fallback) to READY, then LOGOFF. */
  async logoff() {
    for (let i = 0; i < 8 && !READY.test(this.screen); i++) {
      if (CONTINUE.test(this.screen)) await this.key('ENTER');
      else if (i < 3) await this.command('=X');
      else await this.key('PF3');
    }
    expect(READY.test(this.screen), 'READY').toBe(true);
    await this.key(
      'ENTER',
      'LOGOFF',
      (s) => s.includes('Logon ===>'),
      'the logon screen after LOGOFF',
    );
    this.loggedOn = false;
  }

  /** Always call from afterAll: never leave the session waiting for reconnect; write the trace. */
  async close() {
    if (this.loggedOn && this.term.connected) {
      if (this.term.keyboard.isLocked) this.term.press({ type: 'reset' });
      await this.logoff().catch((e: unknown) => console.error('logoff failed:', e));
    }
    this.term.disconnect();
    if (this.recorder && this.tracePath) {
      mkdirSync(dirname(this.tracePath), { recursive: true });
      writeFileSync(this.tracePath, JSON.stringify(this.recorder.trace(), null, 1) + '\n');
      console.log(`trace written to ${this.tracePath}`);
    }
  }
}
