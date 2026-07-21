import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span, TraitDecl, MatchArm, Attribute } from "./ast";
import { simpleType, declaredType } from "./ast";
import type { TypeKind } from "./types";
import { typeFromAst, typeEq, typeName, isNumeric, isCopy, isScalar } from "./types";
import type { Diagnostic, WarningConfig } from "./diagnostics";

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
  // For a ref/slice binding: the source vars this binding's borrow froze.
  // Released (borrowed=false) when the binding's scope pops, so a slice in an
  // inner block doesn't freeze its source for the rest of the function.
  freezes?: VarInfo[];
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
}

export interface StructInfo {
  fields: { name: string; type: TypeKind; cOpaque?: boolean }[];
  baseName?: string;
  typeArgs?: TypeKind[];
  isExtern?: boolean;
  isOpaque?: boolean;
  cLayout?: CLayout;
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

export interface EnumInfo {
  baseName?: string;
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
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
  offsetOfFields: Map<Expr, string>;
  interfaces: Map<string, InterfaceInfo>;
  interfaceCoercions: Map<Expr, { fromType: string; ifaceName: string }>;
  interfaceMethodCalls: Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>;
  autoJsonStringify: Map<Expr, TypeKind>;
  anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[];
  globalTypes?: Map<string, TypeKind>;
  iteratorForIns: Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>;
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
  private genericFns = new Map<string, GenericFnInfo>();
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
  private autoWrappedOption = new Map<Expr, string>();
  private arrayToVecCoercions = new Set<Expr>();
  private closureCaptures = new Map<Expr, CaptureInfo[]>();
  private closureCalls = new Map<Expr, TypeKind>();
  private cfnCalls = new Map<Expr, TypeKind>();
  private sizeOfTypes = new Map<Expr, TypeKind>();
  private cSigs = new Map<string, CSig>();
  private offsetOfFields = new Map<Expr, string>();
  private closureScopeDepth: number | null = null;
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
  private resolvedMethods = new Map<Expr, string>();
  private heapMethodReceivers = new Set<Expr>();
  private iteratorForIns = new Map<Stmt, { nextMethod: string; elemType: TypeKind; optionEnumName: string }>();
  private resolvedOperators = new Map<Expr, string>();
  private fnFieldCalls = new Set<Expr>();
  private propagateConversions = new Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>();
  private interfaces = new Map<string, InterfaceInfo>();
  private interfaceCoercions = new Map<Expr, { fromType: string; ifaceName: string }>();
  private interfaceMethodCalls = new Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>();
  private autoJsonStringify = new Map<Expr, TypeKind>();
  private anonStructCounter = 0;
  private anonStructs: { name: string; fields: { name: string; type: TypeKind }[] }[] = [];
  private _userFnNames?: Set<string>;
  private entryFile?: string;
  private _userImplKeys?: Set<string>;
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
    // unused-unsafe is on by default but fires only in user code (see currentFnIsUser):
    // the permissive safe-extern rule makes most stdlib unsafe blocks technically
    // removable, so warning on imported std would flood every compile.
    this.warningConfig = config;
  }

  private error(msg: string, span?: Span, hint?: string) {
    this.diagnostics.push({ severity: "error", span, message: msg, hint });
  }

  private warn(code: string, msg: string, span?: Span, hint?: string, len?: number) {
    if (this.warningConfig.allowed.has(code)) return;
    const severity = (this.warningConfig.denied.has(code) || this.warningConfig.denied.has("*")) ? "error" : "warning";
    this.diagnostics.push({ severity, span, len, message: msg, hint, code });
  }

  // Whether a function name belongs to the user's own file. Mangled names cover
  // monomorphized user fns (`foo$i32`) and impl methods (`Type$method`,
  // `Type$Trait$method` — matched against userImplKeys `Type.method`).
  // No resolver info (direct TypeChecker use in tests/tools) → treat all as user.
  private fnIsUserCode(name: string): boolean {
    if (!this._userFnNames) return true;
    if (this._userFnNames.has(name)) return true;
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

  private monomorphizeStruct(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.structs.has(mangled)) return mangled;

    const generic = this.genericStructs.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    const fields = generic.decl.fields.map(f => ({
      name: f.name,
      type: this.resolve(this.substituteMiloType(f.type, generic.typeParams, typeArgs)),
    }));
    this.structs.set(mangled, { fields, baseName, typeArgs });

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

    // propagate @send/@sync/@derive attributes from generic struct to monomorphized type
    if (generic.decl.attributes) {
      for (const attr of generic.decl.attributes) {
        if (attr.name === "send") this.sendTypes.add(mangled);
        if (attr.name === "sync") this.syncTypes.add(mangled);
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
        if (vi.freezes) for (const src of vi.freezes) src.borrowed = false;
      }
    }
  }

  private snapshotMoveState(): Map<VarInfo, boolean> {
    const snap = new Map<VarInfo, boolean>();
    for (const scope of this.scopes) {
      for (const [, info] of scope) snap.set(info, info.moved);
    }
    return snap;
  }

  private restoreMoveState(snap: Map<VarInfo, boolean>) {
    for (const [info, moved] of snap) info.moved = moved;
  }

