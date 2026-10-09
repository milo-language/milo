// Every relative markdown link that names a file must point at a file that exists.
//
// Nothing checked this, and four links had rotted the same way: a doc under docs/
// linking to `docs/scripts.md` (correct from the repo root, dead from where it lives)
// and language-reference.md still pointing at `examples/json_parser.milo`, moved to
// examples/basics/json.milo. A dead link in a doc index is worse than a
// missing one — it reads as "this was checked".
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname, normalize } from "path";

const ROOT = join(import.meta.dir, "..");

// Only targets that name a FILE are checked. VitePress route links (`/language/ownership`)
// are extensionless and resolve through the router, not the filesystem — tests/siteNavigation.ts
// owns those.
const FILE_EXT = [".md", ".ts", ".mts", ".milo", ".sh", ".json", ".ebnf", ".yml", ".txt", ".vue"];

const markdownFiles = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf-8" })
  .split("\n")
  .filter(Boolean)
  .filter(f => !f.startsWith("docs/site/node_modules/"));

test("the scan finds the docs", () => {
  expect(markdownFiles.length).toBeGreaterThan(50);
});

test("no markdown link points at a file that does not exist", () => {
  const broken: string[] = [];
  for (const file of markdownFiles) {
    const text = readFileSync(join(ROOT, file), "utf-8");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1]!;
      if (/^(https?:|\/\/|#|mailto:)/.test(raw)) continue;
      const target = raw.split("#")[0]!;
      if (!target || !FILE_EXT.some(e => target.endsWith(e))) continue;
      const resolved = target.startsWith("/")
        ? join(ROOT, target.slice(1))
        : normalize(join(ROOT, dirname(file), target));
      if (!existsSync(resolved)) broken.push(`${file} -> ${raw}`);
    }
  }
  expect(broken).toEqual([]);
});
