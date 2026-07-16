// Unit tests for safety-profile constraints that the type-checker can't express
// as fixtures (call-graph depth, recursive-type detection, integer-only).
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { checkSafetyCompliance, type SafetyLevel } from "../src/safety";

function violations(src: string, level: SafetyLevel) {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  return checkSafetyCompliance(prog, level);
}
function rules(src: string, level: SafetyLevel): string[] {
  return [...new Set(violations(src, level).map(v => v.rule))];
}

// ── noFloatingPoint ──

test("noFloatingPoint flags float at iec61508-4", () => {
  const src = `fn scale(x: f64): f64 requires x >= 0.0 ensures result >= 0.0 { return x * 2.0 }`;
  expect(rules(src, "iec61508-4")).toContain("no-floating-point");
});

test("noFloatingPoint allows float at do178c-a (profile permits it)", () => {
  const src = `fn scale(x: f64): f64 requires x >= 0.0 ensures result >= 0.0 { return x * 2.0 }`;
  expect(rules(src, "do178c-a")).not.toContain("no-floating-point");
});

test("noFloatingPoint catches float cast and local", () => {
  const src = `fn f(n: i32): i32 requires n >= 0 ensures result >= 0 { let y: f32 = 1.0 return n }`;
  expect(rules(src, "iec61508-4")).toContain("no-floating-point");
});

// ── noRecursiveTypes ──
// Heap<Node> passes the type-checker (it's the sanctioned indirection) but is
// still banned at recursive-type-free levels because traversal depth is unbounded.

test("noRecursiveTypes flags Heap-indirect self reference", () => {
  const src = `struct Node { value: i32, next: Heap<Node> }
fn main(): i32 { return 0 }`;
  const vs = violations(src, "do178c-a").filter(v => v.rule === "no-recursive-types");
  expect(vs.length).toBeGreaterThan(0);
  expect(vs[0].message).toContain("Node");
});

test("noRecursiveTypes flags mutual recursion", () => {
  const src = `struct A { b: Heap<B> }
struct B { a: Heap<A> }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-recursive-types");
});

test("noRecursiveTypes passes non-recursive types", () => {
  const src = `struct Point { x: i32, y: i32 }
struct Line { a: Point, b: Point }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).not.toContain("no-recursive-types");
});

// ── maxCallDepth ──

function chain(n: number): string {
  // f0 -> f1 -> ... -> f(n-1); depth = n. do178c-a caps at 30.
  let s = "";
  for (let i = 0; i < n; i++) {
    const call = i < n - 1 ? `return f${i + 1}()` : `return 0`;
    s += `fn f${i}(): i32 ensures result >= 0 { ${call} }\n`;
  }
  return s + `fn main(): i32 { return f0() }\n`;
}

test("maxCallDepth passes a chain within the limit", () => {
  expect(rules(chain(10), "do178c-a")).not.toContain("max-call-depth");
});

test("maxCallDepth flags a chain exceeding the limit", () => {
  // depth 32 (f0..f31) + main = exceeds do178c-a's 30
  expect(rules(chain(32), "do178c-a")).toContain("max-call-depth");
});

// ── cyclomatic complexity counts && / || (McCabe decision points) ──

test("complexity counts && / || short-circuits over the bound", () => {
  const conds = Array.from({ length: 20 }, (_, i) => `a${i} > 0`).join(" && ");
  const params = Array.from({ length: 20 }, (_, i) => `a${i}: i32`).join(", ");
  const src = `fn classify(${params}): i32 { if ${conds} { return 1 } return 0 }`;
  // 20 '&&' + base 1 = complexity 21, over do178c-a's max of 20
  expect(rules(src, "do178c-a")).toContain("max-complexity");
});

test("complexity stays under bound for a simple boolean function", () => {
  const src = `fn simple(a: i32, b: i32): i32 { if a > 0 && b > 0 { return 1 } return 0 }`;
  expect(rules(src, "do178c-a")).not.toContain("max-complexity");
});

// ── noRecursion: direct AND mutual recursion (call-graph cycles) ──

test("noRecursion flags direct recursion", () => {
  const src = `fn fact(n: i32): i32 requires n >= 0 ensures result >= 0 { if n <= 1 { return 1 } return n * fact(n - 1) }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-c")).toContain("no-recursion");
});

test("noRecursion flags mutual recursion under a profile with no call-depth bound (do178c-c)", () => {
  const src = `fn isEven(n: i32): bool requires n >= 0 ensures true { if n == 0 { return true } return isOdd(n - 1) }
fn isOdd(n: i32): bool requires n >= 0 ensures true { if n == 0 { return false } return isEven(n - 1) }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-c")).toContain("no-recursion");
});

