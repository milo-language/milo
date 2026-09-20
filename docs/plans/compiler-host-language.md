<!-- doc-meta
system: compiler-host-language-decision
purpose: decision record for whether to rewrite the TS compiler (src/) in Milo (src-milo/) or Rust, and on what grounds
key-files: src/, src-milo/, tsconfig.json, docs/self-hosting.md, docs/backlog.md
update-when: the defect-class evidence changes, the index-access hole closes, or a self-host port actually starts
last-verified: 2026-08-04
-->

# Host language for the compiler — decision record

**Question.** The TS compiler in `src/` is accumulating Rust-shaped discipline by hand.
Is that a losing battle? Would rewriting it in safe Milo (`src-milo/`) — or in Rust —
produce a *more correct* compiler?

**Decision (2026-08-04).** No rewrite on correctness grounds. Milo would be marginally
safer than TS; Rust would be no safer at all. Neither difference is large enough to pay
for resetting a 40k-line codebase to zero maturity. Self-hosting stays worth doing — for
**proof, not safety** — and stays parked until it is done incrementally behind a
differential harness. See [self-hosting.md](../self-hosting.md) for the parked plan.

**Companion, different question.** This page asks whether a rewrite buys *correctness*.
[milo-first-inner-loop.md](milo-first-inner-loop.md) asks whether, if we go Milo-first
anyway for dogfooding and proof, the edit/test loop survives — measured 2026-08-04, the
answer is yes but conditional on parallel codegen units landing first.

---

## The measurement that decides it

Two questions, and only the second one matters:

1. Is the TS unsound in practice?
2. Is unsoundness the class of bug we are actually fixing?

### 1. The TS is disciplined, but not clean

Measured 2026-08-04 over `src/` (40,130 lines, 35 files):

| Escape hatch | Count |
|---|---|
| `as any` | 94 |
| `as unknown as` | 4 |
| non-null assertion (`x!.`, `x![`, `x!)`, `x!,`) | 52 |
| `@ts-ignore` / `@ts-expect-error` | 0 |

~150 holes, ~1 per 270 lines, and zero suppressed diagnostics. `checker.ts` carries 22 of
the `as any`. That is disciplined for a compiler, but it is not the "no escape hatches"
story a rewrite argument would want, so do not lean on it either way — the point is that
these sites are **not where the observed bugs come from**. No recent compiler bug in the
log traces to one.

### 2. The bug class we are actually fixing

The last 25 commits, filtered to real compiler defects, are dominated by one class:

- `f66b105f` — the safety walker did not look inside `let-else`, so it **reported a pass on
  an unsafe block it never visited**
- `4dc6dc89` — one total walker in the prover: a statement hiding inside an expression
  escaped loop havoc
- `e0770e5d` — call/struct-literal obligations follow one guarded walker, and the places it
  declines to look now say why
- `b3d2d5d5` — the last three field lists in the prover derive their children instead of
  naming them

All four are **incomplete traversal reporting success** — the class recorded in
`feedback_silent_success`. Same shape as the eight ad-hoc place-walkers collapsed into one
fail-closed `placesOf` (backlog, Tier 1 what-is-left section).

**No language prevents this class.** Exhaustive `match` catches *tag* dispatch; nothing in
Milo, Rust, or TS catches "you forgot to recurse into field 7 of a node you did handle." A
hand-listed field walker in Milo is exactly as incomplete as one in TS. The fix that
worked — `b3d2d5d5`, derive the children instead of naming them — is language-independent,
and would have been needed identically in a Milo or Rust port.

**Conclusion:** the dominant defect class is invariant under the choice of host language.
That is the whole decision.

---

## Where Milo would genuinely be safer

One place, and it is precisely the hole we left open on purpose:

```jsonc
// tsconfig.json
"noUncheckedIndexedAccess": false,   // ~700 violations
```

TS `arr[i]` out of range yields `undefined`, which flows onward and corrupts state several
frames downstream from the mistake. Milo bounds-checks and traps **at the index site**, and
`HashMap.get` returns `Option<V>` rather than `V`. That is a real, measurable
debuggability difference across roughly the ~700 sites the flag would have covered.

The tsconfig comment is right that retrofitting `arr[i]!` silences the check rather than
proving anything. The correct conclusion is *get the check another way*, not *skip it* —
see "What to do instead" below.

Secondary, smaller Milo wins: no `undefined` at all (TS `strict` already covers most of
this), typed errors via `Result<T, E>` (TS uses exceptions and unions, roughly a tie in
practice), and exhaustive `match` without a hand-written `never` guard (real, but the
`never` guards in `src/` already work — the failures were field coverage, not tag
coverage).

---

## Where Milo would be worse

