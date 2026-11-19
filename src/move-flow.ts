// Move analysis as dataflow (docs/plans/move-dataflow.md): a control-flow graph of place events per
// function body, backward liveness to a fixpoint, and the move-or-share decision for strings read off
// it. Runs after the checker on the rewritten tree and reads only CheckResult facts.
import type { Expr, Function, Param, Pattern, Program, Span, Stmt } from "./ast";
import type { TypeKind } from "./types";
import * as text from "./move-diagnostics";
import { patternLeafNames } from "./ast";
import type { CheckResult } from "./checker";

// A place is a local binding plus a static field path: "v#3" or "v#3.name.first".
type Place = string;

interface Node {
  // What the node does, in evaluation order: at most one event per node keeps the transfer simple.
  use?: Place; // a read, borrow or move of the place (all keep everything overlapping it live)
  def?: Place; // a declaration or assignment: the place holds a fresh value afterwards
  expr?: Expr; // the expression of a use, so a decision can be looked up per expression
  capture?: boolean; // a closure literal capturing the place; `expr` is the closure
  captureMove?: boolean; // a capture taken by a `move` closure: the use consumes the place
  captureString?: string; // a string captured by a `move` closure at a move position: moved or shared by liveness
  hardMove?: boolean; // consumes the place whatever its type: `forget(s)`, `*h`, calling a call-once closure
  // A read of a capture through closure binding `fname` (when it is used or called): the closure reads `path` of it.
  viaClosure?: { fname: string; cap: string; path: string };
  callee?: string; // the call of a local closure binding named this
  subject?: boolean; // a match subject's evaluation: never a move itself, see `armTakes`
  armTakes?: boolean; // the start of an arm whose pattern binds: the payload is taken from the subject here
  plainTake?: boolean;
  firstUse?: Expr; // a closure literal's capture: where the body first names it (what an error points at)
  succ: number[];
}

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

export interface MoveFlowHost {
  isCopyType(t: TypeKind): boolean;
  show(t: TypeKind): string;
}

