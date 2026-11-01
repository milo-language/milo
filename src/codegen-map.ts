// HashMap/Set lowering (new, insert, get, probe, remove, clear, clone, entries) and the
// FNV-1a hashing and key equality it emits, extracted to keep codegen.ts manageable.
// std/set's HashSet is a HashMap<T, bool> underneath, so sets lower through here too.

import type { HIRExpr } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { OwnLedger } from "./codegen-own";
import type { Gen, StructLayout } from "./codegen";
import { LlvmTextBuilder, Ty, val, asGen, type Builder, type Val } from "./ir";

// %HashMap field indices. The struct is { data, len, cap, seed, tombs }, and these offsets
// appeared as bare `i32 0, i32 N` at 22 sites in codegen.ts — the only clue to which field
// an N meant was the local variable name at the use site, so adding a field meant finding
// and re-reading every one of them.
export const HM_DATA = 0;
export const HM_LEN = 1;
export const HM_CAP = 2;
export const HM_SEED = 3;
// Deleted slots, counted so the resize trigger can see them. Without it a table can reach
// a state where every slot is occupied-or-tombstone, and a probe that stops only at an
// EMPTY slot would never terminate.
export const HM_TOMBS = 4;
// Field count of %HashMap, and the single source for its size. Every field is 8 bytes
// (one ptr + four i64), so the size is just the count — but the COUNT has to come from
// one place or the two drift, which is exactly what happened.
export const HASHMAP_FIELDS = 5;

// The lazily-seeded hash seed function: codegen.ts defines it, every probe here calls it.
export const HASH_SEED_FN = "__milo_hash_seed";

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this — they are not part of its external API.
export interface CodegenMapCtx {
  nextTemp(): string;
  nextLabel(prefix?: string): string;
  llvmType(t: TypeKind): string;
  genVal(expr: HIRExpr, lines: string[], sretDest?: string): Val;
  genLValue(expr: HIRExpr): Gen;
  hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string;
  needsDropCg(t: TypeKind): boolean;
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }): void;
  own: OwnLedger;
  structLayouts: Map<string, StructLayout>;
  hasHashMapType: boolean;
  hasStringType: boolean;
  needsMalloc: boolean;
  needsMemset: boolean;
  needsMemcmp: boolean;
  needsGetentropy: boolean;
}

const i64c = (n: number): Val => val(String(n), Ty.i64);
const i32c = (n: number): Val => val(String(n), Ty.i32);
const HASHMAP_TY = Ty.of("%HashMap");

// sizeof(entry) as an i64, via the null-GEP idiom.
function entrySizeOf(b: Builder, entryTy: Ty): Val {
  const p = b.gep(entryTy, val("null", Ty.ptr), [i32c(1)]);
  return b.cast("ptrtoint", p, Ty.i64);
}

function fnvHash(ctx: CodegenMapCtx, b: Builder, key: Val, keyType: TypeKind, seed: Val): Val {
  // FNV-1a: hash = offset_basis ^ seed; then fold the key's bytes in.
  const h0 = b.binop("xor", val("14695981039346656037", Ty.i64), seed);
  return hashInto(ctx, b, h0, key, keyType);
}

