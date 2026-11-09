// The thread-boundary check, in the portable subset: plain data in, findings out. A closure handed
// to a `@thread` fn runs on a real OS thread, so it may not capture a non-Send value, and it may
// not touch a mutable global that races: a write outside a `@synchronized` closure, or a read of
// a global written anywhere. What each call resolves to, which fns are entry points or critical
// sections and what each node writes are checker facts the host restates here keyed by node id
// (src/checker-thread-boundary-host.ts), numbered the way the walker numbers nodes.
// What a call through a value may run depends on the scope the walk is in, so the pass asks
// ImplicitModel (src/checker-implicit-calls.ts) with its current scope. Following a call into a
// callee is a worklist the driver runs, never a walk started from inside a visit: each body is
// walked once into a list of events (a touch, a call to follow, a closure to run), and the driver
// plays the events depth first, which is the order the findings are reported in.
import type { Span, Stmt, Expr, ClosureExpr } from "./ast";
import { walkStmts, walkExprs } from "./ast-walk-thread-boundary";
import type { Parent, EdgeKey } from "./ast-walk-types";
import { ImplicitModel, Scope, INDIRECT, type FnFact, type NodeFact } from "./checker-implicit-calls";

// kind: 0 a fn body, 1 a global's initializer (`value`), 2 a closure literal's body.
export interface BodyTask { kind: number; body: Stmt[]; value: Expr[]; base: number; name: string; nodeId: number; params: string[] }

export interface SendFact { message: string; hint: string; span: Span | undefined }
// A closure literal handed to a `@thread` fn: the Send errors for its captures, and the replay
// warning when it shares memory through a raw pointer or an `unsafe` block ("" for none).
export interface EntryFact { id: number; span: Span | undefined; sends: SendFact[]; rawMessage: string; rawHint: string }
export interface SayFact { name: string; text: string }

export interface ThreadInput {
  tasks: BodyTask[];
  fns: FnFact[];
  facts: NodeFact[];
  entries: EntryFact[];
  says: SayFact[];
  globals: string[];
  stdGlobals: string[];
}

// level: 0 an error, 1 a warning under `code`. `ref` is the entry closure a replay-hole warning is about.
export interface Finding { level: number; code: string; message: string; hint: string; span: Span | undefined; ref: number }

const TASK_FN = 0;
const TASK_GLOBAL = 1;
const TASK_CLOSURE = 2;

const MODE_COLLECT = 0;
const MODE_REACH = 1;
const MODE_NOTES = 2;
const MODE_SCAN = 3;
const MODE_SITES = 4;

const EV_TOUCH = 0;
const EV_WARN = 1;
const EV_FOLLOW = 2;
const EV_CLOSURE = 3;
const EV_INDIRECT = 4;

function spanFile(s: Span | undefined): string {
  if (s !== undefined) {
    const f = s.file;
    if (f !== undefined) { return f; }
  }
  return "";
}

function spanLine(s: Span | undefined): number {
  if (s !== undefined) { return s.line; }
  return 0;
}

function spanCol(s: Span | undefined): number {
  if (s !== undefined) { return s.col; }
  return 0;
}

function spanOr(s: Span | undefined, fallback: Span | undefined): Span | undefined {
  if (s !== undefined) { return s; }
  return fallback;
}

function baseName(path: string): string {
  let i = path.length;
  while (i > 0 && path.charCodeAt(i - 1) !== 47) { i--; }
  return path.slice(i, path.length);
}

export class ThreadScan {
  next = 0;
  mode = 0;
  globals = new Set<string>();
  nGlobals = 0;
  stdGlobals = new Set<string>();
  says = new Map<string, string>();
  fnTask = new Map<string, number>();
  closureTask = new Map<number, number>();
  entryIdx = new Map<number, number>();

  // The body being walked: its scope, the names it declared (flat), and how many critical-section
  // closures enclose the node (their subtrees are skipped).
  scope = new Scope("", -1);
  bound = new Set<string>();
  skip = 0;

  // Notes: the first write found per mutable global.
  wName = new Map<string, number>();
  wSpan: (Span | undefined)[] = [];

  // Entry call sites found in live code, in walk order: the entry fn and the closure literal's node id.
  siteEntry: string[] = [];
  siteClosure: number[] = [];

