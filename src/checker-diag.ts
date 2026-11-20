// Error and warning reporting, lints, resource/unsafe/range/contract checks.
import type { TypeChecker } from "./checker";
import { BOOL_MEMBERS, FLOAT_MEMBERS, HASHMAP_MEMBERS, INT_MEMBERS, OPTION_MEMBERS, RESULT_MEMBERS, STRING_MEMBERS, VEC_MEMBERS, didYouMean, importHint, memberHint, stdExportNames, suggestions } from "./suggest";
import { BUILTIN_GENERIC_TYPE_NAMES, CheckAbort, importPathFrom, isForeignModule, mustUseOf, rewritten } from "./checker-util";
import type { Diagnostic, DiagnosticNote } from "./diagnostics";
import type { Expr, MiloType, Program, Span, Stmt, IndexAccess, LetDecl } from "./ast";
import { HARD_ERRORS } from "./warnings";
import { PRIMITIVE_TYPE_NAMES, UNKNOWN_TYPE_NAME, typeEq, typeName } from "./types";
import type { TypeKind } from "./types";
import { STDLIB_DIR } from "./stdlibBundle";
import { basename, resolve as resolvePath, sep } from "path";
import { replaySite } from "./replay-externs";
import { traceAttrError } from "./trace-attrs";

// `adopt<T>`/`adoptSlice<T>` on a struct whose fields are raw pointers frees the struct
// and NOTHING it addresses: a raw pointer is not owned, so it gets no drop glue. That is
// correct — it is what makes the layout an ABI match — but it is the one thing about
// `adopt` a reader is likely to assume otherwise, and it is exactly the shape a C-derived
// `extern struct` has. A warning rather than an error, because borrowed pointer fields
// are the normal case and the compiler cannot tell those from owned ones.
export function warnAdoptRawFields(c: TypeChecker, fnName: string, declSpan: Span | undefined, typeArgs: TypeKind[], sp?: Span) {
  if (fnName !== "adopt" && fnName !== "adoptSlice") return;
  if (!isForeignModule(declSpan?.file)) return;
  const t = typeArgs[0];
  if (t?.tag !== "struct") return;
  const raw = (c.structs.get(t.name)?.fields ?? []).filter(f => f.type.tag === "ptr");
  if (raw.length === 0) return;
  c.warn("adopt-raw-fields",
    `'${fnName}<${c.show(t)}>': dropping the adopted value frees the ${c.show(t)} itself and not what its raw pointer field(s) address`,
    sp,
    `${raw.map(f => `'${t.name}.${f.name}'`).join(", ")} ${raw.length === 1
        ? "is a raw pointer: it owns nothing and has no drop glue, so free what it addresses before the adopted value drops"
        : "are raw pointers: they own nothing and have no drop glue, so free what they address before the adopted value drops"}, or '--allow=adopt-raw-fields' if they are borrowed`);
}

// Can a value of this type exist at all? Conservative and total: anything not proven
// empty is treated as inhabited, and a type that reaches itself is assumed inhabited
// rather than chased, because deciding that case needs a fixpoint and getting it wrong
// in the other direction would silently drop a real arm from an exhaustiveness check.
export function isUninhabited(c: TypeChecker, t: TypeKind, seen: Set<string>): boolean {
  if (t.tag === "enum") {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    const info = c.enums.get(t.name);
    if (!info) return false;
    // Zero variants is the base case (`enum Never { }`); an enum all of whose variants
    // are themselves uninhabited has no constructible value either.
    return [...info.variants.values()].every(v => v.fields.some(f => c.isUninhabited(f, seen)));
  }
  if (t.tag === "struct") {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    const info = c.structs.get(t.name);
    if (!info) return false;
    // A product needs every field, so one uninhabited field is enough.
    return info.fields.some(f => c.isUninhabited(f.type, seen));
  }
  // `[Never; 3]` cannot be built; `[Never; 0]` and an empty `Vec<Never>` can.
  if (t.tag === "array" && t.size !== null && t.size > 0) return c.isUninhabited(t.element, seen);
  return false;
}

// Recovery policy: an erroneous declaration still binds; an erroneous expression is
// typed `unknown`; nothing reports about `unknown`. The last part is enforced here
// rather than at each of the hundreds of call sites: once an error is on file, a
// message that had to render a type as `<unknown>` is about the first mistake's
// fallout, not a new one. With no error on file it is a checker bug and still shows.
export function error(c: TypeChecker, msg: string, span?: Span, hint?: string) {
  if ((msg.includes(UNKNOWN_TYPE_NAME) || hint?.includes(UNKNOWN_TYPE_NAME)) && c.diagnostics.some(d => d.severity === "error")) return;
  // An expression the checker synthesized (a derived clone, a desugaring) has no span of its own; the
  // enclosing function's is still a place to look, where none would print no location at all.
  c.diagnostics.push({ severity: "error", span: span ?? c.currentFnDecl?.span, message: msg, hint });
}

export function errorWithNotes(c: TypeChecker, msg: string, span: Span | undefined, hint: string | undefined, notes: DiagnosticNote[]): Diagnostic {
  const d: Diagnostic = { severity: "error", span, message: msg, hint, ...(notes.length > 0 && { notes }) };
  c.diagnostics.push(d);
  return d;
}

// `void` has no runtime representation, so anything that gives it a storage slot (a
// generic instantiated at void, a local bound to a void call) lowers to `alloca void`,
// `call void @f(void void)` or `getelementptr void`, all of which LLVM rejects at the
// link step against a temp .ll file with no source location. Reject here, where a span
// may still exist. `Unit` (std/prelude, auto-imported) is the value-shaped spelling.
// Real zero-sized-type support would make this legal; until then, failing in the right
// place with the right advice beats failing in the linker with none.
export function rejectVoidTypeArgs(c: TypeChecker, owner: string, args: TypeKind[], sp?: Span): boolean {
  if (!args.some(a => a.tag === "void")) return false;
  // One report per compilation, not per generic: `Promise<void>` instantiates Channel,
  // Result and Option with the same void, and four copies of one mistake buries the fix.
  // A second, genuinely independent void mistake surfaces on the next run.
  const first = c.voidGenericReported.size === 0;
  c.voidGenericReported.add(owner);
  if (first) {
    c.error(`'${owner}' cannot be instantiated with 'void': 'void' has no runtime representation`, sp,
      `use 'Unit' for a value that carries no data: '${owner}<Unit>', constructed as 'Unit {}'`);
  }
  return true;
}

// Every method name callable on `t`, for "did you mean" only. Builtin receivers
// dispatch through hand-written if-chains with no symbol table, so their names
// come from the lists in suggest.ts; user types read their real impl blocks.
export function methodCandidates(c: TypeChecker, t: TypeKind): string[] {
  const bare = t.tag === "ref" ? t.inner : t;
  switch (bare.tag) {
    case "vec": case "array": return [...VEC_MEMBERS];
    case "hashmap": return [...HASHMAP_MEMBERS];
    case "string": return [...STRING_MEMBERS];
    // Scalars dispatch by hand too, and their surface is the overflow escape
    // hatch (wrappingAdd, checkedMul, …) — without these a typo there was the
    // one member mistake in the language that got no suggestion at all.
    case "int": return [...INT_MEMBERS];
    case "float": return [...FLOAT_MEMBERS];
    case "bool": return [...BOOL_MEMBERS];
    default: break;
  }
  const name = (bare as any).name;
  if (typeof name !== "string") return [];
  const out: string[] = [];
  // Option/Result have no impl block — their combinators live in the checker, so
  // without this the member tables are the only place that knows them and a typo
  // gets no suggestion at all.
  if (bare.tag === "enum") {
    const base = c.enums.get(name)?.baseName;
    if (base === "Option") out.push(...OPTION_MEMBERS);
    if (base === "Result") out.push(...RESULT_MEMBERS);
  }
  const inherent = c.inherentImpls.get(name);
  if (inherent) out.push(...inherent.methods.keys());
  for (const impl of c.traitImpls.get(name) ?? []) out.push(...impl.methods.keys());
  const sdef = c.structs.get(name);
  // fn-typed fields are callable as methods, so they belong in the candidate set
  if (sdef) for (const f of sdef.fields) if (f.type.tag === "fn") out.push(f.name);
  return out;
}

