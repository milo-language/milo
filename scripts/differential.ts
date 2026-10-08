#!/usr/bin/env bun
// Differential gate for codegen changes that must not change behaviour (LLVM attributes,
// optimisation flags): builds every runtime fixture and every `// @run:` example twice,
// as A and B, runs both and compares stdout and exit code. Any difference is a finding.
//
// A program whose A build disagrees with itself across two runs (hash seeds, clocks,
// addresses) is reported as nondeterministic rather than compared, so a real diff is
// never hidden behind flaky output.
//
// Usage: bun scripts/differential.ts --b-flags "--noalias" [--flags "--release"]
//          [--a-flags "..."] [--a-root <milo checkout>] [--b-root <milo checkout>]
//          [--filter <substring>] [-j N] [--no-examples] [--no-fixtures]
import { readdirSync, statSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { guardedRun } from "./guard";

function opt(name: string, def = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? def : def;
}
const split = (s: string) => s.split(/\s+/).filter(Boolean);
const here = resolve(import.meta.dir, "..");
const aRoot = resolve(opt("--a-root", here)), bRoot = resolve(opt("--b-root", here));
const common = split(opt("--flags")), aFlags = split(opt("--a-flags")), bFlags = split(opt("--b-flags"));
const filter = opt("--filter");
// 4 compiles at ~1GB each plus their children stays far under half of RAM (guard.ts math).
const jobs = Number(opt("-j", "4"));
const out = mkdtempSync(join(tmpdir(), "milo-diff-"));

type Prog = { file: string; args: string[]; stdin?: string };
const progs: Prog[] = [];
if (!process.argv.includes("--no-fixtures")) {
  for (const dir of ["tests/fixtures", "tests/runtime-errors"]) {
    for (const f of readdirSync(join(here, dir)).sort()) if (f.endsWith(".milo")) progs.push({ file: join(dir, f), args: [] });
  }
}
if (!process.argv.includes("--no-examples")) {
  const walk = (d: string): string[] => readdirSync(join(here, d)).flatMap(e => {
    const p = join(d, e);
    return statSync(join(here, p)).isDirectory() ? walk(p) : p.endsWith(".milo") ? [p] : [];
  });
  for (const f of walk("examples").sort()) {
    const src = readFileSync(join(here, f), "utf8");
    const m = src.match(/^\s*\/\/\s*@run:(.*)$/m);
    if (!m || !/\bfn\s+main\s*\(/.test(src)) continue;
    const stdin = src.match(/^\s*\/\/\s*@stdin:(.*)$/m);
    progs.push({ file: f, args: split(m[1]), stdin: stdin ? stdin[1].trim() + "\n" : undefined });
  }
}
const selected = progs.filter(p => !filter || p.file.includes(filter));

async function build(root: string, p: Prog, flags: string[], tag: string): Promise<string | null> {
  const bin = join(out, p.file.replace(/[\/.]/g, "_") + "." + tag);
  const r = await guardedRun("bun", ["run", join(root, "src/main.ts"), "build", join(here, p.file), "-o", bin, ...common, ...flags],
    { cwd: here, memMb: 2048, timeoutMs: 240_000 });
  return r.code === 0 ? bin : null;
}
async function exec(bin: string, p: Prog) {
  const r = await guardedRun(bin, p.args, { cwd: here, memMb: 1024, timeoutMs: 30_000, stdinData: p.stdin });
  return `exit=${r.code}${r.signal ? ` sig=${r.signal}` : ""}\n${r.stdout}`;
}

let same = 0, diff = 0, nondet = 0, bothFail = 0;
const findings: string[] = [], nondets: string[] = [];
async function one(p: Prog) {
  const [a, b] = await Promise.all([build(aRoot, p, aFlags, "a"), build(bRoot, p, bFlags, "b")]);
  if (!a && !b) { bothFail++; return; }
  if (!a || !b) { diff++; findings.push(`${p.file}: build failed only in ${a ? "B" : "A"}`); return; }
  const a1 = await exec(a, p), b1 = await exec(b, p);
  if (a1 === b1) { same++; return; }
  const a2 = await exec(a, p);
  if (a2 !== a1) { nondet++; nondets.push(p.file); return; }
  diff++;
  findings.push(`${p.file}:\n  A: ${a1.slice(0, 300).replace(/\n/g, "\n     ")}\n  B: ${b1.slice(0, 300).replace(/\n/g, "\n     ")}`);
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < selected.length) await one(selected[next++]);
}));
for (const f of findings) console.log(`DIFF ${f}`);
if (nondets.length) console.log(`nondeterministic (A disagrees with itself): ${nondets.join(", ")}`);
console.log(`differential: ${selected.length} programs, ${same} same, ${diff} differ, ${nondet} nondeterministic, ${bothFail} failed to build in both`);
// A run that compared nothing is not a pass (a broken walk or filter would look green).
if (diff > 0 || same === 0) process.exit(1);
