// HIR -> the source-level `milo` MLIR dialect (mlir/Milo.td), as text, for the functions
// the MLIR path compiles through milo-opt (docs/mlir-backend.md). A printer, not a lowering:
// structured control flow stays region ops, `var` stays a slot, Milo's checked arithmetic
// stays one op carrying its trap; every rewrite after this is a milo-opt pass.
//
// `emitMlirFunction` throws `MlirUnsupported` for anything outside the subset the dialect
// covers, so the function stays on legacy codegen; `mlirSupports` is that test alone.

import type { HIRExpr, HIRFunction, HIRPattern, HIRStmt } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";

export interface MlirEmitCtx {
  trapOnOverflow: boolean;
  // std/replay is in the program, so replay-engine fns count their depth (codegen replayEngineScope).
  replayScope: boolean;
  // requires/ensures/invariant become runtime checks only when on (-O0 by default).
  contractChecks: boolean;
  checkLocation(span?: Span): { file: string; line: number; col: number } | null;
  isBuiltinName(name: string): boolean;
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  sretFns: Set<string>;
  llvmType(t: TypeKind): string;
  // main is taken only when it is the process entry (no green-task wrapper around it).
  readonly mlirMainOk: boolean;
  mlirPrintHelper(stderr: boolean, parts: { key: string; type: TypeKind }[]): string;
  hasStringType: boolean;
  hasVecType: boolean;
  mlirDropHelper(key: string, t: TypeKind): void;
  mlirHelper(name: string, make: () => Omit<HIRFunction, "name" | "isExtern" | "isVariadic">): string;
  structLayouts: Map<string, { fields: { name: string; typeKind: TypeKind }[] }>;
  mlirEnumLayout(name: string): { size: number; align: number; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null;
  needsDropCg(t: TypeKind): boolean;
  dropImpls: Set<string>;
  typeSizeOf(t: TypeKind): number;
  mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null;
}

export class MlirUnsupported extends Error {
  constructor(readonly reason: string) { super(`mlir: unsupported ${reason}`); }
}

// `*T` for any T: untyped, as the pointee type rides on each access.
const PTR = "!milo.ptr";
// Only ever a literal until drops exist (Milo.td StringType).
const STR = "!milo.string";

/** The dialect's type for a Milo scalar (ints carry signedness), or null. */
export function mlirType(t: TypeKind): string | null {
  if (t.tag === "int" && t.min === undefined && t.max === undefined) return `${t.signed ? "si" : "ui"}${t.bits}`;
  if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
  if (t.tag === "bool") return "i1";
  if (t.tag === "ptr") return PTR;
  return null;
}

/** The element type of a Vec of scalars, or null. */
/** The dialect's element type of a Vec, or null. Indexing takes only scalar ones. */
function vecElem(cx: MlirEmitCtx, t: TypeKind): string | null {
  if (t.tag !== "vec") return null;
  const e = placeType(cx, t.element);
  return e === null || e === PTR ? null : e;
}

const isScalarTy = (ty: string) => /^([su]i\d+|i1|f32|f64)$/.test(ty);

/** How the symbol of a legacy helper spells a type: Milo.h typeKey of its dialect type. */
function typeKey(t: TypeKind): string {
  t = stripRefs(t);
  switch (t.tag) {
    case "int": return `${t.signed ? "si" : "ui"}${t.bits}`;
    case "float": return t.bits === 32 ? "f32" : "f64";
    case "bool": return "i1";
    case "ptr": return "ptr";
    case "string": return "string";
    case "vec": return `vec.${typeKey(t.element)}`;
    case "struct": return `S${t.name}`;
    case "enum": return `E${t.name}`;
    default: throw new MlirUnsupported(`helper for a ${t.tag}`);
  }
}

function scalar(t: TypeKind, what: string): string {
  const m = mlirType(t);
  if (m === null) throw new MlirUnsupported(`${what} of type ${t.tag}`);
  return m;
}

const aggregates = new WeakMap<MlirEmitCtx, Map<string, string | null>>();

const bigTypes = new WeakMap<MlirEmitCtx, Set<string>>();

/** An aggregate of 128 bytes or more: only ever a place (placeType), never an SSA value. */
function isBig(cx: MlirEmitCtx, ty: string): boolean {
  return bigTypes.get(cx)?.has(ty) ?? false;
}

/**
 * The dialect's type for a value of `t`: placeType, except an aggregate of 128 bytes or
 * more. Legacy never holds one as an SSA value (isBigAgg): SROA splits a whole-aggregate
 * load into one op per element, so a struct holding a big array takes -O2 forever.
 */
function valueType(cx: MlirEmitCtx, t: TypeKind): string | null {
  const r = placeType(cx, t);
  return r !== null && isBig(cx, r) ? null : r;
}

/**
 * The dialect's type for what a place of type `t` holds: a scalar, a string, a Vec, a fn
 * value, or a struct or enum of those, of any size. A big one is read and written field
 * by field through field_ref, as legacy does through its address.
 */
function placeType(cx: MlirEmitCtx, t: TypeKind): string | null {
  const m = mlirType(t);
  if (t.tag === "string") { cx.hasStringType = true; return STR; }
  if (t.tag === "vec") {
    const e = vecElem(cx, t);
    if (e) cx.hasVecType = true;
    return e && `!milo.vecval<${e}>`;
  }
  if (t.tag === "fn") return fnType(cx, t);
  if (m !== null || (t.tag !== "struct" && t.tag !== "enum")) return m;
  let cache = aggregates.get(cx);
  if (!cache) aggregates.set(cx, cache = new Map());
  const key = `${t.tag} ${t.name}`;
  if (cache.has(key)) return cache.get(key)!;
  // A type that contains itself is behind a Heap, which this rejects anyway.
  cache.set(key, null);
  const r = aggregateType(cx, t);
  cache.set(key, r);
  if (r !== null && cx.typeSizeOf(t) >= 128) {
    if (!bigTypes.has(cx)) bigTypes.set(cx, new Set());
    bigTypes.get(cx)!.add(r);
  }
  return r;
}

/**
 * A non-owning fn value `(T) => R` as !milo.fn; null for an owning (`move`) one, whose
 * environment is heap memory with drop glue, and for a param the dialect lacks.
 */
function fnType(cx: MlirEmitCtx, t: TypeKind & { tag: "fn" }): string | null {
  if (t.owning) return null;
  const ps = t.params.map(p => closureParamType(cx, p));
  if (ps.some(x => x === null)) return null;
  const r = t.ret.tag === "void" ? "()" : valueType(cx, t.ret);
  return r === null ? null : `!milo.fn<(${ps.join(", ")}) -> ${r}>`;
}

/** A closure param: a `&T` is the place (legacy closureParamTy passes a pointer). */
function closureParamType(cx: MlirEmitCtx, p: TypeKind): string | null {
  if (p.tag !== "ref") return valueType(cx, p);
  if (p.inner.tag === "vec") { const e = vecElem(cx, p.inner); return e && `!milo.vec<${e}>`; }
  // A slice param is the address of a %Vec header that a slice expression makes: not yet.
  if (p.inner.tag === "array") return null;
  const v = valueType(cx, p.inner);
  return v && `!milo.ref<${v}>`;
}

// Its own `impl Drop`; one on a field's type makes that field's valueType null.
const hasUserDrop = (cx: MlirEmitCtx, t: TypeKind & { name: string }) => cx.dropImpls.has(t.name);

function aggregateType(cx: MlirEmitCtx, t: TypeKind & { tag: "struct" | "enum" }): string | null {
  // A user Drop runs code whose timing is observable, and legacy drops temporaries at the
  // end of their statement, this backend at the end of their block: keep those legacy.
  if (hasUserDrop(cx, t) || cx.llvmType(t) !== `%${t.name}`) return null;
  if (t.tag === "struct") {
    const l = cx.structLayouts.get(t.name);
    const fields = l?.fields.map(f => placeType(cx, f.typeKind));
    if (!fields || fields.some(f => f === null)) return null;
    return `!milo.struct<${quote(t.name)}${fields.map(f => `, ${f}`).join("")}>`;
  }
  const l = cx.mlirEnumLayout(t.name);
  if (!l) return null;
  const variants: string[] = [];
  for (const v of l.variants) {
    const fields = v.fields.map(f => placeType(cx, f));
    if (fields.some(f => f === null)) return null;
    variants.push(`${v.tag}: (${fields.map((f, k) => `${f} at ${v.offsets[k]}`).join(", ")})`);
  }
  return `!milo.enum<${quote(t.name)}, size = ${l.size}, align = ${l.align}, [${variants.join(", ")}]>`;
}

function stripRefs(t: TypeKind): TypeKind {
  while (t.tag === "ref") t = t.inner;
  return t;
}

/** Why valueType rejects `t`: its tag, and for an aggregate what inside it blocks it. */
function blocker(cx: MlirEmitCtx, t: TypeKind, depth = 0): string {
  if (t.tag === "int") return "ranged int";
  if ((t.tag !== "struct" && t.tag !== "enum") || depth > 3) return t.tag;
  const why = hasUserDrop(cx, t) ? "user Drop" : cx.typeSizeOf(t) >= 128 ? "128+ bytes" : cx.llvmType(t) !== `%${t.name}` ? "niche" : null;
  if (why) return `${t.tag} (${why})`;
  const fields = t.tag === "struct" ? cx.structLayouts.get(t.name)?.fields.map(f => f.typeKind) ?? []
    : cx.mlirEnumLayout(t.name)?.variants.flatMap(v => v.fields) ?? [];
  const bad = fields.find(f => valueType(cx, f) === null);
  return bad ? `${t.tag} (${blocker(cx, bad, depth + 1)})` : t.tag;
}

/** MLIR string literal (symbol names, file names in locations). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(s, "utf-8")) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function quote(s: string): string {
  let out = "";
  for (const ch of Buffer.from(s, "utf-8")) {
    if (ch === 0x22 || ch === 0x5c || ch < 0x20 || ch >= 0x7f) out += `\\${ch.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(ch);
  }
  return `"${out}"`;
}

// Bit-exact float literals: NaN payloads and -0 survive, f32 is rounded the way legacy
// codegen rounds it.
function floatLit(v: number, ty: string): string {
  if (ty === "f32") {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    return `0x${b.getUint32(0).toString(16).toUpperCase().padStart(8, "0")}`;
  }
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return `0x${b.getBigUint64(0).toString(16).toUpperCase().padStart(16, "0")}`;
}

// A value with drop glue (a string, a Vec) is `owned` (a temporary that must end up in a
// slot, an argument or a result: exactly one owner), a `view` (its bits read in place out
// of a slot, never dropped, so it may only be borrowed), or `static` (a literal: cap 0, so
// copying or dropping it does nothing).
interface Val { ref: string; ty: string; own?: "owned" | "view" | "static" }
// A `var` is a slot; so is a by-ref param, whose slot is the caller's (`param` is its index).
// An `owned` var holds a value with drop glue for the scope that declared it.
// A `vec` is a `&Vec<T>` / `&mut Vec<T>` param: the address of the caller's header.
type Binding = { kind: "ssa"; v: Val } | { kind: "var"; ref: string; ty: string; param?: number; owned?: boolean }
  | { kind: "vec"; ref: string; elem: string; param?: number } | { kind: "opaque"; what: string };

// A dialect type is spelled out down to its fields, so it holds a string or a Vec exactly
// when its text names one (Milo.h needsDrop).
const hasDrop = (ty: string) => { const t = withoutFnTypes(ty); return t.includes(STR) || t.includes("!milo.vecval<"); };

/** `ty` with every !milo.fn<...> cut out: a fn value's signature owns nothing. */
function withoutFnTypes(ty: string): string {
  let out = "";
  for (let i = 0; i < ty.length;) {
    if (!ty.startsWith("!milo.fn<", i)) { out += ty[i++]; continue; }
    let depth = 0;
    for (; i < ty.length; i++) {
      if (ty.startsWith("->", i)) { i++; continue; }
      if (ty[i] === "<") depth++;
      else if (ty[i] === ">" && --depth === 0) { i++; break; }
    }
  }
  return out;
}

// What the closure bodies of one top-level function share: their names and texts.
interface ClosureState { next: number; texts: string[]; names: string[] }

const ARITH: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem", "<<": "shl", ">>": "shr" };
const BITS: Record<string, string> = { "&": "and", "|": "or", "^": "xor" };
const CMPS: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };

