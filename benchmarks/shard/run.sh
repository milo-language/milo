#!/usr/bin/env bash
# std/shard parallelMap vs a sequential transform vs C pthreads over one shared buffer.
#
#   sh benchmarks/shard/run.sh
#
# Unlike the other benchmarks here this one reports PEAK MEMORY as well as time,
# because memory is the claim: the move-only route to parallelism used to force a
# copy per worker, and the point of parallelMap is that it does not. Time alone
# would hide the thing being measured, so hyperfine (which does not report RSS) is
# not used.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
MILO="${MILO:-$REPO/milo}"
CC_BIN="${CC:-clang}"
RUNS="${RUNS:-3}"

# Peak RSS in MiB. macOS `time -l` reports bytes, GNU `time -v` reports kilobytes.
peak_mb() {
  case "$(uname -s)" in
    Darwin) awk '/maximum resident set size/ { printf "%.1f", $1/1048576 }' "$1" ;;
    *)      awk '/Maximum resident set size/ { printf "%.1f", $NF/1024 }' "$1" ;;
  esac
}

run_one() {
  label="$1"; shift
  best_ms=""; best_mb=""
  i=0
  while [ "$i" -lt "$RUNS" ]; do
    /usr/bin/time -l "$@" >"$DIR/.out" 2>"$DIR/.err" || /usr/bin/time -v "$@" >"$DIR/.out" 2>"$DIR/.err"
    ms=$(sed -n 's/.*ms=\([0-9][0-9]*\).*/\1/p' "$DIR/.out" | head -1)
    mb=$(peak_mb "$DIR/.err")
    if [ -n "$ms" ] && { [ -z "$best_ms" ] || [ "$ms" -lt "$best_ms" ]; }; then
      best_ms="$ms"; best_mb="$mb"
    fi
    i=$((i + 1))
  done
  printf "%-28s %6s ms   %8s MiB peak\n" "$label" "${best_ms:-?}" "${best_mb:-?}"
}

echo "building..."
"$MILO" build "$DIR/shard_seq.milo" --release -o "$DIR/shard_seq" >/dev/null || exit 1
"$MILO" build "$DIR/shard_par.milo" --release -o "$DIR/shard_par" >/dev/null || exit 1
if ! "$CC_BIN" -O2 -pthread "$DIR/shard.c" -o "$DIR/shard_c" 2>/dev/null; then
  echo "note: no working C compiler at '$CC_BIN'; skipping the C row (set CC=)"
  HAVE_C=0
else
  HAVE_C=1
fi

echo "20M f64, a[i] = a[i] * 1.0000001 + 0.5, 4 workers, best of $RUNS"
echo
run_one "milo sequential" "$DIR/shard_seq"
run_one "milo parallelMap x4" "$DIR/shard_par"
[ "$HAVE_C" = 1 ] && run_one "c pthreads (shared buffer)" "$DIR/shard_c"
echo
echo "The memory column is the claim: parallel must not cost materially more than"
echo "sequential. The residual is worker stacks, a fixed cost that does not grow with n."
rm -f "$DIR/.out" "$DIR/.err"
