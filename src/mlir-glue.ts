// Type-directed glue for the MLIR path: functions generated once per type, in the dialect,
// shared by every function of the module (MlirPlan appends them as closures are appended).
//
// display: `milo.disp.<key>(ref T, ref string)` appends T's text to the string, as Milo
// displays a value (docs/spec.md):
//   int, float, bool   decimal / shortest round-tripping digits / true, false
//   string             its bytes; inside a struct, enum, Vec or array, in double quotes
//   struct             `Name { f: v, g: w }`
//   enum               `Variant` or `Variant(a, b)`
//   Vec, array, slice  `[a, b, c]`
//   pointer            `0x` and lowercase hex
// Strings are written by length, so a NUL inside one is text like any other byte.
//
// eq: `milo.eq.<key>(ref K, ref K) -> i1`, a HashMap key's equality: ints and bools by
// value, strings by bytes, structs field by field.
// clone: `milo.clone.<key>(ptr src, ptr dst)` writes a deep copy of the T at src to dst:
// the bits first, then every part that owns something replaced in place by its own copy
// (a string shares its buffer by count, a Vec, HashMap or Heap gets a buffer of its own
// whose owning elements are cloned in turn). Nothing at dst is dropped: it is written as
// if it held nothing.
// drop: `milo.drop.<key>(ptr p)` (`milo.sdrop.<key>` for a structural copy, which runs no
// user Drop anywhere inside) drops the T at p, the names milo-elaborate-drops calls: a
// struct runs its user Drop first, then drops its fields last to first; a Vec its len
// elements then its buffer; a HashMap its occupied slots' keys and values then its buffer;
// a Heap its contents then the box; an enum the payload of the variant it holds.
// `milo.drop.vectail.<key>` / `arraytail`: what a consuming for-in left, elements from
// its cursor on.
// hash: `milo.hash.<key>(ref K, si64 h) -> si64`, FNV-1a folded over the key (map.ll): a
// bool's one byte, an int's 8 bytes widened by its signedness, a string's bytes, a
// struct's fields in order.
import type { TypeKind } from "./types";
import { MlirUnsupported, type MlirEmitCtx, glueHelpers } from "./emit-mlir";

const STR = "!milo.string";
const PTR = "!milo.ptr";
const STR_REF = `!milo.ref<${STR}>`;

type Ref = string;

export class MlirGlue {
  private texts: string[] = [];
  private names = new Set<string>();
  readonly callees = new Map<string, string>();

  constructor(private cx: MlirEmitCtx) {}

