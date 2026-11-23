import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../../src/core/terminal.js';
import { TcpTransport, createWebSocketProxy, type WebSocketProxy } from '../../../src/node.js';
import { WebSocketTransport } from '../../../src/websocket.js';
import { HERCULES_NEGOTIATION, frame } from '../../helpers/fake-host.js';

const logon = JSON.parse(
  readFileSync(new URL('../../fixtures/datastream/tk5-logon.json', import.meta.url), 'utf8'),
) as { records: string[]; expectedText: string[] };

const hex = (s: string) => Buffer.from(s, 'hex');

/** A TCP server that behaves like Hercules: negotiates, then sends the TK5 logon screens. */
async function fakeHercules() {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  let closedByClient = false;
  const server: Server = createServer((sock) => {
    sockets.push(sock);
    sock.on('data', (d) => received.push(d));
    sock.on('close', () => (closedByClient = true));
    for (const c of HERCULES_NEGOTIATION) sock.write(hex(c));
    setTimeout(() => {
      for (const r of logon.records) sock.write(hex(frame(r)));
    }, 20);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received: () => Buffer.concat(received).toString('hex'),
    closedByClient: () => closedByClient,
    hangUp: () => sockets.forEach((s) => s.destroy()),
    close: () =>
      new Promise<void>((r) => {
        sockets.forEach((sock) => sock.destroy());
        server.close(() => r());
      }),
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('TcpTransport', () => {
  it('runs a Terminal session against a TCP host', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const term = new Terminal();
    await term.connect(new TcpTransport({ host: '127.0.0.1', port: host.port }));
    await until(() => term.text[22]!.startsWith('Logon'));
    expect(term.text).toEqual(logon.expectedText);

    term.type('HELLO');
    term.aid('ENTER');
    await until(() => host.received().includes('c8c5d3d3d6'));
    term.disconnect();
    await until(() => host.closedByClient());
  });

  it('reports a host hang-up', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const term = new Terminal();
    await term.connect(new TcpTransport({ host: '127.0.0.1', port: host.port }));
    const reasons: (string | undefined)[] = [];
    term.on('disconnect', (e) => reasons.push(e.reason));
    host.hangUp();
    await until(() => reasons.length > 0);
    expect(term.connected).toBe(false);
  });

  it('rejects the connection when nothing is listening', async () => {
    const host = await fakeHercules();
    const port = host.port;
    await host.close();
    const term = new Terminal();
    await expect(term.connect(new TcpTransport({ host: '127.0.0.1', port }))).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe('WebSocket proxy + WebSocketTransport', () => {
  async function proxyTo(port: number): Promise<WebSocketProxy> {
    const proxy = await createWebSocketProxy({ targets: { tk5: { host: '127.0.0.1', port } } });
    cleanups.push(() => proxy.close());
    return proxy;
  }

  it('bridges a browser-style session to the TCP host', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const proxy = await proxyTo(host.port);

    const term = new Terminal();
    await term.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270?target=tk5`));
    await until(() => term.text[22]!.startsWith('Logon'));
    expect(term.text).toEqual(logon.expectedText);

    term.type('HELLO');
    term.aid('ENTER');
    await until(() => host.received().includes('c8c5d3d3d6'));
  });

  it('uses the only target when none is named', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const proxy = await proxyTo(host.port);
    const term = new Terminal();
    await term.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270`));
    expect(term.connected).toBe(true);
  });

  it('refuses targets that are not configured (no open relay)', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const proxy = await proxyTo(host.port);
    const term = new Terminal();
    await expect(
      term.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270?target=evil`)),
    ).rejects.toThrow(/unknown target/);
    await expect(
      term.connect(
        new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270?target=hasOwnProperty`),
      ),
    ).rejects.toThrow(/unknown target/);
  });

  it('refuses other paths', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const proxy = await proxyTo(host.port);
    const term = new Terminal();
    await expect(
      term.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/other`)),
    ).rejects.toThrow();
  });

  it('closes the browser side when the host hangs up, and vice versa', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const proxy = await proxyTo(host.port);

    const a = new Terminal();
    await a.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270`));
    let gone = false;
    a.on('disconnect', () => (gone = true));
    host.hangUp();
    await until(() => gone);

    const b = new Terminal();
    await b.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270`));
    b.disconnect();
    await until(() => host.closedByClient());
  });

  it('lets an observer see traffic in both directions', async () => {
    const host = await fakeHercules();
    cleanups.push(host.close);
    const seen: string[] = [];
    let ended = false;
    const proxy = await createWebSocketProxy({
      targets: { tk5: { host: '127.0.0.1', port: host.port } },
      onSession: (s) => {
        s.onTraffic((dir, data) => seen.push(`${dir}:${Buffer.from(data).toString('hex')}`));
        s.onEnd(() => (ended = true));
      },
    });
    cleanups.push(() => proxy.close());
    const term = new Terminal();
    await term.connect(new WebSocketTransport(`ws://127.0.0.1:${proxy.port}/tn3270`));
    await until(() => seen.some((x) => x.startsWith('terminal:')));
    const fromHost = seen
      .filter((x) => x.startsWith('host:'))
      .map((x) => x.slice(5))
      .join('');
    const fromTerminal = seen
      .filter((x) => x.startsWith('terminal:'))
      .map((x) => x.slice(9))
      .join('');
    expect(fromHost.startsWith('fffd18')).toBe(true);
    expect(fromTerminal.startsWith('fffb18')).toBe(true);
    term.disconnect();
    await until(() => ended);
  });

  it('requires at least one target', async () => {
    await expect(createWebSocketProxy({ targets: {} })).rejects.toThrow(/no targets/);
  });
});

