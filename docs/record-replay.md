<!-- doc-meta
system: record-replay
purpose: deterministic record/replay of a program's nondeterministic inputs: what is captured, how replay answers it, scheduling, the trace format, divergence, stopping at a record, `milo trace`
key-files: std/replay.milo, std/os.milo (sys* calls), std/runtime.milo (pollAndWakeTraced), std/fs.milo, std/io.milo, std/net.milo, std/process.milo, std/pty.*.milo, std/openssl.milo, std/time.milo, std/env.milo, std/args.milo, src/trace.ts, src/main.ts (run --record/--replay), tests/replay.test.ts, tests/replayIo.test.ts
update-when: a std entry point starts reading the OS or changing the world, a record kind is added, the framing changes, or a later phase lands
last-verified: 2026-10-06 (phases 1-3: clock, entropy, env, argv; file, socket, DNS, TLS, subprocess, pty and stdin IO; green-scheduler order)
-->

# Record and replay

Any compiled Milo program can record the answers it got from the OS and later run again
on exactly those answers. Run it with `MILO_RECORD=<file>` and every nondeterministic
answer std gets (the clock, entropy, the environment, a file's bytes, a socket's bytes, a
child's exit status, which green task the scheduler woke) is appended to a trace; run it
with `MILO_REPLAY=<file>` and each of those calls returns the recorded answer instead, so
the program computes what it computed when recorded, whatever the files, the network or
the timing now say. No recompile is needed; the variables are read when the process
starts. `milo run --record <file>` and `milo run --replay <file>` are the same thing from
the CLI, and `milo trace <file>` lists what a trace holds.

Design and the phase plan: [plans/stdlib-next-2026-10.md](plans/stdlib-next-2026-10.md)
§Deterministic record/replay. Phases 1-3 are built; phase 4 (dapweb reverse step) builds
on the stop-at-record hook below.

```sh
MILO_RECORD=run.mrr ./server --port 8080      # or: milo run server.milo --record run.mrr --port 8080
MILO_REPLAY=run.mrr ./server                  # same answers, same task interleaving, no network needed
milo trace run.mrr                            # seq, kind, call, payload size per record
MILO_REPLAY=run.mrr MILO_REPLAY_STOP=120 lldb ./server   # stops when record 120 is replayed
```

## What is captured

Each row is a record kind: the `arg` names the call (so replay can tell `env.get(HOME)` from
`env.get(PATH)`, or a read of fd 5 from a read of fd 6), the payload is the answer.

### Phase 1: clock, entropy, environment, argv

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
global initializers). `std/rng` needs nothing: it is a seeded generator, and its seed comes
from the program (or from `Random`, which is recorded).

### Phase 2: IO

Descriptor IO goes through the replay-aware single syscalls in `std/os.milo` (`sysRead`,
`sysWrite`, `sysRecv`, `sysSend`, `sysOpen`, `sysClose`, `sysLseek`, `sysDup`,
`sysSocket`, `sysListen`, `sysAccept`, `sysWaitpid`, `sysKill`, `sysIsatty`), which the
green-aware wrappers (`readFd`, `writeFd`, `recvFd`, `sendFd`, `acceptFd`, `connectFd`)
and every std module below are built on. A read or write is named by what its descriptor
is, which std notes when it opens one: `fs.` for a file, `net.` for a socket, `proc.` for
a child's pipe, `pty.` for a pty master, `stdin.`/`stdout.`/`stderr.` for the inherited
0/1/2, `fd.` for anything else.

