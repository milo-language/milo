// Reference interpreter with tasks: green tasks, a scheduler and the rules of docs/semantics/milo.md
// section 5 (R-TASK-*). Each task is a generator running the interpreter's generator twins
// (src/interp-gen.ts, generated from src/interp.ts), so it can stop in the middle of an expression
// and be resumed later; a task has its own frames, temporaries and pending operands, swapped in when
// it runs. The library's operations on tasks and channels are natives in src/interp-co-natives.ts.
//
// The scheduler mirrors std/runtime.milo: one task runs at a time and keeps the CPU until it parks,
// yields or ends (nothing preempts it); a FIFO run queue; main is itself a task, and its return
// ends the program with every other task abandoned. Which ready task runs next is ONE method,
// `pickNext`: the hook for exploring other schedules.
import type { Function as AstFn, Program } from "./ast";
import type { CheckResult } from "./checker";
import { Interp, type Frame, type RunResult } from "./interp";
import { InterpGen, type Gen } from "./interp-gen";
import { ExitProgram, NeedTasks, Panic, type ClosureV, type Slot, type Value } from "./interp-values";
import type { Native } from "./interp-natives";
import type { SysOptions } from "./interp-sys";
import { replyAndClose } from "./interp-net";

interface Ctx { frames: Frame[]; temps: Slot[]; depth: number; pend: Slot[] }
export interface Task {
  id: number;
  state: "ready" | "running" | "parked" | "done";
  gen: Gen | null;
  ctx: Ctx;
  isMain: boolean;
  joiner: Task | null;
  scopesOpen: number; // Task.scope calls this task is inside: a panic then aborts instead of retiring it
  scope: { live: number; waiter: Task | null } | null;
  cacheable: boolean; // spawned with the default stack size
  why: string; // what a parked task waits for, for the deadlock report
  panicReply?: { fd: number; bytes: Uint8Array }; // R-TASK-PANIC: sent on fd if the task panics
}

// The scheduler runs this many tasks before it moves the front of the queue to the back (std/runtime
// schedulerRunOnce's batch of 32): it changes the order only when more than 32 tasks are ready.
const BATCH = 32;
const isGen = (v: unknown): v is Generator<unknown, Value, unknown> => !!v && typeof v === "object" && typeof (v as { next?: unknown }).next === "function";

export class InterpCo extends InterpGen {
  override coMode = true;
  tasks = new Map<number, Task>();
  runq: Task[] = [];
  cur!: Task;
  drainWaiter: Task | null = null;
  sleepers: { t: Task; at: number }[] = [];
  private nextTaskId = 1;
  // contexts of finished default-stack tasks the scheduler keeps for the next spawn (at most 64, as std/runtime)
  cachedContexts = 0;
  // The compiled program runs `main` as a green task only when Task.spawn / spawnWithStack is reachable from it
  // (startup.ts mainCanSpawnGreenTasks), and only then is the scheduler torn down at exit. Task.scope spawns
  // through spawnRaw and does not count. Approximated by whether either of those natives ran.
  greenMain = false;
  scopeSpawned = false;
  // a task waited on a descriptor: the scheduler allocated its table of fd waiters, one more block it leaves behind (R-TASK-ABANDON)
  fdWaited = false;

  // R-TASK-PICK: the scheduling decision. Takes the ready tasks, front of the queue first, and returns
  // the index to run. FIFO by default, as the library's run queue is.
  // With a `schedule` (R-EXPLORE-REPLAY) the n-th choice point (two or more tasks ready) takes schedule[n];
  // past the list, or when an index does not fit the ready list, it falls back to the front.
  schedule: number[] | null = null;
  choicesMade = 0;
  scheduleMismatch = false;
  // R-TASK-PICK
  pickNext(ready: readonly Task[]): number {
    if (!this.schedule || ready.length < 2) return 0;
    const i = this.schedule[this.choicesMade++];
    if (i === undefined) return 0;
    if (i >= ready.length) { this.scheduleMismatch = true; return 0; }
    return i;
  }
  // R-EXPLORE-INDEP: the exploration driver (src/interp-explore.ts) sets this to learn what each step touches.
  // `key` is any object or string naming a shared thing: a channel, a task, a global, a heap block.
  onTouch: ((key: unknown) => void) | null = null;
  touch(key: unknown): void { if (this.onTouch) this.onTouch(key); }
  // messages of panics that retired a task (R-TASK-PANIC) instead of ending the program
  taskPanics: string[] = [];

  liveTasks(): number { return this.tasks.size; }

