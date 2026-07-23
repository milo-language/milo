import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir, devNull } from "os";
import { join } from "path";
import { parseExpected, parseExpectedError, parseExpectedRuntimeError } from "./annotations";
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
// Windows CI runners are ~4 cores and clang-on-COFF is slower than the mac/linux
// path; the 5-minute pool budget that fits macOS times out there before the
// fixture set finishes compiling.
const POOL_TIMEOUT_MS = IS_WINDOWS ? 1_500_000 : 300_000;

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
const COMPILE_JOBS = Math.min(8, Math.max(2, (navigator.hardwareConcurrency ?? 8) - 2));

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

describe("fixtures (compile + run)", () => {
  const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".milo") && !skippedHere(FIXTURES_DIR, f));
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
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
  }, POOL_TIMEOUT_MS);

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
  const files = readdirSync(ERRORS_DIR).filter(f => f.endsWith(".milo") && !skippedHere(ERRORS_DIR, f));
  const results = new Map<string, RunResult>();

  // Compile-only lane: the compile IS the test, so results are captured in the
  // pool and the tests just assert.
  beforeAll(async () => {
    await mapPool(files, COMPILE_JOBS, async (file) => {
      results.set(file, await run(MILOC, ["build", join(ERRORS_DIR, file), "-o", REJECTED_OUT]));
    });
  }, POOL_TIMEOUT_MS);

  for (const file of files) {
    test(file.replace(".milo", ""), () => {
      const source = readFileSync(join(ERRORS_DIR, file), "utf-8");
      const expectedError = parseExpectedError(source);

      const r = results.get(file)!;
      expect(r.code !== 0).toBe(true);
      if (expectedError) {
        expect(r.stderr).toContain(expectedError);
      }
    });
  }
});

describe("runtime errors (debug mode traps)", () => {
  let files: string[] = [];
  try { files = readdirSync(RUNTIME_ERRORS_DIR).filter(f => f.endsWith(".milo") && !skippedHere(RUNTIME_ERRORS_DIR, f)); } catch {}
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
    await mapPool(files, COMPILE_JOBS, async (file) => {
      const path = join(RUNTIME_ERRORS_DIR, file);
      const outBin = join(RUNTIME_ERRORS_DIR, file.replace(".milo", ""));
      binaries.push(outBin + EXE);
      builds.set(file, await runWithRetry(MILOC, ["build", path, "--debug", "-o", outBin]));
    });
  }, POOL_TIMEOUT_MS);

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const source = readFileSync(join(RUNTIME_ERRORS_DIR, file), "utf-8");
      const expectedError = parseExpectedRuntimeError(source);

      const build = builds.get(file)!;
      if (build.code !== 0) throw new Error(`build failed for ${file}:\n${build.stderr}`);

      const r = await run(join(RUNTIME_ERRORS_DIR, file.replace(".milo", "")) + EXE, []);
      expect(r.code !== 0).toBe(true);
      if (expectedError) {
        expect(r.stdout).toContain(expectedError);
      }
    }, 30000);
  }
});
