// Explicit `&mut` on call arguments (docs/plans/local-reasoning-2026-09.md, track A):
// the `implicit-mut-borrow` warning, the misplacement errors, and the fixer that
// rewrites a file from the checker's resolved signatures. tests/errors pins the error
// texts on whole programs; this file covers the warning levels and the script, which
// only a CLI run can exercise.
import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "milo-explicit-mut-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function write(src: string): string {
  const f = join(WORK, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(f, src);
  return f;
}
function check(file: string, ...flags: string[]): { out: string; code: number } {
  const r = spawnSync("bun", [join(ROOT, "src", "main.ts"), "check", file, ...flags], { encoding: "utf8" });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}
const WARN = "is passed to a '&mut' parameter without '&mut'";

const bare = `struct P { n: i64 }
fn bump(p: &mut P, by: i64): void { p.n = p.n + by }
fn fill(s: &mut [i64], v: i64): void { s[0] = v }
fn main(): i32 {
  var p = P { n: 1 }
  var v: Vec<i64> = [0, 0]
  bump(p, 2)
  fill(v[0..1], 3)
  fill(v, 4)
  return 0
}
`;
const explicit = bare
  .replace("bump(p, 2)", "bump(&mut p, 2)")
  .replace("fill(v[0..1], 3)", "fill(&mut v[0..1], 3)")
  .replace("fill(v, 4)", "fill(&mut v, 4)");

test("implicit-mut-borrow is allowed by default: a bare argument is silent", () => {
  const r = check(write(bare));
  expect(r.code).toBe(0);
  expect(r.out).not.toContain(WARN);
});

test("--deny=implicit-mut-borrow makes a bare argument an error, with the rewrite hint", () => {
  const r = check(write(bare), "--deny=implicit-mut-borrow");
  expect(r.code).toBe(1);
  expect(r.out).toContain("argument 'p' is passed to a '&mut' parameter without '&mut'");
  expect(r.out).toContain("write 'bump(... &mut p ...)'; run 'bun scripts/explicit-mut.ts <file>' to rewrite the file");
  expect(r.out).toContain("argument 'v[..]' is passed to a '&mut' parameter without '&mut'");
  expect(r.out).toContain("argument 'v' is passed to a '&mut' parameter without '&mut'");
  expect((r.out.match(new RegExp(WARN, "g")) ?? []).length).toBe(3);
});

test("with &mut written the denied warning is silent and the program checks", () => {
  const r = check(write(explicit), "--deny=implicit-mut-borrow");
  expect(r.code).toBe(0);
  expect(r.out).not.toContain(WARN);
});

test("&mut on an argument to a &T or by-value parameter is an error naming the parameter type", () => {
  const r = check(write(`struct P { n: i64 }
fn show(p: &P): i64 { return p.n }
fn take(p: P): i64 { return p.n }
fn main(): i32 {
  var p = P { n: 1 }
  let a = show(&mut p)
  let b = take(&mut p)
  return (a + b) as i32
}
`));
  expect(r.code).toBe(1);
  expect(r.out).toContain("'&mut' on an argument to a '&P' parameter of 'show'; only a '&mut' parameter takes '&mut'");
  expect(r.out).toContain("'&mut' on an argument to a 'P' parameter of 'take'; only a '&mut' parameter takes '&mut'");
});

test("&mut on a receiver is an error that prints the call without it", () => {
  const r = check(write(`fn main(): i32 {
  var v: Vec<i64> = []
  (&mut v).push(1)
  return v.len() as i32
}
`));
  expect(r.code).toBe(1);
  expect(r.out).toContain("'&mut' is implicit on a method receiver; write 'v.push(1)'");
});

test("&mut outside a call argument is not a value", () => {
  const r = check(write(`fn main(): i32 {
  var x: i64 = 1
  let r = &mut x
  return r as i32
}
`));
  expect(r.code).toBe(1);
  expect(r.out).toContain("'&mut' marks an argument to a '&mut' parameter; it is not a value");
});

test("&mut on a closure call argument and on a &mut param passed on is accepted", () => {
  const r = check(write(`fn inc(x: &mut i64): void { x = x + 1 }
fn twice(f: (&mut i64) => void, x: &mut i64): void {
  f(&mut x)
  f(&mut x)
}
fn main(): i32 {
  var k: i64 = 0
  twice(inc, &mut k)
  return k as i32
}
`), "--deny=implicit-mut-borrow");
  expect(r.out).not.toContain(WARN);
  expect(r.code).toBe(0);
});

test("&x stays an error and the message says why &mut is different", () => {
  const r = check(write(`fn total(v: &Vec<i64>): i64 { return v.len() }
fn main(): i32 {
  let v: Vec<i64> = [1]
  return total(&v) as i32
}
`));
  expect(r.code).toBe(1);
  expect(r.out).toContain("'&x' is not an expression: shared borrows are implicit (pass 'x' bare). Only a '&mut' argument is spelled out: 'f(&mut x)'.");
});

test("scripts/explicit-mut.ts rewrites a file to the explicit form and is idempotent", () => {
  const f = write(bare);
  const run = () => spawnSync("bun", [join(ROOT, "scripts", "explicit-mut.ts"), f], { encoding: "utf8" });
  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`${f}: 3 argument(s) rewritten`);
  expect(readFileSync(f, "utf8")).toBe(explicit);
  const second = run();
  expect(second.status).toBe(0);
  expect(second.stdout).toContain(`${f}: 0 argument(s) rewritten`);
  expect(readFileSync(f, "utf8")).toBe(explicit);
  expect(check(f, "--deny=implicit-mut-borrow").code).toBe(0);
});
