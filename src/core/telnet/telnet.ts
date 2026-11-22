/**
 * Telnet for TN3270 (RFC 1576): a pure state machine over bytes.
 *
 * `receive()` takes bytes from the host and returns events in stream order:
 * complete 3270 records, NVT text, bytes to send back, and option/mode
 * changes. It does no I/O, so it runs the same in a browser, Node, or a test.
 *
 * Negotiation is reactive only: we never start one; we answer the host. We
 * reply only when an option's state actually changes, which prevents loops
 * (RFC 854 "Discussion" and RFC 1143).
 *
 * TN3270E (RFC 2355) is accepted when `tn3270e` is given. Once its DEVICE-TYPE
 * and FUNCTIONS negotiation completes, every record carries a 5-byte header.
 * If the host rejects the device type, or the FUNCTIONS negotiation can't
 * agree, we refuse TN3270E (WONT) and the host carries on with plain TN3270,
 * as x3270 does.
 */
import {
  Telnet,
  TelnetOption,
  TerminalType,
  Tn3270eFunction,
  Tn3270eOp,
  Tn3270eReason,
} from './constants.js';

const { IAC, DONT, DO, WONT, WILL, SB, SE, EOR } = Telnet;

/** Options we will enable on our side (answer DO with WILL). */
const LOCAL_SUPPORTED = new Set<number>([
  TelnetOption.BINARY,
  TelnetOption.EOR,
  TelnetOption.TTYPE,
]);
/** Options we let the host enable on its side (answer WILL with DO). */
const REMOTE_SUPPORTED = new Set<number>([TelnetOption.BINARY, TelnetOption.EOR]);

const MAX_SUBNEGOTIATION = 1024;
const DEFAULT_MAX_RECORD = 1 << 20;

export type TelnetSide = 'local' | 'remote';

/** The TN3270E message header. RFC 2355 §8.1. */
export interface Tn3270eHeader {
  dataType: number;
  requestFlag: number;
  responseFlag: number;
  /** 0–32767. */
  seq: number;
}

export interface Tn3270eOptions {
  /** Sent in DEVICE-TYPE REQUEST, e.g. `IBM-3278-2-E`. RFC 2355 names only 3278 types. */
  deviceType: string;
  /** Ask for this LU (device or resource name) with CONNECT. */
  luName?: string;
  /** Functions to ask for. Default BIND-IMAGE, RESPONSES and SYSREQ, as x3270. */
  functions?: number[];
}

const DEFAULT_FUNCTIONS = [
  Tn3270eFunction.BIND_IMAGE,
  Tn3270eFunction.RESPONSES,
  Tn3270eFunction.SYSREQ,
];
const REASONS = Object.fromEntries(
  Object.entries(Tn3270eReason).map(([k, v]) => [v, k.replace(/_/g, '-')]),
) as Record<number, string>;

export type TelnetEvent =
  /**
   * A complete record (IAC undoubled, IAC EOR removed). In TN3270E the header
   * is split off into `header`, and `data` is what follows it.
   */
  | { type: 'record'; data: Uint8Array; header?: Tn3270eHeader }
  /** Data received outside 3270 mode. */
  | { type: 'nvt'; data: Uint8Array }
  /** Bytes the caller must send to the host. */
  | { type: 'send'; data: Uint8Array }
  | { type: 'option'; side: TelnetSide; option: number; enabled: boolean }
  | { type: 'mode'; in3270: boolean; tn3270e: boolean }
  /**
   * Plain TN3270: the host refused the LU asked for with `type@LU` by asking
   * for the terminal type again (RFC 1646). The session can't continue.
   */
  | { type: 'luRefused'; luName: string }
  /** TN3270E negotiation finished: what the host assigned and agreed. */
  | { type: 'tn3270e'; deviceType: string; luName?: string; functions: number[] }
  /** A protocol problem; the session has recovered and carries on. */
  | { type: 'error'; message: string };

export interface TelnetSessionOptions {
  /** Sent in reply to TERMINAL-TYPE SEND, e.g. `IBM-3279-2-E`. Printable ASCII, no spaces. */
  terminalType: string;
  /** Records longer than this are dropped with an error event. Default 1 MiB. */
  maxRecordLength?: number;
  /** Accept TN3270E (RFC 2355). Omit to refuse it, as a plain TN3270 client. */
  tn3270e?: Tn3270eOptions;
  /**
   * Plain TN3270: ask for this LU by sending `terminalType@luName` (RFC 1646,
   * as x3270 does; Hercules uses it to pick a device). A second TERMINAL-TYPE
   * SEND means the host refused it.
   */
  luName?: string;
}

