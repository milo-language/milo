// Ownership facts emit-mlir asks of an expression's form (src/emit-forms.ts): which
// expressions are owned temporaries (discarding one must drop it), whether an if/match used
// as a value owns its result, and whether a closure handed to a parameter can outlive the call.
import type { Expr, MatchArm, Stmt } from "./ast";
import type { FnDecl } from "./backend-program";
import type { Facts, Form, FormCtx, FormOf, Node } from "./emit-forms";
import type { TypeKind } from "./types";
import type { Layout } from "./layout";

function armTail(body: Stmt[]): Expr | null {
  const last = body[body.length - 1];
  return last && last.kind === "ExprStmt" ? last.expr : null;
}

// The names a match arm declares itself: its pattern's bindings (owned unless the
// subject is matched by reference) and its top-level `let`s.
function matchArmLocals(arm: MatchArm, subjectIsRef: boolean): Set<string> {
  const out = new Set<string>();
  if (arm.pattern.kind === "EnumPattern" && !subjectIsRef) for (const b of arm.pattern.bindings) out.add(b);
  for (const st of arm.body) if (st.kind === "LetDecl" || st.kind === "VarDecl") out.add(st.name);
  return out;
}

// Every form kind that is NOT an owned temporary: it yields a scalar, a void, a borrowed
// view, or a place someone else already owns, so discarding its result frees nothing and
// drop glue must not run on it.
//
// Listed rather than left as the implicit `false` at the bottom of `isOwnedTempExpr`,
// because implicit is exactly how `VecRemove` was missed: it moves an element out of the
// buffer like its sibling `VecPop`, `VecPop` was in the list and it was not, and
// `v.remove(0)` as a statement therefore destroyed nothing. `tests/ownedTempCoverage.test.ts`
// requires every kind in `Form` to appear either here or in `isOwnedTempExpr`, so a
// newly added form cannot inherit an answer nobody chose.
export const NOT_OWNED_TEMP: readonly string[] = [
  "ArrayLen", "ArrayRepeat", "BitIntrinsic", "BoolLit", "CFnCall", "Cast",
  "CharLit", "CheckedArith", "Closure", "EnumTryFrom", "FloatLit",
  "Forget", "HashMapLen",
  "HeapCreate", "HeapPtr", "Ident",
  "IntLit", "InterfaceCoerce", "IsCheck", "MapAlloc", "MapHash", "MapKeyEq", "MapSeed", "MemSwap", "NatLess", "NonNegative", "VecGrowBuf", "VecPanic", "OffsetOf",
  "PtrDeref", "RangeCheck", "RawSlice", "SaturatingArith", "SizeOf", "StringCstr",
  "StrRangeCheck", "StringLen", "StringLit", "StrAlloc", "StrPanic", "StrReserve", "StrUnique", "StringPushInt", "StringPushStr", "StringSlice",
  "UnaryOp", "VecCapacity",
  "VecLen", "VecPtr",
  "VecSlice",
  "WrappingArith", "Zeroed",
];

// What these facts are asked about sits in no particular body: no `?` here returns.
const ANY: FormCtx = { ret: { tag: "void" } };

export class Ownership {
  private closureParamEscapeCache = new Map<string, boolean>();
  constructor(private readonly layout: Layout, private readonly fns: ReadonlyMap<string, FnDecl>, private readonly fx: Facts) {}

  private f(n: Node): Form { return this.fx.form(n, ANY); }
  private ty(n: Node): TypeKind { return this.fx.ty(n); }
  private moved(f: Form): boolean { return this.fx.moved(this.fx.ast(f.node)); }

