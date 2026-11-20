// Method resolution, container impl instantiation, trait/interface satisfaction, Send/Sync.
import type { TypeChecker } from "./checker";
import { declaredType } from "./ast";
import type { Expr, Function, MiloType, Span, MethodCall } from "./ast";
import type { FnSig } from "./checker";
import { sameFnOwnership, typeEq, typeName } from "./types";
import type { TypeKind } from "./types";
import { identNameOf, rewritten } from "./checker-util";
import { must } from "./must";

// Check a call against an already-resolved concrete method and record the symbol codegen
// must emit. Shared by the two paths that resolve a method by instantiating it rather
// than by looking it up: a generic method (`fn map<R>`) and a blanket container impl
// (`impl Trait for Vec<T>`). The ordinary path is not routed through here because it
// carries the `json` auto-stringify special case, which neither of these can reach.
// A `&mut self` method on a receiver that is not writable: the same rule a `&mut`
// argument gets (unwritableMutTarget), applied in every method-dispatch path. Without it
// `let s = S { n: 1 }; s.bump()` compiled and wrote through the `let`, and so did
// `let m = HashMap.new(); m.upsert(...)`. A `Heap<T>` receiver writes the box's pointee,
// not the binding, so it stays legal, as do temporaries (the argument rule allows them).
// Returns true when it reported, so the caller can stop before borrowing.
export function refuseImmutableReceiver(c: TypeChecker, expr: MethodCall, sp: Span | undefined): boolean {
  const t = c.exprTypes.get(expr.object);
  if (t?.tag === "heap") return false;
  // A by-value pattern binding owns its payload (moved out, or a copy of a temporary),
  // so its write is real; the copy of a place's payload is errorIfCopyBind's case.
  // tests/fixtures/matchTempBindMutate.milo is the shape (`Ok(child) => child.close()`).
  const root = c.rootNameOf(expr.object);
  const rootInfo = root === null ? undefined : c.lookup(root);
  if (rootInfo?.patternBound && rootInfo.type.tag !== "ref") return false;
  const bad = c.unwritableMutTarget(expr.object);
  if (!bad) return false;
  const recv = t?.tag === "ref" ? t.inner : t;
  const container = recv?.tag === "hashmap" ? "HashMap" : recv?.tag === "vec" ? "Vec" : recv?.tag === "string" ? "string" : null;
  const name = c.describeExpr(expr.object);
  const fix = rootInfo?.byValueParam
    ? `'${root}' is a by-value parameter, and parameters are immutable: move it into a 'var' first ('var out = ${root}') and use that`
    : `declare with 'var' to make it mutable`;
  if (bad.shared) {
    c.error(`cannot call '${expr.method}' on '${name}', a shared '&' reference: it takes '&mut self'`, sp,
      `take '&mut ${c.show(bad.shared)}' in this function's signature if it needs to mutate`);
  } else if (container) {
    // The builtin container methods' wordings ("cannot remove from immutable HashMap",
    // "cannot retain on an immutable Vec"), which tests pin.
    c.error(expr.method === "remove" && container === "HashMap"
      ? `cannot remove from immutable HashMap`
      : expr.method === "clear" && container === "HashMap"
      ? `cannot clear an immutable HashMap`
      : `cannot ${expr.method} on an immutable ${container}`, sp, fix);
  } else {
    c.error(`cannot call '${expr.method}' on immutable '${name}': it takes '&mut self'`, sp, fix);
  }
  return true;
}

// A local fn value taking a Copy element by value (`let f = (x: i64) => ...; v.map(f)`),
// passed where std/vec calls with `&T`: rewritten in place to the thunk
// `(p0: &T, ...) => f(p0, ...)`, which borrows `f` only for the call (the std callback
// parameter does not escape). The builtin map and sorts loaded the element for such a
// callback; coerceCopyCallback covers literals and named fns, not locals.
export function thunkByValueFnValue(c: TypeChecker, slot: Expr, element: TypeKind, arity: number): void {
  const arg = rewritten(c.rewrites, slot);
  // ident-ok: the rewrite emits a call by NAME (`f(p0)`), so only a fn value bound to a name qualifies
  const fnName = identNameOf(arg);
  if (fnName === null) return;
  const t = c.lookup(fnName)?.type;
  if (t?.tag !== "fn" || t.params.length !== arity || !c.isCopyType(element)) return;
  if (!t.params.every(p => typeEq(p, element))) return;
  const elemRef: TypeKind = { tag: "ref", inner: element, mutable: false };
  const paramTypes: TypeKind[] = [];
  for (const _p of t.params) paramTypes.push(elemRef);
  c.rewrites.set(arg, c.callbackThunk(fnName, paramTypes, t.ret, arg.span));
}