describe('WebSocketTransport text messages', () => {
  /** A server that sends `script` on connection and records what it receives, in order. */
  async function server(script: (string | Buffer)[]) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    const received: string[] = [];
    wss.on('connection', (sock) => {
      sock.on('message', (data, isBinary) => {
        const buf = Buffer.from(data as Buffer);
        received.push(isBinary ? `bin:${buf.toString('hex')}` : `text:${buf.toString()}`);
      });
      for (const m of script) sock.send(m, { binary: typeof m !== 'string' });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, received };
  }

  it('delivers text to onText and bytes to onData, separately', async () => {
    const srv = await server(['{"type":"connected"}', Buffer.from([1, 2, 3]), '{"type":"exit"}']);
    const t = new WebSocketTransport(srv.url);
    cleanups.push(() => t.close());
    const texts: string[] = [];
    const bytes: number[][] = [];
    t.onText((s) => texts.push(s));
    t.onData((d) => bytes.push([...d]));
    await until(() => texts.length === 2);
    expect(texts).toEqual(['{"type":"connected"}', '{"type":"exit"}']);
    expect(bytes).toEqual([[1, 2, 3]]);
  });

  it('sends text and bytes in order, including those queued before the socket opened', async () => {
    const srv = await server([]);
    const t = new WebSocketTransport(srv.url);
    cleanups.push(() => t.close());
    t.sendText('first');
    t.send(Uint8Array.of(0xff, 0xfb));
    t.sendText('second');
    await until(() => srv.received.length === 3);
    t.sendText('after open');
    await until(() => srv.received.length === 4);
    expect(srv.received).toEqual(['text:first', 'bin:fffb', 'text:second', 'text:after open']);
  });

  it('stops delivering text after unsubscribing, and sends nothing once closed', async () => {
    const srv = await server(['a']);
    const t = new WebSocketTransport(srv.url);
    const texts: string[] = [];
    const off = t.onText((s) => texts.push(s));
    off();
    t.onData(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(texts).toEqual([]);
    t.close();
    t.sendText('late');
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.received).toEqual([]);
  });
});
