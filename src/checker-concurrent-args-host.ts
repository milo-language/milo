// The boundary between the checker and the portable `@concurrent` closure-argument pass
// (src/checker-concurrent-args.ts). The checker keys call resolution, expression types and closure
// captures by object; this file numbers every node of each function body in the walker's
// pre-order and restates them as plain data keyed by that id.
import type { Program } from "./ast";
import { collectStmts, type AnyNode } from "./ast-nodes";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import {
  concurrentArgsFindings, ARG_BAD_CLOSURE, ARG_NAMED, ARG_OPAQUE,
  type ArgFact, type BodyTask, type CallFact, type ConcurrentArgsInput,
} from "./checker-concurrent-args";

// Test hook (scripts/ts2milo-concurrent-args-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: ConcurrentArgsInput) => void) | undefined;
export function setConcurrentArgsCapture(f: ((input: ConcurrentArgsInput) => void) | undefined): void { captureInput = f; }

export function checkConcurrentClosureArgs(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const { fns, calleeOf } = view;
  const isConcurrent = (t: string | undefined) => !!t && !!fns.get(t)?.attributes?.some(a => a.name === "concurrent");
  if (![...fns.values()].some(f => f.attributes?.some(a => a.name === "concurrent"))) return;
  const named = new Set<string>([...program.functions.map(f => f.name), ...fns.keys()]);

  const tasks: BodyTask[] = [];
  const facts: CallFact[] = [];
  let total = 0;
  for (const f of fns.values()) {
    if (!f.body) continue;
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    const base = total;
    total += nodes.length;
    let any = false;
    nodes.forEach((e, i) => {
      if (e.kind !== "Call" && e.kind !== "MethodCall" && e.kind !== "EnumLit") return;
      const callee = calleeOf(e);
      if (!isConcurrent(callee)) return;
      const args: ArgFact[] = [];
      for (const a of e.args) {
        if (host.exprTypes.get(a)?.tag !== "fn") continue;
        const span = a.span ?? e.span;
        if (a.kind === "Closure") {
          const bad = (host.closureCaptures.get(a) ?? []).find(c => c.mutatedInClosure || c.consumedInClosure);
          if (bad) args.push({ verdict: ARG_BAD_CLOSURE, name: bad.name, moves: !!bad.consumedInClosure && !bad.mutatedInClosure, span });
        } else if (a.kind === "Ident" && named.has(a.name)) {
          args.push({ verdict: ARG_NAMED, name: a.name, moves: false, span });
        } else {
          args.push({ verdict: ARG_OPAQUE, name: "", moves: false, span });
        }
      }
      if (args.length === 0) return;
      facts.push({ id: base + i, who: view.pretty(callee!), args });
      any = true;
    });
    // A body with no fact reports nothing, so skipping it changes no finding.
    if (any) tasks.push({ body: f.body, base, params: f.params.map(p => p.name) });
  }
  const input: ConcurrentArgsInput = { tasks, facts };
  if (captureInput) captureInput(input);
  for (const f of concurrentArgsFindings(input)) host.error(f.message, f.span, f.hint);
}
