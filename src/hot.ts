// Hot reload (`milo build --hot`, `milo hot`): an IR-text transform that makes every
// function patchable through a data slot, the patch emitter that diffs a new build against
// the host's manifest, and the watch/apply driver. Design: docs/plans/fast-iteration-2026-10.md
// "Hot reload design (step 5)". MVP: body-only edits; anything that changes a layout, a
// signature, the function set or the mutable-global set is refused and the driver restarts.
//
// IR scanning is cgu.ts's (parseModule / mapSymbols); this file adds no IR parser of its own
// beyond splitting a `define` header into its parts.

import { execSync, spawn, type ChildProcess } from "child_process";
import { mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync, constants as fsConst } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  parseModule, mapSymbols, mapGlobalSymbols, referencedSymbols, referencedInGlobal,
  declareFor, externDeclFor, textHash, quoteIfNeeded, type Module, type Func, type Global,
} from "./cgu";
import { monitorPidTree, DEFAULT_MEM_MB } from "../scripts/guard";

// Module-local symbols are exported from the host under this prefix. Exporting them under
// their own name would let a Milo function named `read` or `write` interpose libc's for
// every other library in the process (ELF global lookup, and Mach-O flat lookup from the
// patch dylib); the prefix makes that collision impossible.
export const HOT_PREFIX = "__milo_hot.";

export type HotFn = { sig: string; hash: string; patchable: boolean };
export type HotManifest = {
  version: 1;
  /** keyed by the function's name in the codegen IR (before export renaming) */
  fns: Record<string, HotFn>;
  /** `%T` -> its `type ...` definition */
  types: Record<string, string>;
  /** mutable global -> its declaration shape (linkage dropped) */
  globals: Record<string, string>;
};

type Header = { name: string; ret: string; params: string[]; suffix: string };

const LINKAGE_WORDS = /^(?:private|internal|external|available_externally|linkonce|linkonce_odr|weak|weak_odr|appending|common|extern_weak|dso_local|dso_preemptable|unnamed_addr|local_unnamed_addr)\s+/;

/** `define [linkage] <ret> @name(<params>) <suffix> {` split at top-level commas. */
function splitHeader(header: string): Header | null {
  const m = /^define\s+(.*?)@("(?:[^"\\]|\\.)*"|[-a-zA-Z$._][-a-zA-Z$._0-9]*)\(/.exec(header);
  if (!m) return null;
  let ret = m[1]!.trim();
  while (LINKAGE_WORDS.test(ret + " ")) ret = (ret + " ").replace(LINKAGE_WORDS, "").trim();
  const params: string[] = [];
  let depth = 0, start = m[0].length, i = start;
  for (; i < header.length; i++) {
    const c = header[i]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) { params.push(header.slice(start, i).trim()); start = i + 1; }
  }
  if (i >= header.length) return null;
  const last = header.slice(start, i).trim();
  if (last) params.push(last);
  const suffix = header.slice(i + 1).replace(/\{\s*$/, "").trimEnd();
  const name = m[2]!.startsWith('"') ? m[2]!.slice(1, -1) : m[2]!;
  return { name, ret, params, suffix };
}

/** A param's type and attributes without its `%name`. */
function paramType(p: string): string {
  const m = /^(.*\S)\s+%(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)$/.exec(p);
  return m ? m[1]! : p;
}

const q = (name: string) => `@${quoteIfNeeded(name)}`;

function isConstant(g: Global): boolean {
  return /^@\S+\s*=\s*(?:[a-z_]+(?:\([^)]*\))?\s+)*constant\b/.test(g.text);
}

/** Facts about one parsed module that both the host transform and the patch need. */
class View {
  readonly fns: Map<string, Func>;
  readonly globals: Map<string, Global>;
  /** module-local constants: copied into a patch, never bound to the host by name */
  readonly localConsts: Map<string, Global>;
  readonly rename = new Map<string, string>();
  readonly typeNames: Set<string>;

