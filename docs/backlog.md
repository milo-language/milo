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
| 1 | **Flip overflow traps ON by default in release** | H | M | **`--overflow-checks` SHIPPED 2026-07-16** — traps at any -O; `tests/overflowChecks.test.ts` pins both halves against `--release` (wrap by default, trap with the flag). What remains is the DEFAULT flip, which needs a benchmark I could not get honestly. **Measured so far:** the compiler proves most arithmetic safe and emits no check at all — `matmul` emits ZERO traps even with the flag on, and a loop whose `acc` is bounded by `% 1000000007` emits none either. Only operands it cannot range-bound get a check. Worst case, arithmetic-dominated with unprovable ranges (operands from a Vec), 400M iterations: **0.37s -> 0.40s, ~+8%**. Real benchmarks (fib/binarytrees/json/grep DO emit checks; matmul does not) are sub-0.3s and I could not measure them credibly — this box had 5 competing agent processes, and I produced four invalid measurements before catching each (backwards timings, checks-not-emitted, a folded loop, and swallowed `time` output). **Do the benchmark on a quiet machine, with the emulators as the stress case, before flipping.** **DECIDED 2026-07-17 — direction is settled: flip to trap-by-default (Ethos #1, silent release wrap is the one inherited footgun); `wrappingAdd`/`saturatingAdd`/`checkedAdd` stay for intentional wrap.** The quiet-box benchmark is confirmation of the worst-case number, not a veto on the direction — so this is now an execution/measurement task, not an open decision. | `src/main.ts` overflowChecks, `docs/graydon-review.md`, `docs/design.md` (Ethos + Graydon §) |
| 2 | **`std/smt` can't decide past ~2^62** | M | H | **No longer unsound** — `combineTerm` detects the i64 overflow and the verdict degrades to `unknown` instead of a false `proven`. What remains is capability: Fourier-Motzkin multiplies constants, so anything near 2^62 overflows and the answer is lost. That is why `verify.ts` omits i64/u64 param ranges — with them on, a genuinely broken call reports `unknown` instead of its counterexample. Needs wider arithmetic (i128/bignum) in the elimination. | `std/smt.milo combine`, `verify.ts INT_RANGES` |
| 3 | **Prover models ints as unbounded, params only** | M | H | `verify.ts` now asserts each int param's real range, which killed the `fpMul` false alarms — but **intermediate arithmetic carries no range**, so `error = setpoint - measured` (two i32s) can reach -2^32 in the model and refute a call that no real i32 could. That is the whole `pidStep` baseline entry. Needs range-carrying arithmetic or a bitvector model. **TRAP — do not "fix" this by asserting local ranges the way params get them.** Params are safe to bound because they are inputs. A DERIVED value is not: assert `(>= error -2147483648)` on `error = setpoint - measured` while the arithmetic is modelled as unbounded `Int`, and every overflowing (setpoint, measured) pair becomes UNSAT — silently excluding exactly the inputs that matter. The prover then reports an unconditional `proven` for a claim that only holds when nothing overflows. That is a FALSE PROOF, the same class as the `combine()` overflow that made std/smt report UNSAT on a wrapped row (see tests/prove/overflowNoFalseProof.milo). The two honest routes stand: range-carrying arithmetic (derive the bound, do not assume it) or a bitvector model (model the wrap). | `verify.ts intRangeAssumption`, `miloTypeToSmt` |
| 4 | **Extern fn parameters are unverified** | M | H | The audit now covers **return types** on both platforms (CI runs it on macOS + Linux), and std is clean — so `@cSig`'s remaining gap is the Milo-param ↔ C-param mapping, which `cSigGuard` documents as unchecked (its two asserts cover the stated-signature-vs-header claim and the return type only). Needs a C parser to introspect a function type's parameter list; `__builtin_types_compatible_p` on the whole signature is exact but only when the C signature is hand-written (`@cSig`). Nothing cheap left here. | `scripts/audit-extern-returns.ts`, `src/codegen.ts cSigGuard` |
| 5 | **Cross-compiling hosted targets needs a sysroot** | M | H | `--target` now reaches clang and a cross build fails loudly with a hint (was: silently emitted a host binary and reported success). Actually *doing* it needs a target linker + sysroot; the compiler has no `-I`/`-isysroot`/`--sysroot` notion at all. Until then, build on the target. Also what blocks cross-target `@cLayout`/`@cSig` verification, which warns and skips. | `src/main.ts clangTargetFlags`, `linkIR` |
| 6 | **Lazy iterator adapters + generalize `map`/`filter` beyond Vec** | M | H | **Retitled — the old entry ("`.map().filter().collect()`, needs associated types") was wrong on both halves.** Chaining already works and is a passing fixture: `tests/fixtures/vecChain.milo` runs `nums.filter(...).map(...)`. Shipped on Vec (checker's MethodCall arm in `checkExpr`): `map`/`filter`/`each`/`enumerate`/`find`/`any`/`all`, closures included. **Associated types are not needed** — a structural iterator protocol already exists (for-in accepts any struct/enum with `next(&mut Self): Option<T>`, resolved via `resolveMethod("next")`; `Channel<T>.next` in `std/sync.milo` uses it), and the `Option<T>` return supplies the item type an associated type would have. No `.collect()` because `map`/`filter` return an owned `Vec<T>` directly. Real remaining work: no `reduce`/`fold`/`sum`/`take`/`skip`/`zip`; combinators are gated on `objType.tag === "vec"`, so arrays/slices/maps/user types are excluded. **Lazy/fusing adapters are deliberately out** (Graydon review decision #2): eager Vec-returning stages stay — laziness buys perf only via aggressive inlining and would pull associated types into the trait system. | `checker.ts checkExpr` (vec MethodCall arm), `tests/fixtures/vecChain.milo`, `docs/graydon-review.md` |
| 7 | **Byte views for I/O interop** | H | M | Vec/string/array slicing all shipped (`arraySlice`/`vecSlice`/`stringSlice` fixtures). Remaining: generalized byte views for I/O/`Buffer`/`ArrayBuffer`. Unblocks the zero-copy form of #8 (JSON byte-feed). | roadmap: Borrowed slices / byte views |
| 8 | **JSON incremental byte-feed** | H | M | `jsonPull` shipped (string-backed). Remaining: incremental feed for unbounded input (socket/multi-GB) — a reader layer over the same tokenizer. Hands out copies until #7 (byte views) lands. | `std/json.milo jsonPull`, roadmap: Standard Library |
| 10 | **Flow-sensitive invalidation tracking** | H | H | Compile-time catch of aliased mutation / use-after-invalidate — the aircraft-grade safety tier. | roadmap.md, safety-roadmap.md |
| 11 | **Compile-time reduction** | H | H | **PROFILED 2026-07-16 — no longer diffuse.** Self-host (20k LOC): frontend 0.38s, clang -O2 **7.3s (95% of build)** on 493k lines of IR from 905 fns. NOT generics — only 8 monomorphized instances exist, so de-monomorphizing buys nothing. Three concrete levers, in order: (a) `src-milo/codegen`'s string-compare dispatch chains — `genMethodCall` alone is 50k IR lines (10% of total), top-3 fns are 25%; interned method IDs / jump table is a *Milo-source* fix. (b) `String` by-value shreds structs: 90k insertvalue/extractvalue churn. (c) MIR to pre-shrink load/store before LLVM (Tier 3). | memory: papercuts-from-hades, scratchpad profile 2026-07-16 |

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
- **Const/value generic params** — Milo generics are type-only; bun-rs audit (2026-07-17) found 1,120 `const B: bool`-style sites (js_parser lexer monomorphizes over 9 const bools for perf). Workaround: runtime bools (perf loss) or hand-duplication. Only surfaced gap that's a real language feature; weigh against Ethos #3 when a concrete Milo need appears.
- **`std/decimal`** — scaled-i128 decimal for financial math; stdlib only, no compiler change ("every language discovers the long way that financial math is special" — graydon-review.md #4)
- **Explicit tail calls (`become`)** — never implicit TCO; LLVM `musttail` now works and Milo has no ABI-stability constraint; primitive for composable state machines (graydon-review.md #4)
- **`@derive` on enums** — enums parse attributes but nothing consumes them; now a hard error rather than a silent no-op (`checker.ts validateAttributes`). Implement if wanted (`checker.ts processDerives` walks only structs, and skips generic ones).

## Concurrency & TUI findings (2026-07-15, tmuxClone/splitPty session)

Surfaced building a terminal multiplexer (`examples/apps/tmuxClone.milo`) — the
primitives carried it, but these gaps are where the friction was. Ranked.

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| C4 | **`Process.wait()` blocks the whole scheduler thread** | M | M | `Process.wait` is `waitpid(pid, buf, 0)` — from a green task that wedges every other task on the thread, not just the caller. `Pty` already works around the sharp case (kill -> close master to unwedge -> reap). **The prerequisite is now done**: self-pipes are per-signal (they were one global, which cross-wired SIGWINCH onto SIGCHLD's fd), and the event-driven child wait is proven end to end (`selectChildExit.milo`; `examples/cli-tools/timeout.milo` for a real use). **The open design question, not a coding gap:** the green path needs a SIGCHLD self-pipe, and `installSignalPipe` sets a PROCESS-WIDE disposition — `Process.wait()` cannot quietly install one behind a caller who has their own SIGCHLD handler, and re-installing replaces their pipe. Needs a decision first (an opt-in `waitAsync`, a runtime-owned SIGCHLD reaper that fans out, or documenting "install it yourself"), then the conversion is mechanical. **DECIDED 2026-07-16:** the runtime owns SIGCHLD, installed at `schedulerEnsureInit`. **It must NEVER `waitpid(-1)`** — that would steal exit statuses from other reapers; the real ones in-tree are `std/pty.{darwin,linux}` (`waitpid(childPid, …, 0)`), `std/process` (`system()` and `Process.wait`), and **`examples/cli-tools/parallel.milo:99`, which itself blind-reaps with `waitpid(-1, status, 0)`**. (A previous revision of this note claimed parallel.milo didn't exist — wrong: it is under examples/, not std/.) `system()` blocks SIGCHLD and waits its own pid, so a per-pid WNOHANG reaper never races it; that is precisely why 'never -1' is the load-bearing rule. The reaper only wakes registered waiters, each doing `waitpid(itsOwnPid, WNOHANG)`. A caller installing its own SIGCHLD handler must be a HARD ERROR, not a silent replacement that hangs every green wait. **DECIDED 2026-07-17 — no separate `waitAsync`: the green path goes straight into `Process.wait()`, gated on `schedulerCurrent() != 0` (main-context wait stays the identical blocking `waitpid`).** This preserves `wait()`'s observable contract (block until exit, return status) and only changes the parking mechanism in green context — same shape as `readFd` (`std/os.milo:306`); it's a wedge fix, not a semantics change, so the incremental-API rule doesn't require a parallel API. `timeout.milo` migrates from its own SIGCHLD self-pipe (95160f8) to the runtime-owned path as part of this — mechanical debt, not a design question. | `std/process.milo Process.wait`, `std/runtime.milo schedulerEnsureInit` |

**Known limitation (not a bug):** on split/resize the daemon rebuilds every pane grid at the new width (shells repaint via SIGWINCH), so on-screen content of *other* panes is cleared at that moment (still live in each shell's own history). True content reflow across a resize is a later polish.

## Ergonomics findings (2026-07-16, ugly-code audit)

| # | Item | ROI | Effort | Detail | Ref |
|---|------|-----|--------|--------|-----|
| E1 | **Named enum-variant fields** | H | M | `ForEach(string, Option<string>, TypeKind, Option<TypeKind>, Heap<HIRExpr>, string, Vec<Heap<HIRStmt>>, Option<Span>)` needs a trailing comment decoding the slots. Hits the self-hosted compiler hardest (HIR/AST are all sum types). Rust-style `ForEach { varName: string, ... }`. **GREENLIT 2026-07-17 as a language feature (Ethos #2, readable sum types) — but it is a real addition, not a papercut: parser + checker + formatter + LSP (definition-of-done), and it queues behind the drop-glue slice-2 leak fix.** | `src-milo/hir.milo HIRStmt.ForEach` |
| E2 | **Raw-pointer sugar: `ptr == null` + `ptr.offset(n)`** | M | L | Null check today is `dir as i64 == 0 as i64` (both sides cast); pointer arithmetic is `(ent as i64 + nameOff) as *u8` (three casts). Recurs across `fs`/`cstr`/`env`/`runtime`/`sync`/`crypto`. Confined to the FFI seam, but the ugliness is accidental, not deliberate friction. | `std/fs.milo readDir` |
| E3 | **Type-alias hygiene sweep** | M | L | Language has `type X = ...` (`TypeAlias` in `src/ast.ts`); `std/` + `src-milo/` use it zero times. `Vec<Heap<Stmt>>` is spelled verbatim ~37× (13 of those inside `Option<...>`) — one `type Block = Vec<Heap<Stmt>>` kills it. Pure code debt. | `src-milo/checker/stmt.milo checkReturn` |
| E4 | **Codegen context struct** | M | M | `locs/sigs/retTy` + 4 label params copy-pasted through every `gen*` fn (`genForInHashMap` takes 13 params). Fold into a `GenCtx`. | `src-milo/codegen/stmt.milo genForInHashMap` |
| E5 | **`jsonParseValue` err flag → `Result`** | L | L | Parser threads `err: &mut bool` through its recursive signatures instead of `Result<i64, E>` — predates typed-errors migration. Scratch-vec design itself is deliberate zero-alloc, keep it. | `std/json.milo jsonParseValue` |

## Dependency notes

- **Byte views (#7) gate the zero-copy form of the JSON byte-feed (#8).** #8 works without it (materialize per event), but hands out copies until #7 lands.
- **The child-exit arm is the pattern to copy** for any event-driven child wait: `installSignalPipe(sigchld())` + `sel.onRead(fd)` + `waitpid(..., WNOHANG)` (`tests/fixtures/selectChildExit.milo`, and `examples/cli-tools/timeout.milo` for a real use incl. the fork/inherit hazards).
- **Compile-time reduction likely wants MIR (Tier 3)** for real wins — profile before committing.

## milojs: Array change-by-copy methods (ES2023) — gap, and why the easy fix fails

`with`, `toReversed`, `toSorted`, `toSpliced` are missing. Found by the QuickJS
sweep (`with is not a function`, 3 cases).

They cannot be added to `lib/engine-prelude.js`. Array methods are natives
dispatched by a **name whitelist** in `eval.milo` (`isArrayMethod`, ~line 6349),
and member lookup on an array never falls back to `Array.prototype` — so
`Array.prototype.with = ...` in the prelude is unreachable dead code. I wrote
that version, watched it have no effect, and backed it out.

Adding them means implementing natively: extend the whitelist and add the cases
alongside `findLast`/`findLastIndex`. Each is pure array shuffling; the only
subtlety is spec index handling — a negative index counts from the end, and a
fractional or out-of-range index throws `RangeError` rather than clamping.

Worth noting for anything else "missing" from the sweep: check whether the
method is prototype-dispatched or whitelisted before assuming the prelude is the
place to put it.

### Not gaps, despite the sweep's wording

`concat`, `sort`, `apply`, `toString`, `escape` all work on ordinary receivers —
those sweep failures are on unusual receivers (typed arrays and similar), not
missing methods. Probe before implementing.

### Math.fround stays out

The existing exclusion comment in the prelude is correct and should not be
"fixed": rounding to f32 needs a bit-level reinterpret the engine has no
primitive for. The usual JS workaround, `new Float32Array([x])[0]`, is not
available either — `Float32Array` is not implemented.

## milojs: built-in constructors have no real `.prototype`, so `.constructor` is missing

Probed against node:

| expression | node | milojs |
|---|---|---|
| `new C().constructor === C` (user class) | true | **true** |
| `({}).constructor === Object` | true | false |
| `[].constructor === Array` | true | false |
| `Object.getPrototypeOf(new TypeError("x")) === TypeError.prototype` | true | false |
| `typeof TypeError.prototype.constructor` | `"function"` | throws — `TypeError.prototype` is `undefined` |

The last row is the root cause. Built-in constructors are natives with no
prototype object behind them, so there is nothing to hold a `constructor`
property and nothing for `getPrototypeOf` to return. User-defined classes work
because class construction sets `constructor` itself.

Found while writing the ES2023 array fixture: `catch (e) { e.constructor.name }`
throws here, and the fixture had to use `e.name` instead. `err.constructor ===
TypeError` is a common branch in library code, so this is app-relevant and not
only a conformance detail — it is a plausible cause of a library taking a wrong
error path rather than failing loudly.

Not a one-liner: it means giving Object/Array/Error and the Error subtypes real
prototype objects wired to their natives, which touches construction, the
prototype chain and `instanceof`. Worth doing as its own slice with the app
smoke test, not folded into an unrelated change.

Related: several QuickJS sweep failures reported as `X is not a function` are
methods called on unusual receivers rather than missing methods (see the
change-by-copy note above). Probe before implementing.
