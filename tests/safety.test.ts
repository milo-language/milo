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

// Statements nest inside `let .. else`, and the statement walker used to have no arm for
// it — so an `unsafe` block or a heap allocation in the else-body was never looked at and
// DO-178C DAL A reported "pass" on code that contained one. The `if-else` control is the
// point: the two bodies are the same code, and only the walker told them apart.
test("safety checks reach into a let-else else-body", () => {
  const body = `let v: Vec<i64> = Vec.new() unsafe { let x = 1 } return 0`;
  const src = `fn get(v: i64): Option<i64> requires true { if v > 0 { return Option.Some(v) } return Option.None }
fn viaIfElse(n: i64): i64 requires true ensures true { if n < 0 { ${body} } return n }
fn viaLetElse(n: i64): i64 requires true ensures true { let Option.Some(x) = get(n) else { ${body} } return x }
fn main(): i32 { return 0 }`;
  const perFn = (name: string) =>
    violations(src, "do178c-a").filter(v => v.message.includes(`'${name}'`)).map(v => v.rule);
  for (const rule of ["no-unsafe", "no-dynamic-alloc"]) {
    expect(perFn("viaIfElse")).toContain(rule);
    expect(perFn("viaLetElse")).toContain(rule);
  }
});

// The sibling walker to the one above had the same hole. Branches inside `let .. else` and
// `unsafe { }` counted as zero, so a function well over the DAL A bound measured as
// complexity 2 and passed. A rule that holds in one switch and not the next one over is
// not a rule — hence the never-guards, and tests/exhaustiveSwitchLint.test.ts.
test("cyclomatic complexity counts branches inside let-else and unsafe", () => {
  const branches = Array.from({ length: 25 }, (_, i) => `if n > ${i} { t = ${i} }`).join(" ");
  const src = `fn get(v: i64): Option<i64> requires true { if v > 0 { return Option.Some(v) } return Option.None }
fn viaIfElse(n: i64): i64 requires true ensures true { var t = 0 if n < 0 { ${branches} } return t }
fn viaLetElse(n: i64): i64 requires true ensures true { var t = 0 let Option.Some(x) = get(n) else { ${branches} return t } return x }
fn viaUnsafe(n: i64): i64 requires true ensures true { var t = 0 unsafe { ${branches} } return t }
fn main(): i32 { return 0 }`;
  const flagged = violations(src, "do178c-a")
    .filter(v => v.rule === "max-complexity")
    .map(v => v.message.match(/function '(\w+)'/)![1]);
  for (const fn of ["viaIfElse", "viaLetElse", "viaUnsafe"]) expect(flagged).toContain(fn);
});

// ── requireUsedResults ──
// The safety walker has no types, so the checker's `unused-result` findings are handed in;
// these pin which profiles turn them into errors. The finding itself is pinned in
// tests/mustUseLint.test.ts.

const DISCARDED = [{ message: "unused result of '@mustUse' function 'f'", span: { line: 3, col: 3 } }];
const TRIVIAL = `fn main(): i32 requires true ensures result == 0 { return 0 }`;

for (const level of ["do178c-a", "do178c-b", "do178c-c", "nasa-a", "nasa-b"] as const) {
  test(`requireUsedResults: a discarded result is an error at ${level}`, () => {
    const prog = new Parser(new Lexer(TRIVIAL).tokenize(), TRIVIAL).parse();
    const vs = checkSafetyCompliance(prog, level, DISCARDED).filter(v => v.rule === "unused-result");
    expect(vs).toHaveLength(1);
    expect(vs[0].severity).toBe("error");
    expect(vs[0].message).toBe(`[${level}] unused result of '@mustUse' function 'f'`);
    expect(vs[0].span).toEqual({ line: 3, col: 3 });
  });
}

for (const level of ["iso26262-a", "iso26262-d", "iec61508-4"] as const) {
  test(`requireUsedResults: a discarded result stays a warning at ${level}`, () => {
    const prog = new Parser(new Lexer(TRIVIAL).tokenize(), TRIVIAL).parse();
    expect(rules(TRIVIAL, level)).not.toContain("unused-result");
    expect(checkSafetyCompliance(prog, level, DISCARDED).filter(v => v.rule === "unused-result")).toHaveLength(0);
  });
}

// The checker's own Option finding (a discarded `a.get(h)`), not a `@mustUse` one, is
// escalated the same way: the rule keys on the warning, not on the attribute.
test("requireUsedResults: a discarded Option escalates to an error at do178c-a", () => {
  const prog = new Parser(new Lexer(TRIVIAL).tokenize(), TRIVIAL).parse();
  const finding = [{ message: "unused Option value — this may contain an error that should be handled", span: { line: 5, col: 3 } }];
  const vs = checkSafetyCompliance(prog, "do178c-a", finding).filter(v => v.rule === "unused-result");
  expect(vs).toHaveLength(1);
  expect(vs[0].severity).toBe("error");
  expect(vs[0].message).toBe("[do178c-a] unused Option value — this may contain an error that should be handled");
});
