<!-- doc-meta
system: planning
purpose: accepted std and toolchain additions for the agent era, for consideration, with a design sketch for deterministic record/replay
key-files: std/ (http, json, testing, runtime, time, rng, fs, net, process), src/checker.ts (attributes, extern calls)
update-when: an item is accepted, built, or rejected
last-verified: 2026-10-06 (replay phases 1-4 landed; std module list checked; items marked "no" are absent from std/)
-->

# What std should include next (2026-10)

Milo's std already covers more than Go 1.0 did: HTTP/HTTPS, WebSocket, fetch, TLS, SQLite,
JWT, TOTP, zstd, zip, uuid, unicode, testing, url, select/timer, even an SMT solver. This
is the list of what became standard after Go and Rust shipped their std, plus what makes
agents productive. For consideration, not committed work.

## Protocols and formats that became standard

| Item | Why now | In std |
|---|---|---|
| Server-sent events (SSE) | Every LLM API streams over it; the commonest streaming shape today | no |
| JSON-RPC 2.0 + Content-Length framing | LSP, DAP and MCP all speak it | separate package (milo-json-rpc) |
| JSON Schema derived from types | Tool definitions, structured model output, API validation | no |
| MCP (Model Context Protocol) | How agents call tools; JSON-RPC + JSON Schema underneath | no |
| Deadlines, cancellation, retry with backoff | Every call to a model or remote API needs them; Go's `context` was the right idea | timers/select only |
| Structured logging and tracing | JSON-lines logs, OpenTelemetry spans | plain `log` |
| Diff and patch | Agents produce patches; tools show unified diffs (Myers diff + apply) | no |
| glob, semver, gitignore matching | Every repo-walking tool reimplements them | no |
| BLAKE3, content addressing | Caches, dedupe, reproducible builds | sha*, xxhash |
| CBOR / MessagePack | Compact binary JSON for internal protocols | no |

## What makes agents productive

1. **`@tool` functions.** `@tool fn search(query: string, limit: i64): Vec<Hit>`: the
   compiler derives the JSON Schema from the signature and doc comment, std serves it over
   MCP. Any Milo program becomes callable by an agent with no glue. No mainstream language
   builds this in.
2. **Self-description.** Diagnostics as JSON, `milo fix` and `milo explain` exist. Add
   `milo doc <symbol>`: signature plus one runnable example, offline. Agent code drifts to
   stale idioms copied from old code (dapweb is full of now-unneeded `(0 as i64)` casts);
   an authoritative lookup stops that.
3. **Capabilities.** A program declares what it may touch (paths, hosts, subprocesses);
   anything else fails, Deno-style, enforced in std. Agents run code nobody has read.
4. **Deterministic record/replay.** Below.
5. **Property testing and fuzzing in `std/testing`.** Agent-written tests often cannot
   fail; generated inputs and a built-in fuzzer (Go 1.18 added one) make them check
   something.

## Not in std

Vendor model SDKs, gRPC/protobuf, GUI toolkits: too fast-moving or too big. Ship the
primitives (SSE, JSON Schema, retry, JSON-RPC) and let packages build clients on them.

## Deterministic record/replay: design sketch

Not exotic. rr (Mozilla) records and replays whole Linux processes at the syscall level;
Meta's Hermit runs programs deterministically; FoundationDB and TigerBeetle find their
concurrency bugs by running the real code in deterministic simulation; Antithesis sells a
deterministic hypervisor. Milo can do it more cheaply than rr because it owns the runtime:

- **Every source of nondeterminism already goes through std**: time, randomness, env and
  args, file reads, network, subprocess IO, and the green scheduler's choice of which
  ready task runs next (kevent/epoll readiness order).
- **Green tasks run on one scheduler thread**, so given the same readiness order the
  interleaving is the same. No instruction-level recording needed.

How it works:

1. **Record.** `milo run --record trace.mrr`: each std boundary call that can differ
   between runs appends its result to the trace (`now() -> t`, `read(fd) -> bytes`,
   `rng -> seed`, `scheduler picked task 7`). Costs one append per call; trace size is
   dominated by network and file payloads.
