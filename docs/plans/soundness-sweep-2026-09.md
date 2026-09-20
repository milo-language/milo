<!-- doc-meta
system: planning
purpose: work plan for closing the three safe-code memory holes found 2026-09-19, the prover false-failed verdict, and the gates that keep them closed
key-files: tests/holes-2026-09/, src/checker.ts, std/shard.milo, src/verify.ts, scripts/fuzz-ownership.ts, scripts/asan-sweep.ts
update-when: a work package ships, is re-scoped, or its gate changes
last-verified: 2026-09-19 (every hole reproduced at 284606cc; probes in tests/holes-2026-09)
-->

# Soundness sweep, September 2026

Baseline commit `284606cc`. Five reproducers live in `tests/holes-2026-09/`. Each work
package (WP) below names the reproducer it must turn from red to green. Delete the
directory when every file in it has become a fixture, an error test, or a fuzzer seed.

## The holes

| # | Reproducer | Symptom at HEAD | Root cause |
|---|---|---|---|
| H1 | `hole1-shard-string-double-free.milo` | exit 133, malloc abort | `std/shard.milo:89` `Shard.get` does `unsafe { self.base[i] }`: bitwise copy of a Drop `T`. Arena is fine because it indexes a `Vec` and Vec indexing clones. |
| H2 | `hole2-shards-owner-dropped-under-worker.milo` | worker writes 2.0 into a freed buffer; a fresh `Vec` reusing it prints 2 not 9 | `Shards` is implicitly droppable while windows are outstanding. Docs call it "the residue". |
| H3 | `hole3-global-forin-across-yield.milo` | prints `1, 4, 0` from a freed buffer | for-in freeze on a mutable global is interprocedural but not cross-task: body yields, another task pushes, buffer reallocates. |
| H4 | `hole4-vec-ptr-outlives-realloc.milo` | ASan heap-use-after-free, no `unsafe`, no thread, no generic | `v.ptr()` / `s.cstr()` return `*T` in safe code with no provenance; `push` reallocates; a scalar-returning extern reads the stale pointer. Found 2026-09-19 by independent review. |
| P1 | `prover-push-ensures-false-counterexample.milo` | `push1` postcondition **failed**, counterexample `v_len__mut1 = 0` | builtin `Vec.push` has no contract; havoc reports as a counterexample instead of `unknown`. |
| P2 | `prover-push-reports-failed-not-unknown.milo` | `main` precondition **failed**, counterexample `len = -1` | same; a length symbol has no `>= 0` assumption after havoc. |

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

### WP5a: promote the reproducers and the battle test into CI

- Move the three `hole*` files under `tests/fixtures/` with `// @expect:` lines that
  describe correct behaviour (H1: the program must not build, so it becomes
  `tests/errors/` once WP2 lands; until then it is a known-red fixture listed in a
  `tests/known-red.txt` the driver skips and reports).
- Add the 13 probes from `docs/memory-safety-vs-rust.md` as fixtures or error tests
  where they are not already. Document is not a gate.
- Wire `bun scripts/asan-sweep.ts --all` into `package.json` `test:asan` and into
  whatever CI script `scripts/build.sh` drives. Confirm it fails on H2 at HEAD before
  merging (gate audit rule).

Done when: CI has a red entry for H2 and H3 at `284606cc`, and the known-red list is
the only thing keeping `bun test` green.

### WP5b: `scripts/fuzz-generic-drop.ts`

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

Done when: it reports H1 red at HEAD, and covers >= 80% of generic pub std symbols.

### WP5c: `scripts/fuzz-tasks.ts`

Would have caught H2 and H3.

- Generator over: mutable globals of `Vec<i64>` and `Vec<string>`; `Task.spawn`;
  `schedulerYield` / channel ops / `sleepMs` inside loop bodies; `for x in g`, slices
  `g[a..b]`, index reads; `Promise.blocking` workers; `shatter`/`windows`/`weld` with
  windows dropped, duplicated, or outstanding while the owner goes out of scope.
- Programs contain zero `unsafe` blocks. Oracle: `--sanitize` build, ASan report of
  any kind is a failure. Same accept-direction asymmetry as `fuzz-ownership.ts`: a
  program the checker rejects is counted, not investigated.
- Seed the corpus with `hole2` and `hole3`.

Done when: it reproduces H2 and H3 at HEAD in under a minute, and after WP1 and WP3
land it runs 10k programs clean.

---

## Lane B: effects

### WP1: `@parks` and the cross-task freeze rule (closes H3)

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

Done when: `hole3` is an error test, WP5c runs clean on the H3 shape, and
`examples/` plus `~/git/hades` still compile (a false positive on a real program is a
rule not finished).

---

## Lane C: attributes (serial)

### WP2: `@copyOnly` on generic types (closes H1)

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

### WP3: close the manual shard path (closes H2)

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

Done when: `hole2` is an error test, `milo api --json` lists no `windows`/`weld`/
`reclaim`/`shatter*`, and every fixture and benchmark that used them builds on the
closed forms with the same output.

### WP4: raw-pointer fields make a struct move-only

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

Done when: `@noCopy` survives only where a struct with no pointer field still needs
move tracking (integer resource handles such as fds), and every example builds.

---

## Lane B2: raw-pointer provenance

### WP8: `ptr()`/`cstr()` results are element views (closes H4)

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

Done when: `hole4` is an error test, all 15 bound sites compile or are fixed, and
WP5c's generator includes the `ptr()`-then-mutate shape.

---

## Lane D: prover

### WP6: builtin container model and honest verdicts (closes P1, P2)

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

Done when: both `prover-*` reproducers prove clean, and a deliberately wrong
`ensures v.len == old(v.len) + 2` after one push still fails with a real
counterexample.

---

## Lane E: docs and pitch (after B and C)

### WP7

- `docs/site/index.md`: lead with no lifetimes, memory-safe, ergonomic; contracts
  second. The Promises caption drops "no data race to get wrong" or scopes it to
  OS threads.
- `docs/residue-vs-rust.md`, `ownership-patterns.md`, `design-insights.md`,
  `proposal-task-shared-state.md`: updates named in WP1 and WP3.
- `docs/memory-safety-vs-rust.md`: add H1, H2, H3 as findings #3-#5 with the commit
  that closed each, and note that the probe set now runs in CI (WP5a).
- `docs/backlog.md`: file whatever WP4 leaves behind.

---

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
