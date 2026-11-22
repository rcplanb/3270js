import type { Transport } from '../../src/core/transport.js';

/** An in-memory transport whose host side is driven by the test. */
export class FakeHost implements Transport {
  readonly sent: Uint8Array[] = [];
  closed = false;
  #data = new Set<(d: Uint8Array) => void>();
  #close = new Set<(reason?: string) => void>();

  send(data: Uint8Array): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(data.slice());
  }
  onData(listener: (d: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }
  onClose(listener: (reason?: string) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }
  close(): void {
    this.hangUp('closed by terminal');
  }

  /** Host → terminal. */
  write(data: Uint8Array | number[] | string): void {
    const bytes =
      typeof data === 'string' ? Uint8Array.from(Buffer.from(data, 'hex')) : Uint8Array.from(data);
    for (const l of this.#data) l(bytes);
  }
  /** The host drops the connection. */
  hangUp(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.#close) l(reason);
  }
  /** Everything the terminal sent, as one hex string; then forget it. */
  takeSent(): string {
    const hex = this.sent.map((b) => Buffer.from(b).toString('hex')).join('');
    this.sent.length = 0;
    return hex;
  }
}

/** Telnet negotiation as Hercules does it, ending in 3270 mode. */
export const HERCULES_NEGOTIATION = ['fffd18', 'fffa1801fff0', 'fffb00fffd00', 'fffb19fffd19'];

/** Frame a 3270 record the way a host sends it. */
export function frame(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.map((b) => (b === 'ff' ? 'ffff' : b)).join('') + 'ffef';
}
