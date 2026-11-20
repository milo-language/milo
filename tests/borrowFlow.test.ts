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

// Pointer loans: a binding that holds `v.ptr()` keeps a loan on `v`'s buffer while it is read later.
const PTR = `from "std/os" import {\n    strlen\n}\nfn main(): i32 {\n    var v: Vec<u8> = Vec.new()\n    v.push(0)\n`;

test("push while a pointer into the buffer is read later is a conflict", () => {
  expect(flow(`${PTR}    let p = v.ptr()\n    v.push(1)\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["8: 'v' may reallocate here while 'p' still points into its buffer (from 'v.ptr()' on line 7)"]);
});

test("an index write and a reassignment under a live pointer name their own wording", () => {
  expect(flow(`${PTR}    let p = v.ptr()\n    v[0] = 65\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["8: 'v' is written here while 'p' still points into its buffer (from 'v.ptr()' on line 7)"]);
  expect(flow(`${PTR}    let p = v.ptr()\n    v = Vec.new()\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["8: 'v' is reassigned here while 'p' still points into its buffer (from 'v.ptr()' on line 7)"]);
});

test("push after the pointer's last use is fine (NLL), and so is a write inside unsafe", () => {
  expect(flow(`${PTR}    let p = v.ptr()\n    print(strlen(p))\n    v.push(1)\n    return 0\n}`)).toEqual([]);
  expect(flow(`${PTR}    let p = v.ptr()\n    unsafe {\n        v.push(1)\n    }\n    print(strlen(p))\n    return 0\n}`)).toEqual([]);
});

test("moving the source is allowed and ends the pointer's loan; a let move hands it to the new owner", () => {
  expect(flow(`fn take(v: Vec<u8>) {}\n${PTR}    let p = v.ptr()\n    take(v)\n    print(strlen(p))\n    return 0\n}`)).toEqual([]);
  expect(flow(`${PTR}    let p = v.ptr()\n    var w = v\n    w.push(1)\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["9: 'w' may reallocate here while 'p' still points into its buffer (from 'v.ptr()' on line 7)"]);
});

test("a container that was pushed the pointer holds the loan", () => {
  expect(flow(`${PTR}    var ps: Vec<*u8> = []\n    ps.push(v.ptr())\n    v.push(1)\n    print(strlen(ps[0]))\n    return 0\n}`))
    .toEqual(["9: 'v' may reallocate here while 'ps' still points into its buffer (from 'v.ptr()' on line 8)"]);
});

// Capture writes: a closure holds no loan of what it captures (the checker accepts writes around a bound closure), but calling or
// passing one whose body writes a capture is a write of it, judged against the loans others hold.
const CLR = `    var v: Vec<i64> = Vec.new()\n    v.push(1)\n    let clr = (): void => {\n        v = Vec.new()\n    }\n`;
const RUN = `fn run(f: () => void): void { f() }\n`;

test("calling a closure that rewrites the vec inside a for-in over it is a conflict", () => {
  expect(flow(`fn main(): i32 {\n${CLR}    for x in v {\n        clr()\n        print(x)\n    }\n    return 0\n}`))
    .toEqual(["8: cannot write to 'v' by calling 'clr' while a loop iterates over 'v'"]);
});

test("calling it while a view is read later is a conflict; calling it after the view's last use is fine", () => {
  expect(flow(`fn main(): i32 {\n${CLR}    let w = v[0..1]\n    clr()\n    print(w[0])\n    return 0\n}`))
    .toEqual(["8: cannot write to 'v' by calling 'clr' while 'w' borrows 'v'"]);
  expect(flow(`fn main(): i32 {\n${CLR}    let w = v[0..1]\n    print(w[0])\n    clr()\n    return 0\n}`)).toEqual([]);
});

test("handing the closure on counts as the write, at the argument", () => {
  expect(flow(`${RUN}fn main(): i32 {\n${CLR}    let w = v[0..1]\n    run(clr)\n    print(w[0])\n    return 0\n}`))
    .toEqual(["9: cannot write to 'v' by passing 'clr' while 'w' borrows 'v'"]);
});

test("a closure that only reads a capture does not stop writes to it, and one called through another closure still writes", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    let n = (): i64 => v.len\n    v.push(2)\n    print(n())\n    return 0\n}`)).toEqual([]);
  expect(flow(`fn main(): i32 {\n${CLR}    let g = (): void => {\n        clr()\n    }\n    let w = v[0..1]\n    g()\n    print(w[0])\n    return 0\n}`))
    .toEqual(["11: cannot write to 'v' by calling 'g' while 'w' borrows 'v'"]);
});

test("an if-let payload that borrows the subject conflicts with a closure write of it while read later", () => {
  const head = `enum Slot {\n    Full(string),\n    Empty,\n}\nstruct Box1 {\n    s: Slot,\n}\nfn main(): i32 {\n    var b = Box1 { s: Slot.Full("a heap string long enough to be on the heap".clone()) }\n    let wipe = (): void => {\n        b.s = Slot.Empty\n    }\n`;
  expect(flow(`${head}    if let Slot.Full(x) = b.s {\n        wipe()\n        print(x)\n    }\n    return 0\n}`))
    .toEqual(["14: cannot write to 'b' by calling 'wipe' while 'x' borrows 'b'"]);
  expect(flow(`${head}    if let Slot.Full(x) = b.s {\n        print(x)\n        wipe()\n    }\n    return 0\n}`)).toEqual([]);
});

// Callback loans: the receiver of a builtin collection method is loaned to the callback literal's body.
test("push on the receiver inside an each callback is a conflict that names the method", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    v.each((x: &i64) => {\n        v.push(1)\n    })\n    return 0\n}`))
    .toEqual(["5: cannot call 'push' on 'v' while 'v.each' borrows it"]);
});

