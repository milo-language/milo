// Generates docs/site/language/errors.md, every compile error the test suite pins, with the program
// that provokes it.
//
// One copy, on the docs site. It used to be docs/errors.md, outside the site, where the only
// readers were agents grepping the repo; a user hitting the error never saw it.
//
// Run:  bun run scripts/gen-error-catalog.ts          # rewrite the catalog
//       bun run scripts/gen-error-catalog.ts --check  # fail if it is stale (CI/test)
//
// tests/errors/ already holds 242 programs, each annotated with the message it must
// produce and many with a comment explaining why the rule exists. That is a reference
// manual nobody could read: it was 242 files with no index, and a user hitting
// "cannot move out of a borrow" had nowhere to look it up. Nothing here is written by
// hand — improve an entry by improving the fixture's own comment.
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseExpectedError } from "../tests/annotations";

const ROOT = join(import.meta.dir, "..");
const ERRORS_DIR = join(ROOT, "tests", "errors");
const OUT = join(ROOT, "docs", "site", "language", "errors.md");
// Fixtures link to their source on GitHub: a relative link out of docs/site is a dead
// link to VitePress, which fails the build on one.
const REPO_BLOB = "https://github.com/milo-language/milo/blob/main";

interface ErrorCase {
  file: string;
  message: string;
  /** The fixture's own explanation, if it opens with one. */
  rationale: string;
  /** The program, with the annotation and rationale stripped. */
  program: string;
}

export function cases(): ErrorCase[] {
  const out: ErrorCase[] = [];
  for (const file of readdirSync(ERRORS_DIR).filter(f => f.endsWith(".milo")).sort()) {
    const source = readFileSync(join(ERRORS_DIR, file), "utf-8");
    const lines = source.split("\n");
    // The same parser the test driver uses, so the catalog and the gate can never
    // disagree about what a fixture asserts.
    const message = parseExpectedError(source);
    if (!message) throw new Error(`tests/errors/${file} has no // @error: annotation`);

    // Everything before the first non-comment, non-blank line is header: the
    // annotations plus, sometimes, a paragraph saying why the rule exists.
    let i = 0;
    const header: string[] = [];
    for (; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t === "") { header.push(""); continue; }
      if (!t.startsWith("//")) break;
      header.push(t);
    }
    const rationale = header
      .filter(l => l.startsWith("//") && !/@(error|expect|skip-os|run)\b/.test(l))
      .map(l => l.replace(/^\/\/\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    out.push({ file, message: message.trim(), rationale, program: lines.slice(i).join("\n").trim() });
  }
  return out;
}

function byMessage(all: ErrorCase[]): Map<string, ErrorCase[]> {
  const m = new Map<string, ErrorCase[]>();
  for (const c of all) m.set(c.message, [...(m.get(c.message) ?? []), c]);
  return new Map([...m].sort((a, b) => a[0].localeCompare(b[0])));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// A code span that survives a backtick inside the message.
function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map(r => r.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

// Fixture comments are plain prose. On a VitePress page `<T>` in prose is an unclosed HTML
// tag that fails the Vue compile, and `*`/`_` can open emphasis; escape them outside code spans.
const prose = (text: string) =>
  text.split(/(`[^`]*`)/).map((part, i) => i % 2 ? part : part.replace(/([\\*_<>[\]])/g, "\\$1")).join("");

export function render(): string {
  const all = cases();
  const grouped = byMessage(all);
  // Explicit heading ids: VitePress slugs headings its own way, and the index has to land
  // on them. Two messages that differ only in punctuation slug alike; the second gets a suffix.
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const msg of grouped.keys()) {
    let id = slug(msg) || "error";
    for (let n = 2; used.has(id); n++) id = `${slug(msg)}-${n}`;
    used.add(id);
    ids.set(msg, id);
  }
  const lines: string[] = [
    "---",
    // 357 headings make the right-hand outline unusable; the index below replaces it.
    "outline: false",
    "---",
    "",
    "<!-- doc-meta",
    "system: error-catalog",
    "purpose: every compile error the suite pins, with the program that provokes it and why the rule exists",
    "key-files: tests/errors/, scripts/gen-error-catalog.ts, src/diagnostics.ts, tests/errorCatalog.test.ts",
    "update-when: never by hand; regenerate with `bun run scripts/gen-error-catalog.ts`",
    "last-verified: generated",
    "-->",
    "",
    "# Compile errors",
    "",
    `Every error message the test suite pins: ${grouped.size} distinct messages across ${all.length} programs the compiler must reject.`,
    "Each entry is the message, why the rule exists when the fixture says, and the program that provokes it.",
    "Find an error by searching this page for the text the compiler printed.",
    "",
    "This page is generated from `tests/errors/` by `scripts/gen-error-catalog.ts`. Improve an entry by",
    "improving the fixture or its leading comment, then regenerate. For warnings, which have names and",
    "flags, see [Warnings & errors](./warnings-and-errors#warnings).",
    "",
    "## Index {#index}",
    "",
  ];
  for (const msg of grouped.keys()) lines.push(`- [${code(msg)}](#${ids.get(msg)})`);
  lines.push("");

  for (const [msg, group] of grouped) {
    lines.push(`## ${code(msg)} {#${ids.get(msg)}}`, "");
    for (const c of group) {
      if (c.rationale) lines.push(prose(c.rationale), "");
      // `skip`: tests/run.test.ts already compiles every fixture and holds it to its message,
      // with the full build (a @cValue mismatch is caught at link time, not by the checker
      // the site's snippet harness runs), so a second, weaker check here adds nothing.
      lines.push("```milo skip", c.program, "```", "");
      lines.push(`<sub>[tests/errors/${c.file}](${REPO_BLOB}/tests/errors/${c.file})</sub>`, "");
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const next = render();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(OUT, "utf-8"); } catch { /* not generated yet */ }
    if (current !== next) {
      console.error("docs/site/language/errors.md is stale; run: bun run scripts/gen-error-catalog.ts");
      process.exit(1);
    }
    console.log("docs/site/language/errors.md is up to date");
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${OUT}`);
  }
}
