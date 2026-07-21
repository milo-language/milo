<!-- doc-meta
system: milojs-async-suspension
purpose: plan of record for making await suspend in milojs — requirements, design, per-requirement status, and test plan
key-files: examples/apps/milojs/eval.milo, examples/apps/milojs/runtime.milo, std/runtime.milo, tests/fixtures/asyncCallOrdering.milo
update-when: a requirement is implemented, dropped, or revised, or the suspension mechanism changes
last-verified: 2026-07-21
-->

# milojs: await suspension

This is the **plan of record**: work on await suspension implements this
document, and the document changes first if the plan changes.

## Status

| item | state |
|------|-------|
| Interpreter runs on a green task | done (`530dfe8`) |
| `Task.spawnWithStack` for interpreter-sized stacks | done (`5613f78`) |
| Ordering mechanism (caller parks, body unparks it) | proven, `tests/fixtures/asyncCallOrdering.milo` |
| R1 async call returns at first await | done in the **runtime** for a pending awaited promise — matches node; 71/71 fixtures, integration app green (0 errors, ~34ms) |
| R1b same in the engine binary | **still not landed**, but the cause is now narrowed: the engine running on `gProg` alone is SAFE (landed independently for proxy traps, `adae042`, CI green). The unkillable hang came from `gProg` **plus** running the whole program on a green task — that combination, not `gProg` itself, is what wedged. So R1b needs the green-task part done differently |
| R1a `await` of a non-thenable yields | not met — deferred, see below; a bare yield bypasses R6 save/restore |
| R2 suspension is per-activation | done — park/wake on a promise (`ceb9aea`), wired into the `await` path (`parkOnPromise` at eval.milo:3619, taken on an activation task). Covered by `tests/runtime/r2r3Barrier.js` (both participants suspend on a pending barrier) + `r2TimerDuringSuspend.js` (a self-rescheduling timer chain keeps firing while an activation is parked) |
| R3 resume order | done (`ceb9aea`) — `wakeAwaiters` walks the registry front-to-back, so waiters resume in registration order. Covered by `tests/runtime/r2r3Barrier.js` (a resumes before b) |
| R4 settle/reject semantics | done — already held; locked in by `tests/asyncSettleReject.js`, clean under GC stress |
| R4a async body returns a pending promise | done (`0391271`) — an activation returning a pending promise adopts it, not reads its state; guarded by `tests/runtime/asyncReturnsPendingPromise.js` (new runtime harness pass) |
| Per-binary JS recursion limit | done (`2843607`) — `callDepthLimit` field; engine 20 (main-thread Linux stack), runtime 500 (8 MB green task). Fixes a spurious `RangeError` on the integration app without regressing the engine's Linux-catchability. Not an async requirement, tracked here because it interacts with activation stacks |
| R5 existing values unchanged | holds (nothing landed yet) |
| R6 per-activation execution state | done (`3215822`, corrected `c079770`) — 9 fields, contexts reclaimed by task identity. Covered end-to-end by `tests/runtime/r6LocalsLiveAcrossSuspend.js` (locals live across a mid-loop suspend) |
| R7 GC over suspended activations | done (`3215822`) — collect walks parked roots. Covered by `tests/runtime/r7GcOverSuspended.js`, which `run.sh` runs under `MILOJS_GC_THRESHOLD=1` (any `*Gc*` fixture) so a collection actually fires during the park |
| R8 unsettleable promise still reported | holds today, must survive |

## Why

`await` cannot suspend today. The event loop is drained in place until the
awaited promise settles, so an async call runs its whole body before returning.
Two consequences, both hitting the integration app:

- **Deadlock.** Two async calls that must interleave never do. A barrier that
  releases once N participants arrive is the common shape; prisma puts one in
  front of a batched `$transaction`, so `$transaction([a, b])` hangs while
  `$transaction([a])` and the callback form work.
- **Latency.** An unawaited call blocks its caller for the whole body. The app's
  analytics middleware calls `processQueue()` without awaiting, and that
  deadlocks, so every request paid the 30s await budget.

## Requirements

R1. Calling an async function runs its body up to the first `await`, then
    returns a pending promise. Statements after the call run before the body
    resumes.
R2. `await` on a pending promise suspends only the awaiting activation. Other
    activations, timers, microtasks and the HTTP accept loop keep running.
R3. Settling a promise resumes every activation awaiting it, in the order they
    began awaiting.
R4. An async body that returns settles its promise with the value; one that
    throws rejects it. `await` on a rejected promise throws at the await site.
