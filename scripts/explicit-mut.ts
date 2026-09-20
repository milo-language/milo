#!/usr/bin/env bun
// Rewrites `f(x)` to `f(&mut x)` wherever `x` is bound to a `&mut` parameter, using the
// checker's resolved signatures (`milo check --json --deny=implicit-mut-borrow`), never a
// regex: only the checker knows which parameter an argument binds to.
//
// Usage: bun scripts/explicit-mut.ts <file.milo>...
//
// Each file is checked as its own entry and only the files named are edited. A site the
// check reports in some other file (an imported module) is listed at the end so the
// caller can pass that file too. Idempotent: a second run finds no sites and changes
// nothing. Loops up to 3 times per file, since a rewrite never exposes a new site but a
// fixed point is cheaper to verify than to argue.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "..", "src", "main.ts");
const files = process.argv.slice(2).filter(a => !a.startsWith("--"));
if (files.length === 0) { console.error("usage: bun scripts/explicit-mut.ts <file.milo>..."); process.exit(2); }

interface Site { file: string; line: number; col: number }

function sitesOf(file: string): { sites: Site[]; elsewhere: Site[]; ok: boolean } {
  const r = spawnSync("bun", ["run", MAIN, "check", file, "--json", "--deny=implicit-mut-borrow"], { encoding: "utf8" });
  let parsed: any;
  try { parsed = JSON.parse(r.stdout ?? ""); } catch {
    console.error(`${file}: check produced no JSON\n${r.stderr ?? ""}`);
    return { sites: [], elsewhere: [], ok: false };
  }
  const here = resolve(file);
  const sites: Site[] = [], elsewhere: Site[] = [];
  for (const d of parsed.diagnostics ?? []) {
    if (d.code !== "implicit-mut-borrow" || d.line == null) continue;
    const s = { file: resolve(d.file ?? file), line: d.line, col: d.col };
    (s.file === here ? sites : elsewhere).push(s);
  }
  // Other errors leave the check partial; the sites it did report are still real.
  return { sites, elsewhere, ok: true };
}

// Insert `&mut ` at each (line, col), descending so earlier offsets stay valid.
function apply(src: string, sites: Site[]): string {
  const lineStart: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStart.push(i + 1);
  const offsets = [...new Set(sites.map(s => lineStart[s.line - 1] + s.col - 1))].sort((a, b) => b - a);
  let out = src;
  for (const off of offsets) out = out.slice(0, off) + "&mut " + out.slice(off);
  return out;
}

let total = 0;
const elsewhereAll = new Map<string, number>();
for (const file of files) {
  let changed = 0;
  for (let round = 0; round < 3; round++) {
    const { sites, elsewhere, ok } = sitesOf(file);
    if (!ok) break;
    for (const s of elsewhere) elsewhereAll.set(s.file, (elsewhereAll.get(s.file) ?? 0) + 1);
    if (sites.length === 0) break;
    writeFileSync(file, apply(readFileSync(file, "utf8"), sites));
    changed += sites.length;
  }
  total += changed;
  console.log(`${file}: ${changed} argument(s) rewritten`);
}
if (elsewhereAll.size) {
  console.log(`\nsites in files not named on the command line (pass them to rewrite):`);
  for (const [f, n] of [...elsewhereAll].sort()) console.log(`  ${f}: ${n}`);
}
console.log(`total ${total}`);