test("a HashMap modify callback that inserts into the map is a conflict", () => {
  expect(flow(`fn main(): i32 {\n    var m: HashMap<string, i64> = HashMap.new()\n    m.insert("a", 1)\n    m.modify("a", (x: &mut i64): void => {\n        m.insert("b", 2)\n    })\n    return 0\n}`))
    .toEqual(["5: cannot call 'insert' on 'm' while 'm.modify' borrows it"]);
});

test("the same write after the call, or an element write inside the callback, is fine (the loan is the callback's body)", () => {
  expect(flow(`fn main(): i32 {\n${VEC}    v.each((x: &i64) => {\n        print(x)\n    })\n    v.push(1)\n    return 0\n}`)).toEqual([]);
  expect(flow(`fn main(): i32 {\n${VEC}    v.each((x: &i64) => {\n        v[0] = 2\n    })\n    return 0\n}`)).toEqual([]);
});

// Places handed to a `&mut` parameter, or to swap / replace, are writes of the place.
const GROW = `fn grow(v: &mut Vec<i64>): void {\n    v.push(1)\n}\n`;
test("passing the iterated vec to a &mut parameter in its loop is a conflict", () => {
  expect(flow(`${GROW}fn main(): i32 {\n${VEC}    for x in v {\n        grow(&mut v)\n    }\n    return 0\n}`))
    .toEqual(["8: cannot pass 'v' while a loop iterates over it"]);
});

test("passing the vec to a &mut parameter after the loop or after the view's last use is fine", () => {
  expect(flow(`${GROW}fn main(): i32 {\n${VEC}    for x in v {\n        print(x)\n    }\n    grow(&mut v)\n    return 0\n}`)).toEqual([]);
  expect(flow(`${GROW}fn main(): i32 {\n${VEC}    let w = v[0..1]\n    print(w[0])\n    grow(&mut v)\n    return 0\n}`)).toEqual([]);
});

test("swap and replace of a viewed or iterated place are conflicts", () => {
  expect(flow(`fn main(): i32 {\n    var s = "hello world".clone()\n    var t = "x".clone()\n    let w = s[0..5]\n    swap(s, t)\n    print(w)\n    return 0\n}`))
    .toEqual(["5: cannot swap 's' while 'w' borrows it"]);
  expect(flow(`fn main(): i32 {\n${VEC}    for x in v {\n        let old = replace(v, [])\n        print(old.len)\n    }\n    return 0\n}`))
    .toEqual(["5: cannot replace 'v' while a loop iterates over it"]);
});

test("swap before a view is taken, or after its last use, is fine", () => {
  expect(flow(`fn main(): i32 {\n    var s = "hello world".clone()\n    var t = "x".clone()\n    swap(s, t)\n    let w = s[0..1]\n    print(w)\n    return 0\n}`)).toEqual([]);
  expect(flow(`fn main(): i32 {\n    var s = "hello world".clone()\n    var t = "x".clone()\n    let w = s[0..5]\n    print(w)\n    swap(s, t)\n    return 0\n}`)).toEqual([]);
});

// Borrows the checker records without a holder (a match arm's payload, a lines() loop) read "because it is borrowed".
const NODE = `enum Node { Pair(string, i64), Empty }\n`;
test("reassigning a match subject while an arm's payload is read later is a holder-less conflict", () => {
  expect(flow(`${NODE}fn clobber(n: &mut Node): void {\n    match n {\n        Node.Pair(s, k) => {\n            n = Node.Empty\n            print(s)\n        }\n        Node.Empty => {}\n    }\n}\nfn main(): i32 {\n    return 0\n}`))
    .toEqual(["5: cannot assign to 'n' because it is borrowed"]);
  expect(flow(`${NODE}fn clobber(n: &mut Node): void {\n    match n {\n        Node.Pair(s, k) => {\n            print(s)\n            n = Node.Empty\n        }\n        Node.Empty => {}\n    }\n}\nfn main(): i32 {\n    return 0\n}`)).toEqual([]);
});

test("push on a string inside a lines() loop is a holder-less conflict; after the loop it is fine", () => {
  expect(flow(`fn main(): i32 {\n    var t: string = "a\\nb"\n    for line in t.lines() {\n        t.push(67)\n        print(line)\n    }\n    return 0\n}`))
    .toEqual(["4: cannot call 'push' on 't' because it is borrowed"]);
  expect(flow(`fn main(): i32 {\n    var t: string = "a\\nb"\n    for line in t.lines() {\n        print(line)\n    }\n    t.push(67)\n    return 0\n}`)).toEqual([]);
});

