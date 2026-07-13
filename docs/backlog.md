<!-- doc-meta
system: planning
purpose: ROI/difficulty-ranked lens over outstanding work; a prioritization view, NOT the source of truth for status
key-files: docs/roadmap.md (canonical status), docs/safety-roadmap.md
update-when: an item ships (flip in roadmap.md first, then re-rank here) or a new item is triaged
last-verified: 2026-07-13
-->

# Backlog — prioritized

A **do-next ordering** across the open work. Status source of truth is [roadmap.md](roadmap.md); this file only ranks by return-on-investment vs effort. `Ref` links the canonical entry.

ROI / Effort: **H**igh / **M**edium / **L**ow. Tiers = the quadrant that matters: ship Tier 1 first (cheap + high payoff), invest deliberately in Tier 2, let Tier 3 wait.

## Tier 1 — quick wins (high ROI, low effort) — do first

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 1 | ~~**`checkedDiv/Rem`, `wrapping/checkedNeg`**~~ ✅ shipped 2026-07-13. | M | L | Safe division (None on div-by-zero / signed `INT_MIN`/-1) + unary negation (desugars to `sub(0,x)`, correct signed+unsigned overflow for free). `overflowingAdd/Sub/Mul` (→ `(val,bool)`) still **blocked on tuple support** — no tuples yet. | `checker.ts`, `lower.ts`, `codegen.ts genCheckedDivRem` |
| 2 | **Struct-field + fn docstring pass** on hot modules | M | L | Bare 6502 register fields (`a/x/y/p`) and un-doc'd fns (`busRead`) read as opaque to newcomers. One-line labels close it. Also seeds `milo doc` (#9). | this session |
| 3 | **JSON builder ergonomics** — *mostly done* | M | L | Builder was already complete + symmetric (`str/int/float/bool/nil/obj/arr/val/raw` on both `JsonObj`/`JsonArr`). ✅ 2026-07-13 added `strOpt/intOpt/floatOpt/boolOpt` to `JsonObj` — optional fields now stay in the fluent chain instead of breaking to an `if`. Remaining: `build()` emits `string` not `Json` (read/write paths disjoint) — bridge later. | `std/json.milo` |
| 4 | **Unused import warnings** — *deferred, not loop-sized* | M | M | Resolver strips imports (`resolveImports` returns `imports: []`), so the checker never sees them — needs threading entry-file imports + used-name collection across resolver→checker, **and** still false-positives on node-milo's link-only imports. Wants a real design pass, not a quick pass. | roadmap.md:108 |
| 5 | **`std`-shadows-local fix** | M | L→M | Papercut: a local can be silently shadowed by a std symbol. Correctness + clarity. | memory: papercuts-from-hades |

## Tier 2 — strategic (high ROI, higher effort) — plan & invest

| # | Item | ROI | Effort | Why / unblocks | Ref |
|---|------|-----|--------|----------------|-----|
| 6 | **Borrowed slices / byte views** `&[T]` — *partially shipped* | H | M→H | Vec/string slicing already works: `v[a..b]` → `&[T]` (non-owning `%Vec`, `checker.ts` slice path). **Gaps:** fixed-size arrays (`"cannot slice a fixed-size array yet"`) and generalized byte views for I/O/`Buffer`. Unblocks the zero-copy form of #7. | roadmap.md:109 |
| 7 | **JSON streaming / pull parser** | H | M | Unbounded / multi-GB / NDJSON input has no path today (whole-doc-only, offsets into resident source). Separate state-machine tokenizer; `src-milo/lexer.milo` pattern. Zero-copy variant wants #6. | roadmap: Standard Library |
| 8 | **Iterators** — `.map().filter().collect()` | H | H | Ergonomics everywhere; kills manual index loops. Needs associated types. | roadmap.md:115 |
| 9 | **Doc comments + `milo doc`** | H | M | `///` + generator. DX + real docs; incentivizes the docstrings #2 adds by hand. | roadmap.md:123 |
| 10 | **LSP rename + find-references** | H | M | Daily-driver DX gap. | roadmap.md:122 |
| 11 | **Option ergonomics** | H | M | Frequent papercut; touches nearly all code paths. | memory: papercuts-from-hades |
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

## Dependency notes

- **#6 (byte views) gates the zero-copy form of #7 (streaming JSON).** #7 works without it (materialize per event), but hands out copies until #6 lands.
- **#2 (hand docstrings) → #9 (`milo doc`):** do #2 opportunistically now; #9 makes it systematic.
- **#13 (compile time) likely wants MIR (Tier 3)** for real wins — profile before committing.
