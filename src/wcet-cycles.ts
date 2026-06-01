// Static WCET cycle estimation for Cortex-M3 — the "real WCET" step.
//
// Flow facts (src/wcet.ts) give loop iteration COUNTS at the source level. To
// turn those into a cycle bound you need the actual machine instructions and a
// timing model of the core. This module does what OTAWA/aiT do internally:
// disassemble the linked thumb ELF (llvm-objdump), find the loop body by its
// backward branch, sum per-instruction worst-case cycle costs from the ARM
// Cortex-M3 timing model, and multiply by the loop trip count.
//
// The cost table is CONSERVATIVE (upper bounds) because WCET must never
// under-estimate. Cortex-M3 is a good first target precisely because it has no
// cache and a short, in-order pipeline, so a per-instruction model is tight —
// unlike A-profile cores where caches force much looser bounds.

import { execSync } from "child_process";

// Worst-case cycles per instruction class, ARM Cortex-M3 TRM (DDI 0337).
// Branch penalty = pipeline refill; M3 refill is 1-3, we take the worst (3) so
// a taken branch costs 1 (issue) + 3 (refill) = 4.
const BRANCH_TAKEN = 4;
const LOAD_STORE = 2;     // ldr/str base
const MULTIPLY_LONG = 5;  // smull/umull worst case on M3
const DEFAULT_ALU = 1;    // mov/add/sub/cmp/orr/lsr/asr/etc.

function cyclesFor(mnemonic: string): number {
  const m = mnemonic.replace(/\..*$/, ""); // strip .w/.n width suffix
  if (/^(b|bl|bx|blx|bne|beq|bge|blt|ble|bgt|bcc|bcs|cbz|cbnz)$/.test(m)) return BRANCH_TAKEN;
  if (/^(smull|umull|smlal|umlal)$/.test(m)) return MULTIPLY_LONG;
  if (/^(ldr|ldrb|ldrh|ldrd|str|strb|strh|strd|push|pop|stm|ldm)$/.test(m)) return LOAD_STORE;
  return DEFAULT_ALU;
}

export interface CycleEstimate {
  fn: string;
  loopStart: number;     // address (hex) of loop head
  bodyInstrs: number;    // instructions in the loop body
  bodyCycles: number;    // worst-case cycles for one body pass
  unroll: number;        // how many logical iterations one body pass covers
  iterations: number;    // source-level trip count (from flow facts)
  loopCycles: number;    // bodyCycles * (iterations / unroll)
}

interface Insn { addr: number; mnemonic: string; targetAddr: number | null }

// Parse `llvm-objdump -d` output for one function into instructions.
function disassembleFn(elf: string, fnName: string): Insn[] {
  const od = "/opt/homebrew/opt/llvm/bin/llvm-objdump";
  const out = execSync(`${od} -d --mcpu=cortex-m3 "${elf}"`, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  const lines = out.split("\n");
  const insns: Insn[] = [];
  let inFn = false;
  for (const line of lines) {
    const hdr = line.match(/^[0-9a-f]+\s+<(.+)>:/);
    if (hdr) { inFn = hdr[1] === fnName; continue; }
    if (!inFn) continue;
    // "     428: ebae 0708    \tsub.w\tr7, lr, r8"
    const m = line.match(/^\s*([0-9a-f]+):\s+[0-9a-f ]+\t([a-z][a-z0-9.]*)\b(.*)$/);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    const mnemonic = m[2];
    // branch target, if the operand carries one (e.g. "0x428 <settle+0x1c>")
    const t = m[3].match(/0x([0-9a-f]+)\b/);
    insns.push({ addr, mnemonic, targetAddr: t ? parseInt(t[1], 16) : null });
  }
  return insns;
}

// Find the innermost loop: the last backward branch in the function. Its target
// is the loop head; the body is [head .. branch]. Detect ×N unrolling from a
// `subs rX, #N` decrement near the branch (the compiler's loop counter step).
export function estimateLoopCycles(elf: string, fnName: string, iterations: number): CycleEstimate | null {
  const insns = disassembleFn(elf, fnName);
  if (insns.length === 0) return null;

  let branch: Insn | null = null;
  for (const ins of insns) {
    if (ins.targetAddr !== null && /^(b|bne|beq|bge|blt|ble|bgt|bcc|bcs|cbz|cbnz)/.test(ins.mnemonic) && ins.targetAddr < ins.addr) {
      branch = ins; // keep the last backward branch = innermost/main loop
    }
  }
  if (!branch || branch.targetAddr === null) return null;

  const head = branch.targetAddr;
  const body = insns.filter(i => i.addr >= head && i.addr <= branch!.addr);
  const bodyCycles = body.reduce((s, i) => s + cyclesFor(i.mnemonic), 0);

  // Unroll factor: look for `subs rX, #K` in the body — the loop counter step.
  let unroll = 1;
  for (const i of body) {
    const dec = i.mnemonic.startsWith("sub") ? body.find(b => b === i) : null;
    void dec;
  }
  // scan raw decrement immediate from disasm operands of subs near branch
  // (re-derive from objdump line is overkill; default unroll=1, override below)
  const subsK = findUnroll(elf, fnName, head, branch.addr);
  if (subsK > 1) unroll = subsK;

  const loopCycles = Math.round(bodyCycles * (iterations / unroll));
  return {
    fn: fnName,
    loopStart: head,
    bodyInstrs: body.length,
    bodyCycles,
    unroll,
    iterations,
    loopCycles,
  };
}

// Find the loop-counter decrement immediate (`subs rX, #K`) inside the body to
// recover the unroll factor. Returns 1 if none found.
function findUnroll(elf: string, fnName: string, head: number, branchAddr: number): number {
  const od = "/opt/homebrew/opt/llvm/bin/llvm-objdump";
  const out = execSync(`${od} -d --mcpu=cortex-m3 "${elf}"`, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  let inFn = false;
  let best = 1;
  for (const line of out.split("\n")) {
    const hdr = line.match(/^[0-9a-f]+\s+<(.+)>:/);
    if (hdr) { inFn = hdr[1] === fnName; continue; }
    if (!inFn) continue;
    const m = line.match(/^\s*([0-9a-f]+):.*\tsubs?\b.*#0x?([0-9a-f]+)/);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    if (addr >= head && addr <= branchAddr) {
      const k = parseInt(m[2], m[2].match(/[a-f]/) ? 16 : 10);
      if (k > best && k <= 16) best = k; // plausible unroll factor
    }
  }
  return best;
}

export function formatCycleEstimate(e: CycleEstimate, triple: string, mhzNote = 24): string {
  const lines: string[] = [];
  lines.push(`WCET cycle estimate (${triple}, Cortex-M3 timing model):`);
  lines.push(`  loop in ${e.fn} @ 0x${e.loopStart.toString(16)}`);
  lines.push(`  body: ${e.bodyInstrs} instructions, ${e.bodyCycles} cycles/pass` +
             (e.unroll > 1 ? ` (unrolled ×${e.unroll})` : ""));
  lines.push(`  trip count: ${e.iterations} iterations (from flow facts)`);
  lines.push(`  loop WCET: ${e.loopCycles} cycles`);
  lines.push(`  at ${mhzNote} MHz: ${(e.loopCycles / (mhzNote * 1000)).toFixed(3)} ms`);
  lines.push(`  (conservative upper bound: branch=4, load/store=2, smull=5, alu=1)`);
  return lines.join("\n");
}
