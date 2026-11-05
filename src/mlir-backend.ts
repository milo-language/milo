// MLIR driver (the build path) (docs/mlir-backend.md): checked AST -> milo MLIR (src/emit-mlir.ts),
// one module holding every function, the module globals and itables, the type-directed glue
// (src/mlir-glue.ts) and the process scaffold (src/scaffold.ts) -> milo-opt (the passes, then
// LLVM IR with the runtime sections linked in, mlir/Link.cpp). milo-opt's LLVM IR is the
// module clang compiles.

import { appendFileSync, existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { BackendProgram, FnDecl } from "./backend-program";
import type { TargetInfo } from "./target";
import { emitMlirFunction, typeAliasText, globalOps, itableOps, mlirModuleText, type MlirFunction } from "./emit-mlir";
import { MlirGlue } from "./mlir-glue";
import { ModuleCtx, type BuildOptions } from "./mlir-ctx";
import { planStartup } from "./startup";
import { scaffoldModule, HASH_SEED_FN } from "./scaffold";
import { runtimeModule } from "./runtime-ir";
import { DebugInfo } from "./mlir-debug";
import { mlirStringBody } from "./mlir-llvm";

// The data layout clang uses for `triple`. Asked of the clang of milo-opt's LLVM,
// the same one that later compiles the module, so both halves of the module agree by
// construction.
const dataLayouts = new Map<string, string>();
function targetDataLayout(triple: string): string {
  const known = dataLayouts.get(triple);
  if (known) return known;
  const r = spawnSync(mlirClang().path, ["--target=" + triple, "-S", "-emit-llvm", "-x", "c", "/dev/null", "-o", "-"], { encoding: "utf-8" });
  const m = r.status === 0 ? /^target datalayout = "([^"]*)"/m.exec(r.stdout) : null;
  if (!m) throw new Error(`mlir: cannot get the data layout of ${triple} from clang:\n${r.stderr}`);
  dataLayouts.set(triple, m[1]);
  return m[1];
}

