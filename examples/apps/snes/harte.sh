#!/usr/bin/env bash
# Convert + run one or more Harte 65816 opcode tests through the Milo core.
# One process per opcode keeps memory bounded. Runs both emulation (.e) and
# native (.n) mode files for each opcode.
# Usage: examples/apps/snes/harte.sh ea a9 aa ...
#        examples/apps/snes/harte.sh            (runs the implemented set)
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=roms/harte-65816/v1
# No-arg run tests EVERY opcode that has reference data (glob the test files), not a
# hand-kept list — a curated subset is exactly how $FC stayed unimplemented+untested.
# MVN (54) / MVP (44) are excluded below: Harte captures cycle-bounded partial
# block-move state an instruction-stepped core can't reproduce (they're implemented
# atomically and correct for games).
if [ $# -gt 0 ]; then
    OPS=("$@")
else
    OPS=($(ls "$D"/*.e.json | sed -E 's#.*/([0-9a-f]{2})\.e\.json#\1#' | grep -vE '^(44|54)$'))
fi
pass=0; fail=0
for op in "${OPS[@]}"; do
  for mode in e n; do
    js="$D/$op.$mode.json"
    if [ ! -f "$js" ]; then printf '%-8s MISSING\n' "$op.$mode"; continue; fi
    bun run examples/apps/snes/harteConv.ts "$js" /tmp/h.flat 2>/dev/null || true
    out=$(MILO_RUN_MEM_MB=3000 bun run src/main.ts run examples/apps/snes/runHarte.milo /tmp/h.flat 2>/dev/null | grep -E 'passed|first fail' || true)
    line=$(echo "$out" | grep passed || true)
    ff=$(echo "$out" | grep 'first fail' || true)
    if echo "$line" | grep -qE 'passed ([0-9]+) / \1 '; then
      printf '%-8s OK   %s\n' "$op.$mode" "$line"; pass=$((pass+1))
    else
      printf '%-8s FAIL %s | %s\n' "$op.$mode" "$line" "$ff"; fail=$((fail+1))
    fi
  done
done
echo "=== files fully green: $pass, with failures: $fail ==="
