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
  const elemTy = ctx.llvmType(vecType.element);

  const enumTy = `%${expr.optionEnumName}`;
  const enumLayout = ctx.enumLayouts.get(expr.optionEnumName);
  if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);
  const noneVariant = enumLayout.variants.get("None");
  const someVariant = enumLayout.variants.get("Some");
  if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const [vecPtrLines, vecPtr] = ctx.genLValue(expr.vec);
  lines.push(...vecPtrLines);

  // load len
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

  // result Option, defaulted to None
  const resultAddr = `%__pop_result.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
  lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
  ctx.storeEnumTag(lines, enumTy, resultAddr, noneVariant.tag);

  const isEmpty = ctx.nextTemp();
  lines.push(`  ${isEmpty} = icmp eq i64 ${len}, 0`);
  const someLabel = ctx.nextLabel("vec.pop.some");
  const endLabel = ctx.nextLabel("vec.pop.end");
  lines.push(`  br i1 ${isEmpty}, label %${endLabel}, label %${someLabel}`);

  // some: len--, move value out of data[new_len] into Some payload
  lines.push(`${someLabel}:`);
  const newLen = ctx.nextTemp();
  lines.push(`  ${newLen} = sub i64 ${len}, 1`);
  lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${newLen}`);
  const val = ctx.nextTemp();
  lines.push(`  ${val} = load ${elemTy}, ptr ${elemPtr}`);

  ctx.storeEnumTag(lines, enumTy, resultAddr, someVariant.tag);
  const payloadPtr = ctx.enumPayloadPtr(lines, enumTy, resultAddr, someVariant);
  lines.push(`  store ${elemTy} ${val}, ptr ${payloadPtr}`);
  lines.push(`  br label %${endLabel}`);

  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
  return [lines, result, enumTy];
}

export function genVecFind(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFind" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const enumTy = `%${expr.optionEnumName}`;
  const enumLayout = ctx.enumLayouts.get(expr.optionEnumName);
  if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);

  const noneVariant = enumLayout.variants.get("None");
  const someVariant = enumLayout.variants.get("Some");
  if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const resultAddr = `%__find_result.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
  lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
  ctx.storeEnumTag(lines, enumTy, resultAddr, noneVariant.tag);

  const idxAddr = `%__find_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("find.cond");
  const bodyLabel = ctx.nextLabel("find.body");
  const foundLabel = ctx.nextLabel("find.found");
  const nextLabel = ctx.nextLabel("find.next");
  const endLabel = ctx.nextLabel("find.end");

  lines.push(`  br label %${condLabel}`);
  lines.push(`${condLabel}:`);
  const idx = ctx.nextTemp();
  lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
  const cmp = ctx.nextTemp();
  lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
  lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);

  lines.push(`${bodyLabel}:`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx}`);
  const match = ctx.nextTemp();
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
  lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
  lines.push(`  br i1 ${match}, label %${foundLabel}, label %${nextLabel}`);

  lines.push(`${foundLabel}:`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
  ctx.storeEnumTag(lines, enumTy, resultAddr, someVariant.tag);
  const payloadPtr = ctx.enumPayloadPtr(lines, enumTy, resultAddr, someVariant);
  lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
  lines.push(`  br label %${endLabel}`);

  lines.push(`${nextLabel}:`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);

  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
  release();
  return [lines, result, enumTy];
}

// Set up an `alloca Option<…>` pre-filled with None; callers branch to a "some"
// block that overwrites the tag and payload. Shared by get/min/max/indexOf/position.
function optionResultSlot(ctx: CodegenCtx, optionEnumName: string, label: string, lines: string[]): {
  enumTy: string; addr: string; someTag: number;
} {
  const enumTy = `%${optionEnumName}`;
  const layout = ctx.enumLayouts.get(optionEnumName);
  if (!layout) throw new Error(`enum layout not found for ${optionEnumName}`);
  const none = layout.variants.get("None");
  const some = layout.variants.get("Some");
  if (!none || !some) throw new Error("Option enum missing Some/None variants");
  const addr = `%__${label}.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${addr} = alloca ${enumTy}`);
  lines.push(`  store ${enumTy} zeroinitializer, ptr ${addr}`);
  ctx.storeEnumTag(lines, enumTy, addr, none.tag);
  return { enumTy, addr, someTag: some.tag };
}

// v.get(i) / v.first() / v.last(): the total read. A negative index becomes a huge
// unsigned value, so the single `ult` test rejects both ends without a second compare.
export function genVecGetOpt(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecGetOpt" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = ctx.llvmType(expr.elementType);
  const [vl, vv] = ctx.genExpr(expr.object);
  lines.push(...vl);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
  const [il, iv] = ctx.genExpr(expr.index);
  lines.push(...il);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecget", lines);
  const inBounds = ctx.nextTemp();
  lines.push(`  ${inBounds} = icmp ult i64 ${iv}, ${len}`);
  const someLabel = ctx.nextLabel("vecget.some");
  const endLabel = ctx.nextLabel("vecget.end");
  lines.push(`  br i1 ${inBounds}, label %${someLabel}, label %${endLabel}`);
  lines.push(`${someLabel}:`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${iv}`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr, slot.someTag);
  const payloadPtr = ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr, slot.someTag);
  lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
  // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.object);
  return [lines, result, slot.enumTy];
}

