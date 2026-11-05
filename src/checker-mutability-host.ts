// The boundary between the checker and the portable mutability pass (src/checker-mutability.ts).
//
// The checker keys its facts by object identity (`writtenExprs`, `autoBorrowed`, `explicitMutArgs`,
// `matchSubjectMut`, `exprTypes`, `closureCaptures`, the call-resolution maps). The pass cannot
// hold an object, so this file is the one place that still does: it numbers every node of every
// function body in the walker's pre-order and restates each fact as a list of ids. The pass
// sees only plain data.
import type { Program, Function, Stmt, Expr } from "./ast";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import { collectStmts, EXPR_KINDS, type AnyNode } from "./ast-nodes";
import { mutabilityFindings, newScan, scanBody, type FnEntry, type MutInput } from "./checker-mutability";
import type { CallFact, CaptureFact, MutFacts, RootFact } from "./mutability-scan";

// Facts for the nodes of `fns`' bodies, numbered from `from`. Each distinct Function object is
// numbered once, however many entries name it.
function factsFor(host: ProgramPassHost, view: ProgramView, fns: Function[]): { facts: MutFacts; baseOf: Map<Function, number> } {
  const m = host.mutation;
  const baseOf = new Map<Function, number>();
  const facts: MutFacts = { total: 0, mutated: [], aggregate: [], arrays: [], roots: [], captures: [], calls: [] };
  for (const fn of fns) {
    if (baseOf.has(fn)) continue;
    const base = facts.total;
    baseOf.set(fn, base);
    const nodes: AnyNode[] = [];
    collectStmts(fn.body, nodes);
    facts.total += nodes.length;
    nodes.forEach((node, i) => {
      const id = base + i;
      if (!EXPR_KINDS.has(node.kind)) return;
      const e = node as Expr;
      if (m.written.has(e) || m.autoBorrowed.get(e)?.mutable || m.explicitMutArgs.has(e) || m.matchSubjectMut.has(e)) facts.mutated.push(id);
      const root = view.rootOf(e);
      if (root !== undefined) facts.roots.push({ id, name: root } satisfies RootFact);
      const t = host.exprTypes.get(e);
      const through = t?.tag === "ref" ? t.inner : t;
      if (through?.tag === "struct" || through?.tag === "enum") facts.aggregate.push(id);
      if (t?.tag === "array") facts.arrays.push(id);
      if (e.kind === "Closure") {
        for (const c of host.closureCaptures.get(e) ?? []) facts.captures.push({ id, name: c.name, mutated: !!c.mutatedInClosure } satisfies CaptureFact);
      }
      if (e.kind === "Call" || e.kind === "MethodCall") {
        const callee = view.calleeOf(e) ?? "";
        const sig = callee ? host.functions.get(callee) : undefined;
        facts.calls.push({
          id, callee, hasSig: !!sig,
          mutParams: (sig?.params ?? []).map(p => p.type.tag === "ref" && p.type.mutable),
          explicitArgs: e.args.map(a => m.explicitMutArgs.has(a)),
        } satisfies CallFact);
      }
    });
  }
  return { facts, baseOf };
}

export function mutInputOf(host: ProgramPassHost, program: Program, view: ProgramView): MutInput {
  const viewFns = [...view.fns.entries()];
  const { facts, baseOf } = factsFor(host, view, [...viewFns.map(([, f]) => f), ...program.functions]);
  const entry = (name: string, fn: Function): FnEntry => {
    const sig = host.functions.get(name);
    return { name, base: baseOf.get(fn)!, fn, hasSig: !!sig, refParams: (sig?.params ?? []).map(p => p.type.tag === "ref") };
  };
  return {
    facts,
    view: viewFns.map(([name, fn]) => entry(name, fn)),
    program: program.functions.map(f => entry(f.name, f)),
  };
}

export function checkMutability(host: ProgramPassHost, program: Program, view: ProgramView): void {
  for (const f of mutabilityFindings(mutInputOf(host, program, view))) {
    const before = host.mutation.diagnostics.length;
    host.warn(f.code, f.message, f.span, f.hint, f.len);
    // Each explicit call site rides along as a note: the fix deletes the marker there.
    if (f.code === "unwritten-mut-param" && host.mutation.diagnostics.length > before) host.mutation.diagnostics[before]!.notes = f.notes;
  }
}

// The names `body` writes (used by the harden rewrites, which ask about one statement list).
export function writtenNames(host: ProgramPassHost, view: ProgramView, body: Stmt[], _watch: null): { written: Set<string> } {
  const fn = { kind: "Function", name: "", typeParams: [], params: [], contracts: [], body, isExtern: false, isVariadic: false } as unknown as Function;
  const { facts } = factsFor(host, view, [fn]);
  const scan = newScan(facts);
  scanBody(scan, 0, 0, "", fn);
  return { written: scan.written };
}
