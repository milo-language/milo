# Concurrency Unification

Goal: one concurrency system, Go's factoring. `Task` is the user-facing primitive; `Channel` parks green tasks; `std/os` IO is green-aware by default; `select` waits on channels + fds; `Thread`/`Mutex` become a documented escape hatch; `Promise` is sugar over green channels. Design motivated by hades M4 (see hades `docs/design.md` M7).

## Current state (what's broken and why)

Two non-communicating worlds:

- **Green world** (`std/runtime`): single-threaded ucontext scheduler. Task = raw 64-byte struct; states ready/running/waitingIo/done; run queue + fd-keyed wait list; kqueue/epoll event loop. A task can wait on exactly one fd (`tWaitFd`) — nothing else.
- **pthread world** (`std/sync`, `std/thread`): `Channel` blocks via `pthread_cond_wait`, which parks the *OS thread* — the same thread every green task shares. `Channel.recv` from a green task therefore freezes the whole scheduler.

Consequences (all hit in hades):

1. `Channel.recv` in a green task deadlocks the scheduler → hand-built self-pipe + `tryRecv` wake pattern in hades server.milo.
2. Green-aware IO (`schedulerCurrent()` check + `setNonblocking` + EAGAIN → `schedulerWaitRead`) is copy-pasted per call site in `std/net` (send/recv/accept), partially in `std/ws`, absent in `std/pty` and `std/os`.
3. No `select`: a green task waits on one fd only; "fd OR channel" is impossible without the self-pipe hack.
4. `Promise.await` busy-polls (`tryRecv` + yield/tick loop) — burns CPU, and the main-thread path spins `_schedulerTick` with a 100ms poll.
5. **Exit semantics**: codegen emits `_schedulerDrain()` before every `ret` in `main` (src/codegen.ts:755,851,879); drain loops `while numTasks > 0`. `return 1` from an error path (e.g. bind failure) after spawning server tasks hangs forever — the tasks never finish. Bit hades directly.

## Target semantics

- `Task.spawn` everywhere; tasks communicate over `Channel`.
- `Channel` send/recv from a green task parks that *task* (scheduler keeps running); from a plain OS thread it blocks via pthread cond as today. Cross-world wakes work in both directions.
- All fd IO in std yields to the scheduler when called from a task. No per-call-site `_inGreen()` checks in user or std code.
- `select` waits on any mix of channel-recv, channel-send, and fd readiness, with optional timeout.
- Main exit: Go rule — when `main` returns, the process exits; outstanding tasks die. Waiting is explicit (`Task.join`, `WaitGroup`, or channel). This replaces the implicit drain (phase 4; needs example migration).
- `Thread`/`Mutex`/`RwLock` stay, documented as the escape hatch for CPU-bound parallelism and FFI that must block. Scheduler stays single-threaded (M:N is out of scope; revisit post self-hosting).

## Phases

Each phase lands as isolated commits with fixtures; full `bun test` before each. hades is the integration test — after phases 1–3, delete its wsWriterLoop self-pipe machinery and per-call-site green IO.

### Phase 0 — unblock + groundwork (small) — DONE

- Document `os.exit(code)` as the immediate error-path escape (bypasses drain). hades bind-failure fix today: `exit(1)` instead of `return 1`.
- Scheduler wakeup fd: add `EVFILT_USER` (darwin) / `eventfd` (linux) to `std/event`, registered by the scheduler at init. Foundation for cross-world channel wakes and timers. API: `eventLoopNotify(el)` callable from any thread; poll reports it like an fd.
- New task wait state `waitingPark` + primitives in `std/runtime`:
  - `schedulerPark(): void` — current task off run queue, swap to scheduler.
  - `schedulerUnpark(task: *u8): void` — push task back on run queue; callable from scheduler thread; cross-thread version signals the wakeup fd with the task ptr queued on a mutex-guarded ready-transfer list.

### Phase 1 — green-aware Channel — DONE

Rework `ChannelInner`: keep mutex/buffer/ring; replace cond-only blocking with waiter lists.

