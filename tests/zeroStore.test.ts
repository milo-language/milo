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

// Moving a global out by value must zero its slot, exactly like a local move-out.
// Without this, a subsequent reassignment drops (frees) the old buffer the callee
// already owns — a double-free that compiled clean. Regression for the checker's
// moved-flag being cleared on reassign while codegen left the global slot live.
describe("move-out of a global zeros the source slot", () => {
  const src = `var g: string = ""
fn takeStr(s: string) { print(s) }
fn main(): i32 {
    g = "hello"
    takeStr(g)
    g = "world"
    print(g)
    return 0
}`;

  test("global move-out emits a zero-store before reassignment", () => {
    const ir = emitIr(src);
    expect(ir).toContain("store %String zeroinitializer, ptr @g");
  });

  test("local move-out (control) also zeros its slot", () => {
    const ir = emitIr(`fn takeStr(s: string) { print(s) }
fn main(): i32 {
    var l: string = "hello"
    takeStr(l)
    l = "world"
    print(l)
    return 0
}`);
    expect(ir).toContain("store %String zeroinitializer, ptr %l.addr");
  });
});
