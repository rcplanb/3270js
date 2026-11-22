/** A TCP server that replays a trace's host side to one client, a record at a time. */
import { type Server, type Socket, createServer } from 'node:net';
import type { Trace } from '../../src/core/trace/index.js';

export function frameRecord(hex: string): Buffer {
  const out: number[] = [];
  for (const b of Buffer.from(hex, 'hex')) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  out.push(0xff, 0xef);
  return Buffer.from(out);
}

/** Host events grouped into steps: each step ends with one host record. */
export function hostSteps(trace: Trace): { prelude: Buffer; records: Buffer[]; hex: string[] } {
  const host = trace.events.filter((e) => e.dir === 'host');
  const first = host.findIndex((e) => e.kind === 'record');
  const prelude = Buffer.concat(host.slice(0, first).map((e) => Buffer.from(e.hex, 'hex')));
  const records: Buffer[] = [];
  const hex: string[] = [];
  let pending: Buffer[] = [];
  for (const e of host.slice(first)) {
    if (e.kind === 'telnet') pending.push(Buffer.from(e.hex, 'hex'));
    else {
      records.push(Buffer.concat([...pending, frameRecord(e.hex)]));
      hex.push(e.hex);
      pending = [];
    }
  }
  return { prelude, records, hex };
}

export class ReplayHost {
  readonly #server: Server;
  #socket: Socket | undefined;
  #connected: Promise<void>;
  port = 0;

  constructor(prelude: Buffer) {
    let ready!: () => void;
    this.#connected = new Promise((r) => (ready = r));
    this.#server = createServer((sock) => {
      this.#socket = sock;
      sock.on('data', () => undefined); // the terminal's replies are not needed
      sock.on('error', () => undefined);
      sock.write(prelude); // negotiation, so the client's Connect() completes
      ready();
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async send(data: Buffer): Promise<void> {
    await this.#connected;
    this.#socket!.write(data);
  }

  close(): Promise<void> {
    this.#socket?.destroy();
    return new Promise((r) => this.#server.close(() => r()));
  }
}