  /** The symbol of T's display glue, generated on first use; its first param is T's place. */
  display(t: TypeKind): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const name = `milo.disp.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    const place = this.placeOf(t);
    const g = new GlueFn(this, this.cx);
    g.body(t, "%p", "%s");
    this.texts.push([`func.func @${h.quote(name)}(%p: ${place}, %s: ${STR_REF}) attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, "  milo.return", "}"].join("\n"));
    return name;
  }

  /** The symbol of T's deep clone, generated on first use; it takes and writes raw pointers. */
  clone(t: TypeKind): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const name = `milo.clone.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    try {
      const g = new GlueFn(this, this.cx);
      g.bitCopy(t, "%src", "%dst");
      g.cloneParts(t, "%src", "%dst");
      this.texts.push([`func.func @${h.quote(name)}(%src: ${PTR}, %dst: ${PTR}) attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, "  milo.return", "}"].join("\n"));
    } catch (err) {
      // Not generated: a later request must not find a name with no body behind it.
      this.names.delete(name);
      throw err;
    }
    return name;
  }

  /**
   * The clone taking places: the source as `srcTy` (a slot, or a Vec's header), the
   * destination a slot of `ty`. A place lent from a raw pointer can only be a call's
   * argument, so the addresses are taken in here.
   */
  cloneFromPlace(t: TypeKind, srcTy: string, ty: string): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const inner = this.clone(t);
    const header = srcTy.startsWith("!milo.vec<");
    const name = `milo.clonefrom${header ? ".h" : ""}.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    this.texts.push([
      `func.func @${h.quote(name)}(%src: ${srcTy}, %dst: !milo.ref<${ty}>) attributes {llvm.linkage = #llvm.linkage<internal>} {`,
      `  %s = milo.addr %src : ${srcTy}`,
      `  %d = milo.addr %dst : !milo.ref<${ty}>`,
      `  func.call @${h.quote(inner)}(%s, %d) : (${PTR}, ${PTR}) -> ()`,
      "  milo.return", "}"].join("\n"));
    this.callees.set(inner, `(${PTR}, ${PTR}) -> ()`);
    return name;
  }

  /** The symbol of T's drop (structural: no user Drop runs), generated on first use. */
  drop(t: TypeKind, structural = false): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const name = `milo.${structural ? "sdrop" : "drop"}.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    try {
      const g = new GlueFn(this, this.cx);
      g.dropAt(t, "%p", structural, true);
      this.texts.push([`func.func @${h.quote(name)}(%p: ${PTR}) attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, "  milo.return", "}"].join("\n"));
    } catch (err) {
      this.names.delete(name);
      throw err;
    }
    return name;
  }

  /** What a consuming for-in over `seq` (a Vec or an array) leaves: `{ storage, i64 cursor }`. */
  tailDrop(seq: TypeKind): string {
    const h = glueHelpers;
    const name = seq.tag === "array" ? `milo.drop.arraytail.${h.typeKey(seq)}` : `milo.drop.vectail.${h.typeKey((seq as TypeKind & { tag: "vec" }).element)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    try {
      const g = new GlueFn(this, this.cx);
      g.tailDropAt(seq, "%p");
      this.texts.push([`func.func @${h.quote(name)}(%p: ${PTR}) attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, "  milo.return", "}"].join("\n"));
    } catch (err) {
      this.names.delete(name);
      throw err;
    }
    return name;
  }

  /**
   * `milo.json.<key>(ref S, ref string)`: std's jsonStringify of a struct of strings, ints,
   * floats and bools, appended: `{"f":v,...}`, a string escaped (milo.string.push_json).
   */
  json(t: TypeKind): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    if (t.tag !== "struct") throw new MlirUnsupported("jsonStringify of a non-struct");
    const name = `milo.json.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    const g = new GlueFn(this, this.cx);
    g.jsonBody(t, "%p", "%s");
    this.texts.push([`func.func @${h.quote(name)}(%p: ${this.placeOf(t)}, %s: ${STR_REF}) attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, "  milo.return", "}"].join("\n"));
    return name;
  }

  /** The symbol of K's key equality, generated on first use. */
  eq(t: TypeKind): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const name = `milo.eq.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    const place = this.placeOf(t);
    const g = new GlueFn(this, this.cx);
    const r = g.keyEq(t, "%a", "%b");
    this.texts.push([`func.func @${h.quote(name)}(%a: ${place}, %b: ${place}) -> i1 attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, `  milo.return ${r} : i1`, "}"].join("\n"));
    return name;
  }

  /** The symbol of K's key hash, generated on first use. */
  hash(t: TypeKind): string {
    const h = glueHelpers;
    t = h.stripRefs(t);
    const name = `milo.hash.${h.typeKey(t)}`;
    if (this.names.has(name)) return name;
    this.names.add(name);
    const place = this.placeOf(t);
    const g = new GlueFn(this, this.cx);
    const r = g.keyHash(t, "%p", "%h");
    this.texts.push([`func.func @${h.quote(name)}(%p: ${place}, %h: si64) -> si64 attributes {llvm.linkage = #llvm.linkage<internal>} {`, ...g.vars, ...g.lines, `  milo.return ${r} : si64`, "}"].join("\n"));
    return name;
  }

  /** T's place type: a Vec's header, anything else a !milo.ref. */
  placeOf(t: TypeKind): string {
    // A slice is a view of a Vec: its glue reads the same header a Vec's does.
    if (t.tag === "array" && t.size === null) {
      const e = glueHelpers.placeType(this.cx, t.element);
      if (e === null) throw new MlirUnsupported("display of a slice element");
      return `!milo.vec<${e}>`;
    }
    const p = glueHelpers.placeType(this.cx, t);
    if (p === null) throw new MlirUnsupported(`display of ${t.tag}`);
    return glueHelpers.refOf(p);
  }

  /** The glue as one pseudo-function's worth of text and symbols, or null when there is none. */
  module(): { text: string; names: string[] } | null {
    if (this.texts.length === 0) return null;
    return { text: this.texts.join("\n"), names: [...this.names] };
  }
}

/** One glue function's body: SSA names of its own, ops appended as text. */
class GlueFn {
  readonly lines: string[] = [];
  // Slots, at the top of the function wherever they are used (as FnEmitter hoists them).
  readonly vars: string[] = [];
  private n = 0;
  constructor(private glue: MlirGlue, private cx: MlirEmitCtx) {}

  private def(op: string): Ref {
    const r = `%g${this.n++}`;
    this.lines.push(`  ${r} = ${op}`);
    return r;
  }
  private emit(op: string): void { this.lines.push(`  ${op}`); }

  private slot(name: string, ty: string): Ref {
    const r = `%g${this.n++}`;
    this.vars.push(`  ${r} = milo.var ${glueHelpers.quote(name)} : !milo.ref<${ty}>`);
    return r;
  }

  private call(name: string, args: [Ref, string][], ret: string | null): Ref {
    const ty = `(${args.map(a => a[1]).join(", ")}) -> ${ret ?? "()"}`;
    this.glue.callees.set(name, ty);
    const op = `func.call @${glueHelpers.quote(name)}(${args.map(a => a[0]).join(", ")}) : ${ty}`;
    if (ret === null) { this.emit(op); return ""; }
    return this.def(op);
  }

  private text(s: string, dst: Ref): void {
    if (s === "") return;
    const lit = this.def(`milo.string.lit ${glueHelpers.quote(s)}`);
    this.emit(`milo.string.append ${dst}, ${lit} : ${STR_REF}`);
  }

