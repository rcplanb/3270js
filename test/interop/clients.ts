/**
 * The clients the interop suite runs against the TN3270E test host. Each test
 * is written once against `InteropClient`; s3270 is the reference, and 3270js
 * joins the list when it speaks TN3270E (Phase 2 task 1).
 */
import { Terminal } from '../../src/core/terminal.js';
import { TcpTransport } from '../../src/transport/node/tcp.js';
import { S3270, s3270Available } from '../differential/s3270.js';

export interface InteropClient {
  /** Connect, optionally asking for a named LU. Resolves once the telnet session is up. */
  connect(port: number, lu?: string): Promise<void>;
  /** The screen as text rows. */
  text(): Promise<string[]>;
  attn(): Promise<void>;
  sysReq(): Promise<void>;
  enter(): Promise<void>;
  close(): Promise<void>;
}

export interface ClientFactory {
  name: string;
  available: boolean;
  /** Tests (by name) this client can't pass yet, with the plan task that brings them. */
  pending?: Record<string, string>;
  create(): InteropClient;
}

const s3270: ClientFactory = {
  name: 's3270',
  available: s3270Available(),
  create() {
    const s = new S3270(['-model', '3279-2']);
    // s3270 runs actions one at a time, and Connect() only returns once the
    // session is bound (or in plain 3270 mode), so chain every action behind it.
    let chain: Promise<unknown> = Promise.resolve();
    const run = (action: string) => {
      const p = chain.then(() => s.run(action));
      chain = p.catch(() => undefined);
      return p;
    };
    return {
      connect: (port, lu) => {
        void run(`Connect(${lu ? `${lu}@` : ''}127.0.0.1:${port})`).catch(() => undefined);
        return Promise.resolve();
      },
      text: () => run('Ascii()'),
      attn: async () => void (await run('Attn()')),
      sysReq: async () => void (await run('SysReq()')),
      enter: async () => void (await run('Enter()')),
      close: () => {
        s.kill();
        return Promise.resolve();
      },
    };
  },
};

const settle = () => new Promise((r) => setTimeout(r, 100));

const t3270js: ClientFactory = {
  name: '3270js',
  available: true,
  pending: {
    'sends Attn as IAC IP and SysReq as IAC AO': 'task 4',
  },
  create() {
    let term: Terminal | undefined;
    const t = () => {
      if (!term) throw new Error('not connected');
      return term;
    };
    return {
      connect: (port, lu) => {
        term = new Terminal({ model: 2, color: true, ...(lu ? { luName: lu } : {}) });
        void term.connect(new TcpTransport({ host: '127.0.0.1', port })).catch(() => undefined);
        return Promise.resolve();
      },
      text: async () => {
        await settle();
        return t().text;
      },
      attn: async () => {
        t().press({ type: 'attn' });
        await settle();
      },
      sysReq: async () => {
        t().aid('SYSREQ');
        await settle();
      },
      enter: async () => {
        t().aid('ENTER');
        await settle();
      },
      close: () => {
        term?.disconnect();
        return Promise.resolve();
      },
    };
  },
};

export const CLIENTS: ClientFactory[] = [s3270, t3270js];
