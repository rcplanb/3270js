# Hercules / OS/390 (ADCD)

OS/390 from the museum's Application Development CD (ADCD) under SDL
Hyperion 4.9.1, beside TK5 on the same host. It is Phase 3 task 13 in
`docs/PLAN-phase3.md`, and a system SimH Assist *manages*: its Hercules console
lets SimH Assist clear stuck TSO user IDs (task 14f).

It gives SimH Assist and 3270js two ways in:

| Port (host)     | What                                  | Protocol          |
| --------------- | ------------------------------------- | ----------------- |
| `3271`          | Hercules' own 3270 server             | plain TN3270      |
| `2323`          | OS/390's TCP/IP: its TN3270E server   | TN3270E           |
| `8039`          | Hercules HTTP console (no auth)       | HTTP              |

The TN3270E server lets 3270js be tested against real OS/390 TN3270E on our
own hardware, not only on the museum's Multiprise 3000.

## Licence

The ADCD volumes are licensed by the museum for non-commercial use, which
covers this: visitors exploring OS/390 through SimH Assist. **Never commit
them**, and never run commercial workloads on this system. They live only in
`./os390/dasd` on the host (`.gitignore` excludes `os390/`).

## Layout

- `Dockerfile`: the runtime only (Ubuntu 24.04, Hercules' libraries,
  `iproute2` and `iptables`, about 130 MB). Neither Hercules nor OS/390 is in
  the image.
- `prepare-os390.sh <TK5 kit>`: creates `./os390` with a copy of the TK5
  kit's SDL Hyperion 4.9.1 (Linux x86_64, with the LCS/CTC and 3270 device
  modules) and its HTTP console pages, plus `os390/conf/os390.cnf` from the
  template. It never touches `os390/dasd` or an existing config.
- `conf/os390.cnf.template`: the Hercules configuration. Lines marked
  `@ADCD@` depend on the ADCD release.
- `entrypoint.sh`: runs Hercules in daemon mode with its stdin held open
  (Hercules stops at the end of stdin). With `OS390_IP` set, it NATs the
  container's port 2323 to OS/390's TN3270E server on `tap0`, the interface
  Hercules creates for the guest's LCS adapter.
- `compose.yaml`: binds every port to `BIND_IP` only, and gives the container
  `NET_ADMIN` and `/dev/net/tun` (its own network namespace only) for the
  guest's network.

## Getting the volumes

They are on the museum's Nextcloud, which is reachable only on the museum
tailnet. While on it, download the ADCD files, and keep the ADCD's own
documentation (the readme or system guide): it lists what the config needs.

1. Copy them to the host, into `~/os390-build/os390/dasd/`. Use `/home`,
   because the root filesystem is small. Unpack them there if they're
   compressed archives. CCKD (`.cckd`) images can stay as they are.
2. From the ADCD documentation, fill in every `@ADCD@` line of
   `os390/conf/os390.cnf`:
   - one `3390` line per volume, at the address its IODF expects
   - `IPL` (the IPL volume's address) and `LOADPARM`
   - the master console and the TSO terminals: give the console's device
     group `CONS`, so a client can ask for it by LU
   - the network adapter that its TCPIP PROFILE uses (LCS or CTC)
3. Put the guest's IP address in `.env` as `OS390_IP`, so the TN3270E port
   is forwarded.

## Deploy

```sh
./prepare-os390.sh ~/tk5-build/tk5
# install the volumes and fill in os390/conf/os390.cnf (above)
cat > .env <<EOF
BIND_IP=<tailnet ip>     # never 0.0.0.0: the HTTP console has no auth
OS390_IP=10.1.1.2        # the guest's address on the LCS network
EOF
docker compose up -d --build
```

Then IPL. Depending on the config, either the `IPL` statement does it, or
you type `ipl <address>` at the HTTP console. Watch the progress there
(`http://<host>:8039`): reply to the IPL prompts as the ADCD documentation
says, then wait for VTAM and TSO.

## Checked so far (2026-11-24, no volumes yet)

On gpu-server, with Hercules 4.9.1:
- The container starts, and the config is read (ESA/390, CPU model 7060,
  512 MB, 2 CPUs).
- The HTTP console answers on 8039, and the 3270 port negotiates.
- An LCS adapter opens `tap0`, and the NAT rule for port 2323 is installed.

## Notes

- **Shut down cleanly.** Use OS/390's own shutdown before
  `docker compose stop`: stop the TSO users, VTAM and JES2, then `Z EOD`,
  following the ADCD documentation. A plain stop can damage the volumes.
- **TK5 is separate.** OS/390 has its own copy of Hercules and its own
  ports (TK5 uses 3270 and 8038), so the two can be restarted
  independently.
- **Root in the container.** Creating the guest's network interface and the
  NAT both need `NET_ADMIN`, so Hercules runs as root inside the container,
  and the files it creates in `./os390` belong to root.
- **SimH Assist** gets a `tn3270-target` machine for each port, with a TSO
  user ID pool and a `console` entry pointing at port 8039 (task 14f), once
  OS/390 is up.
