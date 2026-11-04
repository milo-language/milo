// Profile checks on the linked binary (docs/plans/object-level-assurance.md step 3).
// The source-level profile (src/safety.ts) is a claim about the AST; these check the same
// claims on what the toolchain actually produced, so a lowering or optimizer change that
// adds a malloc or a call cycle is caught where it lands.
//
// Input is the final linked image, read with the llvm-nm / llvm-objdump of milo-opt's LLVM:
//   - llvm-nm: defined and undefined (imported) symbols;
//   - llvm-objdump -d: direct calls and jumps between symbols give the call graph. Indirect
//     calls (blr, blx rN, call *) have no static target and are reported as "unknown target".
// The object, not the LLVM IR, so the checks see what clang and the linker did to it: a
// call the optimizer inlined away is gone, one the runtime shim adds is present.
//
// Limits (also in docs/site/language/safety-profiles.md): indirect tail jumps (br/jmp *)
// are not edges (they are mostly jump tables); a dynamic binary's libc is opaque, so only the
// imports are known, not what libc does behind them; Mach-O stubs are resolved through
// `--indirect-symbols`, ELF PLT entries through objdump's own `<sym@plt>` labels.
import { spawnSync } from "child_process";
import { openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { LLVM_BIN } from "./mlir-backend";
import { objectPolicy, type SafetyLevel } from "./safety";

export interface ObjectGraph {
  defined: Set<string>;
  undefinedSyms: Set<string>;
  edges: Map<string, Set<string>>;   // caller -> direct callees (calls and jumps to other symbols)
  indirect: Map<string, number>;     // function -> number of indirect call sites
}

export interface ObjectViolation { check: "allocation" | "recursion" | "indirect-call" | "allowlist"; message: string }

const ALLOC_SINKS = new Set(["malloc", "calloc", "realloc", "free", "posix_memalign", "aligned_alloc", "memalign", "valloc", "mmap", "brk", "sbrk", "strdup", "strndup"]);

// Libc names the bare-metal runtime shim (tools/cortex-m/startup.c) DEFINES: in a static
// image they are not undefined imports, but they are still runtime services the program
// reached, so the allowlist applies to them too.
const SHIM_DEFINED = new Set(["malloc", "free", "printf", "exit", "memcpy", "memset", "memmove", "memchr", "memcmp"]);

// What a no-allocation profile lets the program import: the freestanding core C needs plus
// compiler helper routines. No I/O, no threads, no environment. `printf` and `exit` are the
// fail-stop path: every overflow/bounds/contract trap ends in __milo_overflow_fail, which
// reports and exits, so a binary with traps (all of them) reaches both. Allowing them is the
// profile accepting that defined trap behavior; a product replaces the handler with its own.
const CORE_ALLOW = new Set(["memcpy", "memmove", "memset", "memcmp", "bcmp", "memchr", "strlen", "abort", "exit", "_exit", "printf"]);
const HELPER_ALLOW = /^(__aeabi_\w+|__(u?div|u?mod|mul|add|sub)(di|si|ti|df|sf)3|__(fix|float)\w*|__stack_chk_\w+|__udivmoddi4|__gnu_\w+|dyld_stub_binder)$/;
// Pure libm: no allocation, no state.
const LIBM_ALLOW = new Set(["floor", "ceil", "fmod", "pow", "sqrt", "sin", "cos", "tan", "atan", "atan2", "exp", "log", "log2", "log10", "fabs", "trunc", "round"]);
// A profile that allows allocation may also import the usual hosted libc.
const HOSTED_ALLOW = /^(malloc|calloc|realloc|free|mmap|munmap|mprotect|read|write|open|close|lseek|stat|fstat|fcntl|ioctl|getenv|setenv|unsetenv|gettimeofday|clock_gettime|usleep|nanosleep|sched_yield|getpid|kill|raise|atexit|fflush|fwrite|snprintf|dprintf|setvbuf|strerror|waitpid|pthread_\w+|_?_?error|__errno_location|environ|_NSGetEnviron|\w*context|stdout|stderr|__stdoutp|__stderrp|_tlv_bootstrap)$/;

function tool(name: string): string { return join(LLVM_BIN, name); }
function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

// Mach-O C symbols carry a leading underscore; strip it so one allowlist serves both formats.
// ELF versioned imports (malloc@GLIBC_2.2.5, malloc@plt) drop the suffix.
function norm(sym: string, macho: boolean): string {
  // __milo_cgu. is the prefix a split build gives a promoted internal symbol.
  let s = sym.replace(/@.*$/, "").replace(/^(_*)__milo_cgu\./, "$1");
  if (macho && s.startsWith("_")) s = s.slice(1);
  return s;
}

const BRANCH = /^(b[a-z.]*|cb[a-z]*|tb[a-z]*|j[a-z]+|call[a-z]*)$/;
const TARGET = /(?:^|,\s*)(0x[0-9a-f]+)\s*<([^>]+)>/;
const INDIRECT_CALL = /^(blr\w*|blx\w*\s+(r\d+|lr|ip|sp)|call[a-z]*\s+\*|callq?\s+\*)/;

// Mach-O magics (32/64-bit, either byte order) and the fat header; anything else is ELF here.
function isMachO(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(b.toString("hex"));
  } finally { closeSync(fd); }
}

