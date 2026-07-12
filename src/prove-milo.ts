// Milo-native proof engine: discharge verification conditions with std/smt (a
// QF_LIA decision procedure written in Milo) instead of z3. Each VC's SMT-LIB is
// parsed into a linear boolean formula and serialized to the integer DSL that
// tools/smtSolve.milo reads on stdin; that solver is compiled once to a cached
// native binary and reused, so obligations are discharged by a native Milo
// binary — no per-proof compile, no external solver. VCs outside the linear
// fragment fall to "unknown", exactly where z3 gives up on theories std/smt
// doesn't model.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { VerifyResult, ProveResult, SolverResult } from "./verify";

// ---- S-expression parser ----

type Sexp = string | Sexp[];

function tokenize(src: string): string[] {
  // strip comment lines, then split on parens / whitespace
  const noComments = src.split("\n").filter(l => !l.trimStart().startsWith(";")).join("\n");
  const toks: string[] = [];
  let i = 0;
  while (i < noComments.length) {
    const ch = noComments[i];
    if (ch === "(" || ch === ")") { toks.push(ch); i++; }
    else if (/\s/.test(ch)) { i++; }
    else {
      let j = i;
      while (j < noComments.length && !/[\s()]/.test(noComments[j])) j++;
      toks.push(noComments.slice(i, j));
      i = j;
    }
  }
  return toks;
}

function parseAll(toks: string[]): Sexp[] {
  let pos = 0;
  function parse(): Sexp {
    if (toks[pos] === "(") {
      pos++;
      const list: Sexp[] = [];
      while (toks[pos] !== ")") {
        if (pos >= toks.length) throw new Error("unbalanced sexpr");
        list.push(parse());
      }
      pos++;
      return list;
    }
    return toks[pos++];
  }
  const out: Sexp[] = [];
  while (pos < toks.length) out.push(parse());
  return out;
}

// ---- linearization ----

// A linear term  sum(coeffs[var]*var) + konst.
interface Lin { coeffs: Map<string, number>; konst: number; }

function addLin(a: Lin, b: Lin, scale: number): Lin {
  const coeffs = new Map(a.coeffs);
  for (const [k, v] of b.coeffs) coeffs.set(k, (coeffs.get(k) ?? 0) + v * scale);
  return { coeffs, konst: a.konst + b.konst * scale };
}

// Parse an arithmetic S-expr into a linear term, or null if nonlinear.
function linTerm(e: Sexp, vars: Set<string>): Lin | null {
  if (typeof e === "string") {
    if (/^-?\d+$/.test(e)) return { coeffs: new Map(), konst: parseInt(e, 10) };
    if (vars.has(e)) return { coeffs: new Map([[e, 1]]), konst: 0 };
    return null;
  }
  const head = e[0];
  if (head === "+") {
    let acc: Lin = { coeffs: new Map(), konst: 0 };
    for (let i = 1; i < e.length; i++) {
      const t = linTerm(e[i], vars); if (!t) return null;
      acc = addLin(acc, t, 1);
    }
    return acc;
  }
  if (head === "-") {
    const first = linTerm(e[1], vars); if (!first) return null;
    if (e.length === 2) return addLin({ coeffs: new Map(), konst: 0 }, first, -1);
    let acc = first;
    for (let i = 2; i < e.length; i++) {
      const t = linTerm(e[i], vars); if (!t) return null;
      acc = addLin(acc, t, -1);
    }
    return acc;
  }
  if (head === "*") {
    // product is linear only if at most one factor carries a variable
    let coeffProduct = 1;
    let varFactor: Lin | null = null;
    for (let i = 1; i < e.length; i++) {
      const t = linTerm(e[i], vars); if (!t) return null;
      if (t.coeffs.size === 0) {
        coeffProduct *= t.konst;
      } else {
        if (varFactor) return null; // var * var → nonlinear
        varFactor = t;
      }
    }
    if (!varFactor) return { coeffs: new Map(), konst: coeffProduct };
    const coeffs = new Map<string, number>();
    for (const [k, v] of varFactor.coeffs) coeffs.set(k, v * coeffProduct);
    return { coeffs, konst: varFactor.konst * coeffProduct };
  }
  return null; // div, mod, unknown → punt
}

// Boolean formula over linear atoms.
type FNode =
  | { op: "true" } | { op: "false" }
  | { op: "and" | "or"; ks: FNode[] }
  | { op: "not"; k: FNode }
  | { op: "atom"; lin: Lin; strict: boolean }; // asserts lin <op> 0

