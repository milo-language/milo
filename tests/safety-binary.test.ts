// Gates for profile checks on the BINARY (docs/plans/object-level-assurance.md steps 1 and 3):
// the pinned build record and the three object checks. Each check has a planted violation
// that must fail and a clean program that must pass do178c-a. Bare-metal cortex-m3 images
// are static, so they are checked without a libc; the allowlist check needs a hosted build.
import { describe, expect, test as bunTest, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { readObject, checkObject } from "../src/object-checks";

// Each test runs one to three compiler processes.
const test = (name: string, fn: () => void) => bunTest(name, fn, 90_000);

const ROOT = resolve(import.meta.dir, "..");
const FIX = join(ROOT, "tests", "safety-binary");
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-safety-bin-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function milo(args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", ["run", join(ROOT, "src", "main.ts"), ...args], { encoding: "utf-8", cwd: ROOT });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const M3 = ["--target=cortex-m3"];

describe("pinned build", () => {
  test("a clean program builds under do178c-a and verifies", () => {
    const out = join(dir, "clean.elf");
    const b = milo(["build", join(FIX, "clean", "clean.milo"), ...M3, "--safety=do178c-a", "-o", out]);
    expect(b.out).toContain("binary check passed");
    expect(b.code).toBe(0);
    const v = milo(["verify", "--profile", "do178c-a", out]);
    expect(v.out).toContain("pinned build: -O2, none LTO, 1 codegen unit");
    expect(v.code).toBe(0);
  });

  test("a binary built without --safety has no record and is refused", () => {
    const out = join(dir, "plain.elf");
    expect(milo(["build", join(FIX, "clean", "clean.milo"), ...M3, "-o", out]).code).toBe(0);
    const v = milo(["verify", "--profile", "do178c-a", out]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("no pinned-build record");
  });

  test("a binary whose recorded pass list differs from the pin is refused", () => {
    const out = join(dir, "tampered.elf");
    milo(["build", join(FIX, "clean", "clean.milo"), ...M3, "--safety=do178c-a", "-o", out]);
    const bytes = readFileSync(out);
    const at = bytes.indexOf("milo-version-bounds-checks");
    expect(at).toBeGreaterThan(0);
    bytes.write("milo-version-bounds-checkz", at, "latin1"); // same length: a different pass list
    writeFileSync(out, bytes);
    const v = milo(["verify", "--profile", "do178c-a", out]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("pass pipeline differs from the pinned pipeline");
  });

  test("a binary built for another profile is refused", () => {
    const out = join(dir, "other.elf");
    milo(["build", join(FIX, "clean", "clean.milo"), ...M3, "--safety=do178c-b", "-o", out]);
    const v = milo(["verify", "--profile", "do178c-a", out]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("built for profile do178c-b, verifying do178c-a");
  });

  test("--safety refuses a build flag that moves the pin", () => {
    const b = milo(["build", join(FIX, "clean", "clean.milo"), ...M3, "--safety=do178c-a", "--release", "-o", join(dir, "rel.elf")]);
    expect(b.code).toBe(1);
    expect(b.out).toContain("pins -O2");
    expect(existsSync(join(dir, "rel.elf"))).toBe(false);
  });
});

describe("checks on the binary", () => {
  test("noDynamicAllocation: a hidden heap allocation fails the build and removes the binary", () => {
    const out = join(dir, "alloc.elf");
    const b = milo(["build", join(FIX, "alloc", "alloc.milo"), ...M3, "--safety=do178c-a", "-o", out]);
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/FAIL \[allocation\] .*main.* -> malloc/);
    expect(existsSync(out)).toBe(false);
  });

  test("noDynamicAllocation: the same program passes a profile that allows allocation", () => {
    const out = join(dir, "alloc-c.elf");
    const b = milo(["build", join(FIX, "alloc", "alloc.milo"), ...M3, "--safety=do178c-c", "-o", out]);
    expect(b.out).not.toContain("[allocation]");
    expect(b.code).toBe(0);
  });

  test("noRecursion: the source profile rejects the cycle before any binary exists", () => {
    const b = milo(["build", join(FIX, "recursion", "recursion.milo"), ...M3, "--safety=do178c-a", "-o", join(dir, "rec-src.elf")]);
    expect(b.code).toBe(1);
    expect(b.out).toContain("recursion detected: ping -> pong -> ping");
    expect(existsSync(join(dir, "rec-src.elf"))).toBe(false);
  });

  // Layering: the source rule above already bans this program, so no `build --safety` run can
  // reach the binary check for it. Build it without --safety and run the object check directly.
  test("noRecursion: mutual recursion shows up as a cycle in the call graph of the image", () => {
    const out = join(dir, "rec.elf");
    expect(milo(["build", join(FIX, "recursion", "recursion.milo"), ...M3, "-o", out]).code).toBe(0);
    const findings = checkObject(readObject(out), "do178c-a").filter(v => v.check === "recursion");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.message).toMatch(/call cycle: ping/);
  });

  test("allowlist: a libc import no profile names fails", () => {
    const out = join(dir, "libc");
    expect(milo(["build", join(FIX, "libc.milo"), "-o", out]).code).toBe(0);
    const v = milo(["verify", "--profile", "do178c-a", out]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("not on the do178c-a allowlist: getppid");
    // The same import is fine for a profile that allows the hosted libc? Not getppid: still unlisted.
    expect(milo(["verify", "--profile", "do178c-c", out]).out).toContain("allowlist: getppid");
  });
});

// examples/embedded/pidStep.milo is not DO-178 conformant (no contracts or @req, by design: it is
// the unannotated original). examples/assured/pid is its traced, contracted descendant.
describe("examples/assured", () => {
  test("the traced pid controller passes do178c-a on the Cortex-M3 binary", () => {
    const b = milo(["build", join(ROOT, "examples", "assured", "pid", "pid.milo"), ...M3, "--safety=do178c-a", "-o", join(dir, "pid.elf")]);
    expect(b.out).toContain("binary check passed");
    expect(b.code).toBe(0);
  });
});
