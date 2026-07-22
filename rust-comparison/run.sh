#!/usr/bin/env bash
# Compile and run every Rust/Milo receipt, asserting its documented outcome.
set -uo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
MILO="$ROOT/milo"
RUSTC="${RUSTC:-rustc}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DEBUG=0
[ "${1:-}" = "--debug" ] && DEBUG=1

if ! command -v "$RUSTC" >/dev/null 2>&1 && [ ! -x "$RUSTC" ]; then
  echo "error: rustc not found; set RUSTC=/path/to/rustc" >&2
  exit 2
fi
if [ ! -x "$MILO" ]; then
  echo "error: Milo wrapper not found at $MILO" >&2
  exit 2
fi

rust_outcome() {
  local src="$1" bin="$TMP/rs" err="$TMP/rs.err" flags=(-O)
  rm -f "$bin" "$err"
  [ "$DEBUG" -eq 1 ] && flags=(-g -C debug-assertions=on)
  if ! "$RUSTC" "${flags[@]}" "$src" -o "$bin" 2>"$err"; then
    # fbsource's wrapper can request an unavailable bundled lld. This retry uses
    # the host linker without changing language or optimization semantics.
    if grep -q "self-contained linker was requested" "$err"; then
      "$RUSTC" -C linker-features=-lld "${flags[@]}" "$src" -o "$bin" 2>"$err"
    fi
  fi
  if [ ! -x "$bin" ]; then
    local raw; raw="$(cat "$err")"
    printf 'compile-error|%s' "$raw"
    return
  fi
  local out rc
  out="$("$bin" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then printf 'runtime-panic|%s' "$out"
  else printf 'clean|%s' "$out"; fi
}

milo_outcome() {
  local src="$1" flags=() out rc clean
  [ "$DEBUG" -eq 1 ] && flags=(--debug)
  out="$("$MILO" run "${flags[@]}" "$src" 2>&1)"; rc=$?
  clean="$(printf '%s' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
  if printf '%s' "$clean" | grep -qiE "runtime error:|milo:.*(bounds|division|overflow)"; then
    printf 'runtime-trap|%s' "$clean"
  elif printf '%s' "$clean" | grep -qiE "^error|error:"; then
    printf 'compile-error|%s' "$clean"
  elif [ "$rc" -ne 0 ]; then printf 'runtime-trap|%s' "$clean"
  else printf 'clean|%s' "$clean"; fi
}

expected() {
  local name="$1" side="$2" mode="$3"
  case "$name:$side:$mode" in
    contract:rust:*) echo 'runtime-panic|assertion failed' ;;
    contract:milo:*) echo "compile-error|requires clause 'lo <= hi' violated" ;;
    dangling_ref:rust:*) echo 'compile-error|E0515' ;;
    dangling_ref:milo:*) echo 'compile-error|cannot return a reference' ;;
    oob_index:rust:*) echo 'runtime-panic|index out of bounds' ;;
    oob_index:milo:*) echo 'runtime-trap|array index out of bounds' ;;
    overflow:rust:release) echo 'clean|-2147483648' ;;
    overflow:rust:debug) echo 'runtime-panic|attempt to add with overflow' ;;
    overflow:milo:release) echo 'clean|-2147483648' ;;
    overflow:milo:debug) echo 'runtime-trap|integer overflow' ;;
    stale_handle:rust:*) echo 'clean|arena[h] = carol' ;;
    stale_handle:milo:*) echo 'clean|caught: stale handle -> None' ;;
    steelman_arena:rust:*) echo 'clean|caught: stale key -> None' ;;
    steelman_arena:milo:*) echo 'clean|caught: stale handle -> None' ;;
    use_after_move:rust:*) echo 'compile-error|E0382' ;;
    use_after_move:milo:*) echo "compile-error|use of moved variable 'v'" ;;
    *) return 1 ;;
  esac
}

check_outcome() {
  local name="$1" side="$2" mode="$3" actual="$4" want want_class want_text got_class got_text
  if ! want="$(expected "$name" "$side" "$mode")"; then
    echo "  $side: FAIL (no expectation registered)"
    return 1
  fi
  want_class="${want%%|*}"; want_text="${want#*|}"
  got_class="${actual%%|*}"; got_text="${actual#*|}"
  if [ "$got_class" != "$want_class" ] || [[ "$got_text" != *"$want_text"* ]]; then
    echo "  $side: FAIL expected $want_class containing '$want_text'"
    printf '    got %s: %s\n' "$got_class" "$(printf '%s' "$got_text" | tr '\n' ' ' | cut -c1-180)"
    return 1
  fi
  printf '  %-5s PASS %-13s %s\n' "$side" "$got_class" "$(printf '%s' "$got_text" | tr '\n' ' ' | cut -c1-100)"
}

mode=release; [ "$DEBUG" -eq 1 ] && mode=debug
echo "=== Rust vs Milo safety receipts ($mode mode) ==="
failures=0
for d in */; do
  d="${d%/}"; [ -f "$d/rust.rs" ] || continue
  echo
  echo "[$d] $(cat "$d/about.txt")"
  rust="$(rust_outcome "$d/rust.rs")"
  milo="$(milo_outcome "$d/milo.milo")"
  check_outcome "$d" rust "$mode" "$rust" || failures=$((failures + 1))
  check_outcome "$d" milo "$mode" "$milo" || failures=$((failures + 1))
done

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures receipt assertion(s) failed" >&2
  exit 1
fi
echo "all receipt assertions passed"