// A plain `"..."` is not interpolated — only `$"..."` is. `"hi ${name}"` and
// `"hi {name}"` therefore compile to those characters verbatim, with no error,
// which is the one way to get silently wrong output in this language. Warning
// requires the braced name to actually resolve in scope, so a literal holding
// shell (`"${PATH}"`), CSS, or a format string for some other tool stays quiet.
export function checkMissingInterpolation(c: TypeChecker, expr: import("./ast").StringLit) {
  if (expr.fromFString) return;
  const v = expr.value;
  if (!v.includes("{")) return;
  for (const m of v.matchAll(/\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (!c.lookup(m[1])) continue;
    // `{{name}}` is a template placeholder (`t.replace("{{name}}", v)`), not a missed interpolation.
    const open = m.index! + m[0].indexOf("{");
    if (v[open - 1] === "{" || v[open + m[0].length - (open - m.index!)] === "}") continue;
    c.warn("missing-interpolation", `'${m[0]}' in a plain string is not interpolated`, expr.span,
      `prefix the literal with '$' to interpolate: $"...{${m[1]}}..."  (Milo drops the '$' inside the braces)`);
    return;
  }
}

// `Foo.bar()` where the whole thing failed to resolve. Three very different
// mistakes land here — a typo'd static method, a typo'd type name, and a type
// that exists in std but wasn't imported — and reporting all three as "unknown
// enum" left the reader with nothing to act on (and, for a struct, a word that
// doesn't apply to their code at all).
export function errorUnknownStatic(c: TypeChecker, typeName_: string, member: string, sp: Span | undefined) {
  const known = c.structs.has(typeName_) || c.enums.has(typeName_) ||
    c.genericStructs.has(typeName_) || c.genericEnums.has(typeName_);
  if (known) {
    const statics: string[] = [...(c.inherentImpls.get(typeName_)?.methods.keys() ?? [])];
    for (const impl of c.traitImpls.get(typeName_) ?? []) statics.push(...impl.methods.keys());
    const variants = [...(c.enums.get(typeName_)?.variants.keys() ?? [])];
    // A generic type's impl block is only registered per monomorphization, so
    // `Arena.new()` finds nothing to call while `Arena<Node>.new()` works. The
    // empty candidate set would otherwise leave this error with no hint at all.
    const params = c.genericStructs.get(typeName_)?.typeParams ?? c.genericEnums.get(typeName_)?.typeParams;
    // The generic impl's own declarations: the method exists, only its type arguments
    // are unknown. Saying "no static method" here sent readers looking for a method
    // that is right there in the impl.
    const genericMethods = (c.genericImpls.get(typeName_) ?? []).flatMap(g => g.impl.methods);
    const declared = genericMethods.find(m => m.name === member && m.params[0]?.name !== "self");
    if (params && params.length > 0 && declared) {
      const spelled = `${typeName_}<${params.join(", ")}>`;
      c.error(`cannot infer the type arguments of '${typeName_}' for '${typeName_}.${member}(...)'`, sp,
        `nothing in the arguments or the expected type fixes ${params.map(p => `'${p}'`).join(", ")}: ` +
        `write them, '${spelled}.${member}(...)', or annotate the binding, 'let x: ${spelled} = ${typeName_}.${member}(...)'`);
      return;
    }
    statics.push(...genericMethods.filter(m => m.params[0]?.name !== "self").map(m => m.name));
    const hint = memberHint(member, [...statics, ...variants]) ??
      (params && params.length > 0
        ? `'${typeName_}' is generic — spell its type arguments: '${typeName_}<${params.join(", ")}>.${member}(...)'`
        : undefined);
    c.error(`type '${typeName_}' has no static method '${member}'`, sp, hint);
    return;
  }
  c.error(`unknown type '${typeName_}'`, sp, c.unknownTypeHint(typeName_));
}

// A missing std import gets the import line; otherwise the nearest declared type,
// then the nearest std export.
// A name this file never imported that other modules export under per-module symbols
// (src/resolver.ts, stage 1): nothing in the merged program is called `name` any more,
// so the visibility pass cannot report it as unimported, and the lookup that failed
// would say "undefined". Reported the way the visibility pass reports an unimported
// name, with the import line to add.
export function unimportedRenamed(c: TypeChecker, name: string, ns: "values" | "types", sp: Span | undefined): { message: string; hint: string } | undefined {
  const files = new Set<string>();
  for (const [sym, written] of c._displayNames ?? []) {
    if (written !== name) continue;
    const o = c.declOrigin(ns, sym);
    if (o?.anyPub) for (const f of o.files) files.add(f);
  }
  if (files.size === 0) return undefined;
  const sorted = [...files].sort();
  const hint = sorted.length === 1 && sp?.file
    ? `it is exported by ${basename(sorted[0])}; add it to the import list: from "${importPathFrom(sp.file, sorted[0])}" import { ${name} }`
    : `it is exported by ${sorted.map(f => basename(f)).join(" and ")}; add it to the import list of the module you mean`;
  return { message: `'${name}' is not imported`, hint };
}

export function unknownTypeHint(c: TypeChecker, name: string, extra: Iterable<string> = []): string {
  const fromStd = importHint(name);
  if (fromStd) return fromStd;
  const declared = new Set<string>([
    ...c.structs.keys(), ...c.enums.keys(),
    ...c.genericStructs.keys(), ...c.genericEnums.keys(),
    ...c.typeAliases.keys(), ...c.interfaces.keys(),
    ...PRIMITIVE_TYPE_NAMES, ...BUILTIN_GENERIC_TYPE_NAMES, ...extra,
  ].map(n => c._displayNames?.get(n) ?? n).filter(n => !n.includes("$")));
  return didYouMean(suggestions(name, declared))
    ?? didYouMean(suggestions(name, stdExportNames()))
    ?? `no type named '${name}' is declared or imported here`;
}

// Every type written in the program, checked against the declared names before any
// of them is resolved. `resolve` cannot do this itself: it runs before every decl is
// registered (forward references) and inside generic templates whose parameters are
// plain names, so an unknown name there looks exactly like a struct not yet seen.
// Undeclared names are recorded in `unknownTypeNames`, which `resolve` maps to
// `unknown` so the one mistake does not come back as a mismatch at every use.
export function reportUnknownTypeNames(c: TypeChecker, program: Program): void {
  const known = new Set<string>([
    ...PRIMITIVE_TYPE_NAMES, ...BUILTIN_GENERIC_TYPE_NAMES, "Self",
    ...program.structs.map(s => s.name), ...program.enums.map(e => e.name),
    ...program.typeAliases.map(a => a.name), ...program.interfaces.map(i => i.name),
    ...program.traits.map(t => t.name),
    ...c.structs.keys(), ...c.enums.keys(), ...c.interfaces.keys(),
  ]);
  const reported = new Set<string>();
  const typeParamNames = new Set<string>();
  const unknown = new Map<string, Span | undefined>();
  const isMiloType = (v: any): v is MiloType =>
    typeof v.name === "string" && typeof v.isPtr === "boolean" && typeof v.isArray === "boolean" && !("kind" in v);
  const checkType = (ty: MiloType, scope: ReadonlySet<string>, fallback: Span | undefined) => {
    if (ty.isFn) {
      for (const p of ty.fnParams ?? []) checkType(p, scope, fallback);
      if (ty.fnRet) checkType(ty.fnRet, scope, fallback);
      return;
    }
    for (const a of ty.typeArgs ?? []) checkType(a, scope, ty.span ?? fallback);
    if (known.has(ty.name) || scope.has(ty.name)) return;
    const sp = ty.span ?? fallback;
    const key = `${sp?.file}:${sp?.line}:${sp?.col}:${ty.name}`;
    if (reported.has(key)) return;
    reported.add(key);
    if (!unknown.has(ty.name)) unknown.set(ty.name, sp);
    const unimported = c.unimportedRenamed(ty.name, "types", sp);
    if (unimported) c.diagnostics.push({ severity: "error", span: sp, ...unimported, code: "unimported" });
    else c.error(`unknown type '${ty.name}'`, sp, c.unknownTypeHint(ty.name, known));
  };
  // Statements and expressions hold types in many node kinds (let annotations, casts,
  // turbofish args, closure params); a structural walk finds all of them without a
  // case per node that a new node kind would silently miss.
  const walk = (node: any, scope: ReadonlySet<string>, fallback: Span | undefined): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, scope, fallback); return; }
    if (isMiloType(node)) { checkType(node, scope, fallback); return; }
    const here: Span | undefined = node.span && typeof node.span.line === "number" ? node.span : fallback;
    for (const k in node) if (k !== "span") walk(node[k], scope, here);
  };
  const withParams = (outer: ReadonlySet<string>, tps: readonly { name: string }[] | undefined): ReadonlySet<string> => {
    if (!tps?.length) return outer;
    for (const tp of tps) typeParamNames.add(tp.name);
    return new Set([...outer, ...tps.map(tp => tp.name)]);
  };
  const none = new Set<string>();
  const checkFn = (fn: { typeParams?: { name: string }[]; params: unknown; retType: unknown; body: unknown; contracts?: unknown; span?: Span }, outer: ReadonlySet<string>) => {
    const scope = withParams(outer, fn.typeParams);
    walk([fn.params, fn.retType, fn.contracts ?? [], fn.body ?? []], scope, fn.span);
  };
  for (const s of program.structs) walk(s.fields, withParams(none, s.typeParams), s.span);
  for (const e of program.enums) walk(e.variants, withParams(none, e.typeParams), e.span);
  for (const a of program.typeAliases) walk(a.type, withParams(none, a.typeParams), a.span);
  for (const g of program.globals) walk([g.type, g.value], none, g.span);
  for (const fn of program.functions) checkFn(fn, none);
  for (const t of program.traits) {
    const scope = withParams(none, t.typeParams);
    for (const m of t.methods) checkFn({ ...m, contracts: [] }, scope);
  }
  for (const i of program.interfaces) for (const m of i.methods) checkFn({ ...m, contracts: [] }, none);
  for (const impl of program.impls) {
    const scope = withParams(none, impl.typeParams);
    if (!known.has(impl.typeName) && !scope.has(impl.typeName)) {
      checkType({ name: impl.typeName, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }, scope, impl.typeSpan ?? impl.span);
    }
    for (const m of impl.methods) checkFn(m, scope);
  }
  // A name some declaration also uses as a type parameter must still resolve to that
  // parameter there, so only names that are never one are poisoned.
  for (const name of unknown.keys()) if (!typeParamNames.has(name)) c.unknownTypeNames.add(name);
}

