<!-- doc-meta
system: planning
purpose: ROI/difficulty-ranked lens over outstanding work; a prioritization view, NOT the source of truth for status
key-files: docs/roadmap.md (canonical status), docs/safety-roadmap.md
update-when: an item ships (flip in roadmap.md, then DELETE it here) or a new item is triaged
last-verified: 2026-07-16 (full audit — every entry in every tier verified against code)
-->

# Backlog — prioritized

A **do-next ordering** across the open work. Status source of truth is [roadmap.md](roadmap.md); this file only ranks by return-on-investment vs effort. `Ref` links the canonical entry.

**Refs name things, never line numbers.** Every `roadmap.md:NNN` in here had rotted — `:115` pointed at an unrelated shipped item, `:109`/`:123` at blank lines. A ref that silently points somewhere plausible is worse than none. Same for `#N` cross-references: renumbering after a deletion left one item pointing at itself and another at a deleted entry, so prefer naming the item.

**Verify before working an entry.** These are written from intent and rot as code lands: three entries here (LSP rename, `milo doc`, the parser bug's diagnosis) turned out already shipped or misdiagnosed, and two more (iterators' "needs associated types", Option's "needs closures") named blockers that no longer existed. The full audit then found three more shipped entries still listed (SIGWINCH select arm, shuf/Promise ergonomics, benchmarking harness). Check the code first; correct the entry when it lies.

**Shipped items are deleted from this file, not struck through** — git history and roadmap.md keep the record. If an entry ships but leaves real work behind, only the leftover survives here, rewritten as its own item.

ROI / Effort: **H**igh / **M**edium / **L**ow. Tiers = the quadrant that matters: ship Tier 1 first (cheap + high payoff), invest deliberately in Tier 2, let Tier 3 wait.

## Tier 1 — quick wins (high ROI, low effort) — do first

_Empty — pull the cheapest Tier 2 item up when one qualifies._

## Tier 2 — strategic (high ROI, higher effort) — plan & invest

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 2 | **`std/smt` can't decide past ~2^62** | M | H | **No longer unsound** — `combineTerm` detects the i64 overflow and the verdict degrades to `unknown` instead of a false `proven`. What remains is capability: Fourier-Motzkin multiplies constants, so anything near 2^62 overflows and the answer is lost. That is why `verify.ts` omits i64/u64 param ranges — with them on, a genuinely broken call reports `unknown` instead of its counterexample. Needs wider arithmetic (i128/bignum) in the elimination. | `std/smt.milo combine`, `verify.ts INT_RANGES` |
| 3 | **Prover models ints as unbounded, params only** | M | H | `verify.ts` now asserts each int param's real range, which killed the `fpMul` false alarms — but **intermediate arithmetic carries no range**, so `error = setpoint - measured` (two i32s) can reach -2^32 in the model and refute a call that no real i32 could. That is the whole `pidStep` baseline entry. Needs range-carrying arithmetic or a bitvector model. | `verify.ts intRangeAssumption` |
| 4 | **Extern fn parameters are unverified** | M | H | The audit now covers **return types** on both platforms (CI runs it on macOS + Linux), and std is clean — so `@cSig`'s remaining gap is the Milo-param ↔ C-param mapping, which `cSigGuard` documents as unchecked (its two asserts cover the stated-signature-vs-header claim and the return type only). Needs a C parser to introspect a function type's parameter list; `__builtin_types_compatible_p` on the whole signature is exact but only when the C signature is hand-written (`@cSig`). Nothing cheap left here. | `scripts/audit-extern-returns.ts`, `src/codegen.ts cSigGuard` |
| 5 | **Cross-compiling hosted targets needs a sysroot** | M | H | `--target` now reaches clang and a cross build fails loudly with a hint (was: silently emitted a host binary and reported success). Actually *doing* it needs a target linker + sysroot; the compiler has no `-I`/`-isysroot`/`--sysroot` notion at all. Until then, build on the target. Also what blocks cross-target `@cLayout`/`@cSig` verification, which warns and skips. | `src/main.ts clangTargetFlags`, `linkIR` |
| 6 | **Lazy iterator adapters + generalize `map`/`filter` beyond Vec** | M | H | **Retitled — the old entry ("`.map().filter().collect()`, needs associated types") was wrong on both halves.** Chaining already works and is a passing fixture: `tests/fixtures/vecChain.milo` runs `nums.filter(...).map(...)`. Shipped on Vec (checker's MethodCall arm in `checkExpr`): `map`/`filter`/`each`/`enumerate`/`find`/`any`/`all`, closures included. **Associated types are not needed** — a structural iterator protocol already exists (for-in accepts any struct/enum with `next(&mut Self): Option<T>`, resolved via `resolveMethod("next")`; `Channel<T>.next` in `std/sync.milo` uses it), and the `Option<T>` return supplies the item type an associated type would have. No `.collect()` because `map`/`filter` return an owned `Vec<T>` directly. Real remaining work: each stage allocates a new Vec (no lazy/fusing adapters); no `reduce`/`fold`/`sum`/`take`/`skip`/`zip`; combinators are gated on `objType.tag === "vec"`, so arrays/slices/maps/user types are excluded. | `checker.ts checkExpr` (vec MethodCall arm), `tests/fixtures/vecChain.milo` |
| 7 | **Byte views for I/O interop** | H | M | Vec/string/array slicing all shipped (`arraySlice`/`vecSlice`/`stringSlice` fixtures). Remaining: generalized byte views for I/O/`Buffer`/`ArrayBuffer`. Unblocks the zero-copy form of #8 (JSON byte-feed). | roadmap: Borrowed slices / byte views |
| 8 | **JSON incremental byte-feed** | H | M | `jsonPull` shipped (string-backed). Remaining: incremental feed for unbounded input (socket/multi-GB) — a reader layer over the same tokenizer. Hands out copies until #7 (byte views) lands. | `std/json.milo jsonPull`, roadmap: Standard Library |
| 9 | **`std/net` has no IPv6 — the language's own networking is v4-only** | M | M | The 2026-07-16 IPv6 work all landed in **node-milo's** bindings; `std/net` was never touched and has zero hits for `AF_INET6`/`sockaddr_in6`/`inet_pton`. IPv4 is baked into the *public API* (`ip4(a,b,c,d): u32`, `TcpStream.connect(ip: u32, …)`, `TlsStream.connect(ip: u32, …)`) — a `u32` cannot hold a 128-bit address — and `resolve()` hardcodes AF_INET in its hints, so DNS never returns a v6 answer. Needs: `SockAddrIn6` (28B: len/family/port/flowinfo/addr@8/scope@24) in **both** `std/platform.{darwin,linux}.milo` (they differ — darwin has `sin6_len`, linux starts with a u16 family), an `IpAddr` V4/V6 type, and AF_UNSPEC resolution. Add alongside `ip4`/`connect` rather than changing them (incremental-API rule). Port the `buildSockAddr` shape already proven in node-milo's `tcp.milo`. | `std/net.milo resolve`, `std/platform.*.milo makeSockaddr` |
| 10 | **Flow-sensitive invalidation tracking** | H | H | Compile-time catch of aliased mutation / use-after-invalidate — the aircraft-grade safety tier. | roadmap.md, safety-roadmap.md |
| 11 | **Compile-time reduction** | H | H | Broad DX win; diffuse, needs profiling first (candidate for MIR). | memory: papercuts-from-hades |

## Tier 3 — backlog (niche, deferred, or lower ROI)

Track in [roadmap.md](roadmap.md); pull up when a concrete need appears.

- **`JsonObj.build()` returns `string`, not `Json`** — read/write paths disjoint; bridge later (`std/json.milo`)
- **Error boxing** — the `?` half of "error conversion" shipped: wrapping-variant auto-From converts the error type in `?` (`tests/fixtures/resultFromConversion.milo`, alias form too). What's left is `anyhow`-style boxing, which wants Heap\<Interface\> (roadmap.md)
- **Ranged integers L3** — branch narrowing (roadmap.md)
- **Heap\<Interface\>** — heterogeneous collections (roadmap.md)
- **C ABI layout control** — packed structs, alignment (roadmap.md)
- **Structured OS/syscall errors** — `errno` + context (roadmap.md)
- **Struct-by-value FFI stage 6** — define-side exported struct-by-value fns (memory: struct-by-value-ffi)
- **`-O2` codegen blowup + int-widening** — deferred from emulator work (memory: emulator-feedback-fixes)
- **Missing bindings** — `alarm`/`setitimer`, `setpgid`/`killpg`. (`execvp` shipped: declared in `std/os.milo`, used by `std/process` and `std/pty`.) (roadmap.md)
- **MIR** — optimization IR, post self-hosting (roadmap.md)
- **node-milo V8 C API wrapper** — eliminate `bridge/*.cpp` (roadmap.md)
- **"The book"** — documentation/tutorials (roadmap.md). Cross-compilation is Tier 2 #5, not a separate item; the benchmarking harness shipped (`benchmarks/run.sh` + per-bench `results-*.md`).
- **Re-enable `noUncheckedIndexedAccess`** — off deliberately 2026-07-16 so the tsc gate could enforce at zero; it was a bun-init default with ~700 violations, i.e. enforcing nothing. Retrofitting means ~700 `arr[i]!` assertions, which silence rather than prove. Revisit per-file only if index bugs actually show up. (`tsconfig.json`)
- **`@derive` on enums** — enums parse attributes but nothing consumes them; now a hard error rather than a silent no-op (`checker.ts validateAttributes`). Implement if wanted (`checker.ts processDerives` walks only structs, and skips generic ones).

## Concurrency & TUI findings (2026-07-15, tmuxClone/splitPty session)

Surfaced building a terminal multiplexer (`examples/apps/tmuxClone.milo`) — the
primitives carried it, but these gaps are where the friction was. Ranked.

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| C1 | **`Select.wait()` returns `-1`, not the winning arm** | H | M | Main-context select parks correctly (idle CPU **0.0%**) but the claim never lands in the return value, so callers can't tell *which* arm fired. Workaround in the demos: drain every arm (correct + free, fds are `O_NONBLOCK`). Root cause: `_selectWaitState` stashes `schedulerCurrent()` — which is 0 on the main context — so `schedulerPark()` no-ops and the unclaimed `-1` falls through. **Channels solved this exact problem since:** main-context send/recv now drives the scheduler via `_schedulerPollMain` (`std/sync.milo`), but `std/select.milo` never adopted the pattern. An earlier naive fix (driving `_pollAndWake` from `_selectWaitState`) regressed to a hang, so port the channel pattern carefully. | `std/runtime.milo _selectWaitState`, `std/sync.milo` `_schedulerPollMain` callers |
| C2 | **Concurrency primitives don't compose** | H | M | `Promise` is not selectable and `Channel<T>` has no shareable handle / `clone()` (`_ptr` is module-private, not `@copy`) — even though `Promise` is now literally a private `Channel<T>` inside (`std/runtime.milo struct Promise`, field `_ch`). So you can't bridge a `Promise.blocking` OS-thread result into a `Select` — exactly what an event-driven `timeout` needs. Want: `Channel.clone()` (or a selectable `Promise`), **plus** a child-exit `Select` arm — the signal half of that shipped (`std/signal.milo installSignalPipe`), leaving the `SIGCHLD` constant (Tier 1 #1) and a reap-on-wake pattern. | `std/sync.milo struct Channel`, `std/runtime.milo struct Promise` |
| C3 | **`timeout` is a `waitpid(WNOHANG)`+sleep poll** | M | M | The one genuine I/O-poll left after the sweep (animation demos are frame timers, correctly untouched): `timeout`'s main loop is `waitpid(pid, status, WNOHANG)` + `sleepMs(50)`. Clean conversion is blocked on a child-exit `Select` arm: Tier 1 #1 (`SIGCHLD`) plus the C2 bridge. | `examples/cli-tools/timeout.milo` waitpid loop |
| C4 | **Blocking `waitpid` wedges the green runtime** | M | M | Blocking `waitpid` on a `SIGKILL`'d-but-wedged child (stuck writing to a full PTY) hangs the scheduler thread. Now handled inside `Pty` (kill → close master to unwedge → reap; see the "unwedges a child blocked writing" comment), but the runtime interaction is a sharp edge worth a guard. | `std/pty.*.milo` `Pty.kill`/close |
| C5 | **Papercuts** | L | L | (a) match-bound values are immutable for `&mut` **fn args** but fine for `&mut` **methods** — inconsistent, forced inlining a spawn helper. (b) `string.push` needs an explicit `as u8` on int literals (re-verified: `s.push(65)` still errors "expected u8, got i64"). | session |
| C6 | **No `AF_UNIX` in `std/net`** | M | M | `std/net` is TCP-only (zero hits for `AF_UNIX`/`UnixListener`/`UnixStream`). The tmux-style detach/attach daemon works over a localhost TCP port as a result — fine on one machine, but a unix-domain socket (filesystem-scoped, no port allocation, peer-cred auth) is the right transport for a local daemon. Add `UnixListener`/`UnixStream`. | `std/net.milo`, `examples/apps/tmuxDaemon.milo` |

**Known limitation (not a bug):** on split/resize the daemon rebuilds every pane grid at the new width (shells repaint via SIGWINCH), so on-screen content of *other* panes is cleared at that moment (still live in each shell's own history). True content reflow across a resize is a later polish.

## Ergonomics findings (2026-07-16, ugly-code audit)

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| E1 | **Named enum-variant fields** | H | M | `ForEach(string, Option<string>, TypeKind, Option<TypeKind>, Heap<HIRExpr>, string, Vec<Heap<HIRStmt>>, Option<Span>)` needs a trailing comment decoding the slots. Hits the self-hosted compiler hardest (HIR/AST are all sum types). Rust-style `ForEach { varName: string, ... }`. | `src-milo/hir.milo HIRStmt.ForEach` |
| E2 | **Raw-pointer sugar: `ptr == null` + `ptr.offset(n)`** | M | L | Null check today is `dir as i64 == 0 as i64` (both sides cast); pointer arithmetic is `(ent as i64 + nameOff) as *u8` (three casts). Recurs across `fs`/`cstr`/`env`/`runtime`/`sync`/`crypto`. Confined to the FFI seam, but the ugliness is accidental, not deliberate friction. | `std/fs.milo readDir` |
| E3 | **Type-alias hygiene sweep** | M | L | Language has `type X = ...` (`TypeAlias` in `src/ast.ts`); `std/` + `src-milo/` use it zero times. `Vec<Heap<Stmt>>` is spelled verbatim ~37× (13 of those inside `Option<...>`) — one `type Block = Vec<Heap<Stmt>>` kills it. Pure code debt. | `src-milo/checker/stmt.milo checkReturn` |
| E4 | **Codegen context struct** | M | M | `locs/sigs/retTy` + 4 label params copy-pasted through every `gen*` fn (`genForInHashMap` takes 13 params). Fold into a `GenCtx`. | `src-milo/codegen/stmt.milo genForInHashMap` |
| E5 | **`jsonParseValue` err flag → `Result`** | L | L | Parser threads `err: &mut bool` through its recursive signatures instead of `Result<i64, E>` — predates typed-errors migration. Scratch-vec design itself is deliberate zero-alloc, keep it. | `std/json.milo jsonParseValue` |

## Dependency notes

- **Byte views (#7) gate the zero-copy form of the JSON byte-feed (#8).** #8 works without it (materialize per event), but hands out copies until #7 lands.
- **`SIGCHLD` (#1) is the cheap prerequisite** for C2's child-exit arm, which in turn unblocks C3 (`timeout` conversion).
- **Compile time (#12) likely wants MIR (Tier 3)** for real wins — profile before committing.
