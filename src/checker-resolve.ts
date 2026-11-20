// Type resolution, aliases, generics, monomorphization and type-argument inference.
import { TypeChecker } from "./checker";
import { declaredType, simpleType } from "./ast";
import type { Attribute, Expr, Function, MiloType, Span, Stmt, StructDecl, EnumLit, MethodCall } from "./ast";
import { CONDITIONAL_CLONE_BASES } from "./checker-derive";
import type { StructInfo } from "./checker";
import { isNumeric, typeEq, typeFromAst, typeName } from "./types";
import type { TypeKind } from "./types";
import { must } from "./must";
import { mustUseOf, rawPointerField, rawPointerVariant, substituteAliasType, wrapTypeArg } from "./checker-util";
import { walkExprs } from "./safety";

// A reference nested inside a container outlives the borrow it came from: the
// container survives the scope that owns the borrowed value, and reading it
// later is a use-after-free. Struct fields have always been rejected; this is
// the same rule for `Vec<&T>`, `HashMap<_, &T>`, `[&T; N]` and `Heap<&T>`,
// which used to slip through and produce garbage at runtime.
export function nestedRef(c: TypeChecker, t: TypeKind, seen = new Set<string>()): boolean {
  switch (t.tag) {
    case "vec": return t.element.tag === "ref" || c.nestedRef(t.element, seen);
    case "array": return t.element.tag === "ref" || c.nestedRef(t.element, seen);
    case "heap": return t.inner.tag === "ref" || c.nestedRef(t.inner, seen);
    case "hashmap":
      return t.key.tag === "ref" || t.value.tag === "ref" || c.nestedRef(t.key, seen) || c.nestedRef(t.value, seen);
    // An enum payload is storage like any other: `Option<&[T]>` let a view outlive the
    // freeze taken for it, which is the same escape `Vec<&T>` had. `seen` guards the
    // recursive enums (a list variant holding its own type) this walk would loop on.
    case "enum": {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      const info = c.enums.get(t.name);
      if (!info) return false;
      for (const v of info.variants.values()) {
        for (const f of v.fields) if (f.tag === "ref" || c.nestedRef(f, seen)) return true;
      }
      return false;
    }
    default: return false;
  }
}

