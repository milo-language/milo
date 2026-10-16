// Drop and clone glue: per-type drop sequences, deep clone, and the generated drop/clone helper functions.

import type { TypeKind } from "./types";
import type { Span } from "./ast";
import { LlvmTextBuilder, Ty, val, type Block, type NameSource, type Val } from "./ir";
import type { StructLayout, EnumLayout, EnumVariant } from "./codegen";
import { HM_TOMBS } from "./codegen-map";
import { must } from "./must";

const STRING = Ty.of("%String");
const VEC = Ty.of("%Vec");
const HASHMAP = Ty.of("%HashMap");
// A closure and a Heap<Interface> are both a { data/fn, env/itable } pair.
const CLOSURE = Ty.of("{ ptr, ptr }");
const NULL = val("null", Ty.ptr);
const I64_0 = val("0", Ty.i64);
const I64_1 = val("1", Ty.i64);
const I32_0 = val("0", Ty.i32);
const I32_1 = val("1", Ty.i32);

// Which helper functions have been generated, so each is emitted once per module.
export class DropGlueSeen {
  readonly enumClone = new Set<string>();
  readonly structClone = new Set<string>();
  readonly enumDrop = new Set<string>();
  readonly structDrop = new Set<string>();
}

// The slice of Codegen these extracted helpers need. Codegen's matching members are
// public solely to satisfy this, they are not part of its external API.
export interface DropCtx extends NameSource {
  llvmType(t: TypeKind): string;
  typeSizeOf(t: TypeKind): number;
  hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string;
  needsDropCg(t: TypeKind): boolean;
  structNeedsDrop(name: string): boolean;
  // Re-enters Codegen's wrapper, which owns structural-mode switching and the ownership ledger.
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string };
  emitStrShare(lines: string[], val: string): string;
  strRt(): void;
  enumFieldPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number, k: number): string;
  loadEnumTag(lines: string[], enumTy: string, addr: string): string;
  /** Run `build` with fresh temp/label numbering and ownership-ledger maps, then queue the body as a module-level helper. */
  emitHelperFn(hoistAt: number | undefined, build: (body: string[]) => void): void;
  structLayouts: Map<string, StructLayout>;
  enumLayouts: Map<string, EnumLayout>;
  dropImpls: Set<string>;
  droppableEnums: Set<string>;
  ifaceMethodCounts: Map<string, number>;
  structuralDrop: boolean;
  dropGlueSeen: DropGlueSeen;
  hasVecType: boolean;
  hasHashMapType: boolean;
  needsMalloc: boolean;
  needsMemcpy: boolean;
  needsFree: boolean;
}

