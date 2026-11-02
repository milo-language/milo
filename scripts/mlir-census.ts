#!/usr/bin/env bun
// Compile-only MLIR coverage census: emit-ir with MILO_MLIR_LOG over every fixture and
// example with a main plus milojs's two entry points, then the function-instance coverage
// and the top legacy reasons. This is the ranking the coverage batches work from; it never
// runs a binary, so it is not a correctness gate (mlir-same is).
//
// It runs whatever src/ holds as each file compiles, so run it from a worktree of a commit
// (MILO_OPT pointing at a built milo-opt) when src/ may change meanwhile.
//
// Usage: bun scripts/mlir-census.ts [--top N] [--where reason-substring] [--probe]
//   --where prints the files whose log carries a matching reason, with counts.
//   --probe (MILO_MLIR_PROBE) skips each refused statement and keeps going, so the ranking
//   counts every blocker of every function, not only its first: the burn-down list. Its
//   total is the number of (function, reason) pairs left.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir, availableParallelism } from "node:os";

const REPO = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const topN = Number(args[args.indexOf("--top") + 1]) || (args.includes("--top") ? 25 : 25);
const where = args.includes("--where") ? args[args.indexOf("--where") + 1] : undefined;
const probe = args.includes("--probe");

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
const hasMain = (p: string) => /^\s*(pub\s+)?fn main\s*\(/m.test(readFileSync(p, "utf-8"));
const files = [
  ...walk(join(REPO, "tests/fixtures")).filter(hasMain),
  ...walk(join(REPO, "examples")).filter(hasMain),
  ...["src/milojs.milo", "src/milojs-engine.milo"].map(f => join(homedir(), "git/milojs", f)).filter(existsSync),
];

const tmp = mkdtempSync(join(tmpdir(), "mlir-census-"));
const MAIN = join(REPO, "src/main.ts");
let ok = 0, all = 0, failed = 0, blockers = 0;
const failures: string[] = [];
const reasons = new Map<string, number>();
const byFile = new Map<string, number>();

async function one(file: string, i: number) {
  const log = join(tmp, `${i}.log`);
  const proc = Bun.spawn(["bun", "run", MAIN, "emit-ir", file], {
    env: { ...process.env, MILO_MLIR_LOG: log, ...(probe ? { MILO_MLIR_PROBE: "1" } : {}) }, stdout: "ignore", stderr: "ignore",
    cwd: resolve(file, ".."),
  });
  // A big example (games/flight) takes minutes; one that hangs must not hold the census.
  const timer = setTimeout(() => proc.kill(), 300_000);
  if ((await proc.exited) !== 0) { failed++; failures.push(file); }
  clearTimeout(timer);
  if (!existsSync(log)) return;
  for (const line of readFileSync(log, "utf-8").split("\n")) {
    if (!line) continue;
    const [, reason = "?", more] = line.split("\t");
    if (!more) all++;
    if (reason === "ok") { ok++; continue; }
    blockers++;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (where && reason.includes(where)) byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
}

const queue = files.map((f, i) => [f, i] as const);
await Promise.all(Array.from({ length: Math.max(1, availableParallelism() >> 1) }, async () => {
  for (let item; (item = queue.shift()); ) await one(item[0], item[1]);
}));

console.log(`census: ${ok} of ${all} (${(100 * ok / Math.max(all, 1)).toFixed(2)}%), ${all - ok} on legacy, ${files.length} files, ${failed} emit failures${probe ? `, ${blockers} blockers` : ""}`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log(`${String(n).padStart(6)}  ${r}`);
for (const f of failures) console.log(`emit failure: ${f}`);
if (where) for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n}\t${f}`);
