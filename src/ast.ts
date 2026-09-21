// AST node types: what the parser produces and the checker walks.
export interface Span { line: number; col: number; file?: string }

export interface MiloType {
  name: string; // "i32", "u8", "bool", "void", etc.
  typeArgs?: MiloType[]; // generic type arguments, e.g. Option<i32>
  isPtr: boolean;
  ptrDepth?: number;   // pointer nesting: `**u8` has depth 2. Absent ⇒ isPtr?1:0 (single level)
  isRef: boolean;      // &T
  isRefMut: boolean;   // &mut T
  // `?&mut T` / `?&T` — a nullable extern reference. Set ALONGSIDE isRef/isRefMut, and
  // legal only on a parameter of an `extern` / `@externalLinkage` fn: the parser rejects
  // the spelling everywhere else (see parseType), so nothing downstream has to defend
  // against one turning up in a field, a local or a type argument. It is a signature
  // spelling, not a type: `resolve` maps it to `*T`, which is what the ABI already is.
  isNullableRef?: boolean;
  isArray: boolean;    // [T]
  arraySize: number | null; // [T; N] — null for dynamic
  isFn?: boolean;      // fn(T): R
  // `move (T) => R` — a closure that OWNS its captured environment, as opposed to a
  // bare function pointer or a by-reference closure, which own nothing. The distinction
  // is what makes an owning closure non-Copy: duplicating one would give two owners of
  // the same heap environment, which is why no destructor could exist for it before.
  isMoveFn?: boolean;
  isCFn?: boolean;     // extern (T) => R — bare C function pointer
  fnParams?: MiloType[];
  fnRet?: MiloType;
  rangeMin?: number;   // i32(0..50000) — range constraint
  rangeMax?: number;
}

