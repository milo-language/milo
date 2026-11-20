// Helpers shared by checker.ts and the checker-*.ts files that hold its methods.
import type { Attribute, Expr, MiloType, Pattern, Span } from "./ast";
import type { Place, PlaceStep } from "./checker";
import { STDLIB_DIR } from "./stdlibBundle";
import type { TypeKind } from "./types";
import type { WarningConfig } from "./diagnostics";
import { basename, dirname, relative, sep } from "path";

export const spanKey = (sp: Span): string => `${sp.file ?? ""}:${sp.line}:${sp.col}`;

// Type names the checker builds in rather than reading from a declaration.
export const BUILTIN_GENERIC_TYPE_NAMES = ["Vec", "HashMap", "Heap", "Option", "Result"] as const;

// The reads a `doc[...]` chain ends in, and the std/json method each one calls.
export const JSON_CHAIN_READS: Record<string, string> = {
  str: "idxStr", f64: "idxF64", i64: "idxI64", bool: "idxBool", len: "idxLen", kind: "idxKind",
  exists: "idxExists", raw: "idxRaw", json: "idxJson", items: "idxItems", keys: "idxKeys", valueAt: "idxValueAt",
};

export const RAW_SLICE_INTRINSICS: ReadonlySet<string> = new Set(["rawSlice", "rawSliceMut"]);

// The ownership constructors for foreign memory: the return leg of `forget`. Same file
// seam and the same reason: an unchecked claim about a pointer's provenance belongs in
// one reviewed module, not in every caller.
export const ADOPT_INTRINSICS: ReadonlySet<string> = new Set(["adoptHeap", "adoptVec"]);

export const FOREIGN_MODULE = "std/foreign.milo";

// The intrinsic file gates key on a path SUFFIX, and on Windows the resolver hands back
// `D:\a\milo\std\foreign.milo`, which does not end with "std/foreign.milo". Every
// std/foreign fixture therefore failed to compile there with "undefined function
// 'adoptHeap'" while the whole macOS and Linux lane stayed green: the gate was not merely
// wrong on Windows, it silently removed the feature. Compare on posix separators.
// Windows hands back `std\arena.milo`, so any rule that recognises a module by its path
// has to normalise first. `lintArenaNeverFrees` skips the module that IMPLEMENTS the
// pattern it warns about; without this it stopped skipping on Windows and warned inside
// std, where the reader cannot act on it.
export function inModule(file: string | undefined, module: string): boolean {
  return !!file && file.replace(/\\/g, "/").includes(module);
}

// A file path as a diagnostic names it: `std/seal.milo` for the stdlib, cwd-relative
// for a project file, basename when neither applies.
export function displayPath(file: string): string {
  const norm = (p: string) => p.split(sep).join("/");
  const root = STDLIB_DIR + sep;
  if (file.startsWith(root)) return norm(file.slice(root.length));
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? norm(rel) : basename(file);
}

// The import path that names `declFile` from inside `refFile`: `std/os` for the stdlib
// (a platform suffix such as `.darwin` is not part of the path), otherwise relative to
// the importing file, which is what a non-std import path means. Written so a tool can
// paste it straight into an import line (src/fixes.ts does).
export function importPathFrom(refFile: string, declFile: string): string {
  const norm = (p: string) => p.split(sep).join("/");
  const stripExt = (p: string) => p.replace(/\.(darwin|linux|windows|none|wasm)\.milo$|\.milo$/, "");
  // STDLIB_DIR is the directory holding `std/`, so a sibling `examples/` file is under
  // it too; only the `std/` subtree gets the bare path.
  const root = STDLIB_DIR + sep;
  if (declFile.startsWith(root + "std" + sep)) return stripExt(norm(declFile.slice(root.length)));
  const rel = norm(relative(dirname(refFile), declFile));
  return stripExt(rel.startsWith(".") ? rel : `./${rel}`);
}