  constructor(readonly mod: Module) {
    this.fns = new Map(mod.funcs.map(f => [f.name, f]));
    this.globals = new Map(mod.globals.map(g => [g.name, g]));
    this.localConsts = new Map(mod.globals.filter(g => g.local && isConstant(g)).map(g => [g.name, g]));
    this.typeNames = new Set(mod.typedefs.map(t => /^%(\S+)\s*=/.exec(t)?.[1] ?? "").filter(Boolean));
    for (const f of mod.funcs) if (f.local) this.rename.set(f.name, HOT_PREFIX + f.name);
    for (const g of mod.globals) if (g.local && !isConstant(g)) this.rename.set(g.name, HOT_PREFIX + g.name);
  }

  exported(name: string): string { return this.rename.get(name) ?? name; }

  /**
   * A function's identity for change detection. `.str.N` numbering shifts whenever any
   * earlier literal is added, so a constant reference hashes by the constant's contents;
   * otherwise one new string literal would make every later function look edited.
   */
  fnHash(f: Func): string {
    const text = mapSymbols(f.text, n => {
      const c = this.localConsts.get(n);
      return c ? `__c.${textHash(c.text.replace(/^@\S+\s*=\s*/, ""))}` : undefined;
    });
    // Value and label names renumbered by first appearance: some synthesized functions
    // draw temp numbers from a module-wide counter, so an edit elsewhere renames their
    // `%t.N` without changing a single instruction.
    const local = new Map<string, string>();
    const canon = (n: string) => { let c = local.get(n); if (c === undefined) local.set(n, (c = `_${local.size}`)); return c; };
    const normalized = text.replace(/%("(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)|^([-a-zA-Z$._0-9]+):/gm, (m, ref?: string, label?: string) => {
      if (label !== undefined) return `${canon(label)}:`;
      return this.typeNames.has(ref!) ? m : `%${canon(ref!)}`;
    });
    return textHash(normalized);
  }

  mutableGlobals(): Map<string, string> {
    const out = new Map<string, string>();
    for (const g of this.mod.globals) {
      if (isConstant(g)) continue;
      out.set(g.name, (externDeclFor(g.text) ?? g.text).replace(/^@\S+\s*=\s*external\s+/, ""));
    }
    return out;
  }
}

function signature(h: Header): string {
  return `${h.ret} (${h.params.map(paramType).join(", ")})${h.suffix}`;
}

/**
 * Functions the thunk cannot forward. Varargs: `musttail` can forward `...` only from a
 * varargs caller, and a varargs thunk of a varargs body is legal, but codegen emits none
 * today and the path is untested, so they stay direct (not patchable).
 */
function unpatchableReason(f: Func, h: Header): string | null {
  if (h.params.some(p => p.includes("..."))) return "varargs";
  if (f.name.startsWith("llvm.")) return "intrinsic";
  return null;
}

/**
 * Host transform: `@f` becomes a thunk that tail-calls through `@f.slot`, whose initial
 * value is the original body renamed `@f.v0`. Every reference to `@f` (calls, function
 * pointers in closures and trait itables) keeps naming the thunk, so a patch only has to
 * store a new pointer into the slot. Module-local functions and mutable globals are
 * promoted and exported (under HOT_PREFIX) so a patch dylib can bind to them.
 */
