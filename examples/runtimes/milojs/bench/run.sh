#!/bin/sh
# milojs microbenchmark harness.
#
# Reports best-of-3 wall time for each bench under milojs and under bun, plus
# the milojs/bun ratio. The ratio is the signal, not the absolute time: it
# normalizes away workload size, so a bench whose ratio is far above the others
# points at a mechanism milojs handles disproportionately badly.
#
# Benches come in PAIRS that differ in exactly one dimension (see the header
# comment in each .js). Compare within a pair to attribute cost to a mechanism;
# `noop` is the startup floor and is subtracted from every other measurement.
#
# Usage: examples/runtimes/milojs/bench/run.sh <path-to-milojs-binary>

set -eu
ENGINE="${1:?usage: run.sh <path-to-milojs-binary>}"
DIR="$(dirname "$0")"
REPS=3

BENCHES="noop numRead strRead localRead deepRead propFew propMany protoDeep callFn callArrow arith objChurn"

# Best-of-N wall milliseconds for "$@".
best_ms() {
  best=""
  i=0
  while [ "$i" -lt "$REPS" ]; do
    start=$(perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000')
    "$@" >/dev/null 2>&1
    end=$(perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000')
    ms=$((end - start))
    if [ -z "$best" ] || [ "$ms" -lt "$best" ]; then best=$ms; fi
    i=$((i + 1))
  done
  echo "$best"
}

printf '%-12s %10s %10s %10s\n' bench milojs_ms bun_ms ratio
printf '%s\n' '------------------------------------------------'

floor_milo=0
floor_bun=0
for b in $BENCHES; do
  f="$DIR/$b.js"
  m=$(best_ms "$ENGINE" "$f")
  n=$(best_ms bun "$f")

  if [ "$b" = noop ]; then
    floor_milo=$m
    floor_bun=$n
    printf '%-12s %10s %10s %10s   (startup floor, subtracted below)\n' "$b" "$m" "$n" -
    continue
  fi

  # Subtract startup so we compare execution, not process spawn. Clamp at 1ms:
  # a bench cannot be faster than the floor except by measurement noise.
  am=$((m - floor_milo)); [ "$am" -lt 1 ] && am=1
  an=$((n - floor_bun));  [ "$an" -lt 1 ] && an=1

  ratio=$(perl -e "printf '%.1f', $am/$an")
  printf '%-12s %10s %10s %10s\n' "$b" "$am" "$an" "${ratio}x"
done
