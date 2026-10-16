// Drop and clone glue: per-type drop sequences, deep clone, and the generated drop/clone helper functions.

import type { TypeKind } from "./types";
import type { Span } from "./ast";
import { LlvmTextBuilder, Ty, val, type NameSource, type Val } from "./ir";
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

  // Copy types: just load
  if (!ctx.needsDropCg(typeKind)) {
    const v = ctx.nextTemp();
    lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
    return v;
  }

  // The one switch for every implicit string copy (`v[i]`, a field read out of a
  // borrow, a struct or Vec clone): a heap buffer is shared by count, not copied.
  if (typeKind.tag === "string") {
    const orig = ctx.nextTemp();
    lines.push(`  ${orig} = load %String, ptr ${srcPtr}`);
    return ctx.emitStrShare(lines, orig);
  }

  if (typeKind.tag === "vec") {
    ctx.hasVecType = true;
    ctx.needsMalloc = true;
    ctx.needsMemcpy = true;
    const orig = ctx.nextTemp();
    lines.push(`  ${orig} = load %Vec, ptr ${srcPtr}`);
    const srcData = ctx.nextTemp();
    lines.push(`  ${srcData} = extractvalue %Vec ${orig}, 0`);
    const vecLen = ctx.nextTemp();
    lines.push(`  ${vecLen} = extractvalue %Vec ${orig}, 1`);
    const elemSize = ctx.typeSizeOf(typeKind.element);
    const elemTy = ctx.llvmType(typeKind.element);

    // result buf pointer (set conditionally below)
    const newBufAddr = ctx.nextTemp();
    lines.push(`  ${newBufAddr} = alloca ptr`);
    lines.push(`  store ptr null, ptr ${newBufAddr}`);

    const isEmpty = ctx.nextTemp();
    lines.push(`  ${isEmpty} = icmp eq i64 ${vecLen}, 0`);
    const allocLabel = ctx.nextLabel("vec.clone.alloc");
    const endLabel = ctx.nextLabel("vec.clone.end");
    lines.push(`  br i1 ${isEmpty}, label %${endLabel}, label %${allocLabel}`);

    lines.push(`${allocLabel}:`);
    const { buf: newBuf, bytes: bytes } = ctx.emitAllocBytes(lines, vecLen, elemSize, "vecclone", undefined);
    lines.push(`  store ptr ${newBuf}, ptr ${newBufAddr}`);

    if (ctx.needsDropCg(typeKind.element)) {
      // deep-clone each element
      const loopCond = ctx.nextLabel("vec.clone.cond");
      const loopBody = ctx.nextLabel("vec.clone.body");
      const iAddr = ctx.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
      lines.push(`${loopCond}:`);
      const iVal = ctx.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = ctx.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${vecLen}`);
      lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${endLabel}`);
      lines.push(`${loopBody}:`);
      const srcElemPtr = ctx.nextTemp();
      lines.push(`  ${srcElemPtr} = getelementptr ${elemTy}, ptr ${srcData}, i64 ${iVal}`);
      const clonedElem = emitDeepCloneFromPtr(ctx, lines, srcElemPtr, typeKind.element);
      const dstElemPtr = ctx.nextTemp();
      lines.push(`  ${dstElemPtr} = getelementptr ${elemTy}, ptr ${newBuf}, i64 ${iVal}`);
      lines.push(`  store ${elemTy} ${clonedElem}, ptr ${dstElemPtr}`);
      const nextI = ctx.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
    } else {
      // Copy element: just memcpy
      lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${srcData}, i64 ${bytes})`);
      lines.push(`  br label %${endLabel}`);
    }

    lines.push(`${endLabel}:`);
    const finalPtr = ctx.nextTemp();
    lines.push(`  ${finalPtr} = load ptr, ptr ${newBufAddr}`);
    const v0 = ctx.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${finalPtr}, 0`);
    const v1 = ctx.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${vecLen}, 1`);
    const v2 = ctx.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${vecLen}, 2`);
    return v2;
  }

  if (typeKind.tag === "heap") {
    ctx.needsMalloc = true;
    const inner = typeKind.inner;
    const innerTy = ctx.llvmType(inner);
    const innerSize = ctx.typeSizeOf(inner);
    const origPtr = ctx.nextTemp();
    lines.push(`  ${origPtr} = load ptr, ptr ${srcPtr}`);
    const newHeap = ctx.nextTemp();
    lines.push(`  ${newHeap} = call ptr @malloc(i64 ${innerSize})`);
    const clonedInner = emitDeepCloneFromPtr(ctx, lines, origPtr, inner);
    lines.push(`  store ${innerTy} ${clonedInner}, ptr ${newHeap}`);
    return newHeap;
  }

  if (typeKind.tag === "struct") {
    const layout = ctx.structLayouts.get(typeKind.name);
    if (!layout) {
      const v = ctx.nextTemp();
      lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
      return v;
    }
    const structTy = `%${typeKind.name}`;
    if (ctx.needsDropCg(typeKind)) {
      ensureStructCloneHelper(ctx, typeKind.name);
      const helperName = `milo.clone.struct.${typeKind.name}`;
      const dstAlloca = ctx.nextTemp();
      lines.push(`  ${dstAlloca} = alloca ${structTy}`);
      lines.push(`  call void @${helperName}(ptr ${srcPtr}, ptr ${dstAlloca})`);
      const result = ctx.nextTemp();
      lines.push(`  ${result} = load ${structTy}, ptr ${dstAlloca}`);
      return result;
    }
    const newAlloca = ctx.nextTemp();
    lines.push(`  ${newAlloca} = alloca ${structTy}`);
    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const srcFieldPtr = ctx.nextTemp();
      lines.push(`  ${srcFieldPtr} = getelementptr ${structTy}, ptr ${srcPtr}, i32 0, i32 ${i}`);
      const clonedField = emitDeepCloneFromPtr(ctx, lines, srcFieldPtr, f.typeKind);
      const dstFieldPtr = ctx.nextTemp();
      lines.push(`  ${dstFieldPtr} = getelementptr ${structTy}, ptr ${newAlloca}, i32 0, i32 ${i}`);
      lines.push(`  store ${f.type} ${clonedField}, ptr ${dstFieldPtr}`);
    }
    const result = ctx.nextTemp();
    lines.push(`  ${result} = load ${structTy}, ptr ${newAlloca}`);
    return result;
  }

  if (typeKind.tag === "enum" && ctx.needsDropCg(typeKind) && ctx.enumLayouts.has(typeKind.name)) {
    ensureEnumCloneHelper(ctx, typeKind.name);
    const dstAlloca = ctx.nextTemp();
    lines.push(`  ${dstAlloca} = alloca ${lt}`);
    lines.push(`  call void @milo.clone.${typeKind.name}(ptr ${srcPtr}, ptr ${dstAlloca})`);
    const result = ctx.nextTemp();
    lines.push(`  ${result} = load ${lt}, ptr ${dstAlloca}`);
    return result;
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
    const entryTy = ctx.hashMapEntryType(keyType, valueType);
    const orig = ctx.nextTemp();
    lines.push(`  ${orig} = load %HashMap, ptr ${srcPtr}`);
    const srcData = ctx.nextTemp();
    lines.push(`  ${srcData} = extractvalue %HashMap ${orig}, 0`);
    const len = ctx.nextTemp();
    lines.push(`  ${len} = extractvalue %HashMap ${orig}, 1`);
    const cap = ctx.nextTemp();
    lines.push(`  ${cap} = extractvalue %HashMap ${orig}, 2`);
    const seed = ctx.nextTemp();
    lines.push(`  ${seed} = extractvalue %HashMap ${orig}, 3`);
    const entrySizePtr = ctx.nextTemp();
    lines.push(`  ${entrySizePtr} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySize = ctx.nextTemp();
    lines.push(`  ${entrySize} = ptrtoint ptr ${entrySizePtr} to i64`);
    const { buf: newBuf, bytes: bytes } = ctx.emitAllocBytes(lines, cap, entrySize, "hmclone", undefined);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${srcData}, i64 ${bytes})`);

    if (ctx.needsDropCg(keyType) || ctx.needsDropCg(valueType)) {
      // memcpy covered states and Copy fields; re-clone owned K/V in
      // occupied slots so the two maps share no heap data
      const condLbl = ctx.nextLabel("hm.clone.cond");
      const bodyLbl = ctx.nextLabel("hm.clone.body");
      const skipLbl = ctx.nextLabel("hm.clone.skip");
      const endLbl = ctx.nextLabel("hm.clone.end");
      const iAddr = ctx.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      lines.push(`  br label %${condLbl}`);
      lines.push(`${condLbl}:`);
      const iVal = ctx.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = ctx.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${cap}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLbl}, label %${endLbl}`);
      lines.push(`${bodyLbl}:`);
      const statePtr = ctx.nextTemp();
      lines.push(`  ${statePtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 0`);
      const state = ctx.nextTemp();
      lines.push(`  ${state} = load i8, ptr ${statePtr}`);
      const occupied = ctx.nextTemp();
      lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
      const cloneLbl = ctx.nextLabel("hm.clone.slot");
      lines.push(`  br i1 ${occupied}, label %${cloneLbl}, label %${skipLbl}`);
      lines.push(`${cloneLbl}:`);
      if (ctx.needsDropCg(keyType)) {
        const srcKeyPtr = ctx.nextTemp();
        lines.push(`  ${srcKeyPtr} = getelementptr ${entryTy}, ptr ${srcData}, i64 ${iVal}, i32 1`);
        const clonedKey = emitDeepCloneFromPtr(ctx, lines, srcKeyPtr, keyType);
        const dstKeyPtr = ctx.nextTemp();
        lines.push(`  ${dstKeyPtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 1`);
        lines.push(`  store ${ctx.llvmType(keyType)} ${clonedKey}, ptr ${dstKeyPtr}`);
      }
      if (ctx.needsDropCg(valueType)) {
        const srcValPtr = ctx.nextTemp();
        lines.push(`  ${srcValPtr} = getelementptr ${entryTy}, ptr ${srcData}, i64 ${iVal}, i32 2`);
        const clonedVal = emitDeepCloneFromPtr(ctx, lines, srcValPtr, valueType);
        const dstValPtr = ctx.nextTemp();
        lines.push(`  ${dstValPtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 2`);
        lines.push(`  store ${ctx.llvmType(valueType)} ${clonedVal}, ptr ${dstValPtr}`);
      }
      lines.push(`  br label %${skipLbl}`);
      lines.push(`${skipLbl}:`);
      const nextI = ctx.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${condLbl}`);
      lines.push(`${endLbl}:`);
    }

    const h0 = ctx.nextTemp();
    lines.push(`  ${h0} = insertvalue %HashMap undef, ptr ${newBuf}, 0`);
    const h1 = ctx.nextTemp();
    lines.push(`  ${h1} = insertvalue %HashMap ${h0}, i64 ${len}, 1`);
    const h2 = ctx.nextTemp();
    lines.push(`  ${h2} = insertvalue %HashMap ${h1}, i64 ${cap}, 2`);
    const h3 = ctx.nextTemp();
    lines.push(`  ${h3} = insertvalue %HashMap ${h2}, i64 ${seed}, 3`);
    // The buffer is memcpy'd verbatim, tombstone slots and all, so the clone starts
    // life with exactly the source's deleted-slot count — not zero.
    const srcTombs = ctx.nextTemp();
    lines.push(`  ${srcTombs} = extractvalue %HashMap ${orig}, ${HM_TOMBS}`);
    const h4 = ctx.nextTemp();
    lines.push(`  ${h4} = insertvalue %HashMap ${h3}, i64 ${srcTombs}, ${HM_TOMBS}`);
    return h4;
  }

  // array — fall back to shallow load
  const v = ctx.nextTemp();
  lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
  return v;
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
    body.push(`define void @${helperName}(ptr %src, ptr %dst) {`);
    body.push("entry.bb:");
    const shallow = ctx.nextTemp();
    body.push(`  ${shallow} = load ${enumTy}, ptr %src`);
    body.push(`  store ${enumTy} ${shallow}, ptr %dst`);
    const tag = ctx.loadEnumTag(body, enumTy, "%src");

    const doneLabel = ctx.nextLabel("clone.done");
    const cases: string[] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      if (!variant.fieldTypeKinds.some(f => ctx.needsDropCg(f))) continue;

      const label = ctx.nextLabel(`clone.${vName}`);
      cases.push(`    i32 ${variant.tag}, label %${label}`);

      const vLines: string[] = [];
      vLines.push(`${label}:`);
      // Copy fields were carried over by the shallow whole-enum copy above.
      for (let i = 0; i < variant.fieldTypes.length; i++) {
        if (!ctx.needsDropCg(variant.fieldTypeKinds[i])) continue;
        const srcFieldPtr = ctx.enumFieldPtr(vLines, enumTy, "%src", variant, i);
        const cloned = emitDeepCloneFromPtr(ctx, vLines, srcFieldPtr, variant.fieldTypeKinds[i]);
        const dstFieldPtr = ctx.enumFieldPtr(vLines, enumTy, "%dst", variant, i);
        vLines.push(`  store ${variant.fieldTypes[i]} ${cloned}, ptr ${dstFieldPtr}`);
      }
      vLines.push(`  br label %${doneLabel}`);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      body.push(`  switch i32 ${tag}, label %${doneLabel} [`);
      for (const c of cases) body.push(c);
      body.push("  ]");
      for (const vb of variantBodies) body.push(...vb);
    } else {
      body.push(`  br label %${doneLabel}`);
    }
    body.push(`${doneLabel}:`);
    body.push("  ret void");
    body.push("}");

    // Helper bodies bypass the normal function emitter, so hoist here: the clone
    // of a Vec field emits its allocas inside the copy loop, and a dynamic alloca
    // per iteration walks the stack off the end.
  });
}