export function hostTransform(ir: string): { ir: string; manifest: HotManifest } | { error: string } {
  const mod = parseModule(ir);
  if (!mod) return { error: "the IR has a shape the hot transform does not recognize" };
  const v = new View(mod);
  const manifest: HotManifest = { version: 1, fns: {}, types: typesOf(mod), globals: Object.fromEntries(v.mutableGlobals()) };
  const rn = (t: string) => mapSymbols(t, n => v.rename.get(n));
  const typedefMap = new Map(Object.entries(manifest.types));

  const parts: string[] = [...mod.header, ""];
  parts.push(...mod.typedefs, "");
  parts.push(...mod.declares.map(rn), "");
  for (const g of mod.globals) {
    let t = mapGlobalSymbols(g.text, n => v.rename.get(n));
    if (v.rename.has(g.name)) t = t.replace(/^(@\S+\s*=\s*)(?:private|internal)\s+/, "$1");
    parts.push(t);
  }
  parts.push("");

  for (const f of mod.funcs) {
    const h = splitHeader(f.header);
    if (!h) return { error: `cannot parse the header of @${f.name}` };
    const why = unpatchableReason(f, h);
    manifest.fns[f.name] = { sig: signature(h), hash: v.fnHash(f), patchable: why === null };
    const exp = v.exported(f.name);
    const body = rn(f.text.slice(f.text.indexOf("\n")));
    if (why !== null) {
      parts.push(`define ${h.ret} ${q(exp)}(${h.params.join(", ")})${h.suffix} {${body}`, "");
      continue;
    }
    parts.push(`define internal ${h.ret} ${q(exp + ".v0")}(${h.params.join(", ")})${h.suffix} {${body}`, "");
    parts.push(`${q(exp + ".slot")} = global ptr ${q(exp + ".v0")}`, "");
    parts.push(thunk(exp, h, typedefMap), "");
  }
  parts.push(...mod.attrs, ...mod.metadata.map(rn));
  return { ir: parts.join("\n") + "\n", manifest };
}

/**
 * `musttail` rather than a plain call where the backend can do it: the thunk should be
 * invisible. A plain call adds a frame per call, so a deep recursion that fit before can
 * overflow in a hot build. musttail requires the prototype and every ABI attribute to
 * match, which holds by construction (the same header).
 *
 * The exception is a large aggregate return. The backend returns it through a hidden
 * pointer (sret demotion), and AArch64 then fails the whole build with "failed to perform
 * tail call elimination on a call site marked musttail" (seen on std/net's SockAddrIn,
 * 12 scalar leaves; %String with 3 is fine). Those thunks use a plain call, which is
 * correct and costs one frame.
 *
 * The acquire load pairs with the runtime's release store, so a thread that sees the new
 * pointer also sees the patch's relocated data.
 */
function thunk(exp: string, h: Header, typedefs: Map<string, string>): string {
  const types = h.params.map(paramType);
  const params = types.map((t, i) => `${t} %a${i}`).join(", ");
  const kind = returnFitsRegisters(h.ret, typedefs) ? "musttail call" : "call";
  const call = `${kind} ${h.ret} %p(${params})`;
  const body = h.ret === "void" ? `  ${call}\n  ret void` : `  %r = ${call}\n  ret ${h.ret} %r`;
  // A DISubprogram may describe only one function, and the body (`.v0`) keeps it.
  const suffix = h.suffix.replace(/\s*!dbg\s+![0-9]+/g, "");
  return `define ${h.ret} ${q(exp)}(${params})${suffix} {\nentry:\n  %p = load atomic ptr, ptr ${q(exp + ".slot")} acquire, align 8\n${body}\n}`;
}

// Conservative across targets: x86-64 returns up to 4 integer and 2 SSE values in
// registers, AArch64 8 of each.
const RET_MAX_INT = 4, RET_MAX_FP = 2;

function returnFitsRegisters(ret: string, typedefs: Map<string, string>): boolean {
  const count = { int: 0, fp: 0 };
  if (!countLeaves(ret.trim(), typedefs, count, 0)) return false;
  return count.int <= RET_MAX_INT && count.fp <= RET_MAX_FP;
}

