// Gates on the docs site's hand-written navigation and its stdlib coverage.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { langInfo } from "../src/lang-info";
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

// A std module with no site page is invisible to anyone reading the docs site. The
// site's stdlib section is hand-written prose, so it cannot be generated — but the
// COVERAGE can be checked, and it had fallen 20 modules behind.
describe("stdlib site coverage", () => {
  // Platform arms are implementation splits behind one import path; the resolver picks
  // by target OS, so `std/platform` is what a user writes and what gets a page. Modules
  // listed here are deliberately internal and documented nowhere on the site.
  const INTERNAL = new Set(["prelude", "cstr", "select", "keys", "checksum", "rng", "httpmw", "pool"]);

  // Public modules that still have no site page, as of 2026-08-15. This list is a
  // RATCHET, not an exemption: a module may only be removed from it, never added, so a
  // newly added std module cannot ship without docs. Writing these pages is prose work,
  // not something a generator can do — `milo doc` renders them almost entirely
  // "_Undocumented._" because the sources carry no doc-comments (ansi 0/25, xxhash 0/2,
  // zstd 0/3), and publishing that would be worse than the gap it fills.
  const UNDOCUMENTED = new Set([
    "ansi", "dl", "fetch", "https", "openssl", "os", "png", "smt", "tls", "unix", "ws", "xxhash", "zstd",
  ]);

  const stdModules = readdirSync(join(root, "std"))
    .filter(f => f.endsWith(".milo"))
    .map(f => f.replace(/\.milo$/, ""))
    .filter(m => !m.includes("."))       // drop platform arms: foo.darwin, foo.linux
    .filter(m => !INTERNAL.has(m))
    .sort();
  const sitePages = new Set(
    readdirSync(join(root, "docs", "site", "stdlib"))
      .filter(f => f.endsWith(".md") && f !== "index.md")
      .map(f => f.replace(/\.md$/, "")),
  );

  test("the module scan finds std", () => {
    expect(stdModules.length).toBeGreaterThan(40);
  });

  test("every public std module has a site page, or is on the ratchet", () => {
    expect(stdModules.filter(m => !sitePages.has(m) && !UNDOCUMENTED.has(m))).toEqual([]);
  });

  test("the ratchet only shrinks — a documented module must come off it", () => {
    expect([...UNDOCUMENTED].filter(m => sitePages.has(m)).sort()).toEqual([]);
  });

  test("no site page documents a module that no longer exists", () => {
    const real = new Set(readdirSync(join(root, "std")).map(f => f.replace(/\.milo$/, "").split(".")[0]!));
    expect([...sitePages].filter(p => !real.has(p)).sort()).toEqual([]);
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
  const KEYWORDS_OFF_SITE = new Set(["thread_local"]);
  // The site's Warnings section documents 7 of 26 by name. The rest are real gaps, not
  // decisions: burn this list down. (`milo lang --json` carries no doc text for a warning,
  // so the page cannot be generated: each entry is prose someone has to write.)
  const WARNINGS_OFF_SITE = new Set([
    "arena-never-frees", "borrow-that-clones", "external-linkage-not-pub", "index-clone",
    "manual-option-default", "nan-comparison", "opaque-call-on-thread", "shadows-stdlib-override",
    "single-variant-match", "string-concat-in-loop", "unchecked-ffi-contract", "unfulfilled-expectation",
    "unowned-pointer-copy", "unused-import", "unused-unsafe", "useless-forget",
  ]);

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
