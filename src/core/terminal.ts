/**
 * Terminal: wires telnet, the data stream, the screen, the keyboard and the
 * OIA together over a Transport. This is the main public API of the core.
 */
import { type CodePage, getCodePage } from './codepage/index.js';
import { type OutboundGeometry, type OutboundResult, processOutbound } from './datastream/index.js';

type OutboundSense = NonNullable<OutboundResult['sense']>;
import { Emitter } from './events.js';
import {
  Aid,
  aidForKey,
  type AidKey,
  readBuffer,
  readModified,
  type ReplyModeState,
} from './inbound/index.js';
import {
  Keyboard,
  type KeyAction,
  type KeyboardOptions,
  type KeyResult,
} from './keyboard/index.js';
import { OiaModel, type ConnectionState, type OiaOwner, type OiaState } from './oia/index.js';
import {
  QueryListType,
  ReadPartitionType,
  ReplyModeCode,
  StructuredFieldId,
  buildQueryReply,
  parseStructuredFields,
} from './query/index.js';
import { MODELS, type ModelNumber, Screen } from './screen/index.js';
import { readSscpLu, writeSscpLu } from './sscp.js';
import {
  Tn3270eDataType,
  Tn3270eFunction,
  Tn3270eResponseFlag,
  createTelnetSession,
  type TelnetSession,
  type Tn3270eHeader,
} from './telnet/index.js';
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
  /** Override the announced terminal type entirely (plain TN3270 and TN3270E). */
  terminalType?: string;
  /**
   * Accept TN3270E (RFC 2355) when the host offers it. Default true. Hosts
   * that don't offer it (Hercules, for one) get plain TN3270 either way.
   */
  tn3270e?: boolean;
  /**
   * Ask the host for this LU (device or pool name), e.g. a console. TN3270E
   * sends it with CONNECT; plain TN3270 appends it to the terminal type as
   * `type@LU` (RFC 1646), which Hercules uses to pick a device.
   */
  luName?: string;
  /** Code page id or object. Default `cp037`. */
  codePage?: string | CodePage;
  keyboard?: KeyboardOptions;
}

export interface TerminalEvents {
  /** The session reached 3270 mode. */
  connect: undefined;
  /** TN3270E negotiation completed. */
  tn3270e: { deviceType: string; luName?: string; functions: number[] };
  /** TN3270E: the host bound an LU-LU session (BIND-IMAGE). */
  bind: BindInfo;
  /** TN3270E: the host ended the LU-LU session. */
  unbind: { reason?: number };
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

/** What a BIND image says about the session. Offsets as x3270 reads them. */
export interface BindInfo {
  /** The primary LU (the application), e.g. `TSO` or `A06TSO01`. */
  plu?: string;
  /** Screen sizes from the presentation-space bytes, when the BIND gives them. */
  defaultSize?: { rows: number; cols: number };
  alternateSize?: { rows: number; cols: number };
  /** The BIND request unit as received. */
  image: Uint8Array;
}

/** The TN3270E session sub-mode, as x3270 tracks it. */
export type SessionMode = 'unbound' | 'lu-lu' | 'sscp-lu' | 'nvt';

/** The default screen size for every model; the model size is the alternate. */
const DEFAULT_GEOMETRY = { rows: 24, cols: 80 };

export class Terminal {
  readonly model: ModelNumber;
  readonly color: boolean;
  readonly terminalType: string;
  /** The device type asked for in TN3270E. RFC 2355 names only 3278 types; colour goes in Query Reply. */
  readonly deviceType: string;
  readonly luName: string | undefined;
  readonly #tn3270e: boolean;
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
  /** TN3270E SEQ-NUMBER for the next 3270-DATA we send. */
  #seq = 0;
  #session: { deviceType: string; luName?: string; functions: number[] } | undefined;
  /** Set Reply Mode state; field mode until the host says otherwise. */
  #reply: ReplyModeState = { mode: 'field' };
  #mode: SessionMode = 'unbound';
  #bind: BindInfo | undefined;
  /** SSCP-LU: where the host's text ended and the operator's input starts. */
  #sscpStart = 0;
  /** While set, outgoing data is held here (so a TN3270E response can go first). */
  #held: Uint8Array[] | undefined;

