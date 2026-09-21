// Typed HIR — every expression carries its resolved TypeKind.
// Eliminates string-based type re-derivation between checker and codegen.

import type { TypeKind } from "./types";
import type { Span } from "./ast";

// ── Expressions ──

export type HIRExpr =
  | { kind: "IntLit"; value: bigint; type: TypeKind; span?: Span }
  // Wraps a value flowing into a ranged-int target; codegen emits `value` then a runtime
  // bound check on it, yielding the value. Enforces `i32(0..100)` at any expression position.
  | { kind: "RangeCheck"; value: HIRExpr; min: number; max: number; typeName: string; type: TypeKind; span?: Span }
  | { kind: "FloatLit"; value: number; type: TypeKind; span?: Span }
  | { kind: "BoolLit"; value: boolean; type: TypeKind; span?: Span }
  | { kind: "CharLit"; value: number; type: TypeKind; span?: Span }
  | { kind: "StringLit"; value: string; type: TypeKind; span?: Span }
  | { kind: "Ident"; name: string; type: TypeKind; isMove?: boolean; span?: Span }
  | { kind: "BinOp"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "UnaryOp"; op: string; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "Call"; func: string; args: HIRArg[]; type: TypeKind; variadic: boolean; span?: Span }
  | { kind: "StructLit"; name: string; fields: { name: string; value: HIRExpr }[]; type: TypeKind; span?: Span }
  | { kind: "FieldAccess"; object: HIRExpr; field: string; type: TypeKind; isMove?: boolean; span?: Span }
  | { kind: "ArrayLit"; elements: HIRExpr[]; type: TypeKind; span?: Span }
  | { kind: "ArrayRepeat"; value: HIRExpr; count: number; type: TypeKind; span?: Span }
  | { kind: "IndexAccess"; object: HIRExpr; index: HIRExpr; type: TypeKind; isMove?: boolean; isBorrowed?: boolean; span?: Span }
  | { kind: "EnumLit"; enumName: string; variant: string; args: HIRExpr[]; type: TypeKind; span?: Span }
  | { kind: "ArrayLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringCstr"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecPtr"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HeapPtr"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "Unwrap"; operand: HIRExpr; enumName: string; type: TypeKind; span?: Span }
  | { kind: "Propagate"; operand: HIRExpr; enumName: string; retType: TypeKind; fromConversion?: { targetEnumName: string; wrapVariant: string; wrapTag: number }; type: TypeKind; span?: Span }
  | { kind: "DefaultValue"; operand: HIRExpr; default: HIRExpr; enumName: string; type: TypeKind; span?: Span }
  | { kind: "Cast"; operand: HIRExpr; targetType: TypeKind; type: TypeKind; span?: Span }
  // `replace(place, value)`: stores `value` into `place` WITHOUT dropping the old occupant
  // (it is moved out and returned instead). `type` is the moved-out value's type.
  | { kind: "MemReplace"; place: HIRExpr; value: HIRExpr; type: TypeKind; span?: Span }
  // `forget(x)` — evaluate x, then drop nothing. The move is already recorded on the
  // operand, so the source slot is zeroed exactly as any other transfer would.
  | { kind: "Forget"; value: HIRExpr; type: TypeKind; span?: Span }
  // `swap(a, b)`: exchanges two places in place; drops nothing. `type` is void.
  | { kind: "MemSwap"; a: HIRExpr; b: HIRExpr; type: TypeKind; span?: Span }
  // `Kind.tryFrom(n)` on a repr'd enum → Option<Kind>. `Some(variant)` when `value` equals
  // one of `discriminants`, else `None`. A fieldless enum's value IS its tag, so the matched
  // integer reconstructs the variant directly. `type` is the Option enum.
  | { kind: "EnumTryFrom"; enumName: string; optionEnumName: string; value: HIRExpr; discriminants: number[]; type: TypeKind; span?: Span }
  | { kind: "IsCheck"; operand: HIRExpr; tag: number; type: TypeKind; span?: Span }
  | { kind: "HeapCreate"; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HeapDeref"; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "PtrDeref"; operand: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "MatchExpr"; subject: HIRExpr; arms: HIRMatchArm[]; enumName: string; subjectIsRef?: boolean; subjectIsMut?: boolean; type: TypeKind; span?: Span }
  | { kind: "VecNew"; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecWithCapacity"; capacity: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFilled"; count: HIRExpr; value: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecPush"; vec: HIRExpr; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecPop"; vec: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecClone"; object: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "HashMapNew"; keyType: TypeKind; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "HashMapInsert"; map: HIRExpr; key: HIRExpr; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapGet"; map: HIRExpr; key: HIRExpr; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "HashMapGetOrDefault"; map: HIRExpr; key: HIRExpr; default: HIRExpr; type: TypeKind; span?: Span }
  // `m.modify(k, f)`: f(&mut value) in place when the key is present; bool says whether.
  | { kind: "HashMapModify"; map: HIRExpr; key: HIRExpr; callback: HIRExpr; type: TypeKind; span?: Span }
  // `m.getOrInsertWith(k, init)`: insert init() when the key is absent; bool says whether it did.
  | { kind: "HashMapGetOrInsertWith"; map: HIRExpr; key: HIRExpr; init: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapContains"; map: HIRExpr; key: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapRemove"; map: HIRExpr; key: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapLen"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapWithCapacity"; capacity: HIRExpr; keyType: TypeKind; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "HashMapClone"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "HashMapClear"; object: HIRExpr; type: TypeKind; span?: Span }
  // `keys()`/`values()` snapshot the occupied slots into a fresh Vec (deep-cloned —
  // the map keeps its own copy). `field` says which half of the entry to collect.
  | { kind: "HashMapEntries"; object: HIRExpr; field: "key" | "value"; type: TypeKind; span?: Span }
  | { kind: "StringWithCapacity"; capacity: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringPush"; str: HIRExpr; byte: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringPushStr"; str: HIRExpr; other: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringSubstr"; str: HIRExpr; start: HIRExpr; end: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringSlice"; str: HIRExpr; start: HIRExpr; end: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecSlice"; vec: HIRExpr; start: HIRExpr; end: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  // A slice view over memory Milo did not allocate: `std/foreign`'s rawSlice/rawSliceMut.
  // Unlike VecSlice there is no source Vec to bound the range against, so nothing is
  // checked here: the caller's `@unsafe` promise is the only guarantee.
  | { kind: "RawSlice"; ptr: HIRExpr; len: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  // Ownership taken back through a raw pointer: `std/foreign`'s adoptHeap/adoptVec, the
  // inverse of `Forget`. `type` is `heap` or `vec`, and that is the whole difference:
  // both are the pointer the caller supplied, re-labelled as something with drop glue.
  // `len` is present only for the vec form.
  | { kind: "Adopt"; ptr: HIRExpr; len?: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "StringFind"; str: HIRExpr; needle: HIRExpr; from?: HIRExpr; reverse: boolean; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "StringClone"; str: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "NumberToString"; value: HIRExpr; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "BoolToString"; value: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "JsonStringify"; value: HIRExpr; valueType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "Closure"; params: { name: string; type: TypeKind }[]; body: HIRStmt[]; captures: { name: string; type: TypeKind; mutable: boolean }[]; retType: TypeKind; type: TypeKind; isMove?: boolean; span?: Span }
  // indirect call through a bare C function pointer: no env argument
  | { kind: "CFnCall"; callee: HIRExpr; args: HIRArg[]; type: TypeKind; span?: Span }
  | { kind: "ClosureCall"; callee: HIRExpr; args: HIRArg[]; type: TypeKind; span?: Span }
  | { kind: "VecMap"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; resultElementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFilter"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecEach"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFind"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecAny"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSum"; vec: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecAll"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecFold"; vec: HIRExpr; init: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecIsEmpty"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecEnumerate"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecReverse"; object: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSwap"; object: HIRExpr; indexA: HIRExpr; indexB: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecInsert"; object: HIRExpr; index: HIRExpr; value: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecRemove"; object: HIRExpr; index: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecTruncate"; object: HIRExpr; length: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecContains"; vec: HIRExpr; value: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  // Total indexed read: `get(i)`, and the `first()`/`last()` sugar that lowers to it.
  // Out of range yields None instead of the panic `v[i]` raises.
  | { kind: "VecGetOpt"; object: HIRExpr; index: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecMinMax"; object: HIRExpr; elementType: TypeKind; isMax: boolean; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecIndexOf"; vec: HIRExpr; value: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecPosition"; vec: HIRExpr; callback: HIRExpr; elementType: TypeKind; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "VecExtend"; object: HIRExpr; other: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecRetain"; object: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecCapacity"; object: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "VecReserve"; object: HIRExpr; additional: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSort"; object: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSortBy"; object: HIRExpr; callback: HIRExpr; elementType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "VecSortByKey"; object: HIRExpr; callback: HIRExpr; elementType: TypeKind; keyType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "WrappingArith"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "SaturatingArith"; op: string; left: HIRExpr; right: HIRExpr; type: TypeKind; span?: Span }
  | { kind: "CheckedArith"; op: string; left: HIRExpr; right: HIRExpr; optionEnumName: string; type: TypeKind; span?: Span }
  | { kind: "BitIntrinsic"; intrinsic: string; value: HIRExpr; amount?: HIRExpr; span?: Span; type: TypeKind }
  | { kind: "OptionOp"; op: string; value: HIRExpr; default?: HIRExpr; enumName: string; type: TypeKind; span?: Span }
  | { kind: "SizeOf"; sizeType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "OffsetOf"; sizeType: TypeKind; fieldName: string; type: TypeKind; span?: Span }
  | { kind: "Zeroed"; zeroType: TypeKind; type: TypeKind; span?: Span }
  | { kind: "InterfaceCoerce"; value: HIRExpr; fromType: string; ifaceName: string; type: TypeKind; span?: Span }
  | { kind: "InterfaceMethodCall"; object: HIRExpr; ifaceName: string; methodIndex: number; args: HIRArg[]; type: TypeKind; span?: Span }
  | { kind: "IfExpr"; cond: HIRExpr; thenBody: HIRStmt[]; elseBody: HIRStmt[]; type: TypeKind; span?: Span };

export interface HIRArg {
  expr: HIRExpr;
  passByRef: boolean;
  refMut: boolean;
}

// ── Statements ──

export type HIRStmt =
  | { kind: "Let"; name: string; type: TypeKind; value: HIRExpr; mutable: boolean; span?: Span }
  // `isInit` marks a first write into a slot that holds no value yet (the generated
  // module-global initializer). The slot is still zeroinitializer, so running Drop on
  // it would hand a null pointer to a `drop` that dereferences.
  | { kind: "Assign"; target: HIRExpr; value: HIRExpr; isInit?: boolean; span?: Span }
  | { kind: "Return"; value: HIRExpr | null; retType: TypeKind; span?: Span }
  | { kind: "If"; cond: HIRExpr; thenBody: HIRStmt[]; elseBody: HIRStmt[] | null; span?: Span }
  | { kind: "While"; cond: HIRExpr; body: HIRStmt[]; invariants?: HIRContract[]; span?: Span }
  | { kind: "Break"; span?: Span }
  | { kind: "Continue"; span?: Span }
  | { kind: "ExprStmt"; expr: HIRExpr; span?: Span }
  | { kind: "Match"; subject: HIRExpr; arms: HIRMatchArm[]; enumName: string; subjectIsRef?: boolean; subjectIsMut?: boolean; span?: Span }
  | { kind: "UnsafeBlock"; body: HIRStmt[]; span?: Span }
  // `let g = p else { … }` over a `?&mut T` extern parameter. `ptr` is the incoming
  // pointer (the parameter's real ABI type), `elseBody` runs when it is null and always
  // diverges, and `name` binds an ordinary second-class ref to the pointee on the other
  // path. Not a Match: there is no enum, no tag and no payload to project — one icmp.
  | { kind: "NullRefUnwrap"; name: string; ptr: HIRExpr; inner: TypeKind; mutable: boolean; elseBody: HIRStmt[]; span?: Span }
  | { kind: "ForRange"; varName: string; varType: TypeKind; start: HIRExpr; end: HIRExpr; body: HIRStmt[]; invariants?: HIRContract[]; span?: Span }
  | { kind: "ForEach"; varName: string; varName2: string | null; varType: TypeKind; varType2: TypeKind | null; iterable: HIRExpr; iterableKind: "vec" | "string" | "hashmap" | "array"; body: HIRStmt[]; invariants?: HIRContract[]; span?: Span }
  | { kind: "ForIterator"; varName: string; varType: TypeKind; iterable: HIRExpr; nextMethod: string; optionEnumName: string; body: HIRStmt[]; invariants?: HIRContract[]; span?: Span }
  // `for line in text.lines()` / `for f in text.splitView(sep)`: the loop variable is a
  // `&string` view into `src`, so no piece is ever copied or allocated.
  | { kind: "ForStrView"; varName: string; varName2: string | null; varType: TypeKind; src: HIRExpr; sep: HIRExpr | null; mode: "lines" | "split"; body: HIRStmt[]; invariants?: HIRContract[]; span?: Span };

interface HIRMatchArm {
  pattern: HIRPattern;
  body: HIRStmt[];
}

export type HIRPattern =
  | { kind: "EnumPattern"; variant: string; bindings: { name: string; type: TypeKind }[]; tag: number }
  | { kind: "LiteralPattern"; value: number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool" }
  | { kind: "WildcardPattern" };

// ── Top-level ──

// Contracts reach codegen so debug builds can assert them at runtime
// (requires at entry, ensures at returns, invariant at the loop header).
export interface HIRContract {
  kind: "requires" | "ensures" | "invariant";
  expr: HIRExpr;
  span?: Span;
}

export interface HIRFunction {
  name: string;
  params: { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }[];
  retType: TypeKind;
  body: HIRStmt[];
  contracts?: HIRContract[];
  // `let __oldN = <expr>` bindings for every `old(...)` an `ensures` mentions, emitted at
  // entry ahead of the body — but only in a contract-checking build, so a release binary
  // pays nothing for a clause it never evaluates.
  oldSnapshots?: (HIRStmt & { kind: "Let" })[];
  isExtern: boolean;
  isVariadic: boolean;
  // @wrapping: the routine's + - * -x, div INT_MIN/-1 and over-shifts use defined modular
  // arithmetic instead of trapping (see docs/plans/overflow-semantics.md). Correctness dial
  // only — bounds/div-by-zero/ranged still trap, `as` conversions unchanged.
  isWrapping?: boolean;
  // Drives what the generated C header declares: the header is the library's published
  // API, so a helper the author never marked `pub` has no business in it.
  isPub?: boolean;
  sourceFile?: string; // origin file — DWARF DIFile/DISubprogram (set by lower from the resolver-stamped AST fn)
  line?: number;       // 1-based decl-line proxy (first body stmt) — DISubprogram line
}

export interface HIRStruct {
  name: string;
  fields: { name: string; type: TypeKind; cOpaque?: boolean }[];
  isExtern?: boolean;
  // From `@cLayout(...)`: verify these field offsets against the real C header at build time.
  cLayout?: { cType: string; header: string };
}

export interface HIREnum {
  name: string;
  variants: { name: string; tag: number; fields: TypeKind[] }[];
}

export interface HIRGlobal {
  name: string;
  // Declaring file, same role as HIRFunction.sourceFile: the partition key. A global must
  // be DEFINED in exactly one object file and declared external in the others, so per-module
  // codegen cannot work without knowing which module owns it.
  sourceFile?: string;
  type: TypeKind;
  value: HIRExpr;
  mutable: boolean;
  threadLocal?: boolean;
}

export interface HIRModule {
  structs: HIRStruct[];
  enums: HIREnum[];
  functions: HIRFunction[];
  globals: HIRGlobal[];
  dropImpls: Set<string>;
  itables: { concreteType: string; ifaceName: string; methods: string[] }[];
  userFnNames?: Set<string>;
  // Mangled symbol -> as-written name for the per-module renaming pass (src/mangle.ts).
  // Codegen needs it because two of its outputs are read by humans, not the linker: the
  // `Name { .. }` text `print` emits for a struct, and the DWARF `name` a debugger shows.
  displayNames?: Map<string, string>;
  // opaque extern struct names (dropped from `structs` since they have no body) — kept
  // so the C header generator can emit forward `typedef struct X X;` declarations
  opaqueTypes?: string[];
  // From `@cSig(...)`: extern fn signatures to verify against real C headers at build time.
  cSigs?: { fnName: string; header: string; sig: string; retType: TypeKind; params?: { type: TypeKind }[] }[];
  // From `@cValue(...)`: integer constants to verify against the C macros they transcribe.
  cValues?: { global: string; cName: string; header: string; value: string; signed: boolean }[];
  // From `@link("SDL2")` on extern fns: native libs to pass to the linker.
  linkLibs?: string[];
  // Globals whose initializer has to run (CheckResult.nonConstGlobals, carried through
  // so the driver can see it). Codegen puts exactly these in `@__milo.global_init`;
  // `emit-obj --no-entry` has nothing that calls it, so it rejects on this list.
  nonConstGlobals?: string[];
}
