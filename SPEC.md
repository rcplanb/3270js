# Spec: 3270js

> Status: **approved** · 2026-11-22 · Phase 1 and Phase 2 complete

## 1. Objective

**3270js** is an open-source TypeScript library that emulates an IBM 3270 display terminal (3278/3279) over TN3270 and TN3270E. It does for IBM mainframes what xterm.js does for DEC-style and serial terminals.

The first consumer is SimH Assist (to be renamed). It will use 3270js to put mainframe simulators (Hercules running MVS 3.8j TK5, VM/370 CE and similar) in the browser next to its existing VT100 machines. It is a standalone package with no SimH Assist–specific code, so other projects can use it too.

### Why not c3270 inside xterm.js

That would show a 3270 through a VT100 rendering. Field boundaries, extended colours and highlighting, and the status line would all be approximated, and the 3270 keyboard (PF13–24, PA1–3, Reset, Attn, SysReq) would be awkward. Tools that read the screen, like the Virtual Docent, would have to scrape a curses rendering instead of reading a field model.

### Users

- **Embedders:** web developers putting a 3270 session in a page, the way xterm.js is embedded.
- **Server-side automation:** Node code that needs a headless 3270, the way s3270 is used. This covers screen scraping, scripted logons and SimH Assist's Docent bridge.
- **End users:** people using the embedding app. They expect it to look and behave like a real 3278/3279 (or x3270).

### Key design fact

A 3270 is a **block-mode terminal with local intelligence**, not a stream renderer. The terminal itself:

- owns the field map
- handles all editing locally
- locks the keyboard
- answers Query
- sends back only the modified fields when an AID key is pressed (Enter, Clear, a PF or PA key)

So 3270js is a complete terminal emulator. Its core is a headless state machine, and renderers only display that state.

## 2. Scope

### Phase 1: Core MVP (TN3270, model 2)

- **Telnet:** negotiate BINARY, TERMINAL-TYPE and EOR. Announce `IBM-3278-2-E` (monochrome) or `IBM-3279-2-E` (colour); `extendedDataStream: false` drops the `-E`. Frame records with `IAC EOR` and handle IAC doubling.
- **Query Reply** _(moved from Phase 2 at checkpoint B, 2026-11-22)_. TK5's TSO only accepts `-E` terminals and sends them Read Partition Query. A plain `IBM-3278-2` gets `IKT00405I SCREEN ERASURE CAUSED BY ERROR RECOVERY PROCEDURE` in a loop; s3270 behaves the same. So Phase 1 answers Read Partition Query and Query List with Summary, Usable Area, Alphanumeric Partitions, Character Sets, Color, Highlighting, Reply Modes (field mode only) and Implicit Partition. Each was checked byte for byte against s3270. The Color reply describes a green-only 3278 unless `color` is on. _(This reverses the checkpoint A decision to announce plain `IBM-3278-2`, which rested on the wrong assumption that dropping `-E` avoids the query.)_
- **Commands:** W, EW, EWA, EAU, WSF, RB, RM, RMA, accepting both the local (0xF1 …) and SNA (0x01 …) codes.
- **WCC:** reset, sound alarm, keyboard restore, reset MDT.
- **Orders:** SF, SBA, IC, PT, RA, EUA, plus SFE, SA and MF (parsed and stored even before rendering supports every attribute). GE is parsed and its character stored.
- **Addressing:** 12-bit (6-bit encoded) and 14-bit buffer addresses.
- **Field model:** protected, numeric, intensified, non-display, light-pen-detectable and MDT.
- **Keyboard state machine:** character entry, insert/overtype, Tab/Backtab, Home, New Line, cursor movement, Delete, Backspace, Erase EOF, Erase Input, Dup, Field Mark, Reset, Clear, Enter, PF1–24, PA1–3, and Attn (on TN3270: a PA1 short read plus `IAC BREAK`, as x3270 does; on TN3270E: `IAC IP`). Keyboard lock and unlock follow the 3270 rules, including input inhibited (X) and the "do not enter here" and "too much" errors. Insert mode only shifts into nulls, as on a real 3270. x3270's `blankFill` (trailing blanks count as room) is an option, **off by default** for fidelity; SimH Assist will turn it on, because TK5 fills input fields with blanks. _(Decided at checkpoint A.)_
- **Inbound:** Read Modified, Read Modified All and Read Buffer generation, including short reads for Clear and the PA keys.
- **Code pages:** EBCDIC CP037. The code-page interface is pluggable.
- **Status line (OIA) model:** connection state, keyboard lock reason, insert mode and cursor position.
- **Renderers:** DOM and canvas, both implementing the same `Renderer` interface.
- **Transports:** WebSocket (browser and Node) and raw TCP (Node only).

