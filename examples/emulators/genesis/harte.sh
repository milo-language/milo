#!/usr/bin/env bash
# Convert + run one or more Harte 68000 opcode tests through the Milo core.
# Usage: examples/emulators/genesis/harte.sh NOP MOVE.w ADD.l ...
#        examples/emulators/genesis/harte.sh            (runs a default supported set)
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=roms/ProcessorTests/680x0/68000/v1
[ $# -gt 0 ] && OPS=("$@") || OPS=(NOP MOVE.b MOVE.w MOVE.l MOVEA.w MOVEA.l MOVEQ \
  ADD.b ADD.w ADD.l ADDA.w ADDA.l ADDQ.b ADDQ.w ADDQ.l \
  SUB.b SUB.w SUB.l SUBA.w SUBA.l SUBQ.b SUBQ.w SUBQ.l \
  CMP.b CMP.w CMP.l CMPA.w CMPA.l CMPM.b CMPM.w CMPM.l \
  AND.b AND.w AND.l OR.b OR.w OR.l EOR.b EOR.w EOR.l \
  CLR.b CLR.w CLR.l NOT.b NOT.w NOT.l NEG.b NEG.w NEG.l TST.b TST.w TST.l \
  LEA PEA SWAP EXT.w EXT.l BRA BSR Bcc DBcc Scc JMP JSR RTS)
pass=0; fail=0
for op in "${OPS[@]}"; do
  gz="$D/$op.json.gz"
  if [ ! -f "$gz" ]; then printf '%-10s MISSING\n' "$op"; continue; fi
  bun run examples/emulators/genesis/harteConv.ts "$gz" /tmp/h.flat 2>/dev/null || true
  out=$(MILO_RUN_MEM_MB=3000 bun run src/main.ts run examples/emulators/genesis/runHarte.milo /tmp/h.flat 2>/dev/null | grep -E 'passed|fail' || true)
  line=$(echo "$out" | grep passed || true)
  ff=$(echo "$out" | grep 'first fail' || true)
  if echo "$line" | grep -qE 'passed ([0-9]+) / \1 '; then
    printf '%-10s OK   %s\n' "$op" "$line"; pass=$((pass+1))
  else
    printf '%-10s FAIL %s | %s\n' "$op" "$line" "$ff"; fail=$((fail+1))
  fi
done
echo "=== opcodes fully green: $pass, with failures: $fail ==="
