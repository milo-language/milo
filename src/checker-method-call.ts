// Method-call expressions: receiver dispatch over builtin and user methods.
import type { TypeChecker } from "./checker";
import type { TypeKind } from "./types";
import { JSON_CHAIN_READS, VEC_CALLBACK_METHODS, rewritten } from "./checker-util";
import { ARRAY_COMBINATORS, SLICE_COMBINATORS, typeEq, typeName } from "./types";
import { MUTATING_COLLECTION_METHODS } from "./builtin-members";
import { HASHMAP_MEMBERS, VEC_MEMBERS, memberHint } from "./suggest";
import { must } from "./must";
import type { MethodCall } from "./ast";

// Builtin methods (on string, Vec, HashMap, ...) are checked case by case and never reach
// checkCallSiteExclusivity, yet their receiver is taken before the arguments run just
// like a user method's: `v[0].startsWith(consume(v).toString())` read the string after
// `consume` freed it. So the receiver is checked against the arguments' nested writes
// here, unless a user-method path already checked it as its first argument.
export function checkMethodCallExpr(c: TypeChecker, call: MethodCall, expected: TypeKind | null): TypeKind {
  const t = c.checkMethodCallExprInner(call, expected);
  // The receiver strip and the Json chain rewrites replace the call; the checks below are on what was checked.
  const expr = rewritten(c.rewrites, call) as MethodCall;
  if (expr.args.length > 0 && !c.siteCheckedFirstArgs.has(expr.object)) {
    const p = c.exclusivityPlace(expr.object);
    // A string root is a name that is not a binding (a static call's type name).
    if (p && typeof p.root === "object") c.reportLaterArgWrites([{ arg: 0, ...p, moved: false }], [expr.object, ...expr.args], expr.span);
  }
  return t;
}

