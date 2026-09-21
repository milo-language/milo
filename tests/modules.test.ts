// Cross-module name-collision semantics (issue #5): same-named top-level fns in
// different modules must not silently merge into one body. Different bodies are a
// compile error; identical bodies still merge; prelude override keeps working; and
// separately-compiled objects keep their own copies at link time (internal linkage).
import { test, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const DIR = mkdtempSync(join(tmpdir(), "milo-modules-"));

// spawnSync (not execSync) so stderr is captured on BOTH exit paths — a non-fatal
// warning exits 0, and execSync only surfaces stderr on a non-zero exit.
function milo(args: string, opts?: { env?: Record<string, string>; cwd?: string }): { code: number; out: string; err: string } {
  const r = spawnSync("bun", ["run", COMPILER, ...args.split(" ").filter(Boolean)], {
    encoding: "utf-8",
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function write(name: string, content: string): string {
  const p = join(DIR, name);
  writeFileSync(p, content);
  return p;
}

// `pub`, not private: a private helper of this shape is renamed per module now and is a
// legal program (see "two modules may each define a private helper"). Two modules EXPORTING
// the same name with different bodies is still a real ambiguity for anyone importing both.
test("same-named fns with different bodies in two modules is a compile error", () => {
  write("dup_a.milo", `pub fn foo(): string { return "AAA" }\npub fn fromA(): string { return foo() }\n`);
  write("dup_b.milo", `pub fn foo(): string { return "BBB" }\npub fn fromB(): string { return foo() }\n`);
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

test("identical bodies merge even when only one copy is pub", () => {
  // Visibility is not part of a body. `helper` is exported from one file and
  // private in the other; the merge must still see one implementation, and the
  // exported copy must stay importable from a third file.
  write("pubsame_a.milo", `pub fn helper(): i64 { return 7 }\npub fn fromA(): i64 { return helper() }\n`);
  write("pubsame_b.milo", `fn helper(): i64 { return 7 }\npub fn fromB(): i64 { return helper() }\n`);
  const main = write("pubsame_main.milo", `from "pubsame_a" import { fromA, helper }
from "pubsame_b" import { fromB }
fn main(): void {
    print(fromA() + fromB() + helper())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("21");
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
  // `pub`: only an exported fn is a linkable symbol (the header's rule, now the object's).
  const libA = write("obj_lib_a.milo", `from "obj_helper_a" import { tag }\npub fn fromA(): i64 { return tag() }\nfn main(): void {}\n`);
  const libB = write("obj_lib_b.milo", `from "obj_helper_b" import { tag }\npub fn fromB(): i64 { return tag() }\nfn main(): void {}\n`);
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

// `--no-entry` strips @main, and @main is the only caller of @__milo.global_init, so a
// global whose initializer has to RUN stays zero in the object with nothing said about
// it. `pub let A: string = "hello"` came out as the empty string. The condition is the
// flag alone: a module that HAS a main is no safer, because --no-entry renames it to
// @_milo_unused_main and strands the init call in dead code.
test("emit-obj --no-entry rejects a global whose initializer has to run", () => {
  const lib = write("no_entry_runtime_global.milo", `pub let GREETING: string = "hello"\npub fn greet(): string { return GREETING }\n`);
  const r = milo(`emit-obj ${lib} --no-entry -o ${join(DIR, "no_entry_runtime_global.o")}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("global 'GREETING' needs an initializer that runs");
  expect(existsSync(join(DIR, "no_entry_runtime_global.o"))).toBe(false);

  // Same module with a main(): still rejected, for the stranded-init reason.
  const withMain = write("no_entry_runtime_global_main.milo", `pub let GREETING: string = "hello"\nfn main(): void { print(GREETING) }\n`);
  const r2 = milo(`emit-obj ${withMain} --no-entry -o ${join(DIR, "no_entry_runtime_global_main.o")}`);
  expect(r2.code).not.toBe(0);
  expect(r2.err).toContain("needs an initializer that runs");
});

// The case --no-entry exists for: constant globals fold to real LLVM constants, so
// there is nothing for the init routine to run and the object is complete on its own.
test("emit-obj --no-entry still accepts constant globals", () => {
  const lib = write("no_entry_const_global.milo", `pub let N: i64 = 5\npub fn twice(): i64 { return N * 2 }\n`);
  const obj = join(DIR, "no_entry_const_global.o");
  const r = milo(`emit-obj ${lib} --no-entry -o ${obj}`);
  expect(`${r.code}: ${r.err}`).toBe(`0: ${r.err}`);
  expect(existsSync(obj)).toBe(true);
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

// ── types and globals share the fn story: one flat namespace, last-wins ──
// The live case this closed: std/fetch's `pub struct Response` vs std/http's
// `pub enum Response`. Importing both compiled the enum and silently discarded
// the struct, so std/fetch's own code failed with "cannot access field on enum
// 'Response'" and "expected Response, got Response" — errors pointing at correct
// code, with nothing naming the collision.

test("a struct and an enum with the same name in two modules is a compile error", () => {
  write("ty_struct.milo", `pub struct Payload { code: i64 }\npub fn fromStruct(): Payload { return Payload { code: 1 } }\n`);
  write("ty_enum.milo", `pub enum Payload { Ok, Bad }\npub fn fromEnum(): Payload { return Payload.Ok }\n`);
  const main = write("ty_main.milo", `from "ty_struct" import { fromStruct }
from "ty_enum" import { fromEnum }
fn main(): void {
    print(fromStruct().code)
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  // Both kinds and both files, so the user can act without opening the compiler.
  expect(msg).toContain("'Payload' is defined as a struct in");
  expect(msg).toContain("and as an enum in");
  expect(msg).toContain("ty_struct.milo");
  expect(msg).toContain("ty_enum.milo");
});

test("same-named structs with different fields in two modules is a compile error", () => {
  write("tyd_a.milo", `pub struct Config { host: string }\npub fn hostOf(c: &Config): string { return c.host }\n`);
  write("tyd_b.milo", `pub struct Config { port: i64 }\npub fn portOf(c: &Config): i64 { return c.port }\n`);
  const main = write("tyd_main.milo", `from "tyd_a" import { Config, hostOf }
from "tyd_b" import { portOf }
fn main(): void {
    print(hostOf(Config { host: "x" }))
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  expect(msg).toContain("'Config' is defined as a struct in");
  expect(msg).toContain("tyd_a.milo");
  expect(msg).toContain("tyd_b.milo");
});

// The tolerance guard. Vendoring the same type into two modules is legitimate and
// must keep compiling — fns already get this and types must match them, or a
// future tightening breaks working code with no test to catch it.
test("byte-identical type definitions in two modules still merge", () => {
  write("tysame_a.milo", `pub struct Pt { x: i64, y: i64 }\npub fn fromA(): Pt { return Pt { x: 1, y: 2 } }\n`);
  write("tysame_b.milo", `pub struct Pt { x: i64, y: i64 }\npub fn fromB(): Pt { return Pt { x: 10, y: 20 } }\n`);
  const main = write("tysame_main.milo", `from "tysame_a" import { Pt, fromA }
from "tysame_b" import { fromB }
fn main(): void {
    let a = fromA()
    let b = fromB()
    print(a.x + a.y + b.x + b.y)
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("33");
});

test("identical enums merge even when only one copy is pub", () => {
  // Same laxity fns get: `isPub` is not part of a definition.
  write("tyenum_a.milo", `pub enum Color { Red, Blue }\npub fn fromA(): Color { return Color.Red }\n`);
  write("tyenum_b.milo", `enum Color { Red, Blue }\npub fn fromB(): bool { return fromBInner() == Color.Blue }\nfn fromBInner(): Color { return Color.Blue }\n`);
  const main = write("tyenum_main.milo", `from "tyenum_a" import { Color, fromA }
from "tyenum_b" import { fromB }
fn main(): void {
    print(fromA() == Color.Red)
    print(fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual(["true", "true"]);
});

// `pub` for the same reason as the fn case above: a private global is per-module now.
test("same-named globals with different values in two modules is a compile error", () => {
  write("gl_a.milo", `pub let LIMIT: i64 = 10\npub fn fromA(): i64 { return LIMIT }\n`);
  write("gl_b.milo", `pub let LIMIT: i64 = 20\npub fn fromB(): i64 { return LIMIT }\n`);
  const main = write("gl_main.milo", `from "gl_a" import { fromA }
from "gl_b" import { fromB }
fn main(): void {
    print(fromA() + fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  expect(msg).toContain("'LIMIT' is defined as a global in");
  expect(msg).toContain("gl_a.milo");
  expect(msg).toContain("gl_b.milo");
});

test("identical globals in two modules still merge", () => {
  // std/sha1 and std/sha256 both hold `let MASK32: i64 = 0xffffffff` — this is
  // that shape, and it must stay legal.
  write("glsame_a.milo", `let MASKV: i64 = 255\npub fn fromA(): i64 { return MASKV }\n`);
  write("glsame_b.milo", `let MASKV: i64 = 255\npub fn fromB(): i64 { return MASKV }\n`);
  const main = write("glsame_main.milo", `from "glsame_a" import { fromA }
from "glsame_b" import { fromB }
fn main(): void {
    print(fromA() + fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("510");
});

// Globals and fns share the value namespace — `@name` is one LLVM symbol either
// way. Before this check the only signal was clang's "redefinition of function
// '@asciiIsDigit'" against generated IR the user never wrote.
test("a global shadowing a stdlib function name is a compile error", () => {
  const main = write("glfn_main.milo", `let asciiIsDigit: i64 = 5
fn main(): void {
    print(asciiIsDigit)
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).not.toBe(0);
  const msg = r.err + r.out;
  expect(msg).toContain("'asciiIsDigit' is defined as a function in 'std/string.milo'");
  expect(msg).toContain("and as a global in");
  expect(msg).not.toContain("redefinition of function");
});

// std ships as one flat namespace, so a private helper in one module can collide with
// a private helper in another and make the PAIR unimportable — `std/sha1` + `std/xxhash`
// both defined `rotl`, with different bodies, so any program wanting both failed to
// compile with an error naming neither of its own lines. That is invisible to per-module
// tests: each module is fine alone. One program importing the whole hazard set catches
// every such collision in a single compile, so this is the regression lock for the
// module-prefixed helper names (_xxRotl, _sha1Rotl, _uuidHexValue, _httpHexValue, ...).
// Every std module in one program. Stage 4 of per-module namespaces scopes every private
// std name to its module, so no two std modules can collide on a private helper any more;
// this is the gate that says so for ALL of them, not the historical hazard set. Enumerated
// from std/ so a new module joins the gate by existing. Platform arms collapse to their
// base module (the resolver picks the host's arm); the prelude is imported implicitly.
// Type-check only: the point is the merge, and linking every std module would also need
// every native library std can bind (sqlite, tls, dl).
test("every std module imports together in one program", () => {
  const stdDir = join(import.meta.dir, "..", "std");
  const modules = readdirSync(stdDir)
    .filter(f => f.endsWith(".milo") && !/\.(darwin|linux|windows|wasm)\.milo$/.test(f) && f !== "prelude.milo")
    .map(f => f.replace(/\.milo$/, ""))
    .sort();
  expect(modules.length).toBeGreaterThan(60);
  const imports: string[] = [];
  for (const m of modules) {
    // The first `pub` declaration is the import; a module with none has no surface to
    // import and is listed so the gate cannot silently stop covering it.
    const src = readFileSync(join(stdDir, `${m}.milo`), "utf-8");
    const pub = src.match(/^pub (?:fn|struct|enum|trait|interface|type|var|let) ([A-Za-z_][A-Za-z0-9_]*)/m);
    expect(`${m}: ${pub?.[1] ?? "NO PUB DECL"}`).not.toContain("NO PUB DECL");
    imports.push(`from "std/${m}" import { ${pub![1]} }`);
  }
  const main = write("std_all_modules.milo", `${imports.join("\n")}\nfn main() { print("ok") }\n`);
  const r = milo(`check ${main}`);
  // Only these two are collisions; a warning (unused import) is expected and fine.
  expect(r.err).not.toContain("defined in two modules");
  expect(r.err).not.toContain("is defined as a");
  expect(`${r.code} ${r.err.split("\n").filter(l => l.includes("error")).join(" | ")}`).toBe("0 ");
});

// Per-module namespaces, stage 1 (docs/plans/module-namespaces.md). A private helper is
// invisible outside its own file, so two modules each defining one is not an ambiguity —
// it was only ever a failure of the flat merge. Renaming the contested names deletes the
// error class without changing what any working program means.
test("two modules may each define a private helper with the same name", () => {
  write("priv_a.milo", `fn tone(x: i64): i64 { return x + 1 }\npub fn fromA(): i64 { return tone(10) }\n`);
  write("priv_b.milo", `fn tone(x: i64): i64 { return x * 100 }\npub fn fromB(): i64 { return tone(10) }\n`);
  const main = write("priv_main.milo", `from "priv_a" import { fromA }
from "priv_b" import { fromB }
fn main(): void {
    print(fromA())
    print(fromB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).not.toContain("defined in two modules");
  expect(r.code).toBe(0);
  // Each call site must reach its OWN module's body — the failure mode this replaces is
  // one body surviving the merge and every call site silently running it.
  expect(r.out.trim().split("\n")).toEqual(["11", "1000"]);
});

test("a private helper may also collide with another module's pub name", () => {
  write("pp_a.milo", `fn helper(): i64 { return 1 }\npub fn fromA(): i64 { return helper() }\n`);
  write("pp_b.milo", `pub fn helper(): i64 { return 2 }\n`);
  const main = write("pp_main.milo", `from "pp_a" import { fromA }
from "pp_b" import { helper }
fn main(): void {
    print(fromA())
    print(helper())
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual(["1", "2"]);
});

// The pass renames PRIVATE names only. Two modules exporting the same name is a real
// ambiguity for anyone importing both, so that diagnostic has to survive — and keeping it
// is also what means no import binding anywhere had to be rewritten.
test("two pub names with different bodies still collide", () => {
  write("pub_a.milo", `pub fn shared(): i64 { return 1 }\n`);
  write("pub_b.milo", `pub fn shared(): i64 { return 2 }\n`);
  const main = write("pub_main.milo", `from "pub_a" import { shared }
fn main(): void {
    print(shared())
}
`);
  write("pub_c.milo", `from "pub_b" import { shared as other }\npub fn use2(): i64 { return other() }\n`);
  const r = milo(`run ${main}`);
  expect(r.code === 0 || r.err.includes("defined in two modules")).toBe(true);
});

test("identical private helpers in two modules still work", () => {
  write("id_a.milo", `fn same(): i64 { return 7 }\npub fn a1(): i64 { return same() }\n`);
  write("id_b.milo", `fn same(): i64 { return 7 }\npub fn b1(): i64 { return same() }\n`);
  const main = write("id_main.milo", `from "id_a" import { a1 }
from "id_b" import { b1 }
fn main(): void {
    print(a1() + b1())
}
`);
  const r = milo(`run ${main}`);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("14");
});

// A private STRUCT is renamed the same way, and the rename must reach every reference to
// it — a missed field type or literal is a miscompile, not a compile error.
test("two modules may each define a private struct with the same name", () => {
  write("ps_a.milo", `struct Node { v: i64 }\npub fn mkA(): i64 { let n = Node { v: 3 }\n    return n.v }\n`);
  write("ps_b.milo", `struct Node { label: string }\npub fn mkB(): string { let n = Node { label: "b" }\n    return n.label }\n`);
  const main = write("ps_main.milo", `from "ps_a" import { mkA }
from "ps_b" import { mkB }
fn main(): void {
    print(mkA())
    print(mkB())
}
`);
  const r = milo(`run ${main}`);
  expect(r.err).not.toContain("defined in two modules");
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual(["3", "b"]);
});

// ── display names (docs/plans/module-namespaces.md, stage 3) ──
//
// The rename is a SYMBOL change. Every surface a person reads has to keep showing the
// name they wrote, or the pass trades one bad error message for another, which is
// exactly what blocked it from ever widening past collisions.

// Both modules define a private `User` and a private `tone`; both are contested, so both
// get renamed. `print` is program output, not a symbol.
const DISPLAY_A = `struct User { id: i64 }
fn tone(x: i64): i64 { return x + 1 }
pub fn fromA(): i64 {
    let u = User { id: tone(10) }
    print(u)
    return u.id
}
`;
const DISPLAY_B = `struct User { name: string }
fn tone(x: i64): i64 { return x * 100 }
pub fn fromB(): i64 {
    let u = User { name: "b" }
    print(u)
    return tone(10)
}
`;
const DISPLAY_MAIN = `from "disp_a" import { fromA }
from "disp_b" import { fromB }
fn main(): void {
    print(fromA())
    print(fromB())
}
`;

test("print of a collided private struct shows the name as written", () => {
  write("disp_a.milo", DISPLAY_A);
  write("disp_b.milo", DISPLAY_B);
  const main = write("disp_main.milo", DISPLAY_MAIN);
  const r = milo(`run ${main}`);
  expect(`${r.code} ${r.err}`).toContain("0 ");
  expect(r.out.trim().split("\n")).toEqual([
    "User { id: 11 }", "11", "User { name: \"b\" }", "1000",
  ]);
  // Not a revert: the symbols themselves are still renamed, which is the whole point.
  const ir = milo(`emit-ir ${main}`);
  expect(ir.out).toContain("%disp_a$User = type");
  expect(ir.out).toContain("%disp_b$User = type");
  expect(ir.out).toContain("@disp_a$tone");
});

test("a diagnostic about a collided private name shows the name as written", () => {
  write("disp_a.milo", DISPLAY_A.replace("tone(10)", "tone(10, 2)").replace("print(u)", "print(u.nope)"));
  write("disp_b.milo", DISPLAY_B);
  const main = write("disp_main.milo", DISPLAY_MAIN);
  const r = milo(`check ${main}`);
  const msg = r.err + r.out;
  expect(r.code).not.toBe(0);
  expect(msg).toContain("function 'tone' expects 1 args");
  expect(msg).toContain("struct 'User' has no field 'nope'");
  // The module prefix must not reach the reader anywhere in the report.
  expect(msg).not.toContain("$");
});

// The regressions that kept stage 1 collision-only were `print` output and `@error:`
// text. With display names in place the pass can rename every private name; this pins
// that the two surfaces stay clean when it does (the fixture suite run under the same
// switch is the wide version of this test).
test("display names hold when EVERY private name is mangled, not just contested ones", () => {
  // Nothing collides here: `Solo`/`solo` exist in one module only, so the pass is a
  // no-op by default and renames them only under the widening switch.
  write("wide_a.milo", `struct Solo { id: i64 }
fn solo(x: i64): i64 { return x + 1 }
pub fn fromWide(): i64 {
    let s = Solo { id: solo(10) }
    print(s)
    return s.id
}
`);
  const main = write("wide_main.milo", `from "wide_a" import { fromWide }
fn main(): void { print(fromWide()) }
`);
  const env = { MILO_MANGLE_ALL: "1" };
  const r = milo(`run ${main}`, { env });
  expect(`${r.code} ${r.err}`).toContain("0 ");
  expect(r.out.trim().split("\n")).toEqual(["Solo { id: 11 }", "11"]);
  // ...and it really did rename them, so the assertion above is not vacuous.
  expect(milo(`emit-ir ${main}`, { env }).out).toContain("%wide_a$Solo = type");

  write("wide_a.milo", `struct Solo { id: i64 }
fn solo(x: i64): i64 { return x + 1 }
pub fn fromWide(): i64 {
    let s = Solo { id: solo(10, 2) }
    return s.nope
}
`);
  const bad = milo(`check ${main}`, { env });
  const msg = bad.err + bad.out;
  expect(bad.code).not.toBe(0);
  expect(msg).toContain("function 'solo' expects 1 args");
  expect(msg).toContain("struct 'Solo' has no field 'nope'");
  expect(msg).not.toContain("$");
});

// DWARF is the surface with no second chance: a debugger shows what the metadata says,
// and `gfx$tone` in a backtrace is a worse debugging story than the collision error the
// pass replaced. Skipped rather than failed where no dwarfdump exists.
test("a collided private fn keeps its written name in DWARF", () => {
  write("disp_a.milo", DISPLAY_A);
  write("disp_b.milo", DISPLAY_B);
  const main = write("disp_main.milo", DISPLAY_MAIN);
  const bin = join(DIR, "disp_bin");
  const b = milo(`build ${main} -o ${bin} -g --debug`);
  expect(`${b.code} ${b.err}`).toContain("0 ");

  const dumper = ["llvm-dwarfdump", "dwarfdump", "/opt/homebrew/opt/llvm/bin/llvm-dwarfdump"].find(d => {
    try { execSync(`command -v ${d}`, { stdio: "ignore" }); return true; } catch { return false; }
  });
  if (!dumper) { console.log("no DWARF reader on this box; DWARF name check skipped"); return; }
  // macOS puts the debug map in a .dSYM bundle; ELF keeps it in the binary.
  const target = existsSync(`${bin}.dSYM`) ? `${bin}.dSYM` : bin;
  const dump = execSync(`${dumper} ${target}`, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const names = new Set(Array.from(dump.matchAll(/DW_AT_name\s*\(?"([^"]+)"/g), m => m[1]));
  expect(names.has("tone")).toBe(true);
  expect(names.has("User")).toBe(true);
  expect([...names].filter(n => n.startsWith("disp_a$") || n.startsWith("disp_b$"))).toEqual([]);
  // The linker still sees the renamed symbol; display names change nothing about that.
  expect(execSync(`nm ${bin} 2>/dev/null || true`, { encoding: "utf-8" })).toContain("disp_a$tone");
});

test("cleanup", () => {
  rmSync(DIR, { recursive: true, force: true });
});

// A package import resolves against the manifest NEAREST THE IMPORTING FILE, not against
// the entry point's.
//
// Resolving it once from the entry's directory made an import's meaning depend on where
// compilation started: a library file sitting beside a milo.json that declares `dep`
// resolved `from "dep" import …` when the entry was its neighbour and failed with
// `cannot open 'dep'` when the entry was a test fixture two directories away — the same
// file, the same import, two different answers. It broke `tests/fixtures/flybyGeometry.milo`
// the moment an example it imports grew a package dependency, and it would break any
// fixture that reaches a package-using module.
//
// Built as a local-path dependency so this needs no network and no package cache.
test("a package import resolves against the importing file's manifest, not the entry's", () => {
  const root = join(DIR, "pkgscope");
  const lib = join(root, "lib");       // has a manifest naming the dep
  const dep = join(root, "dep");       // the dependency itself
  const entry = join(root, "entry");   // NO manifest — the entry lives here
  const cache = join(root, "cache");   // isolated: never touch the developer's ~/.milo
  for (const d of [root, lib, dep, entry, cache]) mkdirSync(d, { recursive: true });

  writeFileSync(join(dep, "milo.json"), JSON.stringify({ name: "dep", version: "0.1.0", lib: "lib.milo" }));
  writeFileSync(join(dep, "lib.milo"), "pub fn depValue(): i64 { return 7 }\n");
  writeFileSync(join(lib, "milo.json"), JSON.stringify({
    name: "lib", version: "0.1.0", deps: { dep },
  }));
  writeFileSync(join(lib, "helper.milo"),
    'from "dep" import { depValue }\n\npub fn helper(): i64 { return depValue() + 1 }\n');
  writeFileSync(join(entry, "main.milo"),
    'from "../lib/helper" import { helper }\n\nfn main() { print(helper()) }\n');

  const env = { XDG_CACHE_HOME: cache, XDG_DATA_HOME: join(root, "data") };
  const inst = milo("install", { env, cwd: lib });
  // If install cannot run at all the assertion below would "pass" for the wrong reason.
  expect(`install: ${inst.code} ${inst.err}`).toContain("install: 0");

  const r = milo(`run ${join(entry, "main.milo")}`, { env });
  expect(`${r.code} ${r.out.trim()} ${r.err}`).toContain("8");
  expect(r.code).toBe(0);
});
