#!/usr/bin/env bun
// Does milo-self REJECT the programs it is supposed to reject?
//
//   bun scripts/selfhost-rejects.ts                 # census
//   bun scripts/selfhost-rejects.ts --filter move   # only names containing "move"
//   bun scripts/selfhost-rejects.ts --verbose       # list accepted-but-shouldn't-be
//   bun scripts/selfhost-rejects.ts --check         # soundness ratchet: exit 1 on regression
//   bun scripts/selfhost-rejects.ts --write         # grow the ratchet manifest
//
// Non-ok results are always re-verified serially before being reported: under parallel
// load contention can downgrade a genuine "accepted" (unsound) to "wrong-message",
// which under-reports unsoundness in exactly the direction that matters.
//
// scripts/selfhost-sweep.ts measures only tests/fixtures — programs that must COMPILE and
// print the right thing. It deliberately skips every negative test. That leaves the more
// important half of a compiler unmeasured: a compiler that accepts literally everything
// scores 100% on the positive corpus. Memory safety in Milo is enforced by rejection, so
// "milo-self passes 578/578" says nothing about whether it is sound.
//
// Two lanes, mirroring tests/run.test.ts:
//   tests/errors/*.milo          must fail to compile; stderr must contain `// @error:`
//   tests/runtime-errors/*.milo  must compile at --debug, then trap at runtime
//
// The `wrong-message` bucket matters as much as `ACCEPTED`: rejecting for an unrelated
// reason is not the same as catching the bug, and it is how a rejection test silently
// stops testing anything.
//
// THIS IS NOT A GATE. Self-host parity must never block a change in src/ — see
// docs/self-hosting.md. Every milo-self invocation goes through guardedRun.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { parseExpectedError, parseExpectedRuntimeError } from "../tests/annotations";
import { guardedRun } from "./guard";
import { requireFreshSelfhost } from "./selfhost-stamp";

const MILO_ROOT = join(import.meta.dir, "..");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");
const ERRORS_DIR = join(MILO_ROOT, "tests", "errors");
const RUNTIME_ERRORS_DIR = join(MILO_ROOT, "tests", "runtime-errors");
const CHILD_ENV = { ...process.env, MILO_ROOT };
const CONCURRENCY = Number(process.env.MILO_SWEEP_CONCURRENCY || 0) || 4;

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const check = argv.includes("--check");
const write = argv.includes("--write");
const fi = argv.indexOf("--filter");
const filter = fi >= 0 ? argv[fi + 1] : null;

requireFreshSelfhost();

// "unmeasured" is not a verdict about the compiler — it means the guard killed the child
// (watchdog or system memory pressure) before it could answer. Folding those into
// "wrong-message" is how a harness reports a confident number it did not actually measure;
// an early version of this script did exactly that and produced 204 bogus failures while
// six compiler builds were competing for RAM. Run this with the machine otherwise idle.
type Verdict = "ok" | "accepted" | "wrong-message" | "build-failed" | "did-not-trap" | "unmeasured";
type Outcome = { name: string; lane: string; verdict: Verdict; detail: string };

function names(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith(".milo")).map(f => basename(f, ".milo"))
    .filter(n => !filter || n.includes(filter)).sort();
}

// A negative test can be as platform-bound as a positive one: a diagnostic quoting a POSIX
// header proves nothing where that header does not exist. Same contract as tests/run.test.ts.
function skipped(source: string): boolean {
  const m = source.match(/^\s*\/\/\s*@skip-os:(.*)$/m);
  return !!m && m[1]!.split(/[,\s]+/).filter(Boolean).includes(process.platform);
}

async function checkReject(name: string, tmpDir: string): Promise<Outcome> {
  const src = join(ERRORS_DIR, `${name}.milo`);
  const source = readFileSync(src, "utf-8");
  const want = parseExpectedError(source);

  const r = await guardedRun(MILO_SELF, ["build", src, "-o", join(tmpDir, "rejected")],
    { env: CHILD_ENV, timeoutMs: 60_000, memMb: 1536 });
  const out = r.stderr + r.stdout;

  if (r.guardKill) return { name, lane: "errors", verdict: "unmeasured", detail: r.guardKill };
  if (r.code === 0) return { name, lane: "errors", verdict: "accepted", detail: "compiled clean — the bug this fixture guards is not caught" };
  if (want && !out.includes(want)) {
    return { name, lane: "errors", verdict: "wrong-message", detail: `want "${want}" — got "${out.trim().split("\n").find(l => l.trim())?.slice(0, 110) ?? ""}"` };
  }
  return { name, lane: "errors", verdict: "ok", detail: "" };
}

