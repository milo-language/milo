import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern, HIRContract } from "./hir";
import { type TypeKind, needsDrop } from "./types";
import type { TargetInfo } from "./target";
import { genVecSort, genVecSortBy, genVecSortByKey } from "./codegen-vec";
import { classifyArg, classifyRet, AbiError, type ArgClass, type RetClass, type AbiStruct, type AbiLeaf } from "./abi";
import { resolve, dirname, basename } from "path";

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

export class Codegen {
  private target: TargetInfo;
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, { type: string; typeKind: TypeKind; mutable: boolean; isRef: boolean; addr?: string }>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>();
  // extern fns that pass/return a struct by value need native-ABI lowering (byval/sret/coerce)
  private externAbi = new Map<string, ExternAbiInfo>();
  private structLayouts = new Map<string, StructLayout>();
  private enumLayouts = new Map<string, EnumLayout>();
  private userDeclaredFns = new Set<string>();
  private needsBoundsCheck = false;
  private needsOverflowCheck = false;
  private needsRangeCheck = false;
  private needsContractCheck = false;
  // ensures clauses of the function being generated; checked at every return site
  private currentEnsures: HIRContract[] = [];
  private debugOverflow = false;
  private usedOverflowIntrinsics = new Set<string>();
  private needsPrintf = false;
  private needsDprintf = false;
  private needsFflush = false;
  private needsPutchar = false;
  private needsExit = false;
  private needsMalloc = false;
  private needsFree = false;
  private needsMemcpy = false;
  private needsStrlen = false;
  private needsMemcmp = false;
  private needsPthread = false;
  private parallelCounter = 0;
  private hasStringType = false;
  private hasVecType = false;
  private hasHashMapType = false;
  private needsGetentropy = false;
  private needsStrtod = false;
  private loopHeader: string | null = null;
  private loopExit: string | null = null;
  private loopDropStart: number = 0;
  private globalVars = new Map<string, { type: string; typeKind: TypeKind }>();
  private userFnNames = new Set<string>();
  private droppableLocals: { name: string; typeKind: TypeKind; aliveFlag: string }[] = [];
  private droppableEnums = new Set<string>();
  private dropImpls = new Set<string>();
  private structDropCache = new Map<string, boolean>();
  private generatedDropHelpers = new Set<string>();
  private generatedJsonEscapeHelper = false;
  private generatedStructDropHelpers = new Set<string>();
  private dropHelperBodies: string[][] = [];
  private closureBodies: string[][] = [];
  private closureCounter = 0;
  private scopeCounter = 0;
  private entryAllocas: string[] = [];
  private static BUILTINS = new Set(["print", "eprint", "format", "flush", "exit", "assert", "max", "min", "_miloArgCount", "_miloArgAt", "_cstrToString", "_strDataPtr", "_loadU8", "_loadI32", "_callClosureVoid", "_atomicLoadI64", "_atomicStoreI64", "_atomicAddI64", "_atomicSubI64", "_atomicCasI64", "_atomicLoadBool", "_atomicStoreBool", "_atomicSwapBool", "_schedulerGet", "_schedulerSet"]);
  private needsArgGlobals = false;
  private usesSchedulerGlobal = false;
  private currentFnName = "";
  private itableLayouts = new Map<string, { globalName: string; methodCount: number }>();

  private filePath?: string;

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
  private currentSubprogramId: number | null = null;
  private currentSubprogramFileId = 0;
  private usedDbgDeclare = false;
  private diTypes = new Map<string, number>();

  constructor(target: TargetInfo, filePath?: string, debugOverflow = false, emitDebug = false) {
    this.target = target;
    this.filePath = filePath;
    this.debugOverflow = debugOverflow;
    this.emitDebug = emitDebug;
  }

