/**
 * SessionObserver: a passive copy of a 3270 session, fed the raw bytes of
 * both directions by something in the middle (a relay, a proxy, a recorder).
 * It never sends anything. Like a 3174 establishment controller watching its
 * terminal, it keeps the screen as the host wrote it, knows which fields are
 * hidden, follows the keyboard lock as the host sees it, and parses what the
 * terminal sends, with passwords redacted. What the operator sent is put back
 * on the screen (applyInbound), as the terminal still showed it; what has
 * been typed but not sent exists only in the terminal.
 *
 * It follows the same session logic as Terminal: telnet and TN3270E
 * negotiation (RFC 2355), FUNCTIONS, BIND and UNBIND, SSCP-LU text, Outbound
 * 3270DS structured fields and Erase/Write Alternate. Its screen matches a
 * Terminal fed the same host bytes plus the same input put back (checked on
 * every recorded trace).
 */
import { type CodePage, getCodePage } from '../codepage/index.js';
import { type OutboundGeometry, processOutbound } from '../datastream/index.js';
import { Emitter } from '../events.js';
import {
  Aid,
  type InboundRecord,
  type ReplyModeState,
  applyInbound,
  parseInbound,
} from '../inbound/index.js';
import { ReplyModeCode, StructuredFieldId, parseStructuredFields } from '../query/index.js';
import { MODELS, type ModelNumber, Screen } from '../screen/index.js';
import { writeSscpLu } from '../sscp.js';
import { TelnetFramer } from '../trace/framer.js';
import { redactInbound } from '../trace/redact.js';

export interface SessionObserverOptions {
  /** The terminal's model (its alternate screen size). Default 2. */
  model?: ModelNumber;
  /** A 3279: host colours are kept. A 3278 ignores them, as Terminal does. Default false. */
  color?: boolean;
  /** Code page for `text`. Default `cp037`. */
  codePage?: string | CodePage;
  /** Milliseconds of host silence before `ready`. Default 300. */
  quietMs?: number;
  /**
   * Timers for the `ready` event's quiet period, e.g.
   * `{ setTimeout, clearTimeout }` in Node or a browser. The core is
   * platform-neutral, so it can't use them itself: without them, `ready` is
   * never emitted (everything else works).
   */
  timers?: Timers;
}

/** The two timer functions the observer needs (the core has no platform types). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One framed item, as the observer saw it. Terminal records are already redacted. */
export interface ObservedItem {
  kind: 'record' | 'telnet';
  data: Uint8Array;
}

export type ObservedMode = 'unbound' | 'lu-lu' | 'sscp-lu' | 'nvt';

/**
 * What a Terminal needs to continue an observed session on the same
 * connection (Terminal.adopt), besides the screen.
 */
export interface ObservedSession {
  /** The TN3270E session, if one was negotiated; plain TN3270 otherwise. */
  tn3270e?: { deviceType: string; luName?: string; functions: number[] };
  /** The current BIND image (TN3270E with BIND-IMAGE), without its header. */
  bindImage?: Uint8Array;
  mode: ObservedMode;
  /** The sequence number for the terminal's next 3270-DATA record (TN3270E). */
  nextSeq: number;
  /** Waiting for the host after an AID: the keyboard is locked. */
  keyboardLocked: boolean;
  /** The host's reply mode (Set Reply Mode). */
  reply: ReplyModeState;
  /** The AID of the operator's last key, for reads the host makes later. */
  lastAid: number;
}

export interface SessionObserverEvents {
  /** The host wrote to the screen (any write, including SSCP-LU text). */
  hostWrite: undefined;
  /** The terminal sent input. Hidden fields are already redacted. */
  input: InboundRecord;
  /** The keyboard is unlocked and the host has been quiet for `quietMs` (needs `timers`). */
  ready: undefined;
}

const IAC = 0xff;
const SB = 0xfa;
const WILL = 0xfb;
const WONT = 0xfc;
const DONT = 0xfe;
const TELOPT_TN3270E = 40;
const OP_FUNCTIONS = 0x03;
const OP_IS = 0x04;
const FN_BIND_IMAGE = 0x00;
const OP_DEVICE_TYPE = 0x02;
const OP_CONNECT = 0x01;
const DT = { DATA_3270: 0x00, BIND_IMAGE: 0x03, UNBIND: 0x04, SSCP_LU_DATA: 0x07 } as const;
const DEFAULT_GEOMETRY = { rows: 24, cols: 80 };
/** AIDs on replies the host asked for, not operator input. */
const HOST_REQUESTED = new Set<number>([Aid.NONE, Aid.QUERY_REPLY, Aid.STRUCTURED_FIELD]);