// `sp` is where the type was WRITTEN or implied (a `let` annotation, a call whose
// signature mentions it); a MiloType carries no span of its own, so an instantiation
// that a generic rejects (`@copyOnly`, `void`) has no other way to point at the user.
export function resolve(c: TypeChecker, ty: MiloType, sp?: Span): TypeKind {
  if (ty.isFn && ty.fnParams && ty.fnRet) {
    const tag = ty.isCFn ? "cfn" as const : "fn" as const;
    const fnTy = { tag, params: ty.fnParams.map(p => c.resolve(p, sp)), ret: c.resolve(ty.fnRet, sp) };
    // `move (T) => R` — carry the ownership through. This is a SECOND place fn types are
    // built (typeFromAst is the other); a declared parameter comes through here, so
    // losing the flag here meant a `move` parameter typed as non-owning: it was not Copy
    // at the call site but the callee never dropped it, so every capture leaked anyway.
    return (ty as { isMoveFn?: boolean }).isMoveFn ? { ...fnTy, owning: true } : fnTy;
  }
  if (c.unknownTypeNames.has(ty.name)) return { tag: "unknown" };
  // type alias resolution
  const alias = c.typeAliases.get(ty.name);
  const aliasParams = c.aliasTypeParams.get(ty.name);
  if (alias && aliasParams && !ty.isArray) {
    // A generic alias is a TEMPLATE: substitute the arguments into its body and resolve
    // the result. There is no instantiation to register and no monomorphization to run,
    // because the alias names no type of its own — `Handler<i64>` IS `(i64) => Result<i64, Error>`
    // to everything downstream, which is what makes it free.
    const args = ty.typeArgs ?? [];
    if (args.length !== aliasParams.length) {
      c.error(`type alias '${ty.name}' takes ${aliasParams.length} type argument(s), got ${args.length}`, undefined,
        args.length === 0
          ? `write '${ty.name}<${aliasParams.map(() => "…").join(", ")}>' — a generic alias has no meaning without its arguments`
          : `it declares '${ty.name}<${aliasParams.join(", ")}>'`);
      return { tag: "unknown" };
    }
    if (c.expandingAliases.has(ty.name)) {
      c.error(`type alias '${ty.name}' is cyclic`, undefined,
        `it expands to itself, so there is no type it names — break the cycle, or use a struct or enum, which may refer to itself through 'Heap' or 'Vec'`);
      return { tag: "unknown" };
    }
    const subst = new Map<string, MiloType>();
    aliasParams.forEach((p, i) => subst.set(p, args[i]));
    c.expandingAliases.add(ty.name);
    let inner: TypeKind;
    try {
      inner = c.resolve(substituteAliasType(alias, subst));
    } finally {
      c.expandingAliases.delete(ty.name);
    }
    const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
    if (depth > 0) {
      let result = inner;
      for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
      return result;
    }
    if (ty.isNullableRef) return { tag: "ptr", inner };
    if (ty.isRef) return { tag: "ref", inner, mutable: false };
    if (ty.isRefMut) return { tag: "ref", inner, mutable: true };
    return inner;
  }
  if (alias && !ty.isArray && !ty.typeArgs?.length) {
    if (c.expandingAliases.has(ty.name)) {
      c.error(`type alias '${ty.name}' is cyclic`, undefined,
        `it expands to itself, so there is no type it names — break the cycle, or use a struct or enum, which may refer to itself through 'Heap' or 'Vec'`);
      return { tag: "unknown" };
    }
    // The ptr/ref flags belong to the *use site* (`&Board`), not to the alias:
    // expand the alias body, then re-apply the wrapper the use site asked for.
    c.expandingAliases.add(ty.name);
    let inner: TypeKind;
    try {
      inner = c.resolve(alias);
    } finally {
      c.expandingAliases.delete(ty.name);
    }
    const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
    if (depth > 0) {
      let result = inner;
      for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
      return result;
    }
    if (ty.isNullableRef) return { tag: "ptr", inner };
    if (ty.isRef) return { tag: "ref", inner, mutable: false };
    if (ty.isRefMut) return { tag: "ref", inner, mutable: true };
    return inner;
  }
  const typeArgs = ty.typeArgs ?? [];
  if (typeArgs.length > 0) {
    const resolvedArgs = typeArgs.map(a => c.resolve(a, sp));
    // A user generic bails out: `Promise<void>` would otherwise instantiate Channel,
    // Result and Option with the same void and report the one mistake four times.
    // A builtin container has no such body, so it keeps its resolved type rather than
    // degrading to `<unknown>` and cascading "cannot infer element type" behind it.
    if (c.rejectVoidTypeArgs(ty.name, resolvedArgs)
        && (c.genericStructs.has(ty.name) || c.genericEnums.has(ty.name))) {
      return { tag: "unknown" };
    }
    let result: TypeKind;
    if (ty.name === "Heap") {
      if (resolvedArgs.length !== 1) { c.error(`'Heap' expects 1 type argument, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
      result = { tag: "heap", inner: resolvedArgs[0] };
    } else if (ty.name === "Vec") {
      if (resolvedArgs.length !== 1) { c.error(`'Vec' expects 1 type argument, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
      result = { tag: "vec", element: resolvedArgs[0] };
    } else if (ty.name === "HashMap") {
      if (resolvedArgs.length !== 2) { c.error(`'HashMap' expects 2 type arguments, got ${resolvedArgs.length}`); return { tag: "unknown" }; }
      c.validateHashableKey(resolvedArgs[0]);
      result = { tag: "hashmap", key: resolvedArgs[0], value: resolvedArgs[1] };
    } else {
      const ge = c.genericEnums.get(ty.name);
      if (ge) {
        let args = resolvedArgs;
        if (args.length < ge.typeParams.length && ge.typeParamDefaults) {
          // fill remaining type args from defaults
          args = [...args];
          for (let i = args.length; i < ge.typeParams.length; i++) {
            const def = ge.typeParamDefaults[i];
            if (!def) {
              c.error(`'${ty.name}' requires type argument for '${ge.typeParams[i]}'`);
              return { tag: "unknown" };
            }
            args.push(def);
          }
        } else if (args.length !== ge.typeParams.length) {
          c.error(`'${ty.name}' expects ${ge.typeParams.length} type args, got ${args.length}`);
          return { tag: "unknown" };
        }
        result = { tag: "enum", name: c.monomorphizeEnum(ty.name, args, sp) };
      } else {
        const gs = c.genericStructs.get(ty.name);
        if (gs) {
          if (resolvedArgs.length !== gs.typeParams.length) {
            c.error(`'${ty.name}' expects ${gs.typeParams.length} type args, got ${resolvedArgs.length}`);
            return { tag: "unknown" };
          }
          result = { tag: "struct", name: c.monomorphizeStruct(ty.name, resolvedArgs, sp) };
        } else {
          c.error(`'${ty.name}' is not a generic type`);
          return { tag: "unknown" };
        }
      }
    }
    // `[Vec<i64>; 2]` arrives here because of its type ARGUMENTS, and this branch used
    // to return the element type and drop the array entirely: the annotation resolved to
    // a plain `Vec<i64>`, so `for v in a` yielded an i64 and the reported error was
    // "cannot iterate over type 'i64'" against a program that never wrote one. Wrap here,
    // inside the ref/ptr wrappers, which belong outside the array.
    if (ty.isArray) result = { tag: "array", element: result, size: ty.arraySize };
    // `*P<i64>` came through here without its pointer: the cast `p as *P<i64>` then
    // resolved to a plain `P<i64>` and failed as a cast to a struct.
    const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
    for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
    if (depth > 0) return result;
    if (ty.isNullableRef) return { tag: "ptr", inner: result };
    if (ty.isRef) return { tag: "ref", inner: result, mutable: false };
    if (ty.isRefMut) return { tag: "ref", inner: result, mutable: true };
    return result;
  }
  // check if name refers to an interface
  if (c.interfaces.has(ty.name)) {
    let result: TypeKind = { tag: "interface", name: ty.name };
    if (ty.isRef) return { tag: "ref", inner: result, mutable: false };
    if (ty.isRefMut) return { tag: "ref", inner: result, mutable: true };
    return result;
  }
  const base = typeFromAst(ty);
  if (base.tag === "struct" && c.enums.has(base.name)) {
    return { tag: "enum", name: base.name };
  }
  // `&Enum` / `*Enum`: typeFromAst tags the named inner as a struct by default;
  // correct it to enum so e.g. a `&Value` param's pointee is a real enum.
  if (base.tag === "ref" && base.inner.tag === "struct" && c.enums.has(base.inner.name)) {
    return { tag: "ref", inner: { tag: "enum", name: base.inner.name }, mutable: base.mutable };
  }
  if (base.tag === "ptr" && base.inner.tag === "struct" && c.enums.has(base.inner.name)) {
    return { tag: "ptr", inner: { tag: "enum", name: base.inner.name } };
  }
  // opaque extern types can only appear behind *T
  const opaqueCheck = base.tag === "struct" ? base.name
    : (base.tag === "ref" && base.inner.tag === "struct") ? base.inner.name
    : (base.tag === "array" && base.element.tag === "struct") ? base.element.name
    : null;
  if (opaqueCheck && c.structs.get(opaqueCheck)?.isOpaque) {
    c.error(`extern type '${opaqueCheck}' can only be used as a pointer (*${opaqueCheck})`);
  }
  return base;
}

export function mangleTypeName(c: TypeChecker, t: TypeKind): string {
  const rangeSym = (n: number) => n < 0 ? `n${-n}` : `${n}`;
  switch (t.tag) {
    case "cfn": return `cfn${t.params.length}`;
    // A ranged int keeps its range in the name: `Option<i32(0..9)>` is a different
    // instance from `Option<i32>` (its layout can use the excluded values as a niche),
    // and the instances being distinct is what stops an `Option<i32>` holding an
    // out-of-range value from being passed off as the ranged one.
    case "int": return `${t.signed ? "i" : "u"}${t.bits}${t.min !== undefined && t.max !== undefined ? `r${rangeSym(t.min)}_${rangeSym(t.max)}` : ""}`;
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "string": return "string";
    case "struct": return t.name;
    case "enum": return t.name;
    case "ptr": return `ptr_${c.mangleTypeName(t.inner)}`;
    case "heap": return `Heap_${c.mangleTypeName(t.inner)}`;
    case "vec": return `Vec_${c.mangleTypeName(t.element)}`;
    case "hashmap": return `HashMap_${c.mangleTypeName(t.key)}_${c.mangleTypeName(t.value)}`;
    case "array": return `arr_${c.mangleTypeName(t.element)}_${t.size}`;
    case "ref": return `ref_${c.mangleTypeName(t.inner)}`;
    case "fn": return `fn_${t.params.map(p => c.mangleTypeName(p)).join("_")}_ret_${c.mangleTypeName(t.ret)}`;
    case "interface": return `iface_${t.name}`;
    case "never": return "never";
    case "unknown": return "unknown";
  }
}

export function monomorphizeEnum(c: TypeChecker, baseName: string, typeArgs: TypeKind[], sp?: Span): string {
  c.rejectVoidTypeArgs(baseName, typeArgs, sp);
  const mangled = `${baseName}_${typeArgs.map(a => c.mangleTypeName(a)).join("_")}`;
  if (c.enums.has(mangled)) return mangled;

  const generic = must(c.genericEnums, baseName, "generic enums");
  const typeMap = new Map<string, TypeKind>();
  generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

  for (let i = 0; i < generic.decl.typeParams.length; i++) {
    const tp = generic.decl.typeParams[i];
    for (const bound of tp.bounds) {
      c._pendingStructBounds.push({ struct: baseName, mangled, param: tp.name, concrete: typeArgs[i], bound });
    }
  }

  const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
  for (const [vName, vInfo] of generic.variants) {
    variants.set(vName, {
      tag: vInfo.tag,
      fields: vInfo.fields.map(f => c.substituteTypeKind(f, typeMap)),
    });
  }
  const decl: import("./ast").EnumDecl = {
    kind: "EnumDecl",
    name: mangled,
    typeParams: [],
    variants: generic.decl.variants.map(v => ({
      name: v.name,
      fields: v.fields.map(f => c.substituteMiloType(f, generic.typeParams, typeArgs)),
    })),
  };
  const pointerVariant = generic.decl.attributes?.some(a => a.name === "copy") ? undefined : rawPointerVariant(variants);
  c.enums.set(mangled, { baseName, typeArgs, variants, decl, ...(pointerVariant && { pointerVariant }) });
  c.monomorphizedDecls.push(decl);
  // An instance that appears after the derive pass (`let o: Option<P>` inside a body)
  // missed the fixpoint, so it gets its conditional Clone here; one that appears
  // before it is a fixpoint candidate, where a payload still pending can be honoured.
  if (c._derivesProcessed && CONDITIONAL_CLONE_BASES.has(baseName)) {
    c.deriveCloneForBuiltinInstance(mangled);
  }
  return mangled;
}

export function deriveCloneForBuiltinInstance(c: TypeChecker, mangled: string): void {
  if (c.typeImplementsTrait(mangled, "Clone")) return;
  const info = c.enums.get(mangled);
  if (!info?.decl) return;
  // A Copy instance (`Option<i32>`) already has `.clone()` as the identity.
  if (c.isCopyType({ tag: "enum", name: mangled })) return;
  // Not `top`: an Option's generic clone calls its payload's clone(), which a Heap lacks.
  if (c.derive.enumCloneBlocker(mangled, c.cloneDerived, false)) return;
  const impl = c.derive.deriveCloneEnum(info.decl, true);
  if (impl) c.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [], typeAliases: [], interfaces: [], globals: [], deriveTemplates: [] }, c._pendingImplFns);
}

