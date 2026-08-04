import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span, TraitDecl, MatchArm, Attribute, GlobalDecl } from "./ast";
import { simpleType, declaredType, floatNamespaceConst } from "./ast";
import type { TypeKind } from "./types";
import { typeFromAst, typeEq, typeName, isNumeric, isCopy, isScalar } from "./types";
import type { Diagnostic, WarningConfig } from "./diagnostics";
import { checkVisibility } from "./visibility";
import { countCSigParams } from "./csig";
import { memberHint, closest, importHint, stdExportNames, VEC_MEMBERS, HASHMAP_MEMBERS, STRING_MEMBERS, OPTION_MEMBERS, RESULT_MEMBERS } from "./suggest";
import { deriveJsonSource, type JsonPlan, type JsonFieldPlan } from "./derive-json";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { basename } from "path";

// One hop from a place to a place inside it. `index` is deliberately opaque —
// two index steps may or may not select the same element, and nothing here tries
// to decide that. `payload` is the inside of an Option/Result reached by `!`/`?`.
export type PlaceStep =
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

export interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
  borrowed: boolean;
  read: boolean;
  span?: Span;
  // A pattern binding that holds a COPY of the payload: bound by value, and the payload
  // type is Copy, so it is a snapshot the enum can't see through. Mutating it through a
  // '&mut self' method compiles and then silently throws the write away (the copy dies at
  // the arm's end). Non-Copy payloads bound by value are MOVED instead — the binding owns
  // the value, so writes are real and this stays false.
  copyBind?: boolean;
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
  // An unannotated `let x = <const-int-value>` whose width is still adaptable:
  // its value is built entirely from integer literals (directly, or as the arm
  // tails of an if/match expression), so it can be re-typed to a wider int on
  // first use without any runtime conversion. `leaves` are those literal exprs
  // and `valueExpr` the whole initializer (whose node type is also retyped).
  // Cleared the moment the binding is resolved (widened) or locked (its
  // statement ends) — so a binding can only ever adopt a width at its FIRST
  // read, never retroactively after an i32 use was already committed.
  flexInt?: { leaves: Expr[]; valueExpr: Expr };
  // The closure literal this binding was initialized with, if any. A closure that
  // escapes (returned by identifier) must own its captures; the Return path uses
  // this to promote the underlying literal to `move` even when the return value is
  // the binding, not the literal itself (`let f = ...; return f`).
  boundClosure?: Expr;
}

// Builtins that may realloc, free, or shift collection memory — illegal on a
// receiver with a live borrow (slice or active for-in). Read-only and in-place
// element ops are intentionally absent.
const MUTATING_COLLECTION_METHODS = new Set([
  "push", "pushStr", "pop", "insert", "remove", "reverse", "swap", "sort", "sortBy", "sortByKey",
  "clear", "truncate", "extend", "retain", "reserve",
]);

export interface CaptureInfo {
  name: string;
  type: TypeKind;
  mutable: boolean;
  // Set when the closure body mutates this capture *in place* (assignment or a
  // mutating method on it). Distinguishes "needs write-back to the original"
  // (cannot be move-captured) from a capture that is merely read or moved out
  // (safe to move-capture). Drives the auto-move decision for generic-fn calls.
  mutatedInClosure?: boolean;
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

export interface StructInfo {
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
}

// A verified claim about a C type's layout, from `@cLayout(cType, header)`.
export interface CLayout {
  cType: string;
  header: string;
}

// A verified claim about an extern fn's C signature, from `@cSig(header, sig)`.
export interface CSig {
  header: string;
  sig: string;
}

// From `@cValue("SDL_INIT_VIDEO", "SDL2/SDL.h")` on a global: the C macro/enumerator
// this constant claims to mirror. `@cSig` and `@cLayout` verify functions and structs;
// a bare constant has no such anchor, so a wrong scancode or pixel format is a runtime
// bug (a dead key, a garbled frame) with no link error and no diagnostic.
export interface CValue {
  cName: string;
  header: string;
}

export interface EnumInfo {
  baseName?: string;
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  reprType?: string; // set for `enum Kind: i32 { ... }` — the tag IS the integer value
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exprTypes: Map<Expr, TypeKind>;
  patternBindingTypes: Map<import("./ast").Pattern, TypeKind[]>;
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
  autoJsonToJson: Map<Expr, string>;
  anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[];
  globalTypes?: Map<string, TypeKind>;
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
  private rangeCheckedExprs = new Map<Expr, { min: number; max: number; typeName: string }>();
  private returnHint: TypeKind | null = null;
  private monomorphizedDecls: import("./ast").EnumDecl[] = [];
  private monomorphizedStructDecls: StructDecl[] = [];
  private monomorphizedFns: Function[] = [];
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
  // Why a `match` on an owned enum local consumed it rather than borrowing: the first
  // named non-Copy payload binding found. Only drives the wording of the use-after-move
  // error — without it the reader sees "use of moved variable" at a line whose
  // connection to the match, and to the `_` that would have avoided it, is invisible
  // (payload Copy-ness is not written anywhere near the match).
  private ownedInspectBlockedBy = new Map<object, { variant: string; binding: string; type: TypeKind; subject: string }>();
  private autoWrappedOption = new Map<Expr, string>();
  private arrayToVecCoercions = new Set<Expr>();
  private closureCaptures = new Map<Expr, CaptureInfo[]>();
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
  private _pendingImplFns: Function[] = [];
  // Trait bounds on a generic STRUCT's type params, checked after every impl has
  // registered. A struct is monomorphized as soon as a field mentions it, which can
  // be before `impl Reader for File` exists — checking eagerly would reject the
  // legal case, so the verdict waits until the impl tables are complete.
  private _pendingStructBounds: { struct: string; mangled: string; param: string; concrete: TypeKind; bound: string }[] = [];
  private _boundFailedStructs = new Set<string>();
  private resolvedMethods = new Map<Expr, string>();
  private heapMethodReceivers = new Set<Expr>();
  private iteratorForIns = new Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>();
  private stringViewForIns = new Map<Stmt, { mode: "lines" | "split" }>();
  private iterDelegates = new Map<Stmt, string>();
  private resolvedOperators = new Map<Expr, string>();
  private fnFieldCalls = new Set<Expr>();
  private propagateConversions = new Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>();
  private interfaces = new Map<string, InterfaceInfo>();
  private interfaceCoercions = new Map<Expr, { fromType: string; ifaceName: string }>();
  private interfaceMethodCalls = new Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>();
  private autoJsonStringify = new Map<Expr, TypeKind>();
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
    if (!config.denied.has("unused-move")) config.allowed.add("unused-move");
    // unverified-extern is OFF unless asked for: pairing an `extern struct` with a local
    // .c peer (no header) is a legitimate, common FFI shape — this repo's own ABI-test
    // fixtures do exactly that — and @cLayout has no header to name there. A lint that
    // fires on code that cannot be fixed is one users turn off wholesale, taking the
    // cases that *are* fixable with it. `--deny=unverified-extern` opts a project in
    // (e.g. a binding crate or a safety-critical build where every layout must be pinned).
    if (!config.denied.has("unverified-extern")) config.allowed.add("unverified-extern");
    // unused-import is OFF unless asked for. An import can be load-bearing without the
    // entry file ever naming the symbol: node-milo's main.milo imports binding symbols
    // purely so those modules get compiled and linked. Warning by default would fire on
    // every one of them, and the fix ("just delete it") would break the build — so the
    // projects that don't do that opt in.
    if (!config.denied.has("unused-import")) config.allowed.add("unused-import");
    // large-stack-array is OFF unless asked for. Big fixed-size locals are a real
    // stack-overflow footgun, but plenty are intentional (main-thread framebuffers
    // that work fine), so warning by default would nag every graphics program. The
    // always-on hover note already surfaces the size; projects opt into the hard lint.
    if (!config.denied.has("large-stack-array")) config.allowed.add("large-stack-array");
    // unused-unsafe is on by default but fires only in user code (see currentFnIsUser):
    // the permissive safe-extern rule makes most stdlib unsafe blocks technically
    // removable, so warning on imported std would flood every compile.
    this.warningConfig = config;
  }

  private error(msg: string, span?: Span, hint?: string) {
    this.diagnostics.push({ severity: "error", span, message: msg, hint });
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

  private warn(code: string, msg: string, span?: Span, hint?: string, len?: number) {
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
    const elemName = ty.tag === "array" ? typeName(ty.element) : "T";
    this.warn(
      "large-stack-array",
      `'${name}' is a ${human} stack allocation`,
      span,
      `large local arrays can overflow the stack; use Vec<${elemName}> for a heap buffer`,
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
        this.error(`value ${litVal} is out of range for ${typeName(target)} (${target.min}..${target.max})`, sp);
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
        this.error(`decreases clause must be an integer measure, got ${typeName(cType)}`, c.span,
          `it is the quantity that must strictly fall on every recursive call or iteration`);
      }
      return;
    }
    if (cType.tag !== "bool") {
      this.error(`${c.kind} clause must be bool, got ${typeName(cType)}`, c.span);
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

  private resolve(ty: MiloType): TypeKind {
    if (ty.isFn && ty.fnParams && ty.fnRet) {
      const tag = ty.isCFn ? "cfn" as const : "fn" as const;
      return { tag, params: ty.fnParams.map(p => this.resolve(p)), ret: this.resolve(ty.fnRet) };
    }
    // type alias resolution
    const alias = this.typeAliases.get(ty.name);
    if (alias && !ty.isArray && !ty.typeArgs?.length) {
      // The ptr/ref flags belong to the *use site* (`&Board`), not to the alias:
      // expand the alias body, then re-apply the wrapper the use site asked for.
      const inner = this.resolve(alias);
      const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
      if (depth > 0) {
        let result = inner;
        for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
        return result;
      }
      if (ty.isRef) return { tag: "ref", inner, mutable: false };
      if (ty.isRefMut) return { tag: "ref", inner, mutable: true };
      return inner;
    }
    const typeArgs = ty.typeArgs ?? [];
    if (typeArgs.length > 0) {
      const resolvedArgs = typeArgs.map(a => this.resolve(a));
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
          result = { tag: "enum", name: this.monomorphizeEnum(ty.name, args) };
        } else {
          const gs = this.genericStructs.get(ty.name);
          if (gs) {
            if (resolvedArgs.length !== gs.typeParams.length) {
              this.error(`'${ty.name}' expects ${gs.typeParams.length} type args, got ${resolvedArgs.length}`);
              return { tag: "unknown" };
            }
            result = { tag: "struct", name: this.monomorphizeStruct(ty.name, resolvedArgs) };
          } else {
            this.error(`'${ty.name}' is not a generic type`);
            return { tag: "unknown" };
          }
        }
      }
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

  private monomorphizeEnum(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.enums.has(mangled)) return mangled;

    const generic = this.genericEnums.get(baseName)!;
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
    this.enums.set(mangled, { baseName, variants });

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
    while (this._pendingStructBounds.length > 0) {
      for (const b of this._pendingStructBounds.splice(0)) {
        if (this.typeImplementsTrait(typeName(b.concrete), b.bound)) continue;
        this.error(`type '${typeName(b.concrete)}' does not implement trait '${b.bound}', required by '${b.struct}<${b.param}: ${b.bound}>'`);
        this._boundFailedStructs.add(b.mangled);
      }
    }
  }

  // Bodies of a bound-violating instantiation are skipped: every one of them would
  // re-report the violation as "type 'i64' has no method 'read'" pointing inside the
  // library, burying the single line that names the real cause.
  private fromBoundFailedStruct(fn: Function): boolean {
    const sep = fn.name.indexOf("$");
    return sep > 0 && this._boundFailedStructs.has(fn.name.slice(0, sep));
  }

  private monomorphizeStruct(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.structs.has(mangled)) return mangled;

    const generic = this.genericStructs.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    for (let i = 0; i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      for (const bound of tp.bounds) {
        this._pendingStructBounds.push({ struct: baseName, mangled, param: tp.name, concrete: typeArgs[i], bound });
      }
    }

    const fields = generic.decl.fields.map(f => ({
      name: f.name,
      type: this.resolve(this.substituteMiloType(f.type, generic.typeParams, typeArgs)),
      ...(f.attributes?.some(a => a.name === "iter") ? { iterDelegate: true } : {}),
    }));
    this.structs.set(mangled, {
      fields, baseName, typeArgs,
      // Copy-ness is a property of the declaration, so every instantiation of a
      // `@noCopy` generic inherits it — `Handle<Texture>` is no more copyable than
      // the `Handle<T>` it came from.
      ...(generic.decl.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
    });

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
          methods: gi.methods.map(m => ({
            ...m,
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
          if (impl) this.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [], typeAliases: [], interfaces: [], globals: [] }, this._pendingImplFns);
        }
      }
    }