| Category | Record kinds | Under replay |
|---|---|---|
| Files (`std/io` File, `std/fs`) | `fs.open` (`flags path` → fd), `fs.read` (`fd len` → `=bytes` or `!errno`), `fs.seek`, `fs.write` (`fd len` → bytes written), `fs.stat`, `fs.lstat`, `fs.access`, `fs.isdir`, `fs.readdir` (name NUL kind per entry), `fs.readlink`, `fs.realpath`, `fs.getcwd`, `fs.mkdtemp`, `fs.mkstemp`; mutations `fs.unlink`, `fs.mkdir`, `fs.rmdir`, `fs.rename`, `fs.link`, `fs.symlink`, `fs.chmod`, `fs.fchmod`, `fs.chown`, `fs.fchown`, `fs.lchown`, `fs.truncate`, `fs.ftruncate`, `fs.fsync`, `fs.fdatasync`, `fs.chdir` (status + errno) | Every answer from the trace, errno restored so `IoError` is the recorded one. **Nothing on disk is touched**: no file is opened, created, written, removed or renamed. A replay is repeatable and side-effect free, which is what running it again and again from a debugger needs. |
| Sockets (`std/net`, `std/http`, `std/unix`, `std/ws`) | `net.socket`, `net.bind` (`fd hex-sockaddr`), `net.listen`, `net.port`, `net.accept`, `net.connect` (`fd hex-sockaddr`), `net.connected` (SO_ERROR), `net.read`, `net.write`, `net.resolve` (hostname → address) | The fds are synthetic: a replayed `TcpStream` or `TcpListener` works with no socket behind it. Sends are recorded by size and suppressed (the peer does not exist); receives come from the trace. A replay needs no network, and a server that was up when recorded may be down. |
| TLS (`std/openssl` helpers used by fetch, tls, ws) | `tls.connect`, `tls.accept`, `tls.read` (the plaintext), `tls.write` (size), `tls.verify` | OpenSSL does its own socket IO, so TLS is recorded above it: no handshake under replay, the plaintext comes from the trace. |
| Subprocesses (`std/process`) | `proc.spawn` (command line → `pid stdin stdout stderr` fds), `proc.read`, `proc.write`, `proc.wait` (`pid options` → `r status errno`), `proc.kill`, `proc.run` (`system`), `proc.getpid` (`capture`'s temp path) | Nothing is forked or signalled; the child's output and exit status come from the trace. |
| Ptys (`std/pty` darwin, linux) | `pty.open` (master fd, slave path), `pty.spawn`, `pty.read`, `pty.write`, `pty.resize`, `pty.winsize`, `fd.isatty` | No pty is opened and nothing forked. |
| stdin | `stdin.read` (`readLine`, `readStdin`, `stdinChannel`, `std/term` key reads) | From the trace; the replay's own stdin is not read. |
| stdout, stderr | `stdout.write`, `stderr.write` (for writes through `writeFd`, e.g. `writeStdout`, `log`) | Performed, so the user sees the output, and checked against the recorded size. |

`print` and `eprint` are not records: they go through C stdio, which is deterministic given
the inputs, and they reach the terminal under replay as they did when recorded.

**Descriptors under replay.** Every fd the trace hands out (a file, socket, pipe end, pty
master, accepted client) is synthetic: the number the recorded run got, with nothing
behind it. std remembers which numbers are synthetic, so `sysClose` forgets one instead of
closing whatever real descriptor shares the number, `setNonblocking` and the event-loop
registration skip them, and every read, write and query on them is answered from the
trace. Code that hands such a number to a raw extern (`unsafe`) gets a meaningless fd,
which is the extern-call hole below.

### Phase 3: scheduling

Given the same inputs the green scheduler (`std/runtime.milo`) is deterministic except for
one thing: what the event-loop poll returns. Which fds came ready, which select timer arms
are past their deadline (real time), and which tasks an OS thread unparked depend on the
outside world. So under either variable each poll goes through `pollAndWakeTraced`, which
records its outcome as a token list and then acts on that list:

| Token | Meaning |
|---|---|
| `f<fd>` | the fd came ready (wakes the task parked on it, and claims select fd arms on it) |
| `t<i>` | the timer node at position `i` of the scheduler's select list is due (claims its arm) |
| `x<n>` | `n` tasks were unparked from another OS thread (a `Promise.blocking` result) |

A poll that woke something is a `sched.pick` record with that list as its payload. Polls
that woke nothing are counted and written as one `sched.idle` record (payload: the count)
before the next record, so a busy-polling scheduler does not flood the trace but replay
still knows exactly which poll each wake belongs to. Under replay the poll never touches
the OS: it takes the next scheduler record and acts on it, so tasks interleave exactly as
recorded. Everything else (the run queue, the wait list, the 32-task batch) follows from
those decisions.

Consequences:

- **Sleeps take no time under replay.** `sleepMs` on a scheduler is a select timer arm,
  and the trace says at which poll it fired; a sleep with no scheduler (and
  `sleepBlockingMs`) returns at once. A program that slept for a minute replays in
  milliseconds.
- **Timers fire in recorded order**, including `Timer`, `Ticker`, `recvTimeout` and
  `waitReadable`, which are select arms.
- **The poll past the end of the trace** is idle (a recording's trailing idle polls are
  never written), but a replay still polling a million times past the end is waiting for
  an event the recording never had, and diverges.

The scheduler's deadline clock (`std/time.milo: unrecordedEpochMillis`) stays unrecorded:
it only feeds the decisions, and the decisions are what is recorded.

### OS threads

Recording and replay cover the main OS thread, which runs `main` and every green task. A
`Promise.blocking` worker's own OS reads go to the OS unrecorded (its hook state is
thread-local and decides "off"), and when its result arrives is real time. Replay makes the
arrival point deterministic where it can: an `x<n>` token makes the replaying scheduler
wait for `n` cross-thread unparks at that poll. The worker's computation is only
reproduced if it is itself deterministic. A program that starts one gets, once, on stderr
under either variable:

