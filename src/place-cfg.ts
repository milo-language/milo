// Per-function control-flow graph of place events and backward liveness, shared by the move and borrow analyses (docs/plans/move-dataflow.md).
import type { Expr, Pattern, Span, Stmt } from "./ast";
import type { TypeKind } from "./types";
import { patternLeafNames } from "./ast";
import type { CheckResult } from "./checker";
import { MUTATING_COLLECTION_METHODS } from "./builtin-members";

// A place is a local binding plus a static field path: "v#3" or "v#3.name.first".
export type Place = string;

// Analyses add their own event fields here.
export interface Node {
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
  // Borrow events: emitted only when the Builder is made with `borrowEvents`.
  write?: BorrowWrite; // an operation that may reallocate or overwrite `place`: it conflicts with a loan in force
  loan?: BorrowLoan; // a borrow of `place` begins here (a view let's binding, or a for-in loop head)
  carryTo?: Place; // on a move of a whole local into a new binding: the pointer loans on it now belong to that binding
  iterEnd?: number; // on an iteration or callback loan's head: the loan covers node ids from the head up to this one (exclusive)
  succ: number[];
}

// `unsafe`: written inside an `unsafe` block, which the checker lets write under a live pointer.
// kind "closure": calling or passing a closure binding whose body writes the captured `place` (`via`, `fname`).
export interface BorrowWrite { kind: "call" | "assign" | "elem" | "closure"; place: Place; text: string; method?: string; span?: Span; unsafe?: boolean; via?: "calling" | "passing"; fname?: string }
// A pointer loan also carries the call that took the pointer ("v.ptr()") and its line, for the message.
export interface BorrowLoan { kind: "view" | "iteration" | "pointer" | "callback"; place: Place; holder?: Place; name?: string; span?: Span; call?: string; line?: number }

export interface PlaceCfgHost {
  isCopyType(t: TypeKind): boolean;
  show(t: TypeKind): string;
  // Methods returning a view of only some fields of the receiver (the checker's own table); absent: the whole receiver.
  viewReturnFields?: ReadonlyMap<string, string[]>;
  // The raw pointers into a local's buffer that an initializer carries (the checker's own recogniser).
  pointerViewsIn?(e: Expr): { source: Expr; call: string; line: number }[];
}

// How a diagnostic names a written expression: `v`, `h.data`, `v[...]`, `*p`.
function describe(e: Expr): string {
  switch (e.kind) {
    case "Ident": return e.name;
    case "FieldAccess": return `${describe(e.object)}.${e.field}`;
    case "IndexAccess": return `${describe(e.object)}[...]`;
    case "UnaryOp": return e.op === "*" ? `*${describe(e.operand)}` : "<expr>";
    default: return "<expr>";
  }
}

const rootOfPlace = (p: Place): string => p.slice(0, p.indexOf("#"));
export const overlaps = (a: Place, b: Place) => a === b || a.startsWith(b + ".") || b.startsWith(a + ".");

export class Builder {
  nodes: Node[] = [];
  // Bindings that hold a borrow (`&T` / `&mut T` params): a string read out of one is always a share,
  // a local rule that needs no flow.
  borrowed = new Set<Place>();
  // A binding holding a by-reference closure: what it captures, so every use of the binding reads them.
  private closureCaps = new Map<Place, { fname: string; reads: { cap: string; place: Place; path: string }[] }>();
  // A binding holding a `move` closure whose body moves a capture out: calling it consumes it.
  private callsOnce = new Set<Place>();
  // A binding holding a by-reference closure whose body writes a capture (directly or through a closure it calls): the places it writes.
  private closureWrites = new Map<Place, { fname: string; places: Place[] }>();
  // For each let-bound closure literal: the writing closures it captures, by name, so its body (a separate graph) can call them.
  closureEnvs = new Map<Expr, Map<string, { fname: string; writes: string[] }>>();
  // Set on a closure body's builder: the captured closure names it inherits (see closureEnvs).
  inheritedWrites: Map<string, { fname: string; writes: string[] }> | undefined;
  // A closure literal passed to a builtin collection method (`v.each(cb)`): the receiver, by root name and field path, and the
  // method's label ("v.each"). Its body is a separate graph, where the receiver is loaned for the body's whole length.
  callbackOf = new Map<Expr, { root: string; path: string; label: string }>();
  callbackLoan: { root: string; path: string; label: string } | undefined;
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
  private unsafeDepth = 0;

