// Holds the allocation choke point: a heap size computed as `count * elemSize` must go
// through `emitAllocBytes`, which checks the multiply for overflow and the result for null.
//
// This exists because the rule was previously restated at fifteen call sites and not one of
// them checked the product. `v.reserve(2305843009213693952)` wrapped the byte count, malloc
// returned a small buffer, the capacity field kept the huge value, and every later push wrote
// past the allocation — from safe code. A rule written out per site is a rule the next site
// forgets, so the gate is on the shape rather than on anyone remembering.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const SRC = join(SRC_DIR, "codegen.ts");
// codegen.ts is split into codegen-*.ts siblings (codegen-vec, codegen-map); a malloc moved
// into one of them must not escape the scan just by changing files.
const CODEGEN_FILES = readdirSync(SRC_DIR).filter(f => /^codegen(-[\w-]+)?\.ts$/.test(f)).map(f => join(SRC_DIR, f));
// Matched without a visibility modifier: emitAllocBytes is public so the codegen-*.ts ctx
// interfaces can reach it, and a test keyed on `private` went red on that alone.
const isHelperDecl = (l: string) => /^\s+(?:private |public )?emitAllocBytes\(/.test(l);

// The one hand-written IR template that allocates without the helper. It lives inside a
// `define` emitted as a string array, so there is no `lines` array to hand the helper.
// `len * 6 + 1` for a JSON-escaped string can only overflow past 2^60 bytes of input, which
// is not reachable — but it is an exception, so it is named here rather than tolerated by a
// loose pattern.
const ALLOWED_RAW_IR = ["%buf = call ptr @malloc(i64 %cap)"];
// Both spellings of each half: IR still emitted as text, and the same instruction through the
// typed builder (src/ir.ts). Matching only the text form let every migrated site drop out of
// the scan while the test stayed green.
const MALLOC = /call ptr @malloc|"@malloc"/;
const MUL = /= mul i64|binop\("mul"/;

describe("allocation choke point", () => {
  const src = readFileSync(SRC, "utf8");
  const lines = src.split("\n");

  test("no multiply feeds a malloc outside emitAllocBytes", () => {
    expect(lines.findIndex(isHelperDecl)).toBeGreaterThan(-1);
    expect(CODEGEN_FILES.length).toBeGreaterThan(2);

    const offenders: string[] = [];
    for (const file of CODEGEN_FILES) {
      const fl = readFileSync(file, "utf8").split("\n");
      const helperStart = fl.findIndex(isHelperDecl);
      const helperEnd = helperStart < 0 ? -1 : helperStart + 60;
      fl.forEach((line, i) => {
        if (!MALLOC.test(line)) return;
        if (i >= helperStart && i <= helperEnd) return;
        if (ALLOWED_RAW_IR.some(a => line.includes(a))) return;
        // A multiply within the preceding window is what produced a byte count.
        const window = fl.slice(Math.max(0, i - 10), i).join("\n");
        if (MUL.test(window)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("emitAllocBytes checks the multiply and the allocation", () => {
    const helperStart = lines.findIndex(isHelperDecl);
    expect(helperStart).toBeGreaterThan(-1);
    const body = lines.slice(helperStart, helperStart + 60).join("\n");
    // Both halves must survive; a refactor that drops either one re-opens the hole this
    // file exists to keep closed.
    expect(body).toContain("umul.with.overflow.i64");
    expect(body).toContain("icmp ne ptr");
    expect(body).toContain("__milo_overflow_fail");
  });
});
