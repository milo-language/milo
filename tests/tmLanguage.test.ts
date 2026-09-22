// Gate on the VS Code grammar and the two lists it is generated from.
//
// editors/vscode/syntaxes/milo.tmLanguage.json was hand-maintained and silently
// wrong: it highlighted `parallel` and `char` — neither exists in the language — and
// left `trait`, `type`, `move`, `from`, `thread_local`, `string`, `int`, `byte` and
// `float` unhighlighted. Nothing failed, because nothing compared the grammar to the
// compiler. scripts/gen-tmlanguage.ts now derives it; these tests keep the derivation
// honest at both ends.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { KEYWORDS, SOFT_KEYWORDS } from "../src/tokens";
import { PRIMITIVE_TYPE_NAMES, typeFromAst } from "../src/types";

const ROOT = join(import.meta.dir, "..");

test("the checked-in grammar matches the generator", () => {
  // Regenerate with: bun run scripts/gen-tmlanguage.ts
  execFileSync("bun", ["run", "scripts/gen-tmlanguage.ts", "--check"], { cwd: ROOT, stdio: "pipe" });
});

// The generator can only be trusted if its inputs are. Both lists live in src/ but
// are duplicated knowledge — the parser recognises soft keywords by string value, and
// typeFromAst resolves primitive names in a switch. These pin them to that behaviour.

test("SOFT_KEYWORDS covers exactly what the parser recognises contextually", () => {
  const parser = readFileSync(join(ROOT, "src", "parser.ts"), "utf-8");
  const viaHelper = new Set<string>();
  for (const m of parser.matchAll(/(?:atSoftKw|expectSoftKw)\("([a-z_]+)"\)/g)) viaHelper.add(m[1]!);
  expect(viaHelper.size).toBeGreaterThan(0); // the scan must actually find something

  // thread_local predates the atSoftKw helper and is still matched by raw token value.
  // It is named explicitly rather than scanned for: a general `.value === "x"` sweep
  // also picks up pattern-matching internals like `"_"`, which are not keywords.
  const RAW_VALUE_SOFT_KEYWORDS = ["thread_local"];
  for (const kw of RAW_VALUE_SOFT_KEYWORDS) expect(parser).toContain(`value === "${kw}"`);

  const recognised = new Set([...viaHelper, ...RAW_VALUE_SOFT_KEYWORDS]);
  expect([...recognised].sort()).toEqual([...SOFT_KEYWORDS].sort());
});

test("every PRIMITIVE_TYPE_NAME resolves to a builtin, and a struct name does not", () => {
  const resolve = (name: string) => typeFromAst({
    name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null,
  });
  for (const n of PRIMITIVE_TYPE_NAMES) {
    expect(`${n} -> ${resolve(n).tag}`).not.toBe(`${n} -> struct`);
  }
  // Control: without this the loop above passes for free if typeFromAst stopped
  // returning "struct" for unknown names.
  expect(resolve("SomeUserStruct").tag).toBe("struct");
});

test("the grammar highlights no word the compiler does not know", () => {
  const g = JSON.parse(readFileSync(join(ROOT, "editors/vscode/syntaxes/milo.tmLanguage.json"), "utf-8"));
  const known = new Set<string>([...KEYWORDS, ...SOFT_KEYWORDS, ...PRIMITIVE_TYPE_NAMES]);
  const generated = [
    ...g.repository.keywords.patterns,
    ...g.repository.constants.patterns.filter((p: any) => p.name === "constant.language.milo"),
    ...g.repository.types.patterns.filter((p: any) => p.name === "support.type.primitive.milo"),
  ] as { name: string; match: string }[];
  expect(generated.length).toBeGreaterThan(5);
  for (const p of generated) {
    const words = /\\b\(([^)]+)\)\\b/.exec(p.match)?.[1]?.split("|") ?? [];
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(`${p.name}: ${w}`).toBe(`${p.name}: ${known.has(w) ? w : `UNKNOWN(${w})`}`);
  }
});

// The docs site kept its own hand-made copy of the grammar next to the VitePress
// config, and nothing compared the two: the site shipped the pre-generator version for
// months, highlighting `char`/`String`/`Box` and missing `unsafe`, `from`, `trait` and
// the contract keywords. One tracked grammar file, read by everyone who needs it.
test("there is exactly one grammar file, and the docs site reads it", () => {
  const tracked = execFileSync("git", ["ls-files", "*.tmLanguage.json"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n").filter(Boolean);
  expect(tracked).toEqual(["editors/vscode/syntaxes/milo.tmLanguage.json"]);

  const grammar = readFileSync(join(ROOT, "docs/site/.vitepress/miloGrammar.ts"), "utf-8");
  expect(grammar).toContain("editors/vscode/syntaxes/milo.tmLanguage.json");
  const config = readFileSync(join(ROOT, "docs/site/.vitepress/config.mts"), "utf-8");
  expect(config).toContain("import { miloGrammar } from './miloGrammar'");
  expect(config).toContain("languages: [miloGrammar]");
});
