# Phase 3 Implementation Plan

> Status: **draft for review** · 2026-11-22 · Implements [SPEC.md](../SPEC.md) §2 Phase 3

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

- **Tasks 0–5** are library work in **3270js**.
- **Tasks 6–11** are integration work in **simh-assist**, as PRs into its `develop` branch.

Each task is one PR.

### 3270js: the library side (→ Checkpoint H)

- [ ] **0. `SessionObserver`: the passive copy**
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

- [ ] **1. Screen recognisers and readiness**
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

- [ ] **2. Public scripting helper (`3270js/script`)**
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

- [ ] **3. Docent actions**
  - Acceptance:
    - A JSON action format, which `applyAction(terminal, action)` performs and reports on. Examples:
      - `{ fill: [{ field: 2, text: "HERC03" }], aid: "ENTER" }`
      - `{ command: "LISTCAT" }`, which types at the cursor or on the command line, then presses Enter
    - **Refused:**
      - into non-display (password) fields
      - into protected fields
      - while the keyboard is locked
    - The refusal reasons match SimH Assist's existing refusals.
  - Verify: unit tests, including every refusal.

- [ ] **4. Recordings: asciinema export ("EBCDIC cinema")**
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

- [ ] **5. Faithful replay player**
  - Acceptance:
    - `TracePlayer` plays a trace into a DOM or canvas renderer, with real timing, play/pause, speed and seeking by record.
    - This is the true 3270 view of a recording, for the admin and dashboard pages, next to the asciinema version.
  - Verify: e2e in three browsers × two renderers on a recorded trace.

### simh-assist: the integration (→ Checkpoints I and J)

- [ ] **6. A `tn3270-target` machine kind**
  - Acceptance:
    - A migration that rebuilds `machines` with `tn3270-target` added to its CHECK constraint.
    - Columns or JSON for model, colour, code page, LU name and TN3270E.
    - Registry validation, admin CRUD and a seed for TK5.
    - `connection: 'tn3270'`.
  - Verify: `node --test` for the migration and registry; the admin API round-trips.

- [ ] **7. Relay and observer on the server**
  - Acceptance:
    - A WebSocket handler for `tn3270` machines: binary frames relayed to the machine's host and port, using the machine record only (never an open relay).
    - A `SessionObserver` attached to every session.
    - Sessions registered like the other kinds (`docent-sessions`, the sessions Map).
    - A JSON control channel for Docent actions and state.
  - Verify: an integration test with 3270js's scripted test host; live on TK5.

- [ ] **8. The browser page**
  - Acceptance:
    - `index.html` chooses the renderer by the machine's terminal type: xterm for the existing machines, and 3270js (DOM renderer, keyboard mapper, 3270 font, status line) for `tn3270`.
    - 3270js served from `node_modules` like xterm.
    - Docent actions applied with task 3's `applyAction`.
    - `window.simhAssist` works for 3270 too: `getTerminalOutput` returns the screen text.
  - Verify: SimH Assist's CI checks, and a manual visit through the dashboard.

- [ ] **9. Docent bridge for 3270**
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

- [ ] **10. Logging and replay**
  - Acceptance:
    - A 3270 session writes its redacted 3270js trace, plus a derived `.cast` for asciinema-player and MP4 export.
    - Its command/response pairs go to `session_commands`.
    - Retention and purge apply to both files.
    - The admin and dashboard pages offer the faithful `TracePlayer` next to the cast.
  - Verify:
    - A recorded TK5 session replays in both players and exports to MP4.
    - **The password appears in none of the outputs.**

- [ ] **11. Phase 3 acceptance**
  - Acceptance, live on TK5 through SimH Assist:
    1. A visitor logs on.
    2. The Docent recognises the ISPF menu, proposes a command and injects it after "Run".
    3. The session replays in both players.
    4. The recording, cast, MP4 and `session_commands` contain no password.
  - Also: README and docs in both repos.
  - Verify: the live run, then a museum demo checklist.

## Checkpoints

|       | Gate                                                                        | Proves                                 |
| ----- | --------------------------------------------------------------------------- | -------------------------------------- |
| **H** | Tasks 0–5: observer matches `Terminal` on every trace; cast and player work | The library has what SimH Assist needs |
| **I** | Tasks 6–8: a visitor uses TK5 through SimH Assist                           | The plumbing works                     |
| **J** | Tasks 9–11: Docent help, logging and replay, no password anywhere           | Phase 3 done                           |

## Risks

| Risk                                                                         | Mitigation                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passwords leaking into logs (one TN3270E leak was just found and fixed, #47) | One redaction path, the observer's, used by traces, casts and `session_commands`; tests with a hidden field on every output; a scan for known test passwords in CI |
| The observer drifting from the browser's terminal                            | Task 0's equivalence test on every trace; both are built from the same core                                                                                        |
| A `kind` migration on a live SQLite database                                 | Copy-table migration in a transaction, tested on a copy of production's schema; back up first                                                                      |
| Docent actions surprising the visitor                                        | Actions run in the browser, through the same keyboard rules, after "Run"; never into hidden fields                                                                 |
| How SimH Assist gets 3270js (not on npm yet)                                 | Open question 1                                                                                                                                                    |

## Open questions

1. **Delivery of 3270js to SimH Assist.** Publish it to npm now (public, MIT, as `3270js`), or install it in SimH Assist from a GitHub release tarball or git tag until it's public? SPEC says to ask before publishing.
2. **Docent authority.** May the Docent fill fields and press AID keys (Enter, PF3 and so on) after the visitor clicks "Run", or only type commands at a ready prompt as today? In both cases it never touches hidden fields.
3. **Which host first.** TK5 on gpu-server for development. For the museum, is TK5 the first public mainframe, with the MP3000 later? And can SimH Assist's production server reach gpu-server's tailnet address?
4. **SimH Assist workflow.** PRs into `develop`, which you merge, as here? Any conventions there I should follow beyond its CLAUDE.md?
5. **Recordings.** Keep both the 3270js trace (the original) and the derived `.cast` per session? That doubles the storage, but keeps the existing players and MP4 export working.
