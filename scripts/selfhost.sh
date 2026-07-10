#!/bin/sh
# Build milo-self (the Milo compiler written in Milo) with the TS compiler.
# The TS compiler is the oracle; this script only produces the stage-1 binary.
# Exits nonzero if it does not build. See docs/self-hosting.md.
#
# Runs under scripts/guard.ts so a runaway build can never eat all system
# memory (macOS enforces no rlimits — the guard is the only real cap).
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/.selfhost"
mkdir -p "$out"

exec bun "$root/scripts/guard.ts" --timeout-s 300 -- \
  bun run "$root/src/main.ts" build "$root/src-milo/main.milo" -o "$out/milo-self" "$@"
