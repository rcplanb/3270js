# Phase 2 Implementation Plan

> Status: **in progress** · 2026-11-22 · Implements [SPEC.md](../SPEC.md) §2 Phase 2

## Approach

Phase 1 left a working TN3270 terminal that has been checked against s3270 and a real
TK5. Phase 2 adds **TN3270E** and finishes the **extended data stream**. The same rules
apply as before:

- byte-level tests first
- every behaviour checked against s3270
- live verification wherever a real host can show it

**The test-target problem.** Hercules' 3270 server only speaks plain TN3270 (found in
Phase 1). So the TN3270E work needs its own test host:

1. **A scripted TN3270E test host** (task 0). It's a small Node server implementing the
   server side of RFC 2355: negotiation, BIND, the header, responses and SSCP-LU data.
   It can replay recorded or scripted sessions.
2. **s3270 as the reference client** against that same host. Both clients connect, and
   their negotiation bytes, responses and screens must match. This is the Phase 1
   differential idea, applied to TN3270E.
3. **A real TN3270E server for live acceptance:** see Open Question 1.

## Tasks

Each task is one PR. Most depend on task 0. Tasks 6–12 are independent of TN3270E and
can run in parallel with it.

### TN3270E (→ Checkpoint E)

- [x] **0. TN3270E test host + s3270 interop harness**
  - Acceptance:
    - A Node server for the RFC 2355 server side, scriptable per test: device type
      accept or reject, CONNECT to a named LU, FUNCTIONS, BIND/UNBIND, responses,
      SSCP-LU data.
    - A harness that runs the same script against 3270js and s3270, and compares the
      negotiation and the screens.
  - Verify: the harness runs s3270 through a full TN3270E negotiation and a BIND.
  - Done: `test/helpers/tn3270e-host.ts`, `test/interop/` (10 tests). What s3270 showed:
    - In TN3270E it asks for `IBM-3278-2-E` even as a 3279; RFC 2355 names only 3278
      types, and colour goes in Query Reply. After falling back to plain TN3270 it
      sends `IBM-3279-2-E`.
    - It asks for CONTENTION-RESOLUTION (function 5) too, and accepts a counter-offer
      without it.
    - `Connect()` only returns once bound; 3270 data before BIND is ignored.
    - Responses: positive `00`, negative `02` (operation check) for a bad address.
    - Attn is `IAC IP`, SysReq is `IAC AO`; Enter on SSCP-LU goes back as SSCP-LU-DATA.

- [x] **1. TN3270E negotiation** (telnet layer)
  - Acceptance:
    - Accept `DO TN3270E`.
    - DEVICE-TYPE REQUEST with the model type (`IBM-3279-2-E` …), plus CONNECT when
      `luName` is set.
    - Handle DEVICE-TYPE IS (record the LU name) and REJECT with a reason, falling back
      to plain TN3270 as x3270 does.
    - FUNCTIONS REQUEST and IS: BIND-IMAGE, RESPONSES, SYSREQ. Handle the counter-offer
      when the server proposes a subset.
    - New `Terminal` options: `tn3270e` (default true) and `luName`.
  - Verify: unit tests with the exact RFC 2355 byte sequences; the interop harness
    matches s3270's negotiation.
  - Done: TN3270E is announced as `IBM-3278-n[-E]` (as s3270 does); plain TN3270
    keeps `IBM-3279-n-E` for colour. A failed negotiation refuses TN3270E for the rest
    of the connection. Input goes out as 3270-DATA with SEQ-NUMBER counting from 0.
    3270js passes the 5 negotiation and framing interop cases; the other 6 are marked
    pending for tasks 2 and 4.
  - Checked live (read-only) against **OS/390 2.10's TN3270E server** on the museum's
    Multiprise 3000: 3270js was assigned LU `SC0TCP01`, agreed BIND-IMAGE, RESPONSES
    and SYSREQ, and drew the USS screen. OS/390 sends a BIND-IMAGE (PLU `TELNET`,
    24×80) before the USS screen, which is 3270-DATA with the SNA Erase/Write code
    `05`. It answers a FUNCTIONS REQUEST naming an unknown function (s3270's
    CONTENTION-RESOLUTION) with `WONT TN3270E`, not a counter-offer, so s3270 drops to
    plain TN3270 there; 3270js now handles that impasse too.

- [x] **2. TN3270E framing and responses**
  - Acceptance:
    - The 5-byte header on every record, both ways.
    - Data types routed: 3270-DATA, SCS-DATA (rejected), RESPONSE, BIND-IMAGE, UNBIND,
      NVT-DATA, REQUEST, SSCP-LU-DATA, PRINT-EOJ.
    - Sequence numbers.
    - Positive and negative responses when the host asks (ALWAYS-RESPONSE,
      ERROR-RESPONSE), including a negative response for a data stream error.
  - Verify: unit tests; interop harness.
  - Done: found necessary on OS/390 2.10, whose TSO asks for ALWAYS-RESPONSE on its
    first write and waits (X SYSTEM) until it gets one. Positive and negative responses
    follow x3270 (no positive response when the write produced a reply; negative `02`
    for a bad address, `00` otherwise). With BIND-IMAGE agreed, 3270 data is ignored
    until BIND; UNBIND clears the screen; the BIND's PLU and sizes are exposed
    (`bindInfo`, `bind` event); SSCP-LU text is shown and Enter sends the typed text
    as SSCP-LU-DATA (`src/core/sscp.ts`); NVT-DATA goes to the `nvt` event.
    `sessionMode` reports unbound / lu-lu / sscp-lu / nvt. Screen sizes from the BIND
    aren't applied yet (task 8).

