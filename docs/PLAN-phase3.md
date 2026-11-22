# Phase 3 Implementation Plan

> Status: **decisions recorded, for review** · 2026-11-22 · Implements [SPEC.md](../SPEC.md) §2 Phase 3

## Goal

IBM mainframe sessions in SimH Assist, alongside its existing xterm.js
terminals:

- A visitor picks a mainframe (TK5 under Hercules first) and gets a real
  3270 in the browser.
- The Docent can see the screen and help: suggest a command, fill in a
  field, press Enter.
- The session is logged without passwords and can be replayed, including in
  asciinema-player and as MP4, as SimH Assist does for its other machines.

## What SimH Assist is today

From a read-only survey of `~/Development/Projects/simh-assist`.

**Stack**

- Node 20, CommonJS, Express 5, `ws` and SQLite.
- Vanilla HTML pages, no bundler.
- Tests: `node --test`. CI: GitHub Actions.
- Deployed with systemd, nginx and rsync. Gitflow (`develop`, `main`).

**Terminals**

- **xterm.js only.** The browser and server talk over a JSON WebSocket (`input` and `output` strings).
- **Telnet machines** use the server's own `TelnetClient`, which has VT100 only and no BINARY, EOR or TN3270E.

**Machines**

- A `machines` table, with `kind` limited by a CHECK constraint to `ephemeral-template`, `persistent-template` and `telnet-target`.
- The connection type is derived from `kind`.

**Prompt detection**

- Regexes on the last text line of a line buffer.
- It gates Docent injection, and drives password redaction in the logger.

**Docent**

- An external service calls `/api/docent/terminal/state`, then `/inject {command}`.
- Injection writes `command + "\r"`, and is refused at a password prompt.

**Logging**

- asciinema v2 `.cast` files (80×24, VT100), with prompt-based password redaction.
- Derived `session_commands` rows.
- Replay in asciinema-player, and MP4 export through `agg`.

**Fit with 3270js:**

- Its CommonJS server can `require('3270js/node')`; the package declares Node 20 or later and ships a CJS build.
- Its pages can load `3270js/dist/*.js` as ES modules from `express.static`, as they already do for xterm.

## Architecture (decided at SPEC Open Question 1)

```
browser                        SimH Assist server                  host
┌──────────────────┐  binary   ┌────────────────────────────┐  TCP ┌─────────┐
│ Terminal (3270js)│◄────WS───►│ relay ── SessionObserver ──│◄────►│Hercules │
│ authoritative    │           │  (passive copy of screen)  │      │ / OS/390│
│ DOM/canvas, keys │◄─JSON WS─►│ Docent bridge, logger      │      └─────────┘
└──────────────────┘ (control) └────────────────────────────┘
```

- **The browser's 3270js terminal is authoritative.** It negotiates with the host through the relay, and owns the keyboard and the screen.
- **The server relays bytes, and a passive `SessionObserver` follows both directions**, like a 3174 controller. This passive copy:
  - gives the Docent the screen
  - tells the logger which fields are hidden
  - shows when the host is waiting for input
- **The Docent never types into the host directly.** The server sends the browser an _action_ (fill these fields, press this AID), and the browser's terminal performs it, as if the visitor had. So the screen, the keyboard rules and the status line stay consistent.

## Tasks

Two repositories:

- **Tasks 0–6** are library work in **3270js**, ending in a release.
- **Tasks 7–12** are integration work in **simh-assist**, as PRs into its `develop` branch, which you merge, as here.
- **Task 13**, OS/390 under Hercules, is infrastructure, done in parallel.

Each task is one PR.

### 3270js: the library side (→ Checkpoint H)

