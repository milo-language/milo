// How the backend reads the checked AST (docs/plans/top-dialect.md): each expression as the
// op family src/emit-mlir.ts prints for it, decided on each visit from the merged AST and the
// checker's facts (CheckResult). Nothing here is a tree: a Form's operands are AST nodes, a
// Form is made when a node is visited and dropped after, and every type is the checker's
// (`Facts.ty`). The checker's coercions on an expression (an auto-wrapped `Some`, an
// interface coercion, a range check, a shared string, a fixed array passed as a slice) are
// layers over the node, read outermost first (`Peel`).
//
// Facts also holds what the emitter itself adds: AST nodes it builds for its own sugar
// (a `?`'s error conversion, a combinator's arms), each with its type, move and borrow marks.
import type { Expr, Pattern, Span, Stmt } from "./ast";
import { declaredType, floatNamespaceConst, isNestedPattern } from "./ast";
import type { CheckResult, EnumInfo, PropagateBoxing } from "./checker";
import { RAW_SLICE_INTRINSICS, ADOPT_INTRINSICS, MAP_INTRINSICS, VEC_INTRINSICS, STR_INTRINSICS, isForeignModule, isHashMapModule, isStringModule, isVecModule, userFnShadowsBuiltin } from "./checker";
import type { TypeKind } from "./types";
import { SLICE_COMBINATORS, ARRAY_COMBINATORS, typeFromAst } from "./types";
import { SCOPED_SPAWN_FN } from "./checker-program-passes";
import { must } from "./must";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, dirname } from "path";

/** An AST expression with its outer `depth` coercion layers already applied by the caller. */
export interface Peel { kind: "$peel"; of: Expr; depth: number }
export type Node = Expr | Peel;
export interface Arg { expr: Node; passByRef: boolean; refMut: boolean }

const I64: TypeKind = { tag: "int", bits: 64, signed: true };
const BOOL: TypeKind = { tag: "bool" };
const STRING: TypeKind = { tag: "string" };

