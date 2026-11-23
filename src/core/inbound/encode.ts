/**
 * Encode an inbound (terminal → host) record: the inverse of parseInbound for
 * Read Modified replies. Used by a server that acts on a session it observes:
 * to add a field to what the operator sent, or to send a key of its own.
 *
 * Field data is sent as given: characters that need Graphic Escape (APL, line
 * drawing) are not supported here. Read Buffer layouts (field attributes) are
 * not encoded.
 */
import { Order } from '../datastream/orders.js';
import { addressModeFor, encodeAddress } from '../screen/index.js';
import { isShortReadAid } from './aid.js';
import type { InboundField } from './parse.js';

export interface InboundInput {
  aid: number;
  /** The cursor address. Omitted (and ignored) for short reads: PA keys and Clear. */
  cursor?: number;
  /** Each field: SBA to `address`, then `data`. */
  fields?: readonly InboundField[];
}

export function encodeInbound(input: InboundInput, bufferSize: number): Uint8Array {
  const out: number[] = [input.aid];
  if (isShortReadAid(input.aid)) return Uint8Array.from(out);
  if (input.cursor === undefined) throw new Error('an inbound record needs a cursor address');
  const mode = addressModeFor(bufferSize);
  out.push(...encodeAddress(input.cursor, mode));
  for (const f of input.fields ?? []) {
    out.push(Order.SBA, ...encodeAddress(f.address, mode), ...f.data);
  }
  return Uint8Array.from(out);
}
