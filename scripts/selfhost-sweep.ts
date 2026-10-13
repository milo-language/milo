// Differential sweep: run every tests/fixtures/*.milo through milo-self and
// bucket the failures. This is how the M3 manifest grows — see docs/self-hosting.md.
//
//   bun scripts/selfhost-sweep.ts              # census, print buckets
//   bun scripts/selfhost-sweep.ts --write      # also rewrite tests/selfhost-manifest.txt
//   bun scripts/selfhost-sweep.ts --filter foo # only fixtures whose name contains foo
//   bun scripts/selfhost-sweep.ts --check      # ratchet: exit 1 if a manifest fixture regressed
//
// Failures are always re-verified serially before being reported — milo-self is
// nondeterministic under parallel load, so a single parallel verdict is not trustworthy.
//
// Every milo-self invocation goes through guardedRun: the binaries under test
// are untrusted (see scripts/guard.ts).
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { parseExpected, parseExpectedError, parseExpectedRuntimeError } from "../tests/annotations";
import { guardedRun } from "./guard";
import { requireFreshSelfhost } from "./selfhost-stamp";

const MILO_ROOT = join(import.meta.dir, "..");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");
export const FIXTURES_DIR = join(MILO_ROOT, "tests", "fixtures");
const MANIFEST = join(MILO_ROOT, "tests", "selfhost-manifest.txt");
// How many extra times a newly-passing fixture must pass before the manifest claims it.
const CONFIRM_RUNS = 3;
const CHILD_ENV = { ...process.env, MILO_ROOT };
// 4 workers × 1.5GB compile cap = 6GB worst case, under the 8GB global cap on
// a 16GB machine. 8×4GB default caps could outrun the watchdog and swap-thrash.
// milo-self is nondeterministic under parallel load (a few fixtures flip
// pass/fail; pass serially) — use MILO_SWEEP_CONCURRENCY=1 for ratchet runs.
const CONCURRENCY = Number(process.env.MILO_SWEEP_CONCURRENCY || 0) || 4;
const COMPILE_MEM_MB = 1536;
const RUN_MEM_MB = 512;

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
const fi = args.indexOf("--filter");
const filter = fi >= 0 ? args[fi + 1] : null;

if (check && filter) {
  console.error("--check ratchets against the whole manifest; it cannot be combined with --filter");
  process.exit(2);
}

requireFreshSelfhost();

// Failure buckets, in match order. The first pattern that hits a fixture's
// stderr names its bucket; unmatched failures land in "other" and want triage.
const BUCKETS: [string, RegExp][] = [
  ["index-oob", /array index out of bounds/i],
  ["unknown-struct", /unknown struct/i],
  ["undefined-function", /undefined function/i],
  ["unsupported-method", /unsupported method|unknown method/i],
  ["unknown-field", /unknown field/i],
  ["unsupported-stmt", /unsupported statement|not yet supported|TODO/i],
  ["parse-error", /parse error|unexpected token/i],
  ["type-error", /type error|expected .* found/i],
  ["panic", /panic/i],
];

type Outcome = { name: string; ok: boolean; bucket: string; detail: string };

// The first index where two output lists disagree, rendered with enough context to act on.
// A length difference past the common prefix is its own case: "got 2 lines, wanted 3" is
// the useful sentence there, not a comparison against an element that does not exist.
function describeDiff(expected: string[], actual: string[]): string {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      return `line ${i + 1}: want ${JSON.stringify(expected[i])} got ${JSON.stringify(actual[i])}`;
    }
  }
  if (expected.length !== actual.length) {
    const missing = expected.slice(n, n + 2);
    const extra = actual.slice(n, n + 2);
    return actual.length < expected.length
      ? `got ${actual.length} line(s), wanted ${expected.length} — missing from line ${n + 1}: ${JSON.stringify(missing)}`
      : `got ${actual.length} line(s), wanted ${expected.length} — extra from line ${n + 1}: ${JSON.stringify(extra)}`;
  }
  return "identical — reported as a mismatch, which means this comparison is wrong";
}