export class SessionObserver {
  readonly screen: Screen;
  readonly codePage: CodePage;
  readonly model: ModelNumber;
  readonly color: boolean;
  readonly #events = new Emitter<SessionObserverEvents>();
  readonly #geometry: OutboundGeometry;
  readonly #color: boolean;
  readonly #quietMs: number;
  readonly #hostFramer = new TelnetFramer();
  readonly #terminalFramer = new TelnetFramer();
  #tn3270e = false;
  #functions = new Set<number>();
  #bound = false;
  #bindImage: Uint8Array | undefined;
  #deviceType = '';
  #luName: string | undefined;
  #nextSeq = 0;
  #reply: ReplyModeState = { mode: 'field' };
  #lastAid: number = Aid.NONE;
  #mode: ObservedMode = 'unbound';
  #locked = true;
  #awaitingFirst = true;
  readonly #timers: Timers | undefined;
  #quiet: unknown;

  constructor(options: SessionObserverOptions = {}) {
    const model = options.model ?? 2;
    const requested = options.codePage ?? 'cp037';
    const cp = typeof requested === 'object' ? requested : getCodePage(requested);
    if (!cp)
      throw new Error(`unknown code page "${typeof requested === 'string' ? requested : ''}"`);
    this.codePage = cp;
    this.#geometry = { default: DEFAULT_GEOMETRY, alternate: MODELS[model] };
    this.#color = options.color ?? false;
    this.model = model;
    this.color = this.#color;
    this.#quietMs = options.quietMs ?? 300;
    this.#timers = options.timers;
    this.screen = new Screen(DEFAULT_GEOMETRY.rows, DEFAULT_GEOMETRY.cols);
  }

  on<K extends keyof SessionObserverEvents>(
    event: K,
    handler: (payload: SessionObserverEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, handler);
  }

  /** The screen as text, one string per row. Non-display fields are blank. */
  get text(): string[] {
    return this.screen.toText(this.codePage);
  }

  /** TN3270E negotiation took place (records carry headers). */
  get tn3270e(): boolean {
    return this.#tn3270e;
  }

  /** The session state: `lu-lu` for an application (always, on plain TN3270). */
  get sessionMode(): ObservedMode {
    return this.#tn3270e ? this.#mode : 'lu-lu';
  }

  /**
   * The keyboard as the host sees it: locked from the terminal's AID until a
   * write restores it (operator errors are local to the terminal, not seen).
   */
  get keyboardLocked(): boolean {
    return this.#locked;
  }

  /** Is the cell at `address` in a non-display (hidden) field? */
  isHidden(address: number): boolean {
    return this.screen.fieldAt(address)?.display === 'hidden';
  }

  /** Bytes from the host. Returns the items framed from them. */
  host(chunk: Uint8Array): ObservedItem[] {
    const items = this.#hostFramer.push(chunk);
    for (const item of items) {
      if (item.kind === 'telnet') this.#telnet(item.data);
      else this.#hostRecord(item.data);
    }
    return items;
  }