- [x] **0. `SessionObserver`: the passive copy**
  - Acceptance:
    - A headless class fed raw bytes from both directions (`host(chunk)`, `terminal(chunk)`).
    - It follows the telnet and TN3270E negotiation, BIND, UNBIND, SSCP-LU and Outbound 3270DS, with the same logic as the trace recorder, which is then rebuilt on it.
    - It exposes:
      - the screen and fields
      - the cursor
      - the TN3270E session state
      - whether the host has restored the keyboard
    - Events:
      - `hostWrite`
      - `ready`: the keyboard is unlocked and the host is quiet
      - `input`: the AID and field contents, parsed with `parseInbound`, hidden fields redacted
  - Verify:
    - Every recorded trace (TK5 colour and models 2–5, OS/390 TN3270E) is fed through both a `SessionObserver` and a real `Terminal`; the screens must match after every record.
    - The redaction tests from #47 also run against the observer.
  - Done:
    - `src/core/observer/`, exported from `3270js` (ESM and CJS).
    - `ready` needs `timers` (`{ setTimeout, clearTimeout }`) from the embedder, because the core is platform-neutral and may not touch `globalThis`.
    - The keyboard lock is the host's view: an operator's AID locks it, and a restoring write (or the first write) unlocks it. Host-requested replies don't lock it.
    - The trace recorder is now built on the observer, so there's one redaction path.
    - Equivalence: all 9 recorded traces (TK5 mono, colour and models 2–5; OS/390 TN3270E; synthetic) match `Terminal` cell for cell after every host record.

- [x] **1. Screen recognisers and readiness**
  - Acceptance:
    - Small, composable matchers over a screen: text anywhere, text on a row, the field after a label, a regex over the screen text.
    - A `ready` notion that SimH Assist can use instead of prompt regexes: the keyboard is unlocked, the host has been quiet for N ms, and an optional matcher holds.
    - Built-in recognisers for TK5 and OS/390, from the live tests:
      - VTAM logon
      - the TSO `READY` prompt
      - the `***` continuation marker
      - the ISPF primary menu
      - the password prompt, as a non-display field
  - Verify: unit tests on recorded screens (fixtures).
  - Done:
    - `src/core/recognise/` gives three layers:
      - `match` combinators (text, row, at, cursor in a hidden field, all/any/not) and `fieldAfter(label)`
      - `recognise()`: the kind (`hercules`, `vtam-logon`, `password`, `more`, `ispf-primary`, `ispf-panel`, `tso-ready`, `unknown`), the ISPF title and the command field
      - `screenState(source, locked)`: the plain object the Docent will get, with labelled fields and hidden values always ''
    - They work on a `Terminal` or a `SessionObserver`.
    - **Password** is recognised by the cursor being in an unprotected non-display field, not by wording.
    - Readiness is the keyboard lock, plus the observer's `ready` quiet period.
    - Tested on the recorded TK5 logon and ISPF tour, OS/390's USS screen, and a synthetic OS/390-style ISPF menu.

