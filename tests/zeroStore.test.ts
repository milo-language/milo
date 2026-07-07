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

// Large zero-inits must lower to llvm.memset, not a first-class aggregate
// `store [N x i8] zeroinitializer` — the latter makes clang's InstCombine
// superlinear (a lone 64KB buffer pushed an -O2 build past 100s).
describe("large zero-init uses memset", () => {
  test("64KB array literal emits memset, not an aggregate zero-store", () => {
    const ir = emitIr(`fn main(): i32 {
    var buf: [u8 ; 65536] = [0 ; 65536]
    buf[0] = 1
    return buf[0] as i32
}`);
    expect(ir).toContain("@llvm.memset.p0.i64(ptr %buf.addr, i8 0, i64 65536");
    expect(ir).not.toContain("store [65536 x i8] zeroinitializer");
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
