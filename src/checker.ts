// Type checking, move checking and scope validation over the merged AST, producing
// the CheckResult that lowering reads. Semantic errors are caught HERE, before codegen:
// if codegen can reach an invalid state, this file missed it.
import { attributesFor } from "./attributes";
import { walkExprs } from "./safety";
import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span, MatchArm, Attribute, GlobalDecl } from "./ast";
import { simpleType, declaredType, floatNamespaceConst } from "./ast";
import type { TypeKind } from "./types";
import { typeFromAst, typeEq, typeName, isNumeric, isCopy, isScalar, SLICE_COMBINATORS, ARRAY_COMBINATORS } from "./types";
import type { Diagnostic, WarningConfig } from "./diagnostics";
import { checkVisibility } from "./visibility";
import { countCSigParams } from "./csig";
import { RETAINING_MEMBERS } from "./builtin-members";
import { memberHint, closest, importHint, stdExportNames, VEC_MEMBERS, HASHMAP_MEMBERS, STRING_MEMBERS, OPTION_MEMBERS, RESULT_MEMBERS, INT_MEMBERS, FLOAT_MEMBERS, BOOL_MEMBERS } from "./suggest";
import { deriveJsonSource, type JsonPlan, type JsonFieldPlan } from "./derive-json";
import { expandDeriveTemplate, dumpTokens, DeriveTemplateError } from "./derive-template";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { basename } from "path";
import { must } from "./must";

// The view constructors for foreign memory, and the one module allowed to call them.
// See the intrinsic in `checkCallExpr` for why the seam is a file rather than a keyword;
// `src/lower.ts` imports both so the two passes cannot disagree about which calls these
// names denote.
export const RAW_SLICE_INTRINSICS: ReadonlySet<string> = new Set(["rawSlice", "rawSliceMut"]);
// The ownership constructors for foreign memory: the return leg of `forget`. Same file
// seam and the same reason: an unchecked claim about a pointer's provenance belongs in
// one reviewed module, not in every caller.
export const ADOPT_INTRINSICS: ReadonlySet<string> = new Set(["adoptHeap", "adoptVec"]);
export const FOREIGN_MODULE = "std/foreign.milo";

// The intrinsic file gates key on a path SUFFIX, and on Windows the resolver hands back
// `D:\a\milo\std\foreign.milo`, which does not end with "std/foreign.milo". Every
// std/foreign fixture therefore failed to compile there with "undefined function
// 'adoptHeap'" while the whole macOS and Linux lane stayed green: the gate was not merely
// wrong on Windows, it silently removed the feature. Compare on posix separators.
// Windows hands back `std\arena.milo`, so any rule that recognises a module by its path
// has to normalise first. `lintArenaNeverFrees` skips the module that IMPLEMENTS the
// pattern it warns about; without this it stopped skipping on Windows and warned inside
// std, where the reader cannot act on it.
export function inModule(file: string | undefined, module: string): boolean {
  return !!file && file.replace(/\\/g, "/").includes(module);
}

// Substitute a generic alias's arguments into its body, at the AST level rather than on
// resolved types: the body may name types that are not registered yet (an alias is
// registered before the enums it mentions), which is the same reason the alias table
// stores AST in the first place.
//
// The use site's own wrappers compose with the parameter's: in `type Slot<T> = *T` used as
// `Slot<Point>`, the `*` comes from the body and the name from the argument, while in
// `Handler<&Point>` the `&` comes from the argument. Both have to survive, so the two are
// merged rather than one overwriting the other.
function substituteAliasType(body: MiloType, subst: ReadonlyMap<string, MiloType>): MiloType {
  const arg = !body.isFn && !body.typeArgs?.length ? subst.get(body.name) : undefined;
  if (arg) {
    const ptrDepth = (body.ptrDepth ?? (body.isPtr ? 1 : 0)) + (arg.ptrDepth ?? (arg.isPtr ? 1 : 0));
    return {
      ...arg,
      isPtr: ptrDepth > 0,
      ...(ptrDepth > 0 ? { ptrDepth } : {}),
      isRef: body.isRef || arg.isRef,
      isRefMut: body.isRefMut || arg.isRefMut,
      // `[T]` in the body wraps whatever T turns out to be; an array argument keeps its own.
      isArray: body.isArray || arg.isArray,
      arraySize: body.isArray ? body.arraySize : arg.arraySize,
    };
  }
  return {
    ...body,
    ...(body.typeArgs ? { typeArgs: body.typeArgs.map(t => substituteAliasType(t, subst)) } : {}),
    ...(body.fnParams ? { fnParams: body.fnParams.map(t => substituteAliasType(t, subst)) } : {}),
    ...(body.fnRet ? { fnRet: substituteAliasType(body.fnRet, subst) } : {}),
  };
}

export function isForeignModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  // Anchored on a separator, so a directory that merely ENDS in "std" (".../notstd/
  // foreign.milo") is not the module. A bare suffix test accepted that.
  return posix === FOREIGN_MODULE || posix.endsWith(`/${FOREIGN_MODULE}`);
}

// One hop from a place to a place inside it. `index` is deliberately opaque —
// two index steps may or may not select the same element, and nothing here tries
// to decide that. `payload` is the inside of an Option/Result reached by `!`/`?`.
// Why a variable is frozen. The distinction matters at exactly one place — an
// index-qualified assignment (`v[0] = x`) — which a view survives and an iteration
// does not. See `freeze` and the Assign case. A `pointer` borrow is a bound `*T` from
// `v.ptr()` / `s.cstr()` / `h.ptr()`: it survives an index write like a view does, and
// unlike either it does not forbid a MOVE of its source; the move ends the holder
// instead, except through `forget` (see `tryMoveLeaf`).
type BorrowKind = "view" | "iteration" | "pointer";

// The binding that holds a pointer borrow, so the diagnostic can name both ends:
// `'v' may reallocate here while 'p' still points into its buffer (from 'v.ptr()' on
// line N)`. `null` in `VarInfo.borrowHolders` for every non-pointer borrow.
interface PointerHolder { name: string; info: VarInfo; root: string; call: string; line: number }

type PlaceStep =
  | { tag: "field"; name: string }
  | { tag: "index" }
  | { tag: "deref" }
  | { tag: "payload" };

// Storage an expression reaches. See `placesOf` for why this exists and why the
// walker that produces it is total.
export type Place =
  // Reached from a named binding by a chain of steps.
  | { tag: "path"; root: string; steps: PlaceStep[] }
  // A fresh value that owns itself: a literal, an arithmetic result, a call's
  // return. Aliases no binding, so every rule may ignore it.
  | { tag: "value" }
  // Storage this walker cannot name. Every rule must read it as "may be any
  // place", never as "no place" — that direction is what made the old walkers
  // leak, since each returned null for the kinds it didn't list.
  | { tag: "opaque" };

const VALUE: Place = { tag: "value" };
const OPAQUE: Place = { tag: "opaque" };
const INDEX: PlaceStep = { tag: "index" };
const DEREF: PlaceStep = { tag: "deref" };
const PAYLOAD: PlaceStep = { tag: "payload" };

// Printable key for a step, and the spelling the older string-keyed callers use:
// a field is ".name", everything else collapses to one opaque token per kind.
function stepKey(s: PlaceStep): string {
  switch (s.tag) {
    case "field": return `.${s.name}`;
    case "index": return "[]";
    case "deref": return "*";
    case "payload": return "!";
  }
}

function stepsEq(a: PlaceStep[], b: PlaceStep[]): boolean {
  return a.length === b.length && a.every((s, i) => stepKey(s) === stepKey(b[i]));
}

// How a step reads in a diagnostic, where an index has to look like source.
function stepLabel(s: PlaceStep): string {
  return s.tag === "index" ? "[…]" : stepKey(s);
}

// One variable's move state at a point in the program: the whole binding, plus the
// places inside it that have already left. Both halves have to be saved and merged
// together — a branch that moves `p.a` and a branch that moves `p` are the same kind
// of fact about what is left, and flow merging that only knew about the second one
// reported a move on a path that returns before reaching the use (examples/tools/java-dap).
interface MoveSnapshot {
  moved: boolean;
  places: string[];
}

interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
  borrowed: boolean;
  read: boolean;
  span?: Span;
  // A `?&mut T` / `?&T` parameter of an extern / @externalLinkage fn. Its `type` is the
  // `*T` the ABI actually passes; this records the reference the `let … else` unwrap
  // produces, and its presence is what makes EVERY other use of the binding an error.
  // The nullable reference is not a value: it exists only long enough to be unwrapped,
  // which is why nothing here can become an `Option<&mut T>` that `nestedRef` would have
  // to catch downstream.
  nullableRef?: { inner: TypeKind; mutable: boolean };
  // A pattern binding that holds a COPY of the payload: bound by value, and the payload
  // type is Copy, so it is a snapshot the enum can't see through. Mutating it through a
  // '&mut self' method compiles and then silently throws the write away (the copy dies at
  // the arm's end). Non-Copy payloads bound by value are MOVED instead — the binding owns
  // the value, so writes are real and this stays false.
  copyBind?: boolean;
  // Holds a `move` closure whose body moves a capture out, so calling it consumes it.
  callsOnce?: boolean;
  // `moved` was set by CALLING a call-once closure rather than by transferring it,
  // which needs a different explanation than "ownership was transferred earlier".
  consumedByCall?: boolean;
  // Places inside this variable whose value has already been moved out, as field
  // chains (".a", ".a.b"). `moved` answers the question for the whole binding; this
  // answers it for a part, which nothing did before — `let x = p.a` marked the
  // expression so codegen would zero the field, and then a second `let y = p.a`
  // compiled and handed back the zeroed slot as an empty string. Safe, and wrong.
  //
  // Only static field chains live here. An index step is a runtime value, so `v[i]`
  // twice cannot be settled at compile time; that case keeps the move-zeroing, which
  // is memory-safe on its own.
  movedPlaces?: Set<string>;
  // For a ref/slice binding: the source vars this binding's borrow froze.
  // Released (borrowed=false) when the binding's scope pops, so a slice in an
  // inner block doesn't freeze its source for the rest of the function.
  freezes?: VarInfo[];
  // Which places inside this variable the live borrows point into, as field chains off
  // the root (`["a"]` for a view of `x.a`, `[]` for the whole variable). A `null` entry
  // means the borrow's path could not be determined and the whole variable is frozen.
  // Absent while `borrowed` is true is read the same as `[null]`. Only mutations whose
  // own path overlaps a frozen one are rejected, so a view of `x.a` leaves `x.b` writable.
  borrowedPaths?: (string[] | null)[];
  // Why each borrow in `borrowedPaths` was taken, same order. A slice VIEW tolerates an
  // in-place element write (the slot does not move, so the view stays valid and simply
  // sees the new value); a loop ITERATION does not, because the loop is handing out that
  // element and rewriting it mid-loop is the invalidation the rule exists to stop.
  borrowKinds?: BorrowKind[];
  // Who holds each borrow in `borrowedPaths`, same order; only a `pointer` borrow has one.
  borrowHolders?: (PointerHolder | null)[];
  // This binding holds a `*T` whose source has since been moved to an owner the checker
  // cannot see (`take(v)`, `store.push(v)`), so the buffer may be freed at any point after.
  // Any read of the binding is an error until it is reassigned. Set by `tryMoveLeaf`.
  pointerSourceMoved?: { root: string; call: string; line: number };
  // Bound by a MATCH/if-let pattern rather than by a `let`/`var` declaration. Assignment
  // to one is rejected like any other immutable binding, but the generic advice ("declare
  // with 'var'") names a declaration the reader cannot find: there is no `let` here, and
  // no spelling of the pattern makes the binding mutable. Recorded so the diagnostic can
  // say what actually works instead.
  patternBound?: boolean;
  // An unannotated `let x = <const-int-value>` whose width is still adaptable:
  // its value is built entirely from integer literals (directly, or as the arm
  // tails of an if/match expression), so it can be re-typed to a wider int on
  // first use without any runtime conversion. `leaves` are those literal exprs
  // and `valueExpr` the whole initializer (whose node type is also retyped).
  // Cleared the moment the binding is resolved (widened) or locked (its
  // statement ends) — so a binding can only ever adopt a width at its FIRST
  // read, never retroactively after an i32 use was already committed.
  flexInt?: { leaves: Expr[]; valueExpr: Expr };
}

// Builtins that may realloc, free, or shift collection memory — illegal on a
// receiver with a live borrow (slice or active for-in). Read-only and in-place
// element ops are intentionally absent.
const MUTATING_COLLECTION_METHODS = new Set([
  "push", "pushStr", "pop", "insert", "remove", "reverse", "swap", "sort", "sortBy", "sortByKey",
  "clear", "truncate", "extend", "retain", "reserve",
]);

interface CaptureInfo {
  name: string;
  type: TypeKind;
  mutable: boolean;
  // Set when the closure body mutates this capture *in place* (assignment or a
  // mutating method on it). Distinguishes "needs write-back to the original"
  // (cannot be move-captured) from a capture that is merely read or moved out
  // (safe to move-capture). Drives the auto-move decision for generic-fn calls.
  mutatedInClosure?: boolean;
  // Set when the closure body MOVES this capture out (hands it to a callee by value).
  // Captures live in the environment's own slots, so the move zeroes the slot — which
  // makes the closure call-once: a second call reads the emptied slot.
  consumedInClosure?: boolean;
}

export interface FnSig {
  params: { type: TypeKind; name: string }[];
  ret: TypeKind;
  variadic: boolean;
  isExtern?: boolean;
  // carried for impl methods so call-site precondition checking (constant-arg
  // `requires`) works on `Type.method(...)` calls too, not just free functions.
  contracts?: import("./ast").Contract[];
}

interface StructInfo {
  // `iterDelegate`: `@iter` on the field — `for x in wrapper` iterates this field
  // instead of looking for a `next` method. Lets a newtype keep the container's
  // iteration without leaking the field or paying for a snapshot.
  fields: { name: string; type: TypeKind; cOpaque?: boolean; iterDelegate?: boolean }[];
  baseName?: string;
  typeArgs?: TypeKind[];
  isExtern?: boolean;
  isOpaque?: boolean;
  cLayout?: CLayout;
  // `@noCopy`: this type is move-tracked however plain its fields are. See isAllCopyStruct.
  noCopy?: boolean;
  // `@copy`: this type stays Copy although it holds a raw pointer, because it does not own
  // what the pointer addresses. Inherited by every instantiation of a generic.
  copy?: boolean;
  // The first field of raw pointer type (directly or through a fixed array) on a struct
  // that is not `@copy`. Set at registration; it makes the struct move-tracked, since a
  // second copy would be a second owner of whatever the pointer addresses. Named so the
  // diagnostics can point at it. See isAllCopyStruct.
  pointerField?: string;
}

// The first field whose type is a raw pointer, directly or through a fixed array. A struct
// field of a pointer-holding struct is not reported here: that inner struct is itself
// move-tracked (or `@copy`), and the ordinary all-fields-Copy rule carries the verdict up.
export function rawPointerField(fields: { name: string; type: TypeKind }[]): string | undefined {
  const holdsPtr = (t: TypeKind): boolean => t.tag === "ptr" || (t.tag === "array" && holdsPtr(t.element));
  return fields.find(f => holdsPtr(f.type))?.name;
}

// A verified claim about a C type's layout, from `@cLayout(cType, header)`.
interface CLayout {
  cType: string;
  header: string;
}

// A verified claim about an extern fn's C signature, from `@cSig(header, sig)`.
interface CSig {
  header: string;
  sig: string;
}

// From `@cValue("SDL_INIT_VIDEO", "SDL2/SDL.h")` on a global: the C macro/enumerator
// this constant claims to mirror. `@cSig` and `@cLayout` verify functions and structs;
// a bare constant has no such anchor, so a wrong scancode or pixel format is a runtime
// bug (a dead key, a garbled frame) with no link error and no diagnostic.
interface CValue {
  cName: string;
  header: string;
}

export interface EnumInfo {
  baseName?: string;
  typeArgs?: TypeKind[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  reprType?: string; // set for `enum Kind: i32 { ... }` — the tag IS the integer value
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exprTypes: Map<Expr, TypeKind>;
  patternBindingTypes: Map<import("./ast").Pattern, TypeKind[]>;
  // The reference each nullable-extern-reference unwrap (`let g = p else { … }`) binds.
  // Lowering reads it to emit the null test and the binding; nothing else can derive it,
  // because the parameter's own type is the `*T` the ABI passes.
  nullRefUnwraps: Map<import("./ast").LetElseStmt, { inner: TypeKind; mutable: boolean }>;
  autoBorrowed: Map<Expr, { mutable: boolean }>;
  matchSubjectRef: Set<Expr>;
  rewrittenCalls: Map<Expr, string>;
  rewrittenEnums: Map<Expr, string>;
  staticCalls: Map<Expr, string>;
  rewrittenStructLits: Map<Expr, string>;
  movedExprs: Set<Expr>;
  borrowedExprs: Set<Expr>;
  autoWrappedOption: Map<Expr, string>;
  arrayToVecCoercions: Set<Expr>;
  functions: Map<string, FnSig>;
  structs: Map<string, StructInfo>;
  enums: Map<string, EnumInfo>;
  dropImpls: Set<string>;
  monomorphizedFns: Function[];
  monomorphizedEnums: import("./ast").EnumDecl[];
  monomorphizedStructs: StructDecl[];
  closureCaptures: Map<Expr, CaptureInfo[]>;
  closureCalls: Map<Expr, TypeKind>;
  cfnCalls: Map<Expr, TypeKind>;
  resolvedMethods: Map<Expr, string>;
  // method calls whose receiver was auto-dereffed through a Heap<T>
  heapMethodReceivers: Set<Expr>;
  resolvedOperators: Map<Expr, string>;
  fnFieldCalls: Set<Expr>;
  cfnFieldCalls: Set<Expr>;
  propagateConversions: Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>;
  rangeCheckedExprs: Map<Expr, { min: number; max: number; typeName: string }>;
  sizeOfTypes: Map<Expr, TypeKind>;
  cSigs: Map<string, CSig>;
  cValues: Map<string, CValue>;
  offsetOfFields: Map<Expr, string>;
  interfaces: Map<string, InterfaceInfo>;
  interfaceCoercions: Map<Expr, { fromType: string; ifaceName: string }>;
  interfaceMethodCalls: Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>;
  autoJsonStringify: Map<Expr, TypeKind>;
  arraySliceArgs: Set<Expr>;
  autoJsonToJson: Map<Expr, string>;
  anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[];
  globalTypes?: Map<string, TypeKind>;
  // Module-level globals whose initializer has to RUN (a non-empty string, a Vec, any
  // call). Codegen collects exactly these into `@__milo.global_init` and calls it from
  // main, so a build with no entry point to call it leaves them zeroed: `emit-obj
  // --no-entry` reads this list and refuses rather than emitting the silent zero.
  nonConstGlobals: string[];
  iteratorForIns: Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>;
  stringViewForIns: Map<Stmt, { mode: "lines" | "split" }>;
  // `for x in wrapper` where the struct has an `@iter` field: the field to walk instead.
  iterDelegates: Map<Stmt, string>;
}

interface GenericEnumInfo {
  typeParams: string[];
  typeParamDefaults?: (TypeKind | null)[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  decl: import("./ast").EnumDecl;
}

interface GenericStructInfo {
  typeParams: string[];
  fields: { name: string; type: TypeKind }[];
  decl: StructDecl;
}

interface GenericFnInfo {
  typeParams: string[];
  decl: Function;
}

interface TraitMethodInfo {
  params: { name: string; type: TypeKind }[];
  ret: TypeKind;
  hasDefault: boolean;
}

interface TraitInfo {
  name: string;
  supertraits: string[];
  methods: Map<string, TraitMethodInfo>;
}

interface ImplInfo {
  traitName: string | null;
  typeName: string;
  methods: Map<string, FnSig>;
}

interface InterfaceMethodInfo {
  params: { name: string; type: TypeKind }[];
  ret: TypeKind;
}

interface InterfaceInfo {
  name: string;
  methods: Map<string, InterfaceMethodInfo>;
}

// Thrown by `TypeChecker.fatal`, caught by `TypeChecker.recover`. Carries no
// message: the diagnostic is already in `diagnostics` by the time this is thrown,
// and this type exists only to unwind. It is deliberately NOT exported — an
// escape past the outermost boundary is a checker bug, not a user-visible error.
class CheckAbort extends Error {
  constructor() {
    super("check aborted");
  }
}

// Narrow an Expr union member by its `kind`, so an extracted arm keeps exactly the
// type the switch gave it without importing every node interface.
type ExprOf<K extends Expr["kind"]> = Extract<Expr, { kind: K }>;

// What a whole-program pass may ask of the finished program. Built once by
// `TypeChecker.programView` after every body is checked; see that method for why.
interface ProgramView {
  // Every function with a body the passes can walk, by mangled name: free fns plus the
  // monomorphized instances (impl methods, generic instantiations).
  fns: Map<string, Function>;
  // The mangled callee a Call / EnumLit / MethodCall resolved to, or the bare name for a
  // Call nothing rewrote. Undefined for enum construction and for calls through values.
  calleeOf(e: Expr): string | undefined;
  // The binding a place expression roots at (`G`, `G.f`, `G[i]`, `G!.f` all give `G`),
  // or undefined for a non-expression or a place with no single named root.
  rootOf(e: unknown): string | undefined;
  // A mangled name as the user wrote it, for diagnostics.
  pretty(name: string): string;
}

export class TypeChecker {
  private warningConfig: WarningConfig;
  private diagnostics: Diagnostic[] = [];
  // Deferred Vec element inference: `var v = Vec.new()` with no annotation gets a
  // placeholder element object, resolved in-place from the first `v.push(x)`.
  // inferVecElems holds the live placeholder objects (identity set); pendingInferVecs
  // records each with its span so an unresolved one (no push ever seen) can error.
  private inferVecElems = new WeakSet<object>();
  private pendingInferVecs: Array<{ elem: TypeKind; span: Span | undefined }> = [];
  private _globalTypes = new Map<string, TypeKind>();
  private _nonConstGlobals: string[] = [];
  private functions = new Map<string, FnSig>();
  private fnDecls = new Map<string, Function>();
  // Which contract clause is being checked, if any. `old()` is legal only inside `ensures`,
  // and the error for it elsewhere reads better naming the clause it was found in.
  private contractScope: "requires" | "ensures" | "invariant" | "decreases" | null = null;
  private genericFns = new Map<string, GenericFnInfo>();
  // fns already flagged for a reference return — the declaration scan and checkFunction
  // both see plain fns, and only the second sees impl methods
  private refReturnReported = new Set<Function>();
  private structs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private genericEnums = new Map<string, GenericEnumInfo>();
  private genericStructs = new Map<string, GenericStructInfo>();
  // Store the alias's AST type, not a resolved TypeKind: aliases are registered
  // before enums/structs, so eager resolution would mis-tag a referenced enum as
  // a struct (breaks `?` auto-From into an aliased Result error type). Resolve
  // lazily at each use site, when every type name is registered.
  private typeAliases = new Map<string, MiloType>();
  // Alias names currently being expanded. `type A = A`, `type A = B` / `type B = A`, and the
  // generic `type Loop<T> = Loop<T>` all resolve by expanding a body that names the alias
  // again; without this the recursion runs until the JS stack dies and the user gets a host
  // stack trace instead of a diagnostic. It exits 1 either way, so this is a message fix
  // rather than a silent-success one.
  private expandingAliases = new Set<string>();
  // Parameters of a GENERIC alias, by alias name. An alias is a template expanded at the
  // use site rather than a type of its own, so this is the arity to check the use against
  // and the names to substitute — there is no instantiation to record anywhere.
  private aliasTypeParams = new Map<string, string[]>();
  private rangeCheckedExprs = new Map<Expr, { min: number; max: number; typeName: string }>();
  private returnHint: TypeKind | null = null;
  private monomorphizedDecls: import("./ast").EnumDecl[] = [];
  private monomorphizedStructDecls: StructDecl[] = [];
  private monomorphizedFns: Function[] = [];
  private voidGenericReported = new Set<string>();
  // Guard against an unbounded recursive generic (e.g. `fn grow<T>() { grow<Wrap<T>>() }`)
  // whose every instantiation is a fresh type, so the memo never hits and checkFunction
  // recurses until the JS stack blows. Cap the instantiation depth and fail cleanly.
  private static readonly MAX_MONO_DEPTH = 256;
  private monoDepth = 0;
  private monoDepthErrored = false;
  private dropImpls = new Set<string>();
  private sendTypes = new Set<string>();
  private syncTypes = new Set<string>();
  // Depth of nesting inside the OBJECT of a field/index access. While raised, an
  // identifier read is naming a container on the way to a narrower place rather than
  // using the value itself — the one distinction the partial-move read rule needs.
  // A new object-checking site that forgets to raise it over-reports rather than
  // under-reports, which is the direction to fail in.
  private placeBaseDepth = 0;
  private unsafeDepth = 0;
  // Parallel to unsafeDepth: one flag per live `unsafe` block, set true the moment
  // an operation inside it actually needs unsafe. A block popped still false is the
  // unused-unsafe lint target. Marking happens at the real check sites (via
  // requireUnsafe) so ops nested in call args/closures count — the trap the
  // prior statement-walker attempt fell into.
  private unsafeUsedStack: boolean[] = [];
  private scopes: Map<string, VarInfo>[] = [];
  private exprTypes = new Map<Expr, TypeKind>();
  // Per-pattern payload binding types (parallel to pattern.bindings), for hover/LSP.
  private patternBindingTypes = new Map<import("./ast").Pattern, TypeKind[]>();
  private nullRefUnwraps = new Map<import("./ast").LetElseStmt, { inner: TypeKind; mutable: boolean }>();
  private autoBorrowed = new Map<Expr, { mutable: boolean }>();
  private matchSubjectRef = new Set<Expr>();
  private rewrittenCalls = new Map<Expr, string>();
  private rewrittenEnums = new Map<Expr, string>();
  private staticCalls = new Map<Expr, string>();
  private rewrittenStructLits = new Map<Expr, string>();
  private movedExprs = new Set<Expr>();
  private borrowedExprs = new Set<Expr>();
  // Subjects consumed by the destructuring arm/pattern currently being checked.
  // Only drives the wording of the use-after-move error, which is otherwise
  // misleading here (the transfer point is the pattern, not an earlier stmt).
  private movedByPattern = new Set<object>();
  private autoWrappedOption = new Map<Expr, string>();
  private arrayToVecCoercions = new Set<Expr>();
  private closureCaptures = new Map<Expr, CaptureInfo[]>();
  // Closure literals whose body moves a capture out — call-once (see CaptureInfo).
  private onceClosures = new Set<Expr>();
  private closureCalls = new Map<Expr, TypeKind>();
  private cfnCalls = new Map<Expr, TypeKind>();
  private sizeOfTypes = new Map<Expr, TypeKind>();
  private cSigs = new Map<string, CSig>();
  private cValues = new Map<string, CValue>();
  private offsetOfFields = new Map<Expr, string>();
  private closureScopeDepth: number | null = null;
  // Nesting depth of a `sortByKey` key-extractor body currently being checked — the one
  // callee known to read a returned field without retaining or dropping it. Only the
  // move-out-of-a-borrow rule reads it; see the FieldAccess branch of tryMove.
  private keyExtractorDepth = 0;
  private currentClosureCaptures: Map<string, CaptureInfo> | null = null;
  private closureParamHints: TypeKind[] | null = null;
  // The expected RETURN type of a closure being checked against a fn-typed hint. Without
  // it an un-annotated `() => 0` always infers i64, so `opt.unwrapOrElse(() => 0)` on an
  // Option<i32> failed with "callback must return i32, got i64" — the literal never saw
  // the context that would have coerced it. Param hints were already propagated; this is
  // the other half.
  private closureRetHint: TypeKind | null = null;
  private currentFnRetType: TypeKind = { tag: "void" };
  private loopDepth = 0;
  // Track variables moved exclusively inside return stmts within loops.
  // Stack entry per loop nesting level.
  private returnOnlyMovesStack: Set<VarInfo>[] = [];
  private inReturnInLoop = false;
  private traits = new Map<string, TraitInfo>();
  private traitImpls = new Map<string, ImplInfo[]>();
  private inherentImpls = new Map<string, ImplInfo>();
  private genericImpls = new Map<string, { impl: import("./ast").ImplDecl; program: Program }[]>();
  // Methods carrying their OWN type parameters (`fn map<R>(…)`), keyed `Type$method`.
  //
  // These cannot be registered as a concrete signature the way every other method is: `R`
  // is not known until a call site supplies it, and resolving it eagerly produced a
  // signature mentioning a struct type literally named "R" — which is why
  // `b.map((x: &i64): i64 => x * 2)` used to report *"expected (&i64) => R, got
  // (&i64) => i64"*. So the declaration is kept as a template and instantiated per call,
  // the same lifecycle `monomorphizeFn` gives a generic free function. The struct's own
  // parameters are still substituted eagerly in `monomorphizeStruct`, so a method on
  // `Arena<T>` arrives here already concrete in `T` and generic only in `R`.
  private genericMethods = new Map<string, { decl: Function; owner: string }>();
  private _pendingImplFns: Function[] = [];
  // Trait bounds on a generic STRUCT's type params, checked after every impl has
  // registered. A struct is monomorphized as soon as a field mentions it, which can
  // be before `impl Reader for File` exists — checking eagerly would reject the
  // legal case, so the verdict waits until the impl tables are complete.
  private _pendingStructBounds: { struct: string; mangled: string; param: string; concrete: TypeKind; bound: string }[] = [];
  private _boundFailedStructs = new Set<string>();
  // `@copyOnly` on a generic struct: each instantiation's type args must be Copy. Deferred
  // for the same reason as the trait bounds above, and one more: a struct is monomorphized
  // while other structs are still being registered, and `isAllCopyStruct` on a name that
  // is not registered yet answers false, which would reject `Shard<Point>` for a `Point`
  // declared further down the file.
  private _pendingCopyOnly: { generic: string; mangled: string; concrete: TypeKind; span?: Span }[] = [];
  // One report per offending type, not per instantiation: `parallelMap(strings, 4, f)`
  // reaches `Shards<string>`, whose fields and methods then reach `Shard<string>`, and
  // only the first of those sits on a line the user wrote.
  private copyOnlyReported = new Set<string>();
  private resolvedMethods = new Map<Expr, string>();
  private heapMethodReceivers = new Set<Expr>();
  private iteratorForIns = new Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>();
  private stringViewForIns = new Map<Stmt, { mode: "lines" | "split" }>();
  private iterDelegates = new Map<Stmt, string>();
  private resolvedOperators = new Map<Expr, string>();
  private fnFieldCalls = new Set<Expr>();
  // `s.f(...)` where `f` is a C function-pointer field: an indirect call with no
  // environment argument, distinct from the fat-closure ClosureCall lower path.
  private cfnFieldCalls = new Set<Expr>();
  // Every READ of a C function-pointer field, recorded when it is checked and deleted
  // again by the two contexts that may consume one (a store into another such field,
  // and `isNull`). Whatever is left when the program is checked is a use the design
  // does not cover, so the rule fails closed: a context nobody thought about errors
  // rather than silently handing a thin pointer to code that expects a fat one.
  private strandedCFnReads = new Map<Expr, { struct: string; field: string; span?: Span }>();
  private propagateConversions = new Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>();
  private interfaces = new Map<string, InterfaceInfo>();
  private interfaceCoercions = new Map<Expr, { fromType: string; ifaceName: string }>();
  private interfaceMethodCalls = new Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>();
  private autoJsonStringify = new Map<Expr, TypeKind>();
  // Arguments where a fixed array is being passed to a slice parameter. Lowering turns
  // each into a full-range slice; the checker cannot do it because the conversion is a
  // representation change, not a type judgement.
  private arraySliceArgs = new Set<Expr>();
  // Subset of the above whose struct has a `toJson`: the mangled name to call
  // instead of the built-in stringifier.
  private autoJsonToJson = new Map<Expr, string>();
  private anonStructCounter = 0;
  private anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[] = [];
  private _userFnNames?: Set<string>;
  private entryFile?: string;
  private _userImplKeys?: Set<string>;
  // Manifest dep names whose symbols carry a `<pkg>$` prefix (see fnIsUserCode).
  private _packageNames?: Set<string>;
  // true while checking a function from the user's own file (not imported code);
  // gates lints that would otherwise flood every compile with stdlib noise
  private currentFnIsUser = true;

  constructor(warningConfig?: WarningConfig) {
    const config = warningConfig ?? { denied: new Set(), allowed: new Set() };
    // `--expect=<name>` counts as asking for the warning, exactly as `--deny` does.
    // Without this an off-by-default lint stayed off, never fired, and the expectation
    // then reported itself unfulfilled against code that does contain the finding.
    if (!config.denied.has("unused-move") && !config.expected?.has("unused-move")) config.allowed.add("unused-move");
    // unverified-extern is OFF unless asked for: pairing an `extern struct` with a local
    // .c peer (no header) is a legitimate, common FFI shape — this repo's own ABI-test
    // fixtures do exactly that — and @cLayout has no header to name there. A lint that
    // fires on code that cannot be fixed is one users turn off wholesale, taking the
    // cases that *are* fixable with it. `--deny=unverified-extern` opts a project in
    // (e.g. a binding crate or a safety-critical build where every layout must be pinned).
    if (!config.denied.has("unverified-extern") && !config.expected?.has("unverified-extern")) config.allowed.add("unverified-extern");
    // unused-import is OFF unless asked for. An import can be needed without the
    // entry file ever naming the symbol: node-milo's main.milo imports binding symbols
    // purely so those modules get compiled and linked. Warning by default would fire on
    // every one of them, and the fix ("just delete it") would break the build — so the
    // projects that don't do that opt in.
    if (!config.denied.has("unused-import") && !config.expected?.has("unused-import")) config.allowed.add("unused-import");
    // large-stack-array is OFF unless asked for. Big fixed-size locals are a real
    // stack-overflow footgun, but plenty are intentional (main-thread framebuffers
    // that work fine), so warning by default would nag every graphics program. The
    // always-on hover note already surfaces the size; projects opt into the hard lint.
    if (!config.denied.has("large-stack-array") && !config.expected?.has("large-stack-array")) config.allowed.add("large-stack-array");
    // single-variant-match is OFF while the tree is still being swept. The rewrite it asks
    // for is always an improvement, but the shape is everywhere: 304 sites in src-milo, 110
    // in milojs, 55 in examples/ at the census that shipped it. Default-on before the sweep
    // would bury every real warning under it. Flip it on once those reach zero.
    if (!config.denied.has("single-variant-match") && !config.expected?.has("single-variant-match")) config.allowed.add("single-variant-match");
    // opaque-call-on-thread is OFF until the thread-boundary scan resolves function values
    // with a statically known target. Every hit in the tree today (rg.milo, the Once
    // fixture) is a callback that touches no global, so on-by-default would be two false
    // positives and no true ones. Flip it on once the scan can see through `let f = bump`.
    if (!config.denied.has("opaque-call-on-thread") && !config.expected?.has("opaque-call-on-thread")) config.allowed.add("opaque-call-on-thread");
    // unowned-pointer-copy is OFF by default: it fires on every `@copy` struct, which is to
    // say on a deliberate annotation, not a smell. It exists so `--deny=unowned-pointer-copy`
    // can enumerate the pointer-holding Copy types of a build and audit each claim.
    if (!config.denied.has("unowned-pointer-copy") && !config.expected?.has("unowned-pointer-copy")) config.allowed.add("unowned-pointer-copy");
    // index-clone is ON by default. It was off on the theory that most hits are working
    // code paying a cost the author accepted, but the lint does not fire on the cases
    // where that is true: `isCopy` skips register copies, so a `Vec<Pod>` bind is silent
    // and only an element that owns heap is reported. What is left is a malloc per
    // element per iteration written in syntax that looks free, with two free spellings
    // (`for x in v`, `v[i].n`) sitting right there in the hint. A cost that invisible is
    // exactly what a default-on warning is for; measured across examples/ it is tens of
    // hits, not hundreds. `--allow=index-clone` silences it for a project that wants it.
    // unused-unsafe is on by default but fires only in user code (see currentFnIsUser):
    // the permissive safe-extern rule makes most stdlib unsafe blocks technically
    // removable, so warning on imported std would flood every compile.
    this.warningConfig = config;
  }

  // `adopt<T>`/`adoptSlice<T>` on a struct whose fields are raw pointers frees the struct
  // and NOTHING it addresses: a raw pointer is not owned, so it gets no drop glue. That is
  // correct — it is what makes the layout an ABI match — but it is the one thing about
  // `adopt` a reader is likely to assume otherwise, and it is exactly the shape a C-derived
  // `extern struct` has. A warning rather than an error, because borrowed pointer fields
  // are the normal case and the compiler cannot tell those from owned ones.
  private warnAdoptRawFields(fnName: string, declSpan: Span | undefined, typeArgs: TypeKind[], sp?: Span) {
    if (fnName !== "adopt" && fnName !== "adoptSlice") return;
    if (!isForeignModule(declSpan?.file)) return;
    const t = typeArgs[0];
    if (t?.tag !== "struct") return;
    const raw = (this.structs.get(t.name)?.fields ?? []).filter(f => f.type.tag === "ptr");
    if (raw.length === 0) return;
    this.warn("adopt-raw-fields",
      `'${fnName}<${this.show(t)}>': dropping the adopted value frees the ${this.show(t)} itself and not what its raw pointer field(s) address`,
      sp,
      `${raw.map(f => `'${t.name}.${f.name}'`).join(", ")} ${raw.length === 1
        ? "is a raw pointer: it owns nothing and has no drop glue, so free what it addresses before the adopted value drops"
        : "are raw pointers: they own nothing and have no drop glue, so free what they address before the adopted value drops"}, or '--allow=adopt-raw-fields' if they are borrowed`);
  }

  // Can a value of this type exist at all? Conservative and total: anything not proven
  // empty is treated as inhabited, and a type that reaches itself is assumed inhabited
  // rather than chased, because deciding that case needs a fixpoint and getting it wrong
  // in the other direction would silently drop a real arm from an exhaustiveness check.
  private isUninhabited(t: TypeKind, seen: Set<string>): boolean {
    if (t.tag === "enum") {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      const info = this.enums.get(t.name);
      if (!info) return false;
      // Zero variants is the base case (`enum Never { }`); an enum all of whose variants
      // are themselves uninhabited has no constructible value either.
      return [...info.variants.values()].every(v => v.fields.some(f => this.isUninhabited(f, seen)));
    }
    if (t.tag === "struct") {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      const info = this.structs.get(t.name);
      if (!info) return false;
      // A product needs every field, so one uninhabited field is enough.
      return info.fields.some(f => this.isUninhabited(f.type, seen));
    }
    // `[Never; 3]` cannot be built; `[Never; 0]` and an empty `Vec<Never>` can.
    if (t.tag === "array" && t.size !== null && t.size > 0) return this.isUninhabited(t.element, seen);
    return false;
  }

  private error(msg: string, span?: Span, hint?: string) {
    this.diagnostics.push({ severity: "error", span, message: msg, hint });
  }

  // `void` has no runtime representation, so anything that gives it a storage slot (a
  // generic instantiated at void, a local bound to a void call) lowers to `alloca void`,
  // `call void @f(void void)` or `getelementptr void`, all of which LLVM rejects at the
  // link step against a temp .ll file with no source location. Reject here, where a span
  // may still exist. `Unit` (std/prelude, auto-imported) is the value-shaped spelling.
  // Real zero-sized-type support would make this legal; until then, failing in the right
  // place with the right advice beats failing in the linker with none.
  private rejectVoidTypeArgs(owner: string, args: TypeKind[], sp?: Span): boolean {
    if (!args.some(a => a.tag === "void")) return false;
    // One report per compilation, not per generic: `Promise<void>` instantiates Channel,
    // Result and Option with the same void, and four copies of one mistake buries the fix.
    // A second, genuinely independent void mistake surfaces on the next run.
    const first = this.voidGenericReported.size === 0;
    this.voidGenericReported.add(owner);
    if (first) {
      this.error(`'${owner}' cannot be instantiated with 'void': 'void' has no runtime representation`, sp,
        `use 'Unit' for a value that carries no data: '${owner}<Unit>', constructed as 'Unit {}'`);
    }
    return true;
  }

  // Every method name callable on `t`, for "did you mean" only. Builtin receivers
  // dispatch through hand-written if-chains with no symbol table, so their names
  // come from the lists in suggest.ts; user types read their real impl blocks.
  private methodCandidates(t: TypeKind): string[] {
    const bare = t.tag === "ref" ? t.inner : t;
    switch (bare.tag) {
      case "vec": case "array": return [...VEC_MEMBERS];
      case "hashmap": return [...HASHMAP_MEMBERS];
      case "string": return [...STRING_MEMBERS];
      // Scalars dispatch by hand too, and their surface is the overflow escape
      // hatch (wrappingAdd, checkedMul, …) — without these a typo there was the
      // one member mistake in the language that got no suggestion at all.
      case "int": return [...INT_MEMBERS];
      case "float": return [...FLOAT_MEMBERS];
      case "bool": return [...BOOL_MEMBERS];
      default: break;
    }
    const name = (bare as any).name;
    if (typeof name !== "string") return [];
    const out: string[] = [];
    // Option/Result have no impl block — their combinators live in the checker, so
    // without this the member tables are the only place that knows them and a typo
    // gets no suggestion at all.
    if (bare.tag === "enum") {
      const base = this.enums.get(name)?.baseName;
      if (base === "Option") out.push(...OPTION_MEMBERS);
      if (base === "Result") out.push(...RESULT_MEMBERS);
    }
    const inherent = this.inherentImpls.get(name);
    if (inherent) out.push(...inherent.methods.keys());
    for (const impl of this.traitImpls.get(name) ?? []) out.push(...impl.methods.keys());
    const sdef = this.structs.get(name);
    // fn-typed fields are callable as methods, so they belong in the candidate set
    if (sdef) for (const f of sdef.fields) if (f.type.tag === "fn") out.push(f.name);
    return out;
  }

  // A plain `"..."` is not interpolated — only `$"..."` is. `"hi ${name}"` and
  // `"hi {name}"` therefore compile to those characters verbatim, with no error,
  // which is the one way to get silently wrong output in this language. Warning
  // requires the braced name to actually resolve in scope, so a literal holding
  // shell (`"${PATH}"`), CSS, or a format string for some other tool stays quiet.
  private checkMissingInterpolation(expr: import("./ast").StringLit) {
    if (expr.fromFString) return;
    const v = expr.value;
    if (!v.includes("{")) return;
    for (const m of v.matchAll(/\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (!this.lookup(m[1])) continue;
      this.warn("missing-interpolation", `'${m[0]}' in a plain string is not interpolated`, expr.span,
        `prefix the literal with '$' to interpolate: $"...{${m[1]}}..."  (Milo drops the '$' inside the braces)`);
      return;
    }
  }

  // `Foo.bar()` where the whole thing failed to resolve. Three very different
  // mistakes land here — a typo'd static method, a typo'd type name, and a type
  // that exists in std but wasn't imported — and reporting all three as "unknown
  // enum" left the reader with nothing to act on (and, for a struct, a word that
  // doesn't apply to their code at all).
  private errorUnknownStatic(typeName_: string, member: string, sp: Span | undefined) {
    const known = this.structs.has(typeName_) || this.enums.has(typeName_) ||
      this.genericStructs.has(typeName_) || this.genericEnums.has(typeName_);
    if (known) {
      const statics: string[] = [...(this.inherentImpls.get(typeName_)?.methods.keys() ?? [])];
      for (const impl of this.traitImpls.get(typeName_) ?? []) statics.push(...impl.methods.keys());
      const variants = [...(this.enums.get(typeName_)?.variants.keys() ?? [])];
      // A generic type's impl block is only registered per monomorphization, so
      // `Arena.new()` finds nothing to call while `Arena<Node>.new()` works. The
      // empty candidate set would otherwise leave this error with no hint at all.
      const params = this.genericStructs.get(typeName_)?.typeParams ?? this.genericEnums.get(typeName_)?.typeParams;
      const hint = memberHint(member, [...statics, ...variants]) ??
        (params && params.length > 0
          ? `'${typeName_}' is generic — spell its type arguments: '${typeName_}<${params.join(", ")}>.${member}(...)'`
          : undefined);
      this.error(`type '${typeName_}' has no static method '${member}'`, sp, hint);
      return;
    }
    const fromStd = importHint(typeName_);
    if (fromStd) { this.error(`unknown type '${typeName_}'`, sp, fromStd); return; }
    const names = new Set<string>([
      ...this.structs.keys(), ...this.enums.keys(),
      ...this.genericStructs.keys(), ...this.genericEnums.keys(),
      ...stdExportNames(),
    ]);
    const near = closest(typeName_, names);
    this.error(`unknown type '${typeName_}'`, sp,
      near ? `did you mean '${near}'?` : `no type named '${typeName_}' is declared or imported here`);
  }

  // Nearest in-scope binding or function to a name that didn't resolve. Scopes are
  // searched innermost-out so a shadowing local wins the suggestion.
  private nameHint(name: string): string | undefined {
    const seen = new Set<string>();
    for (let i = this.scopes.length - 1; i >= 0; i--) for (const k of this.scopes[i].keys()) seen.add(k);
    for (const k of this.functions.keys()) if (!k.includes("$")) seen.add(k);
    const near = closest(name, seen);
    return near ? `did you mean '${near}'?` : undefined;
  }

  // Field names readable on `t`. The builtin containers expose exactly one, which
  // is what makes the `.length` → `.len` suggestion land.
  private fieldCandidates(t: TypeKind): string[] {
    const bare = t.tag === "ref" ? t.inner : t;
    switch (bare.tag) {
      case "vec": case "array": case "hashmap": case "string": return ["len"];
      case "struct": return this.structs.get(bare.name)?.fields.map(f => f.name) ?? [];
      default: return [];
    }
  }

  // Report and STOP. For the sites where the invariant the rest of the code needs
  // is exactly the one that just failed: a struct that isn't declared, a field
  // that doesn't exist, an expression that isn't a place. `error()` returns void,
  // so each of those had to remember its own `return`, and the ones that forgot
  // ran on a value the diagnostic had just proved absent. Throwing removes the
  // choice — and removes the `| null` from the signatures that had to encode it.
  //
  // Recovery is not lost: the throw unwinds to the nearest boundary (`recover`),
  // one per statement inside a function body and one per declaration above that,
  // so a run still reports an error in every statement that has one.
  private fatal(msg: string, span?: Span, hint?: string): never {
    this.error(msg, span, hint);
    throw new CheckAbort();
  }

  // A `fatal()` recovery boundary. Absorbs the unwind and rewinds the stacks the
  // abandoned work had pushed onto — a scope, an `unsafe` block, a loop body left
  // open would otherwise leak into whatever is checked next and misreport it.
  private recover(f: () => void) {
    const scopeDepth = this.scopes.length;
    const unsafeDepth = this.unsafeDepth;
    const unsafeUsed = this.unsafeUsedStack.length;
    const loopDepth = this.loopDepth;
    const closureDepth = this.closureScopeDepth;
    const captures = this.currentClosureCaptures;
    try {
      f();
    } catch (e) {
      if (!(e instanceof CheckAbort)) throw e;
      this.scopes.length = scopeDepth;
      this.unsafeDepth = unsafeDepth;
      this.unsafeUsedStack.length = unsafeUsed;
      this.loopDepth = loopDepth;
      this.closureScopeDepth = closureDepth;
      this.currentClosureCaptures = captures;
    }
  }

  // Names given to `--expect=` that actually fired, so an expectation that never did can
  // be reported. Recorded BEFORE the allow/deny decision, because whether the finding
  // occurred is a different question from whether it was shown.
  private firedWarnings = new Set<string>();

  private warn(code: string, msg: string, span?: Span, hint?: string, len?: number) {
    if (this.warningConfig.expected?.has(code)) {
      this.firedWarnings.add(code);
      return; // expected findings are suppressed, exactly like an allow
    }
    if (this.warningConfig.allowed.has(code)) return;
    const severity = (this.warningConfig.denied.has(code) || this.warningConfig.denied.has("*")) ? "error" : "warning";
    this.diagnostics.push({ severity, span, len, message: msg, hint, code });
  }

  // Conservative byte size of a fixed-size array whose leaves are scalars.
  // Returns null when any dimension is dynamic or a leaf isn't a fixed-width
  // scalar (structs/enums/vecs have layout we don't compute here). Used only to
  // flag oversized stack allocations — an underestimate is fine, a false alarm is not.
  private fixedArrayBytes(t: TypeKind): number | null {
    if (t.tag !== "array" || t.size === null) return null;
    const elemBytes = (e: TypeKind): number | null => {
      if (e.tag === "int" || e.tag === "float") return e.bits / 8;
      if (e.tag === "bool") return 1;
      if (e.tag === "ptr" || e.tag === "ref") return 8;
      if (e.tag === "array") return this.fixedArrayBytes(e);
      return null;
    };
    const eb = elemBytes(t.element);
    return eb === null ? null : eb * t.size;
  }

  // A local fixed array is a stack allocation of its full size, up front. Big ones
  // silently overflow the stack at runtime (same trap Rust's `[T; N]` has). Warn so
  // the fix — a heap `Vec<T>` — is visible at the declaration.
  private lintStackArray(name: string, ty: TypeKind, span?: Span) {
    // Opt-in only (see constructor); skip the byte math entirely when suppressed.
    if (this.warningConfig.allowed.has("large-stack-array")) return;
    const threshold = this.warningConfig.maxStackArrayBytes ?? 512 * 1024;
    const bytes = this.fixedArrayBytes(ty);
    if (bytes === null || bytes <= threshold) return;
    const kib = bytes / 1024;
    const human = kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${Math.round(kib)} KiB`;
    const elemName = ty.tag === "array" ? this.show(ty.element) : "T";
    this.warn(
      "large-stack-array",
      `'${name}' is a ${human} stack allocation`,
      span,
      `large local arrays can overflow the stack; use Vec<${elemName}> for a heap buffer`,
    );
  }

  // `let m = v[i]` on a non-Copy element is a deep copy: indexing clones so the
  // container stays intact (the field spelling `b.v` is a hard error instead — see the
  // aliasing matrix). The cost is invisible at the use site, because the SAME syntax is
  // free or a malloc depending on a field of the element type you cannot see there:
  // `Vec<i64>` costs nothing, `Vec<Mark>` costs an allocation per heap field, per row,
  // per iteration. `for m in v` binds by reference and clones nothing, so the cheap
  // spelling already exists — it is just undiscoverable at the moment it matters.
  // A value whose duplication has a MEANING beyond copying bytes: a struct with a Drop
  // impl that releases something, `@noCopy` on a handle, or a raw pointer field without
  // `@copy`, anywhere inside the type.
  // The index path's deep clone (codegen emitDeepCloneFromPtr) is structural: it copies
  // strings and Vecs buffer by buffer but never consults a Drop impl, so a resource
  // nested in an `Option<Fd>` or a `Vec<Fd>` element is duplicated just as surely as a
  // bare `Fd`. Returns which mechanism and the type that carries it, for the diagnostic.
  private resourceKind(ty: TypeKind, seen: Set<string> = new Set()): { kind: string; via: TypeKind } | null {
    switch (ty.tag) {
      case "struct": {
        if (this.dropImpls.has(ty.name)) return { kind: "Drop", via: ty };
        const info = this.structs.get(ty.name);
        if (!info) return null;
        if (info.noCopy) return { kind: "@noCopy", via: ty };
        if (info.pointerField) return { kind: `a raw pointer field ('${info.pointerField}') and is not @copy`, via: ty };
        // Recursive types (`Heap<Node>` fields) terminate on the visited set.
        if (seen.has(ty.name)) return null;
        seen.add(ty.name);
        for (const f of info.fields) {
          const r = this.resourceKind(f.type, seen);
          if (r) return r;
        }
        return null;
      }
      case "enum": {
        if (this.dropImpls.has(ty.name)) return { kind: "Drop", via: ty };
        if (seen.has(ty.name)) return null;
        seen.add(ty.name);
        const info = this.enums.get(ty.name);
        if (!info) return null;
        for (const v of info.variants.values()) {
          for (const f of v.fields) {
            const r = this.resourceKind(f, seen);
            if (r) return r;
          }
        }
        return null;
      }
      case "vec": case "array": return this.resourceKind(ty.element, seen);
      case "heap": return this.resourceKind(ty.inner, seen);
      case "hashmap": return this.resourceKind(ty.key, seen) ?? this.resourceKind(ty.value, seen);
      default: return null;
    }
  }

  // Taking a Drop or @noCopy element out of a container by INDEX is an error, not a
  // lint. The index path copies memberwise and consults neither mechanism, so both ways
  // of saying "this handle has exactly one owner" were bypassed by one spelling:
  // `let a = v[0]` on a `Vec<Fd>` closed the same descriptor twice, and on a `@noCopy`
  // handle released it twice. The field spelling of the same operation already errors.
  //
  // Lives in tryMoveLeaf, the one place every by-value consumption reaches, because the
  // rule used to fire only from the `let` initializer: `Option.Some(v[0])`, `peek(v[0])`,
  // `return v[0]`, `s.f = v[0]` and a struct-literal field were all accepted and each
  // ran the element's Drop once more (docs/plans/soundness-sweep-2026-09.md H5). An
  // element of a container is a place; reading it by value is a move-out, and for a
  // resource type that is an error wherever it appears.
  private errorIfResourceIndexRead(expr: Extract<Expr, { kind: "IndexAccess" }>, ty: TypeKind): boolean {
    const res = this.resourceKind(ty);
    if (!res) return false;
    const via = typeEq(res.via, ty) ? "" : ` (through '${this.show(res.via)}')`;
    const spelled = this.describeExpr(expr);
    const container = this.describeExpr(expr.object);
    this.error(
      `cannot take '${this.show(ty)}' out of a container by index: it carries ${res.kind}${via}`,
      expr.span,
      `indexing copies the element memberwise, so the copy and the container's own ` +
      `element would each release it. Clone it explicitly ('${spelled}.clone()'), borrow it ` +
      `('for x in ${container}', a field read '${spelled}.n', or a '&' parameter), or ` +
      `'swap'/'remove' it out so the container gives up its owner.`,
    );
    return true;
  }

  // The builtin spellings of the same read: `v.get(i)`/`first`/`last`, `m.get(k)`,
  // `keys()`/`values()` and a container `clone()` all hand out a structural copy of an
  // element, through the same codegen path `v[i]` takes, and so duplicate a resource the
  // same way. `what` is the method, `container` the receiver's type for the message.
  private errorIfResourceCopyOut(elem: TypeKind, what: string, container: string, sp: Span | undefined, borrowForm: string): boolean {
    const res = this.resourceKind(elem);
    if (!res) return false;
    const via = typeEq(res.via, elem) ? "" : ` (through '${this.show(res.via)}')`;
    this.error(`'${what}' would copy '${this.show(elem)}' out of the ${container}: it carries ${res.kind}${via}`, sp,
      `the copy is structural and never runs a Drop, so the copy and the element still in the ${container} ` +
      `would each release it. ${borrowForm}, or clone the element where its own Clone impl runs.`);
    return true;
  }

  private lintIndexClone(value: Expr, ty: TypeKind, span?: Span) {
    // A resource element is rejected by tryMoveLeaf, which every caller of this lint
    // reaches next; the cost warning below would only pile onto that error.
    if (value.kind === "IndexAccess" && ty.tag !== "ref" && this.resourceKind(ty)) return;
    // The cost warning below is advisory, and a warning inside std/ or a dependency is
    // not actionable by the person reading it (dapweb builds warned on std/argparse's
    // own argv loop). Same scoping as unused-unsafe; the Drop/@noCopy error above
    // stays everywhere because that one is a double release, not a cost.
    if (!this.currentFnIsUser) return;
    if (this.warningConfig.allowed.has("index-clone")) return;
    // Fork tails count: `if c { v[0] } else { v[1] }` clones whichever arm runs, and the
    // reader has no more reason to expect an allocation there than in the direct form.
    // moveTargets already knows where a value actually comes from, so reuse it rather
    // than re-deriving the tail rules here.
    if (value.kind === "IfExpr" || value.kind === "MatchExpr") {
      for (const t of this.moveTargets(value)) this.lintIndexClone(t, ty, t.span ?? span);
      return;
    }
    if (value.kind !== "IndexAccess") return;
    // Copy elements are a register move, not an allocation — nothing to warn about.
    if (this.isCopyType(ty)) return;
    // A ref binding (`let r: &T = ...`) borrows rather than clones.
    if (ty.tag === "ref") return;
    this.warn(
      "index-clone",
      `this deep-copies the ${this.show(ty)} out of the container`,
      span,
      `indexing clones so the container stays intact; 'for x in <container>' binds by reference and copies nothing, and a field read ('v[i].n') materialises no element`,
    );
  }

  // Whether a function name belongs to the user's own file. Mangled names cover
  // monomorphized user fns (`foo$i32`) and impl methods (`Type$method`,
  // `Type$Trait$method` — matched against userImplKeys `Type.method`).
  // No resolver info (direct TypeChecker use in tests/tools) → treat all as user.
  private fnIsUserCode(name: string): boolean {
    if (!this._userFnNames) return true;
    if (this._userFnNames.has(name)) return true;
    // Per-package mangling (src/mangle.ts) prefixes a dependency's symbols with
    // `<pkg>$`, so `http2$foo` and `http2$Box_i64$get` reach here. The `$` split
    // below assumes the first segment is a type-or-fn name, so a package prefix
    // makes both lookups miss — and mis-classifying dependency code as user code
    // (or vice versa) would point `unused-unsafe` at the wrong files entirely.
    // Only dep files are ever mangled, so a known package prefix settles it: not
    // user code. Empty when the program has no deps, i.e. a no-op by default.
    const firstSep = name.indexOf("$");
    if (firstSep > 0 && this._packageNames?.has(name.slice(0, firstSep))) return false;
    const parts = name.split("$");
    if (parts.length > 1) {
      if (this._userFnNames.has(parts[0])) return true;
      if (this._userImplKeys?.has(`${parts[0]}.${parts[parts.length - 1]}`)) return true;
    }
    return false;
  }

  // An operation that requires unsafe: error if outside a block, else mark the
  // innermost live block used (feeds the unused-unsafe lint).
  private requireUnsafe(msg: string, span?: Span, hint?: string) {
    if (this.unsafeDepth === 0) {
      this.error(msg, span, hint);
    } else if (this.unsafeUsedStack.length > 0) {
      this.unsafeUsedStack[this.unsafeUsedStack.length - 1] = true;
    }
  }

  // `@unsafe fn`: the callee carries a contract the compiler cannot check, so the
  // obligation lands on the CALLER. Every other unsafe rule triggers on an operation
  // (a deref, a pointer cast); this one exists because a function can be built
  // entirely out of individually checkable operations and still be unsound to call
  // with the wrong arguments, which is exactly the shape of a foreign-memory view.
  private requireUnsafeCall(decl: { attributes?: { name: string }[] } | undefined, name: string, span?: Span) {
    if (!decl?.attributes?.some(a => a.name === "unsafe")) return;
    this.requireUnsafe(`calling '${name}' requires an unsafe block`, span,
      `'${name}' is declared '@unsafe': it has a precondition the compiler cannot check, so the caller vouches for it`);
  }

  // compute the output range of an arithmetic operation on two ranged integers
  private propagateRange(lt: TypeKind & { tag: "int" }, rt: TypeKind & { tag: "int" }, op: string): TypeKind | null {
    const lmin = lt.min!, lmax = lt.max!, rmin = rt.min!, rmax = rt.max!;
    let outMin: number, outMax: number;
    switch (op) {
      case "+": outMin = lmin + rmin; outMax = lmax + rmax; break;
      case "-": outMin = lmin - rmax; outMax = lmax - rmin; break;
      case "*": {
        const products = [lmin * rmin, lmin * rmax, lmax * rmin, lmax * rmax];
        outMin = Math.min(...products);
        outMax = Math.max(...products);
        break;
      }
      case "/": {
        if (rmin <= 0 && rmax >= 0) return null; // divisor range includes zero
        const quotients = [lmin / rmin, lmin / rmax, lmax / rmin, lmax / rmax];
        outMin = Math.floor(Math.min(...quotients));
        outMax = Math.floor(Math.max(...quotients));
        break;
      }
      default: return null;
    }
    // clamp to the underlying type's representable range
    const typMin = lt.signed ? -(2 ** (lt.bits - 1)) : 0;
    const typMax = lt.signed ? 2 ** (lt.bits - 1) - 1 : 2 ** lt.bits - 1;
    outMin = Math.max(outMin, typMin);
    outMax = Math.min(outMax, typMax);
    return { tag: "int", bits: lt.bits, signed: lt.signed, min: outMin, max: outMax };
  }

  // extract a constant integer value from an expression (handles IntLit and -IntLit)
  private constIntValue(expr: import("./ast").Expr): bigint | null {
    if (expr.kind === "IntLit") return expr.value;
    if (expr.kind === "UnaryOp" && expr.op === "-" && expr.operand.kind === "IntLit") return -expr.operand.value;
    return null;
  }

  // Enforce a ranged integer target (`i32(0..100)`) against a value flowing into it — at a
  // let/var, a call argument, a `return`, or a reassignment. A const literal out of range is
  // a compile error; a value whose propagated range already fits needs no check; otherwise a
  // runtime range check is emitted (via rangeCheckedExprs). Without this the range was
  // enforced at declarations only, so `f(500)` into an `i32(0..100)` param silently passed.
  private enforceRangeInto(valueExpr: Expr, valType: TypeKind, target: TypeKind, sp?: Span) {
    if (target.tag !== "int" || target.min === undefined || target.max === undefined) return;
    const litVal = this.constIntValue(valueExpr);
    if (litVal !== null) {
      if (litVal < BigInt(target.min) || litVal > BigInt(target.max)) {
        this.error(`value ${litVal} is out of range for ${this.show(target)} (${target.min}..${target.max})`, sp);
      }
    } else if (valType.tag === "int" && valType.min !== undefined && valType.max !== undefined &&
               valType.min >= target.min && valType.max <= target.max) {
      // range propagation proved the value fits — no runtime check needed
    } else {
      this.rangeCheckedExprs.set(valueExpr, { min: target.min, max: target.max, typeName: typeName(target) });
    }
  }

  private constFloatValue(expr: import("./ast").Expr): number | null {
    if (expr.kind === "FloatLit") return expr.value;
    if (expr.kind === "UnaryOp" && expr.op === "-" && expr.operand.kind === "FloatLit") return -expr.operand.value;
    return null;
  }

  private constNumericValue(expr: import("./ast").Expr): number | null {
    // narrows to a JS number for float/contract-eval callers — fine for the
    // magnitudes those use; exact 64-bit checks go through constIntValue.
    const iv = this.constIntValue(expr);
    if (iv !== null) return Number(iv);
    return this.constFloatValue(expr);
  }

  // Evaluate a contract expression with argument substitutions. Returns true/false/null.
  private tryEvalContractExpr(expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>): boolean | null {
    if (expr.kind === "BoolLit") return expr.value;

    if (expr.kind === "IntLit" || expr.kind === "FloatLit") return null;

    if (expr.kind === "Ident") {
      const sub = subs.get(expr.name);
      if (sub) return this.tryEvalContractExpr(sub, new Map());
      return null;
    }

    if (expr.kind === "UnaryOp" && expr.op === "!") {
      const inner = this.tryEvalContractExpr(expr.operand, subs);
      return inner !== null ? !inner : null;
    }

    if (expr.kind === "BinOp") {
      // short-circuit logic
      if (expr.op === "&&") {
        const l = this.tryEvalContractExpr(expr.left, subs);
        if (l === false) return false;
        const r = this.tryEvalContractExpr(expr.right, subs);
        if (r === false) return false;
        if (l === true && r === true) return true;
        return null;
      }
      if (expr.op === "||") {
        const l = this.tryEvalContractExpr(expr.left, subs);
        if (l === true) return true;
        const r = this.tryEvalContractExpr(expr.right, subs);
        if (r === true) return true;
        if (l === false && r === false) return false;
        return null;
      }

      // numeric comparisons — resolve through substitutions
      const lVal = this.resolveNumericValue(expr.left, subs);
      const rVal = this.resolveNumericValue(expr.right, subs);
      if (lVal === null || rVal === null) return null;

      switch (expr.op) {
        case ">=": return lVal >= rVal;
        case "<=": return lVal <= rVal;
        case ">":  return lVal > rVal;
        case "<":  return lVal < rVal;
        case "==": return lVal === rVal;
        case "!=": return lVal !== rVal;
        default: return null;
      }
    }

    return null;
  }

  // Resolve an expression to a numeric value, substituting parameter names with call arguments
  private resolveNumericValue(expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>): number | null {
    if (expr.kind === "Ident") {
      const sub = subs.get(expr.name);
      if (sub) return this.constNumericValue(sub);
      return null;
    }
    if (expr.kind === "FieldAccess" && expr.field === "len" && expr.object.kind === "Ident") {
      const sub = subs.get(expr.object.name);
      if (sub?.kind === "StringLit") return sub.value.length;
      return null;
    }
    return this.constNumericValue(expr);
  }

  private checkCallSiteContracts(fnDecl: import("./ast").Function, args: import("./ast").Expr[], callSpan?: import("./ast").Span) {
    if (!fnDecl.contracts || fnDecl.contracts.length === 0) return;
    const subs = new Map<string, import("./ast").Expr>();
    for (let i = 0; i < Math.min(fnDecl.params.length, args.length); i++) {
      subs.set(fnDecl.params[i].name, args[i]);
    }
    for (const c of fnDecl.contracts) {
      if (c.kind !== "requires") continue;
      const result = this.tryEvalContractExpr(c.expr, subs);
      if (result === false) {
        const contractSrc = this.contractExprToString(c.expr);
        this.error(`requires clause '${contractSrc}' violated`, callSpan);
      }
    }
  }

  // A `decreases` measure is an integer that must fall toward zero, so it is the one clause
  // that is not a boolean claim.
  private checkContractClause(c: import("./ast").Contract): void {
    const prev = this.contractScope;
    this.contractScope = c.kind;
    const cType = this.checkExpr(c.expr);
    this.contractScope = prev;
    if (cType.tag === "unknown") return;
    if (c.kind === "decreases") {
      if (cType.tag !== "int") {
        this.error(`decreases clause must be an integer measure, got ${this.show(cType)}`, c.span,
          `it is the quantity that must strictly fall on every recursive call or iteration`);
      }
      return;
    }
    if (cType.tag !== "bool") {
      this.error(`${c.kind} clause must be bool, got ${this.show(cType)}`, c.span);
    }
  }

  // Reconstruct a readable string from a contract expression
  private contractExprToString(expr: import("./ast").Expr): string {
    if (expr.kind === "Ident") return expr.name;
    if (expr.kind === "IntLit") return String(expr.value);
    if (expr.kind === "FloatLit") return expr.value % 1 === 0 ? expr.value.toFixed(1) : String(expr.value);
    if (expr.kind === "BoolLit") return String(expr.value);
    if (expr.kind === "FieldAccess") return `${this.contractExprToString(expr.object)}.${expr.field}`;
    if (expr.kind === "UnaryOp") return `${expr.op}${this.contractExprToString(expr.operand)}`;
    if (expr.kind === "BinOp") return `${this.contractExprToString(expr.left)} ${expr.op} ${this.contractExprToString(expr.right)}`;
    if (expr.kind === "CastExpr") return `${this.contractExprToString(expr.operand)} as ${expr.targetType.name}`;
    return "...";
  }

  private checkConstOverflow(lv: bigint, rv: bigint, op: string, ty: TypeKind, span?: Span) {
    if (ty.tag !== "int") return;
    const ops: Record<string, (a: bigint, b: bigint) => bigint> = {
      "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b,
    };
    const fn = ops[op];
    if (!fn) return;
    const result = fn(lv, rv);
    const { bits, signed } = ty;
    const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
    const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
    if (result < min || result > max) {
      this.error(`constant expression '${lv} ${op} ${rv}' overflows ${signed ? "i" : "u"}${bits} (result: ${result}, range ${min}..${max})`, span);
    }
  }

  // A reference nested inside a container outlives the borrow it came from: the
  // container survives the scope that owns the borrowed value, and reading it
  // later is a use-after-free. Struct fields have always been rejected; this is
  // the same rule for `Vec<&T>`, `HashMap<_, &T>`, `[&T; N]` and `Heap<&T>`,
  // which used to slip through and produce garbage at runtime.
  private nestedRef(t: TypeKind, seen = new Set<string>()): boolean {
    switch (t.tag) {
      case "vec": return t.element.tag === "ref" || this.nestedRef(t.element, seen);
      case "array": return t.element.tag === "ref" || this.nestedRef(t.element, seen);
      case "heap": return t.inner.tag === "ref" || this.nestedRef(t.inner, seen);
      case "hashmap":
        return t.key.tag === "ref" || t.value.tag === "ref" || this.nestedRef(t.key, seen) || this.nestedRef(t.value, seen);
      // An enum payload is storage like any other: `Option<&[T]>` let a view outlive the
      // freeze taken for it, which is the same escape `Vec<&T>` had. `seen` guards the
      // recursive enums (a list variant holding its own type) this walk would loop on.
      case "enum": {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        const info = this.enums.get(t.name);
        if (!info) return false;
        for (const v of info.variants.values()) {
          for (const f of v.fields) if (f.tag === "ref" || this.nestedRef(f, seen)) return true;
        }
        return false;
      }
      default: return false;
    }
  }

  // `sp` is where the type was WRITTEN or implied (a `let` annotation, a call whose
  // signature mentions it); a MiloType carries no span of its own, so an instantiation
  // that a generic rejects (`@copyOnly`, `void`) has no other way to point at the user.
  private resolve(ty: MiloType, sp?: Span): TypeKind {
    if (ty.isFn && ty.fnParams && ty.fnRet) {
      const tag = ty.isCFn ? "cfn" as const : "fn" as const;
      const fnTy = { tag, params: ty.fnParams.map(p => this.resolve(p, sp)), ret: this.resolve(ty.fnRet, sp) };
      // `move (T) => R` — carry the ownership through. This is a SECOND place fn types are
      // built (typeFromAst is the other); a declared parameter comes through here, so
      // losing the flag here meant a `move` parameter typed as non-owning: it was not Copy
      // at the call site but the callee never dropped it, so every capture leaked anyway.
      return (ty as { isMoveFn?: boolean }).isMoveFn ? { ...fnTy, owning: true } : fnTy;
    }
    // type alias resolution
    const alias = this.typeAliases.get(ty.name);
    const aliasParams = this.aliasTypeParams.get(ty.name);
    if (alias && aliasParams && !ty.isArray) {
      // A generic alias is a TEMPLATE: substitute the arguments into its body and resolve
      // the result. There is no instantiation to register and no monomorphization to run,
      // because the alias names no type of its own — `Handler<i64>` IS `(i64) => Result<i64, Error>`
      // to everything downstream, which is what makes it free.
      const args = ty.typeArgs ?? [];
      if (args.length !== aliasParams.length) {
        this.error(`type alias '${ty.name}' takes ${aliasParams.length} type argument(s), got ${args.length}`, undefined,
          args.length === 0
            ? `write '${ty.name}<${aliasParams.map(() => "…").join(", ")}>' — a generic alias has no meaning without its arguments`
            : `it declares '${ty.name}<${aliasParams.join(", ")}>'`);
        return { tag: "unknown" };
      }
      if (this.expandingAliases.has(ty.name)) {
        this.error(`type alias '${ty.name}' is cyclic`, undefined,
          `it expands to itself, so there is no type it names — break the cycle, or use a struct or enum, which may refer to itself through 'Heap' or 'Vec'`);
        return { tag: "unknown" };
      }
      const subst = new Map<string, MiloType>();
      aliasParams.forEach((p, i) => subst.set(p, args[i]));
      this.expandingAliases.add(ty.name);
      let inner: TypeKind;
      try {
        inner = this.resolve(substituteAliasType(alias, subst));
      } finally {
        this.expandingAliases.delete(ty.name);
      }
      const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
      if (depth > 0) {
        let result = inner;
        for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
        return result;
      }
      if (ty.isNullableRef) return { tag: "ptr", inner };
      if (ty.isRef) return { tag: "ref", inner, mutable: false };
      if (ty.isRefMut) return { tag: "ref", inner, mutable: true };
      return inner;
    }
    if (alias && !ty.isArray && !ty.typeArgs?.length) {
      if (this.expandingAliases.has(ty.name)) {
        this.error(`type alias '${ty.name}' is cyclic`, undefined,
          `it expands to itself, so there is no type it names — break the cycle, or use a struct or enum, which may refer to itself through 'Heap' or 'Vec'`);
        return { tag: "unknown" };
      }
      // The ptr/ref flags belong to the *use site* (`&Board`), not to the alias:
      // expand the alias body, then re-apply the wrapper the use site asked for.
      this.expandingAliases.add(ty.name);
      let inner: TypeKind;
      try {
        inner = this.resolve(alias);
      } finally {
        this.expandingAliases.delete(ty.name);
      }
      const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
      if (depth > 0) {
        let result = inner;
        for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
        return result;
      }
      if (ty.isNullableRef) return { tag: "ptr", inner };
      if (ty.isRef) return { tag: "ref", inner, mutable: false };
      if (ty.isRefMut) return { tag: "ref", inner, mutable: true };
      return inner;
    }
    const typeArgs = ty.typeArgs ?? [];
    if (typeArgs.length > 0) {
      const resolvedArgs = typeArgs.map(a => this.resolve(a, sp));
      // A user generic bails out: `Promise<void>` would otherwise instantiate Channel,
      // Result and Option with the same void and report the one mistake four times.
      // A builtin container has no such body, so it keeps its resolved type rather than
      // degrading to `<unknown>` and cascading "cannot infer element type" behind it.
      if (this.rejectVoidTypeArgs(ty.name, resolvedArgs)
          && (this.genericStructs.has(ty.name) || this.genericEnums.has(ty.name))) {
        return { tag: "unknown" };
      }
      let result: TypeKind;
      if (ty.name === "Heap") {
        if (resolvedArgs.length !== 1) { this.error(`'Heap' expects 1 type argument, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
        result = { tag: "heap", inner: resolvedArgs[0] };
      } else if (ty.name === "Vec") {
        if (resolvedArgs.length !== 1) { this.error(`'Vec' expects 1 type argument, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
        result = { tag: "vec", element: resolvedArgs[0] };
      } else if (ty.name === "HashMap") {
        if (resolvedArgs.length !== 2) { this.error(`'HashMap' expects 2 type arguments, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
        this.validateHashableKey(resolvedArgs[0]);
        result = { tag: "hashmap", key: resolvedArgs[0], value: resolvedArgs[1] };
      } else {
        const ge = this.genericEnums.get(ty.name);
        if (ge) {
          let args = resolvedArgs;
          if (args.length < ge.typeParams.length && ge.typeParamDefaults) {
            // fill remaining type args from defaults
            args = [...args];
            for (let i = args.length; i < ge.typeParams.length; i++) {
              const def = ge.typeParamDefaults[i];
              if (!def) {
                this.error(`'${ty.name}' requires type argument for '${ge.typeParams[i]}'`);
                return { tag: "unknown" };
              }
              args.push(def);
            }
          } else if (args.length !== ge.typeParams.length) {
            this.error(`'${ty.name}' expects ${ge.typeParams.length} type args, got ${args.length}`);
            return { tag: "unknown" };
          }
          result = { tag: "enum", name: this.monomorphizeEnum(ty.name, args, sp) };
        } else {
          const gs = this.genericStructs.get(ty.name);
          if (gs) {
            if (resolvedArgs.length !== gs.typeParams.length) {
              this.error(`'${ty.name}' expects ${gs.typeParams.length} type args, got ${resolvedArgs.length}`);
              return { tag: "unknown" };
            }
            result = { tag: "struct", name: this.monomorphizeStruct(ty.name, resolvedArgs, sp) };
          } else {
            this.error(`'${ty.name}' is not a generic type`);
            return { tag: "unknown" };
          }
        }
      }
      // `[Vec<i64>; 2]` arrives here because of its type ARGUMENTS, and this branch used
      // to return the element type and drop the array entirely: the annotation resolved to
      // a plain `Vec<i64>`, so `for v in a` yielded an i64 and the reported error was
      // "cannot iterate over type 'i64'" against a program that never wrote one. Wrap here,
      // inside the ref/ptr wrappers, which belong outside the array.
      if (ty.isArray) result = { tag: "array", element: result, size: ty.arraySize };
      if (ty.isRef) return { tag: "ref", inner: result, mutable: false };
      if (ty.isRefMut) return { tag: "ref", inner: result, mutable: true };
      return result;
    }
    // check if name refers to an interface
    if (this.interfaces.has(ty.name)) {
      let result: TypeKind = { tag: "interface", name: ty.name };
      if (ty.isRef) return { tag: "ref", inner: result, mutable: false };
      if (ty.isRefMut) return { tag: "ref", inner: result, mutable: true };
      return result;
    }
    const base = typeFromAst(ty);
    if (base.tag === "struct" && this.enums.has(base.name)) {
      return { tag: "enum", name: base.name };
    }
    // `&Enum` / `*Enum`: typeFromAst tags the named inner as a struct by default;
    // correct it to enum so e.g. a `&Value` param's pointee is a real enum.
    if (base.tag === "ref" && base.inner.tag === "struct" && this.enums.has(base.inner.name)) {
      return { tag: "ref", inner: { tag: "enum", name: base.inner.name }, mutable: base.mutable };
    }
    if (base.tag === "ptr" && base.inner.tag === "struct" && this.enums.has(base.inner.name)) {
      return { tag: "ptr", inner: { tag: "enum", name: base.inner.name } };
    }
    // opaque extern types can only appear behind *T
    const opaqueCheck = base.tag === "struct" ? base.name
      : (base.tag === "ref" && base.inner.tag === "struct") ? base.inner.name
      : (base.tag === "array" && base.element.tag === "struct") ? base.element.name
      : null;
    if (opaqueCheck && this.structs.get(opaqueCheck)?.isOpaque) {
      this.error(`extern type '${opaqueCheck}' can only be used as a pointer (*${opaqueCheck})`);
    }
    return base;
  }

  private mangleTypeName(t: TypeKind): string {
    switch (t.tag) {
      case "cfn": return `cfn${t.params.length}`;
      case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
      case "float": return `f${t.bits}`;
      case "bool": return "bool";
      case "void": return "void";
      case "string": return "string";
      case "struct": return t.name;
      case "enum": return t.name;
      case "ptr": return `ptr_${this.mangleTypeName(t.inner)}`;
      case "heap": return `Heap_${this.mangleTypeName(t.inner)}`;
      case "vec": return `Vec_${this.mangleTypeName(t.element)}`;
      case "hashmap": return `HashMap_${this.mangleTypeName(t.key)}_${this.mangleTypeName(t.value)}`;
      case "array": return `arr_${this.mangleTypeName(t.element)}_${t.size}`;
      case "ref": return `ref_${this.mangleTypeName(t.inner)}`;
      case "fn": return `fn_${t.params.map(p => this.mangleTypeName(p)).join("_")}_ret_${this.mangleTypeName(t.ret)}`;
      case "interface": return `iface_${t.name}`;
      case "unknown": return "unknown";
    }
  }

  private monomorphizeEnum(baseName: string, typeArgs: TypeKind[], sp?: Span): string {
    this.rejectVoidTypeArgs(baseName, typeArgs, sp);
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.enums.has(mangled)) return mangled;

    const generic = must(this.genericEnums, baseName, "generic enums");
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    for (let i = 0; i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      for (const bound of tp.bounds) {
        this._pendingStructBounds.push({ struct: baseName, mangled, param: tp.name, concrete: typeArgs[i], bound });
      }
    }

    const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
    for (const [vName, vInfo] of generic.variants) {
      variants.set(vName, {
        tag: vInfo.tag,
        fields: vInfo.fields.map(f => this.substituteTypeKind(f, typeMap)),
      });
    }
    this.enums.set(mangled, { baseName, typeArgs, variants });

    const decl: import("./ast").EnumDecl = {
      kind: "EnumDecl",
      name: mangled,
      typeParams: [],
      variants: generic.decl.variants.map(v => ({
        name: v.name,
        fields: v.fields.map(f => this.substituteMiloType(f, generic.typeParams, typeArgs)),
      })),
    };
    this.monomorphizedDecls.push(decl);
    return mangled;
  }

  // Rule on every generic-struct bound recorded so far. Callable only once the impl
  // tables are complete — see `_pendingStructBounds`.
  private flushStructBounds() {
    while (this._pendingStructBounds.length > 0 || this._pendingCopyOnly.length > 0) {
      for (const b of this._pendingStructBounds.splice(0)) {
        if (this.typeImplementsTrait(typeName(b.concrete), b.bound)) continue;
        this.error(`type '${this.show(b.concrete)}' does not implement trait '${b.bound}', required by '${b.struct}<${b.param}: ${b.bound}>'`);
        this._boundFailedStructs.add(b.mangled);
      }
      for (const c of this._pendingCopyOnly.splice(0)) {
        if (this.rejectNonCopyTypeArg(c.generic, c.mangled, c.concrete, c.span)) this._boundFailedStructs.add(c.mangled);
      }
    }
  }

  // Which of a generic's type parameters `@copyOnly` constrains: all of them when bare,
  // only the named ones with arguments (`@copyOnly(T)` on `parallelMapWith<T, S>`, whose
  // per-worker state S never crosses the raw pointer and may own a Vec). Empty when the
  // declaration carries no `@copyOnly`.
  private copyOnlyParams(attrs: Attribute[] | undefined, typeParams: string[]): Set<string> {
    const attr = attrs?.find(a => a.name === "copyOnly");
    if (!attr) return new Set();
    return new Set(attr.args.length > 0 ? attr.args : typeParams);
  }

  // `@copyOut`: the routine hands a `T` out of a container by copy, which duplicates a
  // resource (see errorIfResourceIndexRead). Rather than reject the whole instantiation
  // the way `@copyOnly` does, only the copying method goes missing: `Arena<Fd>` keeps
  // `alloc`/`read`/`modifyMut` and loses `get`, and calling `get` names the reason.
  //
  // Decided at instantiation, because a method call resolved in a user body before any
  // deferred flush would already have bound the symbol codegen emits. Drop impls are
  // pre-registered before the first monomorphization for exactly this reason; the
  // by-index rule inside the instantiated body is the fail-closed backstop for a
  // resource this early answer cannot see (a struct declared later that nests one).
  private copyOutUnavailable = new Map<string, { kind: string; via: TypeKind; arg: TypeKind }>();
  private copyOutBlocker(attrs: Attribute[] | undefined, typeArgs: TypeKind[]) {
    if (!attrs?.some(a => a.name === "copyOut")) return null;
    for (const arg of typeArgs) {
      const res = this.resourceKind(arg);
      if (res) return { ...res, arg };
    }
    return null;
  }
  private copyOutMethodUnavailable(m: Function, mangled: string, typeArgs: TypeKind[]): boolean {
    const blocker = this.copyOutBlocker(m.attributes, typeArgs);
    if (!blocker) return false;
    this.copyOutUnavailable.set(`${mangled}.${m.name}`, blocker);
    return true;
  }
  private copyOutReason(what: string, b: { kind: string; via: TypeKind; arg: TypeKind }): string {
    const via = typeEq(b.via, b.arg) ? "" : ` (through '${this.show(b.via)}')`;
    return `${what} copies its element out, and '${this.show(b.arg)}' carries ${b.kind}${via}`;
  }
  private static readonly COPY_OUT_HINT =
    `a copy of a resource is released once per copy; use the borrowing form of this API ` +
    `(a callback taking '&T' or '&mut T'), or clone the element where its own Clone impl runs`;

  // A generic body is only ever checked as an INSTANCE, so `self.base[i]` on a `*T` is
  // seen as `*i64` or `*string` and judged per instantiation; the one instantiation that
  // is unsound is the one no fixture wrote. This scans the TEMPLATE instead: inside a
  // generic fn or a generic struct's method that is not `@copyOnly`, reading an element
  // by value through a raw pointer whose pointee is a type parameter is refused, because
  // nothing at that site proves T is Copy and a bitwise copy of a heap-owning T is a
  // second owner. Narrow on purpose: only `name[i]` / `self.field[i]` where the pointer
  // is DECLARED `*T` (a param, an explicitly typed local, or a field), only as an rvalue
  // that is not itself indexed into further (`p[i].len` borrows), never a write, and
  // never a memcpy/memset/zeroed move, which is how std/sync's Channel<T> stays clean.
  private checkRawTypeParamReads(): void {
    const ptrToParam = (t: MiloType | null | undefined, typeParams: string[]): string | null =>
      t && t.isPtr && (t.ptrDepth ?? 1) === 1 && !t.isArray && !t.isRef && !t.isRefMut
        && !t.isFn && !t.typeArgs?.length && typeParams.includes(t.name) ? t.name : null;

    const scan = (fn: Function, typeParams: string[], selfFields: Map<string, string>, owner: string, constrained: Set<string>) => {
      if (fn.isExtern || !fn.body) return;
      // Only the UNconstrained parameters can be read unsoundly; the rest are Copy.
      typeParams = typeParams.filter(tp => !constrained.has(tp));
      selfFields = new Map([...selfFields].filter(([, tp]) => !constrained.has(tp)));
      const locals = new Map<string, string>();
      for (const p of fn.params) {
        const tp = ptrToParam(declaredType(p), typeParams);
        if (tp) locals.set(p.name, tp);
      }
      const writes = new Set<Expr>();
      const borrowed = new Set<Expr>();
      walkExprs(fn.body, e => {
        if (e.kind === "FieldAccess" || e.kind === "MethodCall") borrowed.add(e.object);
      }, st => {
        if (st.kind === "Assign") writes.add(st.target);
        if ((st.kind === "LetDecl" || st.kind === "VarDecl") && st.type) {
          const tp = ptrToParam(st.type, typeParams);
          if (tp) locals.set(st.name, tp);
        }
      });
      walkExprs(fn.body, e => {
        if (e.kind !== "IndexAccess" || writes.has(e) || borrowed.has(e)) return;
        const o = e.object;
        const tp = o.kind === "Ident" ? locals.get(o.name)
          : o.kind === "FieldAccess" && o.object.kind === "Ident" && o.object.name === "self" ? selfFields.get(o.field)
          : undefined;
        if (!tp) return;
        this.error(`reading '${tp}' by value through a raw pointer copies it bitwise; '${tp}' may own memory`, e.span ?? fn.span,
          `mark '${owner}' @copyOnly so only Copy types can instantiate '${tp}', or clone the element and drop the old one explicitly`);
      });
    };

    for (const [name, g] of this.genericFns) {
      scan(g.decl, g.typeParams, new Map(), name, this.copyOnlyParams(g.decl.attributes, g.typeParams));
    }
    for (const [baseName, impls] of this.genericImpls) {
      const gs = this.genericStructs.get(baseName);
      if (!gs) continue;
      const selfFields = new Map<string, string>();
      for (const f of gs.decl.fields) {
        const tp = ptrToParam(f.type, gs.typeParams);
        if (tp) selfFields.set(f.name, tp);
      }
      const structConstrained = this.copyOnlyParams(gs.decl.attributes, gs.typeParams);
      for (const { impl } of impls) {
        for (const m of impl.methods) {
          const own = m.typeParams.map(t => t.name);
          const constrained = new Set([...structConstrained, ...this.copyOnlyParams(m.attributes, own)]);
          scan(m, [...gs.typeParams, ...own], selfFields, baseName, constrained);
        }
      }
    }
  }

  // The `@copyOnly` verdict for one type argument. Returns whether it was rejected.
  private rejectNonCopyTypeArg(generic: string, mangled: string, concrete: TypeKind, span?: Span): boolean {
    if (concrete.tag === "unknown") return false;
    if (this.isCopyType(concrete)) return false;
    const key = this.mangleTypeName(concrete);
    if (this.copyOnlyReported.has(key)) return true;
    this.copyOnlyReported.add(key);
    const shownArg = this.show(concrete);
    const instance = this.structs.has(mangled) ? this.demangle(mangled) : `${generic}<${shownArg}>`;
    this.error(`'${instance}' is not allowed: '${generic}' is @copyOnly and '${shownArg}' is not a Copy type (${this.whyNotCopy(concrete)})`, span,
      `'${generic}' moves elements through a raw pointer, so a second owner of a '${shownArg}' would free it twice. Use a Copy element type, keep the elements in an Arena and hand out its Copy handles, or index the Vec directly`);
    return true;
  }

  // One clause on why a type is move-tracked, for the `@copyOnly` diagnostic.
  private whyNotCopy(t: TypeKind): string {
    switch (t.tag) {
      case "string": case "vec": case "hashmap": case "heap": return "it owns heap memory";
      case "struct": {
        if (this.dropImpls.has(t.name)) return "it implements Drop";
        const info = this.structs.get(t.name);
        if (info?.noCopy) return "it is @noCopy";
        if (info?.pointerField) return `it holds a raw pointer ('${info.pointerField}') and is not @copy`;
        return "a field of it owns heap memory";
      }
      case "enum": return "a variant of it owns heap memory";
      case "fn": return t.owning ? "it is a move closure" : "it is a closure";
      case "ref": return "it is a reference";
      default: return "it is move-tracked";
    }
  }

  // Bodies of a bound-violating instantiation are skipped: every one of them would
  // re-report the violation as "type 'i64' has no method 'read'" pointing inside the
  // library, burying the single line that names the real cause.
  private fromBoundFailedStruct(fn: Function): boolean {
    const sep = fn.name.indexOf("$");
    return sep > 0 && this._boundFailedStructs.has(fn.name.slice(0, sep));
  }

  // Whether `name` reaches itself through by-value fields (directly or through other
  // by-value structs / fixed arrays), which means it has no finite size. Vec/Heap/
  // pointer/ref indirection breaks the chain, since those are pointer-sized whatever
  // they point at, so only value-struct and fixed-array-of-struct fields keep walking.
  private embedsSelf(name: string, stack: Set<string>): boolean {
    if (stack.has(name)) return true;
    const info = this.structs.get(name);
    if (!info) return false;
    stack.add(name);
    for (const f of info.fields) {
      let t = f.type;
      while (t.tag === "array") t = t.element;
      if (t.tag === "struct" && this.embedsSelf(t.name, stack)) { stack.delete(name); return true; }
    }
    stack.delete(name);
    return false;
  }

  // `Pair_i64_string` back to `Pair<i64, string>`, for a diagnostic about a
  // monomorphized struct or enum: the mangled name is an implementation detail and
  // nobody wrote it, so nobody should have to read it. Every diagnostic formats types
  // through `show`, which threads this into `typeName`; `typeName` alone stays the
  // identity for lookups and mangling.
  private demangle(mangled: string): string {
    const info = this.structs.get(mangled) ?? this.enums.get(mangled);
    if (!info || info.baseName === undefined) return mangled;
    const args = (info.typeArgs ?? []).map(a => this.show(a)).join(", ");
    return args.length === 0 ? info.baseName : `${info.baseName}<${args}>`;
  }

  private show(t: TypeKind): string {
    return typeName(t, n => this.demangle(n));
  }

  private monomorphizeStruct(baseName: string, typeArgs: TypeKind[], sp?: Span): string {
    this.rejectVoidTypeArgs(baseName, typeArgs, sp);
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.structs.has(mangled)) return mangled;

    const generic = must(this.genericStructs, baseName, "generic structs");
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    for (let i = 0; i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      for (const bound of tp.bounds) {
        this._pendingStructBounds.push({ struct: baseName, mangled, param: tp.name, concrete: typeArgs[i], bound });
      }
      if (this.copyOnlyParams(generic.decl.attributes, generic.typeParams).has(tp.name)) {
        this._pendingCopyOnly.push({ generic: baseName, mangled, concrete: typeArgs[i], span: sp });
      }
    }

    // The memo entry goes in BEFORE the field types are resolved, because
    // resolving one can lead straight back to this same instantiation: a struct
    // whose field is `Owner<T>` whose own method returns `Rejected<T>` reaches
    // `Rejected_f64` again while `Rejected_f64` is still being built. With the
    // memo installed only afterwards, that re-entry re-ran the whole body and
    // registered every impl method a second time, and LLVM rejected the program
    // with `invalid redefinition of function`. Fields are filled in below; the
    // re-entrant reader only needs the name to exist, not the layout.
    const entry: StructInfo = {
      fields: [], baseName, typeArgs,
      // Copy-ness is a property of the declaration, so every instantiation of a
      // `@noCopy` generic inherits it — `Handle<Texture>` is no more copyable than
      // the `Handle<T>` it came from.
      ...(generic.decl.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
      ...(generic.decl.attributes?.some(a => a.name === "copy") ? { copy: true } : {}),
    };
    this.structs.set(mangled, entry);
    entry.fields = generic.decl.fields.map(f => ({
      name: f.name,
      type: this.resolve(this.substituteMiloType(f.type, generic.typeParams, typeArgs)),
      ...(f.attributes?.some(a => a.name === "iter") ? { iterDelegate: true } : {}),
    }));
    // Judged on the instance, not the template: `Shard<T> { base: *T }` holds a pointer
    // in every instance, and `Cell<T> { v: T }` holds one exactly when `T` is a pointer.
    if (!entry.copy) {
      const pf = rawPointerField(entry.fields);
      if (pf) entry.pointerField = pf;
    }

    const decl: StructDecl = {
      kind: "StructDecl",
      name: mangled,
      typeParams: [],
      fields: generic.decl.fields.map(f => ({
        name: f.name,
        type: this.substituteMiloType(f.type, generic.typeParams, typeArgs),
      })),
    };
    this.monomorphizedStructDecls.push(decl);

    // instantiate generic impls for this concrete type
    const genericImplTemplates = this.genericImpls.get(baseName);
    if (genericImplTemplates) {
      for (const { impl: gi, program: prog } of genericImplTemplates) {
        const concreteImpl: import("./ast").ImplDecl = {
          kind: "ImplDecl",
          traitName: gi.traitName,
          typeName: mangled,
          typeParams: [],
          methods: gi.methods.filter(m => !this.copyOutMethodUnavailable(m, mangled, typeArgs)).map(m => ({
            ...m,
            // `@copyOut` has been decided for this instance; the concrete impl has no
            // type parameters left for it to constrain, and registerImpl says so.
            ...(m.attributes && { attributes: m.attributes.filter(a => a.name !== "copyOut") }),
            body: this.substituteBody(m.body, generic.typeParams, typeArgs, baseName, mangled),
            params: m.params.map(p => ({
              name: p.name,
              type: this.substituteSelfInMiloType(
                this.substituteMiloType(declaredType(p), generic.typeParams, typeArgs),
                mangled
              ),
            })),
            retType: this.substituteSelfInMiloType(
              this.substituteMiloType(m.retType, generic.typeParams, typeArgs),
              mangled
            ),
          })),
          span: gi.span,
        };
        this.registerImpl(concreteImpl, prog, this._pendingImplFns);
      }
    }

    // Propagate derives from the generic struct to the monomorphized type.
    if (generic.decl.attributes) {
      for (const attr of generic.decl.attributes) {
        if (attr.name !== "derive") continue;
        for (const traitName of attr.args) {
          const impl = this.synthesizeDeriveImpl(decl, traitName);
          if (impl) this.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [], typeAliases: [], interfaces: [], globals: [], deriveTemplates: [] }, this._pendingImplFns);
        }
      }
    }

    return mangled;
  }

  private substituteTypeKind(t: TypeKind, typeMap: Map<string, TypeKind>): TypeKind {
    if (t.tag === "struct" && typeMap.has(t.name)) return must(typeMap, t.name, "type map");
    if (t.tag === "array") return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
    if (t.tag === "ref") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "ptr") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "heap") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "vec") return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
    if (t.tag === "hashmap") return { ...t, key: this.substituteTypeKind(t.key, typeMap), value: this.substituteTypeKind(t.value, typeMap) };
    if (t.tag === "fn") return { ...t, params: t.params.map(p => this.substituteTypeKind(p, typeMap)), ret: this.substituteTypeKind(t.ret, typeMap) };
    return t;
  }

  private typeKindToMiloType(t: TypeKind): MiloType {
    switch (t.tag) {
      case "vec": return { ...simpleType("Vec"), typeArgs: [this.typeKindToMiloType(t.element)] };
      case "heap": return { ...simpleType("Heap"), typeArgs: [this.typeKindToMiloType(t.inner)] };
      case "ref": return { ...simpleType(typeName(t.inner)), isRef: !t.mutable, isRefMut: t.mutable };
      case "ptr": {
        // unwrap nested ptrs so `**u8` round-trips at the right depth, not collapsed
        let depth = 0; let cur: TypeKind = t;
        while (cur.tag === "ptr") { depth++; cur = cur.inner; }
        return { ...simpleType(typeName(cur)), isPtr: true, ptrDepth: depth };
      }
      case "fn": return { ...simpleType(""), isFn: true, fnParams: t.params.map(p => this.typeKindToMiloType(p)), fnRet: this.typeKindToMiloType(t.ret) };
      default: return simpleType(typeName(t));
    }
  }

  // Null in, null out: only a closure param may omit its type annotation, and closures
  // aren't monomorphized — but Param.type is nullable for everyone, so the substitution
  // paths have to carry that through rather than assert it away.
  private substituteMiloType(ty: MiloType, typeParams: string[], typeArgs: TypeKind[]): MiloType;
  private substituteMiloType(ty: MiloType | null, typeParams: string[], typeArgs: TypeKind[]): MiloType | null;
  private substituteMiloType(ty: MiloType | null, typeParams: string[], typeArgs: TypeKind[]): MiloType | null {
    if (ty === null) return null;
    const idx = typeParams.indexOf(ty.name);
    if (idx !== -1) {
      const sub = this.typeKindToMiloType(typeArgs[idx]);
      // Preserve reference/pointer/array wrappers from the original: `&T` must become
      // `&P`, not value `P`. Dropping isRef here collapsed the param to by-value,
      // so a generic fn taking `&T` passed a struct where a ptr was expected. `isArray`
      // is the same story one wrapper out: `&[T]` became `&P`, which typed a slice
      // parameter as a single element and made a generic over slices unwritable.
      if (ty.isRef || ty.isRefMut || ty.isPtr || ty.isArray) {
        return {
          ...sub,
          isRef: ty.isRef, isRefMut: ty.isRefMut, isPtr: ty.isPtr, ptrDepth: ty.ptrDepth,
          isArray: ty.isArray, arraySize: ty.arraySize,
        };
      }
      return sub;
    }
    if (ty.isFn && ty.fnParams && ty.fnRet) {
      return {
        ...ty,
        fnParams: ty.fnParams.map(p => this.substituteMiloType(p, typeParams, typeArgs)),
        fnRet: this.substituteMiloType(ty.fnRet, typeParams, typeArgs),
      };
    }
    if (ty.typeArgs) {
      return { ...ty, typeArgs: ty.typeArgs.map(a => this.substituteMiloType(a, typeParams, typeArgs)) };
    }
    return ty;
  }

  private monomorphizeFn(baseName: string, typeArgs: TypeKind[], sp?: Span): string {
    this.rejectVoidTypeArgs(baseName, typeArgs, sp);
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.functions.has(mangled)) return mangled;

    if (this.monoDepth >= TypeChecker.MAX_MONO_DEPTH) {
      if (!this.monoDepthErrored) {
        this.monoDepthErrored = true;
        this.error(`generic instantiation exceeded depth ${TypeChecker.MAX_MONO_DEPTH} while monomorphizing '${baseName}' — likely an unbounded recursive generic that instantiates itself on an ever-growing type`);
      }
      // register a stub sig so callers don't dereference undefined, then stop recursing
      this.functions.set(mangled, { params: [], ret: { tag: "unknown" }, variadic: false });
      return mangled;
    }
    this.monoDepth++;
    try {
    const generic = must(this.genericFns, baseName, "generic fns");
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    // check trait bounds
    for (let i = 0; i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      const concreteType = typeArgs[i];
      for (const bound of tp.bounds) {
        if (!this.typeImplementsTrait(typeName(concreteType), bound)) {
          this.error(`type '${this.show(concreteType)}' does not implement trait '${bound}'`);
        }
      }
      if (this.copyOnlyParams(generic.decl.attributes, generic.typeParams).has(tp.name)) {
        this.rejectNonCopyTypeArg(baseName, mangled, concreteType, sp);
      }
    }

    // Build concrete param types — substitute type params first, then resolve
    const params = generic.decl.params.map(p => ({
      type: this.resolve(this.substituteMiloType(declaredType(p), generic.typeParams, typeArgs), sp),
      name: p.name,
    }));
    const ret = this.resolve(this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs), sp);

    // Register the concrete sig so recursive calls and the rest of checking works
    this.functions.set(mangled, { params, ret, variadic: false });

    // `@copyOut` with a resource argument: the call is the error, at the caller's span.
    // The signature above stays registered so the call types through without a cascade;
    // the body is never checked, because its by-index read would only repeat this at a
    // line inside the generic's own file.
    const blocker = this.copyOutBlocker(generic.decl.attributes, typeArgs);
    if (blocker) {
      this.error(`'${baseName}<${typeArgs.map(a => this.show(a)).join(", ")}>' is not allowed: ${this.copyOutReason(`'${baseName}'`, blocker)}`, sp,
        TypeChecker.COPY_OUT_HINT);
      return mangled;
    }

    // Create concrete AST node for codegen
    const concreteDecl: Function = {
      kind: "Function",
      name: mangled,
      sourceName: baseName,
      typeParams: [],
      params: generic.decl.params.map(p => ({
        name: p.name,
        type: this.substituteMiloType(declaredType(p), generic.typeParams, typeArgs),
      })),
      retType: this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs),
      contracts: generic.decl.contracts ?? [],
      body: this.substituteBody(generic.decl.body, generic.typeParams, typeArgs),
      isExtern: false,
      isVariadic: false,
      // Attributes are behavioral (`@wrapping` changes arithmetic, `@pure` is checked
      // per-instance), so an instance that dropped them would silently differ from the
      // generic that declared them.
      ...(generic.decl.attributes && { attributes: generic.decl.attributes }),
      ...(generic.decl.fromWrappingModule && { fromWrappingModule: true }),
      // The instance belongs to the file that DEFINED the generic, not the one that
      // happened to instantiate it — its code is the generic's body. Unlike the impl-method
      // paths below, this decl is built field by field rather than spread from the generic,
      // so the origin has to be carried explicitly or the instance arrives with none.
      ...(generic.decl.sourceFile && { sourceFile: generic.decl.sourceFile }),
    };
    this.monomorphizedFns.push(concreteDecl);

    // Type-check the monomorphized instance
    this.checkFunction(concreteDecl);

    return mangled;
    } finally { this.monoDepth--; }
  }

  // Instantiate a method that carries its own type parameters, for one concrete argument
  // list. Mirrors `monomorphizeFn`: substitute, register the concrete signature so the body
  // and any recursive call can be checked, then check it. The mangled name is what codegen
  // emits, so two instantiations of `map<R>` are two functions, exactly as two
  // instantiations of a generic free fn are.
  private monomorphizeMethod(key: string, typeArgs: TypeKind[], sp?: Span): string | null {
    this.rejectVoidTypeArgs(key.replace("$", "."), typeArgs, sp);
    const tpl = this.genericMethods.get(key);
    if (!tpl) return null;
    const names = (tpl.decl.typeParams ?? []).map(t => t.name);
    const mangled = `${key}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.functions.has(mangled)) return mangled;

    if (this.monoDepth >= TypeChecker.MAX_MONO_DEPTH) {
      if (!this.monoDepthErrored) {
        this.monoDepthErrored = true;
        this.error(`generic instantiation exceeded depth ${TypeChecker.MAX_MONO_DEPTH} while monomorphizing '${key}'`);
      }
      this.functions.set(mangled, { params: [], ret: { tag: "unknown" }, variadic: false });
      return mangled;
    }
    this.monoDepth++;
    try {
      for (let i = 0; i < (tpl.decl.typeParams ?? []).length; i++) {
        for (const bound of tpl.decl.typeParams![i]!.bounds) {
          if (!this.typeImplementsTrait(typeName(typeArgs[i]!), bound)) {
            this.error(`type '${this.show(typeArgs[i]!)}' does not implement trait '${bound}'`);
          }
        }
      }
      const concrete: Function = {
        ...tpl.decl,
        name: mangled,
        typeParams: [],
        params: tpl.decl.params.map(p => ({
          name: p.name,
          type: this.substituteMiloType(declaredType(p), names, typeArgs),
        })),
        retType: this.substituteMiloType(tpl.decl.retType, names, typeArgs),
        body: this.substituteBody(tpl.decl.body, names, typeArgs),
      };
      const params = concrete.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
      const ret = this.resolve(concrete.retType);
      this.functions.set(mangled, { params, ret, variadic: false });
      this.monomorphizedFns.push(concrete);
      this.checkFunction(concrete);
      return mangled;
    } finally { this.monoDepth--; }
  }

  // Work out a generic method's own type arguments from the call. Each parameter's
  // declared type is unified structurally against the argument's actual type — the same
  // `inferTypeParamsFromHint` a generic free-function call uses — and the return hint
  // supplies any parameter no argument mentions.
  private inferMethodTypeArgs(key: string, expr: Extract<Expr, { kind: "MethodCall" }>): TypeKind[] | null {
    const tpl = must(this.genericMethods, key, "generic methods");
    const names = (tpl.decl.typeParams ?? []).map(t => t.name);
    const typeMap = new Map<string, TypeKind>();
    // +1 on the declared side: the template still carries `self` as its first parameter.
    for (let i = 0; i < expr.args.length; i++) {
      const declared = tpl.decl.params[i + 1];
      if (!declared) break;
      const argType = this.checkExpr(expr.args[i]!);
      if (argType.tag === "unknown") return null;
      this.inferTypeParamsFromHint(declaredType(declared), argType, names, typeMap);
    }
    if (this.returnHint) this.inferTypeParamsFromHint(tpl.decl.retType, this.returnHint, names, typeMap);
    if (names.some(n => !typeMap.has(n))) return null;
    return names.map(n => must(typeMap, n, "method type map"));
  }

  private substituteBody(stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[], baseName?: string, mangledName?: string): Stmt[] {
    // Deep clone body with type substitution in all MiloType positions.
    // MiloType objects have `name` but no `kind` (unlike AST nodes).
    // JSON can't round-trip bigint (IntLit.value), so tag it on the way out and
    // rebuild it on the way in.
    return JSON.parse(
      JSON.stringify(stmts, (_k, v) => typeof v === "bigint" ? { __bigint: v.toString() } : v),
      (_key, value) => {
      if (value && typeof value === "object" && "__bigint" in value) return BigInt(value.__bigint);
      if (value && typeof value === "object" && "name" in value && !("kind" in value) && typeof value.name === "string") {
        const idx = typeParams.indexOf(value.name);
        if (idx !== -1) {
          const replaced = this.typeKindToMiloType(typeArgs[idx]);
          return { ...value, ...replaced };
        }
      }
      // rewrite struct literal names: Channel { ... } → Channel_i64 { ... }
      if (baseName && mangledName && value && typeof value === "object" && value.kind === "StructLit" && value.name === baseName) {
        return { ...value, name: mangledName };
      }
      return value;
    });
  }

  private pushScope() { this.scopes.push(new Map()); }
  private popScope() {
    const scope = this.scopes.pop();
    if (scope) {
      for (const [, vi] of scope) {
        if (vi.freezes) for (const src of vi.freezes) { this.unfreeze(src); this.releasePointerBorrows(src, vi); }
      }
    }
  }

  private snapshotMoveState(): Map<VarInfo, MoveSnapshot> {
    const snap = new Map<VarInfo, MoveSnapshot>();
    for (const scope of this.scopes) {
      for (const [, info] of scope) snap.set(info, { moved: info.moved, places: [...info.movedPlaces ?? []] });
    }
    return snap;
  }

  private restoreMoveState(snap: Map<VarInfo, MoveSnapshot>) {
    for (const [info, s] of snap) {
      info.moved = s.moved;
      // Rebuilt rather than reused: the snapshot is taken once and restored to at each
      // arm, so handing back the same Set would let one arm's moves reach the next.
      info.movedPlaces = s.places.length > 0 ? new Set(s.places) : undefined;
    }
  }

  // Union a branch's end state into the current one: a value moved on any path that
  // falls through is unusable after, whichever path actually ran.
  private mergeMoveState(snap: Map<VarInfo, MoveSnapshot>) {
    for (const [info, s] of snap) {
      if (s.moved) info.moved = true;
      for (const p of s.places) this.markPlaceMoved(info, p);
    }
  }

  // After a loop body: a move inside it would run a second time on the next iteration,
  // so it is an error unless the only path that moved also left the loop. Applies one
  // level down too — a field moved out in the body is just as gone on iteration two.
  private checkLoopMoves(pre: Map<VarInfo, MoveSnapshot>, returnMoves: Set<VarInfo>, sp: Span | undefined) {
    for (const scope of this.scopes) {
      for (const [name, info] of scope) {
        const before = pre.get(info);
        if (!before) continue;
        if (!before.moved && info.moved) {
          if (returnMoves.has(info)) info.moved = false;
          else this.error(`cannot move '${name}' out of a loop`, sp);
        }
        for (const p of [...info.movedPlaces ?? []]) {
          if (before.places.includes(p)) continue;
          if (returnMoves.has(info)) info.movedPlaces!.delete(p);
          else this.error(`cannot move '${name}${p}' out of a loop`, sp);
        }
      }
    }
  }

  // Index of the innermost scope belonging to the function currently being
  // checked. Shadowing is judged relative to this, not to the whole stack.
  private fnScopeFloor = 0;
  // True while `tryMove` runs for a move that hands the source to an owner the pointer's
  // holders can still trust: `forget(v)` and `let w = v`. See `tryMoveLeaf`.
  private pointerMoveKeepsHolders = false;

  // `span` is the binding site to point diagnostics at; VarInfo carries one for every
  // binding form now (params, pattern bindings, `let`/`var`, for-in), so `span` here is
  // just an override for callers that want to point somewhere else.
  private declare(name: string, info: VarInfo, span?: Span) {
    const at = span ?? info.span;
    const scope = this.scopes[this.scopes.length - 1];
    // `_` is a discard, not a name: `let _ = f()` twice in one scope is the
    // conventional way to ignore two results, so each one rebinds rather than
    // colliding. Everything else still gets the shadowing error.
    if (name !== "_" && scope.has(name)) {
      const prior = scope.get(name);
      const hint = prior?.span ? `'${name}' was first declared at line ${prior.span.line}` : undefined;
      this.error(`variable '${name}' already declared in this scope`, at, hint);
      return;
    }
    // Shadowing an ENCLOSING binding is rejected too, not just a same-scope
    // redeclaration. Rust allows it; Milo does not, because the reader of
    // `for row in nums` a screen below `let row = 5` has no way to tell which
    // `row` a later line means, and codegen leaked the inner binding past its
    // scope for exactly as long as nothing tested it.
    // Scan only down to the current function's own scope: monomorphization
    // re-enters checkFunction mid-expression, so the CALLER's locals are still
    // on the stack while a generic callee's params are declared. Without the
    // floor, `std/arena`'s `h`/`val` params collided with every local named
    // `h` at the call site.
    // `_name` is the established "I am not reading this" marker (the unused-variable
    // lint keys off it), and the readability argument for banning shadowing —
    // which binding does a later line mean? — does not apply to a name nothing
    // reads. Two match arms both binding `_e` stay legal.
    if (name !== "_" && !name.startsWith("_")) {
      for (let i = this.scopes.length - 2; i >= this.fnScopeFloor; i--) {
        const outer = this.scopes[i].get(name);
        if (outer) {
          const hint = outer.span ? `outer '${name}' is declared at line ${outer.span.line}` : undefined;
          this.error(`'${name}' shadows an outer binding — pick a different name`, at, hint);
          break;
        }
      }
    }
    scope.set(name, info);
  }

  // Freeze `info` for a borrow of `place`. The path is recorded so a later mutation of a
  // provably different field isn't rejected; pass null when the borrowed place is unknown.
  private freeze(info: VarInfo, place: Expr | null, kind: BorrowKind = "view", holder: PointerHolder | null = null) {
    info.borrowed = true;
    (info.borrowedPaths ??= []).push(place ? this.borrowPrefix(place) : null);
    (info.borrowKinds ??= []).push(kind);
    (info.borrowHolders ??= []).push(holder);
  }

  // The exact field prefix of a borrowed place, stopping at the first step that is not a
  // field. An index makes it imprecise about WHICH element, so everything below the index
  // conflicts — but the path ABOVE it is still exact, and that is what keeps a borrow of
  // `self.items[i].ids` from freezing `self.log` as well. `accessPath` answers `null`
  // (conflicts with everything) for the same expression, which is sound but so blunt it
  // rejects the disjoint sibling; see tests/fixtures/borrowIndexFieldPrecision.milo.
  // A place with no single named root stays `null` — unknown must keep meaning "any".
  private borrowPrefix(place: Expr): string[] | null {
    const p = this.soloPath(place);
    if (!p) return null;
    const fields: string[] = [];
    for (const s of p.steps) {
      if (s.tag !== "field") break;
      fields.push(s.name);
    }
    return fields;
  }

  // Release the view/iteration/capture borrows of `info`. Every caller is the code that
  // took one of those and knows it is over (a loop ended, a statement's temporaries
  // died). A pointer borrow is owned by a BINDING and outlives all of them, so it is
  // kept here and released only through `releasePointerBorrows` by its holder; otherwise
  // `let p = v.ptr(); for x in v {}; v.push(0)` would drop `p`'s borrow with the loop's.
  private unfreeze(info: VarInfo) {
    this.retainBorrows(info, (_, i) => info.borrowKinds?.[i] === "pointer");
  }

  private releasePointerBorrows(info: VarInfo, holder: VarInfo) {
    this.retainBorrows(info, (h) => !(h && h.info === holder));
  }

  private retainBorrows(info: VarInfo, keep: (holder: PointerHolder | null, i: number) => boolean) {
    const holders = info.borrowHolders ?? [];
    const idx: number[] = [];
    for (let i = 0; i < (info.borrowedPaths?.length ?? 0); i++) if (keep(holders[i] ?? null, i)) idx.push(i);
    if (idx.length === 0) {
      info.borrowed = false;
      info.borrowedPaths = undefined;
      info.borrowKinds = undefined;
      info.borrowHolders = undefined;
      return;
    }
    info.borrowedPaths = idx.map(i => info.borrowedPaths![i]);
    info.borrowKinds = idx.map(i => info.borrowKinds![i]);
    info.borrowHolders = idx.map(i => holders[i] ?? null);
  }

  // The pointer borrow of `info` that a mutation of `target` would invalidate, if any.
  // Same collision test as `frozenAgainst`, restricted to the `pointer` kind, so a
  // mutation site can say WHICH binding still points into the buffer.
  private pointerBorrowAgainst(info: VarInfo, target: Expr | null): PointerHolder | null {
    if (!info.borrowed) return null;
    const holders = info.borrowHolders;
    if (!holders) return null;
    const paths = info.borrowedPaths;
    const mut = target ? this.accessPath(target) : null;
    const mutFields = mut ? mut.fields : null;
    for (let i = 0; i < holders.length; i++) {
      const h = holders[i];
      if (h && this.borrowCollides(paths?.[i], mutFields)) return h;
    }
    return null;
  }

  // Whether a borrow of field prefix `p` and a mutation of field prefix `mutFields` can
  // alias: two chains off one root diverge only at a named field, and an unknown path on
  // either side (an index or deref step, or a place with no single root) is a collision.
  private borrowCollides(p: string[] | null | undefined, mutFields: string[] | null): boolean {
    if (p === null || p === undefined || mutFields === null) return true;
    const n = Math.min(p.length, mutFields.length);
    for (let j = 0; j < n; j++) if (p[j] !== mutFields[j]) return false;
    return true;
  }

  // Whether every live borrow of `info` is a pointer borrow. A move of such a source is
  // allowed (see `tryMoveLeaf`), where any other borrow kind forbids it.
  private onlyPointerBorrows(info: VarInfo): boolean {
    const kinds = info.borrowKinds;
    return !!info.borrowed && !!kinds && kinds.length > 0 && kinds.every(k => k === "pointer");
  }

  // The `*T`-producing calls whose result is an element view of the receiver, reached
  // through the casts and struct literals a binding's initializer may wrap them in.
  // `let base = s.cstr() as i64` still points into `s`; `let c = Cfg { buf: v.ptr() }`
  // holds the pointer for as long as `c` does, and so does `let ps: Vec<*u8> = [v.ptr()]`
  // or `Some(v.ptr())`. Anything else (a call result, an arithmetic value, a bare pointer
  // variable) carries no provenance this can see.
  private pointerViewsIn(e: Expr, out: { source: Expr; call: string; line: number }[] = []): { source: Expr; call: string; line: number }[] {
    switch (e.kind) {
      case "CastExpr":
        return this.pointerViewsIn(e.operand, out);
      case "StructLit":
        for (const f of e.fields) this.pointerViewsIn(f.value, out);
        return out;
      case "ArrayLit":
        for (const el of e.elements) this.pointerViewsIn(el, out);
        return out;
      case "EnumLit":
        for (const a of e.args) this.pointerViewsIn(a, out);
        return out;
      case "MethodCall": {
        if (e.args.length !== 0) return out;
        const t = this.exprTypes.get(e);
        if (!t || t.tag !== "ptr") return out;
        const recv = this.exprTypes.get(e.object);
        const bare = recv?.tag === "ref" ? recv.inner : recv;
        // A user `ptr` on T wins over the `Heap<T>` give leg (heapPtrUserMethodWins.milo);
        // `heapMethodReceivers` is the record of that dispatch.
        const isView = (e.method === "ptr" && (bare?.tag === "vec" || (bare?.tag === "heap" && !this.heapMethodReceivers.has(e))))
          || (e.method === "cstr" && bare?.tag === "string")
          // `CStr.ptr()` (std/cstr.milo) returns its own backing pointer; same hazard.
          || (e.method === "ptr" && bare?.tag === "struct" && bare.name === "CStr");
        if (isView) out.push({ source: e.object, call: `${this.describeExpr(e.object)}.${e.method}()`, line: e.span?.line ?? 0 });
        return out;
      }
      default:
        return out;
    }
  }

  // Bind the pointer views in `value` to the binding `name`: each source is frozen with
  // a `pointer` borrow until `name`'s scope pops (the same lexical release a `&[T]`
  // binding gets through `freezes`). Only a BINDING creates the borrow: an inline
  // `strlen(v.ptr())` has nothing that could outlive the statement, so it stays legal.
  private bindPointerViews(name: string, holderInfo: VarInfo, value: Expr): void {
    for (const pv of this.pointerViewsIn(value)) {
      const ap = this.accessPath(pv.source);
      if (!ap) continue;
      const src = this.lookup(ap.root);
      if (!src || src === holderInfo) continue;
      this.freeze(src, pv.source, "pointer", { name, info: holderInfo, root: ap.root, call: pv.call, line: pv.line });
      (holderInfo.freezes ??= []).push(src);
    }
  }

  // `ps.push(v.ptr())` / `m.insert(k, v.ptr())`: the container now holds the pointer, so
  // it is the holder and `v` stays frozen for as long as `ps` lives. Without this the
  // pointer escaped through an inline argument with no binding of `*T` anywhere in the
  // program text, and `v.push(..); strlen(ps[0])` read a freed buffer (h4-ptr-in-vec).
  private holdPointerArgsIn(container: Expr, args: Expr[]): void {
    const ap = this.accessPath(container);
    const info = ap ? this.lookup(ap.root) : null;
    if (!ap || !info) return;
    for (const a of args) this.bindPointerViews(ap.root, info, a);
  }

  // The scope index a binding lives in, or -1 when it is not in scope (a global is 0).
  private scopeIndexOf(info: VarInfo): number {
    for (let i = this.scopes.length - 1; i >= 0; i--) for (const [, vi] of this.scopes[i]) if (vi === info) return i;
    return -1;
  }

  // Storage this frame owns and frees on exit: a local or by-value param. A `&T` param
  // and a global outlive the call, so a pointer into them is the caller's business.
  private frameOwned(info: VarInfo): boolean {
    return info.type.tag !== "ref" && this.scopeIndexOf(info) >= this.fnScopeFloor;
  }

  // `p = v.ptr()` where `v` was declared in an inner block: `v` is freed when that
  // block ends and `p` is still in scope. The `let` form cannot hit this (the binding is
  // never older than its initializer's sources), so only assignment checks it.
  private errorIfPointerOutlivesSource(name: string, holder: VarInfo, value: Expr, sp?: Span): void {
    const holderDepth = this.scopeIndexOf(holder);
    for (const pv of this.pointerViewsIn(value)) {
      const ap = this.accessPath(pv.source);
      const src = ap ? this.lookup(ap.root) : null;
      if (!src || src.type.tag === "ref") continue;
      if (this.scopeIndexOf(src) > holderDepth) {
        this.error(`'${ap!.root}' goes out of scope before '${name}', which would still point into its buffer (from '${pv.call}' on line ${pv.line})`, sp,
          `declare '${ap!.root}' in the same block as '${name}' or an enclosing one`);
        return;
      }
    }
  }

  // `return v.ptr()` (or a struct carrying it, or a binding still holding it) where `v`
  // dies with this frame hands the caller a pointer into freed memory. A `&T` param, a
  // global, or a source given away with `forget(v)` is fine: the buffer outlives the
  // call. (Any other move of the source already ended the holder, and the `return p`
  // is rejected as a read of it.) The same rule `errorIfRefReturn` states for `&T`.
  private errorIfReturnedPointerDangles(value: Expr, sp?: Span): void {
    for (const pv of this.pointerViewsIn(value)) {
      const ap = this.accessPath(pv.source);
      const src = ap ? this.lookup(ap.root) : null;
      if (src && this.frameOwned(src)) {
        this.error(`cannot return '${pv.call}': '${ap!.root}' is freed when this function returns, so the pointer would dangle`, sp,
          `return the ${typeName(src.type)} itself, or 'forget' it first if the caller takes ownership of the buffer`);
        return;
      }
    }
    if (value.kind === "Ident") {
      const holder = this.lookup(value.name);
      for (const src of holder?.freezes ?? []) {
        const ph = src.borrowHolders?.find(h => h?.info === holder);
        if (ph && src.borrowed && this.frameOwned(src)) {
          this.error(`cannot return '${value.name}': '${ph.root}' is freed when this function returns, so the pointer would dangle (from '${ph.call}' on line ${ph.line})`, sp,
            `return the buffer itself, or 'forget' it first if the caller takes ownership of it`);
          return;
        }
      }
    }
  }

  private pointerHint(h: PointerHolder): string {
    return `take the pointer after the last mutation, or pass '${h.call}' inline to the call`;
  }

  // A move keeps the heap buffer where it is, so a pointer borrow of the source is not
  // invalidated by `let w = v`, but its obligation now belongs to `w`. Snapshot the
  // pointer borrows a whole-variable initializer carries BEFORE `tryMove` releases them
  // from the source; `carryPointerBorrows` re-attaches them to the new binding.
  private pointerBorrowsCarriedBy(value: Expr): { from: VarInfo; paths: (string[] | null)[]; holders: PointerHolder[] } | null {
    if (value.kind !== "Ident") return null;
    const info = this.lookup(value.name);
    if (!info || !this.onlyPointerBorrows(info) || !info.borrowHolders || !info.borrowedPaths) return null;
    const holders: PointerHolder[] = [];
    const paths: (string[] | null)[] = [];
    info.borrowHolders.forEach((h, i) => { if (h) { holders.push(h); paths.push(info.borrowedPaths![i]); } });
    return holders.length > 0 ? { from: info, paths, holders } : null;
  }

  private carryPointerBorrows(carried: { from: VarInfo; paths: (string[] | null)[]; holders: PointerHolder[] }, toName: string): void {
    const to = this.lookup(toName);
    // Only a binding that actually took ownership carries the borrow: a Copy source is
    // still the owner, `tryMoveLeaf` left its borrows in place, and there is nothing to carry.
    if (!to || !carried.from.moved) return;
    carried.holders.forEach((h, i) => {
      to.borrowed = true;
      (to.borrowedPaths ??= []).push(carried.paths[i]);
      (to.borrowKinds ??= []).push("pointer");
      (to.borrowHolders ??= []).push(h);
      (h.info.freezes ??= []).push(to);
    });
  }

  // Whether a mutation of `target` collides with a live borrow of `info`. Two chains off
  // one root can alias only when neither diverges from the other at a named field; an
  // unknown path on either side (an index or deref step) is treated as a collision.
  // Is any live borrow of `info` that collides with `target` an ITERATION borrow?
  // Only iteration cares about an in-place element write, so this is what lets the
  // index exemption below stay true for slice views while closing it for loops.
  private frozenByIteration(info: VarInfo, target: Expr | null): boolean {
    if (!this.frozenAgainst(info, target)) return false;
    const kinds = info.borrowKinds;
    if (!kinds || kinds.length === 0) return false;
    const paths = info.borrowedPaths;
    const mut = target ? this.accessPath(target) : null;
    const mutFields = mut ? mut.fields : null;
    return kinds.some((k, i) => k === "iteration" && this.borrowCollides(paths?.[i], mutFields));
  }

  private frozenAgainst(info: VarInfo, target: Expr | null): boolean {
    if (!info.borrowed) return false;
    const paths = info.borrowedPaths;
    if (!paths || paths.length === 0) return true;
    const mut = target ? this.accessPath(target) : null;
    const mutFields = mut ? mut.fields : null;
    return paths.some(p => this.borrowCollides(p, mutFields));
  }

  private lookup(name: string): VarInfo | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const info = this.scopes[i].get(name);
      if (info) {
        if (this.closureScopeDepth !== null && i < this.closureScopeDepth && this.currentClosureCaptures) {
          // globals are accessible directly in closures — don't capture them
          if (!this._globalTypes.has(name) && !this.currentClosureCaptures.has(name)) {
            this.currentClosureCaptures.set(name, { name, type: info.type, mutable: info.mutable });
          }
        }
        return info;
      }
    }
    return null;
  }

  check(program: Program): CheckResult {
    // Outermost `fatal()` boundary. Everything below has a finer one, so reaching
    // here means a fatal fired in a pass that has no per-item recovery (a
    // registration sweep, a whole-program lint). The diagnostic is already
    // recorded, so the caller still gets a real error instead of a stack trace —
    // which matters most in the LSP, where the checker runs on half-typed code
    // and an escaped throw means the file shows no diagnostics at all.
    try {
      this.checkProgram(program);
      this.reportStrandedCFnReads();
    } catch (e) {
      if (!(e instanceof CheckAbort)) throw e;
    }
    return {
      diagnostics: this.diagnostics,
      exprTypes: this.exprTypes,
      patternBindingTypes: this.patternBindingTypes,
      nullRefUnwraps: this.nullRefUnwraps,
      autoBorrowed: this.autoBorrowed,
      matchSubjectRef: this.matchSubjectRef,
      rewrittenCalls: this.rewrittenCalls,
      rewrittenEnums: this.rewrittenEnums,
      staticCalls: this.staticCalls,
      rewrittenStructLits: this.rewrittenStructLits,
      movedExprs: this.movedExprs,
      borrowedExprs: this.borrowedExprs,
      autoWrappedOption: this.autoWrappedOption,
      arrayToVecCoercions: this.arrayToVecCoercions,
      functions: this.functions,
      structs: this.structs,
      enums: this.enums,
      dropImpls: this.dropImpls,
      monomorphizedFns: this.monomorphizedFns,
      monomorphizedEnums: this.monomorphizedDecls,
      monomorphizedStructs: this.monomorphizedStructDecls,
      closureCaptures: this.closureCaptures,
      closureCalls: this.closureCalls,
      cfnCalls: this.cfnCalls,
      resolvedMethods: this.resolvedMethods,
      heapMethodReceivers: this.heapMethodReceivers,
      resolvedOperators: this.resolvedOperators,
      fnFieldCalls: this.fnFieldCalls,
      cfnFieldCalls: this.cfnFieldCalls,
      propagateConversions: this.propagateConversions,
      rangeCheckedExprs: this.rangeCheckedExprs,
      sizeOfTypes: this.sizeOfTypes,
      cSigs: this.cSigs,
      cValues: this.cValues,
      offsetOfFields: this.offsetOfFields,
      interfaces: this.interfaces,
      interfaceCoercions: this.interfaceCoercions,
      interfaceMethodCalls: this.interfaceMethodCalls,
      autoJsonStringify: this.autoJsonStringify,
      arraySliceArgs: this.arraySliceArgs,
      autoJsonToJson: this.autoJsonToJson,
      anonStructs: this.anonStructs,
      globalTypes: this._globalTypes,
      nonConstGlobals: this._nonConstGlobals,
      iteratorForIns: this.iteratorForIns,
      stringViewForIns: this.stringViewForIns,
      iterDelegates: this.iterDelegates,
    };
  }

  private checkProgram(program: Program): void {
    this._userFnNames = program.userFnNames;
    this.entryFile = program.entryFile;
    for (const u of program.unusedImports ?? []) {
      this.warn("unused-import",
        `'${u.name}' is imported from '${u.path}' but never used`,
        u.span,
        `remove it from the import list — unless the import exists to force '${u.path}' to link, which this lint cannot see`);
    }
    for (const s of program.shadowedStdlib ?? []) {
      this.warn("shadows-stdlib-override",
        `'fn ${s.name}' shadows a standard-library function of the same name and signature`,
        s.span,
        `the standard library defines '${s.name}' in '${s.stdlibFile}'. The signatures match, so this compiles — but Milo's flat namespace makes this definition win everywhere, including the library's own internal calls to '${s.name}', which now run this body. Rename it, or pass --allow=shadows-stdlib-override if the override is deliberate`);
    }
    this._userImplKeys = program.userImplKeys;
    this._packageNames = program.packageNames;
    // register built-in functions
    const ptrU8: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
    const i32t: TypeKind = { tag: "int", bits: 32, signed: true };
    // print/format accept any number of Display-formattable args (handled in codegen).
    // No required param — variadic-from-zero. Type-driven formatting per arg.
    this.functions.set("print", { params: [], ret: { tag: "void" }, variadic: true });
    this.functions.set("eprint", { params: [], ret: { tag: "void" }, variadic: true });
    this.functions.set("format", { params: [], ret: { tag: "string" }, variadic: true });
    this.functions.set("flush", { params: [], ret: { tag: "void" }, variadic: false });
    this.functions.set("exit", { params: [{ type: i32t, name: "code" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_miloArgCount", { params: [], ret: { tag: "int", bits: 64, signed: true }, variadic: false });
    this.functions.set("_miloArgAt", { params: [{ type: { tag: "int", bits: 64, signed: true }, name: "index" }], ret: { tag: "string" }, variadic: false });
    this.functions.set("_cstrToString", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "string" }, variadic: false });
    // Same copy, but with an explicit length instead of strlen: NUL-safe, so it can
    // carry arbitrary file bytes. `readAll` used to append the buffer a byte at a
    // time, which cost more than the read itself on any large file.
    this.functions.set("_bytesToString", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }, { type: { tag: "int", bits: 64, signed: true }, name: "len" }], ret: { tag: "string" }, variadic: false });
    this.functions.set("_strDataPtr", { params: [{ type: { tag: "ref", inner: { tag: "string" }, mutable: false }, name: "s" }], ret: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, variadic: false });
    // One byte onto stdout's stdio buffer. `putChar` used to write(2) per byte, which
    // is a syscall each and also raced ahead of `print`'s buffered output.
    this.functions.set("_putByte", { params: [{ type: { tag: "int", bits: 8, signed: false }, name: "b" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_loadU8", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 8, signed: false }, variadic: false });
    this.functions.set("_loadI32", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 32, signed: true }, variadic: false });
    this.functions.set("_callClosureVoid", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "fn" }, { type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "env" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("assert", { params: [{ type: { tag: "bool" }, name: "cond" }], ret: { tag: "void" }, variadic: true });
    this.functions.set("max", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
    this.functions.set("min", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
    // Atomic intrinsics — ptr arg is *u8, codegen emits LLVM atomic instructions
    const i64t: TypeKind = { tag: "int", bits: 64, signed: true };
    this.functions.set("_atomicLoadI64", { params: [{ type: ptrU8, name: "ptr" }], ret: i64t, variadic: false });
    this.functions.set("_atomicStoreI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_atomicAddI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
    this.functions.set("_atomicSubI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
    this.functions.set("_atomicSwapI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
    this.functions.set("_atomicCasI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "expected" }, { type: i64t, name: "desired" }], ret: i64t, variadic: false });
    this.functions.set("_atomicLoadI32", { params: [{ type: ptrU8, name: "ptr" }], ret: i32t, variadic: false });
    this.functions.set("_atomicStoreI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_atomicAddI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
    this.functions.set("_atomicSubI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
    this.functions.set("_atomicSwapI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
    this.functions.set("_atomicCasI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "expected" }, { type: i32t, name: "desired" }], ret: i32t, variadic: false });
    this.functions.set("_atomicLoadBool", { params: [{ type: ptrU8, name: "ptr" }], ret: { tag: "bool" }, variadic: false });
    this.functions.set("_atomicStoreBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_atomicSwapBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "bool" }, variadic: false });
    this.functions.set("_atomicCasBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "expected" }, { type: { tag: "bool" }, name: "desired" }], ret: { tag: "bool" }, variadic: false });
    // Scheduler global access — green thread runtime
    this.functions.set("_schedulerGet", { params: [], ret: ptrU8, variadic: false });
    this.functions.set("_schedulerSet", { params: [{ type: ptrU8, name: "ptr" }], ret: { tag: "void" }, variadic: false });

    this.registerBuiltinTraits();
    this.registerBuiltinOption();
    this.registerBuiltinResult();

    // register type aliases
    for (const ta of program.typeAliases) {
      this.typeAliases.set(ta.name, ta.type);
      if (ta.typeParams?.length) {
        this.aliasTypeParams.set(ta.name, ta.typeParams.map(tp => tp.name));
        for (const tp of ta.typeParams) {
          if (tp.bounds.length > 0) {
            // A bound constrains the uses of a type parameter inside a body. An alias has
            // no body of its own — it is textually replaced — so there is nothing here for
            // a bound to constrain, and honouring the syntax silently would promise a
            // check that never runs.
            this.error(`type alias '${ta.name}': type parameter '${tp.name}' cannot carry a bound`, ta.span,
              `an alias is expanded at each use, so a bound here would never be checked — put the bound on the function or struct that uses the alias`);
          }
        }
      }
    }

    // pre-register enum names so struct fields can reference enum types
    for (const e of program.enums) {
      if (e.typeParams.length === 0) {
        this.enums.set(e.name, { variants: new Map() });
      }
    }

    // Pre-register interface names so struct fields (e.g. `Heap<Shape>`) resolve
    // their inner to an interface rather than defaulting to a struct. Full method
    // registration happens later and overwrites these placeholders.
    for (const iface of program.interfaces) {
      if (!this.interfaces.has(iface.name)) {
        this.interfaces.set(iface.name, { name: iface.name, methods: new Map() });
      }
    }

    // register structs — two passes so generic structs are available when resolving fields
    for (const s of program.structs) {
      if (s.typeParams.length > 0) {
        const fields = s.fields.map(f => ({ name: f.name, type: typeFromAst(f.type) }));
        this.genericStructs.set(s.name, { typeParams: s.typeParams.map(tp => tp.name), fields, decl: s });
      }
    }

    // pre-register generic impls so struct fields like Channel<string> trigger full monomorphization
    for (const impl of program.impls) {
      if (impl.typeParams && impl.typeParams.length > 0 && !impl.traitName) {
        const existing = this.genericImpls.get(impl.typeName) || [];
        existing.push({ impl, program });
        this.genericImpls.set(impl.typeName, existing);
      }
    }
    // Drop-ness has to be known before the FIRST monomorphization, which a struct field
    // (`struct S { pool: Arena<Res> }`) triggers below: a `@copyOut` method is kept or
    // dropped from that instantiation by asking resourceKind(Res) right then, and an
    // answer from an empty dropImpls would keep `Arena<Res>.get`. The later registration
    // (before derive synthesis) validates; this one only pre-fills the same Set.
    const declaredTypeNames = new Set([...program.structs.map(s => s.name), ...program.enums.map(e => e.name)]);
    for (const impl of program.impls) {
      if (impl.traitName === "Drop" && declaredTypeNames.has(impl.typeName)) this.dropImpls.add(impl.typeName);
    }

    for (const s of program.structs) {
      if (s.typeParams.length === 0) {
        const fields = s.fields.map(f => ({
          name: f.name, type: this.thinFnField(s.isExtern, this.resolve(f.type)),
          ...(f.attributes?.some(a => a.name === "cOpaque") ? { cOpaque: true } : {}),
          ...(f.attributes?.some(a => a.name === "iter") ? { iterDelegate: true } : {}),
        }));
        for (const f of fields) {
          if (f.type.tag === "ref") {
            this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`, undefined, `references are second-class — use an owned type instead`);
          } else if (this.nestedRef(f.type)) {
            this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in a collection`, undefined, `references are second-class — store owned values instead`);
          }
        }
        const copy = s.attributes?.some(a => a.name === "copy") ?? false;
        const pointerField = copy ? undefined : rawPointerField(fields);
        this.structs.set(s.name, {
          fields, isExtern: s.isExtern, isOpaque: s.isOpaque,
          ...(s.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
          ...(copy ? { copy: true } : {}),
          ...(pointerField ? { pointerField } : {}),
        });
      }
    }

    // Reject a struct that embeds itself by value (directly or through other by-value
    // structs / fixed arrays) — it has infinite size and can't be laid out, yet used
    // to compile and produce a broken type. What counts as "by value" is `embedsSelf`.
    // Generic declarations are skipped here and rejected per instantiation at the end
    // of this function, because `A<T> { me: A<T> }` has no layout to walk until T is
    // chosen.
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      if (this.embedsSelf(s.name, new Set())) {
        this.error(`struct '${s.name}' is recursive by value and has infinite size`, s.span,
          `a struct cannot contain itself by value — put the recursive field behind an indirection (e.g. 'Heap<${s.name}>' or 'Vec<${s.name}>')`);
      }
    }

    // validate extern-struct fields once all structs are registered (nested extern
    // structs may be declared in any order). Non-extern structs are unrestricted.
    for (const s of program.structs) {
      if (s.typeParams.length > 0 || !s.isExtern || s.isOpaque) continue;
      const info = this.structs.get(s.name);
      if (!info) continue;
      for (const f of info.fields) {
        if (!this.isValidExternStructField(f.type)) {
          this.error(`extern struct '${s.name}' field '${f.name}': type '${this.show(f.type)}' is not C-representable`, undefined,
            `extern-struct fields must be scalars, pointers, C function pointers ('(A, B) => R'), nested extern structs, or fixed arrays of those`);
        }
      }
    }

    // Struct invariants name the struct's own fields directly (`chr.len > 0`), so they are
    // checked in a scope holding exactly those fields. Nothing else is visible: an invariant
    // reaching for a global or a caller's local would be a claim the type cannot maintain
    // on its own, which is the only thing that makes it assumable at every use site.
    for (const s of program.structs) {
      if (!s.invariants?.length) continue;
      // Generic structs are allowed: an invariant is discharged against the generic
      // declaration, before monomorphization, so one clause covers every instantiation. A
      // clause that reaches into a field of type-parameter type simply won't typecheck.
      const info = this.structs.get(s.name);
      if (!info) continue;
      this.pushScope();
      for (const f of info.fields) {
        this.declare(f.name, { type: f.type, mutable: false, moved: false, borrowed: false, read: true });
      }
      for (const inv of s.invariants) {
        if (inv.kind !== "invariant") {
          this.error(`a struct takes only 'invariant' clauses, not '${inv.kind}'`, inv.span);
          continue;
        }
        this.checkContractClause(inv);
      }
      this.popScope();
    }

    for (const s of program.structs) {
      this.validateAttributes(s.name, s.attributes, "struct");
      this.validateFieldAttributes(s);
      this.warnUnverifiedExtern(s);
      if (s.attributes) {
        for (const attr of s.attributes) {
          if (attr.name === "cLayout") this.checkCLayout(s, attr);
          if (attr.name === "noCopy" && attr.args && attr.args.length > 0) {
            this.error(`'@noCopy' on '${s.name}' takes no arguments`, s.span,
              `write '@noCopy' on its own line above the struct`);
          }
          if (attr.name === "copy") this.validateCopyAttr(s, attr, program);
          if (attr.name === "copyOnly") this.validateCopyOnly(s.name, attr, s.typeParams.map(t => t.name), s.span);
        }
      }
    }
    for (const e of program.enums) this.validateAttributes(e.name, e.attributes, "enum");

    // Option and Result are compiler builtins with dedicated syntax (`T?`, `!`, `??`,
    // `?`-propagation) that a redeclaration does not rebind, and prelude signatures
    // already name them. Overriding one used to be allowed and merely broke the
    // prelude three files away; say so at the declaration instead.
    for (const e of program.enums) {
      if (e.name === "Option" || e.name === "Result") {
        this.error(`'${e.name}' is a builtin enum and cannot be redeclared`, e.span,
          `it already has the shape you are writing — delete this declaration, or rename it if you meant a different type`);
      }
    }

    // register enums — two passes so generic enums are available when resolving variant fields
    for (const e of program.enums) {
      if (e.typeParams.length > 0) {
        if (e.reprType) {
          this.error(`integer-repr enum '${e.name}' cannot be generic`, e.span,
            `remove the type parameters or remove ': ${e.reprType}'`);
          if (e.reprType !== "i32") {
            this.error(`enum '${e.name}' has unsupported representation '${e.reprType}'`, e.span,
              `integer-repr enums currently require ': i32'`);
          }
        }
        const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
        e.variants.forEach((v, i) => {
          variants.set(v.name, { tag: i, fields: v.fields.map(f => typeFromAst(f)) });
        });
        this.genericEnums.set(e.name, { typeParams: e.typeParams.map(tp => tp.name), variants, decl: e });
      }
    }
    for (const e of program.enums) {
      if (e.typeParams.length === 0) {
        // user-declared non-generic enum overrides any built-in generic of the same name
        this.genericEnums.delete(e.name);
        // pre-register so self-referential fields (Heap<Self>) resolve correctly
        this.enums.set(e.name, { variants: new Map() });
        const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
        // A repr'd enum's tag IS its integer value: explicit `= N`, else previous + 1 from 0.
        // Sparse/non-contiguous is allowed and expected (that is why tryFrom is generated).
        let nextDisc = 0;
        const usedDiscs = new Map<number, string>();
        if (e.reprType && e.reprType !== "i32") {
          this.error(`enum '${e.name}' has unsupported representation '${e.reprType}'`, e.span,
            `integer-repr enums currently require ': i32'`);
        }
        e.variants.forEach((v, i) => {
          const fields = v.fields.map(f => this.resolve(f));
          for (const field of fields) {
            if (field.tag === "enum" && field.name === e.name) {
              this.error(`enum '${e.name}' has infinite size due to recursive field`, undefined,
                `wrap the recursive field in Heap<${e.name}> for heap allocation`);
            }
          }
          let tag = i;
          if (e.reprType) {
            if (fields.length > 0) {
              this.error(`variant '${v.name}' of repr'd enum '${e.name}' cannot carry a payload`, e.span,
                `an 'enum ... : ${e.reprType}' is a C-like enum; drop the '(...)' or drop the ': ${e.reprType}'`);
            }
            tag = v.discriminant ?? nextDisc;
            if (!Number.isInteger(tag) || tag < -2147483648 || tag > 2147483647) {
              this.error(`discriminant ${tag} is out of range for i32 in enum '${e.name}'`, e.span);
            }
            const clash = usedDiscs.get(tag);
            if (clash) this.error(`discriminant ${tag} is used by both '${clash}' and '${v.name}' in enum '${e.name}'`, e.span);
            usedDiscs.set(tag, v.name);
            nextDisc = tag + 1;
          }
          variants.set(v.name, { tag, fields });
        });
        this.enums.set(e.name, { variants, ...(e.reprType && { reprType: e.reprType }) });
      }
    }

    // register interfaces (before functions so &Interface params resolve correctly)
    for (const iface of program.interfaces) {
      const methods = new Map<string, InterfaceMethodInfo>();
      for (const m of iface.methods) {
        if (m.body !== null) {
          this.error(`interface methods cannot have default bodies`, m.span);
        }
        const params = m.params.map(p => ({ name: p.name, type: this.resolve(declaredType(p)) }));
        const selfParam = params[0];
        if (!selfParam || selfParam.type.tag !== "ref") {
          this.error(`interface method '${m.name}' must take self by reference (&Self or &mut Self)`, m.span);
        }
        const ret = this.resolve(m.retType);
        methods.set(m.name, { params, ret });
      }
      this.interfaces.set(iface.name, { name: iface.name, methods });
    }

    // register traits (user-defined override built-ins)
    for (const t of program.traits) {
      for (const sup of t.supertraits) {
        if (!this.traits.has(sup)) {
          this.error(`supertrait '${sup}' not found`, t.span);
        }
      }
      const methods = new Map<string, TraitMethodInfo>();
      for (const m of t.methods) {
        const params = m.params.map(p => ({ name: p.name, type: this.resolve(declaredType(p)) }));
        const ret = this.resolve(m.retType);
        methods.set(m.name, { params, ret, hasDefault: m.body !== null });
      }
      this.traits.set(t.name, { name: t.name, supertraits: t.supertraits, methods });
    }

    // register functions
    for (const fn of program.functions) {
      if (fn.attributes) {
        for (const attr of fn.attributes) {
          if (attr.name === "cSig") this.checkCSig(fn, attr);
          // @externalLinkage forces external linkage — see lower.ts. Needed when the
          // only caller is a dlopen'd library resolving against this executable, which
          // no reachability analysis can see.
          else if (attr.name === "externalLinkage") {
            if (fn.isExtern) {
              this.error(`'@externalLinkage' on extern fn '${fn.name}' — extern declares a function defined elsewhere, so there is no definition here to give linkage to`, undefined,
                `drop '@externalLinkage', or remove 'extern' if you meant to define it`);
            }
            // Legal, and occasionally exactly right: a fn nothing in Milo references,
            // resolved only by a dlopen'd library against this executable. So a warning,
            // never an error. But the pairing is more often a slip — the author wanted
            // "visible from outside" and reached for the linkage attribute instead of
            // `pub`, or had both and dropped the `pub`. The two live in unrelated domains
            // (module graph vs C linker) and nothing else flags them disagreeing.
            else if (!fn.isPub && this.currentFnIsUser) {
              this.warn("external-linkage-not-pub", `'@externalLinkage' on non-pub fn '${fn.name}'`, fn.span,
                `'@externalLinkage' is a C-linker concern and does not make '${fn.name}' importable from Milo — add 'pub' if that is what you meant, and keep both if a dlopen'd library resolves this symbol`);
            }
          }
          else if (attr.name === "link") {
            if (!fn.isExtern) {
              this.error(`'@link' on '${fn.name}': only an 'extern fn' links against a native library`, undefined,
                `put @link on an extern declaration`);
            }
            if (attr.args.length === 0) {
              this.error(`'@link' needs a library name, e.g. @link("SDL2")`, undefined,
                `the argument is the -l name, so @link("SDL2") links -lSDL2`);
            }
            attr.argKinds?.forEach((k, i) => {
              if (k !== "string") {
                this.error(`'@link' argument must be a string library name, got '${attr.args[i]}'`, undefined,
                  `write @link("SDL2"), not @link(SDL2)`);
                return;
              }
              // The name is pasted into the link command the compiler shells out to, so it
              // is held to a charset that cannot close the argument and inject a command —
              // the same reason @cLayout/@cSig constrain their arguments. `milo add` fetches
              // third-party source, and building a package must not be able to run one.
              const name = attr.args[i]!;
              if (!TypeChecker.LINK_NAME_RE.test(name)) {
                this.error(`'@link' argument '${name}' is not a library name`, undefined,
                  `expected the '-l' name (letters, digits, '_', '.', '+', '-'), optionally 'framework:Name' for a darwin framework`);
              }
            });
          }
          // @wrapping makes the routine's + - * -x, div INT_MIN/-1, and over-shifts use
          // defined modular arithmetic (two's-complement wrap / masked shift) instead of
          // trapping. It is a correctness dial only: div-by-zero, bounds, and ranged
          // checks still trap, and `as` conversions are unchanged.
          else if (attr.name === "wrapping") {
            if (fn.isExtern) {
              this.error(`'@wrapping' on extern fn '${fn.name}' — an extern is defined elsewhere, so there is no arithmetic here to make modular`, undefined,
                `drop '@wrapping'`);
            }
            if (attr.args.length > 0) {
              this.error(`'@wrapping' takes no arguments`, undefined,
                `write '@wrapping fn ${fn.name}(...)'`);
            }
          }
          // @pure declares the function has no effect the signature doesn't already show:
          // it reads and writes only its parameters and its own locals. On a Milo body that
          // is checked (see checkPurity); on an `extern` it is an assertion, because there
          // is no body here to inspect — the same trust hole every effect system has at the
          // FFI boundary.
          else if (attr.name === "pure") {
            if (attr.args.length > 0) {
              this.error(`'@pure' takes no arguments`, undefined, `write '@pure fn ${fn.name}(...)'`);
            }
          }
          else if (attr.name === "copyOnly") this.validateCopyOnly(fn.name, attr, fn.typeParams.map(t => t.name), undefined);
          // Bare only: it constrains every type parameter, since the copy is of whatever
          // the container holds and a routine copying out one parameter and not another
          // has not come up. On a concrete fn it would be a claim about nothing.
          else if (attr.name === "copyOut") {
            if (attr.args.length > 0) this.error(`'@copyOut' takes no arguments`, undefined, `write '@copyOut fn ${fn.name}<...>(...)'`);
            if (fn.typeParams.length === 0) {
              this.error(`'@copyOut' on '${fn.name}': it has no type parameters to constrain`, undefined,
                `'@copyOut' withholds a generic from a type argument that carries Drop or @noCopy; a concrete fn has none, so drop the attribute`);
            }
          }
          // @thread marks a fn that hands a closure param to a real OS thread. It is the
          // single source of truth for where a data race can enter a program — see
          // checkThreadBoundary, which reads this rather than hardcoding entry points.
          else if (attr.name === "thread") {
            if (attr.args.length > 0) {
              this.error(`'@thread' takes no arguments`, undefined, `write '@thread fn ${fn.name}(...)'`);
            }
          }
          // @parks marks a fn that can switch the current green task out. It sits on the
          // primitives that call swapcontext (the checker cannot see through that extern);
          // everything reaching them inherits it in checkGlobalBorrowInvalidation.
          else if (attr.name === "parks") {
            if (attr.args.length > 0) {
              this.error(`'@parks' takes no arguments`, undefined, `write '@parks fn ${fn.name}(...)'`);
            }
          }
          // @unsafe moves the proof obligation to the caller: the body may be entirely
          // checkable and the function still unsound to call with the wrong arguments.
          // Nothing is verified here (that is the point), so the only check is the shape.
          else if (attr.name === "unsafe") {
            if (attr.args.length > 0) {
              this.error(`'@unsafe' takes no arguments`, undefined, `write '@unsafe fn ${fn.name}(...)'`);
            }
            if (fn.isExtern) {
              this.error(`'@unsafe' on extern fn '${fn.name}': an extern call's unsafety is already decided by its signature`, undefined,
                `drop '@unsafe'; see the extern rules in docs/language-reference.md`);
            }
          }
          else this.error(`'@${attr.name}' is not supported on functions — '${fn.name}'`, undefined,
            `only ${attributesFor("fn").map(a => `'@${a}'`).join(", ")} apply to a fn; it would be silently ignored otherwise`);
        }
      }
      this.checkVariadicExtern(fn);
      this.warnUnverifiedExternFn(fn);
      if (fn.typeParams.length > 0) {
        this.genericFns.set(fn.name, { typeParams: fn.typeParams.map(tp => tp.name), decl: fn });
        continue;
      }
      const params = fn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
      const ret = this.resolve(fn.retType);
      this.errorIfRefReturn(fn, ret);
      // main lowers to a C `int main`; codegen forces its LLVM return to i32, so
      // any other return type emits a mismatched `ret` and fails at the LLVM
      // stage instead of here. Catch it in the checker.
      if (fn.name === "main" && !fn.isExtern) {
        const okMain = ret.tag === "void" || (ret.tag === "int" && ret.bits === 32 && ret.signed);
        if (!okMain) {
          this.error(`'main' must return i32 or void, got ${this.show(ret)}`, fn.span, `the entry point lowers to C 'int main'`);
        }
      }
      // extern signatures must be C-representable — catch ABI-broken decls here rather
      // than emitting silently-wrong IR in codegen
      if (fn.isExtern) {
        for (const p of params) {
          const err = this.externSigError(p.type, "parameter");
          if (err) this.error(`extern function '${fn.name}' parameter '${p.name}': ${err.msg}`, undefined, err.hint);
        }
        const retErr = this.externSigError(ret, "return type");
        if (retErr) this.error(`extern function '${fn.name}' return type: ${retErr.msg}`, undefined, retErr.hint);
      }
      // fn return types allowed — move closures heap-allocate and are safe to escape
      this.functions.set(fn.name, { params, ret, variadic: fn.isVariadic, isExtern: fn.isExtern });
      // The call site needs the declaration for contracts and for `@unsafe`; recording it
      // only for contracts meant an `@unsafe fn` with no `requires` clause was declared
      // unsafe and called freely.
      if ((fn.contracts && fn.contracts.length > 0) || fn.attributes?.some(a => a.name === "unsafe")) {
        this.fnDecls.set(fn.name, fn);
      }
    }

    // Drop-ness has to be known BEFORE derive synthesis, not after registerImpl runs:
    // a Drop type is never Copy, and the first copy-ness query decides that from an empty
    // dropImpls and caches `true`. The auto-derived Clone then reads its field as Copy and
    // synthesizes `Wrap { inner: self.inner }`, a move out of `&self`, which the checker
    // rejects with no span on a struct the program never touched. registerImpl adds these
    // again; a Set makes that idempotent, and it still owns the validation.
    for (const impl of program.impls) {
      if (impl.traitName === "Drop" && (this.structs.has(impl.typeName) || this.enums.has(impl.typeName))) {
        this.dropImpls.add(impl.typeName);
      }
    }
    this.allCopyCache.clear();

    // process @derive attributes — synthesize impl decls
    const derivedImpls = this.processDerives(program);

    // register impls
    const implFnsToCheck: Function[] = [];
    for (const impl of [...program.impls, ...derivedImpls]) {
      this.registerImpl(impl, program, implFnsToCheck);
    }
    // Record which field of the receiver each view-returning method points into, before
    // any body is checked — a call site freezes the receiver, and without this it has to
    // freeze the whole object, so a view of `self.a` would block writes to `self.b`.
    // Done as a pre-pass rather than during checkFunction so the answer does not depend
    // on whether the method happens to be checked before its first call site.
    for (const fn of implFnsToCheck) this.recordViewProvenance(fn);

    this.orderGlobalsByDependency(program);

    // type-check module-level globals — push a module scope so declare() works
    this.pushScope();
    const globalTypes = new Map<string, TypeKind>();
    // Declare annotated globals up front. Checking one global's initializer can
    // monomorphize a function whose body reads a global declared further down the
    // list (a `var g: Arena<T> = arenaNew<T>()` reaches std/arena's `nextArenaId`),
    // and checking them strictly in order reported that as an undefined variable
    // inside a std file. Unannotated globals still wait for their inferred type.
    for (const g of program.globals) {
      if (!g.type) continue;
      const t = this.resolve(g.type);
      globalTypes.set(g.name, t);
      this.declare(g.name, { type: t, mutable: g.mutable, moved: false, borrowed: false, read: true, span: g.span });
    }
    for (const g of program.globals) {
      const hint = g.type ? this.resolve(g.type) : null;
      const valType = this.checkExprWithHint(g.value, hint);
      const finalType = hint ?? valType;
      if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
        this.error(`global '${g.name}': type mismatch: expected ${this.show(hint)}, got ${this.show(valType)}`, g.span);
      }
      globalTypes.set(g.name, finalType);
      // Non-constant initializers used to be rejected when the module had no main(),
      // because the generated init routine is called from main. That answered a
      // whole-program question ("is anything going to link this?") inside a per-module
      // pass, so `milo check` rejected every library holding a string constant. A
      // Milo string is an owned heap buffer, so `pub let A: string = "hi"` is never
      // const. The missing-entry-point diagnostic now lives in the driver, where the
      // build/run path is the one that actually needs an entry point.
      //
      // The decision is still made and published on CheckResult, because one build
      // mode does have no entry point to run the routine: `emit-obj --no-entry`
      // strips `@main`, so nothing ever calls `@__milo.global_init` and every global
      // in this list would silently stay zero. That path rejects on this list.
      if (!this.isConstGlobalInit(g.value)) this._nonConstGlobals.push(g.name);
      if (!g.type) this.declare(g.name, { type: finalType, mutable: g.mutable, moved: false, borrowed: false, read: true, span: g.span });
      for (const attr of g.attributes ?? []) {
        if (attr.name === "cValue") this.checkCValue(g, attr, finalType);
        else {
          // Attributes on globals parsed but were silently discarded before @cValue
          // existed, so an unknown one here is a no-op the author believes is doing
          // something. Reject rather than inherit that.
          this.error(`'@${attr.name}' is not an attribute a global can carry`, g.span,
            `only '@cValue(...)' applies to a global`);
        }
      }
    }
    this._globalTypes = globalTypes;

    // The outer `recover` per function catches a `fatal()` fired in the signature
    // or contracts, before the per-statement boundaries inside the body exist.
    for (const fn of program.functions) {
      if (!fn.isExtern && fn.typeParams.length === 0) this.recover(() => this.checkFunction(fn));
    }

    this.checkRawTypeParamReads();
    this.flushStructBounds();

    // type-check impl method bodies after all registrations
    for (const fn of implFnsToCheck) {
      if (this.fromBoundFailedStruct(fn)) continue;
      this.recover(() => this.checkFunction(fn));
    }

    // drain deferred impl fns from generic impl monomorphization
    while (this._pendingImplFns.length > 0) {
      const batch = this._pendingImplFns.splice(0);
      this.flushStructBounds();
      for (const fn of batch) {
        if (this.fromBoundFailedStruct(fn)) continue;
        this.recover(() => this.checkFunction(fn));
      }
    }
    this.flushStructBounds();

    // Any deferred-inference Vec that never saw a `push` couldn't have its element
    // resolved — fall back to the original "add an annotation" error.
    for (const p of this.pendingInferVecs) {
      if (this.inferVecElems.has(p.elem as object)) {
        this.error(`cannot infer Vec element type — no 'push' found to infer from; add a type annotation: 'let v: Vec<T> = Vec.new()'`, p.span);
      }
    }

    // The infinite-size rejection above only covers structs that were WRITTEN with
    // concrete fields. A generic declaration cannot be walked: `A<T> { me: A<T> }`
    // says nothing about layout until T is chosen, so the cycle is only visible in
    // the instantiation. Instantiations are created on demand, some of them from a
    // function body, so this runs at the end when the set has stopped growing.
    //
    // Without it `A<i64>` type-checked clean and reached codegen as
    // `%A_i64 = type { i64, %A_i64 }`, which clang rejects as a recursive type: an
    // accepted program the backend cannot build.
    for (const mangled of [...this.structs.keys()]) {
      const info = must(this.structs, mangled, "structs");
      if (info.baseName === undefined) continue;
      if (!this.embedsSelf(mangled, new Set())) continue;
      const shown = this.demangle(mangled);
      this.error(`struct '${shown}' is recursive by value and has infinite size`, undefined,
        `a struct cannot contain itself by value: put the recursive field behind an indirection (e.g. 'Heap<${shown}>' or 'Vec<${shown}>')`);
    }

    // The whole-program passes below all read the finished program through one view:
    // the call-resolution maps are complete, every monomorphized instance exists, and
    // `closureCaptures` / the auto-`move` promotions have settled. Built once here so no
    // pass carries its own copy of "which function does this call reach".
    const view = this.programView(program);

    // `@pure` needs the finished call-resolution maps and the full set of
    // monomorphized instances, so it runs after everything else has been checked.
    this.checkPurity(program, view);

    // Also needs the finished maps: `closureCaptures` is filled as each closure body is
    // checked, and the auto-`move` promotions have all settled by now.
    this.checkEscapingClosures(program, view);

    // Same reason: the `@thread` entry points, their call sites, and the closure captures
    // are all resolved by now.
    this.checkThreadBoundary(program, view);

    // Needs the finished call-resolution maps too: the global-write summary is a fixpoint
    // over the call graph, so every callee has to be resolvable before it runs.
    this.checkGlobalBorrowInvalidation(program, view);
    this.lintArenaNeverFrees(program);

    // An expectation that never fired means the code it excused was fixed and the
    // suppression outlived its cause. Reported here, after every warning has had its
    // chance to fire.
    for (const name of this.warningConfig.expected ?? []) {
      if (this.firedWarnings.has(name)) continue;
      this.warn("unfulfilled-expectation",
        `'--expect=${name}' was given but no '${name}' warning was reported`, undefined,
        `the code this suppression excused looks fixed: drop the flag, or switch it to '--allow=${name}' if you meant to silence it unconditionally`);
    }

    // File-level `pub` visibility: a reference to a non-`pub` decl defined in
    // another file is an error. Run last so it never masks a more basic type error.
    for (const v of checkVisibility(program)) {
      const where = v.declFiles.length === 1 ? basename(v.declFiles[0]) : `${v.declFiles.length} files`;
      this.diagnostics.push({
        severity: "error",
        span: v.span,
        message: `'${v.name}' is private to ${where}`,
        hint: `mark '${v.name}' as 'pub' where it is defined to use it from another file`,
        code: "private",
      });
    }

  }

  private processDerives(program: Program): import("./ast").ImplDecl[] {
    const result: import("./ast").ImplDecl[] = [];
    const explicitEq = new Set<string>();
    const explicitClone = new Set<string>();
    for (const tpl of program.deriveTemplates ?? []) {
      // A template may not take a built-in's name. Silently losing to `Eq` would make a
      // package's derive a no-op that still type-checks, which is the worst failure a
      // plugin point can have.
      if (tpl.name === "Eq" || tpl.name === "Json") {
        this.error(`'derive ${tpl.name}' collides with the built-in @derive(${tpl.name})`, tpl.span,
          `rename the template — a user derive cannot replace a built-in one`);
        continue;
      }
      const prev = this.deriveTemplates.get(tpl.name);
      if (prev && prev !== tpl) {
        this.error(`'derive ${tpl.name}' is declared twice`, tpl.span,
          `two modules in this program each define a derive named '${tpl.name}'; rename one`);
        continue;
      }
      this.deriveTemplates.set(tpl.name, tpl);
    }
    // Derives run before impls are registered, so the user's own methods are not
    // in `this.functions` yet — read them off the AST.
    for (const im of program.impls) {
      for (const m of im.methods) this.jsonUserMethods.add(`${im.typeName}.${m.name}`);
    }
    // A struct is a legal Json field type if it derives the codec or hand-wrote
    // one. Collected up front so field validation does not depend on which
    // struct the derive loop reaches first.
    for (const s of program.structs) {
      if (s.attributes?.some(a => a.name === "derive" && a.args.includes("Json"))) {
        this.jsonCapableStructs.add(s.name);
      }
    }
    for (const key of this.jsonUserMethods) {
      if (key.endsWith(".fromJsonNode")) this.jsonCapableStructs.add(key.slice(0, -".fromJsonNode".length));
    }
    for (const s of program.structs) {
      if (!s.attributes || s.typeParams.length > 0) continue;
      for (const attr of s.attributes) {
        if (attr.name !== "derive") continue;
        for (const traitName of attr.args) {
          if (traitName === "Eq") explicitEq.add(s.name);
          if (traitName === "Clone") {
            explicitClone.add(s.name);
            // Checked here, not in deriveClone: dropImpls is not populated until impls
            // register, which is after synthesis — the method-local check passed a Drop
            // type clean because it ran too early to see the impl.
            if (program.impls.some(i => i.traitName === "Drop" && i.typeName === s.name)) {
              this.error(`cannot derive Clone for '${s.name}': it implements Drop, so each clone would release the resource again on drop`, s.span);
            }
          }
          const impl = this.synthesizeDeriveImpl(s, traitName);
          if (impl) result.push(impl);
        }
      }
    }
    // auto-derive Eq for all structs not explicitly derived and not generic
    // loop until fixpoint (struct A containing struct B needs B derived first)
    const derived = new Set<string>();
    const cloneDerived = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of program.structs) {
        if (s.typeParams.length > 0) continue;
        if (s.isOpaque) continue;
        if (explicitEq.has(s.name)) continue;
        if (derived.has(s.name)) continue;
        if (program.impls.some(i => i.traitName === "Eq" && i.typeName === s.name)) continue;
        let allEq = true;
        for (const f of s.fields) {
          const ft = this.resolve(f.type);
          if (!this.canAutoEq(ft)) { allEq = false; break; }
        }
        if (allEq) {
          const impl = this.deriveEq(s, true);
          if (impl) { result.push(impl); derived.add(s.name); changed = true; }
        }
      }
      // Auto-derive Clone by the same fixpoint, so `.clone()` exists on every plain
      // struct without ceremony — the explicit spelling the index-clone lint asks for
      // has to actually be available. Fixpoint, because struct A { b: B } is clonable
      // only once B is.
      //
      // Two exclusions Eq does not need: a Drop type (cloning an fd closes it twice —
      // the TcpStream bug, as a method) and `@noCopy` (the attribute exists precisely
      // to stop copies of a resource handle; a clone() would be the same hazard with
      // an explicit spelling).
      for (const s of program.structs) {
        if (s.typeParams.length > 0) continue;
        if (s.isOpaque) continue;
        if (explicitClone.has(s.name)) continue;
        if (cloneDerived.has(s.name)) continue;
        if (program.impls.some(i => i.traitName === "Clone" && i.typeName === s.name)) continue;
        if (program.impls.some(i => i.traitName === "Drop" && i.typeName === s.name)) continue;
        if (s.attributes?.some(a => a.name === "noCopy")) continue;
        if (this.structs.get(s.name)?.pointerField) continue;
        let allClone = true;
        for (const f of s.fields) {
          const ft = this.resolve(f.type);
          if (!this.canAutoClone(ft, cloneDerived)) { allClone = false; break; }
        }
        if (allClone) {
          const impl = this.deriveClone(s, true);
          if (impl) { result.push(impl); cloneDerived.add(s.name); changed = true; }
        }
      }
    }
    return result;
  }

  // A field the synthesized clone() can reproduce: copied when Copy, `.clone()`d when the
  // builtin or the struct provides one. Enums with payloads have no clone path yet, so a
  // struct holding one is not auto-clonable — explicit `@derive(Clone)` on it errors with
  // the field name rather than synthesizing something wrong.
  // `pending` carries the structs derived earlier in the same fixpoint loop — they are
  // not in traitImpls yet (registration happens after synthesis), and without them the
  // fixpoint can never close over `struct A { b: B }`.
  private canAutoClone(t: TypeKind, pending?: Set<string>): boolean {
    if (this.isCopyType(t)) return true;
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
    if (t.tag === "struct") return this.typeImplementsTrait(t.name, "Clone") || !!pending?.has(t.name);
    return false;
  }

  private deriveClone(s: import("./ast").StructDecl, skipValidation = false): import("./ast").ImplDecl {
    if (!skipValidation) {
      if (this.dropImpls.has(s.name) || s.attributes?.some(a => a.name === "noCopy")) {
        this.error(`cannot derive Clone for '${s.name}': it is a resource type (Drop or @noCopy), and duplicating it would release the resource twice`, s.span);
      }
      const pointerField = this.structs.get(s.name)?.pointerField;
      if (pointerField) {
        this.error(`cannot derive Clone for '${s.name}': it holds a raw pointer ('${pointerField}') and is not @copy, so a clone would be a second owner of what the pointer addresses`, s.span,
          `mark '${s.name}' @copy if it does not own what the pointer points at; otherwise write the Clone impl by hand so it duplicates the pointee`);
      }
      for (const f of s.fields) {
        const ft = this.resolve(f.type);
        if (!this.canAutoClone(ft)) {
          this.error(`cannot derive Clone for '${s.name}': field '${f.name}' of type '${this.show(ft)}' has no clone`, s.span);
        }
      }
    }

    // synthesize: fn clone(self: &Self): Self { return S { f: self.f | self.f.clone(), ... } }
    const selfParam: import("./ast").Param = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    const fields = s.fields.map(f => {
      const ft = this.resolve(f.type);
      const access: Expr = { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "self" }, field: f.name };
      const value: Expr = this.isCopyType(ft)
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

  private canAutoEq(t: TypeKind): boolean {
    if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "string") return true;
    if (t.tag === "enum") {
      const info = this.enums.get(t.name);
      if (!info) return false;
      for (const [, v] of info.variants) {
        if (v.fields.length > 0) return false;
      }
      return true;
    }
    if (t.tag === "struct") {
      const impls = this.traitImpls.get(t.name);
      return !!impls?.some(i => i.traitName === "Eq");
    }
    return false;
  }

  private synthesizeDeriveImpl(s: import("./ast").StructDecl, traitName: string): import("./ast").ImplDecl | null {
    if (traitName === "Eq") return this.deriveEq(s);
    if (traitName === "Clone") return this.deriveClone(s);
    if (traitName === "Json") return this.deriveJson(s);
    const tpl = this.deriveTemplates.get(traitName);
    if (tpl) {
      // Same one-bit visibility every other declaration has. Without it a template that a
      // module never exported is still reachable from every file in the program, which is
      // the opposite of the rule `pub` states everywhere else.
      if (!tpl.isPub && tpl.span?.file && s.span?.file && tpl.span.file !== s.span.file) {
        this.error(`'derive ${traitName}' is private to ${tpl.span.file}`, s.span,
          `mark it 'pub derive ${traitName} { … }' to let other modules derive it`);
        return null;
      }
      return this.expandUserDerive(s, tpl);
    }
    const known = ["Eq", "Json", ...this.deriveTemplates.keys()];
    this.error(`cannot derive '${traitName}' — no built-in derive and no 'derive ${traitName} { … }' template is in scope`, s.span,
      `available: ${known.map(k => `'${k}'`).join(", ")}. A user-defined derive is a top-level 'derive ${traitName} { … }' block; import the module that declares it`);
    return null;
  }

  // `derive <Trait> { … }` written by a user, expanded for one struct. Failures are
  // reported against the STRUCT rather than the template: the struct is what selected
  // this expansion, and it is the half the author of the failing program controls.
  private expandUserDerive(s: import("./ast").StructDecl, tpl: import("./ast").DeriveTemplate): import("./ast").ImplDecl | null {
    try {
      const impl = expandDeriveTemplate(tpl, s, s.span);
      if (process.env.MILO_DUMP_DERIVES) {
        process.stderr.write(`// derive ${tpl.name} for ${s.name}\n${dumpTokens(tpl.body)}\n`);
      }
      return this.stampOrigin(impl, s);
    } catch (e) {
      const msg = e instanceof DeriveTemplateError ? e.message
        : e instanceof Error ? e.message : String(e);
      const hint = e instanceof DeriveTemplateError ? e.hint
        : `set MILO_DUMP_DERIVES=1 to print what 'derive ${tpl.name}' generated`;
      this.error(`@derive(${tpl.name}) on '${s.name}': ${msg}`, s.span, hint);
      return null;
    }
  }

  // Templates in scope, by trait name. Filled per program in `processDerives` — a derive
  // reaches this compilation only by being declared in a file the resolver merged, which
  // is what makes a derive shippable in a package.
  private deriveTemplates = new Map<string, import("./ast").DeriveTemplate>();

  // A synthesized method has no source of its own, so it inherits the struct's file.
  // Without this it reaches the HIR with no origin at all: invisible to DWARF (what the
  // field is for) and to anything that groups definitions by module.
  //
  // Stamped in the generators rather than at the `@derive` call site because Eq is ALSO
  // auto-derived for every eligible struct that never asked for it — that path calls
  // `deriveEq` directly, and stamping only the explicit route left 40 of 1006 functions
  // in `java-dap` with no origin.
  private stampOrigin(impl: import("./ast").ImplDecl, s: StructDecl): import("./ast").ImplDecl {
    const file = s.span?.file;
    if (file) for (const m of impl.methods) m.sourceFile ??= file;
    return impl;
  }

  // Structs whose `toJson`/`fromJsonNode` exist: derived, or hand-written by the
  // user. A nested field type must be in this set, otherwise the generated call
  // fails deep inside code the user never wrote.
  private jsonCapableStructs = new Set<string>();
  // "Type.method" for every method the user actually wrote.
  private jsonUserMethods = new Set<string>();

  // Milo spelling of a type, for the `var x: T = …` lines the generator emits.
  // Different from `typeName` in one place that matters: an Option is a
  // monomorphized enum whose *name* is mangled, but its written form is not.
  private jsonTypeSpelling(t: TypeKind): string {
    if (t.tag === "array" && t.size !== null) return `[${this.jsonTypeSpelling(t.element)}; ${t.size}]`;
    if (t.tag === "vec") return `Vec<${this.jsonTypeSpelling(t.element)}>`;
    if (t.tag === "hashmap") return `HashMap<${this.jsonTypeSpelling(t.key)}, ${this.jsonTypeSpelling(t.value)}>`;
    if (t.tag === "enum") {
      const inner = this.optionInnerType(t);
      if (inner) return `Option<${this.jsonTypeSpelling(inner)}>`;
    }
    return typeName(t);
  }

  // A fixed array has to exist before it can be filled, so decoding one needs a value to
  // build the N slots with. Only types with an obvious zero qualify; anything else has no
  // neutral element to stand in, and inventing one (a struct of zeros) would put a value
  // the wire never sent into a field the caller reads.
  private jsonZeroFor(t: TypeKind): string | null {
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
  private jsonPlanFor(t: TypeKind): JsonPlan | { err: string } {
    switch (t.tag) {
      case "string": return { k: "string" };
      case "bool": return { k: "bool" };
      case "int": {
        // Not typeName: a refinement type prints as `i32(0..10)`, which is a
        // diagnostic spelling, not one the parser accepts back.
        const ty = `${t.signed ? "i" : "u"}${t.bits}`;
        if (!t.signed && t.bits === 64) return { k: "int", ty, unsigned64: true };
        if (t.signed && t.bits === 64) return { k: "int", ty, unsigned64: false };
        // Narrower than the i64 the cursor hands back: the value has to be range
        // checked before the cast, or the wire silently rewrites it.
        const hi = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
        const lo = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n;
        return { k: "int", ty, unsigned64: false, range: { lo: lo.toString(), hi: hi.toString() } };
      }
      case "float": return { k: "float", ty: `f${t.bits}` };
      case "struct": {
        if (!this.jsonCapableStructs.has(t.name)) {
          return { err: `struct '${t.name}' has no JSON codec — add @derive(Json) to it` };
        }
        return { k: "struct", name: t.name };
      }
      case "enum": {
        const inner = this.optionInnerType(t);
        if (inner) {
          const p = this.jsonPlanFor(inner);
          if ("err" in p) return p;
          // Both `Some(None)` and an absent field encode as `null`, so the outer
          // layer cannot survive a round trip. serde has the same hole; refusing
          // it is cheaper than a silently-collapsing field.
          if (p.k === "option") return { err: `Option<Option<T>> has no distinct JSON encoding — 'Some(None)' and an absent field are both null` };
          return { k: "option", ty: this.jsonTypeSpelling(t), inner: p };
        }
        const info = this.enums.get(t.name);
        if (!info) return { err: `unknown enum '${t.name}'` };
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
          return { err: `'[${this.show(t.element)}; ${t.size}]' has no JSON form: a fixed array must be built before it is filled, and '${this.show(t.element)}' has no zero value to build it with. Use 'Vec<${this.show(t.element)}>'` };
        }
        return { k: "array", ty: this.jsonTypeSpelling(t), elem: p, size: t.size, zero };
      }
      case "hashmap": {
        // A JSON object's keys are strings and nothing else. An i64-keyed map has no
        // lossless encoding — stringifying the key would round-trip `1` and `"1"` to the
        // same place — so say that rather than inventing one.
        if (t.key.tag !== "string") {
          return { err: `HashMap key '${this.show(t.key)}' has no JSON form — a JSON object's keys are strings, so only HashMap<string, V> encodes` };
        }
        const p = this.jsonPlanFor(t.value);
        if ("err" in p) return p;
        return { k: "map", ty: this.jsonTypeSpelling(t), value: p };
      }
      default:
        return { err: `type '${this.show(t)}' has no JSON form` };
    }
  }

  private deriveJson(s: import("./ast").StructDecl): import("./ast").ImplDecl | null {
    // An extern struct's fields are a C memory layout, and an opaque one has no
    // fields to read at all — a codec over either describes nothing a peer sends.
    if (s.isExtern || s.isOpaque) {
      this.error(`cannot derive Json for '${s.name}': it is a foreign type`, s.span,
        `an extern struct mirrors a C layout; write a Milo struct for the wire shape and convert`);
      return null;
    }
    // A monomorphized generic reaches this path without going through the
    // collection pass in processDerives.
    this.jsonCapableStructs.add(s.name);
    const fields: JsonFieldPlan[] = [];
    for (const f of s.fields) {
      const t = this.resolve(f.type);
      const plan = this.jsonPlanFor(t);
      if ("err" in plan) {
        this.error(`cannot derive Json for '${s.name}': field '${f.name}': ${plan.err}`, s.span);
        return null;
      }
      // `@json("wire_name")` renames one field on the wire. Everything else about
      // the codec follows the declaration, so this is the whole mapping surface.
      let key = f.name;
      const rename = f.attributes?.find(a => a.name === "json");
      if (rename) {
        const arg = rename.args[0];
        if (rename.args.length !== 1 || rename.argKinds?.[0] !== "string") {
          this.error(`@json on '${s.name}.${f.name}': expects one string, e.g. @json("user_id")`, s.span);
          return null;
        }
        // The name is emitted straight into a JSON string literal, so anything
        // needing an escape would have to be escaped in two grammars at once.
        if (arg === undefined || arg.length === 0 || /["\\\x00-\x1f]/.test(arg)) {
          this.error(`@json on '${s.name}.${f.name}': the name must be non-empty and free of quotes, backslashes and control characters`, s.span);
          return null;
        }
        key = arg;
      }
      fields.push({ field: f.name, key, plan });
    }
    const dupe = fields.find((f, i) => fields.findIndex(g => g.key === f.key) !== i);
    if (dupe) {
      this.error(`cannot derive Json for '${s.name}': two fields map to the JSON name '${dupe.key}'`, s.span);
      return null;
    }
    for (const name of ["toJson", "fromJson", "fromJsonNode"]) {
      if (this.jsonUserMethods.has(`${s.name}.${name}`)) {
        this.error(`cannot derive Json for '${s.name}': it already defines '${name}'`, s.span);
        return null;
      }
    }

    const src = deriveJsonSource(s.name, fields);
    // The one way to read code the user never wrote. Without it a diagnostic
    // pointing into "<derive Json for User>" names a file nobody can open.
    if (process.env.MILO_DUMP_DERIVES) process.stderr.write(`// ${s.name}: @derive(Json)\n${src}\n`);
    let parsed: Program;
    try {
      parsed = new Parser(new Lexer(src).tokenize(), src, `<derive Json for ${s.name}>`).parse();
    } catch (e) {
      this.error(`internal error: generated Json codec for '${s.name}' did not parse: ${e instanceof Error ? e.message : String(e)}`, s.span);
      return null;
    }
    const impl = parsed.impls[0];
    if (!impl) {
      this.error(`internal error: generated Json codec for '${s.name}' produced no impl`, s.span);
      return null;
    }
    for (const m of impl.methods) m.sourceFile = s.span?.file;
    return this.stampOrigin(impl, s);
  }

  private deriveEq(s: import("./ast").StructDecl, skipValidation = false): import("./ast").ImplDecl {
    if (!skipValidation) {
      for (const f of s.fields) {
        const ft = this.resolve(f.type);
        const ftName = typeName(ft);
        if (!this.typeImplementsTrait(ftName, "Eq")) {
          this.error(`cannot derive Eq for '${s.name}': field '${f.name}' of type '${ftName}' does not implement Eq`);
        }
      }
    }

    // synthesize: fn eq(self: &Self, other: &Self): bool { return self.f1 == other.f1 && self.f2 == other.f2 && ... }
    const selfParam: import("./ast").Param = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    // A field-less struct's synthesized body is `return true`, so `other` is never
    // read. Name it `_other` to suppress the unused-variable lint — the user can't
    // edit generated code to silence it, and the warning carries no span (the
    // synthesized param has none) so it prints without a location.
    const otherParam: import("./ast").Param = { name: s.fields.length === 0 ? "_other" : "other", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };

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

  private registerBuiltinOption() {
    if (this.genericEnums.has("Option")) return;
    const decl: import("./ast").EnumDecl = {
      kind: "EnumDecl",
      name: "Option",
      typeParams: [{ name: "T", bounds: [] }],
      variants: [
        { name: "Some", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
        { name: "None", fields: [] },
      ],
    };
    const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
    variants.set("Some", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
    variants.set("None", { tag: 1, fields: [] });
    this.genericEnums.set("Option", { typeParams: ["T"], variants, decl });
  }

  private registerBuiltinResult() {
    if (this.genericEnums.has("Result")) return;
    const decl: import("./ast").EnumDecl = {
      kind: "EnumDecl",
      name: "Result",
      typeParams: [{ name: "T", bounds: [] }, { name: "E", bounds: [] }],
      variants: [
        { name: "Ok", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
        { name: "Err", fields: [{ name: "E", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
      ],
    };
    const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
    variants.set("Ok", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
    variants.set("Err", { tag: 1, fields: [{ tag: "struct", name: "E" }] });
    this.genericEnums.set("Result", {
      typeParams: ["T", "E"],
      typeParamDefaults: [null, { tag: "string" }],
      variants,
      decl,
    });
  }

  private registerBuiltinTraits() {
    const selfRef: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: false };
    const bool_t: TypeKind = { tag: "bool" };
    const u64_t: TypeKind = { tag: "int", bits: 64, signed: false };
    const string_t: TypeKind = { tag: "string" };

    // Eq trait
    this.traits.set("Eq", {
      name: "Eq",
      supertraits: [],
      methods: new Map([
        ["eq", { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: bool_t, hasDefault: false }],
      ]),
    });

    // Hash trait
    this.traits.set("Hash", {
      name: "Hash",
      supertraits: [],
      methods: new Map([
        ["hash", { params: [{ name: "self", type: selfRef }], ret: u64_t, hasDefault: false }],
      ]),
    });

    // Clone trait
    this.traits.set("Clone", {
      name: "Clone",
      supertraits: [],
      methods: new Map([
        ["clone", { params: [{ name: "self", type: selfRef }], ret: { tag: "struct", name: "Self" }, hasDefault: false }],
      ]),
    });

    // Display trait
    this.traits.set("Display", {
      name: "Display",
      supertraits: [],
      methods: new Map([
        ["toString", { params: [{ name: "self", type: selfRef }], ret: string_t, hasDefault: false }],
      ]),
    });

    // Iterator marker trait. Milo has no associated types, so the element type can't be
    // named in the trait method — instead the iteration contract (`next(&mut Self):
    // Option<T>`) is checked structurally at each `for x in it` site (duck-typed on the
    // method). `impl Iterator for X {}` marks X as iterable so it satisfies an
    // `<I: Iterator>` bound and is nameable in prover contracts over "any iterator".
    this.traits.set("Iterator", { name: "Iterator", supertraits: [], methods: new Map() });

    // Operator traits
    const selfType: TypeKind = { tag: "struct", name: "Self" };
    for (const [traitName, methodName] of [["Add", "add"], ["Sub", "sub"], ["Mul", "mul"], ["Div", "div"]] as const) {
      this.traits.set(traitName, {
        name: traitName,
        supertraits: [],
        methods: new Map([
          [methodName, { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: selfType, hasDefault: false }],
        ]),
      });
    }

    // Drop trait — self: &mut Self
    const selfRefMut: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: true };
    this.traits.set("Drop", {
      name: "Drop",
      supertraits: [],
      methods: new Map([
        ["drop", { params: [{ name: "self", type: selfRefMut }], ret: { tag: "void" }, hasDefault: false }],
      ]),
    });

    // register primitive impls for Eq (checker-only, no codegen needed)
    const primTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "string"];
    for (const pt of primTypes) {
      const eqMethods = new Map<string, FnSig>();
      eqMethods.set("eq", { params: [{ type: selfRef, name: "self" }, { type: selfRef, name: "other" }], ret: bool_t, variadic: false });
      this.traitImpls.set(pt, [{ traitName: "Eq", typeName: pt, methods: eqMethods }]);
    }

    // Hash impls for hashable primitives
    const hashTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "bool", "string"];
    for (const pt of hashTypes) {
      const existing = this.traitImpls.get(pt) || [];
      const hashMethods = new Map<string, FnSig>();
      hashMethods.set("hash", { params: [{ type: selfRef, name: "self" }], ret: u64_t, variadic: false });
      existing.push({ traitName: "Hash", typeName: pt, methods: hashMethods });
      this.traitImpls.set(pt, existing);
    }
  }

  private substituteSelfInMiloType(ty: MiloType, concreteName: string): MiloType {
    if (ty.name === "Self") return { ...ty, name: concreteName };
    if (ty.typeArgs) return { ...ty, typeArgs: ty.typeArgs.map(a => this.substituteSelfInMiloType(a, concreteName)) };
    return ty;
  }

  private isExternStructType(ty: TypeKind): boolean {
    return ty.tag === "struct" && !!this.structs.get(ty.name)?.isExtern;
  }

  // The complete set of attributes the compiler acts on. Anything else used to be dropped
  // in silence, so a typo (`@clayout`, `@drive(Eq)`) looked like it worked while doing
  // nothing — the same silent-failure class @cLayout exists to close. Enums parse
  // attributes but nothing consumes them, so those are rejected rather than ignored.
  private static readonly KNOWN_ATTRS = attributesFor("struct");

  // `@cSig("unistd.h", "long sysconf(int)")` — the C signature is checked against the real
  // header at build time. Milo's type system can't express C type identity (is `i64` a
  // `long` or a `long long`? on macOS they're distinct types of the same width), so the
  // compiler cannot derive this — the declaration states it and the build verifies it.
  private checkCSig(f: Function, attr: Attribute): void {
    if (!f.isExtern) {
      this.error(`@cSig on '${f.name}': only an 'extern fn' has a C signature to verify`, undefined,
        `a Milo fn is compiled from this source — there's no foreign declaration to check it against`);
      return;
    }
    if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
      this.error(`@cSig on '${f.name}': expected two string arguments`, undefined,
        `write '@cSig("unistd.h", "int ${f.name}(int)")' — the header, then the C signature as the header spells it`);
      return;
    }
    const header = attr.args[0]!, sig = attr.args[1]!;
    if (!TypeChecker.isCHeaderSpec(header)) {
      this.error(`@cSig on '${f.name}': '${header}' is not a C header path`, undefined,
        `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'unistd.h'. Separate per-platform spellings with '|' when no one name is portable`);
      return;
    }
    if (!TypeChecker.C_SIG_RE.test(sig)) {
      this.error(`@cSig on '${f.name}': '${sig}' is not a C function signature`, undefined,
        `expected the declaration as C spells it — e.g. 'ssize_t ${f.name}(int, void *, size_t)'`);
      return;
    }
    if (!new RegExp(`(^|[^A-Za-z0-9_])${f.name}\\s*\\(`).test(sig)) {
      this.error(`@cSig on '${f.name}': the signature declares a different function`, undefined,
        `'${sig}' must name '${f.name}' — the assert is generated against that symbol`);
      return;
    }
    // Arity is checkable here, with no header in the picture: the guard TU compares C
    // parameter i against Milo parameter i, so a signature that lists a different number
    // of parameters than the decl would silently shift every comparison by one.
    const cArity = countCSigParams(sig);
    if (cArity !== null && !f.isVariadic && cArity !== f.params.length) {
      this.error(`@cSig on '${f.name}': the signature takes ${cArity} parameter${cArity === 1 ? "" : "s"}, the Milo declaration takes ${f.params.length}`, undefined,
        `'${sig}' and the 'extern fn' must describe the same call`);
      return;
    }
    this.cSigs.set(f.name, { header, sig });
  }

  // A `@cLayout`/`@cSig`/`@cValue` header argument: one path, or several separated by '|'
  // for a header C spells differently per platform (macOS 'OpenGL/gl3.h' vs
  // 'GL/glcorearb.h'). The guard TU takes the first that `__has_include` finds. A path may
  // be prefixed with '+'-separated feature macros the header needs before it declares
  // anything — 'GL_GLEXT_PROTOTYPES+GL/glcorearb.h'.
  private static isCHeaderSpec(spec: string): boolean {
    const alts = spec.split("|");
    if (alts.length === 0) return false;
    return alts.every(alt => {
      const parts = alt.split("+");
      const path = parts.pop();
      return path !== undefined && TypeChecker.C_HEADER_RE.test(path)
        && parts.every(f => TypeChecker.C_IDENT_RE.test(f));
    });
  }

  // `@cValue("SDL_PIXELFORMAT_ABGR8888", "SDL2/SDL.h")` pins a Milo constant to the C
  // macro or enumerator it transcribes. The guard TU compares the two, so the value has
  // to survive into generated C as a literal — hence the integer-literal restriction.
  private checkCValue(g: GlobalDecl, attr: Attribute, type: TypeKind): void {
    if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
      this.error(`@cValue on '${g.name}': expected two string arguments`, g.span,
        `write '@cValue("${g.name}", "SDL2/SDL.h")' — the C name, then the header that defines it`);
      return;
    }
    const cName = attr.args[0]!, header = attr.args[1]!;
    if (!TypeChecker.C_IDENT_RE.test(cName)) {
      this.error(`@cValue on '${g.name}': '${cName}' is not a C identifier`, g.span,
        `expected the macro or enumerator name as C spells it — e.g. 'SDL_INIT_VIDEO'`);
      return;
    }
    if (!TypeChecker.isCHeaderSpec(header)) {
      this.error(`@cValue on '${g.name}': '${header}' is not a C header path`, g.span,
        `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'SDL2/SDL.h'`);
      return;
    }
    if (g.mutable) {
      this.error(`@cValue on '${g.name}': a 'var' is not a constant, so there is nothing fixed to compare against C`, g.span,
        `declare it with 'let'`);
      return;
    }
    if (type.tag !== "int") {
      this.error(`@cValue on '${g.name}': only an integer constant can be checked against a C macro, got ${this.show(type)}`, g.span,
        `the guard compares the two with '==' in C, which needs an integer on both sides`);
      return;
    }
    // A computed initializer would have to be re-derived in C to compare it. Folding it
    // here instead would compare Milo's arithmetic against itself, which proves nothing
    // about the header — so require the literal the author actually transcribed.
    const v = g.value;
    const isIntLit = v.kind === "IntLit" || (v.kind === "UnaryOp" && v.op === "-" && v.operand.kind === "IntLit");
    if (!isIntLit) {
      this.error(`@cValue on '${g.name}': the initializer must be an integer literal`, g.span,
        `@cValue checks a transcribed constant against its header; an expression has nothing to transcribe`);
      return;
    }
    this.cValues.set(g.name, { cName, header });
  }

  // ── @pure ──────────────────────────────────────────────────────────────────────
  //
  // `@pure` narrows a function's effects to the ones its signature already shows: it
  // reads and writes its parameters and its own locals, and nothing else. It is not a
  // totality claim — a pure function can still trap (overflow, bounds, a failed
  // contract) or loop forever, the same way a bounds check can. What it rules out is
  // *ambient* effect: I/O, mutable module state, raw memory, and any call that could
  // reach one of those.
  //
  // Run as a post-pass rather than inside type checking because it needs the finished
  // call-resolution maps (`staticCalls`, `resolvedMethods`, the monomorphized
  // instances) to know what a given call site actually targets.

  // Built-in free functions with no ambient effect. An allowlist, not a denylist: a new
  // intrinsic has to be judged pure deliberately rather than inheriting it by default.
  // `assert` is here because trapping is not an effect under this definition.
  private static readonly PURE_BUILTINS = new Set(["format", "max", "min", "assert"]);

  // Does `fnName` KEEP its idx-th argument past the call? A fn-typed parameter that is
  // only ever CALLED is consumed during the call and is safe to hand a borrowing closure;
  // one that is stored, returned, or forwarded to something that stores it is not. The
  // distinction falls out of the AST for free: `g(1)` parses as `Call{func:"g"}` and
  // contributes no `Ident` node at all, so "appears as an Ident anywhere in the body" is
  // exactly "used as a value rather than called".
  //
  // This is the *property* the `sortByKey` carve-out approximates with a name (see
  // `keyExtractorDepth`) — computed here instead of annotated, which is why a user's own
  // non-retaining combinator gets the same treatment std's does.
  //
  // Every unknown answers YES: no body, an extern, a variadic slot past the declared
  // params, or a cycle in the forwarding graph. A wrong NO is a use-after-free.
  private retainsParam(fns: Map<string, Function>, fnName: string, idx: number, seen: Set<string>): boolean {
    const key = `${fnName}#${idx}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const fn = fns.get(fnName);
    if (!fn || fn.isExtern || !fn.body) return true;
    const param = fn.params[idx];
    if (!param) return true;
    let retained = false;
    const walk = (node: unknown): void => {
      if (retained || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string };
      if (n.kind === "Ident" && n.name === param.name) { retained = true; return; }
      // A closure that CAPTURES the parameter keeps it, and the walk above cannot see
      // that: the body spells the use `f(3)`, a `Call` with a string callee and no `Ident`
      // node anywhere. So `fn wrap(f) { return move (): i64 => f(3) }` answered "not
      // retained", the call site handed it a borrowing closure, and the returned `move`
      // closure carried a pointer into the dead frame — printed -1 for 8.
      if (n.kind === "Closure") {
        const caps = this.closureCaptures.get(n as unknown as Expr);
        if (caps?.some(c => c.name === param.name)) { retained = true; return; }
      }
      // Forwarding: `fn outer(g) { each(g) }` keeps `g` only if `each` does. Without this
      // a one-line wrapper would be indistinguishable from a store.
      if (n.kind === "Call" && Array.isArray(n.args)) {
        const args = n.args as Expr[];
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          if (a.kind === "Ident" && a.name === param.name) {
            if (this.retainsParam(fns, n.func as string, i, seen)) { retained = true; return; }
          } else walk(a);
        }
        return;
      }
      // The same forwarding through a METHOD call. Without this arm a MethodCall fell to
      // the structural walk below, which saw the bare `Ident` and marked the parameter
      // retained — so `fn w(f) { a.modify(h, f) }` was rejected while the identical
      // `fn w(f) { arenaModify(a, h, f) }` was accepted. That is over-rejection, not
      // unsoundness, but it walls off every wrapper around a std higher-order method.
      if (n.kind === "MethodCall" && Array.isArray(n.args)) {
        const args = n.args as Expr[];
        walk(n.object);
        // The builtins that store a fn value, the same set the call-site check reads.
        const storesIt = RETAINING_MEMBERS.has(n.method as string);
        const recv = this.exprTypes.get(n.object as Expr);
        const base = recv?.tag === "ref" ? recv.inner : recv;
        const owner = base && (base.tag === "struct" || base.tag === "enum") ? base.name : null;
        const mangled = owner ? `${owner}$${n.method}` : null;
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          if (a.kind === "Ident" && a.name === param.name) {
            if (storesIt) { retained = true; return; }
            // +1: the mangled method carries `self` as its first parameter.
            if (mangled && fns.has(mangled) && this.retainsParam(fns, mangled, i + 1, seen)) { retained = true; return; }
            // An unresolved receiver is waved through on the same reasoning the call
            // site uses: no builtin outside the `retainsArg` rows retains a fn value.
          } else walk(a);
        }
        return;
      }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
    };
    walk(fn.body);
    return retained;
  }

  // A closure that captures by reference is a pointer into the frame it was written in.
  // It is safe to CALL and unsafe to KEEP, so this pass rejects every route by which one
  // can outlive that frame. All five were live use-after-frees in safe code — silent
  // garbage at -O0, a hang or a SIGKILL at -O2, and invisible to ASan because the capture
  // lives on the stack:
  //
  //     Box { f: g }         store into an aggregate       (closed 2026-07-31)
  //     b.f = g              assign into a place
  //     wrap(g)              hand to a fn that keeps it
  //     wrap((x) => x + n)   the same, when the capture is a `var` — the call-site
  //                          auto-`move` declines there because move-capturing would
  //                          drop the write-back, so the literal escaped unpromoted
  //     return g             hand to the caller
  //
  // The last one used to be PROMOTED rather than rejected: the Return path flipped the
  // closure to `move` so its captures became heap-owned. That was unsound in a way the
  // reject is not, because the promotion happened at the `return` — after the move
  // checker had already walked the body. `let s = "…"; let f = () => s.len(); print(s);
  // return f` moved `s` into the closure's env at the LITERAL and printed an empty line
  // for `print(s)`, with no diagnostic. Rejecting needs no such retroactive edit.
  //
  // Rejecting needs no escape analysis either, which is the point: we cannot tell whether
  // an aggregate escapes, so we assume it does. `move` is the escape hatch — it works
  // even for a `var` capture, at the cost of dropping the write-back — and it is what
  // every diagnostic here names.
  // The finished program as the whole-program passes (purity, escaping closures, thread
  // boundary, global borrow invalidation) see it. Each pass used to rebuild these four
  // things inline, and the copies drifted: `rootOf` was the hand-rolled two-step walk
  // that `rootNameOf` exists to replace, and purity's callee lookup had a different
  // fallback chain from the other three (design pass 2026-09, F2).
  private programView(program: Program): ProgramView {
    // monomorphizedFns holds impl methods (mangled `Type$method`, `Type$Trait$method`)
    // and generic instances; program.functions holds free fns.
    const fns = new Map<string, Function>();
    for (const f of [...program.functions, ...this.monomorphizedFns]) fns.set(f.name, f);
    // `Type$method` reads as `Type.method`; a monomorphized `foo_i64` reads as `foo`.
    const asWritten = new Map<string, string>();
    for (const f of this.monomorphizedFns) if (f.sourceName) asWritten.set(f.name, f.sourceName);
    return {
      fns,
      // The three maps are keyed by disjoint node kinds (rewrittenCalls: Call and the
      // Promise.all/race EnumLit; staticCalls: EnumLit; resolvedMethods: MethodCall), so
      // the order is a union, not a priority.
      calleeOf: (e) =>
        this.rewrittenCalls.get(e) ?? this.staticCalls.get(e) ?? this.resolvedMethods.get(e) ??
        (e.kind === "Call" ? e.func : undefined),
      // Takes `unknown` because the passes walk raw AST nodes; anything that is not an
      // expression has no root. Total over the expression grammar via the place walker,
      // where the old inline loops knew only FieldAccess and IndexAccess: `G!.x = v` and
      // `G.slice(a, b)[i]` (a view into G) now root at `G` too, the fail-closed direction.
      rootOf: (e) => {
        if (!e || typeof e !== "object" || typeof (e as { kind?: unknown }).kind !== "string") return undefined;
        return this.rootNameOf(e as Expr) ?? undefined;
      },
      pretty: (n) => asWritten.get(n) ?? n.replace(/\$/g, "."),
    };
  }

  private checkEscapingClosures(program: Program, view: ProgramView): void {
    const seen = new Set<string>();
    const { fns } = view;
    const globals = new Set(program.globals.map(g => g.name));
    // Approximate scoping on purpose: one flat map per body, so a closure bound by
    // `let f = …` is still recognized when `f` is stored later. Shadowing can only make
    // this reject something it would otherwise allow, never the reverse.
    // Which frame-pointing captures does escaping `c` expose? For a borrowing closure that
    // is its own capture list. For a `move` closure it is normally EMPTY — owning the
    // captures is the whole point — but not when a capture is itself a borrowing closure:
    // moving a `{fn, env}` pair copies the pointer, and the env keeps pointing at the frame
    // the inner closure was written in. `let f = (x) => x + n; return move () => f(3)`
    // printed -1 for 8 through exactly that hole, so resolve through move captures until we
    // reach a borrowing closure or run out of bindings. A capture we cannot resolve here is
    // a fn-typed *parameter*; those are caught one frame up by `retainsParam`, which counts
    // a capture as retention.
    const borrowedCaps = (c: Expr, bound: Map<string, Expr>, visited: Set<Expr>): CaptureInfo[] => {
      if (visited.has(c)) return [];
      visited.add(c);
      const caps = this.closureCaptures.get(c) ?? [];
      if (!(c as Extract<Expr, { kind: "Closure" }>).isMove) return caps;
      const out: CaptureInfo[] = [];
      for (const cap of caps) {
        const inner = bound.get(cap.name);
        if (inner) out.push(...borrowedCaps(inner, bound, visited));
      }
      return out;
    };
    const check = (value: Expr, bound: Map<string, Expr>, message: (names: string) => string, holder: string) => {
      let c: Expr | null = null;
      if (value.kind === "Closure") c = value;
      else if (value.kind === "Ident") c = bound.get(value.name) ?? null;
      if (!c) return;
      const caps = borrowedCaps(c, bound, new Set());
      if (caps.length === 0) return;
      const span = value.span ?? c.span;
      const key = `${span?.line ?? 0}:${span?.col ?? 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      const names = caps.map(c => `'${c.name}'`).join(", ");
      const hint = (c as Extract<Expr, { kind: "Closure" }>).isMove
        ? `this closure is 'move', but it captures another closure that points at locals in the current frame — 'move' on the outer one copies that pointer, it does not own what it points at. Write the inner closure 'move (…) => …' too`
        : `this closure points at locals in the current frame, and ${holder} can outlive them — write 'move (…) => …' so the closure owns its captures instead`;
      this.error(message(names), span, hint);
    };
    const cannotStore = (names: string) => `cannot store a closure that captures ${names} by reference`;
    // Structural walk rather than a per-node switch: a missing arm here would silently
    // skip a whole subtree, which is exactly the class of bug this pass exists to close.
    const visit = (node: unknown, bound: Map<string, Expr>) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) visit(n, bound); return; }
      const n = node as Record<string, unknown> & { kind?: string };
      switch (n.kind) {
        case "LetDecl": case "VarDecl": {
          const v = n.value as Expr | undefined;
          if (v?.kind === "Closure") bound.set(n.name as string, v);
          // `let g = f` aliases the same closure. Without this the alias launders a
          // borrowing closure past every check below — `let g = f; return g` printed
          // garbage for exactly that reason.
          else if (v?.kind === "Ident" && bound.has(v.name)) bound.set(n.name as string, bound.get(v.name)!);
          break;
        }
        case "StructLit":
          for (const f of n.fields as { name: string; value: Expr }[]) check(f.value, bound, cannotStore, "the struct holding it");
          break;
        case "ArrayLit":
          for (const el of n.elements as Expr[]) check(el, bound, cannotStore, "the array holding it");
          break;
        case "ArrayRepeat":
          check(n.value as Expr, bound, cannotStore, "the array holding it");
          break;
        case "Return":
          if (n.value) check(n.value as Expr, bound,
            names => `cannot return a closure that captures ${names} by reference`, "the caller");
          break;
        case "Assign": {
          // Assigning to a bare local is fine — the local dies with the same frame the
          // captures live in. A field, an element, or a global is a place that outlives it.
          const t = n.target as Expr;
          const where = t.kind === "FieldAccess" ? "the struct holding it"
            : t.kind === "IndexAccess" ? "the collection holding it"
            : t.kind === "Ident" && globals.has(t.name) ? "a global"
            : null;
          if (where) check(n.value as Expr, bound, cannotStore, where);
          break;
        }
        case "Call": {
          const args = n.args as Expr[];
          for (let i = 0; i < args.length; i++) {
            if (!this.retainsParam(fns, n.func as string, i, new Set())) continue;
            check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${n.func}', which keeps it`,
              `'${n.func}'`);
          }
          break;
        }
        case "EnumLit": {
          // `Promise.blocking(...)`, `Task.spawn(...)`, and every other `Type.method(...)`
          // parse as EnumLit, not Call/MethodCall, so the two arms below never saw them and
          // a borrowing closure crossed a real OS thread as a raw pointer into the frame
          // that wrote it. `var n = 41; Promise.blocking(() => { n = n + 1; return n })`
          // returned 8421921353 from a dead stack.
          const args = n.args as Expr[];
          if (args.length === 0) break;
          const who = `${n.enumName}.${n.variant}`;
          const mangled = this.staticCalls.get(node as Expr);
          for (let i = 0; i < args.length; i++) {
            // No resolved target means an enum VARIANT constructor (which stores its
            // payload) or a builtin: treated as retaining, on retainsParam's own rule that
            // every unknown answers YES because a wrong NO is a use-after-free. The only
            // args this can reject are closures, so fail-closed costs nothing else.
            if (mangled && fns.has(mangled) && !this.retainsParam(fns, mangled, i, new Set())) continue;
            check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${who}', which keeps it`,
              `'${who}'`);
          }
          break;
        }
        case "MethodCall": {
          // The collection-storing methods. A closure passed to `map`/`each`/`sortBy` is
          // called and dropped within the call, so those stay legal — that is the common
          // case and rejecting it would gut the combinators. No builtin outside the
          // `retainsArg` rows retains a fn value, which is what makes the unresolved case
          // below safe to wave through; a builtin that starts retaining one gets the flag.
          if (RETAINING_MEMBERS.has(n.method as string)) {
            for (const a of n.args as Expr[]) check(a, bound, cannotStore, "the collection holding it");
            break;
          }
          // A user-defined method resolves to the mangled `Type$method` and gets the same
          // retention analysis a free function does.
          const recv = this.exprTypes.get(n.object as Expr);
          const base = recv?.tag === "ref" ? recv.inner : recv;
          const owner = base && (base.tag === "struct" || base.tag === "enum") ? base.name : null;
          if (!owner) break;
          const mangled = `${owner}$${n.method}`;
          if (!fns.has(mangled)) break;
          const args = n.args as Expr[];
          for (let i = 0; i < args.length; i++) {
            // +1: the mangled method carries `self` as its first parameter.
            if (!this.retainsParam(fns, mangled, i + 1, new Set())) continue;
            check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${owner}.${n.method}', which keeps it`,
              `'${owner}.${n.method}'`);
          }
          break;
        }
        default:
          // Deliberately partial, and safe because of the line below: this switch only
          // ADDS knowledge for the few node kinds that can let a closure escape. Every
          // other kind is still descended into structurally, so nothing is skipped.
          break;
      }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") visit(n[k], bound); }
    };
    for (const fn of [...program.functions, ...this.monomorphizedFns]) {
      if (fn.isExtern || !fn.body) continue;
      visit(fn.body, new Map<string, Expr>());
    }
  }

  private checkPurity(program: Program, view: ProgramView): void {
    const pureNames = new Set<string>();
    const bodies: Function[] = [];
    // A generic declaration is registered as pure but not walked — its instances are what
    // call sites resolved to, and they are the copies whose expressions carry resolution
    // data.
    for (const f of view.fns.values()) {
      if (!f.attributes?.some(a => a.name === "pure")) continue;
      pureNames.add(f.name);
      if (!f.isExtern && f.typeParams.length === 0) bodies.push(f);
    }
    if (bodies.length === 0) return;

    const mutableGlobals = new Set(program.globals.filter(g => g.mutable).map(g => g.name));
    // Every instance of a pure generic walks the same source span, so the same violation
    // would be reported once per instantiation.
    const seen = new Set<string>();
    const { pretty } = view;

    for (const fn of bodies) {
      const who = fn.sourceName ?? pretty(fn.name);
      const fail = (msg: string, span: Span | undefined, hint: string, key?: string) => {
        const k = key ?? `${span?.line ?? 0}:${span?.col ?? 0}:${msg}`;
        if (seen.has(k)) return;
        seen.add(k);
        this.error(msg, span, hint);
      };

      const checkCall = (target: string, span: Span | undefined) => {
        if (pureNames.has(target) || TypeChecker.PURE_BUILTINS.has(target)) return;
        const sig = this.functions.get(target);
        if (!sig) {
          // No registered signature: a compiler builtin (`Vec.new`, `v.len()`). Those act
          // only on the data handed to them, so they are pure by construction — the ones
          // that are not (`print`, `exit`, the `_milo*`/`_atomic*` intrinsics) do have a
          // registered signature and fall through to the impure branch below.
          return;
        }
        if (sig.isExtern) {
          fail(`'${who}' is @pure but calls extern fn '${pretty(target)}'`, span,
            `an extern's body is compiled elsewhere, so nothing here can check it — write '@pure extern fn ${target}(...)' to assert it has no effects, or drop '@pure' from '${who}'`);
          return;
        }
        fail(`'${who}' is @pure but calls '${pretty(target)}', which is not`, span,
          `purity is transitive — mark '${pretty(target)}' '@pure' too, or drop '@pure' from '${who}'`);
      };

      const ex = (e: Expr | null | undefined, bound: Set<string>): void => {
        if (!e) return;
        switch (e.kind) {
          case "Ident":
            if (mutableGlobals.has(e.name) && !bound.has(e.name)) {
              // One report per global per function: `g = g + 1` is a read and a write of
              // the same mistake, and repeating it per mention buries the fix.
              fail(`'${who}' is @pure but touches the mutable global '${e.name}'`, e.span,
                `a @pure fn reads and writes only its parameters and its own locals — pass '${e.name}' in as a parameter, or make it a 'let'`,
                `${fn.name}|global|${e.name}`);
            }
            break;
          case "Call":
            // A call through a value (closure, fn-typed param, C function pointer) has no
            // static target, and purity is not part of a fn type yet.
            if (this.closureCalls.has(e) || this.cfnCalls.has(e)) {
              fail(`'${who}' is @pure but calls the function value '${e.func}'`, e.span,
                `purity is not part of a fn type, so the compiler cannot see what this call does — call a named @pure fn instead`);
            } else {
              checkCall(view.calleeOf(e) ?? e.func, e.span);
            }
            e.args.forEach(a => ex(a, bound));
            break;
          case "EnumLit": {
            // Static method calls (`Math.sqrt(x)`) parse as EnumLit and are resolved into
            // staticCalls; without an entry this is ordinary enum construction.
            const target = view.calleeOf(e);
            if (target) checkCall(target, e.span);
            e.args.forEach(a => ex(a, bound));
            break;
          }
          case "MethodCall": {
            const iface = this.interfaceMethodCalls.get(e);
            if (iface) {
              fail(`'${who}' is @pure but calls '${e.method}' through the interface '${iface.ifaceName}'`, e.span,
                `dynamic dispatch hides which body runs, and purity is not part of an interface method's signature`);
            } else if (this.fnFieldCalls.has(e) || this.cfnFieldCalls.has(e)) {
              fail(`'${who}' is @pure but calls the fn-typed field '${e.method}'`, e.span,
                `purity is not part of a fn type, so the compiler cannot see what this call does`);
            } else {
              const target = view.calleeOf(e);
              if (target) checkCall(target, e.span);
            }
            ex(e.object, bound);
            e.args.forEach(a => ex(a, bound));
            break;
          }
          case "BinOp": ex(e.left, bound); ex(e.right, bound); break;
          case "UnaryOp": ex(e.operand, bound); break;
          case "FieldAccess": ex(e.object, bound); break;
          case "IndexAccess": ex(e.object, bound); ex(e.index, bound); break;
          case "StructLit": e.fields.forEach(f => ex(f.value, bound)); break;
          case "ArrayLit": e.elements.forEach(el => ex(el, bound)); break;
          case "ArrayRepeat": ex(e.value, bound); break;
          case "Unwrap": case "Propagate": ex(e.operand, bound); break;
          case "DefaultValue": ex(e.operand, bound); ex(e.default, bound); break;
          case "CastExpr": ex(e.operand, bound); break;
          case "Closure": {
            // The body runs inside this fn, so its effects are this fn's effects.
            const inner = new Set(bound);
            for (const p of e.params) inner.add(p.name);
            st(e.body, inner);
            break;
          }
          case "RangeExpr": ex(e.start, bound); ex(e.end, bound); break;
          case "IsExpr": ex(e.operand, bound); break;
          case "IfExpr": ex(e.cond, bound); st(e.thenBody, new Set(bound)); st(e.elseBody, new Set(bound)); break;
          case "MatchExpr": ex(e.subject, bound); e.arms.forEach(a => st(a.body, bindPattern(a.pattern, bound))); break;
          case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
            break;
          default: {
            // A missing arm would silently skip a whole subtree — the same failure mode
            // that let the safety walker report "pass" on code it never looked at.
            const _exhaustive: never = e;
            void _exhaustive;
          }
        }
      };

      const bindPattern = (p: import("./ast").Pattern, bound: Set<string>): Set<string> => {
        const inner = new Set(bound);
        if (p.kind === "EnumPattern") for (const b of p.bindings) inner.add(b);
        return inner;
      };

      const st = (list: Stmt[], outer: Set<string>): void => {
        const bound = new Set(outer);
        for (const s of list) {
          switch (s.kind) {
            // Walk the initializer before binding the name: in `let x = x + 1` the
            // right-hand `x` is still whatever `x` meant outside.
            case "LetDecl": case "VarDecl": ex(s.value, bound); bound.add(s.name); break;
            case "Assign": ex(s.target, bound); ex(s.value, bound); break;
            case "Return": ex(s.value, bound); break;
            case "ExprStmt": ex(s.expr, bound); break;
            case "IfStmt": ex(s.cond, bound); st(s.thenBody, bound); if (s.elseBody) st(s.elseBody, bound); break;
            case "WhileStmt": ex(s.cond, bound); st(s.body, bound); break;
            case "ForInStmt": {
              ex(s.iterable, bound);
              const inner = new Set(bound);
              inner.add(s.varName);
              if (s.varName2) inner.add(s.varName2);
              st(s.body, inner);
              break;
            }
            case "MatchStmt": ex(s.subject, bound); s.arms.forEach(a => st(a.body, bindPattern(a.pattern, bound))); break;
            case "IfLetStmt":
              ex(s.subject, bound);
              st(s.thenBody, bindPattern(s.pattern, bound));
              if (s.elseBody) st(s.elseBody, bound);
              break;
            case "LetElseStmt":
              ex(s.value, bound);
              st(s.elseBody, bound);
              // The bind escapes into the enclosing scope — that is the point of let-else.
              if (s.pattern.kind === "EnumPattern") for (const b of s.pattern.bindings) bound.add(b);
              break;
            case "UnsafeBlock":
              fail(`'${who}' is @pure but contains an 'unsafe' block`, s.span,
                `raw memory access is exactly the ambient effect '@pure' rules out`);
              st(s.body, bound);
              break;
            case "BreakStmt": case "ContinueStmt": break;
            default: {
              const _exhaustive: never = s;
              void _exhaustive;
            }
          }
        }
      };

      st(fn.body, new Set(fn.params.map(p => p.name)));
    }
  }

  // Which functions hand a closure to a real OS thread? They say so themselves, with
  // `@thread` on the declaration in std. The two hardcoded copies this replaces had
  // already drifted apart: the `Thread` tier was deleted and its arm stayed behind
  // guarding a type that no longer exists, while `spawnOsThreadDetached` — added after
  // both — never got an arm, so the *same* fixture that errors on `Promise.blocking`
  // compiled clean and shipped a pointer into a dead frame to another thread. A list the
  // declarations own cannot drift from the declarations.
  private checkThreadBoundary(program: Program, view: ProgramView): void {
    const { fns, rootOf, calleeOf: target } = view;
    const isEntry = (target: string | undefined) =>
      !!target && !!fns.get(target)?.attributes?.some(a => a.name === "thread");
    if (![...fns.values()].some(f => f.attributes?.some(a => a.name === "thread"))) return;

    // A `var` global is unsynchronized shared memory, and `Sync` is the wrong question to
    // ask about it: `i64` is perfectly Sync — sharing `&i64` is safe — while the hazard
    // here is the *write*, which Sync says nothing about. The synchronized way to hold
    // shared mutable state is already a `let` global of a cell that mutates through
    // `&self` (AtomicI64, Channel, Once), so `var` plus a thread is always the bug, and
    // the optimizer makes it worse than it looks: a whole loop of `g = g + 1` gets hoisted
    // into a single load/store pair, losing every update but the last rather than a few.
    const mutableGlobals = new Set<string>();
    for (const g of program.globals) if (g.mutable && !g.threadLocal) mutableGlobals.add(g.name);
    // `@synchronized` marks a method whose closure argument is a critical section — the
    // primitive itself provides the mutual exclusion and the happens-before edge, so a
    // global written in there is not racing. Without this the canonical `Once.run(...)`
    // one-shot-init pattern reports as a race, which is the reverse of the truth: it is
    // the *fix* for one. The scan below stops at the boundary rather than reasoning about
    // the primitive, so a new one only has to declare itself.
    const isCriticalSection = (target: string | undefined) =>
      !!target && !!fns.get(target)?.attributes?.some(a => a.name === "synchronized");

    const reported = new Set<string>();

    // Reports every unsynchronized global reachable from `closure`, following static calls
    // so a touch three helpers deep still names the thread it escaped to. Approximate
    // scoping on purpose, same as checkEscapingClosures: one flat bound-name set per body,
    // which can only make this miss a shadowed global, never invent one.

    // Two phases over one reachable set, because reads and writes are not equally guilty.
    // A *write* reached without crossing a critical section races on its own. A *read*
    // only races if some write is also unsynchronized: `Once.run` publishes `gValue`, and
    // every later read of it is ordered by that publication, so flagging the read would
    // reject the very pattern that fixes the race.
    type Touch = { name: string; span: Span | undefined; chain: string[]; write: boolean };
    const scan = (closure: Expr, entry: string) => {
      const touches: Touch[] = [];
      const done = new Set<string>();
      const walk = (node: unknown, bound: Set<string>, chain: string[]) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const n of node) walk(n, bound, chain); return; }
        const n = node as Record<string, unknown> & { kind?: string; name?: unknown; span?: unknown };
        const span = (n.span as Span | undefined) ?? closure.span;
        if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);

        const hit = (name: string | undefined, write: boolean) => {
          if (!name || !mutableGlobals.has(name) || bound.has(name)) return;
          touches.push({ name, span, chain, write });
        };
        if (n.kind === "Assign") hit(rootOf(n.target), true);
        // `G.push(x)` is a write that never appears as an Assign. A `&self` method is not
        // — `gOnce.run(...)` is the Once synchronizing itself, and `Sync` is the wrong
        // question to ask here anyway: `Vec<i64>` is perfectly Sync and `push` still
        // reallocs it.
        if (n.kind === "MethodCall") hit(rootOf(n.object), this.mutatesReceiver(n as unknown as Expr));
        if (n.kind === "Ident" && typeof n.name === "string") hit(n.name, false);

        // A call through a value (closure, fn-typed param, C function pointer) has no static
        // target, so the walk cannot see whether it touches a global: the check below is
        // incomplete exactly here. The @pure walker errors in this situation, but doing that
        // rejected `rg.milo` and the Once fixture (a callback that touches nothing), so this
        // is an off-by-default warning until fn values with a statically known target are
        // resolved through. Skipped entirely when the program has no mutable globals, since
        // then an opaque call cannot reach one.
        if (mutableGlobals.size > 0 && n.kind === "Call"
            && (this.closureCalls.has(n as unknown as Expr) || this.cfnCalls.has(n as unknown as Expr))) {
          const key = `${entry}|indirect|${span?.line ?? 0}:${span?.col ?? 0}`;
          if (!reported.has(key)) {
            reported.add(key);
            this.warn("opaque-call-on-thread",
              `cannot tell whether this call touches a mutable global, and it runs on a real OS thread`,
              span,
              `a call through a function value has no static target, so nothing here can see what it does. ` +
              `Call a named function instead, or make the globals it may touch atomics from 'std/sync'`,
            );
          }
        }
        if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
          const t = target(n as unknown as Expr);
          if (isCriticalSection(t)) {
            // Stop at the boundary: everything the closure argument does is serialized by
            // the primitive. Its receiver and non-closure args are still ordinary code.
            for (const k of Object.keys(n)) {
              if (k === "span" || k === "args") continue;
              walk(n[k], bound, chain);
            }
            for (const a of (n.args as Expr[] | undefined) ?? []) if (a.kind !== "Closure") walk(a, bound, chain);
            return;
          }
          if (t && !done.has(t)) {
            done.add(t);
            const f = fns.get(t);
            if (f && !f.isExtern && f.body) walk(f.body, new Set(f.params.map(p => p.name)), [...chain, t]);
          }
        }
        // A nested closure body runs on the same thread, so the generic descent walks in.
        for (const k of Object.keys(n)) if (k !== "span") walk(n[k], bound, chain);
      };
      walk((closure as Extract<Expr, { kind: "Closure" }>).body, new Set(), []);

      const racy = new Set(touches.filter(t => t.write).map(t => t.name));
      for (const t of touches) {
        if (!racy.has(t.name)) continue;
        // One report per global per thread entry: `g = g + 1` is a read and a write of
        // the same mistake, and repeating it per mention buries the fix.
        const key = `${entry}|${t.name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const where = t.chain.length ? ` (via ${t.chain.map(c => `'${c.replace(/\$/g, ".")}'`).join(" → ")})` : "";
        this.error(
          `'${t.name}' is a mutable global, and this code runs on a real OS thread${where}`,
          t.span,
          `two threads touching one unsynchronized global is a data race — make '${t.name}' an ` +
          `atomic from 'std/sync' (AtomicI64/AtomicBool/AtomicI32/AtomicU64), do the mutation inside ` +
          `'Once.run', or write 'thread_local var ${t.name}' if each thread should get its own copy`,
        );
      }
    };


    const atEntry = (call: Expr, entry: string) => {
      for (const arg of (call as { args?: Expr[] }).args ?? []) {
        if (arg.kind !== "Closure") continue;
        for (const cap of this.closureCaptures.get(arg) ?? []) {
          if (this.isSend(cap.type)) continue;
          this.error(
            `cannot send '${cap.name}' of type '${this.show(cap.type)}' across threads — type does not implement Send`,
            arg.span, this.whyNotSend(cap.type));
        }
        scan(arg, entry);
      }
    };

    const findCalls = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) findCalls(n); return; }
      const n = node as Record<string, unknown> & { kind?: string };
      if (n.kind === "Call" || n.kind === "EnumLit") {
        const t = target(n as unknown as Expr);
        if (isEntry(t)) atEntry(n as unknown as Expr, t!);
      }
      for (const k of Object.keys(n)) if (k !== "span") findCalls(n[k]);
    };
    for (const f of fns.values()) if (f.body) findCalls(f.body);
    for (const g of program.globals) findCalls(g.value);
  }

  // Which globals does each function transitively write? The aliasing model is keyed to
  // locals, params and self, so a `var` global mutated inside a callee is invisible to it
  // and three heap-use-after-frees fell straight through: `for x in G { grow() }` where
  // grow() pushes to G, the same with `G = Vec.new()`, and plain `use(G[0])` where use()
  // reallocs G. No threads involved — this is single-threaded aliasing, a different axis
  // from checkThreadBoundary, but it needs the same summary, so both read this one.
  // Does this method call mutate its receiver? Built-in collection mutators are a fixed
  // list; a user method declares it by taking `&mut self`.
  private mutatesReceiver(call: Expr): boolean {
    const m = (call as Extract<Expr, { kind: "MethodCall" }>).method;
    if (MUTATING_COLLECTION_METHODS.has(m)) return true;
    const t = this.resolvedMethods.get(call) ?? this.rewrittenCalls.get(call);
    const self = t ? this.functions.get(t)?.params?.[0]?.type : undefined;
    return !!self && self.tag === "ref" && self.mutable;
  }

  // `parks` rides the same call graph: a fn may park the current green task if it carries
  // `@parks` or calls one that may. Stops at the declared boundary, so the scheduler's
  // internals are never modelled here.
  private globalWriteSummary(view: ProgramView, mutableGlobals: Set<string>): { writes: Map<string, Set<string>>; parks: Set<string> } {
    const { fns, rootOf, calleeOf: target } = view;

    const writes = new Map<string, Set<string>>();
    const callees = new Map<string, Set<string>>();
    for (const [name, f] of fns) {
      const w = new Set<string>();
      const c = new Set<string>();
      const bound = new Set<string>(f.params.map(p => p.name));
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const n of node) walk(n); return; }
        const n = node as Record<string, unknown> & { kind?: string; name?: unknown };
        if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
        const note = (r: string | undefined) => { if (r && mutableGlobals.has(r) && !bound.has(r)) w.add(r); };
        if (n.kind === "Assign") note(rootOf(n.target));
        if (n.kind === "MethodCall" && this.mutatesReceiver(n as unknown as Expr)) {
          // `G.push(x)` never appears as an Assign but reallocs G's buffer.
          note(rootOf(n.object));
        }
        if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
          const t = target(n as unknown as Expr);
          if (t) c.add(t);
        }
        for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
      };
      if (f.body) walk(f.body);
      writes.set(name, w);
      callees.set(name, c);
    }
    const parks = new Set<string>();
    for (const [name, f] of fns) if (f.attributes?.some(a => a.name === "parks")) parks.add(name);
    // Least fixpoint over the call graph. Recursion just stops adding on the round where
    // nothing new propagates, so no explicit cycle guard is needed.
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, cs] of callees) {
        const w = writes.get(name)!;
        for (const t of cs) {
          for (const g of writes.get(t) ?? []) if (!w.has(g)) { w.add(g); changed = true; }
          if (parks.has(t) && !parks.has(name)) { parks.add(name); changed = true; }
        }
      }
      // FFI re-entry: C code can call back into any `@externalLinkage` fn, so once one
      // of those may park, every extern call may park too (the walk cannot see which C
      // routine reaches which callback). Coarse on purpose; today no such fn parks.
      if (!changed && [...fns.values()].some(f => parks.has(f.name) && f.attributes?.some(a => a.name === "externalLinkage"))) {
        for (const [name, f] of fns) if (f.isExtern && !parks.has(name)) { parks.add(name); changed = true; }
      }
    }
    return { writes, parks };
  }

  // An arena that is read but never freed, where a tier exists that would make the
  // read infallible. See docs/ownership-patterns.md, pattern 2.
  //
  // `Arena.get` returns `Option<T>` because a slot can be freed and reused, so a stale
  // handle must be catchable. A program that never frees is unwrapping an Option that
  // cannot be None at every call site, and `sealGrowth()` removes exactly the operation
  // it is paying for while still allowing `alloc`.
  //
  // Keyed to a LOCAL arena so the whole of its life is visible here: an arena reaching
  // this function as a parameter may well be freed by its owner, and guessing otherwise
  // would be advice that is wrong more often than right.
  private lintArenaNeverFrees(program: Program): void {
    if (this.warningConfig.allowed.has("arena-never-frees")) return;
    for (const f of [...program.functions]) {
      if (!f.body) continue;
      if (inModule(f.sourceFile, "std/arena")) continue;
      // name -> declaration span, for locals declared as an Arena
      const locals = new Map<string, Span | undefined>();
      const frees = new Set<string>();
      const reads = new Set<string>();
      const receiver = (n: Record<string, unknown>): string | undefined => {
        const o = n.object as Record<string, unknown> | undefined;
        return o && o.kind === "Ident" && typeof o.name === "string" ? o.name : undefined;
      };
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const n of node) walk(n); return; }
        const n = node as Record<string, unknown> & { kind?: string; name?: unknown; method?: unknown; span?: unknown };
        if ((n.kind === "VarDecl" || n.kind === "LetDecl") && typeof n.name === "string") {
          const t = n.type as { name?: string } | undefined;
          if (t?.name === "Arena") locals.set(n.name, n.span as Span | undefined);
        }
        if (n.kind === "MethodCall" && typeof n.method === "string") {
          const r = receiver(n);
          if (r) {
            if (n.method === "free" || n.method === "clear") frees.add(r);
            // Handing the arena on by value, or sealing it, ends our view of its life.
            if (n.method === "freeze" || n.method === "sealGrowth") frees.add(r);
            if (n.method === "get" || n.method === "valid") reads.add(r);
          }
        }
        // Passed to a function: its callee may free it, so stop guessing.
        if (n.kind === "Call") {
          for (const a of (n.args as Expr[] | undefined) ?? []) {
            if (a.kind === "Ident" && typeof a.name === "string") frees.add(a.name);
          }
        }
        for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
      };
      walk(f.body);
      for (const [name, span] of locals) {
        if (frees.has(name) || !reads.has(name)) continue;
        this.warn("arena-never-frees",
          `'${name}' is never freed, so every 'get' unwraps an Option that cannot be None`,
          span,
          `'${name}.sealGrowth()' gives an infallible 'get' and keeps 'alloc'; ` +
          `'${name}.freeze()' also gives up 'alloc'. See docs/ownership-patterns.md.`);
      }
    }
  }

  // Rejects a call that writes a global while a borrow into that same global is live.
  // Two shapes, both heap-use-after-free before this: iterating a global while a callee
  // reallocs or replaces it, and passing a place rooted at a global to a function that
  // reallocs that global under the reference it was just handed.
  //
  // The same walk applies the cross-task rule: an element view of a mutable global may
  // not be live across a call that may park the current green task. The callee need not
  // write anything itself; while the task is parked ANY other task can push to the global
  // and free the buffer the view points into. `for x in g { schedulerYield() }` printed
  // freed memory before this. Element views are the for-in binding, a slice binding, and
  // a `&`/`&[T]` argument into the global; a `&mut` to the global's header itself is not
  // one (the header outlives a realloc, the buffer does not) and stays legal.
  private checkGlobalBorrowInvalidation(program: Program, view: ProgramView): void {
    const mutableGlobals = new Set<string>();
    for (const g of program.globals) if (g.mutable) mutableGlobals.add(g.name);
    if (mutableGlobals.size === 0) return;
    const { fns, rootOf, calleeOf: target, pretty } = view;
    const { writes, parks } = this.globalWriteSummary(view, mutableGlobals);
    const reported = new Set<string>();
    const report = (msg: string, span: Span | undefined, hint: string) => {
      const key = `${span?.line ?? 0}:${span?.col ?? 0}:${msg}`;
      if (reported.has(key)) return;
      reported.add(key);
      this.error(msg, span, hint);
    };

    // A `&[T]` parameter is a fat pointer into the argument's buffer, so even the bare
    // global is an element view there; only `&Vec<T>`/`&mut Vec<T>` name the header.
    const isSliceParam = (t: { isRef: boolean; isRefMut: boolean; isArray: boolean; arraySize: number | null } | undefined) =>
      !!t && (t.isRef || t.isRefMut) && t.isArray && t.arraySize === null;
    const parkHint = (g: string) =>
      `iterate by index ('while i < ${g}.len'), snapshot first ('${g}.clone()'), or move the global into a value the task owns`;

    for (const f of fns.values()) {
      if (!f.body) continue;
      const bound = new Set<string>(f.params.map(p => p.name));
      // Globals whose storage is borrowed by an enclosing for-in. A loop iterand is a
      // reference into the container's buffer, so anything that reallocs or replaces the
      // container leaves it dangling for the rest of the iteration.
      //
      // `views` are element views into a global held by a binding that stays live to the
      // end of its block: a reference binding (`let s = g[a..b]`, or a method returning
      // `&[T]` from a receiver rooted at g) or a raw pointer binding (`let p = g.ptr()`,
      // `let c = Cfg { buf: g.cstr() }`; `pointerViewsIn` is the same recognizer the
      // freeze machinery uses, so this walk and `bindPointerViews` agree on what a pointer
      // view is). A statement list is walked in order and each such binding extends the
      // context for the statements after it. Decided by the binding's checked type, not
      // its spelling, so every way of producing a view counts (`g[a..b]` itself parses as
      // `g.slice(a, b)`). `via` names the pointer call for the diagnostic; a ref view has none.
      type View = { name: string; global: string; via?: string };
      const viewsOf = (n: Record<string, unknown> & { kind?: string; name?: unknown }): View[] => {
        if ((n.kind !== "LetDecl" && n.kind !== "VarDecl") || typeof n.name !== "string") return [];
        const v = n.value as Expr | undefined;
        if (!v) return [];
        const name = n.name;
        const isGlobal = (g: string | undefined): g is string => !!g && mutableGlobals.has(g) && !bound.has(g);
        if (this.exprTypes.get(v)?.tag === "ref") {
          const g = rootOf(v.kind === "MethodCall" ? v.object : v);
          return isGlobal(g) ? [{ name, global: g }] : [];
        }
        const out: View[] = [];
        for (const pv of this.pointerViewsIn(v)) {
          const g = rootOf(pv.source);
          if (isGlobal(g)) out.push({ name, global: g, via: `${pv.call}' on line ${pv.line}` });
        }
        return out;
      };
      const describeView = (v: View) => v.via
        ? `'${v.name}' still points into '${v.global}'s buffer (from '${v.via})`
        : `'${v.name}' is a view into '${v.global}'s buffer`;
      const walk = (node: unknown, iterated: string[], views: View[]) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          let live = views;
          for (const n of node) {
            walk(n, iterated, live);
            const vs = viewsOf(n as Record<string, unknown> & { kind?: string; name?: unknown });
            if (vs.length > 0) live = [...live, ...vs];
          }
          return;
        }
        const n = node as Record<string, unknown> & { kind?: string; name?: unknown; span?: unknown };
        const span = n.span as Span | undefined;
        if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);

        if (n.kind === "ForInStmt") {
          const g = rootOf(n.iterable);
          const next = g && mutableGlobals.has(g) && !bound.has(g) ? [...iterated, g] : iterated;
          walk(n.iterable, iterated, views);
          walk(n.body, next, views);
          return;
        }

        if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
          const t = target(n as unknown as Expr);
          const callArgs = (n.args as Expr[] | undefined) ?? [];
          const callee = t ? fns.get(t) : undefined;
          // A method call carries its receiver as params[0]; anything that does not
          // line up leaves paramOffset -1 and the check stays fail-closed.
          const paramOffset = !callee ? -1
            : callee.params.length === callArgs.length ? 0
            : callee.params.length === callArgs.length + 1 ? 1
            : -1;
          if (t && parks.has(t)) {
            for (const g of iterated) {
              report(
                `'${pretty(t)}' can park this task while the loop variable is a reference into '${g}'s buffer; another task may push to '${g}' before it resumes`,
                span,
                parkHint(g),
              );
            }
            for (const v of views) {
              if (iterated.includes(v.global)) continue;
              report(
                `'${pretty(t)}' can park this task while ${describeView(v)}; another task may push to '${v.global}' before it resumes`,
                span,
                parkHint(v.global),
              );
            }
            // `use(g[0])` / `sum(g)` into a `&[T]`: the argument is a view into g's buffer
            // for as long as the callee runs, and the callee parks.
            for (const [argIdx, a] of callArgs.entries()) {
              // A slice expression is already a reference whatever the parameter says;
              // it roots at its receiver (`g[a..b]` parses as `g.slice(a, b)`). An inline
              // `g.ptr()` is a view for the duration of the call in the same way.
              const ptrView = this.pointerViewsIn(a)[0];
              const isViewArg = this.exprTypes.get(a)?.tag === "ref" || ptrView !== undefined;
              const g = ptrView ? rootOf(ptrView.source) : rootOf(isViewArg && a.kind === "MethodCall" ? a.object : a);
              if (!g || !mutableGlobals.has(g) || bound.has(g)) continue;
              if (iterated.includes(g) || views.some(v => v.global === g)) continue;
              const prm = paramOffset >= 0 ? callee!.params[argIdx + paramOffset] : undefined;
              const isElement = ((): boolean => {
                let cur = a as unknown as Record<string, unknown> & { kind?: string };
                while (cur && typeof cur === "object") {
                  if (cur.kind === "IndexAccess") return true;
                  if (cur.kind === "FieldAccess") { cur = cur.object as typeof cur; continue; }
                  return false;
                }
                return false;
              })();
              if (!isViewArg) {
                if (prm?.type) {
                  if (!isSliceParam(prm.type) && !(isElement && (prm.type.isRef || prm.type.isRefMut))) continue;
                } else if (!isElement) continue;
              }
              report(
                `'${pretty(t)}' can park this task while it holds a reference into '${g}'s buffer; another task may push to '${g}' before it resumes`,
                (a.span as Span | undefined) ?? span,
                parkHint(g),
              );
            }
          }
          const w = t ? writes.get(t) : undefined;
          if (t && w) {
            for (const g of iterated) {
              if (!w.has(g)) continue;
              report(
                `'${pretty(t)}' writes the global '${g}', which is being iterated here`,
                span,
                `the loop variable is a reference into '${g}'s buffer — pushing to it, clearing it, or ` +
                `reassigning it from inside the loop frees that buffer and leaves the reference dangling. ` +
                `Iterate a copy ('for x in ${g}.clone()'), or collect the changes and apply them after the loop`,
              );
            }
            // `let p = g.ptr(); writer()` (or a slice binding) where `writer` pushes to g:
            // the callee frees the buffer the binding points into (h4-global-callee-push).
            // The main pass cannot see a write made inside another function, and this
            // walk is the one place that knows both the live views and the write summary.
            for (const v of views) {
              if (!w.has(v.global) || iterated.includes(v.global)) continue;
              report(
                `'${pretty(t)}' writes the global '${v.global}' while ${describeView(v)}`,
                span,
                `pushing to, clearing or reassigning '${v.global}' frees the buffer '${v.name}' points into: ` +
                `take '${v.name}' after the call, or end its block before it`,
              );
            }
            for (const a of callArgs) {
              for (const pv of this.pointerViewsIn(a)) {
                const g = rootOf(pv.source);
                if (!g || !mutableGlobals.has(g) || bound.has(g) || !w.has(g)) continue;
                if (iterated.includes(g) || views.some(v => v.global === g)) continue;
                report(
                  `'${pretty(t)}' writes the global '${g}', and is passed '${pv.call}' here`,
                  (a.span as Span | undefined) ?? span,
                  `the pointer is into '${g}'s buffer, and '${pretty(t)}' can realloc or replace '${g}' while it holds it: take the pointer inside '${pretty(t)}', or have it not write '${g}'`,
                );
              }
            }
            // `use(G[0])` — the argument is a reference into G's storage and the callee
            // reallocs G, so the reference dies before the callee is done with it.
            //
            // Two things have to be true for that to dangle, and checking only that the
            // argument MENTIONS the global rejected two safe shapes that a real program
            // (milojs) is built out of:
            //
            //   - the path has to reach the global's HEAP interior. `G` and `G.field`
            //     name storage at the global's own fixed address, which no realloc moves
            //     and which reassigning G overwrites in place; only an index step reaches
            //     a buffer that can be freed under the reference.
            //   - the PARAMETER has to be a reference. A by-value parameter materialises
            //     its argument before the callee runs, so nothing of the global's is
            //     still borrowed while the callee writes.
            const reachesHeapInterior = (e: unknown): boolean => {
              let cur = e as Record<string, unknown> & { kind?: string };
              while (cur && typeof cur === "object") {
                if (cur.kind === "IndexAccess") return true;
                if (cur.kind === "FieldAccess") { cur = cur.object as typeof cur; continue; }
                return false;
              }
              return false;
            };
            for (const [argIdx, a] of callArgs.entries()) {
              const g = rootOf(a);
              if (!g || !mutableGlobals.has(g) || bound.has(g) || !w.has(g)) continue;
              if (iterated.includes(g)) continue;
              if (!reachesHeapInterior(a)) continue;
              if (paramOffset >= 0) {
                const prm = callee!.params[argIdx + paramOffset];
                if (prm && prm.type && !prm.type.isRef && !prm.type.isRefMut) continue;
              }
              report(
                `'${pretty(t)}' writes the global '${g}', and is passed a reference into '${g}' here`,
                (a.span as Span | undefined) ?? span,
                `the argument borrows '${g}'s storage, and '${pretty(t)}' can realloc or replace '${g}' ` +
                `while that borrow is live — pass a copy, or have '${pretty(t)}' take '${g}' by value`,
              );
            }
          }
        }
        for (const k of Object.keys(n)) if (k !== "span") walk(n[k], iterated, views);
      };
      walk(f.body, [], []);
    }
  }

  // `@copy` is a claim with one meaning: this struct holds a raw pointer it does not own.
  // On a struct with no pointer field it is a no-op that lies about why the type is Copy,
  // so it is rejected rather than ignored. A generic template is judged on its declared
  // field types (`*T`, `*u8`), since a bare `T` may or may not become a pointer.
  private validateCopyAttr(s: StructDecl, attr: Attribute, program: Program) {
    if (attr.args && attr.args.length > 0) {
      this.error(`'@copy' on '${s.name}' takes no arguments`, s.span,
        `write '@copy' on its own line above the struct`);
    }
    if (s.attributes?.some(a => a.name === "noCopy")) {
      this.error(`'@copy' and '@noCopy' on '${s.name}' contradict each other`, s.span,
        `'@copy' keeps a pointer-holding struct Copy; '@noCopy' makes a struct move-tracked. Keep the one that says who owns the resource`);
      return;
    }
    if (program.impls.some(i => i.traitName === "Drop" && i.typeName === s.name)) {
      this.error(`'@copy' on '${s.name}' contradicts its Drop impl: a type with a destructor is never Copy`, s.span,
        `a Drop impl means the value owns something to release, which is exactly what '@copy' denies. Drop the attribute`);
      return;
    }
    const isPtrType = (t: MiloType): boolean => t.isPtr || (t.ptrDepth ?? 0) > 0;
    const pointerField = s.typeParams.length > 0
      ? s.fields.find(f => isPtrType(f.type))?.name
      : rawPointerField(this.structs.get(s.name)?.fields ?? []);
    if (!pointerField) {
      this.error(`'@copy' on '${s.name}' does nothing: no field of it is a raw pointer`, s.span,
        `'@copy' keeps a struct Copy although it holds a raw pointer it does not own. A struct with no pointer field is already Copy when its fields are, so drop the attribute`);
      return;
    }
    // The census of pointer-carrying Copy structs, as a lint. Off by default: every
    // `@copy` in the tree was placed on purpose. `--deny=unowned-pointer-copy` lists them,
    // so an audit can re-ask each one the question the attribute answered.
    this.warn("unowned-pointer-copy",
      `'${s.name}' is @copy and holds a raw pointer ('${pointerField}'): a copy of it shares whatever the pointer addresses`,
      s.span,
      `this is what '@copy' asks for. Confirm that '${s.name}' does not own the pointee (a C-owned record, a view into a buffer another value owns); if it does, remove '@copy' so the struct is move-tracked`);
  }

  // `@copyOnly` constrains type parameters, so on a declaration without any it would be
  // a claim about nothing; say so rather than accept an annotation that does no work.
  private validateCopyOnly(declName: string, attr: Attribute, typeParams: string[], span?: Span): void {
    attr.args.forEach((arg, i) => {
      if (attr.argKinds?.[i] !== "ident" || !typeParams.includes(arg)) {
        this.error(`'@copyOnly(${arg})' on '${declName}': '${arg}' is not one of its type parameters`, span,
          typeParams.length > 0
            ? `it declares ${typeParams.map(t => `'${t}'`).join(", ")}; write '@copyOnly' bare to constrain all of them`
            : `write '@copyOnly' on a generic declaration`);
      }
    });
    if (typeParams.length === 0) {
      this.error(`'@copyOnly' on '${declName}': it has no type parameters to constrain`, span,
        `'@copyOnly' restricts what a generic's type parameters may be instantiated with; a concrete type has none, so drop the attribute`);
    }
  }

  private validateAttributes(declName: string, attrs: Attribute[] | undefined, target: "struct" | "enum"): void {
    if (!attrs) return;
    const known = TypeChecker.KNOWN_ATTRS.map(a => `@${a}`).join(", ");
    for (const attr of attrs) {
      if (!TypeChecker.KNOWN_ATTRS.includes(attr.name)) {
        this.error(`unknown attribute '@${attr.name}' on '${declName}'`, undefined, `known attributes: ${known}`);
      } else if (target === "enum") {
        this.error(`'@${attr.name}' is not supported on enums — '${declName}'`, undefined,
          `only structs consume attributes today; on an enum it would be silently ignored`);
      }
    }
  }

  // `@cLayout("struct stat", "sys/stat.h")` — the declared layout is checked against the
  // real header at build time. Both args are pasted into a generated C translation unit,
  // so they're constrained to a charset that can't escape the `#include <...>` or the
  // type position and inject arbitrary C.
  private static readonly C_TYPE_RE = /^(struct |union |enum )?[A-Za-z_][A-Za-z0-9_]*$/;
  private static readonly C_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  private static readonly C_HEADER_RE = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*\.h$/;
  // `@link("SDL2")` / `@link("framework:OpenGL")`. Reaches a shell command line, so no
  // spaces, quotes, semicolons, backticks, or `$` — see the check in validateAttributes.
  private static readonly LINK_NAME_RE = /^(framework:)?[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
  // A C function signature, pasted verbatim into a generated TU — so it's held to a
  // charset that can't close the assert and inject statements. Allows what real decls
  // need (`ssize_t f(int, void *, size_t)`, `struct tm *g(const time_t *)`, `void h(void)`,
  // and `...` for variadics like `int open(const char *, int, ...)`) and nothing else:
  // no quotes, no semicolons, no braces, no backslashes, no newlines.
  private static readonly C_SIG_RE = /^[A-Za-z_][A-Za-z0-9_ .,*()[\]]*\)$/;

  // An `extern struct` with no `@cLayout` is an unverified claim about a C type, and it
  // looks exactly like a verified one — which is the whole failure mode `@cLayout` exists
  // to close, still open by default. So say so once, at the declaration.
  //
  // Only for structs in the file being compiled: you can't annotate a struct inside a
  // library you imported, and warning about one is noise you can't act on. Same reasoning
  // as the unused-unsafe lint. `entryFile` is unset when the checker is driven directly
  // (tests/tools), which correctly means "everything is user code".
  // libc symbols that are variadic in the real headers on BOTH darwin and linux.
  // Declaring one of these with fixed arity compiles clean and silently calls it with the
  // wrong ABI: on AArch64 a variadic callee reads its variadic args off the stack, while a
  // fixed-arity call passes them in registers, so the callee sees garbage. It is silent
  // because on x86_64 the two conventions coincide for integer args — the code "works"
  // until it meets an ARM64 machine.
  //
  // This cost node-milo hours: `fcntl(fd, F_SETFL, flags)` declared fixed-arity meant
  // O_NONBLOCK never landed, so every socket in the runtime stayed blocking and the bug
  // surfaced as a throughput mystery, not as a bad declaration. Milo already has the `...`
  // syntax and std/platform declares fcntl correctly; nothing checked that anyone else did.
  //
  // Conservative on purpose: only names whose variadic-ness is not in dispute. `execl`,
  // `execlp` and `execle` are NUL-terminated variadic lists; `syscall`, `ioctl`, `fcntl`,
  // `open`/`openat` take a mode/arg only for some commands; the printf/scanf families are
  // variadic by definition.
  // name → how many parameters are FIXED in the C prototype (everything after is `...`).
  // The count is what matters, not the name: `open(const char *, int, ...)` declared with
  // exactly its 2 fixed params is fine (no variadic arg is ever passed), while
  // `fcntl(int, int, ...)` declared with 3 absorbs the variadic arg into a fixed one and
  // is the bug. Getting this wrong in either direction misplaces an argument.
  private static readonly VARIADIC_LIBC = new Map<string, number>([
    ["fcntl", 2], ["open", 2], ["openat", 3], ["ioctl", 2], ["syscall", 1],
    ["printf", 1], ["fprintf", 2], ["sprintf", 2], ["snprintf", 3], ["dprintf", 2],
    ["scanf", 1], ["fscanf", 2], ["sscanf", 2],
    ["execl", 2], ["execlp", 2], ["execle", 2],
  ]);

  private checkVariadicExtern(fn: Function): void {
    if (!fn.isExtern) return;
    const fixed = TypeChecker.VARIADIC_LIBC.get(fn.name);
    if (fixed === undefined) return;
    if (this.entryFile && fn.span?.file && fn.span.file !== this.entryFile) return;

    const why = `On AArch64 a variadic callee reads its variadic args off the stack while a ` +
      `fixed-arity call passes them in registers, so the callee sees garbage. x86_64 hides this ` +
      `(the conventions agree for integer args), which is why it survives testing.`;

    if (!fn.isVariadic && fn.params.length > fixed) {
      this.error(
        `extern '${fn.name}' declares ${fn.params.length} fixed parameters but C fixes only ${fixed} — ` +
        `the rest are variadic, so this miscompiles silently on AArch64`,
        fn.span,
        `declare it 'extern fn ${fn.name}(<${fixed} fixed param(s)>,...): ...' and pass the rest as variadic args. ${why}`);
      return;
    }
    if (fn.isVariadic && fn.params.length !== fixed) {
      this.error(
        `extern '${fn.name}' declares ${fn.params.length} fixed parameter(s) before '...' but C fixes ${fixed}`,
        fn.span,
        `a parameter on the wrong side of the '...' is passed in the wrong place. ${why}`);
    }
  }

  // The `extern fn` half of the same lint. A signature is as much an unverified claim as a
  // layout is, and the pointer parameters are the worse half: a wrong field offset reads
  // garbage, a wrong pointee width lets the callee write past what the caller reserved.
  private warnUnverifiedExternFn(fn: Function): void {
    if (!fn.isExtern) return;
    if (fn.attributes?.some(a => a.name === "cSig")) return;
    if (this.entryFile && fn.span?.file && fn.span.file !== this.entryFile) return;
    const ptrParam = fn.params.find(p => declaredType(p).isPtr);
    const why = ptrParam
      ? `'${ptrParam.name}' is a pointer C writes through, so its pointee width is part of the contract and nothing checks it`
      : `parameter and return widths are a claim about C that nothing checks`;
    this.warn("unverified-extern",
      `extern fn '${fn.name}' has no @cSig — its signature is an unverified claim about C`,
      fn.span,
      `${why}. Add '@cSig("some/header.h", "<the declaration as C spells it>")'`);
  }

  private warnUnverifiedExtern(s: StructDecl): void {
    if (!s.isExtern || s.isOpaque) return;              // opaque types have no fields to verify
    if (s.attributes?.some(a => a.name === "cLayout")) return;
    if (this.entryFile && s.span?.file && s.span.file !== this.entryFile) return;
    this.warn("unverified-extern",
      `extern struct '${s.name}' has no @cLayout — its layout is an unverified claim about C`,
      s.span,
      `add '@cLayout("struct ${s.name.toLowerCase()}", "some/header.h")' to check the field offsets against the real header at build time`);
  }

  // `@cOpaque` marks a field as filler with no C counterpart, so @cLayout skips it —
  // needed for structs padded out to a size C dictates (getrusage writes 144 bytes into
  // a struct whose named fields only cover 32). It still counts toward Milo's own layout,
  // so the size assert stays meaningful. `@json("name")` renames a field on the wire.
  // Anything else on a field is rejected: a silently ignored attribute is the failure
  // this whole feature exists to close.
  private validateFieldAttributes(s: StructDecl): void {
    let iterFields = 0;
    const derivesJson = s.attributes?.some(a => a.name === "derive" && a.args.includes("Json")) ?? false;
    for (const f of s.fields) {
      if (!f.attributes) continue;
      for (const attr of f.attributes) {
        if (attr.name === "iter") {
          if (attr.args.length !== 0) {
            this.error(`@iter on '${s.name}.${f.name}': takes no arguments`, s.span);
          }
          // The delegate must itself be something `for-in` knows how to walk. A
          // second one would make `for x in wrapper` ambiguous with no way to say
          // which you meant, so one per struct.
          if (++iterFields > 1) {
            this.error(`'${s.name}' has more than one @iter field`, s.span,
              `a struct iterates exactly one field — mark only the container that 'for x in ${s.name.toLowerCase()}' should walk`);
          }
          // Read the written type rather than resolving it: on a generic decl the
          // field's type arguments are still type parameters, and resolving
          // `HashMap<T, bool>` here would report T as an unhashable key.
          const ft = f.type;
          const iterable = !ft.isRef && !ft.isRefMut && !ft.isPtr &&
            (ft.isArray || ft.name === "Vec" || ft.name === "HashMap" || ft.name === "string");
          if (!iterable) {
            this.error(`@iter on '${s.name}.${f.name}': '${ft.name}' is not iterable`, s.span,
              `mark a Vec, HashMap, array, or string field`);
          }
        } else if (attr.name === "json") {
          // Arity and content are validated in deriveJson, where the error can
          // name the generated codec. Here only the "nothing consumes it" case.
          if (!derivesJson) {
            this.error(`@json on '${s.name}.${f.name}': the struct does not derive Json`, s.span,
              `add '@derive(Json)' to '${s.name}', or drop the field attribute — nothing else reads it`);
          }
        } else if (attr.name !== "cOpaque") {
          this.error(`'@${attr.name}' is not supported on a struct field — '${s.name}.${f.name}'`, s.span,
            `only '@cOpaque', '@iter' and '@json' apply to a field`);
        } else if (!s.isExtern) {
          this.error(`@cOpaque on '${s.name}.${f.name}': only an 'extern struct' field can be C-invisible`, s.span,
            `a Milo struct has no C layout to be opaque against`);
        } else if (attr.args.length !== 0) {
          this.error(`@cOpaque on '${s.name}.${f.name}': takes no arguments`, s.span);
        }
      }
    }
  }

  private checkCLayout(s: StructDecl, attr: Attribute): void {
    if (!s.isExtern || s.isOpaque) {
      this.error(`@cLayout on '${s.name}': only 'extern struct' has a C layout to verify`, undefined,
        `@cLayout checks declared field offsets against a C header — a Milo struct has no C counterpart`);
      return;
    }
    if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
      this.error(`@cLayout on '${s.name}': expected two string arguments`, undefined,
        `write '@cLayout("struct ${s.name.toLowerCase()}", "some/header.h")' — the C type name and the header declaring it`);
      return;
    }
    const cType = attr.args[0]!, header = attr.args[1]!;
    if (!TypeChecker.C_TYPE_RE.test(cType)) {
      this.error(`@cLayout on '${s.name}': '${cType}' is not a C type name`, undefined,
        `expected something like 'struct stat', 'mytypedef_t', or 'union sigval'`);
      return;
    }
    if (!TypeChecker.isCHeaderSpec(header)) {
      this.error(`@cLayout on '${s.name}': '${header}' is not a C header path`, undefined,
        `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'sys/stat.h'`);
      return;
    }
    const info = this.structs.get(s.name);
    if (info) info.cLayout = { cType, header };
  }

  // extern-struct fields must be plain-old-data: scalars, raw pointers, nested extern
  // structs, or fixed arrays of those. Strings/Vecs/enums carry drop glue or a non-C
  // layout, so an extern struct built from them could never round-trip through C.
  private isValidExternStructField(ty: TypeKind): boolean {
    switch (ty.tag) {
      case "int": case "float": case "bool": case "ptr": return true;
      case "array": return ty.size !== null && this.isValidExternStructField(ty.element);
      case "struct": { const info = this.structs.get(ty.name); return !!info && !!info.isExtern; }
      case "cfn": return this.isCReprFnSig(ty);
      default: return false;
    }
  }

  // Inside an `extern struct`, `(A, B) => R` names the C spelling: one thin code
  // pointer, not the `{ code, environment }` pair a Milo fn value carries. `cfn` is
  // already exactly that type (it lowers to a bare `ptr`), so the rewrite happens
  // once here and layout, the @cLayout guard TU, headergen and the call site all see
  // the right thing with no context-sensitive special case of their own. A `move`
  // closure type keeps its `fn` tag deliberately: it owns a heap environment, which
  // is the one thing a C field cannot hold, so it falls through to the
  // not-C-representable error instead of being silently thinned.
  private thinFnField(isExtern: boolean | undefined, t: TypeKind): TypeKind {
    if (!isExtern || t.tag !== "fn" || t.owning) return t;
    return { tag: "cfn", params: t.params, ret: t.ret };
  }

  // What may be stored in a C function-pointer field, and the whole reason the set is
  // this small: the field is one word, so a value that is not already one word has to
  // lose half of itself on the way in. A top-level `fn` name is the code pointer with
  // nothing attached; another such field is a pointer copy. Everything else carries an
  // environment C has nowhere to put.
  //
  // Returns true when it has handled the value (accepted or reported); false to let the
  // caller raise its ordinary type-mismatch error.
  private checkCFnStore(value: Expr, expected: TypeKind & { tag: "cfn" }, valType: TypeKind, where: string, sp?: Span): boolean {
    if (valType.tag === "cfn") {
      if (typeEq(expected, valType)) { this.strandedCFnReads.delete(value); return true; }
      return false;
    }
    if (valType.tag !== "fn") return false;
    // ident-ok: the accepted form IS a bare top-level function name; anything else is
    // a value with an environment and is rejected below.
    if (value.kind === "Ident" && this.functions.has(value.name) && this.lookup(value.name) === null) {
      const thin: TypeKind = { tag: "cfn", params: valType.params, ret: valType.ret };
      if (typeEq(expected, thin)) return true;
      this.error(`${where}: '${value.name}' has signature ${this.show(thin)}, expected ${this.show(expected)}`, sp);
      return true;
    }
    this.error(`${where}: only a top-level 'fn' can be stored in a C function-pointer field`, sp,
      `a closure value is a { code, environment } pair and this field holds only the code pointer, so the environment would be lost and the C call would read garbage — name a top-level function instead`);
    return true;
  }

  // Fail-closed report for every C function-pointer field read that no legal context
  // consumed. See `strandedCFnReads`.
  private reportStrandedCFnReads(): void {
    for (const [, info] of this.strandedCFnReads) {
      this.error(`'${info.struct}.${info.field}' is a C function pointer and cannot be used as a value`, info.span,
        `there are two things to do with one: call it ('s.${info.field}(...)', inside 'unsafe'), or test it with 'isNull(s.${info.field})'`);
    }
    this.strandedCFnReads.clear();
  }

  // A C function pointer's own parameters and return have to cross the ABI too. A
  // nested fn type is excluded: inside a signature there is no field declaration to
  // thin it, so it would be Milo's fat pair again and the C caller would disagree
  // about the argument count.
  private isCReprFnSig(ty: { params: TypeKind[]; ret: TypeKind }): boolean {
    const ok = (t: TypeKind) => t.tag !== "fn" && t.tag !== "cfn" && this.isValidExternStructField(t);
    return ty.params.every(ok) && (ty.ret.tag === "void" || ok(ty.ret));
  }

  // What may appear in an extern fn signature (by value). `&T` and `*T` cross by
  // reference and are always fine; a struct crosses by value only if it's `extern struct`;
  // enums and regular structs have no stable C representation. Returns an error to raise, or null.
  private externSigError(ty: TypeKind, role: "parameter" | "return type"): { msg: string; hint?: string } | null {
    switch (ty.tag) {
      case "int": case "float": case "bool": case "ptr": case "ref": case "string": return null;
      case "void": return role === "return type" ? null : { msg: `extern function parameter cannot be void` };
      case "array":
        return ty.size !== null && this.isValidExternStructField(ty.element)
          ? null : { msg: `${role} '${this.show(ty)}' has no stable C representation` };
      case "struct": {
        const info = this.structs.get(ty.name);
        if (!info) return { msg: `unknown type '${ty.name}' in extern ${role}` };
        if (!info.isExtern)
          return { msg: `struct '${ty.name}' crosses the C ABI by value but is not declared 'extern struct'`,
                   hint: `declare '${ty.name}' as 'extern struct', or pass it by reference (&${ty.name})` };
        return null;
      }
      case "enum":
        return { msg: `enum '${ty.name}' cannot cross the C ABI (no stable representation)`,
                 hint: `pass a pointer (*${ty.name}) or an integer tag instead` };
      case "fn":
        // fn-ptr callbacks are fine unless they themselves pass a struct by value (out of scope)
        for (const p of ty.params)
          if (p.tag === "struct")
            return { msg: `function-pointer ${role} passes struct '${p.name}' by value`,
                     hint: `by-value structs in callbacks aren't supported — pass a pointer` };
        return ty.ret.tag === "struct"
          ? { msg: `function-pointer ${role} returns struct '${(ty.ret as any).name}' by value`,
              hint: `by-value structs in callbacks aren't supported — return a pointer` }
          : null;
      default:
        return { msg: `${role} '${this.show(ty)}' is not valid in an extern function signature` };
    }
  }

  private registerImpl(impl: import("./ast").ImplDecl, program: Program, implFnsToCheck: Function[]) {
    const typeName = impl.typeName;

    if (impl.traitName === "Send" || impl.traitName === "Sync") {
      if (!impl.isUnsafe) {
        this.error(`manual '${impl.traitName}' implementation for '${typeName}' must be unsafe`, impl.span,
          `write 'unsafe impl ${impl.traitName} for ${typeName} {}' because the compiler cannot verify this promise`);
        return;
      }
      if (impl.methods.length > 0) {
        this.error(`unsafe impl '${impl.traitName}' for '${typeName}' is a marker and cannot define methods`, impl.span);
        return;
      }
      if (!this.structs.has(typeName) && !this.genericStructs.has(typeName)) {
        this.error(`unsafe impl '${impl.traitName}' requires a struct type, got '${typeName}'`, impl.span);
        return;
      }
      (impl.traitName === "Send" ? this.sendTypes : this.syncTypes).add(typeName);
      return;
    }
    if (impl.isUnsafe) {
      this.error(`unsafe impl is only supported for the Send and Sync marker traits`, impl.span);
      return;
    }

    // 'addrOf' is the built-in universal raw address-of operator (x.addrOf(): *T).
    // Reserve the name so `x.addrOf()` means exactly one thing everywhere — a
    // user method of the same name would be silently shadowed (context-dependent
    // dispatch), which is the ambiguity this design exists to remove.
    for (const m of impl.methods) {
      if (m.name === "addrOf")
        this.error(`'addrOf' is a reserved method name — it is the built-in raw address-of operator ('x.addrOf(): *T'). Rename this method.`, m.span ?? impl.span);
      // Method attributes were silently dropped before they could be parsed at all;
      // reject the unknown ones here so a typo can't look like it took effect.
      for (const attr of m.attributes ?? []) {
        if (!attributesFor("method").includes(attr.name)) {
          this.error(`'@${attr.name}' is not supported on methods — '${typeName}.${m.name}'`, m.span ?? impl.span,
            `only ${attributesFor("method").map(a => `'@${a}'`).join(", ")} apply to a method`);
        } else if (attr.args.length > 0) {
          this.error(`'@${attr.name}' takes no arguments`, m.span ?? impl.span,
            `write '@${attr.name}' on the line above 'fn ${m.name}'`);
        } else if (attr.name === "copyOut" && !(impl.typeParams && impl.typeParams.length > 0 && !impl.traitName)) {
          this.error(`'@copyOut' on '${typeName}.${m.name}': only a method of a generic inherent impl can be withheld per instantiation`, m.span ?? impl.span,
            impl.traitName ? `a trait impl's method set is fixed by the trait; move the copying method to 'impl ${typeName} { ... }'`
              : `'${typeName}' has no type parameters, so there is no instantiation to withhold it from`);
        }
      }
    }

    // generic impl — store as template, instantiate per monomorphization. Trait impls
    // included: a generic trait impl with a body (e.g. `impl Drop for Foo<T>`) can't be
    // checked against the base name (not a concrete struct); deferring to per-mono means
    // the body is checked, and the trait registered (dropImpls etc.), against the real
    // mangled struct — see monomorphizeStruct, which preserves traitName when instantiating.
    if (impl.typeParams && impl.typeParams.length > 0) {
      const existing = this.genericImpls.get(typeName) || [];
      if (!existing.some(e => e.impl === impl)) {
        existing.push({ impl, program });
        this.genericImpls.set(typeName, existing);
      }
      return;
    }

    if (impl.traitName) {
      const trait = this.traits.get(impl.traitName);
      if (!trait) {
        this.error(`unknown trait '${impl.traitName}'`, impl.span);
        return;
      }

      // check for duplicate impl
      const existing = this.traitImpls.get(typeName) || [];
      if (existing.some(i => i.traitName === impl.traitName)) {
        this.error(`duplicate impl '${impl.traitName}' for '${typeName}'`, impl.span);
        return;
      }

      // Drop-specific validations
      if (impl.traitName === "Drop") {
        const builtins = ["string", "Vec", "Heap", "HashMap"];
        if (builtins.includes(typeName)) {
          this.error(`cannot impl Drop for built-in type '${typeName}'`, impl.span);
          return;
        }
        if (!this.structs.has(typeName) && !this.enums.has(typeName)) {
          this.error(`impl Drop requires a struct or enum type, got '${typeName}'`, impl.span);
          return;
        }
        this.dropImpls.add(typeName);
      }

      // check supertraits
      for (const sup of trait.supertraits) {
        if (!existing.some(i => i.traitName === sup)) {
          this.error(`impl '${impl.traitName}' for '${typeName}' requires impl '${sup}' for '${typeName}'`, impl.span);
        }
      }

      // validate all required methods are present
      const implMethodNames = new Set(impl.methods.map(m => m.name));
      for (const [mName, mInfo] of trait.methods) {
        if (!mInfo.hasDefault && !implMethodNames.has(mName)) {
          this.error(`impl '${impl.traitName}' for '${typeName}': missing required method '${mName}'`, impl.span);
        }
      }

      // register each method as a concrete function
      const methods = new Map<string, FnSig>();
      for (const m of impl.methods) {
        const traitMethod = trait.methods.get(m.name);
        if (!traitMethod) {
          this.error(`method '${m.name}' is not defined in trait '${impl.traitName}'`, impl.span);
          continue;
        }
        // A trait method with its OWN type parameters is a template, exactly as an inherent
        // one is. Keyed without the trait name so the call site — which knows only the
        // receiver type and the method name — can find it; two traits declaring the same
        // generic method on one type is the ambiguity `resolveMethod` already rejects, and
        // it is rejected here too rather than letting one silently win.
        if (m.typeParams && m.typeParams.length > 0) {
          const key = `${typeName}$${m.name}`;
          if (this.genericMethods.has(key)) {
            this.error(`ambiguous generic method '${m.name}' on '${typeName}' — implemented by more than one trait`, m.span ?? impl.span);
          } else {
            this.genericMethods.set(key, {
              decl: {
                ...m,
                name: `${typeName}$${impl.traitName}$${m.name}`,
                params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(declaredType(p), typeName) })),
                retType: this.substituteSelfInMiloType(m.retType, typeName),
              },
              owner: typeName,
            });
          }
          continue;
        }
        const mangled = `${typeName}$${impl.traitName}$${m.name}`;
        const concreteFn: Function = {
          ...m,
          name: mangled,
          params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(declaredType(p), typeName) })),
          retType: this.substituteSelfInMiloType(m.retType, typeName),
        };
        const params = concreteFn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
        const ret = this.resolve(concreteFn.retType);
        this.functions.set(mangled, { params, ret, variadic: false });
        methods.set(m.name, { params, ret, variadic: false });
        this.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }

      // register default methods that weren't overridden
      for (const [mName, mInfo] of trait.methods) {
        if (mInfo.hasDefault && !implMethodNames.has(mName)) {
          const traitDecl = program.traits.find(t => t.name === impl.traitName)!;
          const traitMethod = traitDecl.methods.find(m => m.name === mName)!;
          const mangled = `${typeName}$${impl.traitName}$${mName}`;
          const concreteFn: Function = {
            kind: "Function",
            name: mangled,
            typeParams: [],
            params: traitMethod.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(declaredType(p), typeName) })),
            retType: this.substituteSelfInMiloType(traitMethod.retType, typeName),
            contracts: [],
            body: traitMethod.body!,
            isExtern: false,
            isVariadic: false,
          };
          const params = concreteFn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          methods.set(mName, { params, ret, variadic: false });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
      }

      existing.push({ traitName: impl.traitName, typeName, methods });
      this.traitImpls.set(typeName, existing);
    } else {
      // inherent impl
      if (this.inherentImpls.has(typeName)) {
        // merge methods into existing
        const existing = must(this.inherentImpls, typeName, "inherent impls");
        for (const m of impl.methods) {
          const mangled = `${typeName}$${m.name}`;
          const concreteFn: Function = {
            ...m,
            name: mangled,
            params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(declaredType(p), typeName) })),
            retType: this.substituteSelfInMiloType(m.retType, typeName),
          };
          const params = concreteFn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          existing.methods.set(m.name, { params, ret, variadic: false, contracts: m.contracts });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
      } else {
        const methods = new Map<string, FnSig>();
        for (const m of impl.methods) {
          const mangled = `${typeName}$${m.name}`;
          const concreteFn: Function = {
            ...m,
            name: mangled,
            params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(declaredType(p), typeName) })),
            retType: this.substituteSelfInMiloType(m.retType, typeName),
          };
          // A method with its own type parameters is a template, not a signature. Checking
          // its body here would type `R` as a struct nobody declared; the call site
          // instantiates it instead.
          if (m.typeParams && m.typeParams.length > 0) {
            this.genericMethods.set(mangled, { decl: concreteFn, owner: typeName });
            continue;
          }
          const params = concreteFn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          methods.set(m.name, { params, ret, variadic: false, contracts: m.contracts });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
        this.inherentImpls.set(typeName, { traitName: null, typeName, methods });
      }
    }
  }

  // Check a call against an already-resolved concrete method and record the symbol codegen
  // must emit. Shared by the two paths that resolve a method by instantiating it rather
  // than by looking it up: a generic method (`fn map<R>`) and a blanket container impl
  // (`impl Trait for Vec<T>`). The ordinary path is not routed through here because it
  // carries the `json` auto-stringify special case, which neither of these can reach.
  private dispatchMangledMethod(expr: Extract<Expr, { kind: "MethodCall" }>, mangled: string, sp?: Span): TypeKind {
    const sig = must(this.functions, mangled, "instantiated method");
    const selfParam = sig.params[0];
    if (selfParam?.type.tag === "ref") {
      if (selfParam.type.mutable) {
        this.errorIfFrozen(expr.object, `call '${expr.method}' on`, sp);
        this.errorIfCopyBind(expr.object, expr.method, sp);
      }
      this.autoBorrowed.set(expr.object, { mutable: selfParam.type.mutable });
    } else {
      this.tryMove(expr.object);
    }
    if (expr.args.length !== sig.params.length - 1) {
      this.error(`'${expr.method}' expects ${sig.params.length - 1} argument(s), got ${expr.args.length}`, sp);
    }
    for (let i = 0; i < expr.args.length; i++) {
      const expected = sig.params[i + 1];
      if (!expected) break;
      const bare = expected.type.tag === "ref" ? expected.type.inner : expected.type;
      const argType = this.checkExprWithHint(expr.args[i]!, bare);
      if (!typeEq(bare, argType) && argType.tag !== "unknown") {
        this.error(`'${expr.method}' argument ${i + 1}: expected ${this.show(bare)}, got ${this.show(argType)}`, expr.args[i]!.span);
      }
      if (expected.type.tag === "ref") this.setAutoBorrowChecked(expr.args[i]!, expected.type.mutable, sp);
      else this.tryMove(expr.args[i]!);
    }
    this.resolvedMethods.set(expr, mangled);
    return this.setType(expr, sig.ret);
  }

  // `impl Trait for Vec<T>` — a blanket impl on a BUILTIN container.
  //
  // These parse and land in `genericImpls` under the bare name "Vec", and nothing
  // instantiated them: `monomorphizeStruct` is what instantiates a generic impl, and a
  // builtin container is not a struct, so it is never called. The call then died in the
  // container's own method arm, which errors before anything consults a trait impl —
  // `Vec has no method 'toJ'` even though the program clearly defines one.
  //
  // Instantiated per ELEMENT type and registered under a mangled name (`Vec_i64`), which
  // is what stops every `Vec<T>` impl from collapsing onto one entry: `resolveMethod` is
  // keyed by a bare type name, so without the mangling a `Vec<i64>` impl and a
  // `Vec<string>` impl are the same key.
  private instantiateContainerImpl(container: string, args: TypeKind[], method: string): { mangled: string; sig: FnSig } | null {
    const templates = this.genericImpls.get(container);
    if (!templates || templates.length === 0) return null;
    const concreteName = `${container}_${args.map(a => this.mangleTypeName(a)).join("_")}`;
    const already = this.resolveMethod(concreteName, method);
    if (already) return already;
    if (!templates.some(t => t.impl.methods.some(m => m.name === method))) return null;

    const argsMilo = args.map(a => this.typeKindToMiloType(a));
    for (const { impl: gi, program: prog } of templates) {
      const names = gi.typeParams.map(t => t.name);
      // An impl whose parameter count does not match the container's is not about this
      // container shape at all (`impl T for HashMap<K>` on a two-parameter map), and
      // substituting anyway would bind the wrong positions silently.
      if (names.length !== args.length) continue;
      // The receiver keeps its real container type: `self: &Self` on a `Vec<T>` impl must
      // stay a Vec, not become the mangled struct name, or the body cannot index it.
      const concreteImpl: import("./ast").ImplDecl = {
        kind: "ImplDecl",
        traitName: gi.traitName,
        typeName: concreteName,
        typeParams: [],
        methods: gi.methods.map(m => ({
          ...m,
          params: m.params.map(p => ({
            name: p.name,
            type: p.name === "self"
              ? { name: container, typeArgs: argsMilo, isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null }
              : this.substituteMiloType(declaredType(p), names, args),
          })),
          retType: this.substituteMiloType(m.retType, names, args),
          body: this.substituteBody(m.body, names, args),
        })),
        span: gi.span,
      };
      this.registerImpl(concreteImpl, prog, this._pendingImplFns);
    }
    return this.resolveMethod(concreteName, method);
  }

  private resolveMethod(objTypeName: string, methodName: string): { mangled: string; sig: FnSig } | null {
    // inherent first
    const inherent = this.inherentImpls.get(objTypeName);
    if (inherent) {
      const sig = inherent.methods.get(methodName);
      if (sig) return { mangled: `${objTypeName}$${methodName}`, sig };
    }
    // then trait impls
    const impls = this.traitImpls.get(objTypeName);
    if (impls) {
      const matches: { mangled: string; sig: FnSig }[] = [];
      for (const impl of impls) {
        const sig = impl.methods.get(methodName);
        if (sig) matches.push({ mangled: `${objTypeName}$${impl.traitName}$${methodName}`, sig });
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        this.error(`ambiguous method '${methodName}' on '${objTypeName}' — implemented by multiple traits`);
        return matches[0];
      }
    }
    return null;
  }

  private typeImplementsTrait(tName: string, traitName: string): boolean {
    const impls = this.traitImpls.get(tName);
    if (!impls) return false;
    if (impls.some(i => i.traitName === traitName)) return true;
    // check supertraits transitively
    const trait = this.traits.get(traitName);
    if (trait) {
      for (const sup of trait.supertraits) {
        if (!this.typeImplementsTrait(tName, sup)) return false;
      }
    }
    return false;
  }

  // structural interface satisfaction: type has all methods with matching signatures
  private typeSatisfiesInterface(tName: string, ifaceName: string): boolean {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return false;
    for (const [methodName, ifaceMethod] of iface.methods) {
      const resolved = this.resolveMethod(tName, methodName);
      if (!resolved) return false;
      // check param count matches (skip self — both sides have it)
      if (resolved.sig.params.length !== ifaceMethod.params.length) return false;
      // check non-self param types match
      for (let i = 1; i < ifaceMethod.params.length; i++) {
        if (!typeEq(resolved.sig.params[i].type, ifaceMethod.params[i].type)) return false;
      }
      // check return type matches
      if (!typeEq(resolved.sig.ret, ifaceMethod.ret)) return false;
    }
    return true;
  }

  // try implicit coercion from concrete type to interface type
  // returns true if coercion is valid and was recorded
  private tryInterfaceCoercion(expr: Expr, sourceType: TypeKind, targetType: TypeKind): boolean {
    // &T → &Interface
    if (targetType.tag === "ref" && targetType.inner.tag === "interface") {
      const ifaceName = targetType.inner.name;
      const srcInner = sourceType.tag === "ref" ? sourceType.inner : sourceType;
      const srcName = typeName(srcInner);
      if (srcInner.tag === "struct" || srcInner.tag === "enum") {
        if (this.typeSatisfiesInterface(srcName, ifaceName)) {
          this.interfaceCoercions.set(expr, { fromType: srcName, ifaceName });
          return true;
        }
        this.error(`type '${srcName}' does not satisfy interface '${ifaceName}'`, expr.span);
      }
      return false;
    }
    // Heap<T> → Heap<Interface>
    if (targetType.tag === "heap" && targetType.inner.tag === "interface") {
      const ifaceName = targetType.inner.name;
      if (sourceType.tag === "heap") {
        const srcName = typeName(sourceType.inner);
        if (sourceType.inner.tag === "struct" || sourceType.inner.tag === "enum") {
          if (this.typeSatisfiesInterface(srcName, ifaceName)) {
            this.interfaceCoercions.set(expr, { fromType: srcName, ifaceName });
            return true;
          }
          this.error(`type '${srcName}' does not satisfy interface '${ifaceName}'`, expr.span);
        }
      }
      return false;
    }
    return false;
  }

  // Send = safe to transfer ownership across threads
  private isSend(ty: TypeKind): boolean {
    switch (ty.tag) {
      case "int": case "float": case "bool": case "void": case "string":
        return true;
      case "ptr":
        return false;
      case "ref":
        return ty.mutable ? this.isSend(ty.inner) : this.isSync(ty.inner);
      case "heap":
        return this.isSend(ty.inner);
      case "vec":
        return this.isSend(ty.element);
      case "hashmap":
        return this.isSend(ty.key) && this.isSend(ty.value);
      case "array":
        return this.isSend(ty.element);
      case "fn":
        return true;
      case "interface":
        return false;
      case "struct": {
        if (this.sendTypes.has(ty.name)) return true;
        const info = this.structs.get(ty.name);
        // A marker on Wrapper<T> audits the wrapper's raw representation, not T.
        // Keep the ordinary Send requirement for every instantiated argument.
        if (info?.baseName && this.sendTypes.has(info.baseName)) {
          return (info.typeArgs ?? []).every(arg => this.isSend(arg));
        }
        if (!info) return true;
        return info.fields.every(f => this.isSend(f.type));
      }
      case "enum": {
        const info = this.enums.get(ty.name);
        if (!info) return true;
        for (const [, v] of info.variants) {
          if (!v.fields.every(f => this.isSend(f))) return false;
        }
        return true;
      }
      default: return true;
    }
  }

  private whyNotSend(ty: TypeKind): string {
    if (ty.tag === "ptr") return `raw pointer '${this.show(ty)}' is not Send`;
    if (ty.tag === "struct") {
      const info = this.structs.get(ty.name);
      if (info) {
        for (const f of info.fields) {
          if (!this.isSend(f.type)) return `field '${f.name}' of type '${this.show(f.type)}' is not Send — a manual override requires 'unsafe impl Send for ${ty.name} {}' and an audited invariant`;
        }
      }
    }
    return `type '${this.show(ty)}' is not Send`;
  }

  // Sync = safe to share via &T across threads
  private isSync(ty: TypeKind): boolean {
    switch (ty.tag) {
      case "int": case "float": case "bool": case "void": case "string":
        return true;
      case "ptr":
        return false;
      case "ref":
        return this.isSync(ty.inner);
      case "heap":
        return this.isSync(ty.inner);
      case "vec":
        return this.isSync(ty.element);
      case "hashmap":
        return this.isSync(ty.key) && this.isSync(ty.value);
      case "array":
        return this.isSync(ty.element);
      case "fn":
        return true;
      case "interface":
        return false;
      case "struct": {
        if (this.syncTypes.has(ty.name)) return true;
        const info = this.structs.get(ty.name);
        if (info?.baseName && this.syncTypes.has(info.baseName)) {
          return (info.typeArgs ?? []).every(arg => this.isSync(arg));
        }
        if (!info) return true;
        return info.fields.every(f => this.isSync(f.type));
      }
      case "enum": {
        const info = this.enums.get(ty.name);
        if (!info) return true;
        for (const [, v] of info.variants) {
          if (!v.fields.every(f => this.isSync(f))) return false;
        }
        return true;
      }
      default: return true;
    }
  }

  // A method may hand back a `&[T]` view of its receiver's own storage (the documented
  // zero-copy container idiom). Every other reference return stays banned. The view is
  // only sound because the call site freezes the receiver for the result binding's life
  // (see freezeViewSource) and the body may only derive it from `self` — without both,
  // `let s = b.view(); b.push(x)` reallocs and frees the buffer `s` points at.
  // `&[T]` and `&string` are both non-owning views into a receiver's storage and carry
  // the same provenance rule. A string view is what any zero-copy text pass needs (a
  // tokenizer handing back the span it just matched), so it must not be second-class
  // where the slice view is not.
  private isViewReturn(ret: TypeKind): boolean {
    if (ret.tag !== "ref") return false;
    return (ret.inner.tag === "array" && ret.inner.size === null) || ret.inner.tag === "string";
  }

  private hasSelfReceiver(fn: Function): boolean {
    return fn.params.length > 0 && fn.params[0].name === "self";
  }

  // `let s = b.view()` borrows b's storage exactly as `let s = b.data[0..n]` does, so the
  // receiver has to be frozen the same way. The let/for-in paths already transfer any
  // freeze taken while checking the RHS onto the binding (VarInfo.freezes), released when
  // its scope pops — this only has to mark the root.
  private freezeViewSource(obj: Expr, sp?: Span, viewFields?: string[]) {
    const rootName = this.rootNameOf(obj);
    if (rootName === null) {
      // No binding to freeze: `makeRing().items()` views storage owned by a temporary.
      // That only survives today because temporaries are never dropped (they leak) —
      // it becomes a use-after-free the moment they get drop glue.
      this.error(`cannot take a view of a temporary`, sp,
        `the '&[T]' would outlive the value it points into — bind the receiver first ('let r = makeRing()') and take the view from that`);
      return;
    }
    const info = this.lookup(rootName);
    if (info) {
      // freeze the receiver path extended by the field the method views, so a view of
      // `r.items()` that returns `self.data[..]` blocks writes to `r.data` and nothing else
      const base = this.accessPath(obj);
      const path = base && base.fields && viewFields ? [...base.fields, ...viewFields] : null;
      info.borrowed = true;
      (info.borrowedPaths ??= []).push(path);
    }
    this.borrowedExprs.add(obj);
  }

  // `s.lines()` / `s.splitView(sep)` are loop forms, not expressions: the receiver type has
  // to be known *before* the call is checked as an expression, because checking it that way
  // reports the misuse error. Only paths (`text`, `self.src`) are recognized — any other
  // receiver falls through to the normal path and gets that error, which is the right
  // answer anyway for a temporary the view would outlive.
  private stringViewIterMode(iterable: Expr): "lines" | "split" | null {
    if (iterable.kind !== "MethodCall") return null;
    const mode = iterable.method === "lines" ? "lines" : iterable.method === "splitView" ? "split" : null;
    if (!mode) return null;
    let t = this.peekPathType(iterable.object);
    if (t?.tag === "ref") t = t.inner;
    return t?.tag === "string" ? mode : null;
  }

  // Side-effect-free type of a variable/field path. Deliberately partial: a null answer
  // means "ask the real checker", never "no type".
  private peekPathType(e: Expr): TypeKind | null {
    // A literal's bytes are a module constant, so views of it outlive any loop
    if (e.kind === "StringLit") return { tag: "string" };
    // ident-ok: asks what type a NAME has, and is the base case of a walk that handles the other steps itself
    if (e.kind === "Ident") return this.lookup(e.name)?.type ?? this._globalTypes.get(e.name) ?? null;
    if (e.kind === "FieldAccess") {
      let base = this.peekPathType(e.object);
      if (base?.tag === "ref" || base?.tag === "heap") base = base.inner;
      if (base?.tag !== "struct") return null;
      return this.structs.get(base.name)?.fields.find(f => f.name === e.field)?.type ?? null;
    }
    // `rows[i].lines()` — an element read, so the freeze on the root container still covers
    // the storage the pieces point into
    if (e.kind === "IndexAccess") {
      let base = this.peekPathType(e.object);
      if (base?.tag === "ref" || base?.tag === "heap") base = base.inner;
      if (base?.tag === "vec" || base?.tag === "array") return base.element;
      if (base?.tag === "hashmap") return base.value;
      return null;
    }
    return null;
  }

  private checkStringViewForIn(stmt: Stmt & { kind: "ForInStmt" }, mode: "lines" | "split", fnRetType: TypeKind) {
    const call = stmt.iterable as import("./ast").MethodCall;
    const sp = stmt.span;
    this.checkExpr(call.object);
    if (mode === "split") {
      if (call.args.length !== 1) {
        this.error(`'splitView' expects 1 argument, got ${call.args.length}`, sp);
      } else {
        const sepType = this.checkExpr(call.args[0]);
        if (sepType.tag !== "string" && sepType.tag !== "unknown") {
          this.error(`'splitView': expected string, got ${this.show(sepType)}`, sp);
        }
      }
    } else if (call.args.length !== 0) {
      this.error(`'lines' takes no arguments`, sp);
    }
    // Same freeze a slice takes: every piece points into the receiver's buffer, so it must
    // not be mutated, moved or reallocated for the whole loop.
    const rootInfo = this.freezeRootOf(call.object);
    this.borrowedExprs.add(call.object);
    this.stringViewForIns.set(stmt, { mode });

    const viewType: TypeKind = { tag: "ref", inner: { tag: "string" }, mutable: false };
    const preMoves = this.snapshotMoveState();
    this.returnOnlyMovesStack.push(new Set());
    this.pushScope();
    if (stmt.varName2) {
      // enumerate: `for i, line in text.lines()`
      this.declare(stmt.varName, { type: { tag: "int", bits: 64, signed: true }, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
      this.declare(stmt.varName2, { type: viewType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
    } else {
      this.declare(stmt.varName, { type: viewType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
    }
    for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
    this.loopDepth++;
    for (const s of stmt.body) this.checkStmt(s, fnRetType);
    this.loopDepth--;
    this.popScope();
    if (rootInfo) this.unfreeze(rootInfo);
    const returnMoves = this.returnOnlyMovesStack.pop()!;
    this.checkLoopMoves(preMoves, returnMoves, sp);
  }

  // The call site freezes the receiver and nothing else, so a returned view must point
  // into storage reachable from `self`. A view of a method-local dies at the return; a
  // view of another `&` param outlives a freeze that was never taken for it.
  // The receiver field chain a view-returning method's result points into: `["a"]` for
  // `return self.a[0..n]`, `[]` when the view is of the whole receiver. Absent means
  // "unknown" and the call site falls back to freezing the entire receiver — which is
  // what happens for a return nested inside control flow, or several returns disagreeing.
  private viewReturnFields = new Map<string, string[]>();

  private recordViewProvenance(fn: Function) {
    const ret = fn.retType ? this.resolve(fn.retType) : null;
    if (!ret || !this.isViewReturn(ret) || !this.hasSelfReceiver(fn)) return;
    // Walks the AST directly rather than through accessSteps: this runs before any body
    // is checked, so expression types aren't known yet and a `.slice(a, b)` call can't be
    // recognized as a view by its type.
    const chain = (e: Expr): string[] | null => {
      if (e.kind === "Ident") return e.name === "self" ? [] : null;
      if (e.kind === "FieldAccess") { const b = chain(e.object); return b && [...b, e.field]; }
      if (e.kind === "IndexAccess" || e.kind === "MethodCall") return chain(e.object);
      return null;
    };
    let fields: string[] | null = null;
    for (const stmt of fn.body ?? []) {
      if (stmt.kind !== "Return" || !stmt.value) continue;
      const named = chain(stmt.value);
      if (!named) return;
      if (fields !== null && (fields.length !== named.length || fields.some((f, i) => f !== named[i]))) return;
      fields = named;
    }
    if (fields !== null) this.viewReturnFields.set(fn.name, fields);
  }

  private checkViewProvenance(value: Expr, sp?: Span) {
    // Every place the returned view could point into must be the receiver's own
    // storage — a fork returns one of several, and one bad arm is enough to dangle.
    const places = this.placesOf(value);
    const offending = places.find(p => p.tag === "path" && p.root !== "self");
    if (!offending || offending.tag !== "path") return; // all self, or no named place
    this.error(`cannot return a view of '${offending.root}'`, sp,
      `a returned view may only point into the receiver's own storage ('self...') — the call site freezes the receiver, so any other source could be moved or reallocated while the view is live`);
  }

  private errorIfRefReturn(fn: Function, ret: TypeKind) {
    if (ret.tag !== "ref" && this.nestedRef(ret) && !this.refReturnReported.has(fn)) {
      // `Option<&[T]>` hands the view back inside storage, where it outlives the freeze
      // the call site took for it — the second-class rule has to hold through a payload.
      this.refReturnReported.add(fn);
      const outer = ret.tag === "enum" ? (this.enums.get(ret.name)?.baseName ?? ret.name) : typeName(ret);
      this.error(`function '${fn.name}': cannot return a reference stored inside '${outer}'`, fn.span,
        `references are second-class — return an owned value, or return the view directly and let the caller match on emptiness another way`);
      return;
    }
    if (ret.tag !== "ref" || this.refReturnReported.has(fn)) return;
    if (this.isViewReturn(ret) && this.hasSelfReceiver(fn)) return;
    this.refReturnReported.add(fn);
    this.error(`function '${fn.name}': cannot return a reference`, fn.span,
      this.isViewReturn(ret)
        ? `only a method can return a '${this.show(ret)}' view, and only of its own receiver's storage — take the slice at the call site ('v[a..b]') or return an owned value`
        : `references are second-class — return an owned value instead`);
  }

  private checkFunction(fn: Function) {
    // save/restore: monomorphization can re-enter checkFunction mid-expression.
    // currentFnRetType MUST be saved too — resolving/checking a generic in this
    // fn's body (e.g. Channel<string>.new) re-enters checkFunction for that
    // type's methods (some returning void), which would otherwise leave
    // currentFnRetType clobbered and make a later `?` see a void return.
    const savedIsUser = this.currentFnIsUser;
    const savedRetType = this.currentFnRetType;
    const savedScopeFloor = this.fnScopeFloor;
    // The restore is a `finally` because a `fatal()` anywhere below unwinds past
    // it — leaving currentFnRetType pointing at an abandoned function would make
    // the NEXT function's `return`/`?` check answer against the wrong signature.
    try {
      this.checkFunctionBody(fn);
    } finally {
      this.currentFnIsUser = savedIsUser;
      this.currentFnRetType = savedRetType;
      this.fnScopeFloor = savedScopeFloor;
    }
  }

  private checkFunctionBody(fn: Function) {
    this.currentFnIsUser = this.fnIsUserCode(fn.name);
    this.pushScope();
    this.fnScopeFloor = this.scopes.length - 1;
    const retType = this.resolve(fn.retType);
    // impl methods and generic instantiations never pass the declaration-level scan
    this.errorIfRefReturn(fn, retType);
    this.currentFnRetType = retType;

    for (const p of fn.params) {
      const declared = declaredType(p);
      const pType = this.resolve(declared);
      const nullableRef = declared.isNullableRef && pType.tag === "ptr"
        ? { inner: pType.inner, mutable: !!declared.isRefMut } : undefined;
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false, span: p.span,
        ...(nullableRef && { nullableRef }) });
    }

    // Check contracts in a nested scope so `result` doesn't shadow body locals
    if (fn.contracts && fn.contracts.length > 0) {
      this.pushScope();
      const hasEnsures = fn.contracts.some(c => c.kind === "ensures");
      if (hasEnsures && retType.tag !== "void") {
        this.declare("result", { type: retType, mutable: false, moved: false, borrowed: false, read: true });
      }
      for (const c of fn.contracts) this.checkContractClause(c);
      this.popScope();
    }

    // One boundary per statement: a `fatal()` abandons the statement it fired in,
    // not the function, so a body with three independent errors still reports three.
    for (const stmt of fn.body) this.recover(() => this.checkStmt(stmt, retType));
    this.scanUnreachable(fn.body);

    // Lint: warn if a non-ref, non-Copy param was never moved — suggest &T
    if (!fn.isExtern) {
      for (const p of fn.params) {
        const info = this.lookup(p.name);
        if (!info) continue;
        if (info.type.tag === "ref") continue;
        if (this.isCopyType(info.type)) continue;
        if (!info.moved) {
          this.warn("unused-move",
            `parameter '${p.name}' is never moved — consider taking '&${this.show(info.type)}' instead`,
            fn.span,
            `passing by reference avoids requiring callers to give up ownership`
          );
        }
      }
    }

    // Lint: unused variables
    const scope = this.scopes[this.scopes.length - 1];
    for (const [name, info] of scope) {
      // `self` is the method receiver — never lint it unused (matches Rust). A Drop
      // impl or any method that ignores its receiver shouldn't have to write `_self`.
      if (info.read || name.startsWith("_") || name === "self") continue;
      this.warn("unused-variable", `unused variable '${name}'`, info.span,
        `prefix with underscore to silence: '_${name}'`);
    }

    this.popScope();
  }

  private checkStmt(stmt: Stmt, fnRetType: TypeKind) {
    this.checkStmtBody(stmt, fnRetType);
    // Lock any flexible const-int binding that was read but not widened during
    // this statement: its width is now fixed at the default. This is what keeps
    // widening sound — a binding can only adopt a wider width at its FIRST read
    // (within one statement), never retroactively after an i32 use committed.
    for (const scope of this.scopes) {
      for (const [, vi] of scope) {
        if (vi.flexInt && vi.read) vi.flexInt = undefined;
      }
    }
  }

  private checkStmtBody(stmt: Stmt, fnRetType: TypeKind) {
    const sp = stmt.span;
    switch (stmt.kind) {
      case "LetDecl": {
        const hint = stmt.type ? this.resolve(stmt.type, stmt.span) : null;
        // refs in locals OK (second-class — can't escape function via return/struct/collection)
        if (hint && this.nestedRef(hint)) {
          this.error(`'${stmt.name}': references cannot be stored in a collection`, sp, `references are second-class — store owned values instead`);
        }
        const frozenBeforeRhs = new Set<VarInfo>();
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed) frozenBeforeRhs.add(vi);
        const deferred = !hint ? this.tryDeferVecInfer(stmt.value) : null;
        const valType = deferred ?? this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(hint);
          const isStringToPtr = valType.tag === "string" && hint.tag === "ptr" && hint.inner.tag === "int" && hint.inner.bits === 8;
          if (optInner && typeEq(optInner, valType) && hint.tag === "enum") {
            this.autoWrappedOption.set(stmt.value, hint.name);
          } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
            this.arrayToVecCoercions.add(stmt.value);
          } else if (!isStringToPtr && !this.tryInterfaceCoercion(stmt.value, valType, hint)) {
            this.error(`type mismatch: '${stmt.name}' declared as ${this.show(hint)} but got ${this.show(valType)}`, sp, this.optionUnwrapHint(hint, valType));
          }
        }
        // range checking for ranged integer types
        if (hint?.tag === "int") this.enforceRangeInto(stmt.value, valType, hint, sp);
        // Borrows the RHS created: a ref binding owns them until its scope pops;
        // any other binding consumed them within the statement (e.g. s[0..n].clone())
        // and must not leak a freeze onto later statements.
        const newlyFrozen: VarInfo[] = [];
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) newlyFrozen.push(vi);
        const bindingType = hint ?? valType;
        // A void binding gets a storage slot it cannot have: `alloca void`. The value
        // side of "no data" is `Unit`; `void` is only a function return type. Silent once a
        // void generic has been reported: the bindings inside a monomorphized std body are
        // that one mistake propagating, at spans the programmer never wrote.
        if (bindingType.tag === "void" && this.voidGenericReported.size === 0) {
          this.error(`'${stmt.name}' cannot have type 'void': 'void' has no runtime representation`, sp,
            `drop the binding and call the function as a statement, or return 'Unit {}' instead of nothing`);
        }
        if (bindingType.tag !== "ref") for (const vi of newlyFrozen) this.unfreeze(vi);
        this.declare(stmt.name, { type: bindingType, mutable: false, moved: false, borrowed: false, read: false, span: sp, ...(stmt.value && this.onceClosures.has(stmt.value) && { callsOnce: true }), ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
        const letInfo = this.lookup(stmt.name);
        if (letInfo) this.bindPointerViews(stmt.name, letInfo, stmt.value);
        // An unannotated `let x = <const-int-value>` stays width-adaptable until
        // its first use (see VarInfo.flexInt): its default i32 can widen to an
        // i64 (etc.) context without an `as` cast, since the value is literals.
        if (!hint && valType.tag === "int") {
          const leaves = this.flexIntLeaves(stmt.value);
          if (leaves) {
            const info = this.lookup(stmt.name);
            if (info) info.flexInt = { leaves, valueExpr: stmt.value };
          }
        }
        if (bindingType.tag === "array") this.lintStackArray(stmt.name, bindingType, sp);
        this.lintIndexClone(stmt.value, bindingType, sp);
        const letCarried = this.pointerBorrowsCarriedBy(stmt.value);
        this.pointerMoveKeepsHolders = letCarried !== null;
        try { this.tryMove(stmt.value); } finally { this.pointerMoveKeepsHolders = false; }
        if (letCarried) this.carryPointerBorrows(letCarried, stmt.name);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type, stmt.span) : null;
        if (hint && this.nestedRef(hint)) {
          this.error(`'${stmt.name}': references cannot be stored in a collection`, sp, `references are second-class — store owned values instead`);
        }
        const frozenBeforeRhs = new Set<VarInfo>();
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed) frozenBeforeRhs.add(vi);
        const deferred = !hint ? this.tryDeferVecInfer(stmt.value) : null;
        const valType = deferred ?? this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(hint);
          const isStringToPtr = valType.tag === "string" && hint.tag === "ptr" && hint.inner.tag === "int" && hint.inner.bits === 8;
          if (optInner && typeEq(optInner, valType) && hint.tag === "enum") {
            this.autoWrappedOption.set(stmt.value, hint.name);
          } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
            this.arrayToVecCoercions.add(stmt.value);
          } else if (!isStringToPtr && !this.tryInterfaceCoercion(stmt.value, valType, hint)) {
            this.error(`type mismatch: '${stmt.name}' declared as ${this.show(hint)} but got ${this.show(valType)}`, sp, this.optionUnwrapHint(hint, valType));
          }
        }
        if (hint?.tag === "int" && hint.min !== undefined && hint.max !== undefined) {
          const litVal = this.constIntValue(stmt.value);
          if (litVal !== null) {
            if (litVal < hint.min || litVal > hint.max) {
              this.error(`value ${litVal} is out of range for ${this.show(hint)} (${hint.min}..${hint.max})`, sp);
            }
          } else if (valType.tag === "int" && valType.min !== undefined && valType.max !== undefined &&
                     valType.min >= hint.min && valType.max <= hint.max) {
            // range propagation proved value fits — no runtime check needed
          } else {
            this.rangeCheckedExprs.set(stmt.value, { min: hint.min, max: hint.max, typeName: typeName(hint) });
          }
        }
        {
          const newlyFrozen: VarInfo[] = [];
          for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) newlyFrozen.push(vi);
          const bindingType = hint ?? valType;
          // A void binding gets a storage slot it cannot have: `alloca void`. The value
          // side of "no data" is `Unit`; `void` is only a function return type. Silent once a
          // void generic has been reported: the bindings inside a monomorphized std body are
          // that one mistake propagating, at spans the programmer never wrote.
          if (bindingType.tag === "void" && this.voidGenericReported.size === 0) {
            this.error(`'${stmt.name}' cannot have type 'void': 'void' has no runtime representation`, sp,
              `drop the binding and call the function as a statement, or return 'Unit {}' instead of nothing`);
          }
          if (bindingType.tag !== "ref") for (const vi of newlyFrozen) this.unfreeze(vi);
          this.declare(stmt.name, { type: bindingType, mutable: true, moved: false, borrowed: false, read: false, span: sp, ...(stmt.value && this.onceClosures.has(stmt.value) && { callsOnce: true }), ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
          const varInfo = this.lookup(stmt.name);
          if (varInfo) this.bindPointerViews(stmt.name, varInfo, stmt.value);
          if (bindingType.tag === "array") this.lintStackArray(stmt.name, bindingType, sp);
          this.lintIndexClone(stmt.value, bindingType, sp);
        }
        const varCarried = this.pointerBorrowsCarriedBy(stmt.value);
        this.pointerMoveKeepsHolders = varCarried !== null;
        try { this.tryMove(stmt.value); } finally { this.pointerMoveKeepsHolders = false; }
        if (varCarried) this.carryPointerBorrows(varCarried, stmt.name);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo.mutable) {
          // A pattern binding has no declaration to change, so the generic advice would
          // send the reader looking for a `let` that does not exist. Rebuilding the
          // variant is the move that works, and it costs no clone.
          // ident-ok: asks whether the assigned NAME is a pattern binding, to choose a hint; a place has no binding kind
          const tgtInfo = stmt.target.kind === "Ident" ? this.lookup(stmt.target.name) : null;
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp,
            tgtInfo?.patternBound
              ? `'${this.describeExpr(stmt.target)}' is bound by a pattern, and no spelling of the pattern makes it mutable. Assign a rebuilt value to the matched variable instead (e.g. 'n = Node.Leaf(v + 1)')`
              : `declare with 'var' instead of 'let' to make it mutable`);
          break;
        }
        // Assignment puts a value back, so whatever was moved out of this place is
        // live again. An Ident target replaces the whole variable and clears all of it.
        // ident-ok: an Ident target replaces the WHOLE variable; the field case is the else branch, via staticFieldPath
        if (stmt.target.kind === "Ident") {
          const whole = this.lookup(stmt.target.name);
          if (whole) this.clearMovedPlace(whole, null);
        } else {
          const place = this.staticFieldPath(stmt.target);
          const rootInfo = place ? this.lookup(place.root) : null;
          if (place && rootInfo) this.clearMovedPlace(rootInfo, place.path);
        }
        this.markCaptureMutated(stmt.target);
        // reject reassignment while a borrow (slice, iteration ref) is live
        // but allow closures to mutate their own captured variables.
        // Whole-place assignment (`x = ...`, `x.f = ...`) drops the old value and frees
        // its buffer, so a live view into it would dangle. An index step is exempt: an
        // in-place element write never reallocates, so views stay valid and see it
        // (tests/fixtures/viewFreezeRelease.milo).
        const assignPath = this.accessSteps(stmt.target);
        // The index/deref exemption above is a VIEW's exemption: writing an element in
        // place never reallocates, so a live slice stays valid and simply observes the
        // write. A `for-in` is the case it does not cover — the loop is handing out that
        // very element, so `for it in v { v[0] = x }` rewrites what `it` names. Without
        // this the rule gave two answers to one question depending on spelling:
        // `v.push(x)` was rejected inside the loop and `v[0] = x` was not.
        const indexQualified = assignPath ? assignPath.steps.some((s) => s === "[]" || s === "*") : false;
        const assignInfo = assignPath ? this.lookup(assignPath.root) : null;
        // An element write never moves the buffer, so a slice view survives it; a bound
        // pointer does not get that exemption. The pointer's user may be another thread
        // (tests/fixtures/bandParallelBuffer.milo writes through it from workers), and a
        // write through the owner at the same time is the race the view rule exists to stop.
        const indexPh = assignPath && indexQualified && assignInfo ? this.pointerBorrowAgainst(assignInfo, stmt.target) : null;
        if (indexPh) {
          this.error(`'${assignPath!.root}' is written here while '${indexPh.name}' still points into its buffer (from '${indexPh.call}' on line ${indexPh.line})`, sp,
            `write through '${indexPh.name}' instead, or take the pointer after the last write`);
          break;
        }
        if (assignPath && indexQualified && assignInfo && this.frozenByIteration(assignInfo, stmt.target)) {
          this.error(`cannot assign to '${this.describeExpr(stmt.target)}' because '${assignPath.root}' is being iterated`, sp,
            `the loop hands out this element — finish the loop, or collect the writes and apply them after it`);
          break;
        }
        if (assignPath && !indexQualified) {
          const info = this.lookup(assignPath.root);
          const isCapturedMutation = this.closureScopeDepth !== null && this.currentClosureCaptures?.has(assignPath.root);
          const ph = info && !isCapturedMutation ? this.pointerBorrowAgainst(info, stmt.target) : null;
          if (ph) {
            this.error(`'${this.describeExpr(stmt.target)}' is reassigned here while '${ph.name}' still points into its buffer (from '${ph.call}' on line ${ph.line})`, sp,
              this.pointerHint(ph));
            break;
          }
          if (info && !isCapturedMutation && this.frozenAgainst(info, stmt.target)) {
            const place = this.describeExpr(stmt.target);
            const why = place === assignPath.root ? "it is borrowed" : `'${assignPath.root}' is borrowed`;
            this.error(`cannot assign to '${place}' because ${why}`, sp,
              `a reference or slice into this variable is still live — the assignment would invalidate it`);
            break;
          }
        }
        // Slice/index borrows taken to compute the RHS (e.g. `s[0..n].clone()`)
        // are consumed within this statement — no binding outlives it — so they
        // must not leak a freeze onto the next statement. Snapshot which vars are
        // already frozen, then release any newly-frozen by the RHS afterward.
        const frozenBeforeRhs = new Set<VarInfo>();
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed) frozenBeforeRhs.add(vi);
        const valType = this.checkExprWithHint(stmt.value, targetInfo.type);
        if (targetInfo.type.tag === "cfn" && valType.tag !== "unknown"
            && !this.checkCFnStore(stmt.value, targetInfo.type, valType, `cannot assign to '${this.describeExpr(stmt.target)}'`, sp)) {
          this.error(`type mismatch: cannot assign ${this.show(valType)} to ${this.show(targetInfo.type)}`, sp);
        } else if (targetInfo.type.tag !== "cfn" && !typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(targetInfo.type);
          const isStringToPtr = valType.tag === "string" && targetInfo.type.tag === "ptr" && targetInfo.type.inner.tag === "int" && targetInfo.type.inner.bits === 8;
          if (optInner && typeEq(optInner, valType) && targetInfo.type.tag === "enum") {
            this.autoWrappedOption.set(stmt.value, targetInfo.type.name);
          } else if (!isStringToPtr) {
            this.error(`type mismatch: cannot assign ${this.show(valType)} to ${this.show(targetInfo.type)}`, sp);
          }
        }
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) this.unfreeze(vi);
        if (targetInfo.type.tag === "int") this.enforceRangeInto(stmt.value, valType, targetInfo.type, sp);
        // ident-ok: assigning a whole variable revives it, and a field assignment deliberately must not revive the whole
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          if (info) {
            info.moved = false;
            // `p = w.ptr()` overwrites whatever `p` pointed at, so the borrows the old
            // value held end here; the new ones are bound below. A `var` can never hold a
            // reference, so every freeze on it is a pointer borrow.
            if (info.freezes) { for (const src of info.freezes) this.releasePointerBorrows(src, info); info.freezes = undefined; }
            info.pointerSourceMoved = undefined;
            this.errorIfPointerOutlivesSource(stmt.target.name, info, stmt.value, sp);
            this.bindPointerViews(stmt.target.name, info, stmt.value);
          }
        } else if (assignPath && assignInfo && this.pointerViewsIn(stmt.value).length > 0) {
          // `c.buf = v.ptr()` / `ps[0] = v.ptr()`: the pointer now lives inside `c`/`ps`,
          // which holds it for as long as it lives. The old value of the slot is not
          // released (a field write cannot tell which of `c`'s borrows it overwrote), so
          // this can only over-approximate, and the whole-variable arm above is the reset.
          this.errorIfPointerOutlivesSource(assignPath.root, assignInfo, stmt.value, sp);
          this.bindPointerViews(assignPath.root, assignInfo, stmt.value);
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void") this.error(`return without value in function returning ${this.show(fnRetType)}`, sp);
        } else {
          const prev = this.inReturnInLoop;
          if (this.loopDepth > 0) this.inReturnInLoop = true;
          const valType = this.checkExprWithHint(stmt.value, fnRetType);
          if (!typeEq(fnRetType, valType) && valType.tag !== "unknown" && fnRetType.tag !== "unknown") {
            const isStringToPtr = valType.tag === "string" && fnRetType.tag === "ptr" && fnRetType.inner.tag === "int" && fnRetType.inner.bits === 8;
            // Coerce a concrete type to an interface at return position
            // (`return Heap(Circle{})` where the fn returns Heap<Shape>), as
            // let-bindings and call args already do.
            if (!isStringToPtr && !this.tryInterfaceCoercion(stmt.value, valType, fnRetType)) {
              this.error(`return type mismatch: expected ${this.show(fnRetType)}, got ${this.show(valType)}`, sp);
            }
          }
          if (fnRetType.tag === "int") this.enforceRangeInto(stmt.value, valType, fnRetType, sp);
          // A returned closure that captures by reference is rejected, not promoted —
          // see checkEscapingClosures for why the promotion that used to live here was
          // itself unsound.
          if (this.isViewReturn(fnRetType)) this.checkViewProvenance(stmt.value, sp);
          this.errorIfReturnedPointerDangles(stmt.value, sp);
          // A `return v[i]` allocates exactly like `let m = v[i]` does, and was invisible
          // even with the lint on: the check only ran at a binding. `return b.v[0]` on a
          // borrowed struct is the shape docs/backlog.md #7 is about — the field spelling
          // is a hard error, the index spelling silently deep-copies.
          this.lintIndexClone(stmt.value, valType, sp);
          this.tryMove(stmt.value);
          this.inReturnInLoop = prev;
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${this.show(condType)}`, sp);
        }
        const preMoves = this.snapshotMoveState();
        this.pushScope();
        for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
        this.popScope();
        const thenReturns = this.bodyAlwaysReturns(stmt.thenBody);
        if (stmt.elseBody) {
          const afterThen = this.snapshotMoveState();
          this.restoreMoveState(preMoves);
          this.pushScope();
          for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
          this.popScope();
          const elseReturns = this.bodyAlwaysReturns(stmt.elseBody);
          // moved if moved in a branch that DOESN'T always exit (branches that always return
          // don't leak their moves to code after the if)
          const afterElse = this.snapshotMoveState();
          this.restoreMoveState(preMoves);
          if (!thenReturns) this.mergeMoveState(afterThen);
          if (!elseReturns) this.mergeMoveState(afterElse);
        } else if (thenReturns) {
          // No else and the then-branch always returns: control flow only continues past
          // the if if the condition was false, so moves inside thenBody don't apply here.
          this.restoreMoveState(preMoves);
        }
        break;
      }
      case "WhileStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`while condition must be bool, got ${this.show(condType)}`, sp);
        }
        for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
        const preMoves = this.snapshotMoveState();
        this.returnOnlyMovesStack.push(new Set());
        this.pushScope();
        this.loopDepth++;
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.loopDepth--;
        this.popScope();
        const returnMoves = this.returnOnlyMovesStack.pop()!;
        this.checkLoopMoves(preMoves, returnMoves, sp);
        break;
      }
      case "ForInStmt": {
        if (stmt.iterable.kind === "RangeExpr") {
          const startType = this.checkExpr(stmt.iterable.start);
          const endType = this.checkExpr(stmt.iterable.end);
          if (startType.tag !== "int" && startType.tag !== "unknown") {
            this.error(`for range start must be an integer, got ${this.show(startType)}`, sp);
          }
          if (endType.tag !== "int" && endType.tag !== "unknown") {
            this.error(`for range end must be an integer, got ${this.show(endType)}`, sp);
          }
          if (stmt.varName2) {
            this.error("range for loop takes one binding, not two", sp);
          }
          // Widen to the larger int type so 0..vec.len() just works
          let varType: TypeKind;
          if (startType.tag === "int" && endType.tag === "int") {
            varType = startType.bits >= endType.bits ? startType : endType;
          } else {
            varType = startType.tag === "int" ? startType : endType;
          }
          this.setType(stmt.iterable, varType);
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set());
          this.pushScope();
          this.declare(stmt.varName, { type: varType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
          for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves = this.returnOnlyMovesStack.pop()!;
          this.checkLoopMoves(preMoves, returnMoves, sp);
        } else {
          // `for line in text.lines()` / `for f in text.splitView(",")` — a text pass that
          // allocates nothing. Handled here and nowhere else: the yielded `&string` views
          // cannot travel through the `next(): Option<T>` iterator protocol, because a
          // reference inside an enum payload is a rejected return (see errorIfRefReturn).
          const viewMode = this.stringViewIterMode(stmt.iterable);
          if (viewMode) { this.checkStringViewForIn(stmt, viewMode, fnRetType); return; }
          let iterType = this.checkExpr(stmt.iterable);
          // iterating a slice (&[T]) or &Vec: deref — the loop borrows the view, not a copy
          if (iterType.tag === "ref" && (iterType.inner.tag === "array" || iterType.inner.tag === "vec")) {
            iterType = iterType.inner;
          }
          // `@iter` on a field redirects the loop to that field. A newtype over a
          // container (HashSet over HashMap) then iterates exactly as the container
          // does — same bindings, same borrow, no snapshot — instead of needing a
          // `next` method it cannot write (an iterator would have to hold a
          // reference into the wrapper, and references are second-class).
          {
            const structTy = iterType.tag === "ref" && iterType.inner.tag === "struct" ? iterType.inner : iterType;
            if (structTy.tag === "struct") {
              const delegate = this.structs.get(structTy.name)?.fields.find(f => f.iterDelegate);
              if (delegate) {
                this.iterDelegates.set(stmt, delegate.name);
                iterType = delegate.type;
              }
            }
          }
          // One freeze for every container shape below — see freezeIterable.
          const iterBorrowInfo = this.freezeIterable(stmt.iterable);
          if (iterType.tag === "vec") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              // enumerate: for i, val in vec
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            }
            for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves = this.returnOnlyMovesStack.pop()!;
            this.checkLoopMoves(preMoves, returnMoves, sp);
          } else if (iterType.tag === "string") {
            const byteType: TypeKind = { tag: "int", bits: 8, signed: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
              this.declare(stmt.varName2, { type: byteType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            } else {
              this.declare(stmt.varName, { type: byteType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            }
            for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves3 = this.returnOnlyMovesStack.pop()!;
            this.checkLoopMoves(preMoves, returnMoves3, sp);
          } else if (iterType.tag === "hashmap") {
            const keyRef: TypeKind = { tag: "ref", inner: iterType.key, mutable: false };
            const valRef: TypeKind = { tag: "ref", inner: iterType.value, mutable: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            this.declare(stmt.varName, { type: keyRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            if (stmt.varName2) {
              this.declare(stmt.varName2, { type: valRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            }
            for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves4 = this.returnOnlyMovesStack.pop()!;
            this.checkLoopMoves(preMoves, returnMoves4, sp);
          } else if (iterType.tag === "array") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
            }
            for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves5 = this.returnOnlyMovesStack.pop()!;
            this.checkLoopMoves(preMoves, returnMoves5, sp);
          } else if (iterType.tag === "struct" || iterType.tag === "enum") {
            // iterator protocol: type has next(&mut Self): Option<T>
            const resolved = this.resolveMethod(iterType.name, "next");
            // A generic type parameter (`for x in it`, `it: I` where `I: Iterator`) is not a
            // registered struct/enum, so `next` can't resolve until this function is
            // monomorphized to a concrete type. Defer: check the body with the element type
            // unknown; the per-instantiation re-check binds the real type and sets up the
            // iteration. A real type that simply lacks `next` still errors.
            if (!resolved && !this.structs.has(iterType.name) && !this.enums.has(iterType.name)) {
              this.pushScope();
              this.declare(stmt.varName, { type: { tag: "unknown" }, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
              for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
              this.loopDepth++;
              for (const s of stmt.body) this.checkStmt(s, fnRetType);
              this.loopDepth--;
              this.popScope();
            } else if (!resolved) {
              this.error(`cannot iterate over type '${this.show(iterType)}': no 'next' method found`, sp);
            } else {
              const retType = resolved.sig.ret;
              let elemType: TypeKind | null = null;
              let optionEnumName = "";
              if (retType.tag === "enum") {
                const enumInfo = this.enums.get(retType.name);
                if (enumInfo && enumInfo.baseName === "Option") {
                  const someVariant = enumInfo.variants.get("Some");
                  if (someVariant && someVariant.fields.length === 1) {
                    elemType = someVariant.fields[0];
                    optionEnumName = retType.name;
                  }
                }
              }
              if (!elemType) {
                this.error(`iterator 'next' method must return Option<T>, got ${this.show(retType)}`, sp);
              } else {
                // require iterable to be mutable (next takes &mut Self)
                // Asks the PLACE whether its root is mutable, so an iterator held in a
                // field or reached any other way is checked too. Keyed to a bare `Ident`,
                // this rule simply did not run for `for x in self.cursor`.
                // Only a NAMED root can be immutable. An rvalue iterable (`for x in
                // makeChannel()`) has no root at all: it is materialized into a temp, and
                // a temp is mutable, so demanding `var` of it rejects a legal program.
                const iterRoot = this.accessPath(stmt.iterable);
                if (iterRoot && !this.isRootMutable(stmt.iterable)) {
                  this.error(`cannot iterate: '${this.describeExpr(stmt.iterable)}' must be 'var' (iterator mutates via next())`, sp);
                }
                if (stmt.varName2) {
                  this.error("iterator for loop takes one binding, not two", sp);
                }
                this.iteratorForIns.set(stmt, { nextMethod: resolved.mangled, elemType, optionEnumName });
                const preMoves = this.snapshotMoveState();
                this.returnOnlyMovesStack.push(new Set());
                this.pushScope();
                this.declare(stmt.varName, { type: elemType, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
                for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
                this.loopDepth++;
                for (const s of stmt.body) this.checkStmt(s, fnRetType);
                this.loopDepth--;
                this.popScope();
                const returnMovesIter = this.returnOnlyMovesStack.pop()!;
                this.checkLoopMoves(preMoves, returnMovesIter, sp);
              }
            }
          } else if (iterType.tag !== "unknown") {
            this.error(`cannot iterate over type '${this.show(iterType)}'`, sp);
          }
          // Released once, for whichever arm above ran. Paired with the single
          // freezeIterable before the dispatch — see that function for why the pairing
          // is here and not inside each arm.
          if (iterBorrowInfo) this.unfreeze(iterBorrowInfo);
        }
        break;
      }
      case "BreakStmt":
        if (this.loopDepth === 0) this.error("'break' outside of loop", sp);
        break;
      case "ContinueStmt":
        if (this.loopDepth === 0) this.error("'continue' outside of loop", sp);
        break;
      case "ExprStmt": {
        // A view produced by a discarded expression (`print(lx.word(0, 5))`) has no
        // binding to outlive the statement, so its freeze must not survive it either —
        // same reasoning as the RHS snapshot in Assign, which this mirrors.
        const frozenBefore = new Set<VarInfo>();
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed) frozenBefore.add(vi);
        const exprType = this.checkExpr(stmt.expr);
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBefore.has(vi)) this.unfreeze(vi);
        if (exprType.tag === "enum") {
          const enumInfo = this.enums.get(exprType.name);
          const base = enumInfo?.baseName;
          if (base === "Result" || base === "Option") {
            this.warn("unused-result",
              `unused ${base} value — this may contain an error that should be handled`,
              sp, `use 'let _ = ...' to discard explicitly`);
          }
        }
        break;
      }
      case "MatchStmt": {
        this.checkMatchLike(stmt.subject, stmt.arms, sp, fnRetType, true);
        break;
      }
      case "IfLetStmt": {
        const rawSubjType = this.checkExpr(stmt.subject);
        const { subjType, subjBorrows } = this.enumSubjectBorrow(stmt.subject, rawSubjType, [stmt.pattern]);
        this.bindElidedPattern(stmt.pattern, subjType);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`if let subject must be an enum, got ${this.show(subjType)}`, sp);
          break;
        }
        if (subjType.tag === "enum" && stmt.pattern.kind === "EnumPattern") {
          const enumInfo = must(this.enums, subjType.name, "enums");
          const ps = stmt.pattern.span;
          if (stmt.pattern.enumName !== subjType.name && enumInfo.baseName !== stmt.pattern.enumName) {
            this.error(`pattern enum '${stmt.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
          }
          const variant = enumInfo.variants.get(stmt.pattern.variant);
          if (!variant) {
            this.error(`enum '${subjType.name}' has no variant '${stmt.pattern.variant}'`, ps);
          } else if (stmt.pattern.bindings.length !== variant.fields.length) {
            this.error(`variant '${stmt.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${stmt.pattern.bindings.length} bindings`, ps);
          }
          this.pushScope();
          if (variant) {
            const bindTypes = variant.fields.slice(0, stmt.pattern.bindings.length).map(t => this.payloadBindType(t, subjBorrows));
            this.patternBindingTypes.set(stmt.pattern, bindTypes);
            for (let i = 0; i < Math.min(stmt.pattern.bindings.length, variant.fields.length); i++) {
              const bindSpan = stmt.pattern.bindingSpans?.[i] ?? stmt.pattern.span;
              this.declare(stmt.pattern.bindings[i], { type: bindTypes[i], mutable: false, moved: false, borrowed: false, read: false, span: bindSpan, patternBound: true,
                copyBind: this.isCopyBind(bindTypes[i], this.isPlaceExpr(stmt.subject)) });
            }
          }
          // Same arm-entry consumption as match: a destructuring then-branch
          // zeroes the payload before its body runs, so the subject is dead
          // there. The else-branch never destructures, so it stays readable.
          let patternMovedInfo: { moved: boolean } | null = null;
          if (!subjBorrows && this.armConsumesSubject(stmt.pattern, enumInfo)) {
            this.tryMove(stmt.subject);
            // ident-ok: tracks a NAMED binding so the then-body can read it again; a field subject has no binding to un-mark
            if (stmt.subject.kind === "Ident") {
              const info = this.lookup(stmt.subject.name);
              if (info) { patternMovedInfo = info; this.movedByPattern.add(info); }
            }
          }
          for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
          if (patternMovedInfo) {
            this.movedByPattern.delete(patternMovedInfo);
            patternMovedInfo.moved = false; // re-marked by the tryMove below, after the else-branch
          }
          this.popScope();
        } else {
          this.pushScope();
          for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
          this.popScope();
        }
        if (stmt.elseBody) {
          this.pushScope();
          for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
          this.popScope();
        }
        // A borrowed subject is only read, not consumed.
        if (!subjBorrows) this.tryMove(stmt.subject);
        break;
      }
      case "LetElseStmt": {
        if (stmt.bindName !== undefined) { this.checkNullRefUnwrap(stmt, stmt.bindName, fnRetType, sp); break; }
        const rawSubjType = this.checkExpr(stmt.value);
        const { subjType, subjBorrows } = this.enumSubjectBorrow(stmt.value, rawSubjType, [stmt.pattern]);
        this.bindElidedPattern(stmt.pattern, subjType);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`let-else value must be an enum (Option/Result/…), got ${this.show(subjType)}`, sp);
          break;
        }
        // The else block runs only when the pattern doesn't match, so it must
        // diverge — otherwise the binding below wouldn't be guaranteed live. It's
        // checked (in its own scope) BEFORE the binding is declared, so the
        // binding is not in scope inside it.
        this.pushScope();
        for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
        this.popScope();
        if (!this.bodyAlwaysReturns(stmt.elseBody)) {
          this.error(`let-else block must diverge (return/break/continue) — it runs when the pattern doesn't match`, sp);
        }
        if (subjType.tag === "enum" && stmt.pattern.kind === "EnumPattern") {
          const enumInfo = must(this.enums, subjType.name, "enums");
          const ps = stmt.pattern.span;
          if (stmt.pattern.enumName !== subjType.name && enumInfo.baseName !== stmt.pattern.enumName) {
            this.error(`pattern enum '${stmt.pattern.enumName}' does not match value type '${subjType.name}'`, ps);
          }
          const variant = enumInfo.variants.get(stmt.pattern.variant);
          if (!variant) {
            this.error(`enum '${subjType.name}' has no variant '${stmt.pattern.variant}'`, ps);
          } else if (stmt.pattern.bindings.length !== variant.fields.length) {
            this.error(`variant '${stmt.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${stmt.pattern.bindings.length} bindings`, ps);
          }
          if (variant) {
            const bindTypes = variant.fields.slice(0, stmt.pattern.bindings.length).map(t => this.payloadBindType(t, subjBorrows));
            this.patternBindingTypes.set(stmt.pattern, bindTypes);
            // Bindings escape into the CURRENT scope (the whole point vs if-let).
            for (let i = 0; i < Math.min(stmt.pattern.bindings.length, variant.fields.length); i++) {
              const bindSpan = stmt.pattern.bindingSpans?.[i] ?? stmt.pattern.span;
              this.declare(stmt.pattern.bindings[i], { type: bindTypes[i], mutable: false, moved: false, borrowed: false, read: false, span: bindSpan, patternBound: true,
                copyBind: this.isCopyBind(bindTypes[i], this.isPlaceExpr(stmt.value)) });
            }
          }
        }
        // A borrowed value is only read, not consumed.
        if (!subjBorrows) this.tryMove(stmt.value);
        break;
      }
      case "UnsafeBlock": {
        this.unsafeDepth++;
        this.unsafeUsedStack.push(false);
        this.pushScope();
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.popScope();
        const used = this.unsafeUsedStack.pop();
        this.unsafeDepth--;
        // only lint user code — stdlib has many technically-removable blocks
        if (!used && this.currentFnIsUser) {
          this.warn("unused-unsafe", `unnecessary 'unsafe' block: nothing inside requires unsafe`, stmt.span, `remove the 'unsafe' wrapper`, "unsafe".length);
        }
        break;
      }
      default: {
        // A statement kind with no arm is never checked — no type error, no move error, no
        // diagnostic of any kind for anything inside it. This makes the next unhandled kind
        // a compile error instead of a silent pass.
        const _exhaustive: never = stmt;
        void _exhaustive;
      }
    }
  }

  // T → Option<T> auto-wrapping: returns the monomorphized Option name if param is Option and arg matches inner type
  private optionInnerType(paramType: TypeKind): TypeKind | null {
    if (paramType.tag !== "enum") return null;
    const info = this.enums.get(paramType.name);
    if (!info || info.baseName !== "Option") return null;
    const someVariant = info.variants.get("Some");
    if (!someVariant || someVariant.fields.length !== 1) return null;
    return someVariant.fields[0];
  }

  // A total API answers Option<T>, so "expected T, got Option_T" is the first thing
  // a caller sees the moment a parser or lookup stops handing back a sentinel. The
  // mangled name alone doesn't say what to do about it — name the three ways out.
  private optionUnwrapHint(expected: TypeKind, actual: TypeKind): string | undefined {
    const inner = this.optionInnerType(actual);
    if (!inner || !typeEq(inner, expected)) return undefined;
    return `${this.show(actual)} is Option<${this.show(inner)}> — unwrap it with 'match', `
      + `'let Option.Some(x) = ... else { ... }', or '.unwrapOr(<default>)'`;
  }

  // auto-deref: &T → T, &mut T → T
  private deref(t: TypeKind): TypeKind {
    if (t.tag === "ref") return t.inner;
    return t;
  }

  // For `let/var x = Vec.new()` / `Vec.withCapacity(n)` with no type annotation:
  // return a Vec whose element is a placeholder to be resolved from the first
  // `x.push(...)` (see the push handler). Returns null for anything else, so the
  // normal (element-required) path — and its error — is untouched everywhere else.
  private tryDeferVecInfer(value: Expr): TypeKind | null {
    if (value.kind !== "EnumLit" || value.enumName !== "Vec") return null;
    if (value.variant === "new") {
      if (value.args.length !== 0) this.error(`'Vec.new' takes no arguments`, value.span);
    } else if (value.variant === "withCapacity") {
      if (value.args.length !== 1) this.error(`'Vec.withCapacity' expects 1 argument (capacity), got ${value.args.length}`, value.span);
      else {
        const c = this.checkExpr(value.args[0]);
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.withCapacity': capacity must be an integer, got ${this.show(c)}`, value.span);
      }
    } else {
      return null;
    }
    const elem: TypeKind = { tag: "unknown" };
    const vecTy: TypeKind = { tag: "vec", element: elem };
    this.inferVecElems.add(elem);
    this.pendingInferVecs.push({ elem, span: value.span });
    this.exprTypes.set(value, vecTy);
    return vecTy;
  }

  // Runtime global initializers run in `program.globals` order, so a global that reads
  // another has to sit after it. Source order does not guarantee that: the resolver
  // appends the entry module's globals before walking its imports, so `let FRAG = HEAD +
  // SKY_GLSL` built from an imported chunk read a zeroed string and silently produced a
  // truncated shader. Sort by dependency instead — direct reads, plus reads inside
  // functions the initializer calls — and keep source order among independent globals.
  //
  // Call edges are an over-approximation (a name-keyed call graph), so a cycle they
  // introduce is not necessarily real: only a cycle in the direct global→global edges is
  // reported. Anything else falls back to source order, which is what shipped before.
  private orderGlobalsByDependency(program: Program) {
    const globals = program.globals;
    if (globals.length < 2) return;
    const index = new Map<string, number>();
    globals.forEach((g, i) => index.set(g.name, i));

    const scan = (node: unknown, reads: Set<string>, calls: Set<string>) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const c of node) scan(c, reads, calls); return; }
      const n = node as Record<string, any>;
      if (n.kind === "Ident" && typeof n.name === "string" && index.has(n.name)) reads.add(n.name);
      // `Name.thing(...)` is parsed as an enum/static call; it may be a read of a global
      // named `Name` (staticCallOnVariable rewrites it later) or a static method call.
      if (n.kind === "EnumLit" && typeof n.enumName === "string") {
        if (index.has(n.enumName)) reads.add(n.enumName);
        if (typeof n.variant === "string") calls.add(`${n.enumName}.${n.variant}`);
      }
      if (n.kind === "Call" && n.callee?.kind === "Ident") calls.add(n.callee.name);
      if (n.kind === "MethodCall" && typeof n.method === "string") calls.add(n.method);
      for (const k in n) { if (k !== "span") scan(n[k], reads, calls); }
    };

    // Direct reads/calls of every callable, keyed by every name a call site could use.
    const bodies = new Map<string, { reads: Set<string>; calls: Set<string> }>();
    const record = (key: string, body: unknown) => {
      let e = bodies.get(key);
      if (!e) { e = { reads: new Set(), calls: new Set() }; bodies.set(key, e); }
      scan(body, e.reads, e.calls);
    };
    for (const f of program.functions) if (!f.isExtern) record(f.name, f.body);
    for (const im of program.impls) {
      for (const m of im.methods) { record(m.name, m.body); record(`${im.typeName}.${m.name}`, m.body); }
    }

    // Fixpoint: which globals a callable reads once its callees are folded in.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [, e] of bodies) {
        for (const callee of e.calls) {
          const c = bodies.get(callee);
          if (!c) continue;
          for (const r of c.reads) if (!e.reads.has(r)) { e.reads.add(r); changed = true; }
        }
      }
    }

    const directDeps: Set<string>[] = [];
    const allDeps: Set<string>[] = [];
    for (const g of globals) {
      const reads = new Set<string>(), calls = new Set<string>();
      scan(g.value, reads, calls);
      reads.delete(g.name);
      directDeps.push(new Set(reads));
      const all = new Set(reads);
      for (const callee of calls) for (const r of bodies.get(callee)?.reads ?? []) if (r !== g.name) all.add(r);
      allDeps.push(all);
    }

    // Direct cycles are a real error — no order can satisfy them.
    const onDirectCycle = new Set<number>();
    const seen = new Array<number>(globals.length).fill(0); // 0 unvisited, 1 on stack, 2 done
    const walkDirect = (i: number): void => {
      if (seen[i] === 2) return;
      if (seen[i] === 1) { onDirectCycle.add(i); return; }
      seen[i] = 1;
      for (const d of directDeps[i]!) { const j = index.get(d); if (j !== undefined) walkDirect(j); }
      seen[i] = 2;
    };
    for (let i = 0; i < globals.length; i++) walkDirect(i);
    for (const i of onDirectCycle) {
      const g = globals[i]!;
      this.error(`global '${g.name}': initializer depends on itself through another global`, g.span,
        `module-level initializers run in dependency order before main; a cycle has no valid order`);
    }

    // Stable topological order: emit each global after everything it depends on,
    // visiting in source order so unrelated globals keep their original positions.
    const order: typeof globals = [];
    const state = new Array<number>(globals.length).fill(0);
    const visit = (i: number) => {
      if (state[i] !== 0) return; // done, or already on the stack (cycle → source order wins)
      state[i] = 1;
      for (const d of allDeps[i]!) { const j = index.get(d); if (j !== undefined && j !== i) visit(j); }
      state[i] = 2;
      order.push(globals[i]!);
    };
    for (let i = 0; i < globals.length; i++) visit(i);
    globals.length = 0;
    globals.push(...order);
  }

  // Does this body unconditionally exit (return/break/continue) on every path?
  // Used by move tracking to avoid propagating moves from branches that never fall through.
  private bodyAlwaysReturns(body: Stmt[]): boolean {
    for (const s of body) {
      if (s.kind === "Return") return true;
      if (s.kind === "BreakStmt" || s.kind === "ContinueStmt") return true;
      if (s.kind === "IfStmt" && s.elseBody && this.bodyAlwaysReturns(s.thenBody) && this.bodyAlwaysReturns(s.elseBody)) return true;
      if (s.kind === "MatchStmt") {
        // exhaustive matches where every arm always returns
        let allReturn = true;
        for (const arm of s.arms) {
          if (!this.bodyAlwaysReturns(arm.body)) { allReturn = false; break; }
        }
        if (allReturn && s.arms.length > 0) return true;
      }
    }
    return false;
  }

  // Matches already reported as non-exhaustive, keyed by their arm list. "Every arm
  // returns" only implies the match diverges when the arms cover the subject, so
  // reporting unreachable code after one of these would pile a bogus second error
  // onto a file that already has the real one.
  private nonExhaustiveMatches = new WeakSet<MatchArm[]>();

  // Every Stmt kind, so the scan below can recognize a statement list by shape.
  private static readonly STMT_KINDS: ReadonlySet<string> = new Set([
    "LetDecl", "VarDecl", "Assign", "Return", "IfStmt", "WhileStmt", "ExprStmt",
    "MatchStmt", "BreakStmt", "ContinueStmt", "IfLetStmt", "LetElseStmt",
    "UnsafeBlock", "ForInStmt",
  ]);

  // A statement following one that always exits can never run. It has to be an error
  // here rather than dead weight in codegen: emitting it appends instructions to an
  // already-terminated LLVM block, which clang rejects outright.
  //
  // The walk is structural — any array of Stmt nodes, wherever it sits — instead of a
  // hand-written per-node visitor. Statement lists hide inside expressions too (closure
  // bodies, `if`/`match` in value position), and a visitor that misses one silently
  // reopens the hole for that shape.
  private scanUnreachable(node: unknown) {
    if (Array.isArray(node)) {
      if (node.length > 1 && node.every(n => n !== null && typeof n === "object" && TypeChecker.STMT_KINDS.has(n.kind))) {
        const stmts = node as Stmt[];
        for (let i = 0; i + 1 < stmts.length; i++) {
          const stmt = stmts[i]!;
          if (stmt.kind === "MatchStmt" && this.nonExhaustiveMatches.has(stmt.arms)) continue;
          if (!this.bodyAlwaysReturns([stmt])) continue;
          // One report per block: everything after the first dead statement is dead too.
          this.error("unreachable code", stmts[i + 1]!.span,
            "the statement above always exits, so nothing after it in this block can run");
          break;
        }
      }
      for (const child of node) this.scanUnreachable(child);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const value of Object.values(node)) this.scanUnreachable(value);
    }
  }

  private allCopyEnumCache = new Map<string, boolean>();
  private isAllCopyEnum(name: string): boolean {
    const cached = this.allCopyEnumCache.get(name);
    if (cached !== undefined) return cached;
    const info = this.enums.get(name);
    if (!info) { this.allCopyEnumCache.set(name, false); return false; }
    this.allCopyEnumCache.set(name, false);
    const result = [...info.variants.values()].every(v =>
      v.fields.every(f => this.isCopyType(f))
    );
    this.allCopyEnumCache.set(name, result);
    return result;
  }

  private allCopyCache = new Map<string, boolean>();
  private isAllCopyStruct(name: string): boolean {
    // Checked before the cache: Drop impls are registered while checking impl
    // blocks, which can be after a first copy-ness query has already cached
    // `true` for this struct.
    //
    // A type with a Drop impl is never Copy, however plain its fields are.
    // Treating it as Copy meant passing it recorded no move, so the source kept
    // its drop glue and the value was dropped once per copy — TcpStream and
    // TlsStream are exactly this shape (integer fds + a Drop that closes them),
    // so an accepted connection could be closed while still in use.
    if (this.dropImpls.has(name)) return false;
    const cached = this.allCopyCache.get(name);
    if (cached !== undefined) return cached;
    const info = this.structs.get(name);
    if (!info) { this.allCopyCache.set(name, false); return false; }
    // `@noCopy`. A resource handle is an integer — a GL texture name, an fd, an index
    // into someone else's table — so the all-fields-Copy rule above says it is Copy, and
    // move checking never engages for exactly the type most likely to be used after it is
    // released. Drop already forces non-Copy, but a handle whose cleanup has an ordering
    // requirement the compiler can't see (glDeleteTextures needs the context still
    // current) can't take a Drop. This is that case: move-tracked, no destructor.
    if (info.noCopy) { this.allCopyCache.set(name, false); return false; }
    // A raw pointer is Copy as a scalar, so a struct of pointers used to be Copy too, and
    // every owning handle (`Database`, `Lib`, a GL window) was silently duplicable unless
    // its author remembered `@noCopy`. The default is now the safe one: a pointer field
    // makes the struct move-tracked, and `@copy` is the explicit claim that the struct
    // does not own the pointee (a C record, a view into someone else's buffer).
    if (info.pointerField) { this.allCopyCache.set(name, false); return false; }
    // guard against cycles
    this.allCopyCache.set(name, false);
    const result = info.fields.every(f =>
      this.isCopyType(f.type)
    );
    this.allCopyCache.set(name, result);
    return result;
  }

  // Match a generic fn return type (MiloType) against a concrete hint (TypeKind) to infer type params.
  // e.g. retType=Arena<T>, hint={tag:"struct",name:"Arena_i32"} → T=i32
  // Bare `Pair.new(1, "x")` on a generic struct. A generic impl is registered per
  // MONOMORPHIZATION, so at this point nothing named `Pair` carries a static to look up
  // and only the turbofish resolved. Recover the type arguments by unifying the argument
  // types against the generic impl's own parameter list, then let the explicit path run
  // unchanged.
  //
  // The arguments are typed twice: once here to unify, once by the explicit path against
  // the substituted parameter types. Diagnostics from this pass are discarded, because
  // the second pass reports against the concrete types — the ones the user can act on.
  // Returning null anywhere leaves the existing "spell its type arguments" error in
  // place, so a shape this cannot infer is no worse off than before.
  private inferGenericStaticTypeArgs(expr: Extract<Expr, { kind: "EnumLit" }>): MiloType[] | "argError" | null {
    const generic = this.genericStructs.get(expr.enumName);
    if (!generic || generic.typeParams.length === 0) return null;
    let method: import("./ast").Function | undefined;
    for (const t of this.genericImpls.get(expr.enumName) ?? []) {
      const m = t.impl.methods.find(mm => mm.name === expr.variant);
      if (m) { method = m; break; }
    }
    if (!method) return null;
    // A static has no `self`; an instance method reached through `Type.method(...)` is a
    // different call shape and is not this branch's business.
    if (method.params.length > 0 && method.params[0].name === "self") return null;
    if (method.params.length !== expr.args.length) return null;

    const typeMap = new Map<string, TypeKind>();
    const mark = this.diagnostics.length;
    let argFailed = false;
    try {
      for (let i = 0; i < method.params.length; i++) {
        const argType = this.checkExpr(expr.args[i]);
        if (argType.tag === "unknown") { argFailed = true; break; }
        this.inferTypeParamsFromHint(declaredType(method.params[i]), argType, generic.typeParams, typeMap);
      }
    } catch {
      argFailed = true;
    }
    // An argument that did not type is the real error, and it is the one the reader has
    // to fix. Keep its diagnostics and tell the caller to stop, rather than discarding
    // them and reporting "no static method 'new'" — which blames the call for a typo in
    // its argument. On the success path the explicit branch re-reports against the
    // substituted types, so this pass's copies go.
    if (argFailed) return "argError";
    this.diagnostics.length = mark;

    // A parameter no argument mentions stays unbound; there is no struct-level default
    // to fall back on, so the turbofish is still the only spelling for that shape.
    if (generic.typeParams.some(tp => !typeMap.has(tp))) return null;
    return generic.typeParams.map(tp => this.typeKindToMiloType(must(typeMap, tp, "type map")));
  }

  private inferTypeParamsFromHint(retType: MiloType, hint: TypeKind, typeParams: string[], typeMap: Map<string, TypeKind>) {
    // A bare type parameter (`T`, no further args) binds directly to the hint. First
    // binding wins; a later conflicting one surfaces as a field/arg type mismatch in the
    // caller's per-field re-check, so we don't need to diagnose it here.
    // An array/pointer wrapper means the parameter names the ELEMENT, not the whole
    // hint: `[T]` against a `Vec<i64>` binds T to i64. Same rule as the direct-match
    // arm of generic call inference; the arms below do the unwrapping.
    const wrapped = retType.isArray || retType.isPtr || (retType.ptrDepth ?? 0) > 0;
    if (typeParams.includes(retType.name) && !retType.typeArgs?.length && !wrapped) {
      if (!typeMap.has(retType.name)) typeMap.set(retType.name, hint);
      return;
    }
    // A function type: unify parameter against parameter and result against result. Without
    // this arm a callback could not carry a type parameter at all — `fn map<R>(f: (&T) => R)`
    // handed `(x: &i64): i64 => …` bound nothing, so `R` stayed unresolved and the call
    // reported "expected (&i64) => R, got (&i64) => i64", naming a type nobody declared.
    if (retType.isFn && retType.fnParams && retType.fnRet && hint.tag === "fn") {
      for (let i = 0; i < retType.fnParams.length && i < hint.params.length; i++) {
        const p = hint.params[i]!;
        this.inferTypeParamsFromHint(retType.fnParams[i]!, p.tag === "ref" ? p.inner : p, typeParams, typeMap);
      }
      this.inferTypeParamsFromHint(retType.fnRet, hint.ret, typeParams, typeMap);
      return;
    }
    // Recurse through the built-in generic containers so `Vec<T>` / `[T]` fields infer T
    // from a `Vec<i64>` / `[i64]` argument — the case that made `for x in myVec` over a
    // user `MyVec<T>` fail to construct.
    if (retType.typeArgs?.length && (retType.name === "Vec" || retType.name === "Array") && hint.tag === "vec") {
      this.inferTypeParamsFromHint(retType.typeArgs[0], hint.element, typeParams, typeMap);
      return;
    }
    // A `[T]` / `&[T]` parameter also accepts a Vec (that is what auto-borrow hands it,
    // and the two share a representation), so both element positions unify here.
    if (retType.isArray && (hint.tag === "array" || hint.tag === "vec")) {
      // the element MiloType is the decl stripped of its array-ness
      this.inferTypeParamsFromHint({ ...retType, isArray: false, arraySize: null }, hint.element, typeParams, typeMap);
      return;
    }
    if ((retType.ptrDepth ?? (retType.isPtr ? 1 : 0)) > 0 && hint.tag === "ptr") {
      const depth = retType.ptrDepth ?? 1;
      let inner: TypeKind = hint;
      for (let d = 0; d < depth && inner.tag === "ptr"; d++) inner = inner.inner;
      this.inferTypeParamsFromHint({ ...retType, isPtr: false, ptrDepth: 0 }, inner, typeParams, typeMap);
      return;
    }
    // Nested generic struct: `Arena<T>` field vs a concrete `Arena_i32` hint — recurse on
    // each type-arg position so parameters nested arbitrarily deep still resolve.
    if (hint.tag === "struct" && retType.typeArgs) {
      const info = this.structs.get(hint.name);
      if (info?.baseName === retType.name && info.typeArgs) {
        const gs = this.genericStructs.get(retType.name);
        if (gs) {
          for (let i = 0; i < retType.typeArgs.length && i < info.typeArgs.length; i++) {
            this.inferTypeParamsFromHint(retType.typeArgs[i], info.typeArgs[i], typeParams, typeMap);
          }
        }
      }
    }
  }

  // An arm that binds a non-Copy payload by value consumes the subject at ARM
  // ENTRY — codegen zeroes the payload slot there (see extractBindings) — so
  // reading the subject inside that arm sees zeroed data. Arms with no bindings,
  // or only Copy ones, leave the subject intact and may still read it.
  private armConsumesSubject(
    pattern: Pattern,
    enumInfo: { variants: Map<string, { fields: TypeKind[] }> },
  ): boolean {
    if (pattern.kind !== "EnumPattern" || pattern.bindings.length === 0) return false;
    const variant = enumInfo.variants.get(pattern.variant);
    if (!variant) return false;
    const n = Math.min(pattern.bindings.length, variant.fields.length);
    for (let i = 0; i < n; i++) {
      if (!this.isCopyType(variant.fields[i])) return true;
    }
    return false;
  }

  // A combinator that copies one variant's payload straight into its result leaves that
  // payload owned twice over. Consuming the receiver keeps a single owner. Only needed
  // when the forwarded payload is non-Copy — a Copy payload is safe to duplicate, and
  // staying non-consuming there keeps the common `Result<i64, i64>` case ergonomic
  // (same Copy gate as unwrapOr).
  private consumeForwardedPayload(receiver: Expr, forwarded: TypeKind) {
    if (this.isCopyType(forwarded)) return;
    this.tryMove(receiver);
  }

  // Where a move actually lands. An if- or match-expression owns nothing itself:
  // it evaluates to one of its tails, so consuming it consumes whichever tail ran,
  // and the move rule has to be applied to each of them. Before this existed no
  // branch of `tryMoveLeaf` matched a fork at all, so `return if c { d.a } else
  // { d.b }` moved nothing and checked nothing — it compiled and double-freed,
  // while the identical `return d.a` was a compile error. Same for `??`, `!`, `?`
  // and a cast wrapping the same access.
  //
  // Total, with no `default:` — a new Expr kind is a compile error here until it
  // is classified, which is the whole point. See `placesOf` for the same argument.
  private moveTargets(expr: Expr): Expr[] {
    switch (expr.kind) {
      // Handled directly: these are the forms that name storage (or, for a move
      // closure, capture it).
      case "Ident": case "FieldAccess": case "IndexAccess": case "Closure":
        return [expr];

      // Forks: exactly one tail is consumed, but which one is a runtime fact. Move
      // every candidate — a binding consumed on either path is unusable after, and
      // codegen only zeroes the slot the taken branch actually moved.
      case "IfExpr":
        return this.tailTargets([expr.thenBody, expr.elseBody]);
      case "MatchExpr":
        return this.tailTargets(expr.arms.map(a => a.body));
      case "DefaultValue":
        return [expr.operand, expr.default];

      // Pass-throughs: the value comes out of the operand's storage.
      case "Unwrap": case "Propagate":
        return [expr.operand];

      // A cast reinterprets, it does not consume: `s as *u8` on a `&string` takes
      // the buffer's address (unsafe, FFI seam) and leaves `s` exactly as owned as
      // it was. This is where moveTargets and placesOf legitimately disagree —
      // placesOf DOES forward through a cast, because the resulting pointer aliases
      // the operand's storage and the aliasing rules have to see that.
      case "CastExpr":
        return [];

      // Fresh values. Their own operands are moved where those are checked — a
      // struct literal's fields, a call's arguments — not through the result.
      case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
      case "BinOp": case "UnaryOp": case "Call": case "MethodCall": case "StructLit":
      case "ArrayLit": case "ArrayRepeat": case "EnumLit": case "RangeExpr": case "IsExpr":
        return [];
    }
    const _exhaustive: never = expr;
    void _exhaustive;
    return [];
  }

  private tailTargets(bodies: Stmt[][]): Expr[] {
    const out: Expr[] = [];
    for (const body of bodies) {
      // No value tail means the arm diverges (`return`, `break`, an abort) and
      // consumes nothing on that path — there is no place to move.
      const tail = this.tailExprOf(body);
      if (tail) out.push(tail);
    }
    return out;
  }

  private tryMove(expr: Expr) {
    const targets = this.moveTargets(expr);
    // A fork forwards to its tails; anything else is either itself the target or
    // owns nothing. `targets[0] === expr` is the leaf case — recursing on it would
    // not terminate.
    if (targets.length === 1 && targets[0] === expr) { this.tryMoveLeaf(expr); return; }
    for (const t of targets) this.tryMove(t);
  }

  private tryMoveLeaf(expr: Expr) {
    // ident-ok: asks whether the BINDING was declared `&T`, which is a property of the declaration, not of storage
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      // Moving in an owned position through a borrow (`&T`, T non-Copy) would
      // shallow-copy the pointee — e.g. a String's heap buffer — aliasing it
      // with the real owner and double-freeing on drop. Reject; clone to own.
      if (info && info.type.tag === "ref" &&
          !this.isCopyType(info.type.inner)) {
        this.error(`cannot move the borrowed value out of '${expr.name}'`, expr.span,
          `'${expr.name}' is a reference — call .clone() to take an owned copy`);
        return;
      }
      if (info && !this.isCopyType(info.type)) {
        // A pointer borrow does not forbid the move (the header moves, the buffer stays),
        // but the new owner may free that buffer at any time the checker cannot see, so
        // every holder of the pointer is dead from here: `let p = v.ptr(); take(v);
        // strlen(p)` was a heap-use-after-free (h4-ptr-then-move). Two moves keep the
        // holders alive, and set `pointerMoveKeepsHolders`: `forget(v)` (the explicit "the
        // pointer's owner has the buffer now" spelling of the FFI give leg) and a plain
        // `let w = v`, where `carryPointerBorrows` re-attaches the borrow to `w`. The
        // borrow is released from the source either way, so a later revive
        // (`v = Vec.new()`) is not mistaken for a reassignment under `p`.
        if (info.borrowed && this.onlyPointerBorrows(info)) {
          if (!this.pointerMoveKeepsHolders) {
            for (const h of info.borrowHolders ?? []) {
              if (h && !h.info.pointerSourceMoved) h.info.pointerSourceMoved = { root: h.root, call: h.call, line: h.line };
            }
          }
          this.retainBorrows(info, () => false);
        }
        if (info.borrowed) {
          // `borrowed` covers closure capture *and* a live slice/view/iteration borrow —
          // naming only closures misdiagnosed `let s = b.view(); consume(b)`.
          this.error(`cannot move '${expr.name}' because it is borrowed`, expr.span,
            `a closure capture, or a live view or loop over this variable, still points into it — moving it would leave that borrow dangling`);
          return;
        }
        // Partial move: a field already left, so the struct sitting here is no longer
        // the whole value. Handing it on would pass a zeroed field off as real data —
        // the same silent-empty-string result as re-moving the field, one level up.
        const partial = info.movedPlaces && info.movedPlaces.size > 0
          ? [...info.movedPlaces][0]! : null;
        if (partial) {
          this.error(`cannot move '${expr.name}' because '${expr.name}${partial}' was already moved out of it`, expr.span,
            `move the remaining fields individually, or clone '${expr.name}${partial}' at the point it was transferred so '${expr.name}' stays whole`);
          return;
        }
        info.moved = true;
        this.movedExprs.add(expr);
        // Moving a capture out of a `move` closure empties the environment slot it
        // lives in, so the closure cannot run a second time. Record it on the capture
        // and the literal is typed call-once below.
        if (this.closureScopeDepth !== null) {
          const consumedCap = this.currentClosureCaptures?.get(expr.name);
          if (consumedCap) consumedCap.consumedInClosure = true;
        }
        if (this.loopDepth > 0 && this.returnOnlyMovesStack.length > 0) {
          const cur = this.returnOnlyMovesStack[this.returnOnlyMovesStack.length - 1];
          if (this.inReturnInLoop) {
            cur.add(info);
          } else {
            cur.delete(info);
          }
        }
      }
    }
    // Move closure: captures are moved out of the enclosing scope
    if (expr.kind === "Closure" && (expr as any).isMove) {
      const caps = this.closureCaptures.get(expr);
      if (caps) {
        for (const cap of caps) {
          if (this.isCopyType(cap.type)) continue;
          const info = this.lookup(cap.name);
          if (info) {
            info.moved = true;
            this.unfreeze(info);
          }
        }
      }
    }
    // Mark `v[i]` as a move-out when consumed in a move position. Codegen uses this
    // flag to zero the Vec slot so the slot's drop doesn't double-free.
    // But don't move out of borrowed Vecs — mark as borrowed instead.
    if (expr.kind === "IndexAccess") {
      const elemType = this.exprTypes.get(expr);
      if (elemType && !this.isCopyType(elemType)) {
        // The "clone" that stands in for the move duplicates a resource; reject before
        // recording anything (see errorIfResourceIndexRead).
        if (elemType.tag !== "ref" && this.errorIfResourceIndexRead(expr, elemType)) return;
        let objectIsRef = false;
        // ident-ok: asks whether the receiver BINDING was declared `&T`, same reason as tryMoveLeaf above
        if (expr.object.kind === "Ident") {
          const info = this.lookup(expr.object.name);
          if (info && info.type.tag === "ref") objectIsRef = true;
        }
        if (objectIsRef) {
          this.borrowedExprs.add(expr);
        } else {
          this.movedExprs.add(expr);
        }
      }
    }
    // Mark `s.field` as a move-out when a non-Copy field is consumed in a move
    // position. Codegen zeroes the source field so the struct's own drop glue
    // doesn't free a buffer now owned by the moved value (double-free).
    //
    // Behind a `&T` neither half of that is available: zeroing would mutate
    // through a shared borrow, and *not* zeroing hands the caller a second owner
    // of the same heap buffer. `fn describe(d: &Doc): string { return d.text }`
    // used to compile and hand back a String aliasing a pointee the caller was
    // about to drop — printing freed bytes, then double-freeing. It is the same
    // hazard `tryMove` already rejects for a whole `&T` binding, so it gets the
    // same answer: clone to own.
    //
    // `sortByKey`'s key extractor is the sole exemption; see the note below.
    if (expr.kind === "FieldAccess") {
      const fieldType = this.exprTypes.get(expr);
      if (fieldType && !this.isCopyType(fieldType)) {
        const base = this.borrowBasePath(expr);
        if (base === null) {
          const dropTy = this.dropTypeInPath(expr);
          if (dropTy) {
            this.error(`cannot move '${this.describeExpr(expr)}' out of '${dropTy}', which implements Drop`, expr.span,
              `a Drop impl runs against the whole value, so taking a field out of it would leave the destructor reading an empty one — clone the field, or consume the '${dropTy}' whole`);
            return;
          }
          // Owned root: the field really is handed over, so record WHICH field left.
          // Reading it again is caught at the read (checkExpr), not here — a move
          // position reads first, so checking in both places would double-report.
          const place = this.staticFieldPath(expr);
          const rootInfo = place ? this.lookup(place.root) : null;
          if (place && rootInfo) this.markPlaceMoved(rootInfo, place.path);
          this.movedExprs.add(expr);
        } else if (this.keyExtractorDepth === 0) {
          // `replace` is only offered for `&mut`: it swaps something in, which needs write
          // access. Through a shared `&` the only honest answer is to clone.
          const swap = base.mutable
            ? `, or 'replace(${base.root}${base.path}, ...)' to take the field and leave something in its place`
            : "";
          this.error(`cannot move '${base.root}${base.path}' out of the borrowed '${base.root}'`, expr.span,
            `'${base.root}' is a reference — call .clone() to take an owned copy${swap}`);
        }
        // Inside a sortByKey extractor: neither error nor move-mark. Not marking it moved
        // matters as much as not erroring — marking it makes codegen zero the source field,
        // and that field lives in the container being sorted, which silently emptied every
        // name (tests/fixtures/sortByKeyString.milo).
        //
        // The exemption is deliberately keyed to sortByKey alone, and fail-closed: a new
        // combinator is subject to the rule until someone proves it does not retain the
        // value. Exempting *closures* generally was unsound — `map` retains what its closure
        // returns, so `users.map((u: &User) => u.name)` built a Vec<string> aliasing the
        // users' buffers and double-freed on drop (a live abort, exit 133).
      }
    }
  }

  // Walks `a.b.c` and `v[i].f` down to the variable the read ultimately comes
  // out of, and reports it when that variable is a `&T`/`&mut T` binding. The old
  // check only looked one level up (`expr.object.kind === "Ident"`), so a nested
  // `d.inner.text` slipped past it entirely.
  //
  // Returns the whole accessor path too, so the diagnostic can say which field is being
  // moved rather than only which variable it came from. An index becomes `[…]` — the
  // subscript is not re-evaluated for the message, and naming the exact element would
  // imply a precision the check does not have.
  // The borrow a place reaches through, if any: the root binding is a `&T`/`&mut T`
  // and `path` spells the steps taken through it, for the diagnostic.
  private borrowBaseOfPlace(p: { root: string; steps: PlaceStep[] }): { root: string; path: string; mutable: boolean } | null {
    const info = this.lookup(p.root);
    if (!info || info.type.tag !== "ref") return null;
    return { root: p.root, path: p.steps.map(stepLabel).join(""), mutable: info.type.mutable };
  }

  private borrowBasePath(expr: Expr): { root: string; path: string; mutable: boolean } | null {
    const p = this.soloPath(expr);
    return p ? this.borrowBaseOfPlace(p) : null;
  }

  // Never returns null: every failure path is `fatal()`, because there is no such
  // thing as a half-resolved assignment target — the callers that used to null-check
  // had nothing to do with the answer but bail, and one that forgot would assign
  // through a place the diagnostic had just said does not exist.
  // Mark the variable a place expression is rooted at as read. Used where an operation
  // takes the old value out of a place (`replace`), which the plain assignment path does
  // not count as a use.
  private markPlaceRead(expr: Expr) {
    // Root resolved through the place walker rather than by stepping over the two node
    // kinds this loop used to know. Reading `o!.field` marks `o` read; the old walk saw an
    // Unwrap, gave up, and left the binding looking unused.
    const ap = this.accessPath(expr);
    if (!ap) return;
    const info = this.lookup(ap.root);
    if (info) info.read = true;
  }

  private resolveAssignTarget(expr: Expr): { type: TypeKind; mutable: boolean } {
    const sp = expr.span;
    // ident-ok: the Ident base case of a walk that recurses through FieldAccess/IndexAccess itself
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) this.fatal(`undefined variable '${expr.name}'`, sp, this.nameHint(expr.name));
      if (info.type.tag === "ref" && info.type.mutable) {
        // Writing THROUGH a `&mut` is what one is for, so it counts as a use. Without
        // this a parameter whose whole job is to be written — `fn bump(n: &mut E)` that
        // only assigns to `n` — was reported as an unused variable, and the suggested
        // fix (rename to `_n`) would have broken the code that writes it.
        info.read = true;
        this.setType(expr, info.type.inner);
        return { type: info.type.inner, mutable: true };
      }
      // For ref locals (e.g. `var view: &string`), reassignment replaces the
      // slice, not the underlying data — keep the ref type intact.
      if (info.type.tag === "ref" && info.mutable) {
        this.setType(expr, info.type);
        return { type: info.type, mutable: true };
      }
      const t = this.deref(info.type);
      this.setType(expr, t);
      return { type: t, mutable: info.mutable };
    }
    if (expr.kind === "FieldAccess") {
      this.placeBaseDepth++;
      let objType = this.checkExpr(expr.object);
      this.placeBaseDepth--;
      // auto-deref *Struct for field assignment (always mutable through ptr)
      let throughPtr = false;
      if (objType.tag === "ptr" && objType.inner.tag === "struct") {
        objType = objType.inner;
        throughPtr = true;
      }
      if (objType.tag === "struct") {
        const info = this.structs.get(objType.name);
        if (!info) this.fatal(`unknown struct '${objType.name}'`, sp);
        const field = info.fields.find(f => f.name === expr.field);
        if (!field) this.fatal(`struct '${objType.name}' has no field '${expr.field}'`, sp, memberHint(expr.field, this.fieldCandidates(objType)));
        this.setType(expr, field.type);
        const mutable = throughPtr ? true : this.isRootMutable(expr.object);
        return { type: field.type, mutable };
      }
      this.fatal(`cannot access field on non-struct type ${this.show(objType)}`, sp);
    }
    if (expr.kind === "IndexAccess") {
      const objType = this.checkExpr(expr.object);
      this.checkExpr(expr.index);
      if (objType.tag === "array") {
        this.setType(expr, objType.element);
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      if (objType.tag === "vec") {
        this.setType(expr, objType.element);
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      if (objType.tag === "ptr") {
        this.setType(expr, objType.inner);
        return { type: objType.inner, mutable: true };
      }
      this.fatal(`cannot index non-array type ${this.show(objType)}`, sp);
    }
    if (expr.kind === "UnaryOp" && expr.op === "*") {
      const ot = this.checkExpr(expr.operand);
      if (ot.tag === "ptr") {
        this.setType(expr, ot.inner);
        return { type: ot.inner, mutable: true };
      }
      if (ot.tag === "heap") {
        this.setType(expr, ot.inner);
        return { type: ot.inner, mutable: true };
      }
      this.fatal(`cannot dereference type '${this.show(ot)}' for assignment`, sp);
    }
    // `STORE.field = x` where STORE is a capitalized *variable* (typically a
    // module-level `var`) parses as an EnumLit — the parser can't know STORE
    // isn't a type. checkExpr already recovers this for reads; without the same
    // recovery here, a mutable global struct was writable field-by-field
    // nowhere, which reads as "Milo has no mutable globals".
    if (expr.kind === "EnumLit" && this.rewriteStaticToMember(expr)) {
      return this.resolveAssignTarget(expr);
    }
    this.fatal("invalid assignment target", sp);
  }

  // Walk to the root identifier of an lvalue; if it is a closure capture being
  // mutated in place, record that so the value isn't move-captured out from
  // under the caller (which still needs to see the mutation / drop it).
  private markCaptureMutated(expr: Expr) {
    const capRoot = this.rootNameOf(expr);
    if (capRoot !== null && this.closureScopeDepth !== null) {
      const cap = this.currentClosureCaptures?.get(capRoot);
      if (cap) cap.mutatedInClosure = true;
    }
  }

  // Mirrors codegen's getConstantInitializer: what can actually be emitted as
  // an LLVM constant for a module-scope global. Empty string/vec are allowed
  // (they ARE zeroinitializer); a non-empty string would need heap allocation.
  //
  // It must never claim MORE than codegen folds: `--no-entry` rejects a module on
  // this answer (nothing calls the init routine there), so a "const" the codegen
  // side emits as zeroinitializer would wave through a silent zero. Codegen's side
  // is Codegen.isFullyConstInit / tryConstantExpr; a case added here needs one there.
  private isConstGlobalInit(e: Expr): boolean {
    switch (e.kind) {
      case "IntLit":
      case "FloatLit":
      case "BoolLit":
      case "CharLit":
        return true;
      case "StringLit":
        return e.value.length === 0;
      case "BinOp":
        return this.isConstGlobalInit(e.left) && this.isConstGlobalInit(e.right);
      case "UnaryOp":
        return this.isConstGlobalInit(e.operand);
      case "CastExpr":
        return this.isConstGlobalInit(e.operand);
      case "ArrayLit":
        return e.elements.every((el) => this.isConstGlobalInit(el));
      case "ArrayRepeat":
        return this.isConstGlobalInit(e.value);
      case "StructLit":
        return e.fields.every((f) => this.isConstGlobalInit(f.value));
      case "EnumLit":
        // A static method call (`Arena<T>.new()`) parses as an EnumLit and is recorded in
        // `staticCalls` — it is a real call, not a variant construction, and folding it
        // into a constant is the exact silent-zero this guard exists to stop. Two
        // module-scope `Arena<T>.new()` globals both took id 0 that way, so a handle from
        // one resolved in the other. Only genuine construction is const.
        if (this.staticCalls.has(e)) return false;
        return e.args.every((a) => this.isConstGlobalInit(a));
      default:
        return false;
    }
  }

  // An integer expression composed entirely of literals (and arithmetic on
  // them) — its width is unconstrained and can adopt a context type.
  // The float mirror of isConstIntExpr/retypeConstInt. A float literal defaults to
  // f64, so `1.0 - someF32` used to be a hard type error with no way to write the
  // literal as f32 — you needed a named f32 constant. A constant-float subtree now
  // adopts the other operand's width, exactly like the integer case.
  private isConstFloatExpr(e: Expr): boolean {
    if (e.kind === "FloatLit") return true;
    if (e.kind === "BinOp") return this.isConstFloatExpr(e.left) && this.isConstFloatExpr(e.right);
    if (e.kind === "UnaryOp") return this.isConstFloatExpr(e.operand);
    return false;
  }

  private retypeConstFloat(e: Expr, t: TypeKind) {
    if (e.kind === "FloatLit") { this.exprTypes.set(e, t); return; }
    if (e.kind === "BinOp") {
      this.retypeConstFloat(e.left, t); this.retypeConstFloat(e.right, t); this.exprTypes.set(e, t); return;
    }
    if (e.kind === "UnaryOp") { this.retypeConstFloat(e.operand, t); this.exprTypes.set(e, t); return; }
  }

  private isConstIntExpr(e: Expr): boolean {
    if (e.kind === "IntLit" || e.kind === "CharLit") return true;
    if (e.kind === "BinOp") return this.isConstIntExpr(e.left) && this.isConstIntExpr(e.right);
    if (e.kind === "UnaryOp") return this.isConstIntExpr(e.operand);
    return false;
  }

  // Retype a constant-int subtree to `t`. Leaves go through checkExprWithHint
  // so per-literal range/overflow checks still fire against the target type.
  private retypeConstInt(e: Expr, t: TypeKind) {
    if (e.kind === "IntLit" || e.kind === "CharLit") { this.checkExprWithHint(e, t); return; }
    if (e.kind === "BinOp") {
      this.retypeConstInt(e.left, t); this.retypeConstInt(e.right, t); this.exprTypes.set(e, t);
      // Re-check overflow against the (possibly narrower) target: the folded result can exceed
      // t even when each leaf fits it (`let x: i32 = 2147483647 + 1`). checkExpr already ran this
      // against the i64 literal default, so a coercion down to a hint needs its own check.
      if (t.tag === "int" && e.left.kind === "IntLit" && e.right.kind === "IntLit") {
        this.checkConstOverflow(e.left.value, e.right.value, e.op, t, e.span);
      }
      return;
    }
    if (e.kind === "UnaryOp") {
      // `-<literal>` at exactly signed INT_MIN (e.g. -2147483648 for i32) is valid even though
      // the bare magnitude overflows the type; range-check the negated value, not the leaf, so
      // the per-literal check below doesn't reject the magnitude in isolation.
      if (e.op === "-" && e.operand.kind === "IntLit" && t.tag === "int" && t.signed) {
        const min = -(2n ** BigInt(t.bits - 1));
        const max = 2n ** BigInt(t.bits - 1) - 1n;
        const neg = -e.operand.value;
        if (neg < min || neg > max) {
          this.error(`integer literal ${e.op}${e.operand.value} overflows i${t.bits} (range ${min}..${max})`, e.span);
        }
        this.exprTypes.set(e.operand, t); this.exprTypes.set(e, t); return;
      }
      this.retypeConstInt(e.operand, t); this.exprTypes.set(e, t); return;
    }
  }

  // Phase 3a (call-site exclusivity): a variable must not appear at one call as
  // both a `&var`/`&mut` argument and the root of a `&` argument. A mutation
  // through the mutable borrow could invalidate the shared reference (e.g.
  // `push` reallocates), leaving it dangling. Pure argument-origin check.
  // `sp` is the call's own span, used only as a fallback when an argument has
  // none; both may be undefined, and the diagnostic then carries no source context.
  private checkCallSiteExclusivity(args: Expr[], sp: Span | undefined) {
    const muts: { root: string; fields: string[] | null; span: Span | undefined }[] = [];
    const shared: { root: string; fields: string[] | null; via?: string }[] = [];
    for (const arg of args) {
      const ab = this.borrowModeOf(arg);
      if (!ab) {
        // An inline `v.ptr()` / `s.cstr()` argument is a shared borrow of its source for
        // the duration of the call: `growRead(v.ptr(), v)` with `v: &mut Vec<u8>` pushed
        // through the reference and then read the stale pointer (h4-inline-alias).
        for (const pv of this.pointerViewsIn(arg)) {
          const p = this.accessPath(pv.source);
          if (p) shared.push({ root: p.root, fields: p.fields, via: pv.call });
        }
        continue;
      }
      const p = this.accessPath(arg);
      if (!p) continue;
      if (ab.mutable) muts.push({ root: p.root, fields: p.fields, span: arg.span ?? sp });
      else shared.push({ root: p.root, fields: p.fields });
    }
    // Two accesses off the same root can alias only if their field paths overlap —
    // one a prefix of the other. Divergence at distinct field names (e.g. self.pos vs
    // self.src) is provably disjoint, so a &mut into one can't invalidate a & into the
    // other. An index/deref anywhere (fields === null) is imprecise → treated as overlap.
    const overlaps = (a: string[] | null, b: string[] | null): boolean => {
      if (a === null || b === null) return true;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    for (const m of muts) {
      for (const s of shared) {
        if (m.root === s.root && overlaps(m.fields, s.fields)) {
          this.error(`'${m.root}' is borrowed mutably and shared in the same call`, m.span,
            s.via
              ? `a mutation through the '&var'/'&mut' argument could reallocate '${m.root}' under '${s.via}', which points into its buffer: take the pointer after the call, or split the call into two statements`
              : `a mutation through the '&var'/'&mut' argument could invalidate the '&' argument into '${m.root}' — clone the shared argument inline (e.g. 'x.clone()') or split the call into two statements`);
        }
      }
    }
    // Two `&mut` arguments where one place is an ancestor of the other (a container
    // and something derived from it, e.g. `v` and `v[0]`) are UB: mutating through
    // the container arg (a `push` that reallocs) frees the storage the descendant
    // arg points into — a use-after-free the muts×shared check above misses because
    // both sides are mutable. Index-aware steps distinguish an ancestor/descendant
    // pair (flagged) from two siblings like `v[i]`/`v[j]` (a legitimate two-element
    // borrow, not flagged). Identical non-indexed places (`v` twice) are two `&mut`
    // to the same object and are flagged as well.
    const mutSteps = args.map(a => (this.borrowModeOf(a)?.mutable ? this.accessSteps(a) : null));
    for (let i = 0; i < args.length; i++) {
      for (let j = i + 1; j < args.length; j++) {
        const a = mutSteps[i], b = mutSteps[j];
        if (!a || !b || a.root !== b.root) continue;
        const ra = this.constSliceRange(args[i]), rb = this.constSliceRange(args[j]);
        if (ra && rb && a.steps.length === b.steps.length) {
          // Two `&mut` windows into one buffer with literal bounds: disjointness is
          // decidable right here, so overlap is a rejectable aliasing violation rather
          // than the "may be distinct elements" case aliasesByContainment lets pass.
          // Non-literal bounds stay permissive — that split needs the prover.
          if (ra.lo < rb.hi && rb.lo < ra.hi) {
            this.error(`'${a.root}' is borrowed mutably twice in the same call`, args[i].span ?? args[j].span ?? undefined,
              `the ranges ${ra.lo}..${ra.hi} and ${rb.lo}..${rb.hi} overlap, so both arguments are '&mut' views of the same elements — make the windows disjoint or split the call into two statements`);
          }
          continue;
        }
        if (this.aliasesByContainment(a.steps, b.steps)) {
          const sp = args[i].span ?? args[j].span ?? undefined;
          this.error(`'${a.root}' is borrowed mutably twice in the same call`, sp,
            `one argument is a container and the other borrows into it (or they are the same place) — a mutation through one (e.g. a 'push' that reallocates) could invalidate the other; split the call into two statements or clone one argument`);
          continue;
        }
      }
    }
  }

  // The literal bounds of `v[lo..hi]` (which parses as `v.slice(lo, hi)`), or null when
  // either bound is anything but an integer literal. Only the literal case is decidable
  // without the prover, and only equal `hi`/`lo` ordering is assumed — a reversed range
  // is a runtime bounds error, not this check's business.
  private constSliceRange(e: Expr): { lo: bigint; hi: bigint } | null {
    if (e.kind !== "MethodCall" || e.method !== "slice" || e.args.length !== 2) return null;
    const [lo, hi] = e.args;
    if (lo.kind !== "IntLit" || hi.kind !== "IntLit") return null;
    return { lo: lo.value, hi: hi.value };
  }

  // How a call argument borrows its root, for the exclusivity checks. Most args are
  // auto-borrowed (bare value → `&T`/`&mut T` param), but a slice expression is ALREADY
  // a reference — `f(v, v[0..2])` never enters `autoBorrowed`, so before this the
  // container arg and a view into it slipped past both checks and the callee's `push`
  // freed the storage the view pointed into (use-after-free in safe code). Any arg whose
  // checked type is a ref counts as a borrow of its access path, whatever produced it.
  private borrowModeOf(arg: Expr): { mutable: boolean } | null {
    const ab = this.autoBorrowed.get(arg);
    if (ab) return ab;
    const t = this.exprTypes.get(arg);
    return t?.tag === "ref" ? { mutable: t.mutable } : null;
  }

  // ── Places ────────────────────────────────────────────────────────────────
  //
  // A *place* is storage an expression evaluates to. `d.a` is the `a` field of
  // whatever `d` names. `n + 1` is not a place at all — it is a fresh value that
  // aliases nothing.
  //
  // Every aliasing rule in this checker asks the same question ("what storage
  // does this expression reach, and through whose binding"), and each one used
  // to ask it with its own walker: accessSteps, accessPath, borrowBasePath,
  // isRootMutable, errorIfFrozen, freezeViewSource, plus two more inside the
  // view-provenance code. Eight walkers, eight different sets of node kinds, and
  // every kind none of them listed was a silent hole — `return d.a` was rejected
  // as a move out of a borrow while `return if c { d.a } else { d.b }` compiled
  // and double-freed, because no walker knew what an IfExpr was.
  //
  // So `placesOf` is TOTAL over the expression grammar and fails CLOSED. The
  // switch has no `default`: the `never` assignment at the end makes a newly
  // added Expr kind a compile error here until someone classifies it, and the
  // conservative classification (`opaque` — "storage I cannot name") is the one
  // that rejects rather than the one that lets code through.
  //
  // An expression yields a SET of places because control flow forks: the tails
  // of an if- or match-expression are each a candidate result. Callers must
  // satisfy their rule for *every* place in the set, never just the first.
  private placesOf(e: Expr): Place[] {
    switch (e.kind) {
      // Fresh values. Own themselves, reach no binding's storage.
      case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
      case "ArrayLit": case "ArrayRepeat": case "StructLit": case "EnumLit":
      case "RangeExpr": case "IsExpr": case "Closure":
        return [VALUE];

      // `o ?? d` is a fork like an if-expression: the result is either o's
      // payload — which lives in o's storage — or the default.
      case "DefaultValue":
        return [...this.stepInto(e.operand, PAYLOAD), ...this.placesOf(e.default)];

      // Arithmetic, comparison and concatenation all build a new value. `&x` is
      // not an expression in this language, so no BinOp/UnaryOp yields a borrow.
      case "BinOp":
        return [VALUE];
      case "UnaryOp":
        return e.op === "*" ? this.stepInto(e.operand, DEREF) : [VALUE];

      case "Ident":
        return [{ tag: "path", root: e.name, steps: [] }];
      case "FieldAccess":
        return this.stepInto(e.object, { tag: "field", name: e.field });
      case "IndexAccess":
        return this.stepInto(e.object, INDEX);

      // The payload of `o!` / `o?` lives inside `o`'s storage, so unwrapping a
      // borrowed Option reaches through the borrow exactly as a field access does.
      case "Unwrap": case "Propagate":
        return this.stepInto(e.operand, PAYLOAD);

      // A cast reinterprets its operand in place — `p as *u8` keeps pointing at
      // the same storage. Forwarding can only over-report (a cast of a non-Copy
      // value is not expressible), and over-reporting is the safe direction.
      case "CastExpr":
        return this.placesOf(e.operand);

      // A method returning a view (`v[a..b]`, which desugars to `.slice(a, b)`,
      // or a user method returning `&[T]`/`&string`) points into its receiver's
      // storage; provenance is enforced at the definition by checkViewProvenance,
      // so the receiver is the root. Any other method returns an owned value.
      // A missing type is not a licence to assume the safe answer.
      case "MethodCall": {
        const t = this.exprTypes.get(e);
        if (!t) return [OPAQUE];
        return t.tag === "ref" ? this.stepInto(e.object, INDEX) : [VALUE];
      }

      // Free functions cannot return a view (errorIfRefReturn rejects a `&T`
      // return without a self receiver), so a call's result is owned. If one
      // ever slips through as a ref, name it unknown rather than fresh.
      case "Call": {
        const t = this.exprTypes.get(e);
        return t && t.tag === "ref" ? [OPAQUE] : [VALUE];
      }

      // Control-flow forks: the result is one of the branch tails. A branch with
      // no value tail either diverges (contributes no place) or ends in a form
      // tailExprOf does not model — indistinguishable here, so both are OPAQUE.
      case "IfExpr":
        return this.tailPlaces([e.thenBody, e.elseBody]);
      case "MatchExpr":
        return this.tailPlaces(e.arms.map(a => a.body));
    }
    // No `default:` on purpose. If this line stops compiling, a new Expr kind was
    // added — classify it above. Reaching it at runtime means the parser produced
    // a node the type says cannot exist, so fail closed rather than guess.
    const _exhaustive: never = e;
    void _exhaustive;
    return [OPAQUE];
  }

  // Freeze the storage a `for-in` iterates, for the whole loop.
  //
  // Taken ONCE, before the per-container dispatch, so every iteration shape inherits it
  // — vec, hashmap, array, string, user iterator, and whatever is added next. It used to
  // be re-derived inside four separate arms, each keyed to `iterable.kind === "Ident"`,
  // so `for x in v` was frozen and `for x in b.items` was frozen by nobody: pushing to
  // that field inside its own loop reallocated the buffer the loop reads. Vec and
  // HashMap were both heap-use-after-free in safe code (ASan, 2026-08-16).
  //
  // The root is resolved through the place walker rather than matched as a node kind,
  // which is the whole point: a new way to SPELL the iterable inherits the rule instead
  // of escaping it. The recorded path is what keeps this from over-rejecting — mutating
  // a different field of the same struct does not collide with the borrow.
  private freezeIterable(iterable: Expr): VarInfo | null {
    return this.freezeRootOf(iterable, "iteration");
  }

  // Freeze the root of any borrowed place, resolved through the place walker.
  //
  // This replaces three hand-rolled copies of the same loop — `while (root.kind ===
  // "FieldAccess" || root.kind === "IndexAccess") root = root.object` then match `Ident`
  // — which lived in the string-view for-in, the slice-view expression and the
  // string-view expression. Each knew exactly two ways to step toward a root, so a place
  // spelled any other way (an unwrap, a cast, the tail of a fork) resolved to no root and
  // was silently not frozen. That is the same shape as the for-in freeze that was keyed
  // to a bare `Ident` and turned out to be a use-after-free; these three had two steps
  // instead of one, which makes them narrower holes rather than different ones.
  //
  // `accessPath` goes through `soloPath`/`placesOf`, which is total over the expression
  // grammar and fails closed, so a new `Expr` kind inherits this rule instead of escaping
  // it. Returns null when the place has no single named root, which is the honest answer
  // and leaves the caller no worse off than the hand-rolled walk did.
  // The root binding a place is reached from, resolved through the place walker. Replaces
  // the hand-rolled `while (kind === "FieldAccess" || kind === "IndexAccess")` loops, each
  // of which knew exactly two ways to step toward a root and silently answered "no root"
  // for anything spelled otherwise.
  private rootNameOf(e: Expr): string | null {
    return this.accessPath(e)?.root ?? null;
  }

  private freezeRootOf(place: Expr, kind: BorrowKind = "view"): VarInfo | null {
    const ap = this.accessPath(place);
    if (!ap) return null;
    const info = this.lookup(ap.root);
    if (!info) return null;
    this.freeze(info, place, kind);
    return info;
  }

  // Extend every place the base expression reaches by one step. A step off a
  // fresh value stays fresh (`makeDoc().a` is a field of a temporary, which owns
  // itself); a step off unnamed storage stays unnamed.
  private stepInto(base: Expr, step: PlaceStep): Place[] {
    return this.placesOf(base).map(p =>
      p.tag === "path" ? { tag: "path", root: p.root, steps: [...p.steps, step] } as Place : p);
  }

  private tailPlaces(bodies: Stmt[][]): Place[] {
    const out: Place[] = [];
    for (const body of bodies) {
      const tail = this.tailExprOf(body);
      if (!tail) { out.push(OPAQUE); continue; }
      out.push(...this.placesOf(tail));
    }
    return out;
  }

  // The single-place view the older callers want: a place set collapses to one
  // path only when every member agrees on it. A set containing a value, unnamed
  // storage, or two different roots has no single answer, and `null` here means
  // "no single named place" — callers that must fail closed check the full set.
  private soloPath(e: Expr): { root: string; steps: PlaceStep[] } | null {
    const places = this.placesOf(e);
    if (places.length === 0) return null;
    const first = places[0];
    if (first.tag !== "path") return null;
    for (const p of places.slice(1)) {
      if (p.tag !== "path" || p.root !== first.root || !stepsEq(p.steps, first.steps)) return null;
    }
    return { root: first.root, steps: first.steps };
  }

  // A field-only path off a named binding — the only shape whose move state can be
  // decided at compile time. Any index/deref/payload step means the storage the
  // expression names depends on a runtime value, so there is no place to mark.
  private staticFieldPath(e: Expr): { root: string; path: string } | null {
    const p = this.soloPath(e);
    if (!p || p.steps.length === 0) return null;
    if (p.steps.some(s => s.tag !== "field")) return null;
    return { root: p.root, path: p.steps.map(stepKey).join("") };
  }

  // The moved place that covers `path`: the path itself, or any prefix of it —
  // once `p.a` is gone so is `p.a.b`, because the buffer they share left with it.
  private movedPlaceCovering(info: VarInfo, path: string): string | null {
    if (!info.movedPlaces) return null;
    for (const m of info.movedPlaces) {
      if (path === m || path.startsWith(`${m}.`)) return m;
    }
    return null;
  }

  // Assigning to a place puts a value back: it and everything under it are live
  // again. Without this, `p.a = "new"` would leave `p.a` permanently unusable.
  // Rust's E0509: the type a field is being moved out of implements Drop. Returns the
  // offending type name, checking every base in the chain — moving `p.i.t` leaves both
  // `p.i` and `p` incomplete, so a Drop on either is a problem.
  //
  // Milo's answer before this check was worse than either alternative: codegen sees a
  // partially moved local and skips its drop glue entirely, so `drop` never runs at all
  // and whatever it was going to release — a file, a GL name, a lock — leaks with no
  // diagnostic. Running it instead would hand the destructor a zeroed field, which is
  // the silent-wrong-data outcome. A `Drop` impl is written against the whole value, so
  // the honest answer is that the value cannot be taken apart.
  private dropTypeInPath(e: Expr): string | null {
    let cur: Expr = e;
    // ident-ok: inspects the TYPE at each step, not just the root, so it needs the walk itself; a root-only resolver would lose the intermediate types this rule is about
    while (cur.kind === "FieldAccess" || cur.kind === "IndexAccess") {
      cur = cur.object;
      const t = this.exprTypes.get(cur);
      const bare = t && t.tag === "ref" ? t.inner : t;
      if (bare && bare.tag === "struct" && this.dropImpls.has(bare.name)) return bare.name;
    }
    return null;
  }

  private markPlaceMoved(info: VarInfo, path: string) {
    (info.movedPlaces ??= new Set()).add(path);
  }

  private clearMovedPlace(info: VarInfo, path: string | null) {
    if (!info.movedPlaces) return;
    if (path === null) { info.movedPlaces.clear(); return; }
    for (const m of [...info.movedPlaces]) {
      if (m === path || m.startsWith(`${path}.`)) info.movedPlaces.delete(m);
    }
  }

  // Index-aware access path: each step is a field name (".f") or an opaque index
  // ("[]"). Unlike accessPath (which collapses to fields=null at the first index),
  // this preserves depth so an ancestor/descendant relationship survives an index.
  private accessSteps(e: Expr): { root: string; steps: string[] } | null {
    const p = this.soloPath(e);
    return p ? { root: p.root, steps: p.steps.map(stepKey) } : null;
  }

  // True when the two step chains (same root) are in a containment relation that
  // makes aliasing them mutably unsafe: one is a proper prefix of the other (an
  // ancestor container and a descendant), or they are identical with no index step
  // (provably the same concrete place). Two chains that diverge, or are equal but
  // pass through an index (siblings that may be distinct elements), are not flagged.
  private aliasesByContainment(a: string[], b: string[]): boolean {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; // diverge → disjoint
    if (a.length !== b.length) return true;                      // proper prefix → ancestor/descendant
    return !a.includes("[]");                                    // identical: same place unless index-qualified
  }

  // Access path for exclusivity: root variable + chain of field names. `fields` is
  // null when the access goes through an index, deref or payload, where offsets are
  // dynamic and disjointness can't be proven — callers treat null as "may alias".
  private accessPath(e: Expr): { root: string; fields: string[] | null } | null {
    const p = this.soloPath(e);
    if (!p) return null;
    const fields: string[] = [];
    for (const s of p.steps) {
      if (s.tag !== "field") return { root: p.root, fields: null };
      fields.push(s.name);
    }
    return { root: p.root, fields };
  }

  private isRootMutable(expr: Expr): boolean {
    this.markCaptureMutated(expr);
    // ident-ok: the Ident base case of isRootMutable, which IS the mutability walk over places
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      return info?.mutable ?? false;
    }
    if (expr.kind === "FieldAccess") return this.isRootMutable(expr.object);
    if (expr.kind === "IndexAccess") return this.isRootMutable(expr.object);
    // raw pointer and box derefs are always mutable (unsafe required separately)
    if (expr.kind === "UnaryOp" && (expr.op === "*")) return true;
    return false;
  }

  // Phase 2 (use-after-invalidate): mutating a collection while a borrow into it is
  // live (string slice binding, for-in iteration) can realloc or free the memory the
  // borrow points into. Assignment freezing is handled in the Assign case; this guards
  // mutating method calls. In-place element assignment (v[i] = x) stays legal — it
  // never reallocs, and rewriting elements mid-iteration is a common safe pattern.
  // Every binding this expression could be mutating must be unfrozen — a fork like
  // `(if c { a } else { b }).push(x)` reaches two of them, and checking only the
  // first would let the other's live borrow dangle.
  private errorIfFrozen(obj: Expr, action: string, sp?: Span) {
    for (const place of this.placesOf(obj)) {
      if (place.tag !== "path") continue;
      const info = this.lookup(place.root);
      if (!info) continue;
      const ph = this.pointerBorrowAgainst(info, obj);
      if (ph) {
        this.error(`'${this.describeExpr(obj)}' may reallocate here while '${ph.name}' still points into its buffer (from '${ph.call}' on line ${ph.line})`, sp,
          this.pointerHint(ph));
        return;
      }
      if (this.frozenAgainst(info, obj)) {
        this.error(`cannot ${action} '${place.root}' because it is borrowed`, sp,
          `a slice or loop iteration over this variable is still live — mutating it could move memory the borrow points into`);
        return;
      }
    }
  }

  // Auto-borrow a call argument; passing a frozen var by mutable ref is the same
  // hazard as calling a mutating method on it (the callee may realloc/free it).
  private setAutoBorrowChecked(arg: Expr, mutable: boolean, sp?: Span) {
    if (mutable) {
      // Only for a value being *turned into* a borrow. An argument that is already
      // a reference — a slice like `v[0..2]` — is not competing with the freeze, it
      // IS one, and whether two of them may coexist is checkCallSiteExclusivity's
      // call: it compares access paths and knows `v[0..2]` and `v[2..4]` are
      // disjoint, which this check cannot see (any index collapses its path to
      // "may alias"). Asking both means the blunt one always wins and
      // `fill(v[0..2], v[2..4])` — a supported disjoint split — stops compiling.
      if (this.exprTypes.get(arg)?.tag !== "ref") this.errorIfFrozen(arg, "pass", sp);
      // Passing an immutable binding to a '&mut' param mutates it through the
      // call — the same hazard method receivers already reject ("cannot push to
      // immutable Vec"). A 'let' claims immutability *and* SSA-register storage;
      // taking its address for '&mut' forces a spill and silently breaks both.
      // Free-function '&mut' args were the one path that skipped this check.
      // Every binding the argument could name has to be mutable: a fork reaches
      // more than one, and it is the immutable arm that would be written through.
      for (const place of this.placesOf(arg)) {
        if (place.tag !== "path") continue;
        const info = this.lookup(place.root);
        if (info && !info.mutable && info.type.tag !== "ref") {
          this.error(`cannot pass immutable '${this.describeExpr(arg)}' as a '&mut' argument`, sp,
            `declare with 'var' to make it mutable`);
          break;
        }
      }
    }
    this.autoBorrowed.set(arg, { mutable });
  }

  // Freeze the receiver while checking a callback that iterates it — the callback
  // mutating its own iteration source (v.each(fn(x){ v.push(x) })) is the same
  // realloc hazard as for-in. Returns the VarInfo to release afterward, or null
  // if an outer borrow already owns the freeze.
  private borrowDuringCallback(obj: Expr): VarInfo | null {
    const cbRoot = this.rootNameOf(obj);
    if (cbRoot === null) return null;
    const info = this.lookup(cbRoot);
    if (!info || info.borrowed) return null;
    this.freeze(info, obj);
    return info;
  }

  private describeExpr(expr: Expr): string {
    if (expr.kind === "Ident") return expr.name;
    if (expr.kind === "FieldAccess") return `${this.describeExpr(expr.object)}.${expr.field}`;
    if (expr.kind === "IndexAccess") return `${this.describeExpr(expr.object)}[...]`;
    return "<expr>";
  }

  private checkExprWithHint(expr: Expr, hint: TypeKind | null): TypeKind {
    // Unwrap Option<T> hint to T for non-null/non-None expressions (enables auto-wrapping)
    if (hint && expr.kind !== "EnumLit") {
      const inner = this.optionInnerType(hint);
      if (inner) hint = inner;
    }
    if (hint && (expr.kind === "IntLit" || expr.kind === "CharLit") && hint.tag === "int") {
      if (expr.kind === "IntLit") {
        const v = expr.value;
        const { bits, signed } = hint;
        const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
        const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
        if (v < min || v > max) {
          this.error(`integer literal ${v} overflows ${signed ? "i" : "u"}${bits} (range ${min}..${max})`, expr.span);
        }
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "FloatLit" && hint.tag === "float") {
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "new" && hint?.tag === "vec") {
      if (expr.args.length !== 0) { this.error(`'Vec.new' takes no arguments`, expr.span); }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "withCapacity" && hint?.tag === "vec") {
      if (expr.args.length !== 1) { this.error(`'Vec.withCapacity' expects 1 argument (capacity), got ${expr.args.length}`, expr.span); }
      else {
        const c = this.checkExpr(expr.args[0]);
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.withCapacity': capacity must be an integer, got ${this.show(c)}`, expr.span);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "filled" && hint?.tag === "vec") {
      if (expr.args.length !== 2) { this.error(`'Vec.filled' expects 2 arguments (count, value), got ${expr.args.length}`, expr.span); }
      else {
        const c = this.checkExpr(expr.args[0]);
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.filled': count must be an integer, got ${this.show(c)}`, expr.span);
        // Same discard as the array literals: the fill value was hint-checked and the
        // answer dropped, so `Vec<i64> = Vec.filled(3, "a")` reached clang as `%String`
        // where an `i64` was expected.
        const fillType = this.checkExprWithHint(expr.args[1], hint.element);
        if (!this.elementFits(fillType, hint.element, expr.args[1])) {
          this.error(`'Vec.filled' value has type ${this.show(fillType)}, but the Vec is declared ${this.show(hint)}`, expr.args[1].span);
        }
        // The value is copied into every slot, so it must be Copy — otherwise
        // N slots would alias one heap buffer and free it N times.
        if (!this.isCopyType(hint.element)) {
          this.error(`'Vec.filled' requires a Copy element type (got ${this.show(hint.element)}) — the fill value is duplicated into every slot; build a non-Copy Vec with a push loop`, expr.span);
        }
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "HashMap" && expr.variant === "new" && hint?.tag === "hashmap") {
      if (expr.args.length !== 0) { this.error(`'HashMap.new' takes no arguments`, expr.span); }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "HashMap" && expr.variant === "withCapacity" && hint?.tag === "hashmap") {
      if (expr.args.length !== 1) { this.error(`'HashMap.withCapacity' expects 1 argument (capacity), got ${expr.args.length}`, expr.span); }
      else {
        const c = this.checkExpr(expr.args[0]);
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'HashMap.withCapacity': capacity must be an integer, got ${this.show(c)}`, expr.span);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "ArrayLit" && hint.tag === "array") {
      for (const elem of expr.elements) {
        const et = this.checkExprWithHint(elem, hint.element);
        if (!this.elementFits(et, hint.element, elem)) {
          this.error(`array element has type ${this.show(et)}, but the array is declared ${this.show(hint)}`, elem.span);
        }
      }
      const result: TypeKind = { tag: "array", element: hint.element, size: expr.elements.length };
      return this.setType(expr, result);
    }
    // Vec literal: `let v: Vec<T> = [a, b, c]` lowers to Vec.new() + N pushes in codegen.
    if (hint && expr.kind === "ArrayLit" && hint.tag === "vec") {
      for (const elem of expr.elements) {
        const et = this.checkExprWithHint(elem, hint.element);
        if (!this.elementFits(et, hint.element, elem)) {
          this.error(`Vec element has type ${this.show(et)}, but the Vec is declared ${this.show(hint)}`, elem.span);
        }
        this.tryMove(elem);
      }
      return this.setType(expr, hint);
    }
    if (hint && expr.kind === "ArrayRepeat" && hint.tag === "array") {
      const rt = this.checkExprWithHint(expr.value, hint.element);
      if (!this.elementFits(rt, hint.element, expr.value)) {
        this.error(`repeated element has type ${this.show(rt)}, but the array is declared ${this.show(hint)}`, expr.value.span);
      }
      const result: TypeKind = { tag: "array", element: hint.element, size: expr.count };
      return this.setType(expr, result);
    }
    if (expr.kind === "EnumLit" && hint?.tag === "enum") {
      const sp = expr.span;
      const hintEnum = this.enums.get(hint.name);
      if (hintEnum && (hintEnum.baseName === expr.enumName || hint.name === expr.enumName)) {
        const variant = hintEnum.variants.get(expr.variant);
        if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return { tag: "unknown" }; }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
        }
        for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
          let argType = this.checkExprWithHint(expr.args[i], variant.fields[i]);
          // Coerce a constant-int operand to the field's int width, as fn args do.
          if (variant.fields[i].tag === "int" && argType.tag === "int" && !typeEq(variant.fields[i], argType) && this.isConstIntExpr(expr.args[i])) {
            this.retypeConstInt(expr.args[i], variant.fields[i]);
            argType = variant.fields[i];
          }
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${this.show(variant.fields[i])}, got ${this.show(argType)}`, sp);
          }
          this.tryMove(expr.args[i]);
        }
        this.rewrittenEnums.set(expr, hint.name);
        this.exprTypes.set(expr, hint);
        return hint;
      }
    }
    // Generic struct literal with a monomorphized hint — use hint to resolve type params
    if (hint && hint.tag === "struct" && expr.kind === "StructLit") {
      const genericInfo = this.genericStructs.get(expr.name);
      const hintInfo = this.structs.get(hint.name);
      if (genericInfo && hintInfo && hintInfo.baseName === expr.name) {
        const sp = expr.span;
        for (const f of expr.fields) {
          const fieldDef = hintInfo.fields.find(d => d.name === f.name);
          if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp, memberHint(f.name, hintInfo.fields.map(d => d.name))); continue; }
          let valType = this.checkExprWithHint(f.value, fieldDef.type);
          if (fieldDef.type.tag === "int" && valType.tag === "int" && !typeEq(fieldDef.type, valType) && this.isConstIntExpr(f.value)) {
            this.retypeConstInt(f.value, fieldDef.type);
            valType = fieldDef.type;
          }
          if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown" && !this.tryInterfaceCoercion(f.value, valType, fieldDef.type)) {
            this.error(`field '${f.name}' of '${expr.name}': expected ${this.show(fieldDef.type)}, got ${this.show(valType)}`, sp);
          }
          this.tryMove(f.value);
        }
        for (const d of hintInfo.fields) {
          if (!expr.fields.find(f => f.name === d.name)) {
            this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
          }
        }
        this.rewrittenStructLits.set(expr, hint.name);
        return this.setType(expr, hint);
      }
    }
    if (hint && expr.kind === "Closure" && hint.tag === "fn") {
      this.closureParamHints = hint.params;
      this.closureRetHint = hint.ret;
    }
    const prevHint = this.returnHint;
    this.returnHint = hint;
    const result = this.checkExpr(expr);
    this.returnHint = prevHint;
    // Coerce a constant-int subtree (`-1`, `a + 1` where every leaf is a literal)
    // to an int hint — the bare-literal branch above only catches a lone `IntLit`,
    // so a UnaryOp/BinOp wrapper (`return -1`, `let x: i64 = -1`) would otherwise
    // fail to widen. Call args, struct fields and enum payloads already do this.
    if (hint?.tag === "int" && result.tag === "int" && !typeEq(hint, result) &&
        (expr.kind === "UnaryOp" || expr.kind === "BinOp") && this.isConstIntExpr(expr)) {
      this.retypeConstInt(expr, hint);
      return hint;
    }
    if (hint?.tag === "float" && result.tag === "float" && !typeEq(hint, result) &&
        (expr.kind === "UnaryOp" || expr.kind === "BinOp") && this.isConstFloatExpr(expr)) {
      this.retypeConstFloat(expr, hint);
      return hint;
    }
    return result;
  }

  private setType(expr: Expr, type: TypeKind): TypeKind {
    this.exprTypes.set(expr, type);
    return type;
  }

  // Dispatch only. Every arm with a body of its own lives in a `check<Kind>Expr` method
  // below, because the alternative was one 2,500-line scope in which twenty-five arms
  // shared a set of locals and nothing said which arm was allowed to touch what. The
  // ownership arms are the reason it matters: they are the ones that have to be readable
  // in isolation to be reviewable at all. Arms that are a single `return` stay inline —
  // extracting those buys no isolation and costs a jump.
  private checkExpr(expr: Expr): TypeKind {
    const sp = expr.span;
    switch (expr.kind) {
      case "IntLit":
        // Context-free int literals default to i64 (decision 2026-07-13): this codebase is
        // i64-dominant (arithmetic, indices, loop counters); i32 is the annotated exception.
        // Literals WITH a target-type hint still coerce via checkExprWithHint (let x: i32 = 5).
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      case "FloatLit":
        return this.setType(expr, { tag: "float", bits: 64 });
      case "BoolLit":
        return this.setType(expr, { tag: "bool" });
      case "CharLit":
        return this.setType(expr, { tag: "int", bits: 8, signed: false });
      case "StringLit":
        this.checkMissingInterpolation(expr);
        return this.setType(expr, { tag: "string" });
      case "Ident":
        return this.checkIdentExpr(expr);
      case "BinOp":
        return this.checkBinOpExpr(expr);
      case "UnaryOp":
        return this.checkUnaryOpExpr(expr);
      case "Call":
        return this.checkCallExpr(expr);
      case "StructLit":
        return this.checkStructLitExpr(expr);
      case "FieldAccess":
        return this.checkFieldAccessExpr(expr);
      case "ArrayLit":
        return this.checkArrayLitExpr(expr);
      case "ArrayRepeat":
        return this.checkArrayRepeatExpr(expr);
      case "IndexAccess":
        return this.checkIndexAccessExpr(expr);
      case "EnumLit":
        return this.checkEnumLitExpr(expr);
      case "Unwrap":
        return this.checkUnwrapExpr(expr);
      case "Propagate":
        return this.checkPropagateExpr(expr);
      case "DefaultValue":
        return this.checkDefaultValueExpr(expr);
      case "CastExpr":
        return this.checkCastExprExpr(expr);
      case "Closure":
        return this.checkClosureExpr(expr);
      case "MethodCall":
        return this.checkMethodCallExpr(expr);
      case "RangeExpr":
        this.error("range expressions can only be used in 'for' loops", sp);
        return this.setType(expr, { tag: "unknown" });
      case "IsExpr":
        return this.checkIsExprExpr(expr);
      case "IfExpr":
        return this.checkIfExprExpr(expr);
      case "MatchExpr":
        return this.checkMatchExprExpr(expr);
    }
    // A missing arm here is a SILENT skip: the walker simply does not descend, and every
    // analysis built on it stops seeing that subtree with no error to say so. Binding the
    // scrutinee to `never` makes the next unhandled expression kind a compile error.
    const _exhaustive: never = expr;
    throw new Error(`checkExpr: unhandled expression kind '${(_exhaustive as { kind: string }).kind}'`);
  }

  private checkIdentExpr(expr: ExprOf<"Ident">): TypeKind {
    const sp = expr.span;
    const info = this.lookup(expr.name);
    if (!info) {
      // named function used as a value (function pointer)
      const fnSig = this.functions.get(expr.name);
      if (fnSig) {
        const fnType: TypeKind = { tag: "fn", params: fnSig.params.map(p => p.type), ret: fnSig.ret };
        return this.setType(expr, fnType);
      }
      this.error(`undefined variable '${expr.name}'`, sp, this.nameHint(expr.name));
      return this.setType(expr, { tag: "unknown" });
    }
    // A nullable extern reference is not a value. Every way of naming it — passing it on,
    // storing it, a field access, wrapping it in an `Option` — arrives here, so one gate
    // covers them all; the `let … else` unwrap is the only reader that does not, because
    // it never calls checkExpr on its subject.
    if (info.nullableRef) {
      // Marked read even though the use is rejected: the name WAS mentioned, and leaving
      // it unread stacks a bogus "unused variable" warning on top of every one of these.
      info.read = true;
      const ref = `&${info.nullableRef.mutable ? "mut " : ""}${this.show(info.nullableRef.inner)}`;
      this.error(`'${expr.name}' is a nullable extern reference and must be unwrapped before use`, sp,
        `write 'let x = ${expr.name} else { … }' — the else block runs when C passed null and must diverge; 'x' is then an ordinary '${ref}'`);
      return this.setType(expr, { tag: "unknown" });
    }
    info.read = true;
    // `unsafe` admits the read: the new owner is then the programmer's claim to make
    // (giflib's CStore keeps every buffer alive until the C caller is done with it).
    if (info.pointerSourceMoved) {
      const m = info.pointerSourceMoved;
      this.requireUnsafe(`'${expr.name}' used after its source '${m.root}' was moved (from '${m.call}' on line ${m.line})`, sp,
        `use 'forget(${m.root})' to hand the buffer to the pointer's new owner, or take the pointer after the move`);
      return this.setType(expr, this.deref(info.type));
    }
    // A use of the WHOLE value while one of its places is missing. Reading `p.b`
    // after `p.a` left is fine — a different place — and that read reaches here
    // with placeBaseDepth raised, because `p` is only the base of a narrower place.
    // Anything else names the value itself: an argument, a receiver, a return, a
    // print. Handing that on shows the zeroed field as if it were data.
    if (this.placeBaseDepth === 0 && info.movedPlaces && info.movedPlaces.size > 0) {
      const gone = [...info.movedPlaces][0]!;
      this.error(`'${expr.name}' is incomplete: '${expr.name}${gone}' was moved out of it`, sp,
        `using '${expr.name}' as a whole would show that field as empty — clone it at the point of transfer, or use the fields that are still there`);
    }
    if (info.moved) {
      if (this.movedByPattern.has(info)) {
        this.error(
          `use of moved variable '${expr.name}'`,
          sp,
          `the pattern moved '${expr.name}''s payload out, so reading '${expr.name}' here would see a zeroed value. Use the pattern's binding instead, or compute what you need from '${expr.name}' before the match.`,
        );
      } else {
        // A `@noCopy` handle is deliberately not clonable — duplicating one is how you
        // get the double-free it exists to prevent — so the usual hint would name a fix
        // that cannot be applied. Point at the ownership question instead.
        const t = this.deref(info.type);
        const noCopy = t.tag === "struct" && this.structs.get(t.name)?.noCopy === true;
        const pointerField = t.tag === "struct" ? this.structs.get(t.name)?.pointerField : undefined;
        // An owning closure has no `.clone()` to suggest — cloning it would mean copying a
        // captured environment whose contents may not be clonable at all, and duplicating
        // the environment is exactly what makes it unsound to own. Say what it is instead.
        const owningFn = t.tag === "fn" && t.owning === true;
        this.error(
          `use of moved variable '${expr.name}'`,
          sp,
          owningFn
            ? `'${expr.name}' is a 'move' closure, so it OWNS what it captured and there is only one of it — passing it on transferred that ownership. Build a second closure, or restructure so the transfer happens last.`
            : noCopy
            // A type from a package is stored as `gl$Texture2D`; the hint tells the
            // reader what to type, and what they type is the bare name they imported.
            ? `'${expr.name}' is a @noCopy handle, so transferring it ended its life here — copying one would let the same resource be released twice. Borrow it (pass it to a '&${this.show(t).split("$").pop()}' parameter) instead of transferring, or reorder so the transfer is last.`
            : pointerField
            ? `'${expr.name}' holds a raw pointer ('${pointerField}'), so it is move-tracked and transferring it ended its life here: a copy would be a second owner of whatever the pointer addresses. Borrow it (pass it to a '&${this.show(t).split("$").pop()}' parameter) instead of transferring, reorder so the transfer is last, or mark '${this.show(t).split("$").pop()}' @copy if it does not own what the pointer points at.`
            : `ownership of '${expr.name}' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: '${expr.name}.clone()'.`,
        );
      }
      return this.setType(expr, this.deref(info.type));
    }
    return this.setType(expr, this.deref(info.type));
  }

  private checkBinOpExpr(expr: ExprOf<"BinOp">): TypeKind {
    const sp = expr.span;
    if (expr.op === "&&" || expr.op === "||") {
      const lt = this.checkExpr(expr.left);
      const rt = this.checkExpr(expr.right);
      if (lt.tag !== "bool" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${this.show(lt)}`, sp);
      if (rt.tag !== "bool" && rt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${this.show(rt)}`, sp);
      return this.setType(expr, { tag: "bool" });
    }
    let lt = this.checkExpr(expr.left);
    let rt = this.checkExpr(expr.right);
    // `x == f64.NAN` / `!=` is a dead comparison: NaN equals nothing, itself included,
    // so the branch is unreachable (==) or always taken (!=). Steer to isNan.
    if (expr.op === "==" || expr.op === "!=") {
      const nanSide = [expr.left, expr.right].some(
        e => e.kind === "FieldAccess" && floatNamespaceConst(e)?.value !== undefined && Number.isNaN(floatNamespaceConst(e)!.value));
      if (nanSide) this.warn("nan-comparison",
        `comparison with NaN is always ${expr.op === "==" ? "false" : "true"}`, sp,
        "NaN is never equal to any value; use isNan(x) from std/math");
    }
    // Integer constant coercion: a constant-int operand (a literal, or an
    // all-literal subexpression like `1 << 5` or `(a + 1)`) defaults to i32
    // but should adopt the other operand's int width. Retype the constant
    // subtree to match, so `i64var + 1 * 2` type-checks without an `as i64`.
    if (lt.tag === "int" && rt.tag === "int" && !typeEq(lt, rt)) {
      if (this.isConstIntExpr(expr.right)) {
        this.retypeConstInt(expr.right, lt);
        rt = lt;
      } else if (this.isConstIntExpr(expr.left)) {
        this.retypeConstInt(expr.left, rt);
        lt = rt;
      } else {
        // A flexible const-int binding (`let m = if.. { const arms }`) used
        // against a concrete int of another width adopts that width here —
        // this is its first read, so nothing was committed at the default.
        const rInfo = this.flexIntBinding(expr.right);
        const lInfo = this.flexIntBinding(expr.left);
        if (rInfo && this.resolveFlexInt(rInfo, lt, expr.right)) rt = lt;
        else if (lInfo && this.resolveFlexInt(lInfo, rt, expr.left)) lt = rt;
      }
    }
    // Same treatment for float widths: `1.0 - f32val` retypes the literal to
    // f32 rather than demanding an annotated constant.
    if (lt.tag === "float" && rt.tag === "float" && !typeEq(lt, rt)) {
      if (this.isConstFloatExpr(expr.right)) {
        this.retypeConstFloat(expr.right, lt);
        rt = lt;
      } else if (this.isConstFloatExpr(expr.left)) {
        this.retypeConstFloat(expr.left, rt);
        lt = rt;
      }
    }
    const arithOps = ["+", "-", "*", "/", "%"];
    const cmpOps = ["==", "!=", "<", ">", "<=", ">="];
    const bitOps = ["&", "|", "^", "<<", ">>"];
    if (expr.op === "+" && lt.tag === "string" && rt.tag === "string") {
      return this.setType(expr, { tag: "string" });
    }
    if ((expr.op === "==" || expr.op === "!=") && lt.tag === "string" && rt.tag === "string") {
      return this.setType(expr, { tag: "bool" });
    }
    if (arithOps.includes(expr.op)) {
      // operator overloading for struct types
      if (lt.tag === "struct" && rt.tag === "struct" && typeEq(lt, rt)) {
        const opTraitMap: Record<string, string> = { "+": "Add", "-": "Sub", "*": "Mul", "/": "Div" };
        const traitName = opTraitMap[expr.op];
        if (traitName && this.typeImplementsTrait(lt.name, traitName)) {
          const methodName = traitName.toLowerCase();
          const mangled = `${lt.name}$${traitName}$${methodName}`;
          this.resolvedOperators.set(expr, mangled);
          this.autoBorrowed.set(expr.left, { mutable: false });
          this.autoBorrowed.set(expr.right, { mutable: false });
          return this.setType(expr, lt);
        }
      }
      if (!isNumeric(lt) && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric type, got ${this.show(lt)}`, sp);
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${this.show(lt)} vs ${this.show(rt)}`, sp);
      if (lt.tag === "int" && expr.left.kind === "IntLit" && expr.right.kind === "IntLit") {
        this.checkConstOverflow(expr.left.value, expr.right.value, expr.op, lt, sp);
      }
      // range propagation: compute output range from operand ranges
      if (lt.tag === "int" && rt.tag === "int" && lt.min !== undefined && lt.max !== undefined && rt.min !== undefined && rt.max !== undefined) {
        const propagated = this.propagateRange(lt, rt, expr.op);
        if (propagated) return this.setType(expr, propagated);
      }
      return this.setType(expr, lt);
    }
    if (bitOps.includes(expr.op)) {
      if (lt.tag !== "int" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires integer type, got ${this.show(lt)}`, sp);
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${this.show(lt)} vs ${this.show(rt)}`, sp);
      return this.setType(expr, lt);
    }
    if (cmpOps.includes(expr.op)) {
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${this.show(lt)} vs ${this.show(rt)}`, sp);
      if (expr.op === "==" || expr.op === "!=") {
        if (lt.tag === "enum") {
          const info = this.enums.get(lt.name);
          if (info) {
            let hasPayload = false;
            for (const [, v] of info.variants) {
              if (v.fields.length > 0) { hasPayload = true; break; }
            }
            if (hasPayload) {
              this.error(`cannot use '${expr.op}' on enum '${lt.name}' with payload-bearing variants`, sp, `use 'match' to compare`);
            }
          }
        } else if (lt.tag === "struct") {
          if (this.typeImplementsTrait(lt.name, "Eq")) {
            const mangled = `${lt.name}$Eq$eq`;
            this.resolvedOperators.set(expr, mangled);
            this.autoBorrowed.set(expr.left, { mutable: false });
            this.autoBorrowed.set(expr.right, { mutable: false });
          } else {
            this.error(`cannot use '${expr.op}' on ${this.show(lt)}`, sp, `implement Eq trait or compare individual fields`);
          }
        } else if (lt.tag === "vec" || lt.tag === "hashmap" || lt.tag === "heap" || lt.tag === "array") {
          this.error(`cannot use '${expr.op}' on ${this.show(lt)}`, sp, `compare individual fields or implement an eq method`);
        }
      } else {
        // ordering ops: numeric or string
        if (!isNumeric(lt) && lt.tag !== "string" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric or string type, got ${this.show(lt)}`, sp);
      }
      return this.setType(expr, { tag: "bool" });
    }
    this.error(`unknown operator '${expr.op}'`, sp);
    return this.setType(expr, { tag: "unknown" });
  }

  private checkUnaryOpExpr(expr: ExprOf<"UnaryOp">): TypeKind {
    const sp = expr.span;
    const ot = this.checkExpr(expr.operand);
    if (expr.op === "*") {
      if (ot.tag === "ref") return this.setType(expr, ot.inner);
      if (ot.tag === "heap") return this.setType(expr, ot.inner);
      if (ot.tag === "ptr") {
        this.requireUnsafe(`pointer dereference requires 'unsafe' block`, sp);
        return this.setType(expr, ot.inner);
      }
      if (ot.tag !== "unknown") this.error(`cannot dereference type '${this.show(ot)}' (expected &T, *T or Heap<T>)`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    if (expr.op === "-") {
      if (!isNumeric(ot) && ot.tag !== "unknown") this.error(`unary '-' requires numeric type, got ${this.show(ot)}`, sp);
      if (ot.tag === "int" && expr.operand.kind === "IntLit") {
        const result = -expr.operand.value;
        const { bits, signed } = ot;
        const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
        const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
        if (result < min || result > max) {
          this.error(`negation of ${expr.operand.value} overflows ${signed ? "i" : "u"}${bits} (range ${min}..${max})`, sp);
        }
      }
      return this.setType(expr, ot);
    }
    if (expr.op === "!") {
      if (ot.tag !== "bool" && ot.tag !== "unknown") this.error(`unary '!' requires bool, got ${this.show(ot)}`, sp);
      return this.setType(expr, { tag: "bool" });
    }
    if (expr.op === "~") {
      if (ot.tag !== "int" && ot.tag !== "unknown") this.error(`unary '~' requires integer type, got ${this.show(ot)}`, sp);
      return this.setType(expr, ot);
    }
    if (expr.op === "&") {
      // `&` is a borrow marker that appears only in a TYPE (`&T` = a borrowed
      // param). It is not an expression operator. Borrows are implicit (pass
      // the value bare); a raw pointer comes from `v.ptr()` / `x.addrOf()`.
      this.error(`'&x' is not an expression — borrows are implicit (pass 'x' bare). For a raw pointer use 'v.ptr()' (a collection's data) or 'x.addrOf()' (any value, in an unsafe block).`, sp);
      return this.setType(expr, { tag: "ptr", inner: ot });
    }
    return this.setType(expr, { tag: "unknown" });
  }

  // `arenaWith(a, h, (s: &T): T => { return s.clone() })` is `arenaGet(a, h)` written
  // the long way. The closure form exists to BORROW the value without copying it; a
  // body that immediately clones throws that borrow away, so the caller paid a closure,
  // a callback and a nested match for the copy `get` would have handed them. Detected
  // structurally — one param, one statement, and that statement is a bare
  // `return <thatParam>.clone()` — so a closure doing anything else is untouched.
  private lintBorrowThatClones(expr: ExprOf<"Call">): void {
    if (expr.func !== "arenaWith") return;
    const cb = expr.args[expr.args.length - 1];
    if (!cb || cb.kind !== "Closure" || cb.params.length !== 1 || cb.body.length !== 1) return;
    const only = cb.body[0]!;
    const ret = only.kind === "Return" ? only.value : only.kind === "ExprStmt" ? only.expr : null;
    if (!ret || ret.kind !== "MethodCall" || ret.method !== "clone" || ret.args.length !== 0) return;
    if (ret.object.kind !== "Ident" || ret.object.name !== cb.params[0]!.name) return;
    this.warn("borrow-that-clones",
      `this 'arenaWith' closure only clones its argument, which is what 'arenaGet' already does`,
      expr.span,
      "replace the whole call with 'arenaGet(arena, handle)' (or 'arena.get(handle)') — it returns the same Option<T>");
  }

  private checkCallExpr(expr: ExprOf<"Call">): TypeKind {
    const sp = expr.span;
    this.lintBorrowThatClones(expr);
    // `old(e)` is contract-only syntax, not a function: it names the value `e` held when
    // the function was entered. Recognised before the name lookup so a body-local
    // helper actually called `old` keeps working outside an `ensures`.
    if (expr.func === "old" && !this.functions.has("old") && this.contractScope === "ensures") {
      if (expr.args.length !== 1) { this.error(`old() takes exactly one argument`, sp); return this.setType(expr, { tag: "unknown" }); }
      const inner = this.checkExpr(expr.args[0]!);
      // A snapshot is a by-value copy taken at entry. Copying a Vec/string/struct there
      // would either alias the caller's buffer or clone silently on every debug call, so
      // the pre-state is restricted to what fits in a register — which is also the only
      // fragment the SMT translator models.
      if (inner.tag !== "int" && inner.tag !== "float" && inner.tag !== "bool" && inner.tag !== "unknown") {
        this.error(`old() takes a scalar (integer, float, or bool), got ${this.show(inner)}`, sp,
          `snapshot a scalar projection instead, e.g. old(v.len)`);
      }
      return this.setType(expr, inner);
    }
    if (expr.func === "old" && this.contractScope !== "ensures" && !this.functions.has("old")) {
      this.error(`old() may only appear in an 'ensures' clause`, sp,
        `there is no pre-state to name in a ${this.contractScope === null ? "function body" : `'${this.contractScope}' clause`}`);
      return this.setType(expr, { tag: "unknown" });
    }
    if (expr.func === "sizeOf") {
      if (!expr.typeArgs || expr.typeArgs.length !== 1) { this.error(`sizeOf requires exactly one type argument`, sp); return this.setType(expr, { tag: "unknown" }); }
      if (expr.args.length !== 0) { this.error(`sizeOf takes no value arguments`, sp); return this.setType(expr, { tag: "unknown" }); }
      const resolved = this.resolve(expr.typeArgs[0]);
      this.sizeOfTypes.set(expr, resolved);
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (expr.func === "offsetOf") {
      if (!expr.typeArgs || expr.typeArgs.length !== 1) { this.error(`offsetOf requires exactly one type argument`, sp); return this.setType(expr, { tag: "unknown" }); }
      if (expr.args.length !== 1 || expr.args[0].kind !== "StringLit") { this.error(`offsetOf requires one string argument (field name)`, sp); return this.setType(expr, { tag: "unknown" }); }
      const resolved = this.resolve(expr.typeArgs[0]);
      if (resolved.tag !== "struct") { this.error(`offsetOf requires a struct type`, sp); return this.setType(expr, { tag: "unknown" }); }
      const info = this.structs.get(resolved.name);
      const fieldName = (expr.args[0] as import("./ast").StringLit).value;
      if (info && !info.fields.find(f => f.name === fieldName)) {
        this.error(`struct '${resolved.name}' has no field '${fieldName}'`, sp);
      }
      this.sizeOfTypes.set(expr, resolved);
      this.offsetOfFields.set(expr, fieldName);
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    // `forget(x)` — end x's ownership WITHOUT running its drop. The one operation the
    // move checker cannot otherwise express: every other way of consuming a value either
    // drops it or hands it to something that will. It exists for the seams where
    // ownership leaves through a raw pointer and the checker cannot see it go — a
    // closure environment memcpy'd into a scheduler task, a buffer handed to C — where
    // the alternative is a double free (the drop runs anyway) or a leak dressed up as
    // safety. Deliberately not `unsafe`: forgetting a value is memory-SAFE (leaking is
    // safe), it is merely usually wrong, and requiring `unsafe` here would push callers
    // toward wrapping a whole region rather than this one call.
    if (expr.func === "forget" && !this.functions.has("forget")) {
      if (expr.args.length !== 1) {
        this.error(`'forget' takes exactly one argument`, sp);
        return this.setType(expr, { tag: "void" });
      }
      const t = this.checkExpr(expr.args[0]);
      if (this.isCopyType(t)) {
        this.warn("useless-forget", `'forget' on a Copy value does nothing`, sp,
          `${this.show(t)} owns no resource, so there is no drop to suppress`);
      }
      this.pointerMoveKeepsHolders = true;
      try { this.tryMove(expr.args[0]); } finally { this.pointerMoveKeepsHolders = false; }
      return this.setType(expr, { tag: "void" });
    }
    // `isNull(s.field)` — the ONE test a C function-pointer field admits besides being
    // called. C hands out null function pointers routinely (an optional callback in an
    // ops table), and the ordinary null idiom `p as i64 == 0` is not open here: casting
    // the field to an integer would be reading it as a value, which is what the
    // thin/fat split forbids. Deliberately narrow: it takes a `cfn` and nothing else, so
    // it does not become a second spelling for a raw-pointer null test.
    if (expr.func === "isNull" && !this.functions.has("isNull")) {
      if (expr.args.length !== 1) {
        this.error(`'isNull' takes exactly one argument`, sp);
        return this.setType(expr, { tag: "bool" });
      }
      const t = this.checkExpr(expr.args[0]);
      if (t.tag === "cfn") {
        this.strandedCFnReads.delete(expr.args[0]);
      } else if (t.tag !== "unknown") {
        this.error(`'isNull' takes a C function-pointer field, got ${this.show(t)}`, sp,
          `a raw pointer is tested with 'p as i64 == 0'`);
      }
      return this.setType(expr, { tag: "bool" });
    }
    if (expr.func === "zeroed") {
      if (!expr.typeArgs || expr.typeArgs.length !== 1) { this.error(`zeroed requires exactly one type argument`, sp); return this.setType(expr, { tag: "unknown" }); }
      if (expr.args.length !== 0) { this.error(`zeroed takes no value arguments`, sp); return this.setType(expr, { tag: "unknown" }); }
      this.requireUnsafe(`zeroed<T>() can only be used in unsafe blocks`, sp);
      const resolved = this.resolve(expr.typeArgs[0]);
      this.sizeOfTypes.set(expr, resolved);
      return this.setType(expr, resolved);
    }
    // `rawSlice(p, len)` / `rawSliceMut(p, len)` mint a non-owning `&[T]` / `&mut [T]`
    // over memory Milo did not allocate. Every other slice is carved out of storage the
    // compiler can see (a Vec, an array, a Sealed), so its extent is known; this one is
    // the caller's word. It is the single construction the language cannot express, and
    // the reason `std/foreign` needs compiler help at all.
    //
    // Restricted to std/foreign.milo BY FILE, so the unchecked aliasing assertion lives in
    // exactly one reviewed place. Elsewhere the name is an ordinary undefined function.
    // The restriction is what keeps this from being a general escape hatch: `withRaw`'s
    // closure parameter is what bounds the view's life, and a `let s = rawSlice(p, n)` in
    // user code would hand back the same view with no such bound.
    if (RAW_SLICE_INTRINSICS.has(expr.func) && isForeignModule(sp?.file)) {
      const mutable = expr.func === "rawSliceMut";
      if (expr.args.length !== 2) {
        this.error(`'${expr.func}' takes exactly two arguments (pointer, length)`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      const pt = this.checkExpr(expr.args[0]);
      const lt = this.checkExpr(expr.args[1]);
      if (pt.tag !== "ptr" && pt.tag !== "unknown") {
        this.error(`'${expr.func}': expected a raw pointer, got ${this.show(pt)}`, expr.args[0].span);
        return this.setType(expr, { tag: "unknown" });
      }
      if (lt.tag !== "int" && lt.tag !== "unknown") {
        this.error(`'${expr.func}': expected an integer length, got ${this.show(lt)}`, expr.args[1].span);
      }
      this.requireUnsafe(`'${expr.func}' can only be used in unsafe blocks`, sp);
      const element: TypeKind = pt.tag === "ptr" ? pt.inner : { tag: "unknown" };
      return this.setType(expr, { tag: "ref", inner: { tag: "array", element, size: null }, mutable });
    }
    // `adoptHeap(p)` / `adoptVec(p, len)`: the inverse of `forget`. They turn a raw
    // pointer back into an owned `Heap<T>` / `Vec<T>`, so the value that comes out has
    // drop glue and the move checker treats it like any other owned value. Nothing about
    // the pointer is checkable: whether it came from a Milo allocation of this type, is
    // unaliased, and has not already been adopted is the caller's word, and adopting the
    // same pointer twice is a double free.
    //
    // Restricted to std/foreign.milo BY FILE, exactly as rawSlice is, and for the same
    // reason: `std/foreign`'s `adopt`/`adoptSlice` add the null test and the `Option`
    // wrapping in readable Milo, and outside that file the name is an ordinary undefined
    // function rather than a way to mint ownership of an arbitrary address.
    if (ADOPT_INTRINSICS.has(expr.func) && isForeignModule(sp?.file)) {
      const wantsLen = expr.func === "adoptVec";
      const arity = wantsLen ? 2 : 1;
      if (expr.args.length !== arity) {
        this.error(`'${expr.func}' takes exactly ${wantsLen ? "two arguments (pointer, length)" : "one argument (pointer)"}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      const pt = this.checkExpr(expr.args[0]);
      if (wantsLen) {
        const lt = this.checkExpr(expr.args[1]);
        if (lt.tag !== "int" && lt.tag !== "unknown") {
          this.error(`'${expr.func}': expected an integer length, got ${this.show(lt)}`, expr.args[1].span);
        }
      }
      if (pt.tag !== "ptr" && pt.tag !== "unknown") {
        this.error(`'${expr.func}': expected a raw pointer, got ${this.show(pt)}`, expr.args[0].span);
        return this.setType(expr, { tag: "unknown" });
      }
      this.requireUnsafe(`'${expr.func}' can only be used in unsafe blocks`, sp);
      const inner: TypeKind = pt.tag === "ptr" ? pt.inner : { tag: "unknown" };
      return this.setType(expr, wantsLen ? { tag: "vec", element: inner } : { tag: "heap", inner });
    }
    // `replace(place, value)` and `swap(a, b)`: memory intrinsics whose bodies cannot be
    // written in safe Milo (they move a value out of a place and refill it). From the
    // caller's view the move rules are ordinary — a `&mut` borrow of the place(s) plus a
    // by-value move of `value` — so they need no exclusivity machinery, only load/store
    // codegen. Gated on the name being otherwise unbound, so a user fn of the same name wins.
    if (expr.func === "replace" && !this.functions.has("replace")) {
      if (expr.args.length !== 2) { this.error(`replace(place, value) takes exactly two arguments`, sp); return this.setType(expr, { tag: "unknown" }); }
      const place = this.resolveAssignTarget(expr.args[0]);
      // `replace` hands the old occupant back, so the place is genuinely READ here even
      // when it is an owned local rather than a borrow.
      this.markPlaceRead(expr.args[0]);
      if (!place.mutable) this.error(`cannot replace through an immutable place`, expr.args[0].span, `declare it with 'var'`);
      // value moves in, old occupant moves out to the caller — the place stays valid,
      // so it is NOT invalidated here (only the by-value argument is consumed).
      const vt = this.checkExprWithHint(expr.args[1], place.type);
      if (vt.tag !== "unknown" && place.type.tag !== "unknown" && !typeEq(vt, place.type)) {
        this.error(`replace: value type ${this.show(vt)} does not match place type ${this.show(place.type)}`, expr.args[1].span);
      }
      this.tryMove(expr.args[1]);
      return this.setType(expr, place.type);
    }
    if (expr.func === "swap" && !this.functions.has("swap")) {
      if (expr.args.length !== 2) { this.error(`swap(a, b) takes exactly two arguments`, sp); return this.setType(expr, { tag: "void" }); }
      const a = this.resolveAssignTarget(expr.args[0]);
      const b = this.resolveAssignTarget(expr.args[1]);
      if (!a.mutable) this.error(`cannot swap through an immutable place`, expr.args[0].span, `declare it with 'var'`);
      if (!b.mutable) this.error(`cannot swap through an immutable place`, expr.args[1].span, `declare it with 'var'`);
      if (a.type.tag !== "unknown" && b.type.tag !== "unknown" && !typeEq(a.type, b.type)) {
        this.error(`swap: operands have different types ${this.show(a.type)} and ${this.show(b.type)}`, sp);
      }
      return this.setType(expr, { tag: "void" });
    }
    if (expr.func === "Heap") {
      if (expr.args.length !== 1) { this.error(`Heap() expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      const argType = this.checkExpr(expr.args[0]);
      this.tryMove(expr.args[0]);
      return this.setType(expr, { tag: "heap", inner: argType });
    }
    if (expr.func === "embedFile") {
      // Bare `embedFile(...)` reads like an ordinary call but is compile-time-only:
      // the argument must be a literal and the file is inlined during compilation.
      // `@` is how Milo already marks compiler-level constructs (@cLayout, @link).
      if (!expr.sigil) {
        this.warn("bare-embedfile",
          `'embedFile' is a compile-time builtin — write '@embedFile(...)'`,
          sp, `the '@' marks it as compiler magic, not a runtime call`, "embedFile".length);
      }
      if (expr.args.length !== 1) { this.error(`embedFile() expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      const arg = expr.args[0];
      if (arg.kind !== "StringLit") { this.error(`embedFile() argument must be a string literal`, sp); return this.setType(expr, { tag: "unknown" }); }
      return this.setType(expr, { tag: "string" });
    }
    if (expr.func === "targetOs") {
      // Compile-time constant string naming the target OS ("darwin"/"linux"/
      // "windows"), resolved during lowering. Like @embedFile it is compiler
      // magic, not a runtime call, so it wants the `@` sigil; both arms of an
      // `if @targetOs() == "..."` type-check, only the dead one is folded away.
      if (!expr.sigil) {
        this.warn("bare-targetos",
          `'targetOs' is a compile-time builtin — write '@targetOs()'`,
          sp, `the '@' marks it as compiler magic, not a runtime call`, "targetOs".length);
      }
      if (expr.args.length !== 0) { this.error(`targetOs() takes no arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      return this.setType(expr, { tag: "string" });
    }
    if (expr.func === "jsonStringify") {
      if (expr.args.length !== 1) { this.error(`jsonStringify() expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      const argType = this.checkExpr(expr.args[0]);
      if (argType.tag !== "struct" && argType.tag !== "string" && argType.tag !== "bool" && argType.tag !== "int" && argType.tag !== "float") {
        this.error(`jsonStringify: unsupported type '${this.show(argType)}'`, sp);
      }
      // codegen only serializes scalar fields — anything else silently
      // produced invalid JSON before this guard existed
      if (argType.tag === "struct") {
        const si = this.structs.get(argType.name);
        for (const f of si?.fields ?? []) {
          if (f.type.tag !== "string" && f.type.tag !== "bool" && f.type.tag !== "int" && f.type.tag !== "float") {
            this.error(`jsonStringify: field '${f.name}' has unsupported type '${this.show(f.type)}'`, sp,
              `only string, bool, integer, and float fields are supported — for nested or dynamic JSON use the std/json builders (jsonObj/jsonArr)`);
          }
        }
      }
      this.autoBorrowed.set(expr.args[0], { mutable: false });
      return this.setType(expr, { tag: "string" });
    }
    // Generic function — infer type params from args, monomorphize
    const genericFn = this.genericFns.get(expr.func);
    if (genericFn) {
      const argTypes: TypeKind[] = [];
      for (const arg of expr.args) argTypes.push(this.checkExpr(arg));

      if (expr.args.length !== genericFn.decl.params.length) {
        this.error(`function '${expr.func}' expects ${genericFn.decl.params.length} args, got ${expr.args.length}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }

      const typeMap = new Map<string, TypeKind>();
      const literalInferred = new Set<string>();
      // Explicit turbofish type args (promiseAll<T>(x)) seed the map up front;
      // inference below fills any the caller left off. This is the only way to
      // pin a param that appears nested past what inference walks (e.g. T in
      // Vec<Promise<T>>).
      if (expr.typeArgs && expr.typeArgs.length > 0) {
        if (expr.typeArgs.length > genericFn.typeParams.length) {
          this.error(`'${expr.func}' expects at most ${genericFn.typeParams.length} type argument(s), got ${expr.typeArgs.length}`, sp);
        }
        for (let i = 0; i < expr.typeArgs.length && i < genericFn.typeParams.length; i++) {
          typeMap.set(genericFn.typeParams[i], this.resolve(expr.typeArgs[i]));
        }
      }
      for (let i = 0; i < argTypes.length; i++) {
        const paramTy = declaredType(genericFn.decl.params[i]);
        const argIsLiteral = expr.args[i].kind === "IntLit" || expr.args[i].kind === "CharLit" || expr.args[i].kind === "FloatLit";
        // Direct match: param type IS a type param (e.g. val: T). A POINTER or ARRAY
        // wrapper at the use site is not one: `p: *T` fed a `*i64` names i64, and
        // `v: &[T]` fed a Vec names its element. Both used to bind T to the whole
        // argument type, so `fn firstAt<T>(p: *T): T` reported "expected *i64, got i64"
        // from inside its own body, against a type the program never wrote. `&T` stays a
        // direct match: auto-borrow means the argument arrives as the pointee already.
        const ptrDepth = paramTy.ptrDepth ?? (paramTy.isPtr ? 1 : 0);
        let directArg: TypeKind | null = paramTy.isArray ? null : argTypes[i];
        for (let d = 0; d < ptrDepth && directArg; d++) {
          directArg = directArg.tag === "ptr" ? directArg.inner : null;
        }
        if (genericFn.typeParams.includes(paramTy.name) && directArg) {
          const existing = typeMap.get(paramTy.name);
          if (existing && !typeEq(existing, directArg)) {
            // numeric literal coercion: flex the literal to match the existing inference
            if (argIsLiteral && existing.tag === argTypes[i].tag) {
              this.exprTypes.set(expr.args[i], existing);
              argTypes[i] = existing;
            } else if (literalInferred.has(paramTy.name) && existing.tag === directArg.tag) {
              typeMap.set(paramTy.name, directArg);
              literalInferred.delete(paramTy.name);
            } else {
              this.error(`conflicting inference for type parameter '${paramTy.name}'`, sp);
            }
          } else if (!existing) {
            typeMap.set(paramTy.name, directArg);
            if (argIsLiteral) literalInferred.add(paramTy.name);
          }
        }
        // Nested match: param type contains type params (e.g. &Arena<T>, Vec<T>)
        if (paramTy.typeArgs) {
          let argResolved = argTypes[i];
          if (argResolved.tag === "ref") argResolved = argResolved.inner;
          if (argResolved.tag === "struct") {
            const info = this.structs.get(argResolved.name);
            if (info?.baseName && info.typeArgs) {
              const gs = this.genericStructs.get(info.baseName);
              if (gs && info.baseName === paramTy.name) {
                for (let j = 0; j < paramTy.typeArgs.length && j < info.typeArgs.length; j++) {
                  const ta = paramTy.typeArgs[j];
                  if (genericFn.typeParams.includes(ta.name) && (!typeMap.has(ta.name) || literalInferred.has(ta.name))) {
                    typeMap.set(ta.name, info.typeArgs[j]);
                    literalInferred.delete(ta.name);
                  }
                }
              }
            }
          }
        }
        // Everything the block above does not reach: `Vec<T>`, `[T]`, and generic structs
        // nested inside either. `inferTypeParamsFromHint` already walks those shapes for
        // return hints and closure signatures — it was simply never applied to ordinary
        // arguments, so a generic function over any CONTAINER of T could not infer T at
        // all (`fn f<T>(v: Vec<T>)` called with a `Vec<i32>` reported "cannot infer type
        // parameter 'T'", and a turbofish at every call site was the only way through).
        // Non-destructive: it fills unbound parameters only, so a turbofish and the
        // direct-match branch above both still win.
        if (paramTy.typeArgs?.length || paramTy.isArray) {
          let argResolved = argTypes[i];
          if (argResolved.tag === "ref") argResolved = argResolved.inner;
          this.inferTypeParamsFromHint(paramTy, argResolved, genericFn.typeParams, typeMap);
        }
        // Function-typed param (e.g. f: (&T) => R): infer type params that
        // appear only inside a closure's signature — notably R in arenaWith,
        // which no other argument constrains. Strip matching refs and never
        // overwrite a param already bound by an earlier argument.
        if (paramTy.isFn && argTypes[i].tag === "fn") {
          const argFn = argTypes[i] as Extract<TypeKind, { tag: "fn" }>;
          const unifyFn = (mt: MiloType | undefined, tk: TypeKind | undefined) => {
            if (!mt || !tk) return;
            let t = tk;
            if ((mt.isRef || mt.isRefMut) && t.tag === "ref") t = t.inner;
            // Same wrapper rule as everywhere else: `(&[T]) => R` names T as the slice's
            // ELEMENT. Binding the whole `[i64]` here only ever went unnoticed because
            // an earlier argument had usually pinned T already.
            if (genericFn.typeParams.includes(mt.name) && !mt.isArray && !mt.isPtr) {
              if (!typeMap.has(mt.name)) typeMap.set(mt.name, t);
              return;
            }
            if (mt.typeArgs || mt.isArray || mt.isPtr) this.inferTypeParamsFromHint(mt, t, genericFn.typeParams, typeMap);
          };
          if (paramTy.fnParams) {
            for (let k = 0; k < paramTy.fnParams.length && k < argFn.params.length; k++) {
              unifyFn(paramTy.fnParams[k], argFn.params[k]);
            }
          }
          unifyFn(paramTy.fnRet, argFn.ret);
        }
      }

      // infer missing type params from return type hint
      let missing = genericFn.typeParams.filter(p => !typeMap.has(p));
      if (missing.length > 0 && this.returnHint) {
        this.inferTypeParamsFromHint(genericFn.decl.retType, this.returnHint, genericFn.typeParams, typeMap);
        missing = genericFn.typeParams.filter(p => !typeMap.has(p));
      }
      if (missing.length > 0) {
        this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.func}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }

      const typeArgs = genericFn.typeParams.map(p => must(typeMap, p, "type map"));
      this.warnAdoptRawFields(expr.func, genericFn.decl.span, typeArgs, sp);
      const mangled = this.monomorphizeFn(expr.func, typeArgs, sp);
      this.rewrittenCalls.set(expr, mangled);

      const concreteSig = must(this.functions, mangled, "functions");
      for (let i = 0; i < expr.args.length; i++) {
        const sigParamTy = i < concreteSig.params.length ? concreteSig.params[i].type : undefined;
        if (sigParamTy?.tag === "ref") {
          this.setAutoBorrowChecked(expr.args[i], sigParamTy.mutable, sp);
          continue;
        }
        // Auto-move closure args (parity with the non-generic call path):
        // without this, a closure passed to a generic fn keeps its non-Copy
        // captures owned by the enclosing scope, which then drops them while
        // the closure still references them — a use-after-free. Skip when the
        // closure mutates a capture (it must write back to the original).
        if (expr.args[i].kind === "Closure" && i < concreteSig.params.length
            && concreteSig.params[i].type.tag === "fn" && !(expr.args[i] as any).isMove) {
          const caps = this.closureCaptures.get(expr.args[i]);
          // A capture mutated in place needs write-back, so it cannot be
          // move-captured; one merely read or moved-out is safe to move.
          if (!caps?.some(c => c.mutatedInClosure)) (expr.args[i] as any).isMove = true;
        }
        this.tryMove(expr.args[i]);
      }
      // check requires contracts at call site (generic fn)
      if (genericFn.decl) this.checkCallSiteContracts(genericFn.decl, expr.args, sp);
      this.requireUnsafeCall(genericFn.decl, expr.func, sp);

      return this.setType(expr, must(this.functions, mangled, "functions").ret);
    }

    // A callable in the local scope wins over a global of the same name. Globals used
    // to be consulted first, so a parameter could never shadow one — which meant a
    // user defining `fn handler` broke std/http's *internal* `handler(ctx)` call
    // against its own param, reporting a type error inside a file the user never
    // opened. Innermost binding wins, as everywhere else in the language.
    const localCallable = this.lookup(expr.func);
    const sig = (localCallable && (localCallable.type.tag === "fn" || localCallable.type.tag === "cfn")) ? undefined : this.functions.get(expr.func);
    if (!sig) {
      const varInfo = localCallable;
      if (varInfo && (varInfo.type.tag === "fn" || varInfo.type.tag === "cfn")) {
        // Calling a moved closure is a use like any other. This path never checked it,
        // which was invisible while nothing released a closure environment — the call
        // simply ran against memory still lying around. Once an owning closure has a
        // destructor it is a genuine use-after-free: `Task.spawn(f)` moves `f` into the
        // task, the task is reaped, and `f()` afterwards runs from a freed environment.
        if (varInfo.moved) {
          this.error(`use of moved variable '${expr.func}'`, sp,
            varInfo.consumedByCall
              ? `'${expr.func}' moves a captured value out of itself when it runs, so calling it consumes it: the second call would see that capture already gone. Build a second closure, or clone what it captures inside the body instead of moving it.`
              : varInfo.type.tag === "fn" && varInfo.type.owning === true
              ? `'${expr.func}' is a 'move' closure and it was transferred earlier, so calling it here would run against an environment its new owner may already have released.`
              : `ownership of '${expr.func}' was transferred earlier and it can no longer be used here.`);
        }
        varInfo.read = true;
        const fnType = varInfo.type;
        if (expr.args.length !== fnType.params.length) {
          this.error(`closure expects ${fnType.params.length} args, got ${expr.args.length}`, sp);
        }
        for (let i = 0; i < Math.min(expr.args.length, fnType.params.length); i++) {
          const paramType = fnType.params[i];
          const hint = paramType.tag === "ref" ? paramType.inner : paramType;
          const argType = this.checkExprWithHint(expr.args[i], hint);
          if (paramType.tag === "ref") {
            if (argType.tag === "ref" && typeEq(paramType.inner, argType.inner)) {
              continue;
            }
            this.setAutoBorrowChecked(expr.args[i], paramType.mutable, sp);
            if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
              this.error(`closure argument ${i + 1}: expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span);
            }
          } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
            this.error(`closure argument ${i + 1}: expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span);
          }
        }
        for (let i = 0; i < Math.min(expr.args.length, fnType.params.length); i++) {
          if (fnType.params[i].tag === "ref") continue;
          if (expr.args[i].kind === "Closure" && fnType.params[i].tag === "fn" && !(expr.args[i] as any).isMove) {
            const caps = this.closureCaptures.get(expr.args[i]);
            if (!caps?.some(c => c.mutable)) (expr.args[i] as any).isMove = true;
          }
          this.tryMove(expr.args[i]);
        }
        // Calling a closure that moves a capture out consumes the closure: the call
        // empties the environment slots its captures live in, so a second call reads
        // zeroed captures. Before this, the second call silently returned a wrong
        // answer (and, before captures aliased their slots, double-freed).
        if (varInfo.callsOnce && !varInfo.moved) {
          varInfo.moved = true;
          varInfo.consumedByCall = true;
        }
        if (fnType.tag === "cfn") this.cfnCalls.set(expr, fnType);
        else this.closureCalls.set(expr, fnType);
        return this.setType(expr, fnType.ret);
      }
      // Promise(fn) → Promise<T>.run(fn) with T inferred from closure return type
      if (expr.func === "Promise" && this.genericStructs.has("Promise") && expr.args.length === 1) {
        const argType = this.checkExprWithHint(expr.args[0], { tag: "fn", params: [], ret: { tag: "unknown" } });
        if (argType.tag !== "fn") {
          this.error(`Promise() argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const mangled = this.monomorphizeStruct("Promise", [argType.ret]);
        while (this._pendingImplFns.length > 0) {
          const fn = this._pendingImplFns.shift()!;
          this.checkFunction(fn);
        }
        const inherent = this.inherentImpls.get(mangled);
        const runSig = inherent?.methods.get("run");
        if (!runSig) {
          this.error(`'${mangled}' has no 'run' method`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (expr.args[0].kind === "Closure" && !(expr.args[0] as any).isMove) {
          const caps = this.closureCaptures.get(expr.args[0]);
          if (!caps?.some(c => c.mutable)) (expr.args[0] as any).isMove = true;
        }
        this.tryMove(expr.args[0]);
        this.rewrittenCalls.set(expr, `${mangled}$run`);
        return this.setType(expr, runSig.ret);
      }
      this.error(`undefined function '${expr.func}'`, sp); return this.setType(expr, { tag: "unknown" });
    }
    if (expr.func === "assert") {
      if (expr.args.length < 1 || expr.args.length > 2) {
        this.error(`assert() expects 1-2 arguments, got ${expr.args.length}`, sp);
        return this.setType(expr, { tag: "void" });
      }
      const condType = this.checkExpr(expr.args[0]);
      if (condType.tag !== "bool" && condType.tag !== "unknown") {
        this.error(`assert() condition must be bool, got ${this.show(condType)}`, sp);
      }
      if (expr.args.length === 2) {
        const msgType = this.checkExpr(expr.args[1]);
        if (msgType.tag !== "string" && msgType.tag !== "unknown") {
          this.error(`assert() message must be a string, got ${this.show(msgType)}`, sp);
        }
      }
      return this.setType(expr, { tag: "void" });
    }
    if (expr.func === "max" || expr.func === "min") {
      if (expr.args.length !== 2) {
        this.error(`${expr.func}() expects 2 arguments, got ${expr.args.length}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      const aType = this.checkExpr(expr.args[0]);
      const bType = this.checkExpr(expr.args[1]);
      if (aType.tag !== "int" && aType.tag !== "float" && aType.tag !== "unknown") {
        this.error(`${expr.func}() arguments must be numeric`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      if (!typeEq(aType, bType) && bType.tag !== "unknown" && aType.tag !== "unknown") {
        this.error(`${expr.func}() arguments must be the same type, got ${this.show(aType)} and ${this.show(bType)}`, sp);
      }
      return this.setType(expr, aType.tag !== "unknown" ? aType : bType);
    }
    if (sig.variadic) {
      if (expr.args.length < sig.params.length) this.error(`function '${expr.func}' expects at least ${sig.params.length} args, got ${expr.args.length}`, sp);
    } else if (expr.args.length !== sig.params.length) {
      this.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`, sp);
    }
    for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
      const paramType = sig.params[i].type;
      const hint = paramType.tag === "ref" ? paramType.inner : paramType;
      const argType = this.checkExprWithHint(expr.args[i], hint);
      if (paramType.tag === "ref") {
        if (argType.tag === "ref" && typeEq(paramType.inner, argType.inner)) {
          // A `&[T]` slice is a %Vec *value*, not a bare pointer. To match the `ptr`
          // param ABI it must be passed by reference (its address materialized) —
          // otherwise a slice rvalue (`f(v[a..b])`, `f(c.view())`) is passed by value
          // and the callee reads a garbage length. Other refs are already pointers.
          if (paramType.inner.tag === "array" && paramType.inner.size === null) {
            this.setAutoBorrowChecked(expr.args[i], paramType.mutable, sp);
          }
          continue;
        }
        this.setAutoBorrowChecked(expr.args[i], paramType.mutable, sp);
        // Vec<T> auto-coerces to &[T] / &mut [T] (same {ptr,len,cap} layout; callee
        // ignores cap). For &mut the setAutoBorrowChecked above already rejected an
        // immutable source and froze the Vec exclusively for the borrow's life.
        if (paramType.inner.tag === "array" && paramType.inner.size === null
            && argType.tag === "vec" && typeEq(paramType.inner.element, argType.element)) {
          continue;
        }
        // A FIXED array satisfies a slice parameter too. Unlike a Vec this is not a
        // pass-through: `[N x T]` is an inline layout and the callee expects the
        // `{ptr,len,cap}` view, so the conversion is recorded here and materialised in
        // lowering. Without it `total(v)` worked and `total(a)` did not, for the same
        // function and the same element type.
        if (paramType.inner.tag === "array" && paramType.inner.size === null
            && argType.tag === "array" && argType.size !== null
            && typeEq(paramType.inner.element, argType.element)) {
          this.arraySliceArgs.add(expr.args[i]);
          continue;
        }
        if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
          if (!this.tryInterfaceCoercion(expr.args[i], argType, paramType)) {
            this.error(`argument ${i + 1} of '${expr.func}': expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span, this.optionUnwrapHint(paramType, argType));
          }
        }
      } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
        // String auto-coerces to *u8 for FFI/builtins
        const isStringToPtr = argType.tag === "string" && paramType.tag === "ptr" && paramType.inner.tag === "int" && paramType.inner.bits === 8;
        // [T; N] auto-decays to *T for FFI (array → ptr-to-element)
        const isArrayToPtr = argType.tag === "array" && paramType.tag === "ptr" && typeEq(argType.element, paramType.inner);
        // T auto-wraps to Option<T> (Some(value))
        const optInner = this.optionInnerType(paramType);
        const isOptionWrap = optInner !== null && typeEq(optInner, argType) && paramType.tag === "enum";
        // A flexible const-int binding adopts the param's int width (first use).
        const flexInfo = paramType.tag === "int" ? this.flexIntBinding(expr.args[i]) : null;
        if (isOptionWrap) {
          this.autoWrappedOption.set(expr.args[i], paramType.name);
        } else if (flexInfo && this.resolveFlexInt(flexInfo, paramType, expr.args[i])) {
          // resolved
        } else if (!isStringToPtr && !isArrayToPtr) {
          if (!this.tryInterfaceCoercion(expr.args[i], argType, paramType)) {
            this.error(`argument ${i + 1} of '${expr.func}': expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span, this.optionUnwrapHint(paramType, argType));
          }
        }
      }
      // A ranged-int parameter (`p: i32(0..100)`) enforces its bound on the argument —
      // statically for a literal, else a runtime range check. Previously unchecked.
      if (paramType.tag === "int") this.enforceRangeInto(expr.args[i], argType, paramType, expr.args[i].span);
    }
    for (let i = sig.params.length; i < expr.args.length; i++) {
      const vt = this.checkExpr(expr.args[i]);
      // a struct in the variadic (...) tail has no defined C ABI classification — reject
      if (sig.isExtern && vt.tag === "struct") {
        this.error(`argument ${i + 1} of '${expr.func}': struct '${vt.name}' cannot be passed in a variadic position`, expr.args[i].span,
          `pass it by reference (&${vt.name}) instead`);
      }
    }
    for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
      if (sig.params[i].type.tag === "ref") continue;
      // String→*u8 auto-coercion borrows the ptr, doesn't move the String
      const argType = this.exprTypes.get(expr.args[i]);
      const paramType = sig.params[i].type;
      if (argType?.tag === "string" && paramType.tag === "ptr") continue;
      if (argType?.tag === "array" && paramType.tag === "ptr") continue;
      // auto-move: closure literal passed to owned fn param (skip if closure mutates captures)
      if (expr.args[i].kind === "Closure" && paramType.tag === "fn" && !(expr.args[i] as any).isMove) {
        const caps = this.closureCaptures.get(expr.args[i]);
        if (!caps?.some(c => c.mutable)) (expr.args[i] as any).isMove = true;
      }
      this.tryMove(expr.args[i]);
    }
    this.checkCallSiteExclusivity(expr.args, sp);
    // safe extern call: no unsafe needed if all args are safe-passable and return is scalar/void.
    // Compute safety unconditionally (not just at depth 0) so an unsafe-requiring extern call
    // marks its enclosing block used, while a safe one leaves the block flagged unused.
    if (sig.isExtern) {
      // an extern struct is POD (whitelisted fields, no drop glue) — passing/returning
      // it by value is a plain bit copy with no provenance, so no unsafe is needed
      const retSafe = isScalar(sig.ret) || this.isExternStructType(sig.ret);
      let argsSafe = retSafe;
      if (argsSafe) {
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          const paramType = sig.params[i].type;
          const argType = this.exprTypes.get(expr.args[i]);
          if (isScalar(paramType)) continue;
          if (paramType.tag === "ref") continue;
          // by-value extern struct arg with an exact type match — safe POD copy
          if (this.isExternStructType(paramType) && argType && typeEq(paramType, argType)) continue;
          // fn param with matching fn arg — safe (caller provides valid function)
          if (paramType.tag === "fn" && argType?.tag === "fn") continue;
          // *T param with matching *T, string, or [T;N] arg
          if (paramType.tag === "ptr" && argType) {
            if (argType.tag === "ptr" && typeEq(argType.inner, paramType.inner)) continue;
            if (argType.tag === "string" && paramType.inner.tag === "int" && paramType.inner.bits === 8) continue;
            if (argType.tag === "array" && typeEq(argType.element, paramType.inner)) continue;
          }
          argsSafe = false;
          break;
        }
      }
      if (!argsSafe) {
        // teach the rule, not just the verdict — it's otherwise learned by trial-and-error
        const why = !retSafe
          ? `it returns ${this.show(sig.ret)} (non-scalar)`
          : `an argument doesn't auto-coerce`;
        this.requireUnsafe(`calling extern function '${expr.func}' requires an unsafe block`, sp,
          `extern calls are safe only when every arg is scalar, &T, fn, string/array→*T, or a by-value extern struct, AND the return is scalar/void/extern-struct — here ${why}`);
      }
    }
    // check requires contracts at call site
    const fnDecl = this.fnDecls.get(expr.func);
    if (fnDecl) this.checkCallSiteContracts(fnDecl, expr.args, sp);
    this.requireUnsafeCall(fnDecl, expr.func, sp);

    return this.setType(expr, sig.ret);
  }

  private checkStructLitExpr(expr: ExprOf<"StructLit">): TypeKind {
    const sp = expr.span;
    // anonymous struct literal: { field: value, ... }
    if (expr.name === "") {
      if (expr.fields.length === 0) { this.error(`anonymous struct literal must have at least one field`, sp); return this.setType(expr, { tag: "unknown" }); }
      const fields: { name: string; type: TypeKind }[] = [];
      for (const f of expr.fields) {
        const valType = this.checkExpr(f.value);
        fields.push({ name: f.name, type: valType });
        this.tryMove(f.value);
      }
      const anonName = `__Anon${this.anonStructCounter++}`;
      this.structs.set(anonName, { fields });
      this.anonStructs.push({ name: anonName, fields });
      this.rewrittenStructLits.set(expr, anonName);
      return this.setType(expr, { tag: "struct", name: anonName });
    }
    const genericInfo = this.genericStructs.get(expr.name);
    if (genericInfo) {
      const typeMap = new Map<string, TypeKind>();
      for (const f of expr.fields) {
        const declField = genericInfo.decl.fields.find(d => d.name === f.name);
        if (!declField) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp, memberHint(f.name, genericInfo.decl.fields.map(d => d.name))); continue; }
        const valType = this.checkExpr(f.value);
        // Infer type params from the field's declared (unsubstituted) type against the
        // argument's concrete type — recursively, so `Vec<T>`/`[T]`/nested generics
        // resolve, not just a bare `T` field.
        this.inferTypeParamsFromHint(declField.type, valType, genericInfo.typeParams, typeMap);
      }
      const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
      if (missing.length > 0) {
        this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for struct '${expr.name}'`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      const typeArgs = genericInfo.typeParams.map(p => must(typeMap, p, "type map"));
      const mangled = this.monomorphizeStruct(expr.name, typeArgs);
      this.rewrittenStructLits.set(expr, mangled);
      const info = must(this.structs, mangled, "structs");
      for (const f of expr.fields) {
        const fieldDef = info.fields.find(d => d.name === f.name);
        if (!fieldDef) continue;
        const valType = must(this.exprTypes, f.value, "expr types");
        if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
          this.error(`field '${f.name}' of '${expr.name}': expected ${this.show(fieldDef.type)}, got ${this.show(valType)}`, sp);
        }
        // Record the move of the field value out of its source. Without this a non-Copy
        // value (Vec/String/…) moved into a *generic* struct field was never marked moved,
        // so its source kept its alive-flag and was dropped again at scope exit — a
        // double-free. The non-generic and anonymous branches already do this.
        this.tryMove(f.value);
      }
      for (const d of info.fields) {
        if (!expr.fields.find(f => f.name === d.name)) {
          this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
        }
      }
      return this.setType(expr, { tag: "struct", name: mangled });
    }
    const info = this.structs.get(expr.name);
    if (!info) { this.error(`unknown struct '${expr.name}'`, sp); return this.setType(expr, { tag: "unknown" }); }
    for (const f of expr.fields) {
      const fieldDef = info.fields.find(d => d.name === f.name);
      if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp, memberHint(f.name, info.fields.map(d => d.name))); continue; }
      let valType = this.checkExprWithHint(f.value, fieldDef.type);
      if (fieldDef.type.tag === "int" && valType.tag === "int" && !typeEq(fieldDef.type, valType) && this.isConstIntExpr(f.value)) {
        this.retypeConstInt(f.value, fieldDef.type);
        valType = fieldDef.type;
      }
      const cfnField = fieldDef.type.tag === "cfn" ? fieldDef.type : null;
      if (cfnField) {
        if (valType.tag !== "unknown" && !this.checkCFnStore(f.value, cfnField, valType, `field '${f.name}' of '${expr.name}'`, sp)) {
          this.error(`field '${f.name}' of '${expr.name}': expected ${this.show(fieldDef.type)}, got ${this.show(valType)}`, sp);
        }
      } else if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown" && !this.tryInterfaceCoercion(f.value, valType, fieldDef.type)) {
        this.error(`field '${f.name}' of '${expr.name}': expected ${this.show(fieldDef.type)}, got ${this.show(valType)}`, sp);
      }
      this.tryMove(f.value);
    }
    for (const d of info.fields) {
      if (!expr.fields.find(f => f.name === d.name)) {
        this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
      }
    }
    return this.setType(expr, { tag: "struct", name: expr.name });
  }

  private checkFieldAccessExpr(expr: ExprOf<"FieldAccess">): TypeKind {
    const sp = expr.span;
    // Float namespace constants resolve before the object is checked: `f64` is a type,
    // not a variable, so checkExpr(object) would report it undefined.
    const fnc = floatNamespaceConst(expr);
    if (fnc) return this.setType(expr, { tag: "float", bits: fnc.bits });
    this.placeBaseDepth++;
    let objType = this.checkExpr(expr.object);
    this.placeBaseDepth--;
    // auto-deref through references for field access
    if (objType.tag === "ref") objType = objType.inner;
    // auto-deref through pointers for field access (requires unsafe)
    if (objType.tag === "ptr" && objType.inner.tag === "struct") {
      this.requireUnsafe(`pointer field access requires 'unsafe' block`, sp);
      objType = objType.inner;
    }
    if (objType.tag === "struct") {
      const info = this.structs.get(objType.name);
      if (!info) { this.error(`unknown struct '${objType.name}'`, sp); return this.setType(expr, { tag: "unknown" }); }
      const field = info.fields.find(f => f.name === expr.field);
      if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp, memberHint(expr.field, this.fieldCandidates(objType))); return this.setType(expr, { tag: "unknown" }); }
      this.setType(expr, field.type);
      if (field.type.tag === "cfn") this.strandedCFnReads.set(expr, { struct: objType.name, field: expr.field, span: sp });
      // The field's own move state, the counterpart of the `info.moved` check on a
      // plain identifier. `setType` first: `staticFieldPath` reads the recorded
      // types to walk the place, so the answer depends on this node having one.
      const place = this.staticFieldPath(expr);
      const rootInfo = place ? this.lookup(place.root) : null;
      if (place && rootInfo) {
        const gone = this.movedPlaceCovering(rootInfo, place.path);
        if (gone) {
          this.error(`use of moved value '${place.root}${place.path}'`, sp,
            gone === place.path
              ? `ownership of '${place.root}${place.path}' was transferred earlier — the field is empty now. Clone it at the point of transfer: '${place.root}${place.path}.clone()'.`
              : `'${place.root}${gone}' was moved out earlier, which took '${place.root}${place.path}' with it. Clone at the point of transfer: '${place.root}${gone}.clone()'.`);
        }
      }
      return field.type;
    }
    if (objType.tag === "enum") {
      this.error(`cannot access field on enum '${objType.name}' — use match to extract values`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    if (objType.tag === "array" && expr.field === "len") {
      // fixed arrays: compile-time i32 constant; slices: runtime i64 (matches Vec)
      return this.setType(expr, { tag: "int", bits: objType.size !== null ? 32 : 64, signed: true });
    }
    if (objType.tag === "string" && expr.field === "len") {
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (objType.tag === "vec" && expr.field === "len") {
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (objType.tag === "hashmap" && expr.field === "len") {
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    this.error(`cannot access field '${expr.field}' on type ${this.show(objType)}`, sp,
      memberHint(expr.field, this.fieldCandidates(objType)));
    return this.setType(expr, { tag: "unknown" });
  }

  private checkArrayLitExpr(expr: ExprOf<"ArrayLit">): TypeKind {
    const sp = expr.span;
    if (expr.elements.length === 0) {
      this.error("cannot infer type of empty array literal", sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const elemType = this.checkExpr(expr.elements[0]);
    for (let i = 1; i < expr.elements.length; i++) {
      const t = this.checkExpr(expr.elements[i]);
      if (!typeEq(elemType, t) && t.tag !== "unknown") {
        this.error(`array element ${i}: expected ${this.show(elemType)}, got ${this.show(t)}`, expr.elements[i].span);
      }
    }
    // The literal owns its elements exactly as the hinted (`let a: [T; n] = [...]`) path
    // already records; without this, `[s]` left `s` usable after it was handed over, and
    // `[v[0]]` copied a Drop element out of `v` unchecked.
    for (const el of expr.elements) this.tryMove(el);
    return this.setType(expr, { tag: "array", element: elemType, size: expr.elements.length });
  }

  private checkArrayRepeatExpr(expr: ExprOf<"ArrayRepeat">): TypeKind {
    const elemType = this.checkExprWithHint(expr.value, null);
    return this.setType(expr, { tag: "array", element: elemType, size: expr.count });
  }

  private checkIndexAccessExpr(expr: ExprOf<"IndexAccess">): TypeKind {
    const sp = expr.span;
    this.placeBaseDepth++;
    const rawObjType = this.checkExpr(expr.object);
    this.placeBaseDepth--;
    const objType = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
    const idxType = this.checkExpr(expr.index);
    if (idxType.tag !== "int" && idxType.tag !== "unknown") {
      this.error(`array index must be integer, got ${this.show(idxType)}`, sp);
    }
    if (objType.tag === "array") return this.setType(expr, objType.element);
    if (objType.tag === "vec") return this.setType(expr, objType.element);
    if (objType.tag === "string") return this.setType(expr, { tag: "int", bits: 8, signed: false });
    if (objType.tag === "ptr") {
      this.requireUnsafe(`pointer indexing requires 'unsafe' block`, sp);
      return this.setType(expr, objType.inner);
    }
    this.error(`cannot index type ${this.show(objType)}`, sp);
    return this.setType(expr, { tag: "unknown" });
  }

  // Arity and per-argument checking for a static / enum-variant call: auto-borrow for a
  // `&T` param, the closure-capture rule that makes a non-mutating closure a move, and the
  // moves themselves. Two call sites (the inherent-impl path and the static-method path)
  // carried this verbatim and diverged only after it, so an auto-borrow fix in one would
  // have silently missed the other. Returns paramOffset — the caller needs to know whether
  // a `self` was stripped before it can line args up with the signature's contracts.
  private checkStaticCallArgs(
    sig: { params: { name: string; type: TypeKind }[] },
    expr: any,
    sp: Span | undefined,
  ): number {
    const paramOffset = (sig.params.length > 0 && sig.params[0].name === "self") ? 1 : 0;
    const expectedParams = sig.params.slice(paramOffset);
    if (expr.args.length !== expectedParams.length) {
      this.error(`'${expr.enumName}.${expr.variant}' expects ${expectedParams.length} args, got ${expr.args.length}`, sp);
    }
    for (let i = 0; i < Math.min(expr.args.length, expectedParams.length); i++) {
      const paramType = expectedParams[i].type;
      const hint = paramType.tag === "ref" ? paramType.inner : paramType;
      const argType = this.checkExprWithHint(expr.args[i], hint);
      if (paramType.tag === "ref") {
        if (!(argType.tag === "ref" && typeEq(paramType.inner, argType.inner))) {
          this.setAutoBorrowChecked(expr.args[i], paramType.mutable, sp);
          if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
            this.error(`'${expr.variant}' argument ${i + 1}: expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span);
          }
        }
      } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
        this.error(`'${expr.variant}' argument ${i + 1}: expected ${this.show(paramType)}, got ${this.show(argType)}`, expr.args[i].span);
      }
      if (expr.args[i].kind === "Closure" && paramType.tag === "fn" && !(expr.args[i] as any).isMove) {
        const caps = this.closureCaptures.get(expr.args[i]);
        if (!caps?.some(c => c.mutable)) (expr.args[i] as any).isMove = true;
      }
      if (paramType.tag !== "ref") this.tryMove(expr.args[i]);
    }
    return paramOffset;
  }

  private checkEnumLitExpr(expr: ExprOf<"EnumLit">): TypeKind {
    const sp = expr.span;
    // Promise.all(args) / Promise.race(args) → promiseAll(args) / promiseRace(args)
    if (expr.enumName === "Promise" && (expr.variant === "all" || expr.variant === "race")) {
      const fnName = expr.variant === "all" ? "promiseAll" : "promiseRace";
      const genericFn = this.genericFns.get(fnName);
      if (genericFn && expr.args.length === 1) {
        const argType = this.checkExpr(expr.args[0]);
        const typeMap = new Map<string, TypeKind>();
        for (let i = 0; i < Math.min(1, genericFn.decl.params.length); i++) {
          const paramTy = declaredType(genericFn.decl.params[i]);
          if (paramTy.typeArgs) {
            let argResolved = argType;
            if (argResolved.tag === "ref") argResolved = argResolved.inner;
            if (argResolved.tag === "vec" && argResolved.element.tag === "struct") {
              const info = this.structs.get(argResolved.element.name);
              if (info?.typeArgs && info.typeArgs.length > 0) {
                typeMap.set(genericFn.typeParams[0], info.typeArgs[0]);
              }
            }
          }
        }
        if (typeMap.size > 0) {
          const typeArgs = genericFn.typeParams.map(p => must(typeMap, p, "type map"));
          const mangled = this.monomorphizeFn(fnName, typeArgs);
          this.rewrittenCalls.set(expr as any, mangled);
          const concreteSig = must(this.functions, mangled, "functions");
          if (concreteSig.params[0]?.type.tag === "ref") {
            this.autoBorrowed.set(expr.args[0], { mutable: false });
          } else {
            this.tryMove(expr.args[0]);
          }
          return this.setType(expr, concreteSig.ret);
        }
      }
    }
    // `Kind.tryFrom(n)` on a repr'd enum → Option<Kind>. The partial reverse of `k as i32`;
    // most integers are not a variant, so the honest signature is Option, not a trap.
    {
      const reprInfo = this.enums.get(expr.enumName);
      if (expr.variant === "tryFrom" && reprInfo?.reprType) {
        if (expr.args.length !== 1) { this.error(`'${expr.enumName}.tryFrom' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'${expr.enumName}.tryFrom': expected an integer, got ${this.show(argType)}`, sp);
        return this.setType(expr, this.resolveOptionForValue({ tag: "enum", name: expr.enumName }, sp));
      }
    }
    if (expr.enumName === "String" && expr.variant === "withCapacity") {
      if (expr.args.length !== 1) { this.error(`'String.withCapacity' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      const argType = this.checkExpr(expr.args[0]);
      if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'String.withCapacity': expected integer, got ${this.show(argType)}`, sp);
      return this.setType(expr, { tag: "string" });
    }
    if (expr.enumName === "Vec" && expr.variant === "new") {
      if (expr.args.length !== 0) this.error(`'Vec.new' takes no arguments`, sp);
      this.error(`cannot infer Vec element type — add a type annotation: 'let v: Vec<T> = Vec.new()'`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    if (expr.enumName === "Vec" && (expr.variant === "withCapacity" || expr.variant === "filled")) {
      this.error(`cannot infer Vec element type — add a type annotation: 'let v: Vec<T> = Vec.${expr.variant}(...)'`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    if (expr.enumName === "HashMap" && (expr.variant === "new" || expr.variant === "withCapacity")) {
      if (expr.variant === "new" && expr.args.length !== 0) this.error(`'HashMap.new' takes no arguments`, sp);
      this.error(`cannot infer HashMap types — add a type annotation: 'let m: HashMap<K, V> = HashMap.${expr.variant}(${expr.variant === "new" ? "" : "n"})'`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const genericInfo = this.genericEnums.get(expr.enumName);
    if (genericInfo) {
      const variant = genericInfo.variants.get(expr.variant);
      if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return this.setType(expr, { tag: "unknown" }); }
      if (expr.args.length !== variant.fields.length) {
        this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
      }
      const typeMap = new Map<string, TypeKind>();
      for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
        const field = variant.fields[i];
        let argType = this.checkExpr(expr.args[i]);
        if (field.tag === "int" && argType.tag === "int" && !typeEq(field, argType) && this.isConstIntExpr(expr.args[i])) {
          this.retypeConstInt(expr.args[i], field);
          argType = field;
        }
        if (field.tag === "struct" && genericInfo.typeParams.includes(field.name)) {
          const existing = typeMap.get(field.name);
          if (existing && !typeEq(existing, argType)) {
            this.error(`conflicting inference for type parameter '${field.name}'`, sp);
          } else {
            typeMap.set(field.name, argType);
          }
        } else if (!typeEq(field, argType) && argType.tag !== "unknown") {
          this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${this.show(field)}, got ${this.show(argType)}`, expr.args[i].span);
        }
        this.tryMove(expr.args[i]);
      }
      // fill uninferred type params from defaults
      if (genericInfo.typeParamDefaults) {
        for (let i = 0; i < genericInfo.typeParams.length; i++) {
          const p = genericInfo.typeParams[i];
          if (!typeMap.has(p) && genericInfo.typeParamDefaults[i]) {
            typeMap.set(p, genericInfo.typeParamDefaults[i]!);
          }
        }
      }
      const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
      if (missing.length > 0) {
        this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.enumName}.${expr.variant}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      const typeArgs = genericInfo.typeParams.map(p => must(typeMap, p, "type map"));
      const mangled = this.monomorphizeEnum(expr.enumName, typeArgs, sp);
      this.rewrittenEnums.set(expr, mangled);
      return this.setType(expr, { tag: "enum", name: mangled });
    }
    // Infer the type arguments a bare `Pair.new(...)` did not spell, so the call below
    // sees the same shape the turbofish produces.
    if ((!expr.typeArgs || expr.typeArgs.length === 0) && this.genericStructs.has(expr.enumName)
        && !this.enums.has(expr.enumName) && !this.structs.has(expr.enumName)) {
      const inferred = this.inferGenericStaticTypeArgs(expr);
      if (inferred === "argError") return this.setType(expr, { tag: "unknown" });
      if (inferred) expr.typeArgs = inferred;
    }
    // generic struct static call: Struct<T>.method(args) with explicit type args
    if (expr.typeArgs && expr.typeArgs.length > 0 && this.genericStructs.has(expr.enumName)) {
      const typeArgs = expr.typeArgs.map(ta => this.resolve(ta));
      const mangled = this.monomorphizeStruct(expr.enumName, typeArgs);
      // process pending impl methods that monomorphization may have generated
      this.flushStructBounds();
      while (this._pendingImplFns.length > 0) {
        const fn = this._pendingImplFns.shift()!;
        if (this.fromBoundFailedStruct(fn)) continue;
        this.checkFunction(fn);
      }
      const inherent = this.inherentImpls.get(mangled);
      if (inherent) {
        const sig = inherent.methods.get(expr.variant);
        if (sig) {
          const mangledMethod = `${mangled}$${expr.variant}`;
          this.checkStaticCallArgs(sig, expr, sp);
          this.staticCalls.set(expr, mangledMethod);
          // Send enforcement for thread-crossing closures lives in checkThreadBoundary,
          // driven by `@thread` on the declaration — see the comment there for what the
          // hardcoded version that used to sit here missed.
          return this.setType(expr, sig.ret);
        }
      }
      const asMethod2 = this.staticCallOnVariable(expr);
      if (asMethod2) return asMethod2;
      this.error(`'${expr.enumName}<...>' has no static method '${expr.variant}'`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const info = this.enums.get(expr.enumName);
    if (!info) {
      // static method call: Struct.method(args)
      const inherent = this.inherentImpls.get(expr.enumName);
      if (inherent) {
        const sig = inherent.methods.get(expr.variant);
        if (sig) {
          const mangled = `${expr.enumName}$${expr.variant}`;
          // static methods have no self param — check args directly
          const paramOffset = this.checkStaticCallArgs(sig, expr, sp);
          this.staticCalls.set(expr, mangled);
          // Precondition checking on a static method call (Math.sqrt(-1.0) etc).
          // Only when there is no `self` param, so args align 1:1 with the sig's
          // params the way checkCallSiteContracts expects.
          if (paramOffset === 0 && sig.contracts && sig.contracts.length > 0) {
            this.checkCallSiteContracts({ params: sig.params, contracts: sig.contracts } as any, expr.args, sp);
          }
          // Send enforcement: Thread.spawn() requires all closure captures to be Send
          if (expr.enumName === "Thread" && expr.variant === "spawn" && expr.args.length === 1 && expr.args[0].kind === "Closure") {
            const captures = this.closureCaptures.get(expr.args[0]);
            if (captures) {
              for (const cap of captures) {
                if (!this.isSend(cap.type)) {
                  this.error(
                    `cannot send '${cap.name}' of type '${this.show(cap.type)}' across threads — type does not implement Send`,
                    expr.args[0].span,
                    this.whyNotSend(cap.type),
                  );
                }
              }
            }
          }
          return this.setType(expr, sig.ret);
        }
      }
      const asMethod = this.staticCallOnVariable(expr);
      if (asMethod) return asMethod;
      this.errorUnknownStatic(expr.enumName, expr.variant, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const variant = info.variants.get(expr.variant);
    if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return this.setType(expr, { tag: "unknown" }); }
    if (expr.args.length !== variant.fields.length) {
      this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
    }
    for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
      let argType = this.checkExprWithHint(expr.args[i], variant.fields[i]);
      if (variant.fields[i].tag === "int" && argType.tag === "int" && !typeEq(variant.fields[i], argType) && this.isConstIntExpr(expr.args[i])) {
        this.retypeConstInt(expr.args[i], variant.fields[i]);
        argType = variant.fields[i];
      }
      if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
        this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${this.show(variant.fields[i])}, got ${this.show(argType)}`, expr.args[i].span);
      }
      this.tryMove(expr.args[i]);
    }
    return this.setType(expr, { tag: "enum", name: expr.enumName });
  }

  private checkUnwrapExpr(expr: ExprOf<"Unwrap">): TypeKind {
    const sp = expr.span;
    const operandType = this.checkExpr(expr.operand);
    const inner = this.unwrapableInner(operandType);
    if (!inner) {
      this.error(`'!' requires Option or Result type, got ${this.show(operandType)}`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    // `!` moves the payload out and codegen zeros the source slot; mark the
    // operand moved so a later use is a compile error, not a silent read of
    // the zeroed value. tryMove no-ops on Copy operands.
    this.tryMove(expr.operand);
    return this.setType(expr, inner);
  }

  private checkPropagateExpr(expr: ExprOf<"Propagate">): TypeKind {
    const sp = expr.span;
    const operandType = this.checkExpr(expr.operand);
    const inner = this.unwrapableInner(operandType);
    if (!inner) {
      this.error(`'?' requires Option or Result type, got ${this.show(operandType)}`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    // `?` consumes the operand (Err returns it, Ok extracts the payload and
    // codegen zeros the slot); mark it moved so a later use errors instead of
    // silently reading the zeroed value. tryMove no-ops on Copy operands.
    this.tryMove(expr.operand);
    const retInner = this.unwrapableInner(this.currentFnRetType);
    if (!retInner) {
      this.error(`'?' requires function to return Option or Result, but returns ${this.show(this.currentFnRetType)}`, sp);
      return this.setType(expr, inner);
    }
    // Option ? in Option fn, or Result ? in Result fn — match error side only
    const operandIsOption = this.isOptionLike(operandType);
    const retIsOption = this.isOptionLike(this.currentFnRetType);
    if (operandIsOption !== retIsOption) {
      this.error(`'?' on ${operandIsOption ? "Option" : "Result"} requires function to return ${operandIsOption ? "Option" : "Result"}, but returns ${this.show(this.currentFnRetType)}`, sp);
    } else if (!operandIsOption) {
      // both Result-like: Err types must match, or From conversion must exist
      const operandErr = this.unwrapableErr(operandType);
      const retErr = this.unwrapableErr(this.currentFnRetType);
      if (operandErr && retErr && !typeEq(operandErr, retErr)) {
        const conversion = this.findFromConversion(operandErr, retErr);
        if (conversion) {
          this.propagateConversions.set(expr, conversion);
        } else {
          this.error(`'?' error type mismatch: '${this.show(operandErr)}' cannot convert to '${this.show(retErr)}' (no wrapping variant found)`, sp);
        }
      }
    }
    return this.setType(expr, inner);
  }

  private checkDefaultValueExpr(expr: ExprOf<"DefaultValue">): TypeKind {
    const sp = expr.span;
    const operandType = this.checkExpr(expr.operand);
    const inner = this.unwrapableInner(operandType);
    if (!inner) {
      this.error(`'??' requires Option or Result type, got ${this.show(operandType)}`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const defaultType = this.checkExprWithHint(expr.default, inner);
    if (!typeEq(inner, defaultType) && defaultType.tag !== "unknown") {
      this.error(`'??' default type mismatch: expected ${this.show(inner)}, got ${this.show(defaultType)}`, sp);
    }
    // `??` consumes BOTH operands wherever it is evaluated: codegen moves the payload
    // out of the Option and moves the default in, whichever branch runs. `moveTargets`
    // has always known that (`case "DefaultValue": return [operand, default]`), but it
    // is only reached when the RESULT lands in a move position — so `let s = o ?? d`
    // was checked and `(o ?? d).len` was not. The moves still happened: after it, `d`
    // read back as "" and `o` still reported `Some` with an emptied payload, both with
    // no diagnostic, which is the silent-empty-string failure the move checker exists
    // to prevent. Record them here, where the operator is checked, so the use position
    // of the result cannot change whether ownership is tracked. tryMoveLeaf gates on
    // isCopy itself, so `Option<i64> ?? 0` still moves nothing.
    this.tryMove(expr.operand);
    this.tryMove(expr.default);
    return this.setType(expr, inner);
  }

  private checkCastExprExpr(expr: ExprOf<"CastExpr">): TypeKind {
    const sp = expr.span;
    const fromType = this.checkExpr(expr.operand);
    const toType = this.resolve(expr.targetType);
    // A repr'd (C-like) enum casts to its integer value — always defined, since every
    // variant has a discriminant. Only to an integer type: `Kind.tryFrom` is the reverse.
    const fromReprEnum = fromType.tag === "enum" && !!this.enums.get(fromType.name)?.reprType;
    if (fromReprEnum && toType.tag !== "int") {
      this.error(`enum '${fromType.name}' casts only to an integer type, not ${this.show(toType)}`, sp);
    }
    const fromOk = isNumeric(fromType) || fromType.tag === "bool" || fromType.tag === "ptr" || fromType.tag === "array" || fromType.tag === "fn" || fromType.tag === "cfn" || fromType.tag === "string" || fromType.tag === "unknown" || fromReprEnum;
    // ptr -> cfn is how a dlsym result becomes callable; cfn -> ptr passes one back out
    const toOk = isNumeric(toType) || toType.tag === "ptr" || toType.tag === "cfn";
    if (!fromOk) {
      this.error(`cannot cast from ${this.show(fromType)}`, sp);
    }
    if (!toOk) {
      this.error(`cannot cast to ${this.show(toType)}`, sp);
    }
    const isNullPtrConst = toType.tag === "ptr" && expr.operand.kind === "IntLit" && expr.operand.value === 0n;
    if (toType.tag === "ptr" && !isNullPtrConst) {
      this.requireUnsafe(`cast to pointer type requires 'unsafe' block`, sp);
    }
    return this.setType(expr, toType);
  }

  private checkClosureExpr(expr: ExprOf<"Closure">): TypeKind {
    const sp = expr.span;
    const paramHints = this.closureParamHints;
    this.closureParamHints = null;
    const retHint = this.closureRetHint;
    this.closureRetHint = null;
    const savedClosureScopeDepth = this.closureScopeDepth;
    const savedClosureCaptures = this.currentClosureCaptures;
    this.currentClosureCaptures = new Map();
    this.pushScope();
    this.closureScopeDepth = this.scopes.length - 1;
    const paramTypes: TypeKind[] = [];
    for (let i = 0; i < expr.params.length; i++) {
      const p = expr.params[i];
      let pType: TypeKind;
      if (p.type) {
        pType = this.resolve(p.type);
      } else if (paramHints && i < paramHints.length) {
        pType = paramHints[i];
      } else {
        this.error(`cannot infer type for parameter '${p.name}'; add a type annotation`, sp);
        pType = { tag: "unknown" };
      }
      paramTypes.push(pType);
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false, span: p.span });
    }
    // An explicit annotation always wins; otherwise take the caller's expected return
    // type so literals in the body get coerced against it (`() => 0` against an
    // Option<i32> is i32, not i64). Falls back to inferring from the body, which is
    // what a hint of `unknown` (e.g. Vec.map, whose U is whatever you return) leaves.
    let inferredRet: TypeKind = expr.retType
      ? this.resolve(expr.retType)
      : (retHint && retHint.tag !== "unknown" ? retHint : { tag: "unknown" });
    const savedRetType = this.currentFnRetType;
    this.currentFnRetType = inferredRet;
    // A closure body is a fresh function body: its `return` returns from the CLOSURE,
    // and any loop enclosing the closure literal is not a loop around these statements.
    // Leaving the enclosing loop state visible here let a move inside the body be
    // credited as "moved only on a path that returns", which checkLoopMoves then
    // excuses AND resets — so `while … { spawn(move () => f(s)) }` compiled clean and
    // handed every iteration after the first an empty `s`. Wrong values, no diagnostic.
    // The direct spelling (`s.len` rather than `f(s)`) was rejected, which is the
    // give-away: one operation, two spellings, two answers.
    const savedLoopDepth = this.loopDepth;
    const savedInReturnInLoop = this.inReturnInLoop;
    this.loopDepth = 0;
    this.inReturnInLoop = false;
    for (const s of expr.body) this.checkStmt(s, inferredRet);
    this.loopDepth = savedLoopDepth;
    this.inReturnInLoop = savedInReturnInLoop;
    if (inferredRet.tag === "unknown" && expr.body.length > 0) {
      const lastStmt = expr.body[expr.body.length - 1];
      if (lastStmt.kind === "Return" && lastStmt.value) {
        inferredRet = this.exprTypes.get(lastStmt.value) ?? { tag: "void" };
      } else if (lastStmt.kind === "ExprStmt") {
        inferredRet = { tag: "void" };
      } else {
        inferredRet = { tag: "void" };
      }
    }
    this.currentFnRetType = savedRetType;
    this.popScope();
    const captures = Array.from(this.currentClosureCaptures.values());
    this.closureCaptures.set(expr, captures);
    if ((expr as any).isMove && captures.some(c => c.consumedInClosure)) this.onceClosures.add(expr);
    for (const cap of captures) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const info = this.scopes[i].get(cap.name);
        if (info) {
          // A closure env is storage, and references are second-class. Capturing a
          // view outlived its source once the closure escaped the frame that owned
          // the Vec — `let s = v[0..2]; return move () => s[0]` read freed memory.
          if (info.type.tag === "ref") {
            this.error(`cannot capture '${cap.name}' in a closure`, expr.span,
              `'${cap.name}' is a reference — a closure stores its captures, and a closure can outlive the storage this points into; capture an owned value (.clone() it) instead`);
          }
          this.freeze(info, null);
          break;
        }
      }
    }
    this.closureScopeDepth = savedClosureScopeDepth;
    this.currentClosureCaptures = savedClosureCaptures;
    // Owning only when it MOVED something in. `move` with no captures lowers to a null
    // environment and owns nothing, so typing it as owning would make it non-Copy for no
    // reason; a by-reference closure's environment is a stack slot in the frame that built
    // it, which that frame already owns. Only a move closure with captures holds heap.
    const owning = !!(expr as { isMove?: boolean }).isMove && captures.length > 0;
    return this.setType(expr, owning
      ? { tag: "fn", params: paramTypes, ret: inferredRet, owning: true }
      : { tag: "fn", params: paramTypes, ret: inferredRet });
  }

  private checkMethodCallExpr(expr: ExprOf<"MethodCall">): TypeKind {
    const sp = expr.span;
    const rawObjType = this.checkExpr(expr.object);
    // auto-deref `&T` for method dispatch (mutating methods still need !isRootMutable to allow)
    const objTypeRaw = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
    // A slice (`&[T]`, an array with no size) carries the SAME `%Vec` layout a Vec does —
    // `llvmType` returns `%Vec` for both — so the read-only combinators need no separate
    // emitter and were excluded only because the arm below gates on `tag === "vec"`. That
    // walled them off from every function taking a slice: `fn total(s: &[i64]) { s.sum() }`
    // reported *"type '[i64]' has no method 'sum'"*.
    //
    // Whitelisted rather than widened, because the same arm also carries `push`/`pop`/
    // `insert`/`sort` — a slice is a non-owning view and must not grow or reorder its
    // source. Anything outside this set still reaches the array path and is rejected.
    // A FIXED array reaches the same set, but the lowerer has to materialise a full-range
    // slice for it rather than re-tag: `[N x T]` is an inline layout, not a `%Vec`. Both
    // arms are normalised here so the arm below sees one shape.
    const objType = (objTypeRaw.tag === "array"
      && (objTypeRaw.size === null
        ? SLICE_COMBINATORS.has(expr.method)
        : ARRAY_COMBINATORS.has(expr.method)))
      ? { tag: "vec", element: objTypeRaw.element } as TypeKind
      : objTypeRaw;
    if ((objType.tag === "int" || objType.tag === "float" || objType.tag === "bool") && expr.method === "toString") {
      if (expr.args.length !== 0) { this.error(`'toString' takes no arguments`, sp); }
      return this.setType(expr, { tag: "string" });
    }
    // x.addrOf(): *T — raw address of any lvalue (the replacement for `&x`).
    // Universal (any receiver), lvalue-only, requires unsafe. Lowers to the
    // same address-of the old `&x` emitted (see lower.ts) → IR unchanged.
    if (expr.method === "addrOf") {
      if (expr.args.length !== 0) { this.error(`'addrOf' takes no arguments`, sp); }
      this.requireUnsafe(`'addrOf' (raw address-of) requires 'unsafe' block`, sp);
      if (expr.object.kind !== "Ident" && expr.object.kind !== "FieldAccess" && expr.object.kind !== "IndexAccess")
        this.error(`'addrOf' requires an lvalue (variable, field, or index)`, sp);
      return this.setType(expr, { tag: "ptr", inner: objType });
    }
    // v.ptr(): *T — a Vec's backing DATA pointer (first element). Safe to
    // obtain (mirrors string.cstr); the Vec stays live in the caller. Fixed
    // arrays already auto-coerce to *T (pass bare), so this is Vec-only.
    if (objType.tag === "vec" && expr.method === "ptr") {
      if (expr.args.length !== 0) { this.error(`'ptr' takes no arguments`, sp); }
      return this.setType(expr, { tag: "ptr", inner: objType.element });
    }
    // h.ptr(): *T — the box pointer of a `Heap<T>`, the give leg `adopt` is the take
    // leg of. Safe for the same reason `v.ptr()` is: the `Heap` stays live in the caller
    // and this only reads the pointer it already is. Without it, handing C a Milo-owned
    // object needed `h.addrOf()` and a load through it — the address of the SLOT, not of
    // the box. A user `impl` method named `ptr` on T wins, since a `Heap<T>` receiver
    // otherwise resolves to T's methods.
    if (objType.tag === "heap" && expr.method === "ptr"
        && !this.resolveMethod(typeName(objType.inner), "ptr")) {
      if (expr.args.length !== 0) { this.error(`'ptr' takes no arguments`, sp); }
      if (objType.inner.tag === "interface") {
        // A `Heap<dyn I>` is {box, vtable}; there is no single pointer that is the value,
        // and free-ing the box alone would strand the dispatch half of it.
        this.error(`'ptr' is not available on Heap<${this.show(objType.inner)}>`, sp,
          `an interface box carries a vtable alongside the allocation, so no single raw pointer represents it`);
        return this.setType(expr, { tag: "unknown" });
      }
      return this.setType(expr, { tag: "ptr", inner: objType.inner });
    }
    // Option combinators — isSome/isNone/unwrapOr. Gated on baseName so a user
    // enum's own impl method of the same name still resolves normally below.
    if (objType.tag === "enum" && this.enums.get(objType.name)?.baseName === "Option") {
      if (expr.method === "isSome" || expr.method === "isNone") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "unwrapOr") {
        if (expr.args.length !== 1) { this.error(`'unwrapOr' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (inner && !this.isCopyType(inner)) {
          // select-based lowering copies the payload; for owned types that would
          // alias the heap buffer (double-free). Move-out needs match.
          this.error(`'unwrapOr' on a non-Copy Option<${this.show(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const at = this.checkExprWithHint(expr.args[0], inner);
          if (!typeEq(inner, at) && at.tag !== "unknown") {
            this.error(`'unwrapOr': default must be ${this.show(inner)}, got ${this.show(at)}`, sp);
          }
          return this.setType(expr, inner);
        }
        return this.setType(expr, { tag: "unknown" });
      }
      // map(f): Option<T> -> Option<U>. The callback takes the payload BY REF, which is
      // why this needs no Copy gate (unlike unwrapOr/unwrapOrElse, which load the
      // payload out): nothing is moved out of the receiver, so an owned inner can't be
      // aliased into two owners.
      //
      // Nor does this consume the receiver, unlike Result.map/mapErr/andThen. Those
      // forward the OTHER variant's payload into the result untouched, so receiver and
      // result would both own one buffer. Option's other variant is None, which carries
      // no payload — there is nothing to forward, so the asymmetry is real, not an
      // oversight.
      if (expr.method === "map") {
        if (expr.args.length !== 1) { this.error(`'map' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (!inner) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "map", sp);
        if (cbType.tag !== "fn") {
          this.error(`'map' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (cbType.ret.tag === "void") {
          this.error(`'map': callback must return a value — use 'match' for a side effect`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, { tag: "enum", name: this.monomorphizeEnum("Option", [cbType.ret]) });
      }
      // unwrapOrElse(f) — like unwrapOr but the default is computed only when None.
      // Same Copy gate as unwrapOr, for the same reason: the payload is loaded, not
      // moved out.
      if (expr.method === "unwrapOrElse") {
        if (expr.args.length !== 1) { this.error(`'unwrapOrElse' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (inner && !this.isCopyType(inner)) {
          this.error(`'unwrapOrElse' on a non-Copy Option<${this.show(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const cbHint: TypeKind = { tag: "fn", params: [], ret: inner };
          const cbType = this.checkExprWithHint(expr.args[0], cbHint);
          this.checkCallbackSig(cbType, cbHint, "unwrapOrElse", sp);
          if (cbType.tag !== "fn") {
            this.error(`'unwrapOrElse' argument must be a function`, sp);
            return this.setType(expr, inner);
          }
          if (cbType.params.length !== 0) {
            this.error(`'unwrapOrElse': callback takes no arguments`, sp);
          }
          if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
            this.error(`'unwrapOrElse': callback must return ${this.show(inner)}, got ${this.show(cbType.ret)}`, sp);
          }
          return this.setType(expr, inner);
        }
        return this.setType(expr, { tag: "unknown" });
      }
      // andThen(f): Option<T> -> Option<U>, f returning the whole Option — the chaining
      // form, so a walk of fallible steps stays one Option deep instead of nesting.
      // Same two properties as map, for the same reasons: the callback takes the payload
      // by ref (no Copy gate) and None carries no payload to forward (no consume).
      if (expr.method === "andThen") {
        if (expr.args.length !== 1) { this.error(`'andThen' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (!inner) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "andThen", sp);
        if (cbType.tag !== "fn") {
          this.error(`'andThen' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Option") {
          this.error(`'andThen': callback must return an Option, got ${this.show(ret)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, ret);
      }
      // orElse(f): Option<T> -> Option<T>, f: () -> Option<T> — the None-side andThen,
      // for "try this source, else that one" without unwrapping in between. The Some
      // branch forwards the receiver's payload into the result, so a non-Copy T consumes
      // the receiver (same rule as Result.map/andThen).
      if (expr.method === "orElse") {
        if (expr.args.length !== 1) { this.error(`'orElse' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (!inner) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [], ret: objType };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "orElse", sp);
        if (cbType.tag !== "fn") {
          this.error(`'orElse' argument must be a function`, sp);
          return this.setType(expr, objType);
        }
        if (cbType.params.length !== 0) {
          this.error(`'orElse': callback takes no arguments`, sp);
        }
        const ret = cbType.ret;
        if (ret.tag !== "unknown") {
          const cbInner = ret.tag === "enum" && this.enums.get(ret.name)?.baseName === "Option"
            ? this.unwrapableInner(ret) : null;
          if (!cbInner || !typeEq(cbInner, inner)) {
            this.error(`'orElse': callback must return Option<${this.show(inner)}>, got ${this.show(ret)}`, sp);
          }
        }
        this.consumeForwardedPayload(expr.object, inner);
        return this.setType(expr, objType);
      }
    }
    // Result combinators — isOk/isErr/unwrapOr, mirroring Option (Ok is tag 0).
    if (objType.tag === "enum" && this.enums.get(objType.name)?.baseName === "Result") {
      if (expr.method === "isOk" || expr.method === "isErr") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "unwrapOr") {
        if (expr.args.length !== 1) { this.error(`'unwrapOr' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        if (inner && !this.isCopyType(inner)) {
          this.error(`'unwrapOr' on a non-Copy Result<${this.show(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const at = this.checkExprWithHint(expr.args[0], inner);
          if (!typeEq(inner, at) && at.tag !== "unknown") {
            this.error(`'unwrapOr': default must be ${this.show(inner)}, got ${this.show(at)}`, sp);
          }
          return this.setType(expr, inner);
        }
        return this.setType(expr, { tag: "unknown" });
      }
      // map(f): Result<T,E> -> Result<U,E>. Like Option.map the callback takes the
      // payload BY REF, which is why there is no Copy gate: nothing is moved out of
      // the receiver, so an owned Ok payload can't end up with two owners.
      // The Err payload IS forwarded into the result untouched though, so a non-Copy
      // E must consume the receiver — see the consume block below.
      if (expr.method === "map") {
        if (expr.args.length !== 1) { this.error(`'map' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        const errT = this.unwrapableErr(objType);
        if (!inner || !errT) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "map", sp);
        if (cbType.tag !== "fn") {
          this.error(`'map' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (cbType.ret.tag === "void") {
          this.error(`'map': callback must return a value — use 'match' for a side effect`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        // Err payload is copied through into the result. Owned E would then be
        // reachable from both the receiver and the result, and both get drop glue.
        this.consumeForwardedPayload(expr.object, errT);
        return this.setType(expr, { tag: "enum", name: this.monomorphizeEnum("Result", [cbType.ret, errT]) });
      }
      // mapErr(f): Result<T,E> -> Result<T,F> — the mirror of map, callback on the Err side.
      if (expr.method === "mapErr") {
        if (expr.args.length !== 1) { this.error(`'mapErr' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        const errT = this.unwrapableErr(objType);
        if (!inner || !errT) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "mapErr", sp);
        if (cbType.tag !== "fn") {
          this.error(`'mapErr' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (cbType.ret.tag === "void") {
          this.error(`'mapErr': callback must return a value — use 'match' for a side effect`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        // Mirror of map: mapErr forwards the OK payload through untouched.
        this.consumeForwardedPayload(expr.object, inner);
        return this.setType(expr, { tag: "enum", name: this.monomorphizeEnum("Result", [inner, cbType.ret]) });
      }
      // andThen(f): Result<T,E> -> Result<U,E>, f returning the whole Result. The Err
      // type must match the receiver's: the Err branch forwards the receiver's payload
      // unchanged, so there is no conversion available for a mismatched E.
      if (expr.method === "andThen") {
        if (expr.args.length !== 1) { this.error(`'andThen' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        const errT = this.unwrapableErr(objType);
        if (!inner || !errT) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "andThen", sp);
        if (cbType.tag !== "fn") {
          this.error(`'andThen' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Result") {
          this.error(`'andThen': callback must return a Result, got ${this.show(ret)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const cbErr = this.unwrapableErr(ret);
        if (cbErr && !typeEq(cbErr, errT)) {
          this.error(`'andThen': callback's error type must be ${this.show(errT)}, got ${this.show(cbErr)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        // Like map, the Err payload is forwarded into the result untouched.
        this.consumeForwardedPayload(expr.object, errT);
        return this.setType(expr, ret);
      }
      // unwrapOrElse(f) — unwrapOr with the default computed only on Err. Unlike Option's
      // (whose failure carries nothing) the callback receives the error by ref, so the
      // default can depend on what went wrong. Same Copy gate as unwrapOr: the Ok payload
      // is loaded out, not moved.
      if (expr.method === "unwrapOrElse") {
        if (expr.args.length !== 1) { this.error(`'unwrapOrElse' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        const errT = this.unwrapableErr(objType);
        if (inner && !this.isCopyType(inner)) {
          this.error(`'unwrapOrElse' on a non-Copy Result<${this.show(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner && errT) {
          const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: inner };
          const cbType = this.checkExprWithHint(expr.args[0], cbHint);
          this.checkCallbackSig(cbType, cbHint, "unwrapOrElse", sp);
          if (cbType.tag !== "fn") {
            this.error(`'unwrapOrElse' argument must be a function`, sp);
            return this.setType(expr, inner);
          }
          if (cbType.params.length !== 1) {
            this.error(`'unwrapOrElse': callback takes 1 argument, the error`, sp);
          }
          if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
            this.error(`'unwrapOrElse': callback must return ${this.show(inner)}, got ${this.show(cbType.ret)}`, sp);
          }
          return this.setType(expr, inner);
        }
        return this.setType(expr, { tag: "unknown" });
      }
      // orElse(f): Result<T,E> -> Result<T,F> — the Err-side andThen. f receives the error
      // and returns a whole Result, so a failed step can be recovered or its error retyped.
      // The Ok payload is forwarded into the result, so a non-Copy T consumes the receiver.
      if (expr.method === "orElse") {
        if (expr.args.length !== 1) { this.error(`'orElse' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const inner = this.unwrapableInner(objType);
        const errT = this.unwrapableErr(objType);
        if (!inner || !errT) return this.setType(expr, { tag: "unknown" });
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: { tag: "unknown" } };
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "orElse", sp);
        if (cbType.tag !== "fn") {
          this.error(`'orElse' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Result") {
          this.error(`'orElse': callback must return a Result, got ${this.show(ret)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const cbOk = this.unwrapableInner(ret);
        if (cbOk && !typeEq(cbOk, inner)) {
          this.error(`'orElse': callback's ok type must be ${this.show(inner)}, got ${this.show(cbOk)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        this.consumeForwardedPayload(expr.object, inner);
        return this.setType(expr, ret);
      }
    }
    // wrapping/saturating/checked arithmetic methods on integers
    if (objType.tag === "int") {
      const wrappingMethods = ["wrappingAdd", "wrappingSub", "wrappingMul"];
      const saturatingMethods = ["saturatingAdd", "saturatingSub", "saturatingMul"];
      const checkedMethods = ["checkedAdd", "checkedSub", "checkedMul", "checkedDiv", "checkedRem"];
      if (wrappingMethods.includes(expr.method) || saturatingMethods.includes(expr.method)) {
        // Must return, not fall through: `this.error` accumulates a diagnostic
        // and keeps going, so with zero args the `args[0]` below is undefined.
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const argType = this.checkExprWithHint(expr.args[0], objType);
        if (!typeEq(objType, argType) && argType.tag !== "unknown") {
          this.error(`'${expr.method}': expected ${this.show(objType)}, got ${this.show(argType)}`, sp);
        }
        return this.setType(expr, objType);
      }
      if (checkedMethods.includes(expr.method)) {
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const argType = this.checkExprWithHint(expr.args[0], objType);
        if (!typeEq(objType, argType) && argType.tag !== "unknown") {
          this.error(`'${expr.method}': expected ${this.show(objType)}, got ${this.show(argType)}`, sp);
        }
        return this.setType(expr, this.resolveOptionForValue(objType, sp));
      }
      // unary negation — desugars to sub(0, x) in lowering, so overflow
      // semantics (None only at signed INT_MIN / unsigned nonzero) fall out for free
      if (expr.method === "wrappingNeg") {
        if (expr.args.length !== 0) { this.error(`'wrappingNeg' takes no arguments`, sp); }
        return this.setType(expr, objType);
      }
      if (expr.method === "checkedNeg") {
        if (expr.args.length !== 0) { this.error(`'checkedNeg' takes no arguments`, sp); }
        return this.setType(expr, this.resolveOptionForValue(objType, sp));
      }
      // bit-counting intrinsics — 0-arg, count fits any width so result is i64
      const bitCountMethods = ["countOnes", "leadingZeros", "trailingZeros"];
      if (bitCountMethods.includes(expr.method)) {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      }
      // rotate: 1-arg shift (mod bit-width), returns same type
      if (expr.method === "rotateLeft" || expr.method === "rotateRight") {
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); }
        else {
          const at = this.checkExprWithHint(expr.args[0], objType);
          if (!typeEq(objType, at) && at.tag !== "unknown") {
            this.error(`'${expr.method}': shift amount must be ${this.show(objType)}, got ${this.show(at)}`, sp);
          }
        }
        return this.setType(expr, objType);
      }
      // reverseBits — 0-arg, returns same type
      if (expr.method === "reverseBits") {
        if (expr.args.length !== 0) { this.error(`'reverseBits' takes no arguments`, sp); }
        return this.setType(expr, objType);
      }
    }
    // frozen-collection guard: reject realloc/free-capable builtins on a borrowed receiver
    if ((objType.tag === "vec" || objType.tag === "hashmap" || objType.tag === "string")
        && MUTATING_COLLECTION_METHODS.has(expr.method)) {
      this.errorIfFrozen(expr.object, `call '${expr.method}' on`, sp);
    }
    // slices: `v[a..b]` desugars to `.slice(a,b)`; a slice is `&[T]` — a ref to an
    // unsized array, runtime rep = non-owning %Vec (cap=0, drop glue skips free)
    if ((objType.tag === "vec" || objType.tag === "array") && expr.method === "slice") {
      // fixed-size arrays slice into their own storage (view built in codegen);
      // the frozen-source rule below keeps the array alive for the view's life
      const refSlice: TypeKind = { tag: "ref", inner: { tag: "array", element: objType.element, size: null }, mutable: false };
      if (expr.args.length !== 2) { this.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, refSlice); }
      const startType = this.checkExpr(expr.args[0]);
      const endType = this.checkExpr(expr.args[1]);
      if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`slice start: expected integer, got ${this.show(startType)}`, sp);
      if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`slice end: expected integer, got ${this.show(endType)}`, sp);
      // A view of a TEMPORARY has nothing to freeze: `mk()[0..2]` points into a Vec that
      // no binding owns. `freezeViewSource` already rejects the method spelling of this
      // (`mk().view()`), and its comment is the reason to reject the slice one too: that
      // storage survives today only because temporaries leak, and it becomes a
      // use-after-free the moment they get drop glue. Three drop-glue paths landed this
      // session, so the gap between the two spellings is closing from the wrong side.
      if (!this.isPlaceExpr(expr.object)) {
        this.error(`cannot take a view of a temporary`, sp,
          `the '&[T]' would outlive the value it points into — bind the receiver first ('let r = ...' then slice 'r')`);
      }
      // freeze the source — mutation could realloc/free the memory this view points into
      this.freezeRootOf(expr.object);
      this.borrowedExprs.add(expr);
      return this.setType(expr, refSlice);
    }
    if (objType.tag === "array" && objType.size === null && expr.method === "len") {
      if (expr.args.length !== 0) this.error(`'len' takes no arguments`, sp);
      return this.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (objType.tag === "vec") {
      if (expr.method === "push") {
        if (expr.args.length !== 1) { this.error(`'push' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot push to immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        // Deferred-inference Vec (`var v = Vec.new()`): first push fixes the
        // element type. Resolve the shared placeholder object in place so the
        // binding, its exprType, and every later use all see the real element.
        if (this.inferVecElems.has(objType.element as object)) {
          const argType = this.checkExprWithHint(expr.args[0], null);
          // A pushed borrow would outlive the scope that owns the borrowed
          // value — the Vec survives it. Same rule as a struct field.
          if (argType.tag === "ref") {
            this.error(`push: cannot store a reference in a Vec`, sp, `references are second-class — push an owned value (clone it if needed)`);
          }
          this.inferVecElems.delete(objType.element as object);
          Object.assign(objType.element as object, argType);
          this.tryMove(expr.args[0]);
          this.holdPointerArgsIn(expr.object, expr.args);
          return this.setType(expr, { tag: "void" });
        }
        const argType = this.checkExprWithHint(expr.args[0], objType.element);
        if (argType.tag === "ref") {
          this.error(`push: cannot store a reference in a Vec`, sp, `references are second-class — push an owned value (clone it if needed)`);
        }
        if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
          if (!this.tryInterfaceCoercion(expr.args[0], argType, objType.element)) {
            this.error(`push: expected ${this.show(objType.element)}, got ${this.show(argType)}`, sp);
          }
        }
        this.tryMove(expr.args[0]);
        this.holdPointerArgsIn(expr.object, expr.args);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "clear" || expr.method === "truncate") {
        // truncate(n) drops everything at index >= n; clear() is truncate(0).
        const want = expr.method === "clear" ? 0 : 1;
        if (expr.args.length !== want) {
          this.error(`'${expr.method}' expects ${want} argument${want === 1 ? "" : "s"}, got ${expr.args.length}`, sp);
        }
        if (want === 1 && expr.args.length === 1) {
          const nType = this.checkExpr(expr.args[0]);
          if (nType.tag !== "int" && nType.tag !== "unknown") {
            this.error(`'truncate': expected an integer length, got ${this.show(nType)}`, sp);
          }
        }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot ${expr.method} an immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "pop") {
        if (expr.args.length !== 0) { this.error(`'pop' takes no arguments`, sp); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot pop from immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        // Returns Option<T> — Some(last) or None when empty; caller picks the
        // failure policy via `!`/`?`/`??`. Mirrors HashMap.get / Vec.find.
        return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
      }
      if (expr.method === "map") {
        if (expr.args.length !== 1) { this.error(`'map' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "unknown" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "map", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'map' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, { tag: "vec", element: cbType.ret });
      }
      if (expr.method === "filter") {
        if (expr.args.length !== 1) { this.error(`'filter' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "filter", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'filter' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, { tag: "vec", element: objType.element });
      }
      if (expr.method === "each") {
        if (expr.args.length !== 1) { this.error(`'each' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "void" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbSig = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbSig, cbHint, "each", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "enumerate") {
        if (expr.args.length !== 1) { this.error(`'enumerate' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "int", bits: 64, signed: true }, elemRef], ret: { tag: "void" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbSig = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbSig, cbHint, "enumerate", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "find") {
        if (expr.args.length !== 1) { this.error(`'find' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "find", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'find' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
      }
      if (expr.method === "any") {
        if (expr.args.length !== 1) { this.error(`'any' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbSig = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbSig, cbHint, "any", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "all") {
        if (expr.args.length !== 1) { this.error(`'all' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbSig = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbSig, cbHint, "all", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "join") {
        if (expr.args.length !== 1) { this.error(`'join' expects 1 argument (separator)`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (objType.element.tag !== "string") { this.error(`'join' is only available on Vec<string>`, sp); return this.setType(expr, { tag: "unknown" }); }
        const sepType = this.checkExpr(expr.args[0]);
        if (sepType.tag !== "string" && sepType.tag !== "unknown") { this.error(`'join' separator must be a string, got ${this.show(sepType)}`, sp); }
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "isEmpty") {
        if (expr.args.length !== 0) { this.error(`'isEmpty' takes no arguments`, sp); }
        return this.setType(expr, { tag: "bool" });
      }
      // fold(init, (acc, elem) => acc) — the accumulate half of the functional
      // set. `reduce` is accepted as the same operation because that is what
      // the majority of readers will type; the suggestion table points at
      // `fold` when neither spelling is a method (a non-Vec receiver).
      if (expr.method === "fold" || expr.method === "reduce") {
        if (expr.args.length !== 2) {
          this.error(`'${expr.method}' expects 2 arguments (initial value, callback)`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        let accType = this.checkExpr(expr.args[0]);
        // A bare `0` seed defaults to i64, which would make every fold over a
        // narrower Vec a width mismatch the writer has to spell around. When the
        // callback annotates its accumulator, that annotation is the real type —
        // adopt it before checking the callback, or the closure body reports the
        // mismatch first and the seed never gets a chance to widen. Only for a
        // constant seed, where re-typing loses nothing.
        const cb = expr.args[1];
        if (accType.tag === "int" && this.isConstIntExpr(expr.args[0]) &&
            cb.kind === "Closure" && cb.params.length > 0) {
          // A closure param may legitimately have no annotation, so read the
          // field directly rather than through declaredType (which throws).
          const declared = cb.params[0].type;
          if (declared) {
            const annotated = this.resolve(declared);
            if (annotated.tag === "int" && !typeEq(annotated, accType)) {
              this.retypeConstInt(expr.args[0], annotated);
              accType = annotated;
            }
          }
        }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [accType, elemRef], ret: accType };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[1], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'${expr.method}' argument 2 must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        // `fold` checked the callback's RETURN against the accumulator and never its
        // parameters, so `fold(0, (acc: i64, x: &string) => acc + x.len)` over a Vec<i64>
        // read each element as a string pointer and folded garbage.
        this.checkCallbackSig(cbType, cbHint, expr.method, sp);
        if (!typeEq(cbType.ret, accType) && cbType.ret.tag !== "unknown" && accType.tag !== "unknown") {
          this.error(`'${expr.method}' callback must return ${this.show(accType)} to match the initial value, got ${this.show(cbType.ret)}`, sp);
        }
        return this.setType(expr, accType);
      }
      if (expr.method === "sum") {
        if (expr.args.length !== 0) { this.error(`'sum' takes no arguments`, sp); }
        if (objType.element.tag !== "int" && objType.element.tag !== "float") {
          this.error(`'sum' requires a Vec of integers or floats, got Vec<${this.show(objType.element)}>`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, objType.element);
      }
      if (expr.method === "contains") {
        if (expr.args.length !== 1) { this.error(`'contains' expects 1 argument`, sp); return this.setType(expr, { tag: "bool" }); }
        const argType = this.checkExprWithHint(expr.args[0], objType.element);
        if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
          this.error(`'contains': expected ${this.show(objType.element)}, got ${this.show(argType)}`, sp);
        }
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "reverse") {
        if (expr.args.length !== 0) { this.error(`'reverse' takes no arguments`, sp); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot reverse immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "swap") {
        if (expr.args.length !== 2) { this.error(`'swap' expects 2 arguments (index a, index b)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot swap on immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const aType = this.checkExpr(expr.args[0]);
        const bType = this.checkExpr(expr.args[1]);
        if (aType.tag !== "int" && aType.tag !== "unknown") { this.error(`'swap' index must be an integer, got ${this.show(aType)}`, sp); }
        if (bType.tag !== "int" && bType.tag !== "unknown") { this.error(`'swap' index must be an integer, got ${this.show(bType)}`, sp); }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "insert") {
        if (expr.args.length !== 2) { this.error(`'insert' expects 2 arguments (index, value)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot insert into immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const idxType = this.checkExpr(expr.args[0]);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'insert' index must be an integer, got ${this.show(idxType)}`, sp); }
        const valType = this.checkExprWithHint(expr.args[1], objType.element);
        if (!typeEq(objType.element, valType) && valType.tag !== "unknown") {
          this.error(`'insert' value: expected ${this.show(objType.element)}, got ${this.show(valType)}`, sp);
        }
        this.tryMove(expr.args[1]);
        this.holdPointerArgsIn(expr.object, [expr.args[1]]);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "remove") {
        if (expr.args.length !== 1) { this.error(`'remove' expects 1 argument (index)`, sp); return this.setType(expr, objType.element); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot remove from immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const idxType = this.checkExpr(expr.args[0]);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'remove' index must be an integer, got ${this.show(idxType)}`, sp); }
        return this.setType(expr, objType.element);
      }
      if (expr.method === "sort") {
        if (expr.args.length !== 0) { this.error(`'sort' takes no arguments`, sp); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const el = objType.element;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
          this.error(`'sort' requires Vec of a comparable type (int, float, string, bool)`, sp);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "sortBy") {
        if (expr.args.length !== 1) { this.error(`'sortBy' expects 1 argument (comparator)`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef, elemRef], ret: { tag: "int", bits: 32, signed: true } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "sortBy", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'sortBy' argument must be a comparator function`, sp); }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "sortByKey") {
        if (expr.args.length !== 1) { this.error(`'sortByKey' expects 1 argument (key extractor)`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "unknown" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        // The one position where a closure may hand back a field of its borrowed
        // parameter: the sort reads the key to compare it and never stores or drops it.
        this.keyExtractorDepth++;
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "sortByKey", sp);
        this.keyExtractorDepth--;
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'sortByKey' argument must be a function`, sp); return this.setType(expr, { tag: "void" }); }
        const keyType = cbType.ret;
        if (keyType.tag !== "int" && keyType.tag !== "float" && keyType.tag !== "string" && keyType.tag !== "bool") {
          this.error(`'sortByKey' key must be a comparable type (int, float, string, bool), got ${this.show(keyType)}`, sp);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "len") {
        if (expr.args.length !== 0) { this.error(`'len' takes no arguments`, sp); }
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      }
      if (expr.method === "clone") {
        if (expr.args.length !== 0) { this.error(`'clone' takes no arguments`, sp); }
        // An interface value's itable has no clone slot, and a closure's
        // captured environment has no copy path — neither can be duplicated.
        const el = objType.element;
        if (el.tag === "interface") {
          this.error(`cannot clone Vec<${this.show(el)}>: an interface value has no clone`, sp,
            `the concrete type is erased and the itable carries no clone slot — build a new Vec from the concrete values instead`);
        } else if (el.tag === "fn") {
          this.error(`cannot clone Vec<${this.show(el)}>: closures cannot be cloned`, sp);
        } else {
          this.errorIfResourceCopyOut(el, "clone", "Vec", sp, `Build the copy element by element ('for x in v { out.push(x.clone()) }')`);
        }
        return this.setType(expr, objType);
      }
      // `v[i]` panics out of range; get/first/last are the total reads. The
      // element comes back cloned — a reference into the buffer could not
      // outlive a later push.
      if (expr.method === "get" || expr.method === "first" || expr.method === "last") {
        const want = expr.method === "get" ? 1 : 0;
        if (expr.args.length !== want) {
          this.error(`'${expr.method}' expects ${want} argument${want === 1 ? " (index)" : "s"}, got ${expr.args.length}`, sp);
        }
        if (want === 1 && expr.args.length === 1) {
          const idxType = this.checkExpr(expr.args[0]);
          if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'get' index must be an integer, got ${this.show(idxType)}`, sp); }
        }
        this.errorIfResourceCopyOut(objType.element, expr.method, "Vec", sp, `Borrow it ('v[i].field', 'for x in v'), or take it out for real with 'remove'/'pop'`);
        return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
      }
      // Same comparable-element gate `sort` uses. Milo has no ordering trait, so
      // rather than invent an ordering for structs (which would be an opinion, not
      // a fact — see the HashMap key note) min/max are refused on them outright.
      if (expr.method === "min" || expr.method === "max") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        const el = objType.element;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
          this.error(`'${expr.method}' requires a Vec of a comparable type (int, float, string, bool), got Vec<${this.show(el)}>`, sp,
            `there is no ordering on ${this.show(el)} — use 'fold' with your own comparison, or 'sortByKey' then 'first'`);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, this.resolveOptionForValue(el, sp));
      }
      // `find` answers "which value"; `indexOf`/`position` answer "where".
      if (expr.method === "indexOf") {
        if (expr.args.length !== 1) { this.error(`'indexOf' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const el = objType.element;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
          this.error(`'indexOf' requires a Vec of a comparable type (int, float, string, bool), got Vec<${this.show(el)}>`, sp,
            `use 'position' with a predicate instead`);
          return this.setType(expr, { tag: "unknown" });
        }
        const argType = this.checkExprWithHint(expr.args[0], el);
        if (!typeEq(el, argType) && argType.tag !== "unknown") {
          this.error(`'indexOf': expected ${this.show(el)}, got ${this.show(argType)}`, sp);
        }
        return this.setType(expr, this.resolveOptionForValue({ tag: "int", bits: 64, signed: true }, sp));
      }
      if (expr.method === "position") {
        if (expr.args.length !== 1) { this.error(`'position' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "position", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'position' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, this.resolveOptionForValue({ tag: "int", bits: 64, signed: true }, sp));
      }
      // extend moves the other Vec in — its elements are transplanted, not copied,
      // so there is no clone and no way to touch the source afterwards.
      if (expr.method === "extend") {
        if (expr.args.length !== 1) { this.error(`'extend' expects 1 argument (a Vec to append)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot extend an immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const otherType = this.checkExprWithHint(expr.args[0], objType);
        if (otherType.tag === "ref") {
          this.error(`'extend' takes ownership of the other Vec`, sp, `clone it if you still need it: 'v.extend(other.clone())'`);
        } else if (!typeEq(objType, otherType) && otherType.tag !== "unknown") {
          this.error(`'extend': expected ${this.show(objType)}, got ${this.show(otherType)}`, sp);
        }
        this.tryMove(expr.args[0]);
        return this.setType(expr, { tag: "void" });
      }
      // retain is filter's in-place twin: no second buffer, and the rejected
      // elements are dropped rather than leaked.
      if (expr.method === "retain") {
        if (expr.args.length !== 1) { this.error(`'retain' expects 1 argument (predicate)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot retain on an immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        this.checkCallbackSig(cbType, cbHint, "retain", sp);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'retain' argument must be a predicate function`, sp); }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "capacity") {
        if (expr.args.length !== 0) { this.error(`'capacity' takes no arguments`, sp); }
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      }
      if (expr.method === "reserve") {
        if (expr.args.length !== 1) { this.error(`'reserve' expects 1 argument (extra capacity)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot reserve on an immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const nType = this.checkExpr(expr.args[0]);
        if (nType.tag !== "int" && nType.tag !== "unknown") { this.error(`'reserve': expected an integer, got ${this.show(nType)}`, sp); }
        return this.setType(expr, { tag: "void" });
      }
      {
        const blanket = this.instantiateContainerImpl("Vec", [objType.element], expr.method);
        if (blanket) return this.dispatchMangledMethod(expr, blanket.mangled, sp);
      }
      this.error(`Vec has no method '${expr.method}'`, sp, memberHint(expr.method, VEC_MEMBERS));
      return this.setType(expr, { tag: "unknown" });
    }
    if (objType.tag === "hashmap") {
      if (expr.method === "insert") {
        if (expr.args.length !== 2) { this.error(`'insert' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot insert into immutable HashMap`, sp, `declare with 'var' to make it mutable`);
        }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`insert key: expected ${this.show(objType.key)}, got ${this.show(keyType)}`, sp);
        }
        const valType = this.checkExprWithHint(expr.args[1], objType.value);
        if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
          this.error(`insert value: expected ${this.show(objType.value)}, got ${this.show(valType)}`, sp);
        }
        this.tryMove(expr.args[0]);
        this.tryMove(expr.args[1]);
        this.holdPointerArgsIn(expr.object, expr.args);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "get") {
        if (expr.args.length !== 1) { this.error(`'get' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`get key: expected ${this.show(objType.key)}, got ${this.show(keyType)}`, sp);
        }
        this.errorIfResourceCopyOut(objType.value, "get", "HashMap", sp, `Borrow it with 'for k, v in m', or take it out for real with 'remove'`);
        const optionType = this.resolveOptionForValue(objType.value, sp);
        return this.setType(expr, optionType);
      }
      if (expr.method === "getOrDefault") {
        if (expr.args.length !== 2) { this.error(`'getOrDefault' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`getOrDefault key: expected ${this.show(objType.key)}, got ${this.show(keyType)}`, sp);
        }
        const valType = this.checkExprWithHint(expr.args[1], objType.value);
        if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
          this.error(`getOrDefault default: expected ${this.show(objType.value)}, got ${this.show(valType)}`, sp);
        }
        this.errorIfResourceCopyOut(objType.value, "getOrDefault", "HashMap", sp, `Borrow it with 'for k, v in m', or take it out for real with 'remove'`);
        return this.setType(expr, objType.value);
      }
      if (expr.method === "contains") {
        if (expr.args.length !== 1) { this.error(`'contains' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`contains key: expected ${this.show(objType.key)}, got ${this.show(keyType)}`, sp);
        }
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "remove") {
        if (expr.args.length !== 1) { this.error(`'remove' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot remove from immutable HashMap`, sp, `declare with 'var' to make it mutable`);
        }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`remove key: expected ${this.show(objType.key)}, got ${this.show(keyType)}`, sp);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "len") {
        if (expr.args.length !== 0) { this.error(`'len' takes no arguments`, sp); }
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      }
      if (expr.method === "isEmpty") {
        if (expr.args.length !== 0) { this.error(`'isEmpty' takes no arguments`, sp); }
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "clear") {
        if (expr.args.length !== 0) { this.error(`'clear' takes no arguments`, sp); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot clear an immutable HashMap`, sp, `declare with 'var' to make it mutable`);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "clone") {
        if (expr.args.length !== 0) { this.error(`'clone' takes no arguments`, sp); }
        for (const [what, t] of [["key", objType.key], ["value", objType.value]] as const) {
          if (t.tag === "interface") {
            this.error(`cannot clone a HashMap with ${what} type ${this.show(t)}: an interface value has no clone`, sp,
              `the concrete type is erased and the itable carries no clone slot`);
          } else if (t.tag === "fn") {
            this.error(`cannot clone a HashMap with ${what} type ${this.show(t)}: closures cannot be cloned`, sp);
          } else {
            this.errorIfResourceCopyOut(t, "clone", "HashMap", sp, `Build the copy entry by entry ('for k, v in m { out.insert(k.clone(), v.clone()) }')`);
          }
        }
        return this.setType(expr, objType);
      }
      // keys()/values() snapshot into a Vec. Iteration order is unspecified and
      // varies per process (the hash seed is randomized), so the snapshot is the
      // supported way to get a stable order: collect, then sort.
      if (expr.method === "keys" || expr.method === "values") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        const el = expr.method === "keys" ? objType.key : objType.value;
        if (el.tag === "interface" || el.tag === "fn") {
          this.error(`'${expr.method}' cannot copy ${this.show(el)} out of the map`, sp,
            `iterate with 'for k, v in map' instead — it borrows rather than copies`);
          return this.setType(expr, { tag: "unknown" });
        }
        this.errorIfResourceCopyOut(el, expr.method, "HashMap", sp, `Iterate with 'for k, v in m' instead, which borrows`);
        return this.setType(expr, { tag: "vec", element: el });
      }
      {
        const blanket = this.instantiateContainerImpl("HashMap", [objType.key, objType.value], expr.method);
        if (blanket) return this.dispatchMangledMethod(expr, blanket.mangled, sp);
      }
      this.error(`HashMap has no method '${expr.method}'`, sp, memberHint(expr.method, HASHMAP_MEMBERS));
      return this.setType(expr, { tag: "unknown" });
    }
    if (objType.tag === "string") {
      if (expr.method === "push") {
        if (expr.args.length !== 1) { this.error(`'push' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot push to immutable string`, sp, `declare with 'var' to make it mutable`);
        }
        // Hint the arg with u8 so an int literal coerces — `s.push(65)` demanded an
        // explicit `as u8` only because this checked without a hint, unlike Vec.push.
        // An out-of-range literal is still rejected by the coercion itself.
        const u8t: TypeKind = { tag: "int", bits: 8, signed: false };
        const argType = this.checkExprWithHint(expr.args[0], u8t);
        if (!typeEq(u8t, argType) && argType.tag !== "unknown") {
          this.error(`string.push: expected u8, got ${this.show(argType)}`, sp);
        }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "pushStr") {
        if (expr.args.length !== 1) { this.error(`'pushStr' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot push to immutable string`, sp, `declare with 'var' to make it mutable`);
        }
        const argType = this.checkExpr(expr.args[0]);
        const argInner = this.deref(argType);
        if (argInner.tag !== "string" && argInner.tag !== "unknown") {
          this.error(`string.pushStr: expected string, got ${this.show(argType)}`, sp);
        }
        this.setAutoBorrowChecked(expr.args[0], false);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "substr") {
        if (expr.args.length !== 2) { this.error(`'substr' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const startType = this.checkExpr(expr.args[0]);
        const endType = this.checkExpr(expr.args[1]);
        if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`substr start: expected integer, got ${this.show(startType)}`, sp);
        if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`substr end: expected integer, got ${this.show(endType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "slice") {
        const refStr: TypeKind = { tag: "ref", inner: { tag: "string" }, mutable: false };
        if (expr.args.length !== 2) { this.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, refStr); }
        const startType = this.checkExpr(expr.args[0]);
        const endType = this.checkExpr(expr.args[1]);
        if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`slice start: expected integer, got ${this.show(startType)}`, sp);
        if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`slice end: expected integer, got ${this.show(endType)}`, sp);
        // Same temporary hazard as the slice-of-Vec case above, same reasoning.
        if (!this.isPlaceExpr(expr.object)) {
          this.error(`cannot take a view of a temporary`, sp,
            `the '&string' would outlive the value it points into — bind the receiver first ('let r = ...' then slice 'r')`);
        }
        // mark source as borrowed — prevents mutation/move while slice is live.
        // Walk to the root variable: `buf.data[a..b]` views storage owned by `buf`,
        // so replacing any part of `buf` can free what this points into.
        this.freezeRootOf(expr.object);
        this.borrowedExprs.add(expr);
        return this.setType(expr, refStr);
      }
      if (expr.method === "parseF64") {
        if (expr.args.length !== 0) { this.error(`'parseF64' takes no arguments`, sp); }
        return this.setType(expr, { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "float", bits: 64 }]) });
      }
      if (expr.method === "clone") {
        if (expr.args.length !== 0) { this.error(`'clone' takes no arguments`, sp); }
        return this.setType(expr, { tag: "string" });
      }
      // string methods delegated to std/string runtime functions
      if (expr.method === "contains" || expr.method === "startsWith" || expr.method === "endsWith") {
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "bool" }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'${expr.method}': expected string, got ${this.show(argType)}`, sp);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "indexOf" || expr.method === "lastIndexOf") {
        const optionI64: TypeKind = { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, optionI64); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'${expr.method}': expected string, got ${this.show(argType)}`, sp);
        return this.setType(expr, optionI64);
      }
      // like indexOf but starts the search at byte offset `from`
      if (expr.method === "indexOfFrom") {
        const optionI64: TypeKind = { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
        if (expr.args.length !== 2) { this.error(`'indexOfFrom' expects 2 arguments (needle, from), got ${expr.args.length}`, sp); return this.setType(expr, optionI64); }
        const nType = this.checkExpr(expr.args[0]);
        if (nType.tag !== "string" && nType.tag !== "unknown") this.error(`'indexOfFrom' arg 1: expected string, got ${this.show(nType)}`, sp);
        const fromType = this.checkExpr(expr.args[1]);
        if (fromType.tag !== "int" && fromType.tag !== "unknown") this.error(`'indexOfFrom' arg 2: expected integer, got ${this.show(fromType)}`, sp);
        return this.setType(expr, optionI64);
      }
      if (expr.method === "split") {
        if (expr.args.length !== 1) { this.error(`'split' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "vec", element: { tag: "string" } }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'split': expected string, got ${this.show(argType)}`, sp);
        return this.setType(expr, { tag: "vec", element: { tag: "string" } });
      }
      if (expr.method === "isEmpty") {
        if (expr.args.length !== 0) { this.error(`'isEmpty' takes no arguments`, sp); }
        return this.setType(expr, { tag: "bool" });
      }
      // Loop-only: each piece is a `&string` view into the receiver, and a view has no
      // storage to live in outside the loop that freezes the receiver for it.
      if (expr.method === "lines" || expr.method === "splitView") {
        const owned = expr.method === "lines" ? `split("\\n")` : `split(sep)`;
        const call = expr.method === "lines" ? `lines()` : `splitView(sep)`;
        this.error(`'${expr.method}' is only valid as the iterable of a 'for ... in' loop over a named string`, sp,
          `it yields borrowed views, which cannot be stored — bind the string first ('let text = ...') and write 'for piece in text.${call}', or use '${owned}' for owned copies`);
        return this.setType(expr, { tag: "unknown" });
      }
      if (expr.method === "splitWords" || expr.method === "splitWhitespace") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        return this.setType(expr, { tag: "vec", element: { tag: "string" } });
      }
      if (expr.method === "trim" || expr.method === "trimStart" || expr.method === "trimEnd" || expr.method === "toLower" || expr.method === "toUpper" || expr.method === "reverse") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "charAt") {
        if (expr.args.length !== 1) { this.error(`'charAt' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'charAt': expected integer, got ${this.show(argType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "parseInt") {
        if (expr.args.length !== 0) { this.error(`'parseInt' takes no arguments`, sp); }
        return this.setType(expr, { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) });
      }
      if (expr.method === "replace" || expr.method === "replaceFirst") {
        if (expr.args.length !== 2) { this.error(`'replace' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const a1 = this.checkExpr(expr.args[0]);
        const a2 = this.checkExpr(expr.args[1]);
        if (a1.tag !== "string" && a1.tag !== "unknown") this.error(`'replace' arg 1: expected string, got ${this.show(a1)}`, sp);
        if (a2.tag !== "string" && a2.tag !== "unknown") this.error(`'replace' arg 2: expected string, got ${this.show(a2)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "repeat") {
        if (expr.args.length !== 1) { this.error(`'repeat' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'repeat': expected integer, got ${this.show(argType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "padStart" || expr.method === "padEnd") {
        if (expr.args.length !== 2) { this.error(`'${expr.method}' expects 2 arguments (targetLen, padStr), got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const lenType = this.checkExpr(expr.args[0]);
        const padType = this.checkExpr(expr.args[1]);
        if (lenType.tag !== "int" && lenType.tag !== "unknown") this.error(`'${expr.method}' arg 1: expected integer, got ${this.show(lenType)}`, sp);
        if (padType.tag !== "string" && padType.tag !== "unknown") this.error(`'${expr.method}' arg 2: expected string, got ${this.show(padType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "len") {
        if (expr.args.length !== 0) { this.error(`'len' takes no arguments`, sp); }
        return this.setType(expr, { tag: "int", bits: 64, signed: true });
      }
      if (expr.method === "cstr") {
        if (expr.args.length !== 0) { this.error(`'cstr' takes no arguments`, sp); }
        return this.setType(expr, { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } });
      }
      // fall through to trait/inherent lookup for String
    }

    // user-defined method resolution: inherent first, then traits.
    // A `Heap<T>` receiver resolves to T's method; record it so lower can
    // insert the deref. Without it codegen passes the address of the Heap
    // slot (a ptr-to-ptr) as `&T`.
    if (objType.tag === "heap") this.heapMethodReceivers.add(expr);
    const derefOnce = objType.tag === "ref" ? objType.inner : objType.tag === "heap" ? objType.inner : objType;
    const bareObjType = derefOnce.tag === "ref" ? derefOnce.inner : derefOnce;
    // interface method dispatch — virtual call through itable
    if (bareObjType.tag === "interface") {
      const iface = this.interfaces.get(bareObjType.name);
      if (iface) {
        const ifaceMethod = iface.methods.get(expr.method);
        if (ifaceMethod) {
          // self is always borrowed for interface calls
          this.autoBorrowed.set(expr.object, { mutable: ifaceMethod.params[0]?.type.tag === "ref" && (ifaceMethod.params[0].type as any).mutable });
          if (expr.args.length !== ifaceMethod.params.length - 1) {
            this.error(`'${expr.method}' expects ${ifaceMethod.params.length - 1} argument(s), got ${expr.args.length}`, sp);
          }
          for (let i = 0; i < expr.args.length; i++) {
            const expected = ifaceMethod.params[i + 1];
            if (!expected) break;
            const bare = expected.type.tag === "ref" ? expected.type.inner : expected.type;
            const argType = this.checkExprWithHint(expr.args[i], bare);
            if (!typeEq(bare, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.method}' argument ${i + 1}: expected ${this.show(bare)}, got ${this.show(argType)}`, expr.args[i].span);
            }
            if (expected.type.tag === "ref") {
              this.setAutoBorrowChecked(expr.args[i], expected.type.mutable, sp);
            } else {
              this.tryMove(expr.args[i]);
            }
          }
          // compute method index for itable slot
          let methodIndex = 0;
          for (const [name] of iface.methods) {
            if (name === expr.method) break;
            methodIndex++;
          }
          this.interfaceMethodCalls.set(expr, { ifaceName: bareObjType.name, methodName: expr.method, methodIndex });
          return this.setType(expr, ifaceMethod.ret);
        }
        this.error(`interface '${bareObjType.name}' has no method '${expr.method}'`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
    }
    const objTName = typeName(bareObjType);
    // A method carrying its own type parameters is instantiated here, before the ordinary
    // resolution path: until a call supplies them there is no signature to resolve against.
    const genericKey = `${objTName}$${expr.method}`;
    if (this.genericMethods.has(genericKey)) {
      const typeArgs = this.inferMethodTypeArgs(genericKey, expr);
      if (!typeArgs) {
        const tpl = must(this.genericMethods, genericKey, "generic methods");
        const unresolved = (tpl.decl.typeParams ?? []).map(t => `'${t.name}'`).join(", ");
        this.error(`cannot infer ${unresolved} for '${objTName}.${expr.method}'`, sp,
          `nothing in the arguments or the expected return type fixes it — annotate the call's result, or the closure's return type`);
        return this.setType(expr, { tag: "unknown" });
      }
      const mangled = this.monomorphizeMethod(genericKey, typeArgs, sp);
      if (mangled) return this.dispatchMangledMethod(expr, mangled, sp);
    }

    const resolved = this.resolveMethod(objTName, expr.method);
    if (resolved) {
      const { mangled, sig } = resolved;
      // args: self is expr.object, rest are expr.args
      // first param is self — check remaining args
      const selfParam = sig.params[0];
      if (selfParam) {
        if (selfParam.type.tag === "ref") {
          // a `&var self` method may mutate the receiver — same hazard as builtins
          if (selfParam.type.mutable) this.errorIfFrozen(expr.object, `call '${expr.method}' on`, sp);
          if (selfParam.type.mutable) this.errorIfCopyBind(expr.object, expr.method, sp);
          this.autoBorrowed.set(expr.object, { mutable: selfParam.type.mutable });
        } else {
          this.tryMove(expr.object);
        }
      }
      if (expr.args.length !== sig.params.length - 1) {
        this.error(`'${expr.method}' expects ${sig.params.length - 1} argument(s), got ${expr.args.length}`, sp);
      }
      for (let i = 0; i < expr.args.length; i++) {
        const expected = sig.params[i + 1];
        if (!expected) break;
        const argType = this.checkExprWithHint(expr.args[i], expected.type.tag === "ref" ? expected.type.inner : expected.type);
        const bare = expected.type.tag === "ref" ? expected.type.inner : expected.type;
        if (!typeEq(bare, argType) && argType.tag !== "unknown") {
          // Only a struct: codegen's stringifier has no scalar path, so the
          // bool/int/float arms this used to accept crashed the compiler.
          if (expr.method === "json" && bare.tag === "string" && argType.tag === "struct") {
            // `ctx.json(user)` auto-stringifies. A struct with a real codec
            // routes through it, so a Vec/Option/nested field serializes
            // properly; the built-in fallback only knows scalar fields and
            // used to emit `"tags":` with no value at all for the rest.
            const codec = argType.tag === "struct" ? this.resolveMethod(argType.name, "toJson") : null;
            if (codec) {
              this.autoJsonToJson.set(expr.args[i], codec.mangled);
            } else if (argType.tag === "struct") {
              const si = this.structs.get(argType.name);
              for (const f of si?.fields ?? []) {
                if (f.type.tag !== "string" && f.type.tag !== "bool" && f.type.tag !== "int" && f.type.tag !== "float") {
                  this.error(`'json': '${argType.name}.${f.name}' has type ${this.show(f.type)}, which the built-in stringifier cannot serialize`,
                    expr.args[i].span, `add '@derive(Json)' to '${argType.name}' — the derived codec handles nested structs, Vec and Option`);
                }
              }
            }
            this.autoJsonStringify.set(expr.args[i], argType);
          } else {
            this.error(`'${expr.method}' argument ${i + 1}: expected ${this.show(bare)}, got ${this.show(argType)}`, expr.args[i].span);
          }
        }
        if (expected.type.tag === "ref") {
          this.setAutoBorrowChecked(expr.args[i], expected.type.mutable, sp);
        } else {
          this.tryMove(expr.args[i]);
        }
      }
      this.resolvedMethods.set(expr, mangled);
      if (this.isViewReturn(sig.ret)) this.freezeViewSource(expr.object, sp, this.viewReturnFields.get(mangled));
      return this.setType(expr, sig.ret);
    }

    // fn-typed struct field call: h.apply(args) where apply: fn(...): T
    // A `*Struct` receiver is admitted only for a C function-pointer field, which is
    // where it is the normal shape: C hands over `Ops *`, not a value. Opening the raw
    // pointer to Milo fn fields as well would be a new auto-deref rule, not this feature.
    const ptrStruct = bareObjType.tag === "ptr" && bareObjType.inner.tag === "struct" ? bareObjType.inner : null;
    const structType = bareObjType.tag === "struct" ? bareObjType : ptrStruct;
    if (structType) {
      const sdef = this.structs.get(structType.name);
      if (sdef) {
        const field = sdef.fields.find(f => f.name === expr.method);
        if (field && (field.type.tag === "fn" || field.type.tag === "cfn") && (!ptrStruct || field.type.tag === "cfn")) {
          const fnType = field.type;
          // A C function pointer may be null, may point at a signature that does not
          // match, and is not owned by anything the checker can see — exactly the
          // situation `unsafe` exists to mark. A Milo fn field has none of those.
          if (fnType.tag === "cfn") {
            this.requireUnsafe(`calling a C function pointer requires 'unsafe' block`, sp);
          }
          if (expr.args.length !== fnType.params.length) {
            this.error(`'${expr.method}' expects ${fnType.params.length} argument(s), got ${expr.args.length}`, sp);
          }
          for (let i = 0; i < expr.args.length; i++) {
            const expected = fnType.params[i];
            if (!expected) break;
            const bare = expected.tag === "ref" ? expected.inner : expected;
            const argType = this.checkExprWithHint(expr.args[i], bare);
            if (!typeEq(bare, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.method}' argument ${i + 1}: expected ${this.show(bare)}, got ${this.show(argType)}`, expr.args[i].span);
            }
            if (expected.tag === "ref") {
              this.setAutoBorrowChecked(expr.args[i], expected.mutable, sp);
            } else {
              this.tryMove(expr.args[i]);
            }
          }
          if (fnType.tag === "cfn") this.cfnFieldCalls.add(expr);
          else this.fnFieldCalls.add(expr);
          return this.setType(expr, fnType.ret);
        }
      }
    }

    // `.clone()` on a Copy scalar is the identity. It exists so generic code
    // can be written once: `fn get<T>(w: &Wrapper<T>): T { return w.val.clone() }`
    // has to compile for T = i64 as well as T = string, and the move-out-of-
    // a-borrow rule leaves clone as the only way to spell it.
    if (expr.method === "clone" && expr.args.length === 0 &&
        this.isCopyType(objType)) {
      return this.setType(expr, objType);
    }

    const skipped = objType.tag === "struct" ? this.copyOutUnavailable.get(`${objType.name}.${expr.method}`) : undefined;
    if (skipped) {
      this.error(`'${expr.method}' is not available on '${this.show(objType)}': ${this.copyOutReason(`'${expr.method}'`, skipped)}`, sp,
        TypeChecker.COPY_OUT_HINT);
      return this.setType(expr, { tag: "unknown" });
    }
    this.error(`type '${this.show(objType)}' has no method '${expr.method}'`, sp,
      memberHint(expr.method, this.methodCandidates(objType)));
    return this.setType(expr, { tag: "unknown" });
  }

  private checkIsExprExpr(expr: ExprOf<"IsExpr">): TypeKind {
    const sp = expr.span;
    const opType = this.checkExpr(expr.operand);
    this.bindElidedPattern(expr.pattern, opType.tag === "ref" ? opType.inner : opType);
    if (expr.pattern.kind === "EnumPattern") {
      if (opType.tag !== "enum" && opType.tag !== "unknown") {
        this.error(`'is' pattern requires an enum type, got ${this.show(opType)}`, sp);
      }
    }
    return this.setType(expr, { tag: "bool" });
  }

  private checkIfExprExpr(expr: ExprOf<"IfExpr">): TypeKind {
    const sp = expr.span;
    const condType = this.checkExpr(expr.cond);
    if (condType.tag !== "bool" && condType.tag !== "unknown") {
      this.error(`if condition must be bool, got ${this.show(condType)}`, sp);
    }
    const fnRetType = this.currentFnRetType;
    const preMoves = this.snapshotMoveState();

    this.pushScope();
    for (const s of expr.thenBody) this.checkStmt(s, fnRetType);
    this.popScope();
    const thenType = this.blockExprType(expr.thenBody);

    const afterThen = this.snapshotMoveState();
    this.restoreMoveState(preMoves);

    this.pushScope();
    for (const s of expr.elseBody) this.checkStmt(s, fnRetType);
    this.popScope();
    const elseType = this.blockExprType(expr.elseBody);

    const afterElse = this.snapshotMoveState();
    this.restoreMoveState(preMoves);
    this.mergeMoveState(afterThen);
    this.mergeMoveState(afterElse);

    // As-a-value if: coerce a const-int arm to the expected width so
    // `let h: i64 = if c { 16 } else { 8 }` doesn't leave both arms at the
    // i32 literal default and then error on the binding. Target is the outer
    // int hint if present, else the concrete non-literal arm's type (so
    // `if c { u8var } else { 0 }` unifies with no annotation). Same const-int
    // retype machinery as enum payloads / struct fields / return.
    const [thenTail, elseTail] = [this.tailExprOf(expr.thenBody), this.tailExprOf(expr.elseBody)];
    const hint = this.returnHint;
    let target: TypeKind | null = hint?.tag === "int" ? hint : null;
    if (!target && thenType.tag === "int" && elseType.tag === "int" && !typeEq(thenType, elseType)) {
      if (thenTail && this.isConstIntExpr(thenTail) && !(elseTail && this.isConstIntExpr(elseTail))) target = elseType;
      else if (elseTail && this.isConstIntExpr(elseTail) && !(thenTail && this.isConstIntExpr(thenTail))) target = thenType;
    }
    let finalThen = thenType, finalElse = elseType;
    if (target) {
      if (thenTail && thenType.tag === "int" && !typeEq(thenType, target) && this.isConstIntExpr(thenTail)) {
        this.retypeConstInt(thenTail, target); finalThen = target;
      }
      if (elseTail && elseType.tag === "int" && !typeEq(elseType, target) && this.isConstIntExpr(elseTail)) {
        this.retypeConstInt(elseTail, target); finalElse = target;
      }
    }

    if (finalThen.tag !== "unknown" && finalElse.tag !== "unknown" && !typeEq(finalThen, finalElse)) {
      this.error(`if-else branches have mismatched types: '${this.show(finalThen)}' vs '${this.show(finalElse)}'`, sp);
    }
    return this.setType(expr, finalThen.tag !== "unknown" ? finalThen : finalElse);
  }

  private checkMatchExprExpr(expr: ExprOf<"MatchExpr">): TypeKind {
    const sp = expr.span;
    const armTypes = this.checkMatchLike(expr.subject, expr.arms, sp, this.currentFnRetType);
    // Unify arm value types. Coerce const-int arms to an int target (the
    // outer hint, else the first concrete non-literal arm) so
    // `match x { A => 1, B => 2 }` in an i64 slot doesn't stall at i32 —
    // same const-int retype path as if-expression arms.
    const armTails = expr.arms.map(a => this.tailExprOf(a.body));
    const hint = this.returnHint;
    let target: TypeKind | null = hint?.tag === "int" ? hint : null;
    if (!target) {
      for (let i = 0; i < armTypes.length; i++) {
        const tail = armTails[i];
        if (armTypes[i].tag === "int" && !(tail && this.isConstIntExpr(tail))) { target = armTypes[i]; break; }
      }
    }
    const finalTypes: TypeKind[] = [];
    for (let i = 0; i < armTypes.length; i++) {
      let t = armTypes[i];
      const tail = armTails[i];
      if (target && t.tag === "int" && !typeEq(t, target) && tail && this.isConstIntExpr(tail)) {
        this.retypeConstInt(tail, target); t = target;
      }
      finalTypes.push(t);
    }
    // Result is the first concrete (non-unknown) arm type; report a mismatch
    // if a later concrete arm disagrees.
    let result: TypeKind = { tag: "unknown" };
    for (const t of finalTypes) {
      if (t.tag === "unknown" || t.tag === "void") continue;
      if (result.tag === "unknown") { result = t; continue; }
      if (!typeEq(result, t)) {
        this.error(`match arms have mismatched types: '${this.show(result)}' vs '${this.show(t)}'`, sp);
      }
    }
    if (result.tag === "unknown" && finalTypes.some(t => t.tag === "void")) result = { tag: "void" };
    return this.setType(expr, result);
  }

  // An OWNED enum in a local, inspected by patterns that bind nothing but `_` and Copy
  // payloads, is read rather than consumed: nothing escapes the arm, so the subject is
  // still usable afterwards. checkMatchLike has always applied this; if-let and let-else
  // did not, which made `if let A(n) = v { }` MOVE `v` where the identical `match` left it
  // alone. The two spellings have to agree, or the lint that rewrites one into the other
  // (single-variant-match) turns compiling code into a use-after-move error.
  private ownedInspectOnly(subject: Expr, subjType: TypeKind, patterns: (Pattern | undefined)[]): boolean {
    // ident-ok: the rule is about a NAMED owned local, not any expression of enum type
    if (subject.kind !== "Ident" || subjType.tag !== "enum") return false;
    const einfo = this.enums.get(subjType.name);
    if (!einfo) return false;
    return patterns.every(pattern => {
      if (!pattern || pattern.kind !== "EnumPattern") return true;
      const v = einfo.variants.get(pattern.variant);
      if (!v) return true;
      return pattern.bindings.every((b, i) =>
        b === "_" || i >= v.fields.length ||
        this.isCopyType(v.fields[i]));
    });
  }

  // `let g = p else { … }` over a `?&mut T` / `?&T` parameter: the nullable extern
  // reference's only legal reader.
  //
  // The subject is deliberately NOT run through checkExpr. Naming a nullable extern
  // reference anywhere else is an error (checkIdentExpr), and routing this through the
  // same path would need an exemption that the next construct to read an Ident would
  // silently inherit. There is no enum here and no `Option<&mut T>` is ever built: the
  // parameter is a `*T`, this is the null test, and `g` is an ordinary second-class ref
  // from here on, subject to every rule any other `&mut T` obeys.
  private checkNullRefUnwrap(stmt: import("./ast").LetElseStmt, name: string, fnRetType: TypeKind, sp?: Span): void {
    // ident-ok: a nullable extern reference can only ever BE a parameter binding
    const info = stmt.value.kind === "Ident" ? this.lookup(stmt.value.name) : null;
    if (!info?.nullableRef) {
      const what = stmt.value.kind === "Ident" ? `'${stmt.value.name}'` : "this value";
      this.error(`${what} is not a nullable extern reference, so 'let ${name} = … else { … }' has nothing to unwrap`, sp,
        `that form is for a '?&mut T' parameter of an 'extern' / '@externalLinkage' fn. To unwrap an enum, name the variant: 'let Option.Some(${name}) = … else { … }'`);
      return;
    }
    // A second live unwrap of a `?&mut T` would hand the body two `&mut T` to one object,
    // which is the aliasing the one rule exists to prevent. Scoped, not function-wide: the
    // borrow is released when the first binding's scope pops, so unwrapping once per arm of
    // an `if` is fine. A shared `?&T` has nothing to exclude, so it is not restricted.
    if (info.nullableRef.mutable && info.borrowed) {
      this.error(`'${(stmt.value as { name: string }).name}' is already unwrapped here — a second '&mut ${this.show(info.nullableRef.inner)}' to the same object would alias the first`, sp,
        `use the binding you already have, or let the first one's scope end before unwrapping again`);
      return;
    }
    info.read = true;
    this.setType(stmt.value, info.type);
    this.nullRefUnwraps.set(stmt, info.nullableRef);
    // The else block runs when C passed null, so it must diverge — otherwise control
    // reaches code where the binding does not exist. Checked in its own scope BEFORE the
    // binding is declared, so the binding is not in scope inside it. Same rule, and the
    // same reason, as the enum let-else above.
    this.pushScope();
    for (const st of stmt.elseBody) this.checkStmt(st, fnRetType);
    this.popScope();
    if (!this.bodyAlwaysReturns(stmt.elseBody)) {
      this.error(`the else block of 'let ${name} = ${stmt.value.kind === "Ident" ? stmt.value.name : "…"} else { … }' must diverge (return/break/continue) — it runs when C passed null`, sp);
    }
    const refType: TypeKind = { tag: "ref", inner: info.nullableRef.inner, mutable: info.nullableRef.mutable };
    // Keyed on the placeholder pattern, which is unique per statement: this is the map the
    // LSP already reads for a let-else binding's hover, so the unwrap gets one for free.
    this.patternBindingTypes.set(stmt.pattern, [refType]);
    if (refType.mutable) info.borrowed = true;
    this.declare(name, { type: refType, mutable: refType.mutable, moved: false, borrowed: false, read: false, span: sp,
      ...(refType.mutable && { freezes: [info] }) });
  }

  // Borrow-detection for if-let/let-else subjects, mirroring checkMatchLike: a
  // `&enum` or an enum place (s.field, v[i], *h) is read without being consumed,
  // so its non-Copy payload must bind as a borrow, not a move. Resolves the enum
  // type behind the ref and registers the subject in matchSubjectRef when it
  // borrows (lower reads that to emit subjectIsRef).
  private enumSubjectBorrow(subject: Expr, rawSubjType: TypeKind, patterns: (Pattern | undefined)[] = []): { subjType: TypeKind; subjBorrows: boolean } {
    let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
    let subjType: TypeKind = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
    // ident-ok: asks whether the subject BINDING was declared `&E`, a property of the declaration
    if (!subjIsRef && subject.kind === "Ident") {
      const info = this.lookup(subject.name);
      if (info && info.type.tag === "ref" && info.type.inner.tag === "enum") { subjIsRef = true; subjType = info.type.inner; }
    }
    const subjIsPlace = !subjIsRef && subjType.tag === "enum" &&
      (subject.kind === "FieldAccess" || subject.kind === "IndexAccess" ||
       (subject.kind === "UnaryOp" && subject.op === "*"));
    const subjBorrows = subjIsRef || subjIsPlace ||
      (!subjIsRef && this.ownedInspectOnly(subject, subjType, patterns));
    if (subjBorrows) this.matchSubjectRef.add(subject);
    return { subjType, subjBorrows };
  }

  // A borrowed subject's non-Copy payload binds as `&T` (a view into the still-
  // owned subject); Copy payloads and owned subjects bind by value.
  // Would a write through this binding be thrown away? Only if it is a by-value COPY:
  // a ref binding writes through to the enum, and a by-value NON-Copy payload was moved
  // into the binding, which then owns it. Both are real; a Copy snapshot is not.
  // A '&mut self' method on a copy-bound pattern binding runs against a snapshot and the
  // write disappears at the end of the arm. The '&mut' fn-arg path already rejects the
  // same thing ("cannot pass immutable 'n' as a '&mut' argument"); this was the one way
  // through. Only copy binds are refused: a moved (non-Copy) binding owns its value, so
  // its writes are real — six shipped programs rely on that.
  private errorIfCopyBind(recv: Expr, method: string, sp?: Span): void {
    const cbindRoot = this.rootNameOf(recv);
    if (cbindRoot === null) return;
    const info = this.lookup(cbindRoot);
    if (!info?.copyBind) return;
    this.error(
      `'${method}' takes '&mut self', but '${cbindRoot}' is a copy of the matched payload — the write would be discarded`,
      sp,
      `a pattern binding of a Copy type is a snapshot, not a view into the enum. Match on a reference, or rebuild the enum from the method's result.`);
  }

  // Would a write through this binding be thrown away where someone could SEE it?
  // Three things must line up:
  //  - the binding is by value (a ref writes through to the enum), and
  //  - the payload is Copy (a non-Copy payload is MOVED, so the binding owns it), and
  //  - the subject is a PLACE that outlives the arm.
  // That last one is what keeps `match Child.spawn(...) { Ok(child) => child.close() }`
  // legal: the subject is a temporary, so the binding is the only owner and its write is
  // the real one. Only `var b = ...; match b { ... }` can observe the discard.
  // Does an element of a literal fit the annotated element type?
  //
  // Both array-literal paths used to call `checkExprWithHint(elem, hint.element)` and throw
  // the answer away, so nothing ever compared them: `var x: [i64; 2] = ["a", "b"]` and
  // `var v: Vec<i64> = ["a"]` type-checked, and the mismatch surfaced as an LLVM error
  // about `%String` where an `i64` was expected — a type error escaping to clang, reported
  // in a language the user does not write.
  //
  // Mirrors the binding rule rather than inventing one: an unknown is already an error
  // reported elsewhere, an Option auto-wraps, and an interface coerces.
  private elementFits(elemType: TypeKind, want: TypeKind, elem: Expr): boolean {
    if (typeEq(want, elemType) || elemType.tag === "unknown") return true;
    const optInner = this.optionInnerType(want);
    if (optInner && typeEq(optInner, elemType) && want.tag === "enum") return true;
    return this.tryInterfaceCoercion(elem, elemType, want);
  }

  // Does a callback's DECLARED signature match what the combinator will actually pass it?
  //
  // Every combinator built a `cbHint` and handed it to `checkExprWithHint`, and at best
  // asked whether the answer was a function at all. Nobody compared the parameters, so a
  // closure could declare any type it liked and receive something else:
  //
  //     var v: Vec<i64> = …
  //     v.each((x: &string) => print(x.len))   // accepted; printed a POINTER value
  //     v.map((s: &string) => s.len)           // accepted; read the next element's bytes
  //
  // That is a type confusion the checker waved through, and with a smaller allocation it
  // reads past the end rather than into the neighbour. Both spellings the language does
  // support stay legal: the hint's own type (`&i64`), and its by-value form (`i64`), which
  // is how a Copy element is idiomatically taken.
  private checkCallbackSig(actual: TypeKind, want: TypeKind, method: string, sp?: Span): void {
    if (actual.tag !== "fn" || want.tag !== "fn") return; // reported by the caller's own check
    if (actual.params.length !== want.params.length) {
      this.error(`'${method}' callback takes ${actual.params.length} parameter(s), but is called with ${want.params.length}`, sp);
      return;
    }
    for (let i = 0; i < want.params.length; i++) {
      const got = actual.params[i], expected = want.params[i];
      if (got.tag === "unknown" || typeEq(got, expected)) continue;
      // A `&T` position also accepts `T` when the closure takes it by value — but ONLY
      // for a Copy T. The combinator holds a borrow of the container and hands the
      // callback a pointer into it; taking that by value is a load, which for a Copy
      // scalar is a copy and for anything owning heap is a move out of a container the
      // caller still owns. `v.each((s: string) => print(s))` type-checked, and printed
      // raw process memory.
      if (expected.tag === "ref" && typeEq(got, expected.inner)) {
        if (this.isCopyType(got)) continue;
        this.error(
          `'${method}' callback parameter ${i + 1} takes ${this.show(got)} by value, but ${method} passes ${this.show(expected)}`,
          sp,
          `${this.show(got)} owns heap, so taking it by value would move it out of the container being iterated. Declare the parameter as '${this.show(expected)}'.`,
        );
        return;
      }
      this.error(`'${method}' callback parameter ${i + 1} is declared ${this.show(got)}, but ${method} passes ${this.show(expected)}`, sp);
      return;
    }
    // The RETURN type too. Only the parameters were checked, so a comparator declared
    // `: bool` where sortBy wants an i32 three-way result was accepted, and codegen then
    // read an i1 return as i32 — zero-extended on arm64, garbage in the upper bits on
    // x86_64. Silent, and wrong on one platform only.
    //
    // `unknown` means the combinator does not constrain it (map's element type is whatever
    // the callback returns), so it is not a mismatch.
    if (want.ret.tag !== "unknown" && actual.ret.tag !== "unknown" && !typeEq(actual.ret, want.ret)) {
      this.error(
        `'${method}' callback returns ${this.show(actual.ret)}, but ${method} expects ${this.show(want.ret)}`,
        sp,
      );
    }
  }

  // The ONE Copy judgment for the checker. Every "may this be read by value" question
  // goes through here so a struct/enum is Copy at every site or at none: `unwrapOr` once
  // called `isCopy` without the struct/enum callbacks and rejected a `Pt {x, y}` that
  // `let e = d` had just copied (design pass 2026-09, F1).
  private isCopyType(t: TypeKind): boolean {
    return isCopy(t, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n));
  }

  private isCopyBind(bt: TypeKind, subjectIsPlace: boolean): boolean {
    if (!subjectIsPlace) return false;
    if (bt.tag === "ref") return false;
    return this.isCopyType(bt);
  }

  private isPlaceExpr(e: Expr): boolean {
    return this.rootNameOf(e) !== null;
  }

  private payloadBindType(bt: TypeKind, subjBorrows: boolean): TypeKind {
    if (subjBorrows && !this.isCopyType(bt)) {
      return { tag: "ref", inner: bt, mutable: false };
    }
    return bt;
  }

  // Shared checking for `match` in both statement and expression position:
  // pattern validation, payload binding (borrow vs by-value), move merging, and
  // exhaustiveness. Returns each arm's block value type in arm order (used by
  // MatchExpr to unify; MatchStmt ignores it).
  // `Some(x)` written without the `Option.` prefix: fill the enum name in from the
  // subject's type. Only ever fills a BLANK name, so an explicitly written prefix
  // that disagrees with the subject still produces its mismatch error.
  private bindElidedPattern(pattern: Pattern | undefined | null, subjType: TypeKind) {
    if (!pattern || pattern.kind !== "EnumPattern" || pattern.enumName !== "") return;
    if (subjType.tag !== "enum") return;
    pattern.enumName = subjType.name;
  }

  // `match opt { Some(x) => { x } None => { d } }` is `opt ?? d`. Both arms have to be a
  // single statement of the same shape, the Some arm has to hand back its binding
  // untouched, and the subject has to be an owned Option — a `&Option` or a place
  // subject binds the payload as a borrow, where `??` would not be the same program.
  // `??` is short-circuit like the match, so a default with side effects stays correct.
  private lintManualOptionDefault(arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void {
    if (arms.length !== 2) return;
    if (subjType.tag !== "enum" || this.optionInnerType(subjType) === null) return;
    const armFor = (v: string) => arms.find(a => a.pattern.kind === "EnumPattern" && a.pattern.variant === v);
    const some = armFor("Some");
    const none = armFor("None") ?? arms.find(a => a.pattern.kind === "WildcardPattern");
    if (!some || !none || some === none) return;
    const binding = some.pattern.kind === "EnumPattern" ? some.pattern.bindings[0] : undefined;
    if (!binding || some.body.length !== 1 || none.body.length !== 1) return;
    const shape = (st: Stmt) => st.kind === "Return" ? { via: "return", e: st.value }
      : st.kind === "ExprStmt" ? { via: "value", e: st.expr } : null;
    const s1 = shape(some.body[0]!);
    const s2 = shape(none.body[0]!);
    if (!s1 || !s2 || s1.via !== s2.via) return;
    if (!s1.e || !s2.e) return;
    if (s1.e.kind !== "Ident" || s1.e.name !== binding) return;
    this.warn("manual-option-default",
      `this match only supplies a default for None`,
      sp,
      s1.via === "return"
        ? "write 'return <option> ?? <default>' instead"
        : "write '<option> ?? <default>' instead");
  }

  // `match x { A(v) => { … } B => {} }` is `if let A(v) = x { … }`. Every arm but one is
  // empty, so the match exists only to name the variant it cares about, and the other arms
  // are there to satisfy exhaustiveness rather than to do anything.
  //
  // Safe as a mechanical rewrite because if-let is not a separate rule: `IfLetStmt` runs the
  // same `enumSubjectBorrow` / `payloadBindType` / `armConsumesSubject` path as a match arm,
  // so the payload binds by borrow or by value identically and the subject is consumed at
  // the same point. Statement position only, since a match in value position cannot have an
  // empty arm and still type-check, so the shape never appears there.
  private lintSingleVariantMatch(subject: Expr, arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void {
    if (arms.length < 2) return;
    const base = subjType.tag === "ref" ? subjType.inner : subjType;
    if (base.tag !== "enum") return;
    const live = arms.filter(a => a.body.length > 0);
    if (live.length !== 1) return;
    const kept = live[0]!;
    // A wildcard arm is the one that would become the `else`, and `if let A(..) = x {} else`
    // with an empty then-branch is worse than the match it replaces.
    if (kept.pattern.kind !== "EnumPattern") return;
    const pat = kept.pattern;
    const name = pat.enumName ? `${pat.enumName}.${pat.variant}` : pat.variant;
    const spelled = pat.bindings.length > 0 ? `${name}(${pat.bindings.join(", ")})` : name;
    // `describeExpr` only spells places; for a call subject it returns `<expr>`, and an
    // ellipsis reads as "your subject here" where a literal `<expr>` reads like a type.
    const subjText = this.describeExpr(subject);
    this.warn("single-variant-match",
      `this match only acts on one variant; the other ${arms.length === 2 ? "arm is" : "arms are"} empty`,
      sp,
      `write 'if let ${spelled} = ${subjText === "<expr>" ? "…" : subjText} { … }' instead`,
      "match".length);
  }

  private checkMatchLike(subject: Expr, arms: MatchArm[], sp: Span | undefined, fnRetType: TypeKind, isStmt = false): TypeKind[] {
    const armTypes: TypeKind[] = [];
    const rawSubjType = this.checkExpr(subject);
    // Both match lints are advisory rewrites, so a hit inside std/ or a dependency is not
    // actionable by the person reading the build (dapweb warned on std/env's own getEnvOr).
    // Same scoping as unused-unsafe and index-clone.
    if (this.currentFnIsUser) {
      if (rawSubjType.tag !== "ref" && subject.kind !== "FieldAccess" && subject.kind !== "IndexAccess") {
        this.lintManualOptionDefault(arms, rawSubjType, sp);
      }
      if (isStmt) this.lintSingleVariantMatch(subject, arms, rawSubjType, sp);
    }
    {
      const t = rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
      for (const arm of arms) this.bindElidedPattern(arm.pattern, t);
    }
    // Matching on a borrowed enum (`&Enum`) reads the pointee without moving
    // it. Payload bindings become borrows (see below), so nothing is consumed.
    // Reading a ref Ident auto-derefs, so also consult its declared type.
    let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
    let subjType = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
    // ident-ok: asks whether the subject BINDING was declared `&E`, a property of the declaration
    if (!subjIsRef && subject.kind === "Ident") {
      const info = this.lookup(subject.name);
      if (info && info.type.tag === "ref" && info.type.inner.tag === "enum") {
        subjIsRef = true;
        subjType = info.type.inner;
      }
    }
    // Matching on a place (s.field, v[i], *heapBox) also borrows: the
    // container keeps ownership, so consuming the subject would zero data
    // the checker cannot track (a second `match v[i].f` read a zeroed enum;
    // `match *h` through a &Heap zeroed the pointee in place — both silent).
    // Bindings become borrows below.
    const subjIsPlace = !subjIsRef && subjType.tag === "enum" &&
      (subject.kind === "FieldAccess" || subject.kind === "IndexAccess" ||
       (subject.kind === "UnaryOp" && subject.op === "*"));
    // Matching an OWNED enum local to inspect its shape shouldn't consume it when no
    // arm actually moves a non-Copy payload out — i.e. every non-Copy payload is
    // ignored (`_`). Then the match only reads, so borrow it (like the place case)
    // instead of moving, and it stays usable afterward. This is purely additive: it
    // never changes a binding's type (there are no named non-Copy bindings in this
    // case — Copy bindings stay by-value either way), so a match that legitimately
    // destructures owned data still consumes exactly as before.
    let subjIsOwnedInspect = false;
    if (!subjIsRef && !subjIsPlace) {
      subjIsOwnedInspect = this.ownedInspectOnly(subject, subjType, arms.map(a => a.pattern));
    }
    const subjBorrows = subjIsRef || subjIsPlace || subjIsOwnedInspect;
    if (subjBorrows) this.matchSubjectRef.add(subject);
    const isEnum = subjType.tag === "enum";
    const isLiteralType = subjType.tag === "int" || subjType.tag === "float" || subjType.tag === "string" || subjType.tag === "bool";
    if (!isEnum && !isLiteralType && subjType.tag !== "unknown") {
      this.error(`match subject must be an enum, integer, float, string, or bool, got ${this.show(subjType)}`, sp);
      return armTypes;
    }
    if (isLiteralType) {
      let hasWildcard = false;
      const preMoves = this.snapshotMoveState();
      const mergedMoves = new Map<VarInfo, MoveSnapshot>();
      for (const arm of arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          hasWildcard = true;
        } else if (arm.pattern.kind === "LiteralPattern") {
          const ps = arm.pattern.span;
          if (subjType.tag === "int" && arm.pattern.literalKind !== "int" && arm.pattern.literalKind !== "char") {
            // char literals are integer-valued (u8); allow them against any int subject
            this.error(`expected integer literal in match arm`, ps);
          } else if (subjType.tag === "float" && arm.pattern.literalKind !== "float" && arm.pattern.literalKind !== "int") {
            this.error(`expected numeric literal in match arm`, ps);
          } else if (subjType.tag === "string" && arm.pattern.literalKind !== "string") {
            this.error(`expected string literal in match arm`, ps);
          } else if (subjType.tag === "bool" && arm.pattern.literalKind !== "bool") {
            this.error(`expected bool literal in match arm`, ps);
          }
        } else if (arm.pattern.kind === "EnumPattern") {
          this.error(`cannot use enum pattern when matching on ${this.show(subjType)}`, arm.pattern.span);
        }
        this.restoreMoveState(preMoves);
        this.pushScope();
        for (const s of arm.body) this.checkStmt(s, fnRetType);
        armTypes.push(this.blockExprType(arm.body));
        this.popScope();
        // An arm that always exits never falls through to the code after the match,
        // so its moves must not reach there — same rule the if-statement uses.
        if (!this.bodyAlwaysReturns(arm.body)) {
          for (const [info, st] of this.snapshotMoveState()) {
            const prior = mergedMoves.get(info);
            mergedMoves.set(info, {
              moved: st.moved || (prior?.moved ?? false),
              places: [...new Set([...st.places, ...prior?.places ?? []])],
            });
          }
        }
      }
      this.restoreMoveState(preMoves);
      this.mergeMoveState(mergedMoves);
      if (!hasWildcard && subjType.tag === "bool") {
        const hasTrueArm = arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === true);
        const hasFalseArm = arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === false);
        if (!hasTrueArm || !hasFalseArm) {
          this.error(`non-exhaustive match on bool`, sp);
          this.nonExhaustiveMatches.add(arms);
        }
      } else if (!hasWildcard) {
        this.error(`match on ${this.show(subjType)} requires a wildcard '_' arm`, sp);
        this.nonExhaustiveMatches.add(arms);
      }
    } else if (isEnum && subjType.tag === "enum") {
      // The tag test is redundant — `subjType` is not reassigned after `isEnum` is
      // computed — but it is what narrows `subjType` for the enum accesses below.
      const enumInfo = must(this.enums, subjType.name, "enums");
      const covered = new Set<string>();
      let hasWildcard = false;
      const preMoves = this.snapshotMoveState();
      const mergedMoves = new Map<VarInfo, MoveSnapshot>();
      for (const arm of arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          hasWildcard = true;
        } else if (arm.pattern.kind === "EnumPattern") {
          const ps = arm.pattern.span;
          if (arm.pattern.enumName !== subjType.name && enumInfo.baseName !== arm.pattern.enumName) {
            this.error(`pattern enum '${arm.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
          }
          const variant = enumInfo.variants.get(arm.pattern.variant);
          if (!variant) {
            this.error(`enum '${subjType.name}' has no variant '${arm.pattern.variant}'`, ps);
            continue;
          }
          if (covered.has(arm.pattern.variant)) {
            this.error(`duplicate match arm for '${arm.pattern.variant}'`, ps);
          }
          covered.add(arm.pattern.variant);
          if (arm.pattern.bindings.length !== variant.fields.length) {
            this.error(`variant '${arm.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${arm.pattern.bindings.length} bindings`, ps);
          }
        } else if (arm.pattern.kind === "LiteralPattern") {
          this.error(`cannot use literal pattern when matching on enum`, arm.pattern.span);
        }
        this.restoreMoveState(preMoves);
        this.pushScope();
        if (arm.pattern.kind === "EnumPattern") {
          const variant = enumInfo.variants.get(arm.pattern.variant);
          if (variant) {
            const bindTypes: TypeKind[] = [];
            for (let i = 0; i < Math.min(arm.pattern.bindings.length, variant.fields.length); i++) {
              let bt = variant.fields[i];
              // Ref- or place-match: a non-Copy payload binds as a borrow
              // (`&T`) — a view into the still-owned subject, so it can't be
              // moved out or dropped. Copy payloads bind by value.
              if (subjBorrows && !this.isCopyType(bt)) {
                bt = { tag: "ref", inner: bt, mutable: false };
              }
              bindTypes.push(bt);
              const bindSpan = arm.pattern.bindingSpans?.[i] ?? arm.pattern.span;
              this.declare(arm.pattern.bindings[i], { type: bt, mutable: false, moved: false, borrowed: false, read: false, span: bindSpan, patternBound: true,
                copyBind: this.isCopyBind(bt, this.isPlaceExpr(subject)) });
            }
            this.patternBindingTypes.set(arm.pattern, bindTypes);
          }
        }
        // Consume BEFORE the body, not after the whole match: a destructuring arm
        // zeroes the payload at arm entry, so a read of the subject inside that
        // arm is a use-after-move. Deferring the move to the end of the match let
        // those reads through silently and they saw zeroed data.
        const armConsumes = !subjBorrows && this.armConsumesSubject(arm.pattern, enumInfo);
        let patternMovedInfo: object | null = null;
        if (armConsumes) {
          this.tryMove(subject);
          // ident-ok: tracks a NAMED binding so the arm body can read it again, like the if-let case above
          if (subject.kind === "Ident") {
            const info = this.lookup(subject.name);
            if (info) { patternMovedInfo = info; this.movedByPattern.add(info); }
          }
        }
        for (const s of arm.body) this.checkStmt(s, fnRetType);
        if (patternMovedInfo) this.movedByPattern.delete(patternMovedInfo);
        armTypes.push(this.blockExprType(arm.body));
        this.popScope();
        // An arm that always exits never falls through to the code after the match,
        // so its moves must not reach there — same rule the if-statement uses.
        if (!this.bodyAlwaysReturns(arm.body)) {
          for (const [info, st] of this.snapshotMoveState()) {
            const prior = mergedMoves.get(info);
            mergedMoves.set(info, {
              moved: st.moved || (prior?.moved ?? false),
              places: [...new Set([...st.places, ...prior?.places ?? []])],
            });
          }
        }
      }
      this.restoreMoveState(preMoves);
      this.mergeMoveState(mergedMoves);
      if (!hasWildcard) {
        for (const [name, v] of enumInfo.variants) {
          // A variant carrying an uninhabited payload has no values, so demanding an arm
          // for it asks the reader to handle a case the checker can prove cannot occur —
          // `Result<T, Never>` from infallible generic code was unusable without the
          // `match e { }` incantation. The empty match stays legal and stays the way to
          // discharge one explicitly; this only stops it from being mandatory.
          if (!covered.has(name) && !v.fields.some(f => this.isUninhabited(f, new Set()))) {
            this.error(`non-exhaustive match: missing variant '${name}'`, sp);
            this.nonExhaustiveMatches.add(arms);
          }
        }
      }
    }
    // A ref- or place-match borrows the subject (payload bindings are
    // borrows); it is not consumed, so don't move it.
    if (!subjBorrows) this.tryMove(subject);
    return armTypes;
  }

  private blockExprType(body: Stmt[]): TypeKind {
    if (body.length === 0) return { tag: "void" };
    const last = body[body.length - 1];
    if (last.kind === "ExprStmt") return this.exprTypes.get(last.expr) ?? { tag: "void" };
    return { tag: "void" };
  }

  // Tail (value) expression of a block, or null if it doesn't end in one.
  private tailExprOf(body: Stmt[]): Expr | null {
    if (body.length === 0) return null;
    const last = body[body.length - 1];
    return last.kind === "ExprStmt" ? last.expr : null;
  }

  // The integer-literal leaf expressions an expression's value is built from —
  // the expr itself if it's an all-literal int subexpr, or every arm tail of an
  // if/match expression (recursively). Null if any part isn't a const-int leaf,
  // meaning the value isn't width-adaptable.
  // `Name.thing(...)` where `Name` starts with a capital is parsed as a static
  // call on a type, because the parser cannot know what `Name` is. When no enum,
  // struct or interface by that name exists but a *variable* does, the only
  // sensible reading is a method call or field access on that variable — which is
  // what a module-level `pub let W: i64 = 1280` then `W.toString()` means.
  //
  // Called only from the two "no such static" error paths, so anything that
  // resolves as a static call today keeps resolving that way.
  private staticCallOnVariable(expr: any): TypeKind | null {
    if (!this.rewriteStaticToMember(expr)) return null;
    return this.checkExpr(expr as Expr);
  }

  // The rewrite half of staticCallOnVariable, without the re-check: mutates the
  // EnumLit node into a FieldAccess/MethodCall on the same-named variable and
  // reports whether it did. Assignment targets need the rewrite but must not
  // re-enter checkExpr — that would type the node as an rvalue read (and move it).
  private rewriteStaticToMember(expr: any): boolean {
    const info = this.lookup(expr.enumName);
    if (!info) return false;
    const obj = { kind: "Ident", name: expr.enumName, span: expr.span } as unknown as Expr;
    let ty = info.type;
    if (ty.tag === "ref") ty = ty.inner;
    const isField = ty.tag === "struct" && !!this.structs.get(ty.name)?.fields.some(f => f.name === expr.variant);
    const node = expr as any;
    const args: Expr[] = expr.args ?? [];
    if (isField && args.length === 0) {
      node.kind = "FieldAccess";
      node.object = obj;
      node.field = expr.variant;
    } else {
      node.kind = "MethodCall";
      node.object = obj;
      node.method = expr.variant;
      node.args = args;
    }
    delete node.enumName;
    delete node.variant;
    delete node.typeArgs;
    return true;
  }

  private flexIntLeaves(e: Expr): Expr[] | null {
    if (this.isConstIntExpr(e)) return [e];
    if (e.kind === "IfExpr") {
      const t = this.tailFlexLeaves(e.thenBody);
      const el = this.tailFlexLeaves(e.elseBody);
      return t && el ? [...t, ...el] : null;
    }
    if (e.kind === "MatchExpr") {
      const all: Expr[] = [];
      for (const arm of e.arms) {
        const l = this.tailFlexLeaves(arm.body);
        if (!l) return null;
        all.push(...l);
      }
      return all.length > 0 ? all : null;
    }
    return null;
  }

  private tailFlexLeaves(body: Stmt[]): Expr[] | null {
    const tail = this.tailExprOf(body);
    return tail ? this.flexIntLeaves(tail) : null;
  }

  // Widen a still-flexible const-int binding to `target` (a wider int) at its
  // first use. Retypes every literal leaf and the initializer's node type, so
  // codegen emits the binding's slot and all leaves at the new width — no
  // runtime sext/zext, because the value is entirely literals.
  private resolveFlexInt(info: VarInfo, target: TypeKind, useExpr: Expr): boolean {
    if (!info.flexInt || target.tag !== "int") return false;
    for (const leaf of info.flexInt.leaves) this.retypeConstInt(leaf, target);
    this.setType(info.flexInt.valueExpr, target);
    info.type = target;
    info.flexInt = undefined;
    this.setType(useExpr, target);
    return true;
  }

  // If `e` is an identifier bound to a still-flexible const-int `let`, return
  // its VarInfo (so a use site can widen it); otherwise null.
  private flexIntBinding(e: Expr): VarInfo | null {
    // ident-ok: asks whether a NAME is bound to a still-flexible const-int literal, which is a property of the binding rather than of storage
    if (e.kind !== "Ident") return null;
    const info = this.lookup(e.name);
    return info?.flexInt ? info : null;
  }

  // A key type is hashable iff it is a scalar/string, or a struct whose every field is
  // hashable. Structural hashing derives from the same field recursion as structural
  // equality, so eq–hash coherence (a == b ⟹ hash(a) == hash(b)) holds by construction.
  private isHashable(t: TypeKind, seen: Set<string> = new Set()): boolean {
    if (t.tag === "int" || t.tag === "bool" || t.tag === "string") return true;
    if (t.tag === "struct") {
      if (seen.has(t.name)) return true; // cycle guard (structs can't nest by value anyway)
      seen.add(t.name);
      const info = this.structs.get(t.name);
      if (!info) return false;
      return info.fields.every(f => this.isHashable(f.type, seen));
    }
    return false;
  }

  private validateHashableKey(t: TypeKind, span?: Span) {
    if (this.isHashable(t)) return;
    if (t.tag !== "unknown") {
      this.error(`type '${this.show(t)}' is not hashable — keys must be integer, bool, string, or a struct of hashable fields`, span);
    }
  }

  private resolveOptionForValue(valueType: TypeKind, span?: Span): TypeKind {
    const ge = this.genericEnums.get("Option");
    if (!ge) {
      this.error(`HashMap.get requires 'enum Option<T> { Some(T), None }' to be defined`, span);
      return { tag: "unknown" };
    }
    const mangled = this.monomorphizeEnum("Option", [valueType]);
    return { tag: "enum", name: mangled };
  }

  // extract T from Option-like (Some(T)/None) or Result-like (Ok(T)/Err(E)) enums
  private unwrapableInner(t: TypeKind): TypeKind | null {
    if (t.tag !== "enum") return null;
    const info = this.enums.get(t.name);
    if (!info) return null;
    // Option-like: has Some(T) and None
    const some = info.variants.get("Some");
    const none = info.variants.get("None");
    if (some && none && some.fields.length === 1 && none.fields.length === 0) {
      return some.fields[0];
    }
    // Result-like: has Ok(T) and Err(E)
    const ok = info.variants.get("Ok");
    const err = info.variants.get("Err");
    if (ok && err && ok.fields.length === 1) {
      return ok.fields[0];
    }
    return null;
  }

  // extract E from Result-like (Ok(T)/Err(E)) enums, or null for Option-like
  private unwrapableErr(t: TypeKind): TypeKind | null {
    if (t.tag !== "enum") return null;
    const info = this.enums.get(t.name);
    if (!info) return null;
    const ok = info.variants.get("Ok");
    const err = info.variants.get("Err");
    if (ok && err && ok.fields.length === 1 && err.fields.length >= 1) {
      return err.fields[0];
    }
    return null;
  }

  // true if enum is Option-like (Some(T)/None)
  private isOptionLike(t: TypeKind): boolean {
    if (t.tag !== "enum") return false;
    const info = this.enums.get(t.name);
    if (!info) return false;
    const some = info.variants.get("Some");
    const none = info.variants.get("None");
    return !!(some && none && some.fields.length === 1 && none.fields.length === 0);
  }

  // compiler-magic From: find a variant in targetErr that wraps sourceErr
  private findFromConversion(sourceErr: TypeKind, targetErr: TypeKind): { targetEnumName: string; wrapVariant: string; wrapTag: number } | null {
    if (targetErr.tag !== "enum") return null;
    const info = this.enums.get(targetErr.name);
    if (!info) return null;
    // also allow string source → any variant with string payload
    let matches: { name: string; tag: number }[] = [];
    for (const [vName, vInfo] of info.variants) {
      if (vInfo.fields.length === 1 && typeEq(vInfo.fields[0], sourceErr)) {
        matches.push({ name: vName, tag: vInfo.tag });
      }
    }
    if (matches.length === 1) {
      return { targetEnumName: targetErr.name, wrapVariant: matches[0].name, wrapTag: matches[0].tag };
    }
    if (matches.length > 1) {
      this.error(`ambiguous From conversion: '${this.show(sourceErr)}' matches multiple variants in '${this.show(targetErr)}': ${matches.map(m => m.name).join(", ")}`);
    }
    return null;
  }
}