// emitDeepCloneFromPtr: given a pointer to a value of type `typeKind`,
// produce a fully-cloned value (deep copy of all heap-owned data).
// Used for auto-clone on Vec[i] reads so the source Vec stays intact.
export function emitDeepCloneFromPtr(ctx: DropCtx, lines: string[], srcPtr: string, typeKind: TypeKind): string {
  const lt = ctx.llvmType(typeKind);
  const b = new LlvmTextBuilder(lines, ctx);
  const src = val(srcPtr, Ty.ptr);

  // Copy types: just load
  if (!ctx.needsDropCg(typeKind)) return b.load(Ty.of(lt), src).ref;

  // The one switch for every implicit string copy (`v[i]`, a field read out of a
  // borrow, a struct or Vec clone): a heap buffer is shared by count, not copied.
  if (typeKind.tag === "string") {
    const orig = b.load(STRING, src);
    return ctx.emitStrShare(lines, orig.ref);
  }

  if (typeKind.tag === "vec") {
    ctx.hasVecType = true;
    ctx.needsMalloc = true;
    ctx.needsMemcpy = true;
    const orig = b.load(VEC, src);
    const srcData = b.extractvalue(orig, 0, Ty.ptr);
    const vecLen = b.extractvalue(orig, 1, Ty.i64);
    const elemSize = ctx.typeSizeOf(typeKind.element);
    const elemTy = Ty.of(ctx.llvmType(typeKind.element));

    // result buf pointer (set conditionally below)
    const newBufAddr = b.alloca(Ty.ptr);
    b.store(NULL, newBufAddr);

    const isEmpty = b.icmp("eq", vecLen, I64_0);
    const allocLabel = b.newBlock("vec.clone.alloc");
    const endLabel = b.newBlock("vec.clone.end");
    b.condBr(isEmpty, endLabel, allocLabel);

    b.position(allocLabel);
    const { buf, bytes } = ctx.emitAllocBytes(lines, vecLen.ref, elemSize, "vecclone", undefined);
    const newBuf = val(buf, Ty.ptr);
    b.store(newBuf, newBufAddr);

    if (ctx.needsDropCg(typeKind.element)) {
      // deep-clone each element
      const loopCond = b.newBlock("vec.clone.cond");
      const loopBody = b.newBlock("vec.clone.body");
      const iAddr = b.alloca(Ty.i64);
      b.store(I64_0, iAddr);
      b.br(loopCond);
      b.position(loopCond);
      const iVal = b.load(Ty.i64, iAddr);
      const cmp = b.icmp("ult", iVal, vecLen);
      b.condBr(cmp, loopBody, endLabel);
      b.position(loopBody);
      const srcElemPtr = b.gep(elemTy, srcData, [iVal]);
      const clonedElem = emitDeepCloneFromPtr(ctx, lines, srcElemPtr.ref, typeKind.element);
      const dstElemPtr = b.gep(elemTy, newBuf, [iVal]);
      b.store(val(clonedElem, elemTy), dstElemPtr);
      const nextI = b.binop("add", iVal, I64_1);
      b.store(nextI, iAddr);
      b.br(loopCond);
    } else {
      // Copy element: just memcpy
      b.callDiscard(Ty.ptr, "@memcpy", [newBuf, srcData, val(bytes, Ty.i64)]);
      b.br(endLabel);
    }

    b.position(endLabel);
    const finalPtr = b.load(Ty.ptr, newBufAddr);
    const v0 = b.insertvalue(val("undef", VEC), finalPtr, 0);
    const v1 = b.insertvalue(v0, vecLen, 1);
    return b.insertvalue(v1, vecLen, 2).ref;
  }

  if (typeKind.tag === "heap") {
    ctx.needsMalloc = true;
    const inner = typeKind.inner;
    const innerTy = Ty.of(ctx.llvmType(inner));
    const innerSize = ctx.typeSizeOf(inner);
    const origPtr = b.load(Ty.ptr, src);
    const newHeap = b.call(Ty.ptr, "@malloc", [val(String(innerSize), Ty.i64)]);
    const clonedInner = emitDeepCloneFromPtr(ctx, lines, origPtr.ref, inner);
    b.store(val(clonedInner, innerTy), newHeap);
    return newHeap.ref;
  }

  if (typeKind.tag === "struct") {
    const layout = ctx.structLayouts.get(typeKind.name);
    if (!layout) return b.load(Ty.of(lt), src).ref;
    const structTy = Ty.of(`%${typeKind.name}`);
    if (ctx.needsDropCg(typeKind)) {
      ensureStructCloneHelper(ctx, typeKind.name);
      const helperName = `milo.clone.struct.${typeKind.name}`;
      const dstAlloca = b.alloca(structTy);
      b.callDiscard(Ty.void, `@${helperName}`, [src, dstAlloca]);
      return b.load(structTy, dstAlloca).ref;
    }
    const newAlloca = b.alloca(structTy);
    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const srcFieldPtr = b.gep(structTy, src, [I32_0, val(String(i), Ty.i32)]);
      const clonedField = emitDeepCloneFromPtr(ctx, lines, srcFieldPtr.ref, f.typeKind);
      const dstFieldPtr = b.gep(structTy, newAlloca, [I32_0, val(String(i), Ty.i32)]);
      b.store(val(clonedField, Ty.of(f.type)), dstFieldPtr);
    }
    return b.load(structTy, newAlloca).ref;
  }

  if (typeKind.tag === "enum" && ctx.needsDropCg(typeKind) && ctx.enumLayouts.has(typeKind.name)) {
    ensureEnumCloneHelper(ctx, typeKind.name);
    const enumTy = Ty.of(lt);
    const dstAlloca = b.alloca(enumTy);
    b.callDiscard(Ty.void, `@milo.clone.${typeKind.name}`, [src, dstAlloca]);
    return b.load(enumTy, dstAlloca).ref;
  }

  if (typeKind.tag === "hashmap") {
    // A shallow load here shares the entry buffer; the clone's drop then
    // frees it under the original, and the next probe loop walks freed
    // memory forever (found via self-hosting: milo-self checking any enum
    // match ran away on a cloned EnumInfo's variants map).
    ctx.hasHashMapType = true;
    ctx.needsMalloc = true;
    ctx.needsMemcpy = true;
    const keyType = typeKind.key;
    const valueType = typeKind.value;
    const entryTy = Ty.of(ctx.hashMapEntryType(keyType, valueType));
    const orig = b.load(HASHMAP, src);
    const srcData = b.extractvalue(orig, 0, Ty.ptr);
    const len = b.extractvalue(orig, 1, Ty.i64);
    const cap = b.extractvalue(orig, 2, Ty.i64);
    const seed = b.extractvalue(orig, 3, Ty.i64);
    const entrySizePtr = b.gep(entryTy, NULL, [I32_1]);
    const entrySize = b.cast("ptrtoint", entrySizePtr, Ty.i64);
    const { buf, bytes } = ctx.emitAllocBytes(lines, cap.ref, entrySize.ref, "hmclone", undefined);
    const newBuf = val(buf, Ty.ptr);
    b.callDiscard(Ty.ptr, "@memcpy", [newBuf, srcData, val(bytes, Ty.i64)]);

    if (ctx.needsDropCg(keyType) || ctx.needsDropCg(valueType)) {
      // memcpy covered states and Copy fields; re-clone owned K/V in
      // occupied slots so the two maps share no heap data
      const condLbl = b.newBlock("hm.clone.cond");
      const bodyLbl = b.newBlock("hm.clone.body");
      const skipLbl = b.newBlock("hm.clone.skip");
      const endLbl = b.newBlock("hm.clone.end");
      const iAddr = b.alloca(Ty.i64);
      b.store(I64_0, iAddr);
      b.br(condLbl);
      b.position(condLbl);
      const iVal = b.load(Ty.i64, iAddr);
      const cmp = b.icmp("ult", iVal, cap);
      b.condBr(cmp, bodyLbl, endLbl);
      b.position(bodyLbl);
      const statePtr = b.gep(entryTy, newBuf, [iVal, I32_0]);
      const state = b.load(Ty.i8, statePtr);
      const occupied = b.icmp("eq", state, val("1", Ty.i8));
      const cloneLbl = b.newBlock("hm.clone.slot");
      b.condBr(occupied, cloneLbl, skipLbl);
      b.position(cloneLbl);
      if (ctx.needsDropCg(keyType)) {
        const srcKeyPtr = b.gep(entryTy, srcData, [iVal, I32_1]);
        const clonedKey = emitDeepCloneFromPtr(ctx, lines, srcKeyPtr.ref, keyType);
        const dstKeyPtr = b.gep(entryTy, newBuf, [iVal, I32_1]);
        b.store(val(clonedKey, Ty.of(ctx.llvmType(keyType))), dstKeyPtr);
      }
      if (ctx.needsDropCg(valueType)) {
        const srcValPtr = b.gep(entryTy, srcData, [iVal, val("2", Ty.i32)]);
        const clonedVal = emitDeepCloneFromPtr(ctx, lines, srcValPtr.ref, valueType);
        const dstValPtr = b.gep(entryTy, newBuf, [iVal, val("2", Ty.i32)]);
        b.store(val(clonedVal, Ty.of(ctx.llvmType(valueType))), dstValPtr);
      }
      b.br(skipLbl);
      b.position(skipLbl);
      const nextI = b.binop("add", iVal, I64_1);
      b.store(nextI, iAddr);
      b.br(condLbl);
      b.position(endLbl);
    }

    const h0 = b.insertvalue(val("undef", HASHMAP), newBuf, 0);
    const h1 = b.insertvalue(h0, len, 1);
    const h2 = b.insertvalue(h1, cap, 2);
    const h3 = b.insertvalue(h2, seed, 3);
    // The buffer is memcpy'd verbatim, tombstone slots and all, so the clone starts
    // life with exactly the source's deleted-slot count — not zero.
    const srcTombs = b.extractvalue(orig, HM_TOMBS, Ty.i64);
    return b.insertvalue(h3, srcTombs, HM_TOMBS).ref;
  }

  // array — fall back to shallow load
  return b.load(Ty.of(lt), src).ref;
}

