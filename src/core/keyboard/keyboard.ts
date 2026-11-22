/**
 * The 3270 keyboard: applies operator actions to the screen and decides what
 * to send. Behaviour follows the 3174 keyboard rules (GA27-2837) as
 * implemented by x3270's kybd.c, our reference emulator. DBCS is not
 * supported.
 */
import { Aid, type ReplyModeState, aidForKey, readModified } from '../inbound/index.js';
import {
  type Screen,
  eraseAllUnprotected,
  nextAddress,
  nextUnprotected,
  prevAddress,
  previousUnprotected,
} from '../screen/index.js';
import type { InhibitReason, KeyAction, KeyOutput, KeyResult, OperatorError } from './actions.js';

const EBC = {
  NULL: 0x00,
  SPACE: 0x40,
  DUP: 0x1c,
  FM: 0x1e,
  PLUS: 0x4e,
  MINUS: 0x60,
  PERIOD: 0x4b,
  COMMA: 0x6b,
  ZERO: 0xf0,
  NINE: 0xf9,
} as const;
const APL = 0xf1;

export interface KeyboardOptions {
  /** Reject non-numeric characters in numeric fields (the 3270 Numeric Lock feature). Default false. */
  numericLock?: boolean;
  /**
   * Treat trailing blanks as room for insert, and turn nulls before the cursor
   * into blanks when typing (x3270's blankFill). Default false: a real 3270
   * only inserts into nulls.
   */
  blankFill?: boolean;
}

export class Keyboard {
  readonly #screen: Screen;
  readonly #options: Required<KeyboardOptions>;
  #inhibit: InhibitReason | undefined = 'notConnected';
  #operatorError: OperatorError | undefined;
  #insertMode = false;
  /** The host's reply mode (Set Reply Mode), used when an AID key sends Read Modified. */
  reply: ReplyModeState | undefined;
  #listeners = new Set<() => void>();

  constructor(screen: Screen, options: KeyboardOptions = {}) {
    this.#screen = screen;
    this.#options = { numericLock: false, blankFill: false, ...options };
  }

  get inhibit(): InhibitReason | undefined {
    return this.#inhibit;
  }
  get operatorError(): OperatorError | undefined {
    return this.#operatorError;
  }
  get insertMode(): boolean {
    return this.#insertMode;
  }
  get isLocked(): boolean {
    return this.#inhibit !== undefined || this.#operatorError !== undefined;
  }

