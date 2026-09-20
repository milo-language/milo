#!/usr/bin/env bun
// Census of every .milo file in the org: what the ownership model costs real programs.
//
// The second-class-reference bet says programs restructure to owned values, pools and
// indices instead of reaching for `unsafe`. This script is the falsifier. Per root it
// counts lines, fns, `unsafe` blocks split by why they exist (FFI: an extern call or a
// pointer cast; rawptr: a deref, `.ptr()`, `.addrOf()`, `Heap<`; other: neither, the
// interesting ones), `.clone()` and `.substr(` per kLOC, arena read spellings, the
// attribute histogram, and comments that name a Milo limit. `--check` is the gate:
// the non-FFI unsafe counts may shrink, never grow, against the committed baseline.
//
// Roots: std, examples, src-milo, tests/fixtures here, plus every sibling under
// ~/git/milo-language (MILO_PACKAGES_ROOT) that exists; missing checkouts are skipped
// like check-packages.sh does. Worktrees, node_modules and dot-dirs are excluded.
//
// Usage: bun scripts/corpus-census.ts [--json] [--check] [--comments] [root-filter]
//   --json      dump everything (per-root metrics, every non-FFI block with its comment)
//   --check     compare unsafe_nonffi per root and the total outside std against
//               scripts/corpus-census.baseline.json; exit 1 on growth
//   --comments  print the preceding comment of each non-FFI unsafe block
//   MILO_CENSUS_UPDATE=1 rewrites the baseline from this run
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(import.meta.dir, "..");
const BASELINE = join(REPO, "scripts", "corpus-census.baseline.json");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const check = args.includes("--check");
const showComments = args.includes("--comments");
const filter = args.find(a => !a.startsWith("--"));
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
  process.exit(0);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules" || e === "worktrees") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".milo")) out.push(p);
  }
  return out;
}

// Root name -> directory. The repo's own roots are split so std is measured apart from
// programs written against it; siblings are one root each.
const roots: [string, string][] = [
  ["std", join(REPO, "std")],
  ["examples", join(REPO, "examples")],
  ["src-milo", join(REPO, "src-milo")],
  ["fixtures", join(REPO, "tests", "fixtures")],
];
const PKG = process.env.MILO_PACKAGES_ROOT ?? join(homedir(), "git", "milo-language");
if (existsSync(PKG)) {
  for (const e of readdirSync(PKG).sort()) {
    const p = join(PKG, e);
    if (e.startsWith(".") || !statSync(p).isDirectory()) continue;
    if (resolve(p) === REPO || (existsSync(join(p, "std")) && existsSync(join(p, "src-milo")))) continue; // the compiler checkout itself
    roots.push([e, p]);
  }
}

// Every extern fn name in the corpus: a call to one of these is what makes an unsafe
// block FFI. Collected up front so a block in a sibling that calls std's extern counts,
// and from the package cache too, so an example built against the gl package classifies
// the same whether or not the milo-gl checkout is present.
const externSources = roots.flatMap(([, d]) => walk(d)).concat(walk(join(homedir(), ".milo", "cache")));
const externs = new Set<string>();
for (const f of externSources) {
  for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:pub\s+)?extern\s+fn\s+(\w+)/gm)) externs.add(m[1]);
}
const externCall = new RegExp("\\b(" + [...externs].join("|") + ")\\s*\\(");

const FRICTION = /workaround|can'?t (?:return|store|borrow|hold)|cannot (?:return|store|borrow|hold)|no lifetimes|second-class|Milo (?:has no|does not|doesn'?t|can'?t|cannot)/i;

type Block = { file: string; line: number; kind: "ffi" | "rawptr" | "other"; comment: string };
type Metrics = {
  files: number; lines: number; kloc: number; fns: number;
  unsafe: number; unsafe_ffi: number; unsafe_rawptr: number; unsafe_other: number; unsafe_nonffi: number;
  clone: number; clone_per_kloc: number; substr: number; substr_per_kloc: number;
  arena_get: number; arena_borrow: number; ptr: number; addrOf: number; heap: number;
  attrs: Record<string, number>; friction: { file: string; line: number; text: string }[];
  blocks: Block[];
};

