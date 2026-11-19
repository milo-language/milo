// src/move-flow.ts: the dataflow move-or-share decision for strings (docs/plans/move-dataflow.md).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { moveFlow } from "../src/move-flow";

// Decisions for the program's own file, as "line:col decision", in source order.
function decide(src: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "moveflow-"));
  const path = join(dir, "m.milo");
  writeFileSync(path, src);
  const program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dir, getHostTarget(), path);
  const tc = new TypeChecker();
  const cr = tc.check(program);
  expect(cr.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  return [...moveFlow(program, cr, tc).stringDecisions]
    .filter(([e]) => e.span?.file === undefined || e.span.file === path)
    .map(([e, d]) => [e.span!.line, e.span!.col, d] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([l, c, d]) => `${l}:${c} ${d}`);
}

test("a string read again on the next iteration is shared, even when moved before the loop on an untaken path", () => {
  const d = decide(`struct Rec { name: string, tags: Vec<string> }
fn main(): i32 {
    let a: i64 = 1
    var v: Rec = Rec { name: $"{a}bc", tags: [] }
    if a > 1 {
        let old = replace(v, Rec { name: "z", tags: [v.name] })
    }
    var i: i64 = 0
    while i < 3 {
        i += 1
        let x: Vec<string> = [v.name, v.name]
        print(x.len)
    }
    return 0
}
`);
  // Line 6's v.name is followed by more reads through the loop, and both reads on line 11 are
  // followed by the next iteration's: every one is a share.
  expect(d).toEqual(["6:54 share", "11:31 share", "11:39 share"]);
});

test("the last read of a string moves; earlier ones share", () => {
  const d = decide(`fn take(s: string) {
    print(s)
}
fn main(): i32 {
    let n: i64 = 2
    let s = $"{n}x"
    take(s)
    take(s)
    return 0
}
`);
  expect(d).toEqual(["7:10 share", "8:10 move"]);
});

test("a path that ends in exit reads nothing after it", () => {
  const d = decide(`fn take(s: string) {
    print(s)
}
fn main(): i32 {
    let n: i64 = 2
    let s = $"{n}x"
    if n > 5 {
        take(s)
        exit(1)
    }
    take(s)
    return 0
}
`);
  expect(d).toEqual(["8:14 move", "11:10 move"]);
});
