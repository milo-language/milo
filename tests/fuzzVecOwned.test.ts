// The Vec falsifier again, with OWNED elements and a leak oracle.
//
// The value model and the leak oracle see different bugs, and the leak ones are the class
// that actually shipped: `m.get("k" + i.toString())` and `mkVec().len` produced entirely
// correct answers while losing an allocation per call. No amount of checking what a
// program PRINTS can see that.
//
// `--owned` switches the element type to string, which turns on drop glue for every op and
// makes the generator emit the two shapes that leaked: a needle BUILT at the call site (a
// literal never leaks — it owns no heap) and a receiver that is a temporary.
//
// macOS only: this uses `leaks -atExit`, and LeakSanitizer does not exist on darwin/arm64
// so the Linux job covers the same ground through scripts/leak-check.ts instead.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { canAttach } from "./debugger";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test.skipIf(process.platform !== "darwin" || !canAttach())("owned Vec ops leak nothing under random sequences", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bun", [
      join(ROOT, "scripts", "fuzz-vec.ts"),
      "--owned", "--leaks",
      "--cases", "10",
      "--ops", "30",
      "--seed", "21",
    ], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? 1;
  }
  expect(out, `owned-vec falsifier reported no cases:\n${out}`).toMatch(/\b10 ran\b/);
  expect(code, `owned-vec falsifier found a leak or mismatch:\n${out}`).toBe(0);
}, 600_000);
