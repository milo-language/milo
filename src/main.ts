// CLI driver: subcommand dispatch for build/run/emit-*/test/fmt/lsp and the rest of
// the surface described in src/cli-help.ts.
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, statSync } from "fs";
import { WARNING_NAMES } from "./warnings";
import { projectLints } from "./pkg";
import { execSync, spawnSync, spawn } from "child_process";
import { guardedRun, monitorPidTree, DEFAULT_MEM_MB } from "../scripts/guard";
import { fileURLToPath } from "url";
import { basename, resolve, dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker } from "./checker";
import { Codegen } from "./codegen";
import { CodegenJS } from "./codegen-js";
import { lower } from "./lower";
import { resolveImports } from "./resolver";
import { display } from "./mangle";
import { generateHeader } from "./headergen";
import { writeStdout } from "./stdout";
import { formatDiagnostic, ParseError, RESET, BOLD, GREEN, DIM, type WarningConfig, type Diagnostic } from "./diagnostics";
import { type TargetInfo, getHostTarget, resolveTarget, listTargets, UnsupportedHostError } from "./target";
import { generateVerificationConditions, formatVerifyReport, proveWithZ3, formatProveReport, proveJson } from "./verify";
import { proveWithMilo } from "./prove-milo";
import { parseSafetyLevel, checkSafetyCompliance, requiresUsedResults, formatSafetyReport, safetyJson, listSafetyLevels } from "./safety";
import { versionString } from "./version";
import { extractFlowFacts, formatFlowFacts } from "./wcet";
import { estimateLoopCycles, formatCycleEstimate } from "./wcet-cycles";
import { PKG_COMMANDS, ensureDepsInstalled } from "./pkgcli";
import { renderHelp, knownCommandNames } from "./cli-help";
import { ensureFmtBinary } from "./fmtbin";
import { splitModule, type SplitStats } from "./cgu";

// `--cgus=N` (also MILO_CGUS): how many codegen units to hand clang. Module-level rather
// than threaded through compileToBinary's parameter list, which is already at its limit —
// linkIR is the only reader and it already consults process state (MILO_VERBOSE) here.
// null = auto.
let cguOverride: number | null = null;

// Measured 2026-08-04: at ~5.7k IR lines splitting LOSES ~0.03s (clang startup and the
// duplicated preamble outweigh the parallelism); by ~49k lines it wins 1.9x. This sits
// deliberately below the observed crossover but well above the small programs that would
// only pay the overhead.
const CGU_MIN_IR_LINES = 20_000;
// More units is uniformly better above the threshold — 8 beat 4 beat 2 on every program
// measured, including 55k-line ones — so unit count tracks available cores rather than
// module size. Sizing by lines/N instead starved a 55k-line module to 2 units and made it
// SLOWER than not splitting at all.
const CGU_MAX_UNITS = 8;

/**
 * How many codegen units this build should use. clang is ~95% of build time and
 * parallelises near-linearly across processes, but splitting costs cross-unit inlining —
 * so this is a dev-loop optimization that release builds opt out of.
 */
function cguCount(irLineCount: number, optFlag: string, emitDebug: boolean): number {
  // cmd.exe has no `&`/`wait`, so the parallel driver below cannot run there.
  if (process.platform === "win32") return 1;
  // Promotion renames module-local symbols, but a DISubprogram's `linkageName` would keep
  // the old one — a debugger would then fail to match frames to functions. Debug builds
  // are -O0 and already fast, so decline rather than half-fix the metadata.
  if (emitDebug) return 1;
  const explicit = cguOverride ?? (process.env.MILO_CGUS ? Number(process.env.MILO_CGUS) : null);
  if (explicit !== null && Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit));
  // -O3 means the user asked for the best code we can produce; whole-module inlining is
  // part of that answer.
  if (optFlag === "-O3") return 1;
  if (irLineCount < CGU_MIN_IR_LINES) return 1;
  const cores = Math.max(1, (navigator.hardwareConcurrency ?? 8) - 2);
  return Math.max(2, Math.min(CGU_MAX_UNITS, cores));
}

function frontendToHIR(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig) {
  const sourceDir = filePath ? dirname(resolve(filePath)) : process.cwd();
  let tokens, program;
  try {
    tokens = new Lexer(source).tokenize();
    program = new Parser(tokens, source, filePath).parse();
    program = resolveImports(program, sourceDir, target, filePath);
  } catch (e: any) {
    // Parse errors carry a structured Diagnostic — render the source line + caret
    // + hint (same Elm-style output as type errors). Errors from imported files
    // carry their own source/path; fall back to the entry file otherwise.
    if (e instanceof ParseError) {
      console.error(formatDiagnostic(e.diagnostic, e.source ?? source, e.filePath ?? filePath));
    } else {
      console.error(e.message);
    }
    process.exit(1);
  }

  const result = new TypeChecker(warningConfig).check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  const warnings = result.diagnostics.filter(d => d.severity !== "error");
  // Diagnostics from imported modules carry span.file; resolve their source off
  // disk (cached) so the caret renders against the right file, not the entry.
  const srcCache = new Map<string, string | undefined>();
  const resolveSource = (f: string): string | undefined => {
    if (f === filePath) return source;
    if (!srcCache.has(f)) {
      try { srcCache.set(f, readFileSync(f, "utf-8")); } catch { srcCache.set(f, undefined); }
    }
    return srcCache.get(f);
  };
  for (const d of warnings) console.error(formatDiagnostic(d, source, filePath, resolveSource));
  if (errors.length > 0) {
    for (const d of errors) console.error(formatDiagnostic(d, source, filePath, resolveSource));
    process.exit(1);
  }

  const hir = lower(program, result, sourceDir, target.os);
  // Attached here rather than inside `lower`: the map is a resolver fact codegen renders
  // through (print text, DWARF names), not anything lowering computes or reads.
  hir.displayNames = program.displayNames;
  return hir;
}

// `milo check <file> [--json]` — parse + resolve + type-check, report, stop. No codegen.
//
// The JSON form is a PUBLIC surface (schema 1): CI annotations, editors that do not speak
// LSP, and fuzzers that want to classify a rejection by diagnostic code instead of
// grepping the rendered message. Before it, every consumer outside this repo had to parse
// Elm-style terminal output — or import the TypeScript, which only in-repo code can do.
const CHECK_JSON_SCHEMA = 1;

function runCheck(source: string, filePath: string, target: TargetInfo, warningConfig: WarningConfig | undefined, json: boolean): void {
  const sourceDir = dirname(resolve(filePath));
  let diagnostics: Diagnostic[] = [];
  try {
    const tokens = new Lexer(source).tokenize();
    let program = new Parser(tokens, source, filePath).parse();
    program = resolveImports(program, sourceDir, target, filePath);
    diagnostics = new TypeChecker(warningConfig).check(program).diagnostics;
  } catch (e: any) {
    // A parse error ends the run, but it is still a diagnostic — a consumer should not
    // have to handle "crashed" and "rejected" as two different shapes.
    if (e instanceof ParseError) diagnostics = [e.diagnostic];
    else if (json) diagnostics = [{ severity: "error", message: e.message }];
    else { console.error(e.message); process.exit(1); }
  }

  const errors = diagnostics.filter(d => d.severity === "error");
  if (json) {
    writeStdout(JSON.stringify({
      schema: CHECK_JSON_SCHEMA,
      file: filePath,
      ok: errors.length === 0,
      diagnostics: diagnostics.map(d => ({
        severity: d.severity,
        ...(d.code ? { code: d.code } : {}),
        message: d.message,
        ...(d.hint ? { hint: d.hint } : {}),
        // A diagnostic from an imported module carries its own file; the entry file is
        // the fallback, not the answer.
        file: d.span?.file ?? filePath,
        ...(d.span ? { line: d.span.line, col: d.span.col, len: d.len ?? 1 } : {}),
      })),
    }, null, 2) + "\n");
    process.exit(errors.length ? 1 : 0);
  }

  const srcCache = new Map<string, string | undefined>();
  const resolveSource = (f: string): string | undefined => {
    if (f === filePath) return source;
    if (!srcCache.has(f)) {
      try { srcCache.set(f, readFileSync(f, "utf-8")); } catch { srcCache.set(f, undefined); }
    }
    return srcCache.get(f);
  };
  for (const d of diagnostics) console.error(formatDiagnostic(d, source, filePath, resolveSource));
  if (errors.length) process.exit(1);
  console.log(`${filePath}: ok`);
}

function compile(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig, trapOnOverflow = false, emitDebug = false, contractChecks = false, stripPanicLocations = false, sanitize = false): string {
  return compileWithGuards(source, target, filePath, warningConfig, trapOnOverflow, emitDebug, contractChecks, stripPanicLocations, sanitize).ir;
}

// Parse + resolve imports + type-check, rendering ParseErrors as clean Elm-style
// diagnostics instead of leaking a JS stack trace. Analysis subcommands (verify/
// wcet/prove/safety) that stop short of codegen share this so a syntax error is
// reported the same way `build` reports it, not as an uncaught exception.
// `diagnosticsOut`, when given, receives the checker's diagnostics; the safety command
// reads its `unused-result` findings from there, since src/safety.ts has no types.
function parseCheckProgram(src: string, target: TargetInfo, filePath: string, warningConfig?: WarningConfig, diagnosticsOut?: Diagnostic[]) {
  const sourceDir = dirname(resolve(filePath));
  try {
    const tokens = new Lexer(src).tokenize();
    let program = new Parser(tokens, src, filePath).parse();
    program = resolveImports(program, sourceDir, target, filePath);
    const result = new TypeChecker(warningConfig).check(program);
    diagnosticsOut?.push(...result.diagnostics);
    return program;
  } catch (e: any) {
    if (e instanceof ParseError) {
      console.error(formatDiagnostic(e.diagnostic, e.source ?? src, e.filePath ?? filePath));
    } else {
      console.error(e.message);
    }
    process.exit(1);
  }
}

// `cGuards` is the `@cLayout`/`@cSig` verification TU (null when the program declares
// neither) — see Codegen.cDeclGuards. It rides alongside the IR because only codegen
// knows the field offsets and return widths it asserts.
function compileWithGuards(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig, trapOnOverflow = false, emitDebug = false, contractChecks = false, stripPanicLocations = false, sanitize = false): { ir: string; cGuards: string | null; linkLibs: string[]; hasMain: boolean; nonConstGlobals: string[] } {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  const cg = new Codegen(target, filePath, trapOnOverflow, emitDebug, contractChecks, stripPanicLocations, sanitize);
  const ir = cg.generate(hirModule);
  // Reported by the caller that is actually linking an executable, not here: emit-ir /
  // emit-obj / emit-hir on a module with no main are all legitimate.
  const hasMain = hirModule.functions.some(f => f.name === "main" && !f.isExtern);
  return { ir, cGuards: cg.cDeclGuards(), linkLibs: hirModule.linkLibs ?? [], hasMain,
           nonConstGlobals: hirModule.nonConstGlobals ?? [] };
}