// Deep-clone an enum by tag: shallow-copy first (tag + Copy payload fields), then
// overwrite each droppable payload field with a deep clone. Mirrors
// ensureDropHelper. Recursive enums terminate because the recursion goes through
// `Heap`, and the memo set stops re-entrant generation.
export function ensureEnumCloneHelper(ctx: DropCtx, enumName: string) {
  if (ctx.dropGlueSeen.enumClone.has(enumName)) return;
  ctx.dropGlueSeen.enumClone.add(enumName);

  const layout = must(ctx.enumLayouts, enumName, "enum layouts");
  const enumTy = `%${enumName}`;
  const helperName = `milo.clone.${enumName}`;
  ctx.emitHelperFn(2, (body) => {
    const b = new LlvmTextBuilder(body, ctx);
    const [src, dst] = b.defineFn({ name: helperName, ret: Ty.void, params: [{ name: "src", ty: Ty.ptr }, { name: "dst", ty: Ty.ptr }] });
    const shallow = b.load(Ty.of(enumTy), src);
    b.store(shallow, dst);
    const tag = ctx.loadEnumTag(body, enumTy, src.ref);

    const doneLabel = b.newBlock("clone.done");
    const cases: [number, Block][] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      if (!variant.fieldTypeKinds.some(f => ctx.needsDropCg(f))) continue;

      const label = b.newBlock(`clone.${vName}`);
      cases.push([variant.tag, label]);

      const vLines: string[] = [];
      const vb = new LlvmTextBuilder(vLines, ctx);
      vb.position(label);
      // Copy fields were carried over by the shallow whole-enum copy above.
      for (let i = 0; i < variant.fieldTypes.length; i++) {
        if (!ctx.needsDropCg(variant.fieldTypeKinds[i])) continue;
        const srcFieldPtr = ctx.enumFieldPtr(vLines, enumTy, src.ref, variant, i);
        const cloned = emitDeepCloneFromPtr(ctx, vLines, srcFieldPtr, variant.fieldTypeKinds[i]);
        const dstFieldPtr = ctx.enumFieldPtr(vLines, enumTy, dst.ref, variant, i);
        vb.store(val(cloned, Ty.of(variant.fieldTypes[i])), val(dstFieldPtr, Ty.ptr));
      }
      vb.br(doneLabel);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      b.switch(val(tag, Ty.i32), doneLabel, cases, true);
      for (const vBody of variantBodies) body.push(...vBody);
    } else {
      b.br(doneLabel);
    }
    b.position(doneLabel);
    b.ret();
    b.endFn();
  });
}