R5. Values are unchanged from today. Only ordering and liveness change.
R6. No interpreter state is ambient across a suspension point. A suspended
    activation holds everything describing its own execution — locals, the JS
    call stack, the pending throw, the module it belongs to — and inherits
    nothing from whoever ran in between. The set of such state must be
    established by going through the Interp struct field by field, not from
    memory: an omission does not fail loudly, it corrupts an unrelated
    activation.
R7. Nothing reachable from a suspended activation is collected while it is
    suspended.
R8. A promise nobody can ever settle must still be reported rather than hanging
    forever (today's await budget, kept).

## Non-requirements

- Generators. Same machinery eventually, not in scope here.
- Matching node's microtask-vs-macrotask ordering exactly beyond R1–R3.
- Parallelism. One activation runs at a time; this is concurrency, not threads.

## Design

Each async activation runs on its own green task. Milo green tasks have real
stacks and switch only at explicit park points, so the interpreter's *native*
stack is already per-activation — that is the whole reason this is tractable.

**Ordering (R1).** The caller spawns the body's task, then parks itself. The
body runs; at its first `await`, or on completion if it never awaits, it unparks
the caller and then parks. The caller resumes with the body's synchronous
portion already run. Only `schedulerPark`/`schedulerUnpark` are used — no new
scheduler primitive, so the task struct that channels, select and net share is
untouched. Proven in `tests/fixtures/asyncCallOrdering.milo`.

**Suspension (R2, R3).** `await` on a pending promise records the current task
as a waiter on that promise and parks. Settling a promise unparks its waiters in
registration order. The event loop keeps running on the interpreter's own task,
so timers, microtasks and `accept` are unaffected.

**Per-activation state (R6).** The Interp fields that describe the *current*
execution are global today and must travel with the activation:

    throwing, thrownValue, callDepth, temp-root stack, active-scope stack,
    modDirStack, modPathStack

Switches happen only at park points, so saving these into the activation record
on park and restoring on resume is sufficient — no finer granularity is needed.

**GC (R7).** Temp roots and active scopes are roots. The collector must walk
every suspended activation's saved state, not just the running one. This is the
part most likely to produce a subtle bug, so it is tested directly rather than
by inspection.

**Budget (R8).** The existing deadline stays, but applies per activation: a
suspended activation whose promise is never settled is reported, rather than the
whole process hanging.

## Test plan

Each requirement gets a fixture, checked against `bun` where it is JS.

| req | test |
|-----|------|
| R1  | `async function f(){ log("A"); await sleep(0); log("C") } f(); log("B")` → `A B C`. Uses a real promise deliberately: `await null` is covered by R1a, which is not met. |
| R2  | barrier repro: two participants await one pending barrier, both suspend, both resolve — `tests/runtime/r2r3Barrier.js`. Barrier settled by an outside timer, not a participant, so neither hits the already-settled-await path (R1a) |
| R2  | a timer keeps firing while an activation is suspended — `tests/runtime/r2TimerDuringSuspend.js` |
| R3  | two activations await one promise; both resume in registration order — `tests/runtime/r2r3Barrier.js` (a before b) |
| R4  | return settles; `throw` rejects; `await` of a rejection throws at the site |
| R5  | every existing async fixture keeps passing unchanged |
| R6  | suspend mid-loop with locals live, resume, check locals — `tests/runtime/r6LocalsLiveAcrossSuspend.js` |
| R7  | suspend an activation holding the only reference to an object, force GC, resume and use it — `tests/runtime/r7GcOverSuspended.js`, run under `MILOJS_GC_THRESHOLD=1` |
| R8  | await a promise nobody settles → reported, other activations unaffected |

Integration: prisma `$transaction([a, b])` returns rows, and the app's analytics
insert stops burning the budget.

## Design tension: long-lived shared state has to be global

An async activation outlives the call that started it, so its task body needs
the program and the interpreter. Neither can be captured: a green task's closure
cannot hold a `&Prog` or `&mut Interp` belonging to a caller's frame, and a raw
pointer back to a local is rejected too. Milo has second-class references and no
lifetimes or refcounting, so there is no way to say "this reference outlives the
frame".

The consequence is `gProg` alongside the existing `gInterp`: mutable global
singletons. This is a workaround for the language, not a preference. It costs

- **re-entrancy** — one process can never run two programs, and
- **clarity** — functions still take `prog: &Prog` while a global must be the
  same object, so there are two ways to reach the program.

It is defensible in that a milojs process *is* one program and one interpreter,
which is why `gInterp` was already built this way. But it is worth naming as a
recurring cost: anything in Milo that needs long-lived state shared across tasks
lands in the same place. If Milo ever grows a way to express shared ownership,
this is the first thing that should change.

## R1: what went wrong

An implementation was written and reverted (stashed as `wip-r1-async-activations`).
It worked in isolation — the barrier repro that deadlocks under the old engine
printed `BOTH: ["done1","done2"]`, matching node, and held up under
`MILOJS_GC_THRESHOLD=1` — but running the integration app produced
`ReferenceError: value is not defined` and then stalls.

The failure says an activation's execution is not fully isolated from its
caller's. R6 named seven fields to move per-activation. That list was assembled
by reading the code, and the symptom says it is incomplete: `newTarget` is
ambient too, `callDepth` is a proxy for a native stack that a copy does not
capture, and the event loop's ordering between the main task and activations is
not pinned by any requirement.

Rooting was part of it and is now understood: an activation's closure env,
arguments and `this` are reachable only from the spawned task's closure until
the body binds them, so a collection in that window frees them. That fix is in
the stash and works. It was not sufficient.

**R6 is therefore revised.** It is not "save these seven fields" but "no
interpreter state is ambient across a suspension point".

That enumeration has since been done, field by field against the struct. Two
findings:

1. **The actual bug was not a missing field.** `parkOnPromise` reclaimed
   `st.suspended`'s *last* entry on resume. Nothing tied an entry to a task, so
   interleaved parks and wakes made activations restore each other's execution.
   The damage is heap corruption, not a wrong value: A wakes holding B's
   context, A's frames pop scopes belonging to B, B's frames end up in no root
   set, the collector sweeps them, and B resumes with scope indices pointing at
   recycled slots — which is exactly `ReferenceError: value is not defined`.
   Fixed in `c079770`; contexts now carry their task and are reclaimed by
   identity.

   This also explains why the barrier repro passed under `MILOJS_GC_THRESHOLD=1`
   while the app failed: symmetric participants keep everything over-rooted, so
   the bug needs asymmetric interleaving *and* allocation pressure.

2. **Nine fields are per-activation, not seven.** `newTarget` (live for a whole
   constructor body, since it is cleared only after the call returns) and
   `optShort` (the `?.` short-circuit flag) were missing. Both are now in
   ExecCtx.

Everything else in `Interp` is global — heap arenas, the module registry, the
timer and microtask queues, the waiter registry — and must *not* be saved or
restored. `microtasks` and `unhandledRejects` especially: an activation that
settles a promise and then parks has to leave the reaction visible to the loop.

## R4a: an async body that returns a pending promise must adopt it

Found while debugging a real the integration app route hang. The the integration app HTTP cache
does `async get(url) { return fetchData(url).then(...) }` — an async function
whose return value is a **pending** promise.

`spawnActivation`'s completion read the returned promise's state at the moment
of return and settled the activation's own promise with it. A pending promise
has state 0, so it settled the activation with "pending" — a no-op — and the
caller's `await` then hung forever with no error (a genuinely stuck promise, so
even the unsettleable-promise budget net eventually fired: "await did not settle
within budget").

The fix adopts instead: when the returned promise is still pending, register a
reaction on it whose `derived` is the activation's promise and whose handlers
are non-callable. `settlePromise`'s existing passthrough then forwards the
returned promise's eventual settlement — value or rejection — straight through.
When it is already settled, settle directly as before.

Verified on the runtime and against faithful replicas of the cache wrapper
(single, nested, `.json()`, concurrent). Guarded by
`tests/runtime/asyncReturnsPendingPromise.js`, which runs on the **runtime**
(see the new runtime pass in `run.sh`): the fix lives in `spawnActivation`,
which only executes on the runtime, so the engine harness cannot exercise it —
the R1b gap made concrete. The test hangs on a pre-fix runtime binary and
passes on a post-fix one.

**The cold-route hang is now FIXED (`79e39a5`).** It was three independent bugs,
none of them the adoption path: (A) `NATIVE_TCP_ACCEPT` did a *blocking* accept
on the listener fd every event-loop iteration, so once a request parked on its
fetch and released back to the loop, the loop blocked in accept and starved
timers / microtasks / `serviceFetches` — the completed fetch response waited in
its channel until the next TCP connection arrived (steady connections hid it;
one request then silence exposed it); (B) three GC-rooting holes that swept
promises parked activations depend on (await-park `popTemp` with no matching
push, unrooted `spawnActivation` promise, and a new `actPromise` registry for a
promise reachable only through the far end of a `.then` chain); (C) `__tcpClose`
never closed the fd (append-only conn slots, so Drop never ran) — one leaked fd
per request, hanging any EOF-draining client. The earlier note below reflects
the investigation *before* the root cause was found; it is kept because its
ruled-out list was correct and useful. My "`fetchData`'s body never starts" read
was wrong — the body did start and parked normally; the hang was the event loop
never delivering the settled fetch.

Original (pre-fix) investigation notes — the ruled-out list here was accurate:

What had been RULED OUT by testing, so the next investigation did not repeat it:

- Not the recursion limit / stack size — zero RangeErrors in the hang; the
  per-binary `callDepthLimit` fix is unrelated.
- Not the adoption fix — that is correct and committed.
- Not the per-activation stack size — 8 MB and 1 MB stacks hang identically.
- Not the `std/runtime` `stackBytes` change — reverting it still hangs.
- Not reproducible in isolation — faithful UrlCache replicas (single, nested,
  `.json()`, inFlight Map, 3 concurrent) all work. Only the FULL app hangs.

The distinguishing feature of the full app is scale and background work:
startup worker jobs (`dist/worker/jobs/capture*.js`) that spawn their own
concurrent fetches, `setInterval` timers, napi/prisma, and many more concurrent
activations than any replica. The leading hypothesis is exhaustion of some fixed
capacity — the green-task scheduler, the activation-tracking vectors, or the
fetch worker-thread pool — so a new activation is created but never scheduled.
An earlier "works" reading was the app serving a **warm cache** (worker jobs
had pre-populated it), not a successful cold fetch; `Fetching` logs zero times
in both the warm-serve and the hang, so cache state, not the fetch path, decided
the outcome. This is the top open the integration app item.

## A pre-existing GC bug found underneath this work

Building an app-shaped test for R1 surfaced a bug that has nothing to do with
suspension: it reproduces on committed main with none of this work involved.
See `examples/apps/milojs/known-bugs/promiseAllGcRoot.js`.

A live promise chain is collected. The symptom is
`ReferenceError: out is not defined`, where `out` is the accumulator inside the
prelude's self-hosted `Promise.all` — a closure a reaction captured has been
freed while the chain was still pending. It needs nested async calls, a
fire-and-forget async call whose promise nobody holds, and enough allocation to
collect; any one alone passes.

This matters for the plan of record for two reasons:

1. It is the **same failure class** as the `ReferenceError: value is not
   defined` that both R1 attempts produced from the app. Some of what was
   attributed to R1 may be this. R1 should not be retried until this is fixed,
   or the next attempt will be debugging two bugs at once.
2. It shows the async fixtures are the wrong shape. They are small, symmetric
   and allocation-light; the app is none of those. R5 ("existing values
   unchanged") is satisfied by tests that cannot see this class of bug.

## R1b: R1 is runtime-only — the engine does not run on a green task

`milojs.milo` runs the program on a green task, so `schedulerCurrent()` is
non-zero and an async call can spawn an activation. `milojs-engine.milo` calls
`runModule`/`runEventLoop` directly on the main thread, so R1 is simply dormant
there — the engine still runs an async body to completion at its first await.

This matters for testing, not just for parity: `tests/run.sh` runs every `*.js`
fixture through the **engine**, so R1 cannot be covered by a fixture in that
harness. An ordering fixture added there would either fail or, worse, be
captured against the engine's current behaviour and lock the wrong ordering in.
R1 is currently verified by the app and by hand against node.

Not just a missing `Task.spawnWithStack` call: the engine builds a local `Prog`,
while an activation's task body cannot borrow from the frame that spawned it and
has to reach the program through `gProg` (see
docs/proposal-task-shared-state.md). Making the engine mirror the runtime means
moving it onto `gProg` first.

### R1b attempt 1: correct ordering, but a wedged scheduler

Moving the engine onto `gProg` and running the whole program on a green task
does fix the ordering — the engine matches node on the R1 test. It is still not
landed, because `microtaskHandlerGcRoot` then **hangs**, and hangs in the worst
way: the process does not die on SIGTERM, so `timeout` cannot reap it. A wedged
green scheduler never reaches a point where the signal is handled.

Isolated: the same fixture passes on main's engine (`s5 ok 3`) and hangs on the
R1b build. It is the fire-and-forget + churn + nested-async shape — the same
shape that exposed the microtask rooting bug.

Two notes for whoever picks this up:

- Putting only `runEventLoop` on the green task is not enough and looks like it
  works. An async call spawns an activation only when it is already on a green
  task, so the program's top level has to run there too. The half version
  produces correct-looking startup and wrong ordering.
- An unkillable hang is a worse failure mode than a wrong answer, and the
  fixture harness has no per-test timeout that survives it. Landing this without
  fixing that would make one bad build able to wedge CI.

So the engine keeps running on the main thread for now, and R1 stays
runtime-only. `tests/run.sh` therefore still cannot cover R1 — that gap is real
and is the reason the R1 ordering fixture is not in the tree.

## R1a: `await` of a non-thenable does not yield — deferred, with the reason

R1's test was originally written with `await null`. The implementation yields to
the caller only when the awaited value is a pending promise, so an async body
that awaits an already-settled value still runs to completion before its caller
resumes. Node yields either way: the spec resolves the awaited value through
`Promise.resolve`, which queues a microtask even for a non-thenable.

Splitting that off as **R1a** rather than folding it into R1, because R1 is
otherwise met and useful, and R1a needs work R1 does not.

The obvious fix — release the caller and `schedulerYield()` on every await —
was implemented and **reverted**, twice, and the evidence took two tries to get
right. A fixture run that appeared to show 71/71 → 67/71 was invalid: it passed
the runtime binary to `tests/run.sh`, which expects an engine binary, so the
failures were a prelude mismatch and not the change. Measured correctly, the
fixtures stay **71/71 with the yield in place** — they cannot see this defect at
all.

The app can. Against the integration app: 0 errors and ~34ms per route without the yield,
13 errors and 6s per route with it, including
`ReferenceError: dl is not defined` — the unrooted-scope signature — and prisma
failing to read `version` and `loadEngine` off a non-object.

The reason is an R6 violation, and it is the useful part of this finding: a bare
yield creates a **new suspension point that bypasses the `ExecCtx` save and
restore**. While the activation sits yielded, `tempRoots` and the active scope
stack belong to whoever resumes; the yielding activation's own scopes are
therefore unrooted, and a collection during that window frees them.

So R1a is not "add a yield". It is "make every suspension point go through the
same save/restore path", which is R6 applied to a second kind of park. Doing it
properly means `yieldAtAwait` pushing an `ExecCtx` and reclaiming it by task
identity exactly as `parkOnPromise` does.

Deferred rather than dropped: it is observable behaviour real code depends on,
but no the integration app route needs it, and it is not worth destabilising a working
R1 to land it in the same slice.

## A pre-existing GC bug found underneath this work — fixed

Building an app-shaped test for R1 surfaced a bug with nothing to do with
suspension: it reproduced on committed main with none of this work involved.
Fixed in 4cf6ebd; fixture `examples/apps/milojs/tests/microtaskHandlerGcRoot.js`.

`drainMicrotasks` pops a queue entry into locals before invoking it. Once
popped, the entry roots nothing — but only `arg` and `derived` were pushed as
temp roots. The handler itself was unrooted for exactly the duration of the
call that runs user code and can collect. A collection during the handler freed
the scope that handler had captured, and it resumed with its closure variables
gone.

The symptom was a `ReferenceError` naming a variable that appears nowhere in
the running program — `out`, the accumulator inside the prelude's self-hosted
`Promise.all`.

Two consequences for this plan:

1. It is the **same failure class** as the `ReferenceError: value is not
   defined` both R1 attempts produced from the app, so some of what was
   attributed to R1 was this. R1 is no longer blocked; retry it from
   `stash@{0}` against a build that has this fix.
2. It shows the async fixtures were the wrong shape. The repro needs nested
   async calls, a fire-and-forget call whose promise nobody holds, and enough
   allocation to collect — any one alone passes. R5 ("existing values
   unchanged") was being satisfied by tests structurally unable to see this
   class of bug. New async work needs at least one fixture with all three
   properties.

## Risks

- **GC over suspended activations (R7).** Miss a root and objects are collected
  under a suspended activation — a use-after-free that appears only under memory
  pressure. Mitigation: R7's fixture runs under `MILOJS_GC_THRESHOLD=1`.
- **Task-per-activation cost.** Each activation reserves stack address space.
  Lazily committed, so cost is what is touched, but a server with many
  concurrent activations should be measured.
- **Ordering drift.** R1's shape is proven; nested and re-entrant cases are not.

## If the implementation cannot work

Revisit the requirements before the design. The first candidates to drop are R3
(resume order) and the finer points of R1, both of which are observable but
rarely depended on. R2 and R4 are the ones that make the app work; a version
that satisfies only those is still worth shipping.