  // R-TASK-SPAWN
  spawnTask(f: ClosureV, scope: Task["scope"] = null, cacheable = true): Task {
    if (cacheable && this.cachedContexts > 0) this.cachedContexts--;
    this.touch("spawn"); // task ids come from one counter, so two spawns do not commute
    const t: Task = { id: this.nextTaskId++, state: "ready", gen: null, ctx: { frames: [], temps: [], depth: 0, pend: [] }, isMain: false, joiner: null, scopesOpen: 0, scope, cacheable: true, why: "" };
    t.cacheable = cacheable;
    t.gen = this.taskBody(f);
    this.tasks.set(t.id, t);
    this.runq.push(t);
    return t;
  }
  // R-NET-THREAD: pthread_create's start routine, by function name, as one more task. A panic in it ends the program (it is no green
  // task: scopesOpen > 0), and `done` gets the routine's return value for pthread_join.
  spawnThread(name: string, args: Value[], done: (ret: Value) => void): Task {
    const t = this.spawnTask({ k: "closure", params: [], paramRefs: [], body: [], env: [], owning: false, ret: { tag: "void" } }, null, false);
    t.scopesOpen = 1;
    t.gen = this.threadBody(name, args, done);
    return t;
  }
  // R-NET-THREAD
  *threadBody(name: string, args: Value[], done: (ret: Value) => void): Gen {
    const r = yield* this.callNamed$g(name, args);
    this.dropTemps(0);
    done(r);
    return undefined;
  }
  // R-TASK-PANIC R-TASK-MAIN
  *taskBody(f: ClosureV): Gen {
    yield* this.callValue$g(f, []);
    this.dropTemps(0); // a body's last expression leaves its temporaries for the caller to drop; a task has no caller
    this.dropValue(f); // the task's closure drops the captures its body did not move out
    return undefined;
  }

  // R-TASK-PARK: the caller leaves the CPU and is not ready until someone unparks it.
  *park(why: string): Gen<void> {
    this.cur.state = "parked";
    this.cur.why = why;
    yield;
    this.cur.why = "";
  }
  // R-TASK-YIELD: the caller goes to the back of the run queue.
  *yieldNow(): Gen<void> {
    this.cur.state = "ready";
    yield;
  }
  // R-TIME: sleepMs parks the task until the clock reaches now + ms; sleeping 0 or less is a yield.
  *sleep(ms: number): Gen<void> {
    if (ms <= 0) { yield* this.yieldNow(); return; }
    this.touch("clock");
    this.sleepers.push({ t: this.cur, at: this.clock + ms });
    yield* this.park("sleepMs");
  }
  // R-TIME
  private wakeSleepers(): boolean {
    if (this.sleepers.length === 0) return false;
    this.clock = Math.min(...this.sleepers.map(x => x.at));
    const due = this.sleepers.filter(x => x.at <= this.clock);
    this.sleepers = this.sleepers.filter(x => x.at > this.clock);
    for (const x of due) this.unpark(x.t); // in the order they went to sleep
    return true;
  }
  // R-TASK-UNPARK: a parked task becomes ready at the back of the queue; any other state is left alone.
  unpark(t: Task): void {
    if (t.state !== "parked") return;
    this.touch(t);
    t.state = "ready";
    this.runq.push(t);
  }

  // A native runs here; a task operation is a generator (or a plain function that needs the scheduler).
  override *runNative$g(nat: Native, args: Value[], e?: import("./ast").Expr): Gen {
    const r = nat(this, args, e) as Value | Generator<unknown, Value, unknown>;
    return isGen(r) ? yield* r : r;
  }

  private swapIn(t: Task): void {
    this.frames = t.ctx.frames; this.temps = t.ctx.temps; this.depth = t.ctx.depth; this.pend = t.ctx.pend;
  }
  private swapOut(t: Task): void {
    t.ctx = { frames: this.frames, temps: this.temps, depth: this.depth, pend: this.pend };
    this.frames = []; this.temps = []; this.depth = 0; this.pend = [];
  }
  // R-TASK-JOIN
  private reap(t: Task): void {
    this.tasks.delete(t.id);
    this.touch(t);
    if (t.scope) this.touch(t.scope);
    if (t.isMain) this.touch("exit"); // ends the program: every task still ready is abandoned
    // Measured on compiled programs with a plain main: the stack of a task reaped with no other task left does not
    // end up in the cache. (With a green main the main task is always still there.)
    const othersLeft = this.greenMain || [...this.tasks.values()].some(x => !x.isMain);
    if (t.cacheable && othersLeft && this.cachedContexts < 64) this.cachedContexts++;
    if (t.joiner) this.unpark(t.joiner);
    const sc = t.scope;
    if (sc && --sc.live === 0 && sc.waiter) { const w = sc.waiter; sc.waiter = null; this.unpark(w); }
    if (this.drainWaiter && this.tasks.size <= 1) { const w = this.drainWaiter; this.drainWaiter = null; this.unpark(w); }
  }
  // R-TASK-ABANDON: when main returns with tasks left, the library leaves its scheduler up (a worker thread
  // may still use it), so its own blocks stay allocated: the scheduler's five (header, context, event loop,
  // transfer mutex, stack cache), three for each abandoned task (task, join cell, context) and three more
  // for one asleep (its select state). Idle stack contexts in the cache stay too. With no task left and
  // a green main the scheduler is torn down and nothing remains.
  private leakRuntime(): void {
    // No task left: a green main tears the scheduler down; a plain main (scope-only programs) never does.
    if (this.tasks.size === 0 && (this.greenMain || !this.scopeSpawned)) return;
    const asleep = new Set(this.sleepers.map(x => x.t));
    let n = 5 + this.cachedContexts + (this.fdWaited ? 1 : 0);
    for (const t of this.tasks.values()) n += asleep.has(t) ? 6 : 3;
    for (let i = 0; i < n; i++) this.alloc();
  }
  private deadlock(): never {
    const blocked = [...this.tasks.values()].map(t => `task ${t.id}${t.isMain ? " (main)" : ""} parked in ${t.why || "park"}`);
    return this.stuck("S-DEADLOCK", `every task is blocked and none can wake another: ${blocked.join("; ")}`);
  }

