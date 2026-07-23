// Host/target resolution, and the Windows cross-compile path.
//
// `getHostTarget()` used to fall through to the Linux entry for ANY non-darwin host,
// so on Windows the compiler reported x86_64-unknown-linux-gnu and emitted ELF-targeting
// IR: it didn't fail, it lied. Windows is a real target now; every other unknown host
// must still be refused explicitly rather than silently mislabelled.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { hostTargetFor, getHostTarget, resolveTarget, UnsupportedHostError } from "../src/target";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

test("hosts resolve to their native triple", () => {
  expect(hostTargetFor("darwin", "arm64").triple).toBe("aarch64-apple-darwin");
  expect(hostTargetFor("darwin", "x64").triple).toBe("x86_64-apple-darwin");
  expect(hostTargetFor("linux", "arm64").triple).toBe("aarch64-unknown-linux-gnu");
  expect(hostTargetFor("linux", "x64").triple).toBe("x86_64-unknown-linux-gnu");
  expect(hostTargetFor("win32", "x64").triple).toBe("x86_64-pc-windows-msvc");
  expect(hostTargetFor("win32", "arm64").triple).toBe("aarch64-pc-windows-msvc");
});

test("a windows host never resolves to a linux triple", () => {
  // The exact regression: ELF-targeting IR emitted under a gnu triple on Windows.
  expect(hostTargetFor("win32", "x64").os).toBe("windows");
  expect(hostTargetFor("win32", "x64").triple).not.toContain("linux");
});

test("unknown hosts are refused explicitly, not mislabelled", () => {
  expect(() => hostTargetFor("freebsd", "x64")).toThrow(UnsupportedHostError);
  expect(() => hostTargetFor("sunos", "x64")).toThrow(/supported: darwin, linux, windows/);
});

test("windows is a named cross-compilation target", () => {
  expect(resolveTarget("windows-x64")?.triple).toBe("x86_64-pc-windows-msvc");
  expect(resolveTarget("windows-arm64")?.triple).toBe("aarch64-pc-windows-msvc");
});

test("the real host resolves on every platform this suite runs on", () => {
  expect(getHostTarget().triple).toBeTruthy();
});

// Cross-compiling to Windows needs the MSVC CRT + Windows SDK, which a POSIX host only
// has if someone ran `xwin splat` and pointed MILO_WINDOWS_SDK at it. Skipped otherwise
// rather than failed: an unset env var means "not set up here", not "broken".
// Setup: cargo install xwin && xwin --accept-license --arch x86_64 splat --output ~/.xwin
const SDK = process.env.MILO_WINDOWS_SDK;
test.skipIf(!SDK || process.platform === "win32")("cross-compiles a windows PE from a posix host", () => {
  const out = join(tmpdir(), `milo_wintest_${process.pid}`);
  const exe = `${out}.exe`;
  try {
    execFileSync("bun", ["run", MAIN, "build", join(ROOT, "examples", "hello.milo"),
      "--target=windows-x64", "-o", out], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    expect(existsSync(exe)).toBe(true);
    // PE32+ magic: "MZ" DOS header. Proves we emitted COFF, not ELF or Mach-O.
    const head = execFileSync("head", ["-c", "2", exe], { encoding: "latin1" });
    expect(head).toBe("MZ");
  } finally {
    try { unlinkSync(exe); } catch {}
  }
}, 120000);

// On Windows itself: the full loop, compile AND execute. This is the only place the
// generated code actually runs on the target OS, so it is what proves _write/fprintf
// lowering works rather than merely links.
test.skipIf(process.platform !== "win32")("builds and runs hello.exe natively", () => {
  const out = join(tmpdir(), `milo_wintest_${process.pid}`);
  const exe = `${out}.exe`;
  try {
    execFileSync("bun", ["run", MAIN, "build", join(ROOT, "examples", "hello.milo"), "-o", out],
      { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const stdout = execFileSync(exe, [], { encoding: "utf-8" });
    expect(stdout.trim()).toBe("Hello, Milo!");
  } finally {
    try { unlinkSync(exe); } catch {}
  }
}, 120000);