// A compiled milo binary has no real path of its own; the test driver passes MILO_ROOT.
const ROOT = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A source checkout builds it at mlir/build/milo-opt; an installed compiler (install.sh,
// the Homebrew formula, the deb/rpm) has it next to the milo binary.
function findMiloOpt(): string {
  if (process.env.MILO_OPT) return process.env.MILO_OPT;
  const built = join(ROOT, "mlir", "build", "milo-opt");
  const beside = join(dirname(process.execPath), "milo-opt");
  return !existsSync(built) && existsSync(beside) ? beside : built;
}
export const MILO_OPT = findMiloOpt();
// The LLVM whose clang compiles the module, the one milo-opt was built against (mlir/build.sh
// looks in the same places).
function findLlvmBin(): string {
  if (process.env.MILO_LLVM_BIN) return process.env.MILO_LLVM_BIN;
  const dirs = ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin", "/home/linuxbrew/.linuxbrew/opt/llvm/bin", "/usr/lib/llvm-23/bin"];
  return dirs.find(d => existsSync(join(d, "clang"))) ?? dirs[0];
}
export const LLVM_BIN = findLlvmBin();
const BUILD_HINT = "build it with `sh mlir/build.sh`";

// arith's `select %c, 1, 0` -> `extui %c` makes a signless-only op from a select whose
// type is Milo's si32 (a bool if-expression folded to a select), which then fails to verify.
const CANONICALIZE = "canonicalize{disable-patterns=SelectToExtUI}";

// desugar the top layer -> verify -> structured control flow to cf -> milo ops to LLVM -> SSA.
// Passes that see one function at a time sit under func.func(...) / llvm.func(...): MLIR's
// pass manager runs those on every function in parallel. At module level the generic
// passes (canonicalize, cse, licm, mem2reg) ran on one thread over the whole module.
export const MLIR_PIPELINE ="--pass-pipeline=builtin.module(" + [
  // The top layer (milo.for_in, milo.try, milo.interp) to core ops, before any pass that
  // reads them (mlir/Desugar.cpp).
  "milo-desugar",
  "milo-verify",
  "func.func(" + [
    // `s = s + x` to an in-place append: before scope-drops, whose drop of the old value
    // ahead of the store would name the place and so stop the rewrite.
    "milo-append-in-place",
    // Drops where owned slots' scopes end and before stores over owned values, while the
    // scopes are still regions; which of them run is decided after control flow is lowered.
    "milo-scope-drops",
  ].join(",") + ")",
  "milo-expand-index",
  "func.func(" + [
    // Loops scf.for can hold go there, where the Vec passes work: hoist `len` out of loops
    // that never grow a Vec, then run a check-free copy when one range test proves every
    // bounds check in the loop passes (mlir/README.md).
    "milo-raise-to-scf",
    // The milo region ops left (loops with early exits, ifs outside raised loops) go to cf
    // before any generic pass runs: they describe their control flow to MLIR only in part
    // (break, continue and return are not region-branch terminators, so a memory-state
    // analysis cannot see a loop exit early), so CSE would reuse a load from before a milo.while
    // inside its body as if the loop never stored in between.
    "milo-lower-structured-cf",
    // Init state of every owned slot over the CFG (MLIR's dense dataflow): before any
    // generic pass can move a store or a drop.
    "milo-elaborate-drops",
    CANONICALIZE,
    "milo-hoist-vec-reads",
    "loop-invariant-code-motion",
    "milo-version-bounds-checks",
    "cse",
    CANONICALIZE,
    "convert-scf-to-cf",
  ].join(",") + ")",
  "convert-milo-to-llvm",
  "reconcile-unrealized-casts",
  // The scaffold's symbols join the program's (mlir/Link.cpp): a declaration on either side
  // meets its definition on the other.
  "milo-merge-scaffold",
  "llvm.func(mem2reg," + CANONICALIZE + ")",
].join(",") + ")";
// -g: the subprograms are src/mlir-debug.ts's, on the function locs; the local variables
// become dbg.declare records in them.
const MLIR_PIPELINE_DEBUG = MLIR_PIPELINE.slice(0, -1) + ",llvm.func(milo-lower-debug-vars))";


// The clang that compiles an MLIR-path module: the one from the LLVM install milo-opt
// comes from. Its IR is that LLVM's, and an older clang (Apple's) may
// misread or reject it (LLVM 23 spells some float constants in a syntax clang 21 cannot
// parse). A MILO_CC naming a clang of another version is an error, not a quiet override.
export function mlirClang(): { path: string; id: string } {
  const want = join(LLVM_BIN, "clang");
  const version = (cc: string): string | null => {
    const r = spawnSync(cc, ["--version"], { encoding: "utf-8" });
    return r.status === 0 ? (r.stdout.split("\n")[0] ?? "") : null;
  };
  const wantVersion = version(want);
  if (wantVersion === null) {
    console.error(`error: an MLIR build compiles with ${want} (the clang of milo-opt's LLVM), which does not run`);
    process.exit(1);
  }
  const cc = process.env.MILO_CC;
  if (cc && version(cc) !== wantVersion) {
    console.error(`error: an MLIR build needs the clang of milo-opt's LLVM (${want}: ${wantVersion}); MILO_CC=${cc} is ${version(cc) ?? "not a working clang"}. Unset MILO_CC or point it at a clang of the same LLVM (a cross toolchain's too).`);
    process.exit(1);
  }
  return { path: cc ?? want, id: `${cc ?? want}\n${wantVersion}` };
}
function tool(path: string, what: string): string {
  if (!existsSync(path)) {
    console.error(`error: missing ${what} at ${path}; ${BUILD_HINT}`);
    process.exit(1);
  }
  return path;
}

/**
 * The newest milo-opt source in `mlirDir` that is newer than `binary`, or null. A milo-opt
 * built from older sources fails on the passes the emitter now asks for, one unhelpful
 * error per fixture; this names the cause instead. No automatic rebuild: a build takes
 * minutes and parallel compiles would race each other to run it.
 */
export function staleMiloOpt(binary: string, mlirDir: string): string | null {
  if (!existsSync(binary) || !existsSync(mlirDir)) return null;
  const built = statSync(binary).mtimeMs;
  let newest: string | null = null;
  let newestMs = built;
  for (const f of readdirSync(mlirDir)) {
    if (!/\.(td|cpp|h)$/.test(f) && f !== "CMakeLists.txt") continue;
    const ms = statSync(join(mlirDir, f)).mtimeMs;
    if (ms > newestMs) { newestMs = ms; newest = f; }
  }
  return newest;
}

function run(cmd: string, args: string[], input: string): string {
  const r = spawnSync(cmd, args, { input, encoding: "utf-8", maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    throw new Error(`mlir: ${cmd} ${args.join(" ")} failed (${r.status ?? r.signal}):\n${r.stderr}`);
  }
  return r.stdout;
}


// Which sanitizer `--sanitize` means: AddressSanitizer, or ThreadSanitizer under
// `--sanitize=thread` (MILO_SANITIZE=thread). Read by milo-opt's function attribute and the
// link flag in main.ts, which have to agree: clang instruments only functions carrying the
// matching `sanitize_*` attribute.
export function sanitizerKind(): "address" | "thread" {
  return process.env.MILO_SANITIZE === "thread" ? "thread" : "address";
}

const mlirString = (s: string) => `"${mlirStringBody(new TextEncoder().encode(s))}"`;

/** One build's module: every function through the milo dialect, then milo-opt. */
export class MlirPlan {
  readonly cx: ModuleCtx;
  private readonly fns = new Map<string, FnDecl>();
  private readonly glue: MlirGlue;
  private readonly debug: DebugInfo | null;

  constructor(private prog: BackendProgram, private target: TargetInfo, opts: BuildOptions) {
    const cx = this.cx = new ModuleCtx(prog, target, opts);
    cx.plan = planStartup(prog, cx.layout, target);
    this.glue = new MlirGlue(cx);
    for (const f of prog.functions) if (!this.fns.has(f.name)) this.fns.set(f.name, f);
    for (const f of cx.plan.initFns) this.fns.set(f.name, f);
    this.debug = opts.emitDebug ? new DebugInfo(cx.dwarfPath(opts.filePath), s => cx.mlirDisplayName(s), f => cx.dwarfPath(f)) : null;
    cx.debugFnLoc = (fn, loc) => this.debug ? this.debug.fnLoc(fn, loc) : loc;
    cx.debugClosureLoc = (name, span, loc) => this.debug ? this.debug.closureLoc(name, span?.file ?? opts.filePath, span?.line ?? 0, loc) : loc;
    // An itable's destructor slot is the type's drop glue, when it has one.
    cx.mlirItableDrop = concrete => cx.needsDropCg({ tag: "struct", name: concrete }) ? this.glue.drop({ tag: "struct", name: concrete }) : null;
  }

  /** Runtime-initialized globals nothing reads: they are filled before main. */
  get startupGlobals(): string[] { return this.cx.plan.startupGlobals; }

  /** Every function in the dialect (the scaffold and glue not included). */
  private emitted: MlirFunction[] | null = null;
  private functions(): MlirFunction[] {
    if (this.emitted) return this.emitted;
    const cx = this.cx;
    const functions = [...this.prog.functions.filter(f => !f.isExtern), ...cx.plan.initFns];
    cx.planAttributes(functions);
    const log: string[] = [];
    const taken: MlirFunction[] = [];
    for (const fn of functions) {
      const r = emitMlirFunction(fn, cx, this.fns, this.glue);
      if (typeof r === "string") {
        const [first, ...more] = r.split("\n");
        log.push(`${fn.name}\t${first}`, ...more.map(m => `${fn.name}\t${m}\tmore`));
        flushLog(log);
        // There is no other backend to fall back to: the dialect must cover every function.
        throw new Error(`mlir: ${fn.name} is not covered: ${first}`);
      }
      taken.push(r);
      log.push(`${fn.name}\tok`);
    }
    flushLog(log);
    return (this.emitted = taken);
  }

  /** The text of the functions named in `names` and their closures, as milo-opt receives them. */
  functionTexts(names: ReadonlySet<string>): string[] {
    return this.functions().filter(f => names.has(f.name)).map(f => f.text);
  }

  /** The whole module milo-opt receives: the top layer of the milo dialect, before any pass. */
  moduleText(): string {
    const cx = this.cx;
    const taken = this.functions();
    // Before the glue's text is taken: an itable's drop slot asks the glue for its drop.
    const itables = itableOps(this.prog.itables, cx);
    const glue = this.glue.module();
    const glueFn: MlirFunction[] = glue ? [{ name: "milo.glue", text: glue.text, callees: this.glue.callees, calls: [], closures: glue.names }] : [];
    const all = [...taken, ...glueFn];
    const scaffold = scaffoldModule(cx, { hashSeed: all.some(f => f.callees.has(HASH_SEED_FN)) });
    // The MLIR module is for the TARGET: the translation reads both attributes, and the
    // lowering sizes types with the data layout.
    const triple = this.target.triple;
    const attrs = [
      `llvm.target_triple = "${triple}"`,
      `llvm.data_layout = "${targetDataLayout(triple)}"`,
      `milo.runtime_ir = ${mlirString(runtimeModule())}`,
    ];
    // A per-module extern is one more typed view of a C symbol: its calls go to that symbol.
    const links = [...this.fns.values()].filter(f => f.isExtern && f.linkName && f.linkName !== f.name);
    if (links.length) attrs.push(`milo.link_names = {${links.map(f => `${mlirString(f.name)} = ${mlirString(f.linkName!)}`).join(", ")}}`);
    if (cx.opts.sanitize) attrs.push(`milo.sanitize = "${sanitizerKind()}"`);
    if (this.fns.get("replayHeapMalloc")?.isExtern === false) attrs.push("milo.replay_heap");
    const flags = this.debug ? `llvm.module_flags [#llvm.mlir.module_flag<warning, "Dwarf Version", 4 : i32>]\n` : "";
    const globals = globalOps(this.prog.globals, cx), funcs = mlirModuleText(all);
    return `${this.debug?.aliases() ?? ""}${typeAliasText(cx)}module attributes {${attrs.join(", ")}} {\n${globals}${itables}${flags}${funcs}${scaffold}}${this.debug ? ` ${this.debug.moduleLoc()}` : ""}\n`;
  }

  /** The LLVM IR of the whole module. */
  compile(): string {
    const cx = this.cx;
    const text = this.moduleText();
    mlirClang();
    const optPath = tool(MILO_OPT, "milo-opt");
    // The sources are the ones the binary was built from: <mlir>/build/milo-opt. A binary
    // elsewhere (a planted-bug build under build/) has no sources beside it to compare.
    // An installed milo-opt (beside the compiler) has no sources to compare with.
    const stale = basename(dirname(optPath)).startsWith("build") ? staleMiloOpt(optPath, dirname(dirname(optPath))) : null;
    if (stale) {
      console.error(`error: milo-opt is stale (mlir/${stale} is newer than ${optPath}): run sh mlir/build.sh`);
      process.exit(1);
    }
    if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, text);
    // One process: milo-opt translates to LLVM IR itself (mlir/milo-opt.cpp).
    return run(optPath, ["--emit-llvmir", cx.emitDebug ? MLIR_PIPELINE_DEBUG : MLIR_PIPELINE], text);
  }
}

function flushLog(log: string[]): void {
  const logPath = process.env.MILO_MLIR_LOG;
  if (logPath && log.length) appendFileSync(logPath, log.join("\n") + "\n");
  log.length = 0;
}