// Rule on every generic-struct bound recorded so far. Callable only once the impl
// tables are complete — see `_pendingStructBounds`.
export function flushStructBounds(c: TypeChecker) {
  while (c._pendingStructBounds.length > 0 || c._pendingCopyOnly.length > 0) {
    for (const b of c._pendingStructBounds.splice(0)) {
      if (c.typeImplementsTrait(typeName(b.concrete), b.bound)) continue;
      c.error(`type '${c.show(b.concrete)}' does not implement trait '${b.bound}', required by '${b.struct}<${b.param}: ${b.bound}>'`);
      c._boundFailedStructs.add(b.mangled);
    }
    for (const ch of c._pendingCopyOnly.splice(0)) {
      if (c.rejectNonCopyTypeArg(ch.generic, ch.mangled, ch.concrete, ch.span)) c._boundFailedStructs.add(ch.mangled);
    }
  }
}

// Which of a generic's type parameters `@copyOnly` constrains: all of them when bare,
// only the named ones with arguments (`@copyOnly(T)` on `parallelMapWith<T, S>`, whose
// per-worker state S never crosses the raw pointer and may own a Vec). Empty when the
// declaration carries no `@copyOnly`.
export function copyOnlyParams(attrs: Attribute[] | undefined, typeParams: string[]): Set<string> {
  const attr = attrs?.find(a => a.name === "copyOnly");
  if (!attr) return new Set();
  return new Set(attr.args.length > 0 ? attr.args : typeParams);
}

export function copyOutBlocker(c: TypeChecker, attrs: Attribute[] | undefined, typeArgs: TypeKind[]) {
  if (!attrs?.some(a => a.name === "copyOut")) return null;
  for (const arg of typeArgs) {
    const res = c.resourceKind(arg);
    if (res) return { ...res, arg };
  }
  return null;
}

// Bare, every type parameter must have `<`; `@ordered(K)` names the ones that must,
// so `SortedMap<i64, Res>` keeps its natural-order `new` (only the keys are compared).
export function orderedBlocker(attrs: Attribute[] | undefined, typeParams: string[], typeArgs: TypeKind[]): TypeKind | null {
  const attr = attrs?.find(a => a.name === "ordered");
  if (!attr) return null;
  return typeArgs.find((arg, i) =>
    (attr.args.length === 0 || attr.args.includes(typeParams[i]!)) && !isNumeric(arg) && arg.tag !== "string") ?? null;
}

// Why a generic `what` cannot exist for these type arguments, or null when it can.
export function withheldReason(c: TypeChecker, what: string, attrs: Attribute[] | undefined, typeParams: string[], typeArgs: TypeKind[]): { reason: string; hint: string } | null {
  const res = c.copyOutBlocker(attrs, typeArgs);
  if (res) return { reason: c.copyOutReason(what, res), hint: TypeChecker.COPY_OUT_HINT };
  const unordered = c.orderedBlocker(attrs, typeParams, typeArgs);
  if (unordered) {
    return {
      reason: `${what} orders its elements with '<', which '${c.show(unordered)}' does not have`,
      hint: `'<' exists only on integers, floats and strings; for another type use a form of this API that takes a comparator, where there is one`,
    };
  }
  return null;
}

export function methodWithheld(c: TypeChecker, m: Function, mangled: string, typeParams: string[], typeArgs: TypeKind[]): boolean {
  const why = c.withheldReason(`'${m.name}'`, m.attributes, typeParams, typeArgs);
  if (!why) return false;
  c.withheldMethods.set(`${mangled}.${m.name}`, why);
  return true;
}

export function copyOutReason(c: TypeChecker, what: string, b: { kind: string; via: TypeKind; arg: TypeKind }): string {
  const via = typeEq(b.via, b.arg) ? "" : ` (through '${c.show(b.via)}')`;
  return `${what} copies its element out, and '${c.show(b.arg)}' carries ${b.kind}${via}`;
}

// A generic body is only ever checked as an INSTANCE, so `self.base[i]` on a `*T` is
// seen as `*i64` or `*string` and judged per instantiation; the one instantiation that
// is unsound is the one no fixture wrote. This scans the TEMPLATE instead: inside a
// generic fn or a generic struct's method that is not `@copyOnly`, reading an element
// by value through a raw pointer whose pointee is a type parameter is refused, because
// nothing at that site proves T is Copy and a bitwise copy of a heap-owning T is a
// second owner. Narrow on purpose: only `name[i]` / `self.field[i]` where the pointer
// is DECLARED `*T` (a param, an explicitly typed local, or a field), only as an rvalue
// that is not itself indexed into further (`p[i].len` borrows), never a write, and
// never a memcpy/memset/zeroed move, which is how std/sync's Channel<T> stays clean.
export function checkRawTypeParamReads(c: TypeChecker): void {
  const ptrToParam = (t: MiloType | null | undefined, typeParams: string[]): string | null =>
    t && t.isPtr && (t.ptrDepth ?? 1) === 1 && !t.isArray && !t.isRef && !t.isRefMut
      && !t.isFn && !t.typeArgs?.length && typeParams.includes(t.name) ? t.name : null;

  const scan = (fn: Function, typeParams: string[], selfFields: Map<string, string>, owner: string, constrained: Set<string>) => {
    if (fn.isExtern || !fn.body) return;
    // Only the UNconstrained parameters can be read unsoundly; the rest are Copy.
    typeParams = typeParams.filter(tp => !constrained.has(tp));
    selfFields = new Map([...selfFields].filter(([, tp]) => !constrained.has(tp)));
    const locals = new Map<string, string>();
    for (const p of fn.params) {
      const tp = ptrToParam(declaredType(p), typeParams);
      if (tp) locals.set(p.name, tp);
    }
    const writes = new Set<Expr>();
    const borrowed = new Set<Expr>();
    walkExprs(fn.body, e => {
      if (e.kind === "FieldAccess" || e.kind === "MethodCall") borrowed.add(e.object);
    }, st => {
      if (st.kind === "Assign") writes.add(st.target);
      if ((st.kind === "LetDecl" || st.kind === "VarDecl") && st.type) {
        const tp = ptrToParam(st.type, typeParams);
        if (tp) locals.set(st.name, tp);
      }
    });
    walkExprs(fn.body, e => {
      if (e.kind !== "IndexAccess" || writes.has(e) || borrowed.has(e)) return;
      const o = e.object;
      const tp = o.kind === "Ident" ? locals.get(o.name)
        : o.kind === "FieldAccess" && o.object.kind === "Ident" && o.object.name === "self" ? selfFields.get(o.field)
        : undefined;
      if (!tp) return;
      c.error(`reading '${tp}' by value through a raw pointer copies it bitwise; '${tp}' may own memory`, e.span ?? fn.span,
        `mark '${owner}' @copyOnly so only Copy types can instantiate '${tp}', or clone the element and drop the old one explicitly`);
    });
  };

  for (const [name, g] of c.genericFns) {
    scan(g.decl, g.typeParams, new Map(), name, c.copyOnlyParams(g.decl.attributes, g.typeParams));
  }
  for (const [baseName, impls] of c.genericImpls) {
    const gs = c.genericStructs.get(baseName);
    if (!gs) continue;
    const selfFields = new Map<string, string>();
    for (const f of gs.decl.fields) {
      const tp = ptrToParam(f.type, gs.typeParams);
      if (tp) selfFields.set(f.name, tp);
    }
    const structConstrained = c.copyOnlyParams(gs.decl.attributes, gs.typeParams);
    for (const { impl } of impls) {
      for (const m of impl.methods) {
        const own = m.typeParams.map(t => t.name);
        const constrained = new Set([...structConstrained, ...c.copyOnlyParams(m.attributes, own)]);
        scan(m, [...gs.typeParams, ...own], selfFields, baseName, constrained);
      }
    }
  }
}

