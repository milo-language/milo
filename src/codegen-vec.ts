// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";
import { LlvmTextBuilder, Ty, val, type Val, type NameSource } from "./ir";

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this — they are not part of its external API.
interface CodegenCtx extends NameSource {
  llvmType(t: TypeKind): string;
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: any): [string[], string, string];
  genLValue(expr: any): [string[], string, string];
  entryAllocas: string[];
  scopeCounter: number;
  hasVecType: boolean;
  needsMemcpy: boolean;
  needsMemcmp: boolean;
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
