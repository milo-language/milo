// `unchecked-ffi-contract` (off by default): a `requires` on a function whose body enters
// `unsafe` is the last guard before C and `-O2` drops it. The lint fires when the body
// checks nothing about the values the clause names, and stays quiet once an `if` or
// `assert` in the body names them all. Backlog #27's two instances (an AES key length,
// a pool block size) were both this shape.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function check(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "milo-ffi-lint-"));
  try {
    const p = join(dir, "p.milo");
    writeFileSync(p, src);
    const r = spawnSync("bun", ["run", MAIN, "check", p, "--deny=unchecked-ffi-contract"], { encoding: "utf8" });
    return r.stdout + r.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = `
extern fn memset(dst: *u8, c: i32, n: i64): *u8
extern fn malloc(size: i64): *u8
`;

test("a requires with no matching body check on an unsafe-bodied fn is flagged", () => {
  const out = check(HEAD + `
fn zeroed(n: i64): *u8
requires n > 0
{
    unsafe {
        let p = malloc(n)
        memset(p, 0, n)
        return p
    }
}
fn main(): i32 { return 0 }
`);
  expect(out).toContain("'zeroed' enters 'unsafe' with only 'requires' guarding 'n'");
});

test("a body check naming the same parameter satisfies the lint, as an if or an assert", () => {
  const out = check(HEAD + `
fn zeroed(n: i64): *u8
requires n > 0
{
    assert(n > 0, "size")
    unsafe {
        let p = malloc(n)
        memset(p, 0, n)
        return p
    }
}
fn maybe(n: i64): Result<i64>
requires n > 0
{
    if n <= 0 { return Result.Err("size") }
    unsafe {
        let p = malloc(n)
        return p as i64
    }
}
fn main(): i32 { return 0 }
`);
  expect(out).not.toContain("unchecked-ffi-contract");
  expect(out).not.toContain("enters 'unsafe'");
});

test("a fn that never enters unsafe is not the lint's business", () => {
  const out = check(`
fn half(n: i64): i64
requires n >= 0
{
    return n / 2
}
fn main(): i32 { return 0 }
`);
  expect(out).not.toContain("enters 'unsafe'");
});
