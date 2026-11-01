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
[ -f build/build.ninja ] || cmake -G Ninja -B build -DCMAKE_BUILD_TYPE=Release -DMLIR_DIR=/opt/homebrew/opt/llvm/lib/cmake/mlir -DCMAKE_CXX_COMPILER=$LLVM/clang++ -DCMAKE_C_COMPILER=$LLVM/clang >/dev/null
mkdir -p "$O"
ninja -C build >/dev/null
CC="$LLVM/clang -O3 -w"

HEAD="--milo-hoist-vec-reads --loop-invariant-code-motion"
TAIL="--cse --canonicalize --milo-expand-checks --convert-scf-to-cf --convert-milo-to-llvm --reconcile-unrealized-casts"
build/milo-opt test/kernels.mlir $HEAD --milo-version-bounds-checks $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir.ll"
build/milo-opt test/kernels.mlir $HEAD $TAIL | "$LLVM/mlir-translate" --mlir-to-llvmir > "$O/mlir-nov.ll"
(cd ..; bun run src/main.ts emit-ir --release mlir/bench/kernels.milo) \
  | sed -E 's/^define internal (void @(axpy|grid)\(.*\)) \{/define \1 noinline {/; s/@main\(/@milo_unused_main(/' > "$O/milo.ll"

sed -E "s/^(define void @axpy\(ptr noalias nonnull dereferenceable\(24\) align 8 %a, ptr) /\1 noalias /" "$O/milo.ll" > "$O/milo-noalias.ll"
grep -q "^define void @axpy(ptr noalias [^,]*, ptr noalias" "$O/milo-noalias.ll"
for v in mlir mlir-nov milo milo-noalias; do $CC bench/harness.c "$O/$v.ll" -o "$O/$v"; done

echo "== FileCheck: pass tests"
for t in test/version.mlir; do
  build/milo-opt "$t" --milo-hoist-vec-reads --milo-version-bounds-checks --canonicalize | "$LLVM/FileCheck" "$t"
done
echo ok

echo "== differential: same result bits on every size"
for v in mlir mlir-nov milo; do "$O/$v" check > "$O/$v.check"; done
cmp "$O/mlir.check" "$O/milo.check" && cmp "$O/mlir-nov.check" "$O/milo.check" && echo "ok ($(wc -l < "$O/milo.check" | tr -d ' ') cases)"

echo "== panic: a short b fails at idx b.len after exactly b.len writes, same as unversioned"
for bl in 50 99; do
  p1=$("$O/mlir" panic $bl || true); p2=$("$O/mlir-nov" panic $bl || true)
  [ "$p1" = "$p2" ] && echo "$p1" | grep -q "idx=$bl len=$bl line=4 written=$bl " || { echo "FAIL b.len=$bl: $p1"; exit 1; }
done
echo ok

echo "== hot loops (after clang -O3)"
for v in mlir milo; do
  $LLVM/clang -O3 -w -S -emit-llvm "$O/$v.ll" -o "$O/$v.opt.ll"
  for f in axpy grid; do
    awk "/^define.*@$f\\(/,/^}/" "$O/$v.opt.ll" > "$O/$v.$f.fn"
    printf "%-5s %-5s vector ops %3s  memchecks %s\n" "$v" "$f" \
      "$(grep -c 'x double>' "$O/$v.$f.fn" || true)" "$(grep -c 'memcheck' "$O/$v.$f.fn" || true)"
  done
done

echo "== bench"
for v in mlir milo milo-noalias; do printf "%-5s " "$v"; "$O/$v" bench; done
