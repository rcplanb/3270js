/**
 * KeyboardMapper: turns browser keyboard and mouse input into 3270 actions.
 *
 * Like xterm.js, it uses a hidden textarea for focus: ordinary text arrives
 * through `input` events (so dead keys, IME composition and paste work), and
 * special keys are mapped on `keydown`. Only mapped keys have their browser
 * default suppressed.
 */
import type { AidKey } from '../core/inbound/index.js';
import type { KeyAction, KeyResult } from '../core/keyboard/index.js';
import type { Terminal } from '../core/terminal.js';
import type { Renderer } from './renderer.js';

/** A key binding's target: a 3270 action, or an AID key by name. */
export type KeyBinding = Exclude<KeyAction, { type: 'char' }> | AidKey;

/**
 * Bindings are keyed by combo: optional `Ctrl+`, `Alt+`, `Shift+`, `Meta+`
 * (in that order), then the key: `event.key` for named keys (Enter, F1,
 * ArrowLeft…) or `event.code` for letters and digits (KeyA, Digit1).
 */
export type Keymap = Record<string, KeyBinding>;

const pf = (n: number): AidKey => `PF${n}` as AidKey;

/** F1–F12 → PF1–12, Shift+F1–F12 → PF13–24. */
function pfKeys(): Keymap {
  const map: Keymap = {};
  for (let i = 1; i <= 12; i++) {
    map[`F${i}`] = pf(i);
    map[`Shift+F${i}`] = pf(i + 12);
  }
  return map;
}

/** x3270-style defaults (SPEC §3), plus keys for Attn and SysReq. */
export const DEFAULT_KEYMAP: Keymap = {
  Enter: 'ENTER',
  'Shift+Enter': { type: 'newline' },
  Escape: 'CLEAR',
  'Ctrl+KeyR': { type: 'reset' },
  'Alt+Digit1': 'PA1',
  'Alt+Digit2': 'PA2',
  'Alt+Digit3': 'PA3',
  'Alt+KeyA': { type: 'attn' },
  'Alt+KeyS': 'SYSREQ',
  'Alt+KeyD': { type: 'dup' },
  'Alt+KeyF': { type: 'fieldMark' },
  Tab: { type: 'tab' },
  'Shift+Tab': { type: 'backtab' },
  Home: { type: 'home' },
  ArrowLeft: { type: 'left' },
  ArrowRight: { type: 'right' },
  ArrowUp: { type: 'up' },
  ArrowDown: { type: 'down' },
  Backspace: { type: 'erase' },
  Delete: { type: 'delete' },
  Insert: { type: 'toggleInsert' },
  End: { type: 'eraseEof' },
  'Ctrl+End': { type: 'eraseInput' },
  ...pfKeys(),
};

export interface KeyboardMapperOptions {
  /** Bindings merged over the defaults; a binding of `null` removes a default. */
  keymap?: Record<string, KeyBinding | null>;
  /** Clicking a cell moves the cursor there (as x3270 does). Default true. */
  clickToMoveCursor?: boolean;
  /** Called for every key the terminal refused, e.g. to sound a beep. */
  onRejected?: (result: KeyResult) => void;
}

/** The combo string for a keyboard event (see Keymap). */
export function comboOf(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string {
  const name =
    /^(Key[A-Z]|Digit\d)$/.test(e.code) && (e.ctrlKey || e.altKey || e.metaKey) ? e.code : e.key;
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${name}`;
}

export class KeyboardMapper {
  readonly textarea: HTMLTextAreaElement;
  readonly #term: Terminal;
  readonly #renderer: Renderer;
  readonly #keymap: Keymap;
  readonly #options: KeyboardMapperOptions;
  readonly #cleanup: (() => void)[] = [];
  #composing = false;

  constructor(terminal: Terminal, renderer: Renderer, options: KeyboardMapperOptions = {}) {
    this.#term = terminal;
    this.#renderer = renderer;
    this.#options = options;
    const map: Keymap = { ...DEFAULT_KEYMAP };
    for (const [k, v] of Object.entries(options.keymap ?? {})) {
      if (v === null) delete map[k];
      else map[k] = v;
    }
    this.#keymap = map;

    const doc = renderer.element.ownerDocument;
    const ta = doc.createElement('textarea');
    ta.className = 't3270-input';
    ta.setAttribute('aria-label', '3270 keyboard input');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
    Object.assign(ta.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      padding: '0',
      border: '0',
      resize: 'none',
      overflow: 'hidden',
    });
    renderer.element.append(ta);
    this.textarea = ta;

    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.#cleanup.push(() => el.removeEventListener(type, fn));
    };
    on(ta, 'keydown', (e) => this.#keydown(e));
    on(ta, 'keyup', (e) => this.#updateShift(e));
    on(ta, 'input', () => this.#input());
    on(ta, 'compositionstart', () => (this.#composing = true));
    on(ta, 'compositionend', () => {
      this.#composing = false;
      this.#input();
    });
    on(renderer.element, 'focus', () => ta.focus());
    on(renderer.element, 'mousedown', (e) => this.#click(e));
  }

  focus(): void {
    this.textarea.focus();
  }

  dispose(): void {
    for (const c of this.#cleanup.splice(0)) c();
    this.textarea.remove();
  }

  /** Type text as if entered at the keyboard: newlines move to the next line, tabs to the next field. */
  paste(text: string): void {
    for (const ch of text.replace(/\r\n?/g, '\n')) {
      if (ch === '\n') this.#press({ type: 'newline' });
      else if (ch === '\t') this.#press({ type: 'tab' });
      else this.#char(ch);
    }
  }

  #keydown(e: KeyboardEvent): void {
    this.#updateShift(e);
    if (e.isComposing || this.#composing) return;
    const binding = this.#keymap[comboOf(e)];
    if (binding === undefined) return; // let it become text, or let the browser have it
    e.preventDefault();
    this.#press(typeof binding === 'string' ? { type: 'aid', key: binding } : binding);
  }

  #input(): void {
    if (this.#composing) return;
    const text = this.textarea.value;
    this.textarea.value = '';
    if (text) this.paste(text);
  }

  #char(ch: string): void {
    const byte = this.#term.codePage.fromUnicode(ch);
    if (byte === undefined || byte < 0x40) return; // not representable; ignore
    this.#press({ type: 'char', byte });
  }

  #press(action: KeyAction): void {
    const r = this.#term.press(action);
    if (!r.accepted) this.#options.onRejected?.(r);
  }

  #updateShift(e: KeyboardEvent): void {
    this.#renderer.setShift(e.shiftKey || e.getModifierState?.('CapsLock') === true);
  }

  #click(e: MouseEvent): void {
    if (this.#options.clickToMoveCursor === false || e.button !== 0) return;
    const m = this.#renderer.cellMetrics;
    const screenEl = this.#renderer.element.querySelector('.t3270-screen');
    if (!m || !screenEl) return;
    const rect = screenEl.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / m.width);
    const row = Math.floor((e.clientY - rect.top) / m.height);
    const s = this.#term.screen;
    if (row >= 0 && row < s.rows && col >= 0 && col < s.cols) {
      e.preventDefault();
      this.#term.moveCursor(row * s.cols + col);
      this.textarea.focus();
    }
  }
}
