# std/runtime

## std/runtime

### `defaultStackSize`

```milo
fn defaultStackSize(): i64
```

_Undocumented._

### `guardPageSize`

```milo
fn guardPageSize(): i64
```

_Undocumented._

### `kindPlain`

```milo
fn kindPlain(): i64
```

_Undocumented._

### `kindSelRead`

```milo
fn kindSelRead(): i64
```

_Undocumented._

### `kindSelRecv`

```milo
fn kindSelRecv(): i64
```

_Undocumented._

### `kindSelSend`

```milo
fn kindSelSend(): i64
```

_Undocumented._

### `kindSelTimer`

```milo
fn kindSelTimer(): i64
```

_Undocumented._

### `kindSelWrite`

```milo
fn kindSelWrite(): i64
```

_Undocumented._

### `nodeA`

```milo
fn nodeA(): i64
```

_Undocumented._

### `nodeArm`

```milo
fn nodeArm(): i64
```

_Undocumented._

### `nodeDeadline`

```milo
fn nodeDeadline(): i64
```

_Undocumented._

### `nodeFd`

```milo
fn nodeFd(): i64
```

_Undocumented._

### `nodeKind`

```milo
fn nodeKind(): i64
```

One layout serves every waiter: a plain parked task on a channel list, and
each armed Select arm (channel recv/send, fd read/write, timer). Channel
lists (recvWaitHead/sendWaitHead) hold kind 0/1/2; the scheduler's selFdHead
holds kind 3/4/5.

### `nodeNext`

```milo
fn nodeNext(): i64
```

_Undocumented._

### `nodeSize`

```milo
fn nodeSize(): i64
```