// Compile the @cLayout/@cSig guard TU against the real system headers and fail the build
// if any _Static_assert trips.
// Include flags for the guard TU's third-party headers. The compiler links `@link` libs
// by name and never needs their headers to build, so nothing else in the build carries an
// -I; a `@cSig("SDL2/SDL.h", ...)` would otherwise fail with "file not found" on any
// Homebrew Mac. pkg-config is what knows the prefix, and it answers the same on apt.
function pkgConfigCflags(linkLibs: string[]): string {
  const flags: string[] = [];
  for (const lib of linkLibs) {
    // `@link("SDL2")` is the -l name; pkg-config's module is `sdl2`. Try the name as
    // written first so a lib whose .pc really is capitalised still resolves.
    for (const mod of [lib, lib.toLowerCase()]) {
      try {
        const out = execSync(`pkg-config --cflags ${mod}`, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (out) flags.push(out);
        break;
      } catch { /* no .pc for this spelling — try the next, then give up quietly */ }
    }
  }
  return flags.join(" ");
}

// The guard TU emits `#warning "milo-guard-skip: <header>"` for every header that isn't on
// this machine. Those claims went unchecked, and an unverified guard that looks verified is
// worse than no guard, so each one is named here. Everything else the C compiler said —
// deprecation notices from the headers themselves, most of all — is not this program's
// business and is dropped.
function reportGuardSkips(output: string): void {
  const skipped = new Set<string>();
  for (const m of output.matchAll(/milo-guard-skip:\s*([^"\n]+)/g)) skipped.add(m[1]!.trim());
  for (const h of skipped) {
    console.error(`warning: @cLayout/@cSig/@cValue guards for '${h}' skipped — no such header on this machine, so those declarations went unchecked`);
  }
}

function verifyCDecls(cGuards: string | null, target: TargetInfo, linkLibs: string[] = []): void {
  if (!cGuards) return;
  // The guard TU is compiled with the host cc against the host's headers, so it only
  // says anything true when the target IS the host. Bare-metal is freestanding; a
  // different hosted target has its own headers and, more subtly, its own data model —
  // `long` is 8 bytes on every target Milo hosts today (all LP64) but 4 on LLP64
  // (Windows), which would make a correct `i64` declaration wrong there. Verifying that
  // against the host's headers would answer the host's question, not the target's.
  //
  // Skipping is announced, never silent: an unverified @cLayout/@cSig looks identical to
  // a verified one, and a guard you think is running is worse than no guard at all.
  // Verifying properly needs a sysroot for the target, which the compiler has no notion
  // of yet (there is no -I/-isysroot anywhere in the build).
  const host = getHostTarget();
  if (target.bareMetal) {
    console.error(`warning: @cLayout/@cSig guards skipped — a bare-metal target is freestanding, so the host's headers don't describe it`);
    return;
  }
  // A Windows cross-compile CAN be verified when the target sysroot is present: compile
  // the guard TU with the target triple (so clang uses LLP64) against xwin's headers.
  // Only this exact case — every other target≠host cross has no sysroot to read, so it
  // still skips, announced.
  const crossWindows =
    target.os === "windows" && process.platform !== "win32" && !!process.env.MILO_WINDOWS_SDK;
  if ((target.os !== host.os || target.arch !== host.arch) && !crossWindows) {
    console.error(`warning: @cLayout/@cSig guards skipped — building for ${target.triple}, but verification would read this ${host.os}-${host.arch} host's headers`);
    return;
  }
  const tc = detectToolchain();
  const cc = tc.kind === "clang" ? tc.path : "cc";
  const crossFlags = crossWindows ? `--target=${target.triple} ${windowsIncludeFlags()}` : "";
  const libFlags = pkgConfigCflags(linkLibs);
  const tmpC = join(tmpdir(), `milo_cdecl_${crypto.randomUUID().slice(0, 8)}.c`);
  try {
    writeFileSync(tmpC, cGuards);
    const stdout = execSync(`${cc} -fsyntax-only ${crossFlags} ${libFlags} "${tmpC}" 2>&1`, { stdio: ["pipe", "pipe", "pipe"] });
    reportGuardSkips(stdout.toString());
  } catch (e: any) {
    const stderr = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? e.message ?? "");
    reportGuardSkips(stderr);
    // A header the preprocessor can't open aborts the TU before any assert is evaluated,
    // so nothing here was checked. That is a missing dev package, not a wrong declaration
    // — the third-party case (SDL headers absent while libSDL2 is installed and links
    // fine) is routine, and failing the build over it would make @cSig a hard dependency
    // on every consumer having -dev installed. Skip, but say so: an unverified guard must
    // never look like a verified one.
    //
    // Guards are wrapped in `#if __has_include` per header, so this only fires for a
    // header the preprocessor found but could not read through — a broken include chain
    // rather than an absent package, which is a whole-TU failure either way.
    const missing = stderr.match(/fatal error: '([^']+)' file not found/);
    if (missing) {
      console.error(`warning: @cLayout/@cSig/@cValue guards skipped — '${missing[1]}' is not installed, so there is no header to check these declarations against`);
      return;
    }
    // Pull our own message out of each failing assert and drop the rest: the raw text
    // names a temp .c file the user never wrote and can't open, which is worse than
    // useless in a diagnostic. clang says `failed due to requirement '<expr>': <msg>`,
    // gcc just `failed: "<msg>"`.
    const asserts: string[] = [];
    for (const line of stderr.split("\n")) {
      const m = line.match(/static assertion failed(?: due to requirement '.*?')?:\s*(.*)$/);
      if (m) { asserts.push(m[1].trim().replace(/^"|"$/g, "")); continue; }
      // Not every mismatch reaches an assert: naming a field C doesn't have makes
      // `offsetof` itself ill-formed, so clang errors before evaluating the assert.
      // Translate rather than dump — the raw text cites a temp file the user can't open.
      const noMember = line.match(/no member named '([^']+)' in '([^']+)'/);
      if (noMember) asserts.push(`${noMember[1]}: declared in Milo, but '${noMember[2]}' has no such field`);
      const unknownType = line.match(/(?:unknown type name|no type named|incomplete type) '([^']+)'/);
      if (unknownType) asserts.push(`'${unknownType[1]}': named in Milo, but the header declares no such type`);
      // A @cSig pointee assert dereferences the C parameter type. If C's parameter is not a
      // pointer at all, that deref is what fails, not the assert — and the Milo declaration
      // passing a pointer where C takes a value is exactly the mismatch worth reporting.
      const notPointer = line.match(/indirection requires pointer operand.*\('([^']+)'/);
      if (notPointer) asserts.push(`'${notPointer[1]}': Milo declares a pointer parameter, but C takes this by value`);
    }
    // clang reports the error then a note pointing at the real declaration, so the same
    // finding arrives twice (once as `timespec`, once as `struct timespec`).
    const seen = new Set<string>();
    const unique = asserts.filter(a => {
      const key = a.replace(/'(?:struct |union |enum )?([^']+)'/g, "'$1'");
      return seen.has(key) ? false : (seen.add(key), true);
    });
    asserts.length = 0;
    asserts.push(...unique);
    console.error(`error[c-decl]: a declaration does not match the C header it claims to describe`);
    for (const a of asserts) console.error(`  ${a}`);
    if (asserts.length === 0) console.error(stderr);
    else console.error(`  the Milo declaration is a claim about C; trust the header, not the claim`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpC); } catch {}
  }
}

function compileToJS(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig): string {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  return new CodegenJS().generate(hirModule);
}

function compileToIr(sourcePath: string, outputPath: string | null, target: TargetInfo, warningConfig?: WarningConfig, trapOnOverflow = false, emitDebug = false, contractChecks = false, stripPanicLocations = false, sanitize = false) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig, trapOnOverflow, emitDebug, contractChecks, stripPanicLocations, sanitize);
  if (outputPath) {
    writeFileSync(outputPath, ir);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(ir);
  }
}

function emitText(text: string, outputPath: string | null) {
  if (outputPath) {
    writeFileSync(outputPath, text);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(text);
  }
}

// JSON replacer shared by emit-ast/emit-hir. Spans are dropped by default (they dominate
// the output and rarely matter); Set/Map (dropImpls, userFnNames) and bigint int-literal
// values are not JSON-native, so serialize them explicitly rather than emit `{}`/throw.
function dumpReplacer(includeSpans: boolean) {
  return (key: string, value: any) => {
    if (!includeSpans && key === "span") return undefined;
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value === "bigint") return `${value}n`;
    return value;
  };
}

function dumpJson(obj: unknown, spans: boolean): string {
  try {
    return JSON.stringify(obj, dumpReplacer(spans), 2) + "\n";
  } catch (e: any) {
    console.error(`error: could not serialize dump: ${e.message}`);
    process.exit(1);
  }
}

// Emit the AST as JSON — the parser's output, before types exist. Default: just the entry
// file (raw parse, no import merge) so the stdlib doesn't drown the user's own code. --all
// merges imports (and resolves) like a real build. No type-check runs: an AST is meaningful
// even when the program doesn't type-check, which is exactly when you want to inspect it.
function emitAst(sourcePath: string, outputPath: string | null, target: TargetInfo, all: boolean, spans: boolean) {
  const source = readFileSync(sourcePath, "utf-8");
  let program;
  try {
    const tokens = new Lexer(source).tokenize();
    program = new Parser(tokens, source, sourcePath).parse();
    if (all) program = resolveImports(program, dirname(resolve(sourcePath)), target, sourcePath);
  } catch (e: any) {
    if (e instanceof ParseError) console.error(formatDiagnostic(e.diagnostic, e.source ?? source, e.filePath ?? sourcePath));
    else console.error(e.message);
    process.exit(1);
  }
  emitText(dumpJson(program, spans), outputPath);
}

// Emit the typed HIR as JSON — the lowered form codegen consumes, with a TypeKind on every
// expression. Runs the full frontend (parse + resolve + check + lower), so a type error
// stops it exactly as a real build would. Default: only functions defined in the entry file
// (the rest is stdlib + monomorphized instantiations); --all dumps the whole module. Structs/
// enums/globals carry no source stamp, so they only appear under --all.
function emitHir(sourcePath: string, outputPath: string | null, target: TargetInfo, all: boolean, spans: boolean, warningConfig?: WarningConfig) {
  const source = readFileSync(sourcePath, "utf-8");
  const mod = frontendToHIR(source, target, sourcePath, warningConfig);
  if (all) {
    emitText(dumpJson(mod, spans), outputPath);
    return;
  }
  // Entry-file functions are stamped with the entry path by the resolver; injected libc
  // externs (memchr/memcmp/…) carry no stamp, so require an exact match rather than treating
  // "unstamped" as "belongs to the entry file".
  const entry = resolve(sourcePath);
  const fns = mod.functions.filter(f => f.sourceFile && resolve(f.sourceFile) === entry);
  const view = { ...mod, functions: fns, structs: [], enums: [], globals: [] };
  if (!outputPath) {
    console.error(`hir: ${fns.length} function(s) from ${sourcePath} (use --all for the full module: stdlib + monomorphized instantiations, structs, enums, globals)`);
  }
  emitText(dumpJson(view, spans), outputPath);
}

// detect clang: prefer /usr/bin/clang (Apple) which is more stable, then PATH clang, then llc+cc
// Two separate LLVM-version requirements, both verified against real toolchains:
//   14 and below — rejects opaque pointers outright: `declare i32 @memcmp(ptr, ...)`
//                  fails with "expected type".
//   15           — accepts `ptr` as a type but still mangles pointer intrinsics with
//                  the element type, so our `@llvm.memcpy.p0.p0.i64` is an
//                  "undefined value". The p0i8 -> p0 change landed in LLVM 16.
// Both errors point at our IR and read like a codegen bug rather than a stale
// toolchain. Reachable on current distros: Debian bookworm defaults to clang 14 and
// Ubuntu 22.04 ships no newer than 15. Confirmed: 16 and 17 build clean.
const MIN_CLANG_MAJOR = 16;

function clangMajor(versionOutput: string): number | null {
  // "Debian clang version 14.0.6", "Apple clang version 17.0.0", "clang version 18.1.3"
  const m = versionOutput.match(/clang version (\d+)/);
  return m ? Number(m[1]) : null;
}

