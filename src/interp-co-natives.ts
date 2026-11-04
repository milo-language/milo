// Reference interpreter, tasks and synchronization: the library's Task, TaskScope, Channel, WaitGroup,
// Once and atomics, replaced by natives because std/runtime.milo and std/sync.milo keep them in raw
// memory under pthread locks and swapcontext. Rules R-TASK-*, R-CHAN-*, R-WG, R-ONCE, R-ATOMIC in
// docs/semantics/milo.md section 5.
//
// A native that can park its task is a generator (`co`): the task interpreter (src/interp-co.ts) runs
// it on the task's own stack of frames and it `yield`s to hand control back to the scheduler.
// Everything here assumes exactly one task runs at a time, so no operation needs a lock.
import type { Expr } from "./ast";
import type { InterpCo, Task } from "./interp-co";
import type { Interp } from "./interp";
import { staticStr, type ClosureV, type HandleV, type Ref, type Value } from "./interp-values";
import type { Native } from "./interp-natives";

type CoNative = (it: InterpCo, args: Value[], e?: Expr) => Generator<unknown, Value, unknown>;

const TABLE = new Map<string, Native>();
// Every native here except the atomics needs the scheduler (`co`), even one that never parks: the plain interpreter
// asks for a rerun with tasks when it reaches one.
const plain = (name: string, f: (it: Interp, args: Value[], e?: Expr) => Value) => { const n = f as Native; n.co = true; TABLE.set(name, n); };
const co = (name: string, f: CoNative) => { const n = f as unknown as Native; n.co = true; TABLE.set(name, n); };

const handle = (kind: string, o: HandleV["o"]): HandleV => ({ k: "handle", kind, o });
// the handle a `&Self` argument names
// Touching the object tells the schedule explorer which steps share it (R-EXPLORE-INDEP); a task handle stands for its task.
const objOf = <T>(it: Interp, self: Value): T => {
  const o = (it.deref(self) as HandleV).o as unknown as T;
  (it as Partial<InterpCo>).touch?.(o instanceof TaskH ? o.t : o);
  return o;
};
const resultName = (it: Interp, e: Expr | undefined): string => (it.T(e!) as { name: string }).name;
const ok = (it: Interp, e: Expr | undefined, v: Value) => it.mkEnum(resultName(it, e), "Ok", [v]);
const err = (it: Interp, e: Expr | undefined, msg: string) => it.mkEnum(resultName(it, e), "Err", [staticStr(msg)]);
const count = (it: Interp, n: number): number[] => Array.from({ length: n }, () => it.alloc());

// ── Task and TaskScope ──
class TaskH { constructor(public t: Task) {} release(): void {} }
class ScopeObj { live = 0; waiter: Task | null = null; release(): void {} }

// R-TASK-SPAWN: a new task is ready at the back of the run queue; it does not run until the spawner parks, yields or ends.
const spawn = (it: Interp, [f]: Value[]): Value => {
  (it as InterpCo).greenMain = true;
  return handle("task", new TaskH((it as InterpCo).spawnTask(f as ClosureV)));
};
plain("Task$spawn", spawn);
// a task with a stack of its own size cannot reuse a cached one, and its context is not cached when it ends
plain("Task$spawnWithStack", (it, [f, bytes]) => ((it as InterpCo).greenMain = true, handle("task", new TaskH((it as InterpCo).spawnTask(f as ClosureV, null, (bytes as bigint) === 1048576n)))));
plain("Task$raw", (it, [self]) => BigInt(objOf<TaskH>(it, self).t.id));
plain("Task$Drop$drop", () => undefined);
// R-TASK-JOIN: join parks the caller until the task ends; a task that already ended returns at once.
co("Task$join", function* (it, [self]) {
  const t = objOf<TaskH>(it, self).t;
  if (t.state === "done") return undefined;
  t.joiner = it.cur;
  yield* it.park("Task.join");
  return undefined;
});
// R-TASK-SCOPE: the body runs, then the caller parks until every task spawned on the scope has ended.
co("Task$scope", function* (it, [body]) {
  const sc = new ScopeObj();
  const slot = { v: handle("scope", sc) };
  const me = it.cur;
  me.scopesOpen++;
  yield* it.callValue$g(body, [{ k: "mut", slot, path: [] } as Ref]);
  while (sc.live > 0) { sc.waiter = me; yield* it.park("Task.scope (waiting for its tasks)"); }
  me.scopesOpen--;
  it.dropValue(body);
  return undefined;
});
plain("TaskScope$spawn", (it, [self, f]) => {
  const sc = objOf<ScopeObj>(it, self);
  (it as InterpCo).scopeSpawned = true;
  (it as InterpCo).spawnTask(f as ClosureV, sc);
  sc.live++;
  return undefined;
});
plain("TaskScope$live", (it, [self]) => BigInt(objOf<ScopeObj>(it, self).live));

