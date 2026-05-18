// Vec method codegen helpers — extracted to keep codegen.ts manageable.

import type { TypeKind } from "./types";

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

export function genVecSort(
  ctx: CodegenCtx,
  object: any,
  elementType: TypeKind,
  lines: string[],
): [string[], string, string] {
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

  // insertion sort: for i in 1..len, shift arr[i] left until sorted
  const tmpAddr = `%__sort_tmp.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${tmpAddr} = alloca ${elemTy}`);

  const iAddr = `%__sort_i.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 1, ptr ${iAddr}`);

  const jAddr = `%__sort_j.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${jAddr} = alloca i64`);

  const outerCond = ctx.nextLabel("sort.outer.cond");
  const outerBody = ctx.nextLabel("sort.outer.body");
  const innerCond = ctx.nextLabel("sort.inner.cond");
  const innerBody = ctx.nextLabel("sort.inner.body");
  const innerEnd = ctx.nextLabel("sort.inner.end");
  const outerEnd = ctx.nextLabel("sort.outer.end");

  // outer loop: i = 1; i < len
  lines.push(`  br label %${outerCond}`);
  lines.push(`${outerCond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const iCmp = ctx.nextTemp();
  lines.push(`  ${iCmp} = icmp ult i64 ${i}, ${len}`);
  lines.push(`  br i1 ${iCmp}, label %${outerBody}, label %${outerEnd}`);

  lines.push(`${outerBody}:`);
  // tmp = arr[i]
  const iPtr = ctx.nextTemp();
  lines.push(`  ${iPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${iPtr}, i64 ${elemSize}, i1 false)`);
  // j = i
  lines.push(`  store i64 ${i}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  // inner loop: while j > 0 && arr[j-1] > tmp
  lines.push(`${innerCond}:`);
  const j = ctx.nextTemp();
  lines.push(`  ${j} = load i64, ptr ${jAddr}`);
  const jGtZero = ctx.nextTemp();
  lines.push(`  ${jGtZero} = icmp ugt i64 ${j}, 0`);
  const checkCmp = ctx.nextLabel("sort.checkcmp");
  lines.push(`  br i1 ${jGtZero}, label %${checkCmp}, label %${innerEnd}`);

  lines.push(`${checkCmp}:`);
  const jm1 = ctx.nextTemp();
  lines.push(`  ${jm1} = sub i64 ${j}, 1`);
  const prevPtr = ctx.nextTemp();
  lines.push(`  ${prevPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jm1}`);

  // compare arr[j-1] > tmp
  let gtResult: string;
  if (elementType.tag === "string") {
    ctx.needsMemcmp = true;
    const prevVal = ctx.nextTemp();
    lines.push(`  ${prevVal} = load %String, ptr ${prevPtr}`);
    const tmpVal = ctx.nextTemp();
    lines.push(`  ${tmpVal} = load %String, ptr ${tmpAddr}`);
    // compare lengths first, then data (lexicographic)
    const pData = ctx.nextTemp();
    lines.push(`  ${pData} = extractvalue %String ${prevVal}, 0`);
    const pLen = ctx.nextTemp();
    lines.push(`  ${pLen} = extractvalue %String ${prevVal}, 1`);
    const tData = ctx.nextTemp();
    lines.push(`  ${tData} = extractvalue %String ${tmpVal}, 0`);
    const tLen = ctx.nextTemp();
    lines.push(`  ${tLen} = extractvalue %String ${tmpVal}, 1`);
    const minLen = ctx.nextTemp();
    const lenCmp = ctx.nextTemp();
    lines.push(`  ${lenCmp} = icmp ult i64 ${pLen}, ${tLen}`);
    lines.push(`  ${minLen} = select i1 ${lenCmp}, i64 ${pLen}, i64 ${tLen}`);
    const memcmpResult = ctx.nextTemp();
    lines.push(`  ${memcmpResult} = call i32 @memcmp(ptr ${pData}, ptr ${tData}, i64 ${minLen})`);
    // if memcmp != 0, use that; else compare lengths
    const memcmpNonZero = ctx.nextTemp();
    lines.push(`  ${memcmpNonZero} = icmp ne i32 ${memcmpResult}, 0`);
    const cmpByData = ctx.nextTemp();
    lines.push(`  ${cmpByData} = icmp sgt i32 ${memcmpResult}, 0`);
    const cmpByLen = ctx.nextTemp();
    lines.push(`  ${cmpByLen} = icmp ugt i64 ${pLen}, ${tLen}`);
    gtResult = ctx.nextTemp();
    lines.push(`  ${gtResult} = select i1 ${memcmpNonZero}, i1 ${cmpByData}, i1 ${cmpByLen}`);
  } else if (elementType.tag === "float") {
    const prevVal = ctx.nextTemp();
    lines.push(`  ${prevVal} = load ${elemTy}, ptr ${prevPtr}`);
    const tmpVal = ctx.nextTemp();
    lines.push(`  ${tmpVal} = load ${elemTy}, ptr ${tmpAddr}`);
    gtResult = ctx.nextTemp();
    lines.push(`  ${gtResult} = fcmp ogt ${elemTy} ${prevVal}, ${tmpVal}`);
  } else {
    const prevVal = ctx.nextTemp();
    lines.push(`  ${prevVal} = load ${elemTy}, ptr ${prevPtr}`);
    const tmpVal = ctx.nextTemp();
    lines.push(`  ${tmpVal} = load ${elemTy}, ptr ${tmpAddr}`);
    gtResult = ctx.nextTemp();
    const cmpOp = elementType.tag === "int" && elementType.signed ? "sgt" : "ugt";
    lines.push(`  ${gtResult} = icmp ${cmpOp} ${elemTy} ${prevVal}, ${tmpVal}`);
  }

  lines.push(`  br i1 ${gtResult}, label %${innerBody}, label %${innerEnd}`);

  lines.push(`${innerBody}:`);
  // arr[j] = arr[j-1]
  const jPtr = ctx.nextTemp();
  lines.push(`  ${jPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${j}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${jPtr}, ptr ${prevPtr}, i64 ${elemSize}, i1 false)`);
  const jNext = ctx.nextTemp();
  lines.push(`  ${jNext} = sub i64 ${j}, 1`);
  lines.push(`  store i64 ${jNext}, ptr ${jAddr}`);
  lines.push(`  br label %${innerCond}`);

  lines.push(`${innerEnd}:`);
  // arr[j] = tmp
  const jFinal = ctx.nextTemp();
  lines.push(`  ${jFinal} = load i64, ptr ${jAddr}`);
  const destPtr = ctx.nextTemp();
  lines.push(`  ${destPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${jFinal}`);
  lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${destPtr}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);
  // i++
  const iNext = ctx.nextTemp();
  lines.push(`  ${iNext} = add i64 ${i}, 1`);
  lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
  lines.push(`  br label %${outerCond}`);

  lines.push(`${outerEnd}:`);
  return [lines, "void", "void"];
}