  /** Call `listener` after any change to lock state or insert mode. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The session reached 3270 mode. */
  connected(): void {
    this.#update(() => {
      this.#inhibit = 'awaitingFirst';
      this.#operatorError = undefined;
    });
  }

  disconnected(): void {
    this.#update(() => {
      this.#inhibit = 'notConnected';
      this.#operatorError = undefined;
      this.#insertMode = false;
    });
  }

  /** The host wrote to the screen. `keyboardRestore` from the WCC, or true for EAU. */
  hostWrite(result: { keyboardRestore: boolean }): void {
    this.#update(() => {
      if (this.#inhibit === 'notConnected') return;
      if (result.keyboardRestore) {
        this.#inhibit = undefined;
        this.#operatorError = undefined;
        this.#insertMode = false;
      } else if (this.#inhibit === 'awaitingFirst') {
        this.#inhibit = undefined;
      } else if (this.#inhibit === 'wait') {
        this.#inhibit = 'system';
      }
    });
  }

  press(action: KeyAction): KeyResult {
    let result: KeyResult = { accepted: false, outputs: [] };
    this.#update(() => {
      result = this.#press(action);
    });
    return result;
  }

  #press(action: KeyAction): KeyResult {
    if (this.#inhibit === 'notConnected') return rejected('notConnected');

    switch (action.type) {
      case 'reset':
        this.#inhibit = undefined;
        this.#operatorError = undefined;
        this.#insertMode = false;
        return ok();
      case 'attn':
        // x3270 on TN3270 (not TN3270E): PA1 short read plus telnet BREAK.
        return ok([
          { kind: 'record', data: Uint8Array.of(Aid.PA1) },
          { kind: 'telnet', command: 'BREAK' },
        ]);
      case 'aid':
        return this.#aid(action.key);
      case 'char':
        if (this.isLocked) return this.#rejection();
        return this.#character(action.byte, action.ge ?? false);
      case 'dup': {
        if (this.isLocked) return this.#rejection();
        const r = this.#character(EBC.DUP, false);
        if (r.accepted) this.#screen.cursor = nextUnprotected(this.#screen, this.#screen.cursor);
        return r;
      }
      case 'fieldMark':
        if (this.isLocked) return this.#rejection();
        return this.#character(EBC.FM, false);
      case 'insert':
        this.#insertMode = true;
        return ok();
      case 'toggleInsert':
        this.#insertMode = !this.#insertMode;
        return ok();
      case 'backspace':
      case 'erase':
      case 'delete':
      case 'newline':
        // Not "movement" keys: they don't clear an operator error.
        if (this.isLocked) return this.#rejection();
        return this.#edit(action.type);
      default:
        // Movement and erase keys clear an operator error first (x3270 OERR_CLEAR_OR_ENQ).
        if (this.#inhibit) return rejected(this.#inhibit);
        this.#operatorError = undefined;
        return this.#edit(action.type);
    }
  }

  #edit(
    type: Exclude<
      KeyAction['type'],
      'char' | 'aid' | 'reset' | 'attn' | 'dup' | 'fieldMark' | 'insert' | 'toggleInsert'
    >,
  ): KeyResult {
    const s = this.#screen;
    const size = s.size;
    const c = s.cursor;
    switch (type) {
      case 'tab':
        s.cursor = nextUnprotected(s, c);
        return ok();
      case 'backtab':
        s.cursor = previousUnprotected(s, c);
        return ok();
      case 'home':
        s.cursor = s.isFormatted ? nextUnprotected(s, size - 1) : 0;
        return ok();
      case 'left':
      case 'backspace':
        s.cursor = prevAddress(c, size);
        return ok();
      case 'right':
        s.cursor = nextAddress(c, size);
        return ok();
      case 'up':
        s.cursor = (c - s.cols + size) % size;
        return ok();
      case 'down':
        s.cursor = (c + s.cols) % size;
        return ok();
      case 'newline': {
        const start = Math.floor(((c + s.cols) % size) / s.cols) * s.cols;
        const field = s.fieldAt(start);
        s.cursor =
          field && (field.start === start || field.protected) ? nextUnprotected(s, start) : start;
        return ok();
      }
      case 'delete':
        return this.#delete();
      case 'erase': {
        const field = s.fieldAt(c);
        if (field && field.start === c) return this.#error('protected');
        if (field && c === field.dataStart) return ok(); // at the start of the field
        s.cursor = prevAddress(c, size);
        return this.#delete();
      }
      case 'eraseEof': {
        const field = s.fieldAt(c);
        if (field && (field.protected || field.start === c)) return this.#error('protected');
        let a = c;
        if (field) {
          do {
            s.replaceChar(a, EBC.NULL);
            a = nextAddress(a, size);
          } while (!s.isFieldAttribute(a));
          s.setModified(field.start, true);
        } else {
          do {
            s.replaceChar(a, EBC.NULL);
            a = nextAddress(a, size);
          } while (a !== 0);
        }
        return ok();
      }
      case 'eraseInput':
        eraseAllUnprotected(s);
        return ok();
    }
  }

  #aid(key: Parameters<typeof aidForKey>[0]): KeyResult {
    if (this.isLocked) return this.#rejection();
    const s = this.#screen;
    const aid = aidForKey(key);
    if (key === 'CLEAR') s.clear();
    const data = readModified(s, aid, this.reply ? { reply: this.reply } : {});
    this.#inhibit = 'wait';
    this.#insertMode = false;
    return ok([{ kind: 'record', data }]);
  }

  /** Type one character at the cursor. x3270 key_Character. */
  #character(byte: number, ge: boolean): KeyResult {
    const s = this.#screen;
    const size = s.size;
    let a = s.cursor;
    const field = s.fieldAt(a);

    if (field && (field.start === a || field.protected)) return this.#error('protected');
    if (field?.numeric && this.#options.numericLock && !isNumericInput(byte)) {
      return this.#error('numeric');
    }
    if (this.#insertMode && !this.#makeRoom(a)) return this.#error('overflow');

    const { background } = s.attributesAt(a);
    s.writeChar(a, byte, { background, charset: ge ? APL : 0 });
    a = nextAddress(a, size);

    if (field && this.#options.blankFill) this.#blankFill(a, field.start);
    if (field) s.setModified(field.start, true);

    // Don't land on an attribute; jump over auto-skip fields. (Not for DUP.)
    if (byte !== EBC.DUP) {
      while (s.isFieldAttribute(a)) {
        a = s.fieldAt(a)!.autoskip ? nextUnprotected(s, a) : nextAddress(a, size);
      }
    }
    s.cursor = a;
    return ok();
  }

  /**
   * Insert mode: shift the field right by one from `at`, into the nearest
   * null (or, with blank fill, trailing blanks). x3270 ins_prep.
   */
  #makeRoom(at: number): boolean {
    const s = this.#screen;
    const size = s.size;
    const count = this.#cellsToFieldEnd(at);

    let ntb = 0;
    let shift = -1; // cells to shift right; -1 = no room
    for (let k = 0, a = at; k < count; k++, a = nextAddress(a, size)) {
      const b = s.charAt(a);
      if (b === EBC.NULL) {
        shift = k;
        break;
      }
      ntb = this.#options.blankFill && b === EBC.SPACE ? ntb + 1 : 0;
    }
    if (shift < 0) {
      if (ntb === 0) return false;
      shift = count - 1; // drop the last trailing blank
    }
    // Move cells [at, at+shift) to [at+1, at+shift], working backwards.
    for (let k = shift; k > 0; k--) {
      this.#copyCell((at + k - 1) % size, (at + k) % size);
    }
    return true;
  }

  /** Delete the character at the cursor, shifting the rest of the field left. x3270 do_delete. */
  #delete(): KeyResult {
    const s = this.#screen;
    const size = s.size;
    const c = s.cursor;
    const field = s.fieldAt(c);
    if (field && (field.protected || field.start === c)) return this.#error('protected');

    const count = this.#cellsToFieldEnd(c);
    for (let k = 0; k < count - 1; k++) this.#copyCell((c + k + 1) % size, (c + k) % size);
    // The vacated cell keeps its colour and highlighting (x3270 ctlr_add).
    s.replaceChar((c + count - 1) % size, EBC.NULL);
    if (field) s.setModified(field.start, true);
    return ok();
  }

  /** x3270 blank fill: nulls between the field start and the cursor become blanks. */
  #blankFill(after: number, fieldStart: number): void {
    const s = this.#screen;
    const size = s.size;
    for (let a = prevAddress(after, size); a !== fieldStart; a = prevAddress(a, size)) {
      if (a % s.cols === s.cols - 1) {
        // Don't fill a row that is all nulls back to its start.
        let allNull = true;
        for (let b = a; b !== fieldStart; b = prevAddress(b, size)) {
          if (s.charAt(b) !== EBC.NULL) {
            allNull = false;
            break;
          }
          if (b % s.cols === 0) break;
        }
        if (allNull) break;
      }
      if (s.charAt(a) === EBC.NULL) s.replaceChar(a, EBC.SPACE);
    }
  }

  /**
   * Cells from `at` (inclusive) to the end of its field, or to the end of the
   * buffer when unformatted.
   */
  #cellsToFieldEnd(at: number): number {
    const s = this.#screen;
    if (!s.isFormatted) return s.size - at;
    let n = 1;
    for (let a = nextAddress(at, s.size); !s.isFieldAttribute(a); a = nextAddress(a, s.size)) n++;
    return n;
  }

  #copyCell(from: number, to: number): void {
    const s = this.#screen;
    s.writeChar(to, s.charAt(from), s.attributesAt(from));
  }

  /** Refuse a key whose function isn't available now: the minus-function operator error. */
  minusFunction(): KeyResult {
    let result: KeyResult = { accepted: false, outputs: [] };
    this.#update(() => (result = this.#error('minusFunction')));
    return result;
  }

  #error(error: OperatorError): KeyResult {
    this.#operatorError = error;
    return { accepted: false, error, outputs: [] };
  }

  #rejection(): KeyResult {
    return rejected(this.#inhibit ?? 'operatorError');
  }

  #update(fn: () => void): void {
    const before = `${this.#inhibit}|${this.#operatorError}|${this.#insertMode}`;
    fn();
    if (`${this.#inhibit}|${this.#operatorError}|${this.#insertMode}` !== before) {
      for (const l of this.#listeners) l();
    }
  }
}

function ok(outputs: KeyOutput[] = []): KeyResult {
  return { accepted: true, outputs };
}

function rejected(reason: InhibitReason | 'operatorError'): KeyResult {
  return { accepted: false, rejected: reason, outputs: [] };
}

function isNumericInput(b: number): boolean {
  return (
    (b >= EBC.ZERO && b <= EBC.NINE) ||
    b === EBC.PLUS ||
    b === EBC.MINUS ||
    b === EBC.PERIOD ||
    b === EBC.COMMA
  );
}
