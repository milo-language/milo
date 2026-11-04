#!/usr/bin/env bun
// Corpus census for the mutability hard errors (`var-never-reassigned`, `unwritten-mut-param`): hits per rule.
// It also checks that `milo fix` leaves every file that checked before still checking: over examples/**,
// tests/fixtures and std. A fix that breaks a file is a false positive in the rule (the gate that
// cannot be gamed: the checker itself re-judges the fixed text).
//
//   bun scripts/mutability-census.ts                # counts per kind (entries only)
//   bun scripts/mutability-census.ts --fix          # + fix on a COPY, re-check every file
//   bun scripts/mutability-census.ts --std          # also std/*.milo, checked one by one
//   bun scripts/mutability-census.ts --filter re --jobs 8
//
// Nothing in the repo is modified: --fix works in a temp mirror of examples/ and
// tests/fixtures/. Exits 1 when a fix broke a file or when nothing was checked.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const jobs = Number(opt("--jobs") ?? 8);
const filter = opt("--filter") ? new RegExp(opt("--filter")!) : null;
const KINDS = ["var-never-reassigned", "unwritten-mut-param"];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".milo")) out.push(p);
  }
  return out;
}

async function pool<T, R>(items: T[], f: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < items.length) { const i = next++; res[i] = await f(items[i]!); }
  }));
  return res;
}

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", MAIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

interface Check { ok: boolean; hits: { code: string; file: string; line: number; col: number }[] }
async function check(file: string, env: Record<string, string> = {}): Promise<Check | null> {
  try {
    const j = JSON.parse(await run(["check", file, "--json"], env));
    return { ok: j.ok, hits: j.diagnostics.filter((d: any) => KINDS.includes(d.code)).map((d: any) => ({ code: d.code, file: d.file, line: d.line, col: d.col })) };
  } catch { return null; }
}

const isEntry = (f: string) => /\bfn main\(/.test(readFileSync(f, "utf-8"));
const entries = [...walk(join(ROOT, "examples")), ...readdirSync(join(ROOT, "tests", "fixtures")).filter(f => f.endsWith(".milo")).map(f => join(ROOT, "tests", "fixtures", f))]
  .filter(isEntry).filter(f => !filter || filter.test(f));
const stdFiles = argv.includes("--std") ? walk(join(ROOT, "std")).filter(f => !filter || filter.test(f)) : [];

const t0 = Date.now();
const counts: Record<string, Set<string>> = Object.fromEntries(KINDS.map(k => [k, new Set<string>()]));
const before = new Map<string, Check>();
const unchecked: string[] = [];
const sweep = async (files: string[], env: Record<string, string>) => {
  await pool(files, async f => {
    const c = await check(f, env);
    if (!c) { unchecked.push(f); return; }
    before.set(f, c);
    for (const h of c.hits) counts[h.code]!.add(`${relative(ROOT, h.file)}:${h.line}:${h.col}`);
  });
};
await sweep(entries, {});
const entryCounts = Object.fromEntries(KINDS.map(k => [k, counts[k]!.size]));
const stdBase = Object.fromEntries(KINDS.map(k => [k, counts[k]!.size]));
if (stdFiles.length) await sweep(stdFiles, {});
if (before.size === 0) { console.error("census: nothing was checked"); process.exit(1); }

console.log(`checked ${entries.length} entries${stdFiles.length ? ` + ${stdFiles.length} std files` : ""} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const k of KINDS) console.log(`${k.padEnd(24)} ${entryCounts[k]} in examples+fixtures${stdFiles.length ? `, ${counts[k]!.size - stdBase[k]!} more in std` : ""}`);
if (unchecked.length) console.log(`unchecked (crashed or no JSON): ${unchecked.length}\n  ${unchecked.slice(0, 10).map(f => relative(ROOT, f)).join("\n  ")}`);

if (argv.includes("--fix")) {
  const mirror = mkdtempSync(join(tmpdir(), "milo-mut-census-"));
  cpSync(join(ROOT, "examples"), join(mirror, "examples"), { recursive: true });
  cpSync(join(ROOT, "tests", "fixtures"), join(mirror, "tests", "fixtures"), { recursive: true });
  const broken: string[] = [];
  let fixedFiles = 0;
  const left: string[] = [];
  const hitEntries = entries.filter(f => before.get(f)?.hits.length);
  await pool(hitEntries, async f => {
    const copy = join(mirror, relative(ROOT, f));
    await run(["fix", copy]);
    const after = await check(copy);
    fixedFiles++;
    const was = before.get(f)!;
    if (was.ok && !(after?.ok)) broken.push(relative(ROOT, f));
    if (after?.hits.length) left.push(`${relative(ROOT, f)} (${after.hits.length})`);
  });
  // Every entry again: a fix applied through a shared module must not break another entry.
  await pool(entries.filter(f => before.get(f)?.ok), async f => {
    const after = await check(join(mirror, relative(ROOT, f)));
    if (!after?.ok && !broken.includes(relative(ROOT, f))) broken.push(relative(ROOT, f));
  });
  console.log(`fix: ran on ${fixedFiles} entries with hits; ${broken.length} entries no longer check`);
  for (const b of broken) console.log(`  BROKEN ${b}`);
  console.log(`fix: ${left.length} entries still report a hit after fixing (not idempotent)`);
  for (const l of left.slice(0, 10)) console.log(`  LEFT ${l}`);
  rmSync(mirror, { recursive: true, force: true });
  if (broken.length) process.exit(1);
}
