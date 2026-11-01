// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";
import type { Gen } from "./codegen";
import type { Span } from "./ast";
import type { HIRExpr } from "./hir";
import type { OwnLedger, CopyDecl } from "./codegen-own";
import type { EnumLayout, EnumVariant } from "./codegen";
import { genStringOrd, type StringCtx } from "./codegen-string";
import { LlvmTextBuilder, Ty, val, asGen, type Val, type Builder } from "./ir";

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this — they are not part of its external API.
interface CodegenCtx extends StringCtx {
  llvmType(t: TypeKind): string;
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: any): [string[], string, string];
  genVal(expr: any, lines: string[], sretDest?: string): Val;
  genLValue(expr: any): [string[], string, string];
  entryAllocas: string[];
  scopeCounter: number;
  hasVecType: boolean;
  needsMemcpy: boolean;
  needsMemcmp: boolean;
  needsMalloc: boolean;
  needsFree: boolean;
  needsRealloc: boolean;
  readonly hasRealloc: boolean;
  emitByteCount(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): string;
  own: OwnLedger;
  needsPrintf: boolean;
  needsDprintf: boolean;
  needsExit: boolean;
  genBoundI64(bound: HIRExpr, lines: string[]): string;
  needsDropCg(t: TypeKind): boolean;
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  emitBoundsCheck(lines: string[], idx: string, size: string, span?: Span): void;
  registerScopedTemp(lines: string[], addr: string, typeKind: TypeKind): string;
  valStore(ty: string, val: string, ptr: string, copy: CopyDecl): string;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
  enumLayouts: Map<string, EnumLayout>;
  storeEnumTag(lines: string[], enumTy: string, addr: string, tag: number | string): void;
  trapOnOverflow: boolean;
  currentFnWrapping: boolean;
  isUnsigned(t: TypeKind): boolean;
  emitCheckedArith(lines: string[], op: string, unsigned: boolean, llType: string, lv: string, rv: string, span: Span | undefined): string;
  enumPayloadPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number): string;
}

const VEC_TY = Ty.of("%Vec");
const I64_0 = val("0", Ty.i64);
const I64_1 = val("1", Ty.i64);
const I32_0 = val("0", Ty.i32);
const I32_1 = val("1", Ty.i32);

// Set up an `alloca Option<…>` pre-filled with None; callers branch to a "some"
// block that overwrites the tag and payload. Shared by get/min/max/indexOf/position.
function optionResultSlot(ctx: CodegenCtx, optionEnumName: string, label: string, lines: string[]): {
  enumTy: string; enumT: Ty; addr: Val; someTag: number;
} {
  const enumTy = `%${optionEnumName}`;
  const layout = ctx.enumLayouts.get(optionEnumName);
  if (!layout) throw new Error(`enum layout not found for ${optionEnumName}`);
  const none = layout.variants.get("None");
  const some = layout.variants.get("Some");
  if (!none || !some) throw new Error("Option enum missing Some/None variants");
  const enumT = Ty.of(enumTy);
  const b = new LlvmTextBuilder(lines, ctx);
  const addr = b.entryAlloca(`%__${label}.${ctx.scopeCounter++}.addr`, enumT);
  b.store(val("zeroinitializer", enumT), addr);
  ctx.storeEnumTag(lines, enumTy, addr.ref, none.tag);
  return { enumTy, enumT, addr, someTag: some.tag };
}