  /** Bytes from the terminal. Returns the items, records redacted. */
  terminal(chunk: Uint8Array): ObservedItem[] {
    return this.#terminalFramer.push(chunk).map((item) => {
      if (item.kind === 'telnet') {
        this.#telnet(item.data);
        return item;
      }
      return { kind: 'record', data: this.#terminalRecord(item.data) };
    });
  }

  /** The session state a Terminal needs to take this session over (Terminal.adopt). */
  get session(): ObservedSession {
    return {
      ...(this.#tn3270e
        ? {
            tn3270e: {
              deviceType: this.#deviceType,
              ...(this.#luName === undefined ? {} : { luName: this.#luName }),
              functions: [...this.#functions],
            },
          }
        : {}),
      ...(this.#bindImage ? { bindImage: this.#bindImage } : {}),
      mode: this.sessionMode,
      nextSeq: this.#nextSeq,
      keyboardLocked: this.#locked,
      reply: this.#reply,
      lastAid: this.#lastAid,
    };
  }

  /** Stop the quiet timer. */
  dispose(): void {
    this.#timers?.clearTimeout(this.#quiet);
  }

  #telnet(bytes: Uint8Array): void {
    if (bytes[0] !== IAC || bytes[2] !== TELOPT_TN3270E) return;
    const verb = bytes[1];
    if (verb === WILL) this.#tn3270e = true;
    else if (verb === WONT || verb === DONT) {
      this.#tn3270e = false;
      this.#functions.clear();
    } else if (verb === SB && bytes[3] === OP_FUNCTIONS && bytes[4] === OP_IS) {
      // FUNCTIONS IS <list> IAC SE, from either side, settles the functions.
      this.#functions = new Set(bytes.subarray(5, bytes.length - 2));
    } else if (verb === SB && bytes[3] === OP_DEVICE_TYPE && bytes[4] === OP_IS) {
      // DEVICE-TYPE IS <type> [CONNECT <lu>] IAC SE, from the host.
      const body = bytes.subarray(5, bytes.length - 2);
      const connect = body.indexOf(OP_CONNECT);
      const text = (b: Uint8Array) => String.fromCharCode(...b);
      this.#deviceType = text(connect < 0 ? body : body.subarray(0, connect));
      this.#luName = connect < 0 ? undefined : text(body.subarray(connect + 1));
    }
  }

  #hostRecord(record: Uint8Array): void {
    let data = record;
    if (this.#tn3270e) {
      if (record.length < 5) return;
      const type = record[0];
      if (type === DT.BIND_IMAGE) {
        this.#bound = true;
        this.#bindImage = record.slice(5);
        return;
      }
      if (type === DT.UNBIND) {
        this.#bound = false;
        this.#bindImage = undefined;
        this.#mode = 'unbound';
        this.screen.resize(DEFAULT_GEOMETRY.rows, DEFAULT_GEOMETRY.cols);
        this.screen.clear();
        return;
      }
      if (type === DT.SSCP_LU_DATA) {
        this.#mode = 'sscp-lu';
        this.#lastAid = Aid.NONE;
        this.screen.cursor = writeSscpLu(this.screen, record.subarray(5), this.screen.cursor);
        this.#hostWrote(true);
        return;
      }
      if (type !== DT.DATA_3270) return;
      // With BIND-IMAGE agreed, 3270 data before a BIND is ignored (as Terminal does).
      if (this.#functions.has(FN_BIND_IMAGE) && !this.#bound) return;
      this.#mode = 'lu-lu';
      data = record.subarray(5);
    }
    this.#write(data);
  }

  /** Apply a 3270 record, and any write carried in an Outbound 3270DS structured field. */
  #write(data: Uint8Array): void {
    const r = processOutbound(this.screen, data, this.#geometry, { color: this.#color });
    const isWrite =
      r.command === 'W' || r.command === 'EW' || r.command === 'EWA' || r.command === 'EAU';
    // An Erase/Write with the WCC reset bit returns to field reply mode (as Terminal).
    if (r.wccReset && (r.command === 'EW' || r.command === 'EWA')) this.#reply = { mode: 'field' };
    if (isWrite) this.#hostWrote(r.keyboardRestore);
    if (!r.structuredFields) return;
    for (const f of parseStructuredFields(r.structuredFields).fields) {
      if (f.id === StructuredFieldId.SET_REPLY_MODE && f.data[0] === 0x00) {
        // As Terminal: field, extended-field or character mode (with its attribute types).
        const type = f.data[1];
        if (type === ReplyModeCode.FIELD) this.#reply = { mode: 'field' };
        else if (type === ReplyModeCode.EXTENDED_FIELD) this.#reply = { mode: 'extendedField' };
        else if (type === ReplyModeCode.CHARACTER)
          this.#reply = { mode: 'character', attributes: [...f.data.subarray(2)] };
      }
      if (f.id === StructuredFieldId.OUTBOUND_3270DS && f.data[0] === 0x00) {
        const inner = processOutbound(this.screen, f.data.subarray(1), this.#geometry, {
          color: this.#color,
        });
        this.#hostWrote(inner.keyboardRestore);
      }
    }
  }

  #hostWrote(keyboardRestore: boolean): void {
    // As Keyboard.hostWrite: restore unlocks; the first write unlocks too.
    if (keyboardRestore || this.#awaitingFirst) this.#locked = false;
    this.#awaitingFirst = false;
    this.#events.emit('hostWrite', undefined);
    this.#timers?.clearTimeout(this.#quiet);
    if (!this.#locked && this.#timers) {
      this.#quiet = this.#timers.setTimeout(() => {
        if (!this.#locked) this.#events.emit('ready', undefined);
      }, this.#quietMs);
    }
  }

  /** Redact a terminal record (keeping a TN3270E header), parse it and note the AID. */
  #terminalRecord(record: Uint8Array): Uint8Array {
    let header: Uint8Array | undefined;
    let body = record;
    if (this.#tn3270e) {
      if (record.length < 5 || record[0] !== DT.DATA_3270) return record;
      header = record.subarray(0, 5);
      // RFC 2355 §10.4: the terminal counts its 3270-DATA records.
      this.#nextSeq = ((((record[3]! << 8) | record[4]!) & 0x7fff) + 1) % 32768;
      body = record.subarray(5);
    }
    const redacted = redactInbound(body, this.screen.size, (a) => this.isHidden(a));
    const parsed = parseInbound(redacted, this.screen.size);
    // An operator's AID locks the keyboard until the host restores it. Replies
    // the host asked for (Query Reply, Read Partition, no-AID reads) don't.
    if (parsed.errors.length === 0 && !HOST_REQUESTED.has(parsed.aid)) {
      this.#locked = true;
      this.#lastAid = parsed.aid;
      this.#timers?.clearTimeout(this.#quiet);
      // The terminal's screen still shows what was typed: keep it on the copy
      // too (displayed fields only; the record is already redacted).
      applyInbound(this.screen, parsed);
      this.#events.emit('input', parsed);
    }
    if (!header) return redacted;
    const out = new Uint8Array(record.length);
    out.set(header);
    out.set(redacted, 5);
    return out;
  }
}
