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

import { appendFileSync, existsSync } from "fs";
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
  "--milo-lower-structured-cf",
  "--convert-milo-to-llvm",
  "--reconcile-unrealized-casts",
  "--mem2reg",
  "--canonicalize",
];

const IDENT = String.raw`"(?:[^"\\]|\\.)*"|[-\w$.]+`;
const DEFINE_RE = new RegExp(String.raw`^define [^@]*@(${IDENT})\(`);
const DECL_RE = new RegExp(String.raw`^(?:define|declare) [^@]*@(${IDENT})\(`);

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
  private log: string[] = [];
  private readonly fns = new Map<string, HIRFunction>();

  constructor(hir: HIRModule, private cx: MlirEmitCtx) {
    for (const f of hir.functions) if (!this.fns.has(f.name)) this.fns.set(f.name, f);
  }

  /**
   * The stub body for `fn` when MLIR takes it, else null. The stub is never executed and
   * never shipped; it exists for codegen's module-wide noalias dataflow, which reads call
   * edges out of the IR text: one dead call per callee keeps the edges through this
   * function. Its own body has nothing else that analysis looks at (scalars only: no
   * pointers, no globals).
   */
  take(fn: HIRFunction): string[] | null {
    if (fn.isExtern) return null;
    const r = emitMlirFunction(fn, this.cx, this.fns);
    if (typeof r === "string") { this.log.push(`${fn.name}\t${r}`); return null; }
    this.taken.push(r);
    this.log.push(`${fn.name}\tok`);
    const stub = ["  unreachable", "mlir.stub.calls:", STUB_MARK];
    for (const name of r.callees.keys()) {
      const callee = this.fns.get(name)!;
      const args = callee.params.map(p => `${this.cx.llvmType(p.type)} poison`).join(", ");
      const sym = /^[-\w$.]+$/.test(name) ? name : `"${name}"`;
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
    const translate = tool(join(LLVM_BIN, "mlir-translate"), "mlir-translate");
    const text = mlirModuleText(this.taken);
    if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, text);
    const ll = run(translate, ["--mlir-to-llvmir", "-"], run(optPath, ["-", ...MLIR_PIPELINE], text)).split("\n");

    const bodies = new Map<string, { header: string; body: string[] }>();
    const decls: { name: string; line: string }[] = [];
    const globals: string[] = [];
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
      } else if (l.startsWith("@")) {
        globals.push(l);
      }
    }

    const lines = ir.split("\n");
    const known = new Set<string>();
    const out: string[] = [];
    let spliced = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = DECL_RE.exec(l);
      if (d) known.add(unquote(d[1]));
      if (!l.startsWith("define") || lines[i + 2] !== "  unreachable" || lines[i + 4] !== STUB_MARK) {
        out.push(l);
        continue;
      }
      const name = unquote(DEFINE_RE.exec(l)![1]);
      const got = bodies.get(name);
      if (!got) throw new Error(`mlir: milo-opt produced no body for ${name}`);
      for (const b of got.body) {
        // The body is spliced into a module whose attribute groups and metadata it does
        // not know; neither appears in what the scalar ops lower to, so one is a bug here.
        if (/ #\d+\b|!\w/.test(b)) throw new Error(`mlir: ${name} body carries attributes or metadata: ${b}`);
      }
      let header = l.replace(/ !dbg !\d+/, "");
      this.fns.get(name)!.params.forEach((p, k) => {
        const re = new RegExp(String.raw` %${p.name.replace(/[$.]/g, "\\$&")}(?=[,)])`);
        if (!re.test(header)) throw new Error(`mlir: no param %${p.name} in ${header}`);
        header = header.replace(re, ` %${k}`);
      });
      const sig = (h: string) => { const m = /^define [^@]*?(\S+) @[^(]*(\(.*\))/.exec(h); return m ? `${m[1]}${m[2]}` : h; };
      if (sig(header) !== sig(got.header)) throw new Error(`mlir: ABI mismatch for ${name}: legacy ${header} vs mlir ${got.header}`);
      out.push(header, ...got.body);
      while (lines[i] !== "}") i++;
      out.push("}");
      spliced++;
    }
    // A stub that ships would be an `unreachable` where a function body belongs.
    if (spliced !== this.taken.length) throw new Error(`mlir: spliced ${spliced} of ${this.taken.length} functions taken`);
    const extras = [...globals, ...decls.filter(d => !known.has(d.name)).map(d => d.line)];
    const firstDefine = out.findIndex(l => l.startsWith("define"));
    out.splice(firstDefine < 0 ? out.length : firstDefine, 0, ...extras, "");
    return out.join("\n");
  }
}
