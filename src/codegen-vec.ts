// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";
import type { Gen } from "./codegen";
import type { Span } from "./ast";
import type { HIRExpr } from "./hir";
import type { OwnLedger, CopyDecl } from "./codegen-own";
import type { EnumLayout, EnumVariant } from "./codegen";
import { genStringCmp, genStringOrd, type StringCtx } from "./codegen-string";
import { LlvmTextBuilder, Ty, val, asGen, type Val, type Builder } from "./ir";

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this — they are not part of its external API.
interface CodegenCtx extends StringCtx {
  llvmType(t: TypeKind): string;
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: any): [string[], string, string];
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
  callbackElemArg(lines: string[], cbType: TypeKind, elemPtr: string, elemTy: string, paramIdx?: number): { arg: string; argTy: string };
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

// shared preamble: get vec data ptr, len, and set up insertion sort scaffolding
function sortPreamble(ctx: CodegenCtx, object: any, elementType: TypeKind, lines: string[], prefix: string) {
  ctx.hasVecType = true;
  ctx.needsMemcpy = true;
  const elemSize = ctx.typeSizeOf(elementType);
  const elemTy = Ty.of(ctx.llvmType(elementType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(object);
  lines.push(...vecPtrLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const vecPtr = val(vecPtrRef, Ty.ptr);

  const vecTy = Ty.of("%Vec");
  const dataPtr = b.gep(vecTy, vecPtr, [val("0", Ty.i32), val("0", Ty.i32)]);
  const data = b.load(Ty.ptr, dataPtr);
  const lenPtr = b.gep(vecTy, vecPtr, [val("0", Ty.i32), val("1", Ty.i32)]);
  const len = b.load(Ty.i64, lenPtr);

  const tmpAddr = b.entryAlloca(`%__${prefix}_tmp.${ctx.scopeCounter++}.addr`, elemTy);
  const iAddr = b.entryAlloca(`%__${prefix}_i.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(val("1", Ty.i64), iAddr);
  const jAddr = b.entryAlloca(`%__${prefix}_j.${ctx.scopeCounter++}.addr`, Ty.i64);

  return { data, len, elemTy, elemSize, tmpAddr, iAddr, jAddr };
}

// shared insertion sort loop structure — calls emitCompare to get the gt condition
function insertionSortLoop(
  ctx: CodegenCtx,
  lines: string[],
  p: ReturnType<typeof sortPreamble>,
  prefix: string,
  emitCompare: (prevPtr: Val, tmpAddr: Val) => Val,
  // Runs inside the outer body, right after the element is copied to the scratch slot
  // and before the inner loop starts. sortByKey extracts the key once here instead of
  // re-calling the key function on every inner iteration; the absence of this hook is
  // the entire reason a second copy of this loop existed.
  afterOuterCopy?: () => void,
) {
  const { data, len, elemTy, elemSize, tmpAddr, iAddr, jAddr } = p;
  const b = new LlvmTextBuilder(lines, ctx);
  const outerCond = b.newBlock(`${prefix}.outer.cond`);
  const outerBody = b.newBlock(`${prefix}.outer.body`);
  const innerCond = b.newBlock(`${prefix}.inner.cond`);
  const innerBody = b.newBlock(`${prefix}.inner.body`);
  const innerEnd = b.newBlock(`${prefix}.inner.end`);
  const outerEnd = b.newBlock(`${prefix}.outer.end`);
  const size = val(String(elemSize), Ty.i64);
  const volatileOff = val("false", Ty.i1);
  const memcpy = (dst: Val, src: Val) => b.callDiscard(Ty.void, "@llvm.memcpy.p0.p0.i64", [dst, src, size, volatileOff]);

  b.br(outerCond);
  b.position(outerCond);
  const i = b.load(Ty.i64, iAddr);
  const iCmp = b.icmp("ult", i, len);
  b.condBr(iCmp, outerBody, outerEnd);

  b.position(outerBody);
  const iPtr = b.gep(elemTy, data, [i]);
  memcpy(tmpAddr, iPtr);
  afterOuterCopy?.();
  b.store(i, jAddr);
  b.br(innerCond);

  b.position(innerCond);
  const j = b.load(Ty.i64, jAddr);
  const jGtZero = b.icmp("ugt", j, val("0", Ty.i64));
  const checkCmp = b.newBlock(`${prefix}.checkcmp`);
  b.condBr(jGtZero, checkCmp, innerEnd);

  b.position(checkCmp);
  const jm1 = b.binop("sub", j, val("1", Ty.i64));
  const prevPtr = b.gep(elemTy, data, [jm1]);

  const gtResult = emitCompare(prevPtr, tmpAddr);

  b.condBr(gtResult, innerBody, innerEnd);

  b.position(innerBody);
  const jPtr = b.gep(elemTy, data, [j]);
  memcpy(jPtr, prevPtr);
  const jNext = b.binop("sub", j, val("1", Ty.i64));
  b.store(jNext, jAddr);
  b.br(innerCond);

  b.position(innerEnd);
  const jFinal = b.load(Ty.i64, jAddr);
  const destPtr = b.gep(elemTy, data, [jFinal]);
  memcpy(destPtr, tmpAddr);
  const iNext = b.binop("add", i, val("1", Ty.i64));
  b.store(iNext, iAddr);
  b.br(outerCond);

  b.position(outerEnd);
}

// built-in > comparison for a known comparable type
function emitBuiltinGt(ctx: CodegenCtx, lines: string[], keyType: TypeKind, a: Val, bv: Val): Val {
  const b = new LlvmTextBuilder(lines, ctx);
  if (keyType.tag === "string") {
    ctx.needsMemcmp = true;
    const pData = b.extractvalue(a, 0, Ty.ptr);
    const pLen = b.extractvalue(a, 1, Ty.i64);
    const tData = b.extractvalue(bv, 0, Ty.ptr);
    const tLen = b.extractvalue(bv, 1, Ty.i64);
    // minLen's temp is drawn before lenCmp's but defined after it, as the old text did
    const minLen = b.reserveTemp(Ty.i64);
    const lenCmp = b.icmp("ult", pLen, tLen);
    b.select(lenCmp, pLen, tLen, minLen);
    const memcmpResult = b.call(Ty.i32, "@memcmp", [pData, tData, minLen]);
    const memcmpNonZero = b.icmp("ne", memcmpResult, val("0", Ty.i32));
    const cmpByData = b.icmp("sgt", memcmpResult, val("0", Ty.i32));
    const cmpByLen = b.icmp("ugt", pLen, tLen);
    return b.select(memcmpNonZero, cmpByData, cmpByLen);
  } else if (keyType.tag === "float") {
    return b.fcmp("ogt", a, bv);
  } else {
    return b.icmp(keyType.tag === "int" && keyType.signed ? "sgt" : "ugt", a, bv);
  }
}

export function genVecSort(
  ctx: CodegenCtx,
  object: any,
  elementType: TypeKind,
  lines: string[],
): [string[], string, string] {
  const p = sortPreamble(ctx, object, elementType, lines, "sort");
  const elemTy = p.elemTy;

  insertionSortLoop(ctx, lines, p, "sort", (prevPtr, tmpAddr) => {
    const b = new LlvmTextBuilder(lines, ctx);
    const prevVal = b.load(elemTy, prevPtr);
    const tmpVal = b.load(elemTy, tmpAddr);
    return emitBuiltinGt(ctx, lines, elementType, prevVal, tmpVal);
  });

  return [lines, "void", "void"];
}

// A closure value is { fn ptr, env ptr }.
function closureParts(ctx: CodegenCtx, lines: string[], closure: string): { fnPtr: Val; envPtr: Val } {
  const b = new LlvmTextBuilder(lines, ctx);
  const cl = val(closure, Ty.of("{ ptr, ptr }"));
  const fnPtr = b.extractvalue(cl, 0, Ty.ptr);
  const envPtr = b.extractvalue(cl, 1, Ty.ptr);
  return { fnPtr, envPtr };
}

// What to hand a sort callback for one element.
//
// sortBy and sortByKey hint `&T` but the checker lets a Copy element be declared by value
// (checker.ts checkCallbackSig), and these two sites passed the pointer regardless. The
// closure then compared ADDRESSES: `sortByKey((x: i64): i64 => 0 - x)` ordered by negated
// pointer, and `sortBy((x: i64, y: i64): bool => x > y)` left the vector untouched. Same
// hole, and the same fix, as callbackElemArg in codegen.ts — kept separate because this
// file takes a CodegenCtx rather than the class.
function cbElemArg(
  ctx: CodegenCtx,
  lines: string[],
  cbType: TypeKind,
  elemPtr: Val,
  elemTy: Ty,
  paramIdx = 0,
): Val {
  const prm = cbType.tag === "fn" ? cbType.params[paramIdx] : undefined;
  if (!prm || prm.tag === "ref" || prm.tag === "unknown") return elemPtr;
  return new LlvmTextBuilder(lines, ctx).load(elemTy, elemPtr);
}

export function genVecSortBy(
  ctx: CodegenCtx,
  object: any,
  callback: any,
  elementType: TypeKind,
  lines: string[],
): [string[], string, string] {
  const p = sortPreamble(ctx, object, elementType, lines, "sortby");
  // the checker admits any signed integer return; the sign is all that is read
  const retTy = Ty.of(callback.type.tag === "fn" && callback.type.ret.tag === "int" ? ctx.llvmType(callback.type.ret) : "i32");

  const [cl, cv] = ctx.genExpr(callback);
  lines.push(...cl);
  const { fnPtr, envPtr } = closureParts(ctx, lines, cv);

  insertionSortLoop(ctx, lines, p, "sortby", (prevPtr, tmpAddr) => {
    const a = cbElemArg(ctx, lines, callback.type, prevPtr, p.elemTy, 0);
    const bArg = cbElemArg(ctx, lines, callback.type, tmpAddr, p.elemTy, 1);
    const b = new LlvmTextBuilder(lines, ctx);
    const cmpResult = b.call(retTy, fnPtr.ref, [envPtr, a, bArg]);
    return b.icmp("sgt", cmpResult, val("0", retTy));
  });

  return [lines, "void", "void"];
}

export function genVecSortByKey(
  ctx: CodegenCtx,
  object: any,
  callback: any,
  elementType: TypeKind,
  keyType: TypeKind,
  lines: string[],
): [string[], string, string] {
  const p = sortPreamble(ctx, object, elementType, lines, "sortkey");
  const keyTy = Ty.of(ctx.llvmType(keyType));

  const [cl, cv] = ctx.genExpr(callback);
  lines.push(...cl);
  const { fnPtr, envPtr } = closureParts(ctx, lines, cv);

  // cache the key for the element being inserted so we don't re-extract each inner iteration
  const tmpKeyAddr = new LlvmTextBuilder(lines, ctx).entryAlloca(`%__sortkey_tmpkey.${ctx.scopeCounter++}.addr`, keyTy);

  insertionSortLoop(
    ctx,
    lines,
    p,
    "sortkey",
    (prevPtr, _tmpAddr) => {
      const ka = cbElemArg(ctx, lines, callback.type, prevPtr, p.elemTy);
      const b = new LlvmTextBuilder(lines, ctx);
      const prevKey = b.call(keyTy, fnPtr.ref, [envPtr, ka]);
      const curTmpKey = b.load(keyTy, tmpKeyAddr);
      return emitBuiltinGt(ctx, lines, keyType, prevKey, curTmpKey);
    },
    () => {
      // once per outer iteration, not once per comparison
      const kb = cbElemArg(ctx, lines, callback.type, p.tmpAddr, p.elemTy);
      const b = new LlvmTextBuilder(lines, ctx);
      const tmpKey = b.call(keyTy, fnPtr.ref, [envPtr, kb]);
      b.store(tmpKey, tmpKeyAddr);
    },
  );
  return [lines, "void", "void"];
}

const VEC_TY = Ty.of("%Vec");
const CLOSURE_TY = Ty.of("{ ptr, ptr }");
const I64_0 = val("0", Ty.i64);
const I64_1 = val("1", Ty.i64);
const I32_0 = val("0", Ty.i32);
const I32_1 = val("1", Ty.i32);

// Extract closure fn/env and vec data/len for functional methods.
// `release` frees a temporary receiver (`mk().any(f)`, `a.filter(f).map(g)`) and must run
// after the loop: every combinator reads elements in place or deep-clones them out, so
// once it has finished nothing points into the receiver and nothing else will free it.
function vecPreamble(ctx: CodegenCtx, vecExpr: HIRExpr, cbExpr: HIRExpr, elemType: TypeKind, lines: string[]): {
  fnPtr: Val; envPtr: Val; data: Val; len: Val; elemTy: Ty; release: () => void;
} {
  ctx.hasVecType = true;
  const [vl, vv] = ctx.genExpr(vecExpr);
  lines.push(...vl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv, VEC_TY);
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);
  const [cl, cv] = ctx.genExpr(cbExpr);
  lines.push(...cl);
  const cb = val(cv, CLOSURE_TY);
  const fnPtr = b.extractvalue(cb, 0, Ty.ptr);
  const envPtr = b.extractvalue(cb, 1, Ty.ptr);
  const release = () => ctx.dropOwnedTemp(lines, vv, "%Vec", vecExpr);
  return { fnPtr, envPtr, data, len, elemTy: Ty.of(ctx.llvmType(elemType)), release };
}

// What callbackElemArg (codegen.ts) hands the callback, as a typed value.
function cbArgVal(arg: { arg: string; argTy: string }): Val {
  return val(arg.arg, Ty.of(arg.argTy));
}

export function genVecMap(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecMap" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const resultElemTy = Ty.of(ctx.llvmType(expr.resultElementType));
  const resultElemSize = ctx.typeSizeOf(expr.resultElementType);
  ctx.needsMalloc = true;

  // allocate result buffer: malloc(len * elemSize)
  const { buf: bufRef } = ctx.emitAllocBytes(lines, len.ref, resultElemSize, "vecmap", expr.span);
  const buf = val(bufRef, Ty.ptr);

  const b = new LlvmTextBuilder(lines, ctx);
  const idxAddr = b.entryAlloca(`%__map_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("map.cond");
  const bodyLabel = b.newBlock("map.body");
  const endLabel = b.newBlock("map.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);
  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  // check if callback takes element by value or by ref
  const cbType = expr.callback.type;
  const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
  const callArg = paramIsRef ? elemPtr : b.load(elemTy, elemPtr);
  const result = b.call(resultElemTy, fnPtr.ref, [envPtr, callArg]);
  const destPtr = b.gep(resultElemTy, buf, [idx]);
  b.store(result, destPtr);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);
  b.position(endLabel);

  // build result Vec { buf, len, len }
  const v0 = b.insertvalue(val("undef", VEC_TY), buf, 0);
  const v1 = b.insertvalue(v0, len, 1);
  const v2 = b.insertvalue(v1, len, 2);
  release();
  return [lines, v2.ref, "%Vec"];
}

export function genVecFilter(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFilter" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const elemSize = ctx.typeSizeOf(expr.elementType);
  ctx.needsMalloc = true;

  // allocate result buffer with capacity = source len (worst case all match)
  const { buf: bufRef } = ctx.emitAllocBytes(lines, len.ref, elemSize, "vecfilt", expr.span);
  const buf = val(bufRef, Ty.ptr);

  const b = new LlvmTextBuilder(lines, ctx);
  const idxAddr = `%__filter_idx.${ctx.scopeCounter++}.addr`;
  const outIdxAddr = `%__filter_out.${ctx.scopeCounter++}.addr`;
  const idxSlot = b.entryAlloca(idxAddr, Ty.i64);
  const outIdxSlot = b.entryAlloca(outIdxAddr, Ty.i64);
  b.store(I64_0, idxSlot);
  b.store(I64_0, outIdxSlot);

  const condLabel = b.newBlock("filter.cond");
  const bodyLabel = b.newBlock("filter.body");
  const copyLabel = b.newBlock("filter.copy");
  const nextLabel = b.newBlock("filter.next");
  const endLabel = b.newBlock("filter.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxSlot);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);

  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  // keep's temp is drawn before callbackElemArg's load but defined after it
  const keep = b.reserveTemp(Ty.i1);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.call(Ty.i1, fnPtr.ref, [envPtr, cbArg], keep);
  b.condBr(keep, copyLabel, nextLabel);

  b.position(copyLabel);
  const cloned = val(ctx.emitDeepCloneFromPtr(lines, elemPtr.ref, expr.elementType), elemTy);
  const outIdx = b.load(Ty.i64, outIdxSlot);
  const destPtr = b.gep(elemTy, buf, [outIdx]);
  b.store(cloned, destPtr);
  const nextOut = b.binop("add", outIdx, I64_1);
  b.store(nextOut, outIdxSlot);
  b.br(nextLabel);

  b.position(nextLabel);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxSlot);
  b.br(condLabel);

  b.position(endLabel);
  const finalLen = b.load(Ty.i64, outIdxSlot);
  const v0 = b.insertvalue(val("undef", VEC_TY), buf, 0);
  const v1 = b.insertvalue(v0, finalLen, 1);
  const v2 = b.insertvalue(v1, len, 2);
  release();
  return [lines, v2.ref, "%Vec"];
}

export function genVecEach(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecEach" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const idxAddr = b.entryAlloca(`%__each_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("each.cond");
  const bodyLabel = b.newBlock("each.body");
  const endLabel = b.newBlock("each.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);
  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.callDiscard(Ty.void, fnPtr.ref, [envPtr, cbArg]);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);
  b.position(endLabel);
  release();
  return [lines, "void", "void"];
}

export function genVecAny(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecAny" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const resultAddr = b.entryAlloca(`%__any_result.${ctx.scopeCounter++}.addr`, Ty.i1);
  b.store(val("false", Ty.i1), resultAddr);

  const idxAddr = b.entryAlloca(`%__any_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("any.cond");
  const bodyLabel = b.newBlock("any.body");
  const endLabel = b.newBlock("any.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);
  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const match = b.reserveTemp(Ty.i1);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.call(Ty.i1, fnPtr.ref, [envPtr, cbArg], match);
  const foundLabel = b.newBlock("any.found");
  const nextLabel = b.newBlock("any.next");
  b.condBr(match, foundLabel, nextLabel);
  b.position(foundLabel);
  b.store(val("true", Ty.i1), resultAddr);
  b.br(endLabel);
  b.position(nextLabel);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);
  b.position(endLabel);
  const result = b.load(Ty.i1, resultAddr);
  release();
  return [lines, result.ref, "i1"];
}

export function genVecAll(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecAll" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const resultAddr = b.entryAlloca(`%__all_result.${ctx.scopeCounter++}.addr`, Ty.i1);
  b.store(val("true", Ty.i1), resultAddr);

  const idxAddr = b.entryAlloca(`%__all_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("all.cond");
  const bodyLabel = b.newBlock("all.body");
  const endLabel = b.newBlock("all.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);
  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const match = b.reserveTemp(Ty.i1);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.call(Ty.i1, fnPtr.ref, [envPtr, cbArg], match);
  const failLabel = b.newBlock("all.fail");
  const nextLabel = b.newBlock("all.next");
  b.condBr(match, nextLabel, failLabel);
  b.position(failLabel);
  b.store(val("false", Ty.i1), resultAddr);
  b.br(endLabel);
  b.position(nextLabel);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);
  b.position(endLabel);
  const result = b.load(Ty.i1, resultAddr);
  release();
  return [lines, result.ref, "i1"];
}

// acc = cb(acc, &elem) over every element. The accumulator lives in an alloca so
// the loop body can write it without a phi, matching how the other Vec callbacks
// carry state across iterations.
export function genVecFold(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFold" }, lines: string[]): Gen {
  const [initLines, initVal, accTyName] = ctx.genExpr(expr.init);
  lines.push(...initLines);
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const accTy = Ty.of(accTyName);
  const accAddr = b.entryAlloca(`%__fold_acc.${ctx.scopeCounter++}.addr`, accTy);
  b.store(val(initVal, accTy), accAddr);
  ctx.own.endVal(lines, initVal, "MOVE");

  const idxAddr = b.entryAlloca(`%__fold_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("fold.cond");
  const bodyLabel = b.newBlock("fold.body");
  const endLabel = b.newBlock("fold.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);

  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const acc = b.load(accTy, accAddr);
  const next = b.reserveTemp(accTy);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll, 1));
  // KNOWN LEAK when accTy owns heap (a String accumulator): the value in `acc` is owned
  // by nobody once this call returns.
  //
  // Caller side: `acc` is a raw `load` out of the alloca above — synthesized here, not an
  // HIRExpr — so isOwnedTempExpr/dropOwnedTemp, which only ever classify real
  // expressions, cannot see it.
  //
  // Callee side: a CLOSURE never registers its by-value owned parameters as droppable
  // locals. A plain `fn` does (see the param loop that pushes to droppableLocals with an
  // alive flag, dropped at scope exit unless moved out) — emit IR for
  // `fn cat(a: string)` and you get `%a.alive` plus a guarded free; the closure param
  // loop stores the parameter and registers a local, and stops there. So a closure
  // relies entirely on its CALLER owning the argument.
  //
  // That works everywhere else, because the caller does own it. It fails here because
  // fold's accumulator is invisible to the caller's own drop machinery, so neither side
  // covers it: `v.fold("s", (a: string, x: &i64): string => a + x.toString())` leaks one
  // accumulator per element.
  //
  // Do not "fix" it by dropping `acc` here, and do not make closures drop their params
  // without checking who else already does. A closure called with a temporary has that
  // temporary dropped by the CALLER today, so a callee-side drop would double free —
  // which is backlog #18's missing contract again.
  b.call(accTy, fnPtr.ref, [envPtr, acc, cbArg], next);
  b.store(next, accAddr);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);

  b.position(endLabel);
  const result = b.load(accTy, accAddr);
  release();
  return [lines, result.ref, accTyName];
}

export function genVecReverse(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecReverse" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMemcpy = true;
  const elemType = expr.elementType;
  const elemSize = ctx.typeSizeOf(elemType);
  const elemTy = Ty.of(ctx.llvmType(elemType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const vecPtr = val(vecPtrRef, Ty.ptr);

  const dataPtr = b.gep(VEC_TY, vecPtr, [val("0", Ty.i32), val("0", Ty.i32)]);
  const data = b.load(Ty.ptr, dataPtr);
  const lenPtr = b.gep(VEC_TY, vecPtr, [val("0", Ty.i32), val("1", Ty.i32)]);
  const len = b.load(Ty.i64, lenPtr);

  const tmpAddr = b.entryAlloca(`%__rev_tmp.${ctx.scopeCounter++}.addr`, elemTy);

  const loAddr = b.entryAlloca(`%__rev_lo.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, loAddr);
  const hiAddr = b.entryAlloca(`%__rev_hi.${ctx.scopeCounter++}.addr`, Ty.i64);
  const hiInit = b.binop("sub", len, I64_1);
  b.store(hiInit, hiAddr);

  const condLabel = b.newBlock("rev.cond");
  const bodyLabel = b.newBlock("rev.body");
  const endLabel = b.newBlock("rev.end");

  b.br(condLabel);
  b.position(condLabel);
  const lo = b.load(Ty.i64, loAddr);
  const hi = b.load(Ty.i64, hiAddr);
  const cmp = b.icmp("slt", lo, hi);
  b.condBr(cmp, bodyLabel, endLabel);

  b.position(bodyLabel);
  const loPtr = b.gep(elemTy, data, [lo]);
  const hiPtr = b.gep(elemTy, data, [hi]);
  const size = val(String(elemSize), Ty.i64);
  const volatileOff = val("false", Ty.i1);
  const memcpy = (dst: Val, src: Val) => b.callDiscard(Ty.void, "@llvm.memcpy.p0.p0.i64", [dst, src, size, volatileOff]);
  memcpy(tmpAddr, loPtr);
  memcpy(loPtr, hiPtr);
  memcpy(hiPtr, tmpAddr);
  const nextLo = b.binop("add", lo, I64_1);
  b.store(nextLo, loAddr);
  const nextHi = b.binop("sub", hi, I64_1);
  b.store(nextHi, hiAddr);
  b.br(condLabel);

  b.position(endLabel);
  return [lines, "void", "void"];
}

// pop(): Option<T> — Some(last) when non-empty, None when empty. The popped
// slot's ownership transfers into the Some payload (len-- makes the slot dead),
// so the value moves out with no clone. No panic path: `!` handles that.
export function genVecPop(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecPop" }, lines: string[]): Gen {
  ctx.hasVecType = true;

  const vecType = expr.vec.type;
  if (vecType.tag !== "vec") throw new Error("VecPop on non-vec type");
  const elemTy = Ty.of(ctx.llvmType(vecType.element));

  const enumTy = `%${expr.optionEnumName}`;
  const enumLayout = ctx.enumLayouts.get(expr.optionEnumName);
  if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);
  const noneVariant = enumLayout.variants.get("None");
  const someVariant = enumLayout.variants.get("Some");
  if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.vec);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);
  const b = new LlvmTextBuilder(lines, ctx);

  // load len
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);

  // result Option, defaulted to None
  const resultAddr = b.entryAlloca(`%__pop_result.${ctx.scopeCounter++}.addr`, Ty.of(enumTy));
  b.store(val("zeroinitializer", Ty.of(enumTy)), resultAddr);
  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, noneVariant.tag);

  const isEmpty = b.icmp("eq", len, I64_0);
  const someLabel = b.newBlock("vec.pop.some");
  const endLabel = b.newBlock("vec.pop.end");
  b.condBr(isEmpty, endLabel, someLabel);

  // some: len--, move value out of data[new_len] into Some payload
  b.position(someLabel);
  const newLen = b.binop("sub", len, I64_1);
  b.store(newLen, lenPtr);

  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const data = b.load(Ty.ptr, dataPtr);
  const elemPtr = b.gep(elemTy, data, [newLen]);
  const popped = b.load(elemTy, elemPtr);

  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, someVariant.tag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, enumTy, resultAddr.ref, someVariant), Ty.ptr);
  b.store(popped, payloadPtr);
  b.br(endLabel);

  b.position(endLabel);
  const result = b.load(Ty.of(enumTy), resultAddr);
  return [lines, result.ref, enumTy];
}

