// Type declarations shared by the TypeChecker and its split files (re-exported from checker.ts).
import type { TypeKind } from "./types";
import type { Expr, Function, Pattern, Span, Stmt, StructDecl, TraitMethod } from "./ast";
import type { Diagnostic } from "./diagnostics";

// The view constructors for foreign memory, and the one module allowed to call them.
// See the intrinsic in `checkCallExpr` for why the seam is a file rather than a keyword;
// `src/lower.ts` imports both so the two passes cannot disagree about which calls these
// names denote.
// A `?` whose error is boxed into Heap<Iface> on the way out (checker.findPropagateBoxing).
// `errType` is the operand's error type (what gets boxed; `viaMessage` wraps a string in
// the prelude `ErrorMessage` first); `fromType` names the concrete type behind the box, which
// is what the itable is keyed on.
export interface PropagateBoxing { fromType: string; ifaceName: string; viaMessage: boolean; errType: TypeKind }

// One hop from a place to a place inside it. `index` is deliberately opaque —
// two index steps may or may not select the same element, and nothing here tries
// to decide that. `payload` is the inside of an Option/Result reached by `!`/`?`.
// Why a variable is frozen. The distinction matters at exactly one place — an
// index-qualified assignment (`v[0] = x`) — which a view survives and an iteration
// does not. See `freeze` and the Assign case. A `pointer` borrow is a bound `*T` from
// `v.ptr()` / `s.cstr()` / `h.ptr()`: it survives an index write like a view does, and
// unlike either it does not forbid a MOVE of its source; the move ends the holder
// instead, except through `forget` (see `tryMoveLeaf`).
// `capture`: a closure captured the binding. It is a view for everyone else, but the
// closures that capture a binding may still assign to it (see the Assign arm).
export type BorrowKind = "view" | "iteration" | "pointer" | "capture";

// The binding that holds a pointer borrow, so the diagnostic can name both ends:
// `'v' may reallocate here while 'p' still points into its buffer (from 'v.ptr()' on
// line N)`. `null` in `VarInfo.borrowHolders` for every non-pointer borrow.
export interface PointerHolder { name: string; info: VarInfo; root: string; call: string; line: number }

// Where a view/iteration/capture borrow was taken and what holds it, so a conflicting
// mutation can name the borrow instead of only saying one exists. `holder` is filled in
// when the borrow is handed to a binding (`let r = xs[0..2]`, a match payload); a borrow
// with no holder and no `via` is a temporary inside the current statement.
export interface BorrowSite {
  span?: Span;
  holder?: { name: string; info: VarInfo };
  via?: "loop" | "capture" | "callback";
  // The callback method for `via: "callback"` (`each`, `map`).
  what?: string;
}

// A binding a pattern introduces, wherever it sits. `steps` is its path from the subject,
// one (variant, payload index) per enum it passes through: a flat `Some(x)` has one step,
// `Ok(Some(x))` two. `type` is the payload's own type, before the borrow rule applies.
export interface PatternLeaf { name: string; type: TypeKind; span?: Span; steps: { variant: string; index: number }[] }

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

export interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  // Set wherever the walk moves the binding (never cleared, reassignment included): what the
  // unused-move lint and carryPointerBorrows ask. Use-after-move itself is src/move-flow.ts.
  everMoved?: boolean;
  borrowed: boolean;
  read: boolean;
  span?: Span;
  // Declared at module scope. A global has no single owner (every function, and every
  // later call of the same function, reads the same slot), so it can be read and
  // borrowed but never moved from. See the global branches of `tryMoveLeaf`.
  isGlobal?: boolean;
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
  // An immutable string `let` whose initializer folds to a constant, folded at the
  // declaration (so a later shadowing name cannot change it); checked SQL reads it.
  constStr?: string;
  // Holds a closure: the literals it may have been bound or assigned from, so passing
  // the binding to a call is checked for exclusivity like passing those literals.
  closureSources?: Expr[];
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
  // Where each borrow in `borrowedPaths` came from, same order (diagnostics only).
  borrowSites?: (BorrowSite | null)[];
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
  // A by-value function or closure parameter. Parameters are immutable and cannot be
  // spelled `var`, so "declare with 'var'" is no fix; the diagnostic says to rebind.
  byValueParam?: boolean;
  // A ref pattern binding: the place it points into (root binding + steps), so the
  // call-site exclusivity check sees `inner` and the subject it came from as one place.
  refInto?: { root: unknown; name: string; steps: PlaceStep[] };
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

