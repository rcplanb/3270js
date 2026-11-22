# Live tests

These drive a real TN3270 host and never run in `npm test`.

```sh
HERCULES_HOST=100.113.55.17 TSO_USER=HERC03 TSO_PASSWORD=... npm run test:live
HERCULES_HOST=100.113.55.17 TSO_USER=HERC03 TSO_PASSWORD=... npm run test:e2e:live   # browser acceptance
```

| Variable        | Default    |                                                                                                    |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `HERCULES_HOST` | (required) | TN3270 host                                                                                        |
| `HERCULES_PORT` | `3270`     |                                                                                                    |
| `TSO_USER`      | `HERC03`   | Automated tests use HERC03, so they never collide with interactive sessions on HERC01/HERC02.      |
| `TSO_PASSWORD`  | (required) | Never commit it. It is typed into a non-display field, so it never appears in the printed screens. |

The TSO test logs off at the end. If a previous run dropped the connection
while logged on, TSO keeps the session waiting for reconnect; the test then
logs on with `RECONNECT` instead of failing.
