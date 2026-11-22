/** Shared helpers for live TSO tests: a Terminal session with robust logon/logoff and optional tracing. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import type { AidKey } from '../../src/core/inbound/index.js';
import { Terminal } from '../../src/core/terminal.js';
import { createTraceRecorder, type TraceRecorder } from '../../src/core/trace/index.js';
import { TcpTransport } from '../../src/node.js';
import { Session, tsoLogoff, tsoLogon, waitForLogonScreen } from '../../src/script/index.js';

export const env = {
  host: process.env.HERCULES_HOST,
  port: Number(process.env.HERCULES_PORT ?? 3270),
  user: process.env.TSO_USER ?? 'HERC03',
  password: process.env.TSO_PASSWORD,
};
export const liveEnabled = Boolean(env.host && env.password);

export class TsoSession {
  /**
   * LIVE_COLOR=1 runs as a 3279 (colour), so the host sends its colours;
   * LIVE_MODEL=3|4|5 picks the screen size (default 2).
   */
  readonly term = new Terminal({
    color: process.env.LIVE_COLOR === '1',
    model: Number(process.env.LIVE_MODEL ?? 2) as 2 | 3 | 4 | 5,
  });
  readonly recorder: TraceRecorder | undefined;
  readonly session: Session;
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
    this.session = new Session(this.term, { quietMs: 400 });
  }

  get screen(): string {
    return this.session.screen;
  }

  show(label: string): void {
    console.log(`\n===== ${label}\n${this.term.text.filter((l) => l.trim()).join('\n')}`);
  }

  /** Type text at the cursor (if given) and press an AID key, then wait for the host. */
  async key(aid: AidKey, text?: string, until?: (s: string) => boolean, what = 'host') {
    if (text !== undefined) this.session.type(text);
    await this.session.press(aid, until && ((t) => until(t.text.join('\n'))), { what });
    if (process.env.LIVE_VERBOSE)
      this.show(`${text === env.password ? '<password>' : (text ?? '')} ${aid}`);
  }

  async connect() {
    await this.term.connect(new TcpTransport({ host: env.host!, port: env.port }));
    await waitForLogonScreen(this.session);
  }

  /** Log on and page through to ISPF. Reconnects if a previous session is waiting. */
  async logon() {
    const { reconnected } = await tsoLogon(this.session, {
      user: env.user,
      password: env.password!,
    });
    this.loggedOn = true;
    expect(this.screen).not.toContain(env.password!); // typed into a non-display field
    return { reconnected };
  }

  /** Enter an ISPF or TSO command from any panel. */
  async command(text: string) {
    await this.session.command(text);
  }

  /** Leave ISPF to READY, then LOGOFF. */
  async logoff() {
    await tsoLogoff(this.session);
    this.loggedOn = false;
  }

  /** Always call from afterAll: never leave the session waiting for reconnect; write the trace. */
  async close() {
    if (this.loggedOn && this.term.connected) {
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
