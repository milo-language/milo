export type TypeKind =
  | { tag: "int"; bits: number; signed: boolean }
  | { tag: "float"; bits: number }
  | { tag: "bool" }
  | { tag: "void" }
  | { tag: "ptr"; inner: TypeKind }
  | { tag: "ref"; inner: TypeKind; mutable: boolean }
  | { tag: "struct"; name: string }
  | { tag: "array"; element: TypeKind; size: number | null }
  | { tag: "unknown" };

export function typeFromAst(ty: { name: string; isPtr: boolean; isRef: boolean; isRefMut: boolean; isArray: boolean; arraySize: number | null }): TypeKind {
  let base: TypeKind;
  switch (ty.name) {
    case "i8": base = { tag: "int", bits: 8, signed: true }; break;
    case "i16": base = { tag: "int", bits: 16, signed: true }; break;
    case "i32": base = { tag: "int", bits: 32, signed: true }; break;
    case "i64": base = { tag: "int", bits: 64, signed: true }; break;
    case "u8": base = { tag: "int", bits: 8, signed: false }; break;
    case "u16": base = { tag: "int", bits: 16, signed: false }; break;
    case "u32": base = { tag: "int", bits: 32, signed: false }; break;
    case "u64": base = { tag: "int", bits: 64, signed: false }; break;
    case "f32": base = { tag: "float", bits: 32 }; break;
    case "f64": base = { tag: "float", bits: 64 }; break;
    case "bool": base = { tag: "bool" }; break;
    case "void": base = { tag: "void" }; break;
    default: base = { tag: "struct", name: ty.name }; break;
  }
  if (ty.isArray) return { tag: "array", element: base, size: ty.arraySize };
  if (ty.isPtr) return { tag: "ptr", inner: base };
  if (ty.isRef) return { tag: "ref", inner: base, mutable: false };
  if (ty.isRefMut) return { tag: "ref", inner: base, mutable: true };
  return base;
}

export function typeEq(a: TypeKind, b: TypeKind): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "int": return (b as typeof a).bits === a.bits && (b as typeof a).signed === a.signed;
    case "float": return (b as typeof a).bits === a.bits;
    case "bool": case "void": case "unknown": return true;
    case "ptr": return typeEq(a.inner, (b as typeof a).inner);
    case "ref": return typeEq(a.inner, (b as typeof a).inner) && a.mutable === (b as typeof a).mutable;
    case "struct": return a.name === (b as typeof a).name;
    case "array": {
      const ba = b as typeof a;
      return typeEq(a.element, ba.element) && a.size === ba.size;
    }
  }
}

export function typeName(t: TypeKind): string {
  switch (t.tag) {
    case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "ptr": return `*${typeName(t.inner)}`;
    case "ref": return `&${t.mutable ? "mut " : ""}${typeName(t.inner)}`;
    case "struct": return t.name;
    case "array": return t.size !== null ? `[${typeName(t.element)}; ${t.size}]` : `[${typeName(t.element)}]`;
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
export function isCopy(t: TypeKind): boolean {
  return t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr";
}
