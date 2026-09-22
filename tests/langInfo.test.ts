// Gate on `milo lang --json` — the language's vocabulary as a public, machine-readable
// surface, and on src/warnings.ts, the list it draws the warning names from.
//
// Everything here exists so that tooling OUTSIDE this repo (a tree-sitter grammar, an
// editor plugin, a third-party linter, a Milo-written tool, a future Rust or self-hosted
// compiler's tooling) can ask the compiler what the language contains instead of copying
// a list by hand. The docs site did copy one, and shipped `char`/`String`/`Box` — words
// Milo does not have — for months.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { langInfo, LANG_JSON_SCHEMA } from "../src/lang-info";
import { KEYWORDS, SOFT_KEYWORDS } from "../src/tokens";
import { KEYWORD_DOCS } from "../src/keyword-docs";
import { PRIMITIVE_TYPE_NAMES } from "../src/types";
import { BUILTIN_MEMBERS } from "../src/builtin-members";
import { WARNINGS, WARNING_NAMES, OFF_BY_DEFAULT, DOCUMENTED_FLOOR } from "../src/warnings";
import { ATTRIBUTES, ATTRIBUTE_NAMES } from "../src/attributes";

const ROOT = join(import.meta.dir, "..");
const CHECKER = readFileSync(join(ROOT, "src", "checker.ts"), "utf-8");

test("the CLI emits the same payload as the module, and it parses", () => {
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "lang", "--json"], { encoding: "utf-8" });
  expect(JSON.parse(out)).toEqual(langInfo());
});

test("the payload carries every vocabulary the compiler has", () => {
  const info = langInfo();
  expect(info.schema).toBe(LANG_JSON_SCHEMA);
  expect(info.keywords.sort()).toEqual([...KEYWORDS].sort());
  expect(info.softKeywords.sort()).toEqual([...SOFT_KEYWORDS].sort());
  expect(info.primitiveTypes.sort()).toEqual([...PRIMITIVE_TYPE_NAMES].sort());
  expect(Object.keys(info.builtinMembers).sort()).toEqual(Object.keys(BUILTIN_MEMBERS).sort());
  // A payload that silently emptied would pass every "is it a subset" check.
  expect(info.keywords.length).toBeGreaterThan(20);
  expect(Object.values(info.symbols).length).toBeGreaterThan(20);
  expect(info.symbols.FatArrow).toBe("=>");
  // Literal classes are lexer concepts with no spelling — they must not leak in as
  // "symbols" a highlighter would try to match.
  expect(Object.values(info.symbols)).not.toContain("IDENT");
});

test("every warning the checker emits has a row in src/warnings.ts", () => {
  const emitted = [...CHECKER.matchAll(/\bwarn\("([a-z-]+)"/g)].map(m => m[1]!);
  expect(emitted.length).toBeGreaterThan(5); // the scan must find the call sites
  expect([...new Set(emitted)].filter(n => !WARNING_NAMES.includes(n)).sort()).toEqual([]);
});

test("every row in src/warnings.ts is a warning the checker emits", () => {
  // The other direction: a row for a warning that no longer exists sends a user to
  // `--deny=` a name the compiler will never produce.
  const mentioned = WARNING_NAMES.filter(n => CHECKER.includes(`"${n}"`));
  expect(WARNING_NAMES.filter(n => !mentioned.includes(n))).toEqual([]);
});

test("off-by-default matches the checker's allow-list", () => {
  const allowed = [...CHECKER.matchAll(/allowed\.add\("([a-z-]+)"\)/g)].map(m => m[1]!);
  expect(allowed.length).toBeGreaterThan(2);
  expect([...new Set(allowed)].sort()).toEqual([...OFF_BY_DEFAULT].sort());
});

test("the checker denies no warning by default", () => {
  // A rule the language requires is a hard error, not a warning the constructor promotes;
  // a warning promoted here would be one `milo lang --json` misreports as ordinary.
  const denied = [...CHECKER.matchAll(/config\.denied\.add\("([a-z-]+)"\)/g)].map(m => m[1]!);
  expect(denied).toEqual([]);
});

test("the --deny-all help line is rendered, not retyped", () => {
  const help = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "--help"], { encoding: "utf-8" });
  for (const name of OFF_BY_DEFAULT) expect(help).toContain(name);
  expect(WARNINGS.length).toBeGreaterThan(OFF_BY_DEFAULT.length);
});

test("every keyword carries hover documentation", () => {
  // A keyword has no type and no declaration site, so the LSP has nothing to fall back
  // on: an undocumented one hovers to NOTHING, silently. This is the only thing keeping
  // a newly added keyword from shipping that way.
  const all = [...KEYWORDS, ...SOFT_KEYWORDS];
  expect(all.filter(k => !KEYWORD_DOCS[k])).toEqual([]);
  // The other direction — a doc for a word the language no longer has teaches a lie.
  expect(Object.keys(KEYWORD_DOCS).filter(k => !all.includes(k))).toEqual([]);
  // Each entry shows the FORM in a fenced milo block, then explains it.
  for (const [kw, doc] of Object.entries(KEYWORD_DOCS)) {
    expect(doc.startsWith("```milo\n")).toBe(true);
    expect(doc.length).toBeGreaterThan(80);
    expect(langInfo().keywordDocs[kw]).toBe(doc);
  }
});