test("a closure body that writes a capture while another capture views it is a holder-less conflict", () => {
  const head = `struct Holder {\n    o: Option<string>,\n}\nfn apply(f: () => i64): i64 {\n    return f()\n}\nfn via(h: &mut Holder): i64 {\n    match h.o {\n        Option.Some(s) => {\n            return apply((): i64 => {\n`;
  const tail = `            })\n        }\n        Option.None => {\n            return 0\n        }\n    }\n}\nfn main(): i32 {\n    return 0\n}`;
  expect(flow(`${head}                h.o = Option.None\n                print(s)\n                return s.len\n${tail}`)).toEqual(["11: cannot assign to 'h.o' because 'h' is borrowed"]);
  expect(flow(`${head}                print(s)\n                h.o = Option.None\n                return 0\n${tail}`)).toEqual([]);
});

// Loans into a global's buffer: a call that parks the task while a slice or pointer of the global is held.
const PARK_HEAD = `from "std/os" import {\n    strlen\n}\nfrom "std/runtime" import {\n    schedulerYield\n}\nvar g: Vec<i64> = []\nvar b: Vec<u8> = []\n\n`;
test("a park while a slice of a global is read later is a conflict; after its last use it is fine", () => {
  expect(flow(`${PARK_HEAD}pub fn main(): i32 {\n    g.push(1)\n    let s = g[0..1]\n    schedulerYield()\n    print(s[0])\n    return 0\n}`))
    .toEqual(["13: 'schedulerYield' can park this task while 's' borrows from 'g's buffer; another task may push to 'g' before it resumes"]);
  expect(flow(`${PARK_HEAD}pub fn main(): i32 {\n    g.push(1)\n    let s = g[0..1]\n    print(s[0])\n    schedulerYield()\n    return 0\n}`)).toEqual([]);
});

test("a park while a raw pointer into a global is read later names where the pointer came from", () => {
  expect(flow(`${PARK_HEAD}pub fn main(): i32 {\n    b.push(0)\n    let p = b.ptr()\n    schedulerYield()\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["13: 'schedulerYield' can park this task while 'p' still points into 'b's buffer (from 'b.ptr()' on line 12); another task may push to 'b' before it resumes"]);
  expect(flow(`${PARK_HEAD}pub fn main(): i32 {\n    b.push(0)\n    let p = b.ptr()\n    print(strlen(p))\n    schedulerYield()\n    return 0\n}`)).toEqual([]);
});

test("a callee that pushes to a global while a pointer or slice of it is read later is a conflict; after the last use it is fine", () => {
  const head = `from "std/os" import {\n    strlen\n}\nvar g: Vec<u8> = []\n\nfn writer() {\n    g.push(65)\n}\n\npub fn main(): i32 {\n    g.push(0)\n`;
  expect(flow(`${head}    let p = g.ptr()\n    writer()\n    print(strlen(p))\n    return 0\n}`))
    .toEqual(["13: 'writer' writes the global 'g' while 'p' still points into 'g's buffer (from 'g.ptr()' on line 12)"]);
  expect(flow(`${head}    let s = g[0..1]\n    writer()\n    print(s[0])\n    return 0\n}`))
    .toEqual(["13: 'writer' writes the global 'g' while 's' borrows from 'g's buffer"]);
  expect(flow(`${head}    let s = g[0..1]\n    print(s[0])\n    writer()\n    return 0\n}`)).toEqual([]);
});

const H = `struct H { items: Vec<i64>, other: Vec<i64> }\nstruct A { h: H }\n`;

test("moving a field out while a view of it is read later is a conflict", () => {
  expect(flow(`${H}fn main(): i32 {\n    let h = H { items: [7, 9], other: [1] }\n    let s = h.items[0..1]\n    var w = h.items\n    w.push(9)\n    print(s[0])\n    return 0\n}`))
    .toEqual(["6: cannot move 'h.items' while 's' borrows 'h'"]);
});

test("moving a nested field out while a view of it is live is a conflict", () => {
  expect(flow(`${H}fn main(): i32 {\n    let a = A { h: H { items: [7, 9], other: [1] } }\n    let s = a.h.items[0..1]\n    var w = a.h.items\n    w.push(9)\n    print(s[0])\n    return 0\n}`))
    .toEqual(["6: cannot move 'a.h.items' while 's' borrows 'a'"]);
});

test("moving a field no view points into is fine, and so is moving it after the view's last use", () => {
  expect(flow(`${H}fn main(): i32 {\n    let h = H { items: [7, 9], other: [1] }\n    let s = h.other[0..1]\n    var w = h.items\n    w.push(9)\n    print(s[0])\n    return 0\n}`)).toEqual([]);
  expect(flow(`${H}fn main(): i32 {\n    let h = H { items: [7, 9], other: [1] }\n    let s = h.items[0..1]\n    print(s[0])\n    var w = h.items\n    w.push(9)\n    return 0\n}`)).toEqual([]);
});
