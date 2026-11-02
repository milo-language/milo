// HIR -> the source-level `milo` MLIR dialect (mlir/Milo.td), as text, for the functions
// the MLIR path compiles through milo-opt (docs/mlir-backend.md). A printer, not a lowering:
// structured control flow stays region ops, `var` stays a slot, Milo's checked arithmetic
// stays one op carrying its trap; every rewrite after this is a milo-opt pass.
//
// `emitMlirFunction` throws `MlirUnsupported` for anything outside the subset the dialect
// covers, so the function stays on legacy codegen; `mlirSupports` is that test alone.

import type { HIRContract, HIRContractCheck, HIRExpr, HIRFunction, HIRPatStep, HIRPatTest, HIRPattern, HIRStmt as HIRStmtBase } from "./hir";
type HIRStmt = HIRStmtBase | HIRContractCheck;
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
  mlirStrViewStep(): string;
  mlirStringOps(): void;
  mlirMapOps(): void;
  mlirContractFail(): void;
  mlirBlockValueOwnsResult(expr: HIRExpr & { kind: "IfExpr" | "MatchExpr" }): boolean;
  mlirClosureParamEscapes(fnName: string, idx: number): boolean;
  mlirPrintHelper(stderr: boolean, parts: { key: string; type: TypeKind }[], partial?: boolean): string;
  hasStringType: boolean;
  hasVecType: boolean;
  mlirDropHelper(key: string, t: TypeKind, structural?: boolean): void;
  mlirVecTailDropHelper(key: string, vec: TypeKind): void;
  mlirHelper(name: string, make: () => Omit<HIRFunction, "name" | "isExtern" | "isVariadic">): string;
  structLayouts: Map<string, { fields: { name: string; typeKind: TypeKind }[] }>;
  mlirEnumLayout(name: string): { size: number; align: number; niche?: { intTy: string; value: string }; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null;
  needsDropCg(t: TypeKind): boolean;
  dropImpls: Set<string>;
  typeSizeOf(t: TypeKind): number;
  // A HashMap slot { i8 state, K, V } as legacy lays it out (hashMapEntryType).
  mapSlotLayout(k: TypeKind, v: TypeKind): { size: number; keyOffset: number; valueOffset: number };
  mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null;
  // libc calls that keep a pointer argument past the call (codegen RETAINING_LIBC).
  readonly retainingLibc: ReadonlySet<string>;
}

// What codegen names main's body behind the green-task wrapper (Codegen.MAIN_BODY_FN).
export const MAIN_BODY = "__milo_main_body";

const CALLBACK_OPS = new Set(["map", "optionAndThen", "optionOrElse", "resultMap", "resultMapErr", "unwrapOrElse", "resultAndThen", "resultOrElse", "resultUnwrapOrElse", "resultContext"]);
const PROBE = !!process.env.MILO_MLIR_PROBE;
const PROBE_SKIPPED = "(skipped by probe)";

export class MlirUnsupported extends Error {
  constructor(readonly reason: string) { super(`mlir: unsupported ${reason}`); }
}

// `*T` for any T: untyped, as the pointee type rides on each access.
const PTR = "!milo.ptr";
// Only ever a literal until drops exist (Milo.td StringType).
const STR = "!milo.string";

/** The dialect's type for a Milo scalar (ints carry signedness), or null. */
export function mlirType(t: TypeKind): string | null {
  // A ranged int is stored as its width (legacy too); every flow into the range is an
  // explicit RangeCheck, and only legacy attaches !range metadata.
  if (t.tag === "int") return `${t.signed ? "si" : "ui"}${t.bits}`;
  if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
  if (t.tag === "bool") return "i1";
  // A C fn pointer (`extern (..) => R`) is a plain pointer, as legacy holds it.
  if (t.tag === "ptr" || t.tag === "cfn") return PTR;
  return null;
}

/**
 * The dialect's element type of a Vec, or of a slice `[T]` (a Vec header that a slice
 * expression makes or a Vec lends, legacy's %Vec), or null.
 */
function vecElem(cx: MlirEmitCtx, t: TypeKind): string | null {
  if (t.tag !== "vec" && !(t.tag === "array" && t.size === null)) return null;
  const e = placeType(cx, t.element);
  return e;
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
    case "ptr": case "cfn": return "ptr";
    case "string": return "string";
    case "vec": return `vec.${typeKey(t.element)}`;
    case "hashmap": return `map.${typeKey(t.key)}.${typeKey(t.value)}`;
    case "heap": return t.inner.tag === "interface" ? `dyn.${t.inner.name}` : `heap.${typeKey(t.inner)}`;
    case "interface": return `dynref.${t.name}`;
    // A plain fn by its signature, as Scalar.cpp typeKey: a helper takes it as a typed
    // param. The param count and `v` for no result keep the dotted key decodable.
    case "fn": if (t.owning) return "ownfn";
      return [`fn${t.params.length}`, ...t.params.map(p => p.tag === "ref" ? `r${typeKey(p)}` : typeKey(p)),
        t.ret.tag === "void" ? "v" : typeKey(t.ret)].join(".");
    case "struct": return `S${t.name}`;
    case "enum": return `E${t.name}`;
    // A slice is lent as a Vec header (!milo.vec), which Scalar.cpp spells `vec`: a plain fn
    // type with a `&[T]` param keys its glue `rvec.T` on both sides.
    case "array": return t.size !== null ? `arr${t.size}.${typeKey(t.element)}` : `vec.${typeKey(t.element)}`;
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

/**
 * Every dialect type the emitter spells, interned once per context (an id per type text),
 * with the per-type decisions below packed into one flag word per id, decided when the
 * type is spelled from a checker type. Data, not a cache: no use recomputes them.
 */
const F_DROP = 1, F_USER_DROP = 2, F_SLOT = 4, F_MEMORY = 8, F_SPELLED = 16, F_SIZED = 32, F_SHARED = 64;
interface TypeTable { ids: Map<string, number>; flags: number[]; from: TypeKind[] }
const tables = new WeakMap<MlirEmitCtx, TypeTable>();

function typeTable(cx: MlirEmitCtx): TypeTable {
  let t = tables.get(cx);
  if (!t) tables.set(cx, t = { ids: new Map(), flags: [], from: [] });
  return t;
}

/** The flags of dialect type `ty`: 0 for one no checker type spelled (a place, a vectail). */
function typeFlags(cx: MlirEmitCtx, ty: string): number {
  const t = typeTable(cx), id = t.ids.get(ty);
  return id === undefined ? 0 : t.flags[id];
}

/**
 * How a value travels, decided here and nowhere else (Clang CodeGen's evaluation kinds,
 * Rust MIR's operand/place split), as two flags of its type:
 * - F_SLOT: a binding of it lives in a slot (a `let`, a param, a match subject read in
 *   place), as legacy keeps an isBigAgg value behind its address;
 * - F_MEMORY: it may not be an SSA operand between positions (128+ bytes, or holding a
 *   fixed array: SROA splits a whole-aggregate load into one op per element, so a struct
 *   holding a big array takes -O2 forever). It is built in its place (`into`), copied
 *   place to place (milo.copy), and is an SSA value only at an ABI boundary, loaded whole
 *   there: a by-value param or result, as legacy's ABI passes it.
 * A 128..512 byte enum is F_SLOT but not F_MEMORY: legacy passes and returns one by value
 * (only structs get sret); a larger one is a place, the size at which SROA's split starts
 * to cost. A type no checker type spelled is a value.
 */
const BIG_ENUM_VALUE_LIMIT = 512;

/**
 * Records checker type `t`'s decisions on the id of its spelling `ty`: what it owns, from
 * the checker's type and never from the text (a type met again inside itself is spelled by
 * name alone, which hides its fields), and how it travels. milo-opt decides what to drop
 * from the dialect type (Milo.cpp needsDrop), so F_DROP must agree with the glue it calls.
 * Two checker types that share a spelling but not an answer mark it F_SHARED: legacy.
 */
function recordType(cx: MlirEmitCtx, ty: string, t: TypeKind): void {
  const tt = typeTable(cx);
  let id = tt.ids.get(ty);
  if (id === undefined) { id = tt.flags.length; tt.ids.set(ty, id); tt.flags.push(0); }
  let f = tt.flags[id];
  if ((f & F_SPELLED) && tt.from[id] === t) return;
  const own = (ownsStructurally(cx, t, []) ? F_DROP : 0) | (runsUserDropT(cx, t, []) ? F_USER_DROP : 0);
  if (!(f & F_SPELLED)) { f |= F_SPELLED | own; tt.from[id] = t; }
  else if ((f & (F_DROP | F_USER_DROP)) !== own) f |= F_SHARED;
  // A type met inside its own fields is spelled by name alone, which says nothing of its size.
  const nameOnly = (t.tag === "struct" || t.tag === "enum") && ty === `!milo.${t.tag}<${quote(t.name)}>`;
  if (!(f & F_SIZED) && !nameOnly) {
    const big = t.tag === "array" || ((t.tag === "struct" || t.tag === "enum") && (cx.typeSizeOf(t) >= 128 || ty.includes("!milo.array<")));
    const memory = big && !(t.tag === "enum" && cx.typeSizeOf(t) < BIG_ENUM_VALUE_LIMIT);
    f |= F_SIZED | (big ? F_SLOT : 0) | (memory ? F_MEMORY : 0);
  }
  tt.flags[id] = f;
}

/** A binding of `ty` lives in a slot (F_SLOT). */
const inSlot = (cx: MlirEmitCtx, ty: string) => (typeFlags(cx, ty) & F_SLOT) !== 0;
/** A `ty` may be an SSA operand away from an ABI boundary (not F_MEMORY). */
const isSsa = (cx: MlirEmitCtx, ty: string) => (typeFlags(cx, ty) & F_MEMORY) === 0;

/** The dialect's type for an SSA operand of `t`: placeType, unless that lives only in places. */
function valueType(cx: MlirEmitCtx, t: TypeKind): string | null {
  const r = placeType(cx, t);
  return r !== null && isSsa(cx, r) ? r : null;
}

interface Owns { drop: boolean; userDrop: boolean }

/** Milo.cpp needsDrop, over the checker's type. */
function ownsStructurally(cx: MlirEmitCtx, t: TypeKind, seen: string[]): boolean {
  switch (t.tag) {
    case "string": case "vec": case "hashmap": case "heap": return true;
    case "fn": return t.owning === true;
    case "array": return t.size !== null && ownsStructurally(cx, t.element, seen);
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
  // A scalar owns nothing, whichever checker types spell it (`i64` and `int<0..9>` share
  // si64) and also when none does (a cast's `mode as u32`).
  if (isScalarTy(ty) || ty === PTR) return { drop: false, userDrop: false };
  const f = typeFlags(cx, ty);
  if (f & F_SHARED) throw new MlirUnsupported("a type whose dialect spelling two checker types share");
  if (f & F_SPELLED) return { drop: (f & F_DROP) !== 0, userDrop: (f & F_USER_DROP) !== 0 };
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
  if (r !== null) recordType(cx, r, t);
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
  // An interface is reached only behind a `&I`: legacy's fat { data, itable } pair, which
  // borrows both (!milo.dynref), never read as the owning `Heap<I>` (!milo.dyn).
  if (t.tag === "interface") return dynRef(t.name);
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
    // A fixed-size array: a place only, at any size (a slice, size null, is a Vec header
    // that a slice expression makes: not yet). What it owns is its element's.
    const e = t.size === null ? null : placeType(cx, t.element);
    if (e === null) return null;
    return `!milo.array<${e}, ${t.size}>`;
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
  return r;
}

/**
 * A non-owning fn value `(T) => R` as !milo.fn; null for an owning (`move`) one, whose
 * environment is heap memory with drop glue, and for a param the dialect lacks.
 */
function fnType(cx: MlirEmitCtx, t: TypeKind & { tag: "fn" }): string | null {
  const ps = t.params.map(p => closureParamType(cx, p));
  if (ps.some(x => x === null)) return null;
  // A by-value param or result is an ABI boundary: one that lives in memory (Repr) is still
  // passed as one SSA value, as legacy's closureParamTy (llvmType) passes it.
  const r = t.ret.tag === "void" ? "()" : placeType(cx, t.ret);
  return r === null ? null : `!milo.fn<${t.owning ? "owning " : ""}(${ps.join(", ")}) -> ${r}>`;
}

/** A closure param: a `&T` is the place (legacy closureParamTy passes a pointer). */
function closureParamType(cx: MlirEmitCtx, p: TypeKind): string | null {
  return p.tag === "ref" ? lentType(cx, p.inner) : placeType(cx, p);
}

/**
 * The one answer to what a by-ref argument of `t` is lent as (legacy passes its address): a
 * Vec's or a slice's header place (!milo.vec), anything else's !milo.ref, a 128+ byte
 * struct like any other; null for a type the dialect lacks.
 */
function lentType(cx: MlirEmitCtx, t: TypeKind): string | null {
  t = stripRefs(t);
  const e = vecElem(cx, t);
  if (e !== null) return `!milo.vec<${e}>`;
  if (t.tag === "vec" || t.tag === "array" && t.size === null) return null;
  const v = placeType(cx, t);
  return v && `!milo.ref<${v}>`;
}

// Its own `impl Drop`; one on a field's type makes that field's valueType null.
const hasUserDrop = (cx: MlirEmitCtx, t: TypeKind & { name: string }) => cx.dropImpls.has(t.name);

function aggregateType(cx: MlirEmitCtx, t: TypeKind & { tag: "struct" | "enum" }): string | null {
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
  const shape = l.niche ? `niche = ${l.niche.value} : ${l.niche.intTy}` : `size = ${l.size}, align = ${l.align}`;
  return `!milo.enum<${quote(t.name)}${drop}, ${shape}, [${variants.join(", ")}]>`;
}

/**
 * A returned view (`&string`, `&[T]`: a method's view of its own receiver, which the
 * checker keeps frozen while the view lives): legacy returns the header by value, so the
 * function's result is that header, a view nobody drops. Null for any other type.
 */
function viewResult(cx: MlirEmitCtx, t: TypeKind): string | null {
  if (t.tag !== "ref" || t.mutable) return null;
  if (t.inner.tag === "string") return STR;
  if (t.inner.tag === "array" && t.inner.size === null) {
    const e = vecElem(cx, { tag: "vec", element: t.inner.element } as TypeKind);
    return e === null ? null : `!milo.vecval<${e}>`;
  }
  return null;
}

const dynRef = (iface: string) => `!milo.dynref<${quote(iface)}>`;

const isTempBox = (op: HIRExpr) => op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "HeapCreate";

function stripRefs(t: TypeKind): TypeKind {
  while (t.tag === "ref") t = t.inner;
  return t;
}

/** Why placeType rejects `t`: the innermost field type it refuses, with the path to it. */
function placeBlocker(cx: MlirEmitCtx, t: TypeKind, depth = 0): string {
  if (depth > 4) return t.tag;
  const inner = (u: TypeKind) => `${t.tag} (${placeBlocker(cx, u, depth + 1)})`;
  switch (t.tag) {
    case "vec": return vecElem(cx, t) === null ? inner(t.element) : "vec";
    case "heap": return inner(t.inner);
    case "hashmap": return inner(placeType(cx, t.key) === null ? t.key : t.value);
    case "array": return t.size === null ? "slice" : inner(t.element);
    case "fn": return t.owning ? "owning fn" : "fn";
    case "struct": case "enum": {
      const bad = fieldTypes(cx, t).find(f => placeType(cx, f) === null);
      return bad ? inner(bad) : t.tag;
    }
    default: return t.tag;
  }
}

/** Why valueType rejects `t`: its tag, and for an aggregate what inside it blocks it. */
function blocker(cx: MlirEmitCtx, t: TypeKind, depth = 0, seen: string[] = []): string {
  if (t.tag === "int") return "ranged int";
  if (t.tag === "vec" && depth <= 3) return `vec (${blocker(cx, t.element, depth + 1, seen)})`;
  if ((t.tag !== "struct" && t.tag !== "enum") || depth > 3) return t.tag;
  if (seen.includes(t.name)) return "recursive";
  const why = cx.typeSizeOf(t) >= 128 ? "128+ bytes" : null;
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

/**
 * A literal pattern's value as the expression it is compared with, of the payload's type
 * `ty`. An int pattern on a float payload (`A(3)` with an f64 field) is a float, as legacy
 * compares it.
 */
function patLiteral(kind: (HIRPattern & { kind: "LiteralPattern" })["literalKind"], value: bigint | number | string | boolean, ty: TypeKind): HIRExpr {
  if (kind === "float" || (kind === "int" && ty.tag === "float")) return { kind: "FloatLit", value: Number(value), type: ty };
  switch (kind) {
    case "string": return { kind: "StringLit", value: String(value), type: ty };
    case "bool": return { kind: "BoolLit", value: !!value, type: ty };
    case "char": return { kind: "CharLit", value: Number(value), type: ty };
    default: return { kind: "IntLit", value: BigInt(value as bigint), type: ty };
  }
}

function quote(s: string): string {
  return quoteBytes(Buffer.from(s, "utf-8"));
}

/**
 * A string literal's bytes: UTF-8, except the lexer's sentinel for a `\xNN` escape (U+F780
 * to U+F7FF, as legacy escapeCString reads it), which is the one raw byte NN.
 */
function literalBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xF780 && c <= 0xF7FF) out.push(c - 0xF700);
    else out.push(...Buffer.from(ch, "utf-8"));
  }
  return Uint8Array.from(out);
}

