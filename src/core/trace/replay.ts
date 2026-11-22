/**
 * Replay a trace's host side into a fresh Terminal and snapshot the screen
 * after each host write. The terminal side is not replayed: the host's bytes
 * were recorded, so the terminal's replies don't change them.
 */
import { Terminal, type TerminalOptions } from '../terminal.js';
import type { Transport } from '../transport.js';
import { type Trace, type TraceScreen, fromHex } from './trace.js';

const IAC = 0xff;
const EOR = 0xef;

export interface ReplayResult {
  terminal: Terminal;
  /** The screen after each host record. */
  screens: TraceScreen[];
  final: TraceScreen;
}

export function replayTrace(trace: Trace, options: TerminalOptions = {}): ReplayResult {
  if (trace.format !== '3270js-trace' || trace.version !== 1) {
    throw new Error('not a 3270js trace (format/version)');
  }
  const terminal = new Terminal({
    model: trace.meta.model,
    codePage: trace.meta.codePage,
    terminalType: trace.meta.terminalType,
    ...options,
  });
  const transport = new ReplayTransport();
  const screens: TraceScreen[] = [];
  const snapshot = (): TraceScreen => ({ text: terminal.text, cursor: terminal.screen.cursor });

  void terminal.connect(transport).catch(() => undefined);
  for (const e of trace.events) {
    if (e.dir !== 'host') continue;
    const data = fromHex(e.hex);
    transport.deliver(e.kind === 'record' ? frame(data) : data);
    if (e.kind === 'record') screens.push(snapshot());
  }
  transport.close();
  return { terminal, screens, final: snapshot() };
}

function frame(record: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of record) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  out.push(IAC, EOR);
  return Uint8Array.from(out);
}

/** Delivers recorded bytes; discards whatever the terminal sends. */
class ReplayTransport implements Transport {
  #data = new Set<(d: Uint8Array) => void>();
  #close = new Set<(reason?: string) => void>();
  #closed = false;
  send(): void {}
  onData(l: (d: Uint8Array) => void) {
    this.#data.add(l);
    return () => this.#data.delete(l);
  }
  onClose(l: (reason?: string) => void) {
    this.#close.add(l);
    return () => this.#close.delete(l);
  }
  deliver(d: Uint8Array): void {
    for (const l of this.#data) l(d);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const l of this.#close) l('replay finished');
  }
}
