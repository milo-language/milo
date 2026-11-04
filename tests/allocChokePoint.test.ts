// Holds the allocation choke point: a heap size computed as `count * elemSize` must go
// through one of the counted allocators (src/runtime/map.ll: milo.buf.alloc, milo.buf.clone,
// milo.map.alloc, milo.vec.grow.*), which check the multiply for overflow and the result for
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
import { parseSections } from "../src/runtime-ir";

const ROOT = join(import.meta.dir, "..");
const RUNTIME_DIR = join(ROOT, "src", "runtime");
const runtime = new Map<string, string[]>();
for (const f of readdirSync(RUNTIME_DIR).filter(f => f.endsWith(".ll")))
  for (const [k, body] of parseSections(readFileSync(join(RUNTIME_DIR, f), "utf8"))) runtime.set(k, [...body]);

// Every generator that can put a malloc into a program: the process scaffold, the MLIR
// emitter and drop/clone glue, and the milo-opt lowerings.
const GENERATORS = [
  ...readdirSync(join(ROOT, "src")).filter(f => /^(scaffold|emit-mlir|mlir-[\w-]+)\.ts$/.test(f)).map(f => join(ROOT, "src", f)),
  ...readdirSync(join(ROOT, "mlir")).filter(f => f.endsWith(".cpp")).map(f => join(ROOT, "mlir", f)),
];

// The allocators that take a count and an element size. Each multiplies them itself.
const COUNTED = ["milo.buf.alloc", "milo.buf.clone", "milo.map.alloc", "milo.vec.grow.realloc", "milo.vec.grow.copy"];

const MALLOC_LL = /call ptr @(malloc|realloc)\(/;
// A plain multiply; `@llvm.umul.with.overflow` does not match.
const MUL_LL = /= mul (nuw |nsw )*i64/;
// Every spelling of a multiply in the generators: IR text, the typed builder, the milo
// dialect, and an MLIR builder op.
const MALLOC_GEN = /call ptr @malloc|"@malloc"|"malloc"/;
const MUL_GEN = /= mul i64|binop\("mul"|milo\.mul |LLVM::MulOp|arith::MulIOp/;

describe("allocation choke point", () => {
  test("no multiply feeds a malloc outside the counted allocators", () => {
    expect(runtime.size).toBeGreaterThan(10);
    expect(GENERATORS.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const [key, body] of runtime) {
      body.forEach((line, i) => {
        if (MALLOC_LL.test(line) && body.slice(0, i).some(l => MUL_LL.test(l))) offenders.push(`runtime ${key}: ${line.trim()}`);
      });
    }
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
      const body = runtime.get(key);
      expect(body, key).toBeDefined();
      const text = body!.join("\n");
      // Both halves must survive; a refactor that drops either one re-opens the hole this
      // file exists to keep closed. The overflow bit must branch to the failure path.
      expect(text, key).toContain("@llvm.umul.with.overflow.i64");
      expect(text, key).toMatch(/br i1 %ovf, label %fail,/);
      expect(text, key).toMatch(/fail:\n\s+(ret ptr null|call void @milo\.str\.oom\(\))/);
      // milo.buf.alloc hands malloc's result straight back; its callers' null check covers it.
      if (key !== "milo.buf.alloc") expect(text, key).toMatch(/icmp ne ptr %\w+, null/);
    }
  });

  test("every MLIR call of a null-returning allocator reports the null", () => {
    const src = readFileSync(join(ROOT, "src", "emit-mlir.ts"), "utf8");
    const helper = /private allocCheck\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(src);
    expect(helper).not.toBeNull();
    expect(helper![1]).toMatch(/milo\.cmp eq, \$\{p\.ref\}, \$\{this\.def\(`milo\.zero/);
    expect(helper![1]).toContain("this.panicIf(isNull.ref");
    const calls = src.split("\n").filter(l => /rtCall\((this\.cx\.mlirVecGrow\(|"milo\.(buf\.alloc|map\.alloc)")/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l).toMatch(/this\.allocCheck\(this\.rtCall\(/);
    // milo.buf.clone does not return null: its failure path ends the program itself.
    expect(runtime.get("milo.buf.clone")!.join("\n")).toMatch(/fail:\n\s+call void @milo\.str\.oom\(\)\n\s+unreachable/);
  });
});