export function checkMethodCallExprInner(chk: TypeChecker, call: MethodCall, expected: TypeKind | null): TypeKind {
  let expr = call;
  const sp = expr.span;
  if (expr.object.kind === "UnaryOp" && expr.object.op === "&mut") {
    // Receivers borrow implicitly.
    // Stripped so the call is still checked as written and one error is reported.
    const inner = chk.describeExpr(expr.object.operand);
    chk.error(`'&mut' is implicit on a method receiver; write '${inner}.${expr.method}(${expr.args.map(a => chk.describeExpr(a)).join(", ")})'`, expr.object.span);
    expr = { ...call, object: expr.object.operand };
    chk.rewrites.set(call, expr);
  }
  const rawObjType = chk.checkExpr(expr.object);
  // A read at the end of a `doc[...]` chain: `doc["a"].str()` → `doc.idxStr(chain)`.
  const chainRoot = chk.jsonChains.get(rewritten(chk.rewrites, expr.object));
  const pathStep = chk.rewriteJsonPathStep(expr, rawObjType, chainRoot, expected);
  if (pathStep) return pathStep;
  if (chainRoot && rawObjType.tag === "struct" && rawObjType.name === "JsonCur") {
    const read = JSON_CHAIN_READS[expr.method];
    if (read && expr.args.length === (read === "idxValueAt" ? 1 : 0)) {
      const next: MethodCall = { ...expr, args: [expr.object, ...expr.args], object: structuredClone(chainRoot), method: read };
      chk.rewrites.set(expr, next);
      return chk.checkMethodCallExprInner(next, expected);
    }
  }
  if (!chainRoot && rawObjType.tag === "struct" && rawObjType.name === "JsonCur" && (JSON_CHAIN_READS[expr.method] || expr.method === "at")) {
    const name = chk.describeExpr(expr.object);
    chk.error(`a JsonCur is read through its document: write 'doc[${name}].${expr.method}()'`, sp);
    for (const a of expr.args) chk.checkExpr(a);
    return chk.setType(expr, { tag: "unknown" });
  }
  // No method can be looked up on a receiver whose own type failed; the arguments are
  // still checked so a mistake inside them is reported, but nothing is moved into a
  // signature nobody knows.
  if (chk.isPoisoned(rawObjType)) {
    for (const a of expr.args) chk.checkExpr(a.kind === "UnaryOp" && a.op === "&mut" ? a.operand : a);
    return chk.setType(expr, { tag: "unknown" });
  }
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
    if (expr.args.length !== 0) { chk.error(`'toString' takes no arguments`, sp); }
    if (objType.tag === "bool") return chk.bindStdPrimMethod(expr, "bool", "toString", { tag: "string" });
    return chk.setType(expr, { tag: "string" });
  }
  // x.addrOf(): *T — raw address of any lvalue (the replacement for `&x`).
  // Universal (any receiver), lvalue-only, requires unsafe. Lowers to the
  // same address-of the old `&x` emitted (see lower.ts) → IR unchanged.
  if (expr.method === "addrOf") {
    if (expr.args.length !== 0) { chk.error(`'addrOf' takes no arguments`, sp); }
    chk.requireUnsafe(`'addrOf' (raw address-of) requires 'unsafe' block`, sp);
    if (expr.object.kind !== "Ident" && expr.object.kind !== "FieldAccess" && expr.object.kind !== "IndexAccess")
      chk.error(`'addrOf' requires an lvalue (variable, field, or index)`, sp);
    return chk.setType(expr, { tag: "ptr", inner: objType });
  }
  // v.ptr(): *T — a Vec's backing DATA pointer (first element). Safe to
  // obtain (mirrors string.cstr); the Vec stays live in the caller. Fixed
  // arrays already auto-coerce to *T (pass bare), so this is Vec-only.
  if (objType.tag === "vec" && expr.method === "ptr") {
    if (expr.args.length !== 0) { chk.error(`'ptr' takes no arguments`, sp); }
    return chk.setType(expr, { tag: "ptr", inner: objType.element });
  }
  // h.ptr(): *T — the box pointer of a `Heap<T>`, the give leg `adopt` is the take
  // leg of. Safe for the same reason `v.ptr()` is: the `Heap` stays live in the caller
  // and this only reads the pointer it already is. Without it, handing C a Milo-owned
  // object needed `h.addrOf()` and a load through it — the address of the SLOT, not of
  // the box. A user `impl` method named `ptr` on T wins, since a `Heap<T>` receiver
  // otherwise resolves to T's methods.
  if (objType.tag === "heap" && expr.method === "ptr"
      && !chk.resolveMethod(typeName(objType.inner), "ptr")) {
    if (expr.args.length !== 0) { chk.error(`'ptr' takes no arguments`, sp); }
    if (objType.inner.tag === "interface") {
      // A `Heap<dyn I>` is {box, vtable}; there is no single pointer that is the value,
      // and free-ing the box alone would strand the dispatch half of it.
      chk.error(`'ptr' is not available on Heap<${chk.show(objType.inner)}>`, sp,
        `an interface box carries a vtable alongside the allocation, so no single raw pointer represents it`);
      return chk.setType(expr, { tag: "unknown" });
    }
    return chk.setType(expr, { tag: "ptr", inner: objType.inner });
  }
  // Option combinators — isSome/isNone/unwrapOr. Gated on baseName so a user
  // enum's own impl method of the same name still resolves normally below.
  if (objType.tag === "enum" && chk.enums.get(objType.name)?.baseName === "Option") {
    if (expr.method === "isSome" || expr.method === "isNone") {
      if (expr.args.length !== 0) { chk.error(`'${expr.method}' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "bool" });
    }
    // take(): `replace(place, None)` spelled as a method, and lowered to exactly that
    // MemReplace. It is what moves a non-Copy (or @noCopy) payload out from behind a
    // `&mut`, where a `match` that binds by value is rejected as a move out of a borrow.
    // The receiver is a place that stays valid (now None), so it is never moved here;
    // it takes the checks replace's place argument takes.
    if (expr.method === "take") {
      if (expr.args.length !== 0) { chk.error(`'take' takes no arguments`, sp); }
      const o = expr.object;
      const isPlace = o.kind === "Ident" || o.kind === "FieldAccess" || o.kind === "IndexAccess"
        || (o.kind === "UnaryOp" && o.op === "*");
      // resolveAssignTarget re-types a `&mut Option<T>` name as its pointee, the shape
      // MemReplace's lvalue codegen expects (same as replace's first argument).
      const place = isPlace ? chk.resolveAssignTarget(o) : null;
      if (!place?.mutable) {
        chk.error(`take() needs a mutable place: '${chk.describeExpr(o)}' is not one`, sp,
          isPlace ? `declare it with 'var', or take a '&mut' parameter` : `bind the Option to a 'var' first, or match on it to move the value out`);
      } else {
        chk.markPlaceRead(o);
        chk.checkPlaceArgWrite(o, "take", sp);
      }
      return chk.setType(expr, objType);
    }
    if (expr.method === "unwrapOr") {
      if (expr.args.length !== 1) { chk.error(`'unwrapOr' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (inner && !chk.isCopyType(inner)) {
        // select-based lowering copies the payload; for owned types that would
        // alias the heap buffer (double-free). Move-out needs match.
        chk.error(`'unwrapOr' on a non-Copy Option<${chk.show(inner)}> — use 'match' to move the value out`, sp);
        return chk.setType(expr, inner);
      }
      if (inner) {
        const at = chk.checkExpr(expr.args[0], inner);
        if (!typeEq(inner, at) && at.tag !== "unknown") {
          chk.error(`'unwrapOr': default must be ${chk.show(inner)}, got ${chk.show(at)}`, sp);
        }
        return chk.setType(expr, inner);
      }
      return chk.setType(expr, { tag: "unknown" });
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
      if (expr.args.length !== 1) { chk.error(`'map' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (!inner) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "map", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'map' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      if (cbType.ret.tag === "void") {
        chk.error(`'map': callback must return a value — use 'match' for a side effect`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Option", [cbType.ret]) });
    }
    // unwrapOrElse(f) — like unwrapOr but the default is computed only when None.
    // Same Copy gate as unwrapOr, for the same reason: the payload is loaded, not
    // moved out.
    if (expr.method === "unwrapOrElse") {
      if (expr.args.length !== 1) { chk.error(`'unwrapOrElse' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (inner && !chk.isCopyType(inner)) {
        chk.error(`'unwrapOrElse' on a non-Copy Option<${chk.show(inner)}> — use 'match' to move the value out`, sp);
        return chk.setType(expr, inner);
      }
      if (inner) {
        const cbHint: TypeKind = { tag: "fn", params: [], ret: inner };
        const cbType = chk.checkExpr(expr.args[0], cbHint);
        chk.checkCallbackSig(cbType, cbHint, "unwrapOrElse", sp);
        if (cbType.tag !== "fn") {
          chk.error(`'unwrapOrElse' argument must be a function`, sp);
          return chk.setType(expr, inner);
        }
        if (cbType.params.length !== 0) {
          chk.error(`'unwrapOrElse': callback takes no arguments`, sp);
        }
        if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
          chk.error(`'unwrapOrElse': callback must return ${chk.show(inner)}, got ${chk.show(cbType.ret)}`, sp);
        }
        return chk.setType(expr, inner);
      }
      return chk.setType(expr, { tag: "unknown" });
    }
    // andThen(f): Option<T> -> Option<U>, f returning the whole Option — the chaining
    // form, so a walk of fallible steps stays one Option deep instead of nesting.
    // Same two properties as map, for the same reasons: the callback takes the payload
    // by ref (no Copy gate) and None carries no payload to forward (no consume).
    if (expr.method === "andThen") {
      if (expr.args.length !== 1) { chk.error(`'andThen' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (!inner) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "andThen", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'andThen' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const ret = cbType.ret;
      if (ret.tag !== "enum" || chk.enums.get(ret.name)?.baseName !== "Option") {
        chk.error(`'andThen': callback must return an Option, got ${chk.show(ret)}`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      return chk.setType(expr, ret);
    }
    // orElse(f): Option<T> -> Option<T>, f: () -> Option<T> — the None-side andThen,
    // for "try this source, else that one" without unwrapping in between. The Some
    // branch forwards the receiver's payload into the result, so a non-Copy T consumes
    // the receiver (same rule as Result.map/andThen).
    if (expr.method === "orElse") {
      if (expr.args.length !== 1) { chk.error(`'orElse' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (!inner) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [], ret: objType };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "orElse", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'orElse' argument must be a function`, sp);
        return chk.setType(expr, objType);
      }
      if (cbType.params.length !== 0) {
        chk.error(`'orElse': callback takes no arguments`, sp);
      }
      const ret = cbType.ret;
      if (ret.tag !== "unknown") {
        const cbInner = ret.tag === "enum" && chk.enums.get(ret.name)?.baseName === "Option"
          ? chk.unwrapableInner(ret) : null;
        if (!cbInner || !typeEq(cbInner, inner)) {
          chk.error(`'orElse': callback must return Option<${chk.show(inner)}>, got ${chk.show(ret)}`, sp);
        }
      }
      chk.consumeForwardedPayload(expr.object, inner);
      return chk.setType(expr, objType);
    }
  }
  // Result combinators — isOk/isErr/unwrapOr, mirroring Option (Ok is tag 0).
  if (objType.tag === "enum" && chk.enums.get(objType.name)?.baseName === "Result") {
    if (expr.method === "isOk" || expr.method === "isErr") {
      if (expr.args.length !== 0) { chk.error(`'${expr.method}' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "bool" });
    }
    if (expr.method === "unwrapOr") {
      if (expr.args.length !== 1) { chk.error(`'unwrapOr' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      if (inner && !chk.isCopyType(inner)) {
        chk.error(`'unwrapOr' on a non-Copy Result<${chk.show(inner)}> — use 'match' to move the value out`, sp);
        return chk.setType(expr, inner);
      }
      if (inner) {
        const at = chk.checkExpr(expr.args[0], inner);
        if (!typeEq(inner, at) && at.tag !== "unknown") {
          chk.error(`'unwrapOr': default must be ${chk.show(inner)}, got ${chk.show(at)}`, sp);
        }
        return chk.setType(expr, inner);
      }
      return chk.setType(expr, { tag: "unknown" });
    }
    // context(note): Result<T,E> -> Result<T, Heap<Error>>. The Err payload is boxed
    // (the same rule as `?` into Heap<Error>) and wrapped in the prelude ErrorContext with
    // the note; Ok is forwarded. Consumes the receiver: the error moves into the box.
    if (expr.method === "context") {
      if (expr.args.length !== 1) { chk.error(`'context' expects 1 argument (the note)`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (!inner || !errT) return chk.setType(expr, { tag: "unknown" });
      const heapError: TypeKind = { tag: "heap", inner: { tag: "interface", name: "Error" } };
      if (!chk.structs.has("ErrorContext") || !chk.interfaces.has("Error")) {
        chk.error(`'context' needs the prelude's Error and ErrorContext (compiled with --no-prelude?)`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const noteT = chk.checkExpr(expr.args[0], { tag: "string" });
      if (noteT.tag !== "string" && noteT.tag !== "unknown") {
        chk.error(`'context': note must be a string, got ${chk.show(noteT)}`, sp);
      }
      chk.tryMove(expr.args[0]);
      if (!typeEq(errT, heapError)) {
        const boxing = chk.findPropagateBoxing(errT, heapError, sp, "'context'");
        if (boxing && boxing !== "reported") chk.contextBoxings.set(expr, boxing);
      }
      chk.tryMove(expr.object);
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Result", [inner, heapError]) });
    }
    // map(f): Result<T,E> -> Result<U,E>. Like Option.map the callback takes the
    // payload BY REF, which is why there is no Copy gate: nothing is moved out of
    // the receiver, so an owned Ok payload can't end up with two owners.
    // The Err payload IS forwarded into the result untouched though, so a non-Copy
    // E must consume the receiver — see the consume block below.
    if (expr.method === "map") {
      if (expr.args.length !== 1) { chk.error(`'map' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (!inner || !errT) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "map", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'map' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      if (cbType.ret.tag === "void") {
        chk.error(`'map': callback must return a value — use 'match' for a side effect`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      // Err payload is copied through into the result. Owned E would then be
      // reachable from both the receiver and the result, and both get drop glue.
      chk.consumeForwardedPayload(expr.object, errT);
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Result", [cbType.ret, errT]) });
    }
    // mapErr(f): Result<T,E> -> Result<T,F> — the mirror of map, callback on the Err side.
    if (expr.method === "mapErr") {
      if (expr.args.length !== 1) { chk.error(`'mapErr' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (!inner || !errT) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "mapErr", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'mapErr' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      if (cbType.ret.tag === "void") {
        chk.error(`'mapErr': callback must return a value — use 'match' for a side effect`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      // Mirror of map: mapErr forwards the OK payload through untouched.
      chk.consumeForwardedPayload(expr.object, inner);
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Result", [inner, cbType.ret]) });
    }
    // andThen(f): Result<T,E> -> Result<U,E>, f returning the whole Result. The Err
    // type must match the receiver's: the Err branch forwards the receiver's payload
    // unchanged, so there is no conversion available for a mismatched E.
    if (expr.method === "andThen") {
      if (expr.args.length !== 1) { chk.error(`'andThen' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (!inner || !errT) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "andThen", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'andThen' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const ret = cbType.ret;
      if (ret.tag !== "enum" || chk.enums.get(ret.name)?.baseName !== "Result") {
        chk.error(`'andThen': callback must return a Result, got ${chk.show(ret)}`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const cbErr = chk.unwrapableErr(ret);
      if (cbErr && !typeEq(cbErr, errT)) {
        chk.error(`'andThen': callback's error type must be ${chk.show(errT)}, got ${chk.show(cbErr)}`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      // Like map, the Err payload is forwarded into the result untouched.
      chk.consumeForwardedPayload(expr.object, errT);
      return chk.setType(expr, ret);
    }
    // unwrapOrElse(f) — unwrapOr with the default computed only on Err. Unlike Option's
    // (whose failure carries nothing) the callback receives the error by ref, so the
    // default can depend on what went wrong. Same Copy gate as unwrapOr: the Ok payload
    // is loaded out, not moved.
    if (expr.method === "unwrapOrElse") {
      if (expr.args.length !== 1) { chk.error(`'unwrapOrElse' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (inner && !chk.isCopyType(inner)) {
        chk.error(`'unwrapOrElse' on a non-Copy Result<${chk.show(inner)}> — use 'match' to move the value out`, sp);
        return chk.setType(expr, inner);
      }
      if (inner && errT) {
        const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: inner };
        const cbType = chk.checkExpr(expr.args[0], cbHint);
        chk.checkCallbackSig(cbType, cbHint, "unwrapOrElse", sp);
        if (cbType.tag !== "fn") {
          chk.error(`'unwrapOrElse' argument must be a function`, sp);
          return chk.setType(expr, inner);
        }
        if (cbType.params.length !== 1) {
          chk.error(`'unwrapOrElse': callback takes 1 argument, the error`, sp);
        }
        if (!typeEq(inner, cbType.ret) && cbType.ret.tag !== "unknown") {
          chk.error(`'unwrapOrElse': callback must return ${chk.show(inner)}, got ${chk.show(cbType.ret)}`, sp);
        }
        return chk.setType(expr, inner);
      }
      return chk.setType(expr, { tag: "unknown" });
    }
    // orElse(f): Result<T,E> -> Result<T,F> — the Err-side andThen. f receives the error
    // and returns a whole Result, so a failed step can be recovered or its error retyped.
    // The Ok payload is forwarded into the result, so a non-Copy T consumes the receiver.
    if (expr.method === "orElse") {
      if (expr.args.length !== 1) { chk.error(`'orElse' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const inner = chk.unwrapableInner(objType);
      const errT = chk.unwrapableErr(objType);
      if (!inner || !errT) return chk.setType(expr, { tag: "unknown" });
      const cbHint: TypeKind = { tag: "fn", params: [{ tag: "ref", inner: errT, mutable: false }], ret: { tag: "unknown" } };
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "orElse", sp);
      if (cbType.tag !== "fn") {
        chk.error(`'orElse' argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const ret = cbType.ret;
      if (ret.tag !== "enum" || chk.enums.get(ret.name)?.baseName !== "Result") {
        chk.error(`'orElse': callback must return a Result, got ${chk.show(ret)}`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const cbOk = chk.unwrapableInner(ret);
      if (cbOk && !typeEq(cbOk, inner)) {
        chk.error(`'orElse': callback's ok type must be ${chk.show(inner)}, got ${chk.show(cbOk)}`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      chk.consumeForwardedPayload(expr.object, inner);
      return chk.setType(expr, ret);
    }
  }
  // wrapping/saturating/checked arithmetic methods on integers
  if (objType.tag === "int") {
    // The result is the receiver's WIDTH, not its range: `r.wrappingAdd(1)` or
    // `r.checkedAdd(1)` can land outside `i32(0..9)`, and typing it as the ranged type
    // would mint an out-of-range value (read as None by a niche `Option<i32(0..9)>`).
    const intBase: TypeKind = { tag: "int", bits: objType.bits, signed: objType.signed };
    const wrappingMethods = ["wrappingAdd", "wrappingSub", "wrappingMul"];
    const saturatingMethods = ["saturatingAdd", "saturatingSub", "saturatingMul"];
    const checkedMethods = ["checkedAdd", "checkedSub", "checkedMul", "checkedDiv", "checkedRem"];
    if (wrappingMethods.includes(expr.method) || saturatingMethods.includes(expr.method)) {
      // Must return, not fall through: `this.error` accumulates a diagnostic
      // and keeps going, so with zero args the `args[0]` below is undefined.
      if (expr.args.length !== 1) { chk.error(`'${expr.method}' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const argType = chk.checkExpr(expr.args[0], intBase);
      if (!typeEq(intBase, argType) && argType.tag !== "unknown") {
        chk.error(`'${expr.method}': expected ${chk.show(intBase)}, got ${chk.show(argType)}`, sp);
      }
      return chk.setType(expr, intBase);
    }
    if (checkedMethods.includes(expr.method)) {
      if (expr.args.length !== 1) { chk.error(`'${expr.method}' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const argType = chk.checkExpr(expr.args[0], intBase);
      if (!typeEq(intBase, argType) && argType.tag !== "unknown") {
        chk.error(`'${expr.method}': expected ${chk.show(intBase)}, got ${chk.show(argType)}`, sp);
      }
      return chk.setType(expr, chk.resolveOptionForValue(intBase, sp));
    }
    // unary negation — desugars to sub(0, x) in lowering, so overflow
    // semantics (None only at signed INT_MIN / unsigned nonzero) fall out for free
    if (expr.method === "wrappingNeg") {
      if (expr.args.length !== 0) { chk.error(`'wrappingNeg' takes no arguments`, sp); }
      return chk.setType(expr, intBase);
    }
    if (expr.method === "checkedNeg") {
      if (expr.args.length !== 0) { chk.error(`'checkedNeg' takes no arguments`, sp); }
      return chk.setType(expr, chk.resolveOptionForValue(intBase, sp));
    }
    // bit-counting intrinsics — 0-arg, count fits any width so result is i64
    const bitCountMethods = ["countOnes", "leadingZeros", "trailingZeros"];
    if (bitCountMethods.includes(expr.method)) {
      if (expr.args.length !== 0) { chk.error(`'${expr.method}' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    // rotate: 1-arg shift (mod bit-width), returns same type
    if (expr.method === "rotateLeft" || expr.method === "rotateRight") {
      if (expr.args.length !== 1) { chk.error(`'${expr.method}' expects 1 argument`, sp); }
      else {
        const at = chk.checkExpr(expr.args[0], intBase);
        if (!typeEq(intBase, at) && at.tag !== "unknown") {
          chk.error(`'${expr.method}': shift amount must be ${chk.show(intBase)}, got ${chk.show(at)}`, sp);
        }
      }
      return chk.setType(expr, intBase);
    }
    // reverseBits — 0-arg, returns same type
    if (expr.method === "reverseBits") {
      if (expr.args.length !== 0) { chk.error(`'reverseBits' takes no arguments`, sp); }
      return chk.setType(expr, intBase);
    }
  }
  // frozen-collection guard: reject realloc/free-capable builtins on a borrowed receiver
  if ((objType.tag === "vec" || objType.tag === "hashmap" || objType.tag === "string")
      && MUTATING_COLLECTION_METHODS.has(expr.method)) {
    chk.errorIfFrozen(expr.object, `call '${expr.method}' on`, sp);
    chk.collectionGuarded.add(expr);
  }
  // slices: `v[a..b]` desugars to `.slice(a,b)`; a slice is `&[T]` — a ref to an
  // unsized array, runtime rep = non-owning %Vec (cap=0, drop glue skips free)
  if ((objType.tag === "vec" || objType.tag === "array") && expr.method === "slice") {
    // fixed-size arrays slice into their own storage (view built in codegen);
    // the frozen-source rule below keeps the array alive for the view's life
    const refSlice: TypeKind = { tag: "ref", inner: { tag: "array", element: objType.element, size: null }, mutable: false };
    if (expr.args.length !== 2) { chk.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp); return chk.setType(expr, refSlice); }
    const startType = chk.checkExpr(expr.args[0]);
    const endType = chk.checkExpr(expr.args[1]);
    if (startType.tag !== "int" && startType.tag !== "unknown") chk.error(`slice start: expected integer, got ${chk.show(startType)}`, sp);
    if (endType.tag !== "int" && endType.tag !== "unknown") chk.error(`slice end: expected integer, got ${chk.show(endType)}`, sp);
    // A view of a TEMPORARY has nothing to freeze: `mk()[0..2]` points into a Vec that
    // no binding owns. `freezeViewSource` already rejects the method spelling of this
    // (`mk().view()`), and its comment is the reason to reject the slice one too: that
    // storage survives today only because temporaries leak, and it becomes a
    // use-after-free the moment they get drop glue. Three drop-glue paths landed this
    // session, so the gap between the two spellings is closing from the wrong side.
    if (!chk.isPlaceExpr(expr.object)) {
      chk.error(`cannot take a slice of a temporary`, sp,
        `the '&[T]' would outlive the value it points into: bind the receiver first ('let r = ...' then slice 'r')`);
    }
    // freeze the source — mutation could realloc/free the memory this view points into
    chk.freezeRootOf(expr.object);
    chk.borrowedExprs.add(expr);
    return chk.setType(expr, refSlice);
  }
  if (objType.tag === "array" && objType.size === null && expr.method === "len") {
    if (expr.args.length !== 0) chk.error(`'len' takes no arguments`, sp);
    return chk.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  if (objType.tag === "vec") {
    if (expr.method === "push") {
      if (expr.args.length !== 1) { chk.error(`'push' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot push to immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      // Deferred-inference Vec (`var v = Vec.new()`): first push fixes the
      // element type. Resolve the placeholder so the binding, its exprType,
      // and every later use all see the real element.
      if (chk.isLiveInfer(objType.element)) {
        const inferId = objType.element.inferId;
        const argType = chk.checkExpr(expr.args[0], null);
        // A pushed borrow would outlive the scope that owns the borrowed
        // value — the Vec survives it. Same rule as a struct field.
        if (argType.tag === "ref") {
          chk.error(`push: cannot store a reference in a Vec`, sp, `references are second-class — push an owned value (clone it if needed)`);
        }
        // Another unresolved placeholder is copied as a plain unknown: the two stay independent.
        chk.inferred[inferId] = argType.tag === "unknown" ? { tag: "unknown" } : argType;
        chk.zonkStored();
        const resolvedVec = chk.resolveInfer(objType);
        const ctor = chk.inferVecCtors.get(inferId);
        if (ctor) chk.bindVecConstructor(ctor, resolvedVec);
        chk.tryMove(expr.args[0]);
        chk.holdPointerArgsIn(expr.object, expr.args);
        return chk.bindStdVecMethod(expr, (resolvedVec as TypeKind & { tag: "vec" }).element, "push", { tag: "void" });
      }
      const argType = chk.checkExpr(expr.args[0], objType.element);
      if (objType.element.tag === "int") chk.enforceRangeInto(expr.args[0], argType, objType.element, expr.args[0].span);
      if (argType.tag === "ref") {
        chk.error(`push: cannot store a reference in a Vec`, sp, `references are second-class — push an owned value (clone it if needed)`);
      }
      if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
        if (!chk.tryInterfaceCoercion(expr.args[0], argType, objType.element)) {
          chk.error(`push: expected ${chk.show(objType.element)}, got ${chk.show(argType)}`, sp);
        }
      }
      chk.tryMove(expr.args[0]);
      chk.holdPointerArgsIn(expr.object, expr.args);
      return chk.bindStdVecMethod(expr, objType.element, "push", { tag: "void" });
    }
    if (expr.method === "clear" || expr.method === "truncate") {
      // truncate(n) drops everything at index >= n; clear() is truncate(0).
      const want = expr.method === "clear" ? 0 : 1;
      if (expr.args.length !== want) {
        chk.error(`'${expr.method}' expects ${want} argument${want === 1 ? "" : "s"}, got ${expr.args.length}`, sp);
      }
      if (want === 1 && expr.args.length === 1) {
        const nType = chk.checkExpr(expr.args[0]);
        if (nType.tag !== "int" && nType.tag !== "unknown") {
          chk.error(`'truncate': expected an integer length, got ${chk.show(nType)}`, sp);
        }
      }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot ${expr.method} an immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      return chk.bindStdVecMethod(expr, objType.element, expr.method, { tag: "void" });
    }
    if (expr.method === "pop") {
      if (expr.args.length !== 0) { chk.error(`'pop' takes no arguments`, sp); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot pop from immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      // Returns Option<T> — Some(last) or None when empty; caller picks the
      // failure policy via `!`/`?`/`??`. Mirrors HashMap.get / Vec.find.
      return chk.bindStdVecMethod(expr, objType.element, "pop", chk.resolveOptionForValue(objType.element, sp));
    }
    if (expr.method === "map") {
      if (expr.args.length !== 1) { chk.error(`'map' expects 1 argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
      const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "unknown" } };
      // The body is std/vec's map<U>, with U the callback's return type, so the callback
      // is checked here, once, and the method bound after. std passes `&T`: a by-value
      // Copy callback is adapted to it (a literal or named fn by coerceCopyCallback, a fn
      // value by thunkByValueFnValue), so every callback the builtin took still works.
      chk.coerceCopyCallback(expr.args[0], cbHint);
      chk.thunkByValueFnValue(expr.args[0]!, objType.element, 1);
      const cbBorrow = chk.borrowDuringCallback(expr.object, expr);
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "map", sp);
      if (cbBorrow) chk.unfreeze(cbBorrow);
      if (cbType.tag !== "fn") { chk.error(`'map' argument must be a function`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const ret: TypeKind = { tag: "vec", element: cbType.ret };
      if (chk.refuseByValueCallback(cbType, elemRef, "map", sp) || cbType.ret.tag === "unknown") return chk.setType(expr, ret);
      return chk.bindStdVecMethod(expr, objType.element, "map", ret, { mutable: false, typeArgs: [cbType.ret] });
    }
    // filter is std/vec code, dispatched like the read-only callback methods. It copies
    // each kept element structurally (_vecCopyOut), as the builtin did, Drop elements too.
    if (expr.method === "filter") {
      const body = chk.instantiateContainerImpl("Vec", [objType.element], "filter");
      if (body) return chk.dispatchMangledMethod(expr, body.mangled, sp, true);
    }
    if (expr.method === "join") {
      if (expr.args.length !== 1) { chk.error(`'join' expects 1 argument (separator)`, sp); return chk.setType(expr, { tag: "unknown" }); }
      if (objType.element.tag !== "string") { chk.error(`'join' is only available on Vec<string>`, sp); return chk.setType(expr, { tag: "unknown" }); }
      const sepType = chk.checkExpr(expr.args[0]);
      if (sepType.tag !== "string" && sepType.tag !== "unknown") { chk.error(`'join' separator must be a string, got ${chk.show(sepType)}`, sp); }
      // std/vec's join takes the separator as `&string`, as std/string's vecJoin did.
      chk.autoBorrow(expr.args[0]!, { mutable: false });
      return chk.bindStdVecMethod(expr, objType.element, "join", { tag: "string" }, { mutable: false });
    }
    // The callback methods are std/vec code. The callback is checked with the receiver
    // frozen (borrowsForCallback), as the builtins did: it may read the Vec, not change it.
    if (VEC_CALLBACK_METHODS.has(expr.method)) {
      // find copies the match out; refused at the call for a resource element, the
      // same rule as first/last, rather than inside std/vec's get.
      if (expr.method === "find" &&
          chk.errorIfResourceCopyOut(objType.element, "find", "Vec", sp, `Find the index with 'position' and borrow 'v[i]', or take it out for real with 'remove'`)) {
        for (const a of expr.args) chk.checkExpr(a);
        return chk.setType(expr, chk.resolveOptionForValue(objType.element, sp));
      }
      if (expr.method === "fold" || expr.method === "reduce") return chk.checkVecFold(expr, objType.element, sp);
      const body = chk.instantiateContainerImpl("Vec", [objType.element], expr.method);
      if (body) return chk.dispatchMangledMethod(expr, body.mangled, sp, true);
    }
    // sum is std/vec code. A ranged element sums as its plain int (the total is not in
    // the element's range); inside a @wrapping fn an int sum is std's wrappingSum, as
    // the builtin wrapped there.
    if (expr.method === "sum" || expr.method === "wrappingSum") {
      const el = objType.element;
      if (el.tag !== "int" && (el.tag !== "float" || expr.method === "wrappingSum")) {
        chk.error(`'${expr.method}' requires a Vec of integers${expr.method === "sum" ? " or floats" : ""}, got Vec<${chk.show(el)}>`, sp);
        for (const a of expr.args) chk.checkExpr(a);
        return chk.setType(expr, { tag: "unknown" });
      }
      const fn = chk.currentFnDecl;
      const wrapping = expr.method === "sum" && el.tag === "int" &&
        !!(fn?.fromWrappingModule || fn?.attributes?.some(a => a.name === "wrapping"));
      const plain: TypeKind = el.tag === "int" ? { tag: "int", bits: el.bits, signed: el.signed } : el;
      const body = chk.instantiateContainerImpl("Vec", [plain], wrapping ? "wrappingSum" : expr.method);
      if (body) return chk.dispatchMangledMethod(expr, body.mangled, sp);
    }
    // contains is std/vec code; its element-type restriction stays here, at the call.
    if (expr.method === "contains") {
      if (!chk.vecSearchComparable(objType.element, "contains", "any", sp)) return chk.setType(expr, { tag: "bool" });
      const plain = chk.plainSearchElement(objType.element, expr.method);
      if (plain) return chk.dispatchMangledMethod(expr, plain, sp);
    }
    if (expr.method === "reverse") {
      if (expr.args.length !== 0) { chk.error(`'reverse' takes no arguments`, sp); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot reverse immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      return chk.bindStdVecMethod(expr, objType.element, "reverse", { tag: "void" });
    }
    if (expr.method === "swap") {
      if (expr.args.length !== 2) { chk.error(`'swap' expects 2 arguments (index a, index b)`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot swap on immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const aType = chk.checkExpr(expr.args[0]);
      const bType = chk.checkExpr(expr.args[1]);
      if (aType.tag !== "int" && aType.tag !== "unknown") { chk.error(`'swap' index must be an integer, got ${chk.show(aType)}`, sp); }
      if (bType.tag !== "int" && bType.tag !== "unknown") { chk.error(`'swap' index must be an integer, got ${chk.show(bType)}`, sp); }
      return chk.bindStdVecMethod(expr, objType.element, "swap", { tag: "void" });
    }
    if (expr.method === "insert") {
      if (expr.args.length !== 2) { chk.error(`'insert' expects 2 arguments (index, value)`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot insert into immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const idxType = chk.checkExpr(expr.args[0]);
      if (idxType.tag !== "int" && idxType.tag !== "unknown") { chk.error(`'insert' index must be an integer, got ${chk.show(idxType)}`, sp); }
      const valType = chk.checkExpr(expr.args[1], objType.element);
      if (objType.element.tag === "int") chk.enforceRangeInto(expr.args[1], valType, objType.element, expr.args[1].span);
      if (!typeEq(objType.element, valType) && valType.tag !== "unknown") {
        chk.error(`'insert' value: expected ${chk.show(objType.element)}, got ${chk.show(valType)}`, sp);
      }
      chk.tryMove(expr.args[1]);
      chk.holdPointerArgsIn(expr.object, [expr.args[1]]);
      return chk.bindStdVecMethod(expr, objType.element, "insert", { tag: "void" });
    }
    if (expr.method === "remove") {
      if (expr.args.length !== 1) { chk.error(`'remove' expects 1 argument (index)`, sp); return chk.setType(expr, objType.element); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot remove from immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const idxType = chk.checkExpr(expr.args[0]);
      if (idxType.tag !== "int" && idxType.tag !== "unknown") { chk.error(`'remove' index must be an integer, got ${chk.show(idxType)}`, sp); }
      return chk.bindStdVecMethod(expr, objType.element, "remove", objType.element);
    }
    if (expr.method === "sort") {
      if (expr.args.length !== 0) { chk.error(`'sort' takes no arguments`, sp); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const el = objType.element;
      if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
        chk.error(`'sort' requires Vec of a comparable type (int, float, string, bool)`, sp);
        return chk.setType(expr, { tag: "void" });
      }
      return chk.bindStdVecMethod(expr, el, "sort", { tag: "void" });
    }
    if (expr.method === "sortBy") {
      if (expr.args.length !== 1) { chk.error(`'sortBy' expects 1 argument (comparator)`, sp); return chk.setType(expr, { tag: "unknown" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
      // The return is left open in the hint and checked below: any signed integer is
      // read by its sign, so an i64 key difference (`a.t - b.t`) needs no `as i32`,
      // the cast that truncated a difference of k * 2^32 to 0.
      const cbHint: TypeKind = { tag: "fn", params: [elemRef, elemRef], ret: { tag: "unknown" } };
      // The body is std/vec's sortBy<R>, R the comparator's return type; checked here
      // once and bound after, as map is.
      chk.coerceCopyCallback(expr.args[0], cbHint);
      chk.thunkByValueFnValue(expr.args[0]!, objType.element, 2);
      const cbBorrow = chk.borrowDuringCallback(expr.object, expr);
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "sortBy", sp);
      if (cbBorrow) chk.unfreeze(cbBorrow);
      if (cbType.tag !== "fn") { chk.error(`'sortBy' argument must be a comparator function`, sp); }
      else if (cbType.ret.tag !== "unknown" && !(cbType.ret.tag === "int" && cbType.ret.signed)) {
        chk.error(`'sortBy' callback returns ${chk.show(cbType.ret)}, but sortBy expects a signed integer (negative: a first, positive: b first, zero: keep order)`, sp,
          `return an ordering such as 'if a.x < b.x { -1 } else if a.x > b.x { 1 } else { 0 }', or sort by a key with 'sortByKey'`);
      } else if (cbType.ret.tag === "int" && chk.refuseByValueCallback(cbType, elemRef, "sortBy", sp) === false) {
        const r: TypeKind = { tag: "int", bits: cbType.ret.bits, signed: true };
        return chk.bindStdVecMethod(expr, objType.element, "sortBy", { tag: "void" }, { typeArgs: [r] });
      }
      return chk.setType(expr, { tag: "void" });
    }
    if (expr.method === "sortByKey") {
      if (expr.args.length !== 1) { chk.error(`'sortByKey' expects 1 argument (key extractor)`, sp); return chk.setType(expr, { tag: "unknown" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot sort immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const elemRef: TypeKind = { tag: "ref", inner: objType.element, mutable: false };
      const cbHint: TypeKind = { tag: "fn", params: [elemRef], ret: { tag: "unknown" } };
      chk.coerceCopyCallback(expr.args[0], cbHint);
      chk.thunkByValueFnValue(expr.args[0]!, objType.element, 1);
      const cbBorrow = chk.borrowDuringCallback(expr.object, expr);
      // The one position where a closure may hand back a field of its borrowed
      // parameter: the sort reads the key to compare it and never stores or drops it
      // (std/vec's sortByKey forgets every key it is handed).
      chk.keyExtractorClosures.add(expr.args[0]!);
      // Exempt only the returned key reads, not the whole body: any other move out of the
      // borrowed element (a `let`, an argument, a nested closure's return) really would
      // free or alias the element's buffer, and the backend refusing it is a backstop.
      const ret = chk.extractorReturns(expr.args[0]!);
      for (const v of ret.values) if (ret.rooted(v)) chk.extractorKeyReads.add(v);
      const cbType = chk.checkExpr(expr.args[0], cbHint);
      chk.checkCallbackSig(cbType, cbHint, "sortByKey", sp);
      if (cbBorrow) chk.unfreeze(cbBorrow);
      if (cbType.tag !== "fn") { chk.error(`'sortByKey' argument must be a function`, sp); return chk.setType(expr, { tag: "void" }); }
      const keyType = cbType.ret;
      if (keyType.tag !== "int" && keyType.tag !== "float" && keyType.tag !== "string" && keyType.tag !== "bool") {
        if (keyType.tag !== "unknown") chk.error(`'sortByKey' key must be a comparable type (int, float, string, bool), got ${chk.show(keyType)}`, sp);
        return chk.setType(expr, { tag: "void" });
      }
      if (chk.refuseByValueCallback(cbType, elemRef, "sortByKey", sp)) return chk.setType(expr, { tag: "void" });
      // A string key that is the element's own field is a borrow, which sortByKey only
      // reads and forgets; one the extractor builds is owned, and sortByKeyOwned drops
      // it. An extractor that does both cannot be sorted by either. [MILO-O-keyExtractor]
      const keys = keyType.tag === "string" ? chk.extractorKeys(expr.args[0]!) : "borrowed";
      if (keys === "mixed") {
        chk.error(`'sortByKey' key extractor returns the element's own field on one path and a new string on another`, sp,
          `return a new string on every path, e.g. 'p.name.clone()' for the field`);
        return chk.setType(expr, { tag: "void" });
      }
      return chk.bindStdVecMethod(expr, objType.element, keys === "owned" ? "sortByKeyOwned" : "sortByKey", { tag: "void" }, { typeArgs: [keyType] });
    }
    if (expr.method === "len") {
      if (expr.args.length !== 0) { chk.error(`'len' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (expr.method === "clone") {
      if (expr.args.length !== 0) { chk.error(`'clone' takes no arguments`, sp); }
      // An interface value's itable has no clone slot, and a closure's
      // captured environment has no copy path — neither can be duplicated.
      const el = objType.element;
      if (el.tag === "interface") {
        chk.error(`cannot clone Vec<${chk.show(el)}>: an interface value has no clone`, sp,
          `the concrete type is erased and the itable carries no clone slot — build a new Vec from the concrete values instead`);
      } else if (el.tag === "fn") {
        chk.error(`cannot clone Vec<${chk.show(el)}>: closures cannot be cloned`, sp);
      } else if (!chk.errorIfResourceCopyOut(el, "clone", "Vec", sp, `Build the copy element by element ('for x in v { out.push(x.clone()) }')`)) {
        return chk.bindStdVecMethod(expr, el, "clone", objType, { mutable: false });
      }
      return chk.setType(expr, objType);
    }
    // `v[i]` panics out of range; get is the total read. The element comes back
    // cloned — a reference into the buffer could not outlive a later push.
    if (expr.method === "get") {
      if (expr.args.length !== 1) {
        chk.error(`'get' expects 1 argument (index), got ${expr.args.length}`, sp);
      } else {
        const idxType = chk.checkExpr(expr.args[0]);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") { chk.error(`'get' index must be an integer, got ${chk.show(idxType)}`, sp); }
      }
      chk.errorIfResourceCopyOut(objType.element, expr.method, "Vec", sp, `Borrow it ('v[i].field', 'for x in v'), or take it out for real with 'remove'/'pop'`);
      return chk.setType(expr, chk.resolveOptionForValue(objType.element, sp));
    }
    // first/last are std/vec calls of get; the copy-out rule is checked here so the
    // error names the caller's method and line, not the get inside std.
    if ((expr.method === "first" || expr.method === "last") &&
        chk.errorIfResourceCopyOut(objType.element, expr.method, "Vec", sp, `Borrow it ('v[i].field', 'for x in v'), or take it out for real with 'remove'/'pop'`)) {
      return chk.setType(expr, chk.resolveOptionForValue(objType.element, sp));
    }
    // Same comparable-element gate `sort` uses. Milo has no ordering trait, so
    // rather than invent an ordering for structs (which would be an opinion, not
    // a fact — see the HashMap key note) min/max are refused on them outright.
    if (expr.method === "min" || expr.method === "max") {
      const el = objType.element;
      if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string" && el.tag !== "bool") {
        chk.error(`'${expr.method}' requires a Vec of a comparable type (int, float, string, bool), got Vec<${chk.show(el)}>`, sp,
          `there is no ordering on ${chk.show(el)} — use 'fold' with your own comparison, or 'sortByKey' then 'first'`);
        return chk.setType(expr, { tag: "unknown" });
      }
      // The body is std/vec code over _natLess; only the element gate stays here.
    }
    // `find` answers "which value"; `indexOf`/`position` answer "where".
    // indexOf is std/vec code, gated and dispatched like contains.
    if (expr.method === "indexOf") {
      if (!chk.vecSearchComparable(objType.element, "indexOf", "position", sp)) return chk.setType(expr, { tag: "unknown" });
      const plain = chk.plainSearchElement(objType.element, expr.method);
      if (plain) return chk.dispatchMangledMethod(expr, plain, sp);
    }
    // extend moves the other Vec in — its elements are transplanted, not copied,
    // so there is no clone and no way to touch the source afterwards.
    if (expr.method === "extend") {
      if (expr.args.length !== 1) { chk.error(`'extend' expects 1 argument (a Vec to append)`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot extend an immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const otherType = chk.checkExpr(expr.args[0], objType);
      if (otherType.tag === "ref") {
        chk.error(`'extend' takes ownership of the other Vec`, sp, `clone it if you still need it: 'v.extend(other.clone())'`);
      } else if (!typeEq(objType, otherType) && otherType.tag !== "unknown") {
        chk.error(`'extend': expected ${chk.show(objType)}, got ${chk.show(otherType)}`, sp);
      }
      chk.tryMove(expr.args[0]);
      return chk.bindStdVecMethod(expr, objType.element, "extend", { tag: "void" });
    }
    // retain is std/vec code, dispatched like the read-only callback methods (receiver
    // frozen while the predicate is checked); the receiver rule keeps "cannot retain on
    // an immutable Vec".
    if (expr.method === "retain") {
      const body = chk.instantiateContainerImpl("Vec", [objType.element], "retain");
      if (body) return chk.dispatchMangledMethod(expr, body.mangled, sp, true);
    }
    if (expr.method === "capacity") {
      if (expr.args.length !== 0) { chk.error(`'capacity' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (expr.method === "reserve") {
      if (expr.args.length !== 1) { chk.error(`'reserve' expects 1 argument (extra capacity)`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot reserve on an immutable Vec`, sp, `declare with 'var' to make it mutable`);
      }
      const nType = chk.checkExpr(expr.args[0]);
      if (nType.tag !== "int" && nType.tag !== "unknown") { chk.error(`'reserve': expected an integer, got ${chk.show(nType)}`, sp); }
      return chk.bindStdVecMethod(expr, objType.element, "reserve", { tag: "void" });
    }
    {
      const blanket = chk.instantiateContainerImpl("Vec", [objType.element], expr.method);
      if (blanket) return chk.dispatchMangledMethod(expr, blanket.mangled, sp);
      if (chk.reportWithheldContainerMethod("Vec", [objType.element], objType, expr.method, sp)) return chk.setType(expr, { tag: "unknown" });
    }
    chk.error(`Vec has no method '${expr.method}'`, sp, memberHint(expr.method, VEC_MEMBERS));
    return chk.setType(expr, { tag: "unknown" });
  }
  if (objType.tag === "hashmap") {
    if (expr.method === "insert") {
      if (expr.args.length !== 2) { chk.error(`'insert' expects 2 arguments, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot insert into immutable HashMap`, sp, `declare with 'var' to make it mutable`);
      }
      const keyType = chk.checkExpr(expr.args[0], objType.key);
      if (objType.key.tag === "int") chk.enforceRangeInto(expr.args[0], keyType, objType.key, expr.args[0].span);
      if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
        chk.error(`insert key: expected ${chk.show(objType.key)}, got ${chk.show(keyType)}`, sp);
      }
      // The key moves before the value is evaluated, as codegen does it, so
      // `m.insert(k, m.get(k))` is a use after move rather than a lookup of an emptied key.
      chk.tryMove(expr.args[0]);
      const valType = chk.checkExpr(expr.args[1], objType.value);
      if (objType.value.tag === "int") chk.enforceRangeInto(expr.args[1], valType, objType.value, expr.args[1].span);
      if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
        chk.error(`insert value: expected ${chk.show(objType.value)}, got ${chk.show(valType)}`, sp);
      }
      chk.tryMove(expr.args[1]);
      chk.holdPointerArgsIn(expr.object, expr.args);
      // The body is std/hashmap code, but the call keeps the rules above rather than
      // dispatchMangledMethod's: its call-site exclusivity check would refuse the common
      // `m.insert(k, m.getOrDefault(k, 0) + 1)`, whose value is computed before the call.
      const body = chk.instantiateContainerImpl("HashMap", [objType.key, objType.value], "insert");
      if (!body) {
        chk.error(`HashMap has no method 'insert'`, sp);
        return chk.setType(expr, { tag: "void" });
      }
      chk.autoBorrow(expr.object, { mutable: true });
      chk.resolvedMethods.set(expr, body.mangled);
      return chk.setType(expr, { tag: "void" });
    }
    // The copying lookups are std/hashmap code; the copy-out rule stays here so a
    // resource value is refused at the call, before the std body is instantiated.
    if ((expr.method === "get" || expr.method === "getOrDefault") &&
        chk.errorIfResourceCopyOut(objType.value, expr.method, "HashMap", sp, `Borrow it with 'for k, v in m', or take it out for real with 'remove'`)) {
      for (const a of expr.args) chk.checkExpr(a);
      return chk.setType(expr, { tag: "unknown" });
    }
    if (expr.method === "len") {
      if (expr.args.length !== 0) { chk.error(`'len' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    // clone is std/hashmap code (one _mapCopyOut of the whole table); the copies it
    // cannot make are refused here, at the call.
    if (expr.method === "clone") {
      let refused = false;
      for (const [what, t] of [["key", objType.key], ["value", objType.value]] as const) {
        if (t.tag === "interface") {
          chk.error(`cannot clone a HashMap with ${what} type ${chk.show(t)}: an interface value has no clone`, sp,
            `the concrete type is erased and the itable carries no clone slot`);
          refused = true;
        } else if (t.tag === "fn") {
          chk.error(`cannot clone a HashMap with ${what} type ${chk.show(t)}: closures cannot be cloned`, sp);
          refused = true;
        } else if (chk.errorIfResourceCopyOut(t, "clone", "HashMap", sp, `Build the copy entry by entry ('for k, v in m { out.insert(k.clone(), v.clone()) }')`)) {
          refused = true;
        }
      }
      if (refused) return chk.setType(expr, objType);
    }
    // keys()/values() are std/hashmap code copying each element out structurally; the
    // copies they cannot make are refused here, at the call, before the body exists.
    if (expr.method === "keys" || expr.method === "values") {
      const el = expr.method === "keys" ? objType.key : objType.value;
      if (el.tag === "interface" || el.tag === "fn") {
        chk.error(`'${expr.method}' cannot copy ${chk.show(el)} out of the map`, sp,
          `iterate with 'for k, v in map' instead — it borrows rather than copies`);
        return chk.setType(expr, { tag: "unknown" });
      }
      if (chk.errorIfResourceCopyOut(el, expr.method, "HashMap", sp, `Iterate with 'for k, v in m' instead, which borrows`)) {
        return chk.setType(expr, { tag: "unknown" });
      }
    }
    {
      const blanket = chk.instantiateContainerImpl("HashMap", [objType.key, objType.value], expr.method);
      if (blanket) return chk.dispatchMangledMethod(expr, blanket.mangled, sp, expr.method === "modify" || expr.method === "getOrInsertWith");
      if (chk.reportWithheldContainerMethod("HashMap", [objType.key, objType.value], objType, expr.method, sp)) return chk.setType(expr, { tag: "unknown" });
    }
    chk.error(`HashMap has no method '${expr.method}'`, sp, memberHint(expr.method, HASHMAP_MEMBERS));
    return chk.setType(expr, { tag: "unknown" });
  }
  if (objType.tag === "string") {
    if (expr.method === "push") {
      if (expr.args.length !== 1) { chk.error(`'push' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot push to immutable string`, sp, `declare with 'var' to make it mutable`);
      }
      // Hint the arg with u8 so an int literal coerces — `s.push(65)` demanded an
      // explicit `as u8` only because this checked without a hint, unlike Vec.push.
      // An out-of-range literal is still rejected by the coercion itself.
      const u8t: TypeKind = { tag: "int", bits: 8, signed: false };
      const argType = chk.checkExpr(expr.args[0], u8t);
      if (!typeEq(u8t, argType) && argType.tag !== "unknown") {
        chk.error(`string.push: expected u8, got ${chk.show(argType)}`, sp);
      }
      return chk.bindStdStringMethod(expr, "push", { tag: "void" }, [], true);
    }
    if (expr.method === "setByte") {
      if (expr.args.length !== 2) { chk.error(`'setByte' expects 2 arguments (index, byte), got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot setByte on an immutable string`, sp, `declare with 'var' to make it mutable`);
      }
      const iType = chk.checkExpr(expr.args[0]);
      if (iType.tag !== "int" && iType.tag !== "unknown") {
        chk.error(`string.setByte: expected an integer byte index, got ${chk.show(iType)}`, sp);
      }
      const u8t: TypeKind = { tag: "int", bits: 8, signed: false };
      const bType = chk.checkExpr(expr.args[1], u8t);
      if (!typeEq(u8t, bType) && bType.tag !== "unknown") {
        chk.error(`string.setByte: expected u8, got ${chk.show(bType)}`, sp);
      }
      return chk.bindStdStringMethod(expr, "setByte", { tag: "void" }, [], true);
    }
    if (expr.method === "pushStr") {
      if (expr.args.length !== 1) { chk.error(`'pushStr' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot push to immutable string`, sp, `declare with 'var' to make it mutable`);
      }
      const argType = chk.checkExpr(expr.args[0]);
      const argInner = chk.deref(argType);
      if (argInner.tag !== "string" && argInner.tag !== "unknown") {
        chk.error(`string.pushStr: expected string, got ${chk.show(argType)}`, sp);
      }
      chk.setAutoBorrowChecked(expr.args[0], false);
      return chk.setType(expr, { tag: "void" });
    }
    if (expr.method === "pushInt") {
      if (expr.args.length !== 1) { chk.error(`'pushInt' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot push to immutable string`, sp, `declare with 'var' to make it mutable`);
      }
      const argType = chk.deref(chk.checkExpr(expr.args[0]));
      if (argType.tag !== "int" && argType.tag !== "unknown") {
        chk.error(`string.pushInt: expected an integer, got ${chk.show(argType)}`, sp,
          `pushInt appends an integer's decimal digits; append other values with pushStr($"{x}")`);
      }
      return chk.setType(expr, { tag: "void" });
    }
    if (expr.method === "clear" || expr.method === "truncate") {
      // Same arity and length rules as Vec's; a string keeps its capacity either way.
      const want = expr.method === "clear" ? 0 : 1;
      if (expr.args.length !== want) {
        chk.error(`'${expr.method}' expects ${want} argument${want === 1 ? "" : "s"}, got ${expr.args.length}`, sp);
      }
      if (want === 1 && expr.args.length === 1) {
        const nType = chk.checkExpr(expr.args[0]);
        if (nType.tag !== "int" && nType.tag !== "unknown") {
          chk.error(`'truncate': expected an integer byte length, got ${chk.show(nType)}`, sp);
        }
      }
      if (!chk.isRootMutable(expr.object)) {
        chk.error(`cannot ${expr.method} an immutable string`, sp, `declare with 'var' to make it mutable`);
      }
      return chk.bindStdStringMethod(expr, expr.method, { tag: "void" }, [], true);
    }
    if (expr.method === "substr") {
      if (expr.args.length !== 2) { chk.error(`'substr' expects 2 arguments, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "string" }); }
      const startType = chk.checkExpr(expr.args[0]);
      const endType = chk.checkExpr(expr.args[1]);
      if (startType.tag !== "int" && startType.tag !== "unknown") chk.error(`substr start: expected integer, got ${chk.show(startType)}`, sp);
      if (endType.tag !== "int" && endType.tag !== "unknown") chk.error(`substr end: expected integer, got ${chk.show(endType)}`, sp);
      return chk.bindStdStringMethod(expr, "substr", { tag: "string" });
    }
    if (expr.method === "slice") {
      const refStr: TypeKind = { tag: "ref", inner: { tag: "string" }, mutable: false };
      if (expr.args.length !== 2) { chk.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp); return chk.setType(expr, refStr); }
      const startType = chk.checkExpr(expr.args[0]);
      const endType = chk.checkExpr(expr.args[1]);
      if (startType.tag !== "int" && startType.tag !== "unknown") chk.error(`slice start: expected integer, got ${chk.show(startType)}`, sp);
      if (endType.tag !== "int" && endType.tag !== "unknown") chk.error(`slice end: expected integer, got ${chk.show(endType)}`, sp);
      // Same temporary hazard as the slice-of-Vec case above, same reasoning.
      if (!chk.isPlaceExpr(expr.object)) {
        chk.error(`cannot take a slice of a temporary`, sp,
          `the '&string' would outlive the value it points into: bind the receiver first ('let r = ...' then slice 'r')`);
      }
      // mark source as borrowed — prevents mutation/move while slice is live.
      // Walk to the root variable: `buf.data[a..b]` views storage owned by `buf`,
      // so replacing any part of `buf` can free what this points into.
      chk.freezeRootOf(expr.object);
      chk.borrowedExprs.add(expr);
      return chk.setType(expr, refStr);
    }
    if (expr.method === "parseF64") {
      if (expr.args.length !== 0) { chk.error(`'parseF64' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Option", [{ tag: "float", bits: 64 }]) });
    }
    if (expr.method === "clone") {
      if (expr.args.length !== 0) { chk.error(`'clone' takes no arguments`, sp); }
      if (chk.reportStringClones && !chk.instanceNodes.has(expr)) chk.stringCloneCalls.push(expr);
      return chk.bindStdStringMethod(expr, "clone", { tag: "string" });
    }
    // string methods delegated to std/string runtime functions
    if (expr.method === "contains" || expr.method === "startsWith" || expr.method === "endsWith") {
      if (expr.args.length !== 1) { chk.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "bool" }); }
      const argType = chk.checkExpr(expr.args[0]);
      if (argType.tag !== "string" && argType.tag !== "unknown") chk.error(`'${expr.method}': expected string, got ${chk.show(argType)}`, sp);
      return chk.setType(expr, { tag: "bool" });
    }
    if (expr.method === "indexOf" || expr.method === "lastIndexOf") {
      const optionI64: TypeKind = { tag: "enum", name: chk.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
      if (expr.args.length !== 1) { chk.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, optionI64); }
      const argType = chk.checkExpr(expr.args[0]);
      if (argType.tag !== "string" && argType.tag !== "unknown") chk.error(`'${expr.method}': expected string, got ${chk.show(argType)}`, sp);
      return chk.bindStdStringMethod(expr, expr.method, optionI64, [0]);
    }
    // like indexOf but starts the search at byte offset `from`
    if (expr.method === "indexOfFrom") {
      const optionI64: TypeKind = { tag: "enum", name: chk.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) };
      if (expr.args.length !== 2) { chk.error(`'indexOfFrom' expects 2 arguments (needle, from), got ${expr.args.length}`, sp); return chk.setType(expr, optionI64); }
      const nType = chk.checkExpr(expr.args[0]);
      if (nType.tag !== "string" && nType.tag !== "unknown") chk.error(`'indexOfFrom' arg 1: expected string, got ${chk.show(nType)}`, sp);
      const fromType = chk.checkExpr(expr.args[1]);
      if (fromType.tag !== "int" && fromType.tag !== "unknown") chk.error(`'indexOfFrom' arg 2: expected integer, got ${chk.show(fromType)}`, sp);
      return chk.bindStdStringMethod(expr, "indexOfFrom", optionI64, [0]);
    }
    if (expr.method === "split") {
      if (expr.args.length !== 1) { chk.error(`'split' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "vec", element: { tag: "string" } }); }
      const argType = chk.checkExpr(expr.args[0]);
      if (argType.tag !== "string" && argType.tag !== "unknown") chk.error(`'split': expected string, got ${chk.show(argType)}`, sp);
      return chk.setType(expr, { tag: "vec", element: { tag: "string" } });
    }
    if (expr.method === "isEmpty") {
      if (expr.args.length !== 0) { chk.error(`'isEmpty' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "bool" });
    }
    // Loop-only: each piece is a `&string` view into the receiver, and a view has no
    // storage to live in outside the loop that freezes the receiver for it.
    if (expr.method === "lines" || expr.method === "splitView") {
      const owned = expr.method === "lines" ? `split("\\n")` : `split(sep)`;
      const call = expr.method === "lines" ? `lines()` : `splitView(sep)`;
      chk.error(`'${expr.method}' is only valid as the iterable of a 'for ... in' loop over a named string`, sp,
        `it yields borrowed slices, which cannot be stored: bind the string first ('let text = ...') and write 'for piece in text.${call}', or use '${owned}' for owned copies`);
      return chk.setType(expr, { tag: "unknown" });
    }
    if (expr.method === "splitWords" || expr.method === "splitWhitespace") {
      if (expr.args.length !== 0) { chk.error(`'${expr.method}' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "vec", element: { tag: "string" } });
    }
    if (expr.method === "trim" || expr.method === "trimStart" || expr.method === "trimEnd" || expr.method === "toLower" || expr.method === "toUpper" || expr.method === "reverse") {
      if (expr.args.length !== 0) { chk.error(`'${expr.method}' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "string" });
    }
    if (expr.method === "charAt") {
      if (expr.args.length !== 1) { chk.error(`'charAt' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "string" }); }
      const argType = chk.checkExpr(expr.args[0]);
      if (argType.tag !== "int" && argType.tag !== "unknown") chk.error(`'charAt': expected integer, got ${chk.show(argType)}`, sp);
      return chk.setType(expr, { tag: "string" });
    }
    if (expr.method === "parseInt") {
      if (expr.args.length !== 0) { chk.error(`'parseInt' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "enum", name: chk.monomorphizeEnum("Option", [{ tag: "int", bits: 64, signed: true }]) });
    }
    if (expr.method === "replace" || expr.method === "replaceFirst") {
      if (expr.args.length !== 2) { chk.error(`'replace' expects 2 arguments, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "string" }); }
      const a1 = chk.checkExpr(expr.args[0]);
      const a2 = chk.checkExpr(expr.args[1]);
      if (a1.tag !== "string" && a1.tag !== "unknown") chk.error(`'replace' arg 1: expected string, got ${chk.show(a1)}`, sp);
      if (a2.tag !== "string" && a2.tag !== "unknown") chk.error(`'replace' arg 2: expected string, got ${chk.show(a2)}`, sp);
      return chk.setType(expr, { tag: "string" });
    }
    if (expr.method === "repeat") {
      if (expr.args.length !== 1) { chk.error(`'repeat' expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "string" }); }
      const argType = chk.checkExpr(expr.args[0]);
      if (argType.tag !== "int" && argType.tag !== "unknown") chk.error(`'repeat': expected integer, got ${chk.show(argType)}`, sp);
      return chk.setType(expr, { tag: "string" });
    }
    if (expr.method === "padStart" || expr.method === "padEnd") {
      if (expr.args.length !== 2) { chk.error(`'${expr.method}' expects 2 arguments (targetLen, padStr), got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "string" }); }
      const lenType = chk.checkExpr(expr.args[0]);
      const padType = chk.checkExpr(expr.args[1]);
      if (lenType.tag !== "int" && lenType.tag !== "unknown") chk.error(`'${expr.method}' arg 1: expected integer, got ${chk.show(lenType)}`, sp);
      if (padType.tag !== "string" && padType.tag !== "unknown") chk.error(`'${expr.method}' arg 2: expected string, got ${chk.show(padType)}`, sp);
      return chk.setType(expr, { tag: "string" });
    }
    if (expr.method === "len") {
      if (expr.args.length !== 0) { chk.error(`'len' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "int", bits: 64, signed: true });
    }
    if (expr.method === "cstr") {
      if (expr.args.length !== 0) { chk.error(`'cstr' takes no arguments`, sp); }
      return chk.setType(expr, { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } });
    }
    // fall through to trait/inherent lookup for String
  }

  // user-defined method resolution: inherent first, then traits.
  // A `Heap<T>` receiver resolves to T's method; record it so lower can
  // insert the deref. Without it codegen passes the address of the Heap
  // slot (a ptr-to-ptr) as `&T`.
  if (objType.tag === "heap") chk.heapMethodReceivers.add(expr);
  const derefOnce = objType.tag === "ref" ? objType.inner : objType.tag === "heap" ? objType.inner : objType;
  const bareObjType = derefOnce.tag === "ref" ? derefOnce.inner : derefOnce;
  // interface method dispatch — virtual call through itable
  if (bareObjType.tag === "interface") {
    const iface = chk.interfaces.get(bareObjType.name);
    if (iface) {
      const ifaceMethod = iface.methods.get(expr.method);
      if (ifaceMethod) {
        // self is always borrowed for interface calls
        const ifaceSelfMut = ifaceMethod.params[0]?.type.tag === "ref" && (ifaceMethod.params[0].type as any).mutable;
        if (ifaceSelfMut && chk.refuseImmutableReceiver(expr, sp)) {
          for (const a of expr.args) chk.checkExpr(a);
          return chk.setType(expr, ifaceMethod.ret);
        }
        chk.autoBorrow(expr.object, { mutable: ifaceSelfMut });
        if (expr.args.length !== ifaceMethod.params.length - 1) {
          chk.error(`'${expr.method}' expects ${ifaceMethod.params.length - 1} argument(s), got ${expr.args.length}`, sp);
        }
        chk.takeExplicitMutArgs(expr.args, expr.method, i => chk.sigParamAt(ifaceMethod.params[i + 1]));
        for (let i = 0; i < expr.args.length; i++) {
          const expected = ifaceMethod.params[i + 1];
          if (!expected) break;
          chk.checkMethodArg(expr, i, expected.type, sp);
          if (!chk.argIsBorrowed(expr.args[i], expected.type)) chk.tryMove(expr.args[i]);
        }
        chk.checkCallSiteExclusivity([expr.object, ...expr.args], sp);
        // compute method index for itable slot
        let methodIndex = 0;
        for (const [name] of iface.methods) {
          if (name === expr.method) break;
          methodIndex++;
        }
        chk.interfaceMethodCalls.set(expr, { ifaceName: bareObjType.name, methodName: expr.method, methodIndex });
        return chk.setType(expr, ifaceMethod.ret);
      }
      chk.error(`interface '${bareObjType.name}' has no method '${expr.method}'`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }
  }
  const objTName = typeName(bareObjType);
  // A method carrying its own type parameters is instantiated here, before the ordinary
  // resolution path: until a call supplies them there is no signature to resolve against.
  const genericKey = `${objTName}$${expr.method}`;
  if (chk.genericMethods.has(genericKey)) {
    const typeArgs = chk.inferMethodTypeArgs(genericKey, expr, expected);
    if (!typeArgs) {
      const tpl = must(chk.genericMethods, genericKey, "generic methods");
      const unresolved = (tpl.decl.typeParams ?? []).map(t => `'${t.name}'`).join(", ");
      chk.error(`cannot infer ${unresolved} for '${objTName}.${expr.method}'`, sp,
        `nothing in the arguments or the expected return type fixes it — annotate the call's result, or the closure's return type`);
      return chk.setType(expr, { tag: "unknown" });
    }
    const mangled = chk.monomorphizeMethod(genericKey, typeArgs, sp);
    if (mangled) return chk.dispatchMangledMethod(expr, mangled, sp);
  }

  const resolved = chk.resolveMethod(objTName, expr.method);
  if (resolved) {
    const { mangled, sig } = resolved;
    // args: self is expr.object, rest are expr.args
    // first param is self — check remaining args
    const selfParam = sig.params[0];
    if (selfParam) {
      if (selfParam.type.tag === "ref") {
        if (selfParam.type.mutable && chk.refuseImmutableReceiver(expr, sp)) {
          for (const a of expr.args) chk.checkExpr(a);
          return chk.setType(expr, sig.ret);
        }
        // a `&var self` method may mutate the receiver — same hazard as builtins
        if (selfParam.type.mutable) chk.errorIfFrozen(expr.object, `call '${expr.method}' on`, sp);
        if (selfParam.type.mutable) chk.errorIfCopyBind(expr.object, expr.method, sp);
        chk.autoBorrow(expr.object, { mutable: selfParam.type.mutable });
      } else {
        chk.tryMove(expr.object);
      }
    }
    if (expr.args.length !== sig.params.length - 1) {
      chk.error(`'${expr.method}' expects ${sig.params.length - 1} argument(s), got ${expr.args.length}`, sp);
    }
    chk.takeExplicitMutArgs(expr.args, expr.method, i => chk.sigParamAt(sig.params[i + 1]));
    for (let i = 0; i < expr.args.length; i++) {
      const expected = sig.params[i + 1];
      if (!expected) break;
      chk.checkMethodArg(expr, i, expected.type, sp, argType => {
        const bare = expected.type.tag === "ref" ? expected.type.inner : expected.type;
        // Only a struct: codegen's stringifier has no scalar path, so the
        // bool/int/float arms this used to accept crashed the compiler.
        if (expr.method === "json" && bare.tag === "string" && argType.tag === "struct") {
          // `ctx.json(user)` auto-stringifies. A struct with a real codec
          // routes through it, so a Vec/Option/nested field serializes
          // properly; the built-in fallback only knows scalar fields and
          // used to emit `"tags":` with no value at all for the rest.
          const codec = argType.tag === "struct" ? chk.resolveMethod(argType.name, "toJson") : null;
          if (codec) {
            chk.autoJsonToJson.set(expr.args[i], codec.mangled);
          } else if (argType.tag === "struct") {
            const si = chk.structs.get(argType.name);
            for (const f of si?.fields ?? []) {
              if (f.type.tag !== "string" && f.type.tag !== "bool" && f.type.tag !== "int" && f.type.tag !== "float") {
                chk.error(`'json': '${argType.name}.${f.name}' has type ${chk.show(f.type)}, which the built-in stringifier cannot serialize`,
                  expr.args[i].span, `add '@derive(Json)' to '${argType.name}' — the derived codec handles nested structs, Vec and Option`);
              }
            }
          }
          chk.autoJsonStringify.set(expr.args[i], argType);
          return true;
        }
        return false;
      });
      if (!chk.argIsBorrowed(expr.args[i], expected.type)) {
        chk.autoMoveClosureArg(expr.args[i], expected.type, c => c.mutable);
        chk.tryMove(expr.args[i]);
      }
    }
    // The receiver is the first argument: `s.set(&mut s.b)` is `S$set(&mut s, &mut s.b)`.
    chk.checkCallSiteExclusivity(selfParam ? [expr.object, ...expr.args] : expr.args, sp);
    chk.resolvedMethods.set(expr, mangled);
    chk.requireUnsafeMethod(mangled, expr.method, sp);
    if (chk.isViewReturn(sig.ret)) chk.freezeViewSource(expr.object, sp, chk.viewReturnFields.get(mangled));
    return chk.setType(expr, sig.ret);
  }

  // fn-typed struct field call: h.apply(args) where apply: fn(...): T
  // A `*Struct` receiver is admitted only for a C function-pointer field, which is
  // where it is the normal shape: C hands over `Ops *`, not a value. Opening the raw
  // pointer to Milo fn fields as well would be a new auto-deref rule, not this feature.
  const ptrStruct = bareObjType.tag === "ptr" && bareObjType.inner.tag === "struct" ? bareObjType.inner : null;
  const structType = bareObjType.tag === "struct" ? bareObjType : ptrStruct;
  if (structType) {
    const sdef = chk.structs.get(structType.name);
    if (sdef) {
      const field = sdef.fields.find(f => f.name === expr.method);
      if (field && (field.type.tag === "fn" || field.type.tag === "cfn") && (!ptrStruct || field.type.tag === "cfn")) {
        const fnType = field.type;
        // A C function pointer may be null, may point at a signature that does not
        // match, and is not owned by anything the checker can see — exactly the
        // situation `unsafe` exists to mark. A Milo fn field has none of those.
        if (fnType.tag === "cfn") {
          chk.requireUnsafe(`calling a C function pointer requires 'unsafe' block`, sp);
        }
        if (expr.args.length !== fnType.params.length) {
          chk.error(`'${expr.method}' expects ${fnType.params.length} argument(s), got ${expr.args.length}`, sp);
        }
        chk.takeExplicitMutArgs(expr.args, expr.method, i => chk.typeParamAt(fnType.params[i], i));
        for (let i = 0; i < expr.args.length; i++) {
          const expected = fnType.params[i];
          if (!expected) break;
          chk.checkMethodArg(expr, i, expected, sp);
          if (!chk.argIsBorrowed(expr.args[i], expected)) chk.tryMove(expr.args[i]);
        }
        chk.checkCallSiteExclusivity(expr.args, sp, fnType.tag !== "cfn");
        if (fnType.tag === "cfn") chk.cfnFieldCalls.add(expr);
        else chk.fnFieldCalls.add(expr);
        return chk.setType(expr, fnType.ret);
      }
    }
  }

  // `.clone()` on a Copy scalar is the identity. It exists so generic code
  // can be written once: `fn get<T>(w: &Wrapper<T>): T { return w.val.clone() }`
  // has to compile for T = i64 as well as T = string, and the move-out-of-
  // a-borrow rule leaves clone as the only way to spell it.
  if (expr.method === "clone" && expr.args.length === 0 &&
      chk.isCopyType(objType)) {
    return chk.setType(expr, objType);
  }

  // A slice shares the Vec layout, so a read-only `impl Vec<T>` method (std or user)
  // takes it as its `&Vec` receiver unchanged, as the builtin combinators above do. A
  // `&mut Self` method could grow or shrink storage the slice only views.
  if (objType.tag === "array" && objType.size === null) {
    const blanket = chk.instantiateContainerImpl("Vec", [objType.element], expr.method);
    if (blanket) {
      const self = blanket.sig.params[0]?.type;
      if (self?.tag !== "ref" || self.mutable) {
        chk.error(`'${expr.method}' needs an owned Vec; a slice is a view`, sp,
          self?.tag === "ref" ? `'${expr.method}' takes 'self: &mut Self', which may grow or shrink the storage; call it on the Vec the slice came from`
            : `'${expr.method}' takes 'self' by value; call it on a Vec`);
        for (const a of expr.args) chk.checkExpr(a);
        return chk.setType(expr, blanket.sig.ret);
      }
      return chk.dispatchMangledMethod(expr, blanket.mangled, sp);
    }
  }

  const skipped = objType.tag === "struct" ? chk.withheldMethods.get(`${objType.name}.${expr.method}`) : undefined;
  if (skipped) {
    chk.error(`'${expr.method}' is not available on '${chk.show(objType)}': ${skipped.reason}`, sp, skipped.hint);
    return chk.setType(expr, { tag: "unknown" });
  }
  chk.error(`type '${chk.show(objType)}' has no method '${expr.method}'`, sp,
    memberHint(expr.method, chk.methodCandidates(objType)));
  return chk.setType(expr, { tag: "unknown" });
}
