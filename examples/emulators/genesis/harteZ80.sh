#!/usr/bin/env bash
# Convert + run z80 SingleStepTests opcodes through the Milo Z80 core.
# Usage: harteZ80.sh 00 78 80 ...   (hex opcode file names; no args = 0x00-0xFF main page)
set -uo pipefail
cd "$(dirname "$0")/../../.."
D=roms/z80tests/v1
if [ $# -gt 0 ]; then OPS=("$@"); else OPS=($(printf '%02x\n' $(seq 0 255))); fi
green=0; red=0
for op in "${OPS[@]}"; do
  [ -f "$D/$op.json" ] || { printf '%-4s MISSING\n' "$op"; continue; }
  bun run examples/emulators/genesis/harteConvZ80.ts "$D/$op.json" /tmp/z.flat 2>/dev/null
  out=$(MILO_RUN_MEM_MB=2000 bun run src/main.ts run examples/emulators/genesis/runHarteZ80.milo /tmp/z.flat 2>/dev/null | grep -E 'passed|fail' || true)
  line=$(echo "$out" | grep passed || true)
  if echo "$line" | grep -qE 'passed ([0-9]+) / \1$'; then
    green=$((green+1))
  else
    ff=$(echo "$out" | grep 'first fail' || true)
    printf '%-4s %s | %s\n' "$op" "$line" "$ff"; red=$((red+1))
  fi
done
echo "=== z80 green: $green, with failures: $red ==="