  constructor(private cr: CheckResult, private host: PlaceCfgHost, private borrowEvents = false) {}

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
      if (this.inheritedWrites !== undefined) {
        for (const [name, w] of this.inheritedWrites) {
          const p = this.lookup(name);
          if (p === null) continue;
          const places = w.writes.flatMap(x => { const q = this.lookup(x.replace(/\..*$/, "")); return q === null ? [] : [q + x.slice(x.replace(/\..*$/, "").length)]; });
          if (places.length > 0) this.closureWrites.set(p, { fname: name, places });
        }
      }
      const cbPlace = this.callbackLoan === undefined ? null : this.lookup(this.callbackLoan.root);
      const cbHead = cbPlace === null ? -1 : (cur = this.node({ loan: { kind: "callback", place: cbPlace + this.callbackLoan!.path, name: this.callbackLoan!.label } }, cur));
      cur = this.stmts(body, cur);
      if (cbHead >= 0) this.nodes[cbHead]!.iterEnd = this.nodes.length;
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
  private bindPattern(p: Pattern, cur: number, subject: Expr, inChain = false, attribute = true): number {
    const views = this.subjectLends(subject);
    // A pattern that binds takes the payload only on the path where it matched.
    const sp = this.placeOf(subject);
    if (sp !== null && patternLeafNames(p).some(n => n !== "_")) cur = this.node({ use: sp, expr: subject, armTakes: true, plainTake: inChain }, cur);
    let first = true;
    for (const name of patternLeafNames(p)) {
      if (name === "_") continue;
      const id = this.declare(name);
      if (views) this.borrowed.add(id);
      cur = this.node({ def: id }, cur);
      // The first binding stands for the payload borrow of the subject, as the checker's attributeBorrows names it. A match arm
      // is not attributed (the checker words that conflict without a holder), and a subject behind a reference is not frozen.
      if (this.borrowEvents && attribute && first && sp !== null && !this.borrowed.has(sp.split(".")[0]!) && this.cr.patternBindingTypes.get(p)?.some(t => t.tag === "ref") === true) {
        cur = this.node({ loan: { kind: "view", place: sp, holder: id, name } }, cur);
      }
      first = false;
    }
    return cur;
  }

