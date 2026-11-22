#!/usr/bin/env bash
# Download the official TK5 distribution, verify it, and unpack it for the
# container. Usage: ./fetch-tk5.sh [target-dir]   (default: ./tk5)
# Refuses to overwrite an existing target, which holds live DASD.
set -euo pipefail

TK5_URL=https://www.prince-webdesign.nl/images/downloads/mvs-tk5.zip
TK5_SHA256=710d002843631322810a276dd42c793fda458548dc64d86e2914a62db7425f84
TARGET=${1:-./tk5}

if [[ -e "$TARGET" ]]; then
  echo "error: $TARGET already exists; move it aside to reinstall" >&2
  exit 1
fi

# Stage next to the target, not in /tmp (often a small root filesystem).
tmp=$(mktemp -d "$(dirname "$TARGET")/.tk5-fetch.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "Downloading TK5..."
curl -fSL --progress-bar -o "$tmp/mvs-tk5.zip" "$TK5_URL"
echo "$TK5_SHA256  $tmp/mvs-tk5.zip" | sha256sum -c -

echo "Unpacking..."
python3 -m zipfile -e "$tmp/mvs-tk5.zip" "$tmp"
mv "$tmp/mvs-tk5" "$TARGET"

# Keep only the linux x86_64 Hercules build.
rm -rf "$TARGET"/hercules/{darwin,windows} \
       "$TARGET"/hercules/linux/{32,arm,arm_softfloat,aarch64}
# No unattended/mode file = daemon mode: Hercules runs headless, logs to stdout.
rm -f "$TARGET/unattended/mode"
# zipfile does not preserve permissions.
find "$TARGET" -type f \( -name '*.so*' -o -path '*/bin/*' \) -exec chmod +x {} +
chmod +x "$TARGET"/mvs "$TARGET"/mvs_ipl
find "$TARGET" -maxdepth 2 -type f -name '*.sh' -exec chmod +x {} +

echo "TK5 unpacked to $TARGET"
