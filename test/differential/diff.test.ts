/**
 * Differential tests: the same host bytes and the same keystrokes go to 3270js
 * and to s3270 (x3270's scripting emulator); the screen buffers must match
 * cell for cell (characters and field attributes), as must the cursor and the
 * keyboard lock state. Skipped with a warning when s3270 is not installed.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyAction } from '../../src/core/keyboard/index.js';
import { Terminal } from '../../src/core/terminal.js';
import type { Trace } from '../../src/core/trace/index.js';
import { FakeHost } from '../helpers/fake-host.js';
import { ReplayHost, hostSteps } from './replay-host.js';
import { type Cell, S3270, parseReadBuffer, s3270Available } from './s3270.js';

const available = s3270Available();
if (!available) console.warn('s3270 not found: differential tests skipped (brew install x3270)');

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../traces/tk5/${name}.json`, import.meta.url), 'utf8')) as Trace;

/** Both emulators, connected to the same recorded host. */
async function pair(trace: Trace) {
  const steps = hostSteps(trace);
  const host = new ReplayHost(steps.prelude);
  await host.listen();
  const s3 = new S3270();
  // s3270 completes Connect() only after the host's first write, so don't wait here.
  const s3connected = s3.run(`Connect(127.0.0.1:${host.port})`);

  const term = new Terminal();
  const fake = new FakeHost();
  const ready = term.connect(fake);
  fake.write(steps.prelude);
  await ready;

  const close = async () => {
    await s3.close();
    await host.close();
    term.disconnect();
  };
  return { steps, host, s3, s3connected, term, fake, close };
}

function ourCells(term: Terminal): Cell[] {
  const s = term.screen;
  const cells: Cell[] = [];
  for (let a = 0; a < s.size; a++) {
    const fa = s.fieldAttributeAt(a);
    cells.push(fa === undefined ? { ch: s.charAt(a) } : { fa });
  }
  return cells;
}

/** s3270's status line reports only L (locked, for any reason) or U (x3270 task.c). */
const ourLock = (term: Terminal) => (term.keyboard.isLocked ? 'L' : 'U');

interface Diff {
  where: string;
  problems: string[];
}

async function compare(
  term: Terminal,
  s3: S3270,
  where: string,
  wait = false,
): Promise<Diff | undefined> {
  const deadline = Date.now() + (wait ? 3000 : 0);
  let problems: string[] = [];
  do {
    const theirs = parseReadBuffer(await s3.run('ReadBuffer(Ebcdic)'));
    const [row, col] = (await s3.run('Query(Cursor)'))[0]!.trim().split(/\s+/).map(Number);
    const mine = ourCells(term);
    problems = [];
    if (theirs.length !== mine.length)
      problems.push(`buffer size ${mine.length} vs s3270 ${theirs.length}`);
    for (let a = 0; a < mine.length && problems.length < 8; a++) {
      if (JSON.stringify(mine[a]) !== JSON.stringify(theirs[a])) {
        problems.push(
          `(${Math.floor(a / 80)},${a % 80}) ours ${JSON.stringify(mine[a])} s3270 ${JSON.stringify(theirs[a])}`,
        );
      }
    }
    const cursor = row! * 80 + col!;
    if (term.screen.cursor !== cursor)
      problems.push(`cursor ours ${term.screen.cursor} s3270 ${cursor}`);
    if (problems.length === 0) return undefined;
    if (wait) await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
  return { where, problems };
}

const traces = ['tso-logon', 'ispf-tour'];

describe.skipIf(!available)('differential: host writes (3270js vs s3270)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  for (const name of traces) {
    it(`${name}: every screen matches s3270`, async () => {
      const p = await pair(load(name));
      cleanups.push(p.close);
      const diffs: Diff[] = [];
      let compared = 0;
      for (let i = 0; i < p.steps.records.length; i++) {
        await p.host.send(p.steps.records[i]!);
        p.fake.write(p.steps.records[i]!);
        await p.s3connected;
        const d = await compare(
          p.term,
          p.s3,
          `${name} record ${i} (${p.steps.hex[i]!.slice(0, 4)})`,
          true,
        );
        if (d) diffs.push(d);
        compared++;
      }
      expect(diffs).toEqual([]);
      expect(compared).toBeGreaterThan(15);
    });
  }
});

