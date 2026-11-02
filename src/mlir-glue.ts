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
    if (t.tag === "fn" || t.tag === "heap" || t.tag === "interface") {
      // Shown as legacy codegen shows a part it has no text for.
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