    return mangled;
  }

  private substituteTypeKind(t: TypeKind, typeMap: Map<string, TypeKind>): TypeKind {
    if (t.tag === "struct" && typeMap.has(t.name)) return typeMap.get(t.name)!;
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
      // Preserve reference/pointer wrappers from the original: `&T` must become
      // `&P`, not value `P`. Dropping isRef here collapsed the param to by-value,
      // so a generic fn taking `&T` passed a struct where a ptr was expected.
      if (ty.isRef || ty.isRefMut || ty.isPtr) {
        return { ...sub, isRef: ty.isRef, isRefMut: ty.isRefMut, isPtr: ty.isPtr, ptrDepth: ty.ptrDepth };
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

  private monomorphizeFn(baseName: string, typeArgs: TypeKind[]): string {
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
    const generic = this.genericFns.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    // check trait bounds
    for (let i = 0; i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      const concreteType = typeArgs[i];
      for (const bound of tp.bounds) {
        if (!this.typeImplementsTrait(typeName(concreteType), bound)) {
          this.error(`type '${typeName(concreteType)}' does not implement trait '${bound}'`);
        }
      }
    }

    // Build concrete param types — substitute type params first, then resolve
    const params = generic.decl.params.map(p => ({
      type: this.resolve(this.substituteMiloType(declaredType(p), generic.typeParams, typeArgs)),
      name: p.name,
    }));
    const ret = this.resolve(this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs));

    // Register the concrete sig so recursive calls and the rest of checking works
    this.functions.set(mangled, { params, ret, variadic: false });

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
    };
    this.monomorphizedFns.push(concreteDecl);

    // Type-check the monomorphized instance
    this.checkFunction(concreteDecl);

    return mangled;
    } finally { this.monoDepth--; }
  }

  private substituteBody(stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[], baseName?: string, mangledName?: string): Stmt[] {
    // Deep clone body with type substitution in all MiloType positions.
    // MiloType objects have `name` but no `kind` (unlike AST nodes).
    // JSON can't round-trip bigint (IntLit.value), so tag it on the way out and
    // rebuild it on the way in.
    return JSON.parse(
      JSON.stringify(stmts, (_k, v) => typeof v === "bigint" ? { __bigint: v.toString() } : v),
      (key, value) => {
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
        if (vi.freezes) for (const src of vi.freezes) this.unfreeze(src);
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

  // `span` is the binding site to point diagnostics at; VarInfo carries one for the
  // binding forms that record it, and callers that don't (for-in, params) pass it here.
  private declare(name: string, info: VarInfo, span?: Span) {
    const at = span ?? info.span;
    const scope = this.scopes[this.scopes.length - 1];
    // `_` is a discard, not a name: `let _ = f()` twice in one scope is the
    // conventional way to ignore two results, so each one rebinds rather than
    // colliding. Everything else still gets the shadowing error.
    if (name !== "_" && scope.has(name)) { this.error(`variable '${name}' already declared in this scope`, at); return; }
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
        if (this.scopes[i].has(name)) {
          this.error(`'${name}' shadows an outer binding — pick a different name`, at);
          break;
        }
      }
    }
    scope.set(name, info);
  }

  // Freeze `info` for a borrow of `place`. The path is recorded so a later mutation of a
  // provably different field isn't rejected; pass null when the borrowed place is unknown.
  private freeze(info: VarInfo, place: Expr | null) {
    info.borrowed = true;
    const path = place ? this.accessPath(place) : null;
    (info.borrowedPaths ??= []).push(path ? path.fields : null);
  }

  private unfreeze(info: VarInfo) {
    info.borrowed = false;
    info.borrowedPaths = undefined;
  }

  // Whether a mutation of `target` collides with a live borrow of `info`. Two chains off
  // one root can alias only when neither diverges from the other at a named field; an
  // unknown path on either side (an index or deref step) is treated as a collision.
  private frozenAgainst(info: VarInfo, target: Expr | null): boolean {
    if (!info.borrowed) return false;
    const paths = info.borrowedPaths;
    if (!paths || paths.length === 0) return true;
    const mut = target ? this.accessPath(target) : null;
    const mutFields = mut ? mut.fields : null;
    if (mutFields === null) return true;
    return paths.some(p => {
      if (p === null) return true;
      const n = Math.min(p.length, mutFields.length);
      for (let i = 0; i < n; i++) if (p[i] !== mutFields[i]) return false;
      return true;
    });
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
    } catch (e) {
      if (!(e instanceof CheckAbort)) throw e;
    }
    return {
      diagnostics: this.diagnostics,
      exprTypes: this.exprTypes,
      patternBindingTypes: this.patternBindingTypes,
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
      autoJsonToJson: this.autoJsonToJson,
      anonStructs: this.anonStructs,
      globalTypes: this._globalTypes,
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

    for (const s of program.structs) {
      if (s.typeParams.length === 0) {
        const fields = s.fields.map(f => ({
          name: f.name, type: this.resolve(f.type),
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
        this.structs.set(s.name, {
          fields, isExtern: s.isExtern, isOpaque: s.isOpaque,
          ...(s.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
        });
      }
    }

    // Reject a struct that embeds itself by value (directly or through other by-value
    // structs / fixed arrays) — it has infinite size and can't be laid out, yet used
    // to compile and produce a broken type. Vec/Heap/pointer/ref indirection breaks
    // the chain (those are pointer-sized regardless of pointee), so only value-struct
    // and fixed-array-of-struct fields continue the walk.
    const embedsSelf = (name: string, stack: Set<string>): boolean => {
      if (stack.has(name)) return true;
      const info = this.structs.get(name);
      if (!info) return false;
      stack.add(name);
      for (const f of info.fields) {
        let t = f.type;
        while (t.tag === "array") t = t.element;
        if (t.tag === "struct" && embedsSelf(t.name, stack)) { stack.delete(name); return true; }
      }
      stack.delete(name);
      return false;
    };
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      if (embedsSelf(s.name, new Set())) {
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
          this.error(`extern struct '${s.name}' field '${f.name}': type '${typeName(f.type)}' is not C-representable`, undefined,
            `extern-struct fields must be scalars, pointers, nested extern structs, or fixed arrays of those`);
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
          else this.error(`'@${attr.name}' is not supported on functions — '${fn.name}'`, undefined,
            `only '@cSig', '@externalLinkage', '@link', '@pure' and '@wrapping' apply to a fn; it would be silently ignored otherwise`);
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
          this.error(`'main' must return i32 or void, got ${typeName(ret)}`, fn.span, `the entry point lowers to C 'int main'`);
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
      if (fn.contracts && fn.contracts.length > 0) this.fnDecls.set(fn.name, fn);
    }

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
    const hasMain = program.functions.some(f => f.name === "main" && !f.isExtern);
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
        this.error(`global '${g.name}': type mismatch: expected ${typeName(hint)}, got ${typeName(valType)}`, g.span);
      }
      globalTypes.set(g.name, finalType);
      // Non-constant initializers used to be rejected outright, because codegen emitted
      // globals as LLVM constants only and a runtime-evaluated one silently became
      // zeroinitializer ("" / 0 / empty). They now run in a generated routine that main
      // calls before its body, in declaration order — so this is a real initializer, and
      // the only remaining rule is that it can't run before main exists.
      if (!this.isConstGlobalInit(g.value) && !hasMain) {
        this.error(
          `global '${g.name}': initializer is not a compile-time constant, and this module has no main() to run it before — give it a constant initializer ('= ""', '= 0', '= []') and assign the real value at the start of your entry point`,
          g.span,
        );
      }
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

    // `@pure` needs the finished call-resolution maps and the full set of
    // monomorphized instances, so it runs after everything else has been checked.
    this.checkPurity(program);

    // Also needs the finished maps: `closureCaptures` is filled as each closure body is
    // checked, and the auto-`move` promotions have all settled by now.
    this.checkStoredClosures(program);

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
          const impl = this.synthesizeDeriveImpl(s, traitName);
          if (impl) result.push(impl);
        }
      }
    }
    // auto-derive Eq for all structs not explicitly derived and not generic
    // loop until fixpoint (struct A containing struct B needs B derived first)
    const derived = new Set<string>();
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
    }
    return result;
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
    if (traitName === "Json") return this.deriveJson(s);
    this.error(`cannot derive '${traitName}' — only Eq and Json are supported`, s.span);
    return null;
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
    if (t.tag === "vec") return `Vec<${this.jsonTypeSpelling(t.element)}>`;
    if (t.tag === "enum") {
      const inner = this.optionInnerType(t);
      if (inner) return `Option<${this.jsonTypeSpelling(inner)}>`;
    }
    return typeName(t);
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
      default:
        return { err: `type '${typeName(t)}' has no JSON form` };
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
    return impl;
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

    return {
      kind: "ImplDecl",
      traitName: "Eq",
      typeName: s.name,
      typeParams: [],
      methods: [eqFn],
    };
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
    const i32_t: TypeKind = { tag: "int", bits: 32, signed: true };
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
  private static readonly KNOWN_ATTRS = ["derive", "cLayout", "cSig", "noCopy"];

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
      this.error(`@cValue on '${g.name}': only an integer constant can be checked against a C macro, got ${typeName(type)}`, g.span,
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

  // A closure without `move` captures its environment BY REFERENCE, so it is only
  // meaningful while the frame owning those locals is alive. Returning one is already
  // handled — the Return path promotes it to `move` so the captures become heap-owned.
  // But a closure stashed inside a struct or a collection escapes by a side door that
  // check never sees: the AGGREGATE is what leaves the function, and the closure rides
  // along still pointing at the dead frame. That was a real use-after-return in safe
  // code (silent garbage at -O0, a hang at -O2, invisible to ASAN because the capture
  // lives on the stack).
  //
  // Rejecting the STORE needs no escape analysis, which is the whole point: we cannot
  // tell whether the aggregate escapes, so we assume it does. `move` is the escape
  // hatch and is what the diagnostic points at.
  private checkStoredClosures(program: Program): void {
    const seen = new Set<string>();
    // Approximate scoping on purpose: one flat map per body, so a closure bound by
    // `let f = …` is still recognized when `f` is stored later. Shadowing can only make
    // this reject something it would otherwise allow, never the reverse.
    const check = (value: Expr, bound: Map<string, Expr>, what: string) => {
      let c: Expr | null = null;
      if (value.kind === "Closure") c = value;
      else if (value.kind === "Ident") c = bound.get(value.name) ?? null;
      if (!c || (c as Extract<Expr, { kind: "Closure" }>).isMove) return;
      const caps = this.closureCaptures.get(c);
      if (!caps || caps.length === 0) return;
      const span = value.span ?? c.span;
      const key = `${span?.line ?? 0}:${span?.col ?? 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      const names = caps.map(c => `'${c.name}'`).join(", ");
      this.error(`cannot store a closure that captures ${names} by reference`, span,
        `this closure points at locals in the current frame, and the ${what} holding it can outlive them — write 'move ${caps.length === 1 ? "" : ""}(…) => …' so the closure owns its captures instead`);
    };
    // Structural walk rather than a per-node switch: a missing arm here would silently
    // skip a whole subtree, which is exactly the class of bug this pass exists to close.
    const visit = (node: unknown, bound: Map<string, Expr>) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) visit(n, bound); return; }
      const n = node as Record<string, unknown> & { kind?: string };
      switch (n.kind) {
        case "LetDecl": case "VarDecl":
          if ((n.value as Expr | undefined)?.kind === "Closure") bound.set(n.name as string, n.value as Expr);
          break;
        case "StructLit":
          for (const f of n.fields as { name: string; value: Expr }[]) check(f.value, bound, "struct");
          break;
        case "ArrayLit":
          for (const el of n.elements as Expr[]) check(el, bound, "array");
          break;
        case "ArrayRepeat":
          check(n.value as Expr, bound, "array");
          break;
        case "MethodCall":
          // The collection-storing methods. A closure passed to `map`/`each`/`sortBy` is
          // called and dropped within the call, so those stay legal — that is the common
          // case and rejecting it would gut the combinators.
          if (["push", "insert", "set"].includes(n.method as string)) {
            for (const a of n.args as Expr[]) check(a, bound, "collection");
          }
          break;
      }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") visit(n[k], bound); }
    };
    for (const fn of [...program.functions, ...this.monomorphizedFns]) {
      if (fn.isExtern || !fn.body) continue;
      visit(fn.body, new Map<string, Expr>());
    }
  }

  private checkPurity(program: Program): void {
    const pureNames = new Set<string>();
    const bodies: Function[] = [];
    // monomorphizedFns holds impl methods (mangled `Type$method`, `Type$Trait$method`)
    // and generic instances; program.functions holds free fns. A generic declaration is
    // registered as pure but not walked — its instances are what call sites resolved to,
    // and they are the copies whose expressions carry resolution data.
    for (const f of [...program.functions, ...this.monomorphizedFns]) {
      if (!f.attributes?.some(a => a.name === "pure")) continue;
      pureNames.add(f.name);
      if (!f.isExtern && f.typeParams.length === 0) bodies.push(f);
    }
    if (bodies.length === 0) return;

    const mutableGlobals = new Set(program.globals.filter(g => g.mutable).map(g => g.name));
    // Every instance of a pure generic walks the same source span, so the same violation
    // would be reported once per instantiation.
    const seen = new Set<string>();
    // `Type$method` reads as `Type.method`; a monomorphized `foo_i64` reads as `foo`.
    const asWritten = new Map<string, string>();
    for (const f of this.monomorphizedFns) if (f.sourceName) asWritten.set(f.name, f.sourceName);
    const pretty = (n: string) => asWritten.get(n) ?? n.replace(/\$/g, ".");

    for (const fn of bodies) {
      const who = fn.sourceName ?? pretty(fn.name);
      const fail = (msg: string, span: Span | undefined, hint: string, key?: string) => {
        const k = key ?? `${span?.line ?? 0}:${span?.col ?? 0}:${msg}`;
        if (seen.has(k)) return;
        seen.add(k);
        this.error(msg, span, hint);
      };

      const callTarget = (e: Expr, fallback: string): string =>
        this.rewrittenCalls.get(e) ?? this.staticCalls.get(e) ?? fallback;

      const checkCall = (e: Expr, target: string, span: Span | undefined) => {
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
              checkCall(e, callTarget(e, e.func), e.span);
            }
            e.args.forEach(a => ex(a, bound));
            break;
          case "EnumLit": {
            // Static method calls (`Math.sqrt(x)`) parse as EnumLit and are resolved into
            // staticCalls; without an entry this is ordinary enum construction.
            const target = this.staticCalls.get(e);
            if (target) checkCall(e, target, e.span);
            e.args.forEach(a => ex(a, bound));
            break;
          }
          case "MethodCall": {
            const iface = this.interfaceMethodCalls.get(e);
            if (iface) {
              fail(`'${who}' is @pure but calls '${e.method}' through the interface '${iface.ifaceName}'`, e.span,
                `dynamic dispatch hides which body runs, and purity is not part of an interface method's signature`);
            } else if (this.fnFieldCalls.has(e)) {
              fail(`'${who}' is @pure but calls the fn-typed field '${e.method}'`, e.span,
                `purity is not part of a fn type, so the compiler cannot see what this call does`);
            } else {
              const target = this.resolvedMethods.get(e);
              if (target) checkCall(e, target, e.span);
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
      default: return false;
    }
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
          ? null : { msg: `${role} '${typeName(ty)}' has no stable C representation` };
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
        return { msg: `${role} '${typeName(ty)}' is not valid in an extern function signature` };
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
        if (attr.name !== "pure" && attr.name !== "wrapping") {
          this.error(`'@${attr.name}' is not supported on methods — '${typeName}.${m.name}'`, m.span ?? impl.span,
            `only '@pure' and '@wrapping' apply to a method`);
        } else if (attr.args.length > 0) {
          this.error(`'@${attr.name}' takes no arguments`, m.span ?? impl.span,
            `write '@${attr.name}' on the line above 'fn ${m.name}'`);
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
        const existing = this.inherentImpls.get(typeName)!;
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
    if (ty.tag === "ptr") return `raw pointer '${typeName(ty)}' is not Send`;
    if (ty.tag === "struct") {
      const info = this.structs.get(ty.name);
      if (info) {
        for (const f of info.fields) {
          if (!this.isSend(f.type)) return `field '${f.name}' of type '${typeName(f.type)}' is not Send — a manual override requires 'unsafe impl Send for ${ty.name} {}' and an audited invariant`;
        }
      }
    }
    return `type '${typeName(ty)}' is not Send`;
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
    let root = obj;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    if (root.kind !== "Ident") {
      // No binding to freeze: `makeRing().items()` views storage owned by a temporary.
      // That only survives today because temporaries are never dropped (they leak) —
      // it becomes a use-after-free the moment they get drop glue.
      this.error(`cannot take a view of a temporary`, sp,
        `the '&[T]' would outlive the value it points into — bind the receiver first ('let r = makeRing()') and take the view from that`);
      return;
    }
    const info = this.lookup(root.name);
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
          this.error(`'splitView': expected string, got ${typeName(sepType)}`, sp);
        }
      }
    } else if (call.args.length !== 0) {
      this.error(`'lines' takes no arguments`, sp);
    }
    // Same freeze a slice takes: every piece points into the receiver's buffer, so it must
    // not be mutated, moved or reallocated for the whole loop.
    let root: Expr = call.object;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    const rootInfo = root.kind === "Ident" ? this.lookup(root.name) : null;
    if (rootInfo) this.freeze(rootInfo, call.object);
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
        ? `only a method can return a '${typeName(ret)}' view, and only of its own receiver's storage — take the slice at the call site ('v[a..b]') or return an owned value`
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
      const pType = this.resolve(declaredType(p));
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false });
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
        if (isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) continue;
        if (!info.moved) {
          this.warn("unused-move",
            `parameter '${p.name}' is never moved — consider taking '&${typeName(info.type)}' instead`,
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
        const hint = stmt.type ? this.resolve(stmt.type) : null;
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
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp, this.optionUnwrapHint(hint, valType));
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
        if (bindingType.tag !== "ref") for (const vi of newlyFrozen) this.unfreeze(vi);
        this.declare(stmt.name, { type: bindingType, mutable: false, moved: false, borrowed: false, read: false, span: sp, ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
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
        if (stmt.value.kind === "Closure") {
          const info = this.lookup(stmt.name);
          if (info) info.boundClosure = stmt.value;
        }
        if (bindingType.tag === "array") this.lintStackArray(stmt.name, bindingType, sp);
        this.tryMove(stmt.value);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
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
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp, this.optionUnwrapHint(hint, valType));
          }
        }
        if (hint?.tag === "int" && hint.min !== undefined && hint.max !== undefined) {
          const litVal = this.constIntValue(stmt.value);
          if (litVal !== null) {
            if (litVal < hint.min || litVal > hint.max) {
              this.error(`value ${litVal} is out of range for ${typeName(hint)} (${hint.min}..${hint.max})`, sp);
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
          if (bindingType.tag !== "ref") for (const vi of newlyFrozen) this.unfreeze(vi);
          this.declare(stmt.name, { type: bindingType, mutable: true, moved: false, borrowed: false, read: false, span: sp, ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
          if (bindingType.tag === "array") this.lintStackArray(stmt.name, bindingType, sp);
        }
        if (stmt.value.kind === "Closure") {
          const info = this.lookup(stmt.name);
          if (info) info.boundClosure = stmt.value;
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo.mutable) {
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp, `declare with 'var' instead of 'let' to make it mutable`);
          break;
        }
        // Assignment puts a value back, so whatever was moved out of this place is
        // live again. An Ident target replaces the whole variable and clears all of it.
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
        if (assignPath && !assignPath.steps.some((s) => s === "[]" || s === "*")) {
          const info = this.lookup(assignPath.root);
          const isCapturedMutation = this.closureScopeDepth !== null && this.currentClosureCaptures?.has(assignPath.root);
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
        if (!typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(targetInfo.type);
          const isStringToPtr = valType.tag === "string" && targetInfo.type.tag === "ptr" && targetInfo.type.inner.tag === "int" && targetInfo.type.inner.bits === 8;
          if (optInner && typeEq(optInner, valType) && targetInfo.type.tag === "enum") {
            this.autoWrappedOption.set(stmt.value, targetInfo.type.name);
          } else if (!isStringToPtr) {
            this.error(`type mismatch: cannot assign ${typeName(valType)} to ${typeName(targetInfo.type)}`, sp);
          }
        }
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) this.unfreeze(vi);
        if (targetInfo.type.tag === "int") this.enforceRangeInto(stmt.value, valType, targetInfo.type, sp);
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          if (info) info.moved = false;
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void") this.error(`return without value in function returning ${typeName(fnRetType)}`, sp);
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
              this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`, sp);
            }
          }
          if (fnRetType.tag === "int") this.enforceRangeInto(stmt.value, valType, fnRetType, sp);
          // A returned closure escapes its defining frame, so it must own its captures:
          // a non-`move` closure captures by reference and would dangle into the dead
          // frame (a use-after-return in safe code). Promote it to `move` — the same
          // heap-allocation the call-argument path already applies — so tryMove below
          // moves the captures into the closure's heap env instead of aliasing locals.
          if (stmt.value.kind === "Closure" && !(stmt.value as any).isMove) {
            (stmt.value as any).isMove = true;
          } else if (stmt.value.kind === "Ident") {
            // `let f = <closure>; return f` escapes the same way a direct return does,
            // but the return value is the binding, not the literal. Promote the literal
            // it was bound to so its captures are heap-owned rather than dangling refs.
            const bound = this.lookup(stmt.value.name)?.boundClosure;
            if (bound && !(bound as any).isMove) (bound as any).isMove = true;
          }
          if (this.isViewReturn(fnRetType)) this.checkViewProvenance(stmt.value, sp);
          this.tryMove(stmt.value);
          this.inReturnInLoop = prev;
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${typeName(condType)}`, sp);
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
          this.error(`while condition must be bool, got ${typeName(condType)}`, sp);
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
            this.error(`for range start must be an integer, got ${typeName(startType)}`, sp);
          }
          if (endType.tag !== "int" && endType.tag !== "unknown") {
            this.error(`for range end must be an integer, got ${typeName(endType)}`, sp);
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
          if (iterType.tag === "vec") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            // mark vec as borrowed to prevent mutation during iteration
            let vecBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { vecBorrowInfo = info; this.freeze(info, stmt.iterable); }
            }
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
            if (vecBorrowInfo) this.unfreeze(vecBorrowInfo);
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
            // mark map as borrowed
            let mapBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { mapBorrowInfo = info; this.freeze(info, stmt.iterable); }
            }
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
            if (mapBorrowInfo) this.unfreeze(mapBorrowInfo);
            const returnMoves4 = this.returnOnlyMovesStack.pop()!;
            this.checkLoopMoves(preMoves, returnMoves4, sp);
          } else if (iterType.tag === "array") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            let arrBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { arrBorrowInfo = info; this.freeze(info, stmt.iterable); }
            }
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
            if (arrBorrowInfo) this.unfreeze(arrBorrowInfo);
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
              if (stmt.iterable.kind === "Ident") {
                const info = this.lookup(stmt.iterable.name);
                if (info) this.freeze(info, stmt.iterable);
              }
              this.pushScope();
              this.declare(stmt.varName, { type: { tag: "unknown" }, mutable: false, moved: false, borrowed: false, read: false }, stmt.span);
              for (const inv of stmt.invariants ?? []) this.checkContractClause(inv);
              this.loopDepth++;
              for (const s of stmt.body) this.checkStmt(s, fnRetType);
              this.loopDepth--;
              this.popScope();
            } else if (!resolved) {
              this.error(`cannot iterate over type '${typeName(iterType)}': no 'next' method found`, sp);
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
                this.error(`iterator 'next' method must return Option<T>, got ${typeName(retType)}`, sp);
              } else {
                // require iterable to be mutable (next takes &mut Self)
                if (stmt.iterable.kind === "Ident") {
                  const info = this.lookup(stmt.iterable.name);
                  if (info && !info.mutable) {
                    this.error(`cannot iterate: '${stmt.iterable.name}' must be 'var' (iterator mutates via next())`, sp);
                  }
                  if (info) this.freeze(info, stmt.iterable);
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
            this.error(`cannot iterate over type '${typeName(iterType)}'`, sp);
          }
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
        this.checkMatchLike(stmt.subject, stmt.arms, sp, fnRetType);
        break;
      }
      case "IfLetStmt": {
        const rawSubjType = this.checkExpr(stmt.subject);
        const { subjType, subjBorrows } = this.enumSubjectBorrow(stmt.subject, rawSubjType);
        this.bindElidedPattern(stmt.pattern, subjType);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`if let subject must be an enum, got ${typeName(subjType)}`, sp);
          break;
        }
        if (subjType.tag === "enum" && stmt.pattern.kind === "EnumPattern") {
          const enumInfo = this.enums.get(subjType.name)!;
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
              this.declare(stmt.pattern.bindings[i], { type: bindTypes[i], mutable: false, moved: false, borrowed: false, read: false,
                copyBind: this.isCopyBind(bindTypes[i], this.isPlaceExpr(stmt.subject)) });
            }
          }
          // Same arm-entry consumption as match: a destructuring then-branch
          // zeroes the payload before its body runs, so the subject is dead
          // there. The else-branch never destructures, so it stays readable.
          let patternMovedInfo: { moved: boolean } | null = null;
          if (!subjBorrows && this.armConsumesSubject(stmt.pattern, enumInfo)) {
            this.tryMove(stmt.subject);
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
        const rawSubjType = this.checkExpr(stmt.value);
        const { subjType, subjBorrows } = this.enumSubjectBorrow(stmt.value, rawSubjType);
        this.bindElidedPattern(stmt.pattern, subjType);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`let-else value must be an enum (Option/Result/…), got ${typeName(subjType)}`, sp);
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
          const enumInfo = this.enums.get(subjType.name)!;
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
              this.declare(stmt.pattern.bindings[i], { type: bindTypes[i], mutable: false, moved: false, borrowed: false, read: false,
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
    return `${typeName(actual)} is Option<${typeName(inner)}> — unwrap it with 'match', `
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
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.withCapacity': capacity must be an integer, got ${typeName(c)}`, value.span);
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
      v.fields.every(f => isCopy(f, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n)))
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
    // guard against cycles
    this.allCopyCache.set(name, false);
    const result = info.fields.every(f =>
      isCopy(f.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))
    );
    this.allCopyCache.set(name, result);
    return result;
  }

  // Match a generic fn return type (MiloType) against a concrete hint (TypeKind) to infer type params.
  // e.g. retType=Arena<T>, hint={tag:"struct",name:"Arena_i32"} → T=i32
  private inferTypeParamsFromHint(retType: MiloType, hint: TypeKind, typeParams: string[], typeMap: Map<string, TypeKind>) {
    // A bare type parameter (`T`, no further args) binds directly to the hint. First
    // binding wins; a later conflicting one surfaces as a field/arg type mismatch in the
    // caller's per-field re-check, so we don't need to diagnose it here.
    if (typeParams.includes(retType.name) && !retType.typeArgs?.length) {
      if (!typeMap.has(retType.name)) typeMap.set(retType.name, hint);
      return;
    }
    // Recurse through the built-in generic containers so `Vec<T>` / `[T]` fields infer T
    // from a `Vec<i64>` / `[i64]` argument — the case that made `for x in myVec` over a
    // user `MyVec<T>` fail to construct.
    if (retType.typeArgs?.length && (retType.name === "Vec" || retType.name === "Array") && hint.tag === "vec") {
      this.inferTypeParamsFromHint(retType.typeArgs[0], hint.element, typeParams, typeMap);
      return;
    }
    if (retType.isArray && hint.tag === "array") {
      // the element MiloType is the decl stripped of its array-ness
      this.inferTypeParamsFromHint({ ...retType, isArray: false, arraySize: null }, hint.element, typeParams, typeMap);
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
      if (!isCopy(variant.fields[i], (x) => this.isAllCopyEnum(x), (x) => this.isAllCopyStruct(x))) return true;
    }
    return false;
  }

  // A combinator that copies one variant's payload straight into its result leaves that
  // payload owned twice over. Consuming the receiver keeps a single owner. Only needed
  // when the forwarded payload is non-Copy — a Copy payload is safe to duplicate, and
  // staying non-consuming there keeps the common `Result<i64, i64>` case ergonomic
  // (same Copy gate as unwrapOr).
  private consumeForwardedPayload(receiver: Expr, forwarded: TypeKind) {
    if (isCopy(forwarded, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) return;
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
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      // Moving in an owned position through a borrow (`&T`, T non-Copy) would
      // shallow-copy the pointee — e.g. a String's heap buffer — aliasing it
      // with the real owner and double-freeing on drop. Reject; clone to own.
      if (info && info.type.tag === "ref" &&
          !isCopy(info.type.inner, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
        this.error(`cannot move the borrowed value out of '${expr.name}'`, expr.span,
          `'${expr.name}' is a reference — call .clone() to take an owned copy`);
        return;
      }
      if (info && !isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
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
          if (isCopy(cap.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) continue;
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
      if (elemType && !isCopy(elemType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
        let objectIsRef = false;
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
      if (fieldType && !isCopy(fieldType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
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
  private resolveAssignTarget(expr: Expr): { type: TypeKind; mutable: boolean } {
    const sp = expr.span;
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) this.fatal(`undefined variable '${expr.name}'`, sp, this.nameHint(expr.name));
      if (info.type.tag === "ref" && info.type.mutable) {
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
      this.fatal(`cannot access field on non-struct type ${typeName(objType)}`, sp);
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
      this.fatal(`cannot index non-array type ${typeName(objType)}`, sp);
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
      this.fatal(`cannot dereference type '${typeName(ot)}' for assignment`, sp);
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
    let e: Expr = expr;
    while (e.kind === "FieldAccess" || e.kind === "IndexAccess") e = e.object;
    if (e.kind === "Ident" && this.closureScopeDepth !== null) {
      const cap = this.currentClosureCaptures?.get(e.name);
      if (cap) cap.mutatedInClosure = true;
    }
  }

  // Mirrors codegen's getConstantInitializer: what can actually be emitted as
  // an LLVM constant for a module-scope global. Empty string/vec are allowed
  // (they ARE zeroinitializer); a non-empty string would need heap allocation.
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
    const shared: { root: string; fields: string[] | null }[] = [];
    for (const arg of args) {
      const ab = this.borrowModeOf(arg);
      if (!ab) continue;
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
            `a mutation through the '&var'/'&mut' argument could invalidate the '&' argument into '${m.root}' — clone the shared argument inline (e.g. 'x.clone()') or split the call into two statements`);
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
      if (info && this.frozenAgainst(info, obj)) {
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
    let e = obj;
    while (e.kind === "FieldAccess" || e.kind === "IndexAccess") e = e.object;
    if (e.kind !== "Ident") return null;
    const info = this.lookup(e.name);
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
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.withCapacity': capacity must be an integer, got ${typeName(c)}`, expr.span);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "filled" && hint?.tag === "vec") {
      if (expr.args.length !== 2) { this.error(`'Vec.filled' expects 2 arguments (count, value), got ${expr.args.length}`, expr.span); }
      else {
        const c = this.checkExpr(expr.args[0]);
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'Vec.filled': count must be an integer, got ${typeName(c)}`, expr.span);
        this.checkExprWithHint(expr.args[1], hint.element);
        // The value is copied into every slot, so it must be Copy — otherwise
        // N slots would alias one heap buffer and free it N times.
        if (!isCopy(hint.element, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
          this.error(`'Vec.filled' requires a Copy element type (got ${typeName(hint.element)}) — the fill value is duplicated into every slot; build a non-Copy Vec with a push loop`, expr.span);
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
        if (c.tag !== "int" && c.tag !== "unknown") this.error(`'HashMap.withCapacity': capacity must be an integer, got ${typeName(c)}`, expr.span);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "ArrayLit" && hint.tag === "array") {
      for (const elem of expr.elements) {
        this.checkExprWithHint(elem, hint.element);
      }
      const result: TypeKind = { tag: "array", element: hint.element, size: expr.elements.length };
      return this.setType(expr, result);
    }
    // Vec literal: `let v: Vec<T> = [a, b, c]` lowers to Vec.new() + N pushes in codegen.
    if (hint && expr.kind === "ArrayLit" && hint.tag === "vec") {
      for (const elem of expr.elements) {
        this.checkExprWithHint(elem, hint.element);
        this.tryMove(elem);
      }
      return this.setType(expr, hint);
    }
    if (hint && expr.kind === "ArrayRepeat" && hint.tag === "array") {
      this.checkExprWithHint(expr.value, hint.element);
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
            this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, sp);
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
            this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp);
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
    info.read = true;
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
      } else if (this.ownedInspectBlockedBy.has(info)) {
        // The transfer point is a `match` that would have borrowed, except that one arm
        // named a payload it could have moved out. Name that arm: the reader cannot see
        // from the match which payloads are Copy, so "it moved" is not a usable fact on
        // its own, and `_` is the one-character fix.
        const b = this.ownedInspectBlockedBy.get(info)!;
        this.error(
          `use of moved variable '${expr.name}'`,
          sp,
          `arm '${b.variant}' binds '${b.binding}', a non-Copy '${typeName(b.type)}' it could move out, so the match consumed '${b.subject}'. Bind '_' instead if the arm does not need it, or match on a '&' parameter.`,
        );
      } else {
        // A `@noCopy` handle is deliberately not clonable — duplicating one is how you
        // get the double-free it exists to prevent — so the usual hint would name a fix
        // that cannot be applied. Point at the ownership question instead.
        const t = this.deref(info.type);
        const noCopy = t.tag === "struct" && this.structs.get(t.name)?.noCopy === true;
        this.error(
          `use of moved variable '${expr.name}'`,
          sp,
          noCopy
            // A type from a package is stored as `gl$Texture2D`; the hint tells the
            // reader what to type, and what they type is the bare name they imported.
            ? `'${expr.name}' is a @noCopy handle, so transferring it ended its life here — copying one would let the same resource be released twice. Borrow it (pass it to a '&${typeName(t).split("$").pop()}' parameter) instead of transferring, or reorder so the transfer is last.`
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
      if (lt.tag !== "bool" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(lt)}`, sp);
      if (rt.tag !== "bool" && rt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(rt)}`, sp);
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
      if (!isNumeric(lt) && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`, sp);
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp);
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
      if (lt.tag !== "int" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires integer type, got ${typeName(lt)}`, sp);
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp);
      return this.setType(expr, lt);
    }
    if (cmpOps.includes(expr.op)) {
      if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp);
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
            this.error(`cannot use '${expr.op}' on ${typeName(lt)}`, sp, `implement Eq trait or compare individual fields`);
          }
        } else if (lt.tag === "vec" || lt.tag === "hashmap" || lt.tag === "heap" || lt.tag === "array") {
          this.error(`cannot use '${expr.op}' on ${typeName(lt)}`, sp, `compare individual fields or implement an eq method`);
        }
      } else {
        // ordering ops: numeric or string
        if (!isNumeric(lt) && lt.tag !== "string" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric or string type, got ${typeName(lt)}`, sp);
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
      if (ot.tag !== "unknown") this.error(`cannot dereference type '${typeName(ot)}' (expected &T, *T or Heap<T>)`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    if (expr.op === "-") {
      if (!isNumeric(ot) && ot.tag !== "unknown") this.error(`unary '-' requires numeric type, got ${typeName(ot)}`, sp);
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
      if (ot.tag !== "bool" && ot.tag !== "unknown") this.error(`unary '!' requires bool, got ${typeName(ot)}`, sp);
      return this.setType(expr, { tag: "bool" });
    }
    if (expr.op === "~") {
      if (ot.tag !== "int" && ot.tag !== "unknown") this.error(`unary '~' requires integer type, got ${typeName(ot)}`, sp);
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

  private checkCallExpr(expr: ExprOf<"Call">): TypeKind {
    const sp = expr.span;
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
        this.error(`old() takes a scalar (integer, float, or bool), got ${typeName(inner)}`, sp,
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
    if (expr.func === "zeroed") {
      if (!expr.typeArgs || expr.typeArgs.length !== 1) { this.error(`zeroed requires exactly one type argument`, sp); return this.setType(expr, { tag: "unknown" }); }
      if (expr.args.length !== 0) { this.error(`zeroed takes no value arguments`, sp); return this.setType(expr, { tag: "unknown" }); }
      this.requireUnsafe(`zeroed<T>() can only be used in unsafe blocks`, sp);
      const resolved = this.resolve(expr.typeArgs[0]);
      this.sizeOfTypes.set(expr, resolved);
      return this.setType(expr, resolved);
    }
    // `replace(place, value)` and `swap(a, b)`: memory intrinsics whose bodies cannot be
    // written in safe Milo (they move a value out of a place and refill it). From the
    // caller's view the move rules are ordinary — a `&mut` borrow of the place(s) plus a
    // by-value move of `value` — so they need no exclusivity machinery, only load/store
    // codegen. Gated on the name being otherwise unbound, so a user fn of the same name wins.
    if (expr.func === "replace" && !this.functions.has("replace")) {
      if (expr.args.length !== 2) { this.error(`replace(place, value) takes exactly two arguments`, sp); return this.setType(expr, { tag: "unknown" }); }
      const place = this.resolveAssignTarget(expr.args[0]);
      if (!place.mutable) this.error(`cannot replace through an immutable place`, expr.args[0].span, `declare it with 'var'`);
      // value moves in, old occupant moves out to the caller — the place stays valid,
      // so it is NOT invalidated here (only the by-value argument is consumed).
      const vt = this.checkExprWithHint(expr.args[1], place.type);
      if (vt.tag !== "unknown" && place.type.tag !== "unknown" && !typeEq(vt, place.type)) {
        this.error(`replace: value type ${typeName(vt)} does not match place type ${typeName(place.type)}`, expr.args[1].span);
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
        this.error(`swap: operands have different types ${typeName(a.type)} and ${typeName(b.type)}`, sp);
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
        this.error(`jsonStringify: unsupported type '${typeName(argType)}'`, sp);
      }
      // codegen only serializes scalar fields — anything else silently
      // produced invalid JSON before this guard existed
      if (argType.tag === "struct") {
        const si = this.structs.get(argType.name);
        for (const f of si?.fields ?? []) {
          if (f.type.tag !== "string" && f.type.tag !== "bool" && f.type.tag !== "int" && f.type.tag !== "float") {
            this.error(`jsonStringify: field '${f.name}' has unsupported type '${typeName(f.type)}'`, sp,
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
        // Direct match: param type IS a type param (e.g. val: T)
        if (genericFn.typeParams.includes(paramTy.name)) {
          const existing = typeMap.get(paramTy.name);
          if (existing && !typeEq(existing, argTypes[i])) {
            // numeric literal coercion: flex the literal to match the existing inference
            if (argIsLiteral && existing.tag === argTypes[i].tag) {
              this.exprTypes.set(expr.args[i], existing);
              argTypes[i] = existing;
            } else if (literalInferred.has(paramTy.name) && existing.tag === argTypes[i].tag) {
              typeMap.set(paramTy.name, argTypes[i]);
              literalInferred.delete(paramTy.name);
            } else {
              this.error(`conflicting inference for type parameter '${paramTy.name}'`, sp);
            }
          } else if (!existing) {
            typeMap.set(paramTy.name, argTypes[i]);
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
            if (genericFn.typeParams.includes(mt.name)) {
              if (!typeMap.has(mt.name)) typeMap.set(mt.name, t);
              return;
            }
            if (mt.typeArgs) this.inferTypeParamsFromHint(mt, t, genericFn.typeParams, typeMap);
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

      const typeArgs = genericFn.typeParams.map(p => typeMap.get(p)!);
      const mangled = this.monomorphizeFn(expr.func, typeArgs);
      this.rewrittenCalls.set(expr, mangled);

      const concreteSig = this.functions.get(mangled)!;
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

      return this.setType(expr, this.functions.get(mangled)!.ret);
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
              this.error(`closure argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
            this.error(`closure argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
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
        this.error(`assert() condition must be bool, got ${typeName(condType)}`, sp);
      }
      if (expr.args.length === 2) {
        const msgType = this.checkExpr(expr.args[1]);
        if (msgType.tag !== "string" && msgType.tag !== "unknown") {
          this.error(`assert() message must be a string, got ${typeName(msgType)}`, sp);
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
        this.error(`${expr.func}() arguments must be the same type, got ${typeName(aType)} and ${typeName(bType)}`, sp);
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
        if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
          if (!this.tryInterfaceCoercion(expr.args[i], argType, paramType)) {
            this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span, this.optionUnwrapHint(paramType, argType));
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
            this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span, this.optionUnwrapHint(paramType, argType));
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
          ? `it returns ${typeName(sig.ret)} (non-scalar)`
          : `an argument doesn't auto-coerce`;
        this.requireUnsafe(`calling extern function '${expr.func}' requires an unsafe block`, sp,
          `extern calls are safe only when every arg is scalar, &T, fn, string/array→*T, or a by-value extern struct, AND the return is scalar/void/extern-struct — here ${why}`);
      }
    }
    // check requires contracts at call site
    const fnDecl = this.fnDecls.get(expr.func);
    if (fnDecl) this.checkCallSiteContracts(fnDecl, expr.args, sp);

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
      const typeArgs = genericInfo.typeParams.map(p => typeMap.get(p)!);
      const mangled = this.monomorphizeStruct(expr.name, typeArgs);
      this.rewrittenStructLits.set(expr, mangled);
      const info = this.structs.get(mangled)!;
      for (const f of expr.fields) {
        const fieldDef = info.fields.find(d => d.name === f.name);
        if (!fieldDef) continue;
        const valType = this.exprTypes.get(f.value)!;
        if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
          this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp);
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
      if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown" && !this.tryInterfaceCoercion(f.value, valType, fieldDef.type)) {
        this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp);
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
    this.error(`cannot access field '${expr.field}' on type ${typeName(objType)}`, sp,
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
        this.error(`array element ${i}: expected ${typeName(elemType)}, got ${typeName(t)}`, expr.elements[i].span);
      }
    }
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
      this.error(`array index must be integer, got ${typeName(idxType)}`, sp);
    }
    if (objType.tag === "array") return this.setType(expr, objType.element);
    if (objType.tag === "vec") return this.setType(expr, objType.element);
    if (objType.tag === "string") return this.setType(expr, { tag: "int", bits: 8, signed: false });
    if (objType.tag === "ptr") {
      this.requireUnsafe(`pointer indexing requires 'unsafe' block`, sp);
      return this.setType(expr, objType.inner);
    }
    this.error(`cannot index type ${typeName(objType)}`, sp);
    return this.setType(expr, { tag: "unknown" });
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
        const literalInferred = new Set<string>();
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
          const typeArgs = genericFn.typeParams.map(p => typeMap.get(p)!);
          const mangled = this.monomorphizeFn(fnName, typeArgs);
          this.rewrittenCalls.set(expr as any, mangled);
          const concreteSig = this.functions.get(mangled)!;
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
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'${expr.enumName}.tryFrom': expected an integer, got ${typeName(argType)}`, sp);
        return this.setType(expr, this.resolveOptionForValue({ tag: "enum", name: expr.enumName }, sp));
      }
    }
    if (expr.enumName === "String" && expr.variant === "withCapacity") {
      if (expr.args.length !== 1) { this.error(`'String.withCapacity' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
      const argType = this.checkExpr(expr.args[0]);
      if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'String.withCapacity': expected integer, got ${typeName(argType)}`, sp);
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
          this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(field)}, got ${typeName(argType)}`, expr.args[i].span);
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
      const typeArgs = genericInfo.typeParams.map(p => typeMap.get(p)!);
      const mangled = this.monomorphizeEnum(expr.enumName, typeArgs);
      this.rewrittenEnums.set(expr, mangled);
      return this.setType(expr, { tag: "enum", name: mangled });
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
                  this.error(`'${expr.variant}' argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
                }
              }
            } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.variant}' argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
            if (expr.args[i].kind === "Closure" && paramType.tag === "fn" && !(expr.args[i] as any).isMove) {
              const caps = this.closureCaptures.get(expr.args[i]);
              if (!caps?.some(c => c.mutable)) (expr.args[i] as any).isMove = true;
            }
            if (paramType.tag !== "ref") this.tryMove(expr.args[i]);
          }
          this.staticCalls.set(expr, mangledMethod);
          // Send enforcement: Promise.blocking() runs the closure on a real
          // OS thread, so all captures must be Send.
          if (expr.enumName === "Promise" && expr.variant === "blocking" && expr.args.length === 1 && expr.args[0].kind === "Closure") {
            const captures = this.closureCaptures.get(expr.args[0]);
            if (captures) {
              for (const cap of captures) {
                if (!this.isSend(cap.type)) {
                  this.error(
                    `cannot send '${cap.name}' of type '${typeName(cap.type)}' across threads — type does not implement Send`,
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
      const asMethod2 = this.staticCallOnVariable(expr, sp);
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
                  this.error(`'${expr.variant}' argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
                }
              }
            } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.variant}' argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
            if (expr.args[i].kind === "Closure" && paramType.tag === "fn" && !(expr.args[i] as any).isMove) {
              const caps = this.closureCaptures.get(expr.args[i]);
              if (!caps?.some(c => c.mutable)) (expr.args[i] as any).isMove = true;
            }
            if (paramType.tag !== "ref") this.tryMove(expr.args[i]);
          }
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
                    `cannot send '${cap.name}' of type '${typeName(cap.type)}' across threads — type does not implement Send`,
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
      const asMethod = this.staticCallOnVariable(expr, sp);
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
        this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, expr.args[i].span);
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
      this.error(`'!' requires Option or Result type, got ${typeName(operandType)}`, sp);
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
      this.error(`'?' requires Option or Result type, got ${typeName(operandType)}`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    // `?` consumes the operand (Err returns it, Ok extracts the payload and
    // codegen zeros the slot); mark it moved so a later use errors instead of
    // silently reading the zeroed value. tryMove no-ops on Copy operands.
    this.tryMove(expr.operand);
    const retInner = this.unwrapableInner(this.currentFnRetType);
    if (!retInner) {
      this.error(`'?' requires function to return Option or Result, but returns ${typeName(this.currentFnRetType)}`, sp);
      return this.setType(expr, inner);
    }
    // Option ? in Option fn, or Result ? in Result fn — match error side only
    const operandIsOption = this.isOptionLike(operandType);
    const retIsOption = this.isOptionLike(this.currentFnRetType);
    if (operandIsOption !== retIsOption) {
      this.error(`'?' on ${operandIsOption ? "Option" : "Result"} requires function to return ${operandIsOption ? "Option" : "Result"}, but returns ${typeName(this.currentFnRetType)}`, sp);
    } else if (!operandIsOption) {
      // both Result-like: Err types must match, or From conversion must exist
      const operandErr = this.unwrapableErr(operandType);
      const retErr = this.unwrapableErr(this.currentFnRetType);
      if (operandErr && retErr && !typeEq(operandErr, retErr)) {
        const conversion = this.findFromConversion(operandErr, retErr);
        if (conversion) {
          this.propagateConversions.set(expr, conversion);
        } else {
          this.error(`'?' error type mismatch: '${typeName(operandErr)}' cannot convert to '${typeName(retErr)}' (no wrapping variant found)`, sp);
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
      this.error(`'??' requires Option or Result type, got ${typeName(operandType)}`, sp);
      return this.setType(expr, { tag: "unknown" });
    }
    const defaultType = this.checkExprWithHint(expr.default, inner);
    if (!typeEq(inner, defaultType) && defaultType.tag !== "unknown") {
      this.error(`'??' default type mismatch: expected ${typeName(inner)}, got ${typeName(defaultType)}`, sp);
    }
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
      this.error(`enum '${fromType.name}' casts only to an integer type, not ${typeName(toType)}`, sp);
    }
    const fromOk = isNumeric(fromType) || fromType.tag === "bool" || fromType.tag === "ptr" || fromType.tag === "array" || fromType.tag === "fn" || fromType.tag === "cfn" || fromType.tag === "string" || fromType.tag === "unknown" || fromReprEnum;
    // ptr -> cfn is how a dlsym result becomes callable; cfn -> ptr passes one back out
    const toOk = isNumeric(toType) || toType.tag === "ptr" || toType.tag === "cfn";
    if (!fromOk) {
      this.error(`cannot cast from ${typeName(fromType)}`, sp);
    }
    if (!toOk) {
      this.error(`cannot cast to ${typeName(toType)}`, sp);
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
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false });
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
    for (const s of expr.body) this.checkStmt(s, inferredRet);
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
    return this.setType(expr, { tag: "fn", params: paramTypes, ret: inferredRet });
  }

  private checkMethodCallExpr(expr: ExprOf<"MethodCall">): TypeKind {
    const sp = expr.span;
    const rawObjType = this.checkExpr(expr.object);
    // auto-deref `&T` for method dispatch (mutating methods still need !isRootMutable to allow)
    const objType = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
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
        if (inner && !isCopy(inner)) {
          // select-based lowering copies the payload; for owned types that would
          // alias the heap buffer (double-free). Move-out needs match.
          this.error(`'unwrapOr' on a non-Copy Option<${typeName(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const at = this.checkExprWithHint(expr.args[0], inner);
          if (!typeEq(inner, at) && at.tag !== "unknown") {
            this.error(`'unwrapOr': default must be ${typeName(inner)}, got ${typeName(at)}`, sp);
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
        if (inner && !isCopy(inner)) {
          this.error(`'unwrapOrElse' on a non-Copy Option<${typeName(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const cbHint: TypeKind = { tag: "fn", params: [], ret: inner };
          const cbType = this.checkExprWithHint(expr.args[0], cbHint);
          if (cbType.tag !== "fn") {
            this.error(`'unwrapOrElse' argument must be a function`, sp);
            return this.setType(expr, inner);
          }
          if (cbType.params.length !== 0) {
            this.error(`'unwrapOrElse': callback takes no arguments`, sp);
          }
          if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
            this.error(`'unwrapOrElse': callback must return ${typeName(inner)}, got ${typeName(cbType.ret)}`, sp);
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
        if (cbType.tag !== "fn") {
          this.error(`'andThen' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Option") {
          this.error(`'andThen': callback must return an Option, got ${typeName(ret)}`, sp);
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
            this.error(`'orElse': callback must return Option<${typeName(inner)}>, got ${typeName(ret)}`, sp);
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
        if (inner && !isCopy(inner)) {
          this.error(`'unwrapOr' on a non-Copy Result<${typeName(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner) {
          const at = this.checkExprWithHint(expr.args[0], inner);
          if (!typeEq(inner, at) && at.tag !== "unknown") {
            this.error(`'unwrapOr': default must be ${typeName(inner)}, got ${typeName(at)}`, sp);
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
        if (cbType.tag !== "fn") {
          this.error(`'andThen' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Result") {
          this.error(`'andThen': callback must return a Result, got ${typeName(ret)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const cbErr = this.unwrapableErr(ret);
        if (cbErr && !typeEq(cbErr, errT)) {
          this.error(`'andThen': callback's error type must be ${typeName(errT)}, got ${typeName(cbErr)}`, sp);
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
        if (inner && !isCopy(inner)) {
          this.error(`'unwrapOrElse' on a non-Copy Result<${typeName(inner)}> — use 'match' to move the value out`, sp);
          return this.setType(expr, inner);
        }
        if (inner && errT) {
          const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: inner };
          const cbType = this.checkExprWithHint(expr.args[0], cbHint);
          if (cbType.tag !== "fn") {
            this.error(`'unwrapOrElse' argument must be a function`, sp);
            return this.setType(expr, inner);
          }
          if (cbType.params.length !== 1) {
            this.error(`'unwrapOrElse': callback takes 1 argument, the error`, sp);
          }
          if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
            this.error(`'unwrapOrElse': callback must return ${typeName(inner)}, got ${typeName(cbType.ret)}`, sp);
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
        if (cbType.tag !== "fn") {
          this.error(`'orElse' argument must be a function`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const ret = cbType.ret;
        if (ret.tag !== "enum" || this.enums.get(ret.name)?.baseName !== "Result") {
          this.error(`'orElse': callback must return a Result, got ${typeName(ret)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const cbOk = this.unwrapableInner(ret);
        if (cbOk && !typeEq(cbOk, inner)) {
          this.error(`'orElse': callback's ok type must be ${typeName(inner)}, got ${typeName(cbOk)}`, sp);
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
          this.error(`'${expr.method}': expected ${typeName(objType)}, got ${typeName(argType)}`, sp);
        }
        return this.setType(expr, objType);
      }
      if (checkedMethods.includes(expr.method)) {
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const argType = this.checkExprWithHint(expr.args[0], objType);
        if (!typeEq(objType, argType) && argType.tag !== "unknown") {
          this.error(`'${expr.method}': expected ${typeName(objType)}, got ${typeName(argType)}`, sp);
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
            this.error(`'${expr.method}': shift amount must be ${typeName(objType)}, got ${typeName(at)}`, sp);
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
      if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`slice start: expected integer, got ${typeName(startType)}`, sp);
      if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`slice end: expected integer, got ${typeName(endType)}`, sp);
      // freeze the source — mutation could realloc/free the memory this view points into
      let root: Expr = expr.object;
      while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
      if (root.kind === "Ident") {
        const info = this.lookup(root.name);
        if (info) this.freeze(info, expr.object);
      }
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
          return this.setType(expr, { tag: "void" });
        }
        const argType = this.checkExprWithHint(expr.args[0], objType.element);
        if (argType.tag === "ref") {
          this.error(`push: cannot store a reference in a Vec`, sp, `references are second-class — push an owned value (clone it if needed)`);
        }
        if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
          if (!this.tryInterfaceCoercion(expr.args[0], argType, objType.element)) {
            this.error(`push: expected ${typeName(objType.element)}, got ${typeName(argType)}`, sp);
          }
        }
        this.tryMove(expr.args[0]);
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
            this.error(`'truncate': expected an integer length, got ${typeName(nType)}`, sp);
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
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'filter' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, { tag: "vec", element: objType.element });
      }
      if (expr.method === "each") {
        if (expr.args.length !== 1) { this.error(`'each' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "void" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        this.checkExprWithHint(expr.args[0], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "enumerate") {
        if (expr.args.length !== 1) { this.error(`'enumerate' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "int", bits: 64, signed: true }, elemRef], ret: { tag: "void" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        this.checkExprWithHint(expr.args[0], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "find") {
        if (expr.args.length !== 1) { this.error(`'find' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'find' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
        return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
      }
      if (expr.method === "any") {
        if (expr.args.length !== 1) { this.error(`'any' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        this.checkExprWithHint(expr.args[0], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "all") {
        if (expr.args.length !== 1) { this.error(`'all' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        this.checkExprWithHint(expr.args[0], cbHint);
        if (cbBorrow) this.unfreeze(cbBorrow);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "join") {
        if (expr.args.length !== 1) { this.error(`'join' expects 1 argument (separator)`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (objType.element.tag !== "string") { this.error(`'join' is only available on Vec<string>`, sp); return this.setType(expr, { tag: "unknown" }); }
        const sepType = this.checkExpr(expr.args[0]);
        if (sepType.tag !== "string" && sepType.tag !== "unknown") { this.error(`'join' separator must be a string, got ${typeName(sepType)}`, sp); }
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
        if (!typeEq(cbType.ret, accType) && cbType.ret.tag !== "unknown" && accType.tag !== "unknown") {
          this.error(`'${expr.method}' callback must return ${typeName(accType)} to match the initial value, got ${typeName(cbType.ret)}`, sp);
        }
        return this.setType(expr, accType);
      }
      if (expr.method === "sum") {
        if (expr.args.length !== 0) { this.error(`'sum' takes no arguments`, sp); }
        if (objType.element.tag !== "int" && objType.element.tag !== "float") {
          this.error(`'sum' requires a Vec of integers or floats, got Vec<${typeName(objType.element)}>`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, objType.element);
      }
      if (expr.method === "contains") {
        if (expr.args.length !== 1) { this.error(`'contains' expects 1 argument`, sp); return this.setType(expr, { tag: "bool" }); }
        const argType = this.checkExprWithHint(expr.args[0], objType.element);
        if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
          this.error(`'contains': expected ${typeName(objType.element)}, got ${typeName(argType)}`, sp);
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
        if (aType.tag !== "int" && aType.tag !== "unknown") { this.error(`'swap' index must be an integer, got ${typeName(aType)}`, sp); }
        if (bType.tag !== "int" && bType.tag !== "unknown") { this.error(`'swap' index must be an integer, got ${typeName(bType)}`, sp); }
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "insert") {
        if (expr.args.length !== 2) { this.error(`'insert' expects 2 arguments (index, value)`, sp); return this.setType(expr, { tag: "void" }); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot insert into immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const idxType = this.checkExpr(expr.args[0]);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'insert' index must be an integer, got ${typeName(idxType)}`, sp); }
        const valType = this.checkExprWithHint(expr.args[1], objType.element);
        if (!typeEq(objType.element, valType) && valType.tag !== "unknown") {
          this.error(`'insert' value: expected ${typeName(objType.element)}, got ${typeName(valType)}`, sp);
        }
        this.tryMove(expr.args[1]);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "remove") {
        if (expr.args.length !== 1) { this.error(`'remove' expects 1 argument (index)`, sp); return this.setType(expr, objType.element); }
        if (!this.isRootMutable(expr.object)) {
          this.error(`cannot remove from immutable Vec`, sp, `declare with 'var' to make it mutable`);
        }
        const idxType = this.checkExpr(expr.args[0]);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'remove' index must be an integer, got ${typeName(idxType)}`, sp); }
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
        this.keyExtractorDepth--;
        if (cbBorrow) this.unfreeze(cbBorrow);
        if (cbType.tag !== "fn") { this.error(`'sortByKey' argument must be a function`, sp); return this.setType(expr, { tag: "void" }); }
        const keyType = cbType.ret;
        if (keyType.tag !== "int" && keyType.tag !== "float" && keyType.tag !== "string" && keyType.tag !== "bool") {
          this.error(`'sortByKey' key must be a comparable type (int, float, string, bool), got ${typeName(keyType)}`, sp);
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
          this.error(`cannot clone Vec<${typeName(el)}>: an interface value has no clone`, sp,
            `the concrete type is erased and the itable carries no clone slot — build a new Vec from the concrete values instead`);
        } else if (el.tag === "fn") {
          this.error(`cannot clone Vec<${typeName(el)}>: closures cannot be cloned`, sp);
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
          if (idxType.tag !== "int" && idxType.tag !== "unknown") { this.error(`'get' index must be an integer, got ${typeName(idxType)}`, sp); }
        }
        return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
      }
      // Same comparable-element gate `sort` uses. Milo has no ordering trait, so
      // rather than invent an ordering for structs (which would be an opinion, not
      // a fact — see the HashMap key note) min/max are refused on them outright.
      if (expr.method === "min" || expr.method === "max") {
        if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
        const el = objType.element;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
          this.error(`'${expr.method}' requires a Vec of a comparable type (int, float, string, bool), got Vec<${typeName(el)}>`, sp,
            `there is no ordering on ${typeName(el)} — use 'fold' with your own comparison, or 'sortByKey' then 'first'`);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, this.resolveOptionForValue(el, sp));
      }
      // `find` answers "which value"; `indexOf`/`position` answer "where".
      if (expr.method === "indexOf") {
        if (expr.args.length !== 1) { this.error(`'indexOf' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const el = objType.element;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
          this.error(`'indexOf' requires a Vec of a comparable type (int, float, string, bool), got Vec<${typeName(el)}>`, sp,
            `use 'position' with a predicate instead`);
          return this.setType(expr, { tag: "unknown" });
        }
        const argType = this.checkExprWithHint(expr.args[0], el);
        if (!typeEq(el, argType) && argType.tag !== "unknown") {
          this.error(`'indexOf': expected ${typeName(el)}, got ${typeName(argType)}`, sp);
        }
        return this.setType(expr, this.resolveOptionForValue({ tag: "int", bits: 64, signed: true }, sp));
      }
      if (expr.method === "position") {
        if (expr.args.length !== 1) { this.error(`'position' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
        const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
        const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
        const cbBorrow = this.borrowDuringCallback(expr.object);
        const cbType = this.checkExprWithHint(expr.args[0], cbHint);
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
          this.error(`'extend': expected ${typeName(objType)}, got ${typeName(otherType)}`, sp);
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
        if (nType.tag !== "int" && nType.tag !== "unknown") { this.error(`'reserve': expected an integer, got ${typeName(nType)}`, sp); }
        return this.setType(expr, { tag: "void" });
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
          this.error(`insert key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp);
        }
        const valType = this.checkExprWithHint(expr.args[1], objType.value);
        if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
          this.error(`insert value: expected ${typeName(objType.value)}, got ${typeName(valType)}`, sp);
        }
        this.tryMove(expr.args[0]);
        this.tryMove(expr.args[1]);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "get") {
        if (expr.args.length !== 1) { this.error(`'get' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`get key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp);
        }
        const optionType = this.resolveOptionForValue(objType.value, sp);
        return this.setType(expr, optionType);
      }
      if (expr.method === "getOrDefault") {
        if (expr.args.length !== 2) { this.error(`'getOrDefault' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`getOrDefault key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp);
        }
        const valType = this.checkExprWithHint(expr.args[1], objType.value);
        if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
          this.error(`getOrDefault default: expected ${typeName(objType.value)}, got ${typeName(valType)}`, sp);
        }
        return this.setType(expr, objType.value);
      }
      if (expr.method === "contains") {
        if (expr.args.length !== 1) { this.error(`'contains' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
        const keyType = this.checkExprWithHint(expr.args[0], objType.key);
        if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
          this.error(`contains key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp);
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
          this.error(`remove key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp);
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
            this.error(`cannot clone a HashMap with ${what} type ${typeName(t)}: an interface value has no clone`, sp,
              `the concrete type is erased and the itable carries no clone slot`);
          } else if (t.tag === "fn") {
            this.error(`cannot clone a HashMap with ${what} type ${typeName(t)}: closures cannot be cloned`, sp);
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
          this.error(`'${expr.method}' cannot copy ${typeName(el)} out of the map`, sp,
            `iterate with 'for k, v in map' instead — it borrows rather than copies`);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, { tag: "vec", element: el });
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
          this.error(`string.push: expected u8, got ${typeName(argType)}`, sp);
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
          this.error(`string.pushStr: expected string, got ${typeName(argType)}`, sp);
        }
        this.setAutoBorrowChecked(expr.args[0], false);
        return this.setType(expr, { tag: "void" });
      }
      if (expr.method === "substr") {
        if (expr.args.length !== 2) { this.error(`'substr' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const startType = this.checkExpr(expr.args[0]);
        const endType = this.checkExpr(expr.args[1]);
        if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`substr start: expected integer, got ${typeName(startType)}`, sp);
        if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`substr end: expected integer, got ${typeName(endType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "slice") {
        const refStr: TypeKind = { tag: "ref", inner: { tag: "string" }, mutable: false };
        if (expr.args.length !== 2) { this.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp); return this.setType(expr, refStr); }
        const startType = this.checkExpr(expr.args[0]);
        const endType = this.checkExpr(expr.args[1]);
        if (startType.tag !== "int" && startType.tag !== "unknown") this.error(`slice start: expected integer, got ${typeName(startType)}`, sp);
        if (endType.tag !== "int" && endType.tag !== "unknown") this.error(`slice end: expected integer, got ${typeName(endType)}`, sp);
        // mark source as borrowed — prevents mutation/move while slice is live.
        // Walk to the root variable: `buf.data[a..b]` views storage owned by `buf`,
        // so replacing any part of `buf` can free what this points into.
        let strRoot: Expr = expr.object;
        while (strRoot.kind === "FieldAccess" || strRoot.kind === "IndexAccess") strRoot = strRoot.object;
        if (strRoot.kind === "Ident") {
          const info = this.lookup(strRoot.name);
          if (info) this.freeze(info, expr.object);
        }
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
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'${expr.method}': expected string, got ${typeName(argType)}`, sp);
        return this.setType(expr, { tag: "bool" });
      }
      if (expr.method === "indexOf" || expr.method === "lastIndexOf") {
        const optionI64: TypeKind = { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
        if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, optionI64); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'${expr.method}': expected string, got ${typeName(argType)}`, sp);
        return this.setType(expr, optionI64);
      }
      // like indexOf but starts the search at byte offset `from`
      if (expr.method === "indexOfFrom") {
        const optionI64: TypeKind = { tag: "enum", name: this.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
        if (expr.args.length !== 2) { this.error(`'indexOfFrom' expects 2 arguments (needle, from), got ${expr.args.length}`, sp); return this.setType(expr, optionI64); }
        const nType = this.checkExpr(expr.args[0]);
        if (nType.tag !== "string" && nType.tag !== "unknown") this.error(`'indexOfFrom' arg 1: expected string, got ${typeName(nType)}`, sp);
        const fromType = this.checkExpr(expr.args[1]);
        if (fromType.tag !== "int" && fromType.tag !== "unknown") this.error(`'indexOfFrom' arg 2: expected integer, got ${typeName(fromType)}`, sp);
        return this.setType(expr, optionI64);
      }
      if (expr.method === "split") {
        if (expr.args.length !== 1) { this.error(`'split' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "vec", element: { tag: "string" } }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'split': expected string, got ${typeName(argType)}`, sp);
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
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'charAt': expected integer, got ${typeName(argType)}`, sp);
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
        if (a1.tag !== "string" && a1.tag !== "unknown") this.error(`'replace' arg 1: expected string, got ${typeName(a1)}`, sp);
        if (a2.tag !== "string" && a2.tag !== "unknown") this.error(`'replace' arg 2: expected string, got ${typeName(a2)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "repeat") {
        if (expr.args.length !== 1) { this.error(`'repeat' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const argType = this.checkExpr(expr.args[0]);
        if (argType.tag !== "int" && argType.tag !== "unknown") this.error(`'repeat': expected integer, got ${typeName(argType)}`, sp);
        return this.setType(expr, { tag: "string" });
      }
      if (expr.method === "padStart" || expr.method === "padEnd") {
        if (expr.args.length !== 2) { this.error(`'${expr.method}' expects 2 arguments (targetLen, padStr), got ${expr.args.length}`, sp); return this.setType(expr, { tag: "string" }); }
        const lenType = this.checkExpr(expr.args[0]);
        const padType = this.checkExpr(expr.args[1]);
        if (lenType.tag !== "int" && lenType.tag !== "unknown") this.error(`'${expr.method}' arg 1: expected integer, got ${typeName(lenType)}`, sp);
        if (padType.tag !== "string" && padType.tag !== "unknown") this.error(`'${expr.method}' arg 2: expected string, got ${typeName(padType)}`, sp);
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
              this.error(`'${expr.method}' argument ${i + 1}: expected ${typeName(bare)}, got ${typeName(argType)}`, expr.args[i].span);
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
                  this.error(`'json': '${argType.name}.${f.name}' has type ${typeName(f.type)}, which the built-in stringifier cannot serialize`,
                    expr.args[i].span, `add '@derive(Json)' to '${argType.name}' — the derived codec handles nested structs, Vec and Option`);
                }
              }
            }
            this.autoJsonStringify.set(expr.args[i], argType);
          } else {
            this.error(`'${expr.method}' argument ${i + 1}: expected ${typeName(bare)}, got ${typeName(argType)}`, expr.args[i].span);
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
    const structType = bareObjType.tag === "struct" ? bareObjType : null;
    if (structType) {
      const sdef = this.structs.get(structType.name);
      if (sdef) {
        const field = sdef.fields.find(f => f.name === expr.method);
        if (field && field.type.tag === "fn") {
          const fnType = field.type;
          if (expr.args.length !== fnType.params.length) {
            this.error(`'${expr.method}' expects ${fnType.params.length} argument(s), got ${expr.args.length}`, sp);
          }
          for (let i = 0; i < expr.args.length; i++) {
            const expected = fnType.params[i];
            if (!expected) break;
            const bare = expected.tag === "ref" ? expected.inner : expected;
            const argType = this.checkExprWithHint(expr.args[i], bare);
            if (!typeEq(bare, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.method}' argument ${i + 1}: expected ${typeName(bare)}, got ${typeName(argType)}`, expr.args[i].span);
            }
            if (expected.tag === "ref") {
              this.setAutoBorrowChecked(expr.args[i], expected.mutable, sp);
            } else {
              this.tryMove(expr.args[i]);
            }
          }
          this.fnFieldCalls = this.fnFieldCalls || new Set();
          this.fnFieldCalls.add(expr);
          return this.setType(expr, fnType.ret);
        }
      }
    }

    // `.clone()` on a Copy scalar is the identity. It exists so generic code
    // can be written once: `fn get<T>(w: &Wrapper<T>): T { return w.val.clone() }`
    // has to compile for T = i64 as well as T = string, and the move-out-of-
    // a-borrow rule leaves clone as the only way to spell it.
    if (expr.method === "clone" && expr.args.length === 0 &&
        isCopy(objType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
      return this.setType(expr, objType);
    }

    this.error(`type '${typeName(objType)}' has no method '${expr.method}'`, sp,
      memberHint(expr.method, this.methodCandidates(objType)));
    return this.setType(expr, { tag: "unknown" });
  }

  private checkIsExprExpr(expr: ExprOf<"IsExpr">): TypeKind {
    const sp = expr.span;
    const opType = this.checkExpr(expr.operand);
    this.bindElidedPattern(expr.pattern, opType.tag === "ref" ? opType.inner : opType);
    if (expr.pattern.kind === "EnumPattern") {
      if (opType.tag !== "enum" && opType.tag !== "unknown") {
        this.error(`'is' pattern requires an enum type, got ${typeName(opType)}`, sp);
      }
    }
    return this.setType(expr, { tag: "bool" });
  }

  private checkIfExprExpr(expr: ExprOf<"IfExpr">): TypeKind {
    const sp = expr.span;
    const condType = this.checkExpr(expr.cond);
    if (condType.tag !== "bool" && condType.tag !== "unknown") {
      this.error(`if condition must be bool, got ${typeName(condType)}`, sp);
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
      this.error(`if-else branches have mismatched types: '${typeName(finalThen)}' vs '${typeName(finalElse)}'`, sp);
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
        this.error(`match arms have mismatched types: '${typeName(result)}' vs '${typeName(t)}'`, sp);
      }
    }
    if (result.tag === "unknown" && finalTypes.some(t => t.tag === "void")) result = { tag: "void" };
    return this.setType(expr, result);
  }

  // Borrow-detection for if-let/let-else subjects, mirroring checkMatchLike: a
  // `&enum` or an enum place (s.field, v[i], *h) is read without being consumed,
  // so its non-Copy payload must bind as a borrow, not a move. Resolves the enum
  // type behind the ref and registers the subject in matchSubjectRef when it
  // borrows (lower reads that to emit subjectIsRef).
  private enumSubjectBorrow(subject: Expr, rawSubjType: TypeKind): { subjType: TypeKind; subjBorrows: boolean } {
    let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
    let subjType: TypeKind = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
    if (!subjIsRef && subject.kind === "Ident") {
      const info = this.lookup(subject.name);
      if (info && info.type.tag === "ref" && info.type.inner.tag === "enum") { subjIsRef = true; subjType = info.type.inner; }
    }
    const subjIsPlace = !subjIsRef && subjType.tag === "enum" &&
      (subject.kind === "FieldAccess" || subject.kind === "IndexAccess" ||
       (subject.kind === "UnaryOp" && subject.op === "*"));
    const subjBorrows = subjIsRef || subjIsPlace;
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
    let root: Expr = recv;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    if (root.kind !== "Ident") return;
    const info = this.lookup(root.name);
    if (!info?.copyBind) return;
    this.error(
      `'${method}' takes '&mut self', but '${root.name}' is a copy of the matched payload — the write would be discarded`,
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
  private isCopyBind(bt: TypeKind, subjectIsPlace: boolean): boolean {
    if (!subjectIsPlace) return false;
    if (bt.tag === "ref") return false;
    return isCopy(bt, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n));
  }

  private isPlaceExpr(e: Expr): boolean {
    let root: Expr = e;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    return root.kind === "Ident";
  }

  private payloadBindType(bt: TypeKind, subjBorrows: boolean): TypeKind {
    if (subjBorrows && !isCopy(bt, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
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

  private checkMatchLike(subject: Expr, arms: MatchArm[], sp: Span | undefined, fnRetType: TypeKind): TypeKind[] {
    const armTypes: TypeKind[] = [];
    const rawSubjType = this.checkExpr(subject);
    {
      const t = rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
      for (const arm of arms) this.bindElidedPattern(arm.pattern, t);
    }
    // Matching on a borrowed enum (`&Enum`) reads the pointee without moving
    // it. Payload bindings become borrows (see below), so nothing is consumed.
    // Reading a ref Ident auto-derefs, so also consult its declared type.
    let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
    let subjType = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
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
    // Matching an OWNED enum local only consumes it if an arm can actually take a
    // payload out — i.e. some pattern binds a non-Copy payload to a NAME. Otherwise
    // (every payload is `_`, or is Copy and therefore snapshot-bound) the match just
    // reads, so borrow it like the place case and leave the local usable afterward.
    // Both halves of that test are load-bearing on real code: `lower.milo`'s bare
    // `match resultType { TypeKind.TString => {} _ => {} }` binds nothing, and milojs's
    // `match cur { JSValue.Obj(o) => ... }` names a Copy i64 handle — a name that cannot
    // take ownership of anything. Dropping either half breaks them.
    //
    // The hazard is not this rule, it is that the rule used to decide SILENTLY: which
    // half applied depended on the Copy-ness of payload types, which is not visible
    // where the match is written, and the consequence surfaced at the subject's *next*
    // use as a bare "use of moved variable". So when the answer is "consumes", record
    // WHY (`ownedInspectBlockedBy`) and let the move diagnostic explain itself.
    let subjIsOwnedInspect = false;
    if (!subjIsRef && !subjIsPlace && subjType.tag === "enum" && subject.kind === "Ident") {
      const einfo = this.enums.get(subjType.name);
      // The first named non-Copy payload, if any: it is what decides "consumes", and it
      // is what the move diagnostic quotes back.
      let blocker: { variant: string; binding: string; type: TypeKind } | undefined;
      if (einfo) {
        outer: for (const arm of arms) {
          const pat = arm.pattern;
          if (pat.kind !== "EnumPattern") continue;
          const v = einfo.variants.get(pat.variant);
          if (!v) continue;
          for (let i = 0; i < pat.bindings.length && i < v.fields.length; i++) {
            const b = pat.bindings[i]!;
            if (b === "_") continue;
            if (isCopy(v.fields[i], (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) continue;
            blocker = { variant: pat.variant, binding: b, type: v.fields[i]! };
            break outer;
          }
        }
        subjIsOwnedInspect = !blocker;
      }
      const info = this.lookup(subject.name);
      if (info) {
        if (blocker) this.ownedInspectBlockedBy.set(info, { ...blocker, subject: subject.name });
        else this.ownedInspectBlockedBy.delete(info);
      }
    }
    const subjBorrows = subjIsRef || subjIsPlace || subjIsOwnedInspect;
    if (subjBorrows) this.matchSubjectRef.add(subject);
    const isEnum = subjType.tag === "enum";
    const isLiteralType = subjType.tag === "int" || subjType.tag === "float" || subjType.tag === "string" || subjType.tag === "bool";
    if (!isEnum && !isLiteralType && subjType.tag !== "unknown") {
      this.error(`match subject must be an enum, integer, float, string, or bool, got ${typeName(subjType)}`, sp);
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
          this.error(`cannot use enum pattern when matching on ${typeName(subjType)}`, arm.pattern.span);
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
        this.error(`match on ${typeName(subjType)} requires a wildcard '_' arm`, sp);
        this.nonExhaustiveMatches.add(arms);
      }
    } else if (isEnum && subjType.tag === "enum") {
      // The tag test is redundant — `subjType` is not reassigned after `isEnum` is
      // computed — but it is what narrows `subjType` for the enum accesses below.
      const enumInfo = this.enums.get(subjType.name)!;
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
              if (subjBorrows && !isCopy(bt, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
                bt = { tag: "ref", inner: bt, mutable: false };
              }
              bindTypes.push(bt);
              this.declare(arm.pattern.bindings[i], { type: bt, mutable: false, moved: false, borrowed: false, read: false,
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
        for (const [name] of enumInfo.variants) {
          if (!covered.has(name)) {
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
  private staticCallOnVariable(expr: any, sp?: Span): TypeKind | null {
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
      this.error(`type '${typeName(t)}' is not hashable — keys must be integer, bool, string, or a struct of hashable fields`, span);
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
      this.error(`ambiguous From conversion: '${typeName(sourceErr)}' matches multiple variants in '${typeName(targetErr)}': ${matches.map(m => m.name).join(", ")}`);
    }
    return null;
  }
}