  // The current entry's scan.
  entry = "";
  entrySpan: Span | undefined = undefined;
  evKind: number[] = [];
  evStr: string[] = [];
  evSpan: (Span | undefined)[] = [];
  evNum: number[] = [];
  evFlag: boolean[] = [];
  tName: string[] = [];
  tSpan: (Span | undefined)[] = [];
  tVia: string[] = [];
  tWrite: boolean[] = [];
  done = new Set<string>();
  // Open frames (a range of events and the next one to play), and the callee chain below them.
  nFrame = 0;
  fIdx: number[] = [];
  fEnd: number[] = [];
  fPushed: boolean[] = [];
  nChain = 0;
  chain: string[] = [];

  reported = new Set<string>();
  out: Finding[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public model: ImplicitModel, public entries: EntryFact[]) {}

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  setup(tasks: BodyTask[], globalNames: string[], stdNames: string[], says: SayFact[]): void {
    this.model.index();
    for (const g of globalNames) { this.globals.add(g); }
    this.nGlobals = globalNames.length;
    for (const g of stdNames) { this.stdGlobals.add(g); }
    for (const s of says) { this.says.set(s.name, s.text); }
    let t = 0;
    while (t < tasks.length) {
      if (tasks[t].kind === TASK_FN) { this.fnTask.set(tasks[t].name, t); }
      if (tasks[t].kind === TASK_CLOSURE) { this.closureTask.set(tasks[t].nodeId, t); }
      t++;
    }
    let e = 0;
    while (e < this.entries.length) {
      this.entryIdx.set(this.entries[e].id, e);
      e++;
    }
  }

  // ---- walking ----

  // k is the closure literal whose written-in scope the body starts from, or -1.
  walkTask(tasks: BodyTask[], ti: number, mode: number, fn: string, env: number, k: number, withParams: boolean): void {
    this.mode = mode;
    this.scope.reset(fn, env);
    if (k >= 0) { this.model.fillClosureScope(k, this.scope); }
    this.bound = new Set<string>();
    this.skip = 0;
    this.next = tasks[ti].base;
    if (withParams) {
      for (const p of tasks[ti].params) { this.bound.add(p); }
    }
    if (tasks[ti].kind === TASK_GLOBAL) {
      walkExprs(this, tasks[ti].value, { kind: "None", id: -1, op: "" }, "root");
    } else {
      walkStmts(this, tasks[ti].body, { kind: "None", id: -1, op: "" }, "root");
    }
  }

  visitClosure(_n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if ((this.mode === MODE_NOTES || this.mode === MODE_SCAN)) {
      const at = this.model.factAt(id);
      if (at >= 0 && this.model.facts[at].critArg) { this.skip++; }
    }
  }

  afterClosure(_n: ClosureExpr, id: number, _kids: number[]): void {
    if ((this.mode === MODE_NOTES || this.mode === MODE_SCAN)) {
      const at = this.model.factAt(id);
      if (at >= 0 && this.model.facts[at].critArg) { this.skip--; }
    }
  }

  bindAll(at: number): void {
    const binds = this.model.facts[at].binds;
    let i = 0;
    while (i < binds.length) {
      this.scope.bind(binds[i]);
      i++;
    }
  }

  node(id: number): void {
    const at = this.model.factAt(id);
    if (at < 0) { return; }
    if (this.mode === MODE_COLLECT) {
      this.bindAll(at);
      this.model.collect(at, id, this.scope);
    } else if (this.mode === MODE_REACH) {
      this.bindAll(at);
      this.model.reachNode(at, this.scope);
    } else if (this.mode === MODE_NOTES) {
      this.noteNode(at);
    } else if (this.mode === MODE_SCAN) {
      this.scanNode(at);
    } else {
      this.siteNode(at);
    }
  }

  // ---- phase: where the program writes a mutable global outside a critical section ----

  noteNode(at: number): void {
    const f = this.model.facts[at];
    if (f.critArg || this.skip > 0) { return; }
    if (f.declares !== "") { this.bound.add(f.declares); }
    // Flat scoping as in the scan: a closure param shadowing a global hides it for the rest of
    // the enclosing body too, which can only miss a write, never invent one.
    if (f.closure) {
      for (const p of f.binds) { this.bound.add(p); }
    }
    for (const r of f.writes) {
      if (this.globals.has(r) && !this.stdGlobals.has(r) && !this.bound.has(r) && !this.wName.has(r)) {
        this.wName.set(r, this.wSpan.length);
        this.wSpan.push(f.span);
      }
    }
  }

  // ---- phase: entry call sites in live code ----

  siteNode(at: number): void {
    const f = this.model.facts[at];
    if (this.skip > 0 || f.entry === "") { return; }
    for (const a of f.args) {
      if (a.closure) {
        this.siteEntry.push(f.entry);
        this.siteClosure.push(a.id);
      }
    }
  }

  // ---- phase: one body's events ----

