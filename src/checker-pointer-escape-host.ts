// The boundary between the checker and the portable pointer-parameter-escape pass
// (src/checker-pointer-escape.ts). The checker keys expression types and method resolution by
// object; this file numbers every node of each function body in the walker's pre-order and
// restates what the pass needs as plain data keyed by that id.
import type { Program, Expr } from "./ast";
import { collectStmts, type AnyNode } from "./ast-nodes";
import { mutatesReceiver, type ProgramPassHost, type ProgramView } from "./checker-program-passes";
import { pointerEscapeFindings, type BodyTask, type PtrFact, type PointerEscapeInput } from "./checker-pointer-escape";

// Test hook (scripts/ts2milo-pointer-escape-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: PointerEscapeInput) => void) | undefined;
export function setPointerEscapeCapture(f: ((input: PointerEscapeInput) => void) | undefined): void { captureInput = f; }

export function checkPointerParamEscape(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const globals = program.globals.filter(g => g.mutable).map(g => g.name);
  if (globals.length === 0) return;
  const tasks: BodyTask[] = [];
  const facts: PtrFact[] = [];
  let total = 0;
  const carries = (e: Expr): boolean => {
    const ty = host.exprTypes.get(e);
    return !!ty && host.carriesRawPointer(ty);
  };

  for (const f of view.fns.values()) {
    if (!f.body) continue;
    // `@externalLinkage` entry points: their pointer parameters come from C, which owns them.
    if (f.attributes?.some(a => a.name === "externalLinkage")) continue;
    const sig = host.functions.get(f.name);
    const params: string[] = [];
    f.params.forEach((p, i) => {
      const ty = sig?.params[i]?.type;
      if (ty && host.carriesRawPointer(ty)) params.push(p.name);
    });
    if (params.length === 0) continue;

    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    const base = total;
    total += nodes.length;
    tasks.push({ body: f.body, base, params });

    nodes.forEach((e, i) => {
      const id = base + i;
      if (e.kind === "LetDecl" || e.kind === "VarDecl") {
        facts.push({ id, root: "", valuePtr: carries(e.value), argPtr: [] });
      } else if (e.kind === "Assign") {
        facts.push({ id, root: view.rootOf(e.target) ?? "", valuePtr: carries(e.value), argPtr: [] });
      } else if (e.kind === "MethodCall" && mutatesReceiver(host, e)) {
        facts.push({ id, root: view.rootOf(e.object) ?? "", valuePtr: false, argPtr: e.args.map(carries) });
      }
    });
  }

  if (tasks.length === 0) return;
  const input: PointerEscapeInput = { tasks, facts, globals };
  if (captureInput) captureInput(input);
  for (const f of pointerEscapeFindings(input)) host.error(f.message, f.span, f.hint);
}