// After the adaptations above, a callback std/vec would call with `&T` that still takes
// an element by value (only a shape neither adapter recognises): refused, rather than
// handed a pointer where it reads a value. True when it reported.
export function refuseByValueCallback(c: TypeChecker, cb: TypeKind & { tag: "fn" }, elemRef: TypeKind, method: string, sp: Span | undefined): boolean {
  const i = cb.params.findIndex(p => p.tag !== "ref" && p.tag !== "unknown");
  if (i < 0) return false;
  c.error(`'${method}' callback parameter ${i + 1} is declared ${c.show(cb.params[i]!)}, but ${method} passes ${c.show(elemRef)}`, sp,
    `declare the parameter as '${c.show(elemRef)}'`);
  return true;
}

// A Vec method whose call the builtin rules above have already checked (arity, argument
// types, the mutable receiver, with the builtin wordings tests pin) and whose body is
// std/vec code: record the instantiated method for lowering, as HashMap insert does.
// Not dispatchMangledMethod: those rules accept any int index, which lowering widens, and
// map's callback is checked once, there, to learn its type argument. `typeArgs` are a
// generic method's own (`map<U>`). An element still unknown after an error (or an
// uninferred `Vec.new()`), or the reference push refused, has no instance to bind.
export function bindStdVecMethod(c: TypeChecker, expr: MethodCall, element: TypeKind, method: string, ret: TypeKind, opts: { mutable?: boolean; typeArgs?: TypeKind[] } = {}): TypeKind {
  if (element.tag === "unknown" || element.tag === "ref") return c.setType(expr, ret);
  let mangled: string | null;
  if (opts.typeArgs) {
    const key = `Vec_${c.mangleTypeName(element)}$${method}`;
    if (!c.genericMethods.has(key)) c.instantiateContainerImpl("Vec", [element], method);
    mangled = c.genericMethods.has(key) ? c.monomorphizeMethod(key, opts.typeArgs, expr.span) : null;
  } else {
    mangled = c.instantiateContainerImpl("Vec", [element], method)?.mangled ?? null;
  }
  if (!mangled) {
    c.error(`Vec has no method '${method}'`, expr.span);
    return c.setType(expr, ret);
  }
  c.autoBorrow(expr.object, { mutable: opts.mutable ?? true });
  c.resolvedMethods.set(expr, mangled);
  return c.setType(expr, ret);
}

// bindStdVecMethod for a string or bool: the builtin rules checked the call (with the
// wordings tests pin, and any int where std takes i64, which lowering widens); the body
// is std/string's `impl string` / `impl bool`. `refArgs`: the arguments std takes as
// `&string`. A by-value receiver (bool's) is a Copy and needs no borrow.
export function bindStdStringMethod(c: TypeChecker, expr: MethodCall, method: string, ret: TypeKind, refArgs: number[] = [], mutable = false): TypeKind {
  return c.bindStdPrimMethod(expr, "string", method, ret, refArgs, mutable);
}

export function bindStdPrimMethod(c: TypeChecker, expr: MethodCall, recv: string, method: string, ret: TypeKind, refArgs: number[] = [], mutable = false): TypeKind {
  const resolved = c.resolveMethod(recv, method);
  if (!resolved) {
    c.error(`${recv} has no method '${method}'`, expr.span);
    return c.setType(expr, ret);
  }
  if (resolved.sig.params[0]?.type.tag === "ref") c.autoBorrow(expr.object, { mutable });
  for (const i of refArgs) if (expr.args[i]) c.setAutoBorrowChecked(expr.args[i]!, false);
  c.resolvedMethods.set(expr, resolved.mangled);
  return c.setType(expr, ret);
}

