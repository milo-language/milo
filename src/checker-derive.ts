// Derive synthesis: the Clone, Eq and Json impls `@derive` (and Eq's auto-derive)
// generates, and the expansion of user `derive <Trait> { ... }` templates. Extracted from
// checker.ts; the fixpoint that decides WHICH types derive stays there (processDerives),
// and this reaches the checker only through `DeriveHost`.
import type { Program, Function, Expr, MiloType, Span, StructDecl, EnumDecl, ImplDecl, Param, MatchArm, DeriveTemplate } from "./ast";
import { simpleType } from "./ast";
import { type TypeKind, typeName } from "./types";
import type { StructInfo, EnumInfo, ImplInfo } from "./checker";
import { deriveRowSource, ROW_SUPPORTED, ROW_METHODS, type RowFieldPlan, type RowKind } from "./derive-row";
import { deriveJsonSource, type JsonPlan, type JsonFieldPlan } from "./derive-json";
import { expandDeriveTemplate, dumpTokens, DeriveTemplateError } from "./derive-template";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

// Generic enums whose Clone impl exists only when their payloads clone.
export const CONDITIONAL_CLONE_BASES = new Set(["Option", "Result"]);

const JSONVAL_VARIANTS = ["JNull", "JBool", "JInt", "JFloat", "JStr", "JArr", "JObj", "JRaw"];
function isStdJsonVal(info: EnumInfo): boolean {
  if (info.variants.size !== JSONVAL_VARIANTS.length) return false;
  return JSONVAL_VARIANTS.every((n, i) => {
    const v = info.variants.get(n);
    return !!v && v.tag === i && v.fields.length === (n === "JNull" ? 0 : 1);
  });
}

export interface DeriveHost {
  structs: Map<string, StructInfo>;
  enums: Map<string, EnumInfo>;
  dropImpls: Set<string>;
  traitImpls: Map<string, ImplInfo[]>;
  // Reassigned per program by processDerives, hence a getter.
  handWrittenClone(): Set<string>;
  deriveTemplates: Map<string, DeriveTemplate>;
  jsonCapableStructs: Set<string>;
  jsonUserMethods: Set<string>;
  displayName(n: string): string;
  error(msg: string, span?: Span, hint?: string): void;
  show(t: TypeKind): string;
  resolve(ty: MiloType): TypeKind;
  isCopyType(t: TypeKind): boolean;
  typeImplementsTrait(tName: string, traitName: string): boolean;
  optionInnerType(t: TypeKind): TypeKind | null;
  // @derive(Row) structs and their columns, for checked SQL's result-column check.
  rowPlans: Map<string, RowFieldPlan[]>;
}

export class DeriveSynth {
  constructor(private host: DeriveHost) {}

  // The first payload a synthesized enum clone() cannot reproduce, or null when every
  // variant is rebuildable. A closure payload is excluded even when it is Copy, for the
  // reason canAutoClone gives for Vec<closure>; a raw pointer payload would make the
  // clone a second owner of the pointee, the same hazard the struct path's pointerField
  // check refuses. An empty enum has nothing to match on.
  enumCloneBlocker(name: string, pending?: Set<string>): { variant: string; index: number; type: TypeKind; why: string } | null {
    const info = this.host.enums.get(name);
    if (!info || info.variants.size === 0) return { variant: "", index: -1, type: { tag: "void" }, why: "it has no variants" };
    for (const [vname, v] of info.variants) {
      for (let i = 0; i < v.fields.length; i++) {
        const ft = v.fields[i]!;
        const why = ft.tag === "fn" ? "a closure's environment cannot be duplicated"
          : ft.tag === "ptr" ? "a clone would be a second owner of what the raw pointer addresses"
          : !this.canAutoClone(ft, pending) ? "it has no clone" : null;
        if (why) return { variant: vname, index: i, type: ft, why };
      }
    }
    return null;
  }

