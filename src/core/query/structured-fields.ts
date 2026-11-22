/**
 * Structured fields (WSF payloads). GA23-0059 §5.1: each field is a 2-byte
 * length (including itself; 0 means "the rest of the record"), a 1-byte ID,
 * then data.
 */
export const StructuredFieldId = {
  READ_PARTITION: 0x01,
  ERASE_RESET: 0x03,
  SET_REPLY_MODE: 0x09,
  OUTBOUND_3270DS: 0x40,
} as const;

/** Read Partition types. GA23-0059 §5.11. */
export const ReadPartitionType = {
  QUERY: 0x02,
  QUERY_LIST: 0x03,
  READ_MODIFIED_ALL: 0x6e,
  READ_BUFFER: 0xf2,
  READ_MODIFIED: 0xf6,
} as const;

/** Set Reply Mode modes. GA23-0059 §5.31. */
export const ReplyModeCode = {
  FIELD: 0x00,
  EXTENDED_FIELD: 0x01,
  CHARACTER: 0x02,
} as const;

/** Query List request types. GA23-0059 §5.11. */
export const QueryListType = {
  LIST: 0x00,
  EQUIVALENT: 0x40,
  ALL: 0x80,
} as const;

export interface StructuredField {
  id: number;
  data: Uint8Array;
}

export function parseStructuredFields(payload: Uint8Array): {
  fields: StructuredField[];
  errors: string[];
} {
  const fields: StructuredField[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < payload.length) {
    if (i + 2 > payload.length) {
      errors.push('structured field length truncated');
      break;
    }
    let len = (payload[i]! << 8) | payload[i + 1]!;
    if (len === 0) len = payload.length - i;
    if (len < 3 || i + len > payload.length) {
      errors.push(`bad structured field length ${len}`);
      break;
    }
    fields.push({ id: payload[i + 2]!, data: payload.subarray(i + 3, i + len) });
    i += len;
  }
  return { fields, errors };
}
