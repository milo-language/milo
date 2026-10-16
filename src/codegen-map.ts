// HashMap/Set lowering (new, insert, get, probe, remove, clear, clone, entries) and the
// FNV-1a hashing and key equality it emits, extracted to keep codegen.ts manageable.
// std/set's HashSet is a HashMap<T, bool> underneath, so sets lower through here too.

import type { HIRExpr } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { OwnEndKind } from "./own-ledger";
import type { Gen, StructLayout, EnumLayout, EnumVariant } from "./codegen";
import { must } from "./must";
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
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: HIRExpr, sretDest?: string): Gen;
  genLValue(expr: HIRExpr): Gen;
  hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string;
  needsDropCg(t: TypeKind): boolean;
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  dropConsumedArg(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  cloneOfOwnedTemp(src: HIRExpr, lines: string[]): Gen | null;
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }): void;
  storeEnumTag(lines: string[], enumTy: string, addr: string, tag: number | string): void;
  enumPayloadPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number): string;
  ownEndVal(lines: string[], val: string, kind: OwnEndKind): void;
  ownValToSlot(val: string, addr: string): void;
  structLayouts: Map<string, StructLayout>;
  enumLayouts: Map<string, EnumLayout>;
  hasHashMapType: boolean;
  hasVecType: boolean;
  hasStringType: boolean;
  needsMalloc: boolean;
  needsFree: boolean;
  needsMemset: boolean;
  needsMemcmp: boolean;
  needsGetentropy: boolean;
}

const i64c = (n: number): Val => val(String(n), Ty.i64);
const i32c = (n: number): Val => val(String(n), Ty.i32);
const i8c = (n: number): Val => val(String(n), Ty.i8);
const HASHMAP_TY = Ty.of("%HashMap");

// Address of field `idx` of the %HashMap at `map`.
function hmField(b: Builder, map: Val, idx: number): Val {
  return b.gep(HASHMAP_TY, map, [i32c(0), i32c(idx)]);
}

// Address of field `idx` (1 = key, 2 = value; 0 is the state byte) of a map entry.
function entryField(b: Builder, entryTy: Ty, entry: Val, idx: number): Val {
  return b.gep(entryTy, entry, [i32c(0), i32c(idx)]);
}

// sizeof(entry) as an i64, via the null-GEP idiom.
function entrySizeOf(b: Builder, entryTy: Ty): Val {
  const p = b.gep(entryTy, val("null", Ty.ptr), [i32c(1)]);
  return b.cast("ptrtoint", p, Ty.i64);
}

// slotAddr = (slot + 1) & mask
function probeAdvance(b: Builder, slot: Val, mask: Val, slotAddr: Val): void {
  const next = b.binop("add", slot, i64c(1));
  const wrapped = b.binop("and", next, mask);
  b.store(wrapped, slotAddr);
}

