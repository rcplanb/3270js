/**
 * Moves bytes between a Terminal and a host. Transports never interpret the
 * bytes. Implementations: WebSocketTransport (browser and Node) and
 * TcpTransport (Node). The host speaks first in telnet, so a transport may
 * start delivering data whenever its connection opens.
 */
export interface Transport {
  send(data: Uint8Array): void;
  /** Returns an unsubscribe function. */
  onData(listener: (data: Uint8Array) => void): () => void;
  /** Called once when the connection ends, from either side. */
  onClose(listener: (reason?: string) => void): () => void;
  close(): void;
}
