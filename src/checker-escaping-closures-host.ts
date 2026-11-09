// The boundary between the checker and the portable escaping-closure pass
// (src/checker-escaping-closures.ts). The checker keys closure captures, call resolution and
// expression types by object; this file numbers every node of each function body in the walker's
// pre-order and restates what the pass needs as plain data keyed by that id.
import type { Program, Expr, Function } from "./ast";
import { collectStmts, type AnyNode } from "./ast-nodes";
import { RETAINING_MEMBERS } from "./builtin-members";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import {
  escapingClosuresFindings,
  type BodyTask, type ClosureFact, type NodeFact, type FnFact, type EscapingClosuresInput,
} from "./checker-escaping-closures";

// Test hook (scripts/ts2milo-escaping-closures-diff.ts): sees each input the pass is about to run
// on. Unset in every real compile, so it changes nothing.
let captureInput: ((input: EscapingClosuresInput) => void) | undefined;
export function setEscapingClosuresCapture(f: ((input: EscapingClosuresInput) => void) | undefined): void { captureInput = f; }

export function checkEscapingClosures(host: ProgramPassHost, program: Program, view: ProgramView): void {
  // No closure captures anything: nothing can be reported.
  let anyCaptures = false;
  for (const caps of host.closureCaptures.values()) if (caps.length > 0) { anyCaptures = true; break; }
  if (!anyCaptures) return;

  const fns: FnFact[] = [];
  const fnObjs: Function[] = [];
  for (const [name, f] of view.fns) {
    const sig = host.functions.get(name);
    const decl = f.params.map((_, i) => {
      const t = sig?.params[i]?.type;
      return t?.tag === "fn" ? (t.owning ? 2 : 1) : 0;
    });
    fns.push({ name, usable: !f.isExtern && !!f.body, params: f.params.map(p => p.name), decl });
    fnObjs.push(f);
  }
  const walked = [...program.functions, ...host.monomorphizedFns].filter(f => !f.isExtern && f.body);

  const baseOf = new Map<Function, number>();
  const all: { f: Function; nodes: AnyNode[]; base: number }[] = [];
  let total = 0;
  for (const f of [...walked, ...fnObjs]) {
    if (!f.body || baseOf.has(f)) continue;
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    baseOf.set(f, total);
    all.push({ f, nodes, base: total });
    total += nodes.length;
  }

  // The parameter summaries first: the check asks them from any body.
  const tasks: BodyTask[] = [];
  fnObjs.forEach((f, i) => { if (fns[i]!.usable) tasks.push({ body: f.body, base: baseOf.get(f)!, fn: i }); });
  for (const f of walked) tasks.push({ body: f.body, base: baseOf.get(f)!, fn: -1 });

  const idOf = new Map<Expr, number>();
  for (const { nodes, base } of all) nodes.forEach((e, i) => { if (e.kind === "Closure") idOf.set(e, base + i); });
  const litsOf = (xs: Expr[]): number[] => xs.flatMap(x => { const id = idOf.get(x); return x.kind === "Closure" && id !== undefined ? [id] : []; });
  const mayBeFnArg = (xs: Expr[]) => xs.some(a => a.kind === "Closure" || a.kind === "Ident");

  const closures: ClosureFact[] = [];
  const facts: NodeFact[] = [];
  const fact = (id: number, lits: number[], target: string) => { if (lits.length > 0 || target !== "") facts.push({ id, lits, target }); };
  for (const { nodes, base } of all) {
    nodes.forEach((e, i) => {
      const id = base + i;
      switch (e.kind) {
        case "Closure": {
          const caps = host.closureCaptures.get(e) ?? [];
          if (caps.length > 0) closures.push({ id, isMove: !!e.isMove, caps: caps.map(c => c.name) });
          break;
        }
        case "LetDecl": case "VarDecl": case "Assign": fact(id, litsOf([e.value]), ""); break;
        case "Return": fact(id, e.value ? litsOf([e.value]) : [], ""); break;
        case "ArrayRepeat": fact(id, litsOf([e.value]), ""); break;
        case "ArrayLit": fact(id, litsOf(e.elements), ""); break;
        case "StructLit": fact(id, litsOf([...e.fields.map(f => f.value), ...(e.base ? [e.base] : [])]), ""); break;
        case "Call": fact(id, litsOf(e.args), ""); break;
        case "EnumLit": fact(id, litsOf(e.args), host.staticCalls.get(e) ?? ""); break;
        case "MethodCall": {
          // Only calls that can pass a closure or a bound name onward need the receiver's type.
          let owner = "";
          if (mayBeFnArg(e.args)) {
            const recv = host.exprTypes.get(e.object);
            const baseTy = recv?.tag === "ref" ? recv.inner : recv;
            owner = baseTy && (baseTy.tag === "struct" || baseTy.tag === "enum") ? baseTy.name : "";
          }
          fact(id, litsOf(e.args), owner);
          break;
        }
      }
    });
  }

  const input: EscapingClosuresInput = {
    tasks, closures, nodes: facts, fns,
    globals: program.globals.map(g => g.name),
    retaining: [...RETAINING_MEMBERS],
  };
  if (captureInput) captureInput(input);
  for (const f of escapingClosuresFindings(input)) host.error(f.message, f.span, f.hint);
}