2. **Replay.** `milo run --replay trace.mrr`: the same boundary calls return the recorded
   results instead of asking the OS; the scheduler follows the recorded order. The program
   computes exactly what it computed before.
3. **Divergence detection.** If the replayed program makes a different call than the
   trace has next, stop with "diverged at call N: expected read(fd 7), got write(fd 7)".
   That is a bug in the program (hidden nondeterminism) or a code change since recording.
4. **Holes.** Raw extern calls bypass std, so they bypass recording. The rule that extern
   calls need `unsafe` (branch `extern-unsafe`) makes every hole visible: the compiler can
   list them. OS threads (`Thread`, `Mutex`) need lock-order recording or are refused
   under replay.

What it unlocks:

- An agent reproduces a flaky failure on demand from the trace instead of re-running and
  hoping.
- **Reverse debugging in dapweb**: "step back" = replay to call N-1. A debugger that can go
  backwards, built on the debugger and language we already have.
- **Simulation testing**: replace time and network with simulated ones, seed the scheduler,
  and explore many interleavings per second. The dapweb websocket writer bug (a task used
  a socket after its owner closed it) is exactly what this finds before users do.

Phases, each useful alone:

1. Time, randomness, env and args recorded/replayed (small; makes most tests repeatable).
   **Done 2026-10-06 (fd64fe4d):** also the timezone and HashMap seeds; format, hook and
   what is not captured in [record-replay.md](../record-replay.md).
2. File, network and subprocess IO through the trace. **Done 2026-10-06 (6aa90385,
   fef6af09):** files, directories and fs mutations, sockets, DNS, TLS (above OpenSSL),
   subprocesses, ptys and stdin; synthetic fds under replay; writes recorded by size and
   performed only for stdout/stderr.
3. Scheduler order recorded; divergence detection. **Done 2026-10-06 (6aa90385,
   36d37c5b):** each event-loop poll is a `sched.pick`/`sched.idle` record, sleeps take no
   time under replay, streaming trace reader, divergence with context and unconsumed
   records at exit, `MILO_REPLAY_STOP` (the reverse-step primitive) and `milo trace`. See
   [record-replay.md](../record-replay.md).
4. dapweb reverse-step on top of replay.
5. Simulation mode: seeded scheduler, simulated clock and network, run many seeds.

## Execution order (accepted 2026-10-06)

Serial, one agent at a time, each landed green before the next:

1. Extern calls need `unsafe`, owning fd/process types (branch `extern-unsafe`, running).
   Replay depends on it: it makes every unrecorded hole visible.
2. Root-cause fixes from `friction-2026-10.md` (analysis first, then fixes by rank).
3. Replay phase 1: time, randomness, env and args. Done (fd64fe4d), see
   [record-replay.md](../record-replay.md).
4. Replay phases 2-3: IO through the trace, scheduler order, divergence detection. Done
   (6aa90385, fef6af09, 36d37c5b), see [record-replay.md](../record-replay.md).
5. Protocol primitives: SSE, deadlines/cancellation/retry, JSON-RPC framing into std.
6. JSON Schema derivation, then `@tool` + MCP serving.
7. diff/patch, glob, semver, gitignore; property testing and fuzzing in `std/testing`.
8. `milo doc <symbol>`; capabilities.
9. Culmination: dapweb reverse debugging of a Milo program. dapweb advertises DAP
   `supportsStepBack`; "step back" and "reverse continue" re-run the program under
   `--replay` to the previous recorded call and stop there. Demo: record a failing run of
   a Milo program, open it in dapweb, run to the failure, step backwards to the cause.

## Replay phase 4: close the gaps (accepted 2026-10-06, after the dapweb demo; done 2026-10-06)

