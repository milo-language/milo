#!/usr/bin/env bun
// Differential gate for the MLIR backend (docs/mlir-backend.md): every fixture is built with
// the default (MLIR) and with MILO_LEGACY=1, both binaries run, and stdout, stderr and the exit status must
// match. It prints the coverage number (function instances compiled through MLIR / all
// non-extern function instances, from MILO_MLIR_LOG), the most common reasons the rest
// stayed on legacy codegen, and the corpus build time on each side.
//
//   bun scripts/mlir-same.ts                  # all fixtures
//   bun scripts/mlir-same.ts --filter arith   # only names matching the regex
//   bun scripts/mlir-same.ts --programs       # only mlir/test/programs (seconds)
//   bun scripts/mlir-same.ts --jobs 2
//   bun scripts/mlir-same.ts --programs --owned   # also: live heap blocks at exit equal
//                                             # legacy's (scripts/livecount.c; at -O2 and
//                                             # at -O0), clean ASan
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

// The candidate is the default build; the baseline is MILO_LEGACY=1. Any inherited setting of
// either switch is dropped first so the caller's shell cannot flip a side.
function buildEnv(mlir: boolean, extra: Record<string, string>): Record<string, string> {
  const e = { ...process.env } as Record<string, string>;
  delete e.MILO_MLIR;
  delete e.MILO_LEGACY;
  if (!mlir) e.MILO_LEGACY = "1";
  return { ...e, ...extra };
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
const OWNED = argv.includes("--owned");
// The live-block counter, built once; darwin only (Linux has LeakSanitizer in the ASan run).
let LIVECOUNT: string | null = null;
if (OWNED && process.platform === "darwin") {
  LIVECOUNT = join(tmp, "livecount.dylib");
  const cc = Bun.spawnSync(["/usr/bin/clang", "-dynamiclib", "-O1", "-o", LIVECOUNT, join(ROOT, "scripts", "livecount.c")]);
  if (cc.exitCode !== 0) { console.error(`mlir-same: cannot build scripts/livecount.c:\n${cc.stderr}`); process.exit(1); }
}

type Verdict = "same" | "differ" | "nondeterministic" | "build-differ" | "no-build" | "owned-differ";
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
  const env = buildEnv(mlir, mlir ? { MILO_MLIR_LOG: log } : {});
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

// --owned: the output diff cannot see a wrong drop (a double free of a string often prints
// the same bytes), so for every program MLIR took part of, two more checks.
//  * live heap blocks at exit (scripts/livecount.c, darwin): MLIR's must equal legacy's;
//    more is a missing drop, fewer an extra free.
//  * the MLIR binary under ASan: no report, same exit status. Symbolizing a report needs
//    the task port, which hangs where lldb does, so it is off: the report names no lines.
async function ownership(name: string, mlirBin: string, legacyBin: string, legacyRun: RunResult): Promise<string | null> {
  if (LIVECOUNT) {
    // Not through guard.ts: it execs via /bin/sh, and macOS strips DYLD_* from anything a
    // system binary starts. The same binary has just run to completion under the guard
    // with the same input, so a direct spawn with a hard timeout is what is left to risk.
    const live = async (bin: string) => {
      const out = `${bin}.live`;
      rmSync(out, { force: true });
      const p = Bun.spawn([bin], { cwd: tmp, stdout: "ignore", stderr: "ignore", stdin: "ignore",
        env: { ...process.env, DYLD_INSERT_LIBRARIES: LIVECOUNT!, MILO_LIVECOUNT_OUT: out } });
      const timer = setTimeout(() => p.kill(9), 30_000);
      await p.exited;
      clearTimeout(timer);
      return existsSync(out) ? readFileSync(out, "utf-8").trim() : null;
    };
    const [lm, lh] = [await live(mlirBin), await live(legacyBin)];
    // No count from a program that exits normally means the counter was not loaded.
    if (lh === null && legacyRun.code === 0) return "live blocks: scripts/livecount.c did not load";
    if (lh !== null && !/^-?\d+$/.test(lh)) return `live blocks: scripts/livecount.c counted nothing (${lh})`;
    // -O0 (`--fast`: checks as at -O2) decides. At -O2 LLVM deletes a malloc whose block is
    // never freed and never escapes, and whether it can see that depends on inlining, which
    // differs per backend: legacy inlines string formatting, MLIR calls a helper. So the -O2
    // counts can differ with identical drops (exitDivergesMoves: a string still owned at
    // exit()), or agree with a drop erased (a struct's drop of its strings left both equal).
    const fast = async (mlir: boolean) => {
      const bin = `${mlir ? mlirBin : legacyBin}.fast`;
      const args = ["run", MAIN, "build", `${name}.milo`, "--fast", "-o", bin];
      if (existsSync(`${name}.c`)) args.push(`${name}.c`);
      const b = await guarded(`build ${name} (${mlir ? "mlir" : "legacy"}, -O0)`, "bun", args, { env: buildEnv(mlir, {}), timeoutMs: 180_000 });
      return b.code === 0 ? await live(bin) : `build failed: ${b.stderr.trim().split("\n")[0]}`;
    };
    const [fm, fh] = [await fast(true), await fast(false)];
    if (fm !== fh) return `live blocks at exit at -O0: legacy ${fh}, mlir ${fm} (at -O2: legacy ${lh}, mlir ${lm})`;
  }
  const asanBin = `${mlirBin}.asan`;
  const args = ["run", MAIN, "build", `${name}.milo`, "--sanitize", "-o", asanBin];
  if (existsSync(`${name}.c`)) args.push(`${name}.c`);
  const b = await guarded(`build ${name} (mlir, asan)`, "bun", args, { env: buildEnv(true, {}), timeoutMs: 180_000 });
  if (b.code !== 0) return `asan build failed: ${b.stderr.trim().split("\n")[0]}`;
  const leaks = process.platform === "linux" ? 1 : 0;
  const r = await guarded(`run ${asanBin}`, asanBin, [], { timeoutMs: 60_000, cwd: tmp, env: { ...process.env, ASAN_OPTIONS: `detect_leaks=${leaks}:symbolize=0` } });
  const report = /ERROR: (AddressSanitizer|LeakSanitizer)[^\n]*/.exec(r.stderr);
  if (report) return report[0];
  if (r.code !== legacyRun.code) return `under asan exit ${legacyRun.code} -> ${r.code}`;
  return null;
}

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
  const same = async () => {
    const bad = OWNED && m.lowered > 0 ? await ownership(name, m.bin, h.bin, rh) : null;
    results.push(bad ? { name, verdict: "owned-differ", detail: bad } : { name, verdict: "same" });
  };
  if (key(rm) === key(rh)) return same();
  const rh2 = await run(h.bin);
  if (key(rh2) !== key(rh)) { results.push({ name, verdict: "nondeterministic" }); return; }
  rm = await run(m.bin);
  if (key(rm) === key(rh)) return same();
  const what = rm.code !== rh.code ? `exit ${rh.code} -> ${rm.code}` : rm.stdout !== rh.stdout ? "stdout" : "stderr";
  results.push({ name, verdict: "differ", detail: what });
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < names.length) await one(names[next++]);
}));
rmSync(tmp, { recursive: true, force: true });

