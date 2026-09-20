// Milo-native proof engine: discharge verification conditions with std/smt (a
// QF_LIA decision procedure written in Milo) instead of z3. Each VC's SMT-LIB is
// parsed into a linear boolean formula and serialized to the integer DSL that
// tools/smtSolve.milo reads on stdin; that solver is compiled once to a cached
// native binary and reused, so obligations are discharged by a native Milo
// binary — no per-proof compile, no external solver. VCs outside the linear
// fragment fall to "unknown", exactly where z3 gives up on theories std/smt
// doesn't model.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { VerifyResult, ProveResult, SolverResult } from "./verify";
import { untranslatable, untranslatableDetail, unreproducibleCounterexample } from "./verify";
import { must } from "./must";

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
    // A decimal literal stays a fraction all the way through; serialize() clears the
    // denominators per atom, which is exact because scaling an inequality by a positive
    // constant preserves its solution set.
    if (/^-?\d+\.\d+$/.test(e)) return { coeffs: new Map(), konst: parseFloat(e) };
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
  // An i64 widened to a float is the same number, so the cast is transparent to the linear
  // form — and the variable keeps its Int declaration, so integer tightening still applies
  // to any row that mentions only it.
  if (head === "to_real" && e.length === 2) return linTerm(e[1], vars);
  // Real division by a constant is multiplication by its reciprocal, which stays linear.
  // Integer `div` is not, and is deliberately still rejected below.
  if (head === "/" && e.length === 3) {
    const num = linTerm(e[1], vars), den = linTerm(e[2], vars);
    if (!num || !den || den.coeffs.size !== 0 || den.konst === 0) return null;
    const coeffs = new Map<string, number>();
    for (const [k, v] of num.coeffs) coeffs.set(k, v / den.konst);
    return { coeffs, konst: num.konst / den.konst };
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
function vcToFormula(smtlib: string): { vars: string[]; isInt: boolean[]; root: FNode } | null {
  let forms: Sexp[];
  try { forms = parseAll(tokenize(smtlib)); } catch { return null; }
  const vars: string[] = [];
  const isInt: boolean[] = [];
  const varSet = new Set<string>();
  const asserts: Sexp[] = [];
  for (const f of forms) {
    if (!Array.isArray(f)) continue;
    // The declared SORT has to travel with the variable: std/smt's integer tightenings are
    // a false proof when applied to a `Real`, so anything that is not `Int` is passed
    // through as real-valued. Bool consts never reach a linear atom (linFormula rejects a
    // bare symbol), so their flag is irrelevant either way.
    if (f[0] === "declare-const" && typeof f[1] === "string") {
      vars.push(f[1]);
      isInt.push(f[2] === "Int");
      varSet.add(f[1]);
    }
    else if (f[0] === "assert") asserts.push(f[1]);
  }
  const ks: FNode[] = [];
  for (const a of asserts) { const fn = linFormula(a, varSet); if (!fn) return null; ks.push(fn); }
  const root: FNode = ks.length === 1 ? ks[0] : { op: "and", ks };
  return { vars, isInt, root };
}

// ---- DSL serialization (see tools/smtSolve.milo for the grammar) ----

interface SNode { kind: 0 | 1 | 2 | 3; atom?: number; kids?: number[]; }

// std/smt rows are i64. A row that came from float literals is rational, so clear the
// denominators by scaling the whole atom — valid for any inequality because the multiplier
// is positive, and it leaves integer rows untouched (d = 0). Null when no power of ten
// lands every value on an integer inside i64, so the VC degrades to `unknown` rather than
// being decided from a rounded-off row.
const SCALE_LIMIT = 2 ** 53;

function scaleToIntegers(values: number[]): number[] | null {
  // An already-integer row goes through untouched. It must not meet the 2^53 ceiling
  // below: rows built from i64 bounds legitimately reach 2^62, and std/smt has its own
  // overflow guard for what happens to them during elimination.
  if (values.every(Number.isInteger)) return values;
  for (let d = 1, mul = 10; d <= 12; d++, mul *= 10) {
    const scaled = values.map(v => v * mul);
    if (scaled.some(v => !Number.isFinite(v) || Math.abs(v) > SCALE_LIMIT)) return null;
    // Tolerance is relative: 0.1 * 10 is 1.0000000000000002 in binary floating point, and
    // demanding exactness here would reject the most ordinary literal there is.
    if (scaled.every(v => Math.abs(v - Math.round(v)) <= 1e-9 * Math.max(1, Math.abs(v)))) {
      return scaled.map(Math.round);
    }
  }
  return null;
}

// Thrown out of serialize() when an atom has no integer scaling; caught in encodeProblem.
class UnscalableAtom extends Error {}

// Flatten a formula into (atoms, nodes) in creation order — children before
// parents, matching how std/smt assigns node indices. Returns the root index.
function serialize(f: FNode, idx: Map<string, number>, nvars: number, atoms: string[], nodes: SNode[]): number {
  if (f.op === "true") { nodes.push({ kind: 2, kids: [] }); return nodes.length - 1; }
  if (f.op === "false") { nodes.push({ kind: 3, kids: [] }); return nodes.length - 1; }
  if (f.op === "atom") {
    const row = new Array(nvars).fill(0);
    for (const [k, v] of f.lin.coeffs) row[must(idx, k, "idx")] = v;
    const scaled = scaleToIntegers([...row, f.lin.konst]);
    if (!scaled) throw new UnscalableAtom();
    const ai = atoms.length;
    atoms.push(`${f.strict ? 1 : 0} ${scaled.slice(0, nvars).join(" ")} ${scaled[nvars]}`);
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

function encodeProblem(vars: string[], isInt: boolean[], root: FNode): string | null {
  const idx = new Map<string, number>();
  vars.forEach((v, i) => idx.set(v, i));
  const atoms: string[] = [];
  const nodes: SNode[] = [];
  let rootIdx: number;
  try {
    rootIdx = serialize(root, idx, vars.length, atoms, nodes);
  } catch (e) {
    if (e instanceof UnscalableAtom) return null;
    throw e;
  }
  const lines = [`${vars.length} ${atoms.length}`, vars.map((_, i) => isInt[i] ? 1 : 0).join(" "), ...atoms, `${nodes.length}`];
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
  // In a `bun build --compile` binary, import.meta.dir points into the virtual
  // bundle (no tools/ or std/ on disk); MILO_ROOT, which callers/tests already
  // set for import resolution, is the real on-disk repo root.
  const root = process.env.MILO_ROOT ?? join(import.meta.dir, "..");
  const solverSrc = join(root, "tools", "smtSolve.milo");
  const smtLib = join(root, "std", "smt.milo");
  const cacheDir = join(tmpdir(), "milo-smt-cache");
  mkdirSync(cacheDir, { recursive: true });
  const bin = join(cacheDir, "smtSolve");

  const fresh = () => existsSync(bin) && statSync(bin).mtimeMs >= newestMtime(solverSrc, smtLib);
  if (fresh()) return bin;

  // Re-invoke the `build` subcommand. Non-compiled: process.execPath is bun, so
  // pass the CLI entry (src/main.ts). Compiled: process.execPath is the milo
  // binary itself, which dispatches `build` directly — its main.ts lives only in
  // bun's virtual FS ($bunfs), so it can't be passed as a script. The old
  // `bun run <import.meta.dir>/main.ts` broke under --compile: that virtual path
  // ran nothing, so the solver never built on a cold cache (e.g. CI).
  const mainTs = join(import.meta.dir, "main.ts");
  const compiled = import.meta.dir.startsWith("/$bunfs") || !existsSync(mainTs);
  const prefix = compiled ? [] : [mainTs];
  // Build to a pid-unique temp then atomically rename into place. `bun test` runs
  // prove.test.ts and verify-contracts.test.ts (both solver consumers) in parallel;
  // on a cold cache they'd otherwise race to write the same `bin` and hand each other
  // a half-written binary → spurious "no verdict"/translator errors.
  const tmpBin = `${bin}.${process.pid}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const b = spawnSync(process.execPath, [...prefix, "build", solverSrc, "-o", tmpBin], { encoding: "utf-8", timeout: 120000 });
    if (b.status === 0 && existsSync(tmpBin)) { renameSync(tmpBin, bin); return bin; }
    if (fresh()) return bin; // a concurrent builder finished ours while we were building
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
  let prepared: { index: number; vars: string[]; isInt: boolean[]; root: FNode }[] = [];

  result.conditions.forEach((vc, i) => {
    // "outside linear fragment" is the catch-all for anything the parser rejects, which
    // includes translator markers — reporting nonlinearity for a linear contract. Name the
    // real cause when there is one.
    const cant = untranslatable(vc.smtlib);
    const f = cant.length ? null : vcToFormula(vc.smtlib);
    if (!f) {
      results[i] = { vc, status: "unknown", detail: cant.length ? untranslatableDetail(cant) : "outside linear fragment (std/smt)" };
    } else {
      prepared.push({ index: i, vars: f.vars, isInt: f.isInt, root: f.root });
    }
  });

  if (prepared.length > 0) {
    const bin = ensureSolverBinary();
    if (!bin) {
      for (const p of prepared) results[p.index] = { vc: result.conditions[p.index], status: "error", detail: "could not build std/smt solver binary" };
    } else {
      // Encoding can still fail on a rational row no power of ten fits into i64; drop
      // those to `unknown` before numbering the problems, so the verdict indices the
      // solver prints still line up with what was sent.
      const encoded = prepared.map(p => ({ p, dsl: encodeProblem(p.vars, p.isInt, p.root) }));
      for (const { p, dsl } of encoded) {
        if (dsl === null) results[p.index] = { vc: result.conditions[p.index], status: "unknown", detail: "rational coefficients outside i64 (std/smt)" };
      }
      prepared = encoded.filter(e => e.dsl !== null).map(e => e.p);
      // One problem per prepared VC, in order; smtSolve prints "<k> <verdict>".
      const dsl = [`${prepared.length}`, ...encoded.filter(e => e.dsl !== null).map(e => e.dsl)].join("\n") + "\n";
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
        // A counterexample that leans on a value nothing constrains (an invented call
        // result, a contract-less havoc) is not reproducible: the solver chose a state the
        // program may never reach. Report what is actually known instead of a refutation
        // nobody can act on (see `opaqueCalls` / `unconstrainedHavocs`).
        else if (v?.verdict === "violated" && unreproducibleCounterexample(vc)) {
          results[p.index] = { vc, status: "unknown", detail: unreproducibleCounterexample(vc)! };
        }
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
