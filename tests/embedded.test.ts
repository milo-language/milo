// Cross-compilation tests for bare-metal Cortex-M targets. These can't use the
// fixture run-driver (a thumb binary won't execute on the host), so they assert
// on the emitted object's architecture and on the CLI's target/error handling.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const SRC = join(tmpdir(), "milo_embed_test.milo");
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

const fileType = (path: string) => execSync(`file ${path}`, { encoding: "utf-8" });

test("emit-obj --target=cortex-m3 produces an ARM EABI object", () => {
  const obj = join(tmpdir(), "milo_embed_m3.o");
  if (existsSync(obj)) unlinkSync(obj);
  const r = milo(`emit-obj ${SRC} --target=cortex-m3 -o ${obj}`);
  expect(r.code).toBe(0);
  expect(existsSync(obj)).toBe(true);
  expect(fileType(obj)).toMatch(/ELF 32-bit.*ARM/);
  unlinkSync(obj);
});

test("emit-obj --target=stm32f4 (chip alias) produces an ARM object", () => {
  const obj = join(tmpdir(), "milo_embed_f4.o");
  if (existsSync(obj)) unlinkSync(obj);
  const r = milo(`emit-obj ${SRC} --target=stm32f4 -o ${obj}`);
  expect(r.code).toBe(0);
  expect(fileType(obj)).toMatch(/ELF 32-bit.*ARM/);
  unlinkSync(obj);
});

test("emit-ir --target=cortex-m3 carries the thumb triple", () => {
  const r = milo(`emit-ir ${SRC} --target=cortex-m3`);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`target triple = "thumbv7m-none-eabi"`);
});

test("unknown target exits non-zero and lists available targets", () => {
  const r = milo(`emit-obj ${SRC} --target=bogus`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("unknown target: bogus");
  expect(r.err).toContain("cortex-m3");
});

test("build --target=cortex-m3 links a bare-metal ARM ELF executable", () => {
  const bin = join(tmpdir(), "milo_embed_bin.elf");
  if (existsSync(bin)) unlinkSync(bin);
  const r = milo(`build ${SRC} --target=cortex-m3 -o ${bin}`);
  expect(r.code).toBe(0);
  expect(existsSync(bin)).toBe(true);
  // statically-linked freestanding executable (no libc), not a relocatable .o
  expect(fileType(bin)).toMatch(/ELF 32-bit.*ARM.*executable/);
  unlinkSync(bin);
});

test("bare-metal runtime files (startup + linker script) are present", () => {
  const ed = join(import.meta.dir, "..", "embedded", "cortex-m");
  expect(existsSync(join(ed, "startup.c"))).toBe(true);
  expect(existsSync(join(ed, "mps2.ld"))).toBe(true);
});
