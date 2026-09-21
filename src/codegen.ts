// HIR -> LLVM IR emission, including drop glue, monomorphization and the per-target
// calling conventions. IR uses opaque `ptr` (LLVM 15+), never `i8*`.
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern, HIRContract, HIRStruct } from "./hir";
import { type TypeKind, needsDrop, typeName } from "./types";
import type { TargetInfo } from "./target";
import type { Span } from "./ast";
import { genVecSort, genVecSortBy, genVecSortByKey } from "./codegen-vec";
import { cSigParams, headerLabel } from "./csig";
import { classifyArg, classifyRet, AbiError, type ArgClass, type RetClass, type AbiStruct, type AbiLeaf } from "./abi";
import { resolve, dirname, basename, relative, isAbsolute } from "path";
import { STDLIB_DIR } from "./stdlibBundle";
import { must } from "./must";
import { display } from "./mangle";

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
export const NOT_OWNED_TEMP: readonly string[] = [
  "ArrayLen", "ArrayRepeat", "BitIntrinsic", "BoolLit", "CFnCall", "Cast",
  "CharLit", "CheckedArith", "Closure", "EnumTryFrom", "FieldAccess", "FloatLit",
  "Forget", "HashMapClear", "HashMapContains", "HashMapGetOrInsertWith", "HashMapInsert", "HashMapLen", "HashMapModify",
"HashMapNew", "HashMapRemove", "HeapCreate", "HeapDeref", "HeapPtr", "Ident",
  "IntLit", "InterfaceCoerce", "IsCheck", "MemSwap", "OffsetOf",
  "OptionOp", "PtrDeref", "RangeCheck", "RawSlice", "SaturatingArith", "SizeOf", "StringCstr",
  "StringFind", "StringLen", "StringLit", "StringPush", "StringPushStr", "StringSlice",
  "UnaryOp", "VecAll", "VecAny", "VecCapacity", "VecContains", "VecEach",
  "VecEnumerate", "VecExtend", "VecIndexOf", "VecInsert", "VecIsEmpty",
  "VecLen", "VecPosition", "VecPtr", "VecPush", "VecReserve", "VecRetain",
  "VecReverse", "VecSlice", "VecSort", "VecSortBy", "VecSortByKey", "VecSum",
  "VecSwap", "VecTruncate", "WrappingArith", "Zeroed",
];

// `.` can't appear in a Milo identifier, so this never collides with a user function.
const GLOBAL_INIT_FN = "__milo.global_init";

// Scratch size for one formatted f64. Worst case at 17 significant digits is
// "-1.2345678901234567e-308" — 24 bytes plus the NUL.
const F64_BUF = 32;

// The bounds-check message is one module-wide global, so the literal and the array length
// in its declaration have to stay in lockstep — a mismatch is an LLVM verifier error.
const BOUNDS_ERR_MSG = "milo: array index out of bounds: %d/%d at %s:%d\n";
const BOUNDS_ERR_IR = BOUNDS_ERR_MSG.replace(/\n/g, "\\0A") + "\\00";
const BOUNDS_ERR_LEN = BOUNDS_ERR_MSG.length + 1;

interface ExternAbiInfo {
  args: (ArgClass | null)[]; // per fixed param; null = direct (scalar/ptr/ref — no rewrite)
  ret: RetClass;
}

interface StructLayout {
  name: string;
  fields: { name: string; type: string; typeKind: TypeKind }[];
}

interface EnumLayout {
  name: string;
  payloadSlots: number;
  variants: Map<string, { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }>;
}

// Headers whose types the winsock family uses but does not define. POSIX headers are
// self-contained enough that any order works, so the @cLayout/@cSig guard TU just sorts
// them; Windows' are not. ws2tcpip.h and afunix.h name ADDRESS_FAMILY and SOCKADDR, which
// only winsock2.h declares, and sorted order puts afunix.h first — so every guard TU that
// touched sockets failed with "'ADDRESS_FAMILY': named in Milo, but the header declares no
// such type", blaming the Milo declaration for what is an include-order bug. This never
// showed up cross-compiling because verifyCDecls skips itself when target != host.
const WINSOCK_DEPENDENTS = new Set(["ws2tcpip.h", "afunix.h", "ws2def.h", "mswsock.h"]);

// Feature-test macros a guard header needs, pulled out of every `FEATURE+header` spec.
// They must land before the FIRST system header in the TU rather than before the header
// that names them: glibc's <features.h> is pulled in by whatever includes first and latches
// the feature set for the whole translation unit, so a `#define _GNU_SOURCE` sitting just
// above <unistd.h> arrives too late. execvpe then reads as undeclared, which the guard
// reports as "Milo declares a function C does not have" — the opposite of the truth.
export function guardFeatureMacros(headers: string[]): string[] {
  return [...new Set(
    headers.flatMap(h => h.split("|").flatMap(alt => alt.split("+").slice(0, -1))),
  )].sort();
}

export function orderGuardIncludes(headers: string[], os: string): string[] {
  if (os !== "windows") return headers;
  // Pulled in even when nothing named it: a header that needs it may be the only one present.
  if (!headers.some(h => WINSOCK_DEPENDENTS.has(h)) && !headers.includes("winsock2.h")) return headers;
  return ["winsock2.h", ...headers.filter(h => h !== "winsock2.h")];
}

interface LocalInfo { type: string; typeKind: TypeKind; mutable: boolean; isRef: boolean; addr?: string }

// One name for codegen's return shape: the IR lines an expression emits, the SSA value it
// leaves the result in, and that value's LLVM type.
//
// `value` and `type` are both bare `string` and adjacent, so nothing but argument order
// stops them being swapped — the kind of mistake that produces IR which is wrong rather
// than invalid. Making them distinct branded types is the real fix and costs ~390 call-site
// changes here; this alias is the one place that change would need to land, and Milo's
// newtypes make it free on the other side of the port. See docs/backlog.md.
type Gen = [lines: string[], value: string, type: string];

// Attribute-group number for the `--sanitize` marker. Emitted IR carries no other
// attribute groups, so 0 is always free.
const SANITIZE_ATTRS = 0;

// %HashMap field indices. The struct is { data, len, cap, seed }, and these offsets
// appeared as bare `i32 0, i32 N` at 22 sites in this file — the only clue to which field
// an N meant was the local variable name at the use site, so adding a field meant finding
// and re-reading every one of them.
const HM_DATA = 0;
const HM_LEN = 1;
const HM_CAP = 2;
const HM_SEED = 3;
// Deleted slots, counted so the resize trigger can see them. Without it a table can reach
// a state where every slot is occupied-or-tombstone, and a probe that stops only at an
// EMPTY slot would never terminate.
const HM_TOMBS = 4;
// Field count of %HashMap, and the single source for its size. Every field is 8 bytes
// (one ptr + four i64), so the size is just the count — but the COUNT has to come from
// one place or the two drift, which is exactly what happened.
const HASHMAP_FIELDS = 5;