// Substitute a generic alias's arguments into its body, at the AST level rather than on
// resolved types: the body may name types that are not registered yet (an alias is
// registered before the enums it mentions), which is the same reason the alias table
// stores AST in the first place.
//
// The use site's own wrappers compose with the parameter's: in `type Slot<T> = *T` used as
// `Slot<Point>`, the `*` comes from the body and the name from the argument, while in
// `Handler<&Point>` the `&` comes from the argument. Both have to survive, so the two are
// merged rather than one overwriting the other.
// A type parameter use site `ty` (`&T`, `*T`, `[T]`) with `sub` for T. The use site's
// ref/pointer/array wrappers stay: `&T` must become `&P`, not a by-value `P` (a generic fn
// taking `&T` was passed a struct where a ptr was expected), and `&[T]` must stay a slice.
// A use site without an array of its own keeps the argument's: `*T` with T = [i64; 2] is
// `*[i64; 2]`. Taking the use site's array flags unconditionally made it `*i64`, so std's
// vecWithCapacity sized a Vec<[i64; 2]> buffer at 8 bytes a slot and map<U> wrote past it.
export function wrapTypeArg(ty: MiloType, sub: MiloType): MiloType {
  if (!(ty.isRef || ty.isRefMut || ty.isPtr || ty.isArray)) return sub;
  const keepSubArray = !ty.isArray && sub.isArray;
  return {
    ...sub,
    isRef: ty.isRef, isRefMut: ty.isRefMut, isPtr: ty.isPtr, ptrDepth: ty.ptrDepth,
    isArray: keepSubArray || ty.isArray, arraySize: keepSubArray ? sub.arraySize : ty.arraySize,
  };
}

export function substituteAliasType(body: MiloType, subst: ReadonlyMap<string, MiloType>): MiloType {
  const arg = !body.isFn && !body.typeArgs?.length ? subst.get(body.name) : undefined;
  if (arg) {
    const ptrDepth = (body.ptrDepth ?? (body.isPtr ? 1 : 0)) + (arg.ptrDepth ?? (arg.isPtr ? 1 : 0));
    return {
      ...arg,
      isPtr: ptrDepth > 0,
      ...(ptrDepth > 0 ? { ptrDepth } : {}),
      isRef: body.isRef || arg.isRef,
      isRefMut: body.isRefMut || arg.isRefMut,
      // `[T]` in the body wraps whatever T turns out to be; an array argument keeps its own.
      isArray: body.isArray || arg.isArray,
      arraySize: body.isArray ? body.arraySize : arg.arraySize,
    };
  }
  return {
    ...body,
    ...(body.typeArgs ? { typeArgs: body.typeArgs.map(t => substituteAliasType(t, subst)) } : {}),
    ...(body.fnParams ? { fnParams: body.fnParams.map(t => substituteAliasType(t, subst)) } : {}),
    ...(body.fnRet ? { fnRet: substituteAliasType(body.fnRet, subst) } : {}),
  };
}

// std/hashmap's hashing and key comparison, the same code the builtin HashMap emits, so a
// method moved into std hashes and matches keys exactly as the ones still in codegen do.
export const MAP_INTRINSICS: ReadonlySet<string> = new Set(["_mapHash", "_mapKeyEq", "_mapCopyOut", "_mapSeed", "_mapAlloc"]);

export function isHashMapModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  return posix === "std/hashmap.milo" || posix.endsWith("/std/hashmap.milo");
}

// std/vec's natural order, `_natLess(a, b)`: the comparison the builtin min/max/sort emit,
// including `false < true`, which the language's `<` does not have on bool.
// `_vecPanic("msg")` prints "msg at file:line:col" and aborts, the wording of the
// builtins' own bounds panics (remove, insert), which a plain panic() would not keep.
// `_vecCopyOut(place)` is _mapCopyOut under its std/vec name: the one structural copy.
// `_vecGrowBuf(data, len, cap): *T` moves a full buffer of `len` elements to one of `cap`
// (the checked allocation push used); `_vecNonNegative(n)` is n after
// the "negative capacity" check, at the caller's line under @trackCaller.
// `_vecForget(x)` is `forget(x)`, which a user fn named forget would shadow in std.
export const VEC_INTRINSICS: ReadonlySet<string> = new Set(["_natLess", "_vecPanic", "_vecCopyOut", "_vecGrowBuf", "_vecNonNegative", "_vecForget"]);

export function isVecModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  return posix === "std/vec.milo" || posix.endsWith("/std/vec.milo");
}

// std/string's `_strRangeCheck(s, start, end)`: the builtin substr's range panic,
// "substr range out of bounds: a..b (len n) at file:line:col".
// `_strReserve(&mut s, extra): *u8` is s's data pointer with room for `extra` more bytes and
// the NUL, held by s alone (the builtin push's inline fast path, else rtStrReserveSlow);
// `_strUnique(&mut s)` makes s the only handle to its buffer (rtStrUnique), so the
// count logic stays in std/rt.milo; `_strAlloc(n): *u8` is a checked n-byte buffer
// with its count word; `_strPanic("head", n, "tail")` is truncate's formatted panic.
export const STR_INTRINSICS: ReadonlySet<string> = new Set(["_strRangeCheck", "_strReserve", "_strUnique", "_strAlloc", "_strPanic"]);

