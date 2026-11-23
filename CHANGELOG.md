# Changelog

## 0.1.1 (2026-11-23)

- `WebSocketTransport` passes text messages to the embedder: `onText()` and
  `sendText()`, so a server can send control messages on the terminal's own
  socket. Text and bytes sent before the socket opens keep their order.
  Before, text messages were dropped.

## 0.1.0 (2026-11-22)

First release, for SimH Assist. Distributed as a tarball on a GitHub release
(not on npm yet).

**Terminal (Phases 1 and 2)**

- **Terminal and protocols:**
  - a headless 3278/3279 terminal: the 3270 data stream, fields, keyboard, Query Reply and status line
  - TN3270 and **TN3270E** (named LUs, BIND, responses, SSCP-LU, Attn and SysReq), checked against s3270 and OS/390 2.10
- **Extended data stream:**
  - colour, highlighting, field outlining, transparency, and extended-field and character reply modes
  - models 2–5
  - code pages 037, 1047, 500, 285 and 1140, and APL/line-drawing characters
- **Renderers:**
  - DOM and canvas, with x3270's status-line glyphs
  - block selection and copy
  - the optional 3270 font (`3270js/fonts/*`)
- **Transports:** WebSocket, TCP, and a WebSocket-to-TCP proxy.
- **Traces:** record and replay, with passwords redacted.

**Embedding (Phase 3, so far)**

- `SessionObserver`: a passive copy of a session from both directions of its bytes, with redacted input and the host's view of the keyboard lock.
- Screen recognisers (`recognise`, `screenState`): logon, password, `***`, ISPF panels and READY.
- `3270js/script`: `Session` and TSO helpers (logon with reconnect, logoff).
- Docent actions (`parseAction`, `applyAction`): fill fields and press keys as the visitor could, never into password fields.
- `3270js/cast`: asciinema export and command/response pairs.
- `3270js/player`: `TracePlayer`, faithful replay into a renderer.

**Known issues**

- `3270js/node` needs `ws` installed, even for `TcpTransport` (#56).
- Casts repaint the whole screen each frame, about twice the trace's size (#54).
