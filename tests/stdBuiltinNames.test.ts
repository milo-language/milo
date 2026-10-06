// Gate: no std `pub` fn shares a name with a builtin function.
//
// Builtins and program fns live in one `functions` map and the namespace is flat, so a
// std pub decl named like a builtin replaces the builtin for the WHOLE program once any
// file imports it: std/os's `pub extern fn exit` retargeted every `exit(n)`, and
// std/testing's one-argument `assert` would break every `assert(cond, msg)` elsewhere.
// Std names are read from source (not `milo api --json`, which leaves out externs).
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

const STD = join(import.meta.dir, "..", "std");

function builtinFnNames(): Set<string> {
  const src = "fn main() {}";
  const checker = new TypeChecker({ denied: new Set(), allowed: new Set() });
  checker.check(new Parser(new Lexer(src).tokenize(), src).parse());
  // Option/Result/Heap ride along in the same set as builtin TYPES; std declares those.
  return new Set([...checker.builtinNames].filter(n => !["Option", "Result", "Heap"].includes(n)));
}

function stdPubFns(): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith(".milo")) continue;
      const lines = readFileSync(p, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const m = /^pub (?:extern )?fn ([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (m) out.push({ name: m[1]!, where: `${p.slice(STD.length - 3)}:${i + 1}` });
      });
    }
  };
  walk(STD);
  return out;
}

test("the scans find builtins and std pub fns", () => {
  const b = builtinFnNames();
  expect(b.has("exit") && b.has("assert") && b.has("print")).toBe(true);
  expect(stdPubFns().length).toBeGreaterThan(500);
});

test("no std pub fn is named like a builtin", () => {
  const builtins = builtinFnNames();
  const clashes = stdPubFns().filter(f => builtins.has(f.name)).map(f => `${f.where} ${f.name}`);
  expect(clashes).toEqual([]);
});