// Drop every owning field of the struct at `addr` except `skip`, which has been moved out.
export function dropStructFieldsExcept(ctx: DropCtx, lines: string[], addr: string, structName: string, skip: string) {
  const layout = must(ctx.structLayouts, structName, "struct layouts");
  const b = new LlvmTextBuilder(lines, ctx);
  layout.fields.forEach((f, i) => {
    if (f.name === skip || !ctx.needsDropCg(f.typeKind)) return;
    const fp = b.gep(Ty.of(`%${structName}`), val(addr, Ty.ptr), [I32_0, val(String(i), Ty.i32)]);
    ctx.emitDropValue(lines, fp.ref, f.typeKind);
  });
}

// The drop glue proper for one value, after Codegen.emitDropValue has handled structural-mode re-entry and the ownership ledger.
export function emitDropValueBody(ctx: DropCtx, lines: string[], allocaPtr: string, typeKind: TypeKind): void {
  const b = new LlvmTextBuilder(lines, ctx);
  const slot = val(allocaPtr, Ty.ptr);
  // An owning closure is `{ ptr fn, ptr env }`, and the drop glue lives in the FIRST
  // word of the environment rather than in a third word of the pair. That choice is
  // what keeps a closure two words wide, so nothing that passes one around — call
  // sites, the Task struct, `_callClosureVoid` — has to change. The header is
  // null for a by-reference closure (its environment is a stack slot in the frame that
  // built it, and freeing that would corrupt the frame), and the whole environment is
  // null for a closure that captured nothing — the two null checks are what let one
  // drop path serve all three shapes.
  if (typeKind.tag === "fn" && typeKind.owning === true) {
    const callLabel = b.newBlock("cldrop.call");
    const midLabel = b.newBlock("cldrop.mid");
    const doneLabel = b.newBlock("cldrop.done");
    const pair = b.load(CLOSURE, slot);
    const env = b.extractvalue(pair, 1, Ty.ptr);
    const isEnv = b.icmp("ne", env, NULL);
    b.condBr(isEnv, midLabel, doneLabel);
    b.position(midLabel);
    const dropFn = b.load(Ty.ptr, env);
    const hasDrop = b.icmp("ne", dropFn, NULL);
    b.condBr(hasDrop, callLabel, doneLabel);
    b.position(callLabel);
    b.callDiscard(Ty.void, dropFn.ref, [env]);
    b.br(doneLabel);
    b.position(doneLabel);
    return;
  }
  if (typeKind.tag === "string") {
    ctx.strRt();
    const old = b.load(STRING, slot);
    const cap = b.extractvalue(old, 2, Ty.i64);
    const owned = b.icmp("ugt", cap, I64_0);
    const dropLabel = b.newBlock("drop");
    const skipLabel = b.newBlock("drop.skip");
    b.condBr(owned, dropLabel, skipLabel);
    b.position(dropLabel);
    const ptr = b.extractvalue(old, 0, Ty.ptr);
    // One handle fewer; the buffer goes when the last one does (see strRt).
    b.callDiscard(Ty.void, "@milo.str.release", [ptr]);
    b.br(skipLabel);
    b.position(skipLabel);
  }
  if (typeKind.tag === "vec") {
    ctx.needsFree = true;
    const vecVal = b.load(VEC, slot);
    const dataPtr = b.extractvalue(vecVal, 0, Ty.ptr);
    const isNull = b.icmp("eq", dataPtr, NULL);
    const dropLabel = b.newBlock("vec.drop");
    const skipLabel = b.newBlock("vec.skip");
    b.condBr(isNull, skipLabel, dropLabel);
    b.position(dropLabel);
    if (ctx.needsDropCg(typeKind.element)) {
      // drop each element: for i in 0..len
      const vecLen = b.extractvalue(vecVal, 1, Ty.i64);
      const elemTy = Ty.of(ctx.llvmType(typeKind.element));
      const loopCond = b.newBlock("vec.drop.cond");
      const loopBody = b.newBlock("vec.drop.body");
      const loopEnd = b.newBlock("vec.drop.end");
      const iAddr = b.alloca(Ty.i64);
      b.store(I64_0, iAddr);
      b.br(loopCond);
      b.position(loopCond);
      const iVal = b.load(Ty.i64, iAddr);
      const cmp = b.icmp("ult", iVal, vecLen);
      b.condBr(cmp, loopBody, loopEnd);
      b.position(loopBody);
      const elemPtr = b.gep(elemTy, dataPtr, [iVal]);
      ctx.emitDropValue(lines, elemPtr.ref, typeKind.element);
      const nextI = b.binop("add", iVal, I64_1);
      b.store(nextI, iAddr);
      b.br(loopCond);
      b.position(loopEnd);
    }
    b.callDiscard(Ty.void, "@free", [dataPtr]);
    b.br(skipLabel);
    b.position(skipLabel);
  }
  if (typeKind.tag === "heap") {
    ctx.needsFree = true;
    let heapPtr: Val;
    if (typeKind.inner.tag === "interface") {
      // Heap<Interface> is { ptr, ptr } — extract data ptr from element 0
      const fatPtr = b.load(CLOSURE, slot);
      heapPtr = b.extractvalue(fatPtr, 0, Ty.ptr);
    } else {
      heapPtr = b.load(Ty.ptr, slot);
    }
    const isNull = b.icmp("eq", heapPtr, NULL);
    const dropLabel = b.newBlock("heap.drop");
    const skipLabel = b.newBlock("heap.skip");
    b.condBr(isNull, skipLabel, dropLabel);
    b.position(dropLabel);
    if (typeKind.inner.tag === "interface") {
      // The concrete type is erased here, so its destructor is reached through the
      // itable's trailing drop slot. A null slot means the concrete type has none.
      const n = ctx.ifaceMethodCounts.get(typeKind.inner.name);
      if (n !== undefined) {
        const fat = b.load(CLOSURE, slot);
        const itab = b.extractvalue(fat, 1, Ty.ptr);
        const dropSlot = b.gep(Ty.ptr, itab, [val(String(n), Ty.i32)]);
        const dropFn = b.load(Ty.ptr, dropSlot);
        const noDrop = b.icmp("eq", dropFn, NULL);
        const callLbl = b.newBlock("iface.drop.call");
        const afterLbl = b.newBlock("iface.drop.after");
        b.condBr(noDrop, afterLbl, callLbl);
        b.position(callLbl);
        b.callDiscard(Ty.void, dropFn.ref, [heapPtr]);
        b.br(afterLbl);
        b.position(afterLbl);
      }
    } else if (ctx.needsDropCg(typeKind.inner)) {
      ctx.emitDropValue(lines, heapPtr.ref, typeKind.inner);
    }
    b.callDiscard(Ty.void, "@free", [heapPtr]);
    b.br(skipLabel);
    b.position(skipLabel);
  }
  if (typeKind.tag === "hashmap") {
    ctx.needsFree = true;
    const hmVal = b.load(HASHMAP, slot);
    const hmDataPtr = b.extractvalue(hmVal, 0, Ty.ptr);
    const isNull = b.icmp("eq", hmDataPtr, NULL);
    const dropLabel = b.newBlock("hm.drop");
    const skipLabel = b.newBlock("hm.skip");
    b.condBr(isNull, skipLabel, dropLabel);
    b.position(dropLabel);
    if (ctx.needsDropCg(typeKind.key) || ctx.needsDropCg(typeKind.value)) {
      const hmCap = b.extractvalue(hmVal, 2, Ty.i64);
      const entryTy = Ty.of(ctx.hashMapEntryType(typeKind.key, typeKind.value));
      const loopCond = b.newBlock("hm.drop.cond");
      const loopBody = b.newBlock("hm.drop.body");
      const loopEnd = b.newBlock("hm.drop.end");
      const iAddr = b.alloca(Ty.i64);
      b.store(I64_0, iAddr);
      b.br(loopCond);
      b.position(loopCond);
      const iVal = b.load(Ty.i64, iAddr);
      const cmp = b.icmp("ult", iVal, hmCap);
      b.condBr(cmp, loopBody, loopEnd);
      b.position(loopBody);
      const entryPtr = b.gep(entryTy, hmDataPtr, [iVal]);
      const state = b.load(Ty.i8, entryPtr);
      const isOccupied = b.icmp("eq", state, val("1", Ty.i8));
      const dropEntryLabel = b.newBlock("hm.drop.entry");
      const skipEntryLabel = b.newBlock("hm.drop.skip");
      b.condBr(isOccupied, dropEntryLabel, skipEntryLabel);
      b.position(dropEntryLabel);
      if (ctx.needsDropCg(typeKind.key)) {
        const kPtr = b.gep(entryTy, entryPtr, [I32_0, I32_1]);
        ctx.emitDropValue(lines, kPtr.ref, typeKind.key);
      }
      if (ctx.needsDropCg(typeKind.value)) {
        const vPtr = b.gep(entryTy, entryPtr, [I32_0, val("2", Ty.i32)]);
        ctx.emitDropValue(lines, vPtr.ref, typeKind.value);
      }
      b.br(skipEntryLabel);
      b.position(skipEntryLabel);
      const nextI = b.binop("add", iVal, I64_1);
      b.store(nextI, iAddr);
      b.br(loopCond);
      b.position(loopEnd);
    }
    b.callDiscard(Ty.void, "@free", [hmDataPtr]);
    b.br(skipLabel);
    b.position(skipLabel);
  }
  if (typeKind.tag === "enum" && ctx.droppableEnums.has(typeKind.name)) {
    const helperName = `milo.${ctx.structuralDrop ? "sdrop" : "drop"}.${typeKind.name}`;
    ensureDropHelper(ctx, typeKind.name);
    const enumTy = Ty.of(`%${typeKind.name}`);
    const loaded = b.load(enumTy, slot);
    const tmp = b.alloca(enumTy);
    b.store(loaded, tmp);
    b.callDiscard(Ty.void, `@${helperName}`, [tmp]);
  }
  if (typeKind.tag === "array" && typeKind.size !== null && ctx.needsDropCg(typeKind.element)) {
    const elemTy = ctx.llvmType(typeKind.element);
    for (let i = 0; i < typeKind.size; i++) {
      const arrTy = Ty.of(`[${typeKind.size} x ${elemTy}]`);
      const elemPtr = b.gep(arrTy, slot, [I32_0, val(String(i), Ty.i32)]);
      ctx.emitDropValue(lines, elemPtr.ref, typeKind.element);
    }
  }
  if (typeKind.tag === "struct" && ctx.structNeedsDrop(typeKind.name)) {
    ensureStructDropHelper(ctx, typeKind.name);
    const helperName = `milo.${ctx.structuralDrop ? "sdrop" : "drop"}.struct.${typeKind.name}`;
    b.callDiscard(Ty.void, `@${helperName}`, [slot]);
  }
}