// v.get(i) / v.first() / v.last(): the total read. A negative index becomes a huge
// unsigned value, so the single `ult` test rejects both ends without a second compare.
export function genVecGetOpt(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecGetOpt" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));
  const vv = ctx.genVal(expr.object, lines);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv.ref, VEC_TY);
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);
  const iv = ctx.genVal(expr.index, lines);
  const index = val(iv.ref, Ty.i64);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecget", lines);
  const inBounds = b.icmp("ult", index, len);
  const someLabel = b.newBlock("vecget.some");
  const endLabel = b.newBlock("vecget.end");
  b.condBr(inBounds, someLabel, endLabel);
  b.position(someLabel);
  const elemPtr = b.gep(elemTy, data, [index]);
  const cloned = val(ctx.emitDeepCloneFromPtr(lines, elemPtr.ref, expr.elementType), elemTy);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr.ref, slot.someTag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr.ref, slot.someTag), Ty.ptr);
  b.store(cloned, payloadPtr);
  b.br(endLabel);
  b.position(endLabel);
  const result = b.load(slot.enumT, slot.addr);
  // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
  ctx.dropOwnedTemp(lines, vv.ref, "%Vec", expr.object);
  return [lines, result.ref, slot.enumTy];
}

// `a <op> b` for the comparable element types min/max/sort accept.
function emitElemOrd(ctx: CodegenCtx, lines: string[], elemType: TypeKind, a: Val, bv: Val, wantGreater: boolean): Val {
  if (elemType.tag === "string") {
    const [, r] = genStringOrd(ctx, lines, a.ref, bv.ref, wantGreater ? ">" : "<");
    return val(r, Ty.i1);
  }
  const b = new LlvmTextBuilder(lines, ctx);
  if (elemType.tag === "float") return b.fcmp(wantGreater ? "ogt" : "olt", a, bv);
  // bool is i1: unsigned ordering makes false < true
  const signed = elemType.tag === "int" && elemType.signed;
  return b.icmp(wantGreater ? (signed ? "sgt" : "ugt") : (signed ? "slt" : "ult"), a, bv);
}

// std/vec's `_natLess(a, b)`: emitElemOrd's `a < b`, so std's min/max order elements as
// the builtins did. The operands are places loaded bitwise (no string refcount traffic).
export function genNatLess(ctx: CodegenCtx, expr: HIRExpr & { kind: "NatLess" }, lines: string[]): Gen {
  const b = new LlvmTextBuilder(lines, ctx);
  const load = (e: HIRExpr): Val => {
    const t = e.type.tag === "ref" ? e.type.inner : e.type;
    const [placeLines, ptr] = ctx.genLValue(e);
    lines.push(...placeLines);
    return b.load(Ty.of(ctx.llvmType(t)), val(ptr, Ty.ptr));
  };
  const elemType = expr.a.type.tag === "ref" ? expr.a.type.inner : expr.a.type;
  const x = load(expr.a);
  const y = load(expr.b);
  return [lines, emitElemOrd(ctx, lines, elemType, x, y, false).ref, "i1"];
}

// std/vec's `_vecPanic("msg")`: the builtins' bounds-panic shape, "msg at file:line:col".
// Inside a @trackCaller copy panicAt names the caller, so the message is the builtin's.
export function genVecPanic(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecPanic" }, lines: string[]): Gen {
  ctx.needsDprintf = true;
  ctx.needsExit = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const { label, length } = ctx.addString(`${expr.message} at ${ctx.panicAt(expr.span)}\n`);
  const msg = b.gep(Ty.of(`[${length} x i8]`), val(label, Ty.ptr), [I32_0, I32_0]);
  ctx.emitFdPrintf(lines, 2, msg.ref, "");
  ctx.panicAbort(lines);
  b.unreachable();
  b.position(b.newBlock("vecpanic.after"));
  return [lines, "void", "void"];
}

// The `bad` condition shared by the Vec and array slice range checks: start < 0, end < start,
// or end > len.
function sliceRangeBad(b: LlvmTextBuilder, start: Val, end: Val, len: Val): Val {
  const badStart = b.icmp("slt", start, I64_0);
  const badOrder = b.icmp("slt", end, start);
  const badEnd = b.icmp("sgt", end, len);
  const bad0 = b.binop("or", badStart, badOrder);
  return b.binop("or", bad0, badEnd);
}

// Builds the non-owning %Vec view { ptr, len, cap = 0 }.
function sliceView(b: LlvmTextBuilder, ptr: Val, len: Val): Val {
  const s0 = b.insertvalue(val("undef", VEC_TY), ptr, 0);
  const s1 = b.insertvalue(s0, len, 1);
  return b.insertvalue(s1, I64_0, 2);
}