  // Mirror of deriveClone for an enum: `match self { E.V(a0, a1) => return E.V(a0, a1.clone()) … }`,
  // a Copy payload passed bare and anything else `.clone()`d. Reads the resolved payload
  // types off the checker's enums, registered before derives run.
  deriveCloneEnum(e: EnumDecl, skipValidation = false, pending?: Set<string>): ImplDecl | null {
    if (!skipValidation) {
      if (this.host.dropImpls.has(e.name) || e.attributes?.some(a => a.name === "noCopy")) {
        this.host.error(`cannot derive Clone for '${e.name}': it is a resource type (Drop or @noCopy), and duplicating it would release the resource twice`, e.span);
      }
      const blocker = this.enumCloneBlocker(e.name, pending);
      if (blocker) {
        if (blocker.index < 0) this.host.error(`cannot derive Clone for '${e.name}': ${blocker.why}`, e.span);
        else this.host.error(`cannot derive Clone for '${e.name}': variant '${blocker.variant}' payload ${blocker.index} of type '${this.host.show(blocker.type)}': ${blocker.why}`, e.span);
        return null;
      }
    }
    const info = this.host.enums.get(e.name);
    if (!info) return null;
    const selfParam: Param = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    const arms: MatchArm[] = [];
    for (const [vname, v] of info.variants) {
      const bindings = v.fields.map((_, i) => `a${i}`);
      const args: Expr[] = v.fields.map((ft, i) => {
        const bound: Expr = { kind: "Ident" as const, name: bindings[i]! };
        return this.host.isCopyType(ft) ? bound : { kind: "MethodCall" as const, object: bound, method: "clone", args: [] };
      });
      arms.push({
        pattern: { kind: "EnumPattern", enumName: e.name, variant: vname, bindings, bindingSpans: [] },
        body: [{ kind: "Return" as const, value: { kind: "EnumLit", enumName: e.name, variant: vname, args } }],
      });
    }
    const cloneFn: Function = {
      kind: "Function",
      name: "clone",
      typeParams: [],
      params: [selfParam],
      retType: { name: e.name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null },
      contracts: [],
      body: [{ kind: "MatchStmt" as const, subject: { kind: "Ident" as const, name: "self" }, arms }],
      isExtern: false,
      isVariadic: false,
    };
    return this.stampOrigin({
      kind: "ImplDecl",
      traitName: "Clone",
      typeName: e.name,
      typeParams: [],
      methods: [cloneFn],
    }, e);
  }

  // A field the synthesized clone() can reproduce: copied when Copy, `.clone()`d when the
  // builtin, the struct or the enum provides one.
  // `pending` carries the structs and enums still standing in the derive fixpoint: they are
  // not in traitImpls yet (registration happens after synthesis), and without them the
  // fixpoint can never close over `struct A { b: B }`.
  canAutoClone(t: TypeKind, pending?: Set<string>): boolean {
    if (this.host.isCopyType(t)) return true;
    if (t.tag === "string") return true;
    // A container clones only what its contents can: Vec<closure> has no clone (an owning
    // closure's environment cannot be duplicated), and letting it through synthesized a
    // clone() whose body failed to compile inside std/http.
    // isCopy accepts a by-ref closure (its environment is a stack slot), but Vec.clone
    // rejects every closure: the element would be duplicated OUT of the frame that owns
    // that slot. So "the element is Copy" is not sufficient here — a closure element
    // disqualifies the container even when the closure itself is copyable.
    if (t.tag === "vec") return t.element.tag !== "fn" && this.canAutoClone(t.element, pending);
    if (t.tag === "hashmap") return t.value.tag !== "fn" && this.canAutoClone(t.key, pending) && this.canAutoClone(t.value, pending);
    if (t.tag === "struct" || t.tag === "enum") {
      if (this.host.typeImplementsTrait(t.name, "Clone") || this.host.handWrittenClone().has(t.name) || !!pending?.has(t.name)) return true;
      // An Option/Result instance is judged by its payloads, the way a container is: its
      // own impl is conditional on them and may not exist yet when a field asks.
      if (t.tag === "enum") {
        const base = this.host.enums.get(t.name)?.baseName;
        if (base && CONDITIONAL_CLONE_BASES.has(base)) return this.enumCloneBlocker(t.name, pending) === null;
      }
    }
    return false;
  }

