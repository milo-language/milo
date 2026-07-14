// Tests for the Cortex-M3 cycle estimator (real WCET from the linked ELF).
// These depend on llvm-objdump + clang cross-compile; skipped if unavailable so
// the suite stays green on machines without the toolchain.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { estimateLoopCycles } from "../src/wcet-cycles";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const OBJDUMP = "/opt/homebrew/opt/llvm/bin/llvm-objdump";

const hasTools = (() => {
  try {
    execSync("/usr/bin/clang --version", { stdio: ["pipe", "pipe", "pipe"] });
    return existsSync(OBJDUMP);
  } catch { return false; }
})();

function buildElf(src: string): string {
  const f = join(tmpdir(), "milo_cyc.milo");
  writeFileSync(f, src);
  const elf = join(tmpdir(), "milo_cyc.elf");
  // --debug (-O0) so small functions aren't inlined away — the test asserts on a
  // named function's loop, which must survive as its own symbol.
  execSync(`bun run ${COMPILER} build ${f} --target=cortex-m3 --debug -o ${elf}`, { stdio: ["pipe", "pipe", "pipe"] });
  unlinkSync(f);
  return elf;
}

test.if(hasTools)("estimates positive cycles for a bounded loop", () => {
  const elf = buildElf(`fn loopSum(): i32 { var t: i32 = 0 for i in 0..10 { t = t + (i as i32) } return t }
fn main(): i32 { return loopSum() }`);
  const est = estimateLoopCycles(elf, "loopSum", 10);
  expect(est).not.toBeNull();
  expect(est!.bodyCycles).toBeGreaterThan(0);
  expect(est!.loopCycles).toBeGreaterThan(0);
  expect(est!.iterations).toBe(10);
  unlinkSync(elf);
});

test.if(hasTools)("cycle bound scales with iteration count", () => {
  const elf = buildElf(`fn loopSum(): i32 { var t: i32 = 0 for i in 0..100 { t = t + (i as i32) } return t }
fn main(): i32 { return loopSum() }`);
  const e10 = estimateLoopCycles(elf, "loopSum", 10);
  const e100 = estimateLoopCycles(elf, "loopSum", 100);
  expect(e10).not.toBeNull();
  expect(e100).not.toBeNull();
  // same loop body, 10x the trip count → ~10x the cycles
  expect(e100!.loopCycles).toBeGreaterThan(e10!.loopCycles * 5);
  unlinkSync(elf);
});

test.if(hasTools)("returns null for a function with no loop", () => {
  const elf = buildElf(`fn noLoop(): i32 { return 7 }
fn main(): i32 { return noLoop() }`);
  const est = estimateLoopCycles(elf, "noLoop", 1);
  expect(est).toBeNull();
  unlinkSync(elf);
});
