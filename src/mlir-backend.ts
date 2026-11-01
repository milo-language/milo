// MILO_MLIR=1 driver (docs/mlir-backend.md): the functions the milo dialect covers go
// HIR -> milo MLIR (src/emit-mlir.ts) -> milo-opt -> mlir-translate, and their bodies
// replace the legacy codegen's in the one LLVM module clang sees.
//
// Linking is a textual splice, not llvm-link. Legacy codegen makes every non-exported fn
// `internal`, and two modules cannot reference each other's internal symbols, so llvm-link
// would need every cross-module callee promoted and re-internalized afterwards. In one
// module the names simply resolve. The legacy body is still generated and then dropped:
// codegen's module-wide analyses (the noalias reach dataflow) read every body, and the
// legacy body computes the same values, so they stay sound without knowing about MLIR.
// The `define` line is the legacy one (linkage, attributes, ABI), with params renumbered
// to the MLIR body's `%0..%n-1`; DWARF for these functions is M6, so -g drops their `!dbg`.

import { appendFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { HIRFunction, HIRModule } from "./hir";
import { emitMlirModule, type MlirEmitCtx } from "./emit-mlir";

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

/** `ir` with the bodies of every function the dialect covers compiled through MLIR. */
export function compileThroughMlir(ir: string, hir: HIRModule, cx: MlirEmitCtx): string {
  const optPath = tool(MILO_OPT, "milo-opt");
  const translate = tool(join(LLVM_BIN, "mlir-translate"), "mlir-translate");
  const lines = ir.split("\n");
  const defineAt = new Map<string, number>();
  const known = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const d = DECL_RE.exec(lines[i]);
    if (!d) continue;
    const name = unquote(d[1]);
    known.add(name);
    if (lines[i].startsWith("define")) defineAt.set(name, i);
  }

  const fns = new Map<string, HIRFunction>();
  for (const f of hir.functions) if (!fns.has(f.name)) fns.set(f.name, f);
  const candidates = [...fns.values()].filter(f => !f.isExtern && defineAt.has(f.name));
  const mod = emitMlirModule(candidates, cx, fns);
  const logPath = process.env.MILO_MLIR_LOG;
  if (logPath) {
    const missing = [...fns.values()].filter(f => !f.isExtern && !defineAt.has(f.name));
    const rows = [...mod.log.map(l => `${l.name}\t${l.reason}`), ...missing.map(f => `${f.name}\tno legacy define`)];
    if (rows.length) appendFileSync(logPath, rows.join("\n") + "\n");
  }
  if (mod.defined.length === 0) return ir;
  if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, mod.text);

  const opt = run(optPath, ["-", ...MLIR_PIPELINE], mod.text);
  const ll = run(translate, ["--mlir-to-llvmir", "-"], opt).split("\n");

  const bodies = new Map<string, { header: string; body: string[] }>();
  const extras: string[] = [];
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
      if (m && !known.has(unquote(m[1]))) extras.push(l.replace(/ #\d+$/, ""));
    } else if (l.startsWith("@")) {
      extras.push(l);
    }
  }

  for (const name of mod.defined) {
    const got = bodies.get(name);
    if (!got) throw new Error(`mlir: milo-opt produced no body for ${name}`);
    for (const l of got.body) {
      // The body is spliced into a module whose attribute groups and metadata it does not
      // know; neither appears in what M1 emits, so finding one is a bug to fix here.
      if (/ #\d+\b|!\w/.test(l)) throw new Error(`mlir: ${name} body carries attributes or metadata: ${l}`);
    }
    const at = defineAt.get(name)!;
    const fn = fns.get(name)!;
    let header = lines[at].replace(/ !dbg !\d+/, "");
    fn.params.forEach((p, i) => {
      const re = new RegExp(String.raw` %${p.name.replace(/[$.]/g, "\\$&")}(?=[,)])`);
      if (!re.test(header)) throw new Error(`mlir: no param %${p.name} in ${header}`);
      header = header.replace(re, ` %${i}`);
    });
    const sig = (h: string) => { const m = /^define [^@]*?(\S+) @[^(]*(\(.*\))/.exec(h); return m ? `${m[1]}${m[2]}` : h; };
    if (sig(header) !== sig(got.header)) throw new Error(`mlir: ABI mismatch for ${name}: legacy ${header} vs mlir ${got.header}`);
    let end = at;
    while (lines[end] !== "}") end++;
    lines.splice(at, end - at + 1, header, ...got.body, "}");
    // Later defines moved; re-index the ones after this splice.
    const delta = got.body.length + 2 - (end - at + 1);
    for (const [k, v] of defineAt) if (v > at) defineAt.set(k, v + delta);
  }
  const firstDefine = lines.findIndex(l => l.startsWith("define"));
  lines.splice(firstDefine < 0 ? lines.length : firstDefine, 0, ...extras, "");
  return lines.join("\n");
}
