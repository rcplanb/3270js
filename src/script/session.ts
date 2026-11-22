/**
 * Scripting a 3270 session: wait for a screen, fill fields, press keys, as an
 * operator would. Built on Terminal and the screen recognisers. Not part of
 * the platform-neutral core: it uses timers, which browsers and Node have.
 */
import type { AidKey } from '../core/inbound/index.js';
import {
  type Matcher,
  type ScreenKind,
  type ScreenState,
  fieldAfter,
  match,
  recognise,
  screenState,
} from '../core/recognise/index.js';
import type { Terminal } from '../core/terminal.js';

/** What to wait for: a screen kind, text, a regex, or any matcher. */
export type Until = ScreenKind | { text: string | RegExp } | RegExp | Matcher;

export interface SessionOptions {
  /** How long to wait for the host, by default. Default 30 s. */
  timeoutMs?: number;
  /** How long the host must be quiet before a screen counts as settled. Default 400 ms. */
  quietMs?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Named in the timeout error. */
  what?: string;
}

/** A refused key or field: the terminal would have shown an operator error. */
export class ScriptError extends Error {}

const KINDS = new Set<string>([
  'hercules',
  'vtam-logon',
  'password',
  'more',
  'ispf-primary',
  'ispf-panel',
  'tso-ready',
  'unknown',
]);

function toMatcher(until: Until): Matcher {
  if (typeof until === 'function') return until;
  if (until instanceof RegExp) return match.text(until);
  if (typeof until === 'string') {
    if (!KINDS.has(until)) throw new ScriptError(`unknown screen kind "${until}"`);
    return (s) => recognise(s).kind === until;
  }
  return match.text(until.text);
}

function describe(until: Until | undefined): string {
  if (until === undefined) return 'the host';
  if (typeof until === 'string') return `a ${until} screen`;
  if (until instanceof RegExp) return String(until);
  if (typeof until === 'function') return 'the screen';
  return JSON.stringify(String(until.text));
}

export class Session {
  readonly #timeoutMs: number;
  readonly #quietMs: number;

  constructor(
    readonly term: Terminal,
    options: SessionOptions = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#quietMs = options.quietMs ?? 400;
  }

  /** The screen as one string (rows joined with newlines). */
  get screen(): string {
    return this.term.text.join('\n');
  }

  /** The screen, recognised (see `screenState`). */
  get state(): ScreenState {
    return screenState(this.term, this.term.keyboard.isLocked);
  }

  /**
   * Resolve once the keyboard is free, the host has been quiet for `quietMs`
   * and `until` (if given) holds. Rejects after the timeout, showing the screen.
   */
  waitFor(until?: Until, options: WaitOptions = {}): Promise<void> {
    const term = this.term;
    const cond = until === undefined ? () => true : toMatcher(until);
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const what = options.what ?? describe(until);
    return new Promise<void>((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(timer);
        offRender();
        offOia();
        offClose();
      };
      const check = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          if (!term.keyboard.isLocked && cond(term)) {
            finish();
            resolve();
          }
        }, this.#quietMs);
      };
      const offRender = term.on('render', check);
      const offOia = term.on('oia', check);
      const offClose = term.on('disconnect', (d) => {
        finish();
        reject(
          new ScriptError(
            `disconnected while waiting for ${what}${d.reason ? `: ${d.reason}` : ''}`,
          ),
        );
      });
      const timer = setTimeout(() => {
        finish();
        reject(new ScriptError(`timed out waiting for ${what}. Screen:\n${this.screen}`));
      }, timeoutMs);
      check();
    });
  }

  /** Type at the cursor. Throws if the terminal refuses (e.g. a protected field). */
  type(text: string): void {
    const r = this.term.type(text);
    if (!r.accepted) {
      throw new ScriptError(
        `typing refused (${r.error ?? r.rejected ?? 'unknown'}): "${text.slice(0, 20)}"`,
      );
    }
  }

  /**
   * Replace an unprotected field's contents: by its index among the
   * unprotected fields, or by the label before it (e.g. "Option ===>").
   */
  fill(field: number | string | RegExp, text: string): void {
    if (typeof field === 'number') {
      const r = this.term.fillField(field, text);
      if (!r.accepted) throw new ScriptError(`filling field ${field} refused`);
      return;
    }
    const f = fieldAfter(this.term, field);
    if (!f) throw new ScriptError(`no input field after ${String(field)}`);
    this.term.moveCursor(f.dataStart);
    this.term.press({ type: 'eraseEof' });
    this.type(text);
  }

  /** Press an AID key, then wait for the host (and `until`, if given). */
  async press(aid: AidKey, until?: Until, options: WaitOptions = {}): Promise<void> {
    if (!this.term.aid(aid).accepted)
      throw new ScriptError(`${aid} refused: the keyboard is locked`);
    await this.waitFor(until, options);
  }

  /**
   * Enter a command: on the screen's command line if it has one (ISPF's
   * Option/Command ===>), otherwise at the cursor (TSO READY). Then Enter.
   *
   * On scrollable ISPF panels it also sends a valid Scroll amount: RFE refuses
   * every command while the host holds an invalid one (found on TK5).
   */
  async command(text: string, until?: Until, options: WaitOptions = {}): Promise<void> {
    // At TSO READY there's no field: type where TSO left the cursor (the next line).
    const field = recognise(this.term).commandField;
    if (field) this.term.moveCursor(field.dataStart);
    this.term.press({ type: 'eraseEof' });
    this.type(text);
    const scroll = fieldAfter(this.term, 'Scroll ===>');
    if (scroll) {
      this.term.moveCursor(scroll.dataStart);
      this.term.press({ type: 'eraseEof' });
      this.type('CSR');
    }
    await this.press('ENTER', until, options);
  }

  /** Press Enter through TSO's "***" prompts until `until` holds (at most `limit` times). */
  async pageThrough(until?: Until, limit = 10): Promise<void> {
    const done = until === undefined ? () => false : toMatcher(until);
    for (let i = 0; i < limit && !done(this.term) && recognise(this.term).kind === 'more'; i++) {
      await this.press('ENTER');
    }
  }
}