export function genVecFind(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFind" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const enumTy = `%${expr.optionEnumName}`;
  const enumLayout = ctx.enumLayouts.get(expr.optionEnumName);
  if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);

  const noneVariant = enumLayout.variants.get("None");
  const someVariant = enumLayout.variants.get("Some");
  if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const b = new LlvmTextBuilder(lines, ctx);
  const enumT = Ty.of(enumTy);
  const resultAddr = b.entryAlloca(`%__find_result.${ctx.scopeCounter++}.addr`, enumT);
  b.store(val("zeroinitializer", enumT), resultAddr);
  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, noneVariant.tag);

  const idxAddr = b.entryAlloca(`%__find_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("find.cond");
  const bodyLabel = b.newBlock("find.body");
  const foundLabel = b.newBlock("find.found");
  const nextLabel = b.newBlock("find.next");
  const endLabel = b.newBlock("find.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);

  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  // the call's result temp is drawn before callbackElemArg's load, as the old text did
  const match = b.reserveTemp(Ty.i1);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.call(Ty.i1, fnPtr.ref, [envPtr, cbArg], match);
  b.condBr(match, foundLabel, nextLabel);

  b.position(foundLabel);
  const cloned = val(ctx.emitDeepCloneFromPtr(lines, elemPtr.ref, expr.elementType), elemTy);
  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, someVariant.tag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, enumTy, resultAddr.ref, someVariant), Ty.ptr);
  b.store(cloned, payloadPtr);
  b.br(endLabel);

  b.position(nextLabel);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);

  b.position(endLabel);
  const result = b.load(enumT, resultAddr);
  release();
  return [lines, result.ref, enumTy];
}

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
  const [vl, vv] = ctx.genExpr(expr.object);
  lines.push(...vl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv, VEC_TY);
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);
  const [il, iv] = ctx.genExpr(expr.index);
  lines.push(...il);
  const index = val(iv, Ty.i64);

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
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.object);
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

export function genVecMinMax(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecMinMax" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));
  const [vl, vv] = ctx.genExpr(expr.object);
  lines.push(...vl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv, VEC_TY);
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecminmax", lines);
  const empty = b.icmp("eq", len, I64_0);
  const scanLabel = b.newBlock("vecmm.scan");
  const endLabel = b.newBlock("vecmm.end");
  b.condBr(empty, endLabel, scanLabel);
  b.position(scanLabel);

  // Track the winning index, not the value: a String winner is cloned once, at
  // the end, instead of on every improvement.
  const bestAddr = b.alloca(Ty.i64);
  b.store(I64_0, bestAddr);
  const iAddr = b.alloca(Ty.i64);
  b.store(I64_1, iAddr);
  const cond = b.newBlock("vecmm.cond");
  const body = b.newBlock("vecmm.body");
  const better = b.newBlock("vecmm.better");
  const step = b.newBlock("vecmm.step");
  const done = b.newBlock("vecmm.done");
  b.br(cond);
  b.position(cond);
  const i = b.load(Ty.i64, iAddr);
  const more = b.icmp("ult", i, len);
  b.condBr(more, body, done);
  b.position(body);
  const curPtr = b.gep(elemTy, data, [i]);
  const cur = b.load(elemTy, curPtr);
  const bestIdx = b.load(Ty.i64, bestAddr);
  const bestPtr = b.gep(elemTy, data, [bestIdx]);
  const best = b.load(elemTy, bestPtr);
  const wins = emitElemOrd(ctx, lines, expr.elementType, cur, best, expr.isMax);
  const winsLabel = b.newBlock("vecmm.cmpdone");
  b.br(winsLabel);
  b.position(winsLabel);
  b.condBr(wins, better, step);
  b.position(better);
  const iNow = b.load(Ty.i64, iAddr);
  b.store(iNow, bestAddr);
  b.br(step);
  b.position(step);
  const iCur = b.load(Ty.i64, iAddr);
  const iNext = b.binop("add", iCur, I64_1);
  b.store(iNext, iAddr);
  b.br(cond);
  b.position(done);
  const winIdx = b.load(Ty.i64, bestAddr);
  const winPtr = b.gep(elemTy, data, [winIdx]);
  const cloned = val(ctx.emitDeepCloneFromPtr(lines, winPtr.ref, expr.elementType), elemTy);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr.ref, slot.someTag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr.ref, slot.someTag), Ty.ptr);
  b.store(cloned, payloadPtr);
  b.br(endLabel);
  b.position(endLabel);
  const result = b.load(slot.enumT, slot.addr);
  // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.object);
  return [lines, result.ref, slot.enumTy];
}

export function genVecIndexOf(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecIndexOf" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));
  const [vl, vv] = ctx.genExpr(expr.vec);
  lines.push(...vl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv, VEC_TY);
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);
  const [nl, nvRef] = ctx.genExpr(expr.value);
  lines.push(...nl);
  const nv = val(nvRef, elemTy);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecidx", lines);
  const iAddr = b.alloca(Ty.i64);
  b.store(I64_0, iAddr);
  const cond = b.newBlock("vecidx.cond");
  const body = b.newBlock("vecidx.body");
  const found = b.newBlock("vecidx.found");
  const step = b.newBlock("vecidx.step");
  const end = b.newBlock("vecidx.end");
  b.br(cond);
  b.position(cond);
  const i = b.load(Ty.i64, iAddr);
  const more = b.icmp("ult", i, len);
  b.condBr(more, body, end);
  b.position(body);
  const elemPtr = b.gep(elemTy, data, [i]);
  const elemVal = b.load(elemTy, elemPtr);
  let eq: Val;
  if (expr.elementType.tag === "string") {
    const [, r] = genStringCmp(ctx, lines, elemVal.ref, nv.ref, true);
    eq = val(r, Ty.i1);
  } else if (expr.elementType.tag === "float") {
    eq = b.fcmp("oeq", elemVal, nv);
  } else {
    eq = b.icmp("eq", elemVal, nv);
  }
  // the string compare above may have opened blocks; land in a fresh one so the
  // index load below is reachable from a single predecessor
  const testLabel = b.newBlock("vecidx.test");
  b.br(testLabel);
  b.position(testLabel);
  b.condBr(eq, found, step);
  b.position(found);
  const hitIdx = b.load(Ty.i64, iAddr);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr.ref, slot.someTag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr.ref, slot.someTag), Ty.ptr);
  b.store(hitIdx, payloadPtr);
  b.br(end);
  b.position(step);
  const iCur = b.load(Ty.i64, iAddr);
  const iNext = b.binop("add", iCur, I64_1);
  b.store(iNext, iAddr);
  b.br(cond);
  b.position(end);
  const result = b.load(slot.enumT, slot.addr);
  // Same as the map lookups: the needle is the caller's, and a read-only search takes
  // no ownership of it. `v.contains("s" + i.toString())` leaked the needle per call.
  ctx.dropOwnedTemp(lines, nv.ref, elemTy.ll, expr.value);
  // …and the receiver, when that is a temporary: `mkVec().contains(x)` leaked the whole
  // container. A search keeps no pointer into it once the answer is a scalar.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.vec);
  return [lines, result.ref, slot.enumTy];
}

export function genVecPosition(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecPosition" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecpos", lines);
  const b = new LlvmTextBuilder(lines, ctx);
  const iAddr = b.alloca(Ty.i64);
  b.store(I64_0, iAddr);
  const cond = b.newBlock("vecpos.cond");
  const body = b.newBlock("vecpos.body");
  const found = b.newBlock("vecpos.found");
  const step = b.newBlock("vecpos.step");
  const end = b.newBlock("vecpos.end");
  b.br(cond);
  b.position(cond);
  const i = b.load(Ty.i64, iAddr);
  const more = b.icmp("ult", i, len);
  b.condBr(more, body, end);
  b.position(body);
  const elemPtr = b.gep(elemTy, data, [i]);
  // the call's result temp is drawn before callbackElemArg's load, as the old text did
  const hit = b.reserveTemp(Ty.i1);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll));
  b.call(Ty.i1, fnPtr.ref, [envPtr, cbArg], hit);
  b.condBr(hit, found, step);
  b.position(found);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr.ref, slot.someTag);
  const payloadPtr = val(ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr.ref, slot.someTag), Ty.ptr);
  b.store(i, payloadPtr);
  b.br(end);
  b.position(step);
  const iNext = b.binop("add", i, I64_1);
  b.store(iNext, iAddr);
  b.br(cond);
  b.position(end);
  const result = b.load(slot.enumT, slot.addr);
  release();
  return [lines, result.ref, slot.enumTy];
}

// `v.truncate(n)` / `v.clear()`. Elements at index >= n are OWNED by the Vec, so
// shortening the length without running their drop glue would leak every string,
// nested Vec or Drop-implementing struct above the cut. The counter lives in an
// alloca rather than a phi because emitDropValue splits the block.
export function genVecTruncate(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecTruncate" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemType = expr.elementType;
  const elemTy = Ty.of(ctx.llvmType(elemType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);
  const [nLines, nRaw] = ctx.genExpr(expr.length);
  lines.push(...nLines);

  const b = new LlvmTextBuilder(lines, ctx);
  // A negative length means empty; a length past the end is a no-op, never a grow.
  const isNeg = b.icmp("slt", val(nRaw, Ty.i64), I64_0);
  const n = b.select(isNeg, I64_0, val(nRaw, Ty.i64));

  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);

  const doneLabel = b.newBlock("vec.trunc.done");
  const startLabel = b.newBlock("vec.trunc.start");
  const noop = b.icmp("uge", n, len);
  b.condBr(noop, doneLabel, startLabel);
  b.position(startLabel);

  if (ctx.needsDropCg(elemType)) {
    const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
    const data = b.load(Ty.ptr, dataPtr);

    const iAddr = b.entryAlloca(`%__trunc_i.${ctx.scopeCounter++}.addr`, Ty.i64);
    b.store(n, iAddr);

    const condLabel = b.newBlock("vec.trunc.cond");
    const bodyLabel = b.newBlock("vec.trunc.body");
    const finLabel = b.newBlock("vec.trunc.fin");
    b.br(condLabel);
    b.position(condLabel);
    const i = b.load(Ty.i64, iAddr);
    const cont = b.icmp("ult", i, len);
    b.condBr(cont, bodyLabel, finLabel);

    b.position(bodyLabel);
    const elemPtr = b.gep(elemTy, data, [i]);
    ctx.emitDropValue(lines, elemPtr.ref, elemType);
    const iNow = b.load(Ty.i64, iAddr);
    const iNext = b.binop("add", iNow, I64_1);
    b.store(iNext, iAddr);
    b.br(condLabel);

    b.position(finLabel);
  }

  b.store(n, lenPtr);
  b.br(doneLabel);
  b.position(doneLabel);
  return [lines, "void", "void"];
}

export function genVecSwap(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecSwap" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMemcpy = true;
  const elemType = expr.elementType;
  const elemSize = val(String(ctx.typeSizeOf(elemType)), Ty.i64);
  const elemTy = Ty.of(ctx.llvmType(elemType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);

  const aVal = val(ctx.genBoundI64(expr.indexA, lines), Ty.i64);
  const bVal = val(ctx.genBoundI64(expr.indexB, lines), Ty.i64);

  const b = new LlvmTextBuilder(lines, ctx);
  // Both indices are bounds-checked. This GEP'd straight into the buffer and memcpy'd
  // three times with no length load at all, so `v.swap(0, 999999)` was an out-of-bounds
  // read AND write from safe code that exited 0. Every other indexed Vec operation
  // checks; this one was simply missed.
  const lenPtrB = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const lenB = b.load(Ty.i64, lenPtrB);
  for (const idx of [aVal, bVal]) ctx.emitBoundsCheck(lines, idx.ref, lenB.ref, expr.span);

  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const data = b.load(Ty.ptr, dataPtr);

  const ptrA = b.gep(elemTy, data, [aVal]);
  const ptrB = b.gep(elemTy, data, [bVal]);

  const tmpAddr = b.entryAlloca(`%__swap_tmp.${ctx.scopeCounter++}.addr`, elemTy);
  const noVolatile = val("false", Ty.i1);
  b.callDiscard(Ty.void, "@llvm.memcpy.p0.p0.i64", [tmpAddr, ptrA, elemSize, noVolatile]);
  b.callDiscard(Ty.void, "@llvm.memcpy.p0.p0.i64", [ptrA, ptrB, elemSize, noVolatile]);
  b.callDiscard(Ty.void, "@llvm.memcpy.p0.p0.i64", [ptrB, tmpAddr, elemSize, noVolatile]);

  return [lines, "void", "void"];
}

export function genVecRemove(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecRemove" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsDprintf = true;
  ctx.needsExit = true;

  const elemSize = val(String(ctx.typeSizeOf(expr.elementType)), Ty.i64);
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));

  const [vecPtrLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);
  const vecPtr = val(vecPtrRef, Ty.ptr);
  const [idxLines, idxRef] = ctx.genExpr(expr.index);
  lines.push(...idxLines);
  const idxVal = val(idxRef, Ty.i64);

  const b = new LlvmTextBuilder(lines, ctx);
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);

  // bounds: index must be < len
  const oob = b.icmp("uge", idxVal, len);
  const panicLabel = b.newBlock("vec.remove.panic");
  const okLabel = b.newBlock("vec.remove.ok");
  b.condBr(oob, panicLabel, okLabel);

  b.position(panicLabel);
  const span = expr.span;
  const { label: errLabel, length: errLen } = ctx.addString(`remove index out of bounds at ${ctx.panicAt(span)}\n`);
  const errPtr = b.gep(Ty.of(`[${errLen} x i8]`), val(errLabel, Ty.ptr), [I32_0, I32_0]);
  ctx.emitFdPrintf(lines, 2, errPtr.ref, "");
  ctx.panicAbort(lines);
  b.unreachable();

  b.position(okLabel);
  const dataPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_0]);
  const data = b.load(Ty.ptr, dataPtr);
  const elemPtr = b.gep(elemTy, data, [idxVal]);
  const elem = b.load(elemTy, elemPtr);

  // shift [index+1, len) left by one
  const idxPlus1 = b.binop("add", idxVal, I64_1);
  const srcPtr = b.gep(elemTy, data, [idxPlus1]);
  const tailCount = b.binop("sub", len, idxPlus1);
  const tailBytes = b.binop("mul", tailCount, elemSize);
  b.callDiscard(Ty.void, "@llvm.memmove.p0.p0.i64", [elemPtr, srcPtr, tailBytes, val("false", Ty.i1)]);
  const newLen = b.binop("sub", len, I64_1);
  b.store(newLen, lenPtr);

  return [lines, elem.ref, elemTy.ll];
}

export function genVecContains(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecContains" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemType = expr.elementType;
  const elemTy = Ty.of(ctx.llvmType(elemType));

  const [vecLines, vecRef] = ctx.genExpr(expr.vec);
  lines.push(...vecLines);
  const vecVal = val(vecRef, VEC_TY);
  const b = new LlvmTextBuilder(lines, ctx);
  const data = b.extractvalue(vecVal, 0, Ty.ptr);
  const len = b.extractvalue(vecVal, 1, Ty.i64);

  const [valLines, valRef, valLt] = ctx.genExpr(expr.value);
  lines.push(...valLines);
  const needle = val(valRef, Ty.of(valLt));

  const resultAddr = b.entryAlloca(`%__contains_result.${ctx.scopeCounter++}.addr`, Ty.i1);
  b.store(val("false", Ty.i1), resultAddr);

  const idxAddr = b.entryAlloca(`%__contains_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("contains.cond");
  const bodyLabel = b.newBlock("contains.body");
  const foundLabel = b.newBlock("contains.found");
  const nextLabel = b.newBlock("contains.next");
  const endLabel = b.newBlock("contains.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);

  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);

  if (elemType.tag === "string") {
    ctx.needsMemcmp = true;
    const elemVal = b.load(Ty.of("%String"), elemPtr);
    const [, cmpResult] = genStringCmp(ctx, lines, elemVal.ref, needle.ref, true);
    b.condBr(val(cmpResult, Ty.i1), foundLabel, nextLabel);
  } else {
    const elemVal = b.load(needle.ty, elemPtr);
    const eq = elemType.tag === "float" ? b.fcmp("oeq", elemVal, needle) : b.icmp("eq", elemVal, needle);
    b.condBr(eq, foundLabel, nextLabel);
  }

  b.position(foundLabel);
  b.store(val("true", Ty.i1), resultAddr);
  b.br(endLabel);

  b.position(nextLabel);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);

  b.position(endLabel);
  const result = b.load(Ty.i1, resultAddr);
  // Same as the map lookups: the needle is the caller's, and a read-only search takes
  // no ownership of it. `v.contains("s" + i.toString())` leaked the needle per call.
  ctx.dropOwnedTemp(lines, needle.ref, valLt, expr.value);
  // …and the receiver, when that is a temporary: `mkVec().contains(x)` leaked the whole
  // container. A search keeps no pointer into it once the answer is a scalar.
  ctx.dropOwnedTemp(lines, vecVal.ref, "%Vec", expr.vec);
  return [lines, result.ref, "i1"];
}

