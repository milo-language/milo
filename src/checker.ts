// Type checking, move checking and scope validation over the merged AST, producing
// the CheckResult that lowering reads. Semantic errors are caught HERE, before codegen:
// if codegen can reach an invalid state, this file missed it.
// Error recovery: an erroneous declaration still binds, an erroneous expression is typed
// `unknown`, and nothing reports about `unknown` (enforced in `error()`).
import { attributesFor } from "./attributes";
import type { ReplayPlan } from "./replay-externs";
import { simpleType } from "./ast";
import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span, MatchArm, Attribute, GlobalDecl, ArrayLit, ArrayRepeat, BinOp, Call, CastExpr, ClosureExpr, DefaultValue, EnumLit, FieldAccess, ForInStmt, Ident, IfExpr, IndexAccess, IsExpr, LetDecl, MatchExpr, MethodCall, Propagate, StructLit, UnaryOp, Unwrap } from "./ast";
import { typeEq, typeName, isCopy } from "./types";
import type { TypeKind } from "./types";
import type { Diagnostic, DiagnosticNote, WarningConfig } from "./diagnostics";
import type { ProgramView, ProgramPassHost } from "./checker-program-passes";
import { DeriveSynth } from "./checker-derive";
import { SqlChecker } from "./checker-sql";
import type { ConstResolver } from "./checker-sql";
import { display } from "./mangle";
import { rewritten, rewrittenPattern, userFnShadowsBuiltin, wrapTypeArg } from "./checker-util";
import * as diag from "./checker-diag";
import * as resolve from "./checker-resolve";
import * as borrows from "./checker-borrows";
import * as borrowMoves from "./checker-borrows-moves";
import * as traits from "./checker-traits";
import * as flow from "./checker-flow";
import * as matches from "./checker-match";
import * as methodCalls from "./checker-method-call";
import * as calls from "./checker-calls";
import * as exprs from "./checker-expr";
import * as literals from "./checker-literals";
import * as stmts from "./checker-stmt";
import * as core from "./checker-core";
import * as register from "./checker-register";
import type { ArgUse, CSig, CValue, CaptureInfo, EnumInfo, FnSig, GenericEnumInfo, GenericFnInfo, GenericStructInfo, ImplInfo, InterfaceInfo, PatternLeaf, PlaceStep, PropagateBoxing, StructInfo, TraitInfo, TraitMethodInfo, VarInfo } from "./checker-types";
export type { ArgUse, CaptureInfo, CheckResult, EnumInfo, ExprOf, FnSig, ImplInfo, InterfaceMethodInfo, NestedWrite, PatternLeaf, Place, PlaceStep, PropagateBoxing, StructInfo, TraitInfo, TraitMethodInfo, VarInfo } from "./checker-types";

