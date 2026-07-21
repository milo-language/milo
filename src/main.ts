import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, statSync } from "fs";
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
import { generateHeader } from "./headergen";
import { formatDiagnostic, ParseError, RESET, BOLD, GREEN, DIM, type WarningConfig } from "./diagnostics";
import { type TargetInfo, getHostTarget, resolveTarget, listTargets } from "./target";
import { generateVerificationConditions, formatVerifyReport, proveWithZ3, formatProveReport } from "./verify";
import { proveWithMilo } from "./prove-milo";
import { parseSafetyLevel, checkSafetyCompliance, formatSafetyReport, listSafetyLevels } from "./safety";
import { extractFlowFacts, formatFlowFacts } from "./wcet";
import { estimateLoopCycles, formatCycleEstimate } from "./wcet-cycles";

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

  return lower(program, result, sourceDir);
}

function compile(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig, debugOverflow = false, emitDebug = false): string {
  return compileWithGuards(source, target, filePath, warningConfig, debugOverflow, emitDebug).ir;
}

// Parse + resolve imports + type-check, rendering ParseErrors as clean Elm-style
// diagnostics instead of leaking a JS stack trace. Analysis subcommands (verify/
// wcet/prove/safety) that stop short of codegen share this so a syntax error is
// reported the same way `build` reports it, not as an uncaught exception.
function parseCheckProgram(src: string, target: TargetInfo, filePath: string, warningConfig?: WarningConfig) {
  const sourceDir = dirname(resolve(filePath));
  try {
    const tokens = new Lexer(src).tokenize();
    let program = new Parser(tokens, src, filePath).parse();
    program = resolveImports(program, sourceDir, target, filePath);
    new TypeChecker(warningConfig).check(program);
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
function compileWithGuards(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig, debugOverflow = false, emitDebug = false): { ir: string; cGuards: string | null } {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  const cg = new Codegen(target, filePath, debugOverflow, emitDebug);
  const ir = cg.generate(hirModule);
  return { ir, cGuards: cg.cDeclGuards() };
}

// Compile the @cLayout/@cSig guard TU against the real system headers and fail the build
// if any _Static_assert trips.
function verifyCDecls(cGuards: string | null, target: TargetInfo): void {
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
  if (target.os !== host.os || target.arch !== host.arch) {
    console.error(`warning: @cLayout/@cSig guards skipped — building for ${target.triple}, but verification would read this ${host.os}-${host.arch} host's headers`);
    return;
  }
  const tc = detectToolchain();
  const cc = tc.kind === "clang" ? tc.path : "cc";
  const tmpC = join(tmpdir(), `milo_cdecl_${crypto.randomUUID().slice(0, 8)}.c`);
  try {
    writeFileSync(tmpC, cGuards);
    execSync(`${cc} -fsyntax-only "${tmpC}"`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    const stderr = e.stderr?.toString() ?? e.message ?? "";
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

function compileToIr(sourcePath: string, outputPath: string | null, target: TargetInfo, warningConfig?: WarningConfig, debugOverflow = false, emitDebug = false) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig, debugOverflow, emitDebug);
  if (outputPath) {
    writeFileSync(outputPath, ir);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(ir);
  }
}

// detect clang: prefer /usr/bin/clang (Apple) which is more stable, then PATH clang, then llc+cc
type Toolchain = { kind: "clang"; path: string } | { kind: "llc+cc" };
let cachedToolchain: Toolchain | null = null;
function detectToolchain(): Toolchain {
  if (cachedToolchain) return cachedToolchain;
  const candidates = ["/usr/bin/clang", "clang"];
  for (const cc of candidates) {
    try {
      execSync(`${cc} --version`, { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      cachedToolchain = { kind: "clang", path: cc };
      return cachedToolchain;
    } catch {}
  }
  try {
    execSync("llc --version", { stdio: ["pipe", "pipe", "pipe"] });
    execSync("cc --version", { stdio: ["pipe", "pipe", "pipe"] });
    cachedToolchain = { kind: "llc+cc" };
  } catch {
    throw new Error("no C compiler found: need either 'clang' or 'llc'+'cc' on PATH");
  }
  return cachedToolchain;
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
  execSync(
    `${tc.path}${tgt} ${opt}${heapDef} -nostdlib -fuse-ld=lld -Wl,-T,"${ldScript}" "${startup}" "${llFile}" -o "${outFile}" -Wno-override-module`,
    { stdio: ["pipe", "pipe", "pipe"] }
  );
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
  if (tc.kind === "clang") {
    const opt = optFlag ? ` ${optFlag}` : "";
    // Mach-O keeps DWARF in the .o and references it from the executable via a debug
    // map (N_OSO); the DWARF is never copied into the linked binary. The default
    // single-step `clang x.ll -o out` deletes its internal .o, dangling that map. So on
    // a Mach-O target with debug info, persist the .o, link it, then dsymutil the debug
    // map into out.dSYM (which lldb/hades auto-load). ELF embeds DWARF in the binary
    // directly, so it needs none of this.
    if (emitDebug && process.platform === "darwin") {
      const obj = `${outFile}.dbg.o`;
      try {
        execSync(`${tc.path}${tgt}${opt}${san} -c ${llFile} -o ${obj} -Wno-override-module`, { stdio: ["pipe", "pipe", "pipe"] });
        execSync(`${tc.path}${tgt}${opt}${san} ${obj} -o ${outFile}${libs}${extra}`, { stdio: ["pipe", "pipe", "pipe"] });
        execSync(`dsymutil ${outFile}`, { stdio: ["pipe", "pipe", "pipe"] });
      } finally {
        try { unlinkSync(obj); } catch {}
      }
    } else {
      // -lm: numToStr and other std math call floor/pow from libm. macOS folds
      // libm into libSystem so clang links it implicitly; Linux does not, so
      // without this the link fails with `undefined reference to 'floor'` for
      // any program that reaches those paths (the llc+cc branch already passes
      // it). Harmless on macOS where libm is always present.
      execSync(`${tc.path}${tgt}${opt}${san} ${llFile} -o ${outFile} -Wno-override-module${libs}${extra} -lm${linuxLink}`, { stdio: ["pipe", "pipe", "pipe"] });
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
      execSync(`cc ${tmpObj} -o ${outFile}${libs}${extra} -lm${linuxLink}`, { stdio: ["pipe", "pipe", "pipe"] });
    } finally {
      try { unlinkSync(tmpObj); } catch {}
    }
  }
}

// bin/milo-fmt is a gitignored per-machine cache. It used to be rebuilt only when
// missing, so editing fmt.milo changed nothing until someone deleted the binary by hand
// — and a stale one silently reformats source with the OLD rules. That shipped a
// formatter bug into 16 committed files via the pre-commit hook, which formats staged
// .milo and re-stages the result, quietly reverting the fix in the same commit.
// The compiler is an input too: fmt.milo is Milo source, so a codegen change can change
// its behavior without fmt.milo moving.
function fmtBinStale(fmtBin: string, fmtSrc: string, root: string): boolean {
  if (!existsSync(fmtBin)) return true;
  try {
    const binTime = statSync(fmtBin).mtimeMs;
    if (statSync(fmtSrc).mtimeMs > binTime) return true;
    const srcDir = resolve(root, "src");
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      if (statSync(join(srcDir, f)).mtimeMs > binTime) return true;
    }
    return false;
  } catch {
    return true; // can't prove it's fresh — rebuild rather than format with unknown rules
  }
}

function compileToObj(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, noEntry = false): string {
  const source = readFileSync(sourcePath, "utf-8");
  const { ir, cGuards } = compileWithGuards(source, target, sourcePath, warningConfig);
  verifyCDecls(cGuards, target);

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

function buildLib(sourcePaths: string[], outputPath: string, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig) {
  const objFiles: string[] = [];
  try {
    for (const src of sourcePaths) {
      const id = crypto.randomUUID().slice(0, 8);
      const tmpObj = join(tmpdir(), `milo_${id}.o`);
      compileToObj(src, tmpObj, target, optFlag, warningConfig, true);
      objFiles.push(tmpObj);
    }
    const objs = objFiles.map(f => `"${f}"`).join(" ");
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

// Resolve `-lfoo` to a link spec. Dynamic is the default because a system dylib
// picks up OpenSSL security fixes without a rebuild; --static-deps trades that away
// for a binary that runs on machines with no Homebrew/openssl installed at all.
function libSpec(names: string[], darwinPrefix: string, target: TargetInfo, staticDeps: boolean): string {
  const flags = names.map((n) => `-l${n}`).join(" ");
  if (!staticDeps) {
    return target.os === "darwin" ? ` -L${darwinPrefix}/lib ${flags}` : ` ${flags}`;
  }
  if (target.os !== "darwin") {
    // GNU ld: -Bstatic/-Bdynamic are positional, so restore dynamic for libc after.
    return ` -Wl,-Bstatic ${flags} -Wl,-Bdynamic`;
  }
  // ld64 has no -Bstatic; naming the archive directly is the supported way to force
  // a static member pull while everything else stays dynamic.
  const archives = names.map((n) => `${darwinPrefix}/lib/lib${n}.a`);
  const missing = archives.filter((a) => !existsSync(a));
  if (missing.length) {
    console.error(`error: --static-deps needs static archives that aren't installed: ${missing.join(", ")}`);
    console.error(`hint: Homebrew ships them alongside the dylibs — try 'brew install ${basename(darwinPrefix)}'`);
    process.exit(1);
  }
  return " " + archives.join(" ");
}

function detectLibs(ir: string, target: TargetInfo, staticDeps = false): string {
  let libs = "";
  const openssl = "/opt/homebrew/opt/openssl@3";
  if (ir.includes("@SSL_") || ir.includes("@TLS_client_method")) {
    libs += libSpec(["ssl", "crypto"], openssl, target, staticDeps);
  }
  if (!libs.includes("-lcrypto") && !libs.includes("libcrypto.a") && (ir.includes("@SHA256") || ir.includes("@MD5"))) {
    libs += libSpec(["crypto"], openssl, target, staticDeps);
  }
  if (ir.includes("@sqlite3_")) {
    libs += libSpec(["sqlite3"], "/opt/homebrew/opt/sqlite", target, staticDeps);
  }
  // JavaScriptCore: a system framework on darwin (zero install); on linux it's the
  // heavier libjavascriptcoregtk, so we only auto-link on darwin.
  if (ir.includes("@JSGlobalContextCreate") || ir.includes("@JSEvaluateScript")) {
    if (target.os === "darwin") libs += " -framework JavaScriptCore";
  }
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

function compileToBinary(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, extraLinkFlags: string[] = [], sanitize: boolean = false, emitDebug = false, heapSize: number | null = null, forceOverflowChecks: boolean | null = null, staticDeps = false): string {
  const source = readFileSync(sourcePath, "utf-8");
  // Arithmetic traps at -O0 but silently WRAPS at -O2/-O3 — the one real footgun left
  // (Rust's wart; Swift traps in every mode). Checks are only *defaulted* from -O, never
  // welded to it: `--overflow-checks` forces them on at any -O and `--no-overflow-checks`
  // forces them off, so -O0's fast build is usable without also changing arithmetic
  // semantics. Both directions matter — the cost has to be measurable before the default
  // can be flipped.
  const debugOverflow = forceOverflowChecks ?? (optFlag === "-O0");
  // DWARF is gated on -g alone (compose `-g --debug` for -O0 + line info). Keeping it
  // off --debug leaves the -O0 path — used by the runtime-error test harness — byte
  // -identical and free of per-build dsymutil / .dSYM litter.
  const { ir, cGuards } = compileWithGuards(source, target, sourcePath, warningConfig, debugOverflow, emitDebug);
  verifyCDecls(cGuards, target);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = outputPath ?? join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  // The linker won't create -o's parent dir; without this it errors with
  // "ld: open() failed" on a fresh checkout (e.g. building into a bin/ that
  // isn't there yet).
  mkdirSync(dirname(out), { recursive: true });

  try {
    writeFileSync(tmpLl, ir);
    if (target.bareMetal) {
      // Freestanding link: program IR + startup runtime + linker script → ELF.
      linkBareMetal(tmpLl, out, target, optFlag, heapSize);
    } else {
      const libs = detectLibs(ir, target, staticDeps);
      const extra = extraLinkFlags.length ? " " + extraLinkFlags.join(" ") : "";
      linkIR(tmpLl, out, optFlag, libs, extra, sanitize, emitDebug, target);
    }
  } catch (e: any) {
    console.error(`error[link]: compilation failed:\n${e.stderr?.toString() ?? e.message}`);
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
  const { ir, cGuards } = compileWithGuards(source, target, sourcePath, warningConfig);
  verifyCDecls(cGuards, target);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);
  try {
    writeFileSync(tmpLl, ir);
    const libs = detectLibs(ir, target);
    linkIR(tmpLl, out, optFlag, libs, "", false, false, target);
  } catch (e: any) {
    throw new Error(`compilation failed:\n${e.stderr?.toString() ?? e.message}`);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

async function runTests(testFiles: string[], target: TargetInfo, optFlag: string, warningConfig?: WarningConfig) {
  let totalPassed = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  for (const file of testFiles) {
    const source = readFileSync(file, "utf-8");
    const testFnRegex = /^fn\s+(test\w+)\s*\(/gm;
    const testFns: string[] = [];
    let m;
    while ((m = testFnRegex.exec(source)) !== null) testFns.push(m[1]);
    if (testFns.length === 0) continue;

    console.log(`\n${file}`);

    // generate main that calls each test, one at a time
    let mainSrc = "\nfn main(): i32 {\n";
    for (const name of testFns) {
      mainSrc += `    eprint("  ${name} ... ")\n`;
      mainSrc += `    ${name}()\n`;
      mainSrc += `    eprint("ok")\n`;
    }
    mainSrc += "    return 0\n}\n";

    const fullSource = source + mainSrc;
    let bin: string;
    try {
      bin = compileSourceToBinary(fullSource, file, target, optFlag, warningConfig);
    } catch (e: any) {
      console.error(`  compile error: ${e.message}`);
      totalFailed += testFns.length;
      continue;
    }

    try {
      // guardedRun, not spawnSync: test binaries are milo-built and untrusted
      const result = await guardedRun(bin, [], { timeoutMs: 30000, memMb: 2048 });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.code === 0) {
        totalPassed += testFns.length;
      } else {
        totalFailed++;
        totalPassed += Math.max(0, testFns.length - 1);
        failures.push(file);
      }
    } finally {
      try { unlinkSync(bin); } catch {}
    }
  }

  console.log(`\nresults: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
  if (totalFailed > 0) {
    console.log("failures:");
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

// Compiled programs run with an RSS watchdog BY DEFAULT: macOS enforces no
// rlimits, and one runaway allocation (e.g. a milo-self memory bug) swaps the
// whole machine to death. Raise with MILO_RUN_MEM_MB, disable with
// MILO_RUN_UNGUARDED=1. No wall-clock timeout — long-running programs are legal.
async function runFile(sourcePath: string, extraArgs: string[], target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, sanitize: boolean = false, emitDebug = false, heapSize: number | null = null, overflowChecks: boolean | null = null) {
  const bin = compileToBinary(sourcePath, null, target, optFlag, warningConfig, [], sanitize, emitDebug, heapSize, overflowChecks);
  try {
    if (target.bareMetal) {
      runBareMetalQemu(bin, target);
      return;
    }
    const memMb = Number(process.env.MILO_RUN_MEM_MB || 0) || DEFAULT_MEM_MB;
    const child = spawn(bin, extraArgs, { stdio: "inherit" });
    let breached = false;
    const stop =
      process.env.MILO_RUN_UNGUARDED === "1"
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

// Parse a heap-size argument (bare-metal only): plain bytes, or a k/m suffix
// (1024-based). "64k" → 65536, "2m" → 2097152. Returns null on malformed input.
function parseHeapSize(s: string): number | null {
  const m = /^(\d+)([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = m[2] === "" ? 1 : (m[2].toLowerCase() === "k" ? 1024 : 1024 * 1024);
  return n * mult;
}

function parseArgs(args: string[]): { output: string | null; source: string | null; rest: string[]; optFlag: string; warningConfig: WarningConfig; noEntry: boolean; safetyLevel: string | null; sanitize: boolean; targetName: string | null; emitHeader: boolean; emitDebug: boolean; heapSize: number | null; overflowChecks: boolean | null; staticDeps: boolean } {
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
  let overflowChecks: boolean | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
    else if (args[i] === "--debug") { optFlag = "-O0"; }
    // Fast edit-loop builds: -O0 is ~2x quicker to compile but would flip arithmetic from
    // wrapping to trapping, so pair it with checks off to keep -O2's semantics. Runtime is
    // up to ~2.4x slower, which is why this is opt-in rather than the default for `run`.
    // A later explicit --overflow-checks still wins (the loop is order-sensitive).
    else if (args[i] === "--fast") { optFlag = "-O0"; overflowChecks = false; }
    else if (args[i] === "-g") { emitDebug = true; } // DWARF line info, composes with any -O
    else if (args[i] === "--no-entry") { noEntry = true; }
    else if (args[i] === "--sanitize") { sanitize = true; }
    else if (args[i] === "--static-deps") { staticDeps = true; }
    else if (args[i] === "--overflow-checks") { overflowChecks = true; }
    else if (args[i] === "--no-overflow-checks") { overflowChecks = false; }
    else if (args[i] === "--emit-header") { emitHeader = true; }
    else if (args[i] === "-O" && i + 1 < args.length) { optFlag = `-O${args[++i]}`; }
    else if (/^-O[0-3sz]$/.test(args[i])) { optFlag = args[i]; }
    else if (args[i] === "--deny-all") { denied.add("*"); }
    else if (args[i].startsWith("--deny=")) { denied.add(args[i].slice(7)); }
    else if (args[i] === "--deny" && i + 1 < args.length) { denied.add(args[++i]); }
    else if (args[i].startsWith("--allow=")) { allowed.add(args[i].slice(8)); }
    else if (args[i] === "--allow" && i + 1 < args.length) { allowed.add(args[++i]); }
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
  return { output, source, rest, optFlag, warningConfig: { denied, allowed }, noEntry, safetyLevel, sanitize, targetName, emitHeader, emitDebug, heapSize, overflowChecks, staticDeps };
}

const SKILL_TEXT = `# Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references — no GC, no RC, no lifetime annotations.

## Compile & Run

\`\`\`bash
bun run src/main.ts run file.milo              # compile + run (no artifacts)
bun run src/main.ts build file.milo -o myapp   # compile to binary
bun run src/main.ts emit-ir file.milo          # emit LLVM IR
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
| \`std/argparse\` | Declarative arg parser | \`newParser\`, \`ArgParser\`, \`ParsedArgs\` (see detailed section below) |
| \`std/env\` | Environment vars | \`getEnv\`, \`setEnv\`, \`allEnv\` |
| \`std/json\` | JSON parse/serialize | \`jsonParse\`, \`jsonStringify\`, \`JsonValue\` |
| \`std/toml\` | TOML parser | \`tomlParse\`, \`TomlValue\` |
| \`std/csv\` | CSV parser | \`csvParse\`, \`csvStringify\` |
| \`std/http\` | HTTP client | \`httpGet\`, \`httpPost\`, \`httpRequest\`, \`HttpResponse\` |
| \`std/net\` | TCP networking | \`tcpConnect\`, \`tcpListen\`, \`TcpStream\`, \`TcpListener\` |
| \`std/crypto\` | Cryptographic hashes | \`sha256\`, \`md5\` |
| \`std/base64\` | Base64 encoding | \`base64Encode\`, \`base64Decode\` |
| \`std/hex\` | Hex encoding | \`hexEncode\`, \`hexDecode\` |
| \`std/regex\` | Regular expressions | \`regexMatch\`, \`regexFind\`, \`regexReplace\` |
| \`std/datetime\` | Date and time | \`now\`, \`formatTime\`, \`DateTime\` |
| \`std/time\` | Timing | \`sleep\`, \`clockMs\` |
| \`std/random\` | Random numbers | \`randomI64\`, \`randomF64\`, \`randomRange\` |
| \`std/uuid\` | UUID generation | \`uuidV4\` |
| \`std/math\` | Math functions | \`sqrt\`, \`abs\`, \`min\`, \`max\`, \`pow\`, \`floor\`, \`ceil\` |
| \`std/string\` | String utilities | \`split\`, \`join\`, \`trim\`, \`padLeft\`, \`padRight\`, \`repeat\` |
| \`std/strconv\` | String conversions | \`parseInt\`, \`parseFloat\` |
| \`std/fmt\` | String formatting | \`fmt\`, \`fmtFloat\` |
| \`std/color\` | Terminal colors | \`red\`, \`green\`, \`blue\`, \`bold\`, \`dim\`, \`reset\` |
| \`std/sort\` | Sorting | \`sort\` for Vec with comparator |
| \`std/set\` | Hash set | \`Set<T>\` |
| \`std/url\` | URL parsing | \`parseUrl\`, \`Url\` |
| \`std/log\` | Logging | \`logInfo\`, \`logWarn\`, \`logError\`, \`logDebug\` |
| \`std/signal\` | OS signal handling | \`onSignal\` |
| \`std/process\` | Process management | \`exec\`, \`spawn\`, \`ProcessResult\` |
| \`std/thread\` | Threading | \`spawn\` (thread), \`Thread\` |
| \`std/sync\` | Concurrency primitives | \`Mutex\`, \`Channel\`, \`WaitGroup\` |
| \`std/arena\` | Arena allocator | \`Arena\`, \`ArenaRef\` |
| \`std/mem\` | Memory utilities | \`sizeOf\`, \`alignOf\` |
| \`std/cstr\` | C string interop | \`toCStr\`, \`fromCStr\` |
| \`std/sqlite\` | SQLite database | \`sqliteOpen\`, \`sqliteExec\`, \`sqliteQuery\` |
| \`std/unicode\` | Unicode utilities | \`isAlpha\`, \`isDigit\`, \`toUpper\`, \`toLower\` |
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
from "std/argparse" import { newParser }
from "std/io" import { readFile }

fn main(): i32 {
    // 1. Create parser
    var parser = newParser("mytool", "process text files")

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
    let file = args.getString("file")       // positional or flag by name
    let fmt = args.getString("format")      // "text" if not provided
    let verbose = args.getBool("verbose")   // false if not provided
    let count = args.getI64("count")        // 100 if not provided
    let token = args.getString("token")     // guaranteed present (required)

    if args.has("output") {
        let out = args.getString("output")
        // write to file...
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
- \`getString(name)\` — get string value by long name
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
    let n = counts.get("apples")!
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
  if (args.length < 1) {
    console.log("usage: milo <command> [options] <file>");
    console.log("commands:");
    console.log("  run <file> [args]      compile and run (no artifacts left behind)");
    console.log("  build <file> [-o out]  compile to executable");
    console.log("  test [file...]         run tests (*_test.milo files)");
    console.log("  emit-ir <file>         emit LLVM IR");
    console.log("  emit-obj <file>        compile to object file (.o)");
    console.log("  build-lib <files...>   compile to static library (.a)");
    console.log("  emit-js <file>         emit JavaScript (playground target)");
    console.log("  fmt <file...>          format source files (-w to write in place)");
    console.log("  verify <file>          generate SMT-LIB2 verification conditions (--all: include imported stdlib)");
    console.log("  prove <file>           verify contracts via std/smt, the milo-native prover (--solver=z3 to use z3; --all: include imported stdlib)");
    console.log("  safety <file>          check safety profile compliance");
    console.log("  safety --list          list available safety profiles");
    console.log("  wcet <file>            emit OTAWA flow facts (loop bounds) for WCET analysis");
    console.log("  skill                  print language guide for LLMs");
    console.log("  api <terms>            search std signatures by name/doc (--module std/x to dump one, --markdown to emit reference docs)");
    console.log("  doc <file|dir>         reference markdown from doc-comments (-o <dir> to write one .md per module)");
    console.log("options:");
    console.log("  --release              optimize (-O3)");
    console.log("  --debug                no optimization (-O0)");
    console.log("  -g                     emit DWARF line info (source-level lldb/hades); composes with any -O / --debug");
    console.log("  -O<level>              clang opt level: 0,1,2,3,s,z (default: -O2)");
    console.log("  --sanitize             link with AddressSanitizer (requires clang)");
    console.log("  --static-deps          static-link native deps (openssl/sqlite) for a portable binary");
    console.log("  --overflow-checks     trap on +/-/* overflow at any -O (default: only --debug)");
    console.log("  --no-overflow-checks  wrap on +/-/* overflow at any -O (e.g. fast -O0 builds)");
    console.log("  --fast                quick edit-loop build: -O0, wrapping (~2x faster compile)");
    console.log("  --deny=<warning>       treat warning as error (e.g. --deny=unused-variable)");
    console.log("  --allow=<warning>      suppress warning (e.g. --allow=unused-result)");
    console.log("  --deny-all             treat all warnings as errors");
    console.log("                         (off-by-default warnings: unused-move, unused-unsafe)");
    console.log("  --safety=<level>       enforce safety profile (e.g. --safety=do178)");
    console.log("  --target=<name>        cross-compile target (e.g. cortex-m3)");
    console.log("  --heap-size=<N>        bare-metal heap cap in bytes or k/m (e.g. 64k); default: all free RAM");
    process.exit(1);
  }

  const cmd = args[0];

  // Reject an unknown subcommand up front. Otherwise a bare file path (forgot `run`)
  // falls through every dispatch branch to the generic "no source file" below.
  const KNOWN_COMMANDS = new Set([
    "skill", "api", "doc", "lsp", "lex", "fmt", "build-lib", "safety", "verify",
    "wcet", "prove", "test", "run", "build", "emit-ir", "emit-obj", "emit-js",
  ]);
  if (!KNOWN_COMMANDS.has(cmd) && cmd !== "--help" && cmd !== "-h") {
    console.error(`error: unknown command '${cmd}'`);
    console.error(`run 'milo' with no arguments to see available commands`);
    process.exit(1);
  }

  if (cmd === "skill") {
    process.stdout.write(SKILL_TEXT);
    return;
  }

  if (cmd === "api") {
    const { runApiSearch } = require("./api-search");
    process.exit(runApiSearch(args.slice(1)));
  }

  if (cmd === "doc") {
    const { runMiloDoc } = require("./api-search");
    process.exit(runMiloDoc(args.slice(1)));
  }

  if (cmd === "lsp") {
    import("./lsp");
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

    // bin/milo-fmt (built from examples/cli-tools/fmt.milo) is the sole formatter.
    // Build it on first use rather than fall back to anything divergent, so
    // `milo fmt` always produces the same bytes.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fmtBin = resolve(root, "bin", "milo-fmt");
    const src = resolve(root, "examples", "cli-tools", "fmt.milo");
    if (fmtBinStale(fmtBin, src, root)) {
      mkdirSync(resolve(root, "bin"), { recursive: true });
      const build = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "build", src, "-o", fmtBin], { encoding: "utf-8" });
      if (build.status !== 0 || !existsSync(fmtBin)) {
        console.error(build.stderr || "error: could not build bin/milo-fmt");
        process.exit(1);
      }
    }

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

  const { output, source, rest, optFlag, warningConfig, noEntry, safetyLevel, sanitize, targetName, emitHeader, emitDebug, heapSize, overflowChecks, staticDeps } = parseArgs(args.slice(1));
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
    buildLib(sources, libOutput, target, optFlag, warningConfig);
    console.log(`compiled ${sources.length} file(s) -> ${libOutput}`);
    return;
  }

  if (cmd === "safety" && args.slice(1).includes("--list")) {
    console.log(listSafetyLevels());
    return;
  }

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

  if (cmd === "verify") {
    const src = readFileSync(source!, "utf-8");
    const program = parseCheckProgram(src, target, source!, warningConfig);
    const result = generateVerificationConditions(program, rest.includes("--all") ? undefined : { onlyFile: source! });
    console.log(formatVerifyReport(result));
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
      if (!target.bareMetal) {
        console.error("error: --cycles requires a bare-metal target (e.g. --target=cortex-m3)");
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
    console.log(formatProveReport(pr));
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
    const program = parseCheckProgram(src, target, source!, warningConfig);
    const violations = checkSafetyCompliance(program, level);
    console.log(formatSafetyReport(violations, level));
    if (violations.some(v => v.severity === "error")) process.exit(1);
    return;
  }

  if (cmd === "test") {
    const testArgs = args.slice(1);
    const { optFlag: testOpt, warningConfig: testWc } = parseArgs(testArgs);
    let files: string[];
    const explicitFiles = testArgs.filter(a => a.endsWith(".milo"));
    if (explicitFiles.length > 0) {
      files = explicitFiles;
    } else {
      const dir = process.cwd();
      files = readdirSync(dir).filter(f => f.endsWith("_test.milo")).map(f => join(dir, f));
    }
    if (files.length === 0) { console.error("no test files found"); process.exit(1); }
    await runTests(files, target, testOpt, testWc);
    return;
  }

  if (heapSize != null && !target.bareMetal) {
    console.error("error: --heap-size applies only to bare-metal targets (e.g. --target=cortex-m3)");
    process.exit(1);
  }

  if (cmd === "run") {
    await runFile(source!, rest, target, optFlag, warningConfig, sanitize, emitDebug, heapSize, overflowChecks);
  } else if (cmd === "build") {
    const t0 = Date.now();
    const bin = compileToBinary(source!, output, target, optFlag, warningConfig, rest, sanitize, emitDebug, heapSize, overflowChecks, staticDeps);
    reportCompiled(source!, bin, Date.now() - t0);
  } else if (cmd === "emit-ir") {
    compileToIr(source!, output, target, warningConfig, optFlag === "-O0", emitDebug);
  } else if (cmd === "emit-obj") {
    const t0 = Date.now();
    const obj = compileToObj(source!, output, target, optFlag, warningConfig, noEntry);
    reportCompiled(source!, obj, Date.now() - t0);
    if (emitHeader) writeHeader(source!, obj.replace(/\.o$/, "") + ".h", target, warningConfig);
  } else if (cmd === "emit-js") {
    const src = readFileSync(source!, "utf-8");
    const js = compileToJS(src, target, source!, warningConfig);
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

await main();