// Drop every owning field of the struct at `addr` except `skip`, which has been moved out.
export function dropStructFieldsExcept(ctx: DropCtx, lines: string[], addr: string, structName: string, skip: string) {
  const layout = must(ctx.structLayouts, structName, "struct layouts");
  layout.fields.forEach((f, i) => {
    if (f.name === skip || !ctx.needsDropCg(f.typeKind)) return;
    const fp = ctx.nextTemp();
    lines.push(`  ${fp} = getelementptr %${structName}, ptr ${addr}, i32 0, i32 ${i}`);
    ctx.emitDropValue(lines, fp, f.typeKind);
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
    body.push(`define void @${helperName}(ptr %self) {`);
    body.push("entry.bb:");
    const tag = ctx.loadEnumTag(body, enumTy, "%self");

    const doneLabel = ctx.nextLabel("drop.done");
    const cases: string[] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      const hasDroppable = variant.fieldTypeKinds.some(f => ctx.needsDropCg(f));
      if (!hasDroppable) continue;

      const label = ctx.nextLabel(`drop.${vName}`);
      cases.push(`    i32 ${variant.tag}, label %${label}`);

      const vLines: string[] = [];
      vLines.push(`${label}:`);
      for (let i = 0; i < variant.fieldTypes.length; i++) {
        if (!ctx.needsDropCg(variant.fieldTypeKinds[i])) continue;
        const fieldPtr = ctx.enumFieldPtr(vLines, enumTy, "%self", variant, i);
        ctx.emitDropValue(vLines, fieldPtr, variant.fieldTypeKinds[i]);
      }
      vLines.push(`  br label %${doneLabel}`);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      body.push(`  switch i32 ${tag}, label %${doneLabel} [`);
      for (const c of cases) body.push(c);
      body.push("  ]");
      for (const vb of variantBodies) body.push(...vb);
    }

    body.push(`${doneLabel}:`);
    body.push("  ret void");
    body.push("}");
  });
}

