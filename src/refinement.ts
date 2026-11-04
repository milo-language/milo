// `milo trace --refinement`: z3 checks the requirements' own clauses (no fn bodies): does a child's contract deliver its parent's, and can each contract be satisfied at all.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import type { Contract, Expr, Program } from "./ast";
import { clauseImplies } from "./verify";
import { findRequirementsFile, inEntryProject, loadRequirements } from "./requirements";

export type RefineVerdict = "REFINED" | "NOT REFINED" | "UNKNOWN" | "NOT COMPARABLE";
export type SatVerdict = "SAT" | "UNSAT" | "UNKNOWN";

export interface RefinementRow {
  req: string;
  /** "file.milo:fn" */
  fn: string;
  kind: string;
  text: string;
  hash: string;
  verdict: RefineVerdict;
  /** Descendant requirements whose clauses on this fn were the antecedent. */
  by: string[];
  counterexample?: string;
  note?: string;
}

export interface SatRow {
  fn: string;
  verdict: SatVerdict;
  /** UNSAT only: which query failed. "requires" = every proof of the fn is vacuous; "contract" = no implementation can exist. */
  scope?: "requires" | "contract";
  clauses?: string[];
  message?: string;
}

export interface RefinementReport {
  obligations: RefinementRow[];
  satisfiability: SatRow[];
  gaps: { key: string; message: string }[];
}

interface FnClauses {
  name: string;
  display: string;
  vars: Map<string, string>;
  contracts: { c: Contract; ids: string[]; text: string }[];
}

const TRUE: Expr = { kind: "BoolLit", value: true };
const FALSE: Expr = { kind: "BoolLit", value: false };
const sha = (e: unknown) => createHash("sha256").update(JSON.stringify(e, (k, v) => k === "span" ? undefined : typeof v === "bigint" ? String(v) : v)).digest("hex").slice(0, 12);

const lineCache = new Map<string, string[]>();
function clauseText(file: string, line: number): string {
  if (!lineCache.has(file)) {
    try { lineCache.set(file, readFileSync(file, "utf-8").split("\n")); } catch { lineCache.set(file, []); }
  }
  return (lineCache.get(file)![line - 1] ?? "").replace(/\s*\/\/.*$/, "").trim();
}

function collectFns(program: Program, entry: string): FnClauses[] {
  const inProject = inEntryProject(entry);
  const all = [
    ...program.functions.map(fn => ({ fn, name: fn.name })),
    ...(program.impls ?? []).flatMap(im => im.methods.map(fn => ({ fn, name: `${im.typeName}.${fn.name}` }))),
  ];
  const out: FnClauses[] = [];
  const seen = new Set<string>();
  for (const { fn, name } of all) {
    if (fn.isExtern) continue;
    const file = resolve(fn.span?.file ?? fn.sourceFile ?? "");
    if (!inProject(file) || seen.has(`${file}:${name}`)) continue;
    seen.add(`${file}:${name}`);
    const vars = new Map<string, string>();
    for (const p of fn.params) vars.set(p.name, p.type?.name ?? "i64");
    if (fn.retType && fn.retType.name !== "void") vars.set("result", fn.retType.name);
    const contracts = fn.contracts.filter(c => c.kind === "requires" || c.kind === "ensures").map(c => ({
      c,
      ids: (c.attributes ?? []).filter(a => (a.name === "req" || a.name === "derived") && a.args.length > 0).map(a => a.args[0]!),
      text: clauseText(file, c.span?.line ?? 0),
    }));
    out.push({ name, display: `${basename(file)}:${name}`, vars, contracts });
  }
  return out;
}

/** Whether the conjunction of `hyp` has a model: SAT = yes, UNSAT = no. Same z3 path as the spec lock. */
function satisfiable(f: FnClauses, hyp: Expr[]): SatVerdict {
  if (hyp.length === 0) return "SAT";
  const r = clauseImplies(f.vars, hyp, TRUE, FALSE);
  return r.status === "refuted" ? "SAT" : r.status === "implies" ? "UNSAT" : "UNKNOWN";
}

/** A smaller set of clauses that is still UNSAT: drop each in turn and keep the drop if the rest stays UNSAT. */
function unsatCore<T extends { c: Contract }>(f: FnClauses, items: T[], fixed: Expr[]): T[] {
  let core = items;
  if (core.length > 12) return core;
  for (const it of items) {
    const rest = core.filter(x => x !== it);
    if (rest.length < core.length && satisfiable(f, [...fixed, ...rest.map(x => x.c.expr)]) === "UNSAT") core = rest;
  }
  return core;
}