// `a <op> b` for the comparable element types min/max/sort accept.
function emitElemOrd(ctx: CodegenCtx, lines: string[], elemType: TypeKind, a: string, b: string, wantGreater: boolean): string {
  const lt = ctx.llvmType(elemType);
  if (elemType.tag === "string") {
    const [, r] = genStringOrd(ctx, lines, a, b, wantGreater ? ">" : "<");
    return r;
  }
  const out = ctx.nextTemp();
  if (elemType.tag === "float") {
    lines.push(`  ${out} = fcmp ${wantGreater ? "ogt" : "olt"} ${lt} ${a}, ${b}`);
    return out;
  }
  // bool is i1: unsigned ordering makes false < true
  const signed = elemType.tag === "int" && elemType.signed;
  const pred = wantGreater ? (signed ? "sgt" : "ugt") : (signed ? "slt" : "ult");
  lines.push(`  ${out} = icmp ${pred} ${lt} ${a}, ${b}`);
  return out;
}

export function genVecMinMax(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecMinMax" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = ctx.llvmType(expr.elementType);
  const [vl, vv] = ctx.genExpr(expr.object);
  lines.push(...vl);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecminmax", lines);
  const empty = ctx.nextTemp();
  lines.push(`  ${empty} = icmp eq i64 ${len}, 0`);
  const scanLabel = ctx.nextLabel("vecmm.scan");
  const endLabel = ctx.nextLabel("vecmm.end");
  lines.push(`  br i1 ${empty}, label %${endLabel}, label %${scanLabel}`);
  lines.push(`${scanLabel}:`);

  // Track the winning index, not the value: a String winner is cloned once, at
  // the end, instead of on every improvement.
  const bestAddr = ctx.nextTemp();
  lines.push(`  ${bestAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${bestAddr}`);
  const iAddr = ctx.nextTemp();
  lines.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 1, ptr ${iAddr}`);
  const cond = ctx.nextLabel("vecmm.cond");
  const body = ctx.nextLabel("vecmm.body");
  const better = ctx.nextLabel("vecmm.better");
  const step = ctx.nextLabel("vecmm.step");
  const done = ctx.nextLabel("vecmm.done");
  lines.push(`  br label %${cond}`);
  lines.push(`${cond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const more = ctx.nextTemp();
  lines.push(`  ${more} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${more}, label %${body}, label %${done}`);
  lines.push(`${body}:`);
  const curPtr = ctx.nextTemp();
  lines.push(`  ${curPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  const cur = ctx.nextTemp();
  lines.push(`  ${cur} = load ${elemTy}, ptr ${curPtr}`);
  const bestIdx = ctx.nextTemp();
  lines.push(`  ${bestIdx} = load i64, ptr ${bestAddr}`);
  const bestPtr = ctx.nextTemp();
  lines.push(`  ${bestPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${bestIdx}`);
  const best = ctx.nextTemp();
  lines.push(`  ${best} = load ${elemTy}, ptr ${bestPtr}`);
  const wins = emitElemOrd(ctx, lines, expr.elementType, cur, best, expr.isMax);
  const winsLabel = ctx.nextLabel("vecmm.cmpdone");
  lines.push(`  br label %${winsLabel}`);
  lines.push(`${winsLabel}:`);
  lines.push(`  br i1 ${wins}, label %${better}, label %${step}`);
  lines.push(`${better}:`);
  const iNow = ctx.nextTemp();
  lines.push(`  ${iNow} = load i64, ptr ${iAddr}`);
  lines.push(`  store i64 ${iNow}, ptr ${bestAddr}`);
  lines.push(`  br label %${step}`);
  lines.push(`${step}:`);
  const iCur = ctx.nextTemp();
  lines.push(`  ${iCur} = load i64, ptr ${iAddr}`);
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${iCur}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${cond}`);
  lines.push(`${done}:`);
  const winIdx = ctx.nextTemp();
  lines.push(`  ${winIdx} = load i64, ptr ${bestAddr}`);
  const winPtr = ctx.nextTemp();
  lines.push(`  ${winPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${winIdx}`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, winPtr, expr.elementType);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr, slot.someTag);
  const payloadPtr = ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr, slot.someTag);
  lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
  // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.object);
  return [lines, result, slot.enumTy];
}

