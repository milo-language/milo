// Milo's internal type representations (distinct from AST's MiloType which is syntactic)

export type TypeKind =
  | { tag: "int"; bits: number; signed: boolean }
  | { tag: "float"; bits: number }
  | { tag: "bool" }
  | { tag: "void" }
  | { tag: "ptr"; inner: TypeKind }
  | { tag: "struct"; name: string }
  | { tag: "unknown" };

export function typeFromName(name: string, isPtr: boolean): TypeKind {
  let base: TypeKind;
  switch (name) {
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
    default: base = { tag: "struct", name }; break;
  }
  if (isPtr) return { tag: "ptr", inner: base };
  return base;
}

export function typeEq(a: TypeKind, b: TypeKind): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "int": return (b as typeof a).bits === a.bits && (b as typeof a).signed === a.signed;
    case "float": return (b as typeof a).bits === a.bits;
    case "bool": case "void": return true;
    case "ptr": return typeEq(a.inner, (b as typeof a).inner);
    case "struct": return a.name === (b as typeof a).name;
    case "unknown": return true;
  }
}

export function typeName(t: TypeKind): string {
  switch (t.tag) {
    case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "ptr": return `*${typeName(t.inner)}`;
    case "struct": return t.name;
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
