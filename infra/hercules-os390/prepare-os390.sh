#!/bin/bash
# Prepare ./os390 on the host: a copy of the TK5 kit's SDL Hyperion (4.9.1,
# Linux x86_64), the directories, and the config template. Never touches
# ./os390/dasd (the licensed volumes) or an existing config.
#
# Usage: ./prepare-os390.sh <TK5 kit directory, e.g. ~/tk5-build/tk5>
set -euo pipefail
kit="${1:?usage: $0 <TK5 kit directory>}"
src="$kit/hercules/linux/64"
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/os390"
[[ -x "$src/bin/hercules" ]] || { echo "no Hercules at $src" >&2; exit 1; }
mkdir -p "$dest"/{dasd,conf,logs,prt}
if [[ -d "$dest/hercules" ]]; then
  echo "os390/hercules exists: left as it is"
else
  cp -a "$src" "$dest/hercules"
  cp -a "$kit/hercules/httproot" "$dest/hercules/httproot"   # the HTTP console's pages
  echo "Hercules copied from $src"
fi
if [[ -f "$dest/conf/os390.cnf" ]]; then
  echo "os390/conf/os390.cnf exists: left as it is"
else
  cp "$here/conf/os390.cnf.template" "$dest/conf/os390.cnf"
  echo "os390/conf/os390.cnf created from the template: fill in the ADCD's devices (README)"
fi
LD_LIBRARY_PATH="$dest/hercules/lib:$dest/hercules/lib/hercules" "$dest/hercules/bin/hercules" --version 2>&1 | grep -m1 'Hercules version'
