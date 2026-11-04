// Ownership facts emit-mlir asks of the HIR: which expressions are owned temporaries
// (discarding one must drop it), whether an if/match used as a value owns its result, and
// whether a closure handed to a parameter can outlive the call.
import type { HIRArg, HIRExpr, HIRFunction, HIRPattern, HIRStmt } from "./hir";
import type { TypeKind } from "./types";
import type { Layout } from "./layout";

function armTailExpr(body: HIRStmt[]): HIRExpr | null {
  const last = body[body.length - 1];
  return last && last.kind === "ExprStmt" ? last.expr : null;
}

// The names a match arm declares itself: its pattern's bindings (owned unless the
// subject is matched by reference) and its top-level `let`s.
function matchArmLocals(arm: { pattern: HIRPattern; body: HIRStmt[] }, subjectIsRef: boolean): Set<string> {
  const out = new Set<string>();
  if (arm.pattern.kind === "EnumPattern" && !subjectIsRef) for (const b of arm.pattern.bindings) out.add(b.name);
  for (const st of arm.body) if (st.kind === "Let") out.add(st.name);
  return out;
}

// Every HIRExpr kind that is NOT an owned temporary: it yields a scalar, a void, a
// borrowed view, or a place someone else already owns, so discarding its result frees
// nothing and drop glue must not run on it.
//
// Listed rather than left as the implicit `false` at the bottom of `isOwnedTempExpr`,
// because implicit is exactly how `VecRemove` was missed: it moves an element out of the
// buffer like its sibling `VecPop`, `VecPop` was in the list and it was not, and
// `v.remove(0)` as a statement therefore destroyed nothing. `tests/ownedTempCoverage.test.ts`
// requires every kind in `HIRExpr` to appear either here or in `isOwnedTempExpr`, so a
// newly added node cannot inherit an answer nobody chose.
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

