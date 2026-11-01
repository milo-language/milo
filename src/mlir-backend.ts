// MILO_MLIR=1 driver (docs/mlir-backend.md): the functions the milo dialect covers go
// HIR -> milo MLIR (src/emit-mlir.ts) -> milo-opt -> mlir-translate, and their bodies
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
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { HIRFunction, HIRModule } from "./hir";
import { emitMlirFunction, mlirModuleText, type MlirEmitCtx, type MlirFunction } from "./emit-mlir";

export const MLIR_MODE = process.env.MILO_MLIR === "1";

// A compiled milo binary has no real path of its own; the test driver passes MILO_ROOT.
const ROOT = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MILO_OPT = process.env.MILO_OPT ?? join(ROOT, "mlir", "build", "milo-opt");
const LLVM_BIN = process.env.MILO_LLVM_BIN ?? "/opt/homebrew/opt/llvm/bin";
const BUILD_HINT = "build it with `sh mlir/build.sh`";

// verify (on parse) -> structured control flow to cf -> milo ops to LLVM -> SSA.
export const MLIR_PIPELINE = [
  "--milo-verify",
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

// The clang that compiles a MILO_MLIR=1 module: the one from the LLVM install milo-opt and
// mlir-translate come from. Their IR is that LLVM's, and an older clang (Apple's) may
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
    console.error(`error: MILO_MLIR=1 compiles with ${want} (the clang of milo-opt's LLVM), which does not run`);
    process.exit(1);
  }
  const cc = process.env.MILO_CC;
  if (cc && version(cc) !== wantVersion) {
    console.error(`error: MILO_MLIR=1 needs the clang of milo-opt's LLVM (${want}: ${wantVersion}); MILO_CC=${cc} is ${version(cc) ?? "not a working clang"}. Unset MILO_CC or point it at a clang of the same LLVM.`);
    process.exit(1);
  }
  return { path: cc ?? want, id: `${cc ?? want}\n${wantVersion}` };
}
function tool(path: string, what: string): string {
  if (!existsSync(path)) {
    console.error(`error: MILO_MLIR=1 needs ${what} at ${path}; ${BUILD_HINT}`);
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

  constructor(hir: HIRModule, private cx: MlirEmitCtx) {
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
    this.taken.push(r);
    this.log.push(`${fn.name}\tok`);
    this.takenNames.add(fn.name);
    if (r.text.slice(r.text.indexOf("\n")).includes("!milo.ptr")) return "legacy";
    const stub = ["  unreachable", "mlir.stub.calls:", STUB_MARK];
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
    const optPath = tool(MILO_OPT, "milo-opt");
    // The sources are the ones the binary was built from: <mlir>/build/milo-opt. A binary
    // elsewhere (a planted-bug build under build/) has no sources beside it to compare.
    const stale = staleMiloOpt(optPath, dirname(dirname(optPath)));
    if (stale) {
      console.error(`error: milo-opt is stale (mlir/${stale} is newer than ${optPath}): run sh mlir/build.sh`);
      process.exit(1);
    }
    const translate = tool(join(LLVM_BIN, "mlir-translate"), "mlir-translate");
    const text = mlirModuleText(this.taken);
    if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, text);
    const ll = run(translate, ["--mlir-to-llvmir", "-"], run(optPath, ["-", ...MLIR_PIPELINE], text)).split("\n");

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
      this.fns.get(name)!.params.forEach((p, k) => {
        const re = new RegExp(String.raw` %${p.name.replace(/[$.]/g, "\\$&")}(?=[,)])`);
        if (!re.test(header)) throw new Error(`mlir: no param %${p.name} in ${header}`);
        header = header.replace(re, ` %${k}`);
      });
      // Return type and param types; param attributes (nonnull, noalias, ...) are legacy's.
      const sig = (h: string) => {
        const m = /^define [^@]*?(\S+) @[^(]*\((.*)\)/.exec(h);
        return m ? `${m[1]}(${m[2].split(", ").map(p => p.split(" ")[0]).join(", ")})` : h;
      };
      if (sig(header) !== sig(got.header)) throw new Error(`mlir: ABI mismatch for ${name}: legacy ${header} vs mlir ${got.header}`);
      out.push(header, ...got.body.map(renumber));
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
    const firstDefine = out.findIndex(l => l.startsWith("define"));
    out.splice(firstDefine < 0 ? out.length : firstDefine, 0, ...extras, "");
    return out.join("\n");
  }
}
