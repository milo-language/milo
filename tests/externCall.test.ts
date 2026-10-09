// The extern-call error: every extern call belongs inside `unsafe`, except a `@pure`
// extern on scalars, and that includes a call inside a manifest dependency. Checker-level
// cases drive TypeChecker directly; the std-wrapper and dependency cases need the
// resolver, so they go through the CLI.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, mkdirSync, cpSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

// No flags: extern-call is an error by default. unused-unsafe is denied only so the
// `@pure` case can show the block holding a pure call counts as empty.
function codes(src: string): { code: string; line: number; severity: string }[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(["unused-unsafe"]), allowed: new Set() }).check(prog);
  return res.diagnostics
    .filter(d => d.code === "extern-call" || d.code === "unused-unsafe")
    .map(d => ({ code: d.code!, line: d.span?.line ?? -1, severity: d.severity }));
}

test("a bare call to a scalar extern is reported", () => {
  const src = `extern fn close(fd: i32): i32
fn main() {
  let r = close(-1)
  print(r)
}`;
  expect(codes(src)).toEqual([{ code: "extern-call", line: 3, severity: "error" }]);
});

test("the same call inside unsafe is not, and the block counts as used", () => {
  const src = `extern fn close(fd: i32): i32
fn main() {
  var r: i32 = 0
  unsafe { r = close(-1) }
  print(r)
}`;
  expect(codes(src)).toEqual([]);
});

test("a call nested in another call's arguments is reported", () => {
  const src = `extern fn getpid(): i32
fn show(n: i32) { print(n) }
fn main() {
  show(getpid())
}`;
  expect(codes(src)).toEqual([{ code: "extern-call", line: 4, severity: "error" }]);
});

test("a @pure extern is exempt, and an unsafe holding only one is unused", () => {
  const src = `@pure
extern fn sqrt(x: f64): f64
fn main() {
  print(sqrt(4.0))
  unsafe { print(sqrt(9.0)) }
}`;
  expect(codes(src)).toEqual([{ code: "unused-unsafe", line: 5, severity: "error" }]);
});

test("a @pure extern taking a pointer is not exempt: @pure is trusted only on scalars", () => {
  const src = `@pure
extern fn strlen(s: *u8): i64
fn main() {
  print(strlen("abc"))
}`;
  expect(codes(src)).toEqual([{ code: "extern-call", line: 4, severity: "error" }]);
});

test("an extern that already needs unsafe is the existing error, not this one", () => {
  const src = `extern fn strdup(s: *u8): *u8
fn main() {
  let p = strdup("x")
}`;
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(), allowed: new Set() }).check(prog);
  expect(res.diagnostics.some(d => d.code === "extern-call")).toBe(false);
  expect(res.diagnostics.some(d => /requires an unsafe block/.test(d.message))).toBe(true);
});

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

function check(file: string, env: Record<string, string> = {}, flags: string[] = []): { code: number; out: string; diags: { code?: string; file: string; severity: string }[] } {
  const r = spawnSync("bun", ["run", COMPILER, "check", "--json", ...flags, file], {
    encoding: "utf-8", env: { ...process.env, ...env }, cwd: join(file, ".."),
  });
  let diags = [];
  try { diags = JSON.parse(r.stdout).diagnostics ?? []; } catch { /* a CLI usage error prints no JSON */ }
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), diags };
}

test("std is clean: a program reaching std wrappers checks with no extern-call", () => {
  const r = check(join(import.meta.dir, "fixtures", "externCallInUnsafe.milo"));
  expect(r.diags.filter(d => d.code === "extern-call")).toEqual([]);
  expect(r.code).toBe(0);
});

test("a bare call is an error with no flag, and --allow does not reach it", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-extern-call-"));
  const f = join(dir, "bare.milo");
  writeFileSync(f, `extern fn getpid(): i32\n\nfn main() {\n    print(getpid())\n}\n`);
  const r = check(f);
  expect(r.code).not.toBe(0);
  expect(r.diags.filter(d => d.code === "extern-call").map(d => d.severity)).toEqual(["error"]);
  // Not a warning name any more, so the flag is refused outright rather than ignored.
  const allowed = check(f, {}, ["--allow=extern-call"]);
  expect(allowed.code).not.toBe(0);
  expect(allowed.out).toContain("unknown warning 'extern-call'");
});

// Same staging as tests/mangle.test.ts: a local-path dep under a temp HOME's cache. The
// package is copied to a temp dir first so `rewrite` can vary it without touching the
// checked-in fixture; both the dep path and its cache entry point at that copy.
function checkWithDep(rewrite: (lib: string) => string): ReturnType<typeof check> {
  const HOME = mkdtempSync(join(tmpdir(), "milo-extern-call-home-"));
  const PROJECT = mkdtempSync(join(tmpdir(), "milo-extern-call-proj-"));
  const FIXTURE = join(mkdtempSync(join(tmpdir(), "milo-extern-call-pkg-")), "externcaller");
  cpSync(resolve(import.meta.dir, "pkgfixtures", "externcaller"), FIXTURE, { recursive: true });
  const lib = join(FIXTURE, "lib.milo");
  writeFileSync(lib, rewrite(readFileSync(lib, "utf-8")));
  const cacheDir = join(HOME, ".milo", "cache", "local", FIXTURE.replace(/\//g, "_"), "main");
  mkdirSync(cacheDir, { recursive: true });
  cpSync(FIXTURE, cacheDir, { recursive: true });
  writeFileSync(join(PROJECT, "milo.json"), JSON.stringify({ name: "consumer", version: "0.1.0", deps: { externcaller: FIXTURE } }));
  const main = join(PROJECT, "main.milo");
  writeFileSync(main, `from "externcaller" import { parentPid }\n\nfn main() {\n    print(parentPid() > 0)\n}\n`);
  return check(main, { HOME });
}

test("a bare extern call inside a manifest dependency is reported: a package's soundness is its own job", () => {
  const r = checkWithDep(lib => lib);
  expect(r.code).not.toBe(0);
  const hits = r.diags.filter(d => d.code === "extern-call");
  expect(hits.length).toBe(1);
  expect(hits[0]!.file).toContain("lib.milo");
});

test("the same dependency with its call wrapped in unsafe checks clean", () => {
  const r = checkWithDep(lib => lib.replace("return getppid()", "unsafe { return getppid() }"));
  expect(r.diags).toEqual([]);
  expect(r.code).toBe(0);
});
