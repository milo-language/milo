// What the backend compiles, read off the merged AST and the checker's result: the module's
// declarations (struct and enum layouts, function signatures, globals, itables, the C-facing
// claims) with each function's body left as the AST it is. src/emit-mlir.ts walks those
// bodies through src/emit-forms.ts; nothing here copies or rewrites one.
import type { Program, Function as AstFn, Expr, Span } from "./ast";
import type { CheckResult } from "./checker";
import type { TypeKind } from "./types";
import { typeFromAst } from "./types";
import { RR_WRAPPER_FILE } from "./replay-externs";
import { Facts, walkAst } from "./emit-forms";
import { trackCallerInstances } from "./track-caller";

export interface FnParam { name: string; type: TypeKind; isRef: boolean; isRefMut: boolean }

/** A function the backend declares or defines: its signature and attributes, and where its body is. */
export interface FnDecl {
  name: string;
  params: FnParam[];
  retType: TypeKind;
  isExtern: boolean;
  // An extern's C symbol when it differs from `name` (see the AST field of the same name).
  linkName?: string;
  isVariadic: boolean;
  // @wrapping: + - * -x, div INT_MIN/-1 and over-shifts wrap instead of trapping.
  isWrapping?: boolean;
  // The generated C header declares only `pub` fns: it is the library's published API.
  isPub?: boolean;
  // @trackCaller (std collection modules): one copy per call site (src/track-caller.ts);
  // a copy carries the call span its panics report.
  trackCaller?: boolean;
  trackedCaller?: Span;
  // @inline (std collection modules): emitted `alwaysinline`.
  alwaysInline?: boolean;
  sourceFile?: string;
  // 1-based decl-line proxy (the first body statement's): the DISubprogram line.
  line?: number;
  // Part of the record/replay engine (std/replay, a recording hook, a generated extern
  // wrapper): while it runs, its thread's allocations go to libc's malloc.
  replayEngine?: boolean;
  /** The body: the AST function (a @trackCaller copy shares its original's). */
  ast?: AstFn;
  /** A module-global initializer: each global filled with its initializer, in order. */
  inits?: GlobalDecl[];
}

export interface GlobalDecl {
  name: string;
  // Declaring file: a global is DEFINED in exactly one object file and declared external in
  // the others, so per-module codegen needs its owner.
  sourceFile?: string;
  type: TypeKind;
  value: Expr;
  mutable: boolean;
  threadLocal?: boolean;
}

export interface StructDecl {
  name: string;
  // `cName`: the C spelling of the field (`@cName`), for the @cLayout guard and headergen.
  fields: { name: string; type: TypeKind; cOpaque?: boolean; cName?: string }[];
  isExtern?: boolean;
  // From `@cLayout(...)`: verify these field offsets against the real C header at build time.
  cLayout?: { cType: string; header: string };
}

export interface EnumDecl { name: string; variants: { name: string; tag: number; fields: TypeKind[] }[] }

export interface BackendProgram {
  facts: Facts;
  structs: StructDecl[];
  enums: EnumDecl[];
  functions: FnDecl[];
  /** @trackCaller copies: per function name, the callee each of its direct calls names. */
  callees: Map<string, Map<Expr, string>>;
  globals: GlobalDecl[];
  dropImpls: Set<string>;
  itables: { concreteType: string; ifaceName: string; methods: string[] }[];
  // Every entry-file fn and each `@externalLinkage` one (sret lowering, user-code attribution).
  userFnNames: Set<string>;
  // The symbols an object exports: the entry file's `pub` fns, `main`, `@externalLinkage` fns.
  exportedFnNames: Set<string>;
  // Mangled symbol -> as-written name (src/mangle.ts), for the two outputs humans read:
  // the `Name { .. }` text `print` emits for a struct, and the DWARF name.
  displayNames?: Map<string, string>;
  // Opaque extern struct names (no body), for the C header's forward declarations.
  opaqueTypes: string[];
  // From `@cSig(...)`: extern fn signatures to verify against real C headers at build time.
  cSigs: { fnName: string; header: string; sig: string; retType: TypeKind; params?: { type: TypeKind }[] }[];
  // From `@cValue(...)`: integer constants to verify against the C macros they transcribe.
  cValues: { global: string; cName: string; header: string; value: string; signed: boolean }[];
  // From `@link("SDL2")` on extern fns: native libs to pass to the linker.
  linkLibs: string[];
  // Globals whose initializer has to run (CheckResult.nonConstGlobals): `emit-obj --no-entry`
  // has nothing that calls the init, so it rejects on this list.
  nonConstGlobals: string[];
}

