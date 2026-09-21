// Unit tests for the string-concat-in-loop lint (on by default since the example
// corpus reached zero sites): `out += piece` in a loop reallocates and copies the
// whole accumulator per iteration, and `pushStr` is the amortized form the idioms
// doc asks for. The compound form parses to `out = out + piece`, so both spellings hit.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-string-concat-lint-"));

function lint(body: string, cfg = { denied: new Set(["string-concat-in-loop"]), allowed: new Set<string>() }) {
  const src = `fn main() {\n    var out = ""\n    var n: i64 = 0\n${body}\n    print(out, n)\n}\n`;
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  return new TypeChecker(cfg).check(prog).diagnostics.filter(d => d.code === "string-concat-in-loop");
}

test("+= on a string inside a loop warns, with pushStr in the hint", () => {
  const ds = lint(`    for i in 0..3 {\n        out += "a"\n    }`);
  expect(ds).toHaveLength(1);
  expect(ds[0].message).toContain("'out' is rebuilt with '+'");
  expect(ds[0].hint).toContain("out.pushStr(...)");
});

test("the long form and a chain of + are the same shape", () => {
  expect(lint(`    while n < 3 {\n        out = out + "b" + "c"\n        n += 1\n    }`)).toHaveLength(1);
});

test("silent outside a loop, on integers, and when the accumulator is not the leftmost operand", () => {
  expect(lint(`    out += "a"`)).toHaveLength(0);
  expect(lint(`    for i in 0..3 {\n        n += 1\n    }`)).toHaveLength(0);
  expect(lint(`    for i in 0..3 {\n        out = "x" + out\n    }`)).toHaveLength(0);
});

test("on by default, and --allow silences it", () => {
  expect(lint(`    for i in 0..3 {\n        out += "a"\n    }`, { denied: new Set(), allowed: new Set() })).toHaveLength(1);
  expect(lint(`    for i in 0..3 {\n        out += "a"\n    }`, { denied: new Set(), allowed: new Set(["string-concat-in-loop"]) })).toHaveLength(0);
});
