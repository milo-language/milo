#!/usr/bin/env bash
# Convert + run one or more Harte 65816 opcode tests through the Milo core.
# One process per opcode keeps memory bounded. Runs both emulation (.e) and
# native (.n) mode files for each opcode.
# Usage: examples/apps/snes/harte.sh ea a9 aa ...
#        examples/apps/snes/harte.sh            (runs the implemented set)
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=roms/harte-65816/v1
[ $# -gt 0 ] && OPS=("$@") || OPS=(ea 18 38 58 78 b8 d8 f8 fb c2 e2 \
  aa a8 8a 98 ba 9a 9b bb 1b 3b 5b 7b eb e8 c8 ca 88 1a 3a a9 a2 a0)
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
