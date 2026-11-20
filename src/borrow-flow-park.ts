// What each call does to the mutable globals (parks the task, writes one), for the global-buffer loans of src/borrow-flow.ts.
// The summaries are the checker's shared analyses (src/checker-program-passes.ts), run again here on the checked program: the
// walk in src/checker-global-borrow.ts keeps them to itself, and CheckResult carries no copy.
import type { Expr, Program } from "./ast";
import { globalWriteSummary, implicitCalls, sayCallee, type ProgramPassHost, type ProgramView } from "./checker-program-passes";
import type { CallEffect } from "./place-cfg";

export interface AnalysisHost { analysisFacts?(program: Program): { host: ProgramPassHost; view: ProgramView } }

export function callEffects(program: Program, host: AnalysisHost): { globals: Set<string>; effects: ((e: Expr) => CallEffect | undefined) | undefined } {
  const globals = new Set(program.globals.filter(g => g.mutable).map(g => g.name));
  if (globals.size === 0 || host.analysisFacts === undefined) return { globals, effects: undefined };
  const { host: ph, view } = host.analysisFacts(program);
  const { writes, parks } = globalWriteSummary(ph, program, view, globals);
  const implicit = implicitCalls(ph, program, view);
  const effects = (e: Expr): CallEffect | undefined => {
    if (e.kind !== "Call" && e.kind !== "MethodCall") return undefined;
    const t = implicit.isIndirect(e) ? undefined : view.calleeOf(e);
    if (t === undefined) return undefined;
    const w = writes.get(t);
    if (!parks.has(t) && (w === undefined || w.size === 0)) return undefined;
    return { say: sayCallee(view, t, implicit), parks: parks.has(t), writes: [...(w ?? [])] };
  };
  return { globals, effects };
}
