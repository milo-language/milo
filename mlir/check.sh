#!/bin/sh
# Correctness gates for the milo dialect, fast enough for CI (~1 min): FileCheck tests,
# dialect hygiene, round-trip of every test file and every emitted program module, and the
# interpreter-oracle gate on test/programs. mlir/run.sh adds the kernel benchmarks on top.
# Every count is checked against what exists on disk, so a gate that silently stops
# matching files fails instead of reporting a smaller "ok".
set -eu
cd "$(dirname "$0")"
LLVM=${MILO_LLVM_BIN:-/opt/homebrew/opt/llvm/bin}
[ -x build/milo-opt ] || { echo "FAIL: build/milo-opt is not built (sh mlir/build.sh)"; exit 1; }

echo "== FileCheck: every test/*.mlir with a RUN line (lit-style, run as written)"
# kernels.mlir is benchmark input for run.sh, not a test; every other file must carry a RUN line.
for t in test/*.mlir; do
  [ "$t" = test/kernels.mlir ] && continue
  grep -q "^// RUN: " "$t" || { echo "FAIL: $t has no RUN line"; exit 1; }
done
want=$(ls test/*.mlir | grep -vc '^test/kernels.mlir$')
n=0
for t in test/*.mlir; do
  cmd=$(sed -n "s|^// RUN: ||p" "$t")
  [ -n "$cmd" ] || continue
  cmd=$(printf "%s" "$cmd" | sed "s|%s|$t|g; s|milo-opt|build/milo-opt|g; s|FileCheck|$LLVM/FileCheck|g")
  sh -c "$cmd" > /dev/null || { echo "FAIL $t"; exit 1; }
  n=$((n + 1))
done
[ "$n" -eq "$want" ] && [ "$n" -gt 0 ] || { echo "FAIL: $n FileCheck tests ran, $want exist"; exit 1; }
echo "ok ($n files)"

echo "== dialect hygiene: docs on every op, no count below its baseline"
out=$(cd .. && bun scripts/dialect-hygiene.ts 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -1

echo "== round-trip: generic form and bytecode print, parse back, print the same"
# --verify-roundtrip (MlirOptMain): every test file of valid IR, and the module the emitter
# prints for every test/programs program (MILO_MLIR_DUMP), 8 at a time.
RT=build/roundtrip
rm -rf "$RT"
mkdir -p "$RT"
n=0
for t in test/*.mlir; do
  grep -q "verify-diagnostics" "$t" && continue
  build/milo-opt --verify-roundtrip -split-input-file "$t" > /dev/null 2> "$RT/err" || { echo "FAIL $t"; head -20 "$RT/err"; exit 1; }
  n=$((n + 1))
done
# Trap programs exit non-zero by design, so emit-ir's status is ignored; the module count
# below is what catches a program that emitted nothing.
ls test/programs/*.milo | xargs -P 8 -I{} sh -c \
  'cd .. && MILO_MLIR_DUMP="mlir/$1/$(basename "$2" .milo).mlir" bun src/main.ts emit-ir "mlir/$2" > /dev/null 2>&1; true' _ "$RT" {}
progs=$(ls test/programs/*.milo | wc -l | tr -d ' ')
m=0
for e in "$RT"/*.mlir; do
  [ -e "$e" ] || continue
  build/milo-opt --verify-roundtrip "$e" > /dev/null 2> "$RT/err" || { echo "FAIL $e"; head -20 "$RT/err"; exit 1; }
  m=$((m + 1))
done
[ "$m" -eq "$progs" ] || { echo "FAIL: $m emitted modules for $progs programs"; exit 1; }
echo "ok ($n test files, $m emitted modules)"

echo "== oracle: test/programs built through MLIR match the reference interpreter (stdout, exit)"
out=$(cd .. && bun scripts/mlir-same.ts --programs 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -1