// The attribute vocabulary is a PUBLIC surface: an editor, linter or agent outside this
// repo learns it from `milo lang --json` and cannot import TypeScript from the compiler.
// It went missing once already -- `@thread` and `@synchronized` shipped as safety-critical
// annotations that no tool could discover and that the language's own author did not know
// existed -- so these hold the JSON to the checker rather than to a hand-kept list.
test("every attribute is reported by lang --json", () => {
  const info = langInfo() as unknown as { attributes: { name: string }[] };
  expect(info.attributes.map(a => a.name).sort()).toEqual([...ATTRIBUTE_NAMES].sort());
});

test("every attribute names at least one target and carries a doc", () => {
  for (const a of ATTRIBUTES) {
    expect(a.targets.length).toBeGreaterThan(0);
    expect(a.doc.length).toBeGreaterThan(20);
  }
});

// Both per-target lists the checker used to carry lived inside error-message strings and
// had drifted from each other. Derived, or the drift comes back.
test("the checker derives its attribute lists from the vocabulary", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "checker.ts"), "utf-8");
  expect(src).toContain('attributesFor("struct")');
  expect(src).toContain('attributesFor("fn")');
  expect(src).toContain('attributesFor("method")');
});

// A safety-critical attribute nobody can find is the failure this file exists to prevent.
test("the annotations the checker enforces are documented for humans too", () => {
  const ref = readFileSync(join(import.meta.dir, "..", "docs", "language-reference.md"), "utf-8");
  for (const name of ATTRIBUTE_NAMES) {
    expect({ attribute: name, documented: ref.includes(`@${name}`) })
      .toEqual({ attribute: name, documented: true });
  }
});

// The internal reference above was complete; the PUBLISHED page was not. It claimed to
// list "the eight constructs" spelled with an `@`, carried nine rows, and omitted five
// attributes the compiler enforces — including @noCopy, @thread and @synchronized, three
// of the four that exist for safety. A reader of the site could not discover them.
//
// Checks the TABLE, not the page: prose elsewhere on the page mentions some of these in
// passing, which would satisfy a bare includes() while the reference table stayed wrong.
test("the published annotations table lists every attribute", () => {
  const page = readFileSync(
    join(import.meta.dir, "..", "docs", "site", "features", "annotations.md"), "utf-8");
  const rows = page.split("\n").filter(l => /^\| `@/.test(l));
  expect(rows.length).toBeGreaterThan(10); // a table that stopped matching is not a pass
  const listed = rows.join("\n");
  for (const name of ATTRIBUTE_NAMES) {
    expect({ attribute: name, inTable: listed.includes(`@${name}`) })
      .toEqual({ attribute: name, inTable: true });
  }
});

// ---------------------------------------------------------------------------
// The warning reference, as data.
//
// Before this, the site's warning coverage was hand-written prose that named 10 of the
// 26 warnings the compiler ships; the other 16 existed only in `--help` output. The text
// now lives on the WARNINGS row and is RENDERED to the site, the CLI and `lang --json`,
// so there is one copy. These tests are what keep that copy honest.
test("a documented warning carries a doc, a fix and an example", () => {
  const documented = WARNINGS.filter(w => w.doc || w.fix || w.example);
  // Partial entries are the failure mode: a doc with no example is a claim nothing checks.
  expect(documented.filter(w => !(w.doc && w.fix && w.example)).map(w => w.name)).toEqual([]);
  for (const w of documented) {
    expect({ name: w.name, docLen: w.doc!.length > 40 }).toEqual({ name: w.name, docLen: true });
    expect({ name: w.name, fixLen: w.fix!.length > 15 }).toEqual({ name: w.name, fixLen: true });
  }
  // Ratchet: entries may only be added. Raise DOCUMENTED_FLOOR when you write more.
  expect(documented.length).toBeGreaterThanOrEqual(DOCUMENTED_FLOOR);
});

test("every documented example actually provokes its own warning", () => {
  // The point of the whole exercise. A reference example that no longer trips the rule it
  // illustrates is exactly the rot the copied lists had, moved one level in.
  const documented = WARNINGS.filter(w => w.example);
  expect(documented.length).toBeGreaterThanOrEqual(DOCUMENTED_FLOOR); // a scan that found nothing is not a pass
  const dir = mkdtempSync(join(tmpdir(), "milo-warn-doc-"));
  const wrong: string[] = [];
  for (const w of documented) {
    // NOT `${w.name}.milo`: the diagnostic prints the path, so a filename carrying the
    // warning name makes `out.includes(name)` true for every example, broken ones too.
    const f = join(dir, "case.milo");
    writeFileSync(f, w.example!);
    // `--expect=<name>`, not `--deny=`: it enables an off-by-default warning, suppresses
    // the finding when it fires, and says so by name when it does NOT. Human-readable
    // diagnostics never print the warning name, so this is the only name-keyed oracle.
    const r = spawnSync("bun", [join(ROOT, "src", "main.ts"), "check", f, `--expect=${w.name}`], { encoding: "utf-8" });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    if (out.includes(`no '${w.name}' warning was reported`)) {
      wrong.push(`${w.name}: example did not provoke it`);
    } else if ((r.status ?? 1) !== 0) {
      // The example must be otherwise clean: a program that fails to type-check would
      // "provoke" nothing and teach a reader syntax that does not compile.
      wrong.push(`${w.name}: example does not check clean\n${out.slice(0, 400)}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  expect(wrong).toEqual([]);
});
