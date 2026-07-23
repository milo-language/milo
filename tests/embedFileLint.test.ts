// Unit tests for the bare-embedfile lint. ON by default: `embedFile("x")` reads
// like an ordinary function call, but it is compile-time-only — the argument must
// be a string literal and the file is inlined by the compiler. `@embedFile("x")`
// is the preferred spelling, matching the `@` Milo already uses for compiler-level
// constructs (@cLayout, @cSig, @link). The bare form still compiles.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-embedfile-lint-"));
writeFileSync(join(dir, "data.txt"), "payload\n");

function lint(src: string, cfg = { denied: new Set<string>(), allowed: new Set<string>() }) {
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  return new TypeChecker(cfg).check(prog).diagnostics.filter(d => d.code === "bare-embedfile");
}

const BARE = `fn main(): i32 {\n    let s = embedFile("data.txt")\n    print(s)\n    return 0\n}\n`;
const SIGIL = `fn main(): i32 {\n    let s = @embedFile("data.txt")\n    print(s)\n    return 0\n}\n`;

test("warns by default on the bare embedFile spelling", () => {
  const out = lint(BARE);
  expect(out.length).toBe(1);
  expect(out[0].severity).toBe("warning");
  expect(out[0].message).toContain("@embedFile");
  // caret must cover exactly the `embedFile` token so the quickfix can insert '@'
  expect(out[0].len).toBe("embedFile".length);
  expect(out[0].span?.line).toBe(2);
  expect(out[0].span?.col).toBe(13);
});

test("does not warn on @embedFile", () => {
  expect(lint(SIGIL)).toEqual([]);
});

test("--allow=bare-embedfile suppresses it", () => {
  expect(lint(BARE, { denied: new Set<string>(), allowed: new Set(["bare-embedfile"]) })).toEqual([]);
});

test("--deny=bare-embedfile promotes it to an error", () => {
  const out = lint(BARE, { denied: new Set(["bare-embedfile"]), allowed: new Set<string>() });
  expect(out.length).toBe(1);
  expect(out[0].severity).toBe("error");
});

test("--deny-all promotes it to an error", () => {
  const out = lint(BARE, { denied: new Set(["*"]), allowed: new Set<string>() });
  expect(out[0]?.severity).toBe("error");
});

test("both spellings type-check to string and take the same argument rules", () => {
  const bad = `fn main(): i32 {\n    let p = "data.txt"\n    let s = @embedFile(p)\n    print(s)\n    return 0\n}\n`;
  const entry = join(dir, "bad.milo");
  writeFileSync(entry, bad);
  const prog = new Parser(new Lexer(bad).tokenize(), bad, entry).parse();
  const diags = new TypeChecker().check(prog).diagnostics;
  expect(diags.some(d => d.severity === "error" && d.message.includes("must be a string literal"))).toBe(true);
});

test("@ must hug the builtin name and the name must be known", () => {
  const parse = (src: string) => new Parser(new Lexer(src).tokenize(), src, "x.milo").parse();
  expect(() => parse(`fn main() { let s = @ embedFile("data.txt") }`)).toThrow(/no whitespace allowed/);
  expect(() => parse(`fn main() { let s = @nope("data.txt") }`)).toThrow(/unknown compile-time builtin/);
});