/** Scalar leaves of an LLVM type, split int/fp; false when the type is not understood. */
function countLeaves(t: string, typedefs: Map<string, string>, c: { int: number; fp: number }, depth: number): boolean {
  if (depth > 32 || c.int + c.fp > 64) return false;
  if (t === "void") return true;
  if (/^(?:i\d+|ptr)$/.test(t)) { c.int++; return true; }
  if (/^(?:half|float|double|fp128|bfloat)$/.test(t)) { c.fp++; return true; }
  if (t.startsWith("%")) {
    const def = typedefs.get(t);
    return def !== undefined && countLeaves(def.replace(/^type\s+/, "").trim(), typedefs, c, depth + 1);
  }
  let m = /^\[(\d+) x (.*)\]$/.exec(t);
  if (m) {
    for (let i = 0; i < Number(m[1]); i++) if (!countLeaves(m[2]!.trim(), typedefs, c, depth + 1)) return false;
    return true;
  }
  m = /^<?\{(.*)\}>?$/.exec(t);
  if (m) {
    for (const part of splitTopLevel(m[1]!)) if (part && !countLeaves(part, typedefs, c, depth + 1)) return false;
    return true;
  }
  return false;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

function typesOf(mod: Module): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of mod.typedefs) {
    const m = /^(%\S+)\s*=\s*(type\b.*)$/.exec(t);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export type PatchResult =
  | { kind: "refuse"; reason: string }
  | { kind: "none" }
  | { kind: "patch"; ir: string; changed: string[]; exported: string[]; hashes: Record<string, string> };

/**
 * Diff `newIr` against the host manifest and emit a patch module holding only the changed
 * bodies, renamed `@f.v<n>`. `current` is each function's hash as last applied (the host's
 * own hashes before the first patch), so a patch carries only what changed since the
 * previous one; layout, signature and function-set checks always compare against the host,
 * because the host's data and thunks are what the patch has to fit.
 */
export function emitPatch(manifest: HotManifest, current: Record<string, string>, newIr: string, n: number): PatchResult {
  const mod = parseModule(newIr);
  if (!mod) return { kind: "refuse", reason: "the IR has a shape the hot transform does not recognize" };
  const v = new View(mod);

  const types = typesOf(mod);
  for (const [name, def] of Object.entries(manifest.types)) {
    if (types[name] !== undefined && types[name] !== def) return { kind: "refuse", reason: `type ${name} changed layout` };
  }
  const globals = v.mutableGlobals();
  for (const [name, shape] of Object.entries(manifest.globals)) {
    const now = globals.get(name);
    if (now === undefined) return { kind: "refuse", reason: `global ${name} removed` };
    if (now !== shape) return { kind: "refuse", reason: `global ${name} retyped` };
  }
  for (const name of globals.keys()) if (!(name in manifest.globals)) return { kind: "refuse", reason: `global ${name} added` };
  for (const name of Object.keys(manifest.fns)) if (!v.fns.has(name)) return { kind: "refuse", reason: `function ${name} removed` };

  const changed: Func[] = [];
  const headers = new Map<string, Header>();
  const hashes: Record<string, string> = {};
  for (const f of mod.funcs) {
    const was = manifest.fns[f.name];
    if (!was) return { kind: "refuse", reason: `function ${f.name} added` };
    const h = splitHeader(f.header);
    if (!h) return { kind: "refuse", reason: `cannot parse the header of @${f.name}` };
    if (signature(h) !== was.sig) return { kind: "refuse", reason: `signature of ${f.name} changed` };
    const hash = v.fnHash(f);
    if (hash === current[f.name]) continue;
    if (!was.patchable) return { kind: "refuse", reason: `${f.name} changed but is not patchable` };
    hashes[f.name] = hash;
    headers.set(f.name, h);
    changed.push(f);
  }
  if (changed.length === 0) return { kind: "none" };

  // Everything the changed bodies reach: host functions and mutable globals become
  // declarations bound by (exported) name; module-local constants are copied in.
  const fnDecls = new Set<string>();
  const globalDecls = new Set<string>();
  const consts = new Set<string>();
  const work: Set<string>[] = changed.map(f => referencedSymbols(f.text));
  while (work.length) {
    for (const s of work.pop()!) {
      if (v.fns.has(s)) fnDecls.add(s);
      else if (v.localConsts.has(s)) {
        if (!consts.has(s)) { consts.add(s); work.push(referencedInGlobal(v.localConsts.get(s)!.text)); }
      } else if (v.globals.has(s)) globalDecls.add(s);
    }
  }

  const rn = (t: string) => mapSymbols(t, n => v.rename.get(n));
  const parts: string[] = [...mod.header, ""];
  parts.push(...mod.typedefs, "");
  parts.push(...mod.declares, "");
  for (const name of fnDecls) parts.push(rn(declareFor(v.fns.get(name)!.header)));
  for (const name of globalDecls) {
    const d = externDeclFor(v.globals.get(name)!.text);
    if (d === null) return { kind: "refuse", reason: `cannot declare global ${name}` };
    parts.push(rn(d));
  }
  // Copied, not bound: constants are numbered per build (`.str.N`), so the host's `.str.7`
  // may hold a different literal than this build's. They are immutable, so a private copy
  // is indistinguishable from the original.
  for (const g of mod.globals) if (consts.has(g.name)) parts.push(mapGlobalSymbols(g.text, n => v.rename.get(n)));
  parts.push("");
  for (const f of changed) {
    const h = headers.get(f.name)!;
    parts.push(`define ${h.ret} ${q(v.exported(f.name) + ".v" + n)}(${h.params.join(", ")})${h.suffix} {${rn(f.text.slice(f.text.indexOf("\n")))}`, "");
  }
  parts.push(...mod.attrs, ...mod.metadata.map(rn));
  return { kind: "patch", ir: parts.join("\n") + "\n", changed: changed.map(f => f.name), exported: changed.map(f => v.exported(f.name)), hashes };
}

/** The hashes a fresh host starts from. */
export function initialHashes(m: HotManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(m.fns).map(([k, f]) => [k, f.hash]));
}

