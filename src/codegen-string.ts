// String method lowering (concat, compare, push, slice, substr, find, number/bool to string), extracted to keep codegen.ts manageable.

import type { HIRExpr, HIRArg } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { TargetInfo } from "./target";
import type { NameSource } from "./ir";
import type { Gen, EnumLayout, EnumVariant } from "./codegen";

// Scratch size for one formatted f64. Worst case at 17 significant digits is
// "-1.2345678901234567e-308" — 24 bytes plus the NUL.
export const F64_BUF = 32;

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this, they are not part of its external API.
interface CodegenCtx extends NameSource {
  genExpr(expr: HIRExpr, sretDest?: string): Gen;
  genLValue(expr: HIRExpr): Gen;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  cloneOfOwnedTemp(src: HIRExpr, lines: string[]): Gen | null;
  emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }): void;
  storeEnumTag(lines: string[], enumTy: string, addr: string, tag: number | string): void;
  enumPayloadPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number): string;
  emitStrAlloc(lines: string[], n: string, tag: string, span?: Span): string;
  emitStrShare(lines: string[], val: string): string;
  emitStrUnique(lines: string[], strPtr: string, srcs?: string[]): string[];
  strRt(): void;
  strReserveFn(): string;
  addString(value: string): { label: string; length: number };
  genBoundI64(bound: HIRExpr, lines: string[]): string;
  emitStringRangeCheck(lines: string[], startVal: string, endVal: string, strVal: string, what: string, span?: { line: number; col: number }): void;
  emitAppendFormatParts(lines: string[], strPtr: string, parts: { val: string; ty: string; tk: TypeKind }[], span?: Span): void;
  fastFormatPart(tk: TypeKind): "string" | "int" | "bool" | "float" | null;
  genFormatParts(args: HIRArg[], lines: string[]): { val: string; ty: string; expr: HIRExpr }[];
  emitIntFmt(lines: string[], dst: string, val: string, llvmTy: string, tk: TypeKind & { tag: "int" }): string;
  emitFloatToBuf(val: string, bits: number, lines: string[], asString?: boolean): { buf: string; len: string };
  emitAllocNullCheck(lines: string[], buf: string, tag: string, span?: Span): void;
  emitFdPrintf(lines: string[], fd: number, fmtLabel: string, argsStr: string): void;
  emitCheckFilePtr(lines: string[], span?: Span): string;
  panicAt(span?: Span): string;
  panicAbort(lines: string[]): void;
  entryAllocas: string[];
  enumLayouts: Map<string, EnumLayout>;
  scopeCounter: number;
  target: TargetInfo;
  hasStringType: boolean;
  needsMalloc: boolean;
  needsMemcpy: boolean;
  needsMemcmp: boolean;
  needsBoundsCheck: boolean;
}

export function genStringWithCapacity(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringWithCapacity" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  const [capLines, capVal] = ctx.genExpr(expr.capacity);
  lines.push(...capLines);
  ctx.emitNonNegativeCheck(lines, capVal, "capacity", expr.span);
  // At least one byte. A String owns its buffer exactly when cap > 0 (cap 0 marks a
  // borrowed literal, which drop skips), and malloc(0) still hands back a live block:
  // `String.withCapacity(0)` was an owned buffer recorded as borrowed, leaked on drop,
  // and orphaned by the first push (which saw cap 0 and allocated afresh).
  const isZero = ctx.nextTemp();
  lines.push(`  ${isZero} = icmp eq i64 ${capVal}, 0`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = select i1 ${isZero}, i64 1, i64 ${capVal}`);
  const buf = ctx.emitStrAlloc(lines, cap, "strcap", expr.span);
  lines.push(`  store i8 0, ptr ${buf}`);
  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %String ${s0}, i64 0, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${cap}, 2`);
  return [lines, s2, "%String"];
}

