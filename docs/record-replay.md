<!-- doc-meta
system: record-replay
purpose: deterministic record/replay of a program's nondeterministic inputs: what is captured, how replay answers it, scheduling, extern calls and the extern catalog, OS threads, addresses, holes, the trace format, divergence, stopping at a record, `milo trace`
key-files: std/replay.milo, std/os.milo (sys* calls), std/sync.milo (thread ordering), std/runtime.milo (pollAndWakeTraced, stacks), src/extern-effects.ts (catalog), src/replay-externs.ts (wrappers), src/checker.ts (redirectForReplay), src/lower.ts, src/codegen.ts (engine scope, heap calls), src/trace.ts, tests/replay.test.ts, tests/replayIo.test.ts, tests/replayExterns.test.ts, tests/externEffects.test.ts
update-when: a std entry point starts reading the OS or changing the world, std declares a new extern, a record kind is added, the framing changes, or a later phase lands
last-verified: 2026-10-06 (phases 1-4: clock, entropy, env, argv; file, socket, DNS, TLS, subprocess, pty and stdin IO; green-scheduler order; extern calls, OS threads, addresses, holes)
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
§Deterministic record/replay. Phases 1-4 are built. Phase 4 closed the gaps: every extern
call is recorded by the compiler from a catalog or an `@records` attribute, OS threads
are recorded and replayed in their recorded interleaving, addresses replay as well as
values, and whatever still cannot be recorded is a reported hole, never a silent one.

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
trace. A raw extern call on such a number is recorded too (§Phase 4: extern calls), so
under replay it is answered from the trace rather than made against a meaningless fd.

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

### Phase 4: extern calls

Anything a program reaches through `extern fn` (in `unsafe`, or an `extern-call` warning)
used to bypass the trace. Now the compiler records it. For every extern a program calls
from code that does not record its own calls, `src/replay-externs.ts` generates a Milo
wrapper, and the checker sends the call there (`redirectForReplay`); std's own recording
functions (`sys*`, the `*Live` halves of the hooks, std/replay and the runtime under it)
are marked `@replayHooked` / `@!replayHooked` and keep calling C directly. A wrapper:

- with neither variable set, is skipped: the call site tests std/replay's mode word and
  calls the extern directly, one load and compare;
- recording, makes the call, then appends an `x.<name>` record: the arg is the scalar
  arguments and the contents of the pointer arguments that name the call (a path), the
  payload is the return value, errno and every buffer the call wrote;
- replaying, does not make the call: it takes the record, copies the bytes back into the
  caller's buffers, restores errno and returns the recorded value.

What a call writes comes from one of three places:

| Source | Covers | Example |
|---|---|---|
| The extern catalog, `src/extern-effects.ts` | every extern std declares, on darwin, linux and windows | `read` writes `buf[ret]`, `stat` writes `buf[sizeof(struct stat)]`, `getcwd` writes `buf[cstr:size]` and returns `buf` |
| `@records(...)` on the declaration | a program's own externs | `@records("buf[cstr:len]") extern fn confstr(name: i32, buf: *u8, len: i64): i64` |
| The signature | an extern with only scalar params and return, not `@pure` | `extern fn getpid(): i32` is recorded by its return value |

**The catalog.** One entry per extern std declares (rr keeps the same table for Linux
syscalls), built from the man pages and Microsoft's Win32 reference: its effect
(`pure` and `local` are left alone; `input` and `effect` are recorded, and under replay
neither is performed, so a replay touches nothing; `sync`, `sched` and `hole` are holes
outside std), each output buffer and its size, how a pointer return replays (`cstr`,
`handle`, `param:<p>`, `static:<size>`), which pointer params name the call, the errno
channel and the variadic tail. C type sizes per target live next to it.
`tests/externEffects.test.ts` fails when std declares an extern the catalog does not
describe (listing them), when an entry describes nothing std declares, and when a
description does not turn into a wrapper on a target it is declared for. SQLite, for
one, is fully recorded this way: every `sqlite3_*` call is answered from the trace, so a
replay needs no database file, and its handles are synthetic like descriptors.

