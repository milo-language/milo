// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";
import type { Gen } from "./codegen";
import type { Span } from "./ast";
import type { HIRExpr } from "./hir";
import type { OwnLedger } from "./codegen-own";
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
  needsMalloc: boolean;
  own: OwnLedger;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  callbackElemArg(lines: string[], cbType: TypeKind, elemPtr: string, elemTy: string, paramIdx?: number): { arg: string; argTy: string };
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
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

// shared helper: extract closure fn/env and vec data/len for functional methods
// `release` frees a temporary receiver (`mk().any(f)`, `a.filter(f).map(g)`) and must run
// after the loop: every combinator reads elements in place or deep-clones them out, so
// once it has finished nothing points into the receiver and nothing else will free it.
export function genVecMethodPreamble(ctx: CodegenCtx, vecExpr: HIRExpr, cbExpr: HIRExpr, elemType: TypeKind, lines: string[]): {
  fnPtr: string; envPtr: string; data: string; len: string; elemTy: string; release: () => void;
} {
  ctx.hasVecType = true;
  const [vl, vv] = ctx.genExpr(vecExpr);
  lines.push(...vl);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
  const [cl, cv] = ctx.genExpr(cbExpr);
  lines.push(...cl);
  const fnPtr = ctx.nextTemp();
  lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
  const envPtr = ctx.nextTemp();
  lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);
  const release = () => ctx.dropOwnedTemp(lines, vv, "%Vec", vecExpr);
  return { fnPtr, envPtr, data, len, elemTy: ctx.llvmType(elemType), release };
}

export function genVecMap(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecMap" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const resultElemTy = ctx.llvmType(expr.resultElementType);
  const resultElemSize = ctx.typeSizeOf(expr.resultElementType);
  ctx.needsMalloc = true;

  // allocate result buffer: malloc(len * elemSize)
  const { buf } = ctx.emitAllocBytes(lines, len, resultElemSize, "vecmap", expr.span);

  const idxAddr = `%__map_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("map.cond");
  const bodyLabel = ctx.nextLabel("map.body");
  const endLabel = ctx.nextLabel("map.end");

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
  // check if callback takes element by value or by ref
  const cbType = expr.callback.type;
  const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
  let callArg: string;
  let callArgTy: string;
  if (paramIsRef) {
    callArg = elemPtr;
    callArgTy = "ptr";
  } else {
    const loadedElem = ctx.nextTemp();
    lines.push(`  ${loadedElem} = load ${elemTy}, ptr ${elemPtr}`);
    callArg = loadedElem;
    callArgTy = elemTy;
  }
  const result = ctx.nextTemp();
  lines.push(`  ${result} = call ${resultElemTy} ${fnPtr}(ptr ${envPtr}, ${callArgTy} ${callArg})`);
  const destPtr = ctx.nextTemp();
  lines.push(`  ${destPtr} = getelementptr ${resultElemTy}, ptr ${buf}, i64 ${idx}`);
  lines.push(`  store ${resultElemTy} ${result}, ptr ${destPtr}`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);
  lines.push(`${endLabel}:`);

  // build result Vec { buf, len, len }
  const v0 = ctx.nextTemp();
  lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
  const v1 = ctx.nextTemp();
  lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${len}, 1`);
  const v2 = ctx.nextTemp();
  lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
  release();
  return [lines, v2, "%Vec"];
}