export function hotRuntimeSource(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "tools", "hot", "hot_runtime.c");
}

/** Extra link flags for a hot host: the apply runtime, and every symbol exported. */
export function hostLinkFlags(os: string): string {
  // Mach-O executables already export their external symbols; -export_dynamic also keeps
  // them through LTO-style dead stripping. Linux already passes -rdynamic for every build.
  return ` ${hotRuntimeSource()}` + (os === "darwin" ? " -Wl,-export_dynamic" : " -lpthread");
}

/** Compile a patch module to a shared library that binds to the host at dlopen. */
export function compilePatch(cc: string, ir: string, outLib: string, os: string): void {
  const ll = outLib.replace(/\.(dylib|so)$/, ".ll");
  writeFileSync(ll, ir);
  // dynamic_lookup: the patch's undefined symbols are the host's, which no link-time
  // library provides. dyld resolves them with a flat search that tries the main
  // executable first.
  const shared = os === "darwin" ? "-dynamiclib -undefined dynamic_lookup" : "-shared -fPIC";
  execSync(`${cc} -O0 ${shared} -Wno-override-module ${ll} -o ${outLib}`, { stdio: ["pipe", "pipe", "pipe"] });
}

export function patchLibName(dir: string, n: number, os: string): string {
  return join(dir, `patch_${n}.${os === "darwin" ? "dylib" : "so"}`);
}

/** Tell a running host to apply a patch. The fifo is opened per message, non-blocking:
 *  a host that died has no reader, and the open then fails instead of hanging. */
export function sendPatch(fifo: string, lib: string, n: number, exported: string[]): void {
  const fd = openSync(fifo, fsConst.O_WRONLY | fsConst.O_NONBLOCK);
  try { writeSync(fd, `${lib}\t${n}\t${exported.join(",")}\n`); } finally { closeSync(fd); }
}

/** Wait for the host's `ok N` / `err N ...` line in the ack file. */
export async function awaitAck(ackFile: string, n: number, timeoutMs = 5000): Promise<{ ok: boolean; msg: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = "";
    try { text = readFileSync(ackFile, "utf-8"); } catch {}
    for (const line of text.split("\n")) {
      const [status, id, ...msg] = line.split(" ");
      if (id === String(n) && (status === "ok" || status === "err")) return { ok: status === "ok", msg: msg.join(" ") };
    }
    await Bun.sleep(2);
  }
  return { ok: false, msg: "timed out waiting for the host to apply the patch" };
}

export type HotDeps = {
  /** Build the hot host binary; returns false after printing diagnostics. */
  buildHost: (outBin: string) => boolean;
  /** Frontend + codegen of the current sources (plain IR, before the hot transform); null after printing diagnostics. */
  compileIR: () => string | null;
  /** Every source file the last compile read. */
  files: () => string[];
  cc: string;
  os: string;
};

