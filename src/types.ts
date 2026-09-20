// Internal type representations: the TypeKind tagged union every later stage speaks.
export type TypeKind =
  | { tag: "int"; bits: number; signed: boolean; min?: number; max?: number }
  | { tag: "float"; bits: number }
  | { tag: "bool" }
  | { tag: "void" }
  | { tag: "string" }
  | { tag: "ptr"; inner: TypeKind }
  | { tag: "ref"; inner: TypeKind; mutable: boolean }
  | { tag: "struct"; name: string }
  | { tag: "enum"; name: string }
  | { tag: "heap"; inner: TypeKind }
  | { tag: "vec"; element: TypeKind }
  | { tag: "hashmap"; key: TypeKind; value: TypeKind }
  | { tag: "array"; element: TypeKind; size: number | null }
  // `owning` marks a closure that took ownership of its captured environment (`move`).
  // It is deliberately NOT part of typeEq: a non-owning fn is usable wherever an owning
  // one is expected (it owns nothing, so a drop is a no-op), and the checker rejects the
  // unsound direction explicitly so it can say why. What the flag DOES change is isCopy.
  | { tag: "fn"; params: TypeKind[]; ret: TypeKind; owning?: boolean }
  // A bare C function pointer (one word, no closure env). `fn` is a fat {ptr,ptr}
  // pair, so a pointer obtained from dlsym cannot become one — calling it would
  // pass an env argument the C callee never declared.
  | { tag: "cfn"; params: TypeKind[]; ret: TypeKind }
  | { tag: "interface"; name: string }
  | { tag: "unknown" };

// Every name `typeFromAst` resolves to a builtin rather than a user struct, aliases
// included (`int`/`byte`/`float` alongside `i64`/`u8`/`f64`). Anything absent here is
// a struct name, so this doubles as the editor grammar's primitive list — the old
// hand-written one highlighted `char`, which is a literal kind and not a type, and
// missed `string`, `int`, `byte` and `float` entirely.
export const PRIMITIVE_TYPE_NAMES = [
  "i8", "i16", "i32", "i64", "int",
  "u8", "byte", "u16", "u32", "u64",
  "f32", "f64", "float",
  "bool", "void", "string",
] as const;

export function typeFromAst(ty: { name: string; isPtr: boolean; ptrDepth?: number; isRef: boolean; isRefMut: boolean; isNullableRef?: boolean; isArray: boolean; arraySize: number | null; isFn?: boolean; isCFn?: boolean; fnParams?: any[]; fnRet?: any; rangeMin?: number; rangeMax?: number }): TypeKind {
  if (ty.isFn && ty.fnParams && ty.fnRet) {
    const tag = ty.isCFn ? "cfn" as const : "fn" as const;
    const base = { tag, params: ty.fnParams.map(typeFromAst), ret: typeFromAst(ty.fnRet) };
    return (ty as { isMoveFn?: boolean }).isMoveFn ? { ...base, owning: true } : base;
  }
  let base: TypeKind;
  switch (ty.name) {
    case "i8": base = { tag: "int", bits: 8, signed: true }; break;
    case "i16": base = { tag: "int", bits: 16, signed: true }; break;
    case "i32": base = { tag: "int", bits: 32, signed: true }; break;
    case "int": case "i64": base = { tag: "int", bits: 64, signed: true }; break;
    case "byte": case "u8": base = { tag: "int", bits: 8, signed: false }; break;
    case "u16": base = { tag: "int", bits: 16, signed: false }; break;
    case "u32": base = { tag: "int", bits: 32, signed: false }; break;
    case "u64": base = { tag: "int", bits: 64, signed: false }; break;
    case "f32": base = { tag: "float", bits: 32 }; break;
    case "float": case "f64": base = { tag: "float", bits: 64 }; break;
    case "bool": base = { tag: "bool" }; break;
    case "void": base = { tag: "void" }; break;
    case "string": base = { tag: "string" }; break;
    default: base = { tag: "struct", name: ty.name }; break;
  }
  if (base.tag === "int" && ty.rangeMin !== undefined && ty.rangeMax !== undefined) {
    base = { ...base, min: ty.rangeMin, max: ty.rangeMax };
  }
  let result: TypeKind = base;
  if (ty.isArray) result = { tag: "array", element: base, size: ty.arraySize };
  const depth = ty.ptrDepth ?? (ty.isPtr ? 1 : 0);
  if (depth > 0) {
    for (let i = 0; i < depth; i++) result = { tag: "ptr", inner: result };
    return result;
  }
  // `?&mut T` IS a `T *` — that is the entire ABI claim the spelling makes, so it is one
  // here too, and headergen/@cSig/codegen need no case of their own. What keeps it from
  // being an ordinary raw pointer is not the type: it is the binding, which the checker
  // marks so that every use except the `let … else` unwrap is an error.
  if (ty.isNullableRef) return { tag: "ptr", inner: result };
  if (ty.isRef) return { tag: "ref", inner: result, mutable: false };
  if (ty.isRefMut) return { tag: "ref", inner: result, mutable: true };
  return result;
}

