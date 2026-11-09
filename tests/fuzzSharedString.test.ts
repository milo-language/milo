// A short, fixed-seed run of the shared-string falsifier as a regression gate.
//
// Heap strings are reference counted and copied on write. The falsifier shares one buffer
// between handles by every spelling the language has, writes through one of them, and
// compares what every handle prints against a JS model, under AddressSanitizer: a missed
// copy shows as a wrong print, a missed count as a use after free.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("shared strings behave as values over random share/write/drop sequences", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bun", [
      join(ROOT, "scripts", "fuzz-shared-string.ts"),
      "--cases", "6",
      "--seed", "7",
    ], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? 1;
  }
  // A case that fails to build counts as failed, so a generator that emits a rejected
  // program turns this red instead of shrinking the sample.
  expect(out, `shared-string falsifier did not run all cases:\n${out}`).toMatch(/\b6 ran, 0 failed\b/);
  expect(code, `shared-string falsifier found a mismatch:\n${out}`).toBe(0);
}, 300_000);
