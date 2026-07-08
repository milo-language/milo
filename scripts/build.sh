#!/bin/sh
# Build a standalone, self-contained milo binary: the stdlib is regenerated into
# src/stdlib-bundle.ts (gitignored) and baked into the binary by `bun build
# --compile`, so the shipped binary compiles Milo programs and serves LSP
# hover/goto/api with NO std/ on disk. Disk always wins in a dev checkout, so the
# embedded copy is a pure fallback and never goes stale there.
#
#   scripts/build.sh            # -> ./milo
#   scripts/build.sh /path/out  # -> custom output path
set -e
cd "$(dirname "$0")/.."

out="${1:-milo}"

echo "+ regenerating stdlib bundle"
bun run scripts/bundle-stdlib.ts

echo "+ compiling standalone binary"
bun build --compile src/main.ts --outfile "$out"

echo "built $out (stdlib embedded)"
