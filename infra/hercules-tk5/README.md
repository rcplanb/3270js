# Hercules / MVS 3.8j TK5 test target

A TK5 system used as the live test target for 3270js (live tests, trace
recording, differential testing). Runs SDL Hyperion 4.9.1 as bundled with TK5
(MVS 3.8j Level 8505 Update 5).

## Layout

- `Dockerfile` — runtime only (Ubuntu 24.04 + Hercules' shared-library deps,
  ~120 MB). TK5 is **not** in the image.
- `fetch-tk5.sh` — downloads the official TK5 zip, verifies its SHA-256,
  unpacks it to `./tk5`, strips non-linux-x86_64 binaries and selects daemon
  mode. Refuses to overwrite an existing `./tk5` (it holds live DASD).
- `compose.yaml` — bind-mounts `./tk5` at `/tk5`, runs as uid/gid 1000,
  publishes 3270 (TN3270) and 8038 (Hercules HTTP console) on `BIND_IP` only.

## Deploy

```sh
./fetch-tk5.sh
echo "BIND_IP=<tailnet ip>" > .env   # never 0.0.0.0: the HTTP console has no auth
docker compose up -d --build
docker logs -f tk5                    # IPL takes ~1 minute
```

Check from any tailnet machine:

```sh
printf 'Connect(<host>:3270)\nWait(30,InputField)\nAscii()\nQuit()\n' | s3270 -model 3279-2-E
```

## Current deployment

- Host: `gpu-server` (tailnet), directory `~/tk5-build`, `BIND_IP` set in `.env`
- Ports: `3270` TN3270, `8038` HTTP console — tailnet only

## Notes

- **Plain TN3270 only.** Hercules' built-in 3270 server does not negotiate
  TN3270E, so it can't exercise 3270js Phase 2 TN3270E code.
- **Shutdown.** `docker compose stop` stops Hercules without a clean MVS
  shutdown. Prefer shutting MVS down from the console first when DASD state
  matters (TK5's `shutdown` procedure via the HTTP console).
- **Why not bake TK5 into the image?** Docker's containerd image store on the
  GPU server lives on a 20 GB root filesystem; a 1 GB+ image filled it.
  Keeping TK5 in a bind mount on `/home` avoids that.
- **`netbase`** (for `/etc/protocols`) is in the image: without it Hercules
  logs `getprotobyname("tcp")` errors on every connection. The running
  container was fixed in place with `docker cp /etc/protocols tk5:/etc/protocols`
  (no restart); the next `docker compose up -d --build` includes it.
- Hercules then logs `setsockopt(TCP_KEEPIDLE/KEEPINTVL/KEEPCNT): Invalid
  argument` per connection: its default keep-alive values are rejected inside
  the container. Harmless (connections simply have no TCP keep-alive); TK5's
  config sets no `CONKPALV`. Not pursued, as testing a fix means re-IPLing MVS.
- Hercules negotiates one TN3270 connection at a time: a client that connects
  and never answers blocks other connections until it times out.
- Default TK5 user IDs and passwords are documented in the TK5 user manual.
  Automated tests use HERC03 (see test/live/README.md).
  Don't commit traces that contain them.
