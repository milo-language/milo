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
  typeSizeOf(t: TypeKind): number;
  genExpr(expr: HIRExpr, sretDest?: string): Gen;
  genVal(expr: HIRExpr, lines: string[], sretDest?: string): Val;
  genLValue(expr: HIRExpr): Gen;
  hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string;
  needsDropCg(t: TypeKind): boolean;
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr): void;
  cloneOfOwnedTemp(src: HIRExpr, lines: string[]): Gen | null;
  emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string;
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }): void;
  own: OwnLedger;
  structLayouts: Map<string, StructLayout>;
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
  const exprVal = ctx.genVal(mapExpr, lines);
  const b = new LlvmTextBuilder(lines, ctx);
  const slot = b.alloca(Ty.of(exprVal.ty.ll));
  b.store(exprVal, slot);
  ctx.own.valToSlot(exprVal.ref, slot.ref);
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
  const keyVal = ctx.genVal(expr.key, lines);
  const valVal = ctx.genVal(expr.value, lines);
  emitHashMapInsertValues(ctx, lines, mapPtr, mapType, keyVal.ref, valVal.ref, expr.span);
  ctx.own.endVal(lines, keyVal.ref, "STORE"); ctx.own.endVal(lines, valVal.ref, "STORE");
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

export function genHashMapClone(ctx: CodegenMapCtx, expr: HIRExpr & { kind: "HashMapClone" }, lines: string[]): Gen {
  ctx.hasHashMapType = true;
  const passed = ctx.cloneOfOwnedTemp(expr.object, lines);
  if (passed) return passed;
  const b = new LlvmTextBuilder(lines, ctx);
  const ov = ctx.genVal(expr.object, lines);
  // emitDeepCloneFromPtr reads through a pointer; the spill is a shallow copy
  // that is never dropped — only the clone it produces is owned by the caller.
  const slot = b.alloca(HASHMAP_TY);
  b.store(val(ov.ref, HASHMAP_TY), slot);
  const cloned = ctx.emitDeepCloneFromPtr(lines, slot.ref, expr.object.type);
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
  const entryTy = Ty.of(ctx.hashMapEntryType(mapType.key, mapType.value));
  const b = new LlvmTextBuilder(lines, ctx);
  const [mapPtrLines, mapPtrRef] = ctx.genLValue(expr.object);
  lines.push(...mapPtrLines);
  const map = val(mapPtrRef, Ty.ptr);

  const dataFieldPtr = hmField(b, map, HM_DATA);
  const data = b.load(Ty.ptr, dataFieldPtr);
  const capPtr = hmField(b, map, HM_CAP);
  const cap = b.load(Ty.i64, capPtr);
  const isNull = b.icmp("eq", data, val("null", Ty.ptr));
  const doLabel = b.newBlock("hmc.do");
  const endLabel = b.newBlock("hmc.end");
  b.condBr(isNull, endLabel, doLabel);
  b.position(doLabel);

  if (ctx.needsDropCg(mapType.key) || ctx.needsDropCg(mapType.value)) {
    const cond = b.newBlock("hmc.cond");
    const body = b.newBlock("hmc.body");
    const dropIt = b.newBlock("hmc.drop");
    const step = b.newBlock("hmc.step");
    const loopEnd = b.newBlock("hmc.loopend");
    const iAddr = b.alloca(Ty.i64);
    b.store(i64c(0), iAddr);
    b.br(cond);
    b.position(cond);
    const i = b.load(Ty.i64, iAddr);
    const more = b.icmp("ult", i, cap);
    b.condBr(more, body, loopEnd);
    b.position(body);
    const entryPtr = b.gep(entryTy, data, [i]);
    const state = b.load(Ty.i8, entryPtr);
    const occupied = b.icmp("eq", state, i8c(1));
    b.condBr(occupied, dropIt, step);
    b.position(dropIt);
    if (ctx.needsDropCg(mapType.key)) {
      const kPtr = entryField(b, entryTy, entryPtr, 1);
      ctx.emitDropValue(lines, kPtr.ref, mapType.key);
    }
    if (ctx.needsDropCg(mapType.value)) {
      const vPtr = entryField(b, entryTy, entryPtr, 2);
      ctx.emitDropValue(lines, vPtr.ref, mapType.value);
    }
    b.br(step);
    b.position(step);
    const nextI = b.binop("add", i, i64c(1));
    b.store(nextI, iAddr);
    b.br(cond);
    b.position(loopEnd);
  }

  const entrySizeI = entrySizeOf(b, entryTy);
  const totalSize = b.binop("mul", entrySizeI, cap);
  b.callDiscard(Ty.ptr, "@memset", [data, i32c(0), totalSize]);
  const lenPtr = hmField(b, map, HM_LEN);
  b.store(i64c(0), lenPtr);
  // The memset above put every slot back to EMPTY, so no tombstone survives either.
  const clearTombsPtr = hmField(b, map, HM_TOMBS);
  b.store(i64c(0), clearTombsPtr);
  b.br(endLabel);
  b.position(endLabel);
  return [lines, "0", "void"];
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