export function genVecFilter(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFilter" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);
  const elemSize = ctx.typeSizeOf(expr.elementType);
  ctx.needsMalloc = true;

  // allocate result buffer with capacity = source len (worst case all match)
  const { buf } = ctx.emitAllocBytes(lines, len, elemSize, "vecfilt", expr.span);

  const idxAddr = `%__filter_idx.${ctx.scopeCounter++}.addr`;
  const outIdxAddr = `%__filter_out.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  ctx.entryAllocas.push(`  ${outIdxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);
  lines.push(`  store i64 0, ptr ${outIdxAddr}`);

  const condLabel = ctx.nextLabel("filter.cond");
  const bodyLabel = ctx.nextLabel("filter.body");
  const copyLabel = ctx.nextLabel("filter.copy");
  const nextLabel = ctx.nextLabel("filter.next");
  const endLabel = ctx.nextLabel("filter.end");

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
  const keep = ctx.nextTemp();
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
  lines.push(`  ${keep} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
  lines.push(`  br i1 ${keep}, label %${copyLabel}, label %${nextLabel}`);

  lines.push(`${copyLabel}:`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
  const outIdx = ctx.nextTemp();
  lines.push(`  ${outIdx} = load i64, ptr ${outIdxAddr}`);
  const destPtr = ctx.nextTemp();
  lines.push(`  ${destPtr} = getelementptr ${elemTy}, ptr ${buf}, i64 ${outIdx}`);
  lines.push(`  store ${elemTy} ${cloned}, ptr ${destPtr}`);
  const nextOut = ctx.nextTemp();
  lines.push(`  ${nextOut} = add i64 ${outIdx}, 1`);
  lines.push(`  store i64 ${nextOut}, ptr ${outIdxAddr}`);
  lines.push(`  br label %${nextLabel}`);

  lines.push(`${nextLabel}:`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);

  lines.push(`${endLabel}:`);
  const finalLen = ctx.nextTemp();
  lines.push(`  ${finalLen} = load i64, ptr ${outIdxAddr}`);
  const v0 = ctx.nextTemp();
  lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
  const v1 = ctx.nextTemp();
  lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${finalLen}, 1`);
  const v2 = ctx.nextTemp();
  lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
  release();
  return [lines, v2, "%Vec"];
}

