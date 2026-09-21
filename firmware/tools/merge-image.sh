#!/usr/bin/env bash
# Merge a finished build into the single image the site flashes.
#
#   firmware/tools/merge-image.sh [build dir]
#
# Writes <build dir>/merged.bin (default .pio/build/crowpanel128, relative to
# firmware/). One image from 0x0 means the browser flasher needs a single part
# and no partition offset arithmetic.
#
# Both firmware.yml (on a release tag) and ci.yml (on every pull request) run
# this, so the command a release depends on is exercised long before a release
# needs it -- including after an esptool bump, which nothing else would test.
set -euo pipefail

BUILD=${1:-.pio/build/crowpanel128}
BOOT_APP0=$(find ~/.platformio/packages -name boot_app0.bin | head -1)
if [ -z "$BOOT_APP0" ]; then
  echo "boot_app0.bin not found under ~/.platformio/packages; run pio run first" >&2
  exit 1
fi

cd "$BUILD"
esptool --chip esp32s3 merge-bin -o merged.bin \
  --flash-mode dio --flash-freq 80m --flash-size 16MB \
  0x0 bootloader.bin \
  0x8000 partitions.bin \
  0xe000 "$BOOT_APP0" \
  0x10000 firmware.bin

# The same checks the Worker applies to an uploaded image. A CI release goes
# straight into KV without passing through them, so they are made here.
SIZE=$(stat -c%s merged.bin)
MAGIC=$(head -c1 merged.bin | od -An -tx1 | tr -d ' ')
if [ "$MAGIC" != "e9" ]; then
  echo "merged.bin does not start with the ESP32 image magic byte 0xE9 (got 0x$MAGIC)" >&2
  exit 1
fi
if [ "$SIZE" -lt $((64 * 1024)) ] || [ "$SIZE" -gt $((8 * 1024 * 1024)) ]; then
  echo "merged.bin is $SIZE bytes, outside the 64KB-8MB the site accepts" >&2
  exit 1
fi
echo "merged.bin: $SIZE bytes, magic 0x$MAGIC"