Impl notes: waiter nodes live on the parked task's stack (frame stays alive while parked; waker pops under the channel mutex before unpark, so no dangling). `send` now also checks `closed` inside its wait loop, and `close` broadcasts `condNotFull` too. `tryRecv`/`trySend` unpark the opposite side. `Promise.await` in a task is a parked `recv`; main-context await still ticks (phase 4). `promiseRace` still spins (needs select, phase 3).

- Add `recvWaiters` / `sendWaiters`: intrusive lists of `Waiter { task: *u8, next }` (green) alongside the existing conds (pthread).
- `recv`: buffer non-empty → take (as today). Empty: if `schedulerCurrent() != 0`, append waiter, unlock, `schedulerPark()`; on wake, retry. Else pthread path unchanged.
- `send`: symmetric on full buffer.
- Wake on send/recv/close: pop a green waiter → `schedulerUnpark` (via wakeup fd if caller is a foreign thread) **and** `pthread_cond_signal` (a pthread waiter may also exist). Close broadcasts both.
- `Promise.await` in a task: replace tryRecv/yield spin with parked recv. Main-thread await keeps the tick loop for now (phase 4 fixes).
- Fixtures: task↔task channel over parked recv; pthread→task send wakes scheduler; task→pthread; close semantics; hades wsWriterLoop pattern reduced to a plain `for msg in ch`.

### Phase 2 — green-aware IO in std/os — DONE

- `std/os`: safe wrappers `readFd(fd, buf, n)` / `writeFd(...)` (extern `read`/`write` stay raw): in a task → `setNonblocking` once + EAGAIN → `schedulerWaitRead/Write` loop; else plain blocking call.
- Port `std/net` (send/recv/accept), `std/ws`, `std/pty`, `std/io` to the wrappers; delete their inline copies. `connect` gets the same treatment (EINPROGRESS → waitWrite → SO_ERROR; note macOS kqueue reports connect *failure* as readable — see node-milo notes).
- Fixture: task reads a pipe while another task computes — both make progress.

Impl notes: added `readFd`/`writeFd`/`acceptFd`/`connectFd` plus TLS twins `sslConnectFd`/`sslReadFd`/`sslWriteFd` in std/os (imports std/runtime — resolver visited-set makes the cycle safe). `connectFd` does nonblocking connect → park writable → `getsockopt(SO_ERROR)`. New platform consts `einprogress`/`soError`. Deleted inline green-IO from io/net/ws/pty (all four platforms); `_readSome`/`_SSL_ERROR_*` in ws collapsed into the wrappers. Verified live: HTTPS `fetch()` from a green task returns 200 (real TLS handshake through parked SSL IO). Fixtures: `greenIoPipe`, `tcpGreenConnectRefused`.

### Phase 3 — select — DONE

- Runtime: allow one task to register N wait sources (channel waiter entries + fd registrations); first ready wins, task deregisters the rest on wake.
- API (stdlib first, syntax later if earned):
  ```milo
  var sel = Select.new()
  sel.onRecv(dapCh)      // arm 0
  sel.onRead(ptyFd)      // arm 1
  sel.onTimeout(5000)    // arm 2
  match sel.wait() { 0 => {...} 1 => {...} 2 => {...} }
  ```
  `wait()` returns the armed index; the winning recv's value fetched via `sel.takeRecv<T>(0)` or arm-local `tryRecv` after wake (decide during impl — heterogeneous `T` across arms is the constraint; per-arm fetch avoids compiler work).
- Timeout arm rides the event loop poll timeout.
- Fixture: fd-or-channel race both directions; timeout fires.

