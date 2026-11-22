/**
 * Apply one outbound (host → terminal) 3270 record to a screen.
 *
 * Behaviour follows GA23-0059 and, where the manual leaves room, x3270's
 * ctlr.c, which is the reference our differential tests compare against.
 * DBCS (SO/SI) is not supported.
 */
import {
  AttributeType,
  CharacterSet,
  type CellAttributes,
  type FieldExtendedAttributes,
  type Screen,
  decodeAddress,
  eraseAllUnprotected,
  nextAddress,
  nextUnprotected,
} from '../screen/index.js';
import { commandKind, type CommandKind } from './commands.js';
import { FORMAT_CONTROLS, Order } from './orders.js';
import { decodeWcc } from './wcc.js';

export interface Geometry {
  rows: number;
  cols: number;
}

export interface OutboundGeometry {
  /** Size used by Erase/Write. */
  default: Geometry;
  /** Size used by Erase/Write Alternate. */
  alternate: Geometry;
}

export type ReadType = 'buffer' | 'modified' | 'modifiedAll';

export interface OutboundResult {
  command: CommandKind | undefined;
  /** The keyboard should be unlocked (WCC keyboard restore, or EAU). */
  keyboardRestore: boolean;
  /** The host asked for the alarm to sound. */
  alarm: boolean;
  /** EWA was processed (the screen is now at its alternate size). */
  alternate?: boolean;
  /** The host asked for an inbound read (RB, RM, RMA). */
  read?: ReadType;
  /** WSF payload (after the command byte), not yet interpreted. */
  structuredFields?: Uint8Array;
  /** Problems that stopped processing. Changes made before them are kept. */
  errors: string[];
  /**
   * How a real terminal would report the first error: an invalid buffer
   * address is an operation check, anything else a command reject. TN3270E
   * sends this as a negative response (RFC 2355 §10.4.1).
   */
  sense?: 'commandReject' | 'operationCheck';
  /** Problems that were skipped over. */
  warnings: string[];
}

class AbortWrite extends Error {
  constructor(
    message: string,
    readonly sense: 'commandReject' | 'operationCheck' = 'commandReject',
  ) {
    super(message);
  }
}

export interface OutboundOptions {
  /**
   * A 3279 (colour) terminal. A 3278 ignores host colours, as the hardware
   * does and as x3270 does in 3278 mode. Default true.
   */
  color?: boolean;
}

export function processOutbound(
  screen: Screen,
  record: Uint8Array,
  geometry: OutboundGeometry,
  options: OutboundOptions = {},
): OutboundResult {
  const result: OutboundResult = {
    command: undefined,
    keyboardRestore: false,
    alarm: false,
    errors: [],
    warnings: [],
  };
  if (record.length === 0) {
    result.errors.push('empty record');
    result.sense = 'commandReject';
    return result;
  }
  const kind = commandKind(record[0]!);
  result.command = kind;
  switch (kind) {
    case undefined:
      result.errors.push(`unknown command X'${hex(record[0]!)}'`);
      result.sense = 'commandReject';
      break;
    case 'EW':
    case 'EWA': {
      const alt = kind === 'EWA';
      const size = alt ? geometry.alternate : geometry.default;
      if (screen.rows !== size.rows || screen.cols !== size.cols) {
        screen.resize(size.rows, size.cols);
      } else {
        screen.clear();
      }
      if (alt) result.alternate = true;
      write(screen, record, result, options.color ?? true);
      break;
    }
    case 'W':
      write(screen, record, result, options.color ?? true);
      break;
    case 'EAU':
      eraseAllUnprotected(screen);
      result.keyboardRestore = true;
      break;
    case 'RB':
      result.read = 'buffer';
      break;
    case 'RM':
      result.read = 'modified';
      break;
    case 'RMA':
      result.read = 'modifiedAll';
      break;
    case 'WSF':
      result.structuredFields = record.subarray(1);
      break;
    case 'NOP':
      break;
  }
  return result;
}