// ── scheduler entry points std exposes ──
// R-TASK-MAIN: a task pointer is the task's number; main is a task whenever the program can spawn.
plain("schedulerCurrent", it => BigInt((it as InterpCo).cur.id));
plain("schedulerExists", () => true);
co("schedulerYield", function* (it) { yield* it.yieldNow(); return undefined; });
co("schedulerPark", function* (it) { yield* it.park("schedulerPark"); return undefined; });
plain("schedulerUnpark", (it, [p]) => { const t = (it as InterpCo).tasks.get(Number(p as bigint)); if (t) (it as InterpCo).unpark(t); return undefined; });
// R-TASK-DRAIN: the caller (main, a task) parks until it is the only task left.
co("schedulerRunToCompletion", function* (it) {
  while (it.liveTasks() > 1) { it.drainWaiter = it.cur; yield* it.park("schedulerRunToCompletion"); }
  it.drainWaiter = null;
  return undefined;
});
// R-TIME: sleeping parks on the virtual clock; sleepBlockingMs holds the CPU and only moves the clock.
co("time$sleepMs", function* (it, [ms]) { yield* it.sleep(Number(ms as bigint)); return undefined; });
co("sleepMs", function* (it, [ms]) { yield* it.sleep(Number(ms as bigint)); return undefined; });
plain("sleepBlockingMs", (it, [ms]) => { (it as InterpCo).clock += Math.max(0, Number(ms as bigint)); return undefined; });
// R-TIME: the scheduler is always up under the task interpreter, so making timers live is a no-op
plain("ensureTimersLive", () => undefined);
plain("schedulerEnsureInit", () => undefined);
// A blocking-pool job or OS thread runs as one more task (R-TASK-BLOCKING): the interpreter has no second thread.
plain("runtime$blockingPoolSubmit", (it, [f]) => { (it as InterpCo).spawnTask(f as ClosureV); return undefined; });
plain("spawnOsThreadDetached", (it, [f]) => { (it as InterpCo).spawnTask(f as ClosureV); return undefined; });