export function isStringModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  return posix === "std/string.milo" || posix.endsWith("/std/string.milo");
}

// std/vec methods taking a callback over the elements; see the dispatch in the Vec chain.
export const VEC_CALLBACK_METHODS: ReadonlySet<string> = new Set(["each", "enumerate", "any", "all", "position", "find", "fold", "reduce"]);

// The std modules that hold builtin collections' method bodies. They replaced code codegen
// emitted inline and may use the std-only machinery that implies (`@inline`, the `@pure`
// exemption). Anchored on a separator like isForeignModule, so "notstd/vec.milo" is not one.
export const STD_COLLECTION_MODULES: readonly string[] = ["std/hashmap.milo", "std/vec.milo", "std/string.milo", "std/rt.milo"];

export function isStdCollectionModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  return STD_COLLECTION_MODULES.some(m => posix === m || posix.endsWith(`/${m}`));
}

export function isForeignModule(file: string | undefined): boolean {
  if (!file) return false;
  const posix = file.replace(/\\/g, "/");
  // Anchored on a separator, so a directory that merely ENDS in "std" (".../notstd/
  // foreign.milo") is not the module. A bare suffix test accepted that.
  return posix === FOREIGN_MODULE || posix.endsWith(`/${FOREIGN_MODULE}`);
}

export const VALUE: Place = { tag: "value" };

export const OPAQUE: Place = { tag: "opaque" };

export const INDEX: PlaceStep = { tag: "index" };

export const DEREF: PlaceStep = { tag: "deref" };

export const PAYLOAD: PlaceStep = { tag: "payload" };

// Printable key for a step, and the spelling the older string-keyed callers use:
// a field is ".name", everything else collapses to one opaque token per kind.
export function stepKey(s: PlaceStep): string {
  switch (s.tag) {
    case "field": return `.${s.name}`;
    case "index": return "[]";
    case "deref": return "*";
    case "payload": return "!";
  }
}

// `a` or `a.b.c`: reading it evaluates nothing, so it may be type-checked out of order.
export function isFieldChain(e: Expr): boolean {
  while (e.kind === "FieldAccess") e = e.object;
  // ident-ok: the root of a syntactic field chain, before any place resolution
  return e.kind === "Ident";
}

export function stepsEq(a: PlaceStep[], b: PlaceStep[]): boolean {
  return a.length === b.length && a.every((s, i) => stepKey(s) === stepKey(b[i]));
}

// How a step reads in a diagnostic, where an index has to look like source.
export function stepLabel(s: PlaceStep): string {
  return s.tag === "index" ? "[…]" : stepKey(s);
}

// One path a prefix of the other: the places overlap.
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return false;
  return true;
}

// The `mustUse` field of an FnSig, from the declaration's attributes. Spread into every
// registration so a method and a monomorphized generic carry it like a plain fn.
export function isUnsafeDecl(decl: { attributes?: { name: string }[] } | undefined): boolean {
  return !!decl?.attributes?.some(a => a.name === "unsafe");
}

export function mustUseOf(decl: { attributes?: { name: string }[] } | undefined): { mustUse?: boolean } {
  return decl?.attributes?.some(a => a.name === "mustUse") ? { mustUse: true } : {};
}

// `@cName("type")` on an extern struct field: the C spelling @cLayout checks it under.
// Only a well-formed argument is carried; a malformed one is reported by
// validateFieldAttributes and must not reach the guard TU as C source.
export function cNameOf(f: { attributes?: Attribute[] }): { cName?: string } {
  const a = f.attributes?.find(x => x.name === "cName");
  const n = a?.args.length === 1 && a.argKinds?.[0] === "string" ? a.args[0] : undefined;
  return n !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? { cName: n } : {};
}

// Whether a user (or imported) fn named `name` takes the call instead of the builtin of
// that name (`swap`, `replace`, `forget`, `isNull`, `old`). The one predicate every such
// guard asks, in the checker and in lower.ts: the guards used to test `functions` alone,
// and a GENERIC fn lives only in the generic table, so `fn swap<A, B>(p: Pair<A, B>)`
// was silently replaced by the builtin (backlog #46). Imported fns are in the same two
// tables after the resolver's merge, so they need no third source.
export function userFnShadowsBuiltin(
  name: string,
  tables: { functions: { has(name: string): boolean }; genericFns: { has(name: string): boolean } },
): boolean {
  return tables.functions.has(name) || tables.genericFns.has(name);
}

