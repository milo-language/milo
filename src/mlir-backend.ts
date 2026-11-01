// MLIR driver (default build path; MILO_LEGACY=1 turns it off) (docs/mlir-backend.md): the functions the milo dialect covers go
// HIR -> milo MLIR (src/emit-mlir.ts) -> milo-opt (passes, then LLVM IR), and their bodies
// replace the legacy codegen's in the one LLVM module clang sees.
//
// Linking is a textual splice, not llvm-link. Legacy codegen makes every non-exported fn
// `internal`, and two modules cannot reference each other's internal symbols, so llvm-link
// would need every cross-module callee promoted and re-internalized afterwards. In one
// module the names simply resolve. Legacy codegen emits only a stub for a taken function
// (MlirPlan.take), with its real `define` line and its call edges.
// The `define` line is the legacy one (linkage, attributes, ABI), with params renumbered
// to the MLIR body's `%0..%n-1`; DWARF for these functions is M6, so -g drops their `!dbg`.

import { appendFileSync, existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { HIRFunction, HIRModule } from "./hir";
import type { TargetInfo } from "./target";
import { emitMlirFunction, mlirModuleText, type MlirEmitCtx, type MlirFunction } from "./emit-mlir";

// On unless MILO_LEGACY=1 (temporary escape hatch for critical deploys; docs/mlir-backend.md).
// MILO_MLIR=0 is the old opt-out spelling, accepted for one release; MILO_MLIR=1 is a no-op.
export const MLIR_MODE = process.env.MILO_LEGACY !== "1" && process.env.MILO_MLIR !== "0";

/**
 * Whether builds for `target` go through MLIR: every hosted target (cross builds and
 * Windows included) and wasm64. A 32-bit target (the Cortex-M family) stays legacy:
 * legacy codegen's typeSize/enum layout hardcode an 8-byte pointer, while milo-opt lays
 * structs out with the target's data layout (4-byte pointer on thumb), so the two halves
 * of one module would disagree about every struct holding a pointer.
 */
export function mlirTargetOk(target: TargetInfo): boolean {
  return target.arch !== "arm";
}

// The data layout clang uses for `triple` (the one source of truth for it: legacy codegen
// emits no `target datalayout` and lets clang pick). Asked of the clang of milo-opt's LLVM,
// the same one that later compiles the module, so both halves of the module agree by
// construction.
const dataLayouts = new Map<string, string>();
export function targetDataLayout(triple: string): string {
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
const MILO_OPT = findMiloOpt();
// The LLVM whose clang compiles the module, the one milo-opt was built against (mlir/build.sh
// looks in the same places).
function findLlvmBin(): string {
  if (process.env.MILO_LLVM_BIN) return process.env.MILO_LLVM_BIN;
  const dirs = ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin", "/home/linuxbrew/.linuxbrew/opt/llvm/bin", "/usr/lib/llvm-23/bin"];
  return dirs.find(d => existsSync(join(d, "clang"))) ?? dirs[0];
}
const LLVM_BIN = findLlvmBin();
const BUILD_HINT = "build it with `sh mlir/build.sh`";

// verify (on parse) -> structured control flow to cf -> milo ops to LLVM -> SSA.
export const MLIR_PIPELINE = [
  "--milo-verify",
  // Drops where owned slots' scopes end and before stores over owned values, while the
  // scopes are still regions; which of them run is decided after control flow is lowered.
  "--milo-scope-drops",
  "--milo-expand-index",
  // Loops scf.for can hold go there, where the Vec passes work: hoist `len` out of loops
  // that never grow a Vec, then run a check-free copy when one range test proves every
  // bounds check in the loop passes (mlir/README.md).
  "--milo-raise-to-scf",
  // The milo region ops left (loops with early exits, ifs outside raised loops) go to cf
  // before any generic pass runs: they do not describe their control flow to MLIR
  // (no RegionBranchOpInterface), so CSE would reuse a load from before a milo.while
  // inside its body as if the loop never stored in between.
  "--milo-lower-structured-cf",
  // Init state of every owned slot over the CFG (MLIR's dense dataflow): before any
  // generic pass can move a store or a drop.
  "--milo-elaborate-drops",
  "--canonicalize",
  "--milo-hoist-vec-reads",
  "--loop-invariant-code-motion",
  "--milo-version-bounds-checks",
  "--cse",
  "--canonicalize",
  "--convert-scf-to-cf",
  "--convert-milo-to-llvm",
  "--reconcile-unrealized-casts",
  "--mem2reg",
  "--canonicalize",
];

const IDENT = String.raw`"(?:[^"\\]|\\.)*"|[-\w$.]+`;
const DEFINE_RE = new RegExp(String.raw`^define [^@]*@(${IDENT})\(`);
const DECL_RE = new RegExp(String.raw`^(?:define|declare) [^@]*@(${IDENT})\(`);
const GLOBAL_RE = new RegExp(String.raw`^@(${IDENT}) = `);

function unquote(n: string): string {
  return n.startsWith('"') ? n.slice(1, -1).replace(/\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : n;
}

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
    console.error(`error: missing ${what} at ${path}; ${BUILD_HINT} (or MILO_LEGACY=1 for the legacy code generator)`);
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

const STUB_MARK = "; milo.mlir.stub";
const STUB_FIRST = "  unreachable";

/**
 * Which functions go through MLIR, decided by legacy codegen as it reaches each one
 * (`take`, called from genFunction once signatures are known). A taken function gets a stub
 * body there instead of its legacy one; `compileThroughMlir` replaces the stub.
 */
export class MlirPlan {
  private taken: MlirFunction[] = [];
  private takenNames = new Set<string>();
  private log: string[] = [];
  private readonly fns = new Map<string, HIRFunction>();

  constructor(hir: HIRModule, private cx: MlirEmitCtx, private target: TargetInfo) {
    for (const f of hir.functions) if (!this.fns.has(f.name)) this.fns.set(f.name, f);
  }

  /**
   * The stub body for `fn` when MLIR takes it, else null. The stub is never executed and
   * never shipped; it exists for codegen's module-wide noalias dataflow, which reads call
   * edges out of the IR text: one dead call per callee keeps the edges through this
   * function. With by-ref params and scalars that is all the analysis would see in the
   * real body. A raw pointer flows in ways a stub does not capture (stored, returned,
   * made from an int), so a function with one keeps its legacy body for the analysis
   * ("legacy"), and pays for generating it.
   */
  take(fn: HIRFunction): string[] | "legacy" | null {
    if (fn.isExtern) return null;
    const r = emitMlirFunction(fn, this.cx, this.fns);
    if (typeof r === "string") { this.log.push(`${fn.name}\t${r}`); return null; }
    // A lazy global's init function is codegen's own, not in the HIR module.
    if (!this.fns.has(fn.name)) this.fns.set(fn.name, fn);
    // Mutable globals the body names are what the analysis reads as `touches`, and their
    // addresses flow like a raw pointer's: neither is in a stub's call list.
    const body = r.text.slice(r.text.indexOf("\n"));
    const ptrs = body.includes("!milo.ptr") || body.includes("milo.global ");
    // main's prologue is found ahead of its stub, and with a full legacy body there is none.
    if (ptrs && fn.name === "main") { this.log.push(`main\t${body.includes("!milo.ptr") ? "raw pointer" : "global"} in main`); return null; }
    this.taken.push(r);
    this.log.push(`${fn.name}\tok`);
    this.takenNames.add(fn.name);
    if (ptrs) return "legacy";
    const stub = [STUB_FIRST, "mlir.stub.calls:", STUB_MARK];
    // A by-ref param passed on keeps its name, so the analysis sees where the pointer flows;
    // everything else is a scalar or a slot of this frame, which reaches no global.
    for (const call of r.calls) {
      const callee = this.fns.get(call.name)!;
      const args = callee.params.map((p, i) => {
        const own = call.refParams[i];
        if (p.isRef || p.isRefMut) return `ptr ${own == null ? "poison" : `%${fn.params[own].name}`}`;
        return `${this.cx.llvmType(p.type)} poison`;
      }).join(", ");
      const sym = /^[-\w$.]+$/.test(call.name) ? call.name : `"${call.name}"`;
      stub.push(`  call ${this.cx.llvmType(callee.retType)} @${sym}(${args})`);
    }
    stub.push("  unreachable");
    return stub;
  }

  /** `ir` with every stub replaced by the function's body compiled through MLIR. */
  compile(ir: string): string {
    const logPath = process.env.MILO_MLIR_LOG;
    if (logPath && this.log.length) appendFileSync(logPath, this.log.join("\n") + "\n");
    if (this.taken.length === 0) return ir;
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
    // The MLIR module is for the TARGET: the translation reads both attributes, and the
    // lowering sizes types with the data layout.
    const triple = this.target.triple;
    const dl = targetDataLayout(triple);
    const text = `module attributes {llvm.target_triple = "${triple}", llvm.data_layout = "${dl}"} {\n${mlirModuleText(this.taken)}}\n`;
    if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, text);
    // One process: milo-opt translates to LLVM IR itself (mlir/milo-opt.cpp).
    const ll = run(optPath, ["--emit-llvmir", ...MLIR_PIPELINE], text).split("\n");
    // The bodies are spliced into the legacy module: a triple or layout the two disagree on
    // would size a struct differently on each side of a call.
    if (!ll.includes(`target triple = "${triple}"`) || !ll.includes(`target datalayout = "${dl}"`)) throw new Error(`mlir: milo-opt did not emit for ${triple}`);
    if (!ir.split("\n").includes(`target triple = "${triple}"`)) throw new Error(`mlir: the legacy module is not for ${triple}`);

    const bodies = new Map<string, { header: string; body: string[] }>();
    const decls: { name: string; line: string }[] = [];
    const globals: string[] = [];
    const metadata: string[] = [];
    for (let i = 0; i < ll.length; i++) {
      const l = ll[i];
      if (l.startsWith("define")) {
        const m = DEFINE_RE.exec(l);
        if (!m) throw new Error(`mlir: unparsed define: ${l}`);
        const end = ll.indexOf("}", i);
        bodies.set(unquote(m[1]), { header: l, body: ll.slice(i + 1, end) });
        i = end;
      } else if (l.startsWith("declare")) {
        const m = DECL_RE.exec(l);
        if (m) decls.push({ name: unquote(m[1]), line: l.replace(/ #\d+$/, "") });
      } else if (/^!\d+ = /.test(l)) {
        metadata.push(l);
      } else if (l.startsWith("@")) {
        globals.push(l);
      }
    }

    const lines = ir.split("\n");
    const known = new Set<string>();
    // MLIR's metadata ids start at 0, as legacy's do: shift them past the legacy ones.
    let mdBase = 0;
    for (const l of lines) { const m = /^!(\d+) = /.exec(l); if (m) mdBase = Math.max(mdBase, Number(m[1]) + 1); }
    const renumber = (s: string) => s.replace(/!(\d+)\b/g, (_, n: string) => `!${Number(n) + mdBase}`);
    const out: string[] = [];
    let spliced = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = DECL_RE.exec(l);
      if (d) known.add(unquote(d[1]));
      const g = GLOBAL_RE.exec(l);
      if (g) known.add(unquote(g[1]));
      const def = l.startsWith("define") ? DEFINE_RE.exec(l) : null;
      const name = def ? unquote(def[1]) : null;
      if (name === null || !this.takenNames.has(name)) {
        out.push(l);
        continue;
      }
      const got = bodies.get(name);
      if (!got) throw new Error(`mlir: milo-opt produced no body for ${name}`);
      for (const b of got.body) {
        // The body is spliced into a module whose attribute groups it does not know, and
        // whose metadata numbering it shares: TBAA tags are renumbered below, anything
        // else (attribute groups, !dbg) is not something these ops lower to.
        if (/ #\d+\b/.test(b) || /!\w/.test(b.replace(/, !tbaa !\d+/g, ""))) throw new Error(`mlir: ${name} body carries attributes or metadata: ${b}`);
      }
      let header = l.replace(/ !dbg !\d+/, "");
      // main's are the process entry's argc/argv (codegen genFunction), not Milo params.
      const paramNames = name === "main" ? ["_milo_argc", "_milo_argv"] : this.fns.get(name)!.params.map(p => p.name);
      const renames: [RegExp, string][] = [];
      paramNames.forEach((p, k) => {
        const re = new RegExp(String.raw` %${p.replace(/[$.]/g, "\\$&")}(?=[,)])`);
        if (!re.test(header)) throw new Error(`mlir: no param %${p} in ${header}`);
        header = header.replace(re, ` %${k}`);
        renames.push([new RegExp(String.raw`%${p.replace(/[$.]/g, "\\$&")}\b`, "g"), `%${k}`]);
      });
      // Legacy lines ahead of the stub (main's prologue: argc/argv globals, stdout
      // buffering, global init) run first, at the top of the MLIR entry block. They are
      // calls and stores of params and globals, so they number no values of their own.
      const prologue: string[] = [];
      for (let j = i + 1; name === "main" && lines[j].replace(/, !dbg !\d+/, "") !== STUB_FIRST; j++) {
        if (lines[j] === "}") throw new Error(`mlir: no stub in ${name}`);
        // The legacy entry label goes; the MLIR body brings its own entry block.
        if (j === i + 1 && /^[-\w$.]+:$/.test(lines[j])) continue;
        let p = lines[j].replace(/, !dbg !\d+/, "");
        for (const [re, to] of renames) p = p.replace(re, to);
        if (/^\s*%\d+ = |^\S.*:$/.test(p)) throw new Error(`mlir: ${name} prologue defines a value or a block: ${p}`);
        prologue.push(p);
      }
      // Return type and param types; param attributes (nonnull, noalias, ...) are legacy's.
      // MLIR quotes a type name with `$` in it (`%"a$B"`); unquoted it is the same name.
      const sig = (h: string) => {
        h = h.replace(/%"([-\w$.]+)"/g, "%$1");
        const m = /^define [^@]*?(\S+) @[^(]*\((.*)\)/.exec(h);
        return m ? `${m[1]}(${m[2].split(", ").map(p => p.split(" ")[0]).join(", ")})` : h;
      };
      if (sig(header) !== sig(got.header)) throw new Error(`mlir: ABI mismatch for ${name}: legacy ${header} vs mlir ${got.header}`);
      const body = got.body.map(renumber);
      // An entry block is printed unlabeled unless something branches to it.
      const at = body.length && /^\S.*:/.test(body[0]) ? 1 : 0;
      body.splice(at, 0, ...prologue);
      out.push(header, ...body);
      while (lines[i] !== "}") i++;
      out.push("}");
      spliced++;
    }
    // A stub that ships would be an `unreachable` where a function body belongs.
    if (spliced !== this.taken.length) throw new Error(`mlir: spliced ${spliced} of ${this.taken.length} functions taken`);
    if (out.some(l => l === STUB_MARK)) throw new Error("mlir: a stub body survived the splice");
    // A global MLIR only declares (the recorder's counters) is the legacy module's own.
    out.push(...metadata.map(renumber));
    const extras = [...globals.filter(g => !known.has(unquote(GLOBAL_RE.exec(g)![1]))), ...decls.filter(d => !known.has(d.name)).map(d => d.line)];
    // Legacy names no data layout (clang picks it from the triple); name the one the bodies
    // were lowered with.
    const tripleAt = out.indexOf(`target triple = "${triple}"`);
    out.splice(tripleAt, 0, `target datalayout = "${dl}"`);
    const firstDefine = out.findIndex(l => l.startsWith("define"));
    out.splice(firstDefine < 0 ? out.length : firstDefine, 0, ...extras, "");
    return out.join("\n");
  }
}