  /**
   * Appends the text of the T at `p`, a `!milo.ref` to it (a field or element place), to
   * the string at `dst`; `quoted` wraps a string.
   */
  private part(t: TypeKind, p: Ref, dst: Ref, quoted: boolean): void {
    t = glueHelpers.stripRefs(t);
    if (t.tag === "string") {
      if (quoted) this.text('"', dst);
      this.emit(`milo.string.append ${dst}, ${this.def(`milo.load ${p} : ${STR_REF}`)} : ${STR_REF}`);
      if (quoted) this.text('"', dst);
      return;
    }
    const scalar = this.scalarKind(t);
    if (scalar) {
      const ty = glueHelpers.placeType(this.cx, t)!;
      let v = this.def(`milo.load ${p} : !milo.ref<${ty}>`);
      let arg = ty;
      if (scalar === "i64" || scalar === "u64") {
        const w = scalar === "i64" ? "si64" : "ui64";
        if (ty !== w) { v = this.def(`milo.cast ${v} : ${ty} to ${w}`); arg = w; }
      }
      this.cx.mlirPushScalar(scalar);
      this.call(`milo.string.push_${scalar}`, [[dst, STR_REF], [v, arg]], PTR);
      return;
    }
    if (t.tag !== "struct" && t.tag !== "enum" && t.tag !== "vec" && t.tag !== "array" && t.tag !== "hashmap") {
      // A closure, a box, an interface: no text, shown as legacy codegen shows one.
      this.text("<unprintable>", dst);
      return;
    }
    const fn = this.glue.display(t);
    const pty = glueHelpers.placeType(this.cx, t)!;
    const place = this.glue.placeOf(t);
    // A Vec's glue takes its header, read from the slot that holds it.
    const arg = place === `!milo.ref<${pty}>` ? p : this.def(`milo.vec.place ${p} : !milo.ref<${pty}> -> ${place}`);
    this.call(fn, [[arg, place], [dst, STR_REF]], null);
  }

  private scalarKind(t: TypeKind): "i64" | "u64" | "f64" | "f32" | "bool" | "ptr" | null {
    if (t.tag === "int") return t.signed ? "i64" : "u64";
    if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
    if (t.tag === "bool") return "bool";
    if (t.tag === "ptr") return "ptr";
    return null;
  }

  private placeTy(t: TypeKind): string {
    const ty = glueHelpers.placeType(this.cx, t);
    if (ty === null) throw new MlirUnsupported(`clone of ${t.tag}`);
    return ty;
  }

  /** The T at raw pointer `s` copied bit for bit to `d`. */
  bitCopy(t: TypeKind, s: Ref, d: Ref): void {
    const ty = this.placeTy(t);
    if (/^!milo\.(struct|enum|array)</.test(ty)) this.emit(`milo.copy ${s}, ${d} : ${PTR}, ${PTR} of ${ty}`);
    else this.emit(`milo.ptr.store ${this.def(`milo.ptr.load ${s} : ${ty}`)}, ${d} : ${ty}`);
  }

  private at(base: Ref, off: number | Ref): Ref {
    if (off === 0) return base;
    const o = typeof off === "number" ? this.def(`milo.const ${off} : si64`) : off;
    return this.def(`milo.ptr.elem ${base}[${o}] : ui8`);
  }

  /** A loop over `0 ..< n` (si64), `body` given the counter. */
  private forUpTo(n: Ref, body: (i: Ref) => void): void {
    const i = `%g${this.n++}`;
    this.emit(`milo.for ${this.def("milo.const 0 : si64")} to ${n} : si64 {`);
    this.lines.push(`  ^bb0(${i}: si64):`);
    body(i);
    this.emit("milo.yield");
    this.emit("}");
  }

