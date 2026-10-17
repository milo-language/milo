// HIR -> LLVM IR emission, including drop glue, monomorphization and the per-target
// calling conventions. IR uses opaque `ptr` (LLVM 15+), never `i8*`.
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRContract, HIRStruct, HIRGlobal } from "./hir";
import { LlvmTextBuilder, Ty, val, type LoadMeta, type Param } from "./ir";
import { guardLazyGlobals, LAZY_GUARD_PREFIX, LAZY_INIT_PREFIX } from "./lazy-globals";
import { type TypeKind, needsDrop, typeEq, typeName } from "./types";
import type { TargetInfo } from "./target";
import type { Span } from "./ast";
import type { PropagateBoxing } from "./checker";
import { genVecSort, genVecSortBy, genVecSortByKey, genVecMethodPreamble, genVecPop, genVecFind, genVecGetOpt, genVecMinMax, genVecIndexOf, genVecPosition, genVecMap, genVecFilter, genVecEach, genVecAny, genVecAll, genVecFold, genVecReverse } from "./codegen-vec";
import {
  F64_BUF, genStringConcat, genStringCmp, genStringOrd, genStringWithCapacity, genStringPush, genStringPushInt, genStringTruncate,
  genStringSetByte, genStringPushStr, genStringSubstr, genStringSlice, genNumberToString, genBoolToString, genStringClone, genStringFind,
} from "./codegen-string";
import { runtimeFn } from "./codegen-runtime";
import { genMatch, genMatchExpr, armTailExpr, matchArmLocals, matchExprAsStmt } from "./codegen-match";
import {
  genHashMapNew, genHashMapInsert, genHashMapGet, genHashMapGetOrDefault, genHashMapContains, genHashMapModify,
  genHashMapGetOrInsertWith, genHashMapRemove, genHashMapWithCapacity, genHashMapClone, genHashMapClear, genHashMapEntries,
  HM_DATA, HM_CAP, HASHMAP_FIELDS, HASH_SEED_FN,
} from "./codegen-map";
import { cDeclGuards, type CSigClaim, type CValueClaim } from "./c-guards";
import { DwarfEmitter, markDbg } from "./codegen-dwarf";
import { classifyArg, classifyRet, AbiError, type ArgClass, type RetClass, type AbiStruct, type AbiLeaf } from "./abi";
import { resolve, relative, isAbsolute } from "path";
import { STDLIB_DIR } from "./stdlibBundle";
import { must } from "./must";
import {
  DropGlueSeen, emitDeepCloneFromPtr, emitDropValueBody, ensureStructDropHelper, dropStructFieldsExcept,
} from "./codegen-drop";
import { display } from "./mangle";
import { mapSymbols } from "./cgu";
import { OwnLedger, type CopyDecl } from "./codegen-own";

// Every HIRExpr kind that is NOT an owned temporary: it yields a scalar, a void, a
// borrowed view, or a place someone else already owns, so discarding its result frees
// nothing and drop glue must not run on it.
//
// Listed rather than left as the implicit `false` at the bottom of `isOwnedTempExpr`,
// because implicit is exactly how `VecRemove` was missed: it moves an element out of the
// buffer like its sibling `VecPop`, `VecPop` was in the list and it was not, and
// `v.remove(0)` as a statement therefore destroyed nothing. `tests/ownedTempCoverage.test.ts`
// requires every kind in `HIRExpr` to appear either here or in `isOwnedTempExpr`, so a
// newly added node cannot inherit an answer nobody chose.
// On by default: scripts/differential.ts over every fixture and runnable example showed no
// output or exit-code change at -O2 or -O3. `--no-noalias` (main.ts) sets MILO_NOALIAS=0 to
// rule it out when chasing a miscompile. An environment variable rather than a Codegen
// constructor argument so the flag reaches every compile path, `milo run`/`test` and
// separately compiled modules included, without threading through each signature.
export function noaliasEnabled(): boolean {
  return process.env.MILO_NOALIAS !== "0";
}

// Below this many live bytes a grow is malloc + memcpy + free rather than realloc. A
// small block cannot be remapped, so realloc saves no memory there, and macOS's realloc
// first looks the pointer's zone and size up: respond's string building (buffers of a
// few hundred bytes) ran 13% slower on realloc than on the copy. At a page and above
// the remap is what keeps peak RSS at the new size (vec_grow: 132 MB -> 68 MB).
const REALLOC_MIN_BYTES = 4096;

export const NOT_OWNED_TEMP: readonly string[] = [
  "ArrayLen", "ArrayRepeat", "BitIntrinsic", "BoolLit", "CFnCall", "Cast",
  "CharLit", "CheckedArith", "Closure", "EnumTryFrom", "FloatLit",
  "Forget", "HashMapClear", "HashMapContains", "HashMapGetOrInsertWith", "HashMapInsert", "HashMapLen", "HashMapModify",
"HashMapNew", "HashMapRemove", "HeapCreate", "HeapPtr", "Ident",
  "IntLit", "InterfaceCoerce", "IsCheck", "MemSwap", "OffsetOf",
  "PtrDeref", "RangeCheck", "RawSlice", "SaturatingArith", "SizeOf", "StringCstr",
  "StringFind", "StringLen", "StringLit", "StringPush", "StringPushInt", "StringPushStr", "StringSetByte", "StringSlice", "StringTruncate",
  "UnaryOp", "VecAll", "VecAny", "VecCapacity", "VecContains", "VecEach",
  "VecEnumerate", "VecExtend", "VecIndexOf", "VecInsert", "VecIsEmpty",
  "VecLen", "VecPosition", "VecPtr", "VecPush", "VecReserve", "VecRetain",
  "VecReverse", "VecSlice", "VecSort", "VecSortBy", "VecSortByKey", "VecSum",
  "VecSwap", "VecTruncate", "WrappingArith", "Zeroed",
];

// `.` can't appear in a Milo identifier, so this never collides with a user function.
export const GLOBAL_INIT_FN = "__milo.global_init";


// The bounds-check message is one module-wide global, so the literal and the array length
// in its declaration have to stay in lockstep — a mismatch is an LLVM verifier error.
const BOUNDS_ERR_MSG = "milo: array index out of bounds: %lld/%lld at %s:%d\n";
const BOUNDS_ERR_IR = BOUNDS_ERR_MSG.replace(/\n/g, "\\0A") + "\\00";
const BOUNDS_ERR_LEN = BOUNDS_ERR_MSG.length + 1;

interface ExternAbiInfo {
  args: (ArgClass | null)[]; // per fixed param; null = direct (scalar/ptr/ref — no rewrite)
  ret: RetClass;
}

export interface StructLayout {
  name: string;
  fields: { name: string; type: string; typeKind: TypeKind }[];
}

export interface EnumVariant { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }

export interface EnumLayout {
  name: string;
  // Each variant is laid out like the C struct `{ i32 tag; <its fields> }`, so its first
  // field sits right after the tag at that field's own alignment, not after padding some
  // other variant needs (see variantFieldOffsets). The enum is the largest such struct,
  // rounded to the enum's alignment (max of the tag's and every field's). The LLVM type
  // is one padding-free array of that alignment's integers, `{ [size/A x i<A*8>] }`; the
  // tag is its first 4 bytes. It must have no padding: a variant's field can sit where
  // `{ i32, [n x i64] }` pads, and LLVM drops padding bytes when it splits a whole-enum
  // load or store. Nothing indexes the array (assertEnumPayloadPacked).
  size: number;          // total bytes; 0 = fieldless enum (`{ i32 }`)
  payloadAlign: number;  // max alignment over every variant's fields
  variants: Map<string, EnumVariant>;
  // Set for an Option-shaped enum whose payload has a value safe code cannot produce
  // (see nicheOf). The enum is then laid out as the payload alone, `{ P }`: the fieldless
  // variant is the niche value in the payload's leading integer, the other variant is the
  // payload itself. No tag word exists, so every tag and payload access goes through
  // loadEnumTag / storeEnumTag / enumPayloadPtr.
  niche?: EnumNiche;
}

interface EnumNiche {
  payloadTy: string;     // LLVM type of the payload (and, wrapped, of the enum)
  intTy: string;         // the integer at offset 0 that carries the niche
  value: string;         // the niche value as an LLVM constant of intTy
  noneTag: number;       // tag of the fieldless variant
  someTag: number;       // tag of the payload variant
}


export interface LocalInfo { type: string; typeKind: TypeKind; mutable: boolean; isRef: boolean; addr?: string }
export interface DroppableLocal { name: string; typeKind: TypeKind; aliveFlag: string; addr: string; consumeCursor?: string }

const STRING_TY = Ty.of("%String");
const VEC_TY = Ty.of("%Vec");
// One name for codegen's return shape: the IR lines an expression emits, the SSA value it
// leaves the result in, and that value's LLVM type.
//
// `value` and `type` are both bare `string` and adjacent, so nothing but argument order
// stops them being swapped — the kind of mistake that produces IR which is wrong rather
// than invalid. Making them distinct branded types is the real fix and costs ~390 call-site
// changes here; this alias is the one place that change would need to land, and Milo's
// newtypes make it free on the other side of the port. See docs/backlog.md.
export type Gen = [lines: string[], value: string, type: string];


// Attribute-group number for the `--sanitize` marker. Emitted IR carries no other
// attribute groups, so 0 is always free.
const SANITIZE_ATTRS = 0;

// Which sanitizer `--sanitize` means: AddressSanitizer, or ThreadSanitizer under
// `--sanitize=thread` (MILO_SANITIZE=thread). Read by the function attribute below and the
// link flag in main.ts, which have to agree: clang instruments only functions carrying the
// matching `sanitize_*` attribute.
export function sanitizerKind(): "address" | "thread" {
  return process.env.MILO_SANITIZE === "thread" ? "thread" : "address";
}

// An if/match expression's result slot. `cloneViews`: the fork's value is owned
// (blockValueOwnsResult) but some arm yields a view of a place it does not consume, so
// that arm stores a clone and the place keeps its own value.
export type ForkSlot = { addr: string; ty: string; cloneViews?: boolean };

export class Codegen {
  public target: TargetInfo;
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  public locals = new Map<string, LocalInfo>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean; wantsStringAddr?: boolean[]; refAttrs?: string[] }>();
  // milo fns whose big-aggregate return is lowered to a hidden `ptr %__sret.out`
  // first param (see genStoreInto). Excludes main and exported fns (C ABI).
  private sretFns = new Set<string>();
  private currentFnSret = false;
  // extern fns that pass/return a struct by value need native-ABI lowering (byval/sret/coerce)
  private externAbi = new Map<string, ExternAbiInfo>();
  public structLayouts = new Map<string, StructLayout>();
  private cLayoutStructs: HIRStruct[] = [];
  // `extern type` names: a pointer to one is a C handle whose pointee Milo never sizes.
  private opaqueTypes = new Set<string>();
  private cSigs: CSigClaim[] = [];
  private cValues: CValueClaim[] = [];
  public enumLayouts = new Map<string, EnumLayout>();
  private userDeclaredFns = new Set<string>();
  public needsBoundsCheck = false;
  private needsGlobalInit = false;
  private needsSchedYield = false;
  // Module globals whose initializer runs code: zeroed at load, filled on first read
  // (src/lazy-globals.ts places the guards, emitLazyGlobals the machinery).
  private lazyGlobals = new Map<string, HIRGlobal>();
  // Runtime-initialized globals nothing reads, filled before main by GLOBAL_INIT_FN.
  public startupGlobals: string[] = [];
  private needsOverflowCheck = false;
  private needsRangeCheck = false;
  private needsContractCheck = false;
  // ensures clauses of the function being generated; checked at every return site
  private currentEnsures: HIRContract[] = [];
  private trapOnOverflow = false;
  // Independent of trapOnOverflow: `requires`/`ensures`/`invariant` become runtime
  // asserts. Both default on at -O0 and off above it, but they answer different
  // questions, so `--contract-checks` / `--overflow-checks` set them separately.
  private contractChecks = false;
  private usedOverflowIntrinsics = new Set<string>();
  private needsPrintf = false;
  private needsDprintf = false;
  private needsFflush = false;
  private needsWrite = false;
  private needsPutchar = false;
  private needsFwrite = false;
  private needsIob = false;
  private needsStderrSym = false;
  private needsSetvbuf = false;
  private needsExit = false;
  public needsMalloc = false;
  public needsFree = false;
  private needsRealloc = false;
  private emittedBufAppend = false;
  private emittedIntFmt = false;
  private emittedStrReserve = false;
  private emittedStrRt = false;
  public needsMemcpy = false;
  private needsStrlen = false;
  public needsMemcmp = false;
  public hasStringType = false;
  public hasVecType = false;
  public hasHashMapType = false;
  public needsGetentropy = false;
  private needsStrtod = false;
  private loopHeader: string | null = null;
  private loopExit: string | null = null;
  private loopDropStart: number = 0;

  // Pending temporaries: owned values an expression has already evaluated but not yet
  // handed to their consumer, e.g. `wrap(q)` in `$"{wrap(q)} {part(n)?}"` or `a()` in
  // `f(a(), b()?)`. An early exit out of the middle of the expression (`?`, or a
  // `return`/`break`/`continue` in an if/match arm used as a value) must drop them, or
  // they leak: they are SSA values, so the locals' drop glue never sees them. Each entry
  // emits the drop of one value. genExpr pushes a child's result when its parent is in
  // PENDING_PARENTS and truncates to its entry mark on return (by then the parent has
  // consumed its operands); aggregate literals push their partly built storage
  // explicitly. Values queued on argTempDrops are pending too and are dropped alongside.
  private pend = {
    temps: [] as { val?: string; emit: (lines: string[]) => void }[],
    parents: [] as string[],
    // stack heights at the innermost loop body's entry: break/continue drop only above
    loopTemps: 0,
    loopArgTemps: 0,
  };
  // Constructs that evaluate every operand before consuming any. Anything else (if/match
  // arms, `??` defaults, combinators) may consume or branch between operands, so its
  // children are not tracked: a missed leak there is the old behaviour, a wrong drop
  // would be a double free.
  private static PENDING_PARENTS = new Set<string>(["Call", "CFnCall", "ClosureCall", "InterfaceMethodCall", "BinOp"]);

  // Bounds-check elision, narrow and provable.
  //
  // `for i in 0..v.len { ... v[i] ... }` cannot go out of range: the loop bound IS
  // the length being checked against. Recording those (loop variable, container)
  // pairs lets the subscript skip its check — the ONLY way this is unsound is if
  // the container's length changes inside the loop, which `loopBodyMutates` below
  // rejects conservatively.
  //
  // This is deliberately not a range analysis. It fires on the exact shape above
  // and nothing else — an index of `i + 1`, a bound that merely happens to equal
  // the length, or a container reached through anything but a name or one field
  // hop all keep their check. Widening it to affine indices wants a range lattice
  // rather than a pattern.
  // A name is not an identity: a function can declare the same name twice in
  // sibling scopes, and a `let` is not a mutation, so `loopBodyMutates` does not
  // reject one. Each entry therefore carries the LocalInfo record the name
  // resolved to when the proof was made, and a use only counts as proven when the
  // name still resolves to that same record — object identity, since every
  // declaration allocates a fresh record and the scope restores put the original
  // back. This half of the guard is defence in depth: the checker rejects nested
  // shadowing, so no body can currently redeclare a name an enclosing proof
  // covers. `hoistedLens` below is where the same hazard was live and observed.
  private provenInRange: { loopVar: string; container: string; containerDecl?: LocalInfo; loopVarDecl?: LocalInfo }[] = [];

  // Loop-invariant lengths, hoisted into the preheader.
  //
  // Every subscript reloads the container's length to check against. LLVM cannot
  // hoist that load out of a loop on its own: a store to `v[i]` and a load of
  // `v.len` are both reached through plain `ptr`s with no type information, so it
  // has to assume the store might have clobbered the length. Nothing in safe Milo
  // can — a length only moves through push/pop/clear or a whole-container
  // assignment, all of which `loopBodyMutates` rejects. So when the body cannot
  // resize a container, the length is loaded ONCE before the loop and every check
  // inside compares against that value. The check still happens; it just stops
  // paying for a memory round trip per element.
  //
  // Keyed by source name, so the entry records which declaration that name meant
  // when the length was loaded (see `provenInRange` above for why a name alone is
  // not an identity).
  private hoistedLens: Map<string, { len: string; decl?: LocalInfo }>[] = [];
  private globalVars = new Map<string, { type: string; typeKind: TypeKind }>();
  private userFnNames = new Set<string>();
  private exportedFnNames = new Set<string>();
  // Mangled symbol -> as-written name (src/mangle.ts). Codegen emits two things a human
  // reads: the `Name { .. }` text behind `print`/`$"…"`, and DWARF names.
  private displayNames?: Map<string, string>;
  // Droppable locals are identified by their slot ADDRESS. A function can hold
  // several locals with the same name in different scopes, so re-resolving a
  // name through the current scope picks an unrelated slot.
  // `consumeCursor`: the temporary a consuming for-in owns (genConsumedIterable). Its
  // elements before the cursor were moved into the loop binding, so dropping it destroys
  // only [cursor, len) and then frees the buffer.
  public droppableLocals: DroppableLocal[] = [];
  public readonly own = new OwnLedger({
    needsDropCg: tk => this.needsDropCg(tk),
    isOwnedTempExpr: e => this.isOwnedTempExpr(e),
    local: name => this.locals.get(name),
    localAddr: name => this.localAddr(name),
    aliveFlagAt: addr => this.droppableLocals.find(d => d.addr === addr)?.aliveFlag,
    fieldFlags: addr => this.fieldMoveFlags.get(addr),
  });
  public droppableEnums = new Set<string>();
  public dropImpls = new Set<string>();
  public dropGlueSeen = new DropGlueSeen();
  private structDropCache = new Map<string, boolean>();
  private generatedJsonEscapeHelper = false;
  private generatedF64FormatHelper = false;
  private generatedF32FormatHelper = false;
  private needsStrtof = false;
  // Structural drop: free a value's heap storage without running any user Drop impl, the
  // exact inverse of emitDeepCloneFromPtr (which never runs a user Clone). A structural
  // clone of a resource shares its handle with the original, so releasing it would release
  // the original's. A TypeKind object in this set is dropped structurally wherever it is
  // dropped (scope exit, early return, break), so the mode travels with the local.
  public structuralDropTypes = new WeakSet<TypeKind>();
  public structuralDrop = false;
  private dropHelperBodies: string[][] = [];
  // Method count per interface, so a `Heap<Iface>` drop knows which itable slot holds the
  // concrete type's destructor. Populated before any body is generated; the itable
  // globals themselves are emitted much later, in the finalization pass.
  public ifaceMethodCounts = new Map<string, number>();
  private helperFnBodies: string[][] = [];
  private emittedStrFind = false;
  // Inside a closure body: capture alloca name -> pointer to its liveness flag in the
  // environment. A move out of a capture clears the flag so the env drop glue skips it.
  private captureFlagByAddr = new Map<string, string>();
  private closureBodies: string[][] = [];
  private closureCounter = 0;
  // `&mut` params that carry pointer attributes, per fn: what applyNoalias may mark.
  private noaliasCandidates = new Map<string, string[]>();
  // Closures whose environment holds pointers to the creator's locals, for applyNoalias.
  private byRefClosures = new Set<string>();
  // Mutable module globals by IR name, for applyNoalias.
  private mutableGlobals = new Set<string>();
  public scopeCounter = 0;
  public entryAllocas: string[] = [];
  // Every atomic intrinsic is sequentially consistent (seq_cst on both the success and
  // failure orderings of a cmpxchg). Milo deliberately exposes no ordering parameter —
  // see docs/site/features/concurrency.md. `bool` widths hold an i1 in a byte of memory.
  private static ATOMIC_INTRINSICS: Record<string, { kind: "load" | "store" | "rmw" | "cas"; rmwOp?: string; ty: string; align: number; isBool?: boolean }> = {
    _atomicLoadI64: { kind: "load", ty: "i64", align: 8 },
    _atomicStoreI64: { kind: "store", ty: "i64", align: 8 },
    _atomicAddI64: { kind: "rmw", rmwOp: "add", ty: "i64", align: 8 },
    _atomicSubI64: { kind: "rmw", rmwOp: "sub", ty: "i64", align: 8 },
    _atomicSwapI64: { kind: "rmw", rmwOp: "xchg", ty: "i64", align: 8 },
    _atomicCasI64: { kind: "cas", ty: "i64", align: 8 },
    _atomicLoadI32: { kind: "load", ty: "i32", align: 4 },
    _atomicStoreI32: { kind: "store", ty: "i32", align: 4 },
    _atomicAddI32: { kind: "rmw", rmwOp: "add", ty: "i32", align: 4 },
    _atomicSubI32: { kind: "rmw", rmwOp: "sub", ty: "i32", align: 4 },
    _atomicSwapI32: { kind: "rmw", rmwOp: "xchg", ty: "i32", align: 4 },
    _atomicCasI32: { kind: "cas", ty: "i32", align: 4 },
    _atomicLoadBool: { kind: "load", ty: "i8", align: 1, isBool: true },
    _atomicStoreBool: { kind: "store", ty: "i8", align: 1, isBool: true },
    _atomicSwapBool: { kind: "rmw", rmwOp: "xchg", ty: "i8", align: 1, isBool: true },
    _atomicCasBool: { kind: "cas", ty: "i8", align: 1, isBool: true },
  };
  private static BUILTINS = new Set(["print", "eprint", "format", "flush", "exit", "assert", "todo", "max", "min", "_miloArgCount", "_miloArgAt", "_cstrToString", "_bytesToString", "_strDataPtr", "_putByte", "_loadU8", "_loadI32", "_callClosureVoid", ...Object.keys(Codegen.ATOMIC_INTRINSICS), "_schedulerGet", "_schedulerSet", "_panicHookSet"]);
  private usesSchedulerGlobal = false;
  // Set once any panic site is emitted: every panic first calls through
  // @_milo_panic_hook (see panicAbort), so the global has to exist.
  private usesPanicHook = false;
  private currentFnName = "";
  // Set for the duration of a `@wrapping` function: + - * -x, div INT_MIN/-1 and over-shifts
  // use defined modular arithmetic instead of trapping. Div-by-zero, bounds, ranged still trap.
  private currentFnWrapping = false;
  private itableLayouts = new Map<string, { globalName: string; methodCount: number }>();

  private filePath?: string;

  // Overflow/range/contract failures print `file:line`. Every module merges into one
  // LLVM module, so the file has to come from the *check's own span* — a single
  // module-wide constant named the entry file and reported std failures as if they
  // were in the user's main file, which is undiagnosable. One interned constant per
  // distinct file; only the files that actually contain a check are emitted.
  private checkFileConstants = new Map<string, string>();

  // DWARF metadata for -g (src/codegen-dwarf.ts). Scope is resolved lazily in its final
  // text pass rather than threaded through the recursive emitters.
  private emitDebug = false;
  private dwarf = new DwarfEmitter({
    displayName: s => display(this.displayNames, s),
    filePath: () => this.filePath,
    structLayouts: this.structLayouts,
    enumLayouts: this.enumLayouts,
    llvmType: t => this.llvmType(t),
    typeSize: ty => this.typeSize(ty),
    typeSizeOf: t => this.typeSizeOf(t),
    structFieldOffset: (f, i) => this.structFieldOffset(f, i),
    structPayloadSize: f => this.structPayloadSize(f),
    variantFieldOffsets: f => this.variantFieldOffsets(f),
  });
  // M2 — local variable inspection. currentSubprogram{Id,FileId} scope the
  // DILocalVariables of the function being emitted; null while a closure/trampoline
  // body is generated so its locals are never mis-scoped (the final pass also strips
  // any dbg.declare that lands in a subprogram-less function as a backstop).
  // Blank the source path out of every runtime panic message. In a binary shipped to
  // people who will never hold the source, the path describes the build machine's
  // filesystem and nothing else. Line numbers stay: alone they identify nothing, and
  // they are all that is left to correlate a user-reported panic against.
  private stripPanicLocations = false;
  private sanitize = false;
  private currentSubprogramId: number | null = null;
  private currentSubprogramFileId = 0;
  private usedDbgDeclare = false;

  constructor(target: TargetInfo, filePath?: string, trapOnOverflow = false, emitDebug = false, contractChecks = false, stripPanicLocations = false, sanitize = false) {
    this.target = target;
    this.filePath = filePath;
    this.trapOnOverflow = trapOnOverflow;
    this.emitDebug = emitDebug;
    this.contractChecks = contractChecks;
    this.stripPanicLocations = stripPanicLocations;
    this.sanitize = sanitize;
  }

  // The MSVC CRT is not POSIX: the byte-level I/O the print builtins lower to has
  // different names (`_write`), narrower types (LLP64 — `_write` takes/returns 32-bit
  // where POSIX `write` is 64-bit), or no equivalent at all (`dprintf`). Each divergence
  // is handled at the emission site rather than by a blanket rename table, because the
  // signatures differ too, and a renamed call with the wrong arity miscompiles silently.
  private get isWindows(): boolean { return this.target.os === "windows"; }

  // Byte-exact write of `len` bytes at `ptr` to a fd. NUL-correct, unlike printf %s.
  private emitFdWrite(lines: string[], fd: number, dataPtr: string, lenVal: string): void {
    this.needsWrite = true;
    if (!this.isWindows) {
      lines.push(`  call i64 @write(i32 ${fd}, ptr ${dataPtr}, i64 ${lenVal})`);
      return;
    }
    // _write's count is `unsigned int`, so the i64 length must be truncated. A string
    // longer than 4 GiB would wrap here; that is also true of the C call itself.
    const n32 = this.nextTemp();
    lines.push(`  ${n32} = trunc i64 ${lenVal} to i32`);
    lines.push(`  call i32 @_write(i32 ${fd}, ptr ${dataPtr}, i32 ${n32})`);
  }

  // Byte-exact write of a Milo string to stdout, through stdio's own buffer.
  //
  // print() used to fflush + write(2) per call, which is two syscalls per line — on a
  // piped stdout that dominated any loop that prints. fwrite is length-counted, so it
  // is just as NUL-correct as write(), and because it shares stdout's buffer with
  // printf there is nothing left to order by hand: the fflush goes away with it.
  // Buffering matches C's: line-buffered on a TTY, block-buffered on a pipe, and
  // drained by exit() (and by the explicit fflush in panicAbort).
  //
  // Getting at stdout is the only non-portable part — it is a data symbol whose name
  // differs per libc, and a function call on MSVC.
  private emitStdoutWrite(lines: string[], dataPtr: string, lenVal: string): void {
    this.needsFwrite = true;
    const handle = this.nextTemp();
    if (this.isWindows) {
      this.needsIob = true;
      lines.push(`  ${handle} = call ptr @__acrt_iob_func(i32 1)`);
    } else {
      lines.push(`  ${handle} = load ptr, ptr @${this.stdoutSymbol}`);
    }
    lines.push(`  call i64 @fwrite(ptr ${dataPtr}, i64 1, i64 ${lenVal}, ptr ${handle})`);
  }

  // Apple's libc exposes stdout as `__stdoutp`; glibc/musl as `stdout`.
  private get stdoutSymbol(): string { return this.target.os === "darwin" ? "__stdoutp" : "stdout"; }
  private get stderrSymbol(): string { return this.target.os === "darwin" ? "__stderrp" : "stderr"; }

  // eprint's counterpart of emitStdoutWrite: a string part goes to stderr by length.
  // It used to go through dprintf's `%.*s`, whose precision is a C int, so a string over
  // 2 GiB printed nothing (the precision wrapped negative and dprintf failed) and one
  // over 4 GiB printed only the low 32 bits' worth. stderr is unbuffered, so this write
  // and the dprintf calls around it reach fd 2 in program order.
  private emitStderrWrite(lines: string[], dataPtr: string, lenVal: string): void {
    this.needsFwrite = true;
    const handle = this.nextTemp();
    if (this.isWindows) {
      this.needsIob = true;
      lines.push(`  ${handle} = call ptr @__acrt_iob_func(i32 2)`);
    } else {
      this.needsStderrSym = true;
      lines.push(`  ${handle} = load ptr, ptr @${this.stderrSymbol}`);
    }
    lines.push(`  call i64 @fwrite(ptr ${dataPtr}, i64 1, i64 ${lenVal}, ptr ${handle})`);
  }

  // A SIGKILL cannot flush stdio, so a program killed by a watchdog (scripts/guard.ts,
  // a CI timeout) with a piped stdout loses every line it printed — precisely the case
  // where that output is the only evidence of where it hung. Block buffering on a pipe
  // is still the right default for throughput (see emitStdoutWrite), so retuning is
  // opt-in and belongs to whoever might do the killing: set MILO_LINE_BUFFERED and pay
  // a write per line to get output up to the hang instead of nothing.
  private static readonly LINE_BUF_INIT_FN = "__milo_line_buffer_init";

  private emitStdoutBufferingOptIn(lines: string[]): void {
    if (this.target.os === "none") return; // freestanding: no environment, no stdio streams
    // Record/replay decides first, before any I/O or initializer: under MILO_RECORD or
    // MILO_REPLAY it restarts the process with ASLR off, and turns on the fixed-address
    // heap so initializers' allocations already land where they will on replay.
    if (this.fnSigs.has("miloReplayStart")) lines.push(`  call void @miloReplayStart(ptr %_milo_argv)`);
    this.needsSetvbuf = true;
    lines.push(`  call void @${Codegen.LINE_BUF_INIT_FN}()`);
    // Before global init too: an initializer may build a HashMap.
    this.needsRrHashInit = true;
    lines.push(`  call void @${Codegen.RR_HASH_INIT_FN}()`);
  }

  // HashMap seeds are entropy, and they decide iteration order, which a program can
  // print. Under record/replay (MILO_RECORD / MILO_REPLAY, std/replay) seeds come from
  // a fixed sequence instead, so a recorded run and its replay iterate every map the
  // same way without a trace record per map. The decision is made here, at process
  // start, because std/replay removes both variables from the environment once it
  // has read them (so child processes do not write into the parent's trace).
  private static readonly RR_HASH_INIT_FN = "__milo_rr_hash_init";
  private static readonly RR_HASH_SEED_GLOBAL = "__milo_rr_hseed";
  private needsRrHashInit = false;

  private rrHashInitFn(): string[] {
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: Codegen.RR_HASH_INIT_FN, ret: Ty.void, params: [], internal: true });
    // A program with no HashMap has no seed to fix; keep its startup to a bare call.
    if (!this.needsGetentropy) {
      lines.push("  ret void");
      b.endFn();
      return lines;
    }
    lines.push(`  br label %rr.check0`);
    // Set and non-empty, matching std/replay, which treats an empty value as unset.
    const vars = ["MILO_RECORD", "MILO_REPLAY"];
    vars.forEach((_, i) => {
      const next = i + 1 < vars.length ? `rr.check${i + 1}` : "rr.done";
      lines.push(`rr.check${i}:`);
      lines.push(`  %v${i} = call ptr @getenv(ptr @.milo_rr_env${i})`);
      lines.push(`  %null${i} = icmp eq ptr %v${i}, null`);
      lines.push(`  br i1 %null${i}, label %${next}, label %rr.byte${i}`);
      lines.push(`rr.byte${i}:`);
      lines.push(`  %b${i} = load i8, ptr %v${i}`);
      lines.push(`  %empty${i} = icmp eq i8 %b${i}, 0`);
      lines.push(`  br i1 %empty${i}, label %${next}, label %rr.det`);
    });
    lines.push("rr.det:");
    // Any nonzero start works; this one spells "milorr".
    lines.push(`  store i64 120364506550898, ptr @${Codegen.RR_HASH_SEED_GLOBAL}`);
    lines.push("  br label %rr.done");
    lines.push("rr.done:");
    lines.push("  ret void");
    b.endFn();
    vars.forEach((name, i) => {
      lines.push(`@.milo_rr_env${i} = private unnamed_addr constant [${name.length + 1} x i8] c"${name}\\00"`);
    });
    return lines;
  }

  private hashSeedFn(): string[] {
    const lines: string[] = [];
    lines.push(`@${Codegen.RR_HASH_SEED_GLOBAL} = internal global i64 0`);
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: HASH_SEED_FN, ret: Ty.i64, params: [], internal: true });
    lines.push("  %buf = alloca i64");
    lines.push(`  %det = load i64, ptr @${Codegen.RR_HASH_SEED_GLOBAL}`);
    lines.push("  %isDet = icmp ne i64 %det, 0");
    lines.push("  br i1 %isDet, label %seed.det, label %seed.os");
    lines.push("seed.det:");
    // Golden-ratio step (0x9E3779B97F4A7C15): consecutive maps get well-spread seeds.
    // Atomic because maps can be built on Promise.blocking threads too; the sequence
    // is only reproducible for maps built in a reproducible order, which is the main
    // thread's.
    lines.push(`  %old = atomicrmw add ptr @${Codegen.RR_HASH_SEED_GLOBAL}, i64 -7046029254386353131 monotonic`);
    lines.push("  %next = add i64 %old, -7046029254386353131");
    lines.push("  ret i64 %next");
    lines.push("seed.os:");
    // 2 = BCRYPT_USE_SYSTEM_PREFERRED_RNG, which is what permits the NULL algorithm
    // handle; the length is a 32-bit ULONG here, not getentropy's size_t.
    if (this.isWindows) lines.push(`  call i32 @BCryptGenRandom(ptr null, ptr %buf, i32 8, i32 2)`);
    else lines.push(`  call i32 @getentropy(ptr %buf, i64 8)`);
    lines.push("  %v = load i64, ptr %buf");
    lines.push("  ret i64 %v");
    b.endFn();
    return lines;
  }

  // Emitted once, as its own function rather than inline in main, for two reasons: the
  // branch would otherwise split main's entry block and push every following alloca out
  // of it (see allocaHoist), and the call has to be skipped rather than made harmless
  // when the variable is unset. There is no no-op setvbuf: MSVC's validates size > 0 for
  // _IOFBF/_IOLBF and routes a 0 to the invalid-parameter handler, which terminates the
  // process — a branchless `select` between _IONBF and _IOFBF killed every Windows
  // binary at startup while POSIX shrugged it off.
  private lineBufferInitFn(): string[] {
    const lines: string[] = [];
    const env = this.nextTemp(), isSet = this.nextTemp(), handle = this.nextTemp();
    // MSVC maps _IOLBF onto _IOFBF, so line buffering there does nothing; _IONBF (4) is
    // the mode that actually reaches the fd per write.
    const mode = this.isWindows ? 4 : 1;
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: Codegen.LINE_BUF_INIT_FN, ret: Ty.void, params: [], internal: true });
    lines.push(`  ${env} = call ptr @getenv(ptr @.milo_line_buf_env)`);
    lines.push(`  ${isSet} = icmp ne ptr ${env}, null`);
    lines.push(`  br i1 ${isSet}, label %linebuf.set, label %linebuf.done`);
    lines.push("linebuf.set:");
    if (this.isWindows) lines.push(`  ${handle} = call ptr @__acrt_iob_func(i32 1)`);
    else lines.push(`  ${handle} = load ptr, ptr @${this.stdoutSymbol}`);
    lines.push(`  call i32 @setvbuf(ptr ${handle}, ptr null, i32 ${mode}, i64 0)`);
    lines.push("  br label %linebuf.done");
    lines.push("linebuf.done:");
    lines.push("  ret void");
    b.endFn();
    return lines;
  }

  // dprintf(fd, fmt, ...) has no UCRT equivalent. stderr is not a linkable data symbol
  // on MSVC either — it is the macro `__acrt_iob_func(2)` — so eprint lowers to an
  // fprintf onto that handle.
  public emitFdPrintf(lines: string[], fd: number, fmtLabel: string, argsStr: string): void {
    // Freestanding targets have one output sink — whatever printf the embedded runtime
    // provides. There are no fds to write to, so a panic goes out the same channel as
    // everything else rather than referencing a dprintf nothing defines.
    if (this.target.os === "none") {
      this.needsPrintf = true;
      lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtLabel}${argsStr})`);
      return;
    }
    this.needsDprintf = true;
    if (!this.isWindows) {
      lines.push(`  call i32 (i32, ptr, ...) @dprintf(i32 ${fd}, ptr ${fmtLabel}${argsStr})`);
      return;
    }
    const iob = this.nextTemp();
    lines.push(`  ${iob} = call ptr @__acrt_iob_func(i32 ${fd})`);
    lines.push(`  call i32 (ptr, ptr, ...) @fprintf(ptr ${iob}, ptr ${fmtLabel}${argsStr})`);
  }

  // Emit a dbg.declare binding `varName` (stored at `addr`) to a DILocalVariable.
  // Skips silently when debug is off, we're inside a subprogram-less body (closure),
  // or the type can't be modelled — never emits metadata the verifier would reject.
  private dbgDeclare(lines: string[], varName: string, addr: string, t: TypeKind, line: number, argIndex: number): void {
    if (!this.emitDebug || this.currentSubprogramId === null) return;
    const varId = this.dwarf.localVariable(varName, t, argIndex, this.currentSubprogramId, this.currentSubprogramFileId, line);
    if (varId === null) return;
    lines.push(`  call void @llvm.dbg.declare(metadata ptr ${addr}, metadata !${varId}, metadata !DIExpression())`);
    this.usedDbgDeclare = true;
  }

  // The dot is required: a parameter named `t0` is emitted as the LLVM value
  // `%t0` (see the param prologue), so a bare `%t${n}` counter collides with it
  // and LLVM rejects the module with "multiple definition of local value". Milo
  // identifiers cannot contain `.`, so this prefix cannot be reached from source.
  public nextTemp(): string { return `%t.${this.tempCounter++}`; }
  public nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  public localAddr(name: string): string {
    // A local/param shadows a same-named global. Decide on membership in `locals`,
    // NOT on whether the entry carries an explicit `addr` — params, closure
    // captures and match-bindings register without one, and `?.addr` would then
    // fall through to the global's `@name` and read the wrong storage (issue: a
    // param named like a module global read garbage).
    const local = this.locals.get(name);
    if (local) return local.addr ?? `%${name}.addr`;
    return this.globalVars.has(name) ? `@${name}` : `%${name}.addr`;
  }
  private emit(line: string) { this.output.push(line); }

  public llvmType(t: TypeKind): string {
    switch (t.tag) {
      case "int":    return `i${t.bits}`;
      case "float":  return t.bits === 32 ? "float" : "double";
      case "bool":   return "i1";
      case "void":   return "void";
      case "string": this.hasStringType = true; return "%String";
      case "ptr":    return "ptr";
      case "heap":
        if (t.inner.tag === "interface") return "{ ptr, ptr }";
        return "ptr";
      case "vec":    this.hasVecType = true; return "%Vec";
      case "hashmap": this.hasHashMapType = true; return "%HashMap";
      case "ref":
        if (t.inner.tag === "interface") return "{ ptr, ptr }";
        // `&[T]` is a slice: a non-owning fat pointer carried by value, not an opaque
        // pointer. It shares the Vec's %Vec layout, so a `&[T]` param/return lowers to
        // %Vec — the same value the slice expression already produces. (Other `&T` stay
        // pointer-passed.)
        if (t.inner.tag === "array" && t.inner.size === null) { this.hasVecType = true; return "%Vec"; }
        // A returned `&string` is the same non-owning fat pointer a slice expression
        // already produces (data + len, no ownership), so it travels by value as
        // %String. Params are unaffected: the isRef path passes a pointer to the
        // pointee and never asks for the lowering of the ref type itself.
        if (t.inner.tag === "string") { this.hasStringType = true; return "%String"; }
        return "ptr";
      case "interface": return "{ ptr, ptr }";
      case "struct": return `%${t.name}`;
      case "enum":   return `%${t.name}`;
      case "fn":     return "{ ptr, ptr }";
      case "cfn":    return "ptr";
      case "array":
        if (t.size !== null) return `[${t.size} x ${this.llvmType(t.element)}]`;
        // unsized [T] = slice view: same {ptr,len,cap} layout as Vec, cap=0 → non-owning
        this.hasVecType = true;
        return `%Vec`;
      case "never": return "void";
      case "unknown": throw new Error("unknown type in codegen");
    }
  }

  private isUnsigned(t: TypeKind): boolean {
    return t.tag === "int" && !t.signed;
  }

  // Escape a JS string into an LLVM `c"..."` body plus its exact byte length (no null
  // terminator). Backslash MUST become \5C — a raw '\' from e.g. a Windows path (`D:\a\...`)
  // would otherwise be read by LLVM as an escape and desync the declared array size.
  // Built in bounded chunks joined once at the end, rather than one `escaped += ch` per
  // character. `@embedFile` turns an asset into a string with one char per byte, so this
  // runs ~63 million times for `examples/games/flight` — appending to a single growing
  // string there cost ~15s, more than the whole rest of the compile.
  //
  // The ASCII short-circuit on `byteLen` matters as much as the chunking: the old default
  // arm called `Buffer.byteLength(ch, "utf-8")` — a native call — for every ordinary
  // character, to compute a value that is 1 whenever the code point is below 0x80.
  private escapeCString(value: string): { escaped: string; byteLen: number } {
    const parts: string[] = [];
    let chunk = "";
    let byteLen = 0;
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (code >= 0xF780 && code <= 0xF7FF) {
        // PUA sentinel from \xNN escape — emit as raw single byte
        const byte = code - 0xF700;
        chunk += `\\${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        byteLen += 1;
      } else {
        switch (code) {
          case 0x5C: chunk += "\\5C"; byteLen += 1; break;
          case 0x0A: chunk += "\\0A"; byteLen += 1; break;
          case 0x0D: chunk += "\\0D"; byteLen += 1; break;
          case 0x09: chunk += "\\09"; byteLen += 1; break;
          case 0x00: chunk += "\\00"; byteLen += 1; break;
          case 0x22: chunk += "\\22"; byteLen += 1; break;
          default:
            chunk += ch;
            byteLen += code < 0x80 ? 1 : Buffer.byteLength(ch, "utf-8");
        }
      }
      if (chunk.length >= 65536) { parts.push(chunk); chunk = ""; }
    }
    parts.push(chunk);
    return { escaped: parts.join(""), byteLen };
  }

  public addString(value: string): { label: string; length: number } {
    const label = `@.str.${this.strCounter++}`;
    const { escaped, byteLen } = this.escapeCString(value);
    const length = byteLen + 1; // null terminator
    this.strings.push({ label, escaped, length });
    return { label, length };
  }

  // A niche: a bit pattern of `t` that no safe program produces, so an Option-shaped enum
  // can spend it on its fieldless variant. Sources: a ranged int (the first value past the
  // declared range that the width can hold; the checker range-checks every safe flow into
  // the type, see tests/rangedSoundness.test.ts), and a struct whose single field has one
  // (the field sits at offset 0). A struct with a Drop impl is left out: its glue would
  // have to learn the encoding, and nothing measured needs it.
  private nicheOf(t: TypeKind, dropImpls: Set<string>, depth = 0): { intTy: string; value: bigint; bits: number } | null {
    if (depth > 16) return null;
    if (t.tag === "int") {
      if (t.min === undefined || t.max === undefined) return null;
      if (!Number.isSafeInteger(t.min) || !Number.isSafeInteger(t.max)) return null;
      const bits = BigInt(t.bits);
      const lo = t.signed ? -(1n << (bits - 1n)) : 0n;
      const hi = t.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      const min = BigInt(t.min), max = BigInt(t.max);
      const intTy = `i${t.bits}`;
      if (max < hi) return { intTy, value: max + 1n, bits: t.bits };
      if (min > lo) return { intTy, value: min - 1n, bits: t.bits };
      return null;
    }
    if (t.tag === "struct") {
      const layout = this.structLayouts.get(t.name);
      if (!layout || layout.fields.length !== 1 || dropImpls.has(t.name)) return null;
      return this.nicheOf(layout.fields[0].typeKind, dropImpls, depth + 1);
    }
    return null;
  }

  private enumNiche(layout: EnumLayout, dropImpls: Set<string>): EnumNiche | null {
    if (layout.variants.size !== 2) return null;
    const [a, b] = [...layout.variants.values()];
    const none = a.fieldTypes.length === 0 ? a : b.fieldTypes.length === 0 ? b : null;
    const some = none === a ? b : a;
    if (!none || some.fieldTypes.length !== 1) return null;
    const n = this.nicheOf(some.fieldTypeKinds[0], dropImpls);
    if (!n) return null;
    // LLVM integer constants are written signed; an unsigned niche above the signed max
    // is the same bits as its two's-complement negative.
    const wrapped = n.value >= (1n << BigInt(n.bits - 1)) ? n.value - (1n << BigInt(n.bits)) : n.value;
    return { payloadTy: some.fieldTypes[0], intTy: n.intTy, value: wrapped.toString(), noneTag: none.tag, someTag: some.tag };
  }

  private nicheOfEnumTy(enumTy: string): EnumNiche | undefined {
    return enumTy.startsWith("%") ? this.enumLayouts.get(enumTy.slice(1))?.niche : undefined;
  }

  // The tag of the enum at `addr`, as the i32 a tagged enum stores.
  public loadEnumTag(lines: string[], enumTy: string, addr: string): string {
    const niche = this.nicheOfEnumTy(enumTy);
    const tag = this.nextTemp();
    if (!niche) {
      const tagPtr = this.nextTemp();
      lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 0`);
      lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);
      return tag;
    }
    const raw = this.nextTemp();
    const isNone = this.nextTemp();
    lines.push(`  ${raw} = load ${niche.intTy}, ptr ${addr}`);
    lines.push(`  ${isNone} = icmp eq ${niche.intTy} ${raw}, ${niche.value}`);
    lines.push(`  ${tag} = select i1 ${isNone}, i32 ${niche.noneTag}, i32 ${niche.someTag}`);
    return tag;
  }

  // The tag of an enum held as an SSA value. Only a fieldless enum's value is `{ i32 }`;
  // a tagged one is a storage array and a niche one has no tag word, so those go through
  // memory (SROA folds the round trip).
  private enumValueTag(lines: string[], enumTy: string, val: string): string {
    const layout = this.enumLayouts.get(enumTy.slice(1));
    if (layout && !layout.niche && layout.size === 0) {
      const t = this.nextTemp();
      lines.push(`  ${t} = extractvalue ${enumTy} ${val}, 0`);
      return t;
    }
    const slot = this.nextTemp();
    this.entryAllocas.push(`  ${slot} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${val}, ptr ${slot}`);
    return this.loadEnumTag(lines, enumTy, slot);
  }

  // Set the variant of the enum at `addr`. On a niche enum the payload variant has no
  // tag to write (its payload store is the whole value), so only the fieldless one writes.
  public storeEnumTag(lines: string[], enumTy: string, addr: string, tag: number | string) {
    const niche = this.nicheOfEnumTy(enumTy);
    if (!niche) {
      const tagPtr = this.nextTemp();
      lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 0`);
      lines.push(`  store i32 ${tag}, ptr ${tagPtr}`);
      return;
    }
    if (typeof tag === "number") {
      if (tag === niche.noneTag) lines.push(`  store ${niche.intTy} ${niche.value}, ptr ${addr}`);
      return;
    }
    const isNone = this.nextTemp();
    const cur = this.nextTemp();
    const next = this.nextTemp();
    lines.push(`  ${isNone} = icmp eq i32 ${tag}, ${niche.noneTag}`);
    lines.push(`  ${cur} = load ${niche.intTy}, ptr ${addr}`);
    lines.push(`  ${next} = select i1 ${isNone}, ${niche.intTy} ${niche.value}, ${niche.intTy} ${cur}`);
    lines.push(`  store ${niche.intTy} ${next}, ptr ${addr}`);
  }

  // The padding-free array a tagged enum is stored as (see EnumLayout.size).
  private enumStorageTy(layout: EnumLayout): string {
    const a = Math.max(4, layout.payloadAlign);
    return `[${layout.size / a} x i${a * 8}]`;
  }

  public enumVariantOf(enumTy: string, variant: EnumVariant | string | number): EnumVariant {
    if (typeof variant === "object") return variant;
    const layout = must(this.enumLayouts, enumTy.slice(1), "enum layouts");
    for (const [name, info] of layout.variants) if (name === variant || info.tag === variant) return info;
    throw new Error(`internal: ${enumTy} has no variant ${variant}`);
  }

  // Byte offset of each field of a tagged enum's variant from the start of the enum: the
  // variant is the C struct `{ i32 tag; <fields> }`.
  private variantFieldOffsets(fieldTypes: string[]): number[] {
    const withTag = ["i32", ...fieldTypes];
    return fieldTypes.map((_, i) => this.structFieldOffset(withTag, i + 1));
  }

  // Address of field `k` of `variant`'s payload in the enum at `addr`. Every variant has its
  // own offsets, so a payload address is only meaningful for the variant it was computed
  // for; the caller must already know (or have branched on) the tag. A niche enum's single
  // payload is the enum itself. The temp is named `%enum.vp.<n>.<tag>.<k>.<enum>` (`enum`
  // is a keyword, so no local's `%name.addr` can collide) so assertEnumPayloadPacked can
  // check every use against that variant's field type.
  public enumFieldPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number, k: number): string {
    const v = this.enumVariantOf(enumTy, variant);
    if (k >= v.fieldTypes.length) throw new Error(`internal: ${enumTy} variant ${v.tag} has no field ${k}`);
    if (this.nicheOfEnumTy(enumTy)) return addr;
    const p = `%enum.vp.${this.tempCounter++}.${v.tag}.${k}.${enumTy.slice(1)}`;
    lines.push(`  ${p} = getelementptr inbounds i8, ptr ${addr}, i64 ${this.variantFieldOffsets(v.fieldTypes)[k]}`);
    return p;
  }

  // Address of `variant`'s first payload field (a niche enum's payload is the enum).
  public enumPayloadPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number): string {
    return this.enumFieldPtr(lines, enumTy, addr, variant, 0);
  }

  // Every niche-enum access must go through the three helpers above; a site that still
  // indexes the tagged shape would read the payload as a tag. This makes such a site a
  // compiler error rather than a miscompile.
  private assertNicheAccessRouted(ir: string) {
    const names = [...this.enumLayouts.values()].filter(l => l.niche).map(l => l.name);
    if (names.length === 0) return;
    const esc = names.map(n => n.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")).join("|");
    const bad = new RegExp(`(getelementptr(?: inbounds)? %(?:${esc}), ptr [^,]+, i32 0, i32 \\d|(?:extractvalue|insertvalue) %(?:${esc}) )`);
    const m = ir.match(bad);
    if (m) {
      const at = ir.lastIndexOf("\n", m.index ?? 0);
      throw new Error(`internal: niche enum accessed as a tagged enum: ${ir.slice(at + 1, ir.indexOf("\n", m.index)).trim()}`);
    }
  }

  // Each variant's payload has its own offset, so a site that ignores the variant reads
  // and writes the wrong bytes. This makes such a site a compiler error, not a miscompile:
  //  - the storage array holds no variant at a fixed index, so indexing into it, or
  //    extracting from or inserting into a whole enum value, is an error;
  //  - every payload address comes from enumFieldPtr, whose temp names its enum, variant
  //    and field: its offset must be that field's, and every load, store or GEP through it
  //    must use that field's type (a GEP only at index 0, no slot stepping). A payload
  //    pointer reused for another variant, or the old `{ fields }` struct GEP off the
  //    first field, shows up as a type mismatch here.
  private assertEnumPayloadPacked(ir: string) {
    const tagged = [...this.enumLayouts.values()].filter(l => !l.niche && l.size > 0);
    if (tagged.length === 0) return;
    const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&");
    const names = tagged.map(l => esc(l.name)).join("|");
    const fail = (line: string, why: string) => {
      throw new Error(`internal: enum payload accessed without its variant's offsets (${why}): ${line.trim()}`);
    };
    const shape = new RegExp(
      `getelementptr(?: inbounds)? %(?:${names}), ptr [^,]+, i32 0, i32 (?:[1-9]|0, i(?:32|64) )` +
      `|(?:extractvalue|insertvalue) %(?:${names}) `);
    const m = ir.match(shape);
    if (m) {
      const at = m.index ?? 0;
      fail(ir.slice(ir.lastIndexOf("\n", at) + 1, ir.indexOf("\n", at)), "indexes the storage array");
    }
    const fieldTyOf = new Map<string, string>();
    const fieldTy = (name: string, line: string): string => {
      const hit = fieldTyOf.get(name);
      if (hit !== undefined) return hit;
      const pm = name.match(/^%enum\.vp\.\d+\.(\d+)\.(\d+)\.(.+)$/);
      const layout = pm ? this.enumLayouts.get(pm[3]) : undefined;
      const v = layout && [...layout.variants.values()].find(x => x.tag === Number(pm![1]));
      if (!pm || !v || Number(pm[2]) >= v.fieldTypes.length) return fail(line, `unknown payload pointer ${name}`);
      const ty = v.fieldTypes[Number(pm[2])];
      fieldTyOf.set(name, ty);
      return ty;
    };
    // The field's own type, or the leading integer of a niche enum field (loadEnumTag).
    const typeOk = (name: string, ty: string, line: string) => {
      const want = fieldTy(name, line);
      if (ty === want) return;
      if (want.startsWith("%") && this.nicheOfEnumTy(want)?.intTy === ty) return;
      fail(line, `${name} is a ${want} field, used as ${ty}`);
    };
    const vp = "(%enum\\.vp\\.[\\w.$-]+)";
    const def = new RegExp(`^\\s*${vp} = getelementptr inbounds i8, ptr [^,]+, i64 (\\d+)`);
    const load = new RegExp(`= load (.+), ptr ${vp}(?:,|$)`);
    const store = new RegExp(`^\\s*store (.+) [^ ]+, ptr ${vp}(?:,|$)`);
    const gep = new RegExp(`getelementptr(?: inbounds)? (.+?), ptr ${vp}, (?:i32|i64) (\\S+?)(?:,|$)`);
    // An untyped use (a call argument, a stored pointer) cannot be type-checked, so it
    // must sit in the block that computed the pointer: that block already knows the
    // variant, and a pointer carried across a branch on the tag is the reuse this is for.
    const vpAll = /%enum\.vp\.[\w.$-]+/g;
    let block = "";
    let defBlock = new Map<string, string>();
    for (const line of ir.split("\n")) {
      if (line.startsWith("define ")) { block = "entry"; defBlock = new Map(); continue; }
      if (line.length > 0 && line[0] !== " " && line.endsWith(":")) { block = line; continue; }
      if (!line.includes("%enum.vp.")) continue;
      const d = line.match(def);
      if (d) {
        const pm = d[1].match(/^%enum\.vp\.\d+\.(\d+)\.(\d+)\.(.+)$/);
        const v = pm && [...(this.enumLayouts.get(pm[3])?.variants.values() ?? [])].find(x => x.tag === Number(pm[1]));
        if (!pm || !v || this.variantFieldOffsets(v.fieldTypes)[Number(pm[2])] !== Number(d[2])) fail(line, "wrong offset");
        defBlock.set(d[1], block);
        continue;
      }
      const typed = new Set<string>();
      const l = line.match(load);
      if (l) { typeOk(l[2], l[1], line); typed.add(l[2]); }
      const st = line.match(store);
      if (st) { typeOk(st[2], st[1], line); typed.add(st[2]); }
      const g = line.match(gep);
      if (g) {
        typeOk(g[2], g[1], line);
        if (g[3] !== "0") fail(line, "steps off a payload address");
        typed.add(g[2]);
      }
      // the typed address operand is checked above; any other mention is untyped
      const uses = line.match(vpAll) ?? [];
      for (const name of uses) {
        if (typed.has(name) && uses.filter(u => u === name).length === 1) continue;
        if (defBlock.get(name) !== block) fail(line, `${name} used outside the block that computed it`);
      }
    }
  }

  public typeSize(ty: string): number {
    if (ty === "i1" || ty === "i8") return 1;
    if (ty === "i16") return 2;
    if (ty === "i32") return 4;
    if (ty === "i64") return 8;
    if (ty === "float") return 4;
    if (ty === "double") return 8;
    if (ty === "ptr") return 8;
    if (ty === "{ ptr, ptr }") return 16;
    if (ty === "%String") return 24; // ptr + i64 + i64
    if (ty === "%Vec") return 24; // ptr + i64 + i64
    // Derived from the struct definition rather than written out, because writing it out
    // is how it went wrong: adding the tombstone counter to %HashMap left this at 32 and
    // every struct holding a map got an 8-byte-short memcpy. Fixtures did not notice; the
    // self-hosted compiler segfaulted on its first lookup, because src-milo is full of
    // structs with HashMap fields.
    if (ty === "%HashMap") return HASHMAP_FIELDS * 8;
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return parseInt(arrMatch[1]) * this.typeSize(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structPayloadSize(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = must(this.enumLayouts, enumMatch[1], "enum layouts");
      // i64 payload array requires 8-byte alignment, so the i32 tag is padded to 8.
      // Without this, malloc undersizes by 4 bytes and store %Enum overruns the buffer.
      if (layout.niche) return this.typeSize(layout.niche.payloadTy);
      return layout.size > 0 ? layout.size : 4;
    }
    return 8;
  }

  public typeSizeOf(t: TypeKind): number {
    return this.typeSize(this.llvmType(t));
  }

  // Zero `ptr` as type `ty`. For large aggregates, emit llvm.memset instead of a
  // first-class `store [N x i8] zeroinitializer` — clang's InstCombine is
  // superlinear on big aggregate zero-stores (a 64KB stack buffer alone pushed
  // an -O2 build to ~110s; memset drops it to ~1s). The intrinsic must still be
  // declared: newer LLVM parsers synthesize `llvm.*` declarations implicitly,
  // but clang 15 (what the linux deploy image ships) rejects the module with
  // "use of undefined value". memset is never worse, so the threshold only
  // needs to sit below the first painful size.
  private static ZERO_STORE_MEMSET_THRESHOLD = 128;
  public zeroStore(ty: string, ptr: string): string {
    const size = this.typeSize(ty);
    if (size >= Codegen.ZERO_STORE_MEMSET_THRESHOLD) {
      this.needsMemsetIntrinsic = true;
      return `  call void @llvm.memset.p0.i64(ptr ${ptr}, i8 0, i64 ${size}, i1 false)`;
    }
    return `  store ${ty} zeroinitializer, ptr ${ptr}`;
  }

  // Store an already-computed value; routes through zeroStore when the value is
  // a zeroinitializer (e.g. an all-zero array literal `[0 ; N]`), which is how
  // large zero-init actually reaches a `store` — the array literal returns the
  // value "zeroinitializer" and the let/assign store writes it.
  public valStore(ty: string, val: string, ptr: string, copy: CopyDecl): string {
    this.own.checkCopy(copy, val);
    if (val === "zeroinitializer") return this.zeroStore(ty, ptr);
    return `  store ${ty} ${val}, ptr ${ptr}`;
  }

  // Big aggregates must never become first-class SSA values: SROA rewrites any
  // whole-aggregate load/store touching an alloca into per-ELEMENT scalar ops
  // with no size cap, so one `load %Bus` of a struct holding a [61440 x i32]
  // framebuffer becomes ~1M IR instructions and -O2 never finishes (the NES
  // emulator's -O2 build went from unbounded to seconds with this). Threshold
  // matches ZERO_STORE_MEMSET_THRESHOLD: memcpy/sret is never worse.
  private static BIG_AGG_THRESHOLD = 128;
  private isBigAgg(ty: string): boolean {
    return (ty.startsWith("%") || ty.startsWith("[")) && this.typeSize(ty) >= Codegen.BIG_AGG_THRESHOLD;
  }
  // A `view` copy gets its view ID here (the source's ID, when the source slot has one, is
  // what a use-after-move is checked against; `viewSrc` overrides it). `move` and `clone`
  // bookkeeping stays with the caller, which knows how the source gave its bytes up.
  private emitMemcpy(lines: string[], dst: string, src: string, ty: string, copy: CopyDecl, viewSrc?: number): void {
    this.own.checkCopy(copy, src);
    if (this.own.on && copy.intent === "view" && this.needsDropCg(copy.type)) {
      this.own.slots.set(dst, this.own.viewMarker(lines, viewSrc ?? this.own.slots.get(src) ?? 0, "memcpy"));
    }
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${dst}, ptr ${src}, i64 ${this.typeSize(ty)}, i1 false)`);
  }

  // Evaluate `expr` and store its value into `destPtr` (LLVM type `ty`). For
  // big aggregates this keeps the value in memory end-to-end: direct calls to
  // sret-lowered fns write straight into destPtr, places copy via llvm.memcpy
  // (with the same move-out bookkeeping as the SSA paths in genExpr), and
  // struct literals build field-by-field in place. Any shape not handled falls
  // back to the plain genExpr+store path — correct, just slower to compile.
  // `into` says what `destPtr` is, for the ownership ledger: "slot" a frame-owned slot
  // (whoever owns the slot now holds the value's ID), "store" a field/element of some
  // aggregate (the value leaves this frame's books), "return" the sret out-pointer.
  public genStoreInto(lines: string[], destPtr: string, ty: string, expr: HIRExpr, into: "slot" | "store" | "return" = "slot"): void {
    if (!this.own.on) { this.genStoreIntoRaw(lines, destPtr, ty, expr); return; }
    const before = this.own.slots.get(destPtr);
    const v = this.genStoreIntoRaw(lines, destPtr, ty, expr);
    let id = v ? this.own.idOf(v) : undefined;
    if (!id) { const after = this.own.slots.get(destPtr); if (after !== before) id = after; }
    if (!id) return;
    if (into === "slot") this.own.slots.set(destPtr, id);
    else { if (this.own.slots.get(destPtr) === id) this.own.slots.delete(destPtr); this.own.end(lines, id, into === "store" ? "STORE" : "RETURN"); }
  }

  // Returns the SSA value it stored, or null when the value was built or copied in place.
  private genStoreIntoRaw(lines: string[], destPtr: string, ty: string, expr: HIRExpr): string | null {
    // A C function-pointer field is one word, and a bare Milo function name is that
    // word: emit `@name` rather than genExpr's { code, env } pair, the same coercion
    // genCall already does for an extern fn's fn-typed parameter. The checker has
    // already refused every value that would need the env half.
    if (ty === "ptr" && expr.kind === "Ident" && expr.type.tag === "fn" && this.fnSigs.has(expr.name)) {
      lines.push(`  store ptr @${expr.name}, ptr ${destPtr}`);
      return null;
    }
    if (this.isBigAgg(ty)) {
      if (expr.kind === "Call" && this.sretFns.has(expr.func)) {
        const [cl] = this.genExpr(expr, destPtr);
        lines.push(...cl);
        return null;
      }
      // A big-agg replace writes its moved-out old value straight into destPtr, same as
      // an sret call — routed here so the old value never becomes an SSA aggregate.
      if (expr.kind === "MemReplace") {
        const [cl] = this.genExpr(expr, destPtr);
        lines.push(...cl);
        return null;
      }
      if (expr.kind === "StructLit" && this.structLayouts.has(expr.name)) {
        const layout = must(this.structLayouts, expr.name, "struct layouts");
        const pendMark = this.pend.temps.length, built: string[] = [];
        for (const f of expr.fields) {
          const idx = layout.fields.findIndex(lf => lf.name === f.name);
          const fieldTy = layout.fields[idx].type;
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = getelementptr %${expr.name}, ptr ${destPtr}, i32 0, i32 ${idx}`);
          this.genStoreInto(lines, ptr, fieldTy, f.value, "slot");
          this.pendStored(lines, null, ptr, layout.fields[idx].typeKind, built);
        }
        this.genStructUpdateBase(lines, destPtr, expr);
        this.endStored(lines, built, pendMark);
        if (this.own.on && this.needsDropCg(expr.type)) this.own.slots.set(destPtr, this.own.make(lines, "StructLit"));
        return null;
      }
      if (expr.kind === "Ident" || expr.kind === "FieldAccess" ||
          (expr.kind === "IndexAccess" && !(expr.isMove && this.needsDropCg(expr.type)))) {
        // Ident must be a real local/global (not a fn-as-value); a ref local's
        // pointee is owned elsewhere, so moves from it never occur — skip bookkeeping.
        const identLocal = expr.kind === "Ident" ? this.locals.get(expr.name) : null;
        const placeOk = expr.kind !== "Ident" || identLocal !== undefined || this.globalVars.has(expr.name);
        if (placeOk) {
          const [pl, srcPtr] = this.genLValue(expr);
          if (srcPtr !== "null") {
            lines.push(...pl);
            const owned = this.needsDropCg(expr.type);
            const moves = !!expr.isMove && owned && !identLocal?.isRef;
            const viewSrc = expr.kind === "Ident" && !identLocal?.isRef ? this.own.placeId(srcPtr) : 0;
            this.emitMemcpy(lines, destPtr, srcPtr, ty, { intent: !owned ? "plain" : moves ? "move" : "view", type: expr.type }, viewSrc);
            if (moves) {
              lines.push(this.zeroStore(ty, srcPtr));
              if (expr.kind === "Ident") {
                const dl = this.droppableLocals.find(d => d.addr === srcPtr);
                if (dl) this.own.clearAlive(lines, dl.aliveFlag, "MOVE");
              }
              if (this.own.on) this.own.slots.set(destPtr, this.own.make(lines, `move:${expr.kind}`));
            }
            return null;
          }
        }
      }
    }
    const [el, v] = this.genExpr(expr);
    lines.push(...el);
    lines.push(this.valStore(ty, v, destPtr, this.own.valIntent(v, expr.type)));
    return v;
  }

  // Structural equality of two lvalue expressions, restricted to Ident and
  // FieldAccess chains (no index/call — those may have side effects). Used to
  // recognize `place = place + rhs` and to guard against aliasing self-assigns.
  private lvalueMatches(a: HIRExpr, b: HIRExpr): boolean {
    if (a.kind === "Ident" && b.kind === "Ident") return a.name === b.name;
    if (a.kind === "FieldAccess" && b.kind === "FieldAccess")
      return a.field === b.field && this.lvalueMatches(a.object, b.object);
    return false;
  }

  // Is this expression a closure whose environment is on the heap, and whose only owner is
  // whoever holds this value?
  //
  // A closure LITERAL cannot be classified by its type alone. The call site's auto-`move`
  // (checker: "auto-move closure args") sets `isMove` AFTER the literal was typed, so the
  // recorded type stays the non-owning `(T) => R` even though codegen will malloc an
  // environment for it. Reading `isMove` here rather than the type is what makes a literal
  // argument and a `let f = move …` argument agree on who frees.
  private ownsClosureEnv(e: HIRExpr): boolean {
    if (e.type.tag !== "fn") return false;
    if (this.isLentClosure(e)) return false;
    if (e.type.owning === true) return true;
    return e.kind === "Closure" && e.isMove === true && e.captures.length > 0;
  }

  // An owning closure place passed by value that the checker did not move out of: it was
  // lent to a plain `(T) => R` parameter (checker `lendsOwningClosure`). The place still
  // owns it and drops it at its own scope exit, so the call neither frees it afterwards
  // (that would be a double free) nor ends it as a transfer in the ownership ledger.
  private isLentClosure(e: HIRExpr): boolean {
    return e.type.tag === "fn" && e.type.owning === true
      && (e.kind === "Ident" || e.kind === "FieldAccess" || e.kind === "IndexAccess" || e.kind === "HeapDeref") && !e.isMove;
  }

  // Does `fnName`'s parameter `idx` outlive the call — is there anything that could still
  // reach the closure passed to it once the call returns?
  //
  // This is what decides who frees a `move` closure's malloc'd environment. An owning fn
  // type is not Copy, so the call site relinquishes the closure and stops dropping it; the
  // callee cannot pick the job up either, because the parameter is declared with the
  // NON-owning `(T) => R` and so is Copy from the checker's point of view — `fn outer(f) {
  // inner(f) inner(f) }` forwards the same environment twice and no alive flag is cleared.
  // So the caller keeps ownership and frees after the call, which needs exactly this
  // question answered: nothing else may be holding the closure by then.
  //
  // Fail closed everywhere the answer is not obvious (extern, indirect/interface dispatch,
  // recursion, a builtin higher-order form): "escapes" means nobody frees, which is the
  // leak we have today, while a wrong "does not escape" is a double free.
  private closureParamEscapes(fnName: string, idx: number, seen: Set<string> = new Set()): boolean {
    const key = `${fnName}#${idx}`;
    const memo = this.closureParamEscapeCache.get(key);
    if (memo !== undefined) return memo;
    if (seen.has(key)) return true;
    seen.add(key);
    const fn = this.hirFns.get(fnName);
    const param = fn?.params[idx];
    if (!fn || fn.isExtern || !param || param.isRef || param.isRefMut) return true;
    // A parameter declared `move (…) => R` is owning, so the callee already registers it as
    // a droppable local and frees it at every exit. Treat that as an escape: it is the one
    // case where somebody else is doing the job, and dropping again in the caller is a
    // double free (`fn call(f: move () => i64)`, tests/fixtures/closureCapturesDropped).
    if (param.type.tag === "fn" && param.type.owning === true) return true;
    const escapes = this.paramEscapesBody(fn.body, param.name, seen);
    this.closureParamEscapeCache.set(key, escapes);
    return escapes;
  }

  // Whether `body` lets its parameter `paramName` (a closure) outlive the call: stores it,
  // returns it, captures it, or forwards it anywhere that does.
  private paramEscapesBody(body: HIRStmt[], paramName: string, seen: Set<string>): boolean {
    let escapes = false;
    const walk = (node: unknown): void => {
      if (escapes || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: string };
      // A nested closure that CAPTURES it keeps a copy of the {fn, env} pair, and that copy
      // can outlive this frame (`return move () => f(1)`). The capture is recorded by name,
      // so walking the nested body alone would miss it when that body only calls it.
      if (n.kind === "Closure" && Array.isArray(n.captures)
          && (n.captures as { name: string }[]).some(c => c.name === paramName)) { escapes = true; return; }
      // `f(…)` hands the closure to nobody: it is called and forgotten.
      if (n.kind === "ClosureCall") {
        const callee = n.callee as { kind?: string; name?: string } | undefined;
        if (!(callee?.kind === "Ident" && callee.name === paramName)) walk(n.callee);
        walk(n.args);
        return;
      }
      // Forwarding: `fn outer(g) { inner(g) }` keeps `g` only if `inner` does. Without this
      // a one-line wrapper would be indistinguishable from a store.
      if (n.kind === "Call" && Array.isArray(n.args)) {
        const args = n.args as HIRArg[];
        for (let i = 0; i < args.length; i++) {
          const e = args[i]?.expr;
          if (e?.kind === "Ident" && e.name === paramName) {
            if (this.closureParamEscapes(n.func as string, i, seen)) { escapes = true; return; }
          } else walk(args[i]);
        }
        return;
      }
      if (n.kind === "Ident" && n.name === paramName) { escapes = true; return; }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
    };
    walk(body);
    return escapes;
  }

  // Every closure value the program can call through a fn VALUE comes from one of two
  // places: a named function used as a value, or a closure literal. Collected once.
  private hirGlobals: unknown = [];
  private fnValueTargets: { fns: HIRFunction[]; closures: (HIRExpr & { kind: "Closure" })[] } | null = null;
  private collectFnValueTargets() {
    if (this.fnValueTargets) return this.fnValueTargets;
    const fnNames = new Set<string>();
    const closures: (HIRExpr & { kind: "Closure" })[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: string };
      // A local that shares a function's name over-approximates the target set, which
      // only ever makes the answer below more conservative.
      if (n.kind === "Ident" && typeof n.name === "string" && this.hirFns.has(n.name)) fnNames.add(n.name);
      if (n.kind === "Closure") closures.push(n as unknown as HIRExpr & { kind: "Closure" });
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
    };
    for (const fn of this.hirFns.values()) walk(fn.body);
    walk(this.hirGlobals);
    this.fnValueTargets = { fns: [...fnNames].map(n => this.hirFns.get(n)!), closures };
    return this.fnValueTargets;
  }

  // closureParamEscapes for a call through a fn value (`mw(&mut c, next)`): the callee is
  // any function used as a value, or closure literal, whose parameter types match the fn
  // value's, and the caller may free the argument only if NONE of them keeps it. Without this an owning
  // closure handed to a fn value was freed by nobody: std/http's middleware chain leaked
  // one link per request. A candidate that declares the parameter `move` frees it itself,
  // which counts as keeping it here, the same as for a direct call.
  private indirectParamEscapes(calleeType: TypeKind, idx: number): boolean {
    if (calleeType.tag !== "fn") return true;
    const want = calleeType.params;
    const key = `<indirect>/${typeName(calleeType)}#${idx}`;
    const memo = this.closureParamEscapeCache.get(key);
    if (memo !== undefined) return memo;
    // Only a target whose parameters match the fn value's type can be called through it.
    // `typeEq` is the checker's own rule for storing a fn into a slot: it ignores a closure
    // value's `move` but not a closure parameter's (types.ts sameFnOwnership).
    const fits = (params: TypeKind[]) =>
      params.length === want.length && params.every((t, i) => typeEq(t, want[i]));
    const { fns, closures } = this.collectFnValueTargets();
    let escapes = false;
    for (const fn of fns) {
      const params = fn.params.map(p => p.isRef || p.isRefMut ? { tag: "ref", inner: p.type, mutable: p.isRefMut } as TypeKind : p.type);
      if (!fits(params)) continue;
      if (this.closureParamEscapes(fn.name, idx)) { escapes = true; break; }
    }
    if (!escapes) {
      for (const c of closures) {
        if (!fits(c.params.map(p => p.type))) continue;
        const p = c.params[idx];
        if ((p.type.tag === "fn" && p.type.owning === true) || this.paramEscapesBody(c.body, p.name, new Set())) { escapes = true; break; }
      }
    }
    this.closureParamEscapeCache.set(key, escapes);
    return escapes;
  }

  public needsDropCg(t: TypeKind): boolean {
    // An owning closure holds a heap environment. It is droppable exactly because it is
    // not Copy (src/types.ts isCopy): single ownership is what makes running a destructor
    // on it sound, and until that landed, attaching one produced a use-after-free.
    if (t.tag === "fn" && t.owning === true) return true;
    if (needsDrop(t)) return true;
    if (t.tag === "enum") return this.droppableEnums.has(t.name);
    if (t.tag === "struct") return this.structNeedsDrop(t.name);
    if (t.tag === "array" && t.size !== null) return this.needsDropCg(t.element);
    return false;
  }

  public structNeedsDrop(name: string): boolean {
    if (this.structDropCache.has(name)) return must(this.structDropCache, name, "struct drop cache");
    // guard against recursion (recursive structs use Heap, not direct embedding)
    this.structDropCache.set(name, false);
    let result = this.dropImpls.has(name);
    if (!result) {
      const layout = this.structLayouts.get(name);
      if (layout) result = layout.fields.some(f => this.needsDropCg(f.typeKind));
    }
    this.structDropCache.set(name, result);
    return result;
  }

  // `!range` + `!noundef` for a load of a ranged int (`i32(0..100)`) out of memory. The
  // checker range-checks every safe flow INTO the type (tests/rangedSoundness.test.ts), so
  // a stored value is in range, with one exception: a moved-from slot is zeroed and its
  // Drop may still read it. So only a range that contains 0 is attached; a zeroed slot then
  // still holds an in-range, defined value. Memory safe code reads is never uninitialized
  // (literals write every field, a Vec is read only below its len), hence `!noundef`.
  private rangeMetaFor(t: TypeKind, loadTy: string): string {
    const m = this.rangeMeta(t, loadTy);
    return m ? `, !range !${m.range}, !noundef !${m.noundef}` : "";
  }
  private rangeMeta(t: TypeKind, loadTy: string): LoadMeta | undefined {
    if (t.tag !== "int" || loadTy !== `i${t.bits}` || t.min === undefined || t.max === undefined) return undefined;
    if (!Number.isSafeInteger(t.min) || !Number.isSafeInteger(t.max) || t.min > 0 || t.max < 0) return undefined;
    const bits = BigInt(t.bits);
    const lo = BigInt(t.min), hiExcl = BigInt(t.max) + 1n;
    if (hiExcl - lo >= 1n << bits) return undefined; // the full set is not a valid !range
    // wrap to the width's signed spelling, which the IR parser accepts for any iN
    const wrap = (v: bigint) => BigInt.asIntN(t.bits, v);
    const key = `i${t.bits} ${wrap(lo)}, i${t.bits} ${wrap(hiExcl)}`;
    let id = this.rangeMetaIds.get(key);
    if (id === undefined) { id = this.dwarf.mintId(); this.rangeMetaIds.set(key, id); }
    if (this.noundefMetaId === null) this.noundefMetaId = this.dwarf.mintId();
    return { range: id, noundef: this.noundefMetaId };
  }
  private rangeMetaIds = new Map<string, number>();
  private noundefMetaId: number | null = null;

  // True when typeSize/typeAlign compute `ty` exactly rather than falling through to their
  // 8-byte default. dereferenceable/align are promises LLVM speculates loads on, so an
  // unknown leaf (i128, an opaque foreign type) must drop the attribute, not guess.
  private layoutExact(ty: string, depth = 0): boolean {
    if (depth > 32) return false;
    if (/^(i1|i8|i16|i32|i64|float|double|ptr|\{ ptr, ptr \}|%String|%Vec|%HashMap)$/.test(ty)) return true;
    const arr = ty.match(/^\[(\d+) x (.+)\]$/);
    if (arr) return this.layoutExact(arr[2], depth + 1);
    const structName = this.getStructName(ty);
    if (structName) return must(this.structLayouts, structName, "struct layouts").fields.every(f => this.layoutExact(f.type, depth + 1));
    const enumMatch = ty.match(/^%(.+)$/);
    const layout = enumMatch && this.enumLayouts.get(enumMatch[1]);
    if (layout) {
      if (layout.niche) return this.layoutExact(layout.niche.payloadTy, depth + 1);
      return [...layout.variants.values()].every(v => v.fieldTypes.every(f => this.layoutExact(f, depth + 1)));
    }
    return false;
  }

  // Facts every by-ref argument satisfies: the caller passes the address of a live place of
  // the pointee type (refs are second-class, so none is ever null, stored or dangling across
  // the call). A zero-sized pointee gets nothing: its "place" may be a null or dangling
  // address (an element of a Vec of ZSTs), and dereferenceable(0) says nothing anyway.
  // Callers that are not Milo get nothing either: extern decls and exported symbols keep the
  // plain C ABI, since a C caller makes none of these promises.
  private refParamAttrs(fn: HIRFunction, p: HIRFunction["params"][number]): string {
    if (!(p.isRef || p.isRefMut) || fn.isExtern || fn.name === "main" || this.exportedFnNames.has(fn.name)) return "";
    const ty = this.llvmType(p.type);
    if (!this.layoutExact(ty)) return "";
    const size = this.typeSize(ty);
    if (size === 0) return "";
    return ` nonnull dereferenceable(${size}) align ${this.typeAlign(ty)}`;
  }

  // Natural alignment of an LLVM type, mirroring typeSize's cases. `min(size,8)` is
  // WRONG for aggregates — a 12-byte nested struct or [3 x i32] aligns to 4, not 8 —
  // which corrupts sizeof/offsetof (and, later, ABI classification) for nested fields.
  private typeAlign(ty: string): number {
    if (ty === "i1" || ty === "i8") return 1;
    if (ty === "i16") return 2;
    if (ty === "i32") return 4;
    if (ty === "i64") return 8;
    if (ty === "float") return 4;
    if (ty === "double") return 8;
    if (ty === "ptr") return 8;
    if (ty === "{ ptr, ptr }") return 8;
    if (ty === "%String" || ty === "%Vec" || ty === "%HashMap") return 8;
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return this.typeAlign(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structAlign(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = must(this.enumLayouts, enumMatch[1], "enum layouts");
      if (layout.niche) return this.typeAlign(layout.niche.payloadTy);
      return Math.max(4, layout.payloadAlign);
    }
    return 8;
  }

  private structAlign(fieldTypes: string[]): number {
    let a = 1;
    for (const ty of fieldTypes) a = Math.max(a, this.typeAlign(ty));
    return a;
  }

  // Flatten a struct's scalar leaves (offset/size/float-ness) for ABI classification —
  // HFA detection and SysV eightbyte SSE/INTEGER merging need per-leaf info, not just size.
  private abiLeaves(name: string, base: number): AbiLeaf[] {
    const layout = must(this.structLayouts, name, "struct layouts");
    const fieldTypes = layout.fields.map(f => f.type);
    const out: AbiLeaf[] = [];
    layout.fields.forEach((f, i) => out.push(...this.leavesOf(f.typeKind, base + this.structFieldOffset(fieldTypes, i))));
    return out;
  }

  private leavesOf(t: TypeKind, off: number): AbiLeaf[] {
    switch (t.tag) {
      case "float": return [{ offset: off, size: t.bits / 8, isFloat: true }];
      case "int": return [{ offset: off, size: Math.max(1, t.bits / 8), isFloat: false }];
      case "bool": return [{ offset: off, size: 1, isFloat: false }];
      case "ptr": return [{ offset: off, size: 8, isFloat: false }];
      case "struct": return this.abiLeaves(t.name, off);
      case "array": {
        if (t.size === null) return [{ offset: off, size: 8, isFloat: false }];
        const stride = this.typeSize(this.llvmType(t.element));
        const out: AbiLeaf[] = [];
        for (let i = 0; i < t.size; i++) out.push(...this.leavesOf(t.element, off + i * stride));
        return out;
      }
      default: return [{ offset: off, size: 8, isFloat: false }];
    }
  }

  private abiStructOf(name: string): AbiStruct {
    const layout = must(this.structLayouts, name, "struct layouts");
    const fieldTypes = layout.fields.map(f => f.type);
    return {
      name,
      size: this.structPayloadSize(fieldTypes),
      align: this.structAlign(fieldTypes),
      leaves: this.abiLeaves(name, 0),
    };
  }

  // Lowered LLVM signature for an extern fn with by-value struct params/return.
  // The SAME attr rendering (byval/sret/coerce) must appear at the declare AND every
  // call site — an sret/byval attr present on one but not the other silently miscompiles
  // on x86_64 — so both go through this single source of truth.
  private externLoweredSig(name: string): { params: string[]; ret: string } {
    const abi = must(this.externAbi, name, "extern abi");
    const sig = must(this.fnSigs, name, "fn sigs");
    const params: string[] = [];
    let ret = sig.retType;
    if (abi.ret.kind === "sret") {
      params.push(`ptr sret(%${abi.ret.name}) align ${abi.ret.align}`);
      ret = "void";
    } else if (abi.ret.kind === "coerce") {
      ret = abi.ret.retTy;
    }
    for (let i = 0; i < sig.paramTypes.length; i++) {
      const cls = abi.args[i];
      if (!cls || cls.kind === "direct") { params.push(sig.paramTypes[i]); continue; }
      if (cls.kind === "coerce") { for (const r of cls.regs) params.push(r.ty); }
      else params.push(cls.byval ? `ptr byval(%${cls.name}) align ${cls.align}` : `ptr`);
    }
    return { params, ret };
  }

  // Emit an extern call whose signature crosses the C ABI with a by-value struct.
  // argVals hold the Milo-level argument values (struct params are whole %T values);
  // here we reinterpret each into the register/indirect/sret form the ABI demands.
  private emitExternAbiCall(expr: HIRExpr & { kind: "Call" }, argVals: { val: string; type: string }[], lines: string[]): Gen {
    const abi = must(this.externAbi, expr.func, "extern abi");
    const sig = must(this.fnSigs, expr.func, "fn sigs");
    const lowered = this.externLoweredSig(expr.func);
    const finalArgs: string[] = [];

    // sret: caller allocates the result buffer and passes it as a hidden first arg
    let sretAlloca: string | null = null;
    if (abi.ret.kind === "sret") {
      sretAlloca = this.nextTemp();
      lines.push(`  ${sretAlloca} = alloca %${abi.ret.name}`);
      finalArgs.push(`ptr sret(%${abi.ret.name}) align ${abi.ret.align} ${sretAlloca}`);
    }

    for (let i = 0; i < argVals.length; i++) {
      const cls = i < abi.args.length ? abi.args[i] : null; // variadic tail has no class
      const a = argVals[i];
      if (!cls || cls.kind === "direct") { finalArgs.push(`${a.type} ${a.val}`); continue; }
      if (cls.kind === "coerce") {
        // stage the struct in an i64-array buffer (>= struct size) so register loads stay in bounds
        const buf = this.nextTemp();
        lines.push(`  ${buf} = alloca [${cls.container / 8} x i64]`);
        lines.push(`  store ${a.type} ${a.val}, ptr ${buf}`);
        for (const r of cls.regs) {
          let p = buf;
          if (r.offset !== 0) { p = this.nextTemp(); lines.push(`  ${p} = getelementptr i8, ptr ${buf}, i64 ${r.offset}`); }
          const v = this.nextTemp();
          lines.push(`  ${v} = load ${r.ty}, ptr ${p}`);
          finalArgs.push(`${r.ty} ${v}`);
        }
      } else { // indirect — pass a pointer to a private copy (byval attr on SysV)
        const buf = this.nextTemp();
        lines.push(`  ${buf} = alloca %${cls.name}`);
        lines.push(`  store ${a.type} ${a.val}, ptr ${buf}`);
        finalArgs.push(cls.byval ? `ptr byval(%${cls.name}) align ${cls.align} ${buf}` : `ptr ${buf}`);
      }
    }

    const argsStr = finalArgs.join(", ");
    let callPrefix = lowered.ret;
    if (expr.variadic) callPrefix = `${lowered.ret} (${lowered.params.join(", ")}, ...)`;

    if (abi.ret.kind === "sret") {
      lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
      const v = this.nextTemp();
      lines.push(`  ${v} = load %${abi.ret.name}, ptr ${sretAlloca}`);
      return [lines, v, `%${abi.ret.name}`];
    }
    if (abi.ret.kind === "coerce") {
      const raw = this.nextTemp();
      lines.push(`  ${raw} = call ${callPrefix} @${expr.func}(${argsStr})`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = alloca [${abi.ret.container / 8} x i64]`);
      lines.push(`  store ${abi.ret.retTy} ${raw}, ptr ${buf}`);
      const structTy = sig.retType; // "%Name" for a struct return
      const v = this.nextTemp();
      lines.push(`  ${v} = load ${structTy}, ptr ${buf}`);
      return [lines, v, structTy];
    }
    // scalar/void return, but arguments were ABI-rewritten
    if (lowered.ret === "void") {
      lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
      return [lines, "void", "void"];
    }
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = call ${callPrefix} @${expr.func}(${argsStr})`);
    return [lines, tmp, lowered.ret];
  }

  // The @cLayout/@cSig/@cValue guard TU (src/c-guards.ts), or null when nothing is claimed.
  cDeclGuards(): string | null {
    return cDeclGuards({ cLayoutStructs: this.cLayoutStructs, cSigs: this.cSigs, cValues: this.cValues, opaqueTypes: this.opaqueTypes, os: this.target.os }, this);
  }

  public structPayloadSize(fieldTypes: string[]): number {
    let offset = 0;
    let maxAlign = 1;
    for (const ty of fieldTypes) {
      const size = this.typeSize(ty);
      const align = this.typeAlign(ty);
      offset = Math.ceil(offset / align) * align;
      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }
    return Math.ceil(offset / maxAlign) * maxAlign;
  }

  public structFieldOffset(fieldTypes: string[], fieldIdx: number): number {
    let offset = 0;
    for (let i = 0; i <= fieldIdx; i++) {
      const size = this.typeSize(fieldTypes[i]);
      const align = this.typeAlign(fieldTypes[i]);
      offset = Math.ceil(offset / align) * align;
      if (i === fieldIdx) return offset;
      offset += size;
    }
    return offset;
  }

  // ── main-as-green-task ──
  //
  // Every blocking std call picks its strategy from `schedulerCurrent()`, and
  // `main` was never a green task — so that read returned 0 and the call blocked
  // the single OS thread the cooperative scheduler runs on, starving the tasks
  // that would have satisfied it. `accept` in `main` with the peer in a
  // `Task.spawn` hung forever, with no error and no timeout.
  //
  // The fix is to leave the OS stack to the scheduler loop and run `main` on a
  // task of its own (Go's g0/m0 split), which is what `schedulerRunMainRaw`
  // does. Emitting that unconditionally is not an option: it would pull the
  // ucontext scheduler into every hello-world, and wasm/bare-metal have no
  // stackful coroutines at all. So it is emitted only when the program can
  // actually create a green task — `Task$spawnWithStack` reachable from `main`
  // or from a global initializer.
  //
  // The reachability walk over-approximates on purpose (any name mentioned in a
  // reachable body is an edge, which sweeps in closures), but it is not total:
  // a spawn reached only through a function pointer this walk cannot follow
  // would leave the program unwrapped — i.e. exactly today's behavior, a hang,
  // never a miscompile.
  private static readonly GREEN_SPAWN_FN = "Task$spawnWithStack";
  private static readonly GREEN_RUN_MAIN_FN = "schedulerRunMainRaw";
  // main's own body, once the entry point becomes the wrapper that runs it.
  private static readonly MAIN_BODY_FN = "__milo_main_body";
  // The `() => void` shape spawnWithStack calls it through, and where main's
  // exit code is captured on the way out.
  private static readonly MAIN_TASK_FN = "__milo_main_task";
  private static readonly MAIN_EXIT_GLOBAL = "_milo_main_exit";
  private wrapMainGreen = false;

  private collectCallees(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) this.collectCallees(child, out);
      return;
    }
    const n = node as Record<string, unknown>;
    if (n.kind === "Call" && typeof n.func === "string") out.add(n.func);
    for (const v of Object.values(n)) this.collectCallees(v, out);
  }

  private mainCanSpawnGreenTasks(functions: HIRFunction[], initFns: HIRFunction[]): boolean {
    // wasm's makecontext is an abort stub and bare metal has no scheduler at
    // all: a program targeting them that spawns is already broken, and wrapping
    // would break the ones that don't.
    const os = this.target.os;
    if (os !== "darwin" && os !== "linux" && os !== "windows") return false;
    // A lazy global's initializer runs on whatever task first reads it, main's included,
    // so its init fn is a root as much as main is.
    const byName = new Map([...functions, ...initFns].map(f => [f.name, f]));
    if (!byName.has(Codegen.GREEN_RUN_MAIN_FN)) return false;
    // The wrapper calls the body with no arguments; a `main` that takes any
    // would emit a call that does not match its callee.
    if ((byName.get("main")?.params.length ?? 0) > 0) return false;
    const seen = new Set<string>();
    const stack = ["main", ...initFns.map(f => f.name)];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === Codegen.GREEN_SPAWN_FN) return true;
      const fn = byName.get(name);
      if (!fn) continue;
      const callees = new Set<string>();
      this.collectCallees(fn.body, callees);
      for (const c of callees) if (!seen.has(c)) stack.push(c);
    }
    return false;
  }

  // The real `@main` when main runs as a green task: it keeps the entry-point
  // work that must happen on the OS stack (argc/argv, global init), hands the
  // body to the scheduler, and returns whatever exit code the body produced.
  private greenMainEntry(): string[] {
    const lines: string[] = [];
    const bMain = new LlvmTextBuilder(lines, this);
    bMain.defineFn({ name: "main", ret: Ty.i32, params: [{ name: "_milo_argc", ty: Ty.i32 }, { name: "_milo_argv", ty: Ty.ptr }] });
    lines.push("  store i32 %_milo_argc, ptr @_milo_argc_global");
    lines.push("  store ptr %_milo_argv, ptr @_milo_argv_global");
    // before global init: an initializer can print, and setvbuf must precede any I/O
    this.emitStdoutBufferingOptIn(lines);
    if (this.needsGlobalInit) lines.push(`  call void @${GLOBAL_INIT_FN}()`);
    lines.push(`  call void @${Codegen.GREEN_RUN_MAIN_FN}(ptr @${Codegen.MAIN_TASK_FN})`);
    lines.push(`  %exit = load i32, ptr @${Codegen.MAIN_EXIT_GLOBAL}`);
    lines.push("  ret i32 %exit");
    bMain.endFn();
    lines.push("");
    // spawnWithStack calls this through the closure ABI, which passes an env
    // pointer this entry has no use for.
    const bTask = new LlvmTextBuilder(lines, this);
    bTask.defineFn({ name: Codegen.MAIN_TASK_FN, ret: Ty.void, params: [{ name: "__env", ty: Ty.ptr }], internal: true });
    lines.push(`  %code = call i32 @${Codegen.MAIN_BODY_FN}()`);
    lines.push(`  store i32 %code, ptr @${Codegen.MAIN_EXIT_GLOBAL}`);
    lines.push("  ret void");
    bTask.endFn();
    return lines;
  }

  generate(module: HIRModule): string {
    // register struct layouts
    for (const s of module.structs) {
      const layout: StructLayout = {
        name: s.name,
        fields: s.fields.map(f => ({ name: f.name, type: this.llvmType(f.type), typeKind: f.type })),
      };
      this.structLayouts.set(s.name, layout);
      if (s.cLayout) this.cLayoutStructs.push(s);
    }
    this.cSigs = module.cSigs ?? [];
    this.opaqueTypes = new Set(module.opaqueTypes ?? []);
    this.cValues = module.cValues ?? [];

    // Register enum layouts. An enum payload can itself be an enum
    // (`Return(Option<Heap<Expr>>)`), and monomorphized generics like
    // `Option_i64` are appended *after* the enums that reference them. A single
    // pass would therefore size such a payload via typeSize()'s 8-byte fallback
    // — `%Outer = { i32, [1 x i64] }` holding a 16-byte `%Option_i64` — and the
    // store would scribble past the slot. Seed every layout, then grow payload
    // sizes to a fixpoint (monotone, so it terminates; recursion goes through
    // Heap, which is a pointer).
    for (const e of module.enums) {
      const variants = new Map<string, EnumVariant>();
      for (const v of e.variants) {
        variants.set(v.name, { tag: v.tag, fieldTypes: v.fields.map(f => this.llvmType(f)), fieldTypeKinds: v.fields });
      }
      this.enumLayouts.set(e.name, { name: e.name, size: 0, payloadAlign: 1, variants });
    }
    for (const layout of this.enumLayouts.values()) {
      const niche = this.enumNiche(layout, module.dropImpls);
      if (niche) layout.niche = niche;
    }
    for (let pass = 0; pass <= module.enums.length; pass++) {
      let changed = false;
      for (const e of module.enums) {
        const layout = must(this.enumLayouts, e.name, "enum layouts");
        let maxEnd = 0;
        let maxAlign = 1;
        for (const v of layout.variants.values()) {
          if (v.fieldTypes.length === 0) continue;
          maxEnd = Math.max(maxEnd, this.structPayloadSize(["i32", ...v.fieldTypes]));
          maxAlign = Math.max(maxAlign, this.structAlign(v.fieldTypes));
        }
        if (maxEnd === 0) continue;
        const enumAlign = Math.max(4, maxAlign);
        const size = Math.ceil(maxEnd / enumAlign) * enumAlign;
        if (size !== layout.size || maxAlign !== layout.payloadAlign) {
          layout.size = size;
          layout.payloadAlign = maxAlign;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Every concrete impl of one interface has the same method count — it is the
    // interface's, not the type's — so this is well defined per interface name.
    for (const it of module.itables) this.ifaceMethodCounts.set(it.ifaceName, it.methods.length);

    // store user-defined Drop impls
    this.dropImpls = module.dropImpls;
    this.structDropCache.clear();

    // compute which enums need drop glue
    for (const [name, layout] of this.enumLayouts) {
      for (const [, variant] of layout.variants) {
        if (variant.fieldTypeKinds.some(f => this.needsDropCg(f) || (f.tag === "enum" && f.name === name))) {
          this.droppableEnums.add(name);
          break;
        }
      }
    }

    // Before the signatures: refParamAttrs reads it, and an exported fn's call sites must
    // agree with its attribute-free definition.
    this.exportedFnNames = module.exportedFnNames ?? module.userFnNames ?? new Set();
    // register function signatures
    for (const fn of module.functions) {
      this.hirFns.set(fn.name, fn);
      this.userDeclaredFns.add(fn.name);
      this.fnSigs.set(fn.name, {
        paramTypes: fn.params.map(p => {
          if (p.isRef || p.isRefMut) return "ptr";
          // extern fn params: fn types are raw function pointers, not closure tuples
          if (fn.isExtern && p.type.tag === "fn") return "ptr";
          return this.llvmType(p.type);
        }),
        retType: fn.isExtern && fn.retType.tag === "fn" ? "ptr" : this.llvmType(fn.retType),
        variadic: fn.isVariadic,
        // `&string` and `*u8` both lower to `ptr`, but they want different things — the
        // address of the %String struct vs. the character buffer. The LLVM type can't
        // tell them apart, so record it here; see the String coercion in genCall.
        wantsStringAddr: fn.params.map(p => (p.isRef || p.isRefMut) && p.type.tag === "string"),
        // Repeated on the call so the caller's optimizer sees them before the callee is
        // inlined or analysed.
        refAttrs: fn.params.map(p => this.refParamAttrs(fn, p)),
      });
      // classify by-value struct params/return for extern fns → native ABI lowering.
      // A `&Struct`/`*Struct` param crosses by reference (already "ptr"), so only bare
      // struct-tagged params/returns need classification.
      if (fn.isExtern) {
        const byValStruct = (t: TypeKind, isRef: boolean) => t.tag === "struct" && !isRef;
        const wantsAbi =
          byValStruct(fn.retType, false) ||
          fn.params.some(p => byValStruct(p.type, !!(p.isRef || p.isRefMut)));
        if (wantsAbi) {
          try {
            const args = fn.params.map(p =>
              byValStruct(p.type, !!(p.isRef || p.isRefMut))
                ? classifyArg(this.target.arch, this.abiStructOf((p.type as any).name), this.target.os)
                : null);
            const ret: RetClass = byValStruct(fn.retType, false)
              ? classifyRet(this.target.arch, this.abiStructOf((fn.retType as any).name), this.target.os)
              : { kind: "direct" };
            this.externAbi.set(fn.name, { args, ret });
          } catch (e) {
            if (e instanceof AbiError) {
              console.error(`error[codegen]: extern '${fn.name}': ${e.message}`);
              process.exit(1);
            }
            throw e;
          }
        }
      }
    }

    this.emit(`target triple = "${this.target.triple}"`);
    this.emit("");

    const externs = module.functions.filter(f => f.isExtern);
    const functions = module.functions.filter(f => !f.isExtern);
    if (module.userFnNames) this.userFnNames = module.userFnNames;
    this.exportedFnNames = module.exportedFnNames ?? module.userFnNames ?? new Set();
    this.displayNames = module.displayNames;

    // sret-lower internal fns returning big aggregates (after userFnNames is
    // known — exported fns keep their C-visible signature)
    for (const fn of functions) {
      if (fn.name === "main" || this.userFnNames.has(fn.name)) continue;
      if (this.isBigAgg(this.llvmType(fn.retType))) this.sretFns.add(fn.name);
    }

    // register globals before function generation so they're visible during codegen
    this.hirGlobals = module.globals;
    for (const g of module.globals) {
      const ty = this.llvmType(g.type);
      this.globalVars.set(g.name, { type: ty, typeKind: g.type });
      if (g.mutable) this.mutableGlobals.add(g.name);
    }

    // A global whose initializer needs to run code (an arena, a populated Vec, a parsed
    // table) is emitted zeroed and filled on first read, by its own init function: lazy,
    // so a program pays only for the globals it touches, and initializers run in the
    // order reads need them rather than an order computed ahead of time. A constant
    // initializer stays a static LLVM initializer with no guard at all.
    //
    // A global that nothing reads exists for what its initializer does (std/replay boots
    // record/replay that way), so that initializer still runs before main, in
    // `module.globals` order, which the checker sorted by dependency.
    const runtimeInitGlobals = module.globals.filter(g => !this.isFullyConstInit(g));
    const initFns: HIRFunction[] = runtimeInitGlobals.map(g => ({
      name: `${LAZY_INIT_PREFIX}${g.name}`,
      params: [],
      retType: { tag: "void" },
      body: [{
        kind: "Assign" as const,
        target: { kind: "Ident" as const, name: g.name, type: g.type },
        value: g.value,
        isInit: true,
      }],
      isExtern: false,
      isVariadic: false,
      ...(g.sourceFile && { sourceFile: g.sourceFile }),
    }));
    const read = guardLazyGlobals([...functions, ...initFns], new Set(runtimeInitGlobals.map(g => g.name)));
    this.lazyGlobals = new Map(runtimeInitGlobals.filter(g => read.has(g.name)).map(g => [g.name, g]));
    const lazyInitFns = initFns.filter((_f, i) => read.has(runtimeInitGlobals[i]!.name));
    const eager = initFns.filter((_f, i) => !read.has(runtimeInitGlobals[i]!.name));
    this.needsGlobalInit = eager.length > 0;
    this.startupGlobals = runtimeInitGlobals.filter(g => !read.has(g.name)).map(g => g.name);
    const initFn: HIRFunction | null = eager.length === 0 ? null : {
      name: GLOBAL_INIT_FN,
      params: [],
      retType: { tag: "void" },
      body: eager.flatMap(f => f.body),
      isExtern: false,
      isVariadic: false,
    };
    const startupFns = initFn ? [...lazyInitFns, initFn] : lazyInitFns;

    this.wrapMainGreen = this.mainCanSpawnGreenTasks(functions, startupFns);
    if (this.wrapMainGreen) this.emit(`@${Codegen.MAIN_EXIT_GLOBAL} = internal global i32 0`);

    // generate function bodies first (collects string constants, sets needsBoundsCheck)
    const fnBodies: string[][] = [];
    for (const fn of functions) fnBodies.push(this.replayEngineScope(fn, this.genFunction(fn)));
    for (const fn of startupFns) fnBodies.push(this.genFunction(fn));
    if (this.lazyGlobals.size > 0) this.closureBodies.push(this.emitLazyGlobals(functions));

    // auto-declare C functions needed by built-ins and bounds checks
    const declaredExterns = new Set(externs.map(e => e.linkName ?? e.name));
    // The bounds/overflow handler bodies are emitted after this point, so whichever
    // printf emitFdPrintf will pick has to be declared here — by the time it sets the
    // flag itself, the declares are already out.
    const panicPrintf = () => { if (this.target.os === "none") this.needsPrintf = true; else this.needsDprintf = true; };
    if (this.needsBoundsCheck) { panicPrintf(); this.needsExit = true; }
    if (this.needsOverflowCheck) { panicPrintf(); this.needsExit = true; }
    if (this.needsSnprintf && !declaredExterns.has("snprintf"))
      this.output.splice(1, 0, "declare i32 @snprintf(ptr, i64, ptr, ...)");
    if (this.needsStrtod && !declaredExterns.has("strtod"))
      this.output.splice(1, 0, "declare double @strtod(ptr, ptr)");
    if (this.needsStrtof && !declaredExterns.has("strtof"))
      this.output.splice(1, 0, "declare float @strtof(ptr, ptr)");
    if (this.needsMemset && !declaredExterns.has("memset"))
      this.output.splice(1, 0, "declare ptr @memset(ptr, i32, i64)");
    if (this.needsMemsetIntrinsic)
      this.output.splice(
        1, 0,
        "declare void @llvm.memset.p0.i64(ptr nocapture writeonly, i8, i64, i1 immarg)",
      );
    for (const decl of this.fpSatIntrinsics)
      this.output.splice(1, 0, decl);
    // Checked under the name actually declared: std/random.windows declares
    // BCryptGenRandom itself, and a second declare is an LLVM error.
    if (this.needsGetentropy && !declaredExterns.has(this.isWindows ? "BCryptGenRandom" : "getentropy"))
      this.output.splice(1, 0, this.isWindows
        // BCryptGenRandom(NULL, buf, len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) is the
        // UCRT-era CSPRNG; passing the system-preferred flag is what lets the algorithm
        // handle be NULL. Returns an NTSTATUS (0 = success), not an errno.
        ? "declare i32 @BCryptGenRandom(ptr, ptr, i32, i32)"
        : "declare i32 @getentropy(ptr, i64)");
    if (this.needsSchedYield && !declaredExterns.has("sched_yield"))
      this.output.splice(1, 0, "declare i32 @sched_yield()");
    if (this.needsMemcmp && !declaredExterns.has("memcmp"))
      this.output.splice(1, 0, "declare i32 @memcmp(ptr, ptr, i64)");
    if (this.needsStrlen && !declaredExterns.has("strlen"))
      this.output.splice(1, 0, "declare i64 @strlen(ptr)");
    if (this.needsMemcpy && !declaredExterns.has("memcpy"))
      this.output.splice(1, 0, "declare ptr @memcpy(ptr, ptr, i64)");
    if (this.needsFree && !declaredExterns.has("free"))
      this.output.splice(1, 0, "declare void @free(ptr)");
    if (this.needsRealloc && !declaredExterns.has("realloc"))
      this.output.splice(1, 0, "declare ptr @realloc(ptr, i64)");
    if (this.needsMalloc && !declaredExterns.has("malloc"))
      this.output.splice(1, 0, "declare ptr @malloc(i64)");
    if (this.needsExit && !declaredExterns.has("exit"))
      this.output.splice(1, 0, "declare void @exit(i32) noreturn");
    if (this.needsAbort && !declaredExterns.has("abort"))
      this.output.splice(1, 0, "declare void @abort() noreturn");
    if (this.usesSchedulerGlobal && !declaredExterns.has("_exit"))
      this.output.splice(1, 0, "declare void @_exit(i32) noreturn");
    if (this.needsPutchar && !declaredExterns.has("putchar"))
      this.output.splice(1, 0, "declare i32 @putchar(i32)");
    if (this.needsFflush && !declaredExterns.has("fflush"))
      this.output.splice(1, 0, `declare i32 @fflush(ptr)`);
    // The guard must name the symbol we actually emit. On Windows that is `_write`, and
    // a POSIX `extern fn write` in std/os says nothing about it — suppressing the declare
    // on that basis left every print() call referencing an undefined @_write.
    if (this.needsWrite && !declaredExterns.has(this.isWindows ? "_write" : "write"))
      this.output.splice(1, 0, this.isWindows
        ? `declare i32 @_write(i32, ptr, i32)`
        : `declare i64 @write(i32, ptr, i64)`);
    if (this.needsDprintf && !declaredExterns.has("dprintf")) {
      if (this.isWindows) {
        this.needsIob = true;
        this.output.splice(1, 0, `declare i32 @fprintf(ptr, ptr, ...)`);
      } else {
        this.output.splice(1, 0, `declare i32 @dprintf(i32, ptr, ...)`);
      }
    }
    if (this.needsFwrite && !declaredExterns.has("fwrite"))
      this.output.splice(1, 0, `declare i64 @fwrite(ptr, i64, i64, ptr)`);
    // The stdout data symbol is ours regardless of who declared fwrite. Nesting
    // it under that guard meant a program declaring its own `extern fn fwrite`
    // — writing a file, say — got print's `load ptr @__stdoutp` with nothing
    // declaring @__stdoutp, and failed to link.
    // greenMainEntry() is appended AFTER this splice point but calls
    // emitStdoutBufferingOptIn, so its externs have to be declared from the fact that
    // it will run, not from its having run.
    if (this.wrapMainGreen && this.target.os !== "none") this.needsSetvbuf = true;
    if (this.needsSetvbuf && this.isWindows) this.needsIob = true;
    if ((this.needsFwrite || this.needsSetvbuf) && !this.isWindows && !declaredExterns.has(this.stdoutSymbol))
      this.output.splice(1, 0, `@${this.stdoutSymbol} = external global ptr`);
    if (this.needsStderrSym && !declaredExterns.has(this.stderrSymbol))
      this.output.splice(1, 0, `@${this.stderrSymbol} = external global ptr`);
    if (this.needsSetvbuf) {
      if (!declaredExterns.has("setvbuf")) this.output.splice(1, 0, `declare i32 @setvbuf(ptr, ptr, i32, i64)`);
      if (!declaredExterns.has("getenv")) this.output.splice(1, 0, `declare ptr @getenv(ptr)`);
      this.output.splice(1, 0, `@.milo_line_buf_env = private unnamed_addr constant [19 x i8] c"MILO_LINE_BUFFERED\\00"`);
    }
    // Both eprint and print-to-stdout need it on MSVC; declaring it twice is an LLVM error.
    if (this.needsIob && !declaredExterns.has("__acrt_iob_func"))
      this.output.splice(1, 0, `declare ptr @__acrt_iob_func(i32)`);
    if (this.needsPrintf && !declaredExterns.has("printf"))
      this.output.splice(1, 0, `declare i32 @printf(ptr, ...)`);
    if (this.usedDbgDeclare)
      this.output.splice(1, 0, `declare void @llvm.dbg.declare(metadata, metadata, metadata)`);
    if (this.needsBoundsCheck)
      this.output.splice(1, 0, `@.bounds_err = private unnamed_addr constant [${BOUNDS_ERR_LEN} x i8] c"${BOUNDS_ERR_IR}"`);
    for (const [file, name] of this.checkFileConstants) {
      // Escape the path (Windows backslashes especially) so the declared array length
      // matches the actual bytes — a raw '\' desyncs LLVM's size check.
      const { escaped, byteLen } = this.escapeCString(file);
      this.output.splice(1, 0, `${name} = private unnamed_addr constant [${byteLen + 1} x i8] c"${escaped}\\00"`);
    }
    if (this.needsContractCheck) {
      const msg = "runtime error: %s clause violated at %s:%d";
      this.output.splice(1, 0, `@.contract_err = private unnamed_addr constant [${msg.length + 2} x i8] c"${msg}\\0A\\00"`);
      for (const k of ["requires", "ensures", "invariant"]) {
        this.output.splice(1, 0, `@.contract_kind_${k} = private unnamed_addr constant [${k.length + 1} x i8] c"${k}\\00"`);
      }
    }
    if (this.needsOverflowCheck) {
      this.output.splice(1, 0, `@.overflow_err = private unnamed_addr constant [42 x i8] c"runtime error: integer overflow at %s:%d\\0A\\00"`);
    }
    for (const decl of this.usedOverflowIntrinsics) this.output.splice(1, 0, decl);
    if (this.usedSatIntrinsics) {
      for (const decl of this.usedSatIntrinsics) this.output.splice(1, 0, decl);
    }
    if (this.needsRangeCheck) {
      this.output.splice(1, 0, `@.range_err = private unnamed_addr constant [44 x i8] c"runtime error: value out of range at %s:%d\\0A\\00"`);
    }
    // always emit argc/argv globals since main stores to them
    this.output.splice(1, 0, "@_milo_argv_global = internal global ptr null");
    this.output.splice(1, 0, "@_milo_argc_global = internal global i32 0");

    if (this.usesSchedulerGlobal) {
      // thread_local: each OS thread gets its own scheduler slot, so a pthread
      // never observes the main thread's scheduler and misreads green context
      this.output.splice(1, 0, "@_milo_scheduler = internal thread_local global ptr null");
    }
    if (this.usesPanicHook) {
      this.output.splice(1, 0, "@_milo_panic_hook = internal thread_local global ptr null");
    }

    // emit module-level globals
    for (const g of module.globals) {
      const ty = this.llvmType(g.type);
      const initVal = this.getConstantInitializer(g);
      const tls = g.threadLocal ? "thread_local " : "";
      this.output.splice(1, 0, `@${g.name} = internal ${tls}global ${ty} ${initVal}`);
    }

    // emit itable globals for interface dispatch
    for (const itable of module.itables) {
      const globalName = `@itable.${itable.concreteType}.${itable.ifaceName}`;
      // One extra slot after the methods: the concrete type's destructor, or null when it
      // has none. Behind an interface the concrete type is erased, so this is the only
      // route by which a boxed value's `Drop` impl can run — without it `Heap<Iface>`
      // freed the box and never destroyed what was in it. Appended rather than prepended
      // so every existing method index stays valid; dispatch GEPs by index and never
      // reads the struct type.
      const slots = itable.methods.map(m => `ptr @${m}`);
      if (this.structNeedsDrop(itable.concreteType)) {
        ensureStructDropHelper(this, itable.concreteType);
        slots.push(`ptr @milo.drop.struct.${itable.concreteType}`);
      } else {
        slots.push("ptr null");
      }
      const ptrs = slots.join(", ");
      const structTy = `{ ${slots.map(() => "ptr").join(", ")} }`;
      this.output.splice(1, 0, `${globalName} = private unnamed_addr constant ${structTy} { ${ptrs} }`);
      this.itableLayouts.set(`${itable.concreteType}.${itable.ifaceName}`, {
        globalName,
        methodCount: itable.methods.length,
      });
    }

    // insert string constants
    for (let i = this.strings.length - 1; i >= 0; i--) {
      const { label, escaped, length } = this.strings[i];
      this.output.splice(1, 0, `${label} = private unnamed_addr constant [${length} x i8] c"${escaped}\\00"`);
    }
    if (this.strings.length > 0) this.output.splice(1, 0, "");

    // insert struct type definitions
    for (const [name, layout] of this.structLayouts) {
      const fieldTypes = layout.fields.map(f => f.type).join(", ");
      this.output.splice(1, 0, `%${name} = type { ${fieldTypes} }`);
    }

    // insert enum type definitions
    for (const [name, layout] of this.enumLayouts) {
      if (layout.niche) {
        this.output.splice(1, 0, `%${name} = type { ${layout.niche.payloadTy} }`);
      } else if (layout.size > 0) {
        this.output.splice(1, 0, `%${name} = type { ${this.enumStorageTy(layout)} }`);
      } else {
        this.output.splice(1, 0, `%${name} = type { i32 }`);
      }
    }

    // Builtin struct types LAST, so these splice(1,0) land them at the very
    // front of the module — ahead of every global. A module global initialized
    // with `%String zeroinitializer` needs %String already defined (sized) at
    // that point; emitting these earlier put them after the globals loop above,
    // so `@gLog = internal global %String zeroinitializer` referenced an as-yet
    // opaque %String and clang rejected it ("invalid type for null constant").
    // The failure was order-dependent, hence intermittent across builds.
    if (this.hasHashMapType)
      // Built from HASHMAP_FIELDS so the layout and typeSize() cannot disagree again.
      this.output.splice(1, 0, `%HashMap = type { ${["ptr", ...Array(HASHMAP_FIELDS - 1).fill("i64")].join(", ")} }`);
    if (this.hasVecType)
      this.output.splice(1, 0, `%Vec = type { ptr, i64, i64 }`);
    if (this.hasStringType)
      this.output.splice(1, 0, `%String = type { ptr, i64, i64 }`);

    // insert extern declarations. A per-module extern (`linkName` set) is one more typed
    // view of a C symbol another declaration may already name: the symbol is declared
    // once (a second `declare` of it is an LLVM redefinition error), the unrenamed
    // declaration's type preferred, and each call site states its own function type, which
    // opaque pointers allow to differ from the declared one. The calls still name the
    // per-module symbol here; the rewrite at the end of generate() points them at the C one.
    const linkDeclared = new Set<string>();
    const ordered = [...externs.filter(e => !e.linkName), ...externs.filter(e => e.linkName)];
    for (const ext of ordered) {
      const sym = ext.linkName ?? ext.name;
      if (linkDeclared.has(sym)) continue;
      linkDeclared.add(sym);
      const sig = must(this.fnSigs, ext.name, "fn sigs");
      let retType = sig.retType;
      let paramTypes: string[];
      if (this.externAbi.has(ext.name)) {
        const lowered = this.externLoweredSig(ext.name);
        retType = lowered.ret;
        paramTypes = [...lowered.params];
      } else {
        paramTypes = [...sig.paramTypes];
      }
      if (ext.isVariadic) paramTypes.push("...");
      this.output.splice(1, 0, `declare ${retType} @${sym}(${paramTypes.join(", ")})`);
    }

    if (this.needsSetvbuf) fnBodies.push(this.lineBufferInitFn());
    if (this.wrapMainGreen) fnBodies.push(this.greenMainEntry());
    // After greenMainEntry, which is what sets the flag on a green-wrapped program.
    if (this.needsRrHashInit) fnBodies.push(this.rrHashInitFn());
    if (this.needsGetentropy) fnBodies.push(this.hashSeedFn());

    // append function bodies
    for (const body of fnBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    if (this.needsBoundsCheck) {
      this.emit("");
      for (const line of this.boundsFailHelper()) this.emit(line);
    }
    if (this.needsOverflowCheck) {
      this.emit("");
      for (const line of this.overflowFailHelper()) this.emit(line);
    }

    // append drop helper functions
    for (const body of this.dropHelperBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // append shared runtime helpers (substring search, ...)
    for (const body of this.helperFnBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // append closure function bodies
    for (const body of this.closureBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // Before any pass that rewrites call lines (debug info, sanitize, noalias): the markers
    // are verified, then stripped, so none of those passes ever sees one.
    this.output = this.own.finish(this.output);
    for (const [key, id] of this.rangeMetaIds) this.emit(`!${id} = !{${key}}`);
    if (this.noundefMetaId !== null) this.emit(`!${this.noundefMetaId} = !{}`);
    if (this.emitDebug) this.dwarf.apply(this.output);
    // After DwarfEmitter.apply: that pass matches `!dbg !N {` at the end of a define line,
    // and the attribute group this inserts sits before the metadata.
    if (this.sanitize) this.applySanitizeAttribute();

    if (this.fnSigs.has("replayHeapMalloc")) this.output = this.replayHeapCalls(this.output);
    // Last: it reads the final call graph, the replay heap's calls included.
    if (noaliasEnabled()) this.output = this.applyNoalias(this.output);
    const externLinks = new Map(externs.filter(e => e.linkName).map(e => [e.name, e.linkName!]));
    let ir = this.output.join("\n") + "\n";
    if (externLinks.size > 0) ir = mapSymbols(ir, n => externLinks.get(n));
    this.assertNicheAccessRouted(ir);
    this.assertEnumPayloadPacked(ir);
    return ir;
  }

  // Mark every emitted function `sanitize_address` so `-fsanitize=address` actually
  // instruments loads and stores.
  //
  // clang attaches this attribute in the FRONTEND, which a `.ll` input bypasses — so
  // `clang -fsanitize=address foo.ll` links the ASan runtime and instruments nothing.
  // That failure is silent and looks like success: the malloc/free interceptors still
  // fire, so double-free and invalid-free are still reported, and only use-after-free
  // READS pass unnoticed. Every function needs it; ASan skips any function without it.
  private applySanitizeAttribute(): void {
    const out = this.output;
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      if (!l.startsWith("define ") || !l.endsWith("{")) continue;
      // An attribute group reference must precede any metadata attachment, so a
      // `-g --sanitize` build has to insert before ` !dbg !N`, not at end of line.
      const dbg = l.indexOf(" !dbg ");
      out[i] = dbg >= 0
        ? `${l.slice(0, dbg)} #${SANITIZE_ATTRS}${l.slice(dbg)}`
        : `${l.slice(0, -1).trimEnd()} #${SANITIZE_ATTRS} {`;
    }
    out.push("", `attributes #${SANITIZE_ATTRS} = { sanitize_${sanitizerKind()} }`);
  }

  // Record/replay's fixed-address heap (std/replay): every allocation Milo code makes goes
  // through std/replay's malloc/realloc/free, which hand them to libc unless the heap is
  // on, and every free goes to whichever heap the block came from. std/replay's own code
  // too: it frees blocks the program allocated (a string moved into it).
  private replayHeapCalls(lines: string[]): string[] {
    // Over the whole module, compiler-emitted helpers included (string concatenation is
    // one): every allocation in it is the program's. The allocator's own fns (std/replay's
    // heap fns) are what call libc's. The three entry points are declared an allocation
    // family, like malloc/realloc/free, so LLVM still removes an allocation that never
    // escapes and its free: without that, every short-lived string and Vec would cost a
    // real allocation it does not cost today.
    let inAllocator = false;
    return lines.map(l => {
      if (l.startsWith("define ")) {
        inAllocator = /@(?:replayHeap|replay\$heap)\w*\(/.test(l);
        if (/@replayHeapMalloc\(i64 %n\)/.test(l)) return l.replace(/\) \{$/, `) allockind("alloc,uninitialized") allocsize(0) "alloc-family"="milo" {`);
        if (/@replayHeapRealloc\(ptr %p, i64 %n\)/.test(l)) return l.replace("ptr %p,", "ptr allocptr %p,").replace(/\) \{$/, `) allockind("realloc") allocsize(1) "alloc-family"="milo" {`);
        if (/@replayHeapFree\(ptr %p\)/.test(l)) return l.replace("ptr %p)", "ptr allocptr %p)").replace(/\) \{$/, `) allockind("free") "alloc-family"="milo" {`);
      }
      // Only instructions (indented, inside a body) call anything. A global's line can hold
      // the same text as data, a string constant spelling "@malloc(", and rewriting it would
      // change its bytes but not its declared [N x i8] length.
      if (inAllocator || !l.startsWith(" ") || !(l.includes("@malloc(") || l.includes("@realloc(") || l.includes("@free("))) return l;
      return l.replace(/@malloc\(/g, "@replayHeapMalloc(").replace(/@realloc\(/g, "@replayHeapRealloc(").replace(/@free\(/g, "@replayHeapFree(");
    });
  }

  // `noalias` on a `&mut` parameter promises LLVM that, for the whole call, the pointee is
  // reached only through that parameter. The checker's call-site exclusivity check (every
  // call form, receivers and moved arguments included) plus emitAliasGuards rule out a
  // second PARAMETER naming the storage. Two routes remain in safe code, and this pass
  // withholds the attribute wherever either can occur. It runs on the final IR, so every
  // codegen path, builtins and the replay heap included, is seen:
  //   - a mutable global G: `f(&mut G)` where f, or anything it may call, also reads or
  //     writes G by name. A pointer "reaches G" when it is G's address, derived from it,
  //     loaded through it, or a slot holding such a pointer; that reach is propagated from
  //     call arguments into callee params and from `ret` back to callers. A pointer that
  //     reaches G and goes anywhere the pass cannot follow (a store outside a stack slot,
  //     an indirect or C call) makes G reach every param in the module.
  //   - a closure body: its environment points at the creator's locals, so it can write
  //     what a `&mut` argument points at (`f(&mut n, () => { n = n + 1 })`). A function
  //     that may run one (directly or through an indirect call) gets no noalias at all.
  // "May call" follows direct calls and sends an indirect call to every address-taken fn.
  // A C call goes there too (C can only call back what it was handed, or an exported
  // symbol) unless it is a libc/OS function that std or codegen declares and that is not in
  // CALLBACK_LIBC (those run code they were handed: threads, context switches, signal and
  // exit handlers). An extern the PROGRAM declares may be any C library and is assumed to
  // call back. A Milo fn defined in another object is unknown code. Raw pointers built in
  // unsafe code are not tracked: an aliasing `*T` is the user's responsibility, as it is
  // everywhere else.
  private static readonly CALLBACK_LIBC = new Set([
    "pthread_create", "pthread_once", "makecontext", "swapcontext", "setcontext", "atexit",
    "on_exit", "exit", "signal", "sigaction", "raise", "kill", "qsort", "bsearch", "dlopen",
    "dlclose", "fork",
  ]);
  // libc/OS calls std makes that hold on to a pointer argument past the call (a stdio
  // buffer, an event's udata, a thread or context argument, a handler). Any other std or
  // codegen libc call only uses its pointers while it runs.
  private static readonly RETAINING_LIBC = new Set([
    "setvbuf", "setbuf", "kevent", "kevent64", "epoll_ctl", "pthread_create", "makecontext",
    "sigaction", "signal", "atexit", "on_exit", "aio_read", "aio_write", "io_uring_enter",
  ]);
  private externKeepsPointers(name: string): boolean {
    if (name.startsWith("llvm.")) return false;
    return Codegen.RETAINING_LIBC.has(name) || this.externCallsBack(name);
  }
  private externCallsBack(name: string): boolean {
    if (name.startsWith("llvm.")) return false;
    if (Codegen.CALLBACK_LIBC.has(name)) return true;
    const fn = this.hirFns.get(name);
    if (!fn) return false; // declared by codegen itself (printf, malloc, abort, ...)
    return !(fn.sourceFile ?? "").startsWith(resolve(STDLIB_DIR, "std") + "/");
  }
  private applyNoalias(lines: string[]): string[] {
    type Fn = {
      start: number; end: number; params: string[];
      callees: Set<string>; unknown: boolean; mayCallAny: boolean; mayCallC: boolean; touches: Set<string>;
      paramReach: Set<string>[]; retReach: Set<string>;
    };
    // Top-level comma split of a call's argument list (types like `{ ptr, ptr }` nest).
    const splitArgs = (s: string): string[] => {
      const out: string[] = [];
      let depth = 0, cur = "";
      for (const ch of s) {
        if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth++;
        if (ch === ")" || ch === "}" || ch === "]" || ch === ">") { if (depth === 0) break; depth--; }
        if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim()) out.push(cur);
      return out;
    };
    const fns = new Map<string, Fn>();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].startsWith("define ") ? lines[i].match(/@([\w$.\-]+)\(/) : null;
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && lines[end] !== "}") end++;
      const paramList = splitArgs(lines[i].slice((m.index ?? 0) + m[0].length));
      const params = paramList.map(p => p.match(/(%[\w.$\-]+)\s*$/)?.[1] ?? "");
      fns.set(m[1], { start: i, end, params, callees: new Set(), unknown: false, mayCallAny: false, mayCallC: false, touches: new Set(), paramReach: params.map(() => new Set()), retReach: new Set() });
      i = end;
    }
    const refRe = /@([\w$.\-]+)/g;
    const valRe = /%[\w.$\-]+/g;
    const addrTaken = new Set<string>();
    for (const l of lines) {
      if (l.startsWith("define ") || l.startsWith("declare ")) continue;
      const call = l.match(/\bcall\b[^@%]*?[@%][\w$.\-]+\(/);
      const calleeAt = call ? (call.index ?? 0) + call[0].lastIndexOf("@") : -1;
      for (const r of l.matchAll(refRe)) if (fns.has(r[1]) && r.index !== calleeAt) addrTaken.add(r[1]);
    }
    // C may also call an exported symbol it was never handed
    for (const e of this.exportedFnNames) if (e !== "main" && fns.has(e)) addrTaken.add(e);
    const wild = new Set<string>(); // globals that reach every param
    const addAll = (into: Set<string>, from: Iterable<string>): boolean => {
      let grew = false;
      for (const g of from) if (!into.has(g)) { into.add(g); grew = true; }
      return grew;
    };
    // Each body is parsed once into the operands the dataflow needs.
    type Opnd = { vals: string[]; globals: string[] };
    type Ins =
      | { k: "call"; def?: string; callee: string; indirect: boolean; args: Opnd[]; scalarRet: boolean }
      | { k: "store"; val: Opnd; dst: string }
      | { k: "ret"; o: Opnd }
      | { k: "def"; def: string; op: string; o: Opnd; gepBase?: string };
    // A typed operand of integer or float type carries no address (only unsafe code turns
    // one back into a pointer), so it reaches nothing.
    const scalarTyped = (text: string) => /^\s*(i\d+|float|double)\s/.test(text);
    const opnd = (text: string, typed = true): Opnd => typed && scalarTyped(text) ? { vals: [], globals: [] } : ({
      vals: [...text.matchAll(valRe)].map(r => r[0]),
      globals: [...text.matchAll(refRe)].map(r => r[1]).filter(g => this.mutableGlobals.has(g)),
    });
    const bodies = new Map<string, Ins[]>();
    const callers = new Map<string, Set<string>>();
    // Every panic site calls through @_milo_panic_hook, so treating that call as unknown
    // code would withhold noalias from every fn with a bounds or overflow check. The hook
    // only ever holds what _panicHookSet stored, so the call is modelled as calls to those
    // fns; a store of anything but a named fn falls back to "may call anything".
    const hookTargets = new Set<string>();
    let hookOpaque = false;
    for (const l of lines) {
      const hs = l.match(/^\s*store ptr ([@%])([\w$.\-]+), ptr @_milo_panic_hook$/);
      if (!hs) continue;
      if (hs[1] === "@" && fns.has(hs[2])) hookTargets.add(hs[2]);
      else hookOpaque = true;
    }
    for (const [name, f] of fns) {
      const ins: Ins[] = [];
      const hookVals = new Set<string>();
      for (let i = f.start + 1; i < f.end; i++) {
        const l = lines[i];
        if (/^\s*%[\w.$\-]+ = load ptr, ptr @_milo_panic_hook$/.test(l)) hookVals.add(l.trim().split(" ")[0].slice(1));
        if (l.includes("@")) for (const r of l.matchAll(refRe)) if (this.mutableGlobals.has(r[1])) f.touches.add(r[1]);
        const def = l.match(/^\s*(%[\w.$\-]+) = (\w+)(.*)$/);
        const call = l.includes("call") ? l.match(/\bcall\b[^@%]*?([@%])([\w$.\-]+)\(/) : null;
        if (call) {
          const args = splitArgs(l.slice(l.indexOf(`${call[1]}${call[2]}(`) + call[2].length + 2)).map(a => opnd(a));
          ins.push({ k: "call", def: def?.[1], callee: call[2], indirect: call[1] === "%", args, scalarRet: /\bcall (i\d+|float|double|void) [@%]/.test(l) });
          if (call[1] === "@" && fns.has(call[2])) {
            f.callees.add(call[2]);
            (callers.get(call[2]) ?? callers.set(call[2], new Set()).get(call[2])!).add(name);
          } else if (call[1] === "%" && hookVals.has(call[2]) && !hookOpaque) {
            for (const t of hookTargets) {
              f.callees.add(t);
              (callers.get(t) ?? callers.set(t, new Set()).get(t)!).add(name);
            }
          } else if (call[1] === "%") f.mayCallAny = true;
          else if (this.hirFns.get(call[2])?.isExtern === false) f.unknown = true;
          else if (this.externCallsBack(call[2])) f.mayCallC = true;
          continue;
        }
        const st = l.match(/^\s*store\s+(.*), ptr (%[\w.$\-]+|@[\w$.\-]+)(,.*)?$/);
        if (st) { ins.push({ k: "store", val: opnd(st[1]), dst: st[2] }); continue; }
        if (/^\s*ret\s/.test(l)) { ins.push({ k: "ret", o: opnd(l.replace(/^\s*ret/, "")) }); continue; }
        if (!def || def[2] === "icmp" || def[2] === "fcmp") continue;
        // a scalar loaded out of reachable memory is a value, not an address
        if (def[2] === "load" && /^\s+(i\d+|float|double),/.test(def[3])) continue;
        ins.push({ k: "def", def: def[1], op: def[2], o: opnd(def[3], false), gepBase: def[2] === "getelementptr" ? def[3].match(/ptr (%[\w.$\-]+)/)?.[1] : undefined });
      }
      bodies.set(name, ins);
    }
    // Reach dataflow, worklist over fns: a fn is redone when a caller widens one of its
    // params' reach or a callee widens its return's reach. `wild` growing redoes all.
    const flow = (name: string, f: Fn, requeue: (n: string) => void): boolean => {
      const taint = new Map<string, Set<string>>();
      f.params.forEach((p, k) => { if (f.paramReach[k].size) taint.set(p, new Set(f.paramReach[k])); });
      const slotBase = new Map<string, string>(); // stack slot (or a GEP into one) -> its alloca
      const origins = (o: Opnd): Set<string> => {
        const out = new Set<string>(o.globals);
        for (const v of o.vals) { const t = taint.get(v); if (t) for (const g of t) out.add(g); }
        return out;
      };
      const taintVal = (v: string, o: Set<string>): boolean => {
        if (o.size === 0) return false;
        const t = taint.get(v);
        if (!t) { taint.set(v, new Set(o)); return true; }
        return addAll(t, o);
      };
      let wildGrew = false;
      let cur: Ins | null = null;
      const toWild = (o: Set<string>) => { if (addAll(wild, o)) { wildGrew = true; if (process.env.MILO_NOALIAS_DEBUG) console.error(`noalias-wild ${name} ${[...o].join(",")} ${JSON.stringify(cur).slice(0, 200)}`); } };
      // Until stable: a loop's back edge carries a slot's taint to loads written above the store.
      for (let local = true; local;) {
        local = false;
        for (const ins of bodies.get(name)!) {
          cur = ins;
          if (ins.k === "def") {
            if (ins.op === "alloca") { slotBase.set(ins.def, ins.def); continue; }
            if (ins.gepBase && slotBase.has(ins.gepBase)) slotBase.set(ins.def, slotBase.get(ins.gepBase)!);
            if (taintVal(ins.def, origins(ins.o))) local = true;
          } else if (ins.k === "store") {
            const o = origins(ins.val);
            if (!o.size) continue;
            const base = slotBase.get(ins.dst);
            if (base) { if (taintVal(ins.dst, o) || taintVal(base, o)) local = true; }
            else toWild(o); // the heap or a global: not followed
          } else if (ins.k === "ret") {
            if (addAll(f.retReach, origins(ins.o))) for (const c of callers.get(name) ?? []) requeue(c);
          } else {
            const all = new Set<string>();
            for (const a of ins.args) for (const g of origins(a)) all.add(g);
            const callee = ins.indirect ? undefined : fns.get(ins.callee);
            if (callee) {
              ins.args.forEach((a, k) => { if (k < callee.paramReach.length && addAll(callee.paramReach[k], origins(a))) requeue(ins.callee); });
              if (ins.def && taintVal(ins.def, callee.retReach)) local = true;
            } else if (/^(llvm\.)?mem(cpy|move)/.test(ins.callee) && ins.args.length >= 2) {
              // a copy moves reach from the source's contents into the destination's
              const o = origins(ins.args[1]);
              const dst = ins.args[0].vals[0];
              const base = dst ? slotBase.get(dst) : undefined;
              if (base) { if (taintVal(dst!, o) || taintVal(base, o)) local = true; }
              else toWild(o);
            } else if (ins.indirect || this.externKeepsPointers(ins.callee)) {
              // it may keep a pointer it was given and hand it back later
              toWild(all);
            }
            if (ins.def && !callee && !ins.scalarRet && taintVal(ins.def, all)) local = true;
          }
        }
      }
      return wildGrew;
    };
    {
      const queue = [...fns.keys()];
      const queued = new Set(queue);
      const requeue = (n: string) => { if (!queued.has(n)) { queued.add(n); queue.push(n); } };
      while (queue.length) {
        const n = queue.shift()!;
        queued.delete(n);
        // wild reaches every param already (see the verdict below), so it needs no requeue
        flow(n, fns.get(n)!, requeue);
      }
    }
    // Which fns may run (transitively) a closure body or unknown code, and which globals
    // each may touch by name.
    // C never runs a by-ref closure: one cannot leave its creator's stack (it is not
    // owning, so it is neither stored nor sent to a task), and a C fn pointer carries no
    // environment. A context switch or thread start runs task entries and move closures.
    for (const f of fns.values()) {
      if (f.mayCallAny) for (const t of addrTaken) f.callees.add(t);
      else if (f.mayCallC) for (const t of addrTaken) if (!this.byRefClosures.has(t)) f.callees.add(t);
    }
    const opaque = new Set<string>();
    // A move closure owns copies of its captures, so only a by-ref one reaches a caller's locals.
    for (const [name, f] of fns) if (f.unknown || this.byRefClosures.has(name)) opaque.add(name);    for (let changed = true; changed;) {
      changed = false;
      for (const [name, f] of fns) {
        for (const c of f.callees) {
          const cf = fns.get(c)!;
          if (!opaque.has(name) && opaque.has(c)) { opaque.add(name); changed = true; }
          if (addAll(f.touches, cf.touches)) changed = true;
        }
      }
    }
    const out = lines.slice();
    const debug = !!process.env.MILO_NOALIAS_DEBUG;
    for (const [name, params] of this.noaliasCandidates) {
      const f = fns.get(name);
      if (!f) continue;
      let l = out[f.start];
      for (const p of params) {
        const k = f.params.indexOf(`%${p}`);
        const clash = [...(k >= 0 ? f.paramReach[k] : [])].filter(g => f.touches.has(g));
        // A global whose address went where the pass cannot follow may be reached through
        // any loaded pointer in any fn, not only by name, so it poisons every candidate.
        const why = opaque.has(name) ? "may run a closure or unknown code"
          : wild.size ? `address of ${[...wild].slice(0, 3).join(",")} escapes untracked`
          : clash.length ? `reaches and touches ${clash.slice(0, 3).join(",")}` : "";
        if (debug) console.error(`noalias ${name} %${p}: ${why ? `withheld (${why})` : "applied"}`);
        if (why) continue;
        l = l.replace(new RegExp(`ptr (nonnull dereferenceable\\(\\d+\\) align \\d+ %${p.replace(/[$.]/g, "\\$&")})([,)])`), "ptr noalias $1$2");
      }
      out[f.start] = l;
    }
    return out;
  }


  // A record/replay engine fn (HIRFunction.replayEngine) raises its thread's engine depth
  // on entry and lowers it before every return, while the fixed heap is on: its
  // allocations then go to libc and leave the program's heap as the recording left it.
  // With the heap off (no MILO_RECORD/MILO_REPLAY) it is one load and branch each way.
  private replayEngineScope(fn: HIRFunction, lines: string[]): string[] {
    if (!fn.replayEngine || !this.globalVars.has("replay$rrDepth") || !this.globalVars.has("replay$rrHeapOn")) return lines;
    const out: string[] = [];
    let n = 0;
    const on = () => {
      const id = n++;
      out.push(`  %rre.on.${id} = load i64, ptr @replay$rrHeapOn`);
      out.push(`  %rre.c.${id} = icmp ne i64 %rre.on.${id}, 0`);
      return id;
    };
    let entered = false;
    for (const l of lines) {
      if (!entered && l === "entry.bb:") {
        out.push(l);
        const id = on();
        out.push(`  br i1 %rre.c.${id}, label %rre.in.${id}, label %rre.go.${id}`);
        out.push(`rre.in.${id}:`);
        out.push(`  %rre.d.${id} = load i64, ptr @replay$rrDepth`);
        out.push(`  %rre.d1.${id} = add i64 %rre.d.${id}, 1`);
        out.push(`  store i64 %rre.d1.${id}, ptr @replay$rrDepth`);
        out.push(`  br label %rre.go.${id}`);
        out.push(`rre.go.${id}:`);
        entered = true;
        continue;
      }
      if (entered && /^\s+ret\b/.test(l)) {
        const id = on();
        out.push(`  %rre.d.${id} = load i64, ptr @replay$rrDepth`);
        out.push(`  %rre.pos.${id} = icmp sgt i64 %rre.d.${id}, 0`);
        out.push(`  %rre.both.${id} = and i1 %rre.c.${id}, %rre.pos.${id}`);
        out.push(`  br i1 %rre.both.${id}, label %rre.out.${id}, label %rre.ret.${id}`);
        out.push(`rre.out.${id}:`);
        out.push(`  %rre.d1.${id} = sub i64 %rre.d.${id}, 1`);
        out.push(`  store i64 %rre.d1.${id}, ptr @replay$rrDepth`);
        out.push(`  br label %rre.ret.${id}`);
        out.push(`rre.ret.${id}:`);
      }
      out.push(l);
    }
    return entered ? out : lines;
  }

  private genFunction(fn: HIRFunction): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals.clear();
    this.droppableLocals = [];
    this.own.vals.clear(); this.own.slots.clear(); this.own.flags.clear(); this.own.views.clear(); this.own.statics.clear();
    this.own.partIds.clear();
    this.partialMovePaths = this.scanPartialMoves(fn.body);
    this.fieldMoveFlags = new Map();
    this.own.srcLine = fn.line ?? 0;
    this.entryAllocas = [];
    this.emittedAddrs.clear();
    this.currentFnName = fn.name;
    this.currentFnWrapping = !!fn.isWrapping;
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);

    const params: Param[] = fn.params.map(p => {
      const ty = p.isRef || p.isRefMut ? Ty.ptr : Ty.of(this.llvmType(p.type));
      const attrs = this.refParamAttrs(fn, p);
      if (attrs && p.isRefMut) {
        const c = this.noaliasCandidates.get(fn.name) ?? [];
        c.push(p.name);
        this.noaliasCandidates.set(fn.name, c);
      }
      return { name: p.name, ty, attrs };
    });
    // main is the process entry point: the OS reads its return register as the exit code, so it
    // must always be i32 even when the Milo signature is void (`fn main()`). A `void @main` leaves
    // garbage in the return register → nonzero exit on a program that should succeed.
    const isSret = this.sretFns.has(fn.name);
    this.currentFnSret = isSret;
    const ret = fn.name === "main" ? "i32" : isSret ? "void" : this.llvmType(fn.retType);
    const dbg = this.emitDebug ? this.dwarf.diSubprogram(fn) : undefined;
    if (this.emitDebug) {
      this.currentSubprogramId = this.dwarf.diSubprogram(fn);
      this.currentSubprogramFileId = this.dwarf.diFile(fn.sourceFile ?? this.filePath ?? "<unknown>");
    }
    if (fn.name === "main" && this.wrapMainGreen) {
      // The entry point is the wrapper (greenMainEntry); this is just its body,
      // so argc/argv and the global-init call belong there, not here.
      b.defineFn({ name: Codegen.MAIN_BODY_FN, ret: Ty.of(ret), params, internal: true, dbg });
    } else if (fn.name === "main") {
      b.defineFn({ name: fn.name, ret: Ty.of(ret), params: [{ name: "_milo_argc", ty: Ty.i32 }, { name: "_milo_argv", ty: Ty.ptr }, ...params], dbg });
    } else {
      // Non-root fns are internal (like globals): each object carries its own copy.
      // linkonce_odr let the linker merge same-named fns across separately-compiled
      // objects and silently pick one body when they differed (issue #5).
      // `.` can't appear in a Milo identifier, so %__sret.out never collides
      const allParams = isSret ? [{ name: "__sret.out", ty: Ty.ptr }, ...params] : params;
      b.defineFn({ name: fn.name, ret: Ty.of(ret), params: allParams, internal: !this.exportedFnNames.has(fn.name), dbg });
    }
    if (fn.name === "main" && !this.wrapMainGreen) {
      lines.push("  store i32 %_milo_argc, ptr @_milo_argc_global");
      lines.push("  store ptr %_milo_argv, ptr @_milo_argv_global");
      // before global init: an initializer can print, and setvbuf must precede any I/O
      this.emitStdoutBufferingOptIn(lines);
      // after argc/argv: a global initializer may read them (argparse-style defaults)
      if (this.needsGlobalInit) lines.push(`  call void @${GLOBAL_INIT_FN}()`);
    }

    const paramSpillStart = lines.length;
    for (let pi = 0; pi < fn.params.length; pi++) {
      const p = fn.params[pi];
      if (p.isRef || p.isRefMut) {
        const innerTy = this.llvmType(p.type);
        lines.push(`  %${p.name}.addr = alloca ptr`);
        lines.push(`  store ptr %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: innerTy, typeKind: p.type, mutable: p.isRefMut, isRef: true });
        // .addr holds a pointer to the pointee → describe the param as ptr-to-T
        this.dbgDeclare(lines, p.name, `%${p.name}.addr`, { tag: "ptr", inner: p.type }, fn.line ?? 0, pi + 1);
      } else {
        const lt = this.llvmType(p.type);
        lines.push(`  %${p.name}.addr = alloca ${lt}`);
        lines.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: lt, typeKind: p.type, mutable: false, isRef: false });
        this.dbgDeclare(lines, p.name, `%${p.name}.addr`, p.type, fn.line ?? 0, pi + 1);
        if (this.needsDropCg(p.type)) {
          const aliveFlag = `%${p.name}.alive`;
          lines.push(`  ${aliveFlag} = alloca i1`);
          this.registerFieldFlags(lines, `%${p.name}.addr`, p.name, p.type);
          this.own.setAlive(lines, aliveFlag, `%${p.name}.addr`, "param");
          this.droppableLocals.push({ name: p.name, typeKind: p.type, aliveFlag, addr: `%${p.name}.addr` });
        }
      }
    }

    // Attribute the parameter spill to line 0 (the DWARF "compiler-generated"
    // convention for prologue code). Left on the scopeLine, LLVM places
    // prologue_end before the by-value struct store completes, so a breakpoint
    // at the first statement reads a half-copied argument (garbage len/cap for
    // string/struct params). Line 0 pushes prologue_end past the whole spill.
    if (this.emitDebug && lines.length > paramSpillStart) {
      const spill = lines.slice(paramSpillStart);
      markDbg(spill, 0, 0);
      for (let i = 0; i < spill.length; i++) lines[paramSpillStart + i] = spill[i];
    }

    const allocaInsertPoint = lines.length;

    this.currentEnsures = [];
    for (const g of fn.entryGuards ?? []) lines.push(`  call void @"${LAZY_GUARD_PREFIX}${g}"()`);
    if (this.contractChecks && fn.oldSnapshots) {
      // Before any `requires` runs, and certainly before the body: `old(e)` names the value
      // at entry, so the snapshot must be taken while that state is still the current one.
      for (const snap of fn.oldSnapshots) {
        const [snapLines] = this.genStmt(snap);
        lines.push(...snapLines);
      }
    }
    if (this.contractChecks && fn.contracts) {
      const ensures = fn.contracts.filter(c => c.kind === "ensures");
      if (ensures.length > 0) {
        this.currentEnsures = ensures;
        // return-value slot for `result` in ensures clauses; hoisted to entry
        if (this.llvmType(fn.retType) !== "void") {
          this.entryAllocas.push(`  %__contract_result.addr = alloca ${this.llvmType(fn.retType)}`);
        }
      }
      for (const c of fn.contracts) {
        if (c.kind !== "requires") continue;
        const [condLines, condVal] = this.genExpr(c.expr);
        lines.push(...condLines);
        this.emitContractCheck(lines, condVal, "requires", c.span);
      }
    }

    let hasTerminator = false;
    for (const stmt of fn.body) {
      const [stmtLines, terminated] = this.genStmt(stmt);
      lines.push(...stmtLines);
      // Anything past a terminator would land in an already-closed block and make
      // the module unparseable. The checker rejects unreachable code before we get
      // here; this just guarantees we can never emit malformed IR if it doesn't.
      if (terminated) { hasTerminator = true; break; }
    }

    if (!hasTerminator) {
      // fall-off end is only reachable in void fns (and main's implicit 0), so no `result` binding
      this.emitEnsuresChecks(lines);
      this.emitDropGlue(lines);
      // Go exit semantics: when main returns the process exits and any
      // outstanding green tasks die. Waiting is explicit (Task.join/WaitGroup).
      if (ret === "void") b.ret();
      else if (this.currentFnName === "main") b.ret(val("0", Ty.i32));
      // The checker rejects any other non-void fn that can fall off, so this end is
      // only reached past a `while true` with no break: a block that needs a
      // terminator and can never execute. A trap rather than bare `unreachable`, so a
      // shape the checker misses aborts instead of running past the end of the function.
      else { b.callDiscard(Ty.void, "@llvm.trap", []); b.unreachable(); }
    }

    // hoist body allocas to entry block
    if (this.entryAllocas.length > 0) {
      lines.splice(allocaInsertPoint, 0, ...this.entryAllocas);
    }
    this.hoistAllocas(lines, allocaInsertPoint);

    b.endFn();
    this.currentSubprogramId = null; // scope closes with the function
    return lines;
  }

  // LLVM folds only entry-block allocas into the fixed stack frame; an alloca in
  // any later block bumps SP every time it executes and never restores it, so an
  // expression-temp alloca inside a loop leaks stack each iteration (a 1M-line
  // grep overflowed the 8MB stack this way). Clang hoists all constant-size
  // allocas to the entry block; do the same. Every alloca we emit is
  // constant-size, so hoisting is unconditionally safe (allocas have no operands
  // that need dominating, and relative order is preserved).
  private hoistAllocas(lines: string[], insertAt: number): void {
    // One partitioning pass: splicing each alloca out in place was quadratic in the
    // function's line count.
    const hoisted: string[] = [];
    const rest: string[] = [];
    let pastEntryBlock = false;
    for (let i = insertAt; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 0 && line[0] !== " " && line.endsWith(":")) {
        pastEntryBlock = true;
        rest.push(line);
        continue;
      }
      // The includes() pre-filter skips the regex for the vast majority of lines.
      if (pastEntryBlock && line.includes(" = alloca ") && /^ {2}%\S+ = alloca /.test(line)) hoisted.push(line);
      else rest.push(line);
    }
    if (hoisted.length === 0) return;
    lines.length = insertAt;
    for (const line of hoisted) lines.push(line);
    for (const line of rest) lines.push(line);
  }

  public genStmt(stmt: HIRStmt): [string[], boolean] {
    if (this.own.on && stmt.span) this.own.srcLine = stmt.span.line;
    // A statement consumes its own expressions: they are never another value's operands.
    this.pend.parents.push("stmt");
    const [lines, terminated] = this.genStmtRaw(stmt);
    this.pend.parents.pop();
    // Precise per-stmt line tagging. Nested stmts (via recursive genStmt) mark first;
    // skip-if-marked leaves only this stmt's own lines for its span.
    if (this.emitDebug && stmt.span) markDbg(lines, stmt.span.line, stmt.span.col);
    return [lines, terminated];
  }

  private genStmtRaw(stmt: HIRStmt): [string[], boolean] {
    const lines: string[] = [];

    switch (stmt.kind) {
      case "Let": {
        // A view binding points at the element, registered like a `for x in v` element:
        // a slot holding its address, no copy, nothing to drop (see checker viewLets).
        if (stmt.viewBind && stmt.value.kind === "IndexAccess") {
          const [pl, ptr] = this.genLValue(stmt.value);
          lines.push(...pl);
          const addr = this.allocaName(stmt.name);
          this.entryAllocas.push(`  ${addr} = alloca ptr`);
          lines.push(`  store ptr ${ptr}, ptr ${addr}`);
          this.locals.set(stmt.name, { type: this.llvmType(stmt.type), typeKind: stmt.type, mutable: false, isRef: true, addr });
          return [lines, false];
        }
        // For `&T` locals (slices), store the inner value directly. The ref-ness is
        // a compile-time concept (enforces no-escape). At runtime it's a non-owning
        // %String (cap=0) or similar — no pointer indirection needed.
        const isRefLocal = stmt.type.tag === "ref";
        const storedTypeKind = isRefLocal ? (stmt.type as Extract<TypeKind, {tag: "ref"}>).inner : stmt.type;
        const declTy = this.llvmType(storedTypeKind);
        const addrName = this.allocaName(stmt.name);
        // A ranged int is never a big aggregate, so the range check (now on the value
        // expression) doesn't interact with this path.
        const bigAgg = !isRefLocal && this.isBigAgg(declTy);
        let val = "";
        let bigTmp: string | null = null;
        if (bigAgg) {
          // In-loop droppable redecl must keep the old order (eval RHS, drop old
          // slot, then write) — the RHS may read the previous iteration's value —
          // so spill through a temp. Otherwise write the destination directly.
          if (this.needsDropCg(stmt.type) && this.loopHeader !== null) {
            bigTmp = this.nextTemp();
            lines.push(`  ${bigTmp} = alloca ${declTy}`);
            this.genStoreInto(lines, bigTmp, declTy, stmt.value);
          } else {
            this.genStoreInto(lines, addrName, declTy, stmt.value);
          }
        } else {
          const [exprLines, v] = this.genExpr(stmt.value);
          lines.push(...exprLines);
          val = v;
        }
        this.locals.set(stmt.name, { type: declTy, typeKind: stmt.type, mutable: stmt.mutable, isRef: false, addr: addrName });
        this.entryAllocas.push(`  ${addrName} = alloca ${declTy}`);
        // Zero-init droppable allocas so a drop-glue pass over a never-initialized
        // branch-local (e.g. `let s` inside an `if` that wasn't taken) reads cap=0 and skips free.
        // Alive flag is allocated up front so the loop's overwrite-drop below can
        // be guarded by it.
        const declAliveFlag = `${addrName}.alive`;
        // A borrowed index is a shallow view of data someone else owns — EXCEPT
        // when the element needs drop, where the IndexAccess path clones it. The
        // clone has no other owner, so excluding it from drop glue leaked the copy
        // on every iteration (this is what made `v.join(sep)` leak).
        const declDroppable = !isRefLocal && this.needsDropCg(stmt.type) &&
          !(stmt.value.kind === "IndexAccess" && stmt.value.isBorrowed && !this.indexAccessClones(stmt.value));
        if (declDroppable) {
          this.entryAllocas.push(`  ${declAliveFlag} = alloca i1`);
          this.entryAllocas.push(`  store i1 0, ptr ${declAliveFlag}`);
          // before the loop overwrite-drop below, which must go field by field too
          this.registerFieldFlags(this.entryAllocas, addrName, stmt.name, stmt.type);
        }
        if (this.needsDropCg(stmt.type)) {
          this.entryAllocas.push(this.zeroStore(declTy, addrName));
          // Drop the old value before overwriting — this decl may run many times
          // inside a loop. Guarded by the alive flag: a zeroed slot is a no-op
          // for String/Vec (null ptr, zero cap), but drop glue for a struct with
          // a user Drop impl calls that impl regardless, so the first iteration
          // used to run the user's drop on a never-initialized slot.
          if (this.loopHeader !== null) {
            if (declDroppable) {
              this.emitGuardedDrop(lines, { name: stmt.name, typeKind: stmt.type, aliveFlag: declAliveFlag, addr: addrName });
            } else {
              this.emitDropValue(lines, addrName, stmt.type);
            }
          }
        }
        if (bigTmp) { this.emitMemcpy(lines, addrName, bigTmp, declTy, { intent: "move", type: stmt.type }); this.own.moveSlot(bigTmp, addrName); }
        else if (!bigAgg) { lines.push(this.valStore(declTy, val, addrName, this.own.valIntent(val, stmt.type))); this.own.valToSlot(val, addrName); }
        // Describe the value actually stored: for `&T` locals that's the inner value.
        this.dbgDeclare(lines, stmt.name, addrName, storedTypeKind, stmt.span?.line ?? 0, 0);
        // Locals that borrow from a ref are a shallow copy — data owned elsewhere.
        if (declDroppable) {
          this.own.setAlive(lines, declAliveFlag, addrName, `let:${stmt.name}`);
          this.droppableLocals.push({ name: stmt.name, typeKind: stmt.type, aliveFlag: declAliveFlag, addr: addrName });
        }
        return [lines, false];
      }
      case "Assign": {
        // Optimization: `place = place + rhs` for strings → in-place append
        // (amortized O(1)). The naive path allocates a fresh String each time,
        // making accumulation O(n^2). Applies to any Ident/FieldAccess place
        // (e.g. `cg.body = cg.body + s`), not just plain idents.
        if (
          (stmt.target.kind === "Ident" || stmt.target.kind === "FieldAccess") &&
          stmt.target.type.tag === "string" &&
          stmt.value.kind === "BinOp" &&
          stmt.value.op === "+" &&
          this.lvalueMatches(stmt.value.left, stmt.target) &&
          // Bail on `x = x + x` — overlapping memcpy is unsafe; let the slow path handle it.
          !this.lvalueMatches(stmt.value.right, stmt.target)
        ) {
          const [rhsLines, rhsVal] = this.genExpr(stmt.value.right);
          lines.push(...rhsLines);
          const [tgtLines, tgtPtr] = this.genLValue(stmt.target);
          lines.push(...tgtLines);
          this.emitStringAppendInPlace(lines, tgtPtr, rhsVal);
          // The append copies the bytes out of the rhs; an rhs that was a
          // temporary (a call result, or the clone `v[i]` produces) has no owner
          // afterwards. The generic concat path drops its operands — this fast
          // path has to as well, or `r = r + v[i]` leaks a copy per iteration.
          this.dropOwnedTemp(lines, rhsVal, "%String", stmt.value.right);
          return [lines, false];
        }
        const assignLlTy = this.llvmType(stmt.target.type);
        if (this.isBigAgg(assignLlTy)) {
          // Materialize the RHS fully before touching the target (it may read the
          // old value), matching the small-type eval→drop→store order, then copy.
          const tmp = this.nextTemp();
          lines.push(`  ${tmp} = alloca ${assignLlTy}`);
          this.genStoreInto(lines, tmp, assignLlTy, stmt.value);
          const [tl, tPtr] = this.genLValue(stmt.target);
          lines.push(...tl);
          const isLValueTgt =
            !stmt.isInit &&
            (stmt.target.kind === "Ident" || stmt.target.kind === "FieldAccess" || stmt.target.kind === "IndexAccess");
          const cover = isLValueTgt ? this.flagsCovering(stmt.target) : null;
          if (isLValueTgt && this.needsDropCg(stmt.target.type) && !this.lvalueMatches(stmt.value, stmt.target)) {
            if (cover) this.emitDropPlace(lines, tPtr, stmt.target.type, cover.flags, cover.path);
            else this.emitDropValue(lines, tPtr, stmt.target.type);
          }
          this.emitMemcpy(lines, tPtr, tmp, assignLlTy, { intent: "move", type: stmt.target.type });
          this.own.assigned(lines, tPtr, this.own.on ? this.own.slots.get(tmp) : undefined);
          if (cover) this.rearmFieldFlags(lines, cover);
          this.rearmAssignedLocal(lines, stmt.target);
          return [lines, false];
        }
        const [valLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...valLines);
        const [targetLines, targetPtr] = this.genLValue(stmt.target);
        lines.push(...targetLines);
        // Drop the old value at the target slot before overwriting it — for ANY
        // place (Ident/FieldAccess/IndexAccess), not just idents, or reassigning
        // a non-Copy field/element leaks its old buffer. Skip identity self-assign
        // (`p = p`), where `val` still aliases the slot's live data.
        const isLValueTarget =
          !stmt.isInit &&
          (stmt.target.kind === "Ident" || stmt.target.kind === "FieldAccess" || stmt.target.kind === "IndexAccess");
        const cover = isLValueTarget ? this.flagsCovering(stmt.target) : null;
        if (isLValueTarget && this.needsDropCg(stmt.target.type) && !this.lvalueMatches(stmt.value, stmt.target)) {
          if (cover) this.emitDropPlace(lines, targetPtr, stmt.target.type, cover.flags, cover.path);
          else this.emitDropValue(lines, targetPtr, stmt.target.type);
        }
        lines.push(this.valStore(valTy, val, targetPtr, this.own.valIntent(val, stmt.target.type)));
        this.own.assigned(lines, targetPtr, this.own.on ? this.own.idOf(val) : undefined);
        if (cover) this.rearmFieldFlags(lines, cover);
        this.rearmAssignedLocal(lines, stmt.target);
        return [lines, false];
      }
      case "Return": {
        if (!stmt.value) {
          this.emitEnsuresChecks(lines);
          this.emitPendingDrops(lines, 0, 0);
          this.emitDropGlue(lines);
          if (this.currentFnName === "main") {
            // main is forced to i32 (see genFn); a bare `return` must still yield a 0 exit code.
            lines.push("  ret i32 0");
          } else {
            lines.push("  ret void");
          }
          return [lines, true];
        }
        if (this.currentFnSret) {
          const retLl = this.llvmType(stmt.retType);
          this.genStoreInto(lines, "%__sret.out", retLl, stmt.value, "return");
          if (this.currentEnsures.length > 0) {
            // `ensures` reads `result` after the value went to the out-pointer: a view of
            // bytes the caller now owns, so its source is not the frame's (ended) ID.
            this.emitMemcpy(lines, "%__contract_result.addr", "%__sret.out", retLl, { intent: "view", type: stmt.retType }, 0);
            const savedResult = this.locals.get("result");
            this.locals.set("result", { type: retLl, typeKind: stmt.retType, mutable: false, isRef: false, addr: "%__contract_result.addr" });
            this.emitEnsuresChecks(lines);
            if (savedResult) this.locals.set("result", savedResult);
            else this.locals.delete("result");
          } else {
            this.emitEnsuresChecks(lines);
          }
          this.emitPendingDrops(lines, 0, 0);
          this.emitDropGlue(lines);
          lines.push("  ret void");
          return [lines, true];
        }
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        if (this.currentEnsures.length > 0 && valTy !== "void") {
          // bind `result` to the return value; shadow any user local of the same name
          lines.push(`  store ${valTy} ${val}, ptr %__contract_result.addr`);
          const savedResult = this.locals.get("result");
          this.locals.set("result", { type: valTy, typeKind: stmt.retType, mutable: false, isRef: false, addr: "%__contract_result.addr" });
          this.emitEnsuresChecks(lines);
          if (savedResult) this.locals.set("result", savedResult);
          else this.locals.delete("result");
        } else {
          this.emitEnsuresChecks(lines);
        }
        this.emitPendingDrops(lines, 0, 0);
        this.emitDropGlue(lines);
        // A sortByKey extractor hands back a borrow of the element (the checker's one
        // exemption): returning that view transfers nothing.
        if (!(this.own.returnsView && this.own.views.has(val))) this.own.endVal(lines, val, "RETURN");
        if (valTy === "void") lines.push("  ret void");
        else lines.push(`  ret ${valTy} ${val}`);
        return [lines, true];
      }
      case "If": return this.genIf(stmt);
      case "While": return this.genWhile(stmt);
      case "Break":
        if (this.loopExit) {
          this.emitPendingDrops(lines, this.pend.loopTemps, this.pend.loopArgTemps);
          this.emitLoopDropGlue(lines);
          lines.push(`  br label %${this.loopExit}`);
        }
        return [lines, true];
      case "Continue":
        if (this.loopHeader) {
          this.emitPendingDrops(lines, this.pend.loopTemps, this.pend.loopArgTemps);
          this.emitLoopDropGlue(lines);
          lines.push(`  br label %${this.loopHeader}`);
        }
        return [lines, true];
      case "ExprStmt": {
        // A void match whose arms all diverge ends in `unreachable`: report it terminated,
        // or an enclosing match arm appends a dead `br` after it.
        if (stmt.expr.kind === "MatchExpr" && this.llvmType(stmt.expr.type) === "void") return genMatch(this, matchExprAsStmt(stmt.expr));
        const [exprLines, exprVal, exprLLTy] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        // A call in statement position still returns an owned value; with nobody
        // to bind it, nothing else will ever free it. Only call forms qualify —
        // place expressions (Ident/FieldAccess/IndexAccess) name storage someone
        // else owns, and dropping those would double-free. Returned `&T` can't
        // occur: references are second-class and never leave a function.
        this.dropOwnedTemp(lines, exprVal, exprLLTy, stmt.expr);
        return [lines, false];
      }
      case "Match":
        return genMatch(this, stmt);
      case "NullRefUnwrap":
        return this.genNullRefUnwrap(stmt);
      case "LazyGlobalInit":
        lines.push(`  call void @"${LAZY_GUARD_PREFIX}${stmt.name}"()`);
        return [lines, false];
      case "UnsafeBlock": case "Block": {
        let terminated = false;
        for (const s of stmt.body) {
          const [sl, st] = this.genStmt(s);
          lines.push(...sl);
          if (st) { terminated = true; break; }
        }
        return [lines, terminated];
      }
      case "ForRange":
        return this.genForRange(stmt);
      case "ForEach":
        return this.genForEach(stmt);
      case "ForIterator":
        return this.genForIterator(stmt);
      case "ForStrView":
        return this.genForStrView(stmt);
    }
    // Every arm above returns, so this is unreachable — and that is the point: it is
    // what makes a newly-added HIR kind a compile error here rather than a value that
    // quietly never gets generated.
    const _exhaustive: never = stmt;
    throw new Error(`genStmtRaw: unhandled HIR kind '${(_exhaustive as { kind: string }).kind}'`);
  }

  public genLValue(expr: HIRExpr): Gen {
    const lines: string[] = [];
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (!local) {
        const globalInfo = this.globalVars.get(expr.name);
        if (globalInfo) return [lines, `@${expr.name}`, globalInfo.type];
      }
      if (local?.isRef) {
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ptr, ptr ${this.localAddr(expr.name)}`);
        return [lines, tmp, local.type];
      }
      return [lines, this.localAddr(expr.name), local?.type ?? "i32"];
    }
    if (expr.kind === "FieldAccess") {
      // pointer-to-struct: load ptr, GEP into pointed-to struct
      if (expr.object.type.tag === "ptr" && expr.object.type.inner.tag === "struct") {
        const [objLines, objVal] = this.genExpr(expr.object);
        lines.push(...objLines);
        const structName = expr.object.type.inner.name;
        const layout = must(this.structLayouts, structName, "struct layouts");
        const idx = layout.fields.findIndex(f => f.name === expr.field);
        const fieldTy = layout.fields[idx].type;
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = getelementptr %${structName}, ptr ${objVal}, i32 0, i32 ${idx}`);
        return [lines, tmp, fieldTy];
      }
      const [objLines, objPtr, objTy] = this.genLValue(expr.object);
      lines.push(...objLines);
      const structName = this.getStructName(objTy);
      if (structName) {
        const layout = must(this.structLayouts, structName, "struct layouts");
        const idx = layout.fields.findIndex(f => f.name === expr.field);
        const fieldTy = layout.fields[idx].type;
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = getelementptr %${structName}, ptr ${objPtr}, i32 0, i32 ${idx}`);
        return [lines, tmp, fieldTy];
      }
    }
    if (expr.kind === "IndexAccess") {
      if (expr.object.type.tag === "ptr") {
        const [objLines, objVal] = this.genExpr(expr.object);
        lines.push(...objLines);
        const [idxLines, idxVal] = this.genExpr(expr.index);
        lines.push(...idxLines);
        const elemTy = this.llvmType(expr.type);
        const gep = this.nextTemp();
        lines.push(`  ${gep} = getelementptr ${elemTy}, ptr ${objVal}, i64 ${idxVal}`);
        return [lines, gep, elemTy];
      }
      // A Vec or a slice (`&[T]`/`&mut [T]`, tag "array" size null) shares the %Vec
      // {ptr,len,cap} layout — index through the bounds-checked Vec path. Deref the ref a
      // slice param carries. Mirrors the read-side dispatch; without this, writing through
      // a slice (`xs[i] = v`) fell to the fixed-array path and stored through a null ptr.
      const effObj = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
      if (effObj.tag === "vec" || (effObj.tag === "array" && effObj.size === null)) {
        return this.genVecBoundsCheckedPtr(expr, lines);
      }
      return this.genBoundsCheckedPtr(expr, lines);
    }
    if (expr.kind === "PtrDeref") {
      const [ptrLines, ptrVal] = this.genExpr(expr.operand);
      lines.push(...ptrLines);
      const innerTy = this.llvmType(expr.type);
      return [lines, ptrVal, innerTy];
    }
    // A temporary box is an rvalue: its payload is moved out and the box freed
    // (genHeapMoveOut), so the caller materializes the value like any owned temporary.
    if (expr.kind === "HeapDeref" && !this.isTempBoxDeref(expr)) {
      const [ptrLines, ptrVal] = this.genExpr(expr.operand);
      lines.push(...ptrLines);
      const innerTy = this.llvmType(expr.type);
      return [lines, ptrVal, innerTy];
    }
    return [lines, "null", "i32"];
  }

  private genBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): Gen {
    const objPtr = this.genIndexObjectPtr(expr.object, lines);
    const objTy = this.llvmType(expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type);
    const [idxLines, idxVal, idxTy] = this.genExpr(expr.index);
    lines.push(...idxLines);

    const match = objTy.match(/\[(\d+) x (.+)\]/);
    if (match) {
      const size = parseInt(match[1]);
      const elemTy = match[2];
      // The check and the GEP both use the full i64 index. This used to truncate to
      // i32 first, so `a[2^32 + 1]` passed the check AND addressed `a[1]`.
      const idx64 = this.indexToI64(lines, idxVal, idxTy, expr.index.type);
      this.emitBoundsCheck(lines, idx64, String(size), expr.span);
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${objTy}, ptr ${objPtr}, i64 0, i64 ${idx64}`);
      return [lines, ptr, elemTy];
    }
    return [lines, "null", "i32"];
  }

  // The failure path is ONE out-of-line `cold noreturn` call, not the printf +
  // fflush + abort sequence spelled out at every subscript. Inline, those three
  // calls appear once per access — the flyby rasteriser's pixel loop carried 24 of
  // each — and a call in a loop body is something LLVM's vectoriser refuses to
  // look past ("call instruction cannot be vectorized"), quite apart from what it
  // does to inlining budgets and I-cache. `cold` also tells LLVM which way the
  // branch goes, so the check falls through in the common case.
  //
  // `idx` and `size` are i64. The compare must see the same index the access uses: a
  // compare on truncated i32 values let `v[-4294967295]` pass (it truncates to 1) and
  // then write through the full 64-bit offset.
  private emitBoundsCheck(lines: string[], idx: string, size: string, span?: Span) {
    this.needsBoundsCheck = true;
    const cmpTmp = this.nextTemp();
    const okLabel = this.nextLabel("bounds.ok");
    const failLabel = this.nextLabel("bounds.fail");

    lines.push(`  ${cmpTmp} = icmp ult i64 ${idx}, ${size}`);
    lines.push(`  br i1 ${cmpTmp}, label %${okLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    // The location rides into the out-of-line handler as arguments, the way the overflow
    // check already does — keeping it out of the hot block, which is the whole point of
    // the handler being out of line.
    const filePtr = this.emitCheckFilePtr(lines, span);
    lines.push(`  call void @__milo_bounds_fail(i64 ${idx}, i64 ${size}, ptr ${filePtr}, i32 ${span?.line ?? 0})`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private overflowFailHelper(): string[] {
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: "__milo_overflow_fail", ret: Ty.void, params: [{ name: "file", ty: Ty.ptr }, { name: "line", ty: Ty.i32 }], internal: true, attrs: " noreturn cold noinline" });
    lines.push(`  %fmt = getelementptr [46 x i8], ptr @.overflow_err, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, "%fmt", `, ptr %file, i32 %line`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    b.endFn();
    return lines;
  }

  // Collect the containers a loop body subscripts, keyed by the shallow path name.
  private indexedContainers(body: HIRStmt[]): Map<string, HIRExpr> {
    const found = new Map<string, HIRExpr>();
    const visitExpr = (e: HIRExpr) => {
      this.walkExpr(e, (x) => {
        if (x.kind !== "IndexAccess") return;
        const vecType = x.object.type.tag === "ref" ? x.object.type.inner : x.object.type;
        if (vecType.tag !== "vec") return;
        const key = this.containerKey(x.object);
        if (key !== null && !found.has(key)) found.set(key, x.object);
      });
    };
    const walk = (stmts: HIRStmt[]) => {
      for (const st of stmts) {
        switch (st.kind) {
          case "Let": visitExpr(st.value); break;
          case "Assign": visitExpr(st.target); visitExpr(st.value); break;
          case "ExprStmt": visitExpr(st.expr); break;
          case "Return": if (st.value) visitExpr(st.value); break;
          case "If": visitExpr(st.cond); walk(st.thenBody); if (st.elseBody) walk(st.elseBody); break;
          case "While": visitExpr(st.cond); walk(st.body); break;
          case "ForRange": visitExpr(st.start); visitExpr(st.end); walk(st.body); break;
          case "UnsafeBlock": case "Block": walk(st.body); break;
          case "Match": visitExpr(st.subject); for (const arm of st.arms) walk(arm.body); break;
          default: break;
        }
      }
    };
    walk(body);
    return found;
  }

  // Emit the once-per-loop length loads. Returns true if a scope was pushed.
  private pushHoistedLens(lines: string[], body: HIRStmt[]): boolean {
    const scope = new Map<string, { len: string; decl?: LocalInfo }>();
    for (const [key, objExpr] of this.indexedContainers(body)) {
      const root = this.rootOf(key);
      // must already exist outside the loop, and must not be resizable inside it
      if (!this.locals.has(root) && !this.globalVars.has(root)) continue;
      if (this.globalVars.has(root)) continue;
      if (this.loopBodyMutates(body, key)) continue;
      try {
        const [ptrLines, vecPtr] = this.genLValue(objExpr);
        const lenPtr = this.nextTemp();
        const len = this.nextTemp();
        lines.push(...ptrLines);
        lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
        lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
        scope.set(key, { len, decl: this.locals.get(root) });
      } catch {
        // an object shape genLValue cannot address: skip it, keep the per-access load
      }
    }
    if (scope.size === 0) return false;
    this.hoistedLens.push(scope);
    return true;
  }

  private hoistedLenFor(expr: HIRExpr): string | null {
    const key = this.containerKey(expr);
    if (key === null) return null;
    const decl = this.locals.get(this.rootOf(key));
    for (let i = this.hoistedLens.length - 1; i >= 0; i--) {
      const v = this.hoistedLens[i].get(key);
      // A shadowing declaration invalidates the outer entries for this name too,
      // so a mismatch stops the walk rather than continuing to an older scope.
      if (v !== undefined) return v.decl === decl ? v.len : null;
    }
    return null;
  }

  // Returns true (and pushes a scope) when this loop proves its index in range.
  private pushProvenInRange(stmt: HIRStmt & { kind: "ForRange" }): boolean {
    if (!(stmt.start.kind === "IntLit" && Number(stmt.start.value) === 0)) return false;
    if (stmt.end.kind !== "VecLen") return false;
    const key = this.containerKey(stmt.end.object);
    if (key === null) return false;
    // A global could be resized by any callee; only locals and params qualify.
    if (this.globalVars.has(this.rootOf(key))) return false;
    if (this.loopBodyMutates(stmt.body, key)) return false;
    this.provenInRange.push({
      loopVar: stmt.varName,
      container: key,
      containerDecl: this.locals.get(this.rootOf(key)),
      loopVarDecl: this.locals.get(stmt.varName),
    });
    return true;
  }

  // A stable name for the container a subscript reads, or null if it is reached
  // by anything more complicated than a local or one field hop (`v`, `self.px`).
  // Deliberately shallow: two spellings must never collide, and a longer path is
  // more chances for something in between to be reassigned.
  private containerKey(e: HIRExpr): string | null {
    if (e.kind === "Ident") return e.name;
    if (e.kind === "FieldAccess" && e.object.kind === "Ident") return `${e.object.name}.${e.field}`;
    return null;
  }

  private rootOf(key: string): string {
    const dot = key.indexOf(".");
    return dot < 0 ? key : key.slice(0, dot);
  }

  // Could anything in `body` change the length of the container named by `key`?
  // Answers "maybe" for everything it does not positively understand — a wrong
  // "no" here is an out-of-bounds write, so the bar is proof, not likelihood.
  private loopBodyMutates(body: HIRStmt[], key: string): boolean {
    const root = this.rootOf(key);
    let mutates = false;

    // Any function that can see the root can resize through it, and a HIR call
    // does not record which parameters are `&mut`. Passing the root anywhere at
    // all — as an argument, as a receiver, inside a bigger expression — ends the
    // analysis.
    const mentionsRoot = (e: HIRExpr): boolean => {
      let found = false;
      this.walkExpr(e, (x) => {
        if (x.kind === "Ident" && x.name === root) found = true;
      });
      return found;
    };

    const checkExpr = (e: HIRExpr) => {
      this.walkExpr(e, (x) => {
        if (mutates) return;
        switch (x.kind) {
          case "VecPush":
            if (mentionsRoot(x.vec)) mutates = true;
            break;
          case "VecPop":
            if (mentionsRoot(x.vec)) mutates = true;
            break;
          case "Call":
            if (x.args.some(a => mentionsRoot(a.expr))) mutates = true;
            break;
          case "CFnCall":
            mutates = true; // opaque to us, and it can hold a raw pointer
            break;
          case "Closure":
          case "MatchExpr":
            // A closure's captures and a match arm's body are statement lists this
            // walk does not descend into. Assume the worst.
            mutates = true;
            break;
          default:
            break;
        }
      });
    };

    const walkStmts = (stmts: HIRStmt[]) => {
      for (const s of stmts) {
        if (mutates) return;
        switch (s.kind) {
          case "Assign": {
            // Reassigning the container itself, or anything on its path, swaps the
            // buffer out from under the loop.
            const t = this.containerKey(s.target);
            if (t !== null && (t === key || t === root || this.rootOf(t) === root)) mutates = true;
            checkExpr(s.target);
            checkExpr(s.value);
            break;
          }
          case "ExprStmt":
            checkExpr(s.expr);
            break;
          case "Let":
            checkExpr(s.value);
            break;
          case "Return":
            if (s.value) checkExpr(s.value);
            break;
          case "If":
            checkExpr(s.cond);
            walkStmts(s.thenBody);
            if (s.elseBody) walkStmts(s.elseBody);
            break;
          case "While":
            checkExpr(s.cond);
            walkStmts(s.body);
            break;
          case "ForRange":
            checkExpr(s.start);
            checkExpr(s.end);
            walkStmts(s.body);
            break;
          case "UnsafeBlock": case "Block":
            walkStmts(s.body);
            break;
          case "Match":
            checkExpr(s.subject);
            for (const arm of s.arms) walkStmts(arm.body);
            break;
          case "Break":
          case "Continue":
            break;
          default:
            // Anything not understood (match arms, iterator loops, defer, …) is
            // assumed to mutate. Elision is an optimisation; giving up is free.
            mutates = true;
            break;
        }
        if (mutates) return;
      }
    };

    walkStmts(body);
    return mutates;
  }

  // Shallow generic walk over an expression's sub-expressions.
  private walkExpr(e: HIRExpr, visit: (x: HIRExpr) => void): void {
    visit(e);
    const anyE = e as unknown as Record<string, unknown>;
    for (const k of Object.keys(anyE)) {
      const v = anyE[k];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === "object") {
            const cand = ("value" in item && item.value && typeof item.value === "object" && "kind" in item.value)
              ? item.value as HIRExpr : item as HIRExpr;
            if ("kind" in cand) this.walkExpr(cand, visit);
          }
        }
      } else if (v && typeof v === "object" && "kind" in (v as object)) {
        const cand = v as HIRExpr;
        // statements carry `kind` too; only recurse into expression shapes
        if (typeof (cand as { kind: string }).kind === "string") this.walkExpr(cand, visit);
      }
    }
  }

  // Body of the out-of-line handler above. Emitted once per module.
  private boundsFailHelper(): string[] {
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: "__milo_bounds_fail", ret: Ty.void, params: [{ name: "idx", ty: Ty.i64 }, { name: "len", ty: Ty.i64 }, { name: "file", ty: Ty.ptr }, { name: "line", ty: Ty.i32 }], internal: true, attrs: " noreturn cold noinline" });
    lines.push(`  %fmt = getelementptr [${BOUNDS_ERR_LEN} x i8], ptr @.bounds_err, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, "%fmt", `, i64 %idx, i64 %len, ptr %file, i32 %line`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    b.endFn();
    return lines;
  }

  // Runtime exclusivity guard for by-ref arguments. The static call-site check
  // (checker.ts checkCallSiteExclusivity) rejects aliasing it can prove, but two index
  // borrows off one container — `f(v[i], v[j])` — alias only when i==j, which is
  // undecidable until runtime. Two live `&mut` to one address break value semantics and
  // would make `noalias` on those params a miscompile, so compare the borrow addresses
  // pairwise and abort if an at-risk pair coincides. Only pairs with >=1 mutable ref
  // matter: two shared borrows of the same place are legal. Identical SSA operands are
  // the same static place (already a compile error) and are skipped. One `icmp eq ptr`
  // per pair; a call with <2 by-ref args emits nothing.
  private emitAliasGuards(lines: string[], refs: { ptr: string; mut: boolean }[], span?: { line: number; col: number }): void {
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if (!refs[i].mut && !refs[j].mut) continue;
        if (refs[i].ptr === refs[j].ptr) continue;
        this.needsPrintf = true;
        this.needsExit = true;
        const eq = this.nextTemp();
        const bad = this.nextLabel("alias.bad");
        const ok = this.nextLabel("alias.ok");
        lines.push(`  ${eq} = icmp eq ptr ${refs[i].ptr}, ${refs[j].ptr}`);
        lines.push(`  br i1 ${eq}, label %${bad}, label %${ok}`);
        lines.push(`${bad}:`);
        const s = this.addString(`milo: aliasing '&mut' arguments at ${this.panicAt(span)} (two mutable borrows of the same value in one call)\n`);
        const errPtr = this.nextTemp();
        lines.push(`  ${errPtr} = getelementptr [${s.length} x i8], ptr ${s.label}, i32 0, i32 0`);
        this.emitFdPrintf(lines, 2, errPtr, "");
        this.panicAbort(lines);
        lines.push(`  unreachable`);
        lines.push(`${ok}:`);
      }
    }
  }

  // Trap if a collection length/capacity is negative. `len`/`cap` are i64 fields and
  // every index bounds check is an UNSIGNED compare, so a negative count (e.g. from a
  // literal -1 or a wrapped overflow) would sail through as a huge unsigned bound and
  // let any index write past a mis-sized (or failed) allocation — an OOB in safe code.
  // Rust/C++ take unsigned size params + an allocator capacity-overflow guard; this is
  // the runtime half of that guard for `Vec.filled` / `Vec.withCapacity` /
  // `String.withCapacity`, whose counts are i64 and can be negative.
  public emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }) {
    this.needsPrintf = true;
    this.needsExit = true;
    const neg = this.nextTemp();
    const okLabel = this.nextLabel("neglen.ok");
    const failLabel = this.nextLabel("neglen.fail");
    lines.push(`  ${neg} = icmp slt i64 ${val}, 0`);
    lines.push(`  br i1 ${neg}, label %${failLabel}, label %${okLabel}`);
    lines.push(`${failLabel}:`);
    const { label: errLabel, length: errLen } = this.addString(`milo: negative ${what} at ${this.panicAt(span)}: `);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, "");
    const nfmt = this.addString("%lld\n");
    const nfmtPtr = this.nextTemp();
    lines.push(`  ${nfmtPtr} = getelementptr [${nfmt.length} x i8], ptr ${nfmt.label}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, nfmtPtr, `, i64 ${val}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  // Integer `/` and `%` by zero are LLVM UB (unlike `+ - *`, which wrap): sdiv/udiv
  // on a zero divisor is undefined, not merely wrong, so it must trap in EVERY mode
  // rather than emit garbage at -O2. For signed ops INT_MIN / -1 has no representable
  // result and is likewise UB — trap it too. Mirrors the bounds-check trap shape.
  private emitDivByZeroCheck(lines: string[], divisor: string, dividend: string, llType: string, signed: boolean, bits: number, span?: { line: number; col: number }) {
    this.needsPrintf = true;
    this.needsExit = true;
    const at = this.panicAt(span);
    const okLabel = this.nextLabel("divz.ok");
    const zeroFail = this.nextLabel("divz.zero");

    // The two causes get their own messages. Reporting the overflow as "division by zero"
    // sends the reader hunting for a zero divisor that isn't there — the divisor is -1.
    const abort = (label: string, msg: string) => {
      lines.push(`${label}:`);
      const s = this.addString(`${msg}\n`);
      const errPtr = this.nextTemp();
      lines.push(`  ${errPtr} = getelementptr [${s.length} x i8], ptr ${s.label}, i32 0, i32 0`);
      this.emitFdPrintf(lines, 2, errPtr, "");
      this.panicAbort(lines);
      lines.push(`  unreachable`);
    };

    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq ${llType} ${divisor}, 0`);
    if (signed) {
      const ovfCheck = this.nextLabel("divz.chkovf");
      const ovfFail = this.nextLabel("divz.ovf");
      lines.push(`  br i1 ${isZero}, label %${zeroFail}, label %${ovfCheck}`);
      lines.push(`${ovfCheck}:`);
      const minVal = (-(BigInt(2) ** BigInt(bits - 1))).toString();
      const isMin = this.nextTemp();
      lines.push(`  ${isMin} = icmp eq ${llType} ${dividend}, ${minVal}`);
      const isNeg1 = this.nextTemp();
      lines.push(`  ${isNeg1} = icmp eq ${llType} ${divisor}, -1`);
      const ovf = this.nextTemp();
      lines.push(`  ${ovf} = and i1 ${isMin}, ${isNeg1}`);
      lines.push(`  br i1 ${ovf}, label %${ovfFail}, label %${okLabel}`);
      abort(ovfFail, `milo: division overflow (i${bits}::MIN / -1) at ${at}`);
    } else {
      lines.push(`  br i1 ${isZero}, label %${zeroFail}, label %${okLabel}`);
    }
    abort(zeroFail, `milo: division by zero at ${at}`);
    lines.push(`${okLabel}:`);
  }

  private emitShiftCheck(lines: string[], amount: string, llType: string, bits: number, span?: { line: number; col: number }) {
    this.needsPrintf = true;
    const at = this.panicAt(span);
    const okLabel = this.nextLabel("shift.ok");
    const failLabel = this.nextLabel("shift.oob");
    // Unsigned compare so a negative amount (huge as unsigned) fails the same way.
    const bad = this.nextTemp();
    lines.push(`  ${bad} = icmp uge ${llType} ${amount}, ${bits}`);
    lines.push(`  br i1 ${bad}, label %${failLabel}, label %${okLabel}`);
    lines.push(`${failLabel}:`);
    const s = this.addString(`milo: shift amount out of range (>= ${bits}) at ${at}\n`);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${s.length} x i8], ptr ${s.label}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, "");
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  // @wrapping signed div/rem: division by zero still TRAPS (no modular value), but the one
  // signed overflow — INT_MIN / -1 — wraps (quotient → INT_MIN, remainder → 0) instead of
  // trapping. LLVM `sdiv`/`srem` of that exact pair is poison, so we route it around the
  // instruction with a select rather than feeding it the poison operands.
  private emitWrappingSignedDivRem(lines: string[], op: string, lv: string, rv: string, llType: string, bits: number, span?: { line: number; col: number }): string {
    // zero-only trap: pass signed=false so emitDivByZeroCheck skips its INT_MIN/-1 branch.
    this.emitDivByZeroCheck(lines, rv, lv, llType, false, bits, span);
    const minVal = (-(BigInt(2) ** BigInt(bits - 1))).toString();
    const isMin = this.nextTemp();
    lines.push(`  ${isMin} = icmp eq ${llType} ${lv}, ${minVal}`);
    const isNeg1 = this.nextTemp();
    lines.push(`  ${isNeg1} = icmp eq ${llType} ${rv}, -1`);
    const isOvf = this.nextTemp();
    lines.push(`  ${isOvf} = and i1 ${isMin}, ${isNeg1}`);
    // Divide by 1 in the overflow case so the instruction never sees the poison (MIN, -1).
    const safeDivisor = this.nextTemp();
    lines.push(`  ${safeDivisor} = select i1 ${isOvf}, ${llType} 1, ${llType} ${rv}`);
    const raw = this.nextTemp();
    lines.push(`  ${raw} = ${op === "/" ? "sdiv" : "srem"} ${llType} ${lv}, ${safeDivisor}`);
    const wrapped = op === "/" ? minVal : "0";
    const res = this.nextTemp();
    lines.push(`  ${res} = select i1 ${isOvf}, ${llType} ${wrapped}, ${llType} ${raw}`);
    return res;
  }

  // `file:line:col` stamp baked into a runtime panic message. Prefer the span's own file
  // over the file being compiled: a panic can fire inside an imported module (a `!` in
  // std/fs), and blaming the entry file sends the reader to the wrong source line.
  public panicAt(span?: Span): string {
    const file = span?.file ?? this.filePath;
    return `${file ? `${this.displayPath(file)}:` : ""}${span?.line ?? 0}:${span?.col ?? 0}`;
  }

  // The path a panic message shows. An absolute one bakes the *compiling* machine's
  // directory layout — and its username — into every binary that ships, so print the path
  // the way the author would type it: relative to the working directory, or `std/x.milo`
  // for a stdlib file. DWARF paths are deliberately left absolute; a debugger needs those.
  private displayPath(file: string): string {
    if (this.stripPanicLocations) return "<stripped>";
    if (!isAbsolute(file)) return file;
    for (const base of [process.cwd(), STDLIB_DIR]) {
      const rel = relative(base, file);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
    }
    return file;
  }

  // Pointer to the interned name of the file a check lives in, for its error message.
  public emitCheckFilePtr(lines: string[], span?: Span): string {
    const file = this.displayPath(span?.file ?? this.filePath ?? "<unknown>");
    let global = this.checkFileConstants.get(file);
    if (!global) {
      global = `@.check_file_${this.checkFileConstants.size}`;
      this.checkFileConstants.set(file, global);
    }
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = getelementptr [${file.length + 1} x i8], ptr ${global}, i32 0, i32 0`);
    return ptr;
  }

  private emitCheckedArith(lines: string[], op: string, unsigned: boolean, llType: string, lv: string, rv: string, span: Span | undefined): string {
    this.needsOverflowCheck = true;
    this.needsPrintf = true;
    this.needsExit = true;
    const prefix = unsigned ? "u" : "s";
    const intrinsic = `@llvm.${prefix}${op}.with.overflow.${llType}`;
    this.usedOverflowIntrinsics.add(`declare {${llType}, i1} ${intrinsic}(${llType}, ${llType})`);
    const result = this.nextTemp();
    const val = this.nextTemp();
    const flag = this.nextTemp();
    const okLabel = this.nextLabel("overflow.ok");
    const failLabel = this.nextLabel("overflow.fail");
    lines.push(`  ${result} = call {${llType}, i1} ${intrinsic}(${llType} ${lv}, ${llType} ${rv})`);
    lines.push(`  ${val} = extractvalue {${llType}, i1} ${result}, 0`);
    lines.push(`  ${flag} = extractvalue {${llType}, i1} ${result}, 1`);
    lines.push(`  br i1 ${flag}, label %${failLabel}, label %${okLabel}`);
    lines.push(`${failLabel}:`);
    // Same reasoning as emitBoundsCheck: one cold out-of-line call, not three
    // inline ones. Index arithmetic is checked too, so these land in the same hot
    // loops the subscripts do.
    const filePtr = this.emitCheckFilePtr(lines, span);
    lines.push(`  call void @__milo_overflow_fail(ptr ${filePtr}, i32 ${span?.line ?? 0})`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
    return val;
  }

  private emitRangeCheck(lines: string[], val: string, llType: string, signed: boolean, min: number, max: number, span: Span | undefined) {
    this.needsRangeCheck = true;
    this.needsPrintf = true;
    this.needsExit = true;
    const cmpLo = signed ? "slt" : "ult";
    const cmpHi = signed ? "sgt" : "ugt";
    const tooLow = this.nextTemp();
    const tooHigh = this.nextTemp();
    const outOfRange = this.nextTemp();
    const failLabel = this.nextLabel("range.fail");
    const okLabel = this.nextLabel("range.ok");
    lines.push(`  ${tooLow} = icmp ${cmpLo} ${llType} ${val}, ${min}`);
    lines.push(`  ${tooHigh} = icmp ${cmpHi} ${llType} ${val}, ${max}`);
    lines.push(`  ${outOfRange} = or i1 ${tooLow}, ${tooHigh}`);
    lines.push(`  br i1 ${outOfRange}, label %${failLabel}, label %${okLabel}`);
    lines.push(`${failLabel}:`);
    const fmtPtr = this.nextTemp();
    lines.push(`  ${fmtPtr} = getelementptr [44 x i8], ptr @.range_err, i32 0, i32 0`);
    const filePtr = this.emitCheckFilePtr(lines, span);
    this.emitFdPrintf(lines, 2, fmtPtr, `, ptr ${filePtr}, i32 ${span?.line ?? 0}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private emitEnsuresChecks(lines: string[]) {
    for (const c of this.currentEnsures) {
      const [condLines, condVal] = this.genExpr(c.expr);
      lines.push(...condLines);
      this.emitContractCheck(lines, condVal, "ensures", c.span);
    }
  }

  // A for-loop's invariants, asserted at the top of every iteration after the loop variable
  // is bound. Unlike a while loop — whose invariants sit at the condition block and so also
  // run on exit — a for loop's iteration count is owned by the lowering, so this checks each
  // iteration but not the state after the last one. The static prover checks that half.
  private emitLoopInvariants(lines: string[], invariants: HIRContract[] | undefined) {
    if (!this.contractChecks || !invariants) return;
    for (const inv of invariants) {
      const [invLines, invVal] = this.genExpr(inv.expr);
      lines.push(...invLines);
      this.emitContractCheck(lines, invVal, "invariant", inv.span);
    }
  }

  private emitContractCheck(lines: string[], condVal: string, kind: "requires" | "ensures" | "invariant", span: Span | undefined) {
    this.needsContractCheck = true;
    this.needsPrintf = true;
    this.needsExit = true;
    const okLabel = this.nextLabel("contract.ok");
    const failLabel = this.nextLabel("contract.fail");
    lines.push(`  br i1 ${condVal}, label %${okLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    const fmtPtr = this.nextTemp();
    lines.push(`  ${fmtPtr} = getelementptr [44 x i8], ptr @.contract_err, i32 0, i32 0`);
    const kindPtr = this.nextTemp();
    lines.push(`  ${kindPtr} = getelementptr [${kind.length + 1} x i8], ptr @.contract_kind_${kind}, i32 0, i32 0`);
    const filePtr = this.emitCheckFilePtr(lines, span);
    this.emitFdPrintf(lines, 2, fmtPtr, `, ptr ${kindPtr}, ptr ${filePtr}, i32 ${span?.line ?? 0}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private getStructName(llvmTy: string): string | null {
    const m = llvmTy.match(/^%(.+)$/);
    if (m && this.structLayouts.has(m[1])) return m[1];
    return null;
  }

  private genIf(stmt: HIRStmt & { kind: "If" }): [string[], boolean] {
    const lines: string[] = [];
    const [condLines, condVal] = this.genExpr(stmt.cond);
    lines.push(...condLines);
    const thenLabel = this.nextLabel("then");
    const elseLabel = this.nextLabel("else");
    const endLabel = this.nextLabel("endif");
    lines.push(`  br i1 ${condVal}, label %${thenLabel}, label %${elseLabel}`);
    lines.push(`${thenLabel}:`);
    let thenTerminated = false;
    const thenStart = this.droppableLocals.length;
    for (const s of stmt.thenBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) thenTerminated = true; }
    // Block-scope drop: locals owned by this arm die at its end, not the fn epilogue.
    if (!thenTerminated) { this.emitScopeDrops(lines, thenStart); lines.push(`  br label %${endLabel}`); }
    lines.push(`${elseLabel}:`);
    let elseTerminated = false;
    const elseStart = this.droppableLocals.length;
    if (stmt.elseBody) { for (const s of stmt.elseBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) elseTerminated = true; } }
    if (!elseTerminated) { this.emitScopeDrops(lines, elseStart); lines.push(`  br label %${endLabel}`); }
    lines.push(`${endLabel}:`);
    // when both arms return/diverge, the merge block is unreachable; LLVM still requires a terminator
    if (thenTerminated && elseTerminated) lines.push(`  unreachable`);
    return [lines, thenTerminated && elseTerminated];
  }

  // `let g = p else { … }` over a `?&mut T` parameter. One `icmp eq ptr … , null` and a
  // branch: null takes the author's else block (which always diverges — only they know
  // whether this C API answers GIF_ERROR, void or errno), non-null registers `g` exactly
  // as the parameter prologue registers a `&mut T`, so every later read/write goes through
  // the ordinary ref path. No wrapper function, no tag, no Option is built.
  private genNullRefUnwrap(stmt: HIRStmt & { kind: "NullRefUnwrap" }): [string[], boolean] {
    const lines: string[] = [];
    const [ptrLines, ptrVal] = this.genExpr(stmt.ptr);
    lines.push(...ptrLines);
    const isNull = this.nextTemp();
    const nullLabel = this.nextLabel("nullref.null");
    const okLabel = this.nextLabel("nullref.ok");
    lines.push(`  ${isNull} = icmp eq ptr ${ptrVal}, null`);
    lines.push(`  br i1 ${isNull}, label %${nullLabel}, label %${okLabel}`);
    lines.push(`${nullLabel}:`);
    let nullTerminated = false;
    const nullStart = this.droppableLocals.length;
    for (const st of stmt.elseBody) { const [sl, t] = this.genStmt(st); lines.push(...sl); if (t) { nullTerminated = true; break; } }
    // The checker requires the block to diverge, so this branch is normally dead; emit it
    // anyway rather than trusting a rule from another file to keep the IR well-formed.
    if (!nullTerminated) { this.emitScopeDrops(lines, nullStart); lines.push(`  br label %${okLabel}`); }
    lines.push(`${okLabel}:`);
    const addr = `%${stmt.name}.addr`;
    this.entryAllocas.push(`  ${addr} = alloca ptr`);
    lines.push(`  store ptr ${ptrVal}, ptr ${addr}`);
    // `type`/`typeKind` are the POINTEE, with isRef saying the slot holds a pointer to it
    // — the same registration shape a `&mut T` parameter gets.
    this.locals.set(stmt.name, { type: this.llvmType(stmt.inner), typeKind: stmt.inner, mutable: stmt.mutable, isRef: true, addr });
    return [lines, false];
  }

  private genWhile(stmt: HIRStmt & { kind: "While" }): [string[], boolean] {
    const lines: string[] = [];
    const condLabel = this.nextLabel("while.cond");
    const bodyLabel = this.nextLabel("while.body");
    const endLabel = this.nextLabel("while.end");
    const prevHeader = this.loopHeader;
    const prevExit = this.loopExit;
    const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
    this.loopHeader = condLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();
    const lensPushed = this.pushHoistedLens(lines, stmt.body);

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    // invariant must hold before every condition eval: loop entry, each back-edge, and exit
    if (this.contractChecks && stmt.invariants) {
      for (const inv of stmt.invariants) {
        const [invLines, invVal] = this.genExpr(inv.expr);
        lines.push(...invLines);
        this.emitContractCheck(lines, invVal, "invariant", inv.span);
      }
    }
    const [condLines, condVal] = this.genExpr(stmt.cond);
    lines.push(...condLines);
    lines.push(`  br i1 ${condVal}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);
    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) {
      // Block-scope drop: body locals die at the end of each iteration, not at the
      // function epilogue. (break/continue drop the same window via emitLoopDropGlue.)
      this.emitScopeDrops(lines, this.loopDropStart);
      lines.push(`  br label %${condLabel}`);
    }
    lines.push(`${endLabel}:`);
    if (lensPushed) this.hoistedLens.pop();
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
    return [lines, false];
  }

  // Alloca names live for the whole function, but a binding's NAME does not:
  // two sibling loops may both bind `line`, and since the loop scope is now
  // unwound at the loop's end, `locals.has(name)` no longer reports the earlier
  // one. Uniquing has to key off what was actually emitted, or LLVM rejects the
  // function with `multiple definition of local value named 'line.addr'`.
  private emittedAddrs = new Set<string>();

  private allocaName(name: string): string {
    const plain = `%${name}.addr`;
    const addr = this.emittedAddrs.has(plain) ? `%${name}.${this.scopeCounter++}.addr` : plain;
    this.emittedAddrs.add(addr);
    return addr;
  }

  // A loop binding is scoped to the loop body, but `locals` is flat by name, so
  // a binding that shadows an outer name has to be undone when the loop ends.
  // Without this every later mention of that name resolves to the loop's slot:
  // `let row = 5; for row in nums { … }; print(row)` printed the LAST ELEMENT,
  // silently, and mutated a `let`. The checker scopes this correctly (pushScope
  // around the body) — the leak was codegen-only.
  private bindLoopLocal(name: string, entry: LocalInfo): [string, LocalInfo | undefined] {
    const prev = this.locals.get(name);
    this.locals.set(name, entry);
    return [name, prev];
  }

  private unbindLoopLocals(saved: [string, LocalInfo | undefined][]): void {
    for (const [name, prev] of saved) {
      if (prev) this.locals.set(name, prev);
      else this.locals.delete(name);
    }
  }

  private genForRange(stmt: HIRStmt & { kind: "ForRange" }): [string[], boolean] {
    const lines: string[] = [];
    const varTy = this.llvmType(stmt.varType);
    const addrName = this.allocaName(stmt.varName);
    this.entryAllocas.push(`  ${addrName} = alloca ${varTy}`);
    const savedLoopLocals = [this.bindLoopLocal(stmt.varName, { type: varTy, typeKind: stmt.varType, mutable: false, isRef: false, addr: addrName })];

    const [startLines, startVal, startLLTy] = this.genExpr(stmt.start);
    lines.push(...startLines);
    let finalStart = startVal;
    if (startLLTy !== varTy && startLLTy !== "void") {
      const ext = this.nextTemp();
      const signed = stmt.varType.tag === "int" && stmt.varType.signed;
      lines.push(`  ${ext} = ${signed ? "sext" : "zext"} ${startLLTy} ${startVal} to ${varTy}`);
      finalStart = ext;
    }
    lines.push(`  store ${varTy} ${finalStart}, ptr ${addrName}`);

    const [endLines, endVal, endLLTy] = this.genExpr(stmt.end);
    lines.push(...endLines);
    let finalEnd = endVal;
    if (endLLTy !== varTy && endLLTy !== "void") {
      const ext = this.nextTemp();
      const signed = stmt.varType.tag === "int" && stmt.varType.signed;
      lines.push(`  ${ext} = ${signed ? "sext" : "zext"} ${endLLTy} ${endVal} to ${varTy}`);
      finalEnd = ext;
    }

    const condLabel = this.nextLabel("for.cond");
    const bodyLabel = this.nextLabel("for.body");
    const incrLabel = this.nextLabel("for.incr");
    const endLabel = this.nextLabel("for.end");
    const prevHeader = this.loopHeader;
    const prevExit = this.loopExit;
    const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
    // continue goes to increment, not condition
    this.loopHeader = incrLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();

    const lensPushed = this.pushHoistedLens(lines, stmt.body);

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const cur = this.nextTemp();
    lines.push(`  ${cur} = load ${varTy}, ptr ${addrName}`);
    const cmp = this.nextTemp();
    const signed = stmt.varType.tag === "int" && stmt.varType.signed;
    lines.push(`  ${cmp} = icmp ${signed ? "slt" : "ult"} ${varTy} ${cur}, ${finalEnd}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);

    this.emitLoopInvariants(lines, stmt.invariants);

    // `for i in 0..v.len` proves `i < v.len` for the whole body — provided the
    // start is a literal 0 (a negative or dynamic start proves nothing) and
    // nothing in the body can resize the container.
    const provenPushed = this.pushProvenInRange(stmt);

    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (provenPushed) this.provenInRange.pop();
    if (lensPushed) this.hoistedLens.pop();
    if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${incrLabel}`); }

    lines.push(`${incrLabel}:`);
    const cur2 = this.nextTemp();
    const next = this.nextTemp();
    lines.push(`  ${cur2} = load ${varTy}, ptr ${addrName}`);
    lines.push(`  ${next} = add ${varTy} ${cur2}, 1`);
    lines.push(`  store ${varTy} ${next}, ptr ${addrName}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
    this.unbindLoopLocals(savedLoopLocals);
    return [lines, false];
  }

  // A for-in over an rvalue (`for x in makeVec()`) has no address. genLValue
  // returns "null" for a call, so the loop would GEP off a null base — reading a
  // garbage len (usually 0), silently never running the body, and never even
  // emitting the producing call. Materialize the rvalue into a temp alloca and,
  // if it owns heap data, register it as a droppable local so the buffer is freed
  // at function exit. Elements are only borrowed (&T) in the body, never moved, so
  // one whole-container drop is sound and the alive-flag makes it double-free safe.
  // A Vec/array temporary the checker marked consuming takes genConsumedIterable instead.
  private genForEachIterableAddr(iterable: HIRExpr): Gen {
    const lvalueKinds = ["Ident", "FieldAccess", "IndexAccess", "PtrDeref", "HeapDeref"];
    // A field of an rvalue (`for x in mk().items`, or an `@iter` field of
    // `if c { a } else { b }`) is no place either: genLValue answered "null" for it, so
    // the loop read len through a null base (silently zero iterations, or a SIGSEGV for
    // a fork). The whole receiver is materialized into a scoped temp, which then IS a
    // place, so the loop borrows the field in it and the temp drops once, whole.
    let root = iterable;
    while (root.kind === "FieldAccess") root = root.object;
    if (root !== iterable && !lvalueKinds.includes(root.kind)) {
      const lines: string[] = [];
      const rootTy = this.llvmType(root.type);
      const addr = this.nextTemp();
      this.entryAllocas.push(`  ${addr} = alloca ${rootTy}`);
      this.genStoreInto(lines, addr, rootTy, root);
      const name = this.needsDropCg(root.type)
        ? this.registerScopedTemp(lines, addr, root.type)
        : `__forin_tmp.${this.scopeCounter++}`;
      this.locals.set(name, { type: rootTy, typeKind: root.type, mutable: false, isRef: false, addr });
      const rootIdent: HIRExpr = { kind: "Ident", name, type: root.type, isMove: false, span: root.span };
      const rebase = (e: HIRExpr): HIRExpr => e === root ? rootIdent : e.kind === "FieldAccess" ? { ...e, object: rebase(e.object) } : e;
      const [lvLines, lvPtr, lvTy] = this.genLValue(rebase(iterable));
      return [[...lines, ...lvLines], lvPtr, lvTy];
    }
    if (lvalueKinds.includes(iterable.kind)) {
      // Indexing into a temporary container (`for x in mk()[0]`) materializes it into a
      // slot queued on argTempDrops, which no one flushed here: the whole container
      // leaked. It has to live as long as the loop, so it becomes a scoped droppable.
      const mark = this.argTempDrops.length;
      const [lvLines, lvPtr, lvTy] = this.genLValue(iterable);
      for (const t of this.argTempDrops.splice(mark)) this.registerScopedTemp(lvLines, t.addr, t.type);
      return [lvLines, lvPtr, lvTy];
    }
    const lines: string[] = [];
    const iterTy = this.llvmType(iterable.type);
    const addr = this.nextTemp();
    this.entryAllocas.push(`  ${addr} = alloca ${iterTy}`);
    // genStoreInto, like every other temp slot: it keeps a big aggregate in memory.
    this.genStoreInto(lines, addr, iterTy, iterable);
    if (this.needsDropCg(iterable.type)) this.registerScopedTemp(lines, addr, iterable.type);
    return [lines, addr, iterTy];
  }

  // Register before the caller sets loopDropStart so this temp is scoped to the block
  // enclosing the loop (dropped at its exit / early return), not to the loop body.
  private registerScopedTemp(lines: string[], addr: string, typeKind: TypeKind): string {
    const name = `__forin_tmp.${this.scopeCounter++}`;
    this.locals.set(name, { type: this.llvmType(typeKind), typeKind, mutable: false, isRef: false, addr });
    const aliveFlag = `${addr}.alive`;
    this.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
    this.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
    this.own.setAlive(lines, aliveFlag, addr, "forin-tmp");
    this.droppableLocals.push({ name, typeKind, aliveFlag, addr });
    return name;
  }

  // A consuming for-in (`for x in makeVec()`, checker's consumingForIns) owns its
  // temporary outright: evaluated once into a slot, never registered as a whole-container
  // drop (that would free the elements the binding already took). Instead its droppable
  // entry carries a cursor the body advances past each element it moves out, so whichever
  // exit runs first (loop end, `break` dropped at the loop's end label, `return` or `?`
  // through the function drop glue) destroys exactly the elements no iteration reached, then the
  // buffer. Registered before loopDropStart, so `continue` and the per-iteration drops
  // never touch it.
  private genConsumedIterable(iterable: HIRExpr): { lines: string[]; addr: string; iterTy: string; entry: DroppableLocal | null } {
    const lines: string[] = [];
    const iterTy = this.llvmType(iterable.type);
    const addr = this.nextTemp();
    this.entryAllocas.push(`  ${addr} = alloca ${iterTy}`);
    this.genStoreInto(lines, addr, iterTy, iterable);
    if (!this.needsDropCg(iterable.type)) return { lines, addr, iterTy, entry: null };
    const cursor = `${addr}.cursor`;
    this.entryAllocas.push(`  ${cursor} = alloca i64`);
    lines.push(`  store i64 0, ptr ${cursor}`);
    const aliveFlag = `${addr}.alive`;
    this.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
    this.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
    this.own.setAlive(lines, aliveFlag, addr, "consumed-iterable");
    const entry: DroppableLocal = { name: `__forin_consumed.${this.scopeCounter++}`, typeKind: iterable.type, aliveFlag, addr, consumeCursor: cursor };
    this.droppableLocals.push(entry);
    return { lines, addr, iterTy, entry };
  }

  // Move element `elemPtr` into the consuming loop's by-value binding, then advance the
  // container's cursor past it. Both happen before any body code, so no exit can observe
  // the element owned twice or by nobody.
  private emitConsumeElement(lines: string[], elemPtr: string, idx64: string, binding: { addr: string; ty: string; tk: TypeKind; alive: string | null }, entry: DroppableLocal | null) {
    if (this.isBigAgg(binding.ty)) {
      this.emitMemcpy(lines, binding.addr, elemPtr, binding.ty, { intent: "move", type: binding.tk });
    } else {
      const v = this.nextTemp();
      lines.push(`  ${v} = load ${binding.ty}, ptr ${elemPtr}`);
      lines.push(`  store ${binding.ty} ${v}, ptr ${binding.addr}`);
    }
    this.own.moveSlot(elemPtr, binding.addr);
    if (binding.alive) this.own.setAlive(lines, binding.alive, binding.addr, "loop-binding");
    if (entry?.consumeCursor) {
      const next = this.nextTemp();
      lines.push(`  ${next} = add i64 ${idx64}, 1`);
      lines.push(`  store i64 ${next}, ptr ${entry.consumeCursor}`);
    }
  }

  // The by-value binding of a consuming loop: a loop-scoped droppable (pushed after
  // loopDropStart) so the end of each iteration, `continue` and `break` drop it unless
  // the body moved it, which clears the flag exactly as for any local.
  private registerConsumedBinding(name: string, addr: string, typeKind: TypeKind): string | null {
    if (!this.needsDropCg(typeKind)) return null;
    const alive = `${addr}.alive`;
    this.entryAllocas.push(`  ${alive} = alloca i1`);
    this.entryAllocas.push(`  store i1 0, ptr ${alive}`);
    this.registerFieldFlags(this.entryAllocas, addr, name, typeKind);
    this.droppableLocals.push({ name, typeKind, aliveFlag: alive, addr });
    return alive;
  }

  // Drop what a consuming loop's container still owns: elements [cursor, len) (a fixed
  // array's len is its size), then a Vec's buffer.
  private emitConsumedTailDrop(lines: string[], addr: string, typeKind: TypeKind, cursor: string) {
    const elem = typeKind.tag === "vec" || typeKind.tag === "array" ? typeKind.element : null;
    if (!elem) throw new Error(`consumed for-in over ${typeKind.tag}`);
    const elemTy = this.llvmType(elem);
    let base: string;
    let len: string;
    let skipLabel: string | null = null;
    if (typeKind.tag === "vec") {
      this.needsFree = true;
      const vecVal = this.nextTemp();
      lines.push(`  ${vecVal} = load %Vec, ptr ${addr}`);
      base = this.nextTemp();
      lines.push(`  ${base} = extractvalue %Vec ${vecVal}, 0`);
      len = this.nextTemp();
      lines.push(`  ${len} = extractvalue %Vec ${vecVal}, 1`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${base}, null`);
      const dropLabel = this.nextLabel("consumed.drop");
      skipLabel = this.nextLabel("consumed.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
    } else {
      base = addr;
      len = String((typeKind as { size: number | null }).size ?? 0);
    }
    if (this.needsDropCg(elem)) {
      const iAddr = this.nextTemp();
      this.entryAllocas.push(`  ${iAddr} = alloca i64`);
      const start = this.nextTemp();
      lines.push(`  ${start} = load i64, ptr ${cursor}`);
      lines.push(`  store i64 ${start}, ptr ${iAddr}`);
      const condL = this.nextLabel("consumed.tail.cond");
      const bodyL = this.nextLabel("consumed.tail.body");
      const endL = this.nextLabel("consumed.tail.end");
      lines.push(`  br label %${condL}`);
      lines.push(`${condL}:`);
      const i = this.nextTemp();
      lines.push(`  ${i} = load i64, ptr ${iAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${i}, ${len}`);
      lines.push(`  br i1 ${cmp}, label %${bodyL}, label %${endL}`);
      lines.push(`${bodyL}:`);
      const ep = this.nextTemp();
      lines.push(`  ${ep} = getelementptr ${elemTy}, ptr ${base}, i64 ${i}`);
      this.emitDropValue(lines, ep, elem);
      const ni = this.nextTemp();
      lines.push(`  ${ni} = add i64 ${i}, 1`);
      lines.push(`  store i64 ${ni}, ptr ${iAddr}`);
      lines.push(`  br label %${condL}`);
      lines.push(`${endL}:`);
    }
    if (skipLabel) {
      lines.push(`  call void @free(ptr ${base})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
  }

  private genForEach(stmt: HIRStmt & { kind: "ForEach" }): [string[], boolean] {
    const lines: string[] = [];

    if (stmt.iterableKind === "vec") {
      // get pointer to the vec so we can extract data ptr and len
      const consumed = stmt.consume ? this.genConsumedIterable(stmt.iterable) : null;
      const [iterLines, iterAddr] = consumed ? [consumed.lines, consumed.addr] : this.genForEachIterableAddr(stmt.iterable);
      lines.push(...iterLines);
      const dataPtr = this.nextTemp();
      const lenPtr = this.nextTemp();
      const data = this.nextTemp();
      const len = this.nextTemp();
      lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${iterAddr}, i32 0, i32 0`);
      lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
      lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${iterAddr}, i32 0, i32 1`);
      lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);

      // enumerate: varName=index, varName2=element; else varName=element
      const elemTypeKind = stmt.varName2 ? stmt.varType2! : stmt.varType;
      const elemName = stmt.varName2 ?? stmt.varName;
      const elemType = elemTypeKind.tag === "ref" ? elemTypeKind.inner : elemTypeKind;
      const elemTy = this.llvmType(elemType);
      const varAddr = this.allocaName(elemName);
      this.entryAllocas.push(`  ${varAddr} = alloca ${consumed ? elemTy : "ptr"}`);
      const savedLoopLocals = [this.bindLoopLocal(elemName, consumed
        ? { type: elemTy, typeKind: elemType, mutable: false, isRef: false, addr: varAddr }
        : { type: elemTy, typeKind: elemTypeKind, mutable: elemTypeKind.tag === "ref" && elemTypeKind.mutable, isRef: true, addr: varAddr })];
      if (stmt.varName2) {
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const bodyLabel = this.nextLabel("for.body");
      const incrLabel = this.nextLabel("for.incr");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();
      const bindAlive = consumed ? this.registerConsumedBinding(elemName, varAddr, elemType) : null;

      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const idx = this.nextTemp();
      lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const elemPtr = this.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx}`);
      if (consumed && this.own.on && this.needsDropCg(elemType)) this.own.slots.set(elemPtr, this.own.make(lines, "element-moved-out"));
      if (consumed) this.emitConsumeElement(lines, elemPtr, idx, { addr: varAddr, ty: elemTy, tk: elemType, alive: bindAlive }, consumed.entry);
      else lines.push(`  store ptr ${elemPtr}, ptr ${varAddr}`);

      this.emitLoopInvariants(lines, stmt.invariants);
      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${incrLabel}`); }

      lines.push(`${incrLabel}:`);
      const nextIdx = this.nextTemp();
      const curIdx = this.nextTemp();
      lines.push(`  ${curIdx} = load i64, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i64 ${curIdx}, 1`);
      lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${endLabel}:`);
      if (consumed?.entry) this.emitGuardedDrop(lines, consumed.entry);
      this.loopHeader = prevHeader;
      this.loopExit = prevExit;
      this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
      this.unbindLoopLocals(savedLoopLocals);
      return [lines, false];

    } else if (stmt.iterableKind === "string") {
      const [iterLines, iterAddr] = this.genForEachIterableAddr(stmt.iterable);
      lines.push(...iterLines);
      const dataPtr = this.nextTemp();
      const lenPtr = this.nextTemp();
      const data = this.nextTemp();
      const len = this.nextTemp();
      lines.push(`  ${dataPtr} = getelementptr %String, ptr ${iterAddr}, i32 0, i32 0`);
      lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
      lines.push(`  ${lenPtr} = getelementptr %String, ptr ${iterAddr}, i32 0, i32 1`);
      lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);

      const elemName2 = stmt.varName2 ?? stmt.varName;
      const varAddr = this.allocaName(elemName2);
      this.entryAllocas.push(`  ${varAddr} = alloca i8`);
      const savedLoopLocals = [this.bindLoopLocal(elemName2, { type: "i8", typeKind: { tag: "int", bits: 8, signed: false }, mutable: false, isRef: false, addr: varAddr })];
      if (stmt.varName2) {
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const bodyLabel = this.nextLabel("for.body");
      const incrLabel = this.nextLabel("for.incr");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();

      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const idx = this.nextTemp();
      lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const bytePtr = this.nextTemp();
      lines.push(`  ${bytePtr} = getelementptr i8, ptr ${data}, i64 ${idx}`);
      const byte = this.nextTemp();
      lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
      lines.push(`  store i8 ${byte}, ptr ${varAddr}`);

      this.emitLoopInvariants(lines, stmt.invariants);
      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${incrLabel}`); }

      lines.push(`${incrLabel}:`);
      const nextIdx = this.nextTemp();
      const curIdx = this.nextTemp();
      lines.push(`  ${curIdx} = load i64, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i64 ${curIdx}, 1`);
      lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${endLabel}:`);
      this.loopHeader = prevHeader;
      this.loopExit = prevExit;
      this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
      this.unbindLoopLocals(savedLoopLocals);
      return [lines, false];

    } else if (stmt.iterableKind === "array") {
      const consumed = stmt.consume ? this.genConsumedIterable(stmt.iterable) : null;
      const [iterLines, iterAddr, iterTy] = consumed ? [consumed.lines, consumed.addr, consumed.iterTy] : this.genForEachIterableAddr(stmt.iterable);
      lines.push(...iterLines);
      const match = iterTy.match(/\[(\d+) x (.+)\]/);
      if (!match) throw new Error("expected fixed array type for for-each");
      const arrSize = parseInt(match[1]);
      const elemTy = match[2];
      const elemTypeKind3 = stmt.varName2 ? stmt.varType2! : stmt.varType;

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);

      const elemName3 = stmt.varName2 ?? stmt.varName;
      const varAddr = this.allocaName(elemName3);
      this.entryAllocas.push(`  ${varAddr} = alloca ${consumed ? elemTy : "ptr"}`);
      const savedLoopLocals = [this.bindLoopLocal(elemName3, consumed
        ? { type: elemTy, typeKind: elemTypeKind3, mutable: false, isRef: false, addr: varAddr }
        : { type: elemTy, typeKind: elemTypeKind3, mutable: elemTypeKind3.tag === "ref" && elemTypeKind3.mutable, isRef: true, addr: varAddr })];
      if (stmt.varName2) {
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const bodyLabel = this.nextLabel("for.body");
      const incrLabel = this.nextLabel("for.incr");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();
      const bindAlive = consumed ? this.registerConsumedBinding(elemName3, varAddr, elemTypeKind3) : null;

      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const idx = this.nextTemp();
      lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${arrSize}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const elemPtr = this.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${iterTy}, ptr ${iterAddr}, i32 0, i64 ${idx}`);
      if (consumed && this.own.on && this.needsDropCg(elemTypeKind3)) this.own.slots.set(elemPtr, this.own.make(lines, "element-moved-out"));
      if (consumed) this.emitConsumeElement(lines, elemPtr, idx, { addr: varAddr, ty: elemTy, tk: elemTypeKind3, alive: bindAlive }, consumed.entry);
      else lines.push(`  store ptr ${elemPtr}, ptr ${varAddr}`);

      this.emitLoopInvariants(lines, stmt.invariants);
      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${incrLabel}`); }

      lines.push(`${incrLabel}:`);
      const curIdx = this.nextTemp();
      const nextIdx = this.nextTemp();
      lines.push(`  ${curIdx} = load i64, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i64 ${curIdx}, 1`);
      lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${endLabel}:`);
      if (consumed?.entry) this.emitGuardedDrop(lines, consumed.entry);
      this.loopHeader = prevHeader;
      this.loopExit = prevExit;
      this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
      this.unbindLoopLocals(savedLoopLocals);
      return [lines, false];

    } else {
      // hashmap iteration
      const [iterLines, iterAddr] = this.genForEachIterableAddr(stmt.iterable);
      lines.push(...iterLines);
      const dataPtr = this.nextTemp();
      const capPtr = this.nextTemp();
      const data = this.nextTemp();
      const cap = this.nextTemp();
      lines.push(`  ${dataPtr} = getelementptr %HashMap, ptr ${iterAddr}, i32 0, i32 ${HM_DATA}`);
      lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
      lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${iterAddr}, i32 0, i32 ${HM_CAP}`);
      lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

      const keyType = stmt.varType.tag === "ref" ? stmt.varType.inner : stmt.varType;
      const valType = stmt.varType2?.tag === "ref" ? stmt.varType2.inner : (stmt.varType2 ?? { tag: "void" as const });
      const entryTy = this.hashMapEntryType(keyType, valType);
      const keyTy = this.llvmType(keyType);
      const valTy = this.llvmType(valType);

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);

      // A shadowing binding needs its OWN alloca, or the loop writes through to
      // the outer variable's storage — the same `.N.addr` fallback the vec and
      // array branches use.
      const keyVarAddr = this.allocaName(stmt.varName);
      this.entryAllocas.push(`  ${keyVarAddr} = alloca ptr`);
      const savedLoopLocals = [this.bindLoopLocal(stmt.varName, { type: keyTy, typeKind: stmt.varType, mutable: false, isRef: true, addr: keyVarAddr })];

      let valVarAddr = "";
      if (stmt.varName2 && stmt.varType2) {
        valVarAddr = this.allocaName(stmt.varName2);
        this.entryAllocas.push(`  ${valVarAddr} = alloca ptr`);
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName2, { type: valTy, typeKind: stmt.varType2, mutable: false, isRef: true, addr: valVarAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const checkLabel = this.nextLabel("for.check");
      const bodyLabel = this.nextLabel("for.body");
      const nextLabel = this.nextLabel("for.next");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
      this.loopHeader = nextLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();

      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const idx = this.nextTemp();
      lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${cap}`);
      lines.push(`  br i1 ${cmp}, label %${checkLabel}, label %${endLabel}`);

      lines.push(`${checkLabel}:`);
      const entryPtr = this.nextTemp();
      lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${idx}`);
      const statePtr = this.nextTemp();
      lines.push(`  ${statePtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 0`);
      const state = this.nextTemp();
      lines.push(`  ${state} = load i8, ptr ${statePtr}`);
      const isOccupied = this.nextTemp();
      lines.push(`  ${isOccupied} = icmp eq i8 ${state}, 1`);
      lines.push(`  br i1 ${isOccupied}, label %${bodyLabel}, label %${nextLabel}`);

      lines.push(`${bodyLabel}:`);
      const keyPtr = this.nextTemp();
      lines.push(`  ${keyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
      lines.push(`  store ptr ${keyPtr}, ptr ${keyVarAddr}`);
      if (stmt.varName2) {
        const valPtr = this.nextTemp();
        lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
        // Must be the uniqued alloca, not `%<name>.addr` — a second `for k, v in map`
        // in the same function gets `%v.N.addr`, and spelling the plain name here wrote
        // the value into the FIRST loop's slot while reads came from an unwritten one.
        lines.push(`  store ptr ${valPtr}, ptr ${valVarAddr}`);
      }

      this.emitLoopInvariants(lines, stmt.invariants);
      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${nextLabel}`); }

      lines.push(`${nextLabel}:`);
      const nextIdx = this.nextTemp();
      const curIdx = this.nextTemp();
      lines.push(`  ${curIdx} = load i64, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i64 ${curIdx}, 1`);
      lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${endLabel}:`);
      this.loopHeader = prevHeader;
      this.loopExit = prevExit;
      this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
      this.unbindLoopLocals(savedLoopLocals);
      return [lines, false];
    }
  }

  // Naive substring search shared by every `splitView`/`lines` loop: returns the byte
  // offset of `n` in `h` at or after `from`, or -1. Emitted once per module; a Milo-level
  // `strIndexOfFrom` can't be used here because codegen cannot assume std/string is
  // imported by the program being compiled.
  private strFindFn(): string {
    if (!this.emittedStrFind) {
      this.emittedStrFind = true;
      this.needsMemcmp = true;
      this.helperFnBodies.push(runtimeFn("milo.strfind"));
    }
    return "@milo.strfind";
  }

  // `for line in text.lines()` / `for f in text.splitView(sep)`. Each iteration stores a
  // non-owning %String (cap 0, so drop glue skips it) pointing into the receiver's buffer,
  // which the checker has frozen for the whole loop.
  private genForStrView(stmt: HIRStmt & { kind: "ForStrView" }): [string[], boolean] {
    const lines: string[] = [];
    this.hasStringType = true;

    const [srcLines, srcAddr] = this.genForEachIterableAddr(stmt.src);
    lines.push(...srcLines);
    const dataPtr = this.nextTemp();
    const data = this.nextTemp();
    const lenPtr = this.nextTemp();
    const len = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %String, ptr ${srcAddr}, i32 0, i32 0`);
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    lines.push(`  ${lenPtr} = getelementptr %String, ptr ${srcAddr}, i32 0, i32 1`);
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    // the separator: an explicit argument for splitView, a literal newline for lines
    let sepPtr: string;
    let sepLen: string;
    if (stmt.mode === "split" && stmt.sep) {
      const [sepLines, sepVal] = this.genExpr(stmt.sep);
      lines.push(...sepLines);
      sepPtr = this.nextTemp();
      sepLen = this.nextTemp();
      lines.push(`  ${sepPtr} = extractvalue %String ${sepVal}, 0`);
      lines.push(`  ${sepLen} = extractvalue %String ${sepVal}, 1`);
    } else {
      const { label, length } = this.addString("\n");
      sepPtr = this.nextTemp();
      lines.push(`  ${sepPtr} = getelementptr [${length} x i8], ptr ${label}, i32 0, i32 0`);
      sepLen = "1";
    }
    const findFn = this.strFindFn();

    const posAddr = `%__strview_pos.${this.scopeCounter++}.addr`;
    const nextAddr = `%__strview_next.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${posAddr} = alloca i64`);
    this.entryAllocas.push(`  ${nextAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${posAddr}`);

    // enumerate form: `for i, line in text.lines()` binds the piece to the second name
    const viewName = stmt.varName2 ?? stmt.varName;
    const varAddr = this.allocaName(viewName);
    this.entryAllocas.push(`  ${varAddr} = alloca %String`);
    const savedLoopLocals = [this.bindLoopLocal(viewName, { type: "%String", typeKind: stmt.varType, mutable: false, isRef: false, addr: varAddr })];
    let idxAddr: string | null = null;
    if (stmt.varName2) {
      idxAddr = `%__strview_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);
      savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
    }

    const condLabel = this.nextLabel("strview.cond");
    const bodyLabel = this.nextLabel("strview.body");
    const incrLabel = this.nextLabel("strview.incr");
    const endLabel = this.nextLabel("strview.end");
    const prevHeader = this.loopHeader;
    const prevExit = this.loopExit;
    const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
    this.loopHeader = incrLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const pos = this.nextTemp();
    lines.push(`  ${pos} = load i64, ptr ${posAddr}`);
    const more = this.nextTemp();
    if (stmt.mode === "lines") {
      // a trailing newline ends the last line, it does not start an empty one
      lines.push(`  ${more} = icmp slt i64 ${pos}, ${len}`);
    } else {
      // `pos == len` still yields the piece after a trailing separator ("a," -> "a", "")
      const inRange = this.nextTemp();
      const sepEmpty = this.nextTemp();
      const emptyDone = this.nextTemp();
      const notEmptyDone = this.nextTemp();
      lines.push(`  ${inRange} = icmp sle i64 ${pos}, ${len}`);
      // an empty separator splits into single bytes, which run out one step earlier
      lines.push(`  ${sepEmpty} = icmp eq i64 ${sepLen}, 0`);
      lines.push(`  ${emptyDone} = icmp sge i64 ${pos}, ${len}`);
      lines.push(`  ${notEmptyDone} = xor i1 ${emptyDone}, true`);
      const okEmpty = this.nextTemp();
      lines.push(`  ${okEmpty} = select i1 ${sepEmpty}, i1 ${notEmptyDone}, i1 true`);
      lines.push(`  ${more} = and i1 ${inRange}, ${okEmpty}`);
    }
    lines.push(`  br i1 ${more}, label %${bodyLabel}, label %${endLabel}`);

    lines.push(`${bodyLabel}:`);
    const found = this.nextTemp();
    lines.push(`  ${found} = call i64 ${findFn}(ptr ${data}, i64 ${len}, ptr ${sepPtr}, i64 ${sepLen}, i64 ${pos})`);
    let sepIdx = found;
    if (stmt.mode === "split") {
      // an empty needle matches at `pos` and would never advance; treat the next byte
      // boundary as the separator instead, which is what strSplit("") yields
      const sepEmpty2 = this.nextTemp();
      const posPlus1 = this.nextTemp();
      const chosen = this.nextTemp();
      lines.push(`  ${sepEmpty2} = icmp eq i64 ${sepLen}, 0`);
      lines.push(`  ${posPlus1} = add i64 ${pos}, 1`);
      lines.push(`  ${chosen} = select i1 ${sepEmpty2}, i64 ${posPlus1}, i64 ${found}`);
      sepIdx = chosen;
    }
    const hasSep = this.nextTemp();
    const pieceEnd = this.nextTemp();
    lines.push(`  ${hasSep} = icmp sge i64 ${sepIdx}, 0`);
    lines.push(`  ${pieceEnd} = select i1 ${hasSep}, i64 ${sepIdx}, i64 ${len}`);

    let viewEnd = pieceEnd;
    if (stmt.mode === "lines") {
      // CRLF: the '\r' belongs to the line ending, not to the line
      const nonEmpty = this.nextTemp();
      const prevIdx = this.nextTemp();
      const probeIdx = this.nextTemp();
      const probePtr = this.nextTemp();
      const probe = this.nextTemp();
      const isCR = this.nextTemp();
      const strip = this.nextTemp();
      const stripped = this.nextTemp();
      lines.push(`  ${nonEmpty} = icmp sgt i64 ${pieceEnd}, ${pos}`);
      lines.push(`  ${prevIdx} = sub i64 ${pieceEnd}, 1`);
      // clamped so the load stays inside the buffer when the line is empty
      lines.push(`  ${probeIdx} = select i1 ${nonEmpty}, i64 ${prevIdx}, i64 ${pos}`);
      lines.push(`  ${probePtr} = getelementptr i8, ptr ${data}, i64 ${probeIdx}`);
      lines.push(`  ${probe} = load i8, ptr ${probePtr}`);
      lines.push(`  ${isCR} = icmp eq i8 ${probe}, 13`);
      lines.push(`  ${strip} = and i1 ${nonEmpty}, ${isCR}`);
      lines.push(`  ${stripped} = select i1 ${strip}, i64 ${prevIdx}, i64 ${pieceEnd}`);
      viewEnd = stripped;
    }

    const viewPtr = this.nextTemp();
    const viewLen = this.nextTemp();
    lines.push(`  ${viewPtr} = getelementptr i8, ptr ${data}, i64 ${pos}`);
    lines.push(`  ${viewLen} = sub i64 ${viewEnd}, ${pos}`);
    const v0 = this.nextTemp();
    const v1 = this.nextTemp();
    const v2 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %String undef, ptr ${viewPtr}, 0`);
    lines.push(`  ${v1} = insertvalue %String ${v0}, i64 ${viewLen}, 1`);
    lines.push(`  ${v2} = insertvalue %String ${v1}, i64 0, 2`);
    lines.push(`  store %String ${v2}, ptr ${varAddr}`);

    // Computed here, where the search result is live, and read back in the increment
    // block — which `continue` can also reach, from blocks that do not see these values.
    const afterSep = this.nextTemp();
    const past = this.nextTemp();
    const nextPos = this.nextTemp();
    lines.push(`  ${afterSep} = add i64 ${pieceEnd}, ${sepLen}`);
    lines.push(`  ${past} = add i64 ${len}, 1`);
    lines.push(`  ${nextPos} = select i1 ${hasSep}, i64 ${afterSep}, i64 ${past}`);
    lines.push(`  store i64 ${nextPos}, ptr ${nextAddr}`);

    this.emitLoopInvariants(lines, stmt.invariants);

    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${incrLabel}`); }

    lines.push(`${incrLabel}:`);
    const advanced = this.nextTemp();
    lines.push(`  ${advanced} = load i64, ptr ${nextAddr}`);
    lines.push(`  store i64 ${advanced}, ptr ${posAddr}`);
    if (idxAddr) {
      const curIdx = this.nextTemp();
      const nextIdx = this.nextTemp();
      lines.push(`  ${curIdx} = load i64, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i64 ${curIdx}, 1`);
      lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    }
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
    this.unbindLoopLocals(savedLoopLocals);
    return [lines, false];
  }

  private genForIterator(stmt: HIRStmt & { kind: "ForIterator" }): [string[], boolean] {
    const lines: string[] = [];
    // The iterator protocol calls next(&mut self), which needs the iterable at a
    // real address. An lvalue already has one; an rvalue (e.g. `for x in mk()`)
    // does not — genLValue would hand back `null` and next() would deref it
    // (SIGTRAP). Materialize the rvalue into a temp alloca first.
    // The temporary is dropped when the loop's enclosing block exits, exactly as for a
    // Vec: `for x in makeChannel()` used to leak the whole channel.
    const [iterLines, iterAddr] = this.genForEachIterableAddr(stmt.iterable);
    lines.push(...iterLines);

    const sig = this.fnSigs.get(stmt.nextMethod);
    const retTy = sig?.retType ?? `%${stmt.optionEnumName}`;
    const layout = this.enumLayouts.get(stmt.optionEnumName);
    if (!layout) throw new Error(`enum layout not found for ${stmt.optionEnumName}`);

    const noneVariant = must(layout.variants, "None", "variants");
    const elemTy = this.llvmType(stmt.varType);

    const varAddr = this.allocaName(stmt.varName);
    this.entryAllocas.push(`  ${varAddr} = alloca ${elemTy}`);
    const savedLoopLocals = [this.bindLoopLocal(stmt.varName, { type: elemTy, typeKind: stmt.varType, mutable: false, isRef: false, addr: varAddr })];

    const condLabel = this.nextLabel("iter.cond");
    const bodyLabel = this.nextLabel("iter.body");
    const endLabel = this.nextLabel("iter.end");
    const prevHeader = this.loopHeader;
    const prevExit = this.loopExit;
    const prevDropStart = this.loopDropStart, prevPend = { ...this.pend };
    this.loopHeader = condLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length; this.enterLoopBodyPending();
    // next() hands each element out by value, so the binding owns it exactly as a
    // consuming Vec loop's binding does: loop-scoped, dropped unless the body moves it.
    const bindAlive = this.registerConsumedBinding(stmt.varName, varAddr, stmt.varType);

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);

    // call next(&mut self); stage the Option enum in memory to extract the tag
    const stagePtr = this.nextTemp();
    this.entryAllocas.push(`  ${stagePtr} = alloca ${retTy}`);
    if (this.sretFns.has(stmt.nextMethod)) {
      lines.push(`  call void @${stmt.nextMethod}(ptr ${stagePtr}, ptr ${iterAddr})`);
    } else {
      const result = this.nextTemp();
      lines.push(`  ${result} = call ${retTy} @${stmt.nextMethod}(ptr ${iterAddr})`);
      lines.push(`  store ${retTy} ${result}, ptr ${stagePtr}`);
    }
    const tag = this.loadEnumTag(lines, retTy, stagePtr);

    // branch: Some → body, None → end
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, ${noneVariant.tag}`);
    lines.push(`  br i1 ${cmp}, label %${endLabel}, label %${bodyLabel}`);

    lines.push(`${bodyLabel}:`);
    // extract payload from Some variant
    const payloadPtr = this.enumPayloadPtr(lines, retTy, stagePtr, "Some");
    // next()'s Some payload is a fresh owned value in this frame; the binding takes it.
    if (this.own.on && this.needsDropCg(stmt.varType)) this.own.slots.set(payloadPtr, this.own.make(lines, "next-payload"));
    this.emitConsumeElement(lines, payloadPtr, "", { addr: varAddr, ty: elemTy, tk: stmt.varType, alive: bindAlive }, null);

    this.emitLoopInvariants(lines, stmt.invariants);
    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) { this.emitScopeDrops(lines, this.loopDropStart); lines.push(`  br label %${condLabel}`); }

    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart; this.pend.loopTemps = prevPend.loopTemps; this.pend.loopArgTemps = prevPend.loopArgTemps;
    this.unbindLoopLocals(savedLoopLocals);
    return [lines, false];
  }

  // The machinery behind lazy globals (see src/lazy-globals.ts for where reads are guarded).
  //
  // Per global G: a state word (0 not started, 1 initializer running, 2 done), the token
  // of whoever is running the initializer, and `__milo.lazy.G`, the guard every read goes
  // through: one acquire load and a branch once G is initialized, which is the whole cost
  // of laziness on the hot path. The first reader wins a compare-and-swap, runs
  // `__milo.lazyinit.G` and publishes with a release store; a reader that loses waits.
  //
  // The token tells "another task or thread is initializing G" (wait for it) from "this
  // task is, and has come back round to G" (an initialization cycle: waiting would never
  // end, so it panics, naming G). It is the running green task when there is one, since
  // two tasks share an OS thread, and otherwise the address of a thread-local byte, which
  // is distinct per thread. Waiting yields to the scheduler on a green task, drives it on
  // a main thread that has one (the initializer may be a parked task), and yields the CPU
  // on a plain thread. Without std/runtime in the program there are no green tasks, and
  // without threads (a bare-metal target) a busy G can only be a cycle.
  //
  // A global declared `thread_local` gets thread-local state too: each thread initializes
  // its own copy on its own first read.
  private emitLazyGlobals(functions: HIRFunction[]): string[] {
    const L: string[] = [];
    // Bare metal and wasm run one thread: plain loads and stores (a Cortex-M0 has no
    // 64-bit compare-and-swap to lower an atomic to), and no thread-local storage.
    const bare = !!this.target.bareMetal;
    const tls = bare ? "" : "thread_local ";
    const has = (n: string) => functions.some(f => f.name === n && !f.isExtern);
    const green = !bare && has("schedulerCurrent") && has("schedulerYield") && has("schedulerExists") && has("schedulerPollMain");
    L.push(`@__milo_lazy_tid = internal ${tls}global i8 0`);
    // What this thread is initializing, for the panic note. Values, not a list of stack
    // frames: green tasks interleave on one thread, so this can go stale, and a stale name
    // pointer is still a valid constant (the token check below keeps it from misleading).
    L.push(`@__milo_lazy_cur_name = internal ${tls}global ptr null`);
    L.push(`@__milo_lazy_cur_tok = internal ${tls}global i64 0`);
    for (const [name, g] of this.lazyGlobals) {
      const gtls = g.threadLocal && !bare ? "thread_local " : "";
      const shown = this.addString(display(this.displayNames, name));
      L.push(`@"${name}.lazy" = internal ${gtls}global i64 0`);
      L.push(`@"${name}.lazyown" = internal ${gtls}global i64 0`);
      L.push(`@"${name}.lazythr" = internal ${gtls}global i64 0`);
      const bGuard = new LlvmTextBuilder(L, this);
      bGuard.defineFn({ name: `"${LAZY_GUARD_PREFIX}${name}"`, ret: Ty.void, params: [], internal: true });
      L.push(bare ? `  %s = load i64, ptr @"${name}.lazy", align 8` : `  %s = load atomic i64, ptr @"${name}.lazy" acquire, align 8`);
      L.push(`  %d = icmp eq i64 %s, 2`);
      L.push(`  br i1 %d, label %done, label %slow`);
      L.push(`slow:`);
      L.push(`  call void @__milo_lazy_slow(ptr @"${name}.lazy", ptr @"${name}.lazyown", ptr @"${name}.lazythr", ptr ${shown.label}, ptr @"${LAZY_INIT_PREFIX}${name}")`);
      L.push(`  br label %done`);
      L.push(`done:`);
      L.push(`  ret void`);
      bGuard.endFn();
    }

    const bTok = new LlvmTextBuilder(L, this);
    bTok.defineFn({ name: "__milo_lazy_token", ret: Ty.i64, params: [], internal: true });
    if (green) {
      L.push(`  %t = call ptr @schedulerCurrent()`);
      L.push(`  %n = icmp eq ptr %t, null`);
      L.push(`  br i1 %n, label %thread, label %task`);
      L.push(`task:`);
      L.push(`  %ti = ptrtoint ptr %t to i64`);
      L.push(`  ret i64 %ti`);
      L.push(`thread:`);
    }
    L.push(`  %a = call i64 @__milo_lazy_thread()`);
    L.push(`  ret i64 %a`);
    bTok.endFn();
    const bThr = new LlvmTextBuilder(L, this);
    bThr.defineFn({ name: "__milo_lazy_thread", ret: Ty.i64, params: [], internal: true });
    L.push(`  %a = ptrtoint ptr @__milo_lazy_tid to i64`);
    L.push(`  %a1 = or i64 %a, 1`);
    L.push(`  ret i64 %a1`);
    bThr.endFn();

    // Waiting for an initializer another task on THIS thread is running: that task is
    // parked (it could not have let us run otherwise), so this one has to let the
    // scheduler run, by yielding from a task or by driving it from the main thread. The
    // checker charges that park to the read, because the initializer itself parks.
    // An initializer on ANOTHER thread needs nothing from this one, so that wait only
    // yields the CPU and never lets another green task in: a read of a global whose
    // initializer does not park must never park.
    if (!bare) {
      const bWait = new LlvmTextBuilder(L, this);
      bWait.defineFn({ name: "__milo_lazy_wait", ret: Ty.void, params: [{ name: "here", ty: Ty.i1 }], internal: true });
      L.push(`  br i1 %here, label %sched, label %os`);
      L.push(`sched:`);
      if (green) {
        L.push(`  %t = call ptr @schedulerCurrent()`);
        L.push(`  %n = icmp eq ptr %t, null`);
        L.push(`  br i1 %n, label %nottask, label %task`);
        L.push(`task:`);
        L.push(`  call void @schedulerYield()`);
        L.push(`  ret void`);
        L.push(`nottask:`);
        L.push(`  %e = call i1 @schedulerExists()`);
        L.push(`  br i1 %e, label %drive, label %os`);
        L.push(`drive:`);
        L.push(`  call void @schedulerPollMain()`);
        L.push(`  ret void`);
      } else {
        L.push(`  br label %os`);
      }
      L.push(`os:`);
      if (!this.isWindows) {
        this.needsSchedYield = true;
        L.push(`  call i32 @sched_yield()`);
      }
      L.push(`  ret void`);
      bWait.endFn();
    }

    const cycleFmt = this.addString("error: initialization cycle: global '%s' is read while its own initializer is running\n");
    const byFmt = this.addString("  (read by the initializer of '%s')\n");
    const noteFmt = this.addString("note: this panic happened while initializing global '%s' (it is initialized on first read)\n");
    const bSlow = new LlvmTextBuilder(L, this);
    bSlow.defineFn({ name: "__milo_lazy_slow", ret: Ty.void, params: [{ name: "st", ty: Ty.ptr }, { name: "own", ty: Ty.ptr }, { name: "thr", ty: Ty.ptr }, { name: "name", ty: Ty.ptr }, { name: "init", ty: Ty.ptr }], internal: true, attrs: " noinline" });
    L.push(`  %tok = call i64 @__milo_lazy_token()`);
    L.push(`  %me = call i64 @__milo_lazy_thread()`);
    L.push(`  br label %try`);
    L.push(`try:`);
    if (bare) {
      L.push(`  %old = load i64, ptr %st, align 8`);
      L.push(`  %won = icmp eq i64 %old, 0`);
      L.push(`  br i1 %won, label %claim, label %lost`);
      L.push(`claim:`);
      L.push(`  store i64 1, ptr %st, align 8`);
      L.push(`  br label %run`);
    } else {
      L.push(`  %pair = cmpxchg ptr %st, i64 0, i64 1 acq_rel acquire, align 8`);
      L.push(`  %won = extractvalue { i64, i1 } %pair, 1`);
      L.push(`  %old = extractvalue { i64, i1 } %pair, 0`);
      L.push(`  br i1 %won, label %run, label %lost`);
    }
    L.push(`run:`);
    L.push(bare ? `  store i64 %tok, ptr %own, align 8` : `  store atomic i64 %tok, ptr %own release, align 8`);
    L.push(bare ? `  store i64 %me, ptr %thr, align 8` : `  store atomic i64 %me, ptr %thr release, align 8`);
    L.push(`  %pn = load ptr, ptr @__milo_lazy_cur_name`);
    L.push(`  %pt = load i64, ptr @__milo_lazy_cur_tok`);
    L.push(`  store ptr %name, ptr @__milo_lazy_cur_name`);
    L.push(`  store i64 %tok, ptr @__milo_lazy_cur_tok`);
    L.push(`  call void %init()`);
    L.push(`  store ptr %pn, ptr @__milo_lazy_cur_name`);
    L.push(`  store i64 %pt, ptr @__milo_lazy_cur_tok`);
    L.push(bare ? `  store i64 2, ptr %st, align 8` : `  store atomic i64 2, ptr %st release, align 8`);
    L.push(`  ret void`);
    L.push(`lost:`);
    L.push(`  %fin = icmp eq i64 %old, 2`);
    // On a target with no threads and no scheduler, nobody else can be running it.
    L.push(`  br i1 %fin, label %out, label %${bare ? "cycle" : "busy"}`);
    if (!bare) {
      L.push(`busy:`);
      L.push(`  %o = load atomic i64, ptr %own acquire, align 8`);
      L.push(`  %mine = icmp eq i64 %o, %tok`);
      L.push(`  br i1 %mine, label %cycle, label %wait`);
      L.push(`wait:`);
      L.push(`  %ot = load atomic i64, ptr %thr acquire, align 8`);
      L.push(`  %here = icmp eq i64 %ot, %me`);
      L.push(`  call void @__milo_lazy_wait(i1 %here)`);
      L.push(`  br label %try`);
    }
    L.push(`cycle:`);
    const cyc: string[] = [];
    this.emitFdPrintf(cyc, 2, cycleFmt.label, `, ptr %name`);
    L.push(...cyc);
    L.push(`  %cn = load ptr, ptr @__milo_lazy_cur_name`);
    L.push(`  %ct = load i64, ptr @__milo_lazy_cur_tok`);
    L.push(`  %cnn = icmp ne ptr %cn, null`);
    L.push(`  %cself = icmp eq i64 %ct, %tok`);
    L.push(`  %cother = icmp ne ptr %cn, %name`);
    L.push(`  %c1 = and i1 %cnn, %cself`);
    L.push(`  %c2 = and i1 %c1, %cother`);
    L.push(`  br i1 %c2, label %by, label %die`);
    L.push(`by:`);
    const by: string[] = [];
    this.emitFdPrintf(by, 2, byFmt.label, `, ptr %cn`);
    L.push(...by);
    L.push(`  br label %die`);
    L.push(`die:`);
    // The note would repeat what was just said.
    L.push(`  store ptr null, ptr @__milo_lazy_cur_name`);
    const die: string[] = [];
    this.panicAbort(die);
    L.push(...die);
    L.push(`  unreachable`);
    L.push(`out:`);
    L.push(`  ret void`);
    bSlow.endFn();

    const bNote = new LlvmTextBuilder(L, this);
    bNote.defineFn({ name: "__milo_lazy_panic_note", ret: Ty.void, params: [], internal: true });
    L.push(`  %cn = load ptr, ptr @__milo_lazy_cur_name`);
    L.push(`  %cnn = icmp ne ptr %cn, null`);
    L.push(`  br i1 %cnn, label %check, label %out`);
    L.push(`check:`);
    L.push(`  %ct = load i64, ptr @__milo_lazy_cur_tok`);
    L.push(`  %tok = call i64 @__milo_lazy_token()`);
    L.push(`  %same = icmp eq i64 %ct, %tok`);
    L.push(`  br i1 %same, label %note, label %out`);
    L.push(`note:`);
    const note: string[] = [];
    this.emitFdPrintf(note, 2, noteFmt.label, `, ptr %cn`);
    L.push(...note);
    if (this.target.os !== "none") {
      this.needsFflush = true;
      this.needsAbort = true;
      L.push(`  call i32 @fflush(ptr null)`);
      L.push(`  call void @abort()`);
    } else {
      this.needsExit = true;
      L.push(`  call void @exit(i32 1)`);
    }
    L.push(`  unreachable`);
    L.push(`out:`);
    L.push(`  ret void`);
    bNote.endFn();
    return L;
  }

  public genFormatParts(args: HIRArg[], lines: string[]): { val: string; ty: string; expr: HIRExpr }[] {
    const out: { val: string; ty: string; expr: HIRExpr }[] = [];
    for (const arg of args) {
      const [al, av, at] = this.genExpr(arg.expr);
      lines.push(...al);
      out.push({ val: av, ty: at, expr: arg.expr });
    }
    return out;
  }

  private genBuiltinCall(expr: HIRExpr & { kind: "Call" }, lines: string[]): Gen {
    if (expr.func === "print" || expr.func === "format") {
      this.needsFree = true;
      const isFormat = expr.func === "format";

      // format(): stringify every part into one snprintf'd buffer. (Note: snprintf's
      // %.*s still truncates a string part at an embedded NUL — format() of binary is
      // a known follow-up; print() below is the NUL-correct path.)
      if (isFormat && expr.args.every(a => this.fastFormatPart(a.expr.type) !== null)) {
        // Every part is text, an int, a bool or a float: build the string in place.
        const acc = `%__fmt.${this.scopeCounter++}.addr`;
        this.entryAllocas.push(`  ${acc} = alloca %String`);
        lines.push(`  store %String { ptr null, i64 0, i64 0 }, ptr ${acc}`);
        const temps = this.genFormatParts(expr.args, lines);
        this.emitAppendFormatParts(lines, acc, temps.map(t => ({ val: t.val, ty: t.ty, tk: t.expr.type })), expr.span);
        for (const t of temps) this.dropOwnedTemp(lines, t.val, t.ty, t.expr);
        const out = this.nextTemp();
        lines.push(`  ${out} = load %String, ptr ${acc}`);
        return [lines, out, "%String"];
      }
      if (isFormat) {
        this.needsPrintf = true;
        const partFmts: string[] = [];
        const partArgs: { val: string; type: string }[] = [];
        const tempBufs: string[] = [];
        const fmtTemps: { val: string; ty: string; expr: HIRExpr }[] = [];
        for (const arg of expr.args) {
          const [al, av, at] = this.genExpr(arg.expr);
          lines.push(...al);
          fmtTemps.push({ val: av, ty: at, expr: arg.expr });
          const bufMark = tempBufs.length;
          this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
          this.pendBufs(tempBufs, bufMark);
        }
        const fmtStr = this.addString(partFmts.join(""));
        const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
        this.needsMalloc = true;
        this.needsSnprintf = true;
        this.hasStringType = true;
        const lenResult = this.nextTemp();
        lines.push(`  ${lenResult} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmtStr.label}${argsStr})`);
        this.emitFormatLenCheck(lines, lenResult);
        const len64 = this.nextTemp();
        lines.push(`  ${len64} = sext i32 ${lenResult} to i64`);
        const bufSize = this.nextTemp();
        lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
        const buf = this.emitStrAlloc(lines, bufSize, "fmt", expr.span);
        lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${bufSize}, ptr ${fmtStr.label}${argsStr})`);
        for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
        for (const t of fmtTemps) this.dropOwnedTemp(lines, t.val, t.ty, t.expr);
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
        return [lines, s2, "%String"];
      }

      // print(): NUL-safe. Milo strings are length-counted, so a string arg is written
      // by length via write(1, …) — printf's %.*s stops at an embedded NUL. Scalars and
      // structs still format through printf; a pending printf batch is emitted and the
      // stdio buffer drained (fflush) before each raw write so buffered printf output and
      // unbuffered write output keep textual order.
      this.needsPrintf = true;
      this.needsPutchar = true;
      this.needsWrite = true;
      this.needsFflush = true;
      let partFmts: string[] = [];
      let partArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = [];
      const flushBatch = () => {
        if (partFmts.length === 0) return;
        const fmtStr = this.addString(partFmts.join(""));
        const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
        lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtStr.label}${argsStr})`);
        partFmts = [];
        partArgs = [];
      };
      // An owned temporary printed directly (`print(n.toString())`) has no owner
      // once it has been written, so free it after the batch is flushed.
      const printTemps: { val: string; ty: string; expr: HIRExpr }[] = [];
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        printTemps.push({ val: av, ty: at, expr: arg.expr });
        let dt: any = arg.expr.type;
        while (dt && dt.tag === "ref") dt = dt.inner;
        if (dt && dt.tag === "string") {
          this.hasStringType = true;
          flushBatch();
          const dataPtr = this.nextTemp();
          lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
          const lenVal = this.nextTemp();
          lines.push(`  ${lenVal} = extractvalue %String ${av}, 1`);
          if (this.target.os === "none") {
            // Freestanding: no stdio, so no shared buffer to write into.
            lines.push(`  call i32 @fflush(ptr null)`);
            this.emitFdWrite(lines, 1, dataPtr, lenVal);
          } else {
            this.emitStdoutWrite(lines, dataPtr, lenVal);
          }
        } else {
          const bufMark = tempBufs.length;
          this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
          this.pendBufs(tempBufs, bufMark);
        }
      }
      flushBatch();
      lines.push(`  call i32 @putchar(i32 10)`);
      for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
      for (const t of printTemps) this.dropOwnedTemp(lines, t.val, t.ty, t.expr);
      return [lines, "void", "void"];
    }
    if (expr.func === "eprint") {
      this.needsDprintf = true;
      this.needsFree = true;
      let partFmts: string[] = [];
      let partArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = [];
      const eprintTemps: { val: string; ty: string; expr: HIRExpr }[] = [];
      const flushBatch = () => {
        if (partFmts.length === 0) return;
        const fmtStr = this.addString(partFmts.join(""));
        const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
        this.emitFdPrintf(lines, 2, fmtStr.label, argsStr);
        partFmts = [];
        partArgs = [];
      };
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        eprintTemps.push({ val: av, ty: at, expr: arg.expr });
        let dt: TypeKind = arg.expr.type;
        while (dt.tag === "ref") dt = dt.inner;
        // Freestanding has no stderr stream; its single printf sink keeps the
        // (clamped) `%.*s` path.
        if (dt.tag === "string" && this.target.os !== "none") {
          this.hasStringType = true;
          flushBatch();
          const dataPtr = this.nextTemp();
          lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
          const lenVal = this.nextTemp();
          lines.push(`  ${lenVal} = extractvalue %String ${av}, 1`);
          this.emitStderrWrite(lines, dataPtr, lenVal);
        } else {
          const bufMark = tempBufs.length;
          this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
          this.pendBufs(tempBufs, bufMark);
        }
      }
      partFmts.push("\n");
      flushBatch();
      for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
      for (const t of eprintTemps) this.dropOwnedTemp(lines, t.val, t.ty, t.expr);
      return [lines, "void", "void"];
    }
    if (expr.func === "flush") {
      this.needsFflush = true;
      lines.push(`  call i32 @fflush(ptr null)`);
      return [lines, "void", "void"];
    }
    if (expr.func === "exit") {
      this.needsExit = true;
      const [al, av] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      lines.push(`  call void @exit(i32 ${av})`);
      return [lines, "void", "void"];
    }
    if (expr.func === "todo") {
      // A body that is not written yet: say which function and where, then abort.
      this.needsDprintf = true;
      this.needsExit = true;
      const at = this.panicAt(expr.span);
      const who = this.currentFnName.slice(this.currentFnName.lastIndexOf("$") + 1);
      if (expr.args.length === 1) {
        const [ml, msgVal] = this.genExpr(expr.args[0].expr);
        lines.push(...ml);
        const msgPtr = this.nextTemp();
        lines.push(`  ${msgPtr} = extractvalue %String ${msgVal}, 0`);
        const fmtStr = this.addString(`todo: '${who}' is not implemented (${at}): %s\n`);
        this.emitFdPrintf(lines, 2, fmtStr.label, `, ptr ${msgPtr}`);
      } else {
        const fmtStr = this.addString(`todo: '${who}' is not implemented (${at})\n`);
        this.emitFdPrintf(lines, 2, fmtStr.label, "");
      }
      this.panicAbort(lines);
      lines.push(`  unreachable`);
      // The block after an abort still needs a label for whatever follows in the IR.
      lines.push(`${this.nextLabel("todo.after")}:`);
      return [lines, "void", "void"];
    }
    if (expr.func === "assert") {
      this.needsDprintf = true;
      this.needsExit = true;
      const [al, condVal] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const okLabel = this.nextLabel("assert.ok");
      const failLabel = this.nextLabel("assert.fail");
      lines.push(`  br i1 ${condVal}, label %${okLabel}, label %${failLabel}`);
      lines.push(`${failLabel}:`);
      const at = this.panicAt(expr.span);
      if (expr.args.length >= 2) {
        const [al2, msgVal] = this.genExpr(expr.args[1].expr);
        lines.push(...al2);
        const msgPtr = this.nextTemp();
        lines.push(`  ${msgPtr} = extractvalue %String ${msgVal}, 0`);
        const fmtStr = this.addString(`assertion failed at ${at}: %s\n`);
        this.emitFdPrintf(lines, 2, fmtStr.label, `, ptr ${msgPtr}`);
      } else {
        const fmtStr = this.addString(`assertion failed at ${at}\n`);
        this.emitFdPrintf(lines, 2, fmtStr.label, "");
      }
      this.panicAbort(lines);
      lines.push(`  unreachable`);
      lines.push(`${okLabel}:`);
      return [lines, "void", "void"];
    }
    if (expr.func === "max" || expr.func === "min") {
      const [al1, av1, at1] = this.genExpr(expr.args[0].expr);
      lines.push(...al1);
      const [al2, av2] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const cmp = this.nextTemp();
      const result = this.nextTemp();
      const isFloat = at1 === "double" || at1 === "float";
      const isUnsigned = expr.args[0].expr.type.tag === "int" && !expr.args[0].expr.type.signed;
      if (isFloat) {
        const pred = expr.func === "max" ? "ogt" : "olt";
        lines.push(`  ${cmp} = fcmp ${pred} ${at1} ${av1}, ${av2}`);
      } else {
        const pred = expr.func === "max" ? (isUnsigned ? "ugt" : "sgt") : (isUnsigned ? "ult" : "slt");
        lines.push(`  ${cmp} = icmp ${pred} ${at1} ${av1}, ${av2}`);
      }
      lines.push(`  ${result} = select i1 ${cmp}, ${at1} ${av1}, ${at1} ${av2}`);
      return [lines, result, at1];
    }
    if (expr.func === "_miloArgCount") {
      const raw = this.nextTemp();
      lines.push(`  ${raw} = load i32, ptr @_milo_argc_global`);
      const ext = this.nextTemp();
      lines.push(`  ${ext} = sext i32 ${raw} to i64`);
      return [lines, ext, "i64"];
    }
    if (expr.func === "_callClosureVoid") {
      // _callClosureVoid(fnPtr: *u8, envPtr: *u8) — indirect call to closure function
      const [al1, fnPtrVal] = this.genExpr(expr.args[0].expr);
      lines.push(...al1);
      const [al2, envPtrVal] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      lines.push(`  call void ${fnPtrVal}(ptr ${envPtrVal})`);
      return [lines, "0", "void"];
    }
    if (expr.func === "_schedulerGet") {
      this.usesSchedulerGlobal = true;
      const val = this.nextTemp();
      lines.push(`  ${val} = load ptr, ptr @_milo_scheduler`);
      return [lines, val, "ptr"];
    }
    if (expr.func === "_panicHookSet") {
      this.usesPanicHook = true;
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      lines.push(`  store ptr ${pv}, ptr @_milo_panic_hook`);
      return [lines, "0", "void"];
    }
    if (expr.func === "_schedulerSet") {
      this.usesSchedulerGlobal = true;
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      lines.push(`  store ptr ${pv}, ptr @_milo_scheduler`);
      return [lines, "0", "void"];
    }
    if (expr.func === "_putByte") {
      // Bare metal has no stdio; there putchar is whatever the freestanding runtime
      // provides, and the declare below covers both.
      this.needsPutchar = true;
      const [al, bv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const ext = this.nextTemp();
      lines.push(`  ${ext} = zext i8 ${bv} to i32`);
      lines.push(`  call i32 @putchar(i32 ${ext})`);
      return [lines, "void", "void"];
    }
    if (expr.func === "_loadU8") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const val = this.nextTemp();
      lines.push(`  ${val} = load i8, ptr ${pv}`);
      return [lines, val, "i8"];
    }
    if (expr.func === "_loadI32") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const val = this.nextTemp();
      lines.push(`  ${val} = load i32, ptr ${pv}`);
      return [lines, val, "i32"];
    }
    if (expr.func === "_bytesToString") {
      this.needsMalloc = true;
      this.needsMemcpy = true;
      this.hasStringType = true;
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [ll, lv] = this.genExpr(expr.args[1].expr);
      lines.push(...ll);
      // len+1 with a trailing NUL, matching _cstrToString's layout so the result
      // can still be handed to C without another copy.
      return [lines, this.emitStrFrom(lines, pv, lv), "%String"];
    }
    if (expr.func === "_cstrToString") {
      this.needsMalloc = true;
      this.needsMemcpy = true;
      this.needsStrlen = true;
      this.hasStringType = true;
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const len = this.nextTemp();
      lines.push(`  ${len} = call i64 @strlen(ptr ${pv})`);
      // Allocate len+1 and write trailing NUL so the Milo string can be passed to
      // C functions (open, printf, etc.) without re-copying. cap stays at len+1.
      return [lines, this.emitStrFrom(lines, pv, len), "%String"];
    }
    if (expr.func === "_strDataPtr") {
      // Extract the data pointer (field 0) from a &string. The argument reaches
      // codegen in one of two shapes and only one of them can be GEP'd: a local
      // or a field is an address, but a `&string` *parameter* is the %String
      // aggregate itself, passed by value. GEPing that emitted
      // `getelementptr %String, ptr %t` against an SSA value of type %String,
      // which LLVM rejects — so any function that took `s: &string` and called
      // this on it failed to compile.
      const [al, pv, ty] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const dataPtr = this.nextTemp();
      if (ty === "%String") {
        lines.push(`  ${dataPtr} = extractvalue %String ${pv}, 0`);
      } else {
        const dataGep = this.nextTemp();
        lines.push(`  ${dataGep} = getelementptr %String, ptr ${pv}, i32 0, i32 0`);
        lines.push(`  ${dataPtr} = load ptr, ptr ${dataGep}`);
      }
      return [lines, dataPtr, "ptr"];
    }
    // ── Atomic intrinsics ──
    const atomicSpec = Codegen.ATOMIC_INTRINSICS[expr.func];
    if (atomicSpec) return this.genAtomicIntrinsic(expr, atomicSpec, lines);
    if (expr.func === "_miloArgAt") {
      this.needsMalloc = true;
      this.needsMemcpy = true;
      this.needsStrlen = true;
      this.hasStringType = true;
      const [al, iv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const argv = this.nextTemp();
      lines.push(`  ${argv} = load ptr, ptr @_milo_argv_global`);
      const argPtr = this.nextTemp();
      lines.push(`  ${argPtr} = getelementptr ptr, ptr ${argv}, i64 ${iv}`);
      const cstr = this.nextTemp();
      lines.push(`  ${cstr} = load ptr, ptr ${argPtr}`);
      const len = this.nextTemp();
      lines.push(`  ${len} = call i64 @strlen(ptr ${cstr})`);
      // Allocate len+1 and NUL-terminate so the arg string can be passed to
      // C functions (open, etc.) directly without re-copying.
      return [lines, this.emitStrFrom(lines, cstr, len), "%String"];
    }
    return [lines, "void", "void"];
  }

  // One lowering for every `_atomic*` intrinsic; the width/op table is ATOMIC_INTRINSICS.
  private genAtomicIntrinsic(
    expr: HIRExpr & { kind: "Call" },
    spec: { kind: "load" | "store" | "rmw" | "cas"; rmwOp?: string; ty: string; align: number; isBool?: boolean },
    lines: string[],
  ): Gen {
    const { ty, align, isBool } = spec;
    const [pl, pv] = this.genExpr(expr.args[0].expr);
    lines.push(...pl);
    // an i1 argument has to be widened to the byte it actually occupies in memory
    const argAt = (i: number): string => {
      const [al, v] = this.genExpr(expr.args[i].expr);
      lines.push(...al);
      if (!isBool) return v;
      const ext = this.nextTemp();
      lines.push(`  ${ext} = zext i1 ${v} to i8`);
      return ext;
    };
    const narrow = (v: string): Gen => {
      if (!isBool) return [lines, v, ty];
      const b = this.nextTemp();
      lines.push(`  ${b} = trunc i8 ${v} to i1`);
      return [lines, b, "i1"];
    };
    switch (spec.kind) {
      case "load": {
        const raw = this.nextTemp();
        lines.push(`  ${raw} = load atomic ${ty}, ptr ${pv} seq_cst, align ${align}`);
        return narrow(raw);
      }
      case "store": {
        const v = argAt(1);
        lines.push(`  store atomic ${ty} ${v}, ptr ${pv} seq_cst, align ${align}`);
        return [lines, "void", "void"];
      }
      case "rmw": {
        const v = argAt(1);
        const old = this.nextTemp();
        lines.push(`  ${old} = atomicrmw ${spec.rmwOp} ptr ${pv}, ${ty} ${v} seq_cst, align ${align}`);
        return narrow(old);
      }
      case "cas": {
        const ev = argAt(1);
        const dv = argAt(2);
        const pair = this.nextTemp();
        lines.push(`  ${pair} = cmpxchg ptr ${pv}, ${ty} ${ev}, ${ty} ${dv} seq_cst seq_cst, align ${align}`);
        const old = this.nextTemp();
        lines.push(`  ${old} = extractvalue { ${ty}, i1 } ${pair}, 0`);
        return narrow(old);
      }
    }
  }

  // sretDest: only honored when `expr` itself is a direct call to an
  // sret-lowered fn (set by genStoreInto); the callee then writes straight
  // into that pointer and no aggregate SSA value is materialized.
  public genExpr(expr: HIRExpr, sretDest?: string): Gen {
    const pendMark = this.pend.temps.length;
    this.pend.parents.push(expr.kind);
    const r = this.genExprRaw(expr, sretDest);
    this.pend.parents.pop();
    this.pend.temps.length = pendMark;
    this.pendIfOperand(expr, r);
    if (this.own.on && this.isOwnedTempExpr(expr) && this.needsDropCg(expr.type)) {
      // The producers are exactly isOwnedTempExpr's list: the expressions whose value
      // nobody else owns. An sret result lives at its destination instead of a register.
      if (sretDest && r[1] === "undef") {
        this.own.slots.set(sretDest, this.own.make(r[0], expr.kind));
      } else {
        this.own.makeVal(r[0], r[1], expr.kind);
      }
    } else if (this.own.on && this.needsDropCg(expr.type) && r[1].startsWith("%")) {
      this.own.declareRead(r[0], r[1], expr);
    }
    if (this.own.on) this.own.producers.set(r[1], expr.kind);
    return r;
  }

  // A child's result stays pending while its parent evaluates the remaining operands.
  // A moved local is included: genIdent already zeroed its slot, so nothing else frees it.
  private pendIfOperand(expr: HIRExpr, r: Gen) {
    const parent = this.pend.parents[this.pend.parents.length - 1];
    if (!parent || !Codegen.PENDING_PARENTS.has(parent)) return;
    const [, val, llTy] = r;
    if (!val.startsWith("%") || !this.needsDropCg(expr.type)) return;
    if (!this.isOwnedTempExpr(expr) && !(expr.kind === "Ident" && expr.isMove)) return;
    this.pend.temps.push({ val, emit: l => this.dropValueNow(l, val, llTy, expr) });
  }

  // An element or field just stored into a literal under construction. Until the literal
  // is complete it is pending (an early exit drops it in place), so the ledger keeps its ID
  // on the slot rather than ending it as a STORE now. `val` is null when the value was
  // built in place (genStoreInto has already put its ID on the slot).
  // `readdr` recomputes the slot's address in the exit's own block, for an address that
  // must not be used outside the block that computed it (an enum payload's).
  private pendStored(lines: string[], val: string | null, ptr: string, tk: TypeKind, built: string[], readdr?: (lines: string[]) => string) {
    if (!this.needsDropCg(tk)) {
      // Nothing to drop on an exit; the ledger still ends whatever ID the value carried.
      if (val) this.own.endVal(lines, val, "STORE");
      else this.endStored(lines, [ptr], this.pend.temps.length);
      return;
    }
    if (val) this.own.valToSlot(val, ptr);
    built.push(ptr);
    this.pend.temps.push({ emit: l => {
      const at = readdr ? readdr(l) : ptr;
      if (at !== ptr && this.own.on && this.own.slots.has(ptr)) this.own.slots.set(at, this.own.slots.get(ptr)!);
      this.emitDropValue(l, at, tk);
    } });
  }

  // The literal is complete: its elements now belong to it.
  private endStored(lines: string[], built: string[], pendMark: number) {
    this.pend.temps.length = pendMark;
    if (!this.own.on) return;
    for (const p of built) {
      const id = this.own.slots.get(p);
      if (id) { this.own.end(lines, id, "STORE"); this.own.slots.delete(p); }
    }
  }

  // Scratch buffers print/format mallocs for a part, freed once the line is built.
  private pendBufs(bufs: string[], from: number) {
    for (const b of bufs.slice(from)) this.pend.temps.push({ emit: l => l.push(`  call void @free(ptr ${b})`) });
  }

  // A value handed to another owner mid-expression (an argument slot on argTempDrops)
  // is no longer this stack's to drop.
  private unpend(val: string) {
    const i = this.pend.temps.findLastIndex(t => t.val === val);
    if (i >= 0) this.pend.temps.splice(i, 1);
  }

  // Drop everything pending above the given stack heights: (0, 0) for an exit out of the
  // function, the loop body's marks for break/continue.
  private emitPendingDrops(lines: string[], tempsFrom: number, argTempsFrom: number, argTempsTo = this.argTempDrops.length) {
    for (let i = this.pend.temps.length - 1; i >= tempsFrom; i--) this.pend.temps[i].emit(lines);
    for (let i = argTempsTo - 1; i >= argTempsFrom; i--) {
      const t = this.argTempDrops[i];
      this.emitDropValue(lines, t.addr, t.type);
      if (t.ownVal) this.own.endVal(lines, t.ownVal, "DROP");
    }
  }

  private genExprRaw(expr: HIRExpr, sretDest?: string): Gen {
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    const lt = this.llvmType(expr.type);

    switch (expr.kind) {
      case "RangeCheck": {
        const [vl, val, vt] = this.genExpr(expr.value);
        lines.push(...vl);
        const signed = expr.type.tag === "int" && expr.type.signed;
        this.emitRangeCheck(lines, val, vt, signed, expr.min, expr.max, expr.span);
        return [lines, val, vt];
      }
      case "IntLit":
        return [lines, String(expr.value), lt];
      case "FloatLit":
        return [lines, this.formatFloatBits(expr.value, lt), lt];
      case "BoolLit":
        return [lines, expr.value ? "1" : "0", "i1"];
      case "StringLit": {
        this.hasStringType = true;
        const { label, length } = this.addString(expr.value);
        const strLen = length - 1; // exclude null terminator
        const ptr = b.gep(Ty.of(`[${length} x i8]`), val(label, Ty.ptr), [val("0", Ty.i32), val("0", Ty.i32)]);
        const s0 = b.insertvalue(val("undef", STRING_TY), ptr, 0);
        const s1 = b.insertvalue(s0, val(String(strLen), Ty.i64), 1);
        const s2 = b.insertvalue(s1, val("0", Ty.i64), 2);
        return [lines, s2.ref, "%String"];
      }
      case "StringWithCapacity":
        return genStringWithCapacity(this, expr, lines);
      case "Ident":
        return this.genIdent(expr, lines);
      case "CharLit": {
        return [lines, String(expr.value), "i8"];
      }
      case "BinOp":
        return this.genBinOp(expr, lines);
      case "UnaryOp":
        return this.genUnaryOp(expr, lines);
      case "Call":
        return this.genCall(expr, lines, sretDest);
      case "StructLit":
        return this.genStructLit(expr, lines);
      case "FieldAccess": {
        const recvTemps: { addr: string; type: TypeKind }[] = [];
        // Reading a field THROUGH an indexed temporary (`makeVec()[0].id`) reaches the
        // container via genIndexObjectPtr, which materialises it and registers the slot in
        // argTempDrops for its caller to release. That protocol is documented on
        // genIndexObjectPtr and every read path in genExpr honours it -- except this one,
        // which never took a mark, so the container was never freed and its elements never
        // ran a destructor. The mark has to be taken BEFORE the pointer is computed and
        // flushed after the load, or the element pointer outlives its buffer.
        const fieldTempMark = this.argTempDrops.length;
        const [ptrLines, ptr, fieldTy] = this.genFieldPtr(expr, recvTemps);
        lines.push(...ptrLines);
        const loaded = b.load(Ty.of(fieldTy), val(ptr, Ty.ptr), undefined, this.rangeMeta(expr.type, fieldTy));
        const owning = this.needsDropCg(expr.type);
        const recvStruct = this.getStructName(this.llvmType(expr.object.type)) ?? "";
        let result = loaded.ref;
        if (recvTemps.length > 0 && owning && (expr.isMove || this.fieldOfOwnedTemp(expr))) {
          // An owning field of a temporary receiver (`mk().name.len`, `f(mk().name)`,
          // `v.push(mk().name)`) leaves with the value: whoever consumes the FieldAccess
          // drops it (see fieldOfOwnedTemp), and the rest of the receiver dies here.
          if (this.dropImpls.has(recvStruct)) {
            // A user `impl Drop` must see every field intact when it runs, so the
            // consumer gets a clone and the receiver is destroyed whole.
            result = this.emitDeepCloneFromPtr(lines, ptr, expr.type);
            for (const t of recvTemps) this.emitDropValue(lines, t.addr, t.type);
          } else {
            // Drop the other fields one by one rather than zeroing this one and running
            // the struct's glue: the glue decides liveness by probing heap fields for
            // non-null, so with the moved field zeroed a `{ opt: Option, items: Vec }`
            // read as already moved-from and leaked `opt` with it.
            dropStructFieldsExcept(this, lines, recvTemps[0].addr, recvStruct, expr.field);
            this.own.end(lines, this.own.slots.get(recvTemps[0].addr), "MOVE");
          }
        } else {
          if (expr.isMove && owning) {
            // Moving a non-Copy field out of a named struct: zero the source field so the
            // struct's own drop glue skips it (a zeroed %String/Vec has cap=0/null). A
            // zeroed value with a user Drop is not empty, so its flag says it left.
            lines.push(this.zeroStore(fieldTy, ptr));
            this.clearFieldMoveFlag(lines, expr);
          }
          // Release a receiver nobody owns once a Copy field has been read out of it; an
          // owning field read in place would still point into it.
          if (recvTemps.length > 0 && !owning) {
            for (const t of recvTemps) this.emitDropValue(lines, t.addr, t.type);
          }
        }
        this.flushArgTempDrops(lines, fieldTempMark);
        return [lines, result, fieldTy];
      }
      case "ArrayLen":
        return this.genArrayLen(expr, lines);
      case "StringLen": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = b.extractvalue(val(ov, STRING_TY), 1, Ty.i64).ref;
        // `n.toString().len` reads a length out of a string nobody owns.
        this.dropOwnedTemp(lines, ov, "%String", expr.object);
        return [lines, len, "i64"];
      }
      case "StringCstr": {
        this.emitCStrUniquePlace(expr.object, lines);
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const dataPtr = b.extractvalue(val(ov, STRING_TY), 0, Ty.ptr).ref;
        return [lines, dataPtr, "ptr"];
      }
      case "HeapPtr": {
        // A `Heap<T>` IS the malloc'd pointer, so the give leg is a re-labelling: no
        // load, no extractvalue. What changes is the type — the result is a `*T` the
        // caller may hand to C, and (after `forget`) to C's `free`.
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        return [lines, ov, "ptr"];
      }
      case "VecPtr": {
        // v.ptr(): the Vec's backing data pointer (field 0 of {ptr,len,cap}).
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const dataPtr = b.extractvalue(val(ov, VEC_TY), 0, Ty.ptr).ref;
        return [lines, dataPtr, "ptr"];
      }
      case "ArrayLit":
        return this.genArrayLit(expr, lines);
      case "ArrayRepeat":
        return this.genArrayRepeat(expr, lines);
      case "IndexAccess":
        return this.genIndexAccess(expr, lines);
      case "EnumLit":
        return this.genEnumLit(expr, lines);
      case "SizeOf": {
        const size = this.typeSizeOf(expr.sizeType);
        return [lines, `${size}`, "i64"];
      }
      case "OffsetOf": {
        const structName = expr.sizeType.tag === "struct" ? expr.sizeType.name : null;
        if (!structName) return [lines, "0", "i64"];
        const layout = this.structLayouts.get(structName);
        if (!layout) return [lines, "0", "i64"];
        const idx = layout.fields.findIndex(f => f.name === expr.fieldName);
        if (idx < 0) return [lines, "0", "i64"];
        const offset = this.structFieldOffset(layout.fields.map(f => f.type), idx);
        return [lines, `${offset}`, "i64"];
      }
      case "Zeroed": {
        const ty = this.llvmType(expr.zeroType);
        return [lines, "zeroinitializer", ty];
      }
      case "Unwrap":
        return this.genUnwrap(expr, lines);
      case "Propagate":
        return this.genPropagate(expr, lines);
      case "DefaultValue":
        return this.genDefaultValue(expr, lines);
      case "MemReplace":
        return this.genMemReplace(expr, lines, sretDest);
      case "EnumTryFrom":
        return this.genEnumTryFrom(expr, lines);
      case "MemSwap":
        return this.genMemSwap(expr, lines);
      case "Forget":
        return this.genForget(expr, lines);
      case "Cast":
        return this.genCast(expr, lines);
      case "IsCheck": {
        const [ol, ov, ot] = this.genExpr(expr.operand);
        lines.push(...ol);
        const tagVal = this.enumValueTag(lines, ot, ov);
        const cmp = b.icmp("eq", val(tagVal, Ty.i32), val(String(expr.tag), Ty.i32)).ref;
        // A tag test keeps nothing of its operand, so a temporary one dies here:
        // `if mk() is Option.Some(_)` and `mk() == Option.None` leaked the payload.
        this.dropOwnedTemp(lines, ov, ot, expr.operand);
        return [lines, cmp, "i1"];
      }
      case "HeapCreate": {
        this.needsMalloc = true;
        const [valLines, valVal, valTy] = this.genExpr(expr.value);
        lines.push(...valLines);
        const size = this.typeSizeOf(expr.value.type);
        const ptr = b.call(Ty.ptr, "@malloc", [val(String(size), Ty.i64)]);
        b.store(val(valVal, Ty.of(valTy)), ptr);
        this.own.endVal(lines, valVal, "STORE");
        return [lines, ptr.ref, "ptr"];
      }
      case "HeapDeref":
      case "PtrDeref": {
        if (expr.kind === "HeapDeref" && (expr.isMove || this.isTempBoxDeref(expr))) {
          const emptied = this.genHeapMoveOut(expr, lines);
          if (emptied) return emptied;
        }
        const [ptrLines, ptrVal] = this.genExpr(expr.operand);
        lines.push(...ptrLines);
        const innerTy = this.llvmType(expr.type);
        const loaded = b.load(Ty.of(innerTy), val(ptrVal, Ty.ptr)).ref;
        // A moving deref zeroes the heap slot after loading to prevent a double free: the
        // loaded value now owns any inner heap pointers. A read leaves the box intact.
        if (expr.kind === "HeapDeref" && expr.isMove && this.needsDropCg(expr.type)) {
          lines.push(this.zeroStore(innerTy, ptrVal));
        }
        return [lines, loaded, innerTy];
      }
      case "VecNew": {
        this.hasVecType = true;
        const s0 = b.insertvalue(val("undef", VEC_TY), val("null", Ty.ptr), 0);
        const s1 = b.insertvalue(s0, val("0", Ty.i64), 1);
        const s2 = b.insertvalue(s1, val("0", Ty.i64), 2);
        return [lines, s2.ref, "%Vec"];
      }
      case "VecWithCapacity":
        return this.genVecWithCapacity(expr, lines);
      case "VecFilled":
        return this.genVecFilled(expr, lines);
      case "VecPush":
        return this.genVecPush(expr, lines);
      case "VecPop":
        return genVecPop(this, expr, lines);
      case "VecLen": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = b.extractvalue(val(ov, VEC_TY), 1, Ty.i64).ref;
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%Vec", expr.object);
        return [lines, len, "i64"];
      }
      case "VecClone": {
        this.hasVecType = true;
        const passed = this.cloneOfOwnedTemp(expr.object, lines);
        if (passed) return passed;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        // emitDeepCloneFromPtr reads through a pointer, so spill the loaded %Vec
        // into a scratch slot first. The spill is a shallow copy that is never
        // dropped — only the clone it produces is owned by the caller.
        const slot = b.alloca(VEC_TY);
        b.store(val(ov, VEC_TY), slot);
        const cloned = this.emitDeepCloneFromPtr(lines, slot.ref, { tag: "vec", element: expr.elementType });
        return [lines, cloned, "%Vec"];
      }
      case "VecMap":
        return genVecMap(this, expr, lines);
      case "VecFilter":
        return genVecFilter(this, expr, lines);
      case "VecEach":
        return genVecEach(this, expr, lines);
      case "VecFind":
        return genVecFind(this, expr, lines);
      case "VecAny":
        return genVecAny(this, expr, lines);
      case "VecSum":
        return this.genVecSum(expr, lines);
      case "VecAll":
        return genVecAll(this, expr, lines);
      case "VecFold":
        return genVecFold(this, expr, lines);
      case "VecIsEmpty": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = b.extractvalue(val(ov, VEC_TY), 1, Ty.i64).ref;
        const result = b.icmp("eq", val(len, Ty.i64), val("0", Ty.i64)).ref;
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%Vec", expr.object);
        return [lines, result, "i1"];
      }
      case "VecReverse":
        return genVecReverse(this, expr, lines);
      case "VecSwap":
        return this.genVecSwap(expr, lines);
      case "VecInsert":
        return this.genVecInsert(expr, lines);
      case "VecRemove":
        return this.genVecRemove(expr, lines);
      case "VecTruncate":
        return this.genVecTruncate(expr, lines);
      case "VecContains":
        return this.genVecContains(expr, lines);
      case "VecEnumerate":
        return this.genVecEnumerate(expr, lines);
      case "VecGetOpt":
        return genVecGetOpt(this, expr, lines);
      case "VecMinMax":
        return genVecMinMax(this, expr, lines);
      case "VecIndexOf":
        return genVecIndexOf(this, expr, lines);
      case "VecPosition":
        return genVecPosition(this, expr, lines);
      case "VecExtend":
        return this.genVecExtend(expr, lines);
      case "VecRetain":
        return this.genVecRetain(expr, lines);
      case "VecReserve":
        return this.genVecReserve(expr, lines);
      case "VecCapacity": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const cap = b.extractvalue(val(ov, VEC_TY), 2, Ty.i64).ref;
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%Vec", expr.object);
        return [lines, cap, "i64"];
      }
      case "VecSort":
        return genVecSort(this, expr.object, expr.elementType, lines);
      case "VecSortBy":
        return genVecSortBy(this, expr.object, expr.callback, expr.elementType, lines);
      case "VecSortByKey":
        this.own.keyExtractor = this.own.on;
        try { return genVecSortByKey(this, expr.object, expr.callback, expr.elementType, expr.keyType, lines); } finally { this.own.keyExtractor = false; }
      case "HashMapNew":
        return genHashMapNew(this, expr, lines);
      case "HashMapInsert":
        return genHashMapInsert(this, expr, lines);
      case "HashMapGet":
        return genHashMapGet(this, expr, lines);
      case "HashMapGetOrDefault":
        return genHashMapGetOrDefault(this, expr, lines);
      case "HashMapContains":
        return genHashMapContains(this, expr, lines);
      case "HashMapModify":
        return genHashMapModify(this, expr, lines);
      case "HashMapGetOrInsertWith":
        return genHashMapGetOrInsertWith(this, expr, lines);
      case "HashMapRemove":
        return genHashMapRemove(this, expr, lines);
      case "HashMapWithCapacity":
        return genHashMapWithCapacity(this, expr, lines);
      case "HashMapClone":
        return genHashMapClone(this, expr, lines);
      case "HashMapClear":
        return genHashMapClear(this, expr, lines);
      case "HashMapEntries":
        return genHashMapEntries(this, expr, lines);
      case "HashMapLen": {
        this.hasHashMapType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = b.extractvalue(val(ov, Ty.of("%HashMap")), 1, Ty.i64).ref;
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%HashMap", expr.object);
        return [lines, len, "i64"];
      }
      case "StringPush":
        return genStringPush(this, expr, lines);
      case "StringPushStr":
        return genStringPushStr(this, expr, lines);
      case "StringPushInt":
        return genStringPushInt(this, expr, lines);
      case "StringTruncate":
        return genStringTruncate(this, expr, lines);
      case "StringSetByte":
        return genStringSetByte(this, expr, lines);
      case "StringSubstr":
        return genStringSubstr(this, expr, lines);
      case "StringSlice":
        return genStringSlice(this, expr, lines);
      case "VecSlice":
        return this.genVecSlice(expr, lines);
      case "RawSlice":
        return this.genRawSlice(expr, lines);
      case "Adopt":
        return this.genAdopt(expr, lines);
      case "StringFind":
        return genStringFind(this, expr, lines);
      case "StringClone":
        return genStringClone(this, expr, lines);
      case "NumberToString":
        return genNumberToString(this, expr, lines);
      case "BoolToString":
        return genBoolToString(this, expr, lines);
      case "WrappingArith":
        return this.genWrappingArith(expr, lines);
      case "SaturatingArith":
        return this.genSaturatingArith(expr, lines);
      case "CheckedArith":
        return this.genCheckedArith(expr, lines);
      case "BitIntrinsic":
        return this.genBitIntrinsic(expr, lines);
      case "OptionOp":
        return this.genOptionOp(expr, lines);
      case "JsonStringify":
        return this.genJsonStringify(expr, lines);
      case "Closure":
        return this.genClosure(expr, lines);
      case "CFnCall":
        return this.genCFnCall(expr, lines);
      case "ClosureCall":
        return this.genClosureCall(expr, lines);
      case "InterfaceCoerce":
        return this.genInterfaceCoerce(expr, lines);
      case "IfExpr":
        return this.genIfExpr(expr, lines);
      case "MatchExpr":
        return genMatchExpr(this, expr, lines);
      case "InterfaceMethodCall":
        return this.genInterfaceMethodCall(expr, lines);
    }
    // Every arm above returns, so this is unreachable — and that is the point: it is
    // what makes a newly-added HIR kind a compile error here rather than a value that
    // quietly never gets generated.
    const _exhaustive: never = expr;
    throw new Error(`genExpr: unhandled HIR kind '${(_exhaustive as { kind: string }).kind}'`);
  }

  private genIdent(expr: HIRExpr & { kind: "Ident" }, lines: string[]): Gen {
    const local = this.locals.get(expr.name);
    if (!local) {
      // named function used as value — generate trampoline with closure calling convention
      if (this.fnSigs.has(expr.name)) {
        const sig = must(this.fnSigs, expr.name, "fn sigs");
        const trampolineName = `__trampoline_${expr.name}`;
        if (!this.fnSigs.has(trampolineName)) {
          const paramNames = sig.paramTypes.map((_, i) => `p${i}`);
          const trampolineParams: Param[] = [{ name: "env", ty: Ty.ptr }, ...sig.paramTypes.map((t, i) => ({ name: paramNames[i], ty: Ty.of(t) }))];
          const fwdArgs = sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`).join(", ");
          const body: string[] = [];
          const bTramp = new LlvmTextBuilder(body, this);
          bTramp.defineFn({ name: trampolineName, ret: Ty.of(sig.retType), params: trampolineParams });
          if (this.sretFns.has(expr.name)) {
            // callee is sret-lowered; trampoline keeps the closure convention
            // (returns the aggregate) and bridges via a local slot
            body.push(`  %slot = alloca ${sig.retType}`);
            body.push(`  call void @${expr.name}(${fwdArgs ? `ptr %slot, ${fwdArgs}` : "ptr %slot"})`);
            body.push(`  %r = load ${sig.retType}, ptr %slot`);
            body.push(`  ret ${sig.retType} %r`);
          } else if (sig.retType === "void") {
            body.push(`  call void @${expr.name}(${fwdArgs})`);
            body.push("  ret void");
          } else {
            body.push(`  %r = call ${sig.retType} @${expr.name}(${fwdArgs})`);
            body.push(`  ret ${sig.retType} %r`);
          }
          bTramp.endFn();
          this.closureBodies.push(body);
          this.fnSigs.set(trampolineName, sig);
        }
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca { ptr, ptr }`);
        const fpSlot = this.nextTemp();
        lines.push(`  ${fpSlot} = getelementptr { ptr, ptr }, ptr ${alloca}, i32 0, i32 0`);
        lines.push(`  store ptr @${trampolineName}, ptr ${fpSlot}`);
        const envSlot = this.nextTemp();
        lines.push(`  ${envSlot} = getelementptr { ptr, ptr }, ptr ${alloca}, i32 0, i32 1`);
        lines.push(`  store ptr null, ptr ${envSlot}`);
        const val = this.nextTemp();
        lines.push(`  ${val} = load { ptr, ptr }, ptr ${alloca}`);
        return [lines, val, "{ ptr, ptr }"];
      }
      const globalInfo = this.globalVars.get(expr.name);
      if (globalInfo) {
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${globalInfo.type}, ptr @${expr.name}`);
        // Moving a global out by value (checker cleared its moved flag, so a
        // later reassignment will drop the slot) must zero the source, exactly
        // like the local-move path below — otherwise the reassign's drop frees
        // the buffer the callee already owns/freed. Double-free that compiled
        // clean before this. No alive-flag: globals aren't in droppableLocals.
        if (expr.isMove && this.needsDropCg(globalInfo.typeKind)) {
          lines.push(this.zeroStore(globalInfo.type, `@${expr.name}`));
        }
        return [lines, val, globalInfo.type];
      }
      console.error(`error[codegen]: undefined variable '${expr.name}'`); process.exit(1);
    }
    if (local.isRef) {
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = load ptr, ptr ${this.localAddr(expr.name)}`);
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${local.type}, ptr ${ptr}`);
      return [lines, val, local.type];
    }
    const addr = this.localAddr(expr.name);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = load ${local.type}, ptr ${addr}`);
    if (expr.isMove && this.needsDropCg(local.typeKind)) {
      lines.push(this.zeroStore(local.type, addr));
      const dl = this.droppableLocals.find(d => d.addr === addr);
      if (dl) this.own.clearAlive(lines, dl.aliveFlag, "MOVE");
      // Moving a capture out of a `move` closure: the environment still owns the other
      // captures, so clear this one's flag rather than the whole env's.
      const capFlag = this.captureFlagByAddr.get(addr);
      if (capFlag) lines.push(`  store i1 0, ptr ${capFlag}`);
    }
    return [lines, tmp, local.type];
  }

  private genBinOp(expr: HIRExpr & { kind: "BinOp" }, lines: string[]): Gen {
    if (expr.op === "&&" || expr.op === "||") {
      return this.genShortCircuit(expr, lines);
    }
    const [ll, lv, llt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);

    if (llt === "%String") {
      // These all read out of their operands into a fresh result, so an
      // operand that was a call temporary (`mk(a) + mk(b)`) has no owner
      // afterwards and would otherwise never be freed.
      const dropOperands = (out: string[]) => {
        this.dropOwnedTemp(out, lv, llt, expr.left);
        this.dropOwnedTemp(out, rv, llt, expr.right);
      };
      if (expr.op === "+") {
        const [cl, cv, ct] = genStringConcat(this, lines, lv, rv);
        dropOperands(cl);
        return [cl, cv, ct];
      }
      if (expr.op === "==" || expr.op === "!=") {
        const [cl, cv, ct] = genStringCmp(this, lines, lv, rv, expr.op === "==");
        dropOperands(cl);
        return [cl, cv, ct];
      }
      if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
        const [cl, cv, ct] = genStringOrd(this, lines, lv, rv, expr.op);
        dropOperands(cl);
        return [cl, cv, ct];
      }
    }

    // enum equality: compare tag field only (checker rejects payload-bearing enums)
    if ((expr.op === "==" || expr.op === "!=") && llt.startsWith("%") && this.enumLayouts.has(llt.slice(1))) {
      const lTag = this.enumValueTag(lines, llt, lv);
      const rTag = this.enumValueTag(lines, llt, rv);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ${expr.op === "==" ? "eq" : "ne"} i32 ${lTag}, ${rTag}`);
      return [lines, cmp, "i1"];
    }

    const tmp = this.nextTemp();
    const isFloat = llt === "float" || llt === "double";
    const unsigned = !isFloat && this.isUnsigned(expr.left.type);
    const intOps: Record<string, string> = unsigned
      ? { "+": "add", "-": "sub", "*": "mul", "/": "udiv", "%": "urem", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "lshr" }
      : { "+": "add", "-": "sub", "*": "mul", "/": "sdiv", "%": "srem", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "ashr" };
    const floatOps: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "%": "frem" };
    const intCmps: Record<string, string> = unsigned
      ? { "==": "eq", "!=": "ne", "<": "ult", ">": "ugt", "<=": "ule", ">=": "uge" }
      : { "==": "eq", "!=": "ne", "<": "slt", ">": "sgt", "<=": "sle", ">=": "sge" };
    // "!=" must be `une` (unordered-or-not-equal), not `one`: for NaN operands
    // `one` is false, which would make both `x == x` and `x != x` false.
    const floatCmps: Record<string, string> = { "==": "oeq", "!=": "une", "<": "olt", ">": "ogt", "<=": "ole", ">=": "oge" };
    if (expr.op in intOps) {
      const op = isFloat ? floatOps[expr.op] : intOps[expr.op];
      const checkedOps: Record<string, string> = { "+": "add", "-": "sub", "*": "mul" };
      // A @wrapping fn skips the overflow trap and takes the plain (defined, two's-
      // complement) op below. Everything else — div-by-zero, bounds — still traps.
      if (this.trapOnOverflow && !this.currentFnWrapping && !isFloat && expr.op in checkedOps && expr.span) {
        const val = this.emitCheckedArith(lines, checkedOps[expr.op], unsigned, llt, lv, rv, expr.span);
        return [lines, val, llt];
      }
      // Integer division/remainder by zero (and signed INT_MIN / -1) is UB — trap it in
      // every mode. Under @wrapping the INT_MIN/-1 overflow wraps (→ INT_MIN, rem 0), but
      // division by zero still traps: there is no modular value for x/0.
      if (!isFloat && (expr.op === "/" || expr.op === "%")) {
        const signed = !unsigned;
        const bits = expr.left.type.tag === "int" ? expr.left.type.bits : 32;
        if (this.currentFnWrapping && signed) {
          const val = this.emitWrappingSignedDivRem(lines, expr.op, lv, rv, llt, bits, expr.span);
          return [lines, val, llt];
        }
        this.emitDivByZeroCheck(lines, rv, lv, llt, signed, bits, expr.span);
      }
      // A shift by >= the operand's bit width (or a negative amount, huge as unsigned) is
      // LLVM poison. Default: trap. @wrapping: mask the amount to [0,width) — defined,
      // matches Rust `wrapping_shl` / C.
      if (!isFloat && (expr.op === "<<" || expr.op === ">>")) {
        const bits = expr.left.type.tag === "int" ? expr.left.type.bits : 32;
        if (this.currentFnWrapping) {
          const masked = this.nextTemp();
          lines.push(`  ${masked} = and ${llt} ${rv}, ${bits - 1}`);
          lines.push(`  ${tmp} = ${op} ${llt} ${lv}, ${masked}`);
          return [lines, tmp, llt];
        }
        this.emitShiftCheck(lines, rv, llt, bits, expr.span);
      }
      lines.push(`  ${tmp} = ${op} ${llt} ${lv}, ${rv}`);
      return [lines, tmp, llt];
    }
    if (expr.op in intCmps) {
      if (isFloat) lines.push(`  ${tmp} = fcmp ${floatCmps[expr.op]} ${llt} ${lv}, ${rv}`);
      else lines.push(`  ${tmp} = icmp ${intCmps[expr.op]} ${llt} ${lv}, ${rv}`);
      return [lines, tmp, "i1"];
    }
    console.error(`error[codegen]: unknown binary op '${expr.op}'`); process.exit(1);
  }

  private genUnaryOp(expr: HIRExpr & { kind: "UnaryOp" }, lines: string[]): Gen {
    if (expr.op === "&") {
      const [al, addr] = this.genLValue(expr.operand);
      lines.push(...al);
      return [lines, addr, "ptr"];
    }
    // Negating an integer literal is a compile-time constant — fold it. Without this,
    // a legitimate negative literal like i32 INT_MIN (-2147483648, lexed as the unary
    // minus of 2147483648) would emit a runtime checked-neg and trap on the INT_MIN
    // overflow now that overflow checks are on in every build.
    if (expr.op === "-" && expr.operand.kind === "IntLit"
        && expr.operand.type.tag === "int" && expr.operand.type.signed) {
      return [lines, (-(expr.operand.value as bigint)).toString(), this.llvmType(expr.operand.type)];
    }
    const [ol, ov, ot] = this.genExpr(expr.operand);
    lines.push(...ol);
    const tmp = this.nextTemp();
    if (expr.op === "-") {
      if (ot === "float" || ot === "double") lines.push(`  ${tmp} = fneg ${ot} ${ov}`);
      else if (this.trapOnOverflow && !this.currentFnWrapping && expr.span) {
        const unsigned = this.isUnsigned(expr.operand.type);
        const val = this.emitCheckedArith(lines, "sub", unsigned, ot, "0", ov, expr.span);
        return [lines, val, ot];
      } else lines.push(`  ${tmp} = sub ${ot} 0, ${ov}`);
      return [lines, tmp, ot];
    }
    if (expr.op === "!") { lines.push(`  ${tmp} = xor i1 ${ov}, 1`); return [lines, tmp, "i1"]; }
    if (expr.op === "~") { lines.push(`  ${tmp} = xor ${ot} ${ov}, -1`); return [lines, tmp, ot]; }
    console.error(`error[codegen]: unknown unary op '${expr.op}'`); process.exit(1);
  }

  private genCall(expr: HIRExpr & { kind: "Call" }, lines: string[], sretDest?: string): Gen {
    if (Codegen.BUILTINS.has(expr.func) && !this.userDeclaredFns.has(expr.func)) {
      return this.genBuiltinCall(expr, lines);
    }
    const sig = this.fnSigs.get(expr.func);
    const tempMark = this.argTempDrops.length;
    const argVals: { val: string; type: string }[] = [];
    const refPtrs: { ptr: string; mut: boolean }[] = [];
    // An argument passes to the callee at the call, not when it is evaluated: a later
    // argument's `?` still owes its drop (see pend), so the ledger ends them together.
    const argEnds: string[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (arg.passByRef) {
        const [al, aPtr] = this.genLValueForArg(arg.expr);
        lines.push(...al);
        argVals.push({ val: aPtr, type: "ptr" });
        refPtrs.push({ ptr: aPtr, mut: arg.refMut });
      } else {
        // [T; N] → *T decay: pass the array's address as a ptr
        const argTk = arg.expr.type;
        const paramExpectsPtr = sig && i < sig.paramTypes.length && sig.paramTypes[i] === "ptr";
        if (argTk.tag === "array" && paramExpectsPtr) {
          const [al, aPtr] = this.genLValueForArg(arg.expr);
          lines.push(...al);
          argVals.push({ val: aPtr, type: "ptr" });
          continue;
        }
        // fn → ptr coercion: bare function name passed to extern fn ptr param
        if (argTk.tag === "fn" && paramExpectsPtr && arg.expr.kind === "Ident" && this.fnSigs.has(arg.expr.name)) {
          argVals.push({ val: `@${arg.expr.name}`, type: "ptr" });
          continue;
        }
        const toCStr = argTk.tag === "string" && !!sig && !sig.wantsStringAddr?.[i]
          && (i >= sig.paramTypes.length || sig.paramTypes[i] === "ptr") && arg.expr.kind !== "StringLit";
        if (toCStr) this.emitCStrUniquePlace(arg.expr, lines);
        let [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        // String → char* coercion, for extern/FFI calls ONLY (including variadic args).
        // The `paramTypes[i] === "ptr"` test alone is not enough to identify one: a
        // Milo `&string` param lowers to `ptr` too, and it wants the address of the
        // %String struct, not the bytes. Coercing there handed strTrim(&string) the
        // character buffer, which it then read a length/capacity out of — silently
        // returning "" instead of the trimmed text, with no crash and no diagnostic.
        // Only a slice or other non-lvalue reached this path; an lvalue arg is
        // auto-borrowed upstream and goes through genLValueForArg.
        // A `&string` param wants the address of the %String struct. Only a
        // non-lvalue reaches here (a slice, a temporary) — an lvalue is auto-borrowed
        // upstream and goes via genLValueForArg — so materialise it and pass that.
        const wantsAddr = at === "%String" && !!sig?.wantsStringAddr?.[i];
        if (at === "%String" && sig && !wantsAddr && (i >= sig.paramTypes.length || sig.paramTypes[i] === "ptr")) {
          // A literal is NUL-terminated in place, and so is every owned string. A view
          // (`splitView`, `lines()`, `slice`) is not: its bytes run on into the parent, so
          // C read "a.txt,zz" for the piece "a.txt". A literal is not a view.
          // An owned temporary (`strlen(mk())`) is passed as its own bytes, and C only
          // borrows them for the call, so it is dropped after the call like any argument
          // temporary. A retaining callee keeps the pointer, so the string is leaked to it.
          // The temporary may share its buffer (f(s.clone())), so it is made unique in
          // its slot before C sees the bytes, as a place is (emitCStrUniquePlace).
          const ownedTemp = arg.expr.kind !== "StringLit" && this.isOwnedTempExpr(arg.expr);
          if (ownedTemp && !Codegen.RETAINING_LIBC.has(expr.func)) {
            const slot = `%__cstrtmp.${this.scopeCounter++}.addr`;
            this.entryAllocas.push(`  ${slot} = alloca %String`);
            lines.push(`  store %String ${av}, ptr ${slot}`);
            this.own.valToSlot(av, slot);
            this.argTempDrops.push({ addr: slot, type: { tag: "string" } });
            this.unpend(av);
            this.emitStrUnique(lines, slot);
            av = new LlvmTextBuilder(lines, this).load(Ty.of("%String"), val(slot, Ty.ptr)).ref;
          }
          const dataPtr = arg.expr.kind === "StringLit"
            ? (() => { const t = this.nextTemp(); lines.push(`  ${t} = extractvalue %String ${av}, 0`); return t; })()
            : this.emitCStringArg(lines, av, Codegen.RETAINING_LIBC.has(expr.func));
          argVals.push({ val: dataPtr, type: "ptr" });
          if (ownedTemp && Codegen.RETAINING_LIBC.has(expr.func)) argEnds.push(av);
        } else if (wantsAddr) {
          const slot = this.nextTemp();
          lines.push(`  ${slot} = alloca %String`);
          lines.push(`  store %String ${av}, ptr ${slot}`);
          argVals.push({ val: slot, type: "ptr" });
        // fn closure → ptr coercion: extract fn ptr from closure tuple for extern calls
        } else if (at === "{ ptr, ptr }" && paramExpectsPtr) {
          const fnPtr = this.nextTemp();
          lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${av}, 0`);
          argVals.push({ val: fnPtr, type: "ptr" });
        } else {
          argVals.push({ val: av, type: at });
          if (!this.isLentClosure(arg.expr)) argEnds.push(av);
          // The caller owns a `move` closure's heap environment right up to the call and
          // then stops dropping it (an owning fn type is not Copy, so passing it is a
          // move), while the callee's parameter is declared non-owning and never picks the
          // job up — so free it here, once the call cannot still be using it. Skipped when
          // the closure outlives the call; see closureParamEscapes.
          if (this.ownsClosureEnv(arg.expr) && at === "{ ptr, ptr }"
              && !this.closureParamEscapes(expr.func, i)) {
            const slot = `%__clarg.${this.scopeCounter++}.addr`;
            this.entryAllocas.push(`  ${slot} = alloca { ptr, ptr }`);
            lines.push(`  store { ptr, ptr } ${av}, ptr ${slot}`);
            this.argTempDrops.push({ addr: slot, type: { ...argTk, owning: true } as TypeKind, ownVal: av });
            this.unpend(av);
          }
        }
      }
    }
    for (const v of argEnds) this.own.endVal(lines, v, "ARG");
    this.emitAliasGuards(lines, refPtrs, expr.span);
    // extern fns passing/returning a struct by value need native-ABI lowering:
    // coerce args into registers, byval/indirect big ones, sret the return.
    if (this.externAbi.has(expr.func)) {
      const r = this.emitExternAbiCall(expr, argVals, lines);
      this.flushArgTempDrops(r[0], tempMark);
      return r;
    }
    const argsStr = argVals.map((a, i) => `${a.type}${a.type === "ptr" ? sig?.refAttrs?.[i] ?? "" : ""} ${a.val}`).join(", ");
    const retTy = sig?.retType ?? "i32";
    if (this.sretFns.has(expr.func)) {
      const dest = sretDest ?? this.nextTemp();
      if (!sretDest) lines.push(`  ${dest} = alloca ${retTy}`);
      lines.push(`  call void @${expr.func}(${argsStr ? `ptr ${dest}, ${argsStr}` : `ptr ${dest}`})`);
      this.flushArgTempDrops(lines, tempMark);
      if (sretDest) return [lines, "undef", retTy];
      // no direct destination: fall back to a first-class value for generic
      // consumers (rare — slower to compile at -O2, but correct)
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = load ${retTy}, ptr ${dest}`);
      return [lines, tmp, retTy];
    }
    let callPrefix = retTy;
    if (expr.variadic) {
      const paramStr = sig!.paramTypes.join(", ");
      callPrefix = `${retTy} (${paramStr}, ...)`;
    }
    if (retTy === "void") {
      lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
      this.flushArgTempDrops(lines, tempMark);
      return [lines, "void", "void"];
    }
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = call ${callPrefix} @${expr.func}(${argsStr})`);
    this.flushArgTempDrops(lines, tempMark);
    return [lines, tmp, retTy];
  }

  private genStructLit(expr: HIRExpr & { kind: "StructLit" }, lines: string[]): Gen {
    const layout = must(this.structLayouts, expr.name, "struct layouts");
    const structTy = `%${expr.name}`;
    const alloca = this.nextTemp();
    lines.push(`  ${alloca} = alloca ${structTy}`);
    const pendMark = this.pend.temps.length, built: string[] = [];
    for (const f of expr.fields) {
      const idx = layout.fields.findIndex(lf => lf.name === f.name);
      const fieldTy = layout.fields[idx].type;
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${structTy}, ptr ${alloca}, i32 0, i32 ${idx}`);
      this.genStoreInto(lines, ptr, fieldTy, f.value, "slot");
      this.pendStored(lines, null, ptr, layout.fields[idx].typeKind, built);
    }
    this.genStructUpdateBase(lines, alloca, expr);
    this.endStored(lines, built, pendMark);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${structTy}, ptr ${alloca}`);
    return [lines, val, structTy];
  }

  // Struct update `S { a: 1, ..base }`: fill the unlisted fields of the literal at
  // `destPtr` from the base, after the listed fields were stored (source order). The base
  // is evaluated once into a scratch slot; genStoreInto does the move bookkeeping (a moved
  // local is zeroed and its alive flag cleared). Its unlisted fields are copied across and
  // its listed ones dropped here, so each field the base owned ends with exactly one owner.
  private genStructUpdateBase(lines: string[], destPtr: string, expr: HIRExpr & { kind: "StructLit" }): void {
    const base = expr.base;
    if (!base) return;
    const layout = must(this.structLayouts, expr.name, "struct layouts");
    const structTy = `%${expr.name}`;
    const tmp = `%__supd.${this.scopeCounter++}`;
    this.entryAllocas.push(`  ${tmp} = alloca ${structTy}`);
    if (base.type.tag === "ref") {
      // Only a Copy struct reaches here behind a `&` (the checker refuses to move a
      // non-Copy one out of a borrow), so a byte copy of the pointee is the whole story.
      const [bl, bv] = this.genExpr(base);
      lines.push(...bl);
      this.emitMemcpy(lines, tmp, bv, structTy, { intent: "plain", type: base.type.tag === "ref" ? base.type.inner : base.type });
    } else {
      this.genStoreInto(lines, tmp, structTy, base);
    }
    // Ledger: the scratch copy of the base owns a value (a temporary's ID, or a fresh one
    // for a moved local), which this splits into one ID per owning field. Each field then
    // has to end exactly once: dropped when listed, stored into the literal when not.
    const splitBase = this.own.on && base.type.tag !== "ref" && this.needsDropCg(base.type);
    if (splitBase) this.own.end(lines, this.own.slots.get(tmp) ?? this.own.make(lines, "update-base"), "MOVE");
    layout.fields.forEach((lf, idx) => {
      const src = this.nextTemp();
      lines.push(`  ${src} = getelementptr ${structTy}, ptr ${tmp}, i32 0, i32 ${idx}`);
      const fieldId = splitBase && this.needsDropCg(lf.typeKind) ? this.own.make(lines, `update-base-field:${lf.name}`) : 0;
      if (fieldId) this.own.slots.set(src, fieldId);
      if (expr.fields.some(f => f.name === lf.name)) {
        if (this.needsDropCg(lf.typeKind)) this.emitDropValue(lines, src, lf.typeKind);
        return;
      }
      const dst = this.nextTemp();
      lines.push(`  ${dst} = getelementptr ${structTy}, ptr ${destPtr}, i32 0, i32 ${idx}`);
      if (this.isBigAgg(lf.type)) {
        this.emitMemcpy(lines, dst, src, lf.type, { intent: "move", type: lf.typeKind });
      } else {
        const v = this.nextTemp();
        lines.push(`  ${v} = load ${lf.type}, ptr ${src}`);
        lines.push(this.valStore(lf.type, v, dst, { intent: "move", type: lf.typeKind }));
      }
      this.own.end(lines, fieldId, "STORE");
    });
  }

  private genArrayLen(expr: HIRExpr & { kind: "ArrayLen" }, lines: string[]): Gen {
    const objType = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    if (objType.tag === "array" && objType.size !== null) {
      return [lines, String(objType.size), "i64"];
    }
    if (objType.tag === "array" && objType.size === null) {
      // slice: runtime length from the %Vec view
      const [ol, ov] = this.genExpr(expr.object);
      lines.push(...ol);
      const len = this.nextTemp();
      lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
      return [lines, len, "i64"];
    }
    return [lines, "0", "i64"];
  }

  private genArrayLit(expr: HIRExpr & { kind: "ArrayLit" }, lines: string[]): Gen {
    // Vec literal: `[a, b, c]` with Vec<T> type hint. Emit malloc + N stores, build %Vec struct.
    if (expr.type.tag === "vec") {
      this.hasVecType = true;
      const vecElemTy = this.llvmType(expr.type.element);
      const n = expr.elements.length;
      if (n === 0) {
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %Vec undef, ptr null, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 0, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
        return [lines, s2, "%Vec"];
      }
      this.needsMalloc = true;
      const elemSize = this.typeSizeOf(expr.type.element);
      const bytes = n * elemSize;
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${bytes})`);
      const pendMark = this.pend.temps.length, built: string[] = [];
      this.pend.temps.push({ emit: l => l.push(`  call void @free(ptr ${buf})`) });
      for (let i = 0; i < n; i++) {
        const [el, ev] = this.genExpr(expr.elements[i]);
        lines.push(...el);
        const pi = this.nextTemp();
        lines.push(`  ${pi} = getelementptr ${vecElemTy}, ptr ${buf}, i64 ${i}`);
        lines.push(`  store ${vecElemTy} ${ev}, ptr ${pi}`);
        this.pendStored(lines, ev, pi, expr.type.element, built);
      }
      this.endStored(lines, built, pendMark);
      const v0 = this.nextTemp();
      lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
      const v1 = this.nextTemp();
      lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${n}, 1`);
      const v2 = this.nextTemp();
      lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${n}, 2`);
      return [lines, v2, "%Vec"];
    }
    if (expr.elements.length === 0) return [lines, "zeroinitializer", "[0 x i32]"];
    const elemTy = expr.type.tag === "array" ? this.llvmType(expr.type.element) : "i32";
    const [firstLines, firstVal] = this.genExpr(expr.elements[0]);
    lines.push(...firstLines);
    const arrTy = `[${expr.elements.length} x ${elemTy}]`;
    const alloca = this.nextTemp();
    lines.push(`  ${alloca} = alloca ${arrTy}`);
    const ptr0 = this.nextTemp();
    lines.push(`  ${ptr0} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 0`);
    lines.push(`  store ${elemTy} ${firstVal}, ptr ${ptr0}`);
    const elemTk: TypeKind = expr.type.tag === "array" ? expr.type.element : { tag: "int", bits: 32, signed: true };
    const pendMark = this.pend.temps.length, built: string[] = [];
    this.pendStored(lines, firstVal, ptr0, elemTk, built);
    for (let i = 1; i < expr.elements.length; i++) {
      const [el, ev] = this.genExpr(expr.elements[i]);
      lines.push(...el);
      const pi = this.nextTemp();
      lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
      lines.push(`  store ${elemTy} ${ev}, ptr ${pi}`);
      this.pendStored(lines, ev, pi, elemTk, built);
    }
    this.endStored(lines, built, pendMark);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${arrTy}, ptr ${alloca}`);
    return [lines, val, arrTy];
  }

  private genArrayRepeat(expr: HIRExpr & { kind: "ArrayRepeat" }, lines: string[]): Gen {
    const elemKind = expr.type.tag === "array" ? expr.type.element : { tag: "int" as const, bits: 32, signed: true };
    const elemTy = this.llvmType(elemKind);
    const arrTy = `[${expr.count} x ${elemTy}]`;
    const [vl, vv] = this.genExpr(expr.value);
    lines.push(...vl);
    if (vv === "0" || vv === "0.0" || vv === "false") {
      return [lines, "zeroinitializer", arrTy];
    }
    const alloca = this.nextTemp();
    lines.push(`  ${alloca} = alloca ${arrTy}`);
    if (this.needsDropCg(elemKind)) {
      // Non-Copy types: the checker moved the value (a place's alive flag is cleared by
      // genExpr, a temporary has no other owner), so the last slot takes it by move and
      // the other N-1 slots get copies; with a count of 0 it is dropped. A copy calls the
      // type's Clone when the checker found one (`cloneFn`), else it is the structural
      // deep clone, which only a type with no Drop anywhere in it can reach.
      const srcPtr = this.nextTemp();
      lines.push(`  ${srcPtr} = alloca ${elemTy}`);
      lines.push(`  store ${elemTy} ${vv}, ptr ${srcPtr}`);
      for (let i = 0; i < expr.count - 1; i++) {
        const pi = this.nextTemp();
        lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
        const cloned = expr.cloneFn
          ? this.emitCloneFnCall(lines, expr.cloneFn, srcPtr, elemTy)
          : this.emitDeepCloneFromPtr(lines, srcPtr, elemKind);
        lines.push(`  store ${elemTy} ${cloned}, ptr ${pi}`);
      }
      if (expr.count > 0) {
        const last = this.nextTemp();
        lines.push(`  ${last} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${expr.count - 1}`);
        lines.push(`  store ${elemTy} ${vv}, ptr ${last}`);
        this.own.endVal(lines, vv, "MOVE");
      } else {
        this.own.valToSlot(vv, srcPtr);
        this.emitDropValue(lines, srcPtr, elemKind);
      }
    } else {
      for (let i = 0; i < expr.count; i++) {
        const pi = this.nextTemp();
        lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
        lines.push(`  store ${elemTy} ${vv}, ptr ${pi}`);
      }
    }
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${arrTy}, ptr ${alloca}`);
    return [lines, val, arrTy];
  }

  // Call a `clone(self: &Self): Self` fn on the value at `srcPtr`, returning the copy.
  private emitCloneFnCall(lines: string[], fn: string, srcPtr: string, elemTy: string): string {
    const attrs = this.fnSigs.get(fn)?.refAttrs?.[0] ?? "";
    if (this.sretFns.has(fn)) {
      const dest = this.nextTemp();
      lines.push(`  ${dest} = alloca ${elemTy}`);
      lines.push(`  call void @${fn}(ptr ${dest}, ptr${attrs} ${srcPtr})`);
      const v = this.nextTemp();
      lines.push(`  ${v} = load ${elemTy}, ptr ${dest}`);
      return v;
    }
    const v = this.nextTemp();
    lines.push(`  ${v} = call ${elemTy} @${fn}(ptr${attrs} ${srcPtr})`);
    return v;
  }

  private genIndexAccess(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): Gen {
    const objTag = expr.object.type.tag === "ref" ? expr.object.type.inner.tag : expr.object.type.tag;
    if (objTag === "string") {
      return this.genStringIndex(expr, lines);
    }
    if (expr.object.type.tag === "ptr") {
      const [objLines, objVal] = this.genExpr(expr.object);
      lines.push(...objLines);
      const [idxLines, idxVal] = this.genExpr(expr.index);
      lines.push(...idxLines);
      const elemTy = this.llvmType(expr.type);
      const gep = this.nextTemp();
      lines.push(`  ${gep} = getelementptr ${elemTy}, ptr ${objVal}, i64 ${idxVal}`);
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${elemTy}, ptr ${gep}`);
      return [lines, val, elemTy];
    }
    {
    const effObj = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    // Indexing a temporary container (`worlds()[i]`) materializes it into a slot
    // that nothing else owns. Drop it once the element is safely out — after the
    // load, or after the deep clone — never before, or the element pointer would
    // outlive its buffer.
    const tempMark = this.argTempDrops.length;
    if (effObj.tag === "vec" || (effObj.tag === "array" && effObj.size === null)) {
      const [, ptr, elemTy] = this.genVecBoundsCheckedPtr(expr, lines);
      const elemKind = effObj.element;
      // Auto-clone non-Copy elements so the Vec stays intact. The user-facing
      // semantics: Vec[i] always returns an independent value.
      if (this.needsDropCg(elemKind)) {
        const cloned = this.emitDeepCloneFromPtr(lines, ptr, elemKind);
        this.flushArgTempDrops(lines, tempMark);
        return [lines, cloned, elemTy];
      }
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}${this.rangeMetaFor(expr.type, elemTy)}`);
      this.flushArgTempDrops(lines, tempMark);
      return [lines, val, elemTy];
    }
    const [, ptr, elemTy] = this.genBoundsCheckedPtr(expr, lines);
    // Sized arrays clone non-Copy elements for the same reason Vec does: a
    // bare load hands out a second owner of the same buffer, and both free
    // it at scope exit. `fn peek(a: &[string; 2]) { return a[0] }` aborted
    // on a double free.
    if (effObj.tag === "array" && this.needsDropCg(expr.type)) {
      const cloned = this.emitDeepCloneFromPtr(lines, ptr, expr.type);
      this.flushArgTempDrops(lines, tempMark);
      return [lines, cloned, elemTy];
    }
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
    this.flushArgTempDrops(lines, tempMark);
    return [lines, val, elemTy];
    }
  }

  private genEnumLit(expr: HIRExpr & { kind: "EnumLit" }, lines: string[]): Gen {
    const layout = must(this.enumLayouts, expr.enumName, "enum layouts");
    const variant = must(layout.variants, expr.variant, "variants");
    const enumTy = `%${expr.enumName}`;
    const alloca = this.nextTemp();
    lines.push(`  ${alloca} = alloca ${enumTy}`);
    this.storeEnumTag(lines, enumTy, alloca, variant.tag);
    const pendMark = this.pend.temps.length, built: string[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const [argLines, argVal, argTy] = this.genExpr(expr.args[i]);
      lines.push(...argLines);
      const fieldPtr = this.enumFieldPtr(lines, enumTy, alloca, variant, i);
      lines.push(`  store ${argTy} ${argVal}, ptr ${fieldPtr}`);
      this.pendStored(lines, argVal, fieldPtr, expr.args[i].type, built, l => this.enumFieldPtr(l, enumTy, alloca, variant, i));
    }
    this.endStored(lines, built, pendMark);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${enumTy}, ptr ${alloca}`);
    return [lines, val, enumTy];
  }

  private genMemReplace(expr: HIRExpr & { kind: "MemReplace" }, lines: string[], sretDest?: string): Gen {
    const [pl, placePtr, placeTy] = this.genLValue(expr.place);
    lines.push(...pl);
    if (this.isBigAgg(placeTy)) {
      // Old value moves out by memcpy — never load a ≥128-byte aggregate as an SSA
      // value (see isBigAgg). It lands in the caller's slot (bound `let old = ...`
      // supplies sretDest) or a scratch slot dropped here when the result is discarded.
      let dest = sretDest;
      if (!dest) { dest = this.nextTemp(); this.entryAllocas.push(`  ${dest} = alloca ${placeTy}`); }
      this.emitMemcpy(lines, dest, placePtr, placeTy, { intent: "move", type: expr.type });
      if (this.own.on && this.needsDropCg(expr.type)) this.own.slots.set(dest, this.own.make(lines, "replace-old"));
      this.genStoreInto(lines, placePtr, placeTy, expr.value, "store");   // store new; does NOT drop old
      if (!sretDest && this.needsDropCg(expr.type)) this.emitDropValue(lines, dest, expr.type);
      return [lines, dest, placeTy];
    }
    const old = this.nextTemp();
    lines.push(`  ${old} = load ${placeTy}, ptr ${placePtr}`);   // move old out
    this.genStoreInto(lines, placePtr, placeTy, expr.value, "store");     // store new; old is not dropped
    return [lines, old, placeTy];
  }

  private genEnumTryFrom(expr: HIRExpr & { kind: "EnumTryFrom" }, lines: string[]): Gen {
    const [vl, nv, nTy] = this.genExpr(expr.value);
    lines.push(...vl);
    // Compare in i64 (every discriminant fits). Sign-extend a signed source, zero-extend
    // an unsigned one, so e.g. a u8 200 matches discriminant 200 instead of wrapping.
    let n64 = nv;
    if (nTy !== "i64") {
      const signed = expr.value.type.tag === "int" ? expr.value.type.signed : true;
      n64 = this.nextTemp();
      lines.push(`  ${n64} = ${signed ? "sext" : "zext"} ${nTy} ${nv} to i64`);
    }
    let valid = "0";   // i1 false when the enum somehow has no variants
    for (const d of expr.discriminants) {
      const eq = this.nextTemp();
      lines.push(`  ${eq} = icmp eq i64 ${n64}, ${d}`);
      if (valid === "0") { valid = eq; }
      else { const o = this.nextTemp(); lines.push(`  ${o} = or i1 ${valid}, ${eq}`); valid = o; }
    }
    const optTy = `%${expr.optionEnumName}`;
    const optLayout = must(this.enumLayouts, expr.optionEnumName, "enum layouts");
    const someTag = must(optLayout.variants, "Some", "variants").tag;
    const noneTag = must(optLayout.variants, "None", "variants").tag;
    const res = this.nextTemp();
    lines.push(`  ${res} = alloca ${optTy}`);
    const someBB = this.nextLabel("tryfrom.some");
    const noneBB = this.nextLabel("tryfrom.none");
    const doneBB = this.nextLabel("tryfrom.done");
    lines.push(`  br i1 ${valid}, label %${someBB}, label %${noneBB}`);
    lines.push(`${someBB}:`);
    this.storeEnumTag(lines, optTy, res, someTag);
    // Payload IS the matched variant: a fieldless enum's value is its i32 tag, and here
    // the tag equals the matched integer. Written as the payload's leading i32.
    const n32 = this.nextTemp();
    lines.push(`  ${n32} = trunc i64 ${n64} to i32`);
    const someVariant = this.enumVariantOf(optTy, someTag);
    const payloadPtr = this.enumPayloadPtr(lines, optTy, res, someVariant);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${someVariant.fieldTypes[0]}, ptr ${payloadPtr}, i32 0, i32 0`);
    lines.push(`  store i32 ${n32}, ptr ${tagPtr}`);
    lines.push(`  br label %${doneBB}`);
    lines.push(`${noneBB}:`);
    this.storeEnumTag(lines, optTy, res, noneTag);
    lines.push(`  br label %${doneBB}`);
    lines.push(`${doneBB}:`);
    const out = this.nextTemp();
    lines.push(`  ${out} = load ${optTy}, ptr ${res}`);
    return [lines, out, optTy];
  }

  // `forget(x)` — end x's ownership without running its drop.
  //
  // For a named place that is exactly the bookkeeping every other transfer does: zero the
  // slot and clear its alive flag, so scope exit walks past it. The difference from a real
  // transfer is only that nothing on the other end will ever free it, which is the point —
  // it is for seams where ownership left through a raw pointer the checker cannot see.
  // Anything that is not a named place is still evaluated, for its side effects.
  private genForget(expr: HIRExpr & { kind: "Forget" }, lines: string[]): Gen {
    const v = expr.value;
    const named = v.kind === "Ident" && this.locals.has(v.name);
    if (named) {
      const [pl, ptr] = this.genLValue(v);
      lines.push(...pl);
      if (ptr !== "null") {
        lines.push(this.zeroStore(this.llvmType(v.type), ptr));
        const dl = this.droppableLocals.find(d => d.addr === ptr);
        if (dl) this.own.clearAlive(lines, dl.aliveFlag, "MOVE");
        return [lines, "", "void"];
      }
    }
    const [el] = this.genExpr(v);
    lines.push(...el);
    return [lines, "", "void"];
  }

  private genMemSwap(expr: HIRExpr & { kind: "MemSwap" }, lines: string[]): Gen {
    const [al, aPtr, aTy] = this.genLValue(expr.a);
    lines.push(...al);
    const [bl, bPtr] = this.genLValue(expr.b);
    lines.push(...bl);
    if (this.isBigAgg(aTy)) {
      const tmp = this.nextTemp();
      this.entryAllocas.push(`  ${tmp} = alloca ${aTy}`);
      const same = this.nextTemp();
      const swapLabel = this.nextLabel("swap.copy");
      const doneLabel = this.nextLabel("swap.done");
      lines.push(`  ${same} = icmp eq ptr ${aPtr}, ${bPtr}`);
      lines.push(`  br i1 ${same}, label %${doneLabel}, label %${swapLabel}`);
      lines.push(`${swapLabel}:`);
      this.emitMemcpy(lines, tmp, aPtr, aTy, { intent: "move", type: expr.a.type });
      this.emitMemcpy(lines, aPtr, bPtr, aTy, { intent: "move", type: expr.a.type });
      this.emitMemcpy(lines, bPtr, tmp, aTy, { intent: "move", type: expr.a.type });
      lines.push(`  br label %${doneLabel}`);
      lines.push(`${doneLabel}:`);
      return [lines, "", "void"];
    }
    // Load both before storing either — the places may alias (swap(v[i], v[j])).
    const ta = this.nextTemp();
    lines.push(`  ${ta} = load ${aTy}, ptr ${aPtr}`);
    const tb = this.nextTemp();
    lines.push(`  ${tb} = load ${aTy}, ptr ${bPtr}`);
    lines.push(this.valStore(aTy, tb, aPtr, { intent: "move", type: expr.a.type }));
    lines.push(this.valStore(aTy, ta, bPtr, { intent: "move", type: expr.a.type }));
    return [lines, "", "void"];
  }

  private genVecWithCapacity(expr: HIRExpr & { kind: "VecWithCapacity" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMalloc = true;
    const elemSize = this.typeSizeOf(expr.elementType);
    const [capLines, capVal] = this.genExpr(expr.capacity);
    lines.push(...capLines);
    this.emitNonNegativeCheck(lines, capVal, "capacity", expr.span);
    // malloc(cap * elemSize); empty (len=0) but pre-sized so pushes up to
    // cap don't realloc. cap==0 still allocates 0 bytes — harmless, matches
    // the "buffer or null" invariant push checks (null only when cap==0).
    const { buf } = this.emitAllocBytes(lines, capVal, elemSize, "veccap", expr.span);
    const v0 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
    const v1 = this.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 0, 1`);
    const v2 = this.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${capVal}, 2`);
    return [lines, v2, "%Vec"];
  }

  private genVecFilled(expr: HIRExpr & { kind: "VecFilled" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMalloc = true;
    const elemSize = this.typeSizeOf(expr.elementType);
    const elemTy = this.llvmType(expr.elementType);
    const [cntLines, cntVal] = this.genExpr(expr.count);
    lines.push(...cntLines);
    this.emitNonNegativeCheck(lines, cntVal, "length", expr.span);
    const [valLines, valVal] = this.genExpr(expr.value);
    lines.push(...valLines);
    const { buf } = this.emitAllocBytes(lines, cntVal, elemSize, "vecrep", expr.span);
    // fill loop: for i in 0..count { buf[i] = value }
    const idxSlot = this.nextTemp();
    lines.push(`  ${idxSlot} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxSlot}`);
    const condL = this.nextLabel("vecfill.cond");
    const bodyL = this.nextLabel("vecfill.body");
    const endL = this.nextLabel("vecfill.end");
    lines.push(`  br label %${condL}`);
    lines.push(`${condL}:`);
    const iv = this.nextTemp();
    lines.push(`  ${iv} = load i64, ptr ${idxSlot}`);
    const more = this.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${iv}, ${cntVal}`);
    lines.push(`  br i1 ${more}, label %${bodyL}, label %${endL}`);
    lines.push(`${bodyL}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = getelementptr ${elemTy}, ptr ${buf}, i64 ${iv}`);
    lines.push(`  store ${elemTy} ${valVal}, ptr ${slot}`);
    const inc = this.nextTemp();
    lines.push(`  ${inc} = add i64 ${iv}, 1`);
    lines.push(`  store i64 ${inc}, ptr ${idxSlot}`);
    lines.push(`  br label %${condL}`);
    lines.push(`${endL}:`);
    const v0 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
    const v1 = this.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${cntVal}, 1`);
    const v2 = this.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${cntVal}, 2`);
    return [lines, v2, "%Vec"];
  }

  // The destructor for one move closure's environment: drop every capture that owns
  // something, then free the block. Emitted per closure SHAPE, because the capture list
  // is known here and nowhere later — at the drop site all that is known is the static
  // type `move (T) => R`, which says a closure owns something but not what.
  //
  // Returns null when nothing in the environment needs dropping AND the block would only
  // need freeing — no: it always returns a name for a move closure, because the malloc'd
  // block itself always needs freeing even when every capture is Copy.
  private emitClosureEnvDrop(closureName: string, envStructTy: string, captures: { name: string; type: TypeKind }[], capFlagSlot: (i: number) => number | null): string {
    const name = `${closureName}_envdrop`;
    const body: string[] = [];
    const b = new LlvmTextBuilder(body, this);
    b.defineFn({ name, ret: Ty.void, params: [{ name: "env", ty: Ty.ptr }], internal: true });
    for (let i = 0; i < captures.length; i++) {
      if (!this.needsDropCg(captures[i].type)) continue;
      const slot = this.nextTemp();
      body.push(`  ${slot} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${i + 1}`);
      // Drop only what the body still owns. A `move` body can hand a capture to a
      // callee by value, and the glue must not free what it gave away — so each
      // droppable capture carries a liveness flag in the environment, set here at
      // creation and cleared by the move.
      //
      // The flag is not paranoia about an extra bit: the value cannot answer this.
      // Sniffing the slot for all-zero (which this did briefly) reads a legitimately
      // zero-valued capture as moved-from, and `Res { id: 0 }` then never runs its
      // destructor at all — silently, since nothing leaks when the struct owns no heap.
      const flagIdx = capFlagSlot(i);
      const liveL = this.nextLabel("envdrop.live"), skipL = this.nextLabel("envdrop.skip");
      const flagPtr = this.nextTemp(), flag = this.nextTemp();
      body.push(`  ${flagPtr} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${flagIdx}`);
      body.push(`  ${flag} = load i1, ptr ${flagPtr}`);
      body.push(`  br i1 ${flag}, label %${liveL}, label %${skipL}`);
      body.push(`${liveL}:`);
      this.emitDropValue(body, slot, captures[i].type);
      body.push(`  br label %${skipL}`);
      body.push(`${skipL}:`);
    }
    this.needsFree = true;
    body.push("  call void @free(ptr %env)");
    body.push("  ret void");
    b.endFn();
    this.closureBodies.push(body);
    return name;
  }

  private genClosure(expr: HIRExpr & { kind: "Closure" }, lines: string[]): Gen {
    const closureName = `__closure_${this.closureCounter++}`;
    const captures = expr.captures;
    const retTy = this.llvmType(expr.retType);

    const isMove = !!(expr as any).isMove;
    if (!isMove) this.byRefClosures.add(closureName);
    // by-ref closures: env holds ptrs to original allocas
    // move closures: env holds copies of captured values
    // Slot 0 of every environment is the drop function; captures start at 1. A by-
    // reference environment carries the slot too, holding null: without it, a by-ref
    // closure passed to a `move` parameter would have its stack environment read as a
    // header and whatever happened to be in the frame called as a destructor.
    // Which captures a move environment must eventually drop, and where each one's
    // liveness flag lives. A capture can be moved OUT by the body (handed to a callee
    // by value), and the glue must not drop what the body gave away. The flag is the
    // only honest way to know: an all-zero slot is not a moved-from marker, because a
    // zero-valued struct (`Res { id: 0 }`) is a perfectly good live value whose
    // destructor still has to run.
    const dropCapIdx = isMove ? captures.map((c, i) => [c, i] as const)
      .filter(([c]) => this.needsDropCg(c.type)).map(([, i]) => i) : [];
    // flag slot for capture i, or null when it needs no drop
    const capFlagSlot = (i: number) => {
      const k = dropCapIdx.indexOf(i);
      return k < 0 ? null : captures.length + 1 + k;
    };
    const envFields = captures.length > 0
      ? (isMove
        ? [...captures.map(c => this.llvmType(c.type)), ...dropCapIdx.map(() => "i1")]
        : captures.map(() => "ptr"))
      : [];
    const envStructTy = captures.length > 0 ? `{ ptr, ${envFields.join(", ")} }` : "{}";

    // save codegen state
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    const savedLocals = this.locals;
    // per-closure: a nested closure must not see the outer body's capture flags
    const savedCapFlags = this.captureFlagByAddr;
    this.captureFlagByAddr = new Map();
    const savedDroppable = this.droppableLocals;
    const savedPartial = this.partialMovePaths, savedFieldFlags = this.fieldMoveFlags;
    this.partialMovePaths = this.scanPartialMoves(expr.body);
    this.fieldMoveFlags = new Map();
    // The closure is its own function: its exits must not drop the enclosing
    // expression's pending temporaries (they live in the other frame).
    const savedPend = this.pend, savedArgTemps = this.argTempDrops;
    this.pend = { temps: [], parents: [], loopTemps: 0, loopArgTemps: 0 };
    this.argTempDrops = [];
    const ownRestore = this.own.enterFn();
    const savedLoopHeader = this.loopHeader;
    const savedLoopExit = this.loopExit;
    const savedFnSret = this.currentFnSret;
    const savedEntryAllocas = this.entryAllocas;
    const savedEmittedAddrs = this.emittedAddrs;
    const savedFnName = this.currentFnName;
    const savedEnsures = this.currentEnsures;
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals = new Map();
    this.droppableLocals = [];
    this.entryAllocas = [];
    this.emittedAddrs = new Set();
    this.loopHeader = null;
    this.loopExit = null;
    // a closure is never sret-lowered: its Return must `ret` the value, not write the
    // enclosing fn's %__sret.out
    this.currentFnSret = false;
    // a Return inside the closure body must not assert the enclosing fn's ensures
    this.currentEnsures = [];
    this.currentFnName = closureName;
    // closure bodies carry no subprogram (M1/M2); suppress dbg.declare so its locals
    // aren't scoped to the enclosing fn (the closure define lacks !dbg anyway)
    const savedSubprogram = this.currentSubprogramId;
    this.currentSubprogramId = null;

    // generate closure function: @__closure_N(ptr %env, params...)
    const closureBody: string[] = [];
    // Closure params carry the full type (top-level fns split it into inner + isRef),
    // and the prologue below spills every ref param as a pointer. `&string` lowers to
    // %String by value in return position, so ask for the pointer explicitly here.
    // `&[T]`/`&mut [T]` needs the same override: llvmType maps it to %Vec (the shape a
    // slice EXPRESSION produces), but a slice parameter is passed the way every other
    // reference parameter is (as the address of the %Vec), so a closure declaring one
    // used to define `%Vec %s` while the prologue and the call site both spoke `ptr`.
    // Nothing caught it: an indirect call has no callee signature to disagree with.
    const closureParamTy = (t: TypeKind) =>
      t.tag === "ref" && (t.inner.tag === "string" || (t.inner.tag === "array" && t.inner.size === null))
        ? "ptr" : this.llvmType(t);
    const closureParams: Param[] = [{ name: "env", ty: Ty.ptr }, ...expr.params.map(p => ({ name: p.name, ty: Ty.of(closureParamTy(p.type)) }))];
    // Internal, like every other Milo fn: an external closure outlives its dead enclosing
    // fn (globaldce cannot drop it), so a std fn never called on Windows still linked its
    // closure's POSIX calls (std/fs's `lstat`, `opendir`...) and failed the link. cgu.ts
    // promotes one that another codegen unit references.
    const bClo = new LlvmTextBuilder(closureBody, this);
    bClo.defineFn({ name: closureName, ret: Ty.of(retTy), params: closureParams, internal: true });

    // load captures from env struct
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      const capTy = this.llvmType(cap.type);
      // i + 1: slot 0 is the drop-function header (see envStructTy).
      const capSlot = `getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${i + 1}`;
      if (isMove) {
        // A move closure's env slot IS the capture's storage — alias it rather than
        // copying it into a private alloca. That aliasing is what makes the env drop
        // glue move-aware for free: when the body moves a capture out, the move's
        // existing zeroing of the source writes THROUGH to the env, so the glue's
        // liveness check (cap > 0, non-null ptr) sees an empty slot and skips it.
        // With a private copy the env kept a live header after the body had already
        // handed the value to a callee, so any path that ran the glue double-freed.
        this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: false });
        closureBody.push(`  %${cap.name}.addr = ${capSlot}`);
        const flagIdx = capFlagSlot(i);
        if (flagIdx !== null) {
          const flagPtr = `%${cap.name}.aliveflag`;
          closureBody.push(`  ${flagPtr} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${flagIdx}`);
          this.captureFlagByAddr.set(`%${cap.name}.addr`, flagPtr);
        }
      } else {
        const gepPtr = this.nextTemp();
        closureBody.push(`  ${gepPtr} = ${capSlot}`);
        const loadedPtr = this.nextTemp();
        closureBody.push(`  ${loadedPtr} = load ptr, ptr ${gepPtr}`);
        // the capture is a pointer to the original variable's alloca, or, for a captured
        // reference (`self`, a `&T` param), the pointer that reference holds, which the
        // creating side loaded for us. Either way the slot points at the value, so a
        // reference is described like a `&T` parameter: by its pointee.
        const viaRef = cap.type.tag === "ref" ? cap.type : null;
        this.locals.set(cap.name, viaRef
          ? { type: this.llvmType(viaRef.inner), typeKind: viaRef.inner, mutable: viaRef.mutable, isRef: true, addr: `${gepPtr}.ref` }
          : { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: true, addr: `${gepPtr}.ref` });
        closureBody.push(`  ${gepPtr}.ref = alloca ptr`);
        closureBody.push(`  store ptr ${loadedPtr}, ptr ${gepPtr}.ref`);
      }
    }

    // A `move` closure whose body moves a capture out can run once: the move zeroes
    // the environment slot and clears its liveness flag, so a second call would read an
    // empty capture and compute a wrong answer, quietly. The checker rejects the second
    // call when it can see it (a local called twice); through a function parameter it
    // cannot (`fn twice(f: move () => i64) { f() + f() }`), so the environment is asked
    // here: a cleared flag on a consumed capture means this call is the second one.
    if (isMove) {
      for (let i = 0; i < captures.length; i++) {
        const cap = captures[i];
        const flagIdx = capFlagSlot(i);
        if (!cap.consumedInClosure || flagIdx === null) continue;
        this.needsDprintf = true;
        this.needsExit = true;
        const flag = this.nextTemp();
        closureBody.push(`  ${flag} = load i1, ptr %${cap.name}.aliveflag`);
        const okLabel = this.nextLabel("once.ok");
        const spentLabel = this.nextLabel("once.spent");
        closureBody.push(`  br i1 ${flag}, label %${okLabel}, label %${spentLabel}`);
        closureBody.push(`${spentLabel}:`);
        const fmtStr = this.addString(`closure called again after it moved '${cap.name}' out (${this.panicAt(expr.span)}): a move closure that gives a capture away can run once\n`);
        this.emitFdPrintf(closureBody, 2, fmtStr.label, "");
        this.panicAbort(closureBody);
        closureBody.push(`  unreachable`);
        closureBody.push(`${okLabel}:`);
      }
    }

    // set up params
    for (const p of expr.params) {
      const isRefParam = p.type.tag === "ref";
      if (isRefParam && p.type.tag === "ref") {
        const innerTy = this.llvmType(p.type.inner);
        closureBody.push(`  %${p.name}.addr = alloca ptr`);
        closureBody.push(`  store ptr %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: innerTy, typeKind: p.type, mutable: false, isRef: true });
      } else {
        const lt = this.llvmType(p.type);
        closureBody.push(`  %${p.name}.addr = alloca ${lt}`);
        closureBody.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: lt, typeKind: p.type, mutable: false, isRef: false });
        // A by-value owned parameter belongs to the CALLEE, exactly as it does for a plain
        // `fn` (see the matching block in the function-parameter loop). Without this a
        // closure never dropped such a parameter — and the caller does not either: it moves
        // the value in, zeroing the slot and clearing the alive flag, then frees nothing.
        // So nobody did, and every call leaked the argument:
        //
        //     let f = (a: string): i64 => (a + "x").len
        //     let s = big()
        //     f(s)                      // s's buffer leaked, every call
        //
        // The leak gate never saw it because `leaks` finds a small block reachable from a
        // stale stack slot and does not report it; at 16 KB a string it is 200 leaks per
        // 200 calls. Registering here is a drop the caller cannot double, precisely because
        // the caller was not dropping at all.
        if (this.needsDropCg(p.type)) {
          const aliveFlag = `%${p.name}.alive`;
          closureBody.push(`  ${aliveFlag} = alloca i1`);
          this.registerFieldFlags(closureBody, `%${p.name}.addr`, p.name, p.type);
          this.own.setAlive(closureBody, aliveFlag, `%${p.name}.addr`, "closure-param");
          this.droppableLocals.push({ name: p.name, typeKind: p.type, aliveFlag, addr: `%${p.name}.addr` });
        }
      }
    }

    // generate body
    const closureAllocaInsertPoint = closureBody.length;
    let hasTerminator = false;
    for (const stmt of expr.body) {
      const [stmtLines, terminated] = this.genStmt(stmt);
      closureBody.push(...stmtLines);
      if (terminated) { hasTerminator = true; break; }
    }
    if (!hasTerminator) {
      // Falling off the end is a scope exit, as in genFunction: the body's locals drop
      // here. Without it a local declared in a closure body (a TcpStream accepted inside
      // a spawned task) never ran its Drop unless the body ended in an explicit return.
      this.emitDropGlue(closureBody);
      if (retTy === "void") closureBody.push("  ret void");
      else { closureBody.push("  call void @llvm.trap()"); closureBody.push("  unreachable"); } // see genFn's fall-off
    }
    if (this.entryAllocas.length > 0) {
      closureBody.splice(closureAllocaInsertPoint, 0, ...this.entryAllocas);
    }
    this.hoistAllocas(closureBody, closureAllocaInsertPoint);
    bClo.endFn();
    this.closureBodies.push(closureBody);

    // restore codegen state
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
    this.locals = savedLocals;
    this.captureFlagByAddr = savedCapFlags;
    this.droppableLocals = savedDroppable;
    this.partialMovePaths = savedPartial; this.fieldMoveFlags = savedFieldFlags;
    this.pend = savedPend;
    this.argTempDrops = savedArgTemps;
    ownRestore();
    this.entryAllocas = savedEntryAllocas;
    this.emittedAddrs = savedEmittedAddrs;
    this.loopHeader = savedLoopHeader;
    this.loopExit = savedLoopExit;
    this.currentFnSret = savedFnSret;
    this.currentFnName = savedFnName;
    this.currentSubprogramId = savedSubprogram;
    this.currentEnsures = savedEnsures;

    // at the call site: build env struct and closure pair
    if (captures.length > 0) {
      let envAddr = this.nextTemp();
      // The header slot is part of the allocation, so it is sized in here too.
      const envSize = this.structPayloadSize(["ptr", ...envFields]);
      // A by-ref env normally lives in the frame that created the closure, which
      // outlives every use — except in the global-init routine, whose frame is gone
      // before main runs. A closure global's env has to be static, so give it its own
      // module-level slot. Only the env *container* moves: the captures it points at
      // are globals, so they were already static. Scoped by currentFnName rather than
      // a spanning flag so a closure created *inside* another closure's body during
      // global init still gets a per-call frame env (that body runs many times).
      const staticEnv = !isMove && (this.currentFnName === GLOBAL_INIT_FN || this.currentFnName.startsWith(LAZY_INIT_PREFIX));
      if (isMove || expr.heapEnv) {
        // heap-allocate env for move closures (safe to send to other threads)
        this.needsMalloc = true;
        lines.push(`  ${envAddr} = call ptr @malloc(i64 ${Math.max(envSize, 16)})`);
      } else if (staticEnv) {
        this.closureBodies.push([`@${closureName}_env = internal global ${envStructTy} zeroinitializer`]);
        envAddr = `@${closureName}_env`;
      } else {
        lines.push(`  ${envAddr} = alloca ${envStructTy}`);
      }
      // Slot 0: how to release this environment. A move closure owns its captures and
      // the block itself; a by-reference one owns neither, and stores null.
      // A heap by-reference environment (a scoped task's) owns only the block: its glue
      // frees it and drops no capture.
      const dropFnName = isMove ? this.emitClosureEnvDrop(closureName, envStructTy, captures, capFlagSlot)
        : expr.heapEnv ? this.emitClosureEnvDrop(closureName, envStructTy, [], capFlagSlot) : null;
      const hdrSlot = this.nextTemp();
      lines.push(`  ${hdrSlot} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 0`);
      lines.push(`  store ptr ${dropFnName === null ? "null" : `@${dropFnName}`}, ptr ${hdrSlot}`);
      for (let i = 0; i < captures.length; i++) {
        const cap = captures[i];
        const capAddr = this.localAddr(cap.name);
        const local = this.locals.get(cap.name);
        const capTy = this.llvmType(cap.type);
        const gepSlot = this.nextTemp();
        lines.push(`  ${gepSlot} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 ${i + 1}`);
        if (isMove) {
          const flagIdx = capFlagSlot(i);
          if (flagIdx !== null) {
            const flagPtr = this.nextTemp();
            lines.push(`  ${flagPtr} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 ${flagIdx}`);
            lines.push(`  store i1 1, ptr ${flagPtr}`);
          }
          // copy the VALUE into the env
          const loaded = this.nextTemp();
          if (local?.isRef) {
            const innerPtr = this.nextTemp();
            lines.push(`  ${innerPtr} = load ptr, ptr ${capAddr}`);
            const val = this.nextTemp();
            lines.push(`  ${val} = load ${capTy}, ptr ${innerPtr}`);
            lines.push(`  store ${capTy} ${cap.share ? this.emitStrShare(lines, val) : val}, ptr ${gepSlot}`);
            // A by-reference closure's capture moved into this one moves the binding it
            // points at (the checker marks that binding moved), so the owner must not
            // drop it again: zero it, as a move out of the owner's own frame does. Without
            // this, `apply(() => Promise.blocking(() => v.len))` freed `v` twice.
            if (cap.type.tag !== "ref" && this.needsDropCg(cap.type) && !cap.share) lines.push(this.zeroStore(capTy, innerPtr));
          } else {
            lines.push(`  ${loaded} = load ${capTy}, ptr ${capAddr}`);
            // A shared string capture: the env gets its own handle, the binding stays live.
            const stored = cap.share ? this.emitStrShare(lines, loaded) : loaded;
            lines.push(`  store ${capTy} ${stored}, ptr ${gepSlot}`);
            // zero source so parent's drop glue won't free moved data
            if (this.needsDropCg(cap.type) && !cap.share) {
              lines.push(this.zeroStore(capTy, capAddr));
              const dl = this.droppableLocals.find(d => d.addr === capAddr);
              if (dl) this.own.clearAlive(lines, dl.aliveFlag, "CAPTURE");
              // The source may itself be a capture of the closure we are emitting inside
              // (a nested `move` closure re-capturing the outer one's value). The outer
              // environment has just handed the value over, so clear its flag too, or
              // both environments drop it.
              const outerFlag = this.captureFlagByAddr.get(capAddr);
              if (outerFlag) lines.push(`  store i1 0, ptr ${outerFlag}`);
            }
          }
        } else if (local?.isRef) {
          // variable is already a ref (ptr to ptr) — load the inner ptr
          const innerPtr = this.nextTemp();
          lines.push(`  ${innerPtr} = load ptr, ptr ${capAddr}`);
          lines.push(`  store ptr ${innerPtr}, ptr ${gepSlot}`);
        } else {
          // variable is a value — store pointer to its alloca
          lines.push(`  store ptr ${capAddr}, ptr ${gepSlot}`);
        }
      }
      // build { ptr fn_ptr, ptr env_ptr }
      const closurePair = this.nextTemp();
      lines.push(`  ${closurePair} = insertvalue { ptr, ptr } undef, ptr @${closureName}, 0`);
      const closurePair2 = this.nextTemp();
      lines.push(`  ${closurePair2} = insertvalue { ptr, ptr } ${closurePair}, ptr ${envAddr}, 1`);
      return [lines, closurePair2, "{ ptr, ptr }"];
    } else {
      const closurePair = this.nextTemp();
      lines.push(`  ${closurePair} = insertvalue { ptr, ptr } undef, ptr @${closureName}, 0`);
      const closurePair2 = this.nextTemp();
      lines.push(`  ${closurePair2} = insertvalue { ptr, ptr } ${closurePair}, ptr null, 1`);
      return [lines, closurePair2, "{ ptr, ptr }"];
    }
  }

  private genCFnCall(expr: HIRExpr & { kind: "CFnCall" }, lines: string[]): Gen {
    // a bare C function pointer: call it directly, with no env prepended
    const [calLines, calVal] = this.genExpr(expr.callee);
    lines.push(...calLines);
    const cTempMark = this.argTempDrops.length;
    const argVals: { val: string; type: string }[] = [];
    const argEnds: string[] = [];
    for (const arg of expr.args) {
      if (arg.passByRef) {
        const [al, aPtr] = this.genLValueForArg(arg.expr);
        lines.push(...al);
        argVals.push({ val: aPtr, type: "ptr" });
      } else {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        argVals.push({ val: av, type: at });
        if (!this.isLentClosure(arg.expr)) argEnds.push(av);
      }
    }
    for (const v of argEnds) this.own.endVal(lines, v, "ARG");   // see genCall
    const cArgsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
    const cRetTy = this.llvmType(expr.type);
    if (cRetTy === "void") {
      lines.push(`  call void ${calVal}(${cArgsStr})`);
      this.flushArgTempDrops(lines, cTempMark);
      return [lines, "void", "void"];
    }
    const cResult = this.nextTemp();
    lines.push(`  ${cResult} = call ${cRetTy} ${calVal}(${cArgsStr})`);
    this.flushArgTempDrops(lines, cTempMark);
    return [lines, cResult, cRetTy];
  }

  private genClosureCall(expr: HIRExpr & { kind: "ClosureCall" }, lines: string[]): Gen {
    // load the { fn_ptr, env_ptr } pair from the callee
    const [calLines, calVal] = this.genExpr(expr.callee);
    lines.push(...calLines);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${calVal}, 0`);
    const envPtr = this.nextTemp();
    lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${calVal}, 1`);

    // evaluate args
    const clTempMark = this.argTempDrops.length;
    const argVals: { val: string; type: string }[] = [{ val: envPtr, type: "ptr" }];
    const refPtrs: { ptr: string; mut: boolean }[] = [];
    // A `&[T]` parameter is address-passed (see closureParamTy). An already-borrowed
    // slice arrives as a `ptr` from genExpr, but a slice TEMPORARY (`f(v[0..2])`, a
    // freshly minted foreign view) is a %Vec value, so materialise it and pass its
    // address: the same thing genCall does one layer up for a direct call.
    const calleeParams = expr.callee.type.tag === "fn" ? expr.callee.type.params : [];
    const argEnds: string[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      const pt = calleeParams[i];
      const wantsSliceAddr = pt?.tag === "ref" && pt.inner.tag === "array" && pt.inner.size === null;
      if (arg.passByRef || wantsSliceAddr) {
        const [al, aPtr] = this.genLValueForArg(arg.expr);
        lines.push(...al);
        argVals.push({ val: aPtr, type: "ptr" });
        if (arg.passByRef) refPtrs.push({ ptr: aPtr, mut: arg.refMut });
      } else {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        argVals.push({ val: av, type: at });
        if (!this.isLentClosure(arg.expr)) argEnds.push(av);
        // Same ownership hand-off as a direct call's closure argument (see genCall).
        if (this.ownsClosureEnv(arg.expr) && at === "{ ptr, ptr }"
            && !this.indirectParamEscapes(expr.callee.type, i)) {
          const slot = `%__clarg.${this.scopeCounter++}.addr`;
          this.entryAllocas.push(`  ${slot} = alloca { ptr, ptr }`);
          lines.push(`  store { ptr, ptr } ${av}, ptr ${slot}`);
          this.argTempDrops.push({ addr: slot, type: { ...arg.expr.type, owning: true } as TypeKind, ownVal: av });
          this.unpend(av);
        }
      }
    }
    for (const v of argEnds) this.own.endVal(lines, v, "ARG");   // see genCall
    this.emitAliasGuards(lines, refPtrs, expr.span);

    const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
    const retTy = this.llvmType(expr.type);
    if (retTy === "void") {
      lines.push(`  call void ${fnPtr}(${argsStr})`);
      this.flushArgTempDrops(lines, clTempMark);
      return [lines, "void", "void"];
    }
    const result = this.nextTemp();
    lines.push(`  ${result} = call ${retTy} ${fnPtr}(${argsStr})`);
    this.flushArgTempDrops(lines, clTempMark);
    return [lines, result, retTy];
  }

  // Move an error value into a fresh heap box and answer the fat pointer { data, itable }
  // that a Heap<Iface> holds. A string error is wrapped in the prelude ErrorMessage first.
  // Shared by `?` into Heap<Error> and `.context`.
  private emitBoxAsIface(lines: string[], payloadVal: string, payloadTy: string, box: PropagateBoxing): string {
    this.needsMalloc = true;
    let boxedVal = payloadVal;
    let boxedTy = payloadTy;
    let boxedType: TypeKind = box.errType;
    if (box.viaMessage) {
      boxedType = { tag: "struct", name: box.fromType };
      boxedTy = this.llvmType(boxedType);
      boxedVal = this.nextTemp();
      lines.push(`  ${boxedVal} = insertvalue ${boxedTy} undef, ${payloadTy} ${payloadVal}, 0`);
    }
    return this.emitHeapFatPtr(lines, boxedVal, boxedTy, boxedType, box.fromType, box.ifaceName);
  }

  // malloc a copy of `val` and pair it with the itable for (concrete, iface).
  private emitHeapFatPtr(lines: string[], val: string, ty: string, type: TypeKind, fromType: string, ifaceName: string): string {
    this.needsMalloc = true;
    const boxPtr = this.nextTemp();
    lines.push(`  ${boxPtr} = call ptr @malloc(i64 ${this.typeSizeOf(type)})`);
    lines.push(`  store ${ty} ${val}, ptr ${boxPtr}`);
    const itableInfo = this.itableLayouts.get(`${fromType}.${ifaceName}`);
    const itableGlobal = itableInfo?.globalName ?? `@itable.${fromType}.${ifaceName}`;
    const fat0 = this.nextTemp();
    lines.push(`  ${fat0} = insertvalue { ptr, ptr } undef, ptr ${boxPtr}, 0`);
    const fat = this.nextTemp();
    lines.push(`  ${fat} = insertvalue { ptr, ptr } ${fat0}, ptr ${itableGlobal}, 1`);
    return fat;
  }

  private genInterfaceCoerce(expr: HIRExpr & { kind: "InterfaceCoerce" }, lines: string[]): Gen {
    // build fat pointer { ptr data, ptr itable }
    const isHeapCoerce = expr.type.tag === "heap";
    let dataPtr: string;
    if (isHeapCoerce) {
      // Heap<T> → Heap<Interface>: data ptr is the heap pointer value
      const [valLines, valVal] = this.genExpr(expr.value);
      lines.push(...valLines);
      dataPtr = valVal;
    } else {
      // &T → &Interface: data ptr is address of the concrete value
      const [addrLines, addrVal] = this.genLValueForArg(expr.value);
      lines.push(...addrLines);
      dataPtr = addrVal;
    }
    const itableKey = `${expr.fromType}.${expr.ifaceName}`;
    const itableInfo = this.itableLayouts.get(itableKey);
    const itableGlobal = itableInfo?.globalName ?? `@itable.${expr.fromType}.${expr.ifaceName}`;
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue { ptr, ptr } undef, ptr ${dataPtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue { ptr, ptr } ${s0}, ptr ${itableGlobal}, 1`);
    // Heap<T> -> Heap<Iface> re-labels the same allocation: the result inherits its ID.
    if (isHeapCoerce) this.own.inherit(dataPtr, s1);
    return [lines, s1, "{ ptr, ptr }"];
  }

  private genIfExpr(expr: HIRExpr & { kind: "IfExpr" }, lines: string[]): Gen {
    const resultTy = this.llvmType(expr.type);
    const resultAddr = `%__ifexpr.${this.scopeCounter++}.addr`;
    // A void-typed if-expression (a redirected void extern call, lower.ts) has no value
    // to carry: no slot, and nothing to load at the end.
    const isVoid = resultTy === "void";
    if (!isVoid) this.entryAllocas.push(`  ${resultAddr} = alloca ${resultTy}`);
    if (this.own.on && this.needsDropCg(expr.type)) this.own.resultSlots.set(resultAddr, { arms: 0, type: expr.type });
    const cloneViews = !isVoid && this.isOwnedTempExpr(expr);

    const [condLines, condVal] = this.genExpr(expr.cond);
    lines.push(...condLines);

    const thenLabel = this.nextLabel("ife.then");
    const elseLabel = this.nextLabel("ife.else");
    const endLabel = this.nextLabel("ife.end");
    lines.push(`  br i1 ${condVal}, label %${thenLabel}, label %${elseLabel}`);

    lines.push(`${thenLabel}:`);
    let thenTerminated = false;
    for (let i = 0; i < expr.thenBody.length - 1; i++) {
      const [sl, t] = this.genStmt(expr.thenBody[i]);
      lines.push(...sl);
      if (t) { thenTerminated = true; break; }
    }
    if (!thenTerminated && expr.thenBody.length > 0) {
      const last = expr.thenBody[expr.thenBody.length - 1];
      if (last.kind === "ExprStmt") {
        const [vl, gv] = this.genExpr(last.expr);
        lines.push(...vl);
        const vv = gv !== "void" && cloneViews && this.forkTailIsView(last.expr, false) ? this.cloneViewValue(lines, gv, last.expr.type) : gv;
        if (vv !== "void" && !isVoid) lines.push(`  store ${resultTy} ${vv}, ptr ${resultAddr}`);
        if (vv !== "void" && !isVoid) this.own.intoResult(lines, resultAddr, vv);
      } else {
        const [sl, t] = this.genStmt(last);
        lines.push(...sl);
        if (t) thenTerminated = true;
      }
    }
    if (!thenTerminated) lines.push(`  br label %${endLabel}`);

    lines.push(`${elseLabel}:`);
    let elseTerminated = false;
    for (let i = 0; i < expr.elseBody.length - 1; i++) {
      const [sl, t] = this.genStmt(expr.elseBody[i]);
      lines.push(...sl);
      if (t) { elseTerminated = true; break; }
    }
    if (!elseTerminated && expr.elseBody.length > 0) {
      const last = expr.elseBody[expr.elseBody.length - 1];
      if (last.kind === "ExprStmt") {
        const [vl, gv] = this.genExpr(last.expr);
        lines.push(...vl);
        const vv = gv !== "void" && cloneViews && this.forkTailIsView(last.expr, false) ? this.cloneViewValue(lines, gv, last.expr.type) : gv;
        if (vv !== "void" && !isVoid) lines.push(`  store ${resultTy} ${vv}, ptr ${resultAddr}`);
        if (vv !== "void" && !isVoid) this.own.intoResult(lines, resultAddr, vv);
      } else {
        const [sl, t] = this.genStmt(last);
        lines.push(...sl);
        if (t) elseTerminated = true;
      }
    }
    if (!elseTerminated) lines.push(`  br label %${endLabel}`);

    lines.push(`${endLabel}:`);
    if (thenTerminated && elseTerminated) {
      lines.push(`  unreachable`);
      return [lines, "void", "void"];
    }
    if (isVoid) return [lines, "void", "void"];
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${resultAddr}`);
    this.own.resultMade(lines, resultAddr, result, expr);
    return [lines, result, resultTy];
  }



  private genInterfaceMethodCall(expr: HIRExpr & { kind: "InterfaceMethodCall" }, lines: string[]): Gen {
    // object is { ptr data, ptr itable } — either directly or loaded from alloca
    let objVal: string;
    const recv = expr.object;
    if (recv.kind === "IndexAccess" && recv.object.type.tag === "vec") {
      // Borrow the fat pointer straight from the Vec slot. Dispatch only
      // reads data+itable, so don't deep-clone the element — an interface
      // value can't be cloned (the itable carries no clone slot), and
      // cloning it as a thin Heap mis-handles the fat pointer.
      const [, slotPtr] = this.genVecBoundsCheckedPtr(recv, lines);
      objVal = this.nextTemp();
      lines.push(`  ${objVal} = load { ptr, ptr }, ptr ${slotPtr}`);
    } else {
      const [objLines, ov] = this.genExpr(recv);
      lines.push(...objLines);
      objVal = ov;
    }

    // extract data ptr and itable ptr
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = extractvalue { ptr, ptr } ${objVal}, 0`);
    const itablePtr = this.nextTemp();
    lines.push(`  ${itablePtr} = extractvalue { ptr, ptr } ${objVal}, 1`);

    // load fn ptr from itable slot — GEP with ptr element type strides by 8 bytes
    const fnSlot = this.nextTemp();
    lines.push(`  ${fnSlot} = getelementptr ptr, ptr ${itablePtr}, i32 ${expr.methodIndex}`);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = load ptr, ptr ${fnSlot}`);

    // build args: data ptr as self, then user args
    const imTempMark = this.argTempDrops.length;
    const argVals: { val: string; type: string }[] = [{ val: dataPtr, type: "ptr" }];
    const refPtrs: { ptr: string; mut: boolean }[] = [];
    const argEnds: string[] = [];
    for (const arg of expr.args) {
      if (arg.passByRef) {
        const [al, aPtr] = this.genLValueForArg(arg.expr);
        lines.push(...al);
        argVals.push({ val: aPtr, type: "ptr" });
        refPtrs.push({ ptr: aPtr, mut: arg.refMut });
      } else {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        argVals.push({ val: av, type: at });
        if (!this.isLentClosure(arg.expr)) argEnds.push(av);
      }
    }
    for (const v of argEnds) this.own.endVal(lines, v, "ARG");   // see genCall
    this.emitAliasGuards(lines, refPtrs, expr.span);

    const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
    const retTy = this.llvmType(expr.type);
    if (retTy === "void") {
      lines.push(`  call void ${fnPtr}(${argsStr})`);
      this.flushArgTempDrops(lines, imTempMark);
      return [lines, "void", "void"];
    }
    const result = this.nextTemp();
    lines.push(`  ${result} = call ${retTy} ${fnPtr}(${argsStr})`);
    this.flushArgTempDrops(lines, imTempMark);
    return [lines, result, retTy];
  }

  private genUnwrap(expr: HIRExpr & { kind: "Unwrap" }, lines: string[]): Gen {
    this.needsPrintf = true;
    this.needsExit = true;
    const [ol, ov] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = must(this.enumLayouts, expr.enumName, "enum layouts");
    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);

    // store enum value, extract tag
    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tag = this.loadEnumTag(lines, enumTy, enumAddr);

    // Some/Ok is always tag 0
    const okLabel = this.nextLabel("unwrap.ok");
    const panicLabel = this.nextLabel("unwrap.panic");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${okLabel}, label %${panicLabel}`);

    // panic branch — print error and exit
    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const isResult = expr.enumName.startsWith("Result_");
    const errVariant = isResult ? layout.variants.get("Err") : null;
    const errIsString = errVariant && errVariant.fieldTypes.length === 1 && errVariant.fieldTypes[0] === "%String";
    // Panics go to stderr, not stdout: a tool whose stdout is being piped must not have
    // its own death message land in the consumer's data stream.
    const errPayloadTy = errVariant?.fieldTypes.length === 1 ? errVariant.fieldTypes[0] : null;
    const errPayloadEnum = errPayloadTy?.startsWith("%") ? errPayloadTy.slice(1) : null;
    if (isResult && errIsString) {
      // Err(string) — extract and print the message
      const errPayloadPtr = this.enumPayloadPtr(lines, enumTy, enumAddr, "Err");
      const errStr = this.nextTemp();
      lines.push(`  ${errStr} = load %String, ptr ${errPayloadPtr}`);
      const errDataPtr = this.nextTemp();
      lines.push(`  ${errDataPtr} = extractvalue %String ${errStr}, 0`);
      const fmt = this.addString(`error at ${this.panicAt(span)}: %s\n`);
      this.emitFdPrintf(lines, 2, fmt.label, `, ptr ${errDataPtr}`);
    } else if (isResult && errPayloadEnum && this.enumLayouts.has(errPayloadEnum)) {
      // Err(SomeEnum) — say *which* error. "unwrap called on Err" alone tells the reader
      // nothing they can act on; `Err(IoError.PermissionDenied)` is the whole diagnosis.
      const errPayloadPtr = this.enumPayloadPtr(lines, enumTy, enumAddr, "Err");
      const errVal = this.nextTemp();
      lines.push(`  ${errVal} = load ${errPayloadTy}, ptr ${errPayloadPtr}`);
      const desc = this.emitEnumDisplay(errPayloadEnum, errVal, lines);
      const fmt = this.addString(`error at ${this.panicAt(span)}: unwrap called on Err(%s)\n`);
      this.emitFdPrintf(lines, 2, fmt.label, `, ptr ${desc}`);
    } else if (isResult) {
      const fmt = this.addString(`error at ${this.panicAt(span)}: unwrap called on Err\n`);
      this.emitFdPrintf(lines, 2, fmt.label, "");
    } else {
      const fmt = this.addString(`error at ${this.panicAt(span)}: unwrap called on None\n`);
      this.emitFdPrintf(lines, 2, fmt.label, "");
    }
    this.panicAbort(lines);
    lines.push(`  unreachable`);

    // ok branch — extract payload and zero source to prevent double-free
    lines.push(`${okLabel}:`);
    this.own.endVal(lines, ov, "MOVE");
    // `Result<void, E>` has no payload to extract, and LLVM rejects `load void` outright
    // ("void type only allowed for function results"), so a `Promise<void>` failed to
    // compile at the link step rather than anywhere a diagnostic could point at.
    if (resultTy === "void") return [lines, "", "void"];
    const payloadPtr = this.enumPayloadPtr(lines, enumTy, enumAddr, 0);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    return [lines, result, resultTy];
  }

  private genPropagate(expr: HIRExpr & { kind: "Propagate" }, lines: string[]): Gen {
    // Slots the operand itself queues on argTempDrops are its caller's to release on the
    // ok path, and the Err payload may still point into one, so the error exit leaves
    // them alone; everything queued before the operand is pending and dropped.
    const argTempsBefore = this.argTempDrops.length;
    const [ol, ov] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = must(this.enumLayouts, expr.enumName, "enum layouts");
    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);
    const retTy = this.llvmType(expr.retType);

    // store enum value, extract tag
    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tag = this.loadEnumTag(lines, enumTy, enumAddr);

    // Some/Ok is tag 0
    const okLabel = this.nextLabel("prop.ok");
    const errLabel = this.nextLabel("prop.err");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${okLabel}, label %${errLabel}`);

    // error branch — reconstruct caller's return type with the Err payload.
    //
    // This is a RETURN, so it owes the same scope drops a `return` statement emits. It
    // did not emit them, and every owned local live at a `?` leaked on the error path —
    // idiomatic Milo error handling, so the leak was everywhere. std/inflate's
    // zlibDecompress lost its decompression buffer on every malformed input, which for a
    // decompressor of untrusted bytes is an unbounded leak driven by a peer.
    //
    // It stayed invisible because a toy reproduction does NOT leak: with nothing
    // observing the allocation, LLVM deletes it outright at -O2. It only shows when the
    // buffer is actually used, which is why it surfaced from a real module and not from
    // any of the small cases written to hunt it.
    //
    // emitGuardedDrop reads each local's alive flag, and a local consumed BY the `?`
    // operand was already zeroed and marked dead by the move machinery, so returning its
    // payload here cannot double-free.
    lines.push(`${errLabel}:`);
    this.own.endVal(lines, ov, "RETURN");
    this.emitPendingDrops(lines, 0, 0, argTempsBefore);
    this.emitDropGlue(lines);
    const retEnumName = expr.retType.tag === "enum" ? expr.retType.name : expr.enumName;
    if (retEnumName === expr.enumName && !expr.fromConversion && !expr.boxConversion) {
      // same enum type — return as-is. When the enclosing fn is sret-lowered
      // (big-aggregate return), the signature is `void @f(ptr %__sret.out, …)`,
      // so this early `?`-return must write the result buffer and `ret void`
      // rather than `ret <value>` (which mismatches the void result type).
      if (this.currentFnSret) {
        lines.push(`  store ${retTy} ${ov}, ptr %__sret.out`);
        lines.push("  ret void");
      } else {
        lines.push(`  ret ${retTy} ${ov}`);
      }
    } else {
      // extract source Err payload
      const srcErrVariant = layout.variants.get("Err") || layout.variants.get("None");
      const srcErrFieldTy = srcErrVariant && srcErrVariant.fieldTypes.length > 0 ? srcErrVariant.fieldTypes[0] : null;
      const errPayloadPtr = srcErrVariant && srcErrFieldTy ? this.enumPayloadPtr(lines, enumTy, enumAddr, srcErrVariant) : "";

      let finalErrPayload: string | null = null;
      let finalErrFieldTy: string | null = null;

      if (expr.boxConversion && srcErrFieldTy) {
        // Box the error and hand back a fat pointer { data, itable }: the same shape
        // genInterfaceCoerce builds for `Heap(e)` coerced to Heap<Iface>, done here
        // because the payload is loaded out of the operand's Err slot, not from an
        // expression. A string error is wrapped in the prelude `ErrorMessage` first.
        const srcPayload = this.nextTemp();
        lines.push(`  ${srcPayload} = load ${srcErrFieldTy}, ptr ${errPayloadPtr}`);
        finalErrPayload = this.emitBoxAsIface(lines, srcPayload, srcErrFieldTy, expr.boxConversion);
        finalErrFieldTy = "{ ptr, ptr }";
      } else if (expr.messageFn && srcErrFieldTy) {
        // `?` into a `Result<T, string>` fn: the error's message() is the string, and the
        // typed error itself is dropped here since nothing else will own it.
        const msgTy = this.llvmType({ tag: "string" });
        finalErrPayload = this.nextTemp();
        lines.push(`  ${finalErrPayload} = call ${msgTy} @${expr.messageFn.fn}(ptr ${errPayloadPtr})`);
        this.emitDropValue(lines, errPayloadPtr, expr.messageFn.errType);
        finalErrFieldTy = msgTy;
      } else if (expr.fromConversion && srcErrFieldTy) {
        // From conversion: wrap source err in target error enum variant
        const convEnumTy = `%${expr.fromConversion.targetEnumName}`;
        const srcPayload = this.nextTemp();
        lines.push(`  ${srcPayload} = load ${srcErrFieldTy}, ptr ${errPayloadPtr}`);
        const convAlloca = this.nextTemp();
        lines.push(`  ${convAlloca} = alloca ${convEnumTy}`);
        this.storeEnumTag(lines, convEnumTy, convAlloca, expr.fromConversion.wrapTag);
        const convPayloadPtr = this.enumPayloadPtr(lines, convEnumTy, convAlloca, expr.fromConversion.wrapTag);
        lines.push(`  store ${srcErrFieldTy} ${srcPayload}, ptr ${convPayloadPtr}`);
        finalErrPayload = this.nextTemp();
        lines.push(`  ${finalErrPayload} = load ${convEnumTy}, ptr ${convAlloca}`);
        finalErrFieldTy = convEnumTy;
      } else if (srcErrFieldTy) {
        // same E type, different T — just copy the Err payload
        finalErrPayload = this.nextTemp();
        lines.push(`  ${finalErrPayload} = load ${srcErrFieldTy}, ptr ${errPayloadPtr}`);
        finalErrFieldTy = srcErrFieldTy;
      }

      // construct caller's return Result with Err tag + payload
      const retEnumTy = `%${retEnumName}`;
      const retAlloca = this.nextTemp();
      lines.push(`  ${retAlloca} = alloca ${retEnumTy}`);
      const retLayout = must(this.enumLayouts, retEnumName, "enum layouts");
      const retErrVariant = retLayout.variants.get("Err") || retLayout.variants.get("None");
      const retErrTag = retErrVariant ? retErrVariant.tag : 1;
      this.storeEnumTag(lines, retEnumTy, retAlloca, retErrTag);
      if (finalErrPayload && finalErrFieldTy) {
        const retPayloadPtr = this.enumPayloadPtr(lines, retEnumTy, retAlloca, retErrTag);
        lines.push(`  store ${finalErrFieldTy} ${finalErrPayload}, ptr ${retPayloadPtr}`);
      }
      const retVal = this.nextTemp();
      lines.push(`  ${retVal} = load ${retEnumTy}, ptr ${retAlloca}`);
      // sret-lowered enclosing fn: write %__sret.out + ret void (see above).
      if (this.currentFnSret) {
        lines.push(`  store ${retEnumTy} ${retVal}, ptr %__sret.out`);
        lines.push("  ret void");
      } else {
        lines.push(`  ret ${retEnumTy} ${retVal}`);
      }
    }

    // ok branch — extract payload and zero source to prevent double-free
    lines.push(`${okLabel}:`);
    this.own.endVal(lines, ov, "MOVE");
    // `Result<void, E>` has no payload to extract, and LLVM rejects `load void` outright
    // ("void type only allowed for function results"), so a `Promise<void>` failed to
    // compile at the link step rather than anywhere a diagnostic could point at.
    if (resultTy === "void") return [lines, "", "void"];
    const payloadPtr = this.enumPayloadPtr(lines, enumTy, enumAddr, 0);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    return [lines, result, resultTy];
  }

  private genDefaultValue(expr: HIRExpr & { kind: "DefaultValue" }, lines: string[]): Gen {
    const [ol, ov] = this.genExpr(expr.operand);
    lines.push(...ol);

    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);

    // Merge via alloca+store, NOT a phi: the default expr may itself lower to
    // control flow (nested `??`, short-circuit, match-expr), so the block that
    // falls into doneLabel isn't necessarily noneLabel — a phi keyed on
    // noneLabel is invalid IR there. Allocas hoisted to entry (loop safety).
    const enumAddr = this.nextTemp();
    this.entryAllocas.push(`  ${enumAddr} = alloca ${enumTy}`);
    const resultAddr = this.nextTemp();
    this.entryAllocas.push(`  ${resultAddr} = alloca ${resultTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tag = this.loadEnumTag(lines, enumTy, enumAddr);

    const someLabel = this.nextLabel("default.some");
    const noneLabel = this.nextLabel("default.none");
    const doneLabel = this.nextLabel("default.done");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${someLabel}, label %${noneLabel}`);

    // some branch — extract payload and zero the source to prevent double-free
    lines.push(`${someLabel}:`);
    this.own.endVal(lines, ov, "MOVE");
    const payloadPtr = this.enumPayloadPtr(lines, enumTy, enumAddr, 0);
    const someVal = this.nextTemp();
    lines.push(`  ${someVal} = load ${resultTy}, ptr ${payloadPtr}`);
    // Zero the source variable's enum so drop glue won't free the moved payload
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    lines.push(`  store ${resultTy} ${someVal}, ptr ${resultAddr}`);
    lines.push(`  br label %${doneLabel}`);

    // none branch — use default. The default is moved into the result; zero its
    // source slot (mirroring the some branch) so the default variable's own
    // scope-end drop doesn't double-free the buffer now owned by the result. Only
    // this branch runs when the default is taken, so the Some path leaves the
    // default untouched and its normal drop still fires there.
    lines.push(`${noneLabel}:`);
    this.own.endVal(lines, ov, "MOVE");
    const [dl, dv] = this.genExpr(expr.default);
    lines.push(...dl);
    if (this.needsDropCg(expr.type) && expr.default.kind === "Ident") {
      const dstAddr = this.localAddr(expr.default.name);
      if (dstAddr) lines.push(`  store ${resultTy} zeroinitializer, ptr ${dstAddr}`);
    }
    lines.push(`  store ${resultTy} ${dv}, ptr ${resultAddr}`);
    this.own.endVal(lines, dv, "MOVE");
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${resultAddr}`);
    return [lines, result, resultTy];
  }

  private genShortCircuit(expr: HIRExpr & { kind: "BinOp" }, lines: string[]): Gen {
    const isAnd = expr.op === "&&";
    const resultAddr = this.nextTemp();
    // Hoist to entry block — alloca in loop body grows stack each iteration → overflow.
    this.entryAllocas.push(`  ${resultAddr} = alloca i1`);
    const [ll, lv] = this.genExpr(expr.left);
    lines.push(...ll);
    lines.push(`  store i1 ${lv}, ptr ${resultAddr}`);
    const rhsLabel = this.nextLabel(isAnd ? "and.rhs" : "or.rhs");
    const endLabel = this.nextLabel(isAnd ? "and.end" : "or.end");
    if (isAnd) {
      lines.push(`  br i1 ${lv}, label %${rhsLabel}, label %${endLabel}`);
    } else {
      lines.push(`  br i1 ${lv}, label %${endLabel}, label %${rhsLabel}`);
    }
    lines.push(`${rhsLabel}:`);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...rl);
    lines.push(`  store i1 ${rv}, ptr ${resultAddr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
    return [lines, result, "i1"];
  }

  private genCast(expr: HIRExpr & { kind: "Cast" }, lines: string[]): Gen {
    const fromKind = expr.operand.type;
    const toKind = expr.targetType;
    const toTy = this.llvmType(expr.targetType);
    // array → ptr: decay to pointer (use alloca address directly)
    if (fromKind.tag === "array" && toKind.tag === "ptr") {
      const [al, addr] = this.genLValue(expr.operand);
      lines.push(...al);
      return [lines, addr, toTy];
    }
    // string → ptr: extract data pointer from String struct
    if (fromKind.tag === "string" && toKind.tag === "ptr") {
      this.hasStringType = true;
      const [ol, ov] = this.genExpr(expr.operand);
      lines.push(...ol);
      const addr = this.nextTemp();
      lines.push(`  ${addr} = alloca %String`);
      lines.push(`  store %String ${ov}, ptr ${addr}`);
      const gep = this.nextTemp();
      lines.push(`  ${gep} = getelementptr %String, ptr ${addr}, i32 0, i32 0`);
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = load ptr, ptr ${gep}`);
      return [lines, dataPtr, "ptr"];
    }
    // fn → ptr: get raw function pointer (bypass closure trampoline for known functions)
    if (fromKind.tag === "fn" && toKind.tag === "ptr") {
      if (expr.operand.kind === "Ident") {
        const fnName = (expr.operand as any).name;
        if (this.fnSigs.has(fnName)) {
          return [lines, `@${fnName}`, "ptr"];
        }
      }
      // parameter or closure: extract fn ptr from closure tuple
      const [ol, ov] = this.genExpr(expr.operand);
      lines.push(...ol);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = extractvalue { ptr, ptr } ${ov}, 0`);
      return [lines, tmp, "ptr"];
    }
    // repr'd enum → integer: the value is its discriminant, held in the tag field.
    if (fromKind.tag === "enum" && toKind.tag === "int") {
      const [ol, ov] = this.genExpr(expr.operand);
      lines.push(...ol);
      const tag = this.nextTemp();
      lines.push(`  ${tag} = extractvalue ${this.llvmType(fromKind)} ${ov}, 0`);
      if (toKind.bits === 32) return [lines, tag, "i32"];
      const out = this.nextTemp();
      // tag is a signed i32 — sext to a wider target (carries negative discriminants), trunc to a narrower one.
      lines.push(`  ${out} = ${toKind.bits > 32 ? "sext" : "trunc"} i32 ${tag} to ${toTy}`);
      return [lines, out, toTy];
    }
    // aggregate types (arrays, structs) can't participate in scalar casts
    if (fromKind.tag === "array" || fromKind.tag === "struct") {
      const [ol, ov, fromTy] = this.genExpr(expr.operand);
      lines.push(...ol);
      return [lines, ov, fromTy];
    }
    const [ol, ov, fromTy] = this.genExpr(expr.operand);
    lines.push(...ol);
    if (fromTy === toTy) return [lines, ov, toTy];
    const tmp = this.nextTemp();
    const fromFloat = fromKind.tag === "float";
    const toFloat = toKind.tag === "float";
    // `cfn` is a bare code pointer, so it converts to an integer the same way a data
    // pointer does. This is the path `isNull(s.field)` lowers to.
    if ((fromKind.tag === "ptr" || fromKind.tag === "cfn") && (toKind.tag === "int" || toKind.tag === "bool")) {
      lines.push(`  ${tmp} = ptrtoint ${fromTy} ${ov} to ${toTy}`);
    } else if ((fromKind.tag === "int" || fromKind.tag === "bool") && toKind.tag === "ptr") {
      // Pointers are 64-bit; inttoptr from a narrower int (e.g. `0 as *u8` where
      // the literal defaults to i32) crashes AArch64 ISel. Widen to i64 first.
      const fromBits = this.bitWidth(fromKind);
      let intVal = ov;
      let intTy = fromTy;
      if (fromBits < 64) {
        const wide = this.nextTemp();
        const ext = fromKind.tag === "int" && fromKind.signed ? "sext" : "zext";
        lines.push(`  ${wide} = ${ext} ${fromTy} ${ov} to i64`);
        intVal = wide;
        intTy = "i64";
      }
      lines.push(`  ${tmp} = inttoptr ${intTy} ${intVal} to ${toTy}`);
    } else if (fromFloat && toFloat) {
      const op = this.bitWidth(toKind) > this.bitWidth(fromKind) ? "fpext" : "fptrunc";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else if (fromFloat) {
      // Raw fptosi/fptoui is poison (UB) when the value doesn't fit the target or is NaN.
      // Use LLVM's saturating variants instead: out-of-range clamps to the target's
      // min/max and NaN → 0, so the cast is total and defined for every input (matches
      // Rust's post-1.45 `as` semantics). fromTy is "float"/"double" → f32/f64 suffix.
      const op = toKind.tag === "int" && !toKind.signed ? "fptoui" : "fptosi";
      const fpSuffix = fromTy === "double" ? "f64" : "f32";
      const intrinsic = `@llvm.${op}.sat.${toTy}.${fpSuffix}`;
      this.fpSatIntrinsics.add(`declare ${toTy} ${intrinsic}(${fromTy})`);
      lines.push(`  ${tmp} = call ${toTy} ${intrinsic}(${fromTy} ${ov})`);
    } else if (toFloat) {
      const op = fromKind.tag === "int" && !fromKind.signed ? "uitofp" : "sitofp";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else {
      const fromBits = this.bitWidth(fromKind);
      const toBits = this.bitWidth(toKind);
      if (toBits > fromBits) {
        const op = fromKind.tag === "bool" || (fromKind.tag === "int" && !fromKind.signed) ? "zext" : "sext";
        lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
      } else {
        lines.push(`  ${tmp} = trunc ${fromTy} ${ov} to ${toTy}`);
      }
    }
    return [lines, tmp, toTy];
  }

  private bitWidth(t: TypeKind): number {
    if (t.tag === "int") return t.bits;
    if (t.tag === "float") return t.bits;
    if (t.tag === "bool") return 1;
    return 64;
  }

  // In-place append into the String at `tgtPtr` (an alloca holding a %String).
  // Used to turn `x = x + rhs` into amortized-O(1) growth instead of fresh malloc each time.
  // It is pushStr: the receiver is made unique before the write, and an rhs that points
  // into x's own buffer (a view of x) is re-based across the grow rather than read after
  // the old block is gone.
  private emitStringAppendInPlace(lines: string[], tgtPtr: string, rhsVal: string): void {
    this.emitAppendFormatParts(lines, tgtPtr, [{ val: rhsVal, ty: "%String", tk: { tag: "string" } }]);
  }

  private genStringIndex(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsBoundsCheck = true;
    // `v[i][j]` reads the string header in place. Going through genExpr would clone the
    // element (a Vec index hands out an independent value) only to read one byte out of
    // it, and that clone was never freed: one leaked allocation per evaluation.
    const tempMark = this.argTempDrops.length;
    let ov: string;
    const inPlace = this.indexAccessClones(expr.object) && expr.object.kind === "IndexAccess";
    if (inPlace) {
      const inner = expr.object as HIRExpr & { kind: "IndexAccess" };
      const innerObj = inner.object.type.tag === "ref" ? inner.object.type.inner : inner.object.type;
      const [, elemPtr] = innerObj.tag === "vec" || (innerObj.tag === "array" && innerObj.size === null)
        ? this.genVecBoundsCheckedPtr(inner, lines)
        : this.genBoundsCheckedPtr(inner, lines);
      ov = this.nextTemp();
      lines.push(`  ${ov} = load %String, ptr ${elemPtr}`);
    } else {
      const [ol, objVal] = this.genExpr(expr.object);
      lines.push(...ol);
      ov = objVal;
    }
    const [il, iv, idxTy] = this.genExpr(expr.index);
    lines.push(...il);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
    const idx64 = this.indexToI64(lines, iv, idxTy, expr.index.type);
    this.emitBoundsCheck(lines, idx64, len, expr.span);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${ov}, 0`);
    const bytePtr = this.nextTemp();
    lines.push(`  ${bytePtr} = getelementptr i8, ptr ${data}, i64 ${idx64}`);
    const byte = this.nextTemp();
    lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
    if (inPlace) this.flushArgTempDrops(lines, tempMark);
    // `mk()[i]` reads a byte out of a string nobody owns.
    else this.dropOwnedTemp(lines, ov, "%String", expr.object);
    return [lines, byte, "i8"];
  }

  // `ownedTemps`, when supplied, collects receivers that had to be materialised into an
  // alloca because they are rvalues nobody owns (`makeRes().id`). The caller drops them
  // AFTER it has read the field; dropping here would free the struct out from under the
  // load. Without this the temporary's destructor never ran at all.
  private genFieldPtr(expr: HIRExpr & { kind: "FieldAccess" }, ownedTemps?: { addr: string; type: TypeKind }[]): Gen {
    const lines: string[] = [];
    // pointer-to-struct: load the ptr value, GEP into the pointed-to struct
    if (expr.object.type.tag === "ptr" && expr.object.type.inner.tag === "struct") {
      const [objLines, objVal] = this.genExpr(expr.object);
      lines.push(...objLines);
      const structName = expr.object.type.inner.name;
      const layout = must(this.structLayouts, structName, "struct layouts");
      const idx = layout.fields.findIndex(f => f.name === expr.field);
      const fieldTy = layout.fields[idx].type;
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr %${structName}, ptr ${objVal}, i32 0, i32 ${idx}`);
      return [lines, ptr, fieldTy];
    }
    const [objLines, objPtr, objTy] = this.genLValue(expr.object);
    lines.push(...objLines);
    let finalPtr = objPtr;
    let finalTy = objTy;
    // genLValue returns null for rvalues (e.g. function call returns) — materialize to alloca
    if (objPtr === "null") {
      const [exprLines, exprVal, exprTy] = this.genExpr(expr.object);
      lines.push(...exprLines);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = alloca ${exprTy}`);
      lines.push(`  store ${exprTy} ${exprVal}, ptr ${tmp}`);
      this.own.valToSlot(exprVal, tmp);
      finalPtr = tmp;
      finalTy = exprTy;
      if (ownedTemps && this.isOwnedTempExpr(expr.object) && this.needsDropCg(expr.object.type)) {
        ownedTemps.push({ addr: tmp, type: expr.object.type });
      }
    }
    const structName = this.getStructName(finalTy);
    if (structName) {
      const layout = must(this.structLayouts, structName, "struct layouts");
      const idx = layout.fields.findIndex(f => f.name === expr.field);
      const fieldTy = layout.fields[idx].type;
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr %${structName}, ptr ${finalPtr}, i32 0, i32 ${idx}`);
      return [lines, ptr, fieldTy];
    }
    return [lines, "null", "i32"];
  }

  private genLValueForArg(expr: HIRExpr): [string[], string] {
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        const lines: string[] = [];
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ptr, ptr ${this.localAddr(expr.name)}`);
        return [lines, tmp];
      }
      return [[], this.localAddr(expr.name)];
    }
    // A field of a temporary has no place to point at once the receiver is gone: it takes
    // the generic path below, which owns the value and drops it after the call.
    if (expr.kind === "FieldAccess" && !this.receiverIsRvalueTemp(expr)) {
      const [lines, ptr] = this.genFieldPtr(expr);
      return [lines, ptr];
    }
    if (expr.kind === "IndexAccess") {
      const lines: string[] = [];
      const [lv, ptr] = this.genLValue(expr);
      lines.push(...lv);
      return [lines, ptr];
    }
    // `*h` in an auto-borrowed argument position: the callee wants the address of
    // the pointee, which is exactly the pointer `h` already holds. Falling through
    // to genExpr() would *load* the value and, for HeapDeref, zero the source box
    // as if this were a move — freeing data the caller still owns.
    if ((expr.kind === "HeapDeref" && !this.isTempBoxDeref(expr)) || expr.kind === "PtrDeref") {
      const [lines, ptr] = this.genExpr(expr.operand);
      return [lines, ptr];
    }
    const lines: string[] = [];
    const [el, ev, et] = this.genExpr(expr);
    lines.push(...el);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${et}`);
    lines.push(`  store ${et} ${ev}, ptr ${tmp}`);
    if (this.isOwnedTempExpr(expr) && this.needsDropCg(expr.type)) {
      this.own.valToSlot(ev, tmp);
      this.argTempDrops.push({ addr: tmp, type: expr.type });
      this.unpend(ev);
    }
    return [lines, tmp];
  }

  // `let x = *h` on a box whose payload has a Drop: load the payload, free the box and
  // null the box's slot, so the box's own drop (scope exit, or the drop before a
  // reassignment) finds null and does nothing. Zeroing the payload in place instead left
  // a live box whose drop ran the payload's Drop on the zeroed leftover (`drop 0`); a
  // zero is not "nothing" for a user Drop. Only a place operand has a slot to null; the
  // checker has recorded the move of that place, so nothing reads it before a reassign.
  // A box returned by a call (`*mk()`) or built in place (`*Heap(x)`) is owned by nobody
  // else, so it is freed here too;
  // it used to leak. Returns null for any other operand, which keeps the zeroing path.
  private genHeapMoveOut(expr: HIRExpr & { kind: "HeapDeref" }, lines: string[]): Gen | null {
    const op = expr.operand;
    if (op.type.tag !== "heap" || op.type.inner.tag === "interface") return null;
    const innerTy = this.llvmType(expr.type);
    if (op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "InterfaceMethodCall" || op.kind === "HeapCreate") {
      const [opLines, box] = this.genExpr(op);
      lines.push(...opLines);
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${innerTy}, ptr ${box}`);
      this.needsFree = true;
      lines.push(`  call void @free(ptr ${box})`);
      // the payload left as the deref's (moved) value; the box itself ends here
      this.own.endVal(lines, box, "DROP");
      return [lines, val, innerTy];
    }
    if (!this.needsDropCg(expr.type)) return null;
    if (op.kind === "Ident") {
      const local = this.locals.get(op.name);
      if (!local || local.isRef) return null;
    } else if (op.kind !== "FieldAccess" || this.receiverIsRvalueTemp(op)) {
      return null;
    }
    const [slotLines, slot] = this.genLValue(op);
    if (slot === "null") return null;
    lines.push(...slotLines);
    const box = this.nextTemp();
    lines.push(`  ${box} = load ptr, ptr ${slot}`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${innerTy}, ptr ${box}`);
    this.needsFree = true;
    lines.push(`  call void @free(ptr ${box})`);
    lines.push(`  store ptr null, ptr ${slot}`);
    return [lines, val, innerTy];
  }

  private vecInitialCap(elemSize: number): number { return Math.max(1, Math.min(8, Math.floor(64 / Math.max(1, elemSize)))); }

  private genVecPush(expr: HIRExpr & { kind: "VecPush" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    const vecType = expr.vec.type;
    if (vecType.tag !== "vec") throw new Error("VecPush on non-vec type");
    const elemSize = this.typeSizeOf(vecType.element);
    const elemTy = this.llvmType(vecType.element);

    // get pointer to the vec struct
    const [vecPtrLines, vecPtr] = this.genLValue(expr.vec);
    lines.push(...vecPtrLines);

    // generate the value to push
    const [valLines, valVal, valTy] = this.genExpr(expr.value);
    lines.push(...valLines);

    // load len and cap
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    // check if len >= cap (need to grow)
    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp uge i64 ${len}, ${cap}`);
    const growLabel = this.nextLabel("vec.grow");
    const pushLabel = this.nextLabel("vec.push");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${pushLabel}`);

    // grow: new_cap = cap == 0 ? initialCap : cap * 2
    // The first allocation is sized in BYTES, not elements: a flat 8 elements
    // costs 64 bytes for a Vec<i64> but 1 KB for a Vec of 128-byte structs, and
    // an object with one property paid that full kilobyte (milojs: ~1 KB per
    // property, measured). Cap the first allocation near 64 bytes instead.
    const initialCap = this.vecInitialCap(elemSize);
    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const newCap = this.nextTemp();
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 ${initialCap}, i64 ${doubled}`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const keepBytes = this.nextTemp();
    lines.push(`  ${keepBytes} = mul i64 ${len}, ${elemSize}`);
    const newBuf = this.emitGrowBytes(lines, oldBuf, keepBytes, newCap, elemSize, "vecgrow", expr.span);
    const storeLabel = this.nextLabel("vec.store");
    lines.push(`  br label %${storeLabel}`);

    // store new buf, cap
    lines.push(`${storeLabel}:`);
    const dataPtr2 = this.nextTemp();
    lines.push(`  ${dataPtr2} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr2}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${pushLabel}`);

    // push: store value at data[len], len++
    lines.push(`${pushLabel}:`);
    const curDataPtr = this.nextTemp();
    lines.push(`  ${curDataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${curDataPtr}`);
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${curData}, i64 ${curLen}`);
    lines.push(`  store ${valTy} ${valVal}, ptr ${elemPtr}`);
    this.own.endVal(lines, valVal, "STORE");
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, "void", "void"];
  }

  // What to hand a Vec combinator's callback for one element.
  //
  // Every combinator hints `&T`, but the checker deliberately lets a closure declare a
  // COPY T by value (see checkCallbackSig). Codegen has to honour that or the closure
  // receives a POINTER where it declared an integer: `each((x: i64) => print(x))` printed
  // raw addresses, `filter((x: i64): bool => x > 1)` kept every element because a heap
  // pointer is greater than 1, and `retain((x: i64): bool => x % 2 == 0)` kept every
  // element because a heap pointer is even. genVecMap had this right and eight sibling
  // sites did not — the same idiom, present in one copy and missing from the rest.
  //
  // `paramIdx` because the element is not always the first argument: fold takes the
  // accumulator first, eachIndexed the index.
  callbackElemArg(
    lines: string[],
    cbType: TypeKind,
    elemPtr: string,
    elemTy: string,
    paramIdx = 0,
  ): { arg: string; argTy: string } {
    const p = cbType.tag === "fn" ? cbType.params[paramIdx] : undefined;
    // Unknown/missing means the checker already reported it; pass the pointer as before
    // rather than inventing a load on a type we cannot name.
    if (!p || p.tag === "ref" || p.tag === "unknown") return { arg: elemPtr, argTy: "ptr" };
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${elemTy}, ptr ${elemPtr}`);
    return { arg: loaded, argTy: elemTy };
  }

  // v.sum() — accumulate all elements. Integer addition follows the enclosing function's
  // normal checked/wrapping policy; floats use fadd. Empty vec sums to 0.
  private genVecSum(expr: HIRExpr & { kind: "VecSum" }, lines: string[]): Gen {
    this.hasVecType = true;
    const [vl, vv] = this.genExpr(expr.vec);
    lines.push(...vl);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
    const elemTy = this.llvmType(expr.elementType);
    const isFloat = expr.elementType.tag === "float";
    const accAddr = `%__sum_acc.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${accAddr} = alloca ${elemTy}`);
    lines.push(`  store ${elemTy} ${isFloat ? "0.0" : "0"}, ptr ${accAddr}`);
    const idxAddr = `%__sum_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("sum.cond");
    const bodyLabel = this.nextLabel("sum.body");
    const endLabel = this.nextLabel("sum.end");
    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const idx = this.nextTemp();
    lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx}`);
    const elem = this.nextTemp();
    lines.push(`  ${elem} = load ${elemTy}, ptr ${elemPtr}`);
    const acc = this.nextTemp();
    lines.push(`  ${acc} = load ${elemTy}, ptr ${accAddr}`);
    let newAcc: string;
    if (!isFloat && this.trapOnOverflow && !this.currentFnWrapping) {
      newAcc = this.emitCheckedArith(lines, "add", this.isUnsigned(expr.elementType), elemTy, acc, elem, expr.span);
    } else {
      newAcc = this.nextTemp();
      lines.push(`  ${newAcc} = ${isFloat ? "fadd" : "add"} ${elemTy} ${acc}, ${elem}`);
    }
    lines.push(`  store ${elemTy} ${newAcc}, ptr ${accAddr}`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${elemTy}, ptr ${accAddr}`);
    // A temporary receiver is dead once the scan is done; the result is a scalar or a clone.
    this.dropOwnedTemp(lines, vv, "%Vec", expr.vec);
    return [lines, result, elemTy];
  }

  // `v.truncate(n)` / `v.clear()`. Elements at index >= n are OWNED by the Vec, so
  // shortening the length without running their drop glue would leak every string,
  // nested Vec or Drop-implementing struct above the cut. The counter lives in an
  // alloca rather than a phi because emitDropValue splits the block.
  private genVecTruncate(expr: HIRExpr & { kind: "VecTruncate" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemType = expr.elementType;
    const elemTy = this.llvmType(elemType);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);
    const [nLines, nRaw] = this.genExpr(expr.length);
    lines.push(...nLines);

    // A negative length means empty; a length past the end is a no-op, never a grow.
    const isNeg = this.nextTemp();
    lines.push(`  ${isNeg} = icmp slt i64 ${nRaw}, 0`);
    const n = this.nextTemp();
    lines.push(`  ${n} = select i1 ${isNeg}, i64 0, i64 ${nRaw}`);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    const doneLabel = this.nextLabel("vec.trunc.done");
    const startLabel = this.nextLabel("vec.trunc.start");
    const noop = this.nextTemp();
    lines.push(`  ${noop} = icmp uge i64 ${n}, ${len}`);
    lines.push(`  br i1 ${noop}, label %${doneLabel}, label %${startLabel}`);
    lines.push(`${startLabel}:`);

    if (this.needsDropCg(elemType)) {
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
      const data = this.nextTemp();
      lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);

      const iAddr = `%__trunc_i.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 ${n}, ptr ${iAddr}`);

      const condLabel = this.nextLabel("vec.trunc.cond");
      const bodyLabel = this.nextLabel("vec.trunc.body");
      const finLabel = this.nextLabel("vec.trunc.fin");
      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const i = this.nextTemp();
      lines.push(`  ${i} = load i64, ptr ${iAddr}`);
      const cont = this.nextTemp();
      lines.push(`  ${cont} = icmp ult i64 ${i}, ${len}`);
      lines.push(`  br i1 ${cont}, label %${bodyLabel}, label %${finLabel}`);

      lines.push(`${bodyLabel}:`);
      const elemPtr = this.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
      this.emitDropValue(lines, elemPtr, elemType);
      const iNow = this.nextTemp();
      lines.push(`  ${iNow} = load i64, ptr ${iAddr}`);
      const iNext = this.nextTemp();
      lines.push(`  ${iNext} = add i64 ${iNow}, 1`);
      lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${finLabel}:`);
    }

    lines.push(`  store i64 ${n}, ptr ${lenPtr}`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${doneLabel}:`);
    return [lines, "void", "void"];
  }

  private genVecSwap(expr: HIRExpr & { kind: "VecSwap" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMemcpy = true;
    const elemType = expr.elementType;
    const elemSize = this.typeSizeOf(elemType);
    const elemTy = this.llvmType(elemType);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);

    const aVal = this.genBoundI64(expr.indexA, lines);
    const bVal = this.genBoundI64(expr.indexB, lines);

    // Both indices are bounds-checked. This GEP'd straight into the buffer and memcpy'd
    // three times with no length load at all, so `v.swap(0, 999999)` was an out-of-bounds
    // read AND write from safe code that exited 0. Every other indexed Vec operation
    // checks; this one was simply missed.
    const lenPtrB = this.nextTemp();
    lines.push(`  ${lenPtrB} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const lenB = this.nextTemp();
    lines.push(`  ${lenB} = load i64, ptr ${lenPtrB}`);
    for (const idx of [aVal, bVal]) this.emitBoundsCheck(lines, idx, lenB, expr.span);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);

    const ptrA = this.nextTemp();
    lines.push(`  ${ptrA} = getelementptr ${elemTy}, ptr ${data}, i64 ${aVal}`);
    const ptrB = this.nextTemp();
    lines.push(`  ${ptrB} = getelementptr ${elemTy}, ptr ${data}, i64 ${bVal}`);

    const tmpAddr = `%__swap_tmp.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${tmpAddr} = alloca ${elemTy}`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${ptrA}, i64 ${elemSize}, i1 false)`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${ptrA}, ptr ${ptrB}, i64 ${elemSize}, i1 false)`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${ptrB}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);

    return [lines, "void", "void"];
  }

  private genVecInsert(expr: HIRExpr & { kind: "VecInsert" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;
    this.needsDprintf = true;
    this.needsExit = true;

    const elemSize = this.typeSizeOf(expr.elementType);
    const elemTy = this.llvmType(expr.elementType);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);
    const [idxLines, idxVal] = this.genExpr(expr.index);
    lines.push(...idxLines);
    const [valLines, valVal, valTy] = this.genExpr(expr.value);
    lines.push(...valLines);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    // bounds: index must be <= len (== len means append)
    const oob = this.nextTemp();
    lines.push(`  ${oob} = icmp ugt i64 ${idxVal}, ${len}`);
    const panicLabel = this.nextLabel("vec.insert.panic");
    const growCheck = this.nextLabel("vec.insert.growcheck");
    lines.push(`  br i1 ${oob}, label %${panicLabel}, label %${growCheck}`);

    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const { label: errLabel, length: errLen } = this.addString(`insert index out of bounds at ${this.panicAt(span)}\n`);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, "");
    this.panicAbort(lines);
    lines.push(`  unreachable`);

    // grow if len >= cap (we are adding one element) — identical policy to push
    lines.push(`${growCheck}:`);
    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp uge i64 ${len}, ${cap}`);
    const growLabel = this.nextLabel("vec.insert.grow");
    const shiftLabel = this.nextLabel("vec.insert.shift");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${shiftLabel}`);

    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 ${this.vecInitialCap(elemSize)}, i64 ${doubled}`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const keepBytes = this.nextTemp();
    lines.push(`  ${keepBytes} = mul i64 ${len}, ${elemSize}`);
    const newBuf = this.emitGrowBytes(lines, oldBuf, keepBytes, newCap, elemSize, "vecgrow2", expr.span);
    const storeLabel = this.nextLabel("vec.insert.store");
    lines.push(`  br label %${storeLabel}`);
    lines.push(`${storeLabel}:`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${shiftLabel}`);

    // shift [index, len) right by one, then store value at index, len++
    lines.push(`${shiftLabel}:`);
    const curDataPtr = this.nextTemp();
    lines.push(`  ${curDataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${curDataPtr}`);
    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = getelementptr ${elemTy}, ptr ${curData}, i64 ${idxVal}`);
    const idxPlus1 = this.nextTemp();
    lines.push(`  ${idxPlus1} = add i64 ${idxVal}, 1`);
    const dstPtr = this.nextTemp();
    lines.push(`  ${dstPtr} = getelementptr ${elemTy}, ptr ${curData}, i64 ${idxPlus1}`);
    const tailCount = this.nextTemp();
    lines.push(`  ${tailCount} = sub i64 ${len}, ${idxVal}`);
    const tailBytes = this.nextTemp();
    lines.push(`  ${tailBytes} = mul i64 ${tailCount}, ${elemSize}`);
    lines.push(`  call void @llvm.memmove.p0.p0.i64(ptr ${dstPtr}, ptr ${srcPtr}, i64 ${tailBytes}, i1 false)`);
    lines.push(`  store ${valTy} ${valVal}, ptr ${srcPtr}`);
    this.own.endVal(lines, valVal, "STORE");
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${len}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, "void", "void"];
  }

  private genVecRemove(expr: HIRExpr & { kind: "VecRemove" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsDprintf = true;
    this.needsExit = true;

    const elemSize = this.typeSizeOf(expr.elementType);
    const elemTy = this.llvmType(expr.elementType);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);
    const [idxLines, idxVal] = this.genExpr(expr.index);
    lines.push(...idxLines);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    // bounds: index must be < len
    const oob = this.nextTemp();
    lines.push(`  ${oob} = icmp uge i64 ${idxVal}, ${len}`);
    const panicLabel = this.nextLabel("vec.remove.panic");
    const okLabel = this.nextLabel("vec.remove.ok");
    lines.push(`  br i1 ${oob}, label %${panicLabel}, label %${okLabel}`);

    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const { label: errLabel, length: errLen } = this.addString(`remove index out of bounds at ${this.panicAt(span)}\n`);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, "");
    this.panicAbort(lines);
    lines.push(`  unreachable`);

    lines.push(`${okLabel}:`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idxVal}`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${elemPtr}`);

    // shift [index+1, len) left by one
    const idxPlus1 = this.nextTemp();
    lines.push(`  ${idxPlus1} = add i64 ${idxVal}, 1`);
    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idxPlus1}`);
    const tailCount = this.nextTemp();
    lines.push(`  ${tailCount} = sub i64 ${len}, ${idxPlus1}`);
    const tailBytes = this.nextTemp();
    lines.push(`  ${tailBytes} = mul i64 ${tailCount}, ${elemSize}`);
    lines.push(`  call void @llvm.memmove.p0.p0.i64(ptr ${elemPtr}, ptr ${srcPtr}, i64 ${tailBytes}, i1 false)`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${len}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, val, elemTy];
  }

  private genVecContains(expr: HIRExpr & { kind: "VecContains" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemType = expr.elementType;
    const elemTy = this.llvmType(elemType);

    const [vecLines, vecVal] = this.genExpr(expr.vec);
    lines.push(...vecLines);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vecVal}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vecVal}, 1`);

    const [valLines, valVal, valLt] = this.genExpr(expr.value);
    lines.push(...valLines);

    const resultAddr = `%__contains_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca i1`);
    lines.push(`  store i1 false, ptr ${resultAddr}`);

    const idxAddr = `%__contains_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("contains.cond");
    const bodyLabel = this.nextLabel("contains.body");
    const foundLabel = this.nextLabel("contains.found");
    const nextLabel = this.nextLabel("contains.next");
    const endLabel = this.nextLabel("contains.end");

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const idx = this.nextTemp();
    lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);

    lines.push(`${bodyLabel}:`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx}`);

    if (elemType.tag === "string") {
      this.needsMemcmp = true;
      const elemVal = this.nextTemp();
      lines.push(`  ${elemVal} = load %String, ptr ${elemPtr}`);
      const [, cmpResult] = genStringCmp(this, lines, elemVal, valVal, true);
      lines.push(`  br i1 ${cmpResult}, label %${foundLabel}, label %${nextLabel}`);
    } else {
      const elemVal = this.nextTemp();
      lines.push(`  ${elemVal} = load ${valLt}, ptr ${elemPtr}`);
      const eq = this.nextTemp();
      if (elemType.tag === "float") {
        lines.push(`  ${eq} = fcmp oeq ${valLt} ${elemVal}, ${valVal}`);
      } else {
        lines.push(`  ${eq} = icmp eq ${valLt} ${elemVal}, ${valVal}`);
      }
      lines.push(`  br i1 ${eq}, label %${foundLabel}, label %${nextLabel}`);
    }

    lines.push(`${foundLabel}:`);
    lines.push(`  store i1 true, ptr ${resultAddr}`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${nextLabel}:`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
    // Same as the map lookups: the needle is the caller's, and a read-only search takes
    // no ownership of it. `v.contains("s" + i.toString())` leaked the needle per call.
    this.dropOwnedTemp(lines, valVal, valLt, expr.value);
    // …and the receiver, when that is a temporary: `mkVec().contains(x)` leaked the whole
    // container. A search keeps no pointer into it once the answer is a scalar.
    this.dropOwnedTemp(lines, vecVal, "%Vec", expr.vec);
    return [lines, result, "i1"];
  }

  // The one place a heap buffer is sized and allocated. `count * elemSize` was written
  // longhand at 15 sites and not one of them checked the product, so any site reachable
  // with a user-controlled count under-allocated on overflow (malloc got the wrapped byte
  // count while the capacity field kept the huge one) and every later write ran past the
  // buffer. `v.reserve(2305843009213693952)` did it from safe code.
  //
  // Both checks live here rather than at the call sites for the reason placesOf exists: a
  // rule restated per site is a rule the next site forgets. tests/allocChokePoint.test.ts
  // holds `call ptr @malloc` to this function.
  // A %String's bytes as a C string for one call. An owned string (cap > 0) keeps its NUL
  // at [len] and is passed as is. A cap-0 one is a literal held in a variable or a view,
  // and a view has no NUL of its own, so it is copied into a NUL-terminated block. The
  // copy is recorded as an owned %String in a temp slot (zeroed, so dropping it is a no-op,
  // when nothing was copied) and dropped after the call like any argument temporary.
  // `keep` (a callee that holds the pointer past the call, such as setvbuf) leaks it
  // instead, since freeing it would leave the callee a dangling pointer.
  private emitCStringArg(lines: string[], str: string, keep: boolean): string {
    this.needsMemcpy = true;
    const ptrSlot = `%__cstrarg.${this.scopeCounter++}.addr`;
    const ownSlot = `%__cstrarg.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${ptrSlot} = alloca ptr`, `  ${ownSlot} = alloca %String`);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${str}, 0`);
    lines.push(`  store ptr ${data}, ptr ${ptrSlot}`);
    lines.push(`  store %String zeroinitializer, ptr ${ownSlot}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = extractvalue %String ${str}, 2`);
    const isView = this.nextTemp();
    lines.push(`  ${isView} = icmp eq i64 ${cap}, 0`);
    const copyL = this.nextLabel("cstrarg.copy");
    const doneL = this.nextLabel("cstrarg.done");
    lines.push(`  br i1 ${isView}, label %${copyL}, label %${doneL}`);
    lines.push(`${copyL}:`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${str}, 1`);
    const owned = this.emitStrFrom(lines, data, len);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = extractvalue %String ${owned}, 0`);
    lines.push(`  store ptr ${buf}, ptr ${ptrSlot}`);
    lines.push(`  store %String ${owned}, ptr ${ownSlot}`);
    lines.push(`  br label %${doneL}`);
    lines.push(`${doneL}:`);
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = load ptr, ptr ${ptrSlot}`);
    if (!keep) this.argTempDrops.push({ addr: ownSlot, type: { tag: "string" } });
    return ptr;
  }

  // Before a string's bytes go to C as *u8 (an extern argument, cstr()): C may write
  // through the pointer, so a string this code owns outright is made the only handle to
  // its buffer (a copy only when the count says it is shared), or the write would reach
  // every other handle. Only a place rooted at an owned local: a &string borrow or a
  // global stays as is, since swapping its buffer would write through a shared borrow
  // (and race a reader on another thread); the bytes C gets there are read-only. An
  // index step is skipped too, since evaluating the place twice would repeat its side
  // effects. Owned temporaries are handled at the call (their slot is made unique).
  private emitCStrUniquePlace(expr: HIRExpr, lines: string[]): void {
    if (expr.type.tag !== "string" || !this.isOwnedLocalPlace(expr)) return;
    const [al, addr] = this.genLValueForArg(expr);
    lines.push(...al);
    this.emitStrUnique(lines, addr);
  }

  private isOwnedLocalPlace(expr: HIRExpr): boolean {
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      return !!local && !local.isRef;
    }
    if (expr.kind === "FieldAccess") {
      return expr.object.type.tag === "struct" && this.isOwnedLocalPlace(expr.object);
    }
    return false;
  }

  public emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string } {
    this.needsMalloc = true;
    const bytes = this.emitByteCount(lines, count, elemSize, tag, span);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bytes})`);
    this.emitAllocNullCheck(lines, buf, tag, span);
    return { buf, bytes };
  }

  // count * elemSize, aborting on overflow rather than allocating a wrapped size.
  private emitByteCount(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): string {
    const bothConst = /^\d+$/.test(String(count)) && /^\d+$/.test(String(elemSize));
    if (bothConst) {
      // A product of two literals is folded here; it cannot overflow at runtime.
      return String(BigInt(String(count)) * BigInt(String(elemSize)));
    }
    if (String(elemSize) === "1") return String(count);
    this.needsOverflowCheck = true;
    const intrinsic = "@llvm.umul.with.overflow.i64";
    this.usedOverflowIntrinsics.add(`declare {i64, i1} ${intrinsic}(i64, i64)`);
    const res = this.nextTemp();
    lines.push(`  ${res} = call {i64, i1} ${intrinsic}(i64 ${count}, i64 ${elemSize})`);
    const prod = this.nextTemp();
    lines.push(`  ${prod} = extractvalue {i64, i1} ${res}, 0`);
    const ovf = this.nextTemp();
    lines.push(`  ${ovf} = extractvalue {i64, i1} ${res}, 1`);
    const ok = this.nextLabel(`${tag}.szok`);
    const bad = this.nextLabel(`${tag}.szovf`);
    lines.push(`  br i1 ${ovf}, label %${bad}, label %${ok}`);
    lines.push(`${bad}:`);
    const fp = this.emitCheckFilePtr(lines, span);
    lines.push(`  call void @__milo_overflow_fail(ptr ${fp}, i32 ${span?.line ?? 0})`);
    lines.push(`  unreachable`);
    lines.push(`${ok}:`);
    return prod;
  }

  // A failed malloc returned null and the memcpy that follows every one of these sites
  // wrote through it. Abort at the allocation instead of faulting with no explanation.
  public emitAllocNullCheck(lines: string[], buf: string, tag: string, span?: Span) {
    this.needsOverflowCheck = true;
    const got = this.nextTemp();
    lines.push(`  ${got} = icmp ne ptr ${buf}, null`);
    const aok = this.nextLabel(`${tag}.aok`);
    const abad = this.nextLabel(`${tag}.abad`);
    lines.push(`  br i1 ${got}, label %${aok}, label %${abad}`);
    lines.push(`${abad}:`);
    const fp2 = this.emitCheckFilePtr(lines, span);
    lines.push(`  call void @__milo_overflow_fail(ptr ${fp2}, i32 ${span?.line ?? 0})`);
    lines.push(`  unreachable`);
    lines.push(`${aok}:`);
  }

  // Cortex-M's bump heap (tools/cortex-m/startup.c) has no block headers, so it cannot
  // implement realloc; every other target's allocator has one (wasm's runtime.c, libc,
  // std/replay's heap).
  private get hasRealloc(): boolean { return this.target.os !== "none"; }

  // Grow a heap buffer to `count * elemSize` bytes, keeping its first `keepBytes`, and
  // return the new pointer (the old one is dead afterwards). A buffer holding at least
  // REALLOC_MIN_BYTES goes through realloc, so it grows in place or by page remap: peak
  // memory stays near the new size instead of old + new, and nothing is copied when the
  // block can extend. A smaller one is malloc + memcpy + free (see REALLOC_MIN_BYTES).
  // Vec buffers only: a string's carries a count header and grows in @milo.str.reserve.
  private emitGrowBytes(lines: string[], oldBuf: string, keepBytes: string, count: string, elemSize: number, tag: string, span?: Span): string {
    if (!this.hasRealloc || elemSize === 0) {
      // Zero-size elements stay on malloc: realloc(p, 0) may free p and return null.
      this.needsFree = true;
      this.needsMemcpy = true;
      const { buf } = this.emitAllocBytes(lines, count, elemSize, tag, span);
      const hasData = this.nextTemp();
      lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
      const copyL = this.nextLabel(`${tag}.copy`);
      const freeL = this.nextLabel(`${tag}.free`);
      const doneL = this.nextLabel(`${tag}.copied`);
      lines.push(`  br i1 ${hasData}, label %${copyL}, label %${doneL}`);
      lines.push(`${copyL}:`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${oldBuf}, i64 ${keepBytes})`);
      lines.push(`  br label %${freeL}`);
      lines.push(`${freeL}:`);
      lines.push(`  call void @free(ptr ${oldBuf})`);
      lines.push(`  br label %${doneL}`);
      lines.push(`${doneL}:`);
      return buf;
    }
    this.needsRealloc = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
    this.needsFree = true;
    const bytes = this.emitByteCount(lines, count, elemSize, tag, span);
    const big = this.nextTemp();
    lines.push(`  ${big} = icmp uge i64 ${keepBytes}, ${REALLOC_MIN_BYTES}`);
    const useRe = big;
    const reL = this.nextLabel(`${tag}.realloc`);
    const freshL = this.nextLabel(`${tag}.fresh`);
    const joinL = this.nextLabel(`${tag}.grown`);
    lines.push(`  br i1 ${useRe}, label %${reL}, label %${freshL}`);
    lines.push(`${reL}:`);
    const re = this.nextTemp();
    lines.push(`  ${re} = call ptr @realloc(ptr ${oldBuf}, i64 ${bytes})`);
    lines.push(`  br label %${joinL}`);
    lines.push(`${freshL}:`);
    const fresh = this.nextTemp();
    lines.push(`  ${fresh} = call ptr @malloc(i64 ${bytes})`);
    // A null fresh block is caught after the join (the old one is left alone); the copy
    // is skipped for it and for a null source.
    const both = this.nextTemp();
    const srcOk = this.nextTemp();
    const dstOk = this.nextTemp();
    lines.push(`  ${srcOk} = icmp ne ptr ${oldBuf}, null`);
    lines.push(`  ${dstOk} = icmp ne ptr ${fresh}, null`);
    lines.push(`  ${both} = and i1 ${srcOk}, ${dstOk}`);
    const cpL = this.nextLabel(`${tag}.cp`);
    const freeL = this.nextLabel(`${tag}.free`);
    const freshDoneL = this.nextLabel(`${tag}.freshdone`);
    lines.push(`  br i1 ${both}, label %${cpL}, label %${freshDoneL}`);
    lines.push(`${cpL}:`);
    lines.push(`  call ptr @memcpy(ptr ${fresh}, ptr ${oldBuf}, i64 ${keepBytes})`);
    lines.push(`  br label %${freeL}`);
    lines.push(`${freeL}:`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${freshDoneL}`);
    lines.push(`${freshDoneL}:`);
    lines.push(`  br label %${joinL}`);
    lines.push(`${joinL}:`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = phi ptr [ ${re}, %${reL} ], [ ${fresh}, %${freshDoneL} ]`);
    this.emitAllocNullCheck(lines, buf, tag, span);
    return buf;
  }

  // Grow `vecPtr`'s buffer so it holds at least `needCap` elements. Leaves the
  // %Vec's data/cap fields updated; len is the caller's business.
  private emitVecEnsureCapacity(lines: string[], vecPtr: string, needCap: string, elemSize: number, tag: string, span?: Span) {
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const enough = this.nextTemp();
    lines.push(`  ${enough} = icmp uge i64 ${cap}, ${needCap}`);
    const growLabel = this.nextLabel(`${tag}.grow`);
    const doneLabel = this.nextLabel(`${tag}.gdone`);
    lines.push(`  br i1 ${enough}, label %${doneLabel}, label %${growLabel}`);
    lines.push(`${growLabel}:`);
    // Geometric growth on top of the exact request, so repeated extends stay amortized.
    const dbl = this.nextTemp();
    lines.push(`  ${dbl} = shl i64 ${cap}, 1`);
    const useDbl = this.nextTemp();
    lines.push(`  ${useDbl} = icmp ugt i64 ${dbl}, ${needCap}`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${useDbl}, i64 ${dbl}, i64 ${needCap}`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const keepBytes = this.nextTemp();
    lines.push(`  ${keepBytes} = mul i64 ${len}, ${elemSize}`);
    const newBuf = this.emitGrowBytes(lines, oldBuf, keepBytes, newCap, elemSize, tag, span);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${doneLabel}:`);
  }

  // v.extend(other): the elements move across bitwise, so nothing is cloned and
  // nothing is dropped. Only `other`'s spine is freed — its elements now live in
  // the destination, and the checker has marked `other` moved so it never drops.
  private genVecExtend(expr: HIRExpr & { kind: "VecExtend" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsFree = true;
    this.needsMemcpy = true;
    const elemSize = this.typeSizeOf(expr.elementType);

    const [dstLines, dstPtr] = this.genLValue(expr.object);
    lines.push(...dstLines);
    const [srcLines, srcVal] = this.genExpr(expr.other);
    lines.push(...srcLines);
    const srcData = this.nextTemp();
    lines.push(`  ${srcData} = extractvalue %Vec ${srcVal}, 0`);
    const srcLen = this.nextTemp();
    lines.push(`  ${srcLen} = extractvalue %Vec ${srcVal}, 1`);
    const srcCap = this.nextTemp();
    lines.push(`  ${srcCap} = extractvalue %Vec ${srcVal}, 2`);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${dstPtr}, i32 0, i32 1`);
    const dstLen = this.nextTemp();
    lines.push(`  ${dstLen} = load i64, ptr ${lenPtr}`);
    const need = this.nextTemp();
    lines.push(`  ${need} = add i64 ${dstLen}, ${srcLen}`);
    this.emitVecEnsureCapacity(lines, dstPtr, need, elemSize, "vecext", expr.span);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${dstPtr}, i32 0, i32 0`);
    const dstData = this.nextTemp();
    lines.push(`  ${dstData} = load ptr, ptr ${dataPtr}`);
    const offBytes = this.nextTemp();
    lines.push(`  ${offBytes} = mul i64 ${dstLen}, ${elemSize}`);
    const tail = this.nextTemp();
    lines.push(`  ${tail} = getelementptr i8, ptr ${dstData}, i64 ${offBytes}`);
    const copyBytes = this.nextTemp();
    lines.push(`  ${copyBytes} = mul i64 ${srcLen}, ${elemSize}`);
    lines.push(`  call ptr @memcpy(ptr ${tail}, ptr ${srcData}, i64 ${copyBytes})`);
    lines.push(`  store i64 ${need}, ptr ${lenPtr}`);

    // A slice (cap 0) never owns its buffer, and a zero-cap Vec has none.
    const owns = this.nextTemp();
    lines.push(`  ${owns} = icmp ugt i64 ${srcCap}, 0`);
    const freeLabel = this.nextLabel("vecext.free");
    const endLabel = this.nextLabel("vecext.end");
    lines.push(`  br i1 ${owns}, label %${freeLabel}, label %${endLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${srcData})`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    this.own.endVal(lines, srcVal, "STORE");
    return [lines, "0", "void"];
  }

  // v.retain(pred): one pass, compacting keepers toward the front and dropping the
  // rest where they sit. No second buffer — that is the whole point next to filter.
  private genVecRetain(expr: HIRExpr & { kind: "VecRetain" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);
    const [vecLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecLines);
    const [cl, cv] = this.genExpr(expr.callback);
    lines.push(...cl);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
    const envPtr = this.nextTemp();
    lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    const iAddr = this.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${iAddr}`);
    const keptAddr = this.nextTemp();
    lines.push(`  ${keptAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${keptAddr}`);

    const cond = this.nextLabel("vecret.cond");
    const body = this.nextLabel("vecret.body");
    const keep = this.nextLabel("vecret.keep");
    const dropIt = this.nextLabel("vecret.drop");
    const step = this.nextLabel("vecret.step");
    const end = this.nextLabel("vecret.end");
    lines.push(`  br label %${cond}`);
    lines.push(`${cond}:`);
    const i = this.nextTemp();
    lines.push(`  ${i} = load i64, ptr ${iAddr}`);
    const more = this.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${i}, ${len}`);
    lines.push(`  br i1 ${more}, label %${body}, label %${end}`);
    lines.push(`${body}:`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
    const hit = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  ${hit} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    lines.push(`  br i1 ${hit}, label %${keep}, label %${dropIt}`);
    lines.push(`${keep}:`);
    const kept = this.nextTemp();
    lines.push(`  ${kept} = load i64, ptr ${keptAddr}`);
    const dstSlot = this.nextTemp();
    lines.push(`  ${dstSlot} = getelementptr ${elemTy}, ptr ${data}, i64 ${kept}`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${elemPtr}`);
    lines.push(`  store ${elemTy} ${val}, ptr ${dstSlot}`);
    const keptNext = this.nextTemp();
    lines.push(`  ${keptNext} = add i64 ${kept}, 1`);
    lines.push(`  store i64 ${keptNext}, ptr ${keptAddr}`);
    lines.push(`  br label %${step}`);
    lines.push(`${dropIt}:`);
    if (this.needsDropCg(expr.elementType)) {
      this.emitDropValue(lines, elemPtr, expr.elementType);
    }
    lines.push(`  br label %${step}`);
    lines.push(`${step}:`);
    const iCur = this.nextTemp();
    lines.push(`  ${iCur} = load i64, ptr ${iAddr}`);
    const iNext = this.nextTemp();
    lines.push(`  ${iNext} = add i64 ${iCur}, 1`);
    lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${end}:`);
    const finalLen = this.nextTemp();
    lines.push(`  ${finalLen} = load i64, ptr ${keptAddr}`);
    lines.push(`  store i64 ${finalLen}, ptr ${lenPtr}`);
    return [lines, "0", "void"];
  }

  private genVecReserve(expr: HIRExpr & { kind: "VecReserve" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemSize = this.typeSizeOf(expr.elementType);
    const [vecLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecLines);
    const [nLines, nRaw] = this.genExpr(expr.additional);
    lines.push(...nLines);
    this.emitNonNegativeCheck(lines, nRaw, "capacity", expr.span);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    // reserve(n) is "room for n MORE", matching Rust — the count a writer has in
    // hand is almost always how many they are about to push, not the final total.
    const need = this.nextTemp();
    lines.push(`  ${need} = add i64 ${len}, ${nRaw}`);
    this.emitVecEnsureCapacity(lines, vecPtr, need, elemSize, "vecrsv", expr.span);
    return [lines, "0", "void"];
  }

  private genVecEnumerate(expr: HIRExpr & { kind: "VecEnumerate" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy, release } = genVecMethodPreamble(this, expr.vec, expr.callback, expr.elementType, lines);

    const idxAddr = `%__enum_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("enum.cond");
    const bodyLabel = this.nextLabel("enum.body");
    const endLabel = this.nextLabel("enum.end");

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const idx = this.nextTemp();
    lines.push(`  ${idx} = load i64, ptr ${idxAddr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp ult i64 ${idx}, ${len}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx}`);
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy, 1);
    lines.push(`  call void ${fnPtr}(ptr ${envPtr}, i64 ${idx}, ${cbArg.argTy} ${cbArg.arg})`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    release();
    return [lines, "void", "void"];
  }

  // Validate a substr/slice range before using it: without this, an inverted
  // or out-of-range span becomes a negative length that malloc/memcpy/getelementptr
  // turn into a silent crash (or a bogus view) with no diagnostic.
  public emitStringRangeCheck(
    lines: string[],
    startVal: string,
    endVal: string,
    strVal: string,
    what: string,
    span?: { line: number; col: number },
  ): void {
    this.needsPrintf = true;
    this.needsExit = true;
    const lenVal = this.nextTemp();
    lines.push(`  ${lenVal} = extractvalue %String ${strVal}, 1`);
    const badStart = this.nextTemp();
    lines.push(`  ${badStart} = icmp slt i64 ${startVal}, 0`);
    const badOrder = this.nextTemp();
    lines.push(`  ${badOrder} = icmp slt i64 ${endVal}, ${startVal}`);
    const badEnd = this.nextTemp();
    lines.push(`  ${badEnd} = icmp sgt i64 ${endVal}, ${lenVal}`);
    const bad0 = this.nextTemp();
    lines.push(`  ${bad0} = or i1 ${badStart}, ${badOrder}`);
    const bad = this.nextTemp();
    lines.push(`  ${bad} = or i1 ${bad0}, ${badEnd}`);
    const panicLabel = this.nextLabel(`${what}.panic`);
    const okLabel = this.nextLabel(`${what}.ok`);
    lines.push(`  br i1 ${bad}, label %${panicLabel}, label %${okLabel}`);
    lines.push(`${panicLabel}:`);
    const { label: errLabel, length: errLen } = this.addString(
      `milo: ${what} range out of bounds: %lld..%lld (len %lld) at ${this.panicAt(span)}\n`,
    );
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, `, i64 ${startVal}, i64 ${endVal}, i64 ${lenVal}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  // Slice/substr bounds are range-checked and used as GEP offsets in i64. A bound
  // that is a narrower int (e.g. an `i32` local) would otherwise emit `icmp ... i64
  // %i32val` — invalid IR that clang rejects. Widen to i64 (sext signed, zext
  // unsigned) so the bound matches the i64 arithmetic around it.
  // Widen an already-generated index to i64 by its own signedness, so a negative i32
  // stays negative (and fails the unsigned bounds compare) and a u32 above 2^31 stays
  // positive.
  private indexToI64(lines: string[], val: string, llTy: string, ty: TypeKind): string {
    if (llTy === "i64") return val;
    const signed = ty.tag === "int" ? ty.signed : true;
    const ext = this.nextTemp();
    lines.push(`  ${ext} = ${signed ? "sext" : "zext"} ${llTy} ${val} to i64`);
    return ext;
  }

  public genBoundI64(bound: HIRExpr, lines: string[]): string {
    const [bl, bv, bty] = this.genExpr(bound);
    lines.push(...bl);
    if (bty === "i8" || bty === "i16" || bty === "i32") {
      const signed = bound.type.tag === "int" ? bound.type.signed : true;
      const ext = this.nextTemp();
      lines.push(`  ${ext} = ${signed ? "sext" : "zext"} ${bty} ${bv} to i64`);
      return ext;
    }
    return bv;
  }

  // rawSlice(p, len) builds a %Vec view over foreign memory, cap=0, exactly as
  // genVecSlice builds every other non-owning view.
  //
  // What actually keeps the C buffer safe, in the order it matters (checked against the
  // emitters, not assumed): `needsDrop` is false for `array`, so a value typed `&[T]`
  // gets no drop glue AT ALL; and SLICE_COMBINATORS denies it `push`/`insert`/`extend`/
  // `reserve`, so it can never reach emitVecEnsureCapacity, which frees the old buffer on
  // non-null and would not have consulted cap. cap=0 is what genVecExtend reads, and it
  // is the one place a cap of `len` would have freed this buffer: `v.extend(view)` frees
  // its source when srcCap > 0. Today the checker rejects that call before codegen sees
  // it, so cap is not observable from Milo, which is precisely why it must be right here
  // rather than defended by a test that cannot exist yet.
  //
  // Nothing about the pointer is checked: there is no source buffer to bound it against,
  // which is why the only callers are `std/foreign`'s two `@unsafe` constructors.
  private genRawSlice(expr: HIRExpr & { kind: "RawSlice" }, lines: string[]): Gen {
    this.hasVecType = true;
    const [pLines, pVal] = this.genExpr(expr.ptr);
    lines.push(...pLines);
    const [lLines, lVal] = this.genExpr(expr.len);
    lines.push(...lLines);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %Vec undef, ptr ${pVal}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 ${lVal}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
    return [lines, s2, "%Vec"];
  }

  // adoptHeap(p) / adoptVec(p, len): take ownership back through a raw pointer.
  //
  // There is no conversion to do: a `Heap<T>` IS the malloc'd pointer (genExpr's
  // `HeapCreate` returns exactly what `malloc` returned), and a `Vec<T>` is that pointer
  // plus two counts. What the node buys is the TYPE: `emitDropValue`'s `heap` and `vec`
  // arms free a non-null data pointer, so the value that comes out of here has real drop
  // glue where the `*T` that went in had none.
  //
  // cap = len, and that is the opposite of the `cap = 0` genRawSlice uses, deliberately:
  // 0 is the marker for "this Vec does not own its buffer", which is the precise claim
  // adoptVec exists to deny. `emitDropValue` frees on a non-null data pointer without
  // reading cap, so the free happens either way; cap is what `genVecExtend` reads to
  // decide whether it may free the source, and an adopted Vec may. It is also the honest
  // number: `len` elements is the only extent the caller stated, so a push reallocs
  // rather than writing into storage nobody promised was there.
  private genAdopt(expr: HIRExpr & { kind: "Adopt" }, lines: string[]): Gen {
    const [pLines, pVal] = this.genExpr(expr.ptr);
    lines.push(...pLines);
    if (expr.type.tag !== "vec") return [lines, pVal, "ptr"];
    this.hasVecType = true;
    if (!expr.len) throw new Error("adoptVec: missing length");
    const [lLines, lVal] = this.genExpr(expr.len);
    lines.push(...lLines);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %Vec undef, ptr ${pVal}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 ${lVal}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 ${lVal}, 2`);
    return [lines, s2, "%Vec"];
  }

  // v.slice(a, b) / v[a..b] — non-owning view: same %Vec rep with adjusted ptr/len
  // and cap=0, so drop glue skips free (the source still owns the buffer).
  private genVecSlice(expr: HIRExpr & { kind: "VecSlice" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);

    // fixed-size array source: the view points into the array's own storage, and
    // the length bound is the static extent N (there is no %Vec len field to read)
    if (expr.vec.type.tag === "array" && expr.vec.type.size !== null) {
      return this.genArraySlice(expr, lines);
    }

    const [vLines, vVal] = this.genExpr(expr.vec);
    lines.push(...vLines);
    const startVal = this.genBoundI64(expr.start, lines);
    const endVal = this.genBoundI64(expr.end, lines);

    // bounds check against the source Vec's len (field 1), mirroring string slices
    this.needsPrintf = true;
    this.needsExit = true;
    const lenVal = this.nextTemp();
    lines.push(`  ${lenVal} = extractvalue %Vec ${vVal}, 1`);
    const badStart = this.nextTemp();
    lines.push(`  ${badStart} = icmp slt i64 ${startVal}, 0`);
    const badOrder = this.nextTemp();
    lines.push(`  ${badOrder} = icmp slt i64 ${endVal}, ${startVal}`);
    const badEnd = this.nextTemp();
    lines.push(`  ${badEnd} = icmp sgt i64 ${endVal}, ${lenVal}`);
    const bad0 = this.nextTemp();
    lines.push(`  ${bad0} = or i1 ${badStart}, ${badOrder}`);
    const bad = this.nextTemp();
    lines.push(`  ${bad} = or i1 ${bad0}, ${badEnd}`);
    const panicLabel = this.nextLabel("vecslice.panic");
    const okLabel = this.nextLabel("vecslice.ok");
    lines.push(`  br i1 ${bad}, label %${panicLabel}, label %${okLabel}`);
    lines.push(`${panicLabel}:`);
    const { label: errLabel, length: errLen } = this.addString(
      `milo: slice range out of bounds: %lld..%lld (len %lld) at ${this.panicAt(expr.span)}\n`,
    );
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, `, i64 ${startVal}, i64 ${endVal}, i64 ${lenVal}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);

    const subLen = this.nextTemp();
    lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);
    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = extractvalue %Vec ${vVal}, 0`);
    const slicePtr = this.nextTemp();
    lines.push(`  ${slicePtr} = getelementptr ${elemTy}, ptr ${srcPtr}, i64 ${startVal}`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %Vec undef, ptr ${slicePtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 ${subLen}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);

    return [lines, s2, "%Vec"];
  }

  // Slice a fixed-size array into a non-owning %Vec view (cap=0) pointing at the
  // array's own storage. Bound is the static extent N parsed from its [N x T] type.
  private genArraySlice(expr: HIRExpr & { kind: "VecSlice" }, lines: string[]): Gen {
    let [aLines, arrPtr, arrTy] = this.genLValue(expr.vec);
    // Not a place (`mk().sum()` on a returned [T; N]): genLValue has no address for it,
    // so the value goes to a frame slot of its own and the view points there.
    if (arrPtr === "null") {
      const [vLines, val, valTy] = this.genExpr(expr.vec);
      const slot = `%__arrtmp.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${slot} = alloca ${valTy}`);
      aLines = [...vLines, this.valStore(valTy, val, slot, this.own.valIntent(val, expr.vec.type))];
      // An array of owned elements (`f([$"a{i}", "b"])`) leaked every element: nothing
      // dropped the slot. The view may outlive the statement (a slice binding), so the
      // slot is dropped at the enclosing block's exit, not after the call.
      if (this.needsDropCg(expr.vec.type)) {
        this.own.valToSlot(val, slot);
        this.registerScopedTemp(aLines, slot, expr.vec.type);
      }
      arrPtr = slot;
      arrTy = valTy;
    }
    lines.push(...aLines);
    const startVal = this.genBoundI64(expr.start, lines);
    const endVal = this.genBoundI64(expr.end, lines);

    const match = arrTy.match(/\[(\d+) x .+\]/);
    const size = match ? parseInt(match[1]) : 0;

    this.needsPrintf = true;
    this.needsExit = true;
    const badStart = this.nextTemp();
    lines.push(`  ${badStart} = icmp slt i64 ${startVal}, 0`);
    const badOrder = this.nextTemp();
    lines.push(`  ${badOrder} = icmp slt i64 ${endVal}, ${startVal}`);
    const badEnd = this.nextTemp();
    lines.push(`  ${badEnd} = icmp sgt i64 ${endVal}, ${size}`);
    const bad0 = this.nextTemp();
    lines.push(`  ${bad0} = or i1 ${badStart}, ${badOrder}`);
    const bad = this.nextTemp();
    lines.push(`  ${bad} = or i1 ${bad0}, ${badEnd}`);
    const panicLabel = this.nextLabel("arrslice.panic");
    const okLabel = this.nextLabel("arrslice.ok");
    lines.push(`  br i1 ${bad}, label %${panicLabel}, label %${okLabel}`);
    lines.push(`${panicLabel}:`);
    const { label: errLabel, length: errLen } = this.addString(
      `milo: slice range out of bounds: %lld..%lld (len ${size}) at ${this.panicAt(expr.span)}\n`,
    );
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, errPtr, `, i64 ${startVal}, i64 ${endVal}`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);

    this.hasVecType = true;
    const subLen = this.nextTemp();
    lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);
    const slicePtr = this.nextTemp();
    lines.push(`  ${slicePtr} = getelementptr ${arrTy}, ptr ${arrPtr}, i64 0, i64 ${startVal}`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %Vec undef, ptr ${slicePtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 ${subLen}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
    return [lines, s2, "%Vec"];
  }

  // True when an enclosing `for i in 0..v.len` already proves this exact
  // subscript in range: same loop variable as the index, same container.
  private indexIsProven(expr: HIRExpr & { kind: "IndexAccess" }): boolean {
    if (expr.index.kind !== "Ident") return false;
    const key = this.containerKey(expr.object);
    if (key === null) return false;
    const containerDecl = this.locals.get(this.rootOf(key));
    const loopVarDecl = this.locals.get(expr.index.name);
    for (let i = this.provenInRange.length - 1; i >= 0; i--) {
      const p = this.provenInRange[i];
      if (p.loopVar !== expr.index.name || p.container !== key) continue;
      return p.containerDecl === containerDecl && p.loopVarDecl === loopVarDecl;
    }
    return false;
  }

  // The address of an indexed container. genLValue answers "null" for anything that
  // is not a place, and indexing a call result — `worlds()[i]` — then GEP'd from that
  // null base and read the length field at 0x8, so the callee never even ran. A
  // temporary has no address until we give it one, so materialize it into a slot.
  //
  // The slot joins argTempDrops rather than being dropped here: at this point the
  // caller holds only a POINTER to the element, so freeing the container first would
  // leave that pointer dangling on the very next line. The read paths in genExpr take
  // a mark before calling and flush after the element has been loaded or cloned.
  //
  // Only a read can get here. `f()[0] = x` is rejected by the checker ("cannot assign
  // to immutable"), so the lvalue paths never see a non-place object.
  private genIndexObjectPtr(obj: HIRExpr, lines: string[]): string {
    const [objLines, objPtr] = this.genLValue(obj);
    lines.push(...objLines);
    if (objPtr !== "null") return objPtr;
    const ty = this.llvmType(obj.type.tag === "ref" ? obj.type.inner : obj.type);
    const slot = this.nextTemp();
    this.entryAllocas.push(`  ${slot} = alloca ${ty}`);
    this.genStoreInto(lines, slot, ty, obj);
    if (this.needsDropCg(obj.type)) this.argTempDrops.push({ addr: slot, type: obj.type });
    return slot;
  }

  private genVecBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): Gen {
    this.hasVecType = true;

    // A slice (`&[T]` / unsized `[T]`, tag "array" with size null) shares the Vec's
    // {ptr,len,cap} runtime layout, so it indexes through the same path. Deref the ref a
    // `&[T]` param carries, then accept either a Vec or a slice.
    const vecType = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    if (vecType.tag !== "vec" && !(vecType.tag === "array" && vecType.size === null)) {
      throw new Error("Vec index on non-vec type");
    }
    const elemTy = this.llvmType(vecType.element);

    const vecPtr = this.genIndexObjectPtr(expr.object, lines);
    const [idxLines, idxVal, idxTy] = this.genExpr(expr.index);
    lines.push(...idxLines);
    const idx64 = this.indexToI64(lines, idxVal, idxTy, expr.index.type);

    // The check, unless an enclosing loop already proved this index in range —
    // in which case the length load goes too, which is most of the cost.
    if (!this.indexIsProven(expr)) {
      this.needsBoundsCheck = true;
      let len = this.hoistedLenFor(expr.object);
      if (len === null) {
        const lenPtr = this.nextTemp();
        lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
        len = this.nextTemp();
        lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
      }
      this.emitBoundsCheck(lines, idx64, len, expr.span);
    }

    // load data pointer and GEP to element
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx64}`);

    return [lines, ptr, elemTy];
  }

  // ── HashMap codegen (the lowering itself lives in codegen-map.ts) ──

  public hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string {
    return `{ i8, ${this.llvmType(keyType)}, ${this.llvmType(valueType)} }`;
  }

  public needsMemset = false;
  private needsMemsetIntrinsic = false;
  private needsSnprintf = false;
  private needsAbort = false;
  // fp→int saturating-cast intrinsic declares needed (each a full `declare ...` line, deduped)
  private fpSatIntrinsics = new Set<string>();

  // A panic (overflow/bounds/div/range/shift trap) terminates via abort() — SIGABRT — not
  // exit(1). abort gives a supervisor an abnormal-exit signal it can distinguish from an
  // ordinary error, lets the OS drop a core dump, and makes lldb/gdb break at the fault.
  // Kept distinct from a user's exit(status) call, which stays a plain exit. Callers still
  // push their own `unreachable` after this.
  public panicAbort(lines: string[]) {
    // Bare-metal/freestanding (os "none"): there is no libc, so abort()/fflush() are
    // undefined symbols. The embedded runtime provides exit (semihosting SYS_EXIT) and there
    // is no buffered stdio to flush — terminate exactly as the pre-abort panic did there.
    if (this.target.os === "none") {
      this.needsExit = true;
      lines.push(`  call void @exit(i32 1)`);
      return;
    }
    this.needsAbort = true;
    // A panic inside a lazy global's initializer names the global, and ends the process
    // even on a green task: retiring just the task would leave the global marked as being
    // initialized, and every later reader would wait for it forever.
    if (this.lazyGlobals.size > 0) lines.push(`  call void @__milo_lazy_panic_note()`);
    // abort() raises SIGABRT immediately WITHOUT flushing stdio — unlike exit(), which does.
    // The panic message was just printf'd (block-buffered on a piped stdout, e.g. Linux under
    // a test harness), so flush it first or it's lost with the process. fflush(NULL) flushes
    // every open stream.
    this.needsFflush = true;
    lines.push(`  call i32 @fflush(ptr null)`);
    // The panic hook (std/runtime sets it when a scheduler starts) retires the panicking
    // green task and never returns, so one task's panic costs that task, not the process.
    // It returns when there is no task to retire, and the panic aborts as before.
    this.usesPanicHook = true;
    const hook = this.nextTemp();
    const noHook = this.nextTemp();
    const callL = this.nextLabel("panic.hook");
    const abortL = this.nextLabel("panic.abort");
    lines.push(`  ${hook} = load ptr, ptr @_milo_panic_hook`);
    lines.push(`  ${noHook} = icmp eq ptr ${hook}, null`);
    lines.push(`  br i1 ${noHook}, label %${abortL}, label %${callL}`);
    lines.push(`${callL}:`);
    lines.push(`  call void ${hook}()`);
    lines.push(`  br label %${abortL}`);
    lines.push(`${abortL}:`);
    lines.push(`  call void @abort()`);
  }

  // Append printf-style format fragments for a value of type `tk`. `val` is the loaded
  // LLVM value, `llvmTy` its LLVM type. Strings, ints, bool, float, ptr inline trivially.
  // Structs/enums/refs go through emitStructDisplay/emitEnumDisplay which snprintf into
  // a malloc'd temp buf — caller frees via `tempBufs`.
  private emitDisplayPart(
    tk: TypeKind,
    val: string,
    llvmTy: string,
    lines: string[],
    partFmts: string[],
    partArgs: { val: string; type: string }[],
    tempBufs: string[],
  ): void {
    if (tk.tag === "ref") {
      // For ref types we currently load through the ref to get the inner value.
      // But ref values are pointers; genExpr already loaded them, so val is the inner.
      this.emitDisplayPart(tk.inner, val, this.llvmType(tk.inner), lines, partFmts, partArgs, tempBufs);
      return;
    }
    if (tk.tag === "string") {
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = extractvalue %String ${val}, 0`);
      const lenVal = this.nextTemp();
      lines.push(`  ${lenVal} = extractvalue %String ${val}, 1`);
      // printf's precision is a C int. A plain trunc wrapped a length over 2 GiB
      // negative, which printf reads as "no precision" and then scans for a NUL past
      // the string's end. Clamped, the part is cut at 2 GiB instead; print and eprint
      // write their top-level strings by length and never come through here.
      const big = this.nextTemp();
      lines.push(`  ${big} = icmp sgt i64 ${lenVal}, 2147483647`);
      const clamped = this.nextTemp();
      lines.push(`  ${clamped} = select i1 ${big}, i64 2147483647, i64 ${lenVal}`);
      const lenI32 = this.nextTemp();
      lines.push(`  ${lenI32} = trunc i64 ${clamped} to i32`);
      partFmts.push("%.*s");
      partArgs.push({ val: lenI32, type: "i32" });
      partArgs.push({ val: dataPtr, type: "ptr" });
      return;
    }
    if (tk.tag === "bool") {
      const trueStr = this.addString("true");
      const falseStr = this.addString("false");
      const boolStr = this.nextTemp();
      lines.push(`  ${boolStr} = select i1 ${val}, ptr ${trueStr.label}, ptr ${falseStr.label}`);
      partFmts.push("%s");
      partArgs.push({ val: boolStr, type: "ptr" });
      return;
    }
    if (tk.tag === "int") {
      // Digits into a per-site stack slot, handed to printf as text: the conversion is
      // @milo.fmt.*, not printf's. One slot per site because a batch can carry several.
      const slot = `%__ifmt.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${slot} = alloca [20 x i8]`);
      const n = this.emitIntFmt(lines, slot, val, llvmTy, tk);
      const n32 = this.nextTemp();
      lines.push(`  ${n32} = trunc i64 ${n} to i32`);
      partFmts.push("%.*s");
      partArgs.push({ val: n32, type: "i32" });
      partArgs.push({ val: slot, type: "ptr" });
      return;
    }
    if (tk.tag === "float") {
      const { buf } = this.emitFloatToBuf(val, tk.bits, lines);
      partFmts.push("%s");
      partArgs.push({ val: buf, type: "ptr" });
      tempBufs.push(buf);
      return;
    }
    if (tk.tag === "struct") {
      const buf = this.emitStructDisplay(tk.name, val, lines);
      partFmts.push("%s");
      partArgs.push({ val: buf, type: "ptr" });
      tempBufs.push(buf);
      return;
    }
    if (tk.tag === "enum") {
      const buf = this.emitEnumDisplay(tk.name, val, lines);
      partFmts.push("%s");
      partArgs.push({ val: buf, type: "ptr" });
      tempBufs.push(buf);
      return;
    }
    // A slice (`array` with size null) shares the Vec's %Vec runtime rep, so the
    // same runtime-length loop renders it — a slice printing as <unprintable>
    // while the Vec it views prints fine was the only gap here.
    if (tk.tag === "vec" || tk.tag === "array") {
      const buf = this.emitSeqDisplay(tk, val, lines);
      partFmts.push("%s");
      partArgs.push({ val: buf, type: "ptr" });
      tempBufs.push(buf);
      return;
    }
    if (tk.tag === "hashmap") {
      const buf = this.emitMapDisplay(tk, val, lines);
      partFmts.push("%s");
      partArgs.push({ val: buf, type: "ptr" });
      tempBufs.push(buf);
      return;
    }
    if (tk.tag === "ptr") {
      partFmts.push("%p");
      partArgs.push({ val: val, type: "ptr" });
      return;
    }
    // fallback for unsupported types: print as pointer (better than silent miscompile)
    partFmts.push("<unprintable>");
  }

  // ── Displaying a container ──────────────────────────────────────────────────
  //
  // Structs and enums render through one compile-time format string because their
  // shape is fixed. A Vec's length and a HashMap's occupancy are not, so these
  // build the text at runtime into a grown-on-demand buffer instead. The result is
  // a malloc'd NUL-terminated C string, the same contract emitStructDisplay has,
  // so the caller frees it out of `tempBufs` exactly the same way.

  // ── Integer formatting ─────────────────────────────────────────────────────
  //
  // `@milo.fmt.u64(dst, v)` / `@milo.fmt.i64(dst, v)` write v's decimal digits at dst
  // (no NUL) and return how many: at most 20, sign included. Two digits per division
  // through a 200-byte pair table, written backwards into a stack scratch and copied
  // forward. snprintf did the same job at ~69 ns a call (format-string parse, locale,
  // varargs); this is the loop every fast formatter uses. Narrower ints are widened
  // (sext/zext) by the caller, so the two cover every width.
  private intFmtFns(): void {
    if (this.emittedIntFmt) return;
    this.emittedIntFmt = true;
    this.needsMemcpy = true;
    let pairs = "";
    for (let i = 0; i < 100; i++) pairs += String(i).padStart(2, "0");
    const table = this.addString(pairs).label;
    this.helperFnBodies.push(runtimeFn("milo.fmt.u64", { table }));
    this.helperFnBodies.push(runtimeFn("milo.fmt.i64"));
  }

  // Write int `val` (LLVM type `llvmTy`, Milo type `tk`) at `dst`; returns the i64 byte count.
  public emitIntFmt(lines: string[], dst: string, val: string, llvmTy: string, tk: TypeKind & { tag: "int" }): string {
    this.intFmtFns();
    let wide = val;
    if (tk.bits < 64) {
      wide = this.nextTemp();
      lines.push(`  ${wide} = ${tk.signed ? "sext" : "zext"} ${llvmTy} ${val} to i64`);
    }
    const n = this.nextTemp();
    lines.push(`  ${n} = call i64 @milo.fmt.${tk.signed ? "i64" : "u64"}(ptr ${dst}, i64 ${wide})`);
    return n;
  }

  // Shared strings. A heap string buffer (cap > 0) carries an 8-byte reference count
  // immediately before its bytes, so a %String's ptr still points at the text and cstr(),
  // views and FFI see no difference. A cap-0 string (a literal, or a view) has no header
  // and never touches one. Copying a string out of a borrow is a count increment
  // (@milo.str.share), a drop is a decrement (@milo.str.release), and every in-place
  // mutation calls @milo.str.unique first, which copies a buffer whose count is above 1,
  // so two handles never observe each other's writes.
  //
  // The count is atomic: strings already reach several OS threads without a boundary copy
  // (immutable heap globals, std/seal's Shared, channel sends, a global set in Once.run),
  // and a non-atomic count lost increments there (tests/fixtures/sharedStringRace*.milo).
  // Increment is relaxed (a new handle is made from one the thread already holds, as in
  // Arc); decrement is release with an acquire fence before the free, so every write a
  // thread made through its handle happens before the buffer is freed. A count read as 1
  // with acquire ordering means this handle is the only one: no other thread holds a
  // handle it could copy from, so the free (or the in-place write) cannot race.
  public strRt(): void {
    if (this.emittedStrRt) return;
    this.emittedStrRt = true;
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;
    this.needsOverflowCheck = true;
    const where = this.addString("<string allocation>");
    const body = runtimeFn("milo.str.oom", { where: where.label });
    for (const k of ["milo.str.alloc", "milo.str.free", "milo.str.release", "milo.str.from", "milo.str.share", "milo.str.unique"]) body.push("", ...runtimeFn(k));
    if (this.hasRealloc) {
      this.needsRealloc = true;
      body.push("", ...runtimeFn("milo.str.realloc"));
    }
    this.helperFnBodies.push(this.strAtomicsForTarget(body));
  }

  // A bare-metal target (Cortex-M, os "none") has no threads to share a string with, and
  // 32-bit M-profile cores have no 64-bit atomic instructions: LLVM would lower the count
  // updates to `__atomic_*_8` libcalls that nothing there provides. Plain loads and stores
  // say the same thing single-threaded.
  private strAtomicsForTarget(body: string[]): string[] {
    if (this.target.os !== "none") return body;
    return body.flatMap(l => {
      const load = l.match(/^(\s+%\S+) = load atomic i64, ptr (%\S+) \w+, align 8$/);
      if (load) return [`${load[1]} = load i64, ptr ${load[2]}, align 8`];
      const rmw = l.match(/^\s+(%\S+) = atomicrmw (add|sub) ptr (%\S+), i64 1 \w+, align 8$/);
      if (rmw) {
        const [, old, op, p] = rmw;
        return [`  ${old} = load i64, ptr ${p}, align 8`, `  ${old}.n = ${op} i64 ${old}, 1`, `  store i64 ${old}.n, ptr ${p}, align 8`];
      }
      if (l.trim() === "fence acquire") return [];
      return [l];
    });
  }

  // A fresh string buffer of `n` bytes (count 1), null-checked against `span`.
  public emitStrAlloc(lines: string[], n: string, tag: string, span?: Span): string {
    this.strRt();
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @milo.str.alloc(i64 ${n})`);
    this.emitAllocNullCheck(lines, buf, tag, span);
    return buf;
  }

  // An owned NUL-terminated copy of `len` bytes at `src`.
  private emitStrFrom(lines: string[], src: string, len: string): string {
    this.strRt();
    const s = this.nextTemp();
    lines.push(`  ${s} = call %String @milo.str.from(ptr ${src}, i64 ${len})`);
    return s;
  }

  // A second owning handle to the string value `val` (see strRt).
  public emitStrShare(lines: string[], val: string): string {
    this.strRt();
    const s = this.nextTemp();
    lines.push(`  ${s} = call %String @milo.str.share(%String ${val})`);
    return s;
  }

  // Before an in-place write to the %String at `strPtr`: make it the only handle to its
  // buffer, and return `srcs` (pointers to bytes about to be copied in) re-based onto the
  // buffer the string holds afterwards when they pointed into the one it held before. A
  // source that is this very string (`s.pushStr(s)`) or another handle to the same buffer
  // would otherwise read the old block, which the release inside @milo.str.unique frees if
  // the last other handle went away on another thread meanwhile.
  public emitStrUnique(lines: string[], strPtr: string, srcs: string[] = []): string[] {
    this.strRt();
    let pre = "", preLen = "";
    if (srcs.length) {
      const dp = this.nextTemp(), lp = this.nextTemp();
      pre = this.nextTemp(); preLen = this.nextTemp();
      lines.push(`  ${dp} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
      lines.push(`  ${pre} = load ptr, ptr ${dp}`);
      lines.push(`  ${lp} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
      lines.push(`  ${preLen} = load i64, ptr ${lp}`);
    }
    lines.push(`  call void @milo.str.unique(ptr ${strPtr})`);
    if (!srcs.length) return [];
    const dp2 = this.nextTemp(), cur = this.nextTemp();
    lines.push(`  ${dp2} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    lines.push(`  ${cur} = load ptr, ptr ${dp2}`);
    const preI = this.nextTemp();
    lines.push(`  ${preI} = ptrtoint ptr ${pre} to i64`);
    return srcs.map(src => {
      const si = this.nextTemp(), off = this.nextTemp(), inside = this.nextTemp(), moved = this.nextTemp(), sel = this.nextTemp();
      lines.push(`  ${si} = ptrtoint ptr ${src} to i64`);
      lines.push(`  ${off} = sub i64 ${si}, ${preI}`);
      lines.push(`  ${inside} = icmp ult i64 ${off}, ${preLen}`);
      lines.push(`  ${moved} = getelementptr i8, ptr ${cur}, i64 ${off}`);
      lines.push(`  ${sel} = select i1 ${inside}, ptr ${moved}, ptr ${src}`);
      return sel;
    });
  }

  // `@milo.str.reserve(s, extra)`: make the %String at `s` hold len + extra bytes plus
  // the NUL, growing by doubling (16-byte floor), with emitGrowBytes's realloc policy.
  // Returns the data pointer, or null when the allocation failed (the caller aborts with
  // its own source location). The string is made unique first (see strRt), so the
  // returned buffer is this handle's alone. A cap-0 buffer is a static literal or a view
  // this string does not own: it is copied, never handed to realloc or free.
  public strReserveFn(): string {
    if (!this.emittedStrReserve) {
      this.emittedStrReserve = true;
      this.strRt();
      const grow = runtimeFn(this.hasRealloc ? "milo.str.reserve.grow.realloc" : "milo.str.reserve.grow.copy");
      const reIn = this.hasRealloc ? `[ %r, %re ]` : `[ %r, %re ], [ %r, %recp ]`;
      this.helperFnBodies.push(runtimeFn("milo.str.reserve", { grow, reallocMin: String(REALLOC_MIN_BYTES), reIn }));
    }
    return "@milo.str.reserve";
  }

  // The parts of a `format(...)` (an interpolated string) that can be written straight
  // into a string buffer, or null when one part needs the snprintf path (a struct,
  // enum, container or pointer renders through emitDisplayPart).
  public fastFormatPart(tk: TypeKind): "string" | "int" | "bool" | "float" | null {
    while (tk.tag === "ref") tk = tk.inner;
    if (tk.tag === "string" || tk.tag === "int" || tk.tag === "bool" || tk.tag === "float") return tk.tag;
    return null;
  }

  // Append already-evaluated format parts to the %String at `strPtr` in one reserve:
  // no snprintf, no temporary string. Each part's worst-case width is summed first,
  // then every part is written in place. A string part may point into the receiver's
  // own buffer (`s.pushStr($"{s}!")`), which the reserve can release, so it is
  // re-based onto the new buffer the way genStringPushStr does.
  public emitAppendFormatParts(lines: string[], strPtr: string, parts: { val: string; ty: string; tk: TypeKind }[], span?: Span): void {
    this.hasStringType = true;
    this.needsMemcpy = true;
    this.needsFree = true;
    type P = { kind: "string" | "int" | "bool" | "float"; ptr?: string; len?: string; val: string; ty: string; tk: TypeKind };
    const ps: P[] = [];
    const tempBufs: string[] = [];
    let total = "0";
    const add = (n: string) => {
      if (total === "0") { total = n; return; }
      const t = this.nextTemp();
      lines.push(`  ${t} = add i64 ${total}, ${n}`);
      total = t;
    };
    for (const part of parts) {
      let tk = part.tk;
      while (tk.tag === "ref") tk = tk.inner;
      const kind = this.fastFormatPart(tk)!;
      const p: P = { kind, val: part.val, ty: kind === "int" ? this.llvmType(tk) : part.ty, tk };
      if (kind === "string") {
        p.ptr = this.nextTemp();
        lines.push(`  ${p.ptr} = extractvalue %String ${part.val}, 0`);
        p.len = this.nextTemp();
        lines.push(`  ${p.len} = extractvalue %String ${part.val}, 1`);
        add(p.len);
      } else if (kind === "bool") {
        const t = this.addString("true"), f = this.addString("false");
        p.ptr = this.nextTemp();
        lines.push(`  ${p.ptr} = select i1 ${part.val}, ptr ${t.label}, ptr ${f.label}`);
        p.len = this.nextTemp();
        lines.push(`  ${p.len} = select i1 ${part.val}, i64 4, i64 5`);
        add(p.len);
      } else if (kind === "float") {
        const { buf, len } = this.emitFloatToBuf(part.val, tk.tag === "float" ? tk.bits : 64, lines);
        p.ptr = buf;
        p.len = len;
        tempBufs.push(buf);
        add(len);
      } else {
        add("20");
      }
      ps.push(p);
    }
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
    const oldLen = this.nextTemp();
    lines.push(`  ${oldLen} = load i64, ptr ${lenPtr}`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const oldData = this.nextTemp();
    lines.push(`  ${oldData} = load ptr, ptr ${dataPtr}`);
    const oldI = this.nextTemp();
    lines.push(`  ${oldI} = ptrtoint ptr ${oldData} to i64`);
    const data = this.nextTemp();
    lines.push(`  ${data} = call ptr ${this.strReserveFn()}(ptr ${strPtr}, i64 ${total})`);
    this.emitAllocNullCheck(lines, data, "fmtapp", span);
    let pos = oldLen;
    for (const p of ps) {
      const dst = this.nextTemp();
      lines.push(`  ${dst} = getelementptr i8, ptr ${data}, i64 ${pos}`);
      let n: string;
      if (p.kind === "int") {
        n = this.emitIntFmt(lines, dst, p.val, p.ty, p.tk as TypeKind & { tag: "int" });
      } else {
        let src = p.ptr!;
        if (p.kind === "string") {
          const ai = this.nextTemp();
          lines.push(`  ${ai} = ptrtoint ptr ${src} to i64`);
          const off = this.nextTemp();
          lines.push(`  ${off} = sub i64 ${ai}, ${oldI}`);
          const inside = this.nextTemp();
          lines.push(`  ${inside} = icmp ult i64 ${off}, ${oldLen}`);
          const moved = this.nextTemp();
          lines.push(`  ${moved} = getelementptr i8, ptr ${data}, i64 ${off}`);
          const sel = this.nextTemp();
          lines.push(`  ${sel} = select i1 ${inside}, ptr ${moved}, ptr ${src}`);
          src = sel;
        }
        lines.push(`  call ptr @memcpy(ptr ${dst}, ptr ${src}, i64 ${p.len})`);
        n = p.len!;
      }
      const np = this.nextTemp();
      lines.push(`  ${np} = add i64 ${pos}, ${n}`);
      pos = np;
    }
    lines.push(`  store i64 ${pos}, ptr ${lenPtr}`);
    const nul = this.nextTemp();
    lines.push(`  ${nul} = getelementptr i8, ptr ${data}, i64 ${pos}`);
    lines.push(`  store i8 0, ptr ${nul}`);
    for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
  }

  // Append `n` bytes of `src` to a buffer held in three caller allocas
  // (ptr, len, cap), growing it geometrically. Emitted once per module.
  private bufAppendFn(): string {
    if (!this.emittedBufAppend) {
      this.emittedBufAppend = true;
      this.needsRealloc = true;
      this.needsMemcpy = true;
      this.helperFnBodies.push(runtimeFn("milo.bufappend"));
    }
    return "@milo.bufappend";
  }

  // Allocas for one display buffer, seeded with an initial malloc. Entry-block
  // allocas, not inline ones: a `print` inside a loop would otherwise grow the
  // stack once per iteration.
  private newDisplayBuf(lines: string[]): { buf: string; len: string; cap: string } {
    this.needsMalloc = true;
    const n = this.scopeCounter++;
    const buf = `%__disp_buf.${n}.addr`;
    const len = `%__disp_len.${n}.addr`;
    const cap = `%__disp_cap.${n}.addr`;
    this.entryAllocas.push(`  ${buf} = alloca ptr`);
    this.entryAllocas.push(`  ${len} = alloca i64`);
    this.entryAllocas.push(`  ${cap} = alloca i64`);
    const initial = this.nextTemp();
    lines.push(`  ${initial} = call ptr @malloc(i64 64)`);
    lines.push(`  store i8 0, ptr ${initial}`);
    lines.push(`  store ptr ${initial}, ptr ${buf}`);
    lines.push(`  store i64 0, ptr ${len}`);
    lines.push(`  store i64 64, ptr ${cap}`);
    return { buf, len, cap };
  }

  private appendLiteral(slots: { buf: string; len: string; cap: string }, text: string, lines: string[]): void {
    if (text.length === 0) return;
    const s = this.addString(text);
    lines.push(`  call void ${this.bufAppendFn()}(ptr ${slots.buf}, ptr ${slots.len}, ptr ${slots.cap}, ptr ${s.label}, i64 ${text.length})`);
  }

  // Render one element and append it. `quoteStrings` matches emitStructDisplay:
  // a bare string element is ambiguous next to the separators.
  private appendElement(
    tk: TypeKind,
    val: string,
    slots: { buf: string; len: string; cap: string },
    lines: string[],
  ): void {
    this.needsStrlen = true;
    this.needsFree = true;
    const fmts: string[] = [];
    const args: { val: string; type: string }[] = [];
    const temps: string[] = [];
    const quote = tk.tag === "string" || (tk.tag === "ref" && tk.inner.tag === "string");
    if (quote) fmts.push(`"`);
    this.emitDisplayPart(tk, val, this.llvmType(tk), lines, fmts, args, temps);
    if (quote) fmts.push(`"`);
    const rendered = this.emitSnprintfToBuf(fmts.join(""), args, temps, lines);
    const n = this.nextTemp();
    lines.push(`  ${n} = call i64 @strlen(ptr ${rendered})`);
    lines.push(`  call void ${this.bufAppendFn()}(ptr ${slots.buf}, ptr ${slots.len}, ptr ${slots.cap}, ptr ${rendered}, i64 ${n})`);
    lines.push(`  call void @free(ptr ${rendered})`);
  }

  // `[a, b, c]` for a Vec (runtime length) or a fixed array (unrolled — the length
  // is a compile-time constant, so a loop would only cost IR).
  private emitSeqDisplay(tk: TypeKind & { tag: "vec" | "array" }, val: string, lines: string[]): string {
    const elem = tk.tag === "vec" ? tk.element : tk.element;
    const slots = this.newDisplayBuf(lines);
    this.appendLiteral(slots, "[", lines);

    if (tk.tag === "array" && tk.size !== null) {
      const elemTy = this.llvmType(elem);
      for (let i = 0; i < tk.size; i++) {
        if (i > 0) this.appendLiteral(slots, ", ", lines);
        const e = this.nextTemp();
        lines.push(`  ${e} = extractvalue [${tk.size} x ${elemTy}] ${val}, ${i}`);
        this.appendElement(elem, e, slots, lines);
      }
    } else {
      const data = this.nextTemp();
      const len = this.nextTemp();
      lines.push(`  ${data} = extractvalue %Vec ${val}, 0`);
      lines.push(`  ${len} = extractvalue %Vec ${val}, 1`);
      const elemTy = this.llvmType(elem);
      const n = this.scopeCounter++;
      const idxAddr = `%__disp_i.${n}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);
      const cond = this.nextLabel("disp.cond");
      const body = this.nextLabel("disp.body");
      const end = this.nextLabel("disp.end");
      const sep = this.nextLabel("disp.sep");
      lines.push(`  br label %${cond}`);
      lines.push(`${cond}:`);
      const i = this.nextTemp();
      lines.push(`  ${i} = load i64, ptr ${idxAddr}`);
      const more = this.nextTemp();
      lines.push(`  ${more} = icmp slt i64 ${i}, ${len}`);
      lines.push(`  br i1 ${more}, label %${sep}, label %${end}`);
      lines.push(`${sep}:`);
      const first = this.nextTemp();
      lines.push(`  ${first} = icmp eq i64 ${i}, 0`);
      const sepDone = this.nextLabel("disp.sepdone");
      const sepDo = this.nextLabel("disp.sepdo");
      lines.push(`  br i1 ${first}, label %${sepDone}, label %${sepDo}`);
      lines.push(`${sepDo}:`);
      this.appendLiteral(slots, ", ", lines);
      lines.push(`  br label %${sepDone}`);
      lines.push(`${sepDone}:`);
      lines.push(`  br label %${body}`);
      lines.push(`${body}:`);
      const ePtr = this.nextTemp();
      lines.push(`  ${ePtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
      const e = this.nextTemp();
      lines.push(`  ${e} = load ${elemTy}, ptr ${ePtr}`);
      this.appendElement(elem, e, slots, lines);
      const next = this.nextTemp();
      lines.push(`  ${next} = add i64 ${i}, 1`);
      lines.push(`  store i64 ${next}, ptr ${idxAddr}`);
      lines.push(`  br label %${cond}`);
      lines.push(`${end}:`);
    }
    this.appendLiteral(slots, "]", lines);
    const out = this.nextTemp();
    lines.push(`  ${out} = load ptr, ptr ${slots.buf}`);
    return out;
  }

  // `{k: v, k: v}` over the open-addressed table, skipping unoccupied slots —
  // same state==1 test the `for k, v in map` lowering uses.
  private emitMapDisplay(tk: TypeKind & { tag: "hashmap" }, val: string, lines: string[]): string {
    const slots = this.newDisplayBuf(lines);
    this.appendLiteral(slots, "{", lines);

    const data = this.nextTemp();
    const cap = this.nextTemp();
    lines.push(`  ${data} = extractvalue %HashMap ${val}, 0`);
    lines.push(`  ${cap} = extractvalue %HashMap ${val}, 2`);
    const entryTy = this.hashMapEntryType(tk.key, tk.value);
    const keyTy = this.llvmType(tk.key);
    const valTy = this.llvmType(tk.value);

    const n = this.scopeCounter++;
    const idxAddr = `%__dispm_i.${n}.addr`;
    const seenAddr = `%__dispm_seen.${n}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    this.entryAllocas.push(`  ${seenAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);
    lines.push(`  store i64 0, ptr ${seenAddr}`);

    const cond = this.nextLabel("dispm.cond");
    const check = this.nextLabel("dispm.check");
    const body = this.nextLabel("dispm.body");
    const step = this.nextLabel("dispm.next");
    const end = this.nextLabel("dispm.end");
    lines.push(`  br label %${cond}`);
    lines.push(`${cond}:`);
    const i = this.nextTemp();
    lines.push(`  ${i} = load i64, ptr ${idxAddr}`);
    const more = this.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${i}, ${cap}`);
    lines.push(`  br i1 ${more}, label %${check}, label %${end}`);

    lines.push(`${check}:`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${i}`);
    const statePtr = this.nextTemp();
    lines.push(`  ${statePtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 0`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${statePtr}`);
    const occupied = this.nextTemp();
    lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${occupied}, label %${body}, label %${step}`);

    lines.push(`${body}:`);
    const seen = this.nextTemp();
    lines.push(`  ${seen} = load i64, ptr ${seenAddr}`);
    const isFirst = this.nextTemp();
    lines.push(`  ${isFirst} = icmp eq i64 ${seen}, 0`);
    const sepDone = this.nextLabel("dispm.sepdone");
    const sepDo = this.nextLabel("dispm.sepdo");
    lines.push(`  br i1 ${isFirst}, label %${sepDone}, label %${sepDo}`);
    lines.push(`${sepDo}:`);
    this.appendLiteral(slots, ", ", lines);
    lines.push(`  br label %${sepDone}`);
    lines.push(`${sepDone}:`);
    const seenNext = this.nextTemp();
    lines.push(`  ${seenNext} = add i64 ${seen}, 1`);
    lines.push(`  store i64 ${seenNext}, ptr ${seenAddr}`);
    const kPtr = this.nextTemp();
    lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const k = this.nextTemp();
    lines.push(`  ${k} = load ${keyTy}, ptr ${kPtr}`);
    this.appendElement(tk.key, k, slots, lines);
    this.appendLiteral(slots, ": ", lines);
    const vPtr = this.nextTemp();
    lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    const v = this.nextTemp();
    lines.push(`  ${v} = load ${valTy}, ptr ${vPtr}`);
    this.appendElement(tk.value, v, slots, lines);
    lines.push(`  br label %${step}`);

    lines.push(`${step}:`);
    const iNow = this.nextTemp();
    lines.push(`  ${iNow} = load i64, ptr ${idxAddr}`);
    const iNext = this.nextTemp();
    lines.push(`  ${iNext} = add i64 ${iNow}, 1`);
    lines.push(`  store i64 ${iNext}, ptr ${idxAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${end}:`);

    this.appendLiteral(slots, "}", lines);
    const out = this.nextTemp();
    lines.push(`  ${out} = load ptr, ptr ${slots.buf}`);
    return out;
  }

  // snprintf a struct into a malloc'd buffer formatted as `Name { f1: v1, f2: v2 }`.
  // Returns the buf ptr; caller is responsible for free.
  private emitStructDisplay(structName: string, structVal: string, lines: string[]): string {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    const layout = must(this.structLayouts, structName, "struct layouts");
    // Stage the struct value into an alloca so we can GEP each field.
    const stagePtr = this.nextTemp();
    lines.push(`  ${stagePtr} = alloca %${structName}`);
    lines.push(`  store %${structName} ${structVal}, ptr ${stagePtr}`);
    // The written name, never the mangled symbol: this string is program OUTPUT.
    const formatParts: string[] = [`${display(this.displayNames, structName)} { `];
    const snprintfArgs: { val: string; type: string }[] = [];
    const tempBufs: string[] = [];
    for (let i = 0; i < layout.fields.length; i++) {
      const field = layout.fields[i];
      if (i > 0) formatParts.push(", ");
      formatParts.push(`${field.name}: `);
      const fieldPtr = this.nextTemp();
      lines.push(`  ${fieldPtr} = getelementptr %${structName}, ptr ${stagePtr}, i32 0, i32 ${i}`);
      const fieldVal = this.nextTemp();
      lines.push(`  ${fieldVal} = load ${field.type}, ptr ${fieldPtr}`);
      // strings get extra quotes so output is unambiguous
      if (field.typeKind.tag === "string") {
        formatParts.push(`"`);
        this.emitDisplayPart(field.typeKind, fieldVal, field.type, lines, formatParts, snprintfArgs, tempBufs);
        formatParts.push(`"`);
      } else {
        this.emitDisplayPart(field.typeKind, fieldVal, field.type, lines, formatParts, snprintfArgs, tempBufs);
      }
    }
    formatParts.push(" }");
    return this.emitSnprintfToBuf(formatParts.join(""), snprintfArgs, tempBufs, lines);
  }

  // snprintf an enum into a malloc'd buffer formatted as `Variant` or `Variant(a, b)`.
  // Returns the buf ptr.
  private emitEnumDisplay(enumName: string, enumVal: string, lines: string[]): string {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    const layout = this.enumLayouts.get(enumName);
    if (!layout) {
      // generic monomorphization may not have registered yet — fall back to "<enum>"
      const fb = this.addString(`<${display(this.displayNames, enumName)}>`);
      // alloc a buf with a copy of the literal so caller can free uniformly
      this.needsStrlen = true;
      this.needsMemcpy = true;
      const len = this.nextTemp();
      lines.push(`  ${len} = call i64 @strlen(ptr ${fb.label})`);
      const sz = this.nextTemp();
      lines.push(`  ${sz} = add i64 ${len}, 1`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${sz})`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${fb.label}, i64 ${sz})`);
      return buf;
    }
    // Stage enum value into alloca so we can read tag + payload by GEP.
    const stagePtr = this.nextTemp();
    lines.push(`  ${stagePtr} = alloca %${enumName}`);
    lines.push(`  store %${enumName} ${enumVal}, ptr ${stagePtr}`);
    const tag = this.loadEnumTag(lines, `%${enumName}`, stagePtr);

    // Allocate result ptr slot — each arm stores its own buf into it then we phi/load.
    const resPtr = this.nextTemp();
    lines.push(`  ${resPtr} = alloca ptr`);

    const endLabel = this.nextLabel("enum.disp.end");
    const variants = Array.from(layout.variants.entries());
    const caseLabels: { tag: number; label: string }[] = [];
    for (const [, info] of variants) {
      caseLabels.push({ tag: info.tag, label: this.nextLabel("enum.disp.case") });
    }
    const defaultLabel = this.nextLabel("enum.disp.default");
    const switchCases = caseLabels.map((c) => `i32 ${c.tag}, label %${c.label}`).join(" ");
    lines.push(`  switch i32 ${tag}, label %${defaultLabel} [${switchCases}]`);

    for (let vi = 0; vi < variants.length; vi++) {
      const [variantName, info] = variants[vi];
      lines.push(`${caseLabels[vi].label}:`);
      const formatParts: string[] = [variantName];
      const snprintfArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = [];
      if (info.fieldTypeKinds.length > 0) {
        formatParts.push("(");
        for (let fi = 0; fi < info.fieldTypeKinds.length; fi++) {
          if (fi > 0) formatParts.push(", ");
          const fk = info.fieldTypeKinds[fi];
          const ft = info.fieldTypes[fi];
          const fieldPtr = this.enumFieldPtr(lines, `%${enumName}`, stagePtr, info, fi);
          const fieldVal = this.nextTemp();
          lines.push(`  ${fieldVal} = load ${ft}, ptr ${fieldPtr}`);
          if (fk.tag === "string") {
            formatParts.push(`"`);
            this.emitDisplayPart(fk, fieldVal, ft, lines, formatParts, snprintfArgs, tempBufs);
            formatParts.push(`"`);
          } else {
            this.emitDisplayPart(fk, fieldVal, ft, lines, formatParts, snprintfArgs, tempBufs);
          }
        }
        formatParts.push(")");
      }
      const buf = this.emitSnprintfToBuf(formatParts.join(""), snprintfArgs, tempBufs, lines);
      lines.push(`  store ptr ${buf}, ptr ${resPtr}`);
      lines.push(`  br label %${endLabel}`);
    }

    lines.push(`${defaultLabel}:`);
    const unkFmt = this.addString(`<${display(this.displayNames, enumName)}.?>`);
    this.needsStrlen = true;
    this.needsMemcpy = true;
    const unkLen = this.nextTemp();
    lines.push(`  ${unkLen} = call i64 @strlen(ptr ${unkFmt.label})`);
    const unkSz = this.nextTemp();
    lines.push(`  ${unkSz} = add i64 ${unkLen}, 1`);
    const unkBuf = this.nextTemp();
    lines.push(`  ${unkBuf} = call ptr @malloc(i64 ${unkSz})`);
    lines.push(`  call ptr @memcpy(ptr ${unkBuf}, ptr ${unkFmt.label}, i64 ${unkSz})`);
    lines.push(`  store ptr ${unkBuf}, ptr ${resPtr}`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${endLabel}:`);
    const out = this.nextTemp();
    lines.push(`  ${out} = load ptr, ptr ${resPtr}`);
    return out;
  }

  // snprintf into a freshly malloc'd buffer; return ptr to it. Frees any temp bufs
  // produced by nested struct/enum field renderings after the snprintf completes.
  // snprintf returns an int: a rendering over 2 GiB comes back as -1 (EOVERFLOW). The
  // callers size a buffer from that length, so -1 became a zero-byte buffer that
  // snprintf never NUL-terminated, then a strlen over the heap, or a String of length
  // -1. Abort instead; the only way to get here is a value whose text exceeds 2 GiB.
  private emitFormatLenCheck(lines: string[], len32: string): void {
    const neg = this.nextTemp();
    const failLabel = this.nextLabel("fmtlen.fail");
    const okLabel = this.nextLabel("fmtlen.ok");
    lines.push(`  ${neg} = icmp slt i32 ${len32}, 0`);
    lines.push(`  br i1 ${neg}, label %${failLabel}, label %${okLabel}`);
    lines.push(`${failLabel}:`);
    const msg = this.addString("runtime error: formatted text exceeds 2 GiB\n");
    this.emitFdPrintf(lines, 2, msg.label, "");
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private emitSnprintfToBuf(
    fmt: string,
    args: { val: string; type: string }[],
    tempBufs: string[],
    lines: string[],
  ): string {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.needsFree = true;
    const fmtStr = this.addString(fmt);
    const argsStr = args.map(a => `, ${a.type} ${a.val}`).join("");
    const len = this.nextTemp();
    lines.push(`  ${len} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmtStr.label}${argsStr})`);
    this.emitFormatLenCheck(lines, len);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = sext i32 ${len} to i64`);
    const sz = this.nextTemp();
    lines.push(`  ${sz} = add i64 ${len64}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${sz})`);
    lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${sz}, ptr ${fmtStr.label}${argsStr})`);
    for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
    return buf;
  }

  private genJsonStringify(expr: HIRExpr & { kind: "JsonStringify" }, lines: string[]): Gen {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.hasStringType = true;

    const valueType = expr.valueType;
    if (valueType.tag !== "struct") {
      throw new Error(`jsonStringify: unsupported type '${valueType.tag}'`);
    }

    const layout = must(this.structLayouts, valueType.name, "struct layouts");
    const [ptrLines, structPtr] = this.genLValueForArg(expr.value);
    lines.push(...ptrLines);

    const formatParts: string[] = ["{"];
    const snprintfArgs: { val: string; type: string }[] = [];
    const escapeBufs: string[] = [];

    for (let i = 0; i < layout.fields.length; i++) {
      const field = layout.fields[i];
      const fk = field.typeKind;
      if (i > 0) formatParts.push(",");

      const fieldPtr = this.nextTemp();
      lines.push(`  ${fieldPtr} = getelementptr %${valueType.name}, ptr ${structPtr}, i32 0, i32 ${i}`);
      const fieldVal = this.nextTemp();
      lines.push(`  ${fieldVal} = load ${field.type}, ptr ${fieldPtr}`);

      formatParts.push(`"${field.name}":`);

      if (fk.tag === "string") {
        // escape before snprintf — raw %s of user data produced invalid JSON
        // for quotes/backslashes/newlines
        this.ensureJsonEscapeHelper();
        const dataPtr = this.nextTemp();
        lines.push(`  ${dataPtr} = extractvalue %String ${fieldVal}, 0`);
        const strLen = this.nextTemp();
        lines.push(`  ${strLen} = extractvalue %String ${fieldVal}, 1`);
        const escaped = this.nextTemp();
        lines.push(`  ${escaped} = call %String @milo.json.escape(ptr ${dataPtr}, i64 ${strLen})`);
        const escPtr = this.nextTemp();
        lines.push(`  ${escPtr} = extractvalue %String ${escaped}, 0`);
        escapeBufs.push(escPtr);
        formatParts.push(`"%s"`);
        snprintfArgs.push({ val: escPtr, type: "ptr" });
      } else if (fk.tag === "bool") {
        const trueStr = this.addString("true");
        const falseStr = this.addString("false");
        const boolStr = this.nextTemp();
        lines.push(`  ${boolStr} = select i1 ${fieldVal}, ptr ${trueStr.label}, ptr ${falseStr.label}`);
        formatParts.push("%s");
        snprintfArgs.push({ val: boolStr, type: "ptr" });
      } else if (fk.tag === "int") {
        let passVal = fieldVal;
        let passType = field.type;
        if (fk.bits < 32) {
          const widened = this.nextTemp();
          lines.push(`  ${widened} = ${fk.signed ? "sext" : "zext"} ${field.type} ${fieldVal} to i32`);
          passVal = widened;
          passType = "i32";
        }
        formatParts.push(fk.bits <= 32 ? (fk.signed ? "%d" : "%u") : (fk.signed ? "%lld" : "%llu"));
        snprintfArgs.push({ val: passVal, type: passType });
      } else if (fk.tag === "float") {
        const { buf } = this.emitFloatToBuf(fieldVal, fk.bits, lines);
        formatParts.push("%s");
        snprintfArgs.push({ val: buf, type: "ptr" });
        escapeBufs.push(buf);
      }
    }

    formatParts.push("}");
    const fmt = this.addString(formatParts.join(""));
    const argsStr = snprintfArgs.map(a => `, ${a.type} ${a.val}`).join("");

    // snprintf(null, 0, fmt, ...) to measure
    const lenResult = this.nextTemp();
    lines.push(`  ${lenResult} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmt.label}${argsStr})`);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = sext i32 ${lenResult} to i64`);
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
    const buf = this.emitStrAlloc(lines, bufSize, "jsonstr", expr.span);

    // snprintf(buf, size, fmt, ...) to write
    lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${bufSize}, ptr ${fmt.label}${argsStr})`);

    if (escapeBufs.length > 0) {
      this.needsFree = true;
      for (const eb of escapeBufs) lines.push(`  call void @free(ptr ${eb})`);
    }

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
    return [lines, s2, "%String"];
  }

  // milo.json.escape(src, len) -> %String: RFC 8259 escaping, mirroring
  // std/json's jsonEscapeStr — ", \, \n, \t, \r as 2-byte escapes, all other
  // control chars (<0x20) as \u00XX. NUL-terminated so the result's data ptr
  // can feed snprintf %s. Worst case every byte escapes to \u00XX: 6x + NUL.
  // milo.fmt.f{32,64}(v, buf) -> length: the shortest decimal string that reads
  // back as the bit-identical value. Plain "%g" is 6 significant digits, which
  // silently destroys data — 1.0/3.0 printed as `0.333333` and 123456789.123456
  // as `1.23457e+08`.
  //
  // Two loops. The first counts integer digits by walking powers of ten, and the
  // second raises "%.*g" precision until the text parses back equal. Precision
  // has to *start* at the integer-digit count, not at 1: %g switches to exponent
  // form once the exponent reaches the precision, so `%.1g` of 100.0 is the
  // round-tripping but unreadable "1e+02". Starting at 3 gives "100".
  //
  // The digit walk uses only comparisons and a multiply, so there is no libm
  // dependency (log10 would need -lm on Linux). NaN makes every fcmp false, so
  // it takes dig=1, never compares equal, and falls out of the second loop at
  // the cap as "nan"; infinity saturates the walk and prints "inf". Both match
  // the old %g output. `buf` must be at least F64_BUF bytes.
  private ensureFloatFormatHelper(bits: 32 | 64) {
    if (bits === 32) {
      if (this.generatedF32FormatHelper) return;
      this.generatedF32FormatHelper = true;
      this.needsStrtof = true;
    } else {
      if (this.generatedF64FormatHelper) return;
      this.generatedF64FormatHelper = true;
      this.needsStrtod = true;
    }
    this.needsSnprintf = true;
    const fmt = this.addString("%.*g");
    // A float needs at most 9 significant digits to round-trip, a double 17.
    const cap = bits === 32 ? 9 : 17;
    const ty = bits === 32 ? "float" : "double";
    const parse = bits === 32 ? "@strtof" : "@strtod";
    // The digit walk and snprintf both want a double; f32 is promoted once.
    const widen = bits === 32
      ? [`  %d = fpext float %v to double`]
      // `x + -0.0` is the identity for every x; `x + 0.0` turned -0.0 into +0.0, and
      // print(-0.0) said "0".
      : [`  %d = fadd double %v, -0.000000e+00`];
    this.dropHelperBodies.push([
      `define private i64 @milo.fmt.f${bits}(${ty} %v, ptr %buf) {`,
      `entry.bb:`,
      ...widen,
      `  %isneg = fcmp olt double %d, 0.000000e+00`,
      `  %negd = fneg double %d`,
      `  %av = select i1 %isneg, double %negd, double %d`,
      `  br label %dloop`,
      `dloop:`,
      `  %dig = phi i32 [ 1, %entry.bb ], [ %dignext, %dnext ]`,
      `  %pow = phi double [ 1.000000e+01, %entry.bb ], [ %pownext, %dnext ]`,
      `  %room = icmp slt i32 %dig, ${cap}`,
      `  %over = fcmp oge double %av, %pow`,
      `  %grow = and i1 %room, %over`,
      `  br i1 %grow, label %dnext, label %ploop`,
      `dnext:`,
      `  %dignext = add i32 %dig, 1`,
      `  %pownext = fmul double %pow, 1.000000e+01`,
      `  br label %dloop`,
      `ploop:`,
      `  %p = phi i32 [ %dig, %dloop ], [ %pnext, %again ]`,
      `  %n = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %buf, i64 ${F64_BUF}, ptr ${fmt.label}, i32 %p, double %d)`,
      `  %back = call ${ty} ${parse}(ptr %buf, ptr null)`,
      `  %exact = fcmp oeq ${ty} %back, %v`,
      `  %last = icmp sge i32 %p, ${cap}`,
      `  %stop = or i1 %exact, %last`,
      `  br i1 %stop, label %fin, label %again`,
      `again:`,
      `  %pnext = add i32 %p, 1`,
      `  br label %ploop`,
      `fin:`,
      `  %n64 = sext i32 %n to i64`,
      `  ret i64 %n64`,
      `}`,
      ``,
    ]);
  }

  // Formats a float into a fresh malloc'd buffer and returns it. Callers own the
  // buffer — free it, or hand it to a temp-buf list that frees it.
  // `asString`: the buffer becomes a %String's, so it carries the count header (strRt).
  public emitFloatToBuf(val: string, bits: number, lines: string[], asString = false): { buf: string; len: string } {
    const w = bits === 32 ? 32 : 64;
    this.ensureFloatFormatHelper(w);
    this.needsMalloc = true;
    let buf: string;
    if (asString) {
      buf = this.emitStrAlloc(lines, String(F64_BUF), "ftos");
    } else {
      buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${F64_BUF})`);
    }
    const len = this.nextTemp();
    lines.push(`  ${len} = call i64 @milo.fmt.f${w}(${w === 32 ? "float" : "double"} ${val}, ptr ${buf})`);
    return { buf, len };
  }

  private ensureJsonEscapeHelper() {
    if (this.generatedJsonEscapeHelper) return;
    this.generatedJsonEscapeHelper = true;
    this.needsMalloc = true;
    this.dropHelperBodies.push([
      `define private %String @milo.json.escape(ptr %src, i64 %len) {`,
      `entry.bb:`,
      `  %cap0 = mul i64 %len, 6`,
      `  %cap = add i64 %cap0, 1`,
      `  %buf = call ptr @malloc(i64 %cap)`,
      `  br label %loop`,
      `loop:`,
      `  %i = phi i64 [ 0, %entry.bb ], [ %inext, %cont ]`,
      `  %o = phi i64 [ 0, %entry.bb ], [ %onext, %cont ]`,
      `  %done = icmp sge i64 %i, %len`,
      `  br i1 %done, label %fin, label %body`,
      `body:`,
      `  %cp = getelementptr i8, ptr %src, i64 %i`,
      `  %c = load i8, ptr %cp`,
      `  %isq = icmp eq i8 %c, 34`,
      `  %isb = icmp eq i8 %c, 92`,
      `  %isn = icmp eq i8 %c, 10`,
      `  %ist = icmp eq i8 %c, 9`,
      `  %isr = icmp eq i8 %c, 13`,
      `  %e1 = or i1 %isq, %isb`,
      `  %e2 = or i1 %e1, %isn`,
      `  %e3 = or i1 %e2, %ist`,
      `  %esc = or i1 %e3, %isr`,
      `  %s1 = select i1 %isn, i8 110, i8 %c`,
      `  %s2 = select i1 %ist, i8 116, i8 %s1`,
      `  %s3 = select i1 %isr, i8 114, i8 %s2`,
      `  br i1 %esc, label %escblk, label %notnamed`,
      `notnamed:`,
      `  %isctl = icmp ult i8 %c, 32`,
      `  br i1 %isctl, label %ctlblk, label %plain`,
      `escblk:`,
      `  %ep0 = getelementptr i8, ptr %buf, i64 %o`,
      `  store i8 92, ptr %ep0`,
      `  %eo1 = add i64 %o, 1`,
      `  %ep1 = getelementptr i8, ptr %buf, i64 %eo1`,
      `  store i8 %s3, ptr %ep1`,
      `  %eo2 = add i64 %o, 2`,
      `  br label %cont`,
      `ctlblk:`,
      // \u00XX — c < 32 so the high nibble is 0 or 1, always a digit
      `  %cp0 = getelementptr i8, ptr %buf, i64 %o`,
      `  store i8 92, ptr %cp0`,
      `  %co1 = add i64 %o, 1`,
      `  %cp1 = getelementptr i8, ptr %buf, i64 %co1`,
      `  store i8 117, ptr %cp1`,
      `  %co2 = add i64 %o, 2`,
      `  %cp2 = getelementptr i8, ptr %buf, i64 %co2`,
      `  store i8 48, ptr %cp2`,
      `  %co3 = add i64 %o, 3`,
      `  %cp3 = getelementptr i8, ptr %buf, i64 %co3`,
      `  store i8 48, ptr %cp3`,
      `  %hi = lshr i8 %c, 4`,
      `  %hid = add i8 %hi, 48`,
      `  %co4 = add i64 %o, 4`,
      `  %cp4 = getelementptr i8, ptr %buf, i64 %co4`,
      `  store i8 %hid, ptr %cp4`,
      `  %lo = and i8 %c, 15`,
      `  %lodig = add i8 %lo, 48`,
      `  %loalpha = add i8 %lo, 87`,
      `  %lolt = icmp ult i8 %lo, 10`,
      `  %lod = select i1 %lolt, i8 %lodig, i8 %loalpha`,
      `  %co5 = add i64 %o, 5`,
      `  %cp5 = getelementptr i8, ptr %buf, i64 %co5`,
      `  store i8 %lod, ptr %cp5`,
      `  %co6 = add i64 %o, 6`,
      `  br label %cont`,
      `plain:`,
      `  %pp = getelementptr i8, ptr %buf, i64 %o`,
      `  store i8 %c, ptr %pp`,
      `  %po = add i64 %o, 1`,
      `  br label %cont`,
      `cont:`,
      `  %onext = phi i64 [ %eo2, %escblk ], [ %co6, %ctlblk ], [ %po, %plain ]`,
      `  %inext = add i64 %i, 1`,
      `  br label %loop`,
      `fin:`,
      `  %np = getelementptr i8, ptr %buf, i64 %o`,
      `  store i8 0, ptr %np`,
      `  %r0 = insertvalue %String undef, ptr %buf, 0`,
      `  %r1 = insertvalue %String %r0, i64 %o, 1`,
      `  %r2 = insertvalue %String %r1, i64 %cap, 2`,
      `  ret %String %r2`,
      `}`,
    ]);
  }

  // True for expression forms that yield a freshly-owned value. Place expressions
  // (Ident/FieldAccess/IndexAccess) name storage owned by someone else, so freeing
  // their result would double-free. A call can't hand back a borrow: references are
  // second-class and never returned.
  // True when codegen's IndexAccess path auto-clones the element (vec / unsized
  // array with a drop-needing element type) rather than loading it in place. The
  // result is then a fresh allocation, whoever consumes it.
  private indexAccessClones(expr: HIRExpr): boolean {
    if (expr.kind !== "IndexAccess") return false;
    const obj = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    const isIndexable = obj.tag === "vec" || obj.tag === "array";
    return isIndexable && this.needsDropCg(expr.type);
  }

  // `opt!` / `res?` hand back a payload nobody else will free: a temp operand dies
  // with the expression, and an Ident operand has its slot zeroed in the ok branch
  // (see genUnwrap/genPropagate) precisely because the payload moved out. A place
  // operand that is NOT zeroed — a struct field — still owns its payload, so
  // freeing the result there would double-free.
  private unwrapMovesPayload(expr: HIRExpr & { kind: "Unwrap" | "Propagate" }): boolean {
    if (this.isOwnedTempExpr(expr.operand)) return true;
    return this.needsDropCg(expr.type) && expr.operand.kind === "Ident";
  }

  // Whether an Option.map/andThen has to free its receiver. True only when the receiver
  // is a temporary nobody else owns: a call result, or another map/andThen — the only two
  // combinators whose result provably shares no buffer with their receiver. orElse and the
  // Result combinators forward a payload through, so their results are NOT unshared and a
  // chain built on them stays the caller's problem rather than risking a double free.
  // r.context(note): Ok is forwarded; Err is boxed (unless already a Heap<Error>) and
  // becomes the cause of a heap ErrorContext { note, cause } coerced to Heap<Error>. The
  // receiver was consumed by the checker, so both payloads are moved, not copied.
  private genResultContext(expr: HIRExpr & { kind: "OptionOp" }, lines: string[], addr: string, enumTy: string, isOk: string): Gen {
    if (expr.type.tag !== "enum") throw new Error("Result.context result is not an enum");
    const resEnum = expr.type.name;
    const resTy = `%${resEnum}`;
    const resLayout = must(this.enumLayouts, resEnum, "enum layouts");
    const srcLayout = must(this.enumLayouts, expr.enumName, "enum layouts");
    const resOk = must(resLayout.variants, "Ok", "Result variants");
    const resErr = must(resLayout.variants, "Err", "Result variants");
    const srcOk = must(srcLayout.variants, "Ok", "Result variants");
    const srcErr = must(srcLayout.variants, "Err", "Result variants");
    // the note is evaluated first, unconditionally, like any argument
    const [nl, noteVal] = this.genExpr(expr.default!);
    lines.push(...nl);
    const resAddr = `%__resctx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resAddr} = alloca ${resTy}`);
    lines.push(`  store ${resTy} zeroinitializer, ptr ${resAddr}`);
    const okLabel = this.nextLabel("resctx.ok");
    const errLabel = this.nextLabel("resctx.err");
    const contLabel = this.nextLabel("resctx.cont");
    lines.push(`  br i1 ${isOk}, label %${okLabel}, label %${errLabel}`);
    const payloadPtr = (variant: EnumVariant) => this.enumPayloadPtr(lines, enumTy, addr, variant);
    const store = (tag: number, ty: string | undefined, val: string | undefined) => {
      this.storeEnumTag(lines, resTy, resAddr, tag);
      if (!ty || !val) return;
      const pp = this.enumPayloadPtr(lines, resTy, resAddr, tag);
      lines.push(`  store ${ty} ${val}, ptr ${pp}`);
    };

    lines.push(`${okLabel}:`);
    // the note is unused on this path and is owned here (emitDropValue takes an address)
    const noteAddr = this.nextTemp();
    lines.push(`  ${noteAddr} = alloca %String`);
    lines.push(`  store %String ${noteVal}, ptr ${noteAddr}`);
    this.own.valToSlot(noteVal, noteAddr);
    this.emitDropValue(lines, noteAddr, { tag: "string" });
    if (srcOk.fieldTypes[0]) {
      const v = this.nextTemp();
      lines.push(`  ${v} = load ${srcOk.fieldTypes[0]}, ptr ${payloadPtr(srcOk)}`);
      store(resOk.tag, srcOk.fieldTypes[0], v);
    } else {
      store(resOk.tag, undefined, undefined);
    }
    lines.push(`  br label %${contLabel}`);

    lines.push(`${errLabel}:`);
    const errTy = srcErr.fieldTypes[0] ?? "{ ptr, ptr }";
    const errVal = this.nextTemp();
    lines.push(`  ${errVal} = load ${errTy}, ptr ${payloadPtr(srcErr)}`);
    const cause = expr.boxConversion ? this.emitBoxAsIface(lines, errVal, errTy, expr.boxConversion) : errVal;
    const ctxType: TypeKind = { tag: "struct", name: "ErrorContext" };
    const ctxTy = this.llvmType(ctxType);
    const c0 = this.nextTemp();
    lines.push(`  ${c0} = insertvalue ${ctxTy} undef, %String ${noteVal}, 0`);
    this.own.endVal(lines, noteVal, "STORE");
    const c1 = this.nextTemp();
    lines.push(`  ${c1} = insertvalue ${ctxTy} ${c0}, { ptr, ptr } ${cause}, 1`);
    const fat = this.emitHeapFatPtr(lines, c1, ctxTy, ctxType, "ErrorContext", "Error");
    store(resErr.tag, "{ ptr, ptr }", fat);
    lines.push(`  br label %${contLabel}`);

    lines.push(`${contLabel}:`);
    const out = this.nextTemp();
    lines.push(`  ${out} = load ${resTy}, ptr ${resAddr}`);
    return [lines, out, resTy];
  }

  private optionOpDropsReceiver(expr: HIRExpr & { kind: "OptionOp" }): boolean {
    if (expr.op !== "map" && expr.op !== "optionAndThen") return false;
    if (!this.needsDropCg(expr.value.type)) return false;
    return this.isOwnedTempExpr(expr.value);
  }

  // Whether an `if`/`match` used as an EXPRESSION hands back a value nobody else owns.
  //
  // It does when some arm yields an owned value: a temporary, a place the checker moved
  // (isMove: genExpr zeroes it), or a match arm's own binding (the yield moves it). An
  // arm that yields a place it does not consume (`if c { a } else { mk() }` read in place)
  // then stores a clone (ForkSlot.cloneViews), so whichever arm ran, the consumer drops
  // exactly one value it owns. For a resource type the checker moves such a place instead
  // (moveMixedFork), since a structural clone would run its Drop twice. A string literal
  // owns nothing, and a fork of only views and literals stays a view.
  private blockValueOwnsResult(expr: HIRExpr & { kind: "IfExpr" | "MatchExpr" }): boolean {
    if (!this.needsDropCg(expr.type)) return false;
    const arms = expr.kind === "IfExpr"
      ? [{ body: expr.thenBody, bound: new Set<string>() }, { body: expr.elseBody, bound: new Set<string>() }]
      : expr.arms.map(a => ({ body: a.body, bound: matchArmLocals(a, !!expr.subjectIsRef) }));
    let owned = false;
    for (const { body, bound } of arms) {
      const tail = armTailExpr(body);
      if (!tail) {
        const last = body[body.length - 1];
        if (last && (last.kind === "Return" || last.kind === "Break" || last.kind === "Continue")) continue;
        // `if true { .. } else { .. }`: the dead arm is lowered empty
        if (!last && expr.kind === "IfExpr" && expr.cond.kind === "BoolLit") continue;
        return false;
      }
      if (tail.kind === "StringLit") continue;
      if (!this.forkTailIsView(tail, tail.kind === "Ident" && bound.has(tail.name))) owned = true;
      // A view of a type with a user Drop cannot be cloned structurally (the copy would
      // run the Drop again); the checker consumes such a place where it can see the read
      // (consumeMixedResourceFork). Anywhere it did not, stay a view: a leak, not a
      // double drop.
      else if (this.typeRunsUserDrop(tail.type)) return false;
    }
    return owned;
  }

  // Whether destroying a value of `t` runs some user Drop impl.
  private typeRunsUserDrop(t: TypeKind, seen: Set<string> = new Set()): boolean {
    switch (t.tag) {
      case "struct": {
        if (this.dropImpls.has(t.name)) return true;
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return (this.structLayouts.get(t.name)?.fields ?? []).some(f => this.typeRunsUserDrop(f.typeKind, seen));
      }
      case "enum": {
        if (this.dropImpls.has(t.name)) return true;
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        const layout = this.enumLayouts.get(t.name);
        if (!layout) return false;
        return [...layout.variants.values()].some(v => v.fieldTypeKinds.some(f => this.typeRunsUserDrop(f, seen)));
      }
      case "vec": case "array": return this.typeRunsUserDrop(t.element, seen);
      case "heap": return t.inner.tag === "interface" || this.typeRunsUserDrop(t.inner, seen);
      case "hashmap": return this.typeRunsUserDrop(t.key, seen) || this.typeRunsUserDrop(t.value, seen);
      case "interface": case "fn": return true;
      default: return false;
    }
  }

  // An arm tail that reads a place without consuming it. `armLocal`: an Ident the arm
  // declared, which the yield moves.
  public forkTailIsView(tail: HIRExpr, armLocal: boolean): boolean {
    if (tail.kind === "StringLit" || armLocal || !this.needsDropCg(tail.type)) return false;
    if (this.isOwnedTempExpr(tail)) return false;
    if ((tail.kind === "Ident" || tail.kind === "FieldAccess" || tail.kind === "IndexAccess" || tail.kind === "HeapDeref") && tail.isMove) return false;
    return true;
  }

  // A fresh copy of a value read out of a place (the place keeps its own).
  public cloneViewValue(lines: string[], val: string, tk: TypeKind): string {
    const lt = this.llvmType(tk);
    const slot = `%__forkclone.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${slot} = alloca ${lt}`);
    lines.push(`  store ${lt} ${val}, ptr ${slot}`);
    const cloned = this.emitDeepCloneFromPtr(lines, slot, tk);
    this.own.makeVal(lines, cloned, "fork-clone");
    return cloned;
  }

  // Whether a field chain bottoms out in an rvalue nobody owns (`mk().a.b`), as opposed to
  // a place genLValue can address in situ (a local, `v[i]`, `*p`). Only the rvalue is
  // materialized by genFieldPtr, so only it can die with the expression.
  private receiverIsRvalueTemp(expr: HIRExpr & { kind: "FieldAccess" }): boolean {
    const obj = expr.object;
    if (obj.type.tag === "ptr") return false;
    if (obj.kind === "FieldAccess") return this.receiverIsRvalueTemp(obj);
    if (obj.kind === "Ident" || obj.kind === "IndexAccess" || obj.kind === "PtrDeref") return false;
    if (obj.kind === "HeapDeref" && !this.isTempBoxDeref(obj)) return false;
    return this.isOwnedTempExpr(obj) && this.needsDropCg(obj.type);
  }

  // `*mk()` / `*Heap(x)`: a deref of a box nobody else owns. Even a read through it has
  // to free the box and drop the payload once the read is done, so codegen treats every
  // such deref as a move out of the box (genHeapMoveOut) yielding an owned temporary.
  // Reading it in place leaked the box and never ran the payload's Drop.
  private isTempBoxDeref(expr: HIRExpr): boolean {
    if (expr.kind !== "HeapDeref") return false;
    const op = expr.operand;
    if (op.type.tag !== "heap" || op.type.inner.tag === "interface") return false;
    return op.kind === "Call" || op.kind === "ClosureCall" || op.kind === "InterfaceMethodCall" || op.kind === "HeapCreate";
  }

  // An owning field read out of a temporary receiver. The receiver is dropped as soon as
  // the field is read, so the FieldAccess hands the field on moved (or, under a user Drop,
  // cloned) and is an owned temporary in its own right.
  private fieldOfOwnedTemp(expr: HIRExpr & { kind: "FieldAccess" }): boolean {
    return this.needsDropCg(expr.type) && this.receiverIsRvalueTemp(expr);
  }

  public isOwnedTempExpr(expr: HIRExpr): boolean {
    // A discarded small-type `replace(...)` result is dropped here (SSA path). A big-agg
    // replace drops its own moved-out value inside genExpr, so it must NOT double-drop here.
    if (expr.kind === "MemReplace") return !this.isBigAgg(this.llvmType(expr.type));
    if (expr.kind === "Call" || expr.kind === "ClosureCall" || expr.kind === "InterfaceMethodCall") return true;
    // An Option/Result combinator that yields an enum owns it: map/andThen build a fresh
    // payload, and every op that forwards the receiver's payload (orElse, mapErr,
    // context, ...) consumed a named receiver in the checker (consumeForwardedPayload).
    // Not an owned temp, `e.map(f).unwrapOr(0)` leaked the Err payload once per call.
    // The scalar ops (isSome, unwrapOr on a Copy payload) are filtered by needsDropCg.
    if (expr.kind === "OptionOp") return expr.type.tag === "enum";
    // Builtins that allocate a fresh String/Vec are temporaries too. `i.toString()`
    // lowers to NumberToString, not Call, so `"n=" + i.toString()` used to leak the
    // converted string on every evaluation — which in a render loop is per frame.
    // A nested concat (`a + b + c`) is the same: the inner BinOp's result is owned
    // by nobody once the outer one has read it.
    switch (expr.kind) {
      // The point of `adopt` is that the result is owned and nothing else will free it,
      // which is the whole feature, so a discarded one leaks by exactly the amount it
      // adopted. Note this is the opposite answer from its sibling `RawSlice`, which is a
      // view and owns nothing.
      case "Adopt":
      // An enum literal in an auto-borrowed argument position (`f(E.Text(s))`) owns
      // its payload and nothing else ever will: the callee only borrows it, and the
      // temp has no name for scope-drop to find. Without this the payload leaks on
      // every call — `renderResponse(Response.Text(body), hdrs)` lost `body` each time.
      case "EnumLit":
      // Array/Vec and struct literals in that same position are the identical case,
      // and were missed when EnumLit was fixed: `f(["GET", key])` leaked the Vec's
      // buffer and `f(Point { name: s })` leaked the field, once per call. Every
      // client library built on a `cmd(&Vec<string>)` shape leaked a buffer per
      // command. Only the borrow path reaches here — a by-value argument moves and
      // is the callee's to drop — so this cannot double-free.
      case "ArrayLit":
      case "StructLit":
      case "NumberToString":
      case "BoolToString":
      case "JsonStringify":
      case "StringClone":
      case "StringSubstr":
      case "StringWithCapacity":
      case "VecClone":
      case "VecNew":
      case "VecWithCapacity":
      case "VecFilled":
      case "VecMap":
      case "VecFilter":
      case "HashMapWithCapacity":
      case "HashMapClone":
      case "HashMapEntries":
      // fold returns the ACCUMULATOR, which is owned whenever the accumulator type is —
      // `v.fold("", (a: string, x: &i64): string => a + x.toString())` hands back a String
      // nobody else owns. It sat in NOT_OWNED_TEMP with the scalar-yielding Vec reads.
      // dropOwnedTemp still checks needsDropCg, so an i64 accumulator is unaffected.
      case "VecFold":
      // getOrDefault yields an OWNED value on both paths — a deep clone of the stored
      // value when the key is present, the default itself when it is not — so a discarded
      // or temporary result has to be dropped. It sat in NOT_OWNED_TEMP next to `contains`
      // and `len`, which really do yield scalars, and `print("D" + m.getOrDefault(k, d))`
      // therefore leaked the clone every time. Exactly the miss the list's own comment
      // describes for VecRemove.
      case "HashMapGetOrDefault":
      // Option-returning Vec reads: the payload is either cloned out of the buffer
      // (get/first/last/min/max/find) or moved out of it (pop). Either way nothing
      // else owns it, so `print(must(v, 0, "v"))` used to leak one copy per call.
      case "VecGetOpt":
      case "VecMinMax":
      case "VecPop":
      // `remove` moves the element out of the buffer exactly as `pop` does, and was the
      // sibling this list forgot: `v.remove(0)` as a statement dropped NOTHING, so the
      // element's destructor never ran and its heap went with it. Discarding a `pop` was
      // already correct, which is what made the gap invisible — the two spellings of
      // "take an element out and ignore it" disagreed.
      case "VecRemove":
      case "VecFind":
      // HashMap.get clones the value out of the table for the same reason.
      case "HashMapGet":
        return true;
      case "BinOp":
        // string `+` only — the comparisons return bool
        return expr.type.tag === "string";
      case "IndexAccess":
        // `v[i]` on a non-Copy element auto-clones so the container stays intact
        // (see the IndexAccess case), which makes the result a fresh allocation
        // with no owner unless it is bound. `print(v[0])` leaked one copy per call.
        return this.indexAccessClones(expr);
      case "FieldAccess":
        return this.fieldOfOwnedTemp(expr);
      case "HeapDeref":
        return this.isTempBoxDeref(expr);
      case "Unwrap":
      case "Propagate":
        return this.unwrapMovesPayload(expr);
      case "DefaultValue":
        return this.defaultValueOwnsResult(expr);
      case "IfExpr":
      case "MatchExpr":
        return this.blockValueOwnsResult(expr);
      default:
        return false;
    }
  }

  // Whether a `??` result is a value nobody else owns. Both branches DO move — the Some
  // branch loads the payload and zeroes the source enum, the None branch stores the
  // default and zeroes its source (genDefaultValue) — so an unbound `(maybe(i) ?? "x").len`
  // leaked one payload per evaluation with nothing left to free it.
  //
  // Deliberately narrower than "both branches move": the zeroing that makes a moved
  // *variable* safe only happens when codegen can find the source slot, which it cannot
  // for every Ident (an immutable `let` is an SSA register, not an alloca). A branch whose
  // value is an owned temp needs no zeroing to begin with, and a string literal has cap 0
  // so its drop is a no-op — those two are safe unconditionally. Everything else, Idents
  // included, stays false and keeps leaking rather than risking a double free.
  private defaultValueOwnsResult(expr: HIRExpr & { kind: "DefaultValue" }): boolean {
    // An Ident counts, for the same reason it does in unwrapMovesPayload: genDefaultValue
    // MOVES out of whichever branch it takes, zeroing the source, so the named variable is
    // not going to be dropped by its scope either. Requiring a literal or a temporary here
    // missed the commonest shape by far —
    //
    //     let o: Option<string> = Option.Some(big(i))
    //     (o ?? "d").len                                  // payload leaked, every time
    //
    // — one payload per evaluation, on BOTH branches. Still an AND: every branch that could
    // produce the result has to be one this owns, or dropping it could free something the
    // caller still holds.
    const branchOwns = (e: HIRExpr): boolean =>
      e.kind === "StringLit"
      || this.isOwnedTempExpr(e)
      || (this.needsDropCg(expr.type) && e.kind === "Ident");
    return branchOwns(expr.operand) && branchOwns(expr.default);
  }

  // Owned temporaries materialised into an alloca so they could be passed by
  // reference (`take(i.toString())`, `print(n.toString())`). The callee cannot keep
  // the borrow — references are second-class — so the temp is dead the moment the
  // call returns, and nothing else will ever free it. Recorded here by
  // genLValueForArg and flushed by the call site that consumed them.
  private argTempDrops: { addr: string; type: TypeKind; ownVal?: string }[] = [];
  private hirFns = new Map<string, HIRFunction>();
  private closureParamEscapeCache = new Map<string, boolean>();

  private flushArgTempDrops(lines: string[], mark: number) {
    while (this.argTempDrops.length > mark) {
      const t = this.argTempDrops.pop()!;
      this.emitDropValue(lines, t.addr, t.type);
    }
  }

  // `.clone()` of a value nobody else owns IS that value: hand the temporary through
  // instead of copying it. Copying left the temporary with no owner, so every spelling
  // leaked it: `mk().clone()`, and `v[i].clone()` on any collection whose indexing
  // already clones (a sized array `["a", "b"][i]`, a `Vec<Vec<i32>>` row), once per
  // evaluation. Null when `src` is a place, which really does need the copy.
  public cloneOfOwnedTemp(src: HIRExpr, lines: string[]): Gen | null {
    if (!this.isOwnedTempExpr(src) || !this.needsDropCg(src.type)) return null;
    const [sl, sv, st] = this.genExpr(src);
    lines.push(...sl);
    return [lines, sv, st];
  }

  // Free a value that was produced by a call and then consumed in-place by an
  // operator, leaving nothing that will ever drop it.
  public dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr) {
    if (!this.isOwnedTempExpr(expr) || !this.needsDropCg(expr.type)) return;
    this.dropValueNow(lines, val, llTy, expr);
  }

  // Free a by-value argument the operation consumed but did not keep: an owned temporary,
  // or a place the checker moved into the call (`isMove`, whose alive flag genExpr has
  // already cleared, so nothing else will drop it).
  public dropConsumedArg(lines: string[], val: string, llTy: string, expr: HIRExpr) {
    if (!this.needsDropCg(expr.type)) return;
    const movedPlace = (expr.kind === "Ident" || expr.kind === "FieldAccess" || expr.kind === "IndexAccess") && !!expr.isMove;
    if (!movedPlace && !this.isOwnedTempExpr(expr)) return;
    this.dropValueNow(lines, val, llTy, expr);
  }

  private dropValueNow(lines: string[], val: string, llTy: string, expr: HIRExpr) {
    const tmpAddr = `%__tmpdrop.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${tmpAddr} = alloca ${llTy}`);
    lines.push(this.valStore(llTy, val, tmpAddr, { intent: "move", type: expr.type }));
    this.own.valToSlot(val, tmpAddr);
    this.emitDropValue(lines, tmpAddr, expr.type);
  }

  public emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string {
    return emitDeepCloneFromPtr(this, lines, srcPtr, typeKind);
  }

  // A synthesized module-level function (drop or clone helper) is numbered from zero and has
  // its own ledger maps; the enclosing function's counters are restored after.
  public emitHelperFn(hoistAt: number | undefined, build: (body: string[]) => void): void {
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    const ownRestore = this.own.enterFn();
    this.labelCounter = 0;
    const body: string[] = [];
    build(body);
    // Helper bodies bypass the normal function emitter, so a Vec clone's allocas would land
    // inside its copy loop (a dynamic alloca per iteration walks the stack off the end).
    if (hoistAt !== undefined) this.hoistAllocas(body, hoistAt);
    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    ownRestore();
    this.labelCounter = savedLabel;
  }

  public emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind) {
    if (this.structuralDropTypes.has(typeKind) && !this.structuralDrop) {
      this.structuralDrop = true;
      try { this.emitDropValue(lines, allocaPtr, typeKind); } finally { this.structuralDrop = false; }
      return;
    }
    // A guarded drop ends its slot's ID itself. Any other drop of a droppable local's slot
    // (an assignment's overwrite) is unguarded and relies on a moved-out slot having been
    // zeroed, so it ends tolerantly (DROPZ): it may legitimately meet an ended ID.
    if (this.own.on && !this.own.inGuard) {
      const id = this.own.slots.get(allocaPtr);
      if (id) this.own.end(lines, id, this.own.flagIds.has(id) ? "DROPZ" : "DROP");
    }
    emitDropValueBody(this, lines, allocaPtr, typeKind);
  }

  // x.wrappingAdd(y) — plain LLVM add/sub/mul (wraps by definition)
  private genWrappingArith(expr: HIRExpr & { kind: "WrappingArith" }, lines: string[]): Gen {
    const [ll, lv, lt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);
    const result = this.nextTemp();
    lines.push(`  ${result} = ${expr.op} ${lt} ${lv}, ${rv}`);
    return [lines, result, lt];
  }

  // x.saturatingAdd(y) — clamps to min/max instead of wrapping
  private genSaturatingArith(expr: HIRExpr & { kind: "SaturatingArith" }, lines: string[]): Gen {
    const [ll, lv, lt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);
    const signed = expr.type.tag === "int" && expr.type.signed;
    const prefix = signed ? "s" : "u";

    // LLVM has sadd.sat/ssub.sat/uadd.sat/usub.sat but NOT smul.sat/umul.sat
    if (expr.op === "mul") {
      return this.emitSaturatingMul(lines, lv, rv, lt, signed, expr.type);
    }

    const intrinsic = `@llvm.${prefix}${expr.op}.sat.${lt}`;
    this.usedSatIntrinsics ??= new Set();
    this.usedSatIntrinsics.add(`declare ${lt} ${intrinsic}(${lt}, ${lt})`);
    const result = this.nextTemp();
    lines.push(`  ${result} = call ${lt} ${intrinsic}(${lt} ${lv}, ${lt} ${rv})`);
    return [lines, result, lt];
  }

  // manual saturating multiply using overflow intrinsic
  private emitSaturatingMul(lines: string[], lv: string, rv: string, lt: string, signed: boolean, ty: TypeKind): Gen {
    const prefix = signed ? "s" : "u";
    const intrinsic = `@llvm.${prefix}mul.with.overflow.${lt}`;
    this.usedOverflowIntrinsics.add(`declare {${lt}, i1} ${intrinsic}(${lt}, ${lt})`);

    const callResult = this.nextTemp();
    const val = this.nextTemp();
    const flag = this.nextTemp();
    lines.push(`  ${callResult} = call {${lt}, i1} ${intrinsic}(${lt} ${lv}, ${lt} ${rv})`);
    lines.push(`  ${val} = extractvalue {${lt}, i1} ${callResult}, 0`);
    lines.push(`  ${flag} = extractvalue {${lt}, i1} ${callResult}, 1`);

    const bits = ty.tag === "int" ? ty.bits : 32;
    let clampVal: string;
    if (!signed) {
      // Unsigned multiply can only overflow upward.
      clampVal = String(BigInt(2) ** BigInt(bits) - BigInt(1));
    } else {
      // Signed multiply overflows in whichever direction the true product points, and this
      // used to clamp to MAX either way behind a comment calling it a simplification. It
      // is not one: `(-2i8).saturatingMul(100)` is -200, which saturates to -128, and the
      // old code answered 127 — wrong bound AND wrong sign, from a documented API.
      //
      // The product's sign is the xor of the operands' signs. Neither operand can be zero
      // on this path, since a multiply involving zero does not overflow.
      const maxV = String(BigInt(2) ** BigInt(bits - 1) - BigInt(1));
      const minV = String(-(BigInt(2) ** BigInt(bits - 1)));
      const lNeg = this.nextTemp();
      lines.push(`  ${lNeg} = icmp slt ${lt} ${lv}, 0`);
      const rNeg = this.nextTemp();
      lines.push(`  ${rNeg} = icmp slt ${lt} ${rv}, 0`);
      const negProduct = this.nextTemp();
      lines.push(`  ${negProduct} = xor i1 ${lNeg}, ${rNeg}`);
      const bound = this.nextTemp();
      lines.push(`  ${bound} = select i1 ${negProduct}, ${lt} ${minV}, ${lt} ${maxV}`);
      clampVal = bound;
    }

    const result = this.nextTemp();
    lines.push(`  ${result} = select i1 ${flag}, ${lt} ${clampVal}, ${lt} ${val}`);
    return [lines, result, lt];
  }

  // x.checkedAdd(y) — returns Option<T>, None on overflow
  // The Option<T> tail every checked-arithmetic op ends with: branch on `flag`, build
  // Some(val) on the safe path and a zeroed None on the other, phi them together. It was
  // two 30-line copies (genCheckedArith and genCheckedDivRem) that differed only in how
  // `flag` was computed — a layout or memset change would have landed in one of them.
  // `emitVal` is the one real hole: div/rem must emit the operation inside the ok block.
  private emitCheckedOptionTail(
    lines: string[],
    optionEnumName: string,
    flag: string,
    lt: string,
    emitVal: () => string,
  ): Gen {
    const optionTy = `%${optionEnumName}`;
    const optionLayout = this.enumLayouts.get(optionEnumName);
    if (!optionLayout) throw new Error(`Option enum '${optionEnumName}' not found`);
    const someTag = must(optionLayout.variants, "Some", "variants").tag;
    const noneTag = must(optionLayout.variants, "None", "variants").tag;

    const okLabel = this.nextLabel("checked.ok");
    const overflowLabel = this.nextLabel("checked.overflow");
    const doneLabel = this.nextLabel("checked.done");

    lines.push(`  br i1 ${flag}, label %${overflowLabel}, label %${okLabel}`);

    lines.push(`${okLabel}:`);
    const val = emitVal();
    const someAlloca = this.nextTemp();
    lines.push(`  ${someAlloca} = alloca ${optionTy}`);
    this.storeEnumTag(lines, optionTy, someAlloca, someTag);
    const somePayloadPtr = this.enumPayloadPtr(lines, optionTy, someAlloca, someTag);
    lines.push(`  store ${lt} ${val}, ptr ${somePayloadPtr}`);
    const someVal = this.nextTemp();
    lines.push(`  ${someVal} = load ${optionTy}, ptr ${someAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${overflowLabel}:`);
    const noneAlloca = this.nextTemp();
    lines.push(`  ${noneAlloca} = alloca ${optionTy}`);
    this.needsMemset = true;
    const optSize = this.nextTemp();
    lines.push(`  ${optSize} = getelementptr ${optionTy}, ptr null, i32 1`);
    const optSizeI = this.nextTemp();
    lines.push(`  ${optSizeI} = ptrtoint ptr ${optSize} to i64`);
    lines.push(`  call ptr @memset(ptr ${noneAlloca}, i32 0, i64 ${optSizeI})`);
    this.storeEnumTag(lines, optionTy, noneAlloca, noneTag);
    const noneVal = this.nextTemp();
    lines.push(`  ${noneVal} = load ${optionTy}, ptr ${noneAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${optionTy} [ ${someVal}, %${okLabel} ], [ ${noneVal}, %${overflowLabel} ]`);
    return [lines, result, optionTy];
  }

  private genCheckedArith(expr: HIRExpr & { kind: "CheckedArith" }, lines: string[]): Gen {
    // div/rem have no *.with.overflow intrinsic — the failure modes are divisor==0
    // and (signed) INT_MIN/-1, and the division itself traps on those, so it must be
    // guarded and executed only on the safe path. Handled separately.
    if (expr.op === "div" || expr.op === "rem") return this.genCheckedDivRem(expr, lines);
    const [ll, lv, lt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);
    const signed = expr.left.type.tag === "int" && expr.left.type.signed;
    const prefix = signed ? "s" : "u";
    const intrinsic = `@llvm.${prefix}${expr.op}.with.overflow.${lt}`;
    this.usedOverflowIntrinsics.add(`declare {${lt}, i1} ${intrinsic}(${lt}, ${lt})`);

    const callResult = this.nextTemp();
    const val = this.nextTemp();
    const flag = this.nextTemp();
    lines.push(`  ${callResult} = call {${lt}, i1} ${intrinsic}(${lt} ${lv}, ${lt} ${rv})`);
    lines.push(`  ${val} = extractvalue {${lt}, i1} ${callResult}, 0`);
    lines.push(`  ${flag} = extractvalue {${lt}, i1} ${callResult}, 1`);

    // The Option-building tail is identical for every checked op; only `flag` differs.
    return this.emitCheckedOptionTail(lines, expr.optionEnumName, flag, lt, () => val);
  }

  // x.checkedDiv(y) / x.checkedRem(y) — Option<T>, None on divide-by-zero or
  // (signed) INT_MIN/-1. The divide is emitted only on the safe branch because
  // LLVM sdiv/udiv trap on a zero divisor.
  private genCheckedDivRem(expr: HIRExpr & { kind: "CheckedArith" }, lines: string[]): Gen {
    const [ll, lv, lt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);
    const signed = expr.left.type.tag === "int" && expr.left.type.signed;
    const bits = expr.left.type.tag === "int" ? expr.left.type.bits : 32;

    const zeroCmp = this.nextTemp();
    lines.push(`  ${zeroCmp} = icmp eq ${lt} ${rv}, 0`);
    let flag = zeroCmp;
    if (signed) {
      // signed overflow: INT_MIN / -1 has no representable result
      const minVal = (-(BigInt(2) ** BigInt(bits - 1))).toString();
      const isMin = this.nextTemp();
      lines.push(`  ${isMin} = icmp eq ${lt} ${lv}, ${minVal}`);
      const isNeg1 = this.nextTemp();
      lines.push(`  ${isNeg1} = icmp eq ${lt} ${rv}, -1`);
      const ovf = this.nextTemp();
      lines.push(`  ${ovf} = and i1 ${isMin}, ${isNeg1}`);
      const combined = this.nextTemp();
      lines.push(`  ${combined} = or i1 ${zeroCmp}, ${ovf}`);
      flag = combined;
    }

    // sdiv/udiv trap on a zero divisor, so unlike every other checked op the operation
    // itself is emitted inside the ok block rather than before the branch.
    return this.emitCheckedOptionTail(lines, expr.optionEnumName, flag, lt, () => {
      const llvmOp = (signed ? "s" : "u") + expr.op; // sdiv/udiv/srem/urem
      const val = this.nextTemp();
      lines.push(`  ${val} = ${llvmOp} ${lt} ${lv}, ${rv}`);
      return val;
    });
  }

  // Integer bit intrinsics. countOnes/leadingZeros/trailingZeros (ctpop/ctlz/cttz)
  // return an i64 count; rotateLeft/Right (fshl/fshr funnel shift) and reverseBits
  // (bitreverse) return the same width as the receiver.
  private genBitIntrinsic(expr: HIRExpr & { kind: "BitIntrinsic" }, lines: string[]): Gen {
    const [vl, vv, vt] = this.genExpr(expr.value);
    lines.push(...vl);
    const name = `@llvm.${expr.intrinsic}.${vt}`;

    // rotate = funnel shift with both halves the same value; amount is taken mod width
    if (expr.intrinsic === "fshl" || expr.intrinsic === "fshr") {
      const [al, av] = this.genExpr(expr.amount!);
      lines.push(...al);
      this.usedOverflowIntrinsics.add(`declare ${vt} ${name}(${vt}, ${vt}, ${vt})`);
      const r = this.nextTemp();
      lines.push(`  ${r} = call ${vt} ${name}(${vt} ${vv}, ${vt} ${vv}, ${vt} ${av})`);
      return [lines, r, vt];
    }
    if (expr.intrinsic === "bitreverse") {
      this.usedOverflowIntrinsics.add(`declare ${vt} ${name}(${vt})`);
      const r = this.nextTemp();
      lines.push(`  ${r} = call ${vt} ${name}(${vt} ${vv})`);
      return [lines, r, vt];
    }

    // bit counts → i64
    const raw = this.nextTemp();
    if (expr.intrinsic === "ctpop") {
      this.usedOverflowIntrinsics.add(`declare ${vt} ${name}(${vt})`);
      lines.push(`  ${raw} = call ${vt} ${name}(${vt} ${vv})`);
    } else {
      // ctlz/cttz take an i1 "is-zero-poison" flag; false = defined for 0 (returns bit width)
      this.usedOverflowIntrinsics.add(`declare ${vt} ${name}(${vt}, i1)`);
      lines.push(`  ${raw} = call ${vt} ${name}(${vt} ${vv}, i1 false)`);
    }
    if (vt === "i64") return [lines, raw, "i64"];
    const wide = this.nextTemp();
    lines.push(`  ${wide} = zext ${vt} ${raw} to i64`);
    return [lines, wide, "i64"];
  }

  // opt.isSome()/isNone()/unwrapOr(d). Some is always tag 0. unwrapOr selects the
  // Some payload vs the default; the checker restricts it to Copy inner types so the
  // payload load can't alias an owned heap buffer.
  private genOptionOp(expr: HIRExpr & { kind: "OptionOp" }, lines: string[]): Gen {
    const [vl, vv] = this.genExpr(expr.value);
    lines.push(...vl);
    const enumTy = `%${expr.enumName}`;
    const addr = this.nextTemp();
    lines.push(`  ${addr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${vv}, ptr ${addr}`);
    this.own.valToSlot(vv, addr);
    // A Result combinator consumes a named receiver when the payload it forwards is not
    // Copy (checker: consumeForwardedPayload); the move ended the local's ID at the read,
    // so the copy at `addr` is a value this op now owns and must end on every branch.
    // Without an ID here a branch that disposed of nothing went unreported.
    const receiverMoved = expr.value.kind === "Ident" && !!(expr.value as { isMove?: boolean }).isMove;
    if (this.own.on && receiverMoved && expr.op.startsWith("result") && expr.op !== "resultUnwrapOrElse"
        && this.needsDropCg(expr.value.type) && !this.own.slots.has(addr)) {
      this.own.slots.set(addr, this.own.make(lines, "combinator-receiver"));
    }
    const tag = this.loadEnumTag(lines, enumTy, addr);
    const isSome = this.nextTemp();
    lines.push(`  ${isSome} = icmp eq i32 ${tag}, 0`);
    // isSome/isNone/isOk/isErr and unwrapOr(Else) keep only a tag or a Copy payload (the
    // checker rejects them on a non-Copy one), so a temporary receiver is dead once they
    // have read it: `if find(k).isNone()` leaked the Some payload on every call. A named
    // receiver still owns its value and is not an owned temp, so this skips it.
    const releaseTempReceiver = () => {
      if (this.isOwnedTempExpr(expr.value) && this.needsDropCg(expr.value.type)) {
        this.emitDropValue(lines, addr, expr.value.type);
      }
    };
    if (expr.op === "isSome") {
      releaseTempReceiver();
      return [lines, isSome, "i1"];
    }
    if (expr.op === "isNone") {
      const r = this.nextTemp();
      lines.push(`  ${r} = xor i1 ${isSome}, true`);
      releaseTempReceiver();
      return [lines, r, "i1"];
    }
    // map/andThen/orElse: Option in, Option out. Handled before the payload load below,
    // because for these `expr.type` is the RESULT enum, not the payload type.
    //   map      Some -> Some(f(&T)),  None -> None
    //   andThen  Some -> f(&T) verbatim (already an Option), None -> None
    //   orElse   Some -> the receiver verbatim, None -> f()
    if (expr.op === "map" || expr.op === "optionAndThen" || expr.op === "optionOrElse") {
      if (expr.type.tag !== "enum") throw new Error(`Option.${expr.op} result is not an enum`);
      const resEnum = expr.type.name;
      const resTy = `%${resEnum}`;
      const resLayout = this.enumLayouts.get(resEnum);
      const srcLayout = this.enumLayouts.get(expr.enumName);
      if (!resLayout || !srcLayout) throw new Error(`enum layout not found for ${resEnum}/${expr.enumName}`);
      const resSome = resLayout.variants.get("Some");
      const resNone = resLayout.variants.get("None");
      const srcSome = srcLayout.variants.get("Some");
      if (!resSome || !resNone || !srcSome) throw new Error("Option enum missing Some/None variants");

      // The closure value is built unconditionally (it is just a {fn,env} pair); only the
      // CALL is conditional.
      const [cl, cv] = this.genExpr(expr.default!);
      lines.push(...cl);
      const fnPtr = this.nextTemp();
      lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
      const envPtr = this.nextTemp();
      lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

      const resAddr = `%__optmap.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${resAddr} = alloca ${resTy}`);
      lines.push(`  store ${resTy} zeroinitializer, ptr ${resAddr}`);

      const someLabel = this.nextLabel("optmap.some");
      const noneLabel = this.nextLabel("optmap.none");
      const contLabel = this.nextLabel("optmap.cont");
      lines.push(`  br i1 ${isSome}, label %${someLabel}, label %${noneLabel}`);

      lines.push(`${someLabel}:`);
      if (expr.op === "optionOrElse") {
        // Result type == receiver type here, so forwarding Some is a whole-enum copy.
        lines.push(`  store ${resTy} ${vv}, ptr ${resAddr}`);
      } else {
        const srcPayloadPtr = this.enumPayloadPtr(lines, enumTy, addr, srcSome);
        // The checker types the callback param as &T, so the payload is passed by pointer —
        // that is what keeps a non-Copy inner from being moved out of the receiver.
        const cbType = expr.default!.type;
        const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
        let callArg = srcPayloadPtr;
        let callArgTy = "ptr";
        if (!paramIsRef) {
          const srcTy = srcSome.fieldTypes[0] ?? "i64";
          const loaded = this.nextTemp();
          lines.push(`  ${loaded} = load ${srcTy}, ptr ${srcPayloadPtr}`);
          callArg = loaded;
          callArgTy = srcTy;
        }
        if (expr.op === "optionAndThen") {
          // the callback already returns the whole Option — store it wholesale, no re-tagging
          const called = this.nextTemp();
          lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr}, ${callArgTy} ${callArg})`);
          lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
        } else {
          const resPayloadTy = resSome.fieldTypes[0] ?? "i64";
          const called = this.nextTemp();
          lines.push(`  ${called} = call ${resPayloadTy} ${fnPtr}(ptr ${envPtr}, ${callArgTy} ${callArg})`);
          this.storeEnumTag(lines, resTy, resAddr, resSome.tag);
          const resPayloadPtr = this.enumPayloadPtr(lines, resTy, resAddr, resSome);
          lines.push(`  store ${resPayloadTy} ${called}, ptr ${resPayloadPtr}`);
        }
      }
      lines.push(`  br label %${contLabel}`);

      lines.push(`${noneLabel}:`);
      if (expr.op === "optionOrElse") {
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr})`);
        lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
      } else {
        this.storeEnumTag(lines, resTy, resAddr, resNone.tag);
      }
      lines.push(`  br label %${contLabel}`);

      lines.push(`${contLabel}:`);
      const out = this.nextTemp();
      lines.push(`  ${out} = load ${resTy}, ptr ${resAddr}`);
      // After map/andThen the receiver's payload is dead: the callback only borrowed it
      // (the checker types the param as &T, so it cannot have been moved out) and None
      // carries nothing to forward, so the result shares no buffer with it. A NAMED
      // receiver still owns it and drops at scope end, but a temporary — `doc.get(k).map(f)`
      // — has no other owner, and without this the whole payload leaks on every hop.
      // Deliberately not done for orElse or the Result combinators: those forward the
      // untouched variant's payload into the result, so dropping here would double-free.
      if (this.optionOpDropsReceiver(expr)) this.emitDropValue(lines, addr, expr.value.type);
      if (expr.op === "optionOrElse") this.own.end(lines, this.own.slots.get(addr), "MOVE"); // Some forwarded verbatim
      return [lines, out, resTy];
    }

    // Result map/mapErr/andThen/orElse. Unlike Option.map, the branch that does NOT run the
    // callback still carries a payload, and it must be copied from the source enum into the
    // result enum — skipping it leaves the zeroinitializer, i.e. `map` over an Err would
    // silently produce a zeroed error value instead of the real one.
    if (expr.op === "resultContext") { const r = this.genResultContext(expr, lines, addr, enumTy, isSome); this.own.end(r[0], this.own.slots.get(addr), "MOVE"); return r; }
    if (expr.op === "resultMap" || expr.op === "resultMapErr" || expr.op === "resultAndThen"
        || expr.op === "resultOrElse") {
      if (expr.type.tag !== "enum") throw new Error(`Result.${expr.op} result is not an enum`);
      const resEnum = expr.type.name;
      const resTy = `%${resEnum}`;
      const resLayout = this.enumLayouts.get(resEnum);
      const srcLayout = this.enumLayouts.get(expr.enumName);
      if (!resLayout || !srcLayout) throw new Error(`enum layout not found for ${resEnum}/${expr.enumName}`);
      const resOk = resLayout.variants.get("Ok");
      const resErr = resLayout.variants.get("Err");
      const srcOk = srcLayout.variants.get("Ok");
      const srcErr = srcLayout.variants.get("Err");
      if (!resOk || !resErr || !srcOk || !srcErr) throw new Error("Result enum missing Ok/Err variants");

      // The closure value is built unconditionally (just a {fn,env} pair); only the CALL is
      // conditional, so a side-effecting callback runs on exactly one branch.
      const [cl, cv] = this.genExpr(expr.default!);
      lines.push(...cl);
      const fnPtr = this.nextTemp();
      lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
      const envPtr = this.nextTemp();
      lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

      const resAddr = `%__resmap.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${resAddr} = alloca ${resTy}`);
      lines.push(`  store ${resTy} zeroinitializer, ptr ${resAddr}`);

      const okLabel = this.nextLabel("resmap.ok");
      const errLabel = this.nextLabel("resmap.err");
      const contLabel = this.nextLabel("resmap.cont");
      lines.push(`  br i1 ${isSome}, label %${okLabel}, label %${errLabel}`);

      // the checker types the callback param as &X, so the payload goes by pointer — that is
      // what keeps a non-Copy payload from being moved out of the receiver
      const cbType = expr.default!.type;
      const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
      const srcPayload = (variant: EnumVariant): string => this.enumPayloadPtr(lines, enumTy, addr, variant);
      const callArgOf = (variant: EnumVariant, srcFieldTy: string): [string, string] => {
        const p = srcPayload(variant);
        if (paramIsRef) return [p, "ptr"];
        const loaded = this.nextTemp();
        lines.push(`  ${loaded} = load ${srcFieldTy}, ptr ${p}`);
        return [loaded, srcFieldTy];
      };
      // The callback only BORROWED the payload it was handed (`&T`/`&E`), the combinator
      // consumed the receiver, and nothing forwards that payload into the result, so after
      // the call nothing refers to it and nothing else would free it. Every combinator's
      // callback side needs this, not just `map`: `mk().andThen((s: &string) => ...)` leaked
      // the Ok payload and `mapErr`/`orElse` the Err payload, named receiver or temporary.
      // Only when this op owns the receiver: a temporary, or a named one the checker moved
      // in. A receiver whose forwarded payload is Copy is NOT consumed, still owns the lent
      // payload and drops it at scope exit, so dropping it here too was a double free
      // (`let r: Result<string, i64> = ...; r.map(...)` freed the string twice).
      const ownsReceiver = receiverMoved || this.isOwnedTempExpr(expr.value);
      // Set by the branch that just ran, so the ledger ends the receiver as DROP exactly
      // when a drop was emitted rather than when one was expected.
      let lentDropped = false;
      const dropLentPayload = (arg: string) => {
        if (!ownsReceiver || !paramIsRef || cbType.tag !== "fn") return;
        const first = cbType.params[0];
        if (first.tag === "ref" && this.needsDropCg(first.inner)) { this.emitDropValue(lines, arg, first.inner); lentDropped = true; }
      };
      const storeTag = (tag: number) => {
        this.storeEnumTag(lines, resTy, resAddr, tag);
      };
      const storePayload = (tag: number, ty: string, val: string) => {
        const pp = this.enumPayloadPtr(lines, resTy, resAddr, tag);
        lines.push(`  store ${ty} ${val}, ptr ${pp}`);
      };
      // forward the untouched side's payload verbatim; the result variant's slot is at least
      // as wide because that side's type is unchanged
      const copyThrough = (src: EnumVariant, tag: number) => {
        storeTag(tag);
        const srcFieldTy = src.fieldTypes[0];
        if (!srcFieldTy) return;
        const p = srcPayload(src);
        const v = this.nextTemp();
        lines.push(`  ${v} = load ${srcFieldTy}, ptr ${p}`);
        storePayload(tag, srcFieldTy, v);
      };

      lines.push(`${okLabel}:`);
      if (expr.op === "resultMapErr" || expr.op === "resultOrElse") {
        copyThrough(srcOk, resOk.tag);
      } else if (expr.op === "resultAndThen") {
        // the callback already returns the whole Result — store it wholesale, no re-tagging
        const [arg, argTy] = callArgOf(srcOk, srcOk.fieldTypes[0] ?? "i64");
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        dropLentPayload(arg);
        lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
      } else {
        const [arg, argTy] = callArgOf(srcOk, srcOk.fieldTypes[0] ?? "i64");
        const outTy = resOk.fieldTypes[0] ?? "i64";
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${outTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        // `Result<string,_>.map(v => v.len)` leaked its string every time. It stayed
        // invisible because the leak gate measures at -O2, where LLVM deletes an allocation
        // nothing observes; at -O0 it was always there.
        dropLentPayload(arg);
        storeTag(resOk.tag);
        storePayload(resOk.tag, outTy, called);
      }
      this.own.endResultRecv(lines, addr, expr.op === "resultMap" || expr.op === "resultAndThen", srcOk, paramIsRef, lentDropped);
      lentDropped = false;
      lines.push(`  br label %${contLabel}`);

      lines.push(`${errLabel}:`);
      if (expr.op === "resultMapErr") {
        const [arg, argTy] = callArgOf(srcErr, srcErr.fieldTypes[0] ?? "i64");
        const outTy = resErr.fieldTypes[0] ?? "i64";
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${outTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        dropLentPayload(arg);
        storeTag(resErr.tag);
        storePayload(resErr.tag, outTy, called);
      } else if (expr.op === "resultOrElse") {
        // mirror of andThen on the other side: the callback returns the whole Result
        const [arg, argTy] = callArgOf(srcErr, srcErr.fieldTypes[0] ?? "i64");
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        dropLentPayload(arg);
        lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
      } else {
        copyThrough(srcErr, resErr.tag);
      }
      this.own.endResultRecv(lines, addr, expr.op === "resultMapErr" || expr.op === "resultOrElse", srcErr, paramIsRef, lentDropped);
      lines.push(`  br label %${contLabel}`);

      lines.push(`${contLabel}:`);
      const out = this.nextTemp();
      lines.push(`  ${out} = load ${resTy}, ptr ${resAddr}`);
      return [lines, out, resTy];
    }

    // unwrapOr / unwrapOrElse
    const payloadTy = this.llvmType(expr.type);
    const payloadPtr = this.enumPayloadPtr(lines, enumTy, addr, 0);
    const payload = this.nextTemp();
    lines.push(`  ${payload} = load ${payloadTy}, ptr ${payloadPtr}`);

    // unwrapOrElse must BRANCH, not select: select evaluates both arms, which would call
    // the closure even when Some — the exact thing the caller chose unwrapOrElse to avoid.
    if (expr.op === "unwrapOrElse" || expr.op === "resultUnwrapOrElse") {
      const someLabel = this.nextLabel("uoe.some");
      const noneLabel = this.nextLabel("uoe.none");
      const contLabel = this.nextLabel("uoe.cont");
      lines.push(`  br i1 ${isSome}, label %${someLabel}, label %${noneLabel}`);
      lines.push(`${someLabel}:`);
      lines.push(`  br label %${contLabel}`);
      lines.push(`${noneLabel}:`);
      const [cl, cv] = this.genExpr(expr.default!);
      lines.push(...cl);
      const fnPtr = this.nextTemp();
      lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
      const envPtr = this.nextTemp();
      lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);
      // Result's version is handed the error, read from the Err variant's own payload
      // offset (not the Ok one loaded above) — by pointer when the param is `&E`.
      let errArgs = "";
      // A by-value error param is handed the Err payload itself, so the receiver no longer
      // owns it and must not be dropped after the call.
      let errMoved = false;
      if (expr.op === "resultUnwrapOrElse") {
        const srcErr = must(must(this.enumLayouts, expr.enumName, "enum layouts").variants, "Err", "Result variants");
        const errPtr = this.enumPayloadPtr(lines, enumTy, addr, srcErr);
        const cbType = expr.default!.type;
        const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
        if (paramIsRef) {
          errArgs = `, ptr ${errPtr}`;
        } else {
          const srcErrTy = srcErr.fieldTypes[0];
          const loaded = this.nextTemp();
          lines.push(`  ${loaded} = load ${srcErrTy}, ptr ${errPtr}`);
          errArgs = `, ${srcErrTy} ${loaded}`;
          errMoved = true;
        }
      }
      const called = this.nextTemp();
      lines.push(`  ${called} = call ${payloadTy} ${fnPtr}(ptr ${envPtr}${errArgs})`);
      // The closure body may itself branch, so the incoming block for the phi is
      // wherever control actually ended up — not noneLabel.
      const noneEnd = this.nextLabel("uoe.none.end");
      lines.push(`  br label %${noneEnd}`);
      lines.push(`${noneEnd}:`);
      lines.push(`  br label %${contLabel}`);
      lines.push(`${contLabel}:`);
      const r = this.nextTemp();
      lines.push(`  ${r} = phi ${payloadTy} [ ${payload}, %${someLabel} ], [ ${called}, %${noneEnd} ]`);
      if (!errMoved) releaseTempReceiver();
      return [lines, r, payloadTy];
    }

    const [dl, dv] = this.genExpr(expr.default!);
    lines.push(...dl);
    const r = this.nextTemp();
    lines.push(`  ${r} = select i1 ${isSome}, ${payloadTy} ${payload}, ${payloadTy} ${dv}`);
    releaseTempReceiver();
    return [lines, r, payloadTy];
  }

  private usedSatIntrinsics?: Set<string>;

  // LLVM encodes a float or double constant as a raw 64-bit hex pattern, but a
  // `float` operand only accepts a pattern that is exactly representable in
  // single precision. Emitting the double bits of 0.1 for an f32 field is a hard
  // LLVM error ("floating point constant invalid for type"), so round through
  // f32 first when that is the operand type.
  private formatFloatBits(v: number, llvmTy = "double"): string {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = llvmTy === "float" ? Math.fround(v) : v;
    const bits = new BigUint64Array(buf)[0];
    return `0x${bits.toString(16).toUpperCase().padStart(16, "0")}`;
  }

  // Fold a compile-time-constant numeric expression (literals + arithmetic on
  // them) to an int/float value. The checker's isConstGlobalInit already admits
  // BinOp/UnaryOp of constants as valid global initializers, but without this
  // fold codegen fell through to "0" and silently zeroed them (e.g. a global
  // `let x: f64 = a / b` became 0.0). Int math stays in bigint to preserve i64
  // precision; float math promotes to Number.
  private tryConstNumeric(
    expr: import("./hir").HIRExpr,
  ): { kind: "int"; v: bigint } | { kind: "float"; v: number } | null {
    switch (expr.kind) {
      case "IntLit": return { kind: "int", v: BigInt(expr.value) };
      case "FloatLit": return { kind: "float", v: expr.value };
      case "BoolLit": return { kind: "int", v: expr.value ? 1n : 0n };
      case "UnaryOp": {
        const o = this.tryConstNumeric(expr.operand);
        if (!o) return null;
        if (expr.op === "-") return o.kind === "float" ? { kind: "float", v: -o.v } : { kind: "int", v: -o.v };
        if (expr.op === "~" && o.kind === "int") return { kind: "int", v: -o.v - 1n }; // two's-complement bitwise-not
        if (expr.op === "!" && o.kind === "int") return { kind: "int", v: o.v === 0n ? 1n : 0n };
        return null;
      }
      case "Cast": {
        const o = this.tryConstNumeric(expr.operand);
        if (!o) return null;
        if (expr.targetType.tag === "float") return { kind: "float", v: o.kind === "float" ? o.v : Number(o.v) };
        if (expr.targetType.tag === "int") return { kind: "int", v: o.kind === "float" ? BigInt(Math.trunc(o.v)) : o.v };
        return null;
      }
      case "BinOp": {
        const l = this.tryConstNumeric(expr.left);
        const r = this.tryConstNumeric(expr.right);
        if (!l || !r) return null;
        const asFloat = expr.type.tag === "float" || l.kind === "float" || r.kind === "float";
        if (asFloat) {
          const a = l.kind === "float" ? l.v : Number(l.v);
          const b = r.kind === "float" ? r.v : Number(r.v);
          switch (expr.op) {
            case "+": return { kind: "float", v: a + b };
            case "-": return { kind: "float", v: a - b };
            case "*": return { kind: "float", v: a * b };
            case "/": return { kind: "float", v: a / b };
            default: return null;
          }
        }
        const a = l.v as bigint, b = r.v as bigint;
        switch (expr.op) {
          case "+": return { kind: "int", v: a + b };
          case "-": return { kind: "int", v: a - b };
          case "*": return { kind: "int", v: a * b };
          case "/": return b === 0n ? null : { kind: "int", v: a / b };  // bigint / truncates toward zero, matches sdiv
          case "%": return b === 0n ? null : { kind: "int", v: a % b };
          case "<<": return { kind: "int", v: a << b };
          case ">>": return { kind: "int", v: a >> b };
          case "&": return { kind: "int", v: a & b };
          case "|": return { kind: "int", v: a | b };
          case "^": return { kind: "int", v: a ^ b };
          default: return null;
        }
      }
      default: return null;
    }
  }

  private tryConstantExpr(expr: import("./hir").HIRExpr): string | null {
    switch (expr.kind) {
      case "IntLit": return expr.value.toString();
      case "FloatLit": return this.formatFloatBits(expr.value);
      case "BoolLit": return expr.value ? "1" : "0";
      case "BinOp":
      case "UnaryOp": {
        const n = this.tryConstNumeric(expr);
        if (n === null) return null;
        return n.kind === "float" ? this.formatFloatBits(n.v) : n.v.toString();
      }
      case "Cast":
        if (expr.type.tag === "ptr") return "null";
        if (expr.type.tag === "int" || expr.type.tag === "float") {
          const n = this.tryConstNumeric(expr);
          if (n !== null) return n.kind === "float" ? this.formatFloatBits(n.v) : n.v.toString();
        }
        return null;
      case "StructLit": {
        const layout = this.structLayouts.get(expr.name);
        // A struct-update base is a run-time value even when every field is listed.
        if (!layout || expr.base) return null;
        const fieldVals: string[] = [];
        for (const lf of layout.fields) {
          const ef = expr.fields.find(f => f.name === lf.name);
          if (!ef) return null;
          const val = this.tryConstantExpr(ef.value);
          if (val === null) return null;
          fieldVals.push(`${lf.type} ${val}`);
        }
        return `{ ${fieldVals.join(", ")} }`;
      }
      case "ArrayLit": {
        if (expr.type.tag !== "array" || expr.type.size === null) return null;
        const elemTy = this.llvmType(expr.type.element);
        const elemVals: string[] = [];
        for (const elem of expr.elements) {
          const val = this.tryConstantExpr(elem);
          if (val === null) return null;
          elemVals.push(`${elemTy} ${val}`);
        }
        return `[${elemVals.join(", ")}]`;
      }
      case "ArrayRepeat": {
        const elemKind = expr.type.tag === "array" ? expr.type.element : { tag: "int" as const, bits: 32, signed: true };
        const elemTy = this.llvmType(elemKind);
        const val = this.tryConstantExpr(expr.value);
        if (val === null) return null;
        if (val === "0" || val === "zeroinitializer") return "zeroinitializer";
        const elems = Array(expr.count).fill(`${elemTy} ${val}`);
        return `[${elems.join(", ")}]`;
      }
      default:
        return null;
    }
  }

  // Whether the LLVM constant initializer captures the whole value. A struct literal
  // with a non-const field lowers to a *partial* constant (that field zeroed), so it
  // still needs the runtime pass — this is the check that decides which globals go in
  // @__milo_global_init, and answering "yes" for a partial init is how a field silently
  // stays empty.
  private isFullyConstInit(g: import("./hir").HIRGlobal): boolean {
    if (this.tryConstantExpr(g.value) !== null) return true;
    if (g.value?.kind !== "StructLit" || g.value.base) return false;
    const layout = this.structLayouts.get(g.type.tag === "struct" ? g.type.name : "");
    if (!layout) return false;
    const byName = new Map(g.value.fields.map(f => [f.name, f.value]));
    return layout.fields.every(f => {
      const e = byName.get(f.name);
      return !e || this.tryConstantExpr(e) !== null;
    });
  }

  private getConstantInitializer(g: import("./hir").HIRGlobal): string {
    const constVal = this.tryConstantExpr(g.value);
    if (constVal !== null) return constVal;
    // A struct literal is not a single constant expression, but its fields usually
    // are. Falling straight through to zeroinitializer silently discarded them —
    // `S { a: -1, c: 42 }` came out as all zeros, which is the exact failure the
    // non-const module-scope check exists to prevent.
    const structInit = this.tryConstantStructInit(g.value, g.type);
    if (structInit !== null) return structInit;
    // zeroinitializer is valid for every LLVM type, scalars included. Classifying by
    // type tag here to pick between "0"/"null"/"zeroinitializer" is what got a
    // `double 0` (and `{ ptr, ptr } 0`) past codegen and into a clang parse error:
    // "0" is only legal for integer and i1, and the tag list only covered aggregates.
    return "zeroinitializer";
  }

  // Build an LLVM constant struct from a struct-literal global. Fields that are not
  // compile-time constants (Vec.new(), String literals needing a heap buffer, any
  // computed scalar) fall back to zeroinitializer for that field alone, which is their
  // correct empty form; the runtime global-init pass fills them in.
  private tryConstantStructInit(value: import("./hir").HIRExpr, type: TypeKind): string | null {
    if (!value || value.kind !== "StructLit" || value.base || type.tag !== "struct") return null;
    const layout = this.structLayouts.get(type.name);
    if (!layout) return null;
    const byName = new Map(value.fields.map(f => [f.name, f.value]));
    const parts: string[] = [];
    for (const f of layout.fields) {
      const expr = byName.get(f.name);
      const c = expr ? this.tryConstantExpr(expr) : null;
      // Same reason as getConstantInitializer: zeroinitializer covers every field type,
      // so there is nothing to classify. A `double`/`float` field used to emit `0`.
      parts.push(`${f.type} ${c !== null ? c : "zeroinitializer"}`);
    }
    return `{ ${parts.join(", ")} }`;
  }

  // Locals drop in REVERSE declaration order, the RAII convention (Rust, C++) and what
  // struct fields already did: a later local is the one most likely to depend on an
  // earlier one (a writer on its file, a lock on its mutex), so it goes first. Before
  // 2026-09-21 locals dropped in declaration order and fields in reverse, and nothing
  // documented either.
  private emitDropGlue(lines: string[]) {
    for (let i = this.droppableLocals.length - 1; i >= 0; i--) {
      this.emitGuardedDrop(lines, this.droppableLocals[i]);
    }
  }

  // Block-scope drop: drop the droppable locals declared in [start, end) at the
  // end of the innermost block that owns them, instead of waiting for the whole
  // function's epilogue. `start` is captured as droppableLocals.length at block
  // entry; everything pushed since then is a local of this block. Additive and
  // idempotent — emitGuardedDrop clears the alive flag and zeroes the slot, so the
  // enclosing/epilogue drops (and a loop body's next-iteration re-init) see a dead
  // slot and no-op. A value moved out of the block was already zeroed at the move,
  // so its block-end drop is a no-op too. This is exactly the mechanism genMatch
  // already uses for match-arm bindings, generalized to if/loop/unsafe blocks.
  private emitScopeDrops(lines: string[], start: number) {
    for (let d = this.droppableLocals.length - 1; d >= start; d--) {
      this.emitGuardedDrop(lines, this.droppableLocals[d]);
    }
  }

  private enterLoopBodyPending() {
    this.pend.loopTemps = this.pend.temps.length;
    this.pend.loopArgTemps = this.argTempDrops.length;
  }

  private emitLoopDropGlue(lines: string[]) {
    for (let i = this.droppableLocals.length - 1; i >= this.loopDropStart; i--) {
      this.emitGuardedDrop(lines, this.droppableLocals[i]);
    }
  }

  // A whole-variable assignment gives the slot a live value again. Moving out of a
  // droppable local cleared its alive flag (and a capture's env flag), and nothing set it
  // back, so `let t = s; s = mk()` (or a closure chain rebuilt in a loop) leaked the new
  // value: the scope-exit drop still read the flag the move left behind.
  private rearmAssignedLocal(lines: string[], target: HIRExpr) {
    if (target.kind !== "Ident" || !this.needsDropCg(target.type)) return;
    const local = this.locals.get(target.name);
    if (!local || local.isRef) return;
    const addr = this.localAddr(target.name);
    const dl = this.droppableLocals.find(d => d.addr === addr);
    if (dl) this.own.setAlive(lines, dl.aliveFlag, dl.addr, "reassign");
    const capFlag = this.captureFlagByAddr.get(addr);
    if (capFlag) lines.push(`  store i1 1, ptr ${capFlag}`);
  }

  // ---- Field-move flags.
  //
  // Moving a field out of a local (`take(e.value)`, `let { a, b } = s`) zeroes the field,
  // and the local's drop glue later visits the zeroed bytes. That is only harmless when the
  // zeroed form drops to nothing, which holds for strings and collections but not for a
  // type with a user Drop: `Res { id: 0 }` is a live-looking value, so its Drop ran a
  // second time on the leftover. A field whose drop runs a user Drop therefore gets its
  // own run-time liveness flag, exactly like a local's alive flag: set when the local is
  // armed, cleared by the move, set again by an assignment to the field, and tested where
  // the local (or the field) is dropped, which then goes field by field. The checker
  // rejects moving out of a struct that itself has a Drop impl, so dropping the parents
  // field by field is the same as running their glue.

  // Names (in the function being generated) of locals some field of which is moved out,
  // with the moved paths ("value", "inner.value"). Keyed by name, not binding: a shadowed
  // name only gets flags that are never cleared, which drop the same as no flags.
  private partialMovePaths = new Map<string, Set<string>>();
  // Slot address of a local -> moved path -> its flag.
  private fieldMoveFlags = new Map<string, Map<string, string>>();

  // `e.a.b` → { root: "e", path: "a.b" }; null unless every step is a by-value struct field.
  private fieldMovePlace(expr: HIRExpr & { kind: "FieldAccess" }): { root: string; path: string } | null {
    const parts: string[] = [expr.field];
    let cur: HIRExpr = expr.object;
    while (cur.kind === "FieldAccess") {
      if (cur.type.tag !== "struct") return null;
      parts.unshift(cur.field);
      cur = cur.object;
    }
    if (cur.kind !== "Ident" || cur.type.tag !== "struct") return null;
    return { root: cur.name, path: parts.join(".") };
  }

  private scanPartialMoves(body: unknown): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.kind === "FieldAccess" && o.isMove) {
        const fa = o as unknown as HIRExpr & { kind: "FieldAccess" };
        const place = this.typeRunsUserDrop(fa.type) ? this.fieldMovePlace(fa) : null;
        if (place) {
          let s = out.get(place.root);
          if (!s) { s = new Set(); out.set(place.root, s); }
          s.add(place.path);
        }
      }
      for (const k in o) if (k !== "type" && k !== "span" && k !== "retType") walk(o[k]);
    };
    walk(body);
    return out;
  }

  // Give the local at `addr` a flag for each of its moved paths. `sink` receives the
  // allocas (the entry block for a `let`, the prologue for a parameter); the flags start
  // dead and ownSetAlive arms them with the local.
  public registerFieldFlags(sink: string[], addr: string, name: string, type: TypeKind) {
    const paths = this.partialMovePaths.get(name);
    if (!paths || type.tag !== "struct" || this.fieldMoveFlags.has(addr)) return;
    const flags = new Map<string, string>();
    for (const path of paths) {
      const t = this.fieldTypeAtPath(type, path);
      if (!t || !this.typeRunsUserDrop(t)) continue;
      const flag = `${addr}.fmv.${path}`;
      sink.push(`  ${flag} = alloca i1`);
      sink.push(`  store i1 0, ptr ${flag}`);
      flags.set(path, flag);
    }
    if (flags.size > 0) this.fieldMoveFlags.set(addr, flags);
  }

  private fieldTypeAtPath(type: TypeKind, path: string): TypeKind | null {
    let t: TypeKind = type;
    for (const f of path.split(".")) {
      if (t.tag !== "struct") return null;
      const field = this.structLayouts.get(t.name)?.fields.find(x => x.name === f);
      if (!field) return null;
      t = field.typeKind;
    }
    return t;
  }

  // The flag of the field `expr` moves out of a local, cleared here; null when it has none.
  private clearFieldMoveFlag(lines: string[], expr: HIRExpr & { kind: "FieldAccess" }) {
    if (!this.typeRunsUserDrop(expr.type)) return;
    const place = this.fieldMovePlace(expr);
    const local = place && this.locals.get(place.root);
    if (!place || !local || local.isRef) return;
    const addr = this.localAddr(place.root);
    const flag = this.fieldMoveFlags.get(addr)?.get(place.path);
    if (flag) lines.push(`  store i1 0, ptr ${flag}`);
    // Ledger: the field leaves its parent's ID. A later whole drop of the parent (one that
    // does not go field by field) is then the double drop this class of bug is.
    if (!this.own.on) return;
    const pid = this.own.slots.get(addr);
    if (pid) lines.push(`  call void @__milo_own_part(i64 ${pid}, i64 ${this.own.partId(addr, place.path, flag)})`);
  }

  // Drop the value of `type` at `ptr`, the place `prefix` of the local whose flags are
  // `flags` ("" for the local itself): a flagged place drops only when its flag says it is
  // still there, and a place with flagged places under it drops field by field.
  private emitDropPlace(lines: string[], ptr: string, type: TypeKind, flags: Map<string, string>, prefix: string) {
    const under = [...flags.keys()].some(p => prefix === "" || p.startsWith(`${prefix}.`));
    const body = () => {
      if (!under || type.tag !== "struct") { this.emitDropValue(lines, ptr, type); return; }
      const layout = must(this.structLayouts, type.name, "struct layouts");
      for (let i = layout.fields.length - 1; i >= 0; i--) {
        const f = layout.fields[i];
        if (!this.needsDropCg(f.typeKind)) continue;
        const fp = this.nextTemp();
        lines.push(`  ${fp} = getelementptr %${type.name}, ptr ${ptr}, i32 0, i32 ${i}`);
        this.emitDropPlace(lines, fp, f.typeKind, flags, prefix === "" ? f.name : `${prefix}.${f.name}`);
      }
    };
    // The whole local dropped outside its guarded drop (an assignment's overwrite) ends
    // its ID here, as emitDropValue's DROPZ would, but without claiming the moved fields.
    if (prefix === "" && this.own.on && !this.own.inGuard) this.own.end(lines, this.own.slots.get(ptr), "DROPZF");
    const own = prefix === "" ? undefined : flags.get(prefix);
    if (!own) { body(); return; }
    const c = this.nextTemp();
    lines.push(`  ${c} = load i1, ptr ${own}`);
    const fid = this.own.on ? this.own.flagId(own) : 0;
    if (fid) lines.push(`  call void @__milo_own_guard(i64 ${fid}, i1 ${c})`);
    const liveL = this.nextLabel("fmv.live"), skipL = this.nextLabel("fmv.skip");
    lines.push(`  br i1 ${c}, label %${liveL}, label %${skipL}`);
    lines.push(`${liveL}:`);
    body();
    if (fid) this.own.end(lines, fid, "DROP");
    lines.push(`  store i1 0, ptr ${own}`);
    lines.push(`  br label %${skipL}`);
    lines.push(`${skipL}:`);
  }

  // The flags of a local's places at or under `path` ("" for the whole local), or null.
  private flagsCovering(target: HIRExpr): { flags: Map<string, string>; path: string } | null {
    if (this.fieldMoveFlags.size === 0) return null;
    let root: string, path: string;
    if (target.kind === "Ident") { root = target.name; path = ""; }
    else if (target.kind === "FieldAccess") {
      const place = this.fieldMovePlace(target);
      if (!place) return null;
      root = place.root; path = place.path;
    } else return null;
    const local = this.locals.get(root);
    if (!local || local.isRef) return null;
    const flags = this.fieldMoveFlags.get(this.localAddr(root));
    if (!flags) return null;
    const hit = [...flags.keys()].some(p => path === "" || p === path || p.startsWith(`${path}.`));
    return hit ? { flags, path } : null;
  }

  // An assignment put a value back at `path`: every flagged place at or under it is there again.
  private rearmFieldFlags(lines: string[], cover: { flags: Map<string, string>; path: string }) {
    for (const [p, flag] of cover.flags) {
      if (cover.path !== "" && p !== cover.path && !p.startsWith(`${cover.path}.`)) continue;
      lines.push(`  store i1 1, ptr ${flag}`);
      if (this.own.on && cover.path !== "") lines.push(`  call void @__milo_own_make(i64 ${this.own.flagId(flag)}) ; own reassign-field L${this.own.srcLine}`);
    }
  }

  public emitGuardedDrop(lines: string[], local: DroppableLocal) {
    const check = this.nextTemp();
    lines.push(`  ${check} = load i1, ptr ${local.aliveFlag}`);
    const dropLabel = this.nextLabel("drop.alive");
    const skipLabel = this.nextLabel("drop.skip");
    const ownId = this.own.on ? this.own.flagId(local.aliveFlag) : 0;
    if (ownId) lines.push(`  call void @__milo_own_guard(i64 ${ownId}, i1 ${check})`);
    lines.push(`  br i1 ${check}, label %${dropLabel}, label %${skipLabel}`);
    lines.push(`${dropLabel}:`);
    const savedInGuard = this.own.inGuard;
    this.own.inGuard = true;
    const fieldFlags = local.consumeCursor ? undefined : this.fieldMoveFlags.get(local.addr);
    if (local.consumeCursor) this.emitConsumedTailDrop(lines, local.addr, local.typeKind, local.consumeCursor);
    else if (fieldFlags) this.emitDropPlace(lines, local.addr, local.typeKind, fieldFlags, "");
    else this.emitDropValue(lines, local.addr, local.typeKind);
    this.own.inGuard = savedInGuard;
    if (ownId) this.own.end(lines, ownId, fieldFlags ? "DROPF" : "DROP");
    // Make the guarded drop idempotent: clear the alive-flag and zero the slot.
    // A loop `break`/`continue` drops loop-scoped locals via emitLoopDropGlue;
    // without this, the function epilogue (after break) or the next iteration's
    // overwrite-drop (after continue) would free the same buffer again.
    lines.push(`  store i1 0, ptr ${local.aliveFlag}`);
    const slotTy = this.llvmType(local.typeKind);
    lines.push(this.zeroStore(slotTy, local.addr));
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }

}
