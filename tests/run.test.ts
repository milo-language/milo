import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { poolTimeoutMs, poolMarginWarning } from "./pool-budget";
import { readdirSync, readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { tmpdir, devNull, homedir } from "os";
import { join } from "path";
import { parseExpected, parseExpectedError, parseExpectedRuntimeError, parseKnownRed } from "./annotations";
import { guardedRun, type RunResult } from "../scripts/guard";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const ERRORS_DIR = join(import.meta.dir, "errors");
const RUNTIME_ERRORS_DIR = join(import.meta.dir, "runtime-errors");
const MILO_ROOT = join(import.meta.dir, "..");

// Spawning `bun run src/main.ts` per program re-transpiles the whole compiler
// each time (~100ms and ~300MB per spawn — concurrent spawns OOM under the test
// runner). Compile the compiler to a standalone binary once and invoke that;
// MILO_ROOT tells it where std/ lives since a bundled binary's import.meta.url
// doesn't map to the repo.
const TOOL_DIR = mkdtempSync(join(tmpdir(), "milo-testc-"));
const IS_WINDOWS = process.platform === "win32";
// `bun build --compile` and `milo build -o` both append .exe on Windows; the
// paths we spawn have to carry it, since CreateProcess does no PATHEXT lookup
// for an absolute path.
const EXE = IS_WINDOWS ? ".exe" : "";
const MILOC = join(TOOL_DIR, "miloc") + EXE;
const CHILD_ENV = { ...process.env, MILO_ROOT };
// Output path for the type-error lane, where the compile is expected to fail
// before anything is written. Windows' NUL device is not a path lld-link will
// accept as an output file, so point it at a scratch name there instead.
const REJECTED_OUT = IS_WINDOWS ? join(TOOL_DIR, "rejected") : devNull;
// The compile-pool budget and its margin warning live in ./pool-budget so they can be
// tested directly: the budget only bites on a slow CI runner and the warning only fires in
// a narrow band, so neither is observable from an ordinary run of this file.
const POOL_TIMEOUT_MS = (n: number) => poolTimeoutMs(n, IS_WINDOWS);

function reportPoolMargin(lane: string, elapsedMs: number, budgetMs: number): void {
  const line = poolMarginWarning(lane, elapsedMs, budgetMs);
  if (line) console.warn(line);
}

beforeAll(() => {
  execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
});

// All compiles and fixture binaries run under guardedRun: macOS enforces no
// rlimits, so a miscompiled program that allocates in a loop would otherwise
// swap the machine to death. The guard SIGKILLs the tree on RSS breach.
async function run(cmd: string, args: string[]): Promise<RunResult> {
  // Bun standalone binaries reserve more than 4 GiB of sparse virtual address
  // space on Linux while using ~80 MiB RSS. Keep the real-memory guard at 4 GiB,
  // but give RLIMIT_AS enough headroom for that reservation.
  return guardedRun(cmd, args, { env: CHILD_ENV, virtualMemMb: 8192 });
}

// Retry once on signal-based failures (resource pressure under full suite).
async function runWithRetry(cmd: string, args: string[]): Promise<RunResult> {
  const r = await run(cmd, args);
  if (r.signal) return run(cmd, args);
  return r;
}

// Bounded-parallel map: compiles are independent and CPU-bound; cap in-flight
// processes to avoid oversubscription.
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      await fn(items[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Keep workers × guard cap below half of RAM (CLAUDE.md). Large CI/dev hosts can
// report 72+ cores; subtracting two would launch enough clang processes to trip
// the global guard and return empty, signal-killed build results.
const COMPILE_JOBS = Number(process.env.MILO_TEST_JOBS)
  || Math.min(8, Math.max(2, (navigator.hardwareConcurrency ?? 8) - 2));

const binaries: string[] = [];
afterAll(() => {
  for (const bin of binaries) {
    try { unlinkSync(bin); } catch {}
  }
  try { rmSync(TOOL_DIR, { recursive: true, force: true }); } catch {}
});


// Compiles fan out in beforeAll (expensive, timing-insensitive); the produced
// binaries then run serially inside each test — timing-sensitive fixtures
// (green threads, channels, select) flake under concurrent CPU load, so the
// run phase stays sequential.
// A fixture may carry `// @skip-os: <platform>` (comma-separated) when it
// asserts a layout or behaviour that is genuinely platform-specific — e.g. a C
// struct whose member types differ across targets, or an API the target has no
// equivalent for — so it neither builds nor runs on that platform. Uses
// process.platform values ("darwin", "linux", "win32"). Every skip must say
// why in a comment beside it: the Windows set is a map of the remaining port
// work (docs/roadmap.md), and a bare skip would hide it.
function skippedHere(dir: string, file: string): boolean {
  const m = readFileSync(join(dir, file), "utf-8").match(/\/\/\s*@skip-os:\s*(.+)/);
  if (!m) return false;
  return m[1].split(",").map(s => s.trim()).includes(process.platform);
}

// `bun test -t <pat>` is consumed by the runner and scrubbed from `process.argv` before a
// test file loads (verified on bun 1.3.10 — argv holds only the executable and the file),
// so the pattern has to be read back off the real command line. Fails open: any trouble
// here means "no filter", i.e. compile everything, which is only slow, never wrong.
function bunTestNamePattern(): string | undefined {
  let cmdline: string;
  try {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(process.pid)], { encoding: "utf-8" });
    cmdline = r.stdout ?? "";
  } catch { return undefined; }
  // The pattern may contain spaces (`-t "green threads"`), which `ps` renders unquoted —
  // so take everything up to the next flag rather than the next whitespace.
  const m = cmdline.match(/(?:^|\s)(?:-t|--test-name-pattern)[= ](.+?)(?=\s+-{1,2}[A-Za-z]|\s*$)/);
  return m?.[1]?.trim() || undefined;
}

// Bun's `-t` decides which tests RUN, but the compile fan-out below is ours and runs in
// `beforeAll` — so without this, `-t "arithmetic"` still built all 577 fixtures and cost
// 34s to execute one test. Mirroring the filter here is what makes a targeted run cheap.
// It only ever narrows the SAME `files` list that generates the tests, so a pattern this
// reads differently from bun can under-generate tests but can never leave a generated
// test without its build.
const nameMatches: (describeName: string, testName: string) => boolean = (() => {
  const pattern = process.env.MILO_TEST_FILTER || bunTestNamePattern();
  if (!pattern) return () => true;
  let re: RegExp | null = null;
  try { re = new RegExp(pattern); } catch { re = null; }
  const hit = (s: string) => (re ? re.test(s) : s.includes(pattern));
  // Match permissively: bun tests the full "describe > test" name, but a pattern aimed at
  // the leaf alone is the common case and must not silently compile nothing.
  return (d, t) => hit(t) || hit(`${d} > ${t}`);
})();

// A fixture may carry `// @requires-package: <name>` when it reaches, directly or through
// an example it imports, a module that imports an external package. Fixtures compile with
// no project manifest and CI installs nothing, so such a package is simply absent there and
// the fixture cannot build — `error[import]: cannot open 'gl'`.
//
// Reported as an EXPLICIT skip naming the missing package, never dropped from the list the
// way `@skip-os` drops a fixture. A test that silently stops existing is the failure this
// suite is supposed to catch, and the annotation is meant to be read as a debt: the fixture
// wants the pure part of what it imports factored out of the package-reaching path.
function requiredPackage(dir: string, file: string): string | null {
  const m = readFileSync(join(dir, file), "utf-8").match(/\/\/\s*@requires-package:\s*(\S+)/);
  return m ? m[1] : null;
}

// Can this fixture's package actually be resolved? ASK THE COMPILER rather than guess
// at the cache layout, which is what the previous version did and got wrong: it scanned
// the cache for a directory named exactly `gl`, while `milo install` lays a package down
// under its REPO name (github.com/milo-language/milo-gl/v0.2.0). So the fixture skipped
// on every machine that had installed the package normally, and ran only where a legacy
// `gl` directory happened to survive -- a skip that fired precisely when it should not.
//
// The alias cannot be looked up by name either: flybyGeometry reaches `gl` transitively
// through examples/games/flight, so the mapping lives in THAT project's manifest, not
// anywhere this test can see. A resolution attempt is the only honest answer, and it
// costs one `check` per fixture carrying the annotation (one, today).
function packageUnresolvable(dir: string, file: string): boolean {
  try {
    const r = spawnSync("bun", ["run", "src/main.ts", "check", join(dir, file)], {
      encoding: "utf8", timeout: 60_000,
    });
    if (r.status === 0) return false;
    const out = (r.stderr || "") + (r.stdout || "");
    return /not found in the local package cache|cannot open module/.test(out);
  } catch { return true; }
}
// tests/known-red.txt lists fixtures that reproduce an OPEN soundness hole (the
// tests/holes-2026-09 reproducers promoted by docs/plans/soundness-sweep-2026-09.md).
// Each is registered as a skip that names its reason, so the count stays visible in
// every run, and a summary line says how many were skipped. The list is what keeps
// `bun test` green while the fix is in flight; scripts/asan-sweep.ts skips nothing on its
// account (it only labels the line), so the hole still shows red where it belongs. A stale entry (a name that is no
// longer a fixture) throws: the entry must be deleted in the same change that closes
// the hole, or the driver would go on excusing a file that no longer needs it.
const KNOWN_RED_FILE = join(import.meta.dir, "known-red.txt");
function knownRed(): Map<string, string> {
  if (!existsSync(KNOWN_RED_FILE)) return new Map();
  const out = parseKnownRed(readFileSync(KNOWN_RED_FILE, "utf-8"));
  for (const name of out.keys()) {
    if (!existsSync(join(FIXTURES_DIR, name))) {
      throw new Error(`tests/known-red.txt names '${name}', which is not in tests/fixtures/: delete the entry`);
    }
  }
  return out;
}

function lane(dir: string, describeName: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.filter(f =>
    f.endsWith(".milo")
    && !skippedHere(dir, f)
    && nameMatches(describeName, f.replace(".milo", "")));
}

describe("fixtures (compile + run)", () => {
  const all = lane(FIXTURES_DIR, "fixtures (compile + run)");
  // Split rather than filtered: the unbuildable ones still register, as skips that name
  // the package, so the count in the report stays honest.
  const blocked = new Map<string, string>();
  const files: string[] = [];
  for (const f of all) {
    const pkg = requiredPackage(FIXTURES_DIR, f);
    if (pkg && packageUnresolvable(FIXTURES_DIR, f)) blocked.set(f, pkg);
    else files.push(f);
  }
  for (const [file, pkg] of blocked) {
    test.skip(`${file.replace(".milo", "")} — needs the '${pkg}' package, which is not installed`, () => {}); // reason is the test name itself, and the fixture carries the debt note
  }
  const red = knownRed();
  let skippedRed = 0;
  for (const [file, reason] of red) {
    const i = files.indexOf(file);
    if (i < 0) continue; // filtered out by -t or @skip-os; not this run's concern
    files.splice(i, 1);
    skippedRed++;
    test.skip(`${file.replace(".milo", "")}: known-red, ${reason}`, () => {}); // reason is the test name itself; tests/known-red.txt carries the closing WP
  }
  console.log(`known-red: ${skippedRed} fixtures skipped (tests/known-red.txt)`);
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
    const startedAt = Date.now();
    await mapPool(files, COMPILE_JOBS, async (file) => {
      const path = join(FIXTURES_DIR, file);
      const outBin = join(FIXTURES_DIR, file.replace(".milo", ""));
      binaries.push(outBin + EXE);
      // a companion `<name>.c` (C ABI test peers) is linked into the build so Milo
      // and clang agree on struct layout / by-value calling convention
      const companionC = path.replace(/\.milo$/, ".c");
      const buildArgs = ["build", path, "-o", outBin];
      if (existsSync(companionC)) buildArgs.push(companionC);
      builds.set(file, await runWithRetry(MILOC, buildArgs));
    });
    reportPoolMargin("fixtures", Date.now() - startedAt, POOL_TIMEOUT_MS(files.length));
  }, POOL_TIMEOUT_MS(files.length));

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const source = readFileSync(join(FIXTURES_DIR, file), "utf-8");
      const expected = parseExpected(source);

      const build = builds.get(file)!;
      if (build.code !== 0) throw new Error(`build failed for ${file}:\n${build.stderr}`);

      const result = await runWithRetry(join(FIXTURES_DIR, file.replace(".milo", "")) + EXE, []);
      const actual = result.stdout.trim().split("\n").map(l => l.trim());

      expect(actual).toEqual(expected);
    }, 30000);
  }
});

