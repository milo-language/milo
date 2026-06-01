// Tests for WCET flow-fact extraction (loop iteration bounds for OTAWA).
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { extractFlowFacts, formatFlowFacts } from "../src/wcet";

function bounds(src: string) {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  return extractFlowFacts(prog, "test.milo").bounds;
}

test("literal for-in range gives an exact count (B-A, exclusive end)", () => {
  const b = bounds(`fn f(): i32 { var t: i32 = 0 for i in 0..10 { t = t + i } return t }`);
  expect(b.length).toBe(1);
  expect(b[0].kind).toBe("exact");
  expect(b[0].count).toBe(10);
});

test("for-in range with nonzero start counts the span", () => {
  const b = bounds(`fn f(): i32 { var t: i32 = 0 for i in 3..13 { t = t + i } return t }`);
  expect(b[0].kind).toBe("exact");
  expect(b[0].count).toBe(10);
});

test("while i < N gives an upper bound of N", () => {
  const b = bounds(`fn f(): i32 { var j: i32 = 0 while j < 5 invariant j >= 0 { j = j + 1 } return j }`);
  expect(b[0].kind).toBe("max");
  expect(b[0].count).toBe(5);
});

test("while i <= N gives an upper bound of N+1", () => {
  const b = bounds(`fn f(): i32 { var j: i32 = 0 while j <= 5 invariant j >= 0 { j = j + 1 } return j }`);
  expect(b[0].kind).toBe("max");
  expect(b[0].count).toBe(6);
});

test("non-literal loop bound is reported unresolved, not silently dropped", () => {
  const b = bounds(`fn f(n: i32): i32 { var t: i32 = 0 for i in 0..n { t = t + i } return t }`);
  expect(b.length).toBe(1);
  expect(b[0].kind).toBe("unresolved");
  expect(b[0].count).toBe(null);
});

test("nested loops are all extracted", () => {
  const b = bounds(`fn f(): i32 {
    var t: i32 = 0
    for i in 0..4 { for j in 0..8 { t = t + 1 } }
    return t
  }`);
  expect(b.length).toBe(2);
  expect(b.map(x => x.count).sort((a, c) => (a ?? 0) - (c ?? 0))).toEqual([4, 8]);
});

test("formatted output is OTAWA-style and keys by source line", () => {
  const prog = new Parser(new Lexer(`fn f(): i32 { var t: i32 = 0 for i in 0..10 { t = t + 1 } return t }`).tokenize(), "x").parse();
  const out = formatFlowFacts(extractFlowFacts(prog, "prog.milo"));
  expect(out).toContain(`loop SOURCE "prog.milo" LINE`);
  expect(out).toContain("COUNT 10");
});