export class TypeChecker {
  warningConfig: WarningConfig;
  diagnostics: Diagnostic[] = [];
  // checkMutForInSource's "cannot use 'v' inside 'for x in &mut v'" errors by site, so a
  // loop-conflict error from src/borrow-flow.ts at the same site can replace its less specific twin.
  mutForInUses = new Map<string, Diagnostic>();
  // The finished-program view and the global write/park summary of checkPasses, kept for src/borrow-flow.ts.
  callFacts: { host: ProgramPassHost; view: ProgramView; summary: { writes: Map<string, Set<string>>; parks: Set<string> } | undefined } | undefined;
  // Deferred Vec element inference: `var v = Vec.new()` with no annotation gets a
  // placeholder element object, resolved in-place from the first `v.push(x)`.
  // inferVecElems holds the live placeholder objects (identity set); pendingInferVecs
  // records each with its span so an unresolved one (no push ever seen) can error.
  // A placeholder is `{ tag: "unknown", inferId }` (so every unknown rule applies until it resolves);
  // `inferred[inferId]` is its resolution, and `zonkStored` rewrites every stored type to it.
  inferred: (TypeKind | undefined)[] = [];
  pendingInferVecs: Array<{ elem: TypeKind; span: Span | undefined }> = [];
  // A deferred `Vec.withCapacity(n)` binds its std constructor when the element resolves.
  inferVecCtors = new Map<number, EnumLit>();
  _globalTypes = new Map<string, TypeKind>();
  _nonConstGlobals: string[] = [];
  functions = new Map<string, FnSig>();
  fnDecls = new Map<string, Function>();
  // Mangled names of `@unsafe` methods (`Type$m`, `Type$Trait$m`). Trait method declarations
  // carry no attributes, so an impl's own `@unsafe` is what a monomorphized call checks.
  unsafeMethods = new Set<string>();
  // Which contract clause is being checked, if any. `old()` is legal only inside `ensures`,
  // and the error for it elsewhere reads better naming the clause it was found in.
  inAssertCond = false;
  contractScope: "requires" | "ensures" | "invariant" | "decreases" | null = null;
  genericFns = new Map<string, GenericFnInfo>();
  // fns already flagged for a reference return — the declaration scan and checkFunction
  // both see plain fns, and only the second sees impl methods
  refReturnReported = new Set<Function>();
  // The "cannot return a reference" error per function, so the return that hands out
  // the view can be attached to it as a note instead of a second error for one mistake.
  refReturnDiags = new Map<Function, Diagnostic>();
  currentFnDecl: Function | null = null;
  structs = new Map<string, StructInfo>();
  enums = new Map<string, EnumInfo>();
  genericEnums = new Map<string, GenericEnumInfo>();
  genericStructs = new Map<string, GenericStructInfo>();
  // Store the alias's AST type, not a resolved TypeKind: aliases are registered
  // before enums/structs, so eager resolution would mis-tag a referenced enum as
  // a struct (breaks `?` auto-From into an aliased Result error type). Resolve
  // lazily at each use site, when every type name is registered.
  typeAliases = new Map<string, MiloType>();
  // Alias names currently being expanded. `type A = A`, `type A = B` / `type B = A`, and the
  // generic `type Loop<T> = Loop<T>` all resolve by expanding a body that names the alias
  // again; without this the recursion runs until the JS stack dies and the user gets a host
  // stack trace instead of a diagnostic. It exits 1 either way, so this is a message fix
  // rather than a silent-success one.
  expandingAliases = new Set<string>();
  // Type names reported undeclared by reportUnknownTypeNames; `resolve` maps them to `unknown`.
  unknownTypeNames = new Set<string>();
  // Parameters of a GENERIC alias, by alias name. An alias is a template expanded at the
  // use site rather than a type of its own, so this is the arity to check the use against
  // and the names to substitute — there is no instantiation to record anywhere.
  aliasTypeParams = new Map<string, string[]>();
  rangeCheckedExprs = new Map<Expr, { min: number; max: number; typeName: string }>();
  monomorphizedDecls: import("./ast").EnumDecl[] = [];
  monomorphizedStructDecls: StructDecl[] = [];
  monomorphizedFns: Function[] = [];
  // Instances of a method with its own type parameters (`fn map<U>` on a struct); a
  // generic fn's instance says so through `sourceName` instead.
  methodGenericInstances = new Set<string>();
  voidGenericReported = new Set<string>();
  // Guard against an unbounded recursive generic (e.g. `fn grow<T>() { grow<Wrap<T>>() }`)
  // whose every instantiation is a fresh type, so the memo never hits and checkFunction
  // recurses until the JS stack blows. Cap the instantiation depth and fail cleanly.
  static readonly MAX_MONO_DEPTH = 256;
  monoDepth = 0;
  monoDepthErrored = false;
  dropImpls = new Set<string>();
  sendTypes = new Set<string>();
  syncTypes = new Set<string>();
  // Depth of nesting inside the OBJECT of a field/index access. While raised, an
  // identifier read is naming a container on the way to a narrower place rather than
  // using the value itself — the one distinction the partial-move read rule needs.
  // A new object-checking site that forgets to raise it over-reports rather than
  // under-reports, which is the direction to fail in.
  placeBaseDepth = 0;
  unsafeDepth = 0;
  // Parallel to unsafeDepth: one flag per live `unsafe` block, set true the moment
  // an operation inside it actually needs unsafe. A block popped still false is the
  // unused-unsafe lint target. Marking happens at the real check sites (via
  // requireUnsafe) so ops nested in call args/closures count — the trap the
  // prior statement-walker attempt fell into.
  unsafeUsedStack: boolean[] = [];
  scopes: Map<string, VarInfo>[] = [];
  // Per-statement bookkeeping used to rescan every binding in scope, and the module scope
  // holds every global (300+ in a game-sized program), which made those scans the
  // checker's top cost. The fields below let each scan skip the bindings it provably
  // cannot change; the results are the same as the full scans.
  //
  // The module scope (pushed before globals are declared) and every VarInfo declared in it.
  globalScope: Map<string, VarInfo> | null = null;
  globalScopeInfos = new Set<VarInfo>();
  // Bindings whose flexInt is (or recently was) set, with the name they are declared under.
  flexIntVars = new Map<VarInfo, string>();
  exprTypes = new Map<Expr, TypeKind>();
  // Per-pattern payload binding types (parallel to pattern.bindings), for hover/LSP.
  patternBindingTypes = new Map<import("./ast").Pattern, TypeKind[]>();
  nullRefUnwraps = new Map<import("./ast").LetElseStmt, { inner: TypeKind; mutable: boolean }>();
  autoBorrowed = new Map<Expr, { mutable: boolean }>();
  // Arguments the program spelled `&mut x`. The wrapper is gone by the time the argument
  // is checked (takeExplicitMutArgs strips it), so this set is the only record that the
  // marker was written; a bare argument bound to `&mut T` is what implicit-mut-borrow
  // reports.
  explicitMutArgs = new Set<Expr>();
  // Source positions already reported as implicit-mut-borrow. A generic body is checked
  // once per instantiation, so without this one bare argument yields N copies of the error.
  implicitMutSeen = new Set<string>();
  matchSubjectRef = new Set<Expr>();
  matchSubjectMut = new Set<Expr>();
  // Every expression a call path handed to tryMove: the by-value arguments that path
  // really moves, which checkCallSiteExclusivity counts as exclusive uses. Asking the
  // path rather than re-deriving it keeps builtins (`format` reads its args) out.
  moveRequested = new Set<Expr>();
  // The binding each Ident resolved to when it was checked. A fork's tail is moved only
  // after the whole fork is checked (tryMove forwards a match/if to its arm tails), and by
  // then the arm's scope is popped: `lookup` misses the pattern binding, so a `&T` payload
  // view returned as the arm's value (`match e { E.A(msg) => msg }` on `e: &E`) escaped
  // the borrowed-move rule and double-freed.
  identBinding = new WeakMap<Expr, VarInfo>();
  rewrittenCalls = new Map<Expr, string>();
  replaySites = new Map<Expr, { wrapper: string; site: string; fixed?: number }>();
  replayRawShares = new Map<Expr, string>();
  declOrigins: import("./ast").DeclOrigins | undefined;
  // Plain method calls rather than `this.declOrigins?.x.get(n)`: an optional chain that ends in a call is outside the generated frontend's subset.
  declOrigin(ns: "values" | "types", name: string): import("./ast").DeclOrigin | undefined {
    if (this.declOrigins === undefined) return undefined;
    return ns === "values" ? this.declOrigins.values.get(name) : this.declOrigins.types.get(name);
  }
  declFiles(ns: "values" | "types", name: string): Set<string> {
    const o = this.declOrigin(ns, name);
    return o === undefined ? new Set<string>() : o.files;
  }
  replayPlans: Map<string, ReplayPlan> | undefined;
  // The fn being checked records its own extern calls (`@replayHooked`), so they stay direct.
  currentFnReplayHooked = false;
  rewrittenEnums = new Map<Expr, string>();
  rewrites = new Map<Expr, Expr>();
  patternRewrites = new Map<Pattern, Pattern>();
  staticCalls = new Map<Expr, string>();
  variantTagCompares = new Map<Expr, { operand: Expr; tag: number }>();
  rewrittenStructLits = new Map<Expr, string>();
  // Field defaults (`timeoutMs: i64 = 30000`), by declared struct name (a generic's base
  // name): field -> the pristine default AST, copied into each literal that omits it.
  structDefaults = new Map<string, Map<string, Expr>>();
  // Fields whose default was rejected: a literal omitting one is not ALSO missing a field.
  badDefaults = new Set<string>();
  // Literals already filled (a literal can be checked more than once).
  defaultsFilled = new WeakSet<Expr>();
  movedExprs = new Set<Expr>();
  viewLets = new Set<Stmt>();
  refLets = new Set<Stmt>();
  // Candidates for viewLets in the function being checked, decided once its body is done.
  viewBindPending = new Map<Stmt, { root: string; lint: () => void }>();
  borrowedExprs = new Set<Expr>();
  // Strings copied out of a place this code does not own (a `&string` binding, a field
  // behind a borrow, a field of a container element, a global). Heap string buffers are
  // reference counted, so the copy is a count increment rather than a move or an error:
  // lowering wraps each one in a StringClone, which shares the buffer.
  sharedStringExprs = new Set<Expr>();
  // `move` closure captures of a string that share rather than move (keyed by the closure).
  sharedStringCaptures = new Map<Expr, Set<string>>();
  autoWrappedOption = new Map<Expr, string>();
  arrayToVecCoercions = new Set<Expr>();
  arrayRepeatClones = new Map<Expr, string>();
  closureCaptures = new Map<Expr, CaptureInfo[]>();
  // Expressions whose evaluation writes the place they name (a mutating receiver, a
  // `&mut` argument), and calls of local closures with the captures their bodies write.
  // `nestedWrites` reads both to see a write buried inside a call argument.
  writtenExprs = new WeakSet<Expr>();
  closureCallWrites = new Map<Expr, CaptureInfo[]>();
  // First arguments checkCallSiteExclusivity has seen: a method receiver found here was
  // checked with its call's arguments, so checkMethodCallExpr need not check it again.
  siteCheckedFirstArgs = new WeakSet<Expr>();
  closureCalls = new Map<Expr, TypeKind>();
  cfnCalls = new Map<Expr, TypeKind>();
  sizeOfTypes = new Map<Expr, TypeKind>();
  cSigs = new Map<string, CSig>();
  cValues = new Map<string, CValue>();
  offsetOfFields = new Map<Expr, string>();
  // One frame per closure literal currently being checked, innermost last. A stack rather
  // than a single (depth, captures) pair because an enclosing closure must carry every
  // capture its nested closures reach past it for: `inner`'s env is built from `outer`'s
  // env slot, so `outer` has to capture the binding too (backlog #45).
  closureFrames: { depth: number; captures: Map<string, CaptureInfo> }[] = [];
  get closureScopeDepth(): number | null {
    const f = this.closureFrames[this.closureFrames.length - 1];
    return f ? f.depth : null;
  }
  get currentClosureCaptures(): Map<string, CaptureInfo> | null {
    const f = this.closureFrames[this.closureFrames.length - 1];
    return f ? f.captures : null;
  }
  // The exact expressions a `sortByKey` extractor returns that are rooted at its borrowed
  // parameter (`u.name`): the only moves out of a borrow the checker lets through, because
  // the sort reads that key and forgets it. Keyed by expression, not by "inside the
  // extractor", so a `let x = u.tags`, a call argument, or a nested closure's return in the
  // same body is still refused. See the FieldAccess branch of tryMove.
  extractorKeyReads = new Set<Expr>();
  isExtractorKey(e: Expr): boolean { return this.extractorKeyReads.has(e); }
  // sortByKey's extractor arguments: emit-mlir lets such a closure return a view of its
  // borrowed element (emit-mlir.ts, e.keyExtractor).
  keyExtractorClosures = new Set<Expr>();
  currentFnRetType: TypeKind = { tag: "void" };
  // Origin file of the fn body being checked; see checkFieldPrivacy.
  currentFnFile: string | undefined;
  loopDepth = 0;
  // Whether control can reach the statement being checked. `return`, `break`,
  // `continue`, a call whose type is `never` (`exit`, `todo`) and a loop nothing leaves
  // clear it; every join (if, if-let, match, if/match expressions, loops) sets it to
  // "any incoming path is reachable" and merges move state over the reachable paths only
  // (`joinPaths`). This is the one model of divergence for move tracking; the syntactic
  // `bodyAlwaysReturns` is left to the unreachable-code diagnostic.
  reachable = true;
  // Per enclosing loop, how many reachable `break`s and `continue`s the body has, and
  // whether the loop itself was reachable (a loop with no way out leaves what follows unreachable).
  loopFrames: { breaks: number; continues: number; reachable: boolean }[] = [];
  traits = new Map<string, TraitInfo>();
  traitImpls = new Map<string, ImplInfo[]>();
  inherentImpls = new Map<string, ImplInfo>();
  genericImpls = new Map<string, { impl: import("./ast").ImplDecl; program: Program }[]>();
  // Mangled container-impl name (`Vec_i64`) -> the container type it stands for; see selfTypeOf.
  containerSelfType = new Map<string, MiloType>();
  // Container trait impls already instantiated, keyed by mangled name and template; see
  // instantiateContainerImpl, which instantiates inherent methods one at a time instead.
  containerTraitImplsDone = new Set<string>();
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
  genericMethods = new Map<string, { decl: Function; owner: string }>();
  _pendingImplFns: Function[] = [];
  // Trait bounds on a generic STRUCT's type params, checked after every impl has
  // registered. A struct is monomorphized as soon as a field mentions it, which can
  // be before `impl Reader for File` exists — checking eagerly would reject the
  // legal case, so the verdict waits until the impl tables are complete.
  _pendingStructBounds: { struct: string; mangled: string; param: string; concrete: TypeKind; bound: string }[] = [];
  _boundFailedStructs = new Set<string>();
  // `@copyOnly` on a generic struct: each instantiation's type args must be Copy. Deferred
  // for the same reason as the trait bounds above, and one more: a struct is monomorphized
  // while other structs are still being registered, and `isAllCopyStruct` on a name that
  // is not registered yet answers false, which would reject `Shard<Point>` for a `Point`
  // declared further down the file.
  _pendingCopyOnly: { generic: string; mangled: string; concrete: TypeKind; span?: Span }[] = [];
  // One report per offending type, not per instantiation: `parallelMap(strings, 4, f)`
  // reaches `Shards<string>`, whose fields and methods then reach `Shard<string>`, and
  // only the first of those sits on a line the user wrote.
  copyOnlyReported = new Set<string>();
  resolvedMethods = new Map<Expr, string>();
  heapMethodReceivers = new Set<Expr>();
  iteratorForIns = new Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>();
  stringViewForIns = new Map<Stmt, { mode: "lines" | "split" }>();
  iterDelegates = new Map<Stmt, string>();
  consumingForIns = new Set<Stmt>();
  forInBindingTypes = new Map<Stmt, TypeKind[]>();
  resolvedOperators = new Map<Expr, string>();
  fnFieldCalls = new Set<Expr>();
  // `s.f(...)` where `f` is a C function-pointer field: an indirect call with no
  // environment argument, distinct from the fat-closure ClosureCall lower path.
  cfnFieldCalls = new Set<Expr>();
  // Every READ of a C function-pointer field, recorded when it is checked and deleted
  // again by the two contexts that may consume one (a store into another such field,
  // and `isNull`). Whatever is left when the program is checked is a use the design
  // does not cover, so the rule fails closed: a context nobody thought about errors
  // rather than silently handing a thin pointer to code that expects a fat one.
  strandedCFnReads = new Map<Expr, { struct: string; field: string; span?: Span }>();
  propagateConversions = new Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>();
  // `?` from a typed error into a fn returning `Result<T, string>`: the error's
  // `message()` becomes the string. Keyed to the concrete type that owns the method.
  propagateMessages = new Map<Expr, { name: string; errType: TypeKind }>();
  // `doc["a"][0]` chains rewritten to `doc.idxKey(...)` calls (std/json), keyed to the
  // `Json` place every step and the terminal read re-borrow (rewriteJsonIndex).
  jsonChains = new Map<Expr, Expr>();
  // `?` in a fn returning Result<T, Heap<Iface>>: the operand's error is boxed and
  // coerced to the interface on the error path (see checkPropagateExpr).
  propagateBoxings = new Map<Expr, PropagateBoxing>();
  // `.context(note)` on a Result whose error is not yet a Heap<Error>: how to box it
  // before it becomes the ErrorContext's cause. Absent when the error is already boxed.
  contextBoxings = new Map<Expr, PropagateBoxing>();
  interfaces = new Map<string, InterfaceInfo>();
  interfaceCoercions = new Map<Expr, { fromType: string; ifaceName: string }>();
  interfaceMethodCalls = new Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>();
  autoJsonStringify = new Map<Expr, TypeKind>();
  // Arguments where a fixed array is being passed to a slice parameter. Lowering turns
  // each into a full-range slice; the checker cannot do it because the conversion is a
  // representation change, not a type judgement.
  arraySliceArgs = new Set<Expr>();
  // Subset of the above whose struct has a `toJson`: the mangled name to call
  // instead of the built-in stringifier.
  autoJsonToJson = new Map<Expr, string>();
  anonStructCounter = 0;
  anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[] = [];
  _userFnNames?: Set<string>;
  entryFile?: string;
  _userImplKeys?: Set<string>;
  // Manifest dep names whose symbols carry a `<pkg>$` prefix (see fnIsUserCode).
  _packageNames?: Set<string>;
  // Mangled symbol -> as-written name, for the private names the per-module pass renamed
  // (src/mangle.ts). Applied to every diagnostic on the way out of `check()`: a diagnostic
  // is built as a string from a hundred call sites, so the one place that can guarantee no
  // mangled name reaches a reader is the boundary they all pass through.
  _displayNames?: Map<string, string>;
  // true while checking a function from the user's own file (not imported code);
  // gates lints that would otherwise flood every compile with stdlib noise
  currentFnIsUser = true;
  // true while checking a function from a manifest dependency (see fnIsDependencyCode)
  currentFnIsDep = false;

