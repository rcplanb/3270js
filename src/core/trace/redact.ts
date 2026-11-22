/**
 * Replace the characters an inbound record sends for non-display (hidden)
 * cells with asterisks, so passwords never reach a trace or log. The record's
 * length and structure are unchanged.
 */
import { Order } from '../datastream/orders.js';
import { decodeAddress } from '../screen/index.js';

const ASTERISK = 0x5c; // EBCDIC '*'
const AID_STRUCTURED_FIELD = 0x88;

export function redactInbound(
  record: Uint8Array,
  bufferSize: number,
  isHidden: (address: number) => boolean,
): Uint8Array {
  const out = record.slice();
  // Short reads, structured fields (Query Reply) and malformed records carry no field data.
  if (out.length < 3 || out[0] === AID_STRUCTURED_FIELD) return out;
  let address = 0;
  let i = 3;
  while (i < out.length) {
    const b = out[i]!;
    if (b === Order.SBA && i + 2 < out.length) {
      address = decodeAddress(out[i + 1]!, out[i + 2]!) % bufferSize;
      i += 3;
    } else if (b === Order.SF && i + 1 < out.length) {
      address = (address + 1) % bufferSize;
      i += 2;
    } else {
      if (b === Order.GE && i + 1 < out.length) i++;
      if (isHidden(address)) out[i] = ASTERISK;
      address = (address + 1) % bufferSize;
      i++;
    }
  }
  return out;
}
