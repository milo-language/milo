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
  mlirPrintHelper(stderr: boolean, parts: { key: string; type: TypeKind }[], partial?: boolean): string;
  hasStringType: boolean;
  hasVecType: boolean;
  mlirDropHelper(key: string, t: TypeKind): void;
  mlirVecTailDropHelper(key: string, vec: TypeKind): void;
  mlirHelper(name: string, make: () => Omit<HIRFunction, "name" | "isExtern" | "isVariadic">): string;
  structLayouts: Map<string, { fields: { name: string; typeKind: TypeKind }[] }>;
  mlirEnumLayout(name: string): { size: number; align: number; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null;
  needsDropCg(t: TypeKind): boolean;
  dropImpls: Set<string>;
  typeSizeOf(t: TypeKind): number;
  mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null;
  // libc calls that keep a pointer argument past the call (codegen RETAINING_LIBC).
  readonly retainingLibc: ReadonlySet<string>;
}

// What codegen names main's body behind the green-task wrapper (Codegen.MAIN_BODY_FN).
export const MAIN_BODY = "__milo_main_body";

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

const I64: TypeKind = { tag: "int", bits: 64, signed: true };
/** The place type of a `ty`: a Vec's is its header (!milo.vec), anything else's a !milo.ref. */
const refOf = (ty: string) => { const m = /^!milo\.vecval<(.*)>$/.exec(ty); return m ? `!milo.vec<${m[1]}>` : `!milo.ref<${ty}>`; };
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
    case "hashmap": return `map.${typeKey(t.key)}.${typeKey(t.value)}`;
    case "heap": return t.inner.tag === "interface" ? `dyn.${t.inner.name}` : `heap.${typeKey(t.inner)}`;
    // A plain fn by its signature, as Scalar.cpp typeKey: a helper takes it as a typed
    // param. The param count and `v` for no result keep the dotted key decodable.
    case "fn": if (t.owning) return "ownfn";
      return [`fn${t.params.length}`, ...t.params.map(p => p.tag === "ref" ? `r${typeKey(p)}` : typeKey(p)),
        t.ret.tag === "void" ? "v" : typeKey(t.ret)].join(".");
    case "struct": return `S${t.name}`;
    case "enum": return `E${t.name}`;
    case "array": if (t.size !== null) return `arr${t.size}.${typeKey(t.element)}`; throw new MlirUnsupported("helper for a slice");
    default: throw new MlirUnsupported(`helper for a ${t.tag}`);
  }
}

function scalar(t: TypeKind, what: string): string {
  const m = mlirType(t);
  if (m === null) throw new MlirUnsupported(`${what} of type ${t.tag}`);
  return m;
}

const aggregates = new WeakMap<MlirEmitCtx, Map<string, string | null>>();
// The aggregates placeType is spelling, outermost first, and the outermost of them the
// spelling so far names by name alone.
const spelling = new WeakMap<MlirEmitCtx, { keys: string[]; outer: number }>();

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
  if (r !== null && isBig(cx, r) && r.startsWith("!milo.enum<") && cx.typeSizeOf(t) < BIG_ENUM_VALUE_LIMIT) return r;
  if (r === null || !isBig(cx, r)) return r;
  if (!placeOnly.has(cx)) placeOnly.set(cx, new Set());
  placeOnly.get(cx)!.add(r);
  return null;
}

// The big types valueType refused: only ever in places, copied with milo.copy.
const placeOnly = new WeakMap<MlirEmitCtx, Set<string>>();

// A 128+ byte enum below this is also a value: legacy returns and passes one by value
// (only structs get sret), so it is an SSA aggregate there too. Larger ones stay places,
// the size at which SROA's split of a whole-aggregate load starts to cost.
const BIG_ENUM_VALUE_LIMIT = 512;

// What a spelled type owns, decided from the checker's type it was spelled from, never
// from its text: a type met again inside itself is spelled by name alone, which hides
// its fields. A string instead of an answer is why the type stays legacy.
interface Owns { drop: boolean; userDrop: boolean }
const owners = new WeakMap<MlirEmitCtx, Map<string, Owns | string>>();

function recordOwns(cx: MlirEmitCtx, text: string, t: TypeKind): void {
  let m = owners.get(cx);
  if (!m) owners.set(cx, m = new Map());
  const drop = ownsStructurally(cx, t, []);
  // milo-opt decides what to drop from the dialect type (Milo.cpp needsDrop), the drop
  // glue it calls is legacy's (needsDropCg): where they differ, one of them is wrong.
  // Legacy computes droppable enums in one pass, so an enum holding one declared after
  // it (`enum W { Wrap(Option<string>) }`) is never dropped there: a legacy leak.
  const o: Owns | string = drop !== cx.needsDropCg(t) ? "a type legacy's drop glue does not drop"
    : { drop, userDrop: runsUserDropT(cx, t, []) };
  const had = m.get(text);
  if (had === undefined) m.set(text, o);
  else if (typeof had !== "string" && (typeof o === "string" || had.drop !== o.drop || had.userDrop !== o.userDrop))
    m.set(text, typeof o === "string" ? o : "a type whose dialect spelling two checker types share");
}

/** Milo.cpp needsDrop, over the checker's type. */
function ownsStructurally(cx: MlirEmitCtx, t: TypeKind, seen: string[]): boolean {
  switch (t.tag) {
    case "string": case "vec": case "hashmap": case "heap": return true;
    case "fn": return t.owning === true;
    case "struct": case "enum": {
      if (cx.dropImpls.has(t.name)) return true;
      // A type holds itself only through a Vec or a Heap, which owns already.
      if (seen.includes(t.name)) return false;
      return fieldTypes(cx, t).some(f => ownsStructurally(cx, f, [...seen, t.name]));
    }
    default: return false;
  }
}

function fieldTypes(cx: MlirEmitCtx, t: TypeKind & { tag: "struct" | "enum" }): TypeKind[] {
  return t.tag === "struct" ? cx.structLayouts.get(t.name)?.fields.map(f => f.typeKind) ?? []
    : cx.mlirEnumLayout(t.name)?.variants.flatMap(v => v.fields) ?? [];
}

/** A user's Drop runs somewhere inside a value of `t` when it is dropped. */
function runsUserDropT(cx: MlirEmitCtx, t: TypeKind, seen: string[]): boolean {
  switch (t.tag) {
    case "vec": case "array": return runsUserDropT(cx, t.element, seen);
    case "heap": return runsUserDropT(cx, t.inner, seen);
    case "hashmap": return runsUserDropT(cx, t.key, seen) || runsUserDropT(cx, t.value, seen);
    case "struct": case "enum":
      if (cx.dropImpls.has(t.name)) return true;
      if (seen.includes(t.name)) return false;
      return fieldTypes(cx, t).some(f => runsUserDropT(cx, f, [...seen, t.name]));
    // The concrete type behind an interface is erased (legacy typeRunsUserDrop).
    case "interface": return true;
    // An owning closure's captures are not in its type; capturing one is refused instead.
    default: return false;
  }
}

/**
 * What a value of dialect type `ty` owns. Every value type the emitter uses comes from
 * placeType, or is a place (a ref, a Vec header: a borrow) or a consumed Vec's tail.
 */
function ownsOf(cx: MlirEmitCtx, ty: string): Owns {
  const o = owners.get(cx)?.get(ty);
  if (typeof o === "string") throw new MlirUnsupported(o);
  if (o) return o;
  if (ty.startsWith("!milo.ref<") || ty.startsWith("!milo.vec<")) return { drop: false, userDrop: false };
  if (ty.startsWith("!milo.vectail<")) return { drop: true, userDrop: ownsOf(cx, `!milo.vecval<${ty.slice(14, -1)}>`).userDrop };
  throw new MlirUnsupported("ownership of a type not spelled from a checker type");
}

/**
 * The dialect's type for what a place of type `t` holds: a scalar, a string, a Vec, a fn
 * value, or a struct or enum of those, of any size. A big one is read and written field
 * by field through field_ref, as legacy does through its address.
 */
function placeType(cx: MlirEmitCtx, t: TypeKind): string | null {
  const r = spellPlace(cx, t);
  if (r !== null) recordOwns(cx, r, t);
  return r;
}

