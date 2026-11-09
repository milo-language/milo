// The boundary between the checker and the portable global borrow pass (src/checker-global-borrow.ts).
// The checker keys call resolution, expression types and closure captures by object; this file
// numbers every node of each function body in the walker's pre-order and restates what the pass
// needs as plain data keyed by that id. The write/park summaries and the implicit-call model are
// the checker's shared analyses, so they are computed here and handed over as results.
import type { Program, Expr, Span } from "./ast";
import { collectStmts, collectExpr, collectContract, type AnyNode } from "./ast-nodes";
import {
  globalWriteSummary, paramViewsAcrossPark, implicitCalls, sayCallee, isDropFn, LAZY_INIT_FN_PREFIX,
  type ProgramPassHost, type ProgramView, type Scope, type ClosureLit,
} from "./checker-program-passes";
import {
  globalBorrowFindings,
  type ArgFact, type BodyTask, type CalleeFact, type CallFact, type CapEntry, type ClosureFact,
  type ForFact, type GlobalBorrowInput, type PvFact, type TargetFact, type ViewFact,
} from "./checker-global-borrow";

// Test hook (scripts/ts2milo-global-borrow-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: GlobalBorrowInput) => void) | undefined;
export function setGlobalBorrowCapture(f: ((input: GlobalBorrowInput) => void) | undefined): void { captureInput = f; }

// Literals handed straight to a std entry point that runs them exactly once. Nothing can run them
// a second time, and scoped tasks sharing a binding are checkTaskScopes' business, so their
// written captures are plain locals here.
const RUNS_ONCE = /^(Task\$scope|TaskScope\$spawn|Task\$spawn|Task\$spawnWithStack|spawnOsThreadDetached|blockingPoolSubmit|dbpool\$dbPoolSubmit|dbPoolRun(_\w+)?|Promise\b.*\$(run|blocking))$/;