- [ ] **3. Session states, status line, minus function**
  - Acceptance:
    - Track unbound, SSCP-LU and LU-LU states from BIND and UNBIND.
    - SSCP-LU data shown as an unformatted screen, with x3270's keyboard rules for that
      state.
    - Status line:
      - underlined **B** for TN3270E
      - the box at column 2 shows session ownership (solid box for LU-LU, boxed person
        for SSCP, boxed ? when unbound)
      - the LU name at cols−25
    - **Minus function (`X -f`)** as a new operator error, set where x3270 sets it.
      Examples: Attn on an unbound session; an AID other than Enter or Clear in
      SSCP-LU mode. Reset clears it.
  - Verify: unit tests; interop harness screens; OIA glyph tests.

- [ ] **4. Attn and SysReq on TN3270E**
  - Acceptance:
    - **Attn:** telnet `IAC IP` when bound; minus function when not.
    - **SysReq:** `IAC AO` when the SYSREQ function is negotiated. Without it, the
      Phase 1 test-request read.
  - Verify: unit tests; interop harness against s3270's bytes.

### Extended data stream (→ Checkpoint F)

- [ ] **5. Reply modes and Read Partition types**
  - Acceptance:
    - WSF Set Reply Mode: field, extended field and character modes.
    - Inbound reads include SFE (extended field) or SA (character) orders as each mode
      requires.
    - Read Partition RB/RM/RMA (types F2, F6, 6E).
    - Query Reply's Reply Modes reply now claims all three.
  - Verify: unit tests against s3270's inbound bytes for the same screens.

- [ ] **6. Colour and highlighting differential**
  - Acceptance:
    - The s3270 differential also compares character attributes (`SA(…)` tokens) and
      field extended attributes (`SF(c0=…,41=…,42=…)`).
    - Record new 3279 traces on TK5 as HERC03: the ISPF menu, RFE DSLIST, a member
      list, Revedit and the utilities.
    - Any difference found is fixed in the core.
  - Verify: `npm test` differential suite.

- [ ] **7. Field outlining and transparency**
  - Acceptance:
    - Both renderers draw field outlining (lines over, under, left and right of fields)
      and honour transparency.
    - The same `cellStyle` data drives both renderers.
  - Verify: unit tests; e2e screenshots of a synthetic screen.

- [ ] **8. Models 3, 4 and 5 live**
  - Acceptance:
    - On TK5 as HERC03, models 3, 4 and 5 log on and show ISPF at the alternate size
      via EWA.
    - Record traces, run the differential, and take e2e screenshots at 132 columns.
  - Verify: live run, differential, e2e.

### Presentation (→ Checkpoint G)

- [ ] **9. More code pages**
  - Acceptance:
    - CP1047, 500, 285 and 1140 (with the euro) generated and cross-checked against the
      Unicode/IBM tables, as CP037 was.
    - A code-page picker in the demo.
  - Verify: unit tests (round trips, known positions).

- [ ] **10. APL glyphs**
  - Acceptance:
    - GE and APL-set characters are drawn as the APL characters (⍴ ⍳ ∇ …) rather than
      their base code-page meaning, using a CP310-to-Unicode table.
  - Verify: unit tests, screenshot.

- [ ] **11. Optional 3270 font** (ADR 0001)
  - Acceptance:
    - `3270js/fonts/3270-Regular.woff` (and WOFF2 if we can convert it), plus
      `3270js/fonts/3270.css` with `@font-face`.
    - The licence goes into THIRD_PARTY_NOTICES.
    - A font toggle in the demo.
    - Not part of the main bundle.
  - Verify: e2e screenshots with the font.

- [ ] **12. Phase 2 acceptance and docs**
  - Acceptance:
    - A TN3270E session (named LU, BIND, Attn, SysReq) passes against the test host and
      s3270, and live if Open Question 1 gives us a server.
    - The 3279 colour differential passes.
    - A model 5 session works live.
    - README and SPEC are updated.
  - Verify: `npm run check`, `npm run test:e2e`, and the live runs.

## Checkpoints

|       | Gate                                                                                          | Proves                                                    |
| ----- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **E** | Tasks 0–4: TN3270E interop matches s3270 on negotiation, CONNECT, BIND, responses and screens | TN3270E is right without a real server                    |
| **F** | Tasks 5–8: attribute differential passes on 3279 traces; models 3–5 work live                 | Colour, highlighting and screen sizes match the reference |
| **G** | Tasks 9–12: Phase 2 acceptance                                                                | Phase 2 done                                              |

## Risks

| Risk                                                       | Mitigation                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No real TN3270E server to test against                     | The scripted host plus s3270 interop covers protocol correctness; live acceptance depends on Open Question 1 |
| RFC 2355 corner cases (REQUEST, PRINT-EOJ, counter-offers) | Write tests from the RFC text, and check each against s3270                                                  |
| TK5's VTAM may not offer every model's logmode             | Find out in task 8; record whatever it supports                                                              |
| The font has no WOFF2 build                                | Ship WOFF (108 KB, optional) and add WOFF2 when a converter is available                                     |

## Open questions

1. **A real TN3270E server for live acceptance.** Hercules can't do it. Could the
   museum's **Multiprise 3000** (OS/390's TN3270E server) be reached from this Mac,
   for example over the tailnet? Is there another option you'd prefer? Otherwise the
   test host plus s3270 is the Phase 2 bar.
2. **Code pages:** are 1047, 500, 285 and 1140 the right four, or does the museum need
   others (273 German, 297 French, …)?
3. **WOFF2 for the font:** OK to install Google's `woff2` tool (`brew install woff2`) to
   convert the published WOFF/TTF? It saves about a third of the size.
