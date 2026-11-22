/** Drive s3270 (the x3270 suite's scripting emulator) as a reference oracle. */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function s3270Available(): boolean {
  try {
    execFileSync('s3270', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class S3270 {
  readonly #proc: ChildProcessWithoutNullStreams;
  #lines: string[] = [];
  #waiters: (() => void)[] = [];
  /** The status line printed with the last action's result. Field 1 is U (unlocked), L (locked) or E (error). */
  status = '';

  constructor(args: string[] = []) {
    this.#proc = spawn('s3270', ['-model', '3278-2', '-xrm', 's3270.blankFill: false', ...args]);
    const rl = createInterface({ input: this.#proc.stdout });
    rl.on('line', (line) => {
      this.#lines.push(line);
      this.#waiters.splice(0).forEach((w) => w());
    });
  }

  /** Run one action; resolves with its data lines. Rejects on "error". */
  async run(action: string): Promise<string[]> {
    this.#proc.stdin.write(action + '\n');
    const data: string[] = [];
    for (;;) {
      const line = await this.#next();
      if (line === 'ok') return data;
      if (line === 'error') throw new Error(`s3270 ${action} failed: ${data.join(' | ')}`);
      if (line.startsWith('data: ')) data.push(line.slice(6));
      else if (line === 'data:') data.push('');
      else this.status = line; // the status line precedes ok/error
    }
  }

  async #next(): Promise<string> {
    while (this.#lines.length === 0) await new Promise<void>((r) => this.#waiters.push(r));
    return this.#lines.shift()!;
  }

  async close(): Promise<void> {
    try {
      await this.run('Quit()');
    } catch {
      /* already gone */
    }
    this.#proc.kill();
  }
}

/** A cell as both emulators can report it: a field attribute or an EBCDIC character. */
export type Cell = { fa: number } | { ch: number };

/** Parse ReadBuffer(Ebcdic) output: one token per cell, "xx" or "SF(c0=xx,...)", plus SA(...) markers. */
export function parseReadBuffer(rows: string[]): Cell[] {
  const cells: Cell[] = [];
  for (const row of rows) {
    for (const tok of row.trim().split(/\s+/)) {
      if (tok === '') continue;
      // SA(...) marks a change of character attributes before the next cell.
      // Character attributes aren't compared yet (Phase 2 renders them).
      if (/^SA\(.*\)$/.test(tok)) continue;
      const sf = /^SF\((.*)\)$/.exec(tok);
      if (sf) {
        const c0 = /(?:^|,)c0=([0-9a-f]{2})/.exec(sf[1]!);
        cells.push({ fa: c0 ? parseInt(c0[1]!, 16) & 0x3d : 0 });
      } else if (/^[0-9a-f]{2}$/.test(tok)) {
        cells.push({ ch: parseInt(tok, 16) });
      } else {
        throw new Error(`unexpected ReadBuffer token "${tok}"`);
      }
    }
  }
  return cells;
}
