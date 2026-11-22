// Node-only entry point (3270js/node): direct TCP transport and the WebSocket proxy.
export { TcpTransport } from './transport/node/tcp.js';
export type { TcpTransportOptions } from './transport/node/tcp.js';
export { createWebSocketProxy } from './transport/node/ws-proxy.js';
export type {
  ProxySession,
  ProxyTarget,
  WebSocketProxy,
  WebSocketProxyOptions,
} from './transport/node/ws-proxy.js';
