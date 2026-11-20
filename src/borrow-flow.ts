// Borrow conflicts as dataflow, shadow mode: nothing here feeds the checker. A loan of place p held by
// holder h is in force at a node iff the loan node reaches it with no redefinition of h in between and
// h is still live there (an NLL region); a conflict is a write or move of something overlapping p
// while a loan is in force. Slice scope: view lets, for-in loops, callback bodies and raw pointers into a local's buffer,
// against method calls, assignments and moves of a local place. Reads the place graph of src/place-cfg.ts.
import type { Expr, Function, Program, Span } from "./ast";
import type { CheckResult } from "./checker";
import * as text from "./borrow-diagnostics";
import { NO_TYPE } from "./move-flow";
import { callEffects, type AnalysisHost } from "./borrow-flow-park";
import { Builder, liveness, overlaps, type InheritedLoan, type Node, type Place, type PlaceCfgHost } from "./place-cfg";

export interface BorrowFlowResult {
  diagnostics: { span: Span | undefined; message: string; hint?: string }[];
}

// "v#3.name" -> "v".
const rootName = (p: Place): string => p.slice(0, p.indexOf("#"));

type Env = Builder["closureEnvs"] extends Map<unknown, infer V> ? V : never;

// `inherit`: the writing closures a closure body captures (from the builder of the body that made the literal).
function analyzeBody(cr: CheckResult, host: PlaceCfgHost, params: Parameters<Builder["fn"]>[0], body: Parameters<Builder["fn"]>[1], out: BorrowFlowResult, seen: Set<string>, inherit?: Env, callback?: Builder["callbackLoan"], loans?: InheritedLoan[], effects?: Builder["effects"], globals: Set<string> = new Set()): Builder {
  const b = new Builder(cr, host, true);
  b.inheritedWrites = inherit;
  b.callbackLoan = callback;
  b.effects = effects;
  b.mutableGlobals = globals;
  b.inheritedLoans = loans;
  b.fn(params, body);
  const nodes = b.nodes;
  if (!nodes.some(n => n.loan !== undefined)) return b;
  const liveIn = liveness(nodes);

  // A move of a local binding: a non-Copy value taken by value out of it.
  const moves = (n: Node): boolean => {
    const e = n.expr;
    if (e === undefined || e.kind !== "Ident" || n.use === undefined || n.capture || n.subject || n.armTakes) return false;
    if (cr.movedExprs.has(e)) return true;
    if (!cr.movePositions.has(e) || b.borrowed.has(n.use)) return false;
    const t = cr.exprTypes.get(e);
    return t !== undefined && t.tag !== "unknown" && t.tag !== "ref" && !host.isCopyType(t);
  };

  // Forward: the loans in force, each as "opening node@place" (a moved pointer's loan changes place),
  // whose holder has not been redefined since.
  const keyOf = (node: number, place: Place) => `${node}@${place}`;
  const originOf = (k: string) => Number(k.slice(0, k.indexOf("@")));
  const placeOfKey = (k: string) => k.slice(k.indexOf("@") + 1);
  const state: (Set<string> | undefined)[] = nodes.map(() => undefined);
  state[0] = new Set();
  const work = [0];
  while (work.length > 0) {
    const i = work.pop()!;
    const n = nodes[i]!;
    const out2 = new Set(state[i]!);
    if (n.def !== undefined) {
      for (const l of [...out2]) { const h = nodes[originOf(l)]!.loan!.holder!; if (h === n.def || h.startsWith(n.def + ".")) out2.delete(l); }
    }
    // Moving a local keeps its buffer where it is, so pointers into it stay valid: they end with the
    // source, or follow it into the binding that took it (`let w = v`). Only when every loan on it is
    // a pointer; any other loan makes the move itself the error.
    if (n.use !== undefined && (moves(n) || n.hardMove)) {
      const root = rootName(n.use);
      const on = [...out2].filter(k => rootName(placeOfKey(k)) === root);
      if (on.length > 0 && on.every(k => nodes[originOf(k)]!.loan!.kind === "pointer")) {
        for (const k of on) {
          out2.delete(k);
          if (n.carryTo !== undefined && !n.hardMove) out2.add(keyOf(originOf(k), n.carryTo + placeOfKey(k).slice(n.use.length)));
        }
      }
    }
    if (n.loan?.kind === "view" || n.loan?.kind === "pointer") out2.add(keyOf(i, n.loan.place));
    for (const s of n.succ) {
      const prev = state[s];
      if (prev === undefined) { state[s] = new Set(out2); work.push(s); continue; }
      let grew = false;
      for (const l of out2) if (!prev.has(l)) { prev.add(l); grew = true; }
      if (grew) work.push(s);
    }
  }

  // A closure made while a view of one capture is held by another: its body sees that loan too.
  nodes.forEach((n, i) => {
    if (!n.capture || n.expr?.kind !== "Closure") return;
    const caps = new Set((cr.closureCaptures.get(n.expr) ?? []).map(k => k.name));
    for (const k of state[i] ?? []) {
      const ln = nodes[originOf(k)]!.loan!;
      const holder = rootName(ln.holder!), root = rootName(placeOfKey(k));
      if (ln.kind !== "view" || !caps.has(holder) || !caps.has(root)) continue;
      const list = b.closureLoans.get(n.expr) ?? [];
      const path = placeOfKey(k).slice(placeOfKey(k).indexOf("#")).replace(/^#\d+/, "");
      if (!list.some(x => x.holder === holder && x.root === root && x.path === path)) list.push({ holder, root, path, name: ln.name!, anon: ln.anon === true });
      b.closureLoans.set(n.expr, list);
    }
  });
  const holderLiveAfter = (n: Node, holder: Place): boolean => {
    for (const s of n.succ) for (const p of liveIn[s]!) if (overlaps(p, holder)) return true;
    return false;
  };
  // The earliest loan in force at node `i` that overlaps `place`. An element write is not a conflict with a
  // view (it never reallocates) but is with a pointer (another thread may be writing through it); a write
  // inside `unsafe` is the one the checker lets through a pointer.
  const conflicting = (i: number, place: Place, elem: boolean, unsafe = false, pointers = true): Node | null => {
    const n = nodes[i]!;
    const found: number[] = [];
    for (const k of state[i] ?? []) {
      const l = originOf(k);
      const ln = nodes[l]!;
      const kind = ln.loan!.kind;
      if ((kind === "view" ? elem : unsafe || !pointers) || !overlaps(placeOfKey(k), place) || !holderLiveAfter(n, ln.loan!.holder!)) continue;
      found.push(l);
    }
    for (let l = 0; l <= i; l++) {
      const ln = nodes[l]!;
      if ((ln.loan?.kind === "iteration" || (ln.loan?.kind === "callback" && !elem)) && ln.iterEnd !== undefined && i < ln.iterEnd && overlaps(ln.loan.place, place)) found.push(l);
    }
    found.sort((x, y) => x - y);
    return found.length === 0 ? null : nodes[found[0]!]!;
  };
  // A call that parks, with a reference into a global's buffer held across it.
  const globalHeld = (i: number): Node[] => {
    const n = nodes[i]!;
    return [...(state[i] ?? [])].map(k => nodes[originOf(k)]!).filter(l => l.loan!.place.endsWith("#g") && holderLiveAfter(n, l.loan!.holder!)).sort((x, y) => nodes.indexOf(x) - nodes.indexOf(y));
  };
  const report = (span: Span | undefined, t: text.BorrowText) => {
    const key = `${span?.file}:${span?.line}:${span?.col}:${t.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.diagnostics.push({ span, ...t });
  };
  const emit = (loan: Node, prefix: string, root: string, span: Span | undefined) => {
    const l = loan.loan!;
    if (l.anon) { report(span, text.unattributed(prefix, root)); return; }
    report(span, l.kind === "view" || l.kind === "callback" ? text.whileHolderBorrows(prefix, root, l.name!) : text.whileLoopIterates(prefix, root));
  };

  nodes.forEach((n, i) => {
    const w = n.write;
    if (w !== undefined) {
      const loan = conflicting(i, w.place, w.kind === "elem", w.unsafe);
      if (loan === null) return;
      const root = rootName(w.place);
      const l = loan.loan!;
      if (l.kind === "pointer") report(w.span, text.pointerConflict(w.kind === "place" ? "call" : w.kind, w.kind === "closure" ? `${w.via} '${w.fname}'` : w.text, root, l.name!, l.call!, l.line!));
      else if (w.kind === "closure") emit(loan, text.closureWritePrefix(root, w.via!, w.fname!), root, w.span);
      else if (w.kind === "call") emit(loan, text.callPrefix(w.method!, root), root, w.span);
      else if (w.kind === "place") emit(loan, text.actionPrefix(w.action!, root), root, w.span);
      else if (w.kind === "elem") report(w.span, text.elemAssignWhileIterated(w.text, root));
      else emit(loan, text.assignPrefix(w.text), root, w.span);
    }
    if (n.effect?.parks) {
      for (const l of globalHeld(i)) {
        const g = rootName(l.loan!.place);
        report(n.effect.span, text.parkWhileHeld(n.effect.say, g, l.loan!.name!, l.loan!.kind === "pointer" ? l.loan!.call : undefined, l.loan!.line));
      }
    }
    if (moves(n)) {
      const e = n.expr as Expr & { kind: "Ident" };
      const loan = conflicting(i, n.use!, false, false, false);
      if (loan !== null) emit(loan, text.movePrefix(e.name), e.name, e.span);
    }
  });
  return b;
}

// Every closure literal in a body, nested ones too (src/move-flow.ts closuresIn, but the literal itself so its captures can be looked up).
function closureLiterals(body: unknown): (Expr & { kind: "Closure" })[] {
  const out: (Expr & { kind: "Closure" })[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.kind === "Closure") out.push(o as unknown as Expr & { kind: "Closure" });
    for (const k in o) if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType") visit(o[k]);
  };
  visit(body);
  return out;
}

export function borrowFlow(program: Program, cr: CheckResult, host: PlaceCfgHost & AnalysisHost): BorrowFlowResult {
  const out: BorrowFlowResult = { diagnostics: [] };
  const { globals, effects } = callEffects(program, host);
  const fns: Function[] = [...program.functions, ...program.impls.flatMap(i => i.methods), ...cr.monomorphizedFns];
  const fnSeen = new Set<Function>();
  const reported = new Set<string>();
  for (const f of fns) {
    if (fnSeen.has(f) || !f.body) continue;
    fnSeen.add(f);
    const top = analyzeBody(cr, host, f.params, f.body, out, reported, undefined, undefined, undefined, effects, globals);
    // A closure body names the enclosing places it captures: they are places of its own graph too.
    for (const c of closureLiterals(f.body)) analyzeBody(cr, host, [...c.params.map(p => ({ ...p, type: { ...(p.type ?? NO_TYPE), isRef: true } })), ...(cr.closureCaptures.get(c) ?? []).map(k => ({ name: k.name, type: null }))], c.body, out, reported, top.closureEnvs.get(c), top.callbackOf.get(c), top.closureLoans.get(c), effects, globals);
  }
  return out;
}