  // Big aggregates must never become first-class SSA values: SROA rewrites any
  // whole-aggregate load/store touching an alloca into per-ELEMENT scalar ops
  // with no size cap, so one `load %Bus` of a struct holding a [61440 x i32]
  // framebuffer becomes ~1M IR instructions and -O2 never finishes (the NES
  // emulator's -O2 build went from unbounded to seconds with this). Threshold
  // matches ZERO_STORE_MEMSET_THRESHOLD: memcpy/sret is never worse.
  static readonly BIG_AGG_THRESHOLD = 128;
  isBigAgg(ty: string): boolean {
    return (ty.startsWith("%") || ty.startsWith("[")) && this.layout.typeSize(ty) >= Ownership.BIG_AGG_THRESHOLD;
  }
  // Does `fnName`'s parameter `idx` outlive the call — is there anything that could still
  // reach the closure passed to it once the call returns?
  //
  // This is what decides who frees a `move` closure's malloc'd environment. An owning fn
  // type is not Copy, so the call site relinquishes the closure and stops dropping it; the
  // callee cannot pick the job up either, because the parameter is declared with the
  // NON-owning `(T) => R` and so is Copy from the checker's point of view — `fn outer(f) {
  // inner(f) inner(f) }` forwards the same environment twice and no alive flag is cleared.
  // So the caller keeps ownership and frees after the call, which needs exactly this
  // question answered: nothing else may be holding the closure by then.
  //
  // Fail closed everywhere the answer is not obvious (extern, indirect/interface dispatch,
  // recursion, a builtin higher-order form): "escapes" means nobody frees, which is the
  // leak we have today, while a wrong "does not escape" is a double free.

  closureParamEscapes(fnName: string, idx: number, seen: Set<string> = new Set()): boolean {
    const key = `${fnName}#${idx}`;
    const memo = this.closureParamEscapeCache.get(key);
    if (memo !== undefined) return memo;
    if (seen.has(key)) return true;
    seen.add(key);
    const fn = this.fns.get(fnName);
    const param = fn?.params[idx];
    if (!fn || fn.isExtern || !fn.ast || !param || param.isRef || param.isRefMut) return true;
    // A parameter declared `move (…) => R` is owning, so the callee already registers it as
    // a droppable local and frees it at every exit. Treat that as an escape: it is the one
    // case where somebody else is doing the job, and dropping again in the caller is a
    // double free (`fn call(f: move () => i64)`, tests/fixtures/closureCapturesDropped).
    if (param.type.tag === "fn" && param.type.owning === true) return true;
    const escapes = this.paramEscapesBody(fn.ast.body, param.name, seen);
    this.closureParamEscapeCache.set(key, escapes);
    return escapes;
  }

  // Whether `body` lets its parameter `paramName` (a closure) outlive the call: stores it,
  // returns it, captures it, or forwards it anywhere that does. A call of the parameter
  // itself (`f(…)`) names it as its callee, not as an operand: called and forgotten.
  private paramEscapesBody(body: Stmt[], paramName: string, seen: Set<string>): boolean {
    let escapes = false;
    const isParam = (n: Node) => n.kind === "Ident" && n.name === paramName;
    const walk = (node: unknown): void => {
      if (escapes || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: string };
      if (typeof n.kind === "string" && n.kind.endsWith("Pattern")) return;
      // A nested closure that CAPTURES it keeps a copy of the {fn, env} pair, and that copy
      // can outlive this frame (`return move () => f(1)`). The capture is recorded by name,
      // so walking the nested body alone would miss it when that body only calls it.
      if (n.kind === "Closure" && (this.fx.c.closureCaptures.get(n as unknown as Expr) ?? []).some(c => c.name === paramName)) { escapes = true; return; }
      // Forwarding: `fn outer(g) { inner(g) }` keeps `g` only if `inner` does. Without this
      // a one-line wrapper would be indistinguishable from a store.
      if (n.kind === "Call" || n.kind === "MethodCall" || n.kind === "EnumLit") {
        let form: Form | null = null;
        try { form = this.f(n as unknown as Expr); } catch { form = null; }
        if (form?.kind === "Call") {
          form.args.forEach((a, i) => {
            if (escapes) return;
            if (isParam(a.expr)) { if (this.closureParamEscapes(form!.func, i, seen)) escapes = true; }
            else walk(a.expr);
          });
          return;
        }
      }
      if (n.kind === "Ident" && n.name === paramName) { escapes = true; return; }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType") walk(n[k]); }
    };
    walk(body);
    return escapes;
  }
  // True when codegen's IndexAccess path auto-clones the element (vec / unsized
  // array with a drop-needing element type) rather than loading it in place. The
  // result is then a fresh allocation, whoever consumes it.
  private indexAccessClones(expr: FormOf<"IndexAccess">): boolean {
    const ot = this.ty(expr.object);
    const obj = ot.tag === "ref" ? ot.inner : ot;
    const isIndexable = obj.tag === "vec" || obj.tag === "array";
    return isIndexable && this.layout.needsDropCg(this.ty(expr.node));
  }

