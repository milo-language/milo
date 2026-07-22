// Locks the `milo prove` pipeline end-to-end: contract → verify.ts VC generation
// → prove-milo.ts linearization → std/smt native solver → verdict counts. Each
// fixture in tests/prove/ annotates the expected proven/failed/unknown tallies;
// the driver runs the default (std/smt) engine and asserts the report matches.
import { test, expect, describe, beforeAll } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun } from "../scripts/guard";

const PROVE_DIR = join(import.meta.dir, "prove");
const MILO_ROOT = join(import.meta.dir, "..");
const TOOL_DIR = mkdtempSync(join(tmpdir(), "milo-provec-"));
const MILOC = join(TOOL_DIR, "miloc");
const CHILD_ENV = { ...process.env, MILO_ROOT };

beforeAll(() => {
  execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
});

function annCount(src: string, key: string): number | null {
  const m = src.match(new RegExp(`//\\s*@${key}:\\s*(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

describe("prove (std/smt engine)", () => {
  const files = readdirSync(PROVE_DIR).filter(f => f.endsWith(".milo"));

  for (const file of files) {
    test(file.replace(".milo", ""), async () => {
      const src = readFileSync(join(PROVE_DIR, file), "utf-8");
      // prove exits 1 when a contract is refuted; the report still prints first.
      const r = await guardedRun(MILOC, ["prove", join(PROVE_DIR, file)], {
        env: CHILD_ENV,
        virtualMemMb: 8192,
      });
      const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
      const m = out.match(/proven:\s*(\d+)\s+failed:\s*(\d+)\s+unknown:\s*(\d+)\s+errors:\s*(\d+)/);
      if (!m) throw new Error(`no prove report for ${file}:\n${out}\n${r.stderr}`);
      const [proven, failed, unknown, errors] = [m[1], m[2], m[3], m[4]].map(n => parseInt(n, 10));

      // A translation/solver error is never expected — it means the pipeline broke.
      expect(errors).toBe(0);

      const eProven = annCount(src, "proven");
      const eFailed = annCount(src, "failed");
      const eUnknown = annCount(src, "unknown");
      if (eProven !== null) expect(proven).toBe(eProven);
      if (eFailed !== null) expect(failed).toBe(eFailed);
      if (eUnknown !== null) expect(unknown).toBe(eUnknown);
    }, 120000);
  }
});
