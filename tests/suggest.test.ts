// Unit tests for "did you mean" hints. Two sources feed them: an alias table for
// names that exist here under a different spelling (`length`, `toUpperCase`,
// `forEach` are not typos, so edit distance can never find them), and edit distance
// against the receiver's real members for actual typos.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { closest, editDistance, memberHint, importHint, VEC_MEMBERS, STRING_MEMBERS } from "../src/suggest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-suggest-"));

// The first error's hint for a whole-program source, or undefined.
function hintFor(src: string): string | undefined {
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  const diags = new TypeChecker().check(prog).diagnostics.filter(d => d.severity === "error");
  return diags[0]?.hint;
}

function errorFor(src: string): string | undefined {
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  const diags = new TypeChecker().check(prog).diagnostics.filter(d => d.severity === "error");
  return diags[0]?.message;
}

test("edit distance bails out past the cap instead of scoring exactly", () => {
  expect(editDistance("abc", "abc", 2)).toBe(0);
  expect(editDistance("abc", "abd", 2)).toBe(1);
  // Beyond the cap the exact score doesn't matter, only that it exceeds it.
  expect(editDistance("abc", "xyzzy", 2)).toBeGreaterThan(2);
});

test("closest scales its threshold to the name's length", () => {
  // One edit is a lot in a 3-char name and little in a 15-char one.
  expect(closest("le", ["len"])).toBe("len");
  expect(closest("xyz", ["len"])).toBe(null);
  expect(closest("splitWhitespac", [...STRING_MEMBERS])).toBe("splitWhitespace");
});

test("a case-only difference always wins", () => {
  expect(closest("ToUpper", [...STRING_MEMBERS])).toBe("toUpper");
});

test("alias table catches cross-language spellings edit distance cannot", () => {
  expect(memberHint("length", ["len"])).toBe("did you mean 'len'?");
  expect(memberHint("toUpperCase", [...STRING_MEMBERS])).toBe("did you mean 'toUpper'?");
  expect(memberHint("forEach", [...VEC_MEMBERS])).toBe("did you mean 'each'?");
  expect(memberHint("push_back", [...VEC_MEMBERS])).toBe("did you mean 'push'?");
});

test("an alias whose target is not a member still names the Milo concept", () => {
  // `length` on a struct with no `len` should not claim a member that isn't there.
  expect(memberHint("length", ["name", "age"])).toBe("Milo spells this 'len'");
});

test("methods spelled as operators get their own hint, not a near-miss name", () => {
  expect(memberHint("unwrap", ["isSome", "map"])).toContain("'!'");
  expect(memberHint("equals", ["clone"])).toContain("'=='");
});

test("importHint names the std module that exports a type", () => {
  expect(importHint("Json")).toContain('from "std/json" import { Json }');
  expect(importHint("Router")).toContain('from "std/http" import { Router }');
  expect(importHint("NoSuchTypeAnywhere")).toBeUndefined();
});

test("the import line uses '/' separators on every host", () => {
  // The hint is a line the reader pastes into their source, and an import path is
  // always '/'-separated. `relative` hands back backslashes on Windows, which shipped
  // `from "std\json" import { Json }` and failed the Windows fixture lane.
  expect(importHint("Json")).not.toContain("\\");
});

test("hints reach the real diagnostics", () => {
  expect(hintFor(`fn main() {\n  let v: Vec<i64> = [1]\n  print(v.length)\n}\n`)).toBe("did you mean 'len'?");
  expect(hintFor(`fn main() {\n  let s = "a"\n  print(s.toUpperCase())\n}\n`)).toBe("did you mean 'toUpper'?");
  expect(hintFor(`fn main() {\n  let count = 5\n  print(cont)\n}\n`)).toBe("did you mean 'count'?");
  expect(hintFor(`struct U { name: string }\nfn main() {\n  let u = U { name: "a" }\n  print(u.nmae)\n}\n`))
    .toBe("did you mean 'name'?");
});

