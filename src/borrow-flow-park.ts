// What each call does to the mutable globals (parks the task, writes one), for the global-buffer loans of src/borrow-flow.ts.
// The summaries are the checker's own: checkPasses computes them once for the global-borrow pass (src/checker-global-borrow-host.ts)
// and keeps them on the checker as `callFacts`; nothing is recomputed here.
import type { Expr, Program } from "./ast";
import { implicitCalls, sayCallee, type ProgramPassHost, type ProgramView } from "./checker-program-passes";
import type { CallEffect } from "./place-cfg";

export interface AnalysisHost {
  callFacts?: { host: ProgramPassHost; view: ProgramView; summary: { writes: Map<string, Set<string>>; parks: Set<string> } | undefined };
}

export function callEffects(program: Program, host: AnalysisHost): { globals: Set<string>; effects: ((e: Expr) => CallEffect | undefined) | undefined } {
  const globals = new Set(program.globals.filter(g => g.mutable).map(g => g.name));
  const facts = host.callFacts;
  if (globals.size === 0 || facts?.summary === undefined) return { globals, effects: undefined };
  const { host: ph, view, summary: { writes, parks } } = facts;
  const implicit = implicitCalls(ph, program, view);
  const effects = (e: Expr): CallEffect | undefined => {
    if (e.kind !== "Call" && e.kind !== "MethodCall") return undefined;
    const t = implicit.isIndirect(e) ? undefined : view.calleeOf(e);
    if (t === undefined) return undefined;
    // The summary also tracks closure captures written in place (the pass models them as globals); only real globals matter here.
    const w = [...(writes.get(t) ?? [])].filter(g => globals.has(g));
    if (!parks.has(t) && w.length === 0) return undefined;
    return { say: sayCallee(view, t, implicit), parks: parks.has(t), writes: w };
  };
  return { globals, effects };
}
