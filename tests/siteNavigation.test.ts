// Gates on the docs site's hand-written navigation and its stdlib coverage.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