test("noRecursion allows a non-recursive call graph", () => {
  const src = `fn add(a: i32, b: i32): i32 requires true ensures true { return a + b }
fn use(): i32 requires true ensures true { return add(1, 2) }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-c")).not.toContain("no-recursion");
});

// ── enforcement must reach every control structure, not just if/while ──

test("noDynamicAllocation catches Vec.new (an EnumLit constructor)", () => {
  const src = `fn f(): i32 requires true ensures true { let v: Vec<i64> = Vec.new() return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-dynamic-alloc");
});

test("noDynamicAllocation catches allocation inside a for-loop body", () => {
  const src = `fn f(): i32 requires true ensures true { for i in 0..3 { let v: Vec<i64> = Vec.new() } return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-dynamic-alloc");
});

test("noUnsafe catches an unsafe block hidden in a for-loop", () => {
  const src = `fn f(): i32 requires true ensures true { for i in 0..3 { unsafe { let x = 1 } } return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-unsafe");
});

// if/match as EXPRESSIONS carry Stmt[] bodies, distinct from IfStmt/MatchStmt. The walker
// silently skipped all of them (its IsExpr/IfExpr arms named fields that don't exist, and
// MatchExpr had no arm at all), so a float or an allocation inside one was invisible to
// every profile — a false "passed" on the check that certification depends on.
test("noFloatingPoint catches a float in an if-expression branch", () => {
  const src = `fn f(c: bool): i32 requires true ensures result >= 0 { let y = if c { 1.5 } else { 2.5 } return 0 }`;
  expect(rules(src, "iec61508-4")).toContain("no-floating-point");
});

test("noFloatingPoint catches a float in a match-expression arm", () => {
  const src = `fn g(n: i32): i32 requires n >= 0 ensures result >= 0 { let y = match n { 0 => 1.5, _ => 2.5 } return 0 }`;
  expect(rules(src, "iec61508-4")).toContain("no-floating-point");
});

test("noDynamicAllocation catches allocation in an if-expression branch", () => {
  const src = `fn f(c: bool): i32 requires true ensures true { let v = if c { Vec.new() } else { Vec.new() } return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-dynamic-alloc");
});

test("noDynamicAllocation catches allocation in a match-expression arm", () => {
  const src = `fn f(n: i32): i32 requires n >= 0 ensures true { let v = match n { 0 => Vec.new(), _ => Vec.new() } return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-dynamic-alloc");
});

test("noFloatingPoint catches a float in an `is` operand", () => {
  const src = `fn f(n: i32): i32 requires n >= 0 ensures result >= 0 { let b = mk(1.5) is Maybe.Just return 0 }`;
  expect(rules(src, "iec61508-4")).toContain("no-floating-point");
});

test("boundedLoops catches a while-loop nested inside a for-loop", () => {
  const src = `fn f(n: i32): i32 requires n >= 0 ensures result >= 0 { for i in 0..3 { var j = 0 while j < n { j = j + 1 } } return 0 }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("bounded-loops");
});

// ── noForeignCalls: unverified extern/FFI banned at catastrophic levels ──

test("noForeignCalls flags a call to an extern function at do178c-a", () => {
  const src = `extern fn write(fd: i32, buf: * u8, n: i64): i64
fn emit(p: * u8): i64 requires true ensures true { return write(1, p, 10) }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-foreign-calls");
});

test("noForeignCalls is not enforced at do178c-c (FFI permitted there)", () => {
  const src = `extern fn write(fd: i32, buf: * u8, n: i64): i64
fn emit(p: * u8): i64 { return write(1, p, 10) }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-c")).not.toContain("no-foreign-calls");
});

test("noForeignCalls passes a program with no extern calls", () => {
  const src = `fn add(a: i32, b: i32): i32 requires true ensures true { return a + b }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).not.toContain("no-foreign-calls");
});

// ── impl methods are subject to the same constraints as free functions ──

test("safety checks cover impl methods (recursion)", () => {
  const src = `struct C { n: i32 }
impl C { fn down(self: &Self, k: i32): i32 requires true ensures true { if k <= 0 { return 0 } return self.down(k - 1) } }
fn main(): i32 { return 0 }`;
  expect(rules(src, "do178c-a")).toContain("no-recursion");
});

test("safety checks cover impl methods (unsafe + dynamic allocation)", () => {
  const src = `struct W { n: i32 }
impl W { fn bad(self: &Self): i32 requires true ensures true { let v: Vec<i64> = Vec.new() unsafe { let x = 1 } return 0 } }
fn main(): i32 { return 0 }`;
  const rs = rules(src, "do178c-a");
  expect(rs).toContain("no-dynamic-alloc");
  expect(rs).toContain("no-unsafe");
});

test("a clean impl method passes", () => {
  const src = `struct A { n: i32 }
impl A { fn get(self: &Self): i32 requires true ensures true { return self.n } }
fn main(): i32 { return 0 }`;
  const rs = rules(src, "do178c-a");
  expect(rs).not.toContain("no-recursion");
  expect(rs).not.toContain("no-unsafe");
});
