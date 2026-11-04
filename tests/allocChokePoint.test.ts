// Holds the allocation choke point: a heap size computed as `count * elemSize` must go
// through one of the counted allocators (std/rt.milo: rtBufAlloc, rtBufClone,
// rtMapAlloc, rtVecGrow*), which check the multiply for overflow and the result for
// null, and every MLIR call site of them reports a null result.
//
// This exists because the rule was previously restated at fifteen call sites and not one of
// them checked the product. `v.reserve(2305843009213693952)` wrapped the byte count, malloc
// returned a small buffer, the capacity field kept the huge value, and every later push wrote
// past the allocation, from safe code. A rule written out per site is a rule the next site
// forgets, so the gate is on the shape rather than on anyone remembering.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// The counted allocators are Milo code in std/rt.milo; each fn's source text, by name.
const rtSrc = readFileSync(join(ROOT, "std", "rt.milo"), "utf8");
function rtFn(name: string): string {
  const m = new RegExp(`^(?:pub )?fn ${name}\\([^]*?^\\}`, "m").exec(rtSrc);
  if (!m) throw new Error(`std/rt.milo: no fn ${name}`);
  return m[0];
}

// Every generator that can put a malloc into a program: the process scaffold, the MLIR
// emitter and drop/clone glue, and the milo-opt lowerings.
const GENERATORS = [
  ...readdirSync(join(ROOT, "src")).filter(f => /^(scaffold|emit-mlir|mlir-[\w-]+)\.ts$/.test(f)).map(f => join(ROOT, "src", f)),
  ...readdirSync(join(ROOT, "mlir")).filter(f => f.endsWith(".cpp")).map(f => join(ROOT, "mlir", f)),
];

// The allocators that take a count and an element size. Each multiplies them itself.
const COUNTED = ["rtBufAlloc", "rtBufClone", "rtMapAlloc", "rtVecGrowRealloc", "rtVecGrowCopy"];

const MALLOC_LL = /call ptr @(malloc|realloc)\(/;
// A plain multiply; `@llvm.umul.with.overflow` does not match.
const MUL_LL = /= mul (nuw |nsw )*i64/;
// Every spelling of a multiply in the generators: IR text, the typed builder, the milo
// dialect, and an MLIR builder op.
const MALLOC_GEN = /call ptr @malloc|"@malloc"|"malloc"/;
const MUL_GEN = /= mul i64|binop\("mul"|milo\.mul |LLVM::MulOp|arith::MulIOp/;

describe("allocation choke point", () => {
  test("no multiply feeds a malloc outside the counted allocators", () => {
    expect(GENERATORS.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    // std/rt.milo's own mallocs sit behind rtMulOverflows (checked next).
    for (const file of GENERATORS) {
      const fl = readFileSync(file, "utf8").split("\n");
      fl.forEach((line, i) => {
        if (!MALLOC_GEN.test(line)) return;
        // A multiply within the preceding window is what produced a byte count.
        if (MUL_GEN.test(fl.slice(Math.max(0, i - 10), i).join("\n"))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the counted allocators check the multiply and the allocation", () => {
    for (const key of COUNTED) {
      const text = rtFn(key);
      // Both halves must survive; a refactor that drops either one re-opens the hole this
      // file exists to keep closed. The overflow test must come before the allocation.
      expect(text, key).toContain("rtMulOverflows(");
      expect(text.indexOf("rtMulOverflows("), key).toBeLessThan(text.search(/malloc\(|realloc\(|rtVecGrowCopy\(/));
      expect(text, key).toMatch(/rtMulOverflows\([^)]*\) \{\n\s+(return 0 as \*u8|rtOom\(\))/);
      // rtBufAlloc hands malloc's result straight back; its callers' null check covers it.
      if (key !== "rtBufAlloc" && key !== "rtVecGrowRealloc") expect(text, key).toMatch(/\(\w+ as i64\) (==|!=) 0/);
    }
    expect(rtFn("rtMulOverflows")).toContain("18446744073709551615 / (size as u64)");
  });

  test("every MLIR call of a null-returning allocator reports the null", () => {
    const src = readFileSync(join(ROOT, "src", "emit-mlir.ts"), "utf8");
    const helper = /private allocCheck\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(src);
    expect(helper).not.toBeNull();
    expect(helper![1]).toMatch(/milo\.cmp eq, \$\{p\.ref\}, \$\{this\.def\(`milo\.zero/);
    expect(helper![1]).toContain("this.panicIf(isNull.ref");
    const calls = src.split("\n").filter(l => /rtCall\((this\.cx\.mlirVecGrow\(|"rt(BufAlloc|MapAlloc)")/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l).toMatch(/this\.allocCheck\(this\.rtCall\(/);
    // rtBufClone does not return null: its failure path ends the program itself.
    expect(rtFn("rtBufClone")).toMatch(/rtOom\(\)/);
  });
});
