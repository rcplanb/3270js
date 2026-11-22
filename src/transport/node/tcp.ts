/** TcpTransport: a direct TCP connection to a TN3270 host (Node only). */
import { type Socket, connect } from 'node:net';
import type { Transport } from '../../core/transport.js';

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** Milliseconds to wait for the TCP connection. Default 10000. */
  connectTimeout?: number;
}

export class TcpTransport implements Transport {
  readonly #socket: Socket;
  readonly #data = new Set<(d: Uint8Array) => void>();
  readonly #close = new Set<(reason?: string) => void>();
  #closed = false;
  #error: string | undefined;

  constructor(options: TcpTransportOptions) {
    this.#socket = connect({ host: options.host, port: options.port });
    this.#socket.setNoDelay(true);
    this.#socket.setTimeout(options.connectTimeout ?? 10_000, () => {
      this.#error = 'connect timeout';
      this.#socket.destroy();
    });
    this.#socket.once('connect', () => this.#socket.setTimeout(0));
    this.#socket.on('data', (buf: Buffer) => {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      for (const l of this.#data) l(bytes);
    });
    this.#socket.on('error', (err) => (this.#error = err.message));
    this.#socket.on('close', () => this.#finish(this.#error ?? 'connection closed by host'));
  }

  send(data: Uint8Array): void {
    if (!this.#closed) this.#socket.write(data);
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  close(): void {
    this.#error ??= 'closed by terminal';
    this.#socket.destroy();
  }

  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const l of this.#close) l(reason);
  }
}