// The `@copyOnly` verdict for one type argument. Returns whether it was rejected.
export function rejectNonCopyTypeArg(c: TypeChecker, generic: string, mangled: string, concrete: TypeKind, span?: Span): boolean {
  if (concrete.tag === "unknown") return false;
  if (c.isCopyType(concrete)) return false;
  const key = c.mangleTypeName(concrete);
  if (c.copyOnlyReported.has(key)) return true;
  c.copyOnlyReported.add(key);
  const shownArg = c.show(concrete);
  const instance = c.structs.has(mangled) ? c.demangle(mangled) : `${generic}<${shownArg}>`;
  c.error(`'${instance}' is not allowed: '${generic}' is @copyOnly and '${shownArg}' is not a Copy type (${c.whyNotCopy(concrete)})`, span,
    `'${generic}' moves elements through a raw pointer, so a second owner of a '${shownArg}' would free it twice. Use a Copy element type, keep the elements in an Arena and hand out its Copy handles, or index the Vec directly`);
  return true;
}

// One clause on why a type is move-tracked, for the `@copyOnly` diagnostic.
export function whyNotCopy(c: TypeChecker, t: TypeKind): string {
  switch (t.tag) {
    case "string": case "vec": case "hashmap": case "heap": return "it owns heap memory";
    case "struct": {
      if (c.dropImpls.has(t.name)) return "it implements Drop";
      const info = c.structs.get(t.name);
      if (info?.noCopy) return "it is @noCopy";
      if (info?.pointerField) return `it holds a raw pointer ('${info.pointerField}') and is not @copy`;
      return "a field of it owns heap memory";
    }
    case "enum": {
      const pv = c.enums.get(t.name)?.pointerVariant;
      return pv ? `variant '${pv}' holds a raw pointer and it is not @copy` : "a variant of it owns heap memory";
    }
    case "fn": return t.owning ? "it is a move closure" : "it is a closure";
    case "ref": return "it is a reference";
    default: return "it is move-tracked";
  }
}

// Bodies of a bound-violating instantiation are skipped: every one of them would
// re-report the violation as "type 'i64' has no method 'read'" pointing inside the
// library, burying the single line that names the real cause.
export function fromBoundFailedStruct(c: TypeChecker, fn: Function): boolean {
  const sep = fn.name.indexOf("$");
  return sep > 0 && c._boundFailedStructs.has(fn.name.slice(0, sep));
}

// Whether `name` reaches itself through by-value fields (directly or through other
// by-value structs / fixed arrays), which means it has no finite size. Vec/Heap/
// pointer/ref indirection breaks the chain, since those are pointer-sized whatever
// they point at, so only value-struct and fixed-array-of-struct fields keep walking.
// Does the struct or enum `name` contain itself by value, through struct fields, enum
// variant payloads and fixed arrays? Enum payloads are inline, so `enum E { X(A) }`
// with `struct A { e: E }` is as infinite as a struct that holds itself; the enum used
// to slip through when the cycle passed through a struct, get a payload sized before
// the struct's own size was known, and spill 32 bytes past it (ASan on
// cloneDeriveEnumInStruct).
export function embedsSelf(c: TypeChecker, name: string, stack: Set<string>): boolean {
  if (stack.has(name)) return true;
  const fields: TypeKind[] = [];
  const sInfo = c.structs.get(name);
  if (sInfo) for (const f of sInfo.fields) fields.push(f.type);
  else {
    const eInfo = c.enums.get(name);
    if (!eInfo) return false;
    for (const v of eInfo.variants.values()) fields.push(...v.fields);
  }
  stack.add(name);
  for (let t of fields) {
    while (t.tag === "array") t = t.element;
    if ((t.tag === "struct" || t.tag === "enum") && c.embedsSelf(t.name, stack)) { stack.delete(name); return true; }
  }
  stack.delete(name);
  return false;
}

// `Pair_i64_string` back to `Pair<i64, string>`, for a diagnostic about a
// monomorphized struct or enum: the mangled name is an implementation detail and
// nobody wrote it, so nobody should have to read it. Every diagnostic formats types
// through `show`, which threads this into `typeName`; `typeName` alone stays the
// identity for lookups and mangling.
export function demangle(c: TypeChecker, mangled: string): string {
  const info = c.structs.get(mangled) ?? c.enums.get(mangled);
  if (!info || info.baseName === undefined) return mangled;
  const args = (info.typeArgs ?? []).map(a => c.show(a)).join(", ");
  return args.length === 0 ? info.baseName : `${info.baseName}<${args}>`;
}

