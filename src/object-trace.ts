// Source-to-object traceability (docs/plans/object-level-assurance.md step 2, DO-178C 6.4.4.2b).
// `milo trace-object <binary>` maps every instruction of a binary built with -g to the line it
// came from, the @req of the function that owns that line, and, for compiler-generated
// constructs, a MILO-O rule ID. `milo trace <entry> --object <binary>` adds the ranges to each
// requirement.
//
// Sources, all read from the linked image with milo-opt's LLVM tools:
//   - llvm-objdump -d: functions, instructions and direct call targets;
//   - llvm-dwarfdump --debug-line: the line table (a Mach-O image keeps it in <bin>.dSYM);
//   - the program's @req data (src/requirements.ts), by file and line.
//
// Rule tags come from the object, not from the MLIR: a bounds check, overflow trap, contract
// check or drop ends in a call to a runtime routine (__milo_bounds_fail, __milo_overflow_fail,
// free, ...) that no optimizer level removes while the check exists, so the line-table row
// holding that call is tagged. A location tag carried through the MLIR passes would need a
// DWARF attribute LLVM's line table has no slot for (it keeps file, line, column, discriminator
// only). Limit: the compare and branch that feed the call sit in other rows (usually the
// source line's own) and are reported as that line, not as the rule.
//
// The line table of a linked image can carry sequences of discarded sections (their addresses
// restart at 0 and overlap live code). A sequence counts only when it starts exactly at a
// function's address.
import { existsSync } from "fs";
import { basename, isAbsolute, resolve } from "path";
import { isMachO, machoStubs, norm, run, tool } from "./object-checks";

export const OBJECT_RULES: Record<string, string> = {
  "MILO-O-boundsCheck": "array/Vec/string index compared with its length, failing into __milo_bounds_fail",
  "MILO-O-overflowTrap": "checked integer arithmetic or cast, failing into __milo_overflow_fail",
  "MILO-O-contractCheck": "requires/ensures/invariant clause checked at run time, failing into __milo_contract_fail",
  "MILO-O-panic": "explicit or generated panic path (__milo_mlir_panic)",
  "MILO-O-drop": "release of an owned value: a free or a drop-glue call",
};

const TRAP_TARGETS: [RegExp, string][] = [
  [/^_*milo_bounds_fail$/, "MILO-O-boundsCheck"],
  [/^_*milo_overflow_fail$/, "MILO-O-overflowTrap"],
  [/^_*milo_contract_fail$/, "MILO-O-contractCheck"],
  [/^_*milo_mlir_panic(_v)?$/, "MILO-O-panic"],
  [/^(free|rtStrFree|rtStrRelease|rtStringDrop|_*milo_drop\w*|\w*\$?drop_glue\w*)$/, "MILO-O-drop"],
];

// Code that is not the program: the startup/semihosting shim (tools/cortex-m/startup.c), libc
// shims and the process scaffold. It has no line table by design; reported apart, not gated.
const RUNTIME_FN = /^(_*milo|\.Lmilo|__)|^(Reset_Handler|exit|_exit|printf|semihost\w*|print_exit_code|_start|start|malloc|calloc|realloc|free|mem\w+|str\w+|abort)$|^_*(replay|scheduler)/;

export interface FnSite { name: string; file: string; line: number; ids: string[] }

export interface ObjRange {
  start: number;
  end: number;
  /** The row's file and line; line 0 is "no source line" (compiler glue). */
  file: string;
  line: number;
  /** Function that owns the line, from the program's declarations. */
  owner?: string;
  reqs: string[];
  rules: string[];
  /** The row had line 0: the range is reported under the line before it. */
  inferred?: true;
}

export interface ObjFn {
  name: string;
  start: number;
  end: number;
  runtime: boolean;
  ranges: ObjRange[];
}

export interface ObjectTrace {
  binary: string;
  functions: ObjFn[];
  /** Bytes of program code (runtime excluded) and how many map to a source line or a rule. */
  totalBytes: number;
  coveredBytes: number;
  /** Of coveredBytes: bytes whose row had line 0 and were put under the line before them. */
  inferredBytes: number;
  runtimeBytes: number;
  untraced: (ObjRange & { fn: string })[];
}

