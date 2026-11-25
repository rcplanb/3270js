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
- `conf/os390.cnf.template`: the Hercules configuration, filled in for the
  OS/390 R10 ADCD.
- `run-copies.sh`: makes the copy-on-write volumes OS/390 runs from.
- `entrypoint.sh`: runs Hercules in daemon mode with its stdin held open
  (Hercules stops at the end of stdin). With `OS390_IP` set, it NATs the
  container's port 2323 to OS/390's TN3270E server on `tap0`, the interface
  Hercules creates for the guest's LCS adapter.
- `compose.yaml`: binds every port to `BIND_IP` only, and gives the container
  `NET_ADMIN` and `/dev/net/tun` (its own network namespace only) for the
  guest's network.

## Getting the volumes

They are on the museum's Nextcloud, which is reachable only on the museum
tailnet. The OS/390 R10 ADCD is 12 volumes in Hercules CKD format (header
`CKD_P370`), named after the volser and the device address (`os39ra_1.a80`).
A 3390-3 comes in two files, `_1` and `_2`; Hercules opens the `_1` file and
finds the other itself. No conversion is needed.

1. Copy them to the host, into `~/os390-build/os390/dasd/`. Use `/home`,
   because the root filesystem is small. Check every size: each `_1` file
   of a split volume is 2,147,397,632 bytes, each `_2` file 699,034,112, and
   each 3390-2 1,897,620,992. A short file gives "ckd header inconsistent".
2. `./run-copies.sh` makes `os390/dasd-run/`, the copies OS/390 runs from
   (XFS reflink, so they cost nothing until written). `dasd/` stays as
   downloaded.

The museum's copy of `OS3DAA_1` is 45 KB short at its source. The missing
piece is part of one track (cylinder 2518, track 14) of the SMP/E CSI,
`MVS.MVSD.CSI.DATA`, which nothing uses at IPL. The run copy was padded to
full size with that track ended after its last whole record, so reads of the
missing records fail cleanly. Replace it if a whole copy turns up.

## Deploy

```sh
./prepare-os390.sh ~/tk5-build/tk5
# install the volumes (above), then:
./run-copies.sh
cat > .env <<EOF
BIND_IP=<tailnet ip>     # never 0.0.0.0: the HTTP console has no auth
OS390_IP=10.1.1.2        # the guest's address on the LCS network
EOF
docker compose up -d --build
```

## IPL

The config has no `IPL` statement: SDL Hercules runs commands it finds in
the config, so one there would IPL OS/390 unwatched. Connect to the master
console first (`c3270 CONS@<host>:3271`, twice: 0700 and 0908 are both
consoles), then at the Hercules console (`http://<host>:8039`):

```
iplc 0a80
```

`LOADPARM 0A82CS` picks the IODF on OS39M1 and `LOADCS`: a cold start (CLPA,
and JES2 `COLD,NOREQ`), so nothing a visitor did survives a re-IPL. On the
console:

- `IEA888A` (the clock): `R 00,U`.
- `IXC420D` (the sysplex), only when the couple data set says another system
  is active, as it does on the first IPL: `R 00,I`. After a clean shutdown
  it doesn't ask.
- `IFB081I LOGREC DATA SET IS FULL`: the ADCD ships with it full. Clear it
  with IFCEREP1 (`PARM='ACC=Y,ZERO=Y'`, `SERLOG DD DSN=SYS1.LOGREC`), then
  delete the message: `D R,L`, `K C,A,<id>`.

`PGMPRDOS LICENSED` is in the config: without it, Hercules stops the
processors when it sees a licensed IBM operating system (`HHC00131A`).

Ignore `*02 ISTEXC200 DYN COMMANDS MAY BE ENTERED` (VTAM's standing reply)
and the VTAM errors about IBM's own nodes and the local SNA links. In SDSF
(ISPF `M.5` on this ADCD), `PREFIX *` and `OWNER *` show every job.

## Network

The ADCD's active TCP/IP profile is `TCPIP.PROFILE.TCPIP` on OS39M1 (the
`PROFILE` DD of the `TCPIP` procedure), not `TCPIP.TCPPARMS(PROFILE)`. As
shipped it defines a CTC at E22 with IBM's own 9.24.71.x addresses. For the
LCS at E20, change it to:

```
 DEVICE LCS1   LCS           E20
 LINK ETH1  ETHERNET 0 LCS1
HOME
   10.1.1.2       ETH1
GATEWAY
 10            =         ETH1    1500     0.255.255.0   0.1.1.0
   defaultnet 10.1.1.1      ETH1   1500 0
START LCS1
```

and delete the `9.24.71.13 ... HOST` route. TCP/IP holds the profile open:
`P TCPIP` before editing, then re-IPL. The change lives on the run copy of
OS39M1, so `./run-copies.sh --reset` loses it.

The LCS must be in the config from the start: one attached after IPL is
never usable (`IEE025I UNIT 0E20 HAS NO LOGICAL PATHS`). Hercules can't give
the host end of `tap0` its address without `hercifc`, which the kit doesn't
have, so the entrypoint does (`OS390_HOST_CIDR`, default `10.1.1.1/24`).

## Checked (2026-11-25)

On gpu-server, with Hercules 4.9.1 and the OS/390 R10 ADCD:
- Cold IPL to TSO: JES2, VTAM, RACF, TCP/IP, a batch job (RC 0000).
- No DASD errors on any volume.
- OS/390's TN3270E server answers on port 2323 from the tailnet, and TSO
  logon works through it (c3270 and SimH Assist staging).

## Notes

- **Shut down cleanly.** Use OS/390's own shutdown before
  `docker compose stop`, waiting for each step: `S SHUTDOWN` (until VTAM is
  inactive, IST1201), `$PJES2`, `Z EOD`, `QUIESCE`. A plain stop can damage
  the volumes.
- **TK5 is separate.** OS/390 has its own copy of Hercules and its own
  ports (TK5 uses 3270 and 8038), so the two can be restarted
  independently.
- **Root in the container.** Creating the guest's network interface and the
  NAT both need `NET_ADMIN`, so Hercules runs as root inside the container,
  and the files it creates in `./os390` belong to root.
- **SimH Assist** reaches it as a `tn3270-target` machine on port 2323.
  A TSO user ID pool and a `console` entry (port 8039, task 14f) come next.