async function checkTrap(name: string, tmpDir: string): Promise<Outcome> {
  const src = join(RUNTIME_ERRORS_DIR, `${name}.milo`);
  const source = readFileSync(src, "utf-8");
  const want = parseExpectedRuntimeError(source);
  const bin = join(tmpDir, `rt_${name}`);

  const build = await guardedRun(MILO_SELF, ["build", src, "--debug", "-o", bin],
    { env: CHILD_ENV, timeoutMs: 60_000, memMb: 1536 });
  if (build.guardKill) return { name, lane: "runtime-errors", verdict: "unmeasured", detail: build.guardKill };
  if (build.code !== 0) {
    return { name, lane: "runtime-errors", verdict: "build-failed", detail: (build.stderr + build.stdout).trim().split("\n").find(l => l.trim())?.slice(0, 130) ?? "" };
  }

  const r = await guardedRun(bin, [], { env: CHILD_ENV, timeoutMs: 30_000, memMb: 512 });
  // A guard kill is not a trap — the watchdog fired, the program's own bounds check may
  // never have run. Do not count it as the fixture passing.
  if (r.guardKill) return { name, lane: "runtime-errors", verdict: "unmeasured", detail: r.guardKill };
  if (r.code === 0 && !r.signal) {
    return { name, lane: "runtime-errors", verdict: "did-not-trap", detail: "exited 0 — the trap this fixture guards did not fire" };
  }
  const out = r.stderr + r.stdout;
  if (want && !out.includes(want)) {
    return { name, lane: "runtime-errors", verdict: "wrong-message", detail: `want "${want}" — got "${out.trim().split("\n").pop()?.slice(0, 110) ?? `signal ${r.signal ?? ""}`}"` };
  }
  return { name, lane: "runtime-errors", verdict: "ok", detail: "" };
}

const tmpDir = mkdtempSync(join(tmpdir(), "milo-neg-"));
const jobs: (() => Promise<Outcome>)[] = [];
let skips = 0;
for (const n of names(ERRORS_DIR)) {
  if (skipped(readFileSync(join(ERRORS_DIR, `${n}.milo`), "utf-8"))) { skips++; continue; }
  jobs.push(() => checkReject(n, tmpDir));
}
for (const n of names(RUNTIME_ERRORS_DIR)) {
  if (skipped(readFileSync(join(RUNTIME_ERRORS_DIR, `${n}.milo`), "utf-8"))) { skips++; continue; }
  jobs.push(() => checkTrap(n, tmpDir));
}

const results: Outcome[] = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) results.push(await jobs[next++]!());
}));
results.sort((a, b) => (a.lane + a.name).localeCompare(b.lane + b.name));

// Re-verify every non-ok result serially. milo-self is nondeterministic under
// parallel load, and the failure modes here are not symmetric: contention can
// turn a genuine "accepted" (unsound) into a lesser "wrong-message", which
// under-reports unsoundness. A serial second opinion is the only trustworthy one.
const suspect = results.filter(r => r.verdict !== "ok");
if (suspect.length && CONCURRENCY > 1) {
  console.error(`re-verifying ${suspect.length} non-ok result(s) serially…`);
  for (const s of suspect) {
    Object.assign(s, s.lane === "errors" ? await checkReject(s.name, tmpDir) : await checkTrap(s.name, tmpDir));
  }
  const recovered = suspect.filter(r => r.verdict === "ok");
  if (recovered.length) console.error(`  ${recovered.length} correct on retry (parallel-load flake): ${recovered.map(r => r.name).join(", ")}`);
}

const ok = results.filter(r => r.verdict === "ok");
const unmeasured = results.filter(r => r.verdict === "unmeasured");
const measured = results.length - unmeasured.length;
console.log(`${ok.length}/${measured} negative tests behave correctly under milo-self (${skips} skipped for this OS)`);
if (unmeasured.length) {
  console.log(`WARNING: ${unmeasured.length} of ${results.length} were NOT MEASURED — the guard killed them. ` +
    `Re-run with the machine idle; these numbers are incomplete, not a compiler verdict.`);
}
console.log();

