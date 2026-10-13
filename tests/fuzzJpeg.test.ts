// A short, fixed-seed run of the std/jpeg crash fuzzer (scripts/fuzz-jpeg.ts) as a gate.
//
// Mutated and truncated JPEGs must decode or be rejected, never trap, hang or allocate
// past the guard's cap; the regression this caught first was an over-subscribed DHT
// writing past the 512-entry lookahead table.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("std/jpeg survives mutated input", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bun", [join(ROOT, "scripts", "fuzz-jpeg.ts"), "--cases", "3000", "--seed", "7"],
      { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? 1;
  }
  expect(out, `jpeg fuzzer reported no run:\n${out}`).toMatch(/\b3000 ran\b/);
  expect(code, `jpeg fuzzer found a crash:\n${out}`).toBe(0);
}, 300_000);