export function genStringConcat(ctx: CodegenCtx, lines: string[], lv: string, rv: string): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  const aData = ctx.nextTemp();
  lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
  const aLen = ctx.nextTemp();
  lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
  const bData = ctx.nextTemp();
  lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
  const bLen = ctx.nextTemp();
  lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
  const total = ctx.nextTemp();
  lines.push(`  ${total} = add i64 ${aLen}, ${bLen}`);
  // +1 for null terminator
  const allocSz = ctx.nextTemp();
  lines.push(`  ${allocSz} = add i64 ${total}, 1`);
  const buf = ctx.emitStrAlloc(lines, allocSz, "strcat");
  lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${aData}, i64 ${aLen})`);
  const dst = ctx.nextTemp();
  lines.push(`  ${dst} = getelementptr i8, ptr ${buf}, i64 ${aLen}`);
  lines.push(`  call ptr @memcpy(ptr ${dst}, ptr ${bData}, i64 ${bLen})`);
  // null terminate
  const nullPtr = ctx.nextTemp();
  lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${total}`);
  lines.push(`  store i8 0, ptr ${nullPtr}`);
  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${total}, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
  return [lines, s2, "%String"];
}

export function genStringCmp(ctx: CodegenCtx, lines: string[], lv: string, rv: string, isEq: boolean): Gen {
  ctx.needsMemcmp = true;
  const aLen = ctx.nextTemp();
  lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
  const bLen = ctx.nextTemp();
  lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
  const lenEq = ctx.nextTemp();
  lines.push(`  ${lenEq} = icmp eq i64 ${aLen}, ${bLen}`);
  const cmpDataLabel = ctx.nextLabel("str.cmpdata");
  const cmpFalseLabel = ctx.nextLabel("str.short");
  const cmpDoneLabel = ctx.nextLabel("str.done");
  lines.push(`  br i1 ${lenEq}, label %${cmpDataLabel}, label %${cmpFalseLabel}`);
  lines.push(`${cmpDataLabel}:`);
  const aData = ctx.nextTemp();
  lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
  const bData = ctx.nextTemp();
  lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
  const cmpResult = ctx.nextTemp();
  lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${aLen})`);
  const dataEq = ctx.nextTemp();
  lines.push(`  ${dataEq} = icmp eq i32 ${cmpResult}, 0`);
  lines.push(`  br label %${cmpDoneLabel}`);
  lines.push(`${cmpFalseLabel}:`);
  lines.push(`  br label %${cmpDoneLabel}`);
  lines.push(`${cmpDoneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi i1 [${dataEq}, %${cmpDataLabel}], [false, %${cmpFalseLabel}]`);
  if (!isEq) {
    const negated = ctx.nextTemp();
    lines.push(`  ${negated} = xor i1 ${result}, 1`);
    return [lines, negated, "i1"];
  }
  return [lines, result, "i1"];
}

// lexicographic string ordering via memcmp on common prefix, then length tiebreak
export function genStringOrd(ctx: CodegenCtx, lines: string[], lv: string, rv: string, op: string): Gen {
  ctx.needsMemcmp = true;
  const aLen = ctx.nextTemp();
  lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
  const bLen = ctx.nextTemp();
  lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
  const aData = ctx.nextTemp();
  lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
  const bData = ctx.nextTemp();
  lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);

  const aLessThanB = ctx.nextTemp();
  lines.push(`  ${aLessThanB} = icmp ult i64 ${aLen}, ${bLen}`);
  const minLen = ctx.nextTemp();
  lines.push(`  ${minLen} = select i1 ${aLessThanB}, i64 ${aLen}, i64 ${bLen}`);
  const cmpResult = ctx.nextTemp();
  lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${minLen})`);

  const isZero = ctx.nextTemp();
  lines.push(`  ${isZero} = icmp eq i32 ${cmpResult}, 0`);
  const dataCmpLabel = ctx.nextLabel("str.orddata");
  const lenCmpLabel = ctx.nextLabel("str.ordlen");
  const doneLabel = ctx.nextLabel("str.orddone");
  lines.push(`  br i1 ${isZero}, label %${lenCmpLabel}, label %${dataCmpLabel}`);

  // prefix differs — compare memcmp result against 0
  lines.push(`${dataCmpLabel}:`);
  const dataPred = op === "<" || op === "<=" ? "slt" : "sgt";
  const dataResult = ctx.nextTemp();
  lines.push(`  ${dataResult} = icmp ${dataPred} i32 ${cmpResult}, 0`);
  lines.push(`  br label %${doneLabel}`);

  // prefix equal — compare lengths
  lines.push(`${lenCmpLabel}:`);
  const lenPred = op === "<" ? "ult" : op === ">" ? "ugt" : op === "<=" ? "ule" : "uge";
  const lenResult = ctx.nextTemp();
  lines.push(`  ${lenResult} = icmp ${lenPred} i64 ${aLen}, ${bLen}`);
  lines.push(`  br label %${doneLabel}`);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi i1 [${dataResult}, %${dataCmpLabel}], [${lenResult}, %${lenCmpLabel}]`);
  return [lines, result, "i1"];
}

// String.push(u8). The fast path stays inline: room for the byte and its NUL, and a
// count of 1 (a heap buffer this handle holds alone). Anything else (a literal, a full
// buffer, a shared one) goes through @milo.str.reserve, which copies or grows.
export function genStringPush(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringPush" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.strRt();

  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const [byteLines, byteVal] = ctx.genExpr(expr.byte);
  lines.push(...byteLines);

  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const lenPlus1 = ctx.nextTemp();
  lines.push(`  ${lenPlus1} = add i64 ${len}, 1`);
  // cap > len + 1 leaves room for the byte and the NUL, and implies a heap buffer.
  const room = ctx.nextTemp();
  lines.push(`  ${room} = icmp ult i64 ${lenPlus1}, ${cap}`);
  const chkL = ctx.nextLabel("str.chk");
  const fastL = ctx.nextLabel("str.fast");
  const slowL = ctx.nextLabel("str.slow");
  const storeL = ctx.nextLabel("str.push");
  lines.push(`  br i1 ${room}, label %${chkL}, label %${slowL}`);
  lines.push(`${chkL}:`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  const hdr = ctx.nextTemp();
  lines.push(`  ${hdr} = getelementptr i8, ptr ${data}, i64 -8`);
  const rc = ctx.nextTemp();
  lines.push(ctx.target.os === "none" ? `  ${rc} = load i64, ptr ${hdr}, align 8` : `  ${rc} = load atomic i64, ptr ${hdr} acquire, align 8`);
  const only = ctx.nextTemp();
  lines.push(`  ${only} = icmp eq i64 ${rc}, 1`);
  lines.push(`  br i1 ${only}, label %${fastL}, label %${slowL}`);
  lines.push(`${fastL}:`);
  lines.push(`  br label %${storeL}`);
  lines.push(`${slowL}:`);
  const grown = ctx.nextTemp();
  lines.push(`  ${grown} = call ptr ${ctx.strReserveFn()}(ptr ${strPtr}, i64 1)`);
  ctx.emitAllocNullCheck(lines, grown, "strgrow", expr.span);
  const slowEnd = ctx.nextLabel("str.slowend");
  lines.push(`  br label %${slowEnd}`);
  lines.push(`${slowEnd}:`);
  lines.push(`  br label %${storeL}`);
  lines.push(`${storeL}:`);
  const cur = ctx.nextTemp();
  lines.push(`  ${cur} = phi ptr [ ${data}, %${fastL} ], [ ${grown}, %${slowEnd} ]`);
  const elemPtr = ctx.nextTemp();
  lines.push(`  ${elemPtr} = getelementptr i8, ptr ${cur}, i64 ${len}`);
  lines.push(`  store i8 ${byteVal}, ptr ${elemPtr}`);
  lines.push(`  store i64 ${lenPlus1}, ptr ${lenPtr}`);
  // null-terminate for FFI safety
  const nullPtr = ctx.nextTemp();
  lines.push(`  ${nullPtr} = getelementptr i8, ptr ${cur}, i64 ${lenPlus1}`);
  lines.push(`  store i8 0, ptr ${nullPtr}`);

  return [lines, "void", "void"];
}

// s.pushInt(n): n's digits written straight into s's buffer, no temporary.
export function genStringPushInt(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringPushInt" }, lines: string[]): Gen {
  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const [vLines, vVal, vTy] = ctx.genExpr(expr.value);
  lines.push(...vLines);
  ctx.emitAppendFormatParts(lines, strPtr, [{ val: vVal, ty: vTy, tk: expr.value.type }], expr.span);
  return [lines, "void", "void"];
}

// s.truncate(n) / s.clear(): shorten to n bytes, keeping the buffer and its capacity.
// A negative n empties the string and an n at or past the end is a no-op, as for
// Vec.truncate. An n inside a multibyte character aborts, the check charAt makes
// (std/string strCharAt): cutting there would leave invalid UTF-8 behind. A cap-0
// string is a static literal that cannot take the NUL a shorter string needs at its
// new end (cstr() reads up to it), so it is copied out to an owned buffer first.
export function genStringTruncate(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringTruncate" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  let n = "0";
  if (expr.length) {
    const raw = ctx.genBoundI64(expr.length, lines);
    const neg = ctx.nextTemp();
    lines.push(`  ${neg} = icmp slt i64 ${raw}, 0`);
    n = ctx.nextTemp();
    lines.push(`  ${n} = select i1 ${neg}, i64 0, i64 ${raw}`);
  }
  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
  const noop = ctx.nextTemp();
  lines.push(`  ${noop} = icmp uge i64 ${n}, ${len}`);
  const cutL = ctx.nextLabel("strtrunc.cut");
  const doneL = ctx.nextLabel("strtrunc.done");
  lines.push(`  br i1 ${noop}, label %${doneL}, label %${cutL}`);
  lines.push(`${cutL}:`);
  // The NUL written at the new end is a write; another handle must not see it.
  ctx.emitStrUnique(lines, strPtr);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  if (expr.length) {
    const at = ctx.nextTemp();
    lines.push(`  ${at} = getelementptr i8, ptr ${data}, i64 ${n}`);
    const b = ctx.nextTemp();
    lines.push(`  ${b} = load i8, ptr ${at}`);
    const hi = ctx.nextTemp();
    lines.push(`  ${hi} = and i8 ${b}, -64`);
    const inside = ctx.nextTemp();
    lines.push(`  ${inside} = icmp eq i8 ${hi}, -128`);
    const badL = ctx.nextLabel("strtrunc.mid");
    const okL = ctx.nextLabel("strtrunc.ok");
    lines.push(`  br i1 ${inside}, label %${badL}, label %${okL}`);
    lines.push(`${badL}:`);
    const { label: errLabel, length: errLen } = ctx.addString(
      `milo: truncate(%lld) lands inside a multibyte UTF-8 character; truncate takes a byte length that must end on a character boundary, at ${ctx.panicAt(expr.span)}\n`,
    );
    const errPtr = ctx.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    ctx.emitFdPrintf(lines, 2, errPtr, `, i64 ${n}`);
    ctx.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okL}:`);
  }
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const owned = ctx.nextTemp();
  lines.push(`  ${owned} = icmp ugt i64 ${cap}, 0`);
  const inPlaceL = ctx.nextLabel("strtrunc.inplace");
  const copyL = ctx.nextLabel("strtrunc.copy");
  lines.push(`  br i1 ${owned}, label %${inPlaceL}, label %${copyL}`);
  lines.push(`${inPlaceL}:`);
  const end = ctx.nextTemp();
  lines.push(`  ${end} = getelementptr i8, ptr ${data}, i64 ${n}`);
  lines.push(`  store i8 0, ptr ${end}`);
  lines.push(`  store i64 ${n}, ptr ${lenPtr}`);
  lines.push(`  br label %${doneL}`);
  lines.push(`${copyL}:`);
  ctx.needsMemcpy = true;
  const size = ctx.nextTemp();
  lines.push(`  ${size} = add i64 ${n}, 1`);
  const buf = ctx.emitStrAlloc(lines, size, "strtrunc", expr.span);
  lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${data}, i64 ${n})`);
  const bend = ctx.nextTemp();
  lines.push(`  ${bend} = getelementptr i8, ptr ${buf}, i64 ${n}`);
  lines.push(`  store i8 0, ptr ${bend}`);
  lines.push(`  store ptr ${buf}, ptr ${dataPtr}`);
  lines.push(`  store i64 ${n}, ptr ${lenPtr}`);
  lines.push(`  store i64 ${size}, ptr ${capPtr}`);
  lines.push(`  br label %${doneL}`);
  lines.push(`${doneL}:`);
  return [lines, "void", "void"];
}

// `s.setByte(i, b)`: the bounds test is unsigned and 64-bit, so a negative or huge
// index aborts instead of wrapping. A literal (cap 0) points into read-only data, so
// it is copied out to an owned buffer before the write, as truncate does.
export function genStringSetByte(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringSetByte" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsBoundsCheck = true;
  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const idx = ctx.genBoundI64(expr.index, lines);
  const [bl, bv, bt] = ctx.genExpr(expr.byte);
  lines.push(...bl);
  let byte = bv;
  if (bt !== "i8") {
    byte = ctx.nextTemp();
    lines.push(`  ${byte} = trunc ${bt} ${bv} to i8`);
  }
  const dataPtr = ctx.nextTemp();
  lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
  const inRange = ctx.nextTemp();
  lines.push(`  ${inRange} = icmp ult i64 ${idx}, ${len}`);
  const okL = ctx.nextLabel("strsetbyte.ok");
  const failL = ctx.nextLabel("strsetbyte.oob");
  lines.push(`  br i1 ${inRange}, label %${okL}, label %${failL}`);
  lines.push(`${failL}:`);
  const filePtr = ctx.emitCheckFilePtr(lines, expr.span);
  lines.push(`  call void @__milo_bounds_fail(i64 ${idx}, i64 ${len}, ptr ${filePtr}, i32 ${expr.span?.line ?? 0})`);
  lines.push(`  unreachable`);
  lines.push(`${okL}:`);
  ctx.emitStrUnique(lines, strPtr);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const owned = ctx.nextTemp();
  lines.push(`  ${owned} = icmp ugt i64 ${cap}, 0`);
  const writeL = ctx.nextLabel("strsetbyte.write");
  const copyL = ctx.nextLabel("strsetbyte.copy");
  lines.push(`  br i1 ${owned}, label %${writeL}, label %${copyL}`);
  lines.push(`${copyL}:`);
  ctx.needsMemcpy = true;
  const old = ctx.nextTemp();
  lines.push(`  ${old} = load ptr, ptr ${dataPtr}`);
  const size = ctx.nextTemp();
  lines.push(`  ${size} = add i64 ${len}, 1`);
  const buf = ctx.emitStrAlloc(lines, size, "strsetbyte", expr.span);
  lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${old}, i64 ${len})`);
  const bend = ctx.nextTemp();
  lines.push(`  ${bend} = getelementptr i8, ptr ${buf}, i64 ${len}`);
  lines.push(`  store i8 0, ptr ${bend}`);
  lines.push(`  store ptr ${buf}, ptr ${dataPtr}`);
  lines.push(`  store i64 ${size}, ptr ${capPtr}`);
  lines.push(`  br label %${writeL}`);
  lines.push(`${writeL}:`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
  const at = ctx.nextTemp();
  lines.push(`  ${at} = getelementptr i8, ptr ${data}, i64 ${idx}`);
  lines.push(`  store i8 ${byte}, ptr ${at}`);
  return [lines, "void", "void"];
}