// The most an assembler pads a function to the next boundary.
const MAX_PADDING = 15;

interface Insn { addr: number; call?: string }
interface CodeFn { name: string; start: number; end: number; insns: Insn[] }
interface Row { addr: number; line: number; file: string; end: boolean }

function disassemble(path: string): CodeFn[] {
  const macho = isMachO(path);
  const stubs = macho ? machoStubs(path) : new Map<number, string>();
  // Section extents bound the last function of each section.
  const sectionEnd = new Map<string, number>();
  for (const l of run(tool("llvm-objdump"), ["-h", path]).split("\n")) {
    const m = /^\s*\d+\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s/.exec(l);
    if (m) sectionEnd.set(m[1]!, parseInt(m[3]!, 16) + parseInt(m[2]!, 16));
  }
  const fns: CodeFn[] = [];
  let cur: CodeFn | null = null;
  let secEnd = 0;
  let skip = false;
  const close = (end: number) => { if (cur) { cur.end = end; cur = null; } };
  for (const line of run(tool("llvm-objdump"), ["-d", "--no-show-raw-insn", path]).split("\n")) {
    if (line.startsWith("Disassembly of section")) {
      close(secEnd);
      const sec = line.replace(/^Disassembly of section /, "").replace(/:$/, "").split(",").pop()!;
      skip = /stubs|\.plt/.test(sec);
      secEnd = sectionEnd.get(sec) ?? 0;
      continue;
    }
    const label = /^([0-9a-f]+) <(.+)>:$/.exec(line);
    if (label) {
      const addr = parseInt(label[1]!, 16);
      close(addr);
      if (!skip) { cur = { name: norm(label[2]!, macho), start: addr, end: addr, insns: [] }; fns.push(cur); }
      continue;
    }
    if (!cur) continue;
    const ins = /^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$/.exec(line);
    if (!ins) continue;
    const [, a, mnem, ops] = ins;
    const insn: Insn = { addr: parseInt(a!, 16) };
    if (/^(bl|blx|call\w*|b|b\.\w+|jmp\w*|j\w+)$/.test(mnem!)) {
      const t = /(0x[0-9a-f]+)\s*<([^>]+)>/.exec(ops!);
      if (t) insn.call = norm(stubs.get(parseInt(t[1]!, 16)) ?? t[2]!.replace(/\+0x[0-9a-f]+$/, ""), macho);
    }
    cur.insns.push(insn);
  }
  close(secEnd);
  return fns.filter(f => f.insns.length > 0);
}

function dwarfPath(path: string): string {
  return isMachO(path) && existsSync(`${path}.dSYM`) ? `${path}.dSYM` : path;
}

/** The source file the binary was compiled from (its compile unit's name), or null. */
export function entryOfBinary(path: string): string | null {
  const info = run(tool("llvm-dwarfdump"), ["--debug-info", dwarfPath(path)]);
  const name = /DW_AT_name\s+\("([^"]*\.milo)"\)/.exec(info)?.[1];
  if (!name) return null;
  return isAbsolute(name) ? name : resolve(/DW_AT_comp_dir\s+\("([^"]*)"\)/.exec(info)?.[1] ?? "", name);
}

