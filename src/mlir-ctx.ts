// What every part of a build reads about the module as a whole: type layout (src/layout.ts),
// function signatures and which of them return through an sret pointer, the C ABI class of
// each extern that passes a struct by value, ownership facts (src/owned-temp.ts), function
// and parameter attributes, and the panic-message paths. src/emit-mlir.ts asks it through
// MlirEmitCtx; src/scaffold.ts and src/mlir-backend.ts read it directly.
import { isAbsolute, relative, resolve } from "path";
import type { BackendProgram, FnDecl, GlobalDecl, StructDecl } from "./backend-program";
import type { FormOf } from "./emit-forms";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { TargetInfo } from "./target";
import type { MlirEmitCtx } from "./emit-mlir";
import { Layout, HASHMAP_FIELDS } from "./layout";
import { Ownership } from "./owned-temp";
import { classifyArg, classifyRet, AbiError, type ArgClass, type RetClass, type AbiStruct, type AbiLeaf } from "./abi";
import { cDeclGuards, type CSigClaim, type CValueClaim } from "./c-guards";
import { display } from "./mangle";
import { STDLIB_DIR } from "./stdlibBundle";
import { must } from "./must";
import { ATOMIC_INTRINSICS, atomicFn, vecGrowFn } from "./runtime-ir";
import { RETAINING_LIBC, noaliasGrants } from "./noalias";
import type { StartupPlan } from "./startup";
import { PUBLIC_BUILTIN_FNS } from "./builtin-names";

export interface BuildOptions {
  filePath?: string;
  trapOnOverflow: boolean;
  emitDebug: boolean;
  contractChecks: boolean;
  // Blank the source path out of every runtime panic message. In a binary shipped to people
  // who will never hold the source, the path describes the build machine's filesystem and
  // nothing else. Line numbers stay: alone they identify nothing, and they are all that is
  // left to correlate a user-reported panic against.
  stripPanicLocations: boolean;
  sanitize: boolean;
}

export interface ExternAbi {
  args: (ArgClass | null)[]; // per fixed param; null = direct (scalar/ptr/ref, no rewrite)
  ret: RetClass;
}

export const BUILTINS = new Set([...PUBLIC_BUILTIN_FNS, "_miloArgCount", "_miloArgAt", "_cstrToString", "_bytesToString", "_strDataPtr", "_putByte", "_loadU8", "_loadI32", "_callClosureVoid", ...Object.keys(ATOMIC_INTRINSICS), "_schedulerGet", "_schedulerSet", "_panicHookSet"]);

const PROCESS_GLOBALS = { argc: "_milo_argc_global", argv: "_milo_argv_global", scheduler: "_milo_scheduler", panicHook: "_milo_panic_hook" } as const;
export const processGlobalNames = PROCESS_GLOBALS;

export class ModuleCtx implements MlirEmitCtx {
  readonly layout = new Layout();
  readonly fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>();
  readonly sretFns = new Set<string>();
  readonly fns = new Map<string, FnDecl>();
  readonly externAbi = new Map<string, ExternAbi>();
  /** Externs whose C ABI shim (`milo.cabi.<f>`) a body calls: src/scaffold.ts defines them. */
  readonly cAbiShims = new Set<string>();
  readonly globals = new Map<string, GlobalDecl>();
  readonly own: Ownership;
  readonly exportedFnNames: Set<string>;
  readonly displayNames?: Map<string, string>;
  plan!: StartupPlan;
  // Per fn, its by-ref params' attributes and which of them may be noalias.
  private readonly refAttrs = new Map<string, (string[] | null)[]>();
  private noalias = new Map<string, Set<number>>();
  private readonly userDeclaredFns = new Set<string>();
  private readonly userFnNames: Set<string>;
  private readonly cLayoutStructs: StructDecl[] = [];
  private readonly cSigs: CSigClaim[];
  private readonly cValues: CValueClaim[];
  private readonly opaqueTypes: Set<string>;