  constructor(options: TerminalOptions = {}) {
    this.model = options.model ?? 2;
    this.color = options.color ?? false;
    const suffix = (options.extendedDataStream ?? true) ? '-E' : '';
    this.terminalType =
      options.terminalType ?? `IBM-${this.color ? 3279 : 3278}-${this.model}${suffix}`;
    this.deviceType = options.terminalType ?? `IBM-3278-${this.model}${suffix}`;
    this.luName = options.luName;
    this.#tn3270e = options.tn3270e ?? true;
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

  /**
   * TN3270E session state: `unbound` until the host sends a BIND (or SSCP-LU
   * data), then `lu-lu` (an application) or `sscp-lu` (VTAM). Plain TN3270
   * sessions are always `lu-lu` once connected.
   */
  get sessionMode(): SessionMode {
    return this.#telnet?.tn3270e ? this.#mode : 'lu-lu';
  }

  /** The current BIND, in TN3270E. */
  get bindInfo(): BindInfo | undefined {
    return this.#telnet?.tn3270e ? this.#bind : undefined;
  }

  /** The TN3270E session (device type, LU and functions), when one was negotiated. */
  get tn3270e(): { deviceType: string; luName?: string; functions: number[] } | undefined {
    return this.#telnet?.tn3270e ? this.#session : undefined;
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
    this.#telnet = createTelnetSession({
      terminalType: this.terminalType,
      ...(this.luName === undefined ? {} : { luName: this.luName }),
      ...(this.#tn3270e
        ? {
            tn3270e: {
              deviceType: this.deviceType,
              ...(this.luName === undefined ? {} : { luName: this.luName }),
            },
          }
        : {}),
    });
    this.#lastAid = Aid.NONE;
    this.#setReply({ mode: 'field' });
    this.#seq = 0;
    this.#session = undefined;
    this.#mode = 'unbound';
    this.#bind = undefined;
    this.#sscpStart = 0;
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
    if (this.#telnet?.tn3270e) {
      if (action.type === 'attn') return this.#tn3270eAttn();
      if (action.type === 'aid' && action.key === 'SYSREQ') return this.#tn3270eSysReq();
    }
    if (action.type === 'aid' && this.sessionMode === 'sscp-lu') return this.#sscpAid(action.key);
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

  /**
   * Attn on TN3270E (RFC 2355 §11, x3270 Attn_action): telnet IP once a BIND
   * has arrived; on an unbound session the function isn't available (X -f).
   * Plain TN3270 keeps PCOMM's PA1 short read plus telnet BREAK (keyboard.ts).
   */
  #tn3270eAttn(): KeyResult {
    if (!this.#bind) {
      const refused = this.keyboard.minusFunction();
      this.#refresh(false);
      return refused;
    }
    this.#send(this.#telnet?.command('IP'));
    return { accepted: true, outputs: [] };
  }

  /**
   * SysReq on TN3270E (RFC 2355 §10.5, x3270 net_abort): telnet AO, which
   * asks the server to switch the terminal between the application and VTAM's
   * SSCP. Sent only with the SYSREQ function agreed and the session owned by
   * an application or the SSCP; otherwise the key does nothing, as in x3270.
   */
  #tn3270eSysReq(): KeyResult {
    const telnet = this.#telnet;
    if (
      !telnet?.functions.has(Tn3270eFunction.SYSREQ) ||
      (this.#mode !== 'lu-lu' && this.#mode !== 'sscp-lu')
    ) {
      return { accepted: false, outputs: [] };
    }
    this.#send(telnet.command('AO'));
    return { accepted: true, outputs: [] };
  }

