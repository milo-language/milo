<!-- doc-meta
system: plan
purpose: sequenced attack plan for Tier 2 (core language) and Tier 3 (stdlib doctrine), plus the profile/contracts play
key-files: src/checker.ts, src/lower.ts, src/codegen.ts, docs/verification-roadmap.md, docs/memory-safety-vs-rust.md
update-when: a tier item ships (collapse to a one-liner), or a sequencing decision changes
last-verified: 2026-07-29
-->

# Tier 2–3 plan

A plan, not a backlog. ROI-ranked working items live in [backlog.md](../backlog.md); this file is the *shape* — dependency order and the hard design interactions.

## The axiom this all rests on

Values are closed: nothing aliases in, nothing escapes out. Every item below is a dividend of that. Order the work by what hardens the axiom into a usable substrate — later items get cheaper once earlier ones seal heap facts into constants. See [memory-safety-vs-rust](../memory-safety-vs-rust.md) (§What the compiler does not check) for what the axiom costs, and [ownership-model](../ownership-model.md) for the mechanism.

## Linchpin — resolved

`&mut` exclusivity **is enforced** — `checkCallSiteExclusivity` (`checker.ts:3368`). Field-path-precise, index-aware. Catches `&mut`+`&` and `&mut`+`&mut` on the same-or-contained place; allows provably-disjoint fields and `v[i]`/`v[j]` siblings.

Residual, required by the prover: static enforcement is **syntactic, call-site, arg-origin**. Sufficient for closedness (param list = frame). But index-qualified places can't be proven disjoint statically — `f(v[i], v[j])` with `i == j` gives two live `&mut` to one place, which was a **soundness hole**, not a contract TODO.

**Shipped (`codegen.ts` `emitAliasGuards`, commit `721a2ca9`):** a runtime guard — pairwise `icmp eq ptr` on by-ref arg addresses, abort if an at-risk pair coincides (fires only when ≥1 is mutable). This is what makes `noalias` on `&mut` params sound to emit: index-coincidence aliasing traps *before* the call. The SMT fact the contract prover may still lean on statically is **"distinct roots or divergent field paths,"** never "distinct indices"; the `i != j` proof obligation is the elision target that later removes the runtime check (consistent with the prover having no `IndexAccess` — see [verification-roadmap](../verification-roadmap.md)). Known gap: dynamic-dispatch receiver-vs-arg aliasing (interface `self` is prepended outside `expr.args`).

## Tier 1 — complete

All shipped to main: unary minus, `f64.NAN/INF/NEG_INF` + `isNan/isInf/isFinite`, `replace`/`swap` intrinsics (`take` deferred pending `Default`), `strContains`, `HashMap`, POD copy, integer-repr enums (`enum K: i32`, `k as i32`, `K.tryFrom(n) -> Option<K>`), and the `&mut` aliasing guard above. Most of the original brief already existed — see `[[project_tier1_ergonomics_decisions]]`.

## Sequence

```
what-Rust-wins doc  →  Drop  →  interior iteration (by-value)  →  views  →  newtypes
   [DONE]                              →  SlotMap/handles  →  profile + contracts
```

Standing lane (parallel, not post-Tier-2): safety evidence — ASAN, checker fuzzing, unsafe audit. Fuzzing the exclusivity checker is the ongoing form of the linchpin question; it never "closes."

## Tier 2 — core language

### Drop — CORE ALREADY SHIPPED; two gaps remain
**Do not rebuild this.** `impl Drop for T` compiles, type-checks (rejects builtins/non-aggregates), and runs today. Drops are emitted at function exit, early `return`, `break`/`continue` (loop-scoped), match-arm fall-through, reassignment (drop-old-before-overwrite), and discarded owned temps; move-out zeroes the source + clears a per-local `alive: i1` flag so no double-free. `needsDropCg` is transitive over struct fields / enum payloads / fixed arrays. std already dogfoods it: `File`, `TcpStream`, `TcpListener`, `TlsStream`, `Socket`. Regression pins: `dropAccounting.milo` (exact counts), `dropEarlyReturn`, `dropMatchBinding`, `loopBreakDrop`, `structFieldMoveDrop`. (Codegen: `emitDropValue` ~8592, `emitGuardedDrop` ~9607, `emitDropGlue` ~9595.)

