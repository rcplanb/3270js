# 3270js

An IBM 3270 terminal emulator library for the browser and Node: TN3270 in
TypeScript, an [xterm.js](https://xtermjs.org/) analogue for IBM mainframes.

![ISPF on MVS 3.8j TK5 in 3270js](docs/screenshots/demo-ispf-color.png)

**Status:** v0.3.0 (2026-11-24): Phases 1 to 3 complete. 3270js runs IBM
mainframe sessions in SimH Assist, the museum's internal project for running
historic systems in the browser (not public).
Not yet published to npm; see Install. See [SPEC.md](SPEC.md),
[docs/PLAN.md](docs/PLAN.md) (Phase 1),
[docs/PLAN-phase2.md](docs/PLAN-phase2.md) (Phase 2) and
[docs/PLAN-phase3.md](docs/PLAN-phase3.md) (Phase 3).

- **A complete 3278/3279 terminal, headless.** Telnet negotiation, the 3270
  data stream (every command and order), the field model, the keyboard with
  its locking rules, Read Modified/Buffer, Query Reply, and the status line.
  It has no dependencies and no DOM or Node APIs, so it runs in browsers,
  Node and Workers.
- **TN3270 and TN3270E.** Named LUs (for consoles and specific terminals),
  BIND and UNBIND, responses, VTAM's SSCP-LU mode, Attn and SysReq as
  protocol functions, and the TN3270E status indicators. Checked against a
  real OS/390 2.10 TN3270E server as well as s3270.
- **The extended data stream.** Colour, highlighting, field outlining and
  transparency; extended-field and character reply modes; models 2 to 5
  (up to 27×132); APL and line-drawing characters; code pages 037, 1047,
  500, 285 and 1140.
- **Two renderers.** A DOM renderer (screen-reader announcements) and a
  canvas renderer (DPR-aware), with a live colour/monochrome switch, x3270's
  status-line glyphs, block (rectangular) selection with copy, and the
  optional 3270 font.
- **Real keyboard handling.** PC keys map to 3270 keys, including PF1–24,
  PA1–3, Attn and SysReq, with IME and dead-key input and paste.
- **Transports.** A WebSocket transport for browsers, TCP for Node, and a
  WebSocket-to-TCP proxy that is never an open relay.
- **Scriptable.** Drive a mainframe from Node with no browser, as s3270 does.
- **Session traces.** Record, replay and share sessions, with passwords
  redacted. Replay them in a real terminal (`TracePlayer`), or export them
  to asciinema and from there to MP4: what the operator typed is shown as
  the terminal showed it.
- **A server-side view of a session.** `SessionObserver` keeps a passive
  copy of a session that a relay passes through: the screen as the host
  knows it, hidden fields known and redacted, and the keyboard lock.
  `recognise` names the screen (VTAM logon, password, `***`, ISPF, TSO
  `READY`), and `parseAction`/`applyAction` let an assistant fill fields and
  press keys, never into a password field and never Attn or SysReq.
  `Terminal.adopt` lets the server take the session over on the same
  connection, for example to log off a visitor who closed the page.

## Try it

You need Node 24 and a TN3270 host: for example, Hercules running
[MVS 3.8j TK5](https://www.prince-webdesign.nl/tk5) (`infra/hercules-tk5/`
sets one up in Docker).

```sh
nvm use
npm install
HERCULES_HOST=<host> npm run dev      # then open http://localhost:5270
```

## Install

3270js isn't on npm yet. Each release has a tarball on its
[GitHub release](https://github.com/rcplanb/3270js/releases): commit it to
your project and depend on it.

```sh
mkdir -p vendor && cp 3270js-0.3.0.tgz vendor/
npm install ./vendor/3270js-0.3.0.tgz   # "3270js": "file:vendor/3270js-0.3.0.tgz"
npm install ws@8                         # needed by 3270js/node
```

It needs Node 20 or later, and works from CommonJS (`require`) and ES modules.
`npm run check:pack` installs the tarball into an empty project and loads every
entry point.

## Use it

In a browser:

```ts
import { Terminal } from '3270js';
import { DomRenderer, KeyboardMapper } from '3270js/dom'; // or CanvasRenderer from '3270js/canvas'
import { WebSocketTransport } from '3270js/websocket';

const term = new Terminal({ model: 2, color: true }); // IBM-3279-2-E (IBM-3278-2-E in TN3270E)
const renderer = new DomRenderer(document.getElementById('screen')!);
renderer.attach(term);
new KeyboardMapper(term, renderer).focus();
await term.connect(new WebSocketTransport('wss://example.org/tn3270?target=tk5'));
```

Headless, in Node, from a script:

```ts
import { Terminal } from '3270js';
import { TcpTransport } from '3270js/node';

const term = new Terminal();
await term.connect(new TcpTransport({ host: 'tk5.example', port: 3270 }));
term.onScreenSettled(() => console.log(term.text.join('\n')));
term.type('HERC03');
term.aid('ENTER');
```

An embedding server can share the terminal's WebSocket for its own control
messages: binary messages carry the 3270 session, and text messages are left
to you, with `transport.onText(listener)` and `transport.sendText(text)`. The
terminal never sees them.

Options include `luName` (ask for a specific LU, such as a console),
`codePage` (`cp037`, `cp1047`, `cp500`, `cp285`, `cp1140`) and `tn3270e`
(on by default; hosts that don't offer it get plain TN3270).

For the authentic look, add the optional 3270 font: link
`3270js/fonts/3270.css`. The default theme already lists it first.

The server side of the browser setup is `createWebSocketProxy()` from
`3270js/node`. Browsers can't open TCP connections, so the proxy relays them,
and clients choose a _named_ target from a fixed list.

| Entry point        | Contents                                                       |
| ------------------ | -------------------------------------------------------------- |
| `3270js`           | `Terminal`, the screen and keyboard models, code pages, traces |
| `3270js/dom`       | `DomRenderer`, `KeyboardMapper`                                |
| `3270js/canvas`    | `CanvasRenderer`, `KeyboardMapper`                             |
| `3270js/websocket` | `WebSocketTransport`                                           |
| `3270js/node`      | `TcpTransport`, `createWebSocketProxy`                         |
| `3270js/script`    | `Session`, `tsoLogon`, `tsoLogoff`: drive a session from code  |
| `3270js/cast`      | `traceToCast`, `traceToCommands`: asciinema export             |
| `3270js/player`    | `TracePlayer`: replay a trace into a renderer                  |
| `3270js/fonts/*`   | The optional 3270 font (`3270.css`, WOFF2 and WOFF)            |

Sizes, minified and gzipped: core 17.2 KB, DOM 9.6 KB, canvas 9.8 KB,
WebSocket 0.5 KB. The font is separate (64 KB as WOFF2) and optional.

### Default keys

| 3270             | PC                    |     | 3270                    | PC                  |
| ---------------- | --------------------- | --- | ----------------------- | ------------------- |
| Enter / New Line | Enter / Shift+Enter   |     | Clear                   | Esc                 |
| PF1–12 / PF13–24 | F1–F12 / Shift+F1–F12 |     | Reset                   | Ctrl+R              |
| PA1 / PA2 / PA3  | Alt+1 / Alt+2 / Alt+3 |     | Erase EOF / Erase Input | End / Ctrl+End      |
| Attn / SysReq    | Alt+A / Alt+S         |     | Insert                  | Insert              |
| Dup / Field Mark | Alt+D / Alt+F         |     | Backspace               | Erase (destructive) |

The keymap can be overridden. A browser or the operating system may take some
keys before the page sees them (F11 and F12, for example).

With the mouse, a click moves the cursor; a drag selects a block of the screen
(Shift extends it) and Cmd/Ctrl+C copies it, one line per row.

## How it is tested

| Level        | What                                                                                                                                                                                                       | Command                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Unit         | 401 tests; core coverage 96% statements, 92% branches                                                                                                                                                      | `npm test`                 |
| Interop      | 42 cases against **s3270**: TN3270E negotiation, responses, BIND, SSCP-LU, Attn and SysReq (both clients through a scripted TN3270E host), reply modes byte for byte, and each code page                   | `npm test` (needs `s3270`) |
| Differential | Every screen of six recorded TK5 sessions (monochrome and colour, models 2 to 5) and a 33-key script on seven screens, compared cell for cell with s3270, colour and highlighting included                 | `npm test` (needs `s3270`) |
| Browser      | Chrome, Firefox and WebKit × DOM and canvas: real keystrokes through replayed sessions, screenshot baselines (27×132, outlining, the 3270 font), all key bindings, block selection and copy                | `npm run test:e2e`         |
| Live         | On TK5: log on, ISPF tours (model 2, colour model 5), and **edit, save and verify a member in Revedit** through each renderer. TN3270E was checked by hand against OS/390 2.10 (logon, ISPF, SysReq, Attn) | `npm run test:e2e:live`    |

`npm run check` runs typecheck, lint, the unit, interop and differential
tests, and a scan that keeps passwords out of committed traces.

## What Phase 1 taught us

Each of these was found on a real system and checked against s3270:

- **TK5's TSO only accepts extended (`-E`) terminal types.** A plain
  `IBM-3278-2` loops on `IKT00405I`. An `-E` terminal is sent a Read Partition
  Query, so Query Reply moved into Phase 1. The reply describes a green-only
  3278 unless colour is on.
- **On MVS 3.8, `ALLOCATE` has no DCB keywords.** Define them with `ATTR` and
  apply them with `ALLOC … USING(name)`.
- **A dropped session waits for reconnect.** Use `LOGON user RECONNECT`, then
  PA2 to redraw the panel. Cancelling the user instead can leave VTAM not
  painting the terminal until you press Clear.
- **Hercules negotiates one connection at a time.** A client that connects and
  stays silent blocks everyone until it times out.
- **TSO writes `***` over panels** (`*** e command C6TUTOR…`). Look for a line
  _starting_ with `***`, not ending with one.
- **Revedit (TK5's editor) reads line commands at the right-hand end** of
  `******`: `****I1` works, `I1****` doesn't.
- **Insert mode needs nulls, as on a real 3270.** TK5 fills its fields with
  blanks, so x3270's "blank fill" option (`keyboard.blankFill`) is off by
  default and on in the demo.

## What Phase 2 taught us

Found on OS/390 2.10's TN3270E server (the museum's Multiprise 3000) and
checked against s3270:

- **Answer when asked.** TSO's first write asks for a definite response; without
  one the session sits at X SYSTEM.
- **Respond before replying.** s3270 4.5 sends the positive response even when the
  record produced a reply (a Query Reply, a read), and sends it first. OS/390's
  ISPF waits for it. Older x3270 source does otherwise; the binary is the reference.
- **ISPF writes inside a structured field** (Outbound 3270DS) to unlock the
  keyboard, and draws its boxes with Graphic Escape line-drawing characters.
- **A host can end TN3270E with WONT** when asked for a function it doesn't know
  (s3270's CONTENTION-RESOLUTION, here). Asking only for RFC 2355's functions keeps
  3270js in TN3270E there; it falls back cleanly either way.
- **Named LUs depend on the server.** OS/390's TN3270 server refused every
  CONNECT (`INV-NAME`) and then `type@LU`; Hercules accepts `@device` and `@group`,
  so a 3270 MVS console is `?lu=CONS` on TK5 (see `infra/hercules-tk5`).
- **A 3278 ignores host colours**, as the hardware does: TK5 sends colour to
  monochrome terminals too.
- **A canvas doesn't load web fonts.** The canvas renderer has to ask for its font
  and re-measure, or it draws the 3270 font in the fallback font's cells.

## What Phase 3 taught us

Found while putting TK5 sessions into SimH Assist:

- **Never leave a TSO logon at the password prompt.** MVS keeps the user ID
  (`D TS,L` lists it) and `C U=` doesn't clear it. VTAM `V NET,INACT,ID=CUU0Cn,I`
  and then `ACT` does, and the terminal needs Clear to see the logon screen again.
- **Any word plus Enter at TK5's `Logon ===>` starts a TSO logon.** Tests that
  don't mean to log on type, then Erase Input and Clear.
- **TSO line mode puts `READY` in an unprotected field**, so recognising READY
  has to ignore only what is being typed in the cursor's field, not every input
  field.
- **Read Modified drops nulls.** Text typed on the line below `READY` arrives as
  if typed at the start of the field. Replays put it just before the cursor,
  where the operator typed it.
- **Enter at a password prompt submits a password**, even if
  something else was filled in. An assistant must not act there at all, and
  failed attempts can revoke the ID.

## Roadmap

This is the library's roadmap. How SimH Assist uses 3270js (its user ID pools,
its machines, its consoles) is on SimH Assist's own roadmap.

- **Done (Phases 1 to 3, v0.3.0):** the terminal, TN3270 and TN3270E, the
  extended data stream, both renderers, the transports and the proxy,
  scripting with the TSO helpers, and everything an application needs to
  sit beside a session: an observer that follows a session it doesn't own,
  programmatic actions (fill fields, press an AID), `Terminal.adopt` to take
  a session over from the server, password-redacted traces, `.cast` export
  and the `TracePlayer`. SimH Assist was the first application built on them.
- **Next:**
  - **Publish to npm**, then settle the API for a 1.0.
  - **Recordings as a feature of their own:** render a trace or a scripted
    session to `.cast` or MP4 from the command line; captions and chapter
    marks from the keys and screens already in a trace; scripted, repeatable
    demos; an embeddable replay page.
- **In progress:** a TN3270E test host of our own, OS/390's TN3270E server
  under Hercules, so TN3270E is tested without depending on someone else's
  machine.
- **Phase 4 (far future): graphics (GDDM).** Programmed symbols, vector
  graphics and image display; needs a host with GDDM.
- **Phase 5 (far future): file transfer (IND$FILE).** DFT and CUT modes.
- **Out of scope for now:** printer sessions (LU1/LU3/SCS), DBCS and the
  light pen.

## License

MIT © 2026 Richard Comish. Status-line glyphs and the APL mapping come from
x3270 (BSD-3), the optional font from rbanffy/3270font (BSD-3), and two code
page tables from ICU (Unicode License V3); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