// Append a whole string in place. `s = s + t` reallocates and copies the
// accumulator on every concat (quadratic when building in a loop); this grows
// amortized like Vec.push and copies only the addition.
export function genStringPushStr(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringPushStr" }, lines: string[]): Gen {
  ctx.hasStringType = true;

  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  // `s.pushStr($"...")`: write the interpolation's parts straight into s rather than
  // building the formatted temporary and copying it.
  const o = expr.other;
  if (o.kind === "Call" && o.func === "format" && o.args.every(a => ctx.fastFormatPart(a.expr.type) !== null)) {
    const temps = ctx.genFormatParts(o.args, lines);
    ctx.emitAppendFormatParts(lines, strPtr, temps.map(t => ({ val: t.val, ty: t.ty, tk: t.expr.type })), expr.span);
    for (const t of temps) ctx.dropOwnedTemp(lines, t.val, t.ty, t.expr);
    return [lines, "void", "void"];
  }
  const [otherLines, otherVal] = ctx.genExpr(expr.other);
  lines.push(...otherLines);
  // One string part: the same reserve (unique first, then grow) and the same re-basing
  // of a source that points into the receiver (`s.pushStr(s)`) as an interpolation.
  ctx.emitAppendFormatParts(lines, strPtr, [{ val: otherVal, ty: "%String", tk: { tag: "string" } }], expr.span);

  // pushStr copies the bytes in; a temporary source (a call result, or the
  // clone `v[i]` produces) is dead afterwards and nothing else frees it.
  ctx.dropOwnedTemp(lines, otherVal, "%String", expr.other);
  return [lines, "void", "void"];
}