// Fold `v`'s bytes into the running FNV-1a accumulator `acc`, returning the new
// accumulator. Structs recurse field-by-field over the *same* recursion that derives
// equality — so `a == b ⟹ hash(a) == hash(b)` holds by construction (the eq–hash
// coherence law). Hash values are NOT stable across compiler versions or runs (the
// table seed varies): never persist them or put them on the wire.
function hashInto(ctx: CodegenMapCtx, b: Builder, acc: Val, v: Val, type: TypeKind): Val {
  const prime = val("1099511628211", Ty.i64);

  if (type.tag === "bool") {
    const byte = b.cast("zext", v, Ty.i64);
    return b.binop("mul", b.binop("xor", acc, byte), prime);
  }

  if (type.tag === "int") {
    const val64 = type.bits === 64 ? v : b.cast(type.signed ? "sext" : "zext", v, Ty.i64);
    // unrolled 8-byte FNV-1a
    let hash = acc;
    for (let i = 0; i < 8; i++) {
      const shifted = b.binop("lshr", val64, val(String(i * 8), Ty.i64));
      const byte = b.binop("and", shifted, val("255", Ty.i64));
      hash = b.binop("mul", b.binop("xor", hash, byte), prime);
    }
    return hash;
  }

  if (type.tag === "string") {
    ctx.hasStringType = true;
    const strData = b.extractvalue(v, 0, Ty.ptr);
    const strLen = b.extractvalue(v, 1, Ty.i64);
    const iAddr = b.alloca(Ty.i64);
    b.store(val("0", Ty.i64), iAddr);
    const hAddr = b.alloca(Ty.i64);
    b.store(acc, hAddr);
    const cond = b.newBlock("fnv.cond");
    const body = b.newBlock("fnv.body");
    const end = b.newBlock("fnv.end");
    b.br(cond);
    b.position(cond);
    const iVal = b.load(Ty.i64, iAddr);
    b.condBr(b.icmp("ult", iVal, strLen), body, end);
    b.position(body);
    const bytePtr = b.gep(Ty.i8, strData, [iVal]);
    const byte64 = b.cast("zext", b.load(Ty.i8, bytePtr), Ty.i64);
    const curH = b.load(Ty.i64, hAddr);
    b.store(b.binop("mul", b.binop("xor", curH, byte64), prime), hAddr);
    b.store(b.binop("add", iVal, val("1", Ty.i64)), iAddr);
    b.br(cond);
    b.position(end);
    return b.load(Ty.i64, hAddr);
  }

  if (type.tag === "struct") {
    const layout = ctx.structLayouts.get(type.name);
    if (!layout) throw new Error(`hash: unknown struct layout '${type.name}'`);
    let hash = acc;
    for (let i = 0; i < layout.fields.length; i++) {
      const fieldTy = layout.fields[i].typeKind;
      const fieldVal = b.extractvalue(v, i, Ty.of(ctx.llvmType(fieldTy)));
      hash = hashInto(ctx, b, hash, fieldVal, fieldTy);
    }
    return hash;
  }

  throw new Error(`unhashable key type: ${type.tag}`);
}

function keysEqual(ctx: CodegenMapCtx, b: Builder, k1: Val, k2: Val, keyType: TypeKind): Val {
  if (keyType.tag === "int" || keyType.tag === "bool") {
    return b.icmp("eq", k1, k2);
  }
  if (keyType.tag === "string") {
    ctx.needsMemcmp = true;
    const aLen = b.extractvalue(k1, 1, Ty.i64);
    const bLen = b.extractvalue(k2, 1, Ty.i64);
    const lenEq = b.icmp("eq", aLen, bLen);
    const cmpData = b.newBlock("keycmp.data");
    const cmpFalse = b.newBlock("keycmp.ne");
    const cmpDone = b.newBlock("keycmp.done");
    b.condBr(lenEq, cmpData, cmpFalse);
    b.position(cmpData);
    const aData = b.extractvalue(k1, 0, Ty.ptr);
    const bData = b.extractvalue(k2, 0, Ty.ptr);
    const cmpResult = b.call(Ty.i32, "@memcmp", [aData, bData, aLen]);
    const dataEq = b.icmp("eq", cmpResult, val("0", Ty.i32));
    b.br(cmpDone);
    b.position(cmpFalse);
    b.br(cmpDone);
    b.position(cmpDone);
    return b.phi(Ty.i1, [[dataEq, cmpData], [val("false", Ty.i1), cmpFalse]]);
  }
  if (keyType.tag === "struct") {
    // Structural equality — the same field recursion that hashing folds over, so the
    // eq–hash coherence law holds by construction.
    const layout = ctx.structLayouts.get(keyType.name);
    if (!layout) throw new Error(`compare: unknown struct layout '${keyType.name}'`);
    let acc: Val | null = null;
    for (let i = 0; i < layout.fields.length; i++) {
      const fieldTk = layout.fields[i].typeKind;
      const fieldTy = Ty.of(ctx.llvmType(fieldTk));
      const f1 = b.extractvalue(k1, i, fieldTy);
      const f2 = b.extractvalue(k2, i, fieldTy);
      const fieldEq = keysEqual(ctx, b, f1, f2, fieldTk);
      acc = acc === null ? fieldEq : b.binop("and", acc, fieldEq);
    }
    return acc ?? val("true", Ty.i1); // a fieldless struct compares equal vacuously
  }
  throw new Error(`uncomparable key type: ${keyType.tag}`);
}

