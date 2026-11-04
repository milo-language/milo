# Concurrency Surface Reduction — Implementation Plan

**STATUS: DONE (2026-07-10, merged as e0c40bd).** All three phases shipped:
`Promise.blocking` added (Send-checked, cross-thread wake verified); thread fixtures
migrated; `Thread`/`Mutex`/`RwLock`/`parallel` removed. Full suite + selfhost green;
one resolved deviation — main-thread `await` of a blocking promise blocks on the
channel condvar (via a `_blocking` flag) rather than driving the scheduler, so it does
not run other green tasks during the wait (documented in language-reference). Corpus
change noted in `self-hosting.md` for the self-host track. The plan below is retained
as the design record.

Goal: one concurrency story. Green tasks + `Promise` are the model; `Promise.blocking(fn)`
becomes the only escape hatch for CPU-bound work / blocking FFI. Then remove the public
OS-thread tier (`Thread`, `Mutex`, `RwLock`, `parallel` block) while it has zero users.
Removals are only cheap pre-adoption; additions are cheap forever — so cut now, re-add
from evidence later if ever needed.

End-state public API: `Promise` (+ `.blocking`), `Task`, `Channel`, `WaitGroup`,
`select`, atomics. Most apps need only `Promise`; streaming servers add `Channel`
(see "Choosing a tool" in language-reference.md); the rest are situational.

## Evidence (surveyed 2026-07-10)

- `Thread.spawn`: zero users outside `tests/fixtures` (~17 fixtures + 3 error tests).
  Only std mention is a doc comment (`std/sync.milo:152`).
- `Mutex`/`RwLock` public structs: test fixtures only. All internal std/runtime locking
  is raw `pthread_mutex_*` FFI, not the public types.
- `parallel` block: one fixture (`tests/fixtures/parallelBlock.milo`), nothing else.
  Not handled in src-milo (self-host checker) at all.
- hades (~/git/hades), examples/, benchmarks/, src-milo: green tier only
  (`Task`/`Promise`/`Channel`/atomics).
- `std/time` already has `sleepMs`/`sleepSecs` — `Thread.sleep` replacement exists.

## Phase 1 — add `Promise.blocking(fn)`

The replacement ships before anything is removed.

- `std/runtime.milo`: `Promise.blocking(f: () => T): Promise<T>`. Runs `f` on a fresh
  OS thread (`pthread_create` via existing FFI). Result flows through the promise's
  existing internal channel; the awaiting task wakes via the cross-thread unpark
  transfer list (`runtime.milo:163+`) — machinery already exists, `Channel` already
  supports cross-thread send→park-wake.
- Semantics v1: one thread per call, no pool. Thread must not leak — either detach
  after result send or join inside `await()`; requirement is "no live thread after
  `await` returns", implementer's choice. Pool (cap ~ core count) is explicitly
  future work; do not build it now. Name is `blocking` (tokio `spawn_blocking`
  precedent) — names the *why* (closure blocks/computes), not the mechanism.
- Checker (`src/checker.ts`): apply the Send capture check to `Promise.blocking`
  closures. Existing enforcement is at the `Thread.spawn` boundary
  (`checker.ts:3902`, capture check ~2464, `isSend` at 1657) — extend the same rule
  to `Promise.blocking`. Plain `Promise(fn)` stays un-Send-checked (single-threaded
  scheduler).
- Tests (fixtures): `promiseBlocking.milo` (basic result), `promiseBlockingAll.milo`
  (N-chunk fan-out via `Promise.all` — this is the documented "split work across N
  threads" pattern, no dedicated API), `promiseBlockingChannel.milo` (blocking worker
  sends into a Channel consumed by a task — exercises cross-thread park).
  Error test: `errors/promiseBlockingNotSend.milo` (raw-pointer capture rejected).
- Docs: Promises section of `language-reference.md` + swap the "CPU-bound work or
  blocking FFI" row of "Choosing a tool" to `Promise.blocking`.
- LSP hover/completions pick std APIs up automatically; verify with `milo api blocking`.

## Phase 2 — migrate test fixtures off `Thread.spawn`

Rewrite, don't delete — these fixtures exercise cross-thread runtime paths
(multi-producer channels, cross-thread park/unpark, atomics under real parallelism)
that still exist under `Promise.blocking`.

- Convert each `Thread.spawn` fixture to `Promise.blocking` (or `Task.spawn` where the
  test never needed real threads). `Thread.sleep(ms)` inside them → `time.sleepMs`.
- Retarget Send error tests (`errors/sendNotSend.milo`, `errors/spawnNotSend.milo`,
  `errors/spawnNotSendStruct.milo`) to `Promise.blocking`; keep expected-error
  substrings meaningful.
- `withLock.milo`, `rwLock.milo`, `rwLockThreaded.milo`: delete with Phase 3.
  If `rwLockThreaded` covers a unique parallel-visibility path, replace with an
  atomics-under-`Promise.blocking` fixture instead.

## Phase 3 — removals (one commit)

