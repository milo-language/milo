// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this — they are not part of its external API.
interface CodegenCtx {
  nextTemp(): string;
  nextLabel(prefix: string): string;
  llvmType(t: TypeKind): string;
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: any): [string[], string, string];
  genLValue(expr: any): [string[], string, string];
  genStringCmp(lines: string[], lv: string, rv: string, isEq: boolean): [string[], string, string];
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
  const elemTy = ctx.llvmType(elementType);

  const [vecPtrLines, vecPtr] = ctx.genLValue(object);
  lines.push(...vecPtrLines);

  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

  const tmpAddr = `%__${prefix}_tmp.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${tmpAddr} = alloca ${elemTy}`);
  const iAddr = `%__${prefix}_i.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 1, ptr ${iAddr}`);
  const jAddr = `%__${prefix}_j.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${jAddr} = alloca i64`);

  return { data, len, elemTy, elemSize, tmpAddr, iAddr, jAddr };
}

// shared insertion sort loop structure — calls emitCompare to get the gt condition
function insertionSortLoop(
  ctx: CodegenCtx,
  lines: string[],
  p: ReturnType<typeof sortPreamble>,
  prefix: string,
  emitCompare: (prevPtr: string, tmpAddr: string) => string,
) {
  const { data, len, elemTy, elemSize, tmpAddr, iAddr, jAddr } = p;
  const outerCond = ctx.nextLabel(`${prefix}.outer.cond`);
  const outerBody = ctx.nextLabel(`${prefix}.outer.body`);
  const innerCond = ctx.nextLabel(`${prefix}.inner.cond`);
  const innerBody = ctx.nextLabel(`${prefix}.inner.body`);
  const innerEnd = ctx.nextLabel(`${prefix}.inner.end`);
  const outerEnd = ctx.nextLabel(`${prefix}.outer.end`);

  lines.push(`  br label %${outerCond}`);
  lines.push(`${outerCond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const iCmp = ctx.nextTemp();
  lines.push(`  ${iCmp} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${iCmp}, label %${outerBody}, label %${outerEnd}`);

  lines.push(`${outerBody}:`);
  const iPtr = ctx.nextTemp();
  lines.push(`  ${iPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${iPtr}, i64 ${elemSize}, i1 false)`);
  lines.push(`  store i64 ${i}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  lines.push(`${innerCond}:`);
  const j = ctx.nextTemp();
  lines.push(`  ${j} = load i64, ptr ${jAddr}`);
  const jGtZero = ctx.nextTemp();
  lines.push(`  ${jGtZero} = icmp ugt i64 ${j}, 0`);
  const checkCmp = ctx.nextLabel(`${prefix}.checkcmp`);
  lines.push(`  br i1 ${jGtZero}, label %${checkCmp}, label %${innerEnd}`);

  lines.push(`${checkCmp}:`);
  const jm1 = ctx.nextTemp();
  lines.push(`  ${jm1} = sub i64 ${j}, 1`);
  const prevPtr = ctx.nextTemp();
  lines.push(`  ${prevPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jm1}`);

  const gtResult = emitCompare(prevPtr, tmpAddr);

  lines.push(`  br i1 ${gtResult}, label %${innerBody}, label %${innerEnd}`);

  lines.push(`${innerBody}:`);
  const jPtr = ctx.nextTemp();
  lines.push(`  ${jPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${j}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${jPtr}, ptr ${prevPtr}, i64 ${elemSize}, i1 false)`);
  const jNext = ctx.nextTemp();
  lines.push(`  ${jNext} = sub i64 ${j}, 1`);
  lines.push(`  store i64 ${jNext}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  lines.push(`${innerEnd}:`);
  const jFinal = ctx.nextTemp();
  lines.push(`  ${jFinal} = load i64, ptr ${jAddr}`);
  const destPtr = ctx.nextTemp();
  lines.push(`  ${destPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jFinal}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${destPtr}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${i}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${outerCond}`);

  lines.push(`${outerEnd}:`);
}

// built-in > comparison for a known comparable type
function emitBuiltinGt(ctx: CodegenCtx, lines: string[], keyType: TypeKind, keyTy: string, aVal: string, bVal: string): string {
  if (keyType.tag === "string") {
    ctx.needsMemcmp = true;
    const pData = ctx.nextTemp();
    lines.push(`  ${pData} = extractvalue %String ${aVal}, 0`);
    const pLen = ctx.nextTemp();
    lines.push(`  ${pLen} = extractvalue %String ${aVal}, 1`);
    const tData = ctx.nextTemp();
    lines.push(`  ${tData} = extractvalue %String ${bVal}, 0`);
    const tLen = ctx.nextTemp();
    lines.push(`  ${tLen} = extractvalue %String ${bVal}, 1`);
    const minLen = ctx.nextTemp();
    const lenCmp = ctx.nextTemp();
    lines.push(`  ${lenCmp} = icmp ult i64 ${pLen}, ${tLen}`);
    lines.push(`  ${minLen} = select i1 ${lenCmp}, i64 ${pLen}, i64 ${tLen}`);
    const memcmpResult = ctx.nextTemp();
    lines.push(`  ${memcmpResult} = call i32 @memcmp(ptr ${pData}, ptr ${tData}, i64 ${minLen})`);
    const memcmpNonZero = ctx.nextTemp();
    lines.push(`  ${memcmpNonZero} = icmp ne i32 ${memcmpResult}, 0`);
    const cmpByData = ctx.nextTemp();
    lines.push(`  ${cmpByData} = icmp sgt i32 ${memcmpResult}, 0`);
    const cmpByLen = ctx.nextTemp();
    lines.push(`  ${cmpByLen} = icmp ugt i64 ${pLen}, ${tLen}`);
    const result = ctx.nextTemp();
    lines.push(`  ${result} = select i1 ${memcmpNonZero}, i1 ${cmpByData}, i1 ${cmpByLen}`);
    return result;
  } else if (keyType.tag === "float") {
    const result = ctx.nextTemp();
    lines.push(`  ${result} = fcmp ogt ${keyTy} ${aVal}, ${bVal}`);
    return result;
  } else {
    const result = ctx.nextTemp();
    const cmpOp = keyType.tag === "int" && keyType.signed ? "sgt" : "ugt";
    lines.push(`  ${result} = icmp ${cmpOp} ${keyTy} ${aVal}, ${bVal}`);
    return result;
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
    const prevVal = ctx.nextTemp();
    lines.push(`  ${prevVal} = load ${elemTy}, ptr ${prevPtr}`);
    const tmpVal = ctx.nextTemp();
    lines.push(`  ${tmpVal} = load ${elemTy}, ptr ${tmpAddr}`);
    return emitBuiltinGt(ctx, lines, elementType, elemTy, prevVal, tmpVal);
  });

  return [lines, "void", "void"];
}

export function genVecSortBy(
  ctx: CodegenCtx,
  object: any,
  callback: any,
  elementType: TypeKind,
  lines: string[],
): [string[], string, string] {
  const p = sortPreamble(ctx, object, elementType, lines, "sortby");

  const [cl, cv] = ctx.genExpr(callback);
  lines.push(...cl);
  const fnPtr = ctx.nextTemp();
  lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
  const envPtr = ctx.nextTemp();
  lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

  insertionSortLoop(ctx, lines, p, "sortby", (prevPtr, tmpAddr) => {
    const cmpResult = ctx.nextTemp();
    lines.push(`  ${cmpResult} = call i32 ${fnPtr}(ptr ${envPtr}, ptr ${prevPtr}, ptr ${tmpAddr})`);
    const shouldSwap = ctx.nextTemp();
    lines.push(`  ${shouldSwap} = icmp sgt i32 ${cmpResult}, 0`);
    return shouldSwap;
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
  const keyTy = ctx.llvmType(keyType);

  const [cl, cv] = ctx.genExpr(callback);
  lines.push(...cl);
  const fnPtr = ctx.nextTemp();
  lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
  const envPtr = ctx.nextTemp();
  lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

  // cache the key for the element being inserted so we don't re-extract each inner iteration
  const tmpKeyAddr = `%__sortkey_tmpkey.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${tmpKeyAddr} = alloca ${keyTy}`);

  // hook into the outer body to extract tmpKey after memcpy
  const origInsertionLoop = insertionSortLoop;
  // Instead of using the shared loop (which doesn't have a hook point after outer body setup),
  // we need to inline the loop here to inject the key extraction.

  const { data, len, elemTy, elemSize, tmpAddr, iAddr, jAddr } = p;
  const outerCond = ctx.nextLabel("sortkey.outer.cond");
  const outerBody = ctx.nextLabel("sortkey.outer.body");
  const innerCond = ctx.nextLabel("sortkey.inner.cond");
  const innerBody = ctx.nextLabel("sortkey.inner.body");
  const innerEnd = ctx.nextLabel("sortkey.inner.end");
  const outerEnd = ctx.nextLabel("sortkey.outer.end");

  lines.push(`  br label %${outerCond}`);
  lines.push(`${outerCond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const iCmp = ctx.nextTemp();
  lines.push(`  ${iCmp} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${iCmp}, label %${outerBody}, label %${outerEnd}`);

  lines.push(`${outerBody}:`);
  const iPtr = ctx.nextTemp();
  lines.push(`  ${iPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${iPtr}, i64 ${elemSize}, i1 false)`);
  // extract key for the element being inserted — only once per outer iteration
  const tmpKey = ctx.nextTemp();
  lines.push(`  ${tmpKey} = call ${keyTy} ${fnPtr}(ptr ${envPtr}, ptr ${tmpAddr})`);
  lines.push(`  store ${keyTy} ${tmpKey}, ptr ${tmpKeyAddr}`);
  lines.push(`  store i64 ${i}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  lines.push(`${innerCond}:`);
  const j = ctx.nextTemp();
  lines.push(`  ${j} = load i64, ptr ${jAddr}`);
  const jGtZero = ctx.nextTemp();
  lines.push(`  ${jGtZero} = icmp ugt i64 ${j}, 0`);
  const checkCmp = ctx.nextLabel("sortkey.checkcmp");
  lines.push(`  br i1 ${jGtZero}, label %${checkCmp}, label %${innerEnd}`);

  lines.push(`${checkCmp}:`);
  const jm1 = ctx.nextTemp();
  lines.push(`  ${jm1} = sub i64 ${j}, 1`);
  const prevPtr = ctx.nextTemp();
  lines.push(`  ${prevPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jm1}`);
  const prevKey = ctx.nextTemp();
  lines.push(`  ${prevKey} = call ${keyTy} ${fnPtr}(ptr ${envPtr}, ptr ${prevPtr})`);
  const curTmpKey = ctx.nextTemp();
  lines.push(`  ${curTmpKey} = load ${keyTy}, ptr ${tmpKeyAddr}`);

  const gtResult = emitBuiltinGt(ctx, lines, keyType, keyTy, prevKey, curTmpKey);

  lines.push(`  br i1 ${gtResult}, label %${innerBody}, label %${innerEnd}`);

  lines.push(`${innerBody}:`);
  const jPtr = ctx.nextTemp();
  lines.push(`  ${jPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${j}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${jPtr}, ptr ${prevPtr}, i64 ${elemSize}, i1 false)`);
  const jNext = ctx.nextTemp();
  lines.push(`  ${jNext} = sub i64 ${j}, 1`);
  lines.push(`  store i64 ${jNext}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  lines.push(`${innerEnd}:`);
  const jFinal = ctx.nextTemp();
  lines.push(`  ${jFinal} = load i64, ptr ${jAddr}`);
  const destPtr = ctx.nextTemp();
  lines.push(`  ${destPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jFinal}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${destPtr}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${i}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${outerCond}`);

  lines.push(`${outerEnd}:`);
  return [lines, "void", "void"];
}