export function genHashMapNew(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapNew" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  ctx.needsMalloc = true;
  const b = new LlvmTextBuilder(lines, ctx);
  const entryTy = Ty.of(ctx.hashMapEntryType(expr.keyType, expr.valueType));
  // allocate initial 8 entries, zeroed
  const entrySize = b.gep(entryTy, val("null", Ty.ptr), [val("1", Ty.i32)]);
  const entrySizeI = b.cast("ptrtoint", entrySize, Ty.i64);
  const { buf, bytes } = ctx.emitAllocBytes(lines, entrySizeI.ref, 8, "hmnew", expr.span);
  ctx.needsMemset = true;
  b.callDiscard(Ty.ptr, "@memset", [val(buf, Ty.ptr), val("0", Ty.i32), val(bytes, Ty.i64)]);

  const zero = val("0", Ty.i64);
  let m = b.insertvalue(val("undef", Ty.of("%HashMap")), val(buf, Ty.ptr), HM_DATA);
  m = b.insertvalue(m, zero, HM_LEN);
  m = b.insertvalue(m, val("8", Ty.i64), HM_CAP);
  // seed = 0 (lazy init on first insert)
  m = b.insertvalue(m, zero, HM_SEED);
  m = b.insertvalue(m, zero, HM_TOMBS);
  return asGen(lines, m);
}

// HashMap.withCapacity(n): pre-size the table so inserting n entries never rehashes.
// Insert grows when (len+1)*4 >= cap*3, so the table must hold cap > 4(n+1)/3; the
// loop rounds that up to a power of two (the mask-based probe requires one).
export function genHashMapWithCapacity(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapWithCapacity" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  ctx.needsMalloc = true;
  ctx.needsMemset = true;
  const entryTy = Ty.of(ctx.hashMapEntryType(expr.keyType, expr.valueType));
  const b = new LlvmTextBuilder(lines, ctx);
  const nRef = ctx.genVal(expr.capacity, lines);
  ctx.emitNonNegativeCheck(lines, nRef.ref, "capacity", expr.span);
  const nVal = val(nRef.ref, Ty.i64);

  const nPlus1 = b.binop("add", nVal, i64c(1));
  const scaled = b.binop("mul", nPlus1, i64c(4));
  const wantDiv = b.binop("udiv", scaled, i64c(3));
  const want = b.binop("add", wantDiv, i64c(1));

  const capSlot = b.alloca(Ty.i64);
  b.store(i64c(8), capSlot);
  const roundCond = b.newBlock("hmwc.cond");
  const roundBody = b.newBlock("hmwc.body");
  const roundEnd = b.newBlock("hmwc.end");
  b.br(roundCond);
  b.position(roundCond);
  const curCap = b.load(Ty.i64, capSlot);
  const tooSmall = b.icmp("ult", curCap, want);
  b.condBr(tooSmall, roundBody, roundEnd);
  b.position(roundBody);
  const dbl = b.binop("shl", curCap, i64c(1));
  b.store(dbl, capSlot);
  b.br(roundCond);
  b.position(roundEnd);
  const cap = b.load(Ty.i64, capSlot);

  const entrySizeI = entrySizeOf(b, entryTy);
  const { buf: dataPtr, bytes: totalSize } = ctx.emitAllocBytes(lines, entrySizeI.ref, cap.ref, "hmwith", expr.span);
  b.callDiscard(Ty.ptr, "@memset", [val(dataPtr, Ty.ptr), i32c(0), val(totalSize, Ty.i64)]);

  let m = b.insertvalue(val("undef", HASHMAP_TY), val(dataPtr, Ty.ptr), HM_DATA);
  m = b.insertvalue(m, i64c(0), HM_LEN);
  m = b.insertvalue(m, cap, HM_CAP);
  m = b.insertvalue(m, i64c(0), HM_SEED);
  m = b.insertvalue(m, i64c(0), HM_TOMBS);
  return asGen(lines, m);
}