export function genVecEach(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecEach" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const idxAddr = `%__each_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("each.cond");
  const bodyLabel = ctx.nextLabel("each.body");
  const endLabel = ctx.nextLabel("each.end");

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
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
  lines.push(`  call void ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);
  lines.push(`${endLabel}:`);
  release();
  return [lines, "void", "void"];
}

export function genVecAny(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecAny" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const resultAddr = `%__any_result.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${resultAddr} = alloca i1`);
  lines.push(`  store i1 false, ptr ${resultAddr}`);

  const idxAddr = `%__any_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("any.cond");
  const bodyLabel = ctx.nextLabel("any.body");
  const endLabel = ctx.nextLabel("any.end");

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
  const foundLabel = ctx.nextLabel("any.found");
  const nextLabel = ctx.nextLabel("any.next");
  lines.push(`  br i1 ${match}, label %${foundLabel}, label %${nextLabel}`);
  lines.push(`${foundLabel}:`);
  lines.push(`  store i1 true, ptr ${resultAddr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${nextLabel}:`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);
  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
  release();
  return [lines, result, "i1"];
}

export function genVecAll(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecAll" }, lines: string[]): Gen {
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const resultAddr = `%__all_result.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${resultAddr} = alloca i1`);
  lines.push(`  store i1 true, ptr ${resultAddr}`);

  const idxAddr = `%__all_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("all.cond");
  const bodyLabel = ctx.nextLabel("all.body");
  const endLabel = ctx.nextLabel("all.end");

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
  const failLabel = ctx.nextLabel("all.fail");
  const nextLabel = ctx.nextLabel("all.next");
  lines.push(`  br i1 ${match}, label %${nextLabel}, label %${failLabel}`);
  lines.push(`${failLabel}:`);
  lines.push(`  store i1 false, ptr ${resultAddr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${nextLabel}:`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);
  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
  release();
  return [lines, result, "i1"];
}

// acc = cb(acc, &elem) over every element. The accumulator lives in an alloca so
// the loop body can write it without a phi, matching how the other Vec callbacks
// carry state across iterations.
export function genVecFold(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecFold" }, lines: string[]): Gen {
  const [initLines, initVal, accTy] = ctx.genExpr(expr.init);
  lines.push(...initLines);
  const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(ctx, expr.vec, expr.callback, expr.elementType, lines);

  const accAddr = `%__fold_acc.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${accAddr} = alloca ${accTy}`);
  lines.push(`  store ${accTy} ${initVal}, ptr ${accAddr}`);
  ctx.own.endVal(lines, initVal, "MOVE");

  const idxAddr = `%__fold_idx.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${idxAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${idxAddr}`);

  const condLabel = ctx.nextLabel("fold.cond");
  const bodyLabel = ctx.nextLabel("fold.body");
  const endLabel = ctx.nextLabel("fold.end");

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
  const acc = ctx.nextTemp();
  lines.push(`  ${acc} = load ${accTy}, ptr ${accAddr}`);
  const next = ctx.nextTemp();
  const cbArg = ctx.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy, 1);
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
  lines.push(`  ${next} = call ${accTy} ${fnPtr}(ptr ${envPtr}, ${accTy} ${acc}, ${cbArg.argTy} ${cbArg.arg})`);
  lines.push(`  store ${accTy} ${next}, ptr ${accAddr}`);
  const nextIdx = ctx.nextTemp();
  lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
  lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
  lines.push(`  br label %${condLabel}`);

  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${accTy}, ptr ${accAddr}`);
  release();
  return [lines, result, accTy];
}

export function genVecReverse(ctx: CodegenCtx, expr: HIRExpr & { kind: "VecReverse" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.needsMemcpy = true;
  const elemType = expr.elementType;
  const elemSize = ctx.typeSizeOf(elemType);
  const elemTy = ctx.llvmType(elemType);

  const [vecPtrLines, vecPtr] = ctx.genLValue(expr.object);
  lines.push(...vecPtrLines);

  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

  const tmpAddr = `%__rev_tmp.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${tmpAddr} = alloca ${elemTy}`);

  const loAddr = `%__rev_lo.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${loAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${loAddr}`);
  const hiAddr = `%__rev_hi.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${hiAddr} = alloca i64`);
  const hiInit = ctx.nextTemp();
  lines.push(`  ${hiInit} = sub i64 ${len}, 1`);
  lines.push(`  store i64 ${hiInit}, ptr ${hiAddr}`);

  const condLabel = ctx.nextLabel("rev.cond");
  const bodyLabel = ctx.nextLabel("rev.body");
  const endLabel = ctx.nextLabel("rev.end");

  lines.push(`  br label %${condLabel}`);
  lines.push(`${condLabel}:`);
  const lo = ctx.nextTemp();
  lines.push(`  ${lo} = load i64, ptr ${loAddr}`);
  const hi = ctx.nextTemp();
  lines.push(`  ${hi} = load i64, ptr ${hiAddr}`);
  const cmp = ctx.nextTemp();
  lines.push(`  ${cmp} = icmp slt i64 ${lo}, ${hi}`);
  lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);

  lines.push(`${bodyLabel}:`);
  const loPtr = ctx.nextTemp();
  lines.push(`  ${loPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${lo}`);
  const hiPtr = ctx.nextTemp();
  lines.push(`  ${hiPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${hi}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${loPtr}, i64 ${elemSize}, i1 false)`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${loPtr}, ptr ${hiPtr}, i64 ${elemSize}, i1 false)`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${hiPtr}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);
  const nextLo = ctx.nextTemp();
  lines.push(`  ${nextLo} = add i64 ${lo}, 1`);
  lines.push(`  store i64 ${nextLo}, ptr ${loAddr}`);
  const nextHi = ctx.nextTemp();
  lines.push(`  ${nextHi} = sub i64 ${hi}, 1`);
  lines.push(`  store i64 ${nextHi}, ptr ${hiAddr}`);
  lines.push(`  br label %${condLabel}`);

  lines.push(`${endLabel}:`);
  return [lines, "void", "void"];
}
