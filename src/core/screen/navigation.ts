/** Field navigation and erase helpers shared by the data stream and keyboard. */
import { nextAddress, prevAddress } from './address.js';
import type { Screen } from './screen.js';

/**
 * The first data position of the next unprotected field after `from`,
 * searching forward and wrapping; 0 if there is none. Zero-length fields are
 * skipped. GA23-0059 §4.3.5 (Program Tab) and the Tab key.
 */
export function nextUnprotected(screen: Screen, from: number): number {
  const size = screen.size;
  let a = from;
  do {
    const n = nextAddress(a, size);
    if (isUnprotectedFieldStart(screen, a, n)) return n;
    a = n;
  } while (a !== from);
  return 0;
}

/**
 * The first data position of the unprotected field before the cursor (or of
 * the current field if the cursor is past its start); 0 if there is none.
 * The Backtab key.
 */
export function previousUnprotected(screen: Screen, from: number): number {
  const size = screen.size;
  let a = prevAddress(from, size);
  if (screen.isFieldAttribute(a)) a = prevAddress(a, size); // at start of field
  const stop = a;
  for (;;) {
    if (isUnprotectedFieldStart(screen, a, nextAddress(a, size))) return nextAddress(a, size);
    a = prevAddress(a, size);
    if (a === stop) return 0;
  }
}

function isUnprotectedFieldStart(screen: Screen, fa: number, next: number): boolean {
  return (
    screen.isFieldAttribute(fa) && !screen.fieldAt(fa)!.protected && !screen.isFieldAttribute(next)
  );
}

/**
 * Null every unprotected field, clear their MDTs and put the cursor at the
 * first one (or 0). On an unformatted screen, clear it. Used by the EAU
 * command and the Erase Input key.
 */
export function eraseAllUnprotected(screen: Screen): void {
  if (!screen.isFormatted) {
    screen.clear();
    return;
  }
  let cursor: number | undefined;
  for (const field of screen.fields) {
    if (field.protected) continue;
    screen.setModified(field.start, false);
    cursor ??= field.dataStart;
    for (let k = 0, a = field.dataStart; k < field.length; k++, a = nextAddress(a, screen.size)) {
      screen.replaceChar(a, 0x00);
    }
  }
  screen.cursor = cursor ?? 0;
}