export function monomorphizeStruct(c: TypeChecker, baseName: string, typeArgs: TypeKind[], sp?: Span): string {
  c.rejectVoidTypeArgs(baseName, typeArgs, sp);
  const mangled = `${baseName}_${typeArgs.map(a => c.mangleTypeName(a)).join("_")}`;
  if (c.structs.has(mangled)) return mangled;

  const generic = must(c.genericStructs, baseName, "generic structs");
  const typeMap = new Map<string, TypeKind>();
  generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

  for (let i = 0; i < generic.decl.typeParams.length; i++) {
    const tp = generic.decl.typeParams[i];
    for (const bound of tp.bounds) {
      c._pendingStructBounds.push({ struct: baseName, mangled, param: tp.name, concrete: typeArgs[i], bound });
    }
    if (c.copyOnlyParams(generic.decl.attributes, generic.typeParams).has(tp.name)) {
      c._pendingCopyOnly.push({ generic: baseName, mangled, concrete: typeArgs[i], span: sp });
    }
  }

  // The memo entry goes in BEFORE the field types are resolved, because
  // resolving one can lead straight back to this same instantiation: a struct
  // whose field is `Owner<T>` whose own method returns `Rejected<T>` reaches
  // `Rejected_f64` again while `Rejected_f64` is still being built. With the
  // memo installed only afterwards, that re-entry re-ran the whole body and
  // registered every impl method a second time, and LLVM rejected the program
  // with `invalid redefinition of function`. Fields are filled in below; the
  // re-entrant reader only needs the name to exist, not the layout.
  const entry: StructInfo = {
    fields: [], baseName, typeArgs,
    ...(generic.decl.span?.file && { file: generic.decl.span.file }),
    // Copy-ness is a property of the declaration, so every instantiation of a
    // `@noCopy` generic inherits it — `Handle<Texture>` is no more copyable than
    // the `Handle<T>` it came from.
    ...(generic.decl.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
    ...(generic.decl.attributes?.some(a => a.name === "copy") ? { copy: true } : {}),
  };
  c.structs.set(mangled, entry);
  entry.fields = generic.decl.fields.map(f => ({
    name: f.name,
    type: c.resolve(c.substituteMiloType(f.type, generic.typeParams, typeArgs)),
    ...(f.attributes?.some(a => a.name === "iter") ? { iterDelegate: true } : {}),
  }));
  // Judged on the instance, not the template: `Shard<T> { base: *T }` holds a pointer
  // in every instance, and `Cell<T> { v: T }` holds one exactly when `T` is a pointer.
  if (!entry.copy) {
    const pf = rawPointerField(entry.fields);
    if (pf) entry.pointerField = pf;
  }

  const decl: StructDecl = {
    kind: "StructDecl",
    name: mangled,
    typeParams: [],
    fields: generic.decl.fields.map(f => ({
      name: f.name,
      type: c.substituteMiloType(f.type, generic.typeParams, typeArgs),
      ...(f.default && { default: f.default }),
    })),
    // Where the generic lives: record/replay asks whether a type is std's own.
    ...(generic.decl.span && { span: generic.decl.span }),
  };
  c.monomorphizedStructDecls.push(decl);

  // instantiate generic impls for this concrete type
  const genericImplTemplates = c.genericImpls.get(baseName);
  if (genericImplTemplates) {
    for (const { impl: gi, program: prog } of genericImplTemplates) {
      const concreteImpl: import("./ast").ImplDecl = {
        kind: "ImplDecl",
        traitName: gi.traitName,
        typeName: mangled,
        typeParams: [],
        methods: gi.methods.filter(m => !c.methodWithheld(m, mangled, generic.typeParams, typeArgs)).map(m => ({
          ...m,
          // `@copyOut`/`@ordered` have been decided for this instance; the concrete impl
          // has no type parameters left for them to constrain, and registerImpl says so.
          ...(m.attributes && { attributes: m.attributes.filter(a => a.name !== "copyOut" && a.name !== "ordered") }),
          body: c.substituteBody(m.body, generic.typeParams, typeArgs, baseName, mangled),
          params: m.params.map(p => ({
            name: p.name,
            type: c.substituteSelfInMiloType(
              c.substituteParamType(declaredType(p), generic.typeParams, typeArgs),
              mangled
            ),
          })),
          retType: c.substituteSelfInMiloType(
            c.substituteMiloType(m.retType, generic.typeParams, typeArgs),
            mangled
          ),
        })),
        span: gi.span,
      };
      c.registerImpl(concreteImpl, prog, c._pendingImplFns);
    }
  }

  // Propagate derives from the generic struct to the monomorphized type.
  if (generic.decl.attributes) {
    for (const attr of generic.decl.attributes) {
      if (attr.name !== "derive") continue;
      for (const traitName of attr.args) {
        const impl = c.derive.synthesizeDeriveImpl(decl, traitName);
        if (impl) c.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [], typeAliases: [], interfaces: [], globals: [], deriveTemplates: [] }, c._pendingImplFns);
      }
    }
  }

  return mangled;
}

export function substituteTypeKind(c: TypeChecker, t: TypeKind, typeMap: Map<string, TypeKind>): TypeKind {
  if (t.tag === "struct" && typeMap.has(t.name)) return must(typeMap, t.name, "type map");
  if (t.tag === "array") return { ...t, element: c.substituteTypeKind(t.element, typeMap) };
  if (t.tag === "ref") return { ...t, inner: c.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "ptr") return { ...t, inner: c.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "heap") return { ...t, inner: c.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "vec") return { ...t, element: c.substituteTypeKind(t.element, typeMap) };
  if (t.tag === "hashmap") return { ...t, key: c.substituteTypeKind(t.key, typeMap), value: c.substituteTypeKind(t.value, typeMap) };
  if (t.tag === "fn") return { ...t, params: t.params.map(p => c.substituteTypeKind(p, typeMap)), ret: c.substituteTypeKind(t.ret, typeMap) };
  return t;
}

export function typeKindToMiloType(c: TypeChecker, t: TypeKind): MiloType {
  switch (t.tag) {
    case "vec": return { ...simpleType("Vec"), typeArgs: [c.typeKindToMiloType(t.element)] };
    case "heap": return { ...simpleType("Heap"), typeArgs: [c.typeKindToMiloType(t.inner)] };
    // typeName spells `HashMap<i64, i64>`, which resolved as one struct name: an
    // `Option<T>` instantiated with it got an enum named `Option_HashMap<i64, i64>`,
    // whose spaces broke the IR value names derived from it.
    case "hashmap": return { ...simpleType("HashMap"), typeArgs: [c.typeKindToMiloType(t.key), c.typeKindToMiloType(t.value)] };
    // A fixed-array pointee goes through the array case: its spelled name `[i64; 2]`
    // resolves as a struct, so `*[i64; 2]` as T made `p[1][0]` "cannot index".
    case "ref": return { ...c.pointeeMiloType(t.inner), isRef: !t.mutable, isRefMut: t.mutable };
    case "ptr": {
      // unwrap nested ptrs so `**u8` round-trips at the right depth, not collapsed
      let depth = 0; let cur: TypeKind = t;
      while (cur.tag === "ptr") { depth++; cur = cur.inner; }
      return { ...c.pointeeMiloType(cur), isPtr: true, ptrDepth: depth };
    }
    case "fn": return { ...simpleType(""), isFn: true, fnParams: t.params.map(p => c.typeKindToMiloType(p)), fnRet: c.typeKindToMiloType(t.ret) };
    // typeName spells a ranged int `i32(0..9)`, which resolves as a struct name: a
    // `W<R>` method taking `T` then refused every plain i32 instead of range-checking it.
    case "int":
      if (t.min !== undefined && t.max !== undefined) {
        return { ...simpleType(`${t.signed ? "i" : "u"}${t.bits}`), rangeMin: t.min, rangeMax: t.max };
      }
      return simpleType(typeName(t));
    // typeName spells `[i64; 2]`, which resolved as a struct name: std's `map<U>` with a
    // fixed-array U reached clang as `%[i64; 2]`. An array type is its element's type
    // with the array flag (one level; a nested array keeps the spelled name).
    case "array":
      if (t.element.tag !== "array") return { ...c.typeKindToMiloType(t.element), isArray: true, arraySize: t.size };
      return simpleType(typeName(t));
    default: return simpleType(typeName(t));
  }
}

