// Call expressions: argument matching, callbacks, collection intrinsics, static calls, SQL call notes.
import type { TypeChecker } from "./checker";
import type { Attribute, Expr, MiloType, Span, Stmt, Call, ClosureExpr, EnumLit, MethodCall } from "./ast";
import type { TypeKind } from "./types";
import { NEVER_TYPE, isScalar, typeEq } from "./types";
import { ADOPT_INTRINSICS, MAP_INTRINSICS, RAW_SLICE_INTRINSICS, STR_INTRINSICS, identNameOf, isForeignModule, isHashMapModule, isStringModule, isVecModule, rewritten, unranged } from "./checker-util";
import { SqlChecker, sqlAttrOf } from "./checker-sql";
import { declaredType } from "./ast";
import { formatMiloType } from "./derive-template";
import { must } from "./must";
import type { ArgUse, CaptureInfo } from "./checker";


// `@ordered(K)` names type parameters; a name the declaration does not have would
// constrain nothing, silently.
export function validateOrderedArgs(c: TypeChecker, declName: string, attr: Attribute, typeParams: string[], span?: Span): void {
  attr.args.forEach((arg, i) => {
    if (attr.argKinds?.[i] !== "ident" || !typeParams.includes(arg)) {
      c.error(`'@ordered(${arg})' on '${declName}': '${arg}' is not one of its type parameters`, span,
        `it declares ${typeParams.map(t => `'${t}'`).join(", ") || "none"}; write '@ordered' bare to constrain all of them`);
    }
  });
}

// A total API answers Option<T>, so "expected T, got Option_T" is the first thing
// a caller sees the moment a parser or lookup stops handing back a sentinel. The
// mangled name alone doesn't say what to do about it — name the three ways out.
export function optionUnwrapHint(c: TypeChecker, expected: TypeKind, actual: TypeKind): string | undefined {
  const inner = c.optionInnerType(actual);
  if (!inner || !typeEq(inner, expected)) return undefined;
  return `${c.show(actual)} is Option<${c.show(inner)}> — unwrap it with 'match', `
    + `'let Option.Some(x) = ... else { ... }', or '.unwrapOr(<default>)'`;
}

// The hint an expression of this kind consumes when the context expects `expected`. An
// `Option<T>` slot hands a plain value `T`, which is auto-wrapped (`let o: Option<i64> =
// 5`). An enum literal (`Option.None`) needs the Option itself, and an if or match hands
// the whole expected type to each branch tail, where this applies again at the leaf.
// `Vec<i64>.new()`, `HashMap<string, i64>.withCapacity(8)`: a static call on a builtin
// collection with its type arguments spelled. Returns the instance type (checked like
// an annotated `Vec.new()`), "rewritten" when the call became another call, or null
// after an error. `Vec<T>.fromJson(text)` is `T.fromJsonArray(text)`: the derive puts
// the array decoder on the element type, and this is the spelling that names it.
export function spelledBuiltinStatic(c: TypeChecker, expr: EnumLit): TypeKind | "rewritten" | null {
  const args = expr.typeArgs!;
  const want = expr.enumName === "Vec" ? 1 : 2;
  if (args.length !== want) {
    c.error(`'${expr.enumName}' takes ${want} type argument${want === 1 ? "" : "s"}, got ${args.length}`, expr.span,
      `'${expr.enumName === "Vec" ? "Vec<T>" : "HashMap<K, V>"}.${expr.variant}(...)'`);
    return null;
  }
  if (expr.enumName === "Vec" && expr.variant === "fromJson") {
    const elem = c.resolve(args[0]);
    if (elem.tag === "unknown") return null;
    if (elem.tag !== "struct" || !c.jsonCapableStructs.has(elem.name)) {
      c.error(`'Vec<${c.show(elem)}>.fromJson' needs '${c.show(elem)}' to have a Json codec`, expr.span,
        `add @derive(Json) to the element struct; the call is then '${c.show(elem)}.fromJsonArray(text)'`);
      return null;
    }
    c.rewrites.set(expr, { kind: "EnumLit", enumName: elem.name, variant: "fromJsonArray", args: expr.args, span: expr.span });
    return "rewritten";
  }
  if (!["new", "withCapacity", "filled"].includes(expr.variant) || (expr.enumName === "HashMap" && expr.variant === "filled")) {
    c.error(`'${expr.enumName}' has no static method '${expr.variant}'`, expr.span,
      expr.enumName === "Vec" ? `Vec's are 'new', 'withCapacity', 'filled' and, for an element with a Json codec, 'fromJson'` : `HashMap's are 'new' and 'withCapacity'`);
    return null;
  }
  return c.resolve({ name: expr.enumName, typeArgs: args, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null, span: expr.span });
}

// `contains`/`indexOf` compare elements inline in codegen (icmp/fcmp/string compare), so
// only those element types are searchable. `contains` used to skip this check and a
// Vec<Struct> reached codegen as an `icmp` on an aggregate, which clang rejected.
// `_natLess(a, b): bool`, std/vec only. Both operands are places of one comparable type
// (int, float, string, bool), read in place as _mapKeyEq's keys are, so comparing two
// string elements makes no refcount round trip.
export function checkNatLess(c: TypeChecker, expr: Call): TypeKind {
  const sp = expr.span;
  if (expr.args.length !== 2) {
    c.error(`'_natLess' expects 2 arguments, got ${expr.args.length}`, sp);
    return c.setType(expr, { tag: "bool" });
  }
  const types = expr.args.map(a => {
    if (a.kind !== "Ident" && a.kind !== "FieldAccess" && a.kind !== "IndexAccess") {
      c.error(`'_natLess': an operand must be a place (a variable, field or element)`, a.span);
    }
    const t = c.checkExpr(a);
    return t.tag === "ref" ? t.inner : t;
  });
  const [a, b] = types as [TypeKind, TypeKind];
  if (a.tag !== "int" && a.tag !== "float" && a.tag !== "string" && a.tag !== "bool" && a.tag !== "unknown") {
    c.error(`'_natLess': no natural order on ${c.show(a)}`, sp);
  } else if (!typeEq(unranged(a), unranged(b)) && b.tag !== "unknown" && a.tag !== "unknown") {
    c.error(`'_natLess': both operands must have the same type, got ${c.show(a)} and ${c.show(b)}`, sp);
  }
  return c.setType(expr, { tag: "bool" });
}