  private diEsc(s: string): string { return s.replace(/\\/g, "\\5C").replace(/"/g, "\\22"); }

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
    this.diNodes.push(`!${id} = distinct !DISubprogram(name: "${this.diEsc(fn.name)}", scope: !${fileId}, file: !${fileId}, line: ${line}, type: !${subT}, scopeLine: ${line}, spFlags: DISPFlagDefinition, unit: !${cu})`);
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
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diEsc(name)}", size: ${totBits}, elements: !${tuple})`);
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
        id = this.diComposite("HashMap", ["ptr", "i64", "i64", "i64"], ["entries", "cap", "len", "tombstones"],
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
        // {i32 tag, [N x i64] payload} — debuggers show the raw tag + payload bytes.
        // A proper DW_TAG_variant_part (pretty Rust-style enums) is deferred.
        const fields = layout.payloadSlots > 0 ? ["i32", `[${layout.payloadSlots} x i64]`] : ["i32"];
        const names = layout.payloadSlots > 0 ? ["tag", "payload"] : ["tag"];
        const kinds: TypeKind[] = layout.payloadSlots > 0
          ? [{ tag: "int", bits: 32, signed: true }, { tag: "array", element: { tag: "int", bits: 64, signed: true }, size: layout.payloadSlots }]
          : [{ tag: "int", bits: 32, signed: true }];
        id = this.diComposite(t.name, fields, names, kinds, key);
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

  private nextTemp(): string { return `%t${this.tempCounter++}`; }
  private nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
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

  private llvmType(t: TypeKind): string {
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
        return "ptr";
      case "interface": return "{ ptr, ptr }";
      case "struct": return `%${t.name}`;
      case "enum":   return `%${t.name}`;
      case "fn":     return "{ ptr, ptr }";
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

  private addString(value: string): { label: string; length: number } {
    const label = `@.str.${this.strCounter++}`;
    let escaped = "";
    let byteLen = 0;
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (code >= 0xF780 && code <= 0xF7FF) {
        // PUA sentinel from \xNN escape — emit as raw single byte
        const byte = code - 0xF700;
        escaped += `\\${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        byteLen += 1;
      } else {
        switch (code) {
          case 0x5C: escaped += "\\5C"; byteLen += 1; break;
          case 0x0A: escaped += "\\0A"; byteLen += 1; break;
          case 0x0D: escaped += "\\0D"; byteLen += 1; break;
          case 0x09: escaped += "\\09"; byteLen += 1; break;
          case 0x00: escaped += "\\00"; byteLen += 1; break;
          case 0x22: escaped += "\\22"; byteLen += 1; break;
          default: escaped += ch; byteLen += Buffer.byteLength(ch, "utf-8");
        }
      }
    }
    byteLen += 1; // null terminator
    this.strings.push({ label, escaped, length: byteLen });
    return { label, length: byteLen };
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
    if (ty === "%HashMap") return 32; // ptr + i64 + i64 + i64
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return parseInt(arrMatch[1]) * this.typeSize(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structPayloadSize(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = this.enumLayouts.get(enumMatch[1])!;
      // i64 payload array requires 8-byte alignment, so the i32 tag is padded to 8.
      // Without this, malloc undersizes by 4 bytes and store %Enum overruns the buffer.
      return layout.payloadSlots > 0 ? 8 + layout.payloadSlots * 8 : 4;
    }
    return 8;
  }

  private typeSizeOf(t: TypeKind): number {
    return this.typeSize(this.llvmType(t));
  }

  // Zero `ptr` as type `ty`. For large aggregates, emit llvm.memset instead of a
  // first-class `store [N x i8] zeroinitializer` — clang's InstCombine is
  // superlinear on big aggregate zero-stores (a 64KB stack buffer alone pushed
  // an -O2 build to ~110s; memset drops it to ~1s). LLVM auto-recognizes the
  // intrinsic, so no `declare` is needed. memset is never worse, so the
  // threshold only needs to sit below the first painful size.
  private static ZERO_STORE_MEMSET_THRESHOLD = 128;
  private zeroStore(ty: string, ptr: string): string {
    const size = this.typeSize(ty);
    if (size >= Codegen.ZERO_STORE_MEMSET_THRESHOLD) {
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

  private needsDropCg(t: TypeKind): boolean {
    if (needsDrop(t)) return true;
    if (t.tag === "enum") return this.droppableEnums.has(t.name);
    if (t.tag === "struct") return this.structNeedsDrop(t.name);
    if (t.tag === "array" && t.size !== null) return this.needsDropCg(t.element);
    return false;
  }

  private structNeedsDrop(name: string): boolean {
    if (this.structDropCache.has(name)) return this.structDropCache.get(name)!;
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

  private needsPanicFmt = false;

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
      const layout = this.enumLayouts.get(enumMatch[1])!;
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
    const layout = this.structLayouts.get(name)!;
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
    const layout = this.structLayouts.get(name)!;
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
    const abi = this.externAbi.get(name)!;
    const sig = this.fnSigs.get(name)!;
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
  private emitExternAbiCall(expr: HIRExpr & { kind: "Call" }, argVals: { val: string; type: string }[], lines: string[]): [string[], string, string] {
    const abi = this.externAbi.get(expr.func)!;
    const sig = this.fnSigs.get(expr.func)!;
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

  generate(module: HIRModule): string {
    // register struct layouts
    for (const s of module.structs) {
      const layout: StructLayout = {
        name: s.name,
        fields: s.fields.map(f => ({ name: f.name, type: this.llvmType(f.type), typeKind: f.type })),
      };
      this.structLayouts.set(s.name, layout);
    }

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
        const layout = this.enumLayouts.get(e.name)!;
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
                ? classifyArg(this.target.arch, this.abiStructOf((p.type as any).name))
                : null);
            const ret: RetClass = byValStruct(fn.retType, false)
              ? classifyRet(this.target.arch, this.abiStructOf((fn.retType as any).name))
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

    // register globals before function generation so they're visible during codegen
    for (const g of module.globals) {
      const ty = this.llvmType(g.type);
      this.globalVars.set(g.name, { type: ty, typeKind: g.type });
    }

    // generate function bodies first (collects string constants, sets needsBoundsCheck)
    const fnBodies: string[][] = [];
    for (const fn of functions) fnBodies.push(this.genFunction(fn));

    // auto-declare C functions needed by built-ins and bounds checks
    const declaredExterns = new Set(externs.map(e => e.name));
    if (this.needsBoundsCheck) { this.needsPrintf = true; this.needsExit = true; }
    if (this.needsOverflowCheck) { this.needsPrintf = true; this.needsExit = true; }
    if (this.needsSnprintf && !declaredExterns.has("snprintf"))
      this.output.splice(1, 0, "declare i32 @snprintf(ptr, i64, ptr, ...)");
    if (this.needsStrtod && !declaredExterns.has("strtod"))
      this.output.splice(1, 0, "declare double @strtod(ptr, ptr)");
    if (this.needsMemset && !declaredExterns.has("memset"))
      this.output.splice(1, 0, "declare ptr @memset(ptr, i32, i64)");
    if (this.needsGetentropy && !declaredExterns.has("getentropy"))
      this.output.splice(1, 0, "declare i32 @getentropy(ptr, i64)");
    if (this.needsPthread) {
      if (!declaredExterns.has("pthread_join"))
        this.output.splice(1, 0, "declare i32 @pthread_join(i64, ptr)");
      if (!declaredExterns.has("pthread_create"))
        this.output.splice(1, 0, "declare i32 @pthread_create(ptr, ptr, ptr, ptr)");
      this.needsMalloc = true;
      this.needsFree = true;
    }
    if (this.needsMemcmp && !declaredExterns.has("memcmp"))
      this.output.splice(1, 0, "declare i32 @memcmp(ptr, ptr, i64)");
    if (this.needsStrlen && !declaredExterns.has("strlen"))
      this.output.splice(1, 0, "declare i64 @strlen(ptr)");
    if (this.needsMemcpy && !declaredExterns.has("memcpy"))
      this.output.splice(1, 0, "declare ptr @memcpy(ptr, ptr, i64)");
    if (this.needsFree && !declaredExterns.has("free"))
      this.output.splice(1, 0, "declare void @free(ptr)");
    if (this.needsMalloc && !declaredExterns.has("malloc"))
      this.output.splice(1, 0, "declare ptr @malloc(i64)");
    if (this.needsExit && !declaredExterns.has("exit"))
      this.output.splice(1, 0, "declare void @exit(i32) noreturn");
    if (this.usesSchedulerGlobal && !declaredExterns.has("_exit"))
      this.output.splice(1, 0, "declare void @_exit(i32) noreturn");
    if (this.needsPutchar && !declaredExterns.has("putchar"))
      this.output.splice(1, 0, "declare i32 @putchar(i32)");
    if (this.needsFflush && !declaredExterns.has("fflush"))
      this.output.splice(1, 0, `declare i32 @fflush(ptr)`);
    if (this.needsDprintf && !declaredExterns.has("dprintf"))
      this.output.splice(1, 0, `declare i32 @dprintf(i32, ptr, ...)`);
    if (this.needsPrintf && !declaredExterns.has("printf"))
      this.output.splice(1, 0, `declare i32 @printf(ptr, ...)`);
    if (this.usedDbgDeclare)
      this.output.splice(1, 0, `declare void @llvm.dbg.declare(metadata, metadata, metadata)`);
    if (this.needsBoundsCheck)
      this.output.splice(1, 0, `@.bounds_err = private unnamed_addr constant [40 x i8] c"milo: array index out of bounds: %d/%d\\0A\\00"`);
    if (this.needsOverflowCheck || this.needsRangeCheck || this.needsContractCheck) {
      const file = this.filePath ?? "<unknown>";
      this.output.splice(1, 0, `@.overflow_file = private unnamed_addr constant [${file.length + 1} x i8] c"${file}\\00"`);
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
    if (this.hasHashMapType)
      this.output.splice(1, 0, `%HashMap = type { ptr, i64, i64, i64 }`);
    if (this.hasVecType)
      this.output.splice(1, 0, `%Vec = type { ptr, i64, i64 }`);
    if (this.hasStringType)
      this.output.splice(1, 0, `%String = type { ptr, i64, i64 }`);

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
      const ptrs = itable.methods.map(m => `ptr @${m}`).join(", ");
      const structTy = `{ ${itable.methods.map(() => "ptr").join(", ")} }`;
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

    // insert extern declarations
    for (const ext of externs) {
      const sig = this.fnSigs.get(ext.name)!;
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

    // append function bodies
    for (const body of fnBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // append drop helper functions
    for (const body of this.dropHelperBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // append closure function bodies
    for (const body of this.closureBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    if (this.emitDebug) this.applyDebugInfo();

    return this.output.join("\n") + "\n";
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
    this.currentFnName = fn.name;
    const lines: string[] = [];

    const params = fn.params.map(p => {
      const lt = p.isRef || p.isRefMut ? "ptr" : this.llvmType(p.type);
      return `${lt} %${p.name}`;
    }).join(", ");
    // main is the process entry point: the OS reads its return register as the exit code, so it
    // must always be i32 even when the Milo signature is void (`fn main()`). A `void @main` leaves
    // garbage in the return register → nonzero exit on a program that should succeed.
    const ret = fn.name === "main" ? "i32" : this.llvmType(fn.retType);
    // Subprogram attaches BEFORE the `{`; applyDebugInfo keys function boundaries off this.
    const dbgAttr = this.emitDebug ? ` !dbg !${this.diSubprogram(fn)}` : "";
    if (this.emitDebug) {
      this.currentSubprogramId = this.diSubprogram(fn);
      this.currentSubprogramFileId = this.diFile(fn.sourceFile ?? this.filePath ?? "<unknown>");
    }
    if (fn.name === "main") {
      const mainParams = params ? `i32 %_milo_argc, ptr %_milo_argv, ${params}` : "i32 %_milo_argc, ptr %_milo_argv";
      lines.push(`define ${ret} @${fn.name}(${mainParams})${dbgAttr} {`);
    } else {
      // Non-root fns are internal (like globals): each object carries its own copy.
      // linkonce_odr let the linker merge same-named fns across separately-compiled
      // objects and silently pick one body when they differed (issue #5).
      const linkage = this.userFnNames.has(fn.name) ? "" : "internal ";
      lines.push(`define ${linkage}${ret} @${fn.name}(${params})${dbgAttr} {`);
    }
    // Dotted label, not bare `entry`: LLVM shares one symbol table for block
    // labels and local values, and params are emitted as `%<name>`. A param named
    // `entry` (a legal Milo identifier) would otherwise collide with the entry
    // block. A `.` can't appear in a Milo identifier, so `entry.bb` never clashes.
    lines.push("entry.bb:");
    if (fn.name === "main") {
      lines.push("  store i32 %_milo_argc, ptr @_milo_argc_global");
      lines.push("  store ptr %_milo_argv, ptr @_milo_argv_global");
    }

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
          this.droppableLocals.push({ name: p.name, typeKind: p.type, aliveFlag });
        }
      }
    }

    const allocaInsertPoint = lines.length;

    this.currentEnsures = [];
    if (this.debugOverflow && fn.contracts) {
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
        this.emitContractCheck(lines, condVal, "requires", c.span?.line ?? 0);
      }
    }

    let hasTerminator = false;
    for (const stmt of fn.body) {
      const [stmtLines, terminated] = this.genStmt(stmt);
      lines.push(...stmtLines);
      if (terminated) hasTerminator = true;
    }

    if (!hasTerminator) {
      // fall-off end is only reachable in void fns (and main's implicit 0), so no `result` binding
      this.emitEnsuresChecks(lines);
      this.emitDropGlue(lines);
      // Go exit semantics: when main returns the process exits and any
      // outstanding green tasks die. Waiting is explicit (Task.join/WaitGroup).
      if (ret === "void") lines.push("  ret void");
      else if (ret === "i32") lines.push("  ret i32 0");
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
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        // For `&T` locals (slices), store the inner value directly. The ref-ness is
        // a compile-time concept (enforces no-escape). At runtime it's a non-owning
        // %String (cap=0) or similar — no pointer indirection needed.
        const isRefLocal = stmt.type.tag === "ref";
        const storedTypeKind = isRefLocal ? (stmt.type as Extract<TypeKind, {tag: "ref"}>).inner : stmt.type;
        const declTy = this.llvmType(storedTypeKind);
        const addrName = this.locals.has(stmt.name) ? `%${stmt.name}.${this.scopeCounter++}.addr` : `%${stmt.name}.addr`;
        this.locals.set(stmt.name, { type: declTy, typeKind: stmt.type, mutable: stmt.mutable, isRef: false, addr: addrName });
        this.entryAllocas.push(`  ${addrName} = alloca ${declTy}`);
        // Zero-init droppable allocas so a drop-glue pass over a never-initialized
        // branch-local (e.g. `let s` inside an `if` that wasn't taken) reads cap=0 and skips free.
        if (this.needsDropCg(stmt.type)) {
          this.entryAllocas.push(this.zeroStore(declTy, addrName));
          // Drop old value before overwriting — needed when this decl is inside a loop
          // and runs multiple times at runtime. The zero-init above makes the first-iteration
          // drop a no-op (null ptr / zero cap guards skip the free).
          if (this.loopHeader !== null) {
            this.emitDropValue(lines, addrName, stmt.type);
          }
        }
        lines.push(this.valStore(declTy, val, addrName));
        // Describe the value actually stored: for `&T` locals that's the inner value.
        this.dbgDeclare(lines, stmt.name, addrName, storedTypeKind, stmt.span?.line ?? 0, 0);
        if (stmt.rangeCheck) {
          const signed = stmt.type.tag === "int" && stmt.type.signed;
          this.emitRangeCheck(lines, val, declTy, signed, stmt.rangeCheck.min, stmt.rangeCheck.max, stmt.span?.line ?? 0);
        }
        // Don't drop locals that borrow from a ref (shallow copy, data owned elsewhere)
        const isBorrowedInit = stmt.value.kind === "IndexAccess" && stmt.value.isBorrowed;
        if (!isRefLocal && this.needsDropCg(stmt.type) && !isBorrowedInit) {
          const aliveFlag = `${addrName}.alive`;
          this.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
          this.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
          lines.push(`  store i1 1, ptr ${aliveFlag}`);
          this.droppableLocals.push({ name: stmt.name, typeKind: stmt.type, aliveFlag });
        }
        return [lines, false];
      }
      case "Assign": {
        // Optimization: `x = x + rhs` for strings → in-place append (amortized O(1)).
        // The naive path allocates a fresh String each time which makes accumulation O(n^2).
        if (
          stmt.target.kind === "Ident" &&
          stmt.target.type.tag === "string" &&
          stmt.value.kind === "BinOp" &&
          stmt.value.op === "+" &&
          stmt.value.left.kind === "Ident" &&
          stmt.value.left.name === stmt.target.name &&
          // Bail on `x = x + x` — overlapping memcpy is unsafe; let the slow path handle it.
          !(stmt.value.right.kind === "Ident" && stmt.value.right.name === stmt.target.name)
        ) {
          const [rhsLines, rhsVal] = this.genExpr(stmt.value.right);
          lines.push(...rhsLines);
          const [tgtLines, tgtPtr] = this.genLValue(stmt.target);
          lines.push(...tgtLines);
          this.emitStringAppendInPlace(lines, tgtPtr, rhsVal);
          return [lines, false];
        }
        const [valLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...valLines);
        const [targetLines, targetPtr, targetTy] = this.genLValue(stmt.target);
        lines.push(...targetLines);
        if (stmt.target.kind === "Ident" && this.needsDropCg(stmt.target.type)) {
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
        const [exprLines] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        return [lines, false];
      }
      case "Match":
        return this.genMatch(stmt);
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
      case "Parallel":
        return this.genParallel(stmt);
    }
  }

  private genLValue(expr: HIRExpr): [string[], string, string] {
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
        const layout = this.structLayouts.get(structName)!;
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
        const layout = this.structLayouts.get(structName)!;
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
      if (expr.object.type.tag === "vec") {
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

  private genBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    const [objLines, objPtr, objTy] = this.genLValue(expr.object);
    lines.push(...objLines);
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
      this.emitBoundsCheck(lines, idx32, String(size));
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${objTy}, ptr ${objPtr}, i32 0, i32 ${idx32}`);
      return [lines, ptr, elemTy];
    }
    return [lines, "null", "i32"];
  }

  private emitBoundsCheck(lines: string[], idx: string, size: string) {
    this.needsBoundsCheck = true;
    const cmpTmp = this.nextTemp();
    const okLabel = this.nextLabel("bounds.ok");
    const failLabel = this.nextLabel("bounds.fail");

    lines.push(`  ${cmpTmp} = icmp ult i32 ${idx}, ${size}`);
    lines.push(`  br i1 ${cmpTmp}, label %${okLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    const fmtPtr = this.nextTemp();
    lines.push(`  ${fmtPtr} = getelementptr [40 x i8], ptr @.bounds_err, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, i32 ${idx}, i32 ${size})`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private emitCheckedArith(lines: string[], op: string, unsigned: boolean, llType: string, lv: string, rv: string, line: number): string {
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
    const fmtPtr = this.nextTemp();
    lines.push(`  ${fmtPtr} = getelementptr [46 x i8], ptr @.overflow_err, i32 0, i32 0`);
    const filePtr = this.nextTemp();
    lines.push(`  ${filePtr} = getelementptr [${(this.filePath ?? "<unknown>").length + 1} x i8], ptr @.overflow_file, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, ptr ${filePtr}, i32 ${line})`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
    return val;
  }

  private emitRangeCheck(lines: string[], val: string, llType: string, signed: boolean, min: number, max: number, line: number) {
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
    const filePtr = this.nextTemp();
    lines.push(`  ${filePtr} = getelementptr [${(this.filePath ?? "<unknown>").length + 1} x i8], ptr @.overflow_file, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, ptr ${filePtr}, i32 ${line})`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private emitEnsuresChecks(lines: string[]) {
    for (const c of this.currentEnsures) {
      const [condLines, condVal] = this.genExpr(c.expr);
      lines.push(...condLines);
      this.emitContractCheck(lines, condVal, "ensures", c.span?.line ?? 0);
    }
  }

  private emitContractCheck(lines: string[], condVal: string, kind: "requires" | "ensures" | "invariant", line: number) {
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
    const filePtr = this.nextTemp();
    lines.push(`  ${filePtr} = getelementptr [${(this.filePath ?? "<unknown>").length + 1} x i8], ptr @.overflow_file, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, ptr ${kindPtr}, ptr ${filePtr}, i32 ${line})`);
    lines.push(`  call void @exit(i32 1)`);
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
    for (const s of stmt.thenBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) thenTerminated = true; }
    if (!thenTerminated) lines.push(`  br label %${endLabel}`);
    lines.push(`${elseLabel}:`);
    let elseTerminated = false;
    if (stmt.elseBody) { for (const s of stmt.elseBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) elseTerminated = true; } }
    if (!elseTerminated) lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    // when both arms return/diverge, the merge block is unreachable; LLVM still requires a terminator
    if (thenTerminated && elseTerminated) lines.push(`  unreachable`);
    return [lines, thenTerminated && elseTerminated];
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
    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    // invariant must hold before every condition eval: loop entry, each back-edge, and exit
    if (this.debugOverflow && stmt.invariants) {
      for (const inv of stmt.invariants) {
        const [invLines, invVal] = this.genExpr(inv.expr);
        lines.push(...invLines);
        this.emitContractCheck(lines, invVal, "invariant", inv.span?.line ?? 0);
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
    if (!bodyTerminated) lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart;
    return [lines, false];
  }

  private genParallel(stmt: HIRStmt & { kind: "Parallel" }): [string[], boolean] {
    this.needsPthread = true;
    const lines: string[] = [];
    const N = stmt.branches.length;
    const parId = this.parallelCounter++;

    const slotAddrs: string[] = [];
    const tidAddrs: string[] = [];
    const branchNames: string[] = [];

    for (let i = 0; i < N; i++) {
      const branch = stmt.branches[i];
      const resultTy = this.llvmType(branch.type);
      const captures = branch.captures;
      const branchFnName = `__parallel_${parId}_${i}`;
      branchNames.push(branchFnName);

      // env struct: { ptr result_slot, ...capture types... }
      const envFields = ["ptr", ...captures.map(c => this.llvmType(c.type))];
      const envStructTy = `{ ${envFields.join(", ")} }`;
      const envSize = this.structPayloadSize(envFields);

      // allocate result slot on caller's stack
      const slotAddr = `%__par_slot_${parId}_${i}`;
      this.entryAllocas.push(`  ${slotAddr} = alloca ${resultTy}`);
      slotAddrs.push(slotAddr);

      // allocate tid on caller's stack
      const tidAddr = `%__par_tid_${parId}_${i}`;
      this.entryAllocas.push(`  ${tidAddr} = alloca i64`);
      tidAddrs.push(tidAddr);

      // ── emit branch function ──
      const savedTemp = this.tempCounter;
      const savedLabel = this.labelCounter;
      const savedLocals = this.locals;
      const savedDroppable = this.droppableLocals;
      const savedLoopHeader = this.loopHeader;
      const savedLoopExit = this.loopExit;
      const savedEntryAllocas = this.entryAllocas;
      const savedEnsures = this.currentEnsures;
      this.tempCounter = 0;
      this.labelCounter = 0;
      this.locals = new Map();
      this.droppableLocals = [];
      this.entryAllocas = [];
      this.loopHeader = null;
      this.loopExit = null;
      // a Return inside the branch body must not assert the enclosing fn's ensures
      this.currentEnsures = [];

      const body: string[] = [];
      body.push(`define ptr @${branchFnName}(ptr %env) {`);
      body.push("entry.bb:");

      // load result slot pointer from env[0]
      const slotGep = this.nextTemp();
      body.push(`  ${slotGep} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 0`);
      const slotPtr = this.nextTemp();
      body.push(`  ${slotPtr} = load ptr, ptr ${slotGep}`);

      // load captures from env[1..N]
      for (let j = 0; j < captures.length; j++) {
        const cap = captures[j];
        const capTy = this.llvmType(cap.type);
        const gepPtr = this.nextTemp();
        body.push(`  ${gepPtr} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${j + 1}`);
        this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: false });
        body.push(`  %${cap.name}.addr = alloca ${capTy}`);
        const loaded = this.nextTemp();
        body.push(`  ${loaded} = load ${capTy}, ptr ${gepPtr}`);
        body.push(`  store ${capTy} ${loaded}, ptr %${cap.name}.addr`);
      }

      // evaluate branch expression
      const allocaInsertPt = body.length;
      const [exprLines, exprVal, exprTy] = this.genExpr(branch.expr);
      body.push(...exprLines);

      // store result into slot
      body.push(`  store ${exprTy} ${exprVal}, ptr ${slotPtr}`);

      // free env and return
      body.push(`  call void @free(ptr %env)`);
      body.push(`  ret ptr null`);
      if (this.entryAllocas.length > 0) {
        body.splice(allocaInsertPt, 0, ...this.entryAllocas);
      }
      this.hoistAllocas(body, allocaInsertPt);
      body.push("}");
      this.closureBodies.push(body);

      // restore codegen state
      this.tempCounter = savedTemp;
      this.labelCounter = savedLabel;
      this.locals = savedLocals;
      this.droppableLocals = savedDroppable;
      this.entryAllocas = savedEntryAllocas;
      this.loopHeader = savedLoopHeader;
      this.loopExit = savedLoopExit;
      this.currentEnsures = savedEnsures;

      // ── build env and spawn ──
      const envAddr = this.nextTemp();
      lines.push(`  ${envAddr} = call ptr @malloc(i64 ${Math.max(envSize, 8)})`);

      // store result slot pointer as env[0]
      const slotFieldGep = this.nextTemp();
      lines.push(`  ${slotFieldGep} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 0`);
      lines.push(`  store ptr ${slotAddr}, ptr ${slotFieldGep}`);

      // store captures as env[1..N]
      for (let j = 0; j < captures.length; j++) {
        const cap = captures[j];
        const capAddr = this.localAddr(cap.name);
        const local = this.locals.get(cap.name);
        const capTy = this.llvmType(cap.type);
        const gepSlot = this.nextTemp();
        lines.push(`  ${gepSlot} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 ${j + 1}`);
        if (local?.isRef) {
          const innerPtr = this.nextTemp();
          lines.push(`  ${innerPtr} = load ptr, ptr ${capAddr}`);
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${capTy}, ptr ${innerPtr}`);
          lines.push(`  store ${capTy} ${val}, ptr ${gepSlot}`);
        } else {
          const loaded = this.nextTemp();
          lines.push(`  ${loaded} = load ${capTy}, ptr ${capAddr}`);
          lines.push(`  store ${capTy} ${loaded}, ptr ${gepSlot}`);
        }
      }

      // pthread_create
      lines.push(`  call i32 @pthread_create(ptr ${tidAddr}, ptr null, ptr @${branchFnName}, ptr ${envAddr})`);
    }