export function ensureDropHelper(ctx: DropCtx, enumName: string) {
  const kind = ctx.structuralDrop ? "sdrop" : "drop";
  if (ctx.dropGlueSeen.enumDrop.has(`${kind}.${enumName}`)) return;
  ctx.dropGlueSeen.enumDrop.add(`${kind}.${enumName}`);

  const layout = must(ctx.enumLayouts, enumName, "enum layouts");
  const enumTy = `%${enumName}`;
  const helperName = `milo.${kind}.${enumName}`;
  ctx.emitHelperFn(undefined, (body) => {
    const b = new LlvmTextBuilder(body, ctx);
    const [self] = b.defineFn({ name: helperName, ret: Ty.void, params: [{ name: "self", ty: Ty.ptr }] });
    const tag = ctx.loadEnumTag(body, enumTy, self.ref);

    const doneLabel = b.newBlock("drop.done");
    const cases: [number, Block][] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      const hasDroppable = variant.fieldTypeKinds.some(f => ctx.needsDropCg(f));
      if (!hasDroppable) continue;

      const label = b.newBlock(`drop.${vName}`);
      cases.push([variant.tag, label]);

      const vLines: string[] = [];
      const vb = new LlvmTextBuilder(vLines, ctx);
      vb.position(label);
      for (let i = 0; i < variant.fieldTypes.length; i++) {
        if (!ctx.needsDropCg(variant.fieldTypeKinds[i])) continue;
        const fieldPtr = ctx.enumFieldPtr(vLines, enumTy, self.ref, variant, i);
        ctx.emitDropValue(vLines, fieldPtr, variant.fieldTypeKinds[i]);
      }
      vb.br(doneLabel);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      b.switch(val(tag, Ty.i32), doneLabel, cases, true);
      for (const vBody of variantBodies) body.push(...vBody);
    }

    b.position(doneLabel);
    b.ret();
    b.endFn();
  });
}