function emitFnvHash(ctx: CodegenMapCtx, lines: string[], keyVal: string, keyType: TypeKind, seedReg: string): string {
  const b = new LlvmTextBuilder(lines, ctx);
  return fnvHash(ctx, b, val(keyVal, Ty.of(ctx.llvmType(keyType))), keyType, val(seedReg, Ty.i64)).ref;
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

function emitKeyCompare(ctx: CodegenMapCtx, lines: string[], k1: string, k2: string, keyType: TypeKind): string {
  const ty = Ty.of(ctx.llvmType(keyType));
  return keysEqual(ctx, new LlvmTextBuilder(lines, ctx), val(k1, ty), val(k2, ty), keyType).ref;
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

// The address of a map for a keyed operation.
//
// genLValue answers the literal "null" for anything that is not a place, so a lookup on
// a TEMPORARY receiver — `makeMap().contains(k)`, `parseHeaders(s).get(k)` — GEP'd from
// null, read a capacity out of low memory, and then probed. The probe only stops at an
// empty slot, so with a garbage capacity it never stopped: a HANG out of ordinary safe
// code, not a wrong answer. Every keyed op had it, at every revision.
//
// A temporary has no address until we give it one. Materialize it into a slot and tell
// the caller to drop that slot when the lookup is done — it is an owned value nobody
// else will ever free.
function mapReceiverPtr(ctx: CodegenMapCtx, lines: string[], mapExpr: HIRExpr): { ptr: string; tempSlot: string | null } {
  const [ptrLines, ptr] = ctx.genLValue(mapExpr);
  lines.push(...ptrLines);
  if (ptr !== "null") return { ptr, tempSlot: null };
  const [exprLines, exprVal, exprTy] = ctx.genExpr(mapExpr);
  lines.push(...exprLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const slot = b.alloca(Ty.of(exprTy));
  b.store(val(exprVal, Ty.of(exprTy)), slot);
  ctx.ownValToSlot(exprVal, slot.ref);
  return { ptr: slot.ref, tempSlot: slot.ref };
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

export function genHashMapInsert(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapInsert" }, lines: string[]): Gen {
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapInsert on non-hashmap");
  // get pointer to map
  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, expr.map);

  // eval key and value
  const [keyLines, keyVal] = ctx.genExpr(expr.key);
  lines.push(...keyLines);
  const [valLines, valVal] = ctx.genExpr(expr.value);
  lines.push(...valLines);
  emitHashMapInsertValues(ctx, lines, mapPtr, mapType, keyVal, valVal, expr.span);
  ctx.ownEndVal(lines, keyVal, "STORE"); ctx.ownEndVal(lines, valVal, "STORE");
  // Inserting into a temporary is pointless but legal, and the temporary still leaks
  // without ctx.
  if (mapTempSlot) ctx.emitDropValue(lines, mapTempSlot, mapType);
  return [lines, "0", "void"];
}

// The insert proper, on an already-evaluated key and value: seed, grow, probe, store.
// `getOrInsertWith` reaches it with a value its init closure produced after its own
// probe missed; the key was evaluated once, up front, for both probes.
function emitHashMapInsertValues(ctx: CodegenMapCtx, lines: string[], mapPtr: string, mapType: TypeKind & { tag: "hashmap" }, keyVal: string, valVal: string, span?: Span): void {
  ctx.hasHashMapType = true;
  ctx.needsMalloc = true;
  ctx.needsFree = true;
  ctx.needsGetentropy = true;

  const keyType = mapType.key;
  const valueType = mapType.value;
  const keyTy = Ty.of(ctx.llvmType(keyType));
  const valTy = Ty.of(ctx.llvmType(valueType));
  const entryTy = Ty.of(ctx.hashMapEntryType(keyType, valueType));
  const b = new LlvmTextBuilder(lines, ctx);
  const map = val(mapPtr, Ty.ptr);
  const key = val(keyVal, keyTy);
  const value = val(valVal, valTy);

  // lazy seed init
  const seedPtr = hmField(b, map, HM_SEED);
  const seed = b.load(Ty.i64, seedPtr);
  const seedIsZero = b.icmp("eq", seed, i64c(0));
  const initLabel = b.newBlock("seed.init");
  const haveLabel = b.newBlock("seed.have");
  const preLabel = b.newBlock("seed.pre");
  b.br(preLabel);
  b.position(preLabel);
  b.condBr(seedIsZero, initLabel, haveLabel);
  b.position(initLabel);
  const newSeed = b.call(Ty.i64, `@${HASH_SEED_FN}`, []);
  const isStillZero = b.icmp("eq", newSeed, i64c(0));
  const finalSeed = b.select(isStillZero, val("14695981039346656037", Ty.i64), newSeed);
  b.store(finalSeed, seedPtr);
  b.br(haveLabel);
  b.position(haveLabel);
  const activeSeed = b.phi(Ty.i64, [[seed, preLabel], [finalSeed, initLabel]]);

  // load cap and len
  const lenPtr = hmField(b, map, HM_LEN);
  const len = b.load(Ty.i64, lenPtr);
  const capPtr = hmField(b, map, HM_CAP);
  const cap = b.load(Ty.i64, capPtr);
  const dataFieldPtr = hmField(b, map, HM_DATA);

  // resize check: (len + tombstones + 1) * 4 >= cap * 3
  //
  // Tombstones are counted, not just live entries. A probe below stops only at an EMPTY
  // slot, so the table must always have one; a load factor computed from `len` alone
  // lets insert/remove churn tombstone every slot while len stays near zero, and then
  // no probe terminates. Rehashing drops tombstones, which is what makes this the fix
  // for both that and the duplicate-key bug.
  const tombsPtr = hmField(b, map, HM_TOMBS);
  const tombs = b.load(Ty.i64, tombsPtr);
  const lenPlusTombs = b.binop("add", len, tombs);
  const lenPlus1 = b.binop("add", lenPlusTombs, i64c(1));
  const lhs = b.binop("mul", lenPlus1, i64c(4));
  const rhs = b.binop("mul", cap, i64c(3));
  const needResize = b.icmp("uge", lhs, rhs);
  const resizeLabel = b.newBlock("hm.resize");
  const insertLabel = b.newBlock("hm.insert");
  b.condBr(needResize, resizeLabel, insertLabel);

  // resize block
  b.position(resizeLabel);
  const newCap = b.binop("shl", cap, i64c(1)); // cap * 2
  const entrySizeI = entrySizeOf(b, entryTy);
  const { buf: newDataRef, bytes: newTotalSize } = ctx.emitAllocBytes(lines, entrySizeI.ref, newCap.ref, "hmresize", span);
  const newData = val(newDataRef, Ty.ptr);
  ctx.needsMemset = true;
  b.callDiscard(Ty.ptr, "@memset", [newData, i32c(0), val(newTotalSize, Ty.i64)]);
  // rehash all occupied entries from old data
  const oldData = b.load(Ty.ptr, dataFieldPtr);
  const rehashCond = b.newBlock("rehash.cond");
  const rehashBody = b.newBlock("rehash.body");
  const rehashEnd = b.newBlock("rehash.end");
  const riAddr = b.alloca(Ty.i64);
  b.store(i64c(0), riAddr);
  b.br(rehashCond);
  b.position(rehashCond);
  const ri = b.load(Ty.i64, riAddr);
  const riCmp = b.icmp("ult", ri, cap);
  b.condBr(riCmp, rehashBody, rehashEnd);
  b.position(rehashBody);
  const oldEntryPtr = b.gep(entryTy, oldData, [ri]);
  const oldState = b.load(Ty.i8, oldEntryPtr);
  const isOccupied = b.icmp("eq", oldState, i8c(1));
  const rehashInsert = b.newBlock("rehash.ins");
  const rehashNext = b.newBlock("rehash.next");
  b.condBr(isOccupied, rehashInsert, rehashNext);
  b.position(rehashInsert);
  // load key from old entry
  const oldKeyPtr = entryField(b, entryTy, oldEntryPtr, 1);
  const oldKey = b.load(keyTy, oldKeyPtr);
  // load value from old entry
  const oldValPtr = entryField(b, entryTy, oldEntryPtr, 2);
  const oldVal = b.load(valTy, oldValPtr);
  // hash key with new mask
  const rehashHash = fnvHash(ctx, b, oldKey, keyType, activeSeed);
  const newMask = b.binop("sub", newCap, i64c(1));
  // probe in new array
  const rjAddr = b.alloca(Ty.i64);
  const rehashSlot0 = b.binop("and", rehashHash, newMask);
  b.store(rehashSlot0, rjAddr);
  const rehashProbeCond = b.newBlock("rehash.probe");
  b.br(rehashProbeCond);
  b.position(rehashProbeCond);
  const rj = b.load(Ty.i64, rjAddr);
  const newEntryPtr = b.gep(entryTy, newData, [rj]);
  const newState = b.load(Ty.i8, newEntryPtr);
  const newEmpty = b.icmp("eq", newState, i8c(0));
  const rehashStore = b.newBlock("rehash.store");
  const rehashProbeNext = b.newBlock("rehash.pnext");
  b.condBr(newEmpty, rehashStore, rehashProbeNext);
  b.position(rehashStore);
  b.store(i8c(1), newEntryPtr);
  const newKeyPtr = entryField(b, entryTy, newEntryPtr, 1);
  b.store(oldKey, newKeyPtr);
  const newValPtr = entryField(b, entryTy, newEntryPtr, 2);
  b.store(oldVal, newValPtr);
  b.br(rehashNext);
  b.position(rehashProbeNext);
  probeAdvance(b, rj, newMask, rjAddr);
  b.br(rehashProbeCond);
  b.position(rehashNext);
  const riNext = b.binop("add", ri, i64c(1));
  b.store(riNext, riAddr);
  b.br(rehashCond);
  b.position(rehashEnd);
  // free old data, update map fields
  b.callDiscard(Ty.void, "@free", [oldData]);
  b.store(newData, dataFieldPtr);
  b.store(newCap, capPtr);
  // The rehash loop above relocates occupied slots only, so the new table has none.
  b.store(i64c(0), tombsPtr);
  b.br(insertLabel);

  // insert block — probe for slot
  b.position(insertLabel);
  const curCap = b.load(Ty.i64, capPtr);
  const curData = b.load(Ty.ptr, dataFieldPtr);
  const curSeed = b.load(Ty.i64, seedPtr);
  const hash = fnvHash(ctx, b, key, keyType, curSeed);
  const mask = b.binop("sub", curCap, i64c(1));
  const slotAddr = b.alloca(Ty.i64);
  const slot0 = b.binop("and", hash, mask);
  b.store(slot0, slotAddr);

  const probeCond = b.newBlock("hm.probe");
  const probeOccupied = b.newBlock("hm.occupied");
  const probeEmpty = b.newBlock("hm.empty");
  const probeNext = b.newBlock("hm.pnext");
  const insertDone = b.newBlock("hm.done");
  const probeNotOcc = b.newBlock("hm.notocc");
  const probeTomb = b.newBlock("hm.tomb");
  const probeTombRecord = b.newBlock("hm.tombrec");

  // Where to put the entry if the key turns out to be absent: the FIRST tombstone
  // passed on the way, or the empty slot that ends the probe. -1 = none seen yet.
  // Stopping at a tombstone instead of remembering it is what let `insert` write a
  // second copy of a key that already existed further along the chain.
  const firstTombAddr = b.alloca(Ty.i64);
  b.store(i64c(-1), firstTombAddr);

  b.br(probeCond);
  b.position(probeCond);
  const slot = b.load(Ty.i64, slotAddr);
  const entryPtr = b.gep(entryTy, curData, [slot]);
  const state = b.load(Ty.i8, entryPtr);
  // state == 1 (occupied) -> check key
  const stateIsOccupied = b.icmp("eq", state, i8c(1));
  b.condBr(stateIsOccupied, probeOccupied, probeNotOcc);

  // not occupied: either a tombstone to remember and probe past, or the empty slot
  // that proves the key is absent.
  b.position(probeNotOcc);
  const stateIsTomb = b.icmp("eq", state, i8c(2));
  b.condBr(stateIsTomb, probeTomb, probeEmpty);

  b.position(probeTomb);
  const seenTomb = b.load(Ty.i64, firstTombAddr);
  const tombUnset = b.icmp("eq", seenTomb, i64c(-1));
  b.condBr(tombUnset, probeTombRecord, probeNext);

  b.position(probeTombRecord);
  b.store(slot, firstTombAddr);
  b.br(probeNext);

  // occupied: compare keys
  b.position(probeOccupied);
  const existingKeyPtr = entryField(b, entryTy, entryPtr, 1);
  const existingKey = b.load(keyTy, existingKeyPtr);
  const keysMatch = keysEqual(ctx, b, key, existingKey, keyType);
  const overwriteLabel = b.newBlock("hm.overwrite");
  b.condBr(keysMatch, overwriteLabel, probeNext);

  // overwrite existing value
  b.position(overwriteLabel);
  const existingValPtr = entryField(b, entryTy, entryPtr, 2);
  // TODO(insert-return-value): return old value as Option<V>
  if (ctx.needsDropCg(valueType)) {
    ctx.emitDropValue(lines, existingValPtr.ref, valueType);
  }
  b.store(value, existingValPtr);
  // The map keeps the key it already has, so the one just handed in has no owner:
  // the checker moved it out of the caller and this path never stores it. Without
  // this, re-inserting a `String` key leaked its buffer on every duplicate.
  if (ctx.needsDropCg(keyType)) {
    const dupKeyAddr = b.alloca(keyTy);
    b.store(key, dupKeyAddr);
    ctx.emitDropValue(lines, dupKeyAddr.ref, keyType);
  }
  b.br(insertDone);

  // Empty slot reached: the key is definitely absent, because the probe walked every
  // slot between its home and here. Reuse the first tombstone passed if there was one,
  // which keeps the chain short; otherwise take this slot.
  b.position(probeEmpty);
  const tombCandidate = b.load(Ty.i64, firstTombAddr);
  const reuseTomb = b.icmp("ne", tombCandidate, i64c(-1));
  const writeSlot = b.select(reuseTomb, tombCandidate, slot);
  const writePtr = b.gep(entryTy, curData, [writeSlot]);
  // Reusing a tombstone retires it — otherwise the count only ever grows and the table
  // rehashes on a load it does not actually carry.
  const tombsNow = b.load(Ty.i64, tombsPtr);
  const tombsLess = b.binop("sub", tombsNow, i64c(1));
  const tombsAfter = b.select(reuseTomb, tombsLess, tombsNow);
  b.store(tombsAfter, tombsPtr);
  b.store(i8c(1), writePtr);
  const newKeySlotPtr = entryField(b, entryTy, writePtr, 1);
  b.store(key, newKeySlotPtr);
  const newValSlotPtr = entryField(b, entryTy, writePtr, 2);
  b.store(value, newValSlotPtr);
  // increment len
  const curLen = b.load(Ty.i64, lenPtr);
  const newLen = b.binop("add", curLen, i64c(1));
  b.store(newLen, lenPtr);
  b.br(insertDone);

  // probe next slot
  b.position(probeNext);
  probeAdvance(b, slot, mask, slotAddr);
  b.br(probeCond);

  b.position(insertDone);
}

// The open-addressing probe every keyed HashMap op opens with: read the slot, an empty
// state means the key is absent, a tombstone means keep probing, an occupied state
// compares the key. contains/remove/get/getOrDefault each carried this verbatim, so a
// change to the tombstone rule or the state encoding had to land in four places.
//
// The labels are allocated by the CALLER and passed in, not minted here: each call site
// allocates its seven labels in its own order, and taking that over would renumber them
// and cost the byte-identical-IR check that verifies this refactor changed nothing.
function emitHashProbePrologue(
  ctx: CodegenMapCtx,
  lines: string[],
  at: {
    probeCond: string;
    probeCheck: string;
    probeOccupied: string;
    probeNext: string;
    // Where an empty slot goes (key absent) and where a key match goes. Only these two
    // differ between callers: remove() jumps straight to its done/remove blocks.
    emptyTarget: string;
    matchTarget: string;
  },
  map: {
    slotAddr: string;
    data: string;
    entryTy: string;
    keyTy: string;
    keyVal: string;
    keyType: TypeKind;
  },
): { slot: string; entryPtr: string } {
  lines.push(`  br label %${at.probeCond}`);
  lines.push(`${at.probeCond}:`);
  const slot = ctx.nextTemp();
  lines.push(`  ${slot} = load i64, ptr ${map.slotAddr}`);
  const entryPtr = ctx.nextTemp();
  lines.push(`  ${entryPtr} = getelementptr ${map.entryTy}, ptr ${map.data}, i64 ${slot}`);
  const state = ctx.nextTemp();
  lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
  // state == 0 (empty) -> the key is not in the map
  const stateIsEmpty = ctx.nextTemp();
  lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
  lines.push(`  br i1 ${stateIsEmpty}, label %${at.emptyTarget}, label %${at.probeCheck}`);

  // state == 1 (occupied) -> compare keys; state == 2 (tombstone) -> keep probing
  lines.push(`${at.probeCheck}:`);
  const stateIsOccupied = ctx.nextTemp();
  lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
  lines.push(`  br i1 ${stateIsOccupied}, label %${at.probeOccupied}, label %${at.probeNext}`);

  lines.push(`${at.probeOccupied}:`);
  const existingKeyPtr = ctx.nextTemp();
  lines.push(`  ${existingKeyPtr} = getelementptr ${map.entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
  const existingKey = ctx.nextTemp();
  lines.push(`  ${existingKey} = load ${map.keyTy}, ptr ${existingKeyPtr}`);
  const keysMatch = emitKeyCompare(ctx, lines, map.keyVal, existingKey, map.keyType);
  lines.push(`  br i1 ${keysMatch}, label %${at.matchTarget}, label %${at.probeNext}`);
  return { slot, entryPtr };
}

export function genHashMapContains(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapContains" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapContains on non-hashmap");
  const keyType = mapType.key;
  const valueType = mapType.value;
  const keyTy = ctx.llvmType(keyType);
  const entryTy = ctx.hashMapEntryType(keyType, valueType);

  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, expr.map);
  const [keyLines, keyVal] = ctx.genExpr(expr.key);
  lines.push(...keyLines);

  const seedPtr = ctx.nextTemp();
  lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
  const seed = ctx.nextTemp();
  lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

  const hash = emitFnvHash(ctx, lines, keyVal, keyType, seed);
  const mask = ctx.nextTemp();
  lines.push(`  ${mask} = sub i64 ${cap}, 1`);
  const slotAddr = ctx.nextTemp();
  lines.push(`  ${slotAddr} = alloca i64`);
  const slot0 = ctx.nextTemp();
  lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
  lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

  const probeCond = ctx.nextLabel("hmc.probe");
  const probeOccupied = ctx.nextLabel("hmc.occupied");
  const probeCheck = ctx.nextLabel("hmc.check");
  const foundLabel = ctx.nextLabel("hmc.found");
  const notFoundLabel = ctx.nextLabel("hmc.notfound");
  const probeNext = ctx.nextLabel("hmc.pnext");
  const doneLabel = ctx.nextLabel("hmc.done");

  const { slot } = emitHashProbePrologue(ctx,
    lines,
    { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
    { slotAddr, data, entryTy, keyTy, keyVal, keyType },
  );

  lines.push(`${foundLabel}:`);
  lines.push(`  br label %${doneLabel}`);
  lines.push(`${notFoundLabel}:`);
  lines.push(`  br label %${doneLabel}`);
  lines.push(`${probeNext}:`);
  const nextSlot = ctx.nextTemp();
  lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
  const wrappedSlot = ctx.nextTemp();
  lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
  lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
  lines.push(`  br label %${probeCond}`);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi i1 [true, %${foundLabel}], [false, %${notFoundLabel}]`);
  ctx.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
  // A materialized receiver is an owned temporary nobody else will free. This runs after
  // the phi above, so the block it opens cannot invalidate the phi's predecessors.
  if (mapTempSlot) ctx.emitDropValue(lines, mapTempSlot, expr.map.type);
  return [lines, result, "i1"];
}

// One keyed probe, shared by modify and getOrInsertWith: evaluates the receiver and
// key, opens the probe, and returns the labels plus what the found block needs (the
// entry pointer) and what the not-found block needs (the map pointer and the evaluated
// key). The caller writes both blocks and the join.
function beginHashMapProbe(ctx: CodegenMapCtx, lines: string[], map: HIRExpr, key: HIRExpr, prefix: string): {
  mapPtr: string; mapTempSlot: string | null; keyVal: string; keyTy: string; keyType: TypeKind; entryPtr: string; slot: string; mask: string; slotAddr: string;
  probeCond: string; probeNext: string; foundLabel: string; notFoundLabel: string;
} {
  ctx.hasHashMapType = true;
  const mapType = map.type;
  if (mapType.tag !== "hashmap") throw new Error(`${prefix} on non-hashmap`);
  const keyType = mapType.key;
  const keyTy = ctx.llvmType(keyType);
  const entryTy = ctx.hashMapEntryType(keyType, mapType.value);

  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, map);
  const [keyLines, keyVal] = ctx.genExpr(key);
  lines.push(...keyLines);

  const seedPtr = ctx.nextTemp();
  lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
  const seed = ctx.nextTemp();
  lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

  const hash = emitFnvHash(ctx, lines, keyVal, keyType, seed);
  const mask = ctx.nextTemp();
  lines.push(`  ${mask} = sub i64 ${cap}, 1`);
  const slotAddr = ctx.nextTemp();
  lines.push(`  ${slotAddr} = alloca i64`);
  const slot0 = ctx.nextTemp();
  lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
  lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

  const probeCond = ctx.nextLabel(`${prefix}.probe`);
  const probeOccupied = ctx.nextLabel(`${prefix}.occupied`);
  const probeCheck = ctx.nextLabel(`${prefix}.check`);
  const foundLabel = ctx.nextLabel(`${prefix}.found`);
  const notFoundLabel = ctx.nextLabel(`${prefix}.notfound`);
  const probeNext = ctx.nextLabel(`${prefix}.pnext`);
  const { slot, entryPtr } = emitHashProbePrologue(ctx,
    lines,
    { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
    { slotAddr, data, entryTy, keyTy, keyVal, keyType },
  );
  return { mapPtr, mapTempSlot, keyVal, keyTy, keyType, entryPtr, slot, mask, slotAddr, probeCond, probeNext, foundLabel, notFoundLabel };
}

function emitProbeNext(ctx: CodegenMapCtx, lines: string[], p: { slot: string; mask: string; slotAddr: string; probeCond: string; probeNext: string }): void {
  lines.push(`${p.probeNext}:`);
  const nextSlot = ctx.nextTemp();
  lines.push(`  ${nextSlot} = add i64 ${p.slot}, 1`);
  const wrappedSlot = ctx.nextTemp();
  lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${p.mask}`);
  lines.push(`  store i64 ${wrappedSlot}, ptr ${p.slotAddr}`);
  lines.push(`  br label %${p.probeCond}`);
}

// `m.modify(k, f)`: on a hit, call f with a pointer to the stored value (a `&mut V`
// view, so the callback writes the entry in place) and yield true; a miss yields false.
export function genHashMapModify(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapModify" }, lines: string[]): Gen {
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapModify on non-hashmap");
  const entryTy = ctx.hashMapEntryType(mapType.key, mapType.value);
  // The callback first: its environment must exist before the probe branches.
  const [cl, cv] = ctx.genExpr(expr.callback);
  lines.push(...cl);
  const fnPtr = ctx.nextTemp();
  lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
  const envPtr = ctx.nextTemp();
  lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

  const p = beginHashMapProbe(ctx, lines, expr.map, expr.key, "hmm");
  const doneLabel = ctx.nextLabel("hmm.done");

  lines.push(`${p.foundLabel}:`);
  const valPtr = ctx.nextTemp();
  lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${p.entryPtr}, i32 0, i32 2`);
  lines.push(`  call void ${fnPtr}(ptr ${envPtr}, ptr ${valPtr})`);
  lines.push(`  br label %${doneLabel}`);
  lines.push(`${p.notFoundLabel}:`);
  lines.push(`  br label %${doneLabel}`);
  emitProbeNext(ctx, lines, p);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi i1 [true, %${p.foundLabel}], [false, %${p.notFoundLabel}]`);
  ctx.dropOwnedTemp(lines, p.keyVal, p.keyTy, expr.key);
  if (p.mapTempSlot) ctx.emitDropValue(lines, p.mapTempSlot, mapType);
  return [lines, result, "i1"];
}

// `m.getOrInsertWith(k, init)`: a miss calls init() and inserts the result under the
// key that was already evaluated for the probe; a hit does nothing. Yields whether it
// inserted. On a hit the key, if it was an owned temporary, is dropped as `get` does;
// on a miss the insert takes ownership of it.
export function genHashMapGetOrInsertWith(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapGetOrInsertWith" }, lines: string[]): Gen {
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapGetOrInsertWith on non-hashmap");
  const [cl, cv] = ctx.genExpr(expr.init);
  lines.push(...cl);
  const fnPtr = ctx.nextTemp();
  lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
  const envPtr = ctx.nextTemp();
  lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

  const p = beginHashMapProbe(ctx, lines, expr.map, expr.key, "hmi");
  const doneLabel = ctx.nextLabel("hmi.done");
  const valTy = ctx.llvmType(mapType.value);

  lines.push(`${p.foundLabel}:`);
  ctx.dropOwnedTemp(lines, p.keyVal, p.keyTy, expr.key);
  // The drop can open blocks; the phi names the one we end in.
  const foundEnd = ctx.nextLabel("hmi.found.end");
  lines.push(`  br label %${foundEnd}`);
  lines.push(`${foundEnd}:`);
  lines.push(`  br label %${doneLabel}`);

  lines.push(`${p.notFoundLabel}:`);
  const produced = ctx.nextTemp();
  lines.push(`  ${produced} = call ${valTy} ${fnPtr}(ptr ${envPtr})`);
  emitHashMapInsertValues(ctx, lines, p.mapPtr, mapType, p.keyVal, produced, expr.span);
  ctx.ownEndVal(lines, p.keyVal, "STORE");
  // The insert opened blocks of its own; the phi below needs the block we end in.
  const insertedEnd = ctx.nextLabel("hmi.inserted");
  lines.push(`  br label %${insertedEnd}`);
  lines.push(`${insertedEnd}:`);
  lines.push(`  br label %${doneLabel}`);
  emitProbeNext(ctx, lines, p);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi i1 [false, %${foundEnd}], [true, %${insertedEnd}]`);
  if (p.mapTempSlot) ctx.emitDropValue(lines, p.mapTempSlot, mapType);
  return [lines, result, "i1"];
}

export function genHashMapRemove(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapRemove" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapRemove on non-hashmap");
  const keyType = mapType.key;
  const valueType = mapType.value;
  const keyTy = ctx.llvmType(keyType);
  const entryTy = ctx.hashMapEntryType(keyType, valueType);

  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, expr.map);
  const [keyLines, keyVal] = ctx.genExpr(expr.key);
  lines.push(...keyLines);

  const seedPtr = ctx.nextTemp();
  lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
  const seed = ctx.nextTemp();
  lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_LEN}`);

  const hash = emitFnvHash(ctx, lines, keyVal, keyType, seed);
  const mask = ctx.nextTemp();
  lines.push(`  ${mask} = sub i64 ${cap}, 1`);
  const slotAddr = ctx.nextTemp();
  lines.push(`  ${slotAddr} = alloca i64`);
  const slot0 = ctx.nextTemp();
  lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
  lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

  const probeCond = ctx.nextLabel("hmr.probe");
  const probeCheck = ctx.nextLabel("hmr.check");
  const probeOccupied = ctx.nextLabel("hmr.occupied");
  const removeLabel = ctx.nextLabel("hmr.remove");
  const probeNext = ctx.nextLabel("hmr.pnext");
  const doneLabel = ctx.nextLabel("hmr.done");

  const { slot, entryPtr } = emitHashProbePrologue(ctx,
    lines,
    { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: doneLabel, matchTarget: removeLabel },
    { slotAddr, data, entryTy, keyTy, keyVal, keyType },
  );

  lines.push(`${removeLabel}:`);
  // set tombstone
  lines.push(`  store i8 2, ptr ${entryPtr}`);
  // drop key and value if needed
  if (ctx.needsDropCg(keyType)) {
    const kPtr = ctx.nextTemp();
    lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    ctx.emitDropValue(lines, kPtr, keyType);
  }
  if (ctx.needsDropCg(valueType)) {
    const vPtr = ctx.nextTemp();
    lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    ctx.emitDropValue(lines, vPtr, valueType);
  }
  // decrement len
  const curLen = ctx.nextTemp();
  lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
  const newLen = ctx.nextTemp();
  lines.push(`  ${newLen} = sub i64 ${curLen}, 1`);
  lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
  // The slot just became a tombstone. Insert's resize trigger reads this, so a remove
  // that did not count itself would let tombstones accumulate past the load factor.
  const rmTombsPtr = ctx.nextTemp();
  lines.push(`  ${rmTombsPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_TOMBS}`);
  const rmTombs = ctx.nextTemp();
  lines.push(`  ${rmTombs} = load i64, ptr ${rmTombsPtr}`);
  const rmTombsNew = ctx.nextTemp();
  lines.push(`  ${rmTombsNew} = add i64 ${rmTombs}, 1`);
  lines.push(`  store i64 ${rmTombsNew}, ptr ${rmTombsPtr}`);
  lines.push(`  br label %${doneLabel}`);

  lines.push(`${probeNext}:`);
  const nextSlot = ctx.nextTemp();
  lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
  const wrappedSlot = ctx.nextTemp();
  lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
  lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
  lines.push(`  br label %${probeCond}`);

  lines.push(`${doneLabel}:`);
  ctx.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
  // A materialized receiver is an owned temporary nobody else will free. This runs after
  // the phi above, so the block it opens cannot invalidate the phi's predecessors.
  if (mapTempSlot) ctx.emitDropValue(lines, mapTempSlot, expr.map.type);
  return [lines, "0", "void"];
}

// HashMap.withCapacity(n): pre-size the table so inserting n entries never rehashes.
// Insert grows when (len+1)*4 >= cap*3, so the table must hold cap > 4(n+1)/3; the
// loop rounds that up to a power of two (the mask-based probe requires one).
export function genHashMapWithCapacity(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapWithCapacity" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  ctx.needsMalloc = true;
  ctx.needsMemset = true;
  const entryTy = ctx.hashMapEntryType(expr.keyType, expr.valueType);
  const [capLines, nVal] = ctx.genExpr(expr.capacity);
  lines.push(...capLines);
  ctx.emitNonNegativeCheck(lines, nVal, "capacity", expr.span);

  const nPlus1 = ctx.nextTemp();
  lines.push(`  ${nPlus1} = add i64 ${nVal}, 1`);
  const scaled = ctx.nextTemp();
  lines.push(`  ${scaled} = mul i64 ${nPlus1}, 4`);
  const wantDiv = ctx.nextTemp();
  lines.push(`  ${wantDiv} = udiv i64 ${scaled}, 3`);
  const want = ctx.nextTemp();
  lines.push(`  ${want} = add i64 ${wantDiv}, 1`);

  const capSlot = ctx.nextTemp();
  lines.push(`  ${capSlot} = alloca i64`);
  lines.push(`  store i64 8, ptr ${capSlot}`);
  const roundCond = ctx.nextLabel("hmwc.cond");
  const roundBody = ctx.nextLabel("hmwc.body");
  const roundEnd = ctx.nextLabel("hmwc.end");
  lines.push(`  br label %${roundCond}`);
  lines.push(`${roundCond}:`);
  const curCap = ctx.nextTemp();
  lines.push(`  ${curCap} = load i64, ptr ${capSlot}`);
  const tooSmall = ctx.nextTemp();
  lines.push(`  ${tooSmall} = icmp ult i64 ${curCap}, ${want}`);
  lines.push(`  br i1 ${tooSmall}, label %${roundBody}, label %${roundEnd}`);
  lines.push(`${roundBody}:`);
  const dbl = ctx.nextTemp();
  lines.push(`  ${dbl} = shl i64 ${curCap}, 1`);
  lines.push(`  store i64 ${dbl}, ptr ${capSlot}`);
  lines.push(`  br label %${roundCond}`);
  lines.push(`${roundEnd}:`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capSlot}`);

  const entrySize = ctx.nextTemp();
  lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
  const entrySizeI = ctx.nextTemp();
  lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
  const { buf: dataPtr, bytes: totalSize } = ctx.emitAllocBytes(lines, entrySizeI, cap, "hmwith", expr.span);
  lines.push(`  call ptr @memset(ptr ${dataPtr}, i32 0, i64 ${totalSize})`);

  const s0 = ctx.nextTemp();
  lines.push(`  ${s0} = insertvalue %HashMap undef, ptr ${dataPtr}, 0`);
  const s1 = ctx.nextTemp();
  lines.push(`  ${s1} = insertvalue %HashMap ${s0}, i64 0, 1`);
  const s2 = ctx.nextTemp();
  lines.push(`  ${s2} = insertvalue %HashMap ${s1}, i64 ${cap}, 2`);
  const s3 = ctx.nextTemp();
  lines.push(`  ${s3} = insertvalue %HashMap ${s2}, i64 0, 3`);
  const s4 = ctx.nextTemp();
  lines.push(`  ${s4} = insertvalue %HashMap ${s3}, i64 0, ${HM_TOMBS}`);
  return [lines, s4, "%HashMap"];
}