export function genVecEnumerate(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecEnumerate" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = vecPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const idxAddr = b.entryAlloca(`%__enum_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condLabel = b.newBlock("enum.cond");
  const bodyLabel = b.newBlock("enum.body");
  const endLabel = b.newBlock("enum.end");

  b.br(condLabel);
  b.position(condLabel);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyLabel, endLabel);
  b.position(bodyLabel);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const cbArg = cbArgVal(ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTy.ll, 1));
  b.callDiscard(Ty.void, fnPtr.ref, [envPtr, idx, cbArg]);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condLabel);
  b.position(endLabel);
  release();
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

  const [vLines, vRef] = ctx.genExpr(expr.vec);
  lines.push(...vLines);
  const vVal = val(vRef, VEC_TY);
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
  const [capLines, capRef] = ctx.genExpr(expr.capacity);
  lines.push(...capLines);
  ctx.emitNonNegativeCheck(lines, capRef, "capacity", expr.span);
  // malloc(cap * elemSize); empty (len=0) but pre-sized so pushes up to
  // cap don't realloc. cap==0 still allocates 0 bytes — harmless, matches
  // the "buffer or null" invariant push checks (null only when cap==0).
  const { buf } = ctx.emitAllocBytes(lines, capRef, elemSize, "veccap", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = makeVec(b, val(buf, Ty.ptr), I64_0, val(capRef, Ty.i64));
  return asGen(lines, vec);
}

