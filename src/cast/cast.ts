/**
 * Recordings for players that only know character terminals ("EBCDIC
 * cinema"): turn a 3270js trace into an asciinema v2 `.cast`, and into
 * command/response pairs.
 *
 * The trace stays the lossless original. The cast is a view of it: every host
 * write becomes one ANSI full-screen repaint (true colour, the 3270's colours
 * and highlighting, the status line as the last row, the cursor where the
 * 3270's is), so asciinema-player and agg show the session as it looked. What
 * the terminal sent becomes "i" events, already redacted in the trace.
 */
import { Aid, parseInbound } from '../core/inbound/index.js';
import { SessionObserver } from '../core/observer/index.js';
import { type ScreenKind, recognise } from '../core/recognise/index.js';
import { MODELS } from '../core/screen/index.js';
import { type Trace, fromHex } from '../core/trace/index.js';
import { type DisplayMode, cellStyle } from '../renderer/cell-style.js';
import { DEFAULT_THEME, type Theme } from '../renderer/theme.js';

export interface CastOptions {
  /** Colours to draw with. Default the renderers' default theme. */
  theme?: Theme;
  /** Default `color` for 3279 traces, `monochrome` for 3278s. */
  displayMode?: DisplayMode;
  /** Shown by players. Default the trace's description. */
  title?: string;
}

const ESC = '\x1b';
const AID_NAMES = new Map<number, string>(
  Object.entries(Aid).map(([name, code]) => [code, name] as const),
);

/** Replay a trace's events, both directions, into an observer, calling back per record. */
function replay(
  trace: Trace,
  o: SessionObserver,
  on: (e: {
    t: number;
    dir: 'host' | 'terminal';
    data: Uint8Array;
    /** The host wrote to the screen. */
    wrote: boolean;
    /** The screen changed (a host write, or the operator's input put back on it). */
    changed: boolean;
  }) => void,
): void {
  let wrote = false;
  const off = o.on('hostWrite', () => (wrote = true));
  for (const e of trace.events) {
    const bytes = fromHex(e.hex);
    // Records are stored unframed: frame them again for the observer.
    const chunk = e.kind === 'record' ? frame(bytes) : bytes;
    wrote = false;
    const version = o.screen.version;
    const items = e.dir === 'host' ? o.host(chunk) : o.terminal(chunk);
    if (e.kind !== 'record') continue;
    const changed = o.screen.version !== version;
    for (const item of items) {
      if (item.kind === 'record') on({ t: e.t, dir: e.dir, data: item.data, wrote, changed });
    }
  }
  off();
}

function frame(record: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of record) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  out.push(0xff, 0xef);
  return Uint8Array.from(out);
}

function observerFor(trace: Trace): SessionObserver {
  return new SessionObserver({
    model: trace.meta.model,
    codePage: trace.meta.codePage,
    color: /3279/.test(trace.meta.terminalType),
  });
}

