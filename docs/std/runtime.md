# std/runtime

## std/runtime

### `defaultStackSize`

```milo
pub fn defaultStackSize(): i64
```

_Undocumented._

### `dequeueRun`

```milo
fn dequeueRun(sched: *u8): *u8
```

_Undocumented._

### `drainXfer`

```milo
fn drainXfer(sched: *u8): void
```

move cross-thread unparked tasks onto the run queue (scheduler thread only)

### `enqueueRun`

```milo
fn enqueueRun(sched: *u8, task: *u8): void
```

_Undocumented._

### `enqueueWait`

```milo
fn enqueueWait(sched: *u8, task: *u8): void
```

_Undocumented._

### `getSched`

```milo
fn getSched(): *u8
```

_Undocumented._

### `guardPageSize`

```milo
pub fn guardPageSize(): i64
```

_Undocumented._

### `kindPlain`

```milo
pub fn kindPlain(): i64
```

_Undocumented._

### `kindSelRead`

```milo
pub fn kindSelRead(): i64
```

_Undocumented._

### `kindSelRecv`

```milo
pub fn kindSelRecv(): i64
```

_Undocumented._

### `kindSelSend`

```milo
pub fn kindSelSend(): i64
```

_Undocumented._

### `kindSelTimer`

```milo
pub fn kindSelTimer(): i64
```

_Undocumented._

### `kindSelWrite`

```milo
pub fn kindSelWrite(): i64
```

_Undocumented._

### `nodeA`

```milo
pub fn nodeA(): i64
```

_Undocumented._

### `nodeArm`

```milo
pub fn nodeArm(): i64
```

_Undocumented._

### `nodeDeadline`

```milo
pub fn nodeDeadline(): i64
```

_Undocumented._

### `nodeFd`

```milo
pub fn nodeFd(): i64
```

_Undocumented._

### `nodeKind`

```milo
pub fn nodeKind(): i64
```

One layout serves every waiter: a plain parked task on a channel list, and
each armed Select arm (channel recv/send, fd read/write, timer). Channel
lists (recvWaitHead/sendWaitHead) hold kind 0/1/2; the scheduler's selFdHead
holds kind 3/4/5.

### `nodeNext`

```milo
pub fn nodeNext(): i64
```

_Undocumented._

### `nodeSize`

```milo
pub fn nodeSize(): i64
```

_Undocumented._

### `osThreadTrampoline`

```milo
fn osThreadTrampoline(arg: *u8): *u8
```

pthread entry: unpacks { fnPtr, envPtr }, runs the void closure, frees both.

### `pollAndWake`

```milo
fn pollAndWake(sched: *u8, timeoutMs: i32): void
```

poll the event loop once and make everything runnable that became ready:
io-waiting tasks whose fd fired, and cross-thread unparks via the wakeup event

### `Promise.await`

```milo
fn Promise.await(self: &Promise): Result<T>
```

_Undocumented._

### `Promise.blocking`

```milo
fn Promise.blocking(f: () => T): Promise<T>
```

Run `f` on a real OS thread for CPU-bound work or blocking FFI — anything
that would otherwise starve the single-threaded cooperative scheduler.
The caller never blocks here; the result arrives over the channel and is
collected with await(), like any Promise. Fan out across N cores by
pushing several Promise.blocking handles into Promise.all.

### `Promise.channel`

```milo
fn Promise.channel(self: &Promise): Channel<T>
```

The result channel, so a Promise can be armed in a Select:

  selectRecv(sel, p.channel())      // arm 0
  sel.onTimeout(1000)               // arm 1
  match sel.wait() { 0 => { let v = p.await()! } 1 => { ... } }

This is the bridge from a Promise.blocking OS-thread result into an event-driven
wait — previously the two tiers couldn't compose, and an event-driven `timeout`
wanted exactly this. Await still owns the fetch: when the arm wins, `await()` does
the recv and the destroy, so don't recv off this handle yourself.

Handing out the channel is safe because Channel<T> is a single *u8 and therefore an
implicitly Copy handle — this is an alias, not a transfer of ownership.

### `Promise.run`

```milo
fn Promise.run(f: () => T): Promise<T>
```

_Undocumented._

### `promiseAll`

```milo
pub fn promiseAll<T>(promises: Vec<Promise<T>>): Promise<Vec<T>>
```

standalone generic functions to avoid recursive struct monomorphization

### `promiseRace`

```milo
pub fn promiseRace<T>(promises: Vec<Promise<T>>): Promise<T>
```

_Undocumented._

### `reapTask`

