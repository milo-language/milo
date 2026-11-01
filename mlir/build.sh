#!/bin/sh
# Build mlir/build/milo-opt (what MILO_MLIR=1 runs) against Homebrew's LLVM/MLIR.
set -eu
cd "$(dirname "$0")"
LLVM=${MILO_LLVM_BIN:-/opt/homebrew/opt/llvm/bin}
[ -f build/build.ninja ] || cmake -G Ninja -B build -DCMAKE_BUILD_TYPE=Release \
  -DMLIR_DIR="$LLVM/../lib/cmake/mlir" -DCMAKE_CXX_COMPILER="$LLVM/clang++" -DCMAKE_C_COMPILER="$LLVM/clang" >/dev/null
ninja -C build >/dev/null