/** The line-table sequences of `path`'s DWARF (a Mach-O image's lives in its .dSYM). */
function lineSequences(path: string): Row[][] {
  const dwarf = dwarfPath(path);
  const info = run(tool("llvm-dwarfdump"), ["--debug-info", dwarf]);
  const compDir = /DW_AT_comp_dir\s+\("([^"]*)"\)/.exec(info)?.[1] ?? "";
  const out: Row[][] = [];
  let dirs: string[] = [];
  let files = new Map<number, string>();
  let seq: Row[] = [];
  let pending: { idx: number; name?: string } | null = null;
  const flushFile = () => {
    if (!pending?.name) return;
    const m = /^(\d+)\|(.*)$/.exec(pending.name)!;
    const d = Number(m[1]);
    const name = m[2]!;
    files.set(pending.idx, isAbsolute(name) ? name : resolve(d === 0 ? compDir : dirs[d] ?? compDir, name));
  };
  for (const l of run(tool("llvm-dwarfdump"), ["--debug-line", dwarf]).split("\n")) {
    if (l.startsWith("debug_line[")) { flushFile(); pending = null; dirs = []; files = new Map(); seq = []; continue; }
    let m = /^include_directories\[\s*(\d+)\]\s*=\s*"(.*)"/.exec(l);
    if (m) { dirs[Number(m[1])] = m[2]!; continue; }
    m = /^file_names\[\s*(\d+)\]:/.exec(l);
    if (m) { flushFile(); pending = { idx: Number(m[1]) }; continue; }
    m = /^\s+name:\s+"(.*)"/.exec(l);
    if (m && pending) { pending.name = `0|${m[1]}`; continue; }
    m = /^\s+dir_index:\s+(\d+)/.exec(l);
    if (m && pending?.name) { pending.name = `${m[1]}|${pending.name.slice(2)}`; continue; }
    m = /^0x([0-9a-f]+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s*(.*)$/.exec(l);
    if (m) {
      if (pending) { flushFile(); pending = null; }
      const end = m[4]!.includes("end_sequence");
      seq.push({ addr: parseInt(m[1]!, 16), line: Number(m[2]), file: files.get(Number(m[3])) ?? "?", end });
      if (end) { out.push(seq); seq = []; }
    }
  }
  return out;
}

const bytes = (r: { start: number; end: number }) => r.end - r.start;

