// The escaping-closure check, in the portable subset: plain data in, findings out. A closure that
// captures by reference is a pointer into the frame it was written in: safe to CALL, unsafe to
// KEEP. Every route by which one can outlive that frame is rejected here: stored into a struct,
// array or collection, assigned to a place that outlives its captures, returned, or handed to a
// callee that keeps it. Rejecting needs no escape analysis (an aggregate is assumed to escape);
// `move` is the escape hatch and what every diagnostic names. What each closure captures, which
// callee each call resolved to and the receiver type of each method call are checker facts the
// host restates here keyed by node id (src/checker-escaping-closures-host.ts), numbered the way
// the walker numbers nodes.
//
// Two walks over one scan. The first runs over every function body and records, per parameter,
// whether the body keeps it: directly, or by forwarding it to a callee parameter. The second is
// the check itself, which asks that summary at each call site. Every unknown answers YES: no
// body, an extern, a variadic slot past the declared params, or a cycle in the forwarding graph.
// A wrong NO is a use-after-free.
import type { Span, Stmt, Expr, Pattern, Call, EnumLit, MethodCall, Ident, ClosureExpr, LetDecl, VarDecl, Assign, Return, StructLit, ArrayLit, ArrayRepeat, ForInStmt, IfLetStmt, IfChainStmt, MatchStmt, MatchExpr, LetElseStmt, EnumPattern, LiteralPattern, WildcardPattern } from "./ast";
import { walkStmts } from "./ast-walk-escaping-closures";
import type { Parent, EdgeKey } from "./ast-walk-types";

// One function body: `base` is the id of its first node. `fn` is the index into `fns` of the
// function whose parameter summary the body feeds, or -1 for a body the check itself runs over.
export interface BodyTask { body: Stmt[]; base: number; fn: number }

// A closure literal with at least one capture: the names it captures, in capture order.
export interface ClosureFact { id: number; isMove: boolean; caps: string[] }

// `lits`: ids of the direct children that are closure literals, in the order the pass examines
// them (arguments, field values then the update base, elements, the one assigned or bound value).
// `target`: for a method call the struct or enum its receiver is, for an enum literal the mangled
// fn it resolved to; "" when unresolved.
export interface NodeFact { id: number; lits: number[]; target: string }

// A function the program can call by mangled name. `usable` is false for an extern or a fn with
// no body. `decl[i]` is what parameter i's declared type says: 0 not a fn type, 1 a plain
// (non-escaping) fn, 2 an owning (`move`) fn.
export interface FnFact { name: string; usable: boolean; params: string[]; decl: number[] }

// `globals`: every global's name. `retaining`: the builtin methods that keep a fn-valued argument.
export interface EscapingClosuresInput {
  tasks: BodyTask[];
  closures: ClosureFact[];
  nodes: NodeFact[];
  fns: FnFact[];
  globals: string[];
  retaining: string[];
}
export interface Finding { message: string; hint: string; span: Span | undefined }

export class EscapingScan {
  next = 0;
  // The fn whose parameter summary the current body feeds; -1 while running the check.
  tFn = -1;
  closureIdx = new Map<number, number>();
  nodeIdx = new Map<number, number>();
  fnIdx = new Map<string, number>();
  globals = new Set<string>();
  retaining = new Set<string>();
  // Keyed "line:col" of the offending closure, across every body.
  seen = new Map<string, boolean>();
  out: Finding[] = [];

  // Per-body check state. `bound`: the closure literal each local name holds (one flat map, so a
  // closure bound by `let f = ...` is still recognized when `f` is stored later; shadowing can only
  // make this reject something it would otherwise allow, never the reverse).
  bound = new Map<string, number>();
  cslId: number[] = [];
  cslSpan: (Span | undefined)[] = [];
  // Local bindings in scope, innermost last, with the block depth each was declared at; entries
  // past `ln` are dead and overwritten. A name in no block (a parameter, `self`) is depth 0.
  lName: string[] = [];
  lDepth: number[] = [];
  ln = 0;
  bdepth = 0;
  marks: number[] = [];
  // The names a block introduces before its first statement, by owner node id (loop variables,
  // closure params, `if let` patterns) or, for a match arm, the arm's own pattern names.
  bindNames: string[] = [];
  bindStart = new Map<number, number>();
  bindCount = new Map<number, number>();
  matchIds = new Map<number, boolean>();
  armNames: string[] = [];