/** `milo hot <file> [-- args]`: run the program and patch it on every source save. */
export async function runHot(args: string[], deps: HotDeps): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "milo_hot_"));
  const fifo = join(dir, "cmd"), ack = join(dir, "ack"), bin = join(dir, "host");
  execSync(`mkfifo ${fifo}`);
  writeFileSync(ack, "");
  let child: ChildProcess | null = null;
  let stopGuard = () => {};
  let restarting = false;
  let manifest: HotManifest;
  let current: Record<string, string> = {};
  let n = 0;
  const fileHashes = new Map<string, string>();
  const fileStats = new Map<string, string>();

  const snapshot = () => {
    fileHashes.clear(); fileStats.clear();
    for (const f of deps.files()) {
      try {
        const st = statSync(f);
        fileStats.set(f, `${st.mtimeMs}:${st.size}`);
        fileHashes.set(f, textHash(readFileSync(f, "utf-8")));
      } catch {}
    }
  };
  const start = (): boolean => {
    if (!deps.buildHost(bin)) return false;
    manifest = JSON.parse(readFileSync(`${bin}.hot.json`, "utf-8"));
    current = initialHashes(manifest);
    snapshot();
    child = spawn(bin, args, { stdio: "inherit", env: { ...process.env, MILO_HOT_FIFO: fifo, MILO_HOT_ACK: ack } });
    const memMb = Number(process.env.MILO_RUN_MEM_MB || 0) || DEFAULT_MEM_MB;
    stopGuard = process.env.MILO_RUN_UNGUARDED === "1" ? () => {} : monitorPidTree(child.pid!, memMb, (mb) => {
      console.error(`hot: program exceeded its memory cap (footprint ${mb} MB) and was killed`);
    });
    child.on("close", (code, signal) => {
      stopGuard();
      if (!restarting) console.error(`hot: program exited (${signal ?? code}); waiting for a change to restart`);
      child = null;
    });
    return true;
  };
  const kill = async () => {
    if (!child) return;
    restarting = true;
    const c = child;
    const closed = new Promise(res => c.once("close", res));
    c.kill("SIGKILL");
    await closed;
    restarting = false;
  };
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on("SIGINT", () => { child?.kill("SIGKILL"); cleanup(); process.exit(130); });

  if (!start()) { cleanup(); return 1; }

  for (;;) {
    await Bun.sleep(50);
    let dirty = false;
    for (const [f, sig] of fileStats) {
      let now = "";
      try { const st = statSync(f); now = `${st.mtimeMs}:${st.size}`; } catch { continue; }
      if (now === sig) continue;
      fileStats.set(f, now);
      const h = textHash(readFileSync(f, "utf-8"));
      if (h !== fileHashes.get(f)) { fileHashes.set(f, h); dirty = true; }
    }
    if (!dirty) continue;
    const t0 = performance.now();
    if (!child) { await kill(); start(); continue; }
    const ir = deps.compileIR();
    if (ir === null) continue;
    const r = emitPatch(manifest!, current, ir, n + 1);
    if (r.kind === "none") continue;
    if (r.kind === "refuse") {
      console.error(`hot: restart (${r.reason})`);
      await kill();
      start();
      continue;
    }
    n++;
    const lib = patchLibName(dir, n, deps.os);
    try {
      compilePatch(deps.cc, r.ir, lib, deps.os);
      sendPatch(fifo, lib, n, r.exported);
    } catch (e: any) {
      console.error(`hot: patch failed, restarting:\n${e.stderr?.toString() ?? e.message}`);
      await kill(); start(); continue;
    }
    const a = await awaitAck(ack, n);
    if (!a.ok) { console.error(`hot: restart (apply failed: ${a.msg})`); await kill(); start(); continue; }
    Object.assign(current, r.hashes);
    console.error(`hot: patched ${r.changed.join(", ")} in ${Math.round(performance.now() - t0)}ms`);
  }
}
