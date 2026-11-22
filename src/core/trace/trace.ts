/**
 * Session traces: a JSON record of both directions of a TN3270 session, for
 * tests, bug reports and replay. Passwords typed into non-display fields are
 * redacted as they are recorded.
 */
import { getCodePage } from '../codepage/index.js';
import { type OutboundGeometry, processOutbound } from '../datastream/index.js';
import { MODELS, type ModelNumber, Screen } from '../screen/index.js';
import { TelnetFramer } from './framer.js';
import { redactInbound } from './redact.js';

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
  const cp = getCodePage(meta.codePage);
  if (!cp) throw new Error(`unknown code page "${meta.codePage}"`);

  const geometry: OutboundGeometry = {
    default: { rows: 24, cols: 80 },
    alternate: MODELS[meta.model],
  };
  // The shadow screen follows host writes so we know which cells are hidden.
  const shadow = new Screen(24, 80);
  const events: TraceEvent[] = [];
  const hostFramer = new TelnetFramer();
  const terminalFramer = new TelnetFramer();

  const add = (dir: TraceEvent['dir'], kind: TraceEvent['kind'], data: Uint8Array) =>
    events.push({ t: clock() - start, dir, kind, hex: toHex(data) });

  const hidden = (address: number) => shadow.fieldAt(address)?.display === 'hidden';

  return {
    host(chunk) {
      for (const item of hostFramer.push(chunk)) {
        if (item.kind === 'record') processOutbound(shadow, item.data, geometry);
        add('host', item.kind, item.data);
      }
    },
    terminal(chunk) {
      for (const item of terminalFramer.push(chunk)) {
        const data =
          item.kind === 'record' ? redactInbound(item.data, shadow.size, hidden) : item.data;
        add('terminal', item.kind, data);
      }
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
        final: { text: shadow.toText(cp), cursor: shadow.cursor },
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