// Walk from the `{` after `unsafe` to its matching brace, skipping strings and comments.
function unsafeBlockEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

function precedingComment(lines: string[], lineIdx: number): string {
  const out: string[] = [];
  for (let i = lineIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("//")) out.unshift(t.replace(/^\/\/\s?/, ""));
    else if (t === "" && out.length === 0) continue;
    else break;
  }
  // Inline comment on the `unsafe {` line itself counts too.
  const inline = lines[lineIdx].match(/\/\/\s?(.*)$/);
  if (inline) out.push(inline[1]);
  return out.join(" ").slice(0, 240);
}

function census(dir: string): Metrics {
  const files = walk(dir);
  const m: Metrics = {
    files: files.length, lines: 0, kloc: 0, fns: 0,
    unsafe: 0, unsafe_ffi: 0, unsafe_rawptr: 0, unsafe_other: 0, unsafe_nonffi: 0,
    clone: 0, clone_per_kloc: 0, substr: 0, substr_per_kloc: 0,
    arena_get: 0, arena_borrow: 0, ptr: 0, addrOf: 0, heap: 0,
    attrs: {}, friction: [], blocks: [],
  };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    const rel = relative(dir, f);
    m.lines += lines.length;
    m.fns += (src.match(/^\s*(?:pub\s+)?(?:extern\s+)?fn\s+\w+/gm) ?? []).length;
    m.clone += (src.match(/\.clone\(\)/g) ?? []).length;
    m.substr += (src.match(/\.substr\(/g) ?? []).length;
    m.arena_get += (src.match(/\barenaGet\(/g) ?? []).length;
    m.arena_borrow += (src.match(/\b(?:arenaWith|arenaRead|arenaModifyMut)\(/g) ?? []).length;
    m.ptr += (src.match(/\.ptr\(\)/g) ?? []).length;
    m.addrOf += (src.match(/\.addrOf\(/g) ?? []).length;
    m.heap += (src.match(/\bHeap</g) ?? []).length;
    for (const a of src.matchAll(/^\s*@(\w+)/gm)) m.attrs[a[1]] = (m.attrs[a[1]] ?? 0) + 1;
    lines.forEach((l, i) => {
      const c = l.indexOf("//");
      if (c >= 0 && FRICTION.test(l.slice(c))) m.friction.push({ file: rel, line: i + 1, text: l.slice(c + 2).trim() });
    });
    for (const u of src.matchAll(/\bunsafe\s*\{/g)) {
      const open = u.index! + u[0].length - 1;
      const body = src.slice(open, unsafeBlockEnd(src, open) + 1);
      const line = src.slice(0, u.index!).split("\n").length;
      const kind: Block["kind"] =
        externCall.test(body) || /\bas\s+\*/.test(body) ? "ffi"
        : /(^|[^\w.])\*[\w(]|\.ptr\(\)|\.addrOf\(|\bHeap</.test(body) ? "rawptr"
        : "other";
      m.unsafe++;
      m[`unsafe_${kind}`]++;
      if (kind !== "ffi") m.blocks.push({ file: rel, line, kind, comment: precedingComment(lines, line - 1) });
    }
  }
  m.kloc = m.lines / 1000;
  m.unsafe_nonffi = m.unsafe_rawptr + m.unsafe_other;
  m.clone_per_kloc = m.kloc ? +(m.clone / m.kloc).toFixed(1) : 0;
  m.substr_per_kloc = m.kloc ? +(m.substr / m.kloc).toFixed(1) : 0;
  return m;
}

const results: Record<string, Metrics> = {};
for (const [name, dir] of roots) {
  if (filter && !name.includes(filter)) continue;
  if (!existsSync(dir)) continue;
  const r = census(dir);
  if (r.files > 0) results[name] = r;
}

const total = Object.values(results).reduce((a, r) => ({
  lines: a.lines + r.lines, unsafe: a.unsafe + r.unsafe, ffi: a.ffi + r.unsafe_ffi,
  nonffi: a.nonffi + r.unsafe_nonffi, clone: a.clone + r.clone,
}), { lines: 0, unsafe: 0, ffi: 0, nonffi: 0, clone: 0 });
const nonffiOutsideStd = Object.entries(results).filter(([n]) => n !== "std").reduce((a, [, r]) => a + r.unsafe_nonffi, 0);

if (asJson) {
  console.log(JSON.stringify({ roots: results, total, nonffi_outside_std: nonffiOutsideStd }, null, 2));
} else {
  const cols = ["root", "kloc", "fns", "unsafe", "ffi", "rawptr", "other", "clone/k", "substr/k", "arenaGet", "arenaBorrow", "ptr()", "addrOf", "Heap<"];
  const rows = Object.entries(results).map(([n, r]) => [
    n, r.kloc.toFixed(1), r.fns, r.unsafe, r.unsafe_ffi, r.unsafe_rawptr, r.unsafe_other,
    r.clone_per_kloc, r.substr_per_kloc, r.arena_get, r.arena_borrow, r.ptr, r.addrOf, r.heap,
  ].map(String));
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  console.log(fmt(cols));
  for (const r of rows) console.log(fmt(r));
  const pct = total.unsafe ? Math.round((100 * total.ffi) / total.unsafe) : 0;
  console.log(`\n${(total.lines / 1000).toFixed(0)}k lines; ${total.unsafe} unsafe blocks, ${total.ffi} (${pct}%) FFI; ${total.nonffi} non-FFI, ${nonffiOutsideStd} of those outside std`);
  const attrs: Record<string, number> = {};
  for (const [n, r] of Object.entries(results)) {
    if (n === "std" || n === "fixtures" || n === "src-milo") continue;
    for (const [a, c] of Object.entries(r.attrs)) attrs[a] = (attrs[a] ?? 0) + c;
  }
  console.log("attributes outside std/fixtures/src-milo: " + Object.entries(attrs).sort((a, b) => b[1] - a[1]).map(([a, c]) => `${a} ${c}`).join(", "));
  const friction = Object.entries(results).filter(([n]) => n !== "std" && n !== "fixtures").map(([n, r]) => `${n} ${r.friction.length}`).join(", ");
  console.log("friction comments outside std/fixtures: " + friction);
  if (showComments) {
    for (const [n, r] of Object.entries(results)) for (const b of r.blocks) console.log(`  ${n}/${b.file}:${b.line} [${b.kind}] ${b.comment || "(no comment)"}`);
    for (const [n, r] of Object.entries(results)) for (const f of r.friction) console.log(`  friction ${n}/${f.file}:${f.line}: ${f.text}`);
  }
}

if (check || process.env.MILO_CENSUS_UPDATE) {
  const now: Record<string, number> = { "(outside std)": nonffiOutsideStd };
  for (const [n, r] of Object.entries(results)) now[n] = r.unsafe_nonffi;
  if (process.env.MILO_CENSUS_UPDATE) {
    writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log(`baseline written: ${relative(REPO, BASELINE)}`);
  } else {
    if (!existsSync(BASELINE)) { console.error(`no baseline at ${BASELINE}; run with MILO_CENSUS_UPDATE=1`); process.exit(2); }
    const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
    // A filtered run measures a subset, and a subset can only look like a shrink; refuse
    // to call that a pass. A sibling checkout missing from this run is skipped and named.
    if (filter) { console.error("--check does not take a root filter"); process.exit(2); }
    const absent = Object.keys(base).filter(n => !(n in now));
    if (absent.length) console.log(`not measured (checkout absent): ${absent.join(", ")}`);
    const grew = Object.entries(now).filter(([n, v]) => n in base && v > base[n]).map(([n, v]) => `${n}: ${base[n]} -> ${v}`);
    const shrank = Object.entries(now).filter(([n, v]) => n in base && v < base[n]).map(([n, v]) => `${n}: ${base[n]} -> ${v}`);
    if (shrank.length) console.log(`non-FFI unsafe shrank (refresh the baseline with MILO_CENSUS_UPDATE=1): ${shrank.join(", ")}`);
    if (grew.length) { console.error(`non-FFI unsafe blocks GREW: ${grew.join(", ")}\nEach new one needs a comment saying why the ownership model could not carry it.`); process.exit(1); }
    console.log("census gate: OK (non-FFI unsafe did not grow)");
  }
}
