<!-- doc-meta
system: planning
purpose: work plan for closing the three safe-code memory holes found 2026-09-19, the prover false-failed verdict, and the gates that keep them closed
key-files: tests/holes-2026-09/, src/checker.ts, std/shard.milo, src/verify.ts, scripts/fuzz-ownership.ts, scripts/asan-sweep.ts
update-when: a work package ships, is re-scoped, or its gate changes
last-verified: 2026-09-20 (every WP shipped and merged; F5 at fc7bc3d0; the reproducers are error tests and prove fixtures, tests/holes-2026-09 deleted)
-->

# Soundness sweep, September 2026

Baseline commit `284606cc`. Five reproducers lived in `tests/holes-2026-09/`; each work
package (WP) below names the reproducer it had to turn from red to green. The directory was
deleted in `470f5d73` once every file in it had become an error test or a prove fixture.
**Status 2026-09-20: every WP below has shipped** (closing commit in each heading; the user-facing
account is `docs/memory-safety-vs-rust.md` findings #3 to #10). Lane F's F5 split shipped at
fc7bc3d0.

## The holes

| # | Reproducer | Symptom at HEAD | Root cause |
|---|---|---|---|
| H1 (closed `b647ee2d`) | `hole1-shard-string-double-free.milo` | exit 133, malloc abort | `std/shard.milo:89` `Shard.get` does `unsafe { self.base[i] }`: bitwise copy of a Drop `T`. Arena is fine because it indexes a `Vec` and Vec indexing clones. |
| H2 (closed `1ad69973`) | `hole2-shards-owner-dropped-under-worker.milo` | worker writes 2.0 into a freed buffer; a fresh `Vec` reusing it prints 2 not 9 | `Shards` is implicitly droppable while windows are outstanding. The docs of the day carried a "keep the owner alive" obligation instead of a rule. |
| H3 (closed `742bf8fd`) | `hole3-global-forin-across-yield.milo` | prints `1, 4, 0` from a freed buffer | for-in freeze on a mutable global is interprocedural but not cross-task: body yields, another task pushes, buffer reallocates. |
| H4 (closed `c3d08e36`, round 2 `0503023d`) | `hole4-vec-ptr-outlives-realloc.milo` | ASan heap-use-after-free, no `unsafe`, no thread, no generic | `v.ptr()` / `s.cstr()` return `*T` in safe code with no provenance; `push` reallocates; a scalar-returning extern reads the stale pointer. Found 2026-09-19 by independent review. |
| H5 (closed `67392368`) | (found by WP5b, 2026-09-19) `Option.Some(v[0])` / `f(v[0])` on a `Vec<Res>` where `Res: Drop` | made 1, gone 3: the element is copied out and every copy runs Drop | the "cannot take a Drop element out of a container by index" rule fires only at `let`; an IndexAccess consumed by value anywhere else (call arg, enum payload, struct field, return, assignment) is an implicit bitwise copy. Pure-checker hole. |
| H6 (closed `c6412f83`) | (found by WP5b) `Channel<Res>` with undelivered payloads | made N, gone 0 | `std/sync.milo:95` `impl Drop for ChannelHandle` frees `buf` without dropping the payloads still queued. Leak class. `promiseRace` losers are the same. |
| H7 (closed `384c935c`) | (found by WP9) `impl Add for Res { fn add(self: Res, other: Res) }` when the trait declares `&Self` | `v[0] + v[1]` printed `8703489800`, gone 5 | impl method signatures are not checked against the trait's; the operator passes operands by reference, the by-value body reads garbage and runs extra drops |
| P1 (closed `ae1a86d0`) | `prover-push-ensures-false-counterexample.milo` | `push1` postcondition **failed**, counterexample `v_len__mut1 = 0` | builtin `Vec.push` has no contract; havoc reports as a counterexample instead of `unknown`. |
| P2 (closed `ae1a86d0`, `ec108569`) | `prover-push-reports-failed-not-unknown.milo` | `main` precondition **failed**, counterexample `len = -1` | same; a length symbol has no `>= 0` assumption after havoc. |

All three memory holes are seams, as `design.md` predicts: unsafe generic × Drop `T`;
owner drop × OS thread; scheduler × global freeze. Zero holes found in the pure checker
surface (moves, second-class refs, call-site exclusivity, closure escape, `@thread`
boundary) across 16 adversarial programs. Continue.

## Lanes

Four lanes run in parallel, one worktree each. Inside a lane the packages are serial.
Merge order matters only for lane A: it lands first so every fix is measured against a
gate that was seen red.

```
lane A  gates      WP5a → WP5b → WP5c                 (no checker edits)
lane B  effects    WP1                                (checker: thread-boundary region)
lane C  attributes WP2 → WP3 → WP4                    (WP2/4 checker attr region; WP3 std/shard only)
lane D  prover     WP6                                (verify.ts only)
lane E  docs       WP7   after B and C merge
```

Lanes B and C both edit `src/checker.ts` in different regions (`checkThreadBoundary`
near line 3975 and the global-iteration walk near 3793-4430 for B; attribute parsing
near 1557/2249/2314 and `resourceKind`/`isAllCopyStruct` near 912-958 for C). Rebase
conflicts are expected to be textual, not semantic.

Every WP: `bun test` green, `bun scripts/asan-sweep.ts --all` green, the lane's own new
gate green, `./milo fmt` clean, and `milo lang --json` still lists every attribute the
WP added (there is a test for the vocabulary). `src-milo` is frozen (proof-only per
`selfhost-endgame-decision.md`), so no mirror edits.

---

## Lane A: gates first

### WP5a: promote the reproducers and the battle test into CI (shipped `9bfa4346`)

- Move the three `hole*` files under `tests/fixtures/` with `// @expect:` lines that
  describe correct behaviour (H1: the program must not build, so it becomes
  `tests/errors/` once WP2 lands; until then it is a known-red fixture listed in a
  `tests/known-red.txt` the driver skips and reports).
- Add the 13 probes from `docs/memory-safety-vs-rust.md` as fixtures or error tests
  where they are not already. Document is not a gate.
- Wire `bun scripts/asan-sweep.ts --all` into `package.json` `test:asan` and into
  whatever CI script `scripts/build.sh` drives. Confirm it fails on H2 at HEAD before
  merging (gate audit rule).

Done: `tests/known-red.txt` carried `hole1`..`hole3` and the ASan sweep (which ignores the
list) showed them red until WP1/WP2/WP3 landed; the list is empty at `1edda9fe`, and `bun run
test:asan` plus the 13 probes (`tests/errors/useBeforeInit`, `tests/runtime-errors/vecIndexOutOfBounds`, ...) run in `ci.yml`.

### WP5b: `scripts/fuzz-generic-drop.ts` (shipped `fba824a6`)

Would have caught H1 on the first run.

- Enumerate every `pub` generic fn and generic struct method in `std/` via
  `milo api --json` (do not import `src/*.ts`; `docs/json-api.md`).
- For each, instantiate `T` with `string` and with a `Drop`-counting struct (reuse the
  accounting oracle from `scripts/fuzz-drops.ts`), call it through its documented
  happy path (alloc/get/set/free, shatter/windows/weld, seal/span/text, and so on),
  build with `--sanitize`, run, and require: ASan clean, drop count balanced.
- Generic fns whose happy path cannot be derived mechanically go in an explicit
  seed table in the script, not skipped silently. The script prints how many symbols
  it covered versus how many exist; that number is the visible gate metric.

Done: reported H1 red at `284606cc` and found H5 and H6 on its first pass; at `1edda9fe`
`covered 100 / 109 generic pub std symbols (92%)`, 180 programs ASan-clean with balanced drop
accounting, 21 rejected by the checker (0 inside std/); the 9 uncovered are the `@copyOnly`
shard family, rejected at instantiation as designed.

### WP5c: `scripts/fuzz-tasks.ts` (shipped `06143d42`; CI step `28c7761e`)

Would have caught H2 and H3.

- Generator over: mutable globals of `Vec<i64>` and `Vec<string>`; `Task.spawn`;
  `schedulerYield` / channel ops / `sleepMs` inside loop bodies; `for x in g`, slices
  `g[a..b]`, index reads; `Promise.blocking` workers; `shatter`/`windows`/`weld` with
  windows dropped, duplicated, or outstanding while the owner goes out of scope.
- Programs contain zero `unsafe` blocks. Oracle: `--sanitize` build, ASan report of
  any kind is a failure. Same accept-direction asymmetry as `fuzz-ownership.ts`: a
  program the checker rejects is counted, not investigated.
- Seed the corpus with `hole2` and `hole3`.

Done: reproduced H2 and H3 at `284606cc` on the seed corpus and found the five WP11 reds on
its first pass at `1a52b6f0`; at `1edda9fe` every generated program is either rejected by one
of the sweep's rules (`@parks`, pointer views, `shatter` private) or ASan-clean, zero red;
`ci.yml` runs `--n=100` per push.

---

## Lane B: effects

### WP1: `@parks` and the cross-task freeze rule (closes H3; shipped `742bf8fd`)

Rule, stated once: **an element view of a mutable global may not be live across a call
that can park.** Element views are what `placesOf` already knows: a for-in binding, a
slice, a `&`/`&mut` into an element. A `&mut` to the global's header is not an element
view and stays legal (the header survives a realloc; the buffer does not).

- `std/runtime.milo`, `std/sync.milo`, `std/select.milo`, `std/time.milo`,
  `std/io`-family: annotate every primitive that can park the current task with
  `@parks`, next to where `@thread` already sits. `schedulerYield`, `await`, channel
  send/recv, `Select.wait`, `sleepMs` if green-aware, blocking fd reads that yield on
  EAGAIN.
- `src/checker.ts`: compute a transitive "may park" summary over the same call graph
  the `writes` map uses (the walk near line 3793 that reports
  `'f' writes the global 'g', which is being iterated here`). Then in that same walk:
  a may-park call inside a for-in over a mutable global, or while a slice or element
  ref of one is live, is an error. Message shape: `'recv' can park this task while
  the loop variable is a reference into 'g's buffer; another task may push to 'g'
  before it resumes`. Hint names the fix: iterate by index, or snapshot with
  `.clone()`, or move the global into a task-owned value.
- Attribute plumbing: `src/attributes.ts`, `lang-info.ts` vocabulary, formatter, LSP
  hover (attrs are generic; verify, do not assume).
- Tests: `tests/errors/` for the direct form, the two-calls-deep form, and the slice
  form; a fixture for the index-loop rewrite that must still compile and print the
  right thing.
- Docs: `language-reference.md` "Thread boundaries" section gains `@parks`;
  `proposal-task-shared-state.md` Option 1 marked shipped and its "already safe"
  sentence corrected; `design-insights.md` payout 3 gets the caveat.

Bennett's razor applies: stop at the declared `@parks` boundary; do not model what
the scheduler does inside.

Done: `tests/errors/globalForInAcrossYield.milo` (plus the two-deep, slice and
unannotated-wrapper forms); `fuzz:tasks` reports the `h3-*` shapes as checker-rejected;
`examples/` and `~/git/hades` compiled at merge (`936b167a`).

---

## Lane C: attributes (serial)

### WP2: `@copyOnly` on generic types (closes H1; shipped `b647ee2d`)

The language has no `T: Copy` bound and should not grow a bounds grammar for one
case. An attribute is the existing spelling for "this struct is move-tracked
regardless of fields" (`@noCopy`); its dual is cheap.

- `@copyOnly` on a generic struct or fn: instantiating `T` with a type that is not
  structurally Copy is a compile error naming the type the user wrote, not the
  mangled instance (backlog Tier 1 #33 is the same complaint; fix both).
- Apply to `Shard<T>`, `Shards<T>`, `parallelMap`, `parallelMapWith`. Audit every
  other `unsafe` block in a generic `std/` fn that indexes a raw `*T`: `grep -n
  'unsafe' std/*.milo` filtered to generic contexts. Each is either `@copyOnly` or
  rewritten to clone-and-drop-old. List the audit result in the PR.
- `tests/errors/shardStringRejected.milo` from `hole1`.
- Docs: `language-reference.md` attribute table, `ownership-patterns.md` pattern 5
  gets a sentence on the dual.

### WP3: close the manual shard path (closes H2; shipped `1ad69973`)

Decision 2026-09-19 (owner, after independent review): no new attribute. `@linear` /
`@mustConsume` would be a compile-time must-consume mechanism with one user; un-`pub`
of the manual path is sound, costs no vocabulary, no runtime, and deletes surface
area. Census: manual `shatter`/`windows`/`weld`/`reclaim` users outside std are 0
examples, 4 fixtures, 3 benchmarks.

- `std/shard.milo`: `shatter`, `shatterStr`, `Shards`, `StrShards`, `WeldRejected`,
  `StrWeldRejected` and their `windows`/`weld`/`reclaim` become module-private. Public
  surface is `Shard<T>`, `StrShard`, `parallelMap`, `parallelMapWith`, `Mapped`, and
  ONE new closed-form string fn, `parallelScanStr(s, windows, overlap, f)` (name to
  taste, same shape as `parallelMap`), so `benchmarks/strscan/scan_par.milo` keeps its
  capability. `WeldReason` stays pub only if `parallelMap`'s error type still exposes
  it; otherwise private.
- If the language has no module-private for a `pub struct`'s methods, the smallest
  spelling that hides them wins (drop `pub` on the struct and on `shatter*`; check what
  `milo api --json` then lists).
- Fixtures `shardWeld`, `shardWeldRecover`, `strShardScan`, `strShardWeldCoverage` and
  the three benchmarks are rewritten onto the closed forms; the weld-refusal recovery
  coverage they gave moves to a std-internal test if `tests/` has a convention for
  one, else it is dropped and the reason recorded.
- `hole2` becomes `tests/errors/shardsManualPathPrivate.milo`: the program must not
  build because `shatter`/`windows`/`weld` are not exported.
- `docs/residue-vs-rust.md` §2 loses the "keep the owner alive" obligation (the
  residue is gone, not enforced); `docs/ownership-patterns.md` third row of the test
  shrinks; `std/shard.milo` header; `docs/breaking-changes.md` entry; the `shatter`
  hint text in `src/` that points users at `parallelMap` is now the only path, reword.

Done: `tests/errors/shardsManualPathPrivate.milo` (`'shatter' is private to shard.milo`);
`milo api --json` at `1edda9fe` lists none of `windows`/`weld`/`reclaim`/`shatter*`; the four
fixtures and three benchmarks build on `parallelMap`/`parallelScanStr` with unchanged output
(`docs/breaking-changes.md` entry of 2026-09-19).

### WP4: raw-pointer fields make a struct move-only (shipped `5380391c`)

Breaking change (`docs/breaking-changes.md` entry). Today a struct of scalars is
Copy; a raw pointer is a scalar; so an owning handle is Copy unless someone
remembers `@noCopy`. Census at HEAD: 23 pointer-holding structs in `std/` and
`examples/` without it. `Task`, `WaitGroup`, `Once`, atomics are saved by their
`Drop` impls. `Lib`, `Database`, `Statement`, `Select`, `CStr`, `Screen` are
copyable owning handles.

- New rule in `isAllCopyStruct`: a field of raw pointer type makes the struct
  move-tracked unless the struct carries `@copy`. `@cLayout` structs passed by value
  to C keep Copy implicitly (they are C's, not ours); decide and document.
- Sweep: every struct the census names either gets `@copy` with a one-line reason
  (`CStr` is a non-owning view; `Kevent` is C's) or becomes move-only and its call
  sites are fixed. Most `@noCopy` uses become redundant; delete them.
- `scripts/` gets the census as a permanent lint (`unowned-pointer-copy`), off by
  default, promotable with `--deny=`.

Done: no `@noCopy` attribute remains in `std/` or `examples/` (every surviving mention is
a comment; the attribute lives on in `tests/` for the integer-handle case), 23 structs swept, `@copy` on `CStr` and `Kevent` with
reasons, `--deny=unowned-pointer-copy` lists them; `scripts/run-examples.ts` green at merge
(`73997550`). Left behind: backlog Tier 1 #35 (enum with a pointer payload is still Copy).

---

## Lane B2: raw-pointer provenance

### WP8: `ptr()`/`cstr()` results are element views (closes H4; shipped `c3d08e36`)

Rule: a `*T` obtained from `v.ptr()`, `s.cstr()`, `h.ptr()` and bound to a name is an
element view of its source under `placesOf`, exactly like a for-in binding. While the
binding is live, the source may not be mutated (`push`/`pop`/`clear`/index-assign via
`&mut`), reassigned, moved, or dropped. Inline use as a call argument (`f(v.ptr())`)
has no binding and stays legal. A cast (`as i64`) forwards provenance (placesOf already
does). Message shape: `'v' may reallocate here while 'p' still points into its buffer
(from 'v.ptr()' on line N)`; hint: take the pointer after the last mutation, or call
the extern with `v.ptr()` inline.

Census at HEAD: 49 call sites in std+examples, 15 bound to a name. Every one must
still compile or be a true positive listed in the PR. Requiring `unsafe` instead was
rejected: 49 edits that label the hazard and prevent nothing.

Done: `tests/errors/vecPtrOutlivesRealloc.milo`, `cstrOutlivesPush`,
`ptrCastOutlivesRealloc`, `ptrOutlivesIndexWrite`, `ptrOutlivesReassign`,
`ptrOutlivesMutSelfMethod`; the 15 bound sites compile; `fuzz-tasks.ts` carries the
`h4-*` shapes (they are what found the five WP11 gaps).

---

## Lane C2: pure-checker copy-out (found by WP5b)

### WP9: an IndexAccess consumed by value is a move-out, everywhere (closes H5; shipped `67392368`)

The rule already exists for `let x = v[i]` (checker.ts ~919, `resourceKind`). Move it to
the one place every by-value consumption of an expression passes through (call
arguments, enum payloads, struct-literal fields, `return`, assignment RHS, closure
captures, match scrutinee if it copies, binary operands if a struct can reach one), so
`Option.Some(v[0])` and `f(v[0])` get the same error as the `let`. Same message. Borrow
forms stay legal: `v[0].field`, `v[0].method()`, `g(v[0])` where `g` takes `&Res`.
Gate: WP5b's `fuzz:generic-drop` findings for `Arena.get/modify`, `arenaGet`,
`frozenGet`, `FrozenArena.get`, `GrowOnlyArena.get`, `HashSet.toVec/clone` go from
red to either green (std rewritten to clone explicitly or return a borrow) or to
"rejected inside std", and a `tests/errors` case for each spelling. Expect std to need
edits: those seven sites are copying Drop elements today.

### WP10: Channel drop destroys undelivered payloads (closes H6; shipped `c6412f83`)

`std/sync.milo` `impl Drop for ChannelHandle`: run `T`'s drop glue on every element
still between head and tail before `free(buf)`. `promiseRace` losers follow. Gate:
`fuzz:generic-drop --filter=Channel` and `--filter=promiseRace` balanced.

---

## Lane B3: raw-pointer provenance, round 2 (found by WP5c)

### WP11: pointer views join the one view list (closes five WP5c reds; shipped `0503023d`)

WP8 tracked `ptr()` bindings in the freeze machinery; WP1 tracked for-in and slice
bindings in the global walk. Two lists, same concept, five gaps between them. One rule:
**a `*T` produced by `ptr()`/`cstr()` is an element view of its source for as long as
any holder of it is live, and every check that asks "is a view of X live" asks one
list.** The reduced programs (all zero `unsafe`, all ASan red at `1a52b6f0`):

1. `let p = g.ptr(); writer()` where `writer` pushes to global `g` (h4-global-callee-push).
   The writes summary already knows `writer` writes `g`; the global walk must see the
   pointer holder as a view. Same fix closes 5.
2. `growRead(v.ptr(), v)` with `v: &mut Vec<u8>` (h4-inline-alias). An inline `ptr()`
   argument is a shared borrow of `v` for the call; call-site exclusivity must reject it
   against a `&mut v` argument in the same call.
3. `let p = v.ptr(); take(v); strlen(p)` (h4-ptr-then-move). WP8 allowed moves for the
   FFI give leg. Narrow it: after the source is moved, the holder is dead; using it is
   `'p' used after its source 'v' was moved`. Sole exception: the move target is
   `forget` (the explicit "I own this now" spelling). The six giflib `store.push(v);
   return p` sites either restructure or wrap the use in `unsafe` with a comment saying
   `store` outlives the pointer; report which.
4. `ps.push(v.ptr())` into `Vec<*u8>` (h4-ptr-in-vec). A `*T` flowing anywhere other
   than directly into an extern call is a holder: a container it is pushed into, a
   struct it is stored in (WP8 did this one), a user fn's by-value `*T` param (holder
   for the call). Freeze the source while the holder lives. Remaining gap, documented
   not fixed: a callee that stashes its `*T` param in a global.
5. `Task.spawn(move() => { let p = g.ptr(); schedulerYield(); strlen(p) })`
   (h3-ptr-park). Falls out of 1 once the `@parks` walk reads the same view list.

Also in this package, because the gate is broken: `scripts/fuzz-ownership.ts`'s ASan
self-check probe is now rejected by WP8 even inside `unsafe`, so the script exits 2 at
startup. Replace the probe with the `strlen` heap-buffer-overflow probe `fuzz-tasks.ts`
uses (or share it).

Side findings from the reducer, fix if under ~30 lines each else backlog with repro:
an empty `from "std/os" import { }` still brings every `std/os` name into scope;
`pub fn main(): i32` with no `return` compiles.

Done: `tests/errors/ptrGlobalCalleePush.milo`, `ptrInlineAliasMutArg`,
`ptrUsedAfterSourceMoved`, `ptrEscapesIntoVec`, `ptrGlobalAcrossPark`; `fuzz:tasks` zero red
on the `h4-*` and `h3-ptr-park` shapes at `1edda9fe`; `fuzz-ownership.ts` starts again with the
`strlen` probe; the two side findings are backlog Tier 1 #37 and #38, the stash-in-a-global gap
is #43.

---

## Lane C3: trait conformance (found by WP9)

### WP14: an impl's method signature must match the trait's (closes H7; shipped `384c935c`)

Check every `impl Trait for T` method against the trait declaration: receiver mode
(`self`, `&self`, `&mut self`), parameter count, each parameter's type and reference
mode with `Self` substituted, return type. Mismatch is an error naming both signatures:
`'add' in 'impl Add for Res' takes 'other: Res' by value; the trait 'Add' declares
'other: &Self'`. Applies to user traits and the operator traits alike. Sweep std,
examples, fixtures for impls that mismatch today; each is a true positive to fix.

---

## Lane D: prover

### WP6: builtin container model and honest verdicts (closes P1, P2; shipped `ae1a86d0`, `ec108569`)

- `src/verify.ts`: a havoc with no contract behind it must yield `unknown`, never a
  counterexample. Today the counterexample is minted from unconstrained symbols,
  which is a false failure and contradicts roadmap's "unknown is reported as
  unknown".
- Every `len` symbol, including post-havoc ones, carries `>= 0`.
- A contract table for builtin `Vec`/`string` methods, stated as the `ensures` the
  method would carry if it were Milo: `push` (`len == old(len) + 1`), `pop`
  (`len == old(len) - 1` under `old(len) > 0`), `clear` (`len == 0`), `[i] = x`
  (`len == old(len)`), `len` pure. Same for `string.len`. Keep it a table in one
  place, not arms scattered through the walker (seam rule 2).
- Gate: `scripts/prove-soundness-fuzz.ts` already exists; add the push/pop shapes
  to its generator and require zero `failed` on programs whose oracle says the
  contract holds.

Done: `tests/prove/builtinPushFrame.milo` (`push1` proven; `bad` and `plusTwo`, the
deliberately wrong `+ 2`, refuted with real counterexamples), `havocNoContractUnknown`
(`unknown: 3`, `failed: 0`), `builtinContainerContracts`, `loopIndexAssignKeepsLen`;
`tests/verify-contracts.test.ts` green.

---

## Lane E: docs and pitch (after B and C)

### WP7 (shipped: this branch, 2026-09-20)

- `docs/site/index.md`: lead with no lifetimes, memory-safe, ergonomic; contracts
  second. The Promises caption drops "no data race to get wrong" or scopes it to
  OS threads. (Done: hero tagline, intro link order, caption names the `@parks` rule and
  the two `@thread` doors.)
- `docs/residue-vs-rust.md`, `ownership-patterns.md`, `design-insights.md`,
  `proposal-task-shared-state.md`: updates named in WP1 and WP3.
- `docs/memory-safety-vs-rust.md`: add H1, H2, H3 as findings #3-#5 with the commit
  that closed each, and note that the probe set now runs in CI (WP5a). (Done, extended:
  findings #3 to #9 are H1 to H7, #10 is the prover pair; a "What runs in CI" section names
  the three `ci.yml` steps; the matrix gained a row per hole.)
- `docs/backlog.md`: file whatever WP4 leaves behind. (Done: #35 by WP4 itself, #37/#38
  by WP11, #43 filed by WP7 for WP11's documented-not-checked gap; duplicate Tier 1 numbers
  renumbered.)
- Retire the word "residue" (owner, 2026-09-19). Fold `docs/residue-vs-rust.md` into
  `docs/memory-safety-vs-rust.md` as a section titled with what it is ("what the compiler
  does not check, and what happens instead"), leave a one-line redirect stub or fix every
  inbound link, and replace the term in `std/shard.milo`, `std/seal.milo`, `std/json.milo`,
  `docs/ownership-patterns.md`, `docs/foreign-memory.md`, `docs/backlog.md`,
  `docs/plans/tier2-3-plan.md`, `src/stdlib-bundle.ts` with a plain description of the
  specific thing each site means. Site dist files regenerate. (Done: folded as
  "What the compiler does not check, and what happens instead"; every inbound link fixed,
  no stub; `grep -rli residue docs *.md std src scripts` returns only this file. `src/stdlib-bundle.ts` did not exist; `std/shard.milo`
  had already dropped the word in WP3.)

---

## Lane F: design-pass follow-ups (after every lane above)

Findings and evidence in `design-pass-2026-09.md`. Order:

1. **WP13** (independent, running): F6 unused-locals gate, F7 dead exports, F10 weak
   api-docs gate, F9 doc, F4 crypto facade dedup.
2. **WP12** (checker, after WP4/WP9/WP11 merge): F1 one `isCopyType()` chokepoint with
   required callbacks; F2 one `ProgramView` (`fns`, `calleeOf`, `rootOf`, `pretty`) built
   once in `checkProgram` and a purity fixture for the late-resolved method case; F3
   `retainsArg`/`grows` flags on `BUILTIN_MEMBERS`; the 8 checker.ts unused locals WP13
   left.
3. **F5** (shipped fc7bc3d0, 2026-09-20): move the five thread/global
   passes (793 lines, 12 fields + 7 methods, 4 inbound edges) to
   `src/checker-program-passes.ts`.
4. **WP7** docs last, so it documents the final state. Shipped 2026-09-20 with F5 still open;
   F5 moves code, not rules, so no doc here depends on it.

## Not in this sweep

- **Formal core (Lean or otherwise).** Contracts speak about program values and
  cannot state "no element view is live across a park"; a proof of the rules
  would not have caught H1 (std unsafe) or H2 (runtime shape). Revisit once the
  rule set has stopped moving for a quarter; Hylo's mutable-value-semantics
  formalization is the starting point.
- **2D tiles, halos, `splitMut`.** Anti-target, unchanged.
- **Quantifiers in the prover.** Backlog Tier 2 #12, unchanged.

## Where Jev fits

TypeSafe's Jev returns typed judgments (Choice, Noul, Score) over natural language;
it does not generate programs. A fuzzer needs a generator and an oracle, and both
are mechanical here (random programs; ASan, drop accounting, a TypeScript model).
Jev is not on the critical path of any WP above. Two places it could earn a slot
later, neither blocking:

- **Failure triage.** WP5b/5c will produce many ASan reports for one root cause.
  A Choice over the known bug classes with the report plus the generated source as
  state, run before an agent looks, dedups the queue. Stack-hash dedup is the
  cheaper first try; reach for Jev only if it proves too coarse.
- **Diagnostic quality gate.** Milo's Elm-style hints are a product surface with
  no gate. A Noul per `tests/errors` output, "does the hint name a concrete fix the
  user can apply", scored against a small hand-labelled set, would catch a hint
  regressing to a restatement of the error. Cheap, and it fits the existing
  `--expect=<warning>` machinery for tracking.

## Subagent brief template

Each WP is one Opus agent in its own worktree. Give it: this file's section, the
reproducer paths, the checker line anchors above, the gate commands, and "done
when". Require in the report: the gate seen red before the change and green after,
`bun test` output tail, and every file touched. Reviewer (you) reads the diff and
reruns the reproducer before merge.