// `borrowsForCallback`: the receiver is frozen while the arguments are checked, and the
// call-site exclusivity rule is not applied. That is the builtin callback methods' rule
// (borrowDuringCallback): the callback may read the receiver but not insert into or
// remove from it, where exclusivity would refuse any capture of it at all.
export function dispatchMangledMethod(c: TypeChecker, expr: MethodCall, mangled: string, sp?: Span, borrowsForCallback = false): TypeKind {
  const sig = must(c.functions, mangled, "instantiated method");
  const selfParam = sig.params[0];
  if (selfParam?.type.tag === "ref") {
    if (selfParam.type.mutable) {
      if (c.refuseImmutableReceiver(expr, sp)) {
        for (const a of expr.args) c.checkExpr(a);
        return c.setType(expr, sig.ret);
      }
      if (!c.collectionGuarded.has(expr)) c.markWritten(expr.object);
      c.errorIfCopyBind(expr.object, expr.method, sp);
    }
    c.autoBorrow(expr.object, { mutable: selfParam.type.mutable });
  } else {
    c.tryMove(expr.object);
  }
  if (expr.args.length !== sig.params.length - 1) {
    c.error(`'${expr.method}' expects ${sig.params.length - 1} argument(s), got ${expr.args.length}`, sp);
  }
  c.takeExplicitMutArgs(expr.args, expr.method, i => c.sigParamAt(sig.params[i + 1]));
  for (let i = 0; i < expr.args.length; i++) {
    const expected = sig.params[i + 1];
    if (!expected) break;
    c.checkMethodArg(expr, i, expected.type, sp);
    if (!c.argIsBorrowed(expr.args[i]!, expected.type)) c.tryMove(expr.args[i]!);
  }
  if (!borrowsForCallback) c.checkCallSiteExclusivity(selfParam ? [expr.object, ...expr.args] : expr.args, sp);
  c.resolvedMethods.set(expr, mangled);
  c.requireUnsafeMethod(mangled, expr.method, sp);
  return c.setType(expr, sig.ret);
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
export function instantiateContainerImpl(c: TypeChecker, container: string, args: TypeKind[], method: string): { mangled: string; sig: FnSig } | null {
  const templates = c.genericImpls.get(container);
  if (!templates || templates.length === 0) return null;
  const concreteName = `${container}_${args.map(a => c.mangleTypeName(a)).join("_")}`;
  const already = c.resolveMethod(concreteName, method);
  if (already) return already;
  // Withheld at an earlier instantiation of this container; registering the impl
  // again would not bring it back.
  if (c.withheldMethods.has(`${concreteName}.${method}`)) return null;
  if (!templates.some(t => t.impl.methods.some(m => m.name === method))) return null;

  const argsMilo = args.map(a => c.typeKindToMiloType(a));
  for (const [ti, { impl: gi, program: prog }] of templates.entries()) {
    const names = gi.typeParams.map(t => t.name);
    // An impl whose parameter count does not match the container's is not about this
    // container shape at all (`impl T for HashMap<K>` on a two-parameter map), and
    // substituting anyway would bind the wrong positions silently.
    if (names.length !== args.length) continue;
    // An inherent method is instantiated only when called, like a C++ template member:
    // a method comparing elements with `==` cannot be checked for a `Vec<Vec<i64>>`, and
    // instantiating every method for every element type would refuse any use of such
    // a Vec. A trait impl's method set is the trait's, so it is instantiated whole, once.
    let wanted: (m: Function) => boolean;
    if (gi.traitName) {
      const key = `${concreteName}#${ti}`;
      if (c.containerTraitImplsDone.has(key)) continue;
      c.containerTraitImplsDone.add(key);
      wanted = () => true;
    } else {
      if (!gi.methods.some(m => m.name === method)) continue;
      wanted = m => m.name === method;
    }
    // `Self` keeps its real container type: `self: &Self` on a `Vec<T>` impl must stay
    // a Vec, not become the mangled struct name, or the body cannot index it. Every
    // position gets the same treatment, so `other: &Self` is the Vec too.
    const selfMilo: MiloType = { name: container, typeArgs: argsMilo, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    c.containerSelfType.set(concreteName, selfMilo);
    const concreteImpl: import("./ast").ImplDecl = {
      kind: "ImplDecl",
      traitName: gi.traitName,
      typeName: concreteName,
      typeParams: [],
      methods: gi.methods.filter(m => wanted(m) && !c.methodWithheld(m, concreteName, names, args)).map(m => ({
        ...m,
        ...(m.attributes && { attributes: m.attributes.filter(a => a.name !== "copyOut" && a.name !== "ordered") }),
        params: m.params.map(p => ({
          name: p.name,
          // The receiver keeps its declared mode: forcing `&Self` here made every
          // `self: &mut Self` method on a container impl unable to mutate the container.
          type: p.name === "self"
            ? { name: container, typeArgs: argsMilo, isPtr: false, isRef: !declaredType(p).isRefMut, isRefMut: !!declaredType(p).isRefMut, isArray: false, arraySize: null }
            : c.substituteSelfInMiloType(c.substituteParamType(declaredType(p), names, args), container, argsMilo),
        })),
        retType: c.substituteSelfInMiloType(c.substituteMiloType(m.retType, names, args), container, argsMilo),
        body: c.substituteBody(m.body, names, args),
      })),
      span: gi.span,
    };
    c.registerImpl(concreteImpl, prog, c._pendingImplFns);
  }
  return c.resolveMethod(concreteName, method);
}

// A container impl method `@copyOut`/`@ordered` withheld from this instantiation:
// say why, instead of the bare "has no method" a reader would take for a typo.
export function reportWithheldContainerMethod(c: TypeChecker, container: string, args: TypeKind[], objType: TypeKind, method: string, sp?: Span): boolean {
  const why = c.withheldMethods.get(`${container}_${args.map(a => c.mangleTypeName(a)).join("_")}.${method}`);
  if (!why) return false;
  c.error(`'${method}' is not available on '${c.show(objType)}': ${why.reason}`, sp, why.hint);
  return true;
}

export function resolveMethod(c: TypeChecker, objTypeName: string, methodName: string): { mangled: string; sig: FnSig } | null {
  // inherent first
  const inherent = c.inherentImpls.get(objTypeName);
  if (inherent) {
    const sig = inherent.methods.get(methodName);
    if (sig) return { mangled: `${objTypeName}$${methodName}`, sig };
  }
  // then trait impls
  const impls = c.traitImpls.get(objTypeName);
  if (impls) {
    const matches: { mangled: string; sig: FnSig }[] = [];
    for (const impl of impls) {
      const sig = impl.methods.get(methodName);
      if (sig) matches.push({ mangled: `${objTypeName}$${impl.traitName}$${methodName}`, sig });
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      c.error(`ambiguous method '${methodName}' on '${objTypeName}' — implemented by multiple traits`);
      return matches[0];
    }
  }
  return null;
}

export function typeImplementsTrait(c: TypeChecker, tName: string, traitName: string): boolean {
  const impls = c.traitImpls.get(tName);
  if (!impls) return false;
  if (impls.some(i => i.traitName === traitName)) return true;
  // check supertraits transitively
  const trait = c.traits.get(traitName);
  if (trait) {
    for (const sup of trait.supertraits) {
      if (!c.typeImplementsTrait(tName, sup)) return false;
    }
  }
  return false;
}

// structural interface satisfaction: type has all methods with matching signatures
export function typeSatisfiesInterface(c: TypeChecker, tName: string, ifaceName: string): boolean {
  const iface = c.interfaces.get(ifaceName);
  if (!iface) return false;
  for (const [methodName, ifaceMethod] of iface.methods) {
    const resolved = c.resolveMethod(tName, methodName);
    if (!resolved) return false;
    // check param count matches (skip self — both sides have it)
    if (resolved.sig.params.length !== ifaceMethod.params.length) return false;
    // check non-self param types match
    for (let i = 1; i < ifaceMethod.params.length; i++) {
      if (!typeEq(resolved.sig.params[i].type, ifaceMethod.params[i].type) || !sameFnOwnership(resolved.sig.params[i].type, ifaceMethod.params[i].type)) return false;
    }
    // check return type matches
    if (!typeEq(resolved.sig.ret, ifaceMethod.ret)) return false;
  }
  return true;
}

// try implicit coercion from concrete type to interface type
// returns true if coercion is valid and was recorded, or if it was rejected with its own
// "does not satisfy" error (so the caller does not add a type-mismatch cascade on top)
export function tryInterfaceCoercion(c: TypeChecker, expr: Expr, sourceType: TypeKind, targetType: TypeKind): boolean {
  // &T → &Interface
  if (targetType.tag === "ref" && targetType.inner.tag === "interface") {
    const ifaceName = targetType.inner.name;
    const srcInner = sourceType.tag === "ref" ? sourceType.inner : sourceType;
    const srcName = typeName(srcInner);
    if (srcInner.tag === "struct" || srcInner.tag === "enum") {
      if (c.typeSatisfiesInterface(srcName, ifaceName)) {
        c.interfaceCoercions.set(expr, { fromType: srcName, ifaceName });
        return true;
      }
      c.error(`type '${srcName}' does not satisfy interface '${ifaceName}'`, expr.span);
      return true;
    }
    return false;
  }
  // Heap<T> → Heap<Interface>
  if (targetType.tag === "heap" && targetType.inner.tag === "interface") {
    const ifaceName = targetType.inner.name;
    if (sourceType.tag === "heap") {
      const srcName = typeName(sourceType.inner);
      if (sourceType.inner.tag === "struct" || sourceType.inner.tag === "enum") {
        if (c.typeSatisfiesInterface(srcName, ifaceName)) {
          c.interfaceCoercions.set(expr, { fromType: srcName, ifaceName });
          return true;
        }
        c.error(`type '${srcName}' does not satisfy interface '${ifaceName}'`, expr.span);
        return true;
      }
    }
    return false;
  }
  return false;
}

// Send = safe to transfer ownership across threads
export function isSend(c: TypeChecker, ty: TypeKind): boolean {
  switch (ty.tag) {
    case "int": case "float": case "bool": case "void": case "string":
      return true;
    case "ptr":
      return false;
    case "ref":
      return ty.mutable ? c.isSend(ty.inner) : c.isSync(ty.inner);
    case "heap":
      return c.isSend(ty.inner);
    case "vec":
      return c.isSend(ty.element);
    case "hashmap":
      return c.isSend(ty.key) && c.isSend(ty.value);
    case "array":
      return c.isSend(ty.element);
    case "fn":
      return true;
    case "interface":
      return false;
    case "struct": {
      if (c.sendTypes.has(ty.name)) return true;
      const info = c.structs.get(ty.name);
      // A marker on Wrapper<T> audits the wrapper's raw representation, not T.
      // Keep the ordinary Send requirement for every instantiated argument.
      if (info?.baseName && c.sendTypes.has(info.baseName)) {
        return (info.typeArgs ?? []).every(arg => c.isSend(arg));
      }
      if (!info) return true;
      return info.fields.every(f => c.isSend(f.type));
    }
    case "enum": {
      const info = c.enums.get(ty.name);
      if (!info) return true;
      for (const [, v] of info.variants) {
        if (!v.fields.every(f => c.isSend(f))) return false;
      }
      return true;
    }
    default: return true;
  }
}

export function whyNotSend(c: TypeChecker, ty: TypeKind): string {
  if (ty.tag === "ptr") return `raw pointer '${c.show(ty)}' is not Send`;
  if (ty.tag === "struct") {
    const info = c.structs.get(ty.name);
    if (info) {
      for (const f of info.fields) {
        if (!c.isSend(f.type)) return `field '${f.name}' of type '${c.show(f.type)}' is not Send — a manual override requires 'unsafe impl Send for ${ty.name} {}' and an audited invariant`;
      }
    }
  }
  return `type '${c.show(ty)}' is not Send`;
}

// Sync = safe to share via &T across threads
export function isSync(c: TypeChecker, ty: TypeKind): boolean {
  switch (ty.tag) {
    case "int": case "float": case "bool": case "void": case "string":
      return true;
    case "ptr":
      return false;
    case "ref":
      return c.isSync(ty.inner);
    case "heap":
      return c.isSync(ty.inner);
    case "vec":
      return c.isSync(ty.element);
    case "hashmap":
      return c.isSync(ty.key) && c.isSync(ty.value);
    case "array":
      return c.isSync(ty.element);
    case "fn":
      return true;
    case "interface":
      return false;
    case "struct": {
      if (c.syncTypes.has(ty.name)) return true;
      const info = c.structs.get(ty.name);
      if (info?.baseName && c.syncTypes.has(info.baseName)) {
        return (info.typeArgs ?? []).every(arg => c.isSync(arg));
      }
      if (!info) return true;
      return info.fields.every(f => c.isSync(f.type));
    }
    case "enum": {
      const info = c.enums.get(ty.name);
      if (!info) return true;
      for (const [, v] of info.variants) {
        if (!v.fields.every(f => c.isSync(f))) return false;
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
export function isViewReturn(ret: TypeKind): boolean {
  if (ret.tag !== "ref") return false;
  return (ret.inner.tag === "array" && ret.inner.size === null) || ret.inner.tag === "string";
}

// `let s = b.view()` borrows b's storage exactly as `let s = b.data[0..n]` does: it needs a binding to borrow from, and
// codegen reads the borrowedExprs fact. The conflicts with the view are src/borrow-flow.ts's.
export function freezeViewSource(c: TypeChecker, obj: Expr, sp?: Span) {
  const rootName = c.rootNameOf(obj);
  if (rootName === null) {
    // No binding to freeze: `makeRing().items()` views storage owned by a temporary.
    // That only survives today because temporaries are never dropped (they leak) —
    // it becomes a use-after-free the moment they get drop glue.
    c.error(`cannot take a slice of a temporary`, sp,
      `the '&[T]' would outlive the value it points into: bind the receiver first ('let r = makeRing()') and take the slice from that`);
    return;
  }
  c.borrowedExprs.add(obj);
}