_Undocumented._

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
fn promiseAll<T>(promises: Vec<Promise<T>>): Promise<Vec<T>>
```

standalone generic functions to avoid recursive struct monomorphization

### `promiseRace`

```milo
fn promiseRace<T>(promises: Vec<Promise<T>>): Promise<T>
```

_Undocumented._

### `schedStructSize`

```milo
fn schedStructSize(): i64
```

_Undocumented._

### `schedulerCurrent`

```milo
fn schedulerCurrent(): *u8
```

_Undocumented._

### `schedulerEnsureInit`

```milo
fn schedulerEnsureInit(): void
```

_Undocumented._

### `schedulerExists`

```milo
fn schedulerExists(): bool
```

True once a green scheduler has been created on this thread. Lets a main-
context waiter (schedulerCurrent()==0) tell "drive the scheduler" apart from
"pure pthread, block on a cond".

### `schedulerPark`

```milo
fn schedulerPark(): void
```

Suspend the current task and switch to the scheduler. The task lands on no
scheduler list: the caller must have stashed schedulerCurrent() somewhere a
future schedulerUnpark can find it, or the task never runs again.
Unpark must not precede park on the same thread — cross-thread unparks are
safe at any time because they are applied only in scheduler context.

### `schedulerRunToCompletion`

```milo
fn schedulerRunToCompletion(): void
```

Drive the scheduler until every spawned task has finished, then tear it down.
Go exit semantics mean main no longer calls this implicitly; it stays as an
explicit "run all outstanding tasks to completion" entry for programs that
want the old drain-to-quiescence behavior (e.g. spawn a fleet of workers and
block main until they all return without a WaitGroup).

### `schedulerUnpark`

```milo
fn schedulerUnpark(task: *u8): void
```

Make a parked task runnable. Safe from any thread: on the task's own
scheduler thread it goes straight to the run queue; from a foreign thread
it is pushed onto the mutex-guarded transfer list and the scheduler's
wakeup event is signaled so a blocked poll returns promptly.

### `schedulerWaitRead`

```milo
fn schedulerWaitRead(fd: i32): void
```

_Undocumented._

### `schedulerWaitWrite`

```milo
fn schedulerWaitWrite(fd: i32): void
```

_Undocumented._

### `schedulerYield`

```milo
fn schedulerYield(): void
```

_Undocumented._

### `sCtx`

```milo
fn sCtx(): i64
```

scheduler field offsets

### `sCurrent`

```milo
fn sCurrent(): i64
```

_Undocumented._

### `selectStateSize`

```milo
fn selectStateSize(): i64
```

_Undocumented._

### `sElFd`

```milo
fn sElFd(): i64
```

_Undocumented._

### `sNumTasks`

```milo
fn sNumTasks(): i64
```

_Undocumented._

### `sRunHead`

```milo
fn sRunHead(): i64
```

_Undocumented._

### `sRunTail`

```milo
fn sRunTail(): i64
```

_Undocumented._

### `ssClaimed`

```milo
fn ssClaimed(): i64
```

_Undocumented._

### `ssCond`

```milo
fn ssCond(): i64
```

Signalled by _selectTryClaim. Only the no-scheduler main context waits on it: a green
task parks instead, and a main context WITH a scheduler polls it. That leaves the case
where the only thing that can fire an arm is a foreign pthread (Promise.blocking with no
green task anywhere) — there is no scheduler to drive and no task to unpark, so without
this the wait had nothing to block on and returned -1 immediately.

### `sSelFdHead`

```milo
fn sSelFdHead(): i64
```

select fd/timer waiter list (scheduler thread only)

### `ssMtx`

```milo
fn ssMtx(): i64
```

Shared by all arms of one Select. `claimed` records the winning arm (-1 until
a source fires); the mutex serializes the claim so at most one arm wins even
across a foreign pthread firing a channel. `parked` gates the unpark so a
claim that lands before the task commits to parking never queues a stale wake.

### `ssParked`

```milo
fn ssParked(): i64
```

_Undocumented._

### `ssTask`

```milo
fn ssTask(): i64
```

_Undocumented._

### `sWaitHead`

```milo
fn sWaitHead(): i64
```

waiting list head (tasks blocked on I/O)

### `sWakeupId`

```milo
fn sWakeupId(): i64
```

_Undocumented._

### `sXferHead`

```milo
fn sXferHead(): i64
```

_Undocumented._

### `sXferMutex`

```milo
fn sXferMutex(): i64
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
fn taskDone(): i32
```

_Undocumented._

### `taskReady`

```milo
fn taskReady(): i32
```

_Undocumented._

### `taskRunning`

```milo
fn taskRunning(): i32
```

_Undocumented._

### `taskStructSize`

```milo
fn taskStructSize(): i64
```

_Undocumented._

### `taskWaitingIo`

```milo
fn taskWaitingIo(): i32
```

_Undocumented._

### `taskWaitingPark`

```milo
fn taskWaitingPark(): i32
```

parked: off every scheduler list; whoever holds the task pointer (e.g. a
channel waiter entry) is responsible for a future schedulerUnpark

### `tClosureEnv`

```milo
fn tClosureEnv(): i64
```

_Undocumented._

### `tClosureFn`

```milo
fn tClosureFn(): i64
```

_Undocumented._

### `tCtx`

```milo
fn tCtx(): i64
```

task field offsets

### `tJoinCell`

```milo
fn tJoinCell(): i64
```

_Undocumented._

### `tJoiner`

```milo
fn tJoiner(): i64
```

_Undocumented._

### `tNext`

```milo
fn tNext(): i64
```

_Undocumented._

### `tSched`

```milo
fn tSched(): i64
```

_Undocumented._

### `tStack`

```milo
fn tStack(): i64
```

_Undocumented._

### `tStackSize`

```milo
fn tStackSize(): i64
```

_Undocumented._

### `tState`

```milo
fn tState(): i64
```

_Undocumented._

### `tWaitFd`

```milo
fn tWaitFd(): i64
```

_Undocumented._

### `tWaitWrite`

```milo
fn tWaitWrite(): i64
```

_Undocumented._
