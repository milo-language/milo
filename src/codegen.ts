// HIR -> LLVM IR emission, including drop glue, monomorphization and the per-target
// calling conventions. IR uses opaque `ptr` (LLVM 15+), never `i8*`.
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRStruct, HIRGlobal } from "./hir";
import { LlvmTextBuilder, asGen, Ty, val, type Block, type Param, type Val } from "./ir";
import { guardLazyGlobals, LAZY_GUARD_PREFIX, LAZY_INIT_PREFIX } from "./lazy-globals";
import { type TypeKind } from "./types";
import type { TargetInfo } from "./target";
import { Layout, type EnumLayout, type EnumVariant, type EnumNiche } from "./layout";
import type { Span } from "./ast";
import { REALLOC_MIN_BYTES } from "./codegen-vec";
import { runtimeFn } from "./codegen-runtime";
import { armTailExpr, matchArmLocals } from "./codegen-match";
import {
  HASHMAP_FIELDS, HASH_SEED_FN,
} from "./codegen-map";
import { cDeclGuards, type CSigClaim, type CValueClaim } from "./c-guards";
import { DwarfEmitter } from "./codegen-dwarf";
import { classifyArg, classifyRet, AbiError, type ArgClass, type RetClass, type AbiStruct, type AbiLeaf } from "./abi";
import { resolve, relative, isAbsolute } from "path";
import { STDLIB_DIR } from "./stdlibBundle";
import { must } from "./must";
import {
  DropGlueSeen, emitDropValueBody, ensureStructDropHelper, } from "./codegen-drop";
import { display } from "./mangle";
import { mapSymbols } from "./cgu";

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
function noaliasEnabled(): boolean {
  return process.env.MILO_NOALIAS !== "0";
}

