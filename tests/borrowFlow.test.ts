// src/borrow-flow.ts: view and loop loans as dataflow, shadow mode. Each case calls borrowFlow directly.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { borrowFlow } from "../src/borrow-flow";

// The flow's messages for the program's own file, with the line they point at.
function flow(src: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "borrowflow-"));
  const path = join(dir, "b.milo");
  writeFileSync(path, src);
  const program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dir, getHostTarget(), path);
  const tc = new TypeChecker();
  const cr = tc.check(program);
  return borrowFlow(program, cr, tc).diagnostics
    .filter(d => d.span?.file === undefined || d.span.file === path)
    .map(d => `${d.span?.line}: ${d.message}`);
}

const VEC = `    var v: Vec<i64> = Vec.new()\n    v.push(1)\n`;

test("push while a view let is read later is a conflict", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    let w = v[0..1]\n    v.push(2)\n    print(w[0])\n    return 0\n}`))
    .toEqual(["5: cannot call 'push' on 'v' while 'w' borrows it"]);
});

test("push after the view's last use is fine (the borrow ends where the holder dies)", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    let w = v[0..1]\n    print(w[0])\n    v.push(2)\n    return 0\n}`)).toEqual([]);
});

test("push inside a for-in over the vec is a loop conflict", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    for x in v {\n        v.push(x)\n    }\n    return 0\n}`))
    .toEqual(["5: cannot call 'push' on 'v' while a loop iterates over it"]);
});

test("push after the loop is fine", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    for x in v {\n        print(x)\n    }\n    v.push(2)\n    return 0\n}`)).toEqual([]);
});

test("an element write inside a for-in over the vec is a loop conflict", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    for x in v {\n        v[0] = x\n    }\n    return 0\n}`))
    .toEqual(["5: cannot assign to 'v[...]' because 'v' is being iterated"]);
});

test("an element write while a view let is live is fine: it never reallocates", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    let w = v[0..1]\n    v[0] = 5\n    print(w[0])\n    return 0\n}`)).toEqual([]);
});

test("moving the vec while a view is read later is a conflict", () => {
  expect(flow(`fn take(v: Vec<i64>) {}\nfn main(): i32 {\n${VEC}    let w = v[0..1]\n    take(v)\n    print(w[0])\n    return 0\n}`))
    .toEqual(["6: cannot move 'v' while 'w' borrows it"]);
});

test("a view taken in one branch still conflicts with a push after the join when it is read later", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    var w = v[0..0]\n    if v.len > 0 {\n        w = v[0..1]\n    }\n    v.push(2)\n    print(w[0])\n    return 0\n}`))
    .toEqual(["8: cannot call 'push' on 'v' while 'w' borrows it"]);
});

test("a whole-vec assignment while a view is read later names the holder", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    let w = v[0..1]\n    v = Vec.new()\n    print(w[0])\n    return 0\n}`))
    .toEqual(["5: cannot assign to 'v' while 'w' borrows it"]);
});