  // R-TASK-MAIN: main runs as the first task; the program ends when it returns.
  override runMain(main: AstFn): Value {
    const t: Task = { id: this.nextTaskId++, state: "ready", gen: null, ctx: { frames: [], temps: [], depth: 0, pend: [] }, isMain: true, joiner: null, scopesOpen: 0, scope: null, cacheable: false, why: "" };
    t.gen = this.callFn$g(main, []);
    this.tasks.set(t.id, t);
    this.runq.push(t);
    let batch = 0;
    for (;;) {
      if (this.runq.length === 0 && !this.wakeSleepers()) return this.deadlock();
      if (batch >= BATCH) { this.runq.push(this.runq.shift()!); batch = 0; }
      const task = this.runq.splice(this.pickNext(this.runq), 1)[0]!;
      task.state = "running";
      this.cur = task;
      this.swapIn(task);
      let r: IteratorResult<unknown, Value>;
      try { r = task.gen!.next(); }
      catch (e) {
        // R-TASK-ABANDON: exit from a task leaves the scheduler up and the other tasks where they stand, as main returning does
        if (e instanceof ExitProgram && !e.killed) this.leakRuntime();
        // R-TASK-PANIC: a panic in a task that is not main and has no open scope retires that task, not the program
        if (!(e instanceof Panic) || task.isMain || task.scopesOpen > 0) throw e;
        this.err.push(...new TextEncoder().encode(e.message + "\n"));
        if (task.panicReply) replyAndClose(this, task.panicReply.fd, task.panicReply.bytes);
        this.taskPanics.push(e.message);
        this.aborted = false;
        r = { done: true, value: undefined };
      }
      finally { this.swapOut(task); }
      batch++;
      if (r.done) {
        task.state = "done";
        this.reap(task);
        if (task.isMain) { this.leakRuntime(); return r.value; }
      } else if ((task.state as string) === "ready") this.runq.push(task);
    }
  }
}


/**
 * Run a checked program. The plain interpreter goes first: it is faster, and most programs never
 * spawn a task. At the first task operation it gives up (NeedTasks) and the run starts over in the
 * task interpreter; a run is deterministic and its output is buffered until the end, so the rerun
 * shows exactly what a run with tasks from the start would.
 */
// schedule: replay these choices (R-EXPLORE-REPLAY); it runs under the task interpreter from the start
export interface RunOptions { contractChecks?: boolean; entryFile?: string; sys?: SysOptions; schedule?: number[] }
// R-TASK-MAIN
export function runChecked(program: Program, checked: CheckResult, opts: RunOptions = {}): { it: Interp; result: RunResult } {
  const make = (c: new (p: Program, r: CheckResult) => Interp): Interp => {
    const i = new c(program, checked);
    i.contractChecks = !!opts.contractChecks;
    i.entryFile = opts.entryFile ?? "";
    i.sysOptions = opts.sys ?? {};
    return i;
  };
  let it: Interp = make(Interp);
  if (!opts.schedule) {
    try {
      return { it, result: it.run() };
    } catch (e) {
      if (!(e instanceof NeedTasks)) { (e as { interp?: Interp }).interp = it; throw e; }
    }
  }
  it = make(InterpCo);
  if (opts.schedule) (it as InterpCo).schedule = opts.schedule;
  try {
    return { it, result: it.run() };
  } catch (e) {
    (e as { interp?: Interp }).interp = it;
    throw e;
  }
}