export const NOT_OWNED_TEMP: readonly string[] = [
  "ArrayLen", "ArrayRepeat", "BitIntrinsic", "BoolLit", "CFnCall", "Cast",
  "CharLit", "CheckedArith", "Closure", "EnumTryFrom", "FloatLit",
  "Forget", "HashMapLen",
"HeapCreate", "HeapPtr", "Ident",
  "IntLit", "InterfaceCoerce", "IsCheck", "MapAlloc", "MapHash", "MapKeyEq", "MapSeed", "MemSwap", "NatLess", "NonNegative", "VecGrowBuf", "VecPanic", "OffsetOf",
  "PtrDeref", "RangeCheck", "RawSlice", "SaturatingArith", "SizeOf", "StringCstr",
  "StrRangeCheck", "StringLen", "StringLit", "StrAlloc", "StrPanic", "StrReserve", "StrUnique", "StringPushInt", "StringPushStr", "StringSlice",
  "UnaryOp", "VecCapacity",

  "VecLen", "VecPtr",
  "VecSlice",
  "WrappingArith", "Zeroed",
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

export type { StructLayout, EnumLayout, EnumVariant, EnumNiche } from "./layout";

const i64c = (n: number | string) => val(String(n), Ty.i64);
const i32c = (n: number | string) => val(String(n), Ty.i32);
// For methods whose `val: string` parameter shadows the `val` import.
const V = val;
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

export class Codegen {
  public target: TargetInfo;
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  public fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean; wantsStringAddr?: boolean[]; refAttrs?: string[] }>();
  // milo fns whose big-aggregate return is lowered to a hidden `ptr %__sret.out`
  // first param. Excludes main and exported fns (C ABI).
  public sretFns = new Set<string>();
  // extern fns that pass/return a struct by value need native-ABI lowering (byval/sret/coerce)
  private externAbi = new Map<string, ExternAbiInfo>();
  // Type layout (src/layout.ts) is built once from the module at the top of generate();
  // the members below keep the names the other codegen files already use.
  public readonly layout = new Layout();
  get structLayouts() { return this.layout.structLayouts; }
  private cLayoutStructs: HIRStruct[] = [];
  // `extern type` names: a pointer to one is a C handle whose pointee Milo never sizes.
  private opaqueTypes = new Set<string>();
  private cSigs: CSigClaim[] = [];
  private cValues: CValueClaim[] = [];
  get enumLayouts() { return this.layout.enumLayouts; }
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
  private needsContractFail = false;
  public trapOnOverflow = false;
  // the MLIR path (src/mlir-backend.ts MlirPlan.take): the stub body for a function MLIR
  // compiles, which genFunction emits in place of a body.
  public mlirTake!: (fn: HIRFunction) => string[] | null;
  // Independent of trapOnOverflow: `requires`/`ensures`/`invariant` become runtime
  // asserts. Both default on at -O0 and off above it, but they answer different
  // questions, so `--contract-checks` / `--overflow-checks` set them separately.
  public contractChecks = false;
  private usedOverflowIntrinsics = new Set<string>();
  public needsPrintf = false;
  public needsDprintf = false;
  private needsFflush = false;
  private needsWrite = false;
  private needsPutchar = false;
  private needsFwrite = false;
  private needsIob = false;
  private needsStderrSym = false;
  private needsSetvbuf = false;
  public needsExit = false;
  public needsMalloc = false;
  public needsFree = false;
  public needsRealloc = false;
  private emittedIntFmt = false;
  private emittedStrReserve = false;
  private emittedStrRt = false;
  public needsMemcpy = false;
  private needsStrlen = false;
  public needsMemcmp = false;
  get hasStringType() { return this.layout.hasStringType; }
  set hasStringType(v: boolean) { this.layout.hasStringType = v; }
  get hasVecType() { return this.layout.hasVecType; }
  set hasVecType(v: boolean) { this.layout.hasVecType = v; }
  get hasHashMapType() { return this.layout.hasHashMapType; }
  set hasHashMapType(v: boolean) { this.layout.hasHashMapType = v; }
  public needsGetentropy = false;
  private needsStrtod = false;

  private globalVars = new Map<string, { type: string; typeKind: TypeKind }>();
  private userFnNames = new Set<string>();
  public exportedFnNames = new Set<string>();
  // Mangled symbol -> as-written name (src/mangle.ts). Codegen emits two things a human
  // reads: the `Name { .. }` text behind `print`/`$"…"`, and DWARF names.
  private displayNames?: Map<string, string>;
  // Droppable locals are identified by their slot ADDRESS. A function can hold
  // several locals with the same name in different scopes, so re-resolving a
  // name through the current scope picks an unrelated slot.
  // `consumeCursor`: the temporary a consuming for-in owns. Its
  // elements before the cursor were moved into the loop binding, so dropping it destroys
  // only [cursor, len) and then frees the buffer.
  get droppableEnums() { return this.layout.droppableEnums; }
  get dropImpls() { return this.layout.dropImpls; }
  public dropGlueSeen = new DropGlueSeen();
  private generatedFloatFmt = false;
  private generatedF64FormatHelper = false;
  private generatedF32FormatHelper = false;
  private needsStrtof = false;
  // Structural drop: free a value's heap storage without running any user Drop impl, the
  // exact inverse of the structural deep clone (which never runs a user Clone). A structural
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
  private emittedStrViewStep = false;
  private closureBodies: string[][] = [];
  // `&mut` params that carry pointer attributes, per fn: what applyNoalias may mark.
  // Per fn, its `&mut` params that may get noalias: name and position in the define line
  // (an sret fn's out pointer comes first). The position is what the MLIR path reads: its
  // spliced bodies number their params.
  private noaliasCandidates = new Map<string, { name: string; at: number }[]>();
  // Closures whose environment holds pointers to the creator's locals, for applyNoalias.
  private byRefClosures = new Set<string>();
  // Mutable module globals by IR name, for applyNoalias.
  private mutableGlobals = new Set<string>();
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
  // Set for the duration of a `@wrapping` function: + - * -x, div INT_MIN/-1 and over-shifts
  // use defined modular arithmetic instead of trapping. Div-by-zero, bounds, ranged still trap.
  public currentFnWrapping = false;
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
  public emitDebug = false;
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
  private usedDbgDeclare = false;

  constructor(target: TargetInfo, filePath?: string, trapOnOverflow = false, emitDebug = false, contractChecks = false, stripPanicLocations = false, sanitize = false) {
    this.target = target;
    this.layout.ptrBytes = target.arch === "arm" ? 4 : 8;
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
      b.ret();
      b.endFn();
      return lines;
    }
    // Fixed block and value names (not nextLabel/nextTemp draws): the body is a constant shape.
    const blk = (name: string): Block => ({ name });
    const named = (name: string, ty: Ty) => b.reserveNamed(name, ty);
    b.br(blk("rr.check0"));
    // Set and non-empty, matching std/replay, which treats an empty value as unset.
    const vars = ["MILO_RECORD", "MILO_REPLAY"];
    vars.forEach((_, i) => {
      const next = blk(i + 1 < vars.length ? `rr.check${i + 1}` : "rr.done");
      b.position(blk(`rr.check${i}`));
      const v = b.call(Ty.ptr, "@getenv", [V(`@.milo_rr_env${i}`, Ty.ptr)], named(`%v${i}`, Ty.ptr));
      const isNull = b.icmp("eq", v, V("null", Ty.ptr), named(`%null${i}`, Ty.i1));
      b.condBr(isNull, next, blk(`rr.byte${i}`));
      b.position(blk(`rr.byte${i}`));
      const first = b.load(Ty.i8, v, undefined, undefined, named(`%b${i}`, Ty.i8));
      const isEmpty = b.icmp("eq", first, V("0", Ty.i8), named(`%empty${i}`, Ty.i1));
      b.condBr(isEmpty, next, blk("rr.det"));
    });
    b.position(blk("rr.det"));
    // Any nonzero start works; this one spells "milorr".
    b.store(i64c("120364506550898"), V(`@${Codegen.RR_HASH_SEED_GLOBAL}`, Ty.ptr));
    b.br(blk("rr.done"));
    b.position(blk("rr.done"));
    b.ret();
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
    const blk = (name: string): Block => ({ name });
    const named = (name: string, ty: Ty) => b.reserveNamed(name, ty);
    const seed = V(`@${Codegen.RR_HASH_SEED_GLOBAL}`, Ty.ptr);
    b.defineFn({ name: HASH_SEED_FN, ret: Ty.i64, params: [], internal: true });
    const buf = b.alloca(Ty.i64, "%buf");
    const det = b.load(Ty.i64, seed, undefined, undefined, named("%det", Ty.i64));
    const isDet = b.icmp("ne", det, i64c(0), named("%isDet", Ty.i1));
    b.condBr(isDet, blk("seed.det"), blk("seed.os"));
    b.position(blk("seed.det"));
    // Golden-ratio step (0x9E3779B97F4A7C15): consecutive maps get well-spread seeds.
    // Atomic because maps can be built on Promise.blocking threads too; the sequence
    // is only reproducible for maps built in a reproducible order, which is the main
    // thread's. atomicrmw is not a builder op, so it stays text.
    lines.push(`  %old = atomicrmw add ptr @${Codegen.RR_HASH_SEED_GLOBAL}, i64 -7046029254386353131 monotonic`);
    const next = b.binop("add", V("%old", Ty.i64), i64c("-7046029254386353131"), named("%next", Ty.i64));
    b.ret(next);
    b.position(blk("seed.os"));
    // 2 = BCRYPT_USE_SYSTEM_PREFERRED_RNG, which is what permits the NULL algorithm
    // handle; the length is a 32-bit ULONG here, not getentropy's size_t.
    if (this.isWindows) b.callDiscard(Ty.i32, "@BCryptGenRandom", [V("null", Ty.ptr), buf, i32c(8), i32c(2)]);
    else b.callDiscard(Ty.i32, "@getentropy", [buf, i64c(8)]);
    b.ret(b.load(Ty.i64, buf, undefined, undefined, named("%v", Ty.i64)));
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
    const b = new LlvmTextBuilder(lines, this);
    const env = b.reserveTemp(Ty.ptr), isSet = b.reserveTemp(Ty.i1), handle = b.reserveTemp(Ty.ptr);
    // MSVC maps _IOLBF onto _IOFBF, so line buffering there does nothing; _IONBF (4) is
    // the mode that actually reaches the fd per write.
    const mode = this.isWindows ? 4 : 1;
    b.defineFn({ name: Codegen.LINE_BUF_INIT_FN, ret: Ty.void, params: [], internal: true });
    const setB: Block = { name: "linebuf.set" }, doneB: Block = { name: "linebuf.done" };
    b.call(Ty.ptr, "@getenv", [V("@.milo_line_buf_env", Ty.ptr)], env);
    b.icmp("ne", env, V("null", Ty.ptr), isSet);
    b.condBr(isSet, setB, doneB);
    b.position(setB);
    if (this.isWindows) b.call(Ty.ptr, "@__acrt_iob_func", [i32c(1)], handle);
    else b.load(Ty.ptr, V(`@${this.stdoutSymbol}`, Ty.ptr), undefined, undefined, handle);
    b.callDiscard(Ty.i32, "@setvbuf", [handle, V("null", Ty.ptr), i32c(mode), i64c(0)]);
    b.br(doneB);
    b.position(doneB);
    b.ret();
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
      // nobuiltin: a message that reaches here as a constant would otherwise become a
      // puts call (LLVM's libcall simplification), and the embedded runtime has none.
      lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtLabel}${argsStr}) nobuiltin`);
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

  // The dot is required: a parameter named `t0` is emitted as the LLVM value
  // `%t0` (see the param prologue), so a bare `%t${n}` counter collides with it
  // and LLVM rejects the module with "multiple definition of local value". Milo
  // identifiers cannot contain `.`, so this prefix cannot be reached from source.
  /** A builtin the program has not shadowed with its own fn of the same name. */
  public isBuiltinName(name: string): boolean { return Codegen.BUILTINS.has(name) && !this.userDeclaredFns.has(name); }
  public nextTemp(): string { return `%t.${this.tempCounter++}`; }
  public nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private emit(line: string) { this.output.push(line); }

  public llvmType(t: TypeKind): string { return this.layout.llvmType(t); }

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

  private nicheOfEnumTy(enumTy: string): EnumNiche | undefined { return this.layout.nicheOfEnumTy(enumTy); }

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

  private enumStorageTy(layout: EnumLayout): string { return this.layout.enumStorageTy(layout); }

  public enumVariantOf(enumTy: string, variant: EnumVariant | string | number): EnumVariant { return this.layout.enumVariantOf(enumTy, variant); }

  private variantFieldOffsets(fieldTypes: string[]): number[] { return this.layout.variantFieldOffsets(fieldTypes); }

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

  public typeSize(ty: string): number { return this.layout.typeSize(ty); }

  public typeSizeOf(t: TypeKind): number { return this.layout.typeSizeOf(t); }

  public mapSlotLayout(k: TypeKind, v: TypeKind): { size: number; keyOffset: number; valueOffset: number } { return this.layout.mapSlotLayout(k, v); }

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
  /** MLIR path: closureParamEscapes, for an owning closure handed to a plain fn param. */
  public mlirClosureParamEscapes(fnName: string, idx: number): boolean { return this.closureParamEscapes(fnName, idx); }

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

  public needsDropCg(t: TypeKind): boolean { return this.layout.needsDropCg(t); }

  public structNeedsDrop(name: string): boolean { return this.layout.structNeedsDrop(name); }

  private rangeMetaIds = new Map<string, number>();
  private noundefMetaId: number | null = null;

  private layoutExact(ty: string): boolean { return this.layout.layoutExact(ty); }

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

  private typeAlign(ty: string): number { return this.layout.typeAlign(ty); }

  private structAlign(fieldTypes: string[]): number { return this.layout.structAlign(fieldTypes); }

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
  /**
   * MLIR path: `milo.cabi.<f>`, a shim taking extern f's arguments as Milo passes them (a
   * struct by value as its %T) and calling f across the C ABI (emitExternAbiCall), or null
   * when f needs none. Text of the module, as the other scaffold routines.
   */
  public mlirCAbiShim(name: string, variadic: boolean): string | null {
    if (!this.externAbi.has(name)) return null;
    const shim = `milo.cabi.${name}`;
    if (this.emittedMlirWrites.has(shim)) return shim;
    this.emittedMlirWrites.add(shim);
    const sig = must(this.fnSigs, name, "fn sigs");
    const saved = this.tempCounter;
    this.tempCounter = 0;
    const lines: string[] = [];
    const ps = sig.paramTypes.map((t, i) => ({ name: `a${i}`, ty: t }));
    lines.push(`define internal ${sig.retType} @${shim}(${ps.map(p => `${p.ty} %${p.name}`).join(", ")}) {`, "entry:");
    const [, v, ty] = this.emitExternAbiCall({ kind: "Call", func: name, args: [], type: { tag: "void" }, variadic } as HIRExpr & { kind: "Call" },
      ps.map(p => ({ val: `%${p.name}`, type: p.ty })), lines);
    lines.push(ty === "void" ? "  ret void" : `  ret ${ty} ${v}`, "}");
    this.tempCounter = saved;
    this.helperFnBodies.push(lines);
    return shim;
  }

  private emitExternAbiCall(expr: HIRExpr & { kind: "Call" }, argVals: { val: string; type: string }[], lines: string[]): Gen {
    const abi = must(this.externAbi, expr.func, "extern abi");
    const sig = must(this.fnSigs, expr.func, "fn sigs");
    const lowered = this.externLoweredSig(expr.func);
    const finalArgs: string[] = [];
    const b = new LlvmTextBuilder(lines, this);

    // sret: caller allocates the result buffer and passes it as a hidden first arg
    let sretAlloca: Val | null = null;
    if (abi.ret.kind === "sret") {
      sretAlloca = b.alloca(Ty.of(`%${abi.ret.name}`));
      finalArgs.push(`ptr sret(%${abi.ret.name}) align ${abi.ret.align} ${sretAlloca.ref}`);
    }

    for (let i = 0; i < argVals.length; i++) {
      const cls = i < abi.args.length ? abi.args[i] : null; // variadic tail has no class
      const a = argVals[i];
      if (!cls || cls.kind === "direct") { finalArgs.push(`${a.type} ${a.val}`); continue; }
      if (cls.kind === "coerce") {
        // stage the struct in an i64-array buffer (>= struct size) so register loads stay in bounds
        const buf = b.alloca(Ty.of(`[${cls.container / 8} x i64]`));
        b.store(V(a.val, Ty.of(a.type)), buf);
        for (const r of cls.regs) {
          let p = buf;
          if (r.offset !== 0) p = b.gep(Ty.i8, buf, [i64c(r.offset)]);
          const v = b.load(Ty.of(r.ty), p);
          finalArgs.push(`${r.ty} ${v.ref}`);
        }
      } else { // indirect — pass a pointer to a private copy (byval attr on SysV)
        const buf = b.alloca(Ty.of(`%${cls.name}`));
        b.store(V(a.val, Ty.of(a.type)), buf);
        finalArgs.push(cls.byval ? `ptr byval(%${cls.name}) align ${cls.align} ${buf.ref}` : `ptr ${buf.ref}`);
      }
    }

    const argsStr = finalArgs.join(", ");
    let callPrefix = lowered.ret;
    if (expr.variadic) callPrefix = `${lowered.ret} (${lowered.params.join(", ")}, ...)`;

    // The calls below stay text: the callee type is spelled out (`ret (params, ...)` for a
    // variadic) and the sret/byval arguments carry attributes, which a Val cannot.
    if (abi.ret.kind === "sret") {
      lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
      return asGen(lines, b.load(Ty.of(`%${abi.ret.name}`), sretAlloca!));
    }
    if (abi.ret.kind === "coerce") {
      const raw = b.reserveTemp(Ty.of(abi.ret.retTy));
      lines.push(`  ${raw.ref} = call ${callPrefix} @${expr.func}(${argsStr})`);
      const buf = b.alloca(Ty.of(`[${abi.ret.container / 8} x i64]`));
      b.store(raw, buf);
      const structTy = sig.retType; // "%Name" for a struct return
      return asGen(lines, b.load(Ty.of(structTy), buf));
    }
    // scalar/void return, but arguments were ABI-rewritten
    if (lowered.ret === "void") {
      lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
      return [lines, "void", "void"];
    }
    const tmp = b.reserveTemp(Ty.of(lowered.ret));
    lines.push(`  ${tmp.ref} = call ${callPrefix} @${expr.func}(${argsStr})`);
    return [lines, tmp.ref, lowered.ret];
  }

  // The @cLayout/@cSig/@cValue guard TU (src/c-guards.ts), or null when nothing is claimed.
  cDeclGuards(): string | null {
    return cDeclGuards({ cLayoutStructs: this.cLayoutStructs, cSigs: this.cSigs, cValues: this.cValues, opaqueTypes: this.opaqueTypes, os: this.target.os }, this);
  }

  public structPayloadSize(fieldTypes: string[]): number { return this.layout.structPayloadSize(fieldTypes); }

  public structFieldOffset(fieldTypes: string[], fieldIdx: number): number { return this.layout.structFieldOffset(fieldTypes, fieldIdx); }

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
    const [argc, argv] = bMain.defineFn({ name: "main", ret: Ty.i32, params: [{ name: "_milo_argc", ty: Ty.i32 }, { name: "_milo_argv", ty: Ty.ptr }] });
    bMain.store(argc, V("@_milo_argc_global", Ty.ptr));
    bMain.store(argv, V("@_milo_argv_global", Ty.ptr));
    // before global init: an initializer can print, and setvbuf must precede any I/O
    this.emitStdoutBufferingOptIn(lines);
    if (this.needsGlobalInit) bMain.callDiscard(Ty.void, `@${GLOBAL_INIT_FN}`, []);
    bMain.callDiscard(Ty.void, `@${Codegen.GREEN_RUN_MAIN_FN}`, [V(`@${Codegen.MAIN_TASK_FN}`, Ty.ptr)]);
    bMain.ret(bMain.load(Ty.i32, V(`@${Codegen.MAIN_EXIT_GLOBAL}`, Ty.ptr), undefined, undefined, bMain.reserveNamed("%exit", Ty.i32)));
    bMain.endFn();
    lines.push("");
    // spawnWithStack calls this through the closure ABI, which passes an env
    // pointer this entry has no use for.
    const bTask = new LlvmTextBuilder(lines, this);
    bTask.defineFn({ name: Codegen.MAIN_TASK_FN, ret: Ty.void, params: [{ name: "__env", ty: Ty.ptr }], internal: true });
    const code = bTask.call(Ty.i32, `@${Codegen.MAIN_BODY_FN}`, [], bTask.reserveNamed("%code", Ty.i32));
    bTask.store(code, V(`@${Codegen.MAIN_EXIT_GLOBAL}`, Ty.ptr));
    bTask.ret();
    bTask.endFn();
    return lines;
  }

  generate(module: HIRModule): string {
    this.layout.build(module);
    for (const s of module.structs) if (s.cLayout) this.cLayoutStructs.push(s);
    this.cSigs = module.cSigs ?? [];
    this.opaqueTypes = new Set(module.opaqueTypes ?? []);
    this.cValues = module.cValues ?? [];

    // Every concrete impl of one interface has the same method count — it is the
    // interface's, not the type's — so this is well defined per interface name.
    for (const it of module.itables) this.ifaceMethodCounts.set(it.ifaceName, it.methods.length);

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
        // tell them apart, so record it here for the call's String coercion.
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
    // Generated with the bodies, not after them: it sets the needs* flags its printf and
    // abort declarations hang off.
    // The overflow and bounds routines too: MLIR bodies call them, and stubs set no flag.
    fnBodies.push(this.mlirPanicFn());
    this.needsOverflowCheck = this.needsBoundsCheck = this.needsPrintf = this.needsExit = true;

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
    if (this.needsContractFail) {
      this.emit("");
      for (const line of this.contractFailHelper()) this.emit(line);
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
    for (const [key, id] of this.rangeMetaIds) this.emit(`!${id} = !{${key}}`);
    if (this.noundefMetaId !== null) this.emit(`!${this.noundefMetaId} = !{}`);
    if (this.emitDebug) this.dwarf.apply(this.output);
    // After DwarfEmitter.apply: that pass matches `!dbg !N {` at the end of a define line,
    // and the attribute group this inserts sits before the metadata.
    if (this.sanitize) this.applySanitizeAttribute();

    if (this.fnSigs.has("replayHeapMalloc")) this.output = this.replayHeapCalls(this.output);
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
  // call form, receivers and moved arguments included) plus the runtime alias guards rule out a
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
  /** The noalias pass over the final module, every body MLIR's (no stubs). It runs last: it reads the final call graph, the replay heap's calls included. */
  public noaliasOnFinal(ir: string, closureBodies: string[]): string {
    if (!noaliasEnabled()) return ir;
    // MLIR's closure bodies are what may write a caller's locals (the pass seeds that from
    // byRefClosures). A move closure's are counted too: conservative, never unsound.
    for (const c of closureBodies) this.byRefClosures.add(c);
    // MLIR's translation quotes some uses of a symbol (`@"f$closure1"`) and not others;
    // the pass reads symbols unquoted, and a quoted one it cannot see is a closure it
    // thinks nobody takes the address of, or a call it thinks goes nowhere.
    const plain = ir.replace(/@"([\w$.\-]+)"/g, "@$1");
    return this.applyNoalias(plain.split("\n")).join("\n");
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
      for (const { name: p, at: k } of params) {
        const clash = [...(k >= 0 ? f.paramReach[k] : [])].filter(g => f.touches.has(g));
        // A global whose address went where the pass cannot follow may be reached through
        // any loaded pointer in any fn, not only by name, so it poisons every candidate.
        const why = opaque.has(name) ? "may run a closure or unknown code"
          : wild.size ? `address of ${[...wild].slice(0, 3).join(",")} escapes untracked`
          : clash.length ? `reaches and touches ${clash.slice(0, 3).join(",")}` : "";
        if (debug) console.error(`noalias ${name} %${p}: ${why ? `withheld (${why})` : "applied"}`);
        if (why) continue;
        // The k-th param of the define line, by position: the stub names it %p, MLIR %k.
        const open = l.indexOf("(", l.indexOf("@"));
        const ps = splitArgs(l.slice(open + 1));
        if (k < ps.length && /^\s*ptr nonnull dereferenceable\(\d+\) align \d+ %/.test(ps[k])) {
          ps[k] = ps[k].replace(/ptr nonnull/, "ptr noalias nonnull");
          const close = open + 1 + splitArgs(l.slice(open + 1)).join(",").length;
          l = l.slice(0, open + 1) + ps.join(",") + l.slice(close);
        }
      }
      out[f.start] = l;
    }
    return out;
  }

  // A record/replay engine fn (HIRFunction.replayEngine) raises its thread's engine depth
  // on entry and lowers it before every return, while the fixed heap is on: its
  // allocations then go to libc and leave the program's heap as the recording left it.
  // With the heap off (no MILO_RECORD/MILO_REPLAY) it is one load and branch each way.
  public get replayScope(): boolean { return this.globalVars.has("replay$rrDepth") && this.globalVars.has("replay$rrHeapOn"); }

  private replayEngineScope(fn: HIRFunction, lines: string[]): string[] {
    if (!fn.replayEngine || !this.replayScope) return lines;
    const out: string[] = [];
    // This pass rewrites finished lines, so its blocks and values carry fixed names derived
    // from a counter rather than the nextLabel/nextTemp draws, which would renumber the body.
    const b = new LlvmTextBuilder(out, this);
    const blk = (name: string): Block => ({ name });
    const depth = V("@replay$rrDepth", Ty.ptr);
    const named = (name: string, ty: Ty) => b.reserveNamed(name, ty);
    let n = 0;
    const on = () => {
      const id = n++;
      const heapOn = b.load(Ty.i64, V("@replay$rrHeapOn", Ty.ptr), undefined, undefined, named(`%rre.on.${id}`, Ty.i64));
      const c = b.icmp("ne", heapOn, i64c(0), named(`%rre.c.${id}`, Ty.i1));
      return { id, c };
    };
    let entered = false;
    for (const l of lines) {
      if (!entered && l === "entry.bb:") {
        out.push(l);
        const { id, c } = on();
        b.condBr(c, blk(`rre.in.${id}`), blk(`rre.go.${id}`));
        b.position(blk(`rre.in.${id}`));
        const d = b.load(Ty.i64, depth, undefined, undefined, named(`%rre.d.${id}`, Ty.i64));
        const d1 = b.binop("add", d, i64c(1), named(`%rre.d1.${id}`, Ty.i64));
        b.store(d1, depth);
        b.br(blk(`rre.go.${id}`));
        b.position(blk(`rre.go.${id}`));
        entered = true;
        continue;
      }
      if (entered && /^\s+ret\b/.test(l)) {
        const { id, c } = on();
        const d = b.load(Ty.i64, depth, undefined, undefined, named(`%rre.d.${id}`, Ty.i64));
        const pos = b.icmp("sgt", d, i64c(0), named(`%rre.pos.${id}`, Ty.i1));
        const both = b.binop("and", c, pos, named(`%rre.both.${id}`, Ty.i1));
        b.condBr(both, blk(`rre.out.${id}`), blk(`rre.ret.${id}`));
        b.position(blk(`rre.out.${id}`));
        const d1 = b.binop("sub", d, i64c(1), named(`%rre.d1.${id}`, Ty.i64));
        b.store(d1, depth);
        b.br(blk(`rre.ret.${id}`));
        b.position(blk(`rre.ret.${id}`));
      }
      out.push(l);
    }
    return entered ? out : lines;
  }

  private genFunction(fn: HIRFunction): string[] {
    const mlirStub = this.mlirTake(fn);
    if (!mlirStub) throw new Error(`codegen: no MLIR body for ${fn.name}`);
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.entryAllocas = [];
    this.emittedAddrs.clear();
    this.currentFnWrapping = !!fn.isWrapping;
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);

    const params: Param[] = fn.params.map(p => {
      const ty = p.isRef || p.isRefMut ? Ty.ptr : Ty.of(this.llvmType(p.type));
      const attrs = this.refParamAttrs(fn, p);
      if (attrs && p.isRefMut) {
        const c = this.noaliasCandidates.get(fn.name) ?? [];
        c.push({ name: p.name, at: fn.params.indexOf(p) + (this.sretFns.has(fn.name) ? 1 : 0) });
        this.noaliasCandidates.set(fn.name, c);
      }
      return { name: p.name, ty, attrs };
    });
    // main is the process entry point: the OS reads its return register as the exit code, so it
    // must always be i32 even when the Milo signature is void (`fn main()`). A `void @main` leaves
    // garbage in the return register → nonzero exit on a program that should succeed.
    const isSret = this.sretFns.has(fn.name);
    const ret = fn.name === "main" ? "i32" : isSret ? "void" : this.llvmType(fn.retType);
    const dbg = this.emitDebug ? this.dwarf.diSubprogram(fn) : undefined;
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
      b.defineFn({ name: fn.name, ret: Ty.of(ret), params: allParams, internal: !this.exportedFnNames.has(fn.name), dbg, ...(fn.alwaysInline && { attrs: " alwaysinline" }) });
    }
    if (fn.name === "main" && !this.wrapMainGreen) {
      b.store(V("%_milo_argc", Ty.i32), V("@_milo_argc_global", Ty.ptr));
      b.store(V("%_milo_argv", Ty.ptr), V("@_milo_argv_global", Ty.ptr));
      // before global init: an initializer can print, and setvbuf must precede any I/O
      this.emitStdoutBufferingOptIn(lines);
      // after argc/argv: a global initializer may read them (argparse-style defaults)
      if (this.needsGlobalInit) b.callDiscard(Ty.void, `@${GLOBAL_INIT_FN}`, []);
    }
    // main's prologue above stays: the splice moves it into the MLIR body's entry block.
    lines.push(...mlirStub);
    b.endFn();
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

  // The panic routine functions compiled through MLIR call (src/mlir-backend.ts): prints
  // `msg` as the format, exactly as the inline division and shift traps do, then aborts
  // through the panic hook.
  /**
   * MLIR path: enum `name`'s layout as this codegen stores it (EnumLayout), for the
   * dialect's !milo.enum to spell out. A niche-packed one has no tag word: its payload is
   * at offset 0 and `niche` says which integer value there is the fieldless variant.
   */
  public mlirEnumLayout(name: string): { size: number; align: number; niche?: { intTy: string; value: string }; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null {
    const l = this.enumLayouts.get(name);
    if (!l) return null;
    const n = l.niche;
    return {
      size: l.size,
      align: Math.max(4, l.payloadAlign),
      niche: n && { intTy: n.intTy, value: n.value },
      variants: [...l.variants].map(([vn, v]) => ({ name: vn, tag: v.tag, fields: v.fieldTypeKinds, offsets: n ? v.fieldTypes.map(() => 0) : this.variantFieldOffsets(v.fieldTypes) })),
    };
  }

  /** MILO_MLIR=1: module global `name` (its `@name` slot), or null for any other name. */
  public get retainingLibc(): ReadonlySet<string> { return Codegen.RETAINING_LIBC; }

  public mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null {
    const g = this.globalVars.get(name);
    if (!g) return null;
    const h = (this.hirGlobals as { name: string; threadLocal?: boolean }[]).find(x => x.name === name);
    return { type: g.typeKind, threadLocal: !!h?.threadLocal };
  }

  /** MLIR path: main goes through MLIR only when it is the process entry itself. */
  public get mlirMainOk(): boolean { return !this.wrapMainGreen; }

  private mlirPanicFn(): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: "__milo_mlir_panic", ret: Ty.void, params: [{ name: "msg", ty: Ty.ptr }], internal: true, attrs: " noreturn cold noinline" });
    this.emitFdPrintf(lines, 2, "%msg", "");
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    b.endFn();
    lines.push("");
    // milo.panic_if with values: up to three %lld; printf ignores the slots it does not name.
    const b2 = new LlvmTextBuilder(lines, this);
    b2.defineFn({ name: "__milo_mlir_panic_v3", ret: Ty.void, params: [{ name: "msg", ty: Ty.ptr }, { name: "a", ty: Ty.i64 }, { name: "b", ty: Ty.i64 }, { name: "c", ty: Ty.i64 }], internal: true, attrs: " noreturn cold noinline" });
    this.emitFdPrintf(lines, 2, "%msg", ", i64 %a, i64 %b, i64 %c");
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    b2.endFn();
    return lines;
  }

  /**
   * MLIR path: `milo.panic.text(ptr s)`, which writes the string (the whole message, by
   * length) to stderr and runs the panic tail; it never returns. Moves with the scaffold.
   */
  public mlirPanicText(): string {
    const name = "milo.panic.text";
    if (this.emittedMlirWrites.has(name)) return name;
    this.emittedMlirWrites.add(name);
    this.strRt();
    const lines: string[] = [];
    const saved = this.tempCounter;
    this.tempCounter = 0;
    lines.push(`define internal void @${name}(ptr nonnull dereferenceable(24) align 8 %s) noreturn cold noinline {`, "entry:");
    lines.push("  %v = load %String, ptr %s", "  %d = extractvalue %String %v, 0", "  %n = extractvalue %String %v, 1");
    if (this.target.os === "none") this.emitFdWrite(lines, 2, "%d", "%n");
    else this.emitStderrWrite(lines, "%d", "%n");
    this.panicAbort(lines);
    lines.push("  unreachable", "}");
    this.tempCounter = saved;
    this.helperFnBodies.push(lines);
    return name;
  }

  // The out-of-line handler MLIR's milo.contract_check calls: the contract message
  // and panic tail. Moves with its siblings in the scaffold step.
  private contractFailHelper(): string[] {
    const lines: string[] = [];
    const b = new LlvmTextBuilder(lines, this);
    b.defineFn({ name: "__milo_contract_fail", ret: Ty.void, params: [{ name: "kind", ty: Ty.ptr }, { name: "file", ty: Ty.ptr }, { name: "line", ty: Ty.i32 }], internal: true, attrs: " noreturn cold noinline" });
    lines.push(`  %fmt = getelementptr [44 x i8], ptr @.contract_err, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, "%fmt", `, ptr %kind, ptr %file, i32 %line`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    b.endFn();
    return lines;
  }
  public mlirContractFail(): void { this.needsContractCheck = true; this.needsContractFail = true; this.needsPrintf = true; this.needsExit = true; }

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

  // `file:line:col` stamp baked into a runtime panic message. Prefer the span's own file
  // over the file being compiled: a panic can fire inside an imported module (a `!` in
  // std/fs), and blaming the entry file sends the reader to the wrong source line.
  // A check's location as panic messages print it, or null when there is no file to name
  // (the panic location and the check's file pointer then disagree, so the MLIR path declines).
  public checkLocation(span?: Span): { file: string; line: number; col: number } | null {
    const file = span?.file ?? this.filePath;
    if (!file) return null;
    return { file: this.displayPath(file), line: span?.line ?? 0, col: span?.col ?? 0 };
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

  // Alloca names live for the whole function, but a binding's NAME does not:
  // two sibling loops may both bind `line`, and since the loop scope is now
  // unwound at the loop's end, `locals.has(name)` no longer reports the earlier
  // one. Uniquing has to key off what was actually emitted, or LLVM rejects the
  // function with `multiple definition of local value named 'line.addr'`.
  private emittedAddrs = new Set<string>();

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

  /** MLIR path: the runtime step of a `for` over lines()/splitView() (runtime/str.ll). */
  public mlirStrViewStep(): string {
    this.strFindFn();
    this.hasStringType = true;
    if (!this.emittedStrViewStep) {
      this.emittedStrViewStep = true;
      this.helperFnBodies.push(runtimeFn("milo.strview.step"));
    }
    return "milo.strview.step";
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
    const blk = (name: string): Block => ({ name });
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
      const lazy = val(`@"${name}.lazy"`, Ty.ptr);
      const gs = bGuard.reserveNamed("%s", Ty.i64);
      if (bare) bGuard.load(Ty.i64, lazy, 8, undefined, gs);
      else bGuard.loadAcquire(Ty.i64, lazy, 8, gs);
      const gd = bGuard.icmp("eq", gs, val("2", Ty.i64), bGuard.reserveNamed("%d", Ty.i1));
      const [gSlow, gDone] = [blk("slow"), blk("done")];
      bGuard.condBr(gd, gDone, gSlow);
      bGuard.position(gSlow);
      bGuard.callDiscard(Ty.void, "@__milo_lazy_slow", [lazy, val(`@"${name}.lazyown"`, Ty.ptr), val(`@"${name}.lazythr"`, Ty.ptr), val(shown.label, Ty.ptr), val(`@"${LAZY_INIT_PREFIX}${name}"`, Ty.ptr)]);
      bGuard.br(gDone);
      bGuard.position(gDone);
      bGuard.ret();
      bGuard.endFn();
    }

    const bTok = new LlvmTextBuilder(L, this);
    bTok.defineFn({ name: "__milo_lazy_token", ret: Ty.i64, params: [], internal: true });
    if (green) {
      const t = bTok.call(Ty.ptr, "@schedulerCurrent", [], bTok.reserveNamed("%t", Ty.ptr));
      const n = bTok.icmp("eq", t, val("null", Ty.ptr), bTok.reserveNamed("%n", Ty.i1));
      const [thread, task] = [blk("thread"), blk("task")];
      bTok.condBr(n, thread, task);
      bTok.position(task);
      bTok.ret(bTok.cast("ptrtoint", t, Ty.i64, bTok.reserveNamed("%ti", Ty.i64)));
      bTok.position(thread);
    }
    bTok.ret(bTok.call(Ty.i64, "@__milo_lazy_thread", [], bTok.reserveNamed("%a", Ty.i64)));
    bTok.endFn();
    const bThr = new LlvmTextBuilder(L, this);
    bThr.defineFn({ name: "__milo_lazy_thread", ret: Ty.i64, params: [], internal: true });
    const ta = bThr.cast("ptrtoint", val("@__milo_lazy_tid", Ty.ptr), Ty.i64, bThr.reserveNamed("%a", Ty.i64));
    bThr.ret(bThr.binop("or", ta, val("1", Ty.i64), bThr.reserveNamed("%a1", Ty.i64)));
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
      const [here] = bWait.defineFn({ name: "__milo_lazy_wait", ret: Ty.void, params: [{ name: "here", ty: Ty.i1 }], internal: true });
      const [sched, os] = [blk("sched"), blk("os")];
      bWait.condBr(here, sched, os);
      bWait.position(sched);
      if (green) {
        const t = bWait.call(Ty.ptr, "@schedulerCurrent", [], bWait.reserveNamed("%t", Ty.ptr));
        const n = bWait.icmp("eq", t, val("null", Ty.ptr), bWait.reserveNamed("%n", Ty.i1));
        const [nottask, task, drive] = [blk("nottask"), blk("task"), blk("drive")];
        bWait.condBr(n, nottask, task);
        bWait.position(task);
        bWait.callDiscard(Ty.void, "@schedulerYield", []);
        bWait.ret();
        bWait.position(nottask);
        const e = bWait.call(Ty.i1, "@schedulerExists", [], bWait.reserveNamed("%e", Ty.i1));
        bWait.condBr(e, drive, os);
        bWait.position(drive);
        bWait.callDiscard(Ty.void, "@schedulerPollMain", []);
        bWait.ret();
      } else {
        bWait.br(os);
      }
      bWait.position(os);
      if (!this.isWindows) {
        this.needsSchedYield = true;
        bWait.callDiscard(Ty.i32, "@sched_yield", []);
      }
      bWait.ret();
      bWait.endFn();
    }

    const cycleFmt = this.addString("error: initialization cycle: global '%s' is read while its own initializer is running\n");
    const byFmt = this.addString("  (read by the initializer of '%s')\n");
    const noteFmt = this.addString("note: this panic happened while initializing global '%s' (it is initialized on first read)\n");
    const bSlow = new LlvmTextBuilder(L, this);
    const [st, own, thr, nm, init] = bSlow.defineFn({ name: "__milo_lazy_slow", ret: Ty.void, params: [{ name: "st", ty: Ty.ptr }, { name: "own", ty: Ty.ptr }, { name: "thr", ty: Ty.ptr }, { name: "name", ty: Ty.ptr }, { name: "init", ty: Ty.ptr }], internal: true, attrs: " noinline" });
    const curName = val("@__milo_lazy_cur_name", Ty.ptr);
    const curTok = val("@__milo_lazy_cur_tok", Ty.ptr);
    const i64c = (n: number) => val(String(n), Ty.i64);
    const tok = bSlow.call(Ty.i64, "@__milo_lazy_token", [], bSlow.reserveNamed("%tok", Ty.i64));
    const me = bSlow.call(Ty.i64, "@__milo_lazy_thread", [], bSlow.reserveNamed("%me", Ty.i64));
    const [bTry, run, lost, out, cycle, by, die] = ["try", "run", "lost", "out", "cycle", "by", "die"].map(blk);
    bSlow.br(bTry);
    bSlow.position(bTry);
    let old: Val;
    if (bare) {
      old = bSlow.load(Ty.i64, st, 8, undefined, bSlow.reserveNamed("%old", Ty.i64));
      const won = bSlow.icmp("eq", old, i64c(0), bSlow.reserveNamed("%won", Ty.i1));
      const claim = blk("claim");
      bSlow.condBr(won, claim, lost);
      bSlow.position(claim);
      bSlow.store(i64c(1), st, 8);
      bSlow.br(run);
    } else {
      const pair = bSlow.cmpxchg(st, i64c(0), i64c(1), 8, bSlow.reserveNamed("%pair", Ty.of("{ i64, i1 }")));
      const won = bSlow.extractvalue(pair, 1, Ty.i1, bSlow.reserveNamed("%won", Ty.i1));
      old = bSlow.extractvalue(pair, 0, Ty.i64, bSlow.reserveNamed("%old", Ty.i64));
      bSlow.condBr(won, run, lost);
    }
    bSlow.position(run);
    if (bare) {
      bSlow.store(tok, own, 8);
      bSlow.store(me, thr, 8);
    } else {
      bSlow.storeRelease(tok, own, 8);
      bSlow.storeRelease(me, thr, 8);
    }
    const pn = bSlow.load(Ty.ptr, curName, undefined, undefined, bSlow.reserveNamed("%pn", Ty.ptr));
    const pt = bSlow.load(Ty.i64, curTok, undefined, undefined, bSlow.reserveNamed("%pt", Ty.i64));
    bSlow.store(nm, curName);
    bSlow.store(tok, curTok);
    bSlow.callDiscard(Ty.void, init.ref, []);
    bSlow.store(pn, curName);
    bSlow.store(pt, curTok);
    if (bare) bSlow.store(i64c(2), st, 8);
    else bSlow.storeRelease(i64c(2), st, 8);
    bSlow.ret();
    bSlow.position(lost);
    const fin = bSlow.icmp("eq", old, i64c(2), bSlow.reserveNamed("%fin", Ty.i1));
    // On a target with no threads and no scheduler, nobody else can be running it.
    bSlow.condBr(fin, out, blk(bare ? "cycle" : "busy"));
    if (!bare) {
      const [busy, wait] = [blk("busy"), blk("wait")];
      bSlow.position(busy);
      const o = bSlow.loadAcquire(Ty.i64, own, 8, bSlow.reserveNamed("%o", Ty.i64));
      const mine = bSlow.icmp("eq", o, tok, bSlow.reserveNamed("%mine", Ty.i1));
      bSlow.condBr(mine, cycle, wait);
      bSlow.position(wait);
      const ot = bSlow.loadAcquire(Ty.i64, thr, 8, bSlow.reserveNamed("%ot", Ty.i64));
      const here = bSlow.icmp("eq", ot, me, bSlow.reserveNamed("%here", Ty.i1));
      bSlow.callDiscard(Ty.void, "@__milo_lazy_wait", [here]);
      bSlow.br(bTry);
    }
    bSlow.position(cycle);
    this.emitFdPrintf(L, 2, cycleFmt.label, `, ptr %name`);
    const cn = bSlow.load(Ty.ptr, curName, undefined, undefined, bSlow.reserveNamed("%cn", Ty.ptr));
    const ct = bSlow.load(Ty.i64, curTok, undefined, undefined, bSlow.reserveNamed("%ct", Ty.i64));
    const cnn = bSlow.icmp("ne", cn, val("null", Ty.ptr), bSlow.reserveNamed("%cnn", Ty.i1));
    const cself = bSlow.icmp("eq", ct, tok, bSlow.reserveNamed("%cself", Ty.i1));
    const cother = bSlow.icmp("ne", cn, nm, bSlow.reserveNamed("%cother", Ty.i1));
    const c1 = bSlow.binop("and", cnn, cself, bSlow.reserveNamed("%c1", Ty.i1));
    const c2 = bSlow.binop("and", c1, cother, bSlow.reserveNamed("%c2", Ty.i1));
    bSlow.condBr(c2, by, die);
    bSlow.position(by);
    this.emitFdPrintf(L, 2, byFmt.label, `, ptr %cn`);
    bSlow.br(die);
    bSlow.position(die);
    // The note would repeat what was just said.
    bSlow.store(val("null", Ty.ptr), curName);
    this.panicAbort(L);
    bSlow.unreachable();
    bSlow.position(out);
    bSlow.ret();
    bSlow.endFn();

    const bNote = new LlvmTextBuilder(L, this);
    bNote.defineFn({ name: "__milo_lazy_panic_note", ret: Ty.void, params: [], internal: true });
    const ncn = bNote.load(Ty.ptr, curName, undefined, undefined, bNote.reserveNamed("%cn", Ty.ptr));
    const ncnn = bNote.icmp("ne", ncn, val("null", Ty.ptr), bNote.reserveNamed("%cnn", Ty.i1));
    const [check, note, nout] = [blk("check"), blk("note"), blk("out")];
    bNote.condBr(ncnn, check, nout);
    bNote.position(check);
    const nct = bNote.load(Ty.i64, curTok, undefined, undefined, bNote.reserveNamed("%ct", Ty.i64));
    const ntok = bNote.call(Ty.i64, "@__milo_lazy_token", [], bNote.reserveNamed("%tok", Ty.i64));
    const same = bNote.icmp("eq", nct, ntok, bNote.reserveNamed("%same", Ty.i1));
    bNote.condBr(same, note, nout);
    bNote.position(note);
    this.emitFdPrintf(L, 2, noteFmt.label, `, ptr %cn`);
    if (this.target.os !== "none") {
      this.needsFflush = true;
      this.needsAbort = true;
      bNote.callDiscard(Ty.i32, "@fflush", [val("null", Ty.ptr)]);
      bNote.callDiscard(Ty.void, "@abort", []);
    } else {
      this.needsExit = true;
      bNote.callDiscard(Ty.void, "@exit", [val("1", Ty.i32)]);
    }
    bNote.unreachable();
    bNote.position(nout);
    bNote.ret();
    bNote.endFn();
    return L;
  }

  // Cortex-M's bump heap (tools/cortex-m/startup.c) has no block headers, so it cannot
  // implement realloc; every other target's allocator has one (wasm's runtime.c, libc,
  // std/replay's heap).
  public get hasRealloc(): boolean { return this.target.os !== "none"; }

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
    const b = new LlvmTextBuilder(lines, this);
    // Bare-metal/freestanding (os "none"): there is no libc, so abort()/fflush() are
    // undefined symbols. The embedded runtime provides exit (semihosting SYS_EXIT) and there
    // is no buffered stdio to flush — terminate exactly as the pre-abort panic did there.
    if (this.target.os === "none") {
      this.needsExit = true;
      b.callDiscard(Ty.void, "@exit", [i32c(1)]);
      return;
    }
    this.needsAbort = true;
    // A panic inside a lazy global's initializer names the global, and ends the process
    // even on a green task: retiring just the task would leave the global marked as being
    // initialized, and every later reader would wait for it forever.
    if (this.lazyGlobals.size > 0) b.callDiscard(Ty.void, "@__milo_lazy_panic_note", []);
    // abort() raises SIGABRT immediately WITHOUT flushing stdio — unlike exit(), which does.
    // The panic message was just printf'd (block-buffered on a piped stdout, e.g. Linux under
    // a test harness), so flush it first or it's lost with the process. fflush(NULL) flushes
    // every open stream.
    this.needsFflush = true;
    b.callDiscard(Ty.i32, "@fflush", [V("null", Ty.ptr)]);
    // The panic hook (std/runtime sets it when a scheduler starts) retires the panicking
    // green task and never returns, so one task's panic costs that task, not the process.
    // It returns when there is no task to retire, and the panic aborts as before.
    this.usesPanicHook = true;
    // The hook and noHook temps are drawn before the labels, as the string code did.
    const hook = b.load(Ty.ptr, V("@_milo_panic_hook", Ty.ptr));
    const noHook = b.icmp("eq", hook, V("null", Ty.ptr));
    const callB = b.newBlock("panic.hook");
    const abortB = b.newBlock("panic.abort");
    b.condBr(noHook, abortB, callB);
    b.position(callB);
    b.callDiscard(Ty.void, hook.ref, []);
    b.br(abortB);
    b.position(abortB);
    b.callDiscard(Ty.void, "@abort", []);
  }

  // ── Displaying a container ──────────────────────────────────────────────────
  //
  // Structs and enums render through one compile-time format string because their
  // shape is fixed. A Vec's length and a HashMap's occupancy are not, so these
  // build the text at runtime into a grown-on-demand buffer instead. The result is
  // a malloc'd NUL-terminated C string, the same contract the struct display has,
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

  // `@milo.str.reserve(s, extra)`: make the %String at `s` hold len + extra bytes plus
  // the NUL, growing by doubling (16-byte floor), with the checked-allocation realloc policy.
  // Returns the data pointer, or null when the allocation failed (the caller aborts with
  // its own source location). The string is made unique first (see strRt), so the
  // returned buffer is this handle's alone. A cap-0 buffer is a static literal or a view
  // this string does not own: it is copied, never handed to realloc or free.
  /** MLIR path: milo.string.concat/append, runtime sections over strRt and milo.str.reserve. */
  public mlirStringOps(): void {
    if (this.emittedMlirStringOps) return;
    this.emittedMlirStringOps = true;
    this.strReserveFn();
    this.helperFnBodies.push(runtimeFn("milo.string.concat"), runtimeFn("milo.string.append"),
      runtimeFn("milo.string.eq"), runtimeFn("milo.string.cmp"),
      runtimeFn("milo.string.reserve", { rcload: this.target.os === "none" ? "load i64, ptr %hdr, align 8" : "load atomic i64, ptr %hdr acquire, align 8" }));
    this.needsMemcmp = true;
  }
  private emittedMlirStringOps = false;

  /**
   * MLIR path: `milo.out.write(ptr s)` / `milo.err.write`, writing the string's bytes to
   * stdout (through stdio's buffer, as emitStdoutWrite) or stderr, then freeing its buffer:
   * the string is print's scratch, held by nobody else. Moves with the module scaffold.
   */
  public mlirOutWrite(stderr: boolean): string {
    const name = stderr ? "milo.err.write" : "milo.out.write";
    if (this.emittedMlirWrites.has(name)) return name;
    this.emittedMlirWrites.add(name);
    this.strRt();
    const lines: string[] = [];
    const saved = this.tempCounter;
    this.tempCounter = 0;
    lines.push(`define internal void @${name}(ptr nonnull dereferenceable(24) align 8 %s) {`, "entry:");
    lines.push("  %v = load %String, ptr %s", "  %d = extractvalue %String %v, 0", "  %n = extractvalue %String %v, 1", "  %c = extractvalue %String %v, 2");
    if (this.target.os === "none") {
      // Freestanding: the embedded runtime's one sink is printf (no fds, no fwrite). By
      // length, so a NUL in the text is written too; a C int's worth at a time is plenty.
      this.needsPrintf = true;
      const fmt = this.addString("%.*s");
      lines.push("  %n32 = trunc i64 %n to i32", `  call i32 (ptr, ...) @printf(ptr ${fmt.label}, i32 %n32, ptr %d) nobuiltin`);
    } else if (stderr) this.emitStderrWrite(lines, "%d", "%n");
    else this.emitStdoutWrite(lines, "%d", "%n");
    lines.push("  %heap = icmp sgt i64 %c, 0", "  br i1 %heap, label %free, label %done", "free:", "  call void @milo.str.free(ptr %d)", "  br label %done", "done:", "  ret void", "}");
    this.tempCounter = saved;
    this.helperFnBodies.push(lines);
    return name;
  }
  private emittedMlirWrites = new Set<string>();

  /**
   * MLIR path: the function for std's `_atomic<Op><Width>` (ATOMIC_INTRINSICS), an
   * instance of a src/runtime/atomic.ll section; its symbol.
   */
  public mlirAtomic(builtin: string): string | null {
    const spec = Codegen.ATOMIC_INTRINSICS[builtin];
    if (!spec) return null;
    const name = `milo.atomic.${builtin}`;
    if (this.emittedMlirWrites.has(name)) return name;
    this.emittedMlirWrites.add(name);
    const key = { load: "milo.atomic.load", store: "milo.atomic.store", rmw: "milo.atomic.rmw", cas: "milo.atomic.cas" }[spec.kind];
    this.helperFnBodies.push(runtimeFn(key, { name, ty: spec.ty, align: String(spec.align), ...(spec.kind === "rmw" ? { op: spec.rmwOp! } : {}) }));
    return name;
  }

  /**
   * MLIR path: the symbol of a process global this module defines (argc/argv, the
   * scheduler, the panic hook), marked used so it is emitted.
   */
  public mlirProcessGlobal(which: "argc" | "argv" | "scheduler" | "panicHook"): string {
    if (which === "scheduler") this.usesSchedulerGlobal = true;
    if (which === "panicHook") this.usesPanicHook = true;
    return { argc: "_milo_argc_global", argv: "_milo_argv_global", scheduler: "_milo_scheduler", panicHook: "_milo_panic_hook" }[which];
  }

  /** MLIR path: the itable global of type `from` as interface `iface`. */
  public mlirItable(from: string, iface: string): string {
    return (this.itableLayouts.get(`${from}.${iface}`)?.globalName ?? `@itable.${from}.${iface}`).slice(1);
  }

  /** MLIR path: std's _vecGrowBuf as a runtime section, realloc where the target has it. */
  public mlirVecGrow(elemSize: number): string {
    const realloc = this.hasRealloc && elemSize > 0;
    const name = realloc ? "milo.vec.grow.realloc" : "milo.vec.grow.copy";
    if (this.emittedMlirWrites.has(name)) return name;
    this.emittedMlirWrites.add(name);
    this.needsMalloc = this.needsMemcpy = this.needsFree = true;
    if (realloc) this.needsRealloc = true;
    this.usedOverflowIntrinsics.add("declare {i64, i1} @llvm.umul.with.overflow.i64(i64, i64)");
    this.helperFnBodies.push(realloc ? runtimeFn("milo.vec.grow.realloc", { reallocMin: String(REALLOC_MIN_BYTES) }) : runtimeFn("milo.vec.grow.copy"));
    return name;
  }

  /** MLIR path: offsetOf(S, f), the byte offset of the field (0 when unknown). */
  public mlirFieldOffset(struct: string, field: string): number {
    const layout = this.structLayouts.get(struct);
    const idx = layout ? layout.fields.findIndex(f => f.name === field) : -1;
    return layout && idx >= 0 ? this.structFieldOffset(layout.fields.map(f => f.type), idx) : 0;
  }

  /** MLIR path: a struct's or enum's name as a program shows it (not its mangled symbol). */
  public mlirDisplayName(name: string): string { return display(this.displayNames, name); }

  /** MLIR path: milo.string.push_<kind>, appending one scalar's text in place. */
  public mlirPushScalar(kind: "i64" | "u64" | "f64" | "f32" | "bool" | "ptr" | "json" | "cstr"): void {
    if (this.emittedMlirPush.has(kind)) return;
    this.emittedMlirPush.add(kind);
    this.mlirStringOps();
    if (kind === "i64" || kind === "u64") this.intFmtFns();
    if (kind === "f64" || kind === "f32") this.ensureFloatFormatHelper(kind === "f32" ? 32 : 64);
    if (kind === "cstr") { this.helperFnBodies.push(runtimeFn("milo.string.cstr")); return; }
    const key = { i64: "milo.string.push_i64", u64: "milo.string.push_u64", f64: "milo.string.push_f64", f32: "milo.string.push_f32", bool: "milo.string.push_bool", ptr: "milo.string.push_ptr", json: "milo.string.push_json" }[kind];
    this.helperFnBodies.push(runtimeFn(key));
  }
  private emittedMlirPush = new Set<string>();

  /** MLIR path: the map runtime sections (src/runtime/map.ll) and their hash seed. */
  public mlirMapOps(): void {
    if (this.emittedMlirMapOps) return;
    this.emittedMlirMapOps = true;
    this.needsMalloc = true;
    this.needsMemset = true;
    this.needsGetentropy = true;
    this.usedOverflowIntrinsics.add("declare {i64, i1} @llvm.umul.with.overflow.i64(i64, i64)");
    this.helperFnBodies.push(runtimeFn("milo.map.alloc"), runtimeFn("milo.hash.byte"), runtimeFn("milo.hash.u64"), runtimeFn("milo.hash.bytes"));
    this.mlirCloneOps();
  }

  /** MLIR path: the drops of a string, an owning closure and a Heap<Interface> (runtime sections). */
  public mlirDropOps(): void {
    if (this.emittedMlirDropOps) return;
    this.emittedMlirDropOps = true;
    this.strRt();
    this.needsFree = true;
    this.helperFnBodies.push(runtimeFn("milo.string.drop"), runtimeFn("milo.closure.drop"), runtimeFn("milo.iface.drop"));
  }
  private emittedMlirDropOps = false;

  /** MLIR path: how many methods interface `name`'s itables hold before the drop slot. */
  public mlirIfaceMethodCount(name: string): number | null { return this.ifaceMethodCounts.get(name) ?? null; }

  /** MLIR path: milo.buf.clone, the buffer copy every Vec, HashMap and Heap clone starts from. */
  public mlirCloneOps(): void {
    if (this.emittedMlirCloneOps) return;
    this.emittedMlirCloneOps = true;
    this.strRt();
    this.needsMalloc = true;
    this.needsMemcpy = true;
    this.usedOverflowIntrinsics.add("declare {i64, i1} @llvm.umul.with.overflow.i64(i64, i64)");
    this.helperFnBodies.push(runtimeFn("milo.buf.clone"), runtimeFn("milo.buf.alloc"));
  }
  private emittedMlirCloneOps = false;
  private emittedMlirMapOps = false;

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
    // The bodies are runtime sections (src/runtime/str.ll), shared with the MLIR path.
    if (!this.generatedFloatFmt) { this.generatedFloatFmt = true; this.dropHelperBodies.push(runtimeFn("milo.fmt.g")); }
    this.dropHelperBodies.push(runtimeFn(bits === 32 ? "milo.fmt.f32" : "milo.fmt.f64"));
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
  // (unwrap and `?` do it) precisely because the payload moved out. A place
  // operand that is NOT zeroed — a struct field — still owns its payload, so
  // freeing the result there would double-free.
  private unwrapMovesPayload(expr: HIRExpr & { kind: "Unwrap" | "Propagate" }): boolean {
    if (this.isOwnedTempExpr(expr.operand)) return true;
    return this.needsDropCg(expr.type) && expr.operand.kind === "Ident";
  }

  // Whether an `if`/`match` used as an EXPRESSION hands back a value nobody else owns.
  //
  // It does when some arm yields an owned value: a temporary, a place the checker moved
  // (isMove: the expression zeroes it), or a match arm's own binding (the yield moves it). An
  // arm that yields a place it does not consume (`if c { a } else { mk() }` read in place)
  // then stores a clone (ForkSlot.cloneViews), so whichever arm ran, the consumer drops
  // exactly one value it owns. For a resource type the checker moves such a place instead
  // (moveMixedFork), since a structural clone would run its Drop twice. A string literal
  // owns nothing, and a fork of only views and literals stays a view.
  /** MLIR path: blockValueOwnsResult, which decides a fork's ownership the same way. */
  public mlirBlockValueOwnsResult(expr: HIRExpr & { kind: "IfExpr" | "MatchExpr" }): boolean { return this.blockValueOwnsResult(expr); }

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

  // Whether a field chain bottoms out in an rvalue nobody owns (`mk().a.b`), as opposed to
  // a place that can be addressed in situ (a local, `v[i]`, `*p`). Only the rvalue is
  // materialized into a temporary, so only it can die with the expression.
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
  // such deref as a move out of the box yielding an owned temporary.
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
    // replace drops its own moved-out value inside the expression, so it must NOT double-drop here.
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
      case "JsonStringify":
      case "StringClone":
      case "VecNew":
      // std/hashmap's copy of a stored value is a fresh deep clone nobody else owns.
      case "MapCopyOut":
      // get's payload is cloned out of the buffer, so nothing else owns it and
      // `print(must(v, 0, "v"))` used to leak one copy per call.
      case "VecGetOpt":
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
  // default and zeroes its source — so an unbound `(maybe(i) ?? "x").len`
  // leaked one payload per evaluation with nothing left to free it.
  //
  // Deliberately narrower than "both branches move": the zeroing that makes a moved
  // *variable* safe only happens when codegen can find the source slot, which it cannot
  // for every Ident (an immutable `let` is an SSA register, not an alloca). A branch whose
  // value is an owned temp needs no zeroing to begin with, and a string literal has cap 0
  // so its drop is a no-op — those two are safe unconditionally. Everything else, Idents
  // included, stays false and keeps leaking rather than risking a double free.
  private defaultValueOwnsResult(expr: HIRExpr & { kind: "DefaultValue" }): boolean {
    // An Ident counts, for the same reason it does in unwrapMovesPayload: the default-value form
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

  private hirFns = new Map<string, HIRFunction>();
  private closureParamEscapeCache = new Map<string, boolean>();

  // A synthesized module-level function (drop or clone helper) is numbered from zero and has
  // its own ledger maps; the enclosing function's counters are restored after.
  public emitHelperFn(hoistAt: number | undefined, build: (body: string[]) => void): void {
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;
    const body: string[] = [];
    build(body);
    // Helper bodies bypass the normal function emitter, so a Vec clone's allocas would land
    // inside its copy loop (a dynamic alloca per iteration walks the stack off the end).
    if (hoistAt !== undefined) this.hoistAllocas(body, hoistAt);
    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
  }

  public emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind) {
    if (this.structuralDropTypes.has(typeKind) && !this.structuralDrop) {
      this.structuralDrop = true;
      try { this.emitDropValue(lines, allocaPtr, typeKind); } finally { this.structuralDrop = false; }
      return;
    }
    emitDropValueBody(this, lines, allocaPtr, typeKind);
  }

  private usedSatIntrinsics?: Set<string>;

  // LLVM encodes a float or double constant as a raw 64-bit hex pattern, but a
  // `float` operand only accepts a pattern that is exactly representable in
  // single precision. Emitting the double bits of 0.1 for an f32 field is a hard
  // LLVM error ("floating point constant invalid for type"), so round through
  // f32 first when that is the operand type.
  public formatFloatBits(v: number, llvmTy = "double"): string {
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

}