  // `opt!` / `res?` hand back a payload nobody else will free: a temp operand dies
  // with the expression, and an Ident operand has its slot zeroed in the ok branch
  // (unwrap and `?` do it) precisely because the payload moved out. A place
  // operand that is NOT zeroed — a struct field — still owns its payload, so
  // freeing the result there would double-free.
  private unwrapMovesPayload(expr: FormOf<"Unwrap" | "Propagate">): boolean {
    if (this.isOwnedTempExpr(expr.operand)) return true;
    return this.layout.needsDropCg(this.ty(expr.node)) && this.f(expr.operand).kind === "Ident";
  }

  // Whether an `if`/`match` used as an EXPRESSION hands back a value nobody else owns.
  //
  // It does when some arm yields an owned value: a temporary, a place the checker moved
  // (isMove: the expression zeroes it), or a match arm's own binding (the yield moves it). An
  // arm that yields a place it does not consume (`if c { a } else { mk() }` read in place)
  // then stores a clone (ForkSlot.cloneViews), so whichever arm ran, the consumer drops
  // exactly one value it owns. For a resource type the checker moves such a place instead
  // (moveMixedFork), since a structural clone would run its Drop twice. A string literal
  // owns nothing, and a fork of only views and literals stays a view.

  blockValueOwnsResult(expr: FormOf<"IfExpr" | "MatchExpr">): boolean {
    if (!this.layout.needsDropCg(this.ty(expr.node))) return false;
    const arms = expr.kind === "IfExpr"
      ? [{ body: expr.thenBody, bound: new Set<string>() }, { body: expr.elseBody, bound: new Set<string>() }]
      : expr.arms.map(a => ({ body: a.body, bound: matchArmLocals(a, expr.subjectIsRef) }));
    let owned = false;
    for (const { body, bound } of arms) {
      const tail = armTail(body);
      if (!tail) {
        const last = body[body.length - 1];
        if (last && (last.kind === "Return" || last.kind === "BreakStmt" || last.kind === "ContinueStmt")) continue;
        // `if true { .. } else { .. }`: the dead arm is left out
        if (!last && expr.kind === "IfExpr" && expr.folded) continue;
        return false;
      }
      const tf = this.f(tail);
      if (tf.kind === "StringLit") continue;
      if (!this.forkTailIsView(tail, tf.kind === "Ident" && bound.has(tf.name))) owned = true;
      // A view of a type with a user Drop cannot be cloned structurally (the copy would
      // run the Drop again); the checker consumes such a place where it can see the read
      // (consumeMixedResourceFork). Anywhere it did not, stay a view: a leak, not a
      // double drop.
      else if (this.typeRunsUserDrop(this.ty(tail))) return false;
    }
    return owned;
  }