### Phase 2: TN3270E and extended data stream — complete _(2026-11-22)_

_Already delivered during Phase 1:_ Query Reply (Read Partition Query and Query List), the colour/monochrome setting (`color` and the renderers' live `displayMode`, with 3279 base colours), rendering of extended colour and highlighting, and EWA switching for models 3–5. What remains:

- **TN3270E** (RFC 2355):
  - DEVICE-TYPE negotiation, including CONNECT to a named LU and falling back to TN3270 when refused
  - FUNCTIONS negotiation (BIND-IMAGE, RESPONSES, SYSREQ)
  - the 5-byte header and sequence numbers
  - positive and negative responses
  - BIND/UNBIND and the SSCP-LU and LU-LU session states, shown in the status line (underlined B, the LU name)
- **Attn and SysReq as TN3270E functions.**
- The **minus-function** status (`X -f`, as on Richard's 3278-2 photo). In x3270 it is set when a key's function isn't available in the current session state, such as Attn on an unbound TN3270E session or most AID keys in SSCP-LU mode. Those states arrive with TN3270E, so the indicator does too. _(Deferred from the ADR 0001 follow-ups, 2026-11-22.)_
- **Reply modes:** Set Reply Mode, with the extended-field and character modes (SA orders in inbound data), and the other Read Partition types (RB, RM, RMA).
- **Colour and highlighting verified:** extend the s3270 differential to character and extended field attributes, on recorded 3279 sessions. Render field outlining and transparency.
- **Models 3, 4 and 5 verified live** (EWA to 32×80, 43×80 and 27×132 on TK5), with recorded traces.
- **More code pages:** 1047, 500, 285 and 1140 (with the euro), using the existing generator.
- **APL:** draw GE and APL-set characters as their real APL glyphs.
- **Block selection and copy** _(requested 2026-11-22)_: drag a rectangle of cells, as in IBM's emulators, and copy it to the system clipboard, in both renderers.
- **The optional 3270 font** (ADR 0001): `3270js/fonts/3270-Regular.woff` plus `@font-face` CSS and its licence notice.

### Phase 3: Embedding and integration features

_Already delivered during Phase 1:_ `onKeyboardUnlock` and `onScreenSettled`, programmatic input (`press`, `type`, `fillField`, `aid`, `moveCursor`), session traces with password redaction and replay, and `toText` with non-display fields blanked. What remains, mostly for SimH Assist:

- **Observer mode:** a passive server-side copy that follows both directions of a session (decided at Open Question 1), built on `parseInbound` and the trace recorder's shadow screen.
- **SimH Assist integration:** prompt detection from screen state, Docent field injection, password-safe session logging and replay.
- **A public scripting helper**, for example `waitFor(text)` and `then type`. It should include the recovery patterns the live tests learned: RECONNECT, PA2 to reshow, Clear, `CANCEL`, and TSO `***` paging.

### Phase 4: Graphics (GDDM) — far future _(logged 2026-11-22)_

The museum wants to show that these terminals were not text-only. GDDM drove three kinds of graphics on 3270-family displays, and each would get its own Query Replies and structured fields:

- **Programmed symbols:** host-loadable character sets, as on the 3279-S3G. Character-cell graphics, charts and custom fonts.
- **Vector graphics:** the graphics terminals (3179G, 3192G), which took drawing orders (lines, arcs, areas, text) in structured fields.
- **Image (bitmap) display.**

Notes for when it starts:

- **Rendering:** the canvas renderer is the natural basis. The DOM renderer would overlay a canvas.
- **Documentation:** gather IBM's data-stream manuals for programmed symbols, graphics and image, and record them in an ADR before any design.
- **A host with GDDM is a hard prerequisite.** MVS 3.8/TK5 has none. Candidates are a licensed OS/390 or VM system (for example the museum's Multiprise 3000), or recorded traces from one.

### Phase 5: File transfer (IND$FILE) — far future _(logged 2026-11-22)_

Send and receive files with the host's `IND$FILE` program, as x3270 and IBM's emulators do:

- **DFT mode:** structured-field transfer, advertised with the DDM Query Reply. 3270js leaves DDM out of its Query Reply until this exists.
- **CUT mode:** the older transfer through screen writes, for hosts without DFT.
- **Options:** text or binary, ASCII/EBCDIC and CR/LF translation, and host options (TSO or CMS, `RECFM`, `LRECL`, `BLKSIZE`, `SPACE`).
- **API:** a browser file picker and download, Node files, and progress and cancel.
- **Tests:** compare with x3270's transfers. TK5 (MVS 3.8) and OS/390 both provide the host side; check TK5's `IND$FILE` first.

### Out of scope (for now)

Printer sessions (LU1/LU3/SCS), DBCS, light pen, and the SimH Assist rename. Graphics have moved to Phase 4, and file transfer to Phase 5.

## 3. Architecture

```
                ┌────────────────────────────────────────────┐
                │ core (pure TS, zero deps, no DOM, no Node) │
  bytes ⇄  ──── │  telnet ─► tn3270e ─► datastream ─► screen │ ──► events / state
 Transport      │                     ◄─ inbound  ◄─ keyboard│ ◄── key actions
                │  codepages · query replies · OIA model     │
                └────────────────────────────────────────────┘
                         ▲                         │ state + dirty ranges
                         │ key actions             ▼
                ┌────────────────────────────────────────────┐
                │ Renderer interface: DomRenderer, CanvasRenderer │
                │ + KeyboardMapper (browser keys → 3270 actions)  │
                └────────────────────────────────────────────┘
```

- **core** works the same in the browser, Node and Workers, and is the only layer with protocol logic. Every module is a pure function or a small state machine over `Uint8Array`, so it's easy to test.
- **Renderer** is an interface. A renderer subscribes to the screen model, repaints dirty cells, draws the cursor and OIA, and reports its cell metrics. It never changes screen state directly.
- **KeyboardMapper** turns browser `KeyboardEvent`s into 3270 actions using a configurable keymap. The default follows x3270's (PF1–12 on F1–F12, PF13–24 on Shift+F1–F12, PA1/PA2 on Alt+1/Alt+2, Clear on Esc, Reset on Ctrl+R, and Enter on Enter, with Right Ctrl as Enter optional).
- **Transport** is an interface: `send(bytes)`, `onData`, `onClose`, `close()`. It moves bytes only and never interprets them.

### Public API sketch (illustrative, not final)

```ts
import { Terminal } from '3270js';
import { DomRenderer } from '3270js/dom';
import { WebSocketTransport } from '3270js/websocket';

const term = new Terminal({ model: '3279-2-E', codePage: 'cp037' });
term.attach(new DomRenderer(document.getElementById('screen')!));
await term.connect(new WebSocketTransport('wss://example/tn3270?host=hercules&port=3270'));

term.onKeyboardUnlock(() => console.log(term.screen.toText()));
term.screen.fields; // read-only field list
term.input.fillField(3, 'HERC01'); // programmatic input
term.input.aid('ENTER');
```

### Package layout

There is a single npm package, with subpath exports instead of a monorepo:

| Import             | Contents                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `3270js`           | `Terminal`, core types, code pages                                                                        |
| `3270js/dom`       | `DomRenderer`, CSS                                                                                        |
| `3270js/canvas`    | `CanvasRenderer`                                                                                          |
| `3270js/websocket` | `WebSocketTransport`                                                                                      |
| `3270js/node`      | `TcpTransport`, `createWebSocketProxy()` (a small WS↔TCP bridge used by the dev harness and by embedders) |

It ships as both ESM and CJS. SimH Assist's browser code imports ESM, and its server code uses `require()`.

## 4. Tech Stack

- TypeScript 6.0 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. (TypeScript 7 is out, but typescript-eslint supports only versions below 6.1.)
- **Zero runtime dependencies** in core and the renderers. The `/node` entry may use `ws` as a peer dependency.
- The library runs on Node ≥ 20. Development needs Node 24 LTS (`.nvmrc`), because Vitest 5 and tsup 9 require it. Target browsers: current evergreen Chrome, Firefox, Safari and Edge.
- Build: `tsup` (ESM, CJS and `.d.ts`)
- Test: Vitest, plus `happy-dom` for DOM renderer unit tests, plus Playwright for browser end-to-end and visual tests
- Lint and format: ESLint (typescript-eslint) and Prettier
- Dev-only oracle: `s3270` from the x3270 suite (`brew install x3270`), used for differential tests (see §7)

## 5. Commands

```
npm install
npm run build          # tsup → dist/ (esm, cjs, d.ts)
npm test               # vitest run (unit + differential, no network)
npm run test:watch     # vitest
npm run test:coverage  # vitest run --coverage
npm run test:e2e       # playwright test (browser; needs `npx playwright install`)
npm run test:live      # opt-in: runs scripts against a live Hercules (HERCULES_HOST/PORT)
npm run lint           # eslint . && prettier --check .
npm run format         # prettier --write .
npm run typecheck      # tsc --noEmit
npm run dev            # demo page + WS↔TCP proxy at http://localhost:5270
```

## 6. Project Structure

```
src/
  core/
    telnet/         telnet option negotiation, IAC/EOR framing
    tn3270e/        TN3270E subnegotiation + header (phase 2)
    datastream/     command, WCC and order parsing (outbound) and read generation (inbound)
    screen/         buffer, attributes, field model, addressing
    keyboard/       3270 keyboard state machine (actions → buffer edits + AIDs)
    query/          Query Reply builders (phase 2)
    codepage/       EBCDIC ⇄ Unicode tables
    oia/            status line model
    terminal.ts     Terminal facade wiring the above together
  renderer/
    renderer.ts     Renderer interface + shared cell/colour logic
    dom/            DomRenderer
    canvas/         CanvasRenderer
    keymap.ts       KeyboardMapper + default keymap
  transport/
    websocket.ts
    node/tcp.ts, node/ws-proxy.ts
  index.ts, dom.ts, canvas.ts, websocket.ts, node.ts   (entry points)
test/
  unit/             mirrors src/
  traces/           recorded host sessions (*.trace.json) + expected screens
  differential/     same input through 3270js and s3270; screens must match
  e2e/              Playwright specs against the demo page
  live/             opt-in Hercules scripts
demo/               dev harness page
docs/               API docs, architecture notes, protocol notes with GA23-0059 references
SPEC.md, README.md, LICENSE (MIT), CHANGELOG.md
```

## 7. Testing Strategy

- **Unit (Vitest), most of the suite.** Every command, order, WCC bit, attribute and keyboard action gets byte-level tests: input bytes → expected buffer, fields, cursor and outbound bytes. Address encoding, EBCDIC tables and the keyboard edge cases are all tested this way. Those edge cases include insert overflow, Dup and Field Mark, nulls in read-back, fields that wrap past the last cell, and a screen with a single field or none.
- **Trace replay.** Sessions recorded from Hercules are stored as JSON (direction, timestamp and hex bytes for each record) along with expected screen snapshots. A recorder in the dev proxy produces them. Traces must not contain passwords; the recorder replaces non-display field input with placeholders.
- **Differential against s3270.** The same host byte stream is fed to 3270js and to `s3270`, and the screens must match: characters, field attributes and cursor. This is the main defence against subtle misbehaviour. CI installs x3270, and these tests are skipped with a warning when `s3270` is missing.
- **Renderers.** happy-dom unit tests check the DOM structure and classes. Playwright screenshot tests cover both renderers on a fixed set of screens (TSO logon, ISPF primary menu, a colour test panel).
- **Live (opt-in).** Scripts log on to TSO on TK5, move around in ISPF, edit and save a member, then log off. These run against a Hercules instance and never in default CI.
- **Coverage targets:** core ≥ 90% of lines and branches; renderers ≥ 70%.
- **TDD:** for core work, write the failing byte-level test first.

## 8. Code Style

- Prettier defaults with `printWidth: 100` and single quotes. ESLint `recommended-type-checked`.
- Named exports only, no default exports. File names are kebab-case.
- Protocol constants live in `const` objects with spec names, never as magic numbers inline.
- Comments cite the spec section when behaviour is subtle (`// GA23-0059 §4.3.3`, `// RFC 2355 §8`).
- No classes in parsers. Use plain functions over `Uint8Array` that return values or emit edits. Classes are fine for stateful facades (`Terminal`, renderers).
- No `any`. Use `unknown` and narrow it.

```ts
// src/core/datastream/orders.ts
export const Order = {
  SF: 0x1d, // Start Field
  SBA: 0x11, // Set Buffer Address
  IC: 0x13, // Insert Cursor
  RA: 0x3c, // Repeat to Address
} as const;

/** Decode a 2-byte buffer address (12-bit or 14-bit form). GA23-0059 §3.3 */
export function decodeAddress(b1: number, b2: number): number {
  const mode = b1 & 0xc0;
  if (mode === 0x00) return ((b1 & 0x3f) << 8) | b2; // 14-bit
  return ((b1 & 0x3f) << 6) | (b2 & 0x3f); // 12-bit
}
```

## 9. Boundaries

- **Always:**
  - Run `npm run typecheck && npm run lint && npm test` before every commit.
  - Write the byte-level test first for protocol behaviour.
  - Keep core free of DOM and Node APIs. Lint enforces this.
  - Cite GA23-0059 or the RFC section for non-obvious behaviour.
  - Update this spec when scope or a decision changes.
- **Ask first:**
  - Adding any runtime dependency.
  - Changing the public API shape once it's in the README.
  - Creating the GitHub repo, pushing, or publishing to npm.
  - Adding CI workflows.
  - Changing the default keymap.
- **Never:**
  - Push to `main` directly. Use PRs.
  - Commit IBM manuals (PDFs) or mainframe disk images. Link to them instead.
  - Commit credentials or traces containing real passwords.
  - Copy x3270 source code. Read it for behaviour and keep our own implementation clean.
  - Remove or skip a failing test without approval.

## 10. Success Criteria

**Phase 1 is done when:**

1. Using the demo page with **both** the DOM and canvas renderers against Hercules running TK5, a user can log on to TSO, open ISPF, edit a PDS member, save it, and log off. No visible differences from x3270 on those screens.
2. All PF1–24, PA1–3, Clear, Reset, Attn and Erase EOF keys work from a standard US keyboard in Chrome, Firefox and Safari.
3. Differential tests pass on at least 20 recorded TK5 screens (logon, ISPF panels, browse, edit, SDSF or its TK5 equivalent).
4. Core coverage is ≥ 90%, and `npm test` passes with no network access.
5. Core bundle size is ≤ 40 KB minified and gzipped. Each renderer is ≤ 15 KB.
6. Rendering a full model 2 screen paints in under 8 ms on a mid-range laptop.

**Phase 2 is done when:** a TN3270E connection to a named LU works, Query Reply is accepted by ISPF and colour panels render in 3279 colours, and model 5 (27×132) works through EWA.

**Phase 3 is done when:** SimH Assist runs a 3270 machine with prompt detection, Docent field injection, hidden-field log redaction and session replay, using only the public 3270js API.

## 11. Open Questions

1. ~~**Where the core runs inside SimH Assist.**~~ **Decided 2026-11-22:** the authoritative core runs in the browser, and SimH Assist runs a passive shadow core on the server. The shadow core parses both directions of the byte stream and relays to Hercules. This mirrors a real 3270 attached to a 3174 establishment controller. The server copy provides the screen model for the Docent, logging and redaction, and injected input is sent to the browser terminal. The library must therefore support a headless core that is fed both inbound and outbound records (an "observer" mode) as well as the normal interactive mode.
2. ~~**Hercules test environment.**~~ **Decided 2026-11-22:** Docker on `gpu-server` (tailnet only), running MVS 3.8j TK5 Update 5 on SDL Hyperion 4.9.1. See `infra/hercules-tk5/`. **Finding:** Hercules' 3270 server negotiates plain TN3270 only, not TN3270E. Phase 2 TN3270E work needs a second target, such as a TN3270E-capable server or proxy. Still open: which one.
3. **Fonts for the canvas renderer.** Bundle an open 3270 font (for example the SIL OFL "3270" font), or use the system monospace font by default? **Requirement:** the status line must show the real OIA symbols, including the Attn and SysReq indicators, the input-inhibited "X" with clock, and the "do not enter" symbol. A system monospace font won't have these, so whichever font we pick must include them (or we draw them ourselves).
4. ~~**Attn and SysReq mapping**~~ **Resolved:** follow x3270. Attn on TN3270 sends a PA1 short read plus `IAC BREAK`; on TN3270E it sends `IAC IP`. SysReq on TN3270 sends the test-request read (SOH % / STX); on TN3270E it sends `IAC AO` (Phase 2).
5. **npm name.** `3270js` (unscoped) is currently free. Confirm we publish unscoped and don't reserve a scope for future addons.

## 12. References

- RFC 854 / 855 / 856 / 885 / 1091 (telnet, BINARY, EOR, TERMINAL-TYPE)
- RFC 1576 (TN3270 current practices), RFC 2355 (TN3270E)
- IBM GA23-0059, _3270 Data Stream Programmer's Reference_
- IBM GA27-2837, _3174 Functional Description_ (keyboard behaviour)
- x3270 / s3270 documentation and behaviour (BSD-licensed, used as the reference oracle)
- xterm.js (API design inspiration: addons, renderer abstraction, `onX` event style)
