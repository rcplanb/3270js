/**
 * TracePlayer: replay a 3270js trace into a real Terminal, with its timing,
 * so a renderer shows the session exactly as it looked (the faithful
 * counterpart of the asciinema export). Play, pause, change speed, cap long
 * pauses, seek to a time or a frame.
 *
 * Seeking rebuilds the terminal from the start and replays up to the target
 * at once, which is instant at these sizes; the renderer is re-attached to the
 * new terminal. Not part of the platform-neutral core: it uses timers.
 */
import { Emitter } from '../core/events.js';
import { Terminal } from '../core/terminal.js';
import { type Trace, fromHex } from '../core/trace/index.js';
import type { Transport } from '../core/transport.js';

/** The part of a renderer the player needs: DomRenderer and CanvasRenderer both fit. */
export interface PlayerView {
  attach(terminal: Terminal): void;
}

export interface TracePlayerOptions {
  /** Shows the session; re-attached after every seek. */
  view?: PlayerView;
  /** Playback speed. Default 1. */
  speed?: number;
  /** Cap pauses longer than this, in seconds (like asciinema's idle limit). Default 3. */
  idleLimit?: number;
}

export interface TracePlayerEvents {
  /** A host record was played; `frame` counts host records from 0. */
  frame: { frame: number; time: number };
  /** Playback reached the end. */
  end: undefined;
  /** Playing or paused. */
  state: { playing: boolean };
}

interface Step {
  /** Seconds on the player's timeline (idle limit applied). */
  time: number;
  bytes: Uint8Array;
  /** Index of this host record among the records, or -1 for telnet commands. */
  frame: number;
}

const IAC = 0xff;
const EOR = 0xef;

function frameRecord(record: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of record) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  out.push(IAC, EOR);
  return Uint8Array.from(out);
}

/** A transport the player writes into; whatever the terminal sends is dropped. */
class PlaybackTransport implements Transport {
  #data = new Set<(d: Uint8Array) => void>();
  #close = new Set<(reason?: string) => void>();
  send(): void {}
  onData(l: (d: Uint8Array) => void): () => void {
    this.#data.add(l);
    return () => this.#data.delete(l);
  }
  onClose(l: (reason?: string) => void): () => void {
    this.#close.add(l);
    return () => this.#close.delete(l);
  }
  close(): void {
    for (const l of this.#close) l('playback ended');
  }
  deliver(bytes: Uint8Array): void {
    for (const l of this.#data) l(bytes);
  }
}

export class TracePlayer {
  readonly #events = new Emitter<TracePlayerEvents>();
  readonly #steps: Step[];
  readonly #view: PlayerView | undefined;
  readonly #trace: Trace;
  #terminal!: Terminal;
  #transport!: PlaybackTransport;
  #next = 0;
  #frame = -1;
  #speed: number;
  #playing = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Timeline position (s) of the last step played, and the wall clock then. */
  #anchor = { time: 0, at: 0 };

  constructor(trace: Trace, options: TracePlayerOptions = {}) {
    if (trace.format !== '3270js-trace' || trace.version !== 1) {
      throw new Error('not a 3270js trace (format/version)');
    }
    this.#trace = trace;
    this.#view = options.view;
    this.#speed = options.speed ?? 1;
    const idle = options.idleLimit ?? 3;
    // Only the host's side is played: the terminal's replies don't change what the host sent.
    let time = 0;
    let last = 0;
    let frame = 0;
    this.#steps = [];
    for (const e of trace.events) {
      if (e.dir !== 'host') continue;
      const t = e.t / 1000;
      time += Math.min(Math.max(0, t - last), idle);
      last = t;
      const bytes = fromHex(e.hex);
      const isRecord = e.kind === 'record';
      this.#steps.push({
        time,
        bytes: isRecord ? frameRecord(bytes) : bytes,
        frame: isRecord ? frame++ : -1,
      });
    }
    this.#reset();
  }

  on<K extends keyof TracePlayerEvents>(
    event: K,
    handler: (payload: TracePlayerEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, handler);
  }