// v.slice(a, b) / v[a..b] — non-owning view: same %Vec rep with adjusted ptr/len
// and cap=0, so drop glue skips free (the source still owns the buffer).
export function genVecSlice(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecSlice" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));

  // fixed-size array source: the view points into the array's own storage, and
  // the length bound is the static extent N (there is no %Vec len field to read)
  if (expr.vec.type.tag === "array" && expr.vec.type.size !== null) {
    return genArraySlice(ctx, expr, lines);
  }

  const vRef = ctx.genVal(expr.vec, lines);
  const vVal = val(vRef.ref, VEC_TY);
  const startVal = val(ctx.genBoundI64(expr.start, lines), Ty.i64);
  const endVal = val(ctx.genBoundI64(expr.end, lines), Ty.i64);

  // bounds check against the source Vec's len (field 1), mirroring string slices
  ctx.needsPrintf = true;
  ctx.needsExit = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const lenVal = b.extractvalue(vVal, 1, Ty.i64);
  const bad = sliceRangeBad(b, startVal, endVal, lenVal);
  const panicLabel = b.newBlock("vecslice.panic");
  const okLabel = b.newBlock("vecslice.ok");
  b.condBr(bad, panicLabel, okLabel);
  b.position(panicLabel);
  const { label: errLabel, length: errLen } = ctx.addString(
    `milo: slice range out of bounds: %lld..%lld (len %lld) at ${ctx.panicAt(expr.span)}\n`,
  );
  const errPtr = b.gep(Ty.of(`[${errLen} x i8]`), val(errLabel, Ty.ptr), [I32_0, I32_0]);
  ctx.emitFdPrintf(lines, 2, errPtr.ref, `, i64 ${startVal.ref}, i64 ${endVal.ref}, i64 ${lenVal.ref}`);
  ctx.panicAbort(lines);
  b.unreachable();
  b.position(okLabel);

  const subLen = b.binop("sub", endVal, startVal);
  const srcPtr = b.extractvalue(vVal, 0, Ty.ptr);
  const slicePtr = b.gep(elemTy, srcPtr, [startVal]);

  return [lines, sliceView(b, slicePtr, subLen).ref, "%Vec"];
}

// Slice a fixed-size array into a non-owning %Vec view (cap=0) pointing at the
// array's own storage. Bound is the static extent N parsed from its [N x T] type.
function genArraySlice(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecSlice" }, lines: string[]): Gen {
  let [aLines, arrPtr, arrTy] = ctx.genLValue(expr.vec);
  // Not a place (`mk().sum()` on a returned [T; N]): genLValue has no address for it,
  // so the value goes to a frame slot of its own and the view points there.
  if (arrPtr === "null") {
    const [vLines, valRef, valTy] = ctx.genExpr(expr.vec);
    const slot = new LlvmTextBuilder(lines, ctx).entryAlloca(`%__arrtmp.${ctx.scopeCounter++}.addr`, Ty.of(valTy));
    aLines = [...vLines, ctx.valStore(valTy, valRef, slot.ref, ctx.own.valIntent(valRef, expr.vec.type))];
    // An array of owned elements (`f([$"a{i}", "b"])`) leaked every element: nothing
    // dropped the slot. The view may outlive the statement (a slice binding), so the
    // slot is dropped at the enclosing block's exit, not after the call.
    if (ctx.needsDropCg(expr.vec.type)) {
      ctx.own.valToSlot(valRef, slot.ref);
      ctx.registerScopedTemp(aLines, slot.ref, expr.vec.type);
    }
    arrPtr = slot.ref;
    arrTy = valTy;
  }
  lines.push(...aLines);
  const startVal = val(ctx.genBoundI64(expr.start, lines), Ty.i64);
  const endVal = val(ctx.genBoundI64(expr.end, lines), Ty.i64);

  const match = arrTy.match(/\[(\d+) x .+\]/);
  const size = match ? parseInt(match[1]) : 0;

  ctx.needsPrintf = true;
  ctx.needsExit = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const bad = sliceRangeBad(b, startVal, endVal, val(String(size), Ty.i64));
  const panicLabel = b.newBlock("arrslice.panic");
  const okLabel = b.newBlock("arrslice.ok");
  b.condBr(bad, panicLabel, okLabel);
  b.position(panicLabel);
  const { label: errLabel, length: errLen } = ctx.addString(
    `milo: slice range out of bounds: %lld..%lld (len ${size}) at ${ctx.panicAt(expr.span)}\n`,
  );
  const errPtr = b.gep(Ty.of(`[${errLen} x i8]`), val(errLabel, Ty.ptr), [I32_0, I32_0]);
  ctx.emitFdPrintf(lines, 2, errPtr.ref, `, i64 ${startVal.ref}, i64 ${endVal.ref}`);
  ctx.panicAbort(lines);
  b.unreachable();
  b.position(okLabel);

  ctx.hasVecType = true;
  const subLen = b.binop("sub", endVal, startVal);
  const slicePtr = b.gep(Ty.of(arrTy), val(arrPtr, Ty.ptr), [I64_0, startVal]);
  return [lines, sliceView(b, slicePtr, subLen).ref, "%Vec"];
}

