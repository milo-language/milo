// Drop and clone glue: per-type drop sequences, deep clone, and the generated drop/clone helper functions.

import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { NameSource } from "./ir";
import type { StructLayout, EnumLayout, EnumVariant } from "./codegen";
import { HM_TOMBS } from "./codegen-map";
import { must } from "./must";

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
  // An owning closure is `{ ptr fn, ptr env }`, and the drop glue lives in the FIRST
  // word of the environment rather than in a third word of the pair. That choice is
  // what keeps a closure two words wide, so nothing that passes one around — call
  // sites, the Task struct, `_callClosureVoid` — has to change. The header is
  // null for a by-reference closure (its environment is a stack slot in the frame that
  // built it, and freeing that would corrupt the frame), and the whole environment is
  // null for a closure that captured nothing — the two null checks are what let one
  // drop path serve all three shapes.
  if (typeKind.tag === "fn" && typeKind.owning === true) {
    const pair = ctx.nextTemp(), env = ctx.nextTemp(), isEnv = ctx.nextTemp();
    const dropFn = ctx.nextTemp(), hasDrop = ctx.nextTemp();
    const callLabel = ctx.nextLabel("cldrop.call");
    const midLabel = ctx.nextLabel("cldrop.mid");
    const doneLabel = ctx.nextLabel("cldrop.done");
    lines.push(`  ${pair} = load { ptr, ptr }, ptr ${allocaPtr}`);
    lines.push(`  ${env} = extractvalue { ptr, ptr } ${pair}, 1`);
    lines.push(`  ${isEnv} = icmp ne ptr ${env}, null`);
    lines.push(`  br i1 ${isEnv}, label %${midLabel}, label %${doneLabel}`);
    lines.push(`${midLabel}:`);
    lines.push(`  ${dropFn} = load ptr, ptr ${env}`);
    lines.push(`  ${hasDrop} = icmp ne ptr ${dropFn}, null`);
    lines.push(`  br i1 ${hasDrop}, label %${callLabel}, label %${doneLabel}`);
    lines.push(`${callLabel}:`);
    lines.push(`  call void ${dropFn}(ptr ${env})`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${doneLabel}:`);
    return;
  }
  if (typeKind.tag === "string") {
    ctx.strRt();
    const old = ctx.nextTemp();
    lines.push(`  ${old} = load %String, ptr ${allocaPtr}`);
    const cap = ctx.nextTemp();
    lines.push(`  ${cap} = extractvalue %String ${old}, 2`);
    const owned = ctx.nextTemp();
    lines.push(`  ${owned} = icmp ugt i64 ${cap}, 0`);
    const dropLabel = ctx.nextLabel("drop");
    const skipLabel = ctx.nextLabel("drop.skip");
    lines.push(`  br i1 ${owned}, label %${dropLabel}, label %${skipLabel}`);
    lines.push(`${dropLabel}:`);
    const ptr = ctx.nextTemp();
    lines.push(`  ${ptr} = extractvalue %String ${old}, 0`);
    // One handle fewer; the buffer goes when the last one does (see strRt).
    lines.push(`  call void @milo.str.release(ptr ${ptr})`);
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }
  if (typeKind.tag === "vec") {
    ctx.needsFree = true;
    const vecVal = ctx.nextTemp();
    lines.push(`  ${vecVal} = load %Vec, ptr ${allocaPtr}`);
    const dataPtr = ctx.nextTemp();
    lines.push(`  ${dataPtr} = extractvalue %Vec ${vecVal}, 0`);
    const isNull = ctx.nextTemp();
    lines.push(`  ${isNull} = icmp eq ptr ${dataPtr}, null`);
    const dropLabel = ctx.nextLabel("vec.drop");
    const skipLabel = ctx.nextLabel("vec.skip");
    lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
    lines.push(`${dropLabel}:`);
    if (ctx.needsDropCg(typeKind.element)) {
      // drop each element: for i in 0..len
      const vecLen = ctx.nextTemp();
      lines.push(`  ${vecLen} = extractvalue %Vec ${vecVal}, 1`);
      const elemTy = ctx.llvmType(typeKind.element);
      const loopCond = ctx.nextLabel("vec.drop.cond");
      const loopBody = ctx.nextLabel("vec.drop.body");
      const loopEnd = ctx.nextLabel("vec.drop.end");
      const iAddr = ctx.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
      lines.push(`${loopCond}:`);
      const iVal = ctx.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = ctx.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${vecLen}`);
      lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
      lines.push(`${loopBody}:`);
      const elemPtr = ctx.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${dataPtr}, i64 ${iVal}`);
      ctx.emitDropValue(lines, elemPtr, typeKind.element);
      const nextI = ctx.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
      lines.push(`${loopEnd}:`);
    }
    lines.push(`  call void @free(ptr ${dataPtr})`);
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }
  if (typeKind.tag === "heap") {
    ctx.needsFree = true;
    let heapPtr: string;
    if (typeKind.inner.tag === "interface") {
      // Heap<Interface> is { ptr, ptr } — extract data ptr from element 0
      const fatPtr = ctx.nextTemp();
      lines.push(`  ${fatPtr} = load { ptr, ptr }, ptr ${allocaPtr}`);
      heapPtr = ctx.nextTemp();
      lines.push(`  ${heapPtr} = extractvalue { ptr, ptr } ${fatPtr}, 0`);
    } else {
      heapPtr = ctx.nextTemp();
      lines.push(`  ${heapPtr} = load ptr, ptr ${allocaPtr}`);
    }
    const isNull = ctx.nextTemp();
    lines.push(`  ${isNull} = icmp eq ptr ${heapPtr}, null`);
    const dropLabel = ctx.nextLabel("heap.drop");
    const skipLabel = ctx.nextLabel("heap.skip");
    lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
    lines.push(`${dropLabel}:`);
    if (typeKind.inner.tag === "interface") {
      // The concrete type is erased here, so its destructor is reached through the
      // itable's trailing drop slot. A null slot means the concrete type has none.
      const n = ctx.ifaceMethodCounts.get(typeKind.inner.name);
      if (n !== undefined) {
        const fat = ctx.nextTemp();
        lines.push(`  ${fat} = load { ptr, ptr }, ptr ${allocaPtr}`);
        const itab = ctx.nextTemp();
        lines.push(`  ${itab} = extractvalue { ptr, ptr } ${fat}, 1`);
        const slot = ctx.nextTemp();
        lines.push(`  ${slot} = getelementptr ptr, ptr ${itab}, i32 ${n}`);
        const dropFn = ctx.nextTemp();
        lines.push(`  ${dropFn} = load ptr, ptr ${slot}`);
        const noDrop = ctx.nextTemp();
        lines.push(`  ${noDrop} = icmp eq ptr ${dropFn}, null`);
        const callLbl = ctx.nextLabel("iface.drop.call");
        const afterLbl = ctx.nextLabel("iface.drop.after");
        lines.push(`  br i1 ${noDrop}, label %${afterLbl}, label %${callLbl}`);
        lines.push(`${callLbl}:`);
        lines.push(`  call void ${dropFn}(ptr ${heapPtr})`);
        lines.push(`  br label %${afterLbl}`);
        lines.push(`${afterLbl}:`);
      }
    } else if (ctx.needsDropCg(typeKind.inner)) {
      ctx.emitDropValue(lines, heapPtr, typeKind.inner);
    }
    lines.push(`  call void @free(ptr ${heapPtr})`);
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }
  if (typeKind.tag === "hashmap") {
    ctx.needsFree = true;
    const hmVal = ctx.nextTemp();
    lines.push(`  ${hmVal} = load %HashMap, ptr ${allocaPtr}`);
    const hmDataPtr = ctx.nextTemp();
    lines.push(`  ${hmDataPtr} = extractvalue %HashMap ${hmVal}, 0`);
    const isNull = ctx.nextTemp();
    lines.push(`  ${isNull} = icmp eq ptr ${hmDataPtr}, null`);
    const dropLabel = ctx.nextLabel("hm.drop");
    const skipLabel = ctx.nextLabel("hm.skip");
    lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
    lines.push(`${dropLabel}:`);
    if (ctx.needsDropCg(typeKind.key) || ctx.needsDropCg(typeKind.value)) {
      const hmCap = ctx.nextTemp();
      lines.push(`  ${hmCap} = extractvalue %HashMap ${hmVal}, 2`);
      const entryTy = ctx.hashMapEntryType(typeKind.key, typeKind.value);
      const loopCond = ctx.nextLabel("hm.drop.cond");
      const loopBody = ctx.nextLabel("hm.drop.body");
      const loopEnd = ctx.nextLabel("hm.drop.end");
      const iAddr = ctx.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
      lines.push(`${loopCond}:`);
      const iVal = ctx.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = ctx.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${hmCap}`);
      lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
      lines.push(`${loopBody}:`);
      const entryPtr = ctx.nextTemp();
      lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${hmDataPtr}, i64 ${iVal}`);
      const state = ctx.nextTemp();
      lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
      const isOccupied = ctx.nextTemp();
      lines.push(`  ${isOccupied} = icmp eq i8 ${state}, 1`);
      const dropEntryLabel = ctx.nextLabel("hm.drop.entry");
      const skipEntryLabel = ctx.nextLabel("hm.drop.skip");
      lines.push(`  br i1 ${isOccupied}, label %${dropEntryLabel}, label %${skipEntryLabel}`);
      lines.push(`${dropEntryLabel}:`);
      if (ctx.needsDropCg(typeKind.key)) {
        const kPtr = ctx.nextTemp();
        lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
        ctx.emitDropValue(lines, kPtr, typeKind.key);
      }
      if (ctx.needsDropCg(typeKind.value)) {
        const vPtr = ctx.nextTemp();
        lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
        ctx.emitDropValue(lines, vPtr, typeKind.value);
      }
      lines.push(`  br label %${skipEntryLabel}`);
      lines.push(`${skipEntryLabel}:`);
      const nextI = ctx.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${loopCond}`);
      lines.push(`${loopEnd}:`);
    }
    lines.push(`  call void @free(ptr ${hmDataPtr})`);
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }
  if (typeKind.tag === "enum" && ctx.droppableEnums.has(typeKind.name)) {
    const helperName = `milo.${ctx.structuralDrop ? "sdrop" : "drop"}.${typeKind.name}`;
    ensureDropHelper(ctx, typeKind.name);
    const val = ctx.nextTemp();
    lines.push(`  ${val} = load %${typeKind.name}, ptr ${allocaPtr}`);
    const tmp = ctx.nextTemp();
    lines.push(`  ${tmp} = alloca %${typeKind.name}`);
    lines.push(`  store %${typeKind.name} ${val}, ptr ${tmp}`);
    lines.push(`  call void @${helperName}(ptr ${tmp})`);
  }
  if (typeKind.tag === "array" && typeKind.size !== null && ctx.needsDropCg(typeKind.element)) {
    const elemTy = ctx.llvmType(typeKind.element);
    for (let i = 0; i < typeKind.size; i++) {
      const arrTy = `[${typeKind.size} x ${elemTy}]`;
      const elemPtr = ctx.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${arrTy}, ptr ${allocaPtr}, i32 0, i32 ${i}`);
      ctx.emitDropValue(lines, elemPtr, typeKind.element);
    }
  }
  if (typeKind.tag === "struct" && ctx.structNeedsDrop(typeKind.name)) {
    ensureStructDropHelper(ctx, typeKind.name);
    const helperName = `milo.${ctx.structuralDrop ? "sdrop" : "drop"}.struct.${typeKind.name}`;
    lines.push(`  call void @${helperName}(ptr ${allocaPtr})`);
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
