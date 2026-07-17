# Milo Roadmap

## Completed

### Core Language

The foundation is complete: primitive types, let/var bindings, if/else, while/for loops, functions, structs, enums with pattern matching (exhaustiveness checked), generics with monomorphization and type inference, move semantics with use-after-move detection, second-class references (`&T`/`&mut T` in params only), closures (including escaping/move closures), traits with static dispatch and `@derive(Eq)`, operator overloading via traits, `Heap<T>`, `Option<T>`, `Result<T,E>` with `!`/`?`/`??` operators, string interpolation, bitwise operators, hex/binary literals, type casts, for-in loops over ranges/Vec/array/string/HashMap, HIR-based typed IR, and Go-style interfaces with structural typing and vtable-based dynamic dispatch.

### Type System & Safety

- **Ownership**: single-owner move semantics, compiler-tracked drops, no GC
- **Null safety**: `Option<T>` — no null pointers in safe code
- **Race safety**: `Send`/`Sync` traits — compiler rejects data races at `spawn()` boundaries
- **Overflow safety**: compile-time range checks + debug-mode traps via LLVM overflow intrinsics
- **No implicit coercion**: explicit `as` casts only
- **Ranged integers (L1+L2)**: `type Altitude = i32(0..50000)` with range propagation through arithmetic

### Concurrency

Green-tier concurrency with one OS-thread escape hatch:

- **Green threads** (`std/runtime`): stackful coroutines via ucontext (64KB stacks, guard pages, kqueue/epoll), cooperative scheduling, transparent async I/O — `stream.recv()`/`stream.send()` auto-yield on EAGAIN
- **Promises** (`std/runtime`): `Promise<T>.run()`, `.await()`, `Promise.all()`, `Promise.race()` — structured concurrency over green threads
- **Task API** (`std/runtime`): `Task.spawn()` for fire-and-forget lightweight concurrency
- **`Promise.blocking()`** (`std/runtime`): the one OS-thread escape hatch — CPU-bound work or blocking FFI, `Send`-checked captures, result via `await`
- **Synchronization** (`std/sync`): `Channel<T>` (bounded FIFO, multi-producer, blocking + non-blocking), `WaitGroup`, `select`, `AtomicI64`, `AtomicBool`
- **No async/await**: write normal blocking code — it yields automatically in green thread context
- Public `Thread`/`Mutex`/`RwLock`/`parallel` removed 2026-07-10 (green-tier only; re-add on demand — see concurrency-simplification.md)

### Standard Library (44 modules)

I/O & system: io, fs, path, env, args, process, signal
Networking: net, http, url
Data: json, csv, toml, base64, hex, sqlite, arena, set
Concurrency: thread, sync, runtime, event
Strings: string, fmt, strconv, unicode, regex
Math: math, random, sort
CLI: argparse, color, log
Crypto: crypto
Time: time, datetime, uuid
Testing: testing
Memory: mem

### Developer Experience

- **LSP server**: diagnostics, hover, go-to-definition, completions, code lens
- **VS Code extension**: syntax highlighting + LSP client
- **Formatter** (`milo-fmt`): context-sensitive formatting, LSP integration (written in Milo)
- **Package manager** (`milo-pkg`): init, new, add, install, git-based cache with lockfile (written in Milo)
- **Test framework**: `@expect:`/`@error:` annotations, `milo test` runner
- **Example apps**: web servers (7), CLI tools (jq, grep, rg, cat, wc, tree, calc, hex, timeout, fmt)
- **GitHub Actions CI**: build + test on push/PR, release pipeline
- **Playground**: browser-based compiler via JS backend (in progress)

### Self-Hosting — Bootstrap Converges

`milo0` (`src-milo/`, ~8.2K lines) — the Milo compiler written in Milo — compiles its own source and reaches a **byte-identical fixed point at the production `-O2` level**: `stage1 == stage2 == stage3`, 157K-line IR identical. Manifest-wide, 212/339 fixtures emit byte-identical IR between stage1 and stage2, zero divergences. See **[docs/self-hosting.md](self-hosting.md)** for the full milestone log (M0–M5) and the eight oracle miscompiles the self-compile exposed and fixed.

