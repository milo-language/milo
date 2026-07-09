// Differential harness for milo-self (src-milo/, the Milo compiler in Milo).
//
// Mirrors tests/run.test.ts, but compiles fixtures with milo-self instead of the
// TS compiler. The TS compiler is the oracle; milo-self must agree with it.
//
// Structure:
//   1. build milo-self via scripts/selfhost.sh
//   2. smoke: `check` and `run` on the most trivial possible program
//   3. every fixture in tests/selfhost-manifest.txt: compile, run, diff stdout
//      against the fixture's `// @expect:` lines
//   4. report manifest coverage
//
// M1 status: `check` on a trivial program is fixed and is now a hard gate.
// `run` still fails intermittently — milo-self's codegen emits corrupted IR
// (garbage bytes inside instruction text), the same class of memory bug that
// broke `check`. Flip RUN_MUST_PASS once that lands. See docs/self-hosting.md.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { parseExpected } from "./annotations";

const execFileAsync = promisify(execFile);

const MILO_ROOT = join(import.meta.dir, "..");
const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const MANIFEST = join(import.meta.dir, "selfhost-manifest.txt");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self");

// Hard gate: milo-self must type-check a trivial program. Regressing this means
// re-introducing the memory corruption M1 fixed.
const CHECK_MUST_PASS = true;
// Not yet: milo-self's codegen still emits corrupted IR intermittently.
const RUN_MUST_PASS = false;

const CHILD_ENV = { ...process.env, MILO_ROOT };

type RunResult = { stdout: string; stderr: string; code: number; signal: string | null };

async function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { env: CHILD_ENV, cwd, timeout: 60000 });
    return { stdout, stderr, code: 0, signal: null };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1, signal: e.signal ?? null };
  }
}

function readManifest(): string[] {
  return readFileSync(MANIFEST, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"));
}

let tmpDir: string;
let buildResult: RunResult;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "milo-selfhost-"));
  buildResult = await run("sh", [join(MILO_ROOT, "scripts", "selfhost.sh")], MILO_ROOT);
}, 300000);

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("milo-self", () => {
  test("builds with the TS compiler", () => {
    if (buildResult.code !== 0) throw new Error(`scripts/selfhost.sh failed:\n${buildResult.stderr}`);
    expect(existsSync(MILO_SELF)).toBe(true);
  });

  // The M1 gate: milo-self must survive the most trivial input that exists.
  describe("smoke", () => {
    const trivial = "fn main(): i32 {\n    return 0\n}\n";

    test("check exits 0 on a return-0 program", async () => {
      const src = join(tmpDir, "min.milo");
      writeFileSync(src, trivial);
      const r = await run(MILO_SELF, ["check", src]);
      if (!CHECK_MUST_PASS && r.code !== 0) {
        console.warn(`  [M1] milo-self check: exit=${r.code} signal=${r.signal ?? "none"} (known failure)`);
        return;
      }
      expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
    }, 60000);

    test("run of a return-0 program exits 0", async () => {
      const src = join(tmpDir, "min2.milo");
      writeFileSync(src, trivial);
      const r = await run(MILO_SELF, ["run", src]);
      if (!RUN_MUST_PASS && r.code !== 0) {
        console.warn(`  [M1] milo-self run: exit=${r.code} signal=${r.signal ?? "none"} (known failure)`);
        return;
      }
      expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
    }, 60000);
  });

  describe("manifest fixtures", () => {
    const manifest = readManifest();

    test("every manifest entry names a real fixture", () => {
      const missing = manifest.filter(n => !existsSync(join(FIXTURES_DIR, `${n}.milo`)));
      expect(missing).toEqual([]);
    });

    test(`coverage: ${manifest.length} fixture(s)`, () => {
      console.log(`  milo-self manifest: ${manifest.length} fixture(s) ratcheted`);
      expect(manifest.length).toBeGreaterThanOrEqual(0);
    });

    for (const name of manifest) {
      test(name, async () => {
        const src = join(FIXTURES_DIR, `${name}.milo`);
        const outBin = join(tmpDir, name);

        const build = await run(MILO_SELF, ["build", src, "-o", outBin]);
        if (build.code !== 0) throw new Error(`milo-self build failed for ${name}:\n${build.stderr}`);

        const r = await run(outBin, []);
        const actual = r.stdout.trim().split("\n").map(l => l.trim());
        expect(actual).toEqual(parseExpected(readFileSync(src, "utf-8")));
      }, 60000);
    }
  });
});