export function ensureStructCloneHelper(ctx: DropCtx, structName: string) {
  if (ctx.dropGlueSeen.structClone.has(structName)) return;
  ctx.dropGlueSeen.structClone.add(structName);

  const layout = must(ctx.structLayouts, structName, "struct layouts");
  const structTy = `%${structName}`;
  const helperName = `milo.clone.struct.${structName}`;
  ctx.emitHelperFn(2, (body) => {
    body.push(`define void @${helperName}(ptr %src, ptr %dst) {`);
    body.push("entry.bb:");
    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const srcFieldPtr = ctx.nextTemp();
      body.push(`  ${srcFieldPtr} = getelementptr ${structTy}, ptr %src, i32 0, i32 ${i}`);
      const clonedField = emitDeepCloneFromPtr(ctx, body, srcFieldPtr, f.typeKind);
      const dstFieldPtr = ctx.nextTemp();
      body.push(`  ${dstFieldPtr} = getelementptr ${structTy}, ptr %dst, i32 0, i32 ${i}`);
      body.push(`  store ${f.type} ${clonedField}, ptr ${dstFieldPtr}`);
    }
    body.push("  ret void");
    body.push("}");
  });
}

export function ensureStructDropHelper(ctx: DropCtx, structName: string) {
  const kind = ctx.structuralDrop ? "sdrop" : "drop";
  if (ctx.dropGlueSeen.structDrop.has(`${kind}.${structName}`)) return;
  ctx.dropGlueSeen.structDrop.add(`${kind}.${structName}`);

  const layout = must(ctx.structLayouts, structName, "struct layouts");
  const helperName = `milo.${kind}.struct.${structName}`;
  ctx.emitHelperFn(undefined, (body) => {
    body.push(`define void @${helperName}(ptr %self) {`);
    body.push("entry.bb:");
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
      const skipLabel = ctx.nextLabel("struct.userdrop.skip");
      const dropLabel = ctx.nextLabel("struct.userdrop");
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
        let alive: string | null = null;
        for (const c of candidates) {
          const fieldPtr = ctx.nextTemp();
          body.push(`  ${fieldPtr} = getelementptr %${structName}, ptr %self, i32 0, i32 ${c.i}`);
          const probe = ctx.nextTemp();
          body.push(`  ${probe} = load ${c.ll}, ptr ${fieldPtr}`);
          const nonZero = ctx.nextTemp();
          body.push(`  ${nonZero} = icmp ne ${c.ll} ${probe}, ${c.zero}`);
          if (alive === null) {
            alive = nonZero;
          } else {
            const merged = ctx.nextTemp();
            body.push(`  ${merged} = or i1 ${alive}, ${nonZero}`);
            alive = merged;
          }
        }
        body.push(`  br i1 ${alive}, label %${dropLabel}, label %${skipLabel}`);
        body.push(`${dropLabel}:`);
        body.push(`  call void @${mangledDrop}(ptr %self)`);
        body.push(`  br label %${skipLabel}`);
        body.push(`${skipLabel}:`);
      } else {
        body.push(`  call void @${mangledDrop}(ptr %self)`);
      }
    }
    for (let i = layout.fields.length - 1; i >= 0; i--) {
      const field = layout.fields[i];
      if (ctx.needsDropCg(field.typeKind)) {
        const fieldPtr = ctx.nextTemp();
        body.push(`  ${fieldPtr} = getelementptr %${structName}, ptr %self, i32 0, i32 ${i}`);
        ctx.emitDropValue(body, fieldPtr, field.typeKind);
      }
    }
    body.push("  ret void");
    body.push("}");
  });
}
