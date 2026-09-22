<!-- doc-meta
system: concurrency-api
purpose: one-table reference of every concurrency function (tasks, promises, shard, channels, wait groups, atomics, Once), each linked to the page that documents it
key-files: std/runtime.milo, std/sync.milo, std/shard.milo, docs/site/features/concurrency.md
update-when: a concurrency function is added, renamed or removed in std/runtime, std/sync or std/shard, or a linked stdlib section moves
last-verified: 2026-09-22
-->

# Concurrency API

Every concurrency function in one table. For when to use which, and how they fit together, read the [Concurrency](/features/concurrency) guide. `Promise` is imported from `std/runtime` but documented in the guide, so its rows link there.

| Function | Description | Documented in |
|----------|-------------|---------------|
| `Task.spawn(move () => {...})` | Spawn a green task | [std/runtime](/stdlib/runtime#spawning) |
| `t.join()` | Wait for a task to finish | [std/runtime](/stdlib/runtime#spawning) |
| `Promise(fn)` / `Promise<T>.run(fn)` | Run `fn` on a green task, result via `await` | [Concurrency: Promises](/features/concurrency#promises) |
| `Promise<T>.blocking(fn)` | Run `fn` on an OS thread (CPU-bound / blocking FFI) | [Concurrency: Promise.blocking](/features/concurrency#promise-blocking-cpu-bound-work-and-blocking-ffi) |
| `p.await()` | Wait for a promise's result | [Concurrency: Promises](/features/concurrency#promises) |
| `Promise.all(v)` / `Promise.race(v)` | Collect all results / first to finish | [Concurrency: Promise.all](/features/concurrency#promise-all-run-n-tasks-collect-all-results), [Promise.race](/features/concurrency#promise-race-first-result-wins) |
| `parallelMap(v, n, f)` | Divide a `Vec` across `n` OS threads, transform in place, reassemble (`std/shard`) | [std/shard](/stdlib/shard#quick-start) |
| `parallelMapWith(v, windows, states, f)` | The same cycle with per-worker state and a window queue | [std/shard](/stdlib/shard#uneven-work-and-per-worker-state) |
| `parallelScanStr(s, n, overlap, f)` | Divide a `string` into read-only windows and scan on `n` threads | [std/shard](/stdlib/shard#scanning-a-string) |
| `Channel.new(cap)` | Create bounded channel | [std/sync](/stdlib/sync#channel-new) |
| `ch.send(val)` | Send value (blocks if full) | [std/sync](/stdlib/sync#ch-send) |
| `ch.recv()` | Receive value (blocks if empty) | [std/sync](/stdlib/sync#ch-recv) |
| `ch.trySend(val)` | Non-blocking send, returns `bool` | [std/sync](/stdlib/sync#ch-trysend) |
| `ch.tryRecv()` | Non-blocking receive, returns `Option<T>` | [std/sync](/stdlib/sync#ch-tryrecv) |
| `ch.close()` | Signal no more values | [std/sync](/stdlib/sync#channel) |
| `ch.len()` | Current items in channel | [std/sync](/stdlib/sync#ch-len) |
| `WaitGroup.new()` | Create a wait group | [std/sync](/stdlib/sync#waitgroup-new) |
| `wg.add(n)` / `wg.done()` / `wg.wait()` | Track and await a fleet of tasks | [std/sync](/stdlib/sync#waitgroup-methods) |
| `AtomicI64.new(v)` / `AtomicI32.new(v)` / `AtomicU64.new(v)` / `AtomicBool.new(v)` | Create atomic | [std/sync](/stdlib/sync#atomici64-new) |
| `a.load()` | Atomic read | [std/sync](/stdlib/sync#a-load) |
| `a.store(v)` | Atomic write | [std/sync](/stdlib/sync#a-store) |
| `a.add(v)` / `a.sub(v)` | Atomic add/sub, wrapping (returns old) | [std/sync](/stdlib/sync#a-add) |
| `a.cas(exp, des)` | Compare-and-swap (returns old) | [std/sync](/stdlib/sync#a-cas) |
| `a.swap(v)` | Atomic swap (returns old) | [std/sync](/stdlib/sync#a-swap) |
| `Once.new()` | Create a run-exactly-once guard | [std/sync](/stdlib/sync#once-new) |
| `o.run(fn)` | Run `fn` once; later callers block until it finishes | [std/sync](/stdlib/sync#o-run) |
| `o.isDone()` | True once the initializer has completed | [std/sync](/stdlib/sync#o-isdone) |
| `x.clone()` | Give another task/worker its own owner of a channel, wait group, atomic, or `Once` | [std/sync](/stdlib/sync#ch-clone) |
