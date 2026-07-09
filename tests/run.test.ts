import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "fs";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

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
const MILOC = join(TOOL_DIR, "miloc");
const CHILD_ENV = { ...process.env, MILO_ROOT };

beforeAll(() => {
  execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
});

type RunResult = { stdout: string; stderr: string; code: number; signal: string | null };

async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      env: CHILD_ENV,
    });
    return { stdout, stderr, code: 0, signal: null };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1, signal: e.signal ?? null };
  }
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

const COMPILE_JOBS = Math.max(2, (navigator.hardwareConcurrency ?? 8) - 2);

const binaries: string[] = [];
afterAll(() => {
  for (const bin of binaries) {
    try { unlinkSync(bin); } catch {}
  }
  try { rmSync(TOOL_DIR, { recursive: true, force: true }); } catch {}
});

// Annotations are matched after trimming: the formatter indents comments to
// their enclosing block, so requiring column 0 would make `milo fmt` break
// every fixture whose annotation sits inside a function body.
function parseExpected(source: string): string[] {
  return source.split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("// @expect:"))
    .map(l => l.replace("// @expect:", "").trim());
}

function parseExpectedError(source: string): string | null {
  const line = source.split("\n").map(l => l.trim()).find(l => l.startsWith("// @error:"));
  return line ? line.replace("// @error:", "").trim() : null;
}

function parseExpectedRuntimeError(source: string): string | null {
  const line = source.split("\n").map(l => l.trim()).find(l => l.startsWith("// @runtime-error:"));
  return line ? line.replace("// @runtime-error:", "").trim() : null;
}

// Compiles fan out in beforeAll (expensive, timing-insensitive); the produced
// binaries then run serially inside each test — timing-sensitive fixtures
// (green threads, channels, select) flake under concurrent CPU load, so the
// run phase stays sequential.
describe("fixtures (compile + run)", () => {
  const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".milo"));
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
    await mapPool(files, COMPILE_JOBS, async (file) => {
      const path = join(FIXTURES_DIR, file);
      const outBin = join(FIXTURES_DIR, file.replace(".milo", ""));
      binaries.push(outBin);
      // a companion `<name>.c` (C ABI test peers) is linked into the build so Milo
      // and clang agree on struct layout / by-value calling convention
      const companionC = path.replace(/\.milo$/, ".c");
      const buildArgs = ["build", path, "-o", outBin];
      if (existsSync(companionC)) buildArgs.push(companionC);
      builds.set(file, await runWithRetry(MILOC, buildArgs));
    });
  }, 300000);

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const source = readFileSync(join(FIXTURES_DIR, file), "utf-8");
      const expected = parseExpected(source);

      const build = builds.get(file)!;
      if (build.code !== 0) throw new Error(`build failed for ${file}:\n${build.stderr}`);

      const result = await runWithRetry(join(FIXTURES_DIR, file.replace(".milo", "")), []);
      const actual = result.stdout.trim().split("\n").map(l => l.trim());

      expect(actual).toEqual(expected);
    }, 30000);
  }
});

describe("errors (type checker rejects)", () => {
  const files = readdirSync(ERRORS_DIR).filter(f => f.endsWith(".milo"));
  const results = new Map<string, RunResult>();

  // Compile-only lane: the compile IS the test, so results are captured in the
  // pool and the tests just assert.
  beforeAll(async () => {
    await mapPool(files, COMPILE_JOBS, async (file) => {
      results.set(file, await run(MILOC, ["build", join(ERRORS_DIR, file), "-o", "/dev/null"]));
    });
  }, 300000);

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
  try { files = readdirSync(RUNTIME_ERRORS_DIR).filter(f => f.endsWith(".milo")); } catch {}
  const builds = new Map<string, RunResult>();

  beforeAll(async () => {
    await mapPool(files, COMPILE_JOBS, async (file) => {
      const path = join(RUNTIME_ERRORS_DIR, file);
      const outBin = join(RUNTIME_ERRORS_DIR, file.replace(".milo", ""));
      binaries.push(outBin);
      builds.set(file, await runWithRetry(MILOC, ["build", path, "--debug", "-o", outBin]));
    });
  }, 300000);

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const source = readFileSync(join(RUNTIME_ERRORS_DIR, file), "utf-8");
      const expectedError = parseExpectedRuntimeError(source);

      const build = builds.get(file)!;
      if (build.code !== 0) throw new Error(`build failed for ${file}:\n${build.stderr}`);

      const r = await run(join(RUNTIME_ERRORS_DIR, file.replace(".milo", "")), []);
      expect(r.code !== 0).toBe(true);
      if (expectedError) {
        expect(r.stdout).toContain(expectedError);
      }
    }, 30000);
  }
});
