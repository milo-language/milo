// `--overflow-checks`: arithmetic traps at ANY optimization level.
//
// Without it, `+ - *` trap at -O0 but silently WRAP at -O2/-O3 — `i64::MAX + 1` quietly
// becomes `i64::MIN` in a release build. That is Rust's wart; Swift traps in every mode.
//
// This lives here rather than in tests/runtime-errors/ on purpose: that harness compiles
// at --debug, where overflow already traps, so a fixture there would pass whether or not
// the flag did anything. The whole point is the RELEASE build, so both halves are asserted
// against `--release` — the wrap without the flag, the trap with it.
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-ovf-"));
  writeFileSync(join(dir, "ovf.milo"), SRC);
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function build(out: string, extra: string[]) {
  execFileSync("bun", ["run", MAIN, "build", join(dir, "ovf.milo"), "-o", join(dir, out), "--release", ...extra],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
}

function run(bin: string): { out: string; code: number } {
  try {
    return { out: execFileSync(join(dir, bin), { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

// The footgun, pinned so a future change to the default is a deliberate act that breaks
// this test rather than a silent behaviour swap.
test("release build wraps on overflow by default", () => {
  build("wrap", []);
  const r = run("wrap");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("-9223372036854775808");
}, 120000);

test("--overflow-checks traps in a release build", () => {
  build("trap", ["--overflow-checks"]);
  const r = run("trap");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("integer overflow");
}, 120000);
