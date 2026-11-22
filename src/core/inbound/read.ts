/**
 * Inbound (terminal → host) records: Read Modified, Read Modified All and Read
 * Buffer. GA23-0059 §3.6. Field reply mode only (character reply mode, which
 * adds SA orders, is Phase 2).
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

export interface ReadModifiedOptions {
  /** Read Modified All: send data even for PA keys and Clear. */
  all?: boolean;
}

/** SYSREQ test request header: SOH % / STX. */
const TEST_REQUEST = [0x01, 0x6c, 0x61, 0x02];

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

  if (!screen.isFormatted) {
    for (let a = 0; a < screen.size; a++) pushChar(screen, a, out, false);
    return Uint8Array.from(out);
  }

  for (const field of screen.fields) {
    if (!field.modified) continue;
    out.push(Order.SBA, ...encodeAddress(field.dataStart, mode));
    const aplField = field.charset === CharacterSet.APL;
    for (let k = 0, a = field.dataStart; k < field.length; k++, a = nextAddress(a, screen.size)) {
      pushChar(screen, a, out, aplField);
    }
  }
  return Uint8Array.from(out);
}

export function readBuffer(screen: Screen, aid: number): Uint8Array {
  const out: number[] = [aid, ...encodeAddress(screen.cursor, addressModeFor(screen.size))];
  for (let a = 0; a < screen.size; a++) {
    const fa = screen.fieldAttributeAt(a);
    if (fa !== undefined) {
      out.push(Order.SF, ADDRESS_CODES[fa & 0x3f]!);
    } else {
      const aplField = screen.fieldAt(a)?.charset === CharacterSet.APL;
      pushChar(screen, a, out, aplField, true);
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
