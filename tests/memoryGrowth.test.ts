import { test, expect, describe } from "bun:test";
import { execSync, execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Peak-RSS gates on allocation patterns that must run in constant memory.
//
// These catch missing drop glue, which no other test can see: a leaking program
// still prints the right answer, so fixtures pass while RSS climbs. The bug that
// motivated this (owned temporaries never freed — a discarded call result, or one
// consumed by an operator) leaked quadratically. `s = mk(a) + mk(b)` in a loop
// peaked at 6.4GB building a 720KB string, and every fixture stayed green.
//
// Each program allocates ~100MB cumulatively but holds almost nothing live, so a
// correct compiler stays near the floor and a leaking one lands 100x above the cap.
// The caps are deliberately loose — this asserts "not scaling with iteration
// count", not a specific number, so allocator noise can't make it flaky.

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

// Peak RSS in MB for a finished child. macOS ships BSD `time -l`; Linux needs GNU
// `time -v` (not the shell builtin), which minimal CI images often lack.
function peakRssMb(binary: string): number | null {
  if (process.platform === "darwin") {
    const out = execSync(`/usr/bin/time -l ${binary} 2>&1 >/dev/null`, { encoding: "utf-8" });
    const m = out.match(/(\d+)\s+maximum resident set size/);
    return m ? Number(m[1]) / (1024 * 1024) : null;
  }
  if (!existsSync("/usr/bin/time")) return null;
  try {
    const out = execSync(`/usr/bin/time -v ${binary} 2>&1 >/dev/null`, { encoding: "utf-8" });
    const m = out.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

const dir = mkdtempSync(join(tmpdir(), "milo-mem-"));

function buildAndMeasure(name: string, source: string): number | null {
  const src = join(dir, `${name}.milo`);
  const bin = join(dir, name);
  writeFileSync(src, source);
  execFileSync("bun", ["run", COMPILER, "build", src, "-o", bin], { stdio: "pipe" });
  return peakRssMb(bin);
}

// allocates a 1KB owned string; the caller decides whether to keep it
const MK = `
from "std/io" import { writeStdout }

fn mk(n: i64): string {
    var s = String.withCapacity(n)
    var k: i64 = 0
    while k < n { s.push('x') k = k + 1 }
    return s
}
`;

const CASES: Array<{ name: string; body: string; capMb: number }> = [
  {
    // 100k discarded call results — leaked ~200MB before the fix
    name: "discardedReturn",
    body: `
fn main() {
    var i: i64 = 0
    while i < 100000 {
        mk(1000)
        i = i + 1
    }
    writeStdout("done\\n")
}`,
    capMb: 60,
  },
  {
    // operands consumed by a string binop — leaked ~200MB before the fix
    name: "consumedOperands",
    body: `
fn main() {
    var i: i64 = 0
    var total: i64 = 0
    while i < 100000 {
        let joined = mk(500) + mk(500)
        total = total + joined.len()
        i = i + 1
    }
    writeStdout("done\\n")
}`,
    capMb: 60,
  },
  {
    // repeated overwrite of a slot: the old value must be dropped each time
    name: "reassignInLoop",
    body: `
fn main() {
    var v: Vec<string> = Vec.new()
    v.push("seed")
    var i: i64 = 0
    while i < 100000 {
        v[0] = mk(1000)
        i = i + 1
    }
    writeStdout("done\\n")
}`,
    capMb: 60,
  },
];

describe("peak RSS stays flat when allocations are not retained", () => {
  for (const c of CASES) {
    test(`${c.name} runs in constant memory`, () => {
      const rss = buildAndMeasure(c.name, MK + c.body);
      if (rss === null) {
        console.warn(`skipped ${c.name}: no usable /usr/bin/time on this platform`);
        return;
      }
      expect(rss).toBeLessThan(c.capMb);
    }, 120000);
  }
});
