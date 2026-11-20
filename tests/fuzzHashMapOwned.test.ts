// The HashMap falsifier with OWNED keys AND values, oracled by `leaks -atExit`.
//
// Its literal-only keys made it blind to the class that shipped: `m.get("k" + i.toString())`
// leaked its key on every call while returning entirely the right answer. `--owned` makes
// values strings too and builds lookup keys from a runtime value, so the argument-temp path
// is actually exercised.
//
// It found HashMapGetOrDefault sitting in NOT_OWNED_TEMP beside `contains` and `len`,
// which really do yield scalars — so a discarded getOrDefault result leaked its clone.
//
// macOS only: `leaks` has no darwin/arm64 LeakSanitizer counterpart, and the Linux job
// covers the same ground through scripts/leak-check.ts.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { canAttach } from "./debugger";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test.skipIf(process.platform !== "darwin" || !canAttach())("owned HashMap ops leak nothing under random sequences", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bun", [
      join(ROOT, "scripts", "fuzz-hashmap.ts"),
      "--owned", "--leaks",
      "--cases", "10",
      "--ops", "30",
      "--seed", "41",
    ], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? 1;
  }
  expect(out, `owned-hashmap falsifier reported no cases:\n${out}`).toMatch(/\b10 ran\b/);
  expect(code, `owned-hashmap falsifier found a leak or mismatch:\n${out}`).toBe(0);
}, 600_000);