Reproduce: `sh scripts/selfhost.sh` (builds stage1 via the oracle — required; `.selfhost/milo-self.bin` is gitignored), then `bun test tests/selfhost.test.ts`.

Remaining (M6, incremental): grow the manifest toward full fixture parity. Expected gaps are the constructs bootstrap doesn't need — closures, user generics, traits beyond `impl Clone`, threads/green-runtime.

---

## In Progress

### Self-Hosting — Stage-1

Blocking full milo0-on-milo0:

- [ ] `Vec<T>` in milo0 — 84 use sites, biggest blocker
- [ ] `String.push` in milo0 — needs mutation-through-self + realloc
- [ ] Port type checker, HIR, lower, codegen to Milo

End goal: compiler compiles itself, producing equivalent IR for the full Milo source set.

---

## Planned

### Runtime Maturity — `node-milo`

`node-milo` is the current stress test for Milo as an implementation language. If a missing feature keeps runtime logic in C++ or forces raw pointer arithmetic in Milo, it moves up the roadmap.

- [ ] Move more `internalBinding()` implementations out of C++ and into Milo
- [ ] Track success by Node compat %, shrinking C++ glue, and keeping `unsafe` contained to binding seams
- [ ] **V8 C API wrapper — eliminate bridge/*.cpp entirely**. Currently `bridge/core.cpp`, `bridge/fs.cpp`, `bridge/timers.cpp` (1235 lines of C++) exist solely because V8 has no C API — every binding must extract V8 args and return V8 values through C++ types (`FunctionCallbackInfo<Value>&`, `HandleScope`, etc.). The fix: write a single `v8_c_api.cpp` that wraps V8's C++ API in `extern "C"` functions (`v8c_get_string_arg`, `v8c_return_int`, `v8c_throw_error`, etc.), then `declare` those in Milo and move all binding orchestration into `.milo` files. This collapses the three-layer architecture (JS → C++ glue → Milo) into two layers (JS → Milo via V8 C wrapper). For reference, even bun (which uses JSC's C API from Zig/Rust) still has 153K lines of C++ — our 1.2K line bridge is already thin, but eliminating it makes the codebase purely Milo + one mechanical C wrapper.

### Safety Hardening

**Fixed 2026-07-16 — `string.push(65)` needed an explicit `as u8`.** The arg was checked
with no expected type, so an int literal inferred i64 and then failed a u8 equality check;
`Vec.push` had always hinted its arg. Nothing else loosens: an out-of-range literal is
rejected by the coercion ("integer literal 300 overflows u8"), and a real i64 value is still
refused (`tests/errors/stringPushI64.milo`) — silently truncating that is the opposite of
the point.

**Fixed 2026-07-16 — signal self-pipes were a single global, cross-wiring any program that
armed two signals.** `_sigPipeW` was one `i32`, so installing a second signal re-pointed the
shared handler at the second pipe: raising SIGWINCH made **SIGCHLD's** fd readable while the
resize fd stayed empty — a resize delivered as a child exit, silently. It survived because
nothing had ever armed two at once; `timeout` arming SIGCHLD while `splitPty` arms SIGWINCH
is what made the pair reachable. Now one write-end per signal, and the shared handler picks
the pipe from its argument (the only input a C handler gets). Out-of-range signals are
rejected instead of indexing off the table. `tests/fixtures/signalTwoPipes.milo` asserts both
directions — each signal hits its own pipe and only its own.

**Shipped 2026-07-16 — `timeout` waits on an event, not a 50ms poll.** Its loop was
`waitpid(pid, status, WNOHANG)` + `sleepMs(50)` — the last genuine I/O poll in the tree. Now
a `Select` over the SIGCHLD self-pipe fd and the deadline. Behaviour is identical (verified
case-by-case against the pre-change binary: exit code, timeout=124 in 1.04s not 5s,
`-k`, and signal-death — which returns 0 both before and after, because the child exits
*normally* after `system()` returns). Three hazards the conversion has to handle, all
documented at the call site: fd arms need a scheduler even with no green tasks
(`schedulerEnsureInit()`); the pipe must be installed BEFORE `fork` or a fast child's exit
is missed; and the handler plus its pipe write-end are **inherited across fork**, so the
child calls `resetSignal(sigchld())` before `system()` — otherwise its grandchild's exit
wakes the parent for the wrong death.

**Fixed 2026-07-16 — a timer-only main-context `Select` spun forever (regression from the
same day's C1 fix).** The main wait loop polls the scheduler and re-checks the claim, but
`_schedulerRunOnce` returns early when `numTasks == 0` and only polls the event loop while
tasks remain. Select arms don't live on the task list — fd/timer arms hang off `sSelFdHead`
and are claimed by `_pollAndWake` — so once the last green task finished, the poll became a
no-op and the loop spun. Before C1 this returned `-1` immediately: wrong, but it terminated.
`_schedulerPollMainSelect` now polls the event loop directly when nothing is runnable
(`_selMinTimeout` bounds the sleep, so it blocks rather than busy-spins). Caught by building
the child-exit arm, not by the suite — `selectMainContext.milo` misses it because its task is
still alive when the claim lands. `tests/fixtures/selectTimerMain.milo` pins it.

**Shipped 2026-07-16 — child-exit `Select` arm.** No new API: `installSignalPipe(sigchld())`
+ `sel.onRead(fd)` + `waitpid(pid, buf, WNOHANG)`. The pieces just never existed at once —
SIGCHLD landed the same day, and WNOHANG is 1 on both platforms (verified). Unblocks the
event-driven `timeout` rewrite. See `tests/fixtures/selectChildExit.milo`.

**Shipped 2026-07-16 — a `Promise` can be armed in a `Select` (`p.channel()`).** The two
concurrency tiers didn't compose: `Promise` runs work on an OS thread, `Select` waits on the
green event loop, and an event-driven `timeout` wanted to bridge them. `Promise` always held
a `Channel<T>`; nothing exposed it. Handing it out is safe because `Channel<T>` is a single
`*u8` and therefore an implicitly Copy handle — it needs no `clone()`, and `let a = ch; let
b = ch` already alias (the old blocker checked for a `@copy` attribute rather than the
property). `await()` still owns the fetch.

That needed a third wait tier. With no scheduler (a main using only `Promise.blocking`)
there is nothing to park on and nothing to poll, so `SelectState` gained a condvar that a
foreign pthread's claim signals — the same ladder channels already use. **Timer and fd arms
are inert without a scheduler** (they need the poll loop), so `onTimeout` is not a safety
net there; `wait()` returns -1 for a select whose arms are all inert rather than blocking on
a wake that can never come, and mixed arms are not rescued. Documented at the top of
`std/select.milo`.

**Fixed 2026-07-16 — `Select.wait()` returned `-1` instead of the winning arm on the main
context.** `schedulerCurrent()` is 0 there, so `schedulerPark()` no-opped and the unclaimed
`-1` fell straight through — select still woke at the right moment, so callers just couldn't
tell which arm fired and the demos drained every arm to compensate. Main now takes the shape
channels already use (`_schedulerPollMain`): it can't park, because nobody else would drive
the scheduler, so it polls a bounded tick and re-checks the claim. Green tasks still park.
`tests/fixtures/selectMainContext.milo` pins the arm index (a 5s timeout arm makes a stalled
poll fail on the index rather than hang the suite).

**Fixed 2026-07-16 — a closure's expected return type was never propagated.** Param hints
were, but not the return, so an un-annotated `() => 0` always inferred i64 and
`opt.unwrapOrElse(() => 0)` on an `Option<i32>` failed with "callback must return i32, got
i64". The caller's expected return now seeds the closure's body context (an explicit
annotation still wins; an `unknown` hint, as Vec.map gives, still infers from the body).
Caught by the language-reference doc test, which type-checks every `milo` block.

**Shipped 2026-07-16 — `Option.map` / `Option.unwrapOrElse`.** Both lower through `OptionOp`
with a real branch rather than the `select` that `unwrapOr` uses: `select` evaluates both
arms, so the callback would run even when it shouldn't — defeating the point of each. `map`
builds its result enum via `monomorphizeEnum("Option", [U])`, so `U` need not equal `T`
(`Option<i64>.map(n => n > 5)` gives `Option<bool>`). `map` takes the payload by `&T`, which
is why it needs no Copy gate, unlike `unwrapOr`/`unwrapOrElse` which load the payload out —
nothing is moved out of the receiver, so an owned inner can't gain a second owner. Fixtures
`optionMap.milo` / `optionUnwrapOrElse.milo` pin laziness via output ordering and cover the
non-Copy (`Option<string>`) case.

**Fixed 2026-07-16 — `std/signal.onSignal` handed its handler a garbage signal number.**
It took `handler: (i32) => void`, i.e. a closure, whose code pointer takes `(env, sig)`. A C
signal handler has no user-data slot, so `signal()` called it with the signal number in the
env slot and the handler read garbage as its `sig` (1794499728 instead of 20). Nothing
caught it because the only in-tree handler, `_sigPipeHandler`, ignores its argument — so
SIGWINCH via `installSignalPipe` worked and the doc comment "Handler receives the signal
number" stayed false. Now takes a raw `*u8` fn pointer. Also added `SIGCHLD` — the one
signal here whose number differs per platform (20 darwin / 17 linux, both verified against
the real headers), so it lives in the `std/platform` split; `tests/fixtures/signalSigchld.milo`
asserts it by raising the signal rather than restating the number.

**Fixed 2026-07-16 — variadic externs declared with the wrong fixed arity miscompiled
silently.** A libc fn like `fcntl(int, int, ...)` declared as `extern fn fcntl(fd, cmd, arg)`
compiles clean and calls with the wrong ABI: AArch64 passes variadic args on the stack while
a fixed-arity call puts them in registers, so the callee reads garbage. x86_64 hides it (the
conventions agree for integer args). node-milo lost hours to exactly this — `O_NONBLOCK`
never landed, so every socket stayed blocking and it presented as a throughput mystery.
The checker now compares each extern against libc's real fixed-param count
(`checkVariadicExtern`). It immediately found a live one in **our own std**: `execl` was
declared with 1 fixed param but C fixes 2 (`path`, `arg0`), so `std/process.spawn` handed
every child a garbage `argv[0]` and shifted the real one to `argv[1]` — observable as
`/bin/echo` echoing its own path. Covered by `tests/errors/variadicExternFixedArity.milo`.

**Fixed 2026-07-16 — `std/net` + `std/ws` TLS clients verified no certificates.** Both
called `SSL_CTX_set_default_verify_paths` and stopped: that loads the trust store but an
OpenSSL client defaults to `SSL_VERIFY_NONE`, so it was never consulted. A self-signed
cert that `openssl s_client` rejects handshook fine, and an attacker's cert for any host
satisfied `wss://` — a MITM was undetectable. Loading the CA store *looked* like
verification, which is why it survived. Now: `SSL_VERIFY_PEER` + `SSL_set1_host`
(hostname binding — SNI selects the server's cert, it verifies nothing) +
`SSL_get_verify_result`. Covered by `tests/tlsVerify.test.ts`, whose hostname case holds
the chain valid so it can only fail on the hostname.

See **[docs/safety-roadmap.md](safety-roadmap.md)** for the full plan. Summary:

1. `unsafe` blocks — quarantine FFI and low-level code behind a grep target
2. Flow-sensitive invalidation tracking — catch aliased mutation at compile time (ref-while-frozen, use-after-invalidate, arena scope tainting)
3. Interprocedural exclusivity — reject aliasing `&var` + `&` at call sites, purity inference, arena lifetime scoping
4. Dynamic fallback — debug ref counting and sanitizer mode for patterns static analysis can't reach
5. Safety profiles — `default`, `strict` (aircraft-grade), `performance`
### Language

Runtime pressure from `node-milo` changes the order here: binary data and FFI safety land before more expressive abstractions.

- [x] ~~**Safe extern call expansion**~~ — extern calls no longer need `unsafe` when all args are safely coerced (string→`*u8`, array→`*T`, `*T`→`*T`, `fn`→fn ptr) and return is scalar/void. Dramatically reduces `unsafe` in FFI code.
- [x] ~~**`string.cstr()` builtin**~~ — returns `*u8` data pointer without `unsafe`. Replaces `_strDataPtr` intrinsic for ergonomic C string interop.
- [x] ~~**Opaque foreign handle types**~~ — `extern type sqlite3`, `extern type SSL` — opaque types that can only exist behind `*T`. Prevents handle mixups between different FFI types. No LLVM layout emitted.
- [x] ~~**Pointer-to-struct field access**~~ — `ptr.field` auto-derefs `*Struct` for field access (requires `unsafe`). Eliminates manual byte-offset pointer arithmetic for C struct access.
- [x] ~~**Typed function pointers in extern decls**~~ — extern fns accept `(*u8, *u8) => i32` params directly. Passing a Milo function no longer needs `as *u8` cast.
- [x] ~~**CStr stdlib**~~ — `std/cstr.milo` provides `CStr.wrap(ptr)`, `.toString()`, `.byte(i)`, `.eq()` for safe NUL-terminated C string access.
- [ ] **Unused import warnings** — compiler should warn (or error) on imported symbols that are never used in the module. Currently `main.milo` imports all binding symbols just so they link, but ideally re-exports or `pub` declarations in binding modules would handle this without polluting the import list.
- [ ] **Borrowed slices / byte views** — `&[T]` / `&mut [T]`, with slicing generalized beyond `string`. Unblocks offset/length I/O, `Buffer`/`ArrayBuffer` interop, and zero-copy protocol parsing.
- [ ] **C ABI / layout control** — packed structs, alignment control. `extern struct` and `sizeOf`/`offsetOf` already work.
- [x] ~~**`@cLayout` — extern struct layout verification**~~ — a declared `extern struct` layout was taken on faith; a wrong offset silently read the neighbouring field and returned plausible garbage. `@cLayout("struct timespec", "time.h")` now emits a throwaway C TU asserting each field's `offsetof` **and** `sizeof` against the real header, compiles it with the system `cc` at build, and discards it. Size checked `>=` so prefix decls stay legal; skipped for bare-metal. Opt-in, and hand-written `extern fn` decls remain unchecked; `unsafe` deliberately covers neither (tracks provenance, not layout/effects). Stepping stone to a full `@cImport`. See `~/git/node/src/milo/MILO_PAINPOINTS.md` #8.
- [ ] **Structured OS / syscall errors** — `OsError`/`SysError` carrying `errno`/code plus syscall/path context. Needed for runtime bindings, better diagnostics, and Node-compatible error surfacing.

- [x] **Interfaces (runtime polymorphism)** — Go-style interfaces with structural typing and vtable dispatch. `interface Shape { fn area(self: &Self): f64 }` — any type with matching methods satisfies the interface. Separate from traits (which remain compile-time only).
- [ ] **Heap\<Interface\> + heterogeneous collections** — `Vec<Heap<Shape>>` for mixed-type collections via heap-allocated interface values.
- [ ] **Iterators** — iterator trait, `.map().filter().collect()` chains, lazy evaluation. Needs associated types.
- [ ] **Error conversion** — `From` trait for automatic error conversion in `?`, `anyhow`-style boxing.
- [ ] **Ranged integers L3** — branch narrowing: after `if x < 50`, x is known `(min..49)` in the then-branch.
- [ ] **MIR** — lower-level IR for optimization passes (post self-hosting)

### Standard Library

- [x] ~~**JSON streaming / pull parser**~~ — shipped: `jsonPull(src).next()` yields `JsonToken`s (`StartObject`/`Key`/`Str`/`Num`/…/`End`) via a container-stack state machine, never building the tree — O(depth) memory (cf. Go `json.Decoder.Token`). Reuses `jsonSkipWs`/`jsonScanStringRange`/`jsonMaterializeStr`. Still string-backed; incremental byte-feed (true unbounded stream) is a later layer on the same tokenizer.
- [ ] **JSON builder ergonomics** — the *read* side is clean; constructing a document by hand (`jsonObj().str(k,v).int(k,n).build()` chains) is clunky vs the fluent parse API. Flagged from Hades. Wants nicer literal/builder sugar for the write path.

### Tooling

- [x] ~~**LSP: rename + find references**~~ — shipped: `textDocument/references`, `documentHighlight`, and `rename`, plus workspace-wide search over every `.milo` under the workspace root. Name-based like hover/goto (not scope-resolved), which is fine for the read-only ones. Rename is the exception — it WRITES, so params/locals are confined to their enclosing function in their own file; only top-level names get the workspace-wide replace. Before that, renaming `a` in `fn f(a)` also rewrote the unrelated `a` in `fn g(a)`.
- [ ] **Doc comments + generation** — `///` comments, `milo doc` to generate HTML/markdown
- [ ] **Cross-compilation** — `--target aarch64-linux` etc. (infrastructure exists in target.ts, needs CLI flag + sysroot handling)
- [ ] **Benchmarking** — `@bench` annotations, `milo bench` runner
- [ ] **Documentation / tutorials / "the book"**

---

## Known Bugs

- [x] ~~**Missing `linkonce_odr` linkage**~~ — fixed: all non-main functions now emit `define linkonce_odr`, eliminating duplicate symbol errors when the same monomorphized generic or prelude function appears in multiple compilation units.
- [x] ~~**Duplicate symbol errors from prelude**~~ — resolved by `linkonce_odr` fix above.
- [x] ~~**No module-level state**~~ — fixed: `let` and `var` at module scope now work everywhere. Parser, checker, lower, and codegen all handle `GlobalDecl` nodes. Emitted as LLVM `internal global`. Supports int/float/bool literal initializers.
- [x] ~~**Large array codegen crash (>=65536 bytes)**~~ — fixed: aggregate types (arrays, structs) no longer fall through to the scalar trunc/ext cast path in genCast.
- [x] ~~**Codegen: `break`/`continue` skip drop cleanup**~~ — fixed: break and continue now emit `emitLoopDropGlue()` for loop-local owned values before branching. All 6 loop variants (while, for-range, for-each vec/string/array/hashmap) track `loopDropStart`.
- [x] ~~**No `string` → `*u8` cast**~~ — fixed: `"literal" as *u8` and `myString as *u8` now work in unsafe blocks. Codegen extracts the data pointer from the String struct.
- [x] ~~**`string` not coercing to `*u8` in all positions**~~ — fixed: string→`*u8` coercion now works in let/var declarations, assignments, and return statements, in addition to function call arguments.
- ~~**Variadic ABI corruption on ARM64**~~ — investigated: variadic support already implemented (parser, AST, codegen all handle `...`). Not a bug.

## Missing Stdlib Bindings

- [ ] **`execvp`** — needed for tools that exec subcommands with argument arrays (timeout, xargs, env). Currently must route through `system()` which double-forks through `/bin/sh`.
- [ ] **`alarm` / `setitimer`** — enables signal-based timeouts without polling loops
- [ ] **`setpgid` / `killpg`** — process group control for proper job management in tools like timeout
