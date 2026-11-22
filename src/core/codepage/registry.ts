import type { CodePage } from './codepage.js';
import { cp037 } from './cp037.js';
import { cp1047 } from './cp1047.js';
import { cp1140 } from './cp1140.js';
import { cp285 } from './cp285.js';
import { cp500 } from './cp500.js';

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

for (const cp of [cp037, cp1047, cp500, cp285, cp1140]) registerCodePage(cp);
