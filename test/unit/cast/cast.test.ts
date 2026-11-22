import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { traceToCast, traceToCommands } from '../../../src/cast/index.js';
import { SessionObserver } from '../../../src/core/observer/index.js';
import { fromHex } from '../../../src/core/trace/index.js';
import { frame } from '../../helpers/fake-host.js';
import { loadTrace } from '../../helpers/replay-driver.js';

/** ESC [ params letter: the control sequences the cast uses. */
const ESC = String.fromCharCode(27);
const CSI = /^\[([0-9;]*)([A-Za-z])/;

/** A minimal VT interpreter for the sequences the cast uses. */
class Vt {
  grid: string[][];
  row = 0;
  col = 0;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.grid = Array.from({ length: height }, () => Array<string>(width).fill(' '));
  }
  write(s: string) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === ESC) {
        const m = CSI.exec(s.slice(i + 1))!;
        const args = m[1]!.split(';').filter(Boolean).map(Number);
        if (m[2] === 'H') [this.row, this.col] = [(args[0] ?? 1) - 1, (args[1] ?? 1) - 1];
        else if (m[2] === 'K')
          for (let c = this.col; c < this.width; c++) this.grid[this.row]![c] = ' ';
        else if (m[2] === 'J') this.grid.forEach((r) => r.fill(' '));
        i += m[0].length;
      } else if (ch === '\r') this.col = 0;
      else if (ch === '\n') this.row++;
      else if (/\p{M}/u.test(ch))
        continue; // a combining overline stays with its base
      else {
        this.grid[this.row]![this.col++] = ch;
      }
    }
  }
  line(r: number) {
    return this.grid[r]!.join('').trimEnd();
  }
}

/** The observer's text and cursor after each host write, in order. */
function framesOf(name: string) {
  const trace = loadTrace(name);
  const o = new SessionObserver({
    model: trace.meta.model,
    codePage: trace.meta.codePage,
    color: /3279/.test(trace.meta.terminalType),
  });
  const frames: { text: string[]; cursor: number; rows: number; cols: number }[] = [];
  o.on(
    'hostWrite',
    () => frames.push({ text: [], cursor: -1, rows: 0, cols: 0 }), // filled in after the record
  );
  for (const e of trace.events) {
    const before = frames.length;
    const b = e.kind === 'record' ? Buffer.from(frame(e.hex), 'hex') : fromHex(e.hex);
    if (e.dir === 'host') o.host(b);
    else o.terminal(b);
    if (frames.length > before) {
      frames[frames.length - 1] = {
        text: o.text.map((l) => l.trimEnd()),
        cursor: o.screen.cursor,
        rows: o.screen.rows,
        cols: o.screen.cols,
      };
      frames.splice(before, frames.length - before - 1); // one frame per record
    }
  }
  return frames;
}

const traces = readdirSync(new URL('../../traces/', import.meta.url), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

describe('traceToCast', () => {
  it.each(traces)('%s: every frame shows the screen the observer had', (name) => {
    const lines = traceToCast(loadTrace(name)).trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as { version: number; width: number; height: number };
    expect(header.version).toBe(2);
    const events = lines.slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    const outputs = events.filter((e) => e[1] === 'o');
    const frames = framesOf(name);
    expect(outputs).toHaveLength(frames.length);
    const vt = new Vt(header.width, header.height);
    let last = -1;
    outputs.forEach(([t, , data], i) => {
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
      vt.write(data);
      const f = frames[i]!;
      for (let r = 0; r < f.rows; r++) expect(vt.line(r), `frame ${i} row ${r}`).toBe(f.text[r]);
      expect(vt.line(header.height - 1)).toMatch(/^4[AB].*\d{3}\/\d{3}$/); // the status line
      expect([vt.row, vt.col]).toEqual([Math.floor(f.cursor / f.cols), f.cursor % f.cols]);
    });
  });

  it('records input as redacted "i" events, and sizes model 5 for 27x132', () => {
    const logon = traceToCast(loadTrace('tk5/tso-logon')).split('\n').slice(1).filter(Boolean);
    const inputs = logon
      .map((l) => JSON.parse(l) as [number, string, string])
      .filter((e) => e[1] === 'i');
    expect(inputs[0]![2]).toBe('HERC01 [ENTER]');
    expect(inputs[1]![2]).toMatch(/^\*+ \[ENTER\]$/); // the password, as recorded: redacted
    const m5 = JSON.parse(traceToCast(loadTrace('tk5/ispf-tour-3279-5')).split('\n')[0]!) as {
      width: number;
      height: number;
    };
    expect([m5.width, m5.height]).toEqual([132, 28]);
  });
});

describe('traceToCommands', () => {
  it('pairs each input with the screens before and after', () => {
    const pairs = traceToCommands(loadTrace('tk5/tso-logon'));
    expect(pairs[0]).toMatchObject({
      aid: 'ENTER',
      input: [{ text: 'HERC01' }],
      before: { kind: 'vtam-logon' },
      after: { kind: 'password' },
    });
    expect(pairs[1]!.input[0]!.text).toMatch(/^\*+$/);
    expect(pairs.some((p) => p.after.kind === 'ispf-primary')).toBe(true);
    const tour = traceToCommands(loadTrace('tk5/ispf-tour'));
    expect(tour.find((p) => p.input.some((i) => i.text === '3.4'))?.after).toMatchObject({
      kind: 'ispf-panel',
      title: 'RFE DSLIST',
    });
  });
});