// `v.fold(init, f)` / `reduce`: std/vec's `fold<A>`, with A taken from the seed. A bare
// constant seed defaults to i64, so when the callback annotates its accumulator that
// annotation is the real type (`fold(0, (acc: i32, x: &i32) => acc + x)` over a narrower
// Vec) and the seed is retyped first, as the builtin did.
export function checkVecFold(c: TypeChecker, expr: MethodCall, element: TypeKind, sp: Span | undefined): TypeKind {
  if (expr.args.length !== 2) {
    c.error(`'${expr.method}' expects 2 arguments (initial value, callback)`, sp);
    for (const a of expr.args) c.checkExpr(a);
    return c.setType(expr, { tag: "unknown" });
  }
  let accType = c.checkExpr(expr.args[0]);
  const cb = expr.args[1];
  if (accType.tag === "int" && c.isConstIntExpr(expr.args[0]) && cb.kind === "Closure" && cb.params.length > 0) {
    // A closure param may have no annotation, so read the field rather than declaredType.
    const declared = cb.params[0].type;
    if (declared) {
      const annotated = c.resolve(declared);
      if (annotated.tag === "int" && !typeEq(annotated, accType)) {
        c.retypeConstInt(expr.args[0], annotated);
        accType = annotated;
      }
    }
  }
  if (accType.tag === "unknown") {
    c.checkExpr(cb);
    return c.setType(expr, accType);
  }
  const key = `Vec_${c.mangleTypeName(element)}$${expr.method}`;
  if (!c.genericMethods.has(key)) c.instantiateContainerImpl("Vec", [element], expr.method);
  const mangled = c.genericMethods.has(key) ? c.monomorphizeMethod(key, [accType], sp) : null;
  if (!mangled) {
    c.error(`Vec has no method '${expr.method}'`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  return c.dispatchMangledMethod(expr, mangled, sp, true);
}

// An `@sql` / `@sqlSchema` call. Folding happens here because only the checker can
// resolve a name to the constant it holds; checker-sql.ts checks the rest once the
// whole program (and so every migration) has been seen.
export function noteSqlCall(c: TypeChecker, callee: string, attrs: Attribute[], params: { name: string }[], args: Expr[], row: string | null, ret: TypeKind, sp: Span | undefined): void {
  const schema = sqlAttrOf(attrs, params, "sqlSchema");
  if (schema) {
    const v = schema.argsIndex === null ? undefined : args[schema.argsIndex];
    const vs = v ? c.sqlConstOf(v) : null;
    const version = vs !== null && /^\d+$/.test(vs) ? BigInt(vs) : null;
    const sqlArg = args[schema.sqlIndex];
    c.sql.noteSchema(callee, schema, args, version, sqlArg ? c.sqlConstOf(sqlArg) : null, sp);
    return;
  }
  const q = sqlAttrOf(attrs, params, "sql");
  const a = q ? args[q.sqlIndex] : undefined;
  if (!q || !a) return;
  let value: string | "unchecked" | "passthrough" | null = null;
  if (a.kind === "Call" && a.func === "uncheckedSql") value = "unchecked";
  else value = c.sqlConstOf(a) ?? (c.isOwnSqlParam(a) ? "passthrough" : null);
  // A fn handing back a Statement may be bound later (prepare once, rebind per row), so
  // an empty `[]` there is not a count to check; one that runs the query has no later.
  const prepares = /\bStatement\b/.test(c.show(ret));
  c.sql.noteQuery(callee, q, args, value, row, prepares, sp);
  c.flushSqlErrors();
}

// The enclosing fn's own `@sql` parameter, not a local that shadows it.
export function isOwnSqlParam(c: TypeChecker, a: Expr): boolean {
  const fn = c.currentFnDecl;
  if (a.kind !== "Ident" || !fn) return false;
  const own = sqlAttrOf(fn.attributes, fn.params, "sql");
  // A malformed @sql on the enclosing fn is already an error at its declaration;
  // rejecting every query inside it too would only repeat that.
  if (!own && fn.attributes?.some(x => x.name === "sql")) return true;
  const p = own ? fn.params[own.sqlIndex] : undefined;
  return !!p && p.name === a.name && c.lookup(a.name)?.span === p.span;
}

export function sqlConstOf(c: TypeChecker, e: Expr): string | null {
  return SqlChecker.constString(e, c.sqlResolver((name) => {
    const info = c.lookup(name);
    if (!info) return null;
    if (info.constStr !== undefined) return info.constStr;
    return info.isGlobal && !info.mutable ? c.globalConst(name) : null;
  }));
}

// A call to a template function: non-generic, every parameter a string, and a body that
// is one `return` of a foldable expression. Its parameters bind to the folded
// arguments; any other name resolves to a module constant only.
export function templateCall(c: TypeChecker, name: string, args: string[]): string | null {
  const f = c.fnDeclsByName.get(name);
  if (!f || f.isExtern || f.typeParams.length > 0 || f.params.length !== args.length || c.templateDepth > 16) return null;
  const ret = f.body?.length === 1 ? f.body[0] : undefined;
  if (!ret || ret.kind !== "Return" || !ret.value) return null;
  const bound = new Map(f.params.map((p, i) => [p.name, args[i]!] as const));
  c.templateDepth++;
  try {
    return SqlChecker.constString(ret.value, c.sqlResolver(n => bound.get(n) ?? c.globalConst(n)));
  } finally {
    c.templateDepth--;
  }
}

// A module constant's folded value. Names inside its initializer resolve to other
// globals only: the initializer runs at module scope, whatever locals the caller has.
export function globalConst(c: TypeChecker, name: string): string | null {
  if (c.globalConstCache.has(name)) return c.globalConstCache.get(name)!;
  const g = c.globalDeclsByName.get(name);
  c.globalConstCache.set(name, null); // a cycle folds to "not constant"
  const v = g && !g.mutable ? SqlChecker.constString(g.value, c.sqlResolver(n => c.globalConst(n))) : null;
  c.globalConstCache.set(name, v);
  return v;
}

// `arenaWith(a, h, (s: &T): T => { return s.clone() })` is `arenaGet(a, h)` written
// the long way. The closure form exists to BORROW the value without copying it; a
// body that immediately clones throws that borrow away, so the caller paid a closure,
// a callback and a nested match for the copy `get` would have handed them. Detected
// structurally — one param, one statement, and that statement is a bare
// `return <thatParam>.clone()` — so a closure doing anything else is untouched.
export function lintBorrowThatClones(c: TypeChecker, expr: Call): void {
  if (expr.func !== "arenaWith") return;
  const cb = expr.args[expr.args.length - 1];
  if (!cb || cb.kind !== "Closure" || cb.params.length !== 1 || cb.body.length !== 1) return;
  const only = cb.body[0]!;
  const ret = only.kind === "Return" ? only.value : only.kind === "ExprStmt" ? only.expr : null;
  if (!ret || ret.kind !== "MethodCall" || ret.method !== "clone" || ret.args.length !== 0) return;
  if (ret.object.kind !== "Ident" || ret.object.name !== cb.params[0]!.name) return;
  c.warn("borrow-that-clones",
    `this 'arenaWith' closure only clones its argument, which is what 'arenaGet' already does`,
    expr.span,
    "replace the whole call with 'arenaGet(arena, handle)' (or 'arena.get(handle)') — it returns the same Option<T>");
}

// std/string's intrinsics (STR_INTRINSICS). A `&mut s` argument is the place itself.
export function checkStrIntrinsic(c: TypeChecker, expr: Call): TypeKind {
  const sp = expr.span;
  const i64: TypeKind = { tag: "int", bits: 64, signed: true };
  const u8p: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
  const shape: Record<string, { args: ("str" | "i64" | "lit")[]; ret: TypeKind }> = {
    _strRangeCheck: { args: ["str", "i64", "i64"], ret: { tag: "void" } },
    _strReserve: { args: ["str", "i64"], ret: u8p },
    _strUnique: { args: ["str"], ret: { tag: "void" } },
    _strAlloc: { args: ["i64"], ret: u8p },
    _strPanic: { args: ["lit", "i64", "lit"], ret: { tag: "void" } },
  };
  const want = shape[expr.func]!;
  if (expr.args.length !== want.args.length) c.error(`'${expr.func}' expects ${want.args.length} argument(s)`, sp);
  expr.args.forEach((slot, i) => {
    let a = rewritten(c.rewrites, slot);
    if (a.kind === "UnaryOp" && a.op === "&mut") { const operand = a.operand; c.rewrites.set(a, operand); a = operand; }
    const k = want.args[i];
    if (k === "lit" && a.kind !== "StringLit") c.error(`'${expr.func}' argument ${i + 1} must be a string literal`, sp);
    c.checkExpr(a, k === "i64" ? i64 : null);
  });
  return c.setType(expr, want.ret);
}

export function checkCallExpr(chk: TypeChecker, expr: Call, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  chk.lintBorrowThatClones(expr);
  // `old(e)` is contract-only syntax, not a function: it names the value `e` held when
  // the function was entered. Recognised before the name lookup so a body-local
  // helper actually called `old` keeps working outside an `ensures`.
  if (expr.func === "old" && !chk.shadowedByUserFn("old") && chk.contractScope === "ensures") {
    if (expr.args.length !== 1) { chk.error(`old() takes exactly one argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const inner = chk.checkExpr(expr.args[0]!);
    // A snapshot is a by-value copy taken at entry. Copying a Vec/string/struct there
    // would either alias the caller's buffer or clone silently on every debug call, so
    // the pre-state is restricted to what fits in a register — which is also the only
    // fragment the SMT translator models.
    if (inner.tag !== "int" && inner.tag !== "float" && inner.tag !== "bool" && inner.tag !== "unknown") {
      chk.error(`old() takes a scalar (integer, float, or bool), got ${chk.show(inner)}`, sp,
        `snapshot a scalar projection instead, e.g. old(v.len)`);
    }
    return chk.setType(expr, inner);
  }
  if (expr.func === "old" && chk.contractScope !== "ensures" && !chk.shadowedByUserFn("old")) {
    chk.error(`old() may only appear in an 'ensures' clause`, sp,
      `there is no pre-state to name in a ${chk.contractScope === null ? "function body" : `'${chk.contractScope}' clause`}`);
    return chk.setType(expr, { tag: "unknown" });
  }
  if (MAP_INTRINSICS.has(expr.func) && isHashMapModule(sp?.file)) return chk.checkMapIntrinsic(expr);
  if (expr.func === "_vecCopyOut" && isVecModule(sp?.file)) return chk.checkMapCopyOut(expr);
  if ((expr.func === "_vecGrowBuf" || expr.func === "_vecNonNegative") && isVecModule(sp?.file)) {
    const i64: TypeKind = { tag: "int", bits: 64, signed: true };
    const grow = expr.func === "_vecGrowBuf";
    if (expr.args.length !== (grow ? 3 : 1)) chk.error(`'${expr.func}' expects ${grow ? 3 : 1} argument(s)`, sp);
    const types = expr.args.map((a, i) => chk.checkExpr(a, grow && i === 0 ? null : i64));
    if (grow && types[0]?.tag !== "ptr") chk.error(`'_vecGrowBuf': the buffer must be a raw pointer`, sp);
    return chk.setType(expr, grow ? (types[0] ?? { tag: "unknown" }) : i64);
  }
  if (STR_INTRINSICS.has(expr.func) && isStringModule(sp?.file)) return chk.checkStrIntrinsic(expr);
  if (expr.func === "_vecPanic" && isVecModule(sp?.file)) {
    if (expr.args.length !== 1 || expr.args[0]!.kind !== "StringLit") {
      chk.error(`'_vecPanic' expects one string literal`, sp);
    }
    return chk.setType(expr, { tag: "void" });
  }
  if (expr.func === "_natLess" && isVecModule(sp?.file)) return chk.checkNatLess(expr);
  if (expr.func === "sizeOf") {
    if (!expr.typeArgs || expr.typeArgs.length !== 1) { chk.error(`sizeOf requires exactly one type argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
    if (expr.args.length !== 0) { chk.error(`sizeOf takes no value arguments`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const resolved = chk.resolve(expr.typeArgs[0]);
    chk.sizeOfTypes.set(expr, resolved);
    return chk.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  if (expr.func === "offsetOf") {
    if (!expr.typeArgs || expr.typeArgs.length !== 1) { chk.error(`offsetOf requires exactly one type argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
    if (expr.args.length !== 1 || expr.args[0].kind !== "StringLit") { chk.error(`offsetOf requires one string argument (field name)`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const resolved = chk.resolve(expr.typeArgs[0]);
    if (resolved.tag !== "struct") { chk.error(`offsetOf requires a struct type`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const info = chk.structs.get(resolved.name);
    const fieldName = (expr.args[0] as import("./ast").StringLit).value;
    if (info && !info.fields.find(f => f.name === fieldName)) {
      chk.error(`struct '${resolved.name}' has no field '${fieldName}'`, sp);
    }
    chk.sizeOfTypes.set(expr, resolved);
    chk.offsetOfFields.set(expr, fieldName);
    return chk.setType(expr, { tag: "int", bits: 64, signed: true });
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
  if ((expr.func === "forget" && !chk.shadowedByUserFn("forget")) || (expr.func === "_vecForget" && isVecModule(sp?.file))) {
    if (expr.args.length !== 1) {
      chk.error(`'forget' takes exactly one argument`, sp);
      return chk.setType(expr, { tag: "void" });
    }
    const t = chk.checkExpr(expr.args[0]);
    if (chk.isCopyType(t) && !chk.instanceNodes.has(expr)) {
      chk.warn("useless-forget", `'forget' on a Copy value does nothing`, sp,
        `${chk.show(t)} owns no resource, so there is no drop to suppress`);
    }
    chk.pointerMoveKeepsHolders = true;
    chk.forgetting = true;
    try { chk.tryMove(expr.args[0]); } finally { chk.pointerMoveKeepsHolders = false; chk.forgetting = false; }
    return chk.setType(expr, { tag: "void" });
  }
  // `isNull(s.field)` — the ONE test a C function-pointer field admits besides being
  // called. C hands out null function pointers routinely (an optional callback in an
  // ops table), and the ordinary null idiom `p as i64 == 0` is not open here: casting
  // the field to an integer would be reading it as a value, which is what the
  // thin/fat split forbids. Deliberately narrow: it takes a `cfn` and nothing else, so
  // it does not become a second spelling for a raw-pointer null test.
  if (expr.func === "isNull" && !chk.shadowedByUserFn("isNull")) {
    if (expr.args.length !== 1) {
      chk.error(`'isNull' takes exactly one argument`, sp);
      return chk.setType(expr, { tag: "bool" });
    }
    const t = chk.checkExpr(expr.args[0]);
    if (t.tag === "cfn") {
      chk.strandedCFnReads.delete(expr.args[0]);
    } else if (t.tag !== "unknown") {
      chk.error(`'isNull' takes a C function-pointer field, got ${chk.show(t)}`, sp,
        `a raw pointer is tested with 'p as i64 == 0'`);
    }
    return chk.setType(expr, { tag: "bool" });
  }
  if (expr.func === "zeroed") {
    if (!expr.typeArgs || expr.typeArgs.length !== 1) { chk.error(`zeroed requires exactly one type argument`, sp); return chk.setType(expr, { tag: "unknown" }); }
    if (expr.args.length !== 0) { chk.error(`zeroed takes no value arguments`, sp); return chk.setType(expr, { tag: "unknown" }); }
    chk.requireUnsafe(`zeroed<T>() can only be used in unsafe blocks`, sp);
    const resolved = chk.resolve(expr.typeArgs[0]);
    chk.sizeOfTypes.set(expr, resolved);
    return chk.setType(expr, resolved);
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
      chk.error(`'${expr.func}' takes exactly two arguments (pointer, length)`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }
    const pt = chk.checkExpr(expr.args[0]);
    const lt = chk.checkExpr(expr.args[1]);
    if (pt.tag !== "ptr" && pt.tag !== "unknown") {
      chk.error(`'${expr.func}': expected a raw pointer, got ${chk.show(pt)}`, expr.args[0].span);
      return chk.setType(expr, { tag: "unknown" });
    }
    if (lt.tag !== "int" && lt.tag !== "unknown") {
      chk.error(`'${expr.func}': expected an integer length, got ${chk.show(lt)}`, expr.args[1].span);
    }
    chk.requireUnsafe(`'${expr.func}' can only be used in unsafe blocks`, sp);
    const element: TypeKind = pt.tag === "ptr" ? pt.inner : { tag: "unknown" };
    return chk.setType(expr, { tag: "ref", inner: { tag: "array", element, size: null }, mutable });
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
      chk.error(`'${expr.func}' takes exactly ${wantsLen ? "two arguments (pointer, length)" : "one argument (pointer)"}`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }
    const pt = chk.checkExpr(expr.args[0]);
    if (wantsLen) {
      const lt = chk.checkExpr(expr.args[1]);
      if (lt.tag !== "int" && lt.tag !== "unknown") {
        chk.error(`'${expr.func}': expected an integer length, got ${chk.show(lt)}`, expr.args[1].span);
      }
    }
    if (pt.tag !== "ptr" && pt.tag !== "unknown") {
      chk.error(`'${expr.func}': expected a raw pointer, got ${chk.show(pt)}`, expr.args[0].span);
      return chk.setType(expr, { tag: "unknown" });
    }
    chk.requireUnsafe(`'${expr.func}' can only be used in unsafe blocks`, sp);
    const inner: TypeKind = pt.tag === "ptr" ? pt.inner : { tag: "unknown" };
    return chk.setType(expr, wantsLen ? { tag: "vec", element: inner } : { tag: "heap", inner });
  }
  // `replace(place, value)` and `swap(a, b)`: memory intrinsics whose bodies cannot be
  // written in safe Milo (they move a value out of a place and refill it). Each place
  // is written as a `&mut` argument writes it, and the old occupant `replace` hands
  // back may be dropped at once, so the place takes every check a `&mut` argument or
  // an assignment takes (checkPlaceArgWrite). These once skipped all of them, which let
  // `replace(v, [])` inside `for x in v` free the element the loop was reading.
  // Gated on the name being otherwise unbound, so a user fn of the same name wins.
  if (expr.func === "replace" && !chk.shadowedByUserFn("replace")) {
    if (expr.args.length !== 2) { chk.error(`replace(place, value) takes exactly two arguments`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const place = chk.resolveAssignTarget(expr.args[0]);
    // `replace` hands the old occupant back, so the place is genuinely READ here even
    // when it is an owned local rather than a borrow.
    chk.markPlaceRead(expr.args[0]);
    if (!place.mutable) chk.error(`cannot replace through an immutable place`, expr.args[0].span, `declare it with 'var'`);
    else chk.checkPlaceArgWrite(expr.args[0], "replace", sp);
    // value moves in, old occupant moves out to the caller — the place stays valid,
    // so it is NOT invalidated here (only the by-value argument is consumed).
    const vt = chk.checkExpr(expr.args[1], place.type);
    if (vt.tag !== "unknown" && place.type.tag !== "unknown" && !typeEq(vt, place.type)) {
      chk.error(`replace: value type ${chk.show(vt)} does not match place type ${chk.show(place.type)}`, expr.args[1].span);
    }
    if (place.type.tag === "int") chk.enforceRangeInto(expr.args[1], vt, place.type, expr.args[1].span);
    // Codegen loads the old occupant BEFORE it evaluates `value`, so the place counts as
    // moved out by the first argument: a write of it while `value` is evaluated
    // (`replace(s, replace(s, x))`) leaves the call holding bits the place has already
    // handed to someone else, and both are dropped.
    const pp = chk.exclusivityPlace(expr.args[0]);
    if (pp) chk.reportLaterArgWrites([{ arg: 0, ...pp, moved: true }], expr.args, sp);
    chk.tryMove(expr.args[1]);
    return chk.setType(expr, place.type);
  }
  if (expr.func === "swap" && !chk.shadowedByUserFn("swap")) {
    if (expr.args.length !== 2) { chk.error(`swap(a, b) takes exactly two arguments`, sp); return chk.setType(expr, { tag: "void" }); }
    const a = chk.resolveAssignTarget(expr.args[0]);
    const b = chk.resolveAssignTarget(expr.args[1]);
    if (!a.mutable) chk.error(`cannot swap through an immutable place`, expr.args[0].span, `declare it with 'var'`);
    else chk.checkPlaceArgWrite(expr.args[0], "swap", sp);
    if (!b.mutable) chk.error(`cannot swap through an immutable place`, expr.args[1].span, `declare it with 'var'`);
    else chk.checkPlaceArgWrite(expr.args[1], "swap", sp);
    if (a.type.tag !== "unknown" && b.type.tag !== "unknown" && !typeEq(a.type, b.type)) {
      chk.error(`swap: operands have different types ${chk.show(a.type)} and ${chk.show(b.type)}`, sp);
    } else if (a.type.tag === "int" && b.type.tag === "int" && (a.type.min !== b.type.min || a.type.max !== b.type.max)) {
      // typeEq ignores ranges. Each side receives the other's value with no check in
      // between, so the ranges must match exactly, as two `&mut` borrows' must.
      chk.error(`swap: operands have different ranges ${chk.show(a.type)} and ${chk.show(b.type)}`, sp,
        `swap is not range-checked: move the value through a binding of the ranged type instead (that copy is checked)`);
    }
    // Both addresses are taken before either is read, so a later operand whose
    // evaluation writes the first one's buffer (`swap(v[0], w[grow()])`) leaves it dangling.
    const ap = chk.exclusivityPlace(expr.args[0]);
    if (ap) chk.reportLaterArgWrites([{ arg: 0, ...ap, moved: false }], expr.args, sp);
    return chk.setType(expr, { tag: "void" });
  }
  if (expr.func === "Heap") {
    if (expr.args.length !== 1) { chk.error(`Heap() expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const argType = chk.checkExpr(expr.args[0]);
    chk.tryMove(expr.args[0]);
    return chk.setType(expr, { tag: "heap", inner: argType });
  }
  if (expr.func === "embedFile") {
    // Bare `embedFile(...)` reads like an ordinary call but is compile-time-only:
    // the argument must be a literal and the file is inlined during compilation.
    // `@` is how Milo already marks compiler-level constructs (@cLayout, @link).
    if (!expr.sigil) {
      chk.warn("bare-embedfile",
        `'embedFile' is a compile-time builtin — write '@embedFile(...)'`,
        sp, `the '@' marks it as compiler magic, not a runtime call`, "embedFile".length);
    }
    if (expr.args.length !== 1) { chk.error(`embedFile() expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const arg = expr.args[0];
    if (arg.kind !== "StringLit") { chk.error(`embedFile() argument must be a string literal`, sp); return chk.setType(expr, { tag: "unknown" }); }
    return chk.setType(expr, { tag: "string" });
  }
  if (expr.func === "targetOs") {
    // Compile-time constant string naming the target OS ("darwin"/"linux"/
    // "windows"), resolved during lowering. Like @embedFile it is compiler
    // magic, not a runtime call, so it wants the `@` sigil; both arms of an
    // `if @targetOs() == "..."` type-check, only the dead one is folded away.
    if (!expr.sigil) {
      chk.warn("bare-targetos",
        `'targetOs' is a compile-time builtin — write '@targetOs()'`,
        sp, `the '@' marks it as compiler magic, not a runtime call`, "targetOs".length);
    }
    if (expr.args.length !== 0) { chk.error(`targetOs() takes no arguments, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "unknown" }); }
    return chk.setType(expr, { tag: "string" });
  }
  if (expr.func === "targetArch") {
    // The CPU half of @targetOs ("aarch64"/"x86_64"/"arm"/"wasm64"), for a C struct
    // whose layout differs by architecture on one OS: Linux's epoll_event is packed
    // on x86_64 and padded to 16 bytes on aarch64.
    if (!expr.sigil) {
      chk.warn("bare-targetos",
        `'targetArch' is a compile-time builtin — write '@targetArch()'`,
        sp, `the '@' marks it as compiler magic, not a runtime call`, "targetArch".length);
    }
    if (expr.args.length !== 0) { chk.error(`targetArch() takes no arguments, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "unknown" }); }
    return chk.setType(expr, { tag: "string" });
  }
  if (expr.func === "jsonStringify") {
    if (expr.args.length !== 1) { chk.error(`jsonStringify() expects 1 argument, got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "unknown" }); }
    const argType = chk.checkExpr(expr.args[0]);
    if (argType.tag !== "struct" && argType.tag !== "string" && argType.tag !== "bool" && argType.tag !== "int" && argType.tag !== "float") {
      chk.error(`jsonStringify: unsupported type '${chk.show(argType)}'`, sp);
    }
    // codegen only serializes scalar fields — anything else silently
    // produced invalid JSON before this guard existed
    if (argType.tag === "struct") {
      const si = chk.structs.get(argType.name);
      for (const f of si?.fields ?? []) {
        if (f.type.tag !== "string" && f.type.tag !== "bool" && f.type.tag !== "int" && f.type.tag !== "float") {
          chk.error(`jsonStringify: field '${f.name}' has unsupported type '${chk.show(f.type)}'`, sp,
            `only string, bool, integer, and float fields are supported — for nested or dynamic JSON use the std/json builders (jsonObj/jsonArr)`);
        }
      }
    }
    chk.autoBorrow(expr.args[0], { mutable: false });
    return chk.setType(expr, { tag: "string" });
  }
  // Generic function — infer type params from args, monomorphize
  const genericFn = chk.genericFns.get(expr.func);
  if (genericFn) {
    // The concrete signature does not exist yet; `&mut`-ness is in the declaration.
    chk.takeExplicitMutArgs(expr.args, expr.func, i => {
      const p = genericFn.decl.params[i];
      return p ? { name: p.name, mut: declaredType(p).isRefMut, show: () => formatMiloType(declaredType(p)) } : undefined;
    });
    const argTypes: TypeKind[] = [];
    // A by-value argument moves before the next one is checked (see the plain-call
    // loop). Inference needs every argument's type first, but a by-value parameter is
    // visible in the declaration already; a closure waits for the concrete signature,
    // since whether it becomes a `move` closure depends on it.
    const movedEarly = new Set<number>();
    expr.args.forEach((arg, i) => {
      const t = chk.checkExpr(arg);
      argTypes.push(t);
      const p = genericFn.decl.params[i];
      if (!p || t.tag === "ref" || t.tag === "fn" || t.tag === "unknown") return;
      const dt = declaredType(p);
      if (dt.isRef || dt.isRefMut) return;
      movedEarly.add(i);
      chk.tryMove(arg);
    });

    if (expr.args.length !== genericFn.decl.params.length) {
      chk.error(`function '${expr.func}' expects ${genericFn.decl.params.length} args, got ${expr.args.length}`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }

    const typeMap = new Map<string, TypeKind>();
    const literalInferred = new Set<string>();
    // Explicit turbofish type args (promiseAll<T>(x)) seed the map up front;
    // inference below fills any the caller left off. This is the only way to
    // pin a param that appears nested past what inference walks (e.g. T in
    // Vec<Promise<T>>).
    if (expr.typeArgs && expr.typeArgs.length > 0) {
      if (expr.typeArgs.length > genericFn.typeParams.length) {
        chk.error(`'${expr.func}' expects at most ${genericFn.typeParams.length} type argument(s), got ${expr.typeArgs.length}`, sp);
      }
      for (let i = 0; i < expr.typeArgs.length && i < genericFn.typeParams.length; i++) {
        typeMap.set(genericFn.typeParams[i], chk.resolve(expr.typeArgs[i]));
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
            chk.exprTypes.set(expr.args[i], existing);
            argTypes[i] = existing;
          } else if (literalInferred.has(paramTy.name) && existing.tag === directArg.tag) {
            typeMap.set(paramTy.name, directArg);
            literalInferred.delete(paramTy.name);
          } else {
            chk.error(`conflicting inference for type parameter '${paramTy.name}'`, sp);
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
          const info = chk.structs.get(argResolved.name);
          if (info?.baseName && info.typeArgs) {
            const gs = chk.genericStructs.get(info.baseName);
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
        chk.inferTypeParamsFromHint(paramTy, argResolved, genericFn.typeParams, typeMap);
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
          if (mt.typeArgs || mt.isArray || mt.isPtr) chk.inferTypeParamsFromHint(mt, t, genericFn.typeParams, typeMap);
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
      if (missing.length > 0 && expected) {
      chk.inferTypeParamsFromHint(genericFn.decl.retType, expected, genericFn.typeParams, typeMap);
      missing = genericFn.typeParams.filter(p => !typeMap.has(p));
    }
    if (missing.length > 0) {
      chk.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.func}`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }

    const typeArgs = genericFn.typeParams.map(p => must(typeMap, p, "type map"));
    chk.warnAdoptRawFields(expr.func, genericFn.decl.span, typeArgs, sp);
    const mangled = chk.monomorphizeFn(expr.func, typeArgs, sp);
    chk.rewrittenCalls.set(expr, mangled);

    const concreteSig = must(chk.functions, mangled, "functions");
    for (let i = 0; i < expr.args.length; i++) {
      const sigParamTy = i < concreteSig.params.length ? concreteSig.params[i].type : undefined;
      if (sigParamTy) {
        // Arguments were typed before the signature was known, so nothing has compared
        // them to it yet: with explicit type arguments (`f<T>(x)`) no inference step
        // ever notices a mismatch, and codegen died on it ("by-ref arg of another type").
        const argTy = chk.exprTypes.get(expr.args[i]) ?? { tag: "unknown" as const };
        // A bare numeric literal was typed with no context (so `100000` is i64); the
        // non-generic path types it against the parameter, so it takes the parameter's
        // type here too (codegen reads it). Its range is checked below.
        const a0 = expr.args[i];
        const lit = a0.kind === "UnaryOp" && a0.op === "-" ? a0.operand : a0;
        const litFits = (lit.kind === "IntLit" && sigParamTy.tag === "int") || (lit.kind === "FloatLit" && sigParamTy.tag === "float");
        if (litFits) { chk.setType(lit, sigParamTy); if (a0 !== lit) chk.setType(a0, sigParamTy); }
        else chk.matchCallArg(expr.args[i], argTy, sigParamTy, sp, argType =>
          chk.error(`argument ${i + 1} of '${expr.func}': expected ${chk.show(sigParamTy)}, got ${chk.show(argType)}`, expr.args[i].span, chk.optionUnwrapHint(sigParamTy, argType)));
      }
      if (sigParamTy?.tag === "ref") continue;
      // Same rule as the non-generic path: a literal for a `move` parameter (which a
      // bare `T` parameter instantiated with a closure type is) owns its captures.
      // Here only a capture mutated in place blocks the move; one merely read or
      // moved out is safe to move.
      chk.autoMoveClosureArg(expr.args[i], concreteSig.params[i]?.type, c => !!c.mutatedInClosure);
      if (!movedEarly.has(i) && !chk.lendsOwningClosure(expr.args[i], concreteSig.params[i]?.type)) chk.tryMove(expr.args[i]);
    }
    // check requires contracts at call site (generic fn)
    chk.checkCallSiteExclusivity(expr.args, sp);
    if (genericFn.decl) chk.checkCallSiteContracts(genericFn.decl, expr.args, sp);
    chk.requireUnsafeCall(genericFn.decl, expr.func, sp);

    return chk.setType(expr, must(chk.functions, mangled, "functions").ret);
  }

  // A callable in the local scope wins over a global of the same name. Globals used
  // to be consulted first, so a parameter could never shadow one — which meant a
  // user defining `fn handler` broke std/http's *internal* `handler(ctx)` call
  // against its own param, reporting a type error inside a file the user never
  // opened. Innermost binding wins, as everywhere else in the language.
  const localCallable = chk.lookup(expr.func);
  const sig = (localCallable && (localCallable.type.tag === "fn" || localCallable.type.tag === "cfn")) ? undefined : chk.functions.get(expr.func);
  if (!sig) {
    const varInfo = localCallable;
    if (varInfo && (varInfo.type.tag === "fn" || varInfo.type.tag === "cfn")) {
      varInfo.read = true;
      const fnType = varInfo.type;
      if (expr.args.length !== fnType.params.length) {
        chk.error(`closure expects ${fnType.params.length} args, got ${expr.args.length}`, sp);
      }
      chk.takeExplicitMutArgs(expr.args, expr.func, i => chk.typeParamAt(fnType.params[i], i));
      for (let i = 0; i < Math.min(expr.args.length, fnType.params.length); i++) {
        const paramType = fnType.params[i];
        chk.checkCallArg(expr.args[i], paramType, sp, argType =>
          chk.error(`closure argument ${i + 1}: expected ${chk.show(paramType)}, got ${chk.show(argType)}`, expr.args[i].span));
        // Moved before the next argument is checked: see the plain-call loop.
        if (chk.argIsBorrowed(expr.args[i], fnType.params[i])) continue;
        // Through a fn value a closure LITERAL is still made `move`, as before: which
        // target runs is unknown here. (An owning closure VALUE is lent above; the
        // target's parameter is plain by typeEq + sameFnOwnership.)
        chk.autoMoveClosureArg(expr.args[i], fnType.params[i], c => c.mutable, true);
        chk.tryMove(expr.args[i]);
      }
      chk.checkCallSiteExclusivity(expr.args, sp, fnType.tag !== "cfn");
      if (fnType.tag === "fn") chk.recordClosureCallWrites(expr, varInfo);
      if (fnType.tag === "cfn") {
        // Same rule as a C fn-pointer struct field: the pointer may be null, a dlsym
        // result cast to the wrong signature, or a freed function's address.
        chk.requireUnsafe(`calling a C function pointer requires 'unsafe' block`, sp);
        chk.cfnCalls.set(expr, fnType);
      } else chk.closureCalls.set(expr, fnType);
      return chk.setType(expr, fnType.ret);
    }
    // Promise(fn) → Promise<T>.run(fn) with T inferred from closure return type
    if (expr.func === "Promise" && chk.genericStructs.has("Promise") && expr.args.length === 1) {
      const argType = chk.checkExpr(expr.args[0], { tag: "fn", params: [], ret: { tag: "unknown" } });
      if (argType.tag !== "fn") {
        chk.error(`Promise() argument must be a function`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      const mangled = chk.monomorphizeStruct("Promise", [argType.ret]);
      while (chk._pendingImplFns.length > 0) {
        const fn = chk._pendingImplFns.shift()!;
        chk.checkFunction(fn);
      }
      const inherent = chk.inherentImpls.get(mangled);
      const runSig = inherent?.methods.get("run");
      if (!runSig) {
        chk.error(`'${mangled}' has no 'run' method`, sp);
        return chk.setType(expr, { tag: "unknown" });
      }
      chk.autoMoveClosureArg(expr.args[0], argType, c => c.mutable, true);
      chk.tryMove(expr.args[0]);
      chk.rewrittenCalls.set(expr, `${mangled}$run`);
      return chk.setType(expr, runSig.ret);
    }
    const unimported = chk.unimportedRenamed(expr.func, "values", sp);
    if (unimported) chk.diagnostics.push({ severity: "error", span: sp, ...unimported, code: "unimported" });
    else chk.error(`undefined function '${expr.func}'`, sp);
    return chk.setType(expr, { tag: "unknown" });
  }
  if (expr.func === "todo") {
    if (expr.args.length > 1) { chk.error(`todo() takes at most one argument (a message), got ${expr.args.length}`, sp); return chk.setType(expr, { tag: "void" }); }
    if (expr.args.length === 1) {
      const msgType = chk.checkExpr(expr.args[0]);
      if (msgType.tag !== "string" && msgType.tag !== "unknown") chk.error(`todo() message must be a string, got ${chk.show(msgType)}`, sp);
    }
    return chk.setType(expr, NEVER_TYPE);
  }
  if (expr.func === "assert") {
    if (expr.args.length < 1 || expr.args.length > 2) {
      chk.error(`assert() expects 1-2 arguments, got ${expr.args.length}`, sp);
      return chk.setType(expr, { tag: "void" });
    }
    const prevAssert = chk.inAssertCond;
    chk.inAssertCond = true;
    const condType = chk.checkExpr(expr.args[0]);
    chk.inAssertCond = prevAssert;
    if (condType.tag !== "bool" && condType.tag !== "unknown") {
      chk.error(`assert() condition must be bool, got ${chk.show(condType)}`, sp);
    }
    if (expr.args.length === 2) {
      const msgType = chk.checkExpr(expr.args[1]);
      if (msgType.tag !== "string" && msgType.tag !== "unknown") {
        chk.error(`assert() message must be a string, got ${chk.show(msgType)}`, sp);
      }
    }
    return chk.setType(expr, { tag: "void" });
  }
  if (expr.func === "max" || expr.func === "min") {
    if (expr.args.length !== 2) {
      chk.error(`${expr.func}() expects 2 arguments, got ${expr.args.length}`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }
    const aType = chk.checkExpr(expr.args[0]);
    const bType = chk.checkExpr(expr.args[1]);
    if (aType.tag !== "int" && aType.tag !== "float" && aType.tag !== "unknown") {
      chk.error(`${expr.func}() arguments must be numeric`, sp);
      return chk.setType(expr, { tag: "unknown" });
    }
    if (!typeEq(aType, bType) && bType.tag !== "unknown" && aType.tag !== "unknown") {
      chk.error(`${expr.func}() arguments must be the same type, got ${chk.show(aType)} and ${chk.show(bType)}`, sp);
    }
    return chk.setType(expr, aType.tag !== "unknown" ? aType : bType);
  }
  if (sig.variadic) {
    if (expr.args.length < sig.params.length) chk.error(`function '${expr.func}' expects at least ${sig.params.length} args, got ${expr.args.length}`, sp);
  } else if (expr.args.length !== sig.params.length) {
    chk.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`, sp);
  }
  chk.takeExplicitMutArgs(expr.args, expr.func, i => chk.sigParamAt(sig.params[i]));
  for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
    const paramType = sig.params[i].type;
    chk.checkCallArg(expr.args[i], paramType, sp, argType =>
      chk.error(`argument ${i + 1} of '${expr.func}': expected ${chk.show(paramType)}, got ${chk.show(argType)}`, expr.args[i].span, chk.optionUnwrapHint(paramType, argType)));
    // A by-value argument moves as it is evaluated, before the next one runs (codegen
    // empties the source right there), so a later argument that reads it is a use after
    // move. Moving only once every argument was checked let `insert(k, m.get(k))` read
    // `k` already emptied and miss the key with no diagnostic.
    if (chk.argIsBorrowed(expr.args[i], paramType)) continue;
    chk.autoMoveClosureArg(expr.args[i], paramType, c => c.mutable);
    chk.tryMove(expr.args[i]);
  }
  for (let i = sig.params.length; i < expr.args.length; i++) {
    const vt = chk.checkExpr(expr.args[i]);
    // a struct in the variadic (...) tail has no defined C ABI classification — reject
    if (sig.isExtern && vt.tag === "struct") {
      chk.error(`argument ${i + 1} of '${expr.func}': struct '${vt.name}' cannot be passed in a variadic position`, expr.args[i].span,
        `pass it by reference (&${vt.name}) instead`);
    }
  }
  chk.checkCallSiteExclusivity(expr.args, sp, !sig.isExtern);
  // `format` (what `$"..."` lowers to) reads each piece by reference when it builds the
  // string, after every piece was evaluated. A later piece that moves or frees an earlier
  // one's place (`$"{k} {consume(k)}"`) left it formatting an emptied string.
  if (sig.variadic && !sig.isExtern) {
    const uses: ArgUse[] = [];
    expr.args.forEach((slot, i) => {
      const a = rewritten(chk.rewrites, slot);
      const t = chk.exprTypes.get(a);
      const p = t && !chk.isCopyType(t) ? chk.exclusivityPlace(a) : null;
      if (p) uses.push({ arg: i, ...p, moved: false });
    });
    chk.reportLaterArgWrites(uses, expr.args, sp);
  }
  // safe extern call: no unsafe needed if all args are safe-passable and return is scalar/void.
  // Compute safety unconditionally (not just at depth 0) so an unsafe-requiring extern call
  // marks its enclosing block used, while a safe one leaves the block flagged unused.
  if (sig.isExtern) {
    // an extern struct is POD (whitelisted fields, no drop glue) — passing/returning
    // it by value is a plain bit copy with no provenance, so no unsafe is needed
    const retSafe = isScalar(sig.ret) || chk.isExternStructType(sig.ret);
    let argsSafe = retSafe;
    if (argsSafe) {
      for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
        const paramType = sig.params[i].type;
        const argType = chk.exprTypes.get(expr.args[i]);
        if (isScalar(paramType)) continue;
        if (paramType.tag === "ref") continue;
        // by-value extern struct arg with an exact type match — safe POD copy
        if (chk.isExternStructType(paramType) && argType && typeEq(paramType, argType)) continue;
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
    if (argsSafe) {
      const allScalar = isScalar(sig.ret) && sig.params.every(p => isScalar(p.type));
      chk.noteSafeExternCall(expr.func, chk.fnDecls.get(expr.func)?.attributes, allScalar, sp);
    }
    if (!argsSafe) {
      // teach the rule, not just the verdict — it's otherwise learned by trial-and-error
      const why = !retSafe
        ? `it returns ${chk.show(sig.ret)} (non-scalar)`
        : `an argument doesn't auto-coerce`;
      chk.requireUnsafe(`calling extern function '${expr.func}' requires an unsafe block`, sp,
        `extern calls are safe only when every arg is scalar, &T, fn, string/array→*T, or a by-value extern struct, AND the return is scalar/void/extern-struct — here ${why}`);
    }
  }
  if (sig.isExtern) chk.redirectForReplay(expr, sp);
  // check requires contracts at call site
  const fnDecl = chk.fnDecls.get(expr.func);
  if (fnDecl) chk.checkCallSiteContracts(fnDecl, expr.args, sp);
  if (fnDecl?.attributes) chk.noteSqlCall(expr.func, fnDecl.attributes, fnDecl.params, expr.args, null, sig.ret, sp);
  chk.requireUnsafeCall(fnDecl, expr.func, sp);
  if (sig && chk.rawPtrBuiltinNames.has(expr.func) && !chk.inStdFile(sp)) {
    chk.requireUnsafe(`calling '${expr.func}' requires an unsafe block`, sp,
      `'${expr.func}' reads or writes through the raw pointer it is given, which nothing checks`);
  }

  return chk.setType(expr, sig.ret);
}

export function coerceCopyCallbackTo(c: TypeChecker, slot: Expr, wantParams: TypeKind[]): void {
  const arg = rewritten(c.rewrites, slot);
  if (arg.kind === "Closure") {
    if (arg.params.length === wantParams.length) {
      const params = [...arg.params];
      let changed = false;
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        const inner = c.copyRefInner(wantParams[i]!);
        if (inner !== null && p.type && !p.type.isRef && !p.type.isRefMut && !p.type.isPtr && typeEq(c.resolve(p.type), inner)) {
          params[i] = { ...p, type: { ...p.type, isRef: true } };
          changed = true;
        }
      }
      if (changed) c.rewrites.set(arg, { ...arg, params });
    }
    return;
  }
  // ident-ok: asks whether the NAME is a top-level fn (not shadowed by a local), not a place
  const fnName = identNameOf(arg);
  if (fnName === null || c.lookup(fnName)) return;
  const sig = c.functions.get(fnName);
  if (!sig || sig.params.length !== wantParams.length) return;
  let adapted = false;
  const paramTypes: TypeKind[] = [];
  for (let i = 0; i < sig.params.length; i++) {
    const inner = c.copyRefInner(wantParams[i]!);
    if (inner !== null && typeEq(sig.params[i]!.type, inner)) { adapted = true; paramTypes.push(wantParams[i]!); }
    else paramTypes.push(sig.params[i]!.type);
  }
  if (!adapted) return;
  c.rewrites.set(arg, c.callbackThunk(fnName, paramTypes, sig.ret, arg.span));
}

// `(__cb0: T0, ...) => f(__cb0, ...)`.
export function callbackThunk(c: TypeChecker, fnName: string, paramTypes: TypeKind[], ret: TypeKind, span: Span | undefined): Expr {
  const args: Expr[] = [];
  const params: ClosureExpr["params"] = [];
  for (let i = 0; i < paramTypes.length; i++) {
    const name = `__cb${i}`;
    args.push({ kind: "Ident", name, span });
    params.push({ name, type: c.typeKindToMiloType(paramTypes[i]!), span });
  }
  const call: Expr = { kind: "Call", func: fnName, args, span };
  const stmt: Stmt = ret.tag === "void" ? { kind: "ExprStmt", expr: call, span } : { kind: "Return", value: call, span };
  let retType: MiloType | null = null;
  if (ret.tag !== "void") retType = c.typeKindToMiloType(ret);
  return { kind: "Closure", params, retType, body: [stmt], span };
}

export function checkCallArg(c: TypeChecker, arg: Expr, paramType: TypeKind, sp: Span | undefined, mismatch: (argType: TypeKind) => void): TypeKind {
  c.coerceCopyCallback(arg, paramType);
  const hint = paramType.tag === "ref" ? paramType.inner : paramType;
  return c.matchCallArg(arg, c.checkExpr(arg, hint), paramType, sp, mismatch);
}

// The argument-vs-parameter rules, for an argument whose type is already known.
// A generic call checks its arguments before the signature exists (inference needs
// every type first), so it applies these afterwards against the monomorphized one.
export function matchCallArg(c: TypeChecker, slot: Expr, argType: TypeKind, paramType: TypeKind, sp: Span | undefined, mismatch: (argType: TypeKind) => void): TypeKind {
  const arg = rewritten(c.rewrites, slot);
  // The `&mut` marker was keyed by the node the wrapper held; checking the argument
  // may have replaced it (static-on-variable to member), so the marker follows.
  if (arg !== slot && c.explicitMutArgs.has(slot)) c.explicitMutArgs.add(arg);
  if (paramType.tag === "ref") {
    c.enforceArgRange(arg, argType, paramType, arg.span);
    if (argType.tag === "ref" && typeEq(paramType.inner, argType.inner)) {
      // A `&[T]` slice is a %Vec *value*, not a bare pointer. To match the `ptr`
      // param ABI it must be passed by reference (its address materialized) —
      // otherwise a slice rvalue (`f(v[a..b])`, `f(c.view())`) is passed by value
      // and the callee reads a garbage length. Other refs are already pointers.
      if (paramType.inner.tag === "array" && paramType.inner.size === null) {
        c.setAutoBorrowChecked(arg, paramType.mutable, sp);
      }
      return argType;
    }
    c.setAutoBorrowChecked(arg, paramType.mutable, sp);
    // Vec<T> auto-coerces to &[T] / &mut [T] (same {ptr,len,cap} layout; callee
    // ignores cap). For &mut the setAutoBorrowChecked above already rejected an
    // immutable source and froze the Vec exclusively for the borrow's life.
    if (paramType.inner.tag === "array" && paramType.inner.size === null
        && argType.tag === "vec" && typeEq(paramType.inner.element, argType.element)) {
      return argType;
    }
    // A FIXED array satisfies a slice parameter too. Unlike a Vec this is not a
    // pass-through: `[N x T]` is an inline layout and the callee expects the
    // `{ptr,len,cap}` view, so the conversion is recorded here and materialised in
    // lowering. Without it `total(v)` worked and `total(a)` did not, for the same
    // function and the same element type.
    if (paramType.inner.tag === "array" && paramType.inner.size === null
        && argType.tag === "array" && argType.size !== null
        && typeEq(paramType.inner.element, argType.element)) {
      c.arraySliceArgs.add(arg);
      return argType;
    }
    if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown" && !c.tryInterfaceCoercion(arg, argType, paramType)) {
      mismatch(argType);
    }
    return argType;
  }
  if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
    // T auto-wraps to Option<T> (Some(value))
    const optInner = c.optionInnerType(paramType);
    const isOptionWrap = optInner !== null && typeEq(optInner, argType) && paramType.tag === "enum";
    // A flexible const-int binding adopts the param's int width (first use).
    const flexInfo = paramType.tag === "int" ? c.flexIntBinding(arg) : null;
    if (isOptionWrap) {
      c.autoWrappedOption.set(arg, paramType.name);
      c.enforceWrapRange(arg);
    } else if (flexInfo && c.resolveFlexInt(flexInfo, paramType, arg)) {
      // resolved
    } else if (!c.decaysToPtr(arg, paramType)) {
      if (!c.tryInterfaceCoercion(arg, argType, paramType)) mismatch(argType);
    }
  }
  // A ranged-int parameter (`p: i32(0..100)`) enforces its bound on the argument —
  // statically for a literal, else a runtime range check.
  if (paramType.tag === "int") c.enforceRangeInto(arg, argType, paramType, arg.span);
  return argType;
}

// A string auto-coerces to `*u8` and a `[T; N]` decays to `*T` for FFI and builtins. The
// argument is borrowed for the call, not moved.
export function decaysToPtr(c: TypeChecker, arg: Expr, paramType: TypeKind): boolean {
  const argType = c.exprTypes.get(arg);
  if (paramType.tag !== "ptr" || !argType) return false;
  if (argType.tag === "string") return paramType.inner.tag === "int" && paramType.inner.bits === 8;
  return argType.tag === "array" && typeEq(argType.element, paramType.inner);
}

// Arity and per-argument checking for a static / enum-variant call: auto-borrow for a
// `&T` param, the closure-capture rule that makes a non-mutating closure a move, and the
// moves themselves. Two call sites (the inherent-impl path and the static-method path)
// carried this verbatim and diverged only after it, so an auto-borrow fix in one would
// have silently missed the other. Returns paramOffset — the caller needs to know whether
// a `self` was stripped before it can line args up with the signature's contracts.
export function checkStaticCallArgs(chk: TypeChecker, sig: { params: { name: string; type: TypeKind }[] }, expr: any, sp: Span | undefined): number {
  const paramOffset = (sig.params.length > 0 && sig.params[0].name === "self") ? 1 : 0;
  const expectedParams = sig.params.slice(paramOffset);
  if (expr.args.length !== expectedParams.length) {
    chk.error(`'${expr.enumName}.${expr.variant}' expects ${expectedParams.length} args, got ${expr.args.length}`, sp);
  }
  chk.takeExplicitMutArgs(expr.args, `${expr.enumName}.${expr.variant}`, i => chk.sigParamAt(expectedParams[i]));
  for (let i = 0; i < Math.min(expr.args.length, expectedParams.length); i++) {
    const paramType = expectedParams[i].type;
    chk.checkCallArg(expr.args[i], paramType, sp, argType =>
      chk.error(`'${expr.variant}' argument ${i + 1}: expected ${chk.show(paramType)}, got ${chk.show(argType)}`, expr.args[i].span));
    chk.autoMoveClosureArg(expr.args[i], paramType, c => c.mutable);
    if (!chk.argIsBorrowed(expr.args[i], paramType)) chk.tryMove(expr.args[i]);
  }
  chk.checkCallSiteExclusivity(expr.args, sp);
  return paramOffset;
}

// `_mapHash(key, seed): i64` and `_mapKeyEq(a, b): bool`, std/hashmap only. The key
// arguments are places read in place (codegen loads them through their address), so
// a string key is hashed without a refcount round trip and nothing moves.
export function checkMapIntrinsic(c: TypeChecker, expr: Call): TypeKind {
  const sp = expr.span;
  if (expr.func === "_mapCopyOut") return c.checkMapCopyOut(expr);
  if (expr.func === "_mapSeed" || expr.func === "_mapAlloc") return c.checkMapTableIntrinsic(expr);
  const isHash = expr.func === "_mapHash";
  const result: TypeKind = isHash ? { tag: "int", bits: 64, signed: true } : { tag: "bool" };
  if (expr.args.length !== 2) {
    c.error(`'${expr.func}' expects 2 arguments, got ${expr.args.length}`, sp);
    return c.setType(expr, result);
  }
  const keyArgs = isHash ? [expr.args[0]] : expr.args;
  const keyTypes = keyArgs.map(a => {
    if (a.kind !== "Ident" && a.kind !== "FieldAccess" && a.kind !== "IndexAccess") {
      c.error(`'${expr.func}': a key argument must be a place (a variable, field or element)`, a.span);
    }
    const t = c.checkExpr(a);
    return t.tag === "ref" ? t.inner : t;
  });
  keyTypes.forEach((t, i) => c.validateHashableKey(t, keyArgs[i].span));
  if (!isHash && !typeEq(keyTypes[0], keyTypes[1]) && keyTypes[0].tag !== "unknown" && keyTypes[1].tag !== "unknown") {
    c.error(`'_mapKeyEq': both keys must have the same type, got ${c.show(keyTypes[0])} and ${c.show(keyTypes[1])}`, sp);
  }
  if (isHash) {
    const seedType = c.checkExpr(expr.args[1], { tag: "int", bits: 64, signed: true });
    if (seedType.tag !== "int" && seedType.tag !== "unknown") {
      c.error(`'_mapHash': the seed must be an i64, got ${c.show(seedType)}`, expr.args[1].span);
    }
  }
  return c.setType(expr, result);
}

// `_mapCopyOut(place): T`, std/hashmap only: a copy of a stored value, made the way the
// builtin get always made it (structural, never a user Clone), so
// a moved get returns the same value.
//
// A resource has no such copy, but that is refused at the user's call (the copy-out
// rule in the hashmap method chain), not here: instantiating `impl HashMap` checks
// every method body, so refusing here broke `HashMap<i64, Res>` programs that never
// call get. `@copyOut` would withhold get for a Drop KEY too, which the builtin allowed.
// `_mapSeed(): i64` (codegen's HASH_SEED_FN, so record/replay still fixes the seed
// sequence) and `_mapAlloc(count, size): *u8` (count * size zeroed bytes through
// the overflow- and null-checked allocation the builtin table used).
export function checkMapTableIntrinsic(c: TypeChecker, expr: Call): TypeKind {
  const i64: TypeKind = { tag: "int", bits: 64, signed: true };
  const isSeed = expr.func === "_mapSeed";
  const want = isSeed ? 0 : 2;
  if (expr.args.length !== want) {
    c.error(`'${expr.func}' expects ${want} argument(s), got ${expr.args.length}`, expr.span);
  }
  for (const a of expr.args) {
    const t = c.checkExpr(a, i64);
    if (t.tag !== "int" && t.tag !== "unknown") c.error(`'${expr.func}': expected an i64, got ${c.show(t)}`, a.span);
  }
  return c.setType(expr, isSeed ? i64 : { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } });
}

// `HashMap.new()` / `HashMap.withCapacity(n)` call std/hashmap's mapNew / mapWithCapacity,
// instantiated for the <K, V> the context gave the literal. Recorded as a static call,
// so lowering emits the call and the whole-program passes see a real callee.
export function bindMapConstructor(c: TypeChecker, expr: EnumLit, t: TypeKind): void {
  // An unhashable key was already refused where the type was written; instantiating
  // would repeat that error once per std/hashmap line that hashes a key.
  if (t.tag !== "hashmap" || !c.isHashable(t.key)) return;
  const base = expr.variant === "new" ? "mapNew" : "mapWithCapacity";
  // The resolver module-scopes a private std name (`hashmap$mapNew`), so find it by origin.
  const generic = [...c.genericFns.entries()].find(([name, g]) =>
    (name === base || name.endsWith(`$${base}`)) && isHashMapModule(g.decl.sourceFile));
  if (!generic) {
    c.error(`'HashMap.${expr.variant}' needs std/hashmap, which the prelude imports`, expr.span);
    return;
  }
  c.staticCalls.set(expr, c.monomorphizeFn(generic[0], [t.key, t.value], expr.span));
}

// `Vec.withCapacity(n)` / `Vec.filled(n, x)` call std/vec's vecWithCapacity / vecFilled
// for the element the context gave, recorded as a static call as bindMapConstructor does.
// Vec.new stays builtin: it is the constant {null, 0, 0}, and a call would turn a global
// initializer into a lazy one for nothing.
export function bindVecConstructor(c: TypeChecker, expr: EnumLit, t: TypeKind): void {
  if (t.tag !== "vec" || t.element.tag === "unknown") return;
  const base = expr.variant === "withCapacity" ? "vecWithCapacity" : "vecFilled";
  const generic = [...c.genericFns.entries()].find(([name, g]) =>
    (name === base || name.endsWith(`$${base}`)) && isVecModule(g.decl.sourceFile));
  if (!generic) {
    c.error(`'Vec.${expr.variant}' needs std/vec, which the prelude imports`, expr.span);
    return;
  }
  c.staticCalls.set(expr, c.monomorphizeFn(generic[0], [t.element], expr.span));
}

export function checkMapCopyOut(c: TypeChecker, expr: Call): TypeKind {
  const sp = expr.span;
  if (expr.args.length !== 1) {
    c.error(`'${expr.func}' expects 1 argument, got ${expr.args.length}`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  const a = expr.args[0];
  if (a.kind !== "Ident" && a.kind !== "FieldAccess" && a.kind !== "IndexAccess") {
    c.error(`'${expr.func}': the argument must be a place (a variable, field or element)`, a.span);
  }
  const t = c.checkExpr(a);
  return c.setType(expr, t.tag === "ref" ? t.inner : t);
}

export function autoMoveClosureArg(chk: TypeChecker, slot: Expr, param: TypeKind | undefined, keepsWriteBack: (c: CaptureInfo) => boolean, always = false): void {
  const arg = rewritten(chk.rewrites, slot);
  if (arg.kind !== "Closure" || chk.isMoveClosure(arg) || param?.tag !== "fn") return;
  if (!always && !param.owning) return;
  const caps = chk.closureCaptures.get(arg) ?? [];
  if (caps.some(keepsWriteBack)) return;
  chk.moveClosures.add(arg);
  chk.errorOnRefCaptures(arg, caps, "this closure is passed to a 'move' parameter, so it owns its captures");
}

// Does a callback's DECLARED signature match what the combinator will actually pass it?
//
// Every combinator built a `cbHint` and handed it to `checkExpr`, and at best
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
export function checkCallbackSig(c: TypeChecker, actual: TypeKind, want: TypeKind, method: string, sp?: Span): void {
  if (actual.tag !== "fn" || want.tag !== "fn") return; // reported by the caller's own check
  if (actual.params.length !== want.params.length) {
    c.error(`'${method}' callback takes ${actual.params.length} parameter(s), but is called with ${want.params.length}`, sp);
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
      if (c.isCopyType(got)) continue;
      c.error(
        `'${method}' callback parameter ${i + 1} takes ${c.show(got)} by value, but ${method} passes ${c.show(expected)}`,
        sp,
        `${c.show(got)} owns heap, so taking it by value would move it out of the container being iterated. Declare the parameter as '${c.show(expected)}'.`,
      );
      return;
    }
    c.error(`'${method}' callback parameter ${i + 1} is declared ${c.show(got)}, but ${method} passes ${c.show(expected)}`, sp);
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
    c.error(
      `'${method}' callback returns ${c.show(actual.ret)}, but ${method} expects ${c.show(want.ret)}`,
      sp,
    );
  }
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
export function staticCallOnVariable(c: TypeChecker, expr: any, expected: TypeKind | null): TypeKind | null {
  const next = c.rewriteStaticToMember(expr);
  if (next === null) return null;
  return c.checkExpr(next, expected);
}

// The rewrite half of staticCallOnVariable, without the re-check: mutates the
// EnumLit node into a FieldAccess/MethodCall on the same-named variable and
// reports whether it did. Assignment targets need the rewrite but must not
// re-enter checkExpr — that would type the node as an rvalue read (and move it).
export function rewriteStaticToMember(c: TypeChecker, expr: any): Expr | null {
  const info = c.lookup(expr.enumName);
  if (!info) return null;
  const obj = { kind: "Ident", name: expr.enumName, span: expr.span } as unknown as Expr;
  let ty = info.type;
  if (ty.tag === "ref") ty = ty.inner;
  // `.len` is the one built-in field: `NAMES.len` on a module-level array reads it, not a method.
  const isField = (ty.tag === "struct" && !!c.structs.get(ty.name)?.fields.some(f => f.name === expr.variant))
    || (expr.variant === "len" && (ty.tag === "array" || ty.tag === "vec" || ty.tag === "string" || ty.tag === "hashmap"));
  const args: Expr[] = expr.args ?? [];
  const next: Expr = isField && args.length === 0
    ? { kind: "FieldAccess", object: obj, field: expr.variant, span: expr.span }
    : { kind: "MethodCall", object: obj, method: expr.variant, args, span: expr.span };
  c.rewrites.set(expr as Expr, next);
  return next;
}

export function validateHashableKey(c: TypeChecker, t: TypeKind, span?: Span) {
  if (c.isHashable(t)) return;
  if (t.tag !== "unknown") {
    c.error(`type '${c.show(t)}' is not hashable — keys must be integer, bool, string, or a struct of hashable fields`, span);
  }
}

// Substitute resolved placeholders through `t`; returns `t` itself when nothing changed.
export function resolveInfer(c: TypeChecker, t: TypeKind): TypeKind {
  if (t.tag === "unknown") {
    if (t.inferId === undefined) return t;
    const r = c.inferred[t.inferId];
    return r === undefined ? t : c.resolveInfer(r);
  }
  if (t.tag === "ptr" || t.tag === "ref" || t.tag === "heap") {
    const inner = c.resolveInfer(t.inner);
    return inner === t.inner ? t : { ...t, inner };
  }
  if (t.tag === "vec" || t.tag === "array") {
    const element = c.resolveInfer(t.element);
    return element === t.element ? t : { ...t, element };
  }
  if (t.tag === "hashmap") {
    const key = c.resolveInfer(t.key), value = c.resolveInfer(t.value);
    return key === t.key && value === t.value ? t : { ...t, key, value };
  }
  if (t.tag === "fn" || t.tag === "cfn") {
    const params: TypeKind[] = [];
    let changed = false;
    for (const p of t.params) {
      const q = c.resolveInfer(p);
      if (q !== p) changed = true;
      params.push(q);
    }
    const ret = c.resolveInfer(t.ret);
    return !changed && ret === t.ret ? t : { ...t, params, ret };
  }
  return t;
}

// Every holder of a type that contained the placeholder sees the resolution: bindings,
// closure captures, globals and the per-expression types.
export function zonkStored(chk: TypeChecker): void {
  for (const scope of chk.scopes) for (const info of scope.values()) info.type = chk.resolveInfer(info.type);
  for (const frame of chk.closureFrames) for (const c of frame.captures.values()) c.type = chk.resolveInfer(c.type);
  for (const [k, v] of chk._globalTypes) chk._globalTypes.set(k, chk.resolveInfer(v));
  for (const [k, v] of chk.exprTypes) chk.exprTypes.set(k, chk.resolveInfer(v));
}

// checkCallArg for a method call's argument `i`, keeping the method diagnostics' wording.
// `special` gets the first look at a mismatch and returns true when it handled it.
export function checkMethodArg(c: TypeChecker, expr: MethodCall, i: number, paramType: TypeKind, sp: Span | undefined, special?: (argType: TypeKind) => boolean): TypeKind {
  const arg = expr.args[i]!;
  return c.checkCallArg(arg, paramType, sp, argType => {
    if (special?.(argType)) return;
    const bare = paramType.tag === "ref" ? paramType.inner : paramType;
    // A callback mismatch names the parameter at fault ("'each' callback parameter 1
    // takes string by value, but each passes &string"), as the builtin combinators said.
    if (bare.tag === "fn" && argType.tag === "fn") {
      const before = c.diagnostics.length;
      c.checkCallbackSig(argType, bare, expr.method, arg.span);
      if (c.diagnostics.length > before) return;
    }
    c.error(`'${expr.method}' argument ${i + 1}: expected ${c.show(bare)}, got ${c.show(argType)}`, arg.span);
  });
}

// `doc.at("data.user.orgs[0].name")`, or `.at(path)` on a `doc[...]` chain: a path step,
// rewritten to `doc.idxPath(start, path)` so the result is a chain like `doc[k]`'s and
// ends in the same reads (`.str()`, `.i64()`, `.items()`, ...). Only a string argument:
// `doc.at(i)` with an integer stays Json.at, the owned-element accessor. Null when this
// is not a path step.
export function rewriteJsonPathStep(c: TypeChecker, expr: MethodCall, objType: TypeKind, chainRoot: Expr | undefined, expected: TypeKind | null): TypeKind | null {
  if (expr.method !== "at" || expr.args.length !== 1) return null;
  const bare = objType.tag === "ref" ? objType.inner : objType;
  if (bare.tag !== "struct") return null;
  const onChain = !!chainRoot && bare.name === "JsonCur";
  const onDoc = !chainRoot && bare.name === "Json";
  if (!onChain && !onDoc) return null;
  const argT = c.checkExpr(expr.args[0]);
  const argBare = argT.tag === "ref" ? argT.inner : argT;
  if (argBare.tag !== "string") {
    if (onDoc) return null;
    if (argBare.tag !== "unknown") c.error(`a Json path step takes a string path ("a.b[0].c"), got ${c.show(argT)}`, expr.span, `index a position with 'doc[...][i]'`);
    return c.setType(expr, { tag: "unknown" });
  }
  if (onDoc && !c.isJsonRootPlace(expr.object)) {
    c.error(`a Json path is read from a Json held in a variable: bind it first ('let doc = ...' then 'doc.at(...)')`, expr.span);
    return c.setType(expr, { tag: "unknown" });
  }
  const root = onChain ? chainRoot! : expr.object;
  const start: Expr = onChain ? expr.object
    : { kind: "MethodCall", object: structuredClone(root), method: "idxRoot", args: [], span: expr.span } as Expr;
  const next: MethodCall = { ...expr, object: structuredClone(root), method: "idxPath", args: [start, expr.args[0]] };
  c.rewrites.set(expr, next);
  c.jsonChains.set(next, root);
  return c.checkMethodCallExprInner(next, expected);
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
export function errorIfCopyBind(c: TypeChecker, recv: Expr, method: string, sp?: Span): void {
  const cbindRoot = c.rootNameOf(recv);
  if (cbindRoot === null) return;
  const info = c.lookup(cbindRoot);
  if (!info?.copyBind) return;
  c.error(
    `'${method}' takes '&mut self', but '${cbindRoot}' is a copy of the matched payload — the write would be discarded`,
    sp,
    `a pattern binding of a Copy type is a snapshot, not a reference into the enum. Match on a reference, or rebuild the enum from the method's result.`);
}

export function resolveOptionForValue(c: TypeChecker, valueType: TypeKind, span?: Span): TypeKind {
  const ge = c.genericEnums.get("Option");
  if (!ge) {
    c.error(`HashMap.get requires 'enum Option<T> { Some(T), None }' to be defined`, span);
    return { tag: "unknown" };
  }
  const mangled = c.monomorphizeEnum("Option", [valueType]);
  return { tag: "enum", name: mangled };
}

// extract T from Option-like (Some(T)/None) or Result-like (Ok(T)/Err(E)) enums
export function unwrapableInner(c: TypeChecker, t: TypeKind): TypeKind | null {
  if (t.tag !== "enum") return null;
  const info = c.enums.get(t.name);
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
export function unwrapableErr(c: TypeChecker, t: TypeKind): TypeKind | null {
  if (t.tag !== "enum") return null;
  const info = c.enums.get(t.name);
  if (!info) return null;
  const ok = info.variants.get("Ok");
  const err = info.variants.get("Err");
  if (ok && err && ok.fields.length === 1 && err.fields.length >= 1) {
    return err.fields[0];
  }
  return null;
}
