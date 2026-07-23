// Cross-compiles every tests/fixtures/*.milo to windows-x64 and runs the PE under
// Wine, comparing stdout to the fixture's `// @expect:` lines.
//
// This is the dev-loop proxy for CI's `test-windows` job: Wine validates the link
// and the CRT calls but is not the OS, so a green sweep here is a strong hint, not
// proof. Use it to find which fixtures need `@skip-os: win32` without burning a CI
// round-trip per guess; CI remains the authority.
//
//   MILO_WINDOWS_SDK=~/.xwin PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
//     bun scripts/windows-sweep.ts [--jobs N] [filter-substring]
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { parseExpected } from "../tests/annotations";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const argv = process.argv.slice(2);
const jobsFlag = argv.indexOf("--jobs");
const JOBS = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : 6;
const filter = argv.filter((a, i) => !a.startsWith("--") && i !== jobsFlag + 1)[0] ?? "";

if (!process.env.MILO_WINDOWS_SDK) {
  console.error("MILO_WINDOWS_SDK is unset — see CLAUDE.md for the xwin setup");
  process.exit(2);
}

const OUT = mkdtempSync(join(tmpdir(), "milo-winsweep-"));
const MILOC = join(OUT, "miloc");
execSync(`bun build --compile ${join(ROOT, "src", "main.ts")} --outfile ${MILOC}`, { stdio: "inherit" });

type Outcome = { file: string; stage: "build" | "run" | "ok"; detail: string; guardKilled?: boolean };
const results: Outcome[] = [];

function skipped(file: string): string | null {
  const m = readFileSync(join(FIXTURES, file), "utf-8").match(/\/\/\s*@skip-os:\s*(.+)/);
  if (!m) return null;
  return m[1].split(",").map(s => s.trim()).includes("win32") ? m[1].trim() : null;
}

const files = readdirSync(FIXTURES).filter(f => f.endsWith(".milo") && f.includes(filter));
const skippedFiles = files.filter(f => skipped(f));
const active = files.filter(f => !skipped(f));

async function sweep(file: string, record: (o: Outcome) => void) {
  const src = join(FIXTURES, file);
  const exe = join(OUT, file.replace(".milo", ".exe"));
  const companionC = src.replace(/\.milo$/, ".c");
  const args = ["build", src, "--target=windows-x64", "-o", exe.replace(/\.exe$/, "")];
  if (existsSync(companionC)) args.push(companionC);

  const build = await guardedRun(MILOC, args, { env: { ...process.env, MILO_ROOT: ROOT }, virtualMemMb: 8192 });
  if (build.code !== 0) {
    record({
      file,
      stage: "build",
      detail: (build.stderr || build.stdout).trim().split("\n").slice(-4).join(" | "),
      guardKilled: !!build.guardKill,
    });
    return;
  }

  const run = await guardedRun("wine", [exe], {
    env: { ...process.env, WINEDEBUG: "-all" },
    timeoutMs: 30_000,
    virtualMemMb: 8192,
  });
  const expected = parseExpected(readFileSync(src, "utf-8"));
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
const first = await pass(active, JOBS);
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

const passed = results.filter(r => r.stage === "ok").length;
const graded = passed + failed.length;
console.log(`\n${passed}/${graded} pass (${((passed / graded) * 100).toFixed(1)}%), ${skippedFiles.length} skipped via @skip-os: win32${stillKilled.length ? `, ${stillKilled.length} ungraded (guard-killed)` : ""}`);
rmSync(OUT, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
