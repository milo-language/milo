// Overflow is a trap in EVERY build mode — the language law is "every op is total;
// wrapping is opt-in." `+ - *` trap at -O0 AND at -O2/-O3; `i64::MAX + 1` aborts rather
// than quietly becoming `i64::MIN`. (Swift/Zig-safe model, not Rust's debug-trap/release-
// wrap.) `--no-overflow-checks` (and `--fast`) is the escape hatch that restores wrapping
// for a perf-critical release build.
//
// This lives here rather than in tests/runtime-errors/ on purpose: that harness compiles
// at --debug, so it can't distinguish the default from the flag. The whole point is the
// RELEASE build, so both halves are asserted against `--release` — the trap by default,
// the wrap only when explicitly opted out.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

const SRC = `fn main(): i32 {
    var x: i64 = 9223372036854775807
    x = x + 1
    print(x)
    return 0
}
`;

const SUM_SRC = `fn main(): i32 {
    let values: Vec<i64> = [9223372036854775807, 1]
    print(values.sum())
    return 0
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-ovf-"));
  writeFileSync(join(dir, "ovf.milo"), SRC);
  writeFileSync(join(dir, "sum.milo"), SUM_SRC);
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function build(out: string, extra: string[], source = "ovf.milo") {
  execFileSync("bun", ["run", MAIN, "build", join(dir, source), "-o", join(dir, out), "--release", ...extra],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
}

function run(bin: string): { out: string; code: number } {
  try {
    return { out: execFileSync(join(dir, bin), { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

// The law, pinned: a release build traps by default. A future change back to silent
// wrapping is then a deliberate act that breaks this test, not a quiet regression.
test("release build traps on overflow by default", () => {
  build("trap", []);
  const r = run("trap");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("integer overflow");
}, 120000);

test("--no-overflow-checks restores wrapping in a release build", () => {
  build("wrap", ["--no-overflow-checks"]);
  const r = run("wrap");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("-9223372036854775808");
}, 120000);

test("Vec.sum traps on integer overflow in a release build", () => {
  build("sum-trap", [], "sum.milo");
  const r = run("sum-trap");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("integer overflow");
}, 120000);
