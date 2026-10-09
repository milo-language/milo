// Gate on the corpus counts quoted in prose (scripts/gen-stats.ts).
//
// AGENTS.md claimed the nightly self-host sweep covered 589 fixtures and
// docs/testing.md claimed 470, against a real 597. A number inside a sentence is
// invisible to every other gate in the repo, so it drifts silently and then gets
// quoted back as fact.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { STATS } from "../scripts/gen-stats";

const ROOT = join(import.meta.dir, "..");

test("every marked count matches the repo", () => {
  // Regenerate with: bun run scripts/gen-stats.ts
  execFileSync("bun", ["run", "scripts/gen-stats.ts", "--check"], { cwd: ROOT, stdio: "pipe" });
});

test("the stat functions count something", () => {
  // A metric that silently returns 0 would let --check pass against an empty repo.
  for (const [name, fn] of Object.entries(STATS)) {
    expect(`${name}: ${fn()}`).not.toBe(`${name}: 0`);
  }
});

test("the fixture count is the number the test driver actually walks", () => {
  // Independent of gen-stats.ts: if both used the same helper, a bug in it would agree
  // with itself. Untracked files are excluded to match — a checkout regularly
  // holds an untracked scratch fixture, and CI would never see it.
  const untracked = new Set(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "tests/fixtures/*.milo"],
      { cwd: ROOT, encoding: "utf-8" }).split("\n").filter(Boolean).map(p => p.replace("tests/fixtures/", "")),
  );
  const onDisk = readdirSync(join(ROOT, "tests", "fixtures"))
    .filter(f => f.endsWith(".milo") && !untracked.has(f)).length;
  const claimed = /<!-- stat:fixtures -->(\d+)<!-- \/stat -->/.exec(readFileSync(join(ROOT, "AGENTS.md"), "utf-8"))?.[1];
  expect(claimed).toBe(String(onDisk));
});

// The roadmap's Standard Library section names every module by hand under a category.
// The COUNT next to the heading is generated (stat:std-modules) and was right; the LIST
// under it had fallen ten modules behind — binary, hkdf, html, mime, multipart, pbkdf2,
// rng, sha512, subtle, timer were all shipped and unlisted. A count that says 80 above a
// list of 70 names reads as complete, which is worse than an obviously stale doc.
test("the roadmap's stdlib list names every module, and no module it lacks", () => {
  const roadmap = readFileSync(join(ROOT, "docs", "roadmap.md"), "utf-8");
  const section = roadmap.split("### Standard Library")[1]!.split("\n###")[0]!;
  // Only the category lines ("Data: `json`, `csv`, …") are the list; the prose around
  // them mentions modules too, and a phantom check over prose would fire on a sentence.
  const categories = section.split("\n").filter(l => /^[A-Z][A-Za-z /&]*: `/.test(l)).join("\n");
  expect(categories.split("\n").length).toBeGreaterThan(5);
  const listed = new Set([...categories.matchAll(/`([a-z0-9]+)`/g)].map(m => m[1]!));
  const real = new Set(
    execFileSync("git", ["ls-files", "std/*.milo"], { cwd: ROOT, encoding: "utf-8" })
      .split("\n").filter(Boolean)
      .map(f => f.slice("std/".length).split(".")[0]!),
  );
  expect(real.size).toBeGreaterThan(50); // the scan must actually find std
  expect([...real].filter(m => !listed.has(m)).sort()).toEqual([]);
  // A name the list carries that std does not have is the same bug pointed the other way.
  expect([...listed].filter(w => !real.has(w)).sort()).toEqual([]);
});