  // Whether destroying a value of `t` runs some user Drop impl.
  private typeRunsUserDrop(t: TypeKind, seen: Set<string> = new Set()): boolean {
    switch (t.tag) {
      case "struct": {
        if (this.layout.dropImpls.has(t.name)) return true;
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return (this.layout.structLayouts.get(t.name)?.fields ?? []).some(f => this.typeRunsUserDrop(f.typeKind, seen));
      }
      case "enum": {
        if (this.layout.dropImpls.has(t.name)) return true;
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        const layout = this.layout.enumLayouts.get(t.name);
        if (!layout) return false;
        return [...layout.variants.values()].some(v => v.fieldTypeKinds.some(f => this.typeRunsUserDrop(f, seen)));
      }
      case "vec": case "array": return this.typeRunsUserDrop(t.element, seen);
      case "heap": return t.inner.tag === "interface" || this.typeRunsUserDrop(t.inner, seen);
      case "hashmap": return this.typeRunsUserDrop(t.key, seen) || this.typeRunsUserDrop(t.value, seen);
      case "interface": case "fn": return true;
      default: return false;
    }
  }

  // An arm tail that reads a place without consuming it. `armLocal`: an Ident the arm
  // declared, which the yield moves.
  public forkTailIsView(tail: Node, armLocal: boolean): boolean {
    const f = this.f(tail);
    if (f.kind === "StringLit" || armLocal || !this.layout.needsDropCg(this.ty(tail))) return false;
    if (this.isOwnedTempExpr(tail)) return false;
    if ((f.kind === "Ident" || f.kind === "FieldAccess" || f.kind === "IndexAccess" || f.kind === "HeapDeref") && this.moved(f)) return false;
    return true;
  }

  // Whether a field chain bottoms out in an rvalue nobody owns (`mk().a.b`), as opposed to
  // a place that can be addressed in situ (a local, `v[i]`, `*p`). Only the rvalue is
  // materialized into a temporary, so only it can die with the expression.
  private receiverIsRvalueTemp(expr: FormOf<"FieldAccess">): boolean {
    const obj = this.f(expr.object);
    if (this.ty(expr.object).tag === "ptr") return false;
    if (obj.kind === "FieldAccess") return this.receiverIsRvalueTemp(obj);
    if (obj.kind === "Ident" || obj.kind === "IndexAccess" || obj.kind === "PtrDeref") return false;
    if (obj.kind === "HeapDeref" && !this.isTempBoxDeref(obj)) return false;
    return this.isOwnedTempExpr(expr.object) && this.layout.needsDropCg(this.ty(expr.object));
  }

  // `*mk()` / `*Heap(x)`: a deref of a box nobody else owns. Even a read through it has
  // to free the box and drop the payload once the read is done, so codegen treats every
  // such deref as a move out of the box yielding an owned temporary.
  // Reading it in place leaked the box and never ran the payload's Drop.
  private isTempBoxDeref(expr: Form): boolean {
    if (expr.kind !== "HeapDeref") return false;
    const ot = this.ty(expr.operand);
    if (ot.tag !== "heap" || ot.inner.tag === "interface") return false;
    const k = this.f(expr.operand).kind;
    return k === "Call" || k === "ClosureCall" || k === "InterfaceMethodCall" || k === "HeapCreate";
  }

  // An owning field read out of a temporary receiver. The receiver is dropped as soon as
  // the field is read, so the FieldAccess hands the field on moved (or, under a user Drop,
  // cloned) and is an owned temporary in its own right.
  private fieldOfOwnedTemp(expr: FormOf<"FieldAccess">): boolean {
    return this.layout.needsDropCg(this.ty(expr.node)) && this.receiverIsRvalueTemp(expr);
  }