const isStdReplayFile = (f: string | undefined) => !!f && /[\\/]std[\\/]replay\.milo$/.test(f);

/** The backend's view of a checked program. `sourceDir` resolves `@embedFile`. */
export function backendProgram(program: Program, c: CheckResult, sourceDir?: string, targetOs?: string, targetArch?: string): BackendProgram {
  // The host by default, so @targetOs() / @targetArch() resolve to something real.
  const os = targetOs ?? (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "darwin");
  const arch = targetArch ?? (process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch);
  const facts = new Facts(c, { os, arch, sourceDir: sourceDir ?? process.cwd() });

  const structs: StructDecl[] = [];
  const opaqueTypes: string[] = [];
  for (const s of program.structs) {
    if (s.typeParams.length > 0) continue;
    const info = c.structs.get(s.name);
    if (!info) continue;
    if (info.isOpaque) { opaqueTypes.push(s.name); continue; }
    structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type, ...(f.cOpaque ? { cOpaque: true } : {}), ...(f.cName ? { cName: f.cName } : {}) })), isExtern: info.isExtern, cLayout: info.cLayout });
  }
  for (const s of c.monomorphizedStructs) {
    const info = c.structs.get(s.name);
    if (info) structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type })), isExtern: info.isExtern });
  }
  for (const s of c.anonStructs) structs.push({ name: s.name, fields: s.fields.map(f => ({ name: f.name, type: f.type })) });

  const enums: EnumDecl[] = [...c.enums].map(([name, info]) => ({ name, variants: [...info.variants].map(([v, x]) => ({ name: v, tag: x.tag, fields: x.fields })) }));

  const replayFns = new Set(program.functions.filter(f => isStdReplayFile(f.sourceFile)).map(f => f.name));
  const functions: FnDecl[] = [];
  for (const fn of program.functions) {
    if (fn.isExtern) functions.push(externDecl(fn, facts));
    else if (fn.typeParams.length === 0) functions.push(fnDecl(fn, facts, replayFns));
  }
  for (const fn of c.monomorphizedFns) functions.push(fnDecl(fn, facts, replayFns));

  const globals: GlobalDecl[] = program.globals.map(g => ({
    name: g.name,
    type: (g.type ? c.globalTypes?.get(g.name) ?? typeFromAst(g.type) : c.globalTypes?.get(g.name)) ?? { tag: "unknown" },
    value: g.value,
    mutable: g.mutable,
    threadLocal: g.threadLocal,
    ...(g.span?.file && { sourceFile: g.span.file }),
  }));

  // A `?` or `.context` that boxes its error needs the same itable an explicit coercion
  // would, and every `.context` boxes the ErrorContext it builds.
  const coercions = [...c.interfaceCoercions.values(), ...c.propagateBoxings.values(), ...c.contextBoxings.values()];
  if (usesContext(program, c, functions)) coercions.push({ fromType: "ErrorContext", ifaceName: "Error" });
  const itableMap = new Map<string, { concreteType: string; ifaceName: string; methods: string[] }>();
  for (const co of coercions) {
    const key = `${co.fromType}.${co.ifaceName}`;
    const iface = c.interfaces.get(co.ifaceName);
    if (itableMap.has(key) || !iface) continue;
    itableMap.set(key, { concreteType: co.fromType, ifaceName: co.ifaceName, methods: [...iface.methods.keys()].map(m => facts.concreteMethodFn(co.fromType, m)) });
  }

  // Each @cSig paired with the Milo signature it claims to mirror: the C signature is the
  // truth, and the Milo declaration's widths must agree.
  const cSigs = [...c.cSigs.entries()].flatMap(([fnName, s]) => {
    const fn = functions.find(f => f.name === fnName);
    return fn ? [{ fnName: fn.linkName ?? fnName, header: s.header, sig: s.sig, retType: fn.retType, params: fn.params.map(p => ({ type: p.type })) }] : [];
  });
  // @cValue's literal as text: the checker accepts only an integer literal (optionally
  // negated), so this is exactly what the author transcribed from the header.
  const cValues = [...c.cValues.entries()].flatMap(([name, cv]) => {
    const g = program.globals.find(x => x.name === name);
    if (!g) return [];
    const neg = g.value.kind === "UnaryOp";
    const lit = (neg ? (g.value as { operand: { value: bigint } }).operand : g.value as { value: bigint }).value;
    const type = c.globalTypes?.get(name);
    return [{ global: name, cName: cv.cName, header: cv.header, value: `${neg ? "-" : ""}${lit}`, signed: type?.tag === "int" ? type.signed : true }];
  });
  // @externalLinkage joins the entry program's functions in getting external linkage: an
  // imported module's fns are internal, invisible to a dlopen'd library resolving against us.
  const userFnNames = new Set(program.userFnNames ?? []);
  for (const fn of program.functions) if (fn.attributes?.some(a => a.name === "externalLinkage")) userFnNames.add(fn.name);
  // Symbols: `pub` is the boundary the header already uses.
  const exportedFnNames = new Set<string>();
  for (const fn of program.functions) {
    if (fn.name === "main" || fn.attributes?.some(a => a.name === "externalLinkage")) exportedFnNames.add(fn.name);
    else if (fn.isPub && program.userFnNames?.has(fn.name)) exportedFnNames.add(fn.name);
  }
  const linkLibs: string[] = [];
  for (const fn of program.functions) for (const attr of fn.attributes ?? []) {
    if (attr.name === "link") for (const lib of attr.args) if (!linkLibs.includes(lib)) linkLibs.push(lib);
  }
  const { copies, callees } = trackCallerInstances(functions, facts);
  return {
    facts, structs, enums, functions: [...functions, ...copies], callees, globals, dropImpls: c.dropImpls,
    itables: [...itableMap.values()], userFnNames, exportedFnNames, displayNames: program.displayNames, opaqueTypes,
    cSigs, cValues, linkLibs, nonConstGlobals: c.nonConstGlobals,
  };
}

