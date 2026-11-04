#!/usr/bin/env bun
// Conformance gate for the MLIR backend: every fixture's stdout, exit code and live heap blocks
// must equal what the reference interpreter (`milo interp`, docs/semantics/milo.md) computes for
// it. The interpreter is the oracle because it follows the written rules: a recorded golden only
// says "same as before", and two goldens recorded tonight's bugs as correct. A program the
// interpreter can't run yet (it reports `unsupported`) falls back to its recorded golden in
// tests/golden; `--golden` uses the goldens for everything. It prints the
// coverage number (function instances compiled through MLIR / all non-extern function
// instances, from MILO_MLIR_LOG), the most common reasons the rest were not lowered, and the
// corpus build time.
//
//   bun scripts/mlir-same.ts                  # all fixtures
//   bun scripts/mlir-same.ts --filter arith   # only names matching the regex
//   bun scripts/mlir-same.ts --programs       # only mlir/test/programs (seconds)
//   bun scripts/mlir-same.ts --jobs 2
//   bun scripts/mlir-same.ts --programs --owned   # also: live heap blocks at exit equal the
//                                             # golden's (scripts/livecount.c; at -O0), clean ASan
//   bun scripts/mlir-same.ts [--programs] [--owned] --record-golden   # rewrite goldens from the
//                                             # MLIR build. This destroys the oracle: use it only
//                                             # deliberately (a fixture changed on purpose) and say
//                                             # so in the commit message. Nondeterministic
//                                             # programs get no file.
//
// It cannot pass vacuously: zero fixtures compared, zero functions through MLIR, or a
// milo-opt that is not built all fail. A mismatch is rerun once; a fixture whose binary
// disagrees with itself is nondeterministic and reported apart. A guard kill for the
// machine's sake (memory pressure) is retried and, every time, aborts with exit 2 and no verdict.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { constants, tmpdir } from "os";
import { guardedRun, type RunResult } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const MAIN = join(ROOT, "src", "main.ts");
const MILO_OPT = process.env.MILO_OPT ?? join(ROOT, "mlir", "build", "milo-opt");

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const filter = opt("--filter");
const RECORD = argv.includes("--record-golden");
const GOLDEN_ONLY = argv.includes("--golden");
const GOLDEN_DIR = join(ROOT, "tests", "golden");
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
const OWNED = argv.includes("--owned");
// The live-block counter, built once; darwin only (Linux has LeakSanitizer in the ASan run).
let LIVECOUNT: string | null = null;
if (OWNED && process.platform === "darwin") {
  LIVECOUNT = join(tmp, "livecount.dylib");
  const cc = Bun.spawnSync(["/usr/bin/clang", "-dynamiclib", "-O1", "-o", LIVECOUNT, join(ROOT, "scripts", "livecount.c")]);
  if (cc.exitCode !== 0) { console.error(`mlir-same: cannot build scripts/livecount.c:\n${cc.stderr}`); process.exit(1); }
}

type Verdict = "same" | "differ" | "nondeterministic" | "build-differ" | "no-build" | "owned-differ" | "no-golden" | "recorded";
const results: { name: string; verdict: Verdict; detail?: string }[] = [];
const fnTotal = { ok: 0, all: 0 };
const reasons = new Map<string, number>();
let buildMs = 0;

// A program can ask for extra build flags (`// @mlir-same-flags: --contract-checks`),
// for behaviour a default build leaves out.
function extraFlags(name: string): string[] {
  const m = /^\/\/ @mlir-same-flags:(.*)$/m.exec(readFileSync(`${name}.milo`, "utf-8"));
  return m ? m[1]!.trim().split(/\s+/) : [];
}

