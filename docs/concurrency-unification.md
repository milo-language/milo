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

### Phase 2 — green-aware IO in std/os

- `std/os`: safe wrappers `readFd(fd, buf, n)` / `writeFd(...)` (extern `read`/`write` stay raw): in a task → `setNonblocking` once + EAGAIN → `schedulerWaitRead/Write` loop; else plain blocking call.
- Port `std/net` (send/recv/accept), `std/ws`, `std/pty`, `std/io` to the wrappers; delete their inline copies. `connect` gets the same treatment (EINPROGRESS → waitWrite → SO_ERROR; note macOS kqueue reports connect *failure* as readable — see node-milo notes).
- Fixture: task reads a pipe while another task computes — both make progress.

### Phase 3 — select

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

### Phase 4 — Promise rework + Go exit semantics

- `Task.spawn` returns a joinable handle: `Task.join()` parks until done (task struct gains a done-waiter slot). Add `WaitGroup` (counter + parked waiters) to `std/sync`.
- `Promise` reimplemented as task handle + result channel; `await` parks (task context) or drives the scheduler without the 100ms spin (main context, using the wakeup fd).
- Flip main-exit: remove implicit `_schedulerDrain()`; migrate examples/fixtures that relied on drain to explicit `join`/`WaitGroup`. This is the breaking step — do last, with a sweep of examples/ and hades.
- Docs: language-reference concurrency section rewrite; Thread/Mutex demoted to escape-hatch section.

## Non-goals

- M:N multi-threaded scheduler (post self-hosting).
- async/await syntax — the whole point is that blocking code yields automatically.
- Removing pthread `Thread` — it stays for CPU parallelism.
