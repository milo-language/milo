import { test, expect, describe } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

function emitIr(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "milo-zs-"));
  const f = join(dir, "t.milo");
  writeFileSync(f, src);
  return execSync(`bun run ${COMPILER} emit-ir ${f}`, { encoding: "utf-8" });
}

// Built with ASan and run: a double free of a moved buffer aborts with a report. These
// were IR-text checks on the legacy codegen's zero-store; the MLIR backend tracks moves
// with drop flags instead, so the property (the moved buffer is freed once) is checked
// where it shows. LeakSanitizer is off: a leak is not what these tests are about.
function runSanitized(src: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "milo-zs-"));
  const f = join(dir, "t.milo");
  writeFileSync(f, src);
  try {
    const out = execSync(`bun run ${COMPILER} run --sanitize ${f}`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// Large zero-inits must not lower to a first-class aggregate
// `store [N x i8] zeroinitializer`: that makes clang's InstCombine superlinear (a lone
// 64KB buffer pushed an -O2 build past 100s). The legacy codegen emitted llvm.memset;
// MLIR emits a fill loop (which -O2 turns into memset). Either is fine, an aggregate
// store or one store per byte is not.
describe("large zero-init uses memset", () => {
  test("64KB array literal is not an aggregate zero-store", () => {
    const ir = emitIr(`fn main(): i32 {
    var buf: [u8 ; 65536] = [0 ; 65536]
    buf[0] = 1
    return buf[0] as i32
}`);
    expect(ir).not.toContain("store [65536 x i8] zeroinitializer");
    const main = ir.slice(ir.indexOf("define i32 @main("), ir.indexOf("\n}\n", ir.indexOf("define i32 @main(")));
    expect(main).toContain("alloca [65536 x i8]");
    expect((main.match(/store i8 0,/g) ?? []).length).toBeLessThan(16);
  });

  test("small zero-init still uses a plain store", () => {
    const ir = emitIr(`fn main(): i32 {
    var small: [u8 ; 8] = [0 ; 8]
    small[0] = 1
    return small[0] as i32
}`);
    expect(ir).not.toContain("@llvm.memset");
  });
});

// A local moved out by value must not be dropped again when reassigned, or the
// reassignment frees the buffer the callee already owns. Globals cannot be moved at all
// (checker rule, tests/errors/globalMoveArg.milo), so only the local path reaches codegen.
// The string is heap-built: a literal has cap 0, so its drop is a no-op and hides this.
describe("move-out zeros the source slot", () => {
  test("a moved-out local is not freed again on reassignment", () => {
    const r = runSanitized(`fn takeStr(s: string) { print(s) }
fn main(): i32 {
    let base = "hel"
    var l: string = base + "lo"
    takeStr(l)
    l = base + "p"
    print(l)
    return 0
}`);
    expect(r.out).not.toContain("AddressSanitizer");
    expect(r.out).toBe("hello\nhelp\n");
    expect(r.code).toBe(0);
  });
});

// `x ?? default` moves the default into the result on the None/Err branch. That
// branch must also retire the default variable, or its own scope-end drop frees
// the buffer the result now owns: a double free that only bit heap defaults.
describe("?? zeros the default's slot on the none branch", () => {
  test("a heap default is freed once on the none branch", () => {
    const r = runSanitized(`fn getStr(): Result<string> { return Result.Err("e") }
fn main(): i32 {
    let base = "default"
    let d = base + " heap buffer"
    let s = getStr() ?? d
    print(s)
    return 0
}`);
    expect(r.out).not.toContain("AddressSanitizer");
    expect(r.out).toBe("default heap buffer\n");
    expect(r.code).toBe(0);
  });
});
