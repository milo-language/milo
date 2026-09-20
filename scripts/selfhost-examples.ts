#!/usr/bin/env bun
// Compile every examples/ entrypoint with milo-self (the Milo compiler written in Milo)
// and bucket the failures — the examples-side counterpart to scripts/selfhost-sweep.ts.
//
//   bun scripts/selfhost-examples.ts               # census, print buckets
//   bun scripts/selfhost-examples.ts --filter nes  # only paths containing "nes"
//   bun scripts/selfhost-examples.ts --verbose     # list every OK too
//
// Contract mirrors scripts/run-examples.ts: a file with `fn main(` must compile; one
// also carrying `// @run: <args>` must additionally run to exit 0. Files without a main
// are library modules and are counted as skipped, never silently dropped.
//
// THIS IS NOT A GATE. Nothing in CI runs it. Self-host parity must never block a change
// in src/ — see docs/self-hosting.md. It exists so the gap can be measured.
//
// Every milo-self invocation goes through guardedRun: the binary under test is untrusted
// (scripts/guard.ts), and an unguarded self-compile has crashed this machine twice.
import { readdirSync, statSync, readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun } from "./guard";
import { requireFreshSelfhost } from "./selfhost-stamp";

const MILO_ROOT = join(import.meta.dir, "..");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");
const CHILD_ENV = { ...process.env, MILO_ROOT };
// Examples are far bigger than fixtures, and the cap covers the whole process tree —
// clang -O2 on examples/games/flight/main.milo alone wants more than 1.5GB. At the
// sweep's 1536MB that example reported `guard-memory` on every run, serial retry
// included, which reads as a milo-self failure and is only this budget. 2 workers x
// 3GB keeps N x cap under half of a 16GB host, the rule in CLAUDE.md.
const CONCURRENCY = Number(process.env.MILO_SWEEP_CONCURRENCY || 0) || 2;
const COMPILE_MEM_MB = 3072;
const RUN_MEM_MB = 512;

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const fi = argv.indexOf("--filter");
const filter = fi >= 0 ? argv[fi + 1] : null;

requireFreshSelfhost();

// First pattern to match a failure's output names its bucket. Unmatched failures land in
// "other" and want triage — that bucket staying large means this list is out of date.
const BUCKETS: [string, RegExp][] = [
  ["link", /Undefined symbols|ld: |linker failed/i],
  ["llvm-reject", /error: expected |error: use of undefined value|defined with type/i],
  ["parse-error", /parse error|unexpected token/i],
  ["unknown-method", /no method '|unsupported method|unknown method/i],
  ["unknown-decl", /unknown struct|unknown enum|unknown trait|undefined function|undefined variable/i],
  ["type-error", /type mismatch|expected .*, got |return type mismatch/i],
  ["move-error", /use of moved|cannot assign to immutable/i],
  ["unsupported", /unsupported statement|not yet supported|TODO/i],
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith(".milo")) files.push(p);
  }
  return files;
}

type Outcome = { file: string; ok: boolean; bucket: string; detail: string };

async function sweepOne(file: string, tmpDir: string): Promise<Outcome> {
  const source = readFileSync(file, "utf-8");
  const bin = join(tmpDir, file.replace(/[\/.]/g, "_"));

  const build = await guardedRun(MILO_SELF, ["build", file, "-o", bin],
    { env: CHILD_ENV, timeoutMs: 180_000, memMb: COMPILE_MEM_MB });
  if (build.code !== 0) {
    const err = (build.stderr + build.stdout).trim();
    const hit = BUCKETS.find(([, re]) => re.test(err));
    const bucket = build.guardKill ? `guard-${build.guardKill}`
      : build.signal ? `signal-${build.signal}`
      : hit ? hit[0]
      : "other";
    return { file, ok: false, bucket, detail: err.split("\n").find(l => l.trim()) ?? `exit ${build.code}` };
  }

  const m = source.match(/^\s*\/\/\s*@run:(.*)$/m);
  if (!m) return { file, ok: true, bucket: "compile-only", detail: "" };

  const runArgs = m[1].trim().split(/\s+/).filter(Boolean);
  // `// @stdin: <text>` — same annotation scripts/run-examples.ts honors. Without
  // it a filter program (jq, wc, shuf) is run on an immediately-closed stdin and
  // only ever exercises its empty-input error path, which then reads as a failure.
  const stdinM = source.match(/^\s*\/\/\s*@stdin:(.*)$/m);
  const run = await guardedRun(bin, runArgs, {
    env: CHILD_ENV, timeoutMs: 60_000, memMb: RUN_MEM_MB,
    ...(stdinM ? { stdinData: stdinM[1].trim() + "\n" } : {}),
  });
  if (run.code !== 0) {
    return {
      file, ok: false,
      bucket: run.signal || run.guardKill ? "run-crash" : "run-nonzero",
      detail: `exit ${run.code}: ${(run.stderr || "").trim().split("\n").pop() ?? ""}`.slice(0, 160),
    };
  }
  return { file, ok: true, bucket: "ran", detail: "" };
}