    // join all threads
    for (let i = 0; i < N; i++) {
      const tid = this.nextTemp();
      lines.push(`  ${tid} = load i64, ptr ${tidAddrs[i]}`);
      lines.push(`  call i32 @pthread_join(i64 ${tid}, ptr null)`);
    }

    // load results into local variables
    for (let i = 0; i < N; i++) {
      const branch = stmt.branches[i];
      const resultTy = this.llvmType(branch.type);
      const varAddr = `%${branch.name}.addr`;
      this.entryAllocas.push(`  ${varAddr} = alloca ${resultTy}`);
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${resultTy}, ptr ${slotAddrs[i]}`);
      lines.push(`  store ${resultTy} ${loaded}, ptr ${varAddr}`);
      this.locals.set(branch.name, { type: resultTy, typeKind: branch.type, mutable: false, isRef: false });
    }

    return [lines, false];
  }

  private genForRange(stmt: HIRStmt & { kind: "ForRange" }): [string[], boolean] {
    const lines: string[] = [];
    const varTy = this.llvmType(stmt.varType);
    const addrName = this.locals.has(stmt.varName) ? `%${stmt.varName}.${this.scopeCounter++}.addr` : `%${stmt.varName}.addr`;
    this.entryAllocas.push(`  ${addrName} = alloca ${varTy}`);
    this.locals.set(stmt.varName, { type: varTy, typeKind: stmt.varType, mutable: false, isRef: false, addr: addrName });

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

    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const cur = this.nextTemp();
    lines.push(`  ${cur} = load ${varTy}, ptr ${addrName}`);
    const cmp = this.nextTemp();
    const signed = stmt.varType.tag === "int" && stmt.varType.signed;
    lines.push(`  ${cmp} = icmp ${signed ? "slt" : "ult"} ${varTy} ${cur}, ${finalEnd}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);

    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) lines.push(`  br label %${incrLabel}`);

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
    return [lines, false];
  }

  private genForEach(stmt: HIRStmt & { kind: "ForEach" }): [string[], boolean] {
    const lines: string[] = [];

    if (stmt.iterableKind === "vec") {
      // get pointer to the vec so we can extract data ptr and len
      const [iterLines, iterAddr, iterTy] = this.genLValue(stmt.iterable);
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
      const varAddr = this.locals.has(elemName) ? `%${elemName}.${this.scopeCounter++}.addr` : `%${elemName}.addr`;
      this.entryAllocas.push(`  ${varAddr} = alloca ptr`);
      this.locals.set(elemName, { type: elemTy, typeKind: elemTypeKind, mutable: false, isRef: true, addr: varAddr });
      if (stmt.varName2) {
        this.locals.set(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr });
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

      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) lines.push(`  br label %${incrLabel}`);

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
      return [lines, false];

    } else if (stmt.iterableKind === "string") {
      const [iterLines, iterAddr] = this.genLValue(stmt.iterable);
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
      const varAddr = this.locals.has(elemName2) ? `%${elemName2}.${this.scopeCounter++}.addr` : `%${elemName2}.addr`;
      this.entryAllocas.push(`  ${varAddr} = alloca i8`);
      this.locals.set(elemName2, { type: "i8", typeKind: { tag: "int", bits: 8, signed: false }, mutable: false, isRef: false, addr: varAddr });
      if (stmt.varName2) {
        this.locals.set(stmt.varName, { type: "i64", typeKind: { tag: "int", bits: 64, signed: true }, mutable: false, isRef: false, addr: idxAddr });
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

      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) lines.push(`  br label %${incrLabel}`);

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
      return [lines, false];

    } else if (stmt.iterableKind === "array") {
      const [iterLines, iterAddr, iterTy] = this.genLValue(stmt.iterable);
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
      const varAddr = this.locals.has(elemName3) ? `%${elemName3}.${this.scopeCounter++}.addr` : `%${elemName3}.addr`;
      this.entryAllocas.push(`  ${varAddr} = alloca ptr`);
      this.locals.set(elemName3, { type: elemTy, typeKind: elemTypeKind3, mutable: false, isRef: true, addr: varAddr });
      if (stmt.varName2) {
        this.locals.set(stmt.varName, { type: "i32", typeKind: { tag: "int", bits: 32, signed: true }, mutable: false, isRef: false, addr: idxAddr });
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

      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) lines.push(`  br label %${incrLabel}`);

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
      return [lines, false];

    } else {
      // hashmap iteration
      const [iterLines, iterAddr] = this.genLValue(stmt.iterable);
      lines.push(...iterLines);
      const dataPtr = this.nextTemp();
      const capPtr = this.nextTemp();
      const data = this.nextTemp();
      const cap = this.nextTemp();
      lines.push(`  ${dataPtr} = getelementptr %HashMap, ptr ${iterAddr}, i32 0, i32 0`);
      lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
      lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${iterAddr}, i32 0, i32 2`);
      lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

      const keyType = stmt.varType.tag === "ref" ? stmt.varType.inner : stmt.varType;
      const valType = stmt.varType2?.tag === "ref" ? stmt.varType2.inner : (stmt.varType2 ?? { tag: "void" as const });
      const entryTy = this.hashMapEntryType(keyType, valType);
      const keyTy = this.llvmType(keyType);
      const valTy = this.llvmType(valType);

      const idxAddr = `%__for_idx.${this.scopeCounter++}.addr`;
      this.entryAllocas.push(`  ${idxAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${idxAddr}`);

      const keyVarAddr = `%${stmt.varName}.addr`;
      this.entryAllocas.push(`  ${keyVarAddr} = alloca ptr`);
      this.locals.set(stmt.varName, { type: keyTy, typeKind: stmt.varType, mutable: false, isRef: true, addr: keyVarAddr });

      if (stmt.varName2 && stmt.varType2) {
        const valVarAddr = `%${stmt.varName2}.addr`;
        this.entryAllocas.push(`  ${valVarAddr} = alloca ptr`);
        this.locals.set(stmt.varName2, { type: valTy, typeKind: stmt.varType2, mutable: false, isRef: true, addr: valVarAddr });
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
        lines.push(`  store ptr ${valPtr}, ptr %${stmt.varName2}.addr`);
      }

      let bodyTerminated = false;
      for (const s of stmt.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { bodyTerminated = true; break; }
      }
      if (!bodyTerminated) lines.push(`  br label %${nextLabel}`);

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
      return [lines, false];
    }
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

    const someVariant = layout.variants.get("Some")!;
    const noneVariant = layout.variants.get("None")!;
    const elemTy = this.llvmType(stmt.varType);

    const varAddr = this.locals.has(stmt.varName)
      ? `%${stmt.varName}.${this.scopeCounter++}.addr`
      : `%${stmt.varName}.addr`;
    this.entryAllocas.push(`  ${varAddr} = alloca ${elemTy}`);
    this.locals.set(stmt.varName, { type: elemTy, typeKind: stmt.varType, mutable: false, isRef: false, addr: varAddr });

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

    // call next(&mut self)
    const result = this.nextTemp();
    lines.push(`  ${result} = call ${retTy} @${stmt.nextMethod}(ptr ${iterAddr})`);

    // stage enum to extract tag
    const stagePtr = this.nextTemp();
    this.entryAllocas.push(`  ${stagePtr} = alloca ${retTy}`);
    lines.push(`  store ${retTy} ${result}, ptr ${stagePtr}`);
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

    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    this.loopDropStart = prevDropStart;
    return [lines, false];
  }

  private genMatch(stmt: HIRStmt & { kind: "Match" }): [string[], boolean] {
    const hasLiteralPattern = stmt.arms.some(a => a.pattern.kind === "LiteralPattern");
    if (hasLiteralPattern) return this.genLiteralMatch(stmt);
    return this.genEnumMatch(stmt);
  }

  private genLiteralMatch(stmt: HIRStmt & { kind: "Match" }): [string[], boolean] {
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
      let armTerminated = false;
      for (const s of literalArms[i].arm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { armTerminated = true; break; }
      }
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
      let wcTerminated = false;
      for (const s of wildcardArm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { wcTerminated = true; break; }
      }
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

  private genEnumMatch(stmt: HIRStmt & { kind: "Match" }): [string[], boolean] {
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
      const local = this.locals.get(stmt.subject.name)!;
      subjAddr = this.localAddr(stmt.subject.name);
      subjTy = local.type;
    } else {
      const [subjLines, subjVal, subjTyL] = this.genExpr(stmt.subject);
      lines.push(...subjLines);
      subjAddr = this.nextTemp();
      subjTy = subjTyL;
      lines.push(`  ${subjAddr} = alloca ${subjTy}`);
      lines.push(`  store ${subjTy} ${subjVal}, ptr ${subjAddr}`);
    }

    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const layout = this.enumLayouts.get(stmt.enumName)!;
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
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
        const variant = layout.variants.get(arm.pattern.variant)!;
        this.extractBindings(lines, subjAddr, subjTy, variant, arm.pattern, !!stmt.subjectIsRef);
      }
      let armTerminated = false;
      for (const s of arm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { armTerminated = true; break; }
      }
      if (!armTerminated) lines.push(`  br label %${endLabel}`);
      if (!armTerminated) allArmsTerminated = false;
    }

    if (wildcardArm) {
      lines.push(`${defaultTarget}:`);
      let wcTerminated = false;
      for (const s of wildcardArm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { wcTerminated = true; break; }
      }
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

  private extractBindings(
    lines: string[], subjAddr: string, subjTy: string,
    variant: { tag: number; fieldTypes: string[] },
    pattern: HIRPattern & { kind: "EnumPattern" },
    subjectIsRef: boolean,
  ) {
    if (pattern.bindings.length === 0) return;
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 1`);

    const bind = (name: string, ty: string, fieldKind: TypeKind, fieldPtr: string) => {
      const uid = this.labelCounter++;
      // Ref-match of a non-Copy payload: bind a BORROW — the local holds a
      // pointer into the still-owned subject. No load, no zeroing, no drop, so
      // there is no double-free with the subject's real owner.
      if (subjectIsRef && this.needsDropCg(fieldKind)) {
        const addr = `%${name}.${uid}.addr`;
        lines.push(`  ${addr} = alloca ptr`);
        lines.push(`  store ptr ${fieldPtr}, ptr ${addr}`);
        this.locals.set(name, { type: ty, typeKind: { tag: "ref", inner: fieldKind, mutable: false }, mutable: false, isRef: true, addr });
        return;
      }
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
      // Owned match consumes (moves) the payload: zero the source so the
      // subject's drop chain doesn't free what the binding now owns. A ref-match
      // of a Copy payload is just a value copy — nothing to zero.
      if (!subjectIsRef && this.needsDropCg(fieldKind)) {
        lines.push(this.zeroStore(ty, fieldPtr));
      }
      const addr = `%${name}.${uid}.addr`;
      lines.push(`  ${addr} = alloca ${ty}`);
      lines.push(this.valStore(ty, val, addr));
      this.locals.set(name, { type: ty, typeKind: fieldKind, mutable: false, isRef: false, addr });
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

  private genBuiltinCall(expr: HIRExpr & { kind: "Call" }, lines: string[]): [string[], string, string] {
    if (expr.func === "print" || expr.func === "format") {
      this.needsPrintf = true;
      this.needsPutchar = true;
      this.needsFree = true;
      // Each arg → one printf call sized to its type. Final newline via putchar.
      const isFormat = expr.func === "format";
      const partFmts: string[] = [];
      const partArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = []; // bufs to free after the outer call (struct/enum stringification)
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
      }
      const fullFmt = partFmts.join("");
      const fmtStr = this.addString(fullFmt);
      const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");

      if (isFormat) {
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
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
        return [lines, s2, "%String"];
      }

      lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtStr.label}${argsStr})`);
      lines.push(`  call i32 @putchar(i32 10)`);
      for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
      return [lines, "void", "void"];
    }
    if (expr.func === "eprint") {
      this.needsDprintf = true;
      this.needsFree = true;
      const partFmts: string[] = [];
      const partArgs: { val: string; type: string }[] = [];
      const tempBufs: string[] = [];
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        this.emitDisplayPart(arg.expr.type, av, at, lines, partFmts, partArgs, tempBufs);
      }
      const fullFmt = partFmts.join("") + "\n";
      const fmtStr = this.addString(fullFmt);
      const argsStr = partArgs.map(a => `, ${a.type} ${a.val}`).join("");
      lines.push(`  call i32 (i32, ptr, ...) @dprintf(i32 2, ptr ${fmtStr.label}${argsStr})`);
      for (const tb of tempBufs) lines.push(`  call void @free(ptr ${tb})`);
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
    if (expr.func === "assert") {
      this.needsDprintf = true;
      this.needsExit = true;
      const [al, condVal] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const okLabel = this.nextLabel("assert.ok");
      const failLabel = this.nextLabel("assert.fail");
      lines.push(`  br i1 ${condVal}, label %${okLabel}, label %${failLabel}`);
      lines.push(`${failLabel}:`);
      const file = this.filePath ?? "<unknown>";
      const line = expr.span?.line ?? 0;
      const col = expr.span?.col ?? 0;
      if (expr.args.length >= 2) {
        const [al2, msgVal] = this.genExpr(expr.args[1].expr);
        lines.push(...al2);
        const msgPtr = this.nextTemp();
        lines.push(`  ${msgPtr} = extractvalue %String ${msgVal}, 0`);
        const fmtStr = this.addString(`assertion failed at ${file}:${line}:${col}: %s\n`);
        lines.push(`  call i32 (i32, ptr, ...) @dprintf(i32 2, ptr ${fmtStr.label}, ptr ${msgPtr})`);
      } else {
        const fmtStr = this.addString(`assertion failed at ${file}:${line}:${col}\n`);
        lines.push(`  call i32 (i32, ptr, ...) @dprintf(i32 2, ptr ${fmtStr.label})`);
      }
      lines.push(`  call void @exit(i32 1)`);
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
      this.needsArgGlobals = true;
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
      // extract the data pointer (field 0) from a &string
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const dataGep = this.nextTemp();
      lines.push(`  ${dataGep} = getelementptr %String, ptr ${pv}, i32 0, i32 0`);
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = load ptr, ptr ${dataGep}`);
      return [lines, dataPtr, "ptr"];
    }
    // ── Atomic intrinsics ──
    if (expr.func === "_atomicLoadI64") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const val = this.nextTemp();
      lines.push(`  ${val} = load atomic i64, ptr ${pv} seq_cst, align 8`);
      return [lines, val, "i64"];
    }
    if (expr.func === "_atomicStoreI64") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, vv] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      lines.push(`  store atomic i64 ${vv}, ptr ${pv} seq_cst, align 8`);
      return [lines, "void", "void"];
    }
    if (expr.func === "_atomicAddI64") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, vv] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const old = this.nextTemp();
      lines.push(`  ${old} = atomicrmw add ptr ${pv}, i64 ${vv} seq_cst, align 8`);
      return [lines, old, "i64"];
    }
    if (expr.func === "_atomicSubI64") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, vv] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const old = this.nextTemp();
      lines.push(`  ${old} = atomicrmw sub ptr ${pv}, i64 ${vv} seq_cst, align 8`);
      return [lines, old, "i64"];
    }
    if (expr.func === "_atomicCasI64") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, ev] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const [al3, dv] = this.genExpr(expr.args[2].expr);
      lines.push(...al3);
      const pair = this.nextTemp();
      lines.push(`  ${pair} = cmpxchg ptr ${pv}, i64 ${ev}, i64 ${dv} seq_cst seq_cst, align 8`);
      const old = this.nextTemp();
      lines.push(`  ${old} = extractvalue { i64, i1 } ${pair}, 0`);
      return [lines, old, "i64"];
    }
    if (expr.func === "_atomicLoadBool") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const raw = this.nextTemp();
      lines.push(`  ${raw} = load atomic i8, ptr ${pv} seq_cst, align 1`);
      const val = this.nextTemp();
      lines.push(`  ${val} = trunc i8 ${raw} to i1`);
      return [lines, val, "i1"];
    }
    if (expr.func === "_atomicStoreBool") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, bv] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const ext = this.nextTemp();
      lines.push(`  ${ext} = zext i1 ${bv} to i8`);
      lines.push(`  store atomic i8 ${ext}, ptr ${pv} seq_cst, align 1`);
      return [lines, "void", "void"];
    }
    if (expr.func === "_atomicSwapBool") {
      const [al, pv] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      const [al2, bv] = this.genExpr(expr.args[1].expr);
      lines.push(...al2);
      const ext = this.nextTemp();
      lines.push(`  ${ext} = zext i1 ${bv} to i8`);
      const old = this.nextTemp();
      lines.push(`  ${old} = atomicrmw xchg ptr ${pv}, i8 ${ext} seq_cst, align 1`);
      const val = this.nextTemp();
      lines.push(`  ${val} = trunc i8 ${old} to i1`);
      return [lines, val, "i1"];
    }
    if (expr.func === "_miloArgAt") {
      this.needsArgGlobals = true;
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

  private genExpr(expr: HIRExpr): [string[], string, string] {
    const lines: string[] = [];
    const lt = this.llvmType(expr.type);

    switch (expr.kind) {
      case "IntLit":
        return [lines, String(expr.value), lt];
      case "FloatLit": {
        // LLVM needs hex float for exact representation
        const buf = new ArrayBuffer(8);
        new Float64Array(buf)[0] = expr.value;
        const hex = [...new Uint8Array(buf)].reverse().map(b => b.toString(16).padStart(2, "0")).join("");
        return [lines, `0x${hex.toUpperCase()}`, lt];
      }
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
      case "StringWithCapacity": {
        this.hasStringType = true;
        this.needsMalloc = true;
        const [capLines, capVal] = this.genExpr(expr.capacity);
        lines.push(...capLines);
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
      case "Ident": {
        const local = this.locals.get(expr.name);
        if (!local) {
          // named function used as value — generate trampoline with closure calling convention
          if (this.fnSigs.has(expr.name)) {
            const sig = this.fnSigs.get(expr.name)!;
            const trampolineName = `__trampoline_${expr.name}`;
            if (!this.fnSigs.has(trampolineName)) {
              const paramNames = sig.paramTypes.map((_, i) => `p${i}`);
              const trampolineParams = [`ptr %env`, ...sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`)].join(", ");
              const fwdArgs = sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`).join(", ");
              const body: string[] = [];
              body.push(`define ${sig.retType} @${trampolineName}(${trampolineParams}) {`);
              body.push("entry.bb:");
              if (sig.retType === "void") {
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
          const dl = this.droppableLocals.find(d => this.localAddr(d.name) === addr);
          if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
        }
        return [lines, tmp, local.type];
      }
      case "CharLit": {
        return [lines, String(expr.value), "i8"];
      }
      case "BinOp": {
        if (expr.op === "&&" || expr.op === "||") {
          return this.genShortCircuit(expr, lines);
        }
        const [ll, lv, llt] = this.genExpr(expr.left);
        const [rl, rv] = this.genExpr(expr.right);
        lines.push(...ll, ...rl);

        if (llt === "%String") {
          if (expr.op === "+") return this.genStringConcat(lines, lv, rv);
          if (expr.op === "==" || expr.op === "!=") return this.genStringCmp(lines, lv, rv, expr.op === "==");
          if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") return this.genStringOrd(lines, lv, rv, expr.op);
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
        const floatCmps: Record<string, string> = { "==": "oeq", "!=": "one", "<": "olt", ">": "ogt", "<=": "ole", ">=": "oge" };
        if (expr.op in intOps) {
          const op = isFloat ? floatOps[expr.op] : intOps[expr.op];
          const checkedOps: Record<string, string> = { "+": "add", "-": "sub", "*": "mul" };
          if (this.debugOverflow && !isFloat && expr.op in checkedOps && expr.span) {
            const val = this.emitCheckedArith(lines, checkedOps[expr.op], unsigned, llt, lv, rv, expr.span.line);
            return [lines, val, llt];
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
      case "UnaryOp": {
        if (expr.op === "&") {
          const [al, addr] = this.genLValue(expr.operand);
          lines.push(...al);
          return [lines, addr, "ptr"];
        }
        const [ol, ov, ot] = this.genExpr(expr.operand);
        lines.push(...ol);
        const tmp = this.nextTemp();
        if (expr.op === "-") {
          if (ot === "float" || ot === "double") lines.push(`  ${tmp} = fneg ${ot} ${ov}`);
          else if (this.debugOverflow && expr.span) {
            const unsigned = this.isUnsigned(expr.operand.type);
            const val = this.emitCheckedArith(lines, "sub", unsigned, ot, "0", ov, expr.span.line);
            return [lines, val, ot];
          } else lines.push(`  ${tmp} = sub ${ot} 0, ${ov}`);
          return [lines, tmp, ot];
        }
        if (expr.op === "!") { lines.push(`  ${tmp} = xor i1 ${ov}, 1`); return [lines, tmp, "i1"]; }
        if (expr.op === "~") { lines.push(`  ${tmp} = xor ${ot} ${ov}, -1`); return [lines, tmp, ot]; }
        console.error(`error[codegen]: unknown unary op '${expr.op}'`); process.exit(1);
      }
      case "Call": {
        if (Codegen.BUILTINS.has(expr.func) && !this.userDeclaredFns.has(expr.func)) {
          return this.genBuiltinCall(expr, lines);
        }
        const sig = this.fnSigs.get(expr.func);
        const argVals: { val: string; type: string }[] = [];
        for (let i = 0; i < expr.args.length; i++) {
          const arg = expr.args[i];
          if (arg.passByRef) {
            const [al, aPtr] = this.genLValueForArg(arg.expr);
            lines.push(...al);
            argVals.push({ val: aPtr, type: "ptr" });
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
            // String → ptr coercion for extern/FFI calls (including variadic args)
            if (at === "%String" && sig && (i >= sig.paramTypes.length || sig.paramTypes[i] === "ptr")) {
              const dataPtr = this.nextTemp();
              lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
              argVals.push({ val: dataPtr, type: "ptr" });
            // fn closure → ptr coercion: extract fn ptr from closure tuple for extern calls
            } else if (at === "{ ptr, ptr }" && paramExpectsPtr) {
              const fnPtr = this.nextTemp();
              lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${av}, 0`);
              argVals.push({ val: fnPtr, type: "ptr" });
            } else {
              argVals.push({ val: av, type: at });
            }
          }
        }
        // extern fns passing/returning a struct by value need native-ABI lowering:
        // coerce args into registers, byval/indirect big ones, sret the return.
        if (this.externAbi.has(expr.func)) {
          return this.emitExternAbiCall(expr, argVals, lines);
        }
        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = sig?.retType ?? "i32";
        let callPrefix = retTy;
        if (expr.variadic) {
          const paramStr = sig!.paramTypes.join(", ");
          callPrefix = `${retTy} (${paramStr}, ...)`;
        }
        if (retTy === "void") {
          lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = call ${callPrefix} @${expr.func}(${argsStr})`);
        return [lines, tmp, retTy];
      }
      case "StructLit": {
        const layout = this.structLayouts.get(expr.name)!;
        const structTy = `%${expr.name}`;
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${structTy}`);
        for (const f of expr.fields) {
          const idx = layout.fields.findIndex(lf => lf.name === f.name);
          const fieldTy = layout.fields[idx].type;
          const [fLines, fVal] = this.genExpr(f.value);
          lines.push(...fLines);
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = getelementptr ${structTy}, ptr ${alloca}, i32 0, i32 ${idx}`);
          lines.push(this.valStore(fieldTy, fVal, ptr));
        }
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${structTy}, ptr ${alloca}`);
        return [lines, val, structTy];
      }
      case "FieldAccess": {
        const [ptrLines, ptr, fieldTy] = this.genFieldPtr(expr);
        lines.push(...ptrLines);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${fieldTy}, ptr ${ptr}`);
        // Moving a non-Copy field out of a struct: zero the source field so the
        // struct's own drop glue skips it (a zeroed %String/Vec has cap=0/null).
        // Otherwise both the moved value and the struct free the same buffer.
        if (expr.isMove && this.needsDropCg(expr.type)) {
          lines.push(this.zeroStore(fieldTy, ptr));
        }
        return [lines, val, fieldTy];
      }
      case "ArrayLen": {
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
      case "StringLen": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
        return [lines, len, "i64"];
      }
      case "StringCstr": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const dataPtr = this.nextTemp();
        lines.push(`  ${dataPtr} = extractvalue %String ${ov}, 0`);
        return [lines, dataPtr, "ptr"];
      }
      case "ArrayLit": {
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
      case "ArrayRepeat": {
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
      case "IndexAccess": {
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
        if (effObj.tag === "vec" || (effObj.tag === "array" && effObj.size === null)) {
          const [ptrLines, ptr, elemTy] = this.genVecBoundsCheckedPtr(expr, lines);
          const elemKind = effObj.element;
          // Auto-clone non-Copy elements so the Vec stays intact. The user-facing
          // semantics: Vec[i] always returns an independent value.
          if (this.needsDropCg(elemKind)) {
            const cloned = this.emitDeepCloneFromPtr(lines, ptr, elemKind);
            return [lines, cloned, elemTy];
          }
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
          return [lines, val, elemTy];
        }
        const [ptrLines, ptr, elemTy] = this.genBoundsCheckedPtr(expr, lines);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
        return [lines, val, elemTy];
        }
      }
      case "EnumLit": {
        const layout = this.enumLayouts.get(expr.enumName)!;
        const variant = layout.variants.get(expr.variant)!;
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
        return [lines, len, "i64"];
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
      case "VecAll":
        return this.genVecAll(expr, lines);
      case "VecIsEmpty": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
        const result = this.nextTemp();
        lines.push(`  ${result} = icmp eq i64 ${len}, 0`);
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
      case "VecContains":
        return this.genVecContains(expr, lines);
      case "VecEnumerate":
        return this.genVecEnumerate(expr, lines);
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
      case "HashMapRemove":
        return this.genHashMapRemove(expr, lines);
      case "HashMapLen": {
        this.hasHashMapType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %HashMap ${ov}, 1`);
        return [lines, len, "i64"];
      }
      case "StringPush":
        return this.genStringPush(expr, lines);
      case "StringSubstr":
        return this.genStringSubstr(expr, lines);
      case "StringSlice":
        return this.genStringSlice(expr, lines);
      case "VecSlice":
        return this.genVecSlice(expr, lines);
      case "StringParseF64":
        return this.genStringParseF64(expr, lines);
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
      case "JsonStringify":
        return this.genJsonStringify(expr, lines);
      case "Closure": {
        const closureName = `__closure_${this.closureCounter++}`;
        const captures = expr.captures;
        const retTy = this.llvmType(expr.retType);

        const isMove = !!(expr as any).isMove;
        // by-ref closures: env holds ptrs to original allocas
        // move closures: env holds copies of captured values
        const envStructTy = captures.length > 0
          ? (isMove
            ? `{ ${captures.map(c => this.llvmType(c.type)).join(", ")} }`
            : `{ ${captures.map(() => "ptr").join(", ")} }`)
          : "{}";

        // save codegen state
        const savedTemp = this.tempCounter;
        const savedLabel = this.labelCounter;
        const savedLocals = this.locals;
        const savedDroppable = this.droppableLocals;
        const savedLoopHeader = this.loopHeader;
        const savedLoopExit = this.loopExit;
        const savedEntryAllocas = this.entryAllocas;
        const savedFnName = this.currentFnName;
        const savedEnsures = this.currentEnsures;
        this.tempCounter = 0;
        this.labelCounter = 0;
        this.locals = new Map();
        this.droppableLocals = [];
        this.entryAllocas = [];
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
        const closureParams = [`ptr %env`, ...expr.params.map(p => `${this.llvmType(p.type)} %${p.name}`)].join(", ");
        closureBody.push(`define ${retTy} @${closureName}(${closureParams}) {`);
        closureBody.push("entry.bb:");

        // load captures from env struct
        for (let i = 0; i < captures.length; i++) {
          const cap = captures[i];
          const capTy = this.llvmType(cap.type);
          const gepPtr = this.nextTemp();
          closureBody.push(`  ${gepPtr} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${i}`);
          if (isMove) {
            // move closure: env holds the value directly — treat as local alloca
            this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: false });
            closureBody.push(`  %${cap.name}.addr = alloca ${capTy}`);
            const loaded = this.nextTemp();
            closureBody.push(`  ${loaded} = load ${capTy}, ptr ${gepPtr}`);
            closureBody.push(`  store ${capTy} ${loaded}, ptr %${cap.name}.addr`);
          } else {
            const loadedPtr = this.nextTemp();
            closureBody.push(`  ${loadedPtr} = load ptr, ptr ${gepPtr}`);
            // the capture is a pointer to the original variable's alloca
            this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: true, addr: `${gepPtr}.ref` });
            closureBody.push(`  ${gepPtr}.ref = alloca ptr`);
            closureBody.push(`  store ptr ${loadedPtr}, ptr ${gepPtr}.ref`);
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
          }
        }

        // generate body
        const closureAllocaInsertPoint = closureBody.length;
        let hasTerminator = false;
        for (const stmt of expr.body) {
          const [stmtLines, terminated] = this.genStmt(stmt);
          closureBody.push(...stmtLines);
          if (terminated) hasTerminator = true;
        }
        if (!hasTerminator) {
          if (retTy === "void") closureBody.push("  ret void");
          else closureBody.push(`  ret ${retTy} 0`);
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
        this.droppableLocals = savedDroppable;
        this.entryAllocas = savedEntryAllocas;
        this.loopHeader = savedLoopHeader;
        this.loopExit = savedLoopExit;
        this.currentFnName = savedFnName;
        this.currentSubprogramId = savedSubprogram;
        this.currentEnsures = savedEnsures;

        // at the call site: build env struct and closure pair
        if (captures.length > 0) {
          const envAddr = this.nextTemp();
          if (isMove) {
            // heap-allocate env for move closures (safe to send to other threads)
            const envSize = this.structPayloadSize(captures.map(c => this.llvmType(c.type)));
            lines.push(`  ${envAddr} = call ptr @malloc(i64 ${Math.max(envSize, 8)})`);
          } else {
            lines.push(`  ${envAddr} = alloca ${envStructTy}`);
          }
          for (let i = 0; i < captures.length; i++) {
            const cap = captures[i];
            const capAddr = this.localAddr(cap.name);
            const local = this.locals.get(cap.name);
            const capTy = this.llvmType(cap.type);
            const gepSlot = this.nextTemp();
            lines.push(`  ${gepSlot} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 ${i}`);
            if (isMove) {
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
                  const dl = this.droppableLocals.find(d => this.localAddr(d.name) === capAddr);
                  if (dl) lines.push(`  store i1 0, ptr ${dl.aliveFlag}`);
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
      case "ClosureCall": {
        // load the { fn_ptr, env_ptr } pair from the callee
        const [calLines, calVal] = this.genExpr(expr.callee);
        lines.push(...calLines);
        const fnPtr = this.nextTemp();
        lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${calVal}, 0`);
        const envPtr = this.nextTemp();
        lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${calVal}, 1`);

        // evaluate args
        const argVals: { val: string; type: string }[] = [{ val: envPtr, type: "ptr" }];
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

        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = this.llvmType(expr.type);
        if (retTy === "void") {
          lines.push(`  call void ${fnPtr}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const result = this.nextTemp();
        lines.push(`  ${result} = call ${retTy} ${fnPtr}(${argsStr})`);
        return [lines, result, retTy];
      }
      case "InterfaceCoerce": {
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
      case "IfExpr": {
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
      case "InterfaceMethodCall": {
        // object is { ptr data, ptr itable } — either directly or loaded from alloca
        let objVal: string;
        const recv = expr.object;
        if (recv.kind === "IndexAccess" && recv.object.type.tag === "vec") {
          // Borrow the fat pointer straight from the Vec slot. Dispatch only
          // reads data+itable, so don't deep-clone the element — a boxed trait
          // object can't be cloned (no vtable clone slot), and cloning it as a
          // thin Heap mis-handles the fat pointer.
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
        const argVals: { val: string; type: string }[] = [{ val: dataPtr, type: "ptr" }];
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

        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = this.llvmType(expr.type);
        if (retTy === "void") {
          lines.push(`  call void ${fnPtr}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const result = this.nextTemp();
        lines.push(`  ${result} = call ${retTy} ${fnPtr}(${argsStr})`);
        return [lines, result, retTy];
      }
    }
  }

  private genUnwrap(expr: HIRExpr & { kind: "Unwrap" }, lines: string[]): [string[], string, string] {
    this.needsPrintf = true;
    this.needsExit = true;
    const [ol, ov, ot] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = this.enumLayouts.get(expr.enumName)!;
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
    if (isResult && errIsString) {
      // Err(string) — extract and print the message
      const errPayloadPtr = this.nextTemp();
      lines.push(`  ${errPayloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
      const errStr = this.nextTemp();
      lines.push(`  ${errStr} = load %String, ptr ${errPayloadPtr}`);
      const errDataPtr = this.nextTemp();
      lines.push(`  ${errDataPtr} = extractvalue %String ${errStr}, 0`);
      const fmtMsg = `error at ${span?.line ?? 0}:${span?.col ?? 0}: %s`;
      const { label: fmtLabel, length: fmtLen } = this.addString(fmtMsg);
      const fmtPtr = this.nextTemp();
      lines.push(`  ${fmtPtr} = getelementptr [${fmtLen} x i8], ptr ${fmtLabel}, i32 0, i32 0`);
      lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, ptr ${errDataPtr})`);
    } else if (isResult) {
      // Err(non-string) — print generic message with enum type name
      const errMsg = `error at ${span?.line ?? 0}:${span?.col ?? 0}: unwrap called on Err`;
      const { label: errLabel, length: errLen } = this.addString(errMsg);
      const errPtr = this.nextTemp();
      lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
      lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    } else {
      const errMsg = `error at ${span?.line ?? 0}:${span?.col ?? 0}: unwrap called on None`;
      const { label: errLabel, length: errLen } = this.addString(errMsg);
      const errPtr = this.nextTemp();
      lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
      lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    }
    lines.push(`  call i32 @putchar(i32 10)`);
    this.needsPutchar = true;
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);

    // ok branch — extract payload and zero source to prevent double-free
    lines.push(`${okLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    return [lines, result, resultTy];
  }

  private genPropagate(expr: HIRExpr & { kind: "Propagate" }, lines: string[]): [string[], string, string] {
    const [ol, ov, ot] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = this.enumLayouts.get(expr.enumName)!;
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

    // error branch — reconstruct caller's return type with the Err payload
    lines.push(`${errLabel}:`);
    const retEnumName = expr.retType.tag === "enum" ? expr.retType.name : expr.enumName;
    if (retEnumName === expr.enumName && !expr.fromConversion) {
      // same enum type — return as-is
      lines.push(`  ret ${retTy} ${ov}`);
    } else {
      // extract source Err payload
      const errPayloadPtr = this.nextTemp();
      lines.push(`  ${errPayloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
      const srcErrVariant = layout.variants.get("Err") || layout.variants.get("None");
      const srcErrFieldTy = srcErrVariant && srcErrVariant.fieldTypes.length > 0 ? srcErrVariant.fieldTypes[0] : null;

      let finalErrPayload: string | null = null;
      let finalErrFieldTy: string | null = null;

      if (expr.fromConversion && srcErrFieldTy) {
        // From conversion: wrap source err in target error enum variant
        const convLayout = this.enumLayouts.get(expr.fromConversion.targetEnumName)!;
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
      const retLayout = this.enumLayouts.get(retEnumName)!;
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
      lines.push(`  ret ${retEnumTy} ${retVal}`);
    }

    // ok branch — extract payload and zero source to prevent double-free
    lines.push(`${okLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    if (this.needsDropCg(expr.type) && expr.operand.kind === "Ident") {
      const srcAddr = this.localAddr(expr.operand.name);
      if (srcAddr) lines.push(`  store ${enumTy} zeroinitializer, ptr ${srcAddr}`);
    }
    return [lines, result, resultTy];
  }

  private genDefaultValue(expr: HIRExpr & { kind: "DefaultValue" }, lines: string[]): [string[], string, string] {
    const [ol, ov] = this.genExpr(expr.operand);
    lines.push(...ol);

    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);

    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
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
    lines.push(`  br label %${doneLabel}`);

    // none branch — use default
    lines.push(`${noneLabel}:`);
    const [dl, dv] = this.genExpr(expr.default);
    lines.push(...dl);
    lines.push(`  br label %${doneLabel}`);

    // merge with phi
    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${resultTy} [${someVal}, %${someLabel}], [${dv}, %${noneLabel}]`);
    return [lines, result, resultTy];
  }

  private genShortCircuit(expr: HIRExpr & { kind: "BinOp" }, lines: string[]): [string[], string, string] {
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

  private genCast(expr: HIRExpr & { kind: "Cast" }, lines: string[]): [string[], string, string] {
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
      const [ol, ov, fromTy] = this.genExpr(expr.operand);
      lines.push(...ol);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = extractvalue { ptr, ptr } ${ov}, 0`);
      return [lines, tmp, "ptr"];
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
    if (fromKind.tag === "ptr" && (toKind.tag === "int" || toKind.tag === "bool")) {
      lines.push(`  ${tmp} = ptrtoint ${fromTy} ${ov} to ${toTy}`);
    } else if ((fromKind.tag === "int" || fromKind.tag === "bool") && toKind.tag === "ptr") {
      lines.push(`  ${tmp} = inttoptr ${fromTy} ${ov} to ${toTy}`);
    } else if (fromFloat && toFloat) {
      const op = this.bitWidth(toKind) > this.bitWidth(fromKind) ? "fpext" : "fptrunc";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else if (fromFloat) {
      const op = toKind.tag === "int" && !toKind.signed ? "fptoui" : "fptosi";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
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

  private genStringConcat(lines: string[], lv: string, rv: string): [string[], string, string] {
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

  private genStringCmp(lines: string[], lv: string, rv: string, isEq: boolean): [string[], string, string] {
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
  private genStringOrd(lines: string[], lv: string, rv: string, op: string): [string[], string, string] {
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

  private genStringIndex(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
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
      this.emitBoundsCheck(lines, idx32, len32);
    } else {
      this.emitBoundsCheck(lines, iv, len32);
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

  private genFieldPtr(expr: HIRExpr & { kind: "FieldAccess" }): [string[], string, string] {
    const lines: string[] = [];
    // pointer-to-struct: load the ptr value, GEP into the pointed-to struct
    if (expr.object.type.tag === "ptr" && expr.object.type.inner.tag === "struct") {
      const [objLines, objVal] = this.genExpr(expr.object);
      lines.push(...objLines);
      const structName = expr.object.type.inner.name;
      const layout = this.structLayouts.get(structName)!;
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
    }
    const structName = this.getStructName(finalTy);
    if (structName) {
      const layout = this.structLayouts.get(structName)!;
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
    const lines: string[] = [];
    const [el, ev, et] = this.genExpr(expr);
    lines.push(...el);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${et}`);
    lines.push(`  store ${et} ${ev}, ptr ${tmp}`);
    return [lines, tmp];
  }

  private genVecPush(expr: HIRExpr & { kind: "VecPush" }, lines: string[]): [string[], string, string] {
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

    // grow: new_cap = cap == 0 ? 8 : cap * 2
    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const newCap = this.nextTemp();
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 8, i64 ${doubled}`);
    const newBytes = this.nextTemp();
    lines.push(`  ${newBytes} = mul i64 ${newCap}, ${elemSize}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newBytes})`);

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

  private genVecPop(expr: HIRExpr & { kind: "VecPop" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsPrintf = true;
    this.needsExit = true;
    this.needsPutchar = true;

    const vecType = expr.vec.type;
    if (vecType.tag !== "vec") throw new Error("VecPop on non-vec type");
    const elemTy = this.llvmType(vecType.element);
    const elemSize = this.typeSizeOf(vecType.element);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.vec);
    lines.push(...vecPtrLines);

    // load len
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    // panic if empty
    const isEmpty = this.nextTemp();
    lines.push(`  ${isEmpty} = icmp eq i64 ${len}, 0`);
    const panicLabel = this.nextLabel("vec.pop.panic");
    const okLabel = this.nextLabel("vec.pop.ok");
    lines.push(`  br i1 ${isEmpty}, label %${panicLabel}, label %${okLabel}`);

    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const errMsg = `pop on empty Vec at ${span?.line ?? 0}:${span?.col ?? 0}`;
    const { label: errLabel, length: errLen } = this.addString(errMsg);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    lines.push(`  call i32 @putchar(i32 10)`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);

    // ok: len--, load value at data[new_len]
    lines.push(`${okLabel}:`);
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

    return [lines, val, elemTy];
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

  private genVecMap(expr: HIRExpr & { kind: "VecMap" }, lines: string[]): [string[], string, string] {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const resultElemTy = this.llvmType(expr.resultElementType);
    const resultElemSize = this.typeSizeOf(expr.resultElementType);
    this.needsMalloc = true;

    // allocate result buffer: malloc(len * elemSize)
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = mul i64 ${len}, ${resultElemSize}`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);

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

  private genVecFilter(expr: HIRExpr & { kind: "VecFilter" }, lines: string[]): [string[], string, string] {
    const { fnPtr, envPtr, data, len, elemTy } = this.genVecMethodPreamble(expr.vec, expr.callback, expr.elementType, lines);
    const elemSize = this.typeSizeOf(expr.elementType);
    this.needsMalloc = true;

    // allocate result buffer with capacity = source len (worst case all match)
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = mul i64 ${len}, ${elemSize}`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);

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
    lines.push(`  ${keep} = call i1 ${fnPtr}(ptr ${envPtr}, ptr ${elemPtr})`);
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

  private genVecEach(expr: HIRExpr & { kind: "VecEach" }, lines: string[]): [string[], string, string] {
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
    lines.push(`  call void ${fnPtr}(ptr ${envPtr}, ptr ${elemPtr})`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, "void", "void"];
  }

  private genVecFind(expr: HIRExpr & { kind: "VecFind" }, lines: string[]): [string[], string, string] {
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
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ptr ${elemPtr})`);
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

  private genVecAny(expr: HIRExpr & { kind: "VecAny" }, lines: string[]): [string[], string, string] {
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
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ptr ${elemPtr})`);
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

  private genVecAll(expr: HIRExpr & { kind: "VecAll" }, lines: string[]): [string[], string, string] {
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
    lines.push(`  ${match} = call i1 ${fnPtr}(ptr ${envPtr}, ptr ${elemPtr})`);
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

  private genVecReverse(expr: HIRExpr & { kind: "VecReverse" }, lines: string[]): [string[], string, string] {
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

  private genVecSwap(expr: HIRExpr & { kind: "VecSwap" }, lines: string[]): [string[], string, string] {
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

  private genVecInsert(expr: HIRExpr & { kind: "VecInsert" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;
    this.needsPrintf = true;
    this.needsExit = true;
    this.needsPutchar = true;

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
    const { label: errLabel, length: errLen } = this.addString(`insert index out of bounds at ${span?.line ?? 0}:${span?.col ?? 0}`);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    lines.push(`  call i32 @putchar(i32 10)`);
    lines.push(`  call void @exit(i32 1)`);
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
    const newBytes = this.nextTemp();
    lines.push(`  ${newBytes} = mul i64 ${newCap}, ${elemSize}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newBytes})`);
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

  private genVecRemove(expr: HIRExpr & { kind: "VecRemove" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsPrintf = true;
    this.needsExit = true;
    this.needsPutchar = true;

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
    const { label: errLabel, length: errLen } = this.addString(`remove index out of bounds at ${span?.line ?? 0}:${span?.col ?? 0}`);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    lines.push(`  call i32 @putchar(i32 10)`);
    lines.push(`  call void @exit(i32 1)`);
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

  private genVecContains(expr: HIRExpr & { kind: "VecContains" }, lines: string[]): [string[], string, string] {
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
    return [lines, result, "i1"];
  }

  private genVecEnumerate(expr: HIRExpr & { kind: "VecEnumerate" }, lines: string[]): [string[], string, string] {
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
    lines.push(`  call void ${fnPtr}(ptr ${envPtr}, i64 ${idx}, ptr ${elemPtr})`);
    const nextIdx = this.nextTemp();
    lines.push(`  ${nextIdx} = add i64 ${idx}, 1`);
    lines.push(`  store i64 ${nextIdx}, ptr ${idxAddr}`);
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, "void", "void"];
  }

  // String.push(u8) — same grow logic as Vec but element size is 1
  private genStringPush(expr: HIRExpr & { kind: "StringPush" }, lines: string[]): [string[], string, string] {
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
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 16, i64 ${doubled}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newCap})`);

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
      `milo: ${what} range out of bounds: %lld..%lld (len %lld) at ${span?.line ?? 0}:${span?.col ?? 0}\n`,
    );
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr}, i64 ${startVal}, i64 ${endVal}, i64 ${lenVal})`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  // String.substr(start, end) — allocate new owned string from s[start..end]
  private genStringSubstr(expr: HIRExpr & { kind: "StringSubstr" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;

    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const [startLines, startVal] = this.genExpr(expr.start);
    lines.push(...startLines);
    const [endLines, endVal] = this.genExpr(expr.end);
    lines.push(...endLines);

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

    return [lines, s2, "%String"];
  }

  // String.slice(start, end) — zero-copy view. Non-owning %String with cap=0.
  private genStringSlice(expr: HIRExpr & { kind: "StringSlice" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;

    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const [startLines, startVal] = this.genExpr(expr.start);
    lines.push(...startLines);
    const [endLines, endVal] = this.genExpr(expr.end);
    lines.push(...endLines);

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

  // v.slice(a, b) / v[a..b] — non-owning view: same %Vec rep with adjusted ptr/len
  // and cap=0, so drop glue skips free (the source still owns the buffer).
  private genVecSlice(expr: HIRExpr & { kind: "VecSlice" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    const elemTy = this.llvmType(expr.elementType);

    const [vLines, vVal] = this.genExpr(expr.vec);
    lines.push(...vLines);
    const [startLines, startVal] = this.genExpr(expr.start);
    lines.push(...startLines);
    const [endLines, endVal] = this.genExpr(expr.end);
    lines.push(...endLines);

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
      `milo: slice range out of bounds: %lld..%lld (len %lld) at ${expr.span?.line ?? 0}:${expr.span?.col ?? 0}\n`,
    );
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr}, i64 ${startVal}, i64 ${endVal}, i64 ${lenVal})`);
    lines.push(`  call void @exit(i32 1)`);
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

  // n.toString() / x.toString() — snprintf into heap buffer, return owned %String
  private genNumberToString(expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): [string[], string, string] {
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
      // float — promote f32 to double
      if (vt.tag === "float" && vt.bits === 32) {
        const promoted = this.nextTemp();
        lines.push(`  ${promoted} = fpext float ${vVal} to double`);
        argVal = promoted;
      }
      argType = "double";
      fmtStr = "%g";
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

  private genBoolToString(expr: HIRExpr & { kind: "BoolToString" }, lines: string[]): [string[], string, string] {
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
  private genStringClone(expr: HIRExpr & { kind: "StringClone" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
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

  private genStringParseF64(expr: HIRExpr & { kind: "StringParseF64" }, lines: string[]): [string[], string, string] {
    this.needsStrtod = true;
    this.hasStringType = true;
    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = extractvalue %String ${strVal}, 0`);
    const result = this.nextTemp();
    lines.push(`  ${result} = call double @strtod(ptr ${dataPtr}, ptr null)`);
    return [lines, result, "double"];
  }

  private genVecBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsBoundsCheck = true;

    const vecType = expr.object.type;
    if (vecType.tag !== "vec") throw new Error("Vec index on non-vec type");
    const elemTy = this.llvmType(vecType.element);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);
    const [idxLines, idxVal, idxTy] = this.genExpr(expr.index);
    lines.push(...idxLines);

    // load len for bounds check
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const len32 = this.nextTemp();
    lines.push(`  ${len32} = trunc i64 ${len} to i32`);

    // bounds check
    let idx32: string;
    if (idxTy === "i64") {
      idx32 = this.nextTemp();
      lines.push(`  ${idx32} = trunc i64 ${idxVal} to i32`);
    } else {
      idx32 = idxVal;
    }
    this.emitBoundsCheck(lines, idx32, len32);

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
    // FNV-1a: hash = offset_basis ^ seed; for each byte: hash ^= byte; hash *= prime
    const offsetBasis = "14695981039346656037";
    const prime = "1099511628211";
    const h0 = this.nextTemp();
    lines.push(`  ${h0} = xor i64 ${offsetBasis}, ${seedReg}`);

    if (keyType.tag === "bool") {
      const byte = this.nextTemp();
      lines.push(`  ${byte} = zext i1 ${keyVal} to i64`);
      const x = this.nextTemp();
      lines.push(`  ${x} = xor i64 ${h0}, ${byte}`);
      const result = this.nextTemp();
      lines.push(`  ${result} = mul i64 ${x}, ${prime}`);
      return result;
    }

    if (keyType.tag === "int") {
      let val64: string;
      if (keyType.bits === 64) {
        val64 = keyVal;
      } else {
        val64 = this.nextTemp();
        if (keyType.signed) {
          lines.push(`  ${val64} = sext i${keyType.bits} ${keyVal} to i64`);
        } else {
          lines.push(`  ${val64} = zext i${keyType.bits} ${keyVal} to i64`);
        }
      }
      // unrolled 8-byte FNV-1a
      let hash = h0;
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

    if (keyType.tag === "string") {
      this.hasStringType = true;
      const strData = this.nextTemp();
      lines.push(`  ${strData} = extractvalue %String ${keyVal}, 0`);
      const strLen = this.nextTemp();
      lines.push(`  ${strLen} = extractvalue %String ${keyVal}, 1`);
      const iAddr = this.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      const hAddr = this.nextTemp();
      lines.push(`  ${hAddr} = alloca i64`);
      lines.push(`  store i64 ${h0}, ptr ${hAddr}`);
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

    throw new Error(`unhashable key type: ${keyType.tag}`);
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
    throw new Error(`uncomparable key type: ${keyType.tag}`);
  }

  private genHashMapNew(expr: HIRExpr & { kind: "HashMapNew" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    const entryTy = this.hashMapEntryType(expr.keyType, expr.valueType);
    // allocate initial 8 entries, zeroed
    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const totalSize = this.nextTemp();
    lines.push(`  ${totalSize} = mul i64 ${entrySizeI}, 8`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = call ptr @malloc(i64 ${totalSize})`);
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
    return [lines, s3, "%HashMap"];
  }

  private genHashMapInsert(expr: HIRExpr & { kind: "HashMapInsert" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsGetentropy = true;

    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapInsert on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    // get pointer to map
    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);

    // eval key and value
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);
    const [valLines, valVal] = this.genExpr(expr.value);
    lines.push(...valLines);

    // lazy seed init
    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
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
    lines.push(`  call i32 @getentropy(ptr ${seedBuf}, i64 8)`);
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
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);

    // resize check: (len + 1) * 4 >= cap * 3
    const lenPlus1 = this.nextTemp();
    lines.push(`  ${lenPlus1} = add i64 ${len}, 1`);
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
    const newTotalSize = this.nextTemp();
    lines.push(`  ${newTotalSize} = mul i64 ${entrySizeI}, ${newCap}`);
    const newData = this.nextTemp();
    lines.push(`  ${newData} = call ptr @malloc(i64 ${newTotalSize})`);
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
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeEmpty}`);

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
    lines.push(`  br label %${insertDone}`);

    // empty or tombstone: insert here
    lines.push(`${probeEmpty}:`);
    lines.push(`  store i8 1, ptr ${entryPtr}`);
    const newKeySlotPtr = this.nextTemp();
    lines.push(`  ${newKeySlotPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    lines.push(`  store ${keyTy} ${keyVal}, ptr ${newKeySlotPtr}`);
    const newValSlotPtr = this.nextTemp();
    lines.push(`  ${newValSlotPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
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
    return [lines, "0", "void"];
  }

  private genHashMapContains(expr: HIRExpr & { kind: "HashMapContains" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapContains on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
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

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    // state == 0 (empty) -> not found
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${notFoundLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${foundLabel}, label %${probeNext}`);

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
    return [lines, result, "i1"];
  }

  private genHashMapRemove(expr: HIRExpr & { kind: "HashMapRemove" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapRemove on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 1`);

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

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${doneLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${removeLabel}, label %${probeNext}`);

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
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    return [lines, "0", "void"];
  }

  private genHashMapGet(expr: HIRExpr & { kind: "HashMapGet" }, lines: string[]): [string[], string, string] {
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

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
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

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${notFoundLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${foundLabel}, label %${probeNext}`);

    // found — construct Some(value)
    lines.push(`${foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    const foundVal = this.nextTemp();
    lines.push(`  ${foundVal} = load ${valTy}, ptr ${valPtr}`);
    // build Option::Some(val) — tag=0, payload=value
    const someAlloca = this.nextTemp();
    lines.push(`  ${someAlloca} = alloca ${optionTy}`);
    const someTagPtr = this.nextTemp();
    lines.push(`  ${someTagPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 0`);
    const someTag = optionLayout.variants.get("Some")!.tag;
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
    const noneTag = optionLayout.variants.get("None")!.tag;
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
    lines.push(`  ${result} = phi ${optionTy} [${someVal}, %${foundLabel}], [${noneVal}, %${notFoundLabel}]`);
    return [lines, result, optionTy];
  }

  private genHashMapGetOrDefault(expr: HIRExpr & { kind: "HashMapGetOrDefault" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapGetOrDefault on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);
    const [defaultLines, defaultVal] = this.genExpr(expr.default);
    lines.push(...defaultLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
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

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${notFoundLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${foundLabel}, label %${probeNext}`);

    // found — return the value directly
    lines.push(`${foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    const foundVal = this.nextTemp();
    lines.push(`  ${foundVal} = load ${valTy}, ptr ${valPtr}`);
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
    lines.push(`  ${result} = phi ${valTy} [${foundVal}, %${foundLabel}], [${defaultVal}, %${notFoundLabel}]`);
    return [lines, result, valTy];
  }

  private needsMemset = false;
  private needsSnprintf = false;

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
      if (tk.bits === 32) {
        const promoted = this.nextTemp();
        lines.push(`  ${promoted} = fpext float ${val} to double`);
        partArgs.push({ val: promoted, type: "double" });
      } else {
        partArgs.push({ val: val, type: "double" });
      }
      partFmts.push("%g");
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
    if (tk.tag === "ptr") {
      partFmts.push("%p");
      partArgs.push({ val: val, type: "ptr" });
      return;
    }
    // fallback for unsupported types: print as pointer (better than silent miscompile)
    partFmts.push("<unprintable>");
  }

  // snprintf a struct into a malloc'd buffer formatted as `Name { f1: v1, f2: v2 }`.
  // Returns the buf ptr; caller is responsible for free.
  private emitStructDisplay(structName: string, structVal: string, lines: string[]): string {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    const layout = this.structLayouts.get(structName)!;
    // Stage the struct value into an alloca so we can GEP each field.
    const stagePtr = this.nextTemp();
    lines.push(`  ${stagePtr} = alloca %${structName}`);
    lines.push(`  store %${structName} ${structVal}, ptr ${stagePtr}`);
    const formatParts: string[] = [`${structName} { `];
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
      const fb = this.addString(`<${enumName}>`);
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
    const unkFmt = this.addString(`<${enumName}.?>`);
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

  private genJsonStringify(expr: HIRExpr & { kind: "JsonStringify" }, lines: string[]): [string[], string, string] {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.hasStringType = true;

    const valueType = expr.valueType;
    if (valueType.tag !== "struct") {
      throw new Error(`jsonStringify: unsupported type '${valueType.tag}'`);
    }

    const layout = this.structLayouts.get(valueType.name)!;
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
        if (fk.bits === 32) {
          const promoted = this.nextTemp();
          lines.push(`  ${promoted} = fpext float ${fieldVal} to double`);
          snprintfArgs.push({ val: promoted, type: "double" });
        } else {
          snprintfArgs.push({ val: fieldVal, type: "double" });
        }
        formatParts.push("%g");
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
      const bytes = this.nextTemp();
      lines.push(`  ${bytes} = mul i64 ${vecLen}, ${elemSize}`);
      const newBuf = this.nextTemp();
      lines.push(`  ${newBuf} = call ptr @malloc(i64 ${bytes})`);
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

    // enum/hashmap/array — fall back to shallow load (TODO: full enum deep clone)
    const v = this.nextTemp();
    lines.push(`  ${v} = load ${lt}, ptr ${srcPtr}`);
    return v;
  }

  private emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind) {
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
      if (this.needsDropCg(typeKind.inner)) {
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

    const layout = this.enumLayouts.get(enumName)!;
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

    const layout = this.structLayouts.get(structName)!;
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

    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
  }

  private ensureStructDropHelper(structName: string) {
    if (this.generatedStructDropHelpers.has(structName)) return;
    this.generatedStructDropHelpers.add(structName);

    const layout = this.structLayouts.get(structName)!;
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
    // Find a droppable field to use as sentinel — heap types (string, vec, hashmap)
    // have non-null data pointers when alive, so null check is a reliable "was zeroed" test.
    const sentinelIdx = layout.fields.findIndex(f =>
      f.typeKind.tag === "string" || f.typeKind.tag === "vec" || f.typeKind.tag === "hashmap" || f.typeKind.tag === "heap");
    if (sentinelIdx >= 0) {
      const sentinelPtr = this.nextTemp();
      body.push(`  ${sentinelPtr} = getelementptr %${structName}, ptr %self, i32 0, i32 ${sentinelIdx}`);
      const probe = this.nextTemp();
      body.push(`  ${probe} = load ptr, ptr ${sentinelPtr}`);
      const isNull = this.nextTemp();
      body.push(`  ${isNull} = icmp eq ptr ${probe}, null`);
      body.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
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
  private genWrappingArith(expr: HIRExpr & { kind: "WrappingArith" }, lines: string[]): [string[], string, string] {
    const [ll, lv, lt] = this.genExpr(expr.left);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...ll, ...rl);
    const result = this.nextTemp();
    lines.push(`  ${result} = ${expr.op} ${lt} ${lv}, ${rv}`);
    return [lines, result, lt];
  }

  // x.saturatingAdd(y) — clamps to min/max instead of wrapping
  private genSaturatingArith(expr: HIRExpr & { kind: "SaturatingArith" }, lines: string[]): [string[], string, string] {
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
  private emitSaturatingMul(lines: string[], lv: string, rv: string, lt: string, signed: boolean, ty: TypeKind): [string[], string, string] {
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
      // unsigned: clamp to max
      clampVal = String(BigInt(2) ** BigInt(bits) - BigInt(1));
    } else {
      // signed: clamp to max (simplification — true saturation would check sign)
      clampVal = String(BigInt(2) ** BigInt(bits - 1) - BigInt(1));
    }

    const result = this.nextTemp();
    lines.push(`  ${result} = select i1 ${flag}, ${lt} ${clampVal}, ${lt} ${val}`);
    return [lines, result, lt];
  }

  // x.checkedAdd(y) — returns Option<T>, None on overflow
  private genCheckedArith(expr: HIRExpr & { kind: "CheckedArith" }, lines: string[]): [string[], string, string] {
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

    const optionTy = `%${expr.optionEnumName}`;
    const optionLayout = this.enumLayouts.get(expr.optionEnumName);
    if (!optionLayout) throw new Error(`Option enum '${expr.optionEnumName}' not found`);
    const someTag = optionLayout.variants.get("Some")!.tag;
    const noneTag = optionLayout.variants.get("None")!.tag;

    const okLabel = this.nextLabel("checked.ok");
    const overflowLabel = this.nextLabel("checked.overflow");
    const doneLabel = this.nextLabel("checked.done");

    lines.push(`  br i1 ${flag}, label %${overflowLabel}, label %${okLabel}`);

    // no overflow → Some(val)
    lines.push(`${okLabel}:`);
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

    // overflow → None
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

    // phi
    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${optionTy} [ ${someVal}, %${okLabel} ], [ ${noneVal}, %${overflowLabel} ]`);

    return [lines, result, optionTy];
  }

  private usedSatIntrinsics?: Set<string>;

  private tryConstantExpr(expr: import("./hir").HIRExpr): string | null {
    switch (expr.kind) {
      case "IntLit": return expr.value.toString();
      case "FloatLit": {
        const buf = new ArrayBuffer(8);
        new Float64Array(buf)[0] = expr.value;
        const bits = new BigUint64Array(buf)[0];
        return `0x${bits.toString(16).toUpperCase().padStart(16, "0")}`;
      }
      case "BoolLit": return expr.value ? "1" : "0";
      case "Cast":
        if (expr.type.tag === "ptr") return "null";
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

  private getConstantInitializer(g: import("./hir").HIRGlobal): string {
    const constVal = this.tryConstantExpr(g.value);
    if (constVal !== null) return constVal;
    if (g.type.tag === "ptr") return "null";
    const tag = g.type.tag;
    if (tag === "struct" || tag === "array" || tag === "enum" || tag === "string" || tag === "vec" || tag === "hashmap" || tag === "tuple") {
      return "zeroinitializer";
    }
    return "0";
  }

  private emitDropGlue(lines: string[]) {
    for (const local of this.droppableLocals) {
      this.emitGuardedDrop(lines, local);
    }
  }

  private emitLoopDropGlue(lines: string[]) {
    for (let i = this.loopDropStart; i < this.droppableLocals.length; i++) {
      this.emitGuardedDrop(lines, this.droppableLocals[i]);
    }
  }

  private emitGuardedDrop(lines: string[], local: { name: string; typeKind: TypeKind; aliveFlag: string }) {
    const check = this.nextTemp();
    lines.push(`  ${check} = load i1, ptr ${local.aliveFlag}`);
    const dropLabel = this.nextLabel("drop.alive");
    const skipLabel = this.nextLabel("drop.skip");
    lines.push(`  br i1 ${check}, label %${dropLabel}, label %${skipLabel}`);
    lines.push(`${dropLabel}:`);
    this.emitDropValue(lines, this.localAddr(local.name), local.typeKind);
    // Make the guarded drop idempotent: clear the alive-flag and zero the slot.
    // A loop `break`/`continue` drops loop-scoped locals via emitLoopDropGlue;
    // without this, the function epilogue (after break) or the next iteration's
    // overwrite-drop (after continue) would free the same buffer again.
    lines.push(`  store i1 0, ptr ${local.aliveFlag}`);
    const slotTy = this.llvmType(local.typeKind);
    lines.push(this.zeroStore(slotTy, this.localAddr(local.name)));
    lines.push(`  br label %${skipLabel}`);
    lines.push(`${skipLabel}:`);
  }
}
