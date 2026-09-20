#!/usr/bin/env bun
// Counts every bare non-receiver argument bound to a `&mut` parameter across the corpus:
// std, examples, src-milo, tests/fixtures, and the sibling repos under ~/git/milo-language.
// This is the gate for the explicit-`&mut` migration in
// docs/plans/local-reasoning-2026-09.md (A1 records the number, A6 drives it to 0).
//
// Each file is checked as its own entry with `milo check --count-implicit-mut`, which
// lists sites in the entry and everything it imports; sites are deduplicated by
// file:line:col and attributed to the root whose path prefix they carry, so a std site
// reached from a hundred entries counts once, under std.
//
// Usage: bun scripts/count-implicit-mut.ts [--sites] [root-filter]
//   --sites   print every site after the totals
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const showSites = args.includes("--sites");
const filter = args.find(a => !a.startsWith("--"));

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".milo")) out.push(p);
  }
  return out;
}

// Root name -> directory. Siblings are named by their checkout; a missing one skips.
const roots: { name: string; dir: string; entries: string[] }[] = [
  { name: "std", dir: join(REPO, "std"), entries: walk(join(REPO, "std")) },
  { name: "examples", dir: join(REPO, "examples"), entries: walk(join(REPO, "examples")) },
  { name: "src-milo", dir: join(REPO, "src-milo"), entries: [join(REPO, "src-milo", "main.milo")] },
  { name: "tests/fixtures", dir: join(REPO, "tests", "fixtures"), entries: walk(join(REPO, "tests", "fixtures")) },
];
const siblings = join(homedir(), "git", "milo-language");
if (existsSync(siblings)) {
  for (const e of readdirSync(siblings).sort()) {
    if (e === "milo" || e === ".github" || e.startsWith(".")) continue;
    const dir = join(siblings, e);
    if (!statSync(dir).isDirectory()) continue;
    roots.push({ name: `sibling/${e}`, dir, entries: walk(dir) });
  }
}

const sites = new Map<string, string>(); // "file:line:col" -> "callee\tparam"
const failed: string[] = [];
for (const root of roots) {
  if (filter && !root.name.includes(filter)) continue;
  for (const entry of root.entries) {
    const r = spawnSync("bun", ["run", join(REPO, "src", "main.ts"), "check", "--count-implicit-mut", entry], { encoding: "utf8" });
    if (r.status === 2) { failed.push(`${entry}: ${(r.stderr ?? "").split("\n")[0]}`); continue; }
    for (const line of (r.stdout ?? "").split("\n")) {
      const m = line.match(/^(.+?:\d+:\d+)\t(.*)$/);
      if (m) sites.set(resolve(m[1]!), m[2]!);
    }
  }
}

const totals = new Map<string, number>();
for (const root of roots) totals.set(root.name, 0);
let other = 0;
for (const key of sites.keys()) {
  const root = roots.find(r => key.startsWith(r.dir + "/"));
  if (root) totals.set(root.name, (totals.get(root.name) ?? 0) + 1);
  else other++;
}
let grand = 0;
for (const [name, n] of totals) { console.log(`${name.padEnd(24)} ${n}`); grand += n; }
if (other) console.log(`${"(other)".padEnd(24)} ${other}`);
console.log(`${"total".padEnd(24)} ${grand + other}`);
if (failed.length) { console.log(`\n${failed.length} entries failed to parse/resolve (not counted):`); for (const f of failed) console.log(`  ${f}`); }
if (showSites) for (const [k, v] of [...sites].sort()) console.log(`${k}\t${v}`);
