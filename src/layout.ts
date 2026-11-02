// Type layout: struct and enum registration, sizes, alignments, field offsets, niches and
// which types need drop glue. Pure functions of the HIRModule's types, split out of
// codegen.ts so layouts outlive the legacy emitter. llvmType also records which builtin
// struct types (%String, %Vec, %HashMap) were mentioned, because the emitter has to
// define exactly those.

import type { HIRModule } from "./hir";
import { type TypeKind, needsDrop } from "./types";
import { HASHMAP_FIELDS } from "./codegen-map";
import { must } from "./must";

export interface StructLayout {
  name: string;
  fields: { name: string; type: string; typeKind: TypeKind }[];
}

export interface EnumVariant { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }

export interface EnumLayout {
  name: string;
  // Each variant is laid out like the C struct `{ i32 tag; <its fields> }`, so its first
  // field sits right after the tag at that field's own alignment, not after padding some
  // other variant needs (see variantFieldOffsets). The enum is the largest such struct,
  // rounded to the enum's alignment (max of the tag's and every field's). The LLVM type
  // is one padding-free array of that alignment's integers, `{ [size/A x i<A*8>] }`; the
  // tag is its first 4 bytes. It must have no padding: a variant's field can sit where
  // `{ i32, [n x i64] }` pads, and LLVM drops padding bytes when it splits a whole-enum
  // load or store. Nothing indexes the array (assertEnumPayloadPacked).
  size: number;          // total bytes; 0 = fieldless enum (`{ i32 }`)
  payloadAlign: number;  // max alignment over every variant's fields
  variants: Map<string, EnumVariant>;
  // Set for an Option-shaped enum whose payload has a value safe code cannot produce
  // (see nicheOf). The enum is then laid out as the payload alone, `{ P }`: the fieldless
  // variant is the niche value in the payload's leading integer, the other variant is the
  // payload itself. No tag word exists, so every tag and payload access goes through
  // loadEnumTag / storeEnumTag / enumPayloadPtr.
  niche?: EnumNiche;
}

export interface EnumNiche {
  payloadTy: string;     // LLVM type of the payload (and, wrapped, of the enum)
  intTy: string;         // the integer at offset 0 that carries the niche
  value: string;         // the niche value as an LLVM constant of intTy
  noneTag: number;       // tag of the fieldless variant
  someTag: number;       // tag of the payload variant
}

export class Layout {
  public structLayouts = new Map<string, StructLayout>();
  public enumLayouts = new Map<string, EnumLayout>();
  public droppableEnums = new Set<string>();
  public dropImpls = new Set<string>();
  private structDropCache = new Map<string, boolean>();
  public hasStringType = false;
  public hasVecType = false;
  public hasHashMapType = false;

  build(module: HIRModule) {
    // register struct layouts
    for (const s of module.structs) {
      const layout: StructLayout = {
        name: s.name,
        fields: s.fields.map(f => ({ name: f.name, type: this.llvmType(f.type), typeKind: f.type })),
      };
      this.structLayouts.set(s.name, layout);
    }

    // Register enum layouts. An enum payload can itself be an enum
    // (`Return(Option<Heap<Expr>>)`), and monomorphized generics like
    // `Option_i64` are appended *after* the enums that reference them. A single
    // pass would therefore size such a payload via typeSize()'s 8-byte fallback
    // — `%Outer = { i32, [1 x i64] }` holding a 16-byte `%Option_i64` — and the
    // store would scribble past the slot. Seed every layout, then grow payload
    // sizes to a fixpoint (monotone, so it terminates; recursion goes through
    // Heap, which is a pointer).
    for (const e of module.enums) {
      const variants = new Map<string, EnumVariant>();
      for (const v of e.variants) {
        variants.set(v.name, { tag: v.tag, fieldTypes: v.fields.map(f => this.llvmType(f)), fieldTypeKinds: v.fields });
      }
      this.enumLayouts.set(e.name, { name: e.name, size: 0, payloadAlign: 1, variants });
    }
    for (const layout of this.enumLayouts.values()) {
      const niche = this.enumNiche(layout, module.dropImpls);
      if (niche) layout.niche = niche;
    }
    for (let pass = 0; pass <= module.enums.length; pass++) {
      let changed = false;
      for (const e of module.enums) {
        const layout = must(this.enumLayouts, e.name, "enum layouts");
        let maxEnd = 0;
        let maxAlign = 1;
        for (const v of layout.variants.values()) {
          if (v.fieldTypes.length === 0) continue;
          maxEnd = Math.max(maxEnd, this.structPayloadSize(["i32", ...v.fieldTypes]));
          maxAlign = Math.max(maxAlign, this.structAlign(v.fieldTypes));
        }
        if (maxEnd === 0) continue;
        const enumAlign = Math.max(4, maxAlign);
        const size = Math.ceil(maxEnd / enumAlign) * enumAlign;
        if (size !== layout.size || maxAlign !== layout.payloadAlign) {
          layout.size = size;
          layout.payloadAlign = maxAlign;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // store user-defined Drop impls
    this.dropImpls = module.dropImpls;
    this.structDropCache.clear();

    // compute which enums need drop glue, to a fixpoint: an enum can hold one declared
    // after it (`enum W { Wrap(Option<string>) }`), and a single pass in declaration
    // order left W without glue, leaking every payload it held. The struct cache is
    // cleared each pass because it memoizes answers that read droppableEnums.
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, layout] of this.enumLayouts) {
        if (this.droppableEnums.has(name)) continue;
        for (const [, variant] of layout.variants) {
          if (variant.fieldTypeKinds.some(f => this.needsDropCg(f) || (f.tag === "enum" && f.name === name))) {
            this.droppableEnums.add(name);
            changed = true;
            break;
          }
        }
      }
      if (changed) this.structDropCache.clear();
    }
  }

