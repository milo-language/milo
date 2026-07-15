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
const APPS_DIR = join(MILO_ROOT, "examples", "apps");
const CLI_DIR = join(MILO_ROOT, "examples", "cli-tools");
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
  "nes/nes.milo",
  "genesis/genesis.milo",
  "snes/snes.milo",
  "weather/app.milo",
  "termpair/server.milo",
  "termpair/client.milo",
  "hades/src/main.milo",
];

function topLevel(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith(".milo")).map(f => join(dir, f));
}

const entries = [
  ...topLevel(APPS_DIR),
  ...topLevel(CLI_DIR),
  ...DIR_ENTRIES.map(p => join(APPS_DIR, p)),
];

describe("examples compile", () => {
  for (const path of entries) {
    const name = path.slice(MILO_ROOT.length + 1);
    test(name, async () => {
      const r = await guardedRun(MILOC, ["emit-ir", path], { env: CHILD_ENV });
      if (r.code !== 0) {
        throw new Error(`compile failed (exit ${r.code}, signal ${r.signal}):\n${r.stderr}`);
      }
      // Warnings land on stderr as "warning: ..."; stdout is IR (may contain the
      // word in string constants, so only stderr counts).
      expect(r.stderr, `unexpected compiler warning:\n${r.stderr}`).not.toMatch(/\bwarning:/);
    });
  }
});
