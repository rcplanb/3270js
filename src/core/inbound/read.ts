/**
 * Inbound (terminal → host) records: Read Modified, Read Modified All and Read
 * Buffer. GA23-0059 §3.6 and §6.1 (reply modes), following x3270 (ctlr.c):
 * - field mode (the default): fields as SF, characters only;
 * - extended-field mode: Read Buffer sends fields as SFE with their colour,
 *   background, highlighting and character set;
 * - character mode: as extended-field, plus SA orders before characters whose
 *   attributes (of the types the host listed in Set Reply Mode) change.
 * APL/GE characters are preceded by GE in every mode.
 */
import { Order } from '../datastream/orders.js';
import {
  ADDRESS_CODES,
  CharacterSet,
  type Screen,
  addressModeFor,
  encodeAddress,
  nextAddress,
} from '../screen/index.js';
import { Aid, isShortReadAid } from './aid.js';

/** Set Reply Mode modes (WSF X'09'). */
export type ReplyMode = 'field' | 'extendedField' | 'character';

export interface ReplyModeState {
  mode: ReplyMode;
  /**
   * Character mode: the attribute types to report with SA (X'41' highlighting,
   * X'42' foreground, X'43' character set, X'45' background).
   */
  attributes?: readonly number[];
}

export interface ReadModifiedOptions {
  /** Read Modified All: send data even for PA keys and Clear. */
  all?: boolean;
  /** The reply mode set by the host; field mode if absent. */
  reply?: ReplyModeState;
}

/** SYSREQ test request header: SOH % / STX. */
const TEST_REQUEST = [0x01, 0x6c, 0x61, 0x02];

const XA = { HIGHLIGHTING: 0x41, FOREGROUND: 0x42, CHARSET: 0x43, BACKGROUND: 0x45 } as const;
const highlightValue = (h: number) => (h === 0 || h === 0xf0 ? 0 : h | 0xf0);
const charsetValue = (c: number) => (c === CharacterSet.APL ? 0xf1 : 0);

interface Attrs {
  fg: number;
  bg: number;
  hl: number;
  cs: number;
}

function cellAttrs(screen: Screen, address: number): Attrs {
  const x = screen.attributesAt(address);
  return { fg: x.foreground, bg: x.background, hl: x.highlighting, cs: x.charset };
}

/**
 * Character reply mode: SA orders for the requested attribute types whose
 * value differs from the last one sent (x3270 insert_sa). Other modes: none.
 */
class SaTracker {
  readonly #prev = new Map<number, number>();
  constructor(readonly reply: ReplyModeState | undefined) {}

  emit(out: number[], a: Attrs): void {
    if (this.reply?.mode !== 'character') return;
    const wanted = this.reply.attributes ?? [];
    const values: [number, number][] = [
      [XA.FOREGROUND, a.fg],
      [XA.BACKGROUND, a.bg],
      [XA.HIGHLIGHTING, highlightValue(a.hl)],
      [XA.CHARSET, charsetValue(a.cs)],
    ];
    for (const [type, value] of values) {
      if (!wanted.includes(type) || (this.#prev.get(type) ?? 0) === value) continue;
      this.#prev.set(type, value);
      out.push(Order.SA, type, value);
    }
  }
}

export function readModified(
  screen: Screen,
  aid: number,
  options: ReadModifiedOptions = {},
): Uint8Array {
  const out: number[] = [];
  const mode = addressModeFor(screen.size);

  if (aid === Aid.SYSREQ) {
    out.push(...TEST_REQUEST);
  } else {
    out.push(aid);
    if (isShortReadAid(aid) && !options.all) return Uint8Array.from(out);
    out.push(...encodeAddress(screen.cursor, mode));
  }

  const sa = new SaTracker(options.reply);
  if (!screen.isFormatted) {
    for (let a = 0; a < screen.size; a++) {
      if (screen.charAt(a) !== 0) sa.emit(out, cellAttrs(screen, a));
      pushChar(screen, a, out, false);
    }
    return Uint8Array.from(out);
  }

  for (const field of screen.fields) {
    if (!field.modified) continue;
    out.push(Order.SBA, ...encodeAddress(field.dataStart, mode));
    const aplField = field.charset === CharacterSet.APL;
    // A character without its own attribute value reports the field's.
    const f = cellAttrs(screen, field.start);
    for (let k = 0, a = field.dataStart; k < field.length; k++, a = nextAddress(a, screen.size)) {
      if (screen.charAt(a) !== 0) {
        const c = cellAttrs(screen, a);
        sa.emit(out, { fg: c.fg || f.fg, bg: c.bg || f.bg, hl: c.hl || f.hl, cs: c.cs || f.cs });
      }
      pushChar(screen, a, out, aplField);
    }
  }
  return Uint8Array.from(out);
}

export function readBuffer(screen: Screen, aid: number, reply?: ReplyModeState): Uint8Array {
  const out: number[] = [aid, ...encodeAddress(screen.cursor, addressModeFor(screen.size))];
  const sa = new SaTracker(reply);
  const extended = reply !== undefined && reply.mode !== 'field';
  for (let a = 0; a < screen.size; a++) {
    const fa = screen.fieldAttributeAt(a);
    if (fa === undefined) {
      sa.emit(out, cellAttrs(screen, a));
      const aplField = screen.fieldAt(a)?.charset === CharacterSet.APL;
      pushChar(screen, a, out, aplField, true);
    } else if (!extended) {
      out.push(Order.SF, ADDRESS_CODES[fa & 0x3f]!);
    } else {
      // SFE: the 3270 attribute, then whichever extended attributes are set.
      const x = cellAttrs(screen, a);
      const pairs: number[] = [0xc0, ADDRESS_CODES[fa & 0x3f]!];
      if (x.fg) pairs.push(XA.FOREGROUND, x.fg);
      if (x.bg) pairs.push(XA.BACKGROUND, x.bg);
      if (highlightValue(x.hl)) pairs.push(XA.HIGHLIGHTING, highlightValue(x.hl));
      if (charsetValue(x.cs)) pairs.push(XA.CHARSET, charsetValue(x.cs));
      out.push(Order.SFE, pairs.length / 2, ...pairs);
    }
  }
  return Uint8Array.from(out);
}

function pushChar(
  screen: Screen,
  address: number,
  out: number[],
  aplField: boolean,
  includeNulls = false,
): void {
  const b = screen.charAt(address);
  if (b === 0 && !includeNulls) return;
  const cs = screen.attributesAt(address).charset;
  if (cs === CharacterSet.APL || (cs === 0 && aplField)) out.push(Order.GE);
  out.push(b);
}
