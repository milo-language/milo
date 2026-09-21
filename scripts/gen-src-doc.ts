// Regenerates the compiler-source index in docs/src.md from each src/*.ts file's own
// first comment line, so the map of the compiler cannot fall behind the directory.
//
// Run:  bun run scripts/gen-src-doc.ts          # rewrite the table
//       bun run scripts/gen-src-doc.ts --check  # fail if it is stale (CI/test)
//
// CLAUDE.md carries a hand-written table of the pipeline's core files; it had 14 rows
// against 39 files in src/, so two thirds of the compiler — abi, cgu, pkg,
// safety, suggest, verify, wcet — was undocumented at the level an agent reads first.
// Growing that table is the wrong fix: CLAUDE.md is loaded into every session, so its
// cost is per-conversation. The full index lives here and is projected, exactly like
// docs/scripts.md; improve an entry by improving the file's own first line.
import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { purposeOf } from "./gen-scripts-doc";

const ROOT = join(import.meta.dir, "..");
const DOC = join(ROOT, "docs", "src.md");
const BEGIN = "<!-- BEGIN GENERATED INDEX -->";
const END = "<!-- END GENERATED INDEX -->";

// git, not readdir: src/stdlib-bundle.ts is a build artifact (gitignored) that exists in
// any checkout that has run a release build, and indexing it would make the doc differ
// between machines.
export function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/*.ts"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n").filter(Boolean).sort();
}

function table(): string {
  const rows = sourceFiles().map(f => {
    const purpose = purposeOf(join(ROOT, f));
    if (purpose === null) {
      throw new Error(`${f} has no leading purpose comment — every compiler source starts with one (see docs/src.md)`);
    }
    return `| \`${f}\` | ${purpose.replace(/\|/g, "\\|")} |`;
  });
  return [BEGIN, "| File | Purpose |", "|---|---|", ...rows, END].join("\n");
}

// The CLI half must not run on import — tests/srcDoc.test.ts imports sourceFiles, and a
// test that rewrites the doc it is checking proves nothing.
if (import.meta.main) {
  const current = readFileSync(DOC, "utf-8");
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`docs/src.md is missing the ${BEGIN} / ${END} markers`);
  const next = current.slice(0, start) + table() + current.slice(end + END.length);

  if (process.argv.includes("--check")) {
    if (current !== next) {
      console.error("docs/src.md index is stale — run: bun run scripts/gen-src-doc.ts");
      process.exit(1);
    }
    console.log("docs/src.md index is up to date");
  } else {
    writeFileSync(DOC, next);
    console.log(`wrote the index in ${DOC}`);
  }
}
