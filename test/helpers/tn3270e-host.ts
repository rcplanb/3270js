/**
 * A scriptable TN3270E *server* (RFC 2355) for tests. Hercules only speaks
 * plain TN3270, so this host is how 3270js's TN3270E support is exercised,
 * and s3270 connects to it too as the reference client.
 *
 * It negotiates TN3270E (device type with optional CONNECT, FUNCTIONS with
 * counter-offers), falls back to plain TN3270 if the client backs off, and
 * then lets the test send typed data messages and observe everything the
 * client sends.
 */
import { type Server, type Socket, createServer } from 'node:net';
import { TelnetFramer } from '../../src/core/trace/framer.js';

export const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
const WILL = 0xfb;
const WONT = 0xfc;
const DO = 0xfd;
const DONT = 0xfe;
const EOR = 0xef;
const IP = 0xf4;
const AO = 0xf5;
const BREAK = 0xf3;
const TTYPE = 24;
const BINARY = 0;
const OPT_EOR = 25;
export const TN3270E = 40;

/** RFC 2355 §3. */
export const Op = {
  ASSOCIATE: 0,
  CONNECT: 1,
  DEVICE_TYPE: 2,
  FUNCTIONS: 3,
  IS: 4,
  REASON: 5,
  REJECT: 6,
  REQUEST: 7,
  SEND: 8,
} as const;
export const Reason = {
  CONN_PARTNER: 0,
  DEVICE_IN_USE: 1,
  INV_ASSOCIATE: 2,
  INV_NAME: 3,
  INV_DEVICE_TYPE: 4,
  TYPE_NAME_ERROR: 5,
  UNKNOWN_ERROR: 6,
  UNSUPPORTED_REQ: 7,
} as const;
export const Fn = {
  BIND_IMAGE: 0,
  DATA_STREAM_CTL: 1,
  RESPONSES: 2,
  SCS_CTL_CODES: 3,
  SYSREQ: 4,
} as const;
/** RFC 2355 §8.1.1. */
export const DataType = {
  DATA_3270: 0,
  SCS_DATA: 1,
  RESPONSE: 2,
  BIND_IMAGE: 3,
  UNBIND: 4,
  NVT_DATA: 5,
  REQUEST: 6,
  SSCP_LU_DATA: 7,
  PRINT_EOJ: 8,
} as const;
export const ResponseFlag = { NO_RESPONSE: 0, ERROR_RESPONSE: 1, ALWAYS_RESPONSE: 2 } as const;

export interface HostScript {
  /** Offer TN3270E (default true). If false, plain TN3270 only. */
  tn3270e?: boolean;
  /** Reject the device-type request with this reason. */
  reject?: number;
  /** LU name to assign when the client doesn't CONNECT to one. Default "LU00001". */
  assignLu?: string;
  /** Functions the server will support. Default BIND-IMAGE, RESPONSES, SYSREQ. */
  functions?: number[];
  /**
   * What to do with a FUNCTIONS REQUEST asking for functions the server lacks:
   * counter-offer the subset (default), or end TN3270E with WONT, as OS/390
   * 2.10 does.
   */
  onUnknownFunction?: 'counter' | 'wont';
}

export interface ClientRecord {
  /** Absent in plain TN3270. */
  header?: { dataType: number; requestFlag: number; responseFlag: number; seq: number };
  data: Uint8Array;
}

export type HostEvent =
  | { kind: 'deviceTypeRequest'; type: string; connect?: string }
  | { kind: 'functionsRequest'; functions: number[] }
  | { kind: 'functionsIs'; functions: number[] }
  | {
      kind: 'negotiated';
      mode: 'tn3270e' | 'tn3270';
      type: string;
      lu?: string;
      functions: number[];
    }
  | { kind: 'wont'; option: number }
  | { kind: 'record'; record: ClientRecord }
  | { kind: 'command'; command: 'IP' | 'AO' | 'BREAK' | number };

/** One connected client, as seen by the host. */
export class HostSession {
  readonly events: HostEvent[] = [];
  mode: 'tn3270e' | 'tn3270' | undefined;
  #seq = 0;
  #waiters: (() => void)[] = [];

  constructor(readonly socket: Socket) {}

  push(e: HostEvent): void {
    this.events.push(e);
    this.#waiters.splice(0).forEach((w) => w());
  }