// Below this many live bytes a grow is malloc + memcpy + free rather than realloc. A
// small block cannot be remapped, so realloc saves no memory there, and macOS's realloc
// first looks the pointer's zone and size up: respond's string building (buffers of a
// few hundred bytes) ran 13% slower on realloc than on the copy. At a page and above
// the remap is what keeps peak RSS at the new size (vec_grow: 132 MB -> 68 MB).
export const REALLOC_MIN_BYTES = 4096;


const I32_2 = val("2", Ty.i32);

// { ptr, len, cap } as three insertvalues into undef, the %Vec layout.
function makeVec(b: Builder, data: Val, len: Val, cap: Val): Val {
  const v0 = b.insertvalue(val("undef", VEC_TY), data, 0);
  const v1 = b.insertvalue(v0, len, 1);
  return b.insertvalue(v1, cap, 2);
}

export function genVecWithCapacity(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecWithCapacity" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMalloc = true;
  const elemSize = ctx.typeSizeOf(expr.elementType);
  const capRef = ctx.genVal(expr.capacity, lines);
  ctx.emitNonNegativeCheck(lines, capRef.ref, "capacity", expr.span);
  // malloc(cap * elemSize); empty (len=0) but pre-sized so pushes up to
  // cap don't realloc. cap==0 still allocates 0 bytes — harmless, matches
  // the "buffer or null" invariant push checks (null only when cap==0).
  const { buf } = ctx.emitAllocBytes(lines, capRef.ref, elemSize, "veccap", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = makeVec(b, val(buf, Ty.ptr), I64_0, val(capRef.ref, Ty.i64));
  return asGen(lines, vec);
}

export function genVecFilled(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFilled" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMalloc = true;
  const elemSize = ctx.typeSizeOf(expr.elementType);
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));
  const cntRef = ctx.genVal(expr.count, lines);
  ctx.emitNonNegativeCheck(lines, cntRef.ref, "length", expr.span);
  const valRef = ctx.genVal(expr.value, lines);
  const { buf: bufRef } = ctx.emitAllocBytes(lines, cntRef.ref, elemSize, "vecrep", expr.span);
  const buf = val(bufRef, Ty.ptr);
  const cnt = val(cntRef.ref, Ty.i64);
  // fill loop: for i in 0..count { buf[i] = value }
  const b = new LlvmTextBuilder(lines, ctx);
  const idxSlot = b.alloca(Ty.i64);
  b.store(I64_0, idxSlot);
  const condL = b.newBlock("vecfill.cond");
  const bodyL = b.newBlock("vecfill.body");
  const endL = b.newBlock("vecfill.end");
  b.br(condL);
  b.position(condL);
  const iv = b.load(Ty.i64, idxSlot);
  const more = b.icmp("ult", iv, cnt);
  b.condBr(more, bodyL, endL);
  b.position(bodyL);
  const slot = b.gep(elemTy, buf, [iv]);
  b.store(val(valRef.ref, elemTy), slot);
  const inc = b.binop("add", iv, I64_1);
  b.store(inc, idxSlot);
  b.br(condL);
  b.position(endL);
  return asGen(lines, makeVec(b, buf, cnt, cnt));
}

