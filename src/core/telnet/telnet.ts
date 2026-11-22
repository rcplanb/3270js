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
 */
import { Telnet, TelnetOption, TerminalType } from './constants.js';

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

export type TelnetEvent =
  /** A complete 3270 data stream record (IAC undoubled, IAC EOR removed). */
  | { type: 'record'; data: Uint8Array }
  /** Data received outside 3270 mode. */
  | { type: 'nvt'; data: Uint8Array }
  /** Bytes the caller must send to the host. */
  | { type: 'send'; data: Uint8Array }
  | { type: 'option'; side: TelnetSide; option: number; enabled: boolean }
  | { type: 'mode'; in3270: boolean }
  /** A protocol problem; the session has recovered and carries on. */
  | { type: 'error'; message: string };

export interface TelnetSessionOptions {
  /** Sent in reply to TERMINAL-TYPE SEND, e.g. `IBM-3279-2-E`. Printable ASCII, no spaces. */
  terminalType: string;
  /** Records longer than this are dropped with an error event. Default 1 MiB. */
  maxRecordLength?: number;
}

export interface TelnetSession {
  receive(chunk: Uint8Array): TelnetEvent[];
  /** Frame a 3270 record for sending: double any IAC and append IAC EOR. */
  frameRecord(data: Uint8Array): Uint8Array;
  /** A telnet command to send, e.g. IP for the Attn key. */
  command(name: 'IP' | 'BREAK' | 'AO' | 'AYT' | 'NOP'): Uint8Array;
  /** BINARY and EOR are on in both directions and TERMINAL-TYPE was accepted. */
  readonly in3270: boolean;
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
  const ttypeBytes = Uint8Array.from(terminalType, (c) => c.charCodeAt(0));
  const maxRecord = options.maxRecordLength ?? DEFAULT_MAX_RECORD;

  const local = new Set<number>();
  const remote = new Set<number>();
  let in3270 = false;

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
    const now =
      local.has(TelnetOption.BINARY) &&
      remote.has(TelnetOption.BINARY) &&
      local.has(TelnetOption.EOR) &&
      remote.has(TelnetOption.EOR) &&
      local.has(TelnetOption.TTYPE);
    if (now !== in3270) {
      in3270 = now;
      record = [];
      recordOverflow = false;
      events.push({ type: 'mode', in3270 });
    }
  };

  const setOption = (side: TelnetSide, option: number, enabled: boolean) => {
    const set = side === 'local' ? local : remote;
    if (enabled) set.add(option);
    else set.delete(option);
    events.push({ type: 'option', side, option, enabled });
    updateMode();
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
        if (remote.has(option)) {
          send(IAC, DONT, option);
          setOption('remote', option, false);
        }
        break;
      case DO:
        if (!LOCAL_SUPPORTED.has(option)) send(IAC, WONT, option);
        else if (!local.has(option)) {
          send(IAC, WILL, option);
          setOption('local', option, true);
        }
        break;
      case DONT:
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
      send(IAC, SB, TelnetOption.TTYPE, TerminalType.IS, ...ttypeBytes, IAC, SE);
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
      events.push({ type: 'record', data: Uint8Array.from(record) });
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

  const frameRecord = (data: Uint8Array): Uint8Array => {
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
    isEnabled: (side, option) => (side === 'local' ? local : remote).has(option),
  };
}