// String.substr(start, end) — allocate new owned string from s[start..end]
export function genStringSubstr(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringSubstr" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;

  const [strLines, strVal] = ctx.genExpr(expr.str);
  lines.push(...strLines);
  const startVal = ctx.genBoundI64(expr.start, lines);
  const endVal = ctx.genBoundI64(expr.end, lines);

  ctx.emitStringRangeCheck(lines, startVal, endVal, strVal, "substr", expr.span);

  const subLen = ctx.nextTemp();
  lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);

  const allocLen = ctx.nextTemp();
  lines.push(`  ${allocLen} = add i64 ${subLen}, 1`);
  const buf = ctx.emitStrAlloc(lines, allocLen, "substr", expr.span);

  const srcPtr = ctx.nextTemp();
  lines.push(`  ${srcPtr} = extractvalue %String ${strVal}, 0`);
  const srcOff = ctx.nextTemp();
  lines.push(`  ${srcOff} = getelementptr i8, ptr ${srcPtr}, i64 ${startVal}`);
  lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${srcOff}, i64 ${subLen})`);

  const nullPtr = ctx.nextTemp();
  lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${subLen}`);
  lines.push(`  store i8 0, ptr ${nullPtr}`);

  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${subLen}, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocLen}, 2`);

  // substr COPIES out of its receiver, so nothing points into it afterwards and a
  // temporary receiver can go: `big(i).substr(0, 100).len` leaked the whole receiver on
  // every call. Same shape as the Vec/HashMap/StringLen receiver drops.
  ctx.dropOwnedTemp(lines, strVal, "%String", expr.str);
  return [lines, s2, "%String"];
}

// String.slice(start, end) — zero-copy view. Non-owning %String with cap=0.
export function genStringSlice(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringSlice" }, lines: string[]): Gen {
  ctx.hasStringType = true;

  const [strLines, strVal] = ctx.genExpr(expr.str);
  lines.push(...strLines);
  const startVal = ctx.genBoundI64(expr.start, lines);
  const endVal = ctx.genBoundI64(expr.end, lines);

  ctx.emitStringRangeCheck(lines, startVal, endVal, strVal, "slice", expr.span);

  const subLen = ctx.nextTemp();
  lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);

  const srcPtr = ctx.nextTemp();
  lines.push(`  ${srcPtr} = extractvalue %String ${strVal}, 0`);
  const slicePtr = ctx.nextTemp();
  lines.push(`  ${slicePtr} = getelementptr i8, ptr ${srcPtr}, i64 ${startVal}`);

  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %String undef, ptr ${slicePtr}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${subLen}, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);

  return [lines, s2, "%String"];
}

// n.toString() / x.toString(): an owned %String; ints through @milo.fmt.*, floats through @milo.fmt.f64
export function genNumberToString(ctx: CodegenCtx, expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): Gen {
  ctx.needsMalloc = true;
  ctx.hasStringType = true;

  const [vLines, vVal, vTy] = ctx.genExpr(expr.value);
  lines.push(...vLines);

  const vt = expr.valueType;
  if (vt.tag === "int") {
    // 24 bytes holds any 64-bit decimal (20 digits with the sign) and the NUL.
    const buf = ctx.emitStrAlloc(lines, "24", "itos", expr.span);
    const n = ctx.emitIntFmt(lines, buf, vVal, vTy, vt);
    const nul = ctx.nextTemp();
    lines.push(`  ${nul} = getelementptr i8, ptr ${buf}, i64 ${n}`);
    lines.push(`  store i8 0, ptr ${nul}`);
    const s0 = ctx.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = ctx.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${n}, 1`);
    const s2 = ctx.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 24, 2`);
    return [lines, s2, "%String"];
  }
  // Floats don't go through snprintf directly: they need the round-trip
  // search in @milo.fmt.f64, which already writes an owned buffer we can
  // hand straight to %String.
  const { buf, len } = ctx.emitFloatToBuf(vVal, vt.tag === "float" ? vt.bits : 64, lines, true);
  const f0 = ctx.nextTemp();
  lines.push(`  ${f0} = insertvalue %String undef, ptr ${buf}, 0`);
  const f1 = ctx.nextTemp();
  lines.push(`  ${f1} = insertvalue %String ${f0}, i64 ${len}, 1`);
  const f2 = ctx.nextTemp();
  lines.push(`  ${f2} = insertvalue %String ${f1}, i64 ${F64_BUF}, 2`);
  return [lines, f2, "%String"];
}

export function genBoolToString(ctx: CodegenCtx, expr: HIRExpr & { kind: "BoolToString" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  const [vLines, vVal] = ctx.genExpr(expr.value);
  lines.push(...vLines);
  const trueStr = ctx.addString("true");
  const falseStr = ctx.addString("false");
  const ptr = ctx.nextTemp();
  lines.push(`  ${ptr} = select i1 ${vVal}, ptr ${trueStr.label}, ptr ${falseStr.label}`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = select i1 ${vVal}, i64 4, i64 5`);
  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %String undef, ptr ${ptr}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len}, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);
  return [lines, s2, "%String"];
}