function vecInitialCap(elemSize: number): number { return Math.max(1, Math.min(8, Math.floor(64 / Math.max(1, elemSize)))); }

export function genVecPush(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecPush" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMalloc = true;
  ctx.needsFree = true;
  ctx.needsMemcpy = true;

  const vecType = expr.vec.type;
  if (vecType.tag !== "vec") throw new Error("VecPush on non-vec type");
  const elemSize = ctx.typeSizeOf(vecType.element);
  const elemTy = Ty.of(ctx.llvmType(vecType.element));

  // get pointer to the vec struct
  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.vec);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);

  // generate the value to push
  const valRef = ctx.genVal(expr.value, lines);
  const value = valRef;

  const b = new LlvmTextBuilder(lines, ctx);
  // load len and cap
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);
  const capPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_2]);
  const cap = b.load(Ty.i64, capPtr);

  // check if len >= cap (need to grow)
  const needsGrow = b.icmp("uge", len, cap);
  const growLabel = b.newBlock("vec.grow");
  const pushLabel = b.newBlock("vec.push");
  b.condBr(needsGrow, growLabel, pushLabel);

  // grow: new_cap = cap == 0 ? initialCap : cap * 2
  // The first allocation is sized in BYTES, not elements: a flat 8 elements
  // costs 64 bytes for a Vec<i64> but 1 KB for a Vec of 128-byte structs, and
  // an object with one property paid that full kilobyte (milojs: ~1 KB per
  // property, measured). Cap the first allocation near 64 bytes instead.
  const initialCap = vecInitialCap(elemSize);
  b.position(growLabel);
  const isZero = b.icmp("eq", cap, I64_0);
  // newCap's name is drawn before doubled's, as the string code did.
  const newCap = b.reserveTemp(Ty.i64);
  const doubled = b.binop("mul", cap, val("2", Ty.i64));
  b.select(isZero, val(String(initialCap), Ty.i64), doubled, newCap);
  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const oldBuf = b.load(Ty.ptr, dataPtr);
  const keepBytes = b.binop("mul", len, val(String(elemSize), Ty.i64));
  const newBuf = emitGrowBytes(ctx, lines, oldBuf, keepBytes, newCap, elemSize, "vecgrow", expr.span);
  const storeLabel = b.newBlock("vec.store");
  b.br(storeLabel);

  // store new buf, cap
  b.position(storeLabel);
  const dataPtr2 = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  b.store(newBuf, dataPtr2);
  b.store(newCap, capPtr);
  b.br(pushLabel);

  // push: store value at data[len], len++
  b.position(pushLabel);
  const curDataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const curData = b.load(Ty.ptr, curDataPtr);
  const curLen = b.load(Ty.i64, lenPtr);
  const elemPtr = b.gep(elemTy, curData, [curLen]);
  b.store(value, elemPtr);
  ctx.own.endVal(lines, valRef.ref, "STORE");
  const newLen = b.binop("add", curLen, I64_1);
  b.store(newLen, lenPtr);

  return [lines, "void", "void"];
}

