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
// M1 status: `check` and `run` on a trivial program are both fixed and gated.
// See docs/self-hosting.md for the three root causes (move-out-of-index,
// enum payload sizing, and deref-of-borrowed-Heap in an argument position).
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseExpected } from "./annotations";
import { guardedRun, type RunResult } from "../scripts/guard";

const MILO_ROOT = join(import.meta.dir, "..");
const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const MANIFEST = join(import.meta.dir, "selfhost-manifest.txt");
// .bin is the real binary — .selfhost/milo-self is a guard wrapper for manual
// use; the harness guards via guardedRun itself, so it calls .bin directly.
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");

// Hard gate: milo-self must type-check a trivial program. Regressing this means
// re-introducing the memory corruption M1 fixed.
const CHECK_MUST_PASS = true;
// Hard gate: milo-self must compile+run a trivial program end to end.
const RUN_MUST_PASS = true;

const CHILD_ENV = { ...process.env, MILO_ROOT };

// milo-self and the binaries it produces are UNTRUSTED: known memory bugs
// mean any invocation can allocate without bound, and macOS enforces no
// rlimits — an unguarded run has swap-thrashed the whole machine. Everything
// goes through guardedRun, which SIGKILLs the process tree on RSS breach.
// 2GB cap: healthy milo-self compiles use well under this, and the tighter
// the cap the sooner the watchdog fires — before swap pressure blinds it.
async function run(cmd: string, args: string[], cwd?: string, timeoutMs = 60000, memMb = 2048): Promise<RunResult> {
  return guardedRun(cmd, args, { env: CHILD_ENV, cwd, timeoutMs, memMb });
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
  buildResult = await run("sh", [join(MILO_ROOT, "scripts", "selfhost.sh")], MILO_ROOT, 240000);
}, 300000);

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("milo-self", () => {
  test("builds with the TS compiler", () => {
    if (buildResult.code !== 0) throw new Error(`scripts/selfhost.sh failed:\n${buildResult.stderr}`);
    expect(existsSync(MILO_SELF)).toBe(true);
  });

  // parseAttribute demanded TokKind.Ident for every attribute arg, but @cSig/@cLayout
  // take string literals. expect() soft-validates — it prints and returns the token
  // anyway — so the args still parsed correctly and the ONLY symptom was 42 bogus
  // "parse error" lines on every self-build. Correct output is exactly why it survived:
  // nothing failed, so nothing caught it. Gate on stderr, not just the exit code.
  test("check of a file with string attribute args is silent", async () => {
    const src = join(tmpDir, "attrArgs.milo");
    writeFileSync(src,
      '@cSig("unistd.h", "int close(int)")\n' +
      "extern fn close(fd: i32): i32\n\n" +
      "fn main(): i32 {\n    return 0\n}\n");
    const r = await run(MILO_SELF, ["check", src]);
    expect(r.stderr).not.toContain("parse error");
    expect(r.code).toBe(0);
  }, 60000);

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

// Bootstrap convergence — the self-hosting claim itself, which nothing gated until now.
//
// If milo-self and the compiler IT builds are the same program, they must emit the same
// IR for the same input. That is the fixpoint; M5 is recorded as converged on exactly
// this basis, but scripts/selfhost.sh only ever built stage1, so a divergence could land
// silently.
//
// Compare the EMITTED IR, never the linked binaries. Two links of identical code differ
// by 47 bytes at ~offset 1369 — the Mach-O LC_UUID, which the linker mints per link — so
// a binary comparison reports a divergence that isn't there and would read as a broken
// bootstrap forever. Ask me how I know.
//
// Honest limitation: this is correct by construction but has never been seen to FAIL. A
// synthetic divergence is hard to stage — editing src-milo/ changes stage1 and stage2
// alike (beforeAll rebuilds stage1 from the same source), so they still agree, and
// keeping a stale stage1 instead just means the edited string shows up in both files as a
// data constant. A true divergence needs a real miscompile: milo-self compiling its own
// source into a compiler that behaves differently. That is exactly the bug worth
// catching, and exactly what cannot be faked cheaply.
describe("bootstrap convergence", () => {
  test("milo-self and the compiler it builds emit identical IR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-converge-"));
    try {
      const entry = join(MILO_ROOT, "src-milo", "main.milo");

      const ir1 = await run(MILO_SELF, ["emit-ir", entry], MILO_ROOT, 120000, 4096);
      expect(ir1.code).toBe(0);
      expect(ir1.stdout.length).toBeGreaterThan(1000);

      // stage2: milo-self compiles its own source.
      const stage2 = join(dir, "stage2.bin");
      const build = await run(MILO_SELF, ["build", entry, "-o", stage2], MILO_ROOT, 300000, 4096);
      expect(build.code).toBe(0);

      const ir2 = await run(stage2, ["emit-ir", entry], MILO_ROOT, 120000, 4096);
      expect(ir2.code).toBe(0);

      // Byte-identical, not merely same-length: a codegen divergence can preserve size.
      expect(ir2.stdout).toBe(ir1.stdout);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }, 480000);
});
