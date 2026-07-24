// Cross-module name-collision semantics (issue #5): same-named top-level fns in
// different modules must not silently merge into one body. Different bodies are a
// compile error; identical bodies still merge; prelude override keeps working; and
// separately-compiled objects keep their own copies at link time (internal linkage).
import { test, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const DIR = mkdtempSync(join(tmpdir(), "milo-modules-"));

// spawnSync (not execSync) so stderr is captured on BOTH exit paths — a non-fatal
// warning exits 0, and execSync only surfaces stderr on a non-zero exit.
function milo(args: string): { code: number; out: string; err: string } {
  const r = spawnSync("bun", ["run", COMPILER, ...args.split(" ").filter(Boolean)], { encoding: "utf-8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function write(name: string, content: string): string {
  const p = join(DIR, name);
  writeFileSync(p, content);
  return p;
}

test("same-named fns with different bodies in two modules is a compile error", () => {
  write("dup_a.milo", `fn foo(): string { return "AAA" }\npub fn fromA(): string { return foo() }\n`);
  write("dup_b.milo", `fn foo(): string { return "BBB" }\npub fn fromB(): string { return foo() }\n`);
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
  expect(msg).toContain("defined in two modules with different bodies");
  expect(msg).toContain("dup_a.milo");
  expect(msg).toContain("dup_b.milo");
});

test("same-named fns with identical bodies still merge", () => {
  // `helper` stays private on purpose: it is defined identically in both files, so
  // each file's own reference to it is legal even after the flat namespace merges them.
  write("same_a.milo", `fn helper(): i64 { return 7 }\npub fn fromA(): i64 { return helper() }\n`);
  write("same_b.milo", `fn helper(): i64 { return 7 }\npub fn fromB(): i64 { return helper() }\n`);
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

test("user redefinition of a prelude fn (same signature) warns but still overrides", () => {
  // Same signature as std/string's strIndexOf, different body. Compiles — the sigs
  // match — but the flat namespace makes this body win everywhere, so it warns
  // (shadows-stdlib-override) rather than rebinding silently.
  const main = write("override_main.milo", `fn strIndexOf(haystack: &string, needle: &string): i64 { return -42 }
fn main(): void {
    print(strIndexOf("hello", "l"))
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("-42");
  expect(r.err).toContain("shadows a standard-library function");
});

test("user redefinition of a prelude fn with a DIFFERENT signature is a hard error", () => {
  // std/string's strTrim is (s: &string): string; this (s: string) mismatches, so
  // the library's own calls would break — rejected outright, not merely warned.
  const main = write("override_sig_main.milo", `fn strTrim(s: string): string { return "overridden" }
fn main(): void {
    print(strTrim("  x  "))
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("shadows a standard-library function");
});

// The hades case: two separately-compiled objects whose imported helpers share a
// name but not a body. Each compilation is internally consistent, so no compile
// error is possible — internal linkage must keep each object's copy at link time
// (linkonce_odr let the linker discard one).
test("separately compiled objects keep their own same-named helper bodies", () => {
  write("obj_helper_a.milo", `pub fn tag(): i64 { return 111 }\n`);
  write("obj_helper_b.milo", `pub fn tag(): i64 { return 222 }\n`);
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

// Regression: a type error in an *imported* module must be reported against that
// module's file/line/source — not misattributed to the entry file. Spans used to
// carry only line/col (no file), so the renderer pulled the caret from the entry
// source and printed e.g. "main.milo:105" (a blank line) for an error in an import.
test("type error in an imported module names the imported file, not the entry", () => {
  write("err_mod.milo", `pub fn bad(x: i64): i64 {
    let narrow: i32 = 2
    return x + narrow
}
`);
  // Pad the entry so the imported error's line number lands on unrelated entry
  // text — that mismatch is exactly what the old renderer exposed.
  const main = write("err_main.milo", `from "err_mod" import { bad }
// filler
// filler
// filler
// filler
fn main(): void {
    print(bad(5))
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  expect(msg).toContain("type mismatch in '+'");
  // Header points at the imported file, and the caret snippet is the imported
  // file's real source line — proof the right source was resolved.
  expect(msg).toContain("err_mod.milo:3");
  expect(msg).toContain("return x + narrow");
  // The entry file must NOT be blamed for the imported module's error.
  expect(msg).not.toContain("err_main.milo:");
});

test("cleanup", () => {
  rmSync(DIR, { recursive: true, force: true });
});