  /** The terminal being played into (a new one after each seek). */
  get terminal(): Terminal {
    return this.#terminal;
  }

  /** Length of the recording on the player's timeline, in seconds. */
  get duration(): number {
    return this.#steps.at(-1)?.time ?? 0;
  }

  /** Number of host records (frames). */
  get frames(): number {
    return this.#steps.filter((s) => s.frame >= 0).length;
  }

  /** The last frame played (-1 before the first). */
  get frame(): number {
    return this.#frame;
  }

  /** The current position, in seconds. */
  get time(): number {
    if (!this.#playing) return this.#anchor.time;
    return Math.min(
      this.duration,
      this.#anchor.time + ((Date.now() - this.#anchor.at) / 1000) * this.#speed,
    );
  }

  get playing(): boolean {
    return this.#playing;
  }

  get speed(): number {
    return this.#speed;
  }

  set speed(speed: number) {
    if (!(speed > 0)) throw new RangeError('speed must be positive');
    const now = this.time;
    this.#speed = speed;
    this.#anchor = { time: now, at: Date.now() };
    if (this.#playing) this.#schedule();
  }

  play(): void {
    if (this.#playing) return;
    if (this.#next >= this.#steps.length) this.seek(0);
    this.#playing = true;
    this.#anchor = { time: this.#anchor.time, at: Date.now() };
    this.#events.emit('state', { playing: true });
    this.#schedule();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#anchor = { time: this.time, at: Date.now() };
    this.#playing = false;
    clearTimeout(this.#timer);
    this.#events.emit('state', { playing: false });
  }

  /** Go to a time (seconds): every step up to it is played at once. */
  seek(time: number): void {
    const target = Math.max(0, Math.min(time, this.duration));
    if (target < this.#anchor.time || this.#next === 0) this.#reset();
    while (this.#next < this.#steps.length && this.#steps[this.#next]!.time <= target) this.#step();
    this.#anchor = { time: target, at: Date.now() };
    if (this.#playing) this.#schedule();
  }

  /** Go to just after a frame (a host record), e.g. to step through screens. */
  seekFrame(frame: number): void {
    const step = this.#steps.find((s) => s.frame === Math.max(0, frame));
    this.seek(step ? step.time : this.duration);
    // Several records can share a time: play up to and including this one.
    while (this.#frame < frame && this.#next < this.#steps.length) this.#step();
  }

  /** Stop playing and release the terminal. */
  dispose(): void {
    this.pause();
    this.#transport.close();
  }

  #reset(): void {
    this.#transport?.close();
    const meta = this.#trace.meta;
    this.#terminal = new Terminal({
      model: meta.model,
      codePage: meta.codePage,
      terminalType: meta.terminalType,
      color: /3279/.test(meta.terminalType),
    });
    this.#transport = new PlaybackTransport();
    void this.#terminal.connect(this.#transport).catch(() => undefined);
    this.#view?.attach(this.#terminal);
    this.#next = 0;
    this.#frame = -1;
    this.#anchor = { time: 0, at: Date.now() };
  }

  #step(): void {
    const s = this.#steps[this.#next++]!;
    this.#transport.deliver(s.bytes);
    if (s.frame >= 0) {
      this.#frame = s.frame;
      this.#events.emit('frame', { frame: s.frame, time: s.time });
    }
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    if (!this.#playing) return;
    const next = this.#steps[this.#next];
    if (!next) {
      this.#playing = false;
      this.#anchor = { time: this.duration, at: Date.now() };
      this.#events.emit('state', { playing: false });
      this.#events.emit('end', undefined);
      return;
    }
    const wait = Math.max(0, ((next.time - this.time) * 1000) / this.#speed);
    this.#timer = setTimeout(() => {
      // Play everything due now, then wait for the next.
      const now = this.time;
      while (this.#next < this.#steps.length && this.#steps[this.#next]!.time <= now + 1e-9)
        this.#step();
      this.#schedule();
    }, wait);
  }
}