Two real gaps, in priority order:

1. **Std migration — ✅ DONE (2026-07-30).** `Channel<T>`, `AtomicI64/Bool`, `WaitGroup` migrated off manual `destroy()` to Arc-style inlined refcount + `Drop`; `.clone()` to share, frees at last drop; `destroy()` deleted. Cascade fixed (Promise non-Copy, io/fetch pump channels, ~20 share-sites, java-dap). All CI green incl selfhost. **Surfaced a new compiler gap:** `impl Drop for Channel<T>` (a generic trait impl WITH a body) is unsupported — the body is checked eagerly against mangled monomorphizations, not as a template. Worked around with a non-generic `ChannelHandle` wrapper (Channel<T> drops transitively via its field). See [[project_milo_drop_state]].

   **Generic-trait-impls-with-bodies — ✅ FIXED (commit 2ed6eafe, one line).** Dropped the `!impl.traitName` gate at checker.ts:1955; generic trait impls now defer to per-monomorphization (monomorphizeStruct already preserved traitName). `impl Drop for Foo<T>` works; no regressions. **Unblocks interior iteration** (`impl Iterator for MyVec<T>` is the same shape). Fixture: genericTraitDrop.milo. (milo-self lacks the fix — keep out of selfhost-manifest.)

2. **Lexical block-scope / last-use drop (the real semantic gap).** Locals are function-scoped, not block-scoped: a value dies at function/loop epilogue, not at the end of the innermost block where it's last owned. No explicit loop-iteration-end drop (only via redecl overwrite). No static per-branch move tracking — conditional/in-loop move correctness rests entirely on the runtime `alive` flag. Closing this = insert drops at end of innermost owning block, driven by last-use analysis.
   - **Drop × move-on-last-use — one dataflow pass, two consumers.** The same last-use analysis decides *when* the last owner dies (= where the block-scope drop goes) *and* when `body = s` moves. Build the pass once; both read it. Do not ship move-inference first and retrofit.
   - **Drop × coroutine frames.** A `for x in c` frame holds values mid-iteration; early `break` must run pending drops for the partially-consumed container. Design scope-exit semantics with the coroutine lowering in view.
   - Edge to fix while here: a heap-field-less `Drop` struct can't be move-detected by the struct drop helper's null-sentinel (`codegen.ts:8890-8903`) — it leans wholly on the local flag.

> **Test-first re-audit 2026-07-30.** This plan was written against a stale model of the compiler. Three rows below were mostly already shipped; the real work was smaller than written (a theme: Drop, newtypes, iteration all "mostly shipped, gaps smaller than planned"). Audit remaining rows by *testing first*, not designing.

### Interior iteration — MOSTLY SHIPPED (no coroutine needed)
External iteration already works today: `for x in container` where the container has `next(&mut Self): Option<T>` (duck-typed on the method name, checker.ts ~2789). Concrete *and* generic containers verified. Zero-copy over custom containers works via **slice views** (below), not coroutines: a container returns a `&[T]` view of its store and the caller iterates it — Milo's answer to Borretti, no `yield` transform. Remaining: (a) a **formal `Iterator` trait** — small, do it for the *prover* (a nameable thing to specify contracts over "any iterator") + bounds; while formalizing, pin the laws duck-typing left open: `for` stops at first `None` and never calls `next` after `break`; post-`None` SHOULD be fused. (b) `yield`-style generators (the multi-week state-machine) are **backlogged** — the protocol already covers the by-value case; defer until a workload demands hand-writing state machines hurts. Fixed en route: a generic `Vec`-backed iterator double-freed its store (generic struct-lit skipped `tryMove`).

### Views (`&str`, `&[T]`, `&mut [T]`) — SHIPPED
`&str` slicing worked already. `&[T]` slices now work end to end: whole-`Vec`→`&[T]` coercion, `v[a..b]` sub-view, `.len`, indexing, `for-in`, returning a `&[T]` view from a fn (the zero-copy container idiom), and passing a slice **rvalue** straight into a call. `&mut [T]` mutable slices work: `var`-Vec→`&mut [T]` coercion (immutable source rejected, exclusive borrow), writes land in the store. Fixes: `genVecBoundsCheckedPtr` accepts slice types (be83f5e5); `&[T]`→`%Vec` value not `ptr` (3f93eac5); auto-borrow slice ref-args so a `%Vec`-value slice materializes by-ref (f5f7acc6); slice lvalue-index routes through the vec bounds path (6b8fb929). **Remaining: only `splitMut`** — a real design item, not a bug: second-class refs can't return a tuple of two `&mut [T]`, so it needs a callback form (`splitMut(xs, mid, |a, b| ...)`) with disjointness the prover discharges. (backlog T2 #9.)

