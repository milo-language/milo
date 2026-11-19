// Move analysis as dataflow (docs/plans/move-dataflow.md): a control-flow graph of place events per
// function body, backward liveness to a fixpoint, and the move-or-share decision for strings read off
// it. Runs after the checker on the rewritten tree and reads only CheckResult facts. Shadow mode for
// now: scripts/move-diff.ts compares its decisions with the checker's movedExprs / sharedStringExprs.
import type { Expr, Function, Param, Pattern, Program, Stmt } from "./ast";
import { patternLeafNames } from "./ast";
import type { CheckResult } from "./checker";

// A place is a local binding plus a static field path: "v#3" or "v#3.name.first".
type Place = string;

interface Node {
  // What the node does, in evaluation order: at most one event per node keeps the transfer simple.
  use?: Place; // a read, borrow or move of the place (all keep everything overlapping it live)
  def?: Place; // a declaration or assignment: the place holds a fresh value afterwards
  expr?: Expr; // the expression of a use, so a decision can be looked up per expression
  succ: number[];
}

export interface MoveFlowResult {
  // Each string-typed move position on a local place, and whether something overlapping it is read later.
  stringDecisions: Map<Expr, "move" | "share">;
}

const overlaps = (a: Place, b: Place) => a === b || a.startsWith(b + ".") || b.startsWith(a + ".");

class Builder {
  nodes: Node[] = [];
  // Bindings that hold a borrow (`&T` / `&mut T` params): a string read out of one is always a share,
  // a local rule that needs no flow.
  borrowed = new Set<Place>();
  private scopes: Map<string, string>[] = [];
  private loops: { head: number; breaks: number[] }[] = [];
  private exits: number[] = []; // nodes that leave the function (return, `?`)
  private ids = 0;

  constructor(private cr: CheckResult) {}

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