const order: Verdict[] = ["accepted", "did-not-trap", "wrong-message", "build-failed", "unmeasured"];
for (const v of order) {
  const rs = results.filter(r => r.verdict === v);
  if (!rs.length) continue;
  const gloss = v === "accepted" ? "  <-- UNSOUND: milo-self compiles a program it must reject"
    : v === "did-not-trap" ? "  <-- UNSOUND: the runtime check did not fire"
    : v === "wrong-message" ? "  (rejected, but for a different reason — the fixture is no longer testing what it names)"
    : v === "build-failed" ? "  (rejected at build time, but this lane's programs are supposed to BUILD and then trap)"
    : "  (guard kill — no verdict; the machine was busy)";
  console.log(`${String(rs.length).padStart(5)}  ${v}${gloss}`);
  for (const r of rs) console.log(`         ${r.name}: ${r.detail}`);
  console.log();
}
if (verbose) for (const r of ok) console.log(`  OK  ${r.lane}/${r.name}`);

// The soundness ratchet. Unlike the fixture sweep, "everything passes" is a long
// way off here, so the gate is a monotonic manifest: every negative test milo-self
// already handles correctly must keep working. A lane gates on one line of output
// instead of the coordinator reading its diff.
const MANIFEST = join(MILO_ROOT, "tests", "selfhost-rejects-manifest.txt");
const okNames = ok.map(r => `${r.lane}/${r.name}`).sort();
if (check || write) {
  const header = existsSync(MANIFEST)
    ? readFileSync(MANIFEST, "utf-8").split("\n").filter(l => l.startsWith("#")).join("\n")
    : "# Negative tests milo-self already handles correctly. Monotonic: entries are never removed\n# except by deleting the fixture. Grow with: bun scripts/selfhost-rejects.ts --write";
  const claimed = existsSync(MANIFEST)
    ? readFileSync(MANIFEST, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    : [];
  // An unmeasured entry is a guard kill, not a regression — the machine was busy.
  const unmeasuredNames = new Set(results.filter(r => r.verdict === "unmeasured").map(r => `${r.lane}/${r.name}`));
  const regressed = claimed.filter(n => !okNames.includes(n) && !unmeasuredNames.has(n));
  const gained = okNames.filter(n => !claimed.includes(n));

  if (check) {
    if (gained.length) console.log(`\nNEW: ${gained.length} negative test(s) now correct — rerun with --write to ratchet:\n  ${gained.join("\n  ")}`);
    if (regressed.length) {
      console.error(`\nSOUNDNESS RATCHET FAILED: ${regressed.length} negative test(s) regressed:\n  ${regressed.join("\n  ")}`);
      process.exit(1);
    }
    // Excusing a guard kill is right one at a time and wrong in bulk: a milo-self that
    // hangs or runs away on every input gets every entry killed, `regressed` comes out
    // empty, and the ratchet would pass having measured nothing (same floor as leak-check).
    const measuredClaimed = claimed.filter(n => !unmeasuredNames.has(n)).length;
    if (measuredClaimed < Math.ceil(claimed.length * 0.9)) {
      console.error(`\nSOUNDNESS RATCHET BLIND: only ${measuredClaimed}/${claimed.length} manifest entries got a verdict; the guard killed the rest. Re-run with the machine idle, or check that milo-self terminates.`);
      process.exit(1);
    }
    console.log(`\nSOUNDNESS RATCHET OK — all ${claimed.length} manifest entries still behave correctly`);
    process.exit(0);
  }
  if (regressed.length) {
    console.error(`\nREFUSING TO WRITE: manifest would shrink — these regressed:\n  ${regressed.join("\n  ")}`);
    process.exit(1);
  }
  // An entry the guard killed is UNKNOWN, not broken — the `regressed` check above
  // exempts it for exactly that reason. Writing plain `okNames` would then delete it
  // from the manifest anyway, so a --write from a busy machine silently lowers the
  // ratchet by however many entries happened to be shed. Carry those rows forward.
  const carried = claimed.filter(n => !okNames.includes(n) && unmeasuredNames.has(n));
  if (carried.length) {
    console.log(`\ncarrying ${carried.length} unmeasured manifest entr(y/ies) forward — the guard shed them, which is not a regression:\n  ${carried.join("\n  ")}`);
  }
  const written = [...okNames, ...carried].sort();
  writeFileSync(MANIFEST, `${header}\n${written.join("\n")}\n`);
  console.log(`\nmanifest: ${claimed.length} → ${written.length} negative tests`);
  process.exit(0);
}

process.exit(results.some(r => r.verdict !== "ok") ? 1 : 0);