// Null in, null out: only a closure param may omit its type annotation, and closures
// aren't monomorphized — but Param.type is nullable for everyone, so the substitution
// paths have to carry that through rather than assert it away.
// A parameter declared as a bare type parameter (`x: T`) promises nothing about
// keeping its argument, so when `T` is a closure type the instance's parameter is
// `move`: escaping, as a plain closure parameter is not (checkNonEscapingParams). Only
// a parameter written as a closure type is non-escaping.
export function substituteParamType(c: TypeChecker, ty: MiloType, typeParams: string[], typeArgs: TypeKind[]): MiloType {
  const sub = c.substituteMiloType(ty, typeParams, typeArgs);
  const bareTypeParam = typeParams.includes(ty.name) && !ty.isRef && !ty.isRefMut && !ty.isPtr && !ty.isArray;
  return bareTypeParam && sub.isFn && !sub.isCFn ? { ...sub, isMoveFn: true } : sub;
}

export function monomorphizeFn(c: TypeChecker, baseName: string, typeArgs: TypeKind[], sp?: Span): string {
  c.rejectVoidTypeArgs(baseName, typeArgs, sp);
  const mangled = `${baseName}_${typeArgs.map(a => c.mangleTypeName(a)).join("_")}`;
  if (c.functions.has(mangled)) return mangled;

  if (c.monoDepth >= TypeChecker.MAX_MONO_DEPTH) {
    if (!c.monoDepthErrored) {
      c.monoDepthErrored = true;
      c.error(`generic instantiation exceeded depth ${TypeChecker.MAX_MONO_DEPTH} while monomorphizing '${baseName}' — likely an unbounded recursive generic that instantiates itself on an ever-growing type`);
    }
    // register a stub sig so callers don't dereference undefined, then stop recursing
    c.functions.set(mangled, { params: [], ret: { tag: "unknown" }, variadic: false });
    return mangled;
  }
  c.monoDepth++;
  try {
  const generic = must(c.genericFns, baseName, "generic fns");
  const typeMap = new Map<string, TypeKind>();
  generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

  // check trait bounds
  let boundFailed = false;
  for (let i = 0; i < generic.decl.typeParams.length; i++) {
    const tp = generic.decl.typeParams[i];
    const concreteType = typeArgs[i];
    for (const bound of tp.bounds) {
      if (!c.typeImplementsTrait(typeName(concreteType), bound)) {
        c.error(`type '${c.show(concreteType)}' does not implement trait '${bound}'`, sp);
        boundFailed = true;
      }
    }
    if (c.copyOnlyParams(generic.decl.attributes, generic.typeParams).has(tp.name)) {
      c.rejectNonCopyTypeArg(baseName, mangled, concreteType, sp);
    }
  }

  // Build concrete param types — substitute type params first, then resolve
  const params = generic.decl.params.map(p => ({
    type: c.resolve(c.substituteParamType(declaredType(p), generic.typeParams, typeArgs), sp),
    name: p.name,
  }));
  const ret = c.resolve(c.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs), sp);

  // Register the concrete sig so recursive calls and the rest of checking works
  c.functions.set(mangled, { params, ret, variadic: false, ...mustUseOf(generic.decl) });

  // `@copyOut` with a resource argument: the call is the error, at the caller's span.
  // The signature above stays registered so the call types through without a cascade;
  // the body is never checked, because its by-index read would only repeat this at a
  // line inside the generic's own file.
  // A failed bound is reported at the call; checking the body as well would only repeat
  // it as a "no method" error inside the generic's own file.
  if (boundFailed) return mangled;

  const withheld = c.withheldReason(`'${baseName}'`, generic.decl.attributes, generic.typeParams, typeArgs);
  if (withheld) {
    c.error(`'${baseName}<${typeArgs.map(a => c.show(a)).join(", ")}>' is not allowed: ${withheld.reason}`, sp, withheld.hint);
    return mangled;
  }

  // Create concrete AST node for codegen
  const concreteDecl: Function = {
    kind: "Function",
    name: mangled,
    sourceName: baseName,
    typeParams: [],
    params: generic.decl.params.map(p => ({
      name: p.name,
      type: c.substituteParamType(declaredType(p), generic.typeParams, typeArgs),
    })),
    retType: c.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs),
    contracts: generic.decl.contracts ?? [],
    body: c.substituteBody(generic.decl.body, generic.typeParams, typeArgs),
    isExtern: false,
    isVariadic: false,
    // Attributes are behavioral (`@wrapping` changes arithmetic, `@pure` is checked
    // per-instance), so an instance that dropped them would silently differ from the
    // generic that declared them.
    ...(generic.decl.attributes && { attributes: generic.decl.attributes }),
    ...(generic.decl.fromWrappingModule && { fromWrappingModule: true }),
    ...(generic.decl.fromReplayHookedModule && { fromReplayHookedModule: true }),
    // The instance belongs to the file that DEFINED the generic, not the one that
    // happened to instantiate it — its code is the generic's body. Unlike the impl-method
    // paths below, this decl is built field by field rather than spread from the generic,
    // so the origin has to be carried explicitly or the instance arrives with none.
    ...(generic.decl.sourceFile && { sourceFile: generic.decl.sourceFile }),
  };
  c.monomorphizedFns.push(concreteDecl);

  // Type-check the monomorphized instance
  c.checkFunction(concreteDecl);

  return mangled;
  } finally { c.monoDepth--; }
}

// Instantiate a method that carries its own type parameters, for one concrete argument
// list. Mirrors `monomorphizeFn`: substitute, register the concrete signature so the body
// and any recursive call can be checked, then check it. The mangled name is what codegen
// emits, so two instantiations of `map<R>` are two functions, exactly as two
// instantiations of a generic free fn are.
export function monomorphizeMethod(c: TypeChecker, key: string, typeArgs: TypeKind[], sp?: Span): string | null {
  c.rejectVoidTypeArgs(key.replace("$", "."), typeArgs, sp);
  const tpl = c.genericMethods.get(key);
  if (!tpl) return null;
  const names = (tpl.decl.typeParams ?? []).map(t => t.name);
  const mangled = `${key}_${typeArgs.map(a => c.mangleTypeName(a)).join("_")}`;
  if (c.unsafeMethods.has(key)) c.unsafeMethods.add(mangled);
  if (c.functions.has(mangled)) return mangled;

  if (c.monoDepth >= TypeChecker.MAX_MONO_DEPTH) {
    if (!c.monoDepthErrored) {
      c.monoDepthErrored = true;
      c.error(`generic instantiation exceeded depth ${TypeChecker.MAX_MONO_DEPTH} while monomorphizing '${key}'`);
    }
    c.functions.set(mangled, { params: [], ret: { tag: "unknown" }, variadic: false });
    return mangled;
  }
  c.monoDepth++;
  try {
    let boundFailed = false;
    for (let i = 0; i < (tpl.decl.typeParams ?? []).length; i++) {
      for (const bound of tpl.decl.typeParams![i]!.bounds) {
        if (!c.typeImplementsTrait(typeName(typeArgs[i]!), bound)) {
          c.error(`type '${c.show(typeArgs[i]!)}' does not implement trait '${bound}'`, sp);
          boundFailed = true;
        }
      }
    }
    const concrete: Function = {
      ...tpl.decl,
      name: mangled,
      typeParams: [],
      params: tpl.decl.params.map(p => ({
        name: p.name,
        type: c.substituteParamType(declaredType(p), names, typeArgs),
      })),
      retType: c.substituteMiloType(tpl.decl.retType, names, typeArgs),
      body: c.substituteBody(tpl.decl.body, names, typeArgs),
    };
    const params = concrete.params.map(p => ({ type: c.resolve(declaredType(p)), name: p.name }));
    const ret = c.resolve(concrete.retType);
    c.functions.set(mangled, { params, ret, variadic: false, ...mustUseOf(tpl.decl) });
    // As in monomorphizeFn: the bound error at the call is the whole story.
    if (boundFailed) return mangled;
    c.monomorphizedFns.push(concrete);
    c.methodGenericInstances.add(mangled);
    c.checkFunction(concrete);
    return mangled;
  } finally { c.monoDepth--; }
}

