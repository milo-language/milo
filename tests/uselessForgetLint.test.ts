// The useless-forget lint: `forget` on a Copy value. Fires on a value whose written type is
// Copy, never inside a generic instance, where `forget(v)` on a `T` is required by the
// source even when one instantiation makes T an i64 (std/sync Channel<T>.send did this).
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

function forgetLines(src: string): number[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(), allowed: new Set() }).check(prog);
  return res.diagnostics.filter(d => d.code === "useless-forget").map(d => d.span?.line ?? -1);
}

test("fires on a Copy value in plain code", () => {
  expect(forgetLines(`fn main(): i32 {
  let n: i64 = 3
  forget(n)
  return 0
}`)).toEqual([3]);
});

test("silent in a generic fn and a generic struct method instantiated with a Copy type", () => {
  expect(forgetLines(`fn drop1<T>(v: T) {
  forget(v)
}
struct Box1<T> { x: T }
impl Box1<T> {
  fn eat(self: &Self, v: T) {
    forget(v)
  }
}
fn main(): i32 {
  drop1(5)
  let b = Box1<i64> { x: 1 }
  b.eat(2)
  return 0
}`)).toEqual([]);
});
