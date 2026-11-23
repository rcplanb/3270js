/**
 * Put what the terminal sent back on a screen. A 3270's screen shows what the
 * operator typed until the host writes over it; a copy of the session built
 * only from the host's records (an observer, a replay, a cast) would show
 * blanks there instead. The record's field data says what each modified
 * field held when the AID key was pressed.
 *
 * Only unprotected, displayed fields of a formatted screen are written:
 * non-display (password) fields stay as they were, and a trace's records hold
 * only asterisks for them anyway.
 */
import type { Screen } from '../screen/index.js';
import { Aid } from './aid.js';
import type { InboundRecord } from './parse.js';

const NULL = 0x00;
/** Replies the host asked for: not the operator's input. */
const HOST_REQUESTED = new Set<number>([Aid.NONE, Aid.QUERY_REPLY, Aid.STRUCTURED_FIELD]);

/** Is this record an operator's key (Enter, PF3, ...), not a reply the host asked for? */
export function isOperatorInput(record: InboundRecord): boolean {
  return record.errors.length === 0 && !HOST_REQUESTED.has(record.aid);
}

/**
 * Write the record's fields onto `screen`, and move the cursor to where the
 * operator left it. Returns whether the screen changed.
 */
export function applyInbound(screen: Screen, record: InboundRecord): boolean {
  if (!isOperatorInput(record) || !screen.isFormatted) return false;
  let changed = false;
  for (const sent of record.fields) {
    const field = screen.fieldAt(sent.address);
    if (!field || field.protected || field.display === 'hidden' || field.length === 0) continue;
    // Read Modified leaves out nulls, so the data runs from the field's first
    // character; what follows it in the field was empty.
    const offset = (sent.address - field.dataStart + screen.size) % screen.size;
    for (let i = offset; i < field.length; i++) {
      const address = (field.dataStart + i) % screen.size;
      const byte = i - offset < sent.data.length ? sent.data[i - offset]! : NULL;
      if (screen.charAt(address) !== byte) {
        screen.replaceChar(address, byte);
        changed = true;
      }
    }
  }
  if (
    record.cursor !== undefined &&
    record.cursor < screen.size &&
    screen.cursor !== record.cursor
  ) {
    screen.cursor = record.cursor;
    changed = true;
  }
  return changed;
}