  deriveClone(s: StructDecl, skipValidation = false, pending?: Set<string>): ImplDecl {
    if (!skipValidation) {
      if (this.host.dropImpls.has(s.name) || s.attributes?.some(a => a.name === "noCopy")) {
        this.host.error(`cannot derive Clone for '${s.name}': it is a resource type (Drop or @noCopy), and duplicating it would release the resource twice`, s.span);
      }
      const pointerField = this.host.structs.get(s.name)?.pointerField;
      if (pointerField) {
        this.host.error(`cannot derive Clone for '${s.name}': it holds a raw pointer ('${pointerField}') and is not @copy, so a clone would be a second owner of what the pointer addresses`, s.span,
          `mark '${s.name}' @copy if it does not own what the pointer points at; otherwise write the Clone impl by hand so it duplicates the pointee`);
      }
      for (const f of s.fields) {
        const ft = this.host.resolve(f.type);
        if (!this.canAutoClone(ft, pending)) {
          this.host.error(`cannot derive Clone for '${s.name}': field '${f.name}' of type '${this.host.show(ft)}' has no clone`, s.span);
        }
      }
    }

    // synthesize: fn clone(self: &Self): Self { return S { f: self.f | self.f.clone(), ... } }
    const selfParam: Param = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    const fields = s.fields.map(f => {
      const ft = this.host.resolve(f.type);
      const access: Expr = { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "self" }, field: f.name };
      const value: Expr = this.host.isCopyType(ft)
        ? access
        : { kind: "MethodCall" as const, object: access, method: "clone", args: [] };
      return { name: f.name, value };
    });
    const body: Expr = { kind: "StructLit", name: s.name, fields };

    const cloneFn: Function = {
      kind: "Function",
      name: "clone",
      typeParams: [],
      params: [selfParam],
      retType: { name: s.name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null },
      contracts: [],
      body: [{ kind: "Return" as const, value: body }],
      isExtern: false,
      isVariadic: false,
    };

