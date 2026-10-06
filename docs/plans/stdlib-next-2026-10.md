<!-- doc-meta
system: planning
purpose: accepted std and toolchain additions for the agent era, for consideration, with a design sketch for deterministic record/replay
key-files: std/ (http, json, testing, runtime, time, rng, fs, net, process), src/checker.ts (attributes, extern calls)
update-when: an item is accepted, built, or rejected
last-verified: 2026-10-06 (replay phase 1 landed; std module list checked; items marked "no" are absent from std/)
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
2. File, network and subprocess IO through the trace.
3. Scheduler order recorded; divergence detection.
4. dapweb reverse-step on top of replay.
5. Simulation mode: seeded scheduler, simulated clock and network, run many seeds.

## Execution order (accepted 2026-10-06)

Serial, one agent at a time, each landed green before the next:

1. Extern calls need `unsafe`, owning fd/process types (branch `extern-unsafe`, running).
   Replay depends on it: it makes every unrecorded hole visible.
2. Root-cause fixes from `friction-2026-10.md` (analysis first, then fixes by rank).
3. Replay phase 1: time, randomness, env and args. Done (fd64fe4d), see
   [record-replay.md](../record-replay.md).
4. Replay phases 2-3: IO through the trace, scheduler order, divergence detection.
5. Protocol primitives: SSE, deadlines/cancellation/retry, JSON-RPC framing into std.
6. JSON Schema derivation, then `@tool` + MCP serving.
7. diff/patch, glob, semver, gitignore; property testing and fuzzing in `std/testing`.
8. `milo doc <symbol>`; capabilities.
9. Culmination: dapweb reverse debugging of a Milo program. dapweb advertises DAP
   `supportsStepBack`; "step back" and "reverse continue" re-run the program under
   `--replay` to the previous recorded call and stop there. Demo: record a failing run of
   a Milo program, open it in dapweb, run to the failure, step backwards to the cause.
