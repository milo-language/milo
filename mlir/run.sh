#!/bin/sh
# One command: build milo-opt, lower the kernels three ways, run every gate.
#   mlir      milo-opt full pipeline (versioning on)
#   mlir-nov  milo-opt pipeline without versioning (same lowering, every check kept)
#   milo      today's Milo codegen of bench/kernels.milo
#   milo-noalias  the same IR plus noalias on axpy's b (the one-attribute alternative)
set -eu
cd "$(dirname "$0")"
LLVM=/opt/homebrew/opt/llvm/bin
O=build/out
sh ./build.sh
mkdir -p "$O"
CC="$LLVM/clang -O3 -w"

HEAD="--milo-hoist-vec-reads --loop-invariant-code-motion"
TAIL="--cse --canonicalize --milo-expand-checks --convert-scf-to-cf --convert-milo-to-llvm --reconcile-unrealized-casts"
build/milo-opt test/kernels.mlir $HEAD --milo-version-bounds-checks $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir.ll"
build/milo-opt test/kernels.mlir $HEAD $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir-nov.ll"
(cd ..; MILO_LEGACY=1 bun run src/main.ts emit-ir --release mlir/bench/kernels.milo) \
  | sed -E 's/^define internal (void @(axpy|grid)\(.*\)) \{/define \1 noinline {/; s/@main\(/@milo_unused_main(/' > "$O/milo.ll"

# milo-mlir: kernels.milo itself through the default build (emitter, versioning, legacy splice).
(cd ..; env -u MILO_LEGACY bun run src/main.ts emit-ir --release mlir/bench/kernels.milo) \
  | sed -E 's/^define internal (void @(axpy|grid)\(.*\)) \{/define \1 noinline {/; s/@main\(/@milo_unused_main(/' > "$O/milo-mlir.ll"
# The MLIR body is what carries TBAA; without it MLIR did not take axpy.
awk '/^define void @axpy/,/^}/' "$O/milo-mlir.ll" | grep -q "!tbaa" || { echo "FAIL: the default build did not compile axpy through MLIR"; exit 1; }

sed -E "s/^(define void @axpy\(ptr noalias nonnull dereferenceable\(24\) align 8 %a, ptr) /\1 noalias /" "$O/milo.ll" > "$O/milo-noalias.ll"
grep -q "^define void @axpy(ptr noalias [^,]*, ptr noalias" "$O/milo-noalias.ll"
for v in mlir mlir-nov milo milo-noalias milo-mlir; do $CC bench/harness.c "$O/$v.ll" -o "$O/$v"; done

echo "== FileCheck: every test/*.mlir with a RUN line (lit-style, run as written)"
n=0
for t in test/*.mlir; do
  cmd=$(sed -n "s|^// RUN: ||p" "$t")
  [ -n "$cmd" ] || continue
  cmd=$(printf "%s" "$cmd" | sed "s|%s|$t|g; s|milo-opt|build/milo-opt|g; s|FileCheck|$LLVM/FileCheck|g")
  sh -c "$cmd" > /dev/null || { echo "FAIL $t"; exit 1; }
  n=$((n + 1))
done
[ "$n" -ge 4 ] || { echo "FAIL: only $n FileCheck tests ran"; exit 1; }
echo "ok ($n files)"

echo "== dialect hygiene: docs on every op, no count below its baseline"
(cd .. && bun scripts/dialect-hygiene.ts) | tail -1

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
ls test/programs/*.milo | xargs -P 8 -I{} sh -c \
  'cd .. && MILO_MLIR_DUMP="mlir/$1/$(basename "$2" .milo).mlir" bun src/main.ts emit-ir "mlir/$2" > /dev/null 2>&1; true' _ "$RT" {}
m=0
for e in "$RT"/*.mlir; do
  build/milo-opt --verify-roundtrip "$e" > /dev/null 2> "$RT/err" || { echo "FAIL $e"; head -20 "$RT/err"; exit 1; }
  m=$((m + 1))
done
[ "$m" -ge 90 ] || { echo "FAIL: only $m emitted modules"; exit 1; }
echo "ok ($n test files, $m emitted modules)"

echo "== default build vs MILO_LEGACY=1 on test/programs (scalar fns, every trap)"
out=$(cd .. && bun scripts/mlir-same.ts --programs 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -3

echo "== differential: same result bits on every size"
for v in mlir mlir-nov milo milo-mlir; do "$O/$v" check > "$O/$v.check"; done
cmp "$O/mlir.check" "$O/milo.check" && cmp "$O/mlir-nov.check" "$O/milo.check" && cmp "$O/milo-mlir.check" "$O/milo.check" && echo "ok ($(wc -l < "$O/milo.check" | tr -d ' ') cases)"

echo "== panic: a short b fails at idx b.len after exactly b.len writes, same as unversioned"
for bl in 50 99; do
  p1=$("$O/mlir" panic $bl || true); p2=$("$O/mlir-nov" panic $bl || true)
  [ "$p1" = "$p2" ] && echo "$p1" | grep -q "idx=$bl len=$bl line=4 written=$bl " || { echo "FAIL b.len=$bl: $p1"; exit 1; }
done
echo ok

echo "== hot loops (after clang -O3)"
for v in mlir milo milo-mlir; do
  $LLVM/clang -O3 -w -S -emit-llvm "$O/$v.ll" -o "$O/$v.opt.ll"
  for f in axpy grid; do
    awk "/^define.*@$f\\(/,/^}/" "$O/$v.opt.ll" > "$O/$v.$f.fn"
    printf "%-5s %-5s vector ops %3s  memchecks %s\n" "$v" "$f" \
      "$(grep -c 'x double>' "$O/$v.$f.fn" || true)" "$(grep -c 'memcheck' "$O/$v.$f.fn" || true)"
  done
done

echo "== bench"
for v in mlir milo milo-noalias milo-mlir; do printf "%-5s " "$v"; "$O/$v" bench; done
