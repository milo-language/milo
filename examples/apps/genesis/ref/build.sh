#!/usr/bin/env bash
# Build the Musashi-based Genesis 68k reference harness -> /tmp/ga-ref.
# Clones Musashi (gitignored) on first run and generates its opcode tables.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d musashi ]; then
  git clone --depth 1 https://github.com/kstenerud/Musashi musashi
fi

# Musashi generates m68kops.c/.h from m68k_in.c via m68kmake.
if [ ! -f musashi/m68kops.c ]; then
  ( cd musashi && cc -O2 -o m68kmake m68kmake.c && ./m68kmake )
fi

cc -O2 -I musashi -o /tmp/ga-ref \
  ref.c \
  musashi/m68kcpu.c musashi/m68kops.c musashi/m68kdasm.c \
  musashi/softfloat/softfloat.c 2>/dev/null || \
cc -O2 -I musashi -o /tmp/ga-ref \
  ref.c musashi/m68kcpu.c musashi/m68kops.c musashi/m68kdasm.c

echo "built /tmp/ga-ref"
