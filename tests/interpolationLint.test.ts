// Unit tests for the missing-interpolation lint. Only `$"..."` interpolates, so a
// plain `"hi ${name}"` emits those characters verbatim with no type error — the one
// way to get silently wrong output. The lint fires only when the braced name is a
// real binding, which is what keeps shell/CSS/format-string literals quiet.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-lint-"));

function lint(body: string, cfg = { denied: new Set<string>(), allowed: new Set<string>() }) {
  const src = `fn main(): i32 {\n${body}\n    return 0\n}\n`;
  const entry = join(dir, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  return new TypeChecker(cfg).check(prog).diagnostics.filter(d => d.code === "missing-interpolation");
}

const BOUND = `    let name = "world"\n    print("hello \${name}")`;

test("warns on the JavaScript ${} spelling in a plain string", () => {
  const out = lint(BOUND);
  expect(out.length).toBe(1);
  expect(out[0].severity).toBe("warning");
  expect(out[0].message).toContain("${name}");
  expect(out[0].hint).toContain("$\"");
});

test("warns on a bare {name} in a plain string", () => {
  const out = lint(`    let name = "world"\n    print("hello {name}")`);
  expect(out.length).toBe(1);
  expect(out[0].message).toContain("{name}");
});

test("does not warn on a correctly prefixed f-string", () => {
  expect(lint(`    let name = "world"\n    print($"hello {name}")`)).toEqual([]);
});

test("does not warn when the braced name is not in scope", () => {
  // A shell fragment, a CSS rule, or a format string meant for another tool — the
  // braces are data, and there is no binding that could have been interpolated.
  expect(lint(`    print("shell \${PATH} stays")`)).toEqual([]);
  expect(lint(`    print("css .a{b}")`)).toEqual([]);
});

test("does not warn on a brace that an f-string escape produced", () => {
  // `\\{` desugars to a literal `{` in a StringLit piece; it was written to be a
  // brace, so re-flagging it would be noise on correct code.
  expect(lint(`    let id = "7"\n    print($"\\{\\"id\\": \\"{id}\\"}")`)).toEqual([]);
});

test("--allow suppresses it and --deny promotes it to an error", () => {
  expect(lint(BOUND, { denied: new Set<string>(), allowed: new Set(["missing-interpolation"]) })).toEqual([]);
  const denied = lint(BOUND, { denied: new Set(["missing-interpolation"]), allowed: new Set<string>() });
  expect(denied.length).toBe(1);
  expect(denied[0].severity).toBe("error");
});

test("does not warn on a doubled-brace {{name}} template placeholder", () => {
  expect(lint(`    let inviter = "a"\n    print("x".replace("{{inviter}}", inviter))`)).toEqual([]);
  expect(lint(`    let name = "w"\n    print("{{name}}")`)).toEqual([]);
});