export function genVecInsert(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecInsert" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMalloc = true;
  ctx.needsFree = true;
  ctx.needsMemcpy = true;
  ctx.needsDprintf = true;
  ctx.needsExit = true;

  const elemSize = ctx.typeSizeOf(expr.elementType);
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);
  const idxRef = ctx.genVal(expr.index, lines);
  const idxVal = val(idxRef.ref, Ty.i64);
  const valRef = ctx.genVal(expr.value, lines);
  const value = valRef;

  const b = new LlvmTextBuilder(lines, ctx);
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);
  const capPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_2]);
  const cap = b.load(Ty.i64, capPtr);

  // bounds: index must be <= len (== len means append)
  const oob = b.icmp("ugt", idxVal, len);
  const panicLabel = b.newBlock("vec.insert.panic");
  const growCheck = b.newBlock("vec.insert.growcheck");
  b.condBr(oob, panicLabel, growCheck);

  b.position(panicLabel);
  const span = expr.span;
  const { label: errLabel, length: errLen } = ctx.addString(`insert index out of bounds at ${ctx.panicAt(span)}\n`);
  const errPtr = b.gep(Ty.of(`[${errLen} x i8]`), val(errLabel, Ty.ptr), [I32_0, I32_0]);
  ctx.emitFdPrintf(lines, 2, errPtr.ref, "");
  ctx.panicAbort(lines);
  b.unreachable();

  // grow if len >= cap (we are adding one element) — identical policy to push
  b.position(growCheck);
  const needsGrow = b.icmp("uge", len, cap);
  const growLabel = b.newBlock("vec.insert.grow");
  const shiftLabel = b.newBlock("vec.insert.shift");
  b.condBr(needsGrow, growLabel, shiftLabel);

  b.position(growLabel);
  const isZero = b.icmp("eq", cap, I64_0);
  const doubled = b.binop("mul", cap, val("2", Ty.i64));
  const newCap = b.select(isZero, val(String(vecInitialCap(elemSize)), Ty.i64), doubled);
  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const oldBuf = b.load(Ty.ptr, dataPtr);
  const keepBytes = b.binop("mul", len, val(String(elemSize), Ty.i64));
  const newBuf = emitGrowBytes(ctx, lines, oldBuf, keepBytes, newCap, elemSize, "vecgrow2", expr.span);
  const storeLabel = b.newBlock("vec.insert.store");
  b.br(storeLabel);
  b.position(storeLabel);
  b.store(newBuf, dataPtr);
  b.store(newCap, capPtr);
  b.br(shiftLabel);

  // shift [index, len) right by one, then store value at index, len++
  b.position(shiftLabel);
  const curDataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const curData = b.load(Ty.ptr, curDataPtr);
  const srcPtr = b.gep(elemTy, curData, [idxVal]);
  const idxPlus1 = b.binop("add", idxVal, I64_1);
  const dstPtr = b.gep(elemTy, curData, [idxPlus1]);
  const tailCount = b.binop("sub", len, idxVal);
  const tailBytes = b.binop("mul", tailCount, val(String(elemSize), Ty.i64));
  b.callDiscard(Ty.void, "@llvm.memmove.p0.p0.i64", [dstPtr, srcPtr, tailBytes, val("false", Ty.i1)]);
  b.store(value, srcPtr);
  ctx.own.endVal(lines, valRef.ref, "STORE");
  const newLen = b.binop("add", len, I64_1);
  b.store(newLen, lenPtr);

  return [lines, "void", "void"];
}

