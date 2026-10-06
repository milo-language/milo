// The redundant-cast lint: a literal cast to the type its context already expects. Fires
// only where the expected type is known, never where the cast is what fixes the type, and
// `milo fix` rewrites each hit into a program that still compiles and means the same.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function redundantLines(src: string): number[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(["redundant-cast"]), allowed: new Set() }).check(prog);
  return res.diagnostics.filter(d => d.code === "redundant-cast").map(d => d.span?.line ?? -1).sort((a, b) => a - b);
}

test("fires where an annotation, a parameter, a return type or a ?? default expects the type", () => {
  const src = `fn take(n: i64): i64 { return n }
fn f(o: Option<i64>): i64 {
  let a: i64 = (0 as i64)
  let b = o ?? (-1 as i64)
  let c: u8 = 7 as u8
  let d: f32 = (1.5 as f32)
  print(take(5 as i64).toString())
  return a + b + (c as i64) + (d as i64)
}
fn g(): i64 { return (3 as i64) }`;
  expect(redundantLines(src)).toEqual([3, 4, 5, 6, 7, 10]);
});

test("stays quiet where the cast is what gives the literal its type", () => {
  const src = `fn same<T>(x: T): T { return x }
fn wide<T>(x: T): i64 { let z: T = (0 as T) return 1 }
fn f(): i64 {
  let a = 0 as u8
  let b: u8 = (300 as u8)
  let c: i64 = (2.5 as i64)
  let d: i32 = 0 as i64 as i32
  let e = same(4 as u16)
  let w = wide(1 as u8)
  print(a.toString() + b.toString() + d.toString() + e.toString())
  return c + w
}`;
  expect(redundantLines(src)).toEqual([]);
});

test("milo fix drops the cast and its own parentheses, never a call's", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-redundant-cast-"));
  try {
    const src = join(dir, "p.milo");
    writeFileSync(src, `fn take(n: i64): i64 {
    return n
}

fn port(o: Option<i64>): i64 {
    return o ?? (-1 as i64)
}

pub fn main(): i32 {
    let a: i64 = (0 as i64)
    print(take(5 as i64).toString())
    print(take((6 as i64)).toString())
    print((a + port(Option.None)).toString())
    return 0
}
`);
    const fix = spawnSync("bun", ["run", MAIN, "fix", src], { encoding: "utf8" });
    expect(fix.status, fix.stderr).toBe(0);
    expect(readFileSync(src, "utf8")).toBe(`fn take(n: i64): i64 {
    return n
}

fn port(o: Option<i64>): i64 {
    return o ?? -1
}

pub fn main(): i32 {
    let a: i64 = 0
    print(take(5).toString())
    print(take(6).toString())
    print((a + port(Option.None)).toString())
    return 0
}
`);
    const run = spawnSync("bun", ["run", MAIN, "run", src, "--deny=redundant-cast"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("5\n6\n-1\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