  constructor(warningConfig?: WarningConfig) {
    this.warningConfig = warningConfig ?? { denied: new Set(), allowed: new Set() };
  }
  warnAdoptRawFields(fnName: string, declSpan: Span | undefined, typeArgs: TypeKind[], sp?: Span) { return diag.warnAdoptRawFields(this, fnName, declSpan, typeArgs, sp); }
  isUninhabited(t: TypeKind, seen: Set<string>) { return diag.isUninhabited(this, t, seen); }
  error(msg: string, span?: Span, hint?: string) { return diag.error(this, msg, span, hint); }
  errorWithNotes(msg: string, span: Span | undefined, hint: string | undefined, notes: DiagnosticNote[]) { return diag.errorWithNotes(this, msg, span, hint, notes); }

  // A value typed `unknown` came out of an expression that already failed to check, so
  // anything said about it next is a guess about a type nobody knows: `let c = Math.nope()`
  // then `use(c); use(c)` reported "use of moved variable 'c'" because `unknown` is not
  // Copy. Requiring an error already on file is what keeps this from hiding anything: if
  // no error was reported, an `unknown` is a checker bug and must not pass silently, and
  // once one is on file the compile fails regardless of what is suppressed.
  isPoisoned(t: TypeKind): boolean {
    return t.tag === "unknown" && this.diagnostics.some(d => d.severity === "error");
  }
  rejectVoidTypeArgs(owner: string, args: TypeKind[], sp?: Span) { return diag.rejectVoidTypeArgs(this, owner, args, sp); }
  methodCandidates(t: TypeKind) { return diag.methodCandidates(this, t); }
  checkMissingInterpolation(expr: import("./ast").StringLit) { return diag.checkMissingInterpolation(this, expr); }
  errorUnknownStatic(typeName_: string, member: string, sp: Span | undefined) { return diag.errorUnknownStatic(this, typeName_, member, sp); }
  unimportedRenamed(name: string, ns: "values" | "types", sp: Span | undefined) { return diag.unimportedRenamed(this, name, ns, sp); }
  unknownTypeHint(name: string, extra?: Iterable<string>) { return diag.unknownTypeHint(this, name, extra); }
  reportUnknownTypeNames(program: Program): void { return diag.reportUnknownTypeNames(this, program); }
  nameHint(name: string) { return diag.nameHint(this, name); }
  fieldCandidates(t: TypeKind) { return diag.fieldCandidates(this, t); }
  fatal(msg: string, span?: Span, hint?: string): never { return diag.fatal(this, msg, span, hint); }
  recover(f: () => void) { return diag.recover(this, f); }

  // Names given to `--expect=` that actually fired, so an expectation that never did can
  // be reported. Recorded BEFORE the allow/deny decision, because whether the finding
  // occurred is a different question from whether it was shown.
  firedWarnings = new Set<string>();
  warn(code: string, msg: string, span?: Span, hint?: string, len?: number) { return diag.warn(this, code, msg, span, hint, len); }
  fixedArrayBytes(t: TypeKind) { return diag.fixedArrayBytes(this, t); }
  lintStackArray(name: string, ty: TypeKind, span?: Span) { return diag.lintStackArray(this, name, ty, span); }
  inStdFile(sp: Span | undefined) { return diag.inStdFile(this, sp); }
  typeDeclaredInStd(ty: TypeKind) { return diag.typeDeclaredInStd(this, ty); }
  carriesRawPointer(ty: TypeKind, seen?: Set<string>) { return diag.carriesRawPointer(this, ty, seen); }
  resourceKind(ty: TypeKind, seen?: Set<string>) { return diag.resourceKind(this, ty, seen); }
  dropTypesIn(ty: TypeKind, out?: Set<string>, seen?: Set<string>) { return diag.dropTypesIn(this, ty, out, seen); }
  errorIfResourceIndexRead(expr: IndexAccess, ty: TypeKind) { return diag.errorIfResourceIndexRead(this, expr, ty); }
  errorIfResourceCopyOut(elem: TypeKind, what: string, container: string, sp: Span | undefined, borrowForm: string) { return diag.errorIfResourceCopyOut(this, elem, what, container, sp, borrowForm); }
  lintStringConcatInLoop(target: Expr, value: Expr, targetType: TypeKind, span?: Span) { return diag.lintStringConcatInLoop(this, target, value, targetType, span); }
  viewBindRoot(stmt: LetDecl, hint: TypeKind | null, valType: TypeKind) { return diag.viewBindRoot(this, stmt, hint, valType); }
  viewBindPure(t: TypeKind, seen: Set<string>) { return diag.viewBindPure(this, t, seen); }
  resolveViewBinds(body: Stmt[]) { return diag.resolveViewBinds(this, body); }
  viewBindRegionClean(region: Stmt[], root: string, name: string) { return diag.viewBindRegionClean(this, region, root, name); }
  lintIndexClone(slot: Expr, ty: TypeKind, span?: Span) { return diag.lintIndexClone(this, slot, ty, span); }
  fnIsUserCode(name: string) { return diag.fnIsUserCode(this, name); }
  requireUnsafe(msg: string, span?: Span, hint?: string) { return diag.requireUnsafe(this, msg, span, hint); }
  mustUseCallee(slot: Expr) { return diag.mustUseCallee(this, slot); }
  noteSafeExternCall(name: string, attrs: { name: string }[] | undefined, allScalar: boolean, span?: Span) { return diag.noteSafeExternCall(this, name, attrs, allScalar, span); }
  redirectForReplay(expr: Expr & { kind: "Call" }, sp: Span | undefined) { return diag.redirectForReplay(this, expr, sp); }
  fnIsDependencyCode(name: string) { return diag.fnIsDependencyCode(this, name); }
  requireUnsafeMethod(mangled: string, name: string, span?: Span) { return diag.requireUnsafeMethod(this, mangled, name, span); }
  requireUnsafeCall(decl: { attributes?: { name: string }[] } | undefined, name: string, span?: Span) { return diag.requireUnsafeCall(this, decl, name, span); }
  propagateRange(lt: TypeKind & { tag: "int" }, rt: TypeKind & { tag: "int" }, op: string): TypeKind | null { return diag.propagateRange(lt, rt, op); }
  foldConstInt(e: Expr) { return diag.foldConstInt(this, e); }
  constIntValue(expr: import("./ast").Expr): bigint | null { return diag.constIntValue(expr); }
  enforceRangeInto(valueExpr: Expr, valType: TypeKind, target: TypeKind, sp?: Span) { return diag.enforceRangeInto(this, valueExpr, valType, target, sp); }
  enforceArgRange(arg: Expr, argType: TypeKind, paramType: TypeKind, sp?: Span) { return diag.enforceArgRange(this, arg, argType, paramType, sp); }
  enforceWrapRange(expr: Expr) { return diag.enforceWrapRange(this, expr); }
  constFloatValue(expr: import("./ast").Expr): number | null { return diag.constFloatValue(expr); }
  constNumericValue(expr: import("./ast").Expr) { return diag.constNumericValue(this, expr); }
  tryEvalContractExpr(expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>) { return diag.tryEvalContractExpr(this, expr, subs); }
  resolveNumericValue(expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>) { return diag.resolveNumericValue(this, expr, subs); }
  checkCallSiteContracts(fnDecl: import("./ast").Function, args: import("./ast").Expr[], callSpan?: import("./ast").Span) { return diag.checkCallSiteContracts(this, fnDecl, args, callSpan); }
  checkContractClause(c: import("./ast").Contract): void { return diag.checkContractClause(this, c); }

  vacuousSeen = new WeakSet<import("./ast").Contract>();
  isTrivialClause(e: import("./ast").Expr) { return diag.isTrivialClause(this, e); }
  contractExprToString(expr: import("./ast").Expr) { return diag.contractExprToString(this, expr); }
  checkConstOverflow(lv: bigint, rv: bigint, op: string, ty: TypeKind, span?: Span) { return diag.checkConstOverflow(this, lv, rv, op, ty, span); }
  nestedRef(t: TypeKind, seen = new Set<string>()) { return resolve.nestedRef(this, t, seen); }
  resolve(ty: MiloType, sp?: Span) { return resolve.resolve(this, ty, sp); }
  mangleTypeName(t: TypeKind) { return resolve.mangleTypeName(this, t); }
  monomorphizeEnum(baseName: string, typeArgs: TypeKind[], sp?: Span) { return resolve.monomorphizeEnum(this, baseName, typeArgs, sp); }

  // The generic enums whose instances get Clone the way a Rust derive's `T: Clone` bound
  // does: only when every payload can be cloned, silently not otherwise, so that an
  // `Option<closure>` stays a legal type that merely has no clone().
  _derivesProcessed = false;
  // The names the Clone fixpoint closed over. Kept past processDerives because an
  // instance monomorphized between the fixpoint and the registration of its impls
  // (an `Option<P>` in a user impl's signature) must still see P as clonable.
  cloneDerived = new Set<string>();
  deriveCloneForBuiltinInstance(mangled: string): void { return resolve.deriveCloneForBuiltinInstance(this, mangled); }
  flushStructBounds() { return resolve.flushStructBounds(this); }
  copyOnlyParams(attrs: Attribute[] | undefined, typeParams: string[]): Set<string> { return resolve.copyOnlyParams(attrs, typeParams); }

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
  //
  // `@ordered` is the same withholding for a routine that compares `T` with `<`, which
  // exists only on integers, floats and strings: `BinaryHeap<Task>` keeps `withCompare`
  // and loses the natural-order `new`, rather than failing inside std on a `<` the
  // caller never wrote.
  withheldMethods = new Map<string, { reason: string; hint: string }>();
  // Calls the frozen-collection guard already judged, so a mutating builtin whose body
  // moved to std (dispatchMangledMethod) is not reported against a live loop twice.
  collectionGuarded = new WeakSet<Expr>();
  copyOutBlocker(attrs: Attribute[] | undefined, typeArgs: TypeKind[]) { return resolve.copyOutBlocker(this, attrs, typeArgs); }
  orderedBlocker(attrs: Attribute[] | undefined, typeParams: string[], typeArgs: TypeKind[]): TypeKind | null { return resolve.orderedBlocker(attrs, typeParams, typeArgs); }
  withheldReason(what: string, attrs: Attribute[] | undefined, typeParams: string[], typeArgs: TypeKind[]) { return resolve.withheldReason(this, what, attrs, typeParams, typeArgs); }
  methodWithheld(m: Function, mangled: string, typeParams: string[], typeArgs: TypeKind[]) { return resolve.methodWithheld(this, m, mangled, typeParams, typeArgs); }
  copyOutReason(what: string, b: { kind: string; via: TypeKind; arg: TypeKind }) { return resolve.copyOutReason(this, what, b); }
  static readonly COPY_OUT_HINT =
    `a copy of a resource is released once per copy; use the borrowing form of this API ` +
    `(a callback taking '&T' or '&mut T'), or clone the element where its own Clone impl runs`;
  checkRawTypeParamReads(): void { return resolve.checkRawTypeParamReads(this); }
  rejectNonCopyTypeArg(generic: string, mangled: string, concrete: TypeKind, span?: Span) { return resolve.rejectNonCopyTypeArg(this, generic, mangled, concrete, span); }
  whyNotCopy(t: TypeKind) { return resolve.whyNotCopy(this, t); }
  fromBoundFailedStruct(fn: Function) { return resolve.fromBoundFailedStruct(this, fn); }
  embedsSelf(name: string, stack: Set<string>) { return resolve.embedsSelf(this, name, stack); }
  demangle(mangled: string) { return resolve.demangle(this, mangled); }

