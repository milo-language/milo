// The checked AST -> the source-level `milo` MLIR dialect (mlir/Milo.td), as text, for the
// functions the MLIR path compiles through milo-opt (docs/mlir-backend.md). It reads each
// function's AST through its forms (src/emit-forms.ts: the op family of each expression, read
// off the checker's facts) and prints the source-faithful top layer: a for-in is milo.for_in,
// `e?` milo.try, an interpolated string milo.interp, each lowered by milo-desugar. A printer,
// not a lowering: structured control flow stays region ops, `var` stays a slot, Milo's checked
// arithmetic stays one op carrying its trap; every rewrite after this is a milo-opt pass.
//
// `emitMlirFunction` throws `MlirUnsupported` for anything outside the subset the dialect
// covers, so the build fails with the reason.

import { globalInit, type ConstVal } from "./const-fold";
import type { FnDecl, GlobalDecl, BackendProgram } from "./backend-program";
import { type Arg, type Facts, type Form, type FormCtx, type FormOf, type Node, type Pat, type PatStep, type PatTest, walkAst } from "./emit-forms";
import { entryGuards, lazyMentions } from "./lazy-globals";
import { type Contract, type Expr, type Pattern, type Stmt, isNestedPattern } from "./ast";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import { MlirGlue } from "./mlir-glue";
import { PUSH_SCALAR_FN } from "./runtime-ir";
import { MAIN_BODY_FN as MAIN_BODY, PROCESS_INIT_FN } from "./startup";

// Which contract clauses assert at runtime: none, requires/ensures only ("boundary"), or
// those plus loop invariants ("all").
export type ContractChecks = "none" | "boundary" | "all";

export interface MlirEmitCtx {
  trapOnOverflow: boolean;
  /** The checker's facts and the emitter's own nodes (src/emit-forms.ts). */
  readonly facts: Facts;
  /** A @trackCaller copy's callees: each direct call's callee in function `name`. */
  calleesOf(name: string): ReadonlyMap<Expr, string> | undefined;
  /** Globals filled on first read: a statement that mentions one initializes it first. */
  readonly lazyGlobals: ReadonlySet<string>;
  // -g: every op carries its source loc (the line table); off, the text has none of them.
  readonly emitDebug: boolean;
  // std/replay is in the program, so replay-engine fns count their depth (milo.replay.enter).
  replayScope: boolean;
  // The default is "boundary" at every -O and "all" at -O0 (contractLevel in main.ts).
  contractChecks: ContractChecks;
  checkLocation(span?: Span): { file: string; line: number; col: number } | null;
  isBuiltinName(name: string): boolean;
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  sretFns: Set<string>;
  llvmType(t: TypeKind): string;
  // main is the process entry itself, not a body a green-task wrapper runs (src/startup.ts).
  readonly mlirMainOk: boolean;
  // A function's `attributes {...}` (linkage, pass-through LLVM attributes), and the
  // attribute dictionary of its param i (nonnull, dereferenceable, noalias; src/noalias.ts).
  fnAttrs(fn: FnDecl, name: string): string;
  paramAttrs(fn: string, i: number): string;
  // -g: `loc` (a function's own, or closure body `name`'s) fused with its DISubprogram (src/mlir-debug.ts).
  debugFnLoc(fn: FnDecl, loc: string): string;
  debugClosureLoc(name: string, span: Span | undefined, loc: string): string;
  mlirStrViewStep(): string;
  mlirIfaceMethodCount(name: string): number | null;
  mlirOutWrite(stderr: boolean): string;
  mlirPanicText(): string;
  mlirDisplayName(name: string): string;
  mlirFieldOffset(struct: string, field: string): number;
  mlirAtomic(builtin: string): string | null;
  mlirCAbiShim(name: string, variadic: boolean): string | null;
  mlirVecGrow(elemSize: number): string;
  mlirItable(from: string, iface: string): string;
  mlirItableDrop(concrete: string): string | null;
  mlirProcessGlobal(which: "argc" | "argv" | "scheduler" | "panicHook"): string;
  mlirBlockValueOwnsResult(expr: FormOf<"IfExpr" | "MatchExpr">): boolean;
  mlirClosureParamEscapes(fnName: string, idx: number): boolean;
  hasStringType: boolean;
  hasVecType: boolean;
  structLayouts: Map<string, { fields: { name: string; typeKind: TypeKind }[] }>;
  mlirEnumLayout(name: string): { size: number; align: number; niche?: { intTy: string; value: string }; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null;
  needsDropCg(t: TypeKind): boolean;
  dropImpls: Set<string>;
  typeSizeOf(t: TypeKind): number;
  // A HashMap slot { i8 state, K, V } (hashMapEntryType).
  mapSlotLayout(k: TypeKind, v: TypeKind): { size: number; keyOffset: number; valueOffset: number };
  mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null;
  // libc calls that keep a pointer argument past the call (src/noalias.ts RETAINING_LIBC).
  readonly retainingLibc: ReadonlySet<string>;
}

const CALLBACK_OPS = new Set(["map", "optionAndThen", "optionOrElse", "resultMap", "resultMapErr", "unwrapOrElse", "resultAndThen", "resultOrElse", "resultUnwrapOrElse", "resultContext"]);

export class MlirUnsupported extends Error {
  constructor(readonly reason: string) { super(`mlir: unsupported ${reason}`); }
}

// `*T` for any T: untyped, as the pointee type rides on each access.
const PTR = "!milo.ptr";
// Only ever a literal until drops exist (Milo.td StringType).
const STR = "!milo.string";

/** A function's own loc: the line its DISubprogram (src/mlir-debug.ts) names. */
function fnDebugLoc(cx: MlirEmitCtx, fn: FnDecl): string {
  return debugLocOf(cx, { file: fn.sourceFile, line: fn.line ?? 0, col: 1 }) ?? "loc(unknown)";
}

/** `loc(...)` of `span` for the line table: the code's own place, not a @trackCaller site. */
function debugLocOf(cx: MlirEmitCtx, span: Span): string | null {
  const l = cx.checkLocation(span);
  return l ? `loc(${quote(l.file)}:${l.line}:${l.col})` : null;
}

/** An op line without a loc: not a block label, a brace, or a line that already has one. */
function needsLoc(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("^") && !t.startsWith("}") && !t.endsWith("{") && !/ loc\(.*\)$/.test(t);
}

/**
 * -g: every op line of `text` still without a loc gets `loc`, and so does each region's
 * closing brace (the lines nothing emitted through FnEmitter.emit: slots, env drops,
 * the function's own `}`).
 */
function fillDebugLocs(text: string, loc: string): string {
  return text.split("\n").map(l => needsLoc(l) || l.trim() === "}" ? `${l} ${loc}` : l).join("\n");
}

/** The dialect's type for a Milo scalar (ints carry signedness), or null. */
function mlirType(t: TypeKind): string | null {
  // A ranged int is stored as its width; every flow into the range is an
  // explicit RangeCheck, and no !range metadata is attached.
  if (t.tag === "int") return `${t.signed ? "si" : "ui"}${t.bits}`;
  if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
  if (t.tag === "bool") return "i1";
  // A C fn pointer (`extern (..) => R`) is a plain pointer.
  if (t.tag === "ptr" || t.tag === "cfn") return PTR;
  return null;
}

/**
 * The dialect's element type of a Vec, or of a slice `[T]` (a Vec header that a slice
 * expression makes or a Vec lends), or null.
 */
function vecElem(cx: MlirEmitCtx, t: TypeKind): string | null {
  if (t.tag !== "vec" && !(t.tag === "array" && t.size === null)) return null;
  const e = placeType(cx, t.element);
  return e;
}

/** The place type of a `ty`: a Vec's is its header (!milo.vec), anything else's a !milo.ref. */
const refOf = (ty: string) => { const m = /^!milo\.vecval<(.*)>$/.exec(ty); return m ? `!milo.vec<${m[1]}>` : `!milo.ref<${ty}>`; };
const isScalarTy = (ty: string) => /^([su]i\d+|i1|f32|f64)$/.test(ty);
/** The dialect types milo-opt can give a DWARF type (diTypes in mlir/Passes.cpp); it drops the op for a nested type it cannot. */
const hasDebugType = (ty: string) => isScalarTy(ty) || /^!milo\.(struct|enum|string|map|vecval)\b/.test(ty);

/** How a glue or runtime symbol spells a type: Milo.h typeKey of its dialect type. */
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
// Every struct and enum is spelled by name alone (`!milo.struct<"N">`); its body is one
// definition per type (typeAliasText), so the text is linear in the number of types. Spelled
// whole at each use, mutually recursive types grew exponentially (30 MB for six enums).
const typeDefs = new WeakMap<MlirEmitCtx, Map<string, string>>();
const spelledOrder = new WeakMap<MlirEmitCtx, string[]>();

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
 *   place): an isBigAgg value is kept behind its address;
 * - F_MEMORY: it may not be an SSA operand between positions (128+ bytes, or holding a
 *   fixed array: SROA splits a whole-aggregate load into one op per element, so a struct
 *   holding a big array takes -O2 forever). It is built in its place (`into`), copied
 *   place to place (milo.copy), and is an SSA value only at an ABI boundary, loaded whole
 *   there: a by-value param or result, per the ABI.
 * A 128..512 byte enum is F_SLOT but not F_MEMORY: the ABI passes and returns one by value
 * (only structs get sret); a larger one is a place, the size at which SROA's split starts
 * to cost. A type no checker type spelled is a value.
 */
const BIG_ENUM_VALUE_LIMIT = 512;

/**
 * Records checker type `t`'s decisions on the id of its spelling `ty`: what it owns, from
 * the checker's type and never from the text (a type met again inside itself is spelled by
 * name alone, which hides its fields), and how it travels. milo-opt decides what to drop
 * from the dialect type (Milo.cpp needsDrop), so F_DROP must agree with the glue it calls.
 * Two checker types that share a spelling but not an answer mark it F_SHARED.
 */
function recordType(cx: MlirEmitCtx, ty: string, t: TypeKind): void {
  const tt = typeTable(cx);
  let id = tt.ids.get(ty);
  if (id === undefined) { id = tt.flags.length; tt.ids.set(ty, id); tt.flags.push(0); }
  let f = tt.flags[id];
  if ((f & F_SPELLED) && tt.from[id] === t) return;
  const own = (ownsStructurally(cx, t, []) ? F_DROP : 0) | (runsUserDropT(cx, t, new Set()) ? F_USER_DROP : 0);
  if (!(f & F_SPELLED)) { f |= F_SPELLED | own; tt.from[id] = t; }
  else if ((f & (F_DROP | F_USER_DROP)) !== own) f |= F_SHARED;
  if (!(f & F_SIZED)) {
    const big = t.tag === "array" || ((t.tag === "struct" || t.tag === "enum") && (cx.typeSizeOf(t) >= 128 || holdsArray(cx, t, new Set())));
    const memory = big && !(t.tag === "enum" && cx.typeSizeOf(t) < BIG_ENUM_VALUE_LIMIT);
    f |= F_SIZED | (big ? F_SLOT : 0) | (memory ? F_MEMORY : 0);
  }
  tt.flags[id] = f;
}

