// The boundary between the checker and the portable Task.scope pass (src/checker-task-scopes.ts).
// The checker keys call resolution and closure captures by object; this file numbers every node of
// each function body in the walker's pre-order and restates them as plain data keyed by that id.
import type { Program, Expr, Function } from "./ast";
import { collectStmts, collectExpr, type AnyNode } from "./ast-nodes";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import {
  taskScopesFindings, CALL_SCOPE, CALL_SPAWN, CALL_LIVE,
  type BodyTask, type CallFact, type CapFact, type ClosureFact, type TaskScopesInput,
} from "./checker-task-scopes";

// Mangled names, std's: a private user type named `TaskScope` is renamed by the resolver.
const TASK_SCOPE_FN = "Task$scope";
export const SCOPED_SPAWN_FN = "TaskScope$spawn";
const SCOPED_LIVE_FN = "TaskScope$live";

// Test hook (scripts/ts2milo-task-scopes-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: TaskScopesInput) => void) | undefined;
export function setTaskScopesCapture(f: ((input: TaskScopesInput) => void) | undefined): void { captureInput = f; }

export function checkTaskScopes(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const verdictOf = (name: string | undefined): number => {
    if (name === TASK_SCOPE_FN) return CALL_SCOPE;
    if (name === SCOPED_SPAWN_FN) return CALL_SPAWN;
    if (name === SCOPED_LIVE_FN) return CALL_LIVE;
    return 0;
  };
  // Most programs never touch a scope; the resolution maps say so without numbering a node.
  const resolves = (m: Map<Expr, string>): boolean => {
    for (const v of m.values()) if (verdictOf(v) !== 0) return true;
    return false;
  };
  if (!resolves(host.rewrittenCalls) && !resolves(host.staticCalls) && !resolves(host.resolvedMethods)) return;

  const walked = [...program.functions, ...host.monomorphizedFns].filter(f => !f.isExtern && f.body && f.typeParams.length === 0);
  const walkedSet = new Set<Function>(walked);
  // A captured closure binding may hold a literal from any body, so every body is numbered.
  const all = [...new Set<Function>([...walked, ...view.fns.values()])].filter(f => f.body);
  const tasks: BodyTask[] = [];
  const calls: CallFact[] = [];
  const closures: ClosureFact[] = [];
  const idOf = new Map<Expr, number>();
  const numbered: { nodes: AnyNode[]; base: number }[] = [];
  let total = 0;
  for (const f of all) {
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    numbered.push({ nodes, base: total });
    nodes.forEach((e, i) => { if (e.kind === "Closure") idOf.set(e, total + i); });
    if (walkedSet.has(f)) tasks.push({ body: f.body, base: total });
    total += nodes.length;
  }

  numbered.forEach(({ nodes, base }) => {
    nodes.forEach((e, i) => {
      const id = base + i;
      if (e.kind === "Call" || e.kind === "EnumLit" || e.kind === "MethodCall") {
        const verdict = verdictOf(view.calleeOf(e));
        if (verdict === 0) return;
        let objSize = 0;
        if (e.kind === "MethodCall") {
          const sub: AnyNode[] = [];
          collectExpr(e.object, sub);
          objSize = sub.length;
        }
        calls.push({ id, verdict, objSize });
      } else if (e.kind === "Closure") {
        const caps = host.closureCaptures.get(e) ?? [];
        if (caps.length === 0) return;
        const facts: CapFact[] = caps.map(c => ({
          name: c.name,
          writes: !!c.mutatedInClosure || !!c.consumedInClosure,
          sources: (c.info?.closureSources ?? []).flatMap(s => { const sid = idOf.get(s); return sid === undefined ? [] : [sid]; }),
        }));
        closures.push({ id, isMove: !!e.isMove, caps: facts });
      }
    });
  });

  const input: TaskScopesInput = { tasks, calls, closures };
  if (captureInput) captureInput(input);
  for (const f of taskScopesFindings(input)) host.error(f.message, f.span, f.hint);
}
