#!/usr/bin/env bash
# Benchmark Milo vs C vs Go.
# Uses hyperfine for wall-clock measurement (median of N runs).

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DIR")"
MILO="bun run $REPO/src/main.ts"
RUNS=${RUNS:-10}
WARMUP=${WARMUP:-2}

CC=${CC:-clang}
CFLAGS=${CFLAGS:--O2 -march=native}
GOFLAGS=${GOFLAGS:-}

bold() { printf "\033[1m%s\033[0m\n" "$*"; }

# ── fib ──
bold "==> fib(42)"
cd "$DIR/fib"
$MILO build fib.milo -o fib_milo > /dev/null
$CC $CFLAGS fib.c -o fib_c
go build $GOFLAGS -o fib_go fib.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-fib.md" \
  -n "milo" "./fib_milo" \
  -n "c"    "./fib_c" \
  -n "go"   "./fib_go"

# ── grep ──
bold "==> grep 'fox' on 5MB file"
cd "$DIR/grep"
INPUT="$DIR/grep/input.txt"
if [ ! -f "$INPUT" ]; then
  python3 -c "
for i in range(100000):
    print(f'line {i}: the quick brown fox jumps over the lazy dog')
" > "$INPUT"
fi
$MILO build grep.milo -o grep_milo > /dev/null
$CC $CFLAGS grep.c -o grep_c
go build $GOFLAGS -o grep_go grep.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-grep.md" \
  -n "milo"      "./grep_milo fox $INPUT" \
  -n "c"         "./grep_c fox $INPUT" \
  -n "go"        "./grep_go fox $INPUT" \
  -n "sys grep"  "grep -c fox $INPUT"

bold "==> results saved to $DIR/results-*.md"