```milo
fn reapTask(sched: *u8, task: *u8): void
```

Free a completed task and wake anyone joining it. Reads the join fields
before freeing the struct (they point outside it). numTasks is decremented
here so the reap is accounted regardless of drain vs tick vs block caller.

### `rtReadI32`

```milo
fn rtReadI32(base: *u8, off: i64): i32
```

_Undocumented._

### `rtReadI64`

```milo
pub fn rtReadI64(base: *u8, off: i64): i64
```

_Undocumented._

### `rtReadPtr`

```milo
fn rtReadPtr(base: *u8, off: i64): *u8
```

_Undocumented._

### `rtWriteI32`

```milo
fn rtWriteI32(base: *u8, off: i64, val: i32): void
```

_Undocumented._

### `rtWriteI64`

```milo
pub fn rtWriteI64(base: *u8, off: i64, val: i64): void
```

_Undocumented._

### `rtWritePtr`

```milo
pub fn rtWritePtr(base: *u8, off: i64, val: *u8): void
```

_Undocumented._

### `schedStructSize`

```milo
pub fn schedStructSize(): i64
```

_Undocumented._

### `schedulerBlockMain`

```milo
pub fn schedulerBlockMain(): void
```

Main-context blocking driver: advance the scheduler, blocking the poll until
a real event arrives instead of the 100ms cooperative spin. Callers loop on
their own completion condition (Promise result, join cell, WaitGroup count).

### `schedulerCurrent`

```milo
pub fn schedulerCurrent(): *u8
```

_Undocumented._

### `schedulerEnsureInit`

```milo
pub fn schedulerEnsureInit(): void
```

_Undocumented._

### `schedulerExists`

```milo
pub fn schedulerExists(): bool
```

True once a green scheduler has been created on this thread. Lets a main-
context waiter (schedulerCurrent()==0) tell "drive the scheduler" apart from
"pure pthread, block on a cond".

### `schedulerPark`

```milo
pub fn schedulerPark(): void
```

Suspend the current task and switch to the scheduler. The task lands on no
scheduler list: the caller must have stashed schedulerCurrent() somewhere a
future schedulerUnpark can find it, or the task never runs again.
Unpark must not precede park on the same thread — cross-thread unparks are
safe at any time because they are applied only in scheduler context.

### `schedulerPollMain`

```milo
pub fn schedulerPollMain(): void
```

Main-context driver for blockers whose wake condition is NOT an fd event the
poll can observe: a channel buffer filled under the mutex by a green sender
that then parked, or by a foreign OS-thread sender that signals a condvar the
main thread is not waiting on. A -1 poll would sleep past both. The bounded
timeout keeps the scheduler advancing while letting the caller re-check its
own condition (the channel buffer) between ticks — forward progress with at
most a few ms of latency and no busy-spin.

### `schedulerPollMainSelect`

```milo
fn schedulerPollMainSelect(): void
```

Select's main-context wait needs a different poll from a channel's.

_schedulerRunOnce returns EARLY when numTasks == 0 — and even past that guard it only
polls the event loop when tasks remain. Select arms don't live on the task list: fd and
timer arms hang off sSelFdHead and are claimed by _pollAndWake (_wakeSelectFds /
_wakeSelectTimers). So once the last green task finishes, _schedulerPollMain becomes a
no-op and a main-context select waiting on a timer would spin on it forever. That is a
real hang — `Task.spawn` a short task, then select on a timeout, and the task is gone by
the time the timer matters.

Poll the event loop directly when there is nothing runnable. _pollAndWake is safe with
zero tasks and _selMinTimeout already bounds the sleep by the nearest arm deadline, so
this blocks rather than busy-spins.

### `schedulerRunOnce`

```milo
fn schedulerRunOnce(timeoutMs: i32): void
```

Run one batch of ready tasks, then poll events once with `timeoutMs`
(-1 blocks until an fd/wakeup/timer fires — used by the main-context
blocking driver; 100 is the cooperative tick used by legacy spin loops).

### `schedulerRunToCompletion`

```milo
pub fn schedulerRunToCompletion(): void
```

Drive the scheduler until every spawned task has finished, then tear it down.
Go exit semantics mean main no longer calls this implicitly; it stays as an
explicit "run all outstanding tasks to completion" entry for programs that
want the old drain-to-quiescence behavior (e.g. spawn a fleet of workers and
block main until they all return without a WaitGroup).

### `schedulerTick`

```milo
pub fn schedulerTick(): void
```

_Undocumented._

### `schedulerUnpark`

