# milojs

A JavaScript interpreter written in Milo. Long-term goal: replace the
JavaScriptCore dependency in `examples/apps/minibun.milo` with a pure-Milo
engine.

## Node-API: real native addons

milojs implements enough of the Node-API (N-API) C ABI to load and run real
`.node` addons — compiled shared libraries, not shims. `require("x.node")` and
`process.dlopen()` both reach the loader, which `dlopen`s the library and calls
its `napi_register_module_v1` entry point.

The proof case is Prisma. Its query engine is a Rust binary
(`libquery_engine-darwin-arm64.dylib.node`) that talks to the host through
threadsafe functions and a tokio worker pool. It loads, connects to sqlite, and
returns rows:

```
$ milojs query.js
connected
rows: 3
first: {"id":1,"roadName":"Highway 50","areaName":"IN THE SACRAMENTO VALLEY..."}
count: 134301
done
```

That is the real engine doing real SQL — no emulation of Prisma, and no
JavaScript reimplementation of the driver.

What this needed beyond the C ABI itself:

- **Threadsafe functions** are ref-counted, and "can still deliver a result"
  is tracked separately from "keeps the process alive". napi-rs unrefs its own
  threadsafe functions, so conflating the two either hangs the process after
  `$disconnect` or kills an in-flight query.
- **A blocked `await` services node-api work.** An addon settles from its own
  threads, so there is no timer or microtask to run while it works; without
  servicing it, `await engine.connect()` looks like a promise nothing will
  settle.
- **`await` adopts thenables**, since a query returns a `PrismaPromise` (a
  plain object with `.then`), not a native promise.

## Running real applications

The engine runs the tahoeroads backend unmodified: Express, tRPC, zod,
cookie-parser, compression, jsonwebtoken, and Prisma, from the app's own
`node_modules`.

```
Will use port 3009
TahoeRoads server listening at http://localhost:3009
```

`fetch` is async: the request runs on a worker OS thread and the event loop
settles a pending promise when the response arrives, so timers keep firing and
concurrent requests overlap. (A green task does not work here — the interpreter
loop runs on the OS main thread and never parks, so `schedulerYield` is a no-op
and a green task would never be scheduled.)

## Known gap: await does not suspend

Milo has no coroutines, so `await` cannot suspend its native frame. Instead the
event loop is drained in place until the awaited promise settles. Values are
correct, ordering is not: continuations run earlier than they should.

```js
async function f() { console.log("A"); await null; console.log("C"); }
f(); console.log("B");
// node: A B C      milojs: A C B
```

This is not only cosmetic. Calling an async function does not return at its
first `await` — it returns when the whole body finishes — so two async calls
that have to interleave deadlock:

```js
function makeLock(n) {                       // releases once n participants arrive
  let release; const gate = new Promise((r) => (release = r));
  return { then(cb) { if (--n === 0) release("open"); return cb?.(gate); } };
}
const lock = makeLock(2);
async function participant(id) { await lock; return "done" + id; }
Promise.all([participant(1), participant(2)]);
// node: resolves      milojs: participant(2) is never called, so the lock
//                     never opens and participant(1) waits forever
```

prisma batches a multi-statement `$transaction` behind exactly this barrier, so
`$transaction([a, b])` hangs while `$transaction([a])` and the callback form
both work.

Fixing it means running each async activation on its own green task and parking
at `await`. Milo has green tasks with real stacks, and they only switch at
explicit park points, so the interpreter's *native* stack is already per-task.
The interpreter itself now runs on a green task, which is what makes park and
unpark reachable at all — both are no-ops in the OS main context.

Three things still stand between that and working suspension:

1. **A direct-switch primitive.** JS runs an async body synchronously up to its
   first `await`, and only then does the call return. `Task.spawn` merely
   queues, so the body would not start until the next scheduler turn and
   `f(); log("B")` would print B before anything in f. The scheduler needs "run
   this task now, come back here when it parks" rather than round-robin.

2. **Per-task execution state.** The Interp bookkeeping describing the current
   execution — throw flag and thrown value, call depth, the temp-root stack, the
   active-scope stack, the module path/dir stacks — is global. Switches happen
   only at park points, so saving it into the task record on park and restoring
   on resume is enough; it needs no finer granularity.

3. **GC over parked tasks.** Temp roots and active scopes are roots, so the
   collector has to walk every parked task's saved state, not just the running
   one.

## Stage 1 — tree-walking interpreter

Implements a small JS subset end to end: lexer → AST → evaluator.

- Values: number (f64), string, bool, null, undefined, functions
- Variables (`let`/`var`/`const`, all block-scoped), assignment
- Arithmetic `+ - * / %` with JS coercion (`+` concatenates if either side is
  a string), comparisons, `== !=` (loose-ish), `&& ||` (short-circuit, yield
  operand values), unary `- !`
- `if`/`else`, `while`, blocks
- Function declarations, anonymous function expressions, `return`, recursion,
  and real closures (a function captures its defining scope)
- `console.log` with JS output formatting (integral numbers without `.0`,
  shortest round-trip float text, `NaN`/`Infinity`)

Out of scope for stage 1: objects, arrays, prototypes, `this`, GC, `for`,
ternary, exceptions/`try`, regex, bytecode.

Internals: the AST is index-based (enums holding i64 indices into flat arenas
in `Prog`) — recursive structure without stored references. Scopes live in an
arena (`Vec<Scope>`, parent links by index) so closures capture their
environment by index.

## Stage 2 — mark-sweep GC over the scope arena

Dead scopes are now reclaimed. Design: **stable slots + free-list reuse, no
compaction** — closures (`Func(fn, envIdx)`) and parent links reference scopes
by index, so slots can never move. Roots are global scope 0 plus an explicit
dynamic-call-stack `Vec` (a recursive frame's parent is its *lexical* scope, not
its caller, so the parent chain alone under-roots the live call stack). GC runs
**only at statement boundaries** — the one safepoint where every live value sits
in a scope binding and no closure is in-flight mid-expression — which keeps the
collector ~130 lines of plain loops with no `unsafe` and no lifetime plumbing.

`tests/gc.js` (~800k scope allocations) stays byte-identical to `bun`; run it
with `MILOJS_GC_STATS=1` to watch the arena stay capped near the GC threshold
(~1028 slots) instead of growing to ~800k.

## Run

```bash
bun run src/main.ts run examples/apps/milojs/milojs.milo -- examples/apps/milojs/tests/basics.js
MILOJS_GC_STATS=1 bun run src/main.ts run examples/apps/milojs/milojs.milo -- examples/apps/milojs/tests/gc.js
```

`tests/*.js` each have a `tests/*.expected` file; output is byte-identical to
`bun <script>` for all.

## Roadmap

- Stage 3: objects, arrays, prototypes, `this` — add an `Obj(u32)` heap cell as
  a new `JSValue` variant, collected by the same `markScope` (extra variants,
  same index-walk shape)
- Stage 3 (in progress): objects landed (literals, get/set, nesting,
  reference equality, GC'd object heap); arrays, prototypes, `this`, `new` next
- Stage 4: bytecode VM (compile AST → bytecode, dispatch loop)
- Stage 5: enough builtins (JSON, Math, String/Array methods, timers) to run
  minibun's node shims without JSC
- Stage 6: test262 conformance lock