// The match pattern facts the emitter needs: the variant tag, each binding's type, and for a
// nested pattern the tests below the top tag (each at a path of payload projections, in an
// order where a test's path crosses only variants already tested) with each binding's path.
export interface PatStep { enumName: string; variant: string; index: number }
export type PatTest =
  | { kind: "tag"; path: PatStep[]; enumName: string; tag: number }
  | { kind: "lit"; path: PatStep[]; value: bigint | number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool"; type: TypeKind };
// `escapes`: the binding outlives its arm (let-else's are read after the match), so the
// enclosing scope's drop owns it, not the arm's.
export type Pat =
  | { kind: "EnumPattern"; variant: string; bindings: { name: string; type: TypeKind; escapes?: boolean; path?: PatStep[] }[]; tag: number; tests?: PatTest[] }
  | { kind: "LiteralPattern"; value: bigint | number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool" }
  | { kind: "WildcardPattern" };

// One op family per variant. `node` is the expression the form was read from.
// Distributes over K, so each kind is its own member and `kind` narrows.
type F<K extends string, T> = K extends string ? { kind: K; node: Node; span?: Span } & T : never;
export type Form =
  | F<"IntLit", { value: bigint }> | F<"FloatLit", { value: number }> | F<"BoolLit", { value: boolean }>
  | F<"CharLit", { value: number }> | F<"StringLit", { value: string }>
  | F<"RangeCheck", { value: Node; min: number; max: number; typeName: string }>
  | F<"Ident", { name: string }>
  | F<"BinOp", { op: string; left: Node; right: Node }>
  | F<"UnaryOp", { op: string; operand: Node }>
  | F<"Call", { func: string; args: Arg[]; variadic: boolean; noNewline?: boolean }>
  | F<"StructLit", { name: string; fields: { name: string; value: Node }[]; base?: Node }>
  | F<"FieldAccess", { object: Node; field: string }>
  | F<"ArrayLit", { elements: Node[] }>
  | F<"ArrayRepeat", { value: Node; count: number; cloneFn?: string }>
  | F<"IndexAccess", { object: Node; index: Node; isBorrowed: boolean }>
  | F<"EnumLit", { enumName: string; variant: string; args: Node[] }>
  | F<"ArrayLen" | "StringLen" | "StringCstr" | "VecPtr" | "HeapPtr" | "VecLen" | "HashMapLen" | "VecCapacity", { object: Node }>
  | F<"Unwrap", { operand: Node; enumName: string }>
  | F<"Propagate", { operand: Node; enumName: string; retType: TypeKind; fromConversion?: { targetEnumName: string; wrapVariant: string; wrapTag: number }; boxConversion?: PropagateBoxing; messageFn?: { fn: string; errType: TypeKind } }>
  | F<"DefaultValue", { operand: Node; default: Node; enumName: string }>
  | F<"Cast", { operand: Node; targetType: TypeKind }>
  | F<"MemReplace", { place: Node; value: Node }>
  | F<"Forget", { value: Node }>
  | F<"MemSwap", { a: Node; b: Node }>
  | F<"EnumTryFrom", { enumName: string; optionEnumName: string; value: Node; discriminants: number[] }>
  | F<"IsCheck", { operand: Node; tag: number }>
  | F<"HeapCreate", { value: Node }>
  | F<"HeapDeref", { operand: Node }>
  | F<"PtrDeref", { operand: Node }>
  | F<"MatchExpr", { subject: Node; arms: { pattern: Pattern; body: Stmt[] }[]; enumName: string; subjectIsRef: boolean; subjectIsMut: boolean }>
  | F<"VecNew", { elementType: TypeKind }>
  | F<"StrReserve", { str: Node; extra: Node }> | F<"StrUnique", { str: Node }> | F<"StrAlloc", { size: Node }>
  | F<"StrPanic", { head: string; value: Node; tail: string }>
  | F<"StringPushStr", { str: Node; other: Node }> | F<"StringPushInt", { str: Node; value: Node }>
  | F<"StrRangeCheck", { str: Node; start: Node; end: Node }>
  | F<"StringSlice", { str: Node; start: Node; end: Node }>
  | F<"VecSlice", { vec: Node; start: Node; end: Node; elementType: TypeKind }>
  | F<"RawSlice", { ptr: Node; len: Node; elementType: TypeKind }>
  | F<"Adopt", { ptr: Node; len?: Node }>
  | F<"StringClone", { str: Node }>
  | F<"NumberToString", { value: Node; valueType: TypeKind }>
  | F<"JsonStringify", { value: Node; valueType: TypeKind }>
  | F<"Closure", { ast?: Expr & { kind: "Closure" }; params: { name: string; type: TypeKind }[]; body: Stmt[]; captures: { name: string; type: TypeKind; mutable: boolean; consumedInClosure?: boolean; share?: boolean }[]; retType: TypeKind; isMove?: boolean; heapEnv?: boolean; keyExtractor?: boolean }>
  | F<"CFnCall" | "ClosureCall", { callee: Node; args: Arg[] }>
  | F<"VecGetOpt", { object: Node; index: Node; elementType: TypeKind; optionEnumName: string }>
  | F<"WrappingArith" | "SaturatingArith", { op: string; left: Node; right: Node }>
  | F<"CheckedArith", { op: string; left: Node; right: Node; optionEnumName: string }>
  | F<"BitIntrinsic", { intrinsic: string; value: Node; amount?: Node }>
  | F<"OptionOp", { op: string; value: Node; default?: Node; boxConversion?: PropagateBoxing; enumName: string }>
  | F<"SizeOf", { sizeType: TypeKind }>
  | F<"MapHash", { key: Node; seed: Node }> | F<"MapKeyEq" | "NatLess", { a: Node; b: Node }>
  | F<"VecPanic", { message: string }>
  | F<"MapCopyOut", { value: Node }> | F<"MapSeed", {}> | F<"MapAlloc", { count: Node; size: Node }>
  | F<"NonNegative", { value: Node; what: string }>
  | F<"VecGrowBuf", { data: Node; len: Node; cap: Node; elementType: TypeKind }>
  | F<"OffsetOf", { sizeType: TypeKind; fieldName: string }>
  | F<"Zeroed", { zeroType: TypeKind }>
  | F<"InterfaceCoerce", { value: Node; fromType: string; ifaceName: string }>
  | F<"InterfaceMethodCall", { object: Node; ifaceName: string; methodIndex: number; args: Arg[] }>
  | F<"IfExpr", { cond: Node; thenBody: Stmt[]; elseBody: Stmt[]; folded?: boolean }>;
export type FormOf<K extends Form["kind"]> = Form & { kind: K };

/** What the forms of one function body need from where it is emitted. */
export interface FormCtx {
  /** The result type of the fn or closure body the expression is in (a `?` returns it). */
  ret: TypeKind;
  /** A direct call's callee, as the emitted copy of the function calls it (@trackCaller). */
  callee?(call: Expr, name: string): string;
  /** An `old(e)` in a contract: the entry snapshot binding it reads. */
  old?(call: Expr): string | undefined;
}

type Layer = "slice" | "range" | "wrap" | "iface" | "rangeIn" | "share";

export class Facts {
  // The emitter's own nodes: their types and marks, where the checker has none.
  private readonly synTypes = new Map<Expr, TypeKind>();
  private readonly synMoves = new Set<Expr>();
  private readonly synBorrows = new Map<Expr, { mutable: boolean }>();
  private readonly synForms = new Map<Expr, (n: Expr) => Form>();
  // Set by a `.context` form: the program then needs ErrorContext's Error itable.
  usedContext = false;

  constructor(readonly c: CheckResult, readonly target: { os: string; arch: string; sourceDir: string }) {}

  /** A node the emitter built: its type, whether it is a move, and how an argument is lent. */
  syn<E extends Expr>(e: E, type: TypeKind, marks: { move?: boolean; borrow?: { mutable: boolean } } = {}): E {
    this.synTypes.set(e, type);
    if (marks.move) this.synMoves.add(e);
    if (marks.borrow) this.synBorrows.set(e, marks.borrow);
    return e;
  }
  /** A node that stands for a form no AST node spells (`NonNegative`, a full-range slice). */
  synForm(type: TypeKind, form: (n: Expr) => Form): Expr {
    const n: Expr = { kind: "Ident", name: "$form" };
    this.synTypes.set(n, type);
    this.synForms.set(n, form);
    return n;
  }

  /** The checker's type of `e` (a diverging call's `never` reads as void). */
  typeOf(e: Expr): TypeKind | undefined {
    const t = this.synTypes.get(e) ?? this.c.exprTypes.get(e);
    return t?.tag === "never" ? { tag: "void" } : t;
  }
  /** The checker's own type, `never` kept. */
  rawTypeOf(e: Expr): TypeKind | undefined { return this.synTypes.get(e) ?? this.c.exprTypes.get(e); }
  moved(e: Expr): boolean { return this.synMoves.has(e) || this.c.movedExprs.has(e); }
  borrow(e: Expr): { mutable: boolean } | undefined { return this.synBorrows.get(e) ?? this.c.autoBorrowed.get(e); }
  arg(e: Expr): Arg { const b = this.borrow(e); return { expr: e, passByRef: !!b, refMut: b?.mutable ?? false }; }

  /** The coercion layers the checker put on `e`, outermost first. */
  private layers(e: Expr): Layer[] {
    if (this.synTypes.has(e)) return [];
    const c = this.c;
    const out: Layer[] = [];
    const wrap = c.autoWrappedOption.has(e);
    const rc = c.rangeCheckedExprs.has(e);
    const inner: Layer[] = [];
    if (wrap) { inner.push("wrap"); if (rc) inner.push("rangeIn"); }
    else if (c.interfaceCoercions.has(e)) inner.push("iface");
    if (c.sharedStringExprs.has(e)) inner.push("share");
    if (rc && !wrap) out.push("range");
    out.push(...inner);
    // A fixed array passed where a slice is expected (the checker marks the argument).
    if (c.arraySliceArgs.has(e)) {
      const t = this.layerType(e, out, 0);
      if (t.tag === "array" && t.size !== null) out.unshift("slice");
    }
    return out;
  }

  private layerType(e: Expr, ls: Layer[], i: number): TypeKind {
    const l = ls[i];
    const raw = this.typeOf(e) ?? { tag: "unknown" as const };
    switch (l) {
      case undefined: return this.rawType(e);
      case "slice": { const t = this.layerType(e, ls, i + 1); return t.tag === "array" ? { tag: "array", element: t.element, size: null } : t; }
      case "range": case "rangeIn": return this.layerType(e, ls, i + 1);
      case "wrap": return { tag: "enum", name: this.c.autoWrappedOption.get(e)! };
      case "iface": {
        const ifaceInner: TypeKind = { tag: "interface", name: this.c.interfaceCoercions.get(e)!.ifaceName };
        // Heap<T> -> Heap<Interface> keeps the Heap for its drop.
        return raw.tag === "heap" ? { tag: "heap", inner: ifaceInner } : ifaceInner;
      }
      case "share": return STRING;
    }
  }

  private peel(n: Node): { e: Expr; ls: Layer[]; at: number } {
    if (n.kind === "$peel") return { e: n.of, ls: this.layers(n.of), at: n.depth };
    return { e: n, ls: this.layers(n), at: 0 };
  }

  /** The type of what `n` evaluates to, every coercion layer on it applied. */
  ty(n: Node): TypeKind {
    const { e, ls, at } = this.peel(n);
    return this.layerType(e, ls, at);
  }

  /** The AST node under `n`. */
  ast(n: Node): Expr { return n.kind === "$peel" ? n.of : n; }

  /** The op family `n` lowers to. */
  form(n: Node, cx: FormCtx): Form {
    const { e, ls, at } = this.peel(n);
    const l = ls[at];
    if (l === undefined) return this.rawForm(e, cx, n);
    const next: Peel = { kind: "$peel", of: e, depth: at + 1 };
    const span = e.span;
    switch (l) {
      case "slice": {
        const t = this.layerType(e, ls, at + 1) as TypeKind & { tag: "array" };
        return { kind: "VecSlice", node: n, span, vec: next, start: this.int(0n), end: this.int(BigInt(t.size!)), elementType: t.element };
      }
      case "range": case "rangeIn": {
        const rc = this.c.rangeCheckedExprs.get(e)!;
        return { kind: "RangeCheck", node: n, span, value: next, min: rc.min, max: rc.max, typeName: rc.typeName };
      }
      case "wrap": return { kind: "EnumLit", node: n, span, enumName: this.c.autoWrappedOption.get(e)!, variant: "Some", args: [next] };
      case "iface": {
        const co = this.c.interfaceCoercions.get(e)!;
        return { kind: "InterfaceCoerce", node: n, span, value: next, fromType: co.fromType, ifaceName: co.ifaceName };
      }
      case "share": return { kind: "StringClone", node: n, span, str: next };
    }
  }

  /** The kind of `n`'s form, cheaply. */
  kind(n: Node, cx: FormCtx): Form["kind"] { return this.form(n, cx).kind; }

  private int(v: bigint): Expr { return this.syn({ kind: "IntLit", value: v }, I64); }
  private str(v: string, span?: Span): Expr { return this.syn({ kind: "StringLit", value: v, span }, STRING); }

  /** `fn`'s own name as the checker resolved a concrete type's method: inherent first, then trait impls. */
  concreteMethodFn(typeName: string, methodName: string): string {
    if (this.c.functions.get(`${typeName}$${methodName}`)) return `${typeName}$${methodName}`;
    for (const [fnName] of this.c.functions) {
      if (fnName.startsWith(`${typeName}$`) && fnName.endsWith(`$${methodName}`)) return fnName;
    }
    return `${typeName}$${methodName}`;
  }

  /** The checker's own guard: a call it typed as a user fn never lowers as the builtin of that name. */
  shadowed(name: string): boolean {
    return userFnShadowsBuiltin(name, { functions: this.c.functions, genericFns: this.c.genericFnNames });
  }

  /** The type of what `e` evaluates to before the checker's coercions (lower's node type). */
  private rawType(e: Expr): TypeKind {
    const type = this.typeOf(e) ?? { tag: "unknown" as const };
    if (this.synTypes.has(e)) return type;
    switch (e.kind) {
      case "StructLit": return { tag: "struct", name: this.c.rewrittenStructLits.get(e) ?? e.name };
      case "ArrayLit": return this.c.arrayToVecCoercions.has(e) ? { tag: "vec", element: type.tag === "array" ? type.element : type } : type;
      case "IsExpr": return BOOL;
      case "BinOp": return this.c.variantTagCompares.has(e) ? BOOL : type;
      case "Call":
        if (e.func === "forget" && !this.shadowed("forget")) return { tag: "void" };
        if (e.func === "swap" && !this.shadowed("swap")) return { tag: "void" };
        if (e.func === "isNull" && !this.shadowed("isNull")) return BOOL;
        if (e.func === "zeroed") return this.c.sizeOfTypes.get(e) ?? type;
        if (e.func === "embedFile" || e.func === "targetOs" || e.func === "targetArch") return STRING;
        if (e.func === "_vecForget" && isVecModule(e.span?.file)) return { tag: "void" };
        return type;
      case "EnumLit": {
        const f = this.rawForm(e, { ret: { tag: "void" } }, e);
        return f.kind === "EnumLit" ? { tag: "enum", name: f.enumName } : type;
      }
      case "MethodCall":
        if (e.method === "clone" && e.args.length === 0 && !this.c.resolvedMethods.has(e) && !this.c.interfaceMethodCalls.has(e)) {
          const f = this.rawForm(e, { ret: { tag: "void" } }, e);
          if (f.node !== e) return this.ty(f.node);
        }
        return type;
      default: return type;
    }
  }

  private call(e: Expr, func: string, args: Arg[], variadic: boolean, n: Node): Form {
    return { kind: "Call", node: n, span: e.span, func, args, variadic };
  }

  private rawForm(e: Expr, cx: FormCtx, n: Node): Form {
    const fixed = this.synForms.get(e);
    if (fixed) return fixed(e);
    const c = this.c;
    const span = e.span;
    const type = this.typeOf(e) ?? { tag: "unknown" as const };
    switch (e.kind) {
      case "IntLit": return { kind: "IntLit", node: n, span, value: e.value };
      case "FloatLit": return { kind: "FloatLit", node: n, span, value: e.value };
      case "BoolLit": return { kind: "BoolLit", node: n, span, value: e.value };
      case "CharLit": return { kind: "CharLit", node: n, span, value: e.value };
      case "StringLit": return { kind: "StringLit", node: n, span, value: e.value };
      case "Ident": return { kind: "Ident", node: n, span, name: e.name };
      case "BinOp": {
        const tagCompare = c.variantTagCompares.get(e);
        if (tagCompare) {
          const is = this.synForm(BOOL, x => ({ kind: "IsCheck", node: x, span, operand: tagCompare.operand, tag: tagCompare.tag }));
          if (e.op === "!=") return { kind: "UnaryOp", node: n, span, op: "!", operand: is };
          return this.rawForm(is, cx, n);
        }
        const resolvedOp = c.resolvedOperators.get(e);
        if (resolvedOp) {
          const args = [e.left, e.right].map(a => ({ expr: a, passByRef: !!c.autoBorrowed.get(a), refMut: false }));
          if (e.op === "!=") {
            const call = this.synForm(type, x => this.call(e, resolvedOp, args, false, x));
            return { kind: "UnaryOp", node: n, span, op: "!", operand: call };
          }
          return this.call(e, resolvedOp, args, false, n);
        }
        return { kind: "BinOp", node: n, span, op: e.op, left: e.left, right: e.right };
      }
      case "UnaryOp":
        // `&mut x` on a call argument is a marker the checker strips: transparent here.
        if (e.op === "&mut") return this.form(e.operand, cx);
        if (e.op === "*") {
          if (this.typeOf(e.operand)?.tag === "ptr") return { kind: "PtrDeref", node: n, span, operand: e.operand };
          return { kind: "HeapDeref", node: n, span, operand: e.operand };
        }
        return { kind: "UnaryOp", node: n, span, op: e.op, operand: e.operand };
      case "Call": return this.callForm(e, cx, n, type);
      case "StructLit": {
        const name = c.rewrittenStructLits.get(e) ?? e.name;
        return { kind: "StructLit", node: n, span, name, fields: e.fields.map(f => ({ name: f.name, value: f.value })), ...(e.base && { base: e.base }) };
      }
      case "FieldAccess": {
        // `f64.NAN` and friends: the literal of its IEEE bits.
        const fnc = floatNamespaceConst(e);
        if (fnc) return { kind: "FloatLit", node: n, span, value: fnc.value };
        const raw = this.typeOf(e.object);
        const ot = raw?.tag === "ref" ? raw.inner : raw;
        if (e.field === "len") {
          if (ot?.tag === "array") return { kind: "ArrayLen", node: n, span, object: e.object };
          if (ot?.tag === "string") return { kind: "StringLen", node: n, span, object: e.object };
          if (ot?.tag === "vec") return { kind: "VecLen", node: n, span, object: e.object };
          if (ot?.tag === "hashmap") return { kind: "HashMapLen", node: n, span, object: e.object };
        }
        return { kind: "FieldAccess", node: n, span, object: e.object, field: e.field };
      }
      case "ArrayLit": return { kind: "ArrayLit", node: n, span, elements: e.elements };
      case "ArrayRepeat": return { kind: "ArrayRepeat", node: n, span, value: e.value, count: e.count, cloneFn: c.arrayRepeatClones.get(e) };
      case "IndexAccess": return { kind: "IndexAccess", node: n, span, object: e.object, index: e.index, isBorrowed: c.borrowedExprs.has(e) };
      case "EnumLit": return this.enumLitForm(e, cx, n, type);
      case "Unwrap": {
        const ot = this.typeOf(e.operand);
        return { kind: "Unwrap", node: n, span, operand: e.operand, enumName: ot?.tag === "enum" ? ot.name : "" };
      }
      case "Propagate": {
        const ot = this.typeOf(e.operand);
        const msg = c.propagateMessages.get(e);
        return {
          kind: "Propagate", node: n, span, operand: e.operand, enumName: ot?.tag === "enum" ? ot.name : "", retType: cx.ret,
          fromConversion: c.propagateConversions.get(e), boxConversion: c.propagateBoxings.get(e),
          messageFn: msg === undefined ? undefined : { fn: this.concreteMethodFn(msg.name, "message"), errType: msg.errType },
        };
      }
      case "DefaultValue": {
        const ot = this.typeOf(e.operand);
        return { kind: "DefaultValue", node: n, span, operand: e.operand, default: e.default, enumName: ot?.tag === "enum" ? ot.name : "" };
      }
      case "CastExpr": return { kind: "Cast", node: n, span, operand: e.operand, targetType: type };
      case "MethodCall": return this.methodForm(e, cx, n, type);
      case "Closure": {
        const captures = c.closureCaptures.get(e) ?? [];
        const ft = c.exprTypes.get(e);
        const shares = c.sharedStringCaptures.get(e);
        // A thread closure that shares unsafe memory reports the replay hole when it starts
        // (the checker's checkThreadBoundary found it; std/replay says it once per run).
        const site = c.replayRawShares?.get(e);
        const report: Stmt[] = site && c.functions.has("replayHoleAt") ? [{ kind: "ExprStmt", span, expr: this.syn<Expr>({ kind: "Call", func: "replayHoleAt", args: [this.str("unsafe shared memory", span), this.str(site, span)], span }, { tag: "void" }) }] : [];
        return {
          kind: "Closure", node: n, span, ast: e,
          params: e.params.map((p, i) => ({ name: p.name, type: ft?.tag === "fn" ? ft.params[i] : { tag: "unknown" as const } })),
          body: report.length ? [...report, ...e.body] : e.body,
          // A string capture the checker made a share copies a counted handle into the env.
          captures: captures.map(cap => shares?.has(cap.name) ? { ...cap, share: true } : cap),
          retType: type.tag === "fn" ? type.ret : { tag: "void" },
          isMove: e.isMove,
          ...(c.keyExtractorClosures.has(e) && { keyExtractor: true }),
        };
      }
      case "RangeExpr": throw new Error("RangeExpr outside a for-in");
      case "IsExpr": {
        const ot = this.typeOf(e.operand);
        let tag = -1;
        if (e.pattern.kind === "EnumPattern" && ot?.tag === "enum") tag = c.enums.get(ot.name)?.variants.get(e.pattern.variant)?.tag ?? -1;
        return { kind: "IsCheck", node: n, span, operand: e.operand, tag };
      }
      case "IfExpr": {
        // A compile-time condition (@targetOs() == "...") keeps the taken arm alone.
        const folded = this.constBool(e.cond);
        if (folded !== null) {
          return { kind: "IfExpr", node: n, span, cond: this.syn({ kind: "BoolLit", value: true }, BOOL), thenBody: folded ? e.thenBody : e.elseBody, elseBody: [], folded: true };
        }
        return { kind: "IfExpr", node: n, span, cond: e.cond, thenBody: e.thenBody, elseBody: e.elseBody };
      }
      case "MatchExpr": {
        const m = this.matchSubject(e.subject);
        return { kind: "MatchExpr", node: n, span, subject: e.subject, arms: e.arms, ...m };
      }
    }
    // A missing arm would be a silent skip for every walk over the forms.
    const _exhaustive: never = e;
    throw new Error(`rawForm: unhandled expression kind ${(_exhaustive as { kind: string }).kind}`);
  }

  /** A match subject's enum, and how the checker said it is matched. */
  matchSubject(subject: Expr): { enumName: string; subjectIsRef: boolean; subjectIsMut: boolean } {
    let st = this.typeOf(subject);
    if (st?.tag === "ref" && st.inner.tag === "enum") st = st.inner;
    return { enumName: st?.tag === "enum" ? st.name : "", subjectIsRef: this.c.matchSubjectRef.has(subject), subjectIsMut: this.c.matchSubjectMut.has(subject) };
  }

  /**
   * A condition whose value is known at compile time because it rests entirely on literals
   * (the @targetOs() case: a string literal compared with one, and !, &&, || over those), or
   * null: the ordinary runtime path. Only literal operands fold, so no runtime condition is
   * ever short-circuited by accident.
   */
  constBool(e: Expr): boolean | null {
    const lit = (x: Expr): string | null => {
      if (x.kind === "StringLit") return x.value;
      if (x.kind === "Call" && (x.func === "targetOs" || x.func === "targetArch") && x.args.length === 0) return x.func === "targetOs" ? this.target.os : this.target.arch;
      return null;
    };
    if (e.kind === "BoolLit") return e.value;
    if (e.kind === "UnaryOp" && e.op === "!") { const v = this.constBool(e.operand); return v === null ? null : !v; }
    if (e.kind === "BinOp") {
      if (e.op === "&&" || e.op === "||") {
        const l = this.constBool(e.left), r = this.constBool(e.right);
        if (e.op === "&&") return l === false || r === false ? false : l === true && r === true ? true : null;
        return l === true || r === true ? true : l === false && r === false ? false : null;
      }
      if ((e.op === "==" || e.op === "!=") && !this.c.resolvedOperators.has(e)) {
        const l = lit(e.left), r = lit(e.right);
        if (l !== null && r !== null) return e.op === "==" ? l === r : l !== r;
        const lb = this.constBool(e.left), rb = this.constBool(e.right);
        if (lb !== null && rb !== null) return e.op === "==" ? lb === rb : lb !== rb;
      }
    }
    return null;
  }

  private callForm(e: Expr & { kind: "Call" }, cx: FormCtx, n: Node, type: TypeKind): Form {
    const c = this.c, span = e.span, a = e.args;
    const old = cx.old?.(e);
    if (old !== undefined) return { kind: "Ident", node: n, span, name: old };
    if (VEC_INTRINSICS.has(e.func) && isVecModule(span?.file)) {
      switch (e.func) {
        case "_vecCopyOut": return { kind: "MapCopyOut", node: n, span, value: a[0] };
        case "_vecForget": return { kind: "Forget", node: n, span, value: a[0] };
        case "_vecNonNegative": return { kind: "NonNegative", node: n, span, value: a[0], what: "capacity" };
        case "_vecGrowBuf": return { kind: "VecGrowBuf", node: n, span, data: a[0], len: a[1], cap: a[2], elementType: type.tag === "ptr" ? type.inner : { tag: "unknown" } };
        case "_vecPanic": return { kind: "VecPanic", node: n, span, message: a[0]?.kind === "StringLit" ? a[0].value : "" };
        default: return { kind: "NatLess", node: n, span, a: a[0], b: a[1] };
      }
    }
    if (STR_INTRINSICS.has(e.func) && isStringModule(span?.file)) {
      switch (e.func) {
        case "_strRangeCheck": return { kind: "StrRangeCheck", node: n, span, str: a[0], start: a[1], end: a[2] };
        case "_strReserve": return { kind: "StrReserve", node: n, span, str: a[0], extra: a[1] };
        case "_strUnique": return { kind: "StrUnique", node: n, span, str: a[0] };
        case "_strAlloc": return { kind: "StrAlloc", node: n, span, size: a[0] };
        default: {
          const lit = (i: number) => { const x = a[i]; return x?.kind === "StringLit" ? x.value : ""; };
          return { kind: "StrPanic", node: n, span, head: lit(0), value: a[1], tail: lit(2) };
        }
      }
    }
    if (MAP_INTRINSICS.has(e.func) && isHashMapModule(span?.file)) {
      switch (e.func) {
        case "_mapCopyOut": return { kind: "MapCopyOut", node: n, span, value: a[0] };
        case "_mapSeed": return { kind: "MapSeed", node: n, span };
        case "_mapAlloc": return { kind: "MapAlloc", node: n, span, count: a[0], size: a[1] };
        case "_mapHash": return { kind: "MapHash", node: n, span, key: a[0], seed: a[1] };
        default: return { kind: "MapKeyEq", node: n, span, a: a[0], b: a[1] };
      }
    }
    if (e.func === "sizeOf" || e.func === "offsetOf" || e.func === "zeroed") {
      const t = c.sizeOfTypes.get(e);
      if (!t) throw new Error(`${e.func}: missing resolved type`);
      if (e.func === "sizeOf") return { kind: "SizeOf", node: n, span, sizeType: t };
      if (e.func === "zeroed") return { kind: "Zeroed", node: n, span, zeroType: t };
      const fieldName = c.offsetOfFields.get(e);
      if (!fieldName) throw new Error("offsetOf: missing field name");
      return { kind: "OffsetOf", node: n, span, sizeType: t, fieldName };
    }
    // Gated exactly as the checker gates them (name + the one module).
    if (RAW_SLICE_INTRINSICS.has(e.func) && isForeignModule(span?.file)) {
      return { kind: "RawSlice", node: n, span, ptr: a[0], len: a[1], elementType: type.tag === "ref" && type.inner.tag === "array" ? type.inner.element : { tag: "unknown" } };
    }
    if (ADOPT_INTRINSICS.has(e.func) && isForeignModule(span?.file)) {
      return { kind: "Adopt", node: n, span, ptr: a[0], ...(e.func === "adoptVec" && { len: a[1] }) };
    }
    if (e.func === "Heap") return { kind: "HeapCreate", node: n, span, value: a[0] };
    // Memory intrinsics: a user fn of the same name wins, as in the checker.
    if (e.func === "forget" && !this.shadowed("forget")) return { kind: "Forget", node: n, span, value: a[0] };
    if (e.func === "isNull" && !this.shadowed("isNull")) {
      // A null compare on the thin code pointer: `p as i64 == 0`.
      const cast = this.synForm(I64, x => ({ kind: "Cast", node: x, span, operand: a[0], targetType: I64 }));
      return { kind: "BinOp", node: n, span, op: "==", left: cast, right: this.int(0n) };
    }
    if (e.func === "replace" && !this.shadowed("replace")) return { kind: "MemReplace", node: n, span, place: a[0], value: a[1] };
    if (e.func === "swap" && !this.shadowed("swap")) return { kind: "MemSwap", node: n, span, a: a[0], b: a[1] };
    if (e.func === "embedFile") return { kind: "StringLit", node: n, span, value: this.embed(e) };
    // Compile-time constants: the target being built for.
    if (e.func === "targetOs") return { kind: "StringLit", node: n, span, value: this.target.os };
    if (e.func === "targetArch") return { kind: "StringLit", node: n, span, value: this.target.arch };
    if (e.func === "jsonStringify") return { kind: "JsonStringify", node: n, span, value: a[0], valueType: this.typeOf(a[0]) ?? { tag: "unknown" } };
    const cfn = c.cfnCalls.get(e);
    if (cfn) return { kind: "CFnCall", node: n, span, callee: this.syn({ kind: "Ident", name: e.func, span }, cfn), args: a.map(x => this.arg(x)) };
    const clo = c.closureCalls.get(e);
    if (clo) return { kind: "ClosureCall", node: n, span, callee: this.syn({ kind: "Ident", name: e.func, span }, clo), args: a.map(x => this.arg(x)) };
    const rr = c.replaySites?.get(e);
    const resolved = rr?.wrapper ?? c.rewrittenCalls.get(e) ?? e.func;
    const func = cx.callee ? cx.callee(e, resolved) : resolved;
    const args = a.map(x => this.arg(x));
    if (rr) {
      // A record/replay wrapper (src/replay-externs.ts): a variadic tail arrives widened to
      // i64, and the last param is the call site a hole report names.
      const wargs: Arg[] = args.map((x, i) => rr.fixed !== undefined && i >= rr.fixed
        ? { ...x, expr: this.synForm(I64, y => ({ kind: "Cast", node: y, span: this.ast(x.expr).span, operand: x.expr, targetType: I64 })) } : x);
      wargs.push({ expr: this.str(rr.site, span), passByRef: false, refMut: false });
      // The off test is made here, at the call site, as a load of std/replay's mode word: the
      // wrapper usually lands in another codegen unit, where clang cannot inline it. Only one
      // branch runs, so each arg is evaluated once. std/replay's private globals carry its
      // module prefix (src/mangle.ts).
      const modeWord = ["replay$rrMode", "rrMode"].find(m => c.globalTypes?.has(m));
      if (modeWord) {
        const direct = this.synForm(type, x => this.call(e, e.func, args, c.functions.get(e.func)?.variadic ?? false, x));
        const recorded = this.synForm(type, x => this.call(e, func, wargs, false, x));
        const cond = this.syn<Expr>({ kind: "BinOp", op: "==", left: this.syn({ kind: "Ident", name: modeWord, span }, I64), right: this.syn({ kind: "IntLit", value: 1n }, I64), span }, BOOL);
        return { kind: "IfExpr", node: n, span, cond, thenBody: [{ kind: "ExprStmt", expr: direct, span }], elseBody: [{ kind: "ExprStmt", expr: recorded, span }] };
      }
      return this.call(e, func, wargs, false, n);
    }
    return this.call(e, func, args, c.functions.get(resolved)?.variadic ?? false, n);
  }

  private embed(e: Expr & { kind: "Call" }): string {
    const path = (e.args[0] as { value: string }).value;
    // Relative to the file containing the call, not the entry file: a module embedding
    // "lib/x.js" means its own lib/x.js wherever it was imported from.
    const callerDir = e.span?.file ? dirname(e.span.file) : this.target.sourceDir;
    const absPath = resolve(callerDir, path);
    if (!existsSync(absPath)) throw new Error(`error[embed]: ${e.span?.line}:${e.span?.col}: cannot open '${path}'`);
    // One call embeds one file, by design: the embedded assets stay visible in the source.
    if (statSync(absPath).isDirectory()) throw new Error(`error[embed]: ${e.span?.line}:${e.span?.col}: '${path}' is a directory — @embedFile embeds one file; call it once per file`);
    // Bytes, not UTF-8 (a decode would corrupt a binary): bytes >= 0x80 ride the U+F7xx
    // sentinel `\xNN` escapes use, which codegen emits back as raw bytes. Built in chunks:
    // `+=` per byte is quadratic on a multi-megabyte asset, and 8192 stays under the
    // argument-count limit of fromCharCode.
    const bytes = readFileSync(absPath);
    const codes = new Uint16Array(bytes.length);
    let k = 0;
    for (const b of bytes) codes[k++] = b < 0x80 ? b : 0xF700 + b;
    let out = "";
    for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode(...codes.subarray(i, i + 8192));
    return out;
  }

  private enumLitForm(e: Expr & { kind: "EnumLit" }, cx: FormCtx, n: Node, type: TypeKind): Form {
    const c = this.c, span = e.span;
    if (e.enumName === "Vec" && e.variant === "new" && type.tag === "vec") return { kind: "VecNew", node: n, span, elementType: type.element };
    // A negative capacity panics at the caller's line, as the builtin did, so the check rides
    // the argument here rather than living in std's constructors.
    const ctor = c.staticCalls.get(e);
    const vecCtor = e.enumName === "Vec" && (e.variant === "withCapacity" || e.variant === "filled") && type.tag === "vec";
    const strCtor = e.enumName === "String" && e.variant === "withCapacity" && type.tag === "string";
    if (ctor && (vecCtor || strCtor || (e.enumName === "HashMap" && e.variant === "withCapacity" && type.tag === "hashmap"))) {
      const a0 = e.args[0];
      const t0 = this.typeOf(a0);
      const widened = t0?.tag === "int" && (t0.bits !== 64 || !t0.signed)
        ? this.synForm(I64, x => ({ kind: "Cast", node: x, span: a0.span, operand: a0, targetType: I64 })) : a0;
      const what = e.variant === "filled" ? "length" : "capacity";
      const count = this.synForm(I64, x => ({ kind: "NonNegative", node: x, span, value: widened, what }));
      const args: Arg[] = [{ expr: count, passByRef: false, refMut: false }];
      if (e.variant === "filled") args.push({ expr: e.args[1], passByRef: false, refMut: false });
      return this.call(e, cx.callee ? cx.callee(e, ctor) : ctor, args, false, n);
    }
    // `Kind.tryFrom(n)` -> Option<Kind>; `type` is the Option the checker inferred.
    const repr = c.enums.get(e.enumName);
    if (e.variant === "tryFrom" && repr?.reprType && type.tag === "enum") {
      return { kind: "EnumTryFrom", node: n, span, enumName: e.enumName, optionEnumName: type.name, value: e.args[0], discriminants: [...repr.variants.values()].map(v => v.tag) };
    }
    const callee = c.rewrittenCalls.get(e) ?? c.staticCalls.get(e);
    if (callee) return this.call(e, cx.callee ? cx.callee(e, callee) : callee, e.args.map(x => this.arg(x)), c.functions.get(callee)?.variadic ?? false, n);
    return { kind: "EnumLit", node: n, span, enumName: c.rewrittenEnums.get(e) ?? e.enumName, variant: e.variant, args: e.args };
  }

  private methodForm(e: Expr & { kind: "MethodCall" }, cx: FormCtx, n: Node, type: TypeKind): Form {
    const c = this.c, span = e.span, m = e.method;
    const raw = this.typeOf(e.object);
    const otRaw = raw?.tag === "ref" ? raw.inner : raw;
    // A slice shares the Vec representation, so the read-only combinators lower through the
    // Vec forms unchanged; the checker and this must use the same whitelist.
    const fixedArray = otRaw?.tag === "array" && otRaw.size !== null && ARRAY_COMBINATORS.has(m);
    // A Vec-shaped combinator's receiver. A FIXED array is wrapped in a full-range slice
    // first: `[N x T]` is an inline layout and every Vec form expects the header view.
    const recv = (): Node => {
      if (!fixedArray || otRaw?.tag !== "array" || otRaw.size === null) return e.object;
      const at = otRaw;
      const vt: TypeKind = { tag: "vec", element: at.element };
      // A literal receiver has no storage to slice: it is the Vec temporary it would be in
      // argument position, which the combinator frees once done with it.
      if (e.object.kind === "ArrayLit" && !this.layers(e.object).length) return this.synForm(vt, x => ({ kind: "ArrayLit", node: x, span: e.object.span, elements: (e.object as Expr & { kind: "ArrayLit" }).elements }));
      return this.synForm({ tag: "array", element: at.element, size: null }, x => ({ kind: "VecSlice", node: x, span, vec: e.object, start: this.int(0n), end: this.int(BigInt(at.size!)), elementType: at.element }));
    };
    const ot = otRaw?.tag === "array" && (otRaw.size === null ? SLICE_COMBINATORS.has(m) : ARRAY_COMBINATORS.has(m))
      ? { tag: "vec" as const, element: otRaw.element } : otRaw;
    const o = e.object, a = e.args;
    // x.addrOf(): the address of a place.
    if (m === "addrOf") return { kind: "UnaryOp", node: n, span, op: "&", operand: o };
    if (ot?.tag === "vec" && m === "ptr") return { kind: "VecPtr", node: n, span, object: o };
    if (ot?.tag === "heap" && m === "ptr" && !c.heapMethodReceivers.has(e)) return { kind: "HeapPtr", node: n, span, object: o };
    if ((ot?.tag === "int" || ot?.tag === "float") && m === "toString") return { kind: "NumberToString", node: n, span, value: o, valueType: ot };
    const base = ot?.tag === "enum" ? c.enums.get(ot.name)?.baseName : undefined;
    if (ot?.tag === "enum" && base === "Option") {
      // take() is replace(place, None): the checker vetted the place as replace's.
      if (m === "take") {
        const none = this.syn<Expr>({ kind: "EnumLit", enumName: ot.name, variant: "None", args: [], span }, ot);
        return { kind: "MemReplace", node: n, span, place: o, value: none };
      }
      if (["isSome", "isNone", "unwrapOr", "unwrapOrElse", "map", "andThen", "orElse"].includes(m)) {
        // Option-qualified names: the Result versions share the method name, not the codegen.
        const op = m === "andThen" ? "optionAndThen" : m === "orElse" ? "optionOrElse" : m;
        return { kind: "OptionOp", node: n, span, op, value: o, ...(m !== "isSome" && m !== "isNone" && { default: a[0] }), enumName: ot.name };
      }
    }
    if (ot?.tag === "enum" && base === "Result") {
      // Ok is tag 0 like Some, so isOk is the isSome test and isErr isNone.
      if (m === "isOk" || m === "isErr" || m === "unwrapOr") {
        return { kind: "OptionOp", node: n, span, op: m === "isOk" ? "isSome" : m === "isErr" ? "isNone" : "unwrapOr", value: o, ...(m === "unwrapOr" && { default: a[0] }), enumName: ot.name };
      }
      // Result's callback is handed the Err payload.
      if (m === "unwrapOrElse") return { kind: "OptionOp", node: n, span, op: "resultUnwrapOrElse", value: o, default: a[0], enumName: ot.name };
      if (m === "context") {
        this.usedContext = true;
        return { kind: "OptionOp", node: n, span, op: "resultContext", value: o, default: a[0], boxConversion: c.contextBoxings.get(e), enumName: ot.name };
      }
      // Their own ops: each copies the untouched side's payload through to the result enum.
      if (m === "map" || m === "mapErr" || m === "andThen" || m === "orElse") {
        const op = m === "map" ? "resultMap" : m === "mapErr" ? "resultMapErr" : m === "andThen" ? "resultAndThen" : "resultOrElse";
        return { kind: "OptionOp", node: n, span, op, value: o, default: a[0], enumName: ot.name };
      }
    }
    if (ot?.tag === "int") {
      const bits: Record<string, string> = { countOnes: "ctpop", leadingZeros: "ctlz", trailingZeros: "cttz", reverseBits: "bitreverse" };
      if (bits[m]) return { kind: "BitIntrinsic", node: n, span, intrinsic: bits[m], value: o };
      if (m === "rotateLeft" || m === "rotateRight") return { kind: "BitIntrinsic", node: n, span, intrinsic: m === "rotateLeft" ? "fshl" : "fshr", value: o, amount: a[0] };
      const optName = () => type.tag === "enum" ? type.name : "Option_" + (ot.signed ? "i" : "u") + ot.bits;
      // x.wrappingNeg() / x.checkedNeg(): wrapping/checked sub(0, x).
      if (m === "wrappingNeg" || m === "checkedNeg") {
        const zero = this.syn<Expr>({ kind: "IntLit", value: 0n, span }, ot);
        if (m === "wrappingNeg") return { kind: "WrappingArith", node: n, span, op: "sub", left: zero, right: o };
        return { kind: "CheckedArith", node: n, span, op: "sub", left: zero, right: o, optionEnumName: optName() };
      }
      const opMap: Record<string, string> = {
        wrappingAdd: "add", wrappingSub: "sub", wrappingMul: "mul", saturatingAdd: "add", saturatingSub: "sub", saturatingMul: "mul",
        checkedAdd: "add", checkedSub: "sub", checkedMul: "mul", checkedDiv: "div", checkedRem: "rem",
      };
      const op = opMap[m];
      if (op) {
        if (m.startsWith("wrapping")) return { kind: "WrappingArith", node: n, span, op, left: o, right: a[0] };
        if (m.startsWith("saturating")) return { kind: "SaturatingArith", node: n, span, op, left: o, right: a[0] };
        return { kind: "CheckedArith", node: n, span, op, left: o, right: a[0], optionEnumName: optName() };
      }
    }
    // Slices (`v[a..b]`) are arrays of size null whose runtime form is a non-owning Vec header.
    if ((ot?.tag === "vec" || ot?.tag === "array") && m === "slice") return { kind: "VecSlice", node: n, span, vec: recv(), start: a[0], end: a[1], elementType: ot.element };
    if (ot?.tag === "array" && ot.size === null && m === "len") return { kind: "ArrayLen", node: n, span, object: o };
    if (ot?.tag === "vec") {
      if (m === "len") return { kind: "VecLen", node: n, span, object: o };
      if (m === "get") return { kind: "VecGetOpt", node: n, span, object: o, index: a[0], elementType: ot.element, optionEnumName: type.tag === "enum" ? type.name : "" };
      if (m === "capacity") return { kind: "VecCapacity", node: n, span, object: o };
    }
    if (ot?.tag === "hashmap" && m === "len") return { kind: "HashMapLen", node: n, span, object: o };
    if (ot?.tag === "string") {
      if (m === "pushStr") return { kind: "StringPushStr", node: n, span, str: o, other: a[0] };
      if (m === "pushInt") return { kind: "StringPushInt", node: n, span, str: o, value: a[0] };
      if (m === "slice") return { kind: "StringSlice", node: n, span, str: o, start: a[0], end: a[1] };
      if (m === "len") return { kind: "StringLen", node: n, span, object: o };
      if (m === "cstr") return { kind: "StringCstr", node: n, span, object: o };
      const fn = STR_METHODS[m];
      if (fn) {
        // Receiver and args by reference, but the int of repeat/padStart/padEnd/charAt (its
        // first user arg) and indexOfFrom's `from` (its second) by value.
        const args: Arg[] = [o, ...a].map(x => ({ expr: x, passByRef: true, refMut: false }));
        if ((m === "repeat" || m === "padStart" || m === "padEnd" || m === "charAt") && args.length > 1) args[1] = { ...args[1], passByRef: false };
        if (m === "indexOfFrom" && args.length > 2) args[2] = { ...args[2], passByRef: false };
        return this.call(e, fn, args, false, n);
      }
    }
    const iface = c.interfaceMethodCalls.get(e);
    if (iface) return { kind: "InterfaceMethodCall", node: n, span, object: o, ifaceName: iface.ifaceName, methodIndex: iface.methodIndex, args: a.map(x => this.arg(x)) };
    const resolved = c.resolvedMethods.get(e);
    if (resolved) {
      const sig = must(c.functions, resolved, "functions");
      const heapRecv = c.heapMethodReceivers.has(e);
      const args: Arg[] = [o, ...a].map((x, i) => {
        const b = this.borrow(x);
        let v: Node = i === 0 && fixedArray ? recv() : x;
        // A scoped task's by-reference literal is created in the Task.scope body's frame,
        // which returns before the scope joins the task: its env goes on the heap, and the
        // task's reap frees it.
        if (resolved === SCOPED_SPAWN_FN && x.kind === "Closure" && !x.isMove && !this.layers(x).length) {
          const lit = x;
          v = this.synForm(this.ty(x), y => ({ ...(this.rawForm(lit, cx, y) as FormOf<"Closure">), heapEnv: true }));
        }
        const json = c.autoJsonStringify.get(x);
        if (json) {
          const codec = c.autoJsonToJson.get(x);
          const inner = v;
          v = codec
            ? this.synForm(STRING, y => ({ kind: "Call", node: y, span: x.span, func: codec, args: [{ expr: inner, passByRef: true, refMut: false }], variadic: false }))
            : this.synForm(STRING, y => ({ kind: "JsonStringify", node: y, span: x.span, value: inner, valueType: json }));
        }
        // `h.m()` on a Heap<T> receiver means `(*h).m()`.
        if (i === 0 && heapRecv) {
          const ht = this.typeOf(o);
          const inner = ht?.tag === "heap" ? ht.inner : ht?.tag === "ref" && ht.inner.tag === "heap" ? ht.inner.inner : this.ty(v);
          const box = v;
          v = this.synForm(inner, y => ({ kind: "HeapDeref", node: y, span: x.span, operand: box }));
          if (!b) this.synMoves.add(this.ast(v));
        }
        // A std Vec method takes an i64 index where the builtin rules accepted any int.
        const pt = sig.params[i]?.type, vt = this.ty(v);
        if (pt?.tag === "int" && vt.tag === "int" && !b && (pt.bits !== vt.bits || pt.signed !== vt.signed)) {
          const to: TypeKind = { tag: "int", bits: pt.bits, signed: pt.signed };
          const from = v;
          v = this.synForm(to, y => ({ kind: "Cast", node: y, span: x.span, operand: from, targetType: to }));
        }
        return { expr: v, passByRef: !!b, refMut: b?.mutable ?? false };
      });
      return this.call(e, cx.callee ? cx.callee(e, resolved) : resolved, args, false, n);
    }
    // A C fn-pointer field: an indirect call through the one word it holds, no env.
    if (c.cfnFieldCalls.has(e)) {
      const callee = this.synForm({ tag: "cfn", params: [], ret: type }, y => ({ kind: "FieldAccess", node: y, span, object: o, field: m }));
      return { kind: "CFnCall", node: n, span, callee, args: a.map(x => this.arg(x)) };
    }
    if (c.fnFieldCalls.has(e)) {
      const callee = this.synForm({ tag: "fn", params: [], ret: type }, y => ({ kind: "FieldAccess", node: y, span, object: o, field: m }));
      return { kind: "ClosureCall", node: n, span, callee, args: a.map(x => this.arg(x)) };
    }
    // `.clone()` on a Copy scalar is the identity (one spelling for generic code).
    if (m === "clone" && a.length === 0) return this.form(o, cx);
    throw new Error(`unsupported method call: ${m}`);
  }

  /** The match pattern `p` over enum `enumName`. */
  pattern(p: Pattern, enumName: string): Pat {
    if (p.kind === "WildcardPattern") return { kind: "WildcardPattern" };
    if (p.kind === "LiteralPattern") return { kind: "LiteralPattern", value: p.value, literalKind: p.literalKind };
    const info: EnumInfo | undefined = this.c.enums.get(enumName);
    const variant = info?.variants.get(p.variant);
    if (isNestedPattern(p) && enumName) {
      const bindings: (Pat & { kind: "EnumPattern" })["bindings"] = [];
      const tests: PatTest[] = [];
      // Depth first, left to right: the order patternLeafNames lists the bindings in.
      const walk = (q: Pattern & { kind: "EnumPattern" }, en: string, path: PatStep[]) => {
        const v = this.c.enums.get(en)?.variants.get(q.variant);
        q.bindings.forEach((name, i) => {
          const ft = v?.fields[i] ?? { tag: "unknown" as const };
          const at = [...path, { enumName: en, variant: q.variant, index: i }];
          const sub = q.args?.[i];
          if (!sub) { bindings.push({ name, type: ft, path: at }); return; }
          if (sub.kind === "EnumPattern" && ft.tag === "enum") {
            tests.push({ kind: "tag", path: at, enumName: ft.name, tag: this.c.enums.get(ft.name)?.variants.get(sub.variant)?.tag ?? 0 });
            walk(sub, ft.name, at);
          } else if (sub.kind === "LiteralPattern") {
            tests.push({ kind: "lit", path: at, value: sub.value, literalKind: sub.literalKind, type: ft });
          }
        });
      };
      walk(p, enumName, []);
      return { kind: "EnumPattern", variant: p.variant, bindings, tag: variant?.tag ?? 0, tests };
    }
    return { kind: "EnumPattern", variant: p.variant, bindings: p.bindings.map((name, i) => ({ name, type: variant?.fields[i] ?? { tag: "unknown" as const } })), tag: variant?.tag ?? 0 };
  }

  /** A param's type as the body sees it: a by-ref param's is the pointee. */
  param(p: import("./ast").Param, sigType: TypeKind | undefined): { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean } {
    const pt = declaredType(p);
    const resolved = sigType ?? typeFromAst(pt);
    return {
      name: p.name,
      type: resolved.tag === "ref" ? resolved.inner : resolved,
      // A `?&mut T` is the raw `T *` the ABI passes: the reference appears at its unwrap.
      isRef: pt.isRef && !pt.isNullableRef,
      isRefMut: pt.isRefMut && !pt.isNullableRef,
    };
  }
}

// String methods delegated to std/string runtime functions.
const STR_METHODS: Record<string, string> = {
  contains: "strContains", startsWith: "strStartsWith", endsWith: "strEndsWith", split: "strSplit", trim: "strTrim",
  trimStart: "strTrimStart", trimEnd: "strTrimEnd", toLower: "strToLower", toUpper: "strToUpper", reverse: "strReverse",
  replace: "strReplace", replaceFirst: "strReplaceFirst", repeat: "strRepeat", padStart: "strPadStart", padEnd: "strPadEnd",
  isEmpty: "strIsEmpty", charAt: "strCharAt", parseInt: "strParseInt", parseF64: "strParseF64",
  splitWords: "strSplitWords", splitWhitespace: "strSplitWhitespace",
};

/** The direct callee every Call form of `e` names, through the forms (for walks over bodies). */
export function directCallee(fx: Facts, e: Expr, cx: FormCtx): string | null {
  if (e.kind !== "Call" && e.kind !== "MethodCall" && e.kind !== "EnumLit" && e.kind !== "BinOp") return null;
  try {
    const f = fx.form(e, cx);
    return f.kind === "Call" ? f.func : null;
  } catch { return null; }
}

const EXPR_KINDS = new Set(["IntLit", "FloatLit", "BoolLit", "StringLit", "CharLit", "Ident", "BinOp", "UnaryOp", "Call", "StructLit",
  "FieldAccess", "ArrayLit", "ArrayRepeat", "IndexAccess", "EnumLit", "Unwrap", "Propagate", "DefaultValue", "CastExpr", "MethodCall",
  "Closure", "RangeExpr", "IsExpr", "IfExpr", "MatchExpr", "$peel"]);

/**
 * Every form reachable from `root` (statements, expressions, or lists of them) and every
 * statement on the way, in source order, through the forms' operands: what the analyses
 * over a body walk, seeing each call the emitter will print. `visit` returning "skip"
 * stops the descent below that form (a closure an analysis walks on its own).
 */
export function walkForms(root: unknown, fx: Facts, cx: FormCtx, visit: (x: Form | Stmt) => void | "skip"): void {
  const node = (n: Node) => {
    let f: Form;
    try { f = fx.form(n, cx); } catch { return; }
    if (visit(f) === "skip") return;
    for (const k in f) {
      if (k === "node" || k === "span" || k === "ast") continue;
      any((f as Record<string, unknown>)[k]);
    }
  };
  const any = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) any(x); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.kind === "string") {
      if (o.kind.endsWith("Pattern")) return;
      if (EXPR_KINDS.has(o.kind)) { node(o as unknown as Node); return; }
      if (typeof o.tag === "string") return;
      if (visit(o as unknown as Stmt) === "skip") return;
    } else if (typeof o.tag === "string") return; // a TypeKind
    for (const k in o) if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType" && k !== "typeArgs") any(o[k]);
  };
  any(root);
}

/**
 * Every node of an expression or statement tree, the checker's coercion layers not
 * included, in source order: what the analyses over bodies walk. Closure bodies included.
 */
export function walkAst(node: unknown, visit: (n: Expr | Stmt) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) walkAst(x, visit); return; }
  const n = node as Record<string, unknown>;
  // Types (MiloType) and patterns hold no expressions.
  if (typeof n.kind === "string") {
    if (n.kind.endsWith("Pattern")) return;
    visit(n as unknown as Expr | Stmt);
  }
  for (const k in n) if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType" && k !== "typeArgs") walkAst(n[k], visit);
}