export function typeEq(a: TypeKind, b: TypeKind): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "int": return (b as typeof a).bits === a.bits && (b as typeof a).signed === a.signed;
    case "float": return (b as typeof a).bits === a.bits;
    case "bool": case "void": case "string": case "unknown": return true;
    case "ptr": return typeEq(a.inner, (b as typeof a).inner);
    case "heap": return typeEq(a.inner, (b as typeof a).inner);
    case "vec": return typeEq(a.element, (b as typeof a).element);
    case "hashmap": return typeEq(a.key, (b as typeof a).key) && typeEq(a.value, (b as typeof a).value);
    case "ref": return typeEq(a.inner, (b as typeof a).inner) && a.mutable === (b as typeof a).mutable;
    case "struct": return a.name === (b as typeof a).name;
    case "enum": return a.name === (b as typeof a).name;
    case "array": {
      const ba = b as typeof a;
      return typeEq(a.element, ba.element) && a.size === ba.size;
    }
    case "fn": case "cfn": {
      const bf = b as typeof a;
      return a.params.length === bf.params.length && a.params.every((p, i) => typeEq(p, bf.params[i])) && typeEq(a.ret, bf.ret);
    }
    case "interface": return a.name === (b as typeof a).name;
  }
}

// `demangle` maps a monomorphized struct/enum name (`Pair_i64_string`) back to what the
// user wrote (`Pair<i64, string>`). Only the checker knows that mapping, so it is passed
// in; without it the name is the identity used for lookups and mangling, and callers
// that build a KEY from a type must not pass one.
export function typeName(t: TypeKind, demangle?: (name: string) => string): string {
  const tn = (x: TypeKind) => typeName(x, demangle);
  switch (t.tag) {
    case "int": {
      const base = `${t.signed ? "i" : "u"}${t.bits}`;
      return t.min !== undefined && t.max !== undefined ? `${base}(${t.min}..${t.max})` : base;
    }
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "string": return "string";
    case "ptr": return `*${tn(t.inner)}`;
    case "heap": return `Heap<${tn(t.inner)}>`;
    case "vec": return `Vec<${tn(t.element)}>`;
    case "hashmap": return `HashMap<${tn(t.key)}, ${tn(t.value)}>`;
    case "ref": return `&${t.mutable ? "mut " : ""}${tn(t.inner)}`;
    case "struct": return demangle ? demangle(t.name) : t.name;
    case "enum": return demangle ? demangle(t.name) : t.name;
    case "array": return t.size !== null ? `[${tn(t.element)}; ${t.size}]` : `[${tn(t.element)}]`;
    case "fn": return `${t.owning ? "move " : ""}(${t.params.map(tn).join(", ")}) => ${tn(t.ret)}`;
    case "cfn": return `extern (${t.params.map(tn).join(", ")}) => ${tn(t.ret)}`;
    case "interface": return t.name;
    case "unknown": return "<unknown>";
  }
}

export function isNumeric(t: TypeKind): boolean {
  return t.tag === "int" || t.tag === "float";
}

export function isInteger(t: TypeKind): boolean {
  return t.tag === "int";
}

