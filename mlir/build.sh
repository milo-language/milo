#!/bin/sh
# Build mlir/build/milo-opt (the MLIR half of every default milo build) against an installed
# LLVM/MLIR 23: Homebrew's, or apt.llvm.org's /usr/lib/llvm-23.
#   MILO_LLVM_BIN=<dir>   the LLVM install's bin/ (default: first of the usual places that exists)
#   MILO_OPT_STATIC=1     link MLIR and LLVM statically (what release archives ship)
set -eu
cd "$(dirname "$0")"
if [ -z "${MILO_LLVM_BIN:-}" ]; then
  for d in /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin /home/linuxbrew/.linuxbrew/opt/llvm/bin /usr/lib/llvm-23/bin; do
    [ -x "$d/clang" ] && MILO_LLVM_BIN=$d && break
  done
fi
LLVM=${MILO_LLVM_BIN:?no LLVM 23 install found: brew install llvm, or set MILO_LLVM_BIN to its bin/}
STATIC=OFF
[ "${MILO_OPT_STATIC:-}" = 1 ] && STATIC=ON
# The static and dynamic builds must not share a cache: the flag changes the link line.
BUILD=${MILO_OPT_BUILD_DIR:-build}
# Quiet on success; a failing step prints its whole log (compiler errors included).
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
quiet() { "$@" >"$LOG" 2>&1 || { cat "$LOG" >&2; exit 1; }; }
[ -f "$BUILD/build.ninja" ] || quiet cmake -G Ninja -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DMILO_STATIC=$STATIC \
  -DMLIR_DIR="$LLVM/../lib/cmake/mlir" -DCMAKE_CXX_COMPILER="$LLVM/clang++" -DCMAKE_C_COMPILER="$LLVM/clang"
quiet ninja -C "$BUILD"
# The dialect reference, generated from Milo.td (never edited by hand): the doc-meta header,
# then mlir-tblgen's page. scripts/dialect-hygiene.ts fails when it is stale.
DOC=../docs/dialect/milo.md
mkdir -p ../docs/dialect
{
  printf '%s\n' '<!-- doc-meta' 'system: milo-dialect-reference' \
    'purpose: every op, type and attribute of the milo MLIR dialect, generated from mlir/Milo.td' \
    'key-files: mlir/Milo.td, mlir/build.sh, scripts/dialect-hygiene.ts' \
    'update-when: never by hand: sh mlir/build.sh regenerates it' 'last-verified: generated' '-->' ''
  "$LLVM/mlir-tblgen" -gen-dialect-doc -dialect=milo -I "$LLVM/../include" Milo.td
} > "$DOC.tmp" && mv "$DOC.tmp" "$DOC"
# A no-op ninja leaves the binary older than freshly touched sources; src/mlir-backend.ts
# would then call it stale.
touch "$BUILD/milo-opt"