export interface CaptureInfo {
  name: string;
  type: TypeKind;
  mutable: boolean;
  // Set when the closure body mutates this capture *in place* (assignment or a
  // mutating method on it). Distinguishes "needs write-back to the original"
  // (cannot be move-captured) from a capture that is merely read or moved out
  // (safe to move-capture). Drives the auto-move decision for generic-fn calls.
  mutatedInClosure?: boolean;
  // The field chains under the capture that the body writes, one per write site (`null`
  // when a step is an index or deref). A call of the closure is checked as a write of
  // each of these, so a loop over `self.items` does not reject a closure that only
  // bumps `self.count`.
  mutatedFields?: (string[] | null)[];
  // Set when the closure body MOVES this capture out (hands it to a callee by value).
  // Captures live in the environment's own slots, so the move zeroes the slot — which
  // makes the closure call-once: a second call reads the emptied slot.
  consumedInClosure?: boolean;
  // The field paths under the capture the body reads (`.a.b`), "" for a read of the whole
  // value. A call of the closure is a read of each, so one whose field was moved out
  // since the closure was built is caught like a direct read of that field.
  readPaths?: Set<string>;
  // The captured binding, resolved when the closure literal closes. The call-site
  // exclusivity check uses it (not `name`, which a later binding may shadow) to see a
  // closure argument's captures as borrows of the places they name.
  info?: VarInfo;
}

// A write that evaluating a call argument makes (see TypeChecker.nestedWrites). A move
// carries its index-aware `steps` too: it conflicts with a borrow of the moved place's own
// slot, where a plain write does not, so it needs the precise path to stay off siblings.
export interface NestedWrite { root: unknown; fields: string[] | null; what: string; moved?: boolean; steps?: string[]; expr?: Expr }

// A place a call argument borrows or moves, `arg` being the argument's index.
export interface ArgUse { arg: number; root: unknown; name: string; fields: string[] | null; steps: string[]; moved: boolean; via?: string }

export interface FnSig {
  params: { type: TypeKind; name: string }[];
  ret: TypeKind;
  variadic: boolean;
  isExtern?: boolean;
  // carried for impl methods so call-site precondition checking (constant-arg
  // `requires`) works on `Type.method(...)` calls too, not just free functions.
  contracts?: import("./ast").Contract[];
  // `@mustUse`: a discarded call is the `unused-result` warning. See the ExprStmt rule.
  mustUse?: boolean;
}

