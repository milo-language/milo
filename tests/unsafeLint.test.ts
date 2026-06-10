// Unit tests for the unused-unsafe lint. On by default for user code (imported
// std is exempt via userFnNames); denying here just makes assertions strict.
// The trap the prior attempt hit: marking must fire for ops nested in call
// args and inside impl-method bodies, not just top-level statements.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

function unusedUnsafeLines(src: string): number[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const res = new TypeChecker({ denied: new Set(["unused-unsafe"]), allowed: new Set() }).check(prog);
  return res.diagnostics
    .filter(d => d.code === "unused-unsafe")
    .map(d => d.span?.line ?? -1)
    .sort((a, b) => a - b);
}

test("flags a block whose only content needs no unsafe", () => {
  const src = `fn f(): i64 { unsafe { return 1 + 2 } }`;
  expect(unusedUnsafeLines(src)).toEqual([1]);
});

test("does not flag a cast-to-pointer nested in a call argument", () => {
  // munmap(self.ptr as *u8, ...) — the prior lint false-positived here because
  // the cast is buried inside a call arg, missed by a shallow statement walker.
  const src = `extern fn munmap(p: *u8, n: i64): i32
fn f(x: i64): i32 { unsafe { return munmap(x as *u8, 8) } }`;
  expect(unusedUnsafeLines(src)).toEqual([]);
});

test("does not flag pointer deref / address-of / pointer index", () => {
  const src = `fn deref(p: *i64): i64 { unsafe { return *p } }
fn addr(x: i64): i64 { unsafe { let p = &x return p as i64 } }
fn idx(p: *i64): i64 { unsafe { return p[3] } }`;
  expect(unusedUnsafeLines(src)).toEqual([]);
});

test("fires inside an impl-method body (the reverted attempt's blind spot)", () => {
  const src = `struct S { ptr: i64, n: i64 }
extern fn munmap(p: *u8, n: i64): i32
impl S {
  fn freeIt(self: &Self): i32 { unsafe { return munmap(self.ptr as *u8, self.n) } }
  fn noop(self: &Self): i64 { unsafe { return self.n + 1 } }
}
fn main(): i32 { return 0 }`;
  // line 4 (freeIt) has a real ptr cast -> kept; line 5 (noop) is redundant -> flagged.
  expect(unusedUnsafeLines(src)).toEqual([5]);
});