  /**
   * An AID key in SSCP-LU mode (x3270 kybd.c): Enter sends the text typed
   * since the host last wrote, as SSCP-LU-DATA, and moves to the next line;
   * Clear clears the screen locally; other AIDs are refused (the status line's
   * minus-function indicator arrives in task 3).
   */
  #sscpAid(key: AidKey): KeyResult {
    // Locked (e.g. by X -f): AID keys are ignored until Reset, as in x3270.
    if (this.keyboard.isLocked) {
      return {
        accepted: false,
        outputs: [],
        rejected: this.keyboard.inhibit ?? 'operatorError',
      };
    }
    const screen = this.screen;
    if (key === 'CLEAR') {
      screen.clear();
      this.#sscpStart = 0;
    } else if (key === 'ENTER') {
      const input = readSscpLu(screen, this.#sscpStart);
      const row = Math.floor(screen.cursor / screen.cols);
      if (row === screen.rows - 1) {
        writeSscpLu(screen, Uint8Array.of(0x15), screen.cursor); // NL scrolls
        screen.cursor = (screen.rows - 1) * screen.cols;
      } else {
        screen.cursor = (row + 1) * screen.cols;
      }
      this.#sscpStart = screen.cursor;
      this.#sendRecord(input, Tn3270eDataType.SSCP_LU_DATA);
    } else {
      const refused = this.keyboard.minusFunction();
      this.#refresh(false);
      return refused;
    }
    this.#refresh(false);
    return { accepted: true, outputs: [] };
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
          if (e.header) hostWrote = this.#tn3270eRecord(e.header, e.data) || hostWrote;
          else hostWrote = this.#hostRecord(e.data).isWrite || hostWrote;
          break;
        case 'tn3270e': {
          const session = {
            deviceType: e.deviceType,
            ...(e.luName === undefined ? {} : { luName: e.luName }),
            functions: e.functions,
          };
          this.#session = session;
          this.#events.emit('tn3270e', session);
          break;
        }
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
        case 'luRefused': {
          // As s3270 ("Cannot connect to specified LU"): give up and say why.
          const transport = this.#transport;
          this.#closed(`the host refused LU ${e.luName}`);
          transport?.close();
          return;
        }
      }
    }
    this.#refresh(hostWrote);
  }

  /**
   * Route a TN3270E message by its data type. Returns true if it was a write.
   * BIND, UNBIND, responses and SSCP-LU data are Phase 2 task 2.
   */
  #tn3270eRecord(header: Tn3270eHeader, data: Uint8Array): boolean {
    const functions = this.#telnet?.functions ?? new Set<number>();
    const binds = functions.has(Tn3270eFunction.BIND_IMAGE);
    switch (header.dataType) {
      case Tn3270eDataType.DATA_3270: {
        // With BIND-IMAGE agreed, 3270 data before a BIND is ignored (x3270).
        if (binds && !this.#bind) return false;
        this.#mode = 'lu-lu';
        // s3270 sends its response before any reply the record produces.
        const held: Uint8Array[] = (this.#held = []);
        const r = this.#hostRecord(data);
        this.#held = undefined;
        this.#respond(header, r.sense);
        for (const d of held) this.#send(d);
        return r.isWrite;
      }
      case Tn3270eDataType.BIND_IMAGE:
        if (!binds) return false;
        this.#bind = parseBind(data, this.codePage);
        this.#events.emit('bind', this.#bind);
        return false;
      case Tn3270eDataType.UNBIND:
        if (!binds) return false;
        this.#bind = undefined;
        this.#mode = 'unbound';
        this.screen.resize(DEFAULT_GEOMETRY.rows, DEFAULT_GEOMETRY.cols);
        this.screen.clear();
        this.#events.emit('unbind', data.length ? { reason: data[0]! } : {});
        return false;
      case Tn3270eDataType.SSCP_LU_DATA:
        if (this.#mode !== 'sscp-lu') {
          this.#mode = 'sscp-lu';
          this.#sscpStart = this.screen.cursor;
        }
        this.screen.cursor = this.#sscpStart = writeSscpLu(this.screen, data, this.screen.cursor);
        this.keyboard.hostWrite({ keyboardRestore: true });
        this.#lastAid = Aid.NONE;
        return true;
      case Tn3270eDataType.NVT_DATA:
        this.#mode = 'nvt';
        this.#events.emit('nvt', data);
        this.#respond(header, undefined);
        return false;
      case Tn3270eDataType.RESPONSE:
      case Tn3270eDataType.REQUEST:
        return false;
      default:
        this.#events.emit('error', {
          message: `TN3270E data type X'${header.dataType.toString(16).toUpperCase().padStart(2, '0')}' not supported; ignored`,
        });
        return false;
    }
  }

  /**
   * TN3270E responses (RFC 2355 §10.4.1), as s3270 4.5 sends them: a negative
   * response for an error unless the host asked for none; otherwise a positive
   * one for ALWAYS-RESPONSE, even when the record produced a reply (a read or
   * a Query Reply). OS/390's ISPF waits for it after its Read Partition Query.
   */
  #respond(header: Tn3270eHeader, sense: OutboundSense | undefined): void {
    const telnet = this.#telnet;
    if (!telnet?.functions.has(Tn3270eFunction.RESPONSES)) return;
    const wanted = header.responseFlag;
    if (wanted === Tn3270eResponseFlag.NO_RESPONSE) return;
    let flag: number;
    let status: number;
    if (sense) {
      flag = Tn3270eResponseFlag.NEGATIVE;
      status = sense === 'operationCheck' ? 0x02 : 0x00;
    } else if (wanted === Tn3270eResponseFlag.ALWAYS_RESPONSE) {
      flag = Tn3270eResponseFlag.POSITIVE;
      status = 0x00; // device end
    } else {
      return;
    }
    this.#send(
      telnet.frameRecord(Uint8Array.of(status), {
        dataType: Tn3270eDataType.RESPONSE,
        requestFlag: 0,
        responseFlag: flag,
        seq: header.seq,
      }),
    );
  }

  #setReply(reply: ReplyModeState): void {
    this.#reply = reply;
    this.keyboard.reply = reply.mode === 'field' ? undefined : reply;
  }

  /** The reply mode the host set with Set Reply Mode (field mode by default). */
  get replyMode(): ReplyModeState {
    return this.#reply;
  }

  /** Apply one host record. */
  #hostRecord(record: Uint8Array): { isWrite: boolean; sense?: OutboundSense } {
    const r = processOutbound(this.screen, record, this.#geometry, { color: this.color });
    for (const message of [...r.errors, ...r.warnings]) this.#events.emit('error', { message });

    // An Erase/Write with the WCC reset bit returns to field reply mode (x3270 ctlr_write).
    if (r.wccReset && (r.command === 'EW' || r.command === 'EWA'))
      this.#setReply({ mode: 'field' });
    if (r.read) {
      const reply =
        r.read === 'buffer'
          ? readBuffer(this.screen, this.#lastAid, this.#reply)
          : readModified(this.screen, this.#lastAid, {
              all: r.read === 'modifiedAll',
              reply: this.#reply,
            });
      this.#sendRecord(reply);
    }
    let sense = r.sense;
    let isWrite =
      r.command === 'W' || r.command === 'EW' || r.command === 'EWA' || r.command === 'EAU';
    if (r.structuredFields) {
      const sf = this.#structuredFields(r.structuredFields);
      sense ??= sf.sense;
      isWrite ||= sf.isWrite;
    }
    if (isWrite && r.command !== 'WSF') {
      this.keyboard.hostWrite({ keyboardRestore: r.keyboardRestore });
      if (r.keyboardRestore) this.#lastAid = Aid.NONE;
    }
    if (r.alarm) this.#events.emit('alarm', undefined);
    return sense ? { isWrite, sense } : { isWrite };
  }

  /**
   * Write Structured Field (x3270 sf.c): Read Partition (Query, Query List,
   * and RB/RM/RMA reads), Set Reply Mode, and Outbound 3270DS (a write carried
   * in a structured field, which OS/390's ISPF uses). Anything else, or a
   * partition other than the implicit one, is a command reject.
   */
  #structuredFields(payload: Uint8Array): { isWrite: boolean; sense?: OutboundSense } {
    const { fields, errors } = parseStructuredFields(payload);
    let isWrite = false;
    let sense: OutboundSense | undefined = errors.length ? 'commandReject' : undefined;
    for (const message of errors) this.#events.emit('error', { message });
    for (const f of fields) {
      const partition = f.data[0];
      const type = f.data[1];
      if (
        f.id === StructuredFieldId.READ_PARTITION &&
        (type === ReadPartitionType.QUERY || type === ReadPartitionType.QUERY_LIST) &&
        partition === 0xff
      ) {
        const { rows, cols } = this.#geometry.alternate;
        // Query List type List names the replies wanted; Equivalent and All get everything.
        const only =
          type === ReadPartitionType.QUERY_LIST && f.data[2] === QueryListType.LIST
            ? [...f.data.subarray(3)]
            : undefined;
        this.#sendRecord(
          buildQueryReply({ rows, cols, color: this.color, ...(only ? { only } : {}) }),
        );
      } else if (
        f.id === StructuredFieldId.READ_PARTITION &&
        partition === 0x00 &&
        (type === ReadPartitionType.READ_BUFFER ||
          type === ReadPartitionType.READ_MODIFIED ||
          type === ReadPartitionType.READ_MODIFIED_ALL)
      ) {
        // Reads of the implicit partition answer with the Query Reply AID (x3270 sf_read_part).
        this.#sendRecord(
          type === ReadPartitionType.READ_BUFFER
            ? readBuffer(this.screen, Aid.QUERY_REPLY, this.#reply)
            : readModified(this.screen, Aid.QUERY_REPLY, {
                all: type === ReadPartitionType.READ_MODIFIED_ALL,
                reply: this.#reply,
              }),
        );
      } else if (
        f.id === StructuredFieldId.SET_REPLY_MODE &&
        partition === 0x00 &&
        (type === ReplyModeCode.FIELD ||
          type === ReplyModeCode.EXTENDED_FIELD ||
          type === ReplyModeCode.CHARACTER)
      ) {
        this.#setReply(
          type === ReplyModeCode.FIELD
            ? { mode: 'field' }
            : type === ReplyModeCode.EXTENDED_FIELD
              ? { mode: 'extendedField' }
              : { mode: 'character', attributes: [...f.data.subarray(2)] },
        );
      } else if (
        f.id === StructuredFieldId.OUTBOUND_3270DS &&
        f.data[0] === 0x00 &&
        // W, EW, EWA, EAU (SNA command codes, as x3270 sf_outbound_ds).
        (type === 0xf1 || type === 0xf5 || type === 0x7e || type === 0x6f)
      ) {
        const r = this.#hostRecord(f.data.subarray(1));
        isWrite ||= r.isWrite;
        sense ??= r.sense;
      } else {
        sense ??= 'commandReject';
        const hex = (n: number | undefined) => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
        this.#events.emit('error', {
          message: `unsupported structured field X'${hex(f.id)}'${f.id === StructuredFieldId.READ_PARTITION ? ` type X'${hex(type)}'` : ''}; ignored`,
        });
      }
    }
    return sense ? { isWrite, sense } : { isWrite };
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

  #sendRecord(data: Uint8Array, dataType: number = Tn3270eDataType.DATA_3270): void {
    const telnet = this.#telnet;
    if (telnet?.tn3270e) {
      // RFC 2355 §10.4: count every 3270-DATA sent, wrapping at 32767.
      const seq = this.#seq;
      if (dataType === Tn3270eDataType.DATA_3270) this.#seq = (seq + 1) % 32768;
      this.#send(
        telnet.frameRecord(data, {
          dataType,
          requestFlag: 0,
          responseFlag: 0,
          seq,
        }),
      );
    } else {
      this.#send(telnet?.frameRecord(data));
    }
  }

  #send(data: Uint8Array | undefined): void {
    if (data && this.#held) {
      this.#held.push(data);
      return;
    }
    if (data && this.#transport) {
      this.#events.emit('traffic', { dir: 'terminal', data });
      this.#transport.send(data);
    }
  }

  /** The TN3270E part of the status line: B, the session owner and the LU. */
  #oiaSession(): { tn3270e: boolean; owner: OiaOwner; luName?: string } {
    const session = this.tn3270e;
    if (!session)
      return { tn3270e: false, owner: 'lu-lu', ...(this.luName ? { luName: this.luName } : {}) };
    const owner: OiaOwner = (
      { 'lu-lu': 'lu-lu', 'sscp-lu': 'sscp', unbound: 'unbound', nvt: 'nvt' } as const
    )[this.#mode];
    return { tn3270e: true, owner, ...(session.luName ? { luName: session.luName } : {}) };
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
      ...this.#oiaSession(),
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

/**
 * Parse a BIND request unit (x3270 process_bind; offsets from 3270ds.h).
 * Screen-size byte 0x7E: default and alternate are both rows×cols at 20/21;
 * 0x7F: default at 20/21, alternate at 22/23; 0x00/0x02: 24×80; 0x03: the
 * alternate is the model's size (left undefined here).
 */
export function parseBind(image: Uint8Array, codePage: CodePage): BindInfo {
  const info: BindInfo = { image: Uint8Array.from(image) };
  if (image[0] !== 0x31) return info;
  const ss = image[24];
  if (image.length > 24) {
    if (ss === 0x00 || ss === 0x02) {
      info.defaultSize = info.alternateSize = { rows: 24, cols: 80 };
    } else if (ss === 0x03) {
      info.defaultSize = { rows: 24, cols: 80 };
    } else if (ss === 0x7e) {
      info.defaultSize = info.alternateSize = { rows: image[20]!, cols: image[21]! };
    } else if (ss === 0x7f) {
      info.defaultSize = { rows: image[20]!, cols: image[21]! };
      info.alternateSize = { rows: image[22]!, cols: image[23]! };
    }
  }
  const len = image[27];
  if (len !== undefined && len > 0 && len <= 8 && image.length >= 28 + len) {
    info.plu = codePage.decode(image.subarray(28, 28 + len)).trimEnd();
  }
  return info;
}
