// "You cannot move a non-Copy value out of a borrow" — checked across every way of
// SPELLING the place, and every position that consumes it.
//
// The companion file tests/aliasingMatrix.test.ts varies the container and the operation.
// This one varies how the place is NAMED and where the moved value goes, which is the axis
// the use-after-frees kept escaping along: `return d.a` was a hard error while
// `return if c { d.a } else { d.b }` compiled and double-freed, because no walker knew what
// an IfExpr was.
//
// Two answers are asserted, not one, because the language genuinely gives two:
//   * a FIELD path (including through a fork or an unwrap) is a hard error naming .clone()
//   * an INDEX path silently deep-clones instead
// That split is backlog Tier 1 #7 and is a filed design decision, not a bug. It is pinned
// here so that changing it shows up as a diff in this file rather than as a surprise, and
// so a NEW spelling cannot quietly pick whichever branch it happens to hit.
//
// `string` is the exception on every path: its heap buffer is reference counted, so a
// copy out of a borrow shares it by count and nothing is rejected. The matrix runs once
// with a type that still moves (`Vec<i64>`) and once with `string`.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

const dir = mkdtempSync(join(tmpdir(), "milo-moveout-"));
let n = 0;

function errorsFor(src: string): string[] {
  const entry = join(dir, `m${n++}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  return new TypeChecker().check(prog).diagnostics
    .filter(d => d.severity === "error").map(d => d.message);
}

const declsOf = (t: string) => `struct Inner { v: ${t} }
struct B { v: ${t}, i: Inner, arr: [${t}; 2], vec: Vec<${t}> }
`;
const DECLS = declsOf("string");

// How the value is reached from the borrowed `b`. `clones` records the language's current
// answer: an index step deep-copies instead of erroring.
const PATHS: { name: string; expr: string; clones: boolean }[] = [
  { name: "a field", expr: "b.v", clones: false },
  { name: "a nested field", expr: "b.i.v", clones: false },
  { name: "a fixed-array element", expr: "b.arr[0]", clones: true },
  { name: "a Vec element", expr: "b.vec[0]", clones: true },
  { name: "a fork of two fields", expr: "if c { b.v } else { b.i.v }", clones: false },
  { name: "a fork of two elements", expr: "if c { b.vec[0] } else { b.vec[1] }", clones: true },
  { name: "a fork mixing field and element", expr: "if c { b.v } else { b.vec[0] }", clones: false },
];

// Where the moved value ends up. Each of these consumes an owned `t`.
const SINKS: { name: string; wrap: (e: string, t: string) => string }[] = [
  { name: "returned", wrap: (e, t) => `fn f(b: &B, c: bool): ${t} {\n    return ${e}\n}` },
  { name: "bound to a local", wrap: e => `fn f(b: &B, c: bool): void {\n    let taken = ${e}\n    print(taken)\n}` },
  { name: "passed as an owned argument", wrap: (e, t) => `fn eat(s: ${t}): void { print(s) }\nfn f(b: &B, c: bool): void {\n    eat(${e})\n}` },
  { name: "stored in a struct literal", wrap: e => `fn f(b: &B, c: bool): Inner {\n    return Inner { v: ${e} }\n}` },
  { name: "pushed into a Vec", wrap: (e, t) => `fn f(b: &B, c: bool): void {\n    var out: Vec<${t}> = Vec.new()\n    out.push(${e})\n    print(out.len)\n}` },
];

describe("moving out of a borrow", () => {
  for (const p of PATHS) {
    for (const s of SINKS) {
      test(`${p.name}, ${s.name}`, () => {
        const errs = errorsFor(`${declsOf("Vec<i64>")}\n${s.wrap(p.expr, "Vec<i64>")}\n\nfn main() { print("x") }\n`);
        const rejected = errs.some(e => /cannot move/.test(e));
        // Anything OTHER than the move rule firing means the probe stopped testing what it
        // claims to (a syntax slip, a missing method), which would make a green row
        // meaningless.
        const unrelated = errs.filter(e => !/cannot move/.test(e));
        expect({ rejected, unrelated }).toEqual({ rejected: !p.clones, unrelated: [] });
      });
      test(`a string through ${p.name}, ${s.name}, is shared`, () => {
        expect(errorsFor(`${DECLS}\n${s.wrap(p.expr, "string")}\n\nfn main() { print("x") }\n`)).toEqual([]);
      });
    }
  }
});

// The rule is about the BORROW, so the identical spellings must all be legal when the root
// is owned. Without this the matrix above could be satisfied by a checker that simply
// rejects every field access.
describe("the same spellings out of an owned value are legal", () => {
  for (const p of PATHS) {
    test(p.name, () => {
      const src = `${DECLS}
fn f(c: bool): string {
    var b = B { v: "a", i: Inner { v: "b" }, arr: ["c", "d"], vec: Vec.new() }
    b.vec.push("e")
    b.vec.push("f")
    return ${p.expr}
}

fn main() { print(f(true)) }
`;
      expect(errorsFor(src)).toEqual([]);
    });
  }
});