  // Parameter summary: "fn#idx" keys whose body keeps them outright, and forwarding edges
  // (source key, callee, callee parameter). A forward is followed only when asked.
  direct = new Map<string, boolean>();
  fwSrc: string[] = [];
  fwDst: string[] = [];
  fwIdx: number[] = [];
  rSeen = new Map<string, boolean>();

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public closures: ClosureFact[], public nodes: NodeFact[], public fns: FnFact[], public globalNames: string[], public retainingNames: string[]) {}

  index(): void {
    let i = 0;
    while (i < this.closures.length) {
      this.closureIdx.set(this.closures[i].id, i);
      i++;
    }
    let j = 0;
    while (j < this.nodes.length) {
      this.nodeIdx.set(this.nodes[j].id, j);
      j++;
    }
    let k = 0;
    while (k < this.fns.length) {
      this.fnIdx.set(this.fns[k].name, k);
      k++;
    }
    for (const g of this.globalNames) { this.globals.add(g); }
    for (const r of this.retainingNames) { this.retaining.add(r); }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
    this.tFn = task.fn;
    this.bound = new Map<string, number>();
    this.cslId = [];
    this.cslSpan = [];
    this.ln = 0;
    this.bdepth = 0;
    this.bindNames = [];
    this.bindStart = new Map<number, number>();
    this.bindCount = new Map<number, number>();
    this.matchIds = new Map<number, boolean>();
    this.armNames = [];
  }

  closureAt(id: number): number {
    const got = this.closureIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  nodeAt(id: number): number {
    const got = this.nodeIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  fnAt(name: string): number {
    const got = this.fnIdx.get(name);
    if (got !== undefined) { return got; }
    return -1;
  }

  litAt(at: number, k: number): number {
    if (at < 0 || k >= this.nodes[at].lits.length) { return -1; }
    return this.nodes[at].lits[k];
  }

  targetAt(id: number): string {
    const at = this.nodeAt(id);
    if (at < 0) { return ""; }
    return this.nodes[at].target;
  }

  // ---- parameter summary ----

  markParam(name: string): void {
    const f = this.tFn;
    let j = 0;
    while (j < this.fns[f].params.length) {
      if (this.fns[f].params[j] === name) {
        const key = `${this.fns[f].name}#${j}`;
        this.direct.set(key, true);
      }
      j++;
    }
  }

  forwardParam(name: string, callee: string, calleeIdx: number): void {
    const f = this.tFn;
    let j = 0;
    while (j < this.fns[f].params.length) {
      if (this.fns[f].params[j] === name) {
        const key = `${this.fns[f].name}#${j}`;
        this.fwSrc.push(key);
        this.fwDst.push(callee);
        this.fwIdx.push(calleeIdx);
      }
      j++;
    }
  }

  // Does `fnName` KEEP its idx-th argument past the call? A closure-typed parameter says in its
  // type (`move` keeps it, a plain one cannot). For any other parameter (a generic `T` a closure
  // may arrive in) the body does: one only ever CALLED is consumed during the call; one stored,
  // returned, or forwarded to something that stores it is not. A key reached twice answers YES,
  // which covers a cycle in the forwarding graph.
  retains(fnName: string, idx: number): boolean {
    this.rSeen = new Map<string, boolean>();
    return this.retainsRec(fnName, idx);
  }

  retainsRec(fnName: string, idx: number): boolean {
    const key = `${fnName}#${idx}`;
    if (this.rSeen.has(key)) { return true; }
    this.rSeen.set(key, true);
    const at = this.fnAt(fnName);
    if (at < 0) { return true; }
    if (!this.fns[at].usable) { return true; }
    if (idx >= this.fns[at].params.length) { return true; }
    const declared = this.fns[at].decl[idx];
    if (declared === 1) { return false; }
    if (declared === 2) { return true; }
    if (this.direct.has(key)) { return true; }
    let i = 0;
    while (i < this.fwSrc.length) {
      if (this.fwSrc[i] === key) {
        const dst = this.fwDst[i];
        if (this.retainsRec(dst, this.fwIdx[i])) { return true; }
      }
      i++;
    }
    return false;
  }

  // ---- the check ----

  declareLocal(name: string): void {
    const at = this.ln;
    if (at < this.lName.length) {
      this.lName[at] = name;
      this.lDepth[at] = this.bdepth;
    } else {
      this.lName.push(name);
      this.lDepth.push(this.bdepth);
    }
    this.ln = at + 1;
  }

  depthOf(name: string): number {
    let i = this.ln - 1;
    while (i >= 0) {
      if (this.lName[i] === name) { return this.lDepth[i]; }
      i = i - 1;
    }
    return 0;
  }

  enterStmts(parentId: number, key: EdgeKey): void {
    if (this.tFn >= 0) { return; }
    const d = this.bdepth;
    if (d < this.marks.length) { this.marks[d] = this.ln; } else { this.marks.push(this.ln); }
    this.bdepth = d + 1;
    if (key !== "body" && key !== "thenBody") { return; }
    const start = this.bindStart.get(parentId);
    if (start !== undefined) {
      const count = this.bindCount.get(parentId);
      if (count !== undefined) {
        let i = 0;
        while (i < count) {
          const nm = this.bindNames[start + i];
          this.declareLocal(nm);
          i++;
        }
      }
    } else if (key === "body" && this.matchIds.has(parentId)) {
      let i = 0;
      while (i < this.armNames.length) {
        const nm = this.armNames[i];
        this.declareLocal(nm);
        i++;
      }
    }
  }

  exitStmts(_parentId: number, _key: EdgeKey): void {
    if (this.tFn >= 0) { return; }
    this.bdepth = this.bdepth - 1;
    this.ln = this.marks[this.bdepth];
  }

  recordBinds(id: number, start: number): void {
    this.bindStart.set(id, start);
    this.bindCount.set(id, this.bindNames.length - start);
  }

  // The names a stored closure exposes: its own captures when it borrows. A `move` closure
  // normally exposes none, but not when a capture is itself a borrowing closure: moving a
  // `{fn, env}` pair copies the pointer, and the env keeps pointing at the frame the inner closure
  // was written in, so resolve through move captures until a borrowing closure or no binding is
  // left. A capture that resolves to nothing is a fn-typed parameter: a plain one may not be
  // captured by a `move` closure at all (checkNonEscapingParams), and a `move` one owns nothing
  // in this frame.
  collect(c: number, visited: Map<number, boolean>, out: string[]): void {
    if (visited.has(c)) { return; }
    visited.set(c, true);
    const at = this.closureAt(c);
    if (at < 0) { return; }
    const caps = this.closures[at].caps;
    if (!this.closures[at].isMove) {
      for (const nm of caps) { out.push(nm); }
      return;
    }
    for (const nm of caps) {
      const inner = this.bound.get(nm);
      if (inner !== undefined) { this.collect(inner, visited, out); }
    }
  }

  spanOfBound(c: number): Span | undefined {
    let i = 0;
    while (i < this.cslId.length) {
      if (this.cslId[i] === c) { return this.cslSpan[i]; }
      i++;
    }
    return undefined;
  }

  // `lit`: the id of `value` when it is a closure literal. `filter` >= 0 keeps only captures
  // declared in a deeper block than that.
  check(value: Expr, lit: number, verb: string, tail: string, holder: string, filter: number): void {
    let c = -1;
    if (value.kind === "Closure") {
      c = lit;
    } else if (value.kind === "Ident") {
      const b = this.bound.get(value.name);
      if (b !== undefined) { c = b; }
    }
    if (c < 0) { return; }
    const all: string[] = [];
    const visited = new Map<number, boolean>();
    this.collect(c, visited, all);
    const caps: string[] = [];
    for (const nm of all) {
      if (filter < 0 || this.depthOf(nm) > filter) { caps.push(nm); }
    }
    if (caps.length === 0) { return; }
    let span = this.spanOfBound(c);
    const own = value.span;
    if (own !== undefined) { span = own; }
    const key = spanKey(span);
    if (this.seen.has(key)) { return; }
    this.seen.set(key, true);
    let names = "";
    let n = 0;
    for (const nm of caps) {
      if (n > 0) { names = names + ", "; }
      names = names + `'${nm}'`;
      n++;
    }
    let isMove = false;
    const ci = this.closureAt(c);
    if (ci >= 0) { isMove = this.closures[ci].isMove; }
    let hint = `this closure points at locals in the current frame, and ${holder} can outlive them — write 'move (…) => …' so the closure owns its captures instead`;
    if (isMove) {
      hint = `this closure is 'move', but it captures another closure that points at locals in the current frame — 'move' on the outer one copies that pointer, it does not own what it points at. Write the inner closure 'move (…) => …' too`;
    }
    this.out.push({ message: `cannot ${verb} a closure that captures ${names} by reference${tail}`, hint, span });
  }

  // Exactly the args `check` does not return early on.
  mayBeClosure(value: Expr): boolean {
    if (value.kind === "Closure") { return true; }
    if (value.kind === "Ident") { return this.bound.has(value.name); }
    return false;
  }

  binding(name: string, value: Expr, id: number): void {
    if (this.tFn >= 0) { return; }
    this.declareLocal(name);
    if (value.kind === "Closure") {
      const lit = this.litAt(this.nodeAt(id), 0);
      this.bound.set(name, lit);
      this.cslId.push(lit);
      this.cslSpan.push(value.span);
    } else if (value.kind === "Ident") {
      // `let g = f` aliases the same closure; without this the alias launders a borrowing closure
      // past every check.
      const b = this.bound.get(value.name);
      if (b !== undefined) { this.bound.set(name, b); }
    }
  }

  visitLetDecl(n: LetDecl, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.binding(n.name, n.value, id); }
  visitVarDecl(n: VarDecl, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.binding(n.name, n.value, id); }

  visitStructLit(n: StructLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const at = this.nodeAt(id);
    let k = 0;
    for (const f of n.fields) {
      let lit = -1;
      if (f.value.kind === "Closure") {
        lit = this.litAt(at, k);
        k++;
      }
      this.check(f.value, lit, "store", "", "the struct holding it", -1);
    }
    if (n.base !== undefined) {
      let lit = -1;
      if (n.base.kind === "Closure") { lit = this.litAt(at, k); }
      this.check(n.base, lit, "store", "", "the struct holding it", -1);
    }
  }

  visitArrayLit(n: ArrayLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const at = this.nodeAt(id);
    let k = 0;
    for (const el of n.elements) {
      let lit = -1;
      if (el.kind === "Closure") {
        lit = this.litAt(at, k);
        k++;
      }
      this.check(el, lit, "store", "", "the array holding it", -1);
    }
  }

  visitArrayRepeat(n: ArrayRepeat, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    this.check(n.value, this.litAt(this.nodeAt(id), 0), "store", "", "the array holding it", -1);
  }

  visitReturn(n: Return, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    if (n.value !== null) { this.check(n.value, this.litAt(this.nodeAt(id), 0), "return", "", "the caller", -1); }
  }

  visitLetElseStmt(n: LetElseStmt, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    // Its bindings land in the enclosing block, after the else.
    const names: string[] = [];
    leafNames(n.pattern, names);
    for (const nm of names) { this.declareLocal(nm); }
  }

  // A field, an element, or a global is a place that outlives the frame. A bare local lives as
  // long as its own block, so it may hold the closure only if every capture was declared in that
  // block or an enclosing one: `var f` assigned a closure over a `let s` from an inner `if` block
  // outlived `s` and read it freed.
  visitAssign(n: Assign, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const lit = this.litAt(this.nodeAt(id), 0);
    if (n.target.kind === "FieldAccess") {
      this.check(n.value, lit, "store", "", "the struct holding it", -1);
    } else if (n.target.kind === "IndexAccess") {
      this.check(n.value, lit, "store", "", "the collection holding it", -1);
    } else if (n.target.kind === "Ident") {
      if (this.globals.has(n.target.name)) {
        this.check(n.value, lit, "store", "", "a global", -1);
      } else {
        const depth = this.depthOf(n.target.name);
        this.check(n.value, lit, "store", "", `'${n.target.name}', declared outside the block they live in,`, depth);
      }
    }
  }

  visitCall(n: Call, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) {
      let j = 0;
      for (const a of n.args) {
        if (a.kind === "Ident") { this.forwardParam(a.name, n.func, j); }
        j++;
      }
      return;
    }
    const at = this.nodeAt(id);
    let i = 0;
    let k = 0;
    for (const a of n.args) {
      let lit = -1;
      if (a.kind === "Closure") {
        lit = this.litAt(at, k);
        k++;
      }
      if (this.mayBeClosure(a) && this.retains(n.func, i)) {
        this.check(a, lit, "pass", ` to '${n.func}', which keeps it`, `'${n.func}'`, -1);
      }
      i++;
    }
  }

  // `Promise.blocking(...)`, `Task.spawn(...)` and every other `Type.method(...)` parse as EnumLit,
  // not Call or MethodCall. `var n = 41; Promise.blocking(() => { n = n + 1; return n })` once
  // returned 8421921353 from a dead stack.
  visitEnumLit(n: EnumLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    if (n.args.length === 0) { return; }
    const at = this.nodeAt(id);
    const mangled = this.targetAt(id);
    const who = `${n.enumName}.${n.variant}`;
    let i = 0;
    let k = 0;
    for (const a of n.args) {
      let lit = -1;
      if (a.kind === "Closure") {
        lit = this.litAt(at, k);
        k++;
      }
      // No resolved target means an enum VARIANT constructor (which stores its payload) or a
      // builtin: treated as retaining, since a wrong NO is a use-after-free. The only args this
      // can reject are closures, so failing closed costs nothing else.
      if (this.mayBeClosure(a)) {
        let skip = false;
        if (mangled !== "" && this.fnAt(mangled) >= 0 && !this.retains(mangled, i)) { skip = true; }
        if (!skip) { this.check(a, lit, "pass", ` to '${who}', which keeps it`, `'${who}'`, -1); }
      }
      i++;
    }
  }

  visitMethodCall(n: MethodCall, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const storesIt = this.retaining.has(n.method);
    const owner = this.targetAt(id);
    if (this.tFn >= 0) {
      let mangledName = "";
      if (owner !== "") { mangledName = `${owner}$${n.method}`; }
      let j = 0;
      for (const a of n.args) {
        if (a.kind === "Ident") {
          if (storesIt) {
            this.markParam(a.name);
          } else if (mangledName !== "" && this.fnAt(mangledName) >= 0) {
            // +1: the mangled method carries `self` as its first parameter.
            this.forwardParam(a.name, mangledName, j + 1);
          }
        }
        j++;
      }
      return;
    }
    const at = this.nodeAt(id);
    let k = 0;
    // A closure passed to `map`/`each`/`sortBy` is called and dropped within the call, so those
    // stay legal. The collection-storing methods keep it. No builtin outside the `retainsArg`
    // rows retains a fn value, which is what makes the unresolved case below safe to wave through.
    if (storesIt) {
      for (const a of n.args) {
        let lit = -1;
        if (a.kind === "Closure") {
          lit = this.litAt(at, k);
          k++;
        }
        this.check(a, lit, "store", "", "the collection holding it", -1);
      }
      return;
    }
    // A user-defined method resolves to the mangled `Type$method` and gets the same retention
    // analysis a free function does.
    if (owner === "") { return; }
    const mangled = `${owner}$${n.method}`;
    if (this.fnAt(mangled) < 0) { return; }
    let i = 0;
    for (const a of n.args) {
      let lit = -1;
      if (a.kind === "Closure") {
        lit = this.litAt(at, k);
        k++;
      }
      // +1: the mangled method carries `self` as its first parameter.
      if (this.mayBeClosure(a) && this.retains(mangled, i + 1)) {
        this.check(a, lit, "pass", ` to '${owner}.${n.method}', which keeps it`, `'${owner}.${n.method}'`, -1);
      }
      i++;
    }
  }

  visitClosure(n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) {
      // A closure that CAPTURES the parameter keeps it, and no Ident node shows it: the body
      // spells the use `f(3)`, a `Call` with a string callee.
      const at = this.closureAt(id);
      if (at >= 0) {
        const caps = this.closures[at].caps;
        for (const c of caps) { this.markParam(c); }
      }
      return;
    }
    const start = this.bindNames.length;
    for (const p of n.params) { this.bindNames.push(p.name); }
    this.recordBinds(id, start);
  }

  visitIdent(n: Ident, _id: number, parent: Parent, key: EdgeKey, _index: number): void {
    if (this.tFn < 0) { return; }
    // An argument that is the parameter itself is judged by the call that receives it.
    if (parent.kind === "Call" && key === "args") { return; }
    if (parent.kind === "MethodCall" && key === "args") { return; }
    this.markParam(n.name);
  }

  visitForInStmt(n: ForInStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const start = this.bindNames.length;
    this.bindNames.push(n.varName);
    const second = n.varName2;
    if (second !== null && second !== "") { this.bindNames.push(second); }
    this.recordBinds(id, start);
  }

  visitIfLetStmt(n: IfLetStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const start = this.bindNames.length;
    leafNames(n.pattern, this.bindNames);
    this.recordBinds(id, start);
  }

  visitIfChainStmt(n: IfChainStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn >= 0) { return; }
    const start = this.bindNames.length;
    for (const c of n.clauses) {
      if (c.kind === "LetClause") { leafNames(c.pattern, this.bindNames); }
    }
    this.recordBinds(id, start);
  }

  visitMatchStmt(_n: MatchStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn < 0) { this.matchIds.set(id, true); }
  }

  visitMatchExpr(_n: MatchExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.tFn < 0) { this.matchIds.set(id, true); }
  }

  // An arm's pattern is walked just before its body, so the names it binds are the ones the
  // body's block opens with.
  armPattern(parent: Parent, key: EdgeKey): boolean {
    return this.tFn < 0 && key === "pattern" && (parent.kind === "MatchStmt" || parent.kind === "MatchExpr");
  }

  visitEnumPattern(n: EnumPattern, _id: number, parent: Parent, key: EdgeKey, _index: number): void {
    if (this.armPattern(parent, key)) {
      this.armNames = [];
      enumLeafNames(n, this.armNames);
    }
  }

  visitLiteralPattern(_n: LiteralPattern, _id: number, parent: Parent, key: EdgeKey, _index: number): void {
    if (this.armPattern(parent, key)) { this.armNames = []; }
  }

  visitWildcardPattern(_n: WildcardPattern, _id: number, parent: Parent, key: EdgeKey, _index: number): void {
    if (this.armPattern(parent, key)) { this.armNames = []; }
  }
}

