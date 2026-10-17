// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";
import type { Gen } from "./codegen";
import type { Span } from "./ast";
import type { HIRExpr } from "./hir";
import type { OwnLedger } from "./codegen-own";
import type { EnumLayout, EnumVariant } from "./codegen";
import { genStringCmp, genStringOrd, type StringCtx } from "./codegen-string";
import { LlvmTextBuilder, Ty, val, type Val } from "./ir";

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
  own: OwnLedger;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  callbackElemArg(lines: string[], cbType: TypeKind, elemPtr: string, elemTy: string, paramIdx?: number): { arg: string; argTy: string };
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
  enumLayouts: Map<string, EnumLayout>;
  storeEnumTag(lines: string[], enumTy: string, addr: string, tag: number | string): void;
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

// Same as genVecMethodPreamble but hands back typed values for builder-based callers.
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

// shared helper: extract closure fn/env and vec data/len for functional methods
// `release` frees a temporary receiver (`mk().any(f)`, `a.filter(f).map(g)`) and must run
// after the loop: every combinator reads elements in place or deep-clones them out, so
// once it has finished nothing points into the receiver and nothing else will free it.
// String-valued for the callers still in codegen.ts.
export function genVecMethodPreamble(ctx: CodegenCtx, vecExpr: HIRExpr, cbExpr: HIRExpr, elemType: TypeKind, lines: string[]): {
  fnPtr: string; envPtr: string; data: string; len: string; elemTy: string; release: () => void;
} {
  const p = vecPreamble(ctx, vecExpr, cbExpr, elemType, lines);
  return { fnPtr: p.fnPtr.ref, envPtr: p.envPtr.ref, data: p.data.ref, len: p.len.ref, elemTy: p.elemTy.ll, release: p.release };
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