const rgb = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`;
};

/** One full-screen repaint: every row, the status line, the cursor. */
function paint(o: SessionObserver, theme: Theme, mode: DisplayMode, height: number): string {
  const { screen } = o;
  const colors = theme.colors;
  let out = `${ESC}[H`;
  for (let r = 0; r < screen.rows; r++) {
    let key = '';
    for (let c = 0; c < screen.cols; c++) {
      const st = cellStyle(screen, r * screen.cols + c, {
        codePage: o.codePage,
        displayMode: mode,
      });
      let fg = colors[st.fg];
      let bg = colors[st.bg];
      if (st.reverse) [fg, bg] = [bg ?? colors.background, fg];
      const sgr = `0;38;2;${rgb(fg)};48;2;${rgb(bg ?? colors.background)}${st.underscore ? ';4' : ''}${st.blink ? ';5' : ''}`;
      if (sgr !== key) {
        out += `${ESC}[${sgr}m`;
        key = sgr;
      }
      out += st.char;
    }
    out += `${ESC}[0;48;2;${rgb(colors.background)}m${ESC}[K\r\n`;
  }
  // Rows below a smaller screen (after a switch back from the alternate size).
  for (let r = screen.rows; r < height - 1; r++) out += `${ESC}[K\r\n`;
  out += `${ESC}[0;38;2;${rgb(theme.oia)};48;2;${rgb(colors.background)}m${statusLine(o, screen.cols)}${ESC}[K`;
  const row = Math.floor(screen.cursor / screen.cols);
  const col = screen.cursor % screen.cols;
  return `${out}${ESC}[0m${ESC}[${row + 1};${col + 1}H`;
}

/** The status line in words, as c3270 writes it: 4A/4B, the lock, the cursor position. */
function statusLine(o: SessionObserver, cols: number): string {
  const line = Array.from({ length: cols }, () => ' ');
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (line[at + i] = ch));
  put(0, o.tn3270e ? '4B' : '4A');
  if (o.keyboardLocked) put(8, 'X Wait');
  const pos = (n: number) => String(n + 1).padStart(3, '0');
  const row = Math.floor(o.screen.cursor / o.screen.cols);
  put(cols - 7, `${pos(row)}/${pos(o.screen.cursor % o.screen.cols)}`);
  return line.join('');
}

/** What the terminal sent, as a line of text: the AID and each field's (redacted) data. */
function describeInput(o: SessionObserver, data: Uint8Array): string | undefined {
  const parsed = inbound(o, data);
  if (!parsed) return undefined;
  const fields = parsed.fields.map((f) => o.codePage.decode(f.data).trimEnd()).filter((t) => t);
  return `${fields.join(' ')}${fields.length ? ' ' : ''}[${AID_NAMES.get(parsed.aid) ?? 'AID'}]`;
}

/** The terminal's record, parsed, if it is an operator's AID (not a reply the host asked for). */
function inbound(o: SessionObserver, data: Uint8Array) {
  const body = o.tn3270e ? (data[0] === 0x00 ? data.subarray(5) : undefined) : data;
  if (!body?.length) return undefined;
  const parsed = parseInbound(body, o.screen.size);
  const aid = parsed.aid;
  if (aid === Aid.NONE || aid === Aid.QUERY_REPLY || aid === Aid.STRUCTURED_FIELD) return undefined;
  return parsed;
}

/** The asciinema v2 recording of a trace, as the text of a `.cast` file. */
export function traceToCast(trace: Trace, options: CastOptions = {}): string {
  const theme = options.theme ?? DEFAULT_THEME;
  const color = /3279/.test(trace.meta.terminalType);
  const mode = options.displayMode ?? (color ? 'color' : 'monochrome');
  const alt = MODELS[trace.meta.model];
  const width = Math.max(80, alt.cols);
  const height = Math.max(24, alt.rows) + 1;
  const recorded = trace.meta.recorded ? Date.parse(trace.meta.recorded) / 1000 : undefined;
  const header = {
    version: 2,
    width,
    height,
    ...(recorded && Number.isFinite(recorded) ? { timestamp: Math.floor(recorded) } : {}),
    env: { TERM: 'xterm-256color' },
    title: options.title ?? trace.meta.description ?? '3270 session',
  };
  const lines = [JSON.stringify(header)];
  const o = observerFor(trace);
  let rows = 0;
  replay(trace, o, ({ t, dir, data, wrote, changed }) => {
    const time = Math.round(t) / 1000;
    if (dir === 'host' && wrote) {
      // A change of screen size: clear once so nothing of the old screen remains.
      const clear = o.screen.rows !== rows ? `${ESC}[0m${ESC}[2J` : '';
      rows = o.screen.rows;
      lines.push(JSON.stringify([time, 'o', clear + paint(o, theme, mode, height)]));
    } else if (dir === 'terminal') {
      // What the operator typed, as the screen showed it when the key was pressed.
      if (changed) lines.push(JSON.stringify([time, 'o', paint(o, theme, mode, height)]));
      const text = describeInput(o, data);
      if (text) lines.push(JSON.stringify([time, 'i', text]));
    }
  });
  o.dispose();
  return lines.join('\n') + '\n';
}

/** One operator interaction: what was sent and the screen that came back. */
export interface CommandPair {
  /** Seconds from the start of the recording. */
  t: number;
  /** The AID key, e.g. "ENTER", "PF3". */
  aid: string;
  /** The fields sent, redacted (a password shows as asterisks). */
  input: { row: number; col: number; text: string }[];
  /** The screen the operator was looking at. */
  before: { kind: ScreenKind; title?: string; text: string[] };
  /** The screen once the host had finished answering (before the next input). */
  after: { kind: ScreenKind; title?: string; text: string[] };
}

/** Command/response pairs, one per AID, for indexing and search (SimH Assist's session_commands). */
export function traceToCommands(trace: Trace): CommandPair[] {
  const o = observerFor(trace);
  const pairs: CommandPair[] = [];
  const snapshot = () => {
    const r = recognise(o);
    return {
      kind: r.kind,
      ...(r.title ? { title: r.title } : {}),
      text: o.text.map((l) => l.trimEnd()),
    };
  };
  let pending: CommandPair | undefined;
  replay(trace, o, ({ t, dir, data }) => {
    if (dir !== 'terminal') {
      if (pending) pending.after = snapshot();
      return;
    }
    const parsed = inbound(o, data);
    if (!parsed) return;
    const cols = o.screen.cols;
    pending = {
      t: Math.round(t) / 1000,
      aid: AID_NAMES.get(parsed.aid) ?? `X'${parsed.aid.toString(16)}'`,
      input: parsed.fields.map((f) => ({
        row: Math.floor(f.address / cols),
        col: f.address % cols,
        text: o.codePage.decode(f.data).trimEnd(),
      })),
      before: snapshot(),
      after: snapshot(),
    };
    pairs.push(pending);
  });
  o.dispose();
  return pairs;
}
