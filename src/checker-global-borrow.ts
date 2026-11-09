// The global borrow invalidation check, in the portable subset: plain data in, findings out. A
// loop over a mutable global (or a written closure capture), a view into its buffer, or a
// reference handed to a callee must not meet a call that parks the task or writes the global.
// What each call resolves to (its callees, whether they park, what they write), how each
// reference argument roots and which closures share written captures are checker facts the host
// restates here keyed by node id (src/checker-global-borrow-host.ts), numbered the way the
// walker numbers nodes. A statement list is a lexical scope: a view binding extends the context
// of the statements after it and ends with the list.
import type { Span, Stmt, LetDecl, VarDecl, ForInStmt, ClosureExpr, Contract } from "./ast";
import { walkStmts } from "./ast-walk-global-borrow";
import type { Parent, EdgeKey } from "./ast-walk-types";

// One function body: `base` is the id of its first node, `params` its parameter names.
export interface BodyTask { body: Stmt[]; base: number; params: string[] }

// A parameter's type, as far as the rules read it: `refish` is `&T` or `&mut T`, `slice` is `&[T]`.
export interface ParamFact { hasType: boolean; refish: boolean; slice: boolean }

// Where a callee holds a view into its parameter `idx` across a park, as "file:line:col: why".
export interface HeldFact { idx: number; at: string }

// A callee that parks or writes some tracked name. `say` is how a diagnostic names it, `writes`
// the tracked names it may write, `held` the parameters it holds a view of across a park,
// `lazyRead` the global whose initializer it is ("" for any other callee). `hasFn` says a fn with
// `params` stands behind it (pseudo-callees have none).
export interface CalleeFact { say: string; parks: boolean; writes: string[]; held: HeldFact[]; hasFn: boolean; params: ParamFact[]; lazyRead: string }

// A raw-pointer view found in an expression: the root of its source, the call that made it and its line.
export interface PvFact { root: string; call: string; line: number }

// One call argument (or the receiver of a method call). `isView` is a reference type or an inline
// pointer view; `viewRoot` is the root the view rule reads; `elem` says the path steps through an
// index; `byValue` says a call through a value takes it by value; "" is no root.
export interface ArgFact { span: Span | undefined; isView: boolean; viewRoot: string; elem: boolean; byValue: boolean; root: string; pvs: PvFact[] }

// `direct` is the callee the source spells; `callArgs` says the call's own arguments reach it
// (an implicit drop is handed only the dying value).
export interface TargetFact { callee: number; direct: boolean; callArgs: boolean }

// A node with at least one target that parks or writes. `args` holds the receiver first when
// `recv` is set, then the call's arguments; a node that is not a call has none.
export interface CallFact { id: number; span: Span | undefined; recv: boolean; targets: TargetFact[]; args: ArgFact[] }

// A let/var whose initializer may be a view: a reference type rooted at `root`, or pointer views.
export interface ViewFact { id: number; isRef: boolean; root: string; pvs: PvFact[] }
export interface ForFact { id: number; root: string }

// The written captures a closure literal shares, by source name and summary key.
export interface CapEntry { name: string; key: string }
export interface ClosureFact { id: number; caps: CapEntry[] }

// `globals`: the mutable globals. `capNames`: every shared capture, to name it in diagnostics.
export interface GlobalBorrowInput {
  tasks: BodyTask[];
  globals: string[];
  capNames: CapEntry[];
  callees: CalleeFact[];
  calls: CallFact[];
  views: ViewFact[];
  fors: ForFact[];
  closures: ClosureFact[];
}
export interface Finding { message: string; hint: string; span: Span | undefined }

export class GlobalBorrowScan {
  next = 0;
  globals = new Set<string>();
  captureName = new Map<string, string>();
  calleeWrites: Set<string>[] = [];
  callIdx = new Map<number, number>();
  viewIdx = new Map<number, number>();
  forIdx = new Map<number, number>();
  closureIdx = new Map<number, number>();
  reported = new Map<string, boolean>();
  out: Finding[] = [];

