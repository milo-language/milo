// Formatter regression tests. fmt.milo had no coverage at all, which is how it shipped
// splitting `extern struct Foo` across three lines — and then baked that into 16
// committed fixtures, since formatting is applied on the way in.
//
// Each case asserts two properties: the formatter's output for an already-canonical
// input is unchanged (round-trip), and formatting twice equals formatting once
// (idempotence — the property that catches "fix moves the mangling around").
import { test, expect, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const FMT = join(ROOT, "examples", "cli-tools", "fmt.milo");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-fmt-")); });

function format(src: string, name: string): string {
  const f = join(dir, `${name}.milo`);
  writeFileSync(f, src);
  return execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "run", FMT, "--", f], {
    cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  });
}

// `extern fn` already round-tripped; `extern struct` and `extern type` did not.
const cases: Record<string, string> = {
  externStruct: `extern struct Timespec {\n    tv_sec: i64,\n    tv_nsec: i64,\n}\n`,
  externFn: `extern fn clock_gettime(clockId: i32, tp: *Timespec): i32\n`,
  externType: `extern type Opaque\n`,
  attributed: `@cLayout("struct timespec", "time.h")\nextern struct Timespec {\n    tv_sec: i64,\n    tv_nsec: i64,\n}\n`,
};

for (const [name, src] of Object.entries(cases)) {
  test(`${name}: canonical source is unchanged`, () => {
    expect(format(src, name)).toBe(src);
  }, 60000);

  test(`${name}: formatting is idempotent`, () => {
    const once = format(src, `${name}1`);
    expect(format(once, `${name}2`)).toBe(once);
  }, 60000);
}

test("extern keyword is never split from its declaration", () => {
  // The original bug: `struct` reads as a top-level item, so a blank line was pushed
  // between it and `extern`. Feed the mangled form and require it to be healed.
  const mangled = `extern\n\nstruct Foo {\n    a: i32,\n}\n`;
  expect(format(mangled, "healed")).toContain("extern struct Foo");
}, 60000);
