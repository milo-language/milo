// Native C ABI classification for passing/returning structs by value across an
// extern (C) boundary. Covers AArch64 (AAPCS64) and x86_64 System V — the two ABIs
// Milo targets for hosted code. Bare-metal ARM (AAPCS32) is rejected.
//
// The classifier is pure: codegen feeds it a struct's size/align plus its flattened
// scalar leaves (byte offset, size, int-vs-float), all derived from Milo's manual
// layout (which matches LLVM's). It returns a lowering plan — register coercion,
// indirect (pointer / byval), or sret. Codegen renders the plan into LLVM declares AND
// matching call-site attributes (they MUST agree or x86_64 miscompiles).
//
// Float handling: AAPCS64 passes homogeneous-float aggregates (HFAs, 1-4 same-type
// float members) in SIMD registers as [N x float/double]; other <=16B aggregates go in
// GP registers (integer coerce). SysV classifies each eightbyte independently as SSE
// (all-float -> double, lone trailing f32 -> float) or INTEGER (-> i64).

export type Arch = "aarch64" | "x86_64" | "arm";

// The ABI is a function of arch AND OS: x86_64 Windows uses Microsoft x64, not System V,
// and the two disagree on every struct that isn't exactly 1/2/4/8 bytes. Windows on
// aarch64 follows AAPCS64 (HFAs included), so only the x86_64 arm needs the split.
export type Os = "darwin" | "linux" | "windows" | "none";

export interface AbiLeaf {
  offset: number; // byte offset within the struct
  size: number; // 4 or 8 for the scalar kinds that reach the ABI
  isFloat: boolean;
}

export interface AbiStruct {
  name: string; // LLVM struct name without the leading '%'
  size: number; // total size in bytes (aligned)
  align: number; // natural alignment
  leaves: AbiLeaf[]; // flattened scalar leaves, in offset order
}

// One register-sized piece of a coerced struct: an LLVM type loaded from `offset`.
export interface Reg {
  ty: string;
  offset: number;
}

export type ArgClass =
  | { kind: "direct" } // scalar / ptr / ref — passed unchanged
  | { kind: "coerce"; regs: Reg[]; container: number } // pass as register(s); container = bytes to stage in an alloca
  | { kind: "indirect"; byval: boolean; align: number; name: string }; // pass a pointer (byval attr only on SysV)

export type RetClass =
  | { kind: "direct" }
  | { kind: "coerce"; retTy: string; container: number } // returned in register(s) as this LLVM type
  | { kind: "sret"; align: number; name: string }; // returned via a caller-provided pointer

export class AbiError extends Error {}

function eightbytes(size: number): number {
  return Math.ceil(size / 8);
}

function armReject(name: string): never {
  throw new AbiError(
    `struct-by-value extern calls are not supported on bare-metal ARM (AAPCS32) — pass &${name} instead`,
  );
}

// AAPCS64 HFA: 1-4 members, all the same floating-point type (after flattening nested
// structs and arrays). Returns the element LLVM type and count, or null.
function hfa(s: AbiStruct): { count: number; eltTy: string } | null {
  const n = s.leaves.length;
  if (n < 1 || n > 4) return null;
  if (!s.leaves.every(l => l.isFloat)) return null;
  const sz = s.leaves[0].size;
  if (!s.leaves.every(l => l.size === sz)) return null;
  return { count: n, eltTy: sz === 4 ? "float" : "double" };
}

function hfaCoerceTy(h: { count: number; eltTy: string }): string {
  return h.count === 1 ? h.eltTy : `[${h.count} x ${h.eltTy}]`;
}

// SysV: type of one eightbyte [8k, 8k+8). SSE if every leaf in it is float; a lone
// 4-byte float in an otherwise-empty eightbyte is passed as `float`, else `double`.
function sysvEightbyteTy(s: AbiStruct, k: number): string {
  const lo = k * 8, hi = lo + 8;
  const inChunk = s.leaves.filter(l => l.offset < hi && l.offset + l.size > lo);
  const allFloat = inChunk.length > 0 && inChunk.every(l => l.isFloat);
  if (!allFloat) return "i64";
  return inChunk.length === 1 && inChunk[0].size === 4 ? "float" : "double";
}