export function genHashMapClone(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapClone" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const passed = ctx.cloneOfOwnedTemp(expr.object, lines);
  if (passed) return passed;
  const [ol, ov] = ctx.genExpr(expr.object);
  lines.push(...ol);
  // emitDeepCloneFromPtr reads through a pointer; the spill is a shallow copy
  // that is never dropped — only the clone it produces is owned by the caller.
  const slot = ctx.nextTemp();
  lines.push(`  ${slot} = alloca %HashMap`);
  lines.push(`  store %HashMap ${ov}, ptr ${slot}`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, slot, expr.object.type);
  return [lines, cloned, "%HashMap"];
}

// Drop every live key/value, then zero the states. Capacity and the hash seed
// survive — clear() is "empty this map", not "give the memory back", so a
// rebuild after clear() reuses the table it already paid for (Vec.clear too).
export function genHashMapClear(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapClear" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  ctx.needsMemset = true;
  const mapType = expr.object.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapClear on non-hashmap");
  const entryTy = ctx.hashMapEntryType(mapType.key, mapType.value);
  const [mapPtrLines, mapPtr] = ctx.genLValue(expr.object);
  lines.push(...mapPtrLines);

  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const isNull = ctx.nextTemp();
  lines.push(`  ${isNull} = icmp eq ptr ${data}, null`);
  const doLabel = ctx.nextLabel("hmc.do");
  const endLabel = ctx.nextLabel("hmc.end");
  lines.push(`  br i1 ${isNull}, label %${endLabel}, label %${doLabel}`);
  lines.push(`${doLabel}:`);

  if (ctx.needsDropCg(mapType.key) || ctx.needsDropCg(mapType.value)) {
    const cond = ctx.nextLabel("hmc.cond");
    const body = ctx.nextLabel("hmc.body");
    const dropIt = ctx.nextLabel("hmc.drop");
    const step = ctx.nextLabel("hmc.step");
    const loopEnd = ctx.nextLabel("hmc.loopend");
    const iAddr = ctx.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${cond}:`);
    const i = ctx.nextTemp();
    lines.push(`  ${i} = load i64, ptr ${iAddr}`);
    const more = ctx.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${i}, ${cap}`);
    lines.push(`  br i1 ${more}, label %${body}, label %${loopEnd}`);
    lines.push(`${body}:`);
    const entryPtr = ctx.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${i}`);
    const state = ctx.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const occupied = ctx.nextTemp();
    lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${occupied}, label %${dropIt}, label %${step}`);
    lines.push(`${dropIt}:`);
    if (ctx.needsDropCg(mapType.key)) {
      const kPtr = ctx.nextTemp();
      lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
      ctx.emitDropValue(lines, kPtr, mapType.key);
    }
    if (ctx.needsDropCg(mapType.value)) {
      const vPtr = ctx.nextTemp();
      lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
      ctx.emitDropValue(lines, vPtr, mapType.value);
    }
    lines.push(`  br label %${step}`);
    lines.push(`${step}:`);
    const nextI = ctx.nextTemp();
    lines.push(`  ${nextI} = add i64 ${i}, 1`);
    lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${loopEnd}:`);
  }

  const entrySize = ctx.nextTemp();
  lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
  const entrySizeI = ctx.nextTemp();
  lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
  const totalSize = ctx.nextTemp();
  lines.push(`  ${totalSize} = mul i64 ${entrySizeI}, ${cap}`);
  lines.push(`  call ptr @memset(ptr ${data}, i32 0, i64 ${totalSize})`);
  const lenPtr = ctx.nextTemp();
  lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_LEN}`);
  lines.push(`  store i64 0, ptr ${lenPtr}`);
  // The memset above put every slot back to EMPTY, so no tombstone survives either.
  const clearTombsPtr = ctx.nextTemp();
  lines.push(`  ${clearTombsPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_TOMBS}`);
  lines.push(`  store i64 0, ptr ${clearTombsPtr}`);
  lines.push(`  br label %${endLabel}`);
  lines.push(`${endLabel}:`);
  return [lines, "0", "void"];
}

