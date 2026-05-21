export interface Span { line: number; col: number }

export interface MiloType {
  name: string; // "i32", "u8", "bool", "void", etc.
  typeArgs?: MiloType[]; // generic type arguments, e.g. Option<i32>
  isPtr: boolean;
  isRef: boolean;      // &T
  isRefMut: boolean;   // &mut T
  isArray: boolean;    // [T]
  arraySize: number | null; // [T; N] — null for dynamic
  isFn?: boolean;      // fn(T): R
  fnParams?: MiloType[];
  fnRet?: MiloType;
  rangeMin?: number;   // i32(0..50000) — range constraint
  rangeMax?: number;
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

export interface TypeParam {
  name: string;
  bounds: string[];
}

export interface Attribute {
  name: string;
  args: string[];
}

// ── Expressions ──

export interface IntLit { kind: "IntLit"; value: number; span?: Span }
export interface FloatLit { kind: "FloatLit"; value: number; span?: Span }
export interface BoolLit { kind: "BoolLit"; value: boolean; span?: Span }
export interface StringLit { kind: "StringLit"; value: string; span?: Span }
export interface CharLit { kind: "CharLit"; value: number; span?: Span }
export interface Ident { kind: "Ident"; name: string; span?: Span }
export interface BinOp { kind: "BinOp"; op: string; left: Expr; right: Expr; span?: Span }
export interface UnaryOp { kind: "UnaryOp"; op: string; operand: Expr; span?: Span }
export interface Call { kind: "Call"; func: string; args: Expr[]; typeArgs?: MiloType[]; span?: Span }
export interface StructLit { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[]; span?: Span }
export interface FieldAccess { kind: "FieldAccess"; object: Expr; field: string; span?: Span }
export interface ArrayLit { kind: "ArrayLit"; elements: Expr[]; span?: Span }
export interface ArrayRepeat { kind: "ArrayRepeat"; value: Expr; count: number; span?: Span }
export interface IndexAccess { kind: "IndexAccess"; object: Expr; index: Expr; span?: Span }
export interface EnumLit { kind: "EnumLit"; enumName: string; variant: string; args: Expr[]; typeArgs?: MiloType[]; span?: Span }
export interface Unwrap { kind: "Unwrap"; operand: Expr; span?: Span }
export interface Propagate { kind: "Propagate"; operand: Expr; span?: Span }
export interface DefaultValue { kind: "DefaultValue"; operand: Expr; default: Expr; span?: Span }
export interface CastExpr { kind: "CastExpr"; operand: Expr; targetType: MiloType; span?: Span }
export interface MethodCall { kind: "MethodCall"; object: Expr; method: string; args: Expr[]; span?: Span }
export interface ClosureExpr { kind: "Closure"; params: Param[]; retType: MiloType | null; body: Stmt[]; isMove?: boolean; span?: Span }
export interface RangeExpr { kind: "RangeExpr"; start: Expr; end: Expr; span?: Span }
export interface IsExpr { kind: "IsExpr"; operand: Expr; pattern: Pattern; span?: Span }

export type Expr = IntLit | FloatLit | BoolLit | StringLit | CharLit | Ident | BinOp | UnaryOp | Call
  | StructLit | FieldAccess | ArrayLit | ArrayRepeat | IndexAccess | EnumLit | Unwrap | Propagate | DefaultValue | CastExpr | MethodCall | ClosureExpr | RangeExpr | IsExpr;

// ── Statements ──

export interface LetDecl { kind: "LetDecl"; name: string; type: MiloType | null; value: Expr; span?: Span }
export interface VarDecl { kind: "VarDecl"; name: string; type: MiloType | null; value: Expr; span?: Span }
export interface Assign { kind: "Assign"; target: Expr; value: Expr; span?: Span }
export interface Return { kind: "Return"; value: Expr | null; span?: Span }
export interface IfStmt { kind: "IfStmt"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null; span?: Span }
export interface WhileStmt { kind: "WhileStmt"; cond: Expr; body: Stmt[]; span?: Span }
export interface ExprStmt { kind: "ExprStmt"; expr: Expr; span?: Span }
export interface BreakStmt { kind: "BreakStmt"; span?: Span }
export interface ContinueStmt { kind: "ContinueStmt"; span?: Span }

export type Pattern =
  | { kind: "EnumPattern"; enumName: string; variant: string; bindings: string[]; span?: Span }
  | { kind: "LiteralPattern"; value: number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool"; span?: Span }
  | { kind: "WildcardPattern"; span?: Span };

export interface MatchArm { pattern: Pattern; body: Stmt[] }
export interface MatchStmt { kind: "MatchStmt"; subject: Expr; arms: MatchArm[]; span?: Span }
export interface IfLetStmt { kind: "IfLetStmt"; pattern: Pattern; subject: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null; span?: Span }

export interface UnsafeBlock { kind: "UnsafeBlock"; body: Stmt[]; span?: Span }
export interface ForInStmt { kind: "ForInStmt"; varName: string; varName2: string | null; iterable: Expr; body: Stmt[]; span?: Span }
export interface ParallelBlock { kind: "ParallelBlock"; bindings: { name: string; value: Expr; span?: Span }[]; span?: Span }

export type Stmt = LetDecl | VarDecl | Assign | Return | IfStmt | WhileStmt | ExprStmt | MatchStmt | BreakStmt | ContinueStmt | IfLetStmt | UnsafeBlock | ForInStmt | ParallelBlock;

// ── Top-level ──

export interface StructDecl {
  kind: "StructDecl";
  name: string;
  typeParams: TypeParam[];
  fields: StructField[];
  attributes?: Attribute[];
  isExtern?: boolean;
  isOpaque?: boolean;
}

export interface EnumVariant {
  name: string;
  fields: MiloType[];
}

export interface EnumDecl {
  kind: "EnumDecl";
  name: string;
  typeParams: TypeParam[];
  variants: EnumVariant[];
  attributes?: Attribute[];
}

export interface Function {
  kind: "Function";
  name: string;
  typeParams: TypeParam[];
  params: Param[];
  retType: MiloType;
  body: Stmt[];
  isExtern: boolean;
  isVariadic: boolean;
}

export interface ImportDecl {
  kind: "ImportDecl";
  path: string;
  names: string[] | null; // null = glob import (import "path"), array = named (from "path" import { a, b })
  span?: Span;
}

export interface TraitMethod {
  name: string;
  params: Param[];
  retType: MiloType;
  body: Stmt[] | null;
  span?: Span;
}

export interface TraitDecl {
  kind: "TraitDecl";
  name: string;
  typeParams: TypeParam[];
  supertraits: string[];
  methods: TraitMethod[];
  span?: Span;
}

export interface ImplDecl {
  kind: "ImplDecl";
  traitName: string | null;
  typeName: string;
  typeParams: TypeParam[];
  methods: Function[];
  span?: Span;
}

export interface InterfaceDecl {
  kind: "InterfaceDecl";
  name: string;
  methods: TraitMethod[];
  span?: Span;
}

export interface TypeAlias {
  kind: "TypeAlias";
  name: string;
  type: MiloType;
  span?: Span;
}

export type TopLevel = StructDecl | EnumDecl | Function | ImportDecl | TraitDecl | ImplDecl | TypeAlias | InterfaceDecl;

export interface GlobalDecl {
  kind: "GlobalDecl";
  name: string;
  type: MiloType | null;
  value: Expr;
  mutable: boolean;
  span?: Span;
}

export interface Program {
  structs: StructDecl[];
  enums: EnumDecl[];
  functions: Function[];
  imports: ImportDecl[];
  traits: TraitDecl[];
  impls: ImplDecl[];
  typeAliases: TypeAlias[];
  interfaces: InterfaceDecl[];
  globals: GlobalDecl[];
  userFnNames?: Set<string>;
}