export function genVecFilled(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFilled" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMalloc = true;
  const elemSize = ctx.typeSizeOf(expr.elementType);
  const elemTy = Ty.of(ctx.llvmType(expr.elementType));
  const [cntLines, cntRef] = ctx.genExpr(expr.count);
  lines.push(...cntLines);
  ctx.emitNonNegativeCheck(lines, cntRef, "length", expr.span);
  const [valLines, valRef] = ctx.genExpr(expr.value);
  lines.push(...valLines);
  const { buf: bufRef } = ctx.emitAllocBytes(lines, cntRef, elemSize, "vecrep", expr.span);
  const buf = val(bufRef, Ty.ptr);
  const cnt = val(cntRef, Ty.i64);
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
  b.store(val(valRef, elemTy), slot);
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
  const [valLines, valRef, valTy] = ctx.genExpr(expr.value);
  lines.push(...valLines);
  const value = val(valRef, Ty.of(valTy));

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
  ctx.own.endVal(lines, valRef, "STORE");
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
  const [idxLines, idxRef] = ctx.genExpr(expr.index);
  lines.push(...idxLines);
  const idxVal = val(idxRef, Ty.i64);
  const [valLines, valRef, valTy] = ctx.genExpr(expr.value);
  lines.push(...valLines);
  const value = val(valRef, Ty.of(valTy));

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
  ctx.own.endVal(lines, valRef, "STORE");
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
  const [srcLines, srcRef] = ctx.genExpr(expr.other);
  lines.push(...srcLines);
  const srcVal = val(srcRef, VEC_TY);
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
  ctx.own.endVal(lines, srcRef, "STORE");
  return [lines, "0", "void"];
}