**`@records`.** The same output grammar as the catalog, one string per buffer:
`buf[len]` (a param), `buf[ret]`, `buf[16]`, `buf[8*ret]`, `buf[*lenp]` (the count an
integer param points at), `buf[cstr]` / `buf[cstr:len]`, and `ret[cstr]` for a returned
string. With no arguments only the return value is recorded. See
[language-reference.md](language-reference.md) §Extern calls under record/replay.

### Holes

An extern that cannot be recorded by copying bytes is a hole: one that takes or returns
a pointer and has neither a catalog entry nor `@records`, a catalog `hole` (`fork`, the
`exec*` family, `dlopen`/`dlsym`, `getaddrinfo`, `ioctl`), a raw lock or event-loop
primitive used outside std, and a catalog description that names a param the program's
own redeclaration of the extern does not have. A hole is never silent:

- **At compile time**: `milo check --replay-holes` (and `build`) lists every call site as
  warning `replay-hole`; `--deny=replay-hole` fails the build. Off by default, because it
  only matters to a program that is recorded.
- **At run time**: the first call to each one in a recorded run prints, once,
  `replay: this run called unrecorded uname at x.milo:19; a replay may diverge`, and
  writes a `trace.hole` record (arg the name, payload where), which `milo trace` reports
  (`hole: ...` lines, `holes` in `--json`). The call itself runs for real, recorded or
  replayed.
- **std is held to it**: `tests/externEffects.test.ts` checks every std module on each
  target with `--replay-holes` and allows only `dlopen` and `dlsym` (std/dl), whose loaded
  code is invisible by nature.

### Phase 4: OS threads

One trace serves every OS thread. A thread std starts (`Promise.blocking`, std/shard) is
numbered when its parent records `thread.spawn`, so the numbering replays, and every
record a thread makes names it after its kind: `fs.read@2`. The trace order is the order
the records were made, under std/replay's lock. Under replay a thread answers its next
call only when the record at the head of the trace is its own, so each thread gets the
answers it got when recorded, in the same interleaving with the others; its own std OS
calls are recorded and replayed on it like the main thread's.

Safe Milo shares memory between threads only through std/sync, so ordering std/sync is
ordering everything a safe program can observe. Once a recorded or replayed program has
started a thread, every look a primitive's operation takes at its state under its lock
is a `sync.*` record with the outcome in the arg: a channel send, receive, `trySend`,
`tryRecv`, `len`, `close` and Select arm finding the queue ready or not; a WaitGroup's
count; a `Once`'s state; and each atomic operation's returned value (`sync.atomic.add`).
Recording writes the record while the primitive's lock is held (an atomic runs inside the
trace lock), so the record order is the order the operations really took effect in.
Replay keeps it: a thread waits for its turn before taking a primitive's lock, never
while holding one, and never sleeps on a condition variable, because the wakeup it would
wait for is itself a later turn. A different outcome under replay is a divergence. The
cross-thread unpark a `Promise.blocking` result does (an `x<n>` scheduler token) waits
for the real unpark as before, which the ordering now makes deterministic.

A thread whose closure shares memory through `unsafe` (it captures a value of a user type
that carries a raw pointer and vouched for itself with `unsafe impl Send`, or its body
has an `unsafe` block) is a hole: listed under `--replay-holes`, and reported as
`unsafe shared memory` when the thread starts in a recorded run. A replay that waits on a
thread that has finished reports the divergence instead of hanging.

std has no `Mutex` or thread type; OS threads come from `Promise.blocking` (and std/shard
on top of it), and a one-slot `Channel` carrying the protected value is the lock
(tests/replayExterns.test.ts uses one).

### Phase 4: addresses

Values replay; addresses have to be made to. Under either variable:

