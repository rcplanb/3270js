/**
 * Terminal: wires telnet, the data stream, the screen, the keyboard and the
 * OIA together over a Transport. This is the main public API of the core.
 */
import { type CodePage, getCodePage } from './codepage/index.js';
import { type OutboundGeometry, processOutbound } from './datastream/index.js';
import { Emitter } from './events.js';
import { Aid, aidForKey, type AidKey, readBuffer, readModified } from './inbound/index.js';
import {
  Keyboard,
  type KeyAction,
  type KeyboardOptions,
  type KeyResult,
} from './keyboard/index.js';
import { OiaModel, type ConnectionState, type OiaState } from './oia/index.js';
import {
  ReadPartitionType,
  StructuredFieldId,
  buildQueryReply,
  parseStructuredFields,
} from './query/index.js';
import { MODELS, type ModelNumber, Screen } from './screen/index.js';
import { createTelnetSession, type TelnetSession } from './telnet/index.js';
import type { Transport } from './transport.js';

export interface TerminalOptions {
  /** 3278/3279 model: 2 (24×80), 3 (32×80), 4 (43×80) or 5 (27×132). Default 2. */
  model?: ModelNumber;
  /**
   * Colour (3279) or monochrome (3278). Chooses the terminal type announced to
   * the host and is fixed for the life of a connection. Default false.
   */
  color?: boolean;
  /**
   * Announce extended data stream support (the `-E` suffix) and answer the
   * host's Read Partition Query. Default true: TK5's TSO only accepts `-E`
   * terminals. Set false for a plain 3278/3279.
   */
  extendedDataStream?: boolean;
  /** Override the announced terminal type entirely. */
  terminalType?: string;
  /** Code page id or object. Default `cp037`. */
  codePage?: string | CodePage;
  keyboard?: KeyboardOptions;
}

export interface TerminalEvents {
  /** The session reached 3270 mode. */
  connect: undefined;
  disconnect: { reason?: string };
  /** The screen or cursor changed; renderers should repaint dirty rows. */
  render: undefined;
  /** The keyboard became usable. */
  keyboardUnlock: undefined;
  /** The host finished a burst of output and the keyboard is usable. */
  screenSettled: undefined;
  oia: OiaState;
  alarm: undefined;
  /** A protocol problem. The session carries on. */
  error: { message: string };
  /** Data received outside 3270 mode. */
  nvt: Uint8Array;
  /** Every byte received from or sent to the host (for trace recording). */
  traffic: { dir: 'host' | 'terminal'; data: Uint8Array };
}

/** The default screen size for every model; the model size is the alternate. */
const DEFAULT_GEOMETRY = { rows: 24, cols: 80 };

export class Terminal {
  readonly model: ModelNumber;
  readonly color: boolean;
  readonly terminalType: string;
  readonly codePage: CodePage;
  readonly screen: Screen;
  readonly keyboard: Keyboard;
  readonly oia = new OiaModel();

  readonly #events = new Emitter<TerminalEvents>();
  readonly #geometry: OutboundGeometry;
  #transport: Transport | undefined;
  #telnet: TelnetSession | undefined;
  #unsubscribe: (() => void)[] = [];
  #pending: { resolve: () => void; reject: (e: Error) => void } | undefined;
  #lastAid: number = Aid.NONE;
  #wasLocked = true;
  #renderedVersion = -1;

  constructor(options: TerminalOptions = {}) {
    this.model = options.model ?? 2;
    this.color = options.color ?? false;
    const suffix = (options.extendedDataStream ?? true) ? '-E' : '';
    this.terminalType =
      options.terminalType ?? `IBM-${this.color ? 3279 : 3278}-${this.model}${suffix}`;
    const requested = options.codePage ?? 'cp037';
    const cp = typeof requested === 'object' ? requested : getCodePage(requested);
    if (!cp)
      throw new Error(`unknown code page "${typeof requested === 'string' ? requested : ''}"`);
    this.codePage = cp;
    this.#geometry = { default: DEFAULT_GEOMETRY, alternate: MODELS[this.model] };
    this.screen = new Screen(DEFAULT_GEOMETRY.rows, DEFAULT_GEOMETRY.cols);
    this.keyboard = new Keyboard(this.screen, options.keyboard);
    this.#refresh(false);
  }