export function genVecReserve(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecReserve" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemSize = ctx.typeSizeOf(expr.elementType);
  const [vecLines, vecRef] = ctx.genLValue(expr.object);
  lines.push(...vecLines);
  const vecPtr = val(vecRef, Ty.ptr);
  const [nLines, nRaw] = ctx.genExpr(expr.additional);
  lines.push(...nLines);
  ctx.emitNonNegativeCheck(lines, nRaw, "capacity", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  const lenPtr = b.gep(VEC_TY, vecPtr, [I32_0, I32_1]);
  const len = b.load(Ty.i64, lenPtr);
  // reserve(n) is "room for n MORE", matching Rust — the count a writer has in
  // hand is almost always how many they are about to push, not the final total.
  const need = b.binop("add", len, val(nRaw, Ty.i64));
  emitVecEnsureCapacity(ctx, lines, vecPtr, need, elemSize, "vecrsv", expr.span);
  return [lines, "0", "void"];
}

// v.sum() — accumulate all elements. Integer addition follows the enclosing function's
// normal checked/wrapping policy; floats use fadd. Empty vec sums to 0.
export function genVecSum(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecSum" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const [vl, vv] = ctx.genExpr(expr.vec);
  lines.push(...vl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vec = val(vv, Ty.of("%Vec"));
  const data = b.extractvalue(vec, 0, Ty.ptr);
  const len = b.extractvalue(vec, 1, Ty.i64);
  const elemTyStr = ctx.llvmType(expr.elementType);
  const elemTy = Ty.of(elemTyStr);
  const isFloat = expr.elementType.tag === "float";
  const accAddr = b.entryAlloca(`%__sum_acc.${ctx.scopeCounter++}.addr`, elemTy);
  b.store(val(isFloat ? "0.0" : "0", elemTy), accAddr);
  const idxAddr = b.entryAlloca(`%__sum_idx.${ctx.scopeCounter++}.addr`, Ty.i64);
  b.store(I64_0, idxAddr);

  const condL = b.newBlock("sum.cond");
  const bodyL = b.newBlock("sum.body");
  const endL = b.newBlock("sum.end");
  b.br(condL);
  b.position(condL);
  const idx = b.load(Ty.i64, idxAddr);
  const cmp = b.icmp("ult", idx, len);
  b.condBr(cmp, bodyL, endL);
  b.position(bodyL);
  const elemPtr = b.gep(elemTy, data, [idx]);
  const elem = b.load(elemTy, elemPtr);
  const acc = b.load(elemTy, accAddr);
  let newAcc: Val;
  if (!isFloat && ctx.trapOnOverflow && !ctx.currentFnWrapping) {
    newAcc = val(ctx.emitCheckedArith(lines, "add", ctx.isUnsigned(expr.elementType), elemTyStr, acc.ref, elem.ref, expr.span), elemTy);
  } else {
    newAcc = b.binop(isFloat ? "fadd" : "add", acc, elem);
  }
  b.store(newAcc, accAddr);
  const nextIdx = b.binop("add", idx, I64_1);
  b.store(nextIdx, idxAddr);
  b.br(condL);
  b.position(endL);
  const result = b.load(elemTy, accAddr);
  // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.vec);
  return [lines, result.ref, elemTyStr];
}

// v.retain(pred): one pass, compacting keepers toward the front and dropping the
// rest where they sit. No second buffer — that is the whole point next to filter.
export function genVecRetain(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecRetain" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTyStr = ctx.llvmType(expr.elementType);
  const elemTy = Ty.of(elemTyStr);
  const [vecLines, vecPtrRef] = ctx.genLValue(expr.object);
  lines.push(...vecLines);
  const [cl, cv] = ctx.genExpr(expr.callback);
  lines.push(...cl);
  const b = new LlvmTextBuilder(lines, ctx);
  const vecPtr = val(vecPtrRef, Ty.ptr);
  const closure = val(cv, Ty.of("{ ptr, ptr }"));
  const fnPtr = b.extractvalue(closure, 0, Ty.ptr);
  const envPtr = b.extractvalue(closure, 1, Ty.ptr);

  const vecTy = Ty.of("%Vec");
  const dataFieldPtr = b.gep(vecTy, vecPtr, [val("0", Ty.i32), val("0", Ty.i32)]);
  const data = b.load(Ty.ptr, dataFieldPtr);
  const lenPtr = b.gep(vecTy, vecPtr, [val("0", Ty.i32), val("1", Ty.i32)]);
  const len = b.load(Ty.i64, lenPtr);

  const iAddr = b.alloca(Ty.i64);
  b.store(I64_0, iAddr);
  const keptAddr = b.alloca(Ty.i64);
  b.store(I64_0, keptAddr);

  const cond = b.newBlock("vecret.cond");
  const body = b.newBlock("vecret.body");
  const keep = b.newBlock("vecret.keep");
  const dropIt = b.newBlock("vecret.drop");
  const step = b.newBlock("vecret.step");
  const end = b.newBlock("vecret.end");
  b.br(cond);
  b.position(cond);
  const i = b.load(Ty.i64, iAddr);
  const more = b.icmp("ult", i, len);
  b.condBr(more, body, end);
  b.position(body);
  const elemPtr = b.gep(elemTy, data, [i]);
  // hit's temp is drawn before callbackElemArg's own load temp, as before.
  const hit = b.reserveTemp(Ty.i1);
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr.ref, elemTyStr);
  b.call(Ty.i1, fnPtr.ref, [envPtr, val(cbArg.arg, Ty.of(cbArg.argTy))], hit);
  b.condBr(hit, keep, dropIt);
  b.position(keep);
  const kept = b.load(Ty.i64, keptAddr);
  const dstSlot = b.gep(elemTy, data, [kept]);
  const elemVal = b.load(elemTy, elemPtr);
  b.store(elemVal, dstSlot);
  const keptNext = b.binop("add", kept, I64_1);
  b.store(keptNext, keptAddr);
  b.br(step);
  b.position(dropIt);
  if (ctx.needsDropCg(expr.elementType)) {
    ctx.emitDropValue(lines, elemPtr.ref, expr.elementType);
  }
  b.br(step);
  b.position(step);
  const iCur = b.load(Ty.i64, iAddr);
  const iNext = b.binop("add", iCur, I64_1);
  b.store(iNext, iAddr);
  b.br(cond);
  b.position(end);
  const finalLen = b.load(Ty.i64, keptAddr);
  b.store(finalLen, lenPtr);
  return [lines, "0", "void"];
}
