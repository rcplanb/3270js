/**
 * Session traces: a JSON record of both directions of a TN3270 session, for
 * tests, bug reports and replay. Passwords typed into non-display fields are
 * redacted as they are recorded.
 */
import { getCodePage } from '../codepage/index.js';
import { type OutboundGeometry, processOutbound } from '../datastream/index.js';
import { StructuredFieldId, parseStructuredFields } from '../query/index.js';
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

  // TN3270E (RFC 2355): records carry a 5-byte header. Follow the negotiation
  // the recorder sees: the terminal's WILL TN3270E starts it, a WONT or DONT
  // ends it. Records only flow once negotiation is over.
  let tn3270e = false;
  const watchTelnet = (bytes: Uint8Array) => {
    if (bytes[0] !== IAC || bytes[2] !== TELOPT_TN3270E) return;
    if (bytes[1] === WILL) tn3270e = true;
    else if (bytes[1] === WONT || bytes[1] === DONT) tn3270e = false;
  };

  /** Apply a host record to the shadow screen (3270-DATA only in TN3270E). */
  const follow = (record: Uint8Array) => {
    let data = record;
    if (tn3270e) {
      if (record.length < 5) return;
      if (record[0] === DT_UNBIND) shadow.clear();
      if (record[0] !== DT_3270_DATA) return;
      data = record.subarray(5);
    }
    const r = processOutbound(shadow, data, geometry);
    // Writes carried in structured fields (Outbound 3270DS), as OS/390's ISPF sends.
    if (!r.structuredFields) return;
    for (const f of parseStructuredFields(r.structuredFields).fields) {
      if (f.id === StructuredFieldId.OUTBOUND_3270DS && f.data[0] === 0x00) {
        processOutbound(shadow, f.data.subarray(1), geometry);
      }
    }
  };

  /** Redact a terminal record, keeping a TN3270E header; only 3270-DATA has fields. */
  const redact = (record: Uint8Array): Uint8Array => {
    if (!tn3270e) return redactInbound(record, shadow.size, hidden);
    if (record.length < 5 || record[0] !== DT_3270_DATA) return record;
    const body = redactInbound(record.subarray(5), shadow.size, hidden);
    const out = new Uint8Array(record.length);
    out.set(record.subarray(0, 5));
    out.set(body, 5);
    return out;
  };

  return {
    host(chunk) {
      for (const item of hostFramer.push(chunk)) {
        if (item.kind === 'record') follow(item.data);
        else watchTelnet(item.data);
        add('host', item.kind, item.data);
      }
    },
    terminal(chunk) {
      for (const item of terminalFramer.push(chunk)) {
        if (item.kind === 'telnet') watchTelnet(item.data);
        add('terminal', item.kind, item.kind === 'record' ? redact(item.data) : item.data);
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

const IAC = 0xff;
const WILL = 0xfb;
const WONT = 0xfc;
const DONT = 0xfe;
const TELOPT_TN3270E = 40;
const DT_3270_DATA = 0x00;
const DT_UNBIND = 0x04;

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