export function traceObject(binary: string, sites: FnSite[]): ObjectTrace {
  const code = disassemble(binary);
  const byStart = new Map(code.map(f => [f.start, f]));
  // ELF: only a sequence that starts at a function's address is live (see the header).
  // Mach-O: dsymutil has already dropped the dead ones and emits one sequence over many
  // functions, so every sequence is live and a function takes the one that contains it.
  const macho = isMachO(binary);
  const all = lineSequences(binary);
  const seqs = new Map<number, Row[]>();
  if (!macho) for (const s of all) if (byStart.has(s[0]!.addr) && !seqs.has(s[0]!.addr)) seqs.set(s[0]!.addr, s);
  const seqOf = (f: CodeFn): Row[] | undefined =>
    macho ? all.find(s => s[0]!.addr <= f.start && f.start < s[s.length - 1]!.addr) : seqs.get(f.start);

  // Line -> owning function: the declaration at or before the line, in the same file.
  const decls = new Map<string, FnSite[]>();
  for (const s of sites) { const k = resolve(s.file); (decls.get(k) ?? decls.set(k, []).get(k)!).push(s); }
  for (const l of decls.values()) l.sort((a, b) => a.line - b.line);
  const ownerOf = (file: string, line: number): FnSite | undefined => {
    const l = decls.get(file);
    if (!l || line === 0) return undefined;
    let best: FnSite | undefined;
    for (const d of l) if (d.line <= line) best = d; else break;
    return best;
  };

  const functions: ObjFn[] = [];
  const untraced: ObjectTrace["untraced"] = [];
  let total = 0, covered = 0, inferredBytes = 0, runtimeBytes = 0;
  for (const f of code) {
    const seq = seqOf(f);
    const runtime = !seq && RUNTIME_FN.test(f.name);
    const fn: ObjFn = { name: f.name, start: f.start, end: f.end, runtime, ranges: [] };
    functions.push(fn);
    // Each instruction's row; a row that holds a trap/drop call tags every instruction of the row.
    const rowOf = (a: number): number => {
      if (!seq) return -1;
      let lo = 0, hi = seq.length - 1, r = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (seq[mid]!.addr <= a) { r = mid; lo = mid + 1; } else hi = mid - 1; }
      return r < 0 || seq[r]!.end ? -1 : r;
    };
    const rows = f.insns.map(i => rowOf(i.addr));
    // An instruction outside every row tags only itself, never the other rowless ones.
    const rowKey = (k: number) => (rows[k]! >= 0 ? rows[k]! : -1 - k);
    const rulesOfRow = new Map<number, Set<string>>();
    f.insns.forEach((i, k) => {
      const rule = i.call && TRAP_TARGETS.find(([re]) => re.test(i.call!))?.[1];
      if (rule) (rulesOfRow.get(rowKey(k)) ?? rulesOfRow.set(rowKey(k), new Set()).get(rowKey(k))!).add(rule);
    });
    f.insns.forEach((i, k) => {
      const next = f.insns[k + 1]?.addr ?? f.end;
      const r = rows[k]!;
      const row = r >= 0 ? seq![r]! : undefined;
      // Alignment padding after the sequence's last row is not code.
      if (seq && !macho && i.addr >= seq[seq.length - 1]!.addr && f.end - seq[seq.length - 1]!.addr <= MAX_PADDING) return;
      const rules = [...(rulesOfRow.get(rowKey(k)) ?? [])].sort();
      let file = row?.file ?? "";
      let line = row?.line ?? 0;
      // Line 0 inside a function's line table is glue the lowering put between two source
      // lines (an index load, a constant argument). It takes the line before it, marked inferred.
      let inferred = false;
      const before = fn.ranges[fn.ranges.length - 1];
      if (line === 0 && row && before && before.line > 0) { file = before.file; line = before.line; inferred = true; }
      const own = ownerOf(file, line);
      const range: ObjRange = {
        start: i.addr, end: next, file, line, ...(own ? { owner: own.name } : {}),
        reqs: own ? [...new Set(own.ids)] : [], rules, ...(inferred ? { inferred } : {}),
      };
      if (before && before.end === range.start && before.file === file && before.line === line && before.rules.join() === rules.join() && !before.inferred === !inferred) before.end = range.end;
      else fn.ranges.push(range);
    });
    for (const r of fn.ranges) {
      if (runtime) { runtimeBytes += bytes(r); continue; }
      total += bytes(r);
      if (r.line > 0 || r.rules.length) { covered += bytes(r); if (r.inferred) inferredBytes += bytes(r); }
      else untraced.push({ ...r, fn: f.name });
    }
  }
  return { binary, functions, totalBytes: total, coveredBytes: covered, inferredBytes, runtimeBytes, untraced };
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** `only`: list just these functions (the totals still cover the whole binary). */
export function formatObjectTrace(t: ObjectTrace, strict: boolean, only?: string[]): string {
  const out: string[] = [`object trace: ${t.binary}`];
  for (const f of t.functions) {
    if (f.runtime || (only && !only.includes(f.name))) continue;
    const reqs = [...new Set(f.ranges.flatMap(r => r.reqs))];
    out.push("", `${f.name}  ${hex(f.start)}-${hex(f.end)} (${f.end - f.start} B)${reqs.length ? `  @req ${reqs.join(", ")}` : ""}`);
    for (const r of f.ranges) {
      const src = r.line > 0 ? `${r.inferred ? "~" : ""}${basename(r.file)}:${r.line}` : "no source line";
      const tags = [...r.reqs, ...r.rules].join(" ");
      out.push(`  ${hex(r.start)}-${hex(r.end)}  ${src.padEnd(24)}${tags}${r.line === 0 && !r.rules.length ? "UNTRACED" : ""}`);
    }
  }
  const pct = t.totalBytes ? (100 * t.coveredBytes) / t.totalBytes : 100;
  out.push("", `covered: ${t.coveredBytes}/${t.totalBytes} B of program code (${pct.toFixed(1)}%), ${t.inferredBytes} B of it "~" (line-table row 0, shown under the line before it); runtime (startup shim, not program code): ${t.runtimeBytes} B`);
  const byRule = new Map<string, number>();
  for (const f of t.functions) for (const r of f.ranges) for (const id of r.rules) byRule.set(id, (byRule.get(id) ?? 0) + bytes(r));
  for (const [id, n] of [...byRule].sort()) out.push(`  ${id}: ${n} B  (${OBJECT_RULES[id]})`);
  out.push(`untraced object code: ${t.untraced.length === 0 ? "none" : `${t.untraced.length} range${t.untraced.length === 1 ? "" : "s"}, ${t.untraced.reduce((n, r) => n + bytes(r), 0)} B`}`);
  for (const u of t.untraced) out.push(`  ${strict ? "error: " : ""}${hex(u.start)}-${hex(u.end)} in ${u.fn}: no source line and no rule`);
  return out.join("\n");
}
