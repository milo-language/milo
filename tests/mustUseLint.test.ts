// The `unused-result` warning on a discarded `@mustUse` call, and on a discarded arena
// `get` (an Option, which needs no attribute). tests/errors cannot pin a warning (the
// lane compiles with warnings enabled but only asserts on exit code and error text), so
// these run `milo check --deny=unused-result` and read the diagnostics back.
import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "milo-mustuse-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function check(src: string): { out: string; code: number } {
  const f = join(WORK, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(f, src);
  const r = spawnSync("bun", [join(ROOT, "src", "main.ts"), "check", f, "--deny=unused-result"], { encoding: "utf8" });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}
const unusedResultCount = (out: string) => (out.match(/unused (result of|Option|Result)/g) ?? []).length;

test("a discarded @mustUse fn call is unused-result", () => {
  const r = check(`@mustUse fn f(): bool { return true }
fn main(): i32 {
  f()
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out).toContain("unused result of '@mustUse' function 'f'");
  expect(r.out).toContain("use 'let _ = ...' to discard explicitly");
});

test("a discarded @mustUse generic fn and method are unused-result; bound calls are silent", () => {
  const r = check(`struct S { n: i32 }
impl S {
  @mustUse
  fn ok(self: &Self): bool { return self.n > 0 }
}
@mustUse fn g<T>(_x: T): bool { return true }
fn main(): i32 {
  let s = S { n: 1 }
  g(1)
  s.ok()
  let _ = g(2)
  let _ = s.ok()
  if s.ok() { print("ok") }
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out).toContain("unused result of '@mustUse' function 'g'");
  expect(r.out).toContain("unused result of '@mustUse' function 'S.ok'");
  expect(unusedResultCount(r.out)).toBe(2);
});

test("a @mustUse fn returning Option reports once, as the Option", () => {
  const r = check(`@mustUse fn h(): Option<i32> { return Option.None }
fn main(): i32 {
  h()
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out).toContain("unused Option value");
  expect(r.out).not.toContain("@mustUse");
  expect(unusedResultCount(r.out)).toBe(1);
});

test("@mustUse on an extern fn is accepted and enforced", () => {
  const r = check(`@mustUse extern fn close(fd: i32): i32
fn main(): i32 {
  close(0)
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out).toContain("unused result of '@mustUse' function 'close'");
});

// The arena miss that matters most: `get` returns an Option and a discarded one was
// already `unused-result` on main, but nothing pinned it. Both spellings.
test("a discarded arena get (Option) is unused-result, by method and by free fn", () => {
  const r = check(`from "std/arena" import { Arena, arenaGet }
fn main(): i32 {
  var a = Arena<i32>.new()
  let h = a.alloc(1)
  a.get(h)
  arenaGet(a, h)
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out.match(/unused Option value/g) ?? []).toHaveLength(2);
  expect(r.out).toContain(".milo:5:3");
  expect(r.out).toContain(".milo:6:3");
});

test("std's annotated arena routines fire at a user call site, by method and by free fn", () => {
  const r = check(`from "std/arena" import { Arena, arenaFree }
fn main(): i32 {
  var a = Arena<i32>.new()
  let h = a.alloc(1)
  a.valid(h)
  arenaFree(a, h)
  return 0
}`);
  expect(r.code).toBe(1);
  expect(r.out).toContain("unused result of '@mustUse' function 'Arena<i32>.valid'");
  expect(r.out).toContain("unused result of '@mustUse' function 'arenaFree'");
});
