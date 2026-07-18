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
  | { tag: "fn"; params: TypeKind[]; ret: TypeKind }
  | { tag: "interface"; name: string }
  | { tag: "unknown" };

export function typeFromAst(ty: { name: string; isPtr: boolean; ptrDepth?: number; isRef: boolean; isRefMut: boolean; isArray: boolean; arraySize: number | null; isFn?: boolean; fnParams?: any[]; fnRet?: any; rangeMin?: number; rangeMax?: number }): TypeKind {
  if (ty.isFn && ty.fnParams && ty.fnRet) {
    return { tag: "fn", params: ty.fnParams.map(typeFromAst), ret: typeFromAst(ty.fnRet) };
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
    case "fn": {
      const bf = b as typeof a;
      return a.params.length === bf.params.length && a.params.every((p, i) => typeEq(p, bf.params[i])) && typeEq(a.ret, bf.ret);
    }
    case "interface": return a.name === (b as typeof a).name;
  }
}

export function typeName(t: TypeKind): string {
  switch (t.tag) {
    case "int": {
      const base = `${t.signed ? "i" : "u"}${t.bits}`;
      return t.min !== undefined && t.max !== undefined ? `${base}(${t.min}..${t.max})` : base;
    }
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "string": return "string";
    case "ptr": return `*${typeName(t.inner)}`;
    case "heap": return `Heap<${typeName(t.inner)}>`;
    case "vec": return `Vec<${typeName(t.element)}>`;
    case "hashmap": return `HashMap<${typeName(t.key)}, ${typeName(t.value)}>`;
    case "ref": return `&${t.mutable ? "mut " : ""}${typeName(t.inner)}`;
    case "struct": return t.name;
    case "enum": return t.name;
    case "array": return t.size !== null ? `[${typeName(t.element)}; ${t.size}]` : `[${typeName(t.element)}]`;
    case "fn": return `(${t.params.map(typeName).join(", ")}) => ${typeName(t.ret)}`;
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
export function isCopy(t: TypeKind, enumIsCopy?: (name: string) => boolean, structIsAllCopy?: (name: string) => boolean): boolean {
  if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr" || t.tag === "fn" || t.tag === "ref") return true;
  if (t.tag === "enum" && enumIsCopy && enumIsCopy(t.name)) return true;
  if (t.tag === "struct" && structIsAllCopy && structIsAllCopy(t.name)) return true;
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