export async function sweepOne(name: string, tmpDir: string): Promise<Outcome> {
  const src = join(FIXTURES_DIR, `${name}.milo`);
  const outBin = join(tmpDir, name);
  const source = readFileSync(src, "utf-8");

  // A companion `<name>.c` is the C ABI peer (struct-by-value tests). tests/run.test.ts
  // links it; without it these fixtures fail at link with "Undefined symbols", which
  // reads as a milo-self bug but is only a missing translation unit.
  const buildArgs = ["build", src, "-o", outBin];
  const companionC = join(FIXTURES_DIR, `${name}.c`);
  if (existsSync(companionC)) buildArgs.push(companionC);

  const build = await guardedRun(MILO_SELF, buildArgs, { env: CHILD_ENV, timeoutMs: 60000, memMb: COMPILE_MEM_MB });
  if (build.code !== 0) {
    const err = (build.stderr + build.stdout).trim();
    const hit = BUCKETS.find(([, re]) => re.test(err));
    const bucket = build.guardKill ? `guard-${build.guardKill}`
      : /\[guard\] (SIGKILL|killed)/.test(err) ? "guard-shed"
      : build.signal ? `signal-${build.signal}`
      : hit ? hit[0]
      : "other";
    return { name, ok: false, bucket, detail: err.split("\n")[0]?.slice(0, 120) ?? `exit ${build.code}` };
  }

  const r = await guardedRun(outBin, [], { env: CHILD_ENV, timeoutMs: 30000, memMb: RUN_MEM_MB });
  const expected = parseExpected(source);
  const actual = r.stdout.trim() === "" ? [] : r.stdout.trim().split("\n").map(l => l.trim());
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return {
      name, ok: false,
      // A guard kill is the harness running out of headroom, not the fixture crashing.
      // Conflating the two turned a memory-pressure shed into a reported regression.
      // r.guardKill alone is not enough: when the OS sheds the tree under system
      // pressure the child dies without this process attributing the kill, and the
      // run then presents as a plain empty-output mismatch. The guard always says so
      // on stderr, so that marker is the reliable signal.
      bucket: r.guardKill ? `guard-${r.guardKill}`
        : /\[guard\] (SIGKILL|killed)/.test(r.stderr) ? "guard-shed"
        : r.signal ? "run-crash"
        : "output-mismatch",
      // Show the line that actually DIFFERS, not the first two. Slicing to [0,2] printed
      // `want ["got 1","drop 1"] got ["got 1","drop 1"]` for a fixture whose third line
      // was the mismatch — two identical-looking arrays reported as a mismatch, which
      // reads as a bug in this harness rather than in the compiler. It cost a diagnostic
      // detour to find out the display was hiding the evidence.
      detail: describeDiff(expected, actual),
    };
  }
  return { name, ok: true, bucket: "pass", detail: "" };
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "milo-sweep-"));
  try {
    let names = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith(".milo"))
      .map(f => basename(f, ".milo"))
      .filter(n => {
        const s = readFileSync(join(FIXTURES_DIR, `${n}.milo`), "utf-8");
        // Fixtures asserting a compile/runtime *error* are not stdout-comparable.
        return !parseExpectedError(s) && !parseExpectedRuntimeError(s);
      })
      .sort();
    if (filter) names = names.filter(n => n.includes(filter));

    const results: Outcome[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < names.length) {
        const n = names[next++];
        results.push(await sweepOne(n, tmpDir));
      }
    }));
    results.sort((a, b) => a.name.localeCompare(b.name));

    // milo-self is nondeterministic under parallel load — a fixture can fail from
    // resource contention alone, which is why two parallel censuses of the same
    // commit used to disagree by ~15 fixtures. Re-run every failure serially and
    // trust that verdict. Only failures are re-run, so the cost is proportional to
    // how broken things are, not to corpus size.
    const failed = results.filter(r => !r.ok);
    if (failed.length && CONCURRENCY > 1) {
      console.error(`re-verifying ${failed.length} failure(s) serially…`);
      for (const f of failed) Object.assign(f, await sweepOne(f.name, tmpDir));
      const recovered = failed.filter(r => r.ok);
      if (recovered.length) {
        console.error(`  ${recovered.length} passed on retry (parallel-load flake): ${recovered.map(r => r.name).join(", ")}`);
      }
    }

    const passing = results.filter(r => r.ok).map(r => r.name);
    const byBucket = new Map<string, Outcome[]>();
    for (const r of results.filter(r => !r.ok)) {
      if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, []);
      byBucket.get(r.bucket)!.push(r);
    }

    console.log(`\n${passing.length}/${results.length} fixtures pass under milo-self\n`);
    for (const [bucket, rs] of [...byBucket].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(rs.length).padStart(3)}  ${bucket}`);
      for (const r of rs.slice(0, 3)) console.log(`         ${r.name}: ${r.detail}`);
      // Names (no detail) for the rest: triage needs the whole set, and re-running
      // the sweep just to see who else is in a bucket costs minutes.
      if (rs.length > 3) console.log(`         … ${rs.length - 3} more: ${rs.slice(3).map(r => r.name).join(", ")}`);
    }

    // The ratchet: every fixture the manifest claims milo-self can build must still
    // build. Exits nonzero on regression so a lane can gate on one number instead of
    // the coordinator reading a diff.
    if (check) {
      const claimed = readFileSync(MANIFEST, "utf-8").split("\n")
        .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      // A guard kill means we never got a verdict — the OS shed the tree under memory
      // pressure. Fail-closed there would make every parallel lane look like a regression.
      const unmeasured = new Set(results.filter(r => r.bucket.startsWith("guard-")).map(r => r.name));
      const regressed = claimed.filter(n => !passing.includes(n) && !unmeasured.has(n));
      const gained = passing.filter(n => !claimed.includes(n));
      if (gained.length) console.log(`\nNEW: ${gained.length} fixture(s) now pass — rerun with --write to ratchet: ${gained.join(", ")}`);
      if (unmeasured.size) console.error(`\nUNMEASURED (guard kill, not counted): ${[...unmeasured].join(", ")}`);
      if (regressed.length) {
        // Name the actual cause when the whole corpus goes down together. A milo-self
        // that builds but miscompiles everything shows up here as "602 fixture(s)
        // regressed" and a 602-line list, which reads as a catastrophic language
        // regression and buries the one fact that matters: the compiler under test is
        // broken, so no fixture verdict below means anything. That is exactly how the
        // 2026-08-20 nightly reported `0/636 fixtures pass` -- the provenance check
        // confirms milo-self.bin MATCHES the source, never that it works.
        const wipeout = passing.length === 0 && claimed.length > 0;
        if (wipeout) {
          console.error(`\nmilo-self COMPILED NOTHING: 0 of ${results.length} fixtures produced a passing run, `
            + `while the manifest claims ${claimed.length}. This is a broken compiler, not ${regressed.length} `
            + `independent regressions, so the per-fixture list is suppressed rather than printed: no fixture `
            + `verdict means anything while the compiler under test is broken. Check that .selfhost/milo-self.bin `
            + `builds and runs a trivial program first.`);
          const modes = [...new Set(results.map(r => r.bucket))].join(", ");
          console.error(`  failure modes seen: ${modes}`);
          process.exit(1);
        }
        console.error(`\nRATCHET FAILED: ${regressed.length} fixture(s) regressed:\n  ${regressed.join("\n  ")}`);
        process.exit(1);
      }
      // Guard kills are excused one at a time, but a milo-self that hangs on every input
      // gets EVERY fixture killed: `regressed` is then empty and the wipeout check above
      // never runs, so the ratchet would pass having measured nothing.
      const measuredClaimed = claimed.filter(n => !unmeasured.has(n)).length;
      if (measuredClaimed < Math.ceil(claimed.length * 0.9)) {
        console.error(`\nRATCHET BLIND: only ${measuredClaimed}/${claimed.length} manifest fixtures got a verdict; the guard killed the rest. Re-run with the machine idle, or check that milo-self terminates.`);
        process.exit(1);
      }
      console.log(`\nRATCHET OK — all ${claimed.length} manifest fixtures still pass`);
    }

    if (write) {
      const old = readFileSync(MANIFEST, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      const lost = old.filter(n => !passing.includes(n));
      if (lost.length) {
        console.error(`\nREFUSING TO WRITE: manifest would shrink — these regressed:\n  ${lost.join("\n  ")}`);
        process.exit(1);
      }
      // A GAIN adopted from one lucky run makes the ratchet permanently red, and it is
      // the adopter who then looks wrong rather than the flake. `arrayOfGenericElements`
      // passed once locally, was written into the manifest, and failed the very next CI
      // sweep -- it passes about 1 run in 3, crashing with no output otherwise.
      //
      // Failures already get re-verified serially above, because a fixture can fail from
      // parallel load alone. Gains deserve the same suspicion in the other direction, so
      // confirm each new one before claiming it forever.
      const gains = passing.filter(n => !old.includes(n));
      const flaky: string[] = [];
      for (const n of gains) {
        for (let i = 0; i < CONFIRM_RUNS; i++) {
          const r = await sweepOne(n, tmpDir);
          if (!r.ok) { flaky.push(`${n} (failed confirmation ${i + 1}/${CONFIRM_RUNS}: ${r.bucket})`); break; }
        }
      }
      const adopted = passing.filter(n => !flaky.some(f => f.startsWith(`${n} `)));
      if (flaky.length) {
        console.error(`\nNOT ADOPTED — passed the sweep but not ${CONFIRM_RUNS} confirmation run(s):\n  ${flaky.join("\n  ")}`);
      }
      const header = readFileSync(MANIFEST, "utf-8").split("\n").filter(l => l.startsWith("#")).join("\n");
      writeFileSync(MANIFEST, `${header}\n${adopted.join("\n")}\n`);
      console.log(`\nmanifest: ${old.length} → ${adopted.length} fixtures`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Guarded so this module can be imported for sweepOne without launching the whole
// sweep. scripts/hir-cover.ts reuses the runner rather than reimplementing it: a second
// copy of "build a fixture with milo-self and diff its output" is the copy that drifts
// and then disagrees with the ratchet about what passing means.
if (import.meta.main) main();
