#!/bin/sh
# Milo against Goose, C++ and Rust on five benchmarks from Goose's own suite
# (records, interp, graph, blur, respond), at the suite's three sizes. The Goose,
# C++ and Rust sources are read from a Goose checkout, not copied here. Writes
# results.md and exits nonzero if any row's checksum disagrees with the others.
#   G=~/src/goose ./benchmarks/vs-goose/run.sh [records,interp,...]
# G must be a built Goose checkout (cmake -B build && cmake --build build).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
: "${G:?set G to a built Goose checkout (https://github.com/aardappel/goose)}"
export G
export GOOSE="$G/build/goose"
export MILO="${MILO:-$HERE/../../milo}"
export CLANG="${CLANG:-clang}"
export CLANGXX="${CLANGXX:-clang++}"
export RUSTC="${RUSTC:-rustc}"
rm -rf "$HERE/gen"
exec python3 -I -B "$HERE/bench.py" "${1:-}"