const NO_TYPE = { name: "", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
const overlaps = (a: Place, b: Place) => a === b || a.startsWith(b + ".") || b.startsWith(a + ".");

class Builder {
  nodes: Node[] = [];
  // Bindings that hold a borrow (`&T` / `&mut T` params): a string read out of one is always a share,
  // a local rule that needs no flow.
  borrowed = new Set<Place>();
  // A binding holding a by-reference closure: what it captures, so every use of the binding reads them.
  private closureCaps = new Map<Place, { fname: string; reads: { cap: string; place: Place; path: string }[] }>();
  // A binding holding a `move` closure whose body moves a capture out: calling it consumes it.
  private callsOnce = new Set<Place>();
  private scopes: Map<string, string>[] = [];
  private loops: { head: number; breaks: number[] }[] = [];
  // Edges that return to a loop head ("from>to"), and each head's loop statement span.
  backEdges = new Set<string>();
  loopSpans = new Map<number, Span | undefined>();
  private backTo(from: number, head: number): void {
    this.nodes[from]!.succ.push(head);
    this.backEdges.add(`${from}>${head}`);
  }
  private exits: number[] = []; // nodes that leave the function (return, `?`)
  private ids = 0;

  constructor(private cr: CheckResult, private host: MoveFlowHost) {}

  private node(n: Omit<Node, "succ">, from: number): number {
    const id = this.nodes.length;
    this.nodes.push({ ...n, succ: [] });
    if (from >= 0) this.nodes[from]!.succ.push(id);
    return id;
  }
  // A join point with no event.
  private join(froms: number[]): number {
    const live = froms.filter(f => f >= 0);
    if (live.length === 0) return -1;
    const id = this.node({}, -1);
    for (const f of live) this.nodes[f]!.succ.push(id);
    return id;
  }

  declare(name: string): Place {
    const id = `${name}#${this.ids++}`;
    this.scopes[this.scopes.length - 1]!.set(name, id);
    return id;
  }
  private lookup(name: string): Place | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const p = this.scopes[i]!.get(name);
      if (p !== undefined) return p;
    }
    return null; // a global, a function or a type name: not a local place
  }
  private scoped<T>(f: () => T): T {
    this.scopes.push(new Map());
    try { return f(); } finally { this.scopes.pop(); }
  }

  // The place an expression names, when it is a local binding or a static field chain of struct fields off one.
  placeOf(e: Expr): Place | null {
    if (e.kind === "Ident") return this.lookup(e.name);
    if (e.kind === "FieldAccess") {
      const bt = this.cr.exprTypes.get(e.object);
      if (!bt || bt.tag !== "struct") return null;
      const base = this.placeOf(e.object);
      return base === null ? null : `${base}.${e.field}`;
    }
    return null;
  }

  fn(params: { name: string; type: { isRef: boolean; isRefMut: boolean } | null }[], body: Stmt[]): void {
    this.scoped(() => {
      let cur = this.node({}, -1);
      for (const p of params) {
        const id = this.declare(p.name);
        if (p.type && (p.type.isRef || p.type.isRefMut)) this.borrowed.add(id);
        cur = this.node({ def: id }, cur);
      }
      cur = this.stmts(body, cur);
      const exit = this.join([cur, ...this.exits]);
      if (exit >= 0) this.nodes[exit]!.succ = [];
    });
  }

  stmts(list: Stmt[], cur: number): number {
    return this.scoped(() => { for (const s of list) cur = this.stmt(s, cur); return cur; });
  }

  // A payload bound from a subject the match does not consume (a borrow, or a place left in place) is a view.
  private subjectLends(subject: Expr): boolean {
    if (this.cr.matchSubjectRef.has(subject)) return true;
    const p = this.placeOf(subject);
    return p !== null && (this.borrowed.has(p.split(".")[0]!) || !this.cr.movePositions.has(subject));
  }

  // `inChain`: a let-chain clause, whose take the checker words as a plain transfer, not a pattern move.
  private bindPattern(p: Pattern, cur: number, subject: Expr, inChain = false): number {
    const views = this.subjectLends(subject);
    // A pattern that binds takes the payload only on the path where it matched.
    const sp = this.placeOf(subject);
    if (sp !== null && patternLeafNames(p).some(n => n !== "_")) cur = this.node({ use: sp, expr: subject, armTakes: true, plainTake: inChain }, cur);
    for (const name of patternLeafNames(p)) {
      if (name === "_") continue;
      const id = this.declare(name);
      if (views) this.borrowed.add(id);
      cur = this.node({ def: id }, cur);
    }
    return cur;
  }

  stmt(s: Stmt, cur: number): number {
    if (cur < 0) return cur; // unreachable code adds nothing to any live path
    switch (s.kind) {
      case "LetDecl": case "VarDecl": {
        cur = this.expr(s.value, cur);
        const id = this.declare(s.name);
        if (s.value.kind === "Closure") this.noteClosure(id, s.value);
        // `let x = v[i]` aliases the element; a reference binding (`let a = s[i..j]`) views another place.
        if (this.cr.viewLets.has(s) || this.cr.refLets.has(s)) this.borrowed.add(id);
        return this.node({ def: id }, cur);
      }
      case "Assign": {
        cur = this.expr(s.value, cur);
        const target = this.placeOf(s.target);
        if (target !== null) return this.node({ def: target }, cur);
        return this.expr(s.target, cur); // `v[i] = x`, `*p = x`: the base is read, nothing is redefined
      }
      case "Return": {
        if (s.value) cur = this.expr(s.value, cur);
        if (cur >= 0) this.exits.push(cur);
        return -1;
      }
      case "ExprStmt": return this.expr(s.expr, cur);
      case "BreakStmt": { const l = this.loops[this.loops.length - 1]; if (l && cur >= 0) l.breaks.push(cur); return -1; }
      case "ContinueStmt": { const l = this.loops[this.loops.length - 1]; if (l && cur >= 0) this.backTo(cur, l.head); return -1; }
      case "UnsafeBlock": return this.stmts(s.body, cur);
      case "IfStmt": {
        cur = this.expr(s.cond, cur);
        const a = this.stmts(s.thenBody, cur);
        const b = s.elseBody ? this.stmts(s.elseBody, cur) : cur;
        return this.join([a, b]);
      }
      case "IfLetStmt": {
        cur = this.subjectOf(s.subject, cur);
        const a = this.scoped(() => this.stmts(s.thenBody, this.bindPattern(s.pattern, cur, s.subject)));
        const b = s.elseBody ? this.stmts(s.elseBody, cur) : cur;
        return this.join([a, b]);
      }
      case "IfChainStmt": {
        // Each clause can fail into the else; the bindings are in scope for later clauses and the then-body.
        const fails: number[] = [];
        const then = this.scoped(() => {
          let c = cur;
          for (const cl of s.clauses) {
            if (cl.kind === "LetClause") { c = this.subjectOf(cl.subject, c); fails.push(c); c = this.bindPattern(cl.pattern, c, cl.subject, true); }
            else { c = this.expr(cl.cond, c); fails.push(c); }
          }
          return this.stmts(s.thenBody, c);
        });
        const failed = this.join(fails);
        const els = s.elseBody ? this.stmts(s.elseBody, failed) : failed;
        return this.join([then, els]);
      }
      case "LetElseStmt": {
        cur = s.bindName ? this.expr(s.value, cur) : this.subjectOf(s.value, cur);
        this.stmts(s.elseBody, cur); // diverges: its end is never a successor of anything after
        if (s.bindName) return this.node({ def: this.declare(s.bindName) }, cur);
        return this.bindPattern(s.pattern, cur, s.value);
      }
      case "MatchStmt": return this.match(s.subject, s.arms, cur);
      case "WhileStmt": {
        const head = this.join([cur]);
        const afterCond = this.expr(s.cond, head);
        this.loops.push({ head, breaks: [] });
        this.loopSpans.set(head, s.span);
        const end = this.stmts(s.body, afterCond);
        if (end >= 0) this.backTo(end, head);
        const { breaks } = this.loops.pop()!;
        return this.join([afterCond, ...breaks]);
      }
      case "ForInStmt": {
        cur = this.expr(s.iterable, cur);
        const head = this.join([cur]);
        this.loops.push({ head, breaks: [] });
        this.loopSpans.set(head, s.span);
        const end = this.scoped(() => {
          // Elements of a container the loop does not consume stay in it: the bindings are views.
          const views = !this.cr.consumingForIns.has(s) && !this.cr.iteratorForIns.has(s);
          const bind = (name: string, c: number) => { const id = this.declare(name); if (views) this.borrowed.add(id); return this.node({ def: id }, c); };
          let c = bind(s.varName, head);
          if (s.varName2) c = bind(s.varName2, c);
          return this.stmts(s.body, c);
        });
        if (end >= 0) this.backTo(end, head);
        const { breaks } = this.loops.pop()!;
        return this.join([head, ...breaks]);
      }
    }
  }

  private noteClosure(id: Place, c: Expr & { kind: "Closure" }): void {
    const caps = this.cr.closureCaptures.get(c) ?? [];
    if (c.isMove !== true) {
      const reads: { cap: string; place: Place; path: string }[] = [];
      for (const k of caps) {
        const p = this.lookup(k.name);
        if (p === null) continue;
        // What the body reads of the capture: the whole value unless only fields of it.
        const paths = k.readPaths !== undefined && k.readPaths.size > 0 ? [...k.readPaths] : [""];
        for (const path of paths) reads.push({ cap: k.name, place: p + path, path });
      }
      if (reads.length > 0) this.closureCaps.set(id, { fname: id.split("#")[0]!, reads });
      return;
    }
    // A move closure owns its captures; if its body moves one out, the first call uses it up.
    const names = new Set(caps.filter(k => !this.host.isCopyType(k.type)).map(k => k.name));
    let consumes = false;
    const visit = (v: unknown): void => {
      if (consumes || v === null || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      const o = v as Record<string, unknown>;
      if (o.kind === "Ident" && names.has(o.name as string) && this.cr.movedExprs.has(o as unknown as Expr)) { consumes = true; return; }
      for (const k in o) if (k !== "span") visit(o[k]);
    };
    visit(c.body);
    if (consumes) this.callsOnce.add(id);
  }

  // Each use of a binding holding a by-reference closure reads the places the closure captured.
  private readCaptures(place: Place, e: Expr, cur: number): number {
    const c = this.closureCaps.get(place);
    if (c === undefined) return cur;
    for (const r of c.reads) cur = this.node({ use: r.place, expr: e, capture: true, viaClosure: { fname: c.fname, cap: r.cap, path: r.path } }, cur);
    return cur;
  }

  // A pattern's subject: evaluating it reads it; a binding arm takes from it (bindPattern).
  private subjectOf(subject: Expr, cur: number): number {
    const before = this.nodes.length;
    cur = this.expr(subject, cur);
    if (cur >= before && this.placeOf(subject) !== null) this.nodes[cur]!.subject = true;
    return cur;
  }

  private match(subject: Expr, arms: { pattern: Pattern; body: Stmt[] }[], cur: number): number {
    cur = this.subjectOf(subject, cur);
    const ends = arms.map(arm => this.scoped(() => this.stmts(arm.body, this.bindPattern(arm.pattern, cur, subject))));
    return this.join(ends);
  }

  // A place passed by borrow stays read until the callee returns, so a string moved by an earlier
  // argument of the same call is still live: `f(s, s)` with `f(a: &string, b: string)` must share
  // the second `s`, or `a` reads the buffer `b` owns. The read node has no expression: it only keeps
  // the place live (the argument's own node reports a use after move). A by-reference closure
  // argument, a literal or a binding, reads what it captures whenever the callee runs it.
  private lend(args: Expr[], cur: number): number {
    for (const a of args) {
      if (cur < 0) return cur;
      if (a.kind === "Closure" && a.isMove !== true) {
        for (const c of this.cr.closureCaptures.get(a) ?? []) {
          const p = this.lookup(c.name);
          if (p !== null) cur = this.node({ use: p }, cur);
        }
        continue;
      }
      const p = this.placeOf(a);
      if (p === null) continue;
      if (!this.cr.movePositions.has(a)) cur = this.node({ use: p }, cur);
      // Passed by value or not, a by-reference closure still reads its captures when it runs.
      const caps = this.closureCaps.get(p);
      if (caps !== undefined) for (const r of caps.reads) cur = this.node({ use: r.place }, cur);
    }
    return cur;
  }

  // A fork expression's value is its last statement; its blocks are statement lists like any other.
  expr(e: Expr, cur: number): number {
    if (cur < 0) return cur;
    const place = this.placeOf(e);
    if (place !== null) return this.readCaptures(place, e, this.node({ use: place, expr: e }, cur));
    switch (e.kind) {
      case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit": case "Ident": return cur;
      case "BinOp": {
        cur = this.expr(e.left, cur);
        if (e.op === "&&" || e.op === "||") return this.join([cur, this.expr(e.right, cur)]);
        return this.expr(e.right, cur);
      }
      case "UnaryOp": {
        // `*h` taken by value moves the payload out of the Heap: `h` is spent. Through a raw pointer
        // (unsafe) it is a read: the pointer owns nothing.
        const inner = e.op === "*" && this.cr.exprTypes.get(e.operand)?.tag !== "ptr" ? this.placeOf(e.operand) : null;
        if (inner !== null && this.cr.movePositions.has(e)) {
          const t = this.cr.exprTypes.get(e);
          if (t !== undefined && !this.host.isCopyType(t)) return this.node({ use: inner, expr: e.operand, hardMove: true }, cur);
        }
        return this.expr(e.operand, cur);
      }
      case "Unwrap": case "CastExpr": case "IsExpr": return this.expr(e.operand, cur);
      case "Propagate": {
        cur = this.expr(e.operand, cur);
        if (cur >= 0) this.exits.push(cur);
        return cur;
      }
      case "DefaultValue": { cur = this.expr(e.operand, cur); return this.join([cur, this.expr(e.default, cur)]); }
      case "EnumLit": { for (const a of e.args) cur = this.expr(a, cur); return cur; }
      // A call whose type is never (exit, panic) ends the path: nothing after it reads anything.
      case "Call": {
        // `forget(x)` ends x's ownership without dropping it: a move whatever the type, a string included.
        const forgotten = e.func === "forget" && e.args.length === 1 ? this.placeOf(e.args[0]!) : null;
        if (forgotten !== null) return this.node({ use: forgotten, expr: e.args[0]!, hardMove: true }, cur);
        for (const a of e.args) cur = this.expr(a, cur);
        cur = this.lend(e.args, cur);
        // Calling a local closure reads it (and what it captures); a call-once closure is spent by the call.
        const callee = this.lookup(e.func);
        if (callee !== null) cur = this.readCaptures(callee, e, this.node({ use: callee, expr: e, capture: true, callee: e.func, hardMove: this.callsOnce.has(callee) }, cur));
        return this.cr.exprTypes.get(e)?.tag === "never" ? -1 : cur;
      }
      case "MethodCall": {
        cur = this.expr(e.object, cur);
        for (const a of e.args) cur = this.expr(a, cur);
        cur = this.lend([e.object, ...e.args], cur);
        return this.cr.exprTypes.get(e)?.tag === "never" ? -1 : cur;
      }
      case "StructLit": { for (const f of e.fields) cur = this.expr(f.value, cur); return e.base ? this.expr(e.base, cur) : cur; }
      case "FieldAccess": return this.expr(e.object, cur);
      case "IndexAccess": return this.expr(e.index, this.expr(e.object, cur));
      case "ArrayLit": { for (const x of e.elements) cur = this.expr(x, cur); return cur; }
      case "ArrayRepeat": return this.expr(e.value, cur);
      case "RangeExpr": return this.expr(e.end, this.expr(e.start, cur));
      case "IfExpr": {
        cur = this.expr(e.cond, cur);
        return this.join([this.stmts(e.thenBody, cur), this.stmts(e.elseBody, cur)]);
      }
      case "MatchExpr": return this.match(e.subject, e.arms, cur);
      case "Closure": {
        // Creating a closure reads what it captures. Its body runs at calls, which this slice treats
        // as reads of the captures too: see the closure-binding note in docs/plans/move-dataflow.md.
        for (const c of this.cr.closureCaptures.get(e) ?? []) {
          const p = this.lookup(c.name);
          if (p !== null) cur = this.node({ use: p, expr: e, capture: true, firstUse: firstIdent(e.body, c.name), captureMove: e.isMove === true && !this.host.isCopyType(c.type) && c.type.tag !== "string", captureString: e.isMove === true && c.type.tag === "string" && this.cr.movePositions.has(e) ? c.name : undefined }, cur);
        }
        return cur;
      }
    }
  }
}

