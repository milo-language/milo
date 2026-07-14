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
  aa a8 8a 98 ba 9a 9b bb 1b 3b 5b 7b eb e8 c8 ca 88 1a 3a a9 a2 a0 \
  48 68 da fa 5a 7a 08 28 8b ab 4b 0b 2b f4 \
  a5 b5 ad bd b9 af bf a1 b1 a7 b7 a3 b3 \
  85 95 8d 9d 99 8f 9f 81 91 87 97 83 93 \
  09 05 15 0d 1d 19 0f 1f 01 11 07 17 03 13 \
  29 25 35 2d 3d 39 2f 3f 21 31 27 37 23 33 \
  49 45 55 4d 5d 59 4f 5f 41 51 47 57 43 53 \
  c9 c5 d5 cd dd d9 cf df c1 d1 c7 d7 c3 d3 \
  e0 e4 ec c0 c4 cc a6 b6 ae be a4 b4 ac bc \
  86 96 8e 84 94 8c 64 74 9c 9e \
  69 65 75 6d 7d 79 6f 7f 61 71 67 77 63 73 \
  e9 e5 f5 ed fd f9 ef ff e1 f1 e7 f7 e3 f3 \
  0a 06 16 0e 1e 4a 46 56 4e 5e 2a 26 36 2e 3e 6a 66 76 6e 7e \
  e6 f6 ee fe c6 d6 ce de 04 0c 14 1c 89 24 34 2c 3c \
  10 30 50 70 90 b0 d0 f0 80 82 4c 5c 6c 7c dc fc 20 60 22 6b d4 62 \
  00 02 40 42 cb db)
# NOTE: MVN (54) / MVP (44) are omitted — Harte captures cycle-bounded *partial*
# block-move state, which an instruction-stepped core can't reproduce. They are
# implemented (atomic full-block move) and correct for running games.
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
