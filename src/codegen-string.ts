// String method lowering (concat, compare, push, slice, substr, find, number/bool to string), extracted to keep codegen.ts manageable.

import type { HIRExpr, HIRArg } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { TargetInfo } from "./target";
import { LlvmTextBuilder, Ty, val, asGen, type Builder, type Val, type NameSource } from "./ir";
import type { Gen, EnumLayout, EnumVariant } from "./codegen";

// Scratch size for one formatted f64. Worst case at 17 significant digits is
// "-1.2345678901234567e-308" — 24 bytes plus the NUL.
export const F64_BUF = 32;

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this, they are not part of its external API.
export interface StringCtx extends NameSource {
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
  const [capLines, capVal] = ctx.genExpr(expr.capacity);
  lines.push(...capLines);
  ctx.emitNonNegativeCheck(lines, capVal, "capacity", expr.span);
  const b = new LlvmTextBuilder(lines, ctx);
  // At least one byte. A String owns its buffer exactly when cap > 0 (cap 0 marks a
  // borrowed literal, which drop skips), and malloc(0) still hands back a live block:
  // `String.withCapacity(0)` was an owned buffer recorded as borrowed, leaked on drop,
  // and orphaned by the first push (which saw cap 0 and allocated afresh).
  const isZero = b.icmp("eq", val(capVal, Ty.i64), I64_0);
  const cap = b.select(isZero, val("1", Ty.i64), val(capVal, Ty.i64));
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

// String.push(u8). The fast path stays inline: room for the byte and its NUL, and a
// count of 1 (a heap buffer this handle holds alone). Anything else (a literal, a full
// buffer, a shared one) goes through @milo.str.reserve, which copies or grows.
export function genStringPush(ctx: StringCtx, expr: HIRExpr & { kind: "StringPush" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.strRt();

  const [strPtrLines, strPtrRef] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const [byteLines, byteVal] = ctx.genExpr(expr.byte);
  lines.push(...byteLines);

  const b = new LlvmTextBuilder(lines, ctx);
  const strPtr = val(strPtrRef, Ty.ptr);
  const dataPtr = stringField(b, strPtr, 0);
  const lenPtr = stringField(b, strPtr, 1);
  const len = b.load(Ty.i64, lenPtr);
  const capPtr = stringField(b, strPtr, 2);
  const cap = b.load(Ty.i64, capPtr);
  const lenPlus1 = b.binop("add", len, val("1", Ty.i64));
  // cap > len + 1 leaves room for the byte and the NUL, and implies a heap buffer.
  const room = b.icmp("ult", lenPlus1, cap);
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
  const grown = b.call(Ty.ptr, ctx.strReserveFn(), [strPtr, val("1", Ty.i64)]);
  ctx.emitAllocNullCheck(lines, grown.ref, "strgrow", expr.span);
  const slowEnd = b.newBlock("str.slowend");
  b.br(slowEnd);
  b.position(slowEnd);
  b.br(store);
  b.position(store);
  const cur = b.phi(Ty.ptr, [[data, fast], [grown, slowEnd]], true);
  const elemPtr = b.gep(Ty.i8, cur, [len]);
  b.store(val(byteVal, Ty.i8), elemPtr);
  b.store(lenPlus1, lenPtr);
  // null-terminate for FFI safety
  const nullPtr = b.gep(Ty.i8, cur, [lenPlus1]);
  b.store(val("0", Ty.i8), nullPtr);

  return [lines, "void", "void"];
}

// s.pushInt(n): n's digits written straight into s's buffer, no temporary.
export function genStringPushInt(ctx: StringCtx, expr: HIRExpr & { kind: "StringPushInt" }, lines: string[]): Gen {
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
export function genStringTruncate(ctx: StringCtx, expr: HIRExpr & { kind: "StringTruncate" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  const [strPtrLines, strPtrRef] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const strPtr = val(strPtrRef, Ty.ptr);
  let n = I64_0;
  if (expr.length) {
    const raw = val(ctx.genBoundI64(expr.length, lines), Ty.i64);
    const neg = b.icmp("slt", raw, I64_0);
    n = b.select(neg, I64_0, raw);
  }
  const dataPtr = stringField(b, strPtr, 0);
  const lenPtr = stringField(b, strPtr, 1);
  const capPtr = stringField(b, strPtr, 2);
  const len = b.load(Ty.i64, lenPtr);
  const noop = b.icmp("uge", n, len);
  const cut = b.newBlock("strtrunc.cut");
  const done = b.newBlock("strtrunc.done");
  b.condBr(noop, done, cut);
  b.position(cut);
  // The NUL written at the new end is a write; another handle must not see it.
  ctx.emitStrUnique(lines, strPtr.ref);
  const data = b.load(Ty.ptr, dataPtr);
  if (expr.length) {
    const at = b.gep(Ty.i8, data, [n]);
    const byte = b.load(Ty.i8, at);
    const hi = b.binop("and", byte, val("-64", Ty.i8));
    const inside = b.icmp("eq", hi, val("-128", Ty.i8));
    const bad = b.newBlock("strtrunc.mid");
    const ok = b.newBlock("strtrunc.ok");
    b.condBr(inside, bad, ok);
    b.position(bad);
    const { label: errLabel, length: errLen } = ctx.addString(
      `milo: truncate(%lld) lands inside a multibyte UTF-8 character; truncate takes a byte length that must end on a character boundary, at ${ctx.panicAt(expr.span)}\n`,
    );
    const errPtr = b.gep(Ty.of(`[${errLen} x i8]`), val(errLabel, Ty.ptr), [val("0", Ty.i32), val("0", Ty.i32)]);
    ctx.emitFdPrintf(lines, 2, errPtr.ref, `, i64 ${n.ref}`);
    ctx.panicAbort(lines);
    b.unreachable();
    b.position(ok);
  }
  const cap = b.load(Ty.i64, capPtr);
  const owned = b.icmp("ugt", cap, I64_0);
  const inPlace = b.newBlock("strtrunc.inplace");
  const copy = b.newBlock("strtrunc.copy");
  b.condBr(owned, inPlace, copy);
  b.position(inPlace);
  const end = b.gep(Ty.i8, data, [n]);
  b.store(val("0", Ty.i8), end);
  b.store(n, lenPtr);
  b.br(done);
  b.position(copy);
  ctx.needsMemcpy = true;
  const size = b.binop("add", n, val("1", Ty.i64));
  const buf = val(ctx.emitStrAlloc(lines, size.ref, "strtrunc", expr.span), Ty.ptr);
  b.callDiscard(Ty.ptr, "@memcpy", [buf, data, n]);
  const bend = b.gep(Ty.i8, buf, [n]);
  b.store(val("0", Ty.i8), bend);
  b.store(buf, dataPtr);
  b.store(n, lenPtr);
  b.store(size, capPtr);
  b.br(done);
  b.position(done);
  return [lines, "void", "void"];
}

// `s.setByte(i, b)`: the bounds test is unsigned and 64-bit, so a negative or huge
// index aborts instead of wrapping. A literal (cap 0) points into read-only data, so
// it is copied out to an owned buffer before the write, as truncate does.
export function genStringSetByte(ctx: StringCtx, expr: HIRExpr & { kind: "StringSetByte" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsBoundsCheck = true;
  const [strPtrLines, strPtrRef] = ctx.genLValue(expr.str);
  lines.push(...strPtrLines);
  const idx = val(ctx.genBoundI64(expr.index, lines), Ty.i64);
  const [bl, bv, bt] = ctx.genExpr(expr.byte);
  lines.push(...bl);
  const b = new LlvmTextBuilder(lines, ctx);
  const strPtr = val(strPtrRef, Ty.ptr);
  let byte = val(bv, Ty.of(bt));
  if (bt !== "i8") byte = b.cast("trunc", byte, Ty.i8);
  const dataPtr = stringField(b, strPtr, 0);
  const lenPtr = stringField(b, strPtr, 1);
  const capPtr = stringField(b, strPtr, 2);
  const len = b.load(Ty.i64, lenPtr);
  const inRange = b.icmp("ult", idx, len);
  const ok = b.newBlock("strsetbyte.ok");
  const fail = b.newBlock("strsetbyte.oob");
  b.condBr(inRange, ok, fail);
  b.position(fail);
  const filePtr = val(ctx.emitCheckFilePtr(lines, expr.span), Ty.ptr);
  b.callDiscard(Ty.void, "@__milo_bounds_fail", [idx, len, filePtr, val(String(expr.span?.line ?? 0), Ty.i32)]);
  b.unreachable();
  b.position(ok);
  ctx.emitStrUnique(lines, strPtr.ref);
  const cap = b.load(Ty.i64, capPtr);
  const owned = b.icmp("ugt", cap, I64_0);
  const write = b.newBlock("strsetbyte.write");
  const copy = b.newBlock("strsetbyte.copy");
  b.condBr(owned, write, copy);
  b.position(copy);
  ctx.needsMemcpy = true;
  const old = b.load(Ty.ptr, dataPtr);
  const size = b.binop("add", len, val("1", Ty.i64));
  const buf = val(ctx.emitStrAlloc(lines, size.ref, "strsetbyte", expr.span), Ty.ptr);
  b.callDiscard(Ty.ptr, "@memcpy", [buf, old, len]);
  const bend = b.gep(Ty.i8, buf, [len]);
  b.store(val("0", Ty.i8), bend);
  b.store(buf, dataPtr);
  b.store(size, capPtr);
  b.br(write);
  b.position(write);
  const data = b.load(Ty.ptr, dataPtr);
  const at = b.gep(Ty.i8, data, [idx]);
  b.store(byte, at);
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
export function genStringSubstr(ctx: StringCtx, expr: HIRExpr & { kind: "StringSubstr" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;

  const [strLines, strVal] = ctx.genExpr(expr.str);
  lines.push(...strLines);
  const startVal = ctx.genBoundI64(expr.start, lines);
  const endVal = ctx.genBoundI64(expr.end, lines);

  ctx.emitStringRangeCheck(lines, startVal, endVal, strVal, "substr", expr.span);

  const b = new LlvmTextBuilder(lines, ctx);
  const start = val(startVal, Ty.i64);
  const subLen = b.binop("sub", val(endVal, Ty.i64), start);

  const allocLen = b.binop("add", subLen, val("1", Ty.i64));
  const buf = val(ctx.emitStrAlloc(lines, allocLen.ref, "substr", expr.span), Ty.ptr);

  const srcPtr = b.extractvalue(val(strVal, STRING), 0, Ty.ptr);
  const srcOff = b.gep(Ty.i8, srcPtr, [start]);
  b.callDiscard(Ty.ptr, "@memcpy", [buf, srcOff, subLen]);

  const nullPtr = b.gep(Ty.i8, buf, [subLen]);
  b.store(val("0", Ty.i8), nullPtr);

  const s = makeString(b, buf, subLen, allocLen);

  // substr COPIES out of its receiver, so nothing points into it afterwards and a
  // temporary receiver can go: `big(i).substr(0, 100).len` leaked the whole receiver on
  // every call. Same shape as the Vec/HashMap/StringLen receiver drops.
  ctx.dropOwnedTemp(lines, strVal, "%String", expr.str);
  return asGen(lines, s);
}

// String.slice(start, end) — zero-copy view. Non-owning %String with cap=0.
export function genStringSlice(ctx: StringCtx, expr: HIRExpr & { kind: "StringSlice" }, lines: string[]): Gen {
  ctx.hasStringType = true;

  const [strLines, strVal] = ctx.genExpr(expr.str);
  lines.push(...strLines);
  const startVal = ctx.genBoundI64(expr.start, lines);
  const endVal = ctx.genBoundI64(expr.end, lines);

  ctx.emitStringRangeCheck(lines, startVal, endVal, strVal, "slice", expr.span);

  const b = new LlvmTextBuilder(lines, ctx);
  const subLen = b.binop("sub", val(endVal, Ty.i64), val(startVal, Ty.i64));

  const srcPtr = b.extractvalue(val(strVal, STRING), 0, Ty.ptr);
  const slicePtr = b.gep(Ty.i8, srcPtr, [val(startVal, Ty.i64)]);

  return asGen(lines, makeString(b, slicePtr, subLen, I64_0));
}

// n.toString() / x.toString(): an owned %String; ints through @milo.fmt.*, floats through @milo.fmt.f64
export function genNumberToString(ctx: StringCtx, expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): Gen {
  ctx.needsMalloc = true;
  ctx.hasStringType = true;

  const [vLines, vVal, vTy] = ctx.genExpr(expr.value);
  lines.push(...vLines);

  const b = new LlvmTextBuilder(lines, ctx);
  const vt = expr.valueType;
  if (vt.tag === "int") {
    // 24 bytes holds any 64-bit decimal (20 digits with the sign) and the NUL.
    const buf = val(ctx.emitStrAlloc(lines, "24", "itos", expr.span), Ty.ptr);
    const n = val(ctx.emitIntFmt(lines, buf.ref, vVal, vTy, vt), Ty.i64);
    const nul = b.gep(Ty.i8, buf, [n]);
    b.store(val("0", Ty.i8), nul);
    return asGen(lines, makeString(b, buf, n, val("24", Ty.i64)));
  }
  // Floats don't go through snprintf directly: they need the round-trip
  // search in @milo.fmt.f64, which already writes an owned buffer we can
  // hand straight to %String.
  const { buf, len } = ctx.emitFloatToBuf(vVal, vt.tag === "float" ? vt.bits : 64, lines, true);
  return asGen(lines, makeString(b, val(buf, Ty.ptr), val(len, Ty.i64), val(String(F64_BUF), Ty.i64)));
}

export function genBoolToString(ctx: StringCtx, expr: HIRExpr & { kind: "BoolToString" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  const [vLines, vVal] = ctx.genExpr(expr.value);
  lines.push(...vLines);
  const trueStr = ctx.addString("true");
  const falseStr = ctx.addString("false");
  const b = new LlvmTextBuilder(lines, ctx);
  const v = val(vVal, Ty.i1);
  const ptr = b.select(v, val(trueStr.label, Ty.ptr), val(falseStr.label, Ty.ptr));
  const len = b.select(v, val("4", Ty.i64), val("5", Ty.i64));
  return asGen(lines, makeString(b, ptr, len, I64_0));
}

// s.clone() — deep copy of the underlying byte buffer; result is an owned %String
export function genStringClone(ctx: StringCtx, expr: HIRExpr & { kind: "StringClone" }, lines: string[]): Gen {
  ctx.hasStringType = true;
  ctx.needsMalloc = true;
  ctx.needsMemcpy = true;
  const passed = ctx.cloneOfOwnedTemp(expr.str, lines);
  if (passed) return passed;
  const [sLines, sVal] = ctx.genExpr(expr.str);
  lines.push(...sLines);
  return [lines, ctx.emitStrShare(lines, sVal), "%String"];
}

export function genStringFind(ctx: StringCtx, expr: HIRExpr & { kind: "StringFind" }, lines: string[]): Gen {
  const enumTy = `%${expr.optionEnumName}`;
  const enumT = Ty.of(enumTy);
  const layout = ctx.enumLayouts.get(expr.optionEnumName);
  const noneVariant = layout?.variants.get("None");
  const someVariant = layout?.variants.get("Some");
  if (!layout || !noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

  const b = new LlvmTextBuilder(lines, ctx);
  const [strLines, strValue] = ctx.genExpr(expr.str);
  const [needleLines, needleValue] = ctx.genExpr(expr.needle);
  lines.push(...strLines);
  const strPtr = b.entryAlloca(`%__string_find_haystack.${ctx.scopeCounter++}.addr`, STRING);
  b.store(val(strValue, STRING), strPtr);
  lines.push(...needleLines);
  const needlePtr = b.entryAlloca(`%__string_find_needle.${ctx.scopeCounter++}.addr`, STRING);
  b.store(val(needleValue, STRING), needlePtr);
  let fn = expr.reverse ? "strLastIndexOf" : "strIndexOf";
  const args = [strPtr, needlePtr];
  if (expr.from) {
    const [fromLines, fromValue, fromTy] = ctx.genExpr(expr.from);
    lines.push(...fromLines);
    fn = "strIndexOfFrom";
    args.push(val(fromValue, Ty.of(fromTy)));
  }
  const index = b.call(Ty.i64, `@${fn}`, args);

  const resultAddr = b.entryAlloca(`%__string_find_result.${ctx.scopeCounter++}.addr`, enumT);
  b.store(val("zeroinitializer", enumT), resultAddr);
  const found = b.icmp("sge", index, I64_0);
  const some = b.newBlock("string.find.some");
  const none = b.newBlock("string.find.none");
  const end = b.newBlock("string.find.end");
  b.condBr(found, some, none);
  b.position(none);
  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, noneVariant.tag);
  b.br(end);
  b.position(some);
  ctx.storeEnumTag(lines, enumTy, resultAddr.ref, someVariant.tag);
  const payloadPtr = ctx.enumPayloadPtr(lines, enumTy, resultAddr.ref, someVariant);
  b.store(index, val(payloadPtr, Ty.ptr));
  b.br(end);
  b.position(end);
  const result = b.load(enumT, resultAddr);
  // indexOf/indexOfFrom/lastIndexOf read both operands and answer an INDEX, so nothing
  // points into either by the time we get here and both can go now — no deferral to
  // argTempDrops needed. `s.indexOf("o" + i.toString())` leaked its needle per call, and
  // `("pre" + i.toString()).indexOf("r")` leaked the receiver as well.
  ctx.dropOwnedTemp(lines, strValue, "%String", expr.str);
  ctx.dropOwnedTemp(lines, needleValue, "%String", expr.needle);
  return asGen(lines, result);
}
