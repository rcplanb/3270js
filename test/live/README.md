# Live tests

These drive a real TN3270 host and never run in `npm test`.

```sh
HERCULES_HOST=<hercules-host> TSO_USER=HERC03 TSO_PASSWORD=... npm run test:live
HERCULES_HOST=<hercules-host> TSO_USER=HERC03 TSO_PASSWORD=... npm run test:e2e:live   # browser acceptance
```

| Variable        | Default    |                                                                                                           |
| --------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `HERCULES_HOST` | (required) | TN3270 host                                                                                               |
| `HERCULES_PORT` | `3270`     |                                                                                                           |
| `TSO_USER`      | `HERC03`   | Automated tests use HERC03, so they never collide with interactive sessions on HERC01/HERC02.             |
| `LIVE_MODEL`    | `2`        | `3`, `4` or `5`: the screen model (32×80, 43×80, 27×132).                                                 |
| `LIVE_COLOR`    | (off)      | `1` runs as a 3279 (colour), so the host sends colours. With `RECORD_TRACE=path`, records a colour trace. |
| `TSO_PASSWORD`  | (required) | Never commit it. It is typed into a non-display field, so it never appears in the printed screens.        |

The tests drive TSO through `3270js/script` (`Session`, `tsoLogon`, `tsoLogoff`).
`reconnect.test.ts` drops a logged-on session on purpose, then checks the next
logon reconnects to it and gets back to ISPF.

The TSO test logs off at the end. If a previous run dropped the connection
while logged on, TSO keeps the session waiting for reconnect; the test then
logs on with `RECONNECT` instead of failing.
