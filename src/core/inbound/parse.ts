/**
 * Parse an inbound (terminal → host) record. Used in observer mode, where a
 * passive copy of the terminal (e.g. on a server) follows both directions of a
 * session.
 *
 * Note that Read Modified suppresses nulls, so field data here is what was
 * sent, not necessarily cell-for-cell what was on screen.
 */
import { Order } from '../datastream/orders.js';
import { FieldAttribute, decodeAddress } from '../screen/index.js';
import { isShortReadAid } from './aid.js';

export interface InboundField {
  /** Address of the first byte of `data`. */
  address: number;
  /** Characters as sent (GE prefixes removed). */
  data: Uint8Array;
}

export interface InboundRecord {
  aid: number;
  /** Absent for short reads. */
  cursor?: number;
  fields: InboundField[];
  /** Field attributes found in a Read Buffer reply (meaningful bits only). */
  fieldAttributes: { address: number; attribute: number }[];
  errors: string[];
}

export function parseInbound(record: Uint8Array, bufferSize: number): InboundRecord {
  const result: InboundRecord = { aid: 0, fields: [], fieldAttributes: [], errors: [] };
  if (record.length === 0) {
    result.errors.push('empty record');
    return result;
  }
  result.aid = record[0]!;
  if (record.length === 1 && isShortReadAid(result.aid)) return result;
  if (record.length < 3) {
    result.errors.push('record too short: missing cursor address');
    return result;
  }
  result.cursor = decodeAddress(record[1]!, record[2]!);

  let address = 0;
  let current: number[] | undefined;
  let currentStart = 0;
  const flush = () => {
    if (current) result.fields.push({ address: currentStart, data: Uint8Array.from(current) });
    current = undefined;
  };
  const begin = (a: number) => {
    flush();
    current = [];
    currentStart = a;
    address = a;
  };

  let i = 3;
  while (i < record.length) {
    const b = record[i]!;
    if (b === Order.SBA) {
      if (i + 2 >= record.length) {
        result.errors.push('record too short: missing SBA address');
        break;
      }
      const a = decodeAddress(record[i + 1]!, record[i + 2]!);
      if (a >= bufferSize) {
        result.errors.push(`SBA address ${a} outside buffer of ${bufferSize}`);
        break;
      }
      begin(a);
      i += 3;
    } else if (b === Order.SF) {
      if (i + 1 >= record.length) {
        result.errors.push('record too short: missing SF attribute');
        break;
      }
      flush();
      result.fieldAttributes.push({
        address,
        attribute: record[i + 1]! & FieldAttribute.MEANINGFUL,
      });
      address = (address + 1) % bufferSize;
      i += 2;
    } else {
      let ch = b;
      if (b === Order.GE) {
        if (i + 1 >= record.length) {
          result.errors.push('record too short: missing GE character');
          break;
        }
        ch = record[++i]!;
      }
      if (!current) begin(address);
      current!.push(ch);
      address = (address + 1) % bufferSize;
      i += 1;
    }
  }
  flush();
  return result;
}