  public llvmType(t: TypeKind): string {
    switch (t.tag) {
      case "int":    return `i${t.bits}`;
      case "float":  return t.bits === 32 ? "float" : "double";
      case "bool":   return "i1";
      case "void":   return "void";
      case "string": this.hasStringType = true; return "%String";
      case "ptr":    return "ptr";
      case "heap":
        if (t.inner.tag === "interface") return "{ ptr, ptr }";
        return "ptr";
      case "vec":    this.hasVecType = true; return "%Vec";
      case "hashmap": this.hasHashMapType = true; return "%HashMap";
      case "ref":
        if (t.inner.tag === "interface") return "{ ptr, ptr }";
        // `&[T]` is a slice: a non-owning fat pointer carried by value, not an opaque
        // pointer. It shares the Vec's %Vec layout, so a `&[T]` param/return lowers to
        // %Vec — the same value the slice expression already produces. (Other `&T` stay
        // pointer-passed.)
        if (t.inner.tag === "array" && t.inner.size === null) { this.hasVecType = true; return "%Vec"; }
        // A returned `&string` is the same non-owning fat pointer a slice expression
        // already produces (data + len, no ownership), so it travels by value as
        // %String. Params are unaffected: the isRef path passes a pointer to the
        // pointee and never asks for the lowering of the ref type itself.
        if (t.inner.tag === "string") { this.hasStringType = true; return "%String"; }
        return "ptr";
      case "interface": return "{ ptr, ptr }";
      case "struct": return `%${t.name}`;
      case "enum":   return `%${t.name}`;
      case "fn":     return "{ ptr, ptr }";
      case "cfn":    return "ptr";
      case "array":
        if (t.size !== null) return `[${t.size} x ${this.llvmType(t.element)}]`;
        // unsized [T] = slice view: same {ptr,len,cap} layout as Vec, cap=0 → non-owning
        this.hasVecType = true;
        return `%Vec`;
      case "never": return "void";
      case "unknown": throw new Error("unknown type in codegen");
    }
  }

  // A niche: a bit pattern of `t` that no safe program produces, so an Option-shaped enum
  // can spend it on its fieldless variant. Sources: a ranged int (the first value past the
  // declared range that the width can hold; the checker range-checks every safe flow into
  // the type, see tests/rangedSoundness.test.ts), and a struct whose single field has one
  // (the field sits at offset 0). A struct with a Drop impl is left out: its glue would
  // have to learn the encoding, and nothing measured needs it.
  public nicheOf(t: TypeKind, dropImpls: Set<string>, depth = 0): { intTy: string; value: bigint; bits: number } | null {
    if (depth > 16) return null;
    if (t.tag === "int") {
      if (t.min === undefined || t.max === undefined) return null;
      if (!Number.isSafeInteger(t.min) || !Number.isSafeInteger(t.max)) return null;
      const bits = BigInt(t.bits);
      const lo = t.signed ? -(1n << (bits - 1n)) : 0n;
      const hi = t.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      const min = BigInt(t.min), max = BigInt(t.max);
      const intTy = `i${t.bits}`;
      if (max < hi) return { intTy, value: max + 1n, bits: t.bits };
      if (min > lo) return { intTy, value: min - 1n, bits: t.bits };
      return null;
    }
    if (t.tag === "struct") {
      const layout = this.structLayouts.get(t.name);
      if (!layout || layout.fields.length !== 1 || dropImpls.has(t.name)) return null;
      return this.nicheOf(layout.fields[0].typeKind, dropImpls, depth + 1);
    }
    return null;
  }