export function readObject(path: string): ObjectGraph {
  const macho = isMachO(path);
  const defined = new Set<string>();
  const undefinedSyms = new Set<string>();
  for (const line of run(tool("llvm-nm"), [path]).split("\n")) {
    const m = /^(?:[0-9a-f]+\s+)?([A-Za-z])\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, kind, name] = m;
    if (kind === "U" || kind === "u") undefinedSyms.add(norm(name, macho));
    else if (/[TtWwVvDdRrSsBb]/.test(kind)) defined.add(norm(name, macho));
  }
  // Mach-O stubs are anonymous in -d output; the indirect symbol table names each one.
  const stubs = new Map<number, string>();
  if (macho) {
    for (const line of run(tool("llvm-objdump"), ["--macho", "--indirect-symbols", path]).split("\n")) {
      const m = /^0x([0-9a-f]+)\s+\d+\s+(\S+)$/.exec(line);
      if (m) stubs.set(parseInt(m[1], 16), norm(m[2], true));
    }
  }
  const edges = new Map<string, Set<string>>();
  const indirect = new Map<string, number>();
  let cur: string | null = null;
  let inStubs = false;
  for (const line of run(tool("llvm-objdump"), ["-d", "--no-show-raw-insn", path]).split("\n")) {
    if (line.startsWith("Disassembly of section")) { inStubs = /stubs|\.plt/.test(line); cur = null; continue; }
    const label = /^[0-9a-f]+ <(.+)>:$/.exec(line);
    if (label) { cur = inStubs ? null : norm(label[1], macho); if (cur && !edges.has(cur)) edges.set(cur, new Set()); continue; }
    if (!cur) continue;
    const ins = /^\s*[0-9a-f]+:\s+(\S+)\s*(.*)$/.exec(line);
    if (!ins) continue;
    const [, mnem, ops] = ins;
    if (INDIRECT_CALL.test(`${mnem} ${ops}`)) { indirect.set(cur, (indirect.get(cur) ?? 0) + 1); continue; }
    if (!BRANCH.test(mnem)) continue;
    const t = TARGET.exec(ops);
    if (!t) continue;
    const addr = parseInt(t[1], 16);
    const stub = stubs.get(addr);
    const m = /^(.+?)(?:\+0x([0-9a-f]+))?$/.exec(t[2])!;
    const sym = norm(stub ?? m[1], macho);
    const off = stub ? 0 : m[2] ? parseInt(m[2], 16) : 0;
    const isCall = mnem === "bl" || mnem === "blx" || mnem.startsWith("call");
    if (sym === cur && !isCall) continue;       // a jump inside the function is a loop, not a call
    // A jump into the middle of another symbol is not a call to it (shared tails, data).
    if (!isCall && !stub && off !== 0) continue;
    edges.get(cur)!.add(sym);
  }
  return { defined, undefinedSyms, edges, indirect };
}

function isRoot(sym: string): boolean { return sym === "main" || sym === "Reset_Handler"; }

// Shortest path from any root to a node satisfying `goal`, or null.
function pathTo(g: ObjectGraph, goal: (s: string) => boolean): string[] | null {
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of g.edges.keys()) if (isRoot(r)) { prev.set(r, null); queue.push(r); }
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (goal(n)) { const p: string[] = []; for (let c: string | null = n; c !== null; c = prev.get(c) ?? null) p.unshift(c); return p; }
    for (const m of g.edges.get(n) ?? []) if (!prev.has(m)) { prev.set(m, n); queue.push(m); }
  }
  return null;
}