// The std/hashmap intrinsics: the same hash and key comparison the builtin methods above
// emit, so a method moved into std probes the same slots and matches the same keys. The
// key operands are places; loading them bitwise (as the probe loads a stored key) keeps
// a string key's refcount untouched.
function loadKeyPlace(ctx: CodegenMapCtx, b: Builder, lines: string[], expr: HIRExpr): { key: Val; keyType: TypeKind } {
  const keyType = expr.type.tag === "ref" ? expr.type.inner : expr.type;
  const [placeLines, ptr] = ctx.genLValue(expr);
  lines.push(...placeLines);
  return { key: b.load(Ty.of(ctx.llvmType(keyType)), val(ptr, Ty.ptr)), keyType };
}

export function genMapHash(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "MapHash" }, lines: string[]): Gen {
  const b = new LlvmTextBuilder(lines, ctx);
  const { key, keyType } = loadKeyPlace(ctx, b, lines, expr.key);
  const seed = ctx.genVal(expr.seed, lines);
  return asGen(lines, fnvHash(ctx, b, key, keyType, val(seed.ref, Ty.i64)));
}

export function genMapKeyEq(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "MapKeyEq" }, lines: string[]): Gen {
  const b = new LlvmTextBuilder(lines, ctx);
  const a = loadKeyPlace(ctx, b, lines, expr.a);
  const c = loadKeyPlace(ctx, b, lines, expr.b);
  return asGen(lines, keysEqual(ctx, b, a.key, c.key, a.keyType));
}

export function genMapCopyOut(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "MapCopyOut" }, lines: string[]): Gen {
  const [placeLines, ptr] = ctx.genLValue(expr.value);
  lines.push(...placeLines);
  // Deep-clone, don't `load`: a shallow copy aliases the map's heap, and a later
  // `insert` on the same key drops the old value out from under it (the copy-back
  // idiom `let v = m.get(k); v.x = 1; m.insert(k, v)`). Degrades to a load for Copy types.
  return asGen(lines, val(ctx.emitDeepCloneFromPtr(lines, ptr, expr.type), Ty.of(ctx.llvmType(expr.type))));
}

export function genMapSeed(ctx: CodegenMapCtx, lines: string[]): Gen {
  ctx.needsGetentropy = true;
  const b = new LlvmTextBuilder(lines, ctx);
  return asGen(lines, b.call(Ty.i64, `@${HASH_SEED_FN}`, []));
}

export function genMapAlloc(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "MapAlloc" }, lines: string[]): Gen {
  const count = ctx.genVal(expr.count, lines);
  const size = ctx.genVal(expr.size, lines);
  const { buf, bytes } = ctx.emitAllocBytes(lines, count.ref, size.ref, "hmalloc", expr.span);
  ctx.needsMemset = true;
  const b = new LlvmTextBuilder(lines, ctx);
  b.callDiscard(Ty.ptr, "@memset", [val(buf, Ty.ptr), i32c(0), val(bytes, Ty.i64)]);
  return asGen(lines, val(buf, Ty.ptr));
}
