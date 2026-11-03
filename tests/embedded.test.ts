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

// Layout on a 32-bit target: structs holding pointers (strings), a Vec of them, enums with
// payloads, a deep clone and a move closure's env, folded into the exit code. On the host
// the same program exits 136; a pointer laid out as 8 bytes on Thumb (the MLIR side lays
// structs out with the target's 4) changes it.
const LAYOUT32_SRC = `struct Rec { name: string, n: i64, tag: bool }
enum Shape { Dot, Named(string, i64), Pair(i64, i64) }

fn total(rs: &Vec<Rec>): i64 {
    var t: i64 = 0
    for r in rs {
        t = t + r.n + r.name.len()
        if r.tag { t = t + 1 }
    }
    return t
}

fn score(s: &Shape): i64 {
    return match s {
        Shape.Dot => 1,
        Shape.Named(n, k) => n.len() * 100 + k,
        Shape.Pair(a, b) => a * b,
    }
}

fn main(): i32 {
    var rs: Vec<Rec> = []
    var i: i64 = 0
    while i < 5 {
        rs.push(Rec { name: format("r", i), n: i * 10, tag: i % 2 == 0 })
        i = i + 1
    }
    let first = rs.get(1)!
    let shapes: Vec<Shape> = [Shape.Dot, Shape.Named("xy".clone(), 7), Shape.Pair(3, 4)]
    var sc: i64 = 0
    for sh in shapes { sc = sc + score(sh) }
    let copy = rs.clone()
    let s = "cap".clone()
    let f = move (): i64 => s.len() + 1
    let v = total(rs) + first.n + sc + f() + copy[4].n + copy.len()
    return (v & 255) as i32
}
`;

test.if(hasQemu)("32-bit layout: structs, enums, clones and closures agree with the host", () => {
  const src = join(DIR, "milo_embed_layout32.milo");
  writeFileSync(src, LAYOUT32_SRC);
  const r = milo(`run ${src} --target=cortex-m3`);
  expect(r.out).toContain("exit=136");
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

// Float math and 64-bit division compile to compiler-rt helper calls that a
// freestanding link has no library to resolve. That's the declared scope of the
// target, so it must read as a named limit — not as the raw "undefined symbol:
// __aeabi_dmul" dump, which reads like a broken toolchain.
test("float math on a bare-metal target names the integer-only limit", () => {
  const src = join(DIR, "milo_bm_float.milo");
  writeFileSync(src, `fn scale(a: f64, b: f64): f64 { return a * b }
fn main(): i32 { return scale(3.5, 2.0) as i32 }
`);
  const r = milo(`build ${src} --target=cortex-m3 --debug -o ${join(DIR, "milo_bm_float.elf")}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("integer-only");
  expect(r.err).toContain("fixed-point");
  expect(r.err).not.toContain("undefined symbol");
  unlinkSync(src);
}, COMPILE_TIMEOUT);

test("i64 division on a bare-metal target names the integer-only limit", () => {
  const src = join(DIR, "milo_bm_div.milo");
  writeFileSync(src, `fn q(a: i64, b: i64): i64 { return a / b }
fn main(): i32 { return q(100, 7) as i32 }
`);
  const r = milo(`build ${src} --target=cortex-m3 --debug -o ${join(DIR, "milo_bm_div.elf")}`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("64-bit division");
  expect(r.err).not.toContain("undefined symbol");
  unlinkSync(src);
}, COMPILE_TIMEOUT);

// The prelude is in every program, so a std function nobody calls must not drag a
// libc symbol into the link. --gc-sections is what guarantees that at -O0, where no
// optimizer pass removes it: std/string's parseF64 calls atof, and that alone used
// to fail the link of a program that parses nothing.
test("a program that parses nothing links despite the prelude's libc-calling parsers", () => {
  const src = join(DIR, "milo_bm_prelude.milo");
  writeFileSync(src, `fn noLoop(): i32 { return 7 }
fn main(): i32 { return noLoop() }
`);
  const out = join(DIR, "milo_bm_prelude.elf");
  const r = milo(`build ${src} --target=cortex-m3 --debug -o ${out}`);
  expect(r.code).toBe(0);
  expect(existsSync(out)).toBe(true);
  unlinkSync(src);
}, COMPILE_TIMEOUT);
