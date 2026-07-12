// Milo-native proof engine: discharge verification conditions with std/smt (a
// QF_LIA decision procedure written in Milo) instead of z3. Each VC's SMT-LIB
// is parsed into a linear boolean formula, a Milo program is generated that
// rebuilds it through the std/smt builder API and calls decide(), and that
// program is compiled+run — so Milo's own compiler and prover discharge the
// obligation end to end. VCs outside the linear fragment fall to "unknown",
// exactly where z3 would give up on the theories std/smt doesn't model.
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
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

// ---- Milo program generation ----

function miloRow(lin: Lin, idx: Map<string, number>, nvars: number): string {
  const row = new Array(nvars).fill(0);
  for (const [k, v] of lin.coeffs) row[idx.get(k)!] = v;
  return `[${row.join(", ")}]`;
}

// Emit builder calls for a formula, returning the Milo variable holding its node
// index. `lines` accumulates statements; `ctr` hands out fresh names.
function emitNode(f: FNode, pv: string, idx: Map<string, number>, nvars: number, lines: string[], ctr: { n: number }): string {
  const fresh = () => `t${ctr.n++}`;
  if (f.op === "true") { const v = fresh(); lines.push(`    var ${v}k: Vec<i64> = []`); lines.push(`    let ${v} = nAnd(${pv}, ${v}k)`); return v; }
  if (f.op === "false") { const v = fresh(); lines.push(`    var ${v}k: Vec<i64> = []`); lines.push(`    let ${v} = nOr(${pv}, ${v}k)`); return v; }
  if (f.op === "atom") {
    const v = fresh();
    lines.push(`    let ${v} = nAtom(${pv}, addAtom(${pv}, ${miloRow(f.lin, idx, nvars)}, ${f.lin.konst}, ${f.strict ? "true" : "false"}))`);
    return v;
  }
  if (f.op === "not") {
    const c = emitNode(f.k, pv, idx, nvars, lines, ctr);
    const v = fresh();
    lines.push(`    let ${v} = nNot(${pv}, ${c})`);
    return v;
  }
  // and / or
  const childVars = f.ks.map(k => emitNode(k, pv, idx, nvars, lines, ctr));
  const v = fresh();
  lines.push(`    var ${v}k: Vec<i64> = []`);
  for (const cv of childVars) lines.push(`    ${v}k.push(${cv})`);
  lines.push(`    let ${v} = ${f.op === "and" ? "nAnd" : "nOr"}(${pv}, ${v}k)`);
  return v;
}

interface PreparedVC { index: number; program: string; }

function generateProgram(prepared: { index: number; vars: string[]; root: FNode }[]): string {
  const fns: string[] = [];
  const calls: string[] = [];
  for (const p of prepared) {
    const idx = new Map<string, number>();
    p.vars.forEach((v, i) => idx.set(v, i));
    const nvars = p.vars.length;
    const lines: string[] = [];
    lines.push(`    var pr = newProblem(${nvars})`);
    const ctr = { n: 0 };
    const rootVar = emitNode(p.root, "pr", idx, nvars, lines, ctr);
    lines.push(`    print("${p.index} ", verdictName(decide(pr, ${rootVar})))`);
    fns.push(`fn vc${p.index}(): void {\n${lines.join("\n")}\n}`);
    calls.push(`    vc${p.index}()`);
  }
  return [
    `from "std/smt" import { SmtProblem, Verdict, newProblem, addAtom, nAtom, nNot, nAnd, nOr, decide, verdictName }`,
    "",
    ...fns,
    "",
    `fn main(): i32 {`,
    ...calls,
    `    return 0`,
    `}`,
  ].join("\n");
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
    const program = generateProgram(prepared);
    const dir = mkdtempSync(join(tmpdir(), "milo-prove-"));
    const src = join(dir, "prove.milo");
    writeFileSync(src, program);
    const mainTs = join(import.meta.dir, "main.ts");
    // Run the generated prover through the JS backend, not native: it's pure
    // integer logic, so emit-js + bun avoids a clang compile that would nest
    // under the outer `prove` and trip the memory guard (fail-closed shed).
    const emit = spawnSync("bun", ["run", mainTs, "emit-js", src], { encoding: "utf-8", timeout: 60000 });
    const js = join(dir, "prove.js");
    writeFileSync(js, emit.stdout ?? "");
    const proc = spawnSync("bun", [js], { encoding: "utf-8", timeout: 60000 });
    const out = (proc.stdout ?? "").trim();
    const verdicts = new Map<number, string>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(proven|violated|unknown)$/);
      if (m) verdicts.set(parseInt(m[1], 10), m[2]);
    }
    for (const p of prepared) {
      const vc = result.conditions[p.index];
      const verdict = verdicts.get(p.index);
      if (verdict === "proven") results[p.index] = { vc, status: "proven" };
      else if (verdict === "violated") results[p.index] = { vc, status: "failed", detail: "counterexample exists" };
      else if (verdict === "unknown") results[p.index] = { vc, status: "unknown", detail: "no integer witness (rational-only)" };
      else results[p.index] = { vc, status: "error", detail: (proc.stderr || "std/smt run produced no verdict").split("\n")[0] };
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