  /** Resolve with the first event (from now or earlier) matching `pred`. */
  async waitFor<E extends HostEvent>(pred: (e: HostEvent) => e is E, ms?: number): Promise<E>;
  async waitFor(pred: (e: HostEvent) => boolean, ms?: number): Promise<HostEvent>;
  async waitFor(pred: (e: HostEvent) => boolean, ms = 3000): Promise<HostEvent> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(
          `host: timed out; events: ${JSON.stringify(this.events.map((e) => e.kind))}`,
        );
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, left);
      });
    }
  }

  /** Send a data message: a TN3270E header in TN3270E mode, none in plain TN3270. */
  send(
    dataType: number,
    data: Uint8Array | number[],
    responseFlag: number = ResponseFlag.NO_RESPONSE,
  ): number {
    const seq = this.#seq;
    if (dataType === DataType.DATA_3270 || dataType === DataType.SCS_DATA)
      this.#seq = (this.#seq + 1) % 32768;
    const header = this.mode === 'tn3270e' ? [dataType, 0, responseFlag, seq >> 8, seq & 0xff] : [];
    this.socket.write(frame([...header, ...data]));
    return seq;
  }

  /** A 3270-DATA message (an outbound 3270 record). */
  send3270(record: number[] | Uint8Array, responseFlag: number = ResponseFlag.NO_RESPONSE): number {
    return this.send(DataType.DATA_3270, record, responseFlag);
  }

  bind(
    o: { rows?: number; cols?: number; altRows?: number; altCols?: number; plu?: string } = {},
  ): void {
    this.send(DataType.BIND_IMAGE, bindImage(o));
  }
}

function frame(bytes: number[]): Buffer {
  const out: number[] = [];
  for (const b of bytes) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  out.push(IAC, EOR);
  return Buffer.from(out);
}

const ascii = (bytes: number[]) => String.fromCharCode(...bytes);
const sb = (...body: number[]) => Buffer.from([IAC, SB, ...body, IAC, SE]);

/**
 * A BIND request unit with explicit screen sizes (screen-size byte X'7F').
 * Offsets as x3270 reads them (3270ds.h): MAXRU 10/11, sizes 20–24, PLU name 27+.
 */
export function bindImage(
  o: { rows?: number; cols?: number; altRows?: number; altCols?: number; plu?: string } = {},
): number[] {
  const b = new Array<number>(28).fill(0);
  b[0] = 0x31; // BIND
  b[1] = 0x01; // format 0, cold
  b[2] = 0x03; // FM profile 3
  b[3] = 0x03; // TS profile 3
  b[4] = 0xb1;
  b[5] = 0x90;
  b[6] = 0x30;
  b[7] = 0x80;
  b[10] = 0x87; // max RU size secondary
  b[11] = 0xf8; // max RU size primary
  b[14] = 0x02; // LU type 2
  b[20] = o.rows ?? 24;
  b[21] = o.cols ?? 80;
  b[22] = o.altRows ?? o.rows ?? 24;
  b[23] = o.altCols ?? o.cols ?? 80;
  b[24] = 0x7f; // explicit default and alternate sizes
  const plu = ebcdic(o.plu ?? 'TSO');
  b[27] = plu.length;
  return [...b, ...plu];
}
/** Upper-case letters, digits and blanks to EBCDIC (CP037); enough for test text. */
export function ebcdic(text: string): number[] {
  return [...text].map((c) => {
    for (const [first, run] of [
      [0xc1, 'ABCDEFGHI'],
      [0xd1, 'JKLMNOPQR'],
      [0xe2, 'STUVWXYZ'],
      [0xf0, '0123456789'],
    ] as const) {
      const k = run.indexOf(c);
      if (k >= 0) return first + k;
    }
    return 0x40;
  });
}

export interface StartedHost {
  port: number;
  /** Resolves with each client session in turn. */
  next(): Promise<HostSession>;
  close(): Promise<void>;
}

