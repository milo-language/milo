// MLIR driver (the build path) (docs/mlir-backend.md): the functions the milo dialect covers go
// HIR -> milo MLIR (src/emit-mlir.ts) -> milo-opt (passes, then LLVM IR), and their bodies
// replace the stubs src/codegen.ts leaves in the one LLVM module clang sees.
//
// Linking is a textual splice, not llvm-link. src/codegen.ts makes every non-exported fn
// `internal`, and two modules cannot reference each other's internal symbols, so llvm-link
// would need every cross-module callee promoted and re-internalized afterwards. In one
// module the names simply resolve. src/codegen.ts emits only a stub for a taken function
// (MlirPlan.take), with its real `define` line and its call edges.
// The `define` line is codegen.ts's (linkage, attributes, ABI), with params renumbered
// to the MLIR body's `%0..%n-1`. Under -g it keeps its `!dbg` (codegen-dwarf.ts's
// DISubprogram), and the body's DILocations are rescoped to it: the line table. Local
// variables (scalars and structs of them) are dbg.declare records on stack slots; enum, string and Vec
// type DIEs are not emitted yet.

import { appendFileSync, existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { HIRFunction, HIRModule } from "./hir";
import { mapSymbols } from "./cgu";
import type { TargetInfo } from "./target";
import { emitMlirFunction, globalOps, itableOps, mlirModuleText, type MlirEmitCtx, type MlirFunction } from "./emit-mlir";
import { MlirGlue } from "./mlir-glue";


// The data layout clang uses for `triple` (the one source of truth for it: codegen.ts
// emits no `target datalayout` and lets clang pick). Asked of the clang of milo-opt's LLVM,
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

// arith's `select %c, 1, 0` -> `extui %c` makes a signless-only op from a select whose
// type is Milo's si32 (a bool if-expression folded to a select), which then fails to verify.
const CANONICALIZE = "canonicalize{disable-patterns=SelectToExtUI}";

// verify (on parse) -> structured control flow to cf -> milo ops to LLVM -> SSA.
// Passes that see one function at a time sit under func.func(...) / llvm.func(...): MLIR's
// pass manager runs those on every function in parallel. At module level the generic
// passes (canonicalize, cse, licm, mem2reg) ran on one thread over the whole module.
const MLIR_PIPELINE = "--pass-pipeline=builtin.module(" + [
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
  "llvm.func(mem2reg," + CANONICALIZE + ")",
].join(",") + ")";
// -g: a DISubprogram per llvm.func, so the translation turns op locs into DILocations. The
// splice swaps these subprograms for codegen-dwarf.ts's.
const MLIR_PIPELINE_DEBUG = MLIR_PIPELINE.slice(0, -1) + ",ensure-debug-info-scope-on-llvm-func{emission-kind=LineTablesOnly},llvm.func(milo-lower-debug-vars))";

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

const STUB_MARK = "; milo.mlir.stub";
const STUB_FIRST = "  unreachable";

/**
 * Which functions go through MLIR, decided by codegen.ts as it reaches each one
 * (`take`, called from genFunction once signatures are known). A taken function gets a stub
 * body there; `compileThroughMlir` replaces the stub.
 */
export class MlirPlan {
  private taken: MlirFunction[] = [];
  private takenNames = new Set<string>();
  private log: string[] = [];
  private readonly fns = new Map<string, HIRFunction>();
  // Type-directed glue (display, ...) every taken function shares: emitted once, appended
  // to the module as closure bodies are.
  private readonly glue: MlirGlue;

  constructor(private hir: HIRModule, private cx: MlirEmitCtx, private target: TargetInfo) {
    this.glue = new MlirGlue(cx);
    for (const f of hir.functions) if (!this.fns.has(f.name)) this.fns.set(f.name, f);
  }

  /**
   * The stub body for `fn` when MLIR takes it, else null: a placeholder the splice
   * replaces with the MLIR body, never executed and never shipped.
   */
  take(fn: HIRFunction): string[] | null {
    if (fn.isExtern) return null;
    const r = emitMlirFunction(fn, this.cx, this.fns, this.glue);
    if (typeof r === "string") {
      const [first, ...more] = r.split("\n");
      this.log.push(`${fn.name}\t${first}`, ...more.map(m => `${fn.name}\t${m}\tmore`));
      // There is no other backend to fall back to: the dialect must cover every function.
      throw new Error(`mlir: ${fn.name} is not covered: ${first}`);
    }
    // A lazy global's init function is codegen's own, not in the HIR module.
    if (!this.fns.has(r.name)) this.fns.set(r.name, fn);
    this.taken.push(r);
    this.log.push(`${fn.name}\tok`);
    this.takenNames.add(r.name);
    // The noalias pass runs on the spliced module (Codegen.noaliasOnFinal), so the stub
    // only holds the place: the splice replaces it whole.
    return [STUB_FIRST, "mlir.stub.calls:", STUB_MARK, "  unreachable"];
  }

  /** The closure bodies MLIR emitted (not their env drops), for the noalias pass. */
  closureBodies(): string[] {
    return this.taken.flatMap(f => f.closures).filter(n => !n.endsWith("$envdrop"));
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
    const glue = this.glue.module();
    const glueFn: MlirFunction[] = glue ? [{ name: "milo.glue", text: glue.text, callees: this.glue.callees, calls: [], closures: glue.names }] : [];
    const text = `module attributes {llvm.target_triple = "${triple}", llvm.data_layout = "${dl}"} {\n${globalOps(this.hir.globals, this.cx)}${itableOps(this.hir.itables, this.cx)}${mlirModuleText([...this.taken, ...glueFn])}}\n`;
    if (process.env.MILO_MLIR_DUMP) appendFileSync(process.env.MILO_MLIR_DUMP, text);
    // One process: milo-opt translates to LLVM IR itself (mlir/milo-opt.cpp).
    // A per-module extern is one more typed view of a C symbol: codegen.ts renames its
    // calls to that symbol at the end of generate(), so the MLIR side is renamed the same way.
    const links = new Map([...this.fns.values()].filter(f => f.isExtern && f.linkName && f.linkName !== f.name).map(f => [f.name, f.linkName!]));
    const debug = this.cx.emitDebug;
    const llText = run(optPath, ["--emit-llvmir", debug ? MLIR_PIPELINE_DEBUG : MLIR_PIPELINE], text);
    const ll = (links.size ? mapSymbols(llText, n => links.get(n)) : llText).split("\n");
    // The bodies are spliced into codegen.ts's module: a triple or layout the two disagree on
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
        if (m) decls.push({ name: unquote(m[1]), line: l.replace(/ #\d+$/, "").replace(/ !dbg !\d+/, "") });
      } else if (/^!\d+ = /.test(l)) {
        metadata.push(l);
      } else if (l.startsWith("@")) {
        globals.push(l);
      }
    }

    const lines = ir.split("\n");
    const known = new Set<string>();
    // MLIR's metadata ids start at 0, as codegen.ts's do: shift them past those.
    let mdBase = 0;
    for (const l of lines) { const m = /^!(\d+) = /.exec(l); if (m) mdBase = Math.max(mdBase, Number(m[1]) + 1); }
    // -g: the scaffold's DICompileUnit and DISubprograms (codegen-dwarf.ts) stay the module's;
    // a reference to MLIR's compile unit or to a taken function's MLIR subprogram is
    // redirected to them, so MLIR's DILocations (and any DILexicalBlockFile under them)
    // land in the scaffold's scopes.
    const redirect = new Map<number, number>();
    if (debug) {
      const cu = lines.map(l => /^!(\d+) = distinct !DICompileUnit\(/.exec(l)).find(m => m);
      const mlirCu = ll.map(l => /^!(\d+) = distinct !DICompileUnit\(/.exec(l)).find(m => m);
      if (!cu) throw new Error("mlir: -g module has no DICompileUnit");
      if (mlirCu) redirect.set(Number(mlirCu[1]), Number(cu[1]));
    }
    const renumber = (s: string) => s.replace(/!(\d+)\b/g, (_, n: string) => `!${redirect.get(Number(n)) ?? Number(n) + mdBase}`);
    // The body is spliced into a module whose attribute groups it does not know, and whose
    // metadata numbering it shares: TBAA tags (and under -g, DILocations) are renumbered,
    // anything else is not something these ops lower to.
    const checkBody = (name: string, body: string[]) => {
      for (const b of body) {
        // A local variable is the debug record `#dbg_declare(ptr %slot, !var, !DIExpression(), !loc)`.
        if (debug && /^\s*#dbg_declare\(ptr %[-\w$.]+, !\d+, !DIExpression\(\), !\d+\)$/.test(b)) continue;
        const rest = b.replace(/, !tbaa !\d+/g, "");
        if (/ #\d+\b/.test(b) || /!\w/.test(debug ? rest.replace(/, !dbg !\d+/g, "") : rest)) throw new Error(`mlir: ${name} body carries attributes or metadata: ${b}`);
      }
    };
    const dbgOf = (l: string) => { const m = / !dbg !(\d+)/.exec(l); return m ? Number(m[1]) : null; };
    // What the module takes from MLIR, in MLIR's numbering: where -g's metadata is reached from.
    const fromMlir: string[] = [];
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
      checkBody(name, got.body);
      let header = debug ? l : l.replace(/ !dbg !\d+/, "");
      const sp = dbgOf(header), mlirSp = dbgOf(got.header);
      if (debug && mlirSp !== null) {
        if (sp !== null) redirect.set(mlirSp, sp);
        else header = header.replace(/ \{$/, ` !dbg !${mlirSp + mdBase} {`);
      }
      // main's are the process entry's argc/argv (codegen genFunction), not Milo params.
      const paramNames = name === "main" ? ["_milo_argc", "_milo_argv"] : this.fns.get(name)!.params.map(p => p.name);
      if (this.cx.sretFns.has(name)) paramNames.unshift("__sret.out");
      const renames: [RegExp, string][] = [];
      paramNames.forEach((p, k) => {
        const re = new RegExp(String.raw` %${p.replace(/[$.]/g, "\\$&")}(?=[,)])`);
        if (!re.test(header)) throw new Error(`mlir: no param %${p} in ${header}`);
        header = header.replace(re, ` %${k}`);
        renames.push([new RegExp(String.raw`%${p.replace(/[$.]/g, "\\$&")}\b`, "g"), `%${k}`]);
      });
      // Lines ahead of the stub (main's prologue: argc/argv globals, stdout
      // buffering, global init) run first, at the top of the MLIR entry block. They are
      // calls and stores of params and globals, so they number no values of their own.
      const prologue: string[] = [];
      for (let j = i + 1; name === "main" && lines[j].replace(/, !dbg !\d+/, "") !== STUB_FIRST; j++) {
        if (lines[j] === "}") throw new Error(`mlir: no stub in ${name}`);
        // The entry label goes; the MLIR body brings its own entry block.
        if (j === i + 1 && /^[-\w$.]+:$/.test(lines[j])) continue;
        // Under -g its DILocations are the scaffold's, in the subprogram the header keeps.
        let p = debug ? lines[j] : lines[j].replace(/, !dbg !\d+/, "");
        for (const [re, to] of renames) p = p.replace(re, to);
        if (/^\s*%\d+ = |^\S.*:$/.test(p)) throw new Error(`mlir: ${name} prologue defines a value or a block: ${p}`);
        prologue.push(p);
      }
      // Return type and param types; param attributes (nonnull, noalias, ...) are codegen.ts's.
      // MLIR quotes a type name with `$` in it (`%"a$B"`); unquoted it is the same name.
      const sig = (h: string) => {
        h = h.replace(/%"([-\w$.]+)"/g, "%$1");
        const m = /^define [^@]*?(\S+) @[^(]*\((.*)\)/.exec(h);
        return m ? `${m[1]}(${m[2].split(", ").map(p => p.split(" ")[0]).join(", ")})` : h;
      };
      if (sig(header) !== sig(got.header)) throw new Error(`mlir: ABI mismatch for ${name}: legacy ${header} vs mlir ${got.header}`);
      const body = got.body.map(renumber);
      fromMlir.push(got.header, ...got.body);
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
    // Closure bodies are functions codegen.ts never defined: appended whole, MLIR's `define internal` line and all.
    // Under -g a closure keeps MLIR's DISubprogram (codegen.ts has none for it), now in the
    // scaffold's compile unit. Glue has no source, so its locs are the dialect text's: none ship.
    const glueNames = new Set(glueFn.flatMap(f => f.closures));
    for (const name of [...this.taken, ...glueFn].flatMap(f => f.closures)) {
      const got = bodies.get(name);
      if (!got) throw new Error(`mlir: milo-opt produced no body for closure ${name}`);
      checkBody(name, got.body);
      const header = got.header.replace(/ #\d+/g, "");
      if (glueNames.has(name)) out.push(header.replace(/ !dbg !\d+/, ""), ...got.body.map(b => renumber(b.replace(/, !dbg !\d+/g, ""))), "}");
      else { out.push(renumber(header), ...got.body.map(renumber), "}"); fromMlir.push(header, ...got.body); }
    }
    if (!debug) out.push(...metadata.map(renumber));
    else {
      // Only the nodes the spliced code reaches: MLIR's compile unit, its subprograms for
      // taken functions and declarations, and its module flags are the scaffold's to say.
      const nodes = new Map(metadata.map(m => [Number(/^!(\d+)/.exec(m)![1]), m]));
      const seen = new Set<number>();
      const reach = (s: string) => {
        for (const [, n] of s.matchAll(/!(\d+)\b/g)) {
          const id = Number(n);
          if (redirect.has(id) || seen.has(id) || !nodes.has(id)) continue;
          seen.add(id);
          reach(nodes.get(id)!.replace(/^!\d+ = /, ""));
        }
      };
      for (const l of fromMlir) reach(l);
      out.push(...[...seen].sort((a, b) => a - b).map(id => renumber(nodes.get(id)!)));
    }
    // A global MLIR only declares (the recorder's counters) is codegen.ts's module's own.
    const extras = [...globals.filter(g => !known.has(unquote(GLOBAL_RE.exec(g)![1]))), ...decls.filter(d => !known.has(d.name)).map(d => d.line)];
    // codegen.ts names no data layout (clang picks it from the triple); name the one the bodies
    // were lowered with.
    const tripleAt = out.indexOf(`target triple = "${triple}"`);
    out.splice(tripleAt, 0, `target datalayout = "${dl}"`);
    const firstDefine = out.findIndex(l => l.startsWith("define"));
    out.splice(firstDefine < 0 ? out.length : firstDefine, 0, ...extras, "");
    return out.join("\n");
  }
}