export function simpleType(name: string): MiloType {
  return { name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
}

export interface Param {
  name: string;
  type: MiloType | null;
  // Binding site, for shadowing/redeclaration diagnostics to point at. Optional
  // because Param is also used in a couple of synthetic contexts with no source.
  span?: Span;
}

// `Param.type` is null only for a closure param whose type is inferred
// (parseClosure); every param the parser builds for a fn/method/trait/interface
// decl carries a written type. Paths that only ever see declared params use this
// to assert that invariant instead of silently defaulting.
export function declaredType(p: Param): MiloType {
  if (p.type === null) throw new Error(`internal: parameter '${p.name}' has no declared type (only closure params may omit one)`);
  return p.type;
}

export interface StructField {
  name: string;
  type: MiloType;
  // `@cOpaque` — filler with no C counterpart; @cLayout must not check it (see checker).
  attributes?: Attribute[];
}

export interface TypeParam {
  name: string;
  bounds: string[];
}

export interface Attribute {
  name: string;
  args: string[];
  // Parallel to `args`: how each was spelled. `@derive(Clone)` is an ident,
  // `@cLayout("sys/stat.h")` is a string — the values alone can't be told apart,
  // and an attribute that wants a path or a C type name must reject a bare ident.
  argKinds?: ("ident" | "string")[];
  // `@!name` (inner attribute, Rust `#![...]` analog) applies to the enclosing file/module
  // rather than the next declaration. Currently only `@!wrapping` uses it.
  inner?: boolean;
}

// ── Expressions ──

// value is a bigint so 64-bit literals (i64::MAX, u64 bit masks) round-trip
// losslessly — a JS number would round anything past 2^53 and miscompile.
export interface IntLit { kind: "IntLit"; value: bigint; span?: Span }
export interface FloatLit { kind: "FloatLit"; value: number; span?: Span }
export interface BoolLit { kind: "BoolLit"; value: boolean; span?: Span }
// `fromFString` marks a piece produced by desugaring `$"..."`. Braces in such a
// piece got there through an escape and are meant literally, so the
// missing-interpolation warning must not fire on them.
export interface StringLit { kind: "StringLit"; value: string; span?: Span; fromFString?: true }
export interface CharLit { kind: "CharLit"; value: number; span?: Span }
export interface Ident { kind: "Ident"; name: string; span?: Span }
export interface BinOp { kind: "BinOp"; op: string; left: Expr; right: Expr; span?: Span }
export interface UnaryOp { kind: "UnaryOp"; op: string; operand: Expr; span?: Span }
// `sigil` is set when the call was written with the `@` prefix (`@embedFile("x")`).
// Only compile-time builtins accept it; it changes nothing about the semantics, it
// just tells the checker not to warn about the bare spelling.
export interface Call { kind: "Call"; func: string; args: Expr[]; typeArgs?: MiloType[]; sigil?: boolean; span?: Span }
export interface StructLit { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[]; span?: Span }
export interface FieldAccess { kind: "FieldAccess"; object: Expr; field: string; span?: Span }

// `f64.NAN` / `f64.INF` / `f64.NEG_INF` (and f32) parse as a FieldAccess whose object is a
// type name, not a variable. Recognize that shape once so the checker types it and the
// lowering rewrites it to the literal — the two must agree on the exact value. Returns the
// float width and the IEEE value, or null for any other field access.
export function floatNamespaceConst(e: FieldAccess): { bits: number; value: number } | null {
  if (e.object.kind !== "Ident") return null;
  const bits = e.object.name === "f64" ? 64 : e.object.name === "f32" ? 32 : 0;
  if (bits === 0) return null;
  const value = e.field === "NAN" ? NaN : e.field === "INF" ? Infinity : e.field === "NEG_INF" ? -Infinity : null;
  return value === null ? null : { bits, value };
}
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
export interface IfExpr { kind: "IfExpr"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[]; span?: Span }

export type Expr = IntLit | FloatLit | BoolLit | StringLit | CharLit | Ident | BinOp | UnaryOp | Call
  | StructLit | FieldAccess | ArrayLit | ArrayRepeat | IndexAccess | EnumLit | Unwrap | Propagate | DefaultValue | CastExpr | MethodCall | ClosureExpr | RangeExpr | IsExpr | IfExpr | MatchExpr;

// ── Statements ──

export interface LetDecl { kind: "LetDecl"; name: string; type: MiloType | null; value: Expr; span?: Span }
export interface VarDecl { kind: "VarDecl"; name: string; type: MiloType | null; value: Expr; span?: Span }
export interface Assign { kind: "Assign"; target: Expr; value: Expr; span?: Span }
export interface Return { kind: "Return"; value: Expr | null; span?: Span }
export interface IfStmt { kind: "IfStmt"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null; span?: Span }
export interface WhileStmt { kind: "WhileStmt"; cond: Expr; invariants: Contract[]; body: Stmt[]; span?: Span }
export interface ExprStmt { kind: "ExprStmt"; expr: Expr; span?: Span }
export interface BreakStmt { kind: "BreakStmt"; span?: Span }
export interface ContinueStmt { kind: "ContinueStmt"; span?: Span }

export type Pattern =
  // `bindingSpans` is parallel to `bindings` — the identifier token's own position,
  // not the whole pattern's — so a shadowing/redeclaration diagnostic on binding i
  // can point at that name instead of the enclosing `Enum.Variant(...)`.
  | { kind: "EnumPattern"; enumName: string; variant: string; bindings: string[]; bindingSpans?: Span[]; span?: Span }
  | { kind: "LiteralPattern"; value: number | string | boolean; literalKind: "int" | "float" | "string" | "char" | "bool"; span?: Span }
  | { kind: "WildcardPattern"; span?: Span };

export interface MatchArm { pattern: Pattern; body: Stmt[] }
export interface MatchStmt { kind: "MatchStmt"; subject: Expr; arms: MatchArm[]; span?: Span }
export interface MatchExpr { kind: "MatchExpr"; subject: Expr; arms: MatchArm[]; span?: Span }
export interface IfLetStmt { kind: "IfLetStmt"; pattern: Pattern; subject: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null; span?: Span }
// `let Enum.Variant(b) = value else { ... }` — refutable bind that escapes into
// the enclosing scope; the else block must diverge (fail-early, bind-forward).
// `let P(b) = v else { … }`, plus the nullable-extern-reference unwrap `let g = p else { … }`.
// The second form has no enum and no variant to name, so `pattern` is a placeholder
// wildcard and `bindName` carries the binding instead. Its presence is what distinguishes
// the two forms; every walker that only visits `value` and `elseBody` needs no change.
export interface LetElseStmt { kind: "LetElseStmt"; pattern: Pattern; value: Expr; elseBody: Stmt[]; bindName?: string; span?: Span }

export interface UnsafeBlock { kind: "UnsafeBlock"; body: Stmt[]; span?: Span }
export interface ForInStmt { kind: "ForInStmt"; varName: string; varName2: string | null; iterable: Expr; invariants: Contract[]; body: Stmt[]; span?: Span }
export type Stmt = LetDecl | VarDecl | Assign | Return | IfStmt | WhileStmt | ExprStmt | MatchStmt | BreakStmt | ContinueStmt | IfLetStmt | LetElseStmt | UnsafeBlock | ForInStmt;

// ── Top-level ──

export interface StructDecl {
  kind: "StructDecl";
  name: string;
  span?: Span; // decl site — lets diagnostics point at the struct, and identifies its file
  typeParams: TypeParam[];
  fields: StructField[];
  // `invariant <expr>` clauses written after the closing brace. The expression names the
  // struct's own fields directly (`chr.len > 0`, not `self.chr.len > 0`) — the receiver is
  // implicit because an invariant has exactly one subject.
  invariants?: Contract[];
  attributes?: Attribute[];
  isExtern?: boolean;
  isOpaque?: boolean;
  isPub?: boolean;
}

export interface EnumVariant {
  name: string;
  fields: MiloType[];
  discriminant?: number; // explicit `= N` on a repr'd (C-like) enum; absent = prev + 1
}

export interface EnumDecl {
  kind: "EnumDecl";
  name: string;
  span?: Span; // decl site — identifies the enum's file (for visibility)
  typeParams: TypeParam[];
  variants: EnumVariant[];
  attributes?: Attribute[];
  isPub?: boolean;
  reprType?: string; // `enum Kind: i32 { ... }` — a C-like enum with an integer representation
}

export interface Contract {
  // `decreases` is a termination measure, not a boolean claim: an integer expression that
  // must strictly drop (and stay >= 0) across every self-recursive call or loop iteration.
  kind: "requires" | "ensures" | "invariant" | "decreases";
  expr: Expr;
  span?: Span;
}

export interface Function {
  kind: "Function";
  name: string;
  attributes?: Attribute[]; // `@cSig(...)` on an extern fn; other attrs are rejected by the checker
  // Set by the parser when the file carries a module-level `@!wrapping` directive, so this
  // fn lowers as if it had a per-fn `@wrapping` — without polluting `attributes` (which the
  // formatter reprints). Per-file: only fns parsed from the wrapping module get it.
  fromWrappingModule?: boolean;
  sourceFile?: string; // set by the resolver; used to diagnose cross-module name collisions
  // The name as written, when `name` is a compiler-generated one. A monomorphized
  // instance is called `foo_i64`, which nobody typed — diagnostics about the generic's
  // body should say `foo`.
  sourceName?: string;
  typeParams: TypeParam[];
  params: Param[];
  retType: MiloType;
  contracts: Contract[];
  body: Stmt[];
  isExtern: boolean;
  isVariadic: boolean;
  // `pub` marks a declaration importable from another file. Absent = file-private.
  // Distinct from `@externalLinkage`, which forces C external linkage (see checker.ts).
  isPub?: boolean;
  // Set by the parser to the function-name token — the anchor for fn-level
  // diagnostics (duplicate/shadow definitions). Optional: synthetic Function
  // nodes (e.g. monomorphized generics) may omit it.
  span?: Span;
}

export interface ImportDecl {
  kind: "ImportDecl";
  path: string;
  names: string[]; // exported names named in `from "path" import { a, b }` (glob imports don't exist — bare `import "path"` is a parse error)
  // Parallel to `names`: the local binding name for `x as y` (aliases[i] set only when renamed).
  // Used by per-package binding to rebind an imported symbol under a different local name.
  aliases?: (string | undefined)[];
  span?: Span;
}

export interface TraitMethod {
  name: string;
  // A method may carry its OWN type parameters (`fn map<R>(…)`), distinct from any on the
  // implementing type. An interface may not: dynamic dispatch needs one vtable slot per
  // method, and a per-instantiation method has no single address to put in one.
  typeParams?: TypeParam[];
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
  isPub?: boolean;
}

export interface ImplDecl {
  kind: "ImplDecl";
  traitName: string | null;
  typeName: string;
  typeParams: TypeParam[];
  methods: Function[];
  isUnsafe?: boolean;
  span?: Span;
}

// A user-defined `@derive(Name)`. The body is captured as a raw TOKEN slice rather than
// parsed: it is a template, not code, and `@name` in expression position is not a valid
// expression until a field name has been substituted for it. Expansion re-runs the parser
// over the substituted tokens, so a template is bound by exactly the same grammar and the
// same checker rules as hand-written code — the property `@derive(Json)` already has for
// emitting source (see src/derive-json.ts), kept here so a third-party derive cannot
// produce something a user could not have typed.
export interface DeriveTemplate {
  kind: "DeriveTemplate";
  name: string;              // the trait the generated impl implements
  body: import("./tokens").Token[]; // impl-block contents, braces excluded
  span?: Span;
  isPub?: boolean;
}

export interface InterfaceDecl {
  kind: "InterfaceDecl";
  name: string;
  methods: TraitMethod[];
  span?: Span;
  isPub?: boolean;
}

export interface TypeAlias {
  kind: "TypeAlias";
  name: string;
  // `type Handler<T> = (T) => Result<T, Error>` — the alias is a TEMPLATE, expanded per
  // use site by substituting the arguments into its body. Empty for an ordinary alias,
  // which stays what it was: a second spelling for one type.
  typeParams?: TypeParam[];
  type: MiloType;
  span?: Span;
  isPub?: boolean;
}

export interface GlobalDecl {
  kind: "GlobalDecl";
  name: string;
  type: MiloType | null;
  value: Expr;
  mutable: boolean;
  threadLocal?: boolean;
  span?: Span;
  isPub?: boolean;
  attributes?: Attribute[];
}

// Where each top-level name was declared, recorded per file BEFORE the flat
// namespace collapses same-named decls. Visibility needs the pre-collapse view:
// a decl deduped away (identical bodies in two modules) or overridden (a user fn
// beating a std one) is still a real definition in its own file, and that file's
// own references to it are legal. Derived from the merged program it would look
// private-to-somewhere-else and produce false errors.
export interface DeclOrigin { files: Set<string>; anyPub: boolean }
export interface FileImports { names: Set<string>; wholeFiles: Set<string> }

export interface DeclOrigins {
  values: Map<string, DeclOrigin>; // fns, globals
  types: Map<string, DeclOrigin>;  // structs, enums, traits, interfaces, aliases
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
  deriveTemplates: DeriveTemplate[];
  // File-level `@!wrapping` directive: the whole module is modular arithmetic. The parser
  // stamps `fromWrappingModule` on the file's own fns; this flag is kept so the formatter
  // can reprint the directive.
  moduleWrapping?: boolean;
  declOrigins?: DeclOrigins; // set by the resolver; absent for a bare Parser program
  // What each file's import lines admit, keyed by resolved path. `names` are the
  // declared names listed in `from "x" import { … }` (an alias is already rewritten to
  // the declared name); `wholeFiles` are modules the resolver imported on the file's
  // behalf (`@derive(Json)` pulls all of std/json). Absent for a bare Parser program.
  fileImports?: Map<string, FileImports>;
  // Names every file sees without an import: the prelude's own decls plus what it imports.
  preludeVisible?: Set<string>;
  // Manifest `deps` names whose files were actually loaded, i.e. the set of `$`
  // prefixes per-package mangling put on symbols (see src/mangle.ts). Empty/absent
  // when the program has no package dependencies.
  packageNames?: Set<string>;
  // Mangled symbol -> the name the programmer wrote, for every rename the per-module pass
  // performed (src/mangle.ts, display names). Empty when nothing was renamed. Every
  // human-facing surface (diagnostics, `print`, DWARF, LSP) renders through it.
  displayNames?: Map<string, string>;
  userFnNames?: Set<string>;
  userImplKeys?: Set<string>;   // `${typeName}.${method}` for user-defined impl methods
  entryFile?: string;           // the file being compiled; imports carry their own span.file
  // Imported names the entry file never mentions (resolver-computed; see unused-import).
  unusedImports?: { name: string; path: string; span?: Span }[];
  // User fns that shadow a stdlib/prelude fn with the same signature but a different
  // body (resolver-computed; see shadows-stdlib-override). Silent last-wins rebind.
  shadowedStdlib?: { name: string; stdlibFile: string; span?: Span }[];
}