    return this.stampOrigin({
      kind: "ImplDecl",
      traitName: "Clone",
      typeName: s.name,
      typeParams: [],
      methods: [cloneFn],
    }, s);
  }

  canAutoEq(t: TypeKind): boolean {
    if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "string") return true;
    if (t.tag === "enum") {
      const info = this.host.enums.get(t.name);
      if (!info) return false;
      for (const [, v] of info.variants) {
        if (v.fields.length > 0) return false;
      }
      return true;
    }
    if (t.tag === "struct") {
      const impls = this.host.traitImpls.get(t.name);
      return !!impls?.some(i => i.traitName === "Eq");
    }
    return false;
  }

  synthesizeDeriveImpl(s: StructDecl, traitName: string): ImplDecl | null {
    if (traitName === "Eq") return this.deriveEq(s);
    if (traitName === "Clone") return this.deriveClone(s);
    if (traitName === "Json") return this.deriveJson(s);
    if (traitName === "Row") return this.deriveRow(s);
    const tpl = this.host.deriveTemplates.get(traitName);
    if (tpl) {
      // Same one-bit visibility every other declaration has. Without it a template that a
      // module never exported is still reachable from every file in the program, which is
      // the opposite of the rule `pub` states everywhere else.
      if (!tpl.isPub && tpl.span?.file && s.span?.file && tpl.span.file !== s.span.file) {
        this.host.error(`'derive ${traitName}' is private to ${tpl.span.file}`, s.span,
          `mark it 'pub derive ${traitName} { … }' to let other modules derive it`);
        return null;
      }
      return this.expandUserDerive(s, tpl);
    }
    const known = ["Eq", "Json", "Row", ...this.host.deriveTemplates.keys()];
    this.host.error(`cannot derive '${traitName}' — no built-in derive and no 'derive ${traitName} { … }' template is in scope`, s.span,
      `available: ${known.map(k => `'${k}'`).join(", ")}. A user-defined derive is a top-level 'derive ${traitName} { … }' block; import the module that declares it`);
    return null;
  }

  // `derive <Trait> { … }` written by a user, expanded for one struct. Failures are
  // reported against the STRUCT rather than the template: the struct is what selected
  // this expansion, and it is the half the author of the failing program controls.
  expandUserDerive(s: StructDecl, tpl: DeriveTemplate): ImplDecl | null {
    try {
      const impl = expandDeriveTemplate(tpl, s, s.span, (n) => this.host.displayName(n));
      if (process.env.MILO_DUMP_DERIVES) {
        process.stderr.write(`// derive ${tpl.name} for ${s.name}\n${dumpTokens(tpl.body)}\n`);
      }
      return this.stampOrigin(impl, s);
    } catch (e) {
      const msg = e instanceof DeriveTemplateError ? e.message
        : e instanceof Error ? e.message : String(e);
      const hint = e instanceof DeriveTemplateError ? e.hint
        : `set MILO_DUMP_DERIVES=1 to print what 'derive ${tpl.name}' generated`;
      this.host.error(`@derive(${tpl.name}) on '${s.name}': ${msg}`, s.span, hint);
      return null;
    }
  }


  // A synthesized method has no source of its own, so it inherits the struct's file.
  // Without this it reaches the HIR with no origin at all: invisible to DWARF (what the
  // field is for) and to anything that groups definitions by module.
  //
  // Stamped in the generators rather than at the `@derive` call site because Eq is ALSO
  // auto-derived for every eligible struct that never asked for it — that path calls
  // `deriveEq` directly, and stamping only the explicit route left 40 of 1006 functions
  // in `java-dap` with no origin.
  stampOrigin(impl: ImplDecl, s: StructDecl | EnumDecl): ImplDecl {
    const file = s.span?.file;
    if (file) for (const m of impl.methods) m.sourceFile ??= file;
    return impl;
  }


  // Milo spelling of a type, for the `var x: T = …` lines the generator emits.
  // Different from `typeName` in one place that matters: an Option is a
  // monomorphized enum whose *name* is mangled, but its written form is not.
  jsonTypeSpelling(t: TypeKind): string {
    if (t.tag === "array" && t.size !== null) return `[${this.jsonTypeSpelling(t.element)}; ${t.size}]`;
    if (t.tag === "vec") return `Vec<${this.jsonTypeSpelling(t.element)}>`;
    if (t.tag === "hashmap") return `HashMap<${this.jsonTypeSpelling(t.key)}, ${this.jsonTypeSpelling(t.value)}>`;
    if (t.tag === "enum") {
      const inner = this.host.optionInnerType(t);
      if (inner) return `Option<${this.jsonTypeSpelling(inner)}>`;
    }
    return typeName(t);
  }

  // A fixed array has to exist before it can be filled, so decoding one needs a value to
  // build the N slots with. Only types with an obvious zero qualify; anything else has no
  // neutral element to stand in, and inventing one (a struct of zeros) would put a value
  // the wire never sent into a field the caller reads.
  jsonZeroFor(t: TypeKind): string | null {
    switch (t.tag) {
      case "int": return "0";
      case "float": return "0.0";
      case "bool": return "false";
      case "string": return `""`;
      // Deliberately NOT recursive into another array. A nested fixed array cannot be
      // indexed (`g[1][0]` is `cannot index type i64`) or element-assigned (the store
      // emits `[2 x i64]` into an `i64` slot and clang rejects the module), so generating
      // a decoder for one produces code that does not link. Refusing here turns that into
      // a sentence at the derive.
      default: return null;
    }
  }

  // Reduce a field type to a generator plan, or return why it cannot be one.
  jsonPlanFor(t: TypeKind): JsonPlan | { err: string } {
    switch (t.tag) {
      case "string": return { k: "string" };
      case "bool": return { k: "bool" };
      case "int": {
        // Not typeName: a refinement type prints as `i32(0..10)`, which is a
        // diagnostic spelling, not one the parser accepts back.
        const ty = `${t.signed ? "i" : "u"}${t.bits}`;
        // A ranged type (`i32(0..9)`) narrows the interval to its declared range, so an
        // out-of-range wire value is a decode error rather than the range trap the
        // field's checked store would otherwise hit.
        const ranged = t.min !== undefined && t.max !== undefined && Number.isSafeInteger(t.min) && Number.isSafeInteger(t.max);
        const clamp = (lo: bigint, hi: bigint) => ranged
          ? { lo: (BigInt(t.min!) > lo ? BigInt(t.min!) : lo).toString(), hi: (BigInt(t.max!) < hi ? BigInt(t.max!) : hi).toString() }
          : { lo: lo.toString(), hi: hi.toString() };
        if (!t.signed && t.bits === 64) return ranged ? { k: "int", ty, unsigned64: true, range: clamp(0n, (1n << 64n) - 1n) } : { k: "int", ty, unsigned64: true };
        if (t.signed && t.bits === 64) return ranged ? { k: "int", ty, unsigned64: false, range: clamp(-(1n << 63n), (1n << 63n) - 1n) } : { k: "int", ty, unsigned64: false };
        // Narrower than the i64 the cursor hands back: the value has to be range
        // checked before the cast, or the wire silently rewrites it.
        const hi = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
        const lo = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n;
        return { k: "int", ty, unsigned64: false, range: clamp(lo, hi) };
      }
      case "float": return { k: "float", ty: `f${t.bits}` };
      case "struct": {
        // std/json's own document type: the field holds whatever JSON arrived.
        if (t.name === "Json") return { k: "raw" };
        if (!this.host.jsonCapableStructs.has(t.name)) {
          return { err: `struct '${t.name}' has no JSON codec — add @derive(Json) to it` };
        }
        return { k: "struct", name: t.name };
      }
      case "enum": {
        const inner = this.host.optionInnerType(t);
        if (inner) {
          const p = this.jsonPlanFor(inner);
          if ("err" in p) return p;
          // Both `Some(None)` and an absent field encode as `null`, so the outer
          // layer cannot survive a round trip. serde has the same hole; refusing
          // it is cheaper than a silently-collapsing field.
          if (p.k === "option") return { err: `Option<Option<T>> has no distinct JSON encoding — 'Some(None)' and an absent field are both null` };
          return { k: "option", ty: this.jsonTypeSpelling(t), inner: p };
        }
        const info = this.host.enums.get(t.name);
        if (!info) return { err: `unknown enum '${t.name}'` };
        // std/json's JsonVal: the `Json` struct check goes by name alone; the shape check
        // is added so a user enum that merely borrows the name (payload-free, or other variants)
        // still takes the ordinary unit-enum path and its errors.
        if (t.name === "JsonVal" && isStdJsonVal(info)) return { k: "jsonval" };
        const variants: string[] = [];
        for (const [name, v] of info.variants) {
          if (v.fields.length > 0) {
            return { err: `enum '${t.name}' carries a payload in '${name}' — only payload-free enums have a JSON form (the variant name as a string)` };
          }
          variants.push(name);
        }
        if (variants.length === 0) return { err: `enum '${t.name}' has no variants` };
        return { k: "unitEnum", name: t.name, variants };
      }
      case "vec": {
        const p = this.jsonPlanFor(t.element);
        if ("err" in p) return p;
        return { k: "vec", ty: this.jsonTypeSpelling(t), elem: p };
      }
      case "array": {
        // A slice borrows, so a decoder would have nothing to own the buffer it filled.
        if (t.size === null) {
          return { err: `a slice '&[T]' has no JSON form because it borrows — decode into a 'Vec<T>' and slice that` };
        }
        const p = this.jsonPlanFor(t.element);
        if ("err" in p) return p;
        if (t.element.tag === "array") {
          return { err: `a nested fixed array has no JSON form yet — '[[T; N]; M]' cannot be indexed or element-assigned in this language, so a decoder for one would not compile; use 'Vec<Vec<T>>' or 'Vec<[T; N]>'` };
        }
        const zero = this.jsonZeroFor(t.element);
        if (zero === null) {
          return { err: `'[${this.host.show(t.element)}; ${t.size}]' has no JSON form: a fixed array must be built before it is filled, and '${this.host.show(t.element)}' has no zero value to build it with. Use 'Vec<${this.host.show(t.element)}>'` };
        }
        return { k: "array", ty: this.jsonTypeSpelling(t), elem: p, size: t.size, zero };
      }
      case "hashmap": {
        // A JSON object's keys are strings and nothing else. An i64-keyed map has no
        // lossless encoding — stringifying the key would round-trip `1` and `"1"` to the
        // same place — so say that rather than inventing one.
        if (t.key.tag !== "string") {
          return { err: `HashMap key '${this.host.show(t.key)}' has no JSON form — a JSON object's keys are strings, so only HashMap<string, V> encodes` };
        }
        const p = this.jsonPlanFor(t.value);
        if ("err" in p) return p;
        return { k: "map", ty: this.jsonTypeSpelling(t), value: p };
      }
      default:
        return { err: `type '${this.host.show(t)}' has no JSON form` };
    }
  }

  // The column kind for a Row field type, or null when it has no sqlite column form.
  private rowKindFor(t: TypeKind): RowKind | null {
    if (t.tag === "string") return "Str";
    if (t.tag === "bool") return "Bool";
    if (t.tag === "float") return t.bits === 64 ? "F64" : null;
    // Plain i64/i32 only: a narrower or ranged int would need a range check on read.
    if (t.tag === "int" && t.signed && t.min === undefined && t.max === undefined) {
      return t.bits === 64 ? "I64" : t.bits === 32 ? "I32" : null;
    }
    return null;
  }

  // Each field's column kind, or null (reported) when one has no sqlite column form.
  private rowPlan(s: StructDecl, what: string): RowFieldPlan[] | null {
    const fields: RowFieldPlan[] = [];
    for (const f of s.fields) {
      const t = this.host.resolve(f.type);
      const inner = t.tag === "enum" ? this.host.optionInnerType(t) : null;
      const kind = this.rowKindFor(inner ?? t);
      if (!kind) {
        this.host.error(`cannot derive ${what} for '${s.name}': field '${f.name}' has type '${this.host.show(t)}', which has no sqlite column form`, s.span,
          `supported field types: ${ROW_SUPPORTED}`);
        return null;
      }
      fields.push({ field: f.name, kind, optional: inner !== null });
    }
    return fields;
  }

  deriveRow(s: StructDecl): ImplDecl | null {
    if (s.isExtern || s.isOpaque) {
      this.host.error(`cannot derive Row for '${s.name}': it is a foreign type`, s.span);
      return null;
    }
    for (const m of ROW_METHODS) {
      if (this.host.jsonUserMethods.has(`${s.name}.${m}`)) {
        this.host.error(`cannot derive Row for '${s.name}': it already defines '${m}'`, s.span);
        return null;
      }
    }
    const fields = this.rowPlan(s, "Row");
    if (!fields) return null;
    this.host.rowPlans.set(s.name, fields);
    const src = deriveRowSource(s.name, fields);
    if (process.env.MILO_DUMP_DERIVES) process.stderr.write(`// ${s.name}: @derive(Row)\n${src}\n`);
    let parsed: Program;
    try {
      parsed = new Parser(new Lexer(src, true).tokenize(), src, `<derive Row for ${s.name}>`).parse();
    } catch (e) {
      this.host.error(`internal error: generated Row reader for '${s.name}' did not parse: ${e instanceof Error ? e.message : String(e)}`, s.span);
      return null;
    }
    const impl = parsed.impls[0];
    if (!impl) {
      this.host.error(`internal error: generated Row reader for '${s.name}' produced no impl`, s.span);
      return null;
    }
    for (const m of impl.methods) m.sourceFile = s.span?.file;
    return this.stampOrigin(impl, s);
  }

  deriveJson(s: StructDecl): ImplDecl | null {
    // An extern struct's fields are a C memory layout, and an opaque one has no
    // fields to read at all — a codec over either describes nothing a peer sends.
    if (s.isExtern || s.isOpaque) {
      this.host.error(`cannot derive Json for '${s.name}': it is a foreign type`, s.span,
        `an extern struct mirrors a C layout; write a Milo struct for the wire shape and convert`);
      return null;
    }
    // A monomorphized generic reaches this path without going through the
    // collection pass in processDerives.
    this.host.jsonCapableStructs.add(s.name);
    const fields: JsonFieldPlan[] = [];
    for (const f of s.fields) {
      const t = this.host.resolve(f.type);
      const plan = this.jsonPlanFor(t);
      if ("err" in plan) {
        this.host.error(`cannot derive Json for '${s.name}': field '${f.name}': ${plan.err}`, s.span);
        return null;
      }
      // `@json("wire_name")` renames one field on the wire. Everything else about
      // the codec follows the declaration, so this is the whole mapping surface.
      let key = f.name;
      const rename = f.attributes?.find(a => a.name === "json");
      if (rename) {
        const arg = rename.args[0];
        if (rename.args.length !== 1 || rename.argKinds?.[0] !== "string") {
          this.host.error(`@json on '${s.name}.${f.name}': expects one string, e.g. @json("user_id")`, s.span);
          return null;
        }
        // The name is emitted straight into a JSON string literal, so anything
        // needing an escape would have to be escaped in two grammars at once.
        if (arg === undefined || arg.length === 0 || /["\\\x00-\x1f]/.test(arg)) {
          this.host.error(`@json on '${s.name}.${f.name}': the name must be non-empty and free of quotes, backslashes and control characters`, s.span);
          return null;
        }
        key = arg;
      }
      fields.push({ field: f.name, key, plan, ...(f.default && { hasDefault: true }) });
    }
    const dupe = fields.find((f, i) => fields.findIndex(g => g.key === f.key) !== i);
    if (dupe) {
      this.host.error(`cannot derive Json for '${s.name}': two fields map to the JSON name '${dupe.key}'`, s.span);
      return null;
    }
    for (const name of ["toJson", "fromJson", "fromJsonNode", "toJsonArray", "fromJsonArray"]) {
      if (this.host.jsonUserMethods.has(`${s.name}.${name}`)) {
        this.host.error(`cannot derive Json for '${s.name}': it already defines '${name}'`, s.span);
        return null;
      }
    }

    const src = deriveJsonSource(s.name, fields);
    // The one way to read code the user never wrote. Without it a diagnostic
    // pointing into "<derive Json for User>" names a file nobody can open.
    if (process.env.MILO_DUMP_DERIVES) process.stderr.write(`// ${s.name}: @derive(Json)\n${src}\n`);
    let parsed: Program;
    try {
      parsed = new Parser(new Lexer(src, true).tokenize(), src, `<derive Json for ${s.name}>`).parse();
    } catch (e) {
      this.host.error(`internal error: generated Json codec for '${s.name}' did not parse: ${e instanceof Error ? e.message : String(e)}`, s.span);
      return null;
    }
    const impl = parsed.impls[0];
    if (!impl) {
      this.host.error(`internal error: generated Json codec for '${s.name}' produced no impl`, s.span);
      return null;
    }
    for (const m of impl.methods) m.sourceFile = s.span?.file;
    return this.stampOrigin(impl, s);
  }

  deriveEq(s: StructDecl, skipValidation = false): ImplDecl {
    if (!skipValidation) {
      for (const f of s.fields) {
        const ft = this.host.resolve(f.type);
        const ftName = typeName(ft);
        if (!this.host.typeImplementsTrait(ftName, "Eq")) {
          this.host.error(`cannot derive Eq for '${s.name}': field '${f.name}' of type '${ftName}' does not implement Eq`);
        }
      }
    }

    // synthesize: fn eq(self: &Self, other: &Self): bool { return self.f1 == other.f1 && self.f2 == other.f2 && ... }
    const selfParam: Param = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    // A field-less struct's synthesized body is `return true`, so `other` is never
    // read. Name it `_other` to suppress the unused-variable lint — the user can't
    // edit generated code to silence it, and the warning carries no span (the
    // synthesized param has none) so it prints without a location.
    const otherParam: Param = { name: s.fields.length === 0 ? "_other" : "other", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };

    let body: Expr;
    if (s.fields.length === 0) {
      body = { kind: "BoolLit", value: true };
    } else {
      const comparisons: Expr[] = s.fields.map(f => ({
        kind: "BinOp" as const,
        op: "==",
        left: { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "self" }, field: f.name },
        right: { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "other" }, field: f.name },
      }));
      body = comparisons.reduce((acc, cmp) => ({
        kind: "BinOp" as const,
        op: "&&",
        left: acc,
        right: cmp,
      }));
    }

    const eqFn: Function = {
      kind: "Function",
      name: "eq",
      typeParams: [],
      params: [selfParam, otherParam],
      retType: simpleType("bool"),
      contracts: [],
      body: [{ kind: "Return" as const, value: body }],
      isExtern: false,
      isVariadic: false,
    };

    return this.stampOrigin({
      kind: "ImplDecl",
      traitName: "Eq",
      typeName: s.name,
      typeParams: [],
      methods: [eqFn],
    }, s);
  }
}