**Graph-shaped data is the expensive 80%.** A compiler is symbol-table → decl, def → use,
interned types, parent pointers — many-to-one references everywhere. Milo has
second-class refs: **a `&T` cannot be stored in a struct or returned.** Every one of those
edges becomes `Arena<T>` + `Handle<T>` or a bare index. That is a data-model rewrite, not a
port. rustc did exactly this (`DefId`, `NodeId`, `Ty<'tcx>` interning) so it demonstrably
works and is even good for cache behaviour — but it is where the months go, and
`project_neon_game_proof` already records the trade: handles concede identity.

**Bootstrap paradox.** Open compiler bugs become bugs *in the compiler that compiles the
compiler*, debugged through two moving layers. Currently open and directly in the blast
radius: `let m = v[i]` on a struct with heap fields silently deep-clones (backlog T1 #8 —
AST/HIR nodes are exactly this shape); the for-in loop-var shadow that emits invalid IR
with no diagnostic; generic-struct statics needing a turbofish (T1 #5 — every generic
collection in a compiler); one aliasing rule with three answers depending on container
(T1 #7).

**Compile time attacks the metric we protect most.** Profiled 2026-07-16: self-host at
20k LOC spends 0.38s in the frontend and **7.3s in clang -O2 — 95% of the build** — and
per-module incremental is blocked by design. A 40k-line Milo compiler means a slow
edit-test loop on the files we edit every day, which is a direct hit to
`feedback_iteration_speed`.

**Maturity reset.** 40k lines of TS have absorbed years of fixes that are invisible until
they are gone.

**Operational hazard.** Unguarded `milo-self` has crashed this machine twice
(`project_selfhost_guard`). Self-hosting is not free even when it works.

---

## Why not Rust

Strictly dominated. Same rewrite cost as Milo, same data-model rework (Rust at least lets
you store references, at the price of lifetime annotations everywhere), and it fixes **none**
of the observed defect classes — TS + GC already has zero memory bugs, and Rust does not
catch incomplete traversal either. Its one real advantage over Milo here is maturity:
incremental compilation, `salsa`, a real `HashMap`, no bootstrap paradox.

What Rust gives up is the only reason to do this at all: **dogfooding**. If the compiler is
going to be rewritten, it should be rewritten in Milo. If it is not going to be rewritten
in Milo, it should not be rewritten.

---

## What to do instead

Ranked by return on effort.

1. **Close the index hole — the one place Milo would truly be safer.** Not 700 `!`.
   Add an `at(arr, i): T | undefined` accessor and migrate `checker.ts`, `lower.ts`,
   `codegen.ts` incrementally, or enable `noUncheckedIndexedAccess` per-file behind a
   directive. This buys the single genuine Milo safety advantage without the rewrite.
   Supersedes the "revisit per-file only if index bugs show up" wording in
   [backlog.md](../backlog.md) Tier 3 — the argument for acting is now positive, not
   reactive.

2. **Make "derive the children" a structural rule, not a habit.** The dominant bug class is
   hand-listed field walkers. `b3d2d5d5` and `4dc6dc89` are the medicine; the rule is that
   no new hand-listed walker survives review. This is the highest-value item on the list
   and it is free.

3. **Invest in oracles, not host languages.** The frontend fuzzer found 2 bugs per 150k
   mutants (`project_frontend_fuzzer`); its named next oracles — emit-js differential and
   fmt idempotence — are still unbuilt, as is broader shape coverage in
   `scripts/fuzz-ownership.ts`. These find the *logic* bugs that no type system in any
   language catches, which per the commit log is what is actually biting.

4. **Self-host for proof, incrementally.** A self-hosted compiler is the most credible
   possible claim that Milo is a real systems language, and it stress-tests the language
   harder than any test suite. That is an honest reason and a good one — it is just not a
   *correctness* reason, and it should not be sold internally as one. If it restarts:
   - **Port codegen first.** Most mechanical, least graph-shaped, and it has a byte-exact
     oracle: diff emitted IR against the TS backend over the fixture corpus.
   - **Port the checker last.** Most reference-heavy, highest churn, worst fit for
     second-class refs.
   - Keep the differential harness green at every step; `src-milo` broke silently once
     already because there was no harness (see self-hosting.md, M-log).

---

## Standing note

`src-milo/` is 20,826 lines across 25 files as of 2026-08-04 — self-hosting.md's
"~8,220 lines across 18 files" is stale. Recent `src-milo` commits are resync work
(chasing stdlib renames), not feature progress, which is the expected steady state of a
parked port and is not by itself an argument for or against restarting it.

**The battle does not feel losing because TS is the wrong language. It feels losing because
we are fighting totality by hand, and totality is a derive/codegen problem in every
language.**