// Nearest in-scope binding or function to a name that didn't resolve. Scopes are
// searched innermost-out so a shadowing local wins the suggestion.
export function nameHint(c: TypeChecker, name: string): string | undefined {
  const seen = new Set<string>();
  for (let i = c.scopes.length - 1; i >= 0; i--) for (const k of c.scopes[i].keys()) seen.add(k);
  for (const sym of c.functions.keys()) {
    const k = c._displayNames?.get(sym) ?? sym;
    if (!k.includes("$")) seen.add(k);
  }
  return didYouMean(suggestions(name, seen));
}

// Field names readable on `t`. The builtin containers expose exactly one, which
// is what makes the `.length` → `.len` suggestion land.
export function fieldCandidates(c: TypeChecker, t: TypeKind): string[] {
  const bare = t.tag === "ref" ? t.inner : t;
  switch (bare.tag) {
    case "vec": case "array": case "hashmap": case "string": return ["len"];
    case "struct": return c.structs.get(bare.name)?.fields.map(f => f.name) ?? [];
    default: return [];
  }
}

// Report and STOP. For the sites where the invariant the rest of the code needs
// is exactly the one that just failed: a struct that isn't declared, a field
// that doesn't exist, an expression that isn't a place. `error()` returns void,
// so each of those had to remember its own `return`, and the ones that forgot
// ran on a value the diagnostic had just proved absent. Throwing removes the
// choice — and removes the `| null` from the signatures that had to encode it.
//
// Recovery is not lost: the throw unwinds to the nearest boundary (`recover`),
// one per statement inside a function body and one per declaration above that,
// so a run still reports an error in every statement that has one.
export function fatal(c: TypeChecker, msg: string, span?: Span, hint?: string): never {
  c.error(msg, span, hint);
  throw new CheckAbort();
}

// A `fatal()` recovery boundary. Absorbs the unwind and rewinds the stacks the
// abandoned work had pushed onto — a scope, an `unsafe` block, a loop body left
// open would otherwise leak into whatever is checked next and misreport it.
export function recover(c: TypeChecker, f: () => void) {
  const scopeDepth = c.scopes.length;
  const unsafeDepth = c.unsafeDepth;
  const unsafeUsed = c.unsafeUsedStack.length;
  const loopDepth = c.loopDepth;
  const loopFrameCount = c.loopFrames.length;
  const reachable = c.reachable;
  const closureFrameCount = c.closureFrames.length;
  const borrowWindowCount = c.borrowWindows.length;
  try {
    f();
  } catch (e) {
    if (!(e instanceof CheckAbort)) throw e;
    c.scopes.length = scopeDepth;
    c.borrowWindows.length = borrowWindowCount;
    c.unsafeDepth = unsafeDepth;
    c.unsafeUsedStack.length = unsafeUsed;
    c.loopDepth = loopDepth;
    c.loopFrames.length = loopFrameCount;
    c.reachable = reachable;
    c.closureFrames.length = closureFrameCount;
  }
}

export function warn(c: TypeChecker, code: string, msg: string, span?: Span, hint?: string, len?: number) {
  if (HARD_ERRORS.has(code)) {
    c.diagnostics.push({ severity: "error", span, len, message: msg, hint, code });
    return;
  }
  if ((c.warningConfig.expected !== undefined && c.warningConfig.expected.has(code))) {
    c.firedWarnings.add(code);
    return; // expected findings are suppressed, exactly like an allow
  }
  if (c.warningConfig.allowed.has(code)) return;
  const severity = (c.warningConfig.denied.has(code) || c.warningConfig.denied.has("*")) ? "error" : "warning";
  c.diagnostics.push({ severity, span, len, message: msg, hint, code });
}

// Conservative byte size of a fixed-size array whose leaves are scalars.
// Returns null when any dimension is dynamic or a leaf isn't a fixed-width
// scalar (structs/enums/vecs have layout we don't compute here). Used only to
// flag oversized stack allocations — an underestimate is fine, a false alarm is not.
export function fixedArrayBytes(c: TypeChecker, t: TypeKind): number | null {
  if (t.tag !== "array" || t.size === null) return null;
  const elemBytes = (e: TypeKind): number | null => {
    if (e.tag === "int" || e.tag === "float") return e.bits / 8;
    if (e.tag === "bool") return 1;
    if (e.tag === "ptr" || e.tag === "ref") return 8;
    if (e.tag === "array") return c.fixedArrayBytes(e);
    return null;
  };
  const eb = elemBytes(t.element);
  return eb === null ? null : eb * t.size;
}