class FnEmitter {
  private body: string[] = [];
  private vars: string[] = [];
  private depth = 1;
  private n = 0;
  private loops = 0;
  private scopes: Map<string, Binding>[] = [new Map()];
  // The owned slots each open block declared, innermost last: its milo.scope's operands.
  private owned: { ref: string; ty: string }[][] = [[]];
  readonly callees = new Map<string, string>();
  // Each call, with the param index of every by-ref argument that is one of this fn's own
  // by-ref params (null for anything else): what codegen's stub must reproduce.
  readonly calls: { name: string; refParams: (number | null)[] }[] = [];

  constructor(private fn: HIRFunction, private cx: MlirEmitCtx, private fns: Map<string, HIRFunction>,
    readonly closures: ClosureState = { next: 0, texts: [], names: [] }) {}

  /**
   * Closure literal `e` as a function of its own, `name`: the env, then its params. Each
   * capture is bound to its place, read out of the env (milo.env.capture).
   */
  runClosure(e: HIRExpr & { kind: "Closure" }, name: string, caps: { name: string; place: string; b: Binding }[]): string {
    const params = ["%env: !milo.ptr"];
    caps.forEach((c, i) => {
      const r = this.def(`milo.env.capture %env[${i}] : ${c.place}`, c.place).ref;
      this.bind(c.name, c.b.kind === "vec" ? { kind: "vec", ref: r, elem: c.b.elem } : { kind: "var", ref: r, ty: (c.b as { ty: string }).ty });
    });
    e.params.forEach((p, i) => {
      const ty = closureParamType(this.cx, p.type);
      if (ty === null) throw new MlirUnsupported(`closure param of type ${blocker(this.cx, stripRefs(p.type))}`);
      params.push(`%p${i}: ${ty}`);
      if (ty.startsWith("!milo.vec<")) this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem: ty.slice(10, -1) });
      else if (p.type.tag === "ref") this.bind(p.name, { kind: "var", ref: `%p${i}`, ty: ty.slice(10, -1) });
      else if (hasDrop(ty)) {
        // An owned param is the closure's, as a function's is.
        const slot = this.ownedSlot(p.name, ty, p.type);
        this.emit(`milo.store %p${i}, ${slot} : !milo.ref<${ty}>`);
        this.bind(p.name, { kind: "var", ref: slot, ty, owned: true });
      } else this.bind(p.name, { kind: "ssa", v: { ref: `%p${i}`, ty } });
    });
    const ret = e.retType.tag === "void" ? null : this.value(e.retType, "closure result");
    this.retTy = ret;
    const jumped = this.stmts(e.body);
    this.closeScope(0, jumped, null);
    if (!jumped) this.emit(ret === null ? "milo.return" : "milo.unreachable");
    const head = `func.func @${quote(name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} attributes {llvm.linkage = #llvm.linkage<internal>} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  run(): string {
    const fn = this.fn;
    if (fn.isExtern) throw new MlirUnsupported("extern fn");
    if (fn.isVariadic) throw new MlirUnsupported("variadic fn");
    // main's prologue (argc/argv, global init, stdout buffering) is legacy codegen's; the
    // splice keeps it. Behind a green-task wrapper main is another function, left legacy.
    const isMain = fn.name === "main";
    if (isMain && (!this.cx.mlirMainOk || fn.params.length || fn.retType.tag !== "void")) throw new MlirUnsupported("main");
    if (this.cx.contractChecks && (fn.contracts?.length || fn.oldSnapshots?.length)) throw new MlirUnsupported("contracts");
    if (fn.entryGuards?.length) throw new MlirUnsupported("lazy global guard");
    const params = fn.params.map((p, i) => {
      // A by-ref param of a type the dialect lacks is just a pointer in the signature; the
      // function qualifies only if it never names it (lookup refuses).
      const elem = vecElem(this.cx, p.type);
      if ((p.isRef || p.isRefMut) && elem !== null) {
        this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem, param: i });
        return `%p${i}: !milo.vec<${elem}>`;
      }
      if ((p.isRef || p.isRefMut) && placeType(this.cx, p.type) === null) {
        this.bind(p.name, { kind: "opaque", what: blocker(this.cx, p.type) });
        return `%p${i}: ${PTR}`;
      }
      const pt = placeType(this.cx, p.type);
      const ty = p.isRef || p.isRefMut || (pt !== null && isBig(this.cx, pt)) ? pt! : this.value(p.type, "param");
      if (p.isRef || p.isRefMut) {
        this.bind(p.name, { kind: "var", ref: `%p${i}`, ty, param: i });
        return `%p${i}: !milo.ref<${ty}>`;
      }
      if (isBig(this.cx, ty) && !hasDrop(ty)) {
        // A 128+ byte param arrives by value (legacy's ABI) and goes straight to a slot, as
        // legacy spills it; from there it is only a place.
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var ${quote(p.name)} : !milo.ref<${ty}>`);
        this.emit(`milo.store %p${i}, ${slot} : !milo.ref<${ty}>`);
        this.bind(p.name, { kind: "var", ref: slot, ty });
        return `%p${i}: ${ty}`;
      }
      if (hasDrop(ty)) {
        // The callee owns a by-value string or Vec: it lives in a slot of the body's scope.
        const slot = this.ownedSlot(p.name, ty, p.type);
        this.emit(`milo.store %p${i}, ${slot} : !milo.ref<${ty}>`);
        this.bind(p.name, { kind: "var", ref: slot, ty, owned: true });
        return `%p${i}: ${ty}`;
      }
      this.bind(p.name, { kind: "ssa", v: { ref: `%p${i}`, ty } });
      return `%p${i}: ${ty}`;
    });
    // main is `i32 @main(i32 argc, ptr argv)` and returns 0, as legacy emits it.
    if (isMain) params.push("%argc: si32", `%argv: ${PTR}`);
    // An sret function (a 128+ byte result) writes its result through `%out`, the hidden
    // first param of legacy's `void @f(ptr %__sret.out, ...)`, and returns nothing.
    if (this.cx.sretFns.has(fn.name)) {
      this.sretOut = { ref: "%out", ty: this.place$(fn.retType, "sret result") };
      params.unshift(`%out: !milo.ref<${this.sretOut.ty}>`);
    }
    const ret = isMain ? "si32" : fn.retType.tag === "void" || this.sretOut ? null : this.value(fn.retType, "return");
    this.isMain = isMain;
    this.retTy = ret;
    // As legacy replayEngineScope, which applies only when std/replay is in the program.
    this.replay = !!fn.replayEngine && this.cx.replayScope;
    if (this.replay) this.emit("milo.replay.enter");
    const jumped = this.stmts(fn.body);
    this.closeScope(0, jumped, null);
    if (!jumped) {
      if (isMain) this.retMain();
      else if (ret === null) this.ret("milo.return");
      else this.emit("milo.unreachable");
    }
    const head = `func.func @${quote(fn.name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  private replay = false;
  private sretOut: { ref: string; ty: string } | null = null;

  /** True for a call of a function legacy lowers to sret: its result is written in place. */
  private isSretCall(e: HIRExpr): e is HIRExpr & { kind: "Call" } {
    return e.kind === "Call" && this.cx.sretFns.has(e.func) && !this.cx.isBuiltinName(e.func);
  }

  /**
   * `e`, a 128+ byte aggregate, written into the place `dst` (of type `ty`) without ever
   * being an SSA value: a struct literal field by field, an sret call through `dst`.
   * The stores are `init`: `dst` holds nothing yet.
   */
  private into(e: HIRExpr, dst: string, ty: string): void {
    if (this.isSretCall(e)) { this.call(e, true, dst); return; }
    if (e.kind !== "StructLit" || e.base) throw new MlirUnsupported("128+ byte value other than a literal or an sret call");
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout || this.place$(e.type, "struct literal") !== ty) throw new MlirUnsupported("struct literal layout");
    const given = new Map<string, Val>();
    for (const f of e.fields) given.set(f.name, this.consume(this.expr(f.value), "field"));
    layout.fields.forEach((f, i) => {
      const v = given.get(f.name);
      const fty = this.value(f.typeKind, "field");
      if (!v || v.ty !== fty) throw new MlirUnsupported("struct literal field");
      const r = this.def(`milo.field_ref ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`).ref;
      this.emit(`milo.store ${v.ref}, ${r} init : !milo.ref<${fty}>`);
    });
  }

  /**
   * A 128+ byte argument passed by value (legacy's ABI): loaded whole from its place right
   * at the call, as legacy loads it. An owning one must be the checker's move of a local.
   */
  private bigArg(e: HIRExpr, ty: string): Val {
    let slot: { ref: string; owned: boolean };
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      if (b.kind !== "var" || b.ty !== ty) throw new MlirUnsupported("128+ byte argument");
      if (hasDrop(ty) && !(b.owned && e.isMove)) throw new MlirUnsupported("128+ byte argument that is not a move");
      slot = { ref: b.ref, owned: !!b.owned };
    } else slot = this.bigSlot("arg", e);
    const op = hasDrop(ty) ? "milo.move" : "milo.load";
    return { ...this.def(`${op} ${slot.ref} : !milo.ref<${ty}>`, ty), own: hasDrop(ty) ? "owned" : undefined };
  }

  /** A slot of this block holding `e` (128+ bytes), filled in place; owned when it has drop glue. */
  private bigSlot(name: string, e: HIRExpr): { ref: string; ty: string; owned: boolean } {
    const ty = this.place$(e.type, "value");
    const owned = hasDrop(ty);
    let ref: string;
    if (owned) ref = this.ownedSlot(name, ty, e.type);
    else {
      ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    }
    this.into(e, ref, ty);
    if (owned) this.emit(`milo.filled ${ref} : !milo.ref<${ty}>`);
    return { ref, ty, owned };
  }
  private isMain = false;
  private retTy: string | null = null;

  /** placeType, or the reason the function stays legacy. */
  private place$(t: TypeKind, what: string): string {
    const v = placeType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${blocker(this.cx, t)}`);
    return v;
  }

  private value(t: TypeKind, what: string): string {
    const v = valueType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${blocker(this.cx, t)}`);
    return v;
  }
  private retMain(): void {
    const z = this.def("milo.const 0 : si32", "si32");
    this.ret(`milo.return ${z.ref} : si32`);
  }
  private ret(line: string): void {
    if (this.replay) this.emit("milo.replay.exit");
    this.emit(line);
  }

  private emit(line: string): void { this.body.push(`${"  ".repeat(this.depth)}${line}`); }
  private fresh(): string { return `%v${this.n++}`; }
  private bind(name: string, b: Binding): void { this.scopes[this.scopes.length - 1].set(name, b); }

  private lookup(name: string): Exclude<Binding, { kind: "opaque" }> {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b?.kind === "opaque") throw new MlirUnsupported(`use of a by-ref param of type ${b.what}`);
      if (b) return b;
    }
    const g = this.cx.mlirGlobal(name);
    if (!g) throw new MlirUnsupported("unknown ident");
    if (g.threadLocal) throw new MlirUnsupported("thread-local global");
    // Its place, not an owned slot: nothing here may move out of it or drop it at a scope end.
    const ty = this.value(g.type, "global");
    const ref = this.def(`milo.global ${quote(name)} : !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
    return { kind: "var", ref, ty };
  }

  /** `name` is a module global here: no local binding shadows it. */
  private isGlobal(name: string): boolean {
    return !this.scopes.some(m => m.has(name)) && this.cx.mlirGlobal(name) !== null;
  }

  private loc(span: Span | undefined): string {
    const l = this.cx.checkLocation(span);
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    return `loc(${quote(l.file)}:${l.line}:${l.col})`;
  }

  /**
   * A region's body, a block of its own. `fill` returns true when it ended in a jump, a Val
   * to yield, or false to yield nothing. True when it ended in a jump.
   */
  private region(open: string, fill: () => boolean | Val): boolean {
    this.emit(open);
    this.depth++;
    this.scopes.push(new Map());
    this.owned.push([]);
    const start = this.body.length;
    const r = fill();
    const v = typeof r === "object" ? r : null;
    const end = this.closeScope(start, r === true, v);
    if (r !== true) this.emit(end ? `milo.yield ${end.ref} : ${end.ty}` : "milo.yield");
    this.scopes.pop();
    this.depth--;
    return r === true;
  }

  /**
   * Closes the innermost block's ownership: when it declared owned slots, its lines from
   * `start` go into a milo.scope listing them (yielding `v` out of it), so they die where
   * control leaves it. Returns the value the block now ends with.
   */
  private closeScope(start: number, jumped: boolean, v: Val | null): Val | null {
    const owned = this.owned.pop()!;
    if (owned.length === 0) return v;
    if (v && hasDrop(v.ty) && v.own === "view") throw new MlirUnsupported("a borrowed value leaving its scope");
    // A region's entry block label stays the region's.
    if (/^\s*\^bb0\(/.test(this.body[start] ?? "")) start++;
    const inner = this.body.splice(start);
    const res = !jumped && v ? this.fresh() : null;
    const head = `${res ? `${res} = ` : ""}milo.scope ${owned.map(o => o.ref).join(", ")} : ${owned.map(o => `!milo.ref<${o.ty}>`).join(", ")}${res ? ` -> ${v!.ty}` : ""} {`;
    this.emit(head);
    this.body.push(...inner.map(l => `  ${l}`));
    if (!jumped) {
      this.depth++;
      this.emit(v ? `milo.yield ${v.ref} : ${v.ty}` : "milo.yield");
      this.depth--;
    }
    this.emit("}");
    // A scope is not a terminator: after one that jumps, the block still needs one.
    if (jumped) this.emit("milo.unreachable");
    return res ? { ref: res, ty: v!.ty, own: v!.own } : v;
  }

  /** `fill` in a block of its own, so the temporaries it makes die before its value is used. */
  private scoped(fill: () => Val): Val {
    this.owned.push([]);
    const start = this.body.length;
    const v = fill();
    return this.closeScope(start, false, v)!;
  }

  /** A slot owning a `ty` (string, Vec) for the innermost block. */
  private ownedSlot(name: string, ty: string, t: TypeKind): string {
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(name)} owned : !milo.ref<${ty}>`);
    this.owned[this.owned.length - 1].push({ ref, ty });
    this.dropGlue(ty, t);
    return ref;
  }

  private dropGlue(_ty: string, t: TypeKind): void {
    this.cx.mlirDropHelper(typeKey(t), stripRefs(t));
  }

  /** `v` where it is consumed (stored, passed or returned by value): it must own itself. */
  private consume(v: Val, what: string): Val {
    if (hasDrop(v.ty) && v.own === "view") throw new MlirUnsupported(`${what} copies a borrowed value`);
    return v;
  }

  /**
   * `v` where it is only read: a temporary that owns a buffer goes into a slot of the
   * innermost block, which drops it when the block ends, and is read in place from there.
   */
  private borrow(v: Val, t: TypeKind): Val {
    if (!hasDrop(v.ty) || v.own !== "owned") return v;
    const slot = this.ownedSlot("tmp", v.ty, t);
    this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
    return { ...this.def(`milo.load ${slot} : !milo.ref<${v.ty}>`, v.ty), own: "view" };
  }

  /** True when the statements end in a jump: whatever follows is dead. */
  private stmts(body: HIRStmt[]): boolean {
    for (const s of body) if (this.stmt(s)) return true;
    return false;
  }

  private stmt(s: HIRStmt): boolean {
    switch (s.kind) {
      case "Let": {
        if (s.viewBind) throw new MlirUnsupported("view let");
        const pt = placeType(this.cx, s.type);
        if (pt !== null && isBig(this.cx, pt)) {
          const b = this.bigSlot(s.name, s.value);
          this.bind(s.name, { kind: "var", ref: b.ref, ty: b.ty, owned: b.owned });
          return false;
        }
        const ty = this.value(s.type, "let");
        const v = this.consume(this.expr(s.value), "let");
        if (v.ty !== ty) throw new MlirUnsupported("let of a different type");
        if (hasDrop(ty)) {
          const slot = this.ownedSlot(s.name, ty, s.type);
          this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${ty}>`);
          this.bind(s.name, { kind: "var", ref: slot, ty, owned: true });
          return false;
        }
        if (!s.mutable) { this.bind(s.name, { kind: "ssa", v }); return false; }
        const ref = this.fresh();
        this.vars.push(`  ${ref} = milo.var ${quote(s.name)} : !milo.ref<${ty}>`);
        this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${ty}>`);
        this.bind(s.name, { kind: "var", ref, ty });
        return false;
      }
      case "Assign": {
        // A lazy global's first fill: the slot holds zeroes, nothing to drop.
        if (s.isInit && (s.target.kind !== "Ident" || !this.isGlobal(s.target.name))) throw new MlirUnsupported("init assign");
        if (s.target.kind === "PtrDeref") {
          const ty = scalar(s.target.type, "store through a pointer");
          // The value first, then the place: legacy genStmt Assign's order.
          const v = this.expr(s.value);
          const p = this.expr(s.target.operand);
          if (p.ty !== PTR || v.ty !== ty) throw new MlirUnsupported("store through a pointer of another type");
          this.emit(`milo.ptr.store ${v.ref}, ${p.ref} : ${ty}`);
          return false;
        }
        if (s.target.kind === "IndexAccess" || s.target.kind === "FieldAccess") {
          // Through a raw pointer: the value is stored as is, nothing is dropped (unsafe).
          const v = this.consume(this.expr(s.value), "store through a pointer");
          const pp = this.ptrPlace(s.target);
          if (pp) {
            if (v.ty !== pp.ty) throw new MlirUnsupported("store through a pointer of another type");
            this.emit(`milo.ptr.store ${v.ref}, ${pp.ptr} : ${pp.ty}`);
            return false;
          }
          if (s.target.kind === "FieldAccess") {
            const p = this.fieldPlace(s.target);
            if (!p) throw new MlirUnsupported("assign to a field of a value");
            if (v.ty !== p.ty) throw new MlirUnsupported("field store of another type");
            this.emit(`milo.store ${v.ref}, ${p.ref} : !milo.ref<${p.ty}>`);
            return false;
          }
          const { vec, elem, index } = this.indexPlace(s.target);
          if (v.ty !== elem) throw new MlirUnsupported("element store of another type");
          this.emit(`milo.index.store ${v.ref}, ${vec}[${index}] : ${elem}, !milo.vec<${elem}> ${this.loc(s.target.span)}`);
          return false;
        }
        if (s.target.kind !== "Ident") throw new MlirUnsupported(`assign to ${s.target.kind}`);
        const b = this.lookup(s.target.name);
        if (b.kind !== "var") throw new MlirUnsupported("assign to an immutable binding");
        // The old value's drop is milo-scope-drops' business: it goes before the store.
        const v = this.consume(this.expr(s.value), "assignment");
        if (v.ty !== b.ty) throw new MlirUnsupported("assign of a different type");
        if (hasDrop(b.ty) && !s.isInit) this.dropGlue(b.ty, s.target.type);
        this.emit(`milo.store ${v.ref}, ${b.ref}${s.isInit ? " init" : ""} : !milo.ref<${b.ty}>`);
        return false;
      }
      case "Return": {
        if (this.sretOut && s.value) {
          this.into(s.value, this.sretOut.ref, this.sretOut.ty);
          this.ret("milo.return");
          return true;
        }
        if (!s.value && this.isMain) { this.retMain(); return true; }
        if (!s.value) { this.ret("milo.return"); return true; }
        const v = this.consume(this.expr(s.value), "return");
        if (v.ty !== this.retTy) throw new MlirUnsupported("return of a different type");
        this.ret(`milo.return ${v.ref} : ${v.ty}`);
        return true;
      }
      case "ExprStmt": {
        if (this.isSretCall(s.expr)) { this.bigSlot("tmp", s.expr); return false; }
        // A result nobody takes still has an owner until the block ends.
        const v = this.expr(s.expr, true);
        if (v.ty) this.borrow(v, s.expr.type);
        return false;
      }
      case "If": {
        const c = this.expr(s.cond);
        let thenDone = false;
        let elseDone = false;
        thenDone = this.region(`milo.if ${c.ref} {`, () => this.stmts(s.thenBody));
        if (s.elseBody) elseDone = this.region("} else {", () => this.stmts(s.elseBody!));
        this.emit("}");
        if (thenDone && elseDone) {
          // milo.if is not a terminator; the block still needs one, and nothing reaches it.
          this.emit("milo.unreachable");
          return true;
        }
        return false;
      }
      case "While": {
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        this.loops++;
        if (s.cond.kind === "BoolLit" && s.cond.value) {
          this.region("milo.loop {", () => this.stmts(s.body));
        } else {
          this.region("milo.while {", () => {
            // milo.condition ends the region, so temporaries die in a block inside it.
            const c = this.scoped(() => this.expr(s.cond));
            this.emit(`milo.condition ${c.ref}`);
            return true;
          });
          this.region("} do {", () => this.stmts(s.body));
        }
        this.emit("}");
        this.loops--;
        return false;
      }
      case "ForRange": {
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        const ty = scalar(s.varType, "for var");
        if (ty === "i1" || ty === PTR || ty.startsWith("f")) throw new MlirUnsupported("for over a non-int");
        const start = this.expr(s.start);
        const end = this.expr(s.end);
        // Legacy codegen widens a narrower bound by the loop variable's signedness, which
        // milo.cast (source signedness) would not match; such loops stay legacy.
        if (start.ty !== ty || end.ty !== ty) throw new MlirUnsupported("for bound of a different type");
        const iv = this.fresh();
        this.loops++;
        this.region(`milo.for ${start.ref} to ${end.ref} : ${ty} {`, () => {
          this.emit(`^bb0(${iv}: ${ty}):`);
          this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty } });
          return this.stmts(s.body);
        });
        this.emit("}");
        this.loops--;
        return false;
      }
      case "Break":
      case "Continue":
        if (this.loops === 0) throw new MlirUnsupported(`${s.kind} outside a loop`);
        this.emit(s.kind === "Break" ? "milo.break" : "milo.continue");
        return true;
      case "Match":
        return this.match(s, null).done;
      case "LazyGlobalInit":
        this.emit(`milo.global.init ${quote(s.name)}`);
        return false;
      case "Block":
        // Opens no scope: a `let` in it binds in the enclosing one.
        return this.stmts(s.body);
      case "UnsafeBlock": {
        this.scopes.push(new Map());
        this.owned.push([]);
        const start = this.body.length;
        try {
          const jumped = this.stmts(s.body);
          this.closeScope(start, jumped, null);
          return jumped;
        } finally { this.scopes.pop(); }
      }
      default:
        throw new MlirUnsupported(`stmt ${s.kind}`);
    }
  }

  private def(rhs: string, ty: string, loc = ""): Val {
    const ref = this.fresh();
    this.emit(`${ref} = ${rhs}${loc ? ` ${loc}` : ""}`);
    return { ref, ty };
  }

  /** `stmt`: evaluated for effect only, so a void call is fine. */
  private expr(e: HIRExpr, stmt = false): Val {
    switch (e.kind) {
      case "IntLit":
      case "CharLit": {
        const ty = scalar(e.type, e.kind);
        if (ty === "i1" || ty === PTR) throw new MlirUnsupported(`int literal of type ${ty}`);
        return this.def(`milo.const ${BigInt(e.value)} : ${ty}`, ty);
      }
      case "BoolLit":
        return this.def(`milo.const ${e.value}`, "i1");
      case "StringLit":
        this.cx.hasStringType = true;
        return { ...this.def(`milo.string.lit ${quote(e.value)}`, STR), own: "static" };
      case "StringClone": {
        // Milo's implicit copy of a string: a new owner of the same buffer.
        if (e.str.kind === "StringLit") return this.expr(e.str);
        const p = this.fieldPlace(e.str);
        if (!p || p.ty !== STR) throw new MlirUnsupported("string copy of a temporary");
        this.cx.mlirHelper("milo.share.string", () => ({
          params: [{ name: "s", type: { tag: "string" }, isRef: true, isRefMut: false }],
          retType: { tag: "string" },
          body: [{ kind: "Return", retType: { tag: "string" }, value: {
            kind: "StringClone", type: { tag: "string" }, str: { kind: "Ident", name: "s", type: { tag: "string" }, isMove: false } } }],
        }));
        return { ...this.def(`milo.string.share ${p.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      }
      case "StringLen": {
        const v = this.borrow(this.expr(e.object), e.object.type);
        if (v.ty !== STR) throw new MlirUnsupported("len of a non-string");
        return this.def(`milo.string.len ${v.ref}`, "si64");
      }
      case "VecNew": {
        const ty = this.value(e.type, "Vec");
        return { ...this.def(`milo.vec.new : ${ty}`, ty), own: "owned" };
      }
      case "FloatLit": {
        const ty = scalar(e.type, "FloatLit");
        if (ty !== "f32" && ty !== "f64") throw new MlirUnsupported("float literal of int type");
        return this.def(`milo.const ${floatLit(e.value, ty)} : ${ty}`, ty);
      }
      case "Ident": {
        if (e.type.tag === "fn" && this.fns.has(e.name) && !this.scopes.some(m => m.has(e.name)) && !this.cx.mlirGlobal(e.name)) {
          // A named fn as a value: legacy's trampoline (closure convention, null env),
          // made by a legacy helper returning the pair.
          const ty = this.value(e.type, "fn value");
          const name = this.cx.mlirHelper(`milo.fnval.${e.name}`, () => ({
            params: [], retType: e.type,
            body: [{ kind: "Return", retType: e.type, value: { kind: "Ident", name: e.name, type: e.type } }],
          }));
          return this.callHelper(name, [], ty);
        }
        const b = this.lookup(e.name);
        if (b.kind === "ssa") return b.v;
        if (b.kind === "vec") throw new MlirUnsupported("a Vec as a value");
        if (b.kind === "var" && isBig(this.cx, b.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
        if (!hasDrop(b.ty)) return this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
        // The checker marks the last use that takes the value; every other read borrows.
        if (!e.isMove) return { ...this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "view" };
        if (!b.owned) throw new MlirUnsupported("move out of a borrow");
        return { ...this.def(`milo.move ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "owned" };
      }
      case "BinOp": return this.binop(e);
      case "UnaryOp": return this.unop(e);
      case "Cast": {
        const from = scalar(e.operand.type, "cast source");
        const to = scalar(e.targetType, "cast target");
        const v = this.expr(e.operand);
        if (v.ty !== from) throw new MlirUnsupported("cast operand type");
        if (from === to) return v;
        if ((from === PTR && to.startsWith("f")) || (to === PTR && from.startsWith("f"))) throw new MlirUnsupported("cast between a pointer and a float");
        return this.def(`milo.cast ${v.ref} : ${from} to ${to}`, to);
      }
      case "Call": return this.call(e, stmt);
      case "IndexAccess": {
        const pp = this.ptrPlace(e);
        if (pp) return this.ptrRead(pp);
        if (stripRefs(e.object.type).tag === "string") {
          // A byte, as legacy genStringIndex reads it: object, index, bounds check.
          const s = this.borrow(this.expr(e.object), e.object.type);
          const i = this.expr(e.index);
          if (s.ty !== STR || !/^[su]i\d+$/.test(i.ty) || scalar(e.type, "string byte") !== "ui8") throw new MlirUnsupported("string index types");
          const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
          return this.def(`milo.string.byte ${s.ref}[${index}]`, "ui8", this.loc(e.span));
        }
        const { vec, elem, index } = this.indexPlace(e);
        return this.def(`milo.index ${vec}[${index}] : !milo.vec<${elem}> -> ${elem}`, elem, this.loc(e.span));
      }
      case "VecGrowBuf": {
        // Legacy's buffer growth (overflow and allocation checks), as a function of the
        // legacy module per element type; its out-of-memory panic names no source line.
        const d = this.expr(e.data), l = this.expr(e.len), c = this.expr(e.cap);
        if (d.ty !== PTR || l.ty !== "si64" || c.ty !== "si64" || scalar(e.type, "grown buffer") !== PTR) throw new MlirUnsupported("vec growth types");
        const name = `milo.vec.grow.${typeKey(e.elementType)}`;
        const i64: TypeKind = { tag: "int", bits: 64, signed: true };
        this.cx.mlirHelper(name, () => ({
          params: [{ name: "d", type: e.data.type, isRef: false, isRefMut: false },
            { name: "l", type: i64, isRef: false, isRefMut: false }, { name: "c", type: i64, isRef: false, isRefMut: false }],
          retType: e.type,
          body: [{ kind: "Return", retType: e.type, value: { kind: "VecGrowBuf", elementType: e.elementType, type: e.type,
            data: { kind: "Ident", name: "d", type: e.data.type }, len: { kind: "Ident", name: "l", type: i64 }, cap: { kind: "Ident", name: "c", type: i64 } } }],
        }));
        this.callees.set(name, `(${PTR}, si64, si64) -> ${PTR}`);
        return this.def(`func.call @${quote(name)}(${d.ref}, ${l.ref}, ${c.ref}) : (${PTR}, si64, si64) -> ${PTR}`, PTR);
      }
      case "StrReserve": {
        // std/string's `_strReserve(&mut s, n)`: legacy's room test and growth
        // (genStrReserve) as a function of the legacy module taking the string's place.
        // Its out-of-memory panic names the call's line, so there is one per call line.
        if (scalar(e.type, "reserved buffer") !== PTR) throw new MlirUnsupported("string reserve type");
        const l = this.cx.checkLocation(e.span);
        if (!l) throw new MlirUnsupported("no source file for a panic location");
        const s = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const n = this.expr(e.extra);
        if (n.ty !== "si64") throw new MlirUnsupported("string reserve size type");
        const name = `milo.str.reserve.${l.line}.${fnv1a(l.file)}`;
        const str: TypeKind = { tag: "string" };
        const i64: TypeKind = { tag: "int", bits: 64, signed: true };
        this.cx.mlirHelper(name, () => ({
          params: [{ name: "s", type: str, isRef: false, isRefMut: true }, { name: "n", type: i64, isRef: false, isRefMut: false }],
          retType: e.type,
          body: [{ kind: "Return", retType: e.type, value: { kind: "StrReserve", type: e.type, span: e.span,
            str: { kind: "Ident", name: "s", type: str, isMove: false }, extra: { kind: "Ident", name: "n", type: i64 } } }],
        }));
        const fnTy = `(!milo.ref<${STR}>, si64) -> ${PTR}`;
        this.callees.set(name, fnTy);
        return this.def(`func.call @${quote(name)}(${s}, ${n.ref}) : ${fnTy}`, PTR);
      }
      case "SizeOf":
        if (scalar(e.type, "sizeOf") !== "si64") throw new MlirUnsupported("sizeOf type");
        return this.def(`milo.const ${this.cx.typeSizeOf(e.sizeType)} : si64`, "si64");
      case "VecPtr": {
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.vec.data ${place} : !milo.vec<${elem}>`, PTR);
      }
      case "WrappingArith": {
        // `a.wrappingAdd(b)`: two's complement, never a trap.
        const op = { add: "add", sub: "sub", mul: "mul" }[e.op];
        const ty = scalar(e.type, "wrapping arithmetic");
        if (!op || !/^[su]i\d+$/.test(ty)) throw new MlirUnsupported(`wrapping ${e.op}`);
        const l = this.expr(e.left), r = this.expr(e.right);
        if (l.ty !== ty || r.ty !== ty) throw new MlirUnsupported("wrapping operand types");
        return this.def(`milo.${op} ${l.ref}, ${r.ref} wrapping : ${ty}`, ty);
      }
      case "VecLen": {
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64");
      }
      case "PtrDeref": {
        const ty = scalar(e.type, "load through a pointer");
        const p = this.expr(e.operand);
        if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
        return this.def(`milo.ptr.load ${p.ref} : ${ty}`, ty);
      }
      case "FieldAccess": {
        const pp = this.ptrPlace(e);
        if (pp) return this.ptrRead(pp);
        // A field of a place is read in place, as legacy genFieldPtr does; of a value, out
        // of the value.
        // Moving an owning field out leaves its struct partly moved: legacy zeroes the field
        // and tracks it apart, which an owned slot here does not express yet.
        if (e.isMove && hasDrop(this.value(e.type, "field"))) throw new MlirUnsupported("move out of a field");
        const own = hasDrop(this.value(e.type, "field")) ? "view" as const : undefined;
        const p = this.fieldPlace(e);
        if (p) return { ...this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty), own };
        const { index, ty } = this.field(e);
        // A temporary that owns is kept in a slot while its field is read.
        const s = this.borrow(this.expr(e.object), e.object.type);
        return { ...this.def(`milo.struct.get ${s.ref}[${index}] : ${s.ty} -> ${ty}`, ty), own };
      }
      case "StructLit": return this.structLit(e);
      case "EnumLit": {
        const ty = this.value(e.type, "enum literal");
        const v = this.cx.mlirEnumLayout(e.enumName)?.variants.find(x => x.name === e.variant);
        if (!v || v.fields.length !== e.args.length) throw new MlirUnsupported("enum variant");
        const args = e.args.map(a => this.consume(this.expr(a), "payload"));
        const fields = v.fields.map(f => this.value(f, "payload"));
        if (args.some((a, k) => a.ty !== fields[k])) throw new MlirUnsupported("payload of another type");
        const ops = args.length ? ` (${args.map(a => a.ref).join(", ")} : ${fields.join(", ")})` : "";
        return { ...this.def(`milo.enum.new ${v.tag}${ops} -> ${ty}`, ty), own: hasDrop(ty) ? "owned" : undefined };
      }
      case "IsCheck": {
        const v = this.expr(e.operand);
        if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("`is` on a non-enum");
        const tag = this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
        const want = this.def(`milo.const ${e.tag} : si32`, "si32");
        return this.def(`milo.cmp eq, ${tag.ref}, ${want.ref} : si32`, "i1");
      }
      case "IfExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("if-expression without a value");
        const ty = this.value(e.type, "if-expression");
        const c = this.expr(e.cond);
        if (c.ty !== "i1") throw new MlirUnsupported("if condition type");
        const ref = this.fresh();
        this.region(`${ref} = milo.if ${c.ref} -> ${ty} {`, () => this.tail(e.thenBody, ty));
        this.region("} else {", () => this.tail(e.elseBody, ty));
        this.emit("}");
        return { ref, ty, own: hasDrop(ty) ? "owned" : undefined };
      }
      case "Closure": return this.closure(e);
      case "ClosureCall": return this.closureCall(e, stmt);
      case "MatchExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("match-expression without a value");
        return this.match(e, this.value(e.type, "match-expression")).v;
      }
      default:
        throw new MlirUnsupported(`expr ${e.kind}`);
    }
  }

  /**
   * A by-reference closure literal (legacy genClosure without `move`): a function of its
   * own, and a milo.closure lending it the place of every capture. A `let` held as an SSA
   * value is spilled to a slot: it is immutable, so the copy reads the same.
   */
  private closure(e: HIRExpr & { kind: "Closure" }): Val {
    if (e.isMove || e.heapEnv || e.keyExtractor) throw new MlirUnsupported(e.isMove ? "move closure" : "heap-env closure");
    const ty = this.value(e.type, "closure");
    // A global's initializer (__milo.global_init, __milo.lazyinit.*) returns before the
    // global's closure is ever called, so legacy gives that env a static slot instead.
    if (e.captures.length && this.fn.name.startsWith("__milo.")) throw new MlirUnsupported("closure env in a global initializer");
    const caps = e.captures.map(c => {
      const b = this.lookup(c.name);
      if (b.kind === "vec") return { name: c.name, place: `!milo.vec<${b.elem}>`, ref: b.ref, b };
      if (b.kind === "var") return { name: c.name, place: `!milo.ref<${b.ty}>`, ref: b.ref, b };
      if (hasDrop(b.v.ty)) throw new MlirUnsupported("capture of an owned value");
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(c.name)} : !milo.ref<${b.v.ty}>`);
      this.emit(`milo.store ${b.v.ref}, ${ref} : !milo.ref<${b.v.ty}>`);
      return { name: c.name, place: `!milo.ref<${b.v.ty}>`, ref, b: { kind: "var" as const, ref, ty: b.v.ty } };
    });
    const name = `${this.fn.name}$closure${this.closures.next++}`;
    const inner = new FnEmitter(this.fn, this.cx, this.fns, this.closures);
    const text = inner.runClosure(e, name, caps);
    this.closures.texts.push(text);
    this.closures.names.push(name);
    for (const [k, v] of inner.callees) this.callees.set(k, v);
    const ops = caps.length ? `(${caps.map(c => c.ref).join(", ")} : ${caps.map(c => c.place).join(", ")})` : "";
    return this.def(`milo.closure @${quote(name)}${ops} : ${ty}`, ty);
  }

  /** `f(args)` through a fn value: the callee, then the args, as legacy genClosureCall. */
  private closureCall(e: HIRExpr & { kind: "ClosureCall" }, stmt: boolean): Val {
    const ft = stripRefs(this.fieldType(e.callee));
    if (ft.tag !== "fn") throw new MlirUnsupported("call of a non-fn");
    const f = this.expr(e.callee);
    if (!f.ty.startsWith("!milo.fn<")) throw new MlirUnsupported("callee type");
    if (ft.params.length !== e.args.length) throw new MlirUnsupported("closure call arity");
    const ptys = ft.params.map(p => closureParamType(this.cx, p));
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const args = e.args.map((a, i) => {
      const pty = ptys[i];
      if (pty === null || (ft.params[i].tag === "ref") !== a.passByRef) throw new MlirUnsupported("closure call arg");
      if (a.passByRef) {
        const r = this.place(a.expr, pty, a.refMut).ref;
        refs.push({ ref: r, mut: a.refMut, ty: pty });
        return r;
      }
      const v = this.consume(this.expr(a.expr), "argument");
      if (v.ty !== pty) throw new MlirUnsupported("closure call arg type");
      return v.ref;
    });
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
        this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
      }
    }
    const ret = ft.ret.tag === "void" ? null : this.value(ft.ret, "closure result");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const call = `milo.closure.call ${f.ref}(${args.join(", ")}) : ${f.ty}${args.length ? `, ${ptys.join(", ")}` : ""}${ret ? ` -> ${ret}` : ""}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return { ...this.def(call, ret), own: hasDrop(ret) ? "owned" : undefined };
  }

  /** The index and value type of the struct field `e` reads. */
  private field(e: HIRExpr & { kind: "FieldAccess" }): { index: number; ty: string } {
    const st = stripRefs(e.object.type);
    if (st.tag !== "struct") throw new MlirUnsupported(`field of a ${st.tag}`);
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    return { index, ty: this.place$(this.fieldType(e), "field") };
  }

  /**
   * The type of the value `e` reads. A fn-typed field's HIR type has lost its params
   * (`(i64, i64) => i64` reads as `() => i64`); the struct's layout has them.
   */
  private fieldType(e: HIRExpr): TypeKind {
    if (e.kind !== "FieldAccess" || e.type.tag !== "fn") return e.type;
    const st = stripRefs(e.object.type);
    const f = st.tag === "struct" ? this.cx.structLayouts.get(st.name)?.fields.find(x => x.name === e.field) : undefined;
    return f?.typeKind ?? e.type;
  }

  /**
   * The address of a place reached through a raw pointer (`p[i]`, `p.f` on a `*S`,
   * `p[i].f`) and its element type, or null when `e` is not one. As legacy genLValue
   * does: the pointer, then the index.
   */
  private ptrPlace(e: HIRExpr): { ptr: string; ty: string } | null {
    if (e.kind === "IndexAccess" && stripRefs(e.object.type).tag === "ptr") {
      const p = this.expr(e.object);
      const i = this.expr(e.index);
      if (p.ty !== PTR || i.ty !== "si64") throw new MlirUnsupported("pointer index of another type");
      const ty = this.value(e.type, "pointer element");
      return { ptr: this.def(`milo.ptr.elem ${p.ref}[${i.ref}] : ${ty}`, PTR).ref, ty };
    }
    if (e.kind !== "FieldAccess") return null;
    const obj = stripRefs(e.object.type);
    let base: { ptr: string; ty: string } | null;
    let st: TypeKind;
    if (obj.tag === "ptr") {
      st = obj.inner;
      const p = this.expr(e.object);
      base = { ptr: p.ref, ty: this.value(st, "pointee") };
    } else {
      base = this.ptrPlace(e.object);
      st = obj;
    }
    if (!base) return null;
    if (st.tag !== "struct") throw new MlirUnsupported("field through a pointer to a non-struct");
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    const ty = this.value(e.type, "field");
    return { ptr: this.def(`milo.ptr.field ${base.ptr}[${index}] : ${base.ty}`, PTR).ref, ty };
  }

  /** A read of a place through a pointer: a bit copy that, for a string or a Vec, owns. */
  private ptrRead(p: { ptr: string; ty: string }): Val {
    return { ...this.def(`milo.ptr.load ${p.ptr} : ${p.ty}`, p.ty), own: hasDrop(p.ty) ? "owned" : undefined };
  }

  /** The slot `e` names (a `var`, a by-ref param, a field of either), or null for a value. */
  private fieldPlace(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      return b.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : null;
    }
    if (e.kind !== "FieldAccess") return null;
    const base = this.fieldPlace(e.object);
    if (!base) return null;
    const { index, ty } = this.field(e);
    const r = this.def(`milo.field_ref ${base.ref}[${index}] : !milo.ref<${base.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`);
    return { ref: r.ref, ty, param: base.param };
  }

  /**
   * `S { a: x, ..base }`: the listed fields in source order, then the base, as legacy
   * genStructLit evaluates them; the unlisted fields come out of the base.
   */
  private structLit(e: HIRExpr & { kind: "StructLit" }): Val {
    const ty = this.value(e.type, "struct literal");
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout) throw new MlirUnsupported("struct layout");
    const given = new Map<string, Val>();
    for (const f of e.fields) given.set(f.name, this.consume(this.expr(f.value), "field"));
    // The base gives up its unlisted fields and drops its listed ones: not with owned ones yet.
    if (e.base && hasDrop(ty)) throw new MlirUnsupported("struct update of an owning struct");
    const base = e.base ? this.expr(e.base) : null;
    if (base && base.ty !== ty) throw new MlirUnsupported("struct update base of another type");
    const ops = layout.fields.map((f, i) => {
      const fty = this.value(f.typeKind, "field");
      const v = given.get(f.name) ?? (base ? this.def(`milo.struct.get ${base.ref}[${i}] : ${ty} -> ${fty}`, fty) : null);
      if (!v || v.ty !== fty) throw new MlirUnsupported("struct literal field");
      return v;
    });
    const operands = ops.length ? `${ops.map(o => o.ref).join(", ")} : ${ops.map(o => o.ty).join(", ")} ` : "";
    return { ...this.def(`milo.struct.new ${operands}-> ${ty}`, ty), own: hasDrop(ty) ? "owned" : undefined };
  }

  /**
   * A value-producing block (if-expression and match arms): every statement but the last,
   * then the value of the last one to yield, or true when the block jumps instead.
   */
  private tail(body: HIRStmt[], ty: string): true | Val {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt") {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    const v = this.consume(this.expr(last.expr), "block value");
    if (v.ty !== ty) throw new MlirUnsupported("block value of another type");
    return v;
  }

  /**
   * `match` as milo.match: one region per arm, the `_` arm last. A flat enum pattern's
   * bindings are its arm's block arguments (payload i is binding i); a literal pattern on
   * an int or bool is a case value. `resultTy` makes it an expression.
   */
  private match(m: { subject: HIRExpr; arms: (HIRStmt & { kind: "Match" })["arms"]; subjectIsMut?: boolean; subjectIsRef?: boolean },
    resultTy: string | null): { done: boolean; v: Val } {
    // An owning subject matched by value moves its payload into the bindings (legacy
    // bindPayloads zeroes it in the subject); matched by reference, bindings are views.
    const subjPlaceTy = placeType(this.cx, m.subject.type);
    // A 128+ byte enum is matched through its place: a switch on the tag read there
    // (milo.enum.tag_at), each binding the payload field's place (milo.enum.field_ref).
    const bigEnum = subjPlaceTy !== null && isBig(this.cx, subjPlaceTy) && subjPlaceTy.startsWith("!milo.enum<");
    const owning = hasDrop(bigEnum ? subjPlaceTy! : this.value(m.subject.type, "match subject"));
    // By value, the owned slot the subject lives in: an arm that binds an owning payload
    // field moves the subject out of it (milo.move), so drop elaboration sees it empty on
    // that path and full on the others, as legacy's alive flag does.
    let from: string | null = null;
    // A `&mut` subject's place: its bindings are the payload's own places
    // (milo.enum.field_ref), so writing one writes the payload.
    let place: { ref: string; ty: string } | null = null;
    let subj: Val;
    if (bigEnum) {
      if (!m.subjectIsRef && !m.subjectIsMut) throw new MlirUnsupported("match by value on a 128+ byte enum");
      place = this.fieldPlace(m.subject);
      if (!place) throw new MlirUnsupported("match on a 128+ byte enum that is not a place");
      subj = this.def(`milo.enum.tag_at ${place.ref} : !milo.ref<${place.ty}>`, "si32");
    } else if (m.subjectIsMut) {
      place = this.fieldPlace(m.subject);
      if (place && isBig(this.cx, place.ty)) throw new MlirUnsupported("match on a 128+ byte enum");
      if (!place || !place.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("match on a &mut subject that is not an enum place");
      subj = { ...this.def(`milo.load ${place.ref} : !milo.ref<${place.ty}>`, place.ty), own: hasDrop(place.ty) ? "view" : undefined };
    } else if (owning && !m.subjectIsRef) {
      const e = m.subject;
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b?.kind === "var" && b.owned) from = b.ref;
      else {
        const v = this.expr(e);
        if (v.own !== "owned") throw new MlirUnsupported("match moving out of a borrowed enum");
        from = this.ownedSlot("subject", v.ty, e.type);
        this.emit(`milo.store ${v.ref}, ${from} : !milo.ref<${v.ty}>`);
      }
      const ty = this.value(e.type, "match subject");
      subj = { ...this.def(`milo.load ${from} : !milo.ref<${ty}>`, ty), own: "view" };
    } else subj = this.borrow(this.expr(m.subject), m.subject.type);
    const isEnum = bigEnum || subj.ty.startsWith("!milo.enum<");
    if (!isEnum && m.arms.some(a => a.pattern.kind === "LiteralPattern" && (a.pattern.literalKind === "string" || a.pattern.literalKind === "float")))
      return this.literalChain(m.arms, subj, stripRefs(m.subject.type), resultTy);
    const st = stripRefs(m.subject.type);
    const layout = isEnum && st.tag === "enum" ? this.cx.mlirEnumLayout(st.name) : null;
    if (isEnum && !layout) throw new MlirUnsupported("match subject layout");
    if (!isEnum && !/^([su]i\d+|i1)$/.test(subj.ty)) throw new MlirUnsupported(`match on ${subj.ty}`);
    const cases: bigint[] = [];
    const arms: { arm: typeof m.arms[0]; args: { name: string; ty: string }[]; tag?: number }[] = [];
    let dflt: typeof m.arms[0] | null = null;
    for (const arm of m.arms) {
      const p = arm.pattern;
      if (p.kind === "WildcardPattern") {
        if (dflt) throw new MlirUnsupported("two wildcard arms");
        dflt = arm;
        continue;
      }
      let c: bigint;
      let args: { name: string; ty: string }[] = [];
      if (p.kind === "EnumPattern") {
        if (!layout || p.tests) throw new MlirUnsupported("nested pattern");
        const v = layout.variants.find(x => x.tag === p.tag);
        if (!v || p.bindings.length > v.fields.length || p.bindings.some(b => b.escapes || b.path)) throw new MlirUnsupported("enum pattern");
        c = BigInt(p.tag);
        args = v.fields.map((f, k) => ({ name: p.bindings[k]?.name ?? "_", ty: bigEnum ? this.place$(f, "payload") : this.value(f, "payload") }));
      } else {
        if (isEnum || !["int", "char", "bool"].includes(p.literalKind)) throw new MlirUnsupported(`${p.literalKind} pattern`);
        // As the i64 holding its bits: a u64 case above i64::MAX wraps, the switch reads it back at the width.
        c = BigInt.asIntN(64, typeof p.value === "boolean" ? BigInt(p.value ? 1 : 0) : BigInt(p.value));
      }
      if (cases.includes(c)) throw new MlirUnsupported("two arms for one case");
      cases.push(c);
      arms.push({ arm, args, tag: p.kind === "EnumPattern" ? p.tag : undefined });
    }
    if (dflt) arms.push({ arm: dflt, args: [] });
    const ref = resultTy ? this.fresh() : "";
    const head = `${resultTy ? `${ref} = ` : ""}milo.match ${subj.ref} : ${subj.ty}${resultTy ? ` -> ${resultTy}` : ""} [${cases.join(", ")}]${dflt ? " default" : ""} {`;
    let allDone = true;
    arms.forEach(({ arm, args, tag }, i) => {
      const consumes = from !== null && args.some(a => a.name !== "_" && hasDrop(a.ty));
      // Legacy stops dropping the subject once an arm takes a payload, so an owning field
      // the arm leaves unbound would be legacy's leak; not reproduced.
      if (consumes && args.some(a => a.name === "_" && hasDrop(a.ty))) throw new MlirUnsupported("match leaving an owning payload field unbound");
      const done = this.region(i === 0 ? head : "}, {", () => {
        if (bigEnum) {
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const r = this.def(`milo.enum.field_ref ${place!.ref}[${tag}, ${k}] : !milo.ref<${place!.ty}> -> !milo.ref<${a.ty}>`, `!milo.ref<${a.ty}>`).ref;
            // Through `&mut`, and for a payload with drop glue, the binding is the payload's
            // place (legacy binds a pointer); a Copy payload under `&` is a copy.
            if (m.subjectIsMut || hasDrop(a.ty) || isBig(this.cx, a.ty)) { this.bind(a.name, { kind: "var", ref: r, ty: a.ty }); return; }
            const slot = this.fresh();
            this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            const v = this.def(`milo.load ${r} : !milo.ref<${a.ty}>`, a.ty).ref;
            this.emit(`milo.store ${v}, ${slot} : !milo.ref<${a.ty}>`);
            this.bind(a.name, { kind: "var", ref: slot, ty: a.ty });
          });
        } else if (args.length) {
          const refs = args.map(() => this.fresh());
          this.emit(`^bb0(${args.map((a, k) => `${refs[k]}: ${a.ty}`).join(", ")}):`);
          if (place) {
            args.forEach((a, k) => {
              if (a.name === "_") return;
              const r = this.def(`milo.enum.field_ref ${place!.ref}[${tag}, ${k}] : !milo.ref<${place!.ty}> -> !milo.ref<${a.ty}>`, `!milo.ref<${a.ty}>`).ref;
              this.bind(a.name, { kind: "var", ref: r, ty: a.ty });
              a.name = "_";
            });
          }
          if (consumes) {
            const moved = this.def(`milo.move ${from} : !milo.ref<${subj.ty}>`, subj.ty).ref;
            args.forEach((a, k) => {
              if (a.name === "_") return;
              refs[k] = this.def(`milo.enum.payload ${moved}[${tag}, ${k}] : ${subj.ty} -> ${a.ty}`, a.ty).ref;
              if (!hasDrop(a.ty)) return;
              // The binding owns the payload now, for the arm's scope.
              const slot = this.ownedSlot(a.name, a.ty, layout!.variants.find(v => v.tag === tag)!.fields[k]);
              this.emit(`milo.store ${refs[k]}, ${slot} : !milo.ref<${a.ty}>`);
              this.bind(a.name, { kind: "var", ref: slot, ty: a.ty, owned: true });
              a.name = "_";
            });
          }
          // A binding is a mutable copy of the payload, as legacy bindPayloads makes it:
          // `c.bump()` in the arm changes the binding.
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const slot = this.fresh();
            this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            this.emit(`milo.store ${refs[k]}, ${slot} : !milo.ref<${a.ty}>`);
            this.bind(a.name, { kind: "var", ref: slot, ty: a.ty });
          });
        }
        return resultTy ? this.tail(arm.body, resultTy) : this.stmts(arm.body);
      });
      if (!done) allDone = false;
    });
    this.emit("}");
    // A match that is not exhaustive by its cases alone still is by the checker, so
    // arms that all jump leave nothing after them.
    if (!resultTy && allDone && arms.length) { this.emit("milo.unreachable"); return { done: true, v: { ref: "", ty: "" } }; }
    return { done: false, v: { ref, ty: resultTy ?? "", own: resultTy && hasDrop(resultTy) ? "owned" : undefined } };
  }

  /**
   * A match on a string or a float: no switch, so the arms are tested in order, each an
   * `==` of the subject with the literal (strings through legacy's comparison), nested
   * milo.ifs with the `_` arm innermost.
   */
  private literalChain(arms: (HIRStmt & { kind: "Match" })["arms"], subj: Val, subjTy: TypeKind, resultTy: string | null): { done: boolean; v: Val } {
    const name = `match$subject${this.n++}`;
    this.bind(name, { kind: "ssa", v: subj });
    const subject: HIRExpr = { kind: "Ident", name, type: subjTy, isMove: false };
    const lit = (p: HIRPattern & { kind: "LiteralPattern" }): HIRExpr => {
      switch (p.literalKind) {
        case "string": return { kind: "StringLit", value: String(p.value), type: subjTy };
        case "float": return { kind: "FloatLit", value: Number(p.value), type: subjTy };
        case "bool": return { kind: "BoolLit", value: !!p.value, type: subjTy };
        case "char": return { kind: "CharLit", value: Number(p.value), type: subjTy };
        default: return { kind: "IntLit", value: BigInt(p.value as bigint), type: subjTy };
      }
    };
    const arm = (i: number): boolean | Val => {
      if (i === arms.length) { this.emit("milo.unreachable"); return true; }
      const { pattern: p, body } = arms[i];
      const run = () => resultTy ? this.tail(body, resultTy) : this.stmts(body);
      if (p.kind === "WildcardPattern") return run();
      if (p.kind !== "LiteralPattern") throw new MlirUnsupported("enum pattern on a scalar");
      const c = this.binop({ kind: "BinOp", op: "==", left: subject, right: lit(p), type: { tag: "bool" } });
      const ref = resultTy ? this.fresh() : "";
      const thenDone = this.region(`${resultTy ? `${ref} = ` : ""}milo.if ${c.ref}${resultTy ? ` -> ${resultTy}` : ""} {`, run);
      const elseDone = this.region("} else {", () => arm(i + 1));
      this.emit("}");
      if (resultTy) return { ref, ty: resultTy, own: hasDrop(resultTy) ? "owned" : undefined };
      if (thenDone && elseDone) { this.emit("milo.unreachable"); return true; }
      return false;
    };
    const r = arm(0);
    if (typeof r === "object") return { done: false, v: r };
    return { done: r, v: { ref: "", ty: "" } };
  }

  /** A call of a legacy helper; `args` are `value : type`. */
  private callHelper(name: string, args: string[], ret: string | null): Val {
    const refs = args.map(a => a.split(" : ")[0]);
    const tys = args.map(a => a.slice(a.indexOf(" : ") + 3));
    const fnTy = `(${tys.join(", ")}) -> ${ret ?? "()"}`;
    this.callees.set(name, fnTy);
    const call = `func.call @${quote(name)}(${refs.join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return this.def(call, ret);
  }

  /**
   * `a == b`, `a < b`, `a + b` on strings: a call of a legacy function doing exactly that
   * to two borrowed strings, so comparison and concatenation are legacy's.
   */
  private stringBinop(e: HIRExpr & { kind: "BinOp" }): Val {
    const names: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "+": "concat" };
    const op = names[e.op];
    if (!op) throw new MlirUnsupported(`string ${e.op}`);
    const l = this.borrow(this.expr(e.left), e.left.type);
    const r = this.borrow(this.expr(e.right), e.right.type);
    const str: TypeKind = { tag: "string" };
    if (op === "concat") {
      // Both helpers: milo-append-in-place may turn `s = s + x` into the append.
      this.cx.mlirHelper("milo.string.concat", () => ({
        params: [{ name: "a", type: str, isRef: true, isRefMut: false }, { name: "b", type: str, isRef: true, isRefMut: false }],
        retType: str,
        body: [{ kind: "Return", retType: str, value: { kind: "BinOp", op: "+", type: str,
          left: { kind: "Ident", name: "a", type: str, isMove: false }, right: { kind: "Ident", name: "b", type: str, isMove: false } } }],
      }));
      this.cx.mlirHelper("milo.string.append", () => ({
        params: [{ name: "s", type: str, isRef: false, isRefMut: true }, { name: "x", type: str, isRef: true, isRefMut: false }],
        retType: { tag: "void" },
        body: [{ kind: "ExprStmt", expr: { kind: "StringPushStr", type: { tag: "void" },
          str: { kind: "Ident", name: "s", type: str, isMove: false }, other: { kind: "Ident", name: "x", type: str, isMove: false } } }],
      }));
      return { ...this.def(`milo.string.concat ${l.ref}, ${r.ref}`, STR), own: "owned" };
    }
    const slot = (v: Val) => {
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var "operand" : !milo.ref<${STR}>`);
      this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${STR}>`);
      return ref;
    };
    const [a, b] = [slot(l), slot(r)];
    const ret: TypeKind = { tag: "bool" };
    const name = `milo.string.${op}`;
    this.cx.mlirHelper(name, () => ({
      params: [{ name: "a", type: str, isRef: true, isRefMut: false }, { name: "b", type: str, isRef: true, isRefMut: false }],
      retType: ret,
      body: [{ kind: "Return", retType: ret, value: { kind: "BinOp", op: e.op, type: ret,
        left: { kind: "Ident", name: "a", type: str, isMove: false }, right: { kind: "Ident", name: "b", type: str, isMove: false } } }],
    }));
    const fnTy = `(!milo.ref<${STR}>, !milo.ref<${STR}>) -> i1`;
    this.callees.set(name, fnTy);
    return this.def(`func.call @${quote(name)}(${a}, ${b}) : ${fnTy}`, "i1");
  }

  private binop(e: HIRExpr & { kind: "BinOp" }): Val {
    if (e.op === "&&" || e.op === "||") {
      // `a && b` is `if a { b } else { false }`: b runs only when a does not decide it.
      const l = this.expr(e.left);
      if (l.ty !== "i1") throw new MlirUnsupported("logical operand type");
      const ref = this.fresh();
      const isAnd = e.op === "&&";
      const rhs = () => {
        const r = this.expr(e.right);
        if (r.ty !== "i1") throw new MlirUnsupported("logical operand type");
        return r;
      };
      const lit = () => this.def(`milo.const ${!isAnd}`, "i1");
      this.region(`${ref} = milo.if ${l.ref} -> i1 {`, isAnd ? rhs : lit);
      this.region("} else {", isAnd ? lit : rhs);
      this.emit("}");
      return { ref, ty: "i1" };
    }
    if (stripRefs(e.left.type).tag === "string" && stripRefs(e.right.type).tag === "string") return this.stringBinop(e);
    const ty = scalar(e.left.type, "binop operand");
    if (ty === PTR && !(e.op in CMPS)) throw new MlirUnsupported(`pointer ${e.op}`);
    const l = this.expr(e.left), r = this.expr(e.right);
    if (l.ty !== ty || r.ty !== ty) throw new MlirUnsupported("binop operand types");
    if (e.op in CMPS) return this.def(`milo.cmp ${CMPS[e.op]}, ${l.ref}, ${r.ref} : ${ty}`, "i1");
    if (scalar(e.type, "binop result") !== ty) throw new MlirUnsupported("binop result type");
    if (e.op in BITS) {
      if (ty.startsWith("f")) throw new MlirUnsupported("bitwise op on a float");
      return this.def(`milo.${BITS[e.op]} ${l.ref}, ${r.ref} : ${ty}`, ty);
    }
    const op = ARITH[e.op];
    if (!op) throw new MlirUnsupported(`binop ${e.op}`);
    const isInt = ty.startsWith("s") || ty.startsWith("u");
    if (!isInt && (op === "shl" || op === "shr")) throw new MlirUnsupported("shift of a non-int");
    if (ty === "i1") throw new MlirUnsupported("arithmetic on bool");
    // Mirrors emitScalarBinOp: + - * trap only with overflow checks on, outside @wrapping,
    // and with a span; / % << >> trap unless @wrapping.
    const wrapping = isInt && (op === "add" || op === "sub" || op === "mul"
      ? !(this.cx.trapOnOverflow && !this.fn.isWrapping && e.span)
      : !!this.fn.isWrapping);
    return this.def(`milo.${op} ${l.ref}, ${r.ref}${wrapping ? " wrapping" : ""} : ${ty}`, ty, isInt ? this.loc(e.span) : "");
  }

  private unop(e: HIRExpr & { kind: "UnaryOp" }): Val {
    if (e.op === "&") {
      // `x.addrOf()`: the address of a place.
      if (e.operand.kind === "Ident") {
        const b = this.lookup(e.operand.name);
        if (b.kind === "vec") return this.def(`milo.addr ${b.ref} : !milo.vec<${b.elem}>`, PTR);
        if (b.kind === "var") return this.def(`milo.addr ${b.ref} : !milo.ref<${b.ty}>`, PTR);
      }
      const p = this.fieldPlace(e.operand);
      if (!p) throw new MlirUnsupported("address of a value");
      return this.def(`milo.addr ${p.ref} : !milo.ref<${p.ty}>`, PTR);
    }
    const ty = scalar(e.type, "unop");
    if (ty === PTR) throw new MlirUnsupported(`unop ${e.op} on a pointer`);
    if (e.op === "-") {
      // A negated literal is a constant, as in codegen: i32's MIN is spelled
      // `-2147483648` and must not reach a checked negation of 2147483648.
      if (e.operand.kind === "IntLit" && e.operand.type.tag === "int" && e.operand.type.signed) {
        if (scalar(e.operand.type, "literal") !== ty) throw new MlirUnsupported("negated literal type");
        return this.def(`milo.const ${-BigInt(e.operand.value)} : ${ty}`, ty);
      }
      const v = this.expr(e.operand);
      if (v.ty !== ty || ty === "i1") throw new MlirUnsupported("negation operand type");
      const isInt = !ty.startsWith("f");
      const wrapping = isInt && !(this.cx.trapOnOverflow && !this.fn.isWrapping && e.span);
      return this.def(`milo.neg ${v.ref}${wrapping ? " wrapping" : ""} : ${ty}`, ty, isInt ? this.loc(e.span) : "");
    }
    if (e.op === "!" || e.op === "~") {
      const v = this.expr(e.operand);
      if (v.ty !== ty || ty.startsWith("f") || (e.op === "!") !== (ty === "i1")) throw new MlirUnsupported(`unop ${e.op} operand type`);
      return this.def(`milo.not ${v.ref} : ${ty}`, ty);
    }
    throw new MlirUnsupported(`unop ${e.op}`);
  }

  /**
   * `v[i]` on a by-ref Vec param: the Vec, its element type and the index as si64. Object
   * first, then the index, as legacy genVecBoundsCheckedPtr evaluates them; a narrower
   * index widens by its own signedness (legacy indexToI64), which milo.cast does.
   */
  private indexPlace(e: HIRExpr & { kind: "IndexAccess" }): { vec: string; elem: string; index: string } {
    const { place, elem } = this.vecPlace(e.object);
    // Legacy clones an element that owns (a Vec index hands out an independent value).
    if (!isScalarTy(elem)) throw new MlirUnsupported("index into a Vec of non-scalars");
    const i = this.expr(e.index);
    if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
    const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
    return { vec: place, elem, index };
  }

  /** The header address of the Vec `e` names: a by-ref Vec param, or an owned Vec local. */
  private vecPlace(e: HIRExpr): { place: string; elem: string; param?: number } {
    const b = e.kind === "Ident" ? this.lookup(e.name) : null;
    if (b?.kind === "vec") return { place: b.ref, elem: b.elem, param: b.param };
    // A Vec local, or a Vec field of a place.
    const slot = b?.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : e.kind === "FieldAccess" ? this.fieldPlace(e) : null;
    const m = slot ? /^!milo\.vecval<(.*)>$/.exec(slot.ty) : null;
    if (!slot || !m) throw new MlirUnsupported("a Vec that is not a param, a local or a field");
    const place = this.def(`milo.vec.place ${slot.ref} : !milo.ref<${slot.ty}> -> !milo.vec<${m[1]}>`, `!milo.vec<${m[1]}>`);
    return { place: place.ref, elem: m[1], param: slot.param };
  }

  /**
   * The slot a by-ref argument borrows. A `var` or a by-ref param is its own slot; an
   * immutable value lent as `&T` gets a fresh one, as legacy codegen spills it.
   */
  private place(e: HIRExpr, refTy: string, mut: boolean): { ref: string; param?: number } {
    if (e.kind === "FieldAccess") {
      // A field of a slot is lent in place; the slot's param, if any, is where it points.
      const p = this.fieldPlace(e);
      if (!p || `!milo.ref<${p.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg of a field of a value");
      return { ref: p.ref, param: p.param };
    }
    if (e.kind !== "Ident") {
      // A value lent as `&T` (`f(Shape.Empty)`) gets a slot of its own, as legacy spills it.
      if (mut) throw new MlirUnsupported(`by-ref &mut arg ${e.kind}`);
      const v = this.expr(e);
      const vm = /^!milo\.vecval<(.*)>$/.exec(v.ty);
      if (vm && refTy === `!milo.vec<${vm[1]}>` && v.own === "owned") {
        // A temporary Vec lends its header from a slot that drops it.
        const slot = this.ownedSlot("arg", v.ty, e.type);
        this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
        return { ref: this.def(`milo.vec.place ${slot} : !milo.ref<${v.ty}> -> ${refTy}`, refTy).ref };
      }
      if (`!milo.ref<${v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      if (hasDrop(v.ty) && v.own === "owned") {
        // A temporary that owns a buffer lends from a slot that drops it.
        const slot = this.ownedSlot("arg", v.ty, e.type);
        this.emit(`milo.store ${v.ref}, ${slot} : ${refTy}`);
        return { ref: slot };
      }
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var "arg" : ${refTy}`);
      this.emit(`milo.store ${v.ref}, ${ref} : ${refTy}`);
      return { ref };
    }
    const b = this.lookup(e.name);
    if (b.kind === "vec" || (b.kind === "var" && refTy.startsWith("!milo.vec<"))) {
      const { place, elem, param } = this.vecPlace(e);
      if (`!milo.vec<${elem}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      return { ref: place, param };
    }
    if (`!milo.ref<${b.kind === "var" ? b.ty : b.v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
    if (b.kind === "var") return { ref: b.ref, param: b.param };
    // A spilled copy would take the callee's writes and drop them.
    if (mut) throw new MlirUnsupported("&mut of an immutable binding");
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(e.name)} : ${refTy}`);
    this.emit(`milo.store ${b.v.ref}, ${ref} : ${refTy}`);
    return { ref };
  }

  /**
   * print/eprint: one milo.print of every part. An interpolated string is
   * `print(format(parts))`; printing the parts displays the same text without building the
   * string (format and print share legacy's int and float formatting).
   */
  private print(e: HIRExpr & { kind: "Call" }): Val {
    let args = e.args;
    const only = args.length === 1 ? args[0].expr : null;
    if (only?.kind === "Call" && only.func === "format" && this.cx.isBuiltinName("format")) args = only.args;
    const parts = args.map(a => {
      if (a.passByRef) throw new MlirUnsupported("by-ref print part");
      let t = a.expr.type;
      while (t.tag === "ref") t = t.inner;
      const v = this.borrow(this.expr(a.expr), t);
      // Scalar.cpp printKey spells the same names.
      if (valueType(this.cx, t) !== v.ty || t.tag === "vec") throw new MlirUnsupported(`print part of type ${t.tag}`);
      const key = typeKey(t);
      return { v, key, type: t };
    });
    this.cx.mlirPrintHelper(e.func === "eprint", parts.map(p => ({ key: p.key, type: p.type })));
    const flag = e.func === "eprint" ? " stderr" : "";
    if (parts.length === 0) this.emit(`milo.print${flag}`);
    else this.emit(`milo.print${flag} ${parts.map(p => p.v.ref).join(", ")} : ${parts.map(p => p.v.ty).join(", ")}`);
    return { ref: "", ty: "" };
  }

  private call(e: HIRExpr & { kind: "Call" }, stmt: boolean, into?: string): Val {
    if ((e.func === "print" || e.func === "eprint") && this.cx.isBuiltinName(e.func)) return this.print(e);
    if (e.variadic) throw new MlirUnsupported("variadic call");
    if (this.cx.isBuiltinName(e.func)) throw new MlirUnsupported(`builtin ${e.func}`);
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    if (!callee || !sig || sig.variadic) throw new MlirUnsupported("callee");
    const sret = this.cx.sretFns.has(e.func);
    if (sret !== (into !== undefined)) throw new MlirUnsupported("sret call as a value");
    // An extern's call goes to its C symbol; keep those on legacy codegen for now.
    if (callee.isExtern && callee.linkName && callee.linkName !== callee.name) throw new MlirUnsupported("callee link name");
    if (callee.params.length !== e.args.length) throw new MlirUnsupported("callee arity");
    const paramTys = callee.params.map((p, i) => {
      const byRef = p.isRef || p.isRefMut;
      if (byRef !== e.args[i].passByRef) throw new MlirUnsupported("by-ref arg mismatch");
      const elem = byRef ? vecElem(this.cx, p.type) : null;
      const pt = placeType(this.cx, p.type);
      const ty = elem ?? (byRef || (pt !== null && isBig(this.cx, pt)) ? this.place$(p.type, "by-ref arg") : this.value(p.type, "call arg"));
      if (sig.paramTypes[i] !== (byRef ? "ptr" : this.cx.llvmType(p.type))) throw new MlirUnsupported("callee signature");
      return elem !== null ? `!milo.vec<${elem}>` : byRef ? `!milo.ref<${ty}>` : ty;
    });
    const ret = callee.retType.tag === "void" || sret ? null : this.value(callee.retType, "call result");
    if (sret) paramTys.unshift(`!milo.ref<${this.place$(callee.retType, "sret result")}>`);
    else if (ret !== null ? sig.retType !== this.cx.llvmType(callee.retType) : sig.retType !== "void") throw new MlirUnsupported("callee signature");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const provenance: (number | null)[] = [];
    const k0 = sret ? 1 : 0;
    const args = e.args.map((a, j) => {
      const i = j + k0;
      if (a.passByRef) {
        const ref = this.place(a.expr, paramTys[i], a.refMut);
        refs.push({ ref: ref.ref, mut: a.refMut, ty: paramTys[i] });
        provenance.push(ref.param ?? null);
        return ref.ref;
      }
      const v = isBig(this.cx, paramTys[i]) ? this.bigArg(a.expr, paramTys[i]) : this.consume(this.expr(a.expr), "argument");
      if (v.ty !== paramTys[i]) throw new MlirUnsupported("call arg type");
      provenance.push(null);
      return v.ref;
    });
    // As legacy genCall: after every argument, one check per pair with a `&mut`; a pair
    // that is the same SSA value is the same static place, which the checker already
    // rejected.
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
        this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
      }
    }
    const fnTy = `(${paramTys.join(", ")}) -> ${ret === null ? "()" : ret}`;
    this.callees.set(e.func, fnTy);
    this.calls.push({ name: e.func, refParams: provenance });
    if (into !== undefined) args.unshift(into);
    const call = `func.call @${quote(e.func)}(${args.join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return { ...this.def(call, ret), own: hasDrop(ret) ? "owned" : undefined };
  }
}

export interface MlirFunction {
  name: string;
  text: string;
  /** Every function it calls, with the dialect's function type. */
  callees: Map<string, string>;
  calls: FnEmitter["calls"];
  /** Its closure bodies: functions of their own, in `text` too, new to the legacy module. */
  closures: string[];
}

/** `fn` in the dialect, or the reason it stays on legacy codegen. */
export function emitMlirFunction(fn: HIRFunction, cx: MlirEmitCtx, fns: Map<string, HIRFunction>): MlirFunction | string {
  const em = new FnEmitter(fn, cx, fns);
  try {
    const text = em.run();
    return { name: fn.name, text: [text, ...em.closures.texts].join("\n"), callees: em.callees, calls: em.calls, closures: em.closures.names };
  } catch (err) {
    if (err instanceof MlirUnsupported) return err.reason;
    throw err;
  }
}

/** Why `fn` stays on legacy codegen, or null when the dialect covers it. */
export function mlirSupports(fn: HIRFunction, cx: MlirEmitCtx, fns: Map<string, HIRFunction>): string | null {
  const r = emitMlirFunction(fn, cx, fns);
  return typeof r === "string" ? r : null;
}

/** One module: the functions, plus a declaration for every callee not among them. */
export function mlirModuleText(funcs: MlirFunction[]): string {
  const have = new Set(funcs.flatMap(f => [f.name, ...f.closures]));
  const callees = new Map<string, string>();
  for (const f of funcs) for (const [k, v] of f.callees) if (!have.has(k)) callees.set(k, v);
  const decls = [...callees].map(([k, ty]) => {
    // The arrow after the argument list's closing paren: a !milo.fn argument has its own.
    let depth = 0, end = 0;
    for (; end < ty.length; end++) {
      if (ty[end] === "(") depth++;
      else if (ty[end] === ")" && --depth === 0) break;
    }
    const args = ty.slice(0, end + 1), ret = ty.slice(end + 5);
    return `func.func private @${quote(k)}${args}${ret === "()" ? "" : ` -> ${ret}`}`;
  });
  return [...decls, ...funcs.map(f => f.text), ""].join("\n");
}