/** `t` holds a fixed-size array anywhere in its type (through boxes, Vecs, fields). */
function holdsArray(cx: MlirEmitCtx, t: TypeKind, seen: Set<string>): boolean {
  switch (t.tag) {
    case "array": return t.size !== null || holdsArray(cx, t.element, seen);
    case "heap": case "ref": return holdsArray(cx, t.inner, seen);
    case "vec": return holdsArray(cx, t.element, seen);
    case "hashmap": return holdsArray(cx, t.key, seen) || holdsArray(cx, t.value, seen);
    case "fn": return t.params.some(p => holdsArray(cx, p, seen)) || holdsArray(cx, t.ret, seen);
    case "struct": case "enum":
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return fieldTypes(cx, t).some(f => holdsArray(cx, f, seen));
    default: return false;
  }
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
function runsUserDropT(cx: MlirEmitCtx, t: TypeKind, seen: Set<string>): boolean {
  switch (t.tag) {
    case "vec": case "array": return runsUserDropT(cx, t.element, seen);
    case "heap": return runsUserDropT(cx, t.inner, seen);
    case "hashmap": return runsUserDropT(cx, t.key, seen) || runsUserDropT(cx, t.value, seen);
    case "struct": case "enum":
      if (cx.dropImpls.has(t.name)) return true;
      // One visit per type: an existence query, and a path-wise walk is exponential in a cycle.
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return fieldTypes(cx, t).some(f => runsUserDropT(cx, f, seen));
    // The concrete type behind an interface is erased.
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
 * by field through field_ref.
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
  // An interface is reached only behind a `&I`: a fat { data, itable } pair, which
  // borrows both (!milo.dynref), never read as the owning `Heap<I>` (!milo.dyn).
  if (t.tag === "interface") return dynRef(t.name);
  if (t.tag === "heap") {
    // A Heap of an interface is a fat { data, itable } pair, opaque here.
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
  // Cached before its fields are spelled: a type met inside its own fields is the same name.
  const key = `!milo.${t.tag}<${quote(t.name)}>`;
  if (cache.has(key)) return cache.get(key)!;
  let order = spelledOrder.get(cx);
  if (!order) spelledOrder.set(cx, order = []);
  let defs = typeDefs.get(cx);
  if (!defs) typeDefs.set(cx, defs = new Map());
  const mark = order.length;
  cache.set(key, key);
  order.push(key);
  const body = aggregateType(cx, t);
  if (body === null) {
    // Types spelled meanwhile named this one as spellable; forget them, they are re-spelled
    // (and fail) on demand.
    for (const k of order.splice(mark)) { cache.delete(k); defs.delete(k); }
    cache.set(key, null);
    return null;
  }
  defs.set(key, body);
  return key;
}

/**
 * The definitions of every struct and enum spelled so far, as MLIR type aliases for the
 * head of the module. A bare `!milo.enum<"N">` resolves to the defined type of that name,
 * but a bare struct met before its body is the empty struct, so a struct not yet defined is
 * spelled whole where first mentioned, once (a mutually recursive group).
 */
export function typeAliasText(cx: MlirEmitCtx): string {
  const defs = typeDefs.get(cx);
  if (!defs) return "";
  const done = new Set<string>(), open = new Set<string>();
  const structRef = /!milo\.struct<"(?:[^"\\]|\\.)*">/g;
  const whole = (token: string, body: string): string => {
    open.add(token);
    const text = body.replace(structRef, (m: string) => {
      const inner = defs.get(m);
      if (inner === undefined || inner === m || done.has(m) || open.has(m)) return m;
      return whole(m, inner);
    });
    open.delete(token);
    done.add(token);
    return text;
  };
  const lines: string[] = [];
  for (const [token, body] of defs) {
    if (done.has(token)) continue;
    lines.push(`!milo_t${lines.length} = ${whole(token, body)}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * A non-owning fn value `(T) => R` as !milo.fn; null for an owning (`move`) one, whose
 * environment is heap memory with drop glue, and for a param the dialect lacks.
 */
function fnType(cx: MlirEmitCtx, t: TypeKind & { tag: "fn" }): string | null {
  const ps = t.params.map(p => closureParamType(cx, p));
  if (ps.some(x => x === null)) return null;
  // A by-value param or result is an ABI boundary: one that lives in memory (Repr) is still
  // passed as one SSA value (llvmType).
  const r = t.ret.tag === "void" ? "()" : placeType(cx, t.ret);
  return r === null ? null : `!milo.fn<${t.owning ? "owning " : ""}(${ps.join(", ")}) -> ${r}>`;
}

/** A closure param: a `&T` is the place (passed as a pointer). */
function closureParamType(cx: MlirEmitCtx, p: TypeKind): string | null {
  return p.tag === "ref" ? lentType(cx, p.inner) : placeType(cx, p);
}

/**
 * The one answer to what a by-ref argument of `t` is lent as (its address): a
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
 * checker keeps frozen while the view lives): the header is returned by value, so the
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

const isTempBox = (op: Form) => op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "HeapCreate";

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
/**
 * A literal pattern's value as the expression it is compared with, of the payload's type
 * `ty`. An int pattern on a float payload (`A(3)` with an f64 field) is a float.
 * compares it.
 */
function patLiteral(fx: Facts, kind: (Pat & { kind: "LiteralPattern" })["literalKind"], value: bigint | number | string | boolean, ty: TypeKind): Expr {
  if (kind === "float" || (kind === "int" && ty.tag === "float")) return fx.syn({ kind: "FloatLit", value: Number(value) }, ty);
  switch (kind) {
    case "string": return fx.syn({ kind: "StringLit", value: String(value) }, ty);
    case "bool": return fx.syn({ kind: "BoolLit", value: !!value }, ty);
    case "char": return fx.syn({ kind: "CharLit", value: Number(value) }, ty);
    default: return fx.syn({ kind: "IntLit", value: BigInt(value as bigint) }, ty);
  }
}

function quote(s: string): string {
  return quoteBytes(Buffer.from(s, "utf-8"));
}

/**
 * A string literal's bytes: UTF-8, except the lexer's sentinel for a `\xNN` escape (U+F780
 * to U+F7FF), which is the one raw byte NN.
 */
function literalBytes(s: string): Uint8Array {
  // Filled by index into one buffer sized for the worst case (3 bytes per UTF-16 unit): an
  // @embedFile literal is tens of megabytes, and a number[] grown by a Buffer per character
  // held over a gigabyte for it.
  const out = new Uint8Array(s.length * 3);
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) { out[k++] = c; continue; }
    if (c >= 0xF780 && c <= 0xF7FF) { out[k++] = c - 0xF700; continue; }
    if (c >= 0xD800 && c <= 0xDFFF) {
      const lo = c <= 0xDBFF && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i++; }
      else c = 0xFFFD; // a lone surrogate encodes as U+FFFD, as Buffer.from does
    }
    if (c < 0x800) { out[k++] = 0xC0 | (c >> 6); out[k++] = 0x80 | (c & 0x3F); }
    else if (c < 0x10000) { out[k++] = 0xE0 | (c >> 12); out[k++] = 0x80 | ((c >> 6) & 0x3F); out[k++] = 0x80 | (c & 0x3F); }
    else { out[k++] = 0xF0 | (c >> 18); out[k++] = 0x80 | ((c >> 12) & 0x3F); out[k++] = 0x80 | ((c >> 6) & 0x3F); out[k++] = 0x80 | (c & 0x3F); }
  }
  return out.slice(0, k);
}

const HEX_DIGITS = Buffer.from("0123456789abcdef", "latin1");

function quoteBytes(bytes: Uint8Array): string {
  // One buffer, decoded once: `+=` per byte made a rope of 30 million pieces for an embedded asset.
  const out = Buffer.allocUnsafe(bytes.length * 3 + 2);
  let k = 0;
  out[k++] = 0x22;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    if (ch === 0x22 || ch === 0x5c || ch < 0x20 || ch >= 0x7f) { out[k++] = 0x5c; out[k++] = HEX_DIGITS[ch >> 4]; out[k++] = HEX_DIGITS[ch & 15]; }
    else out[k++] = ch;
  }
  out[k++] = 0x22;
  return out.toString("latin1", 0, k);
}

// Bit-exact float literals: NaN payloads and -0 survive, f32 is rounded the way
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
// the loop: a move takes it and leaves the zero value.
// `view`: a `var` of a `&T` or slice type, a slot of view headers that owns none of them:
// an assignment replaces the header and drops nothing.
// `flag`: a move closure's capture, held by its env, with the place of its liveness flag:
// a move out zeroes the capture and clears the flag, so the env's drop skips it.
type Binding = { kind: "ssa"; v: Val } | { kind: "var"; ref: string; ty: string; param?: number; owned?: boolean; zeroOnMove?: boolean; view?: boolean; flag?: string }
  | { kind: "vec"; ref: string; elem: string; param?: number } | { kind: "opaque"; what: string }
  // A `&T` reached through a raw pointer (`let p = b else` on a `?&mut T`): the dialect
  // has no milo.ref behind a pointer, so it is read and written through the pointer
  // (ptrPlace) and lent only to a call (milo.ptr.lend); any other use is unsupported.
  | { kind: "ptr"; ptr: string; ty: string };

// How one match arm makes its bindings (FnEmitter.armBinder). `view`: the binding reads
// the subject's memory (a payload place, or a copy of a payload with drop glue).
// A Vec/array/string/HashMap for-in, as the checker classified its iterable (`varType2`: the
// second binding's type, `for i, x in v`). `consume`: the loop owns a temporary Vec/array.
interface ForEachS {
  varName: string; varName2: string | null; varType: TypeKind; varType2: TypeKind | null;
  iterable: Node | Form; iterableKind: "vec" | "string" | "hashmap" | "array"; consume: boolean;
  body: Stmt[]; invariants: Contract[]; span?: Span;
}
// A match arm's body: statements, or (for the emitter's own sugar) a statement emitter.
type ArmBody = Stmt[] | (() => boolean);
interface MatchIn { subject: Node | Form; arms: { pattern: Pat; body: ArmBody }[]; subjectIsRef?: boolean; subjectIsMut?: boolean }

interface ArmBinder {
  bind(name: string, b: Binding, view: boolean): void;
  owned(name: string, ty: string, t: TypeKind): string;
}
// The block a match sits in: an escaping binding's scope and owner.
interface MatchOuter { scope: Map<string, Binding>; frame: number }

// What the closure bodies of one top-level function share: their names and texts.
interface ClosureState { next: number; texts: string[]; names: string[] }

// The builtins that are a libc call, a runtime section, a load or a process global (nativeBuiltin).
const NATIVE_BUILTINS = new Set(["exit", "flush", "_cstrToString", "_bytesToString", "_strDataPtr", "_putByte", "_loadU8", "_loadI32", "_callClosureVoid",
  "_schedulerGet", "_schedulerSet", "_panicHookSet", "_miloArgCount", "_miloArgAt"]);

const ARITH: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem", "<<": "shl", ">>": "shr" };
const BITS: Record<string, string> = { "&": "and", "|": "or", "^": "xor" };
const CMPS: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };

// What an emitter method takes as an expression: an AST node (or a coercion layer of one), or
// the form a caller already read off it.
type X = Node | Form;

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

  private readonly fx: Facts;
  // The forms of this body: the result type a `?` returns to (a closure's own inside it), the
  // callee each @trackCaller call names, and the entry snapshot each `old(e)` reads.
  private fcx: FormCtx;
  private readonly olds = new Map<Expr, string>();

  constructor(private fn: FnDecl, private cx: MlirEmitCtx, private fns: Map<string, FnDecl>,
    readonly closures: ClosureState = { next: 0, texts: [], names: [] }, readonly glue: MlirGlue = new MlirGlue(cx)) {
    this.fx = cx.facts;
    const callees = cx.calleesOf(fn.name);
    this.fcx = { ret: fn.retType, callee: callees ? (e, c) => callees.get(e) ?? c : undefined, old: e => this.olds.get(e) };
  }

  /** The form of `x` (a form is its own). */
  private f(x: X): Form { return "node" in x ? x : this.fx.form(x, this.fcx); }
  private k(x: X): Form["kind"] { return this.f(x).kind; }
  /** The checker's type of what `x` evaluates to. */
  private ty(x: X): TypeKind { return this.fx.ty("node" in x ? x.node : x); }
  /** The checker moves the value `x` reads (its last use, or a `move`). */
  private mv(x: X): boolean { return this.fx.moved(this.fx.ast("node" in x ? x.node : x)); }
  /** A node for a value the emitter itself bound to `name`. */
  private synIdent(name: string, type: TypeKind, move = false, span?: Span): Expr { return this.fx.syn({ kind: "Ident", name, span }, type, { move }); }
  /** A node for a form the emitter builds (its own sugar), of `type`. */
  private syn(type: TypeKind, form: (n: Expr) => Form): Expr { return this.fx.synForm(type, form); }
  private arg(expr: Node, passByRef = false, refMut = false): Arg { return { expr, passByRef, refMut }; }
  /** `n` where a statement needs an expression node: a coercion layer as a node of its own. */
  private asExpr(n: Node): Expr { return n.kind === "$peel" ? this.syn(this.ty(n), x => ({ ...this.f(n), node: x })) : n; }

  private hasDrop(ty: string): boolean { return ownsOf(this.cx, ty).drop; }
  /** `ty` runs a user's Drop when dropped: when that happens is observable. */
  private runsUserDrop(ty: string): boolean { return ownsOf(this.cx, ty).userDrop; }

  /**
   * Closure literal `e` as a function of its own, `name`: the env, then its params. Each
   * capture is bound to its place, read out of the env (milo.env.capture).
   */
  runClosure(e: FormOf<"Closure">, name: string, caps: { name: string; place: string; b: Binding }[], flags: { of: number; once: boolean }[] = []): string {
    // A closure body runs per call: a closure it builds keeps a frame env (scoped
    // staticEnv by currentFnName, which a closure body never is).
    this.inClosureBody = true;
    // `?`, `if`/`match` values and returns in the body are the closure's, not the fn's.
    this.fcx = { ...this.fcx, ret: e.retType };
    if (this.cx.emitDebug) this.debugLoc = (e.span && debugLocOf(this.cx, e.span)) || fnDebugLoc(this.cx, this.fn);
    const params = ["%env: !milo.ptr"];
    const refs = caps.map((c, i) => this.def(`milo.env.capture %env[${i}] : ${c.place}`, c.place).ref);
    // A move env's liveness flags follow its captures in the table.
    const flagOf = new Map(flags.map((f, j) => [f.of, this.def(`milo.env.capture %env[${caps.length + j}] : !milo.ref<i1>`, "!milo.ref<i1>").ref]));
    caps.forEach((c, i) => {
      const r = refs[i];
      this.bind(c.name, c.b.kind === "vec" ? { kind: "vec", ref: r, elem: c.b.elem } : { kind: "var", ref: r, ty: (c.b as { ty: string }).ty, flag: flagOf.get(i) });
    });
    // A move closure that gives a capture away can run once: a cleared
    // flag on such a capture means this is the second call.
    for (const f of flags) {
      if (!f.once) continue;
      const spent = this.def(`milo.not ${this.def(`milo.load ${flagOf.get(f.of)!} : !milo.ref<i1>`, "i1").ref} : i1`, "i1");
      this.panicIf(spent.ref, `closure called again after it moved '${caps[f.of].name}' out (${this.panicAt(e.span)}): a move closure that gives a capture away can run once\n`);
    }
    e.params.forEach((p, i) => {
      const ty = closureParamType(this.cx, p.type);
      if (ty === null) throw new MlirUnsupported(`closure param of type ${placeBlocker(this.cx, stripRefs(p.type))}`);
      params.push(`%p${i}: ${ty}`);
      if (ty.startsWith("!milo.vec<")) this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem: ty.slice(10, -1) });
      else if (p.type.tag === "ref") this.bind(p.name, { kind: "var", ref: `%p${i}`, ty: ty.slice(10, -1) });
      else this.bindParam(p.name, `%p${i}`, ty, p.type, i + 1);
    });
    // A result that lives in memory (Repr) leaves as one SSA value, as a function's does.
    const ret = e.retType.tag === "void" ? null : this.place$(e.retType, "closure result");
    this.retTy = ret;
    // A sortByKey extractor may hand back a field of its borrowed element (checker [MILO-O-keyExtractor]
    // keyExtractorClosures): the sort only reads the key and forgets it, so the view's bits
    // are the result.
    if (e.keyExtractor) { this.retView = ret; this.keyBody = true; }
    this.retPlaceOnly = ret !== null && !isSsa(this.cx, ret);
    const jumped = this.stmts(e.body);
    this.closeScope(0, jumped, null);
    if (!jumped) this.emit(ret === null ? "milo.return" : "milo.unreachable");
    const head = `func.func @${quote(name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} attributes {llvm.linkage = #llvm.linkage<internal>} {`;
    return [head, ...this.vars, ...this.body, this.cx.emitDebug ? `} ${this.cx.debugClosureLoc(name, e.span, this.debugLoc)}` : "}"].join("\n");
  }

  /**
   * A by-value param `ref` of `t` (`ty`, the ABI's SSA value), bound as the prologue
   * keeps it: one that owns goes to an owned slot of the body's scope (the callee owns it),
   * one that lives in memory (Repr) to a slot of its own, and is only a place from there.
   */
  private bindParam(name: string, ref: string, ty: string, t: TypeKind, arg: number): void {
    if (!this.hasDrop(ty) && !inSlot(this.cx, ty)) {
      this.bind(name, { kind: "ssa", v: { ref, ty } });
      this.debugValue(name, ref, ty, t, arg);
      return;
    }
    const owned = this.hasDrop(ty);
    let slot: string;
    if (owned) slot = this.ownedSlot(name, ty, t);
    else {
      slot = this.fresh();
      this.vars.push(`  ${slot} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    }
    this.emit(`milo.store ${ref}, ${slot} : !milo.ref<${ty}>`);
    this.bind(name, { kind: "var", ref: slot, ty, owned });
    this.debugVar(name, slot, ty, t, arg);
  }

  /**
   * -g: `slot` (holding a `ty`) is the source variable `name`, for lldb's `frame variable`.
   * Scalars and structs of them only (milo-opt drops the op for any other pointee). `arg` is
   * the 1-based parameter number of a param.
   */
  private debugVar(name: string, slot: string, ty: string, t: TypeKind, arg?: number): void {
    if (!this.cx.emitDebug || !hasDebugType(ty)) return;
    const fields: string[] = [];
    const seen = new Set<string>();
    // Field names of every struct, variant names of every enum, that the type reaches: the
    // dialect's types carry neither. A depth past 4 is where milo-opt stops describing.
    const names = (k: TypeKind, depth: number) => {
      k = stripRefs(k);
      if (k.tag === "vec") return names(k.element, depth + 1);
      if ((k.tag !== "struct" && k.tag !== "enum") || seen.has(k.name) || depth > 4) return;
      seen.add(k.name);
      if (k.tag === "struct") {
        const l = this.cx.structLayouts.get(k.name);
        if (!l) return;
        fields.push(`${quote(k.name)} = [${l.fields.map(f => quote(f.name)).join(", ")}]`);
        for (const f of l.fields) names(f.typeKind, depth + 1);
        return;
      }
      const l = this.cx.mlirEnumLayout(k.name);
      if (!l) return;
      fields.push(`${quote(k.name)} = [${l.variants.map(v => quote(v.name)).join(", ")}]`);
      for (const v of l.variants) for (const f of v.fields) names(f, depth + 1);
    };
    names(t, 0);
    const attrs = [`name = ${quote(name)}`, ...(arg ? [`arg = ${arg} : i32`] : []), ...(fields.length ? [`fields = {${fields.join(", ")}}`] : [])];
    this.emit(`milo.dbg.var ${slot} : !milo.ref<${ty}> {${attrs.join(", ")}}`);
  }

  /** -g: `v`, an SSA value bound to `name`, copied to a slot of its own so the debugger has a place to read. */
  private debugValue(name: string, v: string, ty: string, t: TypeKind, arg?: number): void {
    if (!this.cx.emitDebug || !hasDebugType(ty)) return;
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    this.emit(`milo.store ${v}, ${slot} : !milo.ref<${ty}>`);
    this.debugVar(name, slot, ty, t, arg);
  }

  run(): string {
    const fn = this.fn;
    if (fn.isExtern) throw new MlirUnsupported("extern fn");
    if (fn.isVariadic) throw new MlirUnsupported("variadic fn");
    if (this.cx.emitDebug) this.debugLoc = fnDebugLoc(this.cx, fn);
    // main first calls the scaffold's process init (argc/argv, stdout buffering, global
    // init). Behind a green-task wrapper main's body is MAIN_BODY, which the wrapper's task
    // calls with nothing (the wrapper ran the init) and takes its i32 as the exit code.
    const isMain = fn.name === "main";
    // `fn main(): i32` returns its exit code; a void main returns 0.
    const mainI32 = isMain && fn.retType.tag === "int" && fn.retType.bits === 32 && fn.retType.signed && fn.retType.min === undefined && fn.retType.max === undefined;
    if (isMain && (fn.params.length || (fn.retType.tag !== "void" && !mainI32))) throw new MlirUnsupported("main");
    const green = isMain && !this.cx.mlirMainOk;
    const params = fn.params.map((p, i) => {
      // A by-ref param of a type the dialect lacks is just a pointer in the signature; the
      // function qualifies only if it never names it (lookup refuses).
      const elem = vecElem(this.cx, p.type);
      const attrs = this.cx.paramAttrs(fn.name, i);
      if ((p.isRef || p.isRefMut) && elem !== null) {
        this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem, param: i });
        return `%p${i}: !milo.vec<${elem}>${attrs}`;
      }
      if ((p.isRef || p.isRefMut) && placeType(this.cx, p.type) === null) {
        this.bind(p.name, { kind: "opaque", what: placeBlocker(this.cx, p.type) });
        return `%p${i}: ${PTR}${attrs}`;
      }
      const pt = placeType(this.cx, p.type);
      const ty = p.isRef || p.isRefMut ? pt! : this.place$(p.type, "param");
      if (p.isRef || p.isRefMut) {
        this.bind(p.name, { kind: "var", ref: `%p${i}`, ty, param: i });
        return `%p${i}: !milo.ref<${ty}>${attrs}`;
      }
      this.bindParam(p.name, `%p${i}`, ty, p.type, i + 1);
      return `%p${i}: ${ty}`;
    });
    // main is `i32 @main(i32 argc, ptr argv)` and returns 0.
    if (isMain && !green) {
      params.push("%argc: si32", `%argv: ${PTR}`);
      const ty = `(si32, ${PTR}) -> ()`;
      this.callees.set(PROCESS_INIT_FN, ty);
      this.emit(`func.call @${quote(PROCESS_INIT_FN)}(%argc, %argv) : ${ty}`);
    }
    // An sret function (a 128+ byte result) writes its result through `%out`, the hidden
    // first param of `void @f(ptr %__sret.out, ...)`, and returns nothing.
    if (this.cx.sretFns.has(fn.name)) {
      this.sretOut = { ref: "%out", ty: this.place$(fn.retType, "sret result") };
      params.unshift(`%out: !milo.ref<${this.sretOut.ty}>`);
    }
    this.retView = isMain ? null : viewResult(this.cx, fn.retType);
    const ret = isMain ? "si32" : fn.retType.tag === "void" || this.sretOut ? null : this.retView ?? this.place$(fn.retType, "return");
    this.retPlaceOnly = ret !== null && !isMain && valueType(this.cx, fn.retType) === null;
    this.isMain = isMain;
    this.retTy = ret;
    // Applies only when std/replay is in the program.
    this.replay = !!fn.replayEngine && this.cx.replayScope;
    if (this.replay) this.emit("milo.replay.enter");
    // A contract-checking build: the old(...) snapshots, then every
    // requires clause, at entry; the ensures clauses at every return (ret).
    // A loop's invariants ride its loop; `decreases` is a static measure `milo prove` checks.
    const contracts = (fn.ast?.contracts ?? []).filter(c => c.kind === "requires" || c.kind === "ensures");
    if (entryGuards(contracts, this.cx.lazyGlobals).length) throw new MlirUnsupported("lazy global guard");
    const snapshots = this.oldSnapshots(contracts);
    if (this.cx.contractChecks !== "none" && contracts.length) {
      if (this.stmts(snapshots)) throw new MlirUnsupported("old() snapshot that jumps");
      for (const c of contracts) if (c.kind === "requires") this.contractCheck(c.kind, c.expr, c.span);
      this.ensures = contracts.filter(c => c.kind === "ensures");
    }
    const jumped = fn.inits ? this.initGlobals(fn.inits) : this.stmts(fn.ast?.body ?? []);
    // A void body that falls off its end checks its ensures here, inside the scope of its
    // owned params: an old() snapshot of one (`old(w.len)` of a by-value Vec) is defined
    // in that scope's region, so a check after it closes names a value out of scope.
    if (!jumped && !isMain && ret === null && this.ensures.length) {
      for (const c of this.ensures) this.contractCheck("ensures", c.expr, c.span);
      this.ensures = [];
    }
    this.closeScope(0, jumped, null);
    if (!jumped) {
      if (isMain) this.retMain();
      else if (ret === null) this.ret("milo.return");
      else this.emit("milo.unreachable");
    }
    const name = green ? MAIN_BODY : fn.name;
    const head = `func.func @${quote(name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`}${this.cx.fnAttrs(fn, name)} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  /**
   * `let __oldN = e` for every `old(e)` the clauses mention, in source order (a clause reads
   * the value `e` had at entry, so a contract-checking build snapshots it there); each
   * `old(e)` then reads its snapshot (FormCtx.old). A release build pays for none.
   */
  private oldSnapshots(contracts: Contract[]): Stmt[] {
    const out: Stmt[] = [];
    if (this.fx.shadowed("old")) return out;
    walkAst(contracts.map(c => c.expr), n => {
      if (n.kind !== "Call" || n.func !== "old" || n.args.length !== 1 || this.olds.has(n)) return;
      const name = `__old${this.olds.size}`;
      out.push({ kind: "LetDecl", name, type: null, value: n.args[0], span: n.span });
      this.olds.set(n, name);
    });
    return out;
  }

  /**
   * A module-global initializer's body: each global filled with its value. The slot holds
   * zeroes until then, so nothing is dropped before the first store (`init`), and a global
   * it reads that is itself lazy is initialized first; its own target is no read.
   */
  private initGlobals(inits: GlobalDecl[]): boolean {
    for (const g of inits) {
      for (const name of lazyMentions(g.value, this.cx.lazyGlobals)) if (name !== g.name) this.emit(`milo.global.init ${quote(name)}`);
      this.owned.push([]);
      const start = this.body.length;
      const jumped = this.assign(this.synIdent(g.name, g.type), g.value, true, g.value.span);
      this.closeScope(start, jumped, null);
      if (jumped) return true;
    }
    return false;
  }

  private replay = false;
  private sretOut: { ref: string; ty: string } | null = null;

  /** True for a call of a function lowered to sret: its result is written in place. */
  private isSretCall(x: X): x is FormOf<"Call"> {
    const e = this.f(x);
    return e.kind === "Call" && this.cx.sretFns.has(e.func) && !this.cx.isBuiltinName(e.func);
  }

  /**
   * `e`, a 128+ byte aggregate, written into the place `dst` (of type `ty`) without ever
   * being an SSA value: a struct literal field by field, an sret call through `dst`.
   * The stores are `init`: `dst` holds nothing yet.
   */
  private into(x: X, dst: string, ty: string): void {
    const e = this.f(x);
    if (this.isSretCall(e)) { this.callScope(() => this.call(e, true, dst)); return; }
    const src = valueType(this.cx, this.ty(e.node)) === ty ? null : this.bigPlace(e, ty);
    if (src) {
      this.emit(`milo.copy ${src.ref}, ${dst} : ${src.refTy}, !milo.ref<${ty}> of ${ty}`);
      src.done();
      return;
    }
    if ((e.kind === "ArrayLit" || e.kind === "ArrayRepeat") && this.ty(e.node).tag === "array") {
      this.arrayInto(e, dst, ty);
      return;
    }
    // A value-producing branch fills the place from each arm
    // does for a big match or if: the value is never an SSA one.
    if (valueType(this.cx, this.ty(e.node)) !== ty) {
      if (e.kind === "MatchExpr") { this.match(this.matchOf(e), null, b => this.tailInto(b, dst, ty)); return; }
      if (e.kind === "Propagate") { this.propagate(e, { dst, ty }); return; }
      if (e.kind === "DefaultValue") { this.defaultValue(e, { dst, ty }); return; }
      if (e.kind === "Zeroed" && this.place$(e.zeroType, "zeroed value") === ty) {
        // A constant store: LLVM makes it a memset.
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
    if (e.kind !== "StructLit" && valueType(this.cx, this.ty(e.node)) === ty) {
      // A big enum that is also a value: computed, then stored whole.
      const v = this.consume(this.expr(e), "value");
      this.emit(`milo.store ${v.ref}, ${dst} init : !milo.ref<${ty}>`);
      return;
    }
    if (e.kind === "EnumLit") { this.enumInto(e, dst, ty); return; }
    if (e.kind === "OptionOp" && e.op !== "resultContext" && this.combinatorMatch(e, { dst, ty })) return;
    if (e.kind === "MemReplace") {
      // The big path of replace: the old value's bits move to `dst` (the result), [MILO-O-replaceSwap]
      // then `v` is built over the place with nothing dropped. Until then both hold the
      // same bits, so no jump may come between (a held pending).
      const p = this.place(e.place, `!milo.ref<${ty}>`, true).ref;
      this.emit(`milo.copy ${p}, ${dst} : !milo.ref<${ty}>, !milo.ref<${ty}> of ${ty}`);
      const mark = this.pending.length;
      if (this.hasDrop(ty)) this.pending.push({ ref: dst, ty, t: this.ty(e.node), place: true, hold: true });
      this.into(e.value, p, ty);
      this.pending.length = mark;
      return;
    }
    // isSretCall narrowed Call away; a call that is not sret returns a place-only value.
    const c = e as Form;
    if ((c.kind === "Call" && !this.cx.isBuiltinName(c.func)) || c.kind === "ClosureCall") {
      const v = this.callScope(() => c.kind === "Call" ? this.call(c, false, undefined, true) : this.closureCall(c, false, true));
      this.emit(`milo.store ${this.take(v, ty, "call result").ref}, ${dst} init : !milo.ref<${ty}>`);
      return;
    }
    if (e.kind === "Unwrap") { this.unwrapInto(e, dst, ty); return; }
    if (e.kind === "HeapDeref" && valueType(this.cx, this.ty(e.node)) === null && (isTempBox(this.f(e.operand)) || (this.mv(e) && this.hasDrop(ty)))) {
      // The payload moves out of the box into `dst`; the box is freed with nothing dropped.
      const hty = `!milo.heap<${ty}>`;
      const { h, after } = this.takeBox(this.f(e.operand), hty);
      const p = this.def(`milo.heap.place ${h} : ${hty} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
      this.emit(`milo.copy ${p}, ${dst} : !milo.ref<${ty}>, !milo.ref<${ty}> of ${ty}`);
      this.emit(`milo.heap.free ${h} : ${hty}`);
      after();
      return;
    }
    if (e.kind === "MapCopyOut" && valueType(this.cx, this.ty(e.node)) === null) {
      // The deep copy of a big value is written by its clone glue straight into `dst`.
      const src = this.place(e.value, refOf(ty), false).ref;
      const fn = this.glue.cloneFromPlace(stripRefs(this.ty(e.node)), refOf(ty), ty);
      this.rtCall(fn, [{ ref: src, ty: refOf(ty) }, { ref: dst, ty: `!milo.ref<${ty}>` }], null);
      return;
    }
    if (e.kind !== "StructLit") throw new MlirUnsupported(`128+ byte value other than a literal or an sret call: ${e.kind}`);
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout || this.place$(this.ty(e.node), "struct literal") !== ty) throw new MlirUnsupported("struct literal layout");
    const given = new Map<string, Val>();
    const mark = this.pending.length;
    for (const f of e.fields) {
      const i = layout.fields.findIndex(lf => lf.name === f.name);
      const lt = layout.fields[i]?.typeKind;
      // A field that is a place only (an array), or one an sret call returns (a 128+ byte
      // enum the callee writes to memory), is built in its own place, in source order.
      const pty = lt && (valueType(this.cx, lt) === null || this.isSretCall(f.value)) ? placeType(this.cx, lt) : null;
      if (pty === null) { given.set(f.name, this.pend(this.fieldValue(f.value, lt), this.ty(f.value))); continue; }
      const fr = this.def(`milo.field_ref ${dst}[${i}] : !milo.ref<${ty}> -> !milo.ref<${pty}>`, `!milo.ref<${pty}>`).ref;
      this.into(f.value, fr, pty);
      // An owning one built in place is owned by nothing until the whole struct is: a
      // jump out of a later field would leak it, so it counts as a pending operand.
      if (this.hasDrop(pty)) this.pending.push({ ref: fr, ty: pty, t: lt, place: true });
      given.set(f.name, { ref: "", ty: pty });
    }
    this.pending.length = mark;
    // A struct update's base (`..base`), after the listed fields
    // The base is evaluated into a slot of the statement, then field by field in layout order,
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
  private enumInto(e: FormOf<"EnumLit">, dst: string, ty: string): void {
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
   * plain only where `leak` says it is stored with nobody to free it (a field).
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
   * extern struct's ops table) is the function's own symbol.
   */
  private fieldValue(x: X, ft: TypeKind | undefined): Val {
    const e = this.f(x);
    if (ft?.tag === "cfn" && e.kind === "Ident" && this.ty(e).tag === "fn" && this.fns.has(e.name) && !this.scopes.some(m => m.has(e.name))) {
      const u8p: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
      return this.fnAddress({ kind: "Cast", node: this.syn(u8p, n => ({ kind: "Cast", node: n, operand: e.node, targetType: u8p })), operand: e.node, targetType: u8p });
    }
    return this.consume(this.expr(x), "field");
  }

  /** An i8/i16/i32 bound as i64, sign or zero extended by its type. */
  private widenBound(v: Val): Val {
    const m = /^([su])i(8|16|32)$/.exec(v.ty);
    if (!m) return v;
    if (m[1] === "s") return this.def(`milo.cast ${v.ref} : ${v.ty} to si64`, "si64");
    const u = this.def(`milo.cast ${v.ref} : ${v.ty} to ui64`, "ui64");
    return this.def(`milo.cast ${u.ref} : ui64 to si64`, "si64");
  }

  /** `[T; N]` where a `*T` is wanted (a cast, a pointer argument): the array's address. */
  private decay(x: X): Val {
    const e = this.f(x);
    const p = this.fieldPlace(e);
    if (!p || !p.ty.startsWith("!milo.array<")) throw new MlirUnsupported("pointer to an array that is not a place");
    return this.def(`milo.addr ${p.ref} : !milo.ref<${p.ty}>`, PTR);
  }

  /**
   * An array literal written into the array place `dst`, element by element: `[a, b]`
   * evaluates and stores each in turn; `[v; n]` evaluates `v` once
   * and stores it n times in a loop (LLVM makes a memset of a zero one,
   * zeroinitializer is).
   */
  private arrayInto(e: FormOf<"ArrayLit" | "ArrayRepeat">, dst: string, ty: string): void {
    const t = this.ty(e.node) as TypeKind & { tag: "array" };
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
    // An owning value is deep cloned into all slots but the last;
    // one bit copy per slot would free the value N times.
    if (this.hasDrop(ety)) {
      // So here: the value parks in a slot that owns nothing, slots 0..n-2 get structural
      // clones of it (copyOut), the last gets the value.
      if (e.count === 0) {
        // No slot takes it: dropped right here. [MILO-O-arrayRepeat]
        this.owned.push([]);
        const start = this.body.length;
        this.emit(`milo.store ${v.ref}, ${this.ownedSlot("repeat.none", ety, this.ty(e.value))} : !milo.ref<${ety}>`);
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
        // The type's own Clone when the checker found one.
        const c = e.cloneFn ? this.cloneCall(e.cloneFn, park, ety, this.ty(e.value)) : this.copyOut(e.value, park, ety, true);
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
   * `o.map(f)` and the other callback combinators as the match each one means, so no
   * helper is needed: the receiver is the subject (a temporary or a moved one is consumed,
   * a named one the checker did not consume is matched in place), its payload binding is
   * handed to `f` (by reference when `f` takes `&T`), and the untouched variant is
   * forwarded as is. `f` is evaluated once, before the match.
   * [MILO-O-combinatorReceiver]
   */
  private combinatorMatch(e: FormOf<"OptionOp">, into?: { dst: string; ty: string }): Val | null {
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
    if (!sh || !e.default || this.ty(e.node).tag === "void") return null;
    const src = this.cx.mlirEnumLayout(e.enumName);
    const rt = this.ty(e.node);
    const res = rt.tag === "enum" ? this.cx.mlirEnumLayout(rt.name) : null;
    const hitV = src?.variants.find(v => v.name === sh.hit), missV = src?.variants.find(v => v.name === sh.miss);
    if (!hitV || !missV || hitV.fields.length > 1 || missV.fields.length > 1) return null;
    const cbt = this.ty(e.default);
    const ft = stripRefs(cbt);
    if (ft.tag !== "fn") return null;
    // The callback, once: an SSA binding the arms call.
    const cb = `comb$f${this.n++}`;
    this.bind(cb, { kind: "ssa", v: this.consume(this.expr(e.default), "combinator callback") });
    const n = this.n++;
    // A named receiver the checker did not consume is matched in place: its bindings are
    // views, read (its forwarded payload is Copy, by the checker's rule), never moved.
    const k = this.k(e.value);
    const owning = !((k === "Ident" || k === "FieldAccess") && !this.mv(e.value));
    const bindOf = (v: typeof hitV, name: string) => v.fields.length ? [{ name, type: v.fields[0]! }] : [];
    const call = (v: typeof hitV, name: string): Expr => {
      const byRef = ft.params[0]?.tag === "ref";
      const args = v.fields.length && ft.params.length ? [this.arg(this.synIdent(name, v.fields[0]!, owning && !byRef), byRef)] : [];
      return this.syn(ft.ret, x => ({ kind: "ClosureCall", node: x, span: e.span, callee: this.synIdent(cb, cbt), args }));
    };
    const lit = (variant: string, args: Expr[]): Expr => {
      const rv = res?.variants.find(v => v.name === variant);
      if (!rv) throw new MlirUnsupported(`combinator result variant ${variant}`);
      return this.syn(rt, x => ({ kind: "EnumLit", node: x, enumName: (rt as { name: string }).name, variant, args }));
    };
    const arm = (v: typeof hitV, isHit: boolean) => {
      const name = `comb$${isHit ? "x" : "e"}${n}`;
      const mine = (sh.call === "hit") === isHit;
      const bound = this.synIdent(name, v.fields[0] ?? rt, owning);
      const value = mine
        ? (sh.wrap ? lit(v.name, [call(v, name)]) : call(v, name))
        : sh.unwrap ? bound : lit(v.name, v.fields.length ? [bound] : []);
      return { pattern: { kind: "EnumPattern" as const, variant: v.name, tag: v.tag, bindings: bindOf(v, name) }, body: [{ kind: "ExprStmt" as const, expr: value }] };
    };
    const arms = [arm(hitV, true), arm(missV, false)];
    this.forks.push({ mode: null, sawView: false });
    try {
      // A 128+ byte result is built in its place, each arm's value into it.
      if (into) return this.match({ subject: e.value, arms, subjectIsRef: !owning }, null, b => this.tailInto(b, into.dst, into.ty)).v;
      return this.match({ subject: e.value, arms, subjectIsRef: !owning }, this.value(rt, "combinator result")).v;
    } finally { this.forks.pop(); }
  }

  private optionCallback(e: FormOf<"OptionOp">): Val {
    if (e.op === "resultContext") return this.resultContext(e);
    { const m = this.combinatorMatch(e); if (m) return m; }
    throw new MlirUnsupported(`option op ${e.op}`);
  }

  /** `clone(&*slot)` through the type's own Clone fn: an owned value of `ty`. */
  private cloneCall(fn: string, slot: string, ty: string, t: TypeKind): Val {
    const name = `repeat$of${this.n++}`;
    this.bind(name, { kind: "var", ref: slot, ty });
    const v = this.expr(this.syn(t, x => ({ kind: "Call", node: x, func: fn, args: [this.arg(this.synIdent(name, t), true)], variadic: false })));
    if (v.ty !== ty) throw new MlirUnsupported("clone result type");
    return v;
  }

  /**
   * The place `e` (128+ bytes, of type `ty`) is read out of for a milo.copy, or null when
   * `e` is not a place: a local, a field of a place, or memory behind a raw pointer (whose
   * bits the copy owns, as ptrRead's do). An owning local gives its value up only as the
   * checker's move of it: `done` then empties its slot, after the copy.
   */
  private bigPlace(x: X, ty: string): { ref: string; refTy: string; done: () => void } | null {
    const e = this.f(x);
    const none = () => {};
    if (e.kind === "Ident" || e.kind === "FieldAccess") {
      const pp = e.kind === "FieldAccess" ? this.ptrPlace(e) : null;
      if (pp) return pp.ty === ty ? { ref: pp.ptr, refTy: PTR, done: none } : null;
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b && b.kind !== "var") return null;
      if (b && this.hasDrop(ty)) {
        if (b.ty !== ty || !b.owned || !this.mv(e)) throw new MlirUnsupported("128+ byte copy that is not a move of a local");
        return { ref: b.ref, refTy: `!milo.ref<${ty}>`, done: () => { this.def(`milo.move ${b.ref} : !milo.ref<${ty}>`, ty); } };
      }
      if (!b && this.hasDrop(ty)) {
        // Moved out of a local's field: zeroed behind the copy, as moveField does.
        if (e.kind !== "FieldAccess" || !this.mv(e) || !this.fieldOfOwnedLocal(e)) throw new MlirUnsupported(`move out of a field (128+, ${this.moveRoot(e)})`);
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
    // A plain-data payload read out of a held box: copied from the box's own place. An
    // owning one would have to empty the box (a move) and a temporary box is freed after
    // the read: neither is a place to copy from.
    if (e.kind === "HeapDeref" && !this.hasDrop(ty) && !isTempBox(this.f(e.operand))) {
      const p = this.heapPlace(e);
      return p.ty === ty ? { ref: p.ref, refTy: `!milo.ref<${ty}>`, done: none } : null;
    }
    if (e.kind === "IndexAccess") {
      const pp = this.ptrPlace(e);
      if (pp) return pp.ty === ty ? { ref: pp.ptr, refTy: PTR, done: none } : null;
      // A Vec element: an owning one is deep-copied (its clone glue), into a fresh slot
      // that owns nothing: every bigPlace consumer takes what the place holds, so the
      // clone passes to it whole.
      const er = this.elemRef(e);
      if (er && er.ty === ty && this.hasDrop(ty)) {
        const tmp = this.fresh();
        this.vars.push(`  ${tmp} = milo.var "elem.copy" : !milo.ref<${ty}>`);
        const t = stripRefs(this.ty(e.node));
        let glue: string | null = null;
        try { glue = this.glue.cloneFromPlace(t, `!milo.ref<${ty}>`, ty); } catch (err) { if (!(err instanceof MlirUnsupported)) throw err; }
        if (glue) {
          this.rtCall(glue, [{ ref: er.ref, ty: `!milo.ref<${ty}>` }, { ref: tmp, ty: `!milo.ref<${ty}>` }], null);
          return { ref: tmp, refTy: `!milo.ref<${ty}>`, done: none };
        }
        throw new MlirUnsupported("copy of an element that has no clone glue");
      }
      return er && er.ty === ty ? { ref: er.ref, refTy: `!milo.ref<${ty}>`, done: none } : null;
    }
    return null;
  }

  /**
   * A 128+ byte argument passed by value (the ABI): loaded whole from its place right
   * at the call. An owning one must be the checker's move of a local.
   */
  private bigArg(x: X, ty: string): Val {
    const e = this.f(x);
    let slot: { ref: string; owned: boolean };
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      if (b.kind !== "var" || b.ty !== ty) throw new MlirUnsupported("128+ byte argument");
      // A move closure's capture moved out of its env: read whole, its flag cleared.
      if (b.flag && this.mv(e) && this.hasDrop(ty)) {
        const v = this.def(`milo.load ${b.ref} : !milo.ref<${ty}>`, ty);
        this.emit(`milo.store ${this.def("milo.const false", "i1").ref}, ${b.flag} : !milo.ref<i1>`);
        return { ...v, own: "owned" };
      }
      if (this.hasDrop(ty) && !(b.owned && this.mv(e))) throw new MlirUnsupported("128+ byte argument that is not a move");
      slot = { ref: b.ref, owned: !!b.owned };
    } else slot = this.bigSlot("arg", e, true);
    const op = this.hasDrop(ty) ? "milo.move" : "milo.load";
    return { ...this.def(`${op} ${slot.ref} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
  }

  /** A slot of this block holding `e` (128+ bytes), filled in place; owned when it has drop glue. */
  private bigSlot(name: string, x: X, temp = false, block = false): { ref: string; ty: string; owned: boolean } {
    const e = this.f(x);
    const ty = this.place$(this.ty(e.node), "value");
    const owned = this.hasDrop(ty);
    let ref: string;
    if (owned) ref = temp ? this.tempSlot(name, ty, this.ty(e.node), undefined, false, block) : this.ownedSlot(name, ty, this.ty(e.node));
    else {
      ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    }
    this.into(e, ref, ty);
    if (owned) this.emit(`milo.filled ${ref} : !milo.ref<${ty}>`);
    return { ref, ty, owned };
  }
  /**
   * A place-only value copied over `dst`, which holds one: the big Assign (the value
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

  /** `p = p` (an Ident or a field chain): the drop and the store are skipped. */
  private lvalueSame(x: X, y: X): boolean {
    const a = this.f(x), b = this.f(y);
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
  // A place lent from a raw pointer (milo.ptr.lend) may only be a call's argument: what
  // wants its address takes the pointer it came from (addressOf).
  private lentFrom = new Map<string, string>();

  /** The address of place `ref` (of type `ty`) as a raw pointer. */
  private addressOf(ref: string, ty: string): Val {
    const p = this.lentFrom.get(ref);
    return p ? { ref: p, ty: PTR } : this.def(`milo.addr ${ref} : ${ty}`, PTR);
  }
  private retPlaceOnly = false;

  /**
   * placeType, or the unsupported reason: what a place of `t` holds, and the
   * type of the SSA value an ABI boundary passes (a by-value param or result) whatever Repr says.
   */
  private place$(t: TypeKind, what: string): string {
    const v = placeType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${placeBlocker(this.cx, t)}`);
    return v;
  }

  /** lentType, or the unsupported reason. */
  private lent(t: TypeKind, what: string): string {
    const v = lentType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${placeBlocker(this.cx, stripRefs(t))}`);
    return v;
  }

  /** valueType, or the unsupported reason: an SSA operand of `t` away from an ABI boundary. */
  private value(t: TypeKind, what: string): string {
    const v = valueType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${blocker(this.cx, t)}`);
    return v;
  }
  private retMain(): void {
    const z = this.def("milo.const 0 : si32", "si32");
    this.ret(`milo.return ${z.ref} : si32`);
  }
  private ensures: Contract[] = [];
  /** One clause checked here: the condition in a scope of its own (its temporaries die before the check). */
  private contractCheck(clause: Contract["kind"], x: X, span?: Span): void {
    const e = this.f(x);
    const c = this.scoped(() => this.expr(e));
    if (c.ty !== "i1") throw new MlirUnsupported("contract clause of another type");
    this.emit(`milo.contract_check ${c.ref} ${JSON.stringify(clause)} ${this.loc(span)}`);
  }
  /**
   * The function's return: its ensures clauses first, `result` bound to the value being
   * returned, then the pending drops.
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

  private emit(line: string): void { this.body.push(`${"  ".repeat(this.depth)}${this.cx.emitDebug ? this.withDebugLoc(line) : line}`); }

  // -g only: the source location of what is being emitted, for the line table. An op the
  // parser reads without a loc gets one in the MLIR text itself, which would make the
  // line table point at the dialect text, so every op gets one.
  private debugLoc = "";
  // A region op's loc follows its closing brace: the loc of each open `{`, innermost last.
  private openLocs: string[] = [];

  private withDebugLoc(line: string): string {
    if (line.endsWith("{")) {
      if (!line.startsWith("}")) this.openLocs.push(this.debugLoc);
      return line;
    }
    if (line === "}") return `} ${this.openLocs.pop() ?? this.debugLoc}`;
    // A region op that carries its own source loc (milo.for_in) closes with it.
    if (/^\} loc\(/.test(line)) { this.openLocs.pop(); return line; }
    return needsLoc(line) ? `${line} ${this.debugLoc}` : line;
  }

  /** Runs `f` with the line table pointing at `span` (when it has one). */
  private at<T>(span: Span | undefined, f: () => T): T {
    if (!this.cx.emitDebug || !span) return f();
    const saved = this.debugLoc;
    this.debugLoc = debugLocOf(this.cx, span) ?? saved;
    try { return f(); } finally { this.debugLoc = saved; }
  }
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

  /** Where a panic at `span` says it is: inside a @trackCaller copy, the call site. */
  private site(span: Span | undefined): { file: string; line: number; col: number } {
    const l = this.cx.checkLocation(this.fn.trackedCaller ?? span);
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    return l;
  }

  /** `file:line:col` of a panic at `span`. */
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

  /**
   * A call of C function `name`, typed as the program's own extern declares it when it has
   * one (one module, one signature per symbol): operands and result cast between the two.
   */
  private libcCall(name: string, args: Val[], ret: string | null): Val {
    const ext = this.fns.get(name);
    if (!ext?.isExtern) return this.rtCall(name, args, ret);
    const ptys = ext.params.map(p => p.isRef || p.isRefMut ? null : valueType(this.cx, p.type));
    const rty = ext.retType.tag === "void" ? null : valueType(this.cx, ext.retType);
    if (ptys.length !== args.length || ptys.some(t => t === null) || (ret !== null && rty === null)) throw new MlirUnsupported(`${name}: its extern's signature`);
    const cast = (v: Val, to: string) => v.ty === to ? v : this.def(`milo.cast ${v.ref} : ${v.ty} to ${to}`, to);
    const res = this.rtCall(name, args.map((a, i) => cast(a, ptys[i]!)), rty);
    return ret === null || rty === null ? res : cast(res, ret);
  }

  /** A null buffer from an allocating runtime call. */
  private allocCheck(p: Val, span: Span | undefined): Val {
    const isNull = this.def(`milo.cmp eq, ${p.ref}, ${this.def(`milo.zero : ${PTR}`, PTR).ref} : ${PTR}`, "i1");
    const l = this.site(span);
    this.panicIf(isNull.ref, `runtime error: integer overflow at ${l.file}:${l.line}\n`);
    return p;
  }

  /**
   * Appends scalar `v`'s text to the string at `dst`: an
   * int as decimal (narrow ones widened by their signedness), a float as its shortest
   * round-tripping digits, a bool as true/false.
   */
  private pushScalar(dst: string, v: Val, span: Span | undefined): void {
    const m = /^([su])i(\d+)$/.exec(v.ty);
    let kind: "i64" | "u64" | "f64" | "f32" | "bool" | "ptr";
    let arg = v;
    if (m) {
      kind = m[1] === "s" ? "i64" : "u64";
      const w = `${m[1]}i64`;
      if (v.ty !== w) arg = this.def(`milo.cast ${v.ref} : ${v.ty} to ${w}`, w);
    } else if (v.ty === "f64" || v.ty === "f32" || v.ty === "i1" || v.ty === PTR) {
      kind = v.ty === "i1" ? "bool" : v.ty === PTR ? "ptr" : v.ty;
    } else throw new MlirUnsupported(`text of a ${v.ty}`);
    this.allocCheck(this.rtCall(PUSH_SCALAR_FN[kind], [{ ref: dst, ty: `!milo.ref<${STR}>` }, arg], PTR), span);
  }

  /**
   * The range check of `x[a..b]`: start < 0,
   * end < start or end > len panics with "milo: <what> range out of bounds: a..b (len n)".
   */
  private rangeCheck(what: string, a: Val, b: Val, len: Val, span: Span | undefined): void {
    const zero = this.def("milo.const 0 : si64", "si64");
    const c = (p: string, x: Val, y: Val) => this.def(`milo.cmp ${p}, ${x.ref}, ${y.ref} : si64`, "i1").ref;
    const bad0 = this.def(`milo.or ${c("lt", a, zero)}, ${c("lt", b, a)} : i1`, "i1");
    const bad = this.def(`milo.or ${bad0.ref}, ${c("gt", b, len)} : i1`, "i1");
    this.panicIf(bad.ref, [`milo: ${what} range out of bounds: `, "..", " (len ", `) at ${this.panicAt(span)}\n`], [a.ref, b.ref, len.ref]);
  }

  /**
   * A header `{ data, len, cap }` of type `ty` (a string, a Vec's !milo.vecval), written
   * through a slot's address, then loaded. Without `cap` it is a view (cap 0 owns nothing,
   * so nothing drops it); with one it owns its buffer.
   */
  private makeView(ty: string, data: Val, len: Val, cap?: Val): Val {
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "view" : !milo.ref<${ty}>`);
    const rec = `!milo.struct<"${ty === STR ? "String" : "Vec"}", ${PTR}, si64, si64>`;
    const at = this.def(`milo.addr ${slot} : !milo.ref<${ty}>`, PTR).ref;
    const field = (i: number) => this.def(`milo.ptr.field ${at}[${i}] : ${rec}`, PTR).ref;
    this.emit(`milo.ptr.store ${data.ref}, ${field(0)} : ${PTR}`);
    this.emit(`milo.ptr.store ${len.ref}, ${field(1)} : si64`);
    this.emit(`milo.ptr.store ${(cap ?? this.def("milo.const 0 : si64", "si64")).ref}, ${field(2)} : si64`);
    return { ...this.def(`milo.load ${slot} : !milo.ref<${ty}>`, ty), own: cap ? "owned" : "view" };
  }

  private constTrue(): string {
    return this.def("milo.const true", "i1").ref;
  }

  /** A call's result where a value is wanted: a void one is unsupported. */
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
   * closes. The open frame is the drop point, and it depends on the position:
   *  - an operator that only reads it and keeps nothing (`.len`, a tag test, a string
   *    byte, a Copy field): right after that operator, `peek`;
   *  - a by-ref argument's: right after its call, before the result is used, in the frame
   *    `callScope` opens around each call;
   *  - a match subject's: when the match ends, in the frame
   *    `stmt` opens around a match statement, or its `let`'s or call's;
   *  - a discarded result's, or one read in place by a statement (a print part, a string
   *    comparison's operand): at the end of its statement, `stmt`. Dropping them right
   *    after their operator would be the same point: nothing else runs in between;
   *  - a `let` initializer's: at the end of the `let` (`scoped`); a for-in iterable's after
   *    the loop; a temporary array a slice is taken of
   *    (`total([a, b])`): when its block ends (`block`);
   * `structural`: the temporary is a structural clone of an element (a `v[i]` match
   * subject), which shares its resources with the element, so
   * it is freed structurally (milo.var `structural`) and no
   * user Drop runs for it. A clone with a user Drop held anywhere else is unsupported.
   */
  private tempSlot(name: string, ty: string, t: TypeKind, of?: Val, structural = false, block = false): string {
    if (of && this.clones.has(of.ref) && !structural && this.runsUserDrop(ty)) throw new MlirUnsupported("a clone with a user Drop as a temporary");
    return this.ownedSlot(name, ty, t, structural, block);
  }
  // Results of copyOut: structural clones of what a place holds.
  private clones = new Set<string>();

  /** `e` read by `read`, which keeps nothing of it: a temporary `e` dies right after (tempSlot). */
  private peek(x: X, read: (v: Val) => Val): Val {
    const e = this.f(x);
    const v = this.expr(e);
    if (v.own !== "owned" || this.bitCopies.has(v.ref) || !this.hasDrop(v.ty)) return read(this.borrow(v, this.ty(e.node)));
    return this.scoped(() => read(this.borrow(v, this.ty(e.node))));
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
    this.glue.drop(stripRefs(t), structural);
  }

  // Owned operands evaluated and not yet handed to their op (`tok()` in
  // `take(tok(), match o { None => return 0, ... })`), or an owning field or element
  // already stored into a place built in place (`place`): no scope drops them on a jump out
  // of a later operand, so the jump does, last first. `hold` is
  // a value with a second owner until its op (MemReplace's old value): no jump may come
  // between, so one is unsupported.
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
   * An operand taken by value where nothing drops it (an extern's, an itable dispatch's):
   * any SSA value that owns nothing (a scalar, a pointer, a plain fn value, a struct or
   * enum of those). One that owns would leave the callee to drop it, which only a direct
   * call's callee does.
   */
  private helperOperand(x: X, what: string): { v: Val; type: TypeKind } {
    const e = this.f(x);
    const type = stripRefs(this.fieldType(e));
    const v = this.pend(this.expr(e), type);
    if (!isScalarTy(v.ty) && v.ty !== PTR && (!v.ty || v.ty !== valueType(this.cx, type) || this.hasDrop(v.ty)))
      throw new MlirUnsupported(`${what} of type ${type.tag}`);
    return { v, type };
  }

  /**
   * The one way a by-value position (an argument, a return, a store, a payload, an
   * element) takes an operand already evaluated: consumed (it owns itself or owns nothing),
   * a fn value cast across owning (fnAs; `leak` where an owned one is stored with nobody
   * to free it), and of exactly the position's type `ty`, or it is unsupported.
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
   * in a slot (Repr) is loaded whole from its place (bigArg).
   */
  private operand(x: X, ty: string, what: string, abi = false): Val {
    const e = this.f(x);
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
  private stmts(body: Stmt[]): boolean {
    for (const s of body) if (this.stmt(s)) return true;
    return false;
  }

  private stmt(s: Stmt): boolean {
    return this.at(s.span, () => {
      // A lazy global the statement mentions is filled before it runs (src/lazy-globals.ts);
      // a let-chain guards each clause where it is evaluated.
      if (s.kind !== "IfChainStmt") this.lazyGuards(s);
      return this.stmtAt(s);
    });
  }

  private lazyGuards(node: unknown): void {
    for (const g of lazyMentions(node, this.cx.lazyGlobals)) this.emit(`milo.global.init ${quote(g)}`);
  }

  /** `s` is a match statement (an `if let`, a let-else whose bindings all escape by name). */
  private isMatchStmt(s: Stmt): boolean {
    if (s.kind === "MatchStmt" || s.kind === "IfLetStmt") return true;
    if (s.kind !== "LetElseStmt" || (this.fx.c.nullRefUnwraps.get(s) && s.bindName !== undefined)) return false;
    return this.fx.c.matchSubjectRef.has(s.value) || isNestedPattern(s.pattern);
  }

  private stmtAt(s: Stmt): boolean {
    if (s.kind !== "Assign" && s.kind !== "ExprStmt" && !this.isMatchStmt(s)) return this.stmtCore(s);
    // Its temporaries die at its end (tempSlot): a block's end may never come
    // (an exit() later in it), and the live-block count at exit would see them.
    this.owned.push([]);
    const start = this.body.length;
    const jumped = this.stmtCore(s);
    this.closeScope(start, jumped, null);
    return jumped;
  }

  /** A loop body: its invariants checked first in a contract-checking build, then its statements. */
  private loopBody(body: Stmt[], invariants: Contract[]): boolean {
    if (this.cx.contractChecks === "all") for (const inv of invariants) if (inv.kind === "invariant") this.contractCheck("invariant", inv.expr, inv.span);
    return this.stmts(body);
  }

  private stmtCore(s: Stmt): boolean {
    switch (s.kind) {
      case "LetDecl":
      case "VarDecl":
        return this.letStmt(s.name, s.value, s.kind === "VarDecl", this.fx.c.viewLets.has(s), s.span);
      case "Assign": return this.assign(s.target, s.value, false, s.span);
      case "Return": return this.returnStmt(s.value, s.span);
      case "IfStmt": {
        // A compile-time condition (@targetOs() comparisons and boolean algebra over
        // literals) keeps only the taken arm: the dead one's platform-only symbols must
        // never reach codegen.
        const folded = this.fx.constBool(s.cond);
        if (folded !== null) {
          this.region(`milo.if ${this.constTrue()} {`, () => this.stmts(folded ? s.thenBody : s.elseBody ?? []));
          this.emit("}");
          return false;
        }
        return this.ifStmt(s.cond, () => this.stmts(s.thenBody), s.elseBody ? () => this.stmts(s.elseBody!) : null);
      }
      case "WhileStmt": {
        // A while's invariants are checked with its condition, so they hold on exit too.
        const invs = this.cx.contractChecks === "all" ? s.invariants.filter(c => c.kind === "invariant") : [];
        this.loops++; this.loopBase.push(this.pending.length);
        const checkInvs = () => { for (const inv of invs) this.contractCheck("invariant", inv.expr, inv.span); };
        const cond = this.f(s.cond);
        if (cond.kind === "BoolLit" && cond.value) {
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
      case "BreakStmt":
      case "ContinueStmt":
        if (this.loops === 0) throw new MlirUnsupported(`${s.kind} outside a loop`);
        this.dropPending(this.loopBase[this.loopBase.length - 1]);
        this.emit(s.kind === "BreakStmt" ? "milo.break" : "milo.continue");
        return true;
      case "ExprStmt": return this.exprStmt(s.expr, s.span);
      case "MatchStmt": {
        const m = this.fx.matchSubject(s.subject);
        return this.match({ subject: s.subject, arms: s.arms.map(a => ({ pattern: this.fx.pattern(a.pattern, m.enumName), body: a.body })), subjectIsRef: m.subjectIsRef, subjectIsMut: m.subjectIsMut }, null).done;
      }
      case "IfLetStmt":
        return this.ifLet(s.pattern, s.subject, () => this.stmts(s.thenBody), () => this.stmts(s.elseBody ?? []));
      case "IfChainStmt": return this.ifChain(s);
      case "LetElseStmt": return this.letElse(s);
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
      case "ForInStmt": return this.forIn(s);
      default: {
        // A statement kind with no arm would fall out of codegen silently: make the next
        // unhandled kind a compile error.
        const _exhaustive: never = s;
        throw new MlirUnsupported(`stmt ${(_exhaustive as { kind: string }).kind}`);
      }
    }
  }

  /** `if c { then } else { else }` as a statement: the condition's temporaries die before either arm. */
  private ifStmt(cond: X, then: () => boolean, els: (() => boolean) | null): boolean {
    const c = this.scoped(() => this.expr(cond));
    const thenDone = this.region(`milo.if ${c.ref} {`, then);
    const elseDone = els ? this.region("} else {", els) : false;
    this.emit("}");
    if (thenDone && elseDone) {
      // milo.if is not a terminator; the block still needs one, and nothing reaches it.
      this.emit("milo.unreachable");
      return true;
    }
    return false;
  }

  /**
   * `if let P = subject { then } else { else }` as a two-arm match. The checker decided
   * whether the subject is borrowed (and mutably); this only reads that back.
   */
  private ifLet(pattern: Pattern, subject: Expr, then: () => boolean, els: () => boolean): boolean {
    const m = this.fx.matchSubject(subject);
    return this.match({ subject, arms: [{ pattern: this.fx.pattern(pattern, m.enumName), body: then }, { pattern: { kind: "WildcardPattern" }, body: els }], subjectIsRef: m.subjectIsRef, subjectIsMut: m.subjectIsMut }, null).done;
  }

  /**
   * `if let P = a && c && let Q = b { then } else { else }`: the clauses nest left to right
   * (`if let` a two-arm match, a condition an if), the then-body innermost. Each clause has
   * its own failure exit, but the else must run once and outside every clause's scope (their
   * bindings are not in it, and a borrowed binding must be gone before the else may write the
   * subject). So the innermost level sets a flag and the else runs after the nest, when it is
   * clear. Copying the else into each exit would put it inside those scopes. [S-IF-CHAIN]
   */
  private ifChain(s: Stmt & { kind: "IfChainStmt" }): boolean {
    let flag: string | null = null;
    if (s.elseBody) {
      flag = this.fresh();
      this.vars.push(`  ${flag} = milo.var ${quote(`__chain${this.chains++}`)} : !milo.ref<i1>`);
      this.emit(`milo.store ${this.def("milo.const false", "i1").ref}, ${flag} : !milo.ref<i1>`);
    }
    const nest = (i: number): boolean => {
      if (i === s.clauses.length) {
        if (flag) this.emit(`milo.store ${this.constTrue()}, ${flag} : !milo.ref<i1>`);
        return this.stmts(s.thenBody);
      }
      const c = s.clauses[i]!;
      // Each clause is a statement of its own: guarded, and its temporaries dying at its end.
      return this.at(c.span, () => {
        this.lazyGuards(c);
        if (c.kind === "CondClause") return this.ifStmt(c.cond, () => nest(i + 1), null);
        this.owned.push([]);
        const start = this.body.length;
        const jumped = this.ifLet(c.pattern, c.subject, () => nest(i + 1), () => false);
        this.closeScope(start, jumped, null);
        return jumped;
      });
    };
    nest(0);
    if (flag && s.elseBody) {
      const ran = this.def(`milo.load ${flag} : !milo.ref<i1>`, "i1");
      this.region(`milo.if ${this.def(`milo.not ${ran.ref} : i1`, "i1").ref} {`, () => this.stmts(s.elseBody!));
      this.emit("}");
    }
    return false;
  }
  private chains = 0;

  /**
   * `let P(b) = v else { E }`: `let b = match v { P(b') => b', _ => E }`, the match's
   * diverging wildcard arm the else, its first binding renamed in the arm (b') so its slot does
   * not collide with the outer `b`. The bindings after the first are read by name after the
   * match, so they escape the arm (E-MATCH). A borrowed subject binds borrows into its payload,
   * which cannot leave the arm as a value, and a nested pattern's first binding is not payload
   * 0: then every binding escapes by name and the match is a statement. Over a `?&mut T`
   * extern parameter it is a null test, no match at all.
   */
  private letElse(s: Stmt & { kind: "LetElseStmt" }): boolean {
    const nullRef = this.fx.c.nullRefUnwraps.get(s);
    if (nullRef && s.bindName !== undefined) return this.nullRefUnwrap(s.bindName, s.value, nullRef.inner, s.elseBody);
    const m = this.fx.matchSubject(s.value);
    const pat = this.fx.pattern(s.pattern, m.enumName);
    if ((m.subjectIsRef || isNestedPattern(s.pattern)) && pat.kind === "EnumPattern") {
      for (const b of pat.bindings) b.escapes = true;
      return this.match({ subject: s.value, arms: [{ pattern: pat, body: [] }, { pattern: { kind: "WildcardPattern" }, body: s.elseBody }], subjectIsRef: m.subjectIsRef, subjectIsMut: this.fx.c.matchSubjectMut.has(s.value) }, null).done;
    }
    const binding = s.pattern.kind === "EnumPattern" ? (s.pattern.bindings[0] ?? "_") : "_";
    // The checker's binding type: `&T` when the value is a borrowed enum, where the pattern
    // alone gives the owned field type.
    const bindingType = this.fx.c.patternBindingTypes.get(s.pattern)?.[0]
      ?? (pat.kind === "EnumPattern" ? pat.bindings[0]?.type : undefined) ?? { tag: "unknown" as const };
    const inner = `__letelse_${binding}`;
    if (pat.kind === "EnumPattern" && pat.bindings[0]) { pat.bindings[0].name = inner; pat.bindings[0].type = bindingType; }
    if (pat.kind === "EnumPattern") for (let i = 1; i < pat.bindings.length; i++) pat.bindings[i].escapes = true;
    const astPat: Pattern = s.pattern.kind === "EnumPattern" ? { ...s.pattern, bindings: [inner, ...s.pattern.bindings.slice(1)] } : s.pattern;
    const arms = [
      { pattern: astPat, pat, body: [{ kind: "ExprStmt" as const, expr: this.synIdent(inner, bindingType, false, s.span), span: s.span }] },
      { pattern: { kind: "WildcardPattern" as const }, body: s.elseBody },
    ];
    const value = this.syn(bindingType, n => ({ kind: "MatchExpr", node: n, span: s.span, subject: s.value, arms, enumName: m.enumName, subjectIsRef: m.subjectIsRef, subjectIsMut: false }));
    return this.letStmt(binding, value, false, false, s.span);
  }

  /**
   * `let p = b else { ... }` on a `?&T`/`?&mut T`: a null test, the else block (which the
   * checker makes diverge) on null, then p is the pointee behind the pointer.
   */
  private nullRefUnwrap(name: string, ptr: Expr, inner: TypeKind, elseBody: Stmt[]): boolean {
    const p = this.expr(ptr);
    if (p.ty !== PTR) throw new MlirUnsupported("nullable ref of another type");
    const isNull = this.def(`milo.cmp eq, ${p.ref}, ${this.def(`milo.zero : ${PTR}`, PTR).ref} : ${PTR}`, "i1");
    const jumped = this.region(`milo.if ${isNull.ref} {`, () => this.stmts(elseBody));
    this.emit("}");
    if (!jumped) throw new MlirUnsupported("nullable ref else block that falls through");
    this.bind(name, { kind: "ptr", ptr: p.ref, ty: this.place$(inner, "nullable ref pointee") });
    return false;
  }

  private letStmt(name: string, value: X, mutable: boolean, viewLet: boolean, _span?: Span): boolean {
    const t = this.ty(value);
    if (viewLet && this.k(value) === "IndexAccess") {
      // The checker proved nobody can tell the element from a clone (viewLets): the binding
      // is the element's place (no copy, nothing to drop).
      const er = this.elemRef(value);
      if (!er) throw new MlirUnsupported("view let");
      this.bind(name, { kind: "var", ref: er.ref, ty: er.ty });
      return false;
    }
    const pt = placeType(this.cx, t);
    if (pt !== null && inSlot(this.cx, pt)) {
      const b = this.bigSlot(name, value);
      this.bind(name, { kind: "var", ref: b.ref, ty: b.ty, owned: b.owned });
      return false;
    }
    const slice = t.tag === "array" && t.size === null;
    if ((t.tag === "ref" || slice) && mutable) {
      // `var view = s[0..5]`: a slot of views (the local is the header), never an owner. [MILO-O-viewVar]
      const inner = t.tag === "ref" ? t.inner : t;
      const want = inner.tag === "array" && inner.size === null ? `!milo.vecval<${this.lent(inner, "let").slice(10, -1)}>` : this.value(inner, "let");
      const v = this.scoped(() => this.expr(value));
      if (v.ty !== want || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("`&T` var of a value it would own");
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${want}>`);
      this.emit(`milo.store ${v.ref}, ${ref} init : !milo.ref<${want}>`);
      this.bind(name, { kind: "var", ref, ty: want, view: true });
      return false;
    }
    if ((t.tag === "ref" || slice) && !mutable) {
      // A `&T` or slice let (`let base = s[0..end]`): a view of what it is taken from,
      // never an owner, so bound as it is: a place as that place, a view as its SSA value.
      const p = this.fieldPlace(value);
      if (p) { this.bind(name, { kind: "var", ref: p.ref, ty: p.ty, param: p.param }); return false; }
      const v = this.scoped(() => this.expr(value));
      const inner = t.tag === "ref" ? t.inner : t;
      const want = inner.tag === "array" && inner.size === null ? `!milo.vecval<${this.lent(inner, "let").slice(10, -1)}>` : this.value(inner, "let");
      if (v.ty !== want || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("`&T` let of a value it would own");
      this.bind(name, { kind: "ssa", v });
      return false;
    }
    const ty = this.value(t, "let");
    // The value's temporaries die at the end of the statement; the binding's slot is the block's.
    const v = this.scoped(() => this.operand(value, ty, "let"));
    if (this.hasDrop(ty)) {
      const slot = this.ownedSlot(name, ty, t);
      this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${ty}>`);
      this.bind(name, { kind: "var", ref: slot, ty, owned: true });
      this.debugVar(name, slot, ty, t);
      return false;
    }
    if (!mutable) { this.bind(name, { kind: "ssa", v }); this.debugValue(name, v.ref, v.ty, t); return false; }
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(name)} : !milo.ref<${ty}>`);
    this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${ty}>`);
    this.bind(name, { kind: "var", ref, ty });
    this.debugVar(name, ref, ty, t);
    return false;
  }

  /** `target = value`. `isInit`: a module global's first fill, whose slot holds zeroes, nothing to drop. */
  private assign(target: X, value: X, isInit: boolean, span?: Span): boolean {
    const tf = this.f(target);
    const tt = this.ty(target);
    if (isInit && (tf.kind !== "Ident" || !this.isGlobal(tf.name))) throw new MlirUnsupported("init assign");
    // The value first, then the place.
    if (tf.kind === "IndexAccess" || tf.kind === "FieldAccess" || tf.kind === "PtrDeref" || tf.kind === "HeapDeref") {
      const big = placeType(this.cx, tt);
      if (big !== null && valueType(this.cx, tt) === null) {
        // A 128+ byte one: the value into a place of its own first (or a
        // local's slot), then copied. Through a pointer nothing is dropped.
        const src = this.bigPlace(value, big) ?? (() => {
          const sl = this.bigSlot("tmp", value, true);
          return { ref: sl.ref, refTy: `!milo.ref<${big}>`, done: () => { if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${big}>`, big); } };
        })();
        const pp = this.ptrPlace(tf);
        if (pp) {
          if (pp.ty !== big) throw new MlirUnsupported("128+ byte store of another type");
          this.emit(`milo.copy ${src.ref}, ${pp.ptr} : ${src.refTy}, ${PTR} of ${big}`);
          src.done();
          return false;
        }
        // Over a field or an element of a place, which always holds a value: the old
        // one dropped, then the new one copied in (eval, drop, memcpy).
        const dst = tf.kind === "IndexAccess" ? this.elemRef(tf) : tf.kind === "FieldAccess" ? this.fieldPlace(tf)
          : tf.kind === "HeapDeref" ? this.heapPlace(tf) : null;
        if (!dst || dst.ty !== big) throw new MlirUnsupported("128+ byte store other than through a pointer");
        this.overwriteBig(dst.ref, big, tt, src, false);
        return false;
      }
      // Through a raw pointer: the value is stored as is, nothing is dropped (unsafe).
      const v = this.consume(this.expr(value), "store through a pointer");
      const pp = this.ptrPlace(tf);
      if (pp) {
        // A generic body sees an owning fn T as plain behind a `*T` (`data[len] = x` in
        // Vec<T>.push): the bits go to memory that the glue for the pointee frees
        // the same way, so the value is cast (fnAs's `leak`).
        this.emit(`milo.ptr.store ${this.take(v, pp.ty, "store through a pointer", true).ref}, ${pp.ptr} : ${pp.ty}`);
        return false;
      }
      if (tf.kind === "PtrDeref") throw new MlirUnsupported("store through a pointer of another type");
      if (tf.kind === "FieldAccess" || tf.kind === "HeapDeref") {
        const p = this.fieldPlace(tf);
        if (!p) throw new MlirUnsupported("assign to a field of a value");
        // milo-scope-drops drops the old value before the store (a box's `*h` too, as
        // the glue for the pointee must exist.
        if (this.hasDrop(p.ty)) this.dropGlue(p.ty, tt);
        this.emit(`milo.store ${this.take(v, p.ty, "field store").ref}, ${p.ref} : !milo.ref<${p.ty}>`);
        return false;
      }
      const er = this.elemRef(tf);
      if (er) {
        // milo-scope-drops drops the old element before the store.
        if (this.hasDrop(er.ty)) this.dropGlue(er.ty, tt);
        this.emit(`milo.store ${this.take(v, er.ty, "element store").ref}, ${er.ref} : !milo.ref<${er.ty}>`);
        return false;
      }
      const { vec, elem, index } = this.indexPlace(tf);
      this.emit(`milo.index.store ${this.take(v, elem, "element store").ref}, ${vec}[${index}] : ${elem}, !milo.vec<${elem}> ${this.loc(tf.span)}`);
      return false;
    }
    if (tf.kind !== "Ident") throw new MlirUnsupported(`assign to ${tf.kind}`);
    const found = this.lookup(tf.name);
    // `v = w` on a `&mut Vec` param (the checker allows no other Vec binding here):
    // a store into the caller's slot behind the header, the old Vec dropped first.
    const b = found.kind === "vec" && found.param !== undefined
      ? { kind: "var" as const, ...this.lendAs(found.ref, `!milo.vec<${found.elem}>`, `!milo.ref<!milo.vecval<${found.elem}>>`), ty: `!milo.vecval<${found.elem}>` }
      : found;
    if (b.kind !== "var") throw new MlirUnsupported("assign to an immutable binding");
    // A lazy global of a place-only type (`let NAMES: [string; 3] = [...]`) is built
    // in place for its first fill.
    if (isInit && inSlot(this.cx, b.ty)) { this.scoped(() => { this.into(value, b.ref, b.ty); return { ref: "", ty: "" }; }); return false; }
    if (inSlot(this.cx, b.ty)) {
      if (this.lvalueSame(value, target)) return false;
      const src = this.bigPlace(value, b.ty) ?? (() => {
        const sl = this.bigSlot("tmp", value, true);
        return { ref: sl.ref, refTy: `!milo.ref<${b.ty}>`, done: () => { if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${b.ty}>`, b.ty); } };
      })();
      this.overwriteBig(b.ref, b.ty, tt, src, !!b.owned);
      return false;
    }
    if (b.view) {
      const v = this.expr(value);
      if (v.ty !== b.ty || (v.own !== "view" && this.hasDrop(v.ty))) throw new MlirUnsupported("assignment of an owned value to a view var");
      this.emit(`milo.store ${v.ref}, ${b.ref} init : !milo.ref<${b.ty}>`);
      return false;
    }
    // The old value's drop is milo-scope-drops' business: it goes before the store.
    const v = this.operand(value, b.ty, "assignment");
    if (this.hasDrop(b.ty) && !isInit) this.dropGlue(b.ty, tt);
    this.emit(`milo.store ${v.ref}, ${b.ref}${isInit ? " init" : ""} : !milo.ref<${b.ty}>`);
    void span;
    return false;
  }

  private returnStmt(value: Expr | null, span?: Span): boolean {
    if (this.sretOut && value) {
      this.into(value, this.sretOut.ref, this.sretOut.ty);
      this.ret("milo.return", { kind: "var", ref: this.sretOut.ref, ty: this.sretOut.ty });
      return true;
    }
    if (!value && this.isMain) { this.retMain(); return true; }
    if (!value) { this.ret("milo.return"); return true; }
    if (this.ty(value).tag === "void" && this.retTy === null && !this.isMain) {
      // `return f()` of a void f, an expression-bodied `(): void => f()`: the call as
      // a statement, then the return.
      if (this.stmt({ kind: "ExprStmt", expr: value, span })) return true;
      this.ret("milo.return");
      return true;
    }
    // A place-only result returned by value (an array, a struct holding one, under 128
    // bytes so not sret): loaded whole from its place at the return (the ABI).
    if (this.retView) {
      const v = this.expr(value);
      if (v.ty !== this.retView || (v.own === "owned" && !this.keyBody)) throw new MlirUnsupported("returned view that is an owned value or of another type");
      this.ret(`milo.return ${v.ref} : ${v.ty}`, { kind: "ssa", v });
      return true;
    }
    // Returned as a plain `(T) => R`: a plain fn value is Copy and owns nothing. The checker
    // rejects an env-owning closure here (plain-closure-env), so what reaches this is a
    // capture-free closure with a null env; fnAs's `leak` casts it. [MILO-O-returnedPlainClosure]
    const plainFn = this.retTy!.startsWith("!milo.fn<") && !this.retTy!.startsWith("!milo.fn<owning ");
    const v = plainFn ? this.take(this.expr(value), this.retTy!, "return", true) : this.operand(value, this.retTy!, "return", this.retPlaceOnly);
    this.ret(`milo.return ${v.ref} : ${v.ty}`, { kind: "ssa", v: { ...v, own: v.own === "owned" ? "view" : v.own } });
    return true;
  }

  private exprStmt(x: X, span?: Span): boolean {
    const e = this.f(x);
    const t = this.ty(e);
    // A discarded 128+ byte value that is built in place (`into`: an sret call, replace,
    // `?`, `??`, `!`) goes to a temporary dropped at the statement's end.
    const built = e.kind === "MemReplace" || e.kind === "Propagate" || e.kind === "DefaultValue" || e.kind === "Unwrap" ||
      // A user fn's big result comes back through the ABI (not sret): into stores it in the temporary.
      (e.kind === "Call" && !this.cx.isBuiltinName(e.func)) || e.kind === "ClosureCall" ||
      ((e.kind === "MatchExpr" || e.kind === "IfExpr") && (this.fx.rawTypeOf(this.fx.ast(e.node)) ?? t).tag !== "never");
    if (this.isSretCall(e) || (built && t.tag !== "void" && inSlot(this.cx, this.place$(t, "discarded value")))) { this.bigSlot("tmp", e, true); return false; }
    // An if or a match whose value nobody takes (void, or never: every arm jumps) is the
    // statement, whose arms may end in a jump.
    const raw = this.fx.rawTypeOf(this.fx.ast(e.node)) ?? t;
    const valueless = t.tag === "void" || raw.tag === "never";
    if (e.kind === "IfExpr" && valueless) {
      if (e.folded) {
        this.region(`milo.if ${this.constTrue()} {`, () => this.stmts(e.thenBody));
        this.emit("}");
        return false;
      }
      return this.ifStmt(e.cond, () => this.stmts(e.thenBody), () => this.stmts(e.elseBody));
    }
    if (e.kind === "MatchExpr" && valueless) return this.match(this.matchOf(e), null).done;
    if (this.diverges(e)) {
      // `exit(…)` and friends do not return: the path ends here, as for a jump.
      this.expr(e, true);
      this.emit("milo.unreachable");
      return true;
    }
    const v = this.expr(e, true);
    if (v.ty && this.runsUserDrop(v.ty) && v.own === "owned") {
      // A result nobody takes runs its user Drop at the end of the statement, as
      // it is dropped: a slot of a block of its own, closed right here.
      this.owned.push([]);
      const start = this.body.length;
      const slot = this.ownedSlot("discarded", v.ty, t);
      this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
      this.closeScope(start, false, null);
      return false;
    }
    // A result nobody takes still has an owner until the block ends.
    if (v.ty) this.borrow(v, t);
    void span;
    return false;
  }

  /** A match form's arms with their patterns read. */
  private matchOf(e: FormOf<"MatchExpr">): MatchIn {
    return {
      subject: e.subject, subjectIsRef: e.subjectIsRef, subjectIsMut: e.subjectIsMut,
      arms: e.arms.map(a => ({ pattern: (a as { pat?: Pat }).pat ?? this.fx.pattern(a.pattern, e.enumName), body: a.body })),
    };
  }

  /** A for-in, as the loop its iterable makes it (the checker classified the iterable). */
  private forIn(s: Stmt & { kind: "ForInStmt" }): boolean {
    const c = this.fx.c;
    const invariants = s.invariants ?? [];
    if (s.iterable.kind === "RangeExpr") {
      return this.forRange({ varName: s.varName, varType: this.fx.typeOf(s.iterable) ?? { tag: "int", bits: 64, signed: true }, start: s.iterable.start, end: s.iterable.end, body: s.body, invariants, span: s.span });
    }
    const view = c.stringViewForIns?.get(s);
    if (view && s.iterable.kind === "MethodCall") {
      return this.forStrView({ varName: s.varName, varName2: s.varName2, src: s.iterable.object, sep: view.mode === "split" ? s.iterable.args[0] ?? null : null, mode: view.mode, body: s.body, invariants, span: s.span });
    }
    const iter = c.iteratorForIns?.get(s);
    if (iter) return this.forIterator({ varName: s.varName, varType: iter.elemType, iterable: s.iterable, nextMethod: iter.nextMethod, optionEnumName: iter.optionEnumName, body: s.body, invariants, span: s.span });
    let it = this.ty(s.iterable);
    // `@iter` field: the loop walks `wrapper.field`, an ordinary Vec/HashMap/array/string
    // for-in from here on.
    const delegate = c.iterDelegates.get(s);
    let iterable: X = s.iterable;
    if (delegate) {
      const st = it.tag === "ref" ? it.inner : it;
      const fieldType = (st.tag === "struct" ? c.structs.get(st.name)?.fields.find(f => f.name === delegate)?.type : undefined) ?? { tag: "unknown" as const };
      iterable = this.syn(fieldType, n => ({ kind: "FieldAccess", node: n, span: s.span, object: s.iterable, field: delegate }));
      it = fieldType;
    }
    // Slices (`&[T]`) and `&Vec` iterate like Vecs: the same non-owning header.
    if (it.tag === "ref" && (it.inner.tag === "array" || it.inner.tag === "vec")) it = it.inner;
    if (it.tag === "array" && it.size === null) it = { tag: "vec", element: it.element };
    const i64: TypeKind = { tag: "int", bits: 64, signed: true };
    // Only a real Vec/array is consumed (MILO-O-consumedForIn); every other loop binds a view.
    const consume = c.consumingForIns.has(s) && (it.tag === "vec" || it.tag === "array");
    const elemBind = (el: TypeKind): TypeKind => consume ? el : { tag: "ref", inner: el, mutable: !!s.mutRef };
    let kind: ForEachS["iterableKind"], varType: TypeKind, varType2: TypeKind | null = null;
    if (it.tag === "vec" || it.tag === "array") {
      kind = it.tag;
      if (s.varName2) { varType = i64; varType2 = elemBind(it.element); } else varType = elemBind(it.element);
    } else if (it.tag === "string") {
      kind = "string";
      const u8: TypeKind = { tag: "int", bits: 8, signed: false };
      if (s.varName2) { varType = i64; varType2 = u8; } else varType = u8;
    } else if (it.tag === "hashmap") {
      kind = "hashmap";
      varType = { tag: "ref", inner: it.key, mutable: false };
      varType2 = { tag: "ref", inner: it.value, mutable: false };
    } else { kind = "vec"; varType = { tag: "unknown" }; }
    return this.forEach({ varName: s.varName, varName2: s.varName2, varType, varType2, iterable, iterableKind: kind, consume, body: s.body, invariants, span: s.span });
  }

  /**
   * `for x in v` over a Vec place, a slice or a string: milo.for_in (lowered by
   * milo-desugar, E-FOR-IN), the element bound by place when it is one or the loop writes
   * it (`&mut`), else as the value read at the top of each iteration (a view, which the
   * checker lets nothing invalidate while the loop borrows the Vec).
   */
  private forEach(s: ForEachS): boolean {
    if (s.consume && s.iterableKind === "vec") return this.consumedForEach(s);
    // A slice is a Vec header: borrowed and walked as a Vec is.
    const it = stripRefs(this.ty(s.iterable));
    const slice = s.iterableKind === "array" && it.tag === "array" && it.size === null;
    if (s.iterableKind === "array" && !slice) return this.arrayForEach(s);
    if (s.iterableKind === "hashmap" && !s.consume) return this.mapForEach(s);
    if ((s.iterableKind !== "vec" && s.iterableKind !== "string" && !slice) || s.consume) throw new MlirUnsupported(`for over a ${s.consume ? "consumed " : ""}${s.iterableKind}`);
    const elemKind = s.varName2 ? s.varType2! : s.varType;
    const mutElem = elemKind.tag === "ref" && elemKind.mutable;
    if (mutElem && s.iterableKind === "string") throw new MlirUnsupported("for over &mut string bytes");
    let src: string, srcTy: string, xTy: string, byPlace = false;
    if (s.iterableKind === "string") {
      const v = this.borrow(this.expr(s.iterable), this.ty(s.iterable));
      if (v.ty !== STR || valueType(this.cx, stripRefs(elemKind)) !== "ui8") throw new MlirUnsupported("for over a string of another element type");
      src = v.ref; srcTy = STR; xTy = "ui8";
    } else {
      const { place, elem } = this.vecPlace(s.iterable);
      // A place-only element (128+ bytes, an array) is bound as its place, never loaded.
      // So is one holding an array, even when small enough to be a value elsewhere.
      byPlace = (mutElem || valueType(this.cx, stripRefs(elemKind)) === null || inSlot(this.cx, elem)) && placeType(this.cx, stripRefs(elemKind)) === elem;
      if (mutElem && !byPlace) throw new MlirUnsupported("for over &mut elements of another type");
      if (!byPlace && (inSlot(this.cx, elem) || valueType(this.cx, stripRefs(elemKind)) !== elem)) throw new MlirUnsupported("for element type");
      src = place; srcTy = `!milo.vec<${elem}>`; xTy = byPlace ? `!milo.ref<${elem}>` : elem;
    }
    const i = this.fresh(), x = this.fresh();
    this.loops++; this.loopBase.push(this.pending.length);
    this.region(`milo.for_in ${src} : ${srcTy} {`, () => {
      this.emit(`^bb0(${i}: si64, ${x}: ${xTy}):`);
      if (byPlace) this.bind(s.varName2 ?? s.varName, { kind: "var", ref: x, ty: xTy.slice(10, -1) });
      else this.bind(s.varName2 ?? s.varName, { kind: "ssa", v: { ref: x, ty: xTy, own: this.hasDrop(xTy) ? "view" : undefined } });
      if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: i, ty: "si64" } });
      return this.loopBody(s.body, s.invariants);
    });
    this.emit(`} ${this.loc(s.span)}`);
    this.loops--; this.loopBase.pop();
    return false;
  }

  /** `for i in a..b`: milo.for, its bounds widened to the variable's type. */
  private forRange(s: { varName: string; varType: TypeKind; start: Expr; end: Expr; body: Stmt[]; invariants: Contract[]; span?: Span }): boolean {
    const ty = scalar(s.varType, "for var");
    if (ty === "i1" || ty === PTR || ty.startsWith("f")) throw new MlirUnsupported("for over a non-int");
    // A narrower bound is extended by the bound's own signedness (a u8 bound of an i32
    // loop is zero extended: 200 stays 200), to the loop variable's width and then
    // reinterpreted as the loop variable's type. A same-width bound of the other
    // signedness keeps its bits.
    const widen = (v: Val): Val => {
      if (v.ty === ty) return v;
      const vm = /^([su])i(\d+)$/.exec(v.ty), tm = /^([su])i(\d+)$/.exec(ty)!;
      if (!vm || Number(vm[2]) > Number(tm[2])) throw new MlirUnsupported("for bound of a different type");
      const wide = `${vm[1]}i${tm[2]}`;
      const r = wide === v.ty ? v : this.def(`milo.cast ${v.ref} : ${v.ty} to ${wide}`, wide);
      return wide === ty ? r : this.def(`milo.cast ${r.ref} : ${wide} to ${ty}`, ty);
    };
    const start = widen(this.expr(s.start));
    const end = widen(this.expr(s.end));
    const iv = this.fresh();
    this.loops++; this.loopBase.push(this.pending.length);
    this.region(`milo.for ${start.ref} to ${end.ref} : ${ty} {`, () => {
      this.emit(`^bb0(${iv}: ${ty}):`);
      this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty } });
      return this.loopBody(s.body, s.invariants);
    });
    this.emit("}");
    this.loops--; this.loopBase.pop();
    return false;
  }

  /**
   * `for x in makeVec()`: the loop owns the Vec. It lives in a [MILO-O-consumedForIn]
   * vectail slot of a block around the loop, and each iteration moves its element out into
   * the binding (an owned slot of the body when it has drop glue) and moves the cursor past
   * it, so whichever way control leaves, the slot's drop frees exactly the elements no
   * iteration took, then the buffer, after the binding's drop.
   */
  /**
   * `h.m(args)` through a `Heap<I>` or a `&I`: itable dispatch in a
   * helper per interface, method and operand shape, the box lent by its place. Arguments
   * are scalars by value or places lent as the callee's `&T`; a string result is owned.
   */
  private dynCall(e: FormOf<"InterfaceMethodCall">): Val {
    const ot = stripRefs(this.ty(e.object));
    // A borrowed interface (`g: &Greeter`) is the same `{ data, itable }` pair in its place.
    if ((ot.tag !== "heap" || ot.inner.tag !== "interface") && ot.tag !== "interface") throw new MlirUnsupported("interface call on a non-interface");
    const dty = this.place$(ot, "interface box");
    // Dispatch only reads { data, itable }: a named or indexed receiver is lent where it is,
    // an SSA view of one (`for s in shapes`) spilled to a slot nothing drops (place).
    const k = this.k(e.object);
    if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess") throw new MlirUnsupported("interface call on a temporary box");
    const p = this.place(e.object, `!milo.ref<${dty}>`, false);
    const ops: { name: string; type: TypeKind; mode: "val" | "ref" | "mut"; ref: string }[] = [{ name: "o", type: ot, mode: "ref", ref: p.ref }];
    const mark = this.pending.length;
    e.args.forEach((a, k) => {
      const t = stripRefs(this.ty(a.expr));
      if (a.passByRef) {
        ops.push({ name: `a${k}`, type: t, mode: a.refMut ? "mut" : "ref", ref: this.place(a.expr, this.lent(t, "interface call operand"), a.refMut).ref });
        return;
      }
      const { v, type } = this.helperOperand(a.expr, "interface call argument");
      ops.push({ name: `a${k}`, type, mode: "val", ref: v.ref });
    });
    this.pending.length = mark;
    const ret = this.ty(e.node).tag === "void" ? null : this.value(this.ty(e.node), "interface call result");
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && ret !== STR) throw new MlirUnsupported("interface call result type");
    // Itable dispatch: data and itable from the pair, the
    // method from itable[i], called with data first and each `&T` as its address, after
    // the alias guard over the by-ref arguments (a `&mut` one must
    // not alias another).
    {
      const refs = ops.slice(1).filter(o => o.mode !== "val").map(o => ({ ref: o.ref, mut: o.mode === "mut", ty: this.lent(o.type, "interface call operand") }));
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
          this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
        }
      }
      const pa = this.addressOf(p.ref, `!milo.ref<${dty}>`).ref;
      const data = this.def(`milo.ptr.load ${pa} : ${PTR}`, PTR);
      const it = this.def(`milo.ptr.load ${this.def(`milo.ptr.elem ${pa}[${this.def("milo.const 1 : si64", "si64").ref}] : ${PTR}`, PTR).ref} : ${PTR}`, PTR);
      const fn = this.def(`milo.ptr.load ${this.def(`milo.ptr.elem ${it.ref}[${this.def(`milo.const ${e.methodIndex} : si64`, "si64").ref}] : ${PTR}`, PTR).ref} : ${PTR}`, PTR);
      const args = [data, ...ops.slice(1).map(o => o.mode !== "val"
        ? this.addressOf(o.ref, this.lent(o.type, "interface call operand"))
        : { ref: o.ref, ty: valueType(this.cx, o.type)! })];
      const call = `milo.call_ptr ${fn.ref}(${args.map(a => a.ref).join(", ")}) : (${args.map(a => a.ty).join(", ")}) -> ${ret ?? "()"}`;
      if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
      const r = this.def(call, ret);
      return ret === STR ? { ...r, own: "owned" } : r;
    }
  }

  /**
   * `f as *u8`: a named function's own symbol, not a trampoline, and any
   * other fn value's code pointer, its first word.
   */
  private fnAddress(e: FormOf<"Cast">): Val {
    const op = this.f(e.operand);
    const named = op.kind === "Ident" && !this.scopes.some(m => m.has(op.name)) && this.cx.fnSigs.has(op.name);
    if (named) {
      // Every Milo function is defined in the module; an extern is a C symbol MLIR does not
      // declare, so its address stays out (no Milo program takes one yet).
      if (!this.fns.get(op.name) || this.fns.get(op.name)!.isExtern) throw new MlirUnsupported("address of an extern fn");
      return this.def(`milo.fn.addr @${quote(op.name)}`, PTR);
    }
    const v = this.expr(op);
    if (v.own === "owned") throw new MlirUnsupported("cast of an owning fn temporary");
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "fn.addr" : !milo.ref<${v.ty}>`);
    this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
    return this.def(`milo.ptr.load ${this.def(`milo.addr ${slot} : !milo.ref<${v.ty}>`, PTR).ref} : ${PTR}`, PTR);
  }

  /**
   * `for k, v in m` over a HashMap place, data and cap read once from
   * the header ({ ptr data, i64 len, i64 cap, i64 seed, i64 tombs }), then every slot
   * ({ i8 state, K, V }) whose state is 1 (occupied). k and v are bound to the slot's
   * places; here each is a bit copy in a slot of its own that owns nothing (a view): the
   * checker lets nothing write the map while the loop borrows it, so the copy reads the
   * same, and a place behind a pointer is never a milo.ref (see ptr.elem).
   */
  private mapForEach(s: ForEachS): boolean {
    const mt = stripRefs(this.ty(s.iterable));
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
      // %HashMap names the header; a slot is addressed by bytes (it is a
      // literal struct, which no !milo.struct name could spell).
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
          jumped = this.loopBody(s.body, s.invariants);
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
   * `for v in s.lines()` / `s.splitView(sep)`: each step
   * (runtime milo.strview.step) finds the next piece and writes it, a view into s's buffer
   * that nothing drops, to the binding's slot. The step runs in the condition, so a
   * `continue` cannot skip it; the enumerate index counts up from -1 at the top of the body.
   */
  private forStrView(s: { varName: string; varName2: string | null; src: Expr; sep: Expr | null; mode: "lines" | "split"; body: Stmt[]; invariants: Contract[]; span?: Span }): boolean {
    const placeOf = (x: X, what: string) => {
      const k = this.k(x);
      if (k !== "Ident" && k !== "FieldAccess" && k !== "StringLit") throw new MlirUnsupported(`${what} of a for over string pieces that is not a place`);
      return this.place(x, refOf(STR), false).ref;
    };
    const src = placeOf(s.src, "source");
    const sep = placeOf(s.mode === "split" && s.sep ? s.sep : this.fx.syn({ kind: "StringLit", value: "\n" }, { tag: "string" }), "separator");
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
        return this.loopBody(s.body, s.invariants);
      });
    } finally { this.scopes.pop(); }
    this.emit("}");
    this.loops--; this.loopBase.pop();
    return false;
  }

  /**
   * `for x in [a, b]` consumed, of elements with a user Drop: the array is built in an
   * arraytail slot (the consumed iterable with its cursor), each iteration moves one
   * element into the binding (dropped at the iteration's end), and the slot's drop glue drops
   * the elements no iteration took, however the loop ends. [MILO-O-consumedForIn]
   */
  private consumedArrayForEach(s: ForEachS, at: TypeKind & { tag: "array" }, aty: string, ety: string): boolean {
    const byPlace = valueType(this.cx, at.element) === null;
    const tailTy = `!milo.arraytail<${aty}>`;
    this.owned.push([]);
    const start = this.body.length;
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "for.arr" owned : !milo.ref<${tailTy}>`);
    this.owned[this.owned.length - 1].push({ ref: slot, ty: tailTy });
    this.glue.tailDrop(at);
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
      return this.loopBody(s.body, s.invariants);
    });
    this.emit("}");
    this.loops--; this.loopBase.pop();
    this.closeScope(start, false, null);
    return false;
  }

  private arrayForEach(s: ForEachS): boolean {
    /**
     * `for x in arr` over a fixed array:
     * a consumed one (`for i in [0, 1, 5]`, a call) evaluated into a slot first, a place
     * borrowed where it is; the binding is the element's place, which nothing writes while
     * the loop runs, so reading it at each use is reading that copy.
     */
    const at = stripRefs(this.ty(s.iterable));
    const elemKind = s.varName2 ? s.varType2! : s.varType;
    if (at.tag !== "array" || at.size === null) throw new MlirUnsupported("for over a slice");
    const aty = this.place$(at, "for array");
    const ety = this.place$(at.element, "for element");
    if (placeType(this.cx, stripRefs(elemKind)) !== ety) throw new MlirUnsupported("for element type");
    // Each element of a consumed array is moved into the binding and dropped at the
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
      // milo.for_in over the array's place (E-FOR-IN), each element bound as its place.
      const iv = this.fresh(), r = this.fresh();
      this.loops++; this.loopBase.push(this.pending.length);
      this.region(`milo.for_in ${arr} : !milo.ref<${aty}> {`, () => {
        this.emit(`^bb0(${iv}: si64, ${r}: !milo.ref<${ety}>):`);
        this.bind(s.varName2 ?? s.varName, s.consume ? { kind: "var", ref: r, ty: ety, zeroOnMove: true } : { kind: "var", ref: r, ty: ety });
        if (s.varName2) this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty: "si64" } });
        return this.loopBody(s.body, s.invariants);
      });
      this.emit(`} ${this.loc(s.span)}`);
      this.loops--; this.loopBase.pop();
      this.closeScope(scopeStart, false, null);
      return false;
    } finally { this.scopes.pop(); this.blocks.pop(); }
  }

  private consumedForEach(s: ForEachS): boolean {
    const vt = stripRefs(this.ty(s.iterable));
    const elemKind = stripRefs(s.varName2 ? s.varType2! : s.varType);
    if (vt.tag !== "vec") throw new MlirUnsupported("for over a consumed vec of another type");
    const elem = placeType(this.cx, elemKind);
    if (elem === null || elem !== placeType(this.cx, vt.element)) throw new MlirUnsupported("for over a consumed vec of another element type");
    // A place-only element is copied out of its place into the binding's slot,
    // the element is memcpy'd into it.
    const byPlace = valueType(this.cx, elemKind) === null;
    const vecTy = `!milo.vecval<${elem}>`, tailTy = `!milo.vectail<${elem}>`;
    this.owned.push([]);
    const start = this.body.length;
    const v = this.consume(this.expr(s.iterable), "consumed for-in");
    if (v.ty !== vecTy) throw new MlirUnsupported("for over a consumed vec of another type");
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "for.vec" owned : !milo.ref<${tailTy}>`);
    this.owned[this.owned.length - 1].push({ ref: slot, ty: tailTy });
    this.glue.tailDrop(vt);
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
        return this.loopBody(s.body, s.invariants);
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
      return this.loopBody(s.body, s.invariants);
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
  private expr(x: X, stmt = false): Val { const e = this.f(x); return this.at(e.span, () => this.exprAt(e, stmt)); }

  private exprAt(x: X, stmt: boolean): Val {
    const e = this.f(x);
    switch (e.kind) {
      case "IntLit":
      case "CharLit": {
        const ty = scalar(this.ty(e.node), e.kind);
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
        if (this.k(e.str) === "StringLit") return this.expr(e.str);
        let p = this.fieldPlace(e.str);
        if (!p) {
          // A temporary is its own copy; a view (a string field of
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
        return { ...this.def(`milo.string.share ${p.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      }
      case "InterfaceMethodCall": return this.dynCall(e);
      case "StringSlice": {
        // `s[a..b]`: a `&string` view into s's buffer (data and len, nothing owned),
        // range-checked. Only a place's string, which
        // outlives the view; never a temporary.
        if (this.k(e.str) !== "Ident" && this.k(e.str) !== "FieldAccess") throw new MlirUnsupported("slice of a temporary string");
        const s = this.place(e.str, refOf(STR), false).ref;
        const a = this.expr(e.start), b = this.expr(e.end);
        if (!isScalarTy(a.ty) || !isScalarTy(b.ty)) throw new MlirUnsupported("slice bound type");
        const lo = this.widenBound(a), hi = this.widenBound(b);
        if (lo.ty !== "si64" || hi.ty !== "si64") throw new MlirUnsupported("slice bound type");
        const sv = this.def(`milo.load ${s} : !milo.ref<${STR}>`, STR);
        this.rangeCheck("slice", lo, hi, this.def(`milo.string.len ${sv.ref}`, "si64"), e.span);
        const data = this.def(`milo.ptr.elem ${this.def(`milo.string.data ${sv.ref}`, PTR).ref}[${lo.ref}] : ui8`, PTR);
        const r = this.makeView(STR, data, this.def(`milo.sub ${hi.ref}, ${lo.ref} wrapping : si64`, "si64"));
        return { ...r, own: "view" };
      }
      case "StringLen": return this.peek(e.object, v => {
        if (v.ty !== STR) throw new MlirUnsupported("len of a non-string");
        return this.def(`milo.string.len ${v.ref}`, "si64");
      });
      case "VecNew": {
        const ty = this.value(this.ty(e.node), "Vec");
        return { ...this.def(`milo.vec.new : ${ty}`, ty), own: "owned" };
      }
      case "FloatLit": {
        const ty = scalar(this.ty(e.node), "FloatLit");
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
        if (this.ty(e.node).tag === "fn" && this.fns.has(e.name) && !this.scopes.some(m => m.has(e.name)) && !this.cx.mlirGlobal(e.name)) {
          // A named fn as a value: the capture-free closure `(a, b) => f(a, b)` (the
          // trampoline: the closure convention, a null env).
          const ft = this.ty(e.node) as TypeKind & { tag: "fn" };
          const callee = this.fns.get(e.name)!;
          const params = ft.params.map((t, i) => ({ name: `fnval$${i}`, type: t }));
          const args = params.map((p, i) => this.arg(this.synIdent(p.name, p.type, !callee.params[i]?.isRef && !callee.params[i]?.isRefMut),
            !!(callee.params[i]?.isRef || callee.params[i]?.isRefMut), !!callee.params[i]?.isRefMut));
          const call = this.syn(ft.ret, n => ({ kind: "Call", node: n, func: e.name, args, variadic: false }));
          const body: Stmt[] = ft.ret.tag === "void" ? [{ kind: "ExprStmt", expr: call }] : [{ kind: "Return", value: call }];
          return this.closure({ kind: "Closure", node: e.node, span: e.span, ast: undefined, params, body, captures: [], retType: ft.ret });
        }
        const b = this.lookup(e.name);
        if (b.kind === "ssa") return b.v;
        if (b.kind === "vec") throw new MlirUnsupported("a Vec as a value");
        if (b.kind === "var" && inSlot(this.cx, b.ty) && valueType(this.cx, this.ty(e.node)) !== b.ty) throw new MlirUnsupported("a 128+ byte aggregate as a value");
        if (!this.hasDrop(b.ty)) return this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
        // The checker marks the last use that takes the value; every other read borrows.
        if (!this.mv(e)) return { ...this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "view" };
        if (b.zeroOnMove || b.flag) {
          const v = this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
          // A flagged capture is skipped by its env's drop once the flag is clear.
          if (b.flag) this.emit(`milo.store ${this.def("milo.const false", "i1").ref}, ${b.flag} : !milo.ref<i1>`);
          else this.emit(`milo.store ${this.def(`milo.zero : ${b.ty}`, b.ty).ref}, ${b.ref} init : !milo.ref<${b.ty}>`);
          return { ...v, own: "owned" };
        }
        if (!b.owned) throw new MlirUnsupported("move out of a borrow");
        return { ...this.def(`milo.move ${b.ref} : !milo.ref<${b.ty}>`, b.ty), own: "owned" };
      }
      case "BinOp": return this.binop(e);
      case "UnaryOp": return this.unop(e);
      case "Cast": {
        if (this.ty(e.operand).tag === "array" && e.targetType.tag === "ptr") return this.decay(e.operand);
        if (stripRefs(this.ty(e.operand)).tag === "string" && e.targetType.tag === "ptr") {
          // `s as *u8`: the bytes, field 0 (no copy, no NUL).
          const v = this.borrow(this.expr(e.operand), this.ty(e.operand));
          if (v.ty !== STR) throw new MlirUnsupported("cast of a non-string");
          return this.def(`milo.string.data ${v.ref}`, PTR);
        }
        if (this.ty(e.operand).tag === "fn" && e.targetType.tag === "ptr") return this.fnAddress(e);
        if (stripRefs(this.ty(e.operand)).tag === "enum" && e.targetType.tag === "int") {
          // A repr'd enum's discriminant is its tag: a signed i32, then
          // sign-extended or truncated to the target.
          const to = scalar(e.targetType, "cast target");
          const tag = this.peek(e.operand, v => {
            if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("cast of a non-enum");
            return this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
          });
          return to === "si32" ? tag : this.def(`milo.cast ${tag.ref} : si32 to ${to}`, to);
        }
        const from = scalar(this.ty(e.operand), "cast source");
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
        if (stripRefs(this.ty(e.object)).tag === "string") {
          // A byte: object, index, bounds check.
          return this.peek(e.object, s => {
            const i = this.expr(e.index);
            if (s.ty !== STR || !/^[su]i\d+$/.test(i.ty) || scalar(this.ty(e.node), "string byte") !== "ui8") throw new MlirUnsupported("string index types");
            const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
            return this.def(`milo.string.byte ${s.ref}[${index}]`, "ui8", this.loc(e.span));
          });
        }
        const er = this.elemRef(e);
        if (er) {
          if (!isSsa(this.cx, er.ty)) throw new MlirUnsupported("a 128+ byte aggregate as a value");
          if (!this.hasDrop(er.ty)) return this.def(`milo.load ${er.ref} : !milo.ref<${er.ty}>`, er.ty);
          // An owning element is cloned: `v[i]` is always an
          // independent value, and the Vec keeps its own.
          return this.copyOut(e, er.ref, er.ty, true);
        }
        const { vec, elem, index } = this.indexPlace(e);
        return this.def(`milo.index ${vec}[${index}] : !milo.vec<${elem}> -> ${elem}`, elem, this.loc(e.span));
      }
      case "VecGrowBuf": {
        // std's _vecGrowBuf: len elements moved to a buffer of cap,
        // a runtime section; a failed allocation is reported here, at the push.
        const d = this.expr(e.data), l = this.expr(e.len), c = this.expr(e.cap);
        if (d.ty !== PTR || l.ty !== "si64" || c.ty !== "si64" || scalar(this.ty(e.node), "grown buffer") !== PTR) throw new MlirUnsupported("vec growth types");
        const es = this.cx.typeSizeOf(e.elementType);
        const size = this.def(`milo.const ${es} : si64`, "si64");
        const keep = this.def(`milo.mul ${l.ref}, ${size.ref} wrapping : si64`, "si64");
        return this.allocCheck(this.rtCall(this.cx.mlirVecGrow(es), [d, keep, c, size], PTR), e.span);
      }
      // std/string's intrinsics: runtime helpers (std/rt.milo) and range checks.
      case "StrReserve": {
        if (scalar(this.ty(e.node), "reserved buffer") !== PTR) throw new MlirUnsupported("string reserve type");
        const str = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const n = this.expr(e.extra);
        if (n.ty !== "si64") throw new MlirUnsupported("string reserve size type");
        return this.allocCheck(this.rtCall("rtStringReserve", [{ ref: str, ty: `!milo.ref<${STR}>` }, n], PTR), e.span);
      }
      case "StrAlloc": {
        if (scalar(this.ty(e.node), "string buffer") !== PTR) throw new MlirUnsupported("string alloc type");
        const n = this.expr(e.size);
        if (n.ty !== "si64") throw new MlirUnsupported("string alloc size type");
        return this.allocCheck(this.rtCall("rtStrAlloc", [n], PTR), e.span);
      }
      case "StrRangeCheck": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, false).ref;
        const a = this.expr(e.start), b = this.expr(e.end);
        if (a.ty !== "si64" || b.ty !== "si64") throw new MlirUnsupported("string range types");
        const len = this.def(`milo.string.len ${this.def(`milo.load ${str} : !milo.ref<${STR}>`, STR).ref}`, "si64");
        this.rangeCheck("substr", a, b, len, e.span);
        return { ref: "", ty: "" };
      }
      case "StrUnique": {
        const str = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        return this.rtCall("rtStrUnique", [{ ref: str, ty: `!milo.ref<${STR}>` }], null);
      }
      case "MapHash": {
        const kt = stripRefs(this.ty(e.key));
        const k = this.place(e.key, refOf(this.value(kt, "map key")), false).ref;
        const seed = this.expr(e.seed);
        if (seed.ty !== "si64") throw new MlirUnsupported("map seed type");
        if (scalar(this.ty(e.node), "map hash") !== "si64") throw new MlirUnsupported("map hash type");
        // FNV-1a from its offset basis xor the seed.
        const h0 = this.def(`milo.xor ${this.def("milo.const -3750763034362895579 : si64", "si64").ref}, ${seed.ref} : si64`, "si64");
        const kp = refOf(this.value(kt, "map key"));
        return this.rtCall(this.glue.hash(kt), [{ ref: k, ty: kp }, h0], "si64");
      }
      case "MapKeyEq":
      case "NatLess": {
        const kt = stripRefs(this.ty(e.a));
        const rt = refOf(this.value(kt, "compared key"));
        const a = this.place(e.a, rt, false).ref, b = this.place(e.b, rt, false).ref;
        if (scalar(this.ty(e.node), "comparison") !== "i1") throw new MlirUnsupported("comparison type");
        if (e.kind === "MapKeyEq") return this.rtCall(this.glue.eq(kt), [{ ref: a, ty: rt }, { ref: b, ty: rt }], "i1");
        // std's _natLess: min/max/sort's `a < b`: strings in byte
        // order, floats ordered (NaN is never less), ints by signedness, false < true.
        const ty = this.value(kt, "compared key");
        if (ty === STR) {
          const c = this.rtCall("rtStringCmp", [{ ref: a, ty: rt }, { ref: b, ty: rt }], "si32");
          return this.def(`milo.cmp lt, ${c.ref}, ${this.def("milo.const 0 : si32", "si32").ref} : si32`, "i1");
        }
        if (!isScalarTy(ty)) throw new MlirUnsupported(`ordering of ${ty}`);
        let x = this.def(`milo.load ${a} : ${rt}`, ty), y = this.def(`milo.load ${b} : ${rt}`, ty);
        if (ty === "i1") { x = this.def(`milo.cast ${x.ref} : i1 to ui8`, "ui8"); y = this.def(`milo.cast ${y.ref} : i1 to ui8`, "ui8"); }
        return this.def(`milo.cmp lt, ${x.ref}, ${y.ref} : ${x.ty}`, "i1");
      }
      case "MapSeed":
        if (scalar(this.ty(e.node), "map seed") !== "si64") throw new MlirUnsupported("map seed type");
        return this.rtCall("__milo_hash_seed", [], "si64");
      case "MapAlloc": {
        const n = this.expr(e.count), z = this.expr(e.size);
        if (n.ty !== "si64" || z.ty !== "si64") throw new MlirUnsupported("map alloc operand types");
        if (scalar(this.ty(e.node), "map buffer") !== PTR) throw new MlirUnsupported("map buffer type");
        return this.allocCheck(this.rtCall("rtMapAlloc", [n, z], PTR), e.span);
      }
      case "MapCopyOut": {
        // `_vecCopyOut(place)`: the structural deep copy of what the place holds
        // is an owned value.
        const ty = this.value(this.ty(e.node), "copied value");
        return this.copyOut(e, this.place(e.value, refOf(ty), false).ref, ty);
      }
      case "StringCstr": {
        // `s.cstr()`: the place's buffer made unique and NUL-terminated, then its bytes.
        if (scalar(this.ty(e.node), "cstr") !== PTR) throw new MlirUnsupported("cstr type");
        const str = this.place(e.object, `!milo.ref<${STR}>`, false).ref;
        // C may write through the bytes: a string owned outright here is made the only
        // handle to its buffer first (the helper sees only a reference).
        if (this.ownedLocal(e.object)) {
          this.rtCall("rtStrUnique", [{ ref: str, ty: `!milo.ref<${STR}>` }], null);
        }
        return this.def(`milo.string.data ${this.def(`milo.load ${str} : !milo.ref<${STR}>`, STR).ref}`, PTR);
      }
      case "NonNegative": {
        const v = this.expr(e.value);
        if (v.ty !== "si64" || scalar(this.ty(e.node), "checked size") !== "si64") throw new MlirUnsupported("non-negative check type");
        const neg = this.def(`milo.cmp lt, ${v.ref}, ${this.def("milo.const 0 : si64", "si64").ref} : si64`, "i1");
        this.panicIf(neg.ref, [`milo: negative ${e.what} at ${this.panicAt(e.span)}: `, "\n"], [v.ref]);
        return v;
      }
      case "NumberToString": {
        const v = this.expr(e.value);
        if (!isScalarTy(v.ty) || v.ty !== valueType(this.cx, e.valueType)) throw new MlirUnsupported("toString of a non-scalar");
        // A fresh empty string, the text appended to it, then taken out of the slot.
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var "tostring" : !milo.ref<${STR}>`);
        this.emit(`milo.store ${this.def(`milo.zero : ${STR}`, STR).ref}, ${slot} : !milo.ref<${STR}>`);
        this.pushScalar(slot, v, e.span);
        return { ...this.def(`milo.load ${slot} : !milo.ref<${STR}>`, STR), own: "owned" };
      }
      case "SizeOf":
        if (scalar(this.ty(e.node), "sizeOf") !== "si64") throw new MlirUnsupported("sizeOf type");
        return this.def(`milo.const ${this.cx.typeSizeOf(e.sizeType)} : si64`, "si64");
      case "VecPtr": {
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.vec.data ${place} : !milo.vec<${elem}>`, PTR);
      }
      case "WrappingArith": {
        // `a.wrappingAdd(b)`: two's complement, never a trap.
        const op = { add: "add", sub: "sub", mul: "mul" }[e.op];
        const ty = scalar(this.ty(e.node), "wrapping arithmetic");
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
        const oty = this.value(this.ty(e.node), "checked arithmetic result");
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
        // `swap(a, b)`: both read before either is written (they may [MILO-O-replaceSwap]
        // be the same element, `swap(v[i], v[j])`), nothing dropped. A 128+ byte one goes
        // through a scratch slot; copying a place onto itself is a no-op.
        const ty = this.place$(stripRefs(this.ty(e.a)), "swapped value");
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
        // `replace(&mut p, v)`: the old value read out (it is the [MILO-O-replaceSwap]
        // result's now), then `v` stored over it with nothing dropped.
        const ty = this.value(this.ty(e.node), "replaced value");
        // A place behind a raw pointer (`replace((*r).items, v)`) is read and written
        // through the pointer: the dialect has no milo.ref there.
        const pp = this.ptrPlace(e.place);
        if (pp && pp.ty !== ty) throw new MlirUnsupported("replace behind a pointer of another type");
        const p = pp ? "" : this.place(e.place, `!milo.ref<${ty}>`, true).ref;
        const old = { ...(pp ? this.def(`milo.ptr.load ${pp.ptr} : ${ty}`, ty) : this.def(`milo.load ${p} : !milo.ref<${ty}>`, ty)), own: this.hasDrop(ty) ? "owned" as const : undefined };
        // Until the store, the old value has two owners on paper: no jump may come between.
        const mark = this.pending.length;
        this.pend(old, this.ty(e.node), true);
        const v = this.operand(e.value, ty, "replacement");
        this.pending.length = mark;
        if (pp) this.emit(`milo.ptr.store ${v.ref}, ${pp.ptr} : ${ty}`);
        else this.emit(`milo.store ${v.ref}, ${p} init : !milo.ref<${ty}>`);
        return old;
      }
      case "HeapCreate": {
        const ty = this.value(this.ty(e.node), "box");
        if (ty.startsWith("!milo.dyn<")) throw new MlirUnsupported("box of an interface");
        const inner = /^!milo\.heap<(.*)>$/.exec(ty)![1];
        const v = this.operand(e.value, inner, "boxed value", !isSsa(this.cx, inner));
        return { ...this.def(`milo.heap.new ${v.ref} : ${inner} -> ${ty}`, ty), own: "owned" };
      }
      case "HeapDeref": {
        const op = this.f(e.operand);
        const temp = isTempBox(op);
        const ty = this.value(this.ty(e.node), "boxed value");
        const hty = `!milo.heap<${ty}>`;
        const payload = (h: string) => this.def(`milo.load ${this.def(`milo.heap.place ${h} : ${hty} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref} : !milo.ref<${ty}>`, ty);
        if (temp || (this.mv(e) && this.hasDrop(ty))) {
          // The payload out, the box freed with nothing dropped,
          // and a box held by a place left empty (an owned local's slot emptied, a field
          // set to null), so no drop of it ever runs on the leftover.
          const { h, after } = this.takeBox(op, hty);
          const v = payload(h);
          this.emit(`milo.heap.free ${h} : ${hty}`);
          after();
          return { ...v, own: this.hasDrop(ty) ? "owned" : undefined };
        }
        // A read leaves the box its payload: a bit copy that owns nothing.
        const p = this.heapPlace(e);
        const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
        if (!this.hasDrop(p.ty)) return v;
        if (this.mv(e)) throw new MlirUnsupported("move out of a box");
        this.bitCopies.add(v.ref);
        return { ...v, own: "view" };
      }
      case "HashMapLen": return this.peek(e.object, m => {
        if (!m.ty.startsWith("!milo.map<")) throw new MlirUnsupported("len of a non-map");
        return this.def(`milo.map.len ${m.ref} : ${m.ty}`, "si64");
      });
      case "ArrayLen": {
        // A fixed array's is its size, the object never evaluated; a
        // slice's is its header's.
        const ot = stripRefs(this.ty(e.object));
        if (scalar(this.ty(e.node), "array length") !== "si64") throw new MlirUnsupported("array length type");
        if (ot.tag === "array" && ot.size !== null) return this.def(`milo.const ${ot.size} : si64`, "si64");
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64");
      }
      case "VecSlice": {
        // `v[a..b]` of a Vec, a fixed array or a slice: range-checked,
        // a header into v's storage. A view: nothing owned.
        const vt = stripRefs(this.ty(e.vec));
        const lent = this.lent(vt, "sliced value");
        const k = this.k(e.vec), at = placeType(this.cx, this.ty(e.vec));
        let v: string;
        if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && at !== null && !isSsa(this.cx, at)) {
          // A temporary array (`total([a, b])`) lives until its block ends (tempSlot).
          const sl = this.bigSlot("slice.of", e.vec, true, true);
          v = this.lendAs(sl.ref, `!milo.ref<${sl.ty}>`, lent).ref;
        } else v = this.place(e.vec, lent, false).ref;
        // A narrower bound widens to i64 by its own signedness.
        const a = this.widenBound(this.expr(e.start)), b = this.widenBound(this.expr(e.end));
        const elem = this.place$(e.elementType, "slice element");
        if (a.ty !== "si64" || b.ty !== "si64" || vecElem(this.cx, stripRefs(this.ty(e.node))) !== elem) throw new MlirUnsupported("slice operand types");
        // A Vec's (or slice's) header gives data and len; a fixed array is its own storage.
        const header = lent.startsWith("!milo.vec<");
        if (!header && !(vt.tag === "array" && vt.size !== null)) throw new MlirUnsupported("slice of another place");
        const base = header ? this.def(`milo.vec.data ${v} : ${lent}`, PTR) : this.addressOf(v, lent);
        const len = header ? this.def(`milo.len ${v} : ${lent}`, "si64") : this.def(`milo.const ${(vt as { size: number }).size} : si64`, "si64");
        this.rangeCheck("slice", a, b, len, e.span);
        const data = this.def(`milo.ptr.elem ${base.ref}[${a.ref}] : ${elem}`, PTR);
        return this.makeView(`!milo.vecval<${elem}>`, data, this.def(`milo.sub ${b.ref}, ${a.ref} wrapping : si64`, "si64"));
      }
      case "CFnCall": {
        // A call through a C fn pointer (milo.call_ptr): scalar arguments and result only (a
        // struct by value would need the C ABI here).
        const f = this.expr(e.callee);
        if (f.ty !== PTR) throw new MlirUnsupported("C fn pointer of another type");
        const ops = [{ name: "f", type: this.ty(e.callee), mode: "val" as const, ref: f.ref }];
        e.args.forEach((a, k) => {
          if (a.passByRef) throw new MlirUnsupported("by-ref argument to a C fn pointer");
          const vt = valueType(this.cx, this.ty(a.expr));
          if (vt === null || !(isScalarTy(vt) || vt === PTR)) throw new MlirUnsupported("non-scalar argument to a C fn pointer");
          const v = this.expr(a.expr);
          if (v.ty !== vt) throw new MlirUnsupported("C fn pointer argument type");
          ops.push({ name: `a${k}`, type: this.ty(a.expr), mode: "val", ref: v.ref });
        });
        const ret = this.ty(e.node).tag === "void" ? null : scalar(this.ty(e.node), "C fn pointer result");
        const args = ops.slice(1);
        const tys = args.map(o => valueType(this.cx, o.type)!);
        const call = `milo.call_ptr ${f.ref}(${args.map(o => o.ref).join(", ")}) : (${tys.join(", ")}) -> ${ret ?? "()"}`;
        if (ret === null) { this.emit(call); return this.valued({ ref: "", ty: "" }, stmt); }
        return this.valued(this.def(call, ret), stmt);
      }
      case "OffsetOf": {
        // A constant of the struct layout.
        if (scalar(this.ty(e.node), "offsetOf") !== "si64") throw new MlirUnsupported("offsetOf type");
        const off = e.sizeType.tag === "struct" ? this.cx.mlirFieldOffset(e.sizeType.name, e.fieldName) : 0;
        return this.def(`milo.const ${off} : si64`, "si64");
      }
      case "InterfaceCoerce": {
        // The fat pair { data, itable }, written in a slot. Heap<T>
        // -> Heap<I>: the box moved into it (the same allocation, now owned by the dyn).
        // `&T -> &I`: T's place, borrowed, as the data.
        const itable = this.def(`milo.global.addr ${quote(this.cx.mlirItable(e.fromType, e.ifaceName))}`, PTR);
        const pair = (ty: string, data: Val) => {
          const slot = this.fresh();
          this.vars.push(`  ${slot} = milo.var "dyn" : !milo.ref<${ty}>`);
          const at = this.def(`milo.addr ${slot} : !milo.ref<${ty}>`, PTR).ref;
          this.emit(`milo.ptr.store ${data.ref}, ${at} : ${data.ty}`);
          this.emit(`milo.ptr.store ${itable.ref}, ${this.def(`milo.ptr.elem ${at}[${this.def("milo.const 1 : si64", "si64").ref}] : ${PTR}`, PTR).ref} : ${PTR}`);
          return this.def(`milo.load ${slot} : !milo.ref<${ty}>`, ty);
        };
        if (this.ty(e.node).tag !== "heap") {
          const st = stripRefs(this.ty(e.value));
          const ty = this.place$(stripRefs(this.ty(e.node)), "borrowed interface");
          const et = this.ty(e.node), mut = et.tag === "ref" && et.mutable;
          const lt = this.lent(st, "coerced value");
          const p = this.place(e.value, lt, mut).ref;
          return { ...pair(ty, this.addressOf(p, lt)), own: "view" };
        }
        const ty = this.value(this.ty(e.node), "interface value");
        const v = this.consume(this.expr(e.value), "coerced box");
        return { ...pair(ty, v), own: "owned" };
      }
      case "VecCapacity": {
        // The header's third word.
        const vt = stripRefs(this.ty(e.object));
        const lent = this.lent(vt, "vec of capacity");
        if (!lent.startsWith("!milo.vec<")) throw new MlirUnsupported("capacity of a non-Vec place");
        const at = this.addressOf(this.place(e.object, lent, false).ref, lent).ref;
        return this.def(`milo.ptr.load ${this.def(`milo.ptr.field ${at}[2] : !milo.struct<"Vec", ${PTR}, si64, si64>`, PTR).ref} : si64`, "si64");
      }
      case "HeapPtr": {
        // `h.ptr()`: the box's address, read from the Heap's place (the Heap IS the
        // pointer). The Heap keeps owning it.
        const ht = stripRefs(this.ty(e.object));
        if (ht.tag !== "heap" || ht.inner.tag === "interface" || scalar(this.ty(e.node), "heap pointer") !== PTR) throw new MlirUnsupported("ptr of a box of an interface");
        const lt = this.lent(ht, "heap of ptr");
        const at = this.addressOf(this.place(e.object, lt, false).ref, lt).ref;
        return this.def(`milo.ptr.load ${at} : ${PTR}`, PTR);
      }
      case "EnumTryFrom": {
        // `E.tryFrom(n)`: Some of the variant whose discriminant is n (its tag), else None;
        // n compared in i64, widened by its own signedness.
        let n = this.expr(e.value);
        const m = /^([su])i(\d+)$/.exec(n.ty);
        if (!m) throw new MlirUnsupported("tryFrom operand type");
        if (m[1] === "u") n = this.def(`milo.cast ${n.ref} : ${n.ty} to ui64`, "ui64");
        if (n.ty !== "si64") n = this.def(`milo.cast ${n.ref} : ${n.ty} to si64`, "si64");
        const oty = this.value(this.ty(e.node), "tryFrom result"), ety = this.value({ tag: "enum", name: e.enumName } as TypeKind, "tryFrom enum");
        const vs = this.cx.mlirEnumLayout(e.optionEnumName)?.variants;
        const some = vs?.find(x => x.name === "Some"), none = vs?.find(x => x.name === "None");
        if (!some || !none) throw new MlirUnsupported("tryFrom Option layout");
        const arm = (k: number): Val => {
          if (k === e.discriminants.length) return this.def(`milo.enum.new ${none.tag} -> ${oty}`, oty);
          const d = e.discriminants[k];
          const c = this.def(`milo.cmp eq, ${n.ref}, ${this.def(`milo.const ${d} : si64`, "si64").ref} : si64`, "i1");
          const r = this.fresh();
          this.region(`${r} = milo.if ${c.ref} -> ${oty} {`, () => this.def(`milo.enum.new ${some.tag} (${this.def(`milo.enum.new ${d} -> ${ety}`, ety).ref} : ${ety}) -> ${oty}`, oty));
          this.region("} else {", () => arm(k + 1));
          this.emit("}");
          return { ref: r, ty: oty };
        };
        return arm(0);
      }
      case "JsonStringify": {
        // `jsonStringify(s)` of a struct: a fresh string from the struct's JSON glue.
        const t = stripRefs(this.ty(e.value));
        if (t.tag !== "struct" || !this.cx.structLayouts.get(t.name)!.fields.every(f => ["string", "int", "float", "bool"].includes(f.typeKind.tag)))
          throw new MlirUnsupported("jsonStringify of a struct with a field that has no JSON");
        const lt = this.glue.placeOf(t);
        const p = this.place(e.value, lt, false).ref;
        const slot = this.ownedSlot("json", STR, { tag: "string" });
        this.emit(`milo.store ${this.def(`milo.zero : ${STR}`, STR).ref}, ${slot} init : !milo.ref<${STR}>`);
        this.rtCall(this.glue.json(t), [{ ref: p, ty: lt }, { ref: slot, ty: `!milo.ref<${STR}>` }], null);
        return { ...this.def(`milo.move ${slot} : !milo.ref<${STR}>`, STR), own: "owned" };
      }
      case "BitIntrinsic": {
        const v = this.expr(e.value);
        if (!/^[su]i\d+$/.test(v.ty)) throw new MlirUnsupported("bit intrinsic operand type");
        const count = ["ctpop", "ctlz", "cttz"].includes(e.intrinsic);
        const amt = e.amount ? this.expr(e.amount) : null;
        if (amt && amt.ty !== v.ty) throw new MlirUnsupported("rotate amount type");
        const rt = count ? "si64" : v.ty;
        if (this.value(this.ty(e.node), "bit intrinsic result") !== rt) throw new MlirUnsupported("bit intrinsic result type");
        return this.def(`milo.bits "${e.intrinsic}", ${v.ref}${amt ? `, ${amt.ref}` : ""} : ${v.ty}${amt ? `, ${amt.ty}` : ""} -> ${rt}`, rt);
      }
      case "Adopt": {
        // adoptHeap(p) / adoptVec(p, len): no conversion, only the type,
        // whose drop glue now frees the block. A Vec is { p, len, len }; a Heap is p.
        const ty = this.value(this.ty(e.node), "adopted value");
        const p = this.expr(e.ptr);
        if (p.ty !== PTR) throw new MlirUnsupported("adopt of a non-pointer");
        if (e.len) {
          const n = this.expr(e.len);
          if (n.ty !== "si64") throw new MlirUnsupported("adopt length type");
          return this.makeView(ty, p, n, n);
        }
        const slot = this.fresh();
        this.vars.push(`  ${slot} = milo.var "adopt" : !milo.ref<${ty}>`);
        this.emit(`milo.ptr.store ${p.ref}, ${this.def(`milo.addr ${slot} : !milo.ref<${ty}>`, PTR).ref} : ${PTR}`);
        return { ...this.def(`milo.load ${slot} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "RawSlice": {
        // A foreign view `&[T]` over (ptr, len): the header { ptr, len, 0 }.
        // Its capacity 0 owns nothing, so it is a view.
        const elem = vecElem(this.cx, stripRefs(this.ty(e.node)));
        if (elem === null) throw new MlirUnsupported("raw slice element type");
        const p = this.expr(e.ptr), n = this.expr(e.len);
        if (p.ty !== PTR || n.ty !== "si64") throw new MlirUnsupported("raw slice operand types");
        return this.makeView(`!milo.vecval<${elem}>`, p, n);
      }
      case "RangeCheck": {
        // A value flowing into a ranged int: a range check (its panic text) in a
        // helper per site, which returns the value unchanged.
        const v = this.expr(e.value);
        const ty = scalar(this.ty(e.node), "range-checked value");
        if (v.ty !== ty || !/^[su]i\d+$/.test(ty)) throw new MlirUnsupported("range check operand type");
        // The panic text names the line only.
        const lo = this.def(`milo.cmp lt, ${v.ref}, ${this.def(`milo.const ${e.min} : ${ty}`, ty).ref} : ${ty}`, "i1");
        const hi = this.def(`milo.cmp gt, ${v.ref}, ${this.def(`milo.const ${e.max} : ${ty}`, ty).ref} : ${ty}`, "i1");
        const bad = this.def(`milo.or ${lo.ref}, ${hi.ref} : i1`, "i1");
        const l = this.site(e.span);
        this.panicIf(bad.ref, `runtime error: value out of range at ${l.file}:${l.line}\n`);
        return v;
      }
      case "VecGetOpt": {
        // `v.get(i)` / first / last: in bounds (unsigned, so a negative
        // index is out), Some of a deep clone of the element, else None; v lent by its place. A temporary receiver goes
        // to a slot that dies with the statement, not dropped right after the read; only a
        // user Drop could tell the difference, so such a one is unsupported.
        const k = this.k(e.object);
        const vt = stripRefs(this.ty(e.object));
        if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && this.runsUserDrop(this.place$(vt, "vec of get"))) throw new MlirUnsupported("get on a temporary vec with a user Drop");
        const v = this.place(e.object, this.lent(vt, "vec of get"), false).ref;
        const i = this.expr(e.index);
        if (i.ty !== "si64") throw new MlirUnsupported("get index type");
        const ty = this.value(this.ty(e.node), "get result");
        const vs = this.cx.mlirEnumLayout(e.optionEnumName)?.variants;
        const some = vs?.find(x => x.name === "Some"), none = vs?.find(x => x.name === "None");
        const lent = this.lent(vt, "vec of get");
        const elem = this.place$(e.elementType, "get element");
        if (some && none && lent === `!milo.vec<${elem}>`) {
          const u = (x: string) => this.def(`milo.cast ${x} : si64 to ui64`, "ui64").ref;
          const inb = this.def(`milo.cmp lt, ${u(i.ref)}, ${u(this.def(`milo.len ${v} : ${lent}`, "si64").ref)} : ui64`, "i1");
          const res = this.fresh();
          this.region(`${res} = milo.if ${inb.ref} -> ${ty} {`, () => {
            const er = this.def(`milo.index.ref ${v}[${i.ref}] : ${lent} -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`).ref;
            const c = this.hasDrop(elem) ? this.cloneTo(e.elementType, er, `!milo.ref<${elem}>`, elem) : this.def(`milo.load ${er} : !milo.ref<${elem}>`, elem);
            if (!c) throw new MlirUnsupported("get of an element with no clone glue");
            return { ...this.def(`milo.enum.new ${some.tag} (${c.ref} : ${elem}) -> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
          });
          this.region("} else {", () => ({ ...this.def(`milo.enum.new ${none.tag} -> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined }));
          this.emit("}");
          return { ref: res, ty, own: this.hasDrop(ty) ? "owned" : undefined };
        }
        throw new MlirUnsupported("get of a Vec of another shape");
      }
      case "VecLen": {
        const { place, elem } = this.vecPlace(e.object);
        return this.def(`milo.len ${place} : !milo.vec<${elem}>`, "si64");
      }
      case "PtrDeref": return this.ptrRead(this.ptrPlace(e)!);
      case "FieldAccess": {
        const pp = this.ptrPlace(e);
        if (pp) return this.ptrRead(pp);
        // A field of a place is read in place; of a value, out
        // of the value.
        if (this.mv(e) && this.hasDrop(this.value(this.ty(e.node), "field")) && !this.borrowedRoot(e)) return this.moveField(e);
        const own = this.hasDrop(this.value(this.ty(e.node), "field")) ? "view" as const : undefined;
        const p = this.fieldPlace(e);
        if (p) return { ...this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty), own };
        const { index, ty } = this.field(e);
        // A temporary that owns is kept in a slot while its field is read: until the end of
        // the statement when the field is a view into it, else only for the read (tempSlot).
        const get = (s: Val): Val => ({ ...this.def(`milo.struct.get ${s.ref}[${index}] : ${s.ty} -> ${ty}`, ty), own });
        if (!own) return this.peek(e.object, get);
        const ov = this.expr(e.object);
        if (ov.own === "owned" && !this.bitCopies.has(ov.ref) && !this.runsUserDrop(ty) && this.hasDrop(ov.ty)) {
          // An owning field of a temporary: the field cloned out, the [MILO-O-tempFieldRead]
          // temporary dropped right after the read (`mk().name`), so a user Drop runs
          // before the statement goes on. A field that runs its own Drop is not cloned.
          this.owned.push([]);
          const start = this.body.length;
          const slot = this.ownedSlot("field.of", ov.ty, this.ty(e.object));
          this.emit(`milo.store ${ov.ref}, ${slot} : !milo.ref<${ov.ty}>`);
          const fr = this.def(`milo.field_ref ${slot}[${index}] : !milo.ref<${ov.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
          const c = this.copyOut(e, fr, ty, true);
          return this.closeScope(start, false, c) ?? c;
        }
        return get(this.borrow(ov, this.ty(e.object)));
      }
      case "StructLit": return this.structLit(e);
      case "EnumLit": {
        const ty = this.value(this.ty(e.node), "enum literal");
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
        if (this.ty(e.node).tag === "void" || this.ty(e.node).tag === "never") throw new MlirUnsupported("if-expression without a value");
        const ty = this.value(this.ty(e.node), "if-expression");
        const c = this.expr(e.cond);
        if (c.ty !== "i1") throw new MlirUnsupported("if condition type");
        const ref = this.fresh();
        const mode = this.forkMode(e, ty);
        const fork = { mode, sawView: false };
        this.forks.push(fork);
        try {
          this.region(`${ref} = milo.if ${c.ref} -> ${ty} {`, () => this.tail(e.thenBody, ty));
          // A compile-time condition (Facts.constBool) keeps the taken arm alone, the dead one left out:
          // that else never runs.
          const folded = !!e.folded;
          this.region("} else {", () => { if (!folded) return this.tail(e.elseBody, ty); this.emit("milo.unreachable"); return true; });
        } finally { this.forks.pop(); }
        this.emit("}");
        return { ref, ty, own: mode === "view" ? (fork.sawView ? "view" : "static") : this.hasDrop(ty) ? "owned" : undefined };
      }
      case "Closure": return this.closure(e);
      case "ClosureCall": return this.valued(this.callScope(() => this.closureCall(e, stmt)), stmt);
      case "MatchExpr": {
        if (this.ty(e.node).tag === "void" || this.ty(e.node).tag === "never") throw new MlirUnsupported("match-expression without a value");
        const ty = this.value(this.ty(e.node), "match-expression");
        const mode = this.forkMode(e, ty);
        const fork = { mode, sawView: false };
        this.forks.push(fork);
        try {
          const v = this.match(this.matchOf(e), ty).v;
          return mode === "view" ? { ...v, own: fork.sawView ? "view" : "static" } : v;
        } finally { this.forks.pop(); }
      }
      case "Propagate": return this.propagate(e);
      case "DefaultValue": return this.defaultValue(e);
      case "Unwrap": {
        if (this.isSretCall(e.operand)) {
          // A 128+ byte enum (sret) with a payload that is a value: unwrapped from the
          // call's slot into a scratch slot (unwrapInto), then the payload read out of it.
          const ty = this.value(this.ty(e.node), "unwrapped payload");
          const dst = this.fresh();
          this.vars.push(`  ${dst} = milo.var "unwrapped" : !milo.ref<${ty}>`);
          this.unwrapInto(e, dst, ty);
          return { ...this.def(`milo.load ${dst} : !milo.ref<${ty}>`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
        }
        // Some/Ok (tag 0) gives its payload; anything else is the unwrap message on
        // stderr, then the panic tail: an Err(string) its text, an Err(enum) the variant
        // shown, any other Err or a None just which it was.
        const st = stripRefs(this.ty(e.operand));
        const v = this.consume(this.expr(e.operand), "unwrapped value");
        const ety = this.value(st, "unwrapped enum");
        if (v.ty !== ety) throw new MlirUnsupported("unwrap operand type");
        this.unwrapCheck(e, this.def(`milo.enum.tag ${v.ref} : ${ety}`, "si32"), (tag, pty) => {
          const slot = this.fresh();
          this.vars.push(`  ${slot} = milo.var "unwrap.err" : !milo.ref<${pty}>`);
          this.emit(`milo.store ${this.def(`milo.enum.payload ${v.ref}[${tag}, 0] : ${ety} -> ${pty}`, pty).ref}, ${slot} : !milo.ref<${pty}>`);
          return slot;
        });
        if (this.ty(e.node).tag === "void") return { ref: "", ty: "" };
        const ty = this.value(this.ty(e.node), "unwrapped payload");
        return { ...this.def(`milo.enum.payload ${v.ref}[0, 0] : ${ety} -> ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
      }
      case "OptionOp": {
        // isSome/isNone (isOk/isErr): a test of the tag, Some and Ok being tag 0; unwrapOr
        // is `??`. The closure-taking ones are the match they mean (combinatorMatch).
        if (e.op === "unwrapOr" && e.default)
          return this.defaultValue({ kind: "DefaultValue", node: e.node, operand: e.value, default: e.default, enumName: e.enumName, span: e.span });
        if (CALLBACK_OPS.has(e.op)) return this.optionCallback(e);
        if (e.op !== "isSome" && e.op !== "isNone") throw new MlirUnsupported(`option op ${e.op}`);
        const pt = placeType(this.cx, this.ty(e.value));
        let tag: string;
        if ((pt !== null && valueType(this.cx, this.ty(e.value)) === null) || this.isSretCall(e.value)) {
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
        // `forget(x)`: x is taken and nothing drops it (an owned SSA value no slot holds). A
        // local that lives in a slot is emptied in place: its slot then drops nothing.
        if (this.k(e.value) === "Ident") {
          const name = (this.f(e.value) as FormOf<"Ident">).name;
          const b = this.scopes.some(m => m.has(name)) ? this.lookup(name) : null;
          if (b?.kind === "var" && inSlot(this.cx, b.ty)) {
            // One that owns nothing has nothing to forget.
            if (b.owned) this.def(`milo.move ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
            return { ref: "", ty: "" };
          }
        }
        const v = this.consume(this.expr(e.value), "forgotten value");
        void v;
        return { ref: "", ty: "" };
      }
      case "Zeroed": {
        const ty = this.value(e.zeroType, "zeroed value");
        if (ty.startsWith("!milo.fn<")) throw new MlirUnsupported("zeroed fn value");
        return { ...this.def(`milo.zero : ${ty}`, ty), own: this.hasDrop(ty) ? "owned" : undefined };
      }
      // std's panics with a message: through milo.panic_if.
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
        // `s.pushStr(x)`: the place, then x; milo.string.append
        // makes the string unique first, then grow; `s.pushStr(s)` re-based).
        const dst = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        const x = this.borrow(this.expr(e.other), this.ty(e.other));
        if (x.ty !== STR) throw new MlirUnsupported("pushStr of a non-string");
        this.emit(`milo.string.append ${dst}, ${x.ref} : !milo.ref<${STR}>`);
        return { ref: "", ty: "" };
      }
      case "StringPushInt": {
        // `s.pushInt(n)`: grow, then the digits in place, in a
        // helper, the string lent `&mut`, the int by value.
        const dst = this.place(e.str, `!milo.ref<${STR}>`, true).ref;
        this.pushScalar(dst, this.expr(e.value), e.span);
        return { ref: "", ty: "" };
      }
      case "ArrayLit": {
        if (this.ty(e.node).tag !== "vec") throw new MlirUnsupported("array literal as a value");
        const ty = this.value(this.ty(e.node), "Vec literal");
        if (e.elements.length === 0) return { ...this.def(`milo.vec.new : ${ty}`, ty), own: "owned" };
        // An array literal: one malloc of exactly n elements, each written as it is
        // evaluated (a place-only one, an array or a 128+ byte struct, built in a slot of
        // the statement, copied in, the slot then emptied); then the header { buf, n, n }.
        // A jump out of a later element drops the slots built so far.
        const et = (this.ty(e.node) as TypeKind & { tag: "vec" }).element;
        const pty = this.place$(et, "Vec literal element");
        const n = e.elements.length, es = this.cx.typeSizeOf(et);
        // Every element first, then the buffer: a `?` inside a later element leaves before
        // anything is allocated, and the elements built so far are pending, so dropped.
        const placeOnly = valueType(this.cx, et) === null;
        const slots = placeOnly ? e.elements.map(x => this.bigSlot("veclit.elem", x, true)) : [];
        const ety = placeOnly ? "" : this.value(et, "Vec literal element");
        const mark = this.pending.length;
        const vals = placeOnly ? [] : e.elements.map(x => this.pend(this.operand(x, ety, "Vec literal element"), this.ty(x)));
        this.pending.length = mark;
        const buf = this.allocCheck(this.rtCall("rtBufAlloc", [this.def(`milo.const ${n} : si64`, "si64"), this.def(`milo.const ${es} : si64`, "si64")], PTR), e.span);
        const at = (k: number) => k === 0 ? buf.ref : this.def(`milo.ptr.elem ${buf.ref}[${this.def(`milo.const ${k} : si64`, "si64").ref}] : ${pty}`, PTR).ref;
        if (placeOnly) {
          slots.forEach((sl, k) => this.emit(`milo.copy ${sl.ref}, ${at(k)} : !milo.ref<${pty}>, ${PTR} of ${pty}`));
          for (const sl of slots) if (sl.owned) this.def(`milo.move ${sl.ref} : !milo.ref<${pty}>`, pty);
        } else vals.forEach((v, k) => this.emit(`milo.ptr.store ${v.ref}, ${at(k)} : ${ety}`));
        if (this.hasDrop(pty)) this.dropGlue(ty, this.ty(e.node));
        const count = this.def(`milo.const ${n} : si64`, "si64");
        return this.makeView(ty, buf, count, count);
      }
      default:
        throw new MlirUnsupported(`expr ${e.kind}`);
    }
  }

  /**
   * A by-reference closure literal (without `move`): a function of its
   * own, and a milo.closure lending it the place of every capture. A `let` held as an SSA
   * value is spilled to a slot: it is immutable, so the copy reads the same. A scoped
   * task's literal (`heapEnv`) has its env on the heap, freed by the task's reap.
   */
  private closure(e: FormOf<"Closure">): Val {
    if (e.isMove && !e.heapEnv && !e.keyExtractor) return this.moveClosure(e);
    if (e.isMove) throw new MlirUnsupported("move closure");
    const ty = this.value(this.ty(e.node), "closure");
    // A global's initializer (__milo.global_init, __milo.lazyinit.*) returns before the
    // global's closure is ever called, so its env is static (milo.closure `static`), as [MILO-O-globalClosureEnv]
    // a static env. A closure inside another closure's body keeps a frame env.
    const staticEnv = e.captures.length > 0 && !e.heapEnv && this.fn.name.startsWith("__milo.") && !this.inClosureBody;
    const caps = e.captures.map(c => {
      const b = this.lookup(c.name);
      if (b.kind === "vec") return { name: c.name, place: `!milo.vec<${b.elem}>`, ref: b.ref, b };
      if (b.kind === "var") return { name: c.name, place: `!milo.ref<${b.ty}>`, ref: b.ref, b };
      // A for-in element or pattern binding is a non-owning view of a value somebody else
      // owns; the by-ref closure only borrows it, so the bits go into an unowned slot
      // (never dropped here). A truly owned SSA value would need the env to own it.
      if (this.hasDrop(b.v.ty) && b.v.own !== "view") throw new MlirUnsupported("capture of an owned value");
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var ${quote(c.name)} : !milo.ref<${b.v.ty}>`);
      this.emit(`milo.store ${b.v.ref}, ${ref} : !milo.ref<${b.v.ty}>`);
      return { name: c.name, place: `!milo.ref<${b.v.ty}>`, ref, b: { kind: "var" as const, ref, ty: b.v.ty } };
    });
    const name = `${this.fn.name}$closure${this.closures.next++}`;
    const inner = new FnEmitter(this.fn, this.cx, this.fns, this.closures, this.glue);
    const text = inner.runClosure(e, name, caps);
    this.closures.texts.push(text);
    this.closures.names.push(name);
    for (const [k, v] of inner.callees) this.callees.set(k, v);
    const ops = caps.length ? `(${caps.map(c => c.ref).join(", ")} : ${caps.map(c => c.place).join(", ")})` : "";
    return this.def(`milo.closure @${quote(name)}${ops}${e.heapEnv ? " heap" : ""}${staticEnv ? " static" : ""} : ${ty}`, ty);
  }

  /**
   * The structural deep copy (through MapCopyOut) of what the
   * place `src` holds (`refOf(ty)`, or a slot of `ty` when `slot`), an owned value of
   * `ty`. A Vec in a slot is lent as its header.
   */
  private copyOut(x: X, src: string, ty: string, slot = false): Val {
    const e = this.f(x);
    const native = this.cloneTo(stripRefs(this.ty(e.node)), src, slot ? `!milo.ref<${ty}>` : refOf(ty), ty);
    if (native) return native;
    throw new MlirUnsupported(`copy of a ${stripRefs(this.ty(e.node)).tag} that has no clone glue`);
  }

  /**
   * A deep copy of the T at place `src` (of type `srcTy`) by its clone glue, owned, in a
   * fresh slot then loaded; null when the glue does not cover T (an owning closure).
   */
  private cloneTo(t: TypeKind, src: string, srcTy: string, ty: string): Val | null {
    let fn: string;
    try { fn = this.glue.cloneFromPlace(t, srcTy, ty); } catch (err) { if (err instanceof MlirUnsupported) return null; throw err; }
    const tmp = this.fresh();
    this.vars.push(`  ${tmp} = milo.var "clone" : !milo.ref<${ty}>`);
    this.rtCall(fn, [{ ref: src, ty: srcTy }, { ref: tmp, ty: `!milo.ref<${ty}>` }], null);
    const v = this.def(`milo.load ${tmp} : !milo.ref<${ty}>`, ty);
    this.clones.add(v.ref);
    return { ...v, own: this.hasDrop(ty) ? "owned" : undefined };
  }


  /**
   * A `move` closure: its captures moved into a heap env with their
   * liveness flags and a drop function, the body a function of its own. A capture moves
   * out of its owned slot; a shared string capture (`share`) passes a new owner of the
   * same buffer and the binding stays live.
   */
  private moveClosure(e: FormOf<"Closure">): Val {
    const ty = this.value(this.ty(e.node), "move closure");
    // Nothing captured: no env at all (null); the by-reference form is exactly that.
    if (e.captures.length === 0) return { ...this.closure({ ...e, isMove: false }), own: "owned" };
    const params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[] = [];
    const args: Val[] = [];
    // A 128+ byte or place-only capture: its address goes in, the helper binds the capture
    // from `*p` (a bit copy the closure moves into its env), and the local's slot is
    // emptied after the call: one owner throughout.
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
      // checker allows): the value read through a non-owning view.
      else if (b.kind === "var" && b.ty === cty.replace(/^!milo\.fn</, "!milo.fn<owning ") && b.ty !== cty)
        v = this.def(`milo.fn.cast ${this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty).ref} : ${b.ty} -> ${cty}`, cty);
      else if (b.kind !== "var" || b.ty !== cty) throw new MlirUnsupported(`capture binding (${b.kind === "var" ? `${b.ty} for ${cty}` : b.kind} ${c.name})`);
      else if (!this.hasDrop(cty)) v = this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty);
      else if (c.share && cty === STR) {
        v = { ...this.def(`milo.string.share ${b.ref} : !milo.ref<${STR}>`, STR), own: "owned" };
      } else if (b.owned && !c.share) v = { ...this.def(`milo.move ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
      else if (b.flag && !c.share) {
        // A capture of the enclosing move closure, moved on into this one.
        v = { ...this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
        this.emit(`milo.store ${this.def("milo.const false", "i1").ref}, ${b.flag} : !milo.ref<i1>`);
      }
      else if (!b.owned && !c.share && this.inClosureBody && !this.runsUserDrop(cty)) {
        // A capture of an enclosing by-ref closure (its slot is the owner's, in another
        // frame) moved on into this one: read out and zeroed through
        // the reference, so the owner's own drop later finds it empty.
        v = { ...this.def(`milo.load ${b.ref} : !milo.ref<${cty}>`, cty), own: "owned" };
        this.emit(`milo.store ${this.def(`milo.zero : ${cty}`, cty).ref}, ${b.ref} init : !milo.ref<${cty}>`);
      } else throw new MlirUnsupported("capture that is not a move of an owned local");
      params.push({ name: c.name, type: c.type, isRef: false, isRefMut: false });
      args.push(v);
    }
    // The env, laid out here: a header (the env's drop function), a
    // table with each capture's address and then each flag's, then the captures' bytes
    // and the flags, every field 8-aligned. The table is what lets the body read a move
    // env exactly as a by-reference one (milo.env.capture). The env owns the captures:
    // a flag says whether the body has given its capture away.
    const name = `${this.fn.name}$closure${this.closures.next++}`;
    const own = e.captures.map((c, i) => [c, i] as const).filter(([c]) => this.hasDrop(this.place$(c.type, "capture"))).map(([, i]) => i);
    const align = (n: number) => Math.ceil(n / 8) * 8;
    // The table is pointer-sized slots, an even count of them so the bytes after it stay
    // 8-aligned on a 32-bit target too.
    const pb = this.cx.typeSizeOf({ tag: "ptr", inner: { tag: "int", bits: 8, signed: false } } as TypeKind);
    const slots = 1 + e.captures.length + own.length;
    const table = pb * (slots + (slots % 2));
    const offs: number[] = [];
    let at = table;
    for (const c of e.captures) { offs.push(at); at += align(this.cx.typeSizeOf(c.type)); }
    const flagOffs = own.map(() => { const o = at; at += 8; return o; });
    const env = this.allocCheck(this.rtCall("rtBufAlloc", [this.def("milo.const 1 : si64", "si64"), this.def(`milo.const ${at} : si64`, "si64")], PTR), e.span);
    const off = (o: number) => o === 0 ? env.ref : this.def(`milo.ptr.elem ${env.ref}[${this.def(`milo.const ${o} : si64`, "si64").ref}] : ui8`, PTR).ref;
    this.emit(`milo.ptr.store ${this.def(`milo.fn.addr @${quote(`${name}$envdrop`)}`, PTR).ref}, ${env.ref} : ${PTR}`);
    [...offs, ...flagOffs].forEach((o, k) => this.emit(`milo.ptr.store ${off(o)}, ${off(pb * (1 + k))} : ${PTR}`));
    // args[i] is capture i: its value, or for one that lives in a slot, the slot's address.
    e.captures.forEach((c, i) => {
      const pty = this.place$(c.type, "capture");
      const vp = viaPtr.find(p => p.name === c.name);
      if (vp) this.emit(`milo.copy ${vp.slot}, ${off(offs[i])} : !milo.ref<${pty}>, ${PTR} of ${pty}`);
      else this.emit(`milo.ptr.store ${args[i].ref}, ${off(offs[i])} : ${args[i].ty}`);
    });
    for (const o of flagOffs) this.emit(`milo.ptr.store ${this.def("milo.const true", "i1").ref}, ${off(o)} : i1`);
    // The body, reading the env through the table.
    const caps = e.captures.map(c => {
      const pty = this.place$(c.type, "capture");
      // A Vec capture is its value's slot in the env (a var of !milo.vecval), so the body
      // can move it out as any other capture.
      return { name: c.name, place: `!milo.ref<${pty}>`, b: { kind: "var", ref: "", ty: pty } as Binding };
    });
    const inner = new FnEmitter(this.fn, this.cx, this.fns, this.closures, this.glue);
    this.closures.texts.push(inner.runClosure({ ...e, captures: e.captures.map(c => ({ ...c, share: false })) }, name, caps,
      own.map(i => ({ of: i, once: !!e.captures[i].consumedInClosure }))));
    this.closures.names.push(name);
    for (const [k, v] of inner.callees) this.callees.set(k, v);
    // Its drop: each capture still held, then the block.
    const dl = [`func.func @${quote(`${name}$envdrop`)}(%env: ${PTR}) attributes {llvm.linkage = #llvm.linkage<internal>} {`];
    let n = 0;
    const d = (op: string) => { const r = `%d${n++}`; dl.push(`  ${r} = ${op}`); return r; };
    const eo = (o: number) => d(`milo.ptr.elem %env[${d(`milo.const ${o} : si64`)}] : ui8`);
    own.forEach((i, j) => {
      const glue = this.glue.drop(stripRefs(e.captures[i].type));
      dl.push(`  milo.if ${d(`milo.ptr.load ${eo(flagOffs[j])} : i1`)} {`, `  func.call @${quote(glue)}(${eo(offs[i])}) : (${PTR}) -> ()`, "  milo.yield", "  }");
    });
    dl.push(`  func.call @"free"(%env) : (${PTR}) -> ()`, "  milo.return", "}");
    this.closures.texts.push(dl.join("\n"));
    this.closures.names.push(`${name}$envdrop`);
    this.callees.set("free", `(${PTR}) -> ()`);
    for (const done of after) done();
    // The value { body, env }, owning: its drop calls the header.
    const pair = this.fresh();
    this.vars.push(`  ${pair} = milo.var "closure" : !milo.ref<${ty}>`);
    const pa = this.def(`milo.addr ${pair} : !milo.ref<${ty}>`, PTR).ref;
    this.emit(`milo.ptr.store ${this.def(`milo.fn.addr @${quote(name)}`, PTR).ref}, ${pa} : ${PTR}`);
    this.emit(`milo.ptr.store ${env.ref}, ${this.def(`milo.ptr.elem ${pa}[${this.def("milo.const 1 : si64", "si64").ref}] : ${PTR}`, PTR).ref} : ${PTR}`);
    this.dropGlue(ty, this.ty(e.node));
    return { ...this.def(`milo.load ${pair} : !milo.ref<${ty}>`, ty), own: "owned" };
  }

  /** `f(args)` through a fn value: the callee, then the args. */
  // abi: a result that lives in memory is the ABI's value (for this call only, not the calls in its arguments).
  private closureCall(e: FormOf<"ClosureCall">, _stmt: boolean, abi = false): Val {
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
      const v = this.pend(this.operand(a.expr, pty, "argument", true), this.ty(a.expr));
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
  private field(e: FormOf<"FieldAccess">): { index: number; ty: string } {
    const st = stripRefs(this.ty(e.object));
    if (st.tag !== "struct") throw new MlirUnsupported(`field of a ${st.tag}`);
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    return { index, ty: this.place$(this.fieldType(e), "field") };
  }

  /**
   * The type of the value `e` reads. A fn-typed field's HIR type has lost its params
   * (`(i64, i64) => i64` reads as `() => i64`); the struct's layout has them.
   */
  private fieldType(x: X): TypeKind {
    const e = this.f(x);
    if (e.kind !== "FieldAccess" || this.ty(e.node).tag !== "fn") return this.ty(e.node);
    const st = stripRefs(this.ty(e.object));
    const f = st.tag === "struct" ? this.cx.structLayouts.get(st.name)?.fields.find(x => x.name === e.field) : undefined;
    return f?.typeKind ?? this.ty(e.node);
  }

  /**
   * The address of a place reached through a raw pointer (`p[i]`, `p.f` on a `*S`,
   * `p[i].f`) and its element type, or null when `e` is not one. The pointer
   * first, then the index.
   */
  private ptrBinding(x: X): { ptr: string; ty: string } | null {
    const e = this.f(x);
    if (e.kind !== "Ident") return null;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(e.name);
      if (b) return b.kind === "ptr" ? { ptr: b.ptr, ty: b.ty } : null;
    }
    return null;
  }

  private ptrPlace(x: X): { ptr: string; ty: string } | null {
    const e = this.f(x);
    const pb = this.ptrBinding(e);
    if (pb) return pb;
    if (e.kind === "PtrDeref") {
      // `*p`: what p points at, of any type; an owning one is a bit copy, as ptrRead says.
      const p = this.expr(e.operand);
      if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
      return { ptr: p.ref, ty: this.place$(this.ty(e.node), "load through a pointer") };
    }
    {
      // A fixed array's element behind a pointer (`p[1][0]`, p: *[T; N]): bounds-checked
      // against N (the same __milo_bounds_fail as a fixed-array index), then stepped
      // to as a pointer: the dialect has no milo.ref behind a pointer.
      const ot = stripRefs(e.kind === "IndexAccess" ? this.ty(e.object) : { tag: "void" } as TypeKind);
      const base = e.kind === "IndexAccess" && ot.tag === "array" && ot.size !== null ? this.ptrPlace(e.object) : null;
      if (base && e.kind === "IndexAccess" && ot.tag === "array" && ot.size !== null) {
        const i = this.index(e.index);
        const n = this.def(`milo.const ${ot.size} : si64`, "si64").ref;
        this.emit(`milo.bounds_check ${i}, ${n} : si64, si64 ${this.loc(e.span)}`);
        const ty = this.place$(ot.element, "array element");
        return { ptr: this.def(`milo.ptr.elem ${base.ptr}[${i}] : ${ty}`, PTR).ref, ty };
      }
    }
    if (e.kind === "IndexAccess" && stripRefs(this.ty(e.object)).tag === "ptr") {
      const p = this.expr(e.object);
      const i = this.expr(e.index);
      if (p.ty !== PTR || i.ty !== "si64") throw new MlirUnsupported("pointer index of another type");
      const ty = this.place$(this.ty(e.node), "pointer element");
      return { ptr: this.def(`milo.ptr.elem ${p.ref}[${i.ref}] : ${ty}`, PTR).ref, ty };
    }
    if (e.kind !== "FieldAccess") return null;
    const obj = stripRefs(this.ty(e.object));
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
    const ty = this.place$(this.ty(e.node), "field");
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
  // `&T` param, a print part), it must not be dropped: the element's address is lent.
  private bitCopies = new Set<string>();

  /**
   * A value that lives in memory (Repr) but is no place (an sret call's result, a 128+
   * byte literal) read in place (`regionByKey(s).isNone()`, `mk().field`): built in a slot
   * of the open frame (tempSlot), or null for anything else. One whose drop runs a user
   * Drop is unsupported: it would have to drop right after the read, not at the frame's end.
   */
  private memTemp(x: X): { ref: string; ty: string; param?: number } | null {
    const e = this.f(x);
    if (e.kind === "Ident" || e.kind === "FieldAccess" || e.kind === "IndexAccess" || e.kind === "HeapDeref" || e.kind === "PtrDeref") return null;
    const pt = placeType(this.cx, this.ty(e.node));
    if (!this.isSretCall(e) && (pt === null || isSsa(this.cx, pt))) return null;
    if (pt !== null && this.runsUserDrop(pt)) throw new MlirUnsupported("a temporary with a user Drop read in place");
    const sl = this.bigSlot("tmp", e, true);
    return { ref: sl.ref, ty: sl.ty };
  }

  /** The slot `e` names (a `var`, a by-ref param, a field of either), or null for a value. */
  private fieldPlace(x: X): { ref: string; ty: string; param?: number } | null {
    const e = this.f(x);
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      return b.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : null;
    }
    if (e.kind === "IndexAccess") return this.elemRef(e);
    // A temporary box is no place: a read through it moves the payload out and frees the
    // box (the HeapDeref value), then drops what it read once the read is done.
    if (e.kind === "HeapDeref") return isTempBox(this.f(e.operand)) ? null : this.heapPlace(e);
    if (e.kind !== "FieldAccess") return null;
    const base = this.fieldPlace(e.object) ?? this.memTemp(e.object);
    if (!base) return null;
    const { index, ty } = this.field(e);
    const r = this.def(`milo.field_ref ${base.ref}[${index}] : !milo.ref<${base.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`);
    return { ref: r.ref, ty, param: base.param };
  }

  /**
   * A held box's 128+ byte owning payload lent to a by-ref param (`(*h).clone()`) is lent
   * where it sits: building it in a slot would have to copy an owner, which bigSlot cannot.
   * A plain-data payload keeps the copy into a slot that bigPlace makes.
   */
  private heapDerefLent(e: FormOf<"HeapDeref">): boolean {
    const pt = placeType(this.cx, this.ty(e.node));
    return pt !== null && valueType(this.cx, this.ty(e.node)) === null && this.hasDrop(pt);
  }

  /**
   * The box `op` (of type `hty`) is given up for a move of its payload: its pointer, and
   * `after` to run once the payload is out (a box held by a place is left empty, so no
   * drop of it ever runs on the leftover).
   */
  private takeBox(op: Form, hty: string): { h: string; after: () => void } {
    let h: string, after = () => {};
    if (isTempBox(op)) {
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
    return { h, after };
  }

  /**
   * `*h` as a place: the box's own pointer. The box must be a place's (a local, a field,
   * an element), not a temporary one, which is freed as soon as the payload is out.
   */
  private heapPlace(e: FormOf<"HeapDeref">): { ref: string; ty: string } {
    const op = this.f(e.operand);
    if (op.kind !== "Ident" && op.kind !== "FieldAccess" && op.kind !== "IndexAccess" && op.kind !== "HeapDeref")
      throw new MlirUnsupported("deref of a temporary box");
    // An element's box is read from the element's place: reading the element as a value
    // would copy (own) the box, which is what a temporary is.
    const slot = op.kind === "IndexAccess" ? this.elemRef(op) : null;
    const h = slot && /^!milo\.heap</.test(slot.ty)
      ? { ...this.def(`milo.load ${slot.ref} : !milo.ref<${slot.ty}>`, slot.ty), own: "view" as const }
      : this.expr(op);
    const m = /^!milo\.heap<(.*)>$/.exec(h.ty);
    if (!m || h.own === "owned") throw new MlirUnsupported("deref of a temporary box");
    const ty = m[1];
    return { ref: this.def(`milo.heap.place ${h.ref} : ${h.ty} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref, ty };
  }

  /**
   * `S { a: x, ..base }`: the listed fields in source order, then the base;
   * the unlisted fields come out of the base.
   */
  private structLit(e: FormOf<"StructLit">): Val {
    const ty = this.value(this.ty(e.node), "struct literal");
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout) throw new MlirUnsupported("struct layout");
    const given = new Map<string, Val>();
    const mark = this.pending.length;
    for (const f of e.fields) given.set(f.name, this.pend(this.fieldValue(f.value, layout.fields.find(lf => lf.name === f.name)?.typeKind), this.ty(f.value)));
    this.pending.length = mark;
    // The base is consumed: it gives up its unlisted fields and [MILO-O-structUpdate]
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
   * A user fork's ownership: owned when some arm yields [MILO-O-forkOwnership]
   * an owned value (the checker clones a place arm there), else a view (only views and
   * literals, or a view of a user-Drop type, which no clone may copy). Null: owns nothing.
   */
  // `sawView`: some arm of a view fork yielded a borrow (not only literals, which are static).
  private forks: { mode: "own" | "view" | null; sawView: boolean }[] = [];
  /** `left == right`, the emitter's own comparison (a literal pattern's test). */
  private eq(left: Node, right: Node): FormOf<"BinOp"> {
    return this.f(this.syn({ tag: "bool" }, n => ({ kind: "BinOp", node: n, op: "==", left, right }))) as FormOf<"BinOp">;
  }

  /** One match arm's body: a statement emitter runs as is; statements as the match's value or not. */
  private armRun(body: ArmBody, resultTy: string | null, armBody?: (body: Stmt[]) => boolean): boolean | Val {
    if (typeof body === "function") return body();
    return armBody ? armBody(body) : resultTy ? this.tail(body, resultTy) : this.stmts(body);
  }

  private forkMode(e: FormOf<"IfExpr" | "MatchExpr">, ty: string): "own" | "view" | null {
    if (!this.hasDrop(ty)) return null;
    return this.cx.mlirBlockValueOwnsResult(e) ? "own" : "view";
  }

  private tail(body: Stmt[], ty: string): true | Val {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt" || this.diverges(last.expr)) {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    // The value statement skips stmt(), where every other statement gets its guards.
    this.lazyGuards(last);
    const tf = this.f(last.expr);
    const armLocal = tf.kind === "Ident" ? this.scopes[this.scopes.length - 1].get(tf.name) : undefined;
    // The block's own binding (an arm's payload, as `let ... else` makes one) is moved out,
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
      // the fork owns what it yields on every path. [MILO-O-forkOwnership]
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
  private tailInto(body: Stmt[], dst: string, ty: string): boolean {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt" || this.diverges(last.expr)) {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    // The value statement skips stmt(), where every other statement gets its guards.
    this.lazyGuards(last);
    const tf = this.f(last.expr);
    const armLocal = tf.kind === "Ident" ? this.scopes[this.scopes.length - 1].get(tf.name) : undefined;
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
  private match(m: MatchIn,
    resultTy: string | null, armBody?: (body: Stmt[]) => boolean): { done: boolean; v: Val } {
    // `match e {}` on an uninhabited type: no value reaches it (unreachable).
    if (m.arms.length === 0) {
      this.peek(m.subject, v => v);
      this.emit("milo.unreachable");
      return { done: true, v: { ref: "", ty: "" } };
    }
    const outer = { scope: this.scopes[this.scopes.length - 1], frame: this.blocks[this.blocks.length - 1] };
    let root = this.f(m.subject);
    while (root.kind === "FieldAccess") root = this.f(root.object);
    const subjLives = root.kind === "Ident";
    // An owning subject matched by value moves its payload into the bindings
    // (zeroed in the subject); matched by reference, bindings are views.
    const subjPlaceTy = placeType(this.cx, this.ty(m.subject));
    // A 128+ byte enum is matched through its place: a switch on the tag read there
    // (milo.enum.tag_at), each binding the payload field's place (milo.enum.field_ref).
    const bigEnum = subjPlaceTy !== null && inSlot(this.cx, subjPlaceTy) && subjPlaceTy.startsWith("!milo.enum<");
    const owning = this.hasDrop(bigEnum ? subjPlaceTy! : this.value(this.ty(m.subject), "match subject"));
    // By value, the owned slot the subject lives in: an arm that binds an owning payload
    // field moves the subject out of it (milo.move), so drop elaboration sees it empty on
    // that path and full on the others.
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
        const e = this.f(m.subject);
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
    } else if (owning && !m.subjectIsRef && !this.borrowedString(m.subject)) {
      const e = this.f(m.subject);
      const b = e.kind === "Ident" ? this.lookup(e.name) : null;
      if (b?.kind === "var" && b.owned) from = b.ref;
      else {
        const v = this.expr(e);
        if (v.own !== "owned") throw new MlirUnsupported("match moving out of a borrowed enum");
        // A `v[i]` subject is its element's structural clone (tempSlot): its bindings only
        // borrow from it, so none takes a payload with a drop of its own.
        const clone = e.kind === "IndexAccess" && this.clones.has(v.ref);
        from = this.tempSlot("subject", v.ty, this.ty(e.node), v, clone);
        this.emit(`milo.store ${v.ref}, ${from} : !milo.ref<${v.ty}>`);
        if (clone) structural = true;
      }
      const ty = this.value(this.ty(e.node), "match subject");
      subj = { ...this.def(`milo.load ${from} : !milo.ref<${ty}>`, ty), own: "view" };
    } else {
      // Read in place; a `v[i]` subject is its element's structural clone (tempSlot).
      const v = this.expr(m.subject);
      if (this.k(m.subject) === "IndexAccess" && this.clones.has(v.ref)) {
        const slot = this.tempSlot("subject", v.ty, this.ty(m.subject), v, true);
        this.emit(`milo.store ${v.ref}, ${slot} : !milo.ref<${v.ty}>`);
        subj = { ...this.def(`milo.load ${slot} : !milo.ref<${v.ty}>`, v.ty), own: "view" };
      } else subj = this.borrow(v, this.ty(m.subject));
    }
    const isEnum = bigEnum || subj.ty.startsWith("!milo.enum<");
    // A float subject compares every literal as a float (fcmp oeq), int patterns too.
    if (!isEnum && (/^f\d+$/.test(subj.ty) || m.arms.some(a => a.pattern.kind === "LiteralPattern" && (a.pattern.literalKind === "string" || a.pattern.literalKind === "float"))))
      return this.literalChain(m.arms, subj, stripRefs(this.ty(m.subject)), resultTy, armBody);
    const st = stripRefs(this.ty(m.subject));
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
        // First match wins: arms after `_` are dead (the checker rejects them).
        dflt = arm;
        break;
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
      // The subject is no longer dropped once an arm takes a payload, so an owning field
      // the arm leaves unbound would leak: unsupported, not reproduced.
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
            // place (bound by address); a Copy payload under `&` is a copy.
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
          // A binding is a mutable copy of the payload:
          // `c.bump()` in the arm changes the binding.
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const slot = this.fresh();
            this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            this.emit(`milo.store ${refs[k]}, ${slot} : !milo.ref<${a.ty}>`);
            bd.bind(a.name, { kind: "var", ref: slot, ty: a.ty }, this.hasDrop(a.ty));
          });
        }
        return this.armRun(arm.body, resultTy, armBody);
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
   * arm (let-else's), in the block the match sits in, whose end drops an owning one (those are
   * left to the enclosing scope's drops). An escaping view reads a subject that outlives the
   * match, one rooted at a binding (`subjLives`). A temporary subject (`v[i].f`, a clone of
   * the element, or a call's result) dies with the match's statement, so a binding that
   * escapes it owns a copy, taken while the subject still lives.
   */
  private armBinder(p: Pat, outer: MatchOuter, subjLives: boolean): ArmBinder {
    const esc = new Set(p.kind === "EnumPattern" ? p.bindings.filter(b => b.escapes).map(b => b.name) : []);
    return {
      bind: (name, b, view) => {
        if (!esc.has(name)) { this.bind(name, b); return; }
        if (view && !subjLives) {
          const t = p.kind === "EnumPattern" ? p.bindings.find(x => x.name === name)?.type : undefined;
          if (!t || b.kind !== "var") throw new MlirUnsupported("escaping view of a temporary subject");
          const c = this.cloneTo(stripRefs(t), b.ref, `!milo.ref<${b.ty}>`, b.ty);
          if (!c) throw new MlirUnsupported("escaping view of a temporary subject that has no clone glue");
          const slot = this.ownedSlot(name, b.ty, stripRefs(t), false, outer.frame);
          this.emit(`milo.store ${c.ref}, ${slot} init : !milo.ref<${b.ty}>`);
          outer.scope.set(name, { kind: "var", ref: slot, ty: b.ty, owned: true });
          return;
        }
        outer.scope.set(name, b);
      },
      owned: (name, ty, t) => this.ownedSlot(name, ty, t, false, esc.has(name) ? outer.frame : false),
    };
  }

  /** An enum's layout, or the unsupported reason. */
  private enumLayout(name: string): NonNullable<ReturnType<MlirEmitCtx["mlirEnumLayout"]>> {
    const l = this.cx.mlirEnumLayout(name);
    if (!l) throw new MlirUnsupported("match subject layout");
    return l;
  }

  /**
   * The subject is no longer dropped once an arm takes a payload, so an owning part the
   * arm leaves unbound would leak: unsupported, not reproduced.
   */
  private leaksUnbound(): never { throw new MlirUnsupported("match leaving an owning payload field unbound"); }

  /**
   * A match with a nested arm: arms are tried in order, each by
   * its top tag and then its sub-pattern tests, and the first that passes runs. Testing
   * only reads the subject, so the choice is made first, as the arm's index (milo.ifs, a
   * test short-circuiting the ones after it, since a test's path reads a payload that only
   * the tests before it prove is there); a milo.match on the index then runs the arm,
   * which binds each payload at its path with a flat arm's move/borrow rule.
   */
  private nestedMatch(m: MatchIn,
    s: { subj: Val; from: string | null; place: { ref: string; ty: string } | null; structural: boolean; bigEnum: boolean; enumName: string },
    outer: MatchOuter, subjLives: boolean, resultTy: string | null, armBody?: (body: Stmt[]) => boolean): { done: boolean; v: Val } {
    const { subj, place, bigEnum } = s;
    const key = (path: PatStep[]) => path.map(st => `${st.variant}.${st.index}`).join("/");
    // Payload places escaping bindings name, taken ahead of the match (as for a flat arm).
    const pre = new Map<string, Val>();
    const variantOf = (enumName: string, pick: (v: { name: string; tag: number }) => boolean) => {
      return this.enumLayout(enumName).variants.find(pick)!;
    };
    // The payload `path` names: its place (a field_ref chain) when `inPlace`, else its value.
    const walk = (path: PatStep[], inPlace: boolean, root?: Val): Val => {
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
    const fieldType = (path: PatStep[]): TypeKind => {
      const st = path[path.length - 1];
      return variantOf(st.enumName, x => x.name === st.variant).fields[st.index];
    };
    const eqTag = (tag: Val, want: number): Val =>
      this.def(`milo.cmp eq, ${tag.ref}, ${this.def(`milo.const ${want} : si32`, "si32").ref} : si32`, "i1");
    // A 128+ byte subject is tested in its place; any other through its value.
    const tagAt = (path: PatStep[]): Val => {
      if (bigEnum && path.length === 0) return subj;
      const at = walk(path, bigEnum);
      return bigEnum ? this.def(`milo.enum.tag_at ${at.ref} : ${at.ty}`, "si32") : this.def(`milo.enum.tag ${at.ref} : ${at.ty}`, "si32");
    };
    const litTest = (t: PatTest & { kind: "lit" }): Val => {
      let v = walk(t.path, bigEnum);
      if (bigEnum) {
        const ty = v.ty.slice("!milo.ref<".length, -1);
        v = this.def(`milo.load ${v.ref} : ${v.ty}`, ty);
      }
      const name = `match$lit${this.n++}`;
      this.bind(name, { kind: "ssa", v: { ...v, own: this.hasDrop(v.ty) ? "view" : undefined } });
      const left = this.synIdent(name, t.type);
      return this.binop(this.eq(left, patLiteral(this.fx, t.literalKind, t.value, t.type)));
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
    const pathOf = (p: Pat & { kind: "EnumPattern" }, k: number) => p.bindings[k].path ?? [{ enumName: s.enumName, variant: p.variant, index: k }];
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
        return this.armRun(arm.body, resultTy, armBody);
      });
      if (!done) allDone = false;
    });
    this.emit("}");
    if (!resultTy && !armBody && allDone) { this.emit("milo.unreachable"); return { done: true, v: { ref: "", ty: "" } }; }
    return { done: false, v: { ref, ty: resultTy ?? "", own: resultTy && this.hasDrop(resultTy) ? "owned" : undefined } };
  }

  /**
   * A nested arm's bindings, each the payload at its path:
   * matched by value with an owning payload bound, the subject is moved out (milo.move)
   * and each binding owns its payload, and a string a literal test matched is dropped
   * (freed rather than leaked); otherwise each binding is a copy of its payload
   * or, through `&mut` or for one with drop glue, the payload's place.
   */
  private bindPaths(p: Pat & { kind: "EnumPattern" },
    s: { subj: Val; from: string | null; place: { ref: string; ty: string } | null; structural: boolean; bigEnum: boolean; enumName: string },
    bd: ArmBinder, walk: (path: PatStep[], inPlace: boolean, root?: Val) => Val, fieldType: (path: PatStep[]) => TypeKind,
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
        // place (bound by address); a Copy payload under `&` is a copy.
        if (subjectIsMut || this.hasDrop(b.ty) || inSlot(this.cx, b.ty)) { bd.bind(b.name, { kind: "var", ref: r.ref, ty: b.ty }, true); continue; }
        plain(b.name, b.ty, this.def(`milo.load ${r.ref} : ${r.ty}`, b.ty).ref);
      }
      return;
    }
    // Every owning part of the subject must leave with a binding or be a matched string,
    // or it would leak (the subject is no longer dropped): unsupported, not reproduced.
    const key = (path: PatStep[]) => path.map(st => `${st.variant}.${st.index}`).join("/");
    const bound = new Set(binds.map(b => key(b.path)));
    const tests = new Map((p.tests ?? []).map(t => [key(t.path), t]));
    const lits: { path: PatStep[]; t: TypeKind; ty: string }[] = [];
    const visit = (enumName: string, variant: { name: string; fields: TypeKind[] }, path: PatStep[]) => variant.fields.forEach((f, k) => {
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
   * `x?`: `Ok(v) => v` (tag 0, Some for an Option), `Err(e) => return Err(e)` in the
   * function's result enum, the error converted first (its From variant, its message, or
   * boxed as the interface). As milo.try (E-PROPAGATE, lowered by milo-desugar) when the
   * subject is an SSA value the try consumes whole and the payload is one too: the error
   * path is its region, a return statement, so the scope drops run before it. A subject or
   * payload that lives in memory (128+ bytes) is the match it means, built in place.
   */
  private propagate(e: FormOf<"Propagate">, into?: { dst: string; ty: string }): Val {
    const src = this.cx.mlirEnumLayout(e.enumName);
    const ret = e.retType.tag === "enum" ? this.cx.mlirEnumLayout(e.retType.name) : null;
    const isErr = (v: { name: string }) => v.name === "Err" || v.name === "None";
    const ok = src?.variants.find(v => v.tag === 0);
    const err = src?.variants.find(isErr);
    const retErr = ret?.variants.find(isErr);
    if (!ok || !err || !retErr || ok.fields.length > 1 || err.fields.length !== retErr.fields.length || err.fields.length > 1) throw new MlirUnsupported("`?` enum layout");
    const n = this.n++;
    const okName = `prop$ok${n}`, errName = `prop$err${n}`;
    const rt = this.ty(e.node);
    // The returned error: `Err(conv(e))` of the fn's result enum.
    const errReturn = (): Stmt[] => {
      let errVal: Expr | null = err.fields.length ? this.synIdent(errName, err.fields[0], true) : null;
      if (e.boxConversion) {
        // `?` into a `Result<T, Heap<I>>` fn: the error, wrapped in [MILO-O-propagate]
        // its one-field message struct first when `viaMessage` (a string as ErrorMessage),
        // boxed and coerced to the interface, as `Heap(e)` coerced to `Heap<I>`.
        if (!errVal) throw new MlirUnsupported("`?` boxing of a payload-less error");
        errVal = this.boxError(errVal, e.boxConversion);
      } else if (e.messageFn) {
        // `?` into a `Result<T, string>` fn: the error's message() is [MILO-O-propagate]
        // the string; the typed error stays the arm's binding, so its scope drops it.
        if (!errVal) throw new MlirUnsupported("`?` message of a payload-less error");
        const fn = e.messageFn.fn;
        const arg = this.arg(this.synIdent(errName, err.fields[0]), true);
        errVal = this.syn({ tag: "string" }, x => ({ kind: "Call", node: x, func: fn, args: [arg], variadic: false }));
      } else if (e.fromConversion) {
        const target = retErr.fields[0];
        if (!errVal || target?.tag !== "enum" || target.name !== e.fromConversion.targetEnumName) throw new MlirUnsupported("`?` conversion layout");
        const inner = errVal, variant = e.fromConversion.wrapVariant;
        errVal = this.syn(target, x => ({ kind: "EnumLit", node: x, enumName: target.name, variant, args: [inner] }));
      }
      const args = errVal ? [errVal] : [];
      const value = this.syn(e.retType, x => ({ kind: "EnumLit", node: x, enumName: (e.retType as { name: string }).name, variant: retErr.name, args }));
      return [{ kind: "Return", value, span: e.span }];
    };
    const subjTy = placeType(this.cx, this.ty(e.operand));
    const okTy = ok.fields.length ? valueType(this.cx, rt) : null;
    if (!into && subjTy !== null && isSsa(this.cx, subjTy) && !inSlot(this.cx, subjTy) && (ok.fields.length === 0 || okTy !== null)) {
      // The subject is taken whole: an owning one must be the checker's move or a temporary.
      const v = this.expr(e.operand);
      if (this.hasDrop(v.ty) && v.own !== "owned") throw new MlirUnsupported("match moving out of a borrowed enum");
      if (v.ty !== subjTy) throw new MlirUnsupported("`?` subject type");
      const pty = err.fields.length ? this.value(err.fields[0], "`?` error") : null;
      const ref = okTy ? this.fresh() : "";
      // E-PROPAGATE: the error path, a region of its own whose binding owns the payload.
      this.region(`${okTy ? `${ref} = ` : ""}milo.try ${v.ref} : ${v.ty}${okTy ? ` -> ${okTy}` : ""} ok ${ok.tag} err ${err.tag} {`, () => {
        if (pty) {
          const a = this.fresh();
          this.emit(`^bb0(${a}: ${pty}):`);
          if (this.hasDrop(pty)) {
            const slot = this.ownedSlot(errName, pty, err.fields[0]);
            this.emit(`milo.store ${a}, ${slot} : !milo.ref<${pty}>`);
            this.bind(errName, { kind: "var", ref: slot, ty: pty, owned: true });
          } else this.bind(errName, { kind: "ssa", v: { ref: a, ty: pty } });
        }
        return this.stmts(errReturn());
      });
      this.emit(`} ${this.loc(e.span)}`);
      return okTy ? { ref, ty: okTy, own: this.hasDrop(okTy) ? "owned" : undefined } : { ref: "", ty: "" };
    }
    const okArm = {
      pattern: { kind: "EnumPattern" as const, variant: ok.name, tag: 0, bindings: ok.fields.length ? [{ name: okName, type: ok.fields[0] }] : [] },
      body: ok.fields.length ? [{ kind: "ExprStmt" as const, expr: this.synIdent(okName, rt, true) }] : [],
    };
    const errArm = {
      pattern: { kind: "EnumPattern" as const, variant: err.name, tag: err.tag, bindings: err.fields.length ? [{ name: errName, type: err.fields[0] }] : [] },
      body: () => this.stmts(errReturn()),
    };
    if (into) return this.match({ subject: e.operand, arms: [okArm, errArm] }, null, b => this.tailInto(b, into.dst, into.ty)).v;
    const resultTy = ok.fields.length ? this.value(rt, "`?` result") : null;
    this.forks.push({ mode: null, sawView: false });
    try { return this.match({ subject: e.operand, arms: [okArm, errArm] }, resultTy).v; } finally { this.forks.pop(); }
  }

  /** The error `v` boxed as its interface: a string first wrapped in its message struct. */
  private boxError(v: Expr, box: NonNullable<FormOf<"Propagate">["boxConversion"]>): Expr {
    let inner: Expr = v;
    const boxed: TypeKind = box.viaMessage ? { tag: "struct", name: box.fromType } : box.errType;
    if (box.viaMessage) {
      const f0 = this.cx.structLayouts.get(box.fromType)?.fields[0];
      if (!f0) throw new MlirUnsupported("error boxing layout");
      inner = this.syn(boxed, x => ({ kind: "StructLit", node: x, name: box.fromType, fields: [{ name: f0.name, value: v }] }));
    }
    const heap = this.syn({ tag: "heap", inner: boxed }, x => ({ kind: "HeapCreate", node: x, value: inner }));
    return this.syn({ tag: "heap", inner: { tag: "interface", name: box.ifaceName } }, x => ({ kind: "InterfaceCoerce", node: x, value: heap, fromType: box.fromType, ifaceName: box.ifaceName }));
  }

  /**
   * `r.context(note)` as the match it means: `Ok(x) => Ok(x)`, and
   * `Err(e) => Err(Heap(ErrorContext { note, cause }))` as a `Heap<Error>`, the cause e
   * boxed as an Error first when it is not one. The note is evaluated first, into an owned
   * slot: the Err arm moves it into the context, the Ok arm leaves it to be dropped.
   */
  private resultContext(e: FormOf<"OptionOp">): Val {
    const rt = this.ty(e.node);
    const src = this.cx.mlirEnumLayout(e.enumName), res = rt.tag === "enum" ? this.cx.mlirEnumLayout(rt.name) : null;
    const ok = src?.variants.find(v => v.name === "Ok"), err = src?.variants.find(v => v.name === "Err");
    const rok = res?.variants.find(v => v.name === "Ok"), rerr = res?.variants.find(v => v.name === "Err");
    const ctx = this.cx.structLayouts.get("ErrorContext");
    if (!ok || !err || !rok || !rerr || !ctx || ctx.fields.length !== 2 || err.fields.length !== 1 || ok.fields.length > 1 || !e.default) throw new MlirUnsupported("context layout");
    const n = this.n++;
    const noteName = `ctx$note${n}`, okName = `ctx$ok${n}`, errName = `ctx$err${n}`;
    const note = this.consume(this.expr(e.default), "context note");
    if (note.ty !== STR) throw new MlirUnsupported("context note type");
    const slot = this.ownedSlot("ctx.note", STR, { tag: "string" });
    this.emit(`milo.store ${note.ref}, ${slot} init : !milo.ref<${STR}>`);
    this.bind(noteName, { kind: "var", ref: slot, ty: STR, owned: true });
    const errVal = this.synIdent(errName, err.fields[0], true);
    const cause = e.boxConversion ? this.boxError(errVal, e.boxConversion) : errVal;
    const ctxTy: TypeKind = { tag: "struct", name: "ErrorContext" };
    const lit = this.syn(ctxTy, x => ({ kind: "StructLit", node: x, name: "ErrorContext",
      fields: [{ name: ctx.fields[0].name, value: this.synIdent(noteName, { tag: "string" }, true) }, { name: ctx.fields[1].name, value: cause }] }));
    const heap = this.syn({ tag: "heap", inner: ctxTy }, x => ({ kind: "HeapCreate", node: x, value: lit }));
    const boxed = this.syn(rerr.fields[0], x => ({ kind: "InterfaceCoerce", node: x, value: heap, fromType: "ErrorContext", ifaceName: "Error" }));
    const rname = (rt as { name: string }).name;
    const okArgs = ok.fields.length ? [this.synIdent(okName, ok.fields[0], true)] : [];
    const arms = [
      { pattern: { kind: "EnumPattern" as const, variant: "Ok", tag: ok.tag, bindings: ok.fields.length ? [{ name: okName, type: ok.fields[0] }] : [] },
        body: [{ kind: "ExprStmt" as const, expr: this.syn(rt, x => ({ kind: "EnumLit", node: x, enumName: rname, variant: "Ok", args: okArgs })) }] },
      { pattern: { kind: "EnumPattern" as const, variant: "Err", tag: err.tag, bindings: [{ name: errName, type: err.fields[0] }] },
        body: [{ kind: "ExprStmt" as const, expr: this.syn(rt, x => ({ kind: "EnumLit", node: x, enumName: rname, variant: "Err", args: [boxed] })) }] },
    ];
    // The receiver is consumed: matched by value whatever the checker marked it.
    const subject = this.syn(this.ty(e.value), x => ({ ...this.f(e.value), node: x }));
    this.fx.syn(subject, this.ty(e.value), { move: true });
    this.forks.push({ mode: null, sawView: false });
    try { return this.match({ subject, arms }, this.value(rt, "context result")).v; } finally { this.forks.pop(); }
  }

  /**
   * `x ?? d` as the match it means: `Some(v) => v` (tag 0; Ok),
   * anything else evaluates `d`. The subject is consumed only on the first arm.
   */
  private defaultValue(e: FormOf<"DefaultValue">, into?: { dst: string; ty: string }): Val {
    const ok = this.cx.mlirEnumLayout(e.enumName)?.variants.find(v => v.tag === 0);
    if (!ok || ok.fields.length !== 1) throw new MlirUnsupported("`??` enum layout");
    const name = `dflt$v${this.n++}`;
    const arms = [
      { pattern: { kind: "EnumPattern" as const, variant: ok.name, tag: 0, bindings: [{ name, type: ok.fields[0] }] },
        body: [{ kind: "ExprStmt" as const, expr: this.synIdent(name, this.ty(e.node), true) }] },
      { pattern: { kind: "WildcardPattern" as const }, body: [{ kind: "ExprStmt" as const, expr: this.asExpr(e.default) }] },
    ];
    if (into) return this.match({ subject: e.operand, arms }, null, b => this.tailInto(b, into.dst, into.ty)).v;
    this.forks.push({ mode: null, sawView: false });
    try { return this.match({ subject: e.operand, arms }, this.value(this.ty(e.node), "`??` result")).v; } finally { this.forks.pop(); }
  }

  /**
   * A match on a string or a float: no switch, so the arms are tested in order, each an
   * `==` of the subject with the literal (strings by their bytes), nested
   * milo.ifs with the `_` arm innermost.
   */
  private literalChain(arms: MatchIn["arms"], subj: Val, subjTy: TypeKind, resultTy: string | null, armBody?: (body: Stmt[]) => boolean): { done: boolean; v: Val } {
    const name = `match$subject${this.n++}`;
    this.bind(name, { kind: "ssa", v: subj });
    const subject = this.synIdent(name, subjTy);
    const lit = (p: Pat & { kind: "LiteralPattern" }): Expr => patLiteral(this.fx, p.literalKind, p.value, subjTy);
    const arm = (i: number): boolean | Val => {
      if (i === arms.length) { this.emit("milo.unreachable"); return true; }
      const { pattern: p, body } = arms[i];
      const run = () => this.armRun(body, resultTy, armBody);
      if (p.kind === "WildcardPattern") return run();
      if (p.kind !== "LiteralPattern") throw new MlirUnsupported("enum pattern on a scalar");
      const c = this.binop(this.eq(subject, lit(p)));
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

  /** A call of a module function by symbol (a runtime section); `args` are `value : type`. */
  private callHelper(name: string, args: string[], ret: string | null): Val {
    const refs = args.map(a => a.split(" : ")[0]);
    const tys = args.map(a => a.slice(a.indexOf(" : ") + 3));
    const fnTy = `(${tys.join(", ")}) -> ${ret ?? "()"}`;
    this.callees.set(name, fnTy);
    const call = `func.call @${quote(name)}(${refs.join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return this.def(call, ret);
  }

  /** `a == b`, `a < b`, `a + b` on two borrowed strings. */
  private stringBinop(e: FormOf<"BinOp">): Val {
    const names: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "+": "concat" };
    const op = names[e.op];
    if (!op) throw new MlirUnsupported(`string ${e.op}`);
    const l = this.borrow(this.expr(e.left), this.ty(e.left));
    const r = this.borrow(this.expr(e.right), this.ty(e.right));
    if (op === "concat") {
      // Both helpers: milo-append-in-place may turn `s = s + x` into the append.
      return { ...this.def(`milo.string.concat ${l.ref}, ${r.ref}`, STR), own: "owned" };
    }
    const slot = (v: Val) => {
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var "operand" : !milo.ref<${STR}>`);
      this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${STR}>`);
      return ref;
    };
    const [a, b] = [slot(l), slot(r)];
    // Runtime sections (std/rt.milo): equality, and a three-way compare for order.
    const eq = op === "eq" || op === "ne";
    const name = eq ? "rtStringEq" : "rtStringCmp";
    const fnTy = `(!milo.ref<${STR}>, !milo.ref<${STR}>) -> ${eq ? "i1" : "si32"}`;
    this.callees.set(name, fnTy);
    const c = this.def(`func.call @${quote(name)}(${a}, ${b}) : ${fnTy}`, eq ? "i1" : "si32");
    if (op === "eq") return c;
    if (op === "ne") return this.def(`milo.not ${c.ref} : i1`, "i1");
    const zero = this.def("milo.const 0 : si32", "si32");
    return this.def(`milo.cmp ${op}, ${c.ref}, ${zero.ref} : si32`, "i1");
  }

  private binop(e: FormOf<"BinOp">): Val {
    if (e.op === "&&" || e.op === "||" || e.op === "==>") {
      // `a ==> b` is `if a { b } else { true }`. `a && b` is `if a { b } else { false }`: b runs only when a does not decide it.
      const l = this.expr(e.left);
      if (l.ty !== "i1") throw new MlirUnsupported("logical operand type");
      const ref = this.fresh();
      const isAnd = e.op !== "||";
      const rhs = () => {
        const r = this.expr(e.right);
        if (r.ty !== "i1") throw new MlirUnsupported("logical operand type");
        return r;
      };
      const lit = () => this.def(`milo.const ${e.op !== "&&"}`, "i1");
      this.region(`${ref} = milo.if ${l.ref} -> i1 {`, isAnd ? rhs : lit);
      this.region("} else {", isAnd ? lit : rhs);
      this.emit("}");
      return { ref, ty: "i1" };
    }
    if (stripRefs(this.ty(e.left)).tag === "string" && stripRefs(this.ty(e.right)).tag === "string") return this.stringBinop(e);
    const lt = stripRefs(this.ty(e.left));
    if ((e.op === "==" || e.op === "!=") && lt.tag === "enum") {
      // The tags compared (the checker allows `==` only on payload-free enums).
      const l = this.expr(e.left), r = this.expr(e.right);
      if (l.ty !== r.ty || !l.ty.startsWith("!milo.enum<") || this.hasDrop(l.ty)) throw new MlirUnsupported("binop operand types");
      const a = this.def(`milo.enum.tag ${l.ref} : ${l.ty}`, "si32"), b = this.def(`milo.enum.tag ${r.ref} : ${r.ty}`, "si32");
      return this.def(`milo.cmp ${CMPS[e.op]}, ${a.ref}, ${b.ref} : si32`, "i1");
    }
    const ty = scalar(this.ty(e.left), "binop operand");
    if (ty === PTR && !(e.op in CMPS)) throw new MlirUnsupported(`pointer ${e.op}`);
    const l = this.expr(e.left), r = this.expr(e.right);
    if (l.ty !== ty || r.ty !== ty) throw new MlirUnsupported("binop operand types");
    if (e.op in CMPS) return this.def(`milo.cmp ${CMPS[e.op]}, ${l.ref}, ${r.ref} : ${ty}`, "i1");
    if (scalar(this.ty(e.node), "binop result") !== ty) throw new MlirUnsupported("binop result type");
    if (e.op in BITS) {
      if (ty.startsWith("f")) throw new MlirUnsupported("bitwise op on a float");
      return this.def(`milo.${BITS[e.op]} ${l.ref}, ${r.ref} : ${ty}`, ty);
    }
    const op = ARITH[e.op];
    if (!op) throw new MlirUnsupported(`binop ${e.op}`);
    const isInt = ty.startsWith("s") || ty.startsWith("u");
    if (!isInt && (op === "shl" || op === "shr")) throw new MlirUnsupported("shift of a non-int");
    if (ty === "i1") throw new MlirUnsupported("arithmetic on bool");
    // + - * trap only with overflow checks on, outside @wrapping,
    // and with a span; / % << >> trap unless @wrapping.
    const wrapping = isInt && (op === "add" || op === "sub" || op === "mul"
      ? !(this.cx.trapOnOverflow && !this.fn.isWrapping && e.span)
      : !!this.fn.isWrapping);
    return this.def(`milo.${op} ${l.ref}, ${r.ref}${wrapping ? " wrapping" : ""} : ${ty}`, ty, isInt ? this.loc(e.span) : "");
  }


  /**
   * `for x in it` over an iterator, as the loop it means:
   * `while true { match next(&mut it) { Some(x) => body, None => break } }`. The binding
   * owns each element. A temporary iterable is first bound to a `var`
   * of the enclosing block (a Block opens no scope), which drops it when that block
   * exits.
   */
  private forIterator(s: { varName: string; varType: TypeKind; iterable: Expr; nextMethod: string; optionEnumName: string; body: Stmt[]; invariants: Contract[]; span?: Span }): boolean {
    const layout = this.cx.mlirEnumLayout(s.optionEnumName);
    const some = layout?.variants.find(v => v.name === "Some"), none = layout?.variants.find(v => v.name === "None");
    if (!some || !none || some.fields.length !== 1) throw new MlirUnsupported("iterator option layout");
    const k = this.k(s.iterable);
    // An element's address is taken once; the loop below would index again per next().
    if (k === "IndexAccess") throw new MlirUnsupported("for over an iterator element");
    const itTy = this.ty(s.iterable);
    let it: Expr = s.iterable;
    if (k !== "Ident" && k !== "FieldAccess") {
      // E-NEW-ITER: an rvalue iterator lives in a `var` of the enclosing block, dropped once
      // when that block ends.
      const name = `__iter.${this.fresh().slice(1)}`;
      this.letStmt(name, s.iterable, true, false, s.span);
      it = this.synIdent(name, itTy, false, s.span);
    }
    const optTy: TypeKind = { tag: "enum", name: s.optionEnumName };
    const next = this.syn(optTy, n => ({ kind: "Call", node: n, span: s.span, func: s.nextMethod, args: [this.arg(it, true, true)], variadic: false }));
    this.loops++; this.loopBase.push(this.pending.length);
    this.region("milo.loop {", () => {
      // The match is a statement of the body: its subject's temporaries die at its end.
      this.owned.push([]);
      const start = this.body.length;
      const done = this.match({ subject: next, arms: [
        { pattern: { kind: "EnumPattern", variant: "Some", tag: some.tag, bindings: [{ name: s.varName, type: s.varType }] }, body: () => this.loopBody(s.body, s.invariants) },
        { pattern: { kind: "EnumPattern", variant: "None", tag: none.tag, bindings: [] }, body: () => this.stmtCore({ kind: "BreakStmt", span: s.span }) },
      ] }, null).done;
      this.closeScope(start, done, null);
      return done;
    });
    this.emit("}");
    this.loops--; this.loopBase.pop();
    return false;
  }

  /**
   * An immutable binding held as an SSA value, moved to a slot because its address is
   * taken: from here on it lives there, so a write through the
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

  private unop(e: FormOf<"UnaryOp">): Val {
    if (e.op === "&") {
      // `x.addrOf()`: the address of a place.
      const of = this.f(e.operand);
      if (of.kind === "Ident") {
        const b = this.lookup(of.name);
        if (b.kind === "vec") return this.def(`milo.addr ${b.ref} : !milo.vec<${b.elem}>`, PTR);
        if (b.kind === "var") return this.def(`milo.addr ${b.ref} : !milo.ref<${b.ty}>`, PTR);
        const ref = this.spill(of.name, b.v);
        return this.def(`milo.addr ${ref} : !milo.ref<${b.v.ty}>`, PTR);
      }
      // A place behind a pointer (`data[i].addrOf()`) is its address already.
      const pp = this.ptrPlace(e.operand);
      if (pp) return { ref: pp.ptr, ty: PTR };
      // A field of an immutable binding held as an SSA value: the binding moves to a slot.
      let root: Form = of;
      while (root.kind === "FieldAccess") root = this.f(root.object);
      if (root !== of && root.kind === "Ident") {
        const rb = this.lookup(root.name);
        if (rb.kind === "ssa") this.spill(root.name, rb.v);
      }
      // `v[i].addrOf()` of a Vec of scalars: the element's place, bounds-checked (scalarElem).
      const p = this.fieldPlace(e.operand) ?? this.scalarElem(e.operand);
      if (!p) {
        let r: Form = of, path = "";
        while (r.kind === "FieldAccess") { path += ".f"; r = this.f(r.object); }
        throw new MlirUnsupported(`address of a value (${r.kind === "Ident" ? this.lookup(r.name).kind : r.kind}${path})`);
      }
      return this.def(`milo.addr ${p.ref} : !milo.ref<${p.ty}>`, PTR);
    }
    const ty = scalar(this.ty(e.node), "unop");
    if (ty === PTR) throw new MlirUnsupported(`unop ${e.op} on a pointer`);
    if (e.op === "-") {
      // A negated literal is a constant, as in codegen: i32's MIN is spelled
      // `-2147483648` and must not reach a checked negation of 2147483648.
      const lit = this.f(e.operand), lt = this.ty(e.operand);
      if (lit.kind === "IntLit" && lt.tag === "int" && lt.signed) {
        if (scalar(this.ty(e.operand), "literal") !== ty) throw new MlirUnsupported("negated literal type");
        return this.def(`milo.const ${-BigInt(lit.value)} : ${ty}`, ty);
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
   * first, then the index; a narrower
   * index widens by its own signedness, which milo.cast does.
   */
  private indexPlace(e: FormOf<"IndexAccess">): { vec: string; elem: string; index: string } {
    const { place, elem } = this.vecPlace(e.object);
    // An element that owns is cloned (a Vec index hands out an independent value).
    if (!isScalarTy(elem)) throw new MlirUnsupported("index into a Vec of non-scalars");
    const index = this.index(e.index);
    return { vec: place, elem, index };
  }

  /**
   * `v[i]` on a Vec of non-scalars as its element's place (milo.index.ref, bounds-checked),
   * lends it; null for any other index. Object, then index.
   */
  private elemRef(x: X): { ref: string; ty: string; param?: number } | null {
    const e = this.f(x);
    if (e.kind !== "IndexAccess") return null;
    const ot = stripRefs(this.ty(e.object));
    if (ot.tag === "array" && ot.size !== null) {
      // A fixed-size array's element, of any type, through the array's place.
      const at = this.place$(ot, "indexed array");
      const k = this.k(e.object);
      // A temporary array (`fixed()[2]`) is built in a slot of the statement, which drops
      // it at the statement's end; its element is read from there.
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
  private vecPlace(x: X): { place: string; elem: string; param?: number } {
    const e = this.f(x);
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
      if (v.own === "owned" && !this.bitCopies.has(v.ref)) ref = this.tempSlot("vec", v.ty, this.ty(e.node), v);
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

  /** An index operand as si64: a narrower int widens by its own signedness. */
  private index(x: X): string {
    const e = this.f(x);
    const i = this.expr(e);
    if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
    return i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
  }

  /**
   * The one way a by-ref position (a call's `&T` / `&mut T` argument, a helper's place
   * operand) lends `e` as `refTy` (lentType): a place (a
   * slot, a by-ref param, a field or an element of one) is lent where it is, a Vec as its
   * header; a value gets a slot: an owned temporary's owns it until the
   * call's frame closes (tempSlot), anything else's drops nothing (whatever owns the value
   * outlives the call). `&mut` of a value would hand the callee a copy to write.
   */
  private place(x: X, refTy: string, mut: boolean): { ref: string; param?: number } {
    const e = this.f(x);
    const pb = this.ptrBinding(e);
    if (pb) {
      // Lent to a call where it is, by pointer.
      if (refTy !== `!milo.ref<${pb.ty}>`) throw new MlirUnsupported(`by-ref arg of another type (pointee ${pb.ty} as ${refTy})`);
      const r = this.def(`milo.ptr.lend ${pb.ptr} -> ${refTy}`, refTy).ref;
      this.lentFrom.set(r, pb.ptr);
      return { ref: r };
    }
    const b = e.kind === "Ident" ? this.lookup(e.name) : null;
    if (b?.kind === "vec") return this.lendAs(b.ref, `!milo.vec<${b.elem}>`, refTy, b.param);
    const p = b?.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param }
      : e.kind === "FieldAccess" || e.kind === "IndexAccess" || (e.kind === "HeapDeref" && (this.heapDerefLent(e) || (mut && !isTempBox(this.f(e.operand))))) ? this.fieldPlace(e) ?? this.scalarElem(e) : null;
    if (p) return this.lendAs(p.ref, `!milo.ref<${p.ty}>`, refTy, p.param);
    if (!b && (e.kind === "IndexAccess" || e.kind === "PtrDeref" || e.kind === "FieldAccess") && valueType(this.cx, this.ty(e.node)) === null && placeType(this.cx, this.ty(e.node)) !== null) {
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
    if (this.isSretCall(e) || (!b && valueType(this.cx, this.ty(e.node)) === null && placeType(this.cx, this.ty(e.node)) !== null)) {
      // One that lives in memory is built in a slot of this frame, which drops it.
      const sl = this.bigSlot("arg", e, true);
      return this.lendAs(sl.ref, `!milo.ref<${sl.ty}>`, refTy);
    }
    if (!b && (e.kind === "IndexAccess" || e.kind === "PtrDeref" || e.kind === "FieldAccess") && (mut || refTy.startsWith("!milo.vec<"))) {
      // `(*p).items.push(v)`: a place behind a raw pointer, lent where it is (passed
      // that address), as a ref or a Vec header only the call sees.
      const pp = this.ptrPlace(e);
      if (pp) {
        const vm = /^!milo\.vecval<(.*)>$/.exec(pp.ty);
        const lent = vm ? `!milo.vec<${vm[1]}>` : `!milo.ref<${pp.ty}>`;
        if (lent !== refTy) throw new MlirUnsupported(`by-ref arg of another type (${lent} as ${refTy})`);
        const r = this.def(`milo.ptr.lend ${pp.ptr} -> ${lent}`, lent).ref;
        this.lentFrom.set(r, pp.ptr);
        return { ref: r };
      }
    }
    // A raw slice, a Vec slice (`&mut v[a..b]`) or a `&mut T` coerced to `&mut I` is a
    // view header over memory it does not own: lent from a temporary spilled to a slot,
    // writes through it still reach that memory.
    if (mut && e.kind !== "RawSlice" && e.kind !== "VecSlice" && e.kind !== "InterfaceCoerce") throw new MlirUnsupported(`&mut of a value (${e.kind})`);
    const v = b?.kind === "ssa" ? b.v : this.expr(e);
    if (!this.fits(`!milo.ref<${v.ty}>`, refTy)) throw new MlirUnsupported(`by-ref arg of another type (value ${v.ty} as ${refTy})`);
    let slot: string;
    if (v.own === "owned" && !this.bitCopies.has(v.ref) && this.hasDrop(v.ty)) slot = this.tempSlot("arg", v.ty, this.ty(e.node), v);
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
    // gives a generic body the plain T, and the same header is passed.
    const owningElems = /^!milo\.ref<!milo\.vecval<!milo\.fn<owning (.*)>>>$/.exec(placeTy);
    if (owningElems && refTy === `!milo.vec<!milo.fn<${owningElems[1]}>>`) return true;
    return placeTy === refTy || placeTy === `!milo.ref<!milo.vecval<${/^!milo\.vec<(.*)>$/.exec(refTy)?.[1]}>>`;
  }

  /** The place `ref` (of type `placeTy`) lent as `refTy` (fits). */
  private lendAs(ref: string, placeTy: string, refTy: string, param?: number): { ref: string; param?: number } {
    if (placeTy === refTy) return { ref, param };
    // A Vec lent as its header, wanted as its slot (replace/swap of a `&mut Vec` param).
    if (placeTy.startsWith("!milo.vec<") && refTy === `!milo.ref<!milo.vecval<${placeTy.slice(10, -1)}>>`)
      return { ref: this.def(`milo.vec.slot ${ref} : ${placeTy} -> ${refTy}`, refTy).ref, param };
    if (!this.fits(placeTy, refTy)) throw new MlirUnsupported(`by-ref arg of another type (${placeTy} as ${refTy})`);
    return { ref: this.def(`milo.vec.place ${ref} : ${placeTy} -> ${refTy}`, refTy).ref, param };
  }

  /**
   * `v[i]` of a Vec of scalars as its element's place (milo.index.ref, bounds-checked), for
   * a by-ref position only: a scalar element is read as a value (milo.index) everywhere else.
   */
  private scalarElem(x: X): { ref: string; ty: string; param?: number } | null {
    const e = this.f(x);
    if (e.kind !== "IndexAccess" || stripRefs(this.ty(e.object)).tag !== "vec") return null;
    const { place, elem, param } = this.vecPlace(e.object);
    const ref = this.def(`milo.index.ref ${place}[${this.index(e.index)}] : !milo.vec<${elem}> -> !milo.ref<${elem}>`, `!milo.ref<${elem}>`, this.loc(e.span)).ref;
    return { ref, ty: elem, param };
  }

  /**
   * print/eprint. An interpolated string is `print(format(parts))`; printing the parts
   * displays the same text without building the string (format and print share the
   * int and float formatting), and like format evaluates every part first. A plain print
   * streams: each string part is written once it is evaluated, after the
   * scalars before it, so a part that prints (or panics) lands between them. Each string
   * part therefore ends a `milo.print partial` of the parts so far.
   */
  private print(e: FormOf<"Call">): Val {
    let args = e.args;
    const only = args.length === 1 ? this.f(args[0].expr) : null;
    const formatted = only?.kind === "Call" && only.func === "format" && this.cx.isBuiltinName("format");
    if (formatted) args = only.args;
    if (args.some(a => a.passByRef)) throw new MlirUnsupported("by-ref print part");
    return this.printText(args, e.func === "eprint", formatted, !e.noNewline);
  }

  /**
   * print / eprint: each part's text appended to a scratch string (a top-level string as
   * its bytes, anything else through its display glue), then the string written at once,
   * to stdout through stdio's buffer or to stderr, and freed. Unless the parts are one
   * format(), a string part ends a chunk: it is written as soon as it is evaluated, so
   * output from evaluating a later part comes after it.
   */
  private printText(args: Arg[], stderr: boolean, formatted: boolean, newline: boolean): Val {
    // Owned: a part that leaves early (`?` inside it) drops what was appended so far. The
    // write frees the buffer, so the slot is emptied after it without a drop (init).
    const slot = this.ownedSlot("print", STR, { tag: "string" });
    const empty = () => this.emit(`milo.store ${this.def(`milo.zero : ${STR}`, STR).ref}, ${slot} init : !milo.ref<${STR}>`);
    const write = this.cx.mlirOutWrite(stderr);
    const flush = () => { this.rtCall(write, [{ ref: slot, ty: `!milo.ref<${STR}>` }], null); empty(); };
    empty();
    this.appendText(slot, args, formatted ? null : flush);
    if (newline) {
      this.emit(`milo.string.append ${slot}, ${this.def('milo.string.lit "\\0A"', STR).ref} : !milo.ref<${STR}>`);
    }
    flush();
    return { ref: "", ty: "" };
  }

  /** The builtins that are a libc call, a runtime section or a load. */
  private nativeBuiltin(e: FormOf<"Call">): Val {
    const arg = (i: number, ty: string) => {
      const v = this.expr(e.args[i].expr);
      if (v.ty !== ty) throw new MlirUnsupported(`${e.func} operand type`);
      return v;
    };
    const none = { ref: "", ty: "" };
    const atomic = e.func.startsWith("_atomic") ? this.cx.mlirAtomic(e.func) : null;
    if (atomic) {
      // A bool is its byte in memory: widened going in, compared back to i1 coming out.
      const vty = /Bool$/.test(e.func) ? "ui8" : /I32$/.test(e.func) ? "si32" : "si64";
      const ops = [arg(0, PTR), ...e.args.slice(1).map(a => {
        const v = this.expr(a.expr);
        return v.ty === "i1" && vty === "ui8" ? this.def(`milo.cast ${v.ref} : i1 to ui8`, "ui8") : v;
      })];
      if (ops.slice(1).some(o => o.ty !== vty)) throw new MlirUnsupported(`${e.func} operand type`);
      const ret = /^_atomicStore/.test(e.func) ? null : vty;
      const r = this.rtCall(atomic, ops, ret);
      if (ret === "ui8") return this.def(`milo.cmp ne, ${r.ref}, ${this.def("milo.const 0 : ui8", "ui8").ref} : ui8`, "i1");
      return r;
    }
    switch (e.func) {
      case "flush": this.libcCall("fflush", [this.def(`milo.zero : ${PTR}`, PTR)], "si32"); return none;
      case "exit": this.libcCall("exit", [arg(0, "si32")], null); return none;
      case "_putByte": {
        const w = this.def(`milo.cast ${arg(0, "ui8").ref} : ui8 to ui32`, "ui32");
        this.libcCall("putchar", [this.def(`milo.cast ${w.ref} : ui32 to si32`, "si32")], "si32");
        return none;
      }
      case "_loadU8": return this.def(`milo.ptr.load ${arg(0, PTR).ref} : ui8`, "ui8");
      case "_miloArgCount": {
        const g = this.def(`milo.global.addr ${quote(this.cx.mlirProcessGlobal("argc"))}`, PTR);
        return this.def(`milo.cast ${this.def(`milo.ptr.load ${g.ref} : si32`, "si32").ref} : si32 to si64`, "si64");
      }
      case "_miloArgAt": {
        // argv[i] copied into a fresh NUL-terminated string.
        const i = arg(0, "si64");
        const argv = this.def(`milo.ptr.load ${this.def(`milo.global.addr ${quote(this.cx.mlirProcessGlobal("argv"))}`, PTR).ref} : ${PTR}`, PTR);
        const p = this.def(`milo.ptr.load ${this.def(`milo.ptr.elem ${argv.ref}[${i.ref}] : ${PTR}`, PTR).ref} : ${PTR}`, PTR);
        return { ...this.rtCall("rtStrFrom", [p, this.libcCall("strlen", [p], "si64")], STR), own: "owned" };
      }
      case "_schedulerGet":
        return this.def(`milo.ptr.load ${this.def(`milo.global.addr ${quote(this.cx.mlirProcessGlobal("scheduler"))}`, PTR).ref} : ${PTR}`, PTR);
      case "_schedulerSet": case "_panicHookSet": {
        const v = arg(0, PTR);
        const g = this.def(`milo.global.addr ${quote(this.cx.mlirProcessGlobal(e.func === "_schedulerSet" ? "scheduler" : "panicHook"))}`, PTR);
        this.emit(`milo.ptr.store ${v.ref}, ${g.ref} : ${PTR}`);
        return none;
      }
      case "_callClosureVoid": {
        const f = arg(0, PTR), env = arg(1, PTR);
        this.emit(`milo.call_ptr ${f.ref}(${env.ref}) : (${PTR}) -> ()`);
        return none;
      }
      case "_loadI32": return this.def(`milo.ptr.load ${arg(0, PTR).ref} : si32`, "si32");
      case "_bytesToString": case "_cstrToString": {
        // A fresh NUL-terminated copy, so the string can go back to C without another.
        const p = arg(0, PTR);
        const n = e.func === "_bytesToString" ? arg(1, "si64") : this.libcCall("strlen", [p], "si64");
        return { ...this.rtCall("rtStrFrom", [p, n], STR), own: "owned" };
      }
      case "_strDataPtr": {
        const s = this.place(e.args[0].expr, `!milo.ref<${STR}>`, false).ref;
        return this.def(`milo.string.data ${this.def(`milo.load ${s} : !milo.ref<${STR}>`, STR).ref}`, PTR);
      }
    }
    throw new MlirUnsupported(`builtin ${e.func}`);
  }

  /**
   * `format(a, b, ...)` (an interpolated string): milo.interp over the parts, each evaluated
   * left to right first (E-INTERP, lowered by milo-desugar): a scalar as its value, a string
   * read in place, anything else as its place with its display glue. A fresh owned string.
   */
  private formatText(args: Arg[], span: Span | undefined): Val {
    if (args.some(a => a.passByRef)) throw new MlirUnsupported("by-ref format part");
    const parts: string[] = [];
    const mark = this.pending.length;
    for (const a of args) {
      const t = stripRefs(this.ty(a.expr));
      if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr") {
        const v = this.expr(a.expr);
        if (valueType(this.cx, t) !== v.ty) throw new MlirUnsupported(`print part of type ${t.tag}`);
        parts.push(`${v.ref} : ${v.ty}`);
      } else if (t.tag === "string") {
        // Read in place until the op: a temporary goes to a slot of the statement (borrow).
        const v = this.borrow(this.expr(a.expr), t);
        if (v.ty !== STR) throw new MlirUnsupported("print part string type");
        parts.push(`${v.ref} : ${STR}`);
      } else {
        const lt = this.glue.placeOf(t);
        const p = this.place(a.expr, lt, false).ref;
        const glue = this.glue.display(t);
        // Glue is defined in the module (src/mlir-glue.ts): milo-desugar calls it by symbol.
        parts.push(`${p} : ${lt} via @${quote(glue)}`);
      }
    }
    this.pending.length = mark;
    const l = this.site(span);
    return { ...this.def(`milo.interp ${quote(`${l.file}:${l.line}`)} [${parts.join(", ")}]`, STR), own: "owned" };
  }

  /**
   * Appends each part's text to the string at `slot`: a top-level string as its bytes,
   * anything else through its display glue. `afterString`, when given, runs after every
   * string part but the last (print's chunk boundary).
   */
  private appendText(slot: string, args: Arg[], afterString: (() => void) | null): void {
    args.forEach((a, i) => {
      const t = stripRefs(this.ty(a.expr));
      if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr") {
        const v = this.expr(a.expr);
        if (valueType(this.cx, t) !== v.ty) throw new MlirUnsupported(`print part of type ${t.tag}`);
        this.pushScalar(slot, v, this.f(a.expr).span);
      } else if (t.tag === "string") {
        const v = this.borrow(this.expr(a.expr), t);
        if (v.ty !== STR) throw new MlirUnsupported("print part string type");
        this.emit(`milo.string.append ${slot}, ${v.ref} : !milo.ref<${STR}>`);
        if (afterString && i < args.length - 1) afterString();
      } else {
        const lt = this.glue.placeOf(t);
        const p = this.place(a.expr, lt, false).ref;
        this.rtCall(this.glue.display(t), [{ ref: p, ty: lt }, { ref: slot, ty: `!milo.ref<${STR}>` }], null);
      }
    });
  }

  /**
   * `todo()` / `todo(msg)`: "todo: '<fn>' is not implemented (<site>)", and the message,
   * then the panic tail. The function is named by what follows its name's last `$`.
   */
  private todo(e: FormOf<"Call">): Val {
    const who = this.fn.name.slice(this.fn.name.lastIndexOf("$") + 1);
    const msg = e.args[0];
    if (e.args.length > 1 || (msg && stripRefs(this.ty(msg.expr)).tag !== "string")) throw new MlirUnsupported("todo arguments");
    const head = `todo: '${who}' is not implemented (${this.panicAt(e.span)})`;
    // Under an always-true milo.if, so what follows the call still has a block to go in.
    this.region(`milo.if ${this.constTrue()} {`, () => { this.panicText(msg ? [`${head}: `, msg, "\n"] : [`${head}\n`]); return true; });
    this.emit("}");
    return { ref: "", ty: "" };
  }


  /**
   * An extern call that is variadic or turns a string into a `*u8`: goes through a
   * helper function per callee, argument shape and call site, so the C string conversion
   * (a view or a literal copied to a NUL-terminated temporary for the call) and the
   * variadic promotion happen there. A string goes to it by reference; one this function
   * owns outright (a local, a field of one, a temporary) is first made the only handle to
   * its buffer before C may write through it.
   * Scalars and pointers go by value, an array as its address.
   */
  /**
   * An extern call natively: a by-ref argument as its place (after the
   * alias guard), which lowers to its address, a string as its bytes as a C string (milo.string.cstr; a
   * literal as is), a fixed array as its address, a scalar or pointer by value; a variadic
   * callee through milo.ccall. Null for what the helper above handles: a struct by value, either
   * way, which the C ABI coerces.
   */
  private nativeFfi(e: FormOf<"Call">, stmt: boolean): Val | null {
    const callee = this.fns.get(e.func), sig = this.cx.fnSigs.get(e.func);
    if (!callee || !sig) return null;
    const ret = this.ty(e.node).tag === "void" ? null : this.value(this.ty(e.node), "extern call result");
    // Only C coerces a struct by value (the ABI); a Milo callee that took a string as *u8
    // takes any other value as the normal call path passes it.
    // A struct by value to or from C goes through the module's shim for f (src/scaffold.ts
    // cAbiShim), which does the C ABI's coercion; to the shim it is a plain value.
    const shim = callee.isExtern ? this.cx.mlirCAbiShim(e.func, !!(sig.variadic || e.variadic)) : null;
    const cAbi = callee.isExtern && !shim;
    if (ret !== null && !isScalarTy(ret) && ret !== PTR && (cAbi || ret === STR || this.hasDrop(ret) || (shim && inSlot(this.cx, ret)))) return null;
    for (const a of e.args) {
      const t = stripRefs(this.ty(a.expr));
      if (!a.passByRef && t.tag !== "string" && t.tag !== "array" && (() => { const vt = valueType(this.cx, this.ty(a.expr)); return vt === null || (cAbi && !(isScalarTy(vt) || vt === PTR)) || (shim && this.hasDrop(vt)); })()) return null;
      if (a.passByRef && (t.tag === "string" || t.tag === "vec" || (t.tag === "array" && t.size === null))) return null;
    }
    const keep = this.cx.retainingLibc.has(e.func);
    const vals: Val[] = [];
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const mark = this.pending.length;
    e.args.forEach(a => {
      const t = stripRefs(this.ty(a.expr));
      if (a.passByRef) {
        const ty = this.lent(t, "extern by-ref operand");
        const r = this.place(a.expr, ty, a.refMut).ref;
        refs.push({ ref: r, mut: !!a.refMut, ty });
        // The place, typed as the extern's other calls declare it: it lowers to the address.
        vals.push({ ref: r, ty });
      } else if (t.tag === "string") {
        if (this.k(a.expr) === "StringLit") {
          // A literal is NUL-terminated in place.
          vals.push(this.def(`milo.string.data ${this.expr(a.expr).ref}`, PTR));
          return;
        }
        let ref: string;
        const local = this.ownedLocal(a.expr);
        if (this.k(a.expr) === "Ident" || this.k(a.expr) === "FieldAccess") ref = this.place(a.expr, `!milo.ref<${STR}>`, false).ref;
        else {
          const v = this.expr(a.expr);
          if (v.ty !== STR || v.own !== "owned" || this.bitCopies.has(v.ref)) throw new MlirUnsupported("C string of a view");
          // C borrows the bytes for the call; one that keeps them gets them leaked.
          if (keep) { ref = this.fresh(); this.vars.push(`  ${ref} = milo.var "cstr" : !milo.ref<${STR}>`); }
          else ref = this.tempSlot("cstr", STR, t, v);
          this.emit(`milo.store ${v.ref}, ${ref}${keep ? "" : " init"} : !milo.ref<${STR}>`);
        }
        // C may write through the bytes: a string owned outright here is made unique first.
        if (local || (this.k(a.expr) !== "Ident" && this.k(a.expr) !== "FieldAccess")) this.rtCall("rtStrUnique", [{ ref, ty: `!milo.ref<${STR}>` }], null);
        const copy = keep ? this.fresh() : this.tempSlot("cstr.copy", STR, { tag: "string" });
        if (keep) this.vars.push(`  ${copy} = milo.var "cstr.copy" : !milo.ref<${STR}>`);
        this.emit(`milo.store ${this.def(`milo.zero : ${STR}`, STR).ref}, ${copy} init : !milo.ref<${STR}>`);
        vals.push(this.rtCall("rtStringCstr", [{ ref, ty: `!milo.ref<${STR}>` }, { ref: copy, ty: `!milo.ref<${STR}>` }], PTR));
      } else if (t.tag === "array") {
        vals.push(this.decay(a.expr));
      } else {
        vals.push(this.helperOperand(a.expr, "extern argument").v);
      }
    });
    this.pending.length = mark;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
        this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
      }
    }
    const tys = `(${vals.map(v => v.ty).join(", ")}) -> ${ret ?? "()"}`;
    if (shim) {
      if (sig.variadic || e.variadic) throw new MlirUnsupported("a variadic extern with a struct by value");
      this.callees.set(shim, tys);
      const call = `func.call @${quote(shim)}(${vals.map(v => v.ref).join(", ")}) : ${tys}`;
      if (ret === null) { this.emit(call); return this.valued({ ref: "", ty: "" }, stmt); }
      return this.valued(this.def(call, ret), stmt);
    }
    const call = sig.variadic || e.variadic
      ? `milo.ccall @${quote(e.func)}(${vals.map(v => v.ref).join(", ")}) fixed ${callee.params.length} : ${tys}`
      : (this.callees.set(e.func, tys), `func.call @${quote(e.func)}(${vals.map(v => v.ref).join(", ")}) : ${tys}`);
    if (ret === null) { this.emit(call); return this.valued({ ref: "", ty: "" }, stmt); }
    return this.valued(this.def(call, ret), stmt);
  }

  private ffiCall(e: FormOf<"Call">, _stmt: boolean): Val {
    const native = this.nativeFfi(e, _stmt);
    if (native) return native;
    throw new MlirUnsupported(`extern call ${e.func}`);
  }

  /**
   * `assert(c, msg)`: when c is false, "assertion failed at <site>: msg" on stderr, then
   * the panic tail. The message is evaluated only on that path.
   */
  private assert(e: FormOf<"Call">): Val {
    const c = this.expr(e.args[0].expr);
    if (c.ty !== "i1") throw new MlirUnsupported("assert of a non-bool");
    if (e.args.length > 2 || (e.args[1] && stripRefs(this.ty(e.args[1].expr)).tag !== "string")) throw new MlirUnsupported("assert arguments");
    this.region(`milo.if ${c.ref} {`, () => false);
    this.region("} else {", () => {
      const at = this.panicAt(e.span);
      this.panicText(e.args[1] ? [`assertion failed at ${at}: `, e.args[1], "\n"] : [`assertion failed at ${at}\n`]);
      return true;
    });
    this.emit("}");
    return { ref: "", ty: "" };
  }

  /**
   * Builds the message (static text and string parts) in a scratch string, then
   * milo.panic.text writes it to stderr and aborts. Ends the block: the call never returns.
   */
  private panicText(parts: (string | { place: string; type: TypeKind } | Arg)[]): void {
    const slot = this.fresh();
    this.vars.push(`  ${slot} = milo.var "panic.msg" : !milo.ref<${STR}>`);
    this.emit(`milo.store ${this.def(`milo.zero : ${STR}`, STR).ref}, ${slot} : !milo.ref<${STR}>`);
    for (const p of parts) {
      if (typeof p === "string") this.emit(`milo.string.append ${slot}, ${this.def(`milo.string.lit ${quote(p)}`, STR).ref} : !milo.ref<${STR}>`);
      else if ("place" in p) {
        // A value already in a slot: a string's bytes, anything else as it displays.
        if (p.type.tag === "string") this.emit(`milo.string.append ${slot}, ${this.def(`milo.load ${p.place} : !milo.ref<${STR}>`, STR).ref} : !milo.ref<${STR}>`);
        else this.rtCall(this.glue.display(p.type), [{ ref: p.place, ty: this.glue.placeOf(p.type) }, { ref: slot, ty: `!milo.ref<${STR}>` }], null);
      } else this.appendText(slot, [p], null);
    }
    this.rtCall(this.cx.mlirPanicText(), [{ ref: slot, ty: `!milo.ref<${STR}>` }], null);
    this.emit("milo.unreachable");
  }

  /** `e` never returns: a `never` value, a std panic, or the builtin exit (typed void in HIR). */
  private diverges(x: X): boolean {
    const e = this.f(x);
    return this.ty(e.node).tag === "never" || e.kind === "StrPanic" || e.kind === "VecPanic" || (e.kind === "Call" && e.func === "exit" && this.cx.isBuiltinName("exit"));
  }

  /**
   * `take(s.f)`: an owning field moved out of a local: the value read
   * out, then the field zeroed in place (an `init` store, nothing dropped), so the
   * struct's own drop later finds an empty one there and frees nothing twice.
   */
  /**
   * `o!` with a 128+ byte payload, written into `dst`: the check of unwrapCheck on the
   * enum's place, then the payload's bits copied out; an owning source's slot is then
   * marked moved.
   */
  private unwrapInto(e: FormOf<"Unwrap">, dst: string, ty: string): void {
    const o = this.f(e.operand), st = stripRefs(this.ty(o));
    let src: { ref: string; ty: string };
    // An enum that owns nothing is bit-copied: read from wherever it is, nothing emptied.
    const plain = !this.hasDrop(this.place$(st, "unwrapped enum"));
    if (plain) {
      const p = o.kind === "Ident" || o.kind === "FieldAccess" ? this.fieldPlace(o) : null;
      src = p ?? this.bigSlot("unwrap.of", o, true);
    } else if (o.kind === "Ident") {
      const b = this.lookup(o.name);
      if (b.kind !== "var" || !b.owned || !this.mv(o)) throw new MlirUnsupported("unwrap of a 128+ byte payload out of a borrow");
      src = { ref: b.ref, ty: b.ty };
    } else if (o.kind === "FieldAccess" || o.kind === "IndexAccess" || o.kind === "HeapDeref" || o.kind === "PtrDeref") {
      throw new MlirUnsupported("unwrap of a 128+ byte payload out of a place");
    } else {
      src = this.bigSlot("unwrap.of", o, true);
    }
    if (src.ty !== this.place$(st, "unwrapped enum")) throw new MlirUnsupported("unwrap operand type");
    const sr = `!milo.ref<${src.ty}>`;
    this.unwrapCheck(e, this.def(`milo.enum.tag_at ${src.ref} : ${sr}`, "si32"),
      (tag, pty) => this.def(`milo.enum.field_ref ${src.ref}[${tag}, 0] : ${sr} -> !milo.ref<${pty}>`, `!milo.ref<${pty}>`).ref);
    // The Some/Ok payload's bits into dst, which takes it over; the source is then empty.
    const fr = this.def(`milo.enum.field_ref ${src.ref}[0, 0] : ${sr} -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref;
    if (/^!milo\.(struct|enum|array)</.test(ty)) this.emit(`milo.copy ${fr}, ${dst} : !milo.ref<${ty}>, !milo.ref<${ty}> of ${ty}`);
    else this.emit(`milo.store ${this.def(`milo.load ${fr} : !milo.ref<${ty}>`, ty).ref}, ${dst} init : !milo.ref<${ty}>`);
    if (!plain) this.def(`milo.move ${src.ref} : !milo.ref<${src.ty}>`, src.ty);
  }

  /**
   * Unless `tag` is 0 (Some/Ok): the unwrap message on stderr, then the panic tail.
   * An Err(string) shows its text, an Err(enum) the variant, any other Err or a None which
   * it was. `errPlace(tag, ty)` gives the place of the Err payload.
   */
  private unwrapCheck(e: FormOf<"Unwrap">, tag: Val, errPlace: (tag: number, ty: string) => string): void {
    const layout = this.cx.mlirEnumLayout(e.enumName);
    if (!layout) throw new MlirUnsupported("unwrap enum layout");
    const ok = this.def(`milo.cmp eq, ${tag.ref}, ${this.def("milo.const 0 : si32", "si32").ref} : si32`, "i1");
    this.region(`milo.if ${ok.ref} {`, () => false);
    this.region("} else {", () => {
      const at = `error at ${this.panicAt(e.span)}: `;
      const err = e.enumName.startsWith("Result_") ? layout.variants.find(x => x.name === "Err") : undefined;
      const pt = err?.fields.length === 1 ? stripRefs(err.fields[0]) : null;
      const payload = () => ({ place: errPlace(err!.tag, this.place$(pt!, "Err payload")), type: pt! });
      if (pt?.tag === "string") this.panicText([at, payload(), "\n"]);
      else if (pt?.tag === "enum" && this.cx.mlirEnumLayout(pt.name)) this.panicText([`${at}unwrap called on Err(`, payload(), ")\n"]);
      else this.panicText([`${at}unwrap called on ${err ? "Err" : "None"}\n`]);
      return true;
    });
    this.emit("}");
  }

  /** What a refused field move reads from, for the unsupported reason: the root and its binding. */
  private moveRoot(x: X): string {
    const e = this.f(x);
    let r: Form = e;
    while (r.kind === "FieldAccess") r = this.f(r.object);
    if (r.kind !== "Ident") return r.kind;
    const name = r.name;
    const b = this.scopes.some(m => m.has(name)) ? this.lookup(name) : null;
    return b ? (b.kind === "var" ? (b.owned ? "owned var" : b.param !== undefined ? "by-ref param" : "var") : b.kind) : "unbound";
  }

  /**
   * `e`'s root is a binding that only borrows (a `&T` param, a match binding of a borrowed
   * subject): taking one of its fields is a read, never a move, and whatever takes the
   * value copies it (a string shares its buffer by count).
   */
  private borrowedRoot(x: X): boolean {
    const e = this.f(x);
    let r: Form = e;
    while (r.kind === "FieldAccess") r = this.f(r.object);
    if (r.kind !== "Ident") return false;
    const name = r.name;
    const b = this.scopes.some(m => m.has(name)) ? this.lookup(name) : null;
    return b?.kind === "var" && !b.owned && !b.flag && !b.zeroOnMove;
  }

  private moveField(e: FormOf<"FieldAccess">): Val {
    let p: { ref: string; ty: string };
    const o = this.f(e.object), k = o.kind, ot = this.ty(o);
    if (this.fieldOfOwnedLocal(e)) {
      p = this.fieldPlace(e)!;
      if (this.runsUserDrop(p.ty)) {
        this.partialMove(e);
        return { ...this.def(`milo.move ${p.ref} : !milo.ref<${p.ty}>`, p.ty), own: "owned" };
      }
    } else if (k !== "Ident" && k !== "FieldAccess" && k !== "IndexAccess" && k !== "HeapDeref" && k !== "PtrDeref"
      && ot.tag === "struct" && !this.cx.dropImpls.has(ot.name)) {
      // Out of a temporary (`make().name`): it goes to a slot that dies with the
      // statement, so the fields left behind are dropped there, the moved one zeroed first.
      const sl = this.bigSlot("tmp", o, true);
      const { index, ty } = this.field(e);
      p = { ref: this.def(`milo.field_ref ${sl.ref}[${index}] : !milo.ref<${sl.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`).ref, ty };
      if (this.runsUserDrop(sl.ty)) {
        // A user Drop in the leftovers is observable, so they die here, first field
        // first, and the slot is emptied.
        const v = this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
        fieldTypes(this.cx, ot as TypeKind & { tag: "struct" }).forEach((ft, j) => {
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
      const path: (FormOf<"FieldAccess">)[] = [e];
      let root: Form = o;
      while (root.kind === "FieldAccess") { path.unshift(root); root = this.f(root.object); }
      const rk = root.kind;
      const temp = rk !== "Ident" && rk !== "IndexAccess" && rk !== "HeapDeref" && rk !== "PtrDeref";
      if (!temp || path.length < 2 || path.some(x => this.ty(x.object).tag !== "struct" || this.runsUserDrop(this.place$(this.ty(x.object), "struct"))))
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
   * A field that runs a user Drop, moved out of a local (field-move flags): a [MILO-O-fieldMove]
   * zeroed one is not empty, so it is emptied by milo.move instead, and
   * milo-elaborate-drops drops the local field by field without it. Those drops call the
   * glue of every field of each struct on the way down.
   */
  private partialMove(e: FormOf<"FieldAccess">): void {
    for (let o: Form = this.f(e.object); ; o = this.f((o as FormOf<"FieldAccess">).object)) {
      const ot = this.ty(o);
      if (ot.tag === "struct")
        for (const f of fieldTypes(this.cx, ot)) if (ownsStructurally(this.cx, f, [])) this.dropGlue("", f);
      if (o.kind !== "FieldAccess") break;
    }
    this.dropGlue("", this.ty(e.node));
  }

  /**
   * `e` is a field (of a field...) of a struct local this function owns, every step a
   * struct by value. None of them implements Drop (the checker refuses a move out of
   * one), so dropping the local with a moved field zeroed drops the rest.
   */
  private fieldOfOwnedLocal(x: X): boolean {
    const e = this.f(x);
    if (e.kind === "Ident") {
      const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
      return b?.kind === "var" && !!b.owned;
    }
    return e.kind === "FieldAccess" && this.ty(e.object).tag === "struct" && this.fieldOfOwnedLocal(e.object);
  }

  /**
   * `e` is a string this function only borrows (a `&string` param, a view): a match on it
   * compares it with literals and moves nothing out, so it is read in place.
   */
  private borrowedString(x: X): boolean {
    const e = this.f(x);
    if (stripRefs(this.ty(e.node)).tag !== "string" || e.kind !== "Ident") return false;
    const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
    return b?.kind === "var" ? !b.owned : b?.kind === "ssa" && b.v.own !== "owned";
  }

  /** `e` names a string this function owns outright. */
  private ownedLocal(x: X): boolean {
    const e = this.f(x);
    if (e.kind === "Ident") {
      const b = this.scopes.some(m => m.has(e.name)) ? this.lookup(e.name) : null;
      return b?.kind === "var" && !!b.owned;
    }
    return e.kind === "FieldAccess" && stripRefs(this.ty(e.object)).tag === "struct" && this.ty(e.object).tag !== "ref" && this.ownedLocal(e.object);
  }

  // abi: as closureCall's.
  private call(e: FormOf<"Call">, stmt: boolean, into?: string, abi = false): Val {
    if ((e.func === "print" || e.func === "eprint") && this.cx.isBuiltinName(e.func)) return this.print(e);
    if (this.cx.isBuiltinName(e.func)) {
      if (NATIVE_BUILTINS.has(e.func) || e.func.startsWith("_atomic")) return this.nativeBuiltin(e);
      if (e.func === "format") return this.formatText(e.args, e.span);
      if (e.func === "assert") return this.assert(e);
      if (e.func === "todo") return this.todo(e);
      throw new MlirUnsupported(`builtin ${e.func}`);
    }
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    // A string given to a `*u8` param gets the C string conversion for any callee, not only an extern.
    if (callee && sig && ((callee.isExtern && e.variadic) || e.args.some((a, i) => !a.passByRef && !callee.params[i]?.isRef && !callee.params[i]?.isRefMut && stripRefs(this.ty(a.expr)).tag === "string" && sig.paramTypes[i] === "ptr")))
      return this.ffiCall(e, stmt);
    if (e.variadic) throw new MlirUnsupported("variadic call");
    if (!callee || !sig || sig.variadic) throw new MlirUnsupported("callee");
    const sret = this.cx.sretFns.has(e.func);
    if (sret !== (into !== undefined)) throw new MlirUnsupported(`sret call as a value: ${e.func}`);
    // A per-module extern (`linkName`) is called by its HIR name: the
    // backend maps both modules' symbols to the C one (mlir-backend compile).
    if (callee.params.length !== e.args.length) throw new MlirUnsupported("callee arity");
    // A struct passed to or returned from C by value goes through the platform ABI's
    // register coercion (src/abi.ts): an MLIR call would pass the LLVM struct as-is and C
    // would read the wrong registers, so ffiCall calls the module's ABI shim instead.
    if (callee.isExtern && [callee.retType, ...callee.params.filter(p => !p.isRef && !p.isRefMut).map(p => p.type)].some(t => t.tag === "struct" || t.tag === "array"))
      return this.ffiCall(e, stmt);
    // A `&string` value (a slice `s[a..b]`) given to a `&string` param: the view goes in
    // a slot nobody drops, and the param gets that place.
    const viewArg = (i: number) => !e.args[i].passByRef && callee.params[i].isRef && this.ty(e.args[i].expr).tag === "ref" && stripRefs(this.ty(e.args[i].expr)).tag === "string";
    const paramTys = callee.params.map((p, i) => {
      const byRef = p.isRef || p.isRefMut;
      if (byRef !== e.args[i].passByRef && !viewArg(i)) throw new MlirUnsupported("by-ref arg mismatch");
      // An extern's fn-typed param is a C function pointer (declared `ptr`).
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
      if (paramTys[i] === PTR && this.ty(a.expr).tag === "array") { provenance.push(null); return this.decay(a.expr).ref; }
      if (paramTys[i] === PTR && this.ty(a.expr).tag === "fn") {
        // A named function to C: its own symbol.
        const x = this.f(a.expr);
        if (x.kind !== "Ident" || !this.fns.has(x.name) || this.scopes.some(m => m.has(x.name))) throw new MlirUnsupported("fn value to a C function pointer param");
        provenance.push(null);
        return this.fieldValue(x, { tag: "cfn" } as TypeKind).ref;
      }
      const pt = paramTys[i];
      if (pt.startsWith("!milo.fn<") && !pt.startsWith("!milo.fn<owning ")) {
        const own = this.expr(a.expr);
        if (own.own === "owned" && own.ty === pt.replace(/^!milo\.fn</, "!milo.fn<owning ")) {
          provenance.push(null);
          // A `move` closure given to a plain fn param (spec "who frees the [MILO-O-lentClosure]
          // heap environment"): the param never owns it, so the caller frees it right after
          // the call (a slot of the call's frame) and passes a plain alias; when the callee
          // may keep the param (closureParamEscapes, failing closed) nobody frees it.
          if (this.cx.mlirClosureParamEscapes(e.func, j)) return this.take(own, pt, "argument", true).ref;
          const slot = this.tempSlot("clarg", own.ty, stripRefs(this.ty(a.expr)).tag === "fn" ? { ...(stripRefs(this.ty(a.expr)) as TypeKind & { tag: "fn" }), owning: true } : this.ty(a.expr), own);
          this.emit(`milo.store ${own.ref}, ${slot} : !milo.ref<${own.ty}>`);
          const view = this.def(`milo.load ${slot} : !milo.ref<${own.ty}>`, own.ty).ref;
          return this.def(`milo.fn.cast ${view} : ${own.ty} -> ${pt}`, pt).ref;
        }
        const v = this.pend(this.take(own, pt, "argument"), this.ty(a.expr));
        provenance.push(null);
        return v.ref;
      }
      const v = this.pend(this.operand(a.expr, paramTys[i], "argument", true), this.ty(a.expr));
      provenance.push(null);
      return v.ref;
    });
    this.pending.length = mark;
    // After every argument, one check per pair with a `&mut`; a pair
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

/** What src/mlir-glue.ts spells types and symbols with, shared so both spell them alike. */
export const glueHelpers = { stripRefs, typeKey, quote, placeType, refOf };

export interface MlirFunction {
  name: string;
  text: string;
  /** Every function it calls, with the dialect's function type. */
  callees: Map<string, string>;
  calls: FnEmitter["calls"];
  /** Its closure bodies: functions of their own, in `text` too, new to the module. */
  closures: string[];
}

/** `fn` in the dialect, or the reason it is unsupported. */
export function emitMlirFunction(fn: FnDecl, cx: MlirEmitCtx, fns: Map<string, FnDecl>, glue?: MlirGlue): MlirFunction | string {
  const em = new FnEmitter(fn, cx, fns, undefined, glue);
  try {
    const text = em.run();
    let all = [text, ...em.closures.texts].join("\n");
    if (cx.emitDebug) {
      // The function's own loc names its subprogram; its closures' get one of their own.
      const loc = fnDebugLoc(cx, fn);
      const own = fillDebugLocs(text, loc).split("\n");
      own[own.length - 1] = `} ${cx.debugFnLoc(fn, loc)}`;
      all = [own.join("\n"), ...em.closures.texts.map(t => fillDebugLocs(t, loc))].join("\n");
    }
    return { name: fn.name === "main" && !cx.mlirMainOk ? MAIN_BODY : fn.name, text: all, callees: em.callees, calls: em.calls, closures: em.closures.names };
  } catch (err) {
    if (err instanceof MlirUnsupported) return err.reason;
    throw err;
  }
}

// A folded constant as a milo.global.def init attribute (see Milo.td): ints as i64 (the
// lowering resizes), floats as their f64 bit pattern, zero as `unit`.
function constAttr(v: ConstVal): string {
  switch (v.k) {
    case "int": return `${BigInt.asIntN(64, v.v)} : i64`;
    case "float": {
      const buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v.v;
      return `0x${new BigUint64Array(buf)[0].toString(16).toUpperCase().padStart(16, "0")} : f64`;
    }
    case "zero": return "unit";
    case "agg": return `[${v.items.map(constAttr).join(", ")}]`;
    case "splat": return `[${constAttr(v.item)}]`;
  }
}

/** Every module global: storage (zero where its initializer runs code) plus the constant part. */
export function globalOps(globals: GlobalDecl[], cx: MlirEmitCtx): string {
  return globals.map(g => {
    const ty = placeType(cx, g.type);
    if (ty === null) throw new MlirUnsupported(`global ${g.name} of type ${placeBlocker(cx, g.type)}`);
    const init = globalInit(g, cx.structLayouts, cx.facts);
    return `milo.global.def @${quote(g.name)}${g.threadLocal ? " thread_local" : ""} : ${ty}${init.k === "zero" ? "" : ` = ${constAttr(init)}`}\n`;
  }).join("");
}

/** The module-level itable ops: one per (concrete type, interface), methods in interface order. */
export function itableOps(itables: BackendProgram["itables"], cx: MlirEmitCtx): string {
  return itables.map(it => {
    const drop = cx.mlirItableDrop(it.concreteType);
    return `milo.itable @${quote(cx.mlirItable(it.concreteType, it.ifaceName))} [${it.methods.map(m => `@${quote(m)}`).join(", ")}]${drop ? ` drop @${quote(drop)}` : ""}\n`;
  }).join("");
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