// A local fixed array is a stack allocation of its full size, up front. Big ones
// silently overflow the stack at runtime (same trap Rust's `[T; N]` has). Warn so
// the fix — a heap `Vec<T>` — is visible at the declaration.
export function lintStackArray(c: TypeChecker, name: string, ty: TypeKind, span?: Span) {
  // Opt-in only (see constructor); skip the byte math entirely when suppressed.
  if (c.warningConfig.allowed.has("large-stack-array")) return;
  const threshold = c.warningConfig.maxStackArrayBytes ?? 512 * 1024;
  const bytes = c.fixedArrayBytes(ty);
  if (bytes === null || bytes <= threshold) return;
  const kib = bytes / 1024;
  const human = kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${Math.round(kib)} KiB`;
  const elemName = ty.tag === "array" ? c.show(ty.element) : "T";
  c.warn(
    "large-stack-array",
    `'${name}' is a ${human} stack allocation`,
    span,
    `large local arrays can overflow the stack; use Vec<${elemName}> for a heap buffer`,
  );
}

// `let m = v[i]` on a non-Copy element is a deep copy: indexing clones so the
// container stays intact (the field spelling `b.v` is a hard error instead — see the
// aliasing matrix). The cost is invisible at the use site, because the SAME syntax is
// free or a malloc depending on a field of the element type you cannot see there:
// `Vec<i64>` costs nothing, `Vec<Mark>` costs an allocation per heap field, per row,
// per iteration. `for m in v` binds by reference and clones nothing, so the cheap
// spelling already exists — it is just undiscoverable at the moment it matters.
// A value whose duplication has a MEANING beyond copying bytes: a struct with a Drop
// impl that releases something, `@noCopy` on a handle, or a raw pointer field without
// `@copy`, anywhere inside the type.
// The index path's deep clone is structural: it copies
// strings and Vecs buffer by buffer but never consults a Drop impl, so a resource
// nested in an `Option<Fd>` or a `Vec<Fd>` element is duplicated just as surely as a
// bare `Fd`. Returns which mechanism and the type that carries it, for the diagnostic.
// Whether a value of `ty` holds a raw pointer anywhere inside it. `@copy` is not an
// exemption here (unlike `resourceKind`): this asks "can it dangle", not "does copying
// it duplicate an owner".
// Whether the code at `sp` (or the fn being checked) is a std module.
export function inStdFile(c: TypeChecker, sp: Span | undefined): boolean {
  const file = sp?.file ?? c.currentFnFile;
  if (!file) return false;
  return resolvePath(file).startsWith(resolvePath(STDLIB_DIR, "std") + sep);
}

// Whether a struct/enum type's every declaration is in std (a std type that carries a
// raw pointer, like a Channel, is std's own audited sharing).
export function typeDeclaredInStd(c: TypeChecker, ty: TypeKind): boolean {
  if (ty.tag !== "struct" && ty.tag !== "enum") return false;
  const files = c.declFiles("types", ty.name);
  // STDLIB_DIR holds std/ (in a checkout it is the repo root, tests/ included).
  const stdRoot = resolvePath(STDLIB_DIR, "std") + sep;
  if (files.size > 0) return [...files].every(f => f.startsWith(stdRoot));
  // A generic's instance (`Channel_i64`) is declared where the generic is.
  const inst = c.monomorphizedStructDecls.find(d => d.name === ty.name);
  return !!inst?.span?.file?.startsWith(stdRoot);
}

export function carriesRawPointer(c: TypeChecker, ty: TypeKind, seen: Set<string> = new Set()): boolean {
  switch (ty.tag) {
    case "ptr": return true;
    case "vec": return c.carriesRawPointer(ty.element, seen);
    case "heap": return c.carriesRawPointer(ty.inner, seen);
    case "struct": {
      const info = c.structs.get(ty.name);
      if (!info || seen.has(ty.name)) return false;
      seen.add(ty.name);
      return info.fields.some(f => c.carriesRawPointer(f.type, seen));
    }
    case "enum": {
      const info = c.enums.get(ty.name);
      if (!info || seen.has(ty.name)) return false;
      seen.add(ty.name);
      return [...info.variants.values()].some(v => v.fields.some(t => c.carriesRawPointer(t, seen)));
    }
    default: return false;
  }
}

export function resourceKind(c: TypeChecker, ty: TypeKind, seen: Set<string> = new Set()): { kind: string; via: TypeKind } | null {
  // The concrete type is erased, so no structural copy can duplicate the block and
  // its drop through the itable: a bitwise copy would be freed once per copy.
  if (ty.tag === "interface") return { kind: "an interface value (its concrete type is erased, so it cannot be copied)", via: ty };
  switch (ty.tag) {
    case "struct": {
      if (c.dropImpls.has(ty.name)) return { kind: "Drop", via: ty };
      const info = c.structs.get(ty.name);
      if (!info) return null;
      if (info.noCopy) return { kind: "@noCopy", via: ty };
      if (info.pointerField) return { kind: `a raw pointer field ('${info.pointerField}') and is not @copy`, via: ty };
      // Recursive types (`Heap<Node>` fields) terminate on the visited set.
      if (seen.has(ty.name)) return null;
      seen.add(ty.name);
      for (const f of info.fields) {
        const r = c.resourceKind(f.type, seen);
        if (r) return r;
      }
      return null;
    }
    case "enum": {
      if (c.dropImpls.has(ty.name)) return { kind: "Drop", via: ty };
      if (seen.has(ty.name)) return null;
      seen.add(ty.name);
      const info = c.enums.get(ty.name);
      if (!info) return null;
      for (const v of info.variants.values()) {
        for (const f of v.fields) {
          const r = c.resourceKind(f, seen);
          if (r) return r;
        }
      }
      return null;
    }
    case "vec": case "array": return c.resourceKind(ty.element, seen);
    case "heap": return c.resourceKind(ty.inner, seen);
    case "hashmap": return c.resourceKind(ty.key, seen) ?? c.resourceKind(ty.value, seen);
    // A copy would share the env, and each copy's drop would free it: one owner only.
    case "fn": return ty.owning ? { kind: "an owning closure's environment", via: ty } : null;
    default: return null;
  }
}

// Every type with a user Drop impl that destroying a value of `ty` may run, for the
// global-write summary. A struct runs its own Drop then its fields' drop glue, so this
// keeps descending past a Drop type where resourceKind stops. A reference or raw
// pointer owns nothing. Two holders hide what they own from the type: a
// closure value (its captures) and an interface value (its concrete type); those come back
// as the markers "<closure-env>" and "<interface>" for the pass to widen.
export function dropTypesIn(c: TypeChecker, ty: TypeKind, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  switch (ty.tag) {
    case "struct": case "enum": {
      if (seen.has(ty.name)) return out;
      seen.add(ty.name);
      if (c.dropImpls.has(ty.name)) out.add(ty.name);
      if (ty.tag === "struct") for (const f of c.structs.get(ty.name)?.fields ?? []) c.dropTypesIn(f.type, out, seen);
      else for (const v of c.enums.get(ty.name)?.variants.values() ?? []) for (const f of v.fields) c.dropTypesIn(f, out, seen);
      return out;
    }
    case "vec": case "array": return c.dropTypesIn(ty.element, out, seen);
    case "heap": return c.dropTypesIn(ty.inner, out, seen);
    case "hashmap": c.dropTypesIn(ty.key, out, seen); return c.dropTypesIn(ty.value, out, seen);
    // Any closure, not just `owning` ones: auto-move can move-capture into a literal
    // whose recorded type never says so.
    case "fn": out.add("<closure-env>"); return out;
    case "interface": out.add("<interface>"); return out;
    default: return out;
  }
}

// Taking a Drop or @noCopy element out of a container by INDEX is an error, not a
// lint. The index path copies memberwise and consults neither mechanism, so both ways
// of saying "this handle has exactly one owner" were bypassed by one spelling:
// `let a = v[0]` on a `Vec<Fd>` closed the same descriptor twice, and on a `@noCopy`
// handle released it twice. The field spelling of the same operation already errors.
//
// Lives in tryMoveLeaf, the one place every by-value consumption reaches, because the
// rule used to fire only from the `let` initializer: `Option.Some(v[0])`, `peek(v[0])`,
// `return v[0]`, `s.f = v[0]` and a struct-literal field were all accepted and each
// ran the element's Drop once more. An
// element of a container is a place; reading it by value is a move-out, and for a
// resource type that is an error wherever it appears.
export function errorIfResourceIndexRead(c: TypeChecker, expr: IndexAccess, ty: TypeKind): boolean {
  const res = c.resourceKind(ty);
  if (!res) return false;
  const via = typeEq(res.via, ty) ? "" : ` (through '${c.show(res.via)}')`;
  const spelled = c.describeExpr(expr);
  const container = c.describeExpr(expr.object);
  c.error(
    `cannot take '${c.show(ty)}' out of a container by index: it carries ${res.kind}${via}`,
    expr.span,
    `indexing copies the element memberwise, so the copy and the container's own ` +
    `element would each release it. Clone it explicitly ('${spelled}.clone()'), borrow it ` +
    `('for x in ${container}', a field read '${spelled}.n', or a '&' parameter), or ` +
    `'swap'/'remove' it out so the container gives up its owner.`,
  );
  return true;
}

