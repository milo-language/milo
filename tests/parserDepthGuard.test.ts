// The recursive-descent parser must reject pathologically deep expression nesting
// with a clean diagnostic instead of a raw `RangeError: Maximum call stack size
// exceeded`. Regression guard for the security audit's D1 finding.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

function build(src: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "milo-d1-"));
  const f = join(dir, "deep.milo");
  writeFileSync(f, src);
  try {
    execFileSync("bun", ["run", MAIN, "build", f, "-o", join(dir, "out")], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { out: "", code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deeply nested parens produce a diagnostic, not a stack overflow", () => {
  const src = `fn main(): i32 { return ${"(".repeat(5000)}1${")".repeat(5000)}\n}\n`;
  const r = build(src);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("nesting too deep");
  expect(r.out).not.toContain("Maximum call stack");
  expect(r.out).not.toContain("RangeError");
});

test("moderately nested expressions still parse fine", () => {
  const src = `fn main(): i32 { return ${"(".repeat(200)}1${")".repeat(200)}\n}\n`;
  const r = build(src);
  expect(r.code).toBe(0);
});
