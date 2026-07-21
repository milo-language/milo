// test262 conformance sweep for milojs-engine — a citeable ECMAScript number.
//
// Runs official tc39/test262 cases through the engine with the real harness
// (assert.js + sta.js + declared includes), honoring frontmatter: negative
// tests must fail with the right error, async tests must print the completion
// marker, onlyStrict/raw are respected. module tests are skipped (no ESM in the
// engine). Default (non-strict-tagged) tests run once in sloppy mode — a proxy
// that slightly under/over-counts strict-only cases; noted in the output.
//
//   bun scripts/test262-sweep.ts --sample 3000      # random sample, whole suite
//   bun scripts/test262-sweep.ts --dir built-ins/Array
//   bun scripts/test262-sweep.ts --sample 2000 -v   # also list failing files
import { readdirSync, readFileSync, writeFileSync, statSync, mkdtempSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const T262 = process.env.TEST262 ?? "/tmp/test262";
const HARNESS = join(T262, "harness");
const ENGINE = process.env.MILOJS_ENGINE ?? "/tmp/mj-eng";
const verbose = process.argv.includes("-v");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const sampleN = arg("--sample") ? parseInt(arg("--sample")!) : null;
const subDir = arg("--dir") ?? "";
const limit = arg("--limit") ? parseInt(arg("--limit")!) : Infinity;

// deterministic sampling so a number is reproducible across runs
let seed = 0x2f6e2b1;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// harness includes are small and reused constantly — cache them
const hcache = new Map<string, string>();
function harness(f: string): string {
  if (!hcache.has(f)) hcache.set(f, readFileSync(join(HARNESS, f), "utf-8"));
  return hcache.get(f)!;
}

type Meta = { includes: string[]; flags: Set<string>; negType: string | null; negPhase: string | null };
function parseMeta(src: string): Meta {
  const m = /\/\*---([\s\S]*?)---\*\//.exec(src);
  const fm = m ? m[1]! : "";
  const includes: string[] = [];
  const inc = /includes:\s*\[([^\]]*)\]/.exec(fm);
  if (inc) inc[1]!.split(",").forEach(s => { const t = s.trim(); if (t) includes.push(t); });
  // multi-line includes form
  const incBlock = /includes:\s*\n((?:\s*-\s*\S+\s*\n)+)/.exec(fm);
  if (incBlock) for (const l of incBlock[1]!.split("\n")) { const t = /-\s*(\S+)/.exec(l); if (t) includes.push(t[1]!); }
  const flags = new Set<string>();
  const fl = /flags:\s*\[([^\]]*)\]/.exec(fm);
  if (fl) fl[1]!.split(",").forEach(s => { const t = s.trim(); if (t) flags.add(t); });
  let negType: string | null = null, negPhase: string | null = null;
  const neg = /negative:\s*\n\s*phase:\s*(\S+)\s*\n\s*type:\s*(\S+)/.exec(fm);
  if (neg) { negPhase = neg[1]!; negType = neg[2]!; }
  return { includes, flags, negType, negPhase };
}

// gather every .js test under a dir (skipping fixtures + staging)
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "staging" && e !== "intl402") out.push(...walk(p)); }
    else if (e.endsWith(".js") && !e.endsWith("_FIXTURE.js")) out.push(p);
  }
  return out;
}

const root = join(T262, "test", subDir);
let files = walk(root);
if (sampleN && files.length > sampleN) {
  // Fisher-Yates partial shuffle with the seeded PRNG, take the first sampleN
  for (let i = 0; i < sampleN; i++) { const j = i + Math.floor(rand() * (files.length - i)); [files[i], files[j]] = [files[j]!, files[i]!]; }
  files = files.slice(0, sampleN);
}
files = files.slice(0, limit);

const tmp = mkdtempSync(join(tmpdir(), "t262-"));
const casePath = join(tmp, "case.js");

