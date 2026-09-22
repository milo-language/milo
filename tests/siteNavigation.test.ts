// Gates on the docs site's hand-written navigation and its stdlib coverage.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { langInfo } from "../src/lang-info";
import { apiEntries, pageOf } from "../scripts/gen-std-docs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Every sidebar/nav link must resolve to a page. Two did not — /stdlib/event and
// /stdlib/runtime were 404s on the deployed site, because the sidebar is hand-written
// and nothing compared it to docs/site/. VitePress does not fail the build on a dead
// nav entry, so this is the only thing that catches it.
describe("site navigation resolves", () => {
  const config = readFileSync(join(root, "docs", "site", ".vitepress", "config.mts"), "utf8");
  const links = [...new Set([...config.matchAll(/link: '(\/[^']*)'/g)].map(m => m[1]!))];

  test("the config scan finds the sidebar", () => {
    expect(links.length).toBeGreaterThan(50);
  });

  for (const link of links) {
    test(`${link} has a page`, () => {
      const base = join(root, "docs", "site", link.replace(/\/$/, "") || "/index");
      const exists = ["", ".md", "/index.md"].some(suffix => existsSync(base + suffix));
      expect(`${link}: ${exists ? "found" : "missing"}`).toBe(`${link}: found`);
    });
  }
});

// A std module with no site page is invisible to anyone reading the docs site. Each page's
// API reference is generated (scripts/gen-std-docs.ts), so what this checks is coverage:
// every module `milo api --json` reports has a page, the sidebar and the overview link it,
// and no page outlives its module.
describe("stdlib site coverage", () => {
  // Deliberately internal: bindings other std modules are built on, with nothing a program
  // should call directly. `platform` is raw per-OS externs (std/os wraps it), `cryptosys` is
  // std/crypto's per-OS backend, and `openssl` is the extern block std/fetch, std/tls and
  // std/ws share.
  const INTERNAL = new Set(["platform", "cryptosys", "openssl"]);

  // From the payload, not a directory scan: this is the module list a reader of `milo api`
  // sees. Platform arms (`std/pty.darwin`) fold to the one import path the resolver serves.
  const allModules = new Set(apiEntries().map(e => pageOf(e.module)));
  const stdModules = [...allModules]
    .filter(m => !INTERNAL.has(m))
    .sort();
  const sitePages = new Set(
    readdirSync(join(root, "docs", "site", "stdlib"))
      .filter(f => f.endsWith(".md") && f !== "index.md")
      .map(f => f.replace(/\.md$/, "")),
  );
  const config = readFileSync(join(root, "docs", "site", ".vitepress", "config.mts"), "utf8");
  const overview = readFileSync(join(root, "docs", "site", "stdlib", "index.md"), "utf8");

  test("the module scan finds std", () => {
    expect(stdModules.length).toBeGreaterThan(70);
  });

  test("every public std module has a site page", () => {
    expect(stdModules.filter(m => !sitePages.has(m))).toEqual([]);
  });

  test("an internal module really exists", () => {
    // A renamed module would otherwise leave a stale exemption that exempts nothing.
    expect([...INTERNAL].filter(m => !allModules.has(m)).sort()).toEqual([]);
  });

  test("every stdlib page is in the sidebar", () => {
    expect([...sitePages].filter(p => !config.includes(`link: '/stdlib/${p}'`)).sort()).toEqual([]);
  });

  test("every public std module is linked from the stdlib overview", () => {
    // Coverage, not wording: the tables are hand-written, but a module missing from them is
    // a module a reader browsing the overview never finds.
    expect(stdModules.filter(m => !overview.includes(`](${m})`)).sort()).toEqual([]);
  });

  test("no site page documents a module that no longer exists", () => {
    expect([...sitePages].filter(p => !allModules.has(p)).sort()).toEqual([]);
  });
});

// A language feature that ships with no page on the docs site is invisible to everyone who
// is not reading this repo. Struct destructuring landed in docs/language-reference.md, the
// grammar, the spec, the error catalog, the roadmap and the backlog, and reached the site
// only because someone happened to notice. The stdlib ratchet above has caught that shape
// for std MODULES since 2026-08-15; nothing was watching the language itself.
describe("language surface site coverage", () => {
  // TRACKED files only, via git. Walking the directory instead picks up
  // docs/site/node_modules, which a local `vitepress` install fills with 172 vendored .md
  // files: two thirds of the corpus would be somebody else's documentation, every check
  // below would pass on a word that appears only there, and the gate would say something
  // different on a dev machine than on a clean runner. CI caught exactly that.
  const site = execFileSync("git", ["ls-files", "-z", "docs/site"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(f => f.endsWith(".md"))
    .map(f => readFileSync(join(root, f), "utf8"))
    .join("\n");
  // Identifier-boundary match, so `int` does not match `print` and `as` does not match
  // `class`. Attributes are searched with their `@`.
  const onSite = (s: string) =>
    new RegExp(`(?<![A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(site);

  // RATCHETS: an entry may only be REMOVED. Adding one waves through the exact failure
  // these tests exist to catch, so a new keyword or warning goes on the site instead.
  // Empty, and it should stay that way: docs/site/language/keywords.md is generated from
  // `keywordDocs` in the payload, so a keyword reaches the site the moment the compiler
  // has a hover doc for it — which tests/langInfo.test.ts already requires of every one.
  const KEYWORDS_OFF_SITE = new Set<string>([]);
  // Every warning name now reaches the site through the GENERATED reference
  // (docs/site/language/warnings-and-errors.md, scripts/gen-lang-docs.ts), so this list is
  // empty and the name check below can no longer fail on its own — a new warning appears in
  // the generated table the moment it is added. The real pressure moved to the entry check
  // further down: a name in a table teaches nobody anything.
  const WARNINGS_OFF_SITE = new Set<string>([]);

  // Ceiling on warnings with no reference entry. RATCHET: may only go DOWN, and it is at
  // the floor — a warning added to src/warnings.ts without doc/fix/example fails here.
  const UNDOCUMENTED_WARNINGS_CEILING = 0;

  const info = langInfo();
  const keywords = [...info.keywords, ...info.softKeywords];
  const warnings = info.warnings.map(w => w.name);
  const attributes = info.attributes.map(a => a.name);

  test("the site corpus was actually read", () => {
    // A glob that matched nothing reports perfect coverage of everything.
    expect(site.length).toBeGreaterThan(100_000);
    expect(keywords.length).toBeGreaterThan(20);
    expect(warnings.length).toBeGreaterThan(20);
  });

  test("every keyword appears on the site", () => {
    expect(keywords.filter(k => !onSite(k) && !KEYWORDS_OFF_SITE.has(k)).sort()).toEqual([]);
  });

  test("every primitive type appears on the site", () => {
    expect(info.primitiveTypes.filter(t => !onSite(t)).sort()).toEqual([]);
  });

  test("every attribute appears on the site", () => {
    expect(attributes.filter(a => !onSite(`@${a}`)).sort()).toEqual([]);
  });

  test("every warning name appears on the site", () => {
    expect(warnings.filter(w => !onSite(w) && !WARNINGS_OFF_SITE.has(w)).sort()).toEqual([]);
  });

  // The check that still bites. `onSite` is satisfied by a row in the generated summary
  // table, which every warning gets for free; a reader learns what the warning MEANS only
  // from a reference entry, and an entry exists only where src/warnings.ts carries
  // doc + fix + example. src/warnings.ts's DOCUMENTED_FLOOR is the ratchet that makes the
  // undocumented set shrink; this is what proves the written ones actually got published.
  test("every documented warning has a reference entry on the published page", () => {
    const page = readFileSync(join(root, "docs/site/language/warnings-and-errors.md"), "utf8");
    const documented = info.warnings.filter(w => w.doc && w.fix && w.example).map(w => w.name);
    expect(documented.length).toBeGreaterThanOrEqual(2); // a payload that lost its docs is not a pass
    expect(documented.filter(n => !page.includes(`### ${n}\n`)).sort()).toEqual([]);
  });

  test("the undocumented warnings are a shrinking set", () => {
    // Not an assertion that it is empty — an inventory, so the number is visible in the
    // test output and a regression (a new warning with no entry) shows up as growth.
    const undocumented = info.warnings.filter(w => !(w.doc && w.fix && w.example)).map(w => w.name);
    expect(undocumented.length).toBeLessThanOrEqual(UNDOCUMENTED_WARNINGS_CEILING);
  });

  test("the ratchets only shrink", () => {
    expect([...KEYWORDS_OFF_SITE].filter(onSite).sort()).toEqual([]);
    expect([...WARNINGS_OFF_SITE].filter(onSite).sort()).toEqual([]);
  });

  // The checks above all key on a NAME. Syntax that ships without one slips past every
  // single one of them: `let Point { x, y } = p` introduced no keyword, no attribute and
  // no type, and its only enumerable trace anywhere in the repo is the `field_bindings`
  // production. So the production list is pinned. When this fails, the failure is the
  // question: does the syntax that was just added need a page on docs/site/language/?
  // Answer it, THEN update this list.
  const PINNED_PRODUCTIONS = [
    "additive", "and_expr", "arg_list", "array_lit", "assign_stmt", "attribute", "attribute_arg",
    "balanced_tokens", "base_type", "bitand_expr", "bitor_expr", "bitxor_expr", "block", "closure",
    "coalesce", "comment", "comparison", "contract", "declaration", "derive_decl", "digit", "enum_decl",
    "enum_variant", "escape", "expr", "extern_decl", "extern_fn", "extern_struct", "extern_type",
    "field_bindings", "fn_decl", "for_stmt", "global_decl", "hexdigit", "if_expr", "if_stmt",
    "impl_decl", "import_decl", "import_name", "interface_decl", "interface_method", "let_decl",
    "letter", "loop_contract", "match_arm", "match_expr", "match_stmt", "multiplicative",
    "nullable_ref", "or_expr", "param", "param_list", "pattern", "postfix", "primary", "program",
    "range_bound", "return_stmt", "shift", "statement", "struct_decl", "struct_lit", "trait_decl",
    "trait_method", "type", "type_alias", "type_args", "type_name", "type_params", "unary",
    "unsafe_block", "var_decl", "while_stmt",
  ];

  test("no new grammar production has shipped without the site being considered", () => {
    const grammar = readFileSync(join(root, "docs", "grammar.ebnf"), "utf8")
      .replace(/\(\*[\s\S]*?\*\)/g, "");
    const names = [...new Set([...grammar.matchAll(/^([a-z_][a-z0-9_]*)\s*=/gm)].map(m => m[1]!))].sort();
    expect(names).toEqual([...PINNED_PRODUCTIONS].sort());
  });
});
