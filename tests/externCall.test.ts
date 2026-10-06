// The extern-call warning: every extern call belongs inside `unsafe`, except a `@pure`
// extern and a call inside a manifest dependency. Checker-level cases drive TypeChecker
// directly; the std-wrapper and dependency cases need the resolver, so they go through
// the CLI.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, mkdirSync, cpSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

function codes(src: string, denied: string[] = ["extern-call", "unused-unsafe"]): { code: string; line: number }[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(denied), allowed: new Set() }).check(prog);
  return res.diagnostics
    .filter(d => d.code === "extern-call" || d.code === "unused-unsafe")
    .map(d => ({ code: d.code!, line: d.span?.line ?? -1 }));
}

test("a bare call to a scalar extern is reported", () => {
  const src = `extern fn close(fd: i32): i32
fn main() {
  let r = close(-1)
  print(r)
}`;
  expect(codes(src)).toEqual([{ code: "extern-call", line: 3 }]);
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
  expect(codes(src)).toEqual([{ code: "extern-call", line: 4 }]);
});

test("a @pure extern is exempt, and an unsafe holding only one is unused", () => {
  const src = `@pure
extern fn sqrt(x: f64): f64
fn main() {
  print(sqrt(4.0))
  unsafe { print(sqrt(9.0)) }
}`;
  expect(codes(src)).toEqual([{ code: "unused-unsafe", line: 5 }]);
});

test("an extern that already needs unsafe is the existing error, not this warning", () => {
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

function check(file: string, env: Record<string, string> = {}): { code: number; diags: { code?: string; file: string }[] } {
  const r = spawnSync("bun", ["run", COMPILER, "check", "--json", "--deny=extern-call", file], {
    encoding: "utf-8", env: { ...process.env, ...env }, cwd: join(file, ".."),
  });
  return { code: r.status ?? 1, diags: JSON.parse(r.stdout).diagnostics ?? [] };
}

test("std is clean: a program reaching std wrappers checks with --deny=extern-call", () => {
  const r = check(join(import.meta.dir, "fixtures", "externCallInUnsafe.milo"));
  expect(r.diags.filter(d => d.code === "extern-call")).toEqual([]);
  expect(r.code).toBe(0);
});

test("--deny=extern-call turns a bare call into an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-extern-call-"));
  const f = join(dir, "bare.milo");
  writeFileSync(f, `extern fn getpid(): i32\n\nfn main() {\n    print(getpid())\n}\n`);
  const r = check(f);
  expect(r.code).not.toBe(0);
  expect(r.diags.map(d => d.code)).toContain("extern-call");
});

test("a bare extern call inside a manifest dependency is not reported", () => {
  // Same staging as tests/mangle.test.ts: a local-path dep under a temp HOME's cache.
  const HOME = mkdtempSync(join(tmpdir(), "milo-extern-call-home-"));
  const PROJECT = mkdtempSync(join(tmpdir(), "milo-extern-call-proj-"));
  const FIXTURE = resolve(import.meta.dir, "pkgfixtures", "externcaller");
  const cacheDir = join(HOME, ".milo", "cache", "local", FIXTURE.replace(/\//g, "_"), "main");
  mkdirSync(cacheDir, { recursive: true });
  cpSync(FIXTURE, cacheDir, { recursive: true });
  writeFileSync(join(PROJECT, "milo.json"), JSON.stringify({ name: "consumer", version: "0.1.0", deps: { externcaller: FIXTURE } }));
  const main = join(PROJECT, "main.milo");
  writeFileSync(main, `from "externcaller" import { parentPid }\n\nfn main() {\n    print(parentPid() > 0)\n}\n`);
  const r = check(main, { HOME });
  expect(r.diags).toEqual([]);
  expect(r.code).toBe(0);
});
