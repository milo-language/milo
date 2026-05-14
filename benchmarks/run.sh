#!/usr/bin/env bash
# Benchmark Milo vs C vs Go.
# Uses hyperfine for wall-clock measurement (median of N runs).

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DIR")"
MILO="bun run $REPO/src/main.ts"
RUNS=${RUNS:-5}
WARMUP=${WARMUP:-1}

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
for i in range(20000):
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

# ── matmul ──
bold "==> 512x512 matmul"
cd "$DIR/matmul"
$MILO build matmul.milo -o matmul_milo > /dev/null
$CC $CFLAGS matmul.c -o matmul_c
go build $GOFLAGS -o matmul_go matmul.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-matmul.md" \
  -n "milo" "./matmul_milo" \
  -n "c"    "./matmul_c" \
  -n "go"   "./matmul_go"

# ── binary trees ──
bold "==> binarytrees depth 18"
cd "$DIR/binarytrees"
$MILO build binarytrees.milo -o binarytrees_milo > /dev/null
$CC $CFLAGS binarytrees.c -o binarytrees_c
go build $GOFLAGS -o binarytrees_go binarytrees.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-binarytrees.md" \
  -n "milo" "./binarytrees_milo" \
  -n "c"    "./binarytrees_c" \
  -n "go"   "./binarytrees_go"

# ── startup ──
bold "==> startup (empty main)"
cd "$DIR/startup"
$MILO build startup.milo -o startup_milo > /dev/null
$CC $CFLAGS startup.c -o startup_c
go build $GOFLAGS -o startup_go startup.go
hyperfine --warmup $WARMUP --runs 50 --export-markdown "$DIR/results-startup.md" \
  -n "milo" "./startup_milo" \
  -n "c"    "./startup_c" \
  -n "go"   "./startup_go"

# ── hashmap ──
bold "==> hashmap 100k insert+lookup"
cd "$DIR/maplookup"
$MILO build maplookup.milo -o maplookup_milo > /dev/null
$CC $CFLAGS maplookup.c -o maplookup_c
go build $GOFLAGS -o maplookup_go maplookup.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-maplookup.md" \
  -n "milo" "./maplookup_milo" \
  -n "c"    "./maplookup_c" \
  -n "go"   "./maplookup_go"

# ── stringops ──
bold "==> string concat 100k chunks"
cd "$DIR/stringops"
$MILO build stringops.milo -o stringops_milo > /dev/null
$CC $CFLAGS stringops.c -o stringops_c
go build $GOFLAGS -o stringops_go stringops.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-stringops.md" \
  -n "milo" "./stringops_milo" \
  -n "c"    "./stringops_c" \
  -n "go"   "./stringops_go"

# ── json ──
bold "==> JSON parse + walk (1MB)"
cd "$DIR/json"
$MILO build json.milo -o json_milo > /dev/null
$CC $CFLAGS json.c -I/opt/homebrew/include -L/opt/homebrew/lib -lyyjson -o json_c
go build $GOFLAGS -o json_go json.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-json.md" \
  -n "milo (stdlib)" "./json_milo $DIR/json/data.json" \
  -n "c (yyjson)"    "./json_c $DIR/json/data.json" \
  -n "go (stdlib)"   "./json_go $DIR/json/data.json"

# ── sieve of Eratosthenes ──
bold "==> sieve up to 10M"
cd "$DIR/sieve"
$MILO build sieve.milo -o sieve_milo > /dev/null
$CC $CFLAGS sieve.c -o sieve_c
go build $GOFLAGS -o sieve_go sieve.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-sieve.md" \
  -n "milo" "./sieve_milo" \
  -n "c"    "./sieve_c" \
  -n "go"   "./sieve_go"

# ── quicksort 2M f64s ──
bold "==> quicksort 2M f64s"
cd "$DIR/sort"
$MILO build sort.milo -o sort_milo > /dev/null
$CC $CFLAGS sort.c -o sort_c
go build $GOFLAGS -o sort_go sort.go
hyperfine --warmup $WARMUP --runs $RUNS --export-markdown "$DIR/results-sort.md" \
  -n "milo" "./sort_milo" \
  -n "c"    "./sort_c" \
  -n "go"   "./sort_go"

bold "==> results saved to $DIR/results-*.md"
