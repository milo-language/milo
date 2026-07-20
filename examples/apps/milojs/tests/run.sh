#!/usr/bin/env bash
# Run every tests/*.js through milojs and diff against its *.expected (captured
# from bun). Regenerate an expected file with:  bun tests/foo.js > tests/foo.expected
#
# The engine is compiled ONCE up front and the binary reused. `milo run` rebuilds
# on every invocation, so the old per-test `milo run` cost a full LLVM compile per
# test file — 49 compiles per suite run, enough to peg a core and set macOS
# scanning every fresh binary. Set MILOJS_ENGINE_BIN to reuse an existing build.
set -u
cd "$(dirname "$0")/../../../.." || exit 1
DIR="examples/apps/milojs/tests"

if [ -n "${MILOJS_ENGINE_BIN:-}" ]; then
  ENGINE_BIN="$MILOJS_ENGINE_BIN"
  # Reject the runtime binary. The expectations here are captured against the
  # ENGINE (milojs-engine.milo); the runtime (milojs.milo) loads a different
  # prelude, so it runs every fixture and reports plausible, wrong failures
  # instead of erroring. That cost a long debugging detour once: a valid 71/71
  # and an invalid 67/71 were compared as though they measured the same thing.
  # The runtime defines process, the engine does not.
  probe="$(printf 'console.log(typeof process)' | "$ENGINE_BIN" /dev/stdin 2>/dev/null)"
  if [ "$probe" = "object" ]; then
    echo "FAIL: MILOJS_ENGINE_BIN=$ENGINE_BIN looks like the runtime (milojs), not the engine."
    echo "      These fixtures expect a build of milojs-engine.milo."
    exit 1
  fi
else
  ENGINE_BIN="$(mktemp -t milojs-engine)"
  trap 'rm -f "$ENGINE_BIN"' EXIT
  if ! bun run src/main.ts build examples/apps/milojs/milojs-engine.milo -o "$ENGINE_BIN" >/dev/null; then
    echo "FAIL: engine did not build"
    exit 1
  fi
fi

# A hung fixture must not hang the suite. gtimeout is the GNU build on macOS;
# without either, run unguarded rather than refusing to test.
PER_TEST_TIMEOUT="${MILOJS_TEST_TIMEOUT:-120}"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT="timeout -s KILL $PER_TEST_TIMEOUT $ENGINE_BIN"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT="gtimeout -s KILL $PER_TEST_TIMEOUT $ENGINE_BIN"
else
  echo "warning: no timeout(1); a hung fixture will hang this suite"
  TIMEOUT="$ENGINE_BIN"
fi

fail=0
for js in "$DIR"/*.js; do
  name="$(basename "$js" .js)"
  exp="$DIR/$name.expected"
  [ -f "$exp" ] || { echo "SKIP $name (no .expected)"; continue; }
  # -s KILL, not the default TERM: a wedged green scheduler never reaches a
  # point where it handles a signal, so a hung fixture ignores TERM and survives
  # the timeout entirely. One such process ran for hours unnoticed, skewing every
  # timing-sensitive measurement taken after it. Without KILL a single bad build
  # hangs this loop forever, which in CI means a wedged job rather than a failure.
  got="$($TIMEOUT "$js" 2>&1)"
  status=$?
  if [ $status -eq 137 ] || [ $status -eq 124 ]; then
    echo "FAIL $name (hung, killed after ${PER_TEST_TIMEOUT}s)"
    fail=$((fail + 1))
    continue
  fi
  if [ "$got" = "$(cat "$exp")" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    diff <(printf '%s\n' "$got") "$exp" | head -20
    fail=1
  fi
done
exit $fail