  public enumNiche(layout: EnumLayout, dropImpls: Set<string>): EnumNiche | null {
    if (layout.variants.size !== 2) return null;
    const [a, b] = [...layout.variants.values()];
    const none = a.fieldTypes.length === 0 ? a : b.fieldTypes.length === 0 ? b : null;
    const some = none === a ? b : a;
    if (!none || some.fieldTypes.length !== 1) return null;
    const n = this.nicheOf(some.fieldTypeKinds[0], dropImpls);
    if (!n) return null;
    // LLVM integer constants are written signed; an unsigned niche above the signed max
    // is the same bits as its two's-complement negative.
    const wrapped = n.value >= (1n << BigInt(n.bits - 1)) ? n.value - (1n << BigInt(n.bits)) : n.value;
    return { payloadTy: some.fieldTypes[0], intTy: n.intTy, value: wrapped.toString(), noneTag: none.tag, someTag: some.tag };
  }

  public nicheOfEnumTy(enumTy: string): EnumNiche | undefined {
    return enumTy.startsWith("%") ? this.enumLayouts.get(enumTy.slice(1))?.niche : undefined;
  }

  // The padding-free array a tagged enum is stored as (see EnumLayout.size).
  public enumStorageTy(layout: EnumLayout): string {
    const a = Math.max(4, layout.payloadAlign);
    return `[${layout.size / a} x i${a * 8}]`;
  }

  public enumVariantOf(enumTy: string, variant: EnumVariant | string | number): EnumVariant {
    if (typeof variant === "object") return variant;
    const layout = must(this.enumLayouts, enumTy.slice(1), "enum layouts");
    for (const [name, info] of layout.variants) if (name === variant || info.tag === variant) return info;
    throw new Error(`internal: ${enumTy} has no variant ${variant}`);
  }

  // Byte offset of each field of a tagged enum's variant from the start of the enum: the
  // variant is the C struct `{ i32 tag; <fields> }`.
  public variantFieldOffsets(fieldTypes: string[]): number[] {
    const withTag = ["i32", ...fieldTypes];
    return fieldTypes.map((_, i) => this.structFieldOffset(withTag, i + 1));
  }

