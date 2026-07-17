<!-- doc-meta
system: planning
purpose: ROI/difficulty-ranked lens over outstanding work; a prioritization view, NOT the source of truth for status
key-files: docs/roadmap.md (canonical status), docs/safety-roadmap.md
update-when: an item ships (flip in roadmap.md, then DELETE it here) or a new item is triaged
last-verified: 2026-07-16 (Tier 2 entries verified against code)
-->

# Backlog — prioritized

A **do-next ordering** across the open work. Status source of truth is [roadmap.md](roadmap.md); this file only ranks by return-on-investment vs effort. `Ref` links the canonical entry.

**Refs name things, never line numbers.** Every `roadmap.md:NNN` in here had rotted — `:115` pointed at an unrelated shipped item, `:109`/`:123` at blank lines. A ref that silently points somewhere plausible is worse than none. Same for `#N` cross-references: renumbering after a deletion left one item pointing at itself and another at a deleted entry, so prefer naming the item.

**Verify before working an entry.** These are written from intent and rot as code lands: three entries here (LSP rename, `milo doc`, the parser bug's diagnosis) turned out already shipped or misdiagnosed, and two more (iterators' "needs associated types", Option's "needs closures") named blockers that no longer existed. Check the code first; correct the entry when it lies.

**Shipped items are deleted from this file, not struck through** — git history and roadmap.md keep the record. If an entry ships but leaves real work behind, only the leftover survives here, rewritten as its own item.

ROI / Effort: **H**igh / **M**edium / **L**ow. Tiers = the quadrant that matters: ship Tier 1 first (cheap + high payoff), invest deliberately in Tier 2, let Tier 3 wait.

## Tier 1 — quick wins (high ROI, low effort) — do first

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 1 | **Docstring pass: rest of the hot modules** | L | L | `examples/apps/nes/cpu.milo` done — the 6502 registers (`a`/`x`/`y`/`sp`/`p`) and `busRead`/`busWrite`'s side effects, which are the cases the note actually named. The same treatment is worth it for the SNES/Genesis cores and `std`'s opaque structs, but it's a slow grind with little leverage until `milo doc` (Tier 2) makes it systematic. Worth doing opportunistically when touching a module, not as a sweep. | `examples/apps/{snes,genesis}/` |

## Tier 2 — strategic (high ROI, higher effort) — plan & invest

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 2 | **`std/smt` can't decide past ~2^62** | M | H | **No longer unsound** — `combine()` detects the i64 overflow and the verdict degrades to `unknown` instead of a false `proven`. What remains is capability: Fourier-Motzkin multiplies constants, so anything near 2^62 overflows and the answer is lost. That is why `verify.ts` omits i64/u64 param ranges — with them on, a genuinely broken call reports `unknown` instead of its counterexample. Needs wider arithmetic (i128/bignum) in the elimination. | `std/smt.milo combine`, `verify.ts INT_RANGES` |
| 3 | **Prover models ints as unbounded, params only** | M | H | `verify.ts` now asserts each int param's real range, which killed the `fpMul` false alarms — but **intermediate arithmetic carries no range**, so `error = setpoint - measured` (two i32s) can reach -2^32 in the model and refute a call that no real i32 could. That is the whole `pidStep` baseline entry. Needs range-carrying arithmetic or a bitvector model. | `verify.ts intRangeAssumption` |
| 4 | **Extern fn parameters are unverified** | M | H | The audit now covers **return types** on both platforms (CI runs it on macOS + Linux), and std is clean — so `@cSig`'s remaining gap is params, which it doesn't check either. Needs a C parser to introspect a function type's parameter list; `__builtin_types_compatible_p` on the whole signature is exact but only when the C signature is hand-written (`@cSig`). Nothing cheap left here. | `scripts/audit-extern-returns.ts`, `src/codegen.ts cSigGuard` |
| 5 | **Cross-compiling hosted targets needs a sysroot** | M | H | `--target` now reaches clang and a cross build fails loudly with a hint (was: silently emitted a host binary and reported success). Actually *doing* it needs a target linker + sysroot; the compiler has no `-I`/`-isysroot`/`--sysroot` notion at all. Until then, build on the target. Also what blocks cross-target `@cLayout`/`@cSig` verification, which warns and skips. | `src/main.ts clangTargetFlags`, `linkIR` |
| 6 | **Lazy iterator adapters + generalize `map`/`filter` beyond Vec** | M | H | **Retitled — the old entry ("`.map().filter().collect()`, needs associated types") was wrong on both halves.** Chaining already works and is a passing fixture: `tests/fixtures/vecChain.milo:10` runs `nums.filter(...).map(...)`. Shipped on Vec: `map`/`filter`/`each`/`enumerate`/`find`/`any`/`all` (`checker.ts:4587-4652`), closures included. **Associated types are not needed** — a structural iterator protocol already exists (`checker.ts:2452`: any type with `next(): Option<T>` works in `for-in`; `Channel<T>` uses it, `std/sync.milo:449`), and the `Option<T>` return supplies the item type an associated type would have. No `.collect()` because `map`/`filter` return an owned `Vec<T>` directly. Real remaining work: each stage allocates a new Vec (no lazy/fusing adapters); no `reduce`/`fold`/`sum`/`take`/`skip`/`zip`/`rev`; combinators are hardcoded to `objType.tag === "vec"`, so arrays/slices/maps/user types are excluded. | `checker.ts:4587`, `tests/fixtures/vecChain.milo` |
| 7 | **Byte views for I/O interop** | H | M | Vec/string/array slicing all shipped. Remaining: generalized byte views for I/O/`Buffer`/`ArrayBuffer`. Unblocks the zero-copy form of #8 (JSON byte-feed). | roadmap.md |
| 8 | **JSON incremental byte-feed** | H | M | `jsonPull` shipped (string-backed). Remaining: incremental feed for unbounded input (socket/multi-GB) — a reader layer over the same tokenizer. Hands out copies until #7 (byte views) lands. | roadmap: Standard Library |
| 9 | **Option `map`/`unwrapOrElse`** | M | M | Headline is real — neither exists (`grep unwrapOrElse\|andThen\|orElse\|okOr src std` matches only this entry). **Both stated blockers were stale and are removed:** closures shipped long ago (16 fixtures; `Vec.map` already takes one), and `?`-on-Option already works (`checker.ts:4297`, fixtures `propagateOption`/`propagateSome`/`optionPropagateDiffT`) — as does `??` (`checker.ts:4316`). So it is *unstarted*, not blocked. Shipped today: `isSome`/`isNone`/`unwrapOr` at `checker.ts:4422-4447`, lowered via `OptionOp`. Actual cost, measured: `map` must build `Option<U>` — `monomorphizeEnum("Option", [U])` exists (`checker.ts:592`, used at `:5428`) — and `unwrapOrElse` needs **branch-based lowering**, because `genOptionOp` is `select`-based (`codegen.ts:8483`) and would call the closure eagerly, defeating the point. Closure call convention: `call <ret> <fnPtr>(ptr <env>, <arg>)` (see `genVecMap`, `codegen.ts:5014`). | `checker.ts:4422`, `codegen.ts:8454` |
| 10 | **Flow-sensitive invalidation tracking** | H | H | Compile-time catch of aliased mutation / use-after-invalidate — the aircraft-grade safety tier. | roadmap.md, safety-roadmap.md |
| 11 | **Compile-time reduction** | H | H | Broad DX win; diffuse, needs profiling first (candidate for MIR). | memory: papercuts-from-hades |

## Tier 3 — backlog (niche, deferred, or lower ROI)

Track in [roadmap.md](roadmap.md); pull up when a concrete need appears.

- **`JsonObj.build()` returns `string`, not `Json`** — read/write paths disjoint; bridge later (`std/json.milo`)
- **Error conversion** — `From` in `?`, boxing (roadmap.md)
- **Ranged integers L3** — branch narrowing (roadmap.md)
- **Heap\<Interface\>** — heterogeneous collections (roadmap.md)
- **C ABI layout control** — packed structs, alignment (roadmap.md)
- **Structured OS/syscall errors** — `errno` + context (roadmap.md)
- **Struct-by-value FFI stage 6** — define-side exported struct-by-value fns (memory: struct-by-value-ffi)
- **`-O2` codegen blowup + int-widening** — deferred from emulator work (memory: emulator-feedback-fixes)
- **Missing bindings** — `execvp`, `alarm`/`setitimer`, `setpgid`/`killpg` (roadmap.md)
- **MIR** — optimization IR, post self-hosting (roadmap.md)
- **node-milo V8 C API wrapper** — eliminate `bridge/*.cpp` (roadmap.md)
- **Cross-compilation**, **benchmarking harness**, **"the book"** (roadmap.md)
- **Promise / shuf ergonomics** — verify current status before scheduling (memory)
- **Re-enable `noUncheckedIndexedAccess`** — off deliberately 2026-07-16 so the tsc gate could enforce at zero; it was a bun-init default with ~700 violations, i.e. enforcing nothing. Retrofitting means ~700 `arr[i]!` assertions, which silence rather than prove. Revisit per-file only if index bugs actually show up. (`tsconfig.json`)
- **`@derive` on enums** — enums parse attributes but nothing consumes them; now a hard error rather than a silent no-op. Implement if wanted (`checker.ts processDerives` walks only structs).

## Concurrency & TUI findings (2026-07-15, tmuxClone/splitPty session)

Surfaced building a terminal multiplexer (`examples/apps/tmuxClone.milo`) — the
primitives carried it, but these gaps are where the friction was. Ranked.

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| C1 | **`Select.wait()` returns `-1`, not the winning arm** | H | M | Main-context select parks correctly (idle CPU **0.0%**) but the claim never lands in the return value, so callers can't tell *which* arm fired. Workaround in the demos: drain every arm (correct + free, fds are `O_NONBLOCK`). Root cause is in the main-thread vs green-task park/claim path (`_selectWaitState`/`_wakeSelectFds`); `schedulerCurrent()` is 0 on the main context so `schedulerPark()` no-ops. **Attempted fix** (drive `_pollAndWake` from `_selectWaitState` when no current task) **regressed to a hang**. Needs a proper investigation of who unparks the main select task. | `std/runtime.milo:795` |
| C2 | **Concurrency primitives don't compose** | H | M | `Promise` is not selectable and `Channel<T>` has no shareable handle / `clone()` (`_ptr` is module-private, not `@copy`). So you can't bridge a `Promise.blocking` OS-thread result into a `Select` — exactly what an event-driven `timeout` needs. Want: `Channel.clone()` (or a selectable `Promise`), **plus** a child-exit `Select` arm (SIGCHLD / kqueue `EVFILT_PROC`). | `std/sync.milo:210`, `std/runtime.milo:486` |
| C3 | **`timeout.milo:247` is a `waitpid(WNOHANG)`+sleep poll** | M | M | The one genuine I/O-poll left after the sweep (animation demos are frame timers, correctly untouched). Clean conversion is **blocked on C2**. | `examples/cli-tools/timeout.milo:247` |
| C4 | **Blocking `waitpid` wedges the green runtime** | M | M | Blocking `waitpid` on a `SIGKILL`'d-but-wedged child (stuck writing to a full PTY) hangs the scheduler thread. Now handled inside `Pty` (kill → close master to unwedge → reap), but the runtime interaction is a sharp edge worth a guard. | `std/pty.*.milo` |
| C5 | **No SIGWINCH → resize needs a timer** | M | M | No signal→`Select` arm, so TUI resize is polled (`splitPty` uses `onTimeout(500)`). A signal arm would make it fully event-driven. | `examples/apps/splitPty.milo` |
| C6 | **Papercuts** | L | L | (a) match-bound values are immutable for `&mut` **fn args** but fine for `&mut` **methods** — inconsistent, forced inlining a spawn helper. (b) `string.push` needs an explicit `as u8` on int literals. | session |
| C7 | **No `AF_UNIX` in `std/net`** | M | M | `std/net` is TCP-only. The tmux-style detach/attach daemon works over a localhost TCP port as a result — fine on one machine, but a unix-domain socket (filesystem-scoped, no port allocation, peer-cred auth) is the right transport for a local daemon. Add `UnixListener`/`UnixStream`. | `std/net.milo`, `examples/apps/tmuxDaemon.milo` |

**Known limitation (not a bug):** on split/resize the daemon rebuilds every pane grid at the new width (shells repaint via SIGWINCH), so on-screen content of *other* panes is cleared at that moment (still live in each shell's own history). True content reflow across a resize is a later polish.

## Ergonomics findings (2026-07-16, ugly-code audit)

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| E2 | **Named enum-variant fields** | H | M | `ForEach(string, Option<string>, TypeKind, Option<TypeKind>, Heap<HIRExpr>, string, Vec<Heap<HIRStmt>>, Option<Span>)` needs a trailing comment decoding the slots. Hits the self-hosted compiler hardest (HIR/AST are all sum types). Rust-style `ForEach { varName: string, ... }`. | `src-milo/hir.milo:88` |
| E1 | **Raw-pointer sugar: `ptr == null` + `ptr.offset(n)`** | M | L | Null check today is `dir as i64 == 0 as i64` (both sides cast); pointer arithmetic is `(ctBuf as i64 + outLen as i64) as *u8` (three casts). Recurs across `fs`/`cstr`/`env`/`runtime`/`sync`/`crypto`. Confined to the FFI seam, but the ugliness is accidental, not deliberate friction. | `std/fs.milo:97` |
| E3 | **Type-alias hygiene sweep** | M | L | Language has `type X = ...`; `std/` + `src-milo/` use it zero times. `&Option<Vec<Heap<Stmt>>>` is spelled verbatim ~30× — one `type Block = Vec<Heap<Stmt>>` kills it. Pure code debt. | `src-milo/checker/stmt.milo:189` |
| E4 | **Codegen context struct** | M | M | `locs/sigs/retTy` + 4 label params copy-pasted through every `gen*` fn (13-param signatures). Fold into a `GenCtx`. | `src-milo/codegen/stmt.milo:205` |
| E5 | **`jsonParseValue` err flag → `Result`** | L | L | Parser threads `err: &mut bool` through 3 signatures instead of `Result<i64, E>` — predates typed-errors migration. Scratch-vec design itself is deliberate zero-alloc, keep it. | `std/json.milo:964` |

## Dependency notes

- **#10 (byte views) gates the zero-copy form of #11 (streaming JSON).** #11 works without it (materialize per event), but hands out copies until #10 lands.
- **#3 (hand docstrings) → #8 (`milo doc`):** do #3 opportunistically now; #8 makes it systematic.
- **#14 (compile time) likely wants MIR (Tier 3)** for real wins — profile before committing.
