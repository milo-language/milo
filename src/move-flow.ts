// Move analysis as dataflow (docs/plans/move-dataflow.md): the move-or-share decision for strings and
// the use-after-move rules, read off the place graph and liveness in src/place-cfg.ts. Runs after the
// checker on the rewritten tree and reads only CheckResult facts.
import type { Expr, Function, Param, Program, Span, Stmt } from "./ast";
import * as text from "./move-diagnostics";
import type { CheckResult } from "./checker";
import { Builder, liveness, overlaps, type Node, type Place, type PlaceCfgHost } from "./place-cfg";


export interface MoveFlowResult {
  // Each string-typed move position on a local place, and whether something overlapping it is read later.
  stringDecisions: Map<Expr, "move" | "share">;
  // The same decision for each string a `move` closure captures: closure literal -> capture name -> decision.
  captureDecisions: Map<Expr, Map<string, "move" | "share">>;
  // A use of a place that a move may have emptied on some path that reaches it: `use` is the reading
  // expression (or the closure that captures it), `movedAt` the move.
  useAfterMove: { use: Expr; place: string; movedAt: Expr }[];
  // The checker's wording for each of them (src/move-diagnostics.ts), at the span it reports.
  diagnostics: { span: Span | undefined; message: string; hint?: string }[];
}

export type MoveFlowHost = PlaceCfgHost;

export const NO_TYPE = { name: "", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };

// Forward maybe-moved: the places some path to a node has moved out of and not reassigned since, each
// with the move. A use of anything overlapping one is a use after move. A move that reaches a use only
// around a loop's back edge is the loop repeating it: `loop` is that loop's head.
interface Moved { at: Expr; atNode: Node; loop: number | null }

function maybeMoved(b: Builder, moves: (n: Node) => boolean, report: (n: Node, place: Place, m: Moved, p: Place) => void): void {
  const nodes = b.nodes;
  const state: (Map<Place, Moved> | undefined)[] = nodes.map(() => undefined);
  state[0] = new Map();
  const work = [0];
  const seen = new Set<Node>();
  while (work.length > 0) {
    const i = work.pop()!;
    const n = nodes[i]!;
    const cur = new Map(state[i]!);
    if (n.use !== undefined) {
      const used = n.use;
      for (const [p, m] of cur) {
        // An arm taking the payload is the subject's own use again: the subject node already reported it.
        if (!overlaps(p, used) || seen.has(n) || n.expr === undefined || n.armTakes) continue;
        seen.add(n);
        report(n, used, m, p);
      }
      if (moves(n)) {
        for (const p of [...cur.keys()]) if (p.startsWith(used + ".")) cur.delete(p);
        cur.set(used, { at: n.expr!, atNode: n, loop: null });
      }
    }
    if (n.def !== undefined) for (const p of [...cur.keys()]) if (p === n.def || p.startsWith(n.def + ".")) cur.delete(p);
    for (const sIdx of n.succ) {
      const back = b.backEdges.has(`${i}>${sIdx}`);
      const prev = state[sIdx];
      let grew = prev === undefined;
      const into = prev ?? new Map<Place, Moved>();
      for (const [p, m] of cur) {
        const carried = back && m.loop === null ? { ...m, loop: sIdx } : m;
        const had = into.get(p);
        // A move that also arrives without going around the loop is an ordinary use after move.
        if (had === undefined) { into.set(p, carried); grew = true; }
        else if (had.loop !== null && carried.loop === null) { into.set(p, carried); grew = true; }
      }
      state[sIdx] = into;
      if (grew) work.push(sIdx);
    }
  }
}

// "v#3.name.first" -> the binding's name and the field path: ["v", ".name.first"].
function display(p: Place): [string, string] {
  const dot = p.indexOf(".");
  const root = dot < 0 ? p : p.slice(0, dot);
  return [root.slice(0, root.indexOf("#")), dot < 0 ? "" : p.slice(dot)];
}

// The innermost object of a field chain: the binding's own identifier.
function rootExpr(e: Expr): Expr {
  return e.kind === "FieldAccess" ? rootExpr(e.object) : e;
}