  stmt(s: Stmt, cur: number): number {
    if (cur < 0) return cur; // unreachable code adds nothing to any live path
    switch (s.kind) {
      case "LetDecl": case "VarDecl": {
        cur = this.expr(s.value, cur);
        const useNode = cur;
        const id = this.declare(s.name);
        if (this.borrowEvents && s.value.kind === "Ident" && this.nodes[useNode]?.use !== undefined && this.nodes[useNode]!.expr === s.value) this.nodes[useNode]!.carryTo = id;
        if (s.value.kind === "Closure") this.noteClosure(id, s.value);
        // `let x = v[i]` aliases the element; a reference binding (`let a = s[i..j]`) views another place.
        if (this.cr.viewLets.has(s) || this.cr.refLets.has(s)) this.borrowed.add(id);
        const viewOf = this.borrowEvents && (this.cr.viewLets.has(s) || this.cr.refLets.has(s)) ? this.viewRoot(s.value) : null;
        cur = this.node({ def: id, ...(viewOf !== null && { loan: { kind: "view" as const, place: viewOf, holder: id, name: s.name, span: s.span } }) }, cur);
        return this.pointerLoans(id, s.name, s.value, cur, s.span);
      }
      case "Assign": {
        cur = this.expr(s.value, cur);
        const target = this.placeOf(s.target);
        const base = this.borrowEvents ? this.writeBase(s.target) : null;
        if (target !== null) {
          cur = this.node({ def: target, ...(base !== null && { write: { kind: "assign" as const, place: target, text: describe(s.target), span: s.span, unsafe: this.unsafeDepth > 0 } }) }, cur);
          // `p = v.ptr()` replaces what `p` pointed at: the def drops the old loans, these open the new ones.
          return s.target.kind === "Ident" ? this.pointerLoans(target, s.target.name, s.value, cur, s.span) : cur;
        }
        cur = this.expr(s.target, cur); // `v[i] = x`, `*p = x`: the base is read, nothing is redefined
        if (base !== null) {
          cur = this.node({ write: { kind: base.indexed ? "elem" as const : "assign" as const, place: base.place, text: describe(s.target), span: s.span, unsafe: this.unsafeDepth > 0 } }, cur);
          // `c.buf = v.ptr()`: the pointer now lives in `c`, which holds it as long as it lives.
          return this.pointerLoans(base.place.split(".")[0]!, rootOfPlace(base.place), s.value, cur, s.span);
        }
        return cur;
      }
      case "Return": {
        if (s.value) cur = this.expr(s.value, cur);
        if (cur >= 0) this.exits.push(cur);
        return -1;
      }
      case "ExprStmt": return this.expr(s.expr, cur);
      case "BreakStmt": { const l = this.loops[this.loops.length - 1]; if (l && cur >= 0) l.breaks.push(cur); return -1; }
      case "ContinueStmt": { const l = this.loops[this.loops.length - 1]; if (l && cur >= 0) this.backTo(cur, l.head); return -1; }
      case "UnsafeBlock": { this.unsafeDepth++; try { return this.stmts(s.body, cur); } finally { this.unsafeDepth--; } }
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
        const iterated = this.borrowEvents && head >= 0 && !this.cr.consumingForIns.has(s) && !this.cr.iteratorForIns.has(s) ? this.placeOf(s.iterable) : null;
        if (iterated !== null) this.nodes[head]!.loan = { kind: "iteration", place: iterated, span: s.span };
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
        if (iterated !== null) this.nodes[head]!.iterEnd = this.nodes.length;
        const { breaks } = this.loops.pop()!;
        return this.join([head, ...breaks]);
      }
      default: { const unhandled: never = s; return unhandled; }
    }
  }

  // The local place a view-typed initializer points into: `s.slice(a, b)`, `v[a..b]`, `h.data[0..2]`.
  private viewRoot(e: Expr): Place | null {
    for (;;) {
      const p = this.placeOf(e);
      if (p !== null) return p;
      if (e.kind === "MethodCall") {
        const fields = this.host.viewReturnFields?.get(this.cr.resolvedMethods.get(e) ?? "");
        const base = fields?.length === 1 ? this.placeOf(e.object) : null;
        if (base !== null && fields !== undefined) return `${base}.${fields[0]}`;
        e = e.object;
      } else if (e.kind === "IndexAccess" || e.kind === "FieldAccess") e = e.object;
      else if (e.kind === "Unwrap") e = e.operand;
      else return null;
    }
  }

  // The local place a write through `e` lands in, and whether it went through an index (an element write).
  private writeBase(e: Expr): { place: Place; indexed: boolean } | null {
    let indexed = false;
    for (;;) {
      const p = this.placeOf(e);
      if (p !== null) return { place: p, indexed };
      if (e.kind === "IndexAccess") { indexed = true; e = e.object; }
      else if (e.kind === "FieldAccess") e = e.object;
      else return null;
    }
  }

  // Loans of the local buffers a pointer-carrying initializer points into, held by `holder`: one loan-only node each, after the holder's own def.
  private pointerLoans(holder: Place, name: string, value: Expr, cur: number, span: Span | undefined): number {
    if (!this.borrowEvents || cur < 0 || this.host.pointerViewsIn === undefined) return cur;
    for (const pv of this.host.pointerViewsIn(value)) {
      const src = this.writeBase(pv.source)?.place;
      if (src === undefined || src.split(".")[0] === holder.split(".")[0]) continue;
      cur = this.node({ loan: { kind: "pointer", place: src, holder, name, call: pv.call, line: pv.line, span } }, cur);
    }
    return cur;
  }

  // A call that may reallocate or overwrite its receiver: a mutating builtin collection method, or a user method taking `&mut self`.
  private mutatesReceiver(e: Expr & { kind: "MethodCall" }): boolean {
    let t = this.cr.exprTypes.get(e.object);
    if (t?.tag === "ref") t = t.inner;
    if (t !== undefined && (t.tag === "vec" || t.tag === "hashmap" || t.tag === "string") && MUTATING_COLLECTION_METHODS.has(e.method)) return true;
    const name = this.cr.resolvedMethods.get(e);
    const self = name === undefined ? undefined : this.cr.functions.get(name)?.params[0]?.type;
    return self !== undefined && self.tag === "ref" && self.mutable;
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
      if (this.borrowEvents) {
        const places = new Set<Place>();
        for (const k of caps) {
          const p = this.lookup(k.name);
          if (p === null) continue;
          if (k.mutatedInClosure) for (const fields of k.mutatedFields ?? [null]) places.add(fields === null || fields.length === 0 ? p : `${p}.${fields.join(".")}`);
          for (const w of this.closureWrites.get(p)?.places ?? []) places.add(w);
        }
        if (places.size > 0) this.closureWrites.set(id, { fname: id.split("#")[0]!, places: [...places] });
        const env = new Map<string, { fname: string; writes: string[] }>();
        for (const k of caps) {
          const p = this.lookup(k.name);
          const cw = p === null ? undefined : this.closureWrites.get(p);
          if (cw !== undefined) env.set(k.name, { fname: cw.fname, writes: cw.places.map(w => rootOfPlace(w) + w.slice(w.indexOf("#") + 1).replace(/^\d+/, "")) });
        }

        if (env.size > 0) this.closureEnvs.set(c, env);
      }
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

  // Each use of a binding holding a by-reference closure reads the places the closure captured. A call of it
  // (or handing it on, `via`) also writes the ones its body writes.
  private readCaptures(place: Place, e: Expr, cur: number): number {
    const via = e.kind === "Call" ? "calling" : "passing";
    const cw = this.closureWrites.get(place);
    if (cw !== undefined) for (const p of cw.places) cur = this.node({ write: { kind: "closure", place: p, text: rootOfPlace(p), span: e.span, via, fname: cw.fname } }, cur);
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
    const ends = arms.map(arm => this.scoped(() => this.stmts(arm.body, this.bindPattern(arm.pattern, cur, subject, false, false))));
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
        if (this.borrowEvents) {
          const base = this.writeBase(e.object);
          if (base !== null && this.mutatesReceiver(e)) cur = this.node({ write: { kind: "call", place: base.place, text: describe(e.object), method: e.method, span: e.span, unsafe: this.unsafeDepth > 0 } }, cur);
          // `v.each(cb)`: the receiver is loaned to the callback's body.
          const recv = this.cr.exprTypes.get(e.object);
          const rbase = recv?.tag === "ref" ? recv.inner : recv;
          if (base !== null && (rbase?.tag === "vec" || rbase?.tag === "hashmap")) {
            for (const a of e.args) {
              if (a.kind === "Closure" && a.isMove !== true) this.callbackOf.set(a, { root: rootOfPlace(base.place), path: base.place.slice(base.place.indexOf("#") + 1).replace(/^\d+/, ""), label: `${rootOfPlace(base.place)}.${e.method}` });
            }
          }
          // `ps.push(v.ptr())`: the container now holds the pointer.
          const holder = this.placeOf(e.object);
          const rt = this.cr.exprTypes.get(e.object);
          const rbare = rt?.tag === "ref" ? rt.inner : rt;
          if (holder !== null && (e.method === "push" || e.method === "insert") && (rbare?.tag === "vec" || rbare?.tag === "hashmap")) {
            for (const a of e.args) cur = this.pointerLoans(holder.split(".")[0]!, rootOfPlace(holder), a, cur, e.span);
          }
        }
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
      default: { const unhandled: never = e; return unhandled; }
    }
  }
}

// Backward liveness: live-in = uses ∪ (live-out − defs), to a fixpoint.
export function liveness(nodes: Node[]): Set<Place>[] {
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

// The first identifier named `name` in `body`, in source order.
export function firstIdent(body: Stmt[], name: string): Expr | undefined {
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