  pushEvent(kind: number, str: string, span: Span | undefined, num: number, flag: boolean): void {
    this.evKind.push(kind);
    this.evStr.push(str);
    this.evSpan.push(span);
    this.evNum.push(num);
    this.evFlag.push(flag);
  }

  hit(name: string, span: Span | undefined, write: boolean): void {
    if (name === "" || !this.globals.has(name) || this.bound.has(name)) { return; }
    this.pushEvent(EV_TOUCH, name, span, 0, write);
  }

  scanNode(at: number): void {
    const f = this.model.facts[at];
    if (f.critArg || this.skip > 0) { return; }
    if (f.declares !== "") { this.bound.add(f.declares); }
    this.bindAll(at);
    const span = spanOr(f.span, this.entrySpan);
    // `G.push(x)` is a write that never appears as an Assign. A `&self` method is not.
    for (const r of f.writes) { this.hit(r, span, true); }
    if (f.ident !== "") { this.hit(f.ident, span, false); }

    // A call through a value has no static target; the walk below follows it fail closed. This
    // opt-in warning still names the opacity itself. Skipped entirely when the program has no
    // mutable globals, since then an opaque call cannot reach one.
    if (this.nGlobals > 0 && f.indirectMode === 1) { this.pushEvent(EV_WARN, "", span, 0, false); }
    if (f.callish) {
      // Stop at a critical section: everything its closure argument does is serialized by the primitive.
      if (f.critical) { return; }
      if (f.callee !== "" && f.indirectMode === 0) {
        this.pushEvent(EV_FOLLOW, f.callee, span, this.model.envFor(f.callee, at, this.scope), false);
      }
    }
    const ts: string[] = [];
    this.model.implicitTargets(at, this.scope, ts);
    for (const t of ts) {
      if (this.model.closureOfId.has(t)) {
        this.pushEvent(EV_CLOSURE, t, span, 0, false);
      } else if (t === INDIRECT) {
        this.pushEvent(EV_INDIRECT, t, span, 0, false);
      } else {
        this.pushEvent(EV_FOLLOW, t, span, -1, false);
      }
    }
  }

  // ---- the driver ----

  say(t: string): string {
    if (t === INDIRECT) { return "a call through a function value"; }
    const k = this.model.closureOfId.get(t);
    if (k !== undefined) {
      const span = this.model.facts[this.model.closureFact[k]].span;
      let line = "?";
      if (span !== undefined) { line = `${span.line}`; }
      return `the closure on line ${line}`;
    }
    const got = this.says.get(t);
    if (got !== undefined) { return got; }
    return `'${t}'`;
  }

  via(): string {
    if (this.nChain === 0) { return ""; }
    let out = " (via ";
    let i = 0;
    while (i < this.nChain) {
      if (i > 0) { out += " → "; }
      out += this.say(this.chain[i]);
      i++;
    }
    return out + ")";
  }

  setChain(i: number, name: string): void {
    if (i < this.chain.length) { this.chain[i] = name; } else { this.chain.push(name); }
  }

  openFrame(start: number, end: number, name: string, pushed: boolean): void {
    if (pushed) {
      this.setChain(this.nChain, name);
      this.nChain++;
    }
    if (this.nFrame < this.fIdx.length) {
      this.fIdx[this.nFrame] = start;
      this.fEnd[this.nFrame] = end;
      this.fPushed[this.nFrame] = pushed;
    } else {
      this.fIdx.push(start);
      this.fEnd.push(end);
      this.fPushed.push(pushed);
    }
    this.nFrame++;
  }

  // Walks a callee body for the events it holds and opens a frame over them.
  followBody(tasks: BodyTask[], name: string, env: number): void {
    const key = `${name}|${this.model.envKey(env)}`;
    if (this.done.has(key)) { return; }
    this.done.add(key);
    const ti = this.fnTask.get(name);
    if (ti !== undefined) {
      const start = this.evKind.length;
      this.walkTask(tasks, ti, MODE_SCAN, name, env, -1, true);
      this.openFrame(start, this.evKind.length, name, true);
    }
  }

  runClosure(tasks: BodyTask[], id: string): void {
    const k = this.model.closureOfId.get(id);
    if (k !== undefined && !this.done.has(id) && !this.model.facts[this.model.closureFact[k]].critArg) {
      this.done.add(id);
      const ti = this.closureTask.get(this.model.closureNode[k]);
      if (ti !== undefined) {
        const start = this.evKind.length;
        const owner = this.model.closureFn[k];
        this.walkTask(tasks, ti, MODE_SCAN, owner, -1, k, true);
        this.openFrame(start, this.evKind.length, id, true);
      }
    }
  }