```milo
pub fn schedulerUnpark(task: *u8): void
```

Make a parked task runnable. Safe from any thread: on the task's own
scheduler thread it goes straight to the run queue; from a foreign thread
it is pushed onto the mutex-guarded transfer list and the scheduler's
wakeup event is signaled so a blocked poll returns promptly.

### `schedulerWaitRead`

```milo
pub fn schedulerWaitRead(fd: i32): void
```

_Undocumented._

### `schedulerWaitWrite`

```milo
pub fn schedulerWaitWrite(fd: i32): void
```

_Undocumented._

### `schedulerYield`

```milo
pub fn schedulerYield(): void
```

_Undocumented._

### `sCtx`

```milo
pub fn sCtx(): i64
```

scheduler field offsets

### `sCurrent`

```milo
pub fn sCurrent(): i64
```

_Undocumented._

### `selectRegisterFd`

```milo
pub fn selectRegisterFd(node: *u8): void
```

Link an fd/read-or-write or timer node into the scheduler's select list and,
for fd arms, register the fd with the event loop. Scheduler thread only
(arms are always set up from the task that owns the Select).

### `selectStateFree`

```milo
pub fn selectStateFree(st: *u8): void
```

_Undocumented._

### `selectStateNew`

```milo
pub fn selectStateNew(): *u8
```

Allocate a SelectState (mutex-guarded claim record). Caller frees via
_selectStateFree once the select and all its arms are torn down.

### `selectStateSize`

```milo
pub fn selectStateSize(): i64
```

_Undocumented._

### `selectTryClaim`

```milo
pub fn selectTryClaim(st: *u8, arm: i64): void
```

Claim the select for `arm` if nothing has won yet, and wake the owning task
only if it has already committed to parking. Safe from any thread (a foreign
pthread firing a channel takes this path); unpark itself is thread-safe.

### `selectUnregisterFd`

```milo
pub fn selectUnregisterFd(node: *u8): void
```

Unlink a node from the select list and deregister its fd. Idempotent: a node
that already fell off the list (never happens today, but cheap to guard) is
skipped.

### `selectWaitState`

```milo
pub fn selectWaitState(st: *u8): i64
```

Task side, called after every arm is registered. Returns the winning arm
index, parking until a source fires. See SelectState for the race handling.

Two contexts, and conflating them is what made this return -1 for so long. A green task
can park: some other task (or the event loop) will claim an arm and unpark it. The MAIN
context cannot — `schedulerCurrent()` is 0 there, so `schedulerPark()` no-ops, and the
old code fell straight through to read an unclaimed `-1` and return it. Callers could
see that select had woken but not which arm fired, so the demos worked around it by
draining every arm.

Main context takes the same shape channels already use (`_schedulerPollMain` in
std/sync): nobody else drives the scheduler, so poll it a bounded tick and re-check the
claim. Parking there, or driving the poll from inside the lock, is what hangs.

### `sElFd`

```milo
pub fn sElFd(): i64
```

_Undocumented._

### `selMinTimeout`

```milo
fn selMinTimeout(sched: *u8, cap: i32): i32
```

Smallest timer deadline remaining (ms), clamped to `cap`. Lets the poll block
only until the next select timeout instead of the default tick interval.

### `setSched`

```milo
fn setSched(s: *u8): void
```

_Undocumented._

### `sNumTasks`

```milo
pub fn sNumTasks(): i64
```

_Undocumented._

### `spawnOsThreadDetached`

```milo
pub fn spawnOsThreadDetached(f: () => void): void
```

Run `f` on a detached OS thread. Detached so its resources are reclaimed at
thread exit with no join — nothing outlives the worker (the plan's no-leak
requirement). If main returns first, Go exit semantics abandon it, symmetric
with an abandoned green task.

### `sRunHead`

```milo
pub fn sRunHead(): i64
```

_Undocumented._

### `sRunTail`

```milo
pub fn sRunTail(): i64
```

_Undocumented._

### `ssClaimed`

```milo
pub fn ssClaimed(): i64
```

_Undocumented._

### `ssCond`

```milo
pub fn ssCond(): i64
```

Signalled by _selectTryClaim. Only the no-scheduler main context waits on it: a green
task parks instead, and a main context WITH a scheduler polls it. That leaves the case
where the only thing that can fire an arm is a foreign pthread (Promise.blocking with no
green task anywhere) — there is no scheduler to drive and no task to unpark, so without
this the wait had nothing to block on and returned -1 immediately.

### `sSelFdHead`

```milo
pub fn sSelFdHead(): i64
```

