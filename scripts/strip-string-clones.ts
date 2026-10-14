// Deletes `.clone()` calls on strings: strings are values (copy on write, shared by count
// where the code reads them again), so every string clone is redundant and removing one
// changes no behaviour.
//
// Type-directed, not a regex: each candidate comes from the checker
// (MILO_REPORT_STRING_CLONES=1 makes `milo check` print every `.clone()` whose receiver is
// a `string`, outside generic instances and never one whose copy is then mutated). The
// script checks every .milo file under the given paths, deletes the reported `.clone()`
// text in files under those paths, re-checks, and puts back any file that stops checking.
//
//   bun scripts/strip-string-clones.ts [--dry-run] [--keep-closure <entry.milo>]... <dir|file>...
//
//   --dry-run              report what would change, write nothing
//   --keep-closure <file>  leave alone every file that <file> imports, directly or not
//                          (the self-hosted compiler's std closure: milo-self has no value
//                          strings, so a clone it needs must stay)
//
// It does not prove outputs unchanged; run the programs before and after.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { cpus } from "os";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keepEntries: string[] = [];
const roots: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dry-run") continue;
  if (args[i] === "--keep-closure") { keepEntries.push(resolve(args[++i]!)); continue; }
  roots.push(resolve(args[i]!));
}
if (roots.length === 0) {
  console.error("usage: bun scripts/strip-string-clones.ts [--dry-run] [--keep-closure <entry.milo>]... <dir|file>...");
  process.exit(2);
}

function miloFiles(p: string): string[] {
  if (statSync(p).isFile()) return p.endsWith(".milo") ? [p] : [];
  const out: string[] = [];
  for (const e of readdirSync(p)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    out.push(...miloFiles(join(p, e)));
  }
  return out;
}

const files = roots.flatMap(miloFiles);
const inRoots = (f: string) => roots.some(r => f === r || f.startsWith(r + "/"));

// Every file an entry compiles, from the spans of its merged AST (tooling reads the
// compiler's JSON, not src/).
function closureOf(entry: string): Set<string> {
  const r = spawnSync("bun", ["run", MAIN, "emit-ast", entry, "--all", "--spans"], { encoding: "utf-8", maxBuffer: 1 << 30 });
  const seen = new Set<string>();
  for (const m of r.stdout.matchAll(/"file":\s*"([^"]+)"/g)) {
    const f = resolve(m[1]!);
    seen.add(f);
    // The resolver picked this host's platform arm; the entry builds every other arm on
    // its own host, so those are in its closure too.
    const arm = /^(.*)\.(darwin|linux|windows)\.milo$/.exec(f);
    if (arm) for (const os of ["darwin", "linux", "windows"]) seen.add(`${arm[1]}.${os}.milo`);
  }
  if (seen.size === 0) throw new Error(`--keep-closure ${entry}: emit-ast listed no files:\n${r.stderr}`);
  return seen;
}
const kept = new Set<string>();
for (const e of keepEntries) for (const f of closureOf(e)) kept.add(f);

type Site = { file: string; line: number; col: number };

// Runs `milo check` on every file, JOBS at a time. Returns the reported sites and the
// files that failed to check.
async function checkAll(list: string[]): Promise<{ sites: Site[]; failed: Set<string> }> {
  const sites: Site[] = [];
  const failed = new Set<string>();
  const jobs = Math.max(1, Math.min(4, cpus().length - 1));
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const f = list[next++]!;
      const p = Bun.spawn(["bun", "run", MAIN, "check", f], {
        env: { ...process.env, MILO_REPORT_STRING_CLONES: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const err = await new Response(p.stderr).text();
      const code = await p.exited;
      if (code !== 0) failed.add(f);
      for (const m of err.matchAll(/^MILO_STRING_CLONE (.*)$/gm)) sites.push(JSON.parse(m[1]!));
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  return { sites, failed };
}

const MUTATORS = new Set(["push", "pushStr", "setByte", "clear", "truncate", "pushInt"]);

// The byte range of `.clone()` for the `clone` token at line:col (1-based), or null when
// the text is not exactly that or the copy is mutated in place (`s.clone().push(1)`).
function cloneRange(text: string, lineStarts: number[], line: number, col: number): [number, number] | null {
  const at = lineStarts[line - 1]! + col - 1;
  const m = /^clone\s*\(\s*\)/.exec(text.slice(at));
  if (!m) return null;
  let dot = at - 1;
  while (dot >= 0 && /\s/.test(text[dot]!)) dot--;
  if (text[dot] !== ".") return null;
  const end = at + m[0].length;
  const after = /^\s*\.\s*([A-Za-z_]\w*)/.exec(text.slice(end));
  if (after && MUTATORS.has(after[1]!)) return null;
  return [dot, end];
}

function lineStartsOf(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

// Deletes the ranges; a line left blank by a deletion (a `.clone()` alone on a chain line)
// goes with it, since a blank line inside a chain would end the statement.
function applyRanges(text: string, ranges: [number, number][]): string {
  let out = text;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) {
    let s = a, e = b;
    const ls = out.lastIndexOf("\n", s - 1) + 1;
    const le = out.indexOf("\n", e);
    const lineEnd = le < 0 ? out.length : le;
    if (out.slice(ls, s).trim() === "" && out.slice(e, lineEnd).trim() === "") { s = ls; e = le < 0 ? lineEnd : lineEnd + 1; }
    out = out.slice(0, s) + out.slice(e);
  }
  return out;
}

const before = await checkAll(files);
const byFile = new Map<string, Map<string, Site>>();
for (const s of before.sites) {
  const f = resolve(s.file);
  if (!inRoots(f) || kept.has(f) || !existsSync(f)) continue;
  let m = byFile.get(f);
  if (!m) byFile.set(f, m = new Map());
  m.set(`${s.line}:${s.col}`, s);
}

const original = new Map<string, string>();
const counts = new Map<string, number>();
let removed = 0, skipped = 0;
for (const [f, sites] of byFile) {
  const text = readFileSync(f, "utf-8");
  const starts = lineStartsOf(text);
  const ranges: [number, number][] = [];
  for (const s of sites.values()) {
    const r = cloneRange(text, starts, s.line, s.col);
    if (r) ranges.push(r); else skipped++;
  }
  if (ranges.length === 0) continue;
  original.set(f, text);
  counts.set(f, ranges.length);
  removed += ranges.length;
  if (dryRun) console.log(`${f}: ${ranges.length}`);
  else writeFileSync(f, applyRanges(text, ranges));
}

if (!dryRun && original.size > 0) {
  // Re-check every program that checked before; a file whose programs now fail goes back.
  const after = await checkAll(files.filter(f => !before.failed.has(f)));
  const broken = [...after.failed];
  if (broken.length) {
    console.log(`now failing to check: ${broken.join(", ")}`);
    console.log("restoring every touched file those import or are; rerun with the culprit excluded");
    for (const [f, text] of original) writeFileSync(f, text);
    process.exit(1);
  }
}
if (!dryRun) for (const [f, n] of counts) console.log(`${f}: ${n}`);
console.log(`${dryRun ? "would remove" : "removed"} ${removed} string .clone() call(s) in ${original.size} file(s); ${skipped} reported site(s) left as is; ${before.failed.size} file(s) did not check before and were only scanned`);
