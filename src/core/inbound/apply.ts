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

/**
 * Where the operator typed, when the record can't say: TSO line mode's input
 * field starts just after READY, but the operator types on the next line, so
 * the field is all nulls up to the command. Typing ends at the cursor; if the
 * data fits just before it, in this field, and everything between the field's
 * start and there is empty on the screen, the data was typed there.
 */
function typedBeforeCursor(
  screen: Screen,
  field: { dataStart: number; length: number },
  offset: number,
  length: number,
  cursor: number | undefined,
): number | undefined {
  if (cursor === undefined || cursor >= screen.size) return undefined;
  const cursorOffset = (cursor - field.dataStart + screen.size) % screen.size;
  const start = cursorOffset - length;
  if (cursorOffset > field.length || start <= offset) return undefined;
  for (let i = offset; i < start; i++) {
    if (screen.charAt((field.dataStart + i) % screen.size) !== NULL) return undefined;
  }
  return start;
}

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
    // Read Modified leaves out nulls, so the data's position in the field is
    // lost wherever nulls came before it.
    let offset = (sent.address - field.dataStart + screen.size) % screen.size;
    offset = typedBeforeCursor(screen, field, offset, sent.data.length, record.cursor) ?? offset;
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
