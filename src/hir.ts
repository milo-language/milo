// Typed HIR — every expression carries its resolved TypeKind.
// Eliminates string-based type re-derivation between checker and codegen.

import type { TypeKind } from "./types";
import type { Span } from "./ast";

// ── Expressions ──

export type HIRExpr =
  | { kind: "IntLit"; value: number; type: TypeKind; span?: Span }
  | { kind: "FloatLit"; value: number; type: TypeKind; span?: Span }
  | { kind: "BoolLit"; value: boolean; type: TypeKind; span?: Span }
  | { kind: "CharLit"; value: number; type: TypeKind; span?: Span }
  | { kind: "StringLit"; value: string; type: TypeKind; span?: Span }
  | { kind: "Ident"; name: string; type: TypeKind; isMove?: boolean; span?: Span }
  | { kind: "BinOp"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "UnaryOp"; op: string; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "Call"; func: string; args: HIRArg[]; type: TypeKind; variadic: boolean; span?: Span }
  | { kind: "StructLit"; name: string; fields: { name: string; value: HIRExpr }[]; type: TypeKind; span?: Span }
  | { kind: "FieldAccess"; object: HIRExpr; field: string; type: TypeKind; span?: Span }
  | { kind: "ArrayLit"; elements: HIRExpr[]; type: TypeKind; span?: Span }
  | { kind: "ArrayRepeat"; value: HIRExpr; count: number; type: TypeKind; span?: Span }
  | { kind: "IndexAccess"; object: HIRExpr; index: HIRExpr; type: TypeKind; isMove?: boolean; isBorrowed?: boolean; span?: Span }
  | { kind: "EnumLit"; enumName: string; variant: string; args: HIRExpr[]; type: TypeKind; span?: Span }
  | { kind: "ArrayLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "Unwrap"; operand: HIRExpr; enumName: string; type: TypeKind; span?: Span }
  | { kind: "Propagate"; operand: HIRExpr; enumName: string; retType: TypeKind; fromConversion?: { targetEnumName: string; wrapVariant: string; wrapTag: number }; type: TypeKind; span?: Span }
  | { kind: "DefaultValue"; operand: HIRExpr; default: HIRExpr; enumName: string; type: TypeKind; span?: Span }
  | { kind: "Cast"; operand: HIRExpr; targetType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "IsCheck"; operand: HIRExpr; tag: number; type: TypeKind; span?: Span }
  | { kind: "HeapCreate"; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HeapDeref"; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "PtrDeref"; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecNew"; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecPush"; vec: HIRExpr; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecPop"; vec: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapNew"; keyType: TypeKind; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "HashMapInsert"; map: HIRExpr; key: HIRExpr; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapGet"; map: HIRExpr; key: HIRExpr; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "HashMapGetOrDefault"; map: HIRExpr; key: HIRExpr; default: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapContains"; map: HIRExpr; key: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapRemove"; map: HIRExpr; key: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringWithCapacity"; capacity: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringPush"; str: HIRExpr; byte: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringSubstr"; str: HIRExpr; start: HIRExpr; end: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringSlice"; str: HIRExpr; start: HIRExpr; end: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringParseF64"; str: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringClone"; str: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "NumberToString"; value: HIRExpr; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "JsonStringify"; value: HIRExpr; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "Closure"; params: { name: string; type: TypeKind }[]; body: HIRStmt[]; captures: { name: string; type: TypeKind; mutable: boolean }[]; retType: TypeKind; type: TypeKind; isMove?: boolean; span?: Span }
  | { kind: "ClosureCall"; callee: HIRExpr; args: HIRArg[]; type: TypeKind; span?: Span }
  | { kind: "VecMap"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; resultElementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFilter"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecEach"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFind"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecAny"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecAll"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecIsEmpty"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecEnumerate"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecReverse"; object: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecContains"; vec: HIRExpr; value: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSort"; object: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSortBy"; object: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSortByKey"; object: HIRExpr; callback: HIRExpr; elementType: TypeKind; keyType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "WrappingArith"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "SaturatingArith"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "CheckedArith"; op: string; left: HIRExpr; right: HIRExpr; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "SizeOf"; sizeType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "Zeroed"; zeroType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "InterfaceCoerce"; value: HIRExpr; fromType: string; ifaceName: string; type: TypeKind; span?: Span }
  | { kind: "InterfaceMethodCall"; object: HIRExpr; ifaceName: string; methodIndex: number; args: HIRArg[]; type: TypeKind; span?: Span };

export interface HIRArg {
  expr: HIRExpr;
  passByRef: boolean;
  refMut: boolean;
}

// ── Statements ──

export type HIRStmt =
  | { kind: "Let"; name: string; type: TypeKind; value: HIRExpr; mutable: boolean; rangeCheck?: { min: number; max: number; typeName: string }; span?: Span }
  | { kind: "Assign"; target: HIRExpr; value: HIRExpr; span?: Span }
  | { kind: "Return"; value: HIRExpr | null; retType: TypeKind; span?: Span }
  | { kind: "If"; cond: HIRExpr; thenBody: HIRStmt[]; elseBody: HIRStmt[] | null; span?: Span }
  | { kind: "While"; cond: HIRExpr; body: HIRStmt[]; span?: Span }
  | { kind: "Break"; span?: Span }
  | { kind: "Continue"; span?: Span }
  | { kind: "ExprStmt"; expr: HIRExpr; span?: Span }
  | { kind: "Match"; subject: HIRExpr; arms: HIRMatchArm[]; enumName: string; span?: Span }
  | { kind: "UnsafeBlock"; body: HIRStmt[]; span?: Span }
  | { kind: "ForRange"; varName: string; varType: TypeKind; start: HIRExpr; end: HIRExpr; body: HIRStmt[]; span?: Span }
  | { kind: "ForEach"; varName: string; varName2: string | null; varType: TypeKind; varType2: TypeKind | null; iterable: HIRExpr; iterableKind: "vec" | "string" | "hashmap" | "array"; body: HIRStmt[]; span?: Span }
  | { kind: "Parallel"; branches: { name: string; expr: HIRExpr; type: TypeKind; captures: { name: string; type: TypeKind; mutable: boolean }[] }[]; span?: Span };

export interface HIRMatchArm {
  pattern: HIRPattern;
  body: HIRStmt[];
}

export type HIRPattern =
  | { kind: "EnumPattern"; variant: string; bindings: { name: string; type: TypeKind }[]; tag: number }
  | { kind: "LiteralPattern"; value: number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool" }
  | { kind: "WildcardPattern" };

// ── Top-level ──

export interface HIRFunction {
  name: string;
  params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[];
  retType: TypeKind;
  body: HIRStmt[];
  isExtern: boolean;
  isVariadic: boolean;
}

export interface HIRStruct {
  name: string;
  fields: { name: string; type: TypeKind }[];
}

export interface HIREnum {
  name: string;
  variants: { name: string; tag: number; fields: TypeKind[] }[];
}

export interface HIRModule {
  structs: HIRStruct[];
  enums: HIREnum[];
  functions: HIRFunction[];
  dropImpls: Set<string>;
  itables: { concreteType: string; ifaceName: string; methods: string[] }[];
}
