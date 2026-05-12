export interface MiloType {
  name: string; // "i32", "u8", "bool", "void", etc.
  typeArgs?: MiloType[]; // generic type arguments, e.g. Option<i32>
  isPtr: boolean;
  isRef: boolean;      // &T
  isRefMut: boolean;   // &mut T
  isArray: boolean;    // [T]
  arraySize: number | null; // [T; N] — null for dynamic
}

export function simpleType(name: string): MiloType {
  return { name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
}

export function ptrType(name: string): MiloType {
  return { name, isPtr: true, isRef: false, isRefMut: false, isArray: false, arraySize: null };
}

export interface Param {
  name: string;
  type: MiloType;
}

export interface StructField {
  name: string;
  type: MiloType;
}

// ── Expressions ──

export interface IntLit { kind: "IntLit"; value: number }
export interface FloatLit { kind: "FloatLit"; value: number }
export interface BoolLit { kind: "BoolLit"; value: boolean }
export interface StringLit { kind: "StringLit"; value: string }
export interface Ident { kind: "Ident"; name: string }
export interface BinOp { kind: "BinOp"; op: string; left: Expr; right: Expr }
export interface UnaryOp { kind: "UnaryOp"; op: string; operand: Expr }
export interface Call { kind: "Call"; func: string; args: Expr[] }
export interface StructLit { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[] }
export interface FieldAccess { kind: "FieldAccess"; object: Expr; field: string }
export interface ArrayLit { kind: "ArrayLit"; elements: Expr[] }
export interface IndexAccess { kind: "IndexAccess"; object: Expr; index: Expr }
export interface EnumLit { kind: "EnumLit"; enumName: string; variant: string; args: Expr[] }

export type Expr = IntLit | FloatLit | BoolLit | StringLit | Ident | BinOp | UnaryOp | Call
  | StructLit | FieldAccess | ArrayLit | IndexAccess | EnumLit;

// ── Statements ──

export interface LetDecl { kind: "LetDecl"; name: string; type: MiloType | null; value: Expr }
export interface VarDecl { kind: "VarDecl"; name: string; type: MiloType | null; value: Expr }
export interface Assign { kind: "Assign"; target: Expr; value: Expr }
export interface Return { kind: "Return"; value: Expr | null }
export interface IfStmt { kind: "IfStmt"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null }
export interface WhileStmt { kind: "WhileStmt"; cond: Expr; body: Stmt[] }
export interface ExprStmt { kind: "ExprStmt"; expr: Expr }

export type Pattern =
  | { kind: "EnumPattern"; enumName: string; variant: string; bindings: string[] }
  | { kind: "WildcardPattern" };

export interface MatchArm { pattern: Pattern; body: Stmt[] }
export interface MatchStmt { kind: "MatchStmt"; subject: Expr; arms: MatchArm[] }

export type Stmt = LetDecl | VarDecl | Assign | Return | IfStmt | WhileStmt | ExprStmt | MatchStmt;

// ── Top-level ──

export interface StructDecl {
  kind: "StructDecl";
  name: string;
  fields: StructField[];
}

export interface EnumVariant {
  name: string;
  fields: MiloType[];
}

export interface EnumDecl {
  kind: "EnumDecl";
  name: string;
  typeParams: string[];
  variants: EnumVariant[];
}

export interface Function {
  kind: "Function";
  name: string;
  params: Param[];
  retType: MiloType;
  body: Stmt[];
  isExtern: boolean;
  isVariadic: boolean;
}

export type TopLevel = StructDecl | EnumDecl | Function;

export interface Program {
  structs: StructDecl[];
  enums: EnumDecl[];
  functions: Function[];
}
