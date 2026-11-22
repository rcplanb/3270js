# Live tests

These drive a real TN3270 host and never run in `npm test`.

```sh
HERCULES_HOST=100.113.55.17 TSO_USER=HERC01 TSO_PASSWORD=... npm run test:live
```

| Variable        | Default    |                                                                                                    |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `HERCULES_HOST` | (required) | TN3270 host                                                                                        |
| `HERCULES_PORT` | `3270`     |                                                                                                    |
| `TSO_USER`      | `HERC01`   |                                                                                                    |
| `TSO_PASSWORD`  | (required) | Never commit it. It is typed into a non-display field, so it never appears in the printed screens. |

The TSO test logs off at the end. If a previous run dropped the connection
while logged on, TSO keeps the session waiting for reconnect; the test then
logs on with `RECONNECT` instead of failing.
