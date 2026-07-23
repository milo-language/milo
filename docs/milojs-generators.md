<!-- doc-meta
system: milojs-generators
purpose: design of record for generator functions in milojs, reusing the async-activation green-task machinery
key-files: examples/runtimes/milojs/eval.milo, examples/runtimes/milojs/parser.milo, examples/runtimes/milojs/ast.milo
update-when: generators are implemented or the design changes
last-verified: 2026-07-21
-->

# milojs: generators (design of record)

## Status (2026-07-21): slice 2 shipped on the runtime

Working and fixture-covered (`tests/runtime/generators.js`,
`generatorGcRoots.js`), byte-identical to node: `next()`, bidirectional
`next(v)`, early `return` (value with `done:true`), `for-of` / spread /
`Array.from` consumption, `yield*` delegation, infinite generators with `break`,
clean process exit when a generator is abandoned mid-iteration, GC over a
generator parked at a `yield` (R7-style, under `MILOJS_GC_THRESHOLD=1`), and
generators interleaved with `async`/`await`.

Two design points that changed during implementation:
- **No current-generator stack.** Each generator body runs on its own green
  task, so `yield` resolves its generator by `schedulerCurrent()==genTask`. The
  per-task stack this doc assumed (for nested generators) is unnecessary — task
  identity already distinguishes them.
- **Records are removed on completion.** A finished generator's stale body-task
  pointer would otherwise collide with a later generator whose freshly-spawned
  task reuses the freed address, mis-resolving `yield`. `genNext` drops the
  record on the terminal read; a later `next()` on the object (still flagged
  `isGenerator`) returns `{done:true}`.

**Runtime only (R1b).** Generators need the green-task scheduler, which only the
runtime binary runs the program on; on the engine `next()` throws. So the QuickJS
sweep (engine) does not benefit — that gap is the R1b wall in
docs/milojs-async-suspension.md, not a generator gap.

Not yet done (slice 3): `gen.return()` / `gen.throw()`, and direct array
destructuring `const [a,b] = gen()` (the parser desugars destructuring to indexed
access `_t[0]`, which fails for every non-indexable iterable, not just
generators; `const [a,b] = [...gen()]` works).

---

`function*` already parses far enough to be detected and throw "generator
functions are not supported"; some `yield` positions still fail to parse. This is
the design to make them actually run. It reuses the async-activation machinery
(green tasks + park/unpark + ExecCtx save/restore) already built for await
suspension — `yield` is structurally the same suspension as `await`, so this is
cheaper than a from-scratch coroutine.

## The reused machinery (eval.milo)

`spawnActivation` (5073) is the template: it spawns the body on an 8 MB green
task, the body runs and unparks its caller at the first suspension point, and the
caller parks and later resumes restoring its ExecCtx via `resumeExecCtx`. Study
also `saveExecCtx`/`resumeExecCtx`, `schedulerPark`/`schedulerUnpark`, the
`actTask`/`actPromise`/`suspended` vectors, and how `collect` marks parked
activations' roots.

## The key difference from async activations

An async body runs to its first `await` AUTOMATICALLY (the caller parks
meanwhile). A generator body starts PAUSED and runs only when `next()` is called,
and `yield` is BIDIRECTIONAL — `yield e` returns the value passed to the
resuming `next(v)`. So a generator is a persistent task that pauses at every
`yield` and resumes on each `next()`, passing a value in each direction.

## Generator object

A JSObj flagged `isGenerator`, with a side record (parallel vectors keyed by the
gen object index, like actTask — or a HashMap<i64, GenState> per the object
side-table plan) holding:

- `task`: the body's green-task ptr.
- `state`: start | suspended | running | done.
- `yielded`: value handed out by the current `yield`/return (→ next()'s caller).
- `sent`: value passed into `next(v)` (→ the yield expression's result).
- `ctx`: the saved ExecCtx while the gen is parked at a yield.
- these are GC roots while parked — `collect` must mark `yielded`/`sent` and the
  saved ctx, exactly as it does for suspended activations.

## Protocol

- **Call a `function*`** → `makeGenerator(fnIdx, env, args, this)`: create the gen
  object, spawn the body task which IMMEDIATELY parks (waiting for the first
  `next`). Do NOT run the body. Return the gen object. Push the gen onto a
  CURRENT-GENERATOR stack keyed by task, so a nested `yield` finds its own gen
  (generators can drive other generators).
- **`gen.next(v)`**: if done → `{value: undefined, done: true}`. Else set
  `sent = v`, save the caller's ExecCtx + park the caller, unpark the gen task.
  The gen resumes (restore its ctx), runs to the next `yield`/return/throw, which
  unparks the caller. Caller resumes → read `yielded`/`done` → return
  `{value: yielded, done}`.
- **`yield e`** (a new eval case): find the current gen (top of the stack for
  this task); eval `e` → `yielded`; save the gen's ExecCtx, unpark the caller,
  park the gen; on resume restore the gen's ctx and the whole `yield` expression
  evaluates to `sent`.
- **return / body end**: `state = done`, `yielded = <return value>`, unpark the
  caller with `done = true`, pop the current-gen stack.
- **`gen.return(v)` / `gen.throw(e)`**: resume the gen forcing a return / throw at
  the current yield point (a pending-signal field the `yield` resume checks).
- **`yield* iterable`**: desugar to a loop that drives the inner iterator's
  `next`, yielding each value (can be done in the prelude once `yield` works).

## The subtle parts (where R1/R1b-style bugs hide — test each under GC stress)

1. **Current-generator tracking must be a STACK, per task** — a generator can
   call `next()` on another generator; `yield` must resolve to the innermost.
2. **ExecCtx save/restore must be symmetric** — a bare park without saving the
   ctx bypasses R6 and corrupts an unrelated activation (this is exactly what
   sank the R1a bare-yield attempt). yield goes through save/restore like
   parkOnPromise, not a raw schedulerYield.
3. **GC roots** — the parked gen's ctx + yielded/sent are the only refs to those
   objects while suspended; `collect` must walk them. Run every slice under
   `MILOJS_GC_THRESHOLD=1`.
4. **A generator abandoned mid-iteration** leaves a parked task forever; that is
   acceptable (matches a dropped generator in JS), but confirm it does not wedge
   the event loop the way the reverted R1b whole-program-on-green-task did.

## Slices (each: build → tests/run.sh → GC-stress → app smoke → commit)

1. Parser + AST: `yield e` / `yield* e` expression, `FuncDef.isGenerator`. (No
   score gain alone — the call still throws — so fold into slice 2.)
2. `makeGenerator` + `gen.next` + the `yield` eval case + the `{value, done}`
   result. Minimal: `function* g(){ yield 1; yield 2 } [...g()]` → `[1,2]`.
3. `gen.return`/`gen.throw`, `yield*`, and `for...of` over a generator.

Fixtures from node: a counter generator, bidirectional `next(v)`, early return,
throw-into, `yield*` delegation, spread/`for-of` consumption.
