#!/bin/bash
# Make the volumes OS/390 runs from (os390/dasd-run) as copy-on-write
# (XFS reflink) copies of the downloaded ones (os390/dasd), which are never
# written to. A copy costs no space until OS/390 changes a track.
#
#   ./run-copies.sh          copy any volume not yet in dasd-run
#   ./run-copies.sh --reset  replace them all: back to the ADCD as shipped
#                            (only with Hercules stopped)
#
# --reset also throws away changes made on the running system, including
# TCPIP.PROFILE.TCPIP on OS39M1 (LCS1 at E20, HOME 10.1.1.2; saved in
# parms/TCPIP.PROFILE.TCPIP.lcs-20261125.txt): redo them after a reset.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/os390/dasd"; dst="$here/os390/dasd-run"
reset=0; [[ "${1:-}" == "--reset" ]] && reset=1
if (( reset )) && pgrep -f "hercules.*os390.cnf" >/dev/null; then
  echo "Hercules is running with os390.cnf: stop it first" >&2; exit 1
fi
mkdir -p "$dst"
for f in "$src"/*.a8?; do
  name=$(basename "$f")
  if [[ -e "$dst/$name" && $reset -eq 0 ]]; then continue; fi
  cp --reflink=always -f "$f" "$dst/$name"
  echo "copied $name"
done