function spellPlace(cx: MlirEmitCtx, t: TypeKind): string | null {
  const m = mlirType(t);
  if (t.tag === "string") { cx.hasStringType = true; return STR; }
  if (t.tag === "vec") {
    const e = vecElem(cx, t);
    if (e) cx.hasVecType = true;
    return e && `!milo.vecval<${e}>`;
  }
  if (t.tag === "fn") return fnType(cx, t);
  if (t.tag === "heap") {
    // A Heap of an interface is legacy's fat { data, itable } pair, opaque here.
    if (t.inner.tag === "interface") return `!milo.dyn<${quote(t.inner.name)}>`;
    const v = placeType(cx, t.inner);
    return v && `!milo.heap<${v}>`;
  }
  if (t.tag === "hashmap") {
    // Opaque here: std/hashmap's methods read it through a raw pointer (MapRaw).
    const k = placeType(cx, t.key), v = placeType(cx, t.value);
    return k && v && `!milo.map<${k}, ${v}>`;
  }
  if (t.tag === "array") {
    // A fixed-size array of elements that own nothing: a place only, at any size (a
    // slice, size null, is a Vec header that a slice expression makes: not yet).
    const e = t.size === null ? null : placeType(cx, t.element);
    // Asked of the checker's element: inside its own body a type is spelled by name
    // alone, and that text would say an owning element owns nothing.
    if (e === null || cx.needsDropCg(t.element)) return null;
    const r = `!milo.array<${e}, ${t.size}>`;
    if (!bigTypes.has(cx)) bigTypes.set(cx, new Set());
    bigTypes.get(cx)!.add(r);
    return r;
  }
  if (m !== null || (t.tag !== "struct" && t.tag !== "enum")) return m;
  let cache = aggregates.get(cx);
  if (!cache) aggregates.set(cx, cache = new Map());
  const key = `${t.tag} ${t.name}`;
  if (cache.has(key)) return cache.get(key)!;
  let sp = spelling.get(cx);
  if (!sp) spelling.set(cx, sp = { keys: [], outer: Infinity });
  const at = sp.keys.indexOf(key);
  if (at >= 0) {
    // Met again inside its own fields (through a Vec): by name alone, the same type.
    sp.outer = Math.min(sp.outer, at);
    return `!milo.${t.tag}<${quote(t.name)}>`;
  }
  const depth = sp.keys.length, saved = sp.outer;
  sp.keys.push(key);
  sp.outer = Infinity;
  let r: string | null;
  try { r = aggregateType(cx, t); } finally { sp.keys.pop(); }
  // A spelling that names an enclosing type by name alone is complete only inside that
  // type's own, so it is not the one to reuse.
  if (sp.outer >= depth) cache.set(key, r);
  sp.outer = Math.min(saved, sp.outer);
  // One holding an array is a place only too: the array is never an SSA value.
  if (r !== null && (cx.typeSizeOf(t) >= 128 || r.includes("!milo.array<"))) {
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
  const ps = t.params.map(p => closureParamType(cx, p));
  if (ps.some(x => x === null)) return null;
  const r = t.ret.tag === "void" ? "()" : valueType(cx, t.ret);
  return r === null ? null : `!milo.fn<${t.owning ? "owning " : ""}(${ps.join(", ")}) -> ${r}>`;
}

/** A closure param: a `&T` is the place (legacy closureParamTy passes a pointer). */
function closureParamType(cx: MlirEmitCtx, p: TypeKind): string | null {
  if (p.tag !== "ref") return valueType(cx, p);
  if (p.inner.tag === "vec") { const e = vecElem(cx, p.inner); return e && `!milo.vec<${e}>`; }
  // A slice param is the address of a %Vec header that a slice expression makes: not yet.
  if (p.inner.tag === "array") return null;
  // A place, so a 128+ byte struct is lent like any other (its address).
  const v = placeType(cx, p.inner);
  return v && `!milo.ref<${v}>`;
}

// Its own `impl Drop`; one on a field's type makes that field's valueType null.
const hasUserDrop = (cx: MlirEmitCtx, t: TypeKind & { name: string }) => cx.dropImpls.has(t.name);

function aggregateType(cx: MlirEmitCtx, t: TypeKind & { tag: "struct" | "enum" }): string | null {
  if (cx.llvmType(t) !== `%${t.name}`) return null;
  const drop = hasUserDrop(cx, t) ? " drop" : "";
  if (t.tag === "struct") {
    const l = cx.structLayouts.get(t.name);
    const fields = l?.fields.map(f => placeType(cx, f.typeKind));
    if (!fields || fields.some(f => f === null)) return null;
    return `!milo.struct<${quote(t.name)}${drop}${fields.map(f => `, ${f}`).join("")}>`;
  }
  const l = cx.mlirEnumLayout(t.name);
  if (!l) return null;
  const variants: string[] = [];
  for (const v of l.variants) {
    const fields = v.fields.map(f => placeType(cx, f));
    if (fields.some(f => f === null)) return null;
    variants.push(`${v.tag}: (${fields.map((f, k) => `${f} at ${v.offsets[k]}`).join(", ")})`);
  }
  return `!milo.enum<${quote(t.name)}${drop}, size = ${l.size}, align = ${l.align}, [${variants.join(", ")}]>`;
}

function stripRefs(t: TypeKind): TypeKind {
  while (t.tag === "ref") t = t.inner;
  return t;
}

/** Why valueType rejects `t`: its tag, and for an aggregate what inside it blocks it. */
function blocker(cx: MlirEmitCtx, t: TypeKind, depth = 0, seen: string[] = []): string {
  if (t.tag === "int") return "ranged int";
  if (t.tag === "vec" && depth <= 3) return `vec (${blocker(cx, t.element, depth + 1, seen)})`;
  if ((t.tag !== "struct" && t.tag !== "enum") || depth > 3) return t.tag;
  if (seen.includes(t.name)) return "recursive";
  const why = cx.typeSizeOf(t) >= 128 ? "128+ bytes" : cx.llvmType(t) !== `%${t.name}` ? "niche" : null;
  if (why) return `${t.tag} (${why})`;
  const fields = t.tag === "struct" ? cx.structLayouts.get(t.name)?.fields.map(f => f.typeKind) ?? []
    : cx.mlirEnumLayout(t.name)?.variants.flatMap(v => v.fields) ?? [];
  const bad = fields.find(f => valueType(cx, f) === null);
  return bad ? `${t.tag} (${blocker(cx, bad, depth + 1, [...seen, t.name])})` : t.tag;
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

// What the closure bodies of one top-level function share: their names and texts.
interface ClosureState { next: number; texts: string[]; names: string[] }

// Builtins taken as a call of a legacy function doing exactly them (builtinCall): they
// read their operands and touch nothing of the caller's frame. exit never returns, so
// nothing after it runs either way.
const HELPER_BUILTINS = /^(_atomic\w+|exit|flush|_cstrToString|_bytesToString|_strDataPtr|_putByte|_loadU8|_loadI32|_callClosureVoid|_schedulerGet|_schedulerSet|_panicHookSet|_miloArgCount|_miloArgAt)$/;

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

  private hasDrop(ty: string): boolean { return ownsOf(this.cx, ty).drop; }
  /** `ty` runs a user's Drop when dropped: when that happens is observable. */
  private runsUserDrop(ty: string): boolean { return ownsOf(this.cx, ty).userDrop; }

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
      else if (this.hasDrop(ty)) {
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
    // splice keeps it. Behind a green-task wrapper main's body is MAIN_BODY, which the
    // wrapper's task calls with nothing and takes its i32 as the exit code.
    const isMain = fn.name === "main";
    if (isMain && (fn.params.length || fn.retType.tag !== "void")) throw new MlirUnsupported("main");
    const green = isMain && !this.cx.mlirMainOk;
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
      if (isBig(this.cx, ty) && !this.hasDrop(ty)) {
        // A 128+ byte param arrives by value (legacy's ABI) and goes straight to a slot, as
        // legacy spills it; from there it is only a place.
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var ${quote(p.name)} : !milo.ref<${ty}>`);
        this.emit(`milo.store %p${i}, ${slot} : !milo.ref<${ty}>`);
        this.bind(p.name, { kind: "var", ref: slot, ty });
        return `%p${i}: ${ty}`;
      }
      if (this.hasDrop(ty)) {
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
    if (isMain && !green) params.push("%argc: si32", `%argv: ${PTR}`);
    // An sret function (a 128+ byte result) writes its result through `%out`, the hidden
    // first param of legacy's `void @f(ptr %__sret.out, ...)`, and returns nothing.
    if (this.cx.sretFns.has(fn.name)) {
      this.sretOut = { ref: "%out", ty: this.place$(fn.retType, "sret result") };
      params.unshift(`%out: !milo.ref<${this.sretOut.ty}>`);
    }
    const ret = isMain ? "si32" : fn.retType.tag === "void" || this.sretOut ? null : this.abiValue(fn.retType, "return");
    this.retPlaceOnly = ret !== null && !isMain && valueType(this.cx, fn.retType) === null;
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
    const head = `func.func @${quote(green ? MAIN_BODY : fn.name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} {`;
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
    if (this.isSretCall(e)) { this.callScope(() => this.call(e, true, dst)); return; }
    const src = valueType(this.cx, e.type) === ty ? null : this.bigPlace(e, ty);
    if (src) {
      this.emit(`milo.copy ${src.ref}, ${dst} : ${src.refTy}, !milo.ref<${ty}> of ${ty}`);
      src.done();
      return;
    }
    if ((e.kind === "ArrayLit" || e.kind === "ArrayRepeat") && e.type.tag === "array") {
      this.arrayInto(e, dst, ty);
      return;
    }
    // A value-producing branch fills the place from each arm, as legacy's genStoreInto
    // does for a big match or if: the value is never an SSA one.
    if (valueType(this.cx, e.type) !== ty) {
      if (e.kind === "MatchExpr") { this.match(e, null, b => this.tailInto(b, dst, ty)); return; }
      if (e.kind === "Propagate") { this.propagate(e, { dst, ty }); return; }
      if (e.kind === "DefaultValue") { this.defaultValue(e, { dst, ty }); return; }
      if (e.kind === "Zeroed" && this.place$(e.zeroType, "zeroed value") === ty) {
        // A constant store: LLVM makes it a memset, as legacy's zeroinitializer store.
        this.emit(`milo.store ${this.def(`milo.zero : ${ty}`, ty).ref}, ${dst} init : !milo.ref<${ty}>`);
        return;
      }
      if (e.kind === "IfExpr") {
        const c = this.expr(e.cond);
        if (c.ty !== "i1") throw new MlirUnsupported("if condition type");
        this.region(`milo.if ${c.ref} {`, () => this.tailInto(e.thenBody, dst, ty));
        this.region("} else {", () => this.tailInto(e.elseBody, dst, ty));
        this.emit("}");
        return;
      }
    }
    if (e.kind !== "StructLit" && valueType(this.cx, e.type) === ty) {
      // A big enum that is also a value: computed, then stored whole.
      const v = this.consume(this.expr(e), "value");
      this.emit(`milo.store ${v.ref}, ${dst} init : !milo.ref<${ty}>`);
      return;
    }
    if (e.kind === "EnumLit") { this.enumInto(e, dst, ty); return; }
    // isSretCall narrowed Call away; a call that is not sret returns a place-only value.
    const c = e as HIRExpr;
    if (c.kind === "Call" && !this.cx.isBuiltinName(c.func)) {
      this.abiResult = true;
      const v = this.callScope(() => this.call(c, false));
      this.abiResult = false;
      if (v.ty !== ty) throw new MlirUnsupported("call result of another type");
      this.emit(`milo.store ${v.ref}, ${dst} init : !milo.ref<${ty}>`);
      return;
    }
    if (e.kind !== "StructLit" || e.base) throw new MlirUnsupported(`128+ byte value other than a literal or an sret call: ${e.kind}`);
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout || this.place$(e.type, "struct literal") !== ty) throw new MlirUnsupported("struct literal layout");
    const given = new Map<string, Val>();
    const mark = this.pending;
    for (const f of e.fields) {
      const i = layout.fields.findIndex(lf => lf.name === f.name);
      const lt = layout.fields[i]?.typeKind;
      const pty = lt && valueType(this.cx, lt) === null ? placeType(this.cx, lt) : null;
      if (pty === null) { given.set(f.name, this.pend(this.consume(this.expr(f.value), "field"))); continue; }
      // A field that is a place only (an array) is built in its own place, in source order.
      this.into(f.value, this.def(`milo.field_ref ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${pty}>`, `!milo.ref<${pty}>`).ref, pty);
      // An owning one built in place is owned by nothing until the whole struct is: a
      // jump out of a later field would leak it, so it counts as a pending operand.
      if (this.hasDrop(pty)) this.pending++;
      given.set(f.name, { ref: "", ty: pty });
    }
    this.pending = mark;
    layout.fields.forEach((f, i) => {
      const g = given.get(f.name);
      if (g?.ref === "") return;
      const fty = this.value(f.typeKind, "field");
      const v = g && this.fnAs(g, fty, true);
      if (!v || v.ty !== fty) throw new MlirUnsupported("struct literal field");
      const r = this.def(`milo.field_ref ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`).ref;
      this.emit(`milo.store ${v.ref}, ${r} init : !milo.ref<${fty}>`);
    });
  }

  /**
   * A place-only enum literal (`Ok(bigRow)` of a 512+ byte Result) built where it lives:
   * the tag, then each payload field in order through its place, a place-only one built
   * in it. A filled owning field is owned by nothing until the enum's place is, so it
   * counts as pending, as in a struct literal built in place.
   */
  private enumInto(e: HIRExpr & { kind: "EnumLit" }, dst: string, ty: string): void {
    const v = this.cx.mlirEnumLayout(e.enumName)?.variants.find(x => x.name === e.variant);
    if (!v || v.fields.length !== e.args.length) throw new MlirUnsupported("enum variant");
    this.emit(`milo.enum.set_tag ${dst}, ${v.tag} : !milo.ref<${ty}>`);
    const mark = this.pending;
    e.args.forEach((a, k) => {
      const fty = this.place$(v.fields[k], "payload");
      const r = this.def(`milo.enum.field_ref ${dst}[${v.tag}, ${k}] : !milo.ref<${ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`).ref;
      if (valueType(this.cx, v.fields[k]) === null) this.into(a, r, fty);
      else {
        const x = this.consume(this.expr(a), "payload");
        if (x.ty !== fty) throw new MlirUnsupported("payload of another type");
        this.emit(`milo.store ${x.ref}, ${r} init : !milo.ref<${fty}>`);
      }
      if (this.hasDrop(fty)) this.pending++;
    });
    this.pending = mark;
  }

  /**
   * `v` as a fn value of type `ty` when the two differ only in owning (milo.fn.cast): a
   * plain one may always become owning (its drop frees nothing); an owned one becomes
   * plain only where `leak` says legacy stores it with nobody to free it (a field).
   */
  private fnAs(v: Val, ty: string, leak = false): Val {
    if (v.ty === ty || !v.ty.startsWith("!milo.fn<") || !ty.startsWith("!milo.fn<")) return v;
    const plain = (t: string) => t.replace(/^!milo\.fn<owning /, "!milo.fn<");
    if (plain(v.ty) !== plain(ty)) return v;
    const toOwning = ty.startsWith("!milo.fn<owning ");
    if (!toOwning && !(leak && v.own === "owned")) return v;
    return { ...this.def(`milo.fn.cast ${v.ref} : ${v.ty} -> ${ty}`, ty), own: toOwning ? "owned" : undefined };
  }

  /** `[T; N]` where a `*T` is wanted (a cast, a pointer argument): the array's address, as legacy. */
  private decay(e: HIRExpr): Val {
    const p = this.fieldPlace(e);
    if (!p || !p.ty.startsWith("!milo.array<")) throw new MlirUnsupported("pointer to an array that is not a place");
    return this.def(`milo.addr ${p.ref} : !milo.ref<${p.ty}>`, PTR);
  }

  /**
   * An array literal written into the array place `dst`, element by element: `[a, b]`
   * evaluates and stores each in turn, as legacy genArrayLit; `[v; n]` evaluates `v` once
   * and stores it n times in a loop (LLVM makes a memset of a zero one, as legacy's
   * zeroinitializer is).
   */
  private arrayInto(e: HIRExpr & { kind: "ArrayLit" | "ArrayRepeat" }, dst: string, ty: string): void {
    const t = e.type as TypeKind & { tag: "array" };
    const ety = this.value(t.element, "array element");
    const at = (i: string) => this.def(`milo.array.index ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${ety}>`, `!milo.ref<${ety}>`, this.loc(e.span)).ref;
    if (e.kind === "ArrayLit") {
      if (e.elements.length !== t.size) throw new MlirUnsupported("array literal of another size");
      e.elements.forEach((x, k) => {
        const v = this.consume(this.expr(x), "array element");
        if (v.ty !== ety) throw new MlirUnsupported("array element of another type");
        const r = at(this.def(`milo.const ${k} : si64`, "si64").ref);
        this.emit(`milo.store ${v.ref}, ${r} init : !milo.ref<${ety}>`);
      });
      return;
    }
    if (e.cloneFn || e.count !== t.size) throw new MlirUnsupported("array repeat of an owning value");
    const v = this.expr(e.value);
    if (v.ty !== ety) throw new MlirUnsupported("array element of another type");
    const lo = this.def("milo.const 0 : si64", "si64").ref;
    const hi = this.def(`milo.const ${e.count} : si64`, "si64").ref;
    const iv = this.fresh();
    this.region(`milo.for ${lo} to ${hi} : si64 {`, () => {
      this.emit(`^bb0(${iv}: si64):`);
      this.emit(`milo.store ${v.ref}, ${at(iv)} init : !milo.ref<${ety}>`);
      return false;
    });
    this.emit("}");
  }

  /**
   * The place `e` (128+ bytes, of type `ty`) is read out of for a milo.copy, or null when
   * `e` is not a place: a local, a field of a place, or memory behind a raw pointer (whose
   * bits the copy owns, as ptrRead's do). An owning local gives its value up only as the
   * checker's move of it: `done` then empties its slot, after the copy.
   */
  private bigPlace(e: HIRExpr, ty: string): { ref: string; refTy: string; done: () => void } | null {
    const none = () => {};
    if (e.kind === "Ident" || e.kind === "FieldAccess") {
      const pp = e.kind === "FieldAccess" ? this.ptrPlace(e) : null;
      if (pp) return pp.ty === ty ? { ref: pp.ptr, refTy: PTR, done: none } : null;
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b && b.kind !== "var") return null;
      if (b && this.hasDrop(ty)) {
        if (b.ty !== ty || !b.owned || !e.isMove) throw new MlirUnsupported("128+ byte copy that is not a move of a local");
        return { ref: b.ref, refTy: `!milo.ref<${ty}>`, done: () => { this.def(`milo.move ${b.ref} : !milo.ref<${ty}>`, ty); } };
      }
      if (!b && this.hasDrop(ty)) {
        // Moved out of a local's field: zeroed behind the copy, as moveField does.
        if (e.kind !== "FieldAccess" || !e.isMove || !this.fieldOfOwnedLocal(e)) throw new MlirUnsupported("move out of a field");
        const p = this.fieldPlace(e)!;
        if (p.ty !== ty) return null;
        return { ref: p.ref, refTy: `!milo.ref<${ty}>`, done: () => {
          this.emit(`milo.store ${this.def(`milo.zero : ${ty}`, ty).ref}, ${p.ref} init : !milo.ref<${ty}>`);
        } };
      }
      const p = this.fieldPlace(e);
      return p && p.ty === ty ? { ref: p.ref, refTy: `!milo.ref<${ty}>`, done: none } : null;
    }
    if (e.kind === "PtrDeref") {
      const pp = this.ptrPlace(e)!;
      return pp.ty === ty ? { ref: pp.ptr, refTy: PTR, done: none } : null;
    }
    if (e.kind === "IndexAccess") {
      const pp = this.ptrPlace(e);
      if (pp) return pp.ty === ty ? { ref: pp.ptr, refTy: PTR, done: none } : null;
      // A Vec element: legacy deep-copies an owning one, which no place copy is.
      if (this.hasDrop(ty)) throw new MlirUnsupported("deep copy of a 128+ byte element");
      const er = this.elemRef(e);
      return er && er.ty === ty ? { ref: er.ref, refTy: `!milo.ref<${ty}>`, done: none } : null;
    }
    return null;
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
      if (this.hasDrop(ty) && !(b.owned && e.isMove)) throw new MlirUnsupported("128+ byte argument that is not a move");
      slot = { ref: b.ref, owned: !!b.owned };
    } else slot = this.bigSlot("arg", e, true);
    const op = this.hasDrop(ty) ? "milo.move" : "milo.load";
    return { ...this.def(`${op} ${slot.ref} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /** A slot of this block holding `e` (128+ bytes), filled in place; owned when it has drop glue. */
  private bigSlot(name: string, e: HIRExpr, temp = false): { ref: string; ty: string; owned: boolean } {
    const ty = this.place$(e.type, "value");
    const owned = this.hasDrop(ty);
    let ref: string;
    if (owned) ref = temp ? this.tempSlot(name, ty, e.type) : this.ownedSlot(name, ty, e.type);
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
  private retPlaceOnly = false;
  // Set by into() for the call it is about to emit: its place-only result may be an SSA
  // value, the ABI's, stored straight into the destination.
  private abiResult = false;

  /** valueType, or for a place-only type the SSA value an ABI passes (a by-value result). */
  private abiValue(t: TypeKind, what: string): string {
    return valueType(this.cx, t) ?? this.place$(t, what);
  }

  /** placeType, or the reason the function stays legacy. */
  private place$(t: TypeKind, what: string): string {
    const v = placeType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${blocker(this.cx, t)}`);
    return v;
  }

  /** The type of what memory behind a pointer holds: a value's, or a 128+ byte place's. */
  private memType(t: TypeKind, what: string): string {
    return valueType(this.cx, t) ?? this.place$(t, what);
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
    // Its place, not an owned slot: nothing here may move out of it or drop it at a scope end.
    const ty = this.place$(g.type, "global");
    const ref = this.def(`milo.global ${quote(name)}${g.threadLocal ? " thread_local" : ""} : !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
    return { kind: "var", ref, ty };
  }

  /** `name` is a module global here: no local binding shadows it. */
  private isGlobal(name: string): boolean {
    return !this.scopes.some(m => m.has(name)) && this.cx.mlirGlobal(name) !== null;
  }

  private loc(span: Span | undefined): string {
    // Inside a @trackCaller copy every panic names the call site, as legacy panicAt.
    const l = this.cx.checkLocation(this.fn.trackedCaller ?? span);
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
    if (v && this.hasDrop(v.ty) && v.own === "view") throw new MlirUnsupported("a borrowed value leaving its scope");
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

  /**
   * A slot for a temporary. A user's Drop on it would run at the end of the block, where
   * legacy runs it after the call or at the end of the statement: those stay legacy.
   */
  private tempSlot(name: string, ty: string, t: TypeKind, arg = false): string {
    if (this.runsUserDrop(ty) && !arg) throw new MlirUnsupported("temporary with a user Drop");
    return this.ownedSlot(name, ty, t);
  }

  /**
   * A direct call in a block of its own: the temporaries its arguments lend from die right
   * after it, before its result is used, as legacy drops an argument temporary after its
   * call (argTempDrops). That timing is what lets one with a user Drop be taken.
   */
  private callScope(fill: () => Val): Val {
    this.owned.push([]);
    const start = this.body.length;
    const v = fill();
    return this.closeScope(start, false, v.ty ? v : null) ?? v;
  }

  // Set while place() lends a by-ref argument of the call being emitted: its temporary is
  // in that call's scope (callScope), so a user Drop on it runs when legacy runs it.
  private lendingArg = false;

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

  // Owned operands evaluated and not yet handed to their op (`tok()` in
  // `take(tok(), match o { None => return 0, ... })`): SSA values, so no scope drops them on
  // a jump out of a later operand. Legacy drops them (its pend.temps); here such a jump
  // keeps the function legacy.
  private pending = 0;
  private pend(v: Val): Val {
    if (this.hasDrop(v.ty) && v.own === "owned") this.pending++;
    return v;
  }
  private noPending(): void {
    if (this.pending > 0) throw new MlirUnsupported("jump out of an expression with an owned operand pending");
  }

  /** `v` where it is consumed (stored, passed or returned by value): it must own itself. */
  private consume(v: Val, what: string): Val {
    if (this.hasDrop(v.ty) && v.own === "view") throw new MlirUnsupported(`${what} copies a borrowed value`);
    return v;
  }

  /**
   * `v` where it is only read: a temporary that owns a buffer goes into a slot of the
   * innermost block, which drops it when the block ends, and is read in place from there.
   */
  private borrow(v: Val, t: TypeKind): Val {
    if (!this.hasDrop(v.ty) || v.own !== "owned") return v;
    if (this.bitCopies.has(v.ref)) return { ...v, own: "view" };
    const slot = this.tempSlot("tmp", v.ty, t);
    this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
    return { ...this.def(`milo.load ${slot} : !milo.ref<${v.ty}>`, v.ty), own: "view" };
  }

  /** True when the statements end in a jump: whatever follows is dead. */
  private stmts(body: HIRStmt[]): boolean {
    for (const s of body) if (this.stmt(s)) return true;
    return false;
  }

  private stmt(s: HIRStmt): boolean {
    if (s.kind !== "Assign" && s.kind !== "ExprStmt") return this.stmtIn(s);
    // Its temporaries die at its end, as legacy drops them: a block's end may never come
    // (an exit() later in it), and the live-block count at exit would see them.
    this.owned.push([]);
    const start = this.body.length;
    const jumped = this.stmtIn(s);
    this.closeScope(start, jumped, null);
    return jumped;
  }

  private stmtIn(s: HIRStmt): boolean {
    switch (s.kind) {
      case "Let": {
        if (s.viewBind) {
          // The checker proved nobody can tell the element from a clone: the binding is
          // the element's place, as legacy binds its address (no copy, nothing to drop).
          const er = s.value.kind === "IndexAccess" ? this.elemRef(s.value) : null;
          if (!er) throw new MlirUnsupported("view let");
          this.bind(s.name, { kind: "var", ref: er.ref, ty: er.ty });
          return false;
        }
        const pt = placeType(this.cx, s.type);
        if (pt !== null && isBig(this.cx, pt)) {
          const b = this.bigSlot(s.name, s.value);
          this.bind(s.name, { kind: "var", ref: b.ref, ty: b.ty, owned: b.owned });
          return false;
        }
        const ty = this.value(s.type, "let");
        // The value's temporaries die at the end of the statement; the binding's slot is the block's.
        const v = this.scoped(() => this.consume(this.expr(s.value), "let"));
        if (v.ty !== ty) throw new MlirUnsupported("let of a different type");
        if (this.hasDrop(ty)) {
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
        // The value first, then the place: legacy genStmt Assign's order.
        if (s.target.kind === "IndexAccess" || s.target.kind === "FieldAccess" || s.target.kind === "PtrDeref" || s.target.kind === "HeapDeref") {
          const big = placeType(this.cx, s.target.type);
          if (big !== null && valueType(this.cx, s.target.type) === null) {
            // A 128+ byte one, as legacy: the value into a place of its own first (or a
            // local's slot), then copied. Through a pointer nothing is dropped.
            const src = this.bigPlace(s.value, big) ?? (() => {
              const sl = this.bigSlot("tmp", s.value, true);
              return { ref: sl.ref, refTy: `!milo.ref<${big}>`, done: () => { if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${big}>`, big); } };
            })();
            const pp = this.ptrPlace(s.target);
            if (!pp || pp.ty !== big) throw new MlirUnsupported("128+ byte store other than through a pointer");
            this.emit(`milo.copy ${src.ref}, ${pp.ptr} : ${src.refTy}, ${PTR} of ${big}`);
            src.done();
            return false;
          }
          // Through a raw pointer: the value is stored as is, nothing is dropped (unsafe).
          const v = this.consume(this.expr(s.value), "store through a pointer");
          const pp = this.ptrPlace(s.target);
          if (pp) {
            if (v.ty !== pp.ty) throw new MlirUnsupported("store through a pointer of another type");
            this.emit(`milo.ptr.store ${v.ref}, ${pp.ptr} : ${pp.ty}`);
            return false;
          }
          if (s.target.kind === "PtrDeref") throw new MlirUnsupported("store through a pointer of another type");
          if (s.target.kind === "FieldAccess" || s.target.kind === "HeapDeref") {
            const p = this.fieldPlace(s.target);
            if (!p) throw new MlirUnsupported("assign to a field of a value");
            if (v.ty !== p.ty) throw new MlirUnsupported("field store of another type");
            // Legacy never drops what `*h = v` overwrites (its Assign drops only through an
            // Ident, a field or an element): dropping it here would change the leak count.
            if (s.target.kind === "HeapDeref" && this.hasDrop(p.ty)) throw new MlirUnsupported("store over an owning boxed value");
            // milo-scope-drops drops the old value before the store: its glue must exist.
            if (this.hasDrop(p.ty)) this.dropGlue(p.ty, s.target.type);
            this.emit(`milo.store ${v.ref}, ${p.ref} : !milo.ref<${p.ty}>`);
            return false;
          }
          const er = this.elemRef(s.target);
          if (er) {
            // milo-scope-drops drops the old element before the store, as legacy does.
            if (v.ty !== er.ty) throw new MlirUnsupported("element store of another type");
            if (this.hasDrop(er.ty)) this.dropGlue(er.ty, s.target.type);
            this.emit(`milo.store ${v.ref}, ${er.ref} : !milo.ref<${er.ty}>`);
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
        if (this.hasDrop(b.ty) && !s.isInit) this.dropGlue(b.ty, s.target.type);
        this.emit(`milo.store ${v.ref}, ${b.ref}${s.isInit ? " init" : ""} : !milo.ref<${b.ty}>`);
        return false;
      }
      case "Return": {
        this.noPending();
        if (this.sretOut && s.value) {
          this.into(s.value, this.sretOut.ref, this.sretOut.ty);
          this.ret("milo.return");
          return true;
        }
        if (!s.value && this.isMain) { this.retMain(); return true; }
        if (!s.value) { this.ret("milo.return"); return true; }
        if (s.value.type.tag === "void" && this.retTy === null && !this.isMain) {
          // `return f()` of a void f, an expression-bodied `(): void => f()`: the call as
          // a statement, then the return, as legacy emits it.
          if (this.stmt({ kind: "ExprStmt", expr: s.value, span: s.span })) return true;
          this.ret("milo.return");
          return true;
        }
        // A place-only result returned by value (an array, a struct holding one, under 128
        // bytes so not sret): loaded whole from its place at the return, legacy's ABI.
        const v = this.retPlaceOnly ? this.bigArg(s.value, this.retTy!) : this.consume(this.expr(s.value), "return");
        if (v.ty !== this.retTy) throw new MlirUnsupported("return of a different type");
        this.ret(`milo.return ${v.ref} : ${v.ty}`);
        return true;
      }
      case "ExprStmt": {
        if (this.isSretCall(s.expr)) { this.bigSlot("tmp", s.expr, true); return false; }
        if (this.diverges(s.expr)) {
          // `exit(…)` and friends do not return: the path ends here, as for a jump.
          this.expr(s.expr, true);
          this.emit("milo.unreachable");
          return true;
        }
        const v = this.expr(s.expr, true);
        if (v.ty && this.runsUserDrop(v.ty) && v.own === "owned") {
          // A result nobody takes runs its user Drop at the end of the statement, as
          // legacy drops it: a slot of a block of its own, closed right here.
          this.owned.push([]);
          const start = this.body.length;
          const slot = this.ownedSlot("discarded", v.ty, s.expr.type);
          this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
          this.closeScope(start, false, null);
          return false;
        }
        // A result nobody takes still has an owner until the block ends.
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
      case "ForEach": {
        // `for x in v` over a Vec place, as legacy genForEach: data and len read once,
        // then each element by index. The element is read at the top of each iteration,
        // where legacy reads it through its address at each use: the same, since the
        // checker lets nothing write the Vec while the loop borrows it. The index moves
        // on before the body, so a `continue` (back to the condition) cannot skip it.
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        if (s.consume && s.iterableKind === "vec") return this.consumedForEach(s);
        if (s.iterableKind === "array") return this.arrayForEach(s);
        if ((s.iterableKind !== "vec" && s.iterableKind !== "string") || s.consume) throw new MlirUnsupported(`for over a ${s.consume ? "consumed " : ""}${s.iterableKind}`);
        const elemKind = s.varName2 ? s.varType2! : s.varType;
        if (elemKind.tag === "ref" && elemKind.mutable) throw new MlirUnsupported("for over &mut elements");
        let place = "", elem: string, data: string, len: string, byPlace = false;
        if (s.iterableKind === "string") {
          // `for b in s`: its bytes, data and len read once (genForEach's string case).
          const v = this.borrow(this.expr(s.iterable), s.iterable.type);
          elem = "ui8";
          if (v.ty !== STR || valueType(this.cx, stripRefs(elemKind)) !== elem) throw new MlirUnsupported("for over a string of another element type");
          data = this.def(`milo.string.data ${v.ref}`, PTR).ref;
          len = this.def(`milo.string.len ${v.ref}`, "si64").ref;
        } else {
          ({ place, elem } = this.vecPlace(s.iterable));
          // A place-only element (128+ bytes, an array) is bound as its place, never loaded.
          // So is one holding an array, even when small enough to be a value elsewhere.
          byPlace = (valueType(this.cx, stripRefs(elemKind)) === null || isBig(this.cx, elem)) && placeType(this.cx, stripRefs(elemKind)) === elem;
          if (!byPlace && (isBig(this.cx, elem) || valueType(this.cx, stripRefs(elemKind)) !== elem)) throw new MlirUnsupported("for element type");
          data = this.def(`milo.vec.data ${place} : !milo.vec<${elem}>`, PTR).ref;
          len = this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64").ref;
        }
        const idx = this.fresh();
        this.vars.push(`  ${idx} = milo.var "for.idx" : !milo.ref<si64>`);
        this.emit(`milo.store ${this.def("milo.const 0 : si64", "si64").ref}, ${idx} : !milo.ref<si64>`);
        this.loops++;
        this.region("milo.while {", () => {
          const i = this.def(`milo.load ${idx} : !milo.ref<si64>`, "si64").ref;
          this.emit(`milo.condition ${this.def(`milo.cmp lt, ${i}, ${len} : si64`, "i1").ref}`);
          return true;
        });
        this.region("} do {", () => {
          const i = this.def(`milo.load ${idx} : !milo.ref<si64>`, "si64").ref;
          const one = this.def("milo.const 1 : si64", "si64").ref;
          this.emit(`milo.store ${this.def(`milo.add ${i}, ${one} wrapping : si64`, "si64").ref}, ${idx} : !milo.ref<si64>`);
          if (byPlace) {
            // In bounds by the condition, and nothing writes the Vec while the loop borrows it.
            const r = this.def(`milo.index.ref ${place}[${i}] : !milo.vec<${elem}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`, this.loc(s.span)).ref;
            this.bind(s.varName2 ?? s.varName, { kind: "var", ref: r, ty: elem });
          } else {
            const ep = this.def(`milo.ptr.elem ${data}[${i}] : ${elem}`, PTR).ref;
            const x = this.def(`milo.ptr.load ${ep} : ${elem}`, elem);
            this.bind(s.varName2 ?? s.varName, { kind: "ssa", v: { ...x, own: this.hasDrop(elem) ? "view" : undefined } });
          }
          if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: i, ty: "si64" } });
          return this.stmts(s.body);
        });
        this.emit("}");
        this.loops--;
        return false;
      }
      case "ForRange": {
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        const ty = scalar(s.varType, "for var");
        if (ty === "i1" || ty === PTR || ty.startsWith("f")) throw new MlirUnsupported("for over a non-int");
        // Legacy genForRange extends a bound of another width by the loop variable's
        // signedness, not the bound's (a u32 bound of an i64 loop is sign extended), so the
        // bound's bits are first read as that signedness, then extended.
        const widen = (v: Val): Val => {
          if (v.ty === ty) return v;
          const vm = /^[su]i(\d+)$/.exec(v.ty), tm = /^([su])i(\d+)$/.exec(ty)!;
          if (!vm || Number(vm[1]) > Number(tm[2])) throw new MlirUnsupported("for bound of a different type");
          const same = `${tm[1]}i${vm[1]}`;
          const r = same === v.ty ? v : this.def(`milo.cast ${v.ref} : ${v.ty} to ${same}`, same);
          return same === ty ? r : this.def(`milo.cast ${r.ref} : ${same} to ${ty}`, ty);
        };
        const start = widen(this.expr(s.start));
        const end = widen(this.expr(s.end));
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
        this.noPending();
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

  /**
   * `for x in makeVec()`: the loop owns the Vec (legacy genConsumedIterable). It lives in a
   * vectail slot of a block around the loop, and each iteration moves its element out into
   * the binding (an owned slot of the body when it has drop glue) and moves the cursor past
   * it, so whichever way control leaves, the slot's drop frees exactly the elements no
   * iteration took, then the buffer, after the binding's drop as legacy orders them.
   */
  /**
   * `h.m(args)` through a `Heap<I>`: legacy's itable dispatch (genInterfaceMethodCall) in a
   * helper per interface, method and operand shape, the box lent by its place. Arguments
   * are scalars by value or places lent as the callee's `&T`; a string result is owned.
   */
  private dynCall(e: HIRExpr & { kind: "InterfaceMethodCall" }): Val {
    const ot = stripRefs(e.object.type);
    if (ot.tag !== "heap" || ot.inner.tag !== "interface") throw new MlirUnsupported("interface call on a borrowed interface");
    const p = this.fieldPlace(e.object);
    const dty = this.place$(ot, "interface box");
    if (!p || p.ty !== dty) throw new MlirUnsupported("interface call on a box that is not a place");
    const ops: { name: string; type: TypeKind; mode: "val" | "ref" | "mut"; ref: string }[] = [{ name: "o", type: ot, mode: "ref", ref: p.ref }];
    const mark = this.pending;
    e.args.forEach((a, k) => {
      const t = stripRefs(a.expr.type);
      if (a.passByRef) {
        const ty = this.place$(t, "interface call operand");
        ops.push({ name: `a${k}`, type: t, mode: a.refMut ? "mut" : "ref", ref: this.place(a.expr, refOf(ty), a.refMut).ref });
        return;
      }
      const v = this.pend(this.expr(a.expr));
      if (!isScalarTy(v.ty) && v.ty !== PTR) throw new MlirUnsupported(`interface call argument of type ${t.tag}`);
      ops.push({ name: `a${k}`, type: t, mode: "val", ref: v.ref });
    });
    this.pending = mark;
    const ret = e.type.tag === "void" ? null : this.value(e.type, "interface call result");
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && ret !== STR) throw new MlirUnsupported("interface call result type");
    const r = this.intrinsic(`dyn${e.methodIndex}`, e, ops, ([o, ...xs]) => ({
      ...e, object: o, args: e.args.map((a, k) => ({ ...a, expr: xs[k] })),
    }), ret, false);
    return ret === STR ? { ...r, own: "owned" } : r;
  }

  /**
   * `f as *u8`, in a legacy helper doing exactly that (genCast): a named function's own
   * symbol, not its trampoline, and any other fn value's code pointer, its first field.
   */
  private fnAddress(e: HIRExpr & { kind: "Cast" }): Val {
    const op = e.operand;
    const named = op.kind === "Ident" && !this.scopes.some(m => m.has(op.name)) && this.cx.fnSigs.has(op.name);
    if (named) {
      const name = this.cx.mlirHelper(`milo.fnaddr.${op.name}`, () => ({
        params: [], retType: e.type, body: [{ kind: "Return", retType: e.type, value: e }],
      }));
      this.callees.set(name, `() -> ${PTR}`);
      return this.def(`func.call @${quote(name)}() : () -> ${PTR}`, PTR);
    }
    const v = this.expr(op);
    if (v.own === "owned") throw new MlirUnsupported("cast of an owning fn temporary");
    return this.intrinsic("fnaddr", e, [{ name: "f", type: op.type, mode: "val", ref: v.ref }],
      ([f]) => ({ ...e, operand: f }), PTR, false);
  }

  private arrayForEach(s: HIRStmt & { kind: "ForEach" }): boolean {
    /**
     * `for x in arr` over a fixed array of elements that own nothing, as legacy genForEach:
     * a consumed one (`for i in [0, 1, 5]`, a call) evaluated into a slot first, a place
     * borrowed where it is; the binding is the element's place, which nothing writes while
     * the loop runs, so reading it at each use is reading legacy's copy.
     */
    const at = stripRefs(s.iterable.type);
    const elemKind = s.varName2 ? s.varType2! : s.varType;
    if (at.tag !== "array" || at.size === null) throw new MlirUnsupported("for over a slice");
    if (elemKind.tag === "ref" && elemKind.mutable) throw new MlirUnsupported("for over &mut elements");
    const aty = this.place$(at, "for array");
    const ety = this.place$(at.element, "for element");
    if (placeType(this.cx, stripRefs(elemKind)) !== ety) throw new MlirUnsupported("for element type");
    const scopeStart = this.body.length;
    this.scopes.push(new Map());
    this.owned.push([]);
    try {
      let arr: string;
      if (s.consume) arr = this.bigSlot("for.arr", s.iterable).ref;
      else {
        const p = this.fieldPlace(s.iterable);
        if (!p || p.ty !== aty) throw new MlirUnsupported("for over an array that is not a place");
        arr = p.ref;
      }
      const zero = this.def("milo.const 0 : si64", "si64").ref;
      const n = this.def(`milo.const ${at.size} : si64`, "si64").ref;
      const iv = this.fresh();
      this.loops++;
      this.region(`milo.for ${zero} to ${n} : si64 {`, () => {
        this.emit(`^bb0(${iv}: si64):`);
        const r = this.def(`milo.array.index ${arr}[${iv}] : !milo.ref<${aty}> -> !milo.ref<${ety}>`, `!milo.ref<${ety}>`, this.loc(s.span)).ref;
        this.bind(s.varName2 ?? s.varName, { kind: "var", ref: r, ty: ety });
        if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty: "si64" } });
        return this.stmts(s.body);
      });
      this.emit("}");
      this.loops--;
      this.closeScope(scopeStart, false, null);
      return false;
    } finally { this.scopes.pop(); }
  }

  private consumedForEach(s: HIRStmt & { kind: "ForEach" }): boolean {
    const vt = stripRefs(s.iterable.type);
    const elemKind = stripRefs(s.varName2 ? s.varType2! : s.varType);
    if (vt.tag !== "vec") throw new MlirUnsupported("for over a consumed vec of another type");
    const elem = placeType(this.cx, elemKind);
    if (elem === null || elem !== placeType(this.cx, vt.element)) throw new MlirUnsupported("for over a consumed vec of another element type");
    // A place-only element is copied out of its place into the binding's slot, as legacy's
    // emitConsumeElement memcpys it.
    const byPlace = valueType(this.cx, elemKind) === null;
    const vecTy = `!milo.vecval<${elem}>`, tailTy = `!milo.vectail<${elem}>`;
    this.owned.push([]);
    const start = this.body.length;
    const v = this.consume(this.expr(s.iterable), "consumed for-in");
    if (v.ty !== vecTy) throw new MlirUnsupported("for over a consumed vec of another type");
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "for.vec" owned : !milo.ref<${tailTy}>`);
    this.owned[this.owned.length - 1].push({ ref: slot, ty: tailTy });
    this.cx.mlirVecTailDropHelper(typeKey(vt.element), vt);
    this.emit(`milo.vectail.init ${v.ref}, ${slot} : ${vecTy}, !milo.ref<${tailTy}>`);
    this.emit(`milo.filled ${slot} : !milo.ref<${tailTy}>`);
    const hdr = this.def(`milo.vectail.vec ${slot} : !milo.ref<${tailTy}> -> !milo.vec<${elem}>`, `!milo.vec<${elem}>`).ref;
    const len = this.def(`milo.len ${hdr} : !milo.vec<${elem}>`, "si64").ref;
    const idx = this.fresh();
    this.vars.push(`  ${idx} = milo.var "for.idx" : !milo.ref<si64>`);
    this.emit(`milo.store ${this.def("milo.const 0 : si64", "si64").ref}, ${idx} : !milo.ref<si64>`);
    this.loops++;
    this.region("milo.while {", () => {
      const i = this.def(`milo.load ${idx} : !milo.ref<si64>`, "si64").ref;
      this.emit(`milo.condition ${this.def(`milo.cmp lt, ${i}, ${len} : si64`, "i1").ref}`);
      return true;
    });
    this.region("} do {", () => {
      const i = this.def(`milo.load ${idx} : !milo.ref<si64>`, "si64").ref;
      const one = this.def("milo.const 1 : si64", "si64").ref;
      this.emit(`milo.store ${this.def(`milo.add ${i}, ${one} wrapping : si64`, "si64").ref}, ${idx} : !milo.ref<si64>`);
      const name = s.varName2 ?? s.varName;
      if (byPlace) {
        const from = this.def(`milo.vectail.take_place ${slot}[${i}] : !milo.ref<${tailTy}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`).ref;
        const own = this.hasDrop(elem);
        let to: string;
        if (own) to = this.ownedSlot(name, elem, elemKind);
        else {
          to = this.fresh();
          this.vars.push(`  ${to} = milo.var ${quote(name)} : !milo.ref<${elem}>`);
        }
        this.emit(`milo.copy ${from}, ${to} : !milo.ref<${elem}>, !milo.ref<${elem}> of ${elem}`);
        if (own) this.emit(`milo.filled ${to} : !milo.ref<${elem}>`);
        this.bind(name, { kind: "var", ref: to, ty: elem, owned: own });
        if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: i, ty: "si64" } });
        return this.stmts(s.body);
      }
      const x = this.def(`milo.vectail.take ${slot}[${i}] : !milo.ref<${tailTy}> -> ${elem}`, elem);
      if (this.hasDrop(elem)) {
        const own = this.ownedSlot(name, elem, elemKind);
        this.emit(`milo.store ${x.ref}, ${own} : !milo.ref<${elem}>`);
        this.bind(name, { kind: "var", ref: own, ty: elem, owned: true });
      } else {
        this.bind(name, { kind: "ssa", v: x });
      }
      if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: i, ty: "si64" } });
      return this.stmts(s.body);
    });
    this.emit("}");
    this.loops--;
    this.closeScope(start, false, null);
    return false;
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
        let p = this.fieldPlace(e.str);
        if (!p && e.str.kind === "FieldAccess") {
          // A string field of a value read in place (a for-in element, a by-value
          // binding): its bits into a slot that drops nothing, shared from there.
          const v = this.expr(e.str);
          if (v.ty !== STR || v.own !== "view") throw new MlirUnsupported("string copy of a temporary");
          const ref = this.fresh();
          this.vars.push(`  ${ref} = milo.var "view" : !milo.ref<${STR}>`);
          this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${STR}>`);
          p = { ref, ty: STR };
        }
        if (!p || p.ty !== STR) throw new MlirUnsupported("string copy of a temporary");
        this.cx.mlirHelper("milo.share.string", () => ({
          params: [{ name: "s", type: { tag: "string" }, isRef: true, isRefMut: false }],
          retType: { tag: "string" },
          body: [{ kind: "Return", retType: { tag: "string" }, value: {
            kind: "StringClone", type: { tag: "string" }, str: { kind: "Ident", name: "s", type: { tag: "string" }, isMove: false } } }],
        }));
        return { ...this.def(`milo.string.share ${p.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      }
      case "InterfaceMethodCall": return this.dynCall(e);
      case "StringSlice": {
        // `s[a..b]`, legacy's genStringSlice in a helper: a `&string` view into s's buffer
        // (data and len, nothing owned), range-checked. Only a place's string, which
        // outlives the view; never a temporary.
        if (e.str.kind !== "Ident" && e.str.kind !== "FieldAccess") throw new MlirUnsupported("slice of a temporary string");
        const s = this.place(e.str, refOf(STR), false).ref;
        const a = this.expr(e.start), b = this.expr(e.end);
        if (!isScalarTy(a.ty) || !isScalarTy(b.ty)) throw new MlirUnsupported("slice bound type");
        const r = this.intrinsic("strslice", e, [
          { name: "s", type: stripRefs(e.str.type), mode: "ref", ref: s },
          { name: "a", type: e.start.type, mode: "val", ref: a.ref },
          { name: "b", type: e.end.type, mode: "val", ref: b.ref }],
        ([x, y, z]) => ({ ...e, str: x, start: y, end: z }), STR);
        return { ...r, own: "view" };
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
        if (b.kind === "var" && isBig(this.cx, b.ty) && valueType(this.cx, e.type) !== b.ty) throw new MlirUnsupported("a 128+ byte aggregate as a value");
        if (!this.hasDrop(b.ty)) return this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
        // The checker marks the last use that takes the value; every other read borrows.
        if (!e.isMove) return { ...this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "view" };
        if (!b.owned) throw new MlirUnsupported("move out of a borrow");
        return { ...this.def(`milo.move ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "owned" };
      }
      case "BinOp": return this.binop(e);
      case "UnaryOp": return this.unop(e);
      case "Cast": {
        if (e.operand.type.tag === "array" && e.targetType.tag === "ptr") return this.decay(e.operand);
        if (stripRefs(e.operand.type).tag === "string" && e.targetType.tag === "ptr") {
          // `s as *u8`: the bytes, as legacy genCast reads field 0 (no copy, no NUL).
          const v = this.borrow(this.expr(e.operand), e.operand.type);
          if (v.ty !== STR) throw new MlirUnsupported("cast of a non-string");
          return this.def(`milo.string.data ${v.ref}`, PTR);
        }
        if (e.operand.type.tag === "fn" && e.targetType.tag === "ptr") return this.fnAddress(e);
        const from = scalar(e.operand.type, "cast source");
        const to = scalar(e.targetType, "cast target");
        const v = this.expr(e.operand);
        if (v.ty !== from) throw new MlirUnsupported("cast operand type");
        if (from === to) return v;
        if ((from === PTR && to.startsWith("f")) || (to === PTR && from.startsWith("f"))) throw new MlirUnsupported("cast between a pointer and a float");
        return this.def(`milo.cast ${v.ref} : ${from} to ${to}`, to);
      }
      case "Call": return this.callScope(() => this.call(e, stmt));
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
        const er = this.elemRef(e);
        if (er) {
          if (placeOnly.get(this.cx)?.has(er.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
          if (!this.hasDrop(er.ty)) return this.def(`milo.load ${er.ref} : !milo.ref<${er.ty}>`, er.ty);
          // Legacy clones an owning element (emitDeepCloneFromPtr): `v[i]` is always an
          // independent value, and the Vec keeps its own.
          return this.copyOut(e, er.ref, er.ty, true);
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
      // std/string's intrinsics, each a legacy function doing exactly it (genStrReserve,
      // emitStrAlloc, emitStringRangeCheck, emitStrUnique, genNumberToString).
      case "StrReserve": {
        if (scalar(e.type, "reserved buffer") !== PTR) throw new MlirUnsupported("string reserve type");
        const str = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const n = this.expr(e.extra);
        if (n.ty !== "si64") throw new MlirUnsupported("string reserve size type");
        return this.intrinsic("reserve", e, [{ name: "s", type: { tag: "string" }, mode: "mut", ref: str }, { name: "n", type: I64, mode: "val", ref: n.ref }],
          ([a, b]) => ({ kind: "StrReserve", type: e.type, span: e.span, str: a, extra: b }), PTR);
      }
      case "StrAlloc": {
        if (scalar(e.type, "string buffer") !== PTR) throw new MlirUnsupported("string alloc type");
        const n = this.expr(e.size);
        if (n.ty !== "si64") throw new MlirUnsupported("string alloc size type");
        return this.intrinsic("alloc", e, [{ name: "n", type: I64, mode: "val", ref: n.ref }],
          ([a]) => ({ kind: "StrAlloc", type: e.type, span: e.span, size: a }), PTR);
      }
      case "StrRangeCheck": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, false).ref;
        const a = this.expr(e.start), b = this.expr(e.end);
        if (a.ty !== "si64" || b.ty !== "si64") throw new MlirUnsupported("string range types");
        return this.intrinsic("range", e, [{ name: "s", type: { tag: "string" }, mode: "ref", ref: str },
          { name: "a", type: I64, mode: "val", ref: a.ref }, { name: "b", type: I64, mode: "val", ref: b.ref }],
          ([x, y, z]) => ({ kind: "StrRangeCheck", type: e.type, span: e.span, str: x, start: y, end: z }), null);
      }
      case "StrUnique": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        return this.intrinsic("unique", e, [{ name: "s", type: { tag: "string" }, mode: "mut", ref: str }],
          ([x]) => ({ kind: "StrUnique", type: e.type, span: e.span, str: x }), null);
      }
      case "MapHash": {
        const kt = stripRefs(e.key.type);
        const k = this.place(e.key, refOf(this.value(kt, "map key")), false).ref;
        const seed = this.expr(e.seed);
        if (seed.ty !== "si64") throw new MlirUnsupported("map seed type");
        return this.intrinsic("maphash", e, [{ name: "k", type: kt, mode: "ref", ref: k }, { name: "s", type: I64, mode: "val", ref: seed.ref }],
          ([a, b]) => ({ kind: "MapHash", type: e.type, span: e.span, key: a, seed: b }), scalar(e.type, "map hash"), false);
      }
      case "MapKeyEq":
      case "NatLess": {
        const kt = stripRefs(e.a.type);
        const rt = refOf(this.value(kt, "compared key"));
        const a = this.place(e.a, rt, false).ref, b = this.place(e.b, rt, false).ref;
        const kind = e.kind;
        return this.intrinsic(kind === "MapKeyEq" ? "mapkeyeq" : "natless", e,
          [{ name: "a", type: kt, mode: "ref", ref: a }, { name: "b", type: kt, mode: "ref", ref: b }],
          ([x, y]) => ({ kind, type: e.type, span: e.span, a: x, b: y }), scalar(e.type, "comparison"), false);
      }
      case "MapSeed":
        return this.intrinsic("mapseed", e, [], () => ({ kind: "MapSeed", type: e.type, span: e.span }), scalar(e.type, "map seed"), false);
      case "MapAlloc": {
        const n = this.expr(e.count), z = this.expr(e.size);
        if (n.ty !== "si64" || z.ty !== "si64") throw new MlirUnsupported("map alloc operand types");
        return this.intrinsic("mapalloc", e, [{ name: "n", type: I64, mode: "val", ref: n.ref }, { name: "z", type: I64, mode: "val", ref: z.ref }],
          ([a, b]) => ({ kind: "MapAlloc", type: e.type, span: e.span, count: a, size: b }), scalar(e.type, "map buffer"));
      }
      case "MapCopyOut": {
        // `_vecCopyOut(place)`: legacy's structural deep copy of what the place holds
        // (emitDeepCloneFromPtr), an owned value.
        const ty = this.value(e.type, "copied value");
        return this.copyOut(e, this.place(e.value, refOf(ty), false).ref, ty);
      }
      case "StringCstr": {
        // `s.cstr()`: the place's buffer made unique and NUL-terminated, then its bytes.
        if (scalar(e.type, "cstr") !== PTR) throw new MlirUnsupported("cstr type");
        const str = this.place(e.object, `!milo.ref<${STR}>`, false).ref;
        // C may write through the bytes: a string owned outright here is made the only
        // handle to its buffer first, as legacy (the helper sees only a reference).
        if (this.ownedLocal(e.object))
          this.intrinsic("unique", { ...e, type: { tag: "void" } }, [{ name: "s", type: { tag: "string" }, mode: "mut", ref: str }],
            ([x]) => ({ kind: "StrUnique", type: { tag: "void" }, span: e.span, str: x }), null);
        return this.intrinsic("cstr", e, [{ name: "s", type: { tag: "string" }, mode: "ref", ref: str }],
          ([x]) => ({ kind: "StringCstr", type: e.type, span: e.span, object: x }), PTR, false);
      }
      case "NonNegative": {
        const v = this.expr(e.value);
        if (v.ty !== "si64" || scalar(e.type, "checked size") !== "si64") throw new MlirUnsupported("non-negative check type");
        return this.intrinsic(`nonneg.${fnv1a(e.what)}`, e, [{ name: "v", type: I64, mode: "val", ref: v.ref }],
          ([x]) => ({ kind: "NonNegative", type: e.type, span: e.span, value: x, what: e.what }), "si64");
      }
      case "NumberToString": {
        const v = this.expr(e.value);
        if (!isScalarTy(v.ty) || v.ty !== valueType(this.cx, e.valueType)) throw new MlirUnsupported("toString of a non-scalar");
        const r = this.intrinsic("tostring", e, [{ name: "v", type: e.valueType, mode: "val", ref: v.ref }],
          ([x]) => ({ kind: "NumberToString", type: e.type, span: e.span, value: x, valueType: e.valueType }), STR);
        return { ...r, own: "owned" };
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
      case "MemReplace": {
        // `replace(&mut p, v)`, as legacy genMemReplace: the old value read out (it is the
        // result's now), then `v` stored over it with nothing dropped.
        const ty = this.value(e.type, "replaced value");
        const p = this.place(e.place, `!milo.ref<${ty}>`, true).ref;
        const old = { ...this.def(`milo.load ${p} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" as const : undefined };
        // Until the store, the old value has two owners on paper: no jump may come between.
        const mark = this.pending;
        this.pend(old);
        const v = this.consume(this.expr(e.value), "replacement");
        this.pending = mark;
        if (v.ty !== ty) throw new MlirUnsupported("replacement of another type");
        this.emit(`milo.store ${v.ref}, ${p} init : !milo.ref<${ty}>`);
        return old;
      }
      case "HeapCreate": {
        const ty = this.value(e.type, "box");
        if (ty.startsWith("!milo.dyn<")) throw new MlirUnsupported("box of an interface");
        const inner = /^!milo\.heap<(.*)>$/.exec(ty)![1];
        const v = valueType(this.cx, e.value.type) === null ? this.bigArg(e.value, inner) : this.consume(this.expr(e.value), "boxed value");
        if (v.ty !== inner) throw new MlirUnsupported("boxed value of another type");
        return { ...this.def(`milo.heap.new ${v.ref} : ${inner} -> ${ty}`, ty), own: "owned" };
      }
      case "HeapDeref": {
        const op = e.operand;
        const temp = op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "HeapCreate";
        const ty = this.value(e.type, "boxed value");
        const hty = `!milo.heap<${ty}>`;
        const payload = (h: string) => this.def(`milo.load ${this.def(`milo.heap.place ${h} : ${hty} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref} : !milo.ref<${ty}>`, ty);
        if (temp || (e.isMove && this.hasDrop(ty))) {
          // As legacy genHeapMoveOut: the payload out, the box freed with nothing dropped,
          // and a box held by a place left empty (an owned local's slot emptied, a field
          // set to null), so no drop of it ever runs on the leftover.
          let h: string, after = () => {};
          if (temp) {
            const v = this.expr(op);
            if (v.ty !== hty || v.own !== "owned") throw new MlirUnsupported("deref of a temporary box");
            h = v.ref;
          } else if (op.kind === "Ident") {
            const b = this.lookup(op.name);
            if (b.kind !== "var" || !b.owned || b.ty !== hty) throw new MlirUnsupported("move out of a box that is not an owned local");
            h = this.def(`milo.move ${b.ref} : !milo.ref<${hty}>`, hty).ref;
          } else if (op.kind === "FieldAccess" && this.fieldOfOwnedLocal(op)) {
            const p = this.fieldPlace(op)!;
            if (p.ty !== hty) throw new MlirUnsupported("move out of a box field of another type");
            h = this.def(`milo.load ${p.ref} : !milo.ref<${hty}>`, hty).ref;
            after = () => this.emit(`milo.store ${this.def(`milo.zero : ${hty}`, hty).ref}, ${p.ref} init : !milo.ref<${hty}>`);
          } else throw new MlirUnsupported("move out of a box that is not a local's");
          const v = payload(h);
          this.emit(`milo.heap.free ${h} : ${hty}`);
          after();
          return { ...v, own: this.hasDrop(ty) ? "owned" : undefined };
        }
        // A read leaves the box its payload: a bit copy that owns nothing.
        const p = this.heapPlace(e);
        const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
        if (!this.hasDrop(p.ty)) return v;
        if (e.isMove) throw new MlirUnsupported("move out of a box");
        this.bitCopies.add(v.ref);
        return { ...v, own: "view" };
      }
      case "HashMapLen": {
        const m = this.borrow(this.expr(e.object), e.object.type);
        if (!m.ty.startsWith("!milo.map<")) throw new MlirUnsupported("len of a non-map");
        return this.def(`milo.map.len ${m.ref} : ${m.ty}`, "si64");
      }
      case "VecLen": {
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64");
      }
      case "PtrDeref": return this.ptrRead(this.ptrPlace(e)!);
      case "FieldAccess": {
        const pp = this.ptrPlace(e);
        if (pp) return this.ptrRead(pp);
        // A field of a place is read in place, as legacy genFieldPtr does; of a value, out
        // of the value.
        if (e.isMove && this.hasDrop(this.value(e.type, "field"))) return this.moveField(e);
        const own = this.hasDrop(this.value(e.type, "field")) ? "view" as const : undefined;
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
        const mark = this.pending;
        // A 128+ byte payload of an enum that is a value passes through one SSA value from
        // its place (bigArg), as a big argument does at a call.
        const fields = v.fields.map(f => valueType(this.cx, f) ?? this.place$(f, "payload"));
        const args = e.args.map((a, k) => this.pend(valueType(this.cx, v.fields[k]) === null
          ? this.bigArg(a, fields[k]) : this.consume(this.expr(a), "payload")));
        this.pending = mark;
        if (args.some((a, k) => a.ty !== fields[k])) throw new MlirUnsupported("payload of another type");
        const ops = args.length ? ` (${args.map(a => a.ref).join(", ")} : ${fields.join(", ")})` : "";
        return { ...this.def(`milo.enum.new ${v.tag}${ops} -> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
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
        return { ref, ty, own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "Closure": return this.closure(e);
      case "ClosureCall": return this.closureCall(e, stmt);
      case "MatchExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("match-expression without a value");
        return this.match(e, this.value(e.type, "match-expression")).v;
      }
      case "Propagate": return this.propagate(e);
      case "DefaultValue": return this.defaultValue(e);
      case "Unwrap": {
        // Legacy's genUnwrap (its panic text and location) in a helper per enum and site,
        // the operand moved into it.
        const st = stripRefs(e.operand.type);
        const v = this.consume(this.expr(e.operand), "unwrapped value");
        const ty = this.value(e.type, "unwrapped payload");
        if (v.ty !== this.value(st, "unwrapped enum")) throw new MlirUnsupported("unwrap operand type");
        const r = this.intrinsic(`unwrap`, e, [{ name: "o", type: st, mode: "val", ref: v.ref }], ([x]) => ({ ...e, operand: { ...x, isMove: true } as HIRExpr }), ty);
        return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "OptionOp": {
        // isSome/isNone (isOk/isErr): a test of the tag, Some and Ok being tag 0; unwrapOr
        // is `??`. The closure-taking ones stay legacy.
        if (e.op === "unwrapOr" && e.default)
          return this.defaultValue({ kind: "DefaultValue", operand: e.value, default: e.default, enumName: e.enumName, type: e.type, span: e.span });
        if (e.op !== "isSome" && e.op !== "isNone") throw new MlirUnsupported(`option op ${e.op}`);
        const pt = placeType(this.cx, e.value.type);
        let tag: string;
        if (pt !== null && valueType(this.cx, e.value.type) === null) {
          const p = this.fieldPlace(e.value);
          if (!p) throw new MlirUnsupported("tag test of a 128+ byte enum that is not a place");
          tag = this.def(`milo.enum.tag_at ${p.ref} : !milo.ref<${p.ty}>`, "si32").ref;
        } else {
          const v = this.borrow(this.expr(e.value), e.value.type);
          if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("tag test of a non-enum");
          tag = this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32").ref;
        }
        const zero = this.def("milo.const 0 : si32", "si32").ref;
        return this.def(`milo.cmp ${e.op === "isSome" ? "eq" : "ne"}, ${tag}, ${zero} : si32`, "i1");
      }
      case "Forget": {
        // `forget(x)`: x is taken and nothing drops it (an owned SSA value no slot holds).
        const v = this.consume(this.expr(e.value), "forgotten value");
        void v;
        return { ref: "", ty: "" };
      }
      case "Zeroed": {
        const ty = this.value(e.zeroType, "zeroed value");
        if (ty.startsWith("!milo.fn<")) throw new MlirUnsupported("zeroed fn value");
        return { ...this.def(`milo.zero : ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
      }
      // std's panics with a message: legacy's text and abort in a helper per site.
      case "StrPanic": {
        const v = this.expr(e.value);
        if (!/^[su]i\d+$/.test(v.ty)) throw new MlirUnsupported("panic value type");
        return this.intrinsic(`strpanic.${fnv1a(`${e.head}\0${e.tail}`)}`, e, [{ name: "v", type: e.value.type, mode: "val", ref: v.ref }],
          ([x]) => ({ ...e, value: x }), null);
      }
      case "VecPanic":
        return this.intrinsic(`vecpanic.${fnv1a(e.message)}`, e, [], () => ({ ...e }), null);
      case "StringPushStr": {
        // `s.pushStr(x)`: the place, then x, as legacy genStringPushStr; milo.string.append
        // is legacy's pushStr (unique first, then grow; `s.pushStr(s)` re-based).
        const dst = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const x = this.borrow(this.expr(e.other), e.other.type);
        if (x.ty !== STR) throw new MlirUnsupported("pushStr of a non-string");
        this.stringHelpers();
        this.emit(`milo.string.append ${dst}, ${x.ref} : !milo.ref<${STR}>`);
        return { ref: "", ty: "" };
      }
      case "ArrayLit": {
        if (e.type.tag !== "vec") throw new MlirUnsupported("array literal as a value");
        const ty = this.value(e.type, "Vec literal");
        if (e.elements.length === 0) return { ...this.def(`milo.vec.new : ${ty}`, ty), own: "owned" };
        // Legacy's genArrayLit (one malloc of exactly n elements, each stored as it is
        // evaluated) in a legacy function per element type and count, the elements
        // evaluated here in order and moved into it.
        const et = e.type.element;
        const ety = this.value(et, "Vec literal element");
        const mark = this.pending;
        const args = e.elements.map(x => {
          const v = this.pend(this.consume(this.expr(x), "Vec literal element"));
          if (v.ty !== ety) throw new MlirUnsupported("Vec literal element of another type");
          return `${v.ref} : ${ety}`;
        });
        this.pending = mark;
        const name = this.cx.mlirHelper(`milo.veclit.${typeKey(et)}.${e.elements.length}`, () => ({
          params: e.elements.map((_, k) => ({ name: `e${k}`, type: et, isRef: false, isRefMut: false })),
          retType: e.type,
          body: [{ kind: "Return", retType: e.type, value: { kind: "ArrayLit", type: e.type,
            elements: e.elements.map((_, k) => ({ kind: "Ident" as const, name: `e${k}`, type: et, isMove: true })) } }],
        }));
        if (this.hasDrop(ety)) this.dropGlue(ty, e.type);
        return { ...this.callHelper(name, args, ty), own: "owned" };
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
    if (e.isMove && !e.heapEnv && !e.keyExtractor) return this.moveClosure(e);
    if (e.isMove || e.heapEnv || e.keyExtractor) throw new MlirUnsupported(e.isMove ? "move closure" : "heap-env closure");
    const ty = this.value(e.type, "closure");
    // A global's initializer (__milo.global_init, __milo.lazyinit.*) returns before the
    // global's closure is ever called, so legacy gives that env a static slot instead.
    if (e.captures.length && this.fn.name.startsWith("__milo.")) throw new MlirUnsupported("closure env in a global initializer");
    const caps = e.captures.map(c => {
      const b = this.lookup(c.name);
      if (b.kind === "vec") return { name: c.name, place: `!milo.vec<${b.elem}>`, ref: b.ref, b };
      if (b.kind === "var") return { name: c.name, place: `!milo.ref<${b.ty}>`, ref: b.ref, b };
      if (this.hasDrop(b.v.ty)) throw new MlirUnsupported("capture of an owned value");
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

  /**
   * Legacy's structural deep copy (emitDeepCloneFromPtr, through MapCopyOut) of what the
   * place `src` holds (`refOf(ty)`, or a slot of `ty` when `slot`), an owned value of
   * `ty`. A Vec in a slot is lent as its header.
   */
  private copyOut(e: HIRExpr, src: string, ty: string, slot = false): Val {
    const vm = /^!milo\.vecval<(.*)>$/.exec(ty);
    if (vm && slot) src = this.def(`milo.vec.place ${src} : !milo.ref<${ty}> -> !milo.vec<${vm[1]}>`, `!milo.vec<${vm[1]}>`).ref;
    const r = this.intrinsic("copyout", e, [{ name: "s", type: e.type, mode: "ref", ref: src }],
      ([x]) => ({ kind: "MapCopyOut", type: e.type, span: e.span, value: x }), ty);
    return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /**
   * `e`, an intrinsic, as a call of a legacy function whose body is `make` applied to its
   * params: one per intrinsic, param types and call site, since its panics name the line and column.
   * `ops` are the operands as already evaluated, in legacy's order; a `ref`/`mut` one is a place.
   */
  private intrinsic(kind: string, e: HIRExpr, ops: { name: string; type: TypeKind; mode: "val" | "ref" | "mut"; ref: string }[],
    make: (idents: HIRExpr[]) => HIRExpr, ret: string | null, panics = true): Val {
    const l = panics ? this.cx.checkLocation(this.fn.trackedCaller ?? e.span) : { line: 0, col: 0, file: "" };
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    const tys = ops.map(o => { const t = this.value(o.type, "intrinsic operand"); return o.mode === "val" ? t : refOf(t); });
    const site = panics ? `.${l.line}.${l.col}.${fnv1a(l.file)}` : "";
    const name = `milo.intr.${kind}.${ops.map(o => typeKey(o.type)).join(".")}${site}`;
    const retType = e.type;
    this.cx.mlirHelper(name, () => {
      const idents = ops.map(o => ({ kind: "Ident" as const, name: o.name, type: o.type, isMove: false }));
      const value = make(idents);
      return {
        params: ops.map(o => ({ name: o.name, type: o.type, isRef: o.mode === "ref", isRefMut: o.mode === "mut" })),
        retType, trackedCaller: this.fn.trackedCaller,
        body: [ret === null ? { kind: "ExprStmt", expr: value } : { kind: "Return", retType, value }],
      };
    });
    const fnTy = `(${tys.join(", ")})${ret === null ? " -> ()" : ` -> ${ret}`}`;
    this.callees.set(name, fnTy);
    const call = `func.call @${quote(name)}(${ops.map(o => o.ref).join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return this.def(call, ret);
  }

  /**
   * A `move` closure: legacy's genClosure inside a legacy function of its own
   * (`milo.mkclosure.<fn>.<k>`) taking each capture by value, so the heap env, its drop
   * glue, the liveness flags and the run-once check are legacy's, and so is the body. A
   * capture moves out of its owned slot into the call; a shared string capture
   * (`share`) passes a new owner of the same buffer and the binding stays live.
   */
  private moveClosure(e: HIRExpr & { kind: "Closure" }): Val {
    const ty = this.value(e.type, "move closure");
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: Val[] = [];
    for (const c of e.captures) {
      if (c.type.tag === "ref") throw new MlirUnsupported("move closure capturing a reference");
      const cty = this.value(c.type, "capture");
      const b = this.lookup(c.name);
      let v: Val;
      if (b.kind === "ssa") v = this.consume(b.v, "capture");
      else if (b.kind !== "var" || b.ty !== cty) throw new MlirUnsupported("capture binding");
      else if (!this.hasDrop(cty)) v = this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty);
      else if (c.share && cty === STR) {
        this.cx.mlirHelper("milo.share.string", () => ({
          params: [{ name: "s", type: { tag: "string" }, isRef: true, isRefMut: false }],
          retType: { tag: "string" },
          body: [{ kind: "Return", retType: { tag: "string" }, value: {
            kind: "StringClone", type: { tag: "string" }, str: { kind: "Ident", name: "s", type: { tag: "string" }, isMove: false } } }],
        }));
        v = { ...this.def(`milo.string.share ${b.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      } else if (b.owned && !c.share) v = { ...this.def(`milo.move ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
      else throw new MlirUnsupported("capture that is not a move of an owned local");
      params.push({ name: c.name, type: c.type, isRef: false, isRefMut: false });
      args.push(v);
    }
    const name = `milo.mkclosure.${this.fn.name}.${this.closures.next++}`;
    this.cx.mlirHelper(name, () => ({
      params, retType: e.type,
      // The helper's params are its own: every capture is moved into the env.
      body: [{ kind: "Return", retType: e.type, value: { ...e, captures: e.captures.map(c => ({ ...c, share: false })) } }],
    }));
    const fnTy = `(${args.map(a => a.ty).join(", ")}) -> ${ty}`;
    this.callees.set(name, fnTy);
    this.dropGlue(ty, e.type);
    return { ...this.def(`func.call @${quote(name)}(${args.map(a => a.ref).join(", ")}) : ${fnTy}`, ty), own: "owned" };
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
    const mark = this.pending;
    const args = e.args.map((a, i) => {
      const pty = ptys[i];
      if (pty === null || (ft.params[i].tag === "ref") !== a.passByRef) throw new MlirUnsupported("closure call arg");
      if (a.passByRef) {
        const r = this.place(a.expr, pty, a.refMut).ref;
        refs.push({ ref: r, mut: a.refMut, ty: pty });
        return r;
      }
      const v = this.pend(this.consume(this.expr(a.expr), "argument"));
      if (v.ty !== pty) throw new MlirUnsupported("closure call arg type");
      return v.ref;
    });
    this.pending = mark;
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
    return { ...this.def(call, ret), own: this.hasDrop(ret) ? "owned" : undefined };
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
    if (e.kind === "PtrDeref") {
      // `*p`: what p points at, of any type; an owning one is a bit copy, as ptrRead says.
      const p = this.expr(e.operand);
      if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
      return { ptr: p.ref, ty: this.memType(e.type, "load through a pointer") };
    }
    if (e.kind === "IndexAccess" && stripRefs(e.object.type).tag === "ptr") {
      const p = this.expr(e.object);
      const i = this.expr(e.index);
      if (p.ty !== PTR || i.ty !== "si64") throw new MlirUnsupported("pointer index of another type");
      const ty = this.memType(e.type, "pointer element");
      return { ptr: this.def(`milo.ptr.elem ${p.ref}[${i.ref}] : ${ty}`, PTR).ref, ty };
    }
    if (e.kind !== "FieldAccess") return null;
    const obj = stripRefs(e.object.type);
    let base: { ptr: string; ty: string } | null;
    let st: TypeKind;
    if (obj.tag === "ptr") {
      st = obj.inner;
      const p = this.expr(e.object);
      base = { ptr: p.ref, ty: this.memType(st, "pointee") };
    } else {
      base = this.ptrPlace(e.object);
      st = obj;
    }
    if (!base) return null;
    if (st.tag !== "struct") throw new MlirUnsupported("field through a pointer to a non-struct");
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    const ty = this.memType(e.type, "field");
    return { ptr: this.def(`milo.ptr.field ${base.ptr}[${index}] : ${base.ty}`, PTR).ref, ty };
  }

  /** A read of a place through a pointer: a bit copy that, for a string or a Vec, owns. */
  private ptrRead(p: { ptr: string; ty: string }): Val {
    if (placeOnly.get(this.cx)?.has(p.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
    const v: Val = { ...this.def(`milo.ptr.load ${p.ptr} : ${p.ty}`, p.ty), own: this.hasDrop(p.ty) ? "owned" : undefined };
    if (v.own) this.bitCopies.add(v.ref);
    return v;
  }

  // Owning values read through a raw pointer: the bits of a value the memory still owns.
  // Moved somewhere (std's pop), the move takes it; only borrowed (`f(src[i])` with a
  // `&T` param, a print part), it must not be dropped, as legacy lends the element's address.
  private bitCopies = new Set<string>();

  /** The slot `e` names (a `var`, a by-ref param, a field of either), or null for a value. */
  private fieldPlace(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      return b.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : null;
    }
    if (e.kind === "IndexAccess") return this.elemRef(e);
    if (e.kind === "HeapDeref") return this.heapPlace(e);
    if (e.kind !== "FieldAccess") return null;
    const base = this.fieldPlace(e.object);
    if (!base) return null;
    const { index, ty } = this.field(e);
    const r = this.def(`milo.field_ref ${base.ref}[${index}] : !milo.ref<${base.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`);
    return { ref: r.ref, ty, param: base.param };
  }

  /**
   * `*h` as a place: the box's own pointer. The box must be a place's (a local, a field,
   * an element), not a temporary one, which legacy frees as soon as the payload is out.
   */
  private heapPlace(e: HIRExpr & { kind: "HeapDeref" }): { ref: string; ty: string } {
    const op = e.operand;
    if (op.kind !== "Ident" && op.kind !== "FieldAccess" && op.kind !== "IndexAccess" && op.kind !== "HeapDeref")
      throw new MlirUnsupported("deref of a temporary box");
    const h = this.expr(op);
    const m = /^!milo\.heap<(.*)>$/.exec(h.ty);
    if (!m || h.own === "owned") throw new MlirUnsupported("deref of a temporary box");
    const ty = m[1];
    return { ref: this.def(`milo.heap.place ${h.ref} : ${h.ty} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref, ty };
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
    const mark = this.pending;
    for (const f of e.fields) given.set(f.name, this.pend(this.consume(this.expr(f.value), "field")));
    this.pending = mark;
    // The base gives up its unlisted fields and drops its listed ones: not with owned ones yet.
    if (e.base && this.hasDrop(ty)) throw new MlirUnsupported("struct update of an owning struct");
    const base = e.base ? this.expr(e.base) : null;
    if (base && base.ty !== ty) throw new MlirUnsupported("struct update base of another type");
    const ops = layout.fields.map((f, i) => {
      const fty = this.value(f.typeKind, "field");
      const g = given.get(f.name);
      const v = g ? this.fnAs(g, fty, true) : base ? this.def(`milo.struct.get ${base.ref}[${i}] : ${ty} -> ${fty}`, fty) : null;
      if (!v || v.ty !== fty) throw new MlirUnsupported("struct literal field");
      return v;
    });
    const operands = ops.length ? `${ops.map(o => o.ref).join(", ")} : ${ops.map(o => o.ty).join(", ")} ` : "";
    return { ...this.def(`milo.struct.new ${operands}-> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /**
   * A value-producing block (if-expression and match arms): every statement but the last,
   * then the value of the last one to yield, or true when the block jumps instead.
   */
  private tail(body: HIRStmt[], ty: string): true | Val {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt" || this.diverges(last.expr)) {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    const armLocal = last.expr.kind === "Ident" ? this.scopes[this.scopes.length - 1].get(last.expr.name) : undefined;
    // The block's own binding (an arm's payload, as `let ... else` makes one) is moved out,
    // as legacy does for an arm-local tail (forkTailIsView's armLocal).
    let v = armLocal?.kind === "var" && armLocal.owned
      ? { ...this.def(`milo.move ${armLocal.ref} : !milo.ref<${armLocal.ty}>`, armLocal.ty), own: "owned" as const }
      : this.expr(last.expr);
    v = this.consume(v, "block value");
    if (v.ty !== ty) throw new MlirUnsupported("block value of another type");
    return v;
  }

  /**
   * A value-producing block whose value goes into the place `dst` (of type `ty`, a place
   * only): tail's statements, then the last expression built in `dst`. The block's own
   * owned binding is moved out, as tail moves it. True when the block jumps instead.
   */
  private tailInto(body: HIRStmt[], dst: string, ty: string): boolean {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt" || this.diverges(last.expr)) {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    const armLocal = last.expr.kind === "Ident" ? this.scopes[this.scopes.length - 1].get(last.expr.name) : undefined;
    if (armLocal?.kind === "var" && armLocal.owned && armLocal.ty === ty) {
      this.emit(`milo.copy ${armLocal.ref}, ${dst} : !milo.ref<${ty}>, !milo.ref<${ty}> of ${ty}`);
      this.def(`milo.move ${armLocal.ref} : !milo.ref<${ty}>`, ty);
      return false;
    }
    this.into(last.expr, dst, ty);
    return false;
  }

  /**
   * `match` as milo.match: one region per arm, the `_` arm last. A flat enum pattern's
   * bindings are its arm's block arguments (payload i is binding i); a literal pattern on
   * an int or bool is a case value. `resultTy` makes it an expression.
   */
  private match(m: { subject: HIRExpr; arms: (HIRStmt & { kind: "Match" })["arms"]; subjectIsMut?: boolean; subjectIsRef?: boolean },
    resultTy: string | null, armBody?: (body: HIRStmt[]) => boolean): { done: boolean; v: Val } {
    // An owning subject matched by value moves its payload into the bindings (legacy
    // bindPayloads zeroes it in the subject); matched by reference, bindings are views.
    const subjPlaceTy = placeType(this.cx, m.subject.type);
    // A 128+ byte enum is matched through its place: a switch on the tag read there
    // (milo.enum.tag_at), each binding the payload field's place (milo.enum.field_ref).
    const bigEnum = subjPlaceTy !== null && isBig(this.cx, subjPlaceTy) && subjPlaceTy.startsWith("!milo.enum<");
    const owning = this.hasDrop(bigEnum ? subjPlaceTy! : this.value(m.subject.type, "match subject"));
    // By value, the owned slot the subject lives in: an arm that binds an owning payload
    // field moves the subject out of it (milo.move), so drop elaboration sees it empty on
    // that path and full on the others, as legacy's alive flag does.
    let from: string | null = null;
    // A `&mut` subject's place: its bindings are the payload's own places
    // (milo.enum.field_ref), so writing one writes the payload.
    let place: { ref: string; ty: string } | null = null;
    let subj: Val;
    if (bigEnum) {
      if (!m.subjectIsRef && !m.subjectIsMut) {
        // By value: a local's own slot, or a slot of this block the subject is built in.
        // An owning one is the `from` of a consuming arm, as for a small enum.
        const e = m.subject;
        const b = e.kind === "Ident" ? this.lookup(e.name) : null;
        if (b?.kind === "var" && b.ty === subjPlaceTy) {
          if (owning && !b.owned) throw new MlirUnsupported("match moving out of a borrowed enum");
          place = { ref: b.ref, ty: b.ty };
        } else {
          const sl = this.bigSlot("subject", e, true);
          place = { ref: sl.ref, ty: sl.ty };
        }
        if (owning) from = place.ref;
      } else place = this.fieldPlace(m.subject);
      if (!place) throw new MlirUnsupported("match on a 128+ byte enum that is not a place");
      subj = this.def(`milo.enum.tag_at ${place.ref} : !milo.ref<${place.ty}>`, "si32");
    } else if (m.subjectIsMut) {
      place = this.fieldPlace(m.subject);
      if (place && isBig(this.cx, place.ty)) throw new MlirUnsupported("match on a 128+ byte enum");
      if (!place || !place.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("match on a &mut subject that is not an enum place");
      subj = { ...this.def(`milo.load ${place.ref} : !milo.ref<${place.ty}>`, place.ty), own: this.hasDrop(place.ty) ? "view" : undefined };
    } else if (owning && !m.subjectIsRef) {
      const e = m.subject;
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b?.kind === "var" && b.owned) from = b.ref;
      else {
        const v = this.expr(e);
        if (v.own !== "owned") throw new MlirUnsupported("match moving out of a borrowed enum");
        // When every arm binds every owning payload field (`f()?`), every path empties the
        // slot, so when it would drop does not matter: a user Drop in it never runs.
        const st = stripRefs(e.type);
        const lay = st.tag === "enum" ? this.cx.mlirEnumLayout(st.name) : null;
        const emptied = !!lay && m.arms.every(a => a.pattern.kind === "EnumPattern" && !a.pattern.tests
          && (lay.variants.find(x => x.tag === (a.pattern as { tag: number }).tag)?.fields ?? [null]).every((f, k) =>
            f !== null && (!this.hasDrop(this.place$(f, "payload")) || (a.pattern as { bindings: { name: string }[] }).bindings[k]?.name)));
        from = this.tempSlot("subject", v.ty, e.type, emptied);
        this.emit(`milo.store ${v.ref}, ${from} : !milo.ref<${v.ty}>`);
      }
      const ty = this.value(e.type, "match subject");
      subj = { ...this.def(`milo.load ${from} : !milo.ref<${ty}>`, ty), own: "view" };
    } else subj = this.borrow(this.expr(m.subject), m.subject.type);
    const isEnum = bigEnum || subj.ty.startsWith("!milo.enum<");
    if (!isEnum && m.arms.some(a => a.pattern.kind === "LiteralPattern" && (a.pattern.literalKind === "string" || a.pattern.literalKind === "float")))
      return this.literalChain(m.arms, subj, stripRefs(m.subject.type), resultTy, armBody);
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
      const consumes = from !== null && args.some(a => a.name !== "_" && this.hasDrop(a.ty));
      // Legacy stops dropping the subject once an arm takes a payload, so an owning field
      // the arm leaves unbound would be legacy's leak; not reproduced.
      if (consumes && args.some(a => a.name === "_" && this.hasDrop(a.ty))) throw new MlirUnsupported("match leaving an owning payload field unbound");
      const done = this.region(i === 0 ? head : "}, {", () => {
        if (bigEnum && consumes) {
          // The arm takes the payload: its fields are read out of the place, then the
          // subject's slot is emptied (milo.move, whose value goes unused), and each
          // owning field belongs to its binding for the arm's scope.
          const fields = args.map((a, k) => {
            if (a.name === "_") return null;
            // A 128+ byte field passes through one SSA value from place to place, as a big
            // argument is loaded whole at its call (bigArg).
            const r = this.def(`milo.enum.field_ref ${place!.ref}[${tag}, ${k}] : !milo.ref<${place!.ty}> -> !milo.ref<${a.ty}>`, `!milo.ref<${a.ty}>`).ref;
            return this.def(`milo.load ${r} : !milo.ref<${a.ty}>`, a.ty).ref;
          });
          this.def(`milo.move ${from} : !milo.ref<${place!.ty}>`, place!.ty);
          args.forEach((a, k) => {
            const v = fields[k];
            if (v === null) return;
            const owns = this.hasDrop(a.ty);
            const slot = owns ? this.ownedSlot(a.name, a.ty, layout!.variants.find(x => x.tag === tag)!.fields[k]) : this.fresh();
            if (!owns) this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            this.emit(`milo.store ${v}, ${slot} : !milo.ref<${a.ty}>`);
            this.bind(a.name, { kind: "var", ref: slot, ty: a.ty, owned: owns });
          });
        } else if (bigEnum) {
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const r = this.def(`milo.enum.field_ref ${place!.ref}[${tag}, ${k}] : !milo.ref<${place!.ty}> -> !milo.ref<${a.ty}>`, `!milo.ref<${a.ty}>`).ref;
            // Through `&mut`, and for a payload with drop glue, the binding is the payload's
            // place (legacy binds a pointer); a Copy payload under `&` is a copy.
            if (m.subjectIsMut || this.hasDrop(a.ty) || isBig(this.cx, a.ty)) { this.bind(a.name, { kind: "var", ref: r, ty: a.ty }); return; }
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
              if (!this.hasDrop(a.ty)) return;
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
        return armBody ? armBody(arm.body) : resultTy ? this.tail(arm.body, resultTy) : this.stmts(arm.body);
      });
      if (!done) allDone = false;
    });
    this.emit("}");
    // A match that is not exhaustive by its cases alone still is by the checker, so
    // arms that all jump leave nothing after them.
    if (!resultTy && !armBody && allDone && arms.length) { this.emit("milo.unreachable"); return { done: true, v: { ref: "", ty: "" } }; }
    return { done: false, v: { ref, ty: resultTy ?? "", own: resultTy && this.hasDrop(resultTy) ? "owned" : undefined } };
  }

  /**
   * `x?` as the match it means, as legacy genPropagate: `Ok(v) => v` (tag 0, Some for an
   * Option), `Err(e) => return Err(e)` in the function's result enum, the error wrapped in
   * its From variant first for a conversion. The error arm is a return statement, so the
   * scope drops run before it and a pending owned operand keeps the function legacy.
   */
  private propagate(e: HIRExpr & { kind: "Propagate" }, into?: { dst: string; ty: string }): Val {
    if (e.boxConversion) throw new MlirUnsupported("`?` boxing its error into a Heap");
    if (e.messageFn) throw new MlirUnsupported("`?` turning its error into a message");
    const src = this.cx.mlirEnumLayout(e.enumName);
    const ret = e.retType.tag === "enum" ? this.cx.mlirEnumLayout(e.retType.name) : null;
    const isErr = (v: { name: string }) => v.name === "Err" || v.name === "None";
    const ok = src?.variants.find(v => v.tag === 0);
    const err = src?.variants.find(isErr);
    const retErr = ret?.variants.find(isErr);
    if (!ok || !err || !retErr || ok.fields.length > 1 || err.fields.length !== retErr.fields.length || err.fields.length > 1) throw new MlirUnsupported("`?` enum layout");
    const n = this.n++;
    const okName = `prop$ok${n}`, errName = `prop$err${n}`;
    let errVal: HIRExpr | null = err.fields.length ? { kind: "Ident", name: errName, type: err.fields[0], isMove: true } : null;
    if (e.fromConversion) {
      const target = retErr.fields[0];
      if (!errVal || target?.tag !== "enum" || target.name !== e.fromConversion.targetEnumName) throw new MlirUnsupported("`?` conversion layout");
      errVal = { kind: "EnumLit", enumName: target.name, variant: e.fromConversion.wrapVariant, args: [errVal], type: target };
    }
    const okArm = {
      pattern: { kind: "EnumPattern" as const, variant: ok.name, tag: 0, bindings: ok.fields.length ? [{ name: okName, type: ok.fields[0] }] : [] },
      body: ok.fields.length ? [{ kind: "ExprStmt" as const, expr: { kind: "Ident" as const, name: okName, type: e.type, isMove: true } }] : [],
    };
    const errArm = {
      pattern: { kind: "EnumPattern" as const, variant: err.name, tag: err.tag, bindings: err.fields.length ? [{ name: errName, type: err.fields[0] }] : [] },
      body: [{ kind: "Return" as const, retType: e.retType, value: { kind: "EnumLit" as const, enumName: (e.retType as { name: string }).name, variant: retErr.name, args: errVal ? [errVal] : [], type: e.retType } }],
    };
    if (into) return this.match({ subject: e.operand, arms: [okArm, errArm] }, null, b => this.tailInto(b, into.dst, into.ty)).v;
    const resultTy = ok.fields.length ? this.value(e.type, "`?` result") : null;
    return this.match({ subject: e.operand, arms: [okArm, errArm] }, resultTy).v;
  }

  /**
   * `x ?? d` as the match it means, as legacy genDefaultValue: `Some(v) => v` (tag 0; Ok),
   * anything else evaluates `d`. The subject is consumed only on the first arm.
   */
  private defaultValue(e: HIRExpr & { kind: "DefaultValue" }, into?: { dst: string; ty: string }): Val {
    const ok = this.cx.mlirEnumLayout(e.enumName)?.variants.find(v => v.tag === 0);
    if (!ok || ok.fields.length !== 1) throw new MlirUnsupported("`??` enum layout");
    // Legacy never drops the payload of the other variant (an owning Err leaks there);
    // dropping it here would change the live-block count, so such ones stay legacy.
    const others = this.cx.mlirEnumLayout(e.enumName)!.variants.filter(v => v.tag !== 0).flatMap(v => v.fields);
    if (others.some(f => this.hasDrop(this.place$(f, "`??` payload")))) throw new MlirUnsupported("`??` over an owning Err");
    const name = `dflt$v${this.n++}`;
    const arms = [
      { pattern: { kind: "EnumPattern" as const, variant: ok.name, tag: 0, bindings: [{ name, type: ok.fields[0] }] },
        body: [{ kind: "ExprStmt" as const, expr: { kind: "Ident" as const, name, type: e.type, isMove: true } }] },
      { pattern: { kind: "WildcardPattern" as const }, body: [{ kind: "ExprStmt" as const, expr: e.default }] },
    ];
    if (into) return this.match({ subject: e.operand, arms }, null, b => this.tailInto(b, into.dst, into.ty)).v;
    return this.match({ subject: e.operand, arms }, this.value(e.type, "`??` result")).v;
  }

  /**
   * A match on a string or a float: no switch, so the arms are tested in order, each an
   * `==` of the subject with the literal (strings through legacy's comparison), nested
   * milo.ifs with the `_` arm innermost.
   */
  private literalChain(arms: (HIRStmt & { kind: "Match" })["arms"], subj: Val, subjTy: TypeKind, resultTy: string | null, armBody?: (body: HIRStmt[]) => boolean): { done: boolean; v: Val } {
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
      const run = () => armBody ? armBody(body) : resultTy ? this.tail(body, resultTy) : this.stmts(body);
      if (p.kind === "WildcardPattern") return run();
      if (p.kind !== "LiteralPattern") throw new MlirUnsupported("enum pattern on a scalar");
      const c = this.binop({ kind: "BinOp", op: "==", left: subject, right: lit(p), type: { tag: "bool" } });
      const ref = resultTy ? this.fresh() : "";
      const thenDone = this.region(`${resultTy ? `${ref} = ` : ""}milo.if ${c.ref}${resultTy ? ` -> ${resultTy}` : ""} {`, run);
      const elseDone = this.region("} else {", () => arm(i + 1));
      this.emit("}");
      if (resultTy) return { ref, ty: resultTy, own: this.hasDrop(resultTy) ? "owned" : undefined };
      // Filling a place, the caller goes on after the chain: no terminator at its top.
      if (thenDone && elseDone && !(armBody && i === 0)) { this.emit("milo.unreachable"); return true; }
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

  /** The legacy functions milo.string.concat and milo.string.append lower to. */
  private stringHelpers(): void {
    const str: TypeKind = { tag: "string" };
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
      this.stringHelpers();
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
        // An immutable binding held as an SSA value: from here on it lives in a slot, as
        // legacy's alloca does, so a write through the address is seen by later reads.
        const ref = this.fresh();
        this.vars.push(`  ${ref} = milo.var ${quote(e.operand.name)} : !milo.ref<${b.v.ty}>`);
        this.emit(`milo.store ${b.v.ref}, ${ref} : !milo.ref<${b.v.ty}>`);
        const m = [...this.scopes].reverse().find(s => s.has((e.operand as { name: string }).name))!;
        m.set(e.operand.name, { kind: "var", ref, ty: b.v.ty });
        return this.def(`milo.addr ${ref} : !milo.ref<${b.v.ty}>`, PTR);
      }
      // A place behind a pointer (`data[i].addrOf()`) is its address already.
      const pp = this.ptrPlace(e.operand);
      if (pp) return { ref: pp.ptr, ty: PTR };
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

  /**
   * `v[i]` on a Vec of non-scalars as its element's place (milo.index.ref, bounds-checked),
   * as legacy genLValue lends it; null for any other index. Object, then index, as legacy.
   */
  private elemRef(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind !== "IndexAccess") return null;
    const ot = stripRefs(e.object.type);
    if (ot.tag === "array" && ot.size !== null) {
      // A fixed-size array's element, of any type, through the array's place.
      const at = this.place$(ot, "indexed array");
      const p = this.fieldPlace(e.object);
      if (!p || p.ty !== at) throw new MlirUnsupported("index into an array that is not a place");
      const i = this.expr(e.index);
      if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
      const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
      const ty = this.place$(ot.element, "array element");
      const ref = this.def(`milo.array.index ${p.ref}[${index}] : !milo.ref<${at}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`, this.loc(e.span)).ref;
      return { ref, ty, param: p.param };
    }
    const el = vecElem(this.cx, ot);
    if (el === null || isScalarTy(el)) return null;
    const { place, elem, param } = this.vecPlace(e.object);
    const i = this.expr(e.index);
    if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
    const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
    const ref = this.def(`milo.index.ref ${place}[${index}] : !milo.vec<${elem}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`, this.loc(e.span)).ref;
    return { ref, ty: elem, param };
  }

  /** The header address of the Vec `e` names: a by-ref Vec param, or an owned Vec local. */
  private vecPlace(e: HIRExpr): { place: string; elem: string; param?: number } {
    const b = e.kind === "Ident" ? this.lookup(e.name) : null;
    if (b?.kind === "vec") return { place: b.ref, elem: b.elem, param: b.param };
    // A Vec local, a Vec field of a place, or a Vec element.
    const slot = b?.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : e.kind === "FieldAccess" || e.kind === "IndexAccess" ? this.fieldPlace(e) : null;
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
      if (p) {
        // A Vec field is lent as its header's place.
        if (refOf(p.ty) === refTy && refTy !== `!milo.ref<${p.ty}>`)
          return { ref: this.def(`milo.vec.place ${p.ref} : !milo.ref<${p.ty}> -> ${refTy}`, refTy).ref, param: p.param };
        if (`!milo.ref<${p.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg of a field of another type");
        return { ref: p.ref, param: p.param };
      }
      // A field of a value (an immutable binding, a temporary): lent from a slot of its
      // own that drops nothing, the value or the temporary still owning what it holds.
      if (mut) throw new MlirUnsupported("&mut of a field of a value");
      const v = this.expr(e);
      if (`!milo.ref<${v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg of a field of a value");
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var "arg" : ${refTy}`);
      this.emit(`milo.store ${v.ref}, ${ref} : ${refTy}`);
      return { ref };
    }
    const er = this.elemRef(e);
    if (er) {
      // An element is lent in place, as legacy genLValueForArg; a Vec element as its header.
      if (refOf(er.ty) === refTy && refTy !== `!milo.ref<${er.ty}>`)
        return { ref: this.def(`milo.vec.place ${er.ref} : !milo.ref<${er.ty}> -> ${refTy}`, refTy).ref, param: er.param };
      if (`!milo.ref<${er.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg of an element of another type");
      return { ref: er.ref, param: er.param };
    }
    if (this.isSretCall(e) || (e.kind !== "Ident" && valueType(this.cx, e.type) === null && placeType(this.cx, e.type) !== null)) {
      // A 128+ byte temporary lent as `&T` is built in a slot of this block, which drops it.
      const sl = this.bigSlot("arg", e, true);
      if (`!milo.ref<${sl.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      return { ref: sl.ref };
    }
    if (e.kind !== "Ident") {
      // A value lent as `&T` (`f(Shape.Empty)`) gets a slot of its own, as legacy spills it.
      if (mut) throw new MlirUnsupported(`by-ref &mut arg ${e.kind}`);
      const arg = this.lendingArg;
      this.lendingArg = false;
      const v = this.expr(e);
      const vm = /^!milo\.vecval<(.*)>$/.exec(v.ty);
      if (vm && refTy === `!milo.vec<${vm[1]}>` && v.own === "owned" && !this.bitCopies.has(v.ref)) {
        // A temporary Vec lends its header from a slot that drops it.
        const slot = this.tempSlot("arg", v.ty, e.type);
        this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
        return { ref: this.def(`milo.vec.place ${slot} : !milo.ref<${v.ty}> -> ${refTy}`, refTy).ref };
      }
      if (`!milo.ref<${v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      if (this.hasDrop(v.ty) && v.own === "owned" && !this.bitCopies.has(v.ref)) {
        // A temporary that owns a buffer lends from a slot that drops it.
        const slot = this.tempSlot("arg", v.ty, e.type, arg);
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
   * print/eprint. An interpolated string is `print(format(parts))`; printing the parts
   * displays the same text without building the string (format and print share legacy's
   * int and float formatting), and like format evaluates every part first. A plain print
   * is legacy's stream: each string part is written once it is evaluated, after the
   * scalars before it, so a part that prints (or panics) lands between them. Each string
   * part therefore ends a `milo.print partial` of the parts so far.
   */
  private print(e: HIRExpr & { kind: "Call" }): Val {
    let args = e.args;
    const only = args.length === 1 ? args[0].expr : null;
    const formatted = only?.kind === "Call" && only.func === "format" && this.cx.isBuiltinName("format");
    if (formatted) args = only.args;
    const stderr = e.func === "eprint";
    const flag = stderr ? " stderr" : "";
    let parts: { v: Val; key: string; type: TypeKind }[] = [];
    const flush = (partial: boolean) => {
      this.cx.mlirPrintHelper(stderr, parts.map(p => ({ key: p.key, type: p.type })), partial);
      const attrs = `${flag}${partial ? " partial" : ""}`;
      if (parts.length === 0) this.emit(`milo.print${attrs}`);
      else this.emit(`milo.print${attrs} ${parts.map(p => p.v.ref).join(", ")} : ${parts.map(p => p.v.ty).join(", ")}`);
      parts = [];
    };
    args.forEach((a, i) => {
      if (a.passByRef) throw new MlirUnsupported("by-ref print part");
      let t = a.expr.type;
      while (t.tag === "ref") t = t.inner;
      const v = this.borrow(this.expr(a.expr), t);
      // Scalar.cpp printKey spells the same names.
      if (valueType(this.cx, t) !== v.ty || t.tag === "vec") throw new MlirUnsupported(`print part of type ${t.tag}`);
      parts.push({ v, key: typeKey(t), type: t });
      if (!formatted && t.tag === "string" && i < args.length - 1) flush(true);
    });
    flush(false);
    return { ref: "", ty: "" };
  }

  /**
   * An extern call that is variadic or turns a string into a `*u8`: legacy's genCall in a
   * legacy function per callee, argument shape and call site, so the C string conversion
   * (a view or a literal copied to a NUL-terminated temporary for the call) and the
   * variadic promotion are legacy's. A string goes to it by reference; one this function
   * owns outright (a local, a field of one, a temporary) is first made the only handle to
   * its buffer, as legacy's emitCStrUniquePlace does before C may write through it.
   * Scalars and pointers go by value, an array as its address.
   */
  private ffiCall(e: HIRExpr & { kind: "Call" }, stmt: boolean): Val {
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: string[] = [];
    const keys: string[] = [];
    const mark = this.pending;
    e.args.forEach((a, k) => {
      const t = a.expr.type;
      const name = `a${k}`;
      if (a.passByRef) {
        // C gets the place's address, as legacy passes it; the helper's param is that place.
        const st = stripRefs(t);
        if (st.tag === "string" || st.tag === "vec" || st.tag === "array") throw new MlirUnsupported(`by-ref ${st.tag} argument of an extern call`);
        const ty = this.place$(st, "extern by-ref operand");
        const r = this.place(a.expr, refOf(ty), a.refMut).ref;
        params.push({ name, type: st, isRef: !a.refMut, isRefMut: !!a.refMut });
        args.push(`${r} : ${refOf(ty)}`);
        keys.push(`r${typeKey(st)}`);
        return;
      }
      if (t.tag === "string") {
        let ref: string;
        const local = this.ownedLocal(a.expr);
        if (a.expr.kind === "StringLit" || a.expr.kind === "Ident" || a.expr.kind === "FieldAccess") {
          ref = this.place(a.expr, `!milo.ref<${STR}>`, false).ref;
        } else {
          // C borrows a temporary only for the call; a callee that keeps the pointer would
          // need it leaked, as legacy does.
          if (this.cx.retainingLibc.has(e.func)) throw new MlirUnsupported("temporary string kept by C");
          const v = this.expr(a.expr);
          if (v.ty !== STR || v.own !== "owned" || this.bitCopies.has(v.ref)) throw new MlirUnsupported("C string of a view");
          ref = this.tempSlot("cstr", STR, t);
          this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${STR}>`);
        }
        if (local || a.expr.kind !== "StringLit" && a.expr.kind !== "Ident" && a.expr.kind !== "FieldAccess")
          this.intrinsic("unique", { ...e, type: { tag: "void" } }, [{ name: "s", type: t, mode: "mut", ref }], ([x]) => ({ kind: "StrUnique", type: { tag: "void" }, span: e.span, str: x }), null);
        params.push({ name, type: t, isRef: true, isRefMut: false });
        args.push(`${ref} : !milo.ref<${STR}>`);
        keys.push("rstring");
        return;
      }
      if (t.tag === "array") {
        params.push({ name, type: { tag: "ptr", inner: t.element }, isRef: false, isRefMut: false });
        args.push(`${this.decay(a.expr).ref} : ${PTR}`);
        keys.push("ptr");
        return;
      }
      const v = this.pend(this.expr(a.expr));
      if (!isScalarTy(v.ty) && v.ty !== PTR) throw new MlirUnsupported(`extern argument of type ${t.tag}`);
      params.push({ name, type: t, isRef: false, isRefMut: false });
      args.push(`${v.ref} : ${v.ty}`);
      keys.push(typeKey(t));
    });
    this.pending = mark;
    const ret = e.type.tag === "void" ? null : this.value(e.type, "extern call result");
    if (ret !== null && !isScalarTy(ret) && ret !== PTR) throw new MlirUnsupported("extern call result type");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const l = this.cx.checkLocation(this.fn.trackedCaller ?? e.span);
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    const name = this.cx.mlirHelper(`milo.ffi.${e.func}.${keys.join(".")}.${l.line}.${l.col}.${fnv1a(l.file)}`, () => {
      const call: HIRExpr = { ...e, args: e.args.map((a, k) => ({ ...a, expr: { kind: "Ident", name: params[k].name, type: params[k].type, isMove: false } })) };
      return { params, retType: e.type, trackedCaller: this.fn.trackedCaller,
        body: [ret === null ? { kind: "ExprStmt", expr: call } : { kind: "Return", retType: e.type, value: call }] };
    });
    return this.callHelper(name, args, ret);
  }

  /**
   * A builtin that only reads its operands (HELPER_BUILTINS): legacy's code for it in a
   * legacy function per builtin, operand shape and call site. A by-ref operand goes as
   * its place; the others are scalars or pointers by value. A string result is owned.
   */
  private builtinCall(e: HIRExpr & { kind: "Call" }, stmt: boolean, lendStrings = false): Val {
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: string[] = [];
    const keys: string[] = [];
    const mark = this.pending;
    e.args.forEach((a, k) => {
      const t = stripRefs(a.expr.type);
      const name = `a${k}`;
      // format reads its string parts: lent from their places, as print lends them.
      if (a.passByRef || (lendStrings && t.tag === "string")) {
        const ty = this.value(t, "builtin operand");
        const r = this.place(a.expr, refOf(ty), a.refMut).ref;
        params.push({ name, type: t, isRef: !a.refMut, isRefMut: !!a.refMut });
        args.push(`${r} : ${refOf(ty)}`);
        keys.push(`r${typeKey(t)}`);
        return;
      }
      const v = this.pend(this.expr(a.expr));
      if (!isScalarTy(v.ty) && v.ty !== PTR) throw new MlirUnsupported(`builtin operand of type ${t.tag}`);
      params.push({ name, type: t, isRef: false, isRefMut: false });
      args.push(`${v.ref} : ${v.ty}`);
      keys.push(typeKey(t));
    });
    this.pending = mark;
    const ret = e.type.tag === "void" || e.type.tag === "never" ? null : this.value(e.type, "builtin result");
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && ret !== STR) throw new MlirUnsupported("builtin result type");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const l = e.span ? this.cx.checkLocation(this.fn.trackedCaller ?? e.span) : null;
    const site = l ? `.${l.line}.${l.col}.${fnv1a(l.file)}` : "";
    const name = this.cx.mlirHelper(`milo.builtin.${e.func}.${keys.join(".")}${site}`, () => {
      const call: HIRExpr = { ...e, args: e.args.map((a, k) => ({ ...a, expr: { kind: "Ident", name: params[k].name, type: params[k].type, isMove: false } })) };
      return { params, retType: ret === null ? { tag: "void" } : e.type, trackedCaller: this.fn.trackedCaller,
        body: [ret === null ? { kind: "ExprStmt", expr: call } : { kind: "Return", retType: e.type, value: call }] };
    });
    const r = this.callHelper(name, args, ret);
    return ret === STR ? { ...r, own: "owned" } : r;
  }

  /**
   * `assert(c, msg)` as legacy's: the message is evaluated only once `c` is false, then
   * legacy's own failure path runs in a helper (`assert(false, msg)`), which never returns.
   */
  private assert(e: HIRExpr & { kind: "Call" }): Val {
    const c = this.expr(e.args[0].expr);
    if (c.ty !== "i1") throw new MlirUnsupported("assert of a non-bool");
    const no: HIRExpr = { kind: "BoolLit", value: false, type: { tag: "bool" }, span: e.args[0].expr.span };
    this.region(`milo.if ${c.ref} {`, () => false);
    this.region("} else {", () => {
      this.builtinCall({ ...e, args: [{ ...e.args[0], expr: no }, ...e.args.slice(1)] }, true, true);
      this.emit("milo.unreachable");
      return true;
    });
    this.emit("}");
    return { ref: "", ty: "" };
  }

  /** `e` never returns: a `never` value, a std panic, or the builtin exit (typed void in HIR). */
  private diverges(e: HIRExpr): boolean {
    return e.type.tag === "never" || e.kind === "StrPanic" || e.kind === "VecPanic" || (e.kind === "Call" && e.func === "exit" && this.cx.isBuiltinName("exit"));
  }

  /**
   * `take(s.f)`: an owning field moved out of a local, as legacy does it: the value read
   * out, then the field zeroed in place (an `init` store, nothing dropped), so the
   * struct's own drop later finds an empty one there and frees nothing twice.
   */
  private moveField(e: HIRExpr & { kind: "FieldAccess" }): Val {
    if (!this.fieldOfOwnedLocal(e)) throw new MlirUnsupported("move out of a field");
    const p = this.fieldPlace(e)!;
    const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
    this.emit(`milo.store ${this.def(`milo.zero : ${p.ty}`, p.ty).ref}, ${p.ref} init : !milo.ref<${p.ty}>`);
    return { ...v, own: "owned" };
  }

  /**
   * `e` is a field (of a field...) of a struct local this function owns, none of whose
   * structs runs a user Drop (which would see the zeroed field).
   */
  private fieldOfOwnedLocal(e: HIRExpr): boolean {
    if (e.kind === "Ident") {
      const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
      return b?.kind === "var" && !!b.owned;
    }
    if (e.kind !== "FieldAccess" || e.object.type.tag !== "struct") return false;
    const st = this.place$(e.object.type, "struct");
    return !this.runsUserDrop(st) && this.fieldOfOwnedLocal(e.object);
  }

  /** `e` names a string this function owns outright (legacy isOwnedLocalPlace). */
  private ownedLocal(e: HIRExpr): boolean {
    if (e.kind === "Ident") {
      const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
      return b?.kind === "var" && !!b.owned;
    }
    return e.kind === "FieldAccess" && stripRefs(e.object.type).tag === "struct" && e.object.type.tag !== "ref" && this.ownedLocal(e.object);
  }

  private call(e: HIRExpr & { kind: "Call" }, stmt: boolean, into?: string): Val {
    // For this call only, not the calls in its arguments.
    const abi = this.abiResult;
    this.abiResult = false;
    if ((e.func === "print" || e.func === "eprint") && this.cx.isBuiltinName(e.func)) return this.print(e);
    if (this.cx.isBuiltinName(e.func)) {
      if (HELPER_BUILTINS.test(e.func)) return this.builtinCall(e, stmt);
      if (e.func === "format") return this.builtinCall(e, stmt, true);
      if (e.func === "assert") return this.assert(e);
      throw new MlirUnsupported(`builtin ${e.func}`);
    }
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    // A string given to a `*u8` param is legacy's C string conversion for any callee, not only an extern.
    if (callee && sig && ((callee.isExtern && e.variadic) || e.args.some((a, i) => !a.passByRef && stripRefs(a.expr.type).tag === "string" && sig.paramTypes[i] === "ptr")))
      return this.ffiCall(e, stmt);
    if (e.variadic) throw new MlirUnsupported("variadic call");
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
    const ret = callee.retType.tag === "void" || sret ? null : abi ? this.abiValue(callee.retType, "call result") : this.value(callee.retType, "call result");
    if (sret) paramTys.unshift(`!milo.ref<${this.place$(callee.retType, "sret result")}>`);
    else if (ret !== null ? sig.retType !== this.cx.llvmType(callee.retType) : sig.retType !== "void") throw new MlirUnsupported("callee signature");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const provenance: (number | null)[] = [];
    const k0 = sret ? 1 : 0;
    const mark = this.pending;
    const args = e.args.map((a, j) => {
      const i = j + k0;
      if (a.passByRef) {
        this.lendingArg = true;
        const ref = this.place(a.expr, paramTys[i], a.refMut);
        this.lendingArg = false;
        refs.push({ ref: ref.ref, mut: a.refMut, ty: paramTys[i] });
        provenance.push(ref.param ?? null);
        return ref.ref;
      }
      if (paramTys[i] === PTR && a.expr.type.tag === "array") { provenance.push(null); return this.decay(a.expr).ref; }
      const v = this.pend(isBig(this.cx, paramTys[i]) ? this.bigArg(a.expr, paramTys[i]) : this.fnAs(this.consume(this.expr(a.expr), "argument"), paramTys[i]));
      if (v.ty !== paramTys[i]) throw new MlirUnsupported("call arg type");
      provenance.push(null);
      return v.ref;
    });
    this.pending = mark;
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
    return { ...this.def(call, ret), own: this.hasDrop(ret) ? "owned" : undefined };
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
    return { name: fn.name === "main" && !cx.mlirMainOk ? MAIN_BODY : fn.name, text: [text, ...em.closures.texts].join("\n"), callees: em.callees, calls: em.calls, closures: em.closures.names };
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