  public isOwnedTempExpr(n: Node): boolean {
    const expr = this.f(n);
    const type = this.ty(expr.node);
    // A discarded small-type `replace(...)` result is dropped here (SSA path). A big-agg
    // replace drops its own moved-out value inside the expression, so it must NOT double-drop here.
    if (expr.kind === "MemReplace") return !this.isBigAgg(this.layout.llvmType(type));
    if (expr.kind === "Call" || expr.kind === "ClosureCall" || expr.kind === "InterfaceMethodCall") return true;
    // An Option/Result combinator that yields an enum owns it: map/andThen build a fresh
    // payload, and every op that forwards the receiver's payload (orElse, mapErr,
    // context, ...) consumed a named receiver in the checker (consumeForwardedPayload).
    // Not an owned temp, `e.map(f).unwrapOr(0)` leaked the Err payload once per call.
    // The scalar ops (isSome, unwrapOr on a Copy payload) are filtered by needsDropCg.
    if (expr.kind === "OptionOp") return type.tag === "enum";
    // Builtins that allocate a fresh String/Vec are temporaries too. `i.toString()`
    // lowers to NumberToString, not Call, so `"n=" + i.toString()` used to leak the
    // converted string on every evaluation — which in a render loop is per frame.
    // A nested concat (`a + b + c`) is the same: the inner BinOp's result is owned
    // by nobody once the outer one has read it.
    switch (expr.kind) {
      // The point of `adopt` is that the result is owned and nothing else will free it,
      // which is the whole feature, so a discarded one leaks by exactly the amount it
      // adopted. Note this is the opposite answer from its sibling `RawSlice`, which is a
      // view and owns nothing.
      case "Adopt":
      // An enum literal in an auto-borrowed argument position (`f(E.Text(s))`) owns
      // its payload and nothing else ever will: the callee only borrows it, and the
      // temp has no name for scope-drop to find. Without this the payload leaks on
      // every call — `renderResponse(Response.Text(body), hdrs)` lost `body` each time.
      case "EnumLit":
      // Array/Vec and struct literals in that same position are the identical case,
      // and were missed when EnumLit was fixed: `f(["GET", key])` leaked the Vec's
      // buffer and `f(Point { name: s })` leaked the field, once per call. Every
      // client library built on a `cmd(&Vec<string>)` shape leaked a buffer per
      // command. Only the borrow path reaches here — a by-value argument moves and
      // is the callee's to drop — so this cannot double-free.
      case "ArrayLit":
      case "StructLit":
      case "NumberToString":
      case "JsonStringify":
      case "StringClone":
      case "VecNew":
      // std/hashmap's copy of a stored value is a fresh deep clone nobody else owns.
      case "MapCopyOut":
      // get's payload is cloned out of the buffer, so nothing else owns it and
      // `print(must(v, 0, "v"))` used to leak one copy per call.
      case "VecGetOpt":
        return true;
      case "BinOp":
        // string `+` only — the comparisons return bool
        return type.tag === "string";
      case "IndexAccess":
        // `v[i]` on a non-Copy element auto-clones so the container stays intact
        // (see the IndexAccess case), which makes the result a fresh allocation
        // with no owner unless it is bound. `print(v[0])` leaked one copy per call.
        return this.indexAccessClones(expr);
      case "FieldAccess":
        return this.fieldOfOwnedTemp(expr);
      case "HeapDeref":
        return this.isTempBoxDeref(expr);
      case "Unwrap":
      case "Propagate":
        return this.unwrapMovesPayload(expr);
      case "DefaultValue":
        return this.defaultValueOwnsResult(expr);
      case "IfExpr":
      case "MatchExpr":
        return this.blockValueOwnsResult(expr);
      default:
        return false;
    }
  }

  // Whether a `??` result is a value nobody else owns. Both branches DO move — the Some
  // branch loads the payload and zeroes the source enum, the None branch stores the
  // default and zeroes its source — so an unbound `(maybe(i) ?? "x").len`
  // leaked one payload per evaluation with nothing left to free it.
  //
  // An Ident counts, for the same reason it does in unwrapMovesPayload: the default-value
  // form MOVES out of whichever branch it takes, zeroing the source, so the named variable
  // is not going to be dropped by its scope either. Still an AND: every branch that could
  // produce the result has to be one this owns, or dropping it could free something the
  // caller still holds.
  private defaultValueOwnsResult(expr: FormOf<"DefaultValue">): boolean {
    const branchOwns = (n: Node): boolean => {
      const k = this.f(n).kind;
      return k === "StringLit" || this.isOwnedTempExpr(n) || (this.layout.needsDropCg(this.ty(expr.node)) && k === "Ident");
    };
    return branchOwns(expr.operand) && branchOwns(expr.default);
  }
}