// atom for  (L <op> 0)  from the difference a - b.
function cmpAtom(a: Sexp, b: Sexp, vars: Set<string>, strict: boolean, flip: boolean): FNode | null {
  const la = linTerm(a, vars), lb = linTerm(b, vars);
  if (!la || !lb) return null;
  const diff = flip ? addLin(lb, la, -1) : addLin(la, lb, -1);
  return { op: "atom", lin: diff, strict };
}

function linFormula(e: Sexp, vars: Set<string>): FNode | null {
  if (typeof e === "string") {
    if (e === "true") return { op: "true" };
    if (e === "false") return { op: "false" };
    return null;
  }
  const head = e[0];
  if (head === "and" || head === "or") {
    const ks: FNode[] = [];
    for (let i = 1; i < e.length; i++) { const f = linFormula(e[i], vars); if (!f) return null; ks.push(f); }
    return { op: head, ks };
  }
  if (head === "not") { const k = linFormula(e[1], vars); return k ? { op: "not", k } : null; }
  if (head === "=>") {
    const a = linFormula(e[1], vars), b = linFormula(e[2], vars);
    return a && b ? { op: "or", ks: [{ op: "not", k: a }, b] } : null;
  }
  if (head === "<=") return cmpAtom(e[1], e[2], vars, false, false);
  if (head === "<") return cmpAtom(e[1], e[2], vars, true, false);
  if (head === ">=") return cmpAtom(e[1], e[2], vars, false, true);
  if (head === ">") return cmpAtom(e[1], e[2], vars, true, true);
  if (head === "=") {
    const le1 = cmpAtom(e[1], e[2], vars, false, false);
    const le2 = cmpAtom(e[1], e[2], vars, false, true);
    return le1 && le2 ? { op: "and", ks: [le1, le2] } : null;
  }
  if (head === "distinct") {
    const lt1 = cmpAtom(e[1], e[2], vars, true, false);
    const lt2 = cmpAtom(e[1], e[2], vars, true, true);
    return lt1 && lt2 ? { op: "or", ks: [lt1, lt2] } : null;
  }
  return null;
}

// Parse one VC's SMT-LIB into (ordered vars, root formula), or null if any part
// is outside the linear fragment.
function vcToFormula(smtlib: string): { vars: string[]; root: FNode } | null {
  let forms: Sexp[];
  try { forms = parseAll(tokenize(smtlib)); } catch { return null; }
  const vars: string[] = [];
  const varSet = new Set<string>();
  const asserts: Sexp[] = [];
  for (const f of forms) {
    if (!Array.isArray(f)) continue;
    if (f[0] === "declare-const" && typeof f[1] === "string") { vars.push(f[1]); varSet.add(f[1]); }
    else if (f[0] === "assert") asserts.push(f[1]);
  }
  const ks: FNode[] = [];
  for (const a of asserts) { const fn = linFormula(a, varSet); if (!fn) return null; ks.push(fn); }
  const root: FNode = ks.length === 1 ? ks[0] : { op: "and", ks };
  return { vars, root };
}

// ---- DSL serialization (see tools/smtSolve.milo for the grammar) ----

interface SNode { kind: 0 | 1 | 2 | 3; atom?: number; kids?: number[]; }

// Flatten a formula into (atoms, nodes) in creation order — children before
// parents, matching how std/smt assigns node indices. Returns the root index.
function serialize(f: FNode, idx: Map<string, number>, nvars: number, atoms: string[], nodes: SNode[]): number {
  if (f.op === "true") { nodes.push({ kind: 2, kids: [] }); return nodes.length - 1; }
  if (f.op === "false") { nodes.push({ kind: 3, kids: [] }); return nodes.length - 1; }
  if (f.op === "atom") {
    const row = new Array(nvars).fill(0);
    for (const [k, v] of f.lin.coeffs) row[idx.get(k)!] = v;
    const ai = atoms.length;
    atoms.push(`${f.strict ? 1 : 0} ${row.join(" ")} ${f.lin.konst}`);
    nodes.push({ kind: 0, atom: ai });
    return nodes.length - 1;
  }
  if (f.op === "not") {
    const c = serialize(f.k, idx, nvars, atoms, nodes);
    nodes.push({ kind: 1, kids: [c] });
    return nodes.length - 1;
  }
  const kids = f.ks.map(k => serialize(k, idx, nvars, atoms, nodes));
  nodes.push({ kind: f.op === "and" ? 2 : 3, kids });
  return nodes.length - 1;
}

