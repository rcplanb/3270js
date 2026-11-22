import type { CodePage } from './codepage.js';
import { cp037 } from './cp037.js';

const byName = new Map<string, CodePage>();

/** Make a code page available to `getCodePage` under its id and aliases. */
export function registerCodePage(cp: CodePage): void {
  const names = [cp.id, ...cp.aliases];
  for (const n of names) {
    if (byName.has(n)) throw new Error(`code page name "${n}" is already registered`);
  }
  for (const n of names) byName.set(n, cp);
}

/** Look up a code page by id or alias, case-insensitively. */
export function getCodePage(name: string): CodePage | undefined {
  return byName.get(name.toLowerCase());
}

/** Canonical ids of all registered code pages. */
export function listCodePages(): string[] {
  return [...new Set([...byName.values()].map((cp) => cp.id))];
}

registerCodePage(cp037);
