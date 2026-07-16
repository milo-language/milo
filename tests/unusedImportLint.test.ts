// Unit tests for the unused-import lint. OFF by default and opted into with
// `--deny=unused-import`, because an import can be load-bearing without the entry file
// ever naming the symbol: node-milo's main.milo imports binding symbols purely so those
// modules get compiled and linked. Warning by default would fire on every one of them,
// and the obvious "fix" would break the build.
//
// The usage scan is deliberately over-broad — it treats any string anywhere in the entry
// AST as a use — so the lint can MISS an unused import but must never invent one. These
// tests pin that direction: the type-only and enum-variant cases are the ones a naive
// "is it called?" check would get wrong.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { resolveImports } from "../src/resolver";
import { getHostTarget } from "../src/target";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-unused-import-"));

function lint(src: string, deny = true): string[] {
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  let prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  prog = resolveImports(prog, dir, getHostTarget(), entry);
  const cfg = { denied: new Set(deny ? ["unused-import"] : []), allowed: new Set<string>() };
  return new TypeChecker(cfg).check(prog).diagnostics
    .filter(d => d.code === "unused-import")
    .map(d => d.message);
}

test("flags a named import the file never mentions", () => {
  const out = lint(`from "std/string" import { strTrim, strSplit }\n\nfn main() { print(strTrim("x")) }\n`);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("'strSplit'");
});

test("does not flag an import that IS used", () => {
  const out = lint(`from "std/string" import { strTrim }\n\nfn main() { print(strTrim("x")) }\n`);
  expect(out).toEqual([]);
});

test("does not flag a name used only as a type annotation", () => {
  const out = lint(`from "std/io" import { File }\n\nfn f(_x: &File): i64 { return 1 }\n\nfn main() { print(1) }\n`);
  expect(out).toEqual([]);
});

test("does not flag a name used only as a return type", () => {
  const out = lint(`from "std/json" import { Json }\n\nfn g(): Option<Json> { return Option.None }\n\nfn main() { print(1) }\n`);
  expect(out).toEqual([]);
});

test("off unless denied — link-only imports must not nag by default", () => {
  const out = lint(`from "std/string" import { strTrim, strSplit }\n\nfn main() { print(strTrim("x")) }\n`, false);
  expect(out).toEqual([]);
});

test("a name used only as an enum variant qualifier is not flagged", () => {
  // `Result.Ok(...)` names Result but never "calls" it — a naive is-it-called check
  // would report this import as dead and break the file.
  const out = lint(`from "std/io" import { readFile }\n\nfn main() {\n  match readFile("/etc/hostname") {\n    Result.Ok(_t) => { print(1) }\n    Result.Err(_e) => { print(0) }\n  }\n}\n`);
  expect(out).toEqual([]);
});