export async function startTn3270eHost(script: HostScript = {}): Promise<StartedHost> {
  const supported = script.functions ?? [Fn.BIND_IMAGE, Fn.RESPONSES, Fn.SYSREQ];
  const sessions: HostSession[] = [];
  const pending: ((s: HostSession) => void)[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const s = new HostSession(socket);
    const framer = new TelnetFramer();
    let deviceType = '';
    let lu: string | undefined;
    let functions: number[] = [];
    let hostEnded = false;

    const negotiated = (mode: 'tn3270e' | 'tn3270') => {
      s.mode = mode;
      s.push({ kind: 'negotiated', mode, type: deviceType, ...(lu ? { lu } : {}), functions });
    };
    const plainNegotiation = () => socket.write(Buffer.from([IAC, DO, TTYPE]));

    socket.on('data', (chunk: Buffer) => {
      for (const item of framer.push(chunk)) {
        if (item.kind === 'record') {
          const d = item.data;
          s.push({
            kind: 'record',
            record:
              s.mode === 'tn3270e' && d.length >= 5
                ? {
                    header: {
                      dataType: d[0]!,
                      requestFlag: d[1]!,
                      responseFlag: d[2]!,
                      seq: (d[3]! << 8) | d[4]!,
                    },
                    data: d.subarray(5),
                  }
                : { data: d },
          });
          continue;
        }
        const c = [...item.data];
        if (c[1] === IP) s.push({ kind: 'command', command: 'IP' });
        else if (c[1] === AO) s.push({ kind: 'command', command: 'AO' });
        else if (c[1] === BREAK) s.push({ kind: 'command', command: 'BREAK' });
        else if (c[1] === WILL && c[2] === TN3270E)
          socket.write(sb(TN3270E, Op.SEND, Op.DEVICE_TYPE));
        else if (c[1] === WONT && c[2] === TN3270E) {
          s.push({ kind: 'wont', option: TN3270E });
          // The client backed off: carry on as plain TN3270 (unless we already have).
          if (!hostEnded) plainNegotiation();
        } else if (c[1] === WILL && c[2] === TTYPE) socket.write(sb(TTYPE, 1));
        else if (c[1] === SB && c[2] === TTYPE && c[3] === 0) {
          deviceType = ascii(c.slice(4, -2));
          socket.write(
            Buffer.from([IAC, WILL, BINARY, IAC, DO, BINARY, IAC, WILL, OPT_EOR, IAC, DO, OPT_EOR]),
          );
          negotiated('tn3270');
        } else if (c[1] === SB && c[2] === TN3270E) {
          const body = c.slice(3, -2);
          if (body[0] === Op.DEVICE_TYPE && body[1] === Op.REQUEST) {
            const rest = body.slice(2);
            const at = rest.indexOf(Op.CONNECT);
            deviceType = ascii(at < 0 ? rest : rest.slice(0, at));
            const connect = at < 0 ? undefined : ascii(rest.slice(at + 1));
            s.push({
              kind: 'deviceTypeRequest',
              type: deviceType,
              ...(connect ? { connect } : {}),
            });
            if (script.reject !== undefined) {
              socket.write(sb(TN3270E, Op.DEVICE_TYPE, Op.REJECT, Op.REASON, script.reject));
            } else {
              lu = connect ?? script.assignLu ?? 'LU00001';
              socket.write(
                sb(
                  TN3270E,
                  Op.DEVICE_TYPE,
                  Op.IS,
                  ...Buffer.from(deviceType),
                  Op.CONNECT,
                  ...Buffer.from(lu),
                ),
              );
            }
          } else if (body[0] === Op.FUNCTIONS && body[1] === Op.REQUEST) {
            const asked = body.slice(2);
            s.push({ kind: 'functionsRequest', functions: asked });
            const agreed = asked.filter((f) => supported.includes(f));
            if (agreed.length === asked.length) {
              functions = asked;
              socket.write(sb(TN3270E, Op.FUNCTIONS, Op.IS, ...asked));
              negotiated('tn3270e');
            } else {
              if (script.onUnknownFunction === 'wont') {
                hostEnded = true;
                socket.write(Buffer.from([IAC, WONT, TN3270E]));
                plainNegotiation();
              } else {
                socket.write(sb(TN3270E, Op.FUNCTIONS, Op.REQUEST, ...agreed)); // counter-offer
              }
            }
          } else if (body[0] === Op.FUNCTIONS && body[1] === Op.IS) {
            functions = body.slice(2);
            s.push({ kind: 'functionsIs', functions });
            negotiated('tn3270e');
          }
        } else if (c[1] === WILL || c[1] === WONT || c[1] === DO || c[1] === DONT) {
          // Other options: nothing to do.
        } else {
          s.push({ kind: 'command', command: c[1]! });
        }
      }
    });

    if (script.tn3270e === false) plainNegotiation();
    else socket.write(Buffer.from([IAC, DO, TN3270E]));

    const waiter = pending.shift();
    if (waiter) waiter(s);
    else sessions.push(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    next: () => {
      const s = sessions.shift();
      return s ? Promise.resolve(s) : new Promise((r) => pending.push(r));
    },
    close: () =>
      new Promise((r) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => r());
      }),
  };
}