// The builtin spellings of the same read: `v.get(i)`/`first`/`last`, `m.get(k)`,
// `keys()`/`values()` and a container `clone()` all hand out a structural copy of an
// element, through the same codegen path `v[i]` takes, and so duplicate a resource the
// same way. `what` is the method, `container` the receiver's type for the message.
export function errorIfResourceCopyOut(c: TypeChecker, elem: TypeKind, what: string, container: string, sp: Span | undefined, borrowForm: string): boolean {
  const res = c.resourceKind(elem);
  if (!res) return false;
  const via = typeEq(res.via, elem) ? "" : ` (through '${c.show(res.via)}')`;
  c.error(`'${what}' would copy '${c.show(elem)}' out of the ${container}: it carries ${res.kind}${via}`, sp,
    `the copy is structural and never runs a Drop, so the copy and the element still in the ${container} ` +
    `would each release it. ${borrowForm}, or clone the element where its own Clone impl runs.`);
  return true;
}

// `out += piece` and `out = out + piece` in a loop: `+` allocates a fresh string the
// size of the accumulator every iteration, so the loop is quadratic. `pushStr` grows
// in place. The compound form parses to the same `out = out + piece` (parseAssign),
// so one shape check covers both; only the leftmost operand has to be the target.
export function lintStringConcatInLoop(c: TypeChecker, target: Expr, value: Expr, targetType: TypeKind, span?: Span) {
  if (c.loopDepth === 0 || targetType.tag !== "string" || !c.currentFnIsUser) return;
  if (c.warningConfig.allowed.has("string-concat-in-loop")) return;
  let leftmost = value;
  while (leftmost.kind === "BinOp" && leftmost.op === "+") leftmost = leftmost.left;
  if (leftmost === value || c.describeExpr(leftmost) !== c.describeExpr(target)) return;
  const name = c.describeExpr(target);
  c.warn("string-concat-in-loop",
    `'${name}' is rebuilt with '+' on every iteration, copying the whole accumulator each time`,
    span, `append in place: '${name}.pushStr(...)' for a string, '${name}.push(...)' for a byte`);
}

// `let x = v[i]` copies the element so the container stays intact. When nothing can
// observe the difference, codegen binds `x` to the element in place instead, the way
// `for x in v` does: `x` is never moved (a `let` is never written), nothing writes or
// moves the container's root from the binding to the end of its block, and the element
// type's clone and drop do nothing but copy and free (no Drop or hand-written Clone
// anywhere in it). The root's name is all this tracks, so a shadowing binding, a
// closure capturing it, or an `unsafe` block only ever costs the optimisation.
// Returns the root to watch, or null when the binding is not a candidate.
export function viewBindRoot(c: TypeChecker, stmt: LetDecl, hint: TypeKind | null, valType: TypeKind): string | null {
  const v = rewritten(c.rewrites, stmt.value);
  if (v.kind !== "IndexAccess" || c.closureFrames.length > 0) return null;
  if (hint && !typeEq(hint, valType)) return null;
  if (valType.tag === "ref" || c.isCopyType(valType) || !c.viewBindPure(valType, new Set())) return null;
  let objTy = c.exprTypes.get(v.object);
  if (objTy?.tag === "ref") objTy = objTy.inner;
  if (objTy?.tag !== "vec" && objTy?.tag !== "array") return null;
  const p = c.soloPath(v.object);
  if (!p) return null;
  const info = c.lookup(p.root);
  if (!info || info.isGlobal || c.globalScopeInfos.has(info) || info.nullableRef) return null;
  if (info.borrowKinds?.includes("pointer")) return null;
  // A root that views another binding (`let s = v[0..1]`) is not the container: a
  // write to `v[0]` is legal while `s` lives and is invisible to a scan for `s`.
  if (info.freezes?.length || info.refInto) return null;
  if (info.viewsAnother === true) return null;
  return p.root;
}

// Cloning and dropping a value of `t` have no effect but copying and freeing bytes.
export function viewBindPure(c: TypeChecker, t: TypeKind, seen: Set<string>): boolean {
  switch (t.tag) {
    case "int": case "float": case "bool": case "string": return true;
    case "vec": case "array": return c.viewBindPure(t.element, seen);
    case "struct": case "enum": {
      if (c.dropImpls.has(t.name) || c.handWrittenClone.has(t.name)) return false;
      if (seen.has(t.name)) return true;
      seen.add(t.name);
      if (t.tag === "struct") {
        const info = c.structs.get(t.name);
        return !!info && !info.noCopy && !info.pointerField && info.fields.every(f => c.viewBindPure(f.type, seen));
      }
      const info = c.enums.get(t.name);
      return !!info && [...info.variants.values()].every(vr => vr.fields.every(f => c.viewBindPure(f, seen)));
    }
    default: return false;
  }
}

// Decide every pending candidate in `body`, a function body just checked: by now the
// move, write and borrow sets cover every statement after each binding.
export function resolveViewBinds(c: TypeChecker, body: Stmt[]) {
  if (c.viewBindPending.size === 0) return;
  const pending = c.viewBindPending;
  c.viewBindPending = new Map();
  const captured = new Set<string>();
  const scan = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach((st, i) => {
        const ch = pending.get(st as Stmt);
        if (!ch) return;
        pending.delete(st as Stmt);
        const name = (st as LetDecl).name;
        if (!captured.has(ch.root) && !captured.has(name) && c.viewBindRegionClean(n.slice(i + 1), ch.root, name)) c.viewLets.add(st as Stmt);
        else ch.lint();
      });
    }
    for (const [k, v] of Object.entries(n)) if (k !== "span") scan(v);
  };
  // A closure anywhere in the function may run inside the region and write what it
  // captured, so a captured root (or binding) is never viewed.
  const closures = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) closures(x); return; }
    const e = n as Expr;
    if (e.kind === "Closure") for (const cap of c.closureCaptures.get(e) ?? []) captured.add(cap.name);
    for (const [k, v] of Object.entries(n)) if (k !== "span") closures(v);
  };
  closures(body);
  scan(body);
  for (const ch of pending.values()) ch.lint();
}