// Grow a heap buffer to `count * elemSize` bytes, keeping its first `keepBytes`, and
// return the new pointer (the old one is dead afterwards). A buffer holding at least
// REALLOC_MIN_BYTES goes through realloc, so it grows in place or by page remap: peak
// memory stays near the new size instead of old + new, and nothing is copied when the
// block can extend. A smaller one is malloc + memcpy + free (see REALLOC_MIN_BYTES).
// Vec buffers only: a string's carries a count header and grows in @milo.str.reserve.
function emitGrowBytes(ctx: CodegenCtx, lines: string[], oldBuf: Val, keepBytes: Val, count: Val, elemSize: number, tag: string, span?: Span): Val {
  const b = new LlvmTextBuilder(lines, ctx);
  const nullPtr = val("null", Ty.ptr);
  if (!ctx.hasRealloc || elemSize === 0) {
    // Zero-size elements stay on malloc: realloc(p, 0) may free p and return null.
    ctx.needsFree = true;
    ctx.needsMemcpy = true;
    const { buf: bufRef } = ctx.emitAllocBytes(lines, count.ref, elemSize, tag, span);
    const buf = val(bufRef, Ty.ptr);
    const hasData = b.icmp("ne", oldBuf, nullPtr);
    const copyL = b.newBlock(`${tag}.copy`);
    const freeL = b.newBlock(`${tag}.free`);
    const doneL = b.newBlock(`${tag}.copied`);
    b.condBr(hasData, copyL, doneL);
    b.position(copyL);
    b.callDiscard(Ty.ptr, "@memcpy", [buf, oldBuf, keepBytes]);
    b.br(freeL);
    b.position(freeL);
    b.callDiscard(Ty.void, "@free", [oldBuf]);
    b.br(doneL);
    b.position(doneL);
    return buf;
  }
  ctx.needsRealloc = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  ctx.needsFree = true;
  const bytes = val(ctx.emitByteCount(lines, count.ref, elemSize, tag, span), Ty.i64);
  const useRe = b.icmp("uge", keepBytes, val(String(REALLOC_MIN_BYTES), Ty.i64));
  const reL = b.newBlock(`${tag}.realloc`);
  const freshL = b.newBlock(`${tag}.fresh`);
  const joinL = b.newBlock(`${tag}.grown`);
  b.condBr(useRe, reL, freshL);
  b.position(reL);
  const re = b.call(Ty.ptr, "@realloc", [oldBuf, bytes]);
  b.br(joinL);
  b.position(freshL);
  const fresh = b.call(Ty.ptr, "@malloc", [bytes]);
  // A null fresh block is caught after the join (the old one is left alone); the copy
  // is skipped for it and for a null source. The three names are drawn in the order
  // both, srcOk, dstOk but defined srcOk, dstOk, both, as the string code did.
  const both = b.reserveTemp(Ty.i1);
  const srcOk = b.reserveTemp(Ty.i1);
  const dstOk = b.reserveTemp(Ty.i1);
  b.icmp("ne", oldBuf, nullPtr, srcOk);
  b.icmp("ne", fresh, nullPtr, dstOk);
  b.binop("and", srcOk, dstOk, both);
  const cpL = b.newBlock(`${tag}.cp`);
  const freeL = b.newBlock(`${tag}.free`);
  const freshDoneL = b.newBlock(`${tag}.freshdone`);
  b.condBr(both, cpL, freshDoneL);
  b.position(cpL);
  b.callDiscard(Ty.ptr, "@memcpy", [fresh, oldBuf, keepBytes]);
  b.br(freeL);
  b.position(freeL);
  b.callDiscard(Ty.void, "@free", [oldBuf]);
  b.br(freshDoneL);
  b.position(freshDoneL);
  b.br(joinL);
  b.position(joinL);
  const buf = b.phi(Ty.ptr, [[re, reL], [fresh, freshDoneL]], true);
  ctx.emitAllocNullCheck(lines, buf.ref, tag, span);
  return buf;
}

// Grow `vecPtr`'s buffer so it holds at least `needCap` elements. Leaves the
// %Vec's data/cap fields updated; len is the caller's business.
function emitVecEnsureCapacity(ctx: CodegenCtx, lines: string[], vecPtr: Val, needCap: Val, elemSize: number, tag: string, span?: Span) {
  ctx.needsMalloc = true;
  ctx.needsFree = true;
  ctx.needsMemcpy = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const capPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_2]);
  const cap = b.load(Ty.i64, capPtr);
  const enough = b.icmp("uge", cap, needCap);
  const growLabel = b.newBlock(`${tag}.grow`);
  const doneLabel = b.newBlock(`${tag}.gdone`);
  b.condBr(enough, doneLabel, growLabel);
  b.position(growLabel);
  // Geometric growth on top of the exact request, so repeated extends stay amortized.
  const dbl = b.binop("shl", cap, I64_1);
  const useDbl = b.icmp("ugt", dbl, needCap);
  const newCap = b.select(useDbl, dbl, needCap);
  const oldBuf = b.load(Ty.ptr, dataPtr);
  const len = b.load(Ty.i64, lenPtr);
  const keepBytes = b.binop("mul", len, val(String(elemSize), Ty.i64));
  const newBuf = emitGrowBytes(ctx, lines, oldBuf, keepBytes, newCap, elemSize, tag, span);
  b.store(newBuf, dataPtr);
  b.store(newCap, capPtr);
  b.br(doneLabel);
  b.position(doneLabel);
}