Impl notes (`std/select.milo` + runtime/sync additions):
- One unified 48-byte waiter Node (runtime) serves plain channel park **and** every Select arm; channel wait lists hold kind 0 (plain) / 1-2 (sel recv/send), scheduler `sSelFdHead` holds kind 3-5 (read/write/timer). This replaced the old 16-byte `[task,next]` channel node.
- `SelectState` = mutex + `claimed`(-1) + `task` + `parked`. Claim protocol: a firing source calls `_selectTryClaim(state, arm)` (sets claimed once, unparks only if `parked==1`); the task's `_selectWaitState` sets `parked` under the same mutex then parks. The parked-gate is what makes the arm-time-vs-park race safe, including a foreign pthread firing a channel mid-arming.
- Chose **per-arm fetch**: `wait()` returns the index, user re-reads (`ch.recv()`/`readFd`). Documented single-consumer requirement (TOCTOU if a second consumer drains between claim and fetch).
- Channel arms are free generic fns `selectRecv`/`selectSend` (no method-level generics in Milo); `onRead`/`onWrite`/`onTimeout` are methods. Timer arms ride `_selMinTimeout` shrinking the poll timeout; fd arms register with the event loop and are claimed in `_pollAndWake`.
- Verified: channel-wins, timeout-fires, fd-wins, and cross-thread pthread→parked-select (10/10 stable). Fixtures: `selectChannelVsTimeout`, `selectFdVsChannel`.
- Not yet done: `select` syntax sugar (stdlib-only for now); `onWrite` has no fixture (symmetric to `onRead`).

### Phase 4 — Promise rework + Go exit semantics — DONE

- `Task.spawn` returns a joinable handle: `Task.join()` parks until done (task struct gains a done-waiter slot). Add `WaitGroup` (counter + parked waiters) to `std/sync`.
- `Promise` reimplemented as task handle + result channel; `await` parks (task context) or drives the scheduler without the 100ms spin (main context, using the wakeup fd).
- Flip main-exit: remove implicit `_schedulerDrain()`; migrate examples/fixtures that relied on drain to explicit `join`/`WaitGroup`. This is the breaking step — do last, with a sweep of examples/ and hades.
- Docs: language-reference concurrency section rewrite; Thread/Mutex demoted to escape-hatch section.

Impl notes (2026-07-07):
- **Cooperative join.** Task struct grew two fields (`tJoiner`, `tJoinCell`; 72→88 B). A green joiner registers `tJoiner`+parks; the main thread registers `tJoinCell` (a heap i64 done-flag) and drives the scheduler until it's set. On completion `_reapTask` frees the task struct and wakes the joiner / sets the cell. Contract: **join before the target can complete** (register precedes completion on the cooperative scheduler) — a late join reads freed memory. Fire-and-forget tasks stay auto-freed with no per-task sync object, so a server spawning one task per connection doesn't leak.
- **WaitGroup** (`std/sync`): mutex + count + parked-green-waiter list + pthread cond. `done` wakes both worlds; `wait` parks a task, drives the scheduler from main (when `schedulerExists()`), or `cond_wait`s on a plain thread.
- **Main-context block driver.** `_schedulerRunOnce(timeoutMs)` factors the old tick; `_schedulerBlockMain()` = `_schedulerRunOnce(-1)` polls blocking on the wakeup fd (clamped by any select timer) instead of the 100 ms spin. `Promise.await`, `Task.join`, and `WaitGroup.wait` all use it from main.
- **Go exit.** codegen no longer emits `_schedulerDrain()` before `main`'s `ret` — main returns → process exits → outstanding tasks die. `_schedulerDrain` was renamed **`schedulerRunToCompletion()`** and kept as an explicit "run all spawned tasks to quiescence, then tear the scheduler down" entry (used by servers that block forever and by fixtures that spawn fire-and-forget workers).
- Migrated: `greenThread` (WaitGroup), `greenThreadMany` + the park/channel/select/tcp fixtures (`schedulerRunToCompletion`/`join`), termpair server (`schedulerRunToCompletion`) + client (already drove manually), and hades `web`/`mcp` mains. Verified: milo suite green; termpair + hades web stay up serving HTTP 200; hades mcp e2e 10/10.
- **Compiler bug surfaced + worked around:** i64 literals > 2^53 miscompile (IntLit stored as a JS `number`, so `9223372036854775807` rounds to a double and wraps negative). It bit `_selMinTimeout`'s old i64-max sentinel — replaced with a `haveBound` bool. Proper fix (lossless i64 lexing, or reject imprecise literals in the checker) is still open.

## Non-goals

- M:N multi-threaded scheduler (post self-hosting).
- async/await syntax — the whole point is that blocking code yields automatically.
- Removing pthread `Thread` — it stays for CPU parallelism.