async function build(name: string): Promise<{ bin: string; res: RunResult; lowered: number }> {
  const id = `${basename(name)}.${names.indexOf(name)}`;
  const bin = join(tmp, `${id}.mlir`);
  const log = join(tmp, `${id}.log`);
  const args = ["run", MAIN, "build", `${name}.milo`, ...extraFlags(name), "-o", bin];
  const companion = `${name}.c`;
  if (existsSync(companion)) args.push(companion);
  const env = { ...process.env, MILO_MLIR_LOG: log } as Record<string, string>;
  rmSync(log, { force: true });
  const t0 = performance.now();
  const res = await guarded(`build ${name}`, "bun", args, { env, timeoutMs: 180_000 });
  buildMs += performance.now() - t0;
  let lowered = 0;
  if (existsSync(log)) {
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
// A process that died of a signal has no exit code (guard.ts reports 1 then); a shell shows 128 + the
// signal number, which is also what the interpreter exits with for an abort (S-PANIC-ABORT).
const status = (r: RunResult): number | null => (r.signal ? 128 + (constants.signals as Record<string, number>)[r.signal]! : r.code);
const key = (r: RunResult) => JSON.stringify([r.code, r.signal, r.stdout, r.stderr]);
let fixturesLowered = 0;

// --owned: the output diff cannot see a wrong drop (a double free of a string often prints
// the same bytes), so for every program MLIR took part of, two more checks.
//  * live heap blocks at exit (scripts/livecount.c, darwin): must equal the golden's;
//    more is a missing drop, fewer an extra free.
//  * the MLIR binary under ASan: no report, same exit status. Symbolizing a report needs
//    the task port, which hangs where lldb does, so it is off: the report names no lines.
// Live blocks at exit for one binary, at -O2 (the binary itself) and at -O0 (`--fast`).
type Live = { o2: string | null; o0: string | null };
async function measureLive(name: string, bin: string): Promise<Live> {
  // Not through guard.ts: it execs via /bin/sh, and macOS strips DYLD_* from anything a
  // system binary starts. The same binary has just run to completion under the guard
  // with the same input, so a direct spawn with a hard timeout is what is left to risk.
  const live = async (b: string) => {
    const out = `${b}.live`;
    rmSync(out, { force: true });
    const p = Bun.spawn([b], { cwd: tmp, stdout: "ignore", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, DYLD_INSERT_LIBRARIES: LIVECOUNT!, MILO_LIVECOUNT_OUT: out } });
    const timer = setTimeout(() => p.kill(9), 30_000);
    await p.exited;
    clearTimeout(timer);
    return existsSync(out) ? readFileSync(out, "utf-8").trim() : null;
  };
  const fastBin = `${bin}.fast`;
  const args = ["run", MAIN, "build", `${name}.milo`, "--fast", ...extraFlags(name), "-o", fastBin];
  if (existsSync(`${name}.c`)) args.push(`${name}.c`);
  const b = await guarded(`build ${name} (-O0)`, "bun", args, { timeoutMs: 180_000 });
  return { o2: await live(bin), o0: b.code === 0 ? await live(fastBin) : `build failed: ${b.stderr.trim().split("\n")[0]}` };
}

// ref is the golden: its exit code and live counts (live null without --owned or off darwin).
type Ref = { code: number | null; live: Live | null; liveOptional?: boolean };
async function ownership(name: string, mlirBin: string, ref: Ref): Promise<string | null> {
  if (LIVECOUNT) {
    const lm = await measureLive(name, mlirBin);
    const lh = ref.live;
    // An aborted run reports no live count in the interpreter (S-PANIC-ABORT), so nothing to compare.
    if (!lh && ref.liveOptional) return null;
    if (!lh) return "live blocks: golden has no live counts (record with --owned on darwin)";
    // No count from a program that exits normally means the counter was not loaded.
    if (lh.o2 === null && ref.code === 0) return "live blocks: scripts/livecount.c did not load";
    if (lh.o2 !== null && !/^-?\d+$/.test(lh.o2)) return `live blocks: scripts/livecount.c counted nothing (${lh.o2})`;
    // -O0 (`--fast`: checks as at -O2) decides. At -O2 LLVM deletes a malloc whose block is
    // never freed and never escapes, and whether it can see that depends on inlining, which
    // differs per backend: the recorded run inlined string formatting, MLIR calls a helper. So the
    // -O2 counts can differ with identical drops (exitDivergesMoves: a string still owned at
    // exit()), or agree with a drop erased (a struct's drop of its strings left both equal).
    if (lm.o0 !== lh.o0) return `live blocks at exit at -O0: golden ${lh.o0}, mlir ${lm.o0} (at -O2: golden ${lh.o2}, mlir ${lm.o2})`;
  }
  const asanBin = `${mlirBin}.asan`;
  const args = ["run", MAIN, "build", `${name}.milo`, "--sanitize", ...extraFlags(name), "-o", asanBin];
  if (existsSync(`${name}.c`)) args.push(`${name}.c`);
  const b = await guarded(`build ${name} (asan)`, "bun", args, { timeoutMs: 180_000 });
  if (b.code !== 0) return `asan build failed: ${b.stderr.trim().split("\n")[0]}`;
  const leaks = process.platform === "linux" ? 1 : 0;
  const r = await guarded(`run ${asanBin}`, asanBin, [], { timeoutMs: 60_000, cwd: tmp, env: { ...process.env, ASAN_OPTIONS: `detect_leaks=${leaks}:symbolize=0` } });
  const report = /ERROR: (AddressSanitizer|LeakSanitizer)[^\n]*/.exec(r.stderr);
  if (report) return report[0];
  if (r.code !== ref.code) return `under asan exit ${ref.code} -> ${r.code}`;
  return null;
}

type Golden = { code: number | null; signal: string | null; stdout: string; stderr: string; live?: Live };
const goldenPath = (name: string) => join(GOLDEN_DIR, programs.includes(name) ? "programs" : "fixtures", `${basename(name)}.json`);
const sortedJson = (o: Record<string, unknown>) =>
  JSON.stringify(o, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v, 2) + "\n";
const skipped: string[] = [];

// Build, run twice (differing runs are nondeterministic, as in the compare path), then
// overwrite the golden.
async function record(name: string): Promise<void> {
  const h = await build(name);
  if (h.res.code !== 0) { skipped.push(`${basename(name)}: build failed`); results.push({ name, verdict: "no-build" }); return; }
  const r1 = await run(h.bin);
  const r2 = await run(h.bin);
  if (key(r1) !== key(r2)) { skipped.push(`${basename(name)}: nondeterministic`); results.push({ name, verdict: "nondeterministic" }); return; }
  const g: Golden = { code: r1.code, signal: r1.signal ?? null, stdout: r1.stdout, stderr: r1.stderr };
  if (LIVECOUNT) g.live = await measureLive(name, h.bin);
  mkdirSync(dirname(goldenPath(name)), { recursive: true });
  writeFileSync(goldenPath(name), sortedJson(g));
  results.push({ name, verdict: "recorded" });
}

// The reference interpreter's result, or null when it can't run the program (it falls back to
// the golden). stderr is not compared against it: panic and diagnostic text is the runtime's.
async function interpRef(name: string): Promise<Golden | null> {
  const r = await guarded(`interp ${name}`, "bun", ["run", MAIN, "interp", `${name}.milo`, "--live", ...extraFlags(name)], { timeoutMs: 600_000, cwd: tmp });
  if (/^interp: (unsupported|stuck at)/m.test(r.stderr) || /^\w*Error: /m.test(r.stderr)) return null;
  if (r.code === 1 && !r.stdout && /error/.test(r.stderr) && !/live blocks/.test(r.stderr)) return null;
  const live = /interp: live blocks (\S+)/.exec(r.stderr)?.[1] ?? null;
  return { code: r.code, signal: null, stdout: r.stdout, stderr: "", live: live === null ? undefined : { o0: live, o2: live } };
}
const oracle = { interp: 0, golden: 0 };

async function one(name: string): Promise<void> {
  if (RECORD) return record(name);
  const fromInterp = GOLDEN_ONLY ? null : await interpRef(name);
  if (!fromInterp && !existsSync(goldenPath(name))) { results.push({ name, verdict: "no-golden" }); return; }
  const gold: Golden = fromInterp ?? JSON.parse(readFileSync(goldenPath(name), "utf-8"));
  oracle[fromInterp ? "interp" : "golden"]++;
  const m = await build(name);
  if (m.lowered > 0) fixturesLowered++;
  else if (programs.includes(name)) {
    results.push({ name, verdict: "build-differ", detail: "a gate program compiled nothing through MLIR" });
    return;
  }
  if (m.res.code !== 0) {
    results.push({ name, verdict: "build-differ", detail: m.res.stderr.trim().split("\n").slice(0, 3).join(" | ") });
    return;
  }
  let rm = await run(m.bin);
  const refKey = JSON.stringify([gold.code, gold.signal ?? null, gold.stdout, gold.stderr]);
  const matches = (r: RunResult) => fromInterp ? status(r) === gold.code && r.stdout === gold.stdout : key(r) === refKey;
  const same = async () => {
    let bad: string | null = null;
    if (OWNED && m.lowered > 0) bad = await ownership(name, m.bin, { code: gold.code, live: gold.live ?? null, liveOptional: !!fromInterp });
    results.push(bad ? { name, verdict: "owned-differ", detail: bad } : { name, verdict: "same" });
  };
  if (matches(rm)) return same();
  const rm2 = await run(m.bin);
  if (key(rm2) !== key(rm)) { results.push({ name, verdict: "nondeterministic" }); return; }
  rm = rm2;
  const what = status(rm) !== gold.code && fromInterp ? `exit ${gold.code} -> ${status(rm)}` : rm.code !== gold.code ? `exit ${gold.code} -> ${rm.code}` : rm.stdout !== gold.stdout ? "stdout" : "stderr";
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
if (RECORD) {
  for (const k of skipped) console.log(`no golden: ${k}`);
  console.log(`mlir-same: recorded ${count("recorded")}/${names.length} goldens in tests/golden, ${skipped.length} skipped`);
  process.exit(count("recorded") === 0 ? 1 : 0);
}
const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`not lowered: ${top.map(([r, n]) => `${r} ${n}`).join(", ")}`);
const pct = fnTotal.all ? (100 * fnTotal.ok / fnTotal.all).toFixed(1) : "0";
console.log(`mlir coverage: ${fnTotal.ok}/${fnTotal.all} function instances (${pct}%), in ${fixturesLowered}/${names.length} programs`);
const s = (ms: number) => (ms / 1000).toFixed(1);
console.log(`build time (sum over fixtures): ${s(buildMs)}s`);
const bad = count("differ") + count("build-differ") + count("owned-differ");
const compared = count("same") + bad;
console.log(`mlir-same: oracle interpreter ${oracle.interp}, golden fallback ${oracle.golden}`);
console.log(`mlir-same: ${count("same")}/${compared} same, ${bad} differ${OWNED ? ` (${count("owned-differ")} in ownership)` : ""}, ${count("nondeterministic")} nondeterministic, ${count("no-build")} build on neither, ${count("no-golden")} no golden`);
if (compared === 0) { console.error("mlir-same: nothing compared"); process.exit(1); }
if (fnTotal.ok === 0) { console.error("mlir-same: no function went through MLIR, so nothing was tested"); process.exit(1); }
process.exit(bad > 0 ? 1 : 0);