// The first field whose type is a raw pointer, directly or through a fixed array. A struct
// field of a pointer-holding struct is not reported here: that inner struct is itself
// move-tracked (or `@copy`), and the ordinary all-fields-Copy rule carries the verdict up.
export function rawPointerField(fields: { name: string; type: TypeKind }[]): string | undefined {
  return fields.find(f => holdsRawPtr(f.type))?.name;
}

// The enum form of rawPointerField: the first variant whose payload holds a raw pointer.
export function rawPointerVariant(variants: Map<string, { fields: TypeKind[] }>): string | undefined {
  for (const [name, v] of variants) if (v.fields.some(holdsRawPtr)) return name;
  return undefined;
}

export function holdsRawPtr(t: TypeKind): boolean {
  return t.tag === "ptr" || (t.tag === "array" && holdsRawPtr(t.element));
}

// The result of an operator on a ranged int keeps its width, not its range (`r | 1`,
// `-r`, `r * k` can all leave it); only range propagation, which computes the result's
// range from both operands', may hand a range back.
export function unranged(t: TypeKind): TypeKind {
  return t.tag === "int" && t.min !== undefined ? { tag: "int", bits: t.bits, signed: t.signed } : t;
}

// The type of a value that is one of two branches: a range only if both have one.
export function joinRanges(a: TypeKind, b: TypeKind): TypeKind {
  if (a.tag !== "int" || b.tag !== "int") return a;
  if (a.min === undefined || a.max === undefined || b.min === undefined || b.max === undefined) return unranged(a);
  if (a.min === b.min && a.max === b.max) return a;
  return { tag: "int", bits: a.bits, signed: a.signed, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
}

// The expression to read where the tree holds `e`: the checker's replacement for it when there is one. A
// replacement can itself be replaced, hence the loop. Every other table of a CheckResult is keyed by the
// node this returns, never by the node it stands in for.
export function rewritten(rewrites: Map<Expr, Expr>, e: Expr): Expr {
  let cur = e;
  let more = true;
  while (more) {
    const next = rewrites.get(cur);
    if (next !== undefined) { cur = next; } else { more = false; }
  }
  return cur;
}

// The pattern to read where the tree holds `p`, like `rewritten` for expressions.
export function rewrittenPattern(patternRewrites: Map<Pattern, Pattern>, p: Pattern): Pattern {
  let cur = p;
  let more = true;
  while (more) {
    const next = patternRewrites.get(cur);
    if (next !== undefined) { cur = next; } else { more = false; }
  }
  return cur;
}

// Thrown by `TypeChecker.fatal`, caught by `TypeChecker.recover`. Carries no
// message: the diagnostic is already in `diagnostics` by the time this is thrown,
// and this type exists only to unwind. It is deliberately NOT exported — an
// escape past the outermost boundary is a checker bug, not a user-visible error.
export class CheckAbort extends Error {
  constructor() {
    super("check aborted");
  }
}

// Defaults and the off-by-default lints for a TypeChecker's warning config. Mutates the config it is given.
export function applyWarningDefaults(config: WarningConfig): void {
    // `--expect=<name>` counts as asking for the warning, exactly as `--deny` does.
    // Without this an off-by-default lint stayed off, never fired, and the expectation
    // then reported itself unfulfilled against code that does contain the finding.
    if (!config.denied.has("unused-move") && !(config.expected !== undefined && config.expected.has("unused-move"))) config.allowed.add("unused-move");
    // unverified-extern is OFF unless asked for: pairing an `extern struct` with a local
    // .c peer (no header) is a legitimate, common FFI shape — this repo's own ABI-test
    // fixtures do exactly that — and @cLayout has no header to name there. A lint that
    // fires on code that cannot be fixed is one users turn off wholesale, taking the
    // cases that *are* fixable with it. `--deny=unverified-extern` opts a project in
    // (e.g. a binding crate or a safety-critical build where every layout must be pinned).
    if (!config.denied.has("unverified-extern") && !(config.expected !== undefined && config.expected.has("unverified-extern"))) config.allowed.add("unverified-extern");
    // unused-import is OFF unless asked for. An import can be needed without the
    // entry file ever naming the symbol: node-milo's main.milo imports binding symbols
    // purely so those modules get compiled and linked. Warning by default would fire on
    // every one of them, and the fix ("just delete it") would break the build — so the
    // projects that don't do that opt in.
    if (!config.denied.has("unused-import") && !(config.expected !== undefined && config.expected.has("unused-import"))) config.allowed.add("unused-import");
    // replay-hole is OFF unless asked for (`--replay-holes`, or `--deny=replay-hole` to fail
    // a build that has one): an unrecorded extern only matters to a program that is
    // recorded, and the run itself reports the first call to each one.
    if (!config.denied.has("replay-hole") && !(config.expected !== undefined && config.expected.has("replay-hole")) && !(config.warned !== undefined && config.warned.has("replay-hole"))) config.allowed.add("replay-hole");
    // large-stack-array is OFF unless asked for. Big fixed-size locals are a real
    // stack-overflow footgun, but plenty are intentional (main-thread framebuffers
    // that work fine), so warning by default would nag every graphics program. The
    // always-on hover note already surfaces the size; projects opt into the hard lint.
    if (!config.denied.has("large-stack-array") && !(config.expected !== undefined && config.expected.has("large-stack-array"))) config.allowed.add("large-stack-array");
    // unchecked-ffi-contract is OFF unless asked for: a `requires` that is really a
    // state precondition (`self.fd >= 0`) fails as a benign errno, and the lint cannot
    // tell that from a length that C will trust. `--deny=` runs the audit.
    if (!config.denied.has("unchecked-ffi-contract") && !(config.expected !== undefined && config.expected.has("unchecked-ffi-contract"))) config.allowed.add("unchecked-ffi-contract");
    // single-variant-match is OFF while the tree is still being swept. The rewrite it asks
    // for is always an improvement, but the shape is everywhere: 304 sites in src-milo, 110
    // in milojs, 55 in examples/ at the census that shipped it. Default-on before the sweep
    // would bury every real warning under it. Flip it on once those reach zero.
    if (!config.denied.has("single-variant-match") && !(config.expected !== undefined && config.expected.has("single-variant-match"))) config.allowed.add("single-variant-match");
    // opaque-call-on-thread is OFF until the thread-boundary scan resolves function values
    // with a statically known target. Every hit in the tree today (rg.milo, the Once
    // fixture) is a callback that touches no global, so on-by-default would be two false
    // positives and no true ones. Flip it on once the scan can see through `let f = bump`.
    if (!config.denied.has("opaque-call-on-thread") && !(config.expected !== undefined && config.expected.has("opaque-call-on-thread"))) config.allowed.add("opaque-call-on-thread");
    // unowned-pointer-copy is OFF by default: it fires on every `@copy` struct, which is to
    // say on a deliberate annotation, not a smell. It exists so `--deny=unowned-pointer-copy`
    // can enumerate the pointer-holding Copy types of a build and audit each claim.
    if (!config.denied.has("unowned-pointer-copy") && !(config.expected !== undefined && config.expected.has("unowned-pointer-copy"))) config.allowed.add("unowned-pointer-copy");
    // mut-param-bundle is OFF by default: a free fn threading three or more `&mut`
    // parameters is a method with its struct un-bundled, but the tree has about 34 of them
    // (gifdec, the plink and redline world builders). `--deny=mut-param-bundle` lists them
    // for the restructuring sweep; flip it on once that reaches zero.
    if (!config.denied.has("mut-param-bundle") && !(config.expected !== undefined && config.expected.has("mut-param-bundle"))) config.allowed.add("mut-param-bundle");
    // index-clone is ON by default. It was off on the theory that most hits are working
    // code paying a cost the author accepted, but the lint does not fire on the cases
    // where that is true: `isCopy` skips register copies, so a `Vec<Pod>` bind is silent
    // and only an element that owns heap is reported. What is left is a malloc per
    // element per iteration written in syntax that looks free, with two free spellings
    // (`for x in v`, `v[i].n`) sitting right there in the hint. A cost that invisible is
    // exactly what a default-on warning is for; measured across examples/ it is tens of
    // hits, not hundreds. `--allow=index-clone` silences it for a project that wants it.
    // unused-unsafe is on by default but fires only in user code (see currentFnIsUser):
    // the permissive safe-extern rule makes most stdlib unsafe blocks technically
    // removable, so warning on imported std would flood every compile.
}

// The name an identifier expression spells, else null.
export function identNameOf(e: Expr): string | null {
  // ident-ok: reads the NAME of a bare identifier, the rewrite emits a call by name
  return e.kind === "Ident" ? e.name : null;
}
