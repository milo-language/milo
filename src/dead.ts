// Dead-branch detection (DO-178C: no dead code; DO-333: what the formal analysis covered).
//
// verify.ts emits one reachability probe per `if`/`else` branch and loop body: the path
// condition (requires + every guard on the way in) with no negated goal. The solver answering
// UNSAT means no input reaches the branch. Anything else (sat, unknown, an untranslatable
// condition, a solver error) is NOT reported: unknown is not dead.
import type { Program } from "./ast";
import { generateVerificationConditions, proveWithZ3 } from "./verify";
import type { VerificationCondition } from "./verify";
import { proveWithMilo } from "./prove-milo";

export interface DeadBranch {
  fn: string;
  file: string;
  line: number;
  /** "then branch of 'if x > 3'" */
  what: string;
  /** The conditions that contradict (requires and guards), as written. */
  why: string[];
  /** Callees whose `ensures` the proof assumed: the verdict is only as good as theirs. */
  assumes: string[];
}

export interface DeadOptions {
  z3?: boolean;
  onlyFile?: string | ((file: string) => boolean);
  /** Test seam: replace the solver (the planted-bug test makes everything "dead"). */
  solve?: (vcs: VerificationCondition[]) => ("proven" | "other")[];
}

export function findDeadBranches(program: Program, check: unknown, o: DeadOptions = {}): DeadBranch[] {
  const gen = generateVerificationConditions(program, { onlyFile: o.onlyFile, methods: check as any, dead: true });
  const probes = gen.deadProbes ?? [];
  const solve = o.solve ?? ((vcs: VerificationCondition[]) => {
    if (vcs.length === 0) return [];
    const res = (o.z3 ? proveWithZ3 : proveWithMilo)({ conditions: vcs, stats: gen.stats });
    return res.results.map(r => (r.status === "proven" ? "proven" as const : "other" as const));
  });

  const verdicts = solve(probes);

  // The walker forks at every `if` and carries the rest of the function down both arms, so
  // one source branch is probed once per path that reaches it. It is dead only if EVERY
  // such path is infeasible: after `if a {..}` then `if b {..}`, the path through a's then
  // arm may rule b out while the path through a's else arm does not.
  const groups = new Map<string, number[]>();
  probes.forEach((p, i) => {
    const d = p.dead!;
    const key = `${p.fn}|${d.file}|${d.line}|${d.what}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });
  const deadGroups = [...groups.values()].filter(ix => ix.every(i => verdicts[i] === "proven"));

  // A branch inside a dead branch is dead only because of it: report the outermost.
  // Conditions are extended by prepending the enclosing ones, so an enclosing branch's
  // conditions are a prefix of everything nested in it.
  const isPrefix = (x: string[], y: string[]) => x.length <= y.length && x.every((c, i) => c === y[i]);
  const outer = deadGroups.filter((g, gi) => !deadGroups.some((h, hi) => {
    if (gi === hi || probes[h[0]!]!.fn !== probes[g[0]!]!.fn) return false;
    return g.every(i => h.some(j => {
      const qc = probes[j]!.dead!.conds, pc = probes[i]!.dead!.conds;
      return isPrefix(qc, pc) && (qc.length < pc.length || hi < gi);
    }));
  }));

  // Name the conditions that actually contradict: drop each one in turn and re-ask. One whose
  // removal makes the branch reachable is needed for the contradiction. Explained on the
  // group's first path.
  const variants: { owner: number; label: string; vc: VerificationCondition }[] = [];
  outer.forEach((g, owner) => {
    const p = probes[g[0]!]!;
    const d = p.dead!;
    const guard = (cs: string[]) => (cs.length > 0 ? `(assert (and true ${cs.join(" ")}))` : "");
    d.conds.forEach((_, k) => {
      const rest = d.conds.filter((__, m) => m !== k);
      variants.push({ owner, label: d.condSrc[k]!, vc: { ...p, smtlib: p.smtlib.replace(guard(d.conds), () => guard(rest)) } });
    });
    d.reqSmt.forEach((smt, j) => {
      variants.push({ owner, label: `requires ${d.reqSrc[j]}`, vc: { ...p, smtlib: p.smtlib.replace(`\n(assert ${smt})`, () => "") } });
    });
  });
  const vv = solve(variants.map(v => v.vc));
  const needed = outer.map(() => [] as string[]);
  variants.forEach((v, i) => { if (vv[i] !== "proven" && !needed[v.owner]!.includes(v.label)) needed[v.owner]!.push(v.label); });

  return outer.map((g, i) => {
    const p = probes[g[0]!]!;
    const d = p.dead!;
    const all = [...d.reqSrc.map(r => `requires ${r}`), ...d.condSrc];
    // Two independent contradictions leave nothing individually needed: list everything.
    const why = needed[i]!.length > 0 ? needed[i]! : [...new Set(all)];
    return { fn: p.fn, file: d.file ?? "", line: d.line, what: d.what, why, assumes: p.assumes ?? [] };
  }).sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
}

export function formatDead(dead: DeadBranch[], rel: (f: string) => string = f => f): string {
  if (dead.length === 0) return "dead branches: none";
  const out = [`dead branches: ${dead.length}`];
  for (const d of dead) {
    out.push(`  ${rel(d.file)}:${d.line} ${d.fn}: ${d.what}`);
    out.push(`    never runs: ${d.why.join("  AND  ")} cannot all hold`);
    if (d.assumes.length) out.push(`    assumes the postconditions of: ${d.assumes.join(", ")}`);
  }
  return out.join("\n");
}