/** Write, Erase/Write, Erase/Write Alternate: WCC then orders and data. */
function write(screen: Screen, rec: Uint8Array, result: OutboundResult, color: boolean): void {
  /**
   * The value to store for an extended attribute, or undefined to ignore it:
   * colours on a 3278, and colour values outside X'F0'-X'FF' become default
   * (x3270 ctlr_add_fg/bg).
   */
  const attrValue = (key: string, value: number): number | undefined => {
    if (key !== 'foreground' && key !== 'background') return value;
    if (!color) return undefined;
    return (value & 0xf0) === 0xf0 ? value : 0;
  };
  if (rec.length < 2) {
    result.errors.push('record too short: missing WCC');
    result.sense = 'commandReject';
    return;
  }
  const wcc = decodeWcc(rec[1]!);
  if (wcc.resetMdt) screen.resetModified();

  const size = screen.size;
  let addr = screen.cursor;
  /** Character attributes set by SA; apply to following characters. */
  let sa: CellAttributes = {
    foreground: 0,
    background: 0,
    highlighting: 0,
    charset: 0,
    transparency: 0,
  };
  let insertCursor: number | undefined;
  /** The previous item was a command or order (not data): decides PT nulling. */
  let lastCmd = true;
  /** The previous item was a nulling PT that left the address at 0. */
  let lastZpt = false;

  /** Read `n` bytes after position `i`, or abort if the record is too short. */
  const need = (i: number, n: number, what: string): void => {
    if (i + n >= rec.length) throw new AbortWrite(`record too short: missing ${what}`);
  };
  const address = (i: number, order: string): number => {
    need(i, 2, `${order} address`);
    const a = decodeAddress(rec[i + 1]!, rec[i + 2]!);
    if (a >= size)
      throw new AbortWrite(`${order} address ${a} > maximum ${size - 1}`, 'operationCheck');
    return a;
  };
  const isProtectedAt = (a: number): boolean => screen.fieldAt(a)?.protected ?? false;

  let i = 2;
  try {
    while (i < rec.length) {
      const b = rec[i]!;
      switch (b) {
        case Order.SF:
          need(i, 1, 'SF attribute');
          screen.startField(addr, rec[i + 1]!);
          addr = nextAddress(addr, size);
          i += 2;
          lastCmd = true;
          lastZpt = false;
          break;

        case Order.SBA:
          addr = address(i, 'SBA');
          i += 3;
          lastCmd = true;
          lastZpt = false;
          break;

        case Order.IC:
          insertCursor = addr;
          i += 1;
          lastCmd = true;
          lastZpt = false;
          break;

        case Order.PT: {
          i += 1;
          // On an unprotected field attribute: just step into the field.
          const fa = screen.fieldAttributeAt(addr);
          if (fa !== undefined && !screen.fieldAt(addr)!.protected) {
            addr = nextAddress(addr, size);
            lastCmd = true;
            lastZpt = false;
            break;
          }
          let target = nextUnprotected(screen, addr);
          if (target < addr) target = 0; // the search wrapped: stop at 0
          if (!lastCmd || lastZpt) {
            // PT after data nulls the rest of the current field.
            while (addr !== target && !screen.isFieldAttribute(addr)) {
              screen.writeChar(addr, 0x00);
              addr = nextAddress(addr, size);
            }
            lastZpt = target === 0;
          } else {
            lastZpt = false;
          }
          addr = target;
          lastCmd = true;
          break;
        }

        case Order.RA: {
          const to = address(i, 'RA');
          need(i, 3, 'RA character');
          let ch = rec[i + 3]!;
          let attrs = sa;
          let len = 4;
          if (ch === Order.GE) {
            need(i, 4, 'RA graphic escape character');
            ch = rec[i + 4]!;
            attrs = { ...sa, charset: CharacterSet.APL };
            len = 5;
          }
          do {
            screen.writeChar(addr, ch, attrs);
            addr = nextAddress(addr, size);
          } while (addr !== to);
          i += len;
          lastCmd = true;
          lastZpt = false;
          break;
        }

        case Order.EUA: {
          const to = address(i, 'EUA');
          let prot = isProtectedAt(addr);
          do {
            const fa = screen.fieldAttributeAt(addr);
            if (fa !== undefined) prot = screen.fieldAt(addr)!.protected;
            else if (!prot) screen.replaceChar(addr, 0x00);
            addr = nextAddress(addr, size);
          } while (addr !== to);
          i += 3;
          lastCmd = true;
          lastZpt = false;
          break;
        }

        case Order.GE:
          need(i, 1, 'GE character');
          screen.writeChar(addr, rec[i + 1]!, { ...sa, charset: CharacterSet.APL });
          addr = nextAddress(addr, size);
          i += 2;
          lastCmd = false;
          lastZpt = false;
          break;

        case Order.SA: {
          need(i, 2, 'SA attribute');
          const type = rec[i + 1]!;
          const value = rec[i + 2]!;
          if (type === AttributeType.ALL) {
            sa = { foreground: 0, background: 0, highlighting: 0, charset: 0, transparency: 0 };
          } else {
            const key = CHAR_ATTRIBUTE_KEYS.get(type);
            const v = key && attrValue(key, value);
            if (key && v !== undefined) sa = { ...sa, [key]: v };
          }
          i += 3;
          lastCmd = true;
          lastZpt = false;
          break;
        }

        case Order.SFE: {
          const pairs = readPairs(rec, i, 'SFE');
          let attribute = 0;
          const ext: Partial<FieldExtendedAttributes> = {};
          for (const [type, value] of pairs) {
            if (type === AttributeType.FIELD_ATTRIBUTE) attribute = value;
            else {
              const key = FIELD_ATTRIBUTE_KEYS.get(type);
              const v = key && attrValue(key, value);
              if (key && v !== undefined) ext[key] = v;
            }
          }
          screen.startField(addr, attribute, ext);
          addr = nextAddress(addr, size);
          i += 2 + pairs.length * 2;
          lastCmd = true;
          lastZpt = false;
          break;
        }

        case Order.MF: {
          const pairs = readPairs(rec, i, 'MF');
          if (screen.isFieldAttribute(addr)) {
            const changes: Partial<FieldExtendedAttributes> & { attribute?: number } = {};
            for (const [type, value] of pairs) {
              if (type === AttributeType.FIELD_ATTRIBUTE) changes.attribute = value;
              else {
                const key = FIELD_ATTRIBUTE_KEYS.get(type);
                const v = key && attrValue(key, value);
                if (key && v !== undefined) changes[key] = v;
              }
            }
            screen.modifyField(addr, changes);
            addr = nextAddress(addr, size);
          }
          i += 2 + pairs.length * 2;
          lastCmd = true;
          lastZpt = false;
          break;
        }

        default:
          if (b === 0x00) {
            screen.writeChar(addr, b, sa);
            addr = nextAddress(addr, size);
            lastCmd = false;
          } else if (FORMAT_CONTROLS.has(b)) {
            screen.writeChar(addr, b, sa);
            addr = nextAddress(addr, size);
            lastCmd = true;
          } else if (b <= 0x3f) {
            result.warnings.push(`unsupported order X'${hex(b)}' skipped`);
            lastCmd = true;
          } else {
            screen.writeChar(addr, b, sa);
            addr = nextAddress(addr, size);
            lastCmd = false;
          }
          lastZpt = false;
          i += 1;
      }
    }
  } catch (e) {
    if (!(e instanceof AbortWrite)) throw e;
    result.errors.push(e.message);
    result.sense ??= e.sense;
  }

  // These apply even after an aborted write, as on a real terminal.
  if (insertCursor !== undefined) screen.cursor = insertCursor;
  result.keyboardRestore = wcc.keyboardRestore;
  result.alarm = wcc.soundAlarm;
}