1. **ASLR off.** A process cannot turn ASLR off for itself once it runs, so std/replay
   (`miloReplayStart`, which `main` calls before any global initializer) restarts the
   program once, in place: on darwin `posix_spawn` with `POSIX_SPAWN_SETEXEC |
   _POSIX_SPAWN_DISABLE_ASLR` (what lldb launches with), on linux
   `personality(ADDR_NO_RANDOMIZE)` and `execve("/proc/self/exe")` (what gdb does). An
   environment marker makes it happen once; a process a debugger traces is left as the
   debugger launched it. If the restart fails the run says so (`could not restart with
   ASLR off; addresses may differ`). Windows has no per-process switch (ASLR is per image),
   so there the restart and the heap below are not done.
2. **A fixed-address heap.** libc's malloc places its regions at random even with ASLR
   off, and the engine's own allocations differ between recording and replaying. So every
   allocation Milo code makes (`malloc`, `realloc` and `free` in all generated code and
   std) goes through std/replay's allocator, served from 16 regions at a fixed address
   (0x200000000000, 8 GiB each, mapped on first use, one per thread number, size-class
   free lists), and green-task stacks come from the top of the same regions. The engine
   (std/replay, every recording hook, every generated wrapper) runs with a per-context
   depth raised, and its allocations go to libc's malloc, so the program's heap is shaped
   by the program's own allocations alone. Values a hooked call returns (the environment
   string, a recorded file's bytes) are allocated by the engine and live in libc's heap.
   With neither variable set the three entry points are one compare in front of libc,
   declared an allocation family so LLVM still removes allocations that never escape.

So a program that prints a pointer, hashes by address or sorts by it replays the same:
globals, heap blocks and green-task stack locals print the same addresses under record
and under replay, outside a debugger (tests/replayExterns.test.ts). Not covered: memory
libc or a C library allocates for itself, the stacks of OS threads, and a block one
thread frees for another (its reuse timing is not ordered).

## The hook