export class Codegen {
  private target: TargetInfo;
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, LocalInfo>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean; wantsStringAddr?: boolean[] }>();
  // milo fns whose big-aggregate return is lowered to a hidden `ptr %__sret.out`
  // first param (see genStoreInto). Excludes main and exported fns (C ABI).
  private sretFns = new Set<string>();
  private currentFnSret = false;
  // extern fns that pass/return a struct by value need native-ABI lowering (byval/sret/coerce)
  private externAbi = new Map<string, ExternAbiInfo>();
  private structLayouts = new Map<string, StructLayout>();
  private cLayoutStructs: HIRStruct[] = [];
  private cSigs: { fnName: string; header: string; sig: string; retType: TypeKind; params?: { type: TypeKind }[] }[] = [];
  private cValues: { global: string; cName: string; header: string; value: string; signed: boolean }[] = [];
  private enumLayouts = new Map<string, EnumLayout>();
  private userDeclaredFns = new Set<string>();
  private needsBoundsCheck = false;
  private needsGlobalInit = false;
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
  private needsSetvbuf = false;
  private needsExit = false;
  private needsMalloc = false;
  private needsFree = false;
  private needsRealloc = false;
  private emittedBufAppend = false;
  public needsMemcpy = false;
  private needsStrlen = false;
  public needsMemcmp = false;
  private hasStringType = false;
  public hasVecType = false;
  private hasHashMapType = false;
  private needsGetentropy = false;
  private needsStrtod = false;
  private loopHeader: string | null = null;
  private loopExit: string | null = null;
  private loopDropStart: number = 0;

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
  // hop all keep their check. Widening it to affine indices is docs/plans/
  // bounds-check-elision.md, and wants a range lattice rather than a pattern.
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
  private droppableLocals: { name: string; typeKind: TypeKind; aliveFlag: string; addr: string }[] = [];
  private droppableEnums = new Set<string>();
  private dropImpls = new Set<string>();
  private structDropCache = new Map<string, boolean>();
  private generatedDropHelpers = new Set<string>();
  private generatedJsonEscapeHelper = false;
  private generatedF64FormatHelper = false;
  private generatedF32FormatHelper = false;
  private needsStrtof = false;
  private generatedStructDropHelpers = new Set<string>();
  private dropHelperBodies: string[][] = [];
  // Method count per interface, so a `Heap<Iface>` drop knows which itable slot holds the
  // concrete type's destructor. Populated before any body is generated; the itable
  // globals themselves are emitted much later, in the finalization pass.
  private ifaceMethodCounts = new Map<string, number>();
  private helperFnBodies: string[][] = [];
  private emittedStrFind = false;
  // Inside a closure body: capture alloca name -> pointer to its liveness flag in the
  // environment. A move out of a capture clears the flag so the env drop glue skips it.
  private captureFlagByAddr = new Map<string, string>();
  private closureBodies: string[][] = [];
  private closureCounter = 0;
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
  private static BUILTINS = new Set(["print", "eprint", "format", "flush", "exit", "assert", "todo", "max", "min", "_miloArgCount", "_miloArgAt", "_cstrToString", "_bytesToString", "_strDataPtr", "_putByte", "_loadU8", "_loadI32", "_callClosureVoid", ...Object.keys(Codegen.ATOMIC_INTRINSICS), "_schedulerGet", "_schedulerSet"]);
  private usesSchedulerGlobal = false;
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

  // ── DWARF line-table emission (M1) ──
  // Off unless `emitDebug`. All metadata is interned here and rendered as trailing
  // `!N = ...` nodes in applyDebugInfo(); the `!N` id space is otherwise unused, so
  // codegen owns it entirely. LLVM permits forward metadata references, so mint order
  // is irrelevant. Scope is resolved lazily in the final text pass (see applyDebugInfo)
  // rather than threaded through the recursive emitters — that sidesteps every
  // closure/trampoline state-save landmine.
  private emitDebug = false;
  private metaCounter = 0;
  private diNodes: string[] = [];
  private diFiles = new Map<string, number>();
  private diSubprograms = new Map<string, number>();
  private diSubprogramLine = new Map<number, number>();
  private diLocations = new Map<string, number>();
  private diCompileUnitId = -1;
  private diSubroutineTypeId = -1;
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
  private diTypes = new Map<string, number>();

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

  // A SIGKILL cannot flush stdio, so a program killed by a watchdog (scripts/guard.ts,
  // a CI timeout) with a piped stdout loses every line it printed — precisely the case
  // where that output is the only evidence of where it hung. Block buffering on a pipe
  // is still the right default for throughput (see emitStdoutWrite), so retuning is
  // opt-in and belongs to whoever might do the killing: set MILO_LINE_BUFFERED and pay
  // a write per line to get output up to the hang instead of nothing.
  private static readonly LINE_BUF_INIT_FN = "__milo_line_buffer_init";

  private emitStdoutBufferingOptIn(lines: string[]): void {
    if (this.target.os === "none") return; // freestanding: no environment, no stdio streams
    this.needsSetvbuf = true;
    lines.push(`  call void @${Codegen.LINE_BUF_INIT_FN}()`);
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
    lines.push(`define internal void @${Codegen.LINE_BUF_INIT_FN}() {`);
    lines.push("entry.bb:");
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
    lines.push("}");
    return lines;
  }

  // dprintf(fd, fmt, ...) has no UCRT equivalent. stderr is not a linkable data symbol
  // on MSVC either — it is the macro `__acrt_iob_func(2)` — so eprint lowers to an
  // fprintf onto that handle.
  private emitFdPrintf(lines: string[], fd: number, fmtLabel: string, argsStr: string): void {
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

  private diEsc(s: string): string { return s.replace(/\\/g, "\\5C").replace(/"/g, "\\22"); }
  // A DWARF display name: what a debugger shows. The per-module pass renames a private
  // name, and that rename is a symbol concern only; a `frame variable` or a breakpoint
  // listing must still read `tone`, not `gfx$tone`. No `linkageName` is emitted on
  // purpose: lldb DISPLAYS the linkage name in every backtrace frame when it is present,
  // which is exactly the surface this keeps clean. The DIE is matched to code by
  // DW_AT_low_pc, not by name, and the mangled symbol is still in the symbol table.
  private diName(s: string): string { return this.diEsc(display(this.displayNames, s)); }

  private diFile(path: string): number {
    const key = path || "<unknown>";
    const cached = this.diFiles.get(key);
    if (cached !== undefined) return cached;
    const id = this.metaCounter++;
    const abs = resolve(key);
    this.diNodes.push(`!${id} = !DIFile(filename: "${this.diEsc(basename(abs))}", directory: "${this.diEsc(dirname(abs))}")`);
    this.diFiles.set(key, id);
    return id;
  }

  private diCompileUnit(): number {
    if (this.diCompileUnitId >= 0) return this.diCompileUnitId;
    const fileId = this.diFile(this.filePath ?? "<unknown>");
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DICompileUnit(language: DW_LANG_C99, file: !${fileId}, producer: "milo", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug)`);
    this.diCompileUnitId = id;
    return id;
  }

  // M1 has no per-parameter type info yet; `types: !{null}` = void/unspecified, shared by all fns.
  private diSubroutineType(): number {
    if (this.diSubroutineTypeId >= 0) return this.diSubroutineTypeId;
    const typesId = this.metaCounter++;
    this.diNodes.push(`!${typesId} = !{null}`);
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DISubroutineType(types: !${typesId})`);
    this.diSubroutineTypeId = id;
    return id;
  }

  private diSubprogram(fn: HIRFunction): number {
    const cached = this.diSubprograms.get(fn.name);
    if (cached !== undefined) return cached;
    const fileId = this.diFile(fn.sourceFile ?? this.filePath ?? "<unknown>");
    const cu = this.diCompileUnit();
    const subT = this.diSubroutineType();
    const line = fn.line ?? 0;
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DISubprogram(name: "${this.diName(fn.name)}", scope: !${fileId}, file: !${fileId}, line: ${line}, type: !${subT}, scopeLine: ${line}, spFlags: DISPFlagDefinition, unit: !${cu})`);
    this.diSubprograms.set(fn.name, id);
    this.diSubprogramLine.set(id, line);
    return id;
  }

  private diLocation(line: number, col: number, scope: number): number {
    const key = `${line}:${col}:${scope}`;
    const cached = this.diLocations.get(key);
    if (cached !== undefined) return cached;
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DILocation(line: ${line}, column: ${col}, scope: !${scope})`);
    this.diLocations.set(key, id);
    return id;
  }

  // Tag every instruction line (2-space indented, non-comment) with a deferred source
  // marker. Nested stmts recurse first and mark their own lines; the outer stmt's marker
  // then only lands on its own lines (skip-if-marked). Resolved to real !dbg in applyDebugInfo.
  private markDbg(lines: string[], line: number, col: number): void {
    const marker = ` ;MILODBG ${line} ${col | 0}`;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.length < 2 || l[0] !== " " || l[1] !== " ") continue;
      const t = l.trimStart();
      if (t.length === 0 || t[0] === ";") continue;
      if (l.includes(";MILODBG") || l.includes("!dbg")) continue;
      lines[i] = l + marker;
    }
  }

  // ── DWARF variable types (M2) ──
  // Structural key so pointers/refs (whose llvmType collapses to "ptr") still cache
  // distinctly by pointee.
  private diTypeKey(t: TypeKind): string {
    switch (t.tag) {
      case "int": return `i${t.bits}${t.signed ? "s" : "u"}`;
      case "float": return `f${t.bits}`;
      case "ptr": case "heap": return `p:${this.diTypeKey(t.inner)}`;
      case "ref": return `r:${this.diTypeKey(t.inner)}`;
      case "struct": return `s:${t.name}`;
      case "enum": return `e:${t.name}`;
      case "vec": return `v:${this.diTypeKey(t.element)}`;
      case "hashmap": return `m:${this.diTypeKey(t.key)}:${this.diTypeKey(t.value)}`;
      case "array": return `a:${this.diTypeKey(t.element)}:${t.size}`;
      default: return t.tag;
    }
  }

  private diPointer(base: number | null): number {
    const id = this.metaCounter++;
    // baseType is required; a void/opaque pointer must spell it `null`, not omit it.
    this.diNodes.push(`!${id} = !DIDerivedType(tag: DW_TAG_pointer_type, baseType: ${base !== null ? "!" + base : "null"}, size: 64)`);
    return id;
  }

  private diBasic(name: string, sizeBits: number, encoding: string): number {
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DIBasicType(name: "${name}", size: ${sizeBits}, encoding: ${encoding})`);
    return id;
  }

  // Composite from LLVM field types — offsets/sizes come from the same layout math the
  // struct codegen uses, so DWARF member offsets match the emitted %Struct exactly.
  private diComposite(name: string, fieldLlvm: string[], fieldNames: string[], fieldKinds: TypeKind[], key: string): number {
    const id = this.metaCounter++;
    this.diTypes.set(key, id); // reserve before recursing into members (breaks self-reference cycles)
    const memberIds: number[] = [];
    for (let i = 0; i < fieldLlvm.length; i++) {
      const ft = this.diType(fieldKinds[i]);
      if (ft === null) continue;
      const mid = this.metaCounter++;
      const off = this.structFieldOffset(fieldLlvm, i) * 8;
      const sz = this.typeSize(fieldLlvm[i]) * 8;
      this.diNodes.push(`!${mid} = !DIDerivedType(tag: DW_TAG_member, name: "${this.diEsc(fieldNames[i])}", baseType: !${ft}, size: ${sz}, offset: ${off})`);
      memberIds.push(mid);
    }
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{${memberIds.map(m => "!" + m).join(", ")}}`);
    const totBits = this.structPayloadSize(fieldLlvm) * 8;
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diName(name)}", size: ${totBits}, elements: !${tuple})`);
    return id;
  }

  // The `tag` field of an enum, described as a real DWARF enumeration so debuggers
  // print `tag = Rect` rather than `tag = 1`.
  private diEnumeration(name: string, layout: EnumLayout): number {
    const base = this.diType({ tag: "int", bits: 32, signed: true })!;
    const enumerators: number[] = [];
    for (const [vname, v] of layout.variants) {
      const eid = this.metaCounter++;
      this.diNodes.push(`!${eid} = !DIEnumerator(name: "${this.diEsc(vname)}", value: ${v.tag})`);
      enumerators.push(eid);
    }
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{${enumerators.map(e => "!" + e).join(", ")}}`);
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_enumeration_type, name: "${this.diName(name)}", size: 32, baseType: !${base}, elements: !${tuple})`);
    return id;
  }

  // A Milo enum is `{ i32 tag, [N x i64] payload }`. Describe it as the classic C
  // tagged union — enumerated tag + union of per-variant payload structs — which every
  // debugger renders natively. DW_TAG_variant_part would be more faithful but lldb
  // shows it as `$variant$0`/`$discr$` noise without a synthetic provider.
  private diEnum(layout: EnumLayout, key: string): number {
    // fieldless enum: the whole value *is* the tag, so no phantom payload slots
    if (layout.payloadSlots === 0) {
      const only = this.diEnumeration(layout.name, layout);
      this.diTypes.set(key, only);
      return only;
    }
    const id = this.metaCounter++;
    this.diTypes.set(key, id); // reserve before recursing into payloads (Heap<Self> variants)

    const tagId = this.diEnumeration(`${layout.name}$tag`, layout);
    const payloadBits = layout.payloadSlots * 64;

    // union member per payload-carrying variant; single-field variants bind the field
    // type directly (`Some = 42`), multi-field ones get a positional struct.
    const unionMembers: number[] = [];
    for (const [vname, v] of layout.variants) {
      if (v.fieldTypes.length === 0) continue;
      let baseId: number | null;
      let sizeBits: number;
      if (v.fieldTypes.length === 1) {
        baseId = this.diType(v.fieldTypeKinds[0]);
        sizeBits = this.typeSize(v.fieldTypes[0]) * 8;
      } else {
        baseId = this.diComposite(`${layout.name}::${vname}`, v.fieldTypes,
          v.fieldTypes.map((_, i) => `_${i}`), v.fieldTypeKinds, `ev:${layout.name}:${vname}`);
        sizeBits = this.structPayloadSize(v.fieldTypes) * 8;
      }
      if (baseId === null) continue; // unmodellable payload — omit rather than emit bad metadata
      const mid = this.metaCounter++;
      this.diNodes.push(`!${mid} = !DIDerivedType(tag: DW_TAG_member, name: "${this.diEsc(vname)}", baseType: !${baseId}, size: ${sizeBits}, offset: 0)`);
      unionMembers.push(mid);
    }
    const utuple = this.metaCounter++;
    this.diNodes.push(`!${utuple} = !{${unionMembers.map(m => "!" + m).join(", ")}}`);
    const unionId = this.metaCounter++;
    this.diNodes.push(`!${unionId} = distinct !DICompositeType(tag: DW_TAG_union_type, name: "${this.diName(layout.name)}$payload", size: ${payloadBits}, elements: !${utuple})`);

    const tagMember = this.metaCounter++;
    this.diNodes.push(`!${tagMember} = !DIDerivedType(tag: DW_TAG_member, name: "tag", baseType: !${tagId}, size: 32, offset: 0)`);
    const payloadMember = this.metaCounter++;
    // payload starts at byte 8: [N x i64] has align 8, so the i32 tag is tail-padded
    this.diNodes.push(`!${payloadMember} = !DIDerivedType(tag: DW_TAG_member, name: "payload", baseType: !${unionId}, size: ${payloadBits}, offset: 64)`);
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{!${tagMember}, !${payloadMember}}`);
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diName(layout.name)}", size: ${64 + payloadBits}, elements: !${tuple})`);
    return id;
  }

  // Translate a Milo type to a DIType node id. Returns null for types we don't model
  // yet (fn/interface/void/unknown/slices) — callers then skip the variable rather
  // than emit metadata the verifier would reject.
  private diType(t: TypeKind): number | null {
    const key = this.diTypeKey(t);
    const cached = this.diTypes.get(key);
    if (cached !== undefined) return cached;
    let id: number | null = null;
    switch (t.tag) {
      case "int":
        id = this.diBasic(`${t.signed ? "i" : "u"}${t.bits}`, t.bits, t.signed ? "DW_ATE_signed" : "DW_ATE_unsigned");
        break;
      case "float":
        id = this.diBasic(`f${t.bits}`, t.bits, "DW_ATE_float");
        break;
      case "bool":
        id = this.diBasic("bool", 8, "DW_ATE_boolean"); // i1 occupies a byte in an alloca
        break;
      case "ptr": case "heap": case "ref":
        id = this.diPointer(this.diType(t.inner));
        break;
      case "string":
        id = this.diComposite("string", ["ptr", "i64", "i64"], ["data", "len", "cap"],
          [{ tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }], key);
        break;
      case "vec": {
        const el = this.llvmType(t.element);
        id = this.diComposite(`Vec<${el}>`, ["ptr", "i64", "i64"], ["data", "len", "cap"],
          [{ tag: "ptr", inner: t.element }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }], key);
        break;
      }
      case "hashmap":
        id = this.diComposite("HashMap", ["ptr", "i64", "i64", "i64", "i64"], ["data", "len", "cap", "seed", "tombstones"],
          [{ tag: "ptr", inner: { tag: "unknown" } }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }], key);
        break;
      case "struct": {
        const layout = this.structLayouts.get(t.name);
        if (!layout) return null;
        id = this.diComposite(t.name, layout.fields.map(f => f.type), layout.fields.map(f => f.name), layout.fields.map(f => f.typeKind), key);
        break;
      }
      case "enum": {
        const layout = this.enumLayouts.get(t.name);
        if (!layout) return null;
        id = this.diEnum(layout, key);
        break;
      }
      case "array": {
        if (t.size === null) return null; // slice — no fixed extent to describe yet
        const base = this.diType(t.element);
        if (base === null) return null;
        const sub = this.metaCounter++;
        this.diNodes.push(`!${sub} = !DISubrange(count: ${t.size})`);
        const subs = this.metaCounter++;
        this.diNodes.push(`!${subs} = !{!${sub}}`);
        id = this.metaCounter++;
        this.diNodes.push(`!${id} = !DICompositeType(tag: DW_TAG_array_type, baseType: !${base}, size: ${this.typeSizeOf(t) * 8}, elements: !${subs})`);
        break;
      }
      default:
        return null; // fn / interface / void / unknown
    }
    this.diTypes.set(key, id);
    return id;
  }

  // Emit a dbg.declare binding `varName` (stored at `addr`) to a DILocalVariable.
  // Skips silently when debug is off, we're inside a subprogram-less body (closure),
  // or the type can't be modelled — never emits metadata the verifier would reject.
  private dbgDeclare(lines: string[], varName: string, addr: string, t: TypeKind, line: number, argIndex: number): void {
    if (!this.emitDebug || this.currentSubprogramId === null) return;
    const ty = this.diType(t);
    if (ty === null) return;
    const varId = this.metaCounter++;
    const argAttr = argIndex > 0 ? `arg: ${argIndex}, ` : "";
    this.diNodes.push(`!${varId} = !DILocalVariable(name: "${this.diEsc(varName)}", ${argAttr}scope: !${this.currentSubprogramId}, file: !${this.currentSubprogramFileId}, line: ${line}, type: !${ty})`);
    lines.push(`  call void @llvm.dbg.declare(metadata ptr ${addr}, metadata !${varId}, metadata !DIExpression())`);
    this.usedDbgDeclare = true;
  }

  // The dot is required: a parameter named `t0` is emitted as the LLVM value
  // `%t0` (see the param prologue), so a bare `%t${n}` counter collides with it
  // and LLVM rejects the module with "multiple definition of local value". Milo
  // identifiers cannot contain `.`, so this prefix cannot be reached from source.
  public nextTemp(): string { return `%t.${this.tempCounter++}`; }
  public nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private localAddr(name: string): string {
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

  private addString(value: string): { label: string; length: number } {
    const label = `@.str.${this.strCounter++}`;
    const { escaped, byteLen } = this.escapeCString(value);
    const length = byteLen + 1; // null terminator
    this.strings.push({ label, escaped, length });
    return { label, length };
  }

  private typeSize(ty: string): number {
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
      return layout.payloadSlots > 0 ? 8 + layout.payloadSlots * 8 : 4;
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
  private zeroStore(ty: string, ptr: string): string {
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
  private valStore(ty: string, val: string, ptr: string): string {
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
  private emitMemcpy(lines: string[], dst: string, src: string, ty: string): void {
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${dst}, ptr ${src}, i64 ${this.typeSize(ty)}, i1 false)`);
  }

  // Evaluate `expr` and store its value into `destPtr` (LLVM type `ty`). For
  // big aggregates this keeps the value in memory end-to-end: direct calls to
  // sret-lowered fns write straight into destPtr, places copy via llvm.memcpy
  // (with the same move-out bookkeeping as the SSA paths in genExpr), and
  // struct literals build field-by-field in place. Any shape not handled falls
  // back to the plain genExpr+store path — correct, just slower to compile.
  private genStoreInto(lines: string[], destPtr: string, ty: string, expr: HIRExpr): void {
    // A C function-pointer field is one word, and a bare Milo function name is that
    // word: emit `@name` rather than genExpr's { code, env } pair, the same coercion
    // genCall already does for an extern fn's fn-typed parameter. The checker has
    // already refused every value that would need the env half.
    if (ty === "ptr" && expr.kind === "Ident" && expr.type.tag === "fn" && this.fnSigs.has(expr.name)) {
      lines.push(`  store ptr @${expr.name}, ptr ${destPtr}`);
      return;
    }
    if (this.isBigAgg(ty)) {
      if (expr.kind === "Call" && this.sretFns.has(expr.func)) {
        const [cl] = this.genExpr(expr, destPtr);
        lines.push(...cl);
        return;
      }
      // A big-agg replace writes its moved-out old value straight into destPtr, same as
      // an sret call — routed here so the old value never becomes an SSA aggregate.
      if (expr.kind === "MemReplace") {
        const [cl] = this.genExpr(expr, destPtr);
        lines.push(...cl);
        return;
      }
      if (expr.kind === "StructLit" && this.structLayouts.has(expr.name)) {
        const layout = must(this.structLayouts, expr.name, "struct layouts");
        for (const f of expr.fields) {
          const idx = layout.fields.findIndex(lf => lf.name === f.name);
          const fieldTy = layout.fields[idx].type;
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = getelementptr %${expr.name}, ptr ${destPtr}, i32 0, i32 ${idx}`);
          this.genStoreInto(lines, ptr, fieldTy, f.value);
        }
        return;
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
            this.emitMemcpy(lines, destPtr, srcPtr, ty);
            if (expr.isMove && this.needsDropCg(expr.type) && !identLocal?.isRef) {
              lines.push(this.zeroStore(ty, srcPtr));
              if (expr.kind === "Ident") {
                const dl = this.droppableLocals.find(d => d.addr === srcPtr);
                if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
              }
            }
            return;
          }
        }
      }
    }
    const [el, v] = this.genExpr(expr);
    lines.push(...el);
    lines.push(this.valStore(ty, v, destPtr));
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
    if (e.type.owning === true) return true;
    return e.kind === "Closure" && e.isMove === true && e.captures.length > 0;
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
    let escapes = false;
    const walk = (node: unknown): void => {
      if (escapes || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: string };
      // A nested closure that CAPTURES it keeps a copy of the {fn, env} pair, and that copy
      // can outlive this frame (`return move () => f(1)`). The capture is recorded by name,
      // so walking the nested body alone would miss it when that body only calls it.
      if (n.kind === "Closure" && Array.isArray(n.captures)
          && (n.captures as { name: string }[]).some(c => c.name === param.name)) { escapes = true; return; }
      // `f(…)` hands the closure to nobody: it is called and forgotten.
      if (n.kind === "ClosureCall") {
        const callee = n.callee as { kind?: string; name?: string } | undefined;
        if (!(callee?.kind === "Ident" && callee.name === param.name)) walk(n.callee);
        walk(n.args);
        return;
      }
      // Forwarding: `fn outer(g) { inner(g) }` keeps `g` only if `inner` does. Without this
      // a one-line wrapper would be indistinguishable from a store.
      if (n.kind === "Call" && Array.isArray(n.args)) {
        const args = n.args as HIRArg[];
        for (let i = 0; i < args.length; i++) {
          const e = args[i]?.expr;
          if (e?.kind === "Ident" && e.name === param.name) {
            if (this.closureParamEscapes(n.func as string, i, seen)) { escapes = true; return; }
          } else walk(args[i]);
        }
        return;
      }
      if (n.kind === "Ident" && n.name === param.name) { escapes = true; return; }
      for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
    };
    walk(fn.body);
    this.closureParamEscapeCache.set(key, escapes);
    return escapes;
  }

  private needsDropCg(t: TypeKind): boolean {
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

  private structNeedsDrop(name: string): boolean {
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
      return layout.payloadSlots > 0 ? 8 : 4;
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

  // C source that checks every `@cLayout` struct's declared layout against the real
  // header, or null if the program declared none. A Milo `extern struct` is otherwise an
  // unverified claim: the compiler believes the declared field order and computes offsets
  // from it, so a field that disagrees with the C header reads its neighbour and returns
  // plausible garbage — no crash, no diagnostic. C sees the true header, so it can check
  // the claim; this TU is compiled with `-fsyntax-only` at build time and discarded.
  cDeclGuards(): string | null {
    const cSigs = this.cSigs;
    const cValues = this.cValues;
    if (this.cLayoutStructs.length === 0 && cSigs.length === 0 && cValues.length === 0) return null;
    const headers = [...new Set([
      ...this.cLayoutStructs.map(s => s.cLayout!.header),
      ...cSigs.map(s => s.header),
      ...cValues.map(v => v.header),
    ])].sort();
    // One `#define MILO_HDR_n` per header spec, set only if the header is really there.
    // Without this a single absent header aborts the preprocessor and takes every OTHER
    // claim in the program down with it — one missing SDL header silently unverified the
    // stat/rusage layouts too. Each group of asserts now stands or falls on its own header.
    const hdrMacro = new Map<string, string>();
    headers.forEach((h, i) => hdrMacro.set(h, `MILO_HDR_${i}`));
    const featureMacros = guardFeatureMacros(headers);
    const out: string[] = [
      "// Generated by the Milo compiler to verify @cLayout declarations. Not part of the build output.",
      ...featureMacros.flatMap(f => [`#ifndef ${f}`, `#define ${f} 1`, "#endif"]),
      "#include <stddef.h>",
    ];
    for (const h of orderGuardIncludes(headers, this.target.os)) {
      const macro = must(hdrMacro, h, "hdr macro");
      // Alternates ("OpenGL/gl3.h|GL/glcorearb.h"): the same C entity under different
      // spellings per platform, for a header std can't assume one name for. First hit wins.
      // An alternate may prefix feature macros the header needs to declare anything at all
      // ("GL_GLEXT_PROTOTYPES+GL/glcorearb.h", "_GNU_SOURCE+sched.h") — without them the
      // header is present and empty, which reads as a wrong Milo declaration rather than a
      // missing #define.
      h.split("|").forEach((alt, i) => {
        const parts = alt.split("+");
        const path = parts.pop()!;
        out.push(`${i === 0 ? "#if" : "#elif"} __has_include(<${path}>)`);
        for (const feature of parts) out.push(`#ifndef ${feature}`, `#define ${feature} 1`, "#endif");
        out.push(`#include <${path}>`, `#define ${macro} 1`);
      });
      // Reported by verifyCDecls as a named skip. An unverified guard must never look
      // like a verified one, so silence is not an option here.
      out.push("#else", `#warning "milo-guard-skip: ${h}"`, "#endif");
    }
    out.push("");
    for (const s of this.cLayoutStructs) {
      const { cType } = s.cLayout!;
      const fieldTypes = s.fields.map(f => this.llvmType(f.type));
      out.push(`#ifdef ${must(hdrMacro, s.cLayout!.header, "hdr macro")}`);
      out.push(`// ${s.name} — declared in Milo as ${cType}`);
      s.fields.forEach((f, i) => {
        // @cOpaque: filler with no C counterpart. `offsetof(struct rusage, _p0)` is
        // ill-formed, so asserting it would make the struct uncheckable rather than
        // checked. It still occupies Milo's layout, so the size assert below still
        // covers it — that's the whole point of declaring the padding.
        if (f.cOpaque) return;
        const offset = this.structFieldOffset(fieldTypes, i);
        const size = this.typeSize(fieldTypes[i]!);
        out.push(
          `_Static_assert(offsetof(${cType}, ${f.name}) == ${offset}, ` +
          `"${s.name}.${f.name}: Milo says offset ${offset}, C header disagrees");`,
        );
        // Offsets alone can't catch a wrong width on the last field, and elsewhere a
        // too-narrow field can hide inside the next field's padding.
        out.push(
          `_Static_assert(sizeof(((${cType} *)0)->${f.name}) == ${size}, ` +
          `"${s.name}.${f.name}: Milo says ${size} bytes, C header disagrees");`,
        );
      });
      // `>=`, not `==`: declaring a prefix of a C struct is legitimate and common —
      // std's `Stat` stops at st_blksize and ignores the trailing platform fields.
      const size = this.structPayloadSize(fieldTypes);
      out.push(
        `_Static_assert(sizeof(${cType}) >= ${size}, ` +
        `"${s.name}: Milo declares ${size} bytes, larger than the real ${cType}");`,
        "#endif",
        "",
      );
    }
    for (const cs of cSigs) {
      out.push(`#ifdef ${must(hdrMacro, cs.header, "hdr macro")}`, ...this.cSigGuard(cs), "#endif", "");
    }
    for (const cv of cValues) {
      // Cast both sides to one 64-bit type so the comparison can't be decided by C's
      // usual arithmetic conversions — an `int` macro against a Milo u32 would otherwise
      // promote the macro to unsigned and pass on a bit pattern rather than a value.
      const cast = cv.signed ? "long long" : "unsigned long long";
      out.push(
        `#ifdef ${must(hdrMacro, cv.header, "hdr macro")}`,
        `// ${cv.global} — declared in ${cv.header} as ${cv.cName}`,
        `_Static_assert((${cast})(${cv.cName}) == (${cast})(${cv.value}), ` +
        `"${cv.global}: Milo says ${cv.value}, ${headerLabel(cv.header)} defines ${cv.cName} as something else");`,
        "#endif",
        "",
      );
    }
    return out.join("\n");
  }

  // Three independent claims per `@cSig`, so a failure says which one broke:
  //   1. the stated C signature really is what the header declares
  //   2. the Milo return type's width/signedness matches that C return type
  //   3. each Milo parameter's width — and, for a pointer, its pointee's width — matches
  //      the C parameter in the same position
  // Claim 3 is what an out-param needs: `glGetShaderiv(out: *u8)` against a C `GLint *`
  // links, runs, and writes four bytes through a pointer whose Milo type promises one, so
  // the caller sizes the local from the Milo type and GL scribbles past it. Nothing else in
  // the pipeline can see that — the ABI passes one word either way.
  private cSigGuard(cs: { fnName: string; header: string; sig: string; retType: TypeKind; params?: { type: TypeKind }[] }): string[] {
    const out: string[] = [`// ${cs.fnName} — declared in ${cs.header} as: ${cs.sig}`];
    // `long sysconf(int)` → type `long(int)`: drop the name, keep return + param list.
    const fnType = cs.sig.replace(new RegExp(`(^|[^A-Za-z0-9_])${cs.fnName}\\s*\\(`), "$1(");
    out.push(
      `_Static_assert(__builtin_types_compatible_p(__typeof__(${cs.fnName}), ${fnType}), ` +
      `"${cs.fnName}: '${cs.sig}' is not what ${headerLabel(cs.header)} declares");`,
    );
    // sizeof on a call is unevaluated — it yields the C return type's width without
    // running anything. Void has no width, and a struct return can't take literal 0 args.
    const ret = cs.retType;
    const arity = this.cSigArity(cs.sig);
    if (arity >= 0 && (ret.tag === "int" || ret.tag === "float" || ret.tag === "ptr")) {
      const args = Array(arity).fill("0").join(", ");
      const size = this.typeSize(this.llvmType(ret));
      out.push(
        `_Static_assert(sizeof(${cs.fnName}(${args})) == ${size}, ` +
        `"${cs.fnName}: Milo declares a ${size}-byte return, C returns a different width");`,
      );
      if (ret.tag === "int") {
        const signed = ret.signed ? "< 0" : "> 0";
        out.push(
          `_Static_assert((__typeof__(${cs.fnName}(${args})))-1 ${signed}, ` +
          `"${cs.fnName}: Milo declares ${ret.signed ? "a signed" : "an unsigned"} return, C disagrees");`,
        );
      }
    }
    out.push(...this.cSigParamGuards(cs));
    out.push("");
    return out;
  }

  // Per-parameter width asserts. Positional: C param i against Milo param i, which the
  // checker has already made the same count.
  private cSigParamGuards(cs: { fnName: string; sig: string; header: string; params?: { type: TypeKind }[] }): string[] {
    const params = cs.params;
    if (!params) return [];
    const cParams = cSigParams(cs.sig);
    if (!cParams) return [];
    const out: string[] = [];
    for (let i = 0; i < cParams.length && i < params.length; i++) {
      const ct = cParams[i]!;
      if (ct === "...") break;
      const mt = params[i]!.type;
      const where = `${cs.fnName} parameter ${i + 1}`;
      if (mt.tag === "int" || mt.tag === "float") {
        const size = this.typeSize(this.llvmType(mt));
        out.push(
          `_Static_assert(sizeof(${ct}) == ${size}, ` +
          `"${where}: Milo declares ${typeName(mt)} (${size} bytes), ${headerLabel(cs.header)} says '${ct}'");`,
        );
        continue;
      }
      // A Milo `*u8` is the deliberate "opaque bytes" spelling — it stands for C's `void *`
      // and for any pointer whose pointee Milo does not model (LPSECURITY_ATTRIBUTES, a
      // `struct stat` read as a byte buffer). Checking it would only force the author to
      // invent a fake pointee, so it is the documented opt-out. Any OTHER pointee is a
      // claim about how wide the callee's writes are, and that claim gets checked.
      if (mt.tag !== "ptr") continue;
      const pointee = mt.inner;
      if (pointee.tag === "int" && pointee.bits === 8) continue;
      // The deref is emitted from the MILO side, not from how the C type is spelled: half
      // of Win32's pointer parameters are typedefs that hide the star (LPDWORD, PHANDLE,
      // LPSTR), and gating on a trailing `*` let exactly those through unchecked. If C
      // turns out not to be a pointer at all, clang says so and verifyCDecls translates it.
      if (/(^|[^A-Za-z0-9_])void\s*\*$/.test(ct)) continue;
      const size = this.typeSize(this.llvmType(pointee));
      // `>=` for a struct pointee, matching @cLayout: declaring a prefix of a C struct is
      // legitimate, so a Milo struct smaller than the C one is not an error.
      const op = pointee.tag === "struct" ? ">=" : "==";
      out.push(
        `_Static_assert(sizeof(*(${ct})0) ${op} ${size}, ` +
        `"${where}: Milo writes through a ${typeName(mt)} (${size}-byte pointee), ${headerLabel(cs.header)} says '${ct}'");`,
      );
    }
    return out;
  }

  // Arity for the return-width assert, which calls the function with that many literal
  // zeroes. -1 when the list can't be split (a function-pointer parameter), so the assert
  // is dropped rather than emitted with the wrong argument count.
  private cSigArity(sig: string): number {
    const params = cSigParams(sig);
    return params ? params.length : -1;
  }

  private structPayloadSize(fieldTypes: string[]): number {
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

  private structFieldOffset(fieldTypes: string[], fieldIdx: number): number {
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

  private mainCanSpawnGreenTasks(functions: HIRFunction[], initFn: HIRFunction | null): boolean {
    // wasm's makecontext is an abort stub and bare metal has no scheduler at
    // all: a program targeting them that spawns is already broken, and wrapping
    // would break the ones that don't.
    const os = this.target.os;
    if (os !== "darwin" && os !== "linux" && os !== "windows") return false;
    const byName = new Map(functions.map(f => [f.name, f]));
    if (!byName.has(Codegen.GREEN_RUN_MAIN_FN)) return false;
    // The wrapper calls the body with no arguments; a `main` that takes any
    // would emit a call that does not match its callee.
    if ((byName.get("main")?.params.length ?? 0) > 0) return false;
    const seen = new Set<string>();
    const stack = ["main"];
    if (initFn) stack.push(initFn.name);
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
    lines.push(`define i32 @main(i32 %_milo_argc, ptr %_milo_argv) {`);
    lines.push("entry.bb:");
    lines.push("  store i32 %_milo_argc, ptr @_milo_argc_global");
    lines.push("  store ptr %_milo_argv, ptr @_milo_argv_global");
    // before global init: an initializer can print, and setvbuf must precede any I/O
    this.emitStdoutBufferingOptIn(lines);
    if (this.needsGlobalInit) lines.push(`  call void @${GLOBAL_INIT_FN}()`);
    lines.push(`  call void @${Codegen.GREEN_RUN_MAIN_FN}(ptr @${Codegen.MAIN_TASK_FN})`);
    lines.push(`  %exit = load i32, ptr @${Codegen.MAIN_EXIT_GLOBAL}`);
    lines.push("  ret i32 %exit");
    lines.push("}");
    lines.push("");
    // spawnWithStack calls this through the closure ABI, which passes an env
    // pointer this entry has no use for.
    lines.push(`define internal void @${Codegen.MAIN_TASK_FN}(ptr %__env) {`);
    lines.push("entry.bb:");
    lines.push(`  %code = call i32 @${Codegen.MAIN_BODY_FN}()`);
    lines.push(`  store i32 %code, ptr @${Codegen.MAIN_EXIT_GLOBAL}`);
    lines.push("  ret void");
    lines.push("}");
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
      const variants = new Map<string, { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }>();
      for (const v of e.variants) {
        variants.set(v.name, { tag: v.tag, fieldTypes: v.fields.map(f => this.llvmType(f)), fieldTypeKinds: v.fields });
      }
      this.enumLayouts.set(e.name, { name: e.name, payloadSlots: 0, variants });
    }
    for (let pass = 0; pass <= module.enums.length; pass++) {
      let changed = false;
      for (const e of module.enums) {
        const layout = must(this.enumLayouts, e.name, "enum layouts");
        let maxPayload = 0;
        for (const v of layout.variants.values()) {
          maxPayload = Math.max(maxPayload, this.structPayloadSize(v.fieldTypes));
        }
        const slots = Math.ceil(maxPayload / 8);
        if (slots > layout.payloadSlots) {
          layout.payloadSlots = slots;
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
    for (const g of module.globals) {
      const ty = this.llvmType(g.type);
      this.globalVars.set(g.name, { type: ty, typeKind: g.type });
    }

    // A global whose initializer needs to run code (an arena, a populated Vec) is emitted
    // zeroed and filled in by a generated routine that main calls before its own body.
    // Evaluation is `module.globals` order, which the checker has already sorted so that
    // every global follows the ones its initializer reads (across modules too).
    const runtimeInitGlobals = module.globals.filter(g => !this.isFullyConstInit(g));
    this.needsGlobalInit = runtimeInitGlobals.length > 0;
    const initFn: HIRFunction | null = runtimeInitGlobals.length === 0 ? null : {
      name: GLOBAL_INIT_FN,
      params: [],
      retType: { tag: "void" },
      body: runtimeInitGlobals.map(g => ({
        kind: "Assign" as const,
        target: { kind: "Ident" as const, name: g.name, type: g.type },
        value: g.value,
        isInit: true,
      })),
      isExtern: false,
      isVariadic: false,
    };

    this.wrapMainGreen = this.mainCanSpawnGreenTasks(functions, initFn);
    if (this.wrapMainGreen) this.emit(`@${Codegen.MAIN_EXIT_GLOBAL} = internal global i32 0`);

    // generate function bodies first (collects string constants, sets needsBoundsCheck)
    const fnBodies: string[][] = [];
    for (const fn of functions) fnBodies.push(this.genFunction(fn));
    if (initFn) fnBodies.push(this.genFunction(initFn));

    // auto-declare C functions needed by built-ins and bounds checks
    const declaredExterns = new Set(externs.map(e => e.name));
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
    if (this.needsGetentropy && !declaredExterns.has("getentropy"))
      this.output.splice(1, 0, this.isWindows
        // BCryptGenRandom(NULL, buf, len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) is the
        // UCRT-era CSPRNG; passing the system-preferred flag is what lets the algorithm
        // handle be NULL. Returns an NTSTATUS (0 = success), not an errno.
        ? "declare i32 @BCryptGenRandom(ptr, ptr, i32, i32)"
        : "declare i32 @getentropy(ptr, i64)");
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
        this.ensureStructDropHelper(itable.concreteType);
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
      if (layout.payloadSlots > 0) {
        this.output.splice(1, 0, `%${name} = type { i32, [${layout.payloadSlots} x i64] }`);
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

    // insert extern declarations
    for (const ext of externs) {
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
      this.output.splice(1, 0, `declare ${retType} @${ext.name}(${paramTypes.join(", ")})`);
    }

    if (this.needsSetvbuf) fnBodies.push(this.lineBufferInitFn());
    if (this.wrapMainGreen) fnBodies.push(this.greenMainEntry());

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

    if (this.emitDebug) this.applyDebugInfo();
    // After applyDebugInfo: that pass matches `!dbg !N {` at the end of a define line,
    // and the attribute group this inserts sits before the metadata.
    if (this.sanitize) this.applySanitizeAttribute();

    return this.output.join("\n") + "\n";
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
    out.push("", `attributes #${SANITIZE_ATTRS} = { sanitize_address }`);
  }

  // Resolve deferred ;MILODBG markers into real !dbg attachments over the assembled
  // module. Scope comes from the enclosing function's define-line subprogram, so
  // closures/trampolines (no subprogram) get their markers stripped instead of
  // mis-scoped — the one rule the LLVM verifier enforces on debug locations. Also
  // back-fills prologue/contract/drop instructions with the function line so that
  // any `call` in a debug-info function carries a location (verifier requirement).
  private applyDebugInfo(): void {
    const out = this.output;
    const MARK = " ;MILODBG ";
    let curSp = -1;
    let curLine = 0;
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      if (l.startsWith("define ")) {
        const m = l.match(/ !dbg !(\d+) \{$/);
        if (m) { curSp = parseInt(m[1], 10); curLine = this.diSubprogramLine.get(curSp) ?? 0; }
        else curSp = -1;
        continue;
      }
      if (l === "}") { curSp = -1; continue; }
      const mk = l.indexOf(MARK);
      if (curSp < 0) {
        // A dbg.declare can only ride into a subprogram-less body (closure/trampoline)
        // if scope leaked during its generation; drop it so its mis-scoped variable
        // can't reach the verifier. The orphaned DILocalVariable node is harmless.
        if (l.includes("@llvm.dbg.declare")) { out.splice(i, 1); i--; continue; }
        if (mk >= 0) out[i] = l.slice(0, mk); // drop stray marker in a non-debug fn
        continue;
      }
      if (mk >= 0) {
        const parts = l.slice(mk + MARK.length).split(" ");
        const locId = this.diLocation(parseInt(parts[0], 10), parseInt(parts[1], 10) || 0, curSp);
        out[i] = l.slice(0, mk) + `, !dbg !${locId}`;
      } else if (l.length >= 2 && l[0] === " " && l[1] === " ") {
        const t = l.trimStart();
        if (t.length > 0 && t[0] !== ";" && !l.includes("!dbg")) {
          out[i] = l + `, !dbg !${this.diLocation(curLine, 0, curSp)}`;
        }
      }
    }

    if (this.diNodes.length === 0) return; // no user functions → nothing to anchor
    const cu = this.diCompileUnit();
    const dwarfVer = this.metaCounter++;
    const dbgVer = this.metaCounter++;
    out.push("");
    for (const n of this.diNodes) out.push(n);
    out.push(`!${dwarfVer} = !{i32 2, !"Dwarf Version", i32 4}`);
    out.push(`!${dbgVer} = !{i32 2, !"Debug Info Version", i32 3}`);
    out.push(`!llvm.dbg.cu = !{!${cu}}`);
    out.push(`!llvm.module.flags = !{!${dwarfVer}, !${dbgVer}}`);
  }

  private genFunction(fn: HIRFunction): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals.clear();
    this.droppableLocals = [];
    this.entryAllocas = [];
    this.emittedAddrs.clear();
    this.currentFnName = fn.name;
    this.currentFnWrapping = !!fn.isWrapping;
    const lines: string[] = [];

    const params = fn.params.map(p => {
      const lt = p.isRef || p.isRefMut ? "ptr" : this.llvmType(p.type);
      return `${lt} %${p.name}`;
    }).join(", ");
    // main is the process entry point: the OS reads its return register as the exit code, so it
    // must always be i32 even when the Milo signature is void (`fn main()`). A `void @main` leaves
    // garbage in the return register → nonzero exit on a program that should succeed.
    const isSret = this.sretFns.has(fn.name);
    this.currentFnSret = isSret;
    const ret = fn.name === "main" ? "i32" : isSret ? "void" : this.llvmType(fn.retType);
    // Subprogram attaches BEFORE the `{`; applyDebugInfo keys function boundaries off this.
    const dbgAttr = this.emitDebug ? ` !dbg !${this.diSubprogram(fn)}` : "";
    if (this.emitDebug) {
      this.currentSubprogramId = this.diSubprogram(fn);
      this.currentSubprogramFileId = this.diFile(fn.sourceFile ?? this.filePath ?? "<unknown>");
    }
    if (fn.name === "main" && this.wrapMainGreen) {
      // The entry point is the wrapper (greenMainEntry); this is just its body,
      // so argc/argv and the global-init call belong there, not here.
      lines.push(`define internal ${ret} @${Codegen.MAIN_BODY_FN}(${params})${dbgAttr} {`);
    } else if (fn.name === "main") {
      const mainParams = params ? `i32 %_milo_argc, ptr %_milo_argv, ${params}` : "i32 %_milo_argc, ptr %_milo_argv";
      lines.push(`define ${ret} @${fn.name}(${mainParams})${dbgAttr} {`);
    } else {
      // Non-root fns are internal (like globals): each object carries its own copy.
      // linkonce_odr let the linker merge same-named fns across separately-compiled
      // objects and silently pick one body when they differed (issue #5).
      const linkage = this.exportedFnNames.has(fn.name) ? "" : "internal ";
      // `.` can't appear in a Milo identifier, so %__sret.out never collides
      const allParams = isSret ? (params ? `ptr %__sret.out, ${params}` : "ptr %__sret.out") : params;
      lines.push(`define ${linkage}${ret} @${fn.name}(${allParams})${dbgAttr} {`);
    }
    // Dotted label, not bare `entry`: LLVM shares one symbol table for block
    // labels and local values, and params are emitted as `%<name>`. A param named
    // `entry` (a legal Milo identifier) would otherwise collide with the entry
    // block. A `.` can't appear in a Milo identifier, so `entry.bb` never clashes.
    lines.push("entry.bb:");
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
          lines.push(`  store i1 1, ptr ${aliveFlag}`);
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
      this.markDbg(spill, 0, 0);
      for (let i = 0; i < spill.length; i++) lines[paramSpillStart + i] = spill[i];
    }

    const allocaInsertPoint = lines.length;

    this.currentEnsures = [];
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
      if (ret === "void") lines.push("  ret void");
      else if (this.currentFnName === "main") lines.push("  ret i32 0");
      // The checker rejects any other non-void fn that can fall off, so this end is
      // only reached past a `while true` with no break: a block that needs a
      // terminator and can never execute. A trap rather than bare `unreachable`, so a
      // shape the checker misses aborts instead of running past the end of the function.
      else { lines.push("  call void @llvm.trap()"); lines.push("  unreachable"); }
    }

    // hoist body allocas to entry block
    if (this.entryAllocas.length > 0) {
      lines.splice(allocaInsertPoint, 0, ...this.entryAllocas);
    }
    this.hoistAllocas(lines, allocaInsertPoint);

    lines.push("}");
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
    const hoisted: string[] = [];
    let pastEntryBlock = false;
    for (let i = insertAt; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 0 && line[0] !== " " && line.endsWith(":")) {
        pastEntryBlock = true;
        continue;
      }
      if (pastEntryBlock && /^ {2}%\S+ = alloca /.test(line)) {
        hoisted.push(line);
        lines.splice(i, 1);
        i--;
      }
    }
    if (hoisted.length > 0) lines.splice(insertAt, 0, ...hoisted);
  }

  private genStmt(stmt: HIRStmt): [string[], boolean] {
    const [lines, terminated] = this.genStmtRaw(stmt);
    // Precise per-stmt line tagging. Nested stmts (via recursive genStmt) mark first;
    // skip-if-marked leaves only this stmt's own lines for its span.
    if (this.emitDebug && stmt.span) this.markDbg(lines, stmt.span.line, stmt.span.col);
    return [lines, terminated];
  }

  private genStmtRaw(stmt: HIRStmt): [string[], boolean] {
    const lines: string[] = [];

    switch (stmt.kind) {
      case "Let": {
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
        if (bigTmp) this.emitMemcpy(lines, addrName, bigTmp, declTy);
        else if (!bigAgg) lines.push(this.valStore(declTy, val, addrName));
        // Describe the value actually stored: for `&T` locals that's the inner value.
        this.dbgDeclare(lines, stmt.name, addrName, storedTypeKind, stmt.span?.line ?? 0, 0);
        // Locals that borrow from a ref are a shallow copy — data owned elsewhere.
        if (declDroppable) {
          lines.push(`  store i1 1, ptr ${declAliveFlag}`);
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
          if (isLValueTgt && this.needsDropCg(stmt.target.type) && !this.lvalueMatches(stmt.value, stmt.target)) {
            this.emitDropValue(lines, tPtr, stmt.target.type);
          }
          this.emitMemcpy(lines, tPtr, tmp, assignLlTy);
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
        if (isLValueTarget && this.needsDropCg(stmt.target.type) && !this.lvalueMatches(stmt.value, stmt.target)) {
          this.emitDropValue(lines, targetPtr, stmt.target.type);
        }
        lines.push(this.valStore(valTy, val, targetPtr));
        return [lines, false];
      }
      case "Return": {
        if (!stmt.value) {
          this.emitEnsuresChecks(lines);
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
          this.genStoreInto(lines, "%__sret.out", retLl, stmt.value);
          if (this.currentEnsures.length > 0) {
            this.emitMemcpy(lines, "%__contract_result.addr", "%__sret.out", retLl);
            const savedResult = this.locals.get("result");
            this.locals.set("result", { type: retLl, typeKind: stmt.retType, mutable: false, isRef: false, addr: "%__contract_result.addr" });
            this.emitEnsuresChecks(lines);
            if (savedResult) this.locals.set("result", savedResult);
            else this.locals.delete("result");
          } else {
            this.emitEnsuresChecks(lines);
          }
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
        this.emitDropGlue(lines);
        if (valTy === "void") lines.push("  ret void");
        else lines.push(`  ret ${valTy} ${val}`);
        return [lines, true];
      }
      case "If": return this.genIf(stmt);
      case "While": return this.genWhile(stmt);
      case "Break":
        if (this.loopExit) {
          this.emitLoopDropGlue(lines);
          lines.push(`  br label %${this.loopExit}`);
        }
        return [lines, true];
      case "Continue":
        if (this.loopHeader) {
          this.emitLoopDropGlue(lines);
          lines.push(`  br label %${this.loopHeader}`);
        }
        return [lines, true];
      case "ExprStmt": {
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
        return this.genMatch(stmt);
      case "NullRefUnwrap":
        return this.genNullRefUnwrap(stmt);
      case "UnsafeBlock": {
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
    if (expr.kind === "HeapDeref") {
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
      // truncate i64 index to i32 for bounds check and GEP
      let idx32 = idxVal;
      if (idxTy === "i64") {
        idx32 = this.nextTemp();
        lines.push(`  ${idx32} = trunc i64 ${idxVal} to i32`);
      }
      this.emitBoundsCheck(lines, idx32, String(size), expr.span);
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${objTy}, ptr ${objPtr}, i32 0, i32 ${idx32}`);
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
  private emitBoundsCheck(lines: string[], idx: string, size: string, span?: Span) {
    this.needsBoundsCheck = true;
    const cmpTmp = this.nextTemp();
    const okLabel = this.nextLabel("bounds.ok");
    const failLabel = this.nextLabel("bounds.fail");

    lines.push(`  ${cmpTmp} = icmp ult i32 ${idx}, ${size}`);
    lines.push(`  br i1 ${cmpTmp}, label %${okLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    // The location rides into the out-of-line handler as arguments, the way the overflow
    // check already does — keeping it out of the hot block, which is the whole point of
    // the handler being out of line.
    const filePtr = this.emitCheckFilePtr(lines, span);
    lines.push(`  call void @__milo_bounds_fail(i32 ${idx}, i32 ${size}, ptr ${filePtr}, i32 ${span?.line ?? 0})`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private overflowFailHelper(): string[] {
    const lines: string[] = [];
    lines.push(`define internal void @__milo_overflow_fail(ptr %file, i32 %line) noreturn cold noinline {`);
    lines.push(`entry.bb:`);
    lines.push(`  %fmt = getelementptr [46 x i8], ptr @.overflow_err, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, "%fmt", `, ptr %file, i32 %line`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`}`);
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
          case "UnsafeBlock": walk(st.body); break;
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
        const len32 = this.nextTemp();
        lines.push(...ptrLines);
        lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
        lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
        lines.push(`  ${len32} = trunc i64 ${len} to i32`);
        scope.set(key, { len: len32, decl: this.locals.get(root) });
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
          case "UnsafeBlock":
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
    lines.push(`define internal void @__milo_bounds_fail(i32 %idx, i32 %len, ptr %file, i32 %line) noreturn cold noinline {`);
    lines.push(`entry.bb:`);
    lines.push(`  %fmt = getelementptr [${BOUNDS_ERR_LEN} x i8], ptr @.bounds_err, i32 0, i32 0`);
    this.emitFdPrintf(lines, 2, "%fmt", `, i32 %idx, i32 %len, ptr %file, i32 %line`);
    this.panicAbort(lines);
    lines.push(`  unreachable`);
    lines.push(`}`);
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
  private emitNonNegativeCheck(lines: string[], val: string, what: string, span?: { line: number; col: number }) {
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
  private panicAt(span?: Span): string {
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
  private emitCheckFilePtr(lines: string[], span?: Span): string {
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
    const prevDropStart = this.loopDropStart;
    this.loopHeader = condLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length;
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
    this.loopDropStart = prevDropStart;
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
    const prevDropStart = this.loopDropStart;
    // continue goes to increment, not condition
    this.loopHeader = incrLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length;

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
    this.loopDropStart = prevDropStart;
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
  private genForEachIterableAddr(iterable: HIRExpr): Gen {
    const lvalueKinds = ["Ident", "FieldAccess", "IndexAccess", "PtrDeref", "HeapDeref"];
    if (lvalueKinds.includes(iterable.kind)) {
      return this.genLValue(iterable);
    }
    const lines: string[] = [];
    const [valLines, val] = this.genExpr(iterable);
    lines.push(...valLines);
    const iterTy = this.llvmType(iterable.type);
    const addr = this.nextTemp();
    this.entryAllocas.push(`  ${addr} = alloca ${iterTy}`);
    lines.push(`  store ${iterTy} ${val}, ptr ${addr}`);
    if (this.needsDropCg(iterable.type)) {
      // Register before the caller sets loopDropStart so this temp is function-
      // scoped (dropped once at fn exit / early return), not loop-body-scoped.
      const name = `__forin_tmp.${this.scopeCounter++}`;
      this.locals.set(name, { type: iterTy, typeKind: iterable.type, mutable: false, isRef: false, addr });
      const aliveFlag = `${addr}.alive`;
      this.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
      this.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
      lines.push(`  store i1 1, ptr ${aliveFlag}`);
      this.droppableLocals.push({ name, typeKind: iterable.type, aliveFlag, addr });
    }
    return [lines, addr, iterTy];
  }

  private genForEach(stmt: HIRStmt & { kind: "ForEach" }): [string[], boolean] {
    const lines: string[] = [];

    if (stmt.iterableKind === "vec") {
      // get pointer to the vec so we can extract data ptr and len
      const [iterLines, iterAddr] = this.genForEachIterableAddr(stmt.iterable);
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
      this.entryAllocas.push(`  ${varAddr} = alloca ptr`);
      const savedLoopLocals = [this.bindLoopLocal(elemName, { type: elemTy, typeKind: elemTypeKind, mutable: false, isRef: true, addr: varAddr })];
      if (stmt.varName2) {
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const bodyLabel = this.nextLabel("for.body");
      const incrLabel = this.nextLabel("for.incr");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart;
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length;

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
      lines.push(`  store ptr ${elemPtr}, ptr ${varAddr}`);

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
      this.loopDropStart = prevDropStart;
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
      const prevDropStart = this.loopDropStart;
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length;

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
      this.loopDropStart = prevDropStart;
      this.unbindLoopLocals(savedLoopLocals);
      return [lines, false];

    } else if (stmt.iterableKind === "array") {
      const [iterLines, iterAddr, iterTy] = this.genForEachIterableAddr(stmt.iterable);
      lines.push(...iterLines);
      const match = iterTy.match(/\[(\d+) x (.+)\]/);
      if (!match) throw new Error("expected fixed array type for for-each");
      const arrSize = parseInt(match[1]);
      const elemTy = match[2];
      const elemTypeKind3 = stmt.varName2 ? stmt.varType2! : stmt.varType;

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i32`);
      lines.push(`  store i32 0, ptr ${idxAddr}`);

      const elemName3 = stmt.varName2 ?? stmt.varName;
      const varAddr = this.allocaName(elemName3);
      this.entryAllocas.push(`  ${varAddr} = alloca ptr`);
      const savedLoopLocals = [this.bindLoopLocal(elemName3, { type: elemTy, typeKind: elemTypeKind3, mutable: false, isRef: true, addr: varAddr })];
      if (stmt.varName2) {
        savedLoopLocals.push(this.bindLoopLocal(stmt.varName, { type: "i32", typeKind: { tag: "int", bits: 32, signed: true }, mutable: false, isRef: false, addr: idxAddr }));
      }

      const condLabel = this.nextLabel("for.cond");
      const bodyLabel = this.nextLabel("for.body");
      const incrLabel = this.nextLabel("for.incr");
      const endLabel = this.nextLabel("for.end");
      const prevHeader = this.loopHeader;
      const prevExit = this.loopExit;
      const prevDropStart = this.loopDropStart;
      this.loopHeader = incrLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length;

      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const idx = this.nextTemp();
      lines.push(`  ${idx} = load i32, ptr ${idxAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i32 ${idx}, ${arrSize}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const elemPtr = this.nextTemp();
      lines.push(`  ${elemPtr} = getelementptr ${iterTy}, ptr ${iterAddr}, i32 0, i32 ${idx}`);
      lines.push(`  store ptr ${elemPtr}, ptr ${varAddr}`);

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
      lines.push(`  ${curIdx} = load i32, ptr ${idxAddr}`);
      lines.push(`  ${nextIdx} = add i32 ${curIdx}, 1`);
      lines.push(`  store i32 ${nextIdx}, ptr ${idxAddr}`);
      lines.push(`  br label %${condLabel}`);

      lines.push(`${endLabel}:`);
      this.loopHeader = prevHeader;
      this.loopExit = prevExit;
      this.loopDropStart = prevDropStart;
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
      const prevDropStart = this.loopDropStart;
      this.loopHeader = nextLabel;
      this.loopExit = endLabel;
      this.loopDropStart = this.droppableLocals.length;

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
      this.loopDropStart = prevDropStart;
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
      this.helperFnBodies.push([
        "define internal i64 @milo.strfind(ptr %h, i64 %hlen, ptr %n, i64 %nlen, i64 %from) {",
        "entry:",
        // negative when the needle is longer than the haystack, which makes the first
        // comparison below fail and the search miss without a special case
        "  %limit = sub i64 %hlen, %nlen",
        "  br label %loop",
        "loop:",
        "  %i = phi i64 [ %from, %entry ], [ %inext, %next ]",
        "  %past = icmp sgt i64 %i, %limit",
        "  br i1 %past, label %miss, label %cmp",
        "cmp:",
        "  %p = getelementptr i8, ptr %h, i64 %i",
        "  %c = call i32 @memcmp(ptr %p, ptr %n, i64 %nlen)",
        "  %eq = icmp eq i32 %c, 0",
        "  br i1 %eq, label %hit, label %next",
        "next:",
        "  %inext = add i64 %i, 1",
        "  br label %loop",
        "hit:",
        "  ret i64 %i",
        "miss:",
        "  ret i64 -1",
        "}",
      ]);
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
    const prevDropStart = this.loopDropStart;
    this.loopHeader = incrLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length;

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
    this.loopDropStart = prevDropStart;
    this.unbindLoopLocals(savedLoopLocals);
    return [lines, false];
  }

  private genForIterator(stmt: HIRStmt & { kind: "ForIterator" }): [string[], boolean] {
    const lines: string[] = [];
    // The iterator protocol calls next(&mut self), which needs the iterable at a
    // real address. An lvalue already has one; an rvalue (e.g. `for x in mk()`)
    // does not — genLValue would hand back `null` and next() would deref it
    // (SIGTRAP). Materialize the rvalue into a temp alloca first.
    const lvalueKinds = ["Ident", "FieldAccess", "IndexAccess", "PtrDeref", "HeapDeref"];
    let iterAddr: string;
    if (lvalueKinds.includes(stmt.iterable.kind)) {
      const [iterLines, addr] = this.genLValue(stmt.iterable);
      lines.push(...iterLines);
      iterAddr = addr;
    } else {
      const [valLines, val] = this.genExpr(stmt.iterable);
      lines.push(...valLines);
      const iterTy = this.llvmType(stmt.iterable.type);
      iterAddr = this.nextTemp();
      this.entryAllocas.push(`  ${iterAddr} = alloca ${iterTy}`);
      lines.push(`  store ${iterTy} ${val}, ptr ${iterAddr}`);
    }

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
    const prevDropStart = this.loopDropStart;
    this.loopHeader = condLabel;
    this.loopExit = endLabel;
    this.loopDropStart = this.droppableLocals.length;

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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${retTy}, ptr ${stagePtr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    // branch: Some → body, None → end
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, ${noneVariant.tag}`);
    lines.push(`  br i1 ${cmp}, label %${endLabel}, label %${bodyLabel}`);

    lines.push(`${bodyLabel}:`);
    // extract payload from Some variant
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${retTy}, ptr ${stagePtr}, i32 0, i32 1`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${payloadPtr}`);
    lines.push(`  store ${elemTy} ${val}, ptr ${varAddr}`);

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
    this.loopDropStart = prevDropStart;
    this.unbindLoopLocals(savedLoopLocals);
    return [lines, false];
  }

  private genMatch(stmt: HIRStmt & { kind: "Match" }, resultSlot?: { addr: string; ty: string }): [string[], boolean] {
    // Route by the SUBJECT's type, not just the pattern kinds. genEnumMatch reads a
    // tag/payload out of the scrutinee via GEP, which is only valid for an enum. A
    // scalar matched with only a wildcard (`match x { _ => ... }`) has no literal
    // pattern, but it is NOT an enum — sending it to genEnumMatch emitted an invalid
    // `getelementptr i64` on the scalar. Only an enum subject uses the enum path.
    if (stmt.subject.type.tag === "enum") return this.genEnumMatch(stmt, resultSlot);
    return this.genLiteralMatch(stmt, resultSlot);
  }

  // Emit a match arm's body. In statement mode (no resultSlot) every stmt runs
  // as-is. In value mode (match-expression) all but the tail run as stmts and
  // the tail ExprStmt's value is stored into resultSlot — same shape as IfExpr.
  private emitMatchArmBody(lines: string[], body: HIRStmt[], resultSlot?: { addr: string; ty: string }): boolean {
    if (!resultSlot) {
      for (const s of body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) return true;
      }
      return false;
    }
    for (let i = 0; i < body.length - 1; i++) {
      const [sl, t] = this.genStmt(body[i]);
      lines.push(...sl);
      if (t) return true;
    }
    if (body.length > 0) {
      const last = body[body.length - 1];
      if (last.kind === "ExprStmt") {
        const [vl, vv] = this.genExpr(last.expr);
        lines.push(...vl);
        if (vv !== "void") lines.push(`  store ${resultSlot.ty} ${vv}, ptr ${resultSlot.addr}`);
        // Yielding a droppable local out of the arm hands its heap data to the
        // result slot — a move, not a copy. Clear the alive flag so the arm's
        // drop does not free what the match's value now owns.
        // Matched on the local's ADDRESS, not its name: a function can hold
        // several droppable locals called the same thing in different scopes,
        // and by-name lookup cleared the first entry's flag — dropping a live
        // value belonging to an unrelated scope.
        if (vv !== "void" && last.expr.kind === "Ident") {
          const yieldedAddr = this.localAddr((last.expr as { name: string }).name);
          const yielded = this.droppableLocals.find(d => d.addr === yieldedAddr);
          if (yielded) lines.push(`  store i1 0, ptr ${yielded.aliveFlag}`);
        }
      } else {
        const [sl, t] = this.genStmt(last);
        lines.push(...sl);
        if (t) return true;
      }
    }
    return false;
  }

  private genLiteralMatch(stmt: HIRStmt & { kind: "Match" }, resultSlot?: { addr: string; ty: string }): [string[], boolean] {
    const lines: string[] = [];
    const [subjLines, subjVal, subjTy] = this.genExpr(stmt.subject);
    lines.push(...subjLines);

    const endLabel = this.nextLabel("match.end");
    let allArmsTerminated = true;

    const literalArms: { label: string; nextLabel: string; arm: typeof stmt.arms[0] }[] = [];
    let wildcardArm: typeof stmt.arms[0] | null = null;

    for (const arm of stmt.arms) {
      if (arm.pattern.kind === "WildcardPattern") {
        wildcardArm = arm;
      } else {
        const label = this.nextLabel("match.arm");
        literalArms.push({ label, nextLabel: "", arm });
      }
    }

    // Fast path — an all-integer/char match lowers to a single LLVM `switch`
    // rather than an icmp/br comparison chain. LLVM turns the switch into a jump
    // table (O(1) dispatch instead of a linear scan) and, critically, the CFG
    // stays flat: a 250-arm opcode dispatcher was becoming a 461-branch chain
    // that -O2's superlinear passes choked on (>3 min vs seconds). Requires
    // distinct case values (LLVM rejects duplicates); anything else (string,
    // bool, float, dup values) falls through to the chain below.
    const allIntCharDistinct = (() => {
      if (literalArms.length === 0) return false;
      const seen = new Set<string>();
      for (const la of literalArms) {
        const p = la.arm.pattern;
        if (p.kind !== "LiteralPattern" || (p.literalKind !== "int" && p.literalKind !== "char")) return false;
        const key = String(p.value);
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    })();

    if (allIntCharDistinct) {
      const defaultLabel = wildcardArm ? this.nextLabel("match.wildcard") : this.nextLabel("match.default");
      const cases = literalArms.map(la => {
        const p = la.arm.pattern as HIRPattern & { kind: "LiteralPattern" };
        return `${subjTy} ${p.value}, label %${la.label}`;
      }).join(" ");
      lines.push(`  switch ${subjTy} ${subjVal}, label %${defaultLabel} [${cases}]`);
      for (const la of literalArms) {
        lines.push(`${la.label}:`);
        const armTerminated = this.emitMatchArmBody(lines, la.arm.body, resultSlot);
        if (!armTerminated) { lines.push(`  br label %${endLabel}`); allArmsTerminated = false; }
      }
      lines.push(`${defaultLabel}:`);
      if (wildcardArm) {
        const wcTerminated = this.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
        if (!wcTerminated) { lines.push(`  br label %${endLabel}`); allArmsTerminated = false; }
      } else {
        lines.push(`  unreachable`);
      }
      lines.push(`${endLabel}:`);
      if (allArmsTerminated) lines.push(`  unreachable`);
      return [lines, allArmsTerminated];
    }

    // chain: compare → arm body or fall through to next comparison
    for (let i = 0; i < literalArms.length; i++) {
      const next = i + 1 < literalArms.length
        ? this.nextLabel("match.cmp")
        : wildcardArm
          ? this.nextLabel("match.wildcard")
          : this.nextLabel("match.default");
      literalArms[i].nextLabel = next;

      const pat = literalArms[i].arm.pattern;
      if (pat.kind !== "LiteralPattern") continue;

      let cmpVal: string;
      if (pat.literalKind === "string") {
        this.hasStringType = true;
        const litStr = this.addString(String(pat.value));
        const litVal = this.nextTemp();
        lines.push(`  ${litVal} = insertvalue %String undef, ptr ${litStr.label}, 0`);
        const litVal2 = this.nextTemp();
        lines.push(`  ${litVal2} = insertvalue %String ${litVal}, i64 ${litStr.length - 1}, 1`);
        const [, cmpResult] = this.genStringCmp(lines, subjVal, litVal2, true);
        cmpVal = cmpResult;
      } else if (pat.literalKind === "bool") {
        const litVal = pat.value ? "1" : "0";
        cmpVal = this.nextTemp();
        lines.push(`  ${cmpVal} = icmp eq i1 ${subjVal}, ${litVal}`);
      } else if (pat.literalKind === "int" || pat.literalKind === "char") {
        cmpVal = this.nextTemp();
        lines.push(`  ${cmpVal} = icmp eq ${subjTy} ${subjVal}, ${pat.value}`);
      } else {
        // float
        cmpVal = this.nextTemp();
        const fval = Number.isInteger(pat.value as number) ? (pat.value as number).toFixed(1) : String(pat.value);
        lines.push(`  ${cmpVal} = fcmp oeq ${subjTy} ${subjVal}, ${fval}`);
      }

      lines.push(`  br i1 ${cmpVal}, label %${literalArms[i].label}, label %${next}`);

      // arm body
      lines.push(`${literalArms[i].label}:`);
      const armTerminated = this.emitMatchArmBody(lines, literalArms[i].arm.body, resultSlot);
      if (!armTerminated) lines.push(`  br label %${endLabel}`);
      if (!armTerminated) allArmsTerminated = false;

      // next comparison block (or wildcard/default)
      if (i + 1 < literalArms.length) {
        lines.push(`${next}:`);
      }
    }

    // wildcard or default
    const lastNext = literalArms.length > 0 ? literalArms[literalArms.length - 1].nextLabel : this.nextLabel("match.wildcard");
    if (wildcardArm) {
      if (literalArms.length === 0) {
        lines.push(`  br label %${lastNext}`);
      }
      lines.push(`${lastNext}:`);
      const wcTerminated = this.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
      if (!wcTerminated) lines.push(`  br label %${endLabel}`);
      if (!wcTerminated) allArmsTerminated = false;
    } else {
      if (literalArms.length === 0) {
        lines.push(`  br label %${lastNext}`);
      }
      lines.push(`${lastNext}:`);
      lines.push(`  unreachable`);
    }

    lines.push(`${endLabel}:`);
    if (allArmsTerminated) lines.push(`  unreachable`);
    return [lines, allArmsTerminated];
  }

  private genEnumMatch(stmt: HIRStmt & { kind: "Match" }, resultSlot?: { addr: string; ty: string }): [string[], boolean] {
    const lines: string[] = [];
    let subjAddr: string;
    let subjTy: string;
    if (stmt.subjectIsRef && stmt.subject.kind === "Ident" && this.locals.get(stmt.subject.name)?.isRef) {
      // `match &Enum`: read the tag/payloads through the borrow's pointer
      // directly — nothing is copied or moved. (genExpr would auto-deref the
      // ref to a value; we want the pointer itself.)
      const p = this.nextTemp();
      lines.push(`  ${p} = load ptr, ptr ${this.localAddr(stmt.subject.name)}`);
      subjAddr = p;
      subjTy = `%${stmt.enumName}`;
    } else if (stmt.subject.kind === "HeapDeref" && stmt.subject.operand.kind === "Ident") {
      const [heapLines, heapVal] = this.genExpr(stmt.subject.operand);
      lines.push(...heapLines);
      subjAddr = heapVal;
      subjTy = this.llvmType(stmt.subject.type);
    } else if (stmt.subject.kind === "Ident" && this.locals.has(stmt.subject.name)) {
      const local = must(this.locals, stmt.subject.name, "locals");
      subjAddr = this.localAddr(stmt.subject.name);
      subjTy = local.type;
    } else if (stmt.subjectIsRef && this.placeRootedAtImmutableRef(stmt.subject)) {
      // Place subject (s.field / v[i]) rooted at an immutable '&' binding:
      // match the slot in place — no clone of the enum (or its heap payloads).
      // Sound only for an immutable root: the checker rejects '&'/'&mut'
      // aliasing in one call and refs are second-class (never stored), so
      // nothing in the arm's call tree can mutate the container while payload
      // borrows are live. A mutable-rooted place keeps the clone-into-temp
      // path below, because the arm body may legally mutate the container
      // (e.g. v.push) and invalidate the matched slot.
      const [pl, pAddr, pTy] = this.genLValue(stmt.subject);
      lines.push(...pl);
      subjAddr = pAddr;
      subjTy = pTy;
    } else {
      // genStoreInto, not genExpr+store: a big-aggregate subject never becomes an
      // SSA value, so genExpr hands back a POINTER for it. Storing that as if it
      // were the aggregate emitted `store %Option_Post %ptr` — invalid IR, caught
      // only by clang. `match replace(x, ...)` on an enum ≥128 bytes hit this.
      subjTy = this.llvmType(stmt.subject.type);
      subjAddr = this.nextTemp();
      lines.push(`  ${subjAddr} = alloca ${subjTy}`);
      this.genStoreInto(lines, subjAddr, subjTy, stmt.subject);
    }

    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const layout = must(this.enumLayouts, stmt.enumName, "enum layouts");
    const endLabel = this.nextLabel("match.end");
    const defaultLabel = this.nextLabel("match.default");

    const armLabels: { tag: number; label: string; arm: typeof stmt.arms[0] }[] = [];
    let wildcardArm: typeof stmt.arms[0] | null = null;
    for (const arm of stmt.arms) {
      if (arm.pattern.kind === "WildcardPattern") {
        wildcardArm = arm;
      } else if (arm.pattern.kind === "EnumPattern") {
        const label = this.nextLabel(`match.${arm.pattern.variant}`);
        armLabels.push({ tag: arm.pattern.tag, label, arm });
      }
    }

    const cases = armLabels.map(a => `i32 ${a.tag}, label %${a.label}`).join(" ");
    const defaultTarget = wildcardArm ? this.nextLabel("match.wildcard") : defaultLabel;
    lines.push(`  switch i32 ${tag}, label %${defaultTarget} [${cases}]`);

    let allArmsTerminated = true;
    for (const { label, arm } of armLabels) {
      lines.push(`${label}:`);
      const armDropStart = this.droppableLocals.length;
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
        const variant = must(layout.variants, arm.pattern.variant, "variants");
        this.extractBindings(lines, subjAddr, subjTy, variant, arm.pattern, !!stmt.subjectIsRef, !!stmt.subjectIsMut);
      }
      const armTerminated = this.emitMatchArmBody(lines, arm.body, resultSlot);
      // Drop the arm's own bindings when it falls through: the alloca is reused
      // on the next visit, so waiting for the function epilogue would drop only
      // the final binding and leak every earlier one (a match inside a loop).
      // emitGuardedDrop clears the alive flag, so the epilogue's drop is a no-op.
      if (!armTerminated) {
        for (let d = armDropStart; d < this.droppableLocals.length; d++) {
          this.emitGuardedDrop(lines, this.droppableLocals[d]);
        }
      }
      if (!armTerminated) lines.push(`  br label %${endLabel}`);
      if (!armTerminated) allArmsTerminated = false;
    }

    if (wildcardArm) {
      lines.push(`${defaultTarget}:`);
      const wcTerminated = this.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
      if (!wcTerminated) lines.push(`  br label %${endLabel}`);
      if (!wcTerminated) allArmsTerminated = false;
    }

    if (!wildcardArm) {
      lines.push(`${defaultLabel}:`);
      lines.push(`  unreachable`);
    }

    lines.push(`${endLabel}:`);
    if (allArmsTerminated) lines.push(`  unreachable`);
    return [lines, allArmsTerminated];
  }

  // True when `e` is a field/index chain whose root is a local bound as an
  // immutable reference (a '&T' param or an immutable ref binding). Such a
  // place can be matched in place: no writer to the referent can exist while
  // the ref is live (see comment at the call site in genEnumMatch).
  private placeRootedAtImmutableRef(e: HIRExpr): boolean {
    if (e.kind !== "FieldAccess" && e.kind !== "IndexAccess") return false;
    let root: HIRExpr = e;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    if (root.kind !== "Ident") return false;
    const local = this.locals.get(root.name);
    return !!local && local.isRef && !local.mutable;
  }

  private extractBindings(
    lines: string[], subjAddr: string, subjTy: string,
    variant: { tag: number; fieldTypes: string[] },
    pattern: HIRPattern & { kind: "EnumPattern" },
    subjectIsRef: boolean,
    subjectIsMut = false,
  ) {
    if (pattern.bindings.length === 0) return;
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 1`);

    const bind = (name: string, ty: string, fieldKind: TypeKind, fieldPtr: string) => {
      // Use scopeCounter (not labelCounter) so a match-binding's `%name.N.addr`
      // shares one disambiguation namespace with `let`/for-loop allocas. Two
      // counters could otherwise mint the same SSA name for same-named locals of
      // different types → "multiple definition of local value" at link time.
      const uid = this.scopeCounter++;
      // Ref-match of a non-Copy payload: bind a BORROW — the local holds a
      // pointer into the still-owned subject. No load, no zeroing, no drop, so
      // there is no double-free with the subject's real owner. Through a `&mut`
      // subject every payload binds this way, as a `&mut` view, so an assignment
      // to the binding stores into the payload (the checker types it `&mut T`).
      if (subjectIsMut || (subjectIsRef && this.needsDropCg(fieldKind))) {
        const addr = `%${name}.${uid}.addr`;
        lines.push(`  ${addr} = alloca ptr`);
        lines.push(`  store ptr ${fieldPtr}, ptr ${addr}`);
        this.locals.set(name, { type: ty, typeKind: { tag: "ref", inner: fieldKind, mutable: subjectIsMut }, mutable: subjectIsMut, isRef: true, addr });
        return;
      }
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
      // Owned match consumes (moves) the payload: zero the source so the
      // subject's drop chain doesn't free what the binding now owns. A ref-match
      // of a Copy payload is just a value copy — nothing to zero.
      if (!subjectIsRef && this.needsDropCg(fieldKind)) {
        lines.push(this.zeroStore(ty, fieldPtr));
        // The binding now owns the payload, so the SUBJECT must stop being dropped.
        // Zeroing the payload is not enough on its own: it makes the subject's glue
        // free a null pointer (a no-op, which is why heap payloads looked fine), but a
        // user `Drop` impl runs regardless and gets a zeroed value. For `Socket { fd:
        // i32 }` in std/http that is `close(0)` — closing stdin — on a socket that was
        // already moved out. Cleared HERE, inside the consuming arm, because an arm
        // that binds nothing leaves the subject intact and must still drop it.
        const subjLocal = this.droppableLocals.find(d => d.addr === subjAddr);
        if (subjLocal) lines.push(`  store i1 0, ptr ${subjLocal.aliveFlag}`);
      }
      const addr = `%${name}.${uid}.addr`;
      lines.push(`  ${addr} = alloca ${ty}`);
      lines.push(this.valStore(ty, val, addr));
      this.locals.set(name, { type: ty, typeKind: fieldKind, mutable: false, isRef: false, addr });
      // An owned match binding owns its payload — it was moved out of the subject
      // (the source is zeroed above), so nothing else will free it. Without drop
      // glue, `match f() { Ok(r) => { return r.id } }` leaked r entirely: one
      // SSL_CTX (~1 MB) per HTTPS request in milojs.
      if (this.needsDropCg(fieldKind)) {
        const aliveFlag = `${addr}.alive`;
        this.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
        this.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
        lines.push(`  store i1 1, ptr ${aliveFlag}`);
        this.droppableLocals.push({ name, typeKind: fieldKind, aliveFlag, addr });
      }
    };

    if (pattern.bindings.length === 1) {
      bind(pattern.bindings[0].name, variant.fieldTypes[0], pattern.bindings[0].type, payloadPtr);
    } else {
      const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
      for (let i = 0; i < pattern.bindings.length; i++) {
        const fieldPtr = this.nextTemp();
        lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
        bind(pattern.bindings[i].name, variant.fieldTypes[i], pattern.bindings[i].type, fieldPtr);
      }
    }
  }

  private genBuiltinCall(expr: HIRExpr & { kind: "Call" }, lines: string[]): Gen {
    if (expr.func === "print" || expr.func === "format") {
      this.needsFree = true;
      const isFormat = expr.func === "format";

      // format(): stringify every part into one snprintf'd buffer. (Note: snprintf's
      // %.*s still truncates a string part at an embedded NUL — format() of binary is
      // a known follow-up; print() below is the NUL-correct path.)
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
          this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
        }
        const fmtStr = this.addString(partFmts.join(""));
        const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
        this.needsMalloc = true;
        this.needsSnprintf = true;
        this.hasStringType = true;
        const lenResult = this.nextTemp();
        lines.push(`  ${lenResult} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmtStr.label}${argsStr})`);
        const len64 = this.nextTemp();
        lines.push(`  ${len64} = sext i32 ${lenResult} to i64`);
        const bufSize = this.nextTemp();
        lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
        const buf = this.nextTemp();
        lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);
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
          this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
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
      const partFmts: string[] = [];
      const partArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = [];
      const eprintTemps: { val: string; ty: string; expr: HIRExpr }[] = [];
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        eprintTemps.push({ val: av, ty: at, expr: arg.expr });
        this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
      }
      const fullFmt = partFmts.join("") + "\n";
      const fmtStr = this.addString(fullFmt);
      const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
      this.emitFdPrintf(lines, 2, fmtStr.label, argsStr);
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
      const cap = this.nextTemp();
      lines.push(`  ${cap} = add i64 ${lv}, 1`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${cap})`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${pv}, i64 ${lv})`);
      const nulPtr = this.nextTemp();
      lines.push(`  ${nulPtr} = getelementptr i8, ptr ${buf}, i64 ${lv}`);
      lines.push(`  store i8 0, ptr ${nulPtr}`);
      const b1 = this.nextTemp();
      lines.push(`  ${b1} = insertvalue %String zeroinitializer, ptr ${buf}, 0`);
      const b2 = this.nextTemp();
      lines.push(`  ${b2} = insertvalue %String ${b1}, i64 ${lv}, 1`);
      const b3 = this.nextTemp();
      lines.push(`  ${b3} = insertvalue %String ${b2}, i64 ${cap}, 2`);
      return [lines, b3, "%String"];
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
      const cap = this.nextTemp();
      lines.push(`  ${cap} = add i64 ${len}, 1`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${cap})`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${pv}, i64 ${len})`);
      const nulPtr = this.nextTemp();
      lines.push(`  ${nulPtr} = getelementptr i8, ptr ${buf}, i64 ${len}`);
      lines.push(`  store i8 0, ptr ${nulPtr}`);
      const s1 = this.nextTemp();
      lines.push(`  ${s1} = insertvalue %String zeroinitializer, ptr ${buf}, 0`);
      const s2 = this.nextTemp();
      lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${len}, 1`);
      const s3 = this.nextTemp();
      lines.push(`  ${s3} = insertvalue %String ${s2}, i64 ${cap}, 2`);
      return [lines, s3, "%String"];
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
      const cap = this.nextTemp();
      lines.push(`  ${cap} = add i64 ${len}, 1`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${cap})`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${cstr}, i64 ${len})`);
      const nulPtr = this.nextTemp();
      lines.push(`  ${nulPtr} = getelementptr i8, ptr ${buf}, i64 ${len}`);
      lines.push(`  store i8 0, ptr ${nulPtr}`);
      const s1 = this.nextTemp();
      lines.push(`  ${s1} = insertvalue %String zeroinitializer, ptr ${buf}, 0`);
      const s2 = this.nextTemp();
      lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${len}, 1`);
      const s3 = this.nextTemp();
      lines.push(`  ${s3} = insertvalue %String ${s2}, i64 ${cap}, 2`);
      return [lines, s3, "%String"];
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
    const lines: string[] = [];
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
        const ptr = this.nextTemp();
        lines.push(`  ${ptr} = getelementptr [${length} x i8], ptr ${label}, i32 0, i32 0`);
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %String undef, ptr ${ptr}, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${strLen}, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);
        return [lines, s2, "%String"];
      }
      case "StringWithCapacity":
        return this.genStringWithCapacity(expr, lines);
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
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${fieldTy}, ptr ${ptr}`);
        // Moving a non-Copy field out of a struct: zero the source field so the
        // struct's own drop glue skips it (a zeroed %String/Vec has cap=0/null).
        // Otherwise both the moved value and the struct free the same buffer.
        const fieldMoved = expr.isMove && this.needsDropCg(expr.type);
        if (fieldMoved) {
          lines.push(this.zeroStore(fieldTy, ptr));
        }
        // Release a receiver nobody owns, now that its field has been read. Only when
        // the value just loaded cannot alias what the drop frees: either the field is
        // Copy, or it was moved out and its slot zeroed just above. A borrowed owning
        // field would still point into the struct, so leave that case alone.
        if (recvTemps.length > 0 && (fieldMoved || !this.needsDropCg(expr.type))) {
          for (const t of recvTemps) this.emitDropValue(lines, t.addr, t.type);
        }
        this.flushArgTempDrops(lines, fieldTempMark);
        return [lines, val, fieldTy];
      }
      case "ArrayLen":
        return this.genArrayLen(expr, lines);
      case "StringLen": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
        // `n.toString().len` reads a length out of a string nobody owns.
        this.dropOwnedTemp(lines, ov, "%String", expr.object);
        return [lines, len, "i64"];
      }
      case "StringCstr": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const dataPtr = this.nextTemp();
        lines.push(`  ${dataPtr} = extractvalue %String ${ov}, 0`);
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
        const dataPtr = this.nextTemp();
        lines.push(`  ${dataPtr} = extractvalue %Vec ${ov}, 0`);
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
        const tagVal = this.nextTemp();
        lines.push(`  ${tagVal} = extractvalue ${ot} ${ov}, 0`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp eq i32 ${tagVal}, ${expr.tag}`);
        return [lines, cmp, "i1"];
      }
      case "HeapCreate": {
        this.needsMalloc = true;
        const [valLines, valVal, valTy] = this.genExpr(expr.value);
        lines.push(...valLines);
        const size = this.typeSizeOf(expr.value.type);
        const ptr = this.nextTemp();
        lines.push(`  ${ptr} = call ptr @malloc(i64 ${size})`);
        lines.push(`  store ${valTy} ${valVal}, ptr ${ptr}`);
        return [lines, ptr, "ptr"];
      }
      case "HeapDeref":
      case "PtrDeref": {
        const [ptrLines, ptrVal] = this.genExpr(expr.operand);
        lines.push(...ptrLines);
        const innerTy = this.llvmType(expr.type);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${innerTy}, ptr ${ptrVal}`);
        // Zero the heap slot after loading to prevent double-free: the loaded
        // value now owns any inner heap pointers, so the source must not drop them.
        if (expr.kind === "HeapDeref" && this.needsDropCg(expr.type)) {
          lines.push(this.zeroStore(innerTy, ptrVal));
        }
        return [lines, val, innerTy];
      }
      case "VecNew": {
        this.hasVecType = true;
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %Vec undef, ptr null, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 0, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
        return [lines, s2, "%Vec"];
      }
      case "VecWithCapacity":
        return this.genVecWithCapacity(expr, lines);
      case "VecFilled":
        return this.genVecFilled(expr, lines);
      case "VecPush":
        return this.genVecPush(expr, lines);
      case "VecPop":
        return this.genVecPop(expr, lines);
      case "VecLen": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%Vec", expr.object);
        return [lines, len, "i64"];
      }
      case "VecClone": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        // emitDeepCloneFromPtr reads through a pointer, so spill the loaded %Vec
        // into a scratch slot first. The spill is a shallow copy that is never
        // dropped — only the clone it produces is owned by the caller.
        const slot = this.nextTemp();
        lines.push(`  ${slot} = alloca %Vec`);
        lines.push(`  store %Vec ${ov}, ptr ${slot}`);
        const cloned = this.emitDeepCloneFromPtr(lines, slot, { tag: "vec", element: expr.elementType });
        return [lines, cloned, "%Vec"];
      }
      case "VecMap":
        return this.genVecMap(expr, lines);
      case "VecFilter":
        return this.genVecFilter(expr, lines);
      case "VecEach":
        return this.genVecEach(expr, lines);
      case "VecFind":
        return this.genVecFind(expr, lines);
      case "VecAny":
        return this.genVecAny(expr, lines);
      case "VecSum":
        return this.genVecSum(expr, lines);
      case "VecAll":
        return this.genVecAll(expr, lines);
      case "VecFold":
        return this.genVecFold(expr, lines);
      case "VecIsEmpty": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
        const result = this.nextTemp();
        lines.push(`  ${result} = icmp eq i64 ${len}, 0`);
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%Vec", expr.object);
        return [lines, result, "i1"];
      }
      case "VecReverse":
        return this.genVecReverse(expr, lines);
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
        return this.genVecGetOpt(expr, lines);
      case "VecMinMax":
        return this.genVecMinMax(expr, lines);
      case "VecIndexOf":
        return this.genVecIndexOf(expr, lines);
      case "VecPosition":
        return this.genVecPosition(expr, lines);
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
        const cap = this.nextTemp();
        lines.push(`  ${cap} = extractvalue %Vec ${ov}, 2`);
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
        return genVecSortByKey(this, expr.object, expr.callback, expr.elementType, expr.keyType, lines);
      case "HashMapNew":
        return this.genHashMapNew(expr, lines);
      case "HashMapInsert":
        return this.genHashMapInsert(expr, lines);
      case "HashMapGet":
        return this.genHashMapGet(expr, lines);
      case "HashMapGetOrDefault":
        return this.genHashMapGetOrDefault(expr, lines);
      case "HashMapContains":
        return this.genHashMapContains(expr, lines);
      case "HashMapModify":
        return this.genHashMapModify(expr, lines);
      case "HashMapGetOrInsertWith":
        return this.genHashMapGetOrInsertWith(expr, lines);
      case "HashMapRemove":
        return this.genHashMapRemove(expr, lines);
      case "HashMapWithCapacity":
        return this.genHashMapWithCapacity(expr, lines);
      case "HashMapClone":
        return this.genHashMapClone(expr, lines);
      case "HashMapClear":
        return this.genHashMapClear(expr, lines);
      case "HashMapEntries":
        return this.genHashMapEntries(expr, lines);
      case "HashMapLen": {
        this.hasHashMapType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %HashMap ${ov}, 1`);
        // The receiver is a temporary here — `mkVec().len` reads a length out of a Vec
        // nobody owns. StringLen above already did this; its Vec and HashMap siblings did
        // not. Reading a scalar keeps no pointer into the container, so it can go now.
        this.dropOwnedTemp(lines, ov, "%HashMap", expr.object);
        return [lines, len, "i64"];
      }
      case "StringPush":
        return this.genStringPush(expr, lines);
      case "StringPushStr":
        return this.genStringPushStr(expr, lines);
      case "StringSubstr":
        return this.genStringSubstr(expr, lines);
      case "StringSlice":
        return this.genStringSlice(expr, lines);
      case "VecSlice":
        return this.genVecSlice(expr, lines);
      case "RawSlice":
        return this.genRawSlice(expr, lines);
      case "Adopt":
        return this.genAdopt(expr, lines);
      case "StringFind":
        return this.genStringFind(expr, lines);
      case "StringClone":
        return this.genStringClone(expr, lines);
      case "NumberToString":
        return this.genNumberToString(expr, lines);
      case "BoolToString":
        return this.genBoolToString(expr, lines);
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
        return this.genMatchExpr(expr, lines);
      case "InterfaceMethodCall":
        return this.genInterfaceMethodCall(expr, lines);
    }
    // Every arm above returns, so this is unreachable — and that is the point: it is
    // what makes a newly-added HIR kind a compile error here rather than a value that
    // quietly never gets generated.
    const _exhaustive: never = expr;
    throw new Error(`genExpr: unhandled HIR kind '${(_exhaustive as { kind: string }).kind}'`);
  }

  private genStringWithCapacity(expr: HIRExpr & { kind: "StringWithCapacity" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    const [capLines, capVal] = this.genExpr(expr.capacity);
    lines.push(...capLines);
    this.emitNonNegativeCheck(lines, capVal, "capacity", expr.span);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${capVal})`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 0, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${capVal}, 2`);
    return [lines, s2, "%String"];
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
          const trampolineParams = [`ptr %env`, ...sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`)].join(", ");
          const fwdArgs = sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`).join(", ");
          const body: string[] = [];
          body.push(`define ${sig.retType} @${trampolineName}(${trampolineParams}) {`);
          body.push("entry.bb:");
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
          body.push("}");
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
      if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
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
        const [cl, cv, ct] = this.genStringConcat(lines, lv, rv);
        dropOperands(cl);
        return [cl, cv, ct];
      }
      if (expr.op === "==" || expr.op === "!=") {
        const [cl, cv, ct] = this.genStringCmp(lines, lv, rv, expr.op === "==");
        dropOperands(cl);
        return [cl, cv, ct];
      }
      if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
        const [cl, cv, ct] = this.genStringOrd(lines, lv, rv, expr.op);
        dropOperands(cl);
        return [cl, cv, ct];
      }
    }

    // enum equality: compare tag field only (checker rejects payload-bearing enums)
    if ((expr.op === "==" || expr.op === "!=") && llt.startsWith("%") && this.enumLayouts.has(llt.slice(1))) {
      const lTag = this.nextTemp();
      const rTag = this.nextTemp();
      const cmp = this.nextTemp();
      lines.push(`  ${lTag} = extractvalue ${llt} ${lv}, 0`);
      lines.push(`  ${rTag} = extractvalue ${llt} ${rv}, 0`);
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
        const [al, av, at] = this.genExpr(arg.expr);
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
          const dataPtr = this.nextTemp();
          lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
          argVals.push({ val: dataPtr, type: "ptr" });
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
            this.argTempDrops.push({ addr: slot, type: { ...argTk, owning: true } as TypeKind });
          }
        }
      }
    }
    this.emitAliasGuards(lines, refPtrs, expr.span);
    // extern fns passing/returning a struct by value need native-ABI lowering:
    // coerce args into registers, byval/indirect big ones, sret the return.
    if (this.externAbi.has(expr.func)) {
      const r = this.emitExternAbiCall(expr, argVals, lines);
      this.flushArgTempDrops(r[0], tempMark);
      return r;
    }
    const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
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
    for (const f of expr.fields) {
      const idx = layout.fields.findIndex(lf => lf.name === f.name);
      const fieldTy = layout.fields[idx].type;
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${structTy}, ptr ${alloca}, i32 0, i32 ${idx}`);
      this.genStoreInto(lines, ptr, fieldTy, f.value);
    }
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${structTy}, ptr ${alloca}`);
    return [lines, val, structTy];
  }

  private genArrayLen(expr: HIRExpr & { kind: "ArrayLen" }, lines: string[]): Gen {
    const objType = expr.object.type.tag === "ref" ? expr.object.type.inner : expr.object.type;
    if (objType.tag === "array" && objType.size !== null) {
      return [lines, String(objType.size), "i32"];
    }
    if (objType.tag === "array" && objType.size === null) {
      // slice: runtime length from the %Vec view
      const [ol, ov] = this.genExpr(expr.object);
      lines.push(...ol);
      const len = this.nextTemp();
      lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
      return [lines, len, "i64"];
    }
    return [lines, "0", "i32"];
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
      for (let i = 0; i < n; i++) {
        const [el, ev] = this.genExpr(expr.elements[i]);
        lines.push(...el);
        const pi = this.nextTemp();
        lines.push(`  ${pi} = getelementptr ${vecElemTy}, ptr ${buf}, i64 ${i}`);
        lines.push(`  store ${vecElemTy} ${ev}, ptr ${pi}`);
      }
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
    for (let i = 1; i < expr.elements.length; i++) {
      const [el, ev] = this.genExpr(expr.elements[i]);
      lines.push(...el);
      const pi = this.nextTemp();
      lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
      lines.push(`  store ${elemTy} ${ev}, ptr ${pi}`);
    }
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
      // Non-Copy types: deep-clone each element so they own independent heap data
      const srcPtr = this.nextTemp();
      lines.push(`  ${srcPtr} = alloca ${elemTy}`);
      lines.push(`  store ${elemTy} ${vv}, ptr ${srcPtr}`);
      for (let i = 0; i < expr.count; i++) {
        const pi = this.nextTemp();
        lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
        const cloned = this.emitDeepCloneFromPtr(lines, srcPtr, elemKind);
        lines.push(`  store ${elemTy} ${cloned}, ptr ${pi}`);
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
      lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${alloca}, i32 0, i32 0`);
    lines.push(`  store i32 ${variant.tag}, ptr ${tagPtr}`);
    if (expr.args.length > 0) {
      const payloadPtr = this.nextTemp();
      lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${alloca}, i32 0, i32 1`);
      if (expr.args.length === 1) {
        const [argLines, argVal, argTy] = this.genExpr(expr.args[0]);
        lines.push(...argLines);
        lines.push(`  store ${argTy} ${argVal}, ptr ${payloadPtr}`);
      } else {
        const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
        for (let i = 0; i < expr.args.length; i++) {
          const [argLines, argVal, argTy] = this.genExpr(expr.args[i]);
          lines.push(...argLines);
          const fieldPtr = this.nextTemp();
          lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
          lines.push(`  store ${argTy} ${argVal}, ptr ${fieldPtr}`);
        }
      }
    }
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
      this.emitMemcpy(lines, dest, placePtr, placeTy);
      this.genStoreInto(lines, placePtr, placeTy, expr.value);   // store new; does NOT drop old
      if (!sretDest && this.needsDropCg(expr.type)) this.emitDropValue(lines, dest, expr.type);
      return [lines, dest, placeTy];
    }
    const old = this.nextTemp();
    lines.push(`  ${old} = load ${placeTy}, ptr ${placePtr}`);   // move old out
    this.genStoreInto(lines, placePtr, placeTy, expr.value);     // store new; old is not dropped
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
    const sTagPtr = this.nextTemp();
    lines.push(`  ${sTagPtr} = getelementptr ${optTy}, ptr ${res}, i32 0, i32 0`);
    lines.push(`  store i32 ${someTag}, ptr ${sTagPtr}`);
    // Payload IS the matched variant: a fieldless enum's value is its i32 tag, and here
    // the tag equals the matched integer. Written as the payload's leading i32.
    const n32 = this.nextTemp();
    lines.push(`  ${n32} = trunc i64 ${n64} to i32`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${optTy}, ptr ${res}, i32 0, i32 1`);
    lines.push(`  store i32 ${n32}, ptr ${payloadPtr}`);
    lines.push(`  br label %${doneBB}`);
    lines.push(`${noneBB}:`);
    const nTagPtr = this.nextTemp();
    lines.push(`  ${nTagPtr} = getelementptr ${optTy}, ptr ${res}, i32 0, i32 0`);
    lines.push(`  store i32 ${noneTag}, ptr ${nTagPtr}`);
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
        if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
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
      this.emitMemcpy(lines, tmp, aPtr, aTy);
      this.emitMemcpy(lines, aPtr, bPtr, aTy);
      this.emitMemcpy(lines, bPtr, tmp, aTy);
      lines.push(`  br label %${doneLabel}`);
      lines.push(`${doneLabel}:`);
      return [lines, "", "void"];
    }
    // Load both before storing either — the places may alias (swap(v[i], v[j])).
    const ta = this.nextTemp();
    lines.push(`  ${ta} = load ${aTy}, ptr ${aPtr}`);
    const tb = this.nextTemp();
    lines.push(`  ${tb} = load ${aTy}, ptr ${bPtr}`);
    lines.push(this.valStore(aTy, tb, aPtr));
    lines.push(this.valStore(aTy, ta, bPtr));
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
    body.push(`define internal void @${name}(ptr %env) {`);
    body.push("entry.bb:");
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
    body.push("}");
    this.closureBodies.push(body);
    return name;
  }

  private genClosure(expr: HIRExpr & { kind: "Closure" }, lines: string[]): Gen {
    const closureName = `__closure_${this.closureCounter++}`;
    const captures = expr.captures;
    const retTy = this.llvmType(expr.retType);

    const isMove = !!(expr as any).isMove;
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
    const savedLoopHeader = this.loopHeader;
    const savedLoopExit = this.loopExit;
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
    const closureParams = [`ptr %env`, ...expr.params.map(p => `${closureParamTy(p.type)} %${p.name}`)].join(", ");
    closureBody.push(`define ${retTy} @${closureName}(${closureParams}) {`);
    closureBody.push("entry.bb:");

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
        // the capture is a pointer to the original variable's alloca
        this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: true, addr: `${gepPtr}.ref` });
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
          closureBody.push(`  store i1 1, ptr ${aliveFlag}`);
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
      if (retTy === "void") closureBody.push("  ret void");
      else { closureBody.push("  call void @llvm.trap()"); closureBody.push("  unreachable"); } // see genFn's fall-off
    }
    if (this.entryAllocas.length > 0) {
      closureBody.splice(closureAllocaInsertPoint, 0, ...this.entryAllocas);
    }
    this.hoistAllocas(closureBody, closureAllocaInsertPoint);
    closureBody.push("}");
    this.closureBodies.push(closureBody);

    // restore codegen state
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
    this.locals = savedLocals;
    this.captureFlagByAddr = savedCapFlags;
    this.droppableLocals = savedDroppable;
    this.entryAllocas = savedEntryAllocas;
    this.emittedAddrs = savedEmittedAddrs;
    this.loopHeader = savedLoopHeader;
    this.loopExit = savedLoopExit;
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
      const staticEnv = !isMove && this.currentFnName === GLOBAL_INIT_FN;
      if (isMove) {
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
      const dropFnName = isMove ? this.emitClosureEnvDrop(closureName, envStructTy, captures, capFlagSlot) : null;
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
            lines.push(`  store ${capTy} ${val}, ptr ${gepSlot}`);
          } else {
            lines.push(`  ${loaded} = load ${capTy}, ptr ${capAddr}`);
            lines.push(`  store ${capTy} ${loaded}, ptr ${gepSlot}`);
            // zero source so parent's drop glue won't free moved data
            if (this.needsDropCg(cap.type)) {
              lines.push(this.zeroStore(capTy, capAddr));
              const dl = this.droppableLocals.find(d => d.addr === capAddr);
              if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
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
    for (const arg of expr.args) {
      if (arg.passByRef) {
        const [al, aPtr] = this.genLValueForArg(arg.expr);
        lines.push(...al);
        argVals.push({ val: aPtr, type: "ptr" });
      } else {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        argVals.push({ val: av, type: at });
      }
    }
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
      }
    }
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
    return [lines, s1, "{ ptr, ptr }"];
  }

  private genIfExpr(expr: HIRExpr & { kind: "IfExpr" }, lines: string[]): Gen {
    const resultTy = this.llvmType(expr.type);
    const resultAddr = `%__ifexpr.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca ${resultTy}`);

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
        const [vl, vv] = this.genExpr(last.expr);
        lines.push(...vl);
        if (vv !== "void") lines.push(`  store ${resultTy} ${vv}, ptr ${resultAddr}`);
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
        const [vl, vv] = this.genExpr(last.expr);
        lines.push(...vl);
        if (vv !== "void") lines.push(`  store ${resultTy} ${vv}, ptr ${resultAddr}`);
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
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${resultAddr}`);
    return [lines, result, resultTy];
  }

  private genMatchExpr(expr: HIRExpr & { kind: "MatchExpr" }, lines: string[]): Gen {
    const resultTy = this.llvmType(expr.type);
    const resultAddr = `%__matchexpr.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca ${resultTy}`);
    // Reuse the statement match generator, passing a result slot so each
    // arm's tail value is stored instead of discarded.
    const asStmt = {
      kind: "Match" as const,
      subject: expr.subject,
      arms: expr.arms,
      enumName: expr.enumName,
      subjectIsRef: expr.subjectIsRef,
      subjectIsMut: expr.subjectIsMut,
      span: expr.span,
    };
    const [ml, allTerminated] = this.genMatch(asStmt, { addr: resultAddr, ty: resultTy });
    lines.push(...ml);
    // Every arm diverged (return/break) — genMatch already closed endLabel
    // with `unreachable`, so a load here would follow a terminator. The
    // value is never observed; hand back a poison of the right type.
    if (allTerminated) return [lines, `poison`, resultTy];
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${resultAddr}`);
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
      }
    }
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

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
      const errPayloadPtr = this.nextTemp();
      lines.push(`  ${errPayloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
      const errStr = this.nextTemp();
      lines.push(`  ${errStr} = load %String, ptr ${errPayloadPtr}`);
      const errDataPtr = this.nextTemp();
      lines.push(`  ${errDataPtr} = extractvalue %String ${errStr}, 0`);
      const fmt = this.addString(`error at ${this.panicAt(span)}: %s\n`);
      this.emitFdPrintf(lines, 2, fmt.label, `, ptr ${errDataPtr}`);
    } else if (isResult && errPayloadEnum && this.enumLayouts.has(errPayloadEnum)) {
      // Err(SomeEnum) — say *which* error. "unwrap called on Err" alone tells the reader
      // nothing they can act on; `Err(IoError.PermissionDenied)` is the whole diagnosis.
      const errPayloadPtr = this.nextTemp();
      lines.push(`  ${errPayloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
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
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    // `Result<void, E>` has no payload to extract, and LLVM rejects `load void` outright
    // ("void type only allowed for function results"), so a `Promise<void>` failed to
    // compile at the link step rather than anywhere a diagnostic could point at.
    if (resultTy === "void") return [lines, "", "void"];
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    return [lines, result, resultTy];
  }

  private genPropagate(expr: HIRExpr & { kind: "Propagate" }, lines: string[]): Gen {
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

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
      const errPayloadPtr = this.nextTemp();
      lines.push(`  ${errPayloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
      const srcErrVariant = layout.variants.get("Err") || layout.variants.get("None");
      const srcErrFieldTy = srcErrVariant && srcErrVariant.fieldTypes.length > 0 ? srcErrVariant.fieldTypes[0] : null;

      let finalErrPayload: string | null = null;
      let finalErrFieldTy: string | null = null;

      if (expr.boxConversion && srcErrFieldTy) {
        // Box the error and hand back a fat pointer { data, itable }: the same shape
        // genInterfaceCoerce builds for `Heap(e)` coerced to Heap<Iface>, done here
        // because the payload is loaded out of the operand's Err slot, not from an
        // expression. A string error is wrapped in the prelude `Message` first.
        this.needsMalloc = true;
        const box = expr.boxConversion;
        const srcPayload = this.nextTemp();
        lines.push(`  ${srcPayload} = load ${srcErrFieldTy}, ptr ${errPayloadPtr}`);
        let boxedVal = srcPayload;
        let boxedTy = srcErrFieldTy;
        let boxedType: TypeKind = box.errType;
        if (box.viaMessage) {
          boxedType = { tag: "struct", name: box.fromType };
          boxedTy = this.llvmType(boxedType);
          boxedVal = this.nextTemp();
          lines.push(`  ${boxedVal} = insertvalue ${boxedTy} undef, ${srcErrFieldTy} ${srcPayload}, 0`);
        }
        const boxPtr = this.nextTemp();
        lines.push(`  ${boxPtr} = call ptr @malloc(i64 ${this.typeSizeOf(boxedType)})`);
        lines.push(`  store ${boxedTy} ${boxedVal}, ptr ${boxPtr}`);
        const itableInfo = this.itableLayouts.get(`${box.fromType}.${box.ifaceName}`);
        const itableGlobal = itableInfo?.globalName ?? `@itable.${box.fromType}.${box.ifaceName}`;
        const fat0 = this.nextTemp();
        lines.push(`  ${fat0} = insertvalue { ptr, ptr } undef, ptr ${boxPtr}, 0`);
        finalErrPayload = this.nextTemp();
        lines.push(`  ${finalErrPayload} = insertvalue { ptr, ptr } ${fat0}, ptr ${itableGlobal}, 1`);
        finalErrFieldTy = "{ ptr, ptr }";
      } else if (expr.fromConversion && srcErrFieldTy) {
        // From conversion: wrap source err in target error enum variant
        const convEnumTy = `%${expr.fromConversion.targetEnumName}`;
        const srcPayload = this.nextTemp();
        lines.push(`  ${srcPayload} = load ${srcErrFieldTy}, ptr ${errPayloadPtr}`);
        const convAlloca = this.nextTemp();
        lines.push(`  ${convAlloca} = alloca ${convEnumTy}`);
        const convTagPtr = this.nextTemp();
        lines.push(`  ${convTagPtr} = getelementptr ${convEnumTy}, ptr ${convAlloca}, i32 0, i32 0`);
        lines.push(`  store i32 ${expr.fromConversion.wrapTag}, ptr ${convTagPtr}`);
        const convPayloadPtr = this.nextTemp();
        lines.push(`  ${convPayloadPtr} = getelementptr ${convEnumTy}, ptr ${convAlloca}, i32 0, i32 1`);
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
      const retTagPtr = this.nextTemp();
      lines.push(`  ${retTagPtr} = getelementptr ${retEnumTy}, ptr ${retAlloca}, i32 0, i32 0`);
      const retLayout = must(this.enumLayouts, retEnumName, "enum layouts");
      const retErrVariant = retLayout.variants.get("Err") || retLayout.variants.get("None");
      const retErrTag = retErrVariant ? retErrVariant.tag : 1;
      lines.push(`  store i32 ${retErrTag}, ptr ${retTagPtr}`);
      if (finalErrPayload && finalErrFieldTy) {
        const retPayloadPtr = this.nextTemp();
        lines.push(`  ${retPayloadPtr} = getelementptr ${retEnumTy}, ptr ${retAlloca}, i32 0, i32 1`);
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
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    // `Result<void, E>` has no payload to extract, and LLVM rejects `load void` outright
    // ("void type only allowed for function results"), so a `Promise<void>` failed to
    // compile at the link step rather than anywhere a diagnostic could point at.
    if (resultTy === "void") return [lines, "", "void"];
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const someLabel = this.nextLabel("default.some");
    const noneLabel = this.nextLabel("default.none");
    const doneLabel = this.nextLabel("default.done");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${someLabel}, label %${noneLabel}`);

    // some branch — extract payload and zero the source to prevent double-free
    lines.push(`${someLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
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
    const [dl, dv] = this.genExpr(expr.default);
    lines.push(...dl);
    if (this.needsDropCg(expr.type) && expr.default.kind === "Ident") {
      const dstAddr = this.localAddr(expr.default.name);
      if (dstAddr) lines.push(`  store ${resultTy} zeroinitializer, ptr ${dstAddr}`);
    }
    lines.push(`  store ${resultTy} ${dv}, ptr ${resultAddr}`);
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
  private emitStringAppendInPlace(lines: string[], tgtPtr: string, rhsVal: string): void {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    // Load current x = {ptr, len, cap}
    const cur = this.nextTemp();
    lines.push(`  ${cur} = load %String, ptr ${tgtPtr}`);
    const xData = this.nextTemp();
    lines.push(`  ${xData} = extractvalue %String ${cur}, 0`);
    const xLen = this.nextTemp();
    lines.push(`  ${xLen} = extractvalue %String ${cur}, 1`);
    const xCap = this.nextTemp();
    lines.push(`  ${xCap} = extractvalue %String ${cur}, 2`);

    // Extract rhs len + data
    const rData = this.nextTemp();
    lines.push(`  ${rData} = extractvalue %String ${rhsVal}, 0`);
    const rLen = this.nextTemp();
    lines.push(`  ${rLen} = extractvalue %String ${rhsVal}, 1`);

    // Need cap >= xLen + rLen + 1 for the trailing NUL.
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${xLen}, ${rLen}`);
    const needed = this.nextTemp();
    lines.push(`  ${needed} = add i64 ${newLen}, 1`);
    const fits = this.nextTemp();
    lines.push(`  ${fits} = icmp uge i64 ${xCap}, ${needed}`);

    const growLabel = this.nextLabel("strapp.grow");
    const writeLabel = this.nextLabel("strapp.write");
    lines.push(`  br i1 ${fits}, label %${writeLabel}, label %${growLabel}`);

    // ── grow ──
    lines.push(`${growLabel}:`);
    // new_cap = max(needed, cap*2). If cap==0 use needed directly.
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = shl i64 ${xCap}, 1`);
    const doubleBigger = this.nextTemp();
    lines.push(`  ${doubleBigger} = icmp uge i64 ${doubled}, ${needed}`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${doubleBigger}, i64 ${doubled}, i64 ${needed}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newCap})`);
    // copy old contents (xLen bytes — may be 0 on first append from "")
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${xData}, i64 ${xLen})`);
    // free old buffer iff it was heap-owned (cap > 0); literals have cap==0
    const capOwned = this.nextTemp();
    lines.push(`  ${capOwned} = icmp ugt i64 ${xCap}, 0`);
    const freeLabel = this.nextLabel("strapp.free");
    const skipFreeLabel = this.nextLabel("strapp.skipfree");
    lines.push(`  br i1 ${capOwned}, label %${freeLabel}, label %${skipFreeLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${xData})`);
    lines.push(`  br label %${skipFreeLabel}`);
    lines.push(`${skipFreeLabel}:`);
    // store new ptr + cap into x; len updated below in writeLabel
    const grewWithBuf = this.nextTemp();
    lines.push(`  ${grewWithBuf} = insertvalue %String ${cur}, ptr ${newBuf}, 0`);
    const grewWithCap = this.nextTemp();
    lines.push(`  ${grewWithCap} = insertvalue %String ${grewWithBuf}, i64 ${newCap}, 2`);
    lines.push(`  store %String ${grewWithCap}, ptr ${tgtPtr}`);
    lines.push(`  br label %${writeLabel}`);

    // ── write rhs at xLen, then bump len ──
    lines.push(`${writeLabel}:`);
    const cur2 = this.nextTemp();
    lines.push(`  ${cur2} = load %String, ptr ${tgtPtr}`);
    const xData2 = this.nextTemp();
    lines.push(`  ${xData2} = extractvalue %String ${cur2}, 0`);
    const writeDst = this.nextTemp();
    lines.push(`  ${writeDst} = getelementptr i8, ptr ${xData2}, i64 ${xLen}`);
    lines.push(`  call ptr @memcpy(ptr ${writeDst}, ptr ${rData}, i64 ${rLen})`);
    // null terminator at new_len
    const nulDst = this.nextTemp();
    lines.push(`  ${nulDst} = getelementptr i8, ptr ${xData2}, i64 ${newLen}`);
    lines.push(`  store i8 0, ptr ${nulDst}`);
    const withLen = this.nextTemp();
    lines.push(`  ${withLen} = insertvalue %String ${cur2}, i64 ${newLen}, 1`);
    lines.push(`  store %String ${withLen}, ptr ${tgtPtr}`);
  }

  private genStringConcat(lines: string[], lv: string, rv: string): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
    const aData = this.nextTemp();
    lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
    const aLen = this.nextTemp();
    lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
    const bData = this.nextTemp();
    lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
    const bLen = this.nextTemp();
    lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
    const total = this.nextTemp();
    lines.push(`  ${total} = add i64 ${aLen}, ${bLen}`);
    // +1 for null terminator
    const allocSz = this.nextTemp();
    lines.push(`  ${allocSz} = add i64 ${total}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocSz})`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${aData}, i64 ${aLen})`);
    const dst = this.nextTemp();
    lines.push(`  ${dst} = getelementptr i8, ptr ${buf}, i64 ${aLen}`);
    lines.push(`  call ptr @memcpy(ptr ${dst}, ptr ${bData}, i64 ${bLen})`);
    // null terminate
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${total}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${total}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
    return [lines, s2, "%String"];
  }

  public genStringCmp(lines: string[], lv: string, rv: string, isEq: boolean): Gen {
    this.needsMemcmp = true;
    const aLen = this.nextTemp();
    lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
    const bLen = this.nextTemp();
    lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
    const lenEq = this.nextTemp();
    lines.push(`  ${lenEq} = icmp eq i64 ${aLen}, ${bLen}`);
    const cmpDataLabel = this.nextLabel("str.cmpdata");
    const cmpFalseLabel = this.nextLabel("str.short");
    const cmpDoneLabel = this.nextLabel("str.done");
    lines.push(`  br i1 ${lenEq}, label %${cmpDataLabel}, label %${cmpFalseLabel}`);
    lines.push(`${cmpDataLabel}:`);
    const aData = this.nextTemp();
    lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
    const bData = this.nextTemp();
    lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
    const cmpResult = this.nextTemp();
    lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${aLen})`);
    const dataEq = this.nextTemp();
    lines.push(`  ${dataEq} = icmp eq i32 ${cmpResult}, 0`);
    lines.push(`  br label %${cmpDoneLabel}`);
    lines.push(`${cmpFalseLabel}:`);
    lines.push(`  br label %${cmpDoneLabel}`);
    lines.push(`${cmpDoneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [${dataEq}, %${cmpDataLabel}], [false, %${cmpFalseLabel}]`);
    if (!isEq) {
      const negated = this.nextTemp();
      lines.push(`  ${negated} = xor i1 ${result}, 1`);
      return [lines, negated, "i1"];
    }
    return [lines, result, "i1"];
  }

  // lexicographic string ordering via memcmp on common prefix, then length tiebreak
  public genStringOrd(lines: string[], lv: string, rv: string, op: string): Gen {
    this.needsMemcmp = true;
    const aLen = this.nextTemp();
    lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
    const bLen = this.nextTemp();
    lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
    const aData = this.nextTemp();
    lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
    const bData = this.nextTemp();
    lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);

    const aLessThanB = this.nextTemp();
    lines.push(`  ${aLessThanB} = icmp ult i64 ${aLen}, ${bLen}`);
    const minLen = this.nextTemp();
    lines.push(`  ${minLen} = select i1 ${aLessThanB}, i64 ${aLen}, i64 ${bLen}`);
    const cmpResult = this.nextTemp();
    lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${minLen})`);

    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i32 ${cmpResult}, 0`);
    const dataCmpLabel = this.nextLabel("str.orddata");
    const lenCmpLabel = this.nextLabel("str.ordlen");
    const doneLabel = this.nextLabel("str.orddone");
    lines.push(`  br i1 ${isZero}, label %${lenCmpLabel}, label %${dataCmpLabel}`);

    // prefix differs — compare memcmp result against 0
    lines.push(`${dataCmpLabel}:`);
    const dataPred = op === "<" || op === "<=" ? "slt" : "sgt";
    const dataResult = this.nextTemp();
    lines.push(`  ${dataResult} = icmp ${dataPred} i32 ${cmpResult}, 0`);
    lines.push(`  br label %${doneLabel}`);

    // prefix equal — compare lengths
    lines.push(`${lenCmpLabel}:`);
    const lenPred = op === "<" ? "ult" : op === ">" ? "ugt" : op === "<=" ? "ule" : "uge";
    const lenResult = this.nextTemp();
    lines.push(`  ${lenResult} = icmp ${lenPred} i64 ${aLen}, ${bLen}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [${dataResult}, %${dataCmpLabel}], [${lenResult}, %${lenCmpLabel}]`);
    return [lines, result, "i1"];
  }

  private genStringIndex(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsBoundsCheck = true;
    const [ol, ov] = this.genExpr(expr.object);
    lines.push(...ol);
    const [il, iv, idxTy] = this.genExpr(expr.index);
    lines.push(...il);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
    const len32 = this.nextTemp();
    lines.push(`  ${len32} = trunc i64 ${len} to i32`);
    if (idxTy === "i64") {
      const idx32 = this.nextTemp();
      lines.push(`  ${idx32} = trunc i64 ${iv} to i32`);
      this.emitBoundsCheck(lines, idx32, len32, expr.span);
    } else {
      this.emitBoundsCheck(lines, iv, len32, expr.span);
    }
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${ov}, 0`);
    let idx64: string;
    if (idxTy === "i64") {
      idx64 = iv;
    } else {
      idx64 = this.nextTemp();
      lines.push(`  ${idx64} = sext ${idxTy} ${iv} to i64`);
    }
    const bytePtr = this.nextTemp();
    lines.push(`  ${bytePtr} = getelementptr i8, ptr ${data}, i64 ${idx64}`);
    const byte = this.nextTemp();
    lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
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
    if (expr.kind === "FieldAccess") {
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
    if (expr.kind === "HeapDeref" || expr.kind === "PtrDeref") {
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
      this.argTempDrops.push({ addr: tmp, type: expr.type });
    }
    return [lines, tmp];
  }

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
    const initialCap = Math.max(1, Math.min(8, Math.floor(64 / Math.max(1, elemSize))));
    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const newCap = this.nextTemp();
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 ${initialCap}, i64 ${doubled}`);
    const { buf: newBuf } = this.emitAllocBytes(lines, newCap, elemSize, "vecgrow", expr.span);

    // copy old data if any
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("vec.copy");
    const storeLabel = this.nextLabel("vec.store");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${storeLabel}`);

    lines.push(`${copyLabel}:`);
    const copyBytes = this.nextTemp();
    lines.push(`  ${copyBytes} = mul i64 ${len}, ${elemSize}`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${copyBytes})`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
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
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, "void", "void"];
  }

  // pop(): Option<T> — Some(last) when non-empty, None when empty. The popped
  // slot's ownership transfers into the Some payload (len-- makes the slot dead),
  // so the value moves out with no clone. No panic path: `!` handles that.
  private genVecPop(expr: HIRExpr & { kind: "VecPop" }, lines: string[]): Gen {
    this.hasVecType = true;

    const vecType = expr.vec.type;
    if (vecType.tag !== "vec") throw new Error("VecPop on non-vec type");
    const elemTy = this.llvmType(vecType.element);

    const enumTy = `%${expr.optionEnumName}`;
    const enumLayout = this.enumLayouts.get(expr.optionEnumName);
    if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);
    const noneVariant = enumLayout.variants.get("None");
    const someVariant = enumLayout.variants.get("Some");
    if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

    const [vecPtrLines, vecPtr] = this.genLValue(expr.vec);
    lines.push(...vecPtrLines);

    // load len
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    // result Option, defaulted to None
    const resultAddr = `%__pop_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 0`);
    lines.push(`  store i32 ${noneVariant.tag}, ptr ${tagPtr}`);

    const isEmpty = this.nextTemp();
    lines.push(`  ${isEmpty} = icmp eq i64 ${len}, 0`);
    const someLabel = this.nextLabel("vec.pop.some");
    const endLabel = this.nextLabel("vec.pop.end");
    lines.push(`  br i1 ${isEmpty}, label %${endLabel}, label %${someLabel}`);

    // some: len--, move value out of data[new_len] into Some payload
    lines.push(`${someLabel}:`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${len}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${newLen}`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${elemPtr}`);

    lines.push(`  store i32 ${someVariant.tag}, ptr ${tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 1`);
    lines.push(`  store ${elemTy} ${val}, ptr ${payloadPtr}`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
    return [lines, result, enumTy];
  }

  // shared helper: extract closure fn/env and vec data/len for functional methods
  private genVecMethodPreamble(vecExpr: HIRExpr, cbExpr: HIRExpr, elemType: TypeKind, lines: string[]): {
    fnPtr: string; envPtr: string; data: string; len: string; elemTy: string;
  } {
    this.hasVecType = true;
    const [vl, vv] = this.genExpr(vecExpr);
    lines.push(...vl);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
    const [cl, cv] = this.genExpr(cbExpr);
    lines.push(...cl);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
    const envPtr = this.nextTemp();
    lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);
    return { fnPtr, envPtr, data, len, elemTy: this.llvmType(elemType) };
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
  private callbackElemArg(
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

  private genVecMap(expr: HIRExpr & { kind: "VecMap" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const resultElemTy = this.llvmType(expr.resultElementType);
    const resultElemSize = this.typeSizeOf(expr.resultElementType);
    this.needsMalloc = true;

    // allocate result buffer: malloc(len * elemSize)
    const { buf } = this.emitAllocBytes(lines, len, resultElemSize, "vecmap", expr.span);

    const idxAddr = `%__map_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("map.cond");
    const bodyLabel = this.nextLabel("map.body");
    const endLabel = this.nextLabel("map.end");

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
    // check if callback takes element by value or by ref
    const cbType = expr.callback.type;
    const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
    let callArg: string;
    let callArgTy: string;
    if (paramIsRef) {
      callArg = elemPtr;
      callArgTy = "ptr";
    } else {
      const loadedElem = this.nextTemp();
      lines.push(`  ${loadedElem} = load ${elemTy}, ptr ${elemPtr}`);
      callArg = loadedElem;
      callArgTy = elemTy;
    }
    const result = this.nextTemp();
    lines.push(`  ${result} = call ${resultElemTy} ${fnPtr}(ptr ${envPtr}, ${callArgTy} ${callArg})`);
    const destPtr = this.nextTemp();
    lines.push(`  ${destPtr} = getelementptr ${resultElemTy}, ptr ${buf}, i64 ${idx}`);
    lines.push(`  store ${resultElemTy} ${result}, ptr ${destPtr}`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);

    // build result Vec { buf, len, len }
    const v0 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
    const v1 = this.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${len}, 1`);
    const v2 = this.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
    return [lines, v2, "%Vec"];
  }

  private genVecFilter(expr: HIRExpr & { kind: "VecFilter" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const elemSize = this.typeSizeOf(expr.elementType);
    this.needsMalloc = true;

    // allocate result buffer with capacity = source len (worst case all match)
    const { buf } = this.emitAllocBytes(lines, len, elemSize, "vecfilt", expr.span);

    const idxAddr = `%__filter_idx.${this.scopeCounter++}.addr`;
    const outIdxAddr = `%__filter_out.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    this.entryAllocas.push(`  ${outIdxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);
    lines.push(`  store i64 0, ptr ${outIdxAddr}`);

    const condLabel = this.nextLabel("filter.cond");
    const bodyLabel = this.nextLabel("filter.body");
    const copyLabel = this.nextLabel("filter.copy");
    const nextLabel = this.nextLabel("filter.next");
    const endLabel = this.nextLabel("filter.end");

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
    const keep = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  ${keep} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    lines.push(`  br i1 ${keep}, label %${copyLabel}, label %${nextLabel}`);

    lines.push(`${copyLabel}:`);
    const cloned = this.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
    const outIdx = this.nextTemp();
    lines.push(`  ${outIdx} = load i64, ptr ${outIdxAddr}`);
    const destPtr = this.nextTemp();
    lines.push(`  ${destPtr} = getelementptr ${elemTy}, ptr ${buf}, i64 ${outIdx}`);
    lines.push(`  store ${elemTy} ${cloned}, ptr ${destPtr}`);
    const nextOut = this.nextTemp();
    lines.push(`  ${nextOut} = add i64 ${outIdx}, 1`);
    lines.push(`  store i64 ${nextOut}, ptr ${outIdxAddr}`);
    lines.push(`  br label %${nextLabel}`);

    lines.push(`${nextLabel}:`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    const finalLen = this.nextTemp();
    lines.push(`  ${finalLen} = load i64, ptr ${outIdxAddr}`);
    const v0 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
    const v1 = this.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${finalLen}, 1`);
    const v2 = this.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
    return [lines, v2, "%Vec"];
  }

  private genVecEach(expr: HIRExpr & { kind: "VecEach" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);

    const idxAddr = `%__each_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("each.cond");
    const bodyLabel = this.nextLabel("each.body");
    const endLabel = this.nextLabel("each.end");

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
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  call void ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, "void", "void"];
  }

  private genVecFind(expr: HIRExpr & { kind: "VecFind" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const enumTy = `%${expr.optionEnumName}`;
    const enumLayout = this.enumLayouts.get(expr.optionEnumName);
    if (!enumLayout) throw new Error(`enum layout not found for ${expr.optionEnumName}`);

    const noneVariant = enumLayout.variants.get("None");
    const someVariant = enumLayout.variants.get("Some");
    if (!noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

    const resultAddr = `%__find_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 0`);
    lines.push(`  store i32 ${noneVariant.tag}, ptr ${tagPtr}`);

    const idxAddr = `%__find_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("find.cond");
    const bodyLabel = this.nextLabel("find.body");
    const foundLabel = this.nextLabel("find.found");
    const nextLabel = this.nextLabel("find.next");
    const endLabel = this.nextLabel("find.end");

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
    const match = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    lines.push(`  br i1 ${match}, label %${foundLabel}, label %${nextLabel}`);

    lines.push(`${foundLabel}:`);
    const cloned = this.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
    lines.push(`  store i32 ${someVariant.tag}, ptr ${tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 1`);
    lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${nextLabel}:`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
    return [lines, result, enumTy];
  }

  private genVecAny(expr: HIRExpr & { kind: "VecAny" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);

    const resultAddr = `%__any_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca i1`);
    lines.push(`  store i1 false, ptr ${resultAddr}`);

    const idxAddr = `%__any_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("any.cond");
    const bodyLabel = this.nextLabel("any.body");
    const endLabel = this.nextLabel("any.end");

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
    const match = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    const foundLabel = this.nextLabel("any.found");
    const nextLabel = this.nextLabel("any.next");
    lines.push(`  br i1 ${match}, label %${foundLabel}, label %${nextLabel}`);
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
    return [lines, result, "i1"];
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
    return [lines, result, elemTy];
  }

  private genVecAll(expr: HIRExpr & { kind: "VecAll" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);

    const resultAddr = `%__all_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca i1`);
    lines.push(`  store i1 true, ptr ${resultAddr}`);

    const idxAddr = `%__all_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("all.cond");
    const bodyLabel = this.nextLabel("all.body");
    const endLabel = this.nextLabel("all.end");

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
    const match = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy);
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ${cbArg.argTy} ${cbArg.arg})`);
    const failLabel = this.nextLabel("all.fail");
    const nextLabel = this.nextLabel("all.next");
    lines.push(`  br i1 ${match}, label %${nextLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    lines.push(`  store i1 false, ptr ${resultAddr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${nextLabel}:`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
    return [lines, result, "i1"];
  }

  // acc = cb(acc, &elem) over every element. The accumulator lives in an alloca so
  // the loop body can write it without a phi, matching how the other Vec callbacks
  // carry state across iterations.
  private genVecFold(expr: HIRExpr & { kind: "VecFold" }, lines: string[]): Gen {
    const [initLines, initVal, accTy] = this.genExpr(expr.init);
    lines.push(...initLines);
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);

    const accAddr = `%__fold_acc.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${accAddr} = alloca ${accTy}`);
    lines.push(`  store ${accTy} ${initVal}, ptr ${accAddr}`);

    const idxAddr = `%__fold_idx.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${idxAddr}`);

    const condLabel = this.nextLabel("fold.cond");
    const bodyLabel = this.nextLabel("fold.body");
    const endLabel = this.nextLabel("fold.end");

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
    const acc = this.nextTemp();
    lines.push(`  ${acc} = load ${accTy}, ptr ${accAddr}`);
    const next = this.nextTemp();
    const cbArg = this.callbackElemArg(lines, expr.callback.type, elemPtr, elemTy, 1);
    // KNOWN LEAK when accTy owns heap (a String accumulator): the value in `acc` is owned
    // by nobody once this call returns.
    //
    // Caller side: `acc` is a raw `load` out of the alloca above — synthesized here, not an
    // HIRExpr — so isOwnedTempExpr/dropOwnedTemp, which only ever classify real
    // expressions, cannot see it.
    //
    // Callee side: a CLOSURE never registers its by-value owned parameters as droppable
    // locals. A plain `fn` does (see the param loop that pushes to droppableLocals with an
    // alive flag, dropped at scope exit unless moved out) — emit IR for
    // `fn cat(a: string)` and you get `%a.alive` plus a guarded free; the closure param
    // loop stores the parameter and registers a local, and stops there. So a closure
    // relies entirely on its CALLER owning the argument.
    //
    // That works everywhere else, because the caller does own it. It fails here because
    // fold's accumulator is invisible to the caller's own drop machinery, so neither side
    // covers it: `v.fold("s", (a: string, x: &i64): string => a + x.toString())` leaks one
    // accumulator per element.
    //
    // Do not "fix" it by dropping `acc` here, and do not make closures drop their params
    // without checking who else already does. A closure called with a temporary has that
    // temporary dropped by the CALLER today, so a callee-side drop would double free —
    // which is backlog #18's missing contract again.
    lines.push(`  ${next} = call ${accTy} ${fnPtr}(ptr ${envPtr}, ${accTy} ${acc}, ${cbArg.argTy} ${cbArg.arg})`);
    lines.push(`  store ${accTy} ${next}, ptr ${accAddr}`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${accTy}, ptr ${accAddr}`);
    return [lines, result, accTy];
  }

  private genVecReverse(expr: HIRExpr & { kind: "VecReverse" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.needsMemcpy = true;
    const elemType = expr.elementType;
    const elemSize = this.typeSizeOf(elemType);
    const elemTy = this.llvmType(elemType);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    const tmpAddr = `%__rev_tmp.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${tmpAddr} = alloca ${elemTy}`);

    const loAddr = `%__rev_lo.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${loAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${loAddr}`);
    const hiAddr = `%__rev_hi.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${hiAddr} = alloca i64`);
    const hiInit = this.nextTemp();
    lines.push(`  ${hiInit} = sub i64 ${len}, 1`);
    lines.push(`  store i64 ${hiInit}, ptr ${hiAddr}`);

    const condLabel = this.nextLabel("rev.cond");
    const bodyLabel = this.nextLabel("rev.body");
    const endLabel = this.nextLabel("rev.end");

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const lo = this.nextTemp();
    lines.push(`  ${lo} = load i64, ptr ${loAddr}`);
    const hi = this.nextTemp();
    lines.push(`  ${hi} = load i64, ptr ${hiAddr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp slt i64 ${lo}, ${hi}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);

    lines.push(`${bodyLabel}:`);
    const loPtr = this.nextTemp();
    lines.push(`  ${loPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${lo}`);
    const hiPtr = this.nextTemp();
    lines.push(`  ${hiPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${hi}`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${tmpAddr}, ptr ${loPtr}, i64 ${elemSize}, i1 false)`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${loPtr}, ptr ${hiPtr}, i64 ${elemSize}, i1 false)`);
    lines.push(`  call void @llvm.memcpy.p0.p0.i64(ptr ${hiPtr}, ptr ${tmpAddr}, i64 ${elemSize}, i1 false)`);
    const nextLo = this.nextTemp();
    lines.push(`  ${nextLo} = add i64 ${lo}, 1`);
    lines.push(`  store i64 ${nextLo}, ptr ${loAddr}`);
    const nextHi = this.nextTemp();
    lines.push(`  ${nextHi} = sub i64 ${hi}, 1`);
    lines.push(`  store i64 ${nextHi}, ptr ${hiAddr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    return [lines, "void", "void"];
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

    const [aLines, aVal] = this.genExpr(expr.indexA);
    lines.push(...aLines);
    const [bLines, bVal] = this.genExpr(expr.indexB);
    lines.push(...bLines);

    // Both indices are bounds-checked. This GEP'd straight into the buffer and memcpy'd
    // three times with no length load at all, so `v.swap(0, 999999)` was an out-of-bounds
    // read AND write from safe code that exited 0. Every other indexed Vec operation
    // checks; this one was simply missed.
    const lenPtrB = this.nextTemp();
    lines.push(`  ${lenPtrB} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const lenB = this.nextTemp();
    lines.push(`  ${lenB} = load i64, ptr ${lenPtrB}`);
    const len32B = this.nextTemp();
    lines.push(`  ${len32B} = trunc i64 ${lenB} to i32`);
    for (const idx of [aVal, bVal]) {
      const i32 = this.nextTemp();
      lines.push(`  ${i32} = trunc i64 ${idx} to i32`);
      this.emitBoundsCheck(lines, i32, len32B, expr.span);
    }

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
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 8, i64 ${doubled}`);
    const { buf: newBuf } = this.emitAllocBytes(lines, newCap, elemSize, "vecgrow2", expr.span);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("vec.insert.copy");
    const storeLabel = this.nextLabel("vec.insert.store");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${storeLabel}`);
    lines.push(`${copyLabel}:`);
    const copyBytes = this.nextTemp();
    lines.push(`  ${copyBytes} = mul i64 ${len}, ${elemSize}`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${copyBytes})`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
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
      const [, cmpResult] = this.genStringCmp(lines, elemVal, valVal, true);
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

  // Set up an `alloca Option<…>` pre-filled with None; callers branch to a "some"
  // block that overwrites the tag and payload. Shared by get/min/max/indexOf/position.
  private optionResultSlot(optionEnumName: string, label: string, lines: string[]): {
    enumTy: string; addr: string; tagPtr: string; someTag: number;
  } {
    const enumTy = `%${optionEnumName}`;
    const layout = this.enumLayouts.get(optionEnumName);
    if (!layout) throw new Error(`enum layout not found for ${optionEnumName}`);
    const none = layout.variants.get("None");
    const some = layout.variants.get("Some");
    if (!none || !some) throw new Error("Option enum missing Some/None variants");
    const addr = `%__${label}.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${addr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} zeroinitializer, ptr ${addr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 0`);
    lines.push(`  store i32 ${none.tag}, ptr ${tagPtr}`);
    return { enumTy, addr, tagPtr, someTag: some.tag };
  }

  // v.get(i) / v.first() / v.last(): the total read. A negative index becomes a huge
  // unsigned value, so the single `ult` test rejects both ends without a second compare.
  private genVecGetOpt(expr: HIRExpr & { kind: "VecGetOpt" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);
    const [vl, vv] = this.genExpr(expr.object);
    lines.push(...vl);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
    const [il, iv] = this.genExpr(expr.index);
    lines.push(...il);

    const slot = this.optionResultSlot(expr.optionEnumName, "vecget", lines);
    const inBounds = this.nextTemp();
    lines.push(`  ${inBounds} = icmp ult i64 ${iv}, ${len}`);
    const someLabel = this.nextLabel("vecget.some");
    const endLabel = this.nextLabel("vecget.end");
    lines.push(`  br i1 ${inBounds}, label %${someLabel}, label %${endLabel}`);
    lines.push(`${someLabel}:`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${iv}`);
    const cloned = this.emitDeepCloneFromPtr(lines, elemPtr, expr.elementType);
    lines.push(`  store i32 ${slot.someTag}, ptr ${slot.tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${slot.enumTy}, ptr ${slot.addr}, i32 0, i32 1`);
    lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
    return [lines, result, slot.enumTy];
  }

  // `a <op> b` for the comparable element types min/max/sort accept.
  private emitElemOrd(lines: string[], elemType: TypeKind, a: string, b: string, wantGreater: boolean): string {
    const lt = this.llvmType(elemType);
    if (elemType.tag === "string") {
      const [, r] = this.genStringOrd(lines, a, b, wantGreater ? ">" : "<");
      return r;
    }
    const out = this.nextTemp();
    if (elemType.tag === "float") {
      lines.push(`  ${out} = fcmp ${wantGreater ? "ogt" : "olt"} ${lt} ${a}, ${b}`);
      return out;
    }
    // bool is i1: unsigned ordering makes false < true
    const signed = elemType.tag === "int" && elemType.signed;
    const pred = wantGreater ? (signed ? "sgt" : "ugt") : (signed ? "slt" : "ult");
    lines.push(`  ${out} = icmp ${pred} ${lt} ${a}, ${b}`);
    return out;
  }

  private genVecMinMax(expr: HIRExpr & { kind: "VecMinMax" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);
    const [vl, vv] = this.genExpr(expr.object);
    lines.push(...vl);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);

    const slot = this.optionResultSlot(expr.optionEnumName, "vecminmax", lines);
    const empty = this.nextTemp();
    lines.push(`  ${empty} = icmp eq i64 ${len}, 0`);
    const scanLabel = this.nextLabel("vecmm.scan");
    const endLabel = this.nextLabel("vecmm.end");
    lines.push(`  br i1 ${empty}, label %${endLabel}, label %${scanLabel}`);
    lines.push(`${scanLabel}:`);

    // Track the winning index, not the value: a String winner is cloned once, at
    // the end, instead of on every improvement.
    const bestAddr = this.nextTemp();
    lines.push(`  ${bestAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${bestAddr}`);
    const iAddr = this.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 1, ptr ${iAddr}`);
    const cond = this.nextLabel("vecmm.cond");
    const body = this.nextLabel("vecmm.body");
    const better = this.nextLabel("vecmm.better");
    const step = this.nextLabel("vecmm.step");
    const done = this.nextLabel("vecmm.done");
    lines.push(`  br label %${cond}`);
    lines.push(`${cond}:`);
    const i = this.nextTemp();
    lines.push(`  ${i} = load i64, ptr ${iAddr}`);
    const more = this.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${i}, ${len}`);
    lines.push(`  br i1 ${more}, label %${body}, label %${done}`);
    lines.push(`${body}:`);
    const curPtr = this.nextTemp();
    lines.push(`  ${curPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${i}`);
    const cur = this.nextTemp();
    lines.push(`  ${cur} = load ${elemTy}, ptr ${curPtr}`);
    const bestIdx = this.nextTemp();
    lines.push(`  ${bestIdx} = load i64, ptr ${bestAddr}`);
    const bestPtr = this.nextTemp();
    lines.push(`  ${bestPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${bestIdx}`);
    const best = this.nextTemp();
    lines.push(`  ${best} = load ${elemTy}, ptr ${bestPtr}`);
    const wins = this.emitElemOrd(lines, expr.elementType, cur, best, expr.isMax);
    const winsLabel = this.nextLabel("vecmm.cmpdone");
    lines.push(`  br label %${winsLabel}`);
    lines.push(`${winsLabel}:`);
    lines.push(`  br i1 ${wins}, label %${better}, label %${step}`);
    lines.push(`${better}:`);
    const iNow = this.nextTemp();
    lines.push(`  ${iNow} = load i64, ptr ${iAddr}`);
    lines.push(`  store i64 ${iNow}, ptr ${bestAddr}`);
    lines.push(`  br label %${step}`);
    lines.push(`${step}:`);
    const iCur = this.nextTemp();
    lines.push(`  ${iCur} = load i64, ptr ${iAddr}`);
    const iNext = this.nextTemp();
    lines.push(`  ${iNext} = add i64 ${iCur}, 1`);
    lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${done}:`);
    const winIdx = this.nextTemp();
    lines.push(`  ${winIdx} = load i64, ptr ${bestAddr}`);
    const winPtr = this.nextTemp();
    lines.push(`  ${winPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${winIdx}`);
    const cloned = this.emitDeepCloneFromPtr(lines, winPtr, expr.elementType);
    lines.push(`  store i32 ${slot.someTag}, ptr ${slot.tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${slot.enumTy}, ptr ${slot.addr}, i32 0, i32 1`);
    lines.push(`  store ${elemTy} ${cloned}, ptr ${payloadPtr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
    return [lines, result, slot.enumTy];
  }

  private genVecIndexOf(expr: HIRExpr & { kind: "VecIndexOf" }, lines: string[]): Gen {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);
    const [vl, vv] = this.genExpr(expr.vec);
    lines.push(...vl);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %Vec ${vv}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %Vec ${vv}, 1`);
    const [nl, nv] = this.genExpr(expr.value);
    lines.push(...nl);

    const slot = this.optionResultSlot(expr.optionEnumName, "vecidx", lines);
    const iAddr = this.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${iAddr}`);
    const cond = this.nextLabel("vecidx.cond");
    const body = this.nextLabel("vecidx.body");
    const found = this.nextLabel("vecidx.found");
    const step = this.nextLabel("vecidx.step");
    const end = this.nextLabel("vecidx.end");
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
    const elemVal = this.nextTemp();
    lines.push(`  ${elemVal} = load ${elemTy}, ptr ${elemPtr}`);
    let eq: string;
    if (expr.elementType.tag === "string") {
      const [, r] = this.genStringCmp(lines, elemVal, nv, true);
      eq = r;
    } else {
      eq = this.nextTemp();
      lines.push(`  ${eq} = ${expr.elementType.tag === "float" ? "fcmp oeq" : "icmp eq"} ${elemTy} ${elemVal}, ${nv}`);
    }
    // the string compare above may have opened blocks; land in a fresh one so the
    // index load below is reachable from a single predecessor
    const testLabel = this.nextLabel("vecidx.test");
    lines.push(`  br label %${testLabel}`);
    lines.push(`${testLabel}:`);
    lines.push(`  br i1 ${eq}, label %${found}, label %${step}`);
    lines.push(`${found}:`);
    const hitIdx = this.nextTemp();
    lines.push(`  ${hitIdx} = load i64, ptr ${iAddr}`);
    lines.push(`  store i32 ${slot.someTag}, ptr ${slot.tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${slot.enumTy}, ptr ${slot.addr}, i32 0, i32 1`);
    lines.push(`  store i64 ${hitIdx}, ptr ${payloadPtr}`);
    lines.push(`  br label %${end}`);
    lines.push(`${step}:`);
    const iCur = this.nextTemp();
    lines.push(`  ${iCur} = load i64, ptr ${iAddr}`);
    const iNext = this.nextTemp();
    lines.push(`  ${iNext} = add i64 ${iCur}, 1`);
    lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${end}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
    // Same as the map lookups: the needle is the caller's, and a read-only search takes
    // no ownership of it. `v.contains("s" + i.toString())` leaked the needle per call.
    this.dropOwnedTemp(lines, nv, elemTy, expr.value);
    // …and the receiver, when that is a temporary: `mkVec().contains(x)` leaked the whole
    // container. A search keeps no pointer into it once the answer is a scalar.
    this.dropOwnedTemp(lines, vv, "%Vec", expr.vec);
    return [lines, result, slot.enumTy];
  }

  private genVecPosition(expr: HIRExpr & { kind: "VecPosition" }, lines: string[]): Gen {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const slot = this.optionResultSlot(expr.optionEnumName, "vecpos", lines);
    const iAddr = this.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${iAddr}`);
    const cond = this.nextLabel("vecpos.cond");
    const body = this.nextLabel("vecpos.body");
    const found = this.nextLabel("vecpos.found");
    const step = this.nextLabel("vecpos.step");
    const end = this.nextLabel("vecpos.end");
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
    lines.push(`  br i1 ${hit}, label %${found}, label %${step}`);
    lines.push(`${found}:`);
    lines.push(`  store i32 ${slot.someTag}, ptr ${slot.tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${slot.enumTy}, ptr ${slot.addr}, i32 0, i32 1`);
    lines.push(`  store i64 ${i}, ptr ${payloadPtr}`);
    lines.push(`  br label %${end}`);
    lines.push(`${step}:`);
    const iNext = this.nextTemp();
    lines.push(`  ${iNext} = add i64 ${i}, 1`);
    lines.push(`  store i64 ${iNext}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${end}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${slot.enumTy}, ptr ${slot.addr}`);
    return [lines, result, slot.enumTy];
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
  private emitAllocBytes(lines: string[], count: string, elemSize: string | number, tag: string, span?: Span): { buf: string; bytes: string } {
    this.needsMalloc = true;
    const bothConst = /^\d+$/.test(String(count)) && /^\d+$/.test(String(elemSize));
    let bytes: string;
    if (bothConst) {
      // A product of two literals is folded here; it cannot overflow at runtime.
      bytes = String(BigInt(String(count)) * BigInt(String(elemSize)));
    } else if (String(elemSize) === "1") {
      bytes = String(count);
    } else {
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
      bytes = prod;
    }
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bytes})`);
    // A failed malloc returned null and the memcpy that follows every one of these sites
    // wrote through it. Abort at the allocation instead of faulting with no explanation.
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
    return { buf, bytes };
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
    const { buf: newBuf } = this.emitAllocBytes(lines, newCap, elemSize, tag, span);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const copyBytes = this.nextTemp();
    lines.push(`  ${copyBytes} = mul i64 ${len}, ${elemSize}`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${copyBytes})`);
    // A zero-cap Vec has a null buffer; free(null) is defined, but the guard keeps
    // the "buffer or null" invariant push relies on visible at the call site.
    const hadBuf = this.nextTemp();
    lines.push(`  ${hadBuf} = icmp ne ptr ${oldBuf}, null`);
    const freeLabel = this.nextLabel(`${tag}.free`);
    const setLabel = this.nextLabel(`${tag}.set`);
    lines.push(`  br i1 ${hadBuf}, label %${freeLabel}, label %${setLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${setLabel}`);
    lines.push(`${setLabel}:`);
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
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);

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
    return [lines, "void", "void"];
  }

  // String.push(u8) — same grow logic as Vec but element size is 1
  private genStringPush(expr: HIRExpr & { kind: "StringPush" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    const [strPtrLines, strPtr] = this.genLValue(expr.str);
    lines.push(...strPtrLines);
    const [byteLines, byteVal] = this.genExpr(expr.byte);
    lines.push(...byteLines);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    // grow when len + 1 >= cap to reserve room for null terminator
    const lenPlus1 = this.nextTemp();
    lines.push(`  ${lenPlus1} = add i64 ${len}, 1`);
    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp uge i64 ${lenPlus1}, ${cap}`);
    const growLabel = this.nextLabel("str.grow");
    const pushLabel = this.nextLabel("str.push");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${pushLabel}`);

    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    const baseCap = this.nextTemp();
    lines.push(`  ${baseCap} = select i1 ${isZero}, i64 16, i64 ${doubled}`);
    // Doubling alone is not enough, and neither is the 16-byte floor: a string
    // whose buffer is a static literal carries cap 0, so the floor was taken for
    // a buffer of ANY length and the memcpy below then wrote `len` bytes into 16.
    // `var s = "<15 or more bytes>"` followed by s.push(c) was a heap overflow in
    // safe code. Demand room for the bytes we are about to copy, the byte being
    // pushed, and the terminator.
    const wantCap = this.nextTemp();
    lines.push(`  ${wantCap} = add i64 ${len}, 2`);
    const capTooSmall = this.nextTemp();
    lines.push(`  ${capTooSmall} = icmp ult i64 ${baseCap}, ${wantCap}`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${capTooSmall}, i64 ${wantCap}, i64 ${baseCap}`);
    const { buf: newBuf } = this.emitAllocBytes(lines, newCap, 1, "strgrow", undefined);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("str.copy");
    const storeLabel = this.nextLabel("str.store");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${storeLabel}`);

    lines.push(`${copyLabel}:`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${len})`);
    // only free if cap > 0 (cap == 0 means static/unowned buffer)
    const canFree = this.nextTemp();
    lines.push(`  ${canFree} = icmp ugt i64 ${cap}, 0`);
    const freeLabel = this.nextLabel("str.free");
    const skipFreeLabel = this.nextLabel("str.skipfree");
    lines.push(`  br i1 ${canFree}, label %${freeLabel}, label %${skipFreeLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${skipFreeLabel}`);
    lines.push(`${skipFreeLabel}:`);
    lines.push(`  br label %${storeLabel}`);

    lines.push(`${storeLabel}:`);
    const dataPtr2 = this.nextTemp();
    lines.push(`  ${dataPtr2} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr2}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${pushLabel}`);

    lines.push(`${pushLabel}:`);
    const curDataPtr = this.nextTemp();
    lines.push(`  ${curDataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${curDataPtr}`);
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr i8, ptr ${curData}, i64 ${curLen}`);
    lines.push(`  store i8 ${byteVal}, ptr ${elemPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    // null-terminate for FFI safety
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${curData}, i64 ${newLen}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);

    return [lines, "void", "void"];
  }

  // Append a whole string in place. `s = s + t` reallocates and copies the
  // accumulator on every concat (quadratic when building in a loop); this grows
  // amortized like Vec.push and copies only the addition.
  private genStringPushStr(expr: HIRExpr & { kind: "StringPushStr" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    const [strPtrLines, strPtr] = this.genLValue(expr.str);
    lines.push(...strPtrLines);
    const [otherLines, otherVal] = this.genExpr(expr.other);
    lines.push(...otherLines);

    const addPtr = this.nextTemp();
    lines.push(`  ${addPtr} = extractvalue %String ${otherVal}, 0`);
    const addLen = this.nextTemp();
    lines.push(`  ${addLen} = extractvalue %String ${otherVal}, 1`);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${len}, ${addLen}`);
    // +1 keeps room for the null terminator, matching StringPush
    const need = this.nextTemp();
    lines.push(`  ${need} = add i64 ${newLen}, 1`);
    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp ugt i64 ${need}, ${cap}`);
    const growLabel = this.nextLabel("strs.grow");
    const inPlaceLabel = this.nextLabel("strs.inplace");
    const endLabel = this.nextLabel("strs.end");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${inPlaceLabel}`);

    lines.push(`${growLabel}:`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    const doubleFits = this.nextTemp();
    lines.push(`  ${doubleFits} = icmp ugt i64 ${doubled}, ${need}`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${doubleFits}, i64 ${doubled}, i64 ${need}`);
    const { buf: newBuf } = this.emitAllocBytes(lines, newCap, 1, "strrsv", undefined);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("strs.copy");
    const appendLabel = this.nextLabel("strs.append");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${appendLabel}`);
    lines.push(`${copyLabel}:`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${len})`);
    lines.push(`  br label %${appendLabel}`);
    lines.push(`${appendLabel}:`);
    // Append BEFORE freeing the old buffer: `s.pushStr(s)` makes `addPtr` alias
    // it, and freeing first would read released memory.
    const growDst = this.nextTemp();
    lines.push(`  ${growDst} = getelementptr i8, ptr ${newBuf}, i64 ${len}`);
    lines.push(`  call ptr @memcpy(ptr ${growDst}, ptr ${addPtr}, i64 ${addLen})`);
    // cap == 0 marks a static/unowned buffer — never free those
    const canFree = this.nextTemp();
    lines.push(`  ${canFree} = icmp ugt i64 ${cap}, 0`);
    const freeLabel = this.nextLabel("strs.free");
    const storeLabel = this.nextLabel("strs.store");
    lines.push(`  br i1 ${canFree}, label %${freeLabel}, label %${storeLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${storeLabel}`);
    lines.push(`${storeLabel}:`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${inPlaceLabel}:`);
    // Self-append in the in-place path is safe: source [0,len) and destination
    // [len,2*len) cannot overlap.
    const dst = this.nextTemp();
    lines.push(`  ${dst} = getelementptr i8, ptr ${oldBuf}, i64 ${len}`);
    lines.push(`  call ptr @memcpy(ptr ${dst}, ptr ${addPtr}, i64 ${addLen})`);
    lines.push(`  br label %${endLabel}`);

    lines.push(`${endLabel}:`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${dataPtr}`);
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${curData}, i64 ${newLen}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);

    // pushStr copies the bytes in; a temporary source (a call result, or the
    // clone `v[i]` produces) is dead afterwards and nothing else frees it.
    this.dropOwnedTemp(lines, otherVal, "%String", expr.other);
    return [lines, "void", "void"];
  }

  // Validate a substr/slice range before using it: without this, an inverted
  // or out-of-range span becomes a negative length that malloc/memcpy/getelementptr
  // turn into a silent crash (or a bogus view) with no diagnostic.
  private emitStringRangeCheck(
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
  private genBoundI64(bound: HIRExpr, lines: string[]): string {
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

  // String.substr(start, end) — allocate new owned string from s[start..end]
  private genStringSubstr(expr: HIRExpr & { kind: "StringSubstr" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;

    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const startVal = this.genBoundI64(expr.start, lines);
    const endVal = this.genBoundI64(expr.end, lines);

    this.emitStringRangeCheck(lines, startVal, endVal, strVal, "substr", expr.span);

    const subLen = this.nextTemp();
    lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);

    const buf = this.nextTemp();
    const allocLen = this.nextTemp();
    lines.push(`  ${allocLen} = add i64 ${subLen}, 1`);
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocLen})`);

    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = extractvalue %String ${strVal}, 0`);
    const srcOff = this.nextTemp();
    lines.push(`  ${srcOff} = getelementptr i8, ptr ${srcPtr}, i64 ${startVal}`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${srcOff}, i64 ${subLen})`);

    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${subLen}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${subLen}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocLen}, 2`);

    // substr COPIES out of its receiver, so nothing points into it afterwards and a
    // temporary receiver can go: `big(i).substr(0, 100).len` leaked the whole receiver on
    // every call. Same shape as the Vec/HashMap/StringLen receiver drops.
    this.dropOwnedTemp(lines, strVal, "%String", expr.str);
    return [lines, s2, "%String"];
  }

  // String.slice(start, end) — zero-copy view. Non-owning %String with cap=0.
  private genStringSlice(expr: HIRExpr & { kind: "StringSlice" }, lines: string[]): Gen {
    this.hasStringType = true;

    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const startVal = this.genBoundI64(expr.start, lines);
    const endVal = this.genBoundI64(expr.end, lines);

    this.emitStringRangeCheck(lines, startVal, endVal, strVal, "slice", expr.span);

    const subLen = this.nextTemp();
    lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);

    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = extractvalue %String ${strVal}, 0`);
    const slicePtr = this.nextTemp();
    lines.push(`  ${slicePtr} = getelementptr i8, ptr ${srcPtr}, i64 ${startVal}`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${slicePtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${subLen}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);

    return [lines, s2, "%String"];
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
    const [aLines, arrPtr, arrTy] = this.genLValue(expr.vec);
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

  // n.toString() / x.toString() — snprintf into heap buffer, return owned %String
  private genNumberToString(expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): Gen {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.hasStringType = true;

    const [vLines, vVal] = this.genExpr(expr.value);
    lines.push(...vLines);

    const vt = expr.valueType;
    let fmtStr: string;
    let argType: string;
    let argVal = vVal;
    if (vt.tag === "int") {
      // widen narrow ints to i32 / i64 for snprintf
      if (vt.bits < 32) {
        const widened = this.nextTemp();
        lines.push(`  ${widened} = ${vt.signed ? "sext" : "zext"} i${vt.bits} ${vVal} to i32`);
        argVal = widened;
        argType = "i32";
        fmtStr = vt.signed ? "%d" : "%u";
      } else if (vt.bits === 32) {
        argType = "i32";
        fmtStr = vt.signed ? "%d" : "%u";
      } else {
        argType = "i64";
        fmtStr = vt.signed ? "%lld" : "%llu";
      }
    } else {
      // Floats don't go through snprintf directly — they need the round-trip
      // search in @milo.fmt.f64, which already writes an owned buffer we can
      // hand straight to %String.
      const { buf, len } = this.emitFloatToBuf(vVal, vt.tag === "float" ? vt.bits : 64, lines);
      const f0 = this.nextTemp();
      lines.push(`  ${f0} = insertvalue %String undef, ptr ${buf}, 0`);
      const f1 = this.nextTemp();
      lines.push(`  ${f1} = insertvalue %String ${f0}, i64 ${len}, 1`);
      const f2 = this.nextTemp();
      lines.push(`  ${f2} = insertvalue %String ${f1}, i64 ${F64_BUF}, 2`);
      return [lines, f2, "%String"];
    }

    const fmt = this.addString(fmtStr);
    // size = snprintf(null, 0, fmt, val)
    const lenRes = this.nextTemp();
    lines.push(`  ${lenRes} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmt.label}, ${argType} ${argVal})`);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = sext i32 ${lenRes} to i64`);
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);
    lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${bufSize}, ptr ${fmt.label}, ${argType} ${argVal})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
    return [lines, s2, "%String"];
  }

  private genBoolToString(expr: HIRExpr & { kind: "BoolToString" }, lines: string[]): Gen {
    this.hasStringType = true;
    const [vLines, vVal] = this.genExpr(expr.value);
    lines.push(...vLines);
    const trueStr = this.addString("true");
    const falseStr = this.addString("false");
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = select i1 ${vVal}, ptr ${trueStr.label}, ptr ${falseStr.label}`);
    const len = this.nextTemp();
    lines.push(`  ${len} = select i1 ${vVal}, i64 4, i64 5`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${ptr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);
    return [lines, s2, "%String"];
  }

  // s.clone() — deep copy of the underlying byte buffer; result is an owned %String
  private genStringClone(expr: HIRExpr & { kind: "StringClone" }, lines: string[]): Gen {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
    // `v[i].clone()` clones straight from the element rather than from a copy of
    // it. Indexing a collection of non-Copy elements materialises an independent
    // value (see IndexAccess), so going through genExpr here allocated twice and
    // nothing owned the intermediate — one leaked buffer per evaluation, which
    // is unbounded inside a loop.
    const src = expr.str;
    if (src.kind === "IndexAccess") {
      const eff = src.object.type.tag === "ref" ? src.object.type.inner : src.object.type;
      if ((eff.tag === "vec" || (eff.tag === "array" && eff.size === null)) && this.needsDropCg(eff.element)) {
        const [, elemPtr] = this.genVecBoundsCheckedPtr(src, lines);
        const clonedFromPtr = this.emitDeepCloneFromPtr(lines, elemPtr, eff.element);
        return [lines, clonedFromPtr, "%String"];
      }
    }
    const [sLines, sVal] = this.genExpr(expr.str);
    lines.push(...sLines);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${sVal}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${sVal}, 1`);
    const allocSz = this.nextTemp();
    lines.push(`  ${allocSz} = add i64 ${len}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocSz})`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${data}, i64 ${len})`);
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${len}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
    return [lines, s2, "%String"];
  }

  private genStringFind(expr: HIRExpr & { kind: "StringFind" }, lines: string[]): Gen {
    const enumTy = `%${expr.optionEnumName}`;
    const layout = this.enumLayouts.get(expr.optionEnumName);
    const noneVariant = layout?.variants.get("None");
    const someVariant = layout?.variants.get("Some");
    if (!layout || !noneVariant || !someVariant) throw new Error("Option enum missing Some/None variants");

    const [strLines, strValue] = this.genExpr(expr.str);
    const [needleLines, needleValue] = this.genExpr(expr.needle);
    lines.push(...strLines);
    const strPtr = `%__string_find_haystack.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${strPtr} = alloca %String`);
    lines.push(`  store %String ${strValue}, ptr ${strPtr}`);
    lines.push(...needleLines);
    const needlePtr = `%__string_find_needle.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${needlePtr} = alloca %String`);
    lines.push(`  store %String ${needleValue}, ptr ${needlePtr}`);
    let fn = expr.reverse ? "strLastIndexOf" : "strIndexOf";
    let args = `ptr ${strPtr}, ptr ${needlePtr}`;
    if (expr.from) {
      const [fromLines, fromValue, fromTy] = this.genExpr(expr.from);
      lines.push(...fromLines);
      fn = "strIndexOfFrom";
      args += `, ${fromTy} ${fromValue}`;
    }
    const index = this.nextTemp();
    lines.push(`  ${index} = call i64 @${fn}(${args})`);

    const resultAddr = `%__string_find_result.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${resultAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} zeroinitializer, ptr ${resultAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 0`);
    const found = this.nextTemp();
    lines.push(`  ${found} = icmp sge i64 ${index}, 0`);
    const someLabel = this.nextLabel("string.find.some");
    const noneLabel = this.nextLabel("string.find.none");
    const endLabel = this.nextLabel("string.find.end");
    lines.push(`  br i1 ${found}, label %${someLabel}, label %${noneLabel}`);
    lines.push(`${noneLabel}:`);
    lines.push(`  store i32 ${noneVariant.tag}, ptr ${tagPtr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${someLabel}:`);
    lines.push(`  store i32 ${someVariant.tag}, ptr ${tagPtr}`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${resultAddr}, i32 0, i32 1`);
    lines.push(`  store i64 ${index}, ptr ${payloadPtr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${enumTy}, ptr ${resultAddr}`);
    // indexOf/indexOfFrom/lastIndexOf read both operands and answer an INDEX, so nothing
    // points into either by the time we get here and both can go now — no deferral to
    // argTempDrops needed. `s.indexOf("o" + i.toString())` leaked its needle per call, and
    // `("pre" + i.toString()).indexOf("r")` leaked the receiver as well.
    this.dropOwnedTemp(lines, strValue, "%String", expr.str);
    this.dropOwnedTemp(lines, needleValue, "%String", expr.needle);
    return [lines, result, enumTy];
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

    // The check, unless an enclosing loop already proved this index in range —
    // in which case the length load goes too, which is most of the cost.
    if (!this.indexIsProven(expr)) {
      this.needsBoundsCheck = true;
      let len32 = this.hoistedLenFor(expr.object);
      if (len32 === null) {
        const lenPtr = this.nextTemp();
        lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
        const len = this.nextTemp();
        lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
        const t32 = this.nextTemp();
        lines.push(`  ${t32} = trunc i64 ${len} to i32`);
        len32 = t32;
      }
      let idx32: string;
      if (idxTy === "i64") {
        idx32 = this.nextTemp();
        lines.push(`  ${idx32} = trunc i64 ${idxVal} to i32`);
      } else {
        idx32 = idxVal;
      }
      this.emitBoundsCheck(lines, idx32, len32, expr.span);
    }

    // load data pointer and GEP to element
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    let idx64: string;
    if (idxTy === "i64") {
      idx64 = idxVal;
    } else {
      idx64 = this.nextTemp();
      lines.push(`  ${idx64} = sext ${idxTy} ${idxVal} to i64`);
    }
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx64}`);

    return [lines, ptr, elemTy];
  }

  // ── HashMap codegen ──

  private hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string {
    return `{ i8, ${this.llvmType(keyType)}, ${this.llvmType(valueType)} }`;
  }

  private emitFnvHash(lines: string[], keyVal: string, keyType: TypeKind, seedReg: string): string {
    // FNV-1a: hash = offset_basis ^ seed; then fold the key's bytes in.
    const offsetBasis = "14695981039346656037";
    const h0 = this.nextTemp();
    lines.push(`  ${h0} = xor i64 ${offsetBasis}, ${seedReg}`);
    return this.emitHashInto(lines, h0, keyVal, keyType);
  }

  // Fold `val`'s bytes into the running FNV-1a accumulator `acc`, returning the new
  // accumulator. Structs recurse field-by-field over the *same* recursion that derives
  // equality — so `a == b ⟹ hash(a) == hash(b)` holds by construction (the eq–hash
  // coherence law). Hash values are NOT stable across compiler versions or runs (the
  // table seed varies): never persist them or put them on the wire.
  private emitHashInto(lines: string[], acc: string, val: string, type: TypeKind): string {
    const prime = "1099511628211";

    if (type.tag === "bool") {
      const byte = this.nextTemp();
      lines.push(`  ${byte} = zext i1 ${val} to i64`);
      const x = this.nextTemp();
      lines.push(`  ${x} = xor i64 ${acc}, ${byte}`);
      const result = this.nextTemp();
      lines.push(`  ${result} = mul i64 ${x}, ${prime}`);
      return result;
    }

    if (type.tag === "int") {
      let val64: string;
      if (type.bits === 64) {
        val64 = val;
      } else {
        val64 = this.nextTemp();
        if (type.signed) {
          lines.push(`  ${val64} = sext i${type.bits} ${val} to i64`);
        } else {
          lines.push(`  ${val64} = zext i${type.bits} ${val} to i64`);
        }
      }
      // unrolled 8-byte FNV-1a
      let hash = acc;
      for (let i = 0; i < 8; i++) {
        const shifted = this.nextTemp();
        lines.push(`  ${shifted} = lshr i64 ${val64}, ${i * 8}`);
        const byte = this.nextTemp();
        lines.push(`  ${byte} = and i64 ${shifted}, 255`);
        const xored = this.nextTemp();
        lines.push(`  ${xored} = xor i64 ${hash}, ${byte}`);
        hash = this.nextTemp();
        lines.push(`  ${hash} = mul i64 ${xored}, ${prime}`);
      }
      return hash;
    }

    if (type.tag === "string") {
      this.hasStringType = true;
      const strData = this.nextTemp();
      lines.push(`  ${strData} = extractvalue %String ${val}, 0`);
      const strLen = this.nextTemp();
      lines.push(`  ${strLen} = extractvalue %String ${val}, 1`);
      const iAddr = this.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      const hAddr = this.nextTemp();
      lines.push(`  ${hAddr} = alloca i64`);
      lines.push(`  store i64 ${acc}, ptr ${hAddr}`);
      const condLabel = this.nextLabel("fnv.cond");
      const bodyLabel = this.nextLabel("fnv.body");
      const endLabel = this.nextLabel("fnv.end");
      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const iVal = this.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${strLen}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const bytePtr = this.nextTemp();
      lines.push(`  ${bytePtr} = getelementptr i8, ptr ${strData}, i64 ${iVal}`);
      const byte = this.nextTemp();
      lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
      const byte64 = this.nextTemp();
      lines.push(`  ${byte64} = zext i8 ${byte} to i64`);
      const curH = this.nextTemp();
      lines.push(`  ${curH} = load i64, ptr ${hAddr}`);
      const xored = this.nextTemp();
      lines.push(`  ${xored} = xor i64 ${curH}, ${byte64}`);
      const newH = this.nextTemp();
      lines.push(`  ${newH} = mul i64 ${xored}, ${prime}`);
      lines.push(`  store i64 ${newH}, ptr ${hAddr}`);
      const nextI = this.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${condLabel}`);
      lines.push(`${endLabel}:`);
      const result = this.nextTemp();
      lines.push(`  ${result} = load i64, ptr ${hAddr}`);
      return result;
    }

    if (type.tag === "struct") {
      const layout = this.structLayouts.get(type.name);
      if (!layout) throw new Error(`hash: unknown struct layout '${type.name}'`);
      const structTy = this.llvmType(type);
      let hash = acc;
      for (let i = 0; i < layout.fields.length; i++) {
        const fieldVal = this.nextTemp();
        lines.push(`  ${fieldVal} = extractvalue ${structTy} ${val}, ${i}`);
        hash = this.emitHashInto(lines, hash, fieldVal, layout.fields[i].typeKind);
      }
      return hash;
    }

    throw new Error(`unhashable key type: ${type.tag}`);
  }

  private emitKeyCompare(lines: string[], k1: string, k2: string, keyType: TypeKind): string {
    if (keyType.tag === "int" || keyType.tag === "bool") {
      const result = this.nextTemp();
      lines.push(`  ${result} = icmp eq ${this.llvmType(keyType)} ${k1}, ${k2}`);
      return result;
    }
    if (keyType.tag === "string") {
      this.needsMemcmp = true;
      const aLen = this.nextTemp();
      lines.push(`  ${aLen} = extractvalue %String ${k1}, 1`);
      const bLen = this.nextTemp();
      lines.push(`  ${bLen} = extractvalue %String ${k2}, 1`);
      const lenEq = this.nextTemp();
      lines.push(`  ${lenEq} = icmp eq i64 ${aLen}, ${bLen}`);
      const cmpDataLabel = this.nextLabel("keycmp.data");
      const cmpFalseLabel = this.nextLabel("keycmp.ne");
      const cmpDoneLabel = this.nextLabel("keycmp.done");
      lines.push(`  br i1 ${lenEq}, label %${cmpDataLabel}, label %${cmpFalseLabel}`);
      lines.push(`${cmpDataLabel}:`);
      const aData = this.nextTemp();
      lines.push(`  ${aData} = extractvalue %String ${k1}, 0`);
      const bData = this.nextTemp();
      lines.push(`  ${bData} = extractvalue %String ${k2}, 0`);
      const cmpResult = this.nextTemp();
      lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${aLen})`);
      const dataEq = this.nextTemp();
      lines.push(`  ${dataEq} = icmp eq i32 ${cmpResult}, 0`);
      lines.push(`  br label %${cmpDoneLabel}`);
      lines.push(`${cmpFalseLabel}:`);
      lines.push(`  br label %${cmpDoneLabel}`);
      lines.push(`${cmpDoneLabel}:`);
      const result = this.nextTemp();
      lines.push(`  ${result} = phi i1 [${dataEq}, %${cmpDataLabel}], [false, %${cmpFalseLabel}]`);
      return result;
    }
    if (keyType.tag === "struct") {
      // Structural equality — the same field recursion that hashing folds over, so the
      // eq–hash coherence law holds by construction.
      const layout = this.structLayouts.get(keyType.name);
      if (!layout) throw new Error(`compare: unknown struct layout '${keyType.name}'`);
      const structTy = this.llvmType(keyType);
      let acc: string | null = null;
      for (let i = 0; i < layout.fields.length; i++) {
        const f1 = this.nextTemp();
        lines.push(`  ${f1} = extractvalue ${structTy} ${k1}, ${i}`);
        const f2 = this.nextTemp();
        lines.push(`  ${f2} = extractvalue ${structTy} ${k2}, ${i}`);
        const fieldEq = this.emitKeyCompare(lines, f1, f2, layout.fields[i].typeKind);
        if (acc === null) {
          acc = fieldEq;
        } else {
          const a = this.nextTemp();
          lines.push(`  ${a} = and i1 ${acc}, ${fieldEq}`);
          acc = a;
        }
      }
      return acc ?? "true"; // a fieldless struct compares equal vacuously
    }
    throw new Error(`uncomparable key type: ${keyType.tag}`);
  }

  // The address of a map for a keyed operation.
  //
  // genLValue answers the literal "null" for anything that is not a place, so a lookup on
  // a TEMPORARY receiver — `makeMap().contains(k)`, `parseHeaders(s).get(k)` — GEP'd from
  // null, read a capacity out of low memory, and then probed. The probe only stops at an
  // empty slot, so with a garbage capacity it never stopped: a HANG out of ordinary safe
  // code, not a wrong answer. Every keyed op had it, at every revision.
  //
  // A temporary has no address until we give it one. Materialize it into a slot and tell
  // the caller to drop that slot when the lookup is done — it is an owned value nobody
  // else will ever free.
  private mapReceiverPtr(lines: string[], mapExpr: HIRExpr): { ptr: string; tempSlot: string | null } {
    const [ptrLines, ptr] = this.genLValue(mapExpr);
    lines.push(...ptrLines);
    if (ptr !== "null") return { ptr, tempSlot: null };
    const [exprLines, exprVal, exprTy] = this.genExpr(mapExpr);
    lines.push(...exprLines);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = alloca ${exprTy}`);
    lines.push(`  store ${exprTy} ${exprVal}, ptr ${slot}`);
    return { ptr: slot, tempSlot: slot };
  }

  private genHashMapNew(expr: HIRExpr & { kind: "HashMapNew" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    const entryTy = this.hashMapEntryType(expr.keyType, expr.valueType);
    // allocate initial 8 entries, zeroed
    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const { buf: dataPtr, bytes: totalSize } = this.emitAllocBytes(lines, entrySizeI, 8, "hmnew", expr.span);
    // zero the memory
    this.needsMemset = true;
    lines.push(`  call ptr @memset(ptr ${dataPtr}, i32 0, i64 ${totalSize})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %HashMap undef, ptr ${dataPtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %HashMap ${s0}, i64 0, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %HashMap ${s1}, i64 8, 2`);
    // seed = 0 (lazy init on first insert)
    const s3 = this.nextTemp();
    lines.push(`  ${s3} = insertvalue %HashMap ${s2}, i64 0, 3`);
    const s4 = this.nextTemp();
    lines.push(`  ${s4} = insertvalue %HashMap ${s3}, i64 0, ${HM_TOMBS}`);
    return [lines, s4, "%HashMap"];
  }

  private genHashMapInsert(expr: HIRExpr & { kind: "HashMapInsert" }, lines: string[]): Gen {
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapInsert on non-hashmap");
    // get pointer to map
    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, expr.map);

    // eval key and value
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);
    const [valLines, valVal] = this.genExpr(expr.value);
    lines.push(...valLines);
    this.emitHashMapInsertValues(lines, mapPtr, mapType, keyVal, valVal, expr.span);
    // Inserting into a temporary is pointless but legal, and the temporary still leaks
    // without this.
    if (mapTempSlot) this.emitDropValue(lines, mapTempSlot, mapType);
    return [lines, "0", "void"];
  }

  // The insert proper, on an already-evaluated key and value: seed, grow, probe, store.
  // `getOrInsertWith` reaches it with a value its init closure produced after its own
  // probe missed; the key was evaluated once, up front, for both probes.
  private emitHashMapInsertValues(lines: string[], mapPtr: string, mapType: TypeKind & { tag: "hashmap" }, keyVal: string, valVal: string, span?: Span): void {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsGetentropy = true;

    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    // lazy seed init
    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const seedIsZero = this.nextTemp();
    lines.push(`  ${seedIsZero} = icmp eq i64 ${seed}, 0`);
    const initLabel = this.nextLabel("seed.init");
    const haveLabel = this.nextLabel("seed.have");
    const preLabel = this.nextLabel("seed.pre");
    lines.push(`  br label %${preLabel}`);
    lines.push(`${preLabel}:`);
    lines.push(`  br i1 ${seedIsZero}, label %${initLabel}, label %${haveLabel}`);
    lines.push(`${initLabel}:`);
    const seedBuf = this.nextTemp();
    lines.push(`  ${seedBuf} = alloca i64`);
    // 2 = BCRYPT_USE_SYSTEM_PREFERRED_RNG, which is what permits the NULL algorithm
    // handle; the length is a 32-bit ULONG here, not getentropy's size_t.
    if (this.isWindows) lines.push(`  call i32 @BCryptGenRandom(ptr null, ptr ${seedBuf}, i32 8, i32 2)`);
    else lines.push(`  call i32 @getentropy(ptr ${seedBuf}, i64 8)`);
    const newSeed = this.nextTemp();
    lines.push(`  ${newSeed} = load i64, ptr ${seedBuf}`);
    const isStillZero = this.nextTemp();
    lines.push(`  ${isStillZero} = icmp eq i64 ${newSeed}, 0`);
    const finalSeed = this.nextTemp();
    lines.push(`  ${finalSeed} = select i1 ${isStillZero}, i64 14695981039346656037, i64 ${newSeed}`);
    lines.push(`  store i64 ${finalSeed}, ptr ${seedPtr}`);
    lines.push(`  br label %${haveLabel}`);
    lines.push(`${haveLabel}:`);
    const activeSeed = this.nextTemp();
    lines.push(`  ${activeSeed} = phi i64 [${seed}, %${preLabel}], [${finalSeed}, %${initLabel}]`);

    // load cap and len
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_LEN}`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);

    // resize check: (len + tombstones + 1) * 4 >= cap * 3
    //
    // Tombstones are counted, not just live entries. A probe below stops only at an EMPTY
    // slot, so the table must always have one; a load factor computed from `len` alone
    // lets insert/remove churn tombstone every slot while len stays near zero, and then
    // no probe terminates. Rehashing drops tombstones, which is what makes this the fix
    // for both that and the duplicate-key bug.
    const tombsPtr = this.nextTemp();
    lines.push(`  ${tombsPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_TOMBS}`);
    const tombs = this.nextTemp();
    lines.push(`  ${tombs} = load i64, ptr ${tombsPtr}`);
    const lenPlusTombs = this.nextTemp();
    lines.push(`  ${lenPlusTombs} = add i64 ${len}, ${tombs}`);
    const lenPlus1 = this.nextTemp();
    lines.push(`  ${lenPlus1} = add i64 ${lenPlusTombs}, 1`);
    const lhs = this.nextTemp();
    lines.push(`  ${lhs} = mul i64 ${lenPlus1}, 4`);
    const rhs = this.nextTemp();
    lines.push(`  ${rhs} = mul i64 ${cap}, 3`);
    const needResize = this.nextTemp();
    lines.push(`  ${needResize} = icmp uge i64 ${lhs}, ${rhs}`);
    const resizeLabel = this.nextLabel("hm.resize");
    const insertLabel = this.nextLabel("hm.insert");
    lines.push(`  br i1 ${needResize}, label %${resizeLabel}, label %${insertLabel}`);

    // resize block
    lines.push(`${resizeLabel}:`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = shl i64 ${cap}, 1`); // cap * 2
    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const { buf: newData, bytes: newTotalSize } = this.emitAllocBytes(lines, entrySizeI, newCap, "hmresize", span);
    this.needsMemset = true;
    lines.push(`  call ptr @memset(ptr ${newData}, i32 0, i64 ${newTotalSize})`);
    // rehash all occupied entries from old data
    const oldData = this.nextTemp();
    lines.push(`  ${oldData} = load ptr, ptr ${dataFieldPtr}`);
    const rehashCond = this.nextLabel("rehash.cond");
    const rehashBody = this.nextLabel("rehash.body");
    const rehashEnd = this.nextLabel("rehash.end");
    const riAddr = this.nextTemp();
    lines.push(`  ${riAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${riAddr}`);
    lines.push(`  br label %${rehashCond}`);
    lines.push(`${rehashCond}:`);
    const ri = this.nextTemp();
    lines.push(`  ${ri} = load i64, ptr ${riAddr}`);
    const riCmp = this.nextTemp();
    lines.push(`  ${riCmp} = icmp ult i64 ${ri}, ${cap}`);
    lines.push(`  br i1 ${riCmp}, label %${rehashBody}, label %${rehashEnd}`);
    lines.push(`${rehashBody}:`);
    const oldEntryPtr = this.nextTemp();
    lines.push(`  ${oldEntryPtr} = getelementptr ${entryTy}, ptr ${oldData}, i64 ${ri}`);
    const oldState = this.nextTemp();
    lines.push(`  ${oldState} = load i8, ptr ${oldEntryPtr}`);
    const isOccupied = this.nextTemp();
    lines.push(`  ${isOccupied} = icmp eq i8 ${oldState}, 1`);
    const rehashInsert = this.nextLabel("rehash.ins");
    const rehashNext = this.nextLabel("rehash.next");
    lines.push(`  br i1 ${isOccupied}, label %${rehashInsert}, label %${rehashNext}`);
    lines.push(`${rehashInsert}:`);
    // load key from old entry
    const oldKeyPtr = this.nextTemp();
    lines.push(`  ${oldKeyPtr} = getelementptr ${entryTy}, ptr ${oldEntryPtr}, i32 0, i32 1`);
    const oldKey = this.nextTemp();
    lines.push(`  ${oldKey} = load ${keyTy}, ptr ${oldKeyPtr}`);
    // load value from old entry
    const oldValPtr = this.nextTemp();
    lines.push(`  ${oldValPtr} = getelementptr ${entryTy}, ptr ${oldEntryPtr}, i32 0, i32 2`);
    const oldVal = this.nextTemp();
    lines.push(`  ${oldVal} = load ${valTy}, ptr ${oldValPtr}`);
    // hash key with new mask
    const rehashHash = this.emitFnvHash(lines, oldKey, keyType, activeSeed);
    const newMask = this.nextTemp();
    lines.push(`  ${newMask} = sub i64 ${newCap}, 1`);
    // probe in new array
    const rjAddr = this.nextTemp();
    lines.push(`  ${rjAddr} = alloca i64`);
    const rehashSlot0 = this.nextTemp();
    lines.push(`  ${rehashSlot0} = and i64 ${rehashHash}, ${newMask}`);
    lines.push(`  store i64 ${rehashSlot0}, ptr ${rjAddr}`);
    const rehashProbeCond = this.nextLabel("rehash.probe");
    lines.push(`  br label %${rehashProbeCond}`);
    lines.push(`${rehashProbeCond}:`);
    const rj = this.nextTemp();
    lines.push(`  ${rj} = load i64, ptr ${rjAddr}`);
    const newEntryPtr = this.nextTemp();
    lines.push(`  ${newEntryPtr} = getelementptr ${entryTy}, ptr ${newData}, i64 ${rj}`);
    const newState = this.nextTemp();
    lines.push(`  ${newState} = load i8, ptr ${newEntryPtr}`);
    const newEmpty = this.nextTemp();
    lines.push(`  ${newEmpty} = icmp eq i8 ${newState}, 0`);
    const rehashStore = this.nextLabel("rehash.store");
    const rehashProbeNext = this.nextLabel("rehash.pnext");
    lines.push(`  br i1 ${newEmpty}, label %${rehashStore}, label %${rehashProbeNext}`);
    lines.push(`${rehashStore}:`);
    lines.push(`  store i8 1, ptr ${newEntryPtr}`);
    const newKeyPtr = this.nextTemp();
    lines.push(`  ${newKeyPtr} = getelementptr ${entryTy}, ptr ${newEntryPtr}, i32 0, i32 1`);
    lines.push(`  store ${keyTy} ${oldKey}, ptr ${newKeyPtr}`);
    const newValPtr = this.nextTemp();
    lines.push(`  ${newValPtr} = getelementptr ${entryTy}, ptr ${newEntryPtr}, i32 0, i32 2`);
    lines.push(`  store ${valTy} ${oldVal}, ptr ${newValPtr}`);
    lines.push(`  br label %${rehashNext}`);
    lines.push(`${rehashProbeNext}:`);
    const rjNext = this.nextTemp();
    lines.push(`  ${rjNext} = add i64 ${rj}, 1`);
    const rjWrapped = this.nextTemp();
    lines.push(`  ${rjWrapped} = and i64 ${rjNext}, ${newMask}`);
    lines.push(`  store i64 ${rjWrapped}, ptr ${rjAddr}`);
    lines.push(`  br label %${rehashProbeCond}`);
    lines.push(`${rehashNext}:`);
    const riNext = this.nextTemp();
    lines.push(`  ${riNext} = add i64 ${ri}, 1`);
    lines.push(`  store i64 ${riNext}, ptr ${riAddr}`);
    lines.push(`  br label %${rehashCond}`);
    lines.push(`${rehashEnd}:`);
    // free old data, update map fields
    lines.push(`  call void @free(ptr ${oldData})`);
    lines.push(`  store ptr ${newData}, ptr ${dataFieldPtr}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    // The rehash loop above relocates occupied slots only, so the new table has none.
    lines.push(`  store i64 0, ptr ${tombsPtr}`);
    lines.push(`  br label %${insertLabel}`);

    // insert block — probe for slot
    lines.push(`${insertLabel}:`);
    const curCap = this.nextTemp();
    lines.push(`  ${curCap} = load i64, ptr ${capPtr}`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${dataFieldPtr}`);
    const curSeed = this.nextTemp();
    lines.push(`  ${curSeed} = load i64, ptr ${seedPtr}`);
    const hash = this.emitFnvHash(lines, keyVal, keyType, curSeed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${curCap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hm.probe");
    const probeOccupied = this.nextLabel("hm.occupied");
    const probeEmpty = this.nextLabel("hm.empty");
    const probeNext = this.nextLabel("hm.pnext");
    const insertDone = this.nextLabel("hm.done");
    const probeNotOcc = this.nextLabel("hm.notocc");
    const probeTomb = this.nextLabel("hm.tomb");
    const probeTombRecord = this.nextLabel("hm.tombrec");

    // Where to put the entry if the key turns out to be absent: the FIRST tombstone
    // passed on the way, or the empty slot that ends the probe. -1 = none seen yet.
    // Stopping at a tombstone instead of remembering it is what let `insert` write a
    // second copy of a key that already existed further along the chain.
    const firstTombAddr = this.nextTemp();
    lines.push(`  ${firstTombAddr} = alloca i64`);
    lines.push(`  store i64 -1, ptr ${firstTombAddr}`);

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${curData}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    // state == 1 (occupied) -> check key
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNotOcc}`);

    // not occupied: either a tombstone to remember and probe past, or the empty slot
    // that proves the key is absent.
    lines.push(`${probeNotOcc}:`);
    const stateIsTomb = this.nextTemp();
    lines.push(`  ${stateIsTomb} = icmp eq i8 ${state}, 2`);
    lines.push(`  br i1 ${stateIsTomb}, label %${probeTomb}, label %${probeEmpty}`);

    lines.push(`${probeTomb}:`);
    const seenTomb = this.nextTemp();
    lines.push(`  ${seenTomb} = load i64, ptr ${firstTombAddr}`);
    const tombUnset = this.nextTemp();
    lines.push(`  ${tombUnset} = icmp eq i64 ${seenTomb}, -1`);
    lines.push(`  br i1 ${tombUnset}, label %${probeTombRecord}, label %${probeNext}`);

    lines.push(`${probeTombRecord}:`);
    lines.push(`  store i64 ${slot}, ptr ${firstTombAddr}`);
    lines.push(`  br label %${probeNext}`);

    // occupied: compare keys
    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    const overwriteLabel = this.nextLabel("hm.overwrite");
    lines.push(`  br i1 ${keysMatch}, label %${overwriteLabel}, label %${probeNext}`);

    // overwrite existing value
    lines.push(`${overwriteLabel}:`);
    const existingValPtr = this.nextTemp();
    lines.push(`  ${existingValPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    // TODO(insert-return-value): return old value as Option<V>
    if (this.needsDropCg(valueType)) {
      this.emitDropValue(lines, existingValPtr, valueType);
    }
    lines.push(`  store ${valTy} ${valVal}, ptr ${existingValPtr}`);
    // The map keeps the key it already has, so the one just handed in has no owner:
    // the checker moved it out of the caller and this path never stores it. Without
    // this, re-inserting a `String` key leaked its buffer on every duplicate.
    if (this.needsDropCg(keyType)) {
      const dupKeyAddr = this.nextTemp();
      lines.push(`  ${dupKeyAddr} = alloca ${keyTy}`);
      lines.push(`  store ${keyTy} ${keyVal}, ptr ${dupKeyAddr}`);
      this.emitDropValue(lines, dupKeyAddr, keyType);
    }
    lines.push(`  br label %${insertDone}`);

    // Empty slot reached: the key is definitely absent, because the probe walked every
    // slot between its home and here. Reuse the first tombstone passed if there was one,
    // which keeps the chain short; otherwise take this slot.
    lines.push(`${probeEmpty}:`);
    const tombCandidate = this.nextTemp();
    lines.push(`  ${tombCandidate} = load i64, ptr ${firstTombAddr}`);
    const reuseTomb = this.nextTemp();
    lines.push(`  ${reuseTomb} = icmp ne i64 ${tombCandidate}, -1`);
    const writeSlot = this.nextTemp();
    lines.push(`  ${writeSlot} = select i1 ${reuseTomb}, i64 ${tombCandidate}, i64 ${slot}`);
    const writePtr = this.nextTemp();
    lines.push(`  ${writePtr} = getelementptr ${entryTy}, ptr ${curData}, i64 ${writeSlot}`);
    // Reusing a tombstone retires it — otherwise the count only ever grows and the table
    // rehashes on a load it does not actually carry.
    const tombsNow = this.nextTemp();
    lines.push(`  ${tombsNow} = load i64, ptr ${tombsPtr}`);
    const tombsLess = this.nextTemp();
    lines.push(`  ${tombsLess} = sub i64 ${tombsNow}, 1`);
    const tombsAfter = this.nextTemp();
    lines.push(`  ${tombsAfter} = select i1 ${reuseTomb}, i64 ${tombsLess}, i64 ${tombsNow}`);
    lines.push(`  store i64 ${tombsAfter}, ptr ${tombsPtr}`);
    lines.push(`  store i8 1, ptr ${writePtr}`);
    const newKeySlotPtr = this.nextTemp();
    lines.push(`  ${newKeySlotPtr} = getelementptr ${entryTy}, ptr ${writePtr}, i32 0, i32 1`);
    lines.push(`  store ${keyTy} ${keyVal}, ptr ${newKeySlotPtr}`);
    const newValSlotPtr = this.nextTemp();
    lines.push(`  ${newValSlotPtr} = getelementptr ${entryTy}, ptr ${writePtr}, i32 0, i32 2`);
    lines.push(`  store ${valTy} ${valVal}, ptr ${newValSlotPtr}`);
    // increment len
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    lines.push(`  br label %${insertDone}`);

    // probe next slot
    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${insertDone}:`);
  }

  // The open-addressing probe every keyed HashMap op opens with: read the slot, an empty
  // state means the key is absent, a tombstone means keep probing, an occupied state
  // compares the key. contains/remove/get/getOrDefault each carried this verbatim, so a
  // change to the tombstone rule or the state encoding had to land in four places.
  //
  // The labels are allocated by the CALLER and passed in, not minted here: each call site
  // allocates its seven labels in its own order, and taking that over would renumber them
  // and cost the byte-identical-IR check that verifies this refactor changed nothing.
  private emitHashProbePrologue(
    lines: string[],
    at: {
      probeCond: string;
      probeCheck: string;
      probeOccupied: string;
      probeNext: string;
      // Where an empty slot goes (key absent) and where a key match goes. Only these two
      // differ between callers: remove() jumps straight to its done/remove blocks.
      emptyTarget: string;
      matchTarget: string;
    },
    map: {
      slotAddr: string;
      data: string;
      entryTy: string;
      keyTy: string;
      keyVal: string;
      keyType: TypeKind;
    },
  ): { slot: string; entryPtr: string } {
    lines.push(`  br label %${at.probeCond}`);
    lines.push(`${at.probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${map.slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${map.entryTy}, ptr ${map.data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    // state == 0 (empty) -> the key is not in the map
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${at.emptyTarget}, label %${at.probeCheck}`);

    // state == 1 (occupied) -> compare keys; state == 2 (tombstone) -> keep probing
    lines.push(`${at.probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${at.probeOccupied}, label %${at.probeNext}`);

    lines.push(`${at.probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${map.entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${map.keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, map.keyVal, existingKey, map.keyType);
    lines.push(`  br i1 ${keysMatch}, label %${at.matchTarget}, label %${at.probeNext}`);
    return { slot, entryPtr };
  }

  private genHashMapContains(expr: HIRExpr & { kind: "HashMapContains" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapContains on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, expr.map);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmc.probe");
    const probeOccupied = this.nextLabel("hmc.occupied");
    const probeCheck = this.nextLabel("hmc.check");
    const foundLabel = this.nextLabel("hmc.found");
    const notFoundLabel = this.nextLabel("hmc.notfound");
    const probeNext = this.nextLabel("hmc.pnext");
    const doneLabel = this.nextLabel("hmc.done");

    const { slot } = this.emitHashProbePrologue(
      lines,
      { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
      { slotAddr, data, entryTy, keyTy, keyVal, keyType },
    );

    lines.push(`${foundLabel}:`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${notFoundLabel}:`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [true, %${foundLabel}], [false, %${notFoundLabel}]`);
    this.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
    // A materialized receiver is an owned temporary nobody else will free. This runs after
    // the phi above, so the block it opens cannot invalidate the phi's predecessors.
    if (mapTempSlot) this.emitDropValue(lines, mapTempSlot, expr.map.type);
    return [lines, result, "i1"];
  }

  // One keyed probe, shared by modify and getOrInsertWith: evaluates the receiver and
  // key, opens the probe, and returns the labels plus what the found block needs (the
  // entry pointer) and what the not-found block needs (the map pointer and the evaluated
  // key). The caller writes both blocks and the join.
  private beginHashMapProbe(lines: string[], map: HIRExpr, key: HIRExpr, prefix: string): {
    mapPtr: string; mapTempSlot: string | null; keyVal: string; keyTy: string; keyType: TypeKind; entryPtr: string; slot: string; mask: string; slotAddr: string;
    probeCond: string; probeNext: string; foundLabel: string; notFoundLabel: string;
  } {
    this.hasHashMapType = true;
    const mapType = map.type;
    if (mapType.tag !== "hashmap") throw new Error(`${prefix} on non-hashmap`);
    const keyType = mapType.key;
    const keyTy = this.llvmType(keyType);
    const entryTy = this.hashMapEntryType(keyType, mapType.value);

    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, map);
    const [keyLines, keyVal] = this.genExpr(key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel(`${prefix}.probe`);
    const probeOccupied = this.nextLabel(`${prefix}.occupied`);
    const probeCheck = this.nextLabel(`${prefix}.check`);
    const foundLabel = this.nextLabel(`${prefix}.found`);
    const notFoundLabel = this.nextLabel(`${prefix}.notfound`);
    const probeNext = this.nextLabel(`${prefix}.pnext`);
    const { slot, entryPtr } = this.emitHashProbePrologue(
      lines,
      { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
      { slotAddr, data, entryTy, keyTy, keyVal, keyType },
    );
    return { mapPtr, mapTempSlot, keyVal, keyTy, keyType, entryPtr, slot, mask, slotAddr, probeCond, probeNext, foundLabel, notFoundLabel };
  }

  private emitProbeNext(lines: string[], p: { slot: string; mask: string; slotAddr: string; probeCond: string; probeNext: string }): void {
    lines.push(`${p.probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${p.slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${p.mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${p.slotAddr}`);
    lines.push(`  br label %${p.probeCond}`);
  }

  // `m.modify(k, f)`: on a hit, call f with a pointer to the stored value (a `&mut V`
  // view, so the callback writes the entry in place) and yield true; a miss yields false.
  private genHashMapModify(expr: HIRExpr & { kind: "HashMapModify" }, lines: string[]): Gen {
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapModify on non-hashmap");
    const entryTy = this.hashMapEntryType(mapType.key, mapType.value);
    // The callback first: its environment must exist before the probe branches.
    const [cl, cv] = this.genExpr(expr.callback);
    lines.push(...cl);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
    const envPtr = this.nextTemp();
    lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

    const p = this.beginHashMapProbe(lines, expr.map, expr.key, "hmm");
    const doneLabel = this.nextLabel("hmm.done");

    lines.push(`${p.foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${p.entryPtr}, i32 0, i32 2`);
    lines.push(`  call void ${fnPtr}(ptr ${envPtr}, ptr ${valPtr})`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${p.notFoundLabel}:`);
    lines.push(`  br label %${doneLabel}`);
    this.emitProbeNext(lines, p);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [true, %${p.foundLabel}], [false, %${p.notFoundLabel}]`);
    this.dropOwnedTemp(lines, p.keyVal, p.keyTy, expr.key);
    if (p.mapTempSlot) this.emitDropValue(lines, p.mapTempSlot, mapType);
    return [lines, result, "i1"];
  }

  // `m.getOrInsertWith(k, init)`: a miss calls init() and inserts the result under the
  // key that was already evaluated for the probe; a hit does nothing. Yields whether it
  // inserted. On a hit the key, if it was an owned temporary, is dropped as `get` does;
  // on a miss the insert takes ownership of it.
  private genHashMapGetOrInsertWith(expr: HIRExpr & { kind: "HashMapGetOrInsertWith" }, lines: string[]): Gen {
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapGetOrInsertWith on non-hashmap");
    const [cl, cv] = this.genExpr(expr.init);
    lines.push(...cl);
    const fnPtr = this.nextTemp();
    lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${cv}, 0`);
    const envPtr = this.nextTemp();
    lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${cv}, 1`);

    const p = this.beginHashMapProbe(lines, expr.map, expr.key, "hmi");
    const doneLabel = this.nextLabel("hmi.done");
    const valTy = this.llvmType(mapType.value);

    lines.push(`${p.foundLabel}:`);
    this.dropOwnedTemp(lines, p.keyVal, p.keyTy, expr.key);
    // The drop can open blocks; the phi names the one we end in.
    const foundEnd = this.nextLabel("hmi.found.end");
    lines.push(`  br label %${foundEnd}`);
    lines.push(`${foundEnd}:`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${p.notFoundLabel}:`);
    const produced = this.nextTemp();
    lines.push(`  ${produced} = call ${valTy} ${fnPtr}(ptr ${envPtr})`);
    this.emitHashMapInsertValues(lines, p.mapPtr, mapType, p.keyVal, produced, expr.span);
    // The insert opened blocks of its own; the phi below needs the block we end in.
    const insertedEnd = this.nextLabel("hmi.inserted");
    lines.push(`  br label %${insertedEnd}`);
    lines.push(`${insertedEnd}:`);
    lines.push(`  br label %${doneLabel}`);
    this.emitProbeNext(lines, p);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [false, %${foundEnd}], [true, %${insertedEnd}]`);
    if (p.mapTempSlot) this.emitDropValue(lines, p.mapTempSlot, mapType);
    return [lines, result, "i1"];
  }

  private genHashMapRemove(expr: HIRExpr & { kind: "HashMapRemove" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapRemove on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, expr.map);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_LEN}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmr.probe");
    const probeCheck = this.nextLabel("hmr.check");
    const probeOccupied = this.nextLabel("hmr.occupied");
    const removeLabel = this.nextLabel("hmr.remove");
    const probeNext = this.nextLabel("hmr.pnext");
    const doneLabel = this.nextLabel("hmr.done");

    const { slot, entryPtr } = this.emitHashProbePrologue(
      lines,
      { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: doneLabel, matchTarget: removeLabel },
      { slotAddr, data, entryTy, keyTy, keyVal, keyType },
    );

    lines.push(`${removeLabel}:`);
    // set tombstone
    lines.push(`  store i8 2, ptr ${entryPtr}`);
    // drop key and value if needed
    if (this.needsDropCg(keyType)) {
      const kPtr = this.nextTemp();
      lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
      this.emitDropValue(lines, kPtr, keyType);
    }
    if (this.needsDropCg(valueType)) {
      const vPtr = this.nextTemp();
      lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
      this.emitDropValue(lines, vPtr, valueType);
    }
    // decrement len
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    // The slot just became a tombstone. Insert's resize trigger reads this, so a remove
    // that did not count itself would let tombstones accumulate past the load factor.
    const rmTombsPtr = this.nextTemp();
    lines.push(`  ${rmTombsPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_TOMBS}`);
    const rmTombs = this.nextTemp();
    lines.push(`  ${rmTombs} = load i64, ptr ${rmTombsPtr}`);
    const rmTombsNew = this.nextTemp();
    lines.push(`  ${rmTombsNew} = add i64 ${rmTombs}, 1`);
    lines.push(`  store i64 ${rmTombsNew}, ptr ${rmTombsPtr}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    this.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
    // A materialized receiver is an owned temporary nobody else will free. This runs after
    // the phi above, so the block it opens cannot invalidate the phi's predecessors.
    if (mapTempSlot) this.emitDropValue(lines, mapTempSlot, expr.map.type);
    return [lines, "0", "void"];
  }

  // HashMap.withCapacity(n): pre-size the table so inserting n entries never rehashes.
  // Insert grows when (len+1)*4 >= cap*3, so the table must hold cap > 4(n+1)/3; the
  // loop rounds that up to a power of two (the mask-based probe requires one).
  private genHashMapWithCapacity(expr: HIRExpr & { kind: "HashMapWithCapacity" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    this.needsMemset = true;
    const entryTy = this.hashMapEntryType(expr.keyType, expr.valueType);
    const [capLines, nVal] = this.genExpr(expr.capacity);
    lines.push(...capLines);
    this.emitNonNegativeCheck(lines, nVal, "capacity", expr.span);

    const nPlus1 = this.nextTemp();
    lines.push(`  ${nPlus1} = add i64 ${nVal}, 1`);
    const scaled = this.nextTemp();
    lines.push(`  ${scaled} = mul i64 ${nPlus1}, 4`);
    const wantDiv = this.nextTemp();
    lines.push(`  ${wantDiv} = udiv i64 ${scaled}, 3`);
    const want = this.nextTemp();
    lines.push(`  ${want} = add i64 ${wantDiv}, 1`);

    const capSlot = this.nextTemp();
    lines.push(`  ${capSlot} = alloca i64`);
    lines.push(`  store i64 8, ptr ${capSlot}`);
    const roundCond = this.nextLabel("hmwc.cond");
    const roundBody = this.nextLabel("hmwc.body");
    const roundEnd = this.nextLabel("hmwc.end");
    lines.push(`  br label %${roundCond}`);
    lines.push(`${roundCond}:`);
    const curCap = this.nextTemp();
    lines.push(`  ${curCap} = load i64, ptr ${capSlot}`);
    const tooSmall = this.nextTemp();
    lines.push(`  ${tooSmall} = icmp ult i64 ${curCap}, ${want}`);
    lines.push(`  br i1 ${tooSmall}, label %${roundBody}, label %${roundEnd}`);
    lines.push(`${roundBody}:`);
    const dbl = this.nextTemp();
    lines.push(`  ${dbl} = shl i64 ${curCap}, 1`);
    lines.push(`  store i64 ${dbl}, ptr ${capSlot}`);
    lines.push(`  br label %${roundCond}`);
    lines.push(`${roundEnd}:`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capSlot}`);

    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const { buf: dataPtr, bytes: totalSize } = this.emitAllocBytes(lines, entrySizeI, cap, "hmwith", expr.span);
    lines.push(`  call ptr @memset(ptr ${dataPtr}, i32 0, i64 ${totalSize})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %HashMap undef, ptr ${dataPtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %HashMap ${s0}, i64 0, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %HashMap ${s1}, i64 ${cap}, 2`);
    const s3 = this.nextTemp();
    lines.push(`  ${s3} = insertvalue %HashMap ${s2}, i64 0, 3`);
    const s4 = this.nextTemp();
    lines.push(`  ${s4} = insertvalue %HashMap ${s3}, i64 0, ${HM_TOMBS}`);
    return [lines, s4, "%HashMap"];
  }

  private genHashMapClone(expr: HIRExpr & { kind: "HashMapClone" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    const [ol, ov] = this.genExpr(expr.object);
    lines.push(...ol);
    // emitDeepCloneFromPtr reads through a pointer; the spill is a shallow copy
    // that is never dropped — only the clone it produces is owned by the caller.
    const slot = this.nextTemp();
    lines.push(`  ${slot} = alloca %HashMap`);
    lines.push(`  store %HashMap ${ov}, ptr ${slot}`);
    const cloned = this.emitDeepCloneFromPtr(lines, slot, expr.object.type);
    return [lines, cloned, "%HashMap"];
  }

  // Drop every live key/value, then zero the states. Capacity and the hash seed
  // survive — clear() is "empty this map", not "give the memory back", so a
  // rebuild after clear() reuses the table it already paid for (Vec.clear too).
  private genHashMapClear(expr: HIRExpr & { kind: "HashMapClear" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    this.needsMemset = true;
    const mapType = expr.object.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapClear on non-hashmap");
    const entryTy = this.hashMapEntryType(mapType.key, mapType.value);
    const [mapPtrLines, mapPtr] = this.genLValue(expr.object);
    lines.push(...mapPtrLines);

    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const isNull = this.nextTemp();
    lines.push(`  ${isNull} = icmp eq ptr ${data}, null`);
    const doLabel = this.nextLabel("hmc.do");
    const endLabel = this.nextLabel("hmc.end");
    lines.push(`  br i1 ${isNull}, label %${endLabel}, label %${doLabel}`);
    lines.push(`${doLabel}:`);

    if (this.needsDropCg(mapType.key) || this.needsDropCg(mapType.value)) {
      const cond = this.nextLabel("hmc.cond");
      const body = this.nextLabel("hmc.body");
      const dropIt = this.nextLabel("hmc.drop");
      const step = this.nextLabel("hmc.step");
      const loopEnd = this.nextLabel("hmc.loopend");
      const iAddr = this.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      lines.push(`  br label %${cond}`);
      lines.push(`${cond}:`);
      const i = this.nextTemp();
      lines.push(`  ${i} = load i64, ptr ${iAddr}`);
      const more = this.nextTemp();
      lines.push(`  ${more} = icmp ult i64 ${i}, ${cap}`);
      lines.push(`  br i1 ${more}, label %${body}, label %${loopEnd}`);
      lines.push(`${body}:`);
      const entryPtr = this.nextTemp();
      lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${i}`);
      const state = this.nextTemp();
      lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
      const occupied = this.nextTemp();
      lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
      lines.push(`  br i1 ${occupied}, label %${dropIt}, label %${step}`);
      lines.push(`${dropIt}:`);
      if (this.needsDropCg(mapType.key)) {
        const kPtr = this.nextTemp();
        lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
        this.emitDropValue(lines, kPtr, mapType.key);
      }
      if (this.needsDropCg(mapType.value)) {
        const vPtr = this.nextTemp();
        lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
        this.emitDropValue(lines, vPtr, mapType.value);
      }
      lines.push(`  br label %${step}`);
      lines.push(`${step}:`);
      const nextI = this.nextTemp();
      lines.push(`  ${nextI} = add i64 ${i}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${cond}`);
      lines.push(`${loopEnd}:`);
    }

    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const totalSize = this.nextTemp();
    lines.push(`  ${totalSize} = mul i64 ${entrySizeI}, ${cap}`);
    lines.push(`  call ptr @memset(ptr ${data}, i32 0, i64 ${totalSize})`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_LEN}`);
    lines.push(`  store i64 0, ptr ${lenPtr}`);
    // The memset above put every slot back to EMPTY, so no tombstone survives either.
    const clearTombsPtr = this.nextTemp();
    lines.push(`  ${clearTombsPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_TOMBS}`);
    lines.push(`  store i64 0, ptr ${clearTombsPtr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, "0", "void"];
  }

  // keys()/values() → a fresh Vec holding a deep clone of each occupied slot's
  // key (or value). The map keeps its own copy, so the two never share a buffer.
  private genHashMapEntries(expr: HIRExpr & { kind: "HashMapEntries" }, lines: string[]): Gen {
    this.hasVecType = true;
    this.hasHashMapType = true;
    this.needsMalloc = true;
    const mapType = expr.object.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapEntries on non-hashmap");
    const elemType = expr.field === "key" ? mapType.key : mapType.value;
    const fieldIdx = expr.field === "key" ? 1 : 2;
    const entryTy = this.hashMapEntryType(mapType.key, mapType.value);
    const elemTy = this.llvmType(elemType);
    const elemSize = this.typeSizeOf(elemType);

    const [ol, ov] = this.genExpr(expr.object);
    lines.push(...ol);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %HashMap ${ov}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %HashMap ${ov}, 1`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = extractvalue %HashMap ${ov}, 2`);
    const { buf } = this.emitAllocBytes(lines, len, elemSize, "hmvals", expr.span);

    const iAddr = this.nextTemp();
    lines.push(`  ${iAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${iAddr}`);
    const outAddr = this.nextTemp();
    lines.push(`  ${outAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${outAddr}`);
    const cond = this.nextLabel("hme.cond");
    const body = this.nextLabel("hme.body");
    const take = this.nextLabel("hme.take");
    const step = this.nextLabel("hme.step");
    const end = this.nextLabel("hme.end");
    lines.push(`  br label %${cond}`);
    lines.push(`${cond}:`);
    const i = this.nextTemp();
    lines.push(`  ${i} = load i64, ptr ${iAddr}`);
    const more = this.nextTemp();
    lines.push(`  ${more} = icmp ult i64 ${i}, ${cap}`);
    lines.push(`  br i1 ${more}, label %${body}, label %${end}`);
    lines.push(`${body}:`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${i}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const occupied = this.nextTemp();
    lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${occupied}, label %${take}, label %${step}`);
    lines.push(`${take}:`);
    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 ${fieldIdx}`);
    const cloned = this.emitDeepCloneFromPtr(lines, srcPtr, elemType);
    const outIdx = this.nextTemp();
    lines.push(`  ${outIdx} = load i64, ptr ${outAddr}`);
    const dstPtr = this.nextTemp();
    lines.push(`  ${dstPtr} = getelementptr ${elemTy}, ptr ${buf}, i64 ${outIdx}`);
    lines.push(`  store ${elemTy} ${cloned}, ptr ${dstPtr}`);
    const nextOut = this.nextTemp();
    lines.push(`  ${nextOut} = add i64 ${outIdx}, 1`);
    lines.push(`  store i64 ${nextOut}, ptr ${outAddr}`);
    lines.push(`  br label %${step}`);
    lines.push(`${step}:`);
    const nextI = this.nextTemp();
    lines.push(`  ${nextI} = add i64 ${i}, 1`);
    lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
    lines.push(`  br label %${cond}`);
    lines.push(`${end}:`);
    const v0 = this.nextTemp();
    lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
    const v1 = this.nextTemp();
    lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${len}, 1`);
    const v2 = this.nextTemp();
    lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${len}, 2`);
    // keys()/values() build a fresh Vec of deep clones, so nothing points into the map
    // afterwards and a temporary receiver can go: `mkMap().keys().len` leaked the map,
    // its keys and its values on every call.
    this.dropOwnedTemp(lines, ov, "%HashMap", expr.object);
    return [lines, v2, "%Vec"];
  }

  private genHashMapGet(expr: HIRExpr & { kind: "HashMapGet" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapGet on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const optionEnumName = expr.optionEnumName;
    const optionLayout = this.enumLayouts.get(optionEnumName);
    if (!optionLayout) throw new Error(`no enum layout for ${optionEnumName}`);
    const optionTy = `%${optionEnumName}`;

    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, expr.map);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmg.probe");
    const probeCheck = this.nextLabel("hmg.check");
    const probeOccupied = this.nextLabel("hmg.occupied");
    const foundLabel = this.nextLabel("hmg.found");
    const notFoundLabel = this.nextLabel("hmg.notfound");
    const probeNext = this.nextLabel("hmg.pnext");
    const doneLabel = this.nextLabel("hmg.done");

    const { slot, entryPtr } = this.emitHashProbePrologue(
      lines,
      { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
      { slotAddr, data, entryTy, keyTy, keyVal, keyType },
    );

    // found — construct Some(value)
    lines.push(`${foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    // Deep-clone, don't `load`: a shallow copy aliases the map's heap, and a later
    // `insert` on the same key drops the old value out from under it (the copy-back
    // idiom `let v = m.get(k); v.x = 1; m.insert(k, v)`). Vec indexing already does
    // this; emitDeepCloneFromPtr degrades to a plain load for Copy types.
    const foundVal = this.emitDeepCloneFromPtr(lines, valPtr, valueType);
    // The clone can open new basic blocks (vec/enum clone loops), so the phi at
    // the bottom must name the block we actually end in, not `foundLabel`.
    const foundEnd = this.nextLabel("hmg.found.end");
    lines.push(`  br label %${foundEnd}`);
    lines.push(`${foundEnd}:`);
    // build Option::Some(val) — tag=0, payload=value
    const someAlloca = this.nextTemp();
    lines.push(`  ${someAlloca} = alloca ${optionTy}`);
    const someTagPtr = this.nextTemp();
    lines.push(`  ${someTagPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 0`);
    const someTag = must(optionLayout.variants, "Some", "variants").tag;
    lines.push(`  store i32 ${someTag}, ptr ${someTagPtr}`);
    const somePayloadPtr = this.nextTemp();
    lines.push(`  ${somePayloadPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 1`);
    lines.push(`  store ${valTy} ${foundVal}, ptr ${somePayloadPtr}`);
    const someVal = this.nextTemp();
    lines.push(`  ${someVal} = load ${optionTy}, ptr ${someAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    // not found — construct None
    lines.push(`${notFoundLabel}:`);
    const noneAlloca = this.nextTemp();
    lines.push(`  ${noneAlloca} = alloca ${optionTy}`);
    // zero it first to avoid garbage in payload
    this.needsMemset = true;
    const optionSize = this.nextTemp();
    lines.push(`  ${optionSize} = getelementptr ${optionTy}, ptr null, i32 1`);
    const optionSizeI = this.nextTemp();
    lines.push(`  ${optionSizeI} = ptrtoint ptr ${optionSize} to i64`);
    lines.push(`  call ptr @memset(ptr ${noneAlloca}, i32 0, i64 ${optionSizeI})`);
    const noneTagPtr = this.nextTemp();
    lines.push(`  ${noneTagPtr} = getelementptr ${optionTy}, ptr ${noneAlloca}, i32 0, i32 0`);
    const noneTag = must(optionLayout.variants, "None", "variants").tag;
    lines.push(`  store i32 ${noneTag}, ptr ${noneTagPtr}`);
    const noneVal = this.nextTemp();
    lines.push(`  ${noneVal} = load ${optionTy}, ptr ${noneAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${optionTy} [${someVal}, %${foundEnd}], [${noneVal}, %${notFoundLabel}]`);
    // The key was built by the CALLER and handed to a lookup that only reads it. Nothing
    // takes ownership on this path, so without a drop `m.get("k" + i.toString())` leaks
    // that string on every call — one 16-byte allocation per lookup, in about the most
    // ordinary map idiom there is. `insert` already knew this for its overwrite path;
    // the four read-only lookups did not. dropOwnedTemp no-ops unless the argument really
    // is an owned temporary, so a variable or a literal key is untouched.
    this.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
    // A materialized receiver is an owned temporary nobody else will free. This runs after
    // the phi above, so the block it opens cannot invalidate the phi's predecessors.
    if (mapTempSlot) this.emitDropValue(lines, mapTempSlot, expr.map.type);
    return [lines, result, optionTy];
  }

  private genHashMapGetOrDefault(expr: HIRExpr & { kind: "HashMapGetOrDefault" }, lines: string[]): Gen {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapGetOrDefault on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const { ptr: mapPtr, tempSlot: mapTempSlot } = this.mapReceiverPtr(lines, expr.map);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);
    const [defaultLines, defaultVal] = this.genExpr(expr.default);
    lines.push(...defaultLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_SEED}`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_CAP}`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 ${HM_DATA}`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmgd.probe");
    const probeCheck = this.nextLabel("hmgd.check");
    const probeOccupied = this.nextLabel("hmgd.occupied");
    const foundLabel = this.nextLabel("hmgd.found");
    const notFoundLabel = this.nextLabel("hmgd.notfound");
    const probeNext = this.nextLabel("hmgd.pnext");
    const doneLabel = this.nextLabel("hmgd.done");

    const { slot, entryPtr } = this.emitHashProbePrologue(
      lines,
      { probeCond, probeCheck, probeOccupied, probeNext, emptyTarget: notFoundLabel, matchTarget: foundLabel },
      { slotAddr, data, entryTy, keyTy, keyVal, keyType },
    );

    // found — return the value directly (deep-cloned; see genHashMapGet)
    lines.push(`${foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    const foundVal = this.emitDeepCloneFromPtr(lines, valPtr, valueType);
    // see genHashMapGet: the clone may have opened new blocks
    const foundEnd = this.nextLabel("hmgd.found.end");
    lines.push(`  br label %${foundEnd}`);
    lines.push(`${foundEnd}:`);
    // The default is dead on this path — the map had the key — so a computed one has no
    // owner. `m.getOrDefault(k, "dflt" + i.toString())` leaked its default on every hit.
    // The drop is conditional by construction: it sits in the found block, and the
    // not-found path hands that same value to the caller as the result.
    //
    // Dropping a Vec or an enum opens basic blocks of its own, so the block this path
    // ENDS in is not `foundEnd` any more. Rejoin an empty one and let the phi below name
    // that, exactly as the deep clone above already has to.
    this.dropOwnedTemp(lines, defaultVal, valTy, expr.default);
    const foundJoin = this.nextLabel("hmgd.found.join");
    lines.push(`  br label %${foundJoin}`);
    lines.push(`${foundJoin}:`);
    lines.push(`  br label %${doneLabel}`);

    // not found — use the default value
    lines.push(`${notFoundLabel}:`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${valTy} [${foundVal}, %${foundJoin}], [${defaultVal}, %${notFoundLabel}]`);
    this.dropOwnedTemp(lines, keyVal, keyTy, expr.key);
    // A materialized receiver is an owned temporary nobody else will free. This runs after
    // the phi above, so the block it opens cannot invalidate the phi's predecessors.
    if (mapTempSlot) this.emitDropValue(lines, mapTempSlot, expr.map.type);
    return [lines, result, valTy];
  }

  private needsMemset = false;
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
  private panicAbort(lines: string[]) {
    // Bare-metal/freestanding (os "none"): there is no libc, so abort()/fflush() are
    // undefined symbols. The embedded runtime provides exit (semihosting SYS_EXIT) and there
    // is no buffered stdio to flush — terminate exactly as the pre-abort panic did there.
    if (this.target.os === "none") {
      this.needsExit = true;
      lines.push(`  call void @exit(i32 1)`);
      return;
    }
    this.needsAbort = true;
    // abort() raises SIGABRT immediately WITHOUT flushing stdio — unlike exit(), which does.
    // The panic message was just printf'd (block-buffered on a piped stdout, e.g. Linux under
    // a test harness), so flush it first or it's lost with the process. fflush(NULL) flushes
    // every open stream.
    this.needsFflush = true;
    lines.push(`  call i32 @fflush(ptr null)`);
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
      const lenI32 = this.nextTemp();
      lines.push(`  ${lenI32} = trunc i64 ${lenVal} to i32`);
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
      let passVal = val;
      let passType = llvmTy;
      if (tk.bits < 32) {
        const widened = this.nextTemp();
        lines.push(`  ${widened} = ${tk.signed ? "sext" : "zext"} ${llvmTy} ${val} to i32`);
        passVal = widened;
        passType = "i32";
      }
      partFmts.push(tk.bits <= 32 ? (tk.signed ? "%d" : "%u") : (tk.signed ? "%lld" : "%llu"));
      partArgs.push({ val: passVal, type: passType });
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

  // Append `n` bytes of `src` to a buffer held in three caller allocas
  // (ptr, len, cap), growing it geometrically. Emitted once per module.
  private bufAppendFn(): string {
    if (!this.emittedBufAppend) {
      this.emittedBufAppend = true;
      this.needsRealloc = true;
      this.needsMemcpy = true;
      this.helperFnBodies.push([
        "define internal void @milo.bufappend(ptr %bufSlot, ptr %lenSlot, ptr %capSlot, ptr %src, i64 %n) {",
        "entry:",
        "  %len = load i64, ptr %lenSlot",
        "  %cap = load i64, ptr %capSlot",
        "  %end = add i64 %len, %n",
        // +1 so the NUL written below always has room
        "  %need = add i64 %end, 1",
        "  %fits = icmp ule i64 %need, %cap",
        "  br i1 %fits, label %copy, label %grow",
        "grow:",
        "  %dbl = shl i64 %cap, 1",
        "  %small = icmp ult i64 %dbl, %need",
        "  %newcap = select i1 %small, i64 %need, i64 %dbl",
        "  %old = load ptr, ptr %bufSlot",
        "  %nb = call ptr @realloc(ptr %old, i64 %newcap)",
        "  store ptr %nb, ptr %bufSlot",
        "  store i64 %newcap, ptr %capSlot",
        "  br label %copy",
        "copy:",
        "  %buf = load ptr, ptr %bufSlot",
        "  %dst = getelementptr i8, ptr %buf, i64 %len",
        "  call ptr @memcpy(ptr %dst, ptr %src, i64 %n)",
        "  store i64 %end, ptr %lenSlot",
        "  %term = getelementptr i8, ptr %buf, i64 %end",
        "  store i8 0, ptr %term",
        "  ret void",
        "}",
      ]);
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr %${enumName}, ptr ${stagePtr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

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
        // Payload starts at offset 1 of the enum struct ({tag, [N x i64]}); cast to variant struct
        const payloadPtr = this.nextTemp();
        lines.push(`  ${payloadPtr} = getelementptr %${enumName}, ptr ${stagePtr}, i32 0, i32 1`);
        // Build a synthetic struct type representing this variant's payload fields.
        const payloadStructTy = `{ ${info.fieldTypes.join(", ")} }`;
        for (let fi = 0; fi < info.fieldTypeKinds.length; fi++) {
          if (fi > 0) formatParts.push(", ");
          const fk = info.fieldTypeKinds[fi];
          const ft = info.fieldTypes[fi];
          const fieldPtr = this.nextTemp();
          lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${fi}`);
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
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);

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
      : [`  %d = fadd double %v, 0.000000e+00`];
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
  private emitFloatToBuf(val: string, bits: number, lines: string[]): { buf: string; len: string } {
    const w = bits === 32 ? 32 : 64;
    this.ensureFloatFormatHelper(w);
    this.needsMalloc = true;
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${F64_BUF})`);
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

  // emitDeepCloneFromPtr: given a pointer to a value of type `typeKind`,
  // produce a fully-cloned value (deep copy of all heap-owned data).
  // Used for auto-clone on Vec[i] reads so the source Vec stays intact.
  private emitDeepCloneFromPtr(lines: string[], srcPtr: string, typeKind: TypeKind): string {
    const lt = this.llvmType(typeKind);

    // Copy types: just load
    if (!this.needsDropCg(typeKind)) {
      const v = this.nextTemp();
      lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
      return v;
    }

    if (typeKind.tag === "string") {
      this.hasStringType = true;
      this.needsMalloc = true;
      this.needsMemcpy = true;
      const orig = this.nextTemp();
      lines.push(`  ${orig} = load %String, ptr ${srcPtr}`);
      const data = this.nextTemp();
      lines.push(`  ${data} = extractvalue %String ${orig}, 0`);
      const len = this.nextTemp();
      lines.push(`  ${len} = extractvalue %String ${orig}, 1`);
      const allocSz = this.nextTemp();
      lines.push(`  ${allocSz} = add i64 ${len}, 1`);
      const buf = this.nextTemp();
      lines.push(`  ${buf} = call ptr @malloc(i64 ${allocSz})`);
      lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${data}, i64 ${len})`);
      const nullPtr = this.nextTemp();
      lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${len}`);
      lines.push(`  store i8 0, ptr ${nullPtr}`);
      const s0 = this.nextTemp();
      lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
      const s1 = this.nextTemp();
      lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len}, 1`);
      const s2 = this.nextTemp();
      lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
      return s2;
    }

    if (typeKind.tag === "vec") {
      this.hasVecType = true;
      this.needsMalloc = true;
      this.needsMemcpy = true;
      const orig = this.nextTemp();
      lines.push(`  ${orig} = load %Vec, ptr ${srcPtr}`);
      const srcData = this.nextTemp();
      lines.push(`  ${srcData} = extractvalue %Vec ${orig}, 0`);
      const vecLen = this.nextTemp();
      lines.push(`  ${vecLen} = extractvalue %Vec ${orig}, 1`);
      const elemSize = this.typeSizeOf(typeKind.element);
      const elemTy = this.llvmType(typeKind.element);

      // result buf pointer (set conditionally below)
      const newBufAddr = this.nextTemp();
      lines.push(`  ${newBufAddr} = alloca ptr`);
      lines.push(`  store ptr null, ptr ${newBufAddr}`);

      const isEmpty = this.nextTemp();
      lines.push(`  ${isEmpty} = icmp eq i64 ${vecLen}, 0`);
      const allocLabel = this.nextLabel("vec.clone.alloc");
      const endLabel = this.nextLabel("vec.clone.end");
      lines.push(`  br i1 ${isEmpty}, label %${endLabel}, label %${allocLabel}`);

      lines.push(`${allocLabel}:`);
      const { buf: newBuf, bytes: bytes } = this.emitAllocBytes(lines, vecLen, elemSize, "vecclone", undefined);
      lines.push(`  store ptr ${newBuf}, ptr ${newBufAddr}`);

      if (this.needsDropCg(typeKind.element)) {
        // deep-clone each element
        const loopCond = this.nextLabel("vec.clone.cond");
        const loopBody = this.nextLabel("vec.clone.body");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopCond}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${vecLen}`);
        lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${endLabel}`);
        lines.push(`${loopBody}:`);
        const srcElemPtr = this.nextTemp();
        lines.push(`  ${srcElemPtr} = getelementptr ${elemTy}, ptr ${srcData}, i64 ${iVal}`);
        const clonedElem = this.emitDeepCloneFromPtr(lines, srcElemPtr, typeKind.element);
        const dstElemPtr = this.nextTemp();
        lines.push(`  ${dstElemPtr} = getelementptr ${elemTy}, ptr ${newBuf}, i64 ${iVal}`);
        lines.push(`  store ${elemTy} ${clonedElem}, ptr ${dstElemPtr}`);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
      } else {
        // Copy element: just memcpy
        lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${srcData}, i64 ${bytes})`);
        lines.push(`  br label %${endLabel}`);
      }

      lines.push(`${endLabel}:`);
      const finalPtr = this.nextTemp();
      lines.push(`  ${finalPtr} = load ptr, ptr ${newBufAddr}`);
      const v0 = this.nextTemp();
      lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${finalPtr}, 0`);
      const v1 = this.nextTemp();
      lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${vecLen}, 1`);
      const v2 = this.nextTemp();
      lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${vecLen}, 2`);
      return v2;
    }

    if (typeKind.tag === "heap") {
      this.needsMalloc = true;
      const inner = typeKind.inner;
      const innerTy = this.llvmType(inner);
      const innerSize = this.typeSizeOf(inner);
      const origPtr = this.nextTemp();
      lines.push(`  ${origPtr} = load ptr, ptr ${srcPtr}`);
      const newHeap = this.nextTemp();
      lines.push(`  ${newHeap} = call ptr @malloc(i64 ${innerSize})`);
      const clonedInner = this.emitDeepCloneFromPtr(lines, origPtr, inner);
      lines.push(`  store ${innerTy} ${clonedInner}, ptr ${newHeap}`);
      return newHeap;
    }

    if (typeKind.tag === "struct") {
      const layout = this.structLayouts.get(typeKind.name);
      if (!layout) {
        const v = this.nextTemp();
        lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
        return v;
      }
      const structTy = `%${typeKind.name}`;
      if (this.needsDropCg(typeKind)) {
        this.ensureStructCloneHelper(typeKind.name);
        const helperName = `milo.clone.struct.${typeKind.name}`;
        const dstAlloca = this.nextTemp();
        lines.push(`  ${dstAlloca} = alloca ${structTy}`);
        lines.push(`  call void @${helperName}(ptr ${srcPtr}, ptr ${dstAlloca})`);
        const result = this.nextTemp();
        lines.push(`  ${result} = load ${structTy}, ptr ${dstAlloca}`);
        return result;
      }
      const newAlloca = this.nextTemp();
      lines.push(`  ${newAlloca} = alloca ${structTy}`);
      for (let i = 0; i < layout.fields.length; i++) {
        const f = layout.fields[i];
        const srcFieldPtr = this.nextTemp();
        lines.push(`  ${srcFieldPtr} = getelementptr ${structTy}, ptr ${srcPtr}, i32 0, i32 ${i}`);
        const clonedField = this.emitDeepCloneFromPtr(lines, srcFieldPtr, f.typeKind);
        const dstFieldPtr = this.nextTemp();
        lines.push(`  ${dstFieldPtr} = getelementptr ${structTy}, ptr ${newAlloca}, i32 0, i32 ${i}`);
        lines.push(`  store ${f.type} ${clonedField}, ptr ${dstFieldPtr}`);
      }
      const result = this.nextTemp();
      lines.push(`  ${result} = load ${structTy}, ptr ${newAlloca}`);
      return result;
    }

    if (typeKind.tag === "enum" && this.needsDropCg(typeKind) && this.enumLayouts.has(typeKind.name)) {
      this.ensureEnumCloneHelper(typeKind.name);
      const dstAlloca = this.nextTemp();
      lines.push(`  ${dstAlloca} = alloca ${lt}`);
      lines.push(`  call void @milo.clone.${typeKind.name}(ptr ${srcPtr}, ptr ${dstAlloca})`);
      const result = this.nextTemp();
      lines.push(`  ${result} = load ${lt}, ptr ${dstAlloca}`);
      return result;
    }

    if (typeKind.tag === "hashmap") {
      // A shallow load here shares the entry buffer; the clone's drop then
      // frees it under the original, and the next probe loop walks freed
      // memory forever (found via self-hosting: milo-self checking any enum
      // match ran away on a cloned EnumInfo's variants map).
      this.hasHashMapType = true;
      this.needsMalloc = true;
      this.needsMemcpy = true;
      const keyType = typeKind.key;
      const valueType = typeKind.value;
      const entryTy = this.hashMapEntryType(keyType, valueType);
      const orig = this.nextTemp();
      lines.push(`  ${orig} = load %HashMap, ptr ${srcPtr}`);
      const srcData = this.nextTemp();
      lines.push(`  ${srcData} = extractvalue %HashMap ${orig}, 0`);
      const len = this.nextTemp();
      lines.push(`  ${len} = extractvalue %HashMap ${orig}, 1`);
      const cap = this.nextTemp();
      lines.push(`  ${cap} = extractvalue %HashMap ${orig}, 2`);
      const seed = this.nextTemp();
      lines.push(`  ${seed} = extractvalue %HashMap ${orig}, 3`);
      const entrySizePtr = this.nextTemp();
      lines.push(`  ${entrySizePtr} = getelementptr ${entryTy}, ptr null, i32 1`);
      const entrySize = this.nextTemp();
      lines.push(`  ${entrySize} = ptrtoint ptr ${entrySizePtr} to i64`);
      const { buf: newBuf, bytes: bytes } = this.emitAllocBytes(lines, cap, entrySize, "hmclone", undefined);
      lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${srcData}, i64 ${bytes})`);

      if (this.needsDropCg(keyType) || this.needsDropCg(valueType)) {
        // memcpy covered states and Copy fields; re-clone owned K/V in
        // occupied slots so the two maps share no heap data
        const condLbl = this.nextLabel("hm.clone.cond");
        const bodyLbl = this.nextLabel("hm.clone.body");
        const skipLbl = this.nextLabel("hm.clone.skip");
        const endLbl = this.nextLabel("hm.clone.end");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${condLbl}`);
        lines.push(`${condLbl}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${cap}`);
        lines.push(`  br i1 ${cmp}, label %${bodyLbl}, label %${endLbl}`);
        lines.push(`${bodyLbl}:`);
        const statePtr = this.nextTemp();
        lines.push(`  ${statePtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 0`);
        const state = this.nextTemp();
        lines.push(`  ${state} = load i8, ptr ${statePtr}`);
        const occupied = this.nextTemp();
        lines.push(`  ${occupied} = icmp eq i8 ${state}, 1`);
        const cloneLbl = this.nextLabel("hm.clone.slot");
        lines.push(`  br i1 ${occupied}, label %${cloneLbl}, label %${skipLbl}`);
        lines.push(`${cloneLbl}:`);
        if (this.needsDropCg(keyType)) {
          const srcKeyPtr = this.nextTemp();
          lines.push(`  ${srcKeyPtr} = getelementptr ${entryTy}, ptr ${srcData}, i64 ${iVal}, i32 1`);
          const clonedKey = this.emitDeepCloneFromPtr(lines, srcKeyPtr, keyType);
          const dstKeyPtr = this.nextTemp();
          lines.push(`  ${dstKeyPtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 1`);
          lines.push(`  store ${this.llvmType(keyType)} ${clonedKey}, ptr ${dstKeyPtr}`);
        }
        if (this.needsDropCg(valueType)) {
          const srcValPtr = this.nextTemp();
          lines.push(`  ${srcValPtr} = getelementptr ${entryTy}, ptr ${srcData}, i64 ${iVal}, i32 2`);
          const clonedVal = this.emitDeepCloneFromPtr(lines, srcValPtr, valueType);
          const dstValPtr = this.nextTemp();
          lines.push(`  ${dstValPtr} = getelementptr ${entryTy}, ptr ${newBuf}, i64 ${iVal}, i32 2`);
          lines.push(`  store ${this.llvmType(valueType)} ${clonedVal}, ptr ${dstValPtr}`);
        }
        lines.push(`  br label %${skipLbl}`);
        lines.push(`${skipLbl}:`);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${condLbl}`);
        lines.push(`${endLbl}:`);
      }

      const h0 = this.nextTemp();
      lines.push(`  ${h0} = insertvalue %HashMap undef, ptr ${newBuf}, 0`);
      const h1 = this.nextTemp();
      lines.push(`  ${h1} = insertvalue %HashMap ${h0}, i64 ${len}, 1`);
      const h2 = this.nextTemp();
      lines.push(`  ${h2} = insertvalue %HashMap ${h1}, i64 ${cap}, 2`);
      const h3 = this.nextTemp();
      lines.push(`  ${h3} = insertvalue %HashMap ${h2}, i64 ${seed}, 3`);
      // The buffer is memcpy'd verbatim, tombstone slots and all, so the clone starts
      // life with exactly the source's deleted-slot count — not zero.
      const srcTombs = this.nextTemp();
      lines.push(`  ${srcTombs} = extractvalue %HashMap ${orig}, ${HM_TOMBS}`);
      const h4 = this.nextTemp();
      lines.push(`  ${h4} = insertvalue %HashMap ${h3}, i64 ${srcTombs}, ${HM_TOMBS}`);
      return h4;
    }

    // array — fall back to shallow load
    const v = this.nextTemp();
    lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
    return v;
  }

  private generatedEnumCloneHelpers = new Set<string>();

  // Deep-clone an enum by tag: shallow-copy first (tag + Copy payload fields), then
  // overwrite each droppable payload field with a deep clone. Mirrors
  // ensureDropHelper. Recursive enums terminate because the recursion goes through
  // `Heap`, and the memo set stops re-entrant generation.
  private ensureEnumCloneHelper(enumName: string) {
    if (this.generatedEnumCloneHelpers.has(enumName)) return;
    this.generatedEnumCloneHelpers.add(enumName);

    const layout = must(this.enumLayouts, enumName, "enum layouts");
    const enumTy = `%${enumName}`;
    const helperName = `milo.clone.${enumName}`;
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;

    const body: string[] = [];
    body.push(`define void @${helperName}(ptr %src, ptr %dst) {`);
    body.push("entry.bb:");
    const shallow = this.nextTemp();
    body.push(`  ${shallow} = load ${enumTy}, ptr %src`);
    body.push(`  store ${enumTy} ${shallow}, ptr %dst`);
    const tagPtr = this.nextTemp();
    body.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr %src, i32 0, i32 0`);
    const tag = this.nextTemp();
    body.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const doneLabel = this.nextLabel("clone.done");
    const cases: string[] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      if (!variant.fieldTypeKinds.some(f => this.needsDropCg(f))) continue;

      const label = this.nextLabel(`clone.${vName}`);
      cases.push(`    i32 ${variant.tag}, label %${label}`);

      const vLines: string[] = [];
      vLines.push(`${label}:`);
      const srcPayload = this.nextTemp();
      vLines.push(`  ${srcPayload} = getelementptr ${enumTy}, ptr %src, i32 0, i32 1`);
      const dstPayload = this.nextTemp();
      vLines.push(`  ${dstPayload} = getelementptr ${enumTy}, ptr %dst, i32 0, i32 1`);

      if (variant.fieldTypes.length === 1) {
        const cloned = this.emitDeepCloneFromPtr(vLines, srcPayload, variant.fieldTypeKinds[0]);
        vLines.push(`  store ${variant.fieldTypes[0]} ${cloned}, ptr ${dstPayload}`);
      } else {
        const structTy = `{ ${variant.fieldTypes.join(", ")} }`;
        for (let i = 0; i < variant.fieldTypes.length; i++) {
          if (!this.needsDropCg(variant.fieldTypeKinds[i])) continue;
          const srcFieldPtr = this.nextTemp();
          vLines.push(`  ${srcFieldPtr} = getelementptr ${structTy}, ptr ${srcPayload}, i32 0, i32 ${i}`);
          const cloned = this.emitDeepCloneFromPtr(vLines, srcFieldPtr, variant.fieldTypeKinds[i]);
          const dstFieldPtr = this.nextTemp();
          vLines.push(`  ${dstFieldPtr} = getelementptr ${structTy}, ptr ${dstPayload}, i32 0, i32 ${i}`);
          vLines.push(`  store ${variant.fieldTypes[i]} ${cloned}, ptr ${dstFieldPtr}`);
        }
      }
      vLines.push(`  br label %${doneLabel}`);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      body.push(`  switch i32 ${tag}, label %${doneLabel} [`);
      for (const c of cases) body.push(c);
      body.push("  ]");
      for (const vb of variantBodies) body.push(...vb);
    } else {
      body.push(`  br label %${doneLabel}`);
    }
    body.push(`${doneLabel}:`);
    body.push("  ret void");
    body.push("}");

    // Helper bodies bypass the normal function emitter, so hoist here: the clone
    // of a Vec field emits its allocas inside the copy loop, and a dynamic alloca
    // per iteration walks the stack off the end.
    this.hoistAllocas(body, 2);
    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
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
  private optionOpDropsReceiver(expr: HIRExpr & { kind: "OptionOp" }): boolean {
    if (expr.op !== "map" && expr.op !== "optionAndThen") return false;
    if (!this.needsDropCg(expr.value.type)) return false;
    const v = expr.value;
    if (v.kind === "OptionOp") return v.op === "map" || v.op === "optionAndThen";
    return this.isOwnedTempExpr(v);
  }

  // The value a block produces, when it produces one: a block's value is its tail
  // expression, which is how genIfExpr and the match-arm emitter already read it. Anything
  // else there (a Return, a loop) leaves no value for this expression to own.
  private armTailExpr(body: HIRStmt[]): HIRExpr | null {
    const last = body[body.length - 1];
    return last && last.kind === "ExprStmt" ? last.expr : null;
  }

  // Whether an `if`/`match` used as an EXPRESSION hands back a value nobody else owns.
  //
  // Every arm that can produce the result has to be one we own, the same AND that guards
  // DefaultValue. But NOT the same predicate: DefaultValue accepts an Ident because
  // genDefaultValue MOVES out of the branch it takes, zeroing the source. An `if` arm does
  // not — `if c { a } else { b }` for locals a and b leaves both still owned by the
  // enclosing scope, and dropping the result on top of that aborts with a double free
  // (measured: exit 133). So an Ident arm makes this false, which leaves that shape
  // leaking rather than crashing; fixing it needs the arm's source zeroed first.
  private blockValueOwnsResult(bodies: HIRStmt[][], type: TypeKind): boolean {
    if (!this.needsDropCg(type)) return false;
    if (bodies.length === 0) return false;
    for (const body of bodies) {
      const tail = this.armTailExpr(body);
      if (!tail) return false;
      if (tail.kind !== "StringLit" && !this.isOwnedTempExpr(tail)) return false;
    }
    return true;
  }

  private isOwnedTempExpr(expr: HIRExpr): boolean {
    // A discarded small-type `replace(...)` result is dropped here (SSA path). A big-agg
    // replace drops its own moved-out value inside genExpr, so it must NOT double-drop here.
    if (expr.kind === "MemReplace") return !this.isBigAgg(this.llvmType(expr.type));
    if (expr.kind === "Call" || expr.kind === "ClosureCall" || expr.kind === "InterfaceMethodCall") return true;
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
      // fold returns the ACCUMULATOR, which is owned whenever the accumulator type is —
      // `v.fold("", (a: string, x: &i64): string => a + x.toString())` hands back a String
      // nobody else owns. It sat in NOT_OWNED_TEMP with the scalar-yielding Vec reads.
      // dropOwnedTemp still checks needsDropCg, so an i64 accumulator is unaffected.
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
      // HashMap.get clones the value out of the table for the same reason. Its
      // sibling getOrDefault is deliberately NOT here: on a miss it hands back the
      // caller's own default, which the caller still owns.
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
      case "Unwrap":
      case "Propagate":
        return this.unwrapMovesPayload(expr);
      case "DefaultValue":
        return this.defaultValueOwnsResult(expr);
      case "IfExpr":
        return this.blockValueOwnsResult([expr.thenBody, expr.elseBody], expr.type);
      case "MatchExpr":
        return this.blockValueOwnsResult(expr.arms.map(a => a.body), expr.type);
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
  private argTempDrops: { addr: string; type: TypeKind }[] = [];
  private hirFns = new Map<string, HIRFunction>();
  private closureParamEscapeCache = new Map<string, boolean>();

  private flushArgTempDrops(lines: string[], mark: number) {
    while (this.argTempDrops.length > mark) {
      const t = this.argTempDrops.pop()!;
      this.emitDropValue(lines, t.addr, t.type);
    }
  }

  // Free a value that was produced by a call and then consumed in-place by an
  // operator, leaving nothing that will ever drop it.
  private dropOwnedTemp(lines: string[], val: string, llTy: string, expr: HIRExpr) {
    if (!this.isOwnedTempExpr(expr) || !this.needsDropCg(expr.type)) return;
    const tmpAddr = `%__tmpdrop.${this.scopeCounter++}.addr`;
    this.entryAllocas.push(`  ${tmpAddr} = alloca ${llTy}`);
    lines.push(this.valStore(llTy, val, tmpAddr));
    this.emitDropValue(lines, tmpAddr, expr.type);
  }

  private emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind) {
    // An owning closure is `{ ptr fn, ptr env }`, and the drop glue lives in the FIRST
    // word of the environment rather than in a third word of the pair. That choice is
    // what keeps a closure two words wide, so nothing that passes one around — call
    // sites, the Task struct, `_callClosureVoid`, emit-js — has to change. The header is
    // null for a by-reference closure (its environment is a stack slot in the frame that
    // built it, and freeing that would corrupt the frame), and the whole environment is
    // null for a closure that captured nothing — the two null checks are what let one
    // drop path serve all three shapes.
    if (typeKind.tag === "fn" && typeKind.owning === true) {
      const pair = this.nextTemp(), env = this.nextTemp(), isEnv = this.nextTemp();
      const dropFn = this.nextTemp(), hasDrop = this.nextTemp();
      const callLabel = this.nextLabel("cldrop.call");
      const midLabel = this.nextLabel("cldrop.mid");
      const doneLabel = this.nextLabel("cldrop.done");
      lines.push(`  ${pair} = load { ptr, ptr }, ptr ${allocaPtr}`);
      lines.push(`  ${env} = extractvalue { ptr, ptr } ${pair}, 1`);
      lines.push(`  ${isEnv} = icmp ne ptr ${env}, null`);
      lines.push(`  br i1 ${isEnv}, label %${midLabel}, label %${doneLabel}`);
      lines.push(`${midLabel}:`);
      lines.push(`  ${dropFn} = load ptr, ptr ${env}`);
      lines.push(`  ${hasDrop} = icmp ne ptr ${dropFn}, null`);
      lines.push(`  br i1 ${hasDrop}, label %${callLabel}, label %${doneLabel}`);
      lines.push(`${callLabel}:`);
      lines.push(`  call void ${dropFn}(ptr ${env})`);
      lines.push(`  br label %${doneLabel}`);
      lines.push(`${doneLabel}:`);
      return;
    }
    if (typeKind.tag === "string") {
      this.needsFree = true;
      const old = this.nextTemp();
      lines.push(`  ${old} = load %String, ptr ${allocaPtr}`);
      const cap = this.nextTemp();
      lines.push(`  ${cap} = extractvalue %String ${old}, 2`);
      const owned = this.nextTemp();
      lines.push(`  ${owned} = icmp ugt i64 ${cap}, 0`);
      const dropLabel = this.nextLabel("drop");
      const skipLabel = this.nextLabel("drop.skip");
      lines.push(`  br i1 ${owned}, label %${dropLabel}, label %${skipLabel}`);
      lines.push(`${dropLabel}:`);
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = extractvalue %String ${old}, 0`);
      lines.push(`  call void @free(ptr ${ptr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "vec") {
      this.needsFree = true;
      const vecVal = this.nextTemp();
      lines.push(`  ${vecVal} = load %Vec, ptr ${allocaPtr}`);
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = extractvalue %Vec ${vecVal}, 0`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${dataPtr}, null`);
      const dropLabel = this.nextLabel("vec.drop");
      const skipLabel = this.nextLabel("vec.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (this.needsDropCg(typeKind.element)) {
        // drop each element: for i in 0..len
        const vecLen = this.nextTemp();
        lines.push(`  ${vecLen} = extractvalue %Vec ${vecVal}, 1`);
        const elemTy = this.llvmType(typeKind.element);
        const loopCond = this.nextLabel("vec.drop.cond");
        const loopBody = this.nextLabel("vec.drop.body");
        const loopEnd = this.nextLabel("vec.drop.end");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopCond}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${vecLen}`);
        lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
        lines.push(`${loopBody}:`);
        const elemPtr = this.nextTemp();
        lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${dataPtr}, i64 ${iVal}`);
        this.emitDropValue(lines, elemPtr, typeKind.element);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopEnd}:`);
      }
      lines.push(`  call void @free(ptr ${dataPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "heap") {
      this.needsFree = true;
      let heapPtr: string;
      if (typeKind.inner.tag === "interface") {
        // Heap<Interface> is { ptr, ptr } — extract data ptr from element 0
        const fatPtr = this.nextTemp();
        lines.push(`  ${fatPtr} = load { ptr, ptr }, ptr ${allocaPtr}`);
        heapPtr = this.nextTemp();
        lines.push(`  ${heapPtr} = extractvalue { ptr, ptr } ${fatPtr}, 0`);
      } else {
        heapPtr = this.nextTemp();
        lines.push(`  ${heapPtr} = load ptr, ptr ${allocaPtr}`);
      }
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${heapPtr}, null`);
      const dropLabel = this.nextLabel("heap.drop");
      const skipLabel = this.nextLabel("heap.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (typeKind.inner.tag === "interface") {
        // The concrete type is erased here, so its destructor is reached through the
        // itable's trailing drop slot. A null slot means the concrete type has none.
        const n = this.ifaceMethodCounts.get(typeKind.inner.name);
        if (n !== undefined) {
          const fat = this.nextTemp();
          lines.push(`  ${fat} = load { ptr, ptr }, ptr ${allocaPtr}`);
          const itab = this.nextTemp();
          lines.push(`  ${itab} = extractvalue { ptr, ptr } ${fat}, 1`);
          const slot = this.nextTemp();
          lines.push(`  ${slot} = getelementptr ptr, ptr ${itab}, i32 ${n}`);
          const dropFn = this.nextTemp();
          lines.push(`  ${dropFn} = load ptr, ptr ${slot}`);
          const noDrop = this.nextTemp();
          lines.push(`  ${noDrop} = icmp eq ptr ${dropFn}, null`);
          const callLbl = this.nextLabel("iface.drop.call");
          const afterLbl = this.nextLabel("iface.drop.after");
          lines.push(`  br i1 ${noDrop}, label %${afterLbl}, label %${callLbl}`);
          lines.push(`${callLbl}:`);
          lines.push(`  call void ${dropFn}(ptr ${heapPtr})`);
          lines.push(`  br label %${afterLbl}`);
          lines.push(`${afterLbl}:`);
        }
      } else if (this.needsDropCg(typeKind.inner)) {
        this.emitDropValue(lines, heapPtr, typeKind.inner);
      }
      lines.push(`  call void @free(ptr ${heapPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "hashmap") {
      this.needsFree = true;
      const hmVal = this.nextTemp();
      lines.push(`  ${hmVal} = load %HashMap, ptr ${allocaPtr}`);
      const hmDataPtr = this.nextTemp();
      lines.push(`  ${hmDataPtr} = extractvalue %HashMap ${hmVal}, 0`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${hmDataPtr}, null`);
      const dropLabel = this.nextLabel("hm.drop");
      const skipLabel = this.nextLabel("hm.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (this.needsDropCg(typeKind.key) || this.needsDropCg(typeKind.value)) {
        const hmCap = this.nextTemp();
        lines.push(`  ${hmCap} = extractvalue %HashMap ${hmVal}, 2`);
        const entryTy = this.hashMapEntryType(typeKind.key, typeKind.value);
        const loopCond = this.nextLabel("hm.drop.cond");
        const loopBody = this.nextLabel("hm.drop.body");
        const loopEnd = this.nextLabel("hm.drop.end");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopCond}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${hmCap}`);
        lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
        lines.push(`${loopBody}:`);
        const entryPtr = this.nextTemp();
        lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${hmDataPtr}, i64 ${iVal}`);
        const state = this.nextTemp();
        lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
        const isOccupied = this.nextTemp();
        lines.push(`  ${isOccupied} = icmp eq i8 ${state}, 1`);
        const dropEntryLabel = this.nextLabel("hm.drop.entry");
        const skipEntryLabel = this.nextLabel("hm.drop.skip");
        lines.push(`  br i1 ${isOccupied}, label %${dropEntryLabel}, label %${skipEntryLabel}`);
        lines.push(`${dropEntryLabel}:`);
        if (this.needsDropCg(typeKind.key)) {
          const kPtr = this.nextTemp();
          lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
          this.emitDropValue(lines, kPtr, typeKind.key);
        }
        if (this.needsDropCg(typeKind.value)) {
          const vPtr = this.nextTemp();
          lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
          this.emitDropValue(lines, vPtr, typeKind.value);
        }
        lines.push(`  br label %${skipEntryLabel}`);
        lines.push(`${skipEntryLabel}:`);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopEnd}:`);
      }
      lines.push(`  call void @free(ptr ${hmDataPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "enum" && this.droppableEnums.has(typeKind.name)) {
      const helperName = `milo.drop.${typeKind.name}`;
      this.ensureDropHelper(typeKind.name);
      const val = this.nextTemp();
      lines.push(`  ${val} = load %${typeKind.name}, ptr ${allocaPtr}`);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = alloca %${typeKind.name}`);
      lines.push(`  store %${typeKind.name} ${val}, ptr ${tmp}`);
      lines.push(`  call void @${helperName}(ptr ${tmp})`);
    }
    if (typeKind.tag === "array" && typeKind.size !== null && this.needsDropCg(typeKind.element)) {
      const elemTy = this.llvmType(typeKind.element);
      for (let i = 0; i < typeKind.size; i++) {
        const arrTy = `[${typeKind.size} x ${elemTy}]`;
        const elemPtr = this.nextTemp();
        lines.push(`  ${elemPtr} = getelementptr ${arrTy}, ptr ${allocaPtr}, i32 0, i32 ${i}`);
        this.emitDropValue(lines, elemPtr, typeKind.element);
      }
    }
    if (typeKind.tag === "struct" && this.structNeedsDrop(typeKind.name)) {
      this.ensureStructDropHelper(typeKind.name);
      const helperName = `milo.drop.struct.${typeKind.name}`;
      lines.push(`  call void @${helperName}(ptr ${allocaPtr})`);
    }
  }

  private ensureDropHelper(enumName: string) {
    if (this.generatedDropHelpers.has(enumName)) return;
    this.generatedDropHelpers.add(enumName);

    const layout = must(this.enumLayouts, enumName, "enum layouts");
    const enumTy = `%${enumName}`;
    const helperName = `milo.drop.${enumName}`;
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;

    const body: string[] = [];
    body.push(`define void @${helperName}(ptr %self) {`);
    body.push("entry.bb:");
    const tagPtr = this.nextTemp();
    body.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr %self, i32 0, i32 0`);
    const tag = this.nextTemp();
    body.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const doneLabel = this.nextLabel("drop.done");
    const cases: string[] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      const hasDroppable = variant.fieldTypeKinds.some(f => this.needsDropCg(f));
      if (!hasDroppable) continue;

      const label = this.nextLabel(`drop.${vName}`);
      cases.push(`    i32 ${variant.tag}, label %${label}`);

      const vLines: string[] = [];
      vLines.push(`${label}:`);
      const payloadPtr = this.nextTemp();
      vLines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr %self, i32 0, i32 1`);

      if (variant.fieldTypes.length === 1) {
        if (this.needsDropCg(variant.fieldTypeKinds[0])) {
          this.emitDropValue(vLines, payloadPtr, variant.fieldTypeKinds[0]);
        }
      } else {
        const structTy = `{ ${variant.fieldTypes.join(", ")} }`;
        for (let i = 0; i < variant.fieldTypes.length; i++) {
          if (!this.needsDropCg(variant.fieldTypeKinds[i])) continue;
          const fieldPtr = this.nextTemp();
          vLines.push(`  ${fieldPtr} = getelementptr ${structTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
          this.emitDropValue(vLines, fieldPtr, variant.fieldTypeKinds[i]);
        }
      }
      vLines.push(`  br label %${doneLabel}`);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      body.push(`  switch i32 ${tag}, label %${doneLabel} [`);
      for (const c of cases) body.push(c);
      body.push("  ]");
      for (const vb of variantBodies) body.push(...vb);
    }

    body.push(`${doneLabel}:`);
    body.push("  ret void");
    body.push("}");

    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
  }

  private generatedStructCloneHelpers = new Set<string>();

  private ensureStructCloneHelper(structName: string) {
    if (this.generatedStructCloneHelpers.has(structName)) return;
    this.generatedStructCloneHelpers.add(structName);

    const layout = must(this.structLayouts, structName, "struct layouts");
    const structTy = `%${structName}`;
    const helperName = `milo.clone.struct.${structName}`;
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;

    const body: string[] = [];
    body.push(`define void @${helperName}(ptr %src, ptr %dst) {`);
    body.push("entry.bb:");
    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const srcFieldPtr = this.nextTemp();
      body.push(`  ${srcFieldPtr} = getelementptr ${structTy}, ptr %src, i32 0, i32 ${i}`);
      const clonedField = this.emitDeepCloneFromPtr(body, srcFieldPtr, f.typeKind);
      const dstFieldPtr = this.nextTemp();
      body.push(`  ${dstFieldPtr} = getelementptr ${structTy}, ptr %dst, i32 0, i32 ${i}`);
      body.push(`  store ${f.type} ${clonedField}, ptr ${dstFieldPtr}`);
    }
    body.push("  ret void");
    body.push("}");

    this.hoistAllocas(body, 2); // see ensureEnumCloneHelper
    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
  }

  private ensureStructDropHelper(structName: string) {
    if (this.generatedStructDropHelpers.has(structName)) return;
    this.generatedStructDropHelpers.add(structName);

    const layout = must(this.structLayouts, structName, "struct layouts");
    const helperName = `milo.drop.struct.${structName}`;
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;

    const body: string[] = [];
    body.push(`define void @${helperName}(ptr %self) {`);
    body.push("entry.bb:");
    const skipLabel = this.nextLabel("struct.drop.skip");
    const dropLabel = this.nextLabel("struct.drop");
    // Sentinel test for "this struct was moved out of and zeroed". Heap types carry a
    // data pointer that is non-null while alive, so a null one suggests the bytes were
    // cleared.
    //
    // It must consult EVERY such field, not the first one. An empty container is
    // indistinguishable from a zeroed one by this test — `Vec.new()` that never grew has
    // a null data pointer and is perfectly alive — so keying on the first field alone
    // meant a struct whose first field happened to be an empty Vec skipped its whole
    // destructor, user `Drop` impl included, and silently never cleaned up. A moved-from
    // struct has ALL of its bytes zeroed, so "every candidate is null" is the honest
    // reading of the same evidence and costs one compare per field.
    //
    // Residual, and it is a real hole rather than a rounding error: a struct whose only
    // droppable field is an empty container still cannot be told apart from a moved-from
    // one by value. Deciding that needs a liveness FLAG rather than a value probe — see
    // docs/plans/aliasing-coverage.md.
    // A heap field proves liveness by a non-null data pointer; an integer or bool field
    // proves it by being non-zero. Both are read from the same evidence — a moved-from
    // struct has every byte cleared — and together they cover far more shapes than the
    // pointer probe alone: `Res { id: 1, v: Vec.new() }` is alive on the strength of
    // `id`, which the pointer-only test could not see.
    const heapCandidates = layout.fields.flatMap((f, i) => {
      const t = f.typeKind.tag;
      return t === "string" || t === "vec" || t === "hashmap" || t === "heap" ? [{ i, ll: "ptr", zero: "null" }] : [];
    });
    // Scalars only AUGMENT a pointer probe; they never create one. A struct with no heap
    // field had no probe at all and was dropped unconditionally, which is correct — the
    // zeroed-ness of an integer says nothing about liveness on its own, and gating on it
    // silently skipped the destructor of every `Tracked { id: 0 }`
    // (tests/fixtures/dropAccounting.milo caught exactly that).
    const scalarCandidates = heapCandidates.length > 0
      ? layout.fields.flatMap((f, i) =>
          f.typeKind.tag === "int" || f.typeKind.tag === "bool" ? [{ i, ll: f.type, zero: "0" }] : [])
      : [];
    const candidates = [...heapCandidates, ...scalarCandidates];
    if (candidates.length > 0) {
      // alive = OR over the candidates; skip only when every one of them reads as zeroed.
      let alive: string | null = null;
      for (const c of candidates) {
        const fieldPtr = this.nextTemp();
        body.push(`  ${fieldPtr} = getelementptr %${structName}, ptr %self, i32 0, i32 ${c.i}`);
        const probe = this.nextTemp();
        body.push(`  ${probe} = load ${c.ll}, ptr ${fieldPtr}`);
        const nonZero = this.nextTemp();
        body.push(`  ${nonZero} = icmp ne ${c.ll} ${probe}, ${c.zero}`);
        if (alive === null) {
          alive = nonZero;
        } else {
          const merged = this.nextTemp();
          body.push(`  ${merged} = or i1 ${alive}, ${nonZero}`);
          alive = merged;
        }
      }
      body.push(`  br i1 ${alive}, label %${dropLabel}, label %${skipLabel}`);
    } else {
      body.push(`  br label %${dropLabel}`);
    }
    body.push(`${dropLabel}:`);
    if (this.dropImpls.has(structName)) {
      const mangledDrop = `${structName}$Drop$drop`;
      body.push(`  call void @${mangledDrop}(ptr %self)`);
    }
    for (let i = layout.fields.length - 1; i >= 0; i--) {
      const field = layout.fields[i];
      if (this.needsDropCg(field.typeKind)) {
        const fieldPtr = this.nextTemp();
        body.push(`  ${fieldPtr} = getelementptr %${structName}, ptr %self, i32 0, i32 ${i}`);
        this.emitDropValue(body, fieldPtr, field.typeKind);
      }
    }
    body.push(`  br label %${skipLabel}`);
    body.push(`${skipLabel}:`);
    body.push("  ret void");
    body.push("}");

    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
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
    const someTagPtr = this.nextTemp();
    lines.push(`  ${someTagPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 0`);
    lines.push(`  store i32 ${someTag}, ptr ${someTagPtr}`);
    const somePayloadPtr = this.nextTemp();
    lines.push(`  ${somePayloadPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 1`);
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
    const noneTagPtr = this.nextTemp();
    lines.push(`  ${noneTagPtr} = getelementptr ${optionTy}, ptr ${noneAlloca}, i32 0, i32 0`);
    lines.push(`  store i32 ${noneTag}, ptr ${noneTagPtr}`);
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
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);
    const isSome = this.nextTemp();
    lines.push(`  ${isSome} = icmp eq i32 ${tag}, 0`);
    if (expr.op === "isSome") return [lines, isSome, "i1"];
    if (expr.op === "isNone") {
      const r = this.nextTemp();
      lines.push(`  ${r} = xor i1 ${isSome}, true`);
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
        const srcPayloadPtr = this.nextTemp();
        lines.push(`  ${srcPayloadPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 1`);
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
          const someTagPtr = this.nextTemp();
          lines.push(`  ${someTagPtr} = getelementptr ${resTy}, ptr ${resAddr}, i32 0, i32 0`);
          lines.push(`  store i32 ${resSome.tag}, ptr ${someTagPtr}`);
          const resPayloadPtr = this.nextTemp();
          lines.push(`  ${resPayloadPtr} = getelementptr ${resTy}, ptr ${resAddr}, i32 0, i32 1`);
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
        const noneTagPtr = this.nextTemp();
        lines.push(`  ${noneTagPtr} = getelementptr ${resTy}, ptr ${resAddr}, i32 0, i32 0`);
        lines.push(`  store i32 ${resNone.tag}, ptr ${noneTagPtr}`);
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
      return [lines, out, resTy];
    }

    // Result map/mapErr/andThen/orElse. Unlike Option.map, the branch that does NOT run the
    // callback still carries a payload, and it must be copied from the source enum into the
    // result enum — skipping it leaves the zeroinitializer, i.e. `map` over an Err would
    // silently produce a zeroed error value instead of the real one.
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
      const srcPayload = (): string => {
        const p = this.nextTemp();
        lines.push(`  ${p} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 1`);
        return p;
      };
      const callArgOf = (srcFieldTy: string): [string, string] => {
        const p = srcPayload();
        if (paramIsRef) return [p, "ptr"];
        const loaded = this.nextTemp();
        lines.push(`  ${loaded} = load ${srcFieldTy}, ptr ${p}`);
        return [loaded, srcFieldTy];
      };
      const storeTag = (tag: number) => {
        const tp = this.nextTemp();
        lines.push(`  ${tp} = getelementptr ${resTy}, ptr ${resAddr}, i32 0, i32 0`);
        lines.push(`  store i32 ${tag}, ptr ${tp}`);
      };
      const storePayload = (ty: string, val: string) => {
        const pp = this.nextTemp();
        lines.push(`  ${pp} = getelementptr ${resTy}, ptr ${resAddr}, i32 0, i32 1`);
        lines.push(`  store ${ty} ${val}, ptr ${pp}`);
      };
      // forward the untouched side's payload verbatim; the result variant's slot is at least
      // as wide because that side's type is unchanged
      const copyThrough = (srcFieldTy: string | undefined, tag: number) => {
        storeTag(tag);
        if (!srcFieldTy) return;
        const p = srcPayload();
        const v = this.nextTemp();
        lines.push(`  ${v} = load ${srcFieldTy}, ptr ${p}`);
        storePayload(srcFieldTy, v);
      };

      lines.push(`${okLabel}:`);
      if (expr.op === "resultMapErr" || expr.op === "resultOrElse") {
        copyThrough(srcOk.fieldTypes[0], resOk.tag);
      } else if (expr.op === "resultAndThen") {
        // the callback already returns the whole Result — store it wholesale, no re-tagging
        const [arg, argTy] = callArgOf(srcOk.fieldTypes[0] ?? "i64");
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
      } else {
        const [arg, argTy] = callArgOf(srcOk.fieldTypes[0] ?? "i64");
        const outTy = resOk.fieldTypes[0] ?? "i64";
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${outTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        // The callback only BORROWED the Ok payload (`&T`), `map` consumed the receiver, and
        // the result carries a different payload type — so after this call nothing in the
        // program still refers to the old payload and nothing would ever free it.
        // `Result<string,_>.map(v => v.len)` leaked its string every time. It stayed
        // invisible because the leak gate measures at -O2, where LLVM deletes an allocation
        // nothing observes; at -O0 it was always there.
        if (paramIsRef) {
          const first = cbType.tag === "fn" ? cbType.params[0] : undefined;
          const inner = first && first.tag === "ref" ? first.inner : undefined;
          if (inner && this.needsDropCg(inner)) this.emitDropValue(lines, arg, inner);
        }
        storeTag(resOk.tag);
        storePayload(outTy, called);
      }
      lines.push(`  br label %${contLabel}`);

      lines.push(`${errLabel}:`);
      if (expr.op === "resultMapErr") {
        const [arg, argTy] = callArgOf(srcErr.fieldTypes[0] ?? "i64");
        const outTy = resErr.fieldTypes[0] ?? "i64";
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${outTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        storeTag(resErr.tag);
        storePayload(outTy, called);
      } else if (expr.op === "resultOrElse") {
        // mirror of andThen on the other side: the callback returns the whole Result
        const [arg, argTy] = callArgOf(srcErr.fieldTypes[0] ?? "i64");
        const called = this.nextTemp();
        lines.push(`  ${called} = call ${resTy} ${fnPtr}(ptr ${envPtr}, ${argTy} ${arg})`);
        lines.push(`  store ${resTy} ${called}, ptr ${resAddr}`);
      } else {
        copyThrough(srcErr.fieldTypes[0], resErr.tag);
      }
      lines.push(`  br label %${contLabel}`);

      lines.push(`${contLabel}:`);
      const out = this.nextTemp();
      lines.push(`  ${out} = load ${resTy}, ptr ${resAddr}`);
      return [lines, out, resTy];
    }

    // unwrapOr / unwrapOrElse
    const payloadTy = this.llvmType(expr.type);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${addr}, i32 0, i32 1`);
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
      // Result's version is handed the error, so it reads the Err payload out of the
      // same slot the Ok payload came from — by pointer when the param is `&E`.
      let errArgs = "";
      if (expr.op === "resultUnwrapOrElse") {
        const srcErr = this.enumLayouts.get(expr.enumName)?.variants.get("Err");
        const cbType = expr.default!.type;
        const paramIsRef = cbType.tag === "fn" && cbType.params.length > 0 && cbType.params[0].tag === "ref";
        if (paramIsRef) {
          errArgs = `, ptr ${payloadPtr}`;
        } else {
          const srcErrTy = srcErr?.fieldTypes[0] ?? "i64";
          const loaded = this.nextTemp();
          lines.push(`  ${loaded} = load ${srcErrTy}, ptr ${payloadPtr}`);
          errArgs = `, ${srcErrTy} ${loaded}`;
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
      return [lines, r, payloadTy];
    }

    const [dl, dv] = this.genExpr(expr.default!);
    lines.push(...dl);
    const r = this.nextTemp();
    lines.push(`  ${r} = select i1 ${isSome}, ${payloadTy} ${payload}, ${payloadTy} ${dv}`);
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
        if (!layout) return null;
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
    if (g.value?.kind !== "StructLit") return false;
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
    if (!value || value.kind !== "StructLit" || type.tag !== "struct") return null;
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

  private emitLoopDropGlue(lines: string[]) {
    for (let i = this.droppableLocals.length - 1; i >= this.loopDropStart; i--) {
      this.emitGuardedDrop(lines, this.droppableLocals[i]);
    }
  }

  private emitGuardedDrop(lines: string[], local: { name: string; typeKind: TypeKind; aliveFlag: string; addr: string }) {
    const check = this.nextTemp();
    lines.push(`  ${check} = load i1, ptr ${local.aliveFlag}`);
    const dropLabel = this.nextLabel("drop.alive");
    const skipLabel = this.nextLabel("drop.skip");
    lines.push(`  br i1 ${check}, label %${dropLabel}, label %${skipLabel}`);
    lines.push(`${dropLabel}:`);
    this.emitDropValue(lines, local.addr, local.typeKind);
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
