# Phase 1 Implementation Plan

> Status: **complete** · 2026-11-22 · Implements [SPEC.md](../SPEC.md) §2 Phase 1. All 22 tasks merged (PRs #4–#28); checkpoints A–D passed. Deviations: Query Reply moved here from Phase 2 (checkpoint B); tasks 5 and 6 shipped together; the minus-function status was deferred to Phase 2.

## Approach

Build from the bottom up: pure, byte-level modules first, then the `Terminal` facade that wires them together, then I/O (transports), then the browser (renderers, keyboard mapping, demo). The core proves itself **headless against the real TK5 system** before any pixels exist. That separates protocol bugs from rendering bugs.

Two design constraints apply from the start, even though the features they serve come later:

- **Observer mode (Phase 3).** SimH Assist's server-side shadow copy has to parse terminal→host records as well as host→terminal ones. So the inbound record _parser_ (not just the generator) is part of Phase 1. The screen model must also accept edits from parsed inbound records, not only from the keyboard.
- **Extended attributes (Phase 2).** Each buffer cell stores colour, highlighting and character set from day one, even though Phase 1 renders only the basic field attributes.

## Components and dependencies

```
 codepage ─┐
 address ──┼─► screen ─► datastream (outbound parse) ─┐
           │      │                                    ├─► Terminal ─► transports ─► demo
           │      ├─► inbound (generate + parse) ──────┤       │
           │      └─► keyboard state machine ──────────┤       └─► renderer iface ─► DOM / canvas
 telnet ───┴───────────────────────────────────────────┘                    keymap ─┘
 oia ─────────────────────────────────────────────────►  (Terminal, renderers)
 trace format ─► replay harness ─► s3270 differential harness
```

These can be built in parallel once the scaffold exists: **codepage**, **address**, **telnet** and **trace format**. Everything else is sequential along the arrows.

## Checkpoints

|       | Gate                                                                                              | Proves                                                        |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **A** | Core unit suite green (tasks 1–9)                                                                 | Parser, screen and keyboard match GA23-0059 at the byte level |
| **B** | A headless Node script logs on to TSO on TK5 through `Terminal` + `TcpTransport` (task 12)        | Protocol works against a real host before any UI exists       |
| **C** | s3270 differential suite green on ≥ 20 TK5 screens (task 14)                                      | No subtle divergence from the reference emulator              |
| **D** | Demo: TSO logon → ISPF edit → save → logoff, DOM and canvas, Chrome, Firefox and Safari (task 21) | Phase 1 success criteria (SPEC §10)                           |

I'll stop for your review at each checkpoint.

## Risks

| Risk                                                                               | Mitigation                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The s3270 differential harness is fiddly, because s3270 needs a host to connect to | Write a tiny Node fake TN3270 server that replays trace records. s3270 connects to it, and we compare its `ReadBuffer` against 3270js. Build it early (task 14) so it guards everything after. |
| Browser key conflicts (F5 reload, Ctrl+W, Safari's handling of function keys)      | Keymap is configurable. Use `preventDefault` only while focused. Test each key per browser in task 21, and document keys that can't be captured, with alternatives.                            |
| No font has the OIA glyphs                                                         | Research task 17 decides before the canvas work. Fallback: draw the OIA symbols as vector paths in both renderers.                                                                             |
| Keyboard edge cases (insert overflow, nulls, wrapping fields)                      | Behaviour tables in the tests, cross-checked against s3270 by driving its keyboard actions in the differential harness.                                                                        |
| TK5 credentials leaking into traces                                                | Recorder redacts non-display field input. A lint check (task 13) fails on known default passwords in `test/traces/`.                                                                           |

---

## Tasks

Each task is one PR. "Verify" commands assume the scaffold from task 0.

### Foundation

- [x] **0. Scaffold the package**
  - Acceptance: `package.json` (name `3270js`, MIT, `exports` map for `.`, `./dom`, `./canvas`, `./websocket` and `./node`, ESM and CJS); `tsconfig` strict; tsup, Vitest, ESLint and Prettier configured; a lint rule forbids DOM and Node globals in `src/core/**`; empty entry points.
  - Verify: `npm run build && npm run typecheck && npm run lint && npm test` all pass. `node -e "require('./dist/index.cjs')"` and an ESM import both work.
  - Files: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `src/*.ts`

### Core (→ Checkpoint A)

- [x] **1. EBCDIC code page CP037**
  - Acceptance: a `CodePage` interface (`toUnicode(byte)` and `fromUnicode(char)`, returning `undefined` when a character can't be mapped); CP037 table; round-trips all 256 bytes where defined; the 3270 control characters (NUL, SUB, DUP, FM, FF, CR, NL, EM, EO) are handled as specified.
  - Verify: `npx vitest run test/unit/core/codepage`
  - Files: `src/core/codepage/{codepage.ts,cp037.ts,index.ts}`, test

- [x] **2. Buffer addressing**
  - Acceptance: decode and encode for 12-bit (with the 6-bit translation table) and 14-bit forms; addresses wrap modulo the buffer size; the encoder picks 12-bit when the address is under 4096 and the session allows it.
  - Verify: `npx vitest run test/unit/core/screen/address`
  - Files: `src/core/screen/address.ts`, test

- [x] **3. Telnet layer**
  - Acceptance: a pure state machine. Bytes in → `{ data records, bytes to send, events }`. It negotiates BINARY, EOR and TERMINAL-TYPE (answering `IBM-3279-2-E` or a configured value), refuses other options, splits records on `IAC EOR`, undoubles IAC on input and doubles it on output, and emits `IAC IP` for Attn. Unknown subnegotiations are ignored safely. Record boundaries are handled when they span TCP chunks.
  - Verify: `npx vitest run test/unit/core/telnet`. Fixtures include the exact negotiation bytes captured from TK5.
  - Files: `src/core/telnet/{telnet.ts,constants.ts}`, test, `test/fixtures/telnet/tk5-negotiation.json`

- [x] **4. Screen model**
  - Acceptance: a cell buffer (character byte; field-attribute flag and value; extended attributes: colour, highlighting, character set); model 2 dimensions (with the other models defined); cursor; `fields` computed lazily and cached until a write (start, length, protected, numeric, display mode, MDT); "no fields" (unformatted) screen handling; dirty-range tracking for renderers.
  - Verify: `npx vitest run test/unit/core/screen`
  - Files: `src/core/screen/{screen.ts,cell.ts,fields.ts,attributes.ts}`, tests

- [x] **5. Outbound data stream: commands, WCC, basic orders**
  - Acceptance: parse and apply W, EW, EWA and EAU (local and SNA codes), WCC (reset, alarm, keyboard restore, reset MDT), and SF, SBA, IC, PT, RA and EUA. Malformed or truncated orders raise a typed error event, not an exception, and the screen stays consistent. Every order has a test citing GA23-0059.
  - Verify: `npx vitest run test/unit/core/datastream`
  - Files: `src/core/datastream/{commands.ts,wcc.ts,orders.ts,apply.ts}`, tests

- [x] **6. Outbound data stream: SFE, SA, MF, GE**
  - Acceptance: parsed and stored in cell extended attributes. GE characters are stored with a flag. SA character attributes are scoped as the spec requires. (Rendering comes in Phase 2.)
  - Verify: `npx vitest run test/unit/core/datastream`
  - Files: `src/core/datastream/{orders.ts,apply.ts}`, tests

- [x] **7. Inbound: generate and parse**
  - Acceptance: AID constants (Enter, Clear, PA1–3, PF1–24, SysReq, no-AID, structured field); Read Modified, Read Modified All and Read Buffer generation; short reads for Clear and the PA keys; nulls suppressed in RM per spec; handling of the RB/RM/RMA commands from the host. A **parser** for inbound records (AID + cursor + SBA/data pairs) for observer mode. Generating then parsing round-trips.
  - Verify: `npx vitest run test/unit/core/inbound`
  - Files: `src/core/inbound/{aid.ts,read.ts,parse.ts}`, tests

- [x] **8. Keyboard state machine**
  - Acceptance: every Phase 1 key action from SPEC §2. Covers protected and numeric enforcement, insert and overtype, insert overflow, Tab and Backtab across wrap, Home, New Line, Delete, Backspace, Erase EOF, Erase Input, Dup, Field Mark and Reset. Lock states (System, Wait, "do not enter here", "too much") behave per GA27-2837. An AID locks the keyboard; a WCC keyboard-restore unlocks it.
  - Verify: `npx vitest run test/unit/core/keyboard` (a table-driven behaviour matrix)
  - Files: `src/core/keyboard/{keyboard.ts,actions.ts}`, tests

- [x] **9. Status line (OIA) model**
  - Acceptance: connection state, keyboard lock reason, insert mode, cursor position and model indicator, with change events. The model is render-neutral: it holds symbol ids, not glyphs.
  - Verify: `npx vitest run test/unit/core/oia`
  - Files: `src/core/oia/oia.ts`, test

### Integration (→ Checkpoints B, C)

- [x] **10. `Terminal` facade**
  - Acceptance: wires telnet → data stream → screen and keyboard → inbound → telnet. Public API per SPEC §3 (`connect`, `screen`, `input.fillField` / `input.aid`, `onKeyboardUnlock`, `onScreenSettled`, `onData` / `onError`). Usable with an in-memory transport.
  - Verify: `npx vitest run test/unit/core/terminal`, using a scripted fake host
  - Files: `src/core/terminal.ts`, `src/core/events.ts`, test

- [x] **11. Transports**
  - Acceptance: the `Transport` interface; `WebSocketTransport` (browser `WebSocket`, binary frames); `TcpTransport` (Node `net`); `createWebSocketProxy()` (WS↔TCP, with a host/port allow-list and no open relay).
  - Verify: unit tests with a loopback TCP server; the proxy test refuses targets not on the allow-list
  - Files: `src/transport/{transport.ts,websocket.ts}`, `src/transport/node/{tcp.ts,ws-proxy.ts}`, tests

- [x] **12. Live smoke script — Checkpoint B**
  - Acceptance: `npm run test:live` connects to `HERCULES_HOST:3270`, waits for the logon screen, logs on to TSO (credentials from env vars, never in the repo), reaches the READY prompt or ISPF, logs off, and prints each screen as text.
  - Verify: run against gpu-server TK5
  - Files: `test/live/tso-logon.test.ts`, `vitest.live.config.ts`

- [x] **13. Trace format, recorder, replay**
  - Acceptance: JSON trace schema (direction, timestamp, hex record; plus metadata for model and code page); a recorder hook in the WS proxy and Terminal, with non-display input redacted; a replay harness that feeds a trace into `Terminal` and snapshots the screen; a credential-scan check over `test/traces/`.
  - Verify: `npx vitest run test/unit/trace`. Record a TK5 logon and replay it with an identical final screen.
  - Files: `src/core/trace/*`, `test/traces/`, `scripts/check-traces.ts`

- [x] **14. s3270 differential harness — Checkpoint C**
  - Acceptance: a Node fake TN3270 server that replays a trace's host records to s3270 and plays its keyboard actions as s3270 actions; compares characters, field attributes and cursor between s3270 and 3270js; ≥ 20 recorded TK5 screens (logon, READY, ISPF primary menu, browse, edit, utilities, the TK5 SDSF equivalent, an error panel); skipped with a warning if s3270 is missing.
  - Verify: `npm test` (the differential suite included)
  - Files: `test/differential/{fake-host.ts,s3270.ts,diff.test.ts}`, `test/traces/tk5/*.json`

### Browser (→ Checkpoint D)

- [x] **15. Renderer interface + shared cell logic**
  - Acceptance: the `Renderer` interface (attach, detach, render dirty ranges, cell metrics, focus, cursor, OIA); shared mapping from cell → visual (display mode, intensity, colour slot); theme tokens for the 3278 green and the 3279 colours.
  - Verify: unit tests
  - Files: `src/renderer/{renderer.ts,cell-style.ts,theme.ts}`, tests

- [x] **16. DOM renderer**
  - Acceptance: run-length spans per row; non-display fields rendered blank (but selectable length preserved); cursor (block or underline, blinking optional); OIA row; repaint only dirty rows; text selection and copy give a plain-text screen; ARIA live region for host writes.
  - Verify: happy-dom unit tests and a Playwright screenshot of three fixture screens
  - Files: `src/renderer/dom/*`, `src/dom.ts`, tests

- [x] **17. Font and OIA glyph research** _(decision task, no product code)_
  - Acceptance: a short ADR in `docs/adr/` choosing the canvas font and how OIA symbols are drawn (font glyphs or vector paths), with licence check. Needs your sign-off.
  - Verify: ADR reviewed
  - Files: `docs/adr/0001-font-and-oia-glyphs.md`

- [x] **18. Canvas renderer**
  - Acceptance: same `Renderer` interface; DPR-aware; font per the ADR; OIA symbols drawn properly; repaint only dirty rows; selection overlay; full-screen paint under 8 ms (SPEC §10).
  - Verify: unit tests, the same Playwright screenshots as task 16, and a paint benchmark
  - Files: `src/renderer/canvas/*`, `src/canvas.ts`, tests

- [x] **19. KeyboardMapper**
  - Acceptance: `KeyboardEvent` → 3270 action using the x3270-style default keymap from SPEC §3; keymap overridable; text input through `beforeinput` / composition (so dead keys and paste work); paste spans fields per 3270 rules; prevents browser defaults only for mapped keys while focused.
  - Verify: unit tests with synthetic events
  - Files: `src/renderer/keymap.ts`, test

- [x] **20. Demo page + dev server**
  - Acceptance: `npm run dev` serves the demo at `http://localhost:5270`, with the WS proxy pointed at `HERCULES_HOST`; renderer toggle (DOM or canvas); model and code-page pickers; trace record button.
  - Verify: manual check against TK5
  - Files: `demo/*`, `scripts/dev.ts`

- [x] **21. E2E + Phase 1 acceptance — Checkpoint D**
  - Acceptance: a Playwright suite (Chromium, Firefox, WebKit) that drives the demo through a TSO logon, ISPF edit, save and logoff against TK5 (`test:e2e:live`), plus offline e2e tests against the fake host; key coverage report per browser; all SPEC §10 Phase 1 criteria checked and recorded in a PR description.
  - Verify: `npm run test:e2e`, then a manual run with you
  - Files: `test/e2e/*`, `playwright.config.ts`

## Not in this plan

TN3270E, Query Reply, colour rendering, models 3–5 (Phase 2), observer mode wiring and SimH Assist integration (Phase 3), npm publishing, and CI workflows (ask first, per spec).
