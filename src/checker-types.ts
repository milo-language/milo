import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span, TraitDecl } from "./ast";
import type { TypeKind } from "./types";
import type { Diagnostic, WarningConfig } from "./diagnostics";

export type { WarningConfig } from "./diagnostics";
export type { Diagnostic } from "./diagnostics";

export interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
  borrowed: boolean;
  read: boolean;
  span?: Span;
}

export interface CaptureInfo {
  name: string;
  type: TypeKind;
  mutable: boolean;
}

export interface FnSig {
  params: { type: TypeKind; name: string }[];
  ret: TypeKind;
  variadic: boolean;
  isExtern?: boolean;
}

export interface StructInfo {
  fields: { name: string; type: TypeKind }[];
  baseName?: string;
  typeArgs?: TypeKind[];
}

export interface EnumInfo {
  baseName?: string;
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exprTypes: Map<Expr, TypeKind>;
  autoBorrowed: Map<Expr, { mutable: boolean }>;
  rewrittenCalls: Map<Expr, string>;
  rewrittenEnums: Map<Expr, string>;
  rewrittenStructLits: Map<Expr, string>;
  movedExprs: Set<Expr>;
  borrowedExprs: Set<Expr>;
  autoWrappedOption: Map<Expr, string>;
  arrayToVecCoercions: Set<Expr>;
  functions: Map<string, FnSig>;
  structs: Map<string, StructInfo>;
  enums: Map<string, EnumInfo>;
  dropImpls: Set<string>;
  monomorphizedFns: Function[];
  monomorphizedEnums: import("./ast").EnumDecl[];
  monomorphizedStructs: StructDecl[];
  closureCaptures: Map<Expr, CaptureInfo[]>;
  closureCalls: Map<Expr, TypeKind>;
  resolvedMethods: Map<Expr, string>;
  resolvedOperators: Map<Expr, string>;
  fnFieldCalls: Set<Expr>;
  propagateConversions: Map<Expr, { targetEnumName: string; wrapVariant: string; wrapTag: number }>;
}

export interface GenericEnumInfo {
  typeParams: string[];
  typeParamDefaults?: (TypeKind | null)[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  decl: import("./ast").EnumDecl;
}

export interface GenericStructInfo {
  typeParams: string[];
  fields: { name: string; type: TypeKind }[];
  decl: StructDecl;
}

export interface GenericFnInfo {
  typeParams: string[];
  decl: Function;
}

export interface TraitMethodInfo {
  params: { name: string; type: TypeKind }[];
  ret: TypeKind;
  hasDefault: boolean;
}

export interface TraitInfo {
  name: string;
  supertraits: string[];
  methods: Map<string, TraitMethodInfo>;
}

export interface ImplInfo {
  traitName: string | null;
  typeName: string;
  methods: Map<string, FnSig>;
}
