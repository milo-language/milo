#!/usr/bin/env bash
# Run every tests/*.js through milojs and diff against its *.expected (captured
# from bun). Regenerate an expected file with:  bun tests/foo.js > tests/foo.expected
set -u
cd "$(dirname "$0")/../../../.." || exit 1
ENGINE="examples/apps/milojs/milojs-engine.milo"
DIR="examples/apps/milojs/tests"
fail=0
for js in "$DIR"/*.js; do
  name="$(basename "$js" .js)"
  exp="$DIR/$name.expected"
  [ -f "$exp" ] || { echo "SKIP $name (no .expected)"; continue; }
  got="$(bun run src/main.ts run "$ENGINE" -- "$js" 2>&1)"
  if [ "$got" = "$(cat "$exp")" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    diff <(printf '%s\n' "$got") "$exp" | head -20
    fail=1
  fi
done
exit $fail