function analyzeBody(cr: CheckResult, host: MoveFlowHost, params: Param[], body: Stmt[], out: MoveFlowResult): void {
  const b = new Builder(cr, host);
  b.fn(params, body);
  const liveIn = liveness(b.nodes);
  // A move empties its place: a non-Copy value taken by value out of a place this body owns. Strings
  // never empty one: a string at a move position moves only when nothing reads it again (below).
  const moves = (n: Node): boolean => {
    if (n.hardMove) return true;
    if (n.capture) return n.captureMove === true;
    if (n.subject) return false;
    if (n.expr === undefined || n.use === undefined || !cr.movePositions.has(n.expr)) return false;
    const t = cr.exprTypes.get(n.expr);
    // An unknown type is a binding a type error already reported: no second error cascades from it.
    return t !== undefined && t.tag !== "string" && t.tag !== "unknown" && !host.isCopyType(t) && !b.borrowed.has(n.use.split(".")[0]!);
  };
  // A string at a move position shares when its place is borrowed or something overlapping it is read later.
  const shareAfter = (n: Node): boolean => {
    const used = n.use!;
    if (b.borrowed.has(used.split(".")[0]!)) return true;
    for (const s of n.succ) for (const p of liveIn[s]!) if (overlaps(p, used)) return true;
    return false;
  };
  const loopsReported = new Set<string>();
  maybeMoved(b, moves, (n, used, m, movedPlace) => {
    const use = n.expr!;
    out.useAfterMove.push({ use, place: used, movedAt: m.at });
    const [name, usePath] = display(used);
    const [, gonePath] = display(movedPlace);
    let t: text.MoveText;
    let span = use.span;
    if (m.loop !== null) {
      const key = `${m.loop}|${movedPlace}`;
      if (loopsReported.has(key)) return;
      loopsReported.add(key);
      t = text.moveOutOfLoop(name + gonePath);
      span = b.loopSpans.get(m.loop);
    } else if (n.callee !== undefined) {
      t = text.calledAfterMove(n.callee, cr.exprTypes.get(m.at), m.atNode.callee !== undefined);
    } else if (n.capture && n.firstUse !== undefined) {
      span = n.firstUse.span;
      t = text.usedAfterMove(name, cr.exprTypes.get(n.firstUse) ?? { tag: "unknown" }, cr.structs, t2 => host.show(t2), m.atNode.armTakes === true && m.atNode.plainTake !== true);
    } else if (n.viaClosure !== undefined) {
      const v = n.viaClosure;
      t = text.captureUsedAfterMove(v.fname, v.cap, v.path, gonePath === "" ? null : gonePath);
    } else if (gonePath === "") {
      t = text.usedAfterMove(name, cr.exprTypes.get(rootExpr(use)) ?? { tag: "unknown" }, cr.structs, t2 => host.show(t2), m.atNode.armTakes === true && m.atNode.plainTake !== true);
    } else if (usePath === "") {
      // Moving it whole reads it whole first: both are reported, as the checker does.
      if (moves(n)) out.diagnostics.push({ span, ...text.incomplete(name, gonePath) });
      t = moves(n) ? text.moveOfIncomplete(name, gonePath) : text.incomplete(name, gonePath);
    } else {
      t = text.fieldUsedAfterMove(name, usePath, gonePath);
    }
    out.diagnostics.push({ span, ...t });
  });
  b.nodes.forEach(n => {
    if (n.captureString !== undefined && n.expr !== undefined && n.use !== undefined) {
      let byName = out.captureDecisions.get(n.expr);
      if (byName === undefined) { byName = new Map(); out.captureDecisions.set(n.expr, byName); }
      byName.set(n.captureString, shareAfter(n) ? "share" : "move");
      return;
    }
    if (n.capture || n.armTakes || n.expr === undefined || n.use === undefined || !cr.movePositions.has(n.expr)) return;
    if (cr.exprTypes.get(n.expr)?.tag !== "string") return;
    out.stringDecisions.set(n.expr, shareAfter(n) ? "share" : "move");
  });
}

// Every closure literal in a body: each is a function of its own, analyzed separately.
export function closuresIn(body: Stmt[]): { params: Param[]; body: Stmt[] }[] {
  const out: { params: Param[]; body: Stmt[] }[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.kind === "Closure") out.push({ params: o.params as Param[], body: o.body as Stmt[] });
    for (const k in o) if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType") visit(o[k]);
  };
  visit(body);
  return out;
}

export function moveFlow(program: Program, cr: CheckResult, host: MoveFlowHost): MoveFlowResult {
  const out: MoveFlowResult = { stringDecisions: new Map(), captureDecisions: new Map(), useAfterMove: [], diagnostics: [] };
  const fns: Function[] = [...program.functions, ...program.impls.flatMap(i => i.methods), ...cr.monomorphizedFns];
  const seen = new Set<Function>();
  for (const f of fns) {
    if (seen.has(f) || !f.body) continue;
    seen.add(f);
    analyzeBody(cr, host, f.params, f.body, out);
    // A closure receives its arguments however the callee hands them over (`mapErr` lends its error),
    // so its params are treated as borrows: a string read out of one is always a share.
    for (const c of closuresIn(f.body)) analyzeBody(cr, host, c.params.map(p => ({ ...p, type: { ...(p.type ?? NO_TYPE), isRef: true } })), c.body, out);
  }
  return out;
}

// Writes the string decisions into the sets codegen and the interpreter read: a move hands the buffer
// over, a share takes another count on it.
export function applyStringDecisions(cr: CheckResult, flow: MoveFlowResult): void {
  for (const [e, d] of flow.stringDecisions) {
    if (d === "move") { cr.sharedStringExprs.delete(e); cr.movedExprs.add(e); }
    else { cr.movedExprs.delete(e); cr.sharedStringExprs.add(e); }
  }
  for (const [closure, byName] of flow.captureDecisions) {
    let names = cr.sharedStringCaptures.get(closure);
    for (const [name, d] of byName) {
      if (d === "move") { if (names !== undefined) names.delete(name); continue; }
      if (names === undefined) { names = new Set(); cr.sharedStringCaptures.set(closure, names); }
      names.add(name);
    }
    if (names !== undefined && names.size === 0) cr.sharedStringCaptures.delete(closure);
  }
}