// Backward liveness: live-in = uses ∪ (live-out − defs), to a fixpoint.
function liveness(nodes: Node[]): Set<Place>[] {
  const preds: number[][] = nodes.map(() => []);
  nodes.forEach((n, i) => { for (const s of n.succ) preds[s]!.push(i); });
  const liveIn = nodes.map(() => new Set<Place>());
  const work = nodes.map((_, i) => i).reverse();
  const queued = new Set(work);
  while (work.length > 0) {
    const i = work.pop()!;
    queued.delete(i);
    const n = nodes[i]!;
    const next = new Set<Place>();
    for (const s of n.succ) for (const p of liveIn[s]!) next.add(p);
    if (n.def !== undefined) for (const p of [...next]) if (p === n.def || p.startsWith(n.def + ".")) next.delete(p);
    if (n.use !== undefined) next.add(n.use);
    if (next.size !== liveIn[i]!.size || [...next].some(p => !liveIn[i]!.has(p))) {
      liveIn[i] = next;
      for (const p of preds[i]!) if (!queued.has(p)) { queued.add(p); work.push(p); }
    }
  }
  return liveIn;
}

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

// The first identifier named `name` in `body`, in source order.
function firstIdent(body: Stmt[], name: string): Expr | undefined {
  let found: Expr | undefined;
  const visit = (v: unknown): void => {
    if (found !== undefined || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const o = v as Record<string, unknown>;
    if (o.kind === "Ident" && o.name === name) { found = o as unknown as Expr; return; }
    for (const k in o) if (k !== "span") visit(o[k]);
  };
  visit(body);
  return found;
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
function closuresIn(body: Stmt[]): { params: Param[]; body: Stmt[] }[] {
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
