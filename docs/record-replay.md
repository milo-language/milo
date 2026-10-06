<!-- doc-meta
system: record-replay
purpose: deterministic record/replay of a program's nondeterministic inputs: what is captured, the trace format, the runtime hook, divergence
key-files: std/replay.milo, std/time.milo, std/datetime.milo, std/random.*.milo, std/env.milo, std/environ.*.milo, std/args.milo, src/codegen.ts (rrHashInitFn, hashSeedFn), src/main.ts (run --record/--replay), tests/replay.test.ts
update-when: a std entry point starts reading the OS, a record kind is added, the framing changes, or a later phase lands
last-verified: 2026-10-06 (phase 1: clock, timezone, entropy, HashMap seeds, env, argv)
-->

# Record and replay

Any compiled Milo program can record the answers it got from the OS and later run again
on exactly those answers. Run it with `MILO_RECORD=<file>` and every nondeterministic
read std makes is appended to a trace; run it with `MILO_REPLAY=<file>` and each of those
reads returns the recorded answer instead, so the program computes what it computed when
recorded, whatever the clock, environment or argv now say. No recompile is needed; the
variables are read when the process starts. `milo run --record <file>` and
`milo run --replay <file>` are the same thing from the CLI.

Design and the phase plan: [plans/stdlib-next-2026-10.md](plans/stdlib-next-2026-10.md)
§Deterministic record/replay. This is phase 1.

```sh
MILO_RECORD=run.mrr ./server --port 8080      # or: milo run server.milo --record run.mrr --port 8080
MILO_REPLAY=run.mrr ./server                  # same clock, entropy, env and argv as the recorded run
```

## What phase 1 captures

| Record kind | Arg | Payload | Std entry point (file: function) |
|---|---|---|---|
| `time.wall` | | `<sec> <usec>` | `std/time.milo: now` (and so `epochMillis`, `epochSecs`, `since`, `DateTime.now`, `Timer`/`Ticker` instants, log timestamps, uuid v7) |
| `time.local` | epoch seconds | `year month day hour minute second weekday` | `std/datetime.milo: DateTime.fromEpochLocal` (and `localNow`): the host timezone is an input too |
| `random.u32` | | decimal | `std/random.{darwin,linux,windows}.milo: randU32` (`Random.u32`, `float`, `bool`; `int`/`range` on linux and windows) |
| `random.uniform` | max | decimal | `std/random.darwin.milo: randInt` (arc4random_uniform; `Random.int`, `range`, `shuffleI64`) |
| `random.bytes` | byte count | the bytes | `std/random.*.milo: randBytes` (`Random.bytes`, uuid v4, websocket masks) |
| `env.get` | name | `-` unset, `=value` set | `std/env.milo: getEnv` (`Env.get`, `Env.getOr`, and every std module that reads a variable) |
| `env.vars` | | `name NUL value NUL` per entry | `std/environ.{darwin,linux,windows}.milo: envVars` |
| `args` | | each argument then NUL | `std/args.milo: args` (and `getFlag`, `hasFlag`, `ArgParser.parse`) |

Not recorded but still deterministic: **HashMap seeds.** A map's hash seed is entropy and
decides its iteration order, which a program can print. Under either variable the
compiler-emitted seed source (`src/codegen.ts: hashSeedFn`) hands out a fixed sequence
instead, so a recording and its replay iterate every map identically without a record per
map. The decision is made at process start (`rrHashInitFn`, called from `main` before
global initializers).

`std/rng` needs nothing: it is a seeded generator, and its seed comes from the program
(or from `Random`, which is recorded).

## The hook

`std/replay.milo` holds the mode in one thread-local global, decided by a global
initializer at process start (0 undecided, 1 off, 2 recording, 3 replaying). Each hooked entry point is:

```
if replayOff() { return <ask the OS> }      // one load and compare when off
if replayActive() { return <decode replayTake(kind, arg)> }
let v = <ask the OS>
replayPut(kind, arg, <encode v>)
return v
```

A hooked call that runs before std/replay's own initializer (another module's global
initializer reading the clock) finds the mode undecided and decides it on the spot.

When off, the cost is that one thread-local load and compare per hooked call, against a
syscall-sized call it guards. To measure it, time a tight loop of `now()` built against
std before and after a change here.