/** Read the count byte and (type, value) pairs of an SFE or MF order at `i`. */
function readPairs(rec: Uint8Array, i: number, order: string): [number, number][] {
  if (i + 1 >= rec.length) throw new AbortWrite(`record too short: missing ${order} count`);
  const count = rec[i + 1]!;
  const pairs: [number, number][] = [];
  for (let p = 0; p < count; p++) {
    const at = i + 2 + p * 2;
    if (at + 1 >= rec.length) throw new AbortWrite(`record too short: missing ${order} attribute`);
    pairs.push([rec[at]!, rec[at + 1]!]);
  }
  return pairs;
}

const CHAR_ATTRIBUTE_KEYS = new Map<number, keyof CellAttributes>([
  [AttributeType.FOREGROUND, 'foreground'],
  [AttributeType.BACKGROUND, 'background'],
  [AttributeType.HIGHLIGHTING, 'highlighting'],
  [AttributeType.CHARSET, 'charset'],
  [AttributeType.TRANSPARENCY, 'transparency'],
]);

const FIELD_ATTRIBUTE_KEYS = new Map<number, keyof FieldExtendedAttributes>([
  ...CHAR_ATTRIBUTE_KEYS,
  [AttributeType.VALIDATION, 'validation'],
  [AttributeType.OUTLINING, 'outlining'],
]);

function hex(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}
