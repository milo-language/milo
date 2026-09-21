// Gate on docs/src.md — the compiler-source index, projected from each src file's own
// first comment line by scripts/gen-src-doc.ts.
//
// The only map of the compiler was the 14-row table in CLAUDE.md, against 39 files:
// abi, cgu, pkg, safety, suggest, verify and wcet were invisible to anyone
// (agent or human) reading the docs to find where a change belongs.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { sourceFiles } from "../scripts/gen-src-doc";

const ROOT = join(import.meta.dir, "..");

test("the checked-in index matches the generator", () => {
  // Regenerate with: bun run scripts/gen-src-doc.ts
  execFileSync("bun", ["run", "scripts/gen-src-doc.ts", "--check"], { cwd: ROOT, stdio: "pipe" });
});

test("every compiler source is listed", () => {
  const doc = readFileSync(join(ROOT, "docs", "src.md"), "utf-8");
  const files = sourceFiles();
  expect(files.length).toBeGreaterThan(20); // the scan must actually find src/
  expect(files.filter(f => !doc.includes(`\`${f}\``))).toEqual([]);
});

test("every file CLAUDE.md's pipeline table names still exists", () => {
  // The curated table stays small on purpose (it costs context every session), but a row
  // naming a file that has been renamed sends every agent to the wrong place.
  const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
  const listed = [...claude.matchAll(/`(src\/[a-z\-]+\.ts)`/g)].map(m => m[1]!);
  expect(listed.length).toBeGreaterThan(5);
  const real = new Set(sourceFiles());
  expect(listed.filter(f => !real.has(f))).toEqual([]);
});
