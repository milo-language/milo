#!/usr/bin/env bun
// Differential gate for the MLIR backend (docs/mlir-backend.md): every fixture is built with
// MILO_MLIR=1 and without, both binaries run, and stdout, stderr and the exit status must
// match. It prints the coverage number (function instances compiled through MLIR / all
// non-extern function instances, from MILO_MLIR_LOG), the most common reasons the rest
// stayed on legacy codegen, and the corpus build time on each side.
//
//   bun scripts/mlir-same.ts                  # all fixtures
//   bun scripts/mlir-same.ts --filter arith   # only names matching the regex
//   bun scripts/mlir-same.ts --programs       # only mlir/test/programs (seconds)
//   bun scripts/mlir-same.ts --jobs 2
//
// It cannot pass vacuously: zero fixtures compared, zero functions through MLIR, or a
// milo-opt that is not built all fail. A mismatch is rerun once on both sides; a fixture
// whose legacy binary disagrees with itself is nondeterministic and reported apart. A guard
// kill for the machine's sake (memory pressure) is retried and, every time, aborts with
// exit 2 and no verdict.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { guardedRun, type RunResult } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const MAIN = join(ROOT, "src", "main.ts");
const MILO_OPT = process.env.MILO_OPT ?? join(ROOT, "mlir", "build", "milo-opt");

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const filter = opt("--filter");
const jobs = Number(opt("--jobs") ?? 2);
const GUARD_TRIES = 3;
const NOISE = new Set(["pressure", "global-memory", "watchdog-blind"]);
const killed = (r: RunResult) => (!!r.guardKill && NOISE.has(r.guardKill)) || /\[guard\] SIGKILL: system memory pressure/.test(r.stderr);

if (!existsSync(MILO_OPT)) {
  console.error(`mlir-same: ${MILO_OPT} is not built; run \`sh mlir/build.sh\``);
  process.exit(1);
}

async function guarded(what: string, cmd: string, args: string[], opts: Parameters<typeof guardedRun>[2]): Promise<RunResult> {
  for (let attempt = 1; ; attempt++) {
    const r = await guardedRun(cmd, args, opts);
    if (!killed(r)) return r;
    console.error(`mlir-same: guard killed ${what}, attempt ${attempt}/${GUARD_TRIES}`);
    if (attempt === GUARD_TRIES) {
      console.log(`mlir-same: ABORTED, ${what} guard-killed ${GUARD_TRIES} times; no verdict, rerun when the machine is idle`);
      process.exit(2);
    }
  }
}

// Each entry is a source path without `.milo`. mlir/test/programs holds scalar programs
// written for this gate, panicking ones included; every one must reach MLIR.
const PROGRAMS = join(ROOT, "mlir", "test", "programs");
const list = (dir: string) => readdirSync(dir).filter(f => f.endsWith(".milo")).map(f => join(dir, f.slice(0, -5)))
  .filter(n => !filter || new RegExp(filter).test(basename(n))).sort();
const programs = list(PROGRAMS);
const names = [...programs, ...(argv.includes("--programs") ? [] : list(FIXTURES))];
const tmp = mkdtempSync(join(tmpdir(), "milo-mlir-same-"));

type Verdict = "same" | "differ" | "nondeterministic" | "build-differ" | "no-build";
const results: { name: string; verdict: Verdict; detail?: string }[] = [];
const fnTotal = { ok: 0, all: 0 };
const reasons = new Map<string, number>();
const buildMs = { legacy: 0, mlir: 0 };

