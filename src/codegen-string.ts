// String method lowering (concat, compare, push, slice, number/bool to string), extracted to keep codegen.ts manageable.

import type { HIRExpr, HIRArg } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { TargetInfo } from "./target";
import { LlvmTextBuilder, Ty, val, asGen, type Builder, type Val, type NameSource } from "./ir";
import type { Gen } from "./codegen";

// Scratch size for one formatted f64. Worst case at 17 significant digits is
// "-1.2345678901234567e-308" — 24 bytes plus the NUL.
export const F64_BUF = 32;

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this, they are not part of its external API.
export interface StringCtx extends NameSource {
  genVal(expr: HIRExpr, lines: string[], sretDest?: string): Val;
  genLValue(expr: HIRExpr): Gen;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  cloneOfOwnedTemp(src: HIRExpr, lines: string[]): Gen | null;
  emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }): void;
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
  panicLine(span?: Span): number;
  panicAbort(lines: string[]): void;
  entryAllocas: string[];
  target: TargetInfo;
  hasStringType: boolean;
  needsMalloc: boolean;
  needsMemcpy: boolean;
  needsMemcmp: boolean;
  needsBoundsCheck: boolean;
}

const STRING = Ty.of("%String");
const I64_0 = val("0", Ty.i64);

// { ptr, len, cap } as three insertvalues into undef, the %String layout every method here builds.
function makeString(b: Builder, data: Val, len: Val, cap: Val): Val {
  const s0 = b.insertvalue(val("undef", STRING), data, 0);
  const s1 = b.insertvalue(s0, len, 1);
  return b.insertvalue(s1, cap, 2);
}

// Pointer to field `i` of a %String (0 data, 1 len, 2 cap).
function stringField(b: Builder, strPtr: Val, i: number): Val {
  return b.gep(STRING, strPtr, [val("0", Ty.i32), val(String(i), Ty.i32)]);
}