type Toolchain = { kind: "clang"; path: string } | { kind: "llc+cc" };
let cachedToolchain: Toolchain | null = null;
function detectToolchain(): Toolchain {
  if (cachedToolchain) return cachedToolchain;
  const candidates = ["/usr/bin/clang", "clang"];
  let tooOld: { path: string; major: number } | null = null;
  for (const cc of candidates) {
    try {
      const out = execSync(`${cc} --version`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      const major = clangMajor(out);
      // An unparseable version string is not a reason to reject a working clang.
      if (major !== null && major < MIN_CLANG_MAJOR) {
        tooOld ??= { path: cc, major };
        continue;
      }
      cachedToolchain = { kind: "clang", path: cc };
      return cachedToolchain;
    } catch {}
  }
  try {
    execSync("llc --version", { stdio: ["pipe", "pipe", "pipe"] });
    execSync("cc --version", { stdio: ["pipe", "pipe", "pipe"] });
    cachedToolchain = { kind: "llc+cc" };
  } catch {
    if (tooOld) {
      throw new Error(
        `clang ${tooOld.major} is too old: milo emits LLVM IR that needs clang ${MIN_CLANG_MAJOR}+\n` +
        `  found: ${tooOld.path}\n` +
        `  fix:   macOS  xcode-select --install   (or: brew install llvm)\n` +
        `         Debian/Ubuntu  apt install clang-${MIN_CLANG_MAJOR}  (bookworm ships 14, jammy ships 15)\n` +
        `                       or use https://apt.llvm.org/llvm.sh\n` +
        `         then put the newer clang first on PATH`
      );
    }
    throw new Error(
      "no C compiler found: need either 'clang' or 'llc'+'cc' on PATH\n" +
      "  fix: macOS  xcode-select --install\n" +
      "       Debian/Ubuntu  apt install clang\n" +
      "       Fedora  dnf install clang"
    );
  }
  return cachedToolchain;
}

// wasm64 needs a clang whose LLVM build actually has the WebAssembly backend
// compiled in. detectToolchain() above prefers /usr/bin/clang unconditionally (for
// its stability on every OTHER target), but Apple's bundled clang doesn't have one —
// `clang --print-targets` on Xcode's clang 17 lists aarch64/arm/x86 only, no wasm32/
// wasm64 — so this is a separate probe, not a variant of detectToolchain(). It checks
// PATH's `clang` FIRST (unlike detectToolchain, which checks the absolute
// /usr/bin/clang path first) specifically so that a user who follows the "put
// Homebrew LLVM first on PATH" instructions (same pattern this repo already uses for
// Windows cross-compiles) gets picked up rather than silently overridden.
let cachedWasmClang: string | null | undefined;
function detectWasmClang(): string | null {
  if (cachedWasmClang !== undefined) return cachedWasmClang;
  const candidates = ["clang", "/opt/homebrew/opt/llvm/bin/clang", "/usr/local/opt/llvm/bin/clang"];
  for (const cc of candidates) {
    try {
      const targets = execSync(`${cc} --print-targets`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      if (!/\bwasm(32|64)\b/.test(targets)) continue;
      const ver = execSync(`${cc} --version`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      const major = clangMajor(ver);
      if (major !== null && major < MIN_CLANG_MAJOR) continue; // same IR-compatibility floor as detectToolchain
      cachedWasmClang = cc;
      return cachedWasmClang;
    } catch {}
  }
  cachedWasmClang = null;
  return null;
}

// clang codegen flags for a cross-compilation target. Empty for the host
// (clang defaults to the host triple). Bare-metal targets get the thumb triple,
// core selection, float ABI, and -ffreestanding (no hosted libc assumptions).
function clangTargetFlags(target: TargetInfo): string {
  if (!target.bareMetal) {
    // A hosted target that isn't the host must still reach clang, or `--target` is a lie:
    // without it clang ignores the IR's triple (the link passes -Wno-override-module) and
    // quietly builds for the host — `--target=linux-x64` on macOS produced a Mach-O arm64
    // binary and reported success. Passing it means a cross build without a target
    // toolchain/sysroot fails loudly, and one with a proper toolchain works.
    const host = getHostTarget();
    return (target.os === host.os && target.arch === host.arch) ? "" : ` --target=${target.triple}`;
  }
  let f = ` --target=${target.triple}`;
  if (target.mcpu) f += ` -mcpu=${target.mcpu}`;
  if (target.floatAbi) f += ` -mfloat-abi=${target.floatAbi}`;
  f += " -ffreestanding";
  return f;
}

// Directory holding the bare-metal runtime (startup + linker scripts), resolved
// relative to this file so it works regardless of the caller's cwd.
function embeddedDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "tools", "cortex-m");
}

// Link a bare-metal Cortex-M executable: the Milo program's IR + the freestanding
// startup (vector table, .data/.bss init, semihosting exit) against the board's
// linker script. Uses lld (-fuse-ld=lld) and -nostdlib — there is no libc/crt0.
// Produces a statically-linked ELF runnable under QEMU (-semihosting).
function linkBareMetal(llFile: string, outFile: string, target: TargetInfo, optFlag: string, heapSize: number | null = null) {
  const tc = detectToolchain();
  if (tc.kind !== "clang") {
    console.error(`error: cross-compiling to ${target.triple} requires clang (not llc+cc)`);
    process.exit(1);
  }
  const ed = embeddedDir();
  const startup = join(ed, "startup.c");
  const ldScript = join(ed, "mps2.ld");
  if (!existsSync(startup) || !existsSync(ldScript)) {
    console.error(`error: bare-metal runtime not found in ${ed} (need startup.c + mps2.ld)`);
    process.exit(1);
  }
  const opt = optFlag || "-O2";
  const tgt = clangTargetFlags(target);
  // -DMILO_HEAP_SIZE caps the bump allocator's arena (startup.c); omitted =
  // heap spans all RAM the linker script leaves free.
  const heapDef = heapSize != null ? ` -DMILO_HEAP_SIZE=${heapSize}` : "";
  // -nostdlib: no libc/crt0. -Wl,-T,<script>: use our memory map. startup.c is
  // compiled and linked alongside the program IR in a single clang invocation.
  //
  // --gc-sections (with -f{function,data}-sections) drops functions nothing
  // reaches, and lld only reports undefined symbols from sections that survive.
  // That matters at -O0, where no optimizer pass removes the prelude functions a
  // program never calls: std/string is in every program, and one of its parsers
  // calling libc's atof was enough to fail the link of a program that parses
  // nothing. The vector table is KEEP'd in mps2.ld, so it survives the sweep.
  try {
    execSync(
      `${tc.path}${tgt} ${opt}${heapDef} -ffunction-sections -fdata-sections -nostdlib -fuse-ld=lld -Wl,--gc-sections -Wl,-T,"${ldScript}" "${startup}" "${llFile}" -o "${outFile}" -Wno-override-module`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (e: any) {
    // A named limit replaces the raw lld dump; anything else falls through to the
    // caller's generic link error, which still prints the linker's own output.
    if (reportMissingBuiltins((e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? ""), target)) process.exit(1);
    throw e;
  }
}

// The compiler-rt/libgcc helper routines clang emits for operations the core has no
// instruction for. A freestanding link has no builtins library to resolve them, so
// they surface as raw "undefined symbol: __aeabi_dmul" — which reads like a compiler
// bug rather than what it is: the declared edge of the bare-metal target. Cortex-M
// support is integer-only, and this is where a program finds that out.
const AEABI_FLOAT = /__aeabi_(d|f)[a-z0-9]+|__(add|sub|mul|div)(df|sf)3|__(fix|float)[a-z]*(df|sf)/;
const AEABI_INT64 = /__aeabi_u?l(div|)mod|__[u]?divdi3|__[u]?moddi3|__muldi3/;

function reportMissingBuiltins(stderr: string, target: TargetInfo): boolean {
  const undef = stderr.match(/undefined symbol: (\S+)/g)?.map(m => m.slice("undefined symbol: ".length)) ?? [];
  if (!undef.length) return false;
  const floats = undef.filter(s => AEABI_FLOAT.test(s));
  const int64s = undef.filter(s => AEABI_INT64.test(s));
  if (!floats.length && !int64s.length) return false;
  console.error(`error: unsupported operation for ${target.triple} — bare-metal Milo is integer-only`);
  if (floats.length) {
    console.error(`note: floating-point arithmetic needs the soft-float helpers (${floats.slice(0, 3).join(", ")}), which a freestanding link has no library to supply`);
    console.error(`note: use fixed-point instead — see examples/embedded/pidStep.milo, a Q16.16 PID kernel`);
  }
  if (int64s.length) {
    console.error(`note: 64-bit division needs a helper routine (${int64s.slice(0, 3).join(", ")}) this target cannot link — use i32 for divisors and quotients`);
  }
  console.error(`note: this is the scope of the target, not a missing toolchain; hosted targets have no such limit`);
  return true;
}

// Directory holding the wasm64 freestanding runtime, resolved the same way as
// embeddedDir() for Cortex-M.
function wasmDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "tools", "wasm");
}

// Link a wasm64 module: the Milo program's IR + tools/wasm/runtime.c (malloc, mem*/
// str*, the printf family, __multi3, and the env.* host imports) -> a freestanding
// .wasm. Unlike linkBareMetal there's no linker script and no vector table: wasm-ld
// lays out linear memory itself, and the "entry point" is just an exported `main`
// function that tools/wasm/run.mjs calls directly — no crt0/Reset_Handler equivalent
// to link in.
function linkWasm(llFile: string, outFile: string, target: TargetInfo, optFlag: string, heapSize: number | null = null) {
  const cc = detectWasmClang();
  if (!cc) {
    console.error(`error: no clang with a wasm64 backend found on PATH or in the usual Homebrew locations`);
    console.error(`hint: brew install llvm, then either put it first on PATH`);
    console.error(`      (PATH="/opt/homebrew/opt/llvm/bin:$PATH" milo build ... --target=wasm64)`);
    console.error(`      or just having it installed is enough — this check also looks there directly.`);
    process.exit(1);
  }
  const runtime = join(wasmDir(), "runtime.c");
  if (!existsSync(runtime)) {
    console.error(`error: wasm64 runtime not found at ${runtime} (need runtime.c)`);
    process.exit(1);
  }
  const opt = optFlag || "-O2";
  const tgt = clangTargetFlags(target); // bareMetal=true gets us --target=wasm64-unknown-unknown -ffreestanding
  // -DMILO_HEAP_SIZE caps runtime.c's bump allocator, same flag/semantics as
  // linkBareMetal's heapDef.
  const heapDef = heapSize != null ? ` -DMILO_HEAP_SIZE=${heapSize}` : "";
  // -nostdlib: no libc/crt0, runtime.c supplies every symbol codegen can auto-declare.
  // --no-entry: there is no _start; the host loader calls the exported `main` directly.
  // --export=main is the one symbol tools/wasm/run.mjs needs — wasm-ld exports the
  // module's linear memory by default, no flag needed for that.
  // --gc-sections (+ -f{function,data}-sections): same reason as linkBareMetal's — at
  // -O0 no optimizer pass strips the stdlib prelude a program never calls, and one of
  // std/string's unused parsers referencing atof was enough to pull in a symbol this
  // runtime deliberately aborts on rather than links against.
  execSync(
    `${cc}${tgt} ${opt}${heapDef} -ffunction-sections -fdata-sections -nostdlib -fuse-ld=lld ` +
    `-Wl,--no-entry -Wl,--export=main -Wl,--gc-sections "${runtime}" "${llFile}" -o "${outFile}" -Wno-override-module`,
    { stdio: ["pipe", "pipe", "pipe"] }
  );
}

// Cross-linking to Windows from a POSIX host: clang can emit COFF unaided, but it has
// no MSVC CRT or Windows SDK to link against and no MS linker. `xwin splat` produces
// exactly that tree from Microsoft's own packages; point MILO_WINDOWS_SDK at its root.
// On a real Windows host clang finds the installed VS toolchain itself, so this is empty
// there — the flags exist only to make the mac/linux dev loop possible.
function windowsSysrootFlags(target: TargetInfo): string {
  if (target.os !== "windows" || process.platform === "win32") return "";
  const root = process.env.MILO_WINDOWS_SDK;
  if (!root) {
    console.error(`error: cross-compiling to ${target.triple} needs the MSVC CRT + Windows SDK, which this host doesn't have.`);
    console.error(`hint: install them with 'cargo install xwin && xwin --accept-license --arch x86_64 splat --output ~/.xwin',`);
    console.error(`      then set MILO_WINDOWS_SDK=~/.xwin. (On Windows itself no flags are needed.)`);
    process.exit(1);
  }
  // xwin lays libs out per-arch under these three roots; the include dirs mirror a
  // VS install (crt = MSVC's own headers, sdk/{ucrt,um,shared} = the Windows SDK).
  const a = target.arch === "aarch64" ? "aarch64" : "x86_64";
  const lib = [`crt/lib/${a}`, `sdk/lib/um/${a}`, `sdk/lib/ucrt/${a}`]
    .map(d => `-L "${root}/${d}"`).join(" ");
  // lld-link, not ld64/GNU ld: the output is COFF and the host linker cannot produce it.
  return ` -fuse-ld=lld-link ${windowsIncludeFlags()} ${lib}`;
}

// The -isystem set for the cross-compiled MSVC CRT + Windows SDK. Shared by the link
// step and by verifyCDecls, so a cross build's @cLayout/@cSig guards read the TARGET's
// headers (with the target triple's LLP64 data model) instead of skipping — the same
// tree that got the ADDRESS_FAMILY include-order bug caught locally instead of in CI.
function windowsIncludeFlags(): string {
  const root = process.env.MILO_WINDOWS_SDK;
  if (!root) return "";
  return ["crt/include", "sdk/include/ucrt", "sdk/include/um", "sdk/include/shared"]
    .map(d => `-isystem "${root}/${d}"`).join(" ");
}

/**
 * Compile `llFile` as N codegen units in parallel processes and link the objects.
 * Returns false when the build was not split, leaving the caller's single-module path to
 * run — including when the split path itself fails. That fallback is what makes this safe
 * to have on by default: the split is a pure optimization, so abandoning it can cost time
 * but can never turn a buildable program into a failed build, and a genuine error in the
 * user's IR still gets reported by the single-module path with its normal diagnostics.
 */
function compileSplit(cc: string, llFile: string, ccFlags: string, linkFlags: string, optFlag: string, emitDebug: boolean): boolean {
  const ir = readFileSync(llFile, "utf-8");
  let irLines = 1;
  for (let i = 0; i < ir.length; i++) if (ir.charCodeAt(i) === 10) irLines++;
  const units = cguCount(irLines, optFlag, emitDebug);
  if (units < 2) return false;

  const stats: { out?: SplitStats } = {};
  const mods = splitModule(ir, units, stats);
  if (!mods) return false;

  const base = llFile.replace(/\.ll$/, "");
  const lls = mods.map((_, i) => `${base}.cgu${i}.ll`);
  const objs = mods.map((_, i) => `${base}.cgu${i}.o`);
  try {
    mods.forEach((m, i) => writeFileSync(lls[i]!, m));
    // One `sh` that backgrounds every unit, then waits on each PID individually: bare
    // `wait` reports only the last job's status, so a failed unit would go unnoticed and
    // resurface as a confusing undefined-symbol error at link time.
    const jobs = lls.map((f, i) =>
      `${cc} ${ccFlags} -c ${f} -o ${objs[i]} -Wno-override-module & pids="$pids $!"`).join("\n");
    const script = `pids=""\n${jobs}\nfor p in $pids; do wait $p || exit 1; done`;
    if (process.env.MILO_VERBOSE === "1") {
      console.error(`cgu: ${units} units, ${stats.out?.promoted ?? 0} symbols promoted, ${irLines} IR lines`);
    }
    execSync(script, { stdio: ["pipe", "pipe", "pipe"] });
    const linkCmd = `${cc} ${ccFlags} ${objs.join(" ")} ${linkFlags}`;
    if (process.env.MILO_VERBOSE === "1") console.error(`link: ${linkCmd}`);
    execSync(linkCmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e: any) {
    if (process.env.MILO_VERBOSE === "1") {
      console.error(`cgu: split build failed, falling back to a single module:\n${e.stderr?.toString() ?? e.message}`);
    }
    return false;
  } finally {
    for (const f of [...lls, ...objs]) { try { unlinkSync(f); } catch {} }
  }
}

function linkIR(llFile: string, outFile: string, optFlag: string, libs: string, extra: string = "", sanitize: boolean = false, emitDebug = false, target?: TargetInfo) {
  const tc = detectToolchain();
  const san = sanitize ? " -fsanitize=address" : "";
  // Empty when the target is the host, so the common path is unchanged.
  const tgt = target ? clangTargetFlags(target) : "";
  // On Linux a dlopen'd library resolves a callback into the host (std/dl's
  // `probe`) only if the host exported its symbols into the dynamic table.
  // ELF hides them by default, so without -rdynamic the callback fails with
  // "undefined symbol". Mach-O exports them anyway, so macOS never needed it.
  // -ldl for dlopen itself (a harmless no-op on glibc >= 2.34 where it folds
  // into libc). Host/target-aware so a cross-compile to Linux gets it too.
  const targetIsLinux = target ? target.os === "linux" : process.platform === "linux";
  const linuxLink = targetIsLinux ? " -rdynamic -ldl" : "";
  const targetIsWindows = target ? target.os === "windows" : process.platform === "win32";
  // The UCRT has no separate libm — floor/pow live in the CRT proper — and `-lm` reaches
  // lld-link as a request for `m.lib`, which does not exist, so it is a hard link error
  // rather than a harmless no-op the way it is on macOS.
  const mathLink = targetIsWindows ? "" : " -lm";
  const winSysroot = target ? windowsSysrootFlags(target) : "";
  if (tc.kind === "clang") {
    const opt = optFlag ? ` ${optFlag}` : "";
    // Mach-O keeps DWARF in the .o and references it from the executable via a debug
    // map (N_OSO); the DWARF is never copied into the linked binary. The default
    // single-step `clang x.ll -o out` deletes its internal .o, dangling that map. So on
    // a Mach-O target with debug info, persist the .o, link it, then dsymutil the debug
    // map into out.dSYM (which lldb/hades auto-load). ELF embeds DWARF in the binary
    // directly, so it needs none of this.
    // Host-darwin is not enough: cross-linking to Windows from a mac produces COFF/PDB,
    // which has no debug map and no dsymutil step. Gate on the TARGET's object format.
    if (emitDebug && process.platform === "darwin" && !targetIsWindows) {
      const obj = `${outFile}.dbg.o`;
      try {
        execSync(`${tc.path}${tgt}${opt}${san} -c ${llFile} -o ${obj} -Wno-override-module`, { stdio: ["pipe", "pipe", "pipe"] });
        execSync(`${tc.path}${tgt}${opt}${san} ${obj} -o ${outFile}${libs}${extra}`, { stdio: ["pipe", "pipe", "pipe"] });
        execSync(`dsymutil ${outFile}`, { stdio: ["pipe", "pipe", "pipe"] });
      } finally {
        try { unlinkSync(obj); } catch {}
      }
    } else {
      const linkFlags = `-o ${outFile}${libs}${extra}${mathLink}${linuxLink}`;
      if (compileSplit(tc.path, llFile, `${tgt}${winSysroot}${opt}${san}`, linkFlags, optFlag, emitDebug)) return;
      // -lm: numToStr and other std math call floor/pow from libm. macOS folds
      // libm into libSystem so clang links it implicitly; Linux does not, so
      // without this the link fails with `undefined reference to 'floor'` for
      // any program that reaches those paths (the llc+cc branch already passes
      // it). Harmless on macOS where libm is always present.
      const cmd = `${tc.path}${tgt}${winSysroot}${opt}${san} ${llFile} -o ${outFile} -Wno-override-module${libs}${extra}${mathLink}${linuxLink}`;
      // MILO_VERBOSE=1 surfaces the otherwise-invisible link command — the only
      // place @link/detected/`--` flags actually land — so a link failure is diagnosable.
      if (process.env.MILO_VERBOSE === "1") console.error(`link: ${cmd}`);
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    }
  } else {
    if (sanitize) {
      console.error("error: --sanitize requires clang (not llc+cc)");
      process.exit(1);
    }
    const tmpObj = llFile.replace(/\.ll$/, ".o");
    const opt = optFlag || "-O2";
    try {
      execSync(`llc -filetype=obj ${opt} ${llFile} -o ${tmpObj}`, { stdio: ["pipe", "pipe", "pipe"] });
      execSync(`cc ${tmpObj} -o ${outFile}${libs}${extra}${mathLink}${linuxLink}`, { stdio: ["pipe", "pipe", "pipe"] });
    } finally {
      try { unlinkSync(tmpObj); } catch {}
    }
  }
}

function compileToObj(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, noEntry = false, forceOverflowChecks: boolean | null = null, forceContractChecks: boolean | null = null): string {
  const source = readFileSync(sourcePath, "utf-8");
  const trapOnOverflow = forceOverflowChecks ?? true;
  const contractChecks = forceContractChecks ?? (optFlag === "-O0");
  const { ir, cGuards, linkLibs, nonConstGlobals } = compileWithGuards(source, target, sourcePath, warningConfig, trapOnOverflow, false, contractChecks);
  // `--no-entry` strips `@main`, and `@main` is the only caller of the generated
  // `@__milo.global_init`. So in a --no-entry object every global whose initializer
  // has to run stays whatever the static form was: "" / 0 / empty, forever, with no
  // diagnostic. That is true whether or not the module HAS a main (the entry is
  // renamed to `@_milo_unused_main`, which strands the init call in dead code), so
  // the guard is on the flag alone. Reject before any object file is written.
  if (noEntry && nonConstGlobals.length > 0) {
    for (const name of nonConstGlobals) {
      console.error(`error: global '${name}' needs an initializer that runs, and '--no-entry' produces an object with no entry point to run it`);
    }
    console.error(`hint: give it a constant initializer ('= ""', '= 0', '= []') and assign the real value from your own entry point, or drop '--no-entry' and build the module into a program with 'fn main()'`);
    process.exit(1);
  }
  verifyCDecls(cGuards, target, linkLibs);

  const base = basename(sourcePath).replace(/\.milo$/, "");
  const out = outputPath ?? base + ".o";
  const id = crypto.randomUUID().slice(0, 8);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  let irText = ir;
  if (noEntry) {
    // Remove main function definition — keep only non-main functions
    // Replace `define ... @main(...)` with internal linkage so it doesn't conflict
    irText = irText.replace(
      /^define (.*) @main\(/m,
      "define internal $1 @_milo_unused_main("
    );
  }

  try {
    writeFileSync(tmpLl, irText);
    const tc = detectToolchain();
    const opt = optFlag || "-O2";
    const tgt = clangTargetFlags(target);
    if (tc.kind === "clang") {
      execSync(`${tc.path} -c${tgt} ${opt} ${tmpLl} -o ${out} -Wno-override-module`, { stdio: ["pipe", "pipe", "pipe"] });
    } else {
      if (tgt) {
        console.error(`error: cross-compiling to ${target.triple} requires clang (not llc+cc)`);
        process.exit(1);
      }
      execSync(`llc -filetype=obj ${opt} ${tmpLl} -o ${out}`, { stdio: ["pipe", "pipe", "pipe"] });
    }
  } catch (e: any) {
    console.error(`error[emit-obj]: compilation failed:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

// Emit a C header (declaring exported functions + extern structs) next to a build
// artifact. Recomputes the frontend to reach the HIR (compileToObj discards it) — the
// cheapest path that keeps codegen untouched.
function writeHeader(sourcePath: string, headerPath: string, target: TargetInfo, warningConfig?: WarningConfig) {
  const source = readFileSync(sourcePath, "utf-8");
  const hir = frontendToHIR(source, target, sourcePath, warningConfig);
  const headerName = basename(headerPath).replace(/\.h$/, "");
  writeFileSync(headerPath, generateHeader(hir, headerName));
  console.log(`wrote ${headerPath}`);
}

function buildLib(sourcePaths: string[], outputPath: string, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, forceOverflowChecks: boolean | null = null, forceContractChecks: boolean | null = null) {
  const objFiles: string[] = [];
  try {
    for (const src of sourcePaths) {
      const id = crypto.randomUUID().slice(0, 8);
      const tmpObj = join(tmpdir(), `milo_${id}.o`);
      compileToObj(src, tmpObj, target, optFlag, warningConfig, true, forceOverflowChecks, forceContractChecks);
      objFiles.push(tmpObj);
    }
    const objs = objFiles.map(f => `"${f}"`).join(" ");
    // `ar r` merges into an existing archive, and the temp object names are random,
    // so a rebuild would append a second copy of every symbol instead of replacing it.
    try { unlinkSync(outputPath); } catch {}
    execSync(`ar rcs "${outputPath}" ${objs}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    console.error(`error[build-lib]: ${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    for (const f of objFiles) { try { unlinkSync(f); } catch {} }
  }
  // header describes the primary source's public surface
  writeHeader(sourcePaths[0], outputPath.replace(/\.a$/, "") + ".h", target, warningConfig);
}

// A .dylib records its own dependencies (LC_LOAD_DYLIB), so dyld pulls them in at
// startup and `-lfoo` is self-sufficient. A .a records nothing — its members just
// carry undefined symbols — so anything a static archive depends on has to be named
// explicitly at link time or ld fails on symbols it has no way to locate. Upstream
// ships that list out of band via a *-config script; probe it, since hardcoding a
// framework set drifts every time the library is rebuilt with different options.
function staticTransitiveDeps(name: string, target: TargetInfo): string {
  const probe = STATIC_DEP_PROBES[name];
  if (!probe) return "";
  try {
    const out = execSync(probe, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Deny-list, not allow-list: darwin needs frameworks, linux needs X11/pulse/alsa,
    // and the set differs per distro and per build config. Keep everything except what
    // the caller already emits (the archive itself, its -l, and search paths).
    const kept = out.split(/\s+/).filter((tok) =>
      tok && !tok.startsWith("-L") && !tok.endsWith(`lib${name}.a`) && tok !== `-l${name}` &&
      // ld errors on undefined symbols anyway; forcing it here only breaks weak frameworks.
      tok !== "-Wl,--no-undefined"
    );
    return kept.length ? " " + [...new Set(kept)].join(" ") : "";
  } catch {
    if (target.os === "darwin") {
      console.error(`warning: --static-deps could not run '${probe}' to resolve ${name}'s framework deps;`);
      console.error(`hint: the link will likely fail on undefined symbols — install the ${name} dev tooling`);
    }
    return "";
  }
}

const STATIC_DEP_PROBES: Record<string, string> = {
  SDL2: "sdl2-config --static-libs",
};

// Resolve `-lfoo` to a link spec. Dynamic is the default because a system dylib
// picks up OpenSSL security fixes without a rebuild; --static-deps trades that away
// for a binary that runs on machines with no Homebrew/openssl installed at all.
// Where a given library's files actually sit on darwin. The caller's prefix is
// tried first so every existing call keeps its exact behaviour; the rest is
// Homebrew's KEG layout, which is a property of the package manager and not of
// any particular vendor — brew installs each formula under opt/<formula> and
// only symlinks some of it into the flat prefix. `.a` archives frequently are
// not symlinked, which is why a flat-prefix-only search finds the dylib and
// misses the archive.
//
// The trailing-digit strip is the one heuristic here: a library's -l name and
// its formula name differ often enough to matter (`-lsqlite3` ships in the
// `sqlite` formula), and dropping trailing digits covers that case without the
// compiler learning any vendor's name.
function darwinLibDirs(name: string, darwinPrefix: string): string[] {
  const stripped = name.replace(/\d+$/, "");
  return [
    `${darwinPrefix}/lib`,
    `/opt/homebrew/opt/${name}/lib`,
    ...(stripped && stripped !== name ? [`/opt/homebrew/opt/${stripped}/lib`] : []),
    `/opt/homebrew/lib`,
  ];
}

function libSpec(names: string[], darwinPrefix: string, target: TargetInfo, staticDeps: boolean): string {
  const flags = names.map((n) => `-l${n}`).join(" ");
  if (!staticDeps) {
    if (target.os !== "darwin") return ` ${flags}`;
    // Emit a -L only for a directory that actually holds the requested library.
    // Adding every candidate looks harmless and is not: `/opt/homebrew/lib`
    // always exists, so a blanket -L puts Homebrew's copies of common libraries
    // (libz, libc++, …) ahead of the SDK's on the search path for every binary
    // we link, whether or not it asked for anything from Homebrew.
    const dirs = [...new Set(names.map((n) => {
      const dir = darwinLibDirs(n, darwinPrefix)
        .find((d) => existsSync(`${d}/lib${n}.dylib`) || existsSync(`${d}/lib${n}.a`));
      // Nothing found: fall back to the caller's prefix, which is what this
      // returned before there were any candidates, and let ld report it.
      return dir ?? `${darwinPrefix}/lib`;
    }))];
    return ` ${dirs.map((d) => `-L${d}`).join(" ")} ${flags}`;
  }
  const transitive = names.map((n) => staticTransitiveDeps(n, target)).join("");
  if (target.os !== "darwin") {
    // GNU ld: -Bstatic/-Bdynamic are positional, so restore dynamic for libc after.
    // Transitive deps go after -Bdynamic — they are system libs we want shared.
    return ` -Wl,-Bstatic ${flags} -Wl,-Bdynamic${transitive}`;
  }
  // ld64 has no -Bstatic; naming the archive directly is the supported way to force
  // a static member pull while everything else stays dynamic.
  const archives: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const found = darwinLibDirs(n, darwinPrefix).map((d) => `${d}/lib${n}.a`).find((a) => existsSync(a));
    if (found) archives.push(found);
    // Report the -l name, not one guessed path: the searched paths are several
    // and naming only the first sends people to install something already present
    // somewhere else. The old message said "try 'brew install homebrew'".
    else missing.push(`lib${n}.a`);
  }
  if (missing.length) {
    console.error(`error: --static-deps needs static archives that aren't installed: ${missing.join(", ")}`);
    console.error(`hint: Homebrew ships them alongside the dylibs — 'brew install' the formula providing ${missing.join(", ")}`);
    process.exit(1);
  }
  return " " + archives.join(" ") + transitive;
}

// Libs declared in source via @link("name"). Homebrew's prefix is the darwin
// default (SDL2 etc. live under /opt/homebrew/lib); linux finds them on the default
// search path. Reuses libSpec so --static-deps stays consistent.
function declaredLibSpec(names: string[], target: TargetInfo, staticDeps: boolean): string {
  if (!names.length) return "";
  // `@link("framework:Foo")` — a darwin framework is not a `-l` name, and a system
  // library that ships as a framework on darwin and an archive elsewhere holds the
  // same symbols under two spellings. Without this prefix the flag could only come
  // from the compiler recognising particular library names, which is exactly what
  // puts a specific vendor's API into a general-purpose language's vocabulary.
  // A `framework:` link belongs in a `.darwin.milo` arm; it is unsatisfiable elsewhere.
  const frameworks = names.filter(n => n.startsWith("framework:")).map(n => n.slice("framework:".length));
  const libs = names.filter(n => !n.startsWith("framework:"));
  if (frameworks.length && target.os !== "darwin") {
    console.error(`error: @link("framework:${frameworks[0]}") targets ${target.os}, but frameworks exist only on darwin`);
    console.error(`hint: put the framework link in a '.darwin.milo' arm and the '-l' spelling in the others`);
    process.exit(1);
  }
  // Never static: a framework is the OS's copy, and there is no archive to name.
  const frameworkFlags = frameworks.map(f => ` -framework ${f}`).join("");
  return frameworkFlags + (libs.length ? libSpec(libs, "/opt/homebrew", target, staticDeps) : "");
}

function detectLibs(ir: string, target: TargetInfo, staticDeps = false): string {
  let libs = "";
  // Auto-detection is a heuristic keyed on Homebrew/apt layouts, and it deliberately
  // over-approximates (see the note below) — which is survivable only because ld64 and
  // GNU ld can drop the unused ones. lld-link ignores --as-needed, so a speculative
  // -lssl becomes a hard "could not open 'ssl.lib'" for any program that merely imports
  // std/io. On Windows these deps have to be requested explicitly via @link.
  if (target.os === "windows") {
    // The exceptions are SDK libraries, not third-party ones: they ship with the
    // toolchain, so unlike openssl there is nothing to install and nothing to detect
    // wrongly — either the symbol is referenced or it isn't.
    // BCryptGenRandom is emitted by the compiler itself (hashmap seed init); std/crypto's
    // Windows arm reaches other CNG entry points (BCryptHash, BCryptEncrypt, …). Any
    // BCrypt* symbol lives in bcrypt.lib, so match the whole family.
    if (/@BCrypt[A-Za-z]+\b/.test(ir)) libs += " -lbcrypt";
    // Winsock. ioctlsocket reaches this via std/event's setNonblocking, which std/io
    // calls on ordinary fds — so this is not confined to programs doing networking.
    if (/@(ioctlsocket|socket|getaddrinfo|freeaddrinfo|WSA[A-Za-z]+)\b/.test(ir)) libs += " -lws2_32";
    return libs;
  }
  const openssl = "/opt/homebrew/opt/openssl@3";
  if (ir.includes("@SSL_") || ir.includes("@TLS_client_method")) {
    libs += libSpec(["ssl", "crypto"], openssl, target, staticDeps);
  }
  if (!libs.includes("-lcrypto") && !libs.includes("libcrypto.a") && (ir.includes("@SHA256") || ir.includes("@MD5"))) {
    libs += libSpec(["crypto"], openssl, target, staticDeps);
  }
  // sqlite3 used to be detected here by IR substring. std/sqlite now declares
  // `@link("sqlite3")` on its first extern, so the flag comes from the binding
  // that needs it — the mechanism the note below says every case should use.
  // JavaScriptCore: a system framework on darwin (zero install); on linux it's the
  // heavier libjavascriptcoregtk, so we only auto-link on darwin.
  if (ir.includes("@JSGlobalContextCreate") || ir.includes("@JSEvaluateScript")) {
    if (target.os === "darwin") libs += " -framework JavaScriptCore";
  }
  // Nothing gets added to this list. Every case here is a name the compiler has to
  // know, and a general-purpose language should not know what any particular vendor's
  // API is called — a binding declares its own `@link` and the flag comes from there.
  // The greps above run on pre-optimization IR, so they over-approximate badly:
  // std/os declares the TLS externs and defines wrappers around them, and every
  // program using std/io imports std/os — so `wc` picked up -lssl even though LLVM
  // dead-strips those unreachable wrappers and the binary needs zero SSL symbols.
  // The cost was a hard load command on a Homebrew-only absolute path, i.e. dyld
  // failure at startup on any machine without openssl@3 installed. Let the linker
  // drop libraries no surviving symbol actually references.
  if (libs) {
    // -dead_strip_dylibs is global on ld64; --as-needed is a positional toggle on
    // GNU ld, so it only affects -l flags that come after it.
    libs = target.os === "darwin" ? libs + " -Wl,-dead_strip_dylibs" : " -Wl,--as-needed" + libs;
  }
  return libs;
}

function compileToBinary(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, extraLinkFlags: string[] = [], sanitize: boolean = false, emitDebug = false, heapSize: number | null = null, forceOverflowChecks: boolean | null = null, staticDeps = false, forceContractChecks: boolean | null = null, stripPanicLocations = false): string {
  const source = readFileSync(sourcePath, "utf-8");
  // Arithmetic (+ - * -x) traps on overflow in EVERY build mode — the language law is
  // "every op is total; wrapping is opt-in" (Swift/Zig-safe model, not Rust's mode-flip).
  // The default is decoupled from -O: `--no-overflow-checks` (and `--fast`) force wrapping
  // back on for the rare perf-critical build, `--overflow-checks` forces trapping. Wrapping
  // is otherwise reached only by naming it: `.wrappingAdd`/`.saturatingAdd`/`.checkedAdd`.
  const trapOnOverflow = forceOverflowChecks ?? true;
  // Contract asserts default the same way but are a separate switch: overflow is about
  // what the machine does to your arithmetic, a contract is a claim you wrote down. A
  // release build that keeps its `requires` checks is a normal thing to want, and so is
  // an -O0 build that skips them while you chase an overflow.
  const contractChecks = forceContractChecks ?? (optFlag === "-O0");
  // DWARF is gated on -g alone (compose `-g --debug` for -O0 + line info). Keeping it
  // off --debug leaves the -O0 path — used by the runtime-error test harness — byte
  // -identical and free of per-build dsymutil / .dSYM litter.
  const { ir, cGuards, linkLibs, hasMain } = compileWithGuards(source, target, sourcePath, warningConfig, trapOnOverflow, emitDebug, contractChecks, stripPanicLocations, sanitize);
  // Every path through here links an executable, and an executable needs an entry
  // point. Without this the linker answered for us, with `Undefined symbols: "_main"`
  // and a stack of ld noise that names no Milo file: the same report you get for a
  // missing extern, so a library built by mistake looked like a broken FFI decl.
  if (!hasMain) {
    console.error(`error: no entry point: '${sourcePath}' has no main()`);
    console.error(`hint: a module without 'fn main()' is a library: import it from a program, or check it with 'milo check ${sourcePath}'`);
    process.exit(1);
  }
  verifyCDecls(cGuards, target, linkLibs);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  // Windows won't execute a file without the .exe suffix, and lld-link appends it
  // itself — so without this the compiler reports one path and writes another.
  const exeSuffix = target.os === "windows" ? ".exe" : "";
  const out = (outputPath ?? join(tmpdir(), `milo_${base}_${id}`)) +
    (exeSuffix && !(outputPath ?? "").endsWith(".exe") ? exeSuffix : "");
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  // The linker won't create -o's parent dir; without this it errors with
  // "ld: open() failed" on a fresh checkout (e.g. building into a bin/ that
  // isn't there yet). Guarded by existsSync because `recursive: true` is not
  // idempotent on Windows: `mkdir "."` throws EEXIST there rather than
  // succeeding, so every `-o name` with no directory part died on that runner.
  const outDir = dirname(out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  try {
    writeFileSync(tmpLl, ir);
    // Dev hook: keep a copy of the whole-program IR for inspection (objdump shows
    // what clang made of it, not what we handed clang).
    if (process.env.MILO_KEEP_LL) writeFileSync(process.env.MILO_KEEP_LL, ir);
    if (target.arch === "wasm64") {
      // Also bareMetal (freestanding), but a different freestanding runtime/linker
      // path than ARM Cortex-M — see linkWasm's comment and target.ts's bareMetal
      // field comment for why this check runs before the bareMetal branch below.
      linkWasm(tmpLl, out, target, optFlag, heapSize);
    } else if (target.bareMetal) {
      // Freestanding link: program IR + startup runtime + linker script → ELF.
      linkBareMetal(tmpLl, out, target, optFlag, heapSize);
    } else {
      const libs = detectLibs(ir, target, staticDeps) + declaredLibSpec(linkLibs, target, staticDeps);
      const extra = extraLinkFlags.length ? " " + extraLinkFlags.join(" ") : "";
      linkIR(tmpLl, out, optFlag, libs, extra, sanitize, emitDebug, target);
    }
  } catch (e: any) {
    console.error(`error[link]: compilation failed:\n${e.stderr?.toString() ?? e.message}`);
    // Attribute injected link flags to their source so an "undefined symbol" or
    // "library not found" is traceable to the @link that requested it (vs an
    // auto-detected lib or a `--` passthrough). Re-run with MILO_VERBOSE=1 for the full command.
    if (linkLibs.length) {
      // Spell each one the way it actually reaches the linker — a `framework:` name
      // printed as `-lframework:Foo` is not a flag anyone could act on.
      const spelled = linkLibs.map(l => l.startsWith("framework:") ? `-framework ${l.slice("framework:".length)}` : `-l${l}`).join(" ");
      console.error(`note: ${spelled} added by @link(...) in your source — remove the @link or install the library (MILO_VERBOSE=1 to see the full link command)`);
    }
    const host = getHostTarget();
    if (!target.bareMetal && (target.os !== host.os || target.arch !== host.arch)) {
      console.error(`hint: cross-compiling to ${target.triple} needs a linker and sysroot for that target — the host toolchain can't link it. Until then, build on the target.`);
    }
    process.exit(1);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

function compileSourceToBinary(source: string, sourcePath: string, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig): string {
  const { ir, cGuards, linkLibs } = compileWithGuards(source, target, sourcePath, warningConfig);
  verifyCDecls(cGuards, target, linkLibs);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);
  try {
    writeFileSync(tmpLl, ir);
    const libs = detectLibs(ir, target) + declaredLibSpec(linkLibs, target, false);
    linkIR(tmpLl, out, optFlag, libs, "", false, false, target);
  } catch (e: any) {
    throw new Error(`compilation failed:\n${e.stderr?.toString() ?? e.message}`);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

// Directories a test sweep should never descend into: dependency/build caches that can
// hold a copy of someone else's suite.
const TEST_SCAN_SKIP = new Set(["node_modules", ".git", ".milo", ".selfhost", "target", "dist"]);

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (TEST_SCAN_SKIP.has(e.name) || e.name.startsWith(".")) continue;
      out.push(...collectTestFiles(join(dir, e.name)));
    } else if (e.name.endsWith("_test.milo")) {
      out.push(join(dir, e.name));
    }
  }
  return out.sort();
}

// A test is a top-level `fn test*()` taking no parameters. Discovered from the parsed AST,
// never by scanning the text: a regex over source counts `fn testFoo(` inside a comment or
// a string literal, and — worse — misses one written differently, which is a test silently
// not running. Anything named `test*` that is NOT a valid test is reported, not skipped.
type TestDiscovery = { tests: string[]; rejected: { name: string; why: string }[] };

function discoverTests(source: string, file: string): TestDiscovery {
  const tokens = new Lexer(source).tokenize();
  const program = new Parser(tokens, source, file).parse();
  const tests: string[] = [];
  const rejected: { name: string; why: string }[] = [];
  for (const fn of program.functions) {
    if (!fn.name.startsWith("test")) continue;
    if (fn.isExtern) continue;
    if (fn.typeParams.length > 0) { rejected.push({ name: fn.name, why: "generic functions cannot be run as tests" }); continue; }
    if (fn.params.length > 0) { rejected.push({ name: fn.name, why: `takes ${fn.params.length} parameter(s); a test takes none` }); continue; }
    tests.push(fn.name);
  }
  return { tests, rejected };
}

/**
 * A `main` that runs ONE test, named by argv[1]. One compile per file, one process per
 * test: that is what buys isolation, because a test that traps (overflow, bounds, failed
 * assert) takes down only its own process and the rest of the file still reports.
 * The import is aliased so it cannot collide with the test file's own imports — a
 * duplicate declaration in one file is a resolver error.
 */
function testHarnessMain(tests: string[]): string {
  const dispatch = tests.map(name =>
    `    if __miloTestName == "${name}" {\n        ${name}()\n        return 0\n    }`).join("\n");
  return [
    ``,
    `from "std/args" import { args as __miloTestArgv }`,
    ``,
    `fn main(): i32 {`,
    `    let __miloTestArgs = __miloTestArgv()`,
    `    if __miloTestArgs.len() < 2 {`,
    `        eprint("milo test harness: expected a test name")`,
    `        return 2`,
    `    }`,
    `    let __miloTestName = __miloTestArgs[1]`,
    dispatch,
    `    eprint($"milo test harness: no such test {__miloTestName}")`,
    `    return 2`,
    `}`,
    ``,
  ].join("\n");
}

const TEST_TIMEOUT_MS = 30_000;
const TEST_MEM_MB = 2048;

async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]!, i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

type TestOutcome = { file: string; name: string; ok: boolean; ms: number; output: string };

// `milo test [--json]`. The JSON form (schema 1) is a PUBLIC surface: a CI dashboard, a
// flake tracker or a bisect script wants per-test records, and the alternative is scraping
// a log whose ✓/✗ lines were never a contract.
const TEST_JSON_SCHEMA = 1;

async function runTests(
  testFiles: string[],
  target: TargetInfo,
  optFlag: string,
  warningConfig?: WarningConfig,
  filter?: string,
  json = false,
) {
  // In JSON mode nothing but the payload may reach stdout, or the consumer parses a log
  // line as the document.
  const log = (line: string) => { if (!json) console.log(line); };
  let re: RegExp | null = null;
  if (filter) {
    try { re = new RegExp(filter); } catch { re = null; }
  }
  const matches = (file: string, name: string) =>
    !filter || (re ? re.test(name) || re.test(`${file} > ${name}`) : name.includes(filter));

  // Test binaries are milo-built and can hang or run away, so every child stays guarded
  // and the pool is sized the same way the rest of the repo sizes clang fan-out.
  const jobs = Number(process.env.MILO_TEST_JOBS)
    || Math.min(8, Math.max(2, (navigator.hardwareConcurrency ?? 8) - 2));

  const outcomes: TestOutcome[] = [];
  const compileErrors: { file: string; message: string }[] = [];
  let skipped = 0;
  const started = Date.now();

  for (const file of testFiles) {
    const source = readFileSync(file, "utf-8");
    let found: TestDiscovery;
    try {
      found = discoverTests(source, file);
    } catch (e: any) {
      compileErrors.push({ file, message: e.message ?? String(e) });
      continue;
    }
    for (const r of found.rejected) {
      log(`${DIM}  ${file}: skipping ${r.name} — ${r.why}${RESET}`);
    }
    const selected = found.tests.filter(name => matches(file, name));
    skipped += found.tests.length - selected.length;
    if (selected.length === 0) continue;

    let bin: string;
    try {
      bin = compileSourceToBinary(source + testHarnessMain(found.tests), file, target, optFlag, warningConfig);
    } catch (e: any) {
      compileErrors.push({ file, message: e.message ?? String(e) });
      continue;
    }

    log(`\n${BOLD}${file}${RESET}`);
    const fileOutcomes: TestOutcome[] = new Array(selected.length);
    try {
      await mapPool(selected, jobs, async (name, i) => {
        const t0 = Date.now();
        const r = await guardedRun(bin, [name], { timeoutMs: TEST_TIMEOUT_MS, memMb: TEST_MEM_MB });
        fileOutcomes[i] = {
          file, name, ok: r.code === 0, ms: Date.now() - t0,
          output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
        };
      });
    } finally {
      try { unlinkSync(bin); } catch {}
    }
    // Printed after the pool so concurrent tests cannot interleave their lines.
    for (const o of fileOutcomes) {
      if (!o) continue;
      log(o.ok ? `  ${GREEN}✓${RESET} ${o.name} ${DIM}[${o.ms}ms]${RESET}`
               : `  ✗ ${o.name} ${DIM}[${o.ms}ms]${RESET}`);
      if (!o.ok && o.output.trim()) {
        for (const line of o.output.trimEnd().split("\n")) log(`      ${line}`);
      }
      outcomes.push(o);
    }
  }

  const passed = outcomes.filter(o => o.ok).length;
  const failed = outcomes.length - passed;
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);

  if (json) {
    writeStdout(JSON.stringify({
      schema: TEST_JSON_SCHEMA,
      ok: failed === 0 && compileErrors.length === 0,
      passed,
      failed,
      // A file that would not compile ran no tests at all: reporting it as a failed test
      // would understate it, and dropping it would make a broken suite look green.
      compileErrors,
      filteredOut: skipped,
      durationMs: Date.now() - started,
      tests: outcomes.map(o => ({
        file: o.file, name: o.name, ok: o.ok, ms: o.ms,
        ...(o.ok ? {} : { output: o.output }),
      })),
    }, null, 2) + "\n");
    if (failed > 0 || compileErrors.length > 0) process.exit(1);
    if (outcomes.length === 0 && filter) process.exit(1);
    return;
  }

  console.log("");
  if (compileErrors.length) {
    for (const c of compileErrors) console.log(`${c.file}: compile error\n  ${c.message.split("\n").join("\n  ")}`);
  }
  const skipNote = skipped > 0 ? `, ${skipped} filtered out` : "";
  const noun = outcomes.length === 1 ? "test" : "tests";
  console.log(`${passed} pass, ${failed} fail${skipNote} — ${outcomes.length} ${noun} in ${elapsed}s`);
  if (failed > 0) {
    console.log("failures:");
    for (const o of outcomes) if (!o.ok) console.log(`  ${o.file} > ${o.name}`);
  }
  if (failed > 0 || compileErrors.length > 0) process.exit(1);
  // A filter that matched nothing is a mistyped pattern, not a green run.
  if (outcomes.length === 0 && filter) {
    console.log(`no test matched '${filter}'`);
    process.exit(1);
  }
}

// Compiled programs run with an RSS watchdog BY DEFAULT: macOS enforces no
// rlimits, and one runaway allocation (e.g. a milo-self memory bug) swaps the
// whole machine to death. Raise with MILO_RUN_MEM_MB, disable with
// MILO_RUN_UNGUARDED=1. No wall-clock timeout — long-running programs are legal.
async function runFile(sourcePath: string, extraArgs: string[], target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, sanitize: boolean = false, emitDebug = false, heapSize: number | null = null, overflowChecks: boolean | null = null, contractChecks: boolean | null = null) {
  const bin = compileToBinary(sourcePath, null, target, optFlag, warningConfig, [], sanitize, emitDebug, heapSize, overflowChecks, false, contractChecks);
  try {
    if (target.arch === "wasm64") {
      runWasm(bin, extraArgs); // process.exit()s itself with the wasm program's exit code
      return;
    }
    if (target.bareMetal) {
      runBareMetalQemu(bin, target);
      return;
    }
    const memMb = Number(process.env.MILO_RUN_MEM_MB || 0) || DEFAULT_MEM_MB;
    const child = spawn(bin, extraArgs, { stdio: "inherit" });
    let breached = false;
    // The watchdog reads phys_footprint / proc rss through POSIX interfaces that don't
    // exist on Windows. It also isn't needed there for the reason it exists here: the
    // guard is a macOS mitigation (no enforced rlimits + a compressor that hides a
    // runaway's RSS). Skipping it on win32 must never widen to darwin/linux.
    const stop =
      process.env.MILO_RUN_UNGUARDED === "1" || process.platform === "win32"
        ? () => {}
        : monitorPidTree(child.pid!, memMb, (rssMb, reason) => {
            breached = true;
            console.error(
              reason === "pressure"
                ? `\nerror: system memory pressure — program killed fail-closed (footprint ${rssMb} MB).`
                : `\nerror: program exceeded ${memMb} MB (footprint ${rssMb} MB) and was killed.` +
                    `\n       raise the cap with MILO_RUN_MEM_MB=<mb> or disable with MILO_RUN_UNGUARDED=1`
            );
          });
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(res => {
      child.on("error", () => res({ code: 127, signal: null }));
      child.on("close", (code, signal) => res({ code, signal }));
    });
    stop();
    if (breached) process.exit(137);
    if (signal) process.exit(137);
    if (code !== 0) process.exit(code ?? 1);
  } finally {
    try { unlinkSync(bin); } catch {}
  }
}

// Run a bare-metal ELF under QEMU with semihosting. The program's stdout/exit
// arrive on the semihosting console (startup.c prints "exit=<n>"); QEMU's own
// process exit is always 1 for legacy SYS_EXIT, so we don't propagate it.
function runBareMetalQemu(bin: string, target: TargetInfo) {
  const machine = target.qemuMachine;
  if (!machine) {
    console.error(`error: no QEMU machine configured for ${target.triple}`);
    process.exit(1);
  }
  const qemu = "qemu-system-arm";
  try {
    execSync(`${qemu} --version`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    console.error(`error: ${qemu} not found on PATH — install QEMU to run bare-metal targets (brew install qemu)`);
    process.exit(1);
  }
  // -semihosting routes the program's bkpt 0xAB I/O to this console; -nographic
  // keeps it headless. mcpu pins the core so the AN board models the right one.
  // QEMU always exits 1 on legacy SYS_EXIT regardless of the program's status,
  // so we capture+forward the console output and treat a clean run as success;
  // the program's actual result is the "exit=<n>" line startup.c prints.
  const r = spawnSync(qemu, ["-machine", machine, "-cpu", target.mcpu!, "-semihosting", "-nographic", "-kernel", bin], {
    encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) { console.error(`error: failed to run ${qemu}: ${r.error.message}`); process.exit(1); }
  // QEMU emits semihosting console output on its stderr; that's the Milo
  // program's stdout, so forward it there (not to our stderr).
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(r.stderr);
}

// Run a wasm64 module through tools/wasm/run.mjs (the host env.* imports live there,
// not here — see that file). Deliberately shells out to `node`, not `bun`, despite
// this repo's usual rule: verified empirically that Bun 1.3.10 (JavaScriptCore)
// rejects the module outright — "Memory64 is not enabled" — while Node 25 (V8)
// instantiates and runs it with no flag at all (older V8/Node needed
// --experimental-wasm-memory64; that flag no longer exists in Node 25 because the
// feature shipped unflagged). This is a real engine capability gap, not a style
// choice, and it matters beyond this CLI path: it's the same gap a browser embedding
// would hit depending on which engine renders the page.
function runWasm(bin: string, extraArgs: string[]) {
  const loader = join(wasmDir(), "run.mjs");
  if (!existsSync(loader)) {
    console.error(`error: wasm64 loader not found at ${loader} (need run.mjs)`);
    process.exit(1);
  }
  const r = spawnSync("node", [loader, bin, ...extraArgs], { stdio: "inherit" });
  if (r.error) { console.error(`error: failed to run node ${loader}: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

// Parse a heap-size argument (bare-metal only): plain bytes, or a k/m suffix
// (1024-based). "64k" → 65536, "2m" → 2097152. Returns null on malformed input.
function parseHeapSize(s: string): number | null {
  const m = /^(\d+)([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = m[2] === "" ? 1 : (m[2].toLowerCase() === "k" ? 1024 : 1024 * 1024);
  return n * mult;
}

function parseArgs(args: string[]): { output: string | null; source: string | null; rest: string[]; optFlag: string; warningConfig: WarningConfig; noEntry: boolean; safetyLevel: string | null; sanitize: boolean; targetName: string | null; emitHeader: boolean; emitDebug: boolean; heapSize: number | null; overflowChecks: boolean | null; contractChecks: boolean | null; staticDeps: boolean; emitAll: boolean; emitSpans: boolean; stripPanicLocations: boolean } {
  let output: string | null = null;
  let source: string | null = null;
  let optFlag = "-O2";
  let emitDebug = false;
  let noEntry = false;
  let safetyLevel: string | null = null;
  let sanitize = false;
  let staticDeps = false;
  let targetName: string | null = null;
  let emitHeader = false;
  let heapSize: number | null = null;
  const rest: string[] = [];
  const denied = new Set<string>();
  const allowed = new Set<string>();
  // `--expect=<name>`: suppress like `--allow`, but report if the warning stops firing.
  const expected = new Set<string>();
  let maxStackArrayBytes: number | undefined;
  let overflowChecks: boolean | null = null;
  let contractChecks: boolean | null = null;
  let stripPanicLocations = false;
  // emit-ast / emit-hir dump controls. Parsed here (not left to fall through) because an
  // unrecognized `--flag` would otherwise be swallowed as the source-file positional below.
  let emitAll = false;
  let emitSpans = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
    else if (args[i] === "--debug") { optFlag = "-O0"; }
    // Fast edit-loop builds: -O0 is ~2x quicker to compile but would flip arithmetic from
    // wrapping to trapping, so pair it with checks off to keep -O2's semantics. Runtime is
    // up to ~2.4x slower, which is why this is opt-in rather than the default for `run`.
    // A later explicit --overflow-checks still wins (the loop is order-sensitive).
    else if (args[i] === "--fast") { optFlag = "-O0"; overflowChecks = false; contractChecks = false; }
    else if (args[i] === "-g") { emitDebug = true; } // DWARF line info, composes with any -O
    // Codegen units: clang is ~95% of build time and parallelises across processes.
    // `--cgus=1` forces the single module back (the shape release builds and -g already
    // get), `--cgus=N` forces N regardless of size or opt level.
    else if (args[i]?.startsWith("--cgus=")) {
      const n = Number(args[i]!.slice("--cgus=".length));
      if (!Number.isFinite(n) || n < 1) { console.error(`error: --cgus expects a positive integer, got '${args[i]!.slice(7)}'`); process.exit(1); }
      cguOverride = Math.floor(n);
    }
    else if (args[i] === "--no-entry") { noEntry = true; }
    else if (args[i] === "--sanitize") { sanitize = true; }
    else if (args[i] === "--static-deps") { staticDeps = true; }
    else if (args[i] === "--overflow-checks") { overflowChecks = true; }
    else if (args[i] === "--no-overflow-checks") { overflowChecks = false; }
    else if (args[i] === "--strip-panic-locations") { stripPanicLocations = true; }
    else if (args[i] === "--contract-checks") { contractChecks = true; }
    else if (args[i] === "--no-contract-checks") { contractChecks = false; }
    else if (args[i] === "--emit-header") { emitHeader = true; }
    else if (args[i] === "--all") { emitAll = true; }        // emit-ast/emit-hir: include imported modules
    else if (args[i] === "--spans") { emitSpans = true; }    // emit-ast/emit-hir: keep source spans in the dump
    else if (args[i] === "-O" && i + 1 < args.length) { optFlag = `-O${args[++i]}`; }
    else if (/^-O[0-3sz]$/.test(args[i])) { optFlag = args[i]; }
    else if (args[i] === "--deny-all") { denied.add("*"); }
    else if (args[i].startsWith("--deny=")) { denied.add(args[i].slice(7)); }
    else if (args[i] === "--deny" && i + 1 < args.length) { denied.add(args[++i]); }
    else if (args[i].startsWith("--expect=")) { expected.add(args[i].slice(9)); }
    else if (args[i] === "--expect" && i + 1 < args.length) { expected.add(args[++i]); }
    else if (args[i].startsWith("--allow=")) { allowed.add(args[i].slice(8)); }
    else if (args[i] === "--allow" && i + 1 < args.length) { allowed.add(args[++i]); }
    else if (args[i].startsWith("--max-stack-array=") || args[i] === "--max-stack-array") {
      const raw = args[i] === "--max-stack-array" ? args[++i] : args[i].slice(18);
      const parsed = raw == null ? null : parseHeapSize(raw);
      if (parsed == null) { console.error(`error: --max-stack-array expects bytes or a k/m suffix (e.g. 256k, 1m), got '${raw}'`); process.exit(1); }
      maxStackArrayBytes = parsed;
    }
    else if (args[i].startsWith("--safety=")) { safetyLevel = args[i].slice(9); }
    else if (args[i] === "--safety" && i + 1 < args.length) { safetyLevel = args[++i]; }
    else if (args[i].startsWith("--target=")) { targetName = args[i].slice(9); }
    else if (args[i] === "--target" && i + 1 < args.length) { targetName = args[++i]; }
    else if (args[i].startsWith("--heap-size=") || args[i] === "--heap-size") {
      const raw = args[i] === "--heap-size" ? args[++i] : args[i].slice(12);
      const parsed = raw == null ? null : parseHeapSize(raw);
      if (parsed == null) { console.error(`error: --heap-size expects bytes or a k/m suffix (e.g. 64k, 2m), got '${raw}'`); process.exit(1); }
      heapSize = parsed;
    }
    else if (args[i] === "--") { rest.push(...args.slice(i + 1)); break; }
    else if (!source) { source = args[i]; }
    else { rest.push(args[i]); }
  }
  // A misspelled warning name used to be accepted in silence, which is the failure this
  // flag family is least able to afford: `--deny=unused-varibale` looked like a project
  // enforcing a lint and enforced nothing. `*` is `--deny-all`, not a name.
  for (const [flag, names] of [["--deny", denied], ["--allow", allowed], ["--expect", expected]] as const) {
    for (const n of names) {
      if (n === "*" || WARNING_NAMES.includes(n)) continue;
      const near = WARNING_NAMES.filter(w => w.startsWith(n.slice(0, 3)) || n.startsWith(w.slice(0, 3)));
      console.error(`error: unknown warning '${n}' in ${flag}=${n}`
        + (near.length ? `\n  did you mean: ${near.join(", ")}?` : `\n  known warnings: ${WARNING_NAMES.join(", ")}`));
      process.exit(1);
    }
  }
  // A milo.json above the source can set lint levels for the whole project, which is how
  // the LSP learns them too (see lsp.ts). Flags win: an explicit `--allow=x` on the command
  // line has to be able to silence a lint the manifest denies, or a one-off build cannot be
  // done without editing the project file.
  if (source) {
    const project = projectLints(dirname(resolve(source)));
    for (const n of project.denied) if (!allowed.has(n) && !expected.has(n)) denied.add(n);
    for (const n of project.allowed) if (!denied.has(n)) allowed.add(n);
  }
  return { output, source, rest, optFlag, warningConfig: { denied, allowed, expected, maxStackArrayBytes }, noEntry, safetyLevel, sanitize, targetName, emitHeader, emitDebug, heapSize, overflowChecks, contractChecks, staticDeps, emitAll, emitSpans, stripPanicLocations };
}

const SKILL_TEXT = `# Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references — no GC, no RC, no lifetime annotations.

## Compile & Run

\`\`\`bash
bun run src/main.ts run file.milo              # compile + run (no artifacts)
bun run src/main.ts build file.milo -o myapp   # compile to binary
bun run src/main.ts emit-ir file.milo          # emit LLVM IR
bun run src/main.ts emit-ast file.milo         # emit parsed AST as JSON (no types yet)
bun run src/main.ts emit-hir file.milo         # emit typed HIR as JSON (every expr carries its type)
bun run src/main.ts build file.milo --release  # -O3 optimized
\`\`\`

## Language Basics

\`\`\`milo
fn main(): i32 {
    print("hello")
    return 0
}
\`\`\`

### Variables
- \`let x = 42\` — immutable binding (cannot reassign)
- \`var x = 42\` — mutable binding
- Type inference works: \`let name = "milo"\` infers \`string\`

### Types
- Integers: \`i8\`, \`i16\`, \`i32\`, \`i64\`, \`u8\`, \`u16\`, \`u32\`, \`u64\`
- Float: \`f64\`
- \`bool\`, \`string\`, \`void\`
- \`Vec<T>\`, \`HashMap<K, V>\`, \`Array<T, N>\`
- \`Option<T>\` (shorthand: \`T?\`), \`Result<T, E>\`

### Functions
\`\`\`milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: &string): void {    // & = immutable reference (borrow)
    print($"hello, {name}!")
}

fn increment(x: &mut i64): void {  // &mut = mutable reference
    x = x + 1
}

// generics
fn first<T>(items: &Vec<T>): &T {
    return items[0]
}
\`\`\`

### Structs & Impl
\`\`\`milo
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64): Point {
        return Point { x: x, y: y }
    }

    fn distance(self: &Self, other: &Point): f64 {
        let dx = self.x - other.x
        let dy = self.y - other.y
        return sqrt(dx * dx + dy * dy)
    }
}
\`\`\`

### Enums & Match
\`\`\`milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Empty,
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => return 3.14159 * r * r
        Shape.Rect(w, h) => return w * h
        Shape.Empty => return 0.0
    }
}
\`\`\`

### Option & Result
\`\`\`milo
fn find(items: &Vec<string>, target: &string): string? {
    var i: i64 = 0
    while i < items.len {
        if items[i] == target {
            return Option.Some(items[i].clone())
        }
        i = i + 1
    }
    return null   // sugar for Option.None
}

// unwrap: expr!   propagate: expr?   default: expr ?? fallback
let val = find(items, "key") ?? "default"
\`\`\`

### Closures
\`\`\`milo
let double = (x: i32) => x * 2
let result = double(21)

var items: Vec<i32> = Vec.new()
items.push(3)
items.push(1)
items.push(2)
items.sort((a: &i32, b: &i32) => a - b)
\`\`\`

### Traits
\`\`\`milo
trait Display {
    fn display(self: &Self): string
}

impl Display for Point {
    fn display(self: &Self): string {
        return $"({self.x}, {self.y})"
    }
}

@derive(Eq)    // auto-derive equality
struct Id { value: i64 }
\`\`\`

### Imports
\`\`\`milo
from "std/io" import { readFile, writeFile }
from "std/json" import { jsonParse, jsonStringify }
from "std/fs" import { isFile, isDir, readDir }
import "other_file.milo"
\`\`\`

### Key Rules
- Move semantics: values have a single owner. After \`let y = x\`, using \`x\` is a compile error. Use \`.clone()\` for explicit copies.
- References (\`&T\`, \`&mut T\`) are second-class: only allowed in function parameters, never stored in structs or returned.
- No null — use \`Option<T>\` (\`T?\`).
- No exceptions — use \`Result<T, E>\` for fallible operations.
- No implicit conversions — use \`expr as Type\` for casts.
- Strings are owned UTF-8 buffers. Pass as \`&string\` to borrow.
- \`unsafe { ... }\` required for FFI calls, raw memory, and exit().
- String interpolation: \`$"hello {name}, count={count}"\`
- No semicolons (statements are newline-delimited).
- camelCase for functions/variables, PascalCase for types.

## Standard Library

Import with \`from "std/<name>" import { ... }\`. Key modules:

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| \`std/io\` | File & stream I/O | \`readFile\`, \`writeFile\`, \`readStdin\`, \`writeStdout\`, \`appendFile\` |
| \`std/fs\` | Filesystem ops | \`isFile\`, \`isDir\`, \`readDir\`, \`mkdir\`, \`remove\`, \`rename\`, \`chmod\`, \`symlink\` |
| \`std/path\` | Path manipulation | \`pathJoin\`, \`pathDir\`, \`pathBase\`, \`pathExt\`, \`pathResolve\` |
| \`std/args\` | Raw CLI arguments | \`args()\` → \`Vec<string>\`, \`getFlag(name)\`, \`hasFlag(name)\` |
| \`std/argparse\` | Declarative arg parser | \`ArgParser.new\`, \`ParsedArgs\` (see detailed section below) |
| \`std/env\` | Environment vars | \`getEnv\`, \`setEnv\`, \`allEnv\` |
| \`std/json\` | JSON parse/serialize | \`jsonParse\`, \`jsonStringify\`, \`JsonValue\` |
| \`std/csv\` | CSV parser | \`csvParse\`, \`csvStringify\` |
| \`std/http\` | HTTP client | \`httpGet\`, \`httpPost\`, \`httpRequest\`, \`HttpResponse\` |
| \`std/net\` | TCP networking | \`tcpConnect\`, \`tcpListen\`, \`TcpStream\`, \`TcpListener\` |
| \`std/crypto\` | Cryptographic hashes | \`sha256\`, \`md5\` |
| \`std/base64\` | Base64 encoding | \`base64Encode\`, \`base64Decode\` |
| \`std/hex\` | Hex encoding | \`hexEncode\`, \`hexDecode\` |
| \`std/regex\` | Regular expressions | \`Regex.compile\`, \`.isMatch\`, \`.find\`, \`.findAll\` |
| \`std/datetime\` | Date and time | \`now\`, \`formatTime\`, \`DateTime\` |
| \`std/time\` | Timing | \`sleep\`, \`clockMs\` |
| \`std/random\` | Random numbers | \`randomI64\`, \`randomF64\`, \`randomRange\` |
| \`std/uuid\` | UUIDs | \`Uuid.v4\`, \`Uuid.v7\`, \`Uuid.parse\`, \`Uuid.nil\` |
| \`std/math\` | Math functions | \`sqrt\`, \`abs\`, \`min\`, \`max\`, \`pow\`, \`floor\`, \`ceil\` |
| \`std/string\` | String utilities | \`split\`, \`join\`, \`trim\`, \`padLeft\`, \`padRight\`, \`repeat\` |
| \`std/strconv\` | String conversions | \`parseInt\`, \`parseFloat\` (both \`Option\`; aliases for \`s.parseInt()\`/\`s.parseF64()\`) |
| \`std/fmt\` | String formatting | \`fmt\`, \`fmtFloat\` |
| \`std/color\` | Terminal colors | \`red\`, \`green\`, \`blue\`, \`bold\`, \`dim\`, \`reset\` |
| \`std/sort\` | Sorting | \`sort\` for Vec with comparator |
| \`std/set\` | Hash set | \`Set<T>\` |
| \`std/url\` | URL parsing | \`parseUrl\`, \`Url\` |
| \`std/log\` | Logging | \`Log.info\`, \`Log.setLevel\`, \`Log.setSinkPath\`, \`Log.str(k,v).int(k,v).warn(msg)\`, \`Logger\` |
| \`std/signal\` | OS signal handling | \`onSignal\` |
| \`std/process\` | Process management | \`exec\`, \`spawn\`, \`ProcessResult\` |
| \`std/thread\` | Threading | \`spawn\` (thread), \`Thread\` |
| \`std/sync\` | Concurrency primitives | \`Mutex\`, \`Channel\`, \`WaitGroup\` |
| \`std/arena\` | Arena allocator | \`Arena\`, \`ArenaRef\` |
| \`std/mem\` | Memory utilities | \`sizeOf\`, \`alignOf\` |
| \`std/cstr\` | C string interop | \`toCStr\`, \`fromCStr\` |
| \`std/sqlite\` | SQLite database | \`sqliteOpen\`, \`sqliteExec\`, \`sqliteQuery\` |
| \`std/unicode\` | Unicode utilities | \`codepoints\`, \`displayWidth\`, \`isAlphaStr\`, \`isNumeric\` |
| \`std/os\` | OS information | \`platform\`, \`arch\`, \`hostname\` |
| \`std/runtime\` | Runtime internals | (internal use) |
| \`std/testing\` | Test assertions | \`assert\`, \`assertEqual\`, \`assertNe\` |
| \`std/prelude\` | Auto-imported types | \`Vec\`, \`HashMap\`, \`Option\`, \`Result\`, \`Heap\`, \`print\`, \`eprint\` |
| \`std/event\` | Event loop (kqueue/epoll) | \`EventLoop\`, \`EventHandler\` |
| \`std/platform\` | Platform detection | \`platform\`, \`arch\` |

Prelude types (\`Vec\`, \`HashMap\`, \`Option\`, \`Result\`, \`Heap\`, \`print\`, \`eprint\`) are available without import.

## Argument Parsing (std/argparse)

This is the recommended way to build CLI tools. Full working example:

\`\`\`milo
from "std/argparse" import { ArgParser }
from "std/io" import { readFile }

fn main(): i32 {
    // 1. Create parser
    var parser = ArgParser.new("mytool", "process text files")

    // 2. Define arguments
    parser.addPositional("file", "input file to process")
    parser.addOptionalPositional("output", "output path (default: stdout)")
    parser.addString("format", "f", "output format", "text")   // flag with default
    parser.addBool("verbose", "v", "enable verbose output")     // boolean flag
    parser.addI64("count", "n", "max items to process", 100)   // integer flag
    parser.addRequired("token", "t", "API token")              // required flag

    // 3. Parse (auto-handles --help, exits on error)
    let args = parser.parse()

    // 4. Read values
    let file = args.getString("file") ?? ""      // Option: None if not provided
    let fmt = args.getString("format") ?? "text" // Some("text") if not provided
    let verbose = args.getBool("verbose")        // false if not provided
    let count = args.getI64("count")             // 100 if not provided
    let token = args.getString("token") ?? ""    // guaranteed present (required)

    if let Option.Some(out) = args.getString("output") {
        // write to file...
        print(out)
    }

    match readFile(file) {
        Result.Ok(content) => {
            if verbose {
                print($"processing {file} ({content.len} bytes)")
            }
            print(content)
        }
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

Running this program:
\`\`\`bash
mytool input.txt --format json -v --token abc123
mytool --help    # prints auto-generated usage
\`\`\`

### ArgParser Builder Methods
- \`addString(long, short, help, default)\` — optional string flag
- \`addRequired(long, short, help)\` — required string flag (exits if missing)
- \`addBool(long, short, help)\` — boolean flag (present = true)
- \`addI64(long, short, help, default)\` — integer flag, validated at parse time
- \`addPositional(name, help)\` — required positional argument
- \`addOptionalPositional(name, help)\` — optional positional
- \`enableTrailingArgs()\` — stop flag parsing after first positional, collect rest as-is

### Parsing Methods
- \`parse()\` — parse from process arguments
- \`parseFrom(argv: Vec<string>)\` — parse from a provided arg list (argv[0] = program name, skipped)

### ParsedArgs Query Methods
- \`getString(name)\` — \`Option<string>\`; \`None\` if undeclared, or declared with no
  default and not supplied. \`--flag ""\` is \`Some("")\`. Collapse with \`?? "fallback"\`.
- \`getI64(name)\` — get integer value
- \`getU16(name)\` — get u16 value (validated 0..65535)
- \`getBool(name)\` — check boolean flag
- \`has(name)\` — check if flag/positional was provided
- \`.positional\` — \`Vec<string>\` of remaining positional args

### Trailing Args and -- Separator
\`\`\`milo
parser.enableTrailingArgs()
// mytool build -- --extra-flag    →  args.positional contains ["--extra-flag"]
\`\`\`

## Common Patterns

### Error Handling with Result
\`\`\`milo
from "std/io" import { readFile }

fn processFile(path: &string): Result<string, string> {
    let content = readFile(path)?   // ? propagates error
    // process content...
    return Result.Ok(content)
}

fn main(): i32 {
    match processFile("data.txt") {
        Result.Ok(data) => print(data)
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

### Vec Operations
\`\`\`milo
var items: Vec<string> = Vec.new()
items.push("one")
items.push("two")
items.push("three")
print($"count: {items.len}")   // 3
let first = items[0]           // "one"
items.sort((a: &string, b: &string) => a.len - b.len)
\`\`\`

### HashMap
\`\`\`milo
var counts: HashMap<string, i64> = HashMap.new()
counts.set("apples", 5)
counts.set("oranges", 3)
if counts.has("apples") {
    let n = must(counts, "apples", "counts")
    print($"apples: {n}")
}
\`\`\`

### String Interpolation
\`\`\`milo
let name = "world"
let count = 42
print($"hello {name}, count={count}")
print($"hex: {count}")
print($"result: {1 + 2}")
\`\`\`

### Threads and Channels
\`\`\`milo
from "std/thread" import { greenSpawn }
from "std/sync" import { newChannel }

fn main(): i32 {
    var ch = newChannel<i64>()
    greenSpawn(() => {
        ch.send(42)
    })
    let val = ch.recv()
    print($"got: {val}")
    return 0
}
\`\`\`

### JSON
\`\`\`milo
from "std/json" import { jsonParse, jsonStringify }

struct Config {
    name: string,
    port: i64,
    debug: bool,
}

let config = Config { name: "app", port: 8080, debug: false }
let json = jsonStringify(config)
print(json)   // {"name":"app","port":8080,"debug":false}
\`\`\`

## What NOT to Do
- No garbage collector or reference counting — values are moved or cloned explicitly.
- No storing references in structs — \`&T\` is only valid in function params.
- No raw pointers in safe code — use \`unsafe { ... }\` for FFI.
- No implicit type conversions — cast with \`as\`.
- No exceptions or try/catch — use \`Result<T, E>\` and \`?\` propagation.
- No null — use \`Option<T>\` (\`T?\`) and pattern match or \`??\` for defaults.
- No semicolons — statements are newline-separated.
- No class inheritance — use traits and composition.
`;

// "compiled <src> -> <out> in <t>" with color on a TTY, plain when piped/redirected.
function reportCompiled(source: string, out: string, elapsedMs: number) {
  const t = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(2)}s` : `${Math.round(elapsedMs)}ms`;
  if (process.stdout.isTTY) {
    console.log(`${GREEN}${BOLD}compiled${RESET} ${source} ${DIM}->${RESET} ${BOLD}${out}${RESET} ${DIM}in${RESET} ${GREEN}${t}${RESET}`);
  } else {
    console.log(`compiled ${source} -> ${out} in ${t}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Handled before the usage banner and the unknown-command guard: `--version` is
  // the first thing anyone types after installing, and it should never print a
  // 60-line help screen or an error.
  if (args[0] === "--version" || args[0] === "-V" || args[0] === "version") {
    console.log(versionString());
    process.exit(0);
  }

  if (args.length < 1) {
    console.log(renderHelp());
    process.exit(1);
  }

  const cmd = args[0];

  // `--help` was exempted from the unknown-command guard but nothing then printed the
  // banner: it fell through the whole dispatch to `unknown command: --help`, and `-h`
  // reached "error: no source file". Both are the first thing anyone types.
  if (cmd === "--help" || cmd === "-h") {
    console.log(renderHelp());
    process.exit(0);
  }

  // Reject an unknown subcommand up front. Otherwise a bare file path (forgot `run`)
  // falls through every dispatch branch to the generic "no source file" below.
  const KNOWN_COMMANDS = new Set(knownCommandNames());
  if (!KNOWN_COMMANDS.has(cmd) && cmd !== "--help" && cmd !== "-h") {
    console.error(`error: unknown command '${cmd}'`);
    console.error(`run 'milo' with no arguments to see available commands`);
    process.exit(1);
  }

  // Package-manager verbs. Dispatched before parseArgs because they take package
  // specs, not source files, and share none of the compiler flag surface.
  if (PKG_COMMANDS.has(cmd)) {
    const pkgTarget = getHostTarget();
    const { runPkgCommand } = await import("./pkgcli");
    process.exit(await runPkgCommand(cmd, args.slice(1), {
      build: (src, out, extraLinkFlags) => compileToBinary(src, out, pkgTarget, "-O2", undefined, extraLinkFlags),
      check: (src) => { parseCheckProgram(readFileSync(src, "utf-8"), pkgTarget, src); },
      os: pkgTarget.os,
    }));
  }

  if (cmd === "skill") {
    process.stdout.write(SKILL_TEXT);
    return;
  }

  if (cmd === "api") {
    const { runApiSearch } = require("./api-search");
    process.exit(runApiSearch(args.slice(1)));
  }

  if (cmd === "lang") {
    const { runLangInfo } = require("./lang-info");
    process.exit(runLangInfo(args.slice(1)));
  }

  if (cmd === "doc") {
    const { runMiloDoc } = require("./api-search");
    process.exit(runMiloDoc(args.slice(1)));
  }

  if (cmd === "lsp") {
    // Awaited so a module-init throw (e.g. UnsupportedHostError from the host-target
    // probe) surfaces through main()'s handler instead of as an unhandled rejection.
    await import("./lsp");
    return;
  }

  if (cmd === "lex") {
    const file = args[1];
    if (!file) { console.error("error: no source file"); process.exit(1); }
    const source = readFileSync(file, "utf-8");
    const tokens = new Lexer(source).tokenize();
    function escapeValue(s: string): string {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 10) out += "\\n";
        else if (c === 9) out += "\\t";
        else if (c === 13) out += "\\r";
        else if (c === 0) out += "\\0";
        else if (c < 32 || c === 127) out += `\\x${c.toString(16).padStart(2, "0")}`;
        else out += s[i];
      }
      return out;
    }
    for (const tok of tokens) {
      if (tok.leadingTrivia) {
        for (const t of tok.leadingTrivia) {
          if (t.kind === "blank") console.log(`L_BLANK\t\t${t.line}`);
          else console.log(`L_COMMENT\t${escapeValue(t.text)}\t${t.line}`);
        }
      }
      console.log(`${tok.kind}\t${escapeValue(tok.value)}\t${tok.line}:${tok.col}`);
      if (tok.trailingTrivia) {
        for (const t of tok.trailingTrivia) {
          console.log(`T_COMMENT\t${escapeValue(t.text)}\t${t.line}`);
        }
      }
    }
    return;
  }

  if (cmd === "fmt") {
    const fmtArgs = args.slice(1);
    const write = fmtArgs.includes("-w");
    const files = fmtArgs.filter(a => a !== "-w");
    if (files.length === 0) { console.error("error: no files to format"); process.exit(1); }

    // fmt.milo (built to a binary) is the sole formatter — never fall back to
    // anything divergent, so `milo fmt` always produces the same bytes as the
    // editor's format-on-save. src/fmtbin.ts picks the checkout or cache path.
    const resolved = ensureFmtBinary();
    if ("error" in resolved) {
      console.error(`error: could not build the formatter: ${resolved.error}`);
      process.exit(1);
    }
    const fmtBin = resolved.path;

    let changed = 0;
    for (const f of files) {
      const before = write ? readFileSync(f, "utf-8") : null;
      const result = await guardedRun(fmtBin, write ? ["-w", f] : [f], { timeoutMs: 30000, memMb: 1024 });
      if (result.code !== 0) { console.error(result.stderr || `error formatting ${f}`); process.exit(1); }
      if (!write) { process.stdout.write(result.stdout); continue; }
      if (readFileSync(f, "utf-8") !== before) { console.log(f); changed++; }
    }
    if (write && changed === 0) console.log("all files already formatted");
    return;
  }

  const { output, source, rest, optFlag, warningConfig, noEntry, safetyLevel, sanitize, targetName, emitHeader, emitDebug, heapSize, overflowChecks, contractChecks, staticDeps, emitAll, emitSpans, stripPanicLocations } = parseArgs(args.slice(1));
  let target = getHostTarget();
  if (targetName) {
    const resolved = resolveTarget(targetName);
    if (!resolved) {
      console.error(`unknown target: ${targetName}`);
      console.error(`available targets: ${listTargets().join(", ")}`);
      process.exit(1);
    }
    target = resolved;
  }

  if (cmd === "build-lib") {
    const libArgs = args.slice(1);
    const sources = libArgs.filter(a => a.endsWith(".milo"));
    const libOutput = output ?? "lib.a";
    if (sources.length === 0) { console.error("error: no .milo source files"); process.exit(1); }
    buildLib(sources, libOutput, target, optFlag, warningConfig, overflowChecks, contractChecks);
    console.log(`compiled ${sources.length} file(s) -> ${libOutput}`);
    return;
  }

  if (cmd === "safety" && args.slice(1).includes("--list")) {
    console.log(listSafetyLevels());
    return;
  }

  // Ahead of the source check below: `milo test` takes files OR directories, and a bare
  // `milo test` (no positional at all) means "this directory".
  if (cmd === "test") {
    let testArgs = args.slice(1);
    // `-t <pattern>` / `--test-name-pattern <pattern>` filter, stripped before parseArgs so
    // the pattern is never mistaken for the source positional.
    let testFilter: string | undefined;
    const filtered: string[] = [];
    for (let i = 0; i < testArgs.length; i++) {
      const a = testArgs[i]!;
      if (a === "-t" || a === "--test-name-pattern") {
        if (i + 1 >= testArgs.length) { console.error(`error: ${a} expects a pattern`); process.exit(1); }
        testFilter = testArgs[++i];
      } else if (a.startsWith("--test-name-pattern=")) {
        testFilter = a.slice("--test-name-pattern=".length);
      } else {
        filtered.push(a);
      }
    }
    testArgs = filtered;
    const { source: testSource, rest: testRest, optFlag: testOpt, warningConfig: testWc } = parseArgs(testArgs);
    const roots = [testSource, ...testRest].filter((a): a is string => a != null && !a.startsWith("-"));
    const files: string[] = [];
    for (const p of roots.length > 0 ? roots : [process.cwd()]) {
      if (!existsSync(p)) { console.error(`error: no such file or directory: ${p}`); process.exit(1); }
      if (statSync(p).isDirectory()) {
        const found = collectTestFiles(p);
        if (found.length === 0) { console.error(`no *_test.milo files under ${p}`); process.exit(1); }
        files.push(...found);
      } else {
        files.push(p);
      }
    }
    if (files.length === 0) { console.error("no test files found"); process.exit(1); }
    await runTests(files, target, testOpt, testWc, testFilter, testArgs.includes("--json"));
    return;
  }

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

  if (cmd === "prove" && rest.includes("--emit-smt")) {
    const src = readFileSync(source!, "utf-8");
    const program = parseCheckProgram(src, target, source!, warningConfig);
    const result = generateVerificationConditions(program, rest.includes("--all") ? undefined : { onlyFile: source! });
    // Rendered text, not the program: an analysis report names functions and types for a
    // reader, so the per-module pass's symbols get swapped back out on the way to stdout.
    console.log(display(program.displayNames, formatVerifyReport(result)));
    return;
  }

  if (cmd === "wcet") {
    // Emit OTAWA flow facts (loop iteration bounds) for WCET analysis. Output
    // goes to -o <file> or stdout. Use after `milo safety` confirms bounded loops.
    const src = readFileSync(source!, "utf-8");
    const program = parseCheckProgram(src, target, source!, warningConfig);
    const facts = extractFlowFacts(program, source!);
    // --cycles: go past flow facts to an actual Cortex-M3 cycle bound by
    // disassembling the linked ELF and applying the core timing model.
    if (rest.includes("--cycles")) {
      // wasm64 is also bareMetal (see target.ts) but has no ARM core to disassemble
      // against and no cycle timing model — estimateLoopCycles below assumes an ELF.
      if (!target.bareMetal || target.arch === "wasm64") {
        console.error("error: --cycles requires a bare-metal ARM target (e.g. --target=cortex-m3)");
        process.exit(1);
      }
      const elf = compileToBinary(source!, null, target, optFlag, warningConfig, [], false);
      try {
        let any = false;
        for (const b of facts.bounds) {
          if (b.kind === "unresolved" || b.count === null) continue;
          const est = estimateLoopCycles(elf, b.fn, b.count);
          if (est) { console.log(formatCycleEstimate(est, target.triple)); any = true; }
        }
        if (!any) console.log("no bounded loops with a resolvable cycle estimate");
      } finally {
        try { unlinkSync(elf); } catch {}
      }
      return;
    }
    const ff = formatFlowFacts(facts);
    if (output) {
      writeFileSync(output, ff);
      console.log(`wrote flow facts -> ${output}`);
    } else {
      process.stdout.write(ff);
    }
    return;
  }

  if (cmd === "prove") {
    const src = readFileSync(source!, "utf-8");
    const program = parseCheckProgram(src, target, source!, warningConfig);
    const vcs = generateVerificationConditions(program, rest.includes("--all") ? undefined : { onlyFile: source! });
    // Default engine is std/smt (the prover written in Milo itself); --solver=z3
    // opts into z3 for the theories std/smt doesn't yet model.
    const useZ3 = rest.includes("--solver=z3") || rest.includes("--z3");
    const pr = useZ3 ? proveWithZ3(vcs) : proveWithMilo(vcs);
    if (rest.includes("--json")) writeStdout(display(program.displayNames, proveJson(pr)));
    else console.log(display(program.displayNames, formatProveReport(pr)));
    if (pr.failed > 0) process.exit(1);
    return;
  }

  if (cmd === "safety") {
    const level = parseSafetyLevel(safetyLevel ?? args[2] ?? "");
    if (!level) {
      console.error(`unknown safety level: ${safetyLevel ?? args[2] ?? "(none)"}`);
      console.error("use 'milo safety --list' to see available profiles");
      process.exit(1);
    }
    const src = readFileSync(source!, "utf-8");
    const diagnostics: Diagnostic[] = [];
    // A profile that requires used results must see every finding: an `--allow` or a
    // project-level allow would otherwise suppress the warning inside the checker and the
    // profile would report pass on the code it exists to reject.
    if (requiresUsedResults(level)) {
      warningConfig.allowed.delete("unused-result");
      warningConfig.expected?.delete("unused-result");
    }
    const program = parseCheckProgram(src, target, source!, warningConfig, diagnostics);
    const unusedResults = diagnostics.filter(d => d.code === "unused-result");
    const violations = checkSafetyCompliance(program, level, unusedResults);
    if (rest.includes("--json")) writeStdout(display(program.displayNames, safetyJson(violations, level, source!)));
    else console.log(display(program.displayNames, formatSafetyReport(violations, level)));
    if (violations.some(v => v.severity === "error")) process.exit(1);
    return;
  }

  if (heapSize != null && !target.bareMetal) {
    console.error("error: --heap-size applies only to bare-metal targets (e.g. --target=cortex-m3)");
    process.exit(1);
  }

  // bun/uv behavior: a locked dependency that isn't in the cache is fetched instead
  // of erroring. No-op (a few existsSync calls) when there is no milo.json or no deps.
  if (cmd === "run" || cmd === "build") {
    try {
      await ensureDepsInstalled(source!);
    } catch (e) {
      // A failed fetch / hash mismatch is a user-facing condition, not a crash.
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  if (cmd === "run") {
    await runFile(source!, rest, target, optFlag, warningConfig, sanitize, emitDebug, heapSize, overflowChecks, contractChecks);
  } else if (cmd === "build") {
    const t0 = Date.now();
    const bin = compileToBinary(source!, output, target, optFlag, warningConfig, rest, sanitize, emitDebug, heapSize, overflowChecks, staticDeps, contractChecks, stripPanicLocations);
    reportCompiled(source!, bin, Date.now() - t0);
  } else if (cmd === "check") {
    runCheck(readFileSync(source!, "utf-8"), source!, target, warningConfig, args.includes("--json"));
  } else if (cmd === "emit-ast") {
    emitAst(source!, output, target, emitAll, emitSpans);
  } else if (cmd === "emit-hir") {
    emitHir(source!, output, target, emitAll, emitSpans, warningConfig);
  } else if (cmd === "emit-ir") {
    const trapOnOverflow = overflowChecks ?? true;
    const emitContractChecks = contractChecks ?? (optFlag === "-O0");
    compileToIr(source!, output, target, warningConfig, trapOnOverflow, emitDebug, emitContractChecks, stripPanicLocations, sanitize);
  } else if (cmd === "emit-obj") {
    const t0 = Date.now();
    const obj = compileToObj(source!, output, target, optFlag, warningConfig, noEntry, overflowChecks, contractChecks);
    reportCompiled(source!, obj, Date.now() - t0);
    if (emitHeader) writeHeader(source!, obj.replace(/\.o$/, "") + ".h", target, warningConfig);
  } else if (cmd === "emit-js") {
    const src = readFileSync(source!, "utf-8");
    // The JS backend covers a subset (no FFI, no pointers, no threads, i64 to 2^53).
    // Falling outside it is a fact about the program, not a compiler crash — print
    // the one line that says which construct, not a stack trace.
    let js: string;
    try {
      js = compileToJS(src, target, source!, warningConfig);
    } catch (e: any) {
      if (typeof e?.message === "string" && e.message.startsWith("codegen-js: ")) {
        console.error(`error: ${e.message.slice("codegen-js: ".length)}`);
        console.error("note: 'emit-js' supports a subset of Milo — no FFI, pointers or threads");
        process.exit(1);
      }
      throw e;
    }
    if (output) {
      writeFileSync(output, js);
      console.log(`wrote ${output}`);
    } else {
      process.stdout.write(js);
    }
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

// An unsupported host is a user-facing condition, not a compiler bug: print the
// diagnostic, not a stack trace. Anything else still rethrows so real crashes stay loud.
try {
  await main();
} catch (e) {
  if (e instanceof UnsupportedHostError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