export function isFloat(t: TypeKind): boolean {
  return t.tag === "float";
}

// primitives are Copy (no move tracking needed)
// Payload-free enums are also Copy — they're just a tag, no heap-owning data inside.
// The optional `enumIsPayloadFree` callback lets the caller (the checker) inject its
// view of which enums have payload-bearing variants without us reaching into checker state here.
// The callbacks are REQUIRED: a caller that omits them silently makes every struct and
// enum non-Copy, which is how `unwrapOr` came to reject a struct that `let e = d` had just
// copied (design pass 2026-09, F1). The checker routes every call through
// `TypeChecker.isCopyType`; do not add a second entry point with defaults.
export function isCopy(t: TypeKind, enumIsCopy: (name: string) => boolean, structIsAllCopy: (name: string) => boolean): boolean {
  // An OWNING closure is the one function-ish value that is not Copy: it holds a heap
  // environment, and two copies of the pair would be two owners of it. Everything else in
  // this list owns nothing — a bare function pointer, a C function pointer, a
  // by-reference closure (its environment is a stack slot in the frame that made it).
  if (t.tag === "fn") return !t.owning;
  if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr" || t.tag === "cfn" || t.tag === "ref") return true;
  if (t.tag === "enum" && enumIsCopy(t.name)) return true;
  if (t.tag === "struct" && structIsAllCopy(t.name)) return true;
  // A fixed-size array of Copy elements is itself Copy — it is a value with no heap and no
  // drop glue, exactly like the struct case above (Rust: `[T; N]: Copy where T: Copy`).
  // Without this, `[u8; 16]` (an IPv6 address) could not be passed to two functions: the
  // first call moved it, and the compiler's own hint suggested `.clone()`, which arrays do
  // not have — a diagnostic naming a fix that cannot be applied.
  //
  // This does NOT make big buffers copy by value: `[u8; 4096]` decays to `*u8` at every
  // call in std (readFd/writeFd take pointers), and nothing passes a large array by value.
  // An array of non-Copy elements (`[string; 4]`) stays non-Copy via the element check.
  if (t.tag === "array") return isCopy(t.element, enumIsCopy, structIsAllCopy);
  return false;
}

// scalar types that are safe to pass across extern boundaries (no memory semantics)
export function isScalar(t: TypeKind): boolean {
  return t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "void";
}

// heap-owning types that need destructor calls at scope exit
export function needsDrop(t: TypeKind): boolean {
  return t.tag === "string" || t.tag === "heap" || t.tag === "vec" || t.tag === "hashmap";
}

// Vec methods that only READ, and so are meaningful on a slice (`&[T]`, an array with no
// size). A slice carries the SAME `%Vec` layout a Vec does, so these need no separate
// emitter — they were excluded only because the checker and the lowerer both gate on
// `tag === "vec"`, which walled them off from every function taking a slice.
//
// Whitelisted rather than widened: the same code paths carry `push`/`pop`/`insert`/`sort`,
// and a slice is a non-owning view that must not grow or reorder the storage it points at.
// Shared by src/checker.ts and src/lower.ts so the two can never disagree about which
// methods a slice has — a divergence there is an accepted program the lowerer then cannot
// emit, which is exactly how this landed the first time.
// A FIXED array (`[T; N]`) can use the same set, but not by re-tagging: it is laid out
// inline as `[N x T]`, not as a `%Vec`, so the object has to be turned into a full-range
// slice first. `clone` is excluded because cloning a fixed array should yield an array,
// not a slice of one — the re-tag would change the result type.
export const ARRAY_COMBINATORS: ReadonlySet<string> = new Set([
  "sum", "map", "filter", "fold", "reduce", "each", "enumerate",
  "find", "position", "indexOf", "any", "all", "contains",
  "isEmpty", "join", "first", "last", "min", "max",
]);

export const SLICE_COMBINATORS: ReadonlySet<string> = new Set([
  "sum", "map", "filter", "fold", "reduce", "each", "enumerate",
  "find", "position", "indexOf", "any", "all", "contains",
  "isEmpty", "join", "first", "last", "get", "min", "max", "clone",
]);