select fd/timer waiter list (scheduler thread only)

### `ssMtx`

```milo
pub fn ssMtx(): i64
```

Shared by all arms of one Select. `claimed` records the winning arm (-1 until
a source fires); the mutex serializes the claim so at most one arm wins even
across a foreign pthread firing a channel. `parked` gates the unpark so a
claim that lands before the task commits to parking never queues a stale wake.

### `ssParked`

```milo
pub fn ssParked(): i64
```

_Undocumented._

### `ssTask`

```milo
pub fn ssTask(): i64
```

_Undocumented._

### `sWaitHead`

```milo
pub fn sWaitHead(): i64
```

waiting list head (tasks blocked on I/O)

### `sWakeupId`

```milo
pub fn sWakeupId(): i64
```

_Undocumented._

### `sXferHead`

```milo
pub fn sXferHead(): i64
```

_Undocumented._

### `sXferMutex`

```milo
pub fn sXferMutex(): i64
```

cross-thread unpark transfer list (mutex-guarded; drained after each poll)

### `Task.join`

```milo
fn Task.join(self: &Task): void
```

Block until the spawned task finishes. Cooperative contract: call join
before the target can run (i.e. before yielding/driving the scheduler),
so the registration below always precedes completion. A green caller
parks; the main thread drives the scheduler until the done cell is set.

### `Task.spawn`

```milo
fn Task.spawn(f: () => void): Task
```

Spawn a green (M:N) task that runs `f` on the cooperative scheduler, and
return a handle to it. Returns immediately — the task does not run until
the scheduler is driven (by a blocking IO op, `schedulerYield`, or a
`join`). Each task gets its own guard-paged stack. Await completion with
`task.join()`.

### `Task.spawnWithStack`

```milo
fn Task.spawnWithStack(f: () => void, stackBytes: i64): Task
```

Same as spawn, with an explicit stack size. The default 1 MB is generous
for ordinary tasks but far too small for a recursive interpreter: milojs
budgets its JS call depth against the 8 MB the OS main thread gets, so
running it on a green task needs a comparable stack. The mapping is
anonymous and lazily committed, so a larger reservation costs address
space rather than resident memory.

### `taskDone`

```milo
pub fn taskDone(): i32
```

_Undocumented._

### `taskEntry`

```milo
fn taskEntry(): void
```

_Undocumented._

### `taskReady`

```milo
pub fn taskReady(): i32
```

_Undocumented._

### `taskRunning`

```milo
pub fn taskRunning(): i32
```

_Undocumented._

### `taskStructSize`

```milo
pub fn taskStructSize(): i64
```

_Undocumented._

### `taskWaitingIo`

```milo
pub fn taskWaitingIo(): i32
```

_Undocumented._

### `taskWaitingPark`

```milo
pub fn taskWaitingPark(): i32
```

parked: off every scheduler list; whoever holds the task pointer (e.g. a
channel waiter entry) is responsible for a future schedulerUnpark

### `tClosureEnv`

```milo
pub fn tClosureEnv(): i64
```

_Undocumented._

### `tClosureFn`

```milo
pub fn tClosureFn(): i64
```

_Undocumented._

### `tCtx`

```milo
pub fn tCtx(): i64
```

task field offsets

### `tJoinCell`

```milo
pub fn tJoinCell(): i64
```

_Undocumented._

### `tJoiner`

```milo
pub fn tJoiner(): i64
```

_Undocumented._

### `tNext`

```milo
pub fn tNext(): i64
```

_Undocumented._

### `tSched`

```milo
pub fn tSched(): i64
```

_Undocumented._

### `tStack`

```milo
pub fn tStack(): i64
```

_Undocumented._

### `tStackSize`

```milo
pub fn tStackSize(): i64
```

_Undocumented._

### `tState`

```milo
pub fn tState(): i64
```

_Undocumented._

### `tWaitFd`

```milo
pub fn tWaitFd(): i64
```

_Undocumented._

### `tWaitWrite`

```milo
pub fn tWaitWrite(): i64
```

_Undocumented._

### `wakeReadyTasks`

```milo
fn wakeReadyTasks(sched: *u8, readyFds: *i32, count: i32): void
```

wake waiting tasks whose fd is in the ready set

### `wakeSelectFds`

```milo
fn wakeSelectFds(sched: *u8, readyFds: *i32, count: i32): void
```

Claim select fd arms whose fd fired this poll.

### `wakeSelectTimers`

```milo
fn wakeSelectTimers(sched: *u8): void
```

Claim select timer arms whose deadline has passed.