// Work out a generic method's own type arguments from the call. Each parameter's
// declared type is unified structurally against the argument's actual type — the same
// `inferTypeParamsFromHint` a generic free-function call uses — and the return hint
// supplies any parameter no argument mentions.
export function inferMethodTypeArgs(c: TypeChecker, key: string, expr: MethodCall, expected: TypeKind | null): TypeKind[] | null {
  const tpl = must(c.genericMethods, key, "generic methods");
  const names = (tpl.decl.typeParams ?? []).map(t => t.name);
  const typeMap = new Map<string, TypeKind>();
  // +1 on the declared side: the template still carries `self` as its first parameter.
  for (let i = 0; i < expr.args.length; i++) {
    const declared = tpl.decl.params[i + 1];
    if (!declared) break;
    const argType = c.checkExpr(expr.args[i]!);
    if (argType.tag === "unknown") return null;
    c.inferTypeParamsFromHint(declaredType(declared), argType, names, typeMap);
  }
  if (expected) c.inferTypeParamsFromHint(tpl.decl.retType, expected, names, typeMap);
  if (names.some(n => !typeMap.has(n))) return null;
  return names.map(n => must(typeMap, n, "method type map"));
}

export function substituteBody(c: TypeChecker, stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[], baseName?: string, mangledName?: string): Stmt[] {
  // Deep clone body with type substitution in all MiloType positions.
  // MiloType objects have `name` but no `kind` (unlike AST nodes).
  // JSON can't round-trip bigint (IntLit.value), so tag it on the way out and
  // rebuild it on the way in.
  return JSON.parse(
    JSON.stringify(stmts, (_k, v) => typeof v === "bigint" ? { __bigint: v.toString() } : v),
    (_key, value) => {
    if (value && typeof value === "object" && "__bigint" in value) return BigInt(value.__bigint);
    if (value && typeof value === "object" && (value.kind === "CastExpr" || value.kind === "MethodCall" || (value.kind === "Call" && (value.func === "forget" || value.func === "_vecForget")))) c.instanceNodes.add(value);
    if (value && typeof value === "object" && "name" in value && !("kind" in value) && typeof value.name === "string") {
      const idx = typeParams.indexOf(value.name);
      if (idx !== -1) {
        // The wrappers stay, as in substituteMiloType: `&mut S` inside a local's fn
        // type (`let w: (&mut S) => R`) became a by-value `S`.
        return { ...value, ...wrapTypeArg(value, c.typeKindToMiloType(typeArgs[idx])) };
      }
    }
    // rewrite struct literal names: Channel { ... } → Channel_i64 { ... }. Not one that
    // spells its own type arguments: `Pair<B, A> { … }` inside `impl Pair<A, B>` is a
    // different instance, and its (already substituted) `typeArgs` say which.
    if (baseName && mangledName && value && typeof value === "object" && value.kind === "StructLit" && value.name === baseName
        && !(value.typeArgs?.length > 0)) {
      return { ...value, name: mangledName };
    }
    return value;
  });
}

// Match a generic fn return type (MiloType) against a concrete hint (TypeKind) to infer type params.
// e.g. retType=Arena<T>, hint={tag:"struct",name:"Arena_i32"} → T=i32
// Bare `Pair.new(1, "x")` on a generic struct. A generic impl is registered per
// MONOMORPHIZATION, so at this point nothing named `Pair` carries a static to look up
// and only the turbofish resolved. Recover the type arguments by unifying the argument
// types against the generic impl's own parameter list, then let the explicit path run
// unchanged.
//
// The arguments are typed twice: once here to unify, once by the explicit path against
// the substituted parameter types. Diagnostics from this pass are discarded, because
// the second pass reports against the concrete types — the ones the user can act on.
// Returning null anywhere leaves the existing "spell its type arguments" error in
// place, so a shape this cannot infer is no worse off than before.
export function inferGenericStaticTypeArgs(c: TypeChecker, expr: EnumLit, expected: TypeKind | null): MiloType[] | "argError" | null {
  const generic = c.genericStructs.get(expr.enumName);
  if (!generic || generic.typeParams.length === 0) return null;
  let method: import("./ast").Function | undefined;
  for (const t of c.genericImpls.get(expr.enumName) ?? []) {
    const m = t.impl.methods.find(mm => mm.name === expr.variant);
    if (m) { method = m; break; }
  }
  if (!method) return null;
  // A static has no `self`; an instance method reached through `Type.method(...)` is a
  // different call shape and is not this branch's business.
  if (method.params.length > 0 && method.params[0].name === "self") return null;
  if (method.params.length !== expr.args.length) return null;

  const typeMap = new Map<string, TypeKind>();
  const mark = c.diagnostics.length;
  let argFailed = false;
  try {
    for (let i = 0; i < method.params.length; i++) {
      const argType = c.checkExpr(expr.args[i]);
      if (argType.tag === "unknown") { argFailed = true; break; }
      c.inferTypeParamsFromHint(declaredType(method.params[i]), argType, generic.typeParams, typeMap);
    }
  } catch {
    argFailed = true;
  }
  // An argument that did not type is the real error, and it is the one the reader has
  // to fix. Keep its diagnostics and tell the caller to stop, rather than discarding
  // them and reporting "no static method 'new'" — which blames the call for a typo in
  // its argument. On the success path the explicit branch re-reports against the
  // substituted types, so this pass's copies go.
  if (argFailed) return "argError";
  c.diagnostics.length = mark;

  // A parameter no argument mentions comes from the type the context expects of the
  // call: `var a: Arena<Node> = Arena.new()`, a `&mut Arena<Node>` parameter, a return
  // type. `Self` in the declared return type means the generic type over its own
  // parameters. Only the hint meant for this call counts (`expected`), and a
  // wrong guess cannot slip through: the explicit path below re-checks the call
  // against the substituted signature, and the binding against its annotation.
  if (expected && generic.typeParams.some(tp => !typeMap.has(tp))) {
    const ret: MiloType = method.retType.name === "Self" && !method.retType.typeArgs?.length
      ? { name: expr.enumName, typeArgs: generic.typeParams.map(tp => ({ name: tp })) } as MiloType
      : method.retType;
    c.inferTypeParamsFromHint(ret, expected, generic.typeParams, typeMap);
  }
  // Still unbound: nothing in the call or its context fixes it, and the turbofish is the
  // only spelling left.
  if (generic.typeParams.some(tp => !typeMap.has(tp))) return null;
  return generic.typeParams.map(tp => c.typeKindToMiloType(must(typeMap, tp, "type map")));
}

