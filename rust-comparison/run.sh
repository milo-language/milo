#!/usr/bin/env bash
# Runs each rust-comparison receipt through BOTH compilers and prints the raw outcome
# side by side. No assertions — you read the behavior yourself. That's the point.
#
#   ./run.sh            # release-mode (the shipped default for both)
#   ./run.sh --debug    # debug-mode (shows overflow/contract traps turning on)
#
# Requires: rustc (release uses -O), and the repo's ./milo wrapper.
set -u
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
MILO="$ROOT/milo"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DEBUG=0
[ "${1:-}" = "--debug" ] && DEBUG=1

# classify a rust build+run
rust_outcome() {
  local src="$1" bin="$TMP/rs" err="$TMP/rs.err"
  local flags="-O"; [ $DEBUG -eq 1 ] && flags="-g -C debug-assertions=on"
  if ! rustc $flags "$src" -o "$bin" 2>"$err"; then
    echo "COMPILE-ERROR: $(grep -m1 -oE 'error\[E[0-9]+\][^\n]*' "$err" | cut -c1-48)"; return
  fi
  local out rc
  out="$("$bin" 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then echo "RUNTIME-PANIC (exit $rc): $(printf '%s' "$out" | grep -m1 -iE 'panic|overflow|bounds' | cut -c1-40)"
  else echo "ran clean -> '$out'"; fi
}

# classify a milo build+run
milo_outcome() {
  local src="$1" flags=""; [ $DEBUG -eq 1 ] && flags="--debug"
  local out rc
  out="$("$MILO" run $flags "$src" 2>&1)"; rc=$?
  local clean; clean="$(printf '%s' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
  # runtime traps first — Milo's abort messages ("runtime error: ...", "milo: ...")
  # contain the word "error", so they must be matched before the compile-error case.
  if printf '%s' "$clean" | grep -qiE "runtime error:|milo:.*(bounds|division|overflow)"; then
    echo "RUNTIME-TRAP: $(printf '%s' "$clean" | grep -m1 -iE 'runtime error:|milo:' | cut -c1-42)"
  elif printf '%s' "$clean" | grep -qiE "^error|error:"; then
    echo "COMPILE-ERROR: $(printf '%s' "$clean" | grep -m1 -iE 'error' | sed 's/error: //I' | cut -c1-48)"
  elif [ $rc -ne 0 ]; then echo "RUNTIME-TRAP (exit $rc)"
  else echo "ran clean -> '$(printf '%s' "$clean" | tr '\n' ' ' | cut -c1-40)'"; fi
}

mode="release"; [ $DEBUG -eq 1 ] && mode="debug"
echo "=== Rust vs Milo memory-safety receipts ($mode mode) ==="
for d in */; do
  d="${d%/}"; [ -f "$d/rust.rs" ] || continue
  echo ""
  echo "▶ $d"
  [ -f "$d/about.txt" ] && echo "  $(cat "$d/about.txt")"
  echo "  rust: $(rust_outcome "$d/rust.rs")"
  echo "  milo: $(milo_outcome "$d/milo.milo")"
done
echo ""
echo "Read each pair: a compile-error or runtime-trap is safe. 'ran clean' with a"
echo "wrong value (see stale_handle rust) is the silent-corruption case Milo closes."