  private declare(name: string, info: VarInfo) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) { this.error(`variable '${name}' already declared in this scope`); return; }
    scope.set(name, info);
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
    this.functions.set("_strDataPtr", { params: [{ type: { tag: "ref", inner: { tag: "string" }, mutable: false }, name: "s" }], ret: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, variadic: false });
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
    this.functions.set("_atomicCasI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "expected" }, { type: i64t, name: "desired" }], ret: i64t, variadic: false });
    this.functions.set("_atomicLoadBool", { params: [{ type: ptrU8, name: "ptr" }], ret: { tag: "bool" }, variadic: false });
    this.functions.set("_atomicStoreBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_atomicSwapBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "bool" }, variadic: false });
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
        }));
        for (const f of fields) {
          if (f.type.tag === "ref") {
            this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`, undefined, `references are second-class — use an owned type instead`);
          }
        }
        this.structs.set(s.name, { fields, isExtern: s.isExtern, isOpaque: s.isOpaque });
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

    // collect @send/@sync annotations
    for (const s of program.structs) {
      this.validateAttributes(s.name, s.attributes, "struct");
      this.validateFieldAttributes(s);
      this.warnUnverifiedExtern(s);
      if (s.attributes) {
        for (const attr of s.attributes) {
          if (attr.name === "send") this.sendTypes.add(s.name);
          if (attr.name === "sync") this.syncTypes.add(s.name);
          if (attr.name === "cLayout") this.checkCLayout(s, attr);
        }
      }
    }
    for (const e of program.enums) this.validateAttributes(e.name, e.attributes, "enum");

    // register enums — two passes so generic enums are available when resolving variant fields
    for (const e of program.enums) {
      if (e.typeParams.length > 0) {
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
        e.variants.forEach((v, i) => {
          const fields = v.fields.map(f => this.resolve(f));
          for (const field of fields) {
            if (field.tag === "enum" && field.name === e.name) {
              this.error(`enum '${e.name}' has infinite size due to recursive field`, undefined,
                `wrap the recursive field in Heap<${e.name}> for heap allocation`);
            }
          }
          variants.set(v.name, { tag: i, fields });
        });
        this.enums.set(e.name, { variants });
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
          // @export forces external linkage — see lower.ts. Needed when the only
          // caller is a dlopen'd library resolving against this executable, which
          // no reachability analysis can see.
          else if (attr.name === "export") {
            if (fn.isExtern) {
              this.error(`'@export' on extern fn '${fn.name}' — extern declares a function defined elsewhere, so there is nothing here to export`, undefined,
                `drop '@export', or remove 'extern' if you meant to define it`);
            }
          }
          else this.error(`'@${attr.name}' is not supported on functions — '${fn.name}'`, undefined,
            `only '@cSig' and '@export' apply to a fn; it would be silently ignored otherwise`);
        }
      }
      this.checkVariadicExtern(fn);
      if (fn.typeParams.length > 0) {
        this.genericFns.set(fn.name, { typeParams: fn.typeParams.map(tp => tp.name), decl: fn });
        continue;
      }
      const params = fn.params.map(p => ({ type: this.resolve(declaredType(p)), name: p.name }));
      const ret = this.resolve(fn.retType);
      if (ret.tag === "ref") {
        this.error(`function '${fn.name}': cannot return a reference`, undefined, `references are second-class — return an owned value instead`);
      }
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

    // type-check module-level globals — push a module scope so declare() works
    this.pushScope();
    const globalTypes = new Map<string, TypeKind>();
    for (const g of program.globals) {
      const hint = g.type ? this.resolve(g.type) : null;
      const valType = this.checkExprWithHint(g.value, hint);
      const finalType = hint ?? valType;
      if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
        this.error(`global '${g.name}': type mismatch: expected ${typeName(hint)}, got ${typeName(valType)}`, g.span);
      }
      globalTypes.set(g.name, finalType);
      // A non-empty Vec/HashMap literal is const-shaped but needs heap
      // allocation, so it's just as silently-zeroed as a runtime call.
      const heapLit =
        (finalType.tag === "vec" || finalType.tag === "hashmap") &&
        !(g.value.kind === "ArrayLit" && g.value.elements.length === 0);
      if (!this.isConstGlobalInit(g.value) || heapLit) {
        // Codegen emits globals via LLVM constant initializers only; anything
        // runtime-evaluated used to silently become zeroinitializer ("" / 0 /
        // empty), which repeatedly masqueraded as deadlocks downstream.
        this.error(
          `global '${g.name}': initializer is not a compile-time constant — module-scope runtime initialization is not supported, so this would silently become zero/empty at runtime. Assign it at the start of main() instead (declare it as '= ""', '= 0', '= []', ...)`,
          g.span,
        );
      }
      this.declare(g.name, { type: finalType, mutable: g.mutable, moved: false, borrowed: false, read: true, span: g.span });
    }
    this._globalTypes = globalTypes;

    for (const fn of program.functions) {
      if (!fn.isExtern && fn.typeParams.length === 0) this.checkFunction(fn);
    }

    // type-check impl method bodies after all registrations
    for (const fn of implFnsToCheck) {
      this.checkFunction(fn);
    }

    // drain deferred impl fns from generic impl monomorphization
    while (this._pendingImplFns.length > 0) {
      const batch = this._pendingImplFns.splice(0);
      for (const fn of batch) {
        this.checkFunction(fn);
      }
    }

    // Any deferred-inference Vec that never saw a `push` couldn't have its element
    // resolved — fall back to the original "add an annotation" error.
    for (const p of this.pendingInferVecs) {
      if (this.inferVecElems.has(p.elem as object)) {
        this.error(`cannot infer Vec element type — no 'push' found to infer from; add a type annotation: 'let v: Vec<T> = Vec.new()'`, p.span);
      }
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
      offsetOfFields: this.offsetOfFields,
      interfaces: this.interfaces,
      interfaceCoercions: this.interfaceCoercions,
      interfaceMethodCalls: this.interfaceMethodCalls,
      autoJsonStringify: this.autoJsonStringify,
      anonStructs: this.anonStructs,
      globalTypes: this._globalTypes,
      iteratorForIns: this.iteratorForIns,
    };
  }

  private processDerives(program: Program): import("./ast").ImplDecl[] {
    const result: import("./ast").ImplDecl[] = [];
    const explicitEq = new Set<string>();
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
    this.error(`cannot derive '${traitName}' — only Eq is supported`);
    return null;
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
    const otherParam: import("./ast").Param = { name: "other", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };

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

  private resolveTypeNameForImpl(name: string): string {
    if (this.structs.has(name) || this.genericStructs.has(name)) return name;
    if (this.enums.has(name) || this.genericEnums.has(name)) return name;
    return name;
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
  private static readonly KNOWN_ATTRS = ["derive", "send", "sync", "cLayout", "cSig"];

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
    if (!TypeChecker.C_HEADER_RE.test(header)) {
      this.error(`@cSig on '${f.name}': '${header}' is not a C header path`, undefined,
        `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'unistd.h'`);
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
    this.cSigs.set(f.name, { header, sig });
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
  private static readonly C_HEADER_RE = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*\.h$/;
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
  // so the size assert stays meaningful. Anything else on a field is rejected: a silently
  // ignored attribute is the failure this whole feature exists to close.
  private validateFieldAttributes(s: StructDecl): void {
    for (const f of s.fields) {
      if (!f.attributes) continue;
      for (const attr of f.attributes) {
        if (attr.name !== "cOpaque") {
          this.error(`'@${attr.name}' is not supported on a struct field — '${s.name}.${f.name}'`, s.span,
            `only '@cOpaque' applies to a field; it marks C-invisible padding for @cLayout`);
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
    if (!TypeChecker.C_HEADER_RE.test(header)) {
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

    // 'addrOf' is the built-in universal raw address-of operator (x.addrOf(): *T).
    // Reserve the name so `x.addrOf()` means exactly one thing everywhere — a
    // user method of the same name would be silently shadowed (context-dependent
    // dispatch), which is the ambiguity this design exists to remove.
    for (const m of impl.methods) {
      if (m.name === "addrOf")
        this.error(`'addrOf' is a reserved method name — it is the built-in raw address-of operator ('x.addrOf(): *T'). Rename this method.`, m.span ?? impl.span);
    }

    // generic impl — store as template, instantiate per monomorphization
    if (impl.typeParams && impl.typeParams.length > 0 && !impl.traitName) {
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
          existing.methods.set(m.name, { params, ret, variadic: false });
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
          methods.set(m.name, { params, ret, variadic: false });
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
          if (!this.isSend(f.type)) return `field '${f.name}' of type '${typeName(f.type)}' is not Send — add @send to '${ty.name}' if thread safety is guaranteed`;
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

  private checkFunction(fn: Function) {
    // save/restore: monomorphization can re-enter checkFunction mid-expression.
    // currentFnRetType MUST be saved too — resolving/checking a generic in this
    // fn's body (e.g. Channel<string>.new) re-enters checkFunction for that
    // type's methods (some returning void), which would otherwise leave
    // currentFnRetType clobbered and make a later `?` see a void return.
    const savedIsUser = this.currentFnIsUser;
    const savedRetType = this.currentFnRetType;
    this.currentFnIsUser = this.fnIsUserCode(fn.name);
    this.pushScope();
    const retType = this.resolve(fn.retType);
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
      for (const c of fn.contracts) {
        const cType = this.checkExpr(c.expr);
        if (cType.tag !== "bool" && cType.tag !== "unknown") {
          this.error(`${c.kind} clause must be bool, got ${typeName(cType)}`, c.span);
        }
      }
      this.popScope();
    }

    for (const stmt of fn.body) this.checkStmt(stmt, retType);

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
      if (info.read || name.startsWith("_")) continue;
      this.warn("unused-variable", `unused variable '${name}'`, info.span,
        `prefix with underscore to silence: '_${name}'`);
    }

    this.popScope();
    this.currentFnIsUser = savedIsUser;
    this.currentFnRetType = savedRetType;
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
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
          }
        }
        // range checking for ranged integer types
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
        // Borrows the RHS created: a ref binding owns them until its scope pops;
        // any other binding consumed them within the statement (e.g. s[0..n].clone())
        // and must not leak a freeze onto later statements.
        const newlyFrozen: VarInfo[] = [];
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) newlyFrozen.push(vi);
        const bindingType = hint ?? valType;
        if (bindingType.tag !== "ref") for (const vi of newlyFrozen) vi.borrowed = false;
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
        this.tryMove(stmt.value);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
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
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
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
          if (bindingType.tag !== "ref") for (const vi of newlyFrozen) vi.borrowed = false;
          this.declare(stmt.name, { type: bindingType, mutable: true, moved: false, borrowed: false, read: false, span: sp, ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo) break;
        if (!targetInfo.mutable) {
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp, `declare with 'var' instead of 'let' to make it mutable`);
          break;
        }
        this.markCaptureMutated(stmt.target);
        // reject reassignment while a borrow (slice, iteration ref) is live
        // but allow closures to mutate their own captured variables
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          const isCapturedMutation = this.closureScopeDepth !== null && this.currentClosureCaptures?.has(stmt.target.name);
          if (info?.borrowed && !isCapturedMutation) {
            this.error(`cannot assign to '${stmt.target.name}' because it is borrowed`, sp,
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
        for (const scope of this.scopes) for (const [, vi] of scope) if (vi.borrowed && !frozenBeforeRhs.has(vi)) vi.borrowed = false;
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
          // A returned closure escapes its defining frame, so it must own its captures:
          // a non-`move` closure captures by reference and would dangle into the dead
          // frame (a use-after-return in safe code). Promote it to `move` — the same
          // heap-allocation the call-argument path already applies — so tryMove below
          // moves the captures into the closure's heap env instead of aliasing locals.
          if (stmt.value.kind === "Closure" && !(stmt.value as any).isMove) {
            (stmt.value as any).isMove = true;
          }
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
          for (const [info, m] of afterThen) {
            if (m && !thenReturns) info.moved = true;
          }
          for (const [info, m] of afterElse) {
            if (m && !elseReturns) info.moved = true;
          }
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
        for (const inv of stmt.invariants ?? []) {
          const invType = this.checkExpr(inv.expr);
          if (invType.tag !== "bool" && invType.tag !== "unknown") {
            this.error(`loop invariant must be bool, got ${typeName(invType)}`, inv.span);
          }
        }
        const preMoves = this.snapshotMoveState();
        this.returnOnlyMovesStack.push(new Set());
        this.pushScope();
        this.loopDepth++;
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.loopDepth--;
        this.popScope();
        const returnMoves = this.returnOnlyMovesStack.pop()!;
        for (const scope of this.scopes) {
          for (const [name, info] of scope) {
            if (preMoves.get(info) === false && info.moved) {
              if (returnMoves.has(info)) { info.moved = false; }
              else { this.error(`cannot move '${name}' out of a loop`, sp); }
            }
          }
        }
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
          this.declare(stmt.varName, { type: varType, mutable: false, moved: false, borrowed: false, read: false });
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves = this.returnOnlyMovesStack.pop()!;
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves.has(info)) { info.moved = false; }
                else { this.error(`cannot move '${name}' out of a loop`, sp); }
              }
            }
          }
        } else {
          let iterType = this.checkExpr(stmt.iterable);
          // iterating a slice (&[T]) or &Vec: deref — the loop borrows the view, not a copy
          if (iterType.tag === "ref" && (iterType.inner.tag === "array" || iterType.inner.tag === "vec")) {
            iterType = iterType.inner;
          }
          if (iterType.tag === "vec") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            // mark vec as borrowed to prevent mutation during iteration
            let vecBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { vecBorrowInfo = info; info.borrowed = true; }
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              // enumerate: for i, val in vec
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            if (vecBorrowInfo) vecBorrowInfo.borrowed = false;
            const returnMoves = this.returnOnlyMovesStack.pop()!;
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves.has(info)) { info.moved = false; }
                  else { this.error(`cannot move '${name}' out of a loop`, sp); }
                }
              }
            }
          } else if (iterType.tag === "string") {
            const byteType: TypeKind = { tag: "int", bits: 8, signed: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves3 = this.returnOnlyMovesStack.pop()!;
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves3.has(info)) { info.moved = false; }
                  else { this.error(`cannot move '${name}' out of a loop`, sp); }
                }
              }
            }
          } else if (iterType.tag === "hashmap") {
            const keyRef: TypeKind = { tag: "ref", inner: iterType.key, mutable: false };
            const valRef: TypeKind = { tag: "ref", inner: iterType.value, mutable: false };
            // mark map as borrowed
            let mapBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { mapBorrowInfo = info; info.borrowed = true; }
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            this.declare(stmt.varName, { type: keyRef, mutable: false, moved: false, borrowed: false, read: false });
            if (stmt.varName2) {
              this.declare(stmt.varName2, { type: valRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            if (mapBorrowInfo) mapBorrowInfo.borrowed = false;
            const returnMoves4 = this.returnOnlyMovesStack.pop()!;
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves4.has(info)) { info.moved = false; }
                  else { this.error(`cannot move '${name}' out of a loop`, sp); }
                }
              }
            }
          } else if (iterType.tag === "array") {
            const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
            let arrBorrowInfo: import("./checker").VarInfo | null = null;
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info) { arrBorrowInfo = info; info.borrowed = true; }
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set());
            this.pushScope();
            if (stmt.varName2) {
              const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body) this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            if (arrBorrowInfo) arrBorrowInfo.borrowed = false;
            const returnMoves5 = this.returnOnlyMovesStack.pop()!;
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves5.has(info)) { info.moved = false; }
                  else { this.error(`cannot move '${name}' out of a loop`, sp); }
                }
              }
            }
          } else if (iterType.tag === "struct" || iterType.tag === "enum") {
            // iterator protocol: type has next(&mut Self): Option<T>
            const resolved = this.resolveMethod(iterType.name, "next");
            if (!resolved) {
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
                  if (info) info.borrowed = true;
                }
                if (stmt.varName2) {
                  this.error("iterator for loop takes one binding, not two", sp);
                }
                this.iteratorForIns.set(stmt, { nextMethod: resolved.mangled, elemType, optionEnumName });
                const preMoves = this.snapshotMoveState();
                this.returnOnlyMovesStack.push(new Set());
                this.pushScope();
                this.declare(stmt.varName, { type: elemType, mutable: false, moved: false, borrowed: false, read: false });
                this.loopDepth++;
                for (const s of stmt.body) this.checkStmt(s, fnRetType);
                this.loopDepth--;
                this.popScope();
                const returnMovesIter = this.returnOnlyMovesStack.pop()!;
                for (const scope of this.scopes) {
                  for (const [name, info] of scope) {
                    if (preMoves.get(info) === false && info.moved) {
                      if (returnMovesIter.has(info)) { info.moved = false; }
                      else { this.error(`cannot move '${name}' out of a loop`, sp); }
                    }
                  }
                }
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
        const exprType = this.checkExpr(stmt.expr);
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

  private isPayloadFreeEnum(name: string): boolean {
    const info = this.enums.get(name);
    if (!info) return false;
    for (const [, v] of info.variants) if (v.fields.length > 0) return false;
    return true;
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
    if (typeParams.includes(retType.name)) {
      typeMap.set(retType.name, hint);
      return;
    }
    if (hint.tag === "struct" && retType.typeArgs) {
      const info = this.structs.get(hint.name);
      if (info?.baseName === retType.name && info.typeArgs) {
        const gs = this.genericStructs.get(retType.name);
        if (gs) {
          for (let i = 0; i < retType.typeArgs.length && i < gs.typeParams.length; i++) {
            const ta = retType.typeArgs[i];
            if (typeParams.includes(ta.name) && i < info.typeArgs.length) {
              typeMap.set(ta.name, info.typeArgs[i]);
            }
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

  private tryMove(expr: Expr) {
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
          this.error(`cannot move '${expr.name}' because it is captured by a closure`, expr.span);
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
            info.borrowed = false;
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
    // doesn't free a buffer now owned by the moved value (double-free). Don't
    // move out of a struct held behind a `&T` ref.
    if (expr.kind === "FieldAccess") {
      const fieldType = this.exprTypes.get(expr);
      if (fieldType && !isCopy(fieldType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
        let objectIsRef = false;
        if (expr.object.kind === "Ident") {
          const info = this.lookup(expr.object.name);
          if (info && info.type.tag === "ref") objectIsRef = true;
        }
        if (!objectIsRef) {
          this.movedExprs.add(expr);
        }
      }
    }
  }

  private resolveAssignTarget(expr: Expr): { type: TypeKind; mutable: boolean } | null {
    const sp = expr.span;
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) { this.error(`undefined variable '${expr.name}'`, sp); return null; }
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
      let objType = this.checkExpr(expr.object);
      // auto-deref *Struct for field assignment (always mutable through ptr)
      let throughPtr = false;
      if (objType.tag === "ptr" && objType.inner.tag === "struct") {
        objType = objType.inner;
        throughPtr = true;
      }
      if (objType.tag === "struct") {
        const info = this.structs.get(objType.name);
        if (!info) { this.error(`unknown struct '${objType.name}'`, sp); return null; }
        const field = info.fields.find(f => f.name === expr.field);
        if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp); return null; }
        this.setType(expr, field.type);
        const mutable = throughPtr ? true : this.isRootMutable(expr.object);
        return { type: field.type, mutable };
      }
      this.error(`cannot access field on non-struct type ${typeName(objType)}`, sp);
      return null;
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
      this.error(`cannot index non-array type ${typeName(objType)}`, sp);
      return null;
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
      this.error(`cannot dereference type '${typeName(ot)}' for assignment`, sp);
      return null;
    }
    this.error("invalid assignment target", sp);
    return null;
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
        return e.args.every((a) => this.isConstGlobalInit(a));
      default:
        return false;
    }
  }

  // An integer expression composed entirely of literals (and arithmetic on
  // them) — its width is unconstrained and can adopt a context type.
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

  private rootVarOf(e: Expr): string | null {
    let cur = e;
    while (cur.kind === "FieldAccess" || cur.kind === "IndexAccess") cur = cur.object;
    return cur.kind === "Ident" ? cur.name : null;
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
      const ab = this.autoBorrowed.get(arg);
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
    const mutSteps = args.map(a => (this.autoBorrowed.get(a)?.mutable ? this.accessSteps(a) : null));
    for (let i = 0; i < args.length; i++) {
      for (let j = i + 1; j < args.length; j++) {
        const a = mutSteps[i], b = mutSteps[j];
        if (!a || !b || a.root !== b.root) continue;
        if (this.aliasesByContainment(a.steps, b.steps)) {
          const sp = args[i].span ?? args[j].span ?? undefined;
          this.error(`'${a.root}' is borrowed mutably twice in the same call`, sp,
            `one argument is a container and the other borrows into it (or they are the same place) — a mutation through one (e.g. a 'push' that reallocates) could invalidate the other; split the call into two statements or clone one argument`);
        }
      }
    }
  }

  // Index-aware access path: each step is a field name (".f") or an opaque index
  // ("[]"). Unlike accessPath (which collapses to fields=null at the first index),
  // this preserves depth so an ancestor/descendant relationship survives an index.
  private accessSteps(e: Expr): { root: string; steps: string[] } | null {
    if (e.kind === "Ident") return { root: e.name, steps: [] };
    if (e.kind === "FieldAccess") {
      const base = this.accessSteps(e.object);
      return base ? { root: base.root, steps: [...base.steps, `.${e.field}`] } : null;
    }
    if (e.kind === "IndexAccess") {
      const base = this.accessSteps(e.object);
      return base ? { root: base.root, steps: [...base.steps, "[]"] } : null;
    }
    if (e.kind === "UnaryOp" && e.op === "*") {
      const base = this.accessSteps(e.operand);
      return base ? { root: base.root, steps: [...base.steps, "*"] } : null;
    }
    return null;
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
  // null when the access goes through an index or deref, where offsets are dynamic
  // and disjointness can't be proven — callers treat null as "may alias".
  private accessPath(e: Expr): { root: string; fields: string[] | null } | null {
    if (e.kind === "Ident") return { root: e.name, fields: [] };
    if (e.kind === "FieldAccess") {
      const base = this.accessPath(e.object);
      if (!base) return null;
      return { root: base.root, fields: base.fields === null ? null : [...base.fields, e.field] };
    }
    if (e.kind === "IndexAccess") {
      const base = this.accessPath(e.object);
      return base ? { root: base.root, fields: null } : null;
    }
    if (e.kind === "UnaryOp" && e.op === "*") {
      const base = this.accessPath(e.operand);
      return base ? { root: base.root, fields: null } : null;
    }
    return null;
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
  private errorIfFrozen(obj: Expr, action: string, sp?: Span) {
    let e = obj;
    while (e.kind === "FieldAccess" || e.kind === "IndexAccess") e = e.object;
    if (e.kind !== "Ident") return;
    const info = this.lookup(e.name);
    if (info?.borrowed) {
      this.error(`cannot ${action} '${e.name}' because it is borrowed`, sp,
        `a slice or loop iteration over this variable is still live — mutating it could move memory the borrow points into`);
    }
  }

  // Auto-borrow a call argument; passing a frozen var by mutable ref is the same
  // hazard as calling a mutating method on it (the callee may realloc/free it).
  private setAutoBorrowChecked(arg: Expr, mutable: boolean, sp?: Span) {
    if (mutable) {
      this.errorIfFrozen(arg, "pass", sp);
      // Passing an immutable binding to a '&mut' param mutates it through the
      // call — the same hazard method receivers already reject ("cannot push to
      // immutable Vec"). A 'let' claims immutability *and* SSA-register storage;
      // taking its address for '&mut' forces a spill and silently breaks both.
      // Free-function '&mut' args were the one path that skipped this check.
      let root: Expr = arg;
      while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
      if (root.kind === "Ident") {
        const info = this.lookup(root.name);
        if (info && !info.mutable && info.type.tag !== "ref") {
          this.error(`cannot pass immutable '${this.describeExpr(arg)}' as a '&mut' argument`, sp,
            `declare with 'var' to make it mutable`);
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
    info.borrowed = true;
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
          if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp); continue; }
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
    return result;
  }

  private setType(expr: Expr, type: TypeKind): TypeKind {
    this.exprTypes.set(expr, type);
    return type;
  }

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
        return this.setType(expr, { tag: "string" });
      case "Ident": {
        const info = this.lookup(expr.name);
        if (!info) {
          // named function used as a value (function pointer)
          const fnSig = this.functions.get(expr.name);
          if (fnSig) {
            const fnType: TypeKind = { tag: "fn", params: fnSig.params.map(p => p.type), ret: fnSig.ret };
            return this.setType(expr, fnType);
          }
          this.error(`undefined variable '${expr.name}'`, sp); return this.setType(expr, { tag: "unknown" });
        }
        info.read = true;
        if (info.moved) {
          if (this.movedByPattern.has(info)) {
            this.error(
              `use of moved variable '${expr.name}'`,
              sp,
              `the pattern moved '${expr.name}''s payload out, so reading '${expr.name}' here would see a zeroed value. Use the pattern's binding instead, or compute what you need from '${expr.name}' before the match.`,
            );
          } else {
            this.error(
              `use of moved variable '${expr.name}'`,
              sp,
              `ownership of '${expr.name}' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: '${expr.name}.clone()'.`,
            );
          }
          return this.setType(expr, this.deref(info.type));
        }
        return this.setType(expr, this.deref(info.type));
      }
      case "BinOp": {
        if (expr.op === "&&" || expr.op === "||") {
          const lt = this.checkExpr(expr.left);
          const rt = this.checkExpr(expr.right);
          if (lt.tag !== "bool" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(lt)}`, sp);
          if (rt.tag !== "bool" && rt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(rt)}`, sp);
          return this.setType(expr, { tag: "bool" });
        }
        let lt = this.checkExpr(expr.left);
        let rt = this.checkExpr(expr.right);
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
      case "UnaryOp": {
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
      case "Call": {
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
        if (expr.func === "Heap") {
          if (expr.args.length !== 1) { this.error(`Heap() expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
          const argType = this.checkExpr(expr.args[0]);
          this.tryMove(expr.args[0]);
          return this.setType(expr, { tag: "heap", inner: argType });
        }
        if (expr.func === "embedFile") {
          if (expr.args.length !== 1) { this.error(`embedFile() expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "unknown" }); }
          const arg = expr.args[0];
          if (arg.kind !== "StringLit") { this.error(`embedFile() argument must be a string literal`, sp); return this.setType(expr, { tag: "unknown" }); }
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
              continue;
            }
            this.setAutoBorrowChecked(expr.args[i], paramType.mutable, sp);
            // Vec<T> auto-coerces to &[T] (same {ptr,len,cap} layout; callee ignores cap).
            // Immutable only — &mut [T] in-place views aren't supported yet.
            if (paramType.inner.tag === "array" && paramType.inner.size === null && !paramType.mutable
                && argType.tag === "vec" && typeEq(paramType.inner.element, argType.element)) {
              continue;
            }
            if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
              if (!this.tryInterfaceCoercion(expr.args[i], argType, paramType)) {
                this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
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
                this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
              }
            }
          }
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
      case "StructLit": {
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
            const fieldDef = genericInfo.fields.find(d => d.name === f.name);
            if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp); continue; }
            const valType = this.checkExpr(f.value);
            if (fieldDef.type.tag === "struct" && genericInfo.typeParams.includes(fieldDef.type.name)) {
              const existing = typeMap.get(fieldDef.type.name);
              if (existing && !typeEq(existing, valType)) {
                this.error(`conflicting inference for type parameter '${fieldDef.type.name}'`, sp);
              } else {
                typeMap.set(fieldDef.type.name, valType);
              }
            }
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
          if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp); continue; }
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
      case "FieldAccess": {
        let objType = this.checkExpr(expr.object);
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
          if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp); return this.setType(expr, { tag: "unknown" }); }
          return this.setType(expr, field.type);
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
        this.error(`cannot access field '${expr.field}' on type ${typeName(objType)}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      case "ArrayLit": {
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
      case "ArrayRepeat": {
        const elemType = this.checkExprWithHint(expr.value, null);
        return this.setType(expr, { tag: "array", element: elemType, size: expr.count });
      }
      case "IndexAccess": {
        const rawObjType = this.checkExpr(expr.object);
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
      case "EnumLit": {
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
        if (expr.enumName === "HashMap" && expr.variant === "new") {
          if (expr.args.length !== 0) this.error(`'HashMap.new' takes no arguments`, sp);
          this.error(`cannot infer HashMap types — add a type annotation: 'let m: HashMap<K, V> = HashMap.new()'`, sp);
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
          while (this._pendingImplFns.length > 0) {
            const fn = this._pendingImplFns.shift()!;
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
          this.error(`unknown enum '${expr.enumName}'`, sp); return this.setType(expr, { tag: "unknown" });
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
      case "Unwrap": {
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
      case "Propagate": {
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
      case "DefaultValue": {
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
      case "CastExpr": {
        const fromType = this.checkExpr(expr.operand);
        const toType = this.resolve(expr.targetType);
        const fromOk = isNumeric(fromType) || fromType.tag === "bool" || fromType.tag === "ptr" || fromType.tag === "array" || fromType.tag === "fn" || fromType.tag === "cfn" || fromType.tag === "string" || fromType.tag === "unknown";
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
      case "Closure": {
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
            if (info) { info.borrowed = true; break; }
          }
        }
        this.closureScopeDepth = savedClosureScopeDepth;
        this.currentClosureCaptures = savedClosureCaptures;
        return this.setType(expr, { tag: "fn", params: paramTypes, ret: inferredRet });
      }
      case "MethodCall": {
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
            if (expr.args.length !== 1) { this.error(`'unwrapOr' expects 1 argument`, sp); }
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
            if (expr.args.length !== 1) { this.error(`'unwrapOrElse' expects 1 argument`, sp); }
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
        }
        // Result combinators — isOk/isErr/unwrapOr, mirroring Option (Ok is tag 0).
        if (objType.tag === "enum" && this.enums.get(objType.name)?.baseName === "Result") {
          if (expr.method === "isOk" || expr.method === "isErr") {
            if (expr.args.length !== 0) { this.error(`'${expr.method}' takes no arguments`, sp); }
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "unwrapOr") {
            if (expr.args.length !== 1) { this.error(`'unwrapOr' expects 1 argument`, sp); }
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
        }
        // wrapping/saturating/checked arithmetic methods on integers
        if (objType.tag === "int") {
          const wrappingMethods = ["wrappingAdd", "wrappingSub", "wrappingMul"];
          const saturatingMethods = ["saturatingAdd", "saturatingSub", "saturatingMul"];
          const checkedMethods = ["checkedAdd", "checkedSub", "checkedMul", "checkedDiv", "checkedRem"];
          if (wrappingMethods.includes(expr.method) || saturatingMethods.includes(expr.method)) {
            if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); }
            const argType = this.checkExprWithHint(expr.args[0], objType);
            if (!typeEq(objType, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.method}': expected ${typeName(objType)}, got ${typeName(argType)}`, sp);
            }
            return this.setType(expr, objType);
          }
          if (checkedMethods.includes(expr.method)) {
            if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument`, sp); }
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
            if (info) info.borrowed = true;
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
              this.inferVecElems.delete(objType.element as object);
              Object.assign(objType.element as object, argType);
              this.tryMove(expr.args[0]);
              return this.setType(expr, { tag: "void" });
            }
            const argType = this.checkExprWithHint(expr.args[0], objType.element);
            if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
              if (!this.tryInterfaceCoercion(expr.args[0], argType, objType.element)) {
                this.error(`push: expected ${typeName(objType.element)}, got ${typeName(argType)}`, sp);
              }
            }
            this.tryMove(expr.args[0]);
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
            if (cbBorrow) cbBorrow.borrowed = false;
            if (cbType.tag !== "fn") { this.error(`'map' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
            return this.setType(expr, { tag: "vec", element: cbType.ret });
          }
          if (expr.method === "filter") {
            if (expr.args.length !== 1) { this.error(`'filter' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
            if (cbType.tag !== "fn") { this.error(`'filter' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
            return this.setType(expr, { tag: "vec", element: objType.element });
          }
          if (expr.method === "each") {
            if (expr.args.length !== 1) { this.error(`'each' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "void" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "enumerate") {
            if (expr.args.length !== 1) { this.error(`'enumerate' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [{ tag: "int", bits: 64, signed: true }, elemRef], ret: { tag: "void" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "find") {
            if (expr.args.length !== 1) { this.error(`'find' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
            if (cbType.tag !== "fn") { this.error(`'find' argument must be a function`, sp); return this.setType(expr, { tag: "unknown" }); }
            return this.setType(expr, this.resolveOptionForValue(objType.element, sp));
          }
          if (expr.method === "any") {
            if (expr.args.length !== 1) { this.error(`'any' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "all") {
            if (expr.args.length !== 1) { this.error(`'all' expects 1 argument`, sp); return this.setType(expr, { tag: "unknown" }); }
            const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbBorrow = this.borrowDuringCallback(expr.object);
            this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
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
            if (cbBorrow) cbBorrow.borrowed = false;
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
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbBorrow) cbBorrow.borrowed = false;
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
          this.error(`Vec has no method '${expr.method}'`, sp);
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
          this.error(`HashMap has no method '${expr.method}'`, sp);
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
            // mark source as borrowed — prevents mutation/move while slice is live
            if (expr.object.kind === "Ident") {
              const info = this.lookup(expr.object.name);
              if (info) info.borrowed = true;
            }
            this.borrowedExprs.add(expr);
            return this.setType(expr, refStr);
          }
          if (expr.method === "parseF64") {
            if (expr.args.length !== 0) { this.error(`'parseF64' takes no arguments`, sp); }
            return this.setType(expr, { tag: "float", bits: 64 });
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
            if (expr.args.length !== 1) { this.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return this.setType(expr, { tag: "int", bits: 64, signed: true }); }
            const argType = this.checkExpr(expr.args[0]);
            if (argType.tag !== "string" && argType.tag !== "unknown") this.error(`'${expr.method}': expected string, got ${typeName(argType)}`, sp);
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
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
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
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
              if (expr.method === "json" && bare.tag === "string" && (argType.tag === "struct" || argType.tag === "bool" || argType.tag === "int" || argType.tag === "float")) {
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

        this.error(`type '${typeName(objType)}' has no method '${expr.method}'`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      case "RangeExpr":
        this.error("range expressions can only be used in 'for' loops", sp);
        return this.setType(expr, { tag: "unknown" });
      case "IsExpr": {
        const opType = this.checkExpr(expr.operand);
        if (expr.pattern.kind === "EnumPattern") {
          if (opType.tag !== "enum" && opType.tag !== "unknown") {
            this.error(`'is' pattern requires an enum type, got ${typeName(opType)}`, sp);
          }
        }
        return this.setType(expr, { tag: "bool" });
      }
      case "IfExpr": {
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
        for (const [info, m] of afterThen) { if (m) info.moved = true; }
        for (const [info, m] of afterElse) { if (m) info.moved = true; }

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
      case "MatchExpr": {
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
    }
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
  private checkMatchLike(subject: Expr, arms: MatchArm[], sp: Span | undefined, fnRetType: TypeKind): TypeKind[] {
    const armTypes: TypeKind[] = [];
    const rawSubjType = this.checkExpr(subject);
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
    // Matching an OWNED enum local to inspect its shape shouldn't consume it when no
    // arm actually moves a non-Copy payload out — i.e. every non-Copy payload is
    // ignored (`_`). Then the match only reads, so borrow it (like the place case)
    // instead of moving, and it stays usable afterward. This is purely additive: it
    // never changes a binding's type (there are no named non-Copy bindings in this
    // case — Copy bindings stay by-value either way), so a match that legitimately
    // destructures owned data still consumes exactly as before.
    let subjIsOwnedInspect = false;
    if (!subjIsRef && !subjIsPlace && subjType.tag === "enum" && subject.kind === "Ident") {
      const einfo = this.enums.get(subjType.name);
      if (einfo) {
        subjIsOwnedInspect = arms.every(arm => {
          if (arm.pattern.kind !== "EnumPattern") return true;
          const v = einfo.variants.get(arm.pattern.variant);
          if (!v) return true;
          return arm.pattern.bindings.every((b, i) =>
            b === "_" || i >= v.fields.length ||
            isCopy(v.fields[i], (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n)));
        });
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
      const mergedMoves = new Map<typeof preMoves extends Map<infer K, infer V> ? K : never, boolean>();
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
        for (const [info, moved] of this.snapshotMoveState()) {
          if (moved) mergedMoves.set(info, true);
        }
      }
      this.restoreMoveState(preMoves);
      for (const [info] of mergedMoves) info.moved = true;
      if (!hasWildcard && subjType.tag === "bool") {
        const hasTrueArm = arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === true);
        const hasFalseArm = arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === false);
        if (!hasTrueArm || !hasFalseArm) {
          this.error(`non-exhaustive match on bool`, sp);
        }
      } else if (!hasWildcard) {
        this.error(`match on ${typeName(subjType)} requires a wildcard '_' arm`, sp);
      }
    } else if (isEnum && subjType.tag === "enum") {
      // The tag test is redundant — `subjType` is not reassigned after `isEnum` is
      // computed — but it is what narrows `subjType` for the enum accesses below.
      const enumInfo = this.enums.get(subjType.name)!;
      const covered = new Set<string>();
      let hasWildcard = false;
      const preMoves = this.snapshotMoveState();
      const mergedMoves = new Map<typeof preMoves extends Map<infer K, infer V> ? K : never, boolean>();
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
        for (const [info, moved] of this.snapshotMoveState()) {
          if (moved) mergedMoves.set(info, true);
        }
      }
      this.restoreMoveState(preMoves);
      for (const [info] of mergedMoves) info.moved = true;
      if (!hasWildcard) {
        for (const [name] of enumInfo.variants) {
          if (!covered.has(name)) {
            this.error(`non-exhaustive match: missing variant '${name}'`, sp);
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

  private validateHashableKey(t: TypeKind, span?: Span) {
    if (t.tag === "int" || t.tag === "bool" || t.tag === "string") return;
    if (t.tag !== "unknown") {
      this.error(`type '${typeName(t)}' is not hashable — only integer, bool, and string keys are supported`, span);
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