// `Math.min(a, b)`: a static method carrying its own type parameters on a type that has
// none. The template sits in `genericMethods` exactly as an instance one does, but the
// static path only looked in `inherentImpls`, so the call reported "no static method".
// Arguments are typed twice, as in `inferGenericStaticTypeArgs`: once to unify (that
// pass's diagnostics are dropped), once against the substituted signature.
export function checkGenericStaticMethodCall(c: TypeChecker, expr: EnumLit, key: string, sp: Span | undefined, expected: TypeKind | null): TypeKind {
  const tpl = must(c.genericMethods, key, "generic methods");
  const names = (tpl.decl.typeParams ?? []).map(t => t.name);
  const typeMap = new Map<string, TypeKind>();
  const n = Math.min(expr.args.length, tpl.decl.params.length);
  // A bare literal binds last: `Math.min(9, x)` with `x: i32` means T = i32, and the
  // literal then takes that type from the substituted parameter. Binding the literal's
  // default first would pin T to i64 and reject `x`.
  const isLit = (e: Expr) => e.kind === "IntLit" || e.kind === "FloatLit" || c.isConstIntExpr(e);
  const order = [...Array(n).keys()].sort((a, b) => Number(isLit(expr.args[a]!)) - Number(isLit(expr.args[b]!)));
  const mark = c.diagnostics.length;
  for (const i of order) {
    const argType = c.checkExpr(expr.args[i]!);
    // An argument that did not type is the error to fix; keep its diagnostic.
    if (argType.tag === "unknown") return c.setType(expr, { tag: "unknown" });
    c.inferTypeParamsFromHint(declaredType(tpl.decl.params[i]!), argType, names, typeMap);
  }
  c.diagnostics.length = mark;
  if (expected) c.inferTypeParamsFromHint(tpl.decl.retType, expected, names, typeMap);
  const missing = names.filter(p => !typeMap.has(p));
  if (missing.length > 0) {
    c.error(`cannot infer '${missing.join("', '")}' for '${expr.enumName}.${expr.variant}'`, sp,
      `nothing in the arguments or the expected type fixes it — annotate the result`);
    return c.setType(expr, { tag: "unknown" });
  }
  const mangled = c.monomorphizeMethod(key, names.map(p => must(typeMap, p, "method type map")), sp);
  if (!mangled) return c.setType(expr, { tag: "unknown" });
  const sig = must(c.functions, mangled, "instantiated static method");
  c.checkStaticCallArgs(sig, expr, sp);
  c.staticCalls.set(expr, mangled);
  c.requireUnsafeMethod(mangled, `${expr.enumName}.${expr.variant}`, sp);
  return c.setType(expr, sig.ret);
}

export function inferTypeParamsFromHint(c: TypeChecker, retType: MiloType, hint: TypeKind, typeParams: string[], typeMap: Map<string, TypeKind>) {
  // A bare type parameter (`T`, no further args) binds directly to the hint. First
  // binding wins; a later conflicting one surfaces as a field/arg type mismatch in the
  // caller's per-field re-check, so we don't need to diagnose it here.
  // An array/pointer wrapper means the parameter names the ELEMENT, not the whole
  // hint: `[T]` against a `Vec<i64>` binds T to i64. Same rule as the direct-match
  // arm of generic call inference; the arms below do the unwrapping.
  const wrapped = retType.isArray || retType.isPtr || (retType.ptrDepth ?? 0) > 0;
  if (typeParams.includes(retType.name) && !retType.typeArgs?.length && !wrapped) {
    if (!typeMap.has(retType.name)) typeMap.set(retType.name, hint);
    return;
  }
  // A function type: unify parameter against parameter and result against result. Without
  // this arm a callback could not carry a type parameter at all — `fn map<R>(f: (&T) => R)`
  // handed `(x: &i64): i64 => …` bound nothing, so `R` stayed unresolved and the call
  // reported "expected (&i64) => R, got (&i64) => i64", naming a type nobody declared.
  if (retType.isFn && retType.fnParams && retType.fnRet && hint.tag === "fn") {
    for (let i = 0; i < retType.fnParams.length && i < hint.params.length; i++) {
      const p = hint.params[i]!;
      c.inferTypeParamsFromHint(retType.fnParams[i]!, p.tag === "ref" ? p.inner : p, typeParams, typeMap);
    }
    c.inferTypeParamsFromHint(retType.fnRet, hint.ret, typeParams, typeMap);
    return;
  }
  // Recurse through the built-in generic containers so `Vec<T>` / `[T]` fields infer T
  // from a `Vec<i64>` / `[i64]` argument — the case that made `for x in myVec` over a
  // user `MyVec<T>` fail to construct.
  if (retType.typeArgs?.length && (retType.name === "Vec" || retType.name === "Array") && hint.tag === "vec") {
    c.inferTypeParamsFromHint(retType.typeArgs[0], hint.element, typeParams, typeMap);
    return;
  }
  // A `[T]` / `&[T]` parameter also accepts a Vec (that is what auto-borrow hands it,
  // and the two share a representation), so both element positions unify here.
  if (retType.isArray && (hint.tag === "array" || hint.tag === "vec")) {
    // the element MiloType is the decl stripped of its array-ness
    c.inferTypeParamsFromHint({ ...retType, isArray: false, arraySize: null }, hint.element, typeParams, typeMap);
    return;
  }
  if ((retType.ptrDepth ?? (retType.isPtr ? 1 : 0)) > 0 && hint.tag === "ptr") {
    const depth = retType.ptrDepth ?? 1;
    let inner: TypeKind = hint;
    for (let d = 0; d < depth && inner.tag === "ptr"; d++) inner = inner.inner;
    c.inferTypeParamsFromHint({ ...retType, isPtr: false, ptrDepth: 0 }, inner, typeParams, typeMap);
    return;
  }
  // `Heap<T>` is its own TypeKind, not a generic struct, so the struct arm below never
  // sees it: `&Option<Heap<T>>` could not infer T through the box.
  if (retType.typeArgs?.length === 1 && retType.name === "Heap" && hint.tag === "heap") {
    c.inferTypeParamsFromHint(retType.typeArgs[0], hint.inner, typeParams, typeMap);
    return;
  }
  if (retType.typeArgs?.length === 2 && retType.name === "HashMap" && hint.tag === "hashmap") {
    c.inferTypeParamsFromHint(retType.typeArgs[0], hint.key, typeParams, typeMap);
    c.inferTypeParamsFromHint(retType.typeArgs[1], hint.value, typeParams, typeMap);
    return;
  }
  // A generic enum (`Option<T>`, `Result<T, E>`, a user `Maybe<T>`) against its concrete
  // instance: the monomorphized enum records its base and type arguments, as a struct
  // does. Without this arm `fn f<T>(o: Option<T>)` could not infer T from an
  // `Option<i64>` and every call needed a turbofish.
  if (hint.tag === "enum" && retType.typeArgs) {
    const info = c.enums.get(hint.name);
    if (info?.baseName === retType.name && info.typeArgs) {
      for (let i = 0; i < retType.typeArgs.length && i < info.typeArgs.length; i++) {
        c.inferTypeParamsFromHint(retType.typeArgs[i], info.typeArgs[i], typeParams, typeMap);
      }
    }
    return;
  }
  // Nested generic struct: `Arena<T>` field vs a concrete `Arena_i32` hint — recurse on
  // each type-arg position so parameters nested arbitrarily deep still resolve.
  if (hint.tag === "struct" && retType.typeArgs) {
    const info = c.structs.get(hint.name);
    if (info?.baseName === retType.name && info.typeArgs) {
      const gs = c.genericStructs.get(retType.name);
      if (gs) {
        for (let i = 0; i < retType.typeArgs.length && i < info.typeArgs.length; i++) {
          c.inferTypeParamsFromHint(retType.typeArgs[i], info.typeArgs[i], typeParams, typeMap);
        }
      }
    }
  }
}