async function build(name: string, mlir: boolean): Promise<{ bin: string; res: RunResult; lowered: number }> {
  const id = `${basename(name)}.${names.indexOf(name)}`;
  const bin = join(tmp, `${id}.${mlir ? "mlir" : "legacy"}`);
  const log = join(tmp, `${id}.log`);
  const args = ["run", MAIN, "build", `${name}.milo`, "-o", bin];
  const companion = `${name}.c`;
  if (existsSync(companion)) args.push(companion);
  const env = { ...process.env, MILO_MLIR: mlir ? "1" : "0", ...(mlir ? { MILO_MLIR_LOG: log } : {}) };
  if (mlir) rmSync(log, { force: true });
  const t0 = performance.now();
  const res = await guarded(`build ${name} (${mlir ? "mlir" : "legacy"})`, "bun", args, { env, timeoutMs: 180_000 });
  buildMs[mlir ? "mlir" : "legacy"] += performance.now() - t0;
  let lowered = 0;
  if (mlir && existsSync(log)) {
    for (const line of readFileSync(log, "utf-8").split("\n")) {
      if (!line) continue;
      const reason = line.split("\t")[1] ?? "?";
      fnTotal.all++;
      if (reason === "ok") { fnTotal.ok++; lowered++; }
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return { bin, res, lowered };
}

// Fixtures create scratch files in their working directory; keep them out of the checkout.
const run = (bin: string) => guarded(`run ${bin}`, bin, [], { timeoutMs: 30_000, cwd: tmp });
const key = (r: RunResult) => JSON.stringify([r.code, r.signal, r.stdout, r.stderr]);
let fixturesLowered = 0;

async function one(name: string): Promise<void> {
  // Both sides are always built, so the build-time totals cover the same corpus.
  const m = await build(name, true);
  const h = await build(name, false);
  if (m.lowered > 0) fixturesLowered++;
  else if (programs.includes(name)) {
    results.push({ name, verdict: "build-differ", detail: "a gate program compiled nothing through MLIR" });
    return;
  }
  if ((m.res.code === 0) !== (h.res.code === 0)) {
    results.push({ name, verdict: "build-differ", detail: (m.res.code ? m.res.stderr : h.res.stderr).trim().split("\n").slice(0, 3).join(" | ") });
    return;
  }
  if (m.res.code !== 0) { results.push({ name, verdict: "no-build" }); return; }
  let [rm, rh] = await Promise.all([run(m.bin), run(h.bin)]);
  if (key(rm) === key(rh)) { results.push({ name, verdict: "same" }); return; }
  const rh2 = await run(h.bin);
  if (key(rh2) !== key(rh)) { results.push({ name, verdict: "nondeterministic" }); return; }
  rm = await run(m.bin);
  if (key(rm) === key(rh)) { results.push({ name, verdict: "same" }); return; }
  const what = rm.code !== rh.code ? `exit ${rh.code} -> ${rm.code}` : rm.stdout !== rh.stdout ? "stdout" : "stderr";
  results.push({ name, verdict: "differ", detail: what });
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < names.length) await one(names[next++]);
}));
rmSync(tmp, { recursive: true, force: true });

const count = (v: Verdict) => results.filter(r => r.verdict === v).length;
for (const r of results) if (r.verdict === "differ" || r.verdict === "build-differ") console.log(`DIFF ${basename(r.name)}: ${r.verdict} ${r.detail ?? ""}`);
for (const r of results) if (r.verdict === "nondeterministic") console.log(`nondeterministic ${basename(r.name)}`);
const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`legacy reasons: ${top.map(([r, n]) => `${r} ${n}`).join(", ")}`);
const pct = fnTotal.all ? (100 * fnTotal.ok / fnTotal.all).toFixed(1) : "0";
console.log(`mlir coverage: ${fnTotal.ok}/${fnTotal.all} function instances (${pct}%), in ${fixturesLowered}/${names.length} programs`);
const s = (ms: number) => (ms / 1000).toFixed(1);
console.log(`build time (sum over fixtures): legacy ${s(buildMs.legacy)}s, mlir ${s(buildMs.mlir)}s (${buildMs.legacy ? ((buildMs.mlir / buildMs.legacy - 1) * 100).toFixed(1) : "?"}%)`);
const compared = count("same") + count("differ") + count("build-differ");
console.log(`mlir-same: ${count("same")}/${compared} same, ${count("differ") + count("build-differ")} differ, ${count("nondeterministic")} nondeterministic, ${count("no-build")} build on neither`);
if (compared === 0) { console.error("mlir-same: nothing compared"); process.exit(1); }
if (fnTotal.ok === 0) { console.error("mlir-same: no function went through MLIR, so nothing was tested"); process.exit(1); }
process.exit(count("differ") + count("build-differ") > 0 ? 1 : 0);
