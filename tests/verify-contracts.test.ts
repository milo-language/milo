// Compile-time contract gate, run as part of `bun test` (and thus CI). Proves
// every requires/ensures/invariant in std/ and examples/ with `milo prove` and
// fails if any is *refuted* (counterexample found). Unknown/errors are solver
// limits, not violations — see scripts/verify-contracts.ts for the rationale.
import { test, expect, beforeAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { contractFiles, proveFile, report, type FileResult } from "../scripts/verify-contracts";

const MILO_ROOT = join(import.meta.dir, "..");
const TOOL_DIR = mkdtempSync(join(tmpdir(), "milo-verifyc-"));
const MILOC = join(TOOL_DIR, "miloc");

beforeAll(() => {
  execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
});

test("no project contract is refuted (compile-time prove gate)", async () => {
  const files = contractFiles();
  expect(files.length).toBeGreaterThan(0); // guard against a broken discovery glob

  const results: FileResult[] = [];
  for (const f of files) results.push(await proveFile(MILOC, f));

  const gate = report(results); // human-readable table + counterexamples in the log

  // A NEW refuted contract (not in the baseline) fails the build. Baselined
  // solver-limitations do not; a stale baseline entry is surfaced but tolerated.
  const detail = gate.unexpected.map(r => r.line).join("\n");
  expect(detail).toBe("");
}, 600000);
