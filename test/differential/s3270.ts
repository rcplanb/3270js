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

  constructor(args: string[] = [], model = '3278-2') {
    this.#proc = spawn('s3270', ['-model', model, '-xrm', 's3270.blankFill: false', ...args]);
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

  /** Stop at once, without waiting for actions in progress. */
  kill(): void {
    this.#proc.kill();
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

/**
 * Extended attributes as x3270's ReadBuffer reports them: colours raw (0 =
 * default), highlighting OR'd with F0 (0 = none), character set F1 for APL/GE
 * and 0 otherwise (x3270 treats line-draw as the base set).
 */
export interface Attrs {
  fg: number;
  bg: number;
  hl: number;
  cs: number;
}

/** A cell as both emulators can report it: a field attribute or an EBCDIC character, with attributes. */
export type Cell = ({ fa: number } | { ch: number }) & Attrs;

export const normHighlight = (h: number) => (h === 0 || h === 0xf0 ? 0 : h | 0xf0);
export const normCharset = (c: number) => (c === 0xf1 ? 0xf1 : 0);

/**
 * Parse ReadBuffer(Ebcdic) output (x3270 task.c): one token per cell, "xx",
 * "GE(xx)" or "SF(c0=xx,42=..,45=..,41=..,43=..)", plus "SA(...)" markers that
 * change the running character attributes before the next cell.
 */
export function parseReadBuffer(rows: string[]): Cell[] {
  const cells: Cell[] = [];
  const current: Attrs = { fg: 0, bg: 0, hl: 0, cs: 0 };
  const pairs = (body: string) =>
    new Map(
      body.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k!, parseInt(v!, 16)] as const;
      }),
    );
  for (const row of rows) {
    for (const tok of row.trim().split(/\s+/)) {
      if (tok === '') continue;
      const sa = /^SA\((.*)\)$/.exec(tok);
      if (sa) {
        const m = pairs(sa[1]!);
        if (m.has('42')) current.fg = m.get('42')!;
        if (m.has('45')) current.bg = m.get('45')!;
        if (m.has('41')) current.hl = normHighlight(m.get('41')!);
        if (m.has('43')) current.cs = normCharset(m.get('43')!);
        continue;
      }
      const sf = /^SF\((.*)\)$/.exec(tok);
      const ge = /^GE\(([0-9a-f]{2})\)$/.exec(tok);
      if (sf) {
        const m = pairs(sf[1]!);
        cells.push({
          fa: (m.get('c0') ?? 0) & 0x3d,
          fg: m.get('42') ?? 0,
          bg: m.get('45') ?? 0,
          hl: normHighlight(m.get('41') ?? 0),
          cs: normCharset(m.get('43') ?? 0),
        });
      } else if (ge) {
        cells.push({ ch: parseInt(ge[1]!, 16), ...current, cs: 0xf1 });
      } else if (/^[0-9a-f]{2}$/.test(tok)) {
        cells.push({ ch: parseInt(tok, 16), ...current });
      } else {
        throw new Error(`unexpected ReadBuffer token "${tok}"`);
      }
    }
  }
  return cells;
}
