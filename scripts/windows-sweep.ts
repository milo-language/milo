// Cross-compiles every tests/fixtures/*.milo to windows-x64 and runs the PE,
// comparing stdout to the fixture's `// @expect:` lines.
//
// Three modes:
//   (default)      build + run under Wine, the dev-loop proxy for CI's windows jobs.
//                  Wine validates the link and the CRT calls but is not the OS, so a
//                  green sweep is a strong hint, not proof; CI remains the authority.
//   --out <dir>    build only. Writes each exe plus <dir>/manifest.json =
//                  [{ name, exe (relative to dir), expected: string[] }] for every
//                  graded fixture. CI's `build-windows` job (Linux, has milo-opt).
//   --run <dir>    run only, from a manifest written by --out. Needs no compiler and
//                  no milo-opt, so it works on a Windows host. Runs each exe directly,
//                  or under the program in $MILO_WIN_RUNNER (e.g. `wine`) to test it
//                  on macOS/Linux. Fails closed on a missing/empty manifest, a missing
//                  exe, or fewer exes run than listed. CI's `test-windows` job.
//
//   MILO_WINDOWS_SDK=~/.xwin PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
//     bun scripts/windows-sweep.ts [--jobs N] [--out <dir>] [filter-substring]
//   [MILO_WIN_RUNNER=wine] bun scripts/windows-sweep.ts --run <dir> [--jobs N] [filter-substring]
//
// guardedRun is used for all children: scripts/guard.ts has a win32 path
// (windowsRun: plain spawn + wall-clock timeout, no ps/ulimit), so --run works there.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseExpected } from "../tests/annotations";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const argv = process.argv.slice(2);
const jobsFlag = argv.indexOf("--jobs");
const JOBS = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : 6;
const outFlag = argv.indexOf("--out");
const runFlag = argv.indexOf("--run");
const valueIdx = new Set([jobsFlag + 1, outFlag + 1, runFlag + 1]);
const filter = argv.filter((a, i) => !a.startsWith("--") && !valueIdx.has(i))[0] ?? "";
const OUT_DIR = outFlag >= 0 ? resolve(argv[outFlag + 1] ?? "") : "";
const RUN_DIR = runFlag >= 0 ? resolve(argv[runFlag + 1] ?? "") : "";
if ((outFlag >= 0 && !argv[outFlag + 1]) || (runFlag >= 0 && !argv[runFlag + 1]) || (outFlag >= 0 && runFlag >= 0)) {
  console.error("usage: --out <dir> and --run <dir> take one directory each and are mutually exclusive");
  process.exit(2);
}
const RUNNER = process.env.MILO_WIN_RUNNER || (RUN_DIR ? "" : "wine");

type Manifest = { name: string; exe: string; expected: string[] }[];

async function runExe(file: string, exe: string, expected: string[], record: (o: Outcome) => void) {
  const [cmd, args] = RUNNER ? [RUNNER, [exe]] : [exe, []];
  const run = await guardedRun(cmd, args, {
    env: { ...process.env, WINEDEBUG: "-all" },
    timeoutMs: 30_000,
    virtualMemMb: 8192,
  });
  // Same normalization as tests/run.test.ts — including keeping interior blank
  // lines, which some fixtures assert. `trim()` per line also absorbs the CRLF
  // the MSVC CRT writes in text mode.
  const actual = run.stdout.trim().split("\n").map(l => l.trim());
  const ok = actual.length === expected.length && actual.every((l, i) => l === expected[i]);
  if (ok) record({ file, stage: "ok", detail: "" });
  else record({
    file,
    stage: "run",
    detail: `code=${run.code}${run.signal ? ` sig=${run.signal}` : ""} want ${expected.length} lines got ${actual.length}: ${(run.stderr || actual.join("/")).trim().split("\n").slice(-2).join(" | ").slice(0, 220)}`,
    guardKilled: !!run.guardKill,
  });
}

let OUT = "";
let MILOC = "";
if (!RUN_DIR) {
  if (!process.env.MILO_WINDOWS_SDK) {
    console.error("MILO_WINDOWS_SDK is unset — see AGENTS.md for the xwin setup");
    process.exit(2);
  }
  OUT = OUT_DIR || mkdtempSync(join(tmpdir(), "milo-winsweep-"));
  mkdirSync(OUT, { recursive: true });
  // miloc lives outside the artifact dir so it is not uploaded with the exes.
  const tool = mkdtempSync(join(tmpdir(), "milo-winsweep-tool-"));
  MILOC = join(tool, "miloc");
  execSync(`bun build --compile ${join(ROOT, "src", "main.ts")} --outfile ${MILOC}`, { stdio: "inherit" });
}

type Outcome = { file: string; stage: "build" | "run" | "ok"; detail: string; guardKilled?: boolean };
const results: Outcome[] = [];

function skipped(file: string): string | null {
  const m = readFileSync(join(FIXTURES, file), "utf-8").match(/\/\/\s*@skip-os:\s*(.+)/);
  if (!m) return null;
  return m[1].split(",").map(s => s.trim()).includes("win32") ? m[1].trim() : null;
}