// keys()/values() → a fresh Vec holding a deep clone of each occupied slot's
// key (or value). The map keeps its own copy, so the two never share a buffer.
export function genHashMapEntries(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapEntries" }, lines: string[]): Gen {
  ctx.hasVecType = true;
  ctx.hasHashMapType = true;
  ctx.needsMalloc = true;
  const mapType = expr.object.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapEntries on non-hashmap");
  const elemType = expr.field === "key" ? mapType.key : mapType.value;
  const fieldIdx = expr.field === "key" ? 1 : 2;
  const entryTy = ctx.hashMapEntryType(mapType.key, mapType.value);
  const elemTy = ctx.llvmType(elemType);
  const elemSize = ctx.typeSizeOf(elemType);

  const [ol, ov] = ctx.genExpr(expr.object);
  lines.push(...ol);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = extractvalue %HashMap ${ov}, 0`);
  const len = ctx.nextTemp();
  lines.push(`  ${len} = extractvalue %HashMap ${ov}, 1`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = extractvalue %HashMap ${ov}, 2`);
  const { buf } = ctx.emitAllocBytes(lines, len, elemSize, "hmvals", expr.span);

  const iAddr = ctx.nextTemp();
  lines.push(`  ${iAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${iAddr}`);
  const outAddr = ctx.nextTemp();
  lines.push(`  ${outAddr} = alloca i64`);
  lines.push(`  store i64 0, ptr ${outAddr}`);
  const cond = ctx.nextLabel("hme.cond");
  const body = ctx.nextLabel("hme.body");
  const take = ctx.nextLabel("hme.take");
  const step = ctx.nextLabel("hme.step");
  const end = ctx.nextLabel("hme.end");
  lines.push(`  br label %${cond}`);
  lines.push(`${cond}:`);
  const i = ctx.nextTemp();
  lines.push(`  ${i} = load i64, ptr ${iAddr}`);
  const more = ctx.nextTemp();
  lines.push(`  ${more} = icmp ult i64 ${i}, ${cap}`);
  lines.push(`  br i1 ${more}, label %${body}, label %${end}`);
  lines.push(`${body}:`);
  const entryPtr = ctx.nextTemp();
  lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${i}`);
  const state = ctx.nextTemp();
  lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
  const occupied = ctx.nextTemp();
  lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
  lines.push(`  br i1 ${occupied}, label %${take}, label %${step}`);
  lines.push(`${take}:`);
  const srcPtr = ctx.nextTemp();
  lines.push(`  ${srcPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 ${fieldIdx}`);
  const cloned = ctx.emitDeepCloneFromPtr(lines, srcPtr, elemType);
  const outIdx = ctx.nextTemp();
  lines.push(`  ${outIdx} = load i64, ptr ${outAddr}`);
  const dstPtr = ctx.nextTemp();
  lines.push(`  ${dstPtr} = getelementptr ${elemTy}, ptr ${buf}, i64 ${outIdx}`);
  lines.push(`  store ${elemTy} ${cloned}, ptr ${dstPtr}`);
  const nextOut = ctx.nextTemp();
  lines.push(`  ${nextOut} = add i64 ${outIdx}, 1`);
  lines.push(`  store i64 ${nextOut}, ptr ${outAddr}`);
  lines.push(`  br label %${step}`);
  lines.push(`${step}:`);
  const nextI = ctx.nextTemp();
  lines.push(`  ${nextI} = add i64 ${i}, 1`);
  lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
  lines.push(`  br label %${cond}`);
  lines.push(`${end}:`);
  const v0 = ctx.nextTemp();
  lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
  const v1 = ctx.nextTemp();
  lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${len}, 1`);
  const v2 = ctx.nextTemp();
  lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
  // keys()/values() build a fresh Vec of deep clones, so nothing points into the map
  // afterwards and a temporary receiver can go: `mkMap().keys().len` leaked the map,
  // its keys and its values on every call.
  ctx.dropOwnedTemp(lines, ov, "%HashMap", expr.object);
  return [lines, v2, "%Vec"];
}