export interface StructInfo {
  // `iterDelegate`: `@iter` on the field — `for x in wrapper` iterates this field
  // instead of looking for a `next` method. Lets a newtype keep the container's
  // iteration without leaking the field or paying for a snapshot.
  fields: { name: string; type: TypeKind; cOpaque?: boolean; cName?: string; iterDelegate?: boolean }[];
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
  // File of the declaration (the generic's, for an instantiation). A `_`-prefixed field
  // may only be reached from this file; see checkFieldPrivacy.
  file?: string;
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
  typeArgs?: TypeKind[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  reprType?: string; // set for `enum Kind: i32 { ... }` — the tag IS the integer value
  // The first variant carrying a raw pointer, when the enum is not `@copy`: the same
  // rule as a struct's `pointerField`. An owning handle wrapped in an enum was Copy by
  // the all-variants-Copy rule and so duplicable again.
  pointerVariant?: string;
  // The synthetic declaration of a monomorphized instance (`Option_string`), so a derive
  // can be synthesized for it at either of the two times an instance can appear.
  decl?: import("./ast").EnumDecl;
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
  // Subjects that are `&mut Enum`: their payload bindings are `&mut` views into the
  // payload, so an arm can write `v = v + 1` in place (lower emits subjectIsMut).
  matchSubjectMut: Set<Expr>;
  rewrittenCalls: Map<Expr, string>;
  // Extern calls redirected to a record/replay wrapper (src/replay-externs.ts): the
  // `file:line` the wrapper is handed, and for a variadic extern how many args are fixed
  // (the rest are widened to i64 for the wrapper's tail).
  replaySites: Map<Expr, { wrapper: string; site: string; fixed?: number }>;
  // Thread closures that share unsafe memory: the `file:line` the run's hole report names.
  replayRawShares: Map<Expr, string>;
  rewrittenEnums: Map<Expr, string>;
  // `o == Option.None` / `!=` on an enum with payloads: lowered as the tag test of
  // `operand` (the non-literal side) against `tag`.
  variantTagCompares: Map<Expr, { operand: Expr; tag: number }>;
  staticCalls: Map<Expr, string>;
  rewrittenStructLits: Map<Expr, string>;
  movedExprs: Set<Expr>;
  // Every expression in a move position (consumed by value), moved or not: src/move-flow.ts decides from these.
  movePositions: Set<Expr>;
  borrowedExprs: Set<Expr>;
  sharedStringExprs: Set<Expr>;
  sharedStringCaptures: Map<Expr, Set<string>>;
  keyExtractorClosures: Set<Expr>;
  autoWrappedOption: Map<Expr, string>;
  arrayToVecCoercions: Set<Expr>;
  // `[v; N]` of a type with a Clone impl: the mangled clone fn codegen calls for the N-1
  // copies (the original moves into the last slot).
  arrayRepeatClones: Map<Expr, string>;
  functions: Map<string, FnSig>;
  // Names of the user's generic fns; with `functions`, what `userFnShadowsBuiltin` reads.
  genericFnNames: ReadonlySet<string>;
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
  propagateMessages: Map<Expr, { name: string; errType: TypeKind }>;
  propagateBoxings: Map<Expr, PropagateBoxing>;
  contextBoxings: Map<Expr, PropagateBoxing>;
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
  // Vec/array for-ins over an owned temporary: the loop consumes the container and
  // binds each element by value. Decided here (isPlaceIterable) so lowering and
  // codegen never re-derive it.
  consumingForIns: Set<Stmt>;
  // `let x = v[i]` bindings that alias the element instead of cloning it (resolveViewBinds).
  viewLets: Set<Stmt>;
  // `let` / `var` bindings whose type is a reference (a slice or view of another place): they own nothing.
  refLets: Set<Stmt>;
  // The type each for-in binding was declared with ([varName, varName2?]), for hover.
  forInBindingTypes: Map<Stmt, TypeKind[]>;
  // The node the checker put in place of each expression it re-spelled (a prelude variant, a callback
  // thunk). The tree itself is never written: every reader of a child expression goes through `rewritten`.
  rewrites: Map<Expr, Expr>;
  // The same for patterns (an elided enum name filled in, a bare variant name settled).
  patternRewrites: Map<Pattern, Pattern>;
}

export interface GenericEnumInfo {
  typeParams: string[];
  typeParamDefaults?: (TypeKind | null)[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  decl: import("./ast").EnumDecl;
}

export interface GenericStructInfo {
  typeParams: string[];
  fields: { name: string; type: TypeKind }[];
  decl: StructDecl;
}

export interface GenericFnInfo {
  typeParams: string[];
  decl: Function;
}

export interface TraitMethodInfo {
  params: { name: string; type: TypeKind }[];
  ret: TypeKind;
  hasDefault: boolean;
  // The declaration as written, kept so an impl can be checked against it with `Self`
  // substituted BEFORE resolution: `Option<Self>` resolves to a monomorphized name that
  // no TypeKind-level substitution can reach. Absent for the built-in traits, whose
  // signatures mention `Self` only bare or behind one `&`.
  decl?: TraitMethod;
}

export interface TraitInfo {
  name: string;
  supertraits: string[];
  methods: Map<string, TraitMethodInfo>;
}

export interface ImplInfo {
  traitName: string | null;
  typeName: string;
  methods: Map<string, FnSig>;
}

export interface InterfaceMethodInfo {
  params: { name: string; type: TypeKind }[];
  ret: TypeKind;
}

export interface InterfaceInfo {
  name: string;
  methods: Map<string, InterfaceMethodInfo>;
}

// Narrow an Expr union member by its `kind`, so an extracted arm keeps exactly the
// type the switch gave it without importing every node interface.
export type ExprOf<K extends Expr["kind"]> = Extract<Expr, { kind: K }>;