  constructor(readonly module: BackendProgram, readonly target: TargetInfo, readonly opts: BuildOptions) {
    this.layout.ptrBytes = target.arch === "arm" ? 4 : 8;
    this.layout.build(module);
    for (const s of module.structs) if (s.cLayout) this.cLayoutStructs.push(s);
    this.cSigs = module.cSigs ?? [];
    this.opaqueTypes = new Set(module.opaqueTypes ?? []);
    this.cValues = module.cValues ?? [];
    this.exportedFnNames = module.exportedFnNames ?? module.userFnNames ?? new Set();
    this.userFnNames = module.userFnNames ?? new Set();
    this.displayNames = module.displayNames;
    for (const g of module.globals) this.globals.set(g.name, g);
    for (const fn of module.functions) {
      this.fns.set(fn.name, fn);
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
      if (fn.isExtern) this.classifyExtern(fn);
    }
    this.own = new Ownership(this.layout, this.fns, module.facts);
    // A big aggregate is never a first-class SSA value (Ownership.isBigAgg): a fn returning
    // one writes it through a hidden first `ptr` param. Exported fns keep their C signature.
    for (const fn of module.functions) {
      if (fn.isExtern || fn.name === "main" || this.userFnNames.has(fn.name)) continue;
      if (this.own.isBigAgg(this.llvmType(fn.retType))) this.sretFns.add(fn.name);
    }
  }

  // ── what emit-mlir asks (MlirEmitCtx) ──
  get facts() { return this.module.facts; }
  calleesOf(name: string) { return this.module.callees.get(name); }
  get lazyGlobals(): ReadonlySet<string> { return new Set(this.plan.lazyGlobals.keys()); }
  get trapOnOverflow() { return this.opts.trapOnOverflow; }
  get emitDebug() { return this.opts.emitDebug; }
  get contractChecks() { return this.opts.contractChecks; }
  get structLayouts() { return this.layout.structLayouts; }
  get dropImpls() { return this.layout.dropImpls; }
  get hasStringType() { return this.layout.hasStringType; }
  set hasStringType(v: boolean) { this.layout.hasStringType = v; }
  get hasVecType() { return this.layout.hasVecType; }
  set hasVecType(v: boolean) { this.layout.hasVecType = v; }
  get retainingLibc(): ReadonlySet<string> { return RETAINING_LIBC; }
  // A record/replay engine fn (FnDecl.replayEngine) raises its thread's engine depth on
  // entry and lowers it before every return, while the fixed heap is on.
  get replayScope(): boolean { return this.globals.has("replay$rrDepth") && this.globals.has("replay$rrHeapOn"); }
  get mlirMainOk(): boolean { return !this.plan.greenMain; }

  llvmType(t: TypeKind): string { return this.layout.llvmType(t); }
  needsDropCg(t: TypeKind): boolean { return this.layout.needsDropCg(t); }
  typeSizeOf(t: TypeKind): number { return this.layout.typeSizeOf(t); }
  mapSlotLayout(k: TypeKind, v: TypeKind) { return this.layout.mapSlotLayout(k, v); }
  /** A builtin the program has not shadowed with its own fn of the same name. */
  isBuiltinName(name: string): boolean { return BUILTINS.has(name) && !this.userDeclaredFns.has(name); }
  mlirBlockValueOwnsResult(e: FormOf<"IfExpr" | "MatchExpr">): boolean { return this.own.blockValueOwnsResult(e); }
  mlirClosureParamEscapes(fnName: string, idx: number): boolean { return this.own.closureParamEscapes(fnName, idx); }
  mlirStrViewStep(): string { return "rtStrViewStep"; }
  mlirOutWrite(stderr: boolean): string { return stderr ? "milo.err.write" : "milo.out.write"; }
  mlirPanicText(): string { return "milo.panic.text"; }
  mlirAtomic(builtin: string): string | null { return atomicFn(builtin); }
  mlirVecGrow(elemSize: number): string { return vecGrowFn(this.target, elemSize); }
  mlirItable(from: string, iface: string): string { return `itable.${from}.${iface}`; }
  mlirProcessGlobal(which: keyof typeof PROCESS_GLOBALS): string { return PROCESS_GLOBALS[which]; }
  mlirDisplayName(name: string): string { return display(this.displayNames, name); }
  mlirIfaceMethodCount(name: string): number | null {
    const it = this.module.itables.find(i => i.ifaceName === name);
    return it ? it.methods.length : null;
  }
  // Set by MlirPlan: the drop glue an itable of `concrete` ends in (src/mlir-glue.ts), or null.
  mlirItableDrop: (concrete: string) => string | null = () => null;
  // Set by MlirPlan under -g (src/mlir-debug.ts).
  debugFnLoc: (fn: FnDecl, loc: string) => string = (_fn, loc) => loc;
  debugClosureLoc: (name: string, span: Span | undefined, loc: string) => string = (_n, _s, loc) => loc;

