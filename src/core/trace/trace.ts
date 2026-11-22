/**
 * Session traces: a JSON record of both directions of a TN3270 session, for
 * tests, bug reports and replay. Passwords typed into non-display fields are
 * redacted as they are recorded.
 */
import { getCodePage } from '../codepage/index.js';
import { type ObservedItem, SessionObserver } from '../observer/index.js';
import type { ModelNumber } from '../screen/index.js';

export interface TraceMeta {
  terminalType: string;
  model: ModelNumber;
  codePage: string;
  description?: string;
  /** ISO timestamp. */
  recorded?: string;
}

export interface TraceEvent {
  /** Milliseconds since the recording started. */
  t: number;
  dir: 'host' | 'terminal';
  /** A 3270 record (unframed), or raw telnet command bytes. */
  kind: 'record' | 'telnet';
  hex: string;
}

export interface TraceScreen {
  text: string[];
  cursor: number;
}

export interface Trace {
  format: '3270js-trace';
  version: 1;
  meta: TraceMeta;
  events: TraceEvent[];
  /** The screen as the host last left it. */
  final?: TraceScreen;
}

/** The part of a Terminal the recorder needs (avoids an import cycle). */
export interface TraceSource {
  on(
    event: 'traffic',
    handler: (e: { dir: 'host' | 'terminal'; data: Uint8Array }) => void,
  ): () => void;
}

export interface TraceRecorderOptions {
  meta: TraceMeta;
  /** Millisecond clock. Default `Date.now`. */
  clock?: () => number;
}

export interface TraceRecorder {
  /** Raw bytes from the host. */
  host(chunk: Uint8Array): void;
  /** Raw bytes from the terminal. */
  terminal(chunk: Uint8Array): void;
  /** Record a Terminal's traffic. Returns a function that stops recording. */
  attach(source: TraceSource): () => void;
  trace(): Trace;
}

export function createTraceRecorder(options: TraceRecorderOptions): TraceRecorder {
  const clock = options.clock ?? (() => Date.now());
  const start = clock();
  const meta = { ...options.meta };
  if (!getCodePage(meta.codePage)) throw new Error(`unknown code page "${meta.codePage}"`);

  // The observer follows the session (TN3270E included) so it knows which
  // fields are hidden, and redacts what the terminal sends.
  const observer = new SessionObserver({
    model: meta.model,
    codePage: meta.codePage,
    color: /3279/.test(meta.terminalType),
  });
  const events: TraceEvent[] = [];
  const add = (dir: TraceEvent['dir'], items: ObservedItem[]) => {
    const t = clock() - start;
    for (const item of items) events.push({ t, dir, kind: item.kind, hex: toHex(item.data) });
  };

  return {
    host(chunk) {
      add('host', observer.host(chunk));
    },
    terminal(chunk) {
      add('terminal', observer.terminal(chunk));
    },
    attach(source) {
      return source.on('traffic', (e) =>
        e.dir === 'host' ? this.host(e.data) : this.terminal(e.data),
      );
    },
    trace() {
      return {
        format: '3270js-trace',
        version: 1,
        meta,
        events: events.slice(),
        final: { text: observer.text, cursor: observer.screen.cursor },
      };
    },
  };
}

function toHex(data: Uint8Array): string {
  let s = '';
  for (const b of data) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