  get connected(): boolean {
    return this.#telnet?.in3270 ?? false;
  }

  /** The screen as text, one string per row. Non-display fields are blank. */
  get text(): string[] {
    return this.screen.toText(this.codePage);
  }

  on<K extends keyof TerminalEvents>(
    event: K,
    handler: (payload: TerminalEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, handler);
  }
  onKeyboardUnlock(handler: () => void): () => void {
    return this.on('keyboardUnlock', handler);
  }
  onScreenSettled(handler: () => void): () => void {
    return this.on('screenSettled', handler);
  }

  /** Attach a transport. Resolves when the session reaches 3270 mode. */
  connect(transport: Transport): Promise<void> {
    if (this.#transport) return Promise.reject(new Error('already connected'));
    this.#transport = transport;
    this.#telnet = createTelnetSession({ terminalType: this.terminalType });
    this.#lastAid = Aid.NONE;
    const done = new Promise<void>((resolve, reject) => (this.#pending = { resolve, reject }));
    this.#unsubscribe = [
      transport.onData((d) => this.#receive(d)),
      transport.onClose((reason) => this.#closed(reason)),
    ];
    this.#refresh(false);
    return done;
  }

  disconnect(): void {
    this.#transport?.close();
  }

  /** Press a key. Anything the key sends goes to the host. */
  press(action: KeyAction): KeyResult {
    const result = this.keyboard.press(action);
    if (action.type === 'aid' && result.accepted) this.#lastAid = aidForKey(action.key);
    for (const out of result.outputs) {
      if (out.kind === 'record') this.#sendRecord(out.data);
      else this.#send(this.#telnet?.command(out.command));
    }
    this.#refresh(false);
    return result;
  }

  /** Move the cursor (e.g. on a mouse click), as the cursor-select keys of a real terminal do. */
  moveCursor(address: number): void {
    this.screen.cursor = address;
    this.#refresh(false);
  }

  /** Press an AID key: Enter, Clear, PA1–3, PF1–24, SysReq. */
  aid(key: AidKey): KeyResult {
    return this.press({ type: 'aid', key });
  }

  /**
   * Type text at the cursor, following the keyboard rules. Stops at the first
   * character the keyboard refuses and returns that result. Throws RangeError
   * for characters the code page cannot represent.
   */
  type(text: string): KeyResult {
    const bytes = this.codePage.encode(text);
    let result: KeyResult = { accepted: true, outputs: [] };
    for (const byte of bytes) {
      result = this.press({ type: 'char', byte });
      if (!result.accepted) break;
    }
    return result;
  }

  /**
   * Replace the contents of the `index`th unprotected field (0-based, in
   * buffer order): move there, Erase EOF, type `text`.
   */
  fillField(index: number, text: string): KeyResult {
    const field = this.screen.fields.filter((f) => !f.protected)[index];
    if (!field) throw new RangeError(`no unprotected field ${index}`);
    this.screen.cursor = field.dataStart;
    if (field.length > 0) {
      const r = this.press({ type: 'eraseEof' });
      if (!r.accepted) return r;
    }
    return this.type(text);
  }

  #receive(chunk: Uint8Array): void {
    const telnet = this.#telnet;
    if (!telnet) return;
    this.#events.emit('traffic', { dir: 'host', data: chunk });
    let hostWrote = false;
    for (const e of telnet.receive(chunk)) {
      switch (e.type) {
        case 'send':
          this.#send(e.data);
          break;
        case 'record':
          hostWrote = this.#hostRecord(e.data) || hostWrote;
          break;
        case 'mode':
          if (e.in3270) {
            this.keyboard.connected();
            this.#events.emit('connect', undefined);
            this.#pending?.resolve();
            this.#pending = undefined;
          } else {
            this.keyboard.disconnected();
          }
          break;
        case 'nvt':
          this.#events.emit('nvt', e.data);
          break;
        case 'error':
          this.#events.emit('error', { message: e.message });
          break;
        case 'option':
          break;
      }
    }
    this.#refresh(hostWrote);
  }

  /** Apply one host record. Returns true if it was a write. */
  #hostRecord(record: Uint8Array): boolean {
    const r = processOutbound(this.screen, record, this.#geometry);
    for (const message of [...r.errors, ...r.warnings]) this.#events.emit('error', { message });

    if (r.read) {
      const reply =
        r.read === 'buffer'
          ? readBuffer(this.screen, this.#lastAid)
          : readModified(this.screen, this.#lastAid, { all: r.read === 'modifiedAll' });
      this.#sendRecord(reply);
    }
    if (r.structuredFields) this.#structuredFields(r.structuredFields);
    const isWrite =
      r.command === 'W' || r.command === 'EW' || r.command === 'EWA' || r.command === 'EAU';
    if (isWrite) {
      this.keyboard.hostWrite({ keyboardRestore: r.keyboardRestore });
      if (r.keyboardRestore) this.#lastAid = Aid.NONE;
    }
    if (r.alarm) this.#events.emit('alarm', undefined);
    return isWrite;
  }

  /** Write Structured Field. Phase 1 answers Read Partition Query / Query List. */
  #structuredFields(payload: Uint8Array): void {
    const { fields, errors } = parseStructuredFields(payload);
    for (const message of errors) this.#events.emit('error', { message });
    for (const f of fields) {
      const type = f.data[1];
      if (
        f.id === StructuredFieldId.READ_PARTITION &&
        (type === ReadPartitionType.QUERY || type === ReadPartitionType.QUERY_LIST)
      ) {
        const { rows, cols } = this.#geometry.alternate;
        this.#sendRecord(buildQueryReply({ rows, cols, color: this.color }));
      } else {
        const hex = (n: number | undefined) => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
        this.#events.emit('error', {
          message: `unsupported structured field X'${hex(f.id)}'${f.id === StructuredFieldId.READ_PARTITION ? ` type X'${hex(type)}'` : ''}; ignored`,
        });
      }
    }
  }

  #closed(reason?: string): void {
    for (const u of this.#unsubscribe) u();
    this.#unsubscribe = [];
    this.#transport = undefined;
    this.#telnet = undefined;
    this.keyboard.disconnected();
    this.#pending?.reject(new Error(`connection closed${reason ? `: ${reason}` : ''}`));
    this.#pending = undefined;
    this.#events.emit('disconnect', reason === undefined ? {} : { reason });
    this.#refresh(false);
  }

  #sendRecord(data: Uint8Array): void {
    this.#send(this.#telnet?.frameRecord(data));
  }

  #send(data: Uint8Array | undefined): void {
    if (data && this.#transport) {
      this.#events.emit('traffic', { dir: 'terminal', data });
      this.#transport.send(data);
    }
  }

  /** Update the OIA and fire render/unlock/settled events as needed. */
  #refresh(hostWrote: boolean): void {
    const connection: ConnectionState = this.connected
      ? 'connected'
      : this.#transport
        ? 'connecting'
        : 'disconnected';
    const before = this.oia.state;
    this.oia.update({
      connection,
      inhibit: this.keyboard.inhibit,
      operatorError: this.keyboard.operatorError,
      insertMode: this.keyboard.insertMode,
      cursor: this.screen.cursor,
      cols: this.screen.cols,
      model: `${this.color ? 3279 : 3278}-${this.model}`,
    });
    if (this.oia.state !== before) this.#events.emit('oia', this.oia.state);

    if (this.screen.version !== this.#renderedVersion) {
      this.#renderedVersion = this.screen.version;
      this.#events.emit('render', undefined);
    }
    const locked = this.keyboard.isLocked;
    if (this.#wasLocked && !locked) this.#events.emit('keyboardUnlock', undefined);
    this.#wasLocked = locked;
    if (hostWrote && !locked) this.#events.emit('screenSettled', undefined);
  }
}