export function genVecIndexOf(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecIndexOf" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  const elemTy = ctx.llvmType(expr.elementType);
  const [vl, vv] = ctx.genExpr(expr.vec);
  lines.push(...vl);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
  const [nl, nv] = ctx.genExpr(expr.value);
  lines.push(...nl);

  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecidx", lines);
  const iAddr = ctx.nextTemp();
  lines.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${iAddr}`);
  const cond = ctx.nextLabel("vecidx.cond");
  const body = ctx.nextLabel("vecidx.body");
  const found = ctx.nextLabel("vecidx.found");
  const step = ctx.nextLabel("vecidx.step");
  const end = ctx.nextLabel("vecidx.end");
  lines.push(`  br label %${cond}`);
  lines.push(`${cond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const more = ctx.nextTemp();
  lines.push(`  ${more} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${more}, label %${body}, label %${end}`);
  lines.push(`${body}:`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  const elemVal = ctx.nextTemp();
  lines.push(`  ${elemVal} = load ${elemTy}, ptr ${elemPtr}`);
  let eq: string;
  if (expr.elementType.tag === "string") {
    const [, r] = genStringCmp(ctx, lines, elemVal, nv, true);
    eq = r;
  } else {
    eq = ctx.nextTemp();
    lines.push(`  ${eq} = ${expr.elementType.tag === "float" ? "fcmp oeq" : "icmp eq"} ${elemTy} ${elemVal}, ${nv}`);
  }
  // the string compare above may have opened blocks; land in a fresh one so the
  // index load below is reachable from a single predecessor
  const testLabel = ctx.nextLabel("vecidx.test");
  lines.push(`  br label %${testLabel}`);
  lines.push(`${testLabel}:`);
  lines.push(`  br i1 ${eq}, label %${found}, label %${step}`);
  lines.push(`${found}:`);
  const hitIdx = ctx.nextTemp();
  lines.push(`  ${hitIdx} = load i64, ptr ${iAddr}`);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr, slot.someTag);
  const payloadPtr = ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr, slot.someTag);
  lines.push(`  store i64 ${hitIdx}, ptr ${payloadPtr}`);
  lines.push(`  br label %${end}`);
  lines.push(`${step}:`);
  const iCur = ctx.nextTemp();
  lines.push(`  ${iCur} = load i64, ptr ${iAddr}`);
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${iCur}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${cond}`);
  lines.push(`${end}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
  // Same as the map lookups: the needle is the caller's, and a read-only search takes
  // no ownership of it. `v.contains("s" + i.toString())` leaked the needle per call.
  ctx.dropOwnedTemp(lines, nv, elemTy, expr.value);
  // …and the receiver, when that is a temporary: `mkVec().contains(x)` leaked the whole
  // container. A search keeps no pointer into it once the answer is a scalar.
  ctx.dropOwnedTemp(lines, vv, "%Vec", expr.vec);
  return [lines, result, slot.enumTy];
}

export function genVecPosition(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecPosition" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const slot = optionResultSlot(ctx, expr.optionEnumName, "vecpos", lines);
  const iAddr = ctx.nextTemp();
  lines.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${iAddr}`);
  const cond = ctx.nextLabel("vecpos.cond");
  const body = ctx.nextLabel("vecpos.body");
  const found = ctx.nextLabel("vecpos.found");
  const step = ctx.nextLabel("vecpos.step");
  const end = ctx.nextLabel("vecpos.end");
  lines.push(`  br label %${cond}`);
  lines.push(`${cond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const more = ctx.nextTemp();
  lines.push(`  ${more} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${more}, label %${body}, label %${end}`);
  lines.push(`${body}:`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  const hit = ctx.nextTemp();
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
  lines.push(`  ${hit} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
  lines.push(`  br i1 ${hit}, label %${found}, label %${step}`);
  lines.push(`${found}:`);
  ctx.storeEnumTag(lines, slot.enumTy, slot.addr, slot.someTag);
  const payloadPtr = ctx.enumPayloadPtr(lines, slot.enumTy, slot.addr, slot.someTag);
  lines.push(`  store i64 ${i}, ptr ${payloadPtr}`);
  lines.push(`  br label %${end}`);
  lines.push(`${step}:`);
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${i}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${cond}`);
  lines.push(`${end}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
  release();
  return [lines, result, slot.enumTy];
}