export function ensureStructCloneHelper(ctx: DropCtx, structName: string) {
  if (ctx.dropGlueSeen.structClone.has(structName)) return;
  ctx.dropGlueSeen.structClone.add(structName);

  const layout = must(ctx.structLayouts, structName, "struct layouts");
  const structTy = Ty.of(`%${structName}`);
  const helperName = `milo.clone.struct.${structName}`;
  ctx.emitHelperFn(2, (body) => {
    const b = new LlvmTextBuilder(body, ctx);
    const [src, dst] = b.defineFn({ name: helperName, ret: Ty.void, params: [{ name: "src", ty: Ty.ptr }, { name: "dst", ty: Ty.ptr }] });
    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const srcFieldPtr = b.gep(structTy, src, [I32_0, val(String(i), Ty.i32)]);
      const clonedField = emitDeepCloneFromPtr(ctx, body, srcFieldPtr.ref, f.typeKind);
      const dstFieldPtr = b.gep(structTy, dst, [I32_0, val(String(i), Ty.i32)]);
      b.store(val(clonedField, Ty.of(f.type)), dstFieldPtr);
    }
    b.ret();
    b.endFn();
  });
}

export function ensureStructDropHelper(ctx: DropCtx, structName: string) {
  const kind = ctx.structuralDrop ? "sdrop" : "drop";
  if (ctx.dropGlueSeen.structDrop.has(`${kind}.${structName}`)) return;
  ctx.dropGlueSeen.structDrop.add(`${kind}.${structName}`);

  const layout = must(ctx.structLayouts, structName, "struct layouts");
  const helperName = `milo.${kind}.struct.${structName}`;
  ctx.emitHelperFn(undefined, (body) => {
    const b = new LlvmTextBuilder(body, ctx);
    const [self] = b.defineFn({ name: helperName, ret: Ty.void, params: [{ name: "self", ty: Ty.ptr }] });
    const structTy = Ty.of(`%${structName}`);
    // Every field is dropped unconditionally: each field's own drop already treats its
    // zeroed (moved-from) form as empty, so a struct that was moved out of and zeroed
    // drops to nothing field by field. Deciding liveness for the WHOLE struct by probing
    // its heap fields for non-null was wrong for every struct whose heap fields happened
    // to be empty: `{ response: Resp.Text(body), headers: [] }` read as moved-from and
    // leaked `body` (std/http leaked every response body whose handler set no header).
    //
    // The probe survives only to gate a user `Drop` impl, which is the one thing that
    // must not run on a zeroed struct (a moved field of a parent, or an element moved
    // out of a container, leaves zeroed bytes behind that the parent's glue still
    // visits). Its residual hole is unchanged: such a struct whose heap fields are all
    // empty is indistinguishable from a moved-from one, and its Drop is skipped.
    if (ctx.dropImpls.has(structName) && !ctx.structuralDrop) {
      const skipLabel = b.newBlock("struct.userdrop.skip");
      const dropLabel = b.newBlock("struct.userdrop");
      const heapCandidates = layout.fields.flatMap((f, i) => {
        const t = f.typeKind.tag;
        return t === "string" || t === "vec" || t === "hashmap" || t === "heap" ? [{ i, ll: "ptr", zero: "null" }] : [];
      });
      // Scalars only AUGMENT a pointer probe; they never create one. The zeroed-ness of
      // an integer says nothing about liveness on its own, and gating on it skipped the
      // destructor of every `Tracked { id: 0 }` (tests/fixtures/dropAccounting.milo).
      const scalarCandidates = heapCandidates.length > 0
        ? layout.fields.flatMap((f, i) =>
            f.typeKind.tag === "int" || f.typeKind.tag === "bool" ? [{ i, ll: f.type, zero: "0" }] : [])
        : [];
      const candidates = [...heapCandidates, ...scalarCandidates];
      const mangledDrop = `${structName}$Drop$drop`;
      if (candidates.length > 0) {
        let alive: Val | null = null;
        for (const c of candidates) {
          const fieldPtr = b.gep(structTy, self, [I32_0, val(String(c.i), Ty.i32)]);
          const probeTy = Ty.of(c.ll);
          const probe = b.load(probeTy, fieldPtr);
          const nonZero = b.icmp("ne", probe, val(c.zero, probeTy));
          alive = alive === null ? nonZero : b.binop("or", alive, nonZero);
        }
        b.condBr(alive!, dropLabel, skipLabel);
        b.position(dropLabel);
        b.callDiscard(Ty.void, `@${mangledDrop}`, [self]);
        b.br(skipLabel);
        b.position(skipLabel);
      } else {
        b.callDiscard(Ty.void, `@${mangledDrop}`, [self]);
      }
    }
    for (let i = layout.fields.length - 1; i >= 0; i--) {
      const field = layout.fields[i];
      if (ctx.needsDropCg(field.typeKind)) {
        const fieldPtr = b.gep(structTy, self, [I32_0, val(String(i), Ty.i32)]);
        ctx.emitDropValue(body, fieldPtr.ref, field.typeKind);
      }
    }
    b.ret();
    b.endFn();
  });
}