describe("errors (type checker rejects)", () => {
  // Same @skip-os contract as the fixture lane: a negative test can be as
  // platform-bound as a positive one — asserting on a diagnostic that quotes a
  // POSIX header proves nothing where that header doesn't exist.
  const files = lane(ERRORS_DIR, "errors (type checker rejects)");
  const results = new Map<string, RunResult>();

  // Compile-only lane: the compile IS the test, so results are captured in the
  // pool and the tests just assert.
  beforeAll(async () => {
    const startedAt = Date.now();
    await mapPool(files, COMPILE_JOBS, async (file) => {
      results.set(file, await run(MILOC, ["build", join(ERRORS_DIR, file), "-o", REJECTED_OUT]));
    });
    reportPoolMargin("errors", Date.now() - startedAt, POOL_TIMEOUT_MS(files.length));
  }, POOL_TIMEOUT_MS(files.length));

  for (const file of files) {
    test(file.replace(".milo", ""), () => {
      const source = readFileSync(join(ERRORS_DIR, file), "utf-8");
      const expectedError = parseExpectedError(source);

      const r = results.get(file)!;
      expect(r.code !== 0).toBe(true);
      // Required, not optional. Without the message assertion the test only says the
      // program failed to compile — which an unrelated syntax typo would satisfy just
      // as well as the rule the fixture exists to pin.
      expect(`${file}: ${expectedError ?? "NO @error: ANNOTATION"}`).toBe(`${file}: ${expectedError}`);
      expect(r.stderr).toContain(expectedError!);
    });
  }
});

