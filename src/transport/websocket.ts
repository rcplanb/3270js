/**
 * WebSocketTransport: carries the telnet byte stream over a WebSocket, as
 * binary messages. Works in browsers and in Node 22+ (global WebSocket).
 * The server end is typically createWebSocketProxy() from `3270js/node`.
 */
import type { Transport } from '../core/transport.js';

export interface WebSocketTransportOptions {
  protocols?: string | string[];
}

export class WebSocketTransport implements Transport {
  readonly #ws: WebSocket;
  readonly #data = new Set<(d: Uint8Array) => void>();
  readonly #close = new Set<(reason?: string) => void>();
  #queue: Uint8Array<ArrayBuffer>[] = [];
  #closed = false;

  constructor(url: string | URL, options: WebSocketTransportOptions = {}) {
    this.#ws = new WebSocket(url, options.protocols);
    this.#ws.binaryType = 'arraybuffer';
    this.#ws.addEventListener('open', () => {
      for (const d of this.#queue) this.#ws.send(d);
      this.#queue = [];
    });
    this.#ws.addEventListener('message', (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(e.data);
        for (const l of this.#data) l(bytes);
      }
      // Text messages are not part of the protocol; ignore them.
    });
    this.#ws.addEventListener('close', (e: CloseEvent) =>
      this.#finish(e.reason || `code ${e.code}`),
    );
    this.#ws.addEventListener('error', () => this.#finish('websocket error'));
  }

  send(data: Uint8Array): void {
    if (this.#closed) return;
    // Copy: the DOM typings need an ArrayBuffer-backed view, and the caller may reuse `data`.
    const copy = new Uint8Array(data);
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(copy);
    else this.#queue.push(copy);
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
    if (this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.close(1000, 'closed by terminal');
    }
    this.#finish('closed by terminal');
  }

  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    for (const l of this.#close) l(reason);
  }
}