// s.clone() — deep copy of the underlying byte buffer; result is an owned %String
export function genStringClone(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringClone" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  const passed = ctx.cloneOfOwnedTemp(expr.str, lines);
  if (passed) return passed;
  const [sLines, sVal] = ctx.genExpr(expr.str);
  lines.push(...sLines);
  return [lines, ctx.emitStrShare(lines, sVal), "%String"];
}

export function genStringFind(ctx: CodegenCtx, expr: HIRExpr & { kind: "StringFind" }, lines: string[]): Gen {
  const enumTy = `%${expr.optionEnumName}`;
  const layout = ctx.enumLayouts.get(expr.optionEnumName);
  const noneVariant = layout?.variants.get("None");
  const someVariant = layout?.variants.get("Some");
  if (!layout || !noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const [strLines, strValue] = ctx.genExpr(expr.str);
  const [needleLines, needleValue] = ctx.genExpr(expr.needle);
  lines.push(...strLines);
  const strPtr = `%__string_find_haystack.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${strPtr} = alloca %String`);
  lines.push(`  store %String ${strValue}, ptr ${strPtr}`);
  lines.push(...needleLines);
  const needlePtr = `%__string_find_needle.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${needlePtr} = alloca %String`);
  lines.push(`  store %String ${needleValue}, ptr ${needlePtr}`);
  let fn = expr.reverse ? "strLastIndexOf" : "strIndexOf";
  let args = `ptr ${strPtr}, ptr ${needlePtr}`;
  if (expr.from) {
    const [fromLines, fromValue, fromTy] = ctx.genExpr(expr.from);
    lines.push(...fromLines);
    fn = "strIndexOfFrom";
    args += `, ${fromTy} ${fromValue}`;
  }
  const index = ctx.nextTemp();
  lines.push(`  ${index} = call i64 @${fn}(${args})`);

  const resultAddr = `%__string_find_result.${ctx.scopeCounter++}.addr`;
  ctx.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
  lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
  const found = ctx.nextTemp();
  lines.push(`  ${found} = icmp sge i64 ${index}, 0`);
  const someLabel = ctx.nextLabel("string.find.some");
  const noneLabel = ctx.nextLabel("string.find.none");
  const endLabel = ctx.nextLabel("string.find.end");
  lines.push(`  br i1 ${found}, label %${someLabel}, label %${noneLabel}`);
  lines.push(`${noneLabel}:`);
  ctx.storeEnumTag(lines, enumTy, resultAddr, noneVariant.tag);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${someLabel}:`);
  ctx.storeEnumTag(lines, enumTy, resultAddr, someVariant.tag);
  const payloadPtr = ctx.enumPayloadPtr(lines, enumTy, resultAddr, someVariant);
  lines.push(`  store i64 ${index}, ptr ${payloadPtr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${endLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
  // indexOf/indexOfFrom/lastIndexOf read both operands and answer an INDEX, so nothing
  // points into either by the time we get here and both can go now — no deferral to
  // argTempDrops needed. `s.indexOf("o" + i.toString())` leaked its needle per call, and
  // `("pre" + i.toString()).indexOf("r")` leaked the receiver as well.
  ctx.dropOwnedTemp(lines, strValue, "%String", expr.str);
  ctx.dropOwnedTemp(lines, needleValue, "%String", expr.needle);
  return [lines, result, enumTy];
}