- [x] **2. Public scripting helper (`3270js/script`)**
  - Acceptance:
    - `waitFor(matcher, timeout)`, `fill(labelOrIndex, text)`, `press(aid)` and `command(text)`.
    - TSO and ISPF recovery helpers, promoted from `test/live/tso.ts`:
      - `RECONNECT`
      - PA2 to reshow
      - Clear
      - `CANCEL`
      - `***` paging
    - Works on a `Terminal` (Node, or the browser).
  - Verify: the live tests are rewritten on top of it and still pass on TK5.
  - Done:
    - `3270js/script` is a new entry point outside the platform-neutral core, because it uses timers.
    - `Session` gives `waitFor` (a screen kind, text, a regex or a matcher), `type`, `fill` (by index or label), `press`, `command` (using the recognised command line, and RFE's Scroll field) and `pageThrough`.
    - TSO helpers: `waitForLogonScreen`, `tsoLogon` (which reports `reconnected`), `toIspfPrimary` and `tsoLogoff`.
    - Unit tests replay recorded TK5 sessions interactively (`test/helpers/replay-driver.ts`); the helpers send exactly the recorded records.
    - The live tests run on it, 9/9 on TK5, and a new live test checks the reconnect recovery on purpose.

- [x] **3. Docent actions**
  - Acceptance:
    - A JSON action format, which `applyAction(terminal, action)` performs and reports on. Examples:
      - `{ fill: [{ field: 2, text: "HERC03" }], aid: "ENTER" }`
      - `{ command: "LISTCAT" }`, which types at the cursor or on the command line, then presses Enter
      - `{ aid: "PF3" }`
    - **The Docent may do what the visitor can**, after the visitor clicks "Run": fill fields, move the cursor, and press Enter, Clear, PA1–3 or PF1–24. Not Attn or SysReq, which change the session's state.
    - **Refused:**
      - into non-display (password) fields
      - into protected fields
      - while the keyboard is locked
    - The refusal reasons match SimH Assist's existing refusals.
    - Understanding ISPF is the hard part, and it happens in the Docent service. This task gives it what it needs to see: the recognised screen, each field's label, and whether it can be typed into (task 1).
  - Verify: unit tests, including every refusal.
  - Done:
    - `src/core/actions/`, exported from `3270js`:
      - `parseAction(json)` checks untrusted JSON strictly: known properties only, and the types and length limits
      - `applyAction(terminal, action)` checks every target first, then fills, types and presses, so an action is applied whole or not at all
    - Refusals use SimH Assist's `injection_blocked` with a `reason`: `locked`, `password`, `protected`, `no-field`, `too-long`, `aid` or `not-connected`. A malformed action gets `invalid_action`.
    - Allowed keys (`DOCENT_AIDS`): Enter, Clear, PA1–3 and PF1–24.
    - Also fixed: `Session.command` at TSO READY pressed Home first, which on an unformatted screen typed at the top; it now types at the cursor.

- [x] **4. Recordings: asciinema export ("EBCDIC cinema")**
  - Acceptance:
    - `traceToCast(trace)` turns a 3270js trace into an asciinema v2 `.cast`:
      - each host write becomes one ANSI full-screen repaint, with SGR colours and the status line as the last row
      - each AID becomes an `"i"` event, with its text redacted
      - the size is cols × (rows + 1)
    - `traceToCommands(trace)` gives command/response pairs, one per AID: the fields sent and the screen that came back. This is for SimH Assist's `session_commands`.
    - The trace stays the lossless original.
  - Verify:
    - Casts of the recorded traces play in asciinema-player.
    - `agg` renders them to video.
    - Unit tests compare frames with `Terminal.text`.
  - Done:
    - `3270js/cast` is a new entry point. `traceToCast(trace)` replays a trace through a `SessionObserver`:
      - each host write becomes one ANSI full-screen repaint (true colour, highlighting, the status line as the last row, the cursor)
      - each operator AID becomes an `"i"` event, redacted (`HERC01 [ENTER]`, `****** [ENTER]`)
      - the header sizes the screen for the model (132 × 28 for a model 5)
    - `traceToCommands(trace)` gives each AID with its redacted input, and the recognised screens before and after.
    - Tests:
      - a minimal VT interpreter replays every recorded trace's cast frame by frame against the observer's screen, cursor and status line
      - `agg` renders the colour ISPF menu correctly
      - SimH Assist's asciinema-player 3.17 plays the whole ISPF tour
    - The cast is about twice the trace's size (full repaints); repainting only changed rows could halve it later.

- [x] **5. Faithful replay player**
  - Acceptance:
    - `TracePlayer` plays a trace into a DOM or canvas renderer, with real timing, play/pause, speed and seeking by record.
    - This is the true 3270 view of a recording, for the admin and dashboard pages, next to the asciinema version.
  - Verify: e2e in three browsers × two renderers on a recorded trace.
  - Done:
    - `3270js/player` is a new entry point. `TracePlayer(trace, { view, speed, idleLimit })` plays the host's side of a trace into a real `Terminal`, with the recorded timing (long pauses capped). It offers play, pause, speed, `seek(time)` and `seekFrame(n)`. Seeking rebuilds and replays from the start, and re-attaches the view.
    - `demo/player.html` is a player page:
      - controls: play/pause, speed, a frame slider
      - `?trace=` for the committed recordings, which the demo server now serves under `/traces/`
      - **Open trace** for a local file, read in the browser and never uploaded
    - Tests: unit tests with fake timers (play, pause, speed, seek back and forward, idle limit); e2e in three browsers × two renderers (play to the end, then seek by content), with screenshot baselines.
    - Video: the cast from task 4 also goes through SimH Assist's `agg` → `ffmpeg` pipeline to MP4 (checked on the colour ISPF tour).

- [ ] **6. Release v0.1.0 for SimH Assist**
  - Acceptance:
    - `npm pack` builds `3270js-0.1.0.tgz`, attached to a GitHub release `v0.1.0` (the repository stays private, and `package.json` keeps `private: true`, so nothing can reach npm by accident).
    - A `CHANGELOG.md` entry, and the README states how to install from the tarball.
  - Verify: the tarball installs into an empty Node 20 CommonJS project, and `require('3270js/node')` and the ES module entry points load.
  - Prepared:
    - version `0.1.0`, `CHANGELOG.md`, and README install instructions
    - `npm run check:pack`, which packs the tarball, installs it into an empty CommonJS project and loads all 8 entry points with `require` and `import`, plus the fonts and a smoke test; it passes on Node 20.20.2 and 24.22.1
    - Found on the way: `3270js/node` needs `ws` even for `TcpTransport` (#56, documented)
  - The tag and GitHub release follow once this is merged to `main`.

### simh-assist: the integration (→ Checkpoints I and J)

SimH Assist **vendors the tarball** (`vendor/3270js-0.1.0.tgz`, `"3270js": "file:vendor/3270js-0.1.0.tgz"`), so its rsync deploys need no access to the private repository. Moving to npm later, once 3270js is public, is a one-line change.

- [ ] **7. A `tn3270-target` machine kind**
  - Acceptance:
    - A migration that rebuilds `machines` with `tn3270-target` added to its CHECK constraint.
    - Columns or JSON for model, colour, code page, LU name and TN3270E.
    - Registry validation, admin CRUD and a seed for TK5.
    - `connection: 'tn3270'`.
  - Verify: `node --test` for the migration and registry; the admin API round-trips.

- [ ] **8. Relay and observer on the server**
  - Acceptance:
    - A WebSocket handler for `tn3270` machines: binary frames relayed to the machine's host and port, using the machine record only (never an open relay).
    - A `SessionObserver` attached to every session.
    - Sessions registered like the other kinds (`docent-sessions`, the sessions Map).
    - A JSON control channel for Docent actions and state.
  - Verify: an integration test with 3270js's scripted test host; live on TK5.

- [ ] **9. The browser page**
  - Acceptance:
    - `index.html` chooses the renderer by the machine's terminal type: xterm for the existing machines, and 3270js (DOM renderer, keyboard mapper, 3270 font, status line) for `tn3270`.
    - 3270js served from `node_modules` like xterm.
    - Docent actions applied with task 3's `applyAction`.
    - `window.simhAssist` works for 3270 too: `getTerminalOutput` returns the screen text.
  - Verify: SimH Assist's CI checks, and a manual visit through the dashboard.

- [ ] **10. Docent bridge for 3270**
  - Acceptance:
    - `/terminal/state` returns:
      - the screen text
      - the fields (label, protected, hidden)
      - the cursor
      - `ready`
      - the recognised screen (logon, READY, ISPF and so on)
    - `/terminal/inject` accepts `{command}`, the existing contract, mapped to task 3's `command` action, as well as `{action}`.
    - It's refused when not ready, or when the target field is hidden.
  - Verify: `node --test` with a stubbed observer; live with the Docent service.

- [ ] **11. Logging and replay**
  - Acceptance:
    - A 3270 session writes its redacted 3270js trace, plus a derived `.cast` for asciinema-player and MP4 export.
    - Its command/response pairs go to `session_commands`.
    - Retention and purge apply to both files.
    - The admin and dashboard pages offer the faithful `TracePlayer` next to the cast.
  - Verify:
    - A recorded TK5 session replays in both players and exports to MP4.
    - **The password appears in none of the outputs.**

- [ ] **12. Phase 3 acceptance**
  - Acceptance, live on TK5 through SimH Assist:
    1. A visitor logs on.
    2. The Docent recognises the ISPF menu, proposes a command and injects it after "Run".
    3. The session replays in both players.
    4. The recording, cast, MP4 and `session_commands` contain no password.
  - Also: README and docs in both repos.
  - Verify: the live run, then a museum demo checklist.

### Infrastructure (in parallel)

- [ ] **13. OS/390 (ADCD) under Hercules**
  - Acceptance:
    - A container on gpu-server running OS/390 from the museum's ADCD, alongside TK5, with its own `infra/hercules-os390/` (Dockerfile, compose and README).
    - **The ADCD volumes are licensed:** they're never committed, and they live in a bind mount under `/home` (the root filesystem is small). The user provides them and confirms that the licence covers this use.
    - TN3270 through Hercules' 3270 port, plus OS/390's own TCP/IP and **TN3270E server** through a container network interface (LCS or CTC), so TN3270E can be tested on our own hardware, not only on the Multiprise.
    - A SimH Assist machine for it.
  - Verify: logon and ISPF through 3270js over both ports; the TN3270E interop findings from the Multiprise reproduced.

## Checkpoints

|       | Gate                                                                                         | Proves                                 |
| ----- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| **H** | Tasks 0–6: observer matches `Terminal` on every trace; cast and player work; v0.1.0 released | The library has what SimH Assist needs |
| **I** | Tasks 7–9: a visitor uses TK5 through SimH Assist                                            | The plumbing works                     |
| **J** | Tasks 10–12: Docent help, logging and replay, no password anywhere                           | Phase 3 done                           |

## Risks

| Risk                                                                         | Mitigation                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passwords leaking into logs (one TN3270E leak was just found and fixed, #47) | One redaction path, the observer's, used by traces, casts and `session_commands`; tests with a hidden field on every output; a scan for known test passwords in CI |
| The observer drifting from the browser's terminal                            | Task 0's equivalence test on every trace; both are built from the same core                                                                                        |
| A `kind` migration on a live SQLite database                                 | Copy-table migration in a transaction, tested on a copy of production's schema; back up first                                                                      |
| Docent actions surprising the visitor                                        | Actions run in the browser, through the same keyboard rules, after "Run"; never into hidden fields                                                                 |
| Teaching the Docent to drive ISPF                                            | Out of this plan's code, but the state API gives it recognised screens and labelled fields; start with a few scripted tasks (browse a data set, run a command)     |
| ADCD licensing and disk space                                                | Images never committed; bind mount under `/home`; the user confirms the licence                                                                                    |

## Decisions (2026-11-22)

1. **Delivery:** a GitHub release tarball, vendored into SimH Assist; publish to npm later, when 3270js goes public.
2. **Docent authority:** after "Run", the Docent may fill fields and press AID keys (Enter, PF3 and the rest) as the visitor could; never into hidden fields; not Attn or SysReq.
3. **Hosts:**
   - **Development:** TK5. SimH Assist's production server can reach gpu-server on the tailnet.
   - **Also:** OS/390 from the ADCD under Hercules (task 13).
   - **The Multiprise 3000:** later, for permitted users only, once the SimH Assist server is on the museum's tailnet.
4. **Workflow:** as here. One PR per task into SimH Assist's `develop`, which the user merges.
5. **Recordings:** keep both the 3270js trace (the original) and the derived `.cast` for every session.
