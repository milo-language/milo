#!/bin/sh
# One command: build milo-opt, run every gate (check.sh), then lower the kernels three ways
# and benchmark them.
#   mlir       milo-opt full pipeline on test/kernels.mlir (versioning on)
#   mlir-nov   the same pipeline without versioning (every check kept): the reference
#   milo-mlir  bench/kernels.milo through the default milo build
set -eu
cd "$(dirname "$0")"
LLVM=${MILO_LLVM_BIN:-/opt/homebrew/opt/llvm/bin}
O=build/out
sh ./build.sh
sh ./check.sh
mkdir -p "$O"
CC="$LLVM/clang -O3 -w"

HEAD="--milo-hoist-vec-reads --loop-invariant-code-motion"
TAIL="--cse --canonicalize --milo-expand-checks --convert-scf-to-cf --convert-milo-to-llvm --reconcile-unrealized-casts"
build/milo-opt test/kernels.mlir $HEAD --milo-version-bounds-checks $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir.ll"
build/milo-opt test/kernels.mlir $HEAD $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir-nov.ll"
(cd ..; bun run src/main.ts emit-ir --release mlir/bench/kernels.milo) \
  | sed -E 's/^define internal (void @(axpy|grid)\(.*\)) \{/define \1 noinline {/; s/@main\(/@milo_unused_main(/' > "$O/milo-mlir.ll"
# The MLIR body is what carries TBAA; without it MLIR did not take axpy.
awk '/^define void @axpy/,/^}/' "$O/milo-mlir.ll" | grep -q "!tbaa" || { echo "FAIL: the default build did not compile axpy through MLIR"; exit 1; }

for v in mlir mlir-nov milo-mlir; do $CC bench/harness.c "$O/$v.ll" -o "$O/$v"; done

echo "== differential: same result bits on every size"
for v in mlir mlir-nov milo-mlir; do "$O/$v" check > "$O/$v.check"; done
cmp "$O/mlir.check" "$O/mlir-nov.check" && cmp "$O/milo-mlir.check" "$O/mlir-nov.check" && echo "ok ($(wc -l < "$O/mlir-nov.check" | tr -d ' ') cases)"

echo "== panic: a short b fails at idx b.len after exactly b.len writes, same as unversioned"
for bl in 50 99; do
  p1=$("$O/mlir" panic $bl || true); p2=$("$O/mlir-nov" panic $bl || true)
  [ "$p1" = "$p2" ] && echo "$p1" | grep -q "idx=$bl len=$bl line=4 written=$bl " || { echo "FAIL b.len=$bl: $p1"; exit 1; }
done
echo ok

echo "== hot loops (after clang -O3)"
for v in mlir mlir-nov milo-mlir; do
  $LLVM/clang -O3 -w -S -emit-llvm "$O/$v.ll" -o "$O/$v.opt.ll"
  for f in axpy grid; do
    awk "/^define.*@$f\\(/,/^}/" "$O/$v.opt.ll" > "$O/$v.$f.fn"
    printf "%-5s %-5s vector ops %3s  memchecks %s\n" "$v" "$f" \
      "$(grep -c 'x double>' "$O/$v.$f.fn" || true)" "$(grep -c 'memcheck' "$O/$v.$f.fn" || true)"
  done
done

echo "== bench"
for v in mlir mlir-nov milo-mlir; do printf "%-5s " "$v"; "$O/$v" bench; done
