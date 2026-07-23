// Smoke test: every shipped example must still compile as the language evolves.
// `bun test` otherwise only walks tests/fixtures + tests/errors, so examples/
// could rot silently. This emit-ir's each entry point (full pipeline minus the
// clang link) and fails on a nonzero exit OR any compiler warning.
import { test, expect, describe, beforeAll } from "bun:test";
import { readdirSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun } from "../scripts/guard";

const MILO_ROOT = join(import.meta.dir, "..");
const EXAMPLES_DIR = join(MILO_ROOT, "examples");
const TOOL_DIR = mkdtempSync(join(tmpdir(), "milo-examplesc-"));
const MILOC = join(TOOL_DIR, "miloc");
const CHILD_ENV = { ...process.env, MILO_ROOT };

beforeAll(() => {
  execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
});

// Multi-file apps (dirs with helper/smoke files) — list the real entry points;
// a bare glob would try to compile partial modules that have no main().
const DIR_ENTRIES = [
  "emulators/nes/nes.milo",
  "emulators/genesis/genesis.milo",
  "emulators/snes/snes.milo",
  "net/weather/app.milo",
  "net/termpair/server.milo",
  "net/termpair/client.milo",
  "tools/hades/src/main.milo",
];

// Only the top level of each folder: subdirs hold helper modules and smoke
// programs that aren't standalone entry points (those go in DIR_ENTRIES).
const TOP_LEVEL_DIRS = [
  ".", "basics", "cli-tools", "graphics", "simulation",
  "terminal", "net", "emulators", "embedded", "runtimes",
];

function topLevel(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith(".milo")).map(f => join(dir, f));
}

const entries = [
  ...TOP_LEVEL_DIRS.flatMap(d => topLevel(join(EXAMPLES_DIR, d))),
  ...DIR_ENTRIES.map(p => join(EXAMPLES_DIR, p)),
];

describe("examples compile", () => {
  for (const path of entries) {
    const name = path.slice(MILO_ROOT.length + 1);
    test(name, async () => {
      // Bun standalone reserves >4 GiB of sparse address space on Linux while
      // staying far below the guard's 4 GiB RSS cap.
      const r = await guardedRun(MILOC, ["emit-ir", path], { env: CHILD_ENV, virtualMemMb: 8192 });
      if (r.code !== 0) {
        throw new Error(`compile failed (exit ${r.code}, signal ${r.signal}):\n${r.stderr}`);
      }
      // Warnings land on stderr as "warning: ..."; stdout is IR (may contain the
      // word in string constants, so only stderr counts).
      expect(r.stderr, `unexpected compiler warning:\n${r.stderr}`).not.toMatch(/\bwarning:/);
    });
  }
});
