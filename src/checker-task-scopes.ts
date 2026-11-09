// The Task.scope check, in the portable subset: plain data in, findings out. `Task.scope(body)`
// joins every task spawned on its handle before returning, so a scoped task may borrow the
// enclosing fn's locals. std/runtime's `TaskScope.spawn` keeps its plain closure param past the
// call to do that, which is sound only if every call site obeys three rules: (1) the handle is
// used only as `s.spawn(<closure literal>)`, directly in the scope body; (2) a borrowing task
// captures only what outlives the scope; (3) a borrowed binding is read by everyone or touched by
// exactly one task. How each call resolved and what each closure captures are checker facts the
// host restates here keyed by node id (src/checker-task-scopes-host.ts), numbered the way the
// walker numbers nodes.
import type { Span, Stmt, Expr, Call, MethodCall, EnumLit, Ident, ClosureExpr, WhileStmt, ForInStmt, LetDecl, VarDecl, LetElseStmt, EnumPattern, Contract } from "./ast";
import { walkStmts } from "./ast-walk-task-scopes";
import type { Parent, EdgeKey } from "./ast-walk-types";

export interface BodyTask { body: Stmt[]; base: number }

// What a call resolved to: `Task$scope`, `TaskScope$spawn`, or `TaskScope$live` (a read of the
// scope's live task count, which cannot spawn). Calls resolving to anything else carry no fact.
export const CALL_SCOPE = 1;
export const CALL_SPAWN = 2;
export const CALL_LIVE = 3;

// `objSize` is how many nodes the receiver of a method call spans, so the pass can step over it
// (the original check never looked inside the receiver) and find the first argument's id.
export interface CallFact { id: number; verdict: number; objSize: number }

// A closure literal with at least one capture. `sources` are the ids of the closure literals the
// captured binding may hold, which the capture reaches by calling it.
export interface CapFact { name: string; writes: boolean; sources: number[] }
export interface ClosureFact { id: number; isMove: boolean; caps: CapFact[] }

