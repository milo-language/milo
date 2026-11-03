// Aggregate swap where both operands may be the same element at run time.
//
// The legacy codegen guarded the copies with a runtime `icmp eq ptr` branch. The MLIR
// lowering (emit-mlir MemSwap) drops the guard on purpose: its copies are the
// llvm.memcpy intrinsic, whose contract allows a source exactly equal to its
// destination, so a self-swap is defined without it. What this pins: the copies stay the
// intrinsic (a libc `@memcpy` call would not carry that guarantee), and the swap is
// right at run time both for the same element and for two different ones.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

const SRC = `struct Big { data: [u8; 256] }
fn sum(b: Big): i64 {
    var s: i64 = 0
    for x in b.data { s = s + x as i64 }
    return s
}
fn main() {
    var values = [Big { data: [1; 256] }, Big { data: [2; 256] }]
    var i: i64 = 0
    var j: i64 = 0
    swap(values[i], values[j])
    print(sum(values[0]))
    j = 1
    swap(values[i], values[j])
    print(sum(values[0]))
    print(sum(values[1]))
}`;

test("large aggregate self-swap skips overlapping memcpy", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-swap-"));
  try {
    const source = join(dir, "swap.milo");
    writeFileSync(source, SRC);
    const ir = execFileSync("bun", ["run", MAIN, "emit-ir", source], { cwd: ROOT, encoding: "utf-8" });
    const start = ir.indexOf("define i32 @main(");
    const main = ir.slice(start, ir.indexOf("\n}\n", start));
    expect((main.match(/call void @llvm\.memcpy\.p0\.p0\.i64\([^)]*i64 256,/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(main).not.toMatch(/call ptr @memcpy\(/);

    const out = execFileSync("bun", ["run", MAIN, "run", source], { cwd: ROOT, encoding: "utf-8" });
    expect(out).toBe("256\n512\n256\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