// v.extend(other): the elements move across bitwise, so nothing is cloned and
// nothing is dropped. Only `other`'s spine is freed — its elements now live in
// the destination, and the checker has marked `other` moved so it never drops.
export function genVecExtend(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecExtend" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsFree = true;
  ctx.needsMemcpy = true;
  const elemBytes = ctx.typeSizeOf(expr.elementType);
  const elemSize = val(String(elemBytes), Ty.i64);

  const [dstLines, dstRef] = ctx.genLValue(expr.object);
  lines.push(...dstLines);
  const dstPtr = val(dstRef, Ty.ptr);
  const srcRef = ctx.genVal(expr.other, lines);
  const srcVal = val(srcRef.ref, VEC_TY);
  const b = new LlvmTextBuilder(lines, ctx);
  const srcData = b.extractvalue(srcVal, 0, Ty.ptr);
  const srcLen = b.extractvalue(srcVal, 1, Ty.i64);
  const srcCap = b.extractvalue(srcVal, 2, Ty.i64);

  const lenPtr = b.gep(VEC_TY, dstPtr, [I32_0, I32_1]);
  const dstLen = b.load(Ty.i64, lenPtr);
  const need = b.binop("add", dstLen, srcLen);
  emitVecEnsureCapacity(ctx, lines, dstPtr, need, elemBytes, "vecext", expr.span);

  const dataPtr = b.gep(VEC_TY, dstPtr, [I32_0, I32_0]);
  const dstData = b.load(Ty.ptr, dataPtr);
  const offBytes = b.binop("mul", dstLen, elemSize);
  const tail = b.gep(Ty.i8, dstData, [offBytes]);
  const copyBytes = b.binop("mul", srcLen, elemSize);
  b.callDiscard(Ty.ptr, "@memcpy", [tail, srcData, copyBytes]);
  b.store(need, lenPtr);

  // A slice (cap 0) never owns its buffer, and a zero-cap Vec has none.
  const owns = b.icmp("ugt", srcCap, I64_0);
  const freeLabel = b.newBlock("vecext.free");
  const endLabel = b.newBlock("vecext.end");
  b.condBr(owns, freeLabel, endLabel);
  b.position(freeLabel);
  b.callDiscard(Ty.void, "@free", [srcData]);
  b.br(endLabel);
  b.position(endLabel);
  ctx.own.endVal(lines, srcRef.ref, "STORE");
  return [lines, "0", "void"];
}

export function genVecReserve(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecReserve" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemSize = ctx.typeSizeOf(expr.elementType);
  const [vecLines, vecRef] = ctx.genLValue(expr.object);
  lines.push(...vecLines);
  const vecPtr = val(vecRef, Ty.ptr);
  const nRaw = ctx.genVal(expr.additional, lines);
  ctx.emitNonNegativeCheck(lines, nRaw.ref, "capacity", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);
  // reserve(n) is "room for n MORE", matching Rust — the count a writer has in
  // hand is almost always how many they are about to push, not the final total.
  const need = b.binop("add", len, val(nRaw.ref, Ty.i64));
  emitVecEnsureCapacity(ctx, lines, vecPtr, need, elemSize, "vecrsv", expr.span);
  return [lines, "0", "void"];
}