### Newtypes — SHIPPED (as structural derives, not a keyword)
No new syntax: a **single-field named struct** is the newtype (`struct NodeId { idx: i64 }`). Cross-type safety, zero-cost layout (proven `ret`-only at -O2), and auto-`==` already worked. The real gap was **struct HashMap keys**: shipped structural hash + eq from one field recursion (coherence law `a==b ⟹ hash(a)==hash(b)` by construction; hashes NOT stable across versions/runs). `Ord` deliberately NOT auto-derived — ordering embeds an opinion (field rank); it's opt-in `@derive(Ord)` (future), `sortBy` is the better follow-up. Gates SlotMap typed keys. Nested-generic inference fix (`Vec<T>` field infers at construction) also lands here — gates `SlotMap<NodeId,T>` ergonomics.

## Tier 3 — stdlib doctrine

- **SlotMap + generational handles** = blessed collection for stored/graph/long-lived data. Stale handle → deterministic error. Pair with newtyped keys. Depends on newtypes. The answer to "how do I store references" — idiom, not folklore.
- **Task.join() footgun** — register unconditionally at spawn, or make late join a hard error, not a silent hang. Independent, no design risk; can pull earlier.
- **Move-on-last-use** — folded into Drop's dataflow pass above.

## Profile + contracts (after the frozen-pool/branding substrate)

Sealing turns heap facts into constants → proofs collapse. Build this *after* Tier 2.

- **Profile = restriction dial**, enforced **per-function, module defaults.** Incremental proof only feels incremental if one hot function opts in without dragging its module. Strict forbids: manual `destroy` (Drop only), bare-integer handles, unfrozen-pool deref, `unsafe impl Send/Sync`, optional stack bounds.
- **Contracts = proof dial**, first-order over values (`requires`/`ensures`/quantifiers). **Never expose `∗`/points-to.** Separation is structural in Milo, so users write plain SMT-dischargeable predicates — that invisibility is the whole gift.
- **Check elision — the killer mechanic.** Every contract = runtime assert in debug (zero adoption cost); deleted in release where the prover discharges it. Generational-handle checks become the fallback for unproven obligations, not a tax. Graceful degradation lifetimes structurally can't do.

### Separation logic — exploit by omission
Milo is a smaller decidable fragment of the logic RustBelt encoded into Iris. Disjointness is a *theorem of the language*, not a proof obligation of the program → frame rule = param list → first-order SMT suffices (same reason SPARK skips SL). Uses, ascending:
1. Keep it invisible in user contracts (the point).
2. **Trusted-core soundness.** *Honest sequencing:* full "MiloBelt in Iris" is person-years of specialist work — keep it as roadmap, not near-term. The nearer-term version is a **Miri-analog interpreter** that catches the same stdlib-primitive bug class empirically. Sequence: **interpreter → then maybe Iris.**
3. Bi-abduction (Infer-style) to synthesize unsafe-core/FFI contracts. Speculative; note, don't scope.

Scope contracts to **sequential code first**. Concurrency contracts (channel protocols, atomics) are a research problem — and the green-task model puts most logic in sequential code anyway. Note for later: `ch.send(val)` moving the value *is* CSL's ownership-transfer axiom as a type rule.

Niche this buys: **verified-leaf-library language** — TLS record layer, network-facing parser, seatbelt-grade state machine, freestanding, contracts discharged, no runtime checks left. The SPARK niche without the Ada.

## Acceptance test (Tiers 1–2)

Rewrite the yaml library. Success:
- line-rewriting indentation hack gone
- `.clone()` count down an order of magnitude
- `cloneNode` is one line
- all pool indices newtyped
- no `destroy()` calls in stdlib-using code

Exercises Drop + iterators + views + newtypes together — the integration test for all of Tier 2.