/** Functions that call an allocator directly, with the shortest root path to each one, and
 *  whether the path is entirely the program's own code. A name with `$` is a std/imported
 *  module function, `__milo*` and `rt*` are scaffold/runtime; anything else is program code. */
export function allocationFindings(g: ObjectGraph): { sink: string; path: string[]; viaRuntime: boolean }[] {
  const out: { sink: string; path: string[]; viaRuntime: boolean }[] = [];
  const direct = [...g.edges].filter(([, cs]) => [...cs].some(c => ALLOC_SINKS.has(c))).map(([f]) => f).sort();
  for (const f of direct) {
    const p = pathTo(g, s => s === f);
    if (!p) continue;                      // unreachable from the entry: gc'd or dead
    const sink = [...g.edges.get(f)!].find(c => ALLOC_SINKS.has(c))!;
    out.push({ sink, path: [...p, sink], viaRuntime: p.some(s => /\$|^_*milo|^rt[A-Z]|^_*(replay|scheduler)/.test(s)) });
  }
  return out;
}

/** Every cycle (one representative per strongly connected component) in the call graph. */
export function cycles(g: ObjectGraph): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [], out: string[][] = [];
  let next = 0;
  // Iterative Tarjan: call graphs of a few thousand functions can be deep.
  for (const start of g.edges.keys()) {
    if (index.has(start)) continue;
    const work: { n: string; it: Iterator<string> }[] = [{ n: start, it: (g.edges.get(start) ?? []).values() }];
    index.set(start, next); low.set(start, next); next++; stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const step = top.it.next();
      if (!step.done) {
        const m = step.value;
        if (!g.edges.has(m)) continue;
        if (!index.has(m)) { index.set(m, next); low.set(m, next); next++; stack.push(m); onStack.add(m); work.push({ n: m, it: g.edges.get(m)!.values() }); }
        else if (onStack.has(m)) low.set(top.n, Math.min(low.get(top.n)!, index.get(m)!));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].n; low.set(p, Math.min(low.get(p)!, low.get(top.n)!)); }
        if (low.get(top.n) === index.get(top.n)) {
          const comp: string[] = [];
          for (let w: string; ; ) { w = stack.pop()!; onStack.delete(w); comp.push(w); if (w === top.n) break; }
          if (comp.length > 1 || g.edges.get(top.n)!.has(top.n)) out.push(comp.reverse());
        }
      }
    }
  }
  return out;
}

function allowed(sym: string, level: SafetyLevel): boolean {
  if (CORE_ALLOW.has(sym) || LIBM_ALLOW.has(sym) || HELPER_ALLOW.test(sym)) return true;
  return !objectPolicy(level).noDynamicAllocation && HOSTED_ALLOW.test(sym);
}

/** The runtime symbols the program reaches or imports that the profile's allowlist rejects. */
export function disallowedSymbols(g: ObjectGraph, level: SafetyLevel): string[] {
  const used = new Set<string>(g.undefinedSyms);
  for (const s of SHIM_DEFINED) if (g.defined.has(s) && pathTo(g, n => n === s)) used.add(s);
  return [...used].filter(s => !allowed(s, level)).sort();
}

export function checkObject(g: ObjectGraph, level: SafetyLevel): ObjectViolation[] {
  const pol = objectPolicy(level);
  const v: ObjectViolation[] = [];
  if (pol.noDynamicAllocation) {
    for (const f of allocationFindings(g)) {
      v.push({ check: "allocation", message: `${f.viaRuntime ? "runtime" : "program"} allocation: ${f.path.join(" -> ")}` });
    }
  }
  if (pol.noRecursion) {
    for (const c of cycles(g)) v.push({ check: "recursion", message: `call cycle: ${c.join(" -> ")} -> ${c[0]}` });
  }
  if (pol.noUnknownCallTargets) {
    for (const [f, n] of [...g.indirect].sort()) {
      if (pathTo(g, s => s === f)) v.push({ check: "indirect-call", message: `${f}: ${n} indirect call${n > 1 ? "s" : ""}, target unknown` });
    }
  }
  for (const s of disallowedSymbols(g, level)) v.push({ check: "allowlist", message: `runtime symbol not on the ${level} allowlist: ${s}` });
  return v;
}