- Delete `std/thread.milo` (88 lines). `Thread.sleep` users → `std/time` `sleepMs`.
- `std/sync.milo`: remove public `Mutex` and `RwLock` structs. Keep all raw pthread
  FFI decls and `ChannelInner` internals — `Channel`/`WaitGroup`/runtime depend on them.
- Grammar: remove `parallel` block end to end — `src/tokens.ts` keyword,
  `src/parser.ts`, `src/checker.ts` (5 refs), `src/codegen.ts` (3 refs), any
  hir.ts/lower.ts nodes, **formatter and LSP** (repo definition-of-done),
  `docs/grammar.ebnf`, "Parallel Blocks" section of language-reference,
  `tests/fixtures/parallelBlock.milo`. src-milo needs nothing (never implemented it).
- Docs (`language-reference.md`): drop "Escape hatch: OS threads" (one-liner pointing
  at `Promise.blocking`), drop Thread/Mutex/RwLock rows from the Thread API table,
  reframe "Thread Safety (Send/Sync)" around the `Promise.blocking` boundary, reword
  the Green-vs-OS-thread comparison table, update Pitfalls #4/#5 (both shrink: cost
  is declared at creation; WaitGroup/atomics are now refcounted (clone to share,
  auto-drop), so only Channel still needs `destroy`).

## Acceptance

- `bun test` green (full suite).
- `grep -rn "Thread\.\|Mutex\|RwLock\|parallel {" std examples docs src-milo` → no
  public-API hits (pthread FFI internals and ChannelInner comments OK).
- `bun run src/main.ts api thread mutex` → no public results.
- hades and `examples/*` still compile and run.

## Risks / re-add path

- Only lost pattern: long-lived mutable structure shared across blocking workers
  (the one thing Mutex served that move-captures + await + channels don't).
  Answer today: restructure via channels/atomics. If adoption proves the need,
  Mutex re-adds as a ~150-line std module with zero language changes. Do not
  re-add preemptively.
- Atomics stay: on the green tier they're the only shared-mutable-cell across move
  closures (termpair uses `AtomicI64` with zero threads) — not just a threading tool.

## Unresolved

- Detach-vs-join for the blocking thread (no-leak requirement either way).
- Should `time.sleepMs` park the task when called on the scheduler (green-aware
  sleep)? Nice-to-have, separate change; don't block this plan on it.

## Follow-on: one scheduler per core (workers), 2026-11-04

The model above stays; `std/http` can now run N schedulers. Decided: **design A, tasks never
migrate**. Work stealing was rejected because it breaks `Task.scope` borrow soundness (a
borrowing task may only run where its frame is), the documented "tasks never race" promise,
and record/replay determinism (one thread-ordered log).

- **Runtime.** Nothing in `std/runtime` was single-scheduler by construction: the scheduler
  pointer and the panic hook are `thread_local` (`src/scaffold.ts`), and a task unparked from
  another thread goes on the owner's mutex-guarded transfer list and wakes its event loop
  (`unparkTask`/`drainXfer`), never its run queue. `spawnWorker(f)` (std/runtime) starts a
  dedicated OS thread, runs `f` as that scheduler's first task and tears the scheduler down
  when it and its tasks are done. Same checker rules as `Promise.blocking` (`@thread`).
- **Cross-worker sync.** `Channel` and `WaitGroup` already park/wake across threads (their
  waiter records name the waiter's task, and the wake goes through `unparkTask`).
  Fixtures: `workerChannelHandoff`, `workerWaitGroup`.
- **HTTP.** `ServeOptions.workers` (1 default, 0 = one per core) with
  `serveRouterFactory(host, port, make, opts)`: `make` builds one `Router` per worker, on that
  worker. Linux binds one SO_REUSEPORT listener per worker. Darwin and socket activation
  (LISTEN_FDS) share one listener fd and every worker accepts on it. Darwin's REUSEPORT
  binds but does not spread connections, and a handoff acceptor costs a hop per connection
  the kernel already saves on Linux. `workers: 1` takes the old path untouched.
- **Globals.** The checker's "thread read of a global written elsewhere" rule is the audit;
  it ran over every handler path. Changed: `uuid` v7 state (one atomic word, now ordered
  across threads), `log` timestamps decision, `regex` locale flag, the SIGTERM drain globals
  and the replay heap flag (written through atomics). Every other std counter was already
  atomic.
- **Record/replay.** `workers > 1` under `MILO_RECORD`/`MILO_REPLAY` returns an `Err`; the
  single-worker path is unchanged.
- **Open.** The factory closure is called concurrently by all workers (one shared closure
  value), so it must only read what it captured.
- **Measured** (`bun benchmarks/webserver/workers.ts`, 10-core M-series, 2026-11-04, taken while
  other jobs held the machine at load average 17 to 45, so read the throughput rows as noise):
  `/hello` at c=4 while `/fib/32` runs at c=16, p99: workers 1 = 2399 ms, workers 4 = 0.29 ms,
  workers 0 (10) = 1.77 ms. Throughput on the cheap route did not scale on a saturated box
  (keep-alive c=64: 16351 / 15589 / 17198 rps for 1 / 4 / 0). Per-thread CPU under keep-alive
  fib load was even across the 4 workers on the shared listener.