export function checkRefinement(program: Program, entry: string, requirementsPath?: string): RefinementReport {
  const fns = collectFns(program, entry);
  const gaps: { key: string; message: string }[] = [];
  const obligations: RefinementRow[] = [];

  const reqPath = findRequirementsFile(entry, requirementsPath);
  const reqs = reqPath ? loadRequirements(reqPath).reqs : [];
  const children = new Map<string, string[]>();
  for (const r of reqs) if (r.parent) children.set(r.parent, [...(children.get(r.parent) ?? []), r.id]);
  const descendants = (id: string): Set<string> => {
    const seen = new Set<string>();
    const walk = (x: string) => { for (const c of children.get(x) ?? []) if (!seen.has(c)) { seen.add(c); walk(c); } };
    walk(id);
    return seen;
  };

  // Only a requirement with children is a refinement target; a leaf has nothing below it to check against.
  for (const r of reqs) {
    if (!children.has(r.id)) continue;
    const below = descendants(r.id);
    for (const f of fns) {
      const requires = f.contracts.filter(x => x.c.kind === "requires").map(x => x.c.expr);
      for (const own of f.contracts) {
        if (!own.ids.includes(r.id)) continue;
        const row: RefinementRow = { req: r.id, fn: f.display, kind: own.c.kind, text: own.text, hash: sha([f.name, own.c.kind, own.c.expr]), verdict: "NOT COMPARABLE", by: [] };
        if (own.c.kind !== "ensures") {
          row.note = "requires clauses are not compared";
        } else {
          // The parent's own clauses are excluded, or its second clause would "refine" its first.
          const kids = f.contracts.filter(x => x.c.kind === "ensures" && !x.ids.includes(r.id) && x.ids.some(i => below.has(i)));
          if (kids.length === 0) {
            row.note = `no child clause on ${f.name}`;
          } else {
            row.by = [...new Set(kids.flatMap(k => k.ids.filter(i => below.has(i))))].sort();
            const res = clauseImplies(f.vars, [...requires, ...kids.map(k => k.c.expr)], TRUE, own.c.expr);
            if (res.status === "implies") row.verdict = "REFINED";
            else if (res.status === "refuted") { row.verdict = "NOT REFINED"; row.counterexample = res.model || "(no model)"; }
            else { row.verdict = "UNKNOWN"; row.note = "z3 timed out or the clause is outside what the encoder expresses"; }
          }
        }
        obligations.push(row);
        if (row.verdict === "NOT REFINED") {
          gaps.push({ key: `refinement:${r.id}:${row.hash}`, message: `requirement ${r.id} is not refined by ${row.by.join(", ")}: ${f.display} ${own.text}; counterexample ${row.counterexample}` });
        }
      }
    }
  }

  const satisfiability: SatRow[] = [];
  for (const f of fns) {
    if (!f.contracts.some(x => x.ids.length > 0)) continue;
    const reqC = f.contracts.filter(x => x.c.kind === "requires");
    const ensC = f.contracts.filter(x => x.c.kind === "ensures");
    const reqE = reqC.map(x => x.c.expr);
    const names = (xs: typeof reqC) => xs.map(x => x.text || "(clause)");
    const alone = satisfiable(f, reqE);
    if (alone === "UNSAT") {
      const clauses = names(unsatCore(f, reqC, []));
      const message = `the requires of '${f.name}' are unsatisfiable (${clauses.join("; ")}): no input can meet them, so every proof of '${f.name}' is vacuous`;
      satisfiability.push({ fn: f.display, verdict: "UNSAT", scope: "requires", clauses, message });
      gaps.push({ key: `unsat:${f.name}`, message });
      continue;
    }
    const both = alone === "SAT" ? satisfiable(f, [...reqE, ...ensC.map(x => x.c.expr)]) : "UNKNOWN";
    if (both === "UNSAT") {
      const clauses = names(unsatCore(f, ensC, reqE));
      const message = `the ensures of '${f.name}' (${clauses.join("; ")}) contradict its requires, which are satisfiable on their own: no implementation can meet this contract`;
      satisfiability.push({ fn: f.display, verdict: "UNSAT", scope: "contract", clauses, message });
      gaps.push({ key: `unsat:${f.name}`, message });
    } else {
      satisfiability.push({ fn: f.display, verdict: both === "SAT" ? "SAT" : "UNKNOWN" });
    }
  }
  return { obligations, satisfiability, gaps };
}

export function formatRefinement(r: RefinementReport): string[] {
  const out: string[] = ["", "requirement refinement:"];
  const n = (v: RefineVerdict) => r.obligations.filter(o => o.verdict === v).length;
  const checked = n("REFINED") + n("NOT REFINED") + n("UNKNOWN");
  for (const o of r.obligations) {
    out.push(`  ${o.req} ${o.fn} ${o.text}`);
    if (o.verdict === "REFINED") out.push(`    REFINED by ${o.by.join(", ")}`);
    else if (o.verdict === "NOT REFINED") out.push(`    NOT REFINED by ${o.by.join(", ")}: counterexample ${o.counterexample}`);
    else out.push(`    ${o.verdict}${o.note ? `: ${o.note}` : ""}`);
  }
  out.push(`  ${checked} refinement obligations checked: ${n("REFINED")} refined, ${n("NOT REFINED")} not refined, ${n("UNKNOWN")} unknown; ${n("NOT COMPARABLE")} not comparable (neither pass nor fail)`);
  out.push("contract satisfiability:");
  const total = r.satisfiability.length;
  const sat = r.satisfiability.filter(s => s.verdict === "SAT").length;
  if (sat === total) out.push(`  all ${total} fns satisfiable`);
  else {
    for (const s of r.satisfiability) {
      if (s.verdict === "UNSAT") out.push(`  UNSAT ${s.fn}: ${s.message}`);
      else if (s.verdict === "UNKNOWN") out.push(`  UNKNOWN ${s.fn}: z3 timed out or a clause is outside what the encoder expresses`);
    }
    out.push(`  ${sat} of ${total} fns satisfiable, ${r.satisfiability.filter(s => s.verdict === "UNSAT").length} unsat, ${r.satisfiability.filter(s => s.verdict === "UNKNOWN").length} unknown`);
  }
  return out;
}