  public typeSize(ty: string): number {
    if (ty === "i1" || ty === "i8") return 1;
    if (ty === "i16") return 2;
    if (ty === "i32") return 4;
    if (ty === "i64") return 8;
    if (ty === "float") return 4;
    if (ty === "double") return 8;
    if (ty === "ptr") return 8;
    if (ty === "{ ptr, ptr }") return 16;
    if (ty === "%String") return 24; // ptr + i64 + i64
    if (ty === "%Vec") return 24; // ptr + i64 + i64
    // Derived from the struct definition rather than written out, because writing it out
    // is how it went wrong: adding the tombstone counter to %HashMap left this at 32 and
    // every struct holding a map got an 8-byte-short memcpy. Fixtures did not notice; the
    // self-hosted compiler segfaulted on its first lookup, because src-milo is full of
    // structs with HashMap fields.
    if (ty === "%HashMap") return HASHMAP_FIELDS * 8;
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return parseInt(arrMatch[1]) * this.typeSize(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structPayloadSize(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = must(this.enumLayouts, enumMatch[1], "enum layouts");
      // i64 payload array requires 8-byte alignment, so the i32 tag is padded to 8.
      // Without this, malloc undersizes by 4 bytes and store %Enum overruns the buffer.
      if (layout.niche) return this.typeSize(layout.niche.payloadTy);
      return layout.size > 0 ? layout.size : 4;
    }
    return 8;
  }

  public typeSizeOf(t: TypeKind): number {
    return this.typeSize(this.llvmType(t));
  }

  public mapSlotLayout(k: TypeKind, v: TypeKind): { size: number; keyOffset: number; valueOffset: number } {
    const kt = this.llvmType(k), vt = this.llvmType(v);
    const ka = this.typeAlign(kt), va = this.typeAlign(vt);
    const up = (n: number, a: number) => Math.ceil(n / a) * a;
    const keyOffset = up(1, ka), valueOffset = up(keyOffset + this.typeSize(kt), va);
    // The offsets of the literal struct legacy's for-in GEPs through, by the same rules
    // (structPayloadSize) every legacy struct size comes from.
    return { size: this.structPayloadSize(["i8", kt, vt]), keyOffset, valueOffset };
  }

  public needsDropCg(t: TypeKind): boolean {
    // An owning closure holds a heap environment. It is droppable exactly because it is
    // not Copy (src/types.ts isCopy): single ownership is what makes running a destructor
    // on it sound, and until that landed, attaching one produced a use-after-free.
    if (t.tag === "fn" && t.owning === true) return true;
    if (needsDrop(t)) return true;
    if (t.tag === "enum") return this.droppableEnums.has(t.name);
    if (t.tag === "struct") return this.structNeedsDrop(t.name);
    if (t.tag === "array" && t.size !== null) return this.needsDropCg(t.element);
    return false;
  }

  public structNeedsDrop(name: string): boolean {
    if (this.structDropCache.has(name)) return must(this.structDropCache, name, "struct drop cache");
    // guard against recursion (recursive structs use Heap, not direct embedding)
    this.structDropCache.set(name, false);
    let result = this.dropImpls.has(name);
    if (!result) {
      const layout = this.structLayouts.get(name);
      if (layout) result = layout.fields.some(f => this.needsDropCg(f.typeKind));
    }
    this.structDropCache.set(name, result);
    return result;
  }

  // True when typeSize/typeAlign compute `ty` exactly rather than falling through to their
  // 8-byte default. dereferenceable/align are promises LLVM speculates loads on, so an
  // unknown leaf (i128, an opaque foreign type) must drop the attribute, not guess.
  public layoutExact(ty: string, depth = 0): boolean {
    if (depth > 32) return false;
    if (/^(i1|i8|i16|i32|i64|float|double|ptr|\{ ptr, ptr \}|%String|%Vec|%HashMap)$/.test(ty)) return true;
    const arr = ty.match(/^\[(\d+) x (.+)\]$/);
    if (arr) return this.layoutExact(arr[2], depth + 1);
    const structName = this.getStructName(ty);
    if (structName) return must(this.structLayouts, structName, "struct layouts").fields.every(f => this.layoutExact(f.type, depth + 1));
    const enumMatch = ty.match(/^%(.+)$/);
    const layout = enumMatch && this.enumLayouts.get(enumMatch[1]);
    if (layout) {
      if (layout.niche) return this.layoutExact(layout.niche.payloadTy, depth + 1);
      return [...layout.variants.values()].every(v => v.fieldTypes.every(f => this.layoutExact(f, depth + 1)));
    }
    return false;
  }

  // Natural alignment of an LLVM type, mirroring typeSize's cases. `min(size,8)` is
  // WRONG for aggregates — a 12-byte nested struct or [3 x i32] aligns to 4, not 8 —
  // which corrupts sizeof/offsetof (and, later, ABI classification) for nested fields.
  public typeAlign(ty: string): number {
    if (ty === "i1" || ty === "i8") return 1;
    if (ty === "i16") return 2;
    if (ty === "i32") return 4;
    if (ty === "i64") return 8;
    if (ty === "float") return 4;
    if (ty === "double") return 8;
    if (ty === "ptr") return 8;
    if (ty === "{ ptr, ptr }") return 8;
    if (ty === "%String" || ty === "%Vec" || ty === "%HashMap") return 8;
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return this.typeAlign(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structAlign(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = must(this.enumLayouts, enumMatch[1], "enum layouts");
      if (layout.niche) return this.typeAlign(layout.niche.payloadTy);
      return Math.max(4, layout.payloadAlign);
    }
    return 8;
  }

  public structAlign(fieldTypes: string[]): number {
    let a = 1;
    for (const ty of fieldTypes) a = Math.max(a, this.typeAlign(ty));
    return a;
  }

  public structPayloadSize(fieldTypes: string[]): number {
    let offset = 0;
    let maxAlign = 1;
    for (const ty of fieldTypes) {
      const size = this.typeSize(ty);
      const align = this.typeAlign(ty);
      offset = Math.ceil(offset / align) * align;
      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }
    return Math.ceil(offset / maxAlign) * maxAlign;
  }

  public structFieldOffset(fieldTypes: string[], fieldIdx: number): number {
    let offset = 0;
    for (let i = 0; i <= fieldIdx; i++) {
      const size = this.typeSize(fieldTypes[i]);
      const align = this.typeAlign(fieldTypes[i]);
      offset = Math.ceil(offset / align) * align;
      if (i === fieldIdx) return offset;
      offset += size;
    }
    return offset;
  }

  public getStructName(llvmTy: string): string | null {
    const m = llvmTy.match(/^%(.+)$/);
    if (m && this.structLayouts.has(m[1])) return m[1];
    return null;
  }
}
