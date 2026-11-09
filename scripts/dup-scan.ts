#!/usr/bin/env bun
// Duplicate-code scanner: finds maximal runs of identical normalized lines shared by
// two or more places, within or across files. The dup-unifier maintenance routine
// needs a number it cannot game, and "longest clone in the repo" is that number.
//
// Normalization drops blank/comment/trivial-punctuation lines and collapses
// whitespace, so indentation and formatting churn do not hide a clone. Identifiers
// and literals are kept verbatim: a Type-1/Type-2 clone is actionable, a
// rename-blind match usually is not.
//
//   bun scripts/dup-scan.ts                        # default corpus, top 30
//   bun scripts/dup-scan.ts --min 12 --top 50
//   bun scripts/dup-scan.ts --glob 'src/**/*.ts'
//   bun scripts/dup-scan.ts --max-lines 40         # gate: exit 1 if a clone exceeds N
//   bun scripts/dup-scan.ts --platform-arms         # also report cross-platform-arm clones
import { readFileSync } from "fs";
import { execSync } from "child_process";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1]! : d;
};
const MIN = Number(flag("--min", "8"));
const TOP = Number(flag("--top", "30"));
const GATE = argv.includes("--max-lines") ? Number(flag("--max-lines", "0")) : 0;
// std/x.darwin.milo and std/x.linux.milo are REQUIRED to expose the same surface — the
// filename suffix is the whole #ifdef mechanism, so identical text across the arms of one
// module is the design, not a defect. Counting it swamps the number with unfixable hits.
const KEEP_ARMS = argv.includes("--platform-arms");
const globs = argv.includes("--glob")
  ? [flag("--glob", "")]
  : ["src/*.ts", "src/**/*.ts", "std/*.milo", "std/**/*.milo"];

const files = [
  ...new Set(
    globs.flatMap((g) =>
      execSync(`git ls-files -- '${g}'`, { encoding: "utf8" }).split("\n").filter(Boolean),
    ),
  ),
].filter((f) => !f.includes("stdlib-bundle") && !f.includes("/dist/"));

// A line carries signal only if it survives normalization; a lone brace or a comment
// matches everywhere and would fuse unrelated clones into one giant bogus run.
function normalize(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return null;
  s = s.replace(/\s+/g, " ");
  if (s.replace(/[{}()\[\];,]/g, "").trim().length < 3) return null;
  return s;
}

type Line = { file: string; line: number; text: string };
const stream: Line[] = [];
const fileStart = new Map<string, number>();
for (const f of files) {
  let src: string;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  fileStart.set(f, stream.length);
  src.split("\n").forEach((raw, i) => {
    const t = normalize(raw);
    if (t !== null) stream.push({ file: f, line: i + 1, text: t });
  });
}

// Index every MIN-line window by its content; any bucket with >1 member is a clone seed.
const buckets = new Map<string, number[]>();
for (let i = 0; i + MIN <= stream.length; i++) {
  if (stream[i]!.file !== stream[i + MIN - 1]!.file) continue; // window must not straddle files
  const key = stream.slice(i, i + MIN).map((l) => l.text).join("\n");
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = []));
  b.push(i);
}

// Same module, different platform arm: std/net.darwin.milo vs std/net.linux.milo.
function samePlatformFamily(files: string[]): boolean {
  const stems = new Set(files.map((f) => f.replace(/\.(darwin|linux|windows|wasm)\.milo$/, "")));
  return stems.size === 1 && files.some((f) => /\.(darwin|linux|windows|wasm)\.milo$/.test(f));
}

type Clone = { len: number; sites: number[] };
const clones: Clone[] = [];
const armClones: Clone[] = [];
const covered = new Set<number>();
for (const [, starts] of buckets) {
  if (starts.length < 2) continue;
  if (starts.some((s) => covered.has(s))) continue;
  // Extend the match forward as far as every site agrees and stays inside its own file.
  let len = MIN;
  for (;;) {
    const next = starts.map((s) => s + len);
    if (next.some((n) => n >= stream.length)) break;
    if (next.some((n) => stream[n]!.file !== stream[starts[0]! + len - 1]!.file)) break;
    const t = stream[next[0]!]!.text;
    if (!next.every((n) => stream[n]!.text === t)) break;
    len++;
  }
  // Overlapping sites (a self-similar run) would report the same body twice.
  const sites: number[] = [];
  for (const s of starts.sort((a, b) => a - b)) {
    if (sites.length && s < sites[sites.length - 1]! + len) continue;
    sites.push(s);
  }
  if (sites.length < 2) continue;
  for (const s of sites) for (let k = 0; k < len; k++) covered.add(s + k);
  if (!KEEP_ARMS && samePlatformFamily(sites.map((s) => stream[s]!.file))) {
    armClones.push({ len, sites });
    continue;
  }
  clones.push({ len, sites });
}

clones.sort((a, b) => b.len * b.sites.length - a.len * a.sites.length);
const shown = clones.slice(0, TOP);

const dupLines = clones.reduce((n, c) => n + c.len * (c.sites.length - 1), 0);
console.log(
  `${files.length} files, ${stream.length} significant lines, ` +
    `${clones.length} clone groups >= ${MIN} lines, ${dupLines} duplicated lines ` +
    `(${((dupLines / stream.length) * 100).toFixed(1)}%)`,
);
// Never silently: a suppressed category that is not counted out loud reads as "clean".
console.log(
  armClones.length
    ? `${armClones.length} more group(s) skipped as platform-arm copies (--platform-arms to show)\n`
    : "",
);
for (const c of shown) {
  const where = c.sites.map((s) => `${stream[s]!.file}:${stream[s]!.line}`).join("  ==  ");
  console.log(`${String(c.len).padStart(4)} lines x${c.sites.length}  ${where}`);
  console.log(
    stream
      .slice(c.sites[0]!, c.sites[0]! + Math.min(c.len, 3))
      .map((l) => `      | ${l.text.slice(0, 100)}`)
      .join("\n"),
  );
}

if (GATE) {
  const worst = clones[0];
  const biggest = clones.reduce((m, c) => Math.max(m, c.len), 0);
  if (biggest > GATE) {
    console.error(`\nFAIL: longest clone is ${biggest} lines (max ${GATE}) at ` +
      `${stream[clones.find((c) => c.len === biggest)!.sites[0]!]!.file}`);
    process.exit(1);
  }
  void worst;
  console.log(`\nOK: longest clone ${biggest} lines <= ${GATE}`);
}
