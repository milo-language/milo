// Native C ABI classification for passing/returning structs by value across an
// extern (C) boundary. Covers AArch64 (AAPCS64) and x86_64 System V — the two ABIs
// Milo targets for hosted code. Bare-metal ARM (AAPCS32) is rejected.
//
// The classifier is pure: codegen feeds it a struct's size/align/float-ness (derived
// from Milo's manual layout, which now matches LLVM's) and gets back a lowering plan —
// register coercion, indirect (pointer / byval), or sret. Codegen renders the plan into
// LLVM declares AND matching call-site attributes (they MUST agree or x86_64 miscompiles).
//
// Stage 2 handles integer/pointer structs only. Structs with float fields that land in
// the register-passed size class (<=16 bytes) need HFA/SSE classification (stage 3) and
// currently raise AbiError; large float structs go indirect/sret and work today.

export type Arch = "aarch64" | "x86_64" | "arm";

export interface AbiStruct {
  name: string; // LLVM struct name without the leading '%'
  size: number; // total size in bytes (aligned)
  align: number; // natural alignment
  hasFloat: boolean; // any float leaf anywhere in the (flattened) struct
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

function floatReject(name: string): never {
  throw new AbiError(
    `extern struct '${name}' has float fields and fits in registers — HFA/SSE classification is not implemented yet (stage 3); pass &${name} for now`,
  );
}

export function classifyArg(arch: Arch, s: AbiStruct): ArgClass {
  if (arch === "arm") armReject(s.name);
  if (s.size > 16) {
    // AAPCS64 passes a plain pointer for oversized aggregates (callee copies if it must);
    // SysV requires the byval attribute so the backend materializes the copy.
    return { kind: "indirect", byval: arch === "x86_64", align: s.align, name: s.name };
  }
  if (s.hasFloat) floatReject(s.name);
  if (arch === "aarch64") {
    // AAPCS64: <=16B integer aggregate goes in 1-2 X registers, lowered as one
    // param of type i64 or [2 x i64].
    return s.size <= 8
      ? { kind: "coerce", regs: [{ ty: "i64", offset: 0 }], container: 8 }
      : { kind: "coerce", regs: [{ ty: "[2 x i64]", offset: 0 }], container: 16 };
  }
  // SysV: one i64 param per eightbyte (integer class).
  const n = eightbytes(s.size);
  const regs: Reg[] = [];
  for (let i = 0; i < n; i++) regs.push({ ty: "i64", offset: i * 8 });
  return { kind: "coerce", regs, container: n * 8 };
}

export function classifyRet(arch: Arch, s: AbiStruct): RetClass {
  if (arch === "arm") armReject(s.name);
  if (s.size > 16) return { kind: "sret", align: s.align, name: s.name };
  if (s.hasFloat) floatReject(s.name);
  if (arch === "aarch64") {
    return s.size <= 8
      ? { kind: "coerce", retTy: "i64", container: 8 }
      : { kind: "coerce", retTy: "[2 x i64]", container: 16 };
  }
  const n = eightbytes(s.size);
  const retTy = n === 1 ? "i64" : `{ ${Array(n).fill("i64").join(", ")} }`;
  return { kind: "coerce", retTy, container: n * 8 };
}