// Nothing in `region` writes, moves or mutably borrows a place under `root`, or moves
// any part of `name`.
export function viewBindRegionClean(c: TypeChecker, region: Stmt[], root: string, name: string): boolean {
  const roots = (e: Expr): string[] => c.placesOf(e).flatMap(p => p.tag === "path" ? [p.root] : []);
  let clean = true;
  const visit = (n: unknown): void => {
    if (!clean || !n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    const node = n as { kind?: string };
    const e = n as Expr;
    if (node.kind === "UnsafeBlock") { clean = false; return; }
    if (node.kind === "Assign" && roots((n as { target: Expr }).target).includes(root)) { clean = false; return; }
    if (node.kind === "ForInStmt" && (n as { mutRef?: boolean }).mutRef && roots((n as { iterable: Expr }).iterable).includes(root)) { clean = false; return; }
    if (typeof node.kind === "string") {
      const written = c.writtenExprs.has(e) || !!c.autoBorrowed.get(e)?.mutable || c.explicitMutArgs.has(e) || c.matchSubjectMut.has(e);
      // Moving an element out of a container clones it, so only a binding or a field moves.
      const moved = (e.kind === "Ident" || e.kind === "FieldAccess") && c.movedExprs.has(e);
      if (written || moved) {
        const rs = roots(e);
        if (rs.includes(root) || (moved && rs.includes(name))) { clean = false; return; }
      }
    }
    for (const [k, v] of Object.entries(n)) if (k !== "span") visit(v);
  };
  visit(region);
  return clean;
}

export function lintIndexClone(c: TypeChecker, slot: Expr, ty: TypeKind, span?: Span) {
  const value = rewritten(c.rewrites, slot);
  // A resource element is rejected by tryMoveLeaf, which every caller of this lint
  // reaches next; the cost warning below would only pile onto that error.
  if (value.kind === "IndexAccess" && ty.tag !== "ref" && c.resourceKind(ty)) return;
  // The cost warning below is advisory, and a warning inside std/ or a dependency is
  // not actionable by the person reading it (dapweb builds warned on std/argparse's
  // own argv loop). Same scoping as unused-unsafe; the Drop/@noCopy error above
  // stays everywhere because that one is a double release, not a cost.
  if (!c.currentFnIsUser) return;
  if (c.warningConfig.allowed.has("index-clone")) return;
  // Fork tails count: `if c { v[0] } else { v[1] }` clones whichever arm runs, and the
  // reader has no more reason to expect an allocation there than in the direct form.
  // moveTargets already knows where a value actually comes from, so reuse it rather
  // than re-deriving the tail rules here.
  if (value.kind === "IfExpr" || value.kind === "MatchExpr") {
    for (const slotTail of c.moveTargets(value)) {
      const t = rewritten(c.rewrites, slotTail);
      c.lintIndexClone(t, ty, t.span ?? span);
    }
    return;
  }
  if (value.kind !== "IndexAccess") return;
  // Copy elements are a register move, not an allocation — nothing to warn about.
  if (c.isCopyType(ty)) return;
  // A ref binding (`let r: &T = ...`) borrows rather than clones.
  if (ty.tag === "ref") return;
  // A string element is shared by count (see sharedStringExprs), not copied.
  if (ty.tag === "string") return;
  c.warn(
    "index-clone",
    `this deep-copies the ${c.show(ty)} out of the container`,
    span,
    `indexing clones so the container stays intact; 'for x in <container>' binds by reference and copies nothing, and a field read ('v[i].n') materialises no element`,
  );
}

// Whether a function name belongs to the user's own file. Mangled names cover
// monomorphized user fns (`foo$i32`) and impl methods (`Type$method`,
// `Type$Trait$method` — matched against userImplKeys `Type.method`).
// No resolver info (direct TypeChecker use in tests/tools) → treat all as user.
export function fnIsUserCode(c: TypeChecker, name: string): boolean {
  if (!c._userFnNames) return true;
  if (c._userFnNames.has(name)) return true;
  // Per-package mangling (src/mangle.ts) prefixes a dependency's symbols with
  // `<pkg>$`, so `http2$foo` and `http2$Box_i64$get` reach here. The `$` split
  // below assumes the first segment is a type-or-fn name, so a package prefix
  // makes both lookups miss — and mis-classifying dependency code as user code
  // (or vice versa) would point `unused-unsafe` at the wrong files entirely.
  // Only dep files are ever mangled, so a known package prefix settles it: not
  // user code. Empty when the program has no deps, i.e. a no-op by default.
  const firstSep = name.indexOf("$");
  if (firstSep > 0 && (c._packageNames !== undefined && c._packageNames.has(name.slice(0, firstSep)))) return false;
  const parts = name.split("$");
  if (parts.length > 1) {
    if (c._userFnNames.has(parts[0])) return true;
    if ((c._userImplKeys !== undefined && c._userImplKeys.has(`${parts[0]}.${parts[parts.length - 1]}`))) return true;
  }
  return false;
}

// An operation that requires unsafe: error if outside a block, else mark the
// innermost live block used (feeds the unused-unsafe lint).
export function requireUnsafe(c: TypeChecker, msg: string, span?: Span, hint?: string) {
  if (c.unsafeDepth === 0) {
    c.error(msg, span, hint);
  } else if (c.unsafeUsedStack.length > 0) {
    c.unsafeUsedStack[c.unsafeUsedStack.length - 1] = true;
  }
}

// `@unsafe fn`: the callee carries a contract the compiler cannot check, so the
// obligation lands on the CALLER. Every other unsafe rule triggers on an operation
// (a deref, a pointer cast); this one exists because a function can be built
// entirely out of individually checkable operations and still be unsound to call
// with the wrong arguments, which is exactly the shape of a foreign-memory view.
// The display name of a call's callee when it is `@mustUse`, else null. A generic fn is
// looked up on its template; a method on the mangled name checkExpr resolved it to.
export function mustUseCallee(c: TypeChecker, slot: Expr): string | null {
  const e = rewritten(c.rewrites, slot);
  if (e.kind === "Call") {
    if (c.functions.get(e.func)?.mustUse || mustUseOf(c.genericFns.get(e.func)?.decl).mustUse) return e.func;
    return null;
  }
  if (e.kind === "MethodCall") {
    const mangled = c.resolvedMethods.get(e);
    if (mangled && c.functions.get(mangled)?.mustUse) {
      // Named as the reader wrote it (`Arena<i32>.valid`), not by the mangled instance.
      const objType = c.exprTypes.get(e.object);
      return `${objType ? c.show(objType) : mangled.split("$")[0]}.${e.method}`;
    }
  }
  return null;
}

// extern-call: an extern the signature rule above lets through (scalars,
// auto-coerced strings) still runs C code that can break invariants the checker is
// relying on elsewhere: `close(fd)` on an fd a TcpStream still owns compiles clean and
// leaves the stream writing to a closed or reused descriptor. Every extern call is meant
// to sit inside `unsafe` (std wraps the harmless ones in safe pub fns), staged as a
// warning so existing programs get a cycle to migrate.
//
// A `@pure` extern whose params and return are all scalars is exempt: purity (reads
// only its arguments, no effects) is a stronger claim than this rule asks for, the
// purity pass already trusts it, and a `@pure` caller may not contain `unsafe` at all,
// so Math.sqrt could not call libm. The claim is taken on trust, so it only buys the
// exemption where nothing can go wrong if it is false: a `@pure` extern handed a
// pointer (a string or array coerced to `*T`) can write through it like any other.
//
// Not reported inside a manifest dependency: the reader cannot edit it. std IS
// reported, because std is where the wrappers live and it is held to zero.
export function noteSafeExternCall(c: TypeChecker, name: string, attrs: { name: string }[] | undefined, allScalar: boolean, span?: Span) {
  if (allScalar && attrs?.some(a => a.name === "pure")) return;
  if (c.unsafeDepth > 0) {
    if (c.unsafeUsedStack.length > 0) c.unsafeUsedStack[c.unsafeUsedStack.length - 1] = true;
    return;
  }
  if (c.currentFnIsDep) return;
  c.warn("extern-call", `calling extern function '${name}' outside an 'unsafe' block`, span,
    `wrap the call in 'unsafe { ... }', or call the std function that wraps it`);
}

// Record/replay: send this extern call through its generated wrapper, which records it
// under MILO_RECORD and answers it under MILO_REPLAY, or, for an extern that cannot be
// recorded, reports the hole at run time (and here, as `replay-hole`, when asked).
// Calls inside a `@replayHooked` fn (std's own recording wrappers) stay direct.
export function redirectForReplay(c: TypeChecker, expr: Expr & { kind: "Call" }, sp: Span | undefined) {
  const plan = c.replayPlans?.get(expr.func);
  if (!plan || c.currentFnReplayHooked) return;
  if (plan.hole) {
    c.warn("replay-hole", `'${expr.func}' is not recorded under MILO_RECORD: ${plan.hole}`, sp,
      `describe what it writes with @records("buf[len]") on its extern declaration, or call the std function that wraps it`);
  }
  let wrapper = plan.wrapper;
  if (plan.variadic) {
    wrapper = `${plan.wrapper}_${expr.args.length}`;
    // The tail is widened to i64; a float there would change bits, so leave it direct.
    for (let i = plan.fixed; i < expr.args.length; i++) {
      const t = c.exprTypes.get(expr.args[i]);
      if (!t || (t.tag !== "int" && t.tag !== "ptr" && t.tag !== "bool")) return;
    }
  }
  if (!c.functions.has(wrapper)) return;
  // Kept out of rewrittenCalls on purpose: every other pass (purity, the thread
  // boundary, call graphs) should keep seeing the extern the program wrote.
  c.replaySites.set(expr, { wrapper, site: replaySite(sp ?? expr.span, STDLIB_DIR, process.cwd()), ...(plan.variadic && { fixed: plan.fixed }) });
}

// Manifest deps are the only mangled code, so a `<pkg>$` prefix settles it.
export function fnIsDependencyCode(c: TypeChecker, name: string): boolean {
  const firstSep = name.indexOf("$");
  return firstSep > 0 && !!(c._packageNames !== undefined && c._packageNames.has(name.slice(0, firstSep)));
}

// `@unsafe` on a method: the same obligation as on a free fn. Keyed by the mangled
// symbol the call resolved to, so `T.make()` and `x.raw()` share one check.
export function requireUnsafeMethod(c: TypeChecker, mangled: string, name: string, span?: Span) {
  if (!c.unsafeMethods.has(mangled)) return;
  c.requireUnsafe(`calling '${name}' requires an unsafe block`, span,
    `'${name}' is declared '@unsafe': it has a precondition the compiler cannot check, so the caller vouches for it`);
}

export function requireUnsafeCall(c: TypeChecker, decl: { attributes?: { name: string }[] } | undefined, name: string, span?: Span) {
  if (!decl?.attributes?.some(a => a.name === "unsafe")) return;
  c.requireUnsafe(`calling '${name}' requires an unsafe block`, span,
    `'${name}' is declared '@unsafe': it has a precondition the compiler cannot check, so the caller vouches for it`);
}

// compute the output range of an arithmetic operation on two ranged integers
export function propagateRange(lt: TypeKind & { tag: "int" }, rt: TypeKind & { tag: "int" }, op: string): TypeKind | null {
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
  // A result range past the width means the op can overflow. Clamping it would claim
  // a range a @wrapping fn (or --no-overflow-checks) does not honour, since the value
  // wraps instead of trapping; no range at all is the claim that holds in every mode.
  const typMin = lt.signed ? -(2 ** (lt.bits - 1)) : 0;
  const typMax = lt.signed ? 2 ** (lt.bits - 1) - 1 : 2 ** lt.bits - 1;
  if (outMin < typMin || outMax > typMax || !Number.isSafeInteger(outMin) || !Number.isSafeInteger(outMax)) return null;
  return { tag: "int", bits: lt.bits, signed: lt.signed, min: outMin, max: outMax };
}

// The value of an all-literal integer expression (`2147483646 + 1`), or null. Only the
// operators whose result does not depend on the width; a fold that would need the
// width to be exact (a shift, a division by zero) gives up and leaves a runtime check.
export function foldConstInt(c: TypeChecker, e: Expr): bigint | null {
  if (e.kind === "IntLit") return e.value;
  if (e.kind === "UnaryOp" && e.op === "-") { const v = c.foldConstInt(e.operand); return v === null ? null : -v; }
  if (e.kind !== "BinOp") return null;
  const l = c.foldConstInt(e.left), r = c.foldConstInt(e.right);
  if (l === null || r === null) return null;
  switch (e.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    default: return null;
  }
}

// extract a constant integer value from an expression (handles IntLit and -IntLit)
export function constIntValue(expr: import("./ast").Expr): bigint | null {
  if (expr.kind === "IntLit") return expr.value;
  if (expr.kind === "UnaryOp" && expr.op === "-" && expr.operand.kind === "IntLit") return -expr.operand.value;
  return null;
}

// Enforce a ranged integer target (`i32(0..100)`) against a value flowing into it — at a
// let/var, a call argument, a `return`, or a reassignment. A const literal out of range is
// a compile error; a value whose propagated range already fits needs no check; otherwise a
// runtime range check is emitted (via rangeCheckedExprs). Without this the range was
// enforced at declarations only, so `f(500)` into an `i32(0..100)` param silently passed.
export function enforceRangeInto(c: TypeChecker, valueExpr: Expr, valType: TypeKind, target: TypeKind, sp?: Span) {
  if (target.tag !== "int" || target.min === undefined || target.max === undefined) return;
  const litVal = c.foldConstInt(valueExpr);
  if (litVal !== null) {
    if (litVal < BigInt(target.min) || litVal > BigInt(target.max)) {
      c.error(`value ${litVal} is out of range for ${c.show(target)} (${target.min}..${target.max})`, sp);
    }
  } else if (c.isConstIntExpr(valueExpr)) {
    // A constant this fold cannot evaluate (`0x7fffffff | 0`): callers type a retyped
    // constant as its target, so its type proves nothing. Check it at run time.
    c.rangeCheckedExprs.set(valueExpr, { min: target.min, max: target.max, typeName: typeName(target) });
  } else if (valType.tag === "int" && valType.min !== undefined && valType.max !== undefined &&
             valType.min >= target.min && valType.max <= target.max) {
    // range propagation proved the value fits — no runtime check needed
  } else {
    c.rangeCheckedExprs.set(valueExpr, { min: target.min, max: target.max, typeName: typeName(target) });
  }
}

// A call argument against its parameter. By value it is a flow, checked like any other
// (`enforceRangeInto`). By reference nothing flows, so the ranges themselves must agree:
// a `&R` param fed an unranged int would read an unchecked value as in-range, and a
// `&mut` either way lets one side write what the other side's range forbids.
export function enforceArgRange(c: TypeChecker, arg: Expr, argType: TypeKind, paramType: TypeKind, sp?: Span) {
  if (paramType.tag !== "ref") {
    if (paramType.tag === "int") c.enforceRangeInto(arg, argType, paramType, sp);
    return;
  }
  const want = paramType.inner;
  const got = argType.tag === "ref" ? argType.inner : argType;
  if (want.tag !== "int" || got.tag !== "int") return;
  if (want.min === undefined && got.min === undefined) return;
  const fits = paramType.mutable
    ? want.min === got.min && want.max === got.max
    : want.min === undefined || (got.min !== undefined && got.min >= want.min && got.max! <= want.max!);
  if (!fits) {
    c.error(`a ${c.show(paramType)} parameter cannot borrow a ${c.show(got)}: the ranges must ${paramType.mutable ? "match" : "fit"}, since a borrow is not range-checked`, sp,
      `copy the value into a binding of type ${c.show(want)} first (that copy is checked)`);
  }
}

// `T` auto-wrapped into `Option<T>`: the value flows into the payload, so a ranged
// payload checks it. Lowering applies the check to the value before the Some wrap.
export function enforceWrapRange(c: TypeChecker, expr: Expr) {
  const opt = c.autoWrappedOption.get(expr);
  const inner = opt ? c.optionInnerType({ tag: "enum", name: opt }) : null;
  const valType = c.exprTypes.get(expr);
  if (inner?.tag === "int" && valType) c.enforceRangeInto(expr, valType, inner, expr.span);
}

export function constFloatValue(expr: import("./ast").Expr): number | null {
  if (expr.kind === "FloatLit") return expr.value;
  if (expr.kind === "UnaryOp" && expr.op === "-" && expr.operand.kind === "FloatLit") return -expr.operand.value;
  return null;
}

export function constNumericValue(c: TypeChecker, expr: import("./ast").Expr): number | null {
  // narrows to a JS number for float/contract-eval callers — fine for the
  // magnitudes those use; exact 64-bit checks go through constIntValue.
  const iv = c.constIntValue(expr);
  if (iv !== null) return Number(iv);
  return c.constFloatValue(expr);
}

// Evaluate a contract expression with argument substitutions. Returns true/false/null.
export function tryEvalContractExpr(c: TypeChecker, expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>): boolean | null {
  if (expr.kind === "BoolLit") return expr.value;

  if (expr.kind === "IntLit" || expr.kind === "FloatLit") return null;

  if (expr.kind === "Ident") {
    const sub = subs.get(expr.name);
    if (sub) return c.tryEvalContractExpr(sub, new Map());
    return null;
  }

  if (expr.kind === "UnaryOp" && expr.op === "!") {
    const inner = c.tryEvalContractExpr(expr.operand, subs);
    return inner !== null ? !inner : null;
  }

  if (expr.kind === "BinOp") {
    // short-circuit logic
    if (expr.op === "&&") {
      const l = c.tryEvalContractExpr(expr.left, subs);
      if (l === false) return false;
      const r = c.tryEvalContractExpr(expr.right, subs);
      if (r === false) return false;
      if (l === true && r === true) return true;
      return null;
    }
    if (expr.op === "||") {
      const l = c.tryEvalContractExpr(expr.left, subs);
      if (l === true) return true;
      const r = c.tryEvalContractExpr(expr.right, subs);
      if (r === true) return true;
      if (l === false && r === false) return false;
      return null;
    }

    // numeric comparisons — resolve through substitutions
    const lVal = c.resolveNumericValue(expr.left, subs);
    const rVal = c.resolveNumericValue(expr.right, subs);
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
export function resolveNumericValue(c: TypeChecker, expr: import("./ast").Expr, subs: Map<string, import("./ast").Expr>): number | null {
  if (expr.kind === "Ident") {
    const sub = subs.get(expr.name);
    if (sub) return c.constNumericValue(sub);
    return null;
  }
  if (expr.kind === "FieldAccess" && expr.field === "len" && expr.object.kind === "Ident") {
    const sub = subs.get(expr.object.name);
    if (sub?.kind === "StringLit") return sub.value.length;
    return null;
  }
  return c.constNumericValue(expr);
}

export function checkCallSiteContracts(c: TypeChecker, fnDecl: import("./ast").Function, args: import("./ast").Expr[], callSpan?: import("./ast").Span) {
  if (!fnDecl.contracts || fnDecl.contracts.length === 0) return;
  const subs = new Map<string, import("./ast").Expr>();
  for (let i = 0; i < Math.min(fnDecl.params.length, args.length); i++) {
    subs.set(fnDecl.params[i].name, args[i]);
  }
  for (const ch of fnDecl.contracts) {
    if (ch.kind !== "requires") continue;
    const result = c.tryEvalContractExpr(ch.expr, subs);
    if (result === false) {
      const contractSrc = c.contractExprToString(ch.expr);
      c.error(`requires clause '${contractSrc}' violated`, callSpan);
    }
  }
}

// A `decreases` measure is an integer that must fall toward zero, so it is the one clause
// that is not a boolean claim.
export function checkContractClause(c: TypeChecker, ch: import("./ast").Contract): void {
  for (const attr of ch.attributes ?? []) {
    const bad = attr.name === "req" ? traceAttrError(attr, "clause") : `only '@req(ID)' goes before a ${ch.kind} clause`;
    if (bad) c.error(`'@${attr.name}' on a ${ch.kind} clause: ${bad}`, ch.span);
  }
  const prev = c.contractScope;
  c.contractScope = ch.kind;
  const cType = c.checkExpr(ch.expr);
  c.contractScope = prev;
  if (cType.tag === "unknown") return;
  if (ch.kind === "decreases") {
    if (cType.tag !== "int") {
      c.error(`decreases clause must be an integer measure, got ${c.show(cType)}`, ch.span,
        `it is the quantity that must strictly fall on every recursive call or iteration`);
    }
    return;
  }
  if (cType.tag !== "bool") {
    c.error(`${ch.kind} clause must be bool, got ${c.show(cType)}`, ch.span);
  } else if (c.isTrivialClause(ch.expr) && !c.vacuousSeen.has(ch)) {
    c.vacuousSeen.add(ch);
    c.warn("vacuous-contract", `this ${ch.kind} clause is true for every input, so it says nothing: ${c.contractExprToString(ch.expr)}`, ch.span,
      `state something about the result or the inputs, or delete the clause; a requirement traced to a clause that proves itself is not formalized`);
  }
}

// True only when the clause holds with NO assumption about its variables, found by
// structure, not by the solver: a comparison of an expression with itself, `true`, a
// constant comparison, `a || !a`. Floats are skipped (`x == x` is false for NaN), and an
// operand the checker cannot cheaply type (a field, a call) is skipped too, so the
// warning never fires on a clause that says something.
export function isTrivialClause(c: TypeChecker, e: import("./ast").Expr): boolean {
  const simple = (x: import("./ast").Expr): boolean => {
    // ident-ok: a contract clause names a whole variable to ask its type (is it a float?);
    // there is no place resolution or alias question here
    if (x.kind === "Ident") {
      const t = c.lookup(x.name)?.type;
      return !!t && t.tag !== "float" && t.tag !== "unknown";
    }
    if (x.kind === "IntLit") return true;
    if (x.kind === "BinOp" && ["+", "-", "*"].includes(x.op)) return simple(x.left) && simple(x.right);
    return false;
  };
  const strip = (_k: string, v: unknown) => (_k === "span" ? undefined : typeof v === "bigint" ? `${v}n` : v);
  const same = (a: import("./ast").Expr, b: import("./ast").Expr) => JSON.stringify(a, strip) === JSON.stringify(b, strip);
  if (e.kind === "BoolLit") return e.value === true;
  if (e.kind !== "BinOp") return false;
  if (e.op === "&&") return c.isTrivialClause(e.left) && c.isTrivialClause(e.right);
  if (e.op === "||") {
    if (c.isTrivialClause(e.left) || c.isTrivialClause(e.right)) return true;
    const neg = (a: import("./ast").Expr, b: import("./ast").Expr) => b.kind === "UnaryOp" && b.op === "!" && same(a, b.operand);
    return neg(e.left, e.right) || neg(e.right, e.left);
  }
  if (e.left.kind === "IntLit" && e.right.kind === "IntLit") {
    const a = BigInt(e.left.value as any), b = BigInt(e.right.value as any);
    if (e.op === "<") return a < b;
    if (e.op === ">") return a > b;
    if (e.op === "!=") return a !== b;
    if (e.op === "<=") return a <= b;
    if (e.op === ">=") return a >= b;
    if (e.op === "==") return a === b;
    return false;
  }
  if (["==", "<=", ">="].includes(e.op)) return simple(e.left) && simple(e.right) && same(e.left, e.right);
  return false;
}

// Reconstruct a readable string from a contract expression
export function contractExprToString(c: TypeChecker, expr: import("./ast").Expr): string {
  if (expr.kind === "Ident") return expr.name;
  if (expr.kind === "IntLit") return String(expr.value);
  if (expr.kind === "FloatLit") return expr.value % 1 === 0 ? expr.value.toFixed(1) : String(expr.value);
  if (expr.kind === "BoolLit") return String(expr.value);
  if (expr.kind === "FieldAccess") return `${c.contractExprToString(expr.object)}.${expr.field}`;
  if (expr.kind === "UnaryOp") return `${expr.op}${c.contractExprToString(expr.operand)}`;
  if (expr.kind === "BinOp") return `${c.contractExprToString(expr.left)} ${expr.op} ${c.contractExprToString(expr.right)}`;
  if (expr.kind === "CastExpr") return `${c.contractExprToString(expr.operand)} as ${expr.targetType.name}`;
  return "...";
}

export function checkConstOverflow(c: TypeChecker, lv: bigint, rv: bigint, op: string, ty: TypeKind, span?: Span) {
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
    c.error(`constant expression '${lv} ${op} ${rv}' overflows ${signed ? "i" : "u"}${bits} (result: ${result}, range ${min}..${max})`, span);
  }
}