const all = walk(join(MILO_ROOT, "examples")).sort();
// A file with no `fn main(` is a library module: it compiles transitively via its
// importer. Counted, not dropped — a silent skip would read as a pass.
const libs = all.filter(f => !/\bfn\s+main\s*\(/.test(readFileSync(f, "utf-8")));
let entries = all.filter(f => !libs.includes(f));
if (filter) entries = entries.filter(f => f.includes(filter));

const tmpDir = mkdtempSync(join(tmpdir(), "milo-ex-"));
const results: Outcome[] = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < entries.length) {
    const f = entries[next++]!;
    results.push(await sweepOne(f, tmpDir));
  }
}));

// Re-verify every failure serially before reporting it, exactly as
// scripts/selfhost-sweep.ts does. Examples are far bigger than fixtures, so four
// concurrent compiles routinely trip the per-child memory cap on a machine that
// would compile any one of them comfortably — three such flakes were reported as
// real failures (flight, neon, donut) before this existed. A parallel verdict of
// "failed" is a hypothesis; only the serial re-run is evidence.
const flaky: string[] = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i]!;
  if (r.ok) continue;
  const retry = await sweepOne(r.file, tmpDir);
  if (retry.ok) {
    flaky.push(r.file.replace(MILO_ROOT + "/", ""));
    results[i] = retry;
  }
}
if (flaky.length) {
  console.log(`re-verified serially: ${flaky.length} passed on retry (parallel-load flake): ${flaky.join(", ")}\n`);
}
results.sort((a, b) => a.file.localeCompare(b.file));

const passing = results.filter(r => r.ok);
const ran = passing.filter(r => r.bucket === "ran").length;
const compileOnly = passing.filter(r => r.bucket === "compile-only");
// "70/71 build" is the number that reads as success, and it is the weaker claim:
// a build proves the frontend accepted the program, not that the code it emitted
// is correct. The `??` double-free that broke examples/cli-tools/fmt.milo compiled
// clean. So lead with the count that was actually EXECUTED, and print the
// unverified remainder as its own line rather than folding it into the pass total.
console.log(`${ran}/${entries.length} examples ran clean under milo-self`);
console.log(`${compileOnly.length}/${entries.length} compiled but were NOT run (no \`// @run:\`) — codegen unverified`);
if (passing.length < entries.length) {
  console.log(`${entries.length - passing.length}/${entries.length} failed`);
}
console.log(`(${libs.length} library modules compile transitively)\n`);

if (verbose) for (const r of passing) console.log(`  OK  ${r.bucket.padEnd(12)} ${r.file}`);
else if (compileOnly.length) {
  console.log("unverified (build-only):");
  for (const r of compileOnly) console.log(`         ${r.file.replace(MILO_ROOT + "/", "")}`);
  console.log("");
}

const byBucket = new Map<string, Outcome[]>();
for (const r of results.filter(r => !r.ok)) {
  if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, []);
  byBucket.get(r.bucket)!.push(r);
}
for (const [bucket, rs] of [...byBucket].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(rs.length).padStart(5)}  ${bucket}`);
  for (const r of rs) console.log(`         ${r.file.replace(MILO_ROOT + "/", "")}: ${r.detail.slice(0, 150)}`);
}
process.exit(results.some(r => !r.ok) ? 1 : 0);