Once read, both variables are removed from the process's environment: a child process
that inherited `MILO_RECORD` would truncate and interleave into the parent's trace. Only
the top process is recorded; a recorded program reading `MILO_RECORD` sees it unset.

## Trace format (version 1)

A header line, then one record per hooked call, appended in call order and never
rewritten:

```
milo-trace 1\n
<seq> <kind> <argLen> <payloadLen>\n<arg bytes>\n<payload bytes>\n
...
```

- `seq` counts from 1 and must match the reader's position; a mismatch is a corrupt trace.
- `kind` is a dotted ASCII name with no spaces (`time.wall`, `env.get`).
- `arg` names the call so replay can tell `env.get(HOME)` from `env.get(PATH)`; `payload`
  is the answer. Both are length-prefixed raw bytes, so a payload can be binary and any
  size with no escaping (phase 2's file and socket reads), and a reader can stream
  instead of loading the file (phase 1 loads it whole). The trailing newlines are
  redundant framing that a reader checks, and they make a text-only trace readable with
  `less`.
- Each record is written with one `write` call, unbuffered, so a crash leaves every
  record made before it on disk.

The version is bumped only when the framing changes. A new kind is additive: an older
replayer meeting it reports a divergence that names the kind. Kinds reserved for later
phases: `fs.*`, `net.*`, `proc.*` (IO results, phase 2) and `sched.pick` (which ready
task the green scheduler ran next, phase 3).

A trace holds the program's environment and argv verbatim, secrets included. Treat it
like a core dump.

## Divergence

Replay stops the program, prints to stderr and exits with code 3
(`REPLAY_EXIT_CODE`) when:

- the next record is a different call: `replay diverged at record N: expected env.get(HOME), got time.wall`
  (expected is what the trace holds, got is the call the program made);
- the trace has run out: `replay diverged at record N: expected end of trace, got random.u32`;
- the trace is missing, not a `milo-trace 1` file, or corrupt, or both variables are set.

Recording exits with code 3 if the trace cannot be created or written.

## Not captured yet

- **IO** (file, socket and subprocess reads): phase 2. A program whose output depends on
  a file's contents replays correctly only if the file is unchanged.
- **Scheduling order** (which green task runs next, kevent/epoll readiness): phase 3.
  Hooked calls made from several green tasks are recorded in the order they happened,
  but replay only reproduces it if the tasks interleave the same way. The scheduler's own
  deadline clock (`std/time.milo: unrecordedEpochMillis`, used by `std/runtime` and
  `std/select`) is deliberately unrecorded: how often it polls depends on real timing,
  and phase 3 records the decisions instead of the polls.
- **Sleeps still sleep** under replay; a simulated clock is phase 5.
- **Raw extern calls bypass the hook.** Anything a program or package reaches through
  `extern fn` (in `unsafe`, see the `extern-call` warning) is invisible to the trace:
  `localtime_r`, `getenv` or `gettimeofday` called directly, OpenSSL's own entropy.
  The `unsafe` requirement is what makes those holes listable.
- `std/sysinfo` (uptime, hostname, memory, CPU counts), `getpid`, and anything else in
  std that reads the OS but is outside the four phase 1 categories.
- **OS threads.** Only the main OS thread records or replays (it runs `main` and every
  green task). The hook's state is thread-local, and a `Promise.blocking` worker that
  reaches a hook decides "off" (the variables are gone by then) and asks the OS, so its
  reads are an unrecorded hole like an extern call. That keeps the trace single-writer
  with no lock on the hot path; phase 3 decides whether threads get lock-order records
  or are refused under replay.
- **Unconsumed records.** A replay that makes fewer calls than were recorded exits
  normally; reporting the leftover is part of phase 3's divergence work.
- Traces are platform-specific: `random.uniform` exists only on darwin.

## Tests

`tests/replay.test.ts`: records a program touching every phase 1 source (plus a global
initializer, uuid, DateTime, a green task sleeping on the scheduler, HashMap iteration),
replays it with a different environment, argv, timezone and a later clock, and asserts
byte-identical stdout; the same through `milo run --record/--replay`; divergence on call
order, on a call's argument and on trace exhaustion (message and exit code 3); refusal of
missing, foreign and doubly-requested traces; live behavior with neither variable set;
a hooked call on a `Promise.blocking` thread compiling and reading the OS;
HashMap order fixed under record and replay and entropy-seeded otherwise.