```
milo replay: warning: this program starts an OS thread (Promise.blocking); record/replay covers the main thread and its green tasks only, ...
```

## The hook

`std/replay.milo` holds the mode in one thread-local global, decided by a global
initializer at process start (0 undecided, 1 off, 2 recording, 3 replaying). Each hooked
entry point is:

```
if replayOff() { return <ask the OS> }      // one load and compare when off
if replayActive() { return <decode replayTake(kind, arg)> }
let v = <ask the OS>
replayPut(kind, arg, <encode v>)
return v
```

`replayRet` (a number, negative with errno) and `replayBlob` (bytes the caller encodes)
package that shape around a closure, and `replayRead`/`replayWrite`/`replayOpen` are the
descriptor versions. Recording restores errno after writing the record, since the trace
write is a syscall too. A hooked call that runs before std/replay's own initializer
(another module's global initializer reading the clock) finds the mode undecided and
decides it on the spot.

Once read, `MILO_RECORD`, `MILO_REPLAY` and the `MILO_REPLAY_STOP*` variables are removed
from the process's environment: a child process that inherited `MILO_RECORD` would
truncate and interleave into the parent's trace. Only the top process is recorded.

## Overhead when off

One thread-local load and compare per hooked call, against a syscall-sized call it guards.
Measured 2026-10-06 (darwin arm64, -O2, `MILO_RECORD`/`MILO_REPLAY` unset), before and
after phases 2-3, five alternating runs each: 2,000,000 one-byte `FdStream` reads of
`/dev/zero` 557-575 ms before, 559-564 ms after; 50,000 `readFile` plus `pathExists` of
`/etc/hosts` 401-406 ms before, 403-409 ms after. Within run-to-run noise.

## Trace format (version 1)

A header line, then one record per hooked call, appended in call order and never
rewritten:

```
milo-trace 1\n
<seq> <kind> <argLen> <payloadLen>\n<arg bytes>\n<payload bytes>\n
...
```

- `seq` counts from 1 and must match the reader's position; a mismatch is a corrupt trace.
- `kind` is a dotted ASCII name with no spaces (`time.wall`, `net.read`, `sched.pick`).
- `arg` and `payload` are length-prefixed raw bytes, so a payload can be binary and any
  size with no escaping. The trailing newlines are redundant framing that a reader checks,
  and they make a text-only trace readable with `less`.
- Each record is written with one `write` call, unbuffered, so a crash leaves every
  record made before it on disk.
- Replay streams the trace through a window refilled 64 KiB at a time, so memory is
  bounded by the largest record, not the trace.

The version is bumped only when the framing changes. A new kind is additive: an older
replayer meeting it reports a divergence that names the kind.

A trace holds the program's environment, argv, file contents and network traffic
verbatim, secrets included. Treat it like a core dump.

## Divergence

Replay stops the program, prints to stderr and exits with code 3 (`REPLAY_EXIT_CODE`) when:

- the next record is a different call:
  `replay diverged at record 1: expected fs.open(0 a.txt), got fs.open(0 b.txt)`
  (expected is what the trace holds, got is the call the program made);
- the trace has run out: `replay diverged at record N: expected end of trace, got random.u32`;
- a scheduler poll meets a record that is not a scheduler record, or a call meets a
  `sched.idle` the replay still owes polls to;
- **the program exits with records left over**: `replay diverged at record N: expected
  fs.open(0 a.txt), got end of program (6 records not replayed)`, checked by an atexit
  hook at any normal exit (a return from `main` or `exit()`), after stdout is flushed;
- the trace is missing, not a `milo-trace 1` file, or corrupt, or both variables are set.

Every divergence report after the first line lists the last records replayed:

```
replay diverged at record 7: expected fs.open(0 a.txt), got end of program (6 records not replayed)
last records replayed:
  1 fs.open(0 a.txt) -> 1 bytes
  2 fs.seek(4 0 1) -> 1 bytes
  3 fs.seek(4 0 2) -> 1 bytes
  4 fs.seek(4 0 0) -> 1 bytes
  5 fs.seek(4 0 0) -> 1 bytes
  6 fs.read(4 4) -> 5 bytes
```

(A program that read `a.txt` twice when recorded, replayed by one that reads it once.)

Recording exits with code 3 if the trace cannot be created or written.

## Stopping at a record

`MILO_REPLAY_STOP=<N>` makes replay call `miloReplayStop(N)` right after consuming record
N, so the replaying program is stopped with record N's call just answered and the call
that made it on the stack. `miloReplayStop` has external linkage, so a debugger can break
on it by name (`b miloReplayStop`); it then raises SIGTRAP (`DebugBreak` on Windows), so a
debugger attached without that breakpoint stops there too, and a run with no debugger ends
with SIGTRAP. `MILO_REPLAY_STOP_PRINT=1` prints `replay: stop at record N: <call>` to
stderr instead and lets the replay run on (for tests, and for a UI that only wants the
position).

This is the primitive for dapweb's reverse step: to step back from record N, re-run the
program under replay with `MILO_REPLAY_STOP=N-1` and the debugger attached. Every run
answers every call identically, so record N-1 is reached in the same program state each
time.

## `milo trace`

```
milo trace run.mrr                     # seq, kind, call argument (60 chars), payload size
milo trace run.mrr --kind net.         # only kinds starting with net.
milo trace run.mrr --json              # {version, total, records: [{seq, kind, arg, payloadLen, offset}]}
milo trace run.mrr --payload 42        # record 42's payload bytes on stdout
```

It streams the file and skips payloads, so a large trace lists in constant memory;
`offset` is the byte position of the record's header line, for a UI that wants to read a
payload itself. `src/trace.ts`.

## Not captured

- **Raw extern calls bypass the hook.** Anything a program or package reaches through
  `extern fn` (in `unsafe`, see the `extern-call` warning) is invisible to the trace:
  `localtime_r`, `getenv`, `read` or `socket` called directly, OpenSSL's own entropy. The
  `unsafe` requirement is what makes those holes listable. Under replay such a call also
  runs for real, against synthetic descriptor numbers.
- **Signals.** `std/signal`'s self-pipe is real under replay and signal arrival is not
  recorded.
- **Windows subprocesses and ptys** (`std/process.windows.milo`, `std/pty.windows.milo`)
  are not hooked; on Windows a replay spawns for real.
- Local configuration calls are not records: `setsockopt`, `tcgetattr`/`tcsetattr`
  (`std/term` raw mode still changes the real terminal under replay), `fcntl` flags.
- `std/sysinfo` (uptime, hostname, memory, CPU counts) and `getpid` outside `capture`.
- **Simulation** (seeded scheduler, simulated clock and network, many seeds): phase 5.
- Traces are platform-specific: `random.uniform` exists only on darwin, and record kinds
  carry platform values (open flags, sockaddr bytes, errno numbers).

## Tests

`tests/replay.test.ts` (phase 1): records a program touching every phase 1 source,
replays it with a different environment, argv, timezone and a later clock, and asserts
byte-identical stdout; the same through `milo run --record/--replay`; divergence on call
order, on a call's argument and on trace exhaustion; refusal of missing, foreign and
doubly-requested traces; live behavior with neither variable set; the OS-thread warning;
HashMap order fixed under record and replay and entropy-seeded otherwise.

`tests/replayIo.test.ts` (phases 2-3): a program that reads a file, serves HTTP on a green
task and fetches from it, fetches from an outside server, runs a subprocess and
interleaves three green tasks on sleeps and a channel; replayed with the file rewritten,
then deleted, the outside server stopped and the child's environment changed, it prints
the recording byte for byte. Also: `milo trace` listing, kind filter and payload dump;
replay of a sleeping program at under half the recording's wall time; divergence when the
program reads a different file; unconsumed records at exit; `MILO_REPLAY_STOP` in print
mode, in trap mode (SIGTRAP after the first read's output) and under lldb (breakpoint on
`miloReplayStop`, caller `noteConsumed`); file writes recorded by size and not performed.
Each mechanism was checked by disabling it: replay ignoring `sched.pick` fails the scenario
and the sleep test, a replay read that asks the OS fails the scenario, and no exit check
fails the unconsumed-records test.