  // Reports every unsynchronized global reachable from the closure literal at `nodeId`, following
  // static calls so a touch three helpers deep still names the thread it escaped to. Approximate
  // scoping on purpose: one flat bound-name set per body, which can only make this miss a
  // shadowed global, never invent one. A write reached without crossing a critical section races
  // on its own; a read only races if some write is also unsynchronized.
  scanEntry(tasks: BodyTask[], entry: string, k: number, ti: number): void {
    this.entry = entry;
    this.entrySpan = this.model.facts[this.model.closureFact[k]].span;
    this.evKind = [];
    this.evStr = [];
    this.evSpan = [];
    this.evNum = [];
    this.evFlag = [];
    this.tName = [];
    this.tSpan = [];
    this.tVia = [];
    this.tWrite = [];
    this.done = new Set<string>();
    this.nFrame = 0;
    this.nChain = 0;
    // The entry closure's own body: its params are not bound names.
    const owner = this.model.closureFn[k];
    this.walkTask(tasks, ti, MODE_SCAN, owner, -1, k, false);
    this.openFrame(0, this.evKind.length, "", false);
    while (this.nFrame > 0) {
      const top = this.nFrame - 1;
      if (this.fIdx[top] >= this.fEnd[top]) {
        if (this.fPushed[top]) { this.nChain--; }
        this.nFrame--;
        continue;
      }
      const e = this.fIdx[top];
      this.fIdx[top] = e + 1;
      const kind = this.evKind[e];
      if (kind === EV_TOUCH) {
        this.tName.push(this.evStr[e]);
        this.tSpan.push(this.evSpan[e]);
        this.tVia.push(this.via());
        this.tWrite.push(this.evFlag[e]);
      } else if (kind === EV_WARN) {
        const span = this.evSpan[e];
        const key = `${entry}|indirect|${spanLine(span)}:${spanCol(span)}`;
        if (!this.reported.has(key)) {
          this.reported.add(key);
          this.out.push({
            level: 1,
            code: "opaque-call-on-thread",
            message: `cannot tell whether this call touches a mutable global, and it runs on a real OS thread`,
            hint: `a call through a function value has no static target, so nothing here can see what it does. ` +
              `Call a named function instead, or make the globals it may touch atomics from 'std/sync'`,
            span: span,
            ref: -1,
          });
        }
      } else if (kind === EV_FOLLOW) {
        const callee = this.evStr[e];
        this.followBody(tasks, callee, this.evNum[e]);
      } else if (kind === EV_CLOSURE) {
        const cid = this.evStr[e];
        this.runClosure(tasks, cid);
      } else {
        if (!this.done.has(INDIRECT)) {
          this.done.add(INDIRECT);
          const start = this.evKind.length;
          let c = 0;
          while (c < this.model.closureNode.length) {
            const cid = this.model.closureIdOf(c);
            this.pushEvent(EV_CLOSURE, cid, undefined, 0, false);
            c++;
          }
          let v = 0;
          while (v < this.model.fnValues.length) {
            const fv = this.model.fnValues[v];
            this.pushEvent(EV_FOLLOW, fv, undefined, -1, false);
            v++;
          }
          this.openFrame(start, this.evKind.length, INDIRECT, true);
        }
      }
    }
    this.reportTouches();
  }

  touchKey(i: number): string {
    return `${this.tName[i]}@${spanFile(this.tSpan[i])}:${spanLine(this.tSpan[i])}:${spanCol(this.tSpan[i])}`;
  }