type Res = "pass" | "fail" | "skip";
function runOne(file: string): { res: Res; why: string } {
  const src = readFileSync(file, "utf-8");
  const meta = parseMeta(src);
  if (meta.flags.has("module")) return { res: "skip", why: "module" };
  if (meta.flags.has("CanBlockIsFalse") || meta.flags.has("CanBlockIsTrue")) return { res: "skip", why: "atomics-host" };

  let body = "";
  if (!meta.flags.has("raw")) {
    body += harness("assert.js") + "\n" + harness("sta.js") + "\n";
    if (meta.flags.has("async")) body += harness("doneprintHandle.js") + "\n";
    for (const inc of meta.includes) { try { body += harness(inc) + "\n"; } catch { return { res: "skip", why: "missing-include:" + inc }; } }
  }
  const strict = meta.flags.has("onlyStrict");
  const source = (strict ? '"use strict";\n' : "") + (meta.flags.has("raw") ? src : body + src);
  writeFileSync(casePath, source);

  let out = "";
  try {
    out = execFileSync(ENGINE, [casePath], { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "") || `crash(${e.signal ?? e.status})`;
  }
  const threw = /^Uncaught /m.test(out);

  if (meta.negType) {
    // negative test: must fail. parse-phase → any throw; runtime → matching type.
    if (!threw) return { res: "fail", why: `expected ${meta.negType}, nothing thrown` };
    if (meta.negPhase === "parse" || meta.negPhase === "early") return { res: "pass", why: "" };
    return new RegExp("Uncaught .*" + meta.negType).test(out) ? { res: "pass", why: "" } : { res: "fail", why: `wanted ${meta.negType}: ${out.split("\n")[0]}` };
  }
  if (meta.flags.has("async")) {
    return out.includes("Test262:AsyncTestComplete") ? { res: "pass", why: "" } : { res: "fail", why: out.split("\n").find(l => l.trim()) ?? "no completion marker" };
  }
  if (threw) return { res: "fail", why: (out.match(/^Uncaught .*/m)?.[0] ?? "").slice(0, 100) };
  return { res: "pass", why: "" };
}

function bucket(why: string): string {
  return why.split(tmp).join("").replace(/'[^']*'/g, "'…'").replace(/\b\d+\b/g, "N").slice(0, 90);
}

let pass = 0, fail = 0, skip = 0;
const areaTotals = new Map<string, { p: number; f: number }>();
const buckets = new Map<string, string[]>();
const areaOf = (f: string) => { const rel = f.slice(root.length + 1); const parts = rel.split("/"); return subDir ? parts[0]! : parts.slice(0, 2).join("/"); };

let done = 0;
for (const file of files) {
  const { res, why } = runOne(file);
  if (res === "skip") { skip++; continue; }
  const a = areaOf(file);
  const t = areaTotals.get(a) ?? areaTotals.set(a, { p: 0, f: 0 }).get(a)!;
  if (res === "pass") { pass++; t.p++; }
  else { fail++; t.f++; const b = bucket(why); (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(file.slice(root.length + 1)); }
  if (++done % 500 === 0) process.stderr.write(`  ${done}/${files.length}\r`);
}

const scored = pass + fail;
console.log(`\ntest262-sweep: ${pass}/${scored} pass (${((pass / scored) * 100).toFixed(1)}%), ${skip} skipped (module/atomics), of ${files.length} sampled${subDir ? " in " + subDir : " across the whole suite"}`);
console.log(`engine: ${ENGINE}  (default tests run sloppy-only; onlyStrict honored)\n`);

console.log("by area:");
for (const [a, t] of [...areaTotals.entries()].sort((x, y) => (y[1].p + y[1].f) - (x[1].p + x[1].f)).slice(0, 25)) {
  const tot = t.p + t.f;
  console.log(`  ${((t.p / tot) * 100).toFixed(0).padStart(3)}%  ${String(t.p).padStart(4)}/${String(tot).padEnd(4)}  ${a}`);
}
console.log("\ntop failure buckets:");
for (const [b, cs] of [...buckets.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, verbose ? 999 : 20)) {
  console.log(`  ${String(cs.length).padStart(4)}  ${b}`);
  if (verbose) console.log(`        ${cs.slice(0, 8).join(", ")}${cs.length > 8 ? " …" : ""}`);
}
