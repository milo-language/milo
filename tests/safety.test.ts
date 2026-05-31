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