// The dedup key of a diagnostic: where it points, without the file (as the old pass keyed it).
function spanKey(span: Span | undefined): string {
  let line = 0;
  let col = 0;
  if (span !== undefined) {
    line = span.line;
    col = span.col;
  }
  return `${line}:${col}`;
}

// Every binding an enum pattern introduces (order is irrelevant here: they all land in one block).
export function enumLeafNames(p: EnumPattern, out: string[]): void {
  let nested = false;
  if (p.args !== undefined) {
    for (const a of p.args) { if (a !== null) { nested = true; } }
  }
  if (!nested) {
    for (const b of p.bindings) { out.push(b); }
  }
  if (nested && p.args !== undefined) {
    let i = 0;
    for (const a of p.args) {
      if (i < p.bindings.length) {
        if (a !== null) { leafNames(a, out); } else { out.push(p.bindings[i]); }
      }
      i++;
    }
    while (i < p.bindings.length) {
      out.push(p.bindings[i]);
      i++;
    }
  }
}

export function leafNames(p: Pattern, out: string[]): void {
  if (p.kind === "EnumPattern") { enumLeafNames(p, out); }
}

export function escapingClosuresFindings(input: EscapingClosuresInput): Finding[] {
  const scan = new EscapingScan(input.closures, input.nodes, input.fns, input.globals, input.retaining);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
