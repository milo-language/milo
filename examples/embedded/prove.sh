#!/usr/bin/env bash
# Reproducible proof of Milo's safety-critical / WCET chain, end to end.
#
# One command walks the whole pipeline on a real control kernel and shows,
# at each stage, that the claim holds — culminating in an INDEPENDENT check
# of the WCET model's instruction count against the real compiled machine code.
#
#   examples/embedded/prove.sh
#
# Needs: bun, clang+lld (Milo toolchain), qemu-system-arm (brew install qemu),
#        llvm-objdump (ships with llvm). No OTAWA, no Docker.

set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

MILO="bun run src/main.ts"
SRC="examples/embedded/pidStep.milo"
TARGET="cortex-m3"            # thumbv7m-none-eabi, QEMU mps2-an385, integer-only
ELF="$(mktemp -t pid.XXXX).elf"

# ── pretty helpers ───────────────────────────────────────────────────────────
b()   { printf '\033[1m%s\033[0m\n' "$*"; }
pass(){ printf '  \033[32m✓ PASS\033[0m  %s\n' "$*"; }
fail(){ printf '  \033[31m✗ FAIL\033[0m  %s\n' "$*"; exit 1; }
rule(){ printf '\033[2m%s\033[0m\n' "────────────────────────────────────────────────────────────"; }

b ""
b "  Milo → safety-critical embedded → WCET, proven end to end"
b "  kernel: integer Q16.16 PID controller (brake/ESC/flight tick)"
b "  target: $TARGET  (Cortex-M3, thumbv7m-none-eabi, no OS, no libc)"
rule

# ── 1. SAFETY PROFILE: automotive top level ─────────────────────────────────
b "1. ISO 26262 ASIL-D  (braking / steering / autonomy — highest automotive)"
if $MILO safety "$SRC" --safety=iso26262-d 2>&1 | tee /tmp/prove.safety | grep -q "check passed"; then
  pass "no recursion · bounded loops · no dynamic alloc · contracts · full match · no FFI"
else
  cat /tmp/prove.safety; fail "ASIL-D constraints not satisfied"
fi
rule

# ── 2. WCET FLOW FACTS ──────────────────────────────────────────────────────
b "2. WCET flow facts  (loop iteration bounds — the input a WCET analyzer reads)"
$MILO wcet "$SRC" 2>&1 | grep -E "^loop " | sed 's/^/  /' || true
$MILO wcet "$SRC" 2>&1 | grep -q "COUNT 200" && pass "settle loop bounded: exactly 200 iterations (COUNT)" \
  || fail "expected exact loop bound COUNT 200"
rule

# ── 3. STATIC CYCLE BOUND ───────────────────────────────────────────────────
b "3. WCET cycle bound  (conservative Cortex-M3 timing model)"
$MILO wcet "$SRC" --cycles --target=$TARGET 2>&1 | tee /tmp/prove.cyc | grep -E "instructions|cycles|WCET|MHz|ms" | sed 's/^/  /'
grep -q "10000 cycles" /tmp/prove.cyc && pass "loop WCET = 10000 cycles = 0.417 ms @ 24 MHz" \
  || fail "expected 10000-cycle bound"
rule

# ── 4. FREESTANDING BUILD ───────────────────────────────────────────────────
b "4. Bare-metal build  (thumb codegen · vector table · linker script · -nostdlib · lld)"
$MILO build "$SRC" --target=$TARGET -o "$ELF" >/dev/null 2>&1
FILEOUT="$(file "$ELF")"
echo "  $FILEOUT"
echo "$FILEOUT" | grep -q "ARM" && echo "$FILEOUT" | grep -q "statically linked" \
  && pass "statically-linked ARM ELF, no OS dependencies" || fail "not a static ARM ELF"
rule

# ── 5. RUN ON THE EMULATOR ──────────────────────────────────────────────────
b "5. Execute on QEMU  (mps2-an385, semihosting — real bare-metal run, no host)"
RUNOUT="$($MILO run "$SRC" --target=$TARGET 2>&1 | tr -d '\r')"
echo "  program output: $RUNOUT"
echo "$RUNOUT" | grep -q "exit=34" && pass "kernel ran on Cortex-M3 and returned the correct actuator command (34)" \
  || fail "expected exit=34 from QEMU run"
rule

# ── 6. INDEPENDENT WCET CROSS-CHECK ─────────────────────────────────────────
# The cycle bound is only as trustworthy as its instruction count. Verify that
# count against the REAL compiled machine code — not the model's own claim.
b "6. Independent check  (does the WCET model's instruction count match real machine code?)"
OBJDUMP="$(command -v llvm-objdump || echo /opt/homebrew/opt/llvm/bin/llvm-objdump)"
"$OBJDUMP" -d "$ELF" > /tmp/prove.asm 2>/dev/null

# loop body = from the loop top to its backward branch, read straight from the disasm
TOP=$(grep -oE 'bne\.w\s+0x[0-9a-f]+' /tmp/prove.asm | head -1 | grep -oE '0x[0-9a-f]+')
BE=$(grep -nE "bne\.w\s+$TOP\b" /tmp/prove.asm | head -1)
BEADDR=$(printf '%s\n' "$BE" | grep -oE '^[0-9]+:\s+[0-9a-f]+:' | grep -oE '[0-9a-f]+:' | tail -1 | tr -d ':')
# count real thumb instructions with address in [TOP, backedge]
REAL=$(grep -oE '^\s+[0-9a-f]+:' /tmp/prove.asm | tr -d ' :' | \
  while read h; do echo $((16#$h)); done | \
  awk -v lo=$((TOP)) -v hi=$((16#$BEADDR)) '$1>=lo && $1<=hi{n++} END{print n}')
MODEL=$(grep -oE '[0-9]+ instructions' /tmp/prove.cyc | grep -oE '[0-9]+' | head -1)

echo "  loop top (from ELF):        $TOP"
echo "  model claims / pass:        $MODEL instructions"
echo "  real thumb instrs in body:  $REAL instructions"
UNROLL=$(grep -oE 'subs\s+r[0-9]+, #0x[0-9]+' /tmp/prove.asm | grep -oE '0x[0-9]+$' | head -1)
[ -n "$UNROLL" ] && echo "  backedge decrement:         $UNROLL  (confirms unroll factor)"
if [ "$REAL" = "$MODEL" ]; then
  pass "WCET instruction count VERIFIED against real compiled machine code (exact)"
else
  fail "model says $MODEL, machine code has $REAL — WCET model is wrong"
fi
rule

b ""
b "  ALL STAGES PASS — memory-safe source → ASIL-D checked → contract checked"
b "  → bounded → thumb ELF → runs on emulator → WCET count verified vs real code."
b ""
rm -f "$ELF"
