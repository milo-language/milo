#!/usr/bin/env bun
// Differential gate for MIR (docs/plans/codegen-ir-2026-10.md, phase 2): every fixture is built
// with MILO_MIR=1 and without, both binaries run, and stdout, stderr and the exit status must
// match. Byte-identical IR is impossible here (MIR changes the instruction stream), so behavior
// is the oracle.
//
//   bun scripts/mir-same.ts                  # all fixtures
//   bun scripts/mir-same.ts --filter vec     # only names containing the substring
//   bun scripts/mir-same.ts --jobs 6
//
// It also prints the progress number: the share of functions MIR lowered, and the most common
// reasons the rest fell back (from MILO_MIR_LOG).
//
// A fixture where MIR lowered no function emits exactly the HIR path's IR, so its HIR build is
// skipped; it still counts toward coverage. A mismatch is rerun once on both sides: a fixture
// whose HIR binary disagrees with itself is nondeterministic and reported apart, not as a pass.
// Zero fixtures compared is a failure. A build or run the guard kills says nothing about the
// compiler, so it is retried, and one killed every time aborts the pass with exit 2 and no verdict
// (as in ir-same.ts) instead of counting as a difference.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { guardedRun, type RunResult } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const MAIN = join(ROOT, "src", "main.ts");

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const filter = opt("--filter");
const jobs = Number(opt("--jobs") ?? 2);
const GUARD_TRIES = 3;
// Only a kill for the machine's sake is harness noise: system-wide memory pressure, or the tree
// shed without this process attributing it, which the guard notes on stderr (see
// selfhost-sweep.ts). A timeout or a per-process memory cap is the program's own behavior, and a
// miscompiled loop that never ends or never stops allocating is exactly what this gate exists to
// catch, so those are results to compare.
const NOISE = new Set(["pressure", "global-memory", "watchdog-blind"]);
const killed = (r: RunResult) => (!!r.guardKill && NOISE.has(r.guardKill)) || /\[guard\] SIGKILL: system memory pressure/.test(r.stderr);

async function guarded(what: string, cmd: string, args: string[], opts: Parameters<typeof guardedRun>[2]): Promise<RunResult> {
  for (let attempt = 1; ; attempt++) {
    const r = await guardedRun(cmd, args, opts);
    if (!killed(r)) return r;
    console.error(`mir-same: guard killed ${what}, attempt ${attempt}/${GUARD_TRIES}`);
    if (attempt === GUARD_TRIES) {
      console.log(`mir-same: ABORTED, ${what} guard-killed ${GUARD_TRIES} times; no verdict, rerun when the machine is idle`);
      process.exit(2);
    }
  }
}

const names = readdirSync(FIXTURES).filter(f => f.endsWith(".milo")).map(f => f.slice(0, -5))
  .filter(n => !filter || n.includes(filter)).sort();
const tmp = mkdtempSync(join(tmpdir(), "milo-mir-same-"));

type Verdict = "same" | "differ" | "nondeterministic" | "build-differ" | "no-build" | "unlowered";
const results: { name: string; verdict: Verdict; detail?: string }[] = [];
const fnTotal = { ok: 0, all: 0 };
const reasons = new Map<string, number>();
// Within lowered functions: MIR's own statements and terminators vs opaque ones, by reason.
const stmtTotal = { mir: 0, opaque: 0 };
const opaqueReasons = new Map<string, number>();

async function build(name: string, mir: boolean): Promise<{ bin: string; res: RunResult; lowered: number }> {
  const bin = join(tmp, `${name}.${mir ? "mir" : "hir"}`);
  const log = join(tmp, `${name}.log`);
  const args = ["run", MAIN, "build", join(FIXTURES, `${name}.milo`), "-o", bin];
  const companion = join(FIXTURES, `${name}.c`);
  if (existsSync(companion)) args.push(companion);
  const env = { ...process.env, MILO_MIR: mir ? "1" : "0", ...(mir ? { MILO_MIR_LOG: log } : {}) };
  // A retried build appends to the same log; start it fresh each time.
  if (mir) rmSync(log, { force: true });
  const res = await guarded(`build ${name} (${mir ? "mir" : "hir"})`, "bun", args, { env, timeoutMs: 120_000 });
  let lowered = 0;
  if (mir && existsSync(log)) {
    for (const line of readFileSync(log, "utf-8").split("\n")) {
      if (!line) continue;
      const [, reason, mirCount, opaque] = line.split("\t");
      fnTotal.all++;
      if (reason === "ok") {
        fnTotal.ok++;
        lowered++;
        stmtTotal.mir += Number(mirCount ?? 0);
        for (const r of opaque ? opaque.split("|") : []) {
          stmtTotal.opaque++;
          opaqueReasons.set(r, (opaqueReasons.get(r) ?? 0) + 1);
        }
      } else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return { bin, res, lowered };
}

// Fixtures create scratch files in their working directory; keep them out of the checkout.
const run = (bin: string) => guarded(`run ${bin}`, bin, [], { timeoutMs: 30_000, cwd: tmp });
const key = (r: RunResult) => JSON.stringify([r.code, r.signal, r.stdout, r.stderr]);

async function one(name: string): Promise<void> {
  const m = await build(name, true);
  if (m.lowered === 0) {
    results.push({ name, verdict: m.res.code === 0 ? "unlowered" : "no-build" });
    return;
  }
  const h = await build(name, false);
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
for (const r of results) if (r.verdict === "differ" || r.verdict === "build-differ") console.log(`DIFF ${r.name}: ${r.verdict} ${r.detail ?? ""}`);
for (const r of results) if (r.verdict === "nondeterministic") console.log(`nondeterministic ${r.name}`);
const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`fallback reasons: ${top.map(([r, n]) => `${r} ${n}`).join(", ")}`);
const pct = fnTotal.all ? (100 * fnTotal.ok / fnTotal.all).toFixed(1) : "0";
console.log(`mir coverage: ${fnTotal.ok}/${fnTotal.all} functions (${pct}%)`);
const topOpaque = [...opaqueReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`opaque reasons: ${topOpaque.map(([r, n]) => `${r} ${n}`).join(", ")}`);
const own = stmtTotal.mir + stmtTotal.opaque;
console.log(`mir statements: ${stmtTotal.mir}/${own} lowered by MIR (${own ? (100 * stmtTotal.mir / own).toFixed(1) : "0"}%), ${stmtTotal.opaque} opaque`);
const compared = count("same") + count("differ") + count("build-differ");
console.log(`mir-same: ${count("same")}/${compared} same, ${count("differ") + count("build-differ")} differ, ${count("nondeterministic")} nondeterministic, ${count("no-build")} build on neither, ${count("unlowered")} with nothing lowered`);
if (compared === 0) { console.error("mir-same: nothing compared"); process.exit(1); }
process.exit(count("differ") + count("build-differ") > 0 ? 1 : 0);