describe("runtime errors (debug mode traps)", () => {
  const files = lane(RUNTIME_ERRORS_DIR, "runtime errors (debug mode traps)");
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
    const startedAt = Date.now();
    await mapPool(files, COMPILE_JOBS, async (file) => {
      const path = join(RUNTIME_ERRORS_DIR, file);
      const outBin = join(RUNTIME_ERRORS_DIR, file.replace(".milo", ""));
      binaries.push(outBin + EXE);
      builds.set(file, await runWithRetry(MILOC, ["build", path, "--debug", "-o", outBin]));
    });
    reportPoolMargin("runtime-errors", Date.now() - startedAt, POOL_TIMEOUT_MS(files.length));
  }, POOL_TIMEOUT_MS(files.length));

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const source = readFileSync(join(RUNTIME_ERRORS_DIR, file), "utf-8");
      const expectedError = parseExpectedRuntimeError(source);

      const build = builds.get(file)!;
      if (build.code !== 0) throw new Error(`build failed for ${file}:\n${build.stderr}`);

      const r = await run(join(RUNTIME_ERRORS_DIR, file.replace(".milo", "")) + EXE, []);
      expect(r.code !== 0).toBe(true);
      // Required, not optional — the same hardening the `errors` lane above already got.
      // `if (expectedError)` left an unannotated fixture asserting nothing but "exited
      // non-zero", which a build that traps for an unrelated reason satisfies just as
      // well as the trap the fixture exists to pin. All 20 fixtures are annotated today;
      // this is so the twenty-first cannot quietly not be.
      expect(`${file}: ${expectedError ?? "NO @runtime-error: ANNOTATION"}`).toBe(`${file}: ${expectedError}`);
      // Panics go to stderr; a fixture that printed before dying leaves stdout non-empty.
      expect(r.stdout + r.stderr).toContain(expectedError!);
    }, 30000);
  }
});
