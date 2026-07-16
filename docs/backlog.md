<!-- doc-meta
system: planning
purpose: ROI/difficulty-ranked lens over outstanding work; a prioritization view, NOT the source of truth for status
key-files: docs/roadmap.md (canonical status), docs/safety-roadmap.md
update-when: an item ships (flip in roadmap.md first, then re-rank here) or a new item is triaged
last-verified: 2026-07-16
-->

# Backlog — prioritized

A **do-next ordering** across the open work. Status source of truth is [roadmap.md](roadmap.md); this file only ranks by return-on-investment vs effort. `Ref` links the canonical entry.

ROI / Effort: **H**igh / **M**edium / **L**ow. Tiers = the quadrant that matters: ship Tier 1 first (cheap + high payoff), invest deliberately in Tier 2, let Tier 3 wait.

## Shipped this loop (2026-07-13)

- **`checkedDiv/Rem`, `wrapping/checkedNeg`** — arithmetic suite completion.
- **`countOnes/leadingZeros/trailingZeros`** — bit intrinsics (LLVM ctpop/ctlz/cttz), return `i64`.
- **`rotateLeft/rotateRight/reverseBits`** — funnel-shift + bitreverse, return receiver width.
- **Fixed-size array slicing** (Tier-2 #6) — `arr[a..b]` view into array storage, no copy.
- **JSON pull parser** (Tier-2 #7) — `jsonPull(src).next()` event stream, no tree, O(depth) mem.
- **Field-precise call-site exclusivity** — `f(&self.a, &mut self.b)` on distinct fields no longer rejected; index/deref still conservative. Unblocks stateful cursor/parser structs. (`checker.ts accessPath`, refines safety-roadmap #3.)
- **Option combinators** (Tier-2 #11 start) — `isSome`/`isNone`/`unwrapOr` (Copy inner).
- **JSON `strOpt/intOpt/floatOpt/boolOpt`** — optional fields stay in the fluent chain.

## Tier 1 — quick wins (high ROI, low effort) — do first

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| F1 | **`#[c_layout]` — verify `extern struct` field offsets** | H | L→M | **Do first.** Today the compiler takes a declared `extern struct` layout on faith: a wrong offset silently reads the neighbouring field and returns plausible garbage — no error, no crash. Hits every user of the feature (docs recommend it), not just the node port; the same faith covers hand-written `extern fn` decls. `unsafe` deliberately doesn't cover it (tracks provenance, not layout/effects). Today's only workaround is a C `_Static_assert`, which needs a C file most pure-Milo users don't have. **Fix:** `#[c_layout("struct stat", "sys/stat.h")]` → compiler emits a throwaway C TU of `_Static_assert(offsetof(struct stat, f) == N)` per field, compiles it with the system `cc` during build, discards it. Reuses the offset computation codegen already does; ~90% of `@cImport`'s safety for ~5% of the work, and a stepping stone to `@cImport` (same guts). Verified by hand this session — the assert caught a real wrong offset. | roadmap.md:110; detail + ranked alternatives in `~/git/node/src/milo/MILO_PAINPOINTS.md` #8 |
| 1 | ~~**`checkedDiv/Rem`, `wrapping/checkedNeg`**~~ ✅ shipped 2026-07-13. | M | L | Safe division (None on div-by-zero / signed `INT_MIN`/-1) + unary negation (desugars to `sub(0,x)`, correct signed+unsigned overflow for free). `overflowingAdd/Sub/Mul` (→ `(val,bool)`) still **blocked on tuple support** — no tuples yet. | `checker.ts`, `lower.ts`, `codegen.ts genCheckedDivRem` |
| 2 | **Struct-field + fn docstring pass** on hot modules | M | L | Bare 6502 register fields (`a/x/y/p`) and un-doc'd fns (`busRead`) read as opaque to newcomers. One-line labels close it. Also seeds `milo doc` (#9). | this session |
| 3 | **JSON builder ergonomics** — *mostly done* | M | L | Builder was already complete + symmetric (`str/int/float/bool/nil/obj/arr/val/raw` on both `JsonObj`/`JsonArr`). ✅ 2026-07-13 added `strOpt/intOpt/floatOpt/boolOpt` to `JsonObj` — optional fields now stay in the fluent chain instead of breaking to an `if`. Remaining: `build()` emits `string` not `Json` (read/write paths disjoint) — bridge later. | `std/json.milo` |
| 4 | **Unused import warnings** — *deferred, not loop-sized* | M | M | Resolver strips imports (`resolveImports` returns `imports: []`), so the checker never sees them — needs threading entry-file imports + used-name collection across resolver→checker, **and** still false-positives on node-milo's link-only imports. Wants a real design pass, not a quick pass. | roadmap.md:108 |
| 5 | **`std`-shadows-local fix** | M | L→M | Papercut: a local can be silently shadowed by a std symbol. Correctness + clarity. | memory: papercuts-from-hades |

## Tier 2 — strategic (high ROI, higher effort) — plan & invest

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 6 | **Borrowed slices / byte views** `&[T]` — *mostly shipped* | H | M | Vec/string slicing works; ✅ 2026-07-13 **fixed-size array slicing** (`arr[a..b]` / `arr.slice(a,b)` → non-owning `%Vec` view into the array's own storage, bound against static N, `codegen genArraySlice`). **Remaining:** generalized byte views for I/O/`Buffer`/`ArrayBuffer` interop. Unblocks zero-copy form of #7. | roadmap.md:109 |
| 7 | **JSON streaming / pull parser** — *shipped (string-backed)* | H | M | ✅ 2026-07-13 `jsonPull(src).next()` → `JsonToken` event stream, O(depth) memory, no tree (`std/json.milo`). **Remaining:** incremental byte-feed for truly unbounded input (socket/multi-GB) — a reader layer over the same tokenizer. | roadmap: Standard Library |
| 8 | **Iterators** — `.map().filter().collect()` | H | H | Ergonomics everywhere; kills manual index loops. Needs associated types. | roadmap.md:115 |
| 9 | **Doc comments + `milo doc`** | H | M | `///` + generator. DX + real docs; incentivizes the docstrings #2 adds by hand. | roadmap.md:123 |
| 10 | **LSP rename + find-references** | H | M | Daily-driver DX gap. | roadmap.md:122 |
| 11 | **Option ergonomics** — *started* | H | M | ✅ 2026-07-13 `isSome()`/`isNone()`/`unwrapOr(default)` (`checker`/`lower`/`codegen OptionOp`); `unwrapOr` gated to Copy inner (owned → use `match`). Remaining: `map`/`unwrapOrElse` (need closures), `?`-on-Option polish. | memory: papercuts-from-hades |
| 12 | **Flow-sensitive invalidation tracking** | H | H | Compile-time catch of aliased mutation / use-after-invalidate — the aircraft-grade safety tier. | roadmap.md:94, safety-roadmap.md |
| 13 | **Compile-time reduction** | H | H | Broad DX win; diffuse, needs profiling first (candidate for MIR #b8). | memory: papercuts-from-hades |

## Tier 3 — backlog (niche, deferred, or lower ROI)

Track in [roadmap.md](roadmap.md); pull up when a concrete need appears.

- **Error conversion** — `From` in `?`, boxing (roadmap.md:116)
- **Ranged integers L3** — branch narrowing (roadmap.md:117)
- **Heap\<Interface\>** — heterogeneous collections (roadmap.md:114)
- **C ABI layout control** — packed structs, alignment (roadmap.md:110)
- **Structured OS/syscall errors** — `errno` + context (roadmap.md:111)
- **Struct-by-value FFI stage 6** — define-side exported struct-by-value fns (memory: struct-by-value-ffi)
- **`-O2` codegen blowup + int-widening** — deferred from emulator work (memory: emulator-feedback-fixes)
- **Missing bindings** — `execvp`, `alarm`/`setitimer`, `setpgid`/`killpg` (roadmap.md:143-145)
- **MIR** — optimization IR, post self-hosting (roadmap.md:118)
- **node-milo V8 C API wrapper** — eliminate `bridge/*.cpp` (roadmap.md:87)
- **Cross-compilation**, **benchmarking harness**, **"the book"** (roadmap.md:124-126)
- **Promise / shuf ergonomics** — verify current status before scheduling (memory)

## Concurrency & TUI findings (2026-07-15, tmuxClone/splitPty session)

Surfaced building a terminal multiplexer (`examples/apps/tmuxClone.milo`) — the
primitives carried it, but these gaps are where the friction was. Ranked.

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| C1 | **`Select.wait()` returns `-1`, not the winning arm** | H | M | Main-context select parks correctly (idle CPU measured **0.0%**) but the claim never lands in the return value, so callers can't tell *which* arm fired. Workaround in the demos: drain every arm (correct + free, fds are `O_NONBLOCK`). Root cause is in the main-thread vs green-task park/claim path (`_selectWaitState`/`_wakeSelectFds`, `std/runtime.milo`); `schedulerCurrent()` is 0 on the main context so `schedulerPark()` no-ops. **Attempted fix** (drive `_pollAndWake` from `_selectWaitState` when no current task) **regressed to a hang** — the claim still didn't fire, so neither the fd nor the timer arm was recorded. Needs a proper investigation of who unparks the main select task. | `std/runtime.milo:795 _selectWaitState` |
| C2 | **Concurrency primitives don't compose** | H | M | `Promise` is not selectable and `Channel<T>` has no shareable handle / `clone()` (`_ptr` is module-private, not `@copy`). So you can't bridge a `Promise.blocking` OS-thread result into a `Select` — which is exactly what an event-driven `timeout` needs. Want: `Channel.clone()` (or a selectable `Promise`), **plus** a child-exit `Select` arm (SIGCHLD / kqueue `EVFILT_PROC`). | `std/sync.milo:210`, `std/runtime.milo:486` |
| C3 | **`timeout.milo:247` is a `waitpid(WNOHANG)`+sleep poll** | M | M | The one genuine I/O-poll left after the sweep (animation demos are frame timers, correctly untouched). Clean conversion is **blocked on C2**. | `examples/cli-tools/timeout.milo:247` |
| C4 | **Blocking `waitpid` wedges the green runtime** | M | M | Blocking `waitpid` on a `SIGKILL`'d-but-wedged child (stuck writing to a full PTY) hangs the scheduler thread. Now handled inside `Pty` (kill → close master to unwedge → reap), but the runtime interaction is a sharp edge worth a guard. | `std/pty.*.milo`, session |
| C5 | **No SIGWINCH → resize needs a timer** | M | M | No signal→`Select` arm, so TUI resize is polled (`splitPty` uses `onTimeout(500)`). A signal arm would make it fully event-driven. | `examples/apps/splitPty.milo` |
| C6 | **Papercuts** | L | L | (a) match-bound values are immutable for `&mut` **fn args** but fine for `&mut` **methods** — inconsistent, forced inlining a spawn helper. (b) `string.push` needs an explicit `as u8` on int literals. (c) ~~`appendFile` missing from `std/fs`~~ ✅ added this session. | session |
| C7 | **No `AF_UNIX` in `std/net`** | M | M | `std/net` is TCP-only (`TcpListener`/`TcpStream` over `AF_INET`). The tmux-style detach/attach daemon (`examples/apps/tmuxDaemon.milo`) works over a localhost TCP port as a result — fine on one machine, but a unix-domain socket (filesystem-scoped, no port allocation/conflicts, peer-cred auth) is the right transport for a local daemon. Add `UnixListener`/`UnixStream`. | `std/net.milo`, `examples/apps/tmuxDaemon.milo` |

**Positive findings (this loop):** `Vec<Pty>` and `Vec<Term>` both work — pushing owned structs-with-drop into a `Vec`, indexing them, calling `&mut` methods on elements (`terms[i].feed(...)`), and whole-element reassignment (`terms[i] = newTerm(...)`) all compile and run. That's what let the daemon go dynamic N-pane. No language gap here — just noting it works.

**Known limitation (not a bug):** on split/resize the daemon rebuilds every pane grid at the new width (shells repaint via SIGWINCH), so on-screen content of *other* panes is cleared at that moment (still live in each shell's own history). True content reflow across a resize is a later polish.

## Ergonomics findings (2026-07-16, ugly-code audit)

From a worst-code sweep of `std/` + `src-milo/`. Two language gaps, three hygiene items.

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| E1 | **Raw-pointer sugar: `ptr == null` + `ptr.offset(n)`** | M | L | Null check today is `dir as i64 == 0 as i64` (both sides cast); pointer arithmetic is `(ctBuf as i64 + outLen as i64) as *u8` (three casts). Recurs across `fs`/`cstr`/`env`/`runtime`/`sync`/`crypto`. Confined to the FFI seam, but the ugliness is accidental, not deliberate friction. | `std/fs.milo:97`, `std/crypto.linux.milo:152` |
| E2 | **Named enum-variant fields** | H | M | `ForEach(string, Option<string>, TypeKind, Option<TypeKind>, Heap<HIRExpr>, string, Vec<Heap<HIRStmt>>, Option<Span>)` needs a trailing comment decoding the slots. Hits self-hosted compiler hardest (HIR/AST are all sum types). Rust-style `ForEach { varName: string, ... }`. | `src-milo/hir.milo:88` |
| E3 | **Type-alias hygiene sweep** | M | L | Language has `type X = ...` (parser + range tests use it); `std/` + `src-milo/` use it zero times. `&Option<Vec<Heap<Stmt>>>` is spelled verbatim ~30× — one `type Block = Vec<Heap<Stmt>>` kills it. Pure code debt. | `src-milo/checker/stmt.milo:189` |
| E4 | **Codegen context struct** | M | M | `locs: &mut Vec<Local>, sigs: &Vec<CgFnSig>, retTy: &string` + 4 label params copy-pasted through every `gen*` fn (13-param signatures). Fold into a `GenCtx`. Code debt, no language gap. | `src-milo/codegen/stmt.milo:205` |
| E5 | **`jsonParseValue` err flag → `Result`** | L | L | Parser threads `err: &mut bool` through 3 signatures instead of `Result<i64, E>` — predates typed-errors migration. Scratch-vec design itself is deliberate zero-alloc, keep it. | `std/json.milo:964` |

## Dependency notes

- **#6 (byte views) gates the zero-copy form of #7 (streaming JSON).** #7 works without it (materialize per event), but hands out copies until #6 lands.
- **#2 (hand docstrings) → #9 (`milo doc`):** do #2 opportunistically now; #9 makes it systematic.
- **#13 (compile time) likely wants MIR (Tier 3)** for real wins — profile before committing.