`std/replay.milo` holds the mode in one global, decided at process start (0 undecided,
1 off, 2 recording, 3 replaying) and never changed after; everything else the trace needs
is shared by all threads and written only inside its lock (`ReplayLock.run`, a spin lock
the checker's thread pass knows as `@synchronized`). Each hooked entry point is:

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

One compare against a syscall-sized call it guards, per hooked call; per extern call, a
load and compare at the call site; per allocation, a load and compare in std/replay's
allocator, which LLVM still treats as an allocation family. Measured 2026-10-06 (darwin
arm64, default `milo build` -O2, `MILO_RECORD`/`MILO_REPLAY` unset), the main checkout
against phase 4, five alternating runs each, fastest four shown:

| Loop | before (ms) | phase 4 (ms) |
|---|---|---|
| 40M extern calls (`getppid`, uncatalogued `strtol`) | 1458-1467 | 1467-1473 |
| 2 OS threads ping-pong 200k channel messages, an atomic per hop | 420-424 | 430-432 |
| 5M short-lived strings and two-element Vecs | 349-364 | 358-364 |

Within a percent or two. Phases 2-3 (earlier): 2,000,000 one-byte `FdStream` reads of
`/dev/zero` 557-575 ms before, 559-564 ms after; 50,000 `readFile` plus `pathExists` of
`/etc/hosts` 401-406 ms before, 403-409 ms after.

## Trace format (version 1)

A header line, then one record per hooked call, appended in call order and never
rewritten:

```
milo-trace 1\n
<seq> <kind>[@<thread>] <argLen> <payloadLen>\n<arg bytes>\n<payload bytes>\n
...
```

- `seq` counts from 1 and must match the reader's position; a mismatch is a corrupt trace.
- `kind` is a dotted ASCII name with no spaces (`time.wall`, `net.read`, `sched.pick`).
  A record made on an OS thread other than the main one names it after the kind:
  `fs.read@2` (thread numbers come from `thread.spawn` records). The framing did not
  change, so readers of it (dapweb's timeline) keep working; one that does not know
  threads shows the suffixed kind.
- `arg` and `payload` are length-prefixed raw bytes, so a payload can be binary and any
  size with no escaping. The trailing newlines are redundant framing that a reader checks,
  and they make a text-only trace readable with `less`.
- Each record is written with one `write` call, unbuffered, so a crash leaves every
  record made before it on disk.
- Replay streams the trace through a window refilled 64 KiB at a time, so memory is
  bounded by the largest record, not the trace.

Phase 4 kinds: `x.<extern>` (payload `<ret> <errno> <len>...` then the output bytes),
`thread.spawn`, `sync.<op>` (outcome in the arg), `sync.atomic.<op>`, `trace.hole`.

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
milo trace run.mrr --json              # {version, total, holes, records: [{seq, kind, arg, payloadLen, thread, offset}]}
milo trace run.mrr --payload 42        # record 42's payload bytes on stdout
```

It streams the file and skips payloads, so a large trace lists in constant memory;
`offset` is the byte position of the record's header line, for a UI that wants to read a
payload itself. A record made on another OS thread shows its number (`t2`), and a trace
with holes ends with one `hole: this run called unrecorded <name> at <where> (record N)`
line per hole. `src/trace.ts`.

## Not captured

Everything below is reported, not silent, except where it says otherwise.

- **Holes** (above): externs nothing describes, the catalog's `hole` entries, raw locks
  and event-loop calls outside std, `unsafe` memory shared with a thread. Reported at
  compile time on request and once per recorded run.
- **Signals.** `std/signal`'s self-pipe is real under replay and signal arrival is not
  recorded (not reported).
- **Windows**: the subprocess and pty calls are now recorded through the catalog, but
  there is no ASLR restart or fixed-address heap, std's Windows POSIX shims
  (`std/platform.windows.milo`) are Milo functions, so a program calling one of them
  directly bypasses the catalog, and std/dl's loader calls are not listed as holes there.
  Not exercised end to end: a std program that touches std/os does not link for Windows
  today (`waitpid` and `kill` referenced from std/os closures), before and after phase 4.
- **Addresses** not covered (see §addresses): libc's own allocations, OS-thread stacks,
  cross-thread frees.
- **std internal locks** (a DNS cache in std/net, arena identity) are not ordered between
  threads; their order does not reach a program's output.
- **Simulation** (seeded scheduler, simulated clock and network, many seeds): phase 5.
- Traces are platform-specific: `random.uniform` exists only on darwin, and record kinds
  carry platform values (open flags, sockaddr bytes, errno numbers, struct layouts).

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

`tests/replayExterns.test.ts` (phase 4): a program with its own externs (scalar `getpid`
and `clock`, catalogued `gethostname`, `@records` `confstr`, undescribed `uname`) replays
its recording byte for byte, and prints the hostname and confstr bytes a hand-edited
trace holds, so they come from the trace; `--replay-holes` lists exactly the `uname`
calls, `--deny=replay-hole` fails, and a recorded run reports `uname` once and
`milo trace` shows the hole; four OS threads contending on a channel lock and an atomic
print in a different order on unrecorded runs and replay byte-identically 20 times;
`Promise.blocking` workers reading a file and the environment replay with the file
deleted, their records tagged with their threads; a program printing global, heap,
HashMap-value, linked-node and green-stack addresses replays them identically (and two
recordings agree); a thread closure sharing unsafe memory is listed and reported.
`tests/externEffects.test.ts`: catalog completeness and no stale entries, every
description generates a wrapper on every target, and std's own holes per target are
exactly the documented ones. Checked by disabling: ordering off in std/sync fails the
threads test; the checker not redirecting extern calls fails the own-externs test; no
ASLR restart fails the addresses test (the global's address moves); no fixed heap fails
it too (every heap address moves); a std module losing `@!replayHooked` fails the
std-holes gate.