export function genHashMapGet(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapGet" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapGet on non-hashmap");
  const keyType = mapType.key;
  const valueType = mapType.value;
  const keyTy = ctx.llvmType(keyType);
  const valTy = ctx.llvmType(valueType);
  const entryTy = ctx.hashMapEntryType(keyType, valueType);

  const optionEnumName = expr.optionEnumName;
  const optionLayout = ctx.enumLayouts.get(optionEnumName);
  if (!optionLayout) throw new Error(`no enum layout for ${optionEnumName}`);
  const optionTy = `%${optionEnumName}`;

  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, expr.map);
  const [keyLines, keyVal] = ctx.genExpr(expr.key);
  lines.push(...keyLines);

  const seedPtr = ctx.nextTemp();
  lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
  const seed = ctx.nextTemp();
  lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

  const hash = emitFnvHash(ctx, lines, keyVal, keyType, seed);
  const mask = ctx.nextTemp();
  lines.push(`  ${mask} = sub i64 ${cap}, 1`);
  const slotAddr = ctx.nextTemp();
  lines.push(`  ${slotAddr} = alloca i64`);
  const slot0 = ctx.nextTemp();
  lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
  lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

  const probeCond = ctx.nextLabel("hmg.probe");
  const probeCheck = ctx.nextLabel("hmg.check");
  const probeOccupied = ctx.nextLabel("hmg.occupied");
  const foundLabel = ctx.nextLabel("hmg.found");
  const notFoundLabel = ctx.nextLabel("hmg.notfound");
  const probeNext = ctx.nextLabel("hmg.pnext");
  const doneLabel = ctx.nextLabel("hmg.done");

  const { slot, entryPtr } = emitHashProbePrologue(ctx,
    lines,
    { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
    { slotAddr, data, entryTy, keyTy, keyVal, keyType },
  );

  // found — construct Some(value)
  lines.push(`${foundLabel}:`);
  const valPtr = ctx.nextTemp();
  lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
  // Deep-clone, don't `load`: a shallow copy aliases the map's heap, and a later
  // `insert` on the same key drops the old value out from under it (the copy-back
  // idiom `let v = m.get(k); v.x = 1; m.insert(k, v)`). Vec indexing already does
  // this; emitDeepCloneFromPtr degrades to a plain load for Copy types.
  const foundVal = ctx.emitDeepCloneFromPtr(lines, valPtr, valueType);
  // The clone can open new basic blocks (vec/enum clone loops), so the phi at
  // the bottom must name the block we actually end in, not `foundLabel`.
  const foundEnd = ctx.nextLabel("hmg.found.end");
  lines.push(`  br label %${foundEnd}`);
  lines.push(`${foundEnd}:`);
  // build Option::Some(val) — tag=0, payload=value
  const someAlloca = ctx.nextTemp();
  lines.push(`  ${someAlloca} = alloca ${optionTy}`);
  const someTag = must(optionLayout.variants, "Some", "variants").tag;
  ctx.storeEnumTag(lines, optionTy, someAlloca, someTag);
  const somePayloadPtr = ctx.enumPayloadPtr(lines, optionTy, someAlloca, someTag);
  lines.push(`  store ${valTy} ${foundVal}, ptr ${somePayloadPtr}`);
  const someVal = ctx.nextTemp();
  lines.push(`  ${someVal} = load ${optionTy}, ptr ${someAlloca}`);
  lines.push(`  br label %${doneLabel}`);

  // not found — construct None
  lines.push(`${notFoundLabel}:`);
  const noneAlloca = ctx.nextTemp();
  lines.push(`  ${noneAlloca} = alloca ${optionTy}`);
  // zero it first to avoid garbage in payload
  ctx.needsMemset = true;
  const optionSize = ctx.nextTemp();
  lines.push(`  ${optionSize} = getelementptr ${optionTy}, ptr null, i32 1`);
  const optionSizeI = ctx.nextTemp();
  lines.push(`  ${optionSizeI} = ptrtoint ptr ${optionSize} to i64`);
  lines.push(`  call ptr @memset(ptr ${noneAlloca}, i32 0, i64 ${optionSizeI})`);
  const noneTag = must(optionLayout.variants, "None", "variants").tag;
  ctx.storeEnumTag(lines, optionTy, noneAlloca, noneTag);
  const noneVal = ctx.nextTemp();
  lines.push(`  ${noneVal} = load ${optionTy}, ptr ${noneAlloca}`);
  lines.push(`  br label %${doneLabel}`);

  lines.push(`${probeNext}:`);
  const nextSlot = ctx.nextTemp();
  lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
  const wrappedSlot = ctx.nextTemp();
  lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
  lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
  lines.push(`  br label %${probeCond}`);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi ${optionTy} [${someVal}, %${foundEnd}], [${noneVal}, %${notFoundLabel}]`);
  // The key was built by the CALLER and handed to a lookup that only reads it. Nothing
  // takes ownership on this path, so without a drop `m.get("k" + i.toString())` leaks
  // that string on every call — one 16-byte allocation per lookup, in about the most
  // ordinary map idiom there is. `insert` already knew this for its overwrite path;
  // the four read-only lookups did not. dropOwnedTemp no-ops unless the argument really
  // is an owned temporary, so a variable or a literal key is untouched.
  ctx.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
  // A materialized receiver is an owned temporary nobody else will free. This runs after
  // the phi above, so the block it opens cannot invalidate the phi's predecessors.
  if (mapTempSlot) ctx.emitDropValue(lines, mapTempSlot, expr.map.type);
  return [lines, result, optionTy];
}

export function genHashMapGetOrDefault(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapGetOrDefault" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const mapType = expr.map.type;
  if (mapType.tag !== "hashmap") throw new Error("HashMapGetOrDefault on non-hashmap");
  const keyType = mapType.key;
  const valueType = mapType.value;
  const keyTy = ctx.llvmType(keyType);
  const valTy = ctx.llvmType(valueType);
  const entryTy = ctx.hashMapEntryType(keyType, valueType);

  const { ptr: mapPtr, tempSlot: mapTempSlot } = mapReceiverPtr(ctx, lines, expr.map);
  const [keyLines, keyVal] = ctx.genExpr(expr.key);
  lines.push(...keyLines);
  const [defaultLines, defaultVal] = ctx.genExpr(expr.default);
  lines.push(...defaultLines);

  const seedPtr = ctx.nextTemp();
  lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
  const seed = ctx.nextTemp();
  lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
  const capPtr = ctx.nextTemp();
  lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
  const cap = ctx.nextTemp();
  lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
  const dataFieldPtr = ctx.nextTemp();
  lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
  const data = ctx.nextTemp();
  lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

  const hash = emitFnvHash(ctx, lines, keyVal, keyType, seed);
  const mask = ctx.nextTemp();
  lines.push(`  ${mask} = sub i64 ${cap}, 1`);
  const slotAddr = ctx.nextTemp();
  lines.push(`  ${slotAddr} = alloca i64`);
  const slot0 = ctx.nextTemp();
  lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
  lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

  const probeCond = ctx.nextLabel("hmgd.probe");
  const probeCheck = ctx.nextLabel("hmgd.check");
  const probeOccupied = ctx.nextLabel("hmgd.occupied");
  const foundLabel = ctx.nextLabel("hmgd.found");
  const notFoundLabel = ctx.nextLabel("hmgd.notfound");
  const probeNext = ctx.nextLabel("hmgd.pnext");
  const doneLabel = ctx.nextLabel("hmgd.done");

  const { slot, entryPtr } = emitHashProbePrologue(ctx,
    lines,
    { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
    { slotAddr, data, entryTy, keyTy, keyVal, keyType },
  );

  // found — return the value directly (deep-cloned; see genHashMapGet)
  lines.push(`${foundLabel}:`);
  const valPtr = ctx.nextTemp();
  lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
  const foundVal = ctx.emitDeepCloneFromPtr(lines, valPtr, valueType);
  // see genHashMapGet: the clone may have opened new blocks
  const foundEnd = ctx.nextLabel("hmgd.found.end");
  lines.push(`  br label %${foundEnd}`);
  lines.push(`${foundEnd}:`);
  // The default is dead on this path (the map had the key) and the call owns it: a
  // computed one has no other owner, and a named one was moved in by the checker.
  // `m.getOrDefault(k, "dflt" + i.toString())` leaked its default on every hit.
  // The drop is conditional by construction: it sits in the found block, and the
  // not-found path hands that same value to the caller as the result.
  //
  // Dropping a Vec or an enum opens basic blocks of its own, so the block this path
  // ENDS in is not `foundEnd` any more. Rejoin an empty one and let the phi below name
  // that, exactly as the deep clone above already has to.
  ctx.dropConsumedArg(lines, defaultVal, valTy, expr.default);
  const foundJoin = ctx.nextLabel("hmgd.found.join");
  lines.push(`  br label %${foundJoin}`);
  lines.push(`${foundJoin}:`);
  lines.push(`  br label %${doneLabel}`);

  // not found — use the default value
  lines.push(`${notFoundLabel}:`);
  ctx.ownEndVal(lines, defaultVal, "MOVE");
  lines.push(`  br label %${doneLabel}`);

  lines.push(`${probeNext}:`);
  const nextSlot = ctx.nextTemp();
  lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
  const wrappedSlot = ctx.nextTemp();
  lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
  lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
  lines.push(`  br label %${probeCond}`);

  lines.push(`${doneLabel}:`);
  const result = ctx.nextTemp();
  lines.push(`  ${result} = phi ${valTy} [${foundVal}, %${foundJoin}], [${defaultVal}, %${notFoundLabel}]`);
  ctx.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
  // A materialized receiver is an owned temporary nobody else will free. This runs after
  // the phi above, so the block it opens cannot invalidate the phi's predecessors.
  if (mapTempSlot) ctx.emitDropValue(lines, mapTempSlot, expr.map.type);
  return [lines, result, valTy];
}
