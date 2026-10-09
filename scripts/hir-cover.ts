#!/usr/bin/env bun
// Which fixtures exercise which HIR expression kinds?
//
//   bun scripts/hir-cover.ts                       # (re)generate tests/hir-cover.json
//   bun scripts/hir-cover.ts --for Ident FieldAccess    # list covering fixtures
//   bun scripts/hir-cover.ts --check --for Ident        # build+run them under milo-self
//   bun scripts/hir-cover.ts --unexercised              # kinds no fixture reaches
//
// The HIR self-compile migration lowers ~100 expression kinds one at a time.
// The only gate that sees "this kind is now miscompiled" is the 48-minute corpus sweep,
// which is too slow to run per kind — so it gets skipped, which is exactly how six
// regressions shipped under green gates in one session. This is the fast substitute: run
// only the fixtures that actually reach the kind just changed.
//
// The index is GENERATED, never hand-maintained. It comes from `milo emit-hir --json`,
// the compiler's own answer, through the JSON surface rather than by importing src/*.ts
// (see docs/json-api.md) — so it survives a self-hosted rewrite of the frontend.
//
// Two properties this file exists to guarantee, both learned the hard way:
//
//   1. A run over ZERO fixtures exits non-zero. A gate that reports success while
//      checking nothing is the silent-success defect, and it has bitten this repo at
//      least four times. "0 checked" is a failure, not a pass.
//   2. `--check` reuses sweepOne from selfhost-sweep.ts rather than reimplementing
//      build-and-diff. A second copy would drift and then disagree with the ratchet
//      about what "passing" means.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sweepOne, FIXTURES_DIR } from "./selfhost-sweep";

const MILO_ROOT = join(import.meta.dir, "..");
const INDEX = join(MILO_ROOT, "tests", "hir-cover.json");

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const unexercised = argv.includes("--unexercised");
const fi = argv.indexOf("--for");
const kinds = fi >= 0 ? argv.slice(fi + 1).filter(a => !a.startsWith("--")) : [];

type Index = { generatedFrom: string; fixtures: number; kinds: Record<string, string[]> };

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".milo")).map(f => f.slice(0, -5)).sort();
}

// Every "kind" field anywhere in the HIR JSON — expressions, statements and patterns alike.
// Deliberately a blunt walk rather than a schema-aware one: the taxonomy is 120 names and
// growing, and a walk that knows the schema is a second place to update when it changes.
function kindsIn(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const v of node) kindsIn(v, out); return; }
  const o = node as Record<string, unknown>;
  if (typeof o.kind === "string") out.add(o.kind);
  for (const v of Object.values(o)) kindsIn(v, out);
}

// Default emit-hir output, NOT --all. --all pulls in the whole stdlib, which makes almost
// every fixture cover almost every kind and destroys the discrimination this index exists
// for. What matters is which kinds the FIXTURE's own code reaches.
async function emitKinds(name: string): Promise<Set<string> | null> {
  const src = join(FIXTURES_DIR, `${name}.milo`);
  const p = Bun.spawn(["bun", "run", join(MILO_ROOT, "src", "main.ts"), "emit-hir", src], {
    cwd: MILO_ROOT, stdout: "pipe", stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) return null;
  try {
    const set = new Set<string>();
    kindsIn(JSON.parse(out), set);
    return set;
  } catch { return null; }
}

async function generate(): Promise<Index> {
  const names = fixtureNames();
  const kindMap: Record<string, string[]> = {};
  let failed = 0;
  process.stderr.write(`indexing ${names.length} fixtures`);
  for (let i = 0; i < names.length; i++) {
    if (i % 50 === 0) process.stderr.write(".");
    const set = await emitKinds(names[i]);
    // A fixture the frontend cannot lower contributes nothing. That is not this script's
    // problem to fix, but it must not be silently counted as covering nothing either.
    if (set === null) { failed++; continue; }
    for (const k of set) (kindMap[k] ??= []).push(names[i]);
  }
  process.stderr.write("\n");
  if (failed > 0) process.stderr.write(`note: ${failed} fixture(s) produced no HIR (frontend rejected or non-JSON output)\n`);
  const idx: Index = { generatedFrom: "milo emit-hir (default scope, not --all)", fixtures: names.length, kinds: kindMap };
  writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n");
  return idx;
}

function load(): Index {
  if (!existsSync(INDEX)) {
    console.error(`no index at ${INDEX} — run: bun scripts/hir-cover.ts`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(INDEX, "utf-8"));
}

async function main() {
  if (!check && kinds.length === 0 && !unexercised) {
    const idx = await generate();
    const counts = Object.entries(idx.kinds).map(([k, v]) => [k, v.length] as const).sort((a, b) => b[1] - a[1]);
    console.log(`indexed ${idx.fixtures} fixtures, ${counts.length} kinds`);
    console.log(`\ntop 15 by coverage:`);
    for (const [k, n] of counts.slice(0, 15)) console.log(`  ${k.padEnd(24)} ${n}`);
    console.log(`\nwrote ${INDEX}`);
    return;
  }

  const idx = load();

  if (unexercised) {
    // Every kind the taxonomy declares but no fixture reaches. Migrating one of these
    // proves nothing: there is no evidence it works, and none that it broke.
    const declared = new Set<string>();
    const hir = readFileSync(join(MILO_ROOT, "src", "hir.ts"), "utf-8");
    for (const m of hir.matchAll(/kind:\s*"([A-Za-z]+)"/g)) declared.add(m[1]);
    const missing = [...declared].filter(k => !(idx.kinds[k]?.length)).sort();
    console.log(`${missing.length} of ${declared.size} declared kinds have NO covering fixture:`);
    for (const k of missing) console.log(`  ${k}`);
    return;
  }

  if (kinds.length === 0) {
    console.error("--check requires --for <Kind>...");
    process.exit(1);
  }

  const covering = [...new Set(kinds.flatMap(k => idx.kinds[k] ?? []))].sort();
  const unknown = kinds.filter(k => !(k in idx.kinds));

  if (!check) {
    console.log(`${covering.length} fixture(s) cover ${kinds.join(", ")}`);
    for (const n of covering) console.log(`  ${n}`);
    if (unknown.length) console.log(`\nno fixture covers: ${unknown.join(", ")}`);
    return;
  }

  // Property 1. Checking zero fixtures is a failure, never a pass — otherwise a typo in a
  // kind name reports success and the migration step goes unverified.
  if (covering.length === 0) {
    console.error(`FAIL: 0 fixtures cover ${kinds.join(", ")} — nothing was checked.`);
    if (unknown.length) console.error(`  unknown kind(s): ${unknown.join(", ")} (typo, or not in the index)`);
    console.error(`  a gate that checks nothing cannot fail, so this exits non-zero rather than passing.`);
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "hir-cover-"));
  try {
    const failures: string[] = [];
    for (const name of covering) {
      const r = await sweepOne(name, tmp);
      if (!r.ok) {
        // A guard kill is the harness running out of headroom, not the fixture failing.
        // Conflating them turns a memory-pressure shed into a reported regression.
        if (r.bucket.startsWith("guard-")) {
          console.error(`  SKIP ${name}: ${r.bucket} (guard kill, not a miscompile)`);
          continue;
        }
        failures.push(`${name}: ${r.bucket} — ${r.detail}`);
      }
    }
    console.log(`\nchecked ${covering.length} fixture(s) covering ${kinds.join(", ")}`);
    if (failures.length) {
      console.error(`\n${failures.length} FAILED:`);
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log("all pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
