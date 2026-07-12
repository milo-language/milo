#!/usr/bin/env bash
# Convert + run Harte SPC700 opcode tests through the Milo core (one process per
# opcode). Usage: examples/apps/snes/harteSpc.sh 00 e8 cd ...
#        examples/apps/snes/harteSpc.sh            (runs the implemented set)
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=roms/harte-spc700/v1
[ $# -gt 0 ] && OPS=("$@") || OPS=(00 20 40 60 80 e0 ed a0 c0 e8 cd 8d \
  7d dd 5d fd 9d bd bc 3d fc 9c 1d dc \
  08 04 05 28 24 25 48 44 45 68 64 65 88 84 85 a8 a4 a5 c8 ad e4 e5 c4 c5 \
  f8 e9 d8 c9 eb ec cb cc e6 c6 8f 2d 4d 6d 0d ae ce ee 8e ab ac 8b 8c \
  2f f0 d0 b0 90 30 10 70 50 5f 3f 6f)
pass=0; fail=0
for op in "${OPS[@]}"; do
  js="$D/$op.json"
  if [ ! -f "$js" ]; then printf '%-6s MISSING\n' "$op"; continue; fi
  bun run examples/apps/snes/harteConvSpc.ts "$js" /tmp/hs.flat 2>/dev/null || true
  out=$(MILO_RUN_MEM_MB=3000 bun run src/main.ts run examples/apps/snes/runHarteSpc.milo /tmp/hs.flat 2>/dev/null | grep -E 'passed|first fail' || true)
  line=$(echo "$out" | grep passed || true)
  ff=$(echo "$out" | grep 'first fail' || true)
  if echo "$line" | grep -qE 'passed ([0-9]+) / \1 '; then
    printf '%-6s OK   %s\n' "$op" "$line"; pass=$((pass+1))
  else
    printf '%-6s FAIL %s | %s\n' "$op" "$line" "$ff"; fail=$((fail+1))
  fi
done
echo "=== spc700 files fully green: $pass, with failures: $fail ==="