  private bindPattern(p: Pattern, cur: number, subject: Expr): number {
    const views = this.subjectLends(subject);
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
        if (this.cr.viewLets.has(s)) this.borrowed.add(id); // `let x = v[i]` aliases the element
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
      case "ContinueStmt": { const l = this.loops[this.loops.length - 1]; if (l && cur >= 0) this.nodes[cur]!.succ.push(l.head); return -1; }
      case "UnsafeBlock": return this.stmts(s.body, cur);
      case "IfStmt": {
        cur = this.expr(s.cond, cur);
        const a = this.stmts(s.thenBody, cur);
        const b = s.elseBody ? this.stmts(s.elseBody, cur) : cur;
        return this.join([a, b]);
      }
      case "IfLetStmt": {
        cur = this.expr(s.subject, cur);
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
            if (cl.kind === "LetClause") { c = this.expr(cl.subject, c); fails.push(c); c = this.bindPattern(cl.pattern, c, cl.subject); }
            else { c = this.expr(cl.cond, c); fails.push(c); }
          }
          return this.stmts(s.thenBody, c);
        });
        const failed = this.join(fails);
        const els = s.elseBody ? this.stmts(s.elseBody, failed) : failed;
        return this.join([then, els]);
      }
      case "LetElseStmt": {
        cur = this.expr(s.value, cur);
        this.stmts(s.elseBody, cur); // diverges: its end is never a successor of anything after
        if (s.bindName) return this.node({ def: this.declare(s.bindName) }, cur);
        return this.bindPattern(s.pattern, cur, s.value);
      }
      case "MatchStmt": return this.match(s.subject, s.arms, cur);
      case "WhileStmt": {
        const head = this.join([cur]);
        const afterCond = this.expr(s.cond, head);
        this.loops.push({ head, breaks: [] });
        const end = this.stmts(s.body, afterCond);
        if (end >= 0) this.nodes[end]!.succ.push(head);
        const { breaks } = this.loops.pop()!;
        return this.join([afterCond, ...breaks]);
      }
      case "ForInStmt": {
        cur = this.expr(s.iterable, cur);
        const head = this.join([cur]);
        this.loops.push({ head, breaks: [] });
        const end = this.scoped(() => {
          // Elements of a container the loop does not consume stay in it: the bindings are views.
          const views = !this.cr.consumingForIns.has(s) && !this.cr.iteratorForIns.has(s);
          const bind = (name: string, c: number) => { const id = this.declare(name); if (views) this.borrowed.add(id); return this.node({ def: id }, c); };
          let c = bind(s.varName, head);
          if (s.varName2) c = bind(s.varName2, c);
          return this.stmts(s.body, c);
        });
        if (end >= 0) this.nodes[end]!.succ.push(head);
        const { breaks } = this.loops.pop()!;
        return this.join([head, ...breaks]);
      }
    }
  }

  private match(subject: Expr, arms: { pattern: Pattern; body: Stmt[] }[], cur: number): number {
    cur = this.expr(subject, cur);
    const ends = arms.map(arm => this.scoped(() => this.stmts(arm.body, this.bindPattern(arm.pattern, cur, subject))));
    return this.join(ends);
  }

  // A fork expression's value is its last statement; its blocks are statement lists like any other.
  expr(e: Expr, cur: number): number {
    if (cur < 0) return cur;
    const place = this.placeOf(e);
    if (place !== null) return this.node({ use: place, expr: e }, cur);
    switch (e.kind) {
      case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit": case "Ident": return cur;
      case "BinOp": {
        cur = this.expr(e.left, cur);
        if (e.op === "&&" || e.op === "||") return this.join([cur, this.expr(e.right, cur)]);
        return this.expr(e.right, cur);
      }
      case "UnaryOp": case "Unwrap": case "CastExpr": case "IsExpr": return this.expr(e.operand, cur);
      case "Propagate": {
        cur = this.expr(e.operand, cur);
        if (cur >= 0) this.exits.push(cur);
        return cur;
      }
      case "DefaultValue": { cur = this.expr(e.operand, cur); return this.join([cur, this.expr(e.default, cur)]); }
      case "EnumLit": { for (const a of e.args) cur = this.expr(a, cur); return cur; }
      // A call whose type is never (exit, panic) ends the path: nothing after it reads anything.
      case "Call": { for (const a of e.args) cur = this.expr(a, cur); return this.cr.exprTypes.get(e)?.tag === "never" ? -1 : cur; }
      case "MethodCall": {
        cur = this.expr(e.object, cur);
        for (const a of e.args) cur = this.expr(a, cur);
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
          if (p !== null) cur = this.node({ use: p }, cur);
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

function analyzeBody(cr: CheckResult, params: Param[], body: Stmt[], out: MoveFlowResult): void {
  const b = new Builder(cr);
  b.fn(params, body);
  const liveIn = liveness(b.nodes);
  b.nodes.forEach(n => {
    if (n.expr === undefined || n.use === undefined || !cr.movePositions.has(n.expr)) return;
    if (cr.exprTypes.get(n.expr)?.tag !== "string") return;
    const after = new Set<Place>();
    for (const s of n.succ) for (const p of liveIn[s]!) after.add(p);
    const used = n.use;
    const root = used.split(".")[0]!;
    out.stringDecisions.set(n.expr, b.borrowed.has(root) || [...after].some(p => overlaps(p, used)) ? "share" : "move");
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

export function moveFlow(program: Program, cr: CheckResult): MoveFlowResult {
  const out: MoveFlowResult = { stringDecisions: new Map() };
  const fns: Function[] = [...program.functions, ...program.impls.flatMap(i => i.methods), ...cr.monomorphizedFns];
  const seen = new Set<Function>();
  for (const f of fns) {
    if (seen.has(f) || !f.body) continue;
    seen.add(f);
    analyzeBody(cr, f.params, f.body, out);
    for (const c of closuresIn(f.body)) analyzeBody(cr, c.params, c.body, out);
  }
  return out;
}