export function genStringWithCapacity(ctx: StringCtx, expr: HIRExpr & { kind: "StringWithCapacity" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  const capVal = ctx.genVal(expr.capacity, lines);
  ctx.emitNonNegativeCheck(lines, capVal.ref, "capacity", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  // At least one byte. A String owns its buffer exactly when cap > 0 (cap 0 marks a
  // borrowed literal, which drop skips), and malloc(0) still hands back a live block:
  // `String.withCapacity(0)` was an owned buffer recorded as borrowed, leaked on drop,
  // and orphaned by the first push (which saw cap 0 and allocated afresh).
  const isZero = b.icmp("eq", val(capVal.ref, Ty.i64), I64_0);
  const cap = b.select(isZero, val("1", Ty.i64), val(capVal.ref, Ty.i64));
  const buf = val(ctx.emitStrAlloc(lines, cap.ref, "strcap", expr.span), Ty.ptr);
  b.store(val("0", Ty.i8), buf);
  return asGen(lines, makeString(b, buf, I64_0, cap));
}

export function genStringConcat(ctx: StringCtx, lines: string[], lv: string, rv: string): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const l = val(lv, STRING), r = val(rv, STRING);
  const aData = b.extractvalue(l, 0, Ty.ptr);
  const aLen = b.extractvalue(l, 1, Ty.i64);
  const bData = b.extractvalue(r, 0, Ty.ptr);
  const bLen = b.extractvalue(r, 1, Ty.i64);
  const total = b.binop("add", aLen, bLen);
  // +1 for null terminator
  const allocSz = b.binop("add", total, val("1", Ty.i64));
  const buf = val(ctx.emitStrAlloc(lines, allocSz.ref, "strcat"), Ty.ptr);
  b.callDiscard(Ty.ptr, "@memcpy", [buf, aData, aLen]);
  const dst = b.gep(Ty.i8, buf, [aLen]);
  b.callDiscard(Ty.ptr, "@memcpy", [dst, bData, bLen]);
  // null terminate
  const nullPtr = b.gep(Ty.i8, buf, [total]);
  b.store(val("0", Ty.i8), nullPtr);
  return asGen(lines, makeString(b, buf, total, allocSz));
}

export function genStringCmp(ctx: StringCtx, lines: string[], lv: string, rv: string, isEq: boolean): Gen {
  ctx.needsMemcmp = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const l = val(lv, STRING), r = val(rv, STRING);
  const aLen = b.extractvalue(l, 1, Ty.i64);
  const bLen = b.extractvalue(r, 1, Ty.i64);
  const lenEq = b.icmp("eq", aLen, bLen);
  const cmpData = b.newBlock("str.cmpdata");
  const cmpFalse = b.newBlock("str.short");
  const cmpDone = b.newBlock("str.done");
  b.condBr(lenEq, cmpData, cmpFalse);
  b.position(cmpData);
  const aData = b.extractvalue(l, 0, Ty.ptr);
  const bData = b.extractvalue(r, 0, Ty.ptr);
  const cmpResult = b.call(Ty.i32, "@memcmp", [aData, bData, aLen]);
  const dataEq = b.icmp("eq", cmpResult, val("0", Ty.i32));
  b.br(cmpDone);
  b.position(cmpFalse);
  b.br(cmpDone);
  b.position(cmpDone);
  const result = b.phi(Ty.i1, [[dataEq, cmpData], [val("false", Ty.i1), cmpFalse]]);
  if (!isEq) return asGen(lines, b.binop("xor", result, val("1", Ty.i1)));
  return asGen(lines, result);
}

// lexicographic string ordering via memcmp on common prefix, then length tiebreak
export function genStringOrd(ctx: StringCtx, lines: string[], lv: string, rv: string, op: string): Gen {
  ctx.needsMemcmp = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const l = val(lv, STRING), r = val(rv, STRING);
  const aLen = b.extractvalue(l, 1, Ty.i64);
  const bLen = b.extractvalue(r, 1, Ty.i64);
  const aData = b.extractvalue(l, 0, Ty.ptr);
  const bData = b.extractvalue(r, 0, Ty.ptr);

  const aLessThanB = b.icmp("ult", aLen, bLen);
  const minLen = b.select(aLessThanB, aLen, bLen);
  const cmpResult = b.call(Ty.i32, "@memcmp", [aData, bData, minLen]);

  const isZero = b.icmp("eq", cmpResult, val("0", Ty.i32));
  const dataCmp = b.newBlock("str.orddata");
  const lenCmp = b.newBlock("str.ordlen");
  const done = b.newBlock("str.orddone");
  b.condBr(isZero, lenCmp, dataCmp);

  // prefix differs — compare memcmp result against 0
  b.position(dataCmp);
  const dataResult = b.icmp(op === "<" || op === "<=" ? "slt" : "sgt", cmpResult, val("0", Ty.i32));
  b.br(done);

  // prefix equal — compare lengths
  b.position(lenCmp);
  const lenResult = b.icmp(op === "<" ? "ult" : op === ">" ? "ugt" : op === "<=" ? "ule" : "uge", aLen, bLen);
  b.br(done);

  b.position(done);
  return asGen(lines, b.phi(Ty.i1, [[dataResult, dataCmp], [lenResult, lenCmp]]));
}

// std/string's `_strReserve(&mut s, extra)`: s's data pointer, with room for `extra` more
// bytes and the NUL, in a buffer s holds alone. The fast path stays inline (the IR the
// builtin push emitted): room, and a count of 1. Anything else (a literal, a full buffer,
// a shared one) goes through @milo.str.reserve, which copies or grows.
export function genStrReserve(ctx: StringCtx, expr: HIRExpr & { kind: "StrReserve" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.strRt();

  const [strPtrLines, strPtrRef] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const extra = val(ctx.genBoundI64(expr.extra, lines), Ty.i64);

  const b = new LlvmTextBuilder(lines, ctx);
  const strPtr = val(strPtrRef, Ty.ptr);
  const dataPtr = stringField(b, strPtr, 0);
  const lenPtr = stringField(b, strPtr, 1);
  const len = b.load(Ty.i64, lenPtr);
  const capPtr = stringField(b, strPtr, 2);
  const cap = b.load(Ty.i64, capPtr);
  const need = b.binop("add", len, extra);
  // cap > len + extra leaves room for the bytes and the NUL, and implies a heap buffer.
  const room = b.icmp("ult", need, cap);
  const chk = b.newBlock("str.chk");
  const fast = b.newBlock("str.fast");
  const slow = b.newBlock("str.slow");
  const store = b.newBlock("str.push");
  b.condBr(room, chk, slow);
  b.position(chk);
  const data = b.load(Ty.ptr, dataPtr);
  const hdr = b.gep(Ty.i8, data, [val("-8", Ty.i64)]);
  const rc = ctx.target.os === "none" ? b.load(Ty.i64, hdr, 8) : b.loadAcquire(Ty.i64, hdr, 8);
  const only = b.icmp("eq", rc, val("1", Ty.i64));
  b.condBr(only, fast, slow);
  b.position(fast);
  b.br(store);
  b.position(slow);
  const grown = b.call(Ty.ptr, ctx.strReserveFn(), [strPtr, extra]);
  ctx.emitAllocNullCheck(lines, grown.ref, "strgrow", expr.span);
  const slowEnd = b.newBlock("str.slowend");
  b.br(slowEnd);
  b.position(slowEnd);
  b.br(store);
  b.position(store);
  const cur = b.phi(Ty.ptr, [[data, fast], [grown, slowEnd]], true);
  return [lines, cur.ref, "ptr"];
}

// std/string's `_strPanic("head", n, "tail")`: prints "head<n>tail at file:line:col" and
// aborts, the shape of the builtin truncate's panic. Inside a @trackCaller copy panicAt
// names the caller.
export function genStrPanic(ctx: StringCtx, expr: HIRExpr & { kind: "StrPanic" }, lines: string[]): Gen {
  const n = val(ctx.genBoundI64(expr.value, lines), Ty.i64);
  const b = new LlvmTextBuilder(lines, ctx);
  const { label, length } = ctx.addString(`${expr.head}%lld${expr.tail} at ${ctx.panicAt(expr.span)}\n`);
  const msg = b.gep(Ty.of(`[${length} x i8]`), val(label, Ty.ptr), [val("0", Ty.i32), val("0", Ty.i32)]);
  ctx.emitFdPrintf(lines, 2, msg.ref, `, i64 ${n.ref}`);
  ctx.panicAbort(lines);
  b.unreachable();
  b.position(b.newBlock("strpanic.after"));
  return [lines, "void", "void"];
}

// s.pushInt(n): n's digits written straight into s's buffer, no temporary.
export function genStringPushInt(ctx: StringCtx, expr: HIRExpr & { kind: "StringPushInt" }, lines: string[]): Gen {
  const [strPtrLines, strPtr] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const vVal = ctx.genVal(expr.value, lines);
  ctx.emitAppendFormatParts(lines, strPtr, [{ val: vVal.ref, ty: vVal.ty.ll, tk: expr.value.type }], expr.span);
  return [lines, "void", "void"];
}

// Append a whole string in place. `s = s + t` reallocates and copies the
// accumulator on every concat (quadratic when building in a loop); this grows
// amortized like Vec.push and copies only the addition.
export function genStringPushStr(ctx: StringCtx, expr: HIRExpr & { kind: "StringPushStr" }, lines: string[]): Gen {
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
  const otherVal = ctx.genVal(expr.other, lines);
  // One string part: the same reserve (unique first, then grow) and the same re-basing
  // of a source that points into the receiver (`s.pushStr(s)`) as an interpolation.
  ctx.emitAppendFormatParts(lines, strPtr, [{ val: otherVal.ref, ty: "%String", tk: { tag: "string" } }], expr.span);

  // pushStr copies the bytes in; a temporary source (a call result, or the
  // clone `v[i]` produces) is dead afterwards and nothing else frees it.
  ctx.dropOwnedTemp(lines, otherVal.ref, "%String", expr.other);
  return [lines, "void", "void"];
}

// String.slice(start, end) — zero-copy view. Non-owning %String with cap=0.
export function genStringSlice(ctx: StringCtx, expr: HIRExpr & { kind: "StringSlice" }, lines: string[]): Gen {
  ctx.hasStringType = true;

  const strVal = ctx.genVal(expr.str, lines);
  const startVal = ctx.genBoundI64(expr.start, lines);
  const endVal = ctx.genBoundI64(expr.end, lines);

  ctx.emitStringRangeCheck(lines, startVal, endVal, strVal.ref, "slice", expr.span);

  const b = new LlvmTextBuilder(lines, ctx);
  const subLen = b.binop("sub", val(endVal, Ty.i64), val(startVal, Ty.i64));

  const srcPtr = b.extractvalue(val(strVal.ref, STRING), 0, Ty.ptr);
  const slicePtr = b.gep(Ty.i8, srcPtr, [val(startVal, Ty.i64)]);

  return asGen(lines, makeString(b, slicePtr, subLen, I64_0));
}

// n.toString() / x.toString(): an owned %String; ints through @milo.fmt.*, floats through @milo.fmt.f64
export function genNumberToString(ctx: StringCtx, expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): Gen {
  ctx.needsMalloc = true;
  ctx.hasStringType = true;

  const vVal = ctx.genVal(expr.value, lines);

  const b = new LlvmTextBuilder(lines, ctx);
  const vt = expr.valueType;
  if (vt.tag === "int") {
    // 24 bytes holds any 64-bit decimal (20 digits with the sign) and the NUL.
    const buf = val(ctx.emitStrAlloc(lines, "24", "itos", expr.span), Ty.ptr);
    const n = val(ctx.emitIntFmt(lines, buf.ref, vVal.ref, vVal.ty.ll, vt), Ty.i64);
    const nul = b.gep(Ty.i8, buf, [n]);
    b.store(val("0", Ty.i8), nul);
    return asGen(lines, makeString(b, buf, n, val("24", Ty.i64)));
  }
  // Floats don't go through snprintf directly: they need the round-trip
  // search in @milo.fmt.f64, which already writes an owned buffer we can
  // hand straight to %String.
  const { buf, len } = ctx.emitFloatToBuf(vVal.ref, vt.tag === "float" ? vt.bits : 64, lines, true);
  return asGen(lines, makeString(b, val(buf, Ty.ptr), val(len, Ty.i64), val(String(F64_BUF), Ty.i64)));
}

// s.clone() — deep copy of the underlying byte buffer; result is an owned %String
export function genStringClone(ctx: StringCtx, expr: HIRExpr & { kind: "StringClone" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  const passed = ctx.cloneOfOwnedTemp(expr.str, lines);
  if (passed) return passed;
  const sVal = ctx.genVal(expr.str, lines);
  return [lines, ctx.emitStrShare(lines, sVal.ref), "%String"];
}