  reportTouches(): void {
    // A read races with a write on any thread, so a global the program writes anywhere (outside
    // a critical section) is racy here even when this thread only reads it.
    const racy = new Set<string>();
    let i = 0;
    while (i < this.tName.length) {
      if (this.tWrite[i] || this.wName.has(this.tName[i])) { racy.add(this.tName[i]); }
      i++;
    }
    i = 0;
    while (i < this.tName.length) {
      const name = this.tName[i];
      if (!racy.has(name)) { i++; continue; }
      // One report per global per thread entry: `g = g + 1` is a read and a write of the same
      // mistake, and repeating it per mention buries the fix.
      const key = `${this.entry}|${name}`;
      if (this.reported.has(key)) { i++; continue; }
      this.reported.add(key);
      // And none for an entry that reaches a touch another entry already reported: Promise.blocking's
      // caller and the wrapper closure it hands spawnOsThreadDetached both reach the same user code.
      let seen = false;
      let readOnly = true;
      let j = 0;
      while (j < this.tName.length) {
        if (this.tName[j] === name) {
          if (this.reported.has(this.touchKey(j))) { seen = true; }
          if (this.tWrite[j]) { readOnly = false; }
        }
        j++;
      }
      j = 0;
      while (j < this.tName.length) {
        if (this.tName[j] === name) { this.reported.add(this.touchKey(j)); }
        j++;
      }
      if (seen) { i++; continue; }
      const where = this.tVia[i];
      let hint = "";
      if (readOnly) {
        let at = "";
        const w = this.wName.get(name);
        if (w !== undefined) {
          const ws = this.wSpan[w];
          if (ws !== undefined) { at = ` (${baseName(spanFile(ws))}:${ws.line})`; }
        }
        hint = `this thread only reads '${name}', but the program writes it${at}, and a read racing a write is a ` +
          `data race (a push can realloc the buffer under the reader). If it is filled once, make it ` +
          `'let ${name}' with an initializer that builds it (a non-constant initializer runs on ` +
          `first read, exactly once); otherwise pass the value into the closure, use an atomic from ` +
          `'std/sync', or do every write inside one 'Once.run' that the thread also calls first`;
      } else {
        hint = `two threads touching one unsynchronized global is a data race — make '${name}' an ` +
          `atomic from 'std/sync' (AtomicI64/AtomicBool/AtomicI32/AtomicU64), do the mutation inside ` +
          `'Once.run', or write 'thread_local var ${name}' if each thread should get its own copy`;
      }
      this.out.push({
        level: 0,
        code: "",
        message: `'${name}' is a mutable global, and this code runs on a real OS thread${where}`,
        hint: hint,
        span: this.tSpan[i],
        ref: -1,
      });
      i++;
    }
  }

  // One entry closure: its Send errors, the scan of what it reaches, then the replay warning.
  atEntry(tasks: BodyTask[], nodeId: number, entry: string): void {
    const e = this.entryIdx.get(nodeId);
    if (e !== undefined) {
      for (const s of this.entries[e].sends) {
        this.out.push({ level: 0, code: "", message: s.message, hint: s.hint, span: s.span, ref: -1 });
      }
    }
    const k = this.model.closureOfNode.get(nodeId);
    const ti = this.closureTask.get(nodeId);
    if (k !== undefined && ti !== undefined) { this.scanEntry(tasks, entry, k, ti); }
    if (e !== undefined && this.entries[e].rawMessage !== "") {
      this.out.push({ level: 1, code: "replay-hole", message: this.entries[e].rawMessage, hint: this.entries[e].rawHint, span: this.entries[e].span, ref: nodeId });
    }
  }

  // Walks every body of one kind with a fresh scope named for its owner.
  walkAll(tasks: BodyTask[], mode: number, live: boolean): void {
    let t = 0;
    while (t < tasks.length) {
      const kind = tasks[t].kind;
      if (kind === TASK_FN || kind === TASK_GLOBAL) {
        if (!live || kind === TASK_GLOBAL || this.model.reach.has(tasks[t].name)) {
          this.walkTask(tasks, t, mode, tasks[t].name, -1, -1, kind === TASK_FN && mode === MODE_NOTES);
        }
      }
      t++;
    }
  }

  run(tasks: BodyTask[]): void {
    this.walkAll(tasks, MODE_COLLECT, false);
    this.model.solve(this.scope);
    // An unused generic instance still has a body that spawns a thread, and scanning it would
    // report races in code that never runs: only reachable fns are checked.
    this.model.reachRoots();
    let g = 0;
    while (g < tasks.length) {
      if (tasks[g].kind === TASK_GLOBAL) { this.walkTask(tasks, g, MODE_REACH, "", -1, -1, false); }
      g++;
    }
    let q = 0;
    while (q < this.model.reachQueue.length) {
      const name = this.model.reachQueue[q];
      q++;
      const ti = this.fnTask.get(name);
      if (ti !== undefined) { this.walkTask(tasks, ti, MODE_REACH, name, -1, -1, false); }
    }
    this.walkAll(tasks, MODE_NOTES, true);
    this.walkAll(tasks, MODE_SITES, true);
    let s = 0;
    while (s < this.siteEntry.length) {
      const entryName = this.siteEntry[s];
      this.atEntry(tasks, this.siteClosure[s], entryName);
      s++;
    }
  }
}

export function threadBoundaryFindings(input: ThreadInput): Finding[] {
  const scan = new ThreadScan(new ImplicitModel(input.fns, input.facts), input.entries);
  scan.setup(input.tasks, input.globals, input.stdGlobals, input.says);
  scan.run(input.tasks);
  return scan.out;
}
