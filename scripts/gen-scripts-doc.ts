// Regenerates the Index table in docs/scripts.md from each script's own first
// comment line, so the index cannot fall behind the directory.
//
// Run:  bun run scripts/gen-scripts-doc.ts          # rewrite the table
//       bun run scripts/gen-scripts-doc.ts --check  # fail if it is stale (CI/test)
//
// The table was hand-maintained and listed 15 of 47 scripts, plus one (`scripts/foo.ts`)
// that never existed. docs/scripts.md already required every script to open with a
// one-sentence purpose, and every script honoured it — the doc was the only thing that
// had drifted, so the fix is to project it rather than restate it. Improve an entry by
// improving the script's own first line; there is nowhere else to edit it.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const DOC = join(ROOT, "docs", "scripts.md");
const BEGIN = "<!-- BEGIN GENERATED INDEX -->";
const END = "<!-- END GENERATED INDEX -->";

interface Entry { path: string; purpose: string }

// The opening comment paragraph's first sentence. Reading one PHYSICAL line is not
// enough — most headers wrap, and cutting at the newline produced entries like
// "the stdlib is regenerated into". Lines are joined until a blank comment line or the
// end of the comment block, then the text is cut at the first sentence terminator.
const MAX_PURPOSE = 200;

// Exported: scripts/gen-src-doc.ts projects src/ the same way, and two copies of a
// comment parser drift apart.
export function purposeOf(file: string): string | null {
  const words: string[] = [];
  for (const raw of readFileSync(file, "utf-8").split("\n").slice(0, 24)) {
    const line = raw.trim();
    if (line.startsWith("#!")) continue;
    if (/^#\s*shellcheck/.test(line)) continue;
    const m = /^(?:\/\/|#)\s?(.*)$/.exec(line);
    if (!m) {
      if (line === "" && words.length === 0) continue; // blank line before the header
      break;                                            // code, or a blank line after it
    }
    const text = m[1]!.trim();
    if (text === "") break;                             // blank comment line ends the paragraph
    words.push(text);
    // A terminator inside the accumulated text means the first sentence is complete.
    if (/[.?!]$/.test(text) || /[.?!]\s/.test(words.join(" "))) break;
  }
  if (words.length === 0) return null;
  const para = words.join(" ");
  const cut = /^(.*?[.?!])(?:\s|$)/.exec(para);
  const out = (cut?.[1] ?? para).trim();
  return out.length > MAX_PURPOSE ? out.slice(0, MAX_PURPOSE - 1).trimEnd() + "…" : out;
}

// git, not readdir: a script kept local (untracked, listed in .git/info/exclude) exists on
// one machine only, and indexing it made the doc fail on every other checkout, CI included.
export function trackedFiles(dir: string): string[] {
  return execFileSync("git", ["ls-files", "--", dir], { cwd: ROOT, encoding: "utf-8" })
    .split("\n").filter(Boolean).map(p => p.slice(dir.length + 1)).filter(f => !f.includes("/")).sort();
}

function collect(): Entry[] {
  const out: Entry[] = [];
  const dirs: [string, (f: string) => boolean][] = [
    ["scripts", f => f.endsWith(".ts") || f.endsWith(".sh")],
    [".githooks", () => true],
  ];
  for (const [dir, keep] of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of trackedFiles(dir)) {
      if (!keep(f)) continue;
      const purpose = purposeOf(join(abs, f));
      if (purpose === null) {
        throw new Error(`${dir}/${f} has no leading purpose comment — docs/scripts.md requires one (see "How to write one well")`);
      }
      out.push({ path: `${dir}/${f}`, purpose });
    }
  }
  return out;
}

function table(): string {
  const rows = collect().map(e => `| \`${e.path}\` | ${e.purpose.replace(/\|/g, "\\|")} |`);
  return [BEGIN, "| Script | Purpose |", "|---|---|", ...rows, END].join("\n");
}

function rewrite(doc: string): string {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`docs/scripts.md is missing the ${BEGIN} / ${END} markers`);
  return doc.slice(0, start) + table() + doc.slice(end + END.length);
}

// The CLI half must not run on import — gen-src-doc.ts imports purposeOf, and a doc
// generator that rewrites files as a side effect of being imported is a trap.
if (import.meta.main) {
  const current = readFileSync(DOC, "utf-8");
  const next = rewrite(current);
  if (process.argv.includes("--check")) {
    if (current !== next) {
      console.error("docs/scripts.md index is stale — run: bun run scripts/gen-scripts-doc.ts");
      process.exit(1);
    }
    console.log("docs/scripts.md index is up to date");
  } else {
    writeFileSync(DOC, next);
    console.log(`wrote the index in ${DOC}`);
  }
}
