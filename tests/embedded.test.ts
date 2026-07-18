// Cross-compilation tests for bare-metal Cortex-M targets. These can't use the
// fixture run-driver (a thumb binary won't execute on the host), so they assert
// on the emitted object/executable architecture and on CLI target/error handling.
import { test, expect, afterAll } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

// Per-run dir: these all used fixed /tmp/milo_embed_* paths, so two concurrent `bun test`
// runs clobbered each other's sources mid-compile — ~300 phantom failures that look like
// real regressions. Cost real debugging time twice before it was tracked down.
const DIR = mkdtempSync(join(tmpdir(), "milo-embed-"));
const SRC = join(DIR, "milo_embed_test.milo");
writeFileSync(SRC, `fn add(a: i32, b: i32): i32 { return a + b }
fn main(): i32 { return add(2, 3) }
`);

// Run the compiler; return {code, out, err}. Never throws.
function milo(args: string): { code: number; out: string; err: string } {
  try {
    const out = execSync(`bun run ${COMPILER} ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, out: e.stdout?.toString() ?? "", err: e.stderr?.toString() ?? "" };
  }
}

// Every test here spawns the compiler (clang/llc), and the QEMU lane boots an emulator.
// bun's default per-test timeout is 5s: enough locally with a warm toolchain, not enough
// on a cold CI runner, where 4 of these failed on the first Linux run purely for that.
// COMPILE_TIMEOUT is a ceiling for a hung toolchain, not a target — these take ~100ms.
const COMPILE_TIMEOUT = 60000;

const fileType = (path: string) => execSync(`file ${path}`, { encoding: "utf-8" });

afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

test("emit-obj --target=cortex-m3 produces an ARM EABI object", () => {
  const obj = join(DIR, "milo_embed_m3.o");
  if (existsSync(obj)) unlinkSync(obj);
  const r = milo(`emit-obj ${SRC} --target=cortex-m3 -o ${obj}`);
  expect(r.code).toBe(0);
  expect(existsSync(obj)).toBe(true);
  expect(fileType(obj)).toMatch(/ELF 32-bit.*ARM/);
  unlinkSync(obj);
}, COMPILE_TIMEOUT);

test("emit-obj --target=stm32f4 (chip alias) produces an ARM object", () => {
  const obj = join(DIR, "milo_embed_f4.o");
  if (existsSync(obj)) unlinkSync(obj);
  const r = milo(`emit-obj ${SRC} --target=stm32f4 -o ${obj}`);
  expect(r.code).toBe(0);
  expect(fileType(obj)).toMatch(/ELF 32-bit.*ARM/);
  unlinkSync(obj);
}, COMPILE_TIMEOUT);

test("emit-ir --target=cortex-m3 carries the thumb triple", () => {
  const r = milo(`emit-ir ${SRC} --target=cortex-m3`);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`target triple = "thumbv7m-none-eabi"`);
}, COMPILE_TIMEOUT);

test("unknown target exits non-zero and lists available targets", () => {
  const r = milo(`emit-obj ${SRC} --target=bogus`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("unknown target: bogus");
  expect(r.err).toContain("cortex-m3");
}, COMPILE_TIMEOUT);

test("build --target=cortex-m3 links a bare-metal ARM ELF executable", () => {
  const bin = join(DIR, "milo_embed_bin.elf");
  if (existsSync(bin)) unlinkSync(bin);
  const r = milo(`build ${SRC} --target=cortex-m3 -o ${bin}`);
  expect(r.code).toBe(0);
  expect(existsSync(bin)).toBe(true);
  // statically-linked freestanding executable (no libc), not a relocatable .o
  expect(fileType(bin)).toMatch(/ELF 32-bit.*executable.*ARM/);
  unlinkSync(bin);
}, COMPILE_TIMEOUT);

test("build --target=stm32f4 (chip alias) links an ARM ELF executable", () => {
  const bin = join(DIR, "milo_embed_f4.elf");
  if (existsSync(bin)) unlinkSync(bin);
  const r = milo(`build ${SRC} --target=stm32f4 -o ${bin}`);
  expect(r.code).toBe(0);
  expect(fileType(bin)).toMatch(/ELF 32-bit.*executable.*ARM/);
  unlinkSync(bin);
}, COMPILE_TIMEOUT);

test("bare-metal runtime files (startup + linker script) are present", () => {
  const ed = join(import.meta.dir, "..", "tools", "cortex-m");
  expect(existsSync(join(ed, "startup.c"))).toBe(true);
  expect(existsSync(join(ed, "mps2.ld"))).toBe(true);
}, COMPILE_TIMEOUT);

// End-to-end: compile → link → QEMU → observe the computed result via
// semihosting. Skipped automatically if QEMU isn't installed so the suite stays
// green on machines without it.
const hasQemu = (() => {
  try { execSync("qemu-system-arm --version", { stdio: ["pipe", "pipe", "pipe"] }); return true; }
  catch { return false; }
})();

test.if(hasQemu)("run --target=cortex-m3 executes on QEMU and prints the exit code", () => {
  const src = join(DIR, "milo_embed_ret.milo");
  writeFileSync(src, `fn add(a: i32, b: i32): i32 { return a + b }
fn main(): i32 { return add(40, 2) }
`);
  const r = milo(`run ${src} --target=cortex-m3`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("exit=42");  // add(40,2) computed on the emulated core
  unlinkSync(src);
}, COMPILE_TIMEOUT);

// A heap-using program (Vec grow → malloc) links and runs bare-metal against the
// linker-provided heap region — no size baked into startup.c.
const HEAP_SRC = `fn main(): i32 {
    var v: Vec<i32> = []
    var i: i32 = 0
    while i < 100 { v.push(i); i = i + 1 }
    return v.len() as i32
}
`;

test.if(hasQemu)("bare-metal heap: a Vec-growing program runs on QEMU", () => {
  const src = join(DIR, "milo_embed_heap.milo");
  writeFileSync(src, HEAP_SRC);
  const r = milo(`run ${src} --target=cortex-m3`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("exit=100");  // 100 pushes into a heap-backed Vec
  unlinkSync(src);
}, COMPILE_TIMEOUT);

test.if(hasQemu)("--heap-size caps the heap and OOM traps with ENOMEM instead of a silent fault", () => {
  const src = join(DIR, "milo_embed_oom.milo");
  writeFileSync(src, HEAP_SRC);
  const r = milo(`run ${src} --target=cortex-m3 --heap-size=64`);  // 64 B can't hold 100 i32s
  expect(r.out).toContain("out of memory");
  expect(r.out).toContain("exit=12");  // ENOMEM — observable, not a silent reboot
  unlinkSync(src);
}, COMPILE_TIMEOUT);

// A hosted --target that isn't the host used to be ignored entirely: clangTargetFlags
// returned "" for non-bare-metal and the link passed -Wno-override-module, so
// `--target=linux-x64` on macOS printed "compiled" and emitted a Mach-O arm64 host
// binary. A wrong artifact reported as success is worse than a failed build.
test("a hosted --target that isn't the host fails loudly instead of building for the host", () => {
  const src = join(DIR, "milo_cross_host.milo");
  writeFileSync(src, `fn main(): i32 { return 0 }\n`);
  const out = join(DIR, "milo_cross_bin");
  // Pick a target that is definitely not this host, whichever host runs the suite.
  const other = process.platform === "darwin" ? "linux-x64" : "macos-arm64";
  const r = milo(`build ${src} --target=${other} -o ${out}`);
  expect(r.code).not.toBe(0);
  expect(existsSync(out)).toBe(false);  // no silent host binary left behind
  expect(r.err).toContain("cross-compiling");
  unlinkSync(src);
}, COMPILE_TIMEOUT);

test("--heap-size rejects a non-bare-metal target", () => {
  const src = join(DIR, "milo_heap_host.milo");
  writeFileSync(src, `fn main(): i32 { return 0 }\n`);
  const r = milo(`build ${src} --heap-size=64k -o ${join(DIR, "milo_heap_host_bin")}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("bare-metal");
  unlinkSync(src);
}, COMPILE_TIMEOUT);

test("--heap-size rejects a malformed value", () => {
  const src = join(DIR, "milo_heap_bad.milo");
  writeFileSync(src, `fn main(): i32 { return 0 }\n`);
  const r = milo(`build ${src} --target=cortex-m3 --heap-size=abc -o ${join(DIR, "milo_heap_bad_bin")}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("k/m suffix");
  unlinkSync(src);
}, COMPILE_TIMEOUT);