**Done** (292c0bdf, 3540b8d9, 485a5df0, 94ad5f6d, d70aca75, 979f6649, d16b3309; described in
[record-replay.md](../record-replay.md) §Phase 4): the extern catalog
(`src/extern-effects.ts`, every std extern, gated by tests/externEffects.test.ts),
compiler-generated wrappers for every extern call (`@records` for a program's own,
return value for scalar-only ones), holes listed by `--replay-holes` and reported once
per recorded run and in the trace, OS threads in one tagged trace with std/sync's
operations ordered, `unsafe` memory shared with a thread reported as a hole, and (added
during the phase) deterministic addresses: a restart with ASLR off and a fixed-address
heap for the program's allocations and green stacks. std has no Mutex or Thread type, so
"Mutex lock acquisition" and "Thread spawn/join" are Channel/WaitGroup/Once/atomics and
`thread.spawn` for Promise.blocking workers.


Phases 1-3 record what goes through std; raw `unsafe` extern calls and OS threads are
unrecorded. Both can be closed, the way rr closes them for Linux syscalls:

1. An extern effect catalog: for every extern std declares (POSIX/libc on darwin and
   linux, Win32 on windows), what it returns and what it writes through pointers, with
   output sizes (`read` writes `buf[ret]`, `stat` writes `sizeof(stat)`, `getaddrinfo`
   writes a list). Built from the man pages and Win32 docs, like rr's syscall table.
2. The compiler records catalogued extern calls automatically under MILO_RECORD and
   replays them under MILO_REPLAY; `@pure` externs need nothing; externs with only scalar
   params and return are recorded with no catalog entry. User code describes its own
   externs with one attribute (e.g. `@records(buf[len])`).
3. Holes are never silent: uncatalogued pointer-taking externs are listed at compile time
   and reported once per recorded run ("this run called unrecorded foo at x.milo:42").
4. OS threads: safe Milo shares memory between threads only through std sync primitives
   (Channel, atomics, Once, WaitGroup), so recording their acquisition/message order per thread is
   enough to replay multithreaded programs deterministically; rr instead serializes all
   threads onto one core. `unsafe` shared memory is reported as a hole.

## Fd ownership, finished (accepted 2026-10-06, after replay phase 4)

The websocket writer bug (a task wrote to a socket fd after its owner closed it) is now
hard to write but not impossible. Finish it:

1. `Task.scope`: tasks spawned in a scope must finish before it returns, so they may
   borrow (`&conn`) instead of taking a raw fd by value. Needs the rule for borrows
   shared across the M:N scheduler's OS threads (owner decision: after borrowing
   closures, which have landed). Then dapweb's ws writer borrows its connection.
   **Done 2026-10-07**: design and rules in [task-scope-2026-10.md](task-scope-2026-10.md)
   (scoped tasks stay on the caller's OS thread, so no Send/Sync bound; a borrowed
   binding is read-only to the whole scope or owned by one task); `WsConn.recv` takes
   `&Self`; dapweb's writer is a scoped task borrowing the conn.
2. Convert the remaining std pub fns that take or return raw `i32` fds (~69 at the
   friction analysis) to owning types (`OwnedFd`, `TcpStream`, `Pty`, `Child`), keeping
   raw-fd entry points `@unsafe` for FFI.
   **Done 2026-10-07**: inventory, dispositions and the gate (`tests/rawFdApi.test.ts`) in
   [raw-fd-2026-10.md](raw-fd-2026-10.md); handles are borrowed through `AsFd`, and
   `@unsafe` now applies to methods.

## Dogfood: chadsmith.dev/todo in Milo (accepted 2026-10-07)

After the todo app's Node hardening lands (digitalocean repo, todo/) and SSE is in std:
port todo/server.js to Milo with the same HTTP API and the same public/ frontend
(std/http routing, std/sqlite on the existing todo.db, std/jwt, fetch for the Google
OAuth callback, std SSE for live sync). Gate: a differential test that runs one request
script against the Node and Milo servers and compares responses. Deploy side by side on
another port, switch nginx /todo/ when the diff passes, keep a one-line rollback. No
production recording (decided 2026-10-07): traces grow without bound and capture user
data and secrets; record/replay stays a local debugging tool.