// ── Channel ──
// R-CHAN: a bounded queue. send parks while it is full, recv while it is empty. A task that parks joins its
// wait list at the head, and a wake takes the head (the library's lists are stacks), so the latest waiter
// wakes first. A wake only makes the waiter ready; it rechecks its condition when it next runs.
class ChanObj {
  q: Value[] = [];
  closed = false;
  recvW: Task[] = [];
  sendW: Task[] = [];
  rc = 1;
  constructor(public cap: number, public blocks: number[]) {}
  // R-TASK-ABANDON
  release(it: Interp): void {
    if (--this.rc > 0) return;
    for (const v of this.q) it.dropValue(v);
    this.q = [];
    for (const b of this.blocks) it.free(b);
  }
}
const wake = (it: Interp, ws: Task[]) => { const t = ws.pop(); if (t) (it as InterpCo).unpark(t); };
const chan = (it: Interp, self: Value) => objOf<ChanObj>(it, self);
// The payload's size, read off the instantiated type's name (`Channel_i64`): the ring buffer is capacity * size bytes.
const SIZES: Record<string, bigint> = { i8: 1n, u8: 1n, bool: 1n, i16: 2n, u16: 2n, i32: 4n, u32: 4n, f32: 4n, string: 24n };
const newChannel = (elem: bigint): Native => (it, [cap], e) => {
  const n = cap as bigint;
  if (n <= 0n) return err(it, e, "channel capacity must be positive");
  if (elem > 0n && n > 9223372036854775807n / elem) return err(it, e, "channel capacity too large");
  return ok(it, e, handle("channel", new ChanObj(Number(n), count(it, 5)))); // buffer, header, mutex, two condition variables
};
const CHAN = /^Channel_.+?\$([A-Za-z0-9_]+)$/;
const CHAN_NATIVES: Record<string, Native> = {
  trySend: (it, [self, val]) => {
    const c = chan(it, self);
    if (c.q.length === c.cap) { it.dropValue(val); return false; }
    c.q.push(val); wake(it, c.recvW);
    return true;
  },
  tryRecv: (it, [self], e) => {
    const c = chan(it, self);
    const name = (it.T(e!) as { name: string }).name;
    if (c.q.length === 0) return it.mkEnum(name, "None", []);
    const v = c.q.shift()!;
    wake(it, c.sendW);
    return it.mkEnum(name, "Some", [v]);
  },
  len: (it, [self]) => BigInt(chan(it, self).q.length),
  clone: (it, [self]) => { const c = chan(it, self); c.rc++; return handle("channel", c); },
  close: (it, [self]) => {
    const c = chan(it, self);
    c.closed = true;
    while (c.recvW.length) wake(it, c.recvW);
    while (c.sendW.length) wake(it, c.sendW);
    return undefined;
  },
};
const CHAN_CO: Record<string, CoNative> = {
  send: function* (it, [self, val], e) {
    const c = chan(it, self);
    if (c.closed) { it.dropValue(val); return err(it, e, "channel closed"); }
    while (c.q.length === c.cap) {
      c.sendW.push(it.cur);
      yield* it.park("Channel.send (channel full)");
      if (c.closed) { it.dropValue(val); return err(it, e, "channel closed"); }
    }
    c.q.push(val);
    wake(it, c.recvW);
    return ok(it, e, 0n);
  },
  recv: function* (it, [self], e) {
    const c = chan(it, self);
    while (c.q.length === 0) {
      if (c.closed) return err(it, e, "channel closed");
      c.recvW.push(it.cur);
      yield* it.park("Channel.recv (channel empty)");
    }
    const v = c.q.shift()!;
    wake(it, c.sendW);
    return ok(it, e, v);
  },
};

// ── WaitGroup ──
// R-WG: add/done move a counter; done at zero or below wakes every waiter; wait parks while the counter is positive.
class WgObj {
  n = 0;
  rc = 1;
  waiters: Task[] = [];
  constructor(public blocks: number[]) {}
  release(it: Interp): void { if (--this.rc === 0) for (const b of this.blocks) it.free(b); }
}
const WG = /^WaitGroup\$([A-Za-z0-9_]+)$/;
const wg = (it: Interp, self: Value) => objOf<WgObj>(it, self);
const WG_NATIVES: Record<string, Native> = {
  new: it => handle("waitgroup", new WgObj(count(it, 3))),
  clone: (it, [self]) => { const w = wg(it, self); w.rc++; return handle("waitgroup", w); },
  add: (it, [self, n]) => { wg(it, self).n += Number(n as bigint); return undefined; },
  done: (it, [self]) => {
    const w = wg(it, self);
    if (--w.n <= 0) while (w.waiters.length) (it as InterpCo).unpark(w.waiters.pop()!);
    return undefined;
  },
};

// ── Once ──
// R-ONCE: the first caller runs the closure; the others park until it finishes.
class OnceObj {
  state: "idle" | "running" | "done" = "idle";
  rc = 1;
  waiters: Task[] = [];
  constructor(public blocks: number[]) {}
  release(it: Interp): void { if (--this.rc === 0) for (const b of this.blocks) it.free(b); }
}
const ONCE = /^Once\$([A-Za-z0-9_]+)$/;
const once = (it: Interp, self: Value) => objOf<OnceObj>(it, self);
const ONCE_NATIVES: Record<string, Native> = {
  new: it => handle("once", new OnceObj(count(it, 3))),
  clone: (it, [self]) => { const o = once(it, self); o.rc++; return handle("once", o); },
  isDone: (it, [self]) => once(it, self).state === "done",
};
const ONCE_CO: Record<string, CoNative> = {
  run: function* (it, [self, f]) {
    const o = once(it, self);
    while (o.state !== "done") {
      if (o.state === "idle") {
        o.state = "running";
        yield* it.callValue$g(f, []);
        o.state = "done";
        while (o.waiters.length) it.unpark(o.waiters.pop()!);
        break;
      }
      o.waiters.push(it.cur);
      yield* it.park("Once.run (another task is running it)");
    }
    it.dropValue(f);
    return undefined;
  },
};