function externDecl(fn: AstFn, fx: Facts): FnDecl {
  const sig = fx.c.functions.get(fn.name);
  return {
    name: fn.name,
    ...(fn.sourceFile && { sourceFile: fn.sourceFile }),
    ...(fn.linkName && { linkName: fn.linkName }),
    params: fn.params.map((p, i) => fx.param(p, sig?.params[i]?.type)),
    retType: sig?.ret ?? typeFromAst(fn.retType),
    isExtern: true,
    isVariadic: fn.isVariadic,
  };
}

function fnDecl(fn: AstFn, fx: Facts, replayFns: Set<string>): FnDecl {
  const sig = fx.c.functions.get(fn.name);
  // A synthesized fn (derive glue) has no body spans; its span is the type that produced it.
  const line = fn.body.map(s => s.span?.line).find(x => x !== undefined) ?? fn.span?.line;
  return {
    name: fn.name,
    params: fn.params.map((p, i) => fx.param(p, sig?.params[i]?.type)),
    retType: sig?.ret ?? typeFromAst(fn.retType),
    isExtern: false,
    isVariadic: fn.isVariadic,
    ast: fn,
    ...((fn.fromWrappingModule || fn.attributes?.some(a => a.name === "wrapping")) && { isWrapping: true }),
    ...(fn.isPub && { isPub: true }),
    ...(fn.attributes?.some(a => a.name === "inline") && { alwaysInline: true }),
    ...(fn.attributes?.some(a => a.name === "trackCaller") && { trackCaller: true }),
    ...(fn.sourceFile && { sourceFile: fn.sourceFile }),
    ...(isReplayEngine(fn, replayFns) && { replayEngine: true }),
    // AST fns carry no span: the first body statement's line stands in for the decl's.
    ...(line !== undefined && { line }),
  };
}

// Whether `fn` belongs to the record/replay engine: std/replay itself except its allocator,
// a generated extern wrapper, a `@replayHooked` fn, or any fn that calls into std/replay (a
// hook). The allocator is left out because it is what reads the flag, on every allocation.
function isReplayEngine(fn: AstFn, replayFns: Set<string>): boolean {
  if (replayFns.size === 0) return false;
  if (isStdReplayFile(fn.sourceFile)) return !/heap|Heap/.test(fn.name);
  if (fn.sourceFile === RR_WRAPPER_FILE || fn.attributes?.some(a => a.name === "replayHooked")) return true;
  let calls = false;
  walkAst(fn.body, n => {
    if (!calls && n.kind === "Call" && replayFns.has(n.func) && !/heap|Heap/.test(n.func)) calls = true;
  });
  return calls;
}

// Any `.context` on a Result in a compiled body: it builds an ErrorContext boxed as an Error.
function usesContext(program: Program, c: CheckResult, fns: FnDecl[]): boolean {
  let found = false;
  const bodies = [...fns.map(f => f.ast?.body ?? []), ...program.globals.map(g => g.value)];
  for (const b of bodies) {
    walkAst(b, n => {
      if (found || n.kind !== "MethodCall" || n.method !== "context") return;
      let t = c.exprTypes.get(n.object);
      if (t?.tag === "ref") t = t.inner;
      if (t?.tag === "enum" && c.enums.get(t.name)?.baseName === "Result") found = true;
    });
  }
  return found;
}