  /**
   * With `d` already a bit copy of the T at `s`: every owning part of it replaced by its own
   * copy. A part that owns nothing stays as copied.
   */
  cloneParts(t: TypeKind, s: Ref, d: Ref): void {
    const h = glueHelpers;
    t = h.stripRefs(t);
    if (!this.cx.needsDropCg(t)) return;
    const size = (x: TypeKind) => this.cx.typeSizeOf(x);
    switch (t.tag) {
      case "string": {
        // The runtime's share takes the string by value (src/runtime/str.ll).
        this.cx.mlirStringOps();
        const v = this.def(`milo.ptr.load ${s} : ${STR}`);
        this.emit(`milo.ptr.store ${this.call("milo.str.share", [[v, STR]], STR)}, ${d} : ${STR}`);
        return;
      }
      case "vec": {
        // { data, len, cap }: a buffer of len elements; the clone's cap is its len.
        const vh = `!milo.struct<"Vec", ${PTR}, si64, si64>`;
        const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${s}[0] : ${vh}`)} : ${PTR}`);
        const len = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${s}[1] : ${vh}`)} : si64`);
        const es = size(t.element);
        this.cx.mlirCloneOps();
        const buf = this.call("milo.buf.clone", [[data, PTR], [len, "si64"], [this.def(`milo.const ${es} : si64`), "si64"]], PTR);
        this.emit(`milo.ptr.store ${buf}, ${this.def(`milo.ptr.field ${d}[0] : ${vh}`)} : ${PTR}`);
        this.emit(`milo.ptr.store ${len}, ${this.def(`milo.ptr.field ${d}[2] : ${vh}`)} : si64`);
        if (this.cx.needsDropCg(t.element)) {
          const ec = this.glue.clone(t.element);
          this.forUpTo(len, i => {
            const off = this.def(`milo.mul ${i}, ${this.def(`milo.const ${es} : si64`)} wrapping : si64`);
            this.call(ec, [[this.at(data, off), PTR], [this.at(buf, off), PTR]], null);
          });
        }
        return;
      }
      case "heap": {
        const box = this.def(`milo.ptr.load ${s} : ${PTR}`);
        this.cx.mlirCloneOps();
        // A one-element buffer copy of the box, then its contents' owning parts.
        const nb = this.call("milo.buf.clone", [[box, PTR], [this.def("milo.const 1 : si64"), "si64"], [this.def(`milo.const ${size(t.inner)} : si64`), "si64"]], PTR);
        this.call(this.glue.clone(t.inner), [[box, PTR], [nb, PTR]], null);
        this.emit(`milo.ptr.store ${nb}, ${d} : ${PTR}`);
        return;
      }
      case "hashmap": {
        // { data, len, cap, seed, tombs }: the slot buffer copied whole (states and all),
        // then the owning key and value of each occupied slot.
        const head = `!milo.struct<"HashMap", ${PTR}, si64, si64, si64, si64>`;
        const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${s}[0] : ${head}`)} : ${PTR}`);
        const cap = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${s}[2] : ${head}`)} : si64`);
        const lay = this.cx.mapSlotLayout(t.key, t.value);
        this.cx.mlirCloneOps();
        const buf = this.call("milo.buf.clone", [[data, PTR], [cap, "si64"], [this.def(`milo.const ${lay.size} : si64`), "si64"]], PTR);
        this.emit(`milo.ptr.store ${buf}, ${this.def(`milo.ptr.field ${d}[0] : ${head}`)} : ${PTR}`);
        const kOwn = this.cx.needsDropCg(t.key), vOwn = this.cx.needsDropCg(t.value);
        if (kOwn || vOwn) {
          const kc = kOwn ? this.glue.clone(t.key) : null, vc = vOwn ? this.glue.clone(t.value) : null;
          this.forUpTo(cap, i => {
            const off = this.def(`milo.mul ${i}, ${this.def(`milo.const ${lay.size} : si64`)} wrapping : si64`);
            const ss = this.at(data, off), ds = this.at(buf, off);
            const st = this.def(`milo.ptr.load ${ss} : si8`);
            this.emit(`milo.if ${this.def(`milo.cmp eq, ${st}, ${this.def("milo.const 1 : si8")} : si8`)} {`);
            if (kc) this.call(kc, [[this.at(ss, lay.keyOffset), PTR], [this.at(ds, lay.keyOffset), PTR]], null);
            if (vc) this.call(vc, [[this.at(ss, lay.valueOffset), PTR], [this.at(ds, lay.valueOffset), PTR]], null);
            this.emit("milo.yield");
            this.emit("}");
          });
        }
        return;
      }
      case "struct": {
        const layout = this.cx.structLayouts.get(t.name);
        if (!layout) throw new MlirUnsupported(`clone of struct ${t.name}`);
        const sty = this.placeTy(t);
        layout.fields.forEach((f, i) => {
          if (!this.cx.needsDropCg(f.typeKind)) return;
          const fs = this.def(`milo.ptr.field ${s}[${i}] : ${sty}`), fd = this.def(`milo.ptr.field ${d}[${i}] : ${sty}`);
          this.cloneField(f.typeKind, fs, fd);
        });
        return;
      }
      case "enum": {
        const layout = this.cx.mlirEnumLayout(t.name);
        if (!layout) throw new MlirUnsupported(`clone of enum ${t.name}`);
        const ety = this.placeTy(t);
        const owning = layout.variants.filter(v => v.fields.some(f => this.cx.needsDropCg(f)));
        if (owning.length === 0) return;
        const tag = this.def(`milo.enum.tag ${this.def(`milo.ptr.load ${s} : ${ety}`)} : ${ety}`);
        for (const v of owning) {
          this.emit(`milo.if ${this.def(`milo.cmp eq, ${tag}, ${this.def(`milo.const ${v.tag} : si32`)} : si32`)} {`);
          v.fields.forEach((f, j) => {
            if (!this.cx.needsDropCg(f)) return;
            this.cloneField(f, this.at(s, v.offsets[j]), this.at(d, v.offsets[j]));
          });
          this.emit("milo.yield");
          this.emit("}");
        }
        return;
      }
      case "array": {
        if (t.size === null) throw new MlirUnsupported("clone of a slice");
        const es = size(t.element);
        for (let i = 0; i < t.size; i++) this.cloneField(t.element, this.at(s, i * es), this.at(d, i * es));
        return;
      }
      default:
        // An owning closure: what its env holds is not described here.
        throw new MlirUnsupported(`clone of ${t.tag}`);
    }
  }

  /** A part inside a struct, enum or array: in place for a leaf, by its glue otherwise. */
  private cloneField(t: TypeKind, s: Ref, d: Ref): void {
    t = glueHelpers.stripRefs(t);
    if (t.tag === "struct" || t.tag === "enum" || t.tag === "vec" || t.tag === "hashmap") this.call(this.glue.clone(t), [[s, PTR], [d, PTR]], null);
    else this.cloneParts(t, s, d);
  }

  private isNull(p: Ref): Ref {
    return this.def(`milo.cmp eq, ${p}, ${this.def(`milo.zero : ${PTR}`)} : ${PTR}`);
  }

  /** `body` unless `p` is null. */
  private unlessNull(p: Ref, body: () => void): void {
    this.emit(`milo.if ${this.isNull(p)} {`);
    this.emit("milo.yield");
    this.emit("} else {");
    body();
    this.emit("milo.yield");
    this.emit("}");
  }

  /**
   * Drops the T at raw pointer `p`. `top`: this is T's own glue function, so a struct or
   * enum is dropped here rather than by a call of its glue.
   */
  dropAt(t: TypeKind, p: Ref, structural: boolean, top = false): void {
    const h = glueHelpers;
    t = h.stripRefs(t);
    if (!this.cx.needsDropCg(t)) return;
    if (!top && (t.tag === "struct" || t.tag === "enum")) {
      this.call(this.glue.drop(t, structural), [[p, PTR]], null);
      return;
    }
    const size = (x: TypeKind) => this.cx.typeSizeOf(x);
    switch (t.tag) {
      case "string": this.cx.mlirDropOps(); this.call("milo.string.drop", [[p, PTR]], null); return;
      case "fn": this.cx.mlirDropOps(); this.call("milo.closure.drop", [[p, PTR]], null); return;
      case "vec": {
        const vh = `!milo.struct<"Vec", ${PTR}, si64, si64>`;
        const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[0] : ${vh}`)} : ${PTR}`);
        this.unlessNull(data, () => {
          if (this.cx.needsDropCg(t.element)) {
            const len = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[1] : ${vh}`)} : si64`);
            const es = size(t.element);
            this.forUpTo(len, i => this.dropAt(t.element, this.at(data, this.def(`milo.mul ${i}, ${this.def(`milo.const ${es} : si64`)} wrapping : si64`)), structural));
          }
          this.call("free", [[data, PTR]], null);
        });
        return;
      }
      case "heap": {
        if (t.inner.tag === "interface") {
          const n = this.cx.mlirIfaceMethodCount(t.inner.name);
          this.cx.mlirDropOps();
          if (n === null) {
            // No itable has this interface: no box can be live with a destructor to run.
            const data = this.def(`milo.ptr.load ${p} : ${PTR}`);
            this.unlessNull(data, () => this.call("free", [[data, PTR]], null));
            return;
          }
          this.call("milo.iface.drop", [[p, PTR], [this.def(`milo.const ${n} : si64`), "si64"]], null);
          return;
        }
        const box = this.def(`milo.ptr.load ${p} : ${PTR}`);
        this.unlessNull(box, () => {
          this.dropAt(t.inner, box, structural);
          this.call("free", [[box, PTR]], null);
        });
        return;
      }
      case "hashmap": {
        const head = `!milo.struct<"HashMap", ${PTR}, si64, si64, si64, si64>`;
        const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[0] : ${head}`)} : ${PTR}`);
        this.unlessNull(data, () => {
          const kOwn = this.cx.needsDropCg(t.key), vOwn = this.cx.needsDropCg(t.value);
          if (kOwn || vOwn) {
            const cap = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[2] : ${head}`)} : si64`);
            const lay = this.cx.mapSlotLayout(t.key, t.value);
            this.forUpTo(cap, i => {
              const slot = this.at(data, this.def(`milo.mul ${i}, ${this.def(`milo.const ${lay.size} : si64`)} wrapping : si64`));
              const st = this.def(`milo.ptr.load ${slot} : si8`);
              this.emit(`milo.if ${this.def(`milo.cmp eq, ${st}, ${this.def("milo.const 1 : si8")} : si8`)} {`);
              if (kOwn) this.dropAt(t.key, this.at(slot, lay.keyOffset), structural);
              if (vOwn) this.dropAt(t.value, this.at(slot, lay.valueOffset), structural);
              this.emit("milo.yield");
              this.emit("}");
            });
          }
          this.call("free", [[data, PTR]], null);
        });
        return;
      }
      case "array": {
        if (t.size === null) return;
        const es = size(t.element);
        for (let i = 0; i < t.size; i++) this.dropAt(t.element, this.at(p, i * es), structural);
        return;
      }
      case "enum": {
        const layout = this.cx.mlirEnumLayout(t.name);
        if (!layout) throw new MlirUnsupported(`drop of enum ${t.name}`);
        const ety = this.placeTy(t);
        const owning = layout.variants.filter(v => v.fields.some(f => this.cx.needsDropCg(f)));
        if (owning.length === 0) return;
        const tag = this.def(`milo.enum.tag ${this.def(`milo.ptr.load ${p} : ${ety}`)} : ${ety}`);
        for (const v of owning) {
          this.emit(`milo.if ${this.def(`milo.cmp eq, ${tag}, ${this.def(`milo.const ${v.tag} : si32`)} : si32`)} {`);
          v.fields.forEach((f, j) => this.dropAt(f, this.at(p, v.offsets[j]), structural));
          this.emit("milo.yield");
          this.emit("}");
        }
        return;
      }
      case "struct": {
        const layout = this.cx.structLayouts.get(t.name);
        if (!layout) throw new MlirUnsupported(`drop of struct ${t.name}`);
        const sty = this.placeTy(t);
        if (this.cx.dropImpls.has(t.name) && !structural) this.userDrop(t.name, layout.fields, p, sty);
        for (let i = layout.fields.length - 1; i >= 0; i--) {
          const f = layout.fields[i];
          if (this.cx.needsDropCg(f.typeKind)) this.dropAt(f.typeKind, this.def(`milo.ptr.field ${p}[${i}] : ${sty}`), structural);
        }
        return;
      }
      default:
        throw new MlirUnsupported(`drop of ${t.tag}`);
    }
  }

  /**
   * The user's `Drop.drop` on the struct at `p`, as legacy ensureStructDropHelper runs it:
   * skipped when every heap field (and then every int or bool) is zero, the shape a
   * moved-out struct is left in. A live struct of that shape is skipped too: a known hole
   * (docs/plans/core-hir.md), kept until drops stop visiting moved-out places.
   */
  private userDrop(name: string, fields: { name: string; typeKind: TypeKind }[], p: Ref, sty: string): void {
    const heap = fields.flatMap((f, i) => ["string", "vec", "hashmap", "heap"].includes(f.typeKind.tag) ? [i] : []);
    const scalars = heap.length ? fields.flatMap((f, i) => f.typeKind.tag === "int" || f.typeKind.tag === "bool" ? [i] : []) : [];
    const fnTy = `(!milo.ref<${sty}>) -> ()`;
    const fn = `${name}$Drop$drop`;
    this.glue.callees.set(fn, fnTy);
    const call = () => this.emit(`func.call @${glueHelpers.quote(fn)}(${this.def(`milo.ptr.lend ${p} -> !milo.ref<${sty}>`)}) : ${fnTy}`);
    if (heap.length === 0) { call(); return; }
    let alive: Ref | null = null;
    for (const i of [...heap, ...scalars]) {
      const fp = this.def(`milo.ptr.field ${p}[${i}] : ${sty}`);
      const ft = fields[i].typeKind;
      // A heap field's first word is its pointer (a string's or Vec's data, a box).
      const v = this.def(`milo.ptr.load ${fp} : ${heap.includes(i) ? PTR : glueHelpers.placeType(this.cx, ft)}`);
      const ty = heap.includes(i) ? PTR : glueHelpers.placeType(this.cx, ft)!;
      const zero = ty === PTR ? this.def(`milo.zero : ${PTR}`) : this.def(ty === "i1" ? "milo.const false" : `milo.const 0 : ${ty}`);
      const nz = this.def(`milo.cmp ne, ${v}, ${zero} : ${ty}`);
      alive = alive === null ? nz : this.def(`milo.or ${alive}, ${nz} : i1`);
    }
    this.emit(`milo.if ${alive} {`);
    call();
    this.emit("milo.yield");
    this.emit("}");
  }

  /** The elements of the tail at `p` from its cursor on, then a Vec's buffer. */
  tailDropAt(seq: TypeKind, p: Ref): void {
    if (seq.tag !== "vec" && seq.tag !== "array") throw new MlirUnsupported(`tail drop of ${seq.tag}`);
    // `{ storage, i64 cursor }`: the cursor follows the storage, aligned to 8.
    const cursorAt = Math.ceil(this.cx.typeSizeOf(seq) / 8) * 8;
    const cursor = this.def(`milo.ptr.load ${this.at(p, cursorAt)} : si64`);
    const es = this.cx.typeSizeOf(seq.element);
    const each = (base: Ref, len: Ref) => {
      if (!this.cx.needsDropCg(seq.element)) return;
      const n = this.def(`milo.sub ${len}, ${cursor} wrapping : si64`);
      this.forUpTo(n, k => {
        const i = this.def(`milo.add ${k}, ${cursor} wrapping : si64`);
        this.dropAt(seq.element, this.at(base, this.def(`milo.mul ${i}, ${this.def(`milo.const ${es} : si64`)} wrapping : si64`)), false);
      });
    };
    if (seq.tag === "array") {
      if (seq.size === null) throw new MlirUnsupported("tail drop of a slice");
      each(p, this.def(`milo.const ${seq.size} : si64`));
      return;
    }
    const vh = `!milo.struct<"Vec", ${PTR}, si64, si64>`;
    const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[0] : ${vh}`)} : ${PTR}`);
    this.unlessNull(data, () => {
      each(data, this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${p}[1] : ${vh}`)} : si64`));
      this.call("free", [[data, PTR]], null);
    });
  }

  jsonBody(t: TypeKind & { tag: "struct" }, p: Ref, dst: Ref): void {
    const layout = this.cx.structLayouts.get(t.name)!;
    const sty = this.placeTy(t);
    this.text("{", dst);
    layout.fields.forEach((f, i) => {
      this.text(`${i > 0 ? "," : ""}"${f.name}":`, dst);
      const fty = this.placeTy(f.typeKind);
      const fr = this.def(`milo.field_ref ${p}[${i}] : !milo.ref<${sty}> -> !milo.ref<${fty}>`);
      if (f.typeKind.tag === "string") {
        const s = this.def(`milo.load ${fr} : ${STR_REF}`);
        this.cx.mlirPushScalar("json");
        this.text('"', dst);
        this.call("milo.string.push_json", [[dst, STR_REF], [this.def(`milo.string.data ${s}`), PTR], [this.def(`milo.string.len ${s}`), "si64"]], PTR);
        this.text('"', dst);
      } else this.part(f.typeKind, fr, dst, false);
    });
    this.text("}", dst);
  }

  /** Whether the keys at places `a` and `b` are equal. */
  keyEq(t: TypeKind, a: Ref, b: Ref): Ref {
    const h = glueHelpers;
    t = h.stripRefs(t);
    if (t.tag === "int" || t.tag === "bool") {
      const ty = h.placeType(this.cx, t)!;
      return this.def(`milo.cmp eq, ${this.def(`milo.load ${a} : !milo.ref<${ty}>`)}, ${this.def(`milo.load ${b} : !milo.ref<${ty}>`)} : ${ty}`);
    }
    if (t.tag === "string") {
      this.cx.mlirStringOps();
      return this.call("milo.string.eq", [[a, STR_REF], [b, STR_REF]], "i1");
    }
    if (t.tag === "struct") {
      const layout = this.cx.structLayouts.get(t.name);
      if (!layout) throw new MlirUnsupported(`key equality of struct ${t.name}`);
      const sty = h.placeType(this.cx, t)!;
      // Every field compared (no early exit): a fieldless struct is equal to itself.
      let acc = this.def("milo.const true");
      layout.fields.forEach((f, i) => {
        const fty = h.placeType(this.cx, f.typeKind);
        if (fty === null) throw new MlirUnsupported(`key equality of field ${f.name}`);
        const fa = this.def(`milo.field_ref ${a}[${i}] : !milo.ref<${sty}> -> !milo.ref<${fty}>`);
        const fb = this.def(`milo.field_ref ${b}[${i}] : !milo.ref<${sty}> -> !milo.ref<${fty}>`);
        const s = h.stripRefs(f.typeKind);
        const e = s.tag === "struct" ? this.call(this.glue.eq(s), [[fa, `!milo.ref<${fty}>`], [fb, `!milo.ref<${fty}>`]], "i1") : this.keyEq(s, fa, fb);
        acc = this.def(`milo.and ${acc}, ${e} : i1`);
      });
      return acc;
    }
    throw new MlirUnsupported(`key equality of ${t.tag}`);
  }

  /** The hash `acc` folded over the key at place `p`. */
  keyHash(t: TypeKind, p: Ref, acc: Ref): Ref {
    const h = glueHelpers;
    t = h.stripRefs(t);
    if (t.tag === "bool") {
      const b = this.def(`milo.cast ${this.def(`milo.cast ${this.def(`milo.load ${p} : !milo.ref<i1>`)} : i1 to ui64`)} : ui64 to si64`);
      return this.call("milo.hash.byte", [[acc, "si64"], [b, "si64"]], "si64");
    }
    if (t.tag === "int") {
      const ty = h.placeType(this.cx, t)!;
      let v = this.def(`milo.load ${p} : !milo.ref<${ty}>`);
      if (!t.signed) { if (ty !== "ui64") v = this.def(`milo.cast ${v} : ${ty} to ui64`); v = this.def(`milo.cast ${v} : ui64 to si64`); }
      else if (ty !== "si64") v = this.def(`milo.cast ${v} : ${ty} to si64`);
      return this.call("milo.hash.u64", [[acc, "si64"], [v, "si64"]], "si64");
    }
    if (t.tag === "string") {
      const s = this.def(`milo.load ${p} : ${STR_REF}`);
      return this.call("milo.hash.bytes", [[acc, "si64"], [this.def(`milo.string.data ${s}`), PTR], [this.def(`milo.string.len ${s}`), "si64"]], "si64");
    }
    if (t.tag === "struct") {
      const layout = this.cx.structLayouts.get(t.name);
      if (!layout) throw new MlirUnsupported(`hash of struct ${t.name}`);
      const sty = h.placeType(this.cx, t)!;
      layout.fields.forEach((f, i) => {
        const fty = h.placeType(this.cx, f.typeKind);
        if (fty === null) throw new MlirUnsupported(`hash of field ${f.name}`);
        const fr = this.def(`milo.field_ref ${p}[${i}] : !milo.ref<${sty}> -> !milo.ref<${fty}>`);
        acc = this.keyHash(f.typeKind, fr, acc);
      });
      return acc;
    }
    throw new MlirUnsupported(`hash of ${t.tag}`);
  }

  body(t: TypeKind, p: Ref, dst: Ref): void {
    const h = glueHelpers;
    switch (t.tag) {
      case "struct": {
        const layout = this.cx.structLayouts.get(t.name);
        if (!layout) throw new MlirUnsupported(`display of struct ${t.name}`);
        const sty = h.placeType(this.cx, t)!;
        this.text(`${this.cx.mlirDisplayName(t.name)} { `, dst);
        layout.fields.forEach((f, i) => {
          this.text(`${i > 0 ? ", " : ""}${f.name}: `, dst);
          const fty = h.placeType(this.cx, f.typeKind);
          if (fty === null) throw new MlirUnsupported(`display of field ${f.name}`);
          const fr = this.def(`milo.field_ref ${p}[${i}] : !milo.ref<${sty}> -> !milo.ref<${fty}>`);
          this.part(f.typeKind, fr, dst, f.typeKind.tag === "string");
        });
        this.text(" }", dst);
        return;
      }
      case "enum": {
        const layout = this.cx.mlirEnumLayout(t.name);
        if (!layout) throw new MlirUnsupported(`display of enum ${t.name}`);
        const ety = h.placeType(this.cx, t)!;
        const tag = this.def(`milo.enum.tag_at ${p} : !milo.ref<${ety}>`);
        // One milo.if per variant, the last one taken without its test: the tag is one of them.
        const arm = (k: number): void => {
          const v = layout.variants[k];
          const show = () => {
            this.text(v.name, dst);
            if (v.fields.length === 0) return;
            this.text("(", dst);
            v.fields.forEach((ft, j) => {
              if (j > 0) this.text(", ", dst);
              const fty = h.placeType(this.cx, ft);
              if (fty === null) throw new MlirUnsupported(`display of a ${v.name} payload`);
              const fr = this.def(`milo.enum.field_ref ${p}[${v.tag}, ${j}] : !milo.ref<${ety}> -> !milo.ref<${fty}>`);
              this.part(ft, fr, dst, h.stripRefs(ft).tag === "string");
            });
            this.text(")", dst);
          };
          if (k === layout.variants.length - 1) { show(); return; }
          const c = this.def(`milo.cmp eq, ${tag}, ${this.def(`milo.const ${v.tag} : si32`)} : si32`);
          this.emit(`milo.if ${c} {`);
          show();
          this.emit("milo.yield");
          this.emit("} else {");
          arm(k + 1);
          this.emit("milo.yield");
          this.emit("}");
        };
        if (layout.variants.length) arm(0);
        return;
      }
      case "vec": case "array": {
        const elem = h.placeType(this.cx, t.element);
        if (elem === null) throw new MlirUnsupported("display of a Vec element");
        const quoted = h.stripRefs(t.element).tag === "string";
        this.text("[", dst);
        if (t.tag === "array" && t.size !== null) {
          const aty = h.placeType(this.cx, t)!;
          for (let i = 0; i < t.size; i++) {
            if (i > 0) this.text(", ", dst);
            const er = this.def(`milo.array.index ${p}[${this.def(`milo.const ${i} : si64`)}] : !milo.ref<${aty}> -> !milo.ref<${elem}>`);
            this.part(t.element, er, dst, quoted);
          }
        } else {
          const vty = `!milo.vec<${elem}>`;
          const len = this.def(`milo.len ${p} : ${vty}`);
          const idx = this.slot("disp.i", "si64");
          this.emit(`milo.store ${this.def("milo.const 0 : si64")}, ${idx} : !milo.ref<si64>`);
          this.emit("milo.while {");
          this.emit(`milo.condition ${this.def(`milo.cmp lt, ${this.def(`milo.load ${idx} : !milo.ref<si64>`)}, ${len} : si64`)}`);
          this.emit("} do {");
          const i = this.def(`milo.load ${idx} : !milo.ref<si64>`);
          const zero = this.def("milo.const 0 : si64");
          const sep = this.def(`milo.cmp gt, ${i}, ${zero} : si64`);
          this.emit(`milo.if ${sep} {`);
          this.text(", ", dst);
          this.emit("milo.yield");
          this.emit("}");
          const er = this.def(`milo.index.ref ${p}[${i}] : ${vty} -> !milo.ref<${elem}>`);
          this.part(t.element, er, dst, quoted);
          this.emit(`milo.store ${this.def(`milo.add ${i}, ${this.def("milo.const 1 : si64")} : si64`)}, ${idx} : !milo.ref<si64>`);
          this.emit("milo.yield");
          this.emit("}");
        }
        this.text("]", dst);
        return;
      }
      case "hashmap": {
        // `{k: v, k: v}` in slot order, occupied slots only (state 1), as `for k, v in m`
        // walks them (FnEmitter.mapForEach): a slot is bytes { i8 state, K, V }.
        const mty = h.placeType(this.cx, t)!;
        const kt = h.placeType(this.cx, t.key), vt = h.placeType(this.cx, t.value);
        if (kt === null || vt === null) throw new MlirUnsupported("display of a HashMap entry");
        const lay = this.cx.mapSlotLayout(t.key, t.value);
        const head = `!milo.struct<"HashMap", ${PTR}, si64, si64, si64, si64>`;
        const mp = this.def(`milo.addr ${p} : !milo.ref<${mty}>`);
        const data = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${mp}[0] : ${head}`)} : ${PTR}`);
        const cap = this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${mp}[2] : ${head}`)} : si64`);
        const ks = this.slot("disp.k", kt), vs = this.slot("disp.v", vt), seen = this.slot("disp.seen", "i1");
        // A bit copy into a slot nothing drops: the glue only reads it.
        const copy = (src: Ref, dstSlot: Ref, ty: string) => {
          if (/^!milo\.(struct|enum|array)</.test(ty)) this.emit(`milo.copy ${src}, ${dstSlot} : ${PTR}, !milo.ref<${ty}> of ${ty}`);
          else this.emit(`milo.store ${this.def(`milo.ptr.load ${src} : ${ty}`)}, ${dstSlot} : !milo.ref<${ty}>`);
        };
        const at = (base: Ref, off: number) => off === 0 ? base : this.def(`milo.ptr.elem ${base}[${this.def(`milo.const ${off} : si64`)}] : ui8`);
        this.emit(`milo.store ${this.def("milo.const false")}, ${seen} : !milo.ref<i1>`);
        this.text("{", dst);
        const i = `%g${this.n++}`;
        this.emit(`milo.for ${this.def("milo.const 0 : si64")} to ${cap} : si64 {`);
        this.lines.push(`  ^bb0(${i}: si64):`);
        const slotAt = this.def(`milo.ptr.elem ${data}[${this.def(`milo.mul ${i}, ${this.def(`milo.const ${lay.size} : si64`)} wrapping : si64`)}] : ui8`);
        const st = this.def(`milo.ptr.load ${slotAt} : si8`);
        this.emit(`milo.if ${this.def(`milo.cmp eq, ${st}, ${this.def("milo.const 1 : si8")} : si8`)} {`);
        this.emit(`milo.if ${this.def(`milo.load ${seen} : !milo.ref<i1>`)} {`);
        this.text(", ", dst);
        this.emit("milo.yield");
        this.emit("}");
        this.emit(`milo.store ${this.def("milo.const true")}, ${seen} : !milo.ref<i1>`);
        copy(at(slotAt, lay.keyOffset), ks, kt);
        this.part(t.key, ks, dst, h.stripRefs(t.key).tag === "string");
        this.text(": ", dst);
        copy(at(slotAt, lay.valueOffset), vs, vt);
        this.part(t.value, vs, dst, h.stripRefs(t.value).tag === "string");
        this.emit("milo.yield");
        this.emit("}");
        this.emit("milo.yield");
        this.emit("}");
        this.text("}", dst);
        return;
      }
      default:
        this.part(t, p, dst, false);
    }
  }
}