const manifest: Manifest = [];
const packageSkips: string[] = [];
const files = RUN_DIR ? [] : readdirSync(FIXTURES).filter(f => f.endsWith(".milo") && f.includes(filter));
const skippedFiles = files.filter(f => skipped(f));
const active = files.filter(f => !skipped(f));

async function sweep(file: string, record: (o: Outcome) => void) {
  const src = join(FIXTURES, file);
  const exe = join(OUT, file.replace(".milo", ".exe"));
  const companionC = src.replace(/\.milo$/, ".c");
  const args = ["build", src, "--target=windows-x64", "-o", exe.replace(/\.exe$/, "")];
  if (existsSync(companionC)) args.push(companionC);

  const build = await guardedRun(MILOC, args, { env: { ...process.env, MILO_ROOT: ROOT }, virtualMemMb: 8192 });
  // Same rule as tests/run.test.ts: a fixture that reaches an external package is an
  // announced skip naming it when the package is not installed, never a silent drop and
  // never a failure. Any other build error still fails.
  const pkg = readFileSync(src, "utf-8").match(/\/\/\s*@requires-package:\s*(\S+)/)?.[1];
  const out = build.stderr + build.stdout;
  if (build.code !== 0 && pkg && /cannot open|which does not exist|does not support windows/.test(out)) {
    packageSkips.push(`${file} (package '${pkg}' not installed or not for windows)`);
    return;
  }
  if (build.code !== 0) {
    record({
      file,
      stage: "build",
      detail: (build.stderr || build.stdout).trim().split("\n").slice(-4).join(" | "),
      guardKilled: !!build.guardKill,
    });
    return;
  }

  const expected = parseExpected(readFileSync(src, "utf-8"));
  if (OUT_DIR) {
    manifest.push({ name: file, exe: exe.slice(OUT.length + 1), expected });
    record({ file, stage: "ok", detail: "" });
    return;
  }
  await runExe(file, exe, expected, record);
}

async function pass(items: string[], jobs: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await sweep(items[next++], o => out.push(o));
  }));
  return out;
}

// The guard sheds whole trees on *system* memory pressure — including pressure
// from other apps on the machine. Those kills say nothing about the fixture, and
// under a loaded host they can shed 100+ at once, which reads as a wall of Windows
// failures. Retry them serially before believing any of it.
let first: Outcome[];
let skippedCount = skippedFiles.length;
if (RUN_DIR) {
  const mf = join(RUN_DIR, "manifest.json");
  let entries: Manifest = [];
  try { entries = JSON.parse(readFileSync(mf, "utf-8")); } catch (e) {
    console.error(`FAIL cannot read manifest ${mf}: ${e}`);
    process.exit(1);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error(`FAIL manifest ${mf} is empty or not an array: nothing to run`);
    process.exit(1);
  }
  skippedCount = 0;
  const todo = entries.filter(e => e.name.includes(filter));
  if (todo.length === 0) {
    console.error(`FAIL filter "${filter}" matched none of ${entries.length} manifest entries`);
    process.exit(1);
  }
  first = [];
  let ran = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, async () => {
    while (next < todo.length) {
      const e = todo[next++];
      const exe = join(RUN_DIR, e.exe);
      if (!existsSync(exe)) { first.push({ file: e.name, stage: "run", detail: `missing exe ${e.exe}` }); continue; }
      ran++;
      await runExe(e.name, exe, e.expected, o => first.push(o));
    }
  }));
  if (ran < todo.length) console.log(`ran ${ran} of ${todo.length} manifest entries`);
} else {
  first = await pass(active, JOBS);
}
const killed = first.filter(o => o.guardKilled).map(o => o.file);
results.push(...first.filter(o => !o.guardKilled));
if (killed.length > 0) {
  console.log(`retrying ${killed.length} guard-killed (system memory pressure, not fixture failures) serially…`);
  results.push(...(await pass(killed, 1)));
}
const stillKilled = results.filter(o => o.guardKilled);
if (stillKilled.length > 0) {
  console.log(`\n${stillKilled.length} still guard-killed after retry — host is too loaded to trust this sweep:`);
  for (const o of stillKilled) console.log(`  ${o.file}`);
}

results.sort((a, b) => a.file.localeCompare(b.file));
const failed = results.filter(r => r.stage !== "ok" && !r.guardKilled);
for (const r of failed) console.log(`${r.stage.toUpperCase().padEnd(5)} ${r.file}\n      ${r.detail}`);

for (const p of packageSkips) console.log(`SKIP  ${p}`);
const passed = results.filter(r => r.stage === "ok").length;
const graded = passed + failed.length;
console.log(`\n${passed}/${graded} pass (${((passed / graded) * 100).toFixed(1)}%), ${skippedCount} skipped via @skip-os: win32${packageSkips.length ? `, ${packageSkips.length} skipped for a missing package` : ""}${stillKilled.length ? `, ${stillKilled.length} ungraded (guard-killed)` : ""}`);
if (OUT_DIR) {
  // Not written on failure: a manifest from a failed sweep must not pass for a complete one.
  if (failed.length === 0) writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest.sort((a, b) => a.name.localeCompare(b.name)), null, 1));
  console.log(`${manifest.length} exes written to ${OUT}`);
} else if (!RUN_DIR) rmSync(OUT, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