export interface TaskScopesInput { tasks: BodyTask[]; calls: CallFact[]; closures: ClosureFact[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

export class TaskScopeScan {
  next = 0;
  callIdx = new Map<number, number>();
  closureIdx = new Map<number, number>();
  seen = new Map<string, boolean>();
  out: Finding[] = [];

  // Open Task.scope bodies, outermost first, one entry per parallel array; entries past `nf` are
  // dead and overwritten on the next push. `depth` counts closures entered since the body began
  // (0 = directly in the body) and `loops` the loops around the current point inside it; a spawn
  // is legal only at depth 0. `decls` is every name the body declares at any depth: name-based and
  // conservative, since a shadowed outer name and the body's own local cannot be told apart here.
  // `names` is the body's own mentions without the spawned literals (those are the tasks);
  // `inSpawn` is greater than zero while inside one.
  nf = 0;
  serial = 0;
  fSerial: number[] = [];
  fHandle: string[] = [];
  fBody: number[] = [];
  fDepth: number[] = [];
  fLoops: number[] = [];
  fInSpawn: number[] = [];
  fDecls: Set<string>[] = [];
  fNames: Set<string>[] = [];

  // Every spawn seen, with the serial of the frame it belongs to.
  spFrame: number[] = [];
  spLit: number[] = [];
  spInLoop: boolean[] = [];
  spSpan: (Span | undefined)[] = [];

  // Closure ids that open a scope body, and spawn literals mapped to their frame's stack index.
  scopeLits = new Map<number, boolean>();
  spawnLits = new Map<number, number>();
  // Loops entered with a scope open. The original looked only at such a loop's condition and body,
  // never at its invariants, so those are stepped over.
  loopMarks = new Map<number, boolean>();
  contractSkips = new Map<number, boolean>();
  skipDepth = 0;
  skipStart = 0;
  skipEnd = 0;

  // Scratch for the closures a closure reaches by calling the closures it captured, and the same
  // for the scope body currently being finished.
  rSeen = new Map<number, boolean>();
  rn: string[] = [];
  rw: boolean[] = [];
  bodyRN: string[] = [];
  bodyRW: boolean[] = [];
  // Borrowed names in first-borrowed order, and (name index, spawn index) pairs in borrowed order.
  bNames: string[] = [];
  pName: number[] = [];
  pSpawn: number[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public calls: CallFact[], public closures: ClosureFact[]) {}

  index(): void {
    let i = 0;
    while (i < this.calls.length) {
      this.callIdx.set(this.calls[i].id, i);
      i++;
    }
    let j = 0;
    while (j < this.closures.length) {
      this.closureIdx.set(this.closures[j].id, j);
      j++;
    }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
  }

  off(id: number): boolean {
    return this.skipDepth > 0 || (id >= this.skipStart && id < this.skipEnd);
  }

  callAt(id: number): number {
    const got = this.callIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  closureAt(id: number): number {
    const got = this.closureIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  report(message: string, span: Span | undefined, hint: string): void {
    let file = "";
    let line = 0;
    let col = 0;
    if (span !== undefined) {
      const f = span.file;
      if (f !== undefined) { file = f; }
      line = span.line;
      col = span.col;
    }
    const key = `${file}:${line}:${col}:${message}`;
    if (this.seen.has(key)) { return; }
    this.seen.set(key, true);
    this.out.push({ message, hint, span });
  }

  handleFrame(name: string): number {
    let i = 0;
    while (i < this.nf) {
      if (this.fHandle[i] === name) { return i; }
      i++;
    }
    return -1;
  }

  declare(name: string): void {
    let i = 0;
    while (i < this.nf) {
      this.fDecls[i].add(name);
      i++;
    }
  }

  bumpDepth(by: number): void {
    let i = 0;
    while (i < this.nf) {
      this.fDepth[i] = this.fDepth[i] + by;
      i++;
    }
  }

  mention(name: string): void {
    let i = 0;
    while (i < this.nf) {
      if (this.fInSpawn[i] === 0) { this.fNames[i].add(name); }
      i++;
    }
  }

  pushFrame(handle: string, body: number, decls: Set<string>): void {
    const at = this.nf;
    const names = new Set<string>();
    if (at < this.fHandle.length) {
      this.fSerial[at] = this.serial;
      this.fHandle[at] = handle;
      this.fBody[at] = body;
      this.fDepth[at] = 0;
      this.fLoops[at] = 0;
      this.fInSpawn[at] = 0;
      this.fDecls[at] = decls;
      this.fNames[at] = names;
    } else {
      this.fSerial.push(this.serial);
      this.fHandle.push(handle);
      this.fBody.push(body);
      this.fDepth.push(0);
      this.fLoops.push(0);
      this.fInSpawn.push(0);
      this.fDecls.push(decls);
      this.fNames.push(names);
    }
    this.serial = this.serial + 1;
    this.nf = at + 1;
  }

  enterStmts(parentId: number, key: EdgeKey): void {
    if (key === "body" && this.loopMarks.has(parentId)) { this.fLoops[this.nf - 1] = this.fLoops[this.nf - 1] + 1; }
  }

  exitStmts(parentId: number, key: EdgeKey): void {
    if (key === "body" && this.loopMarks.has(parentId)) { this.fLoops[this.nf - 1] = this.fLoops[this.nf - 1] - 1; }
  }

  loopStart(id: number): void {
    if (!this.off(id) && this.nf > 0) { this.loopMarks.set(id, true); }
  }

  visitWhileStmt(_n: WhileStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.loopStart(id); }

  visitForInStmt(n: ForInStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    this.declare(n.varName);
    const second = n.varName2;
    if (second !== null) { this.declare(second); }
    this.loopStart(id);
  }

  visitContract(_n: Contract, id: number, parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.loopMarks.has(parent.id)) {
      this.contractSkips.set(id, true);
      this.skipDepth = this.skipDepth + 1;
    }
  }

  afterContract(_n: Contract, id: number, _kids: number[]): void {
    if (this.contractSkips.has(id)) { this.skipDepth = this.skipDepth - 1; }
  }

  visitLetDecl(n: LetDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.declare(n.name); }
  visitVarDecl(n: VarDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.declare(n.name); }

  visitLetElseStmt(n: LetElseStmt, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const b = n.bindName;
    if (b !== undefined) { this.declare(b); }
  }

  visitEnumPattern(n: EnumPattern, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    for (const b of n.bindings) { this.declare(b); }
  }

  // A scope handle may appear only as the receiver of `spawn` (or `live`), checked at those calls.
  visitIdent(n: Ident, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    this.mention(n.name);
    if (this.off(id)) { return; }
    if (this.handleFrame(n.name) >= 0) {
      this.report(`the task scope '${n.name}' can only be used as '${n.name}.spawn(...)'`, n.span,
        `a scope handle that is stored, passed on or captured could spawn tasks after Task.scope has joined`);
    }
  }

  // A call names its callee as a string, not an Ident: `clr()` uses the binding `clr`.
  visitCall(n: Call, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    this.mention(n.func);
    if (this.off(id)) { return; }
    this.scopeCall(n.args, id);
  }

  visitEnumLit(n: EnumLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off(id)) { return; }
    this.scopeCall(n.args, id);
  }

  // Task.scope((s) => ...): the literal, which is the first argument and so the next node, opens
  // a scope body.
  scopeCall(args: Expr[], id: number): void {
    const at = this.callAt(id);
    if (at < 0 || this.calls[at].verdict !== CALL_SCOPE || args.length === 0) { return; }
    if (args[0].kind === "Closure" && args[0].params.length === 1) { this.scopeLits.set(id + 1, true); }
  }

  visitMethodCall(n: MethodCall, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (this.off(id)) { return; }
    const at = this.callAt(id);
    if (at < 0) { return; }
    const verdict = this.calls[at].verdict;
    const size = this.calls[at].objSize;
    const top = this.nf - 1;
    let hf = -1;
    if (n.object.kind === "Ident") { hf = this.handleFrame(n.object.name); }
    const direct = hf >= 0 && hf === top && this.fDepth[hf] === 0;
    if (verdict === CALL_SPAWN) {
      if (!direct) {
        this.report(`'spawn' on a task scope must be called directly in the body of the Task.scope closure that provides the scope`, n.span,
          `write it as 'Task.scope((s) => { s.spawn(() => ...) })'; inside a nested closure or a helper fn the task could outlive what it borrows`);
      }
      let isLit = false;
      let argSpan = n.span;
      if (n.args.length > 0) {
        if (n.args[0].kind === "Closure") { isLit = true; }
        const sp = n.args[0].span;
        if (sp !== undefined) { argSpan = sp; }
      }
      if (!isLit) {
        this.report(`a scoped task must be a closure literal`, argSpan,
          `write 's.spawn(() => ...)'; a closure value may borrow a frame that is gone before the scope joins`);
      } else if (direct) {
        const lit = id + 1 + size;
        this.spFrame.push(this.fSerial[hf]);
        this.spLit.push(lit);
        this.spInLoop.push(this.fLoops[hf] > 0);
        this.spSpan.push(argSpan);
        this.spawnLits.set(lit, hf);
      }
      this.skipStart = id + 1;
      this.skipEnd = id + 1 + size;
    } else if (verdict === CALL_LIVE && direct) {
      this.skipStart = id + 1;
      this.skipEnd = id + 1 + size;
    }
  }

  visitClosure(n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    for (const p of n.params) { this.declare(p.name); }
    if (this.off(id)) { return; }
    this.bumpDepth(1);
    if (this.scopeLits.has(id)) {
      const decls = new Set<string>();
      for (const p of n.params) { decls.add(p.name); }
      this.pushFrame(n.params[0].name, id, decls);
    } else {
      const hf = this.spawnLits.get(id);
      if (hf !== undefined) { this.fInSpawn[hf] = this.fInSpawn[hf] + 1; }
    }
  }

  afterClosure(_n: ClosureExpr, id: number, _kids: number[]): void {
    if (this.off(id)) { return; }
    if (this.scopeLits.has(id)) {
      this.finish(this.nf - 1);
      this.nf = this.nf - 1;
    } else {
      const hf = this.spawnLits.get(id);
      if (hf !== undefined) { this.fInSpawn[hf] = this.fInSpawn[hf] - 1; }
    }
    this.bumpDepth(-1);
  }

  // Closures reachable by calling the closures a closure captured, transitively (a `move`
  // closure owns copies, so its captures stop the walk). A task that only captures `clr` still
  // writes `v` when it runs `clr()`, and a body that calls `clr()` writes `v` too, so the rules
  // see these alongside direct captures.
  reachStart(): void {
    this.rSeen = new Map<number, boolean>();
    this.rn = [];
    this.rw = [];
  }

  reachCap(c: CapFact): void {
    const srcs = c.sources;
    for (const s of srcs) { this.walkSrc(s); }
  }

  walkSrc(src: number): void {
    if (this.rSeen.has(src)) { return; }
    const at = this.closureAt(src);
    if (at >= 0 && this.closures[at].isMove) { return; }
    this.rSeen.set(src, true);
    if (at < 0) { return; }
    const caps = this.closures[at].caps;
    for (const c of caps) {
      this.rn.push(c.name);
      this.rw.push(c.writes);
      const srcs = c.sources;
      for (const s of srcs) { this.walkSrc(s); }
    }
  }

  // The last capture of closure `at` called `name`.
  capIdx(at: number, name: string): number {
    let found = -1;
    if (at < 0) { return found; }
    let i = 0;
    while (i < this.closures[at].caps.length) {
      if (this.closures[at].caps[i].name === name) { found = i; }
      i++;
    }
    return found;
  }

  capWrites(at: number, name: string): boolean {
    const i = this.capIdx(at, name);
    return i >= 0 && this.closures[at].caps[i].writes;
  }

  reachedWrites(ns: string[], ws: boolean[], name: string): boolean {
    let j = 0;
    while (j < ns.length) {
      if (ns[j] === name && ws[j]) { return true; }
      j++;
    }
    return false;
  }

  reachedUses(ns: string[], name: string): boolean {
    let j = 0;
    while (j < ns.length) {
      if (ns[j] === name) { return true; }
      j++;
    }
    return false;
  }

  borrowIdx(name: string): number {
    let i = 0;
    while (i < this.bNames.length) {
      if (this.bNames[i] === name) { return i; }
      i++;
    }
    return -1;
  }

  borrowedBy(name: string, spawn: number): boolean {
    const b = this.borrowIdx(name);
    let i = 0;
    while (i < this.pName.length) {
      if (this.pName[i] === b && this.pSpawn[i] === spawn) { return true; }
      i++;
    }
    return false;
  }

  borrow(name: string, spawn: number): void {
    let b = this.borrowIdx(name);
    if (b < 0) {
      this.bNames.push(name);
      b = this.bNames.length - 1;
    }
    this.pName.push(b);
    this.pSpawn.push(spawn);
  }

  // Rule 2: a borrowing task captures only what outlives the scope.
  rule2(k: number, bc: number, decls: Set<string>): void {
    const li = this.closureAt(this.spLit[k]);
    if (li < 0 || this.closures[li].isMove) { return; }
    const caps = this.closures[li].caps;
    const where = this.spSpan[k];
    for (const c of caps) {
      if (this.capIdx(bc, c.name) < 0 || decls.has(c.name)) {
        this.report(`a scoped task borrows '${c.name}', which is declared inside the Task.scope body`, where,
          `the body returns before the scope joins its tasks, so '${c.name}' would be gone while the task runs; declare it before 'Task.scope', or spawn a 'move' closure that owns it`);
      } else {
        this.borrow(c.name, k);
      }
    }
    // Rule 2 already judged the closure these come through; they join rule 3 only.
    this.reachStart();
    for (const c of caps) { this.reachCap(c); }
    const reached = this.rn;
    let j = 0;
    while (j < reached.length) {
      if (!this.borrowedBy(reached[j], k)) { this.borrow(reached[j], k); }
      j++;
    }
  }

  taskWrites(spawn: number, name: string): boolean {
    const li = this.closureAt(this.spLit[spawn]);
    if (li < 0) { return false; }
    const caps = this.closures[li].caps;
    for (const c of caps) {
      if (c.name === name && c.writes) { return true; }
    }
    this.reachStart();
    for (const c of caps) { this.reachCap(c); }
    return this.reachedWrites(this.rn, this.rw, name);
  }

  fail(name: string, why: string, span: Span | undefined): void {
    this.report(`a scoped task writes '${name}', ${why}`, span,
      `a task that writes a borrowed binding must be the only one touching it until the scope joins; tasks interleave at every park, so another reader could see freed memory. Share it through a Channel or an atomic, or give each task its own`);
  }

  // Rule 3: read by everyone, or touched by exactly one task.
  rule3(b: number, bc: number, names: Set<string>): void {
    const name = this.bNames[b];
    const users: number[] = [];
    let i = 0;
    while (i < this.pName.length) {
      if (this.pName[i] === b) { users.push(this.pSpawn[i]); }
      i++;
    }
    const writers: number[] = [];
    for (const u of users) {
      if (this.taskWrites(u, name)) { writers.push(u); }
    }
    if (writers.length === 0) {
      if (this.capWrites(bc, name) || this.reachedWrites(this.bodyRN, this.bodyRW, name)) {
        const first = this.spSpan[users[0]];
        this.report(`'${name}' is borrowed by a scoped task and written by the Task.scope body`, first,
          `the body and the task interleave at every park, so a write could free memory the task is reading; let one side own '${name}' (a 'move' closure), or share it through a Channel or an atomic`);
      }
      return;
    }
    const w = writers[0];
    const wSpan = this.spSpan[w];
    if (writers.length > 1) {
      const second = this.spSpan[writers[1]];
      this.fail(name, "and so does another task in the same scope", second);
    } else if (this.spInLoop[w]) {
      this.fail(name, "and it is spawned in a loop, so several tasks write it", wSpan);
    } else if (users.length > 1) {
      let other = w;
      for (const u of users) {
        if (other === w && u !== w) { other = u; }
      }
      const otherSpan = this.spSpan[other];
      this.fail(name, "and another task in the same scope reads it", otherSpan);
    } else if (names.has(name) || this.reachedUses(this.bodyRN, name)) {
      this.fail(name, "and the Task.scope body uses it too", wSpan);
    }
  }

  finish(fi: number): void {
    const ser = this.fSerial[fi];
    const bc = this.closureAt(this.fBody[fi]);
    const decls = this.fDecls[fi];
    const names = this.fNames[fi];
    // The body's writes and uses through closures it runs itself (not only via a task).
    this.reachStart();
    if (bc >= 0) {
      const caps = this.closures[bc].caps;
      for (const c of caps) {
        if (names.has(c.name)) { this.reachCap(c); }
      }
    }
    this.bodyRN = [];
    this.bodyRW = [];
    let j = 0;
    while (j < this.rn.length) {
      this.bodyRN.push(this.rn[j]);
      this.bodyRW.push(this.rw[j]);
      j++;
    }
    this.bNames = [];
    this.pName = [];
    this.pSpawn = [];
    let k = 0;
    while (k < this.spFrame.length) {
      if (this.spFrame[k] === ser) { this.rule2(k, bc, decls); }
      k++;
    }
    let b = 0;
    while (b < this.bNames.length) {
      this.rule3(b, bc, names);
      b++;
    }
  }
}

export function taskScopesFindings(input: TaskScopesInput): Finding[] {
  const scan = new TaskScopeScan(input.calls, input.closures);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