function sysvRegs(s: AbiStruct): Reg[] {
  const n = eightbytes(s.size);
  const regs: Reg[] = [];
  for (let k = 0; k < n; k++) regs.push({ ty: sysvEightbyteTy(s, k), offset: k * 8 });
  return regs;
}

// Microsoft x64: a struct travels in ONE integer register iff its size is exactly 1, 2,
// 4, or 8 bytes. Every other size — 3/5/6/7 and anything over 8 — is passed as a pointer
// to a caller-owned copy. There is no HFA rule and no per-eightbyte classification: the
// 16-byte struct SysV splits across two registers goes by pointer here, and an all-float
// struct still rides in an integer register. Mismatching this does not fail to link, it
// silently passes garbage — externStructLarge returned 4294967297001 instead of 1001.
function win64InRegister(size: number): boolean {
  return size === 1 || size === 2 || size === 4 || size === 8;
}

function win64RegTy(size: number): string {
  return `i${size * 8}`;
}

export function classifyArg(arch: Arch, s: AbiStruct, os: Os = "linux"): ArgClass {
  if (arch === "arm") armReject(s.name);

  if (arch === "x86_64" && os === "windows") {
    if (!win64InRegister(s.size)) {
      // No byval: MSVC has the caller materialize the copy and pass its address, which
      // is also what clang emits for this target. byval here would disagree with the
      // C peer on who owns the temporary.
      return { kind: "indirect", byval: false, align: s.align, name: s.name };
    }
    return { kind: "coerce", regs: [{ ty: win64RegTy(s.size), offset: 0 }], container: s.size };
  }

  if (arch === "aarch64") {
    const h = hfa(s);
    if (h) {
      const ty = hfaCoerceTy(h);
      return { kind: "coerce", regs: [{ ty, offset: 0 }], container: Math.ceil(s.size / 8) * 8 };
    }
    if (s.size > 16) return { kind: "indirect", byval: false, align: s.align, name: s.name };
    // non-HFA <=16B aggregate → GP registers as i64 / [2 x i64]
    return s.size <= 8
      ? { kind: "coerce", regs: [{ ty: "i64", offset: 0 }], container: 8 }
      : { kind: "coerce", regs: [{ ty: "[2 x i64]", offset: 0 }], container: 16 };
  }

  // x86_64 System V
  if (s.size > 16) return { kind: "indirect", byval: true, align: s.align, name: s.name };
  const regs = sysvRegs(s);
  return { kind: "coerce", regs, container: eightbytes(s.size) * 8 };
}

export function classifyRet(arch: Arch, s: AbiStruct, os: Os = "linux"): RetClass {
  if (arch === "arm") armReject(s.name);

  if (arch === "x86_64" && os === "windows") {
    if (!win64InRegister(s.size)) return { kind: "sret", align: s.align, name: s.name };
    return { kind: "coerce", retTy: win64RegTy(s.size), container: s.size };
  }

  if (arch === "aarch64") {
    const h = hfa(s);
    if (h) return { kind: "coerce", retTy: hfaCoerceTy(h), container: Math.ceil(s.size / 8) * 8 };
    if (s.size > 16) return { kind: "sret", align: s.align, name: s.name };
    return s.size <= 8
      ? { kind: "coerce", retTy: "i64", container: 8 }
      : { kind: "coerce", retTy: "[2 x i64]", container: 16 };
  }

  // x86_64 System V
  if (s.size > 16) return { kind: "sret", align: s.align, name: s.name };
  const regs = sysvRegs(s);
  const retTy = regs.length === 1 ? regs[0].ty : `{ ${regs.map(r => r.ty).join(", ")} }`;
  return { kind: "coerce", retTy, container: eightbytes(s.size) * 8 };
}