  // Per body: the names bound so far (flat, never popped), and the closure bodies being walked,
  // innermost last (entries past `nf` are dead and overwritten): each one's shared captures and
  // the names its own params and locals rebind.
  bound = new Set<string>();
  nf = 0;
  fCaps: Map<string, string>[] = [];
  fShadow: Set<string>[] = [];

  // Globals whose storage is borrowed by an enclosing for-in, innermost last.
  iter: string[] = [];
  nIter = 0;
  forPush = new Map<number, string>();

  // Views live at this point: element views into a global held by a binding that stays live to
  // the end of its block. `saved` holds the view count at each open statement list.
  vName: string[] = [];
  vGlobal: string[] = [];
  vVia: string[] = [];
  nv = 0;
  saved: number[] = [];
  nSaved = 0;

  // A for-in's loop invariants were never part of the walk, so everything under them is stepped over.
  skipDepth = 0;
  contractSkips = new Map<number, boolean>();

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public callees: CalleeFact[], public calls: CallFact[], public views: ViewFact[], public fors: ForFact[], public closures: ClosureFact[]) {}

  index(globalNames: string[], capNames: CapEntry[]): void {
    for (const g of globalNames) { this.globals.add(g); }
    for (const c of capNames) { this.captureName.set(c.key, c.name); }
    for (const c of this.callees) {
      const w = new Set<string>();
      for (const g of c.writes) { w.add(g); }
      this.calleeWrites.push(w);
    }
    let i = 0;
    while (i < this.calls.length) {
      this.callIdx.set(this.calls[i].id, i);
      i++;
    }
    let j = 0;
    while (j < this.views.length) {
      this.viewIdx.set(this.views[j].id, j);
      j++;
    }
    let k = 0;
    while (k < this.fors.length) {
      this.forIdx.set(this.fors[k].id, k);
      k++;
    }
    let m = 0;
    while (m < this.closures.length) {
      this.closureIdx.set(this.closures[m].id, m);
      m++;
    }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
    this.bound = new Set<string>();
    for (const p of task.params) { this.bound.add(p); }
    this.nf = 0;
    this.nIter = 0;
    this.nv = 0;
    this.nSaved = 0;
    this.skipDepth = 0;
    this.forPush = new Map<number, string>();
  }

  indexOf(m: Map<number, number>, id: number): number {
    const got = m.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  off(): boolean {
    return this.skipDepth > 0;
  }

  report(message: string, span: Span | undefined, hint: string): void {
    let line = 0;
    let col = 0;
    if (span !== undefined) {
      line = span.line;
      col = span.col;
    }
    const key = `${line}:${col}:${message}`;
    if (this.reported.has(key)) { return; }
    this.reported.set(key, true);
    this.out.push({ message, hint, span });
  }

  // Diagnostics name a capture by its source name, and the other party is another run of the
  // closure rather than some other task.
  nm(g: string): string {
    const n = this.captureName.get(g);
    if (n !== undefined) { return n; }
    return g;
  }

  theG(g: string): string {
    if (this.captureName.has(g)) { return `the capture '${this.nm(g)}'`; }
    return `the global '${g}'`;
  }

  rival(g: string): string {
    if (this.captureName.has(g)) { return "another run of this closure"; }
    return "another task";
  }

  parkHint(g: string): string {
    if (this.captureName.has(g)) {
      return `iterate by index ('while i < ${this.nm(g)}.len'), or snapshot first ('${this.nm(g)}.clone()'); state that every run of the closure shares is safest in a Channel or a std/sync atomic`;
    }
    return `iterate by index ('while i < ${g}.len'), snapshot first ('${g}.clone()'), or take it with 'replace(${g}, ...)' so the task owns it`;
  }

  // A lazy global parks only at its first read, but which read is first is a run time fact;
  // reading a local copy inside the loop takes the read out of it.
  hintFor(t: number, g: string): string {
    const lazy = this.callees[t].lazyRead;
    if (lazy !== "") {
      return `take what the loop needs from '${lazy}' before it starts (a local copy, 'let v = ${lazy}.clone()'), so no read inside it can run the initializer; or ${this.parkHint(g)}`;
    }
    return this.parkHint(g);
  }

  // The summary key a root name refers to here: a shared capture of an enclosing closure body, an
  // unshadowed mutable global, or "" for nothing the walk models.
  keyOf(name: string): string {
    if (name === "") { return ""; }
    let i = this.nf - 1;
    while (i >= 0) {
      if (this.fShadow[i].has(name)) { return ""; }
      const k = this.fCaps[i].get(name);
      if (k !== undefined) { return k; }
      i--;
    }
    if (this.globals.has(name) && !this.bound.has(name)) { return name; }
    return "";
  }

  iterHas(g: string): boolean {
    let i = 0;
    while (i < this.nIter) {
      if (this.iter[i] === g) { return true; }
      i++;
    }
    return false;
  }

  viewsHasGlobal(g: string): boolean {
    let i = 0;
    while (i < this.nv) {
      if (this.vGlobal[i] === g) { return true; }
      i++;
    }
    return false;
  }

  // Where callee `t` holds parameter `idx` across a park, or "" when it does not.
  heldAt(t: number, idx: number): string {
    const held = this.callees[t].held;
    for (const h of held) {
      if (h.idx === idx) { return h.at; }
    }
    return "";
  }

  describeView(i: number): string {
    const via = this.vVia[i];
    if (via !== "") { return `'${this.vName[i]}' still points into '${this.nm(this.vGlobal[i])}'s buffer (from '${via})`; }
    return `'${this.vName[i]}' borrows from '${this.nm(this.vGlobal[i])}'s buffer`;
  }

  pushIter(g: string): void {
    const at = this.nIter;
    if (at < this.iter.length) { this.iter[at] = g; } else { this.iter.push(g); }
    this.nIter = at + 1;
  }

  pushView(name: string, g: string, via: string): void {
    const at = this.nv;
    if (at < this.vName.length) {
      this.vName[at] = name;
      this.vGlobal[at] = g;
      this.vVia[at] = via;
    } else {
      this.vName.push(name);
      this.vGlobal.push(g);
      this.vVia.push(via);
    }
    this.nv = at + 1;
  }

  pushFrame(caps: Map<string, string>, shadow: Set<string>): void {
    const at = this.nf;
    if (at < this.fCaps.length) {
      this.fCaps[at] = caps;
      this.fShadow[at] = shadow;
    } else {
      this.fCaps.push(caps);
      this.fShadow.push(shadow);
    }
    this.nf = at + 1;
  }

  enterStmts(parentId: number, key: EdgeKey): void {
    const at = this.nSaved;
    if (at < this.saved.length) { this.saved[at] = this.nv; } else { this.saved.push(this.nv); }
    this.nSaved = at + 1;
    if (key === "body") {
      const g = this.forPush.get(parentId);
      if (g !== undefined) { this.pushIter(g); }
    }
  }

  exitStmts(parentId: number, key: EdgeKey): void {
    this.nSaved = this.nSaved - 1;
    this.nv = this.saved[this.nSaved];
    if (key === "body" && this.forPush.has(parentId)) { this.nIter = this.nIter - 1; }
  }

  visitContract(_n: Contract, id: number, parent: Parent, _key: EdgeKey, _index: number): void {
    if (parent.kind === "ForInStmt") {
      this.contractSkips.set(id, true);
      this.skipDepth = this.skipDepth + 1;
    }
  }

  afterContract(_n: Contract, id: number, _kids: number[]): void {
    if (this.contractSkips.has(id)) { this.skipDepth = this.skipDepth - 1; }
  }

  bind(name: string): void {
    this.bound.add(name);
    if (this.nf > 0) { this.fShadow[this.nf - 1].add(name); }
  }

  visitLetDecl(n: LetDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off()) { return; }
    this.bind(n.name);
  }

  visitVarDecl(n: VarDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off()) { return; }
    this.bind(n.name);
  }

  // A reference binding (or a raw pointer binding) stays live to the end of its block.
  viewsOf(name: string, id: number): void {
    const at = this.indexOf(this.viewIdx, id);
    if (at < 0) { return; }
    if (this.views[at].isRef) {
      const g = this.keyOf(this.views[at].root);
      if (g !== "") { this.pushView(name, g, ""); }
      return;
    }
    const pvs = this.views[at].pvs;
    for (const pv of pvs) {
      const g = this.keyOf(pv.root);
      if (g !== "") { this.pushView(name, g, `${pv.call}' on line ${pv.line}`); }
    }
  }

  afterLetDecl(n: LetDecl, id: number, _kids: number[]): void {
    if (this.off()) { return; }
    this.viewsOf(n.name, id);
  }

  afterVarDecl(n: VarDecl, id: number, _kids: number[]): void {
    if (this.off()) { return; }
    this.viewsOf(n.name, id);
  }

  visitClosure(n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off()) { return; }
    const caps = new Map<string, string>();
    const at = this.indexOf(this.closureIdx, id);
    if (at >= 0) {
      const entries = this.closures[at].caps;
      for (const c of entries) { caps.set(c.name, c.key); }
    }
    const shadow = new Set<string>();
    for (const p of n.params) { shadow.add(p.name); }
    this.pushFrame(caps, shadow);
  }

  afterClosure(_n: ClosureExpr, _id: number, _kids: number[]): void {
    if (this.off()) { return; }
    this.nf = this.nf - 1;
  }

  // A loop iterand is a reference into the container's buffer, so anything that reallocs or
  // replaces the container leaves it dangling for the rest of the iteration.
  visitForInStmt(_n: ForInStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off()) { return; }
    const at = this.indexOf(this.forIdx, id);
    if (at < 0) { return; }
    const g = this.keyOf(this.fors[at].root);
    if (g !== "") { this.forPush.set(id, g); }
  }

  node(id: number): void {
    if (this.off()) { return; }
    const ci = this.indexOf(this.callIdx, id);
    if (ci < 0) { return; }
    const nt = this.calls[ci].targets.length;
    let k = 0;
    while (k < nt) {
      this.target(ci, k);
      k++;
    }
  }

  target(ci: number, k: number): void {
    const t = this.calls[ci].targets[k].callee;
    const direct = this.calls[ci].targets[k].direct;
    const callArgs = this.calls[ci].targets[k].callArgs;
    const span = this.calls[ci].span;
    const recv = this.calls[ci].recv;
    let base = 0;
    if (recv) { base = 1; }
    let argsLen = 0;
    if (callArgs) { argsLen = this.calls[ci].args.length - base; }
    // A method call carries its receiver as params[0]; anything that does not line up leaves
    // paramOffset -1 and the check stays fail-closed.
    let paramOffset = -1;
    if (this.callees[t].hasFn) {
      const np = this.callees[t].params.length;
      if (np === argsLen) { paramOffset = 0; } else if (np === argsLen + 1) { paramOffset = 1; }
    }
    if (this.callees[t].parks) { this.parkBlock(ci, t, span, direct, base, argsLen, paramOffset); }
    if (this.callees[t].writes.length > 0) { this.writeBlock(ci, t, span, base, argsLen, paramOffset); }
  }

  parkBlock(ci: number, t: number, span: Span | undefined, direct: boolean, base: number, argsLen: number, paramOffset: number): void {
    const say = this.callees[t].say;
    let i = 0;
    while (i < this.nIter) {
      const g = this.iter[i];
      this.report(
        `${say} can park this task while the loop variable is a reference into '${this.nm(g)}'s buffer; ${this.rival(g)} may push to '${this.nm(g)}' before it resumes`,
        span,
        this.hintFor(t, g),
      );
      i++;
    }
    let v = 0;
    while (v < this.nv) {
      const g = this.vGlobal[v];
      if (!this.iterHas(g)) {
        this.report(
          `${say} can park this task while ${this.describeView(v)}; ${this.rival(g)} may push to '${this.nm(g)}' before it resumes`,
          span,
          this.hintFor(t, g),
        );
      }
      v++;
    }
    // `use(g[0])` / `sum(g)` into a `&[T]`: the argument is a view into g's buffer for as long as
    // the callee runs, and the callee parks. A method's receiver is its params[0] and borrows the
    // same way: `g[0].show()` is `show(g[0])`.
    let a = 0;
    if (this.calls[ci].recv && paramOffset === 1 && direct) { a = -1; }
    while (a < argsLen) {
      this.parkArg(ci, t, span, base + a, a, paramOffset);
      a++;
    }
  }

  parkArg(ci: number, t: number, span: Span | undefined, j: number, argIdx: number, paramOffset: number): void {
    const isView = this.calls[ci].args[j].isView;
    const elem = this.calls[ci].args[j].elem;
    const byValue = this.calls[ci].args[j].byValue;
    const g = this.keyOf(this.calls[ci].args[j].viewRoot);
    if (g === "") { return; }
    if (this.iterHas(g) || this.viewsHasGlobal(g)) { return; }
    const prmIdx = argIdx + paramOffset;
    let hasType = false;
    let slice = false;
    let refish = false;
    if (paramOffset >= 0) {
      hasType = this.callees[t].params[prmIdx].hasType;
      slice = this.callees[t].params[prmIdx].slice;
      refish = this.callees[t].params[prmIdx].refish;
    }
    // A reference to a written capture itself is as bad as one into its buffer when the callee
    // loops over it (or keeps a view into it) across its park: it cannot tell its `&Vec<T>` is
    // shared (`show(log)` where show iterates and yields). The same holds for a global, but that
    // is not rejected yet: milojs hands its global interpreter by `&mut` to every parking entry
    // point, so the global half waits on a decision about that design (memory-safety doc, #22).
    if (!isView) {
      const shared = this.captureName.has(g) || this.globals.has(g);
      if (hasType) {
        const intoBuffer = slice || (elem && refish);
        if (!intoBuffer && !(shared && this.heldAt(t, prmIdx) !== "")) { return; }
      } else if (byValue || (!elem && (this.callees[t].hasFn || !shared))) {
        return;
      }
    }
    let into = `a reference to '${this.nm(g)}'`;
    if (isView || elem || (hasType && slice)) { into = `a reference into '${this.nm(g)}'s buffer`; }
    this.report(
      `${this.callees[t].say} can park this task while it holds ${into}; ${this.rival(g)} may push to '${this.nm(g)}' before it resumes`,
      this.argSpan(ci, j, span),
      this.heldHint(t, prmIdx, g),
    );
  }

  heldHint(t: number, prmIdx: number, g: string): string {
    let at = "";
    if (prmIdx >= 0) { at = this.heldAt(t, prmIdx); }
    if (at !== "") { return `${this.parkHint(g)} (held at ${at})`; }
    return this.parkHint(g);
  }

  argSpan(ci: number, j: number, span: Span | undefined): Span | undefined {
    const sp = this.calls[ci].args[j].span;
    if (sp !== undefined) { return sp; }
    return span;
  }

  writeBlock(ci: number, t: number, span: Span | undefined, base: number, argsLen: number, paramOffset: number): void {
    const say = this.callees[t].say;
    let i = 0;
    while (i < this.nIter) {
      const g = this.iter[i];
      if (this.calleeWrites[t].has(g)) {
        let verb = "writes";
        if (this.captureName.has(g)) { verb = "may run this closure again, which writes"; }
        this.report(
          `${say} ${verb} ${this.theG(g)}, which is being iterated here`,
          span,
          `the loop variable is a reference into '${this.nm(g)}'s buffer — pushing to it, clearing it, or ` +
          `reassigning it from inside the loop frees that buffer and leaves the reference dangling. ` +
          `Iterate a copy ('for x in ${this.nm(g)}.clone()'), or collect the changes and apply them after the loop`,
        );
      }
      i++;
    }
    // `let p = g.ptr(); writer()` (or a slice binding) where `writer` pushes to g: the callee
    // frees the buffer the binding points into (h4-global-callee-push). The main pass cannot see
    // a write made inside another function, and this walk is the one place that knows both the
    // live views and the write summary.
    let v = 0;
    while (v < this.nv) {
      const g = this.vGlobal[v];
      if (this.calleeWrites[t].has(g) && !this.iterHas(g)) {
        let verb = "writes";
        if (this.captureName.has(g)) { verb = "may run this closure again, which writes"; }
        this.report(
          `${say} ${verb} ${this.theG(g)} while ${this.describeView(v)}`,
          span,
          `pushing to, clearing or reassigning '${this.nm(g)}' frees the buffer '${this.vName[v]}' points into: ` +
          `take '${this.vName[v]}' after the call, or end its block before it`,
        );
      }
      v++;
    }
    let a = 0;
    while (a < argsLen) {
      this.writeArg(ci, t, span, base + a, a, paramOffset);
      a++;
    }
  }

  writeArg(ci: number, t: number, span: Span | undefined, j: number, argIdx: number, paramOffset: number): void {
    const say = this.callees[t].say;
    const pvs = this.calls[ci].args[j].pvs;
    for (const pv of pvs) {
      const g = this.keyOf(pv.root);
      if (g !== "" && this.calleeWrites[t].has(g) && !this.iterHas(g) && !this.viewsHasGlobal(g)) {
        this.report(
          `${say} writes ${this.theG(g)}, and is passed '${pv.call}' here`,
          this.argSpan(ci, j, span),
          `the pointer is into '${this.nm(g)}'s buffer, and ${say} can realloc or replace '${this.nm(g)}' while it holds it: take the pointer inside ${say}, or have it not write '${this.nm(g)}'`,
        );
      }
    }
    // `use(G[0])`: the argument is a reference into G's storage and the callee reallocs G, so the
    // reference dies before the callee is done with it. Two things have to be true for that to
    // dangle, and checking only that the argument MENTIONS the global rejected two safe shapes
    // that a real program (milojs) is built out of:
    //   - the path has to reach the global's HEAP interior. `G` and `G.field` name storage at the
    //     global's own fixed address, which no realloc moves and which reassigning G overwrites
    //     in place; only an index step reaches a buffer that can be freed under the reference.
    //   - the PARAMETER has to be a reference. A by-value parameter materialises its argument
    //     before the callee runs, so nothing of the global's is still borrowed while the callee
    //     writes.
    const g = this.keyOf(this.calls[ci].args[j].root);
    if (g === "" || !this.calleeWrites[t].has(g)) { return; }
    if (this.iterHas(g)) { return; }
    if (!this.calls[ci].args[j].elem) { return; }
    if (paramOffset >= 0) {
      const at = argIdx + paramOffset;
      if (this.callees[t].params[at].hasType && !this.callees[t].params[at].refish) { return; }
    } else if (this.calls[ci].args[j].byValue) {
      return;
    }
    this.report(
      `${say} writes ${this.theG(g)}, and is passed a reference into '${this.nm(g)}' here`,
      this.argSpan(ci, j, span),
      `the argument borrows '${this.nm(g)}'s storage, and ${say} can realloc or replace '${this.nm(g)}' ` +
      `while that borrow is live — pass a copy, or have ${say} take '${this.nm(g)}' by value`,
    );
  }
}

export function globalBorrowFindings(input: GlobalBorrowInput): Finding[] {
  const scan = new GlobalBorrowScan(input.callees, input.calls, input.views, input.fors, input.closures);
  scan.index(input.globals, input.capNames);
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
