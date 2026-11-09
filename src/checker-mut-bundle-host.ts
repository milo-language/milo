// The boundary between the checker and the portable `&mut` parameter bundle pass
// (src/checker-mut-bundle.ts). The checker keys signatures and call resolution by object or
// name; this file numbers every node of each function body in the walker's pre-order and
// restates what the pass needs as plain data keyed by that id.
import type { Program } from "./ast";
import { collectStmts, type AnyNode } from "./ast-nodes";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import { mutBundleFindings, type BodyTask, type CallFact, type Subject, type MutBundleInput } from "./checker-mut-bundle";

// Test hook (scripts/ts2milo-mut-bundle-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: MutBundleInput) => void) | undefined;
export function setMutBundleCapture(f: ((input: MutBundleInput) => void) | undefined): void { captureInput = f; }

export function checkMutParamBundle(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const { fns, rootOf, calleeOf, pretty } = view;
  // Free fns only: impl methods live in monomorphizedFns, never program.functions. A
  // generic fn is judged once, at its declaration; its instances are folded back onto it
  // through `sourceName` below so their call sites count toward the one report.
  const subjectIdx = new Map<string, number>();
  const mutIdxs: number[][] = [];
  const subjects: Subject[] = [];
  for (const f of program.functions) {
    if (f.isExtern || !f.body) continue;
    // A generic declaration has no FnSig of its own; any instance carries the same
    // ref-ness at every slot, so the first one stands in. An instantiation-free generic
    // has no sig at all and is skipped: its body was never checked either.
    const sig = host.functions.get(f.name)
      ?? (f.typeParams.length > 0 ? host.functions.get(host.monomorphizedFns.find(m => m.sourceName === f.name)?.name ?? "") : undefined);
    if (!sig) continue;
    const mutIdx: number[] = [];
    sig.params.forEach((p, i) => { if (p.type.tag === "ref" && p.type.mutable) mutIdx.push(i); });
    if (mutIdx.length < 3) continue;
    subjectIdx.set(f.name, subjects.length);
    mutIdxs.push(mutIdx);
    subjects.push({ pretty: pretty(f.name), mutCount: mutIdx.length, span: f.span });
  }
  if (subjects.length === 0) {
    // Most programs have no subject; the probe still wants to see that the pass was reached.
    if (captureInput) captureInput({ tasks: [], facts: [], subjects });
    return;
  }

  const tasks: BodyTask[] = [];
  const facts: CallFact[] = [];
  let total = 0;
  for (const f of fns.values()) {
    if (!f.body) continue;
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    const base = total;
    total += nodes.length;
    tasks.push({ body: f.body, base });
    nodes.forEach((e, i) => {
      if (e.kind !== "Call") return;
      const callee = host.closureCalls.has(e) || host.cfnCalls.has(e) ? undefined : calleeOf(e);
      const name = callee === undefined ? undefined : (fns.get(callee)?.sourceName ?? callee);
      const subject = name === undefined ? undefined : subjectIdx.get(name);
      if (subject === undefined) return;
      // The `&mut` marker is stripped from the argument by the time the passes run (see
      // takeExplicitMutArgs), so the argument roots directly.
      facts.push({ id: base + i, subject, roots: mutIdxs[subject]!.map(k => rootOf(e.args[k]) ?? "") });
    });
  }

  const input: MutBundleInput = { tasks, facts, subjects };
  if (captureInput) captureInput(input);
  for (const f of mutBundleFindings(input)) host.warn("mut-param-bundle", f.message, f.span, f.hint);
}