  show(t: TypeKind): string {
    return typeName(t, n => this.demangle(n));
  }
  monomorphizeStruct(baseName: string, typeArgs: TypeKind[], sp?: Span) { return resolve.monomorphizeStruct(this, baseName, typeArgs, sp); }
  substituteTypeKind(t: TypeKind, typeMap: Map<string, TypeKind>) { return resolve.substituteTypeKind(this, t, typeMap); }

  pointeeMiloType(t: TypeKind): MiloType {
    return t.tag === "array" && t.element.tag !== "array" ? this.typeKindToMiloType(t) : simpleType(typeName(t));
  }
  typeKindToMiloType(t: TypeKind) { return resolve.typeKindToMiloType(this, t); }
  substituteParamType(ty: MiloType, typeParams: string[], typeArgs: TypeKind[]) { return resolve.substituteParamType(this, ty, typeParams, typeArgs); }

  substituteMiloType(ty: MiloType, typeParams: string[], typeArgs: TypeKind[]): MiloType;
  substituteMiloType(ty: MiloType | null, typeParams: string[], typeArgs: TypeKind[]): MiloType | null;
  substituteMiloType(ty: MiloType | null, typeParams: string[], typeArgs: TypeKind[]): MiloType | null {
    if (ty === null) return null;
    const idx = typeParams.indexOf(ty.name);
    if (idx !== -1) {
      return wrapTypeArg(ty, this.typeKindToMiloType(typeArgs[idx]));
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
  monomorphizeFn(baseName: string, typeArgs: TypeKind[], sp?: Span) { return resolve.monomorphizeFn(this, baseName, typeArgs, sp); }
  monomorphizeMethod(key: string, typeArgs: TypeKind[], sp?: Span) { return resolve.monomorphizeMethod(this, key, typeArgs, sp); }
  inferMethodTypeArgs(key: string, expr: MethodCall, expected: TypeKind | null) { return resolve.inferMethodTypeArgs(this, key, expr, expected); }
  substituteBody(stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[], baseName?: string, mangledName?: string) { return resolve.substituteBody(this, stmts, typeParams, typeArgs, baseName, mangledName); }

  pushScope() { this.scopes.push(new Map()); }
  popScope() { return borrows.popScope(this); }

  beginLoop() { return borrows.beginLoop(this); }
  endLoop(condCanExit: boolean) { return borrows.endLoop(this, condCanExit); }

  joinPaths(reachables: boolean[]) { return borrows.joinPaths(this, reachables); }
  checkPath(preReachable: boolean, check: () => void) { return borrows.checkPath(this, preReachable, check); }

  // Index of the innermost scope belonging to the function currently being
  // checked. Shadowing is judged relative to this, not to the whole stack.
  fnScopeFloor = 0;
  // True while `forget(x)` moves its argument: ending ownership is the point, so a string
  // there moves for real and a later read is still a use after move (no share).
  forgetting = false;
  declare(name: string, info: VarInfo, span?: Span) { return borrows.declare(this, name, info, span); }

  pointerViewsIn(slot: Expr, out?: { source: Expr; call: string; line: number }[]) { return borrows.pointerViewsIn(this, slot, out); }
  bindPointerViews(holderInfo: VarInfo, value: Expr): void { return borrows.bindPointerViews(this, holderInfo, value); }
  holdPointerArgsIn(container: Expr, args: Expr[]): void { return borrows.holdPointerArgsIn(this, container, args); }
  scopeIndexOf(info: VarInfo) { return borrows.scopeIndexOf(this, info); }

  frameOwned(info: VarInfo) { return borrows.frameOwned(this, info); }
  errorIfPointerOutlivesSource(name: string, holder: VarInfo, value: Expr, sp?: Span): void { return borrows.errorIfPointerOutlivesSource(this, name, holder, value, sp); }
  errorIfReturnedPointerDangles(value: Expr, sp?: Span): void { return borrows.errorIfReturnedPointerDangles(this, value, sp); }

  carryPointerMarkers(value: Expr, to: VarInfo | null): void { return borrowMoves.carryPointerMarkers(this, value, to); }

  lookup(name: string) { return borrows.lookup(this, name); }

  flushSqlErrors(): void { return core.flushSqlErrors(this); }

  check(program: Program) { return core.check(this, program); }

  buildResult() { return core.buildResult(this); }

  checkCore(program: Program): void { return core.checkCore(this, program); }

  checkPasses(program: Program): void { return core.checkPasses(this, program); }

  finishChecks(): void { return core.finishChecks(this); }

  processDerives(program: Program) { return register.processDerives(this, program); }

  handWrittenClone = new Set<string>();

  // Templates in scope, by trait name. Filled per program in `processDerives` — a derive
  // reaches this compilation only by being declared in a file the resolver merged, which
  // is what makes a derive shippable in a package.
  deriveTemplates = new Map<string, import("./ast").DeriveTemplate>();
  // Structs whose `toJson`/`fromJsonNode` exist: derived, or hand-written by the
  // user. A nested field type must be in this set, otherwise the generated call
  // fails deep inside code the user never wrote.
  jsonCapableStructs = new Set<string>();
  // "Type.method" for every method the user actually wrote.
  jsonUserMethods = new Set<string>();

  // The impl generators (src/checker-derive.ts). What they may reach is this list.
  sql = new SqlChecker();
  globalDeclsByName = new Map<string, import("./ast").GlobalDecl>();
  // program.globals in dependency order (orderGlobalsByDependency); `globalsHome` is the array
  // applyRewrites writes it back into once the core check is done.
  globalsOrdered: GlobalDecl[] = [];
  // Closures the checker promoted to `move` (a callee keeps them, or they move a capture out).
  moveClosures = new Set<Expr>();
  globalsHome: GlobalDecl[] | null = null; // not private: only applyRewrites reads it
  globalConstCache = new Map<string, string | null>();
  fnDeclsByName = new Map<string, Function>();
  templateDepth = 0;
  derive = new DeriveSynth({
    rowPlans: this.sql.rowPlans,
    tableColumns: this.sql.tableColumns,
    noteTable: (n, sp) => this.sql.noteTable(n, sp),
    structs: this.structs,
    enums: this.enums,
    dropImpls: this.dropImpls,
    traitImpls: this.traitImpls,
    handWrittenClone: () => this.handWrittenClone,
    hasCloneMethod: (t) => {
      if (t.tag !== "struct" && t.tag !== "enum") return false;
      const m = this.resolveMethod(t.name, "clone");
      return !!m && m.sig.params.length === 1 && typeEq(m.sig.ret, t);
    },
    deriveTemplates: this.deriveTemplates,
    jsonCapableStructs: this.jsonCapableStructs,
    jsonUserMethods: this.jsonUserMethods,
    displayName: (n) => display(this._displayNames, n),
    error: (msg, span, hint) => this.error(msg, span, hint),
    show: (t) => this.show(t),
    resolve: (ty) => this.resolve(ty),
    isCopyType: (t) => this.isCopyType(t),
    typeImplementsTrait: (n, tr) => this.typeImplementsTrait(n, tr),
    optionInnerType: (t) => this.optionInnerType(t),
  });

  registerBuiltinOption() { return register.registerBuiltinOption(this); }

  registerBuiltinResult() { return register.registerBuiltinResult(this); }

  registerBuiltinTraits() { return register.registerBuiltinTraits(this); }

  checkImplMethodSignature(impl: import("./ast").ImplDecl, m: Function, trait: TraitInfo, traitMethod: TraitMethodInfo, implParams: { name: string; type: TypeKind }[], implRet: TypeKind): void { return register.checkImplMethodSignature(this, impl, m, trait, traitMethod, implParams, implRet); }

  substituteSelfInMiloType(ty: MiloType, concreteName: string, typeArgs?: MiloType[]): MiloType {
    if (ty.name === "Self") return { ...ty, name: concreteName, ...(typeArgs && { typeArgs }) };
    if (ty.typeArgs) return { ...ty, typeArgs: ty.typeArgs.map(a => this.substituteSelfInMiloType(a, concreteName, typeArgs)) };
    return ty;
  }

  // What `Self` spells inside `impl Trait for <typeName>`. A blanket impl over a builtin
  // container is registered under a mangled name (`Vec_i64`) that resolves to nothing;
  // its real type is the container instantiation recorded by instantiateContainerImpl.
  selfTypeOf(typeName: string): MiloType {
    return this.containerSelfType.get(typeName)
      ?? { name: typeName, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }

  isExternStructType(ty: TypeKind) { return register.isExternStructType(this, ty); }

  // The complete set of attributes the compiler acts on. Anything else used to be dropped
  // in silence, so a typo (`@clayout`, `@drive(Eq)`) looked like it worked while doing
  // nothing — the same silent-failure class @cLayout exists to close. Enums parse
  // attributes but nothing consumes them, so those are rejected rather than ignored.
  static readonly KNOWN_ATTRS = attributesFor("struct");

  checkCSig(f: Function, attr: Attribute): void { return register.checkCSig(this, f, attr); }

  // A `@cLayout`/`@cSig`/`@cValue` header argument: one path, or several separated by '|'
  // for a header C spells differently per platform (macOS 'OpenGL/gl3.h' vs
  // 'GL/glcorearb.h'). The guard TU takes the first that `__has_include` finds. A path may
  // be prefixed with '+'-separated feature macros the header needs before it declares
  // anything — 'GL_GLEXT_PROTOTYPES+GL/glcorearb.h'.
  static isCHeaderSpec(spec: string): boolean {
    const alts = spec.split("|");
    if (alts.length === 0) return false;
    return alts.every(alt => {
      const parts = alt.split("+");
      const path = parts.pop();
      return path !== undefined && TypeChecker.C_HEADER_RE.test(path)
        && parts.every(f => TypeChecker.C_IDENT_RE.test(f));
    });
  }

  checkCValue(g: GlobalDecl, attr: Attribute, type: TypeKind): void { return register.checkCValue(this, g, attr, type); }

  programView(program: Program) { return core.programView(this, program); }

  // The finished program for read-only tools that analyse it after `check` (src/harden.ts):
  // the same host and view the whole-program passes get, and nothing the caller can write back.
  analysisFacts(program: Program): { host: ProgramPassHost; view: ProgramView } {
    return { host: this.programPassHost(), view: this.programView(program) };
  }

  programPassHost() { return core.programPassHost(this); }

  lintArenaNeverFrees(program: Program): void { return core.lintArenaNeverFrees(this, program); }

  validateCopyAttr(s: StructDecl, attr: Attribute, program: Program) { return register.validateCopyAttr(this, s, attr, program); }

  validateCopyOnly(declName: string, attr: Attribute, typeParams: string[], span?: Span): void { return register.validateCopyOnly(this, declName, attr, typeParams, span); }

  validateOrderedArgs(declName: string, attr: Attribute, typeParams: string[], span?: Span): void { return calls.validateOrderedArgs(this, declName, attr, typeParams, span); }

  validateEnumCopyAttr(e: import("./ast").EnumDecl, attr: Attribute, program: Program) { return register.validateEnumCopyAttr(this, e, attr, program); }

  validateAttributes(declName: string, attrs: Attribute[] | undefined, target: "struct" | "enum"): void { return register.validateAttributes(this, declName, attrs, target); }

  // `@cLayout("struct stat", "sys/stat.h")` — the declared layout is checked against the
  // real header at build time. Both args are pasted into a generated C translation unit,
  // so they're constrained to a charset that can't escape the `#include <...>` or the
  // type position and inject arbitrary C.
  static readonly C_TYPE_RE = /^(struct |union |enum )?[A-Za-z_][A-Za-z0-9_]*$/;
  static readonly C_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  static readonly C_HEADER_RE = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*\.h$/;
  // `@link("SDL2")` / `@link("framework:OpenGL")`. Reaches a shell command line, so no
  // spaces, quotes, semicolons, backticks, or `$` — see the check in validateAttributes.
  static readonly LINK_NAME_RE = /^(framework:)?[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
  // A C function signature, pasted verbatim into a generated TU — so it's held to a
  // charset that can't close the assert and inject statements. Allows what real decls
  // need (`ssize_t f(int, void *, size_t)`, `struct tm *g(const time_t *)`, `void h(void)`,
  // and `...` for variadics like `int open(const char *, int, ...)`) and nothing else:
  // no quotes, no semicolons, no braces, no backslashes, no newlines.
  static readonly C_SIG_RE = /^[A-Za-z_][A-Za-z0-9_ .,*()[\]]*\)$/;

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
  static readonly VARIADIC_LIBC = new Map<string, number>([
    ["fcntl", 2], ["open", 2], ["openat", 3], ["ioctl", 2], ["syscall", 1],
    ["printf", 1], ["fprintf", 2], ["sprintf", 2], ["snprintf", 3], ["dprintf", 2],
    ["scanf", 1], ["fscanf", 2], ["sscanf", 2],
    ["execl", 2], ["execlp", 2], ["execle", 2],
  ]);

  checkVariadicExtern(fn: Function): void { return register.checkVariadicExtern(this, fn); }

  warnUnverifiedExternFn(fn: Function): void { return register.warnUnverifiedExternFn(this, fn); }

  warnUnverifiedExtern(s: StructDecl): void { return register.warnUnverifiedExtern(this, s); }

  validateFieldAttributes(s: StructDecl): void { return register.validateFieldAttributes(this, s); }

  checkCLayout(s: StructDecl, attr: Attribute): void { return register.checkCLayout(this, s, attr); }

  isValidExternStructField(ty: TypeKind) { return register.isValidExternStructField(this, ty); }

  thinFnField(isExtern: boolean | undefined, t: TypeKind) { return register.thinFnField(this, isExtern, t); }

  checkCFnStore(value: Expr, expected: TypeKind & { tag: "cfn" }, valType: TypeKind, where: string, sp?: Span) { return register.checkCFnStore(this, value, expected, valType, where, sp); }

  reportStrandedCFnReads(): void { return core.reportStrandedCFnReads(this); }

  isCReprFnSig(ty: { params: TypeKind[]; ret: TypeKind }) { return register.isCReprFnSig(this, ty); }

  externSigError(ty: TypeKind, role: "parameter" | "return type") { return register.externSigError(this, ty, role); }

  registerImpl(impl: import("./ast").ImplDecl, program: Program, implFnsToCheck: Function[]) { return register.registerImpl(this, impl, program, implFnsToCheck); }
  refuseImmutableReceiver(expr: MethodCall, sp: Span | undefined) { return traits.refuseImmutableReceiver(this, expr, sp); }
  thunkByValueFnValue(slot: Expr, element: TypeKind, arity: number): void { return traits.thunkByValueFnValue(this, slot, element, arity); }
  refuseByValueCallback(cb: TypeKind & { tag: "fn" }, elemRef: TypeKind, method: string, sp: Span | undefined) { return traits.refuseByValueCallback(this, cb, elemRef, method, sp); }
  bindStdVecMethod(expr: MethodCall, element: TypeKind, method: string, ret: TypeKind, opts?: { mutable?: boolean; typeArgs?: TypeKind[] }) { return traits.bindStdVecMethod(this, expr, element, method, ret, opts); }
  bindStdStringMethod(expr: MethodCall, method: string, ret: TypeKind, refArgs?: number[], mutable = false) { return traits.bindStdStringMethod(this, expr, method, ret, refArgs, mutable); }
  bindStdPrimMethod(expr: MethodCall, recv: string, method: string, ret: TypeKind, refArgs?: number[], mutable = false) { return traits.bindStdPrimMethod(this, expr, recv, method, ret, refArgs, mutable); }
  dispatchMangledMethod(expr: MethodCall, mangled: string, sp?: Span, borrowsForCallback = false) { return traits.dispatchMangledMethod(this, expr, mangled, sp, borrowsForCallback); }
  instantiateContainerImpl(container: string, args: TypeKind[], method: string) { return traits.instantiateContainerImpl(this, container, args, method); }
  reportWithheldContainerMethod(container: string, args: TypeKind[], objType: TypeKind, method: string, sp?: Span) { return traits.reportWithheldContainerMethod(this, container, args, objType, method, sp); }
  resolveMethod(objTypeName: string, methodName: string) { return traits.resolveMethod(this, objTypeName, methodName); }
  typeImplementsTrait(tName: string, traitName: string) { return traits.typeImplementsTrait(this, tName, traitName); }
  typeSatisfiesInterface(tName: string, ifaceName: string) { return traits.typeSatisfiesInterface(this, tName, ifaceName); }
  tryInterfaceCoercion(expr: Expr, sourceType: TypeKind, targetType: TypeKind) { return traits.tryInterfaceCoercion(this, expr, sourceType, targetType); }
  isSend(ty: TypeKind) { return traits.isSend(this, ty); }
  whyNotSend(ty: TypeKind) { return traits.whyNotSend(this, ty); }
  isSync(ty: TypeKind) { return traits.isSync(this, ty); }
  isViewReturn(ret: TypeKind): boolean { return traits.isViewReturn(ret); }

  hasSelfReceiver(fn: Function): boolean {
    return fn.params.length > 0 && fn.params[0].name === "self";
  }
  freezeViewSource(obj: Expr, sp?: Span) { return traits.freezeViewSource(this, obj, sp); }
  stringViewIterMode(iterable: Expr) { return flow.stringViewIterMode(this, iterable); }
  peekPathType(e: Expr) { return flow.peekPathType(this, e); }
  checkStringViewForIn(stmt: ForInStmt, mode: "lines" | "split", fnRetType: TypeKind) { return flow.checkStringViewForIn(this, stmt, mode, fnRetType); }

  // The call site freezes the receiver and nothing else, so a returned view must point
  // into storage reachable from `self`. A view of a method-local dies at the return; a
  // view of another `&` param outlives a freeze that was never taken for it.
  // The receiver field chain a view-returning method's result points into: `["a"]` for
  // `return self.a[0..n]`, `[]` when the view is of the whole receiver. Absent means
  // "unknown" and the call site falls back to freezing the entire receiver — which is
  // what happens for a return nested inside control flow, or several returns disagreeing.
  viewReturnFields = new Map<string, string[]>();
  recordViewProvenance(fn: Function) { return flow.recordViewProvenance(this, fn); }
  ownedReturnType(ret: TypeKind) { return flow.ownedReturnType(this, ret); }
  returnedRefKind(value: Expr, ret: TypeKind) { return flow.returnedRefKind(this, value, ret); }
  shortExprText(e: Expr): string | null { return flow.shortExprText(e); }
  danglingRoot(root: string, fn: Function) { return flow.danglingRoot(this, root, fn); }
  checkViewProvenance(value: Expr, sp: Span | undefined, ret: TypeKind) { return flow.checkViewProvenance(this, value, sp, ret); }

  // A method's Function carries its mangled name (`Buf$items`); diagnostics show the source name.
  shownFnName(fn: Function): string {
    return fn.sourceName ?? fn.name.slice(fn.name.lastIndexOf("$") + 1);
  }
  errorIfRefReturn(fn: Function, ret: TypeKind) { return flow.errorIfRefReturn(this, fn, ret); }

  checkFunction(fn: Function) { return stmts.checkFunction(this, fn); }

  checkFunctionBody(fn: Function) { return stmts.checkFunctionBody(this, fn); }

  checkStmt(stmt: Stmt, fnRetType: TypeKind, valueTail?: { expected: TypeKind | null } | null) { return stmts.checkStmt(this, stmt, fnRetType, valueTail); }

  checkBindingInit(stmt: Extract<Stmt, { kind: "LetDecl" | "VarDecl" }>) { return stmts.checkBindingInit(this, stmt); }

  checkStmtBody(stmt: Stmt, fnRetType: TypeKind, valueTail: { expected: TypeKind | null } | null) { return stmts.checkStmtBody(this, stmt, fnRetType, valueTail); }

  optionInnerType(paramType: TypeKind) { return stmts.optionInnerType(this, paramType); }

  optionUnwrapHint(expected: TypeKind, actual: TypeKind) { return calls.optionUnwrapHint(this, expected, actual); }

  // auto-deref: &T → T, &mut T → T
  deref(t: TypeKind): TypeKind {
    if (t.tag === "ref") return t.inner;
    return t;
  }

  reportUninferredVecs(): void { return core.reportUninferredVecs(this); }

  tryDeferVecInfer(value: Expr) { return stmts.tryDeferVecInfer(this, value); }

  // The placeholder element is an identity-keyed object resolved in place by the first push, which the
  // generated Milo cannot express; kept apart so that only a program with an unannotated Vec.new() reaches it.
  isLiveInfer(t: TypeKind): t is TypeKind & { tag: "unknown"; inferId: number } {
    return t.tag === "unknown" && t.inferId !== undefined && this.inferred[t.inferId] === undefined;
  }

  resolveInfer(t: TypeKind) { return calls.resolveInfer(this, t); }

  zonkStored(): void { return calls.zonkStored(this); }

  makeDeferredVec(value: import("./ast").EnumLit) { return stmts.makeDeferredVec(this, value); }

  orderGlobalsByDependency(program: Program) { return register.orderGlobalsByDependency(this, program); }
  bodyAlwaysReturns(body: Stmt[]) { return flow.bodyAlwaysReturns(this, body); }

  // A `requires` on a function whose body enters `unsafe` is the last guard before C,
  // and the default `-O2` build drops contract checks. Unless the body also checks the
  // same values itself (an `if` or `assert` naming every parameter the clause names),
  // an out-of-contract call reaches C unguarded: `std/crypto` read 32 bytes from an
  // 8-byte key and `std/pool` wrote past a 2-byte block this way. The body check is
  // matched by the names it mentions, not by negating the contract: `requires size >= 8`
  // is satisfied by `if size < 8 { return Err }` as much as by `assert(size >= 8)`.
  ffiContractReported = new Set<string>();
  lintUncheckedFfiContract(fn: Function) { return flow.lintUncheckedFfiContract(this, fn); }
  bodyEntersUnsafe(node: unknown) { return flow.bodyEntersUnsafe(this, node); }
  collectGuardNames(node: unknown, params: Set<string>, out: Set<string>[]) { return flow.collectGuardNames(this, node, params, out); }
  collectIdents(node: unknown, params: Set<string>, out: Set<string>) { return flow.collectIdents(this, node, params, out); }
  bodyNeverFallsOff(body: Stmt[]) { return flow.bodyNeverFallsOff(this, body); }
  bodyBreaksOut(node: unknown) { return flow.bodyBreaksOut(this, node); }

  // One report per source function: a generic is checked once per instantiation, and
  // every instance falls off at the same place.
  fallOffReported = new Set<string>();
  errorIfFallsOff(what: string, body: Stmt[], retType: TypeKind, span?: Span) { return flow.errorIfFallsOff(this, what, body, retType, span); }

  // Matches already reported as non-exhaustive, keyed by their arm list. "Every arm
  // returns" only implies the match diverges when the arms cover the subject, so
  // reporting unreachable code after one of these would pile a bogus second error
  // onto a file that already has the real one.
  nonExhaustiveMatches = new WeakSet<MatchArm[]>();

  builtinFnNames = new Set<string>();
  // Builtins that read, write or call through a raw pointer argument (`_cstrToString`,
  // `_loadU8`, the atomics). Keyed by signature object, so a user fn that reuses one of
  // the names is not caught by it: registering a user fn removes its name.
  rawPtrBuiltinNames = new Set<string>();
  // Read by tests/stdBuiltinNames.test.ts: a std pub fn with one of these names would
  // replace the builtin for the whole program.
  get builtinNames(): ReadonlySet<string> { return this.builtinFnNames; }

  // Every Stmt kind, so the scan below can recognize a statement list by shape.
  static readonly STMT_KINDS: ReadonlySet<string> = new Set([
    "LetDecl", "VarDecl", "Assign", "Return", "IfStmt", "WhileStmt", "ExprStmt",
    "MatchStmt", "BreakStmt", "ContinueStmt", "IfLetStmt", "IfChainStmt", "LetElseStmt",
    "UnsafeBlock", "ForInStmt",
  ]);
  scanUnreachable(node: unknown) { return flow.scanUnreachable(this, node); }

  allCopyEnumCache = new Map<string, boolean>();
  isAllCopyEnum(name: string) { return flow.isAllCopyEnum(this, name); }

  allCopyCache = new Map<string, boolean>();
  isAllCopyStruct(name: string) { return flow.isAllCopyStruct(this, name); }
  inferGenericStaticTypeArgs(expr: EnumLit, expected: TypeKind | null) { return resolve.inferGenericStaticTypeArgs(this, expr, expected); }
  checkGenericStaticMethodCall(expr: EnumLit, key: string, sp: Span | undefined, expected: TypeKind | null) { return resolve.checkGenericStaticMethodCall(this, expr, key, sp, expected); }
  inferTypeParamsFromHint(retType: MiloType, hint: TypeKind, typeParams: string[], typeMap: Map<string, TypeKind>) { return resolve.inferTypeParamsFromHint(this, retType, hint, typeParams, typeMap); }
  armConsumesSubject(pattern: Pattern, enumInfo: { variants: Map<string, { fields: TypeKind[] }> }, subjType: TypeKind) { return borrowMoves.armConsumesSubject(this, pattern, enumInfo, subjType); }
  extractorKeys(arg: Expr) { return borrowMoves.extractorKeys(this, arg); }
  extractorReturns(arg: Expr): { values: Expr[]; rooted: (e: Expr) => boolean } { return borrowMoves.extractorReturns(arg); }
  consumeForwardedPayload(receiver: Expr, forwarded: TypeKind) { return borrowMoves.consumeForwardedPayload(this, receiver, forwarded); }
  moveTargets(expr: Expr) { return borrowMoves.moveTargets(this, expr); }
  tailTargets(bodies: Stmt[][]) { return borrowMoves.tailTargets(this, bodies); }
  autoBorrow(slot: Expr, how: { mutable: boolean }) { return borrowMoves.autoBorrow(this, slot, how); }
  consumeMixedResourceFork(slot: Expr) { return borrowMoves.consumeMixedResourceFork(this, slot); }
  forkHasOwnedTail(e: Expr) { return borrowMoves.forkHasOwnedTail(this, e); }
  tailIsOwnedValue(t: Expr, bound: Set<string>) { return borrowMoves.tailIsOwnedValue(this, t, bound); }
  tryMove(slot: Expr) { return borrowMoves.tryMove(this, slot); }
  tryMoveLeaf(expr: Expr) { return borrowMoves.tryMoveLeaf(this, expr); }
  tryMoveOutOfHeap(expr: UnaryOp) { return borrowMoves.tryMoveOutOfHeap(this, expr); }
  errorMoveOutOfGlobal(expr: Expr, what: string, global: string): void { return borrowMoves.errorMoveOutOfGlobal(this, expr, what, global); }
  globalRootOf(expr: Expr) { return borrowMoves.globalRootOf(this, expr); }
  borrowBaseOfPlace(p: { root: string; steps: PlaceStep[] }) { return borrowMoves.borrowBaseOfPlace(this, p); }
  borrowBasePath(expr: Expr) { return borrowMoves.borrowBasePath(this, expr); }
  fieldIsInElement(expr: FieldAccess) { return borrowMoves.fieldIsInElement(this, expr); }
  errorIfFieldMovedOutOfElement(expr: FieldAccess) { return borrowMoves.errorIfFieldMovedOutOfElement(this, expr); }
  indexedContainerOf(e: Expr): Expr | null { return borrowMoves.indexedContainerOf(e); }
  markPlaceRead(expr: Expr) { return borrowMoves.markPlaceRead(this, expr); }
  resolveAssignTarget(slot: Expr) { return borrowMoves.resolveAssignTarget(this, slot); }
  markCaptureMutated(expr: Expr) { return borrowMoves.markCaptureMutated(this, expr); }
  eachCaptureOf(name: string, fn: (cap: CaptureInfo) => void) { return borrowMoves.eachCaptureOf(this, name, fn); }

  isConstGlobalInit(slot: Expr) { return core.isConstGlobalInit(this, slot); }

  isConstFloatExpr(e: Expr) { return exprs.isConstFloatExpr(this, e); }

  retypeConstFloat(e: Expr, t: TypeKind) { return exprs.retypeConstFloat(this, e, t); }

  isConstIntExpr(e: Expr) { return exprs.isConstIntExpr(this, e); }

  retypeConstInt(e: Expr, target: TypeKind) { return exprs.retypeConstInt(this, e, target); }
  checkCallSiteExclusivity(args: Expr[], sp: Span | undefined, movesExclusive = true) { return borrowMoves.checkCallSiteExclusivity(this, args, sp, movesExclusive); }
  reportLaterArgWrites(uses: ArgUse[], args: Expr[], sp: Span | undefined) { return borrowMoves.reportLaterArgWrites(this, uses, args, sp); }
  closureArgCaptures(slot: Expr) { return borrowMoves.closureArgCaptures(this, slot); }
  capturesOfClosures(sources: Expr[]) { return borrowMoves.capturesOfClosures(this, sources); }
  nestedWrites(arg: Expr) { return borrowMoves.nestedWrites(this, arg); }
  recordClosureCallWrites(call: Expr, info: VarInfo) { return borrowMoves.recordClosureCallWrites(this, call, info); }
  noteClosureSources(info: VarInfo, value: Expr | undefined) { return borrowMoves.noteClosureSources(this, info, value); }
  capturePlace(cap: CaptureInfo): { root: unknown; name: string; fields: string[] | null; steps: string[] } { return borrowMoves.capturePlace(cap); }
  constSliceRange(e: Expr): { lo: bigint; hi: bigint } | null { return borrowMoves.constSliceRange(e); }
  borrowModeOf(arg: Expr) { return borrowMoves.borrowModeOf(this, arg); }
  placesOf(slot: Expr) { return borrows.placesOf(this, slot); }
  checkMutForInSource(stmt: ForInStmt, rawType: TypeKind, sp?: Span) { return borrows.checkMutForInSource(this, stmt, rawType, sp); }
  syntacticPlace(e: Expr, onSub?: (e: Expr) => void): { root: string; fields: string[]; text: string } | null { return borrows.syntacticPlace(e, onSub); }
  noteForInBind(stmt: ForInStmt) { return borrows.noteForInBind(this, stmt); }
  isPlaceIterable(slot: Expr) { return borrows.isPlaceIterable(this, slot); }

  rootNameOf(e: Expr) { return borrows.rootNameOf(this, e); }
  stepInto(base: Expr, step: PlaceStep) { return borrows.stepInto(this, base, step); }
  tailPlaces(bodies: Stmt[][]) { return borrows.tailPlaces(this, bodies); }
  soloPath(e: Expr) { return borrows.soloPath(this, e); }
  staticFieldPath(e: Expr) { return borrows.staticFieldPath(this, e); }
  dropTypeInPath(e: Expr) { return borrows.dropTypeInPath(this, e); }
  shareMovedExpr(e: Expr) { return borrows.shareMovedExpr(this, e); }
  shareStringArg(arg: Expr) { return borrows.shareStringArg(this, arg); }
  accessSteps(e: Expr) { return borrows.accessSteps(this, e); }
  aliasesByContainment(a: string[], b: string[]): boolean { return borrows.aliasesByContainment(a, b); }
  accessPath(e: Expr) { return borrows.accessPath(this, e); }
  exclusivityPlace(e: Expr) { return borrows.exclusivityPlace(this, e); }
  isMovedPlaceArg(arg: Expr) { return borrows.isMovedPlaceArg(this, arg); }
  noteRefIntoSteps(info: VarInfo, subject: Expr, path: PatternLeaf["steps"]) { return borrows.noteRefIntoSteps(this, info, subject, path); }
  noteRefInto(info: VarInfo, subject: Expr, variant: string, index: number) { return borrows.noteRefInto(this, info, subject, variant, index); }
  isRootMutable(expr: Expr) { return borrows.isRootMutable(this, expr); }
  writtenPlaceMutable(target: Expr & { object: Expr }) { return borrows.writtenPlaceMutable(this, target); }
  rootMutable(slot: Expr) { return borrows.rootMutable(this, slot); }

  markWritten(obj: Expr) { return borrows.markWritten(this, obj); }
  checkPlaceArgWrite(place: Expr) { return borrows.checkPlaceArgWrite(this, place); }
  takeExplicitMutArgs(args: Expr[], callee: string, paramAt: (i: number) => { name: string; mut: boolean; show: () => string } | undefined) { return borrows.takeExplicitMutArgs(this, args, callee, paramAt); }

  sigParamAt(p: { name: string; type: TypeKind } | undefined) {
    return p ? { name: p.name, mut: p.type.tag === "ref" && p.type.mutable, show: () => this.show(p.type) } : undefined;
  }
  typeParamAt(t: TypeKind | undefined, i: number) {
    return t ? { name: `#${i + 1}`, mut: t.tag === "ref" && t.mutable, show: () => this.show(t) } : undefined;
  }
  noteImplicitMut(arg: Expr, callee: string, param: string) { return borrows.noteImplicitMut(this, arg, callee, param); }
  setAutoBorrowChecked(arg: Expr, mutable: boolean, sp?: Span) { return borrows.setAutoBorrowChecked(this, arg, mutable, sp); }
  unwritableMutTarget(expr: Expr) { return borrows.unwritableMutTarget(this, expr); }
  describeExpr(slot: Expr) { return borrows.describeExpr(this, slot); }

  // Bare `Some(x)` / `None` / `Ok(v)` / `Err(e)` are aliases for the Option/Result
  // variants. The parser cannot tell them from a call or a variable (it has no scope), so
  // the checker rewrites the node IN PLACE into the same `EnumLit` the qualified spelling
  // parses to, at the first sight of it and before any hint is consumed: `let o: Option<i64>
  // = Some(3)` must reach the EnumLit-with-hint path, not the unwrapped-Option one. Every
  // later pass (lower, codegen, verify, LSP) therefore sees only the qualified
  // shape. A user fn, variable, struct, enum or alias of the same name wins, so existing
  // programs that define their own `Some` are untouched; `bindElidedPattern` is the same
  // rule for patterns.
  // A Map, not an object literal: indexing `{...}[name]` with a call named `toString` or
  // `constructor` found Object.prototype's member and rewrote the call into an EnumLit
  // whose enumName was a function (a crash in the suggester; fuzzFrontend found it).
  static readonly PRELUDE_VARIANTS = new Map<string, string>([["Some", "Option"], ["None", "Option"], ["Ok", "Result"], ["Err", "Result"]]);

  canonicalizePreludeVariant(expr: Expr) { return literals.canonicalizePreludeVariant(this, expr); }

  preludeVariantNode(expr: Expr) { return literals.preludeVariantNode(this, expr); }

  nameIsDefined(name: string) { return exprs.nameIsDefined(this, name); }

  spelledBuiltinStatic(expr: EnumLit) { return calls.spelledBuiltinStatic(this, expr); }

  hintFor(expr: Expr, expected: TypeKind): TypeKind {
    if (expr.kind === "EnumLit" || expr.kind === "IfExpr" || expr.kind === "MatchExpr") return expected;
    return this.optionInnerType(expected) ?? expected;
  }

  checkExpr(node: Expr, expected?: TypeKind | null) { return exprs.checkExpr(this, node, expected); }

  setType(expr: Expr, type: TypeKind): TypeKind {
    this.exprTypes.set(expr, type);
    return type;
  }

  checkExprKind(expr: Expr, expected: TypeKind | null) { return exprs.checkExprKind(this, expr, expected); }

  checkIdentExpr(expr: Ident) { return exprs.checkIdentExpr(this, expr); }

  checkBinOpExpr(expr: BinOp) { return exprs.checkBinOpExpr(this, expr); }

  checkNatLess(expr: Call) { return calls.checkNatLess(this, expr); }

  checkVecFold(expr: MethodCall, element: TypeKind, sp: Span | undefined) { return calls.checkVecFold(this, expr, element, sp); }

  // A Vec of a ranged int searches as a Vec of the plain int: the needle may be any value
  // of that width (`Vec<i32(0..9)>.contains(12)` is false, not an error), as the builtin
  // took it. Same layout, so the plain instantiation reads the ranged Vec unchanged.
  plainSearchElement(el: TypeKind, method: string): string | null {
    if (el.tag !== "int" || (el.min === undefined && el.max === undefined)) return null;
    return this.instantiateContainerImpl("Vec", [{ tag: "int", bits: el.bits, signed: el.signed }], method)?.mangled ?? null;
  }

  vecSearchComparable(el: TypeKind, method: string, alt: string, sp: Span | undefined): boolean {
    if (el.tag === "int" || el.tag === "float" || el.tag === "string" || el.tag === "bool" || el.tag === "unknown") return true;
    this.error(`'${method}' requires a Vec of a comparable type (int, float, string, bool), got Vec<${this.show(el)}>`, sp,
      `use '${alt}' with a predicate instead, e.g. v.${alt}((e) => e == x) for a type that implements Eq`);
    return false;
  }

  noteSqlCall(callee: string, attrs: Attribute[], params: { name: string }[], args: Expr[], row: string | null, ret: TypeKind, sp: Span | undefined): void { return calls.noteSqlCall(this, callee, attrs, params, args, row, ret, sp); }

  isOwnSqlParam(a: Expr) { return calls.isOwnSqlParam(this, a); }

  sqlConstOf(e: Expr) { return calls.sqlConstOf(this, e); }

  sqlResolver(ident: (name: string) => string | null): ConstResolver {
    return { node: (e) => rewritten(this.rewrites, e), ident, staticCall: this.sql.staticConst, call: (fn, args) => this.templateCall(fn, args) };
  }

  templateCall(name: string, args: string[]) { return calls.templateCall(this, name, args); }

  globalConst(name: string) { return calls.globalConst(this, name); }

  checkUnaryOpExpr(expr: UnaryOp, expected: TypeKind | null) { return exprs.checkUnaryOpExpr(this, expr, expected); }

  lintBorrowThatClones(expr: Call): void { return calls.lintBorrowThatClones(this, expr); }

  checkStrIntrinsic(expr: Call) { return calls.checkStrIntrinsic(this, expr); }

  shadowedByUserFn(name: string): boolean {
    return userFnShadowsBuiltin(name, { functions: this.functions, genericFns: this.genericFns });
  }

  checkCallExpr(expr: Call, expected: TypeKind | null) { return calls.checkCallExpr(this, expr, expected); }

  registerFieldDefaults(program: Program) { return register.registerFieldDefaults(this, program); }

  defaultFormError(e: Expr, typeParams: Set<string>) { return register.defaultFormError(this, e, typeParams); }

  checkFieldDefaultTypes(program: Program) { return register.checkFieldDefaultTypes(this, program); }

  checkDefaultGlobals(e: Expr, field: string) { return register.checkDefaultGlobals(this, e, field); }

  fillFieldDefaults(expr: StructLit, declName: string) { return literals.fillFieldDefaults(this, expr, declName); }

  shadowedDefaultName(e: Expr) { return literals.shadowedDefaultName(this, e); }

  checkStructLitAsInstance(expr: StructLit, hint: Extract<TypeKind, { tag: "struct" }>, baseType?: TypeKind) { return literals.checkStructLitAsInstance(this, expr, hint, baseType); }

  checkStructLitBase(expr: StructLit, result: Extract<TypeKind, { tag: "struct" }>, baseType?: TypeKind): void { return literals.checkStructLitBase(this, expr, result, baseType); }

  checkStructLitExpr(expr: StructLit) { return literals.checkStructLitExpr(this, expr); }

  checkFieldPrivacy(structName: string, field: string, refSpan?: Span) { return literals.checkFieldPrivacy(this, structName, field, refSpan); }

  privateFieldOwner(structName: string, field: string, refSpan?: Span) { return literals.privateFieldOwner(this, structName, field, refSpan); }

  checkStructLitFieldNames(expr: StructLit, privacyName: string, declared: string[]) { return literals.checkStructLitFieldNames(this, expr, privacyName, declared); }

  absFileCache = new Map<string, string>();
  absFile(file: string) { return exprs.absFile(this, file); }

  checkFieldAccessExpr(expr: FieldAccess) { return exprs.checkFieldAccessExpr(this, expr); }

  checkArrayLitExpr(expr: ArrayLit) { return exprs.checkArrayLitExpr(this, expr); }

  checkArrayRepeatExpr(expr: ArrayRepeat) { return exprs.checkArrayRepeatExpr(this, expr); }

  checkIndexAccessExpr(expr: IndexAccess) { return exprs.checkIndexAccessExpr(this, expr); }

  // Type-check one call argument against its parameter and apply the argument coercions:
  // a ref passes through (a slice view materialized for a `&[T]` ABI), a value
  // auto-borrows for a `&T`, Vec or fixed array to slice, T to Option<T>, string or array
  // to `*u8`/`*T`, a flexible int literal binding, an interface. Every call form (free,
  // static, method, generic method, interface, fn field, closure) goes through here, so a
  // coercion one of them accepted can no longer be "expected string, got &string" in
  // another. Moves are the caller's: call forms differ in when they happen.
  // A callback slot typed `(&T, ...) => R` with T Copy also takes `(T, ...) => R`: for a
  // Copy T a read through the borrow is the value, so the callback is adapted, not
  // refused. A closure literal has the parameter retyped to `&T`; a named fn is wrapped
  // in a thunk closure `(p: &T) => f(p)`. Rewritten in the AST before checking, so the
  // checker, lowering and codegen see one ordinary closure. A non-Copy T is left alone
  // and refused as before: taking it by value would move it out of the container.
  coerceCopyCallback(arg: Expr, paramType: TypeKind): void {
    const want = paramType.tag === "ref" ? paramType.inner : paramType;
    if (want.tag === "fn") this.coerceCopyCallbackTo(arg, want.params);
  }

  copyRefInner(t: TypeKind): TypeKind | null {
    if (t.tag === "ref" && !t.mutable && this.isCopyType(t.inner)) return t.inner;
    return null;
  }

  coerceCopyCallbackTo(slot: Expr, wantParams: TypeKind[]): void { return calls.coerceCopyCallbackTo(this, slot, wantParams); }

  callbackThunk(fnName: string, paramTypes: TypeKind[], ret: TypeKind, span: Span | undefined) { return calls.callbackThunk(this, fnName, paramTypes, ret, span); }

  checkCallArg(arg: Expr, paramType: TypeKind, sp: Span | undefined, mismatch: (argType: TypeKind) => void) { return calls.checkCallArg(this, arg, paramType, sp, mismatch); }

  matchCallArg(slot: Expr, argType: TypeKind, paramType: TypeKind, sp: Span | undefined, mismatch: (argType: TypeKind) => void) { return calls.matchCallArg(this, slot, argType, paramType, sp, mismatch); }

  argIsBorrowed(slot: Expr, paramType: TypeKind) { return borrows.argIsBorrowed(this, slot, paramType); }

  lendsOwningClosure(arg: Expr, paramType: TypeKind | undefined) { return borrows.lendsOwningClosure(this, arg, paramType); }

  decaysToPtr(arg: Expr, paramType: TypeKind) { return calls.decaysToPtr(this, arg, paramType); }

  checkMethodArg(expr: MethodCall, i: number, paramType: TypeKind, sp: Span | undefined, special?: (argType: TypeKind) => boolean) { return calls.checkMethodArg(this, expr, i, paramType, sp, special); }

  checkStaticCallArgs(sig: { params: { name: string; type: TypeKind }[] }, expr: any, sp: Span | undefined) { return calls.checkStaticCallArgs(this, sig, expr, sp); }

  checkEnumLitExpr(expr: EnumLit, expected: TypeKind | null) { return literals.checkEnumLitExpr(this, expr, expected); }

  checkUnwrapExpr(expr: Unwrap) { return exprs.checkUnwrapExpr(this, expr); }

  checkMapIntrinsic(expr: Call) { return calls.checkMapIntrinsic(this, expr); }

  checkMapTableIntrinsic(expr: Call) { return calls.checkMapTableIntrinsic(this, expr); }

  bindMapConstructor(expr: EnumLit, t: TypeKind): void { return calls.bindMapConstructor(this, expr, t); }

  bindVecConstructor(expr: EnumLit, t: TypeKind): void { return calls.bindVecConstructor(this, expr, t); }

  checkMapCopyOut(expr: Call) { return calls.checkMapCopyOut(this, expr); }

  checkPropagateExpr(expr: Propagate) { return exprs.checkPropagateExpr(this, expr); }

  checkDefaultValueExpr(expr: DefaultValue) { return literals.checkDefaultValueExpr(this, expr); }

  checkCastExprExpr(expr: CastExpr, expected: TypeKind | null) { return exprs.checkCastExprExpr(this, expr, expected); }

  // `(0 as i64)` where an i64 is expected: the literal would get that type from the
  // context anyway (checkExpr's hint path). Two shapes must not fire, because there the
  // cast is what fixes the type: a cast first checked with no expected type (generic
  // inference types the arguments bare, then again against the signature it inferred
  // FROM them), and a cast in a generic instance's body (the target may have been `T`).
  castsCheckedBare = new WeakSet<Expr>();
  // Casts and `forget` calls (and std/vec's `_vecForget` alias, which the forget check
  // also handles) cloned into a generic instance's body. Copy-ness and the
  // cast target are facts about the instance, not the generic source: `forget(v)` on a
  // `T` is required in the source even when one instantiation makes T an i64.
  instanceNodes = new WeakSet<object>();
  // MILO_REPORT_STRING_CLONES=1: every `.clone()` on a string outside a generic instance,
  // printed once checking is done (scripts/strip-string-clones.ts deletes them). One that
  // is itself mutated (an explicit `&mut` argument, a mutating receiver) is left out: its
  // copy is what keeps the write off the original. So is one on a `&string` receiver.
  reportStringClones = (process.env.MILO_REPORT_STRING_CLONES ?? "") !== "";
  stringCloneCalls: MethodCall[] = [];

  printStringClones() { return core.printStringClones(this); }
  lintRedundantCast(expr: CastExpr, toType: TypeKind, expected: TypeKind | null) { return exprs.lintRedundantCast(this, expr, toType, expected); }

  isMoveClosure(e: Expr) { return exprs.isMoveClosure(this, e); }

  autoMoveClosureArg(slot: Expr, param: TypeKind | undefined, keepsWriteBack: (c: CaptureInfo) => boolean, always?: boolean): void { return calls.autoMoveClosureArg(this, slot, param, keepsWriteBack, always); }

  errorOnRefCaptures(expr: Expr, captures: CaptureInfo[], why: string) { return exprs.errorOnRefCaptures(this, expr, captures, why); }

  checkClosureExpr(expr: ClosureExpr, expected: TypeKind | null) { return exprs.checkClosureExpr(this, expr, expected); }

  checkMethodCallExpr(call: MethodCall, expected: TypeKind | null) { return methodCalls.checkMethodCallExpr(this, call, expected); }

  rewriteJsonIndex(expr: IndexAccess, objName: string) { return exprs.rewriteJsonIndex(this, expr, objName); }

  rewriteJsonPathStep(expr: MethodCall, objType: TypeKind, chainRoot: Expr | undefined, expected: TypeKind | null) { return calls.rewriteJsonPathStep(this, expr, objType, chainRoot, expected); }

  isJsonRootPlace(e: Expr) { return exprs.isJsonRootPlace(this, e); }

  checkMethodCallExprInner(call: MethodCall, expected: TypeKind | null) { return methodCalls.checkMethodCallExprInner(this, call, expected); }

  checkIsExprExpr(expr: IsExpr) { return exprs.checkIsExprExpr(this, expr); }

  checkIfExprExpr(expr: IfExpr, expected: TypeKind | null) { return exprs.checkIfExprExpr(this, expr, expected); }

  checkMatchExprExpr(expr: MatchExpr, expected: TypeKind | null) { return matches.checkMatchExprExpr(this, expr, expected); }

  ownedInspectOnly(subject: Expr, subjType: TypeKind, patterns: (Pattern | undefined)[]) { return borrows.ownedInspectOnly(this, subject, subjType, patterns); }

  refuseDropEnumMoveOut(subject: Expr, subjType: TypeKind, subjBorrows: boolean, patterns: (Pattern | undefined)[]): void { return borrows.refuseDropEnumMoveOut(this, subject, subjType, subjBorrows, patterns); }

  bindsOnlyCopy(subjType: TypeKind, patterns: (Pattern | undefined)[]) { return matches.bindsOnlyCopy(this, subjType, patterns); }

  checkNullRefUnwrap(stmt: import("./ast").LetElseStmt, name: string, fnRetType: TypeKind, sp?: Span): void { return matches.checkNullRefUnwrap(this, stmt, name, fnRetType, sp); }

  isBorrowedMatchPlace(subject: Expr) { return borrows.isBorrowedMatchPlace(this, subject); }

  bindLetClause(pattern: Pattern, subject: Expr, subjType: TypeKind, subjBorrows: boolean, subjIsMut: boolean): void { return stmts.bindLetClause(this, pattern, subject, subjType, subjBorrows, subjIsMut); }

  enumSubjectBorrow(subject: Expr, rawSubjType: TypeKind, patterns?: (Pattern | undefined)[]) { return borrows.enumSubjectBorrow(this, subject, rawSubjType, patterns); }

  errorIfCopyBind(recv: Expr, method: string, sp?: Span): void { return calls.errorIfCopyBind(this, recv, method, sp); }

  elementFits(elemType: TypeKind, want: TypeKind, elem: Expr) { return exprs.elementFits(this, elemType, want, elem); }

  checkCallbackSig(actual: TypeKind, want: TypeKind, method: string, sp?: Span): void { return calls.checkCallbackSig(this, actual, want, method, sp); }

  // The ONE Copy judgment for the checker. Every "may this be read by value" question
  // goes through here so a struct/enum is Copy at every site or at none: `unwrapOr` once
  // called `isCopy` without the struct/enum callbacks and rejected a `Pt {x, y}` that
  // `let e = d` had just copied (design pass 2026-09, F1).
  isCopyType(t: TypeKind): boolean {
    return isCopy(t, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n));
  }

  isCopyBind(bt: TypeKind, subjectIsPlace: boolean) { return matches.isCopyBind(this, bt, subjectIsPlace); }

  isPlaceExpr(e: Expr) { return borrows.isPlaceExpr(this, e); }

  payloadBindType(bt: TypeKind, subjBorrows: boolean, subjIsMut?: boolean) { return matches.payloadBindType(this, bt, subjBorrows, subjIsMut); }

  // Shared checking for `match` in both statement and expression position:
  // pattern validation, payload binding (borrow vs by-value), move merging, and
  // exhaustiveness. Returns each arm's block value type in arm order (used by
  // MatchExpr to unify; MatchStmt ignores it).
  // `Some(x)` written without the `Option.` prefix: fill the enum name in from the
  // subject's type. Only ever fills a BLANK name, so an explicitly written prefix
  // that disagrees with the subject still produces its mismatch error.
  //
  // Recurses into a nested pattern the same way, from each payload's type. It also settles
  // the one thing the parser cannot: a bare name in a payload position (`Some(None)`) is a
  // payload-free variant when the payload's enum has a variant of that name, and a binding
  // otherwise. Rust resolves the same spelling the same way.
  // Returns the pattern to use from here on: `pattern` itself when nothing needed filling, else its
  // replacement (recorded in `patternRewrites`; the tree is not written).
  rewrittenPat(p: Pattern): Pattern { return rewrittenPattern(this.patternRewrites, p); }

  bindElidedPattern(pattern: Pattern, subjType: TypeKind) { return stmts.bindElidedPattern(this, pattern, subjType); }

  elidedPatternFor(pattern: Pattern, subjType: TypeKind) { return stmts.elidedPatternFor(this, pattern, subjType); }

  patternLeaves(p: Pattern, et: TypeKind, report: boolean, steps?: PatternLeaf["steps"]) { return stmts.patternLeaves(this, p, et, report, steps); }

  declarePatternLeaves(pattern: Pattern, leaves: PatternLeaf[], subject: Expr, subjBorrows: boolean, subjIsMut: boolean): void { return stmts.declarePatternLeaves(this, pattern, leaves, subject, subjBorrows, subjIsMut); }

  patternSpace() { return matches.patternSpace(this); }

  toSpacePat(p: Pattern, ty: TypeKind) { return matches.toSpacePat(this, p, ty); }

  showPattern(p: Pattern) { return matches.showPattern(this, p); }

  checkNestedCoverage(arms: MatchArm[], subjType: TypeKind & { tag: "enum" }, sp: Span | undefined): void { return matches.checkNestedCoverage(this, arms, subjType, sp); }

  lintManualOptionDefault(arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void { return matches.lintManualOptionDefault(this, arms, subjType, sp); }

  lintSingleVariantMatch(subject: Expr, arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void { return matches.lintSingleVariantMatch(this, subject, arms, subjType, sp); }

  checkMatchLike(subject: Expr, arms: MatchArm[], sp: Span | undefined, fnRetType: TypeKind, isStmt?: boolean, expected?: TypeKind | null) { return matches.checkMatchLike(this, subject, arms, sp, fnRetType, isStmt, expected); }

  blockExprType(body: Stmt[]) { return exprs.blockExprType(this, body); }

  tailExprOf(body: Stmt[]) { return exprs.tailExprOf(this, body); }

  checkValueBody(body: Stmt[], fnRetType: TypeKind, expected: TypeKind | null): void { return exprs.checkValueBody(this, body, fnRetType, expected); }

  staticCallOnVariable(expr: any, expected: TypeKind | null) { return calls.staticCallOnVariable(this, expr, expected); }

  rewriteStaticToMember(expr: any) { return calls.rewriteStaticToMember(this, expr); }

  flexIntLeaves(e: Expr) { return stmts.flexIntLeaves(this, e); }

  tailFlexLeaves(body: Stmt[]) { return stmts.tailFlexLeaves(this, body); }

  resolveFlexInt(info: VarInfo, target: TypeKind, useExpr: Expr) { return exprs.resolveFlexInt(this, info, target, useExpr); }

  flexIntBinding(e: Expr) { return exprs.flexIntBinding(this, e); }

  isHashable(t: TypeKind, seen?: Set<string>) { return exprs.isHashable(this, t, seen); }

  validateHashableKey(t: TypeKind, span?: Span) { return calls.validateHashableKey(this, t, span); }

  resolveOptionForValue(valueType: TypeKind, span?: Span) { return calls.resolveOptionForValue(this, valueType, span); }

  unwrapableInner(t: TypeKind) { return calls.unwrapableInner(this, t); }

  unwrapableErr(t: TypeKind) { return calls.unwrapableErr(this, t); }

  isOptionLike(t: TypeKind) { return exprs.isOptionLike(this, t); }

  findPropagateBoxing(sourceErr: TypeKind, targetErr: TypeKind, sp?: Span, what?: string) { return exprs.findPropagateBoxing(this, sourceErr, targetErr, sp, what); }

  findFromConversion(sourceErr: TypeKind, targetErr: TypeKind) { return exprs.findFromConversion(this, sourceErr, targetErr); }
}

export { RAW_SLICE_INTRINSICS, ADOPT_INTRINSICS, FOREIGN_MODULE, inModule, MAP_INTRINSICS, isHashMapModule, VEC_INTRINSICS, isVecModule, STR_INTRINSICS, isStringModule, isStdCollectionModule, isForeignModule, userFnShadowsBuiltin, rewritten, rewrittenPattern } from "./checker-util";
