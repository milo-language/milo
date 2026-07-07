// Cross-module name-collision semantics (issue #5): same-named top-level fns in
// different modules must not silently merge into one body. Different bodies are a
// compile error; identical bodies still merge; prelude override keeps working; and
// separately-compiled objects keep their own copies at link time (internal linkage).
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const DIR = mkdtempSync(join(tmpdir(), "milo-modules-"));

function milo(args: string): { code: number; out: string; err: string } {
  try {
    const out = execSync(`bun run ${COMPILER} ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, out: e.stdout?.toString() ?? "", err: e.stderr?.toString() ?? "" };
  }
}

function write(name: string, content: string): string {
  const p = join(DIR, name);
  writeFileSync(p, content);
  return p;
}

test("same-named fns with different bodies in two modules is a compile error", () => {
  write("dup_a.milo", `fn foo(): string { return "AAA" }\nfn fromA(): string { return foo() }\n`);
  write("dup_b.milo", `fn foo(): string { return "BBB" }\nfn fromB(): string { return foo() }\n`);
  const main = write("dup_main.milo", `from "dup_a" import { fromA }
from "dup_b" import { fromB }
fn main(): void {
    print(fromA())
    print(fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  expect(msg).toContain("duplicate-fn");
  expect(msg).toContain("dup_a.milo");
  expect(msg).toContain("dup_b.milo");
});

test("same-named fns with identical bodies still merge", () => {
  write("same_a.milo", `fn helper(): i64 { return 7 }\nfn fromA(): i64 { return helper() }\n`);
  write("same_b.milo", `fn helper(): i64 { return 7 }\nfn fromB(): i64 { return helper() }\n`);
  const main = write("same_main.milo", `from "same_a" import { fromA }
from "same_b" import { fromB }
fn main(): void {
    print(fromA() + fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("14");
});

test("user redefinition of a prelude-provided fn still overrides silently", () => {
  const main = write("override_main.milo", `fn strTrim(s: string): string { return "overridden" }
fn main(): void {
    print(strTrim("  x  "))
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("overridden");
});

// The hades case: two separately-compiled objects whose imported helpers share a
// name but not a body. Each compilation is internally consistent, so no compile
// error is possible — internal linkage must keep each object's copy at link time
// (linkonce_odr let the linker discard one).
test("separately compiled objects keep their own same-named helper bodies", () => {
  write("obj_helper_a.milo", `fn tag(): i64 { return 111 }\n`);
  write("obj_helper_b.milo", `fn tag(): i64 { return 222 }\n`);
  const libA = write("obj_lib_a.milo", `from "obj_helper_a" import { tag }\nfn fromA(): i64 { return tag() }\nfn main(): void {}\n`);
  const libB = write("obj_lib_b.milo", `from "obj_helper_b" import { tag }\nfn fromB(): i64 { return tag() }\nfn main(): void {}\n`);
  const objA = join(DIR, "obj_a.o");
  const objB = join(DIR, "obj_b.o");
  let r = milo(`emit-obj ${libA} --no-entry -o ${objA}`);
  expect(r.code).toBe(0);
  r = milo(`emit-obj ${libB} --no-entry -o ${objB}`);
  expect(r.code).toBe(0);

  const cMain = write("obj_main.c", `#include <stdio.h>
extern long long fromA(void);
extern long long fromB(void);
int main(void) { printf("%lld %lld\\n", fromA(), fromB()); return 0; }
`);
  const bin = join(DIR, "obj_main");
  execSync(`cc ${cMain} ${objA} ${objB} -o ${bin}`, { stdio: ["pipe", "pipe", "pipe"] });
  const out = execSync(bin, { encoding: "utf-8" });
  expect(out.trim()).toBe("111 222");
});

test("cleanup", () => {
  rmSync(DIR, { recursive: true, force: true });
});