  /** `milo.cabi.<f>`, the shim that crosses the C ABI for extern f, or null when f needs none. */
  mlirCAbiShim(name: string, _variadic: boolean): string | null {
    if (!this.externAbi.has(name)) return null;
    this.cAbiShims.add(name);
    return `milo.cabi.${name}`;
  }

  mlirFieldOffset(struct: string, field: string): number {
    const layout = this.structLayouts.get(struct);
    const idx = layout ? layout.fields.findIndex(f => f.name === field) : -1;
    return layout && idx >= 0 ? this.layout.structFieldOffset(layout.fields.map(f => f.type), idx) : 0;
  }

  mlirGlobal(name: string): { type: TypeKind; threadLocal: boolean } | null {
    const g = this.globals.get(name);
    return g ? { type: g.type, threadLocal: !!g.threadLocal } : null;
  }

  /**
   * Enum `name`'s layout (EnumLayout), for the dialect's !milo.enum to spell out. A
   * niche-packed one has no tag word: its payload is at offset 0 and `niche` says which
   * integer value there is the fieldless variant.
   */
  mlirEnumLayout(name: string): { size: number; align: number; niche?: { intTy: string; value: string }; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null {
    const l = this.layout.enumLayouts.get(name);
    if (!l) return null;
    const n = l.niche;
    return {
      size: l.size,
      align: Math.max(4, l.payloadAlign),
      niche: n && { intTy: n.intTy, value: n.value },
      variants: [...l.variants].map(([vn, v]) => ({ name: vn, tag: v.tag, fields: v.fieldTypeKinds, offsets: n ? v.fieldTypes.map(() => 0) : this.layout.variantFieldOffsets(v.fieldTypes) })),
    };
  }

  // A check's location as panic messages print it, or null when there is no file to name.
  // The span's own file over the file being compiled: a panic can fire inside an imported
  // module (a `!` in std/fs), and blaming the entry file sends the reader to the wrong line.
  checkLocation(span?: Span): { file: string; line: number; col: number } | null {
    const file = span?.file ?? this.opts.filePath;
    if (!file) return null;
    return { file: this.displayPath(file), line: span?.line ?? 0, col: span?.col ?? 0 };
  }

  // The path a panic message shows. An absolute one bakes the *compiling* machine's directory
  // layout (and its username) into every binary that ships, so print it the way the author
  // would type it: relative to the working directory, or `std/x.milo` for a stdlib file.
  // DWARF paths are deliberately left absolute (src/mlir-debug.ts); a debugger needs those.
  private displayPath(file: string): string {
    if (this.opts.stripPanicLocations) return "<stripped>";
    if (!isAbsolute(file)) return file;
    for (const base of [process.cwd(), STDLIB_DIR]) {
      const rel = relative(base, file);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
    }
    return file;
  }

  // ── function attributes ──

  // Facts every by-ref argument satisfies: the caller passes the address of a live place of
  // the pointee type (refs are second-class, so none is ever null, stored or dangling across
  // the call). A zero-sized pointee gets nothing: its "place" may be a null or dangling
  // address (an element of a Vec of ZSTs), and dereferenceable(0) says nothing anyway.
  // Callers that are not Milo get nothing either: extern decls and exported symbols keep the
  // plain C ABI, since a C caller makes none of these promises.
  private refParamAttrs(fn: FnDecl, p: FnDecl["params"][number]): string[] | null {
    if (!(p.isRef || p.isRefMut) || fn.isExtern || fn.name === "main" || this.exportedFnNames.has(fn.name)) return null;
    const ty = this.llvmType(p.type);
    if (!this.layout.layoutExact(ty)) return null;
    const size = this.layout.typeSize(ty);
    if (size === 0) return null;
    return ["llvm.nonnull", `llvm.dereferenceable = ${size} : i64`, `llvm.align = ${this.layout.typeAlign(ty)} : i64`];
  }

  /** Decides noalias for every `&mut` param of `fns` (src/noalias.ts); before any body is emitted. */
  planAttributes(fns: FnDecl[]): void {
    const candidates = new Map<string, number[]>();
    for (const fn of fns) {
      const attrs = fn.params.map(p => this.refParamAttrs(fn, p));
      this.refAttrs.set(fn.name, attrs);
      const muts = fn.params.flatMap((p, i) => attrs[i] && p.isRefMut ? [i] : []);
      if (muts.length) candidates.set(fn.name, muts);
    }
    const externs = new Map(this.module.functions.filter(f => f.isExtern).map(f => [f.name, f]));
    this.noalias = noaliasGrants({
      functions: fns,
      externs,
      mutableGlobals: new Set(this.module.globals.filter(g => g.mutable).map(g => g.name)),
      exported: this.exportedFnNames,
      facts: this.module.facts,
      callees: this.module.callees,
      lazyGlobals: new Set(this.plan.lazyGlobals.keys()),
      replayGlobals: this.replayScope ? ["replay$rrDepth", "replay$rrHeapOn"] : [],
      dropRuns: t => this.dropRuns(t),
    }, candidates);
  }

  /** The `{...}` attribute dictionary of param `i` of `fn` in the dialect, or "". */
  paramAttrs(fn: string, i: number): string {
    const a = this.refAttrs.get(fn)?.[i];
    if (!a) return "";
    return ` {${[...(this.noalias.get(fn)?.has(i) ? ["llvm.noalias"] : []), ...a].join(", ")}}`;
  }

  /** The `attributes {...}` of `fn`'s func.func: linkage and pass-through LLVM attributes. */
  fnAttrs(fn: FnDecl, name: string): string {
    const a: string[] = [];
    // Non-root fns are internal (like globals): each object carries its own copy.
    // linkonce_odr let the linker merge same-named fns across separately-compiled objects
    // and silently pick one body when they differed (issue #5).
    if (name !== "main" && (name !== fn.name || !this.exportedFnNames.has(fn.name))) a.push("llvm.linkage = #llvm.linkage<internal>");
    if (fn.alwaysInline) a.push(`llvm.passthrough = ["alwaysinline"]`);
    return a.length ? ` attributes {${a.join(", ")}}` : "";
  }

  // Whether dropping a value of `t` can run a user Drop impl, or code nobody can name (an
  // interface's destructor through its itable, an owning closure's env drop).
  private readonly dropMemo = new WeakMap<TypeKind, { user: boolean; unknown: boolean }>();
  private dropRuns(t: TypeKind): { user: boolean; unknown: boolean } {
    const known = this.dropMemo.get(t);
    if (known) return known;
    const r = { user: false, unknown: false };
    const seen = new Set<string>();
    const walk = (t: TypeKind): void => {
      switch (t.tag) {
        case "struct": case "enum": {
          if (this.layout.dropImpls.has(t.name)) r.user = true;
          if (seen.has(t.name)) return;
          seen.add(t.name);
          if (t.tag === "struct") for (const f of this.structLayouts.get(t.name)?.fields ?? []) walk(f.typeKind);
          else for (const v of this.layout.enumLayouts.get(t.name)?.variants.values() ?? []) v.fieldTypeKinds.forEach(walk);
          return;
        }
        case "vec": case "array": walk(t.element); return;
        case "heap": if (t.inner.tag === "interface") r.unknown = true; else walk(t.inner); return;
        case "hashmap": walk(t.key); walk(t.value); return;
        case "interface": r.unknown = true; return;
        case "fn": if (t.owning) r.unknown = true; return;
        default: return;
      }
    };
    walk(t);
    this.dropMemo.set(t, r);
    return r;
  }

  // ── the C ABI of externs passing a struct by value ──

  private classifyExtern(fn: FnDecl): void {
    // A `&Struct`/`*Struct` param crosses by reference (already "ptr"), so only bare
    // struct-tagged params/returns need classification.
    const byValStruct = (t: TypeKind, isRef: boolean) => t.tag === "struct" && !isRef;
    const wantsAbi = byValStruct(fn.retType, false) || fn.params.some(p => byValStruct(p.type, !!(p.isRef || p.isRefMut)));
    if (!wantsAbi) return;
    try {
      const args = fn.params.map(p => byValStruct(p.type, !!(p.isRef || p.isRefMut))
        ? classifyArg(this.target.arch, this.abiStructOf((p.type as { name: string }).name), this.target.os)
        : null);
      const ret: RetClass = byValStruct(fn.retType, false)
        ? classifyRet(this.target.arch, this.abiStructOf((fn.retType as { name: string }).name), this.target.os)
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

  // Flatten a struct's scalar leaves (offset/size/float-ness) for ABI classification: HFA
  // detection and SysV eightbyte SSE/INTEGER merging need per-leaf info, not just size.
  private abiLeaves(name: string, base: number): AbiLeaf[] {
    const layout = must(this.structLayouts, name, "struct layouts");
    const fieldTypes = layout.fields.map(f => f.type);
    const out: AbiLeaf[] = [];
    layout.fields.forEach((f, i) => out.push(...this.leavesOf(f.typeKind, base + this.layout.structFieldOffset(fieldTypes, i))));
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
        const stride = this.layout.typeSize(this.llvmType(t.element));
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
    return { name, size: this.layout.structPayloadSize(fieldTypes), align: this.layout.structAlign(fieldTypes), leaves: this.abiLeaves(name, 0) };
  }

  // ── LLVM types in the LLVM dialect's spelling ──

  /** `ty` (LLVM IR text, as src/layout.ts spells it) as an LLVM-dialect type; null for void. */
  dialectType(ty: string): string | null {
    ty = ty.trim();
    if (ty === "void") return null;
    if (ty === "ptr") return "!llvm.ptr";
    if (ty === "float") return "f32";
    if (ty === "double") return "f64";
    if (/^i\d+$/.test(ty)) return ty;
    const arr = /^\[(\d+) x (.*)\]$/.exec(ty);
    if (arr) return `!llvm.array<${arr[1]} x ${this.dialectType(arr[2])}>`;
    if (ty.startsWith("{")) return `!llvm.struct<(${splitTop(ty.slice(1, -1)).map(t => this.dialectType(t)).join(", ")})>`;
    if (ty.startsWith("%")) {
      const name = ty.slice(1).replace(/^"(.*)"$/, "$1");
      return `!llvm.struct<"${name}", (${this.namedBody(name).map(t => this.dialectType(t)).join(", ")})>`;
    }
    throw new Error(`mlir: no LLVM-dialect spelling for ${ty}`);
  }

  // The body of a named type as mlir/Scalar.cpp's type converter builds it.
  private namedBody(name: string): string[] {
    if (name === "String" || name === "Vec") return ["ptr", "i64", "i64"];
    if (name === "HashMap") return ["ptr", ...Array<string>(HASHMAP_FIELDS - 1).fill("i64")];
    const s = this.structLayouts.get(name);
    if (s) return s.fields.map(f => f.type);
    const e = this.layout.enumLayouts.get(name);
    if (!e) throw new Error(`mlir: no layout for %${name}`);
    if (e.niche) return [e.niche.payloadTy];
    return [e.size > 0 ? this.layout.enumStorageTy(e) : "i32"];
  }

  /** The @cLayout/@cSig/@cValue guard TU (src/c-guards.ts), or null when nothing is claimed. */
  cDeclGuards(): string | null {
    return cDeclGuards({ cLayoutStructs: this.cLayoutStructs, cSigs: this.cSigs, cValues: this.cValues, opaqueTypes: this.opaqueTypes, os: this.target.os }, {
      llvmType: t => this.llvmType(t),
      typeSize: ty => this.layout.typeSize(ty),
      structFieldOffset: (f, i) => this.layout.structFieldOffset(f, i),
      structPayloadSize: f => this.layout.structPayloadSize(f),
    });
  }

  /** The absolute path DWARF names for `file`. */
  dwarfPath(file: string | undefined): string { return resolve(file ?? this.opts.filePath ?? "<unknown>"); }
}

// Top-level comma split of a struct body (`ptr, { i64, i1 }, [2 x i8]`).
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