function quoteBytes(bytes: Uint8Array): string {
  let out = "";
  for (const ch of bytes) {
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
// `zeroOnMove`: an owned element of a consumed array, whose slot drops every element after
// the loop: a move takes it and leaves the zero value (legacy zeroes a moved element too).
// `view`: a `var` of a `&T` or slice type, a slot of view headers that owns none of them:
// an assignment replaces the header and drops nothing.
type Binding = { kind: "ssa"; v: Val } | { kind: "var"; ref: string; ty: string; param?: number; owned?: boolean; zeroOnMove?: boolean; view?: boolean }
  | { kind: "vec"; ref: string; elem: string; param?: number } | { kind: "opaque"; what: string }
  // A `&T` reached through a raw pointer (`let p = b else` on a `?&mut T`): the dialect
  // has no milo.ref behind a pointer, so it is read and written through the pointer
  // (ptrPlace) and lent only to a call (milo.ptr.lend); any other use keeps it legacy.
  | { kind: "ptr"; ptr: string; ty: string };

// How one match arm makes its bindings (FnEmitter.armBinder). `view`: the binding reads
// the subject's memory (a payload place, or a copy of a payload with drop glue).
interface ArmBinder {
  bind(name: string, b: Binding, view: boolean): void;
  owned(name: string, ty: string, t: TypeKind): string;
}
// The block a match sits in: an escaping binding's scope and owner.
interface MatchOuter { scope: Map<string, Binding>; frame: number }

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
  // Which frames of `owned` are blocks' (a region, an unsafe block, a loop's own), innermost last;
  // the others are a statement's, a call's or an operator's (tempSlot).
  private blocks: number[] = [0];
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
    // A closure body runs per call: a closure it builds keeps a frame env (legacy scopes
    // staticEnv by currentFnName, which a closure body never is).
    this.inClosureBody = true;
    const params = ["%env: !milo.ptr"];
    caps.forEach((c, i) => {
      const r = this.def(`milo.env.capture %env[${i}] : ${c.place}`, c.place).ref;
      this.bind(c.name, c.b.kind === "vec" ? { kind: "vec", ref: r, elem: c.b.elem } : { kind: "var", ref: r, ty: (c.b as { ty: string }).ty });
    });
    e.params.forEach((p, i) => {
      const ty = closureParamType(this.cx, p.type);
      if (ty === null) throw new MlirUnsupported(`closure param of type ${placeBlocker(this.cx, stripRefs(p.type))}`);
      params.push(`%p${i}: ${ty}`);
      if (ty.startsWith("!milo.vec<")) this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem: ty.slice(10, -1) });
      else if (p.type.tag === "ref") this.bind(p.name, { kind: "var", ref: `%p${i}`, ty: ty.slice(10, -1) });
      else this.bindParam(p.name, `%p${i}`, ty, p.type);
    });
    // A result that lives in memory (Repr) leaves as one SSA value, as a function's does.
    const ret = e.retType.tag === "void" ? null : this.place$(e.retType, "closure result");
    this.retTy = ret;
    // A sortByKey extractor may hand back a field of its borrowed element (checker [MILO-O-keyExtractor]
    // keyExtractorClosures): the sort only reads the key and forgets it, so the view's bits
    // are the result, as legacy returns them.
    if (e.keyExtractor) { this.retView = ret; this.keyBody = true; }
    this.retPlaceOnly = ret !== null && !isSsa(this.cx, ret);
    const jumped = this.stmts(e.body);
    this.closeScope(0, jumped, null);
    if (!jumped) this.emit(ret === null ? "milo.return" : "milo.unreachable");
    const head = `func.func @${quote(name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} attributes {llvm.linkage = #llvm.linkage<internal>} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  /**
   * A by-value param `ref` of `t` (`ty`, the ABI's SSA value), bound as legacy's prologue
   * keeps it: one that owns goes to an owned slot of the body's scope (the callee owns it),
   * one that lives in memory (Repr) to a slot of its own, and is only a place from there.
   */
  private bindParam(name: string, ref: string, ty: string, t: TypeKind): void {
    if (!this.hasDrop(ty) && !inSlot(this.cx, ty)) { this.bind(name, { kind: "ssa", v: { ref, ty } }); return; }
    const owned = this.hasDrop(ty);
    let slot: string;
    if (owned) slot = this.ownedSlot(name, ty, t);
    else {
      slot = this.fresh();
      this.vars.push(`  ${slot} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    }
    this.emit(`milo.store ${ref}, ${slot} : !milo.ref<${ty}>`);
    this.bind(name, { kind: "var", ref: slot, ty, owned });
  }

  run(): string {
    const fn = this.fn;
    if (fn.isExtern) throw new MlirUnsupported("extern fn");
    if (fn.isVariadic) throw new MlirUnsupported("variadic fn");
    // main's prologue (argc/argv, global init, stdout buffering) is legacy codegen's; the
    // splice keeps it. Behind a green-task wrapper main's body is MAIN_BODY, which the
    // wrapper's task calls with nothing and takes its i32 as the exit code.
    const isMain = fn.name === "main";
    // `fn main(): i32` returns its exit code, as legacy's main does; a void main returns 0.
    const mainI32 = isMain && fn.retType.tag === "int" && fn.retType.bits === 32 && fn.retType.signed && fn.retType.min === undefined && fn.retType.max === undefined;
    if (isMain && (fn.params.length || (fn.retType.tag !== "void" && !mainI32))) throw new MlirUnsupported("main");
    const green = isMain && !this.cx.mlirMainOk;
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
        this.bind(p.name, { kind: "opaque", what: placeBlocker(this.cx, p.type) });
        return `%p${i}: ${PTR}`;
      }
      const pt = placeType(this.cx, p.type);
      const ty = p.isRef || p.isRefMut ? pt! : this.place$(p.type, "param");
      if (p.isRef || p.isRefMut) {
        this.bind(p.name, { kind: "var", ref: `%p${i}`, ty, param: i });
        return `%p${i}: !milo.ref<${ty}>`;
      }
      this.bindParam(p.name, `%p${i}`, ty, p.type);
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
    this.retView = isMain ? null : viewResult(this.cx, fn.retType);
    const ret = isMain ? "si32" : fn.retType.tag === "void" || this.sretOut ? null : this.retView ?? this.place$(fn.retType, "return");
    this.retPlaceOnly = ret !== null && !isMain && valueType(this.cx, fn.retType) === null;
    this.isMain = isMain;
    this.retTy = ret;
    // As legacy replayEngineScope, which applies only when std/replay is in the program.
    this.replay = !!fn.replayEngine && this.cx.replayScope;
    if (this.replay) this.emit("milo.replay.enter");
    // A contract-checking build (legacy genFunction): the old(...) snapshots, then every
    // requires clause, at entry; the ensures clauses at every return (ret).
    if (this.cx.contractChecks && (fn.contracts?.length || fn.oldSnapshots?.length)) {
      this.cx.mlirContractFail();
      if (fn.oldSnapshots && this.stmts(fn.oldSnapshots)) throw new MlirUnsupported("old() snapshot that jumps");
      for (const c of fn.contracts ?? []) if (c.kind === "requires") this.contractCheck(c.kind, c.expr, c.span);
      this.ensures = (fn.contracts ?? []).filter(c => c.kind === "ensures");
    }
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
    if (e.kind === "OptionOp" && e.op !== "resultContext" && this.combinatorMatch(e, { dst, ty })) return;
    if (e.kind === "MemReplace") {
      // Legacy genMemReplace's big path: the old value's bits move to `dst` (the result), [MILO-O-replaceSwap]
      // then `v` is built over the place with nothing dropped. Until then both hold the
      // same bits, so no jump may come between (a held pending).
      const p = this.place(e.place, `!milo.ref<${ty}>`, true).ref;
      this.emit(`milo.copy ${p}, ${dst} : !milo.ref<${ty}>, !milo.ref<${ty}> of ${ty}`);
      const mark = this.pending.length;
      if (this.hasDrop(ty)) this.pending.push({ ref: dst, ty, t: e.type, place: true, hold: true });
      this.into(e.value, p, ty);
      this.pending.length = mark;
      return;
    }
    // isSretCall narrowed Call away; a call that is not sret returns a place-only value.
    const c = e as HIRExpr;
    if ((c.kind === "Call" && !this.cx.isBuiltinName(c.func)) || c.kind === "ClosureCall") {
      this.abiResult = true;
      const v = this.callScope(() => c.kind === "Call" ? this.call(c, false) : this.closureCall(c, false));
      this.abiResult = false;
      this.emit(`milo.store ${this.take(v, ty, "call result").ref}, ${dst} init : !milo.ref<${ty}>`);
      return;
    }
    if (e.kind === "Unwrap") { this.unwrapInto(e, dst, ty); return; }
    if (e.kind !== "StructLit") throw new MlirUnsupported(`128+ byte value other than a literal or an sret call: ${e.kind}`);
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout || this.place$(e.type, "struct literal") !== ty) throw new MlirUnsupported("struct literal layout");
    const given = new Map<string, Val>();
    const mark = this.pending.length;
    for (const f of e.fields) {
      const i = layout.fields.findIndex(lf => lf.name === f.name);
      const lt = layout.fields[i]?.typeKind;
      const pty = lt && valueType(this.cx, lt) === null ? placeType(this.cx, lt) : null;
      if (pty === null) { given.set(f.name, this.pend(this.fieldValue(f.value, lt), f.value.type)); continue; }
      // A field that is a place only (an array) is built in its own place, in source order.
      const fr = this.def(`milo.field_ref ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${pty}>`, `!milo.ref<${pty}>`).ref;
      this.into(f.value, fr, pty);
      // An owning one built in place is owned by nothing until the whole struct is: a
      // jump out of a later field would leak it, so it counts as a pending operand.
      if (this.hasDrop(pty)) this.pending.push({ ref: fr, ty: pty, t: lt, place: true });
      given.set(f.name, { ref: "", ty: pty });
    }
    this.pending.length = mark;
    // A struct update's base (`..base`), after the listed fields, as legacy
    // genStructUpdateBase: in a slot of the statement, then field by field in layout order,
    // a listed field's base value dropped, an unlisted one moved across; the base's slot is
    // then emptied, every field having one owner. [MILO-O-structUpdate]
    const base = e.base ? this.bigSlot("update.base", e.base, true) : null;
    if (base && base.ty !== ty) throw new MlirUnsupported("struct update base of another type");
    const fieldRef = (of: string, i: number, fty: string) => this.def(`milo.field_ref ${of}[${i}] : !milo.ref<${ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`).ref;
    layout.fields.forEach((f, i) => {
      const g = given.get(f.name);
      if (base) {
        const fty = this.place$(f.typeKind, "field");
        const from = fieldRef(base.ref, i, fty);
        if (g) {
          if (this.hasDrop(fty)) { this.dropGlue(fty, f.typeKind); this.emit(`milo.drop ${from} : !milo.ref<${fty}>`); }
        } else {
          const to = fieldRef(dst, i, fty);
          if (valueType(this.cx, f.typeKind) === null || inSlot(this.cx, fty)) this.emit(`milo.copy ${from}, ${to} : !milo.ref<${fty}>, !milo.ref<${fty}> of ${fty}`);
          else this.emit(`milo.store ${this.def(`milo.load ${from} : !milo.ref<${fty}>`, fty).ref}, ${to} init : !milo.ref<${fty}>`);
          return;
        }
      }
      if (g?.ref === "") return;
      const fty = this.value(f.typeKind, "field");
      const v = this.take(g ?? { ref: "", ty: "" }, fty, "struct literal field", true);
      this.emit(`milo.store ${v.ref}, ${fieldRef(dst, i, fty)} init : !milo.ref<${fty}>`);
    });
    if (base?.owned) this.def(`milo.move ${base.ref} : !milo.ref<${ty}>`, ty);
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
    const mark = this.pending.length;
    e.args.forEach((a, k) => {
      const fty = this.place$(v.fields[k], "payload");
      const r = this.def(`milo.enum.field_ref ${dst}[${v.tag}, ${k}] : !milo.ref<${ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`).ref;
      if (valueType(this.cx, v.fields[k]) === null) this.into(a, r, fty);
      else {
        const x = this.operand(a, fty, "payload");
        this.emit(`milo.store ${x.ref}, ${r} init : !milo.ref<${fty}>`);
      }
      if (this.hasDrop(fty)) this.pending.push({ ref: r, ty: fty, t: v.fields[k], place: true });
    });
    this.pending.length = mark;
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

  /**
   * A struct literal's field value. A named function given to a C fn-pointer field (an
   * extern struct's ops table) is the function's own symbol, as legacy stores it.
   */
  private fieldValue(x: HIRExpr, ft: TypeKind | undefined): Val {
    if (ft?.tag === "cfn" && x.kind === "Ident" && x.type.tag === "fn" && this.fns.has(x.name) && !this.scopes.some(m => m.has(x.name))) {
      const u8p: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
      return this.fnAddress({ kind: "Cast", operand: x, targetType: u8p, type: u8p } as HIRExpr & { kind: "Cast" });
    }
    return this.consume(this.expr(x), "field");
  }

  /** An i8/i16/i32 bound as i64, sign or zero extended by its type (legacy genBoundI64). */
  private widenBound(v: Val): Val {
    const m = /^([su])i(8|16|32)$/.exec(v.ty);
    if (!m) return v;
    if (m[1] === "s") return this.def(`milo.cast ${v.ref} : ${v.ty} to si64`, "si64");
    const u = this.def(`milo.cast ${v.ref} : ${v.ty} to ui64`, "ui64");
    return this.def(`milo.cast ${u.ref} : ui64 to si64`, "si64");
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
    const ety = this.place$(t.element, "array element");
    const at = (i: string) => this.def(`milo.array.index ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${ety}>`, `!milo.ref<${ety}>`, this.loc(e.span)).ref;
    if (e.kind === "ArrayLit") {
      if (e.elements.length !== t.size) throw new MlirUnsupported("array literal of another size");
      // A stored owning element is owned by nothing until the array's place is: pending,
      // as a field of a struct literal built in place.
      const mark = this.pending.length;
      e.elements.forEach((x, k) => {
        const r = at(this.def(`milo.const ${k} : si64`, "si64").ref);
        if (valueType(this.cx, t.element) === null) this.into(x, r, ety);
        else {
          const v = this.operand(x, ety, "array element");
          this.emit(`milo.store ${v.ref}, ${r} init : !milo.ref<${ety}>`);
        }
        if (this.hasDrop(ety)) this.pending.push({ ref: r, ty: ety, t: t.element, place: true });
      });
      this.pending.length = mark;
      return;
    }
    if (valueType(this.cx, t.element) === null) throw new MlirUnsupported("array repeat of a place-only value");
    if (e.count !== t.size) throw new MlirUnsupported("array repeat of an owning value");
    const v = this.take(this.expr(e.value), ety, "array element");
    if (e.cloneFn && !this.hasDrop(ety)) throw new MlirUnsupported("array repeat through a user Clone of a plain value");
    // Legacy's genArrayRepeat deep clones an owning value into all slots but the last;
    // one bit copy per slot would free the value N times.
    if (this.hasDrop(ety)) {
      // So here: the value parks in a slot that owns nothing, slots 0..n-2 get structural
      // clones of it (copyOut, legacy's emitDeepCloneFromPtr), the last gets the value.
      if (e.count === 0) {
        // No slot takes it: dropped right here, as legacy's emitDropValue of it. [MILO-O-arrayRepeat]
        this.owned.push([]);
        const start = this.body.length;
        this.emit(`milo.store ${v.ref}, ${this.ownedSlot("repeat.none", ety, e.value.type)} : !milo.ref<${ety}>`);
        this.closeScope(start, false, null);
        return;
      }
      // Clones are needed only for the slots before the last: a user Drop then needs its Clone.
      if (e.count > 1 && !e.cloneFn && this.runsUserDrop(ety)) throw new MlirUnsupported("array repeat of a value with a user Drop and no Clone");
      const park = this.fresh();
      this.vars.push(`  ${park} = milo.var "repeat.of" : !milo.ref<${ety}>`);
      this.emit(`milo.store ${v.ref}, ${park} : !milo.ref<${ety}>`);
      const iv = this.fresh();
      this.region(`milo.for ${this.def("milo.const 0 : si64", "si64").ref} to ${this.def(`milo.const ${e.count - 1} : si64`, "si64").ref} : si64 {`, () => {
        this.emit(`^bb0(${iv}: si64):`);
        // The type's own Clone when the checker found one (legacy emitCloneFnCall).
        const c = e.cloneFn ? this.cloneCall(e.cloneFn, park, ety, e.value.type) : this.copyOut(e.value, park, ety, true);
        this.emit(`milo.store ${c.ref}, ${at(iv)} init : !milo.ref<${ety}>`);
        return false;
      });
      this.emit("}");
      const last = this.def(`milo.const ${e.count - 1} : si64`, "si64").ref;
      this.emit(`milo.store ${this.def(`milo.load ${park} : !milo.ref<${ety}>`, ety).ref}, ${at(last)} init : !milo.ref<${ety}>`);
      return;
    }
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
   * `o.map(f)` and the other closure-taking Option/Result ops: legacy's genOptionOp (the
   * tag test, the conditional call, the result enum) in a helper, the receiver lent by its
   * place and the closure passed as its value. The checker consumes a receiver exactly
   * when the op forwards a payload that owns something (consumeForwardedPayload; context [MILO-O-combinatorReceiver]
   * always): such a receiver moves into the helper and the op there takes it (`isMove`).
   * A named one it did not consume is lent; a temporary one goes in by value unmoved, so
   * the helper drops it after the op, as legacy drops a temporary receiver.
   */
  /**
   * `o.map(f)` and the other callback combinators as the match each one means, so no
   * helper is needed: the receiver is the subject (a temporary or a moved one is consumed,
   * a named one the checker did not consume is matched in place), its payload binding is
   * handed to `f` (by reference when `f` takes `&T`), and the untouched variant is
   * forwarded as is. `f` is evaluated once, before the match, as legacy builds it.
   * [MILO-O-combinatorReceiver]
   */
  private combinatorMatch(e: HIRExpr & { kind: "OptionOp" }, into?: { dst: string; ty: string }): Val | null {
    const shapes: Record<string, { hit: string; miss: string; call: "hit" | "miss"; wrap: boolean; unwrap?: boolean }> = {
      map: { hit: "Some", miss: "None", call: "hit", wrap: true },
      optionAndThen: { hit: "Some", miss: "None", call: "hit", wrap: false },
      optionOrElse: { hit: "Some", miss: "None", call: "miss", wrap: false },
      resultMap: { hit: "Ok", miss: "Err", call: "hit", wrap: true },
      resultAndThen: { hit: "Ok", miss: "Err", call: "hit", wrap: false },
      resultMapErr: { hit: "Ok", miss: "Err", call: "miss", wrap: true },
      resultOrElse: { hit: "Ok", miss: "Err", call: "miss", wrap: false },
      unwrapOrElse: { hit: "Some", miss: "None", call: "miss", wrap: false, unwrap: true },
      resultUnwrapOrElse: { hit: "Ok", miss: "Err", call: "miss", wrap: false, unwrap: true },
    };
    const sh = shapes[e.op];
    if (!sh || !e.default || e.type.tag === "void") return null;
    const src = this.cx.mlirEnumLayout(e.enumName);
    const res = e.type.tag === "enum" ? this.cx.mlirEnumLayout(e.type.name) : null;
    const hitV = src?.variants.find(v => v.name === sh.hit), missV = src?.variants.find(v => v.name === sh.miss);
    if (!hitV || !missV || hitV.fields.length > 1 || missV.fields.length > 1) return null;
    const ft = stripRefs(e.default.type);
    if (ft.tag !== "fn") return null;
    // The callback, once: an SSA binding the arms call.
    const cb = `comb$f${this.n++}`;
    this.bind(cb, { kind: "ssa", v: this.consume(this.expr(e.default), "combinator callback") });
    const cbId: HIRExpr = { kind: "Ident", name: cb, type: e.default.type, isMove: false };
    const n = this.n++;
    // A named receiver the checker did not consume is matched in place: its bindings are
    // views, read (its forwarded payload is Copy, by the checker's rule), never moved.
    const k = e.value.kind;
    const owning = !((k === "Ident" || k === "FieldAccess") && !(e.value as { isMove?: boolean }).isMove);
    const bindOf = (v: typeof hitV, name: string) => v.fields.length ? [{ name, type: v.fields[0]! }] : [];
    const call = (v: typeof hitV, name: string): HIRExpr => {
      const byRef = ft.params[0]?.tag === "ref";
      const args = v.fields.length && ft.params.length ? [{ expr: { kind: "Ident" as const, name, type: v.fields[0]!, isMove: owning && !byRef }, passByRef: byRef, refMut: false }] : [];
      return { kind: "ClosureCall", callee: cbId, args, type: ft.ret, span: e.span };
    };
    const lit = (variant: string, args: HIRExpr[]): HIRExpr => {
      const rv = res?.variants.find(v => v.name === variant);
      if (!rv) throw new MlirUnsupported(`combinator result variant ${variant}`);
      return { kind: "EnumLit", enumName: (e.type as { name: string }).name, variant, args, type: e.type };
    };
    const arm = (v: typeof hitV, isHit: boolean) => {
      const name = `comb$${isHit ? "x" : "e"}${n}`;
      const mine = (sh.call === "hit") === isHit;
      const bound: HIRExpr = { kind: "Ident", name, type: v.fields[0] ?? e.type, isMove: owning };
      const value: HIRExpr = mine
        ? (sh.wrap ? lit(v.name, [call(v, name)]) : call(v, name))
        : sh.unwrap ? bound : lit(v.name, v.fields.length ? [bound] : []);
      return { pattern: { kind: "EnumPattern" as const, variant: v.name, tag: v.tag, bindings: bindOf(v, name) }, body: [{ kind: "ExprStmt" as const, expr: value }] };
    };
    const arms = [arm(hitV, true), arm(missV, false)];
    this.forks.push({ mode: null, sawView: false });
    try {
      // A 128+ byte result is built in its place, each arm's value into it.
      if (into) return this.match({ subject: e.value, arms, subjectIsRef: !owning }, null, b => this.tailInto(b, into.dst, into.ty)).v;
      return this.match({ subject: e.value, arms, subjectIsRef: !owning }, this.value(e.type, "combinator result")).v;
    } finally { this.forks.pop(); }
  }

  private optionCallback(e: HIRExpr & { kind: "OptionOp" }): Val {
    if (e.op !== "resultContext") { const m = this.combinatorMatch(e); if (m) return m; }
    const st = stripRefs(e.value.type);
    const rt = this.place$(st, "option receiver");
    if (!e.default) throw new MlirUnsupported(`option op ${e.op} without a callback`);
    const fty = this.value(e.default.type, "option callback");
    const ty = this.value(e.type, "option result");
    const named = e.value.kind === "Ident" || e.value.kind === "FieldAccess";
    const consumed = this.combinatorConsumes(e.op, st);
    if (named && !!(e.value as { isMove?: boolean }).isMove !== consumed && this.hasDrop(rt))
      throw new MlirUnsupported(`option op ${e.op} whose receiver move disagrees with the checker's rule`);
    if (this.hasDrop(rt) && !(named && !consumed)) {
      if (inSlot(this.cx, rt)) throw new MlirUnsupported(`option op ${e.op} on a 128+ byte owning receiver`);
      const mark = this.pending.length;
      const v = this.pend(this.operand(e.value, rt, "option receiver"), st);
      const f = this.consume(this.expr(e.default), "option callback");
      this.pending.length = mark;
      if (f.ty !== fty) throw new MlirUnsupported("option callback type");
      const r = this.intrinsic(`opt.${consumed ? "own" : "tmp"}.${e.op}`, e, [{ name: "o", type: st, mode: "val", ref: v.ref }, { name: "f", type: e.default.type, mode: "val", ref: f.ref }],
        ([x, y]) => ({ ...e, value: { ...x, isMove: consumed } as HIRExpr, default: { ...y, isMove: this.hasDrop(fty) } as HIRExpr }), ty);
      return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
    }
    const o = this.place(e.value, this.lent(st, "option receiver"), false).ref;
    const f = this.consume(this.expr(e.default), "option callback");
    if (f.ty !== fty) throw new MlirUnsupported("option callback type");
    const r = this.intrinsic(`opt.${e.op}`, e, [{ name: "o", type: st, mode: "ref", ref: o }, { name: "f", type: e.default.type, mode: "val", ref: f.ref }],
      ([x, y]) => ({ ...e, value: x, default: { ...y, isMove: this.hasDrop(fty) } as HIRExpr }), ty);
    return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /** Whether the checker's consumeForwardedPayload consumes the receiver of `op` on `st`. */
  private combinatorConsumes(op: string, st: TypeKind): boolean {
    if (op === "resultContext") return true;
    const fwd = ({ optionOrElse: "Some", resultMap: "Err", resultAndThen: "Err", resultMapErr: "Ok", resultOrElse: "Ok" } as Record<string, string>)[op];
    if (!fwd || st.tag !== "enum") return false;
    const v = this.cx.mlirEnumLayout(st.name)?.variants.find(x => x.name === fwd);
    if (!v) throw new MlirUnsupported(`option op ${op} receiver layout`);
    return v.fields.some(t => this.hasDrop(this.place$(t, "forwarded payload")));
  }

  /** `clone(&*slot)` through the type's own Clone fn: an owned value of `ty`. */
  private cloneCall(fn: string, slot: string, ty: string, t: TypeKind): Val {
    const name = `repeat$of${this.n++}`;
    this.bind(name, { kind: "var", ref: slot, ty });
    const v = this.expr({ kind: "Call", func: fn, args: [{ expr: { kind: "Ident", name, type: t, isMove: false }, passByRef: true, refMut: false }], type: t, variadic: false });
    if (v.ty !== ty) throw new MlirUnsupported("clone result type");
    return v;
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
        if (e.kind !== "FieldAccess" || !e.isMove || !this.fieldOfOwnedLocal(e)) throw new MlirUnsupported(`move out of a field (128+, ${this.moveRoot(e)})`);
        const p = this.fieldPlace(e)!;
        if (p.ty !== ty) return null;
        if (this.runsUserDrop(ty)) {
          this.partialMove(e);
          return { ref: p.ref, refTy: `!milo.ref<${ty}>`, done: () => { this.def(`milo.move ${p.ref} : !milo.ref<${ty}>`, ty); } };
        }
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
      // A Vec element: legacy deep-copies an owning one (emitDeepCloneFromPtr), here into
      // a fresh slot by a legacy helper. The slot owns nothing: every bigPlace consumer
      // takes what the place holds, so the clone passes to it whole.
      const er = this.elemRef(e);
      if (er && er.ty === ty && this.hasDrop(ty)) {
        const tmp = this.fresh();
        this.vars.push(`  ${tmp} = milo.var "elem.copy" : !milo.ref<${ty}>`);
        const t = stripRefs(e.type);
        const name = `milo.intr.elemcopy.${typeKey(t)}`;
        this.cx.mlirHelper(name, () => {
          const id = (n: string): HIRExpr => ({ kind: "Ident", name: n, type: t, isMove: false });
          return {
            params: [{ name: "d", type: t, isRef: false, isRefMut: true }, { name: "s", type: t, isRef: true, isRefMut: false }],
            retType: { tag: "void" }, trackedCaller: this.fn.trackedCaller,
            body: [{ kind: "Assign", target: id("d"), value: { kind: "MapCopyOut", type: t, value: id("s") }, isInit: true }],
          };
        });
        const fnTy = `(!milo.ref<${ty}>, !milo.ref<${ty}>) -> ()`;
        this.callees.set(name, fnTy);
        this.emit(`func.call @${quote(name)}(${tmp}, ${er.ref}) : ${fnTy}`);
        return { ref: tmp, refTy: `!milo.ref<${ty}>`, done: none };
      }
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
  private bigSlot(name: string, e: HIRExpr, temp = false, block = false): { ref: string; ty: string; owned: boolean } {
    const ty = this.place$(e.type, "value");
    const owned = this.hasDrop(ty);
    let ref: string;
    if (owned) ref = temp ? this.tempSlot(name, ty, e.type, undefined, false, block) : this.ownedSlot(name, ty, e.type);
    else {
      ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    }
    this.into(e, ref, ty);
    if (owned) this.emit(`milo.filled ${ref} : !milo.ref<${ty}>`);
    return { ref, ty, owned };
  }
  /**
   * A place-only value copied over `dst`, which holds one: legacy's big Assign (the value
   * already evaluated into `src`, then the old one dropped, then the memcpy). An owned
   * slot's drop is "if it holds one" (milo-elaborate-drops), and the slot is full after.
   */
  private overwriteBig(dst: string, ty: string, t: TypeKind, src: { ref: string; refTy: string; done: () => void }, ownedSlot: boolean): void {
    if (this.hasDrop(ty)) {
      this.dropGlue(ty, t);
      this.emit(`milo.drop ${dst} : !milo.ref<${ty}>`);
    }
    this.emit(`milo.copy ${src.ref}, ${dst} : ${src.refTy}, !milo.ref<${ty}> of ${ty}`);
    src.done();
    if (ownedSlot && this.hasDrop(ty)) this.emit(`milo.filled ${dst} : !milo.ref<${ty}>`);
  }

  /** `p = p` (an Ident or a field chain): legacy skips the drop and the store. */
  private lvalueSame(a: HIRExpr, b: HIRExpr): boolean {
    if (a.kind === "Ident" && b.kind === "Ident") return a.name === b.name;
    if (a.kind === "FieldAccess" && b.kind === "FieldAccess") return a.field === b.field && this.lvalueSame(a.object, b.object);
    return false;
  }

  private isMain = false;
  private retTy: string | null = null;
  private retView: string | null = null;
  // A sortByKey extractor's body: its key is a borrow of the element or, when it builds
  // one, owned (the checker then sorts with sortByKeyOwned, which drops it).
  private keyBody = false;
  private inClosureBody = false;
  private retPlaceOnly = false;
  // Set by into() for the call it is about to emit: its place-only result may be an SSA
  // value, the ABI's, stored straight into the destination.
  private abiResult = false;

  /**
   * placeType, or the reason the function stays legacy: what a place of `t` holds, and the
   * type of the SSA value an ABI boundary passes (a by-value param or result) whatever Repr says.
   */
  private place$(t: TypeKind, what: string): string {
    const v = placeType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${placeBlocker(this.cx, t)}`);
    return v;
  }

  /** lentType, or the reason the function stays legacy. */
  private lent(t: TypeKind, what: string): string {
    const v = lentType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${placeBlocker(this.cx, stripRefs(t))}`);
    return v;
  }

  /** valueType, or the reason the function stays legacy: an SSA operand of `t` away from an ABI boundary. */
  private value(t: TypeKind, what: string): string {
    const v = valueType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${blocker(this.cx, t)}`);
    return v;
  }
  private retMain(): void {
    const z = this.def("milo.const 0 : si32", "si32");
    this.ret(`milo.return ${z.ref} : si32`);
  }
  private ensures: HIRContract[] = [];
  /** A for loop with its invariants checked at the top of every iteration (legacy emitLoopInvariants). */
  private withInvariants<S extends { body: HIRStmt[]; invariants?: HIRContract[] }>(s: S): S {
    if (!this.cx.contractChecks || !s.invariants?.length) return s;
    return { ...s, body: [...s.invariants.map(i => ({ kind: "ContractCheck" as const, clause: i.kind, expr: i.expr, span: i.span })), ...s.body] };
  }
  /** One clause checked here: the condition in a scope of its own (its temporaries die before the check). */
  private contractCheck(clause: HIRContract["kind"], e: HIRExpr, span?: Span): void {
    const c = this.scoped(() => this.expr(e));
    if (c.ty !== "i1") throw new MlirUnsupported("contract clause of another type");
    this.emit(`milo.contract_check ${c.ref} ${JSON.stringify(clause)} ${this.loc(span)}`);
  }
  /**
   * The function's return: its ensures clauses first, `result` bound to the value being
   * returned (legacy emitEnsuresChecks), then the pending drops.
   */
  private ret(line: string, result?: Binding): void {
    if (this.ensures.length) {
      this.scopes.push(new Map());
      try {
        if (result) this.bind("result", result);
        for (const c of this.ensures) this.contractCheck("ensures", c.expr, c.span);
      } finally { this.scopes.pop(); }
    }
    this.dropPending(0);
    if (this.replay) this.emit("milo.replay.exit");
    this.emit(line);
  }

  private emit(line: string): void { this.body.push(`${"  ".repeat(this.depth)}${line}`); }
  private fresh(): string { return `%v${this.n++}`; }
  private bind(name: string, b: Binding): void { this.scopes[this.scopes.length - 1].set(name, b); }

  private lookup(name: string): Exclude<Binding, { kind: "opaque" | "ptr" }> {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b?.kind === "opaque") throw new MlirUnsupported(`use of a by-ref param of type ${b.what}`);
      if (b?.kind === "ptr") throw new MlirUnsupported("use of a binding behind a pointer");
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
    const l = this.site(span);
    return `loc(${quote(l.file)}:${l.line}:${l.col})`;
  }

  /** Where a panic at `span` says it is: inside a @trackCaller copy, the call site (legacy panicAt). */
  private site(span: Span | undefined): { file: string; line: number; col: number } {
    const l = this.cx.checkLocation(this.fn.trackedCaller ?? span);
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    return l;
  }

  /** `file:line:col` of a panic at `span`, as legacy panicAt prints it. */
  private panicAt(span: Span | undefined): string {
    const l = this.site(span);
    return `${l.file}:${l.line}:${l.col}`;
  }

  /**
   * milo.panic_if: when `bad` holds, print the text and abort. `text` is static (every `%`
   * in it escaped), or the static pieces around `values`, each printed as `%lld`.
   */
  private panicIf(bad: string, text: string | string[], values: string[] = []): void {
    const parts = typeof text === "string" ? [text] : text;
    if (parts.length !== values.length + 1) throw new Error("panicIf: one text piece more than values");
    const msg = parts.map(p => p.replace(/%/g, "%%")).join("%lld");
    this.emit(`milo.panic_if ${bad}, ${quoteBytes(new TextEncoder().encode(msg))}${values.length ? `(${values.join(", ")})` : ""}`);
  }

  /** A call of a runtime section or module routine, by symbol. */
  private rtCall(name: string, args: Val[], ret: string | null): Val {
    const fnTy = `(${args.map(a => a.ty).join(", ")}) -> ${ret ?? "()"}`;
    this.callees.set(name, fnTy);
    const call = `func.call @${quote(name)}(${args.map(a => a.ref).join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return this.def(call, ret);
  }

  /** A null buffer from an allocating runtime call: legacy's emitAllocNullCheck text. */
  private allocCheck(p: Val, span: Span | undefined): Val {
    const isNull = this.def(`milo.cmp eq, ${p.ref}, ${this.def(`milo.zero : ${PTR}`, PTR).ref} : ${PTR}`, "i1");
    const l = this.site(span);
    this.panicIf(isNull.ref, `runtime error: integer overflow at ${l.file}:${l.line}\n`);
    return p;
  }

  private constTrue(): string {
    return this.def("milo.const true", "i1").ref;
  }

  /** A call's result where a value is wanted: a void one keeps the function legacy. */
  private valued(v: Val, stmt: boolean): Val {
    if (!stmt && !v.ty) throw new MlirUnsupported("void call as value");
    return v;
  }

  /**
   * A region's body, a block of its own. `fill` returns true when it ended in a jump, a Val
   * to yield, or false to yield nothing. True when it ended in a jump.
   */
  private region(open: string, fill: () => boolean | Val): boolean {
    this.emit(open);
    this.depth++;
    this.scopes.push(new Map());
    this.blocks.push(this.owned.length);
    this.owned.push([]);
    const start = this.body.length;
    const r = fill();
    const v = typeof r === "object" ? r : null;
    const end = this.closeScope(start, r === true, v);
    if (r !== true) this.emit(end ? `milo.yield ${end.ref} : ${end.ty}` : "milo.yield");
    this.scopes.pop();
    this.blocks.pop();
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
   * The one place a temporary is made: an owned Operand that a position needs as a Place
   * goes into an owned slot of the innermost open frame (`owned`), which drops it when it
   * closes. The open frame is the drop point, and it is legacy codegen's per position:
   *  - an operator that only reads it and keeps nothing (`.len`, a tag test, a string
   *    byte, a Copy field): right after that operator (legacy dropOwnedTemp), `peek`;
   *  - a by-ref argument's: right after its call, before the result is used (legacy
   *    argTempDrops, flushed by the call), the frame `callScope` opens around each call;
   *  - a match subject's: when the match ends (legacy genTempSubjectMatch), the frame
   *    `stmt` opens around a match statement, or its `let`'s or call's;
   *  - a discarded result's, or one read in place by a statement (a print part, a string
   *    comparison's operand): at the end of its statement, `stmt`. Legacy drops these right
   *    after their operator, which is the same point: nothing else runs in between;
   *  - a `let` initializer's: at the end of the `let` (`scoped`); a for-in iterable's after
   *    the loop, as legacy's registerScopedTemp; a temporary array a slice is taken of
   *    (`total([a, b])`): when its block ends (`block`), as legacy's frame slot does;
   * `structural`: the temporary is a structural clone of an element (a `v[i]` match
   * subject, legacy emitDeepCloneFromPtr), which shares its resources with the element, so
   * it is freed structurally (milo.var `structural`, legacy's structuralDropTypes) and no
   * user Drop runs for it. A clone with a user Drop held anywhere else stays legacy.
   */
  private tempSlot(name: string, ty: string, t: TypeKind, of?: Val, structural = false, block = false): string {
    if (of && this.clones.has(of.ref) && !structural && this.runsUserDrop(ty)) throw new MlirUnsupported("a clone with a user Drop as a temporary");
    return this.ownedSlot(name, ty, t, structural, block);
  }
  // Results of copyOut: legacy's structural clones of what a place holds.
  private clones = new Set<string>();

  /** `e` read by `read`, which keeps nothing of it: a temporary `e` dies right after (tempSlot). */
  private peek(e: HIRExpr, read: (v: Val) => Val): Val {
    const v = this.expr(e);
    if (v.own !== "owned" || this.bitCopies.has(v.ref) || !this.hasDrop(v.ty)) return read(this.borrow(v, e.type));
    return this.scoped(() => read(this.borrow(v, e.type)));
  }

  /** A direct call in a frame of its own: its by-ref arguments' temporaries die right after it (tempSlot). */
  private callScope(fill: () => Val): Val {
    this.owned.push([]);
    const start = this.body.length;
    const v = fill();
    return this.closeScope(start, false, v.ty ? v : null) ?? v;
  }

  /** A slot owning a `ty` (string, Vec) for the innermost frame, the innermost block's (`block`), or frame `block`. */
  private ownedSlot(name: string, ty: string, t: TypeKind, structural = false, block: boolean | number = false): string {
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(name)} owned${structural ? " structural" : ""} : !milo.ref<${ty}>`);
    this.owned[typeof block === "number" ? block : block ? this.blocks[this.blocks.length - 1] : this.owned.length - 1].push({ ref, ty });
    this.dropGlue(ty, t, structural);
    return ref;
  }

  private dropGlue(_ty: string, t: TypeKind, structural = false): void {
    this.cx.mlirDropHelper(typeKey(t), stripRefs(t), structural);
  }

  // Owned operands evaluated and not yet handed to their op (`tok()` in
  // `take(tok(), match o { None => return 0, ... })`), or an owning field or element
  // already stored into a place built in place (`place`): no scope drops them on a jump out
  // of a later operand, so the jump does, last first (legacy emitPendingDrops). `hold` is
  // a value with a second owner until its op (MemReplace's old value): no jump may come
  // between, so one keeps the function legacy.
  private pending: { ref: string; ty: string; t: TypeKind; place?: boolean; hold?: boolean }[] = [];
  // pending.length at each enclosing loop's entry: a break or continue drops only above it.
  private loopBase: number[] = [];
  private pend(v: Val, t: TypeKind, hold = false): Val {
    if (this.hasDrop(v.ty) && v.own === "owned") this.pending.push({ ref: v.ref, ty: v.ty, t: stripRefs(t), hold });
    return v;
  }
  private dropPending(from: number): void {
    for (let i = this.pending.length - 1; i >= from; i--) {
      const p = this.pending[i];
      if (p.hold) throw new MlirUnsupported("jump out of an expression with a replaced value pending");
      this.owned.push([]);
      const start = this.body.length;
      if (p.place) {
        this.dropGlue(p.ty, p.t);
        this.emit(`milo.drop ${p.ref} : !milo.ref<${p.ty}>`);
      } else {
        const slot = this.ownedSlot("pending", p.ty, p.t);
        this.emit(`milo.store ${p.ref}, ${slot} : !milo.ref<${p.ty}>`);
      }
      this.closeScope(start, false, null);
    }
  }

  /**
   * An operand a legacy helper takes by value (an extern's, a builtin's, an itable
   * dispatch's): any SSA value that owns nothing (a scalar, a pointer, a plain fn value, a
   * struct or enum of those), typed as the helper's own param. One that owns would leave
   * the helper to drop it, which only a direct call's callee does.
   */
  private helperOperand(e: HIRExpr, what: string): { v: Val; type: TypeKind } {
    const type = stripRefs(this.fieldType(e));
    const v = this.pend(this.expr(e), type);
    if (!isScalarTy(v.ty) && v.ty !== PTR && (!v.ty || v.ty !== valueType(this.cx, type) || this.hasDrop(v.ty)))
      throw new MlirUnsupported(`${what} of type ${type.tag}`);
    return { v, type };
  }

  /**
   * The one way a by-value position (an argument, a return, a store, a payload, an
   * element) takes an operand already evaluated: consumed (it owns itself or owns nothing),
   * a fn value cast across owning (fnAs; `leak` where legacy stores an owned one with nobody
   * to free it), and of exactly the position's type `ty`, or the function stays legacy.
   */
  private take(v: Val, ty: string, what: string, leak = false): Val {
    // A borrowed `move` closure given to a plain `(T) => R` param is lent, not given (spec, [MILO-O-lentClosure]
    // moveClosureLentToPlainParam): the param is a plain alias, the caller keeps it.
    if (what === "argument" && v.own === "view" && ty.startsWith("!milo.fn<") && v.ty === ty.replace(/^!milo\.fn</, "!milo.fn<owning "))
      return this.def(`milo.fn.cast ${v.ref} : ${v.ty} -> ${ty}`, ty);
    const r = this.fnAs(this.consume(v, what), ty, leak);
    if (r.ty !== ty) throw new MlirUnsupported(`${what} of another type`);
    return r;
  }

  /**
   * `e` evaluated for a by-value position of type `ty` (take). At an ABI boundary (`abi`: a
   * call's argument, a return, a box's or a value enum's payload) a type whose bindings live
   * in a slot (Repr) is loaded whole from its place (bigArg), as legacy passes it.
   */
  private operand(e: HIRExpr, ty: string, what: string, abi = false): Val {
    // An sret call has no SSA result: built in a slot, then loaded whole, as bigArg does.
    return (abi && inSlot(this.cx, ty)) || this.isSretCall(e) ? this.bigArg(e, ty) : this.take(this.expr(e), ty, what);
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
    if (v.own !== "owned" || !this.hasDrop(v.ty)) return v;
    if (this.bitCopies.has(v.ref)) return { ...v, own: "view" };
    const slot = this.tempSlot("tmp", v.ty, t, v);
    this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
    return { ...this.def(`milo.load ${slot} : !milo.ref<${v.ty}>`, v.ty), own: "view" };
  }

  /** True when the statements end in a jump: whatever follows is dead. */
  private stmts(body: HIRStmt[]): boolean {
    for (const s of body) if (this.stmt(s)) return true;
    return false;
  }

  // MILO_MLIR_PROBE (census only): a refused statement is noted and skipped, so one run
  // lists every blocker of a function, not just its first. The function never ships.
  readonly probed: string[] = [];
  private stmt(s: HIRStmt): boolean {
    if (!PROBE) return this.stmtProbed(s);
    const at = { body: this.body.length, owned: this.owned.length, scopes: this.scopes.length, depth: this.depth,
      pending: this.pending.length, loops: this.loops, loopBase: this.loopBase.length, blocks: this.blocks.length };
    try {
      return this.stmtProbed(s);
    } catch (err) {
      if (!(err instanceof MlirUnsupported)) throw err;
      if (!err.reason.includes(PROBE_SKIPPED)) this.probed.push(err.reason);
      this.body.length = at.body; this.owned.length = at.owned; this.scopes.length = at.scopes; this.depth = at.depth;
      this.pending.length = at.pending; this.loops = at.loops; this.loopBase.length = at.loopBase; this.blocks.length = at.blocks;
      // A later use of what the skipped statement bound refuses as a follow-on, not a blocker.
      if (s.kind === "Let") this.bind(s.name, { kind: "opaque", what: PROBE_SKIPPED });
      return false;
    }
  }

  private stmtProbed(s: HIRStmt): boolean {
    if (s.kind !== "Assign" && s.kind !== "ExprStmt" && s.kind !== "Match") return this.stmtIn(s);
    // Its temporaries die at its end, as legacy drops them (tempSlot): a block's end may never come
    // (an exit() later in it), and the live-block count at exit would see them.
    this.owned.push([]);
    const start = this.body.length;
    const jumped = this.stmtIn(s);
    this.closeScope(start, jumped, null);
    return jumped;
  }

  private stmtIn(s: HIRStmt): boolean {
    // A for loop's invariants go at the top of its body (withInvariants), before dispatch.
    if (s.kind === "ForEach" || s.kind === "ForRange" || s.kind === "ForStrView" || s.kind === "ForIterator") return this.stmtCore(this.withInvariants(s));
    return this.stmtCore(s);
  }

  private stmtCore(s: HIRStmt): boolean {
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
        if (pt !== null && inSlot(this.cx, pt)) {
          const b = this.bigSlot(s.name, s.value);
          this.bind(s.name, { kind: "var", ref: b.ref, ty: b.ty, owned: b.owned });
          return false;
        }
        const slice = s.type.tag === "array" && s.type.size === null;
        if ((s.type.tag === "ref" || slice) && s.mutable) {
          // `var view = s[0..5]`: a slot of views (legacy's local of the header), never an owner. [MILO-O-viewVar]
          const inner = s.type.tag === "ref" ? s.type.inner : s.type;
          const want = inner.tag === "array" && inner.size === null ? `!milo.vecval<${this.lent(inner, "let").slice(10, -1)}>` : this.value(inner, "let");
          const v = this.scoped(() => this.expr(s.value));
          if (v.ty !== want || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("`&T` var of a value it would own");
          const ref = this.fresh();
          this.vars.push(`  ${ref} = milo.var ${quote(s.name)} : !milo.ref<${want}>`);
          this.emit(`milo.store ${v.ref}, ${ref} init : !milo.ref<${want}>`);
          this.bind(s.name, { kind: "var", ref, ty: want, view: true });
          return false;
        }
        if ((s.type.tag === "ref" || slice) && !s.mutable) {
          // A `&T` or slice let (`let base = s[0..end]`): a view of what it is taken from,
          // never an owner, so bound as it is: a place as that place, a view as its SSA value.
          const p = this.fieldPlace(s.value);
          if (p) { this.bind(s.name, { kind: "var", ref: p.ref, ty: p.ty, param: p.param }); return false; }
          const v = this.scoped(() => this.expr(s.value));
          const inner = s.type.tag === "ref" ? s.type.inner : s.type;
          const want = inner.tag === "array" && inner.size === null ? `!milo.vecval<${this.lent(inner, "let").slice(10, -1)}>` : this.value(inner, "let");
          if (v.ty !== want || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("`&T` let of a value it would own");
          this.bind(s.name, { kind: "ssa", v });
          return false;
        }
        const ty = this.value(s.type, "let");
        // The value's temporaries die at the end of the statement; the binding's slot is the block's.
        const v = this.scoped(() => this.operand(s.value, ty, "let"));
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
            if (pp) {
              if (pp.ty !== big) throw new MlirUnsupported("128+ byte store of another type");
              this.emit(`milo.copy ${src.ref}, ${pp.ptr} : ${src.refTy}, ${PTR} of ${big}`);
              src.done();
              return false;
            }
            // Over a field or an element of a place, which always holds a value: the old
            // one dropped, then the new one copied in (legacy's eval, drop, memcpy).
            const dst = s.target.kind === "IndexAccess" ? this.elemRef(s.target) : s.target.kind === "FieldAccess" ? this.fieldPlace(s.target)
              : s.target.kind === "HeapDeref" ? this.heapPlace(s.target) : null;
            if (!dst || dst.ty !== big) throw new MlirUnsupported("128+ byte store other than through a pointer");
            this.overwriteBig(dst.ref, big, s.target.type, src, false);
            return false;
          }
          // Through a raw pointer: the value is stored as is, nothing is dropped (unsafe).
          const v = this.consume(this.expr(s.value), "store through a pointer");
          const pp = this.ptrPlace(s.target);
          if (pp) {
            // A generic body sees an owning fn T as plain behind a `*T` (`data[len] = x` in
            // Vec<T>.push): the bits go to memory that legacy's glue for the pointee frees
            // the same way, so the value is cast (fnAs's `leak`).
            this.emit(`milo.ptr.store ${this.take(v, pp.ty, "store through a pointer", true).ref}, ${pp.ptr} : ${pp.ty}`);
            return false;
          }
          if (s.target.kind === "PtrDeref") throw new MlirUnsupported("store through a pointer of another type");
          if (s.target.kind === "FieldAccess" || s.target.kind === "HeapDeref") {
            const p = this.fieldPlace(s.target);
            if (!p) throw new MlirUnsupported("assign to a field of a value");
            // milo-scope-drops drops the old value before the store (a box's `*h` too, as
            // legacy's Assign does): its glue must exist.
            if (this.hasDrop(p.ty)) this.dropGlue(p.ty, s.target.type);
            this.emit(`milo.store ${this.take(v, p.ty, "field store").ref}, ${p.ref} : !milo.ref<${p.ty}>`);
            return false;
          }
          const er = this.elemRef(s.target);
          if (er) {
            // milo-scope-drops drops the old element before the store, as legacy does.
            if (this.hasDrop(er.ty)) this.dropGlue(er.ty, s.target.type);
            this.emit(`milo.store ${this.take(v, er.ty, "element store").ref}, ${er.ref} : !milo.ref<${er.ty}>`);
            return false;
          }
          const { vec, elem, index } = this.indexPlace(s.target);
          this.emit(`milo.index.store ${this.take(v, elem, "element store").ref}, ${vec}[${index}] : ${elem}, !milo.vec<${elem}> ${this.loc(s.target.span)}`);
          return false;
        }
        if (s.target.kind !== "Ident") throw new MlirUnsupported(`assign to ${s.target.kind}`);
        const b = this.lookup(s.target.name);
        if (b.kind !== "var") throw new MlirUnsupported("assign to an immutable binding");
        // A lazy global of a place-only type (`let NAMES: [string; 3] = [...]`) is built
        // in place, as legacy's genStoreInto does for its first fill.
        if (s.isInit && inSlot(this.cx, b.ty)) { this.scoped(() => { this.into(s.value, b.ref, b.ty); return { ref: "", ty: "" }; }); return false; }
        if (inSlot(this.cx, b.ty)) {
          if (this.lvalueSame(s.value, s.target)) return false;
          const src = this.bigPlace(s.value, b.ty) ?? (() => {
            const sl = this.bigSlot("tmp", s.value, true);
            return { ref: sl.ref, refTy: `!milo.ref<${b.ty}>`, done: () => { if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${b.ty}>`, b.ty); } };
          })();
          this.overwriteBig(b.ref, b.ty, s.target.type, src, !!b.owned);
          return false;
        }
        if (b.view) {
          const v = this.expr(s.value);
          if (v.ty !== b.ty || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("assignment of an owned value to a view var");
          this.emit(`milo.store ${v.ref}, ${b.ref} init : !milo.ref<${b.ty}>`);
          return false;
        }
        // The old value's drop is milo-scope-drops' business: it goes before the store.
        const v = this.operand(s.value, b.ty, "assignment");
        if (this.hasDrop(b.ty) && !s.isInit) this.dropGlue(b.ty, s.target.type);
        this.emit(`milo.store ${v.ref}, ${b.ref}${s.isInit ? " init" : ""} : !milo.ref<${b.ty}>`);
        return false;
      }
      case "Return": {
        if (this.sretOut && s.value) {
          this.into(s.value, this.sretOut.ref, this.sretOut.ty);
          this.ret("milo.return", { kind: "var", ref: this.sretOut.ref, ty: this.sretOut.ty });
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
        if (this.retView) {
          const v = this.expr(s.value);
          if (v.ty !== this.retView || (v.own === "owned" && !this.keyBody)) throw new MlirUnsupported("returned view that is an owned value or of another type");
          this.ret(`milo.return ${v.ref} : ${v.ty}`, { kind: "ssa", v });
          return true;
        }
        // A `move` closure returned as a plain `(T) => R`: a plain fn value is Copy and owns
        // nothing, so its environment has no owner and leaks, as legacy leaks it (the env
        // drop header is docs/backlog.md #23). fnAs's `leak` casts it. [MILO-O-returnedPlainClosure]
        const plainFn = this.retTy!.startsWith("!milo.fn<") && !this.retTy!.startsWith("!milo.fn<owning ");
        const v = plainFn ? this.take(this.expr(s.value), this.retTy!, "return", true) : this.operand(s.value, this.retTy!, "return", this.retPlaceOnly);
        this.ret(`milo.return ${v.ref} : ${v.ty}`, { kind: "ssa", v: { ...v, own: v.own === "owned" ? "view" : v.own } });
        return true;
      }
      case "ExprStmt": {
        // A discarded 128+ byte value that is built in place (`into`: an sret call, replace,
        // `?`, `??`, `!`) goes to a temporary dropped at the statement's end, as legacy's.
        const built = s.expr.kind === "MemReplace" || s.expr.kind === "Propagate" || s.expr.kind === "DefaultValue" || s.expr.kind === "Unwrap";
        if (this.isSretCall(s.expr) || (built && s.expr.type.tag !== "void" && inSlot(this.cx, this.place$(s.expr.type, "discarded value")))) { this.bigSlot("tmp", s.expr, true); return false; }
        // An if or a match whose value nobody takes (void, or never: every arm jumps) is the
        // statement, whose arms may end in a jump.
        const x = s.expr;
        if (x.kind === "IfExpr" && (x.type.tag === "void" || x.type.tag === "never"))
          return this.stmtIn({ kind: "If", cond: x.cond, thenBody: x.thenBody, elseBody: x.elseBody, span: x.span });
        if (x.kind === "MatchExpr" && (x.type.tag === "void" || x.type.tag === "never")) return this.match(x, null).done;
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
        // The condition's temporaries die before either branch runs, as legacy's right after
        // their operator (tempSlot).
        const c = this.scoped(() => this.expr(s.cond));
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
        // A while's invariants are checked with its condition, so they hold on exit too.
        const invs = this.cx.contractChecks ? s.invariants ?? [] : [];
        this.loops++; this.loopBase.push(this.pending.length);
        const checkInvs = () => { for (const inv of invs) this.contractCheck("invariant", inv.expr, inv.span); };
        if (s.cond.kind === "BoolLit" && s.cond.value) {
          this.region("milo.loop {", () => { checkInvs(); return this.stmts(s.body); });
        } else {
          this.region("milo.while {", () => {
            checkInvs();
            // milo.condition ends the region, so temporaries die in a block inside it.
            const c = this.scoped(() => this.expr(s.cond));
            this.emit(`milo.condition ${c.ref}`);
            return true;
          });
          this.region("} do {", () => this.stmts(s.body));
        }
        this.emit("}");
        this.loops--; this.loopBase.pop();
        return false;
      }
      case "ForStrView": return this.forStrView(s);
      case "ForEach": {
        // `for x in v` over a Vec place, as legacy genForEach: data and len read once,
        // then each element by index. The element is read at the top of each iteration,
        // where legacy reads it through its address at each use: the same, since the
        // checker lets nothing write the Vec while the loop borrows it. The index moves
        // on before the body, so a `continue` (back to the condition) cannot skip it.
        if (s.consume && s.iterableKind === "vec") return this.consumedForEach(s);
        // A slice is a Vec header: borrowed and walked as a Vec is.
        const it = stripRefs(s.iterable.type);
        const slice = s.iterableKind === "array" && it.tag === "array" && it.size === null;
        if (s.iterableKind === "array" && !slice) return this.arrayForEach(s);
        if (s.iterableKind === "hashmap" && !s.consume) return this.mapForEach(s);
        if ((s.iterableKind !== "vec" && s.iterableKind !== "string" && !slice) || s.consume) throw new MlirUnsupported(`for over a ${s.consume ? "consumed " : ""}${s.iterableKind}`);
        const elemKind = s.varName2 ? s.varType2! : s.varType;
        // `for x in &mut v`: x is the element's place, written through (legacy binds its address).
        const mutElem = elemKind.tag === "ref" && elemKind.mutable;
        if (mutElem && s.iterableKind === "string") throw new MlirUnsupported("for over &mut string bytes");
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
          byPlace = (mutElem || valueType(this.cx, stripRefs(elemKind)) === null || inSlot(this.cx, elem)) && placeType(this.cx, stripRefs(elemKind)) === elem;
          if (mutElem && !byPlace) throw new MlirUnsupported("for over &mut elements of another type");
          if (!byPlace && (inSlot(this.cx, elem) || valueType(this.cx, stripRefs(elemKind)) !== elem)) throw new MlirUnsupported("for element type");
          data = this.def(`milo.vec.data ${place} : !milo.vec<${elem}>`, PTR).ref;
          len = this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64").ref;
        }
        const idx = this.fresh();
        this.vars.push(`  ${idx} = milo.var "for.idx" : !milo.ref<si64>`);
        this.emit(`milo.store ${this.def("milo.const 0 : si64", "si64").ref}, ${idx} : !milo.ref<si64>`);
        this.loops++; this.loopBase.push(this.pending.length);
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
            // In bounds by the condition, and nothing but the binding writes the Vec while the
            // loop borrows it.
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
        this.loops--; this.loopBase.pop();
        return false;
      }
      case "ForRange": {
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
        this.loops++; this.loopBase.push(this.pending.length);
        this.region(`milo.for ${start.ref} to ${end.ref} : ${ty} {`, () => {
          this.emit(`^bb0(${iv}: ${ty}):`);
          this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty } });
          return this.stmts(s.body);
        });
        this.emit("}");
        this.loops--; this.loopBase.pop();
        return false;
      }
      case "Break":
      case "Continue":
        if (this.loops === 0) throw new MlirUnsupported(`${s.kind} outside a loop`);
        this.dropPending(this.loopBase[this.loopBase.length - 1]);
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
        this.blocks.push(this.owned.length);
        this.owned.push([]);
        const start = this.body.length;
        try {
          const jumped = this.stmts(s.body);
          this.closeScope(start, jumped, null);
          return jumped;
        } finally { this.scopes.pop(); this.blocks.pop(); }
      }
      case "ForIterator": return this.forIterator(s);
      case "ContractCheck": this.contractCheck(s.clause, s.expr, s.span); return false;
      case "NullRefUnwrap": {
        // `let p = b else { ... }` on a `?&T`/`?&mut T`, as legacy genNullRefUnwrap: a null
        // test, the else block (which the checker makes diverge) on null, then p is the
        // pointee behind the pointer.
        const p = this.expr(s.ptr);
        if (p.ty !== PTR) throw new MlirUnsupported("nullable ref of another type");
        const isNull = this.def(`milo.cmp eq, ${p.ref}, ${this.def(`milo.zero : ${PTR}`, PTR).ref} : ${PTR}`, "i1");
        const jumped = this.region(`milo.if ${isNull.ref} {`, () => this.stmts(s.elseBody));
        this.emit("}");
        if (!jumped) throw new MlirUnsupported("nullable ref else block that falls through");
        this.bind(s.name, { kind: "ptr", ptr: p.ref, ty: this.place$(s.inner, "nullable ref pointee") });
        return false;
      }
      default:
        throw new MlirUnsupported(`stmt ${(s as HIRStmt).kind}`);
    }
  }

  /**
   * `for x in makeVec()`: the loop owns the Vec (legacy genConsumedIterable). It lives in a [MILO-O-consumedForIn]
   * vectail slot of a block around the loop, and each iteration moves its element out into
   * the binding (an owned slot of the body when it has drop glue) and moves the cursor past
   * it, so whichever way control leaves, the slot's drop frees exactly the elements no
   * iteration took, then the buffer, after the binding's drop as legacy orders them.
   */
  /**
   * `h.m(args)` through a `Heap<I>` or a `&I`: legacy's itable dispatch (genInterfaceMethodCall) in a
   * helper per interface, method and operand shape, the box lent by its place. Arguments
   * are scalars by value or places lent as the callee's `&T`; a string result is owned.
   */
  private dynCall(e: HIRExpr & { kind: "InterfaceMethodCall" }): Val {
    const ot = stripRefs(e.object.type);
    // A borrowed interface (`g: &Greeter`) is the same `{ data, itable }` pair in its place.
    if ((ot.tag !== "heap" || ot.inner.tag !== "interface") && ot.tag !== "interface") throw new MlirUnsupported("interface call on a non-interface");
    const dty = this.place$(ot, "interface box");
    // Dispatch only reads { data, itable }: a named or indexed receiver is lent where it is,
    // an SSA view of one (`for s in shapes`) spilled to a slot nothing drops (place).
    const k = e.object.kind;
    if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess") throw new MlirUnsupported("interface call on a temporary box");
    const p = this.place(e.object, `!milo.ref<${dty}>`, false);
    const ops: { name: string; type: TypeKind; mode: "val" | "ref" | "mut"; ref: string }[] = [{ name: "o", type: ot, mode: "ref", ref: p.ref }];
    const mark = this.pending.length;
    e.args.forEach((a, k) => {
      const t = stripRefs(a.expr.type);
      if (a.passByRef) {
        ops.push({ name: `a${k}`, type: t, mode: a.refMut ? "mut" : "ref", ref: this.place(a.expr, this.lent(t, "interface call operand"), a.refMut).ref });
        return;
      }
      const { v, type } = this.helperOperand(a.expr, "interface call argument");
      ops.push({ name: `a${k}`, type, mode: "val", ref: v.ref });
    });
    this.pending.length = mark;
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

  /**
   * `for k, v in m` over a HashMap place, as legacy genForEach: data and cap read once from
   * the header ({ ptr data, i64 len, i64 cap, i64 seed, i64 tombs }), then every slot
   * ({ i8 state, K, V }) whose state is 1 (occupied). Legacy binds k and v to the slot's
   * places; here each is a bit copy in a slot of its own that owns nothing (a view): the
   * checker lets nothing write the map while the loop borrows it, so the copy reads the
   * same, and a place behind a pointer is never a milo.ref (see ptr.elem).
   */
  private mapForEach(s: HIRStmt & { kind: "ForEach" }): boolean {
    const mt = stripRefs(s.iterable.type);
    if (mt.tag !== "hashmap") throw new MlirUnsupported("for over a hashmap of another type");
    if ((s.varType.tag === "ref" && s.varType.mutable) || (s.varType2?.tag === "ref" && s.varType2.mutable)) throw new MlirUnsupported("for over &mut map entries");
    const mty = this.place$(mt, "for map");
    const kt = this.place$(mt.key, "map key"), vt = this.place$(mt.value, "map value");
    const scopeStart = this.body.length;
    this.scopes.push(new Map());
    this.blocks.push(this.owned.length);
    this.owned.push([]);
    try {
      let p = this.fieldPlace(s.iterable);
      if (!p) {
        // A map value (a fork of places, a temporary): walked from a slot. A view's slot owns
        // nothing; a temporary's is the loop's frame's, which drops it after the loop.
        const v = this.expr(s.iterable);
        if (v.ty !== mty) throw new MlirUnsupported("for over a hashmap value of another type");
        let ref: string;
        if (v.own === "owned" && !this.bitCopies.has(v.ref)) ref = this.ownedSlot("for.map", mty, mt);
        else { ref = this.fresh(); this.vars.push(`  ${ref} = milo.var "for.map" : !milo.ref<${mty}>`); }
        this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${mty}>`);
        p = { ref, ty: mty };
      }
      if (p.ty !== mty) throw new MlirUnsupported("for over a hashmap that is not a place");
      // Legacy's own %HashMap names the header; a slot is addressed by bytes (it is a
      // literal struct in legacy, which no !milo.struct name could spell).
      const head = `!milo.struct<"HashMap", ${PTR}, si64, si64, si64, si64>`;
      const lay = this.cx.mapSlotLayout(mt.key, mt.value);
      const byte = (base: string, off: number) => off === 0 ? base : this.def(`milo.ptr.elem ${base}[${this.def(`milo.const ${off} : si64`, "si64").ref}] : ui8`, PTR).ref;
      const mp = this.def(`milo.addr ${p.ref} : !milo.ref<${mty}>`, PTR).ref;
      const field = (base: string, i: number, rec: string) => this.def(`milo.ptr.field ${base}[${i}] : ${rec}`, PTR).ref;
      const data = this.def(`milo.ptr.load ${field(mp, 0, head)} : ${PTR}`, PTR).ref;
      const cap = this.def(`milo.ptr.load ${field(mp, 2, head)} : si64`, "si64").ref;
      const view = (name: string, ty: string) => {
        const r = this.fresh();
        this.vars.push(`  ${r} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
        return r;
      };
      // milo.copy moves aggregates; any other value is one ptr.load.
      const copyTo = (src: string, dst: string, ty: string) => {
        if (/^!milo\.(struct|enum|array)</.test(ty)) this.emit(`milo.copy ${src}, ${dst} : ${PTR}, !milo.ref<${ty}> of ${ty}`);
        else this.emit(`milo.store ${this.def(`milo.ptr.load ${src} : ${ty}`, ty).ref}, ${dst} : !milo.ref<${ty}>`);
      };
      const ks = view(s.varName, kt), vs = s.varName2 ? view(s.varName2, vt) : null;
      const iv = this.fresh();
      this.loops++; this.loopBase.push(this.pending.length);
      this.region(`milo.for ${this.def("milo.const 0 : si64", "si64").ref} to ${cap} : si64 {`, () => {
        this.emit(`^bb0(${iv}: si64):`);
        const at = this.def(`milo.mul ${iv}, ${this.def(`milo.const ${lay.size} : si64`, "si64").ref} wrapping : si64`, "si64").ref;
        const slot = this.def(`milo.ptr.elem ${data}[${at}] : ui8`, PTR).ref;
        const st = this.def(`milo.ptr.load ${slot} : si8`, "si8").ref;
        const occupied = this.def(`milo.cmp eq, ${st}, ${this.def("milo.const 1 : si8", "si8").ref} : si8`, "i1").ref;
        let jumped = false;
        this.region(`milo.if ${occupied} {`, () => {
          copyTo(byte(slot, lay.keyOffset), ks, kt);
          this.bind(s.varName, { kind: "var", ref: ks, ty: kt });
          if (vs) {
            copyTo(byte(slot, lay.valueOffset), vs, vt);
            this.bind(s.varName2!, { kind: "var", ref: vs, ty: vt });
          }
          jumped = this.stmts(s.body);
          return jumped;
        });
        this.emit("}");
        return false;
      });
      this.emit("}");
      this.loops--; this.loopBase.pop();
      this.closeScope(scopeStart, false, null);
      return false;
    } finally { this.scopes.pop(); this.blocks.pop(); }
  }

  /**
   * `for v in s.lines()` / `s.splitView(sep)`, as legacy genForStrView: each step
   * (runtime milo.strview.step) finds the next piece and writes it, a view into s's buffer
   * that nothing drops, to the binding's slot. The step runs in the condition, so a
   * `continue` cannot skip it; the enumerate index counts up from -1 at the top of the body.
   */
  private forStrView(s: HIRStmt & { kind: "ForStrView" }): boolean {
    const placeOf = (x: HIRExpr, what: string) => {
      if (x.kind !== "Ident" && x.kind !== "FieldAccess" && x.kind !== "StringLit") throw new MlirUnsupported(`${what} of a for over string pieces that is not a place`);
      return this.place(x, refOf(STR), false).ref;
    };
    const src = placeOf(s.src, "source");
    const sep = placeOf(s.mode === "split" && s.sep ? s.sep : { kind: "StringLit", value: "\n", type: { tag: "string" } } as HIRExpr, "separator");
    const step = this.cx.mlirStrViewStep();
    const slot = (name: string, ty: string) => {
      const r = this.fresh();
      this.vars.push(`  ${r} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
      return r;
    };
    const pos = slot("strview.pos", "si64");
    const piece = slot(s.varName2 ?? s.varName, STR);
    this.emit(`milo.store ${this.def("milo.const 0 : si64", "si64").ref}, ${pos} : !milo.ref<si64>`);
    const idx = s.varName2 ? slot("strview.idx", "si64") : null;
    if (idx) this.emit(`milo.store ${this.def("milo.const -1 : si64", "si64").ref}, ${idx} : !milo.ref<si64>`);
    const split = this.def(`milo.const ${s.mode === "split"}`, "i1").ref;
    this.loops++; this.loopBase.push(this.pending.length);
    this.region("milo.while {", () => {
      const more = this.callHelper(step, [`${src} : !milo.ref<${STR}>`, `${sep} : !milo.ref<${STR}>`, `${split} : i1`, `${pos} : !milo.ref<si64>`, `${piece} : !milo.ref<${STR}>`], "i1");
      this.emit(`milo.condition ${more.ref}`);
      return true;
    });
    this.scopes.push(new Map());
    try {
      this.region("} do {", () => {
        this.bind(s.varName2 ?? s.varName, { kind: "var", ref: piece, ty: STR });
        if (idx) {
          const i = this.def(`milo.add ${this.def(`milo.load ${idx} : !milo.ref<si64>`, "si64").ref}, ${this.def("milo.const 1 : si64", "si64").ref} wrapping : si64`, "si64");
          this.emit(`milo.store ${i.ref}, ${idx} : !milo.ref<si64>`);
          this.bind(s.varName, { kind: "ssa", v: i });
        }
        return this.stmts(s.body);
      });
    } finally { this.scopes.pop(); }
    this.emit("}");
    this.loops--; this.loopBase.pop();
    return false;
  }

  /**
   * `for x in [a, b]` consumed, of elements with a user Drop: the array is built in an
   * arraytail slot (legacy's consumed iterable with its cursor), each iteration moves one
   * element into the binding (dropped at the iteration's end), and the slot's drop glue drops
   * the elements no iteration took, however the loop ends. [MILO-O-consumedForIn]
   */
  private consumedArrayForEach(s: HIRStmt & { kind: "ForEach" }, at: TypeKind & { tag: "array" }, aty: string, ety: string): boolean {
    const byPlace = valueType(this.cx, at.element) === null;
    const tailTy = `!milo.arraytail<${aty}>`;
    this.owned.push([]);
    const start = this.body.length;
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "for.arr" owned : !milo.ref<${tailTy}>`);
    this.owned[this.owned.length - 1].push({ ref: slot, ty: tailTy });
    this.cx.mlirVecTailDropHelper(typeKey(at), at);
    const arr = this.def(`milo.arraytail.array ${slot} : !milo.ref<${tailTy}> -> !milo.ref<${aty}>`, `!milo.ref<${aty}>`).ref;
    this.into(s.iterable, arr, aty);
    this.emit(`milo.arraytail.start ${slot} : !milo.ref<${tailTy}>`);
    this.emit(`milo.filled ${slot} : !milo.ref<${tailTy}>`);
    const iv = this.fresh();
    this.loops++; this.loopBase.push(this.pending.length);
    this.region(`milo.for ${this.def("milo.const 0 : si64", "si64").ref} to ${this.def(`milo.const ${at.size} : si64`, "si64").ref} : si64 {`, () => {
      this.emit(`^bb0(${iv}: si64):`);
      const name = s.varName2 ?? s.varName;
      const own = this.ownedSlot(name, ety, at.element);
      if (byPlace) {
        const from = this.def(`milo.arraytail.take_place ${slot}[${iv}] : !milo.ref<${tailTy}> -> !milo.ref<${ety}>`, `!milo.ref<${ety}>`).ref;
        this.emit(`milo.copy ${from}, ${own} : !milo.ref<${ety}>, !milo.ref<${ety}> of ${ety}`);
        this.emit(`milo.filled ${own} : !milo.ref<${ety}>`);
      } else {
        const x = this.def(`milo.arraytail.take ${slot}[${iv}] : !milo.ref<${tailTy}> -> ${ety}`, ety);
        this.emit(`milo.store ${x.ref}, ${own} : !milo.ref<${ety}>`);
      }
      this.bind(name, { kind: "var", ref: own, ty: ety, owned: true });
      if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty: "si64" } });
      return this.stmts(s.body);
    });
    this.emit("}");
    this.loops--; this.loopBase.pop();
    this.closeScope(start, false, null);
    return false;
  }

  private arrayForEach(s: HIRStmt & { kind: "ForEach" }): boolean {
    /**
     * `for x in arr` over a fixed array, as legacy genForEach:
     * a consumed one (`for i in [0, 1, 5]`, a call) evaluated into a slot first, a place
     * borrowed where it is; the binding is the element's place, which nothing writes while
     * the loop runs, so reading it at each use is reading legacy's copy.
     */
    const at = stripRefs(s.iterable.type);
    const elemKind = s.varName2 ? s.varType2! : s.varType;
    if (at.tag !== "array" || at.size === null) throw new MlirUnsupported("for over a slice");
    const aty = this.place$(at, "for array");
    const ety = this.place$(at.element, "for element");
    if (placeType(this.cx, stripRefs(elemKind)) !== ety) throw new MlirUnsupported("for element type");
    // Legacy moves each element of a consumed array into the binding and drops it at the
    // end of its iteration; here the array's slot drops them all after the loop. Only a
    // user Drop can tell (the order). A binding moved out is zeroed in its slot (zeroOnMove).
    if (s.consume && this.runsUserDrop(ety)) return this.consumedArrayForEach(s, at as TypeKind & { tag: "array" }, aty, ety);
    const scopeStart = this.body.length;
    this.scopes.push(new Map());
    this.blocks.push(this.owned.length);
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
      this.loops++; this.loopBase.push(this.pending.length);
      this.region(`milo.for ${zero} to ${n} : si64 {`, () => {
        this.emit(`^bb0(${iv}: si64):`);
        const r = this.def(`milo.array.index ${arr}[${iv}] : !milo.ref<${aty}> -> !milo.ref<${ety}>`, `!milo.ref<${ety}>`, this.loc(s.span)).ref;
        this.bind(s.varName2 ?? s.varName, s.consume ? { kind: "var", ref: r, ty: ety, zeroOnMove: true } : { kind: "var", ref: r, ty: ety });
        if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty: "si64" } });
        return this.stmts(s.body);
      });
      this.emit("}");
      this.loops--; this.loopBase.pop();
      this.closeScope(scopeStart, false, null);
      return false;
    } finally { this.scopes.pop(); this.blocks.pop(); }
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
    this.loops++; this.loopBase.push(this.pending.length);
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
    this.loops--; this.loopBase.pop();
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
        return { ...this.def(`milo.string.lit ${quoteBytes(literalBytes(e.value))}`, STR), own: "static" };
      case "StringClone": {
        // Milo's implicit copy of a string: a new owner of the same buffer.
        if (e.str.kind === "StringLit") return this.expr(e.str);
        let p = this.fieldPlace(e.str);
        if (!p) {
          // A temporary is its own copy (legacy cloneOfOwnedTemp); a view (a string field of
          // a value read in place, a `&string` let) has its bits put in a slot that drops
          // nothing, and is shared from there.
          const v = this.expr(e.str);
          if (v.ty !== STR) throw new MlirUnsupported("string copy of another type");
          if ((v.own === "owned" && !this.bitCopies.has(v.ref)) || v.own === "static") return v;
          const ref = this.fresh();
          this.vars.push(`  ${ref} = milo.var "view" : !milo.ref<${STR}>`);
          this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${STR}>`);
          p = { ref, ty: STR };
        }
        if (p.ty !== STR) throw new MlirUnsupported("string copy of another type");
        this.cx.mlirStringOps();
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
      case "StringLen": return this.peek(e.object, v => {
        if (v.ty !== STR) throw new MlirUnsupported("len of a non-string");
        return this.def(`milo.string.len ${v.ref}`, "si64");
      });
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
        const pb = this.ptrBinding(e);
        if (pb) {
          // A read of the pointee: a bit copy, a view when it owns (as ptrRead).
          if (inSlot(this.cx, pb.ty)) throw new MlirUnsupported("a 128+ byte pointee as a value");
          const v = this.def(`milo.ptr.load ${pb.ptr} : ${pb.ty}`, pb.ty);
          return { ...v, own: this.hasDrop(pb.ty) ? "view" : undefined };
        }
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
        if (b.kind === "var" && inSlot(this.cx, b.ty) && valueType(this.cx, e.type) !== b.ty) throw new MlirUnsupported("a 128+ byte aggregate as a value");
        if (!this.hasDrop(b.ty)) return this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
        // The checker marks the last use that takes the value; every other read borrows.
        if (!e.isMove) return { ...this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "view" };
        if (b.zeroOnMove) {
          const v = this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
          this.emit(`milo.store ${this.def(`milo.zero : ${b.ty}`, b.ty).ref}, ${b.ref} init : !milo.ref<${b.ty}>`);
          return { ...v, own: "owned" };
        }
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
        if (stripRefs(e.operand.type).tag === "enum" && e.targetType.tag === "int") {
          // A repr'd enum's discriminant is its tag (legacy genCast): a signed i32, then
          // sign-extended or truncated to the target.
          const to = scalar(e.targetType, "cast target");
          const tag = this.peek(e.operand, v => {
            if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("cast of a non-enum");
            return this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
          });
          return to === "si32" ? tag : this.def(`milo.cast ${tag.ref} : si32 to ${to}`, to);
        }
        const from = scalar(e.operand.type, "cast source");
        const to = scalar(e.targetType, "cast target");
        const v = this.expr(e.operand);
        if (v.ty !== from) throw new MlirUnsupported("cast operand type");
        if (from === to) return v;
        if ((from === PTR && to.startsWith("f")) || (to === PTR && from.startsWith("f"))) throw new MlirUnsupported("cast between a pointer and a float");
        return this.def(`milo.cast ${v.ref} : ${from} to ${to}`, to);
      }
      case "Call": return this.valued(this.callScope(() => this.call(e, stmt)), stmt);
      case "IndexAccess": {
        const pp = this.ptrPlace(e);
        if (pp) return this.ptrRead(pp);
        if (stripRefs(e.object.type).tag === "string") {
          // A byte, as legacy genStringIndex reads it: object, index, bounds check.
          return this.peek(e.object, s => {
            const i = this.expr(e.index);
            if (s.ty !== STR || !/^[su]i\d+$/.test(i.ty) || scalar(e.type, "string byte") !== "ui8") throw new MlirUnsupported("string index types");
            const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
            return this.def(`milo.string.byte ${s.ref}[${index}]`, "ui8", this.loc(e.span));
          });
        }
        const er = this.elemRef(e);
        if (er) {
          if (!isSsa(this.cx, er.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
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
        this.stringHelpers();
        return this.allocCheck(this.rtCall("milo.string.reserve", [{ ref: str, ty: `!milo.ref<${STR}>` }, n], PTR), e.span);
      }
      case "StrAlloc": {
        if (scalar(e.type, "string buffer") !== PTR) throw new MlirUnsupported("string alloc type");
        const n = this.expr(e.size);
        if (n.ty !== "si64") throw new MlirUnsupported("string alloc size type");
        this.stringHelpers();
        return this.allocCheck(this.rtCall("milo.str.alloc", [n], PTR), e.span);
      }
      case "StrRangeCheck": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, false).ref;
        const a = this.expr(e.start), b = this.expr(e.end);
        if (a.ty !== "si64" || b.ty !== "si64") throw new MlirUnsupported("string range types");
        // Legacy emitStringRangeCheck: start < 0, end < start or end > len.
        const len = this.def(`milo.string.len ${this.def(`milo.load ${str} : !milo.ref<${STR}>`, STR).ref}`, "si64");
        const zero = this.def("milo.const 0 : si64", "si64");
        const c = (p: string, x: Val, y: Val) => this.def(`milo.cmp ${p}, ${x.ref}, ${y.ref} : si64`, "i1").ref;
        const bad0 = this.def(`milo.or ${c("lt", a, zero)}, ${c("lt", b, a)} : i1`, "i1");
        const bad = this.def(`milo.or ${bad0.ref}, ${c("gt", b, len)} : i1`, "i1");
        this.panicIf(bad.ref, ["milo: substr range out of bounds: ", "..", " (len ", `) at ${this.panicAt(e.span)}\n`], [a.ref, b.ref, len.ref]);
        return { ref: "", ty: "" };
      }
      case "StrUnique": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        this.stringHelpers();
        return this.rtCall("milo.str.unique", [{ ref: str, ty: `!milo.ref<${STR}>` }], null);
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
        if (scalar(e.type, "map seed") !== "si64") throw new MlirUnsupported("map seed type");
        this.cx.mlirMapOps();
        return this.rtCall("__milo_hash_seed", [], "si64");
      case "MapAlloc": {
        const n = this.expr(e.count), z = this.expr(e.size);
        if (n.ty !== "si64" || z.ty !== "si64") throw new MlirUnsupported("map alloc operand types");
        if (scalar(e.type, "map buffer") !== PTR) throw new MlirUnsupported("map buffer type");
        this.cx.mlirMapOps();
        return this.allocCheck(this.rtCall("milo.map.alloc", [n, z], PTR), e.span);
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
        if (this.ownedLocal(e.object)) {
          this.stringHelpers();
          this.rtCall("milo.str.unique", [{ ref: str, ty: `!milo.ref<${STR}>` }], null);
        }
        return this.def(`milo.string.data ${this.def(`milo.load ${str} : !milo.ref<${STR}>`, STR).ref}`, PTR);
      }
      case "NonNegative": {
        const v = this.expr(e.value);
        if (v.ty !== "si64" || scalar(e.type, "checked size") !== "si64") throw new MlirUnsupported("non-negative check type");
        const neg = this.def(`milo.cmp lt, ${v.ref}, ${this.def("milo.const 0 : si64", "si64").ref} : si64`, "i1");
        this.panicIf(neg.ref, [`milo: negative ${e.what} at ${this.panicAt(e.span)}: `, "\n"], [v.ref]);
        return v;
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
      case "SaturatingArith": case "CheckedArith": {
        // `a.saturatingAdd(b)`: milo.saturating. `a.checkedAdd(b)`: None when the op
        // overflows (milo.overflows), else Some of the wrapping op, which then cannot wrap;
        // a div or rem runs only on that side, so a zero divisor never reaches it.
        const l = this.expr(e.left), r = this.expr(e.right);
        const ty = l.ty;
        const ops = e.kind === "CheckedArith" ? ["add", "sub", "mul", "div", "rem"] : ["add", "sub", "mul"];
        if (!ops.includes(e.op) || r.ty !== ty || !/^[su]i\d+$/.test(ty)) throw new MlirUnsupported(`${e.kind} ${e.op} on ${ty}`);
        if (e.kind === "SaturatingArith") return this.def(`milo.saturating "${e.op}", ${l.ref}, ${r.ref} : ${ty}`, ty);
        const oty = this.value(e.type, "checked arithmetic result");
        const vs = this.cx.mlirEnumLayout(e.optionEnumName)?.variants;
        const some = vs?.find(v => v.name === "Some"), none = vs?.find(v => v.name === "None");
        if (!some || !none) throw new MlirUnsupported("checked arithmetic Option layout");
        const bad = this.def(`milo.overflows "${e.op}", ${l.ref}, ${r.ref} : ${ty}`, "i1");
        const res = this.fresh();
        this.region(`${res} = milo.if ${bad.ref} -> ${oty} {`, () => this.def(`milo.enum.new ${none.tag} -> ${oty}`, oty));
        this.region("} else {", () => {
          const v = this.def(`milo.${e.op} ${l.ref}, ${r.ref} wrapping : ${ty}`, ty);
          return this.def(`milo.enum.new ${some.tag} (${v.ref} : ${ty}) -> ${oty}`, oty);
        });
        this.emit("}");
        return { ref: res, ty: oty };
      }
      case "MemSwap": {
        // `swap(a, b)`, as legacy genMemSwap: both read before either is written (they may [MILO-O-replaceSwap]
        // be the same element, `swap(v[i], v[j])`), nothing dropped. A 128+ byte one goes
        // through a scratch slot; copying a place onto itself is a no-op.
        const ty = this.place$(stripRefs(e.a.type), "swapped value");
        const pa = this.place(e.a, `!milo.ref<${ty}>`, true).ref;
        const pb = this.place(e.b, `!milo.ref<${ty}>`, true).ref;
        const r = `!milo.ref<${ty}>`;
        // The same place twice (`swap(v[1], v[1])`): nothing moves. Equal addresses at run
        // time are fine too: llvm.memcpy allows a source equal to its destination.
        if (pa === pb) return { ref: "", ty: "" };
        if (inSlot(this.cx, ty)) {
          const tmp = this.fresh();
          this.vars.push(`  ${tmp} = milo.var "swap.tmp" : ${r}`);
          this.emit(`milo.copy ${pa}, ${tmp} : ${r}, ${r} of ${ty}`);
          this.emit(`milo.copy ${pb}, ${pa} : ${r}, ${r} of ${ty}`);
          this.emit(`milo.copy ${tmp}, ${pb} : ${r}, ${r} of ${ty}`);
        } else {
          const va = this.def(`milo.load ${pa} : ${r}`, ty), vb = this.def(`milo.load ${pb} : ${r}`, ty);
          this.emit(`milo.store ${vb.ref}, ${pa} init : ${r}`);
          this.emit(`milo.store ${va.ref}, ${pb} init : ${r}`);
        }
        return { ref: "", ty: "" };
      }
      case "MemReplace": {
        // `replace(&mut p, v)`, as legacy genMemReplace: the old value read out (it is the [MILO-O-replaceSwap]
        // result's now), then `v` stored over it with nothing dropped.
        const ty = this.value(e.type, "replaced value");
        // A place behind a raw pointer (`replace((*r).items, v)`) is read and written
        // through the pointer: the dialect has no milo.ref there.
        const pp = this.ptrPlace(e.place);
        if (pp && pp.ty !== ty) throw new MlirUnsupported("replace behind a pointer of another type");
        const p = pp ? "" : this.place(e.place, `!milo.ref<${ty}>`, true).ref;
        const old = { ...(pp ? this.def(`milo.ptr.load ${pp.ptr} : ${ty}`, ty) : this.def(`milo.load ${p} : !milo.ref<${ty}>`, ty)), own: this.hasDrop(ty) ? "owned" as const : undefined };
        // Until the store, the old value has two owners on paper: no jump may come between.
        const mark = this.pending.length;
        this.pend(old, e.type, true);
        const v = this.operand(e.value, ty, "replacement");
        this.pending.length = mark;
        if (pp) this.emit(`milo.ptr.store ${v.ref}, ${pp.ptr} : ${ty}`);
        else this.emit(`milo.store ${v.ref}, ${p} init : !milo.ref<${ty}>`);
        return old;
      }
      case "HeapCreate": {
        const ty = this.value(e.type, "box");
        if (ty.startsWith("!milo.dyn<")) throw new MlirUnsupported("box of an interface");
        const inner = /^!milo\.heap<(.*)>$/.exec(ty)![1];
        const v = this.operand(e.value, inner, "boxed value", !isSsa(this.cx, inner));
        return { ...this.def(`milo.heap.new ${v.ref} : ${inner} -> ${ty}`, ty), own: "owned" };
      }
      case "HeapDeref": {
        const op = e.operand;
        const temp = isTempBox(op);
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
      case "HashMapLen": return this.peek(e.object, m => {
        if (!m.ty.startsWith("!milo.map<")) throw new MlirUnsupported("len of a non-map");
        return this.def(`milo.map.len ${m.ref} : ${m.ty}`, "si64");
      });
      case "ArrayLen": {
        // A fixed array's is its size, the object never evaluated (legacy genArrayLen); a
        // slice's is its header's.
        const ot = stripRefs(e.object.type);
        if (scalar(e.type, "array length") !== "si64") throw new MlirUnsupported("array length type");
        if (ot.tag === "array" && ot.size !== null) return this.def(`milo.const ${ot.size} : si64`, "si64");
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64");
      }
      case "VecSlice": {
        // `v[a..b]` of a Vec, a fixed array or a slice: legacy's genVecSlice (range checks, the
        // header into v's buffer) in a helper, v lent by its place. A view: nothing owned.
        const vt = stripRefs(e.vec.type);
        const lent = this.lent(vt, "sliced value");
        const k = e.vec.kind, at = placeType(this.cx, e.vec.type);
        let v: string;
        if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && at !== null && !isSsa(this.cx, at)) {
          // A temporary array (`total([a, b])`) lives until its block ends (tempSlot).
          const sl = this.bigSlot("slice.of", e.vec, true, true);
          v = this.lendAs(sl.ref, `!milo.ref<${sl.ty}>`, lent).ref;
        } else v = this.place(e.vec, lent, false).ref;
        // A narrower bound widens to i64 by its own signedness, as legacy genBoundI64.
        const a = this.widenBound(this.expr(e.start)), b = this.widenBound(this.expr(e.end));
        const elem = this.place$(e.elementType, "slice element");
        if (a.ty !== "si64" || b.ty !== "si64" || vecElem(this.cx, stripRefs(e.type)) !== elem) throw new MlirUnsupported("slice operand types");
        const r = this.intrinsic("vecslice", e, [{ name: "v", type: vt, mode: "ref", ref: v },
          { name: "a", type: I64, mode: "val", ref: a.ref }, { name: "b", type: I64, mode: "val", ref: b.ref }],
        ([x, y, z]) => ({ ...e, vec: x, start: y, end: z }), `!milo.vecval<${elem}>`);
        return { ...r, own: "view" };
      }
      case "CFnCall": {
        // A call through a C fn pointer: legacy's indirect C call in a helper, scalar
        // arguments and result only (a struct by value would need the C ABI here).
        const f = this.expr(e.callee);
        if (f.ty !== PTR) throw new MlirUnsupported("C fn pointer of another type");
        const ops = [{ name: "f", type: e.callee.type, mode: "val" as const, ref: f.ref }];
        e.args.forEach((a, k) => {
          if (a.passByRef) throw new MlirUnsupported("by-ref argument to a C fn pointer");
          const vt = valueType(this.cx, a.expr.type);
          if (vt === null || !(isScalarTy(vt) || vt === PTR)) throw new MlirUnsupported("non-scalar argument to a C fn pointer");
          const v = this.expr(a.expr);
          if (v.ty !== vt) throw new MlirUnsupported("C fn pointer argument type");
          ops.push({ name: `a${k}`, type: a.expr.type, mode: "val", ref: v.ref });
        });
        const ret = e.type.tag === "void" ? null : scalar(e.type, "C fn pointer result");
        const sig = fnv1a(ops.map(o => typeKey(o.type)).join(",") + "->" + (ret ?? "v"));
        const r = this.intrinsic(`cfncall.${sig}`, e, ops,
          ([x, ...xs]) => ({ ...e, callee: x, args: e.args.map((a, k) => ({ ...a, expr: xs[k] })) }), ret, false);
        return this.valued(r, stmt);
      }
      case "OffsetOf": {
        // A constant legacy computes from its struct layout (structFieldOffset): read back
        // from a helper with no operands, which LLVM folds.
        if (scalar(e.type, "offsetOf") !== "si64") throw new MlirUnsupported("offsetOf type");
        const st = e.sizeType.tag === "struct" ? e.sizeType.name : "x";
        return this.intrinsic(`offsetof.${st}.${e.fieldName}`, e, [], () => e, "si64", false);
      }
      case "InterfaceCoerce": {
        // Heap<T> -> Heap<I>: legacy's fat { box, itable } pair in a helper, the box moved
        // into it (the same allocation, now owned by the dyn). `&T -> &I`: the pair of T's
        // place and the itable, borrowing both, made the same way from the lent place.
        if (e.type.tag !== "heap") {
          const st = stripRefs(e.value.type);
          const ty = this.place$(stripRefs(e.type), "borrowed interface");
          const mut = e.type.tag === "ref" && e.type.mutable;
          const p = this.place(e.value, this.lent(st, "coerced value"), mut).ref;
          return this.intrinsic(`coerceref.${e.fromType}.${e.ifaceName}`, e, [{ name: "x", type: st, mode: mut ? "mut" : "ref", ref: p }],
            ([x]) => ({ ...e, value: x }), ty, false);
        }
        const ty = this.value(e.type, "interface value");
        const v = this.consume(this.expr(e.value), "coerced box");
        const r = this.intrinsic(`coerce.${e.fromType}.${e.ifaceName}`, e, [{ name: "h", type: e.value.type, mode: "val", ref: v.ref }],
          ([x]) => ({ ...e, value: { ...x, isMove: true } as HIRExpr }), ty, false);
        return { ...r, own: "owned" };
      }
      case "VecCapacity": case "HeapPtr": return this.builtinOf(e, "object", false);
      case "EnumTryFrom": return this.builtinOf(e, "value", false);
      case "JsonStringify": return this.builtinOf(e, "value", false);
      case "BitIntrinsic": return this.builtinOf(e, "value", true);
      case "Adopt": {
        // adoptHeap(p) / adoptVec(p, len): legacy's genAdopt (no conversion, only the type,
        // whose drop glue now frees the block) in a helper. The result is owned.
        const ty = this.value(e.type, "adopted value");
        const p = this.expr(e.ptr);
        if (p.ty !== PTR) throw new MlirUnsupported("adopt of a non-pointer");
        const ops = [{ name: "p", type: e.ptr.type, mode: "val" as const, ref: p.ref }];
        if (e.len) {
          const n = this.expr(e.len);
          if (n.ty !== "si64") throw new MlirUnsupported("adopt length type");
          ops.push({ name: "n", type: I64, mode: "val", ref: n.ref });
        }
        const r = this.intrinsic(e.len ? "adoptvec" : "adoptheap", e, ops,
          ([x, y]) => ({ ...e, ptr: x, ...(y && { len: y }) }), ty, false);
        return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "RawSlice": {
        // A foreign view `&[T]` over (ptr, len): legacy's genRawSlice header { ptr, len, 0 }
        // in a helper. Its capacity 0 owns nothing, so it is a view.
        const elem = vecElem(this.cx, stripRefs(e.type));
        if (elem === null) throw new MlirUnsupported("raw slice element type");
        const p = this.expr(e.ptr), n = this.expr(e.len);
        if (p.ty !== PTR || n.ty !== "si64") throw new MlirUnsupported("raw slice operand types");
        const r = this.intrinsic("rawslice", e, [{ name: "p", type: e.ptr.type, mode: "val", ref: p.ref },
          { name: "n", type: I64, mode: "val", ref: n.ref }], ([x, y]) => ({ ...e, ptr: x, len: y }), `!milo.vecval<${elem}>`, false);
        return { ...r, own: "view" };
      }
      case "RangeCheck": {
        // A value flowing into a ranged int: legacy's emitRangeCheck (its panic text) in a
        // helper per site, which returns the value unchanged.
        const v = this.expr(e.value);
        const ty = scalar(e.type, "range-checked value");
        if (v.ty !== ty || !/^[su]i\d+$/.test(ty)) throw new MlirUnsupported("range check operand type");
        // Legacy's text names the line only (emitRangeCheck).
        const lo = this.def(`milo.cmp lt, ${v.ref}, ${this.def(`milo.const ${e.min} : ${ty}`, ty).ref} : ${ty}`, "i1");
        const hi = this.def(`milo.cmp gt, ${v.ref}, ${this.def(`milo.const ${e.max} : ${ty}`, ty).ref} : ${ty}`, "i1");
        const bad = this.def(`milo.or ${lo.ref}, ${hi.ref} : i1`, "i1");
        const l = this.site(e.span);
        this.panicIf(bad.ref, `runtime error: value out of range at ${l.file}:${l.line}\n`);
        return v;
      }
      case "VecGetOpt": {
        // `v.get(i)` / first / last: legacy's genVecGetOpt (the bounds test, a deep clone of
        // the element into Some) in a helper, v lent by its place. A temporary receiver goes
        // to a slot that dies with the statement; legacy drops it right after the read, which
        // only a user Drop could tell apart, so such a one stays legacy.
        const k = e.object.kind;
        const vt = stripRefs(e.object.type);
        if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && this.runsUserDrop(this.place$(vt, "vec of get"))) throw new MlirUnsupported("get on a temporary vec with a user Drop");
        const v = this.place(e.object, this.lent(vt, "vec of get"), false).ref;
        const i = this.expr(e.index);
        if (i.ty !== "si64") throw new MlirUnsupported("get index type");
        const ty = this.value(e.type, "get result");
        const r = this.intrinsic("vecget", e, [{ name: "v", type: vt, mode: "ref", ref: v },
          { name: "i", type: I64, mode: "val", ref: i.ref }],
        ([x, y]) => ({ ...e, object: x, index: y }), ty, false);
        return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
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
        // A temporary that owns is kept in a slot while its field is read: until the end of
        // the statement when the field is a view into it, else only for the read (tempSlot).
        const get = (s: Val): Val => ({ ...this.def(`milo.struct.get ${s.ref}[${index}] : ${s.ty} -> ${ty}`, ty), own });
        if (!own) return this.peek(e.object, get);
        const ov = this.expr(e.object);
        if (ov.own === "owned" && !this.bitCopies.has(ov.ref) && !this.runsUserDrop(ty) && this.hasDrop(ov.ty)) {
          // An owning field of a temporary, as legacy reads it: the field cloned out, the [MILO-O-tempFieldRead]
          // temporary dropped right after the read (`mk().name`), so a user Drop runs
          // before the statement goes on. A field that runs its own Drop is not cloned.
          this.owned.push([]);
          const start = this.body.length;
          const slot = this.ownedSlot("field.of", ov.ty, e.object.type);
          this.emit(`milo.store ${ov.ref}, ${slot} : !milo.ref<${ov.ty}>`);
          const fr = this.def(`milo.field_ref ${slot}[${index}] : !milo.ref<${ov.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
          const c = this.copyOut(e, fr, ty, true);
          return this.closeScope(start, false, c) ?? c;
        }
        return get(this.borrow(ov, e.object.type));
      }
      case "StructLit": return this.structLit(e);
      case "EnumLit": {
        const ty = this.value(e.type, "enum literal");
        const v = this.cx.mlirEnumLayout(e.enumName)?.variants.find(x => x.name === e.variant);
        if (!v || v.fields.length !== e.args.length) throw new MlirUnsupported("enum variant");
        const mark = this.pending.length;
        // A 128+ byte payload of an enum that is a value passes through one SSA value from
        // its place (bigArg), as a big argument does at a call.
        const fields = v.fields.map(f => this.place$(f, "payload"));
        const args = e.args.map((a, k) => this.pend(this.operand(a, fields[k], "payload", !isSsa(this.cx, fields[k])), v.fields[k]));
        this.pending.length = mark;
        const ops = args.length ? ` (${args.map(a => a.ref).join(", ")} : ${fields.join(", ")})` : "";
        return { ...this.def(`milo.enum.new ${v.tag}${ops} -> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "IsCheck": return this.peek(e.operand, v => {
        if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("`is` on a non-enum");
        const tag = this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
        const want = this.def(`milo.const ${e.tag} : si32`, "si32");
        return this.def(`milo.cmp eq, ${tag.ref}, ${want.ref} : si32`, "i1");
      });
      case "IfExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("if-expression without a value");
        const ty = this.value(e.type, "if-expression");
        const c = this.expr(e.cond);
        if (c.ty !== "i1") throw new MlirUnsupported("if condition type");
        const ref = this.fresh();
        const mode = this.forkMode(e, ty);
        const fork = { mode, sawView: false };
        this.forks.push(fork);
        try {
          this.region(`${ref} = milo.if ${c.ref} -> ${ty} {`, () => this.tail(e.thenBody, ty));
          // lower.ts folds a compile-time condition to `true` with the dead arm left out
          // (constFoldBool): that else never runs.
          const folded = e.cond.kind === "BoolLit" && e.cond.value && e.elseBody.length === 0;
          this.region("} else {", () => { if (!folded) return this.tail(e.elseBody, ty); this.emit("milo.unreachable"); return true; });
        } finally { this.forks.pop(); }
        this.emit("}");
        return { ref, ty, own: mode === "view" ? (fork.sawView ? "view" : "static") : this.hasDrop(ty) ? "owned" : undefined };
      }
      case "Closure": return this.closure(e);
      case "ClosureCall": return this.valued(this.callScope(() => this.closureCall(e, stmt)), stmt);
      case "MatchExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("match-expression without a value");
        const ty = this.value(e.type, "match-expression");
        const mode = this.forkMode(e, ty);
        const fork = { mode, sawView: false };
        this.forks.push(fork);
        try {
          const v = this.match(e, ty).v;
          return mode === "view" ? { ...v, own: fork.sawView ? "view" : "static" } : v;
        } finally { this.forks.pop(); }
      }
      case "Propagate": return this.propagate(e);
      case "DefaultValue": return this.defaultValue(e);
      case "Unwrap": {
        if (this.isSretCall(e.operand)) {
          // A 128+ byte enum (sret) with a payload that is a value: unwrapped from the
          // call's slot into a scratch slot (unwrapInto), then the payload read out of it.
          const ty = this.value(e.type, "unwrapped payload");
          const dst = this.fresh();
          this.vars.push(`  ${dst} = milo.var "unwrapped" : !milo.ref<${ty}>`);
          this.unwrapInto(e, dst, ty);
          return { ...this.def(`milo.load ${dst} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
        }
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
        // is `??`. The closure-taking ones go through legacy in a helper (optionCallback).
        if (e.op === "unwrapOr" && e.default)
          return this.defaultValue({ kind: "DefaultValue", operand: e.value, default: e.default, enumName: e.enumName, type: e.type, span: e.span });
        if (CALLBACK_OPS.has(e.op)) return this.optionCallback(e);
        if (e.op !== "isSome" && e.op !== "isNone") throw new MlirUnsupported(`option op ${e.op}`);
        const pt = placeType(this.cx, e.value.type);
        let tag: string;
        if ((pt !== null && valueType(this.cx, e.value.type) === null) || this.isSretCall(e.value)) {
          const p = this.fieldPlace(e.value) ?? this.memTemp(e.value);
          if (!p) throw new MlirUnsupported("tag test of a 128+ byte enum that is not a place");
          tag = this.def(`milo.enum.tag_at ${p.ref} : !milo.ref<${p.ty}>`, "si32").ref;
        } else {
          tag = this.peek(e.value, v => {
            if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("tag test of a non-enum");
            return this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
          }).ref;
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
        let n = this.widenBound(v);
        if (n.ty === "ui64") n = this.def(`milo.cast ${n.ref} : ui64 to si64`, "si64");
        this.panicIf(this.constTrue(), [e.head, `${e.tail} at ${this.panicAt(e.span)}\n`], [n.ref]);
        return { ref: "", ty: "" };
      }
      case "VecPanic":
        this.panicIf(this.constTrue(), `${e.message} at ${this.panicAt(e.span)}\n`);
        return { ref: "", ty: "" };
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
      case "StringPushInt": {
        // `s.pushInt(n)`: legacy's genStringPushInt (grow, then the digits in place) in a
        // helper, the string lent `&mut`, the int by value.
        const dst = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const v = this.expr(e.value);
        if (!isScalarTy(v.ty)) throw new MlirUnsupported("pushInt of a non-scalar");
        this.intrinsic("pushint", e, [{ name: "s", type: { tag: "string" }, mode: "mut", ref: dst }, { name: "v", type: e.value.type, mode: "val", ref: v.ref }],
          ([x, y]) => ({ ...e, str: x, value: y }), null, false);
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
        if (valueType(this.cx, et) === null) {
          // A place-only element (an array, a 128+ byte struct): each is built in a slot of
          // the statement, the helper reads it through a raw pointer (a bit copy, as
          // unwrapInto), and the slot is then emptied: the Vec owns the element now. A jump
          // out of a later element drops the slots built so far.
          const pty = this.place$(et, "Vec literal element");
          const slots = e.elements.map(x => this.bigSlot("veclit.elem", x, true));
          const args = slots.map(sl => `${this.def(`milo.addr ${sl.ref} : !milo.ref<${pty}>`, PTR).ref} : ${PTR}`);
          const pt: TypeKind = { tag: "ptr", inner: et };
          const name = this.cx.mlirHelper(`milo.veclit.p.${typeKey(et)}.${e.elements.length}`, () => ({
            params: e.elements.map((_, k) => ({ name: `e${k}`, type: pt, isRef: false, isRefMut: false })),
            retType: e.type,
            body: [{ kind: "Return", retType: e.type, value: { kind: "ArrayLit", type: e.type,
              elements: e.elements.map((_, k) => ({ kind: "PtrDeref" as const, type: et, operand: { kind: "Ident" as const, name: `e${k}`, type: pt, isMove: false } })) } }],
          }));
          const r = this.callHelper(name, args, ty);
          for (const sl of slots) if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${pty}>`, pty);
          if (this.hasDrop(pty)) this.dropGlue(ty, e.type);
          return { ...r, own: "owned" };
        }
        const ety = this.value(et, "Vec literal element");
        const mark = this.pending.length;
        const args = e.elements.map(x => {
          const v = this.pend(this.operand(x, ety, "Vec literal element"), x.type);
          return `${v.ref} : ${ety}`;
        });
        this.pending.length = mark;
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
   * value is spilled to a slot: it is immutable, so the copy reads the same. A scoped
   * task's literal (`heapEnv`) has its env on the heap, freed by the task's reap.
   */
  private closure(e: HIRExpr & { kind: "Closure" }): Val {
    if (e.isMove && !e.heapEnv && !e.keyExtractor) return this.moveClosure(e);
    if (e.isMove) throw new MlirUnsupported("move closure");
    const ty = this.value(e.type, "closure");
    // A global's initializer (__milo.global_init, __milo.lazyinit.*) returns before the
    // global's closure is ever called, so its env is static (milo.closure `static`), as [MILO-O-globalClosureEnv]
    // legacy's staticEnv. A closure inside another closure's body keeps a frame env.
    const staticEnv = e.captures.length > 0 && !e.heapEnv && this.fn.name.startsWith("__milo.") && !this.inClosureBody;
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
    return this.def(`milo.closure @${quote(name)}${ops}${e.heapEnv ? " heap" : ""}${staticEnv ? " static" : ""} : ${ty}`, ty);
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
    this.clones.add(r.ref);
    return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /**
   * `e`, an intrinsic, as a call of a legacy function whose body is `make` applied to its
   * params: one per intrinsic, param types and call site, since its panics name the line and column.
   * `ops` are the operands as already evaluated, in legacy's order; a `ref`/`mut` one is a place.
   */
  private intrinsic(kind: string, e: HIRExpr, ops: { name: string; type: TypeKind; mode: "val" | "ref" | "mut"; ref: string }[],
    make: (idents: HIRExpr[]) => HIRExpr, ret: string | null, panics = true): Val {
    const l = panics ? this.site(e.span) : { line: 0, col: 0, file: "" };
    const tys = ops.map(o => o.mode === "val" ? this.value(o.type, "intrinsic operand") : this.lent(o.type, "intrinsic operand"));
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
    // A 128+ byte or place-only capture: its address goes in, the helper binds the capture
    // from `*p` (a bit copy the closure moves into its env), and the local's slot is
    // emptied after the call: one owner throughout, as legacy's move of the local.
    const viaPtr: { name: string; type: TypeKind; slot: string; ty: string }[] = [];
    const after: (() => void)[] = [];
    for (const c of e.captures) {
      if (c.type.tag === "ref") throw new MlirUnsupported("move closure capturing a reference");
      if (valueType(this.cx, c.type) === null || inSlot(this.cx, this.place$(c.type, "capture"))) {
        const pty = this.place$(c.type, "capture");
        const b = this.lookup(c.name);
        if (b.kind !== "var" || b.ty !== pty || (this.hasDrop(pty) && !b.owned) || c.share) throw new MlirUnsupported("128+ byte capture that is not an owned local");
        const pt: TypeKind = { tag: "ptr", inner: c.type };
        params.push({ name: `${c.name}$p`, type: pt, isRef: false, isRefMut: false });
        args.push(this.def(`milo.addr ${b.ref} : !milo.ref<${pty}>`, PTR));
        viaPtr.push({ name: c.name, type: c.type, slot: b.ref, ty: pty });
        if (this.hasDrop(pty)) after.push(() => { this.def(`milo.move ${b.ref} : !milo.ref<${pty}>`, pty); });
        continue;
      }
      const cty = this.value(c.type, "capture");
      const b = this.lookup(c.name);
      let v: Val;
      if (b.kind === "ssa") v = this.consume(b.v, "capture");
      // A plain fn capture of an owning fn local (`let work: (T) => T = f`, the alias the
      // checker allows): the value read through a non-owning view, as legacy copies it.
      else if (b.kind === "var" && b.ty === cty.replace(/^!milo\.fn</, "!milo.fn<owning ") && b.ty !== cty)
        v = this.def(`milo.fn.cast ${this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty).ref} : ${b.ty} -> ${cty}`, cty);
      else if (b.kind !== "var" || b.ty !== cty) throw new MlirUnsupported(`capture binding (${b.kind === "var" ? `${b.ty} for ${cty}` : b.kind} ${c.name})`);
      else if (!this.hasDrop(cty)) v = this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty);
      else if (c.share && cty === STR) {
        this.cx.mlirStringOps();
        v = { ...this.def(`milo.string.share ${b.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      } else if (b.owned && !c.share) v = { ...this.def(`milo.move ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
      else if (!b.owned && !c.share && this.inClosureBody && !this.runsUserDrop(cty)) {
        // A capture of an enclosing by-ref closure (its slot is the owner's, in another
        // frame) moved on into this one, as legacy does it: read out and zeroed through
        // the reference, so the owner's own drop later finds it empty.
        v = { ...this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
        this.emit(`milo.store ${this.def(`milo.zero : ${cty}`, cty).ref}, ${b.ref} init : !milo.ref<${cty}>`);
      } else throw new MlirUnsupported("capture that is not a move of an owned local");
      params.push({ name: c.name, type: c.type, isRef: false, isRefMut: false });
      args.push(v);
    }
    const name = `milo.mkclosure.${this.fn.name}.${this.closures.next++}`;
    this.cx.mlirHelper(name, () => ({
      params, retType: e.type,
      // The helper's params are its own: every capture is moved into the env.
      body: [
        ...viaPtr.map(p => ({ kind: "Let" as const, name: p.name, type: p.type, mutable: false,
          value: { kind: "PtrDeref" as const, type: p.type, operand: { kind: "Ident" as const, name: `${p.name}$p`, type: { tag: "ptr", inner: p.type } as TypeKind, isMove: false } } } as HIRStmtBase)),
        { kind: "Return" as const, retType: e.type, value: { ...e, captures: e.captures.map(c => ({ ...c, share: false })) } },
      ],
    }));
    const fnTy = `(${args.map(a => a.ty).join(", ")}) -> ${ty}`;
    this.callees.set(name, fnTy);
    this.dropGlue(ty, e.type);
    const r = this.def(`func.call @${quote(name)}(${args.map(a => a.ref).join(", ")}) : ${fnTy}`, ty);
    for (const done of after) done();
    return { ...r, own: "owned" };
  }

  /** `f(args)` through a fn value: the callee, then the args, as legacy genClosureCall. */
  private closureCall(e: HIRExpr & { kind: "ClosureCall" }, _stmt: boolean): Val {
    // For this call only, as call() takes it: a result that lives in memory is the ABI's value.
    const abi = this.abiResult;
    this.abiResult = false;
    const ft = stripRefs(this.fieldType(e.callee));
    if (ft.tag !== "fn") throw new MlirUnsupported("call of a non-fn");
    const f = this.expr(e.callee);
    if (!f.ty.startsWith("!milo.fn<")) throw new MlirUnsupported("callee type");
    if (ft.params.length !== e.args.length) throw new MlirUnsupported("closure call arity");
    const ptys = ft.params.map(p => closureParamType(this.cx, p));
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const mark = this.pending.length;
    const args = e.args.map((a, i) => {
      const pty = ptys[i];
      if (pty === null || (ft.params[i].tag === "ref") !== a.passByRef) throw new MlirUnsupported("closure call arg");
      if (a.passByRef) {
        const r = this.place(a.expr, pty, a.refMut).ref;
        refs.push({ ref: r, mut: a.refMut, ty: pty });
        return r;
      }
      const v = this.pend(this.operand(a.expr, pty, "argument", true), a.expr.type);
      return v.ref;
    });
    this.pending.length = mark;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
        this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
      }
    }
    const ret = ft.ret.tag === "void" ? null : abi ? this.place$(ft.ret, "closure result") : this.value(ft.ret, "closure result");
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
  private ptrBinding(e: HIRExpr): { ptr: string; ty: string } | null {
    if (e.kind !== "Ident") return null;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(e.name);
      if (b) return b.kind === "ptr" ? { ptr: b.ptr, ty: b.ty } : null;
    }
    return null;
  }

  private ptrPlace(e: HIRExpr): { ptr: string; ty: string } | null {
    const pb = this.ptrBinding(e);
    if (pb) return pb;
    if (e.kind === "PtrDeref") {
      // `*p`: what p points at, of any type; an owning one is a bit copy, as ptrRead says.
      const p = this.expr(e.operand);
      if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
      return { ptr: p.ref, ty: this.place$(e.type, "load through a pointer") };
    }
    {
      // A fixed array's element behind a pointer (`p[1][0]`, p: *[T; N]): bounds-checked
      // against N as legacy's fixed-array index (the same __milo_bounds_fail), then stepped
      // to as a pointer: the dialect has no milo.ref behind a pointer.
      const ot = stripRefs(e.kind === "IndexAccess" ? e.object.type : { tag: "void" } as TypeKind);
      const base = e.kind === "IndexAccess" && ot.tag === "array" && ot.size !== null ? this.ptrPlace(e.object) : null;
      if (base && e.kind === "IndexAccess" && ot.tag === "array" && ot.size !== null) {
        const i = this.index(e.index);
        const n = this.def(`milo.const ${ot.size} : si64`, "si64").ref;
        this.emit(`milo.bounds_check ${i}, ${n} : si64, si64 ${this.loc(e.span)}`);
        const ty = this.place$(ot.element, "array element");
        return { ptr: this.def(`milo.ptr.elem ${base.ptr}[${i}] : ${ty}`, PTR).ref, ty };
      }
    }
    if (e.kind === "IndexAccess" && stripRefs(e.object.type).tag === "ptr") {
      const p = this.expr(e.object);
      const i = this.expr(e.index);
      if (p.ty !== PTR || i.ty !== "si64") throw new MlirUnsupported("pointer index of another type");
      const ty = this.place$(e.type, "pointer element");
      return { ptr: this.def(`milo.ptr.elem ${p.ref}[${i.ref}] : ${ty}`, PTR).ref, ty };
    }
    if (e.kind !== "FieldAccess") return null;
    const obj = stripRefs(e.object.type);
    let base: { ptr: string; ty: string } | null;
    let st: TypeKind;
    if (obj.tag === "ptr") {
      st = obj.inner;
      const p = this.expr(e.object);
      base = { ptr: p.ref, ty: this.place$(st, "pointee") };
    } else {
      base = this.ptrPlace(e.object);
      st = obj;
    }
    if (!base) return null;
    if (st.tag !== "struct") throw new MlirUnsupported("field through a pointer to a non-struct");
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    const ty = this.place$(e.type, "field");
    return { ptr: this.def(`milo.ptr.field ${base.ptr}[${index}] : ${base.ty}`, PTR).ref, ty };
  }

  /** A read of a place through a pointer: a bit copy that, for a string or a Vec, owns. */
  private ptrRead(p: { ptr: string; ty: string }): Val {
    if (!isSsa(this.cx, p.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
    const v: Val = { ...this.def(`milo.ptr.load ${p.ptr} : ${p.ty}`, p.ty), own: this.hasDrop(p.ty) ? "owned" : undefined };
    if (v.own) this.bitCopies.add(v.ref);
    return v;
  }

  // Owning values read through a raw pointer: the bits of a value the memory still owns.
  // Moved somewhere (std's pop), the move takes it; only borrowed (`f(src[i])` with a
  // `&T` param, a print part), it must not be dropped, as legacy lends the element's address.
  private bitCopies = new Set<string>();

  /**
   * A value that lives in memory (Repr) but is no place (an sret call's result, a 128+
   * byte literal) read in place (`regionByKey(s).isNone()`, `mk().field`): built in a slot
   * of the open frame (tempSlot), or null for anything else. One whose drop runs a user
   * Drop stays legacy: legacy drops it right after the read, the frame later.
   */
  private memTemp(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind === "Ident" || e.kind === "FieldAccess" || e.kind === "IndexAccess" || e.kind === "HeapDeref" || e.kind === "PtrDeref") return null;
    const pt = placeType(this.cx, e.type);
    if (!this.isSretCall(e) && (pt === null || isSsa(this.cx, pt))) return null;
    if (pt !== null && this.runsUserDrop(pt)) throw new MlirUnsupported("a temporary with a user Drop read in place");
    const sl = this.bigSlot("tmp", e, true);
    return { ref: sl.ref, ty: sl.ty };
  }

  /** The slot `e` names (a `var`, a by-ref param, a field of either), or null for a value. */
  private fieldPlace(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      return b.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : null;
    }
    if (e.kind === "IndexAccess") return this.elemRef(e);
    // A temporary box is no place: a read through it moves the payload out and frees the
    // box (the HeapDeref value), then drops what it read once the read is done.
    if (e.kind === "HeapDeref") return isTempBox(e.operand) ? null : this.heapPlace(e);
    if (e.kind !== "FieldAccess") return null;
    const base = this.fieldPlace(e.object) ?? this.memTemp(e.object);
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
    const mark = this.pending.length;
    for (const f of e.fields) given.set(f.name, this.pend(this.fieldValue(f.value, layout.fields.find(lf => lf.name === f.name)?.typeKind), f.value.type));
    this.pending.length = mark;
    // The base is consumed (legacy genStructUpdateBase): it gives up its unlisted fields and [MILO-O-structUpdate]
    // its listed ones are dropped here, in field order, so each field ends with one owner.
    const base = e.base ? this.consume(this.expr(e.base), "struct update base") : null;
    if (base && base.ty !== ty) throw new MlirUnsupported("struct update base of another type");
    if (base && this.hasDrop(ty)) {
      if (base.own !== "owned") throw new MlirUnsupported("struct update of an owning base it does not own");
      layout.fields.forEach((lf, i) => {
        const fty = this.value(lf.typeKind, "field");
        if (!given.has(lf.name) || !this.hasDrop(fty)) return;
        this.owned.push([]);
        const start = this.body.length;
        const slot = this.ownedSlot("update.base", fty, lf.typeKind);
        this.emit(`milo.store ${this.def(`milo.struct.get ${base.ref}[${i}] : ${ty} -> ${fty}`, fty).ref}, ${slot} : !milo.ref<${fty}>`);
        this.closeScope(start, false, null);
      });
    }
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
  /**
   * A user fork's ownership, as legacy's blockValueOwnsResult: owned when some arm yields [MILO-O-forkOwnership]
   * an owned value (the checker clones a place arm there), else a view (only views and
   * literals, or a view of a user-Drop type, which no clone may copy). Null: owns nothing.
   */
  // `sawView`: some arm of a view fork yielded a borrow (not only literals, which are static).
  private forks: { mode: "own" | "view" | null; sawView: boolean }[] = [];
  private forkMode(e: HIRExpr & { kind: "IfExpr" | "MatchExpr" }, ty: string): "own" | "view" | null {
    if (!this.hasDrop(ty)) return null;
    return this.cx.mlirBlockValueOwnsResult(e) ? "own" : "view";
  }

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
    const fork = this.forks[this.forks.length - 1];
    if (fork?.mode === "view") {
      // A view fork's arms only lend (a place, a literal): nothing here is owned.
      if (v.own === "owned" && !this.bitCopies.has(v.ref)) throw new MlirUnsupported("view fork arm that owns its value");
      if (v.own === "view") fork.sawView = true;
    } else if (fork?.mode === "own" && v.own === "view") {
      // An owning fork's place arm (`if c { s } else { s + "y" }`) hands over a clone, so
      // the fork owns what it yields on every path (legacy cloneViewValue). [MILO-O-forkOwnership]
      const slot = this.fresh();
      this.vars.push(`  ${slot} = milo.var "fork.view" : !milo.ref<${v.ty}>`);
      this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
      v = this.copyOut(last.expr, slot, v.ty, true);
    } else v = this.consume(v, "block value");
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
    // `match e {}` on an uninhabited type: no value reaches it (legacy emits unreachable).
    if (m.arms.length === 0) {
      this.peek(m.subject, v => v);
      this.emit("milo.unreachable");
      return { done: true, v: { ref: "", ty: "" } };
    }
    const outer = { scope: this.scopes[this.scopes.length - 1], frame: this.blocks[this.blocks.length - 1] };
    let root = m.subject;
    while (root.kind === "FieldAccess") root = root.object;
    const subjLives = root.kind === "Ident";
    // An owning subject matched by value moves its payload into the bindings (legacy
    // bindPayloads zeroes it in the subject); matched by reference, bindings are views.
    const subjPlaceTy = placeType(this.cx, m.subject.type);
    // A 128+ byte enum is matched through its place: a switch on the tag read there
    // (milo.enum.tag_at), each binding the payload field's place (milo.enum.field_ref).
    const bigEnum = subjPlaceTy !== null && inSlot(this.cx, subjPlaceTy) && subjPlaceTy.startsWith("!milo.enum<");
    const owning = this.hasDrop(bigEnum ? subjPlaceTy! : this.value(m.subject.type, "match subject"));
    // By value, the owned slot the subject lives in: an arm that binds an owning payload
    // field moves the subject out of it (milo.move), so drop elaboration sees it empty on
    // that path and full on the others, as legacy's alive flag does.
    let from: string | null = null;
    // A `&mut` subject's place: its bindings are the payload's own places
    // (milo.enum.field_ref), so writing one writes the payload.
    let place: { ref: string; ty: string } | null = null;
    let structural = false;
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
      if (place && inSlot(this.cx, place.ty)) throw new MlirUnsupported("match on a 128+ byte enum");
      if (!place || !place.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("match on a &mut subject that is not an enum place");
      subj = { ...this.def(`milo.load ${place.ref} : !milo.ref<${place.ty}>`, place.ty), own: this.hasDrop(place.ty) ? "view" : undefined };
    } else if (owning && !m.subjectIsRef) {
      const e = m.subject;
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b?.kind === "var" && b.owned) from = b.ref;
      else {
        const v = this.expr(e);
        if (v.own !== "owned") throw new MlirUnsupported("match moving out of a borrowed enum");
        // A `v[i]` subject is its element's structural clone (tempSlot): its bindings only
        // borrow from it, so none takes a payload with a drop of its own.
        const clone = e.kind === "IndexAccess" && this.clones.has(v.ref);
        from = this.tempSlot("subject", v.ty, e.type, v, clone);
        this.emit(`milo.store ${v.ref}, ${from} : !milo.ref<${v.ty}>`);
        if (clone) structural = true;
      }
      const ty = this.value(e.type, "match subject");
      subj = { ...this.def(`milo.load ${from} : !milo.ref<${ty}>`, ty), own: "view" };
    } else {
      // Read in place; a `v[i]` subject is its element's structural clone (tempSlot).
      const v = this.expr(m.subject);
      if (m.subject.kind === "IndexAccess" && this.clones.has(v.ref)) {
        const slot = this.tempSlot("subject", v.ty, m.subject.type, v, true);
        this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
        subj = { ...this.def(`milo.load ${slot} : !milo.ref<${v.ty}>`, v.ty), own: "view" };
      } else subj = this.borrow(v, m.subject.type);
    }
    const isEnum = bigEnum || subj.ty.startsWith("!milo.enum<");
    // A float subject compares every literal as a float (legacy fcmp oeq), int patterns too.
    if (!isEnum && (/^f\d+$/.test(subj.ty) || m.arms.some(a => a.pattern.kind === "LiteralPattern" && (a.pattern.literalKind === "string" || a.pattern.literalKind === "float"))))
      return this.literalChain(m.arms, subj, stripRefs(m.subject.type), resultTy, armBody);
    const st = stripRefs(m.subject.type);
    const layout = isEnum ? this.enumLayout(st.tag === "enum" ? st.name : "") : null;
    if (!isEnum && !/^([su]i\d+|i1)$/.test(subj.ty)) throw new MlirUnsupported(`match on ${subj.ty}`);
    // Literal arms (none in a checked enum match) and a lone arm stay on the flat path's refusals.
    if (layout && m.arms.length > 1 && m.arms.some(a => a.pattern.kind === "EnumPattern" && a.pattern.tests) && m.arms.every(a => a.pattern.kind !== "LiteralPattern"))
      return this.nestedMatch(m, { subj, from, place, structural, bigEnum, enumName: (st as { name: string }).name }, outer, subjLives, resultTy, armBody);
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
        // A nested arm reaches here only in a match of one arm (nestedMatch takes the rest).
        const v = layout?.variants.find(x => x.tag === p.tag);
        if (!v || p.tests || p.bindings.length > v.fields.length) throw new MlirUnsupported("enum pattern");
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
    // A payload place an escaping binding names is taken ahead of the match, where what
    // follows the match can see it (an address only; its variant is tested in the arm).
    const pre = new Map<string, string>();
    const fieldRef = (tag: number | undefined, k: number, ty: string) => pre.get(`${tag}.${k}`)
      ?? this.def(`milo.enum.field_ref ${place!.ref}[${tag}, ${k}] : !milo.ref<${place!.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
    if (place) for (const { arm, args, tag } of arms) {
      const p = arm.pattern;
      if (p.kind === "EnumPattern") args.forEach((a, k) => { if (p.bindings[k]?.escapes && a.name !== "_") pre.set(`${tag}.${k}`, fieldRef(tag, k, a.ty)); });
    }
    const ref = resultTy ? this.fresh() : "";
    const head = `${resultTy ? `${ref} = ` : ""}milo.match ${subj.ref} : ${subj.ty}${resultTy ? ` -> ${resultTy}` : ""} [${cases.join(", ")}]${dflt ? " default" : ""} {`;
    let allDone = true;
    arms.forEach(({ arm, args, tag }, i) => {
      const bd = this.armBinder(arm.pattern, outer, subjLives);
      const consumes = from !== null && !structural && args.some(a => a.name !== "_" && this.hasDrop(a.ty));
      // Legacy stops dropping the subject once an arm takes a payload, so an owning field
      // the arm leaves unbound would be legacy's leak; not reproduced.
      if (consumes && args.some(a => a.name === "_" && this.hasDrop(a.ty))) this.leaksUnbound();
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
            const slot = owns ? bd.owned(a.name, a.ty, layout!.variants.find(x => x.tag === tag)!.fields[k]) : this.fresh();
            if (!owns) this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            this.emit(`milo.store ${v}, ${slot} : !milo.ref<${a.ty}>`);
            bd.bind(a.name, { kind: "var", ref: slot, ty: a.ty, owned: owns }, false);
          });
        } else if (bigEnum) {
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const r = fieldRef(tag, k, a.ty);
            // Through `&mut`, and for a payload with drop glue, the binding is the payload's
            // place (legacy binds a pointer); a Copy payload under `&` is a copy.
            if (m.subjectIsMut || this.hasDrop(a.ty) || inSlot(this.cx, a.ty)) { bd.bind(a.name, { kind: "var", ref: r, ty: a.ty }, true); return; }
            const slot = this.fresh();
            this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            const v = this.def(`milo.load ${r} : !milo.ref<${a.ty}>`, a.ty).ref;
            this.emit(`milo.store ${v}, ${slot} : !milo.ref<${a.ty}>`);
            bd.bind(a.name, { kind: "var", ref: slot, ty: a.ty }, false);
          });
        } else if (args.length) {
          const refs = args.map(() => this.fresh());
          this.emit(`^bb0(${args.map((a, k) => `${refs[k]}: ${a.ty}`).join(", ")}):`);
          if (place) {
            args.forEach((a, k) => {
              if (a.name === "_") return;
              bd.bind(a.name, { kind: "var", ref: fieldRef(tag, k, a.ty), ty: a.ty }, true);
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
              const slot = bd.owned(a.name, a.ty, layout!.variants.find(v => v.tag === tag)!.fields[k]);
              this.emit(`milo.store ${refs[k]}, ${slot} : !milo.ref<${a.ty}>`);
              bd.bind(a.name, { kind: "var", ref: slot, ty: a.ty, owned: true }, false);
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
            bd.bind(a.name, { kind: "var", ref: slot, ty: a.ty }, this.hasDrop(a.ty));
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
   * How an arm of `p` makes its bindings: in the arm's scope, or, for one that escapes the
   * arm (let-else's), in the block the match sits in, whose end drops an owning one (legacy
   * leaves those to the enclosing scope's drops). An escaping view must read a subject
   * that outlives the match, one rooted at a binding (`subjLives`), never a temporary the
   * match's statement drops.
   */
  private armBinder(p: HIRPattern, outer: MatchOuter, subjLives: boolean): ArmBinder {
    const esc = new Set(p.kind === "EnumPattern" ? p.bindings.filter(b => b.escapes).map(b => b.name) : []);
    return {
      bind: (name, b, view) => {
        if (!esc.has(name)) { this.bind(name, b); return; }
        if (view && !subjLives) throw new MlirUnsupported("escaping view of a temporary subject");
        outer.scope.set(name, b);
      },
      owned: (name, ty, t) => this.ownedSlot(name, ty, t, false, esc.has(name) ? outer.frame : false),
    };
  }

  /** An enum's layout, or the function stays legacy. */
  private enumLayout(name: string): NonNullable<ReturnType<MlirEmitCtx["mlirEnumLayout"]>> {
    const l = this.cx.mlirEnumLayout(name);
    if (!l) throw new MlirUnsupported("match subject layout");
    return l;
  }

  /**
   * Legacy stops dropping the subject once an arm takes a payload, so an owning part the
   * arm leaves unbound would be legacy's leak; not reproduced.
   */
  private leaksUnbound(): never { throw new MlirUnsupported("match leaving an owning payload field unbound"); }

  /**
   * A match with a nested arm, as legacy genNestedArms: arms are tried in order, each by
   * its top tag and then its sub-pattern tests, and the first that passes runs. Testing
   * only reads the subject, so the choice is made first, as the arm's index (milo.ifs, a
   * test short-circuiting the ones after it, since a test's path reads a payload that only
   * the tests before it prove is there); a milo.match on the index then runs the arm,
   * which binds each payload at its path with a flat arm's move/borrow rule.
   */
  private nestedMatch(m: { subject: HIRExpr; arms: (HIRStmt & { kind: "Match" })["arms"]; subjectIsMut?: boolean; subjectIsRef?: boolean },
    s: { subj: Val; from: string | null; place: { ref: string; ty: string } | null; structural: boolean; bigEnum: boolean; enumName: string },
    outer: MatchOuter, subjLives: boolean, resultTy: string | null, armBody?: (body: HIRStmt[]) => boolean): { done: boolean; v: Val } {
    const { subj, place, bigEnum } = s;
    const key = (path: HIRPatStep[]) => path.map(st => `${st.variant}.${st.index}`).join("/");
    // Payload places escaping bindings name, taken ahead of the match (as for a flat arm).
    const pre = new Map<string, Val>();
    const variantOf = (enumName: string, pick: (v: { name: string; tag: number }) => boolean) => {
      return this.enumLayout(enumName).variants.find(pick)!;
    };
    // The payload `path` names: its place (a field_ref chain) when `inPlace`, else its value.
    const walk = (path: HIRPatStep[], inPlace: boolean, root?: Val): Val => {
      const early = inPlace && !root ? pre.get(key(path)) : undefined;
      if (early) return early;
      let at = root ??(inPlace ? { ref: place!.ref, ty: `!milo.ref<${place!.ty}>` } : subj);
      for (const st of path) {
        const v = variantOf(st.enumName, x => x.name === st.variant);
        const f = v.fields[st.index];
        if (inPlace) {
          const ty = `!milo.ref<${this.place$(f, "payload")}>`;
          at = this.def(`milo.enum.field_ref ${at.ref}[${v.tag}, ${st.index}] : ${at.ty} -> ${ty}`, ty);
        } else {
          const ty = this.value(f, "payload");
          at = this.def(`milo.enum.payload ${at.ref}[${v.tag}, ${st.index}] : ${at.ty} -> ${ty}`, ty);
        }
      }
      return at;
    };
    const fieldType = (path: HIRPatStep[]): TypeKind => {
      const st = path[path.length - 1];
      return variantOf(st.enumName, x => x.name === st.variant).fields[st.index];
    };
    const eqTag = (tag: Val, want: number): Val =>
      this.def(`milo.cmp eq, ${tag.ref}, ${this.def(`milo.const ${want} : si32`, "si32").ref} : si32`, "i1");
    // A 128+ byte subject is tested in its place; any other through its value.
    const tagAt = (path: HIRPatStep[]): Val => {
      if (bigEnum && path.length === 0) return subj;
      const at = walk(path, bigEnum);
      return bigEnum ? this.def(`milo.enum.tag_at ${at.ref} : ${at.ty}`, "si32") : this.def(`milo.enum.tag ${at.ref} : ${at.ty}`, "si32");
    };
    const litTest = (t: HIRPatTest & { kind: "lit" }): Val => {
      let v = walk(t.path, bigEnum);
      if (bigEnum) {
        const ty = v.ty.slice("!milo.ref<".length, -1);
        v = this.def(`milo.load ${v.ref} : ${v.ty}`, ty);
      }
      const name = `match$lit${this.n++}`;
      this.bind(name, { kind: "ssa", v: { ...v, own: this.hasDrop(v.ty) ? "view" : undefined } });
      const left: HIRExpr = { kind: "Ident", name, type: t.type, isMove: false };
      return this.binop({ kind: "BinOp", op: "==", left, right: patLiteral(t.literalKind, t.value, t.type), type: { tag: "bool" } });
    };
    // Every test of an arm, in order, each run only when the ones before it passed.
    const all = (tests: (() => Val)[], i: number): Val => {
      const c = tests[i]();
      if (i === tests.length - 1) return c;
      const r = this.fresh();
      this.region(`${r} = milo.if ${c.ref} -> i1 {`, () => all(tests, i + 1));
      this.region("} else {", () => this.def("milo.const false", "i1"));
      this.emit("}");
      return { ref: r, ty: "i1" };
    };
    // The checker proved some arm matches, so the last one is taken without its tests.
    const index = (i: number): Val => {
      const p = m.arms[i].pattern;
      const k = () => this.def(`milo.const ${i} : si32`, "si32");
      if (i === m.arms.length - 1 || p.kind === "WildcardPattern") return k();
      if (p.kind !== "EnumPattern") return k();
      const c = all([() => eqTag(tagAt([]), p.tag), ...(p.tests ?? []).map(t => () => t.kind === "tag" ? eqTag(tagAt(t.path), t.tag) : litTest(t))], 0);
      const r = this.fresh();
      this.region(`${r} = milo.if ${c.ref} -> si32 {`, k);
      this.region("} else {", () => index(i + 1));
      this.emit("}");
      return { ref: r, ty: "si32" };
    };
    const pathOf = (p: HIRPattern & { kind: "EnumPattern" }, k: number) => p.bindings[k].path ?? [{ enumName: s.enumName, variant: p.variant, index: k }];
    if (place) for (const { pattern: p } of m.arms) {
      if (p.kind === "EnumPattern") p.bindings.forEach((b, k) => { if (b.escapes && b.name !== "_") pre.set(key(pathOf(p, k)), walk(pathOf(p, k), true)); });
    }
    const idx = index(0);
    const ref = resultTy ? this.fresh() : "";
    const head = `${resultTy ? `${ref} = ` : ""}milo.match ${idx.ref} : si32${resultTy ? ` -> ${resultTy}` : ""} [${m.arms.slice(1).map((_, i) => i).join(", ")}] default {`;
    let allDone = true;
    m.arms.forEach((arm, i) => {
      const done = this.region(i === 0 ? head : "}, {", () => {
        const p = arm.pattern;
        if (p.kind === "EnumPattern" && p.bindings.length) this.bindPaths(p, s, this.armBinder(p, outer, subjLives), walk, fieldType, variantOf, m.subjectIsMut);
        return armBody ? armBody(arm.body) : resultTy ? this.tail(arm.body, resultTy) : this.stmts(arm.body);
      });
      if (!done) allDone = false;
    });
    this.emit("}");
    if (!resultTy && !armBody && allDone) { this.emit("milo.unreachable"); return { done: true, v: { ref: "", ty: "" } }; }
    return { done: false, v: { ref, ty: resultTy ?? "", own: resultTy && this.hasDrop(resultTy) ? "owned" : undefined } };
  }

  /**
   * A nested arm's bindings, each the payload at its path, by legacy bindPayloads' rule:
   * matched by value with an owning payload bound, the subject is moved out (milo.move)
   * and each binding owns its payload, and a string a literal test matched is dropped
   * (legacy frees it rather than leak it); otherwise each binding is a copy of its payload
   * or, through `&mut` or for one with drop glue, the payload's place.
   */
  private bindPaths(p: HIRPattern & { kind: "EnumPattern" },
    s: { subj: Val; from: string | null; place: { ref: string; ty: string } | null; structural: boolean; bigEnum: boolean; enumName: string },
    bd: ArmBinder, walk: (path: HIRPatStep[], inPlace: boolean, root?: Val) => Val, fieldType: (path: HIRPatStep[]) => TypeKind,
    variantOf: (enumName: string, pick: (v: { name: string; tag: number }) => boolean) => { name: string; tag: number; fields: TypeKind[] },
    subjectIsMut?: boolean): void {
    const { subj, from, place, structural, bigEnum } = s;
    const binds = p.bindings.map((b, k) => {
      const path = b.path ?? [{ enumName: s.enumName, variant: p.variant, index: k }];
      const t = fieldType(path);
      return { name: b.name, path, t, ty: bigEnum ? this.place$(t, "payload") : this.value(t, "payload") };
    }).filter(b => b.name !== "_");
    const consumes = from !== null && !structural && binds.some(b => this.hasDrop(b.ty));
    const plain = (name: string, ty: string, v: string) => {
      const slot = this.fresh();
      this.vars.push(`  ${slot} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
      this.emit(`milo.store ${v}, ${slot} : !milo.ref<${ty}>`);
      bd.bind(name, { kind: "var", ref: slot, ty }, this.hasDrop(ty));
    };
    if (!consumes) {
      for (const b of binds) {
        if (!place) { plain(b.name, b.ty, walk(b.path, false).ref); continue; }
        const r = walk(b.path, true);
        // Through `&mut`, and for a payload with drop glue, the binding is the payload's
        // place (legacy binds a pointer); a Copy payload under `&` is a copy.
        if (subjectIsMut || this.hasDrop(b.ty) || inSlot(this.cx, b.ty)) { bd.bind(b.name, { kind: "var", ref: r.ref, ty: b.ty }, true); continue; }
        plain(b.name, b.ty, this.def(`milo.load ${r.ref} : ${r.ty}`, b.ty).ref);
      }
      return;
    }
    // Every owning part of the subject must leave with a binding or be a matched string,
    // or it would be legacy's leak (the subject is no longer dropped); not reproduced.
    const key = (path: HIRPatStep[]) => path.map(st => `${st.variant}.${st.index}`).join("/");
    const bound = new Set(binds.map(b => key(b.path)));
    const tests = new Map((p.tests ?? []).map(t => [key(t.path), t]));
    const lits: { path: HIRPatStep[]; t: TypeKind; ty: string }[] = [];
    const visit = (enumName: string, variant: { name: string; fields: TypeKind[] }, path: HIRPatStep[]) => variant.fields.forEach((f, k) => {
      const at = [...path, { enumName, variant: variant.name, index: k }];
      const t = tests.get(key(at));
      if (bound.has(key(at))) return;
      if (t?.kind === "tag") { visit(t.enumName, variantOf(t.enumName, x => x.tag === t.tag) as { name: string; fields: TypeKind[] }, at); return; }
      const ty = bigEnum ? this.place$(f, "payload") : this.value(f, "payload");
      if (!this.hasDrop(ty)) return;
      if (t?.kind !== "lit") this.leaksUnbound();
      lits.push({ path: at, t: f, ty });
    });
    visit(s.enumName, variantOf(s.enumName, x => x.name === p.variant) as { name: string; fields: TypeKind[] }, []);
    const parts = [...binds, ...lits.map(l => ({ name: "", ...l }))];
    let vals: string[];
    if (bigEnum) {
      // Read out of the place, then the subject's slot is emptied (its value goes unused).
      vals = parts.map(b => { const r = walk(b.path, true); return this.def(`milo.load ${r.ref} : ${r.ty}`, b.ty).ref; });
      this.def(`milo.move ${from} : !milo.ref<${place!.ty}>`, place!.ty);
    } else {
      const moved = this.def(`milo.move ${from} : !milo.ref<${subj.ty}>`, subj.ty);
      vals = parts.map(b => walk(b.path, false, moved).ref);
    }
    parts.forEach((b, k) => {
      if (!this.hasDrop(b.ty)) { plain(b.name, b.ty, vals[k]); return; }
      // The binding owns the payload now, for the arm's scope; a matched string dies with it.
      const slot = b.name ? bd.owned(b.name, b.ty, b.t) : this.ownedSlot("lit", b.ty, b.t);
      this.emit(`milo.store ${vals[k]}, ${slot} : !milo.ref<${b.ty}>`);
      if (b.name) bd.bind(b.name, { kind: "var", ref: slot, ty: b.ty, owned: true }, false);
    });
  }

  /**
   * `x?` as the match it means, as legacy genPropagate: `Ok(v) => v` (tag 0, Some for an
   * Option), `Err(e) => return Err(e)` in the function's result enum, the error wrapped in
   * its From variant first for a conversion. The error arm is a return statement, so the
   * scope drops run before it and a pending owned operand keeps the function legacy.
   */
  private propagate(e: HIRExpr & { kind: "Propagate" }, into?: { dst: string; ty: string }): Val {
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
    if (e.boxConversion) {
      // `?` into a `Result<T, Heap<I>>` fn (legacy emitBoxAsIface): the error, wrapped in [MILO-O-propagate]
      // its one-field message struct first when `viaMessage` (a string as ErrorMessage),
      // boxed and coerced to the interface, as `Heap(e)` coerced to `Heap<I>`.
      const box = e.boxConversion;
      if (!errVal) throw new MlirUnsupported("`?` boxing of a payload-less error");
      let inner: HIRExpr = errVal;
      const boxed: TypeKind = box.viaMessage ? { tag: "struct", name: box.fromType } : box.errType;
      if (box.viaMessage) {
        const f0 = this.cx.structLayouts.get(box.fromType)?.fields[0];
        if (!f0) throw new MlirUnsupported("`?` boxing layout");
        inner = { kind: "StructLit", name: box.fromType, fields: [{ name: f0.name, value: errVal }], type: boxed };
      }
      const heap: TypeKind = { tag: "heap", inner: boxed };
      errVal = { kind: "InterfaceCoerce", value: { kind: "HeapCreate", value: inner, type: heap }, fromType: box.fromType, ifaceName: box.ifaceName,
        type: { tag: "heap", inner: { tag: "interface", name: box.ifaceName } } } as HIRExpr;
    } else if (e.messageFn) {
      // `?` into a `Result<T, string>` fn (legacy genPropagate): the error's message() is [MILO-O-propagate]
      // the string; the typed error stays the arm's binding, so its scope drops it.
      if (!errVal) throw new MlirUnsupported("`?` message of a payload-less error");
      errVal = { kind: "Call", func: e.messageFn.fn, type: { tag: "string" }, variadic: false,
        args: [{ expr: { kind: "Ident", name: errName, type: err.fields[0], isMove: false }, passByRef: true, refMut: false }] } as HIRExpr;
    } else if (e.fromConversion) {
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
    this.forks.push({ mode: null, sawView: false });
    try { return this.match({ subject: e.operand, arms: [okArm, errArm] }, resultTy).v; } finally { this.forks.pop(); }
  }

  /**
   * `x ?? d` as the match it means, as legacy genDefaultValue: `Some(v) => v` (tag 0; Ok),
   * anything else evaluates `d`. The subject is consumed only on the first arm.
   */
  private defaultValue(e: HIRExpr & { kind: "DefaultValue" }, into?: { dst: string; ty: string }): Val {
    const ok = this.cx.mlirEnumLayout(e.enumName)?.variants.find(v => v.tag === 0);
    if (!ok || ok.fields.length !== 1) throw new MlirUnsupported("`??` enum layout");
    const name = `dflt$v${this.n++}`;
    const arms = [
      { pattern: { kind: "EnumPattern" as const, variant: ok.name, tag: 0, bindings: [{ name, type: ok.fields[0] }] },
        body: [{ kind: "ExprStmt" as const, expr: { kind: "Ident" as const, name, type: e.type, isMove: true } }] },
      { pattern: { kind: "WildcardPattern" as const }, body: [{ kind: "ExprStmt" as const, expr: e.default }] },
    ];
    if (into) return this.match({ subject: e.operand, arms }, null, b => this.tailInto(b, into.dst, into.ty)).v;
    this.forks.push({ mode: null, sawView: false });
    try { return this.match({ subject: e.operand, arms }, this.value(e.type, "`??` result")).v; } finally { this.forks.pop(); }
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
    const lit = (p: HIRPattern & { kind: "LiteralPattern" }): HIRExpr => patLiteral(p.literalKind, p.value, subjTy);
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

  private stringHelpers(): void {
    // Runtime sections (src/runtime/str.ll), not legacy-generated helpers.
    this.cx.mlirStringOps();
  }

  /** `a == b`, `a < b`, `a + b` on two borrowed strings. */
  private stringBinop(e: HIRExpr & { kind: "BinOp" }): Val {
    const names: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "+": "concat" };
    const op = names[e.op];
    if (!op) throw new MlirUnsupported(`string ${e.op}`);
    const l = this.borrow(this.expr(e.left), e.left.type);
    const r = this.borrow(this.expr(e.right), e.right.type);
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
    // Runtime sections (src/runtime/str.ll): equality, and a three-way compare for order.
    this.stringHelpers();
    const eq = op === "eq" || op === "ne";
    const name = eq ? "milo.string.eq" : "milo.string.cmp";
    const fnTy = `(!milo.ref<${STR}>, !milo.ref<${STR}>) -> ${eq ? "i1" : "si32"}`;
    this.callees.set(name, fnTy);
    const c = this.def(`func.call @${quote(name)}(${a}, ${b}) : ${fnTy}`, eq ? "i1" : "si32");
    if (op === "eq") return c;
    if (op === "ne") return this.def(`milo.not ${c.ref} : i1`, "i1");
    const zero = this.def("milo.const 0 : si32", "si32");
    return this.def(`milo.cmp ${op}, ${c.ref}, ${zero.ref} : si32`, "i1");
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
    const lt = stripRefs(e.left.type);
    if ((e.op === "==" || e.op === "!=") && lt.tag === "enum") {
      // As legacy: the tags compared (the checker allows `==` only on payload-free enums).
      const l = this.expr(e.left), r = this.expr(e.right);
      if (l.ty !== r.ty || !l.ty.startsWith("!milo.enum<") || this.hasDrop(l.ty)) throw new MlirUnsupported("binop operand types");
      const a = this.def(`milo.enum.tag ${l.ref} : ${l.ty}`, "si32"), b = this.def(`milo.enum.tag ${r.ref} : ${r.ty}`, "si32");
      return this.def(`milo.cmp ${CMPS[e.op]}, ${a.ref}, ${b.ref} : si32`, "i1");
    }
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

  /**
   * A builtin whose operands are `e[field]` (and BitIntrinsic's `amount`) as legacy's own
   * codegen of it, in a helper: a scalar operand by value, any other lent by its place
   * (a temporary in a slot of the statement). The result
   * is a value of `e.type`, owned when it has drop glue (JsonStringify's string).
   */
  private builtinOf(e: HIRExpr, field: "object" | "value", panics: boolean): Val {
    const rec = e as unknown as Record<string, HIRExpr | undefined>;
    const names = [field, ...(e.kind === "BitIntrinsic" && rec.amount ? ["amount"] : [])];
    const ops = names.map((n, k) => {
      const x = rec[n]!;
      const t = stripRefs(x.type);
      const vt = valueType(this.cx, t);
      if (vt !== null && isScalarTy(vt)) {
        const v = this.expr(x);
        if (v.ty !== vt) throw new MlirUnsupported(`${e.kind} operand type`);
        return { name: `a${k}`, type: t, mode: "val" as const, ref: v.ref };
      }
      // A temporary goes to a slot that dies with the statement (legacy: right after the
      // read, which only a user Drop could tell apart).
      if (x.kind !== "Ident" && x.kind !== "FieldAccess" && x.kind !== "IndexAccess" && this.runsUserDrop(this.place$(t, `${e.kind} operand`))) throw new MlirUnsupported(`${e.kind} of a temporary with a user Drop`);
      return { name: `a${k}`, type: t, mode: "ref" as const, ref: this.place(x, this.lent(t, `${e.kind} operand`), false).ref };
    });
    const ty = this.value(e.type, `${e.kind} result`);
    const key = e.kind === "BitIntrinsic" ? `bit.${(e as { intrinsic: string }).intrinsic}`
      : e.kind === "EnumTryFrom" ? `tryfrom.${(e as { enumName: string }).enumName}` : e.kind.toLowerCase();
    const r = this.intrinsic(key, e, ops, xs => ({ ...e, ...Object.fromEntries(names.map((n, k) => [n, xs[k]])) } as HIRExpr), ty, panics);
    return { ...r, own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /**
   * `for x in it` over an iterator (legacy genForIterator), as the loop it means:
   * `while true { match next(&mut it) { Some(x) => body, None => break } }`. The binding
   * owns each element, as legacy's does. A temporary iterable is first bound to a `var`
   * of the enclosing block (a Block opens no scope), which drops it when that block
   * exits, as legacy drops its temp alloca.
   */
  private forIterator(s: HIRStmt & { kind: "ForIterator" }): boolean {
    const layout = this.cx.mlirEnumLayout(s.optionEnumName);
    const some = layout?.variants.find(v => v.name === "Some"), none = layout?.variants.find(v => v.name === "None");
    if (!some || !none || some.fields.length !== 1) throw new MlirUnsupported("iterator option layout");
    const k = s.iterable.kind;
    // Legacy takes an element's address once; the loop below would index again per next().
    if (k === "IndexAccess") throw new MlirUnsupported("for over an iterator element");
    const pre: HIRStmt[] = [];
    let it = s.iterable;
    if (k !== "Ident" && k !== "FieldAccess") {
      const name = `__iter.${this.fresh().slice(1)}`;
      pre.push({ kind: "Let", name, type: s.iterable.type, value: s.iterable, mutable: true, span: s.span });
      it = { kind: "Ident", name, type: s.iterable.type, isMove: false, span: s.span };
    }
    const optTy: TypeKind = { tag: "enum", name: s.optionEnumName };
    const next: HIRExpr = { kind: "Call", func: s.nextMethod, args: [{ expr: it, passByRef: true, refMut: true }], type: optTy, variadic: false, span: s.span };
    const loop: HIRStmt = {
      kind: "While", cond: { kind: "BoolLit", value: true, type: { tag: "bool" } }, span: s.span,
      body: [{
        kind: "Match", subject: next, enumName: s.optionEnumName, span: s.span, arms: [
          { pattern: { kind: "EnumPattern", variant: "Some", tag: some.tag, bindings: [{ name: s.varName, type: s.varType }] }, body: s.body },
          { pattern: { kind: "EnumPattern", variant: "None", tag: none.tag, bindings: [] }, body: [{ kind: "Break", span: s.span }] },
        ],
      }],
    };
    return this.stmt({ kind: "Block", body: [...pre, loop] as HIRStmtBase[], span: s.span });
  }

  /**
   * An immutable binding held as an SSA value, moved to a slot because its address is
   * taken: from here on it lives there, as legacy's alloca does, so a write through the
   * address is seen by later reads. The slot owns nothing: the binding never did.
   */
  private spill(name: string, v: Val): string {
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${v.ty}>`);
    this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${v.ty}>`);
    const m = [...this.scopes].reverse().find(s => s.has(name))!;
    m.set(name, { kind: "var", ref, ty: v.ty });
    return ref;
  }

  private unop(e: HIRExpr & { kind: "UnaryOp" }): Val {
    if (e.op === "&") {
      // `x.addrOf()`: the address of a place.
      if (e.operand.kind === "Ident") {
        const b = this.lookup(e.operand.name);
        if (b.kind === "vec") return this.def(`milo.addr ${b.ref} : !milo.vec<${b.elem}>`, PTR);
        if (b.kind === "var") return this.def(`milo.addr ${b.ref} : !milo.ref<${b.ty}>`, PTR);
        const ref = this.spill(e.operand.name, b.v);
        return this.def(`milo.addr ${ref} : !milo.ref<${b.v.ty}>`, PTR);
      }
      // A place behind a pointer (`data[i].addrOf()`) is its address already.
      const pp = this.ptrPlace(e.operand);
      if (pp) return { ref: pp.ptr, ty: PTR };
      // A field of an immutable binding held as an SSA value: the binding moves to a slot.
      let root: HIRExpr = e.operand;
      while (root.kind === "FieldAccess") root = root.object;
      if (root !== e.operand && root.kind === "Ident") {
        const rb = this.lookup(root.name);
        if (rb.kind === "ssa") this.spill(root.name, rb.v);
      }
      // `v[i].addrOf()` of a Vec of scalars: the element's place, bounds-checked (scalarElem).
      const p = this.fieldPlace(e.operand) ?? this.scalarElem(e.operand);
      if (!p) {
        let r: HIRExpr = e.operand, path = "";
        while (r.kind === "FieldAccess") { path += ".f"; r = r.object; }
        throw new MlirUnsupported(`address of a value (${r.kind === "Ident" ? this.lookup(r.name).kind : r.kind}${path})`);
      }
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
    const index = this.index(e.index);
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
      const k = e.object.kind;
      // A temporary array (`fixed()[2]`) is built in a slot of the statement, which drops
      // it at the statement's end, as legacy's temporary; its element is read from there.
      const p = this.fieldPlace(e.object) ?? (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" ? { ...this.bigSlot("index.of", e.object, true), param: undefined as number | undefined } : null);
      if (!p || p.ty !== at) throw new MlirUnsupported("index into an array that is not a place");
      const index = this.index(e.index);
      const ty = this.place$(ot.element, "array element");
      const ref = this.def(`milo.array.index ${p.ref}[${index}] : !milo.ref<${at}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`, this.loc(e.span)).ref;
      return { ref, ty, param: p.param };
    }
    const el = vecElem(this.cx, ot);
    if (el === null || isScalarTy(el)) return null;
    const { place, elem, param } = this.vecPlace(e.object);
    const index = this.index(e.index);
    const ref = this.def(`milo.index.ref ${place}[${index}] : !milo.vec<${elem}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`, this.loc(e.span)).ref;
    return { ref, ty: elem, param };
  }

  /** The header address of the Vec `e` names: a by-ref Vec param, or an owned Vec local. */
  private vecPlace(e: HIRExpr): { place: string; elem: string; param?: number } {
    const b = e.kind === "Ident" ? this.lookup(e.name) : null;
    if (b?.kind === "vec") return { place: b.ref, elem: b.elem, param: b.param };
    // A Vec local, a Vec field of a place, or a Vec element.
    const slot = b?.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : e.kind === "FieldAccess" || e.kind === "IndexAccess" ? this.fieldPlace(e) : null;
    if (!slot && !(b?.kind === "var")) {
      // A Vec that is a value (`s.split(";")[0]`, a slice let): materialized into a slot,
      // a temporary's owning it for the open frame (tempSlot), a view's dropping nothing.
      const v = b?.kind === "ssa" ? b.v : this.expr(e);
      const vm = /^!milo\.vecval<(.*)>$/.exec(v.ty);
      if (!vm) throw new MlirUnsupported("a Vec that is not a param, a local or a field");
      let ref: string;
      if (v.own === "owned" && !this.bitCopies.has(v.ref)) ref = this.tempSlot("vec", v.ty, e.type, v);
      else {
        ref = this.fresh();
        this.vars.push(`  ${ref} = milo.var "vec" : !milo.ref<${v.ty}>`);
      }
      this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${v.ty}>`);
      return { place: this.def(`milo.vec.place ${ref} : !milo.ref<${v.ty}> -> !milo.vec<${vm[1]}>`, `!milo.vec<${vm[1]}>`).ref, elem: vm[1] };
    }
    const m = slot ? /^!milo\.vecval<(.*)>$/.exec(slot.ty) : null;
    if (!slot || !m) throw new MlirUnsupported("a Vec that is not a param, a local or a field");
    const place = this.def(`milo.vec.place ${slot.ref} : !milo.ref<${slot.ty}> -> !milo.vec<${m[1]}>`, `!milo.vec<${m[1]}>`);
    return { place: place.ref, elem: m[1], param: slot.param };
  }

  /** An index operand as si64: a narrower int widens by its own signedness (legacy indexToI64). */
  private index(e: HIRExpr): string {
    const i = this.expr(e);
    if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
    return i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
  }

  /**
   * The one way a by-ref position (a call's `&T` / `&mut T` argument, a helper's place
   * operand) lends `e` as `refTy` (lentType), as legacy genLValueForArg does: a place (a
   * slot, a by-ref param, a field or an element of one) is lent where it is, a Vec as its
   * header; a value gets a slot, as legacy spills it: an owned temporary's owns it until the
   * call's frame closes (tempSlot), anything else's drops nothing (whatever owns the value
   * outlives the call). `&mut` of a value would hand the callee a copy to write.
   */
  private place(e: HIRExpr, refTy: string, mut: boolean): { ref: string; param?: number } {
    const pb = this.ptrBinding(e);
    if (pb) {
      // Lent to a call where it is, as legacy passes the pointer.
      if (refTy !== `!milo.ref<${pb.ty}>`) throw new MlirUnsupported("by-ref arg of another type");
      return { ref: this.def(`milo.ptr.lend ${pb.ptr} -> ${refTy}`, refTy).ref };
    }
    const b = e.kind === "Ident" ? this.lookup(e.name) : null;
    if (b?.kind === "vec") return this.lendAs(b.ref, `!milo.vec<${b.elem}>`, refTy, b.param);
    const p = b?.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param }
      : e.kind === "FieldAccess" || e.kind === "IndexAccess" ? this.fieldPlace(e) ?? this.scalarElem(e) : null;
    if (p) return this.lendAs(p.ref, `!milo.ref<${p.ty}>`, refTy, p.param);
    if (!b && (e.kind === "IndexAccess" || e.kind === "PtrDeref" || e.kind === "FieldAccess") && valueType(this.cx, e.type) === null && placeType(this.cx, e.type) !== null) {
      // A 128+ byte element behind a raw pointer (`f(data[i])` with a `&T` param, as std's
      // sortBy does): lent as a bit copy in a slot nothing drops. Building it with bigSlot
      // would drop the copy after the call and free what the pointer still owns.
      const pp = this.ptrPlace(e);
      if (pp) {
        if (mut) throw new MlirUnsupported("&mut of a 128+ byte element behind a pointer");
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var "arg" : !milo.ref<${pp.ty}>`);
        this.emit(`milo.copy ${pp.ptr}, ${slot} : ${PTR}, !milo.ref<${pp.ty}> of ${pp.ty}`);
        return this.lendAs(slot, `!milo.ref<${pp.ty}>`, refTy);
      }
    }
    if (this.isSretCall(e) || (!b && valueType(this.cx, e.type) === null && placeType(this.cx, e.type) !== null)) {
      // One that lives in memory is built in a slot of this frame, which drops it.
      const sl = this.bigSlot("arg", e, true);
      return this.lendAs(sl.ref, `!milo.ref<${sl.ty}>`, refTy);
    }
    if (!b && (e.kind === "IndexAccess" || e.kind === "PtrDeref" || e.kind === "FieldAccess") && (mut || refTy.startsWith("!milo.vec<"))) {
      // `(*p).items.push(v)`: a place behind a raw pointer, lent where it is (legacy passes
      // that address), as a ref or a Vec header only the call sees.
      const pp = this.ptrPlace(e);
      if (pp) {
        const vm = /^!milo\.vecval<(.*)>$/.exec(pp.ty);
        const lent = vm ? `!milo.vec<${vm[1]}>` : `!milo.ref<${pp.ty}>`;
        if (lent !== refTy) throw new MlirUnsupported("by-ref arg of another type");
        return { ref: this.def(`milo.ptr.lend ${pp.ptr} -> ${lent}`, lent).ref };
      }
    }
    // A raw slice, a Vec slice (`&mut v[a..b]`) or a `&mut T` coerced to `&mut I` is a
    // view header over memory it does not own: lent from a temporary, as legacy spills it,
    // writes through it still reach that memory.
    if (mut && e.kind !== "RawSlice" && e.kind !== "VecSlice" && e.kind !== "InterfaceCoerce") throw new MlirUnsupported(`&mut of a value (${e.kind})`);
    const v = b?.kind === "ssa" ? b.v : this.expr(e);
    if (!this.fits(`!milo.ref<${v.ty}>`, refTy)) throw new MlirUnsupported("by-ref arg of another type");
    let slot: string;
    if (v.own === "owned" && !this.bitCopies.has(v.ref) && this.hasDrop(v.ty)) slot = this.tempSlot("arg", v.ty, e.type, v);
    else {
      slot = this.fresh();
      this.vars.push(`  ${slot} = milo.var ${quote(b && e.kind === "Ident" ? e.name : v.own === "view" && v.ty.startsWith("!milo.vecval<") ? "slice" : "arg")} : !milo.ref<${v.ty}>`);
    }
    this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
    return this.lendAs(slot, `!milo.ref<${v.ty}>`, refTy);
  }

  /** A place of type `placeTy` can be lent as `refTy`: the same, or a Vec slot as its header. */
  private fits(placeTy: string, refTy: string): boolean {
    // A Vec of owning closures fits a Vec of plain ones (milo.vec.place): monomorphization
    // gives a generic body the plain T, and legacy passes the same header.
    const owningElems = /^!milo\.ref<!milo\.vecval<!milo\.fn<owning (.*)>>>$/.exec(placeTy);
    if (owningElems && refTy === `!milo.vec<!milo.fn<${owningElems[1]}>>`) return true;
    return placeTy === refTy || placeTy === `!milo.ref<!milo.vecval<${/^!milo\.vec<(.*)>$/.exec(refTy)?.[1]}>>`;
  }

  /** The place `ref` (of type `placeTy`) lent as `refTy` (fits). */
  private lendAs(ref: string, placeTy: string, refTy: string, param?: number): { ref: string; param?: number } {
    if (placeTy === refTy) return { ref, param };
    if (!this.fits(placeTy, refTy)) throw new MlirUnsupported("by-ref arg of another type");
    return { ref: this.def(`milo.vec.place ${ref} : ${placeTy} -> ${refTy}`, refTy).ref, param };
  }

  /**
   * `v[i]` of a Vec of scalars as its element's place (milo.index.ref, bounds-checked), for
   * a by-ref position only: a scalar element is read as a value (milo.index) everywhere else.
   */
  private scalarElem(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind !== "IndexAccess" || stripRefs(e.object.type).tag !== "vec") return null;
    const { place, elem, param } = this.vecPlace(e.object);
    const ref = this.def(`milo.index.ref ${place}[${this.index(e.index)}] : !milo.vec<${elem}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`, this.loc(e.span)).ref;
    return { ref, ty: elem, param };
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
    const strip = (t: TypeKind) => { while (t.tag === "ref") t = t.inner; return t; };
    // A part milo.print cannot carry (a fixed array, a HashMap): the whole print is one
    // call of legacy's print helper, which takes scalars by value and the rest by reference.
    if (!formatted && args.some(a => { const t = strip(a.expr.type); return t.tag === "array" || t.tag === "hashmap"; })) {
      const ops: string[] = [];
      const mark = this.pending.length;
      for (const a of args) {
        if (a.passByRef) throw new MlirUnsupported("by-ref print part");
        const t = strip(a.expr.type);
        if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr") {
          const v = this.pend(this.expr(a.expr), t);
          if (valueType(this.cx, t) !== v.ty) throw new MlirUnsupported(`print part of type ${t.tag}`);
          ops.push(`${v.ref} : ${v.ty}`);
        } else {
          const lt = this.lent(t, "print part");
          ops.push(`${this.place(a.expr, lt, false).ref} : ${lt}`);
        }
      }
      this.pending.length = mark;
      const name = this.cx.mlirPrintHelper(stderr, args.map(a => ({ key: typeKey(strip(a.expr.type)), type: strip(a.expr.type) })));
      this.callHelper(name, ops, null);
      return { ref: "", ty: "" };
    }
    args.forEach((a, i) => {
      if (a.passByRef) throw new MlirUnsupported("by-ref print part");
      let t = a.expr.type;
      while (t.tag === "ref") t = t.inner;
      const v = this.borrow(this.expr(a.expr), t);
      // Scalar.cpp printKey spells the same names. A slice is its Vec header (a view), and
      // prints as a Vec does.
      const slice = t.tag === "array" && t.size === null ? vecElem(this.cx, { tag: "vec", element: t.element } as TypeKind) : null;
      const want = slice !== null ? `!milo.vecval<${slice}>` : valueType(this.cx, t);
      if (want !== v.ty) throw new MlirUnsupported(`print part of type ${t.tag}`);
      parts.push({ v, key: typeKey(t), type: t });
      if (!formatted && t.tag === "string" && i < args.length - 1) flush(true);
    });
    flush(false);
    return { ref: "", ty: "" };
  }

  /**
   * `todo()` / `todo(msg)`: legacy's message and abort in a helper per site. The message
   * names the enclosing function by what follows its name's last `$` (legacy's
   * currentFnName), so the helper's name ends in `$` and that same name. A message
   * string goes by reference. The call never returns.
   */
  private todo(e: HIRExpr & { kind: "Call" }): Val {
    const l = this.site(e.span);
    const who = this.fn.name.slice(this.fn.name.lastIndexOf("$") + 1);
    const msg = e.args[0]?.expr;
    if (e.args.length > 1 || (msg && stripRefs(msg.type).tag !== "string")) throw new MlirUnsupported("todo arguments");
    const name = this.cx.mlirHelper(`milo.todo.${l.line}.${l.col}.${fnv1a(l.file)}$${who}`, () => ({
      params: msg ? [{ name: "m", type: { tag: "string" }, isRef: true, isRefMut: false }] : [],
      retType: { tag: "void" }, trackedCaller: this.fn.trackedCaller,
      body: [{ kind: "ExprStmt", expr: { ...e, args: msg ? [{ expr: { kind: "Ident", name: "m", type: { tag: "string" }, isMove: false }, passByRef: false, refMut: false }] : [] } }],
    }));
    const args = msg ? [`${this.place(msg, `!milo.ref<${STR}>`, false).ref} : !milo.ref<${STR}>`] : [];
    this.callHelper(name, args, null);
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
  private ffiCall(e: HIRExpr & { kind: "Call" }, _stmt: boolean): Val {
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: string[] = [];
    const keys: string[] = [];
    const mark = this.pending.length;
    e.args.forEach((a, k) => {
      const t = a.expr.type;
      const name = `a${k}`;
      if (a.passByRef) {
        // C gets the place's address, as legacy passes it; the helper's param is that place.
        const st = stripRefs(t);
        // A fixed array goes as its address, as legacy passes it; a slice or Vec is a header.
        if (st.tag === "string" || st.tag === "vec" || (st.tag === "array" && st.size === null)) throw new MlirUnsupported(`by-ref ${st.tag} argument of an extern call`);
        const ty = this.lent(st, "extern by-ref operand");
        const r = this.place(a.expr, ty, a.refMut).ref;
        params.push({ name, type: st, isRef: !a.refMut, isRefMut: !!a.refMut });
        args.push(`${r} : ${ty}`);
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
          ref = this.tempSlot("cstr", STR, t, v);
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
      const { v, type } = this.helperOperand(a.expr, "extern argument");
      params.push({ name, type, isRef: false, isRefMut: false });
      args.push(`${v.ref} : ${v.ty}`);
      keys.push(typeKey(type));
    });
    this.pending.length = mark;
    const ret = e.type.tag === "void" ? null : this.value(e.type, "extern call result");
    // A plain struct result comes back from the helper as an LLVM struct value; a 128+
    // byte one would make the helper sret, and one that owns would need a drop here.
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && (e.type.tag !== "struct" || this.hasDrop(ret) || this.cx.typeSizeOf(e.type) >= 128))
      throw new MlirUnsupported("extern call result type");
    const l = this.site(e.span);
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
  private builtinCall(e: HIRExpr & { kind: "Call" }, _stmt: boolean, lendStrings = false): Val {
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: string[] = [];
    const keys: string[] = [];
    const mark = this.pending.length;
    e.args.forEach((a, k) => {
      const t = stripRefs(a.expr.type);
      const name = `a${k}`;
      // format only reads its parts: a non-scalar one is lent from its place, as print lends it.
      if (a.passByRef || (lendStrings && !(t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr"))) {
        const ty = this.lent(t, "builtin operand");
        const r = this.place(a.expr, ty, a.refMut).ref;
        params.push({ name, type: t, isRef: !a.refMut, isRefMut: !!a.refMut });
        args.push(`${r} : ${ty}`);
        keys.push(`r${typeKey(t)}`);
        return;
      }
      const { v, type } = this.helperOperand(a.expr, "builtin operand");
      params.push({ name, type, isRef: false, isRefMut: false });
      args.push(`${v.ref} : ${v.ty}`);
      keys.push(typeKey(type));
    });
    this.pending.length = mark;
    const ret = e.type.tag === "void" || e.type.tag === "never" ? null : this.value(e.type, "builtin result");
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && ret !== STR) throw new MlirUnsupported("builtin result type");
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
  /**
   * `o!` with a 128+ byte payload, written into `dst`: legacy's genUnwrap (its panic text
   * and location) in a helper per site that init-assigns `d = (*o)!`. The
   * enum goes in as a raw pointer and the helper unwraps `*o`: legacy genUnwrap zeroes the
   * operand when it is an Ident, through localAddr, which for a by-ref param is the 8-byte
   * slot holding its address (a 168-byte store there smashed the -O0 frame). The payload
   * is bit-copied out and the caller marks its slot moved.
   */
  private unwrapInto(e: HIRExpr & { kind: "Unwrap" }, dst: string, ty: string): void {
    const o = e.operand, st = stripRefs(o.type);
    let src: { ref: string; ty: string };
    // An enum that owns nothing is bit-copied: read from wherever it is, nothing emptied.
    const plain = !this.hasDrop(this.place$(st, "unwrapped enum"));
    if (plain) {
      const p = o.kind === "Ident" || o.kind === "FieldAccess" ? this.fieldPlace(o) : null;
      src = p ?? this.bigSlot("unwrap.of", o, true);
    } else if (o.kind === "Ident") {
      const b = this.lookup(o.name);
      if (b.kind !== "var" || !b.owned || !o.isMove) throw new MlirUnsupported("unwrap of a 128+ byte payload out of a borrow");
      src = { ref: b.ref, ty: b.ty };
    } else if (o.kind === "FieldAccess" || o.kind === "IndexAccess" || o.kind === "HeapDeref" || o.kind === "PtrDeref") {
      throw new MlirUnsupported("unwrap of a 128+ byte payload out of a place");
    } else {
      src = this.bigSlot("unwrap.of", o, true);
    }
    if (src.ty !== this.place$(st, "unwrapped enum")) throw new MlirUnsupported("unwrap operand type");
    const l = this.site(e.span);
    const name = `milo.intr.unwrapinto.${typeKey(st)}.${l.line}.${l.col}.${fnv1a(l.file)}`;
    const t = stripRefs(e.type);
    this.cx.mlirHelper(name, () => ({
      params: [{ name: "d", type: t, isRef: false, isRefMut: true }, { name: "o", type: { tag: "ptr", inner: st }, isRef: false, isRefMut: false }],
      retType: { tag: "void" }, trackedCaller: this.fn.trackedCaller,
      body: [{ kind: "Assign", target: { kind: "Ident", name: "d", type: t, isMove: false }, isInit: true,
        value: { ...e, operand: { kind: "PtrDeref", type: st, operand: { kind: "Ident", name: "o", type: { tag: "ptr", inner: st }, isMove: false } } } }],
    }));
    const fnTy = `(!milo.ref<${ty}>, ${PTR}) -> ()`;
    this.callees.set(name, fnTy);
    const at = this.def(`milo.addr ${src.ref} : !milo.ref<${src.ty}>`, PTR);
    this.emit(`func.call @${quote(name)}(${dst}, ${at.ref}) : ${fnTy}`);
    if (!plain) this.def(`milo.move ${src.ref} : !milo.ref<${src.ty}>`, src.ty);
  }

  /** What a refused field move reads from, for the legacy reason: the root and its binding. */
  private moveRoot(e: HIRExpr): string {
    let r = e;
    while (r.kind === "FieldAccess") r = r.object;
    if (r.kind !== "Ident") return r.kind;
    const name = r.name;
    const b = this.scopes.some(m => m.has(name)) ? this.lookup(name) : null;
    return b ? (b.kind === "var" ? (b.owned ? "owned var" : b.param !== undefined ? "by-ref param" : "var") : b.kind) : "unbound";
  }

  private moveField(e: HIRExpr & { kind: "FieldAccess" }): Val {
    let p: { ref: string; ty: string };
    const o = e.object, k = o.kind;
    if (this.fieldOfOwnedLocal(e)) {
      p = this.fieldPlace(e)!;
      if (this.runsUserDrop(p.ty)) {
        this.partialMove(e);
        return { ...this.def(`milo.move ${p.ref} : !milo.ref<${p.ty}>`, p.ty), own: "owned" };
      }
    } else if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && k !== "HeapDeref" && k !== "PtrDeref"
      && o.type.tag === "struct" && !this.cx.dropImpls.has(o.type.name)) {
      // Out of a temporary (`make().name`): it goes to a slot that dies with the
      // statement, so the fields left behind are dropped there (legacy
      // dropStructFieldsExcept), the moved one zeroed first.
      const sl = this.bigSlot("tmp", o, true);
      const { index, ty } = this.field(e);
      p = { ref: this.def(`milo.field_ref ${sl.ref}[${index}] : !milo.ref<${sl.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref, ty };
      if (this.runsUserDrop(sl.ty)) {
        // A user Drop in the leftovers is observable, so they die here, first field
        // first, as legacy's dropStructFieldsExcept runs them, and the slot is emptied.
        const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
        fieldTypes(this.cx, o.type).forEach((ft, j) => {
          if (j === index || !ownsStructurally(this.cx, ft, [])) return;
          const fty = this.place$(ft, "field");
          this.dropGlue(fty, ft);
          const fr = this.def(`milo.field_ref ${sl.ref}[${j}] : !milo.ref<${sl.ty}> -> !milo.ref<${fty}>`, `!milo.ref<${fty}>`);
          this.emit(`milo.drop ${fr.ref} : !milo.ref<${fty}>`);
        });
        this.def(`milo.move ${sl.ref} : !milo.ref<${sl.ty}>`, sl.ty);
        return { ...v, own: "owned" };
      }
    } else {
      // Out of a field of a temporary (`mk().req.path`): the temporary goes to a slot of the
      // statement, the moved field is reached through the path and zeroed, and the slot's
      // drop at the statement's end frees the rest. Only where no struct on the path runs a
      // user Drop: one would observe the zeroed field and the order. [MILO-O-fieldMove]
      const path: (HIRExpr & { kind: "FieldAccess" })[] = [e];
      let root: HIRExpr = o;
      while (root.kind === "FieldAccess") { path.unshift(root); root = root.object; }
      const rk = root.kind;
      const temp = rk !== "Ident" && rk !== "IndexAccess" && rk !== "HeapDeref" && rk !== "PtrDeref";
      if (!temp || path.length < 2 || path.some(x => x.object.type.tag !== "struct" || this.runsUserDrop(this.place$(x.object.type, "struct"))))
        throw new MlirUnsupported(`move out of a field (${this.moveRoot(e)})`);
      const sl = this.bigSlot("tmp", root, true);
      let at = { ref: sl.ref, ty: sl.ty };
      for (const step of path) {
        const { index, ty } = this.field(step);
        at = { ref: this.def(`milo.field_ref ${at.ref}[${index}] : !milo.ref<${at.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref, ty };
      }
      p = at;
    }
    const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
    this.emit(`milo.store ${this.def(`milo.zero : ${p.ty}`, p.ty).ref}, ${p.ref} init : !milo.ref<${p.ty}>`);
    return { ...v, own: "owned" };
  }

  /**
   * A field that runs a user Drop, moved out of a local (legacy's field-move flags): a [MILO-O-fieldMove]
   * zeroed one is not empty, so it is emptied by milo.move instead, and
   * milo-elaborate-drops drops the local field by field without it. Those drops call the
   * glue of every field of each struct on the way down.
   */
  private partialMove(e: HIRExpr & { kind: "FieldAccess" }): void {
    for (let o: HIRExpr = e.object; ; o = (o as HIRExpr & { kind: "FieldAccess" }).object) {
      if (o.type.tag === "struct")
        for (const f of fieldTypes(this.cx, o.type)) if (ownsStructurally(this.cx, f, [])) this.dropGlue("", f);
      if (o.kind !== "FieldAccess") break;
    }
    this.dropGlue("", e.type);
  }

  /**
   * `e` is a field (of a field...) of a struct local this function owns, every step a
   * struct by value. None of them implements Drop (the checker refuses a move out of
   * one), so dropping the local with a moved field zeroed drops the rest.
   */
  private fieldOfOwnedLocal(e: HIRExpr): boolean {
    if (e.kind === "Ident") {
      const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
      return b?.kind === "var" && !!b.owned;
    }
    return e.kind === "FieldAccess" && e.object.type.tag === "struct" && this.fieldOfOwnedLocal(e.object);
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
      if (e.func === "todo") return this.todo(e);
      throw new MlirUnsupported(`builtin ${e.func}`);
    }
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    // A string given to a `*u8` param is legacy's C string conversion for any callee, not only an extern.
    if (callee && sig && ((callee.isExtern && e.variadic) || e.args.some((a, i) => !a.passByRef && !callee.params[i]?.isRef && !callee.params[i]?.isRefMut && stripRefs(a.expr.type).tag === "string" && sig.paramTypes[i] === "ptr")))
      return this.ffiCall(e, stmt);
    if (e.variadic) throw new MlirUnsupported("variadic call");
    if (!callee || !sig || sig.variadic) throw new MlirUnsupported("callee");
    const sret = this.cx.sretFns.has(e.func);
    if (sret !== (into !== undefined)) throw new MlirUnsupported("sret call as a value");
    // A per-module extern (`linkName`) is called by its HIR name, as legacy calls it: the
    // backend maps both modules' symbols to the C one (mlir-backend compile).
    if (callee.params.length !== e.args.length) throw new MlirUnsupported("callee arity");
    // A struct passed to or returned from C by value goes through the platform ABI's
    // register coercion (src/abi.ts), which only legacy's genCall applies: an MLIR call
    // would pass the LLVM struct as-is and C would read the wrong registers. So the call
    // is legacy's, in a helper (ffiCall) that Milo code calls with plain LLVM structs.
    if (callee.isExtern && [callee.retType, ...callee.params.filter(p => !p.isRef && !p.isRefMut).map(p => p.type)].some(t => t.tag === "struct" || t.tag === "array"))
      return this.ffiCall(e, stmt);
    // A `&string` value (a slice `s[a..b]`) given to a `&string` param: the view goes in
    // a slot nobody drops, and the param gets that place.
    const viewArg = (i: number) => !e.args[i].passByRef && callee.params[i].isRef && e.args[i].expr.type.tag === "ref" && stripRefs(e.args[i].expr.type).tag === "string";
    const paramTys = callee.params.map((p, i) => {
      const byRef = p.isRef || p.isRefMut;
      if (byRef !== e.args[i].passByRef && !viewArg(i)) throw new MlirUnsupported("by-ref arg mismatch");
      // An extern's fn-typed param is a C function pointer (legacy declares it `ptr`).
      if (callee.isExtern && !byRef && p.type.tag === "fn" && sig.paramTypes[i] === "ptr") return PTR;
      const ty = byRef ? this.lent(p.type, "by-ref arg") : this.place$(p.type, "call arg");
      if (sig.paramTypes[i] !== (byRef ? "ptr" : this.cx.llvmType(p.type))) throw new MlirUnsupported("callee signature");
      return ty;
    });
    const view = viewResult(this.cx, callee.retType);
    const ret = callee.retType.tag === "void" || sret ? null : view ?? (abi ? this.place$(callee.retType, "call result") : this.value(callee.retType, "call result"));
    if (sret) paramTys.unshift(`!milo.ref<${this.place$(callee.retType, "sret result")}>`);
    else if (ret !== null ? sig.retType !== this.cx.llvmType(callee.retType) : sig.retType !== "void") throw new MlirUnsupported("callee signature");
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const provenance: (number | null)[] = [];
    const k0 = sret ? 1 : 0;
    const mark = this.pending.length;
    const args = e.args.map((a, j) => {
      const i = j + k0;
      if (viewArg(j)) {
        const v = this.expr(a.expr);
        if (v.ty !== STR || v.own !== "view") throw new MlirUnsupported("by-ref arg of a string that is not a view");
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var "view.arg" : !milo.ref<${STR}>`);
        this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${STR}>`);
        refs.push({ ref: slot, mut: false, ty: paramTys[i] });
        provenance.push(null);
        return slot;
      }
      if (a.passByRef) {
        const ref = this.place(a.expr, paramTys[i], a.refMut);
        refs.push({ ref: ref.ref, mut: a.refMut, ty: paramTys[i] });
        provenance.push(ref.param ?? null);
        return ref.ref;
      }
      if (paramTys[i] === PTR && a.expr.type.tag === "array") { provenance.push(null); return this.decay(a.expr).ref; }
      if (paramTys[i] === PTR && a.expr.type.tag === "fn") {
        // A named function to C: its own symbol, as legacy passes it.
        const x = a.expr;
        if (x.kind !== "Ident" || !this.fns.has(x.name) || this.scopes.some(m => m.has(x.name))) throw new MlirUnsupported("fn value to a C function pointer param");
        provenance.push(null);
        return this.fieldValue(x, { tag: "cfn" } as TypeKind).ref;
      }
      const pt = paramTys[i];
      if (pt.startsWith("!milo.fn<") && !pt.startsWith("!milo.fn<owning ")) {
        const own = this.expr(a.expr);
        if (own.own === "owned" && own.ty === pt.replace(/^!milo\.fn</, "!milo.fn<owning ")) {
          provenance.push(null);
          // A `move` closure given to a plain fn param (legacy genCall, spec "who frees the [MILO-O-lentClosure]
          // heap environment"): the param never owns it, so the caller frees it right after
          // the call (a slot of the call's frame) and passes a plain alias; when the callee
          // may keep the param (closureParamEscapes, failing closed) nobody frees it.
          if (this.cx.mlirClosureParamEscapes(e.func, j)) return this.take(own, pt, "argument", true).ref;
          const slot = this.tempSlot("clarg", own.ty, stripRefs(a.expr.type).tag === "fn" ? { ...(stripRefs(a.expr.type) as TypeKind & { tag: "fn" }), owning: true } : a.expr.type, own);
          this.emit(`milo.store ${own.ref}, ${slot} : !milo.ref<${own.ty}>`);
          const view = this.def(`milo.load ${slot} : !milo.ref<${own.ty}>`, own.ty).ref;
          return this.def(`milo.fn.cast ${view} : ${own.ty} -> ${pt}`, pt).ref;
        }
        const v = this.pend(this.take(own, pt, "argument"), a.expr.type);
        provenance.push(null);
        return v.ref;
      }
      const v = this.pend(this.operand(a.expr, paramTys[i], "argument", true), a.expr.type);
      provenance.push(null);
      return v.ref;
    });
    this.pending.length = mark;
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
    return { ...this.def(call, ret), own: view ? "view" : this.hasDrop(ret) ? "owned" : undefined };
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
    if (em.probed.length) return [...new Set(em.probed)].join("\n");
    return { name: fn.name === "main" && !cx.mlirMainOk ? MAIN_BODY : fn.name, text: [text, ...em.closures.texts].join("\n"), callees: em.callees, calls: em.calls, closures: em.closures.names };
  } catch (err) {
    if (err instanceof MlirUnsupported) return [...new Set([...em.probed, err.reason])].filter(r => !r.includes(PROBE_SKIPPED)).join("\n") || err.reason;
    if (PROBE) return [...em.probed, `probe: internal error ${(err as Error).message.slice(0, 60)}`].join("\n");
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
