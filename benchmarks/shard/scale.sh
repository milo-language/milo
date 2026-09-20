#!/usr/bin/env bash
# Worker scaling for std/shard (parallelMapWith) on a compute-bound kernel.
#
#   sh benchmarks/shard/scale.sh
#
# Separate from run.sh because the two measure different claims. run.sh uses a
# single-pass elementwise transform, which is memory-bandwidth-bound: it shows that
# parallelism no longer costs a copy, but four workers cannot beat the memory bus so
# it says nothing about speedup. This one does real arithmetic per element, where
# adding cores actually shows.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MILO="${MILO:-$(cd "$DIR/../.." && pwd)/milo}"
RUNS="${RUNS:-3}"
INNER="${INNER:-200}"

"$MILO" build "$DIR/shard_scale.milo" --release -o "$DIR/shard_scale" >/dev/null || exit 1

echo "2M f64, $INNER rounds of arithmetic each, best of $RUNS"
echo
base=""
for w in 1 2 4 8 10; do
  best=""
  i=0
  while [ "$i" -lt "$RUNS" ]; do
    ms=$("$DIR/shard_scale" "$w" "$INNER" | sed -n 's/.*ms=\([0-9][0-9]*\).*/\1/p')
    if [ -n "$ms" ] && { [ -z "$best" ] || [ "$ms" -lt "$best" ]; }; then best="$ms"; fi
    i=$((i + 1))
  done
  [ -z "$base" ] && base="$best"
  printf "%2s workers  %5s ms   %sx\n" "$w" "$best" "$(awk -v b="$base" -v c="$best" 'BEGIN{printf "%.2f", b/c}')"
done
