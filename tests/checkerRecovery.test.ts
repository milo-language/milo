// `checker.fatal()` stops the check at the point where the invariant the rest of
// the code needs is the one that just failed. It is only usable if error RECOVERY
// survives it: a compiler that reports the first mistake and quits makes you
// recompile once per typo. These tests pin the recovery boundaries — one per
// statement in a function body, one per declaration above that — so a later
// `fatal()` added somewhere hot can't silently collapse a run to one diagnostic.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

function errorsOf(src: string): string[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  return new TypeChecker()
    .check({ ...prog, entryFile: "test.milo" } as any)
    .diagnostics.filter(d => d.severity === "error")
    .map(d => d.message);
}

test("a fatal() in one statement does not swallow the next statement's error", () => {
  const errs = errorsOf(`struct Point {
    x: i64,
}

fn main() {
    var p = Point { x: 1 }
    alpha = 1
    p.nope = 2
    beta = 3
    3 = 4
    print(p.x)
}`);
  expect(errs.some(e => e.includes("undefined variable 'alpha'"))).toBe(true);
  expect(errs.some(e => e.includes("has no field 'nope'"))).toBe(true);
  expect(errs.some(e => e.includes("undefined variable 'beta'"))).toBe(true);
  expect(errs.some(e => e.includes("invalid assignment target"))).toBe(true);
});

test("a fatal() in one function does not swallow the next function's error", () => {
  const errs = errorsOf(`fn first() {
    missingA = 1
}

fn second() {
    missingB = 2
}

fn main() {
    first()
    second()
}`);
  expect(errs.some(e => e.includes("missingA"))).toBe(true);
  expect(errs.some(e => e.includes("missingB"))).toBe(true);
});

// The unwind jumps out of `pushScope`/`unsafe`/loop bodies mid-flight. If `recover`
// didn't rewind those stacks, the leftover depth would leak into the next function
// and change its answers — an `unsafe` op would stop needing a block, or a local
// from the abandoned scope would still resolve. Checked by putting the fatal inside
// all three at once and asserting the following function still checks normally.
// The assertions are all in the SAME function as the fatal, deliberately: a
// following function pushes its own scope floor, which hides a leaked scope by
// accident and would make this test pass without `recover` doing anything.
test("recovery rewinds scope, unsafe and loop depth", () => {
  const errs = errorsOf(`fn broken() {
    var i: i64 = 0
    while i < 3 {
        unsafe {
            let leaked = 1
            missingC = leaked
        }
        i = i + 1
    }
    print(leaked)
    let p = i.addrOf()
    break
}

fn main() {
    broken()
}`);
  expect(errs.some(e => e.includes("missingC"))).toBe(true);
  // `leaked` lived in the abandoned scope: still visible means scopes leaked.
  expect(errs.some(e => e.includes("undefined variable 'leaked'"))).toBe(true);
  // A leftover unsafeDepth would make this raw address-of legal outside `unsafe`.
  expect(errs.some(e => e.includes("requires 'unsafe' block"))).toBe(true);
  // A leftover loopDepth would make this `break` legal outside a loop.
  expect(errs.some(e => e.includes("'break' outside of loop"))).toBe(true);
});

// A parse error INSIDE a string interpolation used to carry the fragment sub-parser's
// own 1:col, which pointed at the first line of the file and a column past the end of
// it — the frontend fuzzer's "bad span" bucket. Successful sub-parses were already
// restamped to the f-string; the throwing path was not.
test("a parse error inside an interpolation is anchored at the f-string, not at 1:1", () => {
  const src = "fn main() {\n    let a = 1\n    print($\"x {a >} y\")\n}\n";
  let span: { line: number; col: number } | undefined;
  try {
    new Parser(new Lexer(src).tokenize(), src).parse();
  } catch (e) {
    span = (e as { diagnostic: { span?: { line: number; col: number } } }).diagnostic.span;
  }
  expect(span?.line).toBe(3);
  const lineLen = src.split("\n")[span!.line - 1]!.length;
  expect(span!.col).toBeLessThanOrEqual(lineLen);
});

// A binding initialized from an expression that failed is typed `unknown`, and
// `unknown` is not Copy, so every second use of it used to report "use of moved
// variable" on top of the real error; a method call on it reported "type '<unknown>'
// has no method". Both are about a type nobody knows. The real mistakes around it
// (a genuine use-after-move, an error inside the call's own arguments) must survive.
test("a binding whose initializer failed does not cascade ownership errors", () => {
  const errs = errorsOf(`struct V {
    x: f64,
}

impl V {
    fn make(x: f64): V {
        return V { x: x }
    }
}

fn scale(v: V, s: f64): V {
    return V { x: v.x * s }
}

fn main() {
    let n = V.make(1.0)
    let cosT = V.nope(1.0)
    let a = scale(n, cosT)
    let b = scale(a, cosT * 2.0)
    let c = cosT.len(missingArg)
    let s = "owned"
    let t = s
    print(s)
    print(b.x + cosT + c + cosT.field)
}`);
  expect(errs.filter(e => e.includes("has no static method 'nope'")).length).toBe(1);
  expect(errs.some(e => e.includes("'cosT'"))).toBe(false);
  expect(errs.some(e => e.includes("<unknown>"))).toBe(false);
  expect(errs.some(e => e.includes("undefined variable 'missingArg'"))).toBe(true);
  expect(errs.some(e => e.includes("use of moved variable 's'"))).toBe(true);
});