export function checkGlobalBorrowInvalidation(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const mutableGlobals = new Set<string>();
  for (const g of program.globals) if (g.mutable) mutableGlobals.add(g.name);
  const { fns, rootOf, calleeOf: target } = view;
  const implicit = implicitCalls(host, program, view);
  // A closure's environment is shared by every run of that closure value: two tasks can
  // call one closure (a route handler in a Router behind `&`, a closure parameter handed
  // to two scoped tasks) and a body can re-enter itself through a call by value. So a
  // capture the body writes in place is, inside that body, a global scoped to the
  // closure: no loop or view over it may live across a park or a call that may run the
  // closure again. Captures only read stay ordinary; nobody can change them.
  const sharedCaps = new Map<ClosureLit, Map<string, string>>();
  const seed = new Map<string, Set<string>>();
  const capNames: CapEntry[] = [];
  for (const [lit, id] of implicit.closureIds) {
    // Only captures written in place. One moved out is not tracked: the second run of
    // such a closure aborts at the move-out (see "runs once" in the language reference),
    // and Promise.blocking/Task.spawn bodies, which run once, move captures out routinely.
    const caps = (host.closureCaptures.get(lit as unknown as Expr) ?? []).filter(c => c.mutatedInClosure);
    if (caps.length === 0) continue;
    const m = new Map(caps.map(c => [c.name, `${id}::${c.name}`]));
    sharedCaps.set(lit, m);
    seed.set(id, new Set(m.values()));
    for (const [nm, key] of m) capNames.push({ name: nm, key });
  }
  if (mutableGlobals.size === 0 && sharedCaps.size === 0) return;
  const { writes, parks } = globalWriteSummary(host, program, view, mutableGlobals, seed);
  const heldAcrossPark = paramViewsAcrossPark(host, view, parks);

  // Only a callee that parks or writes a tracked name can produce a finding.
  const callees: CalleeFact[] = [];
  const calleeIdx = new Map<string, number>();
  const calleeFor = (t: string): number => {
    const hit = calleeIdx.get(t);
    if (hit !== undefined) return hit;
    const w = writes.get(t);
    let idx = -1;
    if (parks.has(t) || (w !== undefined && w.size > 0)) {
      const fn = fns.get(t);
      idx = callees.length;
      callees.push({
        say: sayCallee(view, t, implicit),
        parks: parks.has(t),
        writes: [...(w ?? [])],
        held: [...(heldAcrossPark.get(t) ?? [])].map(([idx, at]) => ({ idx, at })),
        hasFn: fn !== undefined,
        params: (fn?.params ?? []).map(p => {
          const ty = p.type;
          const refish = !!ty && (ty.isRef || ty.isRefMut);
          return { hasType: !!ty, refish, slice: refish && !!ty && ty.isArray && ty.arraySize === null };
        }),
        lazyRead: t.startsWith(LAZY_INIT_FN_PREFIX) ? view.pretty(t.slice(LAZY_INIT_FN_PREFIX.length, -1)) : "",
      });
    }
    calleeIdx.set(t, idx);
    return idx;
  };

  const pvsOf = (e: Expr): PvFact[] => host.pointerViewsIn(e).map(pv => ({ root: rootOf(pv.source) ?? "", call: pv.call, line: pv.line }));
  // The path reaches the heap interior of its root: an index step, through any field accesses.
  const reachesElement = (e: Expr): boolean => {
    let cur: Expr = e;
    while (cur.kind === "FieldAccess") cur = cur.object;
    return cur.kind === "IndexAccess";
  };
  const argFact = (a: Expr, byValue: boolean): ArgFact => {
    const pvs = host.pointerViewsIn(a);
    const first = pvs[0];
    const isView = host.exprTypes.get(a)?.tag === "ref" || first !== undefined;
    const viewRoot = rootOf(first ? first.source : isView && a.kind === "MethodCall" ? a.object : a) ?? "";
    return {
      span: a.span as Span | undefined, isView, viewRoot, elem: reachesElement(a), byValue,
      root: rootOf(a) ?? "", pvs: pvsOf(a),
    };
  };

  const tasks: BodyTask[] = [];
  const calls: CallFact[] = [];
  const views: ViewFact[] = [];
  const fors: ForFact[] = [];
  const closures: ClosureFact[] = [];
  const runsOnce = new Set<unknown>();
  let total = 0;
  for (const f of fns.values()) {
    if (!f.body) continue;
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    const base = total;
    total += nodes.length;
    tasks.push({ body: f.body, base, params: f.params.map(p => p.name) });
    const scope: Scope = { fn: f.name, shadow: new Set() };
    // A for-in's loop invariants were never part of the original walk: ids in [skipFrom, skipTo).
    let skipFrom = 0;
    let skipTo = 0;
    nodes.forEach((n, i) => {
      const id = base + i;
      if (id >= skipFrom && id < skipTo) return;
      implicit.enter(n, scope);
      const isCall = n.kind === "Call" || n.kind === "MethodCall" || n.kind === "EnumLit";
      if (isCall && RUNS_ONCE.test(target(n) ?? "")) {
        for (const a of n.args) if (a.kind === "Closure") runsOnce.add(a);
      }
      if (n.kind === "Closure") {
        const m = runsOnce.has(n) ? undefined : sharedCaps.get(n);
        if (m) closures.push({ id, caps: [...m].map(([name, key]) => ({ name, key })) });
        return;
      }
      if (n.kind === "ForInStmt") {
        const root = rootOf(n.iterable) ?? "";
        if (root !== "") fors.push({ id, root });
        const it: AnyNode[] = [];
        collectExpr(n.iterable, it);
        const inv: AnyNode[] = [];
        for (const c of n.invariants) collectContract(c, inv);
        skipFrom = id + 1 + it.length;
        skipTo = skipFrom + inv.length;
        return;
      }
      if (n.kind === "LetDecl" || n.kind === "VarDecl") {
        const v = n.value;
        if (host.exprTypes.get(v)?.tag === "ref") {
          const root = rootOf(v.kind === "MethodCall" ? v.object : v) ?? "";
          if (root !== "") views.push({ id, isRef: true, root, pvs: [] });
        } else {
          const pvs = pvsOf(v);
          if (pvs.length > 0) views.push({ id, isRef: false, root: "", pvs });
        }
      }
      const direct = isCall && !implicit.isIndirect(n) ? target(n) : undefined;
      const names = [...(direct ? [direct] : []), ...implicit.implicitTargets(n, scope)];
      const targets: TargetFact[] = [];
      for (const t of names) {
        const callee = calleeFor(t);
        // An implicit drop is handed only the dying value; INDIRECT and an interface impl
        // receive the call's own arguments.
        if (callee >= 0) targets.push({ callee, direct: t === direct, callArgs: isCall && !(t !== direct && isDropFn(t)) });
      }
      if (targets.length === 0) return;
      const args: ArgFact[] = [];
      if (isCall) {
        // With no fn to read parameters from, a call through a value still has the value's own
        // fn type, and a by-value parameter materialises its argument before anything runs.
        const valueTy = host.closureCalls.get(n) ?? host.cfnCalls.get(n);
        const byValue = (j: number) => (valueTy?.tag === "fn" || valueTy?.tag === "cfn") && !!valueTy.params[j] && valueTy.params[j].tag !== "ref";
        if (n.kind === "MethodCall") args.push(argFact(n.object, false));
        n.args.forEach((a, j) => args.push(argFact(a, byValue(j))));
      }
      calls.push({ id, span: (n as { span?: Span }).span, recv: n.kind === "MethodCall", targets, args });
    });
  }

  const input: GlobalBorrowInput = { tasks, globals: [...mutableGlobals], capNames, callees, calls, views, fors, closures };
  if (captureInput) captureInput(input);
  for (const f of globalBorrowFindings(input)) host.error(f.message, f.span, f.hint);
}