const count = (v: Verdict) => results.filter(r => r.verdict === v).length;
for (const r of results) if (r.verdict === "differ" || r.verdict === "build-differ" || r.verdict === "owned-differ") console.log(`DIFF ${basename(r.name)}: ${r.verdict} ${r.detail ?? ""}`);
for (const r of results) if (r.verdict === "nondeterministic") console.log(`nondeterministic ${basename(r.name)}`);
const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`legacy reasons: ${top.map(([r, n]) => `${r} ${n}`).join(", ")}`);
const pct = fnTotal.all ? (100 * fnTotal.ok / fnTotal.all).toFixed(1) : "0";
console.log(`mlir coverage: ${fnTotal.ok}/${fnTotal.all} function instances (${pct}%), in ${fixturesLowered}/${names.length} programs`);
const s = (ms: number) => (ms / 1000).toFixed(1);
console.log(`build time (sum over fixtures): legacy ${s(buildMs.legacy)}s, mlir ${s(buildMs.mlir)}s (${buildMs.legacy ? ((buildMs.mlir / buildMs.legacy - 1) * 100).toFixed(1) : "?"}%)`);
const bad = count("differ") + count("build-differ") + count("owned-differ");
const compared = count("same") + bad;
console.log(`mlir-same: ${count("same")}/${compared} same, ${bad} differ${OWNED ? ` (${count("owned-differ")} in ownership)` : ""}, ${count("nondeterministic")} nondeterministic, ${count("no-build")} build on neither`);
if (compared === 0) { console.error("mlir-same: nothing compared"); process.exit(1); }
if (fnTotal.ok === 0) { console.error("mlir-same: no function went through MLIR, so nothing was tested"); process.exit(1); }
process.exit(bad > 0 ? 1 : 0);