export interface TelnetSession {
  receive(chunk: Uint8Array): TelnetEvent[];
  /**
   * Frame a record for sending: prefix the TN3270E header if given (in
   * TN3270E mode it is required), double any IAC, append IAC EOR.
   */
  frameRecord(data: Uint8Array, header?: Tn3270eHeader): Uint8Array;
  /** A telnet command to send, e.g. IP for the Attn key. */
  command(name: 'IP' | 'BREAK' | 'AO' | 'AYT' | 'NOP'): Uint8Array;
  /**
   * In 3270 mode: TN3270E negotiation completed, or (plain TN3270) BINARY and
   * EOR are on in both directions and TERMINAL-TYPE was accepted.
   */
  readonly in3270: boolean;
  /** TN3270E negotiation completed; records carry headers. */
  readonly tn3270e: boolean;
  /** The functions agreed in TN3270E, empty otherwise. */
  readonly functions: ReadonlySet<number>;
  isEnabled(side: TelnetSide, option: number): boolean;
}

const enum State {
  Data,
  Iac,
  Verb,
  Sb,
  SbIac,
}

export function createTelnetSession(options: TelnetSessionOptions): TelnetSession {
  const { terminalType } = options;
  if (!/^[\x21-\x7e]+$/.test(terminalType)) {
    throw new Error(`terminal type must be printable ASCII without spaces: "${terminalType}"`);
  }
  const plainLu = options.luName;
  if (plainLu !== undefined && !/^[\x21-\x7e]+$/.test(plainLu)) {
    throw new Error(`LU name must be printable ASCII without spaces: "${plainLu}"`);
  }
  const ttypeBytes = Uint8Array.from(plainLu ? `${terminalType}@${plainLu}` : terminalType, (c) =>
    c.charCodeAt(0),
  );
  let ttypeSent = false;
  const maxRecord = options.maxRecordLength ?? DEFAULT_MAX_RECORD;
  const e3270 = options.tn3270e;
  if (e3270) {
    for (const [what, value] of [
      ['device type', e3270.deviceType],
      ['LU name', e3270.luName],
    ] as const) {
      if (value !== undefined && !/^[\x21-\x7e]+$/.test(value))
        throw new Error(`TN3270E ${what} must be printable ASCII without spaces: "${value}"`);
    }
  }
  const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
  const asText = (bytes: number[]) => String.fromCharCode(...bytes);

  const local = new Set<number>();
  const remote = new Set<number>();
  let in3270 = false;
  // TN3270E: refused for the rest of the connection after a failed negotiation.
  let eRefused = !e3270;
  let eNegotiated = false;
  let eFunctions = new Set<number>(e3270?.functions ?? DEFAULT_FUNCTIONS);

  let eDeviceType = '';
  let eLuName: string | undefined;

  let state = State.Data;
  let verb = 0;
  let sb: number[] = [];
  let sbOverflow = false;
  let record: number[] = [];
  let recordOverflow = false;
  let nvt: number[] = [];
  let events: TelnetEvent[] = [];

  const send = (...bytes: number[]) => events.push({ type: 'send', data: Uint8Array.from(bytes) });

  const flushNvt = () => {
    if (nvt.length) {
      events.push({ type: 'nvt', data: Uint8Array.from(nvt) });
      nvt = [];
    }
  };

  const updateMode = () => {
    const tn3270e = local.has(TelnetOption.TN3270E);
    const now = tn3270e
      ? eNegotiated
      : local.has(TelnetOption.BINARY) &&
        remote.has(TelnetOption.BINARY) &&
        local.has(TelnetOption.EOR) &&
        remote.has(TelnetOption.EOR) &&
        local.has(TelnetOption.TTYPE);
    if (now !== in3270) {
      in3270 = now;
      record = [];
      recordOverflow = false;
      events.push({ type: 'mode', in3270, tn3270e: tn3270e && eNegotiated });
    }
  };

  const setOption = (side: TelnetSide, option: number, enabled: boolean) => {
    const set = side === 'local' ? local : remote;
    if (enabled) set.add(option);
    else set.delete(option);
    events.push({ type: 'option', side, option, enabled });
    updateMode();
  };

  const sendFunctions = (op: number) =>
    send(IAC, SB, TelnetOption.TN3270E, Tn3270eOp.FUNCTIONS, op, ...eFunctions, IAC, SE);

  /** Give up on TN3270E: WONT, and the host carries on with plain TN3270. */
  const refuseTn3270e = (why: string) => {
    events.push({ type: 'error', message: `TN3270E refused: ${why}; using TN3270` });
    eRefused = true;
    eNegotiated = false;
    send(IAC, WONT, TelnetOption.TN3270E);
    setOption('local', TelnetOption.TN3270E, false);
  };

  const tn3270eSubnegotiation = (data: number[]) => {
    if (!e3270 || !local.has(TelnetOption.TN3270E)) return;
    const [op, sub] = [data[1], data[2]];
    if (op === Tn3270eOp.SEND && sub === Tn3270eOp.DEVICE_TYPE) {
      const connect = e3270.luName ? [Tn3270eOp.CONNECT, ...ascii(e3270.luName)] : [];
      send(
        IAC,
        SB,
        TelnetOption.TN3270E,
        Tn3270eOp.DEVICE_TYPE,
        Tn3270eOp.REQUEST,
        ...ascii(e3270.deviceType),
        ...connect,
        IAC,
        SE,
      );
    } else if (op === Tn3270eOp.DEVICE_TYPE && sub === Tn3270eOp.IS) {
      const rest = data.slice(3);
      const at = rest.indexOf(Tn3270eOp.CONNECT);
      eDeviceType = asText(at < 0 ? rest : rest.slice(0, at));
      eLuName = at < 0 ? undefined : asText(rest.slice(at + 1));
      sendFunctions(Tn3270eOp.REQUEST);
    } else if (op === Tn3270eOp.DEVICE_TYPE && sub === Tn3270eOp.REJECT) {
      const reason = data[3] === Tn3270eOp.REASON ? data[4] : undefined;
      refuseTn3270e(
        `device type rejected (${reason === undefined ? 'no reason' : (REASONS[reason] ?? reason)})`,
      );
    } else if (op === Tn3270eOp.FUNCTIONS && (sub === Tn3270eOp.REQUEST || sub === Tn3270eOp.IS)) {
      const offered = new Set(data.slice(3));
      const added = [...offered].some((f) => !eFunctions.has(f));
      if (sub === Tn3270eOp.REQUEST) {
        // RFC 2355 §7.2.1: accept a list that adds nothing to ours, else
        // counter with the intersection (never re-adding what they removed).
        if (added) {
          eFunctions = new Set([...eFunctions].filter((f) => offered.has(f)));
          sendFunctions(Tn3270eOp.REQUEST);
          return;
        }
        eFunctions = offered;
        sendFunctions(Tn3270eOp.IS);
      } else {
        if (added) {
          refuseTn3270e('the host insisted on functions we did not ask for');
          return;
        }
        eFunctions = offered;
      }
      eNegotiated = true;
      events.push({
        type: 'tn3270e',
        deviceType: eDeviceType,
        ...(eLuName === undefined ? {} : { luName: eLuName }),
        functions: [...eFunctions],
      });
      updateMode();
    }
  };

  const negotiate = (cmd: number, option: number) => {
    flushNvt();
    switch (cmd) {
      case WILL:
        if (!REMOTE_SUPPORTED.has(option)) send(IAC, DONT, option);
        else if (!remote.has(option)) {
          send(IAC, DO, option);
          setOption('remote', option, true);
        }
        break;
      case WONT:
        // RFC 2355 §7.2.1: a host at an impasse ends TN3270E with WONT (or
        // DONT). OS/390 2.10 does this when asked for a function it doesn't
        // know. Drop TN3270E and let plain TN3270 negotiation follow.
        if (option === TelnetOption.TN3270E && local.has(option)) {
          eRefused = true;
          eNegotiated = false;
          events.push({ type: 'error', message: 'TN3270E ended by the host; using TN3270' });
          send(IAC, WONT, option);
          setOption('local', option, false);
          break;
        }
        if (remote.has(option)) {
          send(IAC, DONT, option);
          setOption('remote', option, false);
        }
        break;
      case DO:
        if (option === TelnetOption.TN3270E && !eRefused) {
          if (!local.has(option)) {
            send(IAC, WILL, option);
            setOption('local', option, true);
          }
        } else if (!LOCAL_SUPPORTED.has(option)) send(IAC, WONT, option);
        else if (!local.has(option)) {
          send(IAC, WILL, option);
          setOption('local', option, true);
        }
        break;
      case DONT:
        if (option === TelnetOption.TN3270E) {
          eRefused = true;
          eNegotiated = false;
        }
        if (local.has(option)) {
          send(IAC, WONT, option);
          setOption('local', option, false);
        }
        break;
    }
  };

  const subnegotiation = (data: number[]) => {
    flushNvt();
    if (
      data[0] === TelnetOption.TTYPE &&
      data[1] === TerminalType.SEND &&
      local.has(TelnetOption.TTYPE)
    ) {
      if (ttypeSent && plainLu) {
        events.push({ type: 'luRefused', luName: plainLu });
        return;
      }
      ttypeSent = true;
      send(IAC, SB, TelnetOption.TTYPE, TerminalType.IS, ...ttypeBytes, IAC, SE);
    } else if (data[0] === TelnetOption.TN3270E) {
      tn3270eSubnegotiation(data);
    }
    // Anything else is an option we refused; ignore it.
  };

  const dataByte = (b: number) => {
    if (!in3270) {
      nvt.push(b);
      return;
    }
    if (recordOverflow) return;
    if (record.length >= maxRecord) {
      recordOverflow = true;
      record = [];
      events.push({ type: 'error', message: `record longer than ${maxRecord} bytes dropped` });
      return;
    }
    record.push(b);
  };

  const endOfRecord = () => {
    flushNvt();
    if (!recordOverflow && record.length) {
      if (eNegotiated && local.has(TelnetOption.TN3270E)) {
        if (record.length < 5) {
          events.push({
            type: 'error',
            message: `TN3270E record shorter than its header; dropped`,
          });
        } else {
          const [dataType, requestFlag, responseFlag, hi, lo] = record as [
            number,
            number,
            number,
            number,
            number,
          ];
          events.push({
            type: 'record',
            header: { dataType, requestFlag, responseFlag, seq: (hi << 8) | lo },
            data: Uint8Array.from(record.slice(5)),
          });
        }
      } else {
        events.push({ type: 'record', data: Uint8Array.from(record) });
      }
    }
    record = [];
    recordOverflow = false;
  };

  /** Handle the byte after an IAC (outside a subnegotiation). */
  const afterIac = (b: number) => {
    switch (b) {
      case IAC:
        dataByte(IAC);
        state = State.Data;
        break;
      case WILL:
      case WONT:
      case DO:
      case DONT:
        verb = b;
        state = State.Verb;
        break;
      case SB:
        sb = [];
        sbOverflow = false;
        state = State.Sb;
        break;
      case EOR:
        endOfRecord();
        state = State.Data;
        break;
      default:
        // NOP, GA, DM, AYT etc. from the host carry no meaning for a 3270.
        state = State.Data;
    }
  };

  const receive = (chunk: Uint8Array): TelnetEvent[] => {
    events = [];
    for (const b of chunk) {
      switch (state) {
        case State.Data:
          if (b === IAC) state = State.Iac;
          else dataByte(b);
          break;
        case State.Iac:
          afterIac(b);
          break;
        case State.Verb:
          negotiate(verb, b);
          state = State.Data;
          break;
        case State.Sb:
          if (b === IAC) state = State.SbIac;
          else if (sb.length < MAX_SUBNEGOTIATION) sb.push(b);
          else if (!sbOverflow) {
            sbOverflow = true;
            events.push({ type: 'error', message: 'subnegotiation too long; ignored' });
          }
          break;
        case State.SbIac:
          if (b === SE) {
            if (!sbOverflow) subnegotiation(sb);
            state = State.Data;
          } else if (b === IAC) {
            if (sb.length < MAX_SUBNEGOTIATION) sb.push(IAC);
            state = State.Sb;
          } else {
            // IAC <cmd> inside SB: the host never closed it. Abandon it and
            // treat the command normally.
            events.push({ type: 'error', message: 'unterminated subnegotiation' });
            afterIac(b);
          }
          break;
      }
    }
    flushNvt();
    return events;
  };

  const frameRecord = (body: Uint8Array, header?: Tn3270eHeader): Uint8Array => {
    const data = header
      ? Uint8Array.of(
          header.dataType,
          header.requestFlag,
          header.responseFlag,
          (header.seq >> 8) & 0xff,
          header.seq & 0xff,
          ...body,
        )
      : body;
    let iacs = 0;
    for (const b of data) if (b === IAC) iacs++;
    const out = new Uint8Array(data.length + iacs + 2);
    let i = 0;
    for (const b of data) {
      out[i++] = b;
      if (b === IAC) out[i++] = IAC;
    }
    out[i++] = IAC;
    out[i] = EOR;
    return out;
  };

  return {
    receive,
    frameRecord,
    command: (name) => Uint8Array.of(IAC, Telnet[name]),
    get in3270() {
      return in3270;
    },
    get tn3270e() {
      return eNegotiated && local.has(TelnetOption.TN3270E);
    },
    get functions() {
      return eNegotiated ? eFunctions : new Set<number>();
    },
    isEnabled: (side, option) => (side === 'local' ? local : remote).has(option),
  };
}