/** A keystroke for both emulators: our action and the s3270 action. */
type Step = [
  KeyAction | { type: 'moveCursor'; row: number; col: number } | { type: 'string'; text: string },
  string,
];

const K = (type: Exclude<KeyAction['type'], 'char' | 'aid'>, s3: string): Step => [{ type }, s3];
const S = (text: string): Step => [{ type: 'string', text }, `String("${text}")`];
const M = (row: number, col: number): Step => [
  { type: 'moveCursor', row, col },
  `MoveCursor(${row},${col})`,
];

/** Each error-prone key is followed by Reset, as x3270 queues typing while locked. */
const SCRIPT: Step[] = [
  S('HERC'),
  K('left', 'Left()'),
  K('left', 'Left()'),
  K('delete', 'Delete()'),
  S('X'),
  K('right', 'Right()'),
  K('erase', 'Erase()'),
  K('backspace', 'BackSpace()'),
  K('insert', 'Insert()'),
  S('Q'),
  K('reset', 'Reset()'),
  K('home', 'Home()'),
  K('eraseEof', 'EraseEOF()'),
  S('AB'),
  K('tab', 'Tab()'),
  K('backtab', 'BackTab()'),
  K('backtab', 'BackTab()'),
  K('newline', 'Newline()'),
  K('up', 'Up()'),
  K('down', 'Down()'),
  K('dup', 'Dup()'),
  K('reset', 'Reset()'),
  K('fieldMark', 'FieldMark()'),
  K('reset', 'Reset()'),
  M(0, 0),
  S('Z'),
  K('reset', 'Reset()'),
  K('eraseInput', 'EraseInput()'),
  S('END'),
  K('toggleInsert', 'ToggleInsert()'),
  K('home', 'Home()'),
  S('K'),
  K('reset', 'Reset()'),
];

describe.skipIf(!available)('differential: keyboard (3270js vs s3270)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  const cases: [string, string][] = [
    ['tso-logon', 'Logon ===>'],
    ['ispf-tour', 'ISPF primary option menu'],
    ['ispf-tour', 'Data set name prefix'],
    ['ispf-tour', 'Row 1 of 62'],
  ];

  for (const [name, marker] of cases) {
    it(`${name}: key script on the "${marker}" screen matches s3270`, async () => {
      const p = await pair(load(name));
      cleanups.push(p.close);
      let i = 0;
      for (; i < p.steps.records.length; i++) {
        await p.host.send(p.steps.records[i]!);
        p.fake.write(p.steps.records[i]!);
        await p.s3connected;
        if (p.term.text.some((l) => l.includes(marker)) && !p.term.keyboard.isLocked) break;
      }
      expect(i, `found the ${marker} screen`).toBeLessThan(p.steps.records.length);
      expect(await compare(p.term, p.s3, 'before keys', true)).toBeUndefined();

      const diffs: Diff[] = [];
      for (const [action, s3action] of SCRIPT) {
        if (action.type === 'moveCursor') p.term.screen.cursor = action.row * 80 + action.col;
        else if (action.type === 'string') p.term.type(action.text);
        else p.term.press(action);
        // s3270 reports an operator error (e.g. typing into a protected field)
        // as an error; that is an outcome to compare, not a harness failure.
        await p.s3.run(s3action).catch(() => undefined);
        const d = await compare(p.term, p.s3, `after ${s3action}`);
        const lock = p.s3.status.split(' ')[0];
        if (lock !== ourLock(p.term)) {
          (d ?? diffs[diffs.push({ where: `after ${s3action}`, problems: [] }) - 1]!).problems.push(
            `lock ours ${ourLock(p.term)} s3270 ${lock}`,
          );
        }
        if (d) diffs.push(d);
      }
      expect(diffs).toEqual([]);
    });
  }
});
