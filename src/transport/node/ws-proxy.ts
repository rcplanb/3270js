/**
 * A WebSocket ↔ TCP bridge for browsers, which cannot open raw TCP. Each
 * WebSocket connection gets its own TCP connection to a host chosen from a
 * fixed set of named targets: clients pick a name, never a host and port, so
 * the proxy cannot be used as an open relay.
 */
import type { IncomingMessage, Server } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface WebSocketProxyOptions {
  /** Named hosts clients may reach, e.g. `{ tk5: { host: '100.113.55.17', port: 3270 } }`. */
  targets: Record<string, ProxyTarget>;
  /** Listen on this port (use 0 for any). Ignored when `server` is given. */
  port?: number;
  /** Interface to listen on. Default `127.0.0.1`. */
  host?: string;
  /** Attach to an existing HTTP server instead of listening. */
  server?: Server;
  /** Only accept upgrades on this path. Default `/tn3270`. */
  path?: string;
  /** Observe each session's traffic (for trace recording). */
  onSession?: (session: ProxySession) => void;
}

export interface ProxySession {
  target: string;
  /** Called with every chunk in each direction. */
  onTraffic(listener: (direction: 'host' | 'terminal', data: Uint8Array) => void): void;
  /** Called once when the session ends, with the reason. */
  onEnd(listener: (reason: string) => void): void;
}

export interface WebSocketProxy {
  /** The port actually listened on (useful with `port: 0`). */
  readonly port: number | undefined;
  close(): Promise<void>;
}

/** WebSocket close code for a refused target (policy violation). */
const POLICY_VIOLATION = 1008;

export async function createWebSocketProxy(
  options: WebSocketProxyOptions,
): Promise<WebSocketProxy> {
  const names = Object.keys(options.targets);
  if (names.length === 0) throw new Error('createWebSocketProxy: no targets configured');

  const path = options.path ?? '/tn3270';
  const wss = options.server
    ? new WebSocketServer({ server: options.server, path })
    : new WebSocketServer({ port: options.port ?? 0, host: options.host ?? '127.0.0.1', path });

  if (!options.server) {
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('target');
    const name = requested ?? (names.length === 1 ? names[0]! : undefined);
    const target =
      name !== undefined && Object.hasOwn(options.targets, name)
        ? options.targets[name]
        : undefined;
    if (!target || name === undefined) {
      ws.close(POLICY_VIOLATION, 'unknown target');
      return;
    }
    bridge(ws, name, target, options.onSession);
  });

  const address = wss.address();
  return {
    port: typeof address === 'object' && address ? address.port : undefined,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

function bridge(
  ws: WebSocket,
  name: string,
  target: ProxyTarget,
  onSession: WebSocketProxyOptions['onSession'],
): void {
  const traffic = new Set<(d: 'host' | 'terminal', data: Uint8Array) => void>();
  const ends = new Set<(reason: string) => void>();
  onSession?.({
    target: name,
    onTraffic: (l) => traffic.add(l),
    onEnd: (l) => ends.add(l),
  });

  const tcp = connect({ host: target.host, port: target.port });
  tcp.setNoDelay(true);
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, reason);
    for (const l of ends) l(reason);
  };

  tcp.on('data', (buf: Buffer) => {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const l of traffic) l('host', bytes);
    ws.send(bytes);
  });
  tcp.on('close', () => end('host closed the connection'));
  tcp.on('error', (err) => end(`host connection failed: ${err.message}`));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const l of traffic) l('terminal', bytes);
    tcp.write(bytes);
  });
  ws.on('close', () => end('client closed'));
  ws.on('error', (err) => end(`client error: ${err.message}`));
}
