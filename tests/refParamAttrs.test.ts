// LLVM attributes codegen derives from Milo's reference rules. A by-ref parameter is
// always the address of a live place of its pointee type (refs are second-class), so it
// is nonnull, dereferenceable for the pointee's store size, and aligned. These pin the
// attributes in the emitted IR, and pin where they must NOT appear: a zero-sized pointee
// (its "place" may be a null or dangling address) and anything a C caller can reach.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

function emitIr(src: string, flags = ""): string {
  const f = join(tmpdir(), `milo_ref_attrs_${process.pid}_${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(f, src);
  try {
    return execSync(`bun run ${COMPILER} emit-ir ${f} ${flags}`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
  } finally {
    unlinkSync(f);
  }
}

const defineOf = (ir: string, fn: string) => ir.split("\n").find(l => l.startsWith("define ") && l.includes(`@${fn}(`)) ?? "";

const SRC = `
struct Empty {}
struct P { x: i32, y: f64 }
enum E { A(i64), B(i32, i32), C }

fn fp(p: &P): i32 { return p.x }
fn farr(a: &mut [i32; 4]) { a[0] = 1 }
fn fbool(b: &mut bool) { b = true }
fn fstr(s: &string): i64 { return s.len() as i64 }
fn fslice(s: &[i32]): i64 { return s.len() as i64 }
fn fe(e: &E): i32 {
    match e {
        E.A(x) => { return 1 }
        E.B(a, b) => { return a + b }
        E.C => { return 0 }
    }
}
fn fempty(_e: &Empty): i32 { return 3 }
fn fgen<T>(_t: &T): i32 { return 0 }

fn main(): i32 {
    var p = P { x: 1, y: 2.0 }
    var arr: [i32; 4] = [0; 4]
    var bb = false
    let em = Empty {}
    let e = E.B(1, 2)
    farr(&mut arr)
    fbool(&mut bb)
    print(fp(p) + fe(e) + fempty(em) + fgen(p) + fgen(em))
    print(fstr("abc") + fslice(arr))
    return 0
}
`;

test("by-ref params get nonnull, dereferenceable(store size) and align", () => {
  const ir = emitIr(SRC);
  expect(defineOf(ir, "fp")).toContain("ptr nonnull dereferenceable(16) align 8 %p");
  expect(defineOf(ir, "farr")).toContain("ptr nonnull dereferenceable(16) align 4 %a");
  expect(defineOf(ir, "fbool")).toContain("ptr nonnull dereferenceable(1) align 1 %b");
  // &string and &[T] point at the 24-byte { ptr, len, cap } header, not the bytes
  expect(defineOf(ir, "fstr")).toContain("ptr nonnull dereferenceable(24) align 8 %s");
  expect(defineOf(ir, "fslice")).toContain("ptr nonnull dereferenceable(24) align 8 %s");
  expect(defineOf(ir, "fe")).toContain("ptr nonnull dereferenceable(16) align 8 %e");
  expect(defineOf(ir, "fgen_P")).toContain("ptr nonnull dereferenceable(16) align 8 %_t");
  // the call site repeats them
  expect(ir).toMatch(/call i32 @fp\(ptr nonnull dereferenceable\(16\) align 8 %/);
  expect(ir).toMatch(/call void @farr\(ptr nonnull dereferenceable\(16\) align 4 %/);
});

test("zero-sized pointees get no pointer attributes", () => {
  const ir = emitIr(SRC);
  expect(defineOf(ir, "fempty")).toContain("(ptr %_e)");
  expect(defineOf(ir, "fgen_Empty")).toContain("(ptr %_t)");
});

test("extern declarations and exported symbols keep the plain C ABI", () => {
  const ir = emitIr(`
struct P { x: i32, y: f64 }
extern fn cTakesP(p: &P): i32
pub fn exported(p: &P): i32 { return p.x }
fn main(): i32 {
    let p = P { x: 1, y: 2.0 }
    print(exported(p))
    return 0
}
`);
  expect(defineOf(ir, "exported")).toContain("(ptr %p)");
  const decl = ir.split("\n").find(l => l.startsWith("declare") && l.includes("@cTakesP(")) ?? "";
  expect(decl).not.toContain("nonnull");
  expect(ir).toMatch(/call i32 @exported\(ptr %/);
});

const NOALIAS_SRC = `
var G: i64 = 1
fn axpy(y: &mut [f64; 64], x: &[f64; 64], k: f64) {
    var i: i64 = 0
    while i < 64 {
        y[i] = y[i] + k * x[i]
        i = i + 1
    }
}
fn bumpGlobal(x: &mut i64): i64 {
    x = 10
    G = G + 1
    return x
}
fn viaHelper(x: &mut i64): i64 { return bumpGlobal(&mut x) }
fn callWith(x: &mut i64, f: () => void): i64 {
    x = 10
    f()
    return x
}
fn main(): i32 {
    var y: [f64; 64] = [0.0; 64]
    let x: [f64; 64] = [1.0; 64]
    axpy(&mut y, x, 2.0)
    print(bumpGlobal(&mut G) + viaHelper(&mut G))
    var n: i64 = 1
    print(callWith(&mut n, () => { n = n + 1 }))
    return 0
}
`;

test("--noalias marks &mut params whose callee cannot reach an alias", () => {
  const ir = emitIr(NOALIAS_SRC, "--noalias");
  expect(defineOf(ir, "axpy")).toContain("ptr noalias nonnull dereferenceable(512) align 8 %y");
  // `&T` gets no noalias: a `&mut` elsewhere is ruled out, interior mutability is not
  expect(defineOf(ir, "axpy")).toContain("ptr nonnull dereferenceable(512) align 8 %x");
});

test("noalias is withheld where a global or a closure can alias the param", () => {
  const ir = emitIr(NOALIAS_SRC, "--noalias");
  // G escapes (passed by &mut) and the callee writes it, directly or through a call
  expect(defineOf(ir, "bumpGlobal")).not.toContain("noalias");
  expect(defineOf(ir, "viaHelper")).not.toContain("noalias");
  // the closure body writes `n`, which the &mut param points at
  expect(defineOf(ir, "callWith")).not.toContain("noalias");
});

test("noalias is off without the flag", () => {
  const ir = emitIr(NOALIAS_SRC, "--no-noalias");
  expect(ir.split("\n").filter(l => l.startsWith("define ") && l.includes("noalias"))).toEqual([]);
});