function encodeProblem(vars: string[], root: FNode): string {
  const idx = new Map<string, number>();
  vars.forEach((v, i) => idx.set(v, i));
  const atoms: string[] = [];
  const nodes: SNode[] = [];
  const rootIdx = serialize(root, idx, vars.length, atoms, nodes);
  const lines = [`${vars.length} ${atoms.length}`, ...atoms, `${nodes.length}`];
  for (const n of nodes) {
    if (n.kind === 0) lines.push(`0 ${n.atom}`);
    else if (n.kind === 1) lines.push(`1 ${n.kids![0]}`);
    else lines.push(`${n.kind} ${n.kids!.length} ${n.kids!.join(" ")}`);
  }
  lines.push(`${rootIdx}`);
  return lines.join("\n");
}

// ---- cached native solver binary ----

function newestMtime(...paths: string[]): number {
  return Math.max(...paths.map(p => { try { return statSync(p).mtimeMs; } catch { return 0; } }));
}

// Build tools/smtSolve.milo once and cache the binary, rebuilding only when the
// solver or std/smt sources change. Returns the binary path, or null on failure.
function ensureSolverBinary(): string | null {
  const root = join(import.meta.dir, "..");
  const solverSrc = join(root, "tools", "smtSolve.milo");
  const smtLib = join(root, "std", "smt.milo");
  const cacheDir = join(tmpdir(), "milo-smt-cache");
  mkdirSync(cacheDir, { recursive: true });
  const bin = join(cacheDir, "smtSolve");

  if (existsSync(bin) && statSync(bin).mtimeMs >= newestMtime(solverSrc, smtLib)) return bin;

  const mainTs = join(import.meta.dir, "main.ts");
  for (let attempt = 0; attempt < 4; attempt++) {
    const b = spawnSync("bun", ["run", mainTs, "build", solverSrc, "-o", bin], { encoding: "utf-8", timeout: 120000 });
    if (b.status === 0 && existsSync(bin)) return bin;
    if (!/memory pressure/.test((b.stderr ?? "") + (b.stdout ?? ""))) break; // real error, don't retry
  }
  return null;
}

// Render a witness (values in variable-declaration order) as the failing input,
// e.g. "counterexample: value = -1, result = -1".
function counterexampleDetail(vars: string[], witness: number[]): string {
  if (!witness.length || witness.length !== vars.length) return "counterexample exists";
  return "counterexample: " + vars.map((name, j) => `${name} = ${witness[j]}`).join(", ");
}

// Discharge all VCs via std/smt. Mirrors proveWithZ3's ProveResult shape.
export function proveWithMilo(result: VerifyResult): ProveResult {
  const results: SolverResult[] = new Array(result.conditions.length);
  const prepared: { index: number; vars: string[]; root: FNode }[] = [];

  result.conditions.forEach((vc, i) => {
    const f = vcToFormula(vc.smtlib);
    if (!f) {
      results[i] = { vc, status: "unknown", detail: "outside linear fragment (std/smt)" };
    } else {
      prepared.push({ index: i, vars: f.vars, root: f.root });
    }
  });

  if (prepared.length > 0) {
    const bin = ensureSolverBinary();
    if (!bin) {
      for (const p of prepared) results[p.index] = { vc: result.conditions[p.index], status: "error", detail: "could not build std/smt solver binary" };
    } else {
      // One problem per prepared VC, in order; smtSolve prints "<k> <verdict>".
      const dsl = [`${prepared.length}`, ...prepared.map(p => encodeProblem(p.vars, p.root))].join("\n") + "\n";
      const proc = spawnSync(bin, [], { input: dsl, encoding: "utf-8", timeout: 60000 });
      // "<k> proven" | "<k> unknown" | "<k> violated <w0> <w1> ..." (witness in
      // variable-declaration order).
      const verdicts = new Map<number, { verdict: string; witness: number[] }>();
      for (const line of (proc.stdout ?? "").split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(proven|violated|unknown)(.*)$/);
        if (m) verdicts.set(parseInt(m[1], 10), {
          verdict: m[2],
          witness: m[3].trim() ? m[3].trim().split(/\s+/).map(Number) : [],
        });
      }
      prepared.forEach((p, k) => {
        const vc = result.conditions[p.index];
        const v = verdicts.get(k);
        if (v?.verdict === "proven") results[p.index] = { vc, status: "proven" };
        else if (v?.verdict === "violated") results[p.index] = { vc, status: "failed", detail: counterexampleDetail(p.vars, v.witness) };
        else if (v?.verdict === "unknown") results[p.index] = { vc, status: "unknown", detail: "no integer witness (rational-only)" };
        else results[p.index] = { vc, status: "error", detail: (proc.stderr || "std/smt solver produced no verdict").split("\n")[0] };
      });
    }
  }

  return {
    results,
    proven: results.filter(r => r.status === "proven").length,
    failed: results.filter(r => r.status === "failed").length,
    unknown: results.filter(r => r.status === "unknown").length,
    errors: results.filter(r => r.status === "error").length,
  };
}