// ── atomics ──
// R-ATOMIC: one task runs at a time, so an operation is a plain read-modify-write of the cell.
// add/sub wrap at the width, as the library says.
class AtomObj {
  rc = 1;
  constructor(public v: bigint | boolean, public block: number) {}
  release(it: Interp): void { if (--this.rc === 0) it.free(this.block); }
}
const ATOM = /^Atomic(I64|I32|U64|Bool)\$([A-Za-z0-9_]+)$/;
// R-ATOMIC
function atomicNative(kind: string, m: string): Native | undefined {
  const wrap = (v: bigint) => (kind === "I64" ? BigInt.asIntN(64, v) : kind === "I32" ? BigInt.asIntN(32, v) : BigInt.asUintN(64, v));
  const a = (it: Interp, self: Value) => objOf<AtomObj>(it, self);
  switch (m) {
    case "new": return (it, [v]) => handle("atomic", new AtomObj(v as bigint | boolean, it.alloc()));
    case "clone": return (it, [self]) => { const o = a(it, self); o.rc++; return handle("atomic", o); };
    case "load": return (it, [self]) => a(it, self).v;
    case "store": return (it, [self, v]) => { a(it, self).v = v as bigint | boolean; return undefined; };
    case "swap": return (it, [self, v]) => { const o = a(it, self); const old = o.v; o.v = v as bigint | boolean; return old; };
    case "cas": return (it, [self, want, to]) => { const o = a(it, self); const old = o.v; if (old === want) o.v = to as bigint | boolean; return old; };
    case "add": return kind === "Bool" ? undefined : (it, [self, d]) => { const o = a(it, self); const old = o.v as bigint; o.v = wrap(old + (d as bigint)); return old; };
    case "sub": return kind === "Bool" ? undefined : (it, [self, d]) => { const o = a(it, self); const old = o.v as bigint; o.v = wrap(old - (d as bigint)); return old; };
  }
  return undefined;
}

/** The native for a library function that touches tasks or synchronization, or undefined. */
export function taskNativeFor(name: string): Native | undefined {
  const n = lookup(name);
  if (n && !ATOM.test(name)) n.co = true;
  return n;
}
function lookup(name: string): Native | undefined {
  const t = TABLE.get(name);
  if (t) return t;
  let m = CHAN.exec(name);
  if (m) {
    if (m[1] === "new") return newChannel(SIZES[/^Channel_(.+?)\$/.exec(name)![1]!] ?? 8n);
    const f = CHAN_NATIVES[m[1]!];
    if (f) return f;
    const g = CHAN_CO[m[1]!];
    if (g) { const n = g as unknown as Native; n.co = true; return n; }
    return undefined;
  }
  if (/^Channel_.+?\$Drop\$drop$/.test(name) || /^(WaitGroup|Once|Atomic\w+)\$Drop\$drop$/.test(name)) return () => undefined;
  m = WG.exec(name);
  if (m) {
    if (m[1] === "wait") return WG_WAIT;
    return WG_NATIVES[m[1]!];
  }
  m = ONCE.exec(name);
  if (m) {
    const g = ONCE_CO[m[1]!];
    if (g) { const n = g as unknown as Native; n.co = true; return n; }
    return ONCE_NATIVES[m[1]!];
  }
  m = ATOM.exec(name);
  if (m) return atomicNative(m[1]!, m[2]!);
  return undefined;
}
const WG_WAIT = ((): Native => {
  const f: CoNative = function* (it, [self]) {
    const w = wg(it, self);
    while (w.n > 0) { w.waiters.push(it.cur); yield* it.park("WaitGroup.wait"); }
    return undefined;
  };
  const n = f as unknown as Native;
  n.co = true;
  return n;
})();
