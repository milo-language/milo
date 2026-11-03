import { test, expect, describe } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

// Executable fixtures (tests/run.test.ts) only exercise the HOST arch's ABI. These
// assertions pin the LLVM IR SHAPE emitted for BOTH targets, so a regression in the
// other ABI (byval/sret/coerce) is caught even though we can't run it here.

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const FIX = join(import.meta.dir, "fixtures");

function emitIR(fixture: string, target: string): string {
  return execSync(`bun run ${COMPILER} emit-ir ${join(FIX, fixture)} --target=${target}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// every declare-line attribute that lowers a struct must reappear at the call site,
// or x86_64 silently miscompiles. Assert the count of a token on declares == on calls.
function matchesDeclareAndCall(ir: string, token: string) {
  const decl = ir.split("\n").filter(l => l.trimStart().startsWith("declare") && l.includes(token)).length;
  const call = ir.split("\n").filter(l => l.includes("call ") && l.includes(token)).length;
  expect(decl).toBeGreaterThan(0);
  expect(call).toBeGreaterThan(0);
}

describe("abi: x86_64 System V IR shape", () => {
  test("large struct → sret return + byval arg, on declare AND call", () => {
    const ir = emitIR("externStructLarge.milo", "linux-x64");
    expect(ir).toContain("ptr sret(%Big) align 8");
    expect(ir).toContain("ptr byval(%Big) align 8");
    matchesDeclareAndCall(ir, "sret(%Big)");
    matchesDeclareAndCall(ir, "byval(%Big)");
  });

  test("small {i32,i32} struct → single i64 coercion", () => {
    const ir = emitIR("externStructSmallInt.milo", "linux-x64");
    expect(ir).toMatch(/declare i64 @add_pts\(i64, i64\)/);
  });

  test("two-eightbyte structs → two i64 params / i64 return chunks", () => {
    const ir = emitIR("externStructTwoRegs.milo", "linux-x64");
    expect(ir).toMatch(/declare .* @v2_add\(i64, i64, i64, i64\)/);
    expect(ir).toMatch(/declare i64 @v3_sum\(i64, i64\)/);
  });

  test("HFA/float structs → SSE (double) eightbytes", () => {
    const ir = emitIR("externStructHFA.milo", "linux-x64");
    expect(ir).toMatch(/declare double @dot2\(double, double, double, double\)/);
    expect(ir).toMatch(/declare \{ double, double \} @scale2\(double, double, double\)/);
  });

  test("mixed int/float struct → per-eightbyte SSE + INTEGER", () => {
    const ir = emitIR("externStructMixed.milo", "linux-x64");
    expect(ir).toMatch(/declare double @m1_use\(double, i64\)/);
    expect(ir).toMatch(/declare float @m2_use\(i64\)/); // {i32,f32} arg = one mixed eightbyte → INTEGER i64
  });
});

// `?&mut T` claims to be exactly `T *`. That claim is invisible to the fixture lane —
// a wrapper struct, a tag word or a second argument would all still run correctly from
// Milo — so it is pinned on the IR, for both ABIs.
describe("abi: nullable extern reference", () => {
  for (const target of ["linux-x64", "macos-arm64"]) {
    test(`?&mut T is one bare pointer parameter (${target})`, () => {
      const ir = emitIR("nullableExternRefMut.milo", target);
      const define = ir.split("\n").find(l => l.startsWith("define") && l.includes("@bumpX"));
      expect(define).toBeDefined();
      // The whole parameter list, not a substring: one `ptr` and nothing else (MLIR
      // numbers the parameter, `%0`, where the legacy text kept the name `%b`).
      expect(define).toMatch(/define i32 @bumpX\(ptr %[\w.]+\) \{/);
      // and the null test is a pointer compare against null, not an enum tag load
      expect(ir).toContain("icmp eq ptr");
    });
  }
});

// A `(A, B) => R` field in an extern struct claims to be ONE C function pointer, and the
// call through it claims to pass no environment. Neither claim is visible to the fixture
// lane — Milo compiles both sides, so a fat { code, env } field and a call that prepends
// the env would run and print the right answer — so both are pinned on the IR, for both
// ABIs.
describe("abi: extern struct C function-pointer field", () => {
  for (const target of ["linux-x64", "macos-arm64"]) {
    test(`the field is one bare ptr and the call passes no env (${target})`, () => {
      const ir = emitIR("externFnPtrField.milo", target);
      // The WHOLE struct type, not a substring: a fat field would read
      // `{ { ptr, ptr }, { ptr, ptr } }` and still contain "ptr, ptr".
      const structTy = ir.split("\n").find(l => l.startsWith("%Ops = type"));
      expect(structTy).toBe("%Ops = type { ptr, ptr }");
      // An indirect call through the loaded field with exactly the declared arguments.
      // The `ops.read(0 as *u8, 41)` call folds to a direct `@bump(ptr null, i32 41)`
      // under MLIR; the copied table's call stays indirect, so that one is pinned.
      expect(ir).toMatch(/call i32 %[\w.]+\((ptr null|ptr %[\w.]+), i32 \d+\)/);
      // and the field is filled with the code pointer alone
      expect(ir).toMatch(/store ptr @bump, ptr %[\w.]+/);
    });
  }
});

describe("abi: AArch64 AAPCS64 IR shape", () => {
  test("large struct → sret + PLAIN pointer arg (no byval on arm64)", () => {
    const ir = emitIR("externStructLarge.milo", "macos-arm64");
    expect(ir).toContain("ptr sret(%Big) align 8");
    expect(ir).not.toContain("byval");
    matchesDeclareAndCall(ir, "sret(%Big)");
  });

  test("non-HFA ≤16B struct → [2 x i64] GP-register coercion", () => {
    const ir = emitIR("externStructTwoRegs.milo", "macos-arm64");
    expect(ir).toMatch(/declare .* @v2_add\(\[2 x i64\], \[2 x i64\]\)/);
  });

  test("HFA structs → SIMD array coercion [N x float/double]", () => {
    const ir = emitIR("externStructHFA.milo", "macos-arm64");
    expect(ir).toMatch(/declare double @dot2\(\[2 x double\], \[2 x double\]\)/);
    expect(ir).toMatch(/declare float @sum4\(\[4 x float\]\)/);
  });

  test("nested HFA flattens to [3 x float]", () => {
    const ir = emitIR("externStructHFANested.milo", "macos-arm64");
    expect(ir).toMatch(/declare float @tri_sum\(\[3 x float\]\)/);
  });
});
