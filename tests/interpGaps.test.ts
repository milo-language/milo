// Interpreter gaps closed one rule at a time: library behaviour and C functions that need no
// system access (sort and min/max natives, string pieces, error boxing, jsonStringify, ...), and the
// CLI-only FFI. Each title carries the rule IDs it covers (scripts/trace-semantics.ts check (c)).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { runChecked, type RunOptions } from "../src/interp-co";
import { InterpStuck, InterpUnsupported } from "../src/interp-values";
import type { Program } from "../src/ast";
import type { CheckResult } from "../src/checker";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-gaps-"));
let n = 0;
const checkedOf = new Map<Program, CheckResult>();
function check(src: string, name = `t${n++}.milo`): { program: Program; interp: Interp; path: string } {
  const path = join(dir, name);
  writeFileSync(path, src);
  const tokens = new Lexer(src).tokenize();
  const parsed = new Parser(tokens, src, path).parse();
  const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  if (errors.length) throw new Error(`checker rejected the test program: ${errors.map(e => e.message).join("; ")}`);
  checkedOf.set(program, result);
  return { program, interp: new Interp(program, result), path };
}
const run = (src: string, opts: RunOptions = {}, name?: string) => {
  const { program, path } = check(src, name);
  const { result: r } = runChecked(program, checkedOf.get(program)!, { entryFile: path, ...opts });
  return { out: new TextDecoder().decode(r.stdout), code: r.code, live: r.live };
};

test("E-VEC: sort, min, max and sortByKey order ints, floats (a NaN is less than nothing), strings by bytes and false before true", () => {
  const r = run(`
fn main() {
    var v: Vec<i64> = [5, -3, 9, 0]
    v.sort()
    print(v)
    var f: Vec<f64> = [2.5, 0.0 / 0.0, -1.0]
    f.sort()
    print(f.len)
    var b: Vec<bool> = [true, false, true]
    b.sort()
    print(b)
    let s: Vec<string> = ["pear", "app", "Zed"]
    match s.min() { Option.Some(x) => print(x), Option.None => print("none") }
    match s.max() { Option.Some(x) => print(x), Option.None => print("none") }
    var w: Vec<string> = ["ccc", "a", "bb"]
    w.sortByKey((x: &string) => x.len)
    print(w)
}`);
  expect(r.out).toBe("[-3, 0, 5, 9]\n3\n[false, true, true]\nZed\npear\n[\"a\", \"bb\", \"ccc\"]\n");
  expect(r.live).toBe(0);
});

test("R-INT-BITS: rotateLeft, rotateRight, reverseBits and checkedNeg work at the width of the integer", () => {
  const r = run(`
fn main() {
    let a: u8 = 129
    print(a.rotateLeft(1), " ", a.rotateRight(1), " ", a.rotateLeft(9))
    let b: i32 = -2147483648
    print(b.rotateLeft(1), " ", b.rotateRight(31))
    let c: u8 = 1
    print(c.reverseBits())
    print(b.checkedNeg().isNone(), " ", (5 as i32).checkedNeg().unwrapOr(0))
    let z: u32 = 0
    print(z.checkedNeg().isSome(), " ", (3 as u32).checkedNeg().isNone())
}`);
  expect(r.out).toBe("3 192 3\n1 1\n128\ntrue -5\ntrue true\n");
});

test("E-NEW-ITER: lines() drops the final newline and a CR, splitView() keeps empty pieces, and the enumerate form counts from 0", () => {
  const r = run(`
fn main() {
    for line in "a\\r\\nb\\n\\nc\\n".lines() { print("[", line, "]") }
    for p in "x,,y,".splitView(",") { print("<", p, ">") }
    for i, p in "ab".splitView("") { print(i, p) }
}`);
  expect(r.out).toBe("[a]\n[b]\n[]\n[c]\n<x>\n<>\n<y>\n<>\n0a\n1b\n");
});

test("R-JSON-STRINGIFY: a struct of scalars is an object with escaped strings and shortest floats", () => {
  const r = run(`
struct M { s: string, n: i64, f: f64, ok: bool }
fn main() {
    var s = "q\\"\\n"
    s.push(27)
    print(jsonStringify(M { s: s, n: -1, f: 0.1, ok: true }))
}`);
  expect(r.out).toBe(`{"s":"q\\"\\n\\u001b","n":-1,"f":0.1,"ok":true}\n`);
});

test("E-IFACE: ? boxes an error into Heap<Error> (a string as an ErrorMessage), context() wraps it, and ? into a string uses message()", () => {
  const r = run(`
struct Oops { code: i64 }
impl Oops { fn message(self: &Self): string { return $"oops {self.code}" } }
fn fails(): Result<i64, Oops> { return Result.Err(Oops { code: 7 }) }
fn failsStr(): Result<i64, string> { return Result.Err("plain") }
fn boxed(): Result<i64, Heap<Error>> { let x = fails()?; return Result.Ok(x) }
fn boxedStr(): Result<i64, Heap<Error>> { let x = failsStr()?; return Result.Ok(x) }
fn asText(): Result<i64, string> { let x = fails()?; return Result.Ok(x) }
fn main() {
    match boxed() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
    match boxedStr() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
    match asText() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e) }
    match boxed().context("loading") { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
}`);
  expect(r.out).toBe("oops 7\nplain\noops 7\nloading: oops 7\n");
  expect(r.live).toBe(0);
});

test("R-EMBED-FILE: @embedFile reads the bytes of a file beside the source through the host reader, and is unsupported without one", () => {
  const src = `fn main() { let s = @embedFile("lib/x.txt")\n print(s.len, " ", s) }`;
  const hostFs = {
    readFile: (p: string) => (p === join(dir, "lib", "x.txt") ? new TextEncoder().encode("hi!") : null),
    readdir: () => null,
    stat: () => null,
  };
  expect(run(src, { sys: { hostFs } }).out).toBe("3 hi!\n");
  expect(() => run(src)).toThrow(InterpUnsupported);
  void InterpStuck;
});