export class Ownership {
  private closureParamEscapeCache = new Map<string, boolean>();
  constructor(private readonly layout: Layout, private readonly hirFns: ReadonlyMap<string, HIRFunction>) {}

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
    const fn = this.hirFns.get(fnName);
    const param = fn?.params[idx];
    if (!fn || fn.isExtern || !param || param.isRef || param.isRefMut) return true;
    // A parameter declared `move (…) => R` is owning, so the callee already registers it as
    // a droppable local and frees it at every exit. Treat that as an escape: it is the one
    // case where somebody else is doing the job, and dropping again in the caller is a
    // double free (`fn call(f: move () => i64)`, tests/fixtures/closureCapturesDropped).
    if (param.type.tag === "fn" && param.type.owning === true) return true;
    const escapes = this.paramEscapesBody(fn.body, param.name, seen);
    this.closureParamEscapeCache.set(key, escapes);
    return escapes;
  }

  // Whether `body` lets its parameter `paramName` (a closure) outlive the call: stores it,
  // returns it, captures it, or forwards it anywhere that does.
  private paramEscapesBody(body: HIRStmt[], paramName: string, seen: Set<string>): boolean {
    let escapes = false;
    const walk = (node: unknown): void => {
      if (escapes || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: string };
      // A nested closure that CAPTURES it keeps a copy of the {fn, env} pair, and that copy
      // can outlive this frame (`return move () => f(1)`). The capture is recorded by name,
      // so walking the nested body alone would miss it when that body only calls it.
      if (n.kind === "Closure" && Array.isArray(n.captures)
          && (n.captures as { name: string }[]).some(c => c.name === paramName)) { escapes = true; return; }
      // `f(…)` hands the closure to nobody: it is called and forgotten.
      if (n.kind === "ClosureCall") {
        const callee = n.callee as { kind?: string; name?: string } | undefined;
        if (!(callee?.kind === "Ident" && callee.name === paramName)) walk(n.callee);
        walk(n.args);
        return;
      }
      // Forwarding: `fn outer(g) { inner(g) }` keeps `g` only if `inner` does. Without this
      // a one-line wrapper would be indistinguishable from a store.
      if (n.kind === "Call" && Array.isArray(n.args)) {
        const args = n.args as HIRArg[];
        for (let i = 0; i < args.length; i++) {
          const e = args[i]?.expr;
          if (e?.kind === "Ident" && e.name === paramName) {
            if (this.closureParamEscapes(n.func as string, i, seen)) { escapes = true; return; }
          } else walk(args[i]);
        }
        return;
      }
      if (n.kind === "Ident" && n.name === paramName) { escapes = true; return; }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
    };
    walk(body);
    return escapes;
  }
  // True when codegen's IndexAccess path auto-clones the element (vec / unsized
  // array with a drop-needing element type) rather than loading it in place. The
  // result is then a fresh allocation, whoever consumes it.
  private indexAccessClones(expr: HIRExpr): boolean {
    if (expr.kind !== "IndexAccess") return false;
    const obj = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    const isIndexable = obj.tag === "vec" || obj.tag === "array";
    return isIndexable && this.layout.needsDropCg(expr.type);
  }

  // `opt!` / `res?` hand back a payload nobody else will free: a temp operand dies
  // with the expression, and an Ident operand has its slot zeroed in the ok branch
  // (unwrap and `?` do it) precisely because the payload moved out. A place
  // operand that is NOT zeroed — a struct field — still owns its payload, so
  // freeing the result there would double-free.
  private unwrapMovesPayload(expr: HIRExpr & { kind: "Unwrap" | "Propagate" }): boolean {
    if (this.isOwnedTempExpr(expr.operand)) return true;
    return this.layout.needsDropCg(expr.type) && expr.operand.kind === "Ident";
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

  blockValueOwnsResult(expr: HIRExpr & { kind: "IfExpr" | "MatchExpr" }): boolean {
    if (!this.layout.needsDropCg(expr.type)) return false;
    const arms = expr.kind === "IfExpr"
      ? [{ body: expr.thenBody, bound: new Set<string>() }, { body: expr.elseBody, bound: new Set<string>() }]
      : expr.arms.map(a => ({ body: a.body, bound: matchArmLocals(a, !!expr.subjectIsRef) }));
    let owned = false;
    for (const { body, bound } of arms) {
      const tail = armTailExpr(body);
      if (!tail) {
        const last = body[body.length - 1];
        if (last && (last.kind === "Return" || last.kind === "Break" || last.kind === "Continue")) continue;
        // `if true { .. } else { .. }`: the dead arm is lowered empty
        if (!last && expr.kind === "IfExpr" && expr.cond.kind === "BoolLit") continue;
        return false;
      }
      if (tail.kind === "StringLit") continue;
      if (!this.forkTailIsView(tail, tail.kind === "Ident" && bound.has(tail.name))) owned = true;
      // A view of a type with a user Drop cannot be cloned structurally (the copy would
      // run the Drop again); the checker consumes such a place where it can see the read
      // (consumeMixedResourceFork). Anywhere it did not, stay a view: a leak, not a
      // double drop.
      else if (this.typeRunsUserDrop(tail.type)) return false;
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
  public forkTailIsView(tail: HIRExpr, armLocal: boolean): boolean {
    if (tail.kind === "StringLit" || armLocal || !this.layout.needsDropCg(tail.type)) return false;
    if (this.isOwnedTempExpr(tail)) return false;
    if ((tail.kind === "Ident" || tail.kind === "FieldAccess" || tail.kind === "IndexAccess" || tail.kind === "HeapDeref") && tail.isMove) return false;
    return true;
  }

  // Whether a field chain bottoms out in an rvalue nobody owns (`mk().a.b`), as opposed to
  // a place that can be addressed in situ (a local, `v[i]`, `*p`). Only the rvalue is
  // materialized into a temporary, so only it can die with the expression.
  private receiverIsRvalueTemp(expr: HIRExpr & { kind: "FieldAccess" }): boolean {
    const obj = expr.object;
    if (obj.type.tag === "ptr") return false;
    if (obj.kind === "FieldAccess") return this.receiverIsRvalueTemp(obj);
    if (obj.kind === "Ident" || obj.kind === "IndexAccess" || obj.kind === "PtrDeref") return false;
    if (obj.kind === "HeapDeref" && !this.isTempBoxDeref(obj)) return false;
    return this.isOwnedTempExpr(obj) && this.layout.needsDropCg(obj.type);
  }

  // `*mk()` / `*Heap(x)`: a deref of a box nobody else owns. Even a read through it has
  // to free the box and drop the payload once the read is done, so codegen treats every
  // such deref as a move out of the box yielding an owned temporary.
  // Reading it in place leaked the box and never ran the payload's Drop.
  private isTempBoxDeref(expr: HIRExpr): boolean {
    if (expr.kind !== "HeapDeref") return false;
    const op = expr.operand;
    if (op.type.tag !== "heap" || op.type.inner.tag === "interface") return false;
    return op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "InterfaceMethodCall" || op.kind === "HeapCreate";
  }

  // An owning field read out of a temporary receiver. The receiver is dropped as soon as
  // the field is read, so the FieldAccess hands the field on moved (or, under a user Drop,
  // cloned) and is an owned temporary in its own right.
  private fieldOfOwnedTemp(expr: HIRExpr & { kind: "FieldAccess" }): boolean {
    return this.layout.needsDropCg(expr.type) && this.receiverIsRvalueTemp(expr);
  }

  public isOwnedTempExpr(expr: HIRExpr): boolean {
    // A discarded small-type `replace(...)` result is dropped here (SSA path). A big-agg
    // replace drops its own moved-out value inside the expression, so it must NOT double-drop here.
    if (expr.kind === "MemReplace") return !this.isBigAgg(this.layout.llvmType(expr.type));
    if (expr.kind === "Call" || expr.kind === "ClosureCall" || expr.kind === "InterfaceMethodCall") return true;
    // An Option/Result combinator that yields an enum owns it: map/andThen build a fresh
    // payload, and every op that forwards the receiver's payload (orElse, mapErr,
    // context, ...) consumed a named receiver in the checker (consumeForwardedPayload).
    // Not an owned temp, `e.map(f).unwrapOr(0)` leaked the Err payload once per call.
    // The scalar ops (isSome, unwrapOr on a Copy payload) are filtered by needsDropCg.
    if (expr.kind === "OptionOp") return expr.type.tag === "enum";
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
        return expr.type.tag === "string";
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
  // Deliberately narrower than "both branches move": the zeroing that makes a moved
  // *variable* safe only happens when codegen can find the source slot, which it cannot
  // for every Ident (an immutable `let` is an SSA register, not an alloca). A branch whose
  // value is an owned temp needs no zeroing to begin with, and a string literal has cap 0
  // so its drop is a no-op — those two are safe unconditionally. Everything else, Idents
  // included, stays false and keeps leaking rather than risking a double free.
  private defaultValueOwnsResult(expr: HIRExpr & { kind: "DefaultValue" }): boolean {
    // An Ident counts, for the same reason it does in unwrapMovesPayload: the default-value form
    // MOVES out of whichever branch it takes, zeroing the source, so the named variable is
    // not going to be dropped by its scope either. Requiring a literal or a temporary here
    // missed the commonest shape by far —
    //
    //     let o: Option<string> = Option.Some(big(i))
    //     (o ?? "d").len                                  // payload leaked, every time
    //
    // — one payload per evaluation, on BOTH branches. Still an AND: every branch that could
    // produce the result has to be one this owns, or dropping it could free something the
    // caller still holds.
    const branchOwns = (e: HIRExpr): boolean =>
      e.kind === "StringLit"
      || this.isOwnedTempExpr(e)
      || (this.layout.needsDropCg(expr.type) && e.kind === "Ident");
    return branchOwns(expr.operand) && branchOwns(expr.default);
  }
}
