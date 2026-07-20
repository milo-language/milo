<!-- doc-meta
system: milojs-async-suspension
purpose: plan of record for making await suspend in milojs — requirements, design, per-requirement status, and test plan
key-files: examples/apps/milojs/eval.milo, examples/apps/milojs/runtime.milo, std/runtime.milo, tests/fixtures/asyncCallOrdering.milo
update-when: a requirement is implemented, dropped, or revised, or the suspension mechanism changes
last-verified: 2026-07-20
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
| R1 async call returns at first await | not started |
| R2 suspension is per-activation | not started |
| R3 resume order | not started |
| R4 settle/reject semantics | not started |
| R5 existing values unchanged | holds (nothing landed yet) |
| R6 per-activation execution state | done (`3215822`) — ExecCtx + save/restore |
| R7 GC over suspended activations | done (`3215822`) — collect walks parked roots, fixture proves it fails without |
| R8 unsettleable promise still reported | holds today, must survive |

## Why

`await` cannot suspend today. The event loop is drained in place until the
awaited promise settles, so an async call runs its whole body before returning.
Two consequences, both hitting the tahoeroads app:

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
R6. A suspended activation holds its state: locals, the JS call stack, the
    pending throw, and the module it belongs to.
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
| R1  | `async function f(){ log("A"); await null; log("C") } f(); log("B")` → `A B C` |
| R2  | barrier repro: two participants await one barrier, both resolve |
| R2  | a timer keeps firing while an activation is suspended |
| R3  | three activations await one promise; all resume, in order |
| R4  | return settles; `throw` rejects; `await` of a rejection throws at the site |
| R5  | every existing async fixture keeps passing unchanged |
| R6  | suspend mid-loop with locals live, resume, check locals |
| R7  | suspend an activation holding the only reference to an object, force GC, resume and use it |
| R8  | await a promise nobody settles → reported, other activations unaffected |

Integration: prisma `$transaction([a, b])` returns rows, and the app's analytics
insert stops burning the budget.

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
