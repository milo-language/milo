// Unit tests for the shadows-stdlib-override lint. ON by default (unlike
// unused-import): a user fn that shares a stdlib fn's NAME and SIGNATURE but has a
// different BODY compiles fine — the signatures match — yet Milo's flat namespace
// makes the user's body win everywhere, including the library's own internal calls.
// That silent rebind is the footgun (a user `strIndexOf`/`charAt` breaking std from
// the inside), so it warns by default; --allow opts out for a deliberate override.
//
// A DIFFERENT-signature shadow is a hard error thrown by the resolver
// (shadows-stdlib), not this warning — see resolver.ts.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { resolveImports } from "../src/resolver";
import { getHostTarget } from "../src/target";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-shadow-lint-"));

function lint(src: string, cfg = { denied: new Set<string>(), allowed: new Set<string>() }): string[] {
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  let prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  prog = resolveImports(prog, dir, getHostTarget(), entry);
  return new TypeChecker(cfg).check(prog).diagnostics
    .filter(d => d.code === "shadows-stdlib-override")
    .map(d => d.message);
}

// strIndexOf: (haystack: &string, needle: &string): i64 — matched exactly, body differs.
const SHADOW = `from "std/string" import { strIndexOf }\nfn strIndexOf(haystack: &string, needle: &string): i64 { return -42 }\nfn main() { print(strIndexOf("hello", "l")) }\n`;

test("warns by default when a user fn shadows a stdlib fn of the same signature", () => {
  const out = lint(SHADOW);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("'fn strIndexOf'");
});

test("--allow=shadows-stdlib-override suppresses it", () => {
  const out = lint(SHADOW, { denied: new Set<string>(), allowed: new Set(["shadows-stdlib-override"]) });
  expect(out).toEqual([]);
});

test("does not fire for a uniquely-named user fn", () => {
  const out = lint(`fn myOwnUniqueHelper(x: i64): i64 { return x + 1 }\nfn main() { print(myOwnUniqueHelper(1)) }\n`);
  expect(out).toEqual([]);
});
