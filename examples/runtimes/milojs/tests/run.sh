#!/usr/bin/env bash
# Run every tests/*.js through milojs and diff against its *.expected (captured
# from bun). Regenerate an expected file with:  bun tests/foo.js > tests/foo.expected
#
# Two passes:
#   tests/*.js          run on the ENGINE  (milojs-engine.milo)
#   tests/runtime/*.js  run on the RUNTIME (milojs.milo)
# The runtime pass exists because R1 async activations only run on the runtime —
# the engine executes the program on the main thread and never spawns one, so a
# fixture for async-call ordering or promise adoption cannot be exercised on the
# engine at all. Anything that depends on activations goes in tests/runtime/.
#
# The binary for each pass is compiled ONCE and reused. `milo run` rebuilds on
# every invocation, so a per-test build cost a full LLVM compile per file. Set
# MILOJS_ENGINE_BIN / MILOJS_RUNTIME_BIN to reuse an existing build.
set -u
cd "$(dirname "$0")/../../../.." || exit 1
DIR="examples/runtimes/milojs/tests"
RUNTIME_DIR="$DIR/runtime"

PER_TEST_TIMEOUT="${MILOJS_TEST_TIMEOUT:-120}"
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
else
  echo "warning: no timeout(1); a hung fixture will hang this suite"
fi

fail=0

# run_pass <binary> <dir> <kind>: diff every dir/*.js against its .expected,
# executing through <binary>. <kind> is "engine" or "runtime", used only in
# messages. A hung fixture is killed with SIGKILL — a wedged green scheduler
# never reaches a point where it handles SIGTERM, so the default signal leaves
# it running (one such process ran for hours once, skewing later timings).
run_pass() {
  local bin="$1" dir="$2" kind="$3"
  local runner
  if [ -n "$TIMEOUT_CMD" ]; then
    runner="$TIMEOUT_CMD -s KILL $PER_TEST_TIMEOUT $bin"
  else
    runner="$bin"
  fi
  [ -d "$dir" ] || return 0
  for js in "$dir"/*.js; do
    [ -e "$js" ] || continue
    local name exp got status
    name="$(basename "$js" .js)"
    exp="$dir/$name.expected"
    [ -f "$exp" ] || { echo "SKIP $name (no .expected)"; continue; }
    # A GC-rooting fixture is vacuous at the default collection threshold — it
    # only exercises the root walk if a collection actually happens during the
    # window it sets up. Force one per allocation so `*Gc*` fixtures test R7.
    local gcenv=""
    case "$name" in *Gc*) gcenv="MILOJS_GC_THRESHOLD=1" ;; esac
    got="$(env $gcenv $runner "$js" 2>&1)"
    status=$?
    if [ $status -eq 137 ] || [ $status -eq 124 ]; then
      echo "FAIL $name ($kind, hung, killed after ${PER_TEST_TIMEOUT}s)"
      fail=1
      continue
    fi
    if [ "$got" = "$(cat "$exp")" ]; then
      echo "ok   $name"
    else
      echo "FAIL $name ($kind)"
      diff <(printf '%s\n' "$got") "$exp" | head -20
      fail=1
    fi
  done
}

# Resolve (or build) the engine binary.
if [ -n "${MILOJS_ENGINE_BIN:-}" ]; then
  ENGINE_BIN="$MILOJS_ENGINE_BIN"
  # Reject the runtime binary here: these expectations are captured against the
  # engine, and the runtime loads a different prelude, so it would run every
  # fixture and report plausible, wrong failures instead of erroring. The
  # runtime defines process; the engine does not.
  probe="$(printf 'console.log(typeof process)' | "$ENGINE_BIN" /dev/stdin 2>/dev/null)"
  if [ "$probe" = "object" ]; then
    echo "FAIL: MILOJS_ENGINE_BIN=$ENGINE_BIN looks like the runtime (milojs), not the engine."
    echo "      These fixtures expect a build of milojs-engine.milo."
    exit 1
  fi
else
  ENGINE_BIN="$(mktemp -t milojs-engine)"
  trap 'rm -f "$ENGINE_BIN"' EXIT
  if ! bun run src/main.ts build examples/runtimes/milojs/milojs-engine.milo -o "$ENGINE_BIN" >/dev/null; then
    echo "FAIL: engine did not build"
    exit 1
  fi
fi

run_pass "$ENGINE_BIN" "$DIR" engine

# Runtime pass, only if there are runtime fixtures to run.
if compgen -G "$RUNTIME_DIR/*.js" >/dev/null; then
  if [ -n "${MILOJS_RUNTIME_BIN:-}" ]; then
    RUNTIME_BIN="$MILOJS_RUNTIME_BIN"
    probe="$(printf 'console.log(typeof process)' | "$RUNTIME_BIN" /dev/stdin 2>/dev/null)"
    if [ "$probe" != "object" ]; then
      echo "FAIL: MILOJS_RUNTIME_BIN=$RUNTIME_BIN is not the runtime (milojs)."
      echo "      tests/runtime/ expects a build of milojs.milo."
      exit 1
    fi
  else
    RUNTIME_BIN="$(mktemp -t milojs-runtime)"
    trap 'rm -f "$ENGINE_BIN" "$RUNTIME_BIN"' EXIT
    if ! bun run src/main.ts build examples/runtimes/milojs/milojs.milo -o "$RUNTIME_BIN" >/dev/null; then
      echo "FAIL: runtime did not build"
      exit 1
    fi
  fi
  run_pass "$RUNTIME_BIN" "$RUNTIME_DIR" runtime
fi

exit $fail