test("a failed static call reports the real mistake, not 'unknown enum'", () => {
  // Every one of these used to be "unknown enum 'X'" — including the struct case,
  // where the word did not apply to the user's code at all.
  const missingImport = `fn main() {\n  let x = Json.obj()\n  print(1)\n}\n`;
  expect(errorFor(missingImport)).toBe("unknown type 'Json'");
  expect(hintFor(missingImport)).toContain('from "std/json" import { Json }');

  const typoStatic = `struct P { a: i64 }\nimpl P { fn new(): P { return P { a: 1 } } }\nfn main() {\n  let x = P.knew()\n  print(1)\n}\n`;
  expect(errorFor(typoStatic)).toBe("type 'P' has no static method 'knew'");
  expect(hintFor(typoStatic)).toBe("did you mean 'new'?");

  const unknown = `fn main() {\n  let x = Frobnicator.go()\n  print(1)\n}\n`;
  expect(errorFor(unknown)).toBe("unknown type 'Frobnicator'");
});

// The type arguments of a bare static are inferred from the ARGUMENTS, so this hint is
// now reserved for the shape where there is nothing to infer from. `Box.make(1)` used to
// land here and now compiles — see tests/fixtures/genericStaticInfer.milo.
test("a bare static call on a generic type says to spell the type arguments", () => {
  const src = `struct Box<T> { v: i64 }\nimpl Box<T> { fn make(): Box<T> { return Box { v: 0 } } }\nfn main() {\n  let b = Box.make()\n  print(1)\n}\n`;
  // The method exists; only its type arguments are unknown, so "no static method" would
  // be false. The message says what is missing and the hint gives both spellings.
  expect(errorFor(src)).toBe("cannot infer the type arguments of 'Box' for 'Box.make(...)'");
  expect(hintFor(src)).toContain("Box<T>.make");
  expect(hintFor(src)).toContain("let x: Box<T> = Box.make(...)");
});

test("a bare static call on a generic type takes its type arguments from the expected type", () => {
  const src = `struct Box<T> { v: Vec<T> }
impl Box<T> { fn make(): Box<T> { return Box { v: [] } } }
fn take(b: Box<string>): i64 { return b.v.len() }
fn main() {
  let b: Box<i64> = Box.make()
  print(b.v.len() + take(Box.make()))
}
`;
  expect(errorFor(src)).toBeUndefined();
});

test("a method that does not exist on a generic type is still 'no static method', with a hint", () => {
  const src = `struct Box<T> { v: i64 }
impl Box<T> { fn make(): Box<T> { return Box { v: 0 } } }
fn main() {
  let b = Box.mkae()
  print(1)
}
`;
  expect(errorFor(src)).toBe("type 'Box' has no static method 'mkae'");
  expect(hintFor(src)).toBe("did you mean 'make'?");
});

test("a bare static call whose arguments pin the type parameters needs no hint", () => {
  const src = `struct Box<T> { v: T }\nimpl Box<T> { fn make(v: T): Box<T> { return Box { v: v } } }\nfn main() {\n  let b = Box.make(1)\n  print(b.v)\n}\n`;
  expect(errorFor(src)).toBeUndefined();
});

test("a name that starts a longer member beats a one-letter edit", () => {
  // `min` is one substitution from `sin` and three letters short of `minF64`; the
  // truncated name is the likelier mistake, and the reader has to pick a suffix.
  const math = ["sin", "cos", "minF64", "minI32", "minI64", "maxF64"];
  expect(memberHint("min", math)).toBe("did you mean 'minF64', 'minI32' or 'minI64'?");
  expect(closest("min", math)).toBe("minF64");
  // A camelCase word inside a member counts too, ranked after a prefix match.
  expect(closest("json", ["parseJson", "jsonl"])).toBe("jsonl");
  expect(closest("json", ["parseJson", "print"])).toBe("parseJson");
  // Mid-word is not a word: `ount` inside `amount` is no fragment, so edit distance answers.
  expect(memberHint("ount", ["count", "amount"])).toBe("did you mean 'count'?");
  // Under three characters nothing is a fragment, or `a` would match every member.
  expect(closest("ma", ["map", "max", "matches"])).toBe("map");
  // Edit distance still answers a real typo.
  expect(closest("lne", ["len", "lines"])).toBe("len");
});

test("more than three fragment matches keep the three shortest", () => {
  expect(memberHint("push", ["pushStr", "pushAll", "pushFront", "pushBackMany"]))
    .toBe("did you mean 'pushAll', 'pushStr' or 'pushFront'?");
});
