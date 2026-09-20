// Fills in the corpus counts quoted in prose, so a doc cannot claim a number the
// repo stopped matching.
//
// Run:  bun run scripts/gen-stats.ts          # rewrite every marked count
//       bun run scripts/gen-stats.ts --check  # fail if any is stale (CI/test)
//       bun run scripts/gen-stats.ts --list   # print the current values
//
// Mark a count in any tracked doc as `<!-- stat:NAME -->123<!-- /stat -->`; the text
// between the markers is replaced. Docs drifted quietly before this — CLAUDE.md said
// the nightly sweep covered 589 fixtures and docs/testing.md said 470, against a real
// 597 — because a count in a sentence is invisible to every other gate.
//
// Only LIVE claims get markers. A dated audit or decision record (stdlib-audit-*.md,
// selfhost-endgame-decision.md, security-audit-*.md) states what was true when it was
// written; rewriting those numbers would falsify the record, so they stay untouched.
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// Counts come from git, not the working tree. This repo is often a shared checkout with
// another agent's untracked scratch fixtures in it; counting those made the docs claim a
// number CI could never reproduce, and the gate then failed for everyone.
function tracked(dir: string): string[] {
  const out = execFileSync("git", ["ls-files", "--", `${dir}/*.milo`], { cwd: ROOT, encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

// Test CASES only. tests/fixtures/lib/ holds helper modules that fixtures import, and
// they are not tests — `git ls-files` recurses, so they have to be filtered out here.
const countMilo = (dir: string) =>
  tracked(dir).filter(f => f.slice(dir.length + 1).indexOf("/") < 0).length;

const countExamples = () => tracked("examples").length;

export const STATS: Record<string, () => number> = {
  fixtures: () => countMilo("tests/fixtures"),
  "error-fixtures": () => countMilo("tests/errors"),
  "runtime-error-fixtures": () => countMilo("tests/runtime-errors"),
  "prove-fixtures": () => countMilo("tests/prove"),
  // Platform arms (foo.darwin.milo, foo.linux.milo) are one importable module behind
  // one name, which is the number a user of `from "std/x"` experiences.
  "std-modules": () => new Set(
    readdirSync(join(ROOT, "std")).filter(f => f.endsWith(".milo")).map(f => f.split(".")[0]),
  ).size,
  "example-programs": () => countExamples(),
};

// Docs whose counts are current claims, not a dated record.
// docs/site/roadmap.md is a hand-condensed copy of docs/roadmap.md for the published
// site. Its counts drifted 61 fixtures and 45 error-fixtures behind before it was tracked
// here — the internal roadmap was gated and the public one, which is what users actually
// read, was not.
const TRACKED = ["CLAUDE.md", "AGENTS.md", "README.md", "docs/testing.md", "docs/roadmap.md", "docs/site/roadmap.md"];

// The placeholder in AGENTS.md's own table documents this syntax, so it is written
// `stat:<name>` — the angle brackets keep it out of `[a-z-]+` and stop the generator
// matching its own documentation. It did: every commit failed the pre-commit hook with
// "AGENTS.md: unknown stat 'name'", because a doc that teaches a marker format is
// indistinguishable from a use of it unless one of the two is escaped.
const MARKER = /<!-- stat:([a-z-]+) -->(.*?)<!-- \/stat -->/g;

function rewrite(text: string, file: string): string {
  return text.replace(MARKER, (_m, name: string) => {
    const fn = STATS[name];
    if (!fn) throw new Error(`${file}: unknown stat '${name}' — add it to STATS in scripts/gen-stats.ts`);
    return `<!-- stat:${name} -->${fn()}<!-- /stat -->`;
  });
}

// STATS is imported by tests/docStats.test.ts, so the CLI half must not run on import
// — it writes files, and a test that rewrites the docs it is checking proves nothing.
if (import.meta.main) {
  // The pre-commit hook has to stage exactly what this writes, and hardcoding that list
  // there is how docs/site/roadmap.md drifted: the hook staged five of the six files and
  // CI reported the sixth stale, twenty minutes after the push, on a commit that had only
  // added a fixture. The hook asks for the list now instead of repeating it.
  if (process.argv.includes("--files")) {
    for (const f of TRACKED) console.log(f);
    process.exit(0);
  }
  if (process.argv.includes("--list")) {
    for (const [name, fn] of Object.entries(STATS)) console.log(`${name}\t${fn()}`);
    process.exit(0);
  }

  const check = process.argv.includes("--check");
  let stale = 0;
  let marked = 0;
  for (const file of TRACKED) {
    const path = join(ROOT, file);
    const current = readFileSync(path, "utf-8");
    marked += [...current.matchAll(MARKER)].length;
    const next = rewrite(current, file);
    if (current === next) continue;
    if (check) { console.error(`${file}: a marked count is stale`); stale++; }
    else writeFileSync(path, next);
  }

  // A marker-less run would report success having checked nothing.
  if (marked === 0) { console.error("no stat markers found in any tracked doc — the markers or the file list are wrong"); process.exit(1); }

  if (check) {
    if (stale > 0) { console.error(`run: bun run scripts/gen-stats.ts`); process.exit(1); }
    console.log(`${marked} marked counts are up to date`);
  } else {
    console.log(`updated ${marked} marked counts across ${TRACKED.length} docs`);
  }
}
