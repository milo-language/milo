---

description: "Task list for the HIR expression-layer migration"
---

# Tasks: Typed HIR Through the Expression Layer

**Input**: Design documents from `/specs/002-hir-self-compile/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Test tasks ARE included. Not because TDD was requested, but because the spec makes gate falsification a functional requirement (FR-024: a gate must be observed failing before its pass is trusted). Those are the test tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (typed backend), US2 (corpus parity), US3 (isolation), US4 (regression gates)

## Path Conventions

Work happens in a worktree at `../milo-hir`. All paths below are relative to that worktree root.
`src/` is the **read-only oracle** — this feature never modifies it.

---

## Phase 1: Setup (delivers US3 — isolation)

**Purpose**: An isolated tree with its own compiler, and a recorded baseline. Another session holds uncommitted edits to `std/seal.milo` in the primary tree; nothing here may disturb them.

- [X] T001 Record the primary tree's dirty state to `/private/tmp/claude-501/-Users-csmith-git-milo/53dd66dd-bfde-4ff3-b2e0-786d9e2e4faf/scratchpad/primary-before.txt` via `git -C /Users/csmith/git/milo status --short`, as the before-image for SC-007
- [X] T002 Create the worktree: `git worktree add ../milo-hir -b 002-hir-self-compile` from `/Users/csmith/git/milo`
- [X] T003 Build milo-self inside the worktree with `sh scripts/selfhost.sh` — a worktree does not inherit `.selfhost/` from the primary tree, and using the primary tree's compiler would silently test the wrong binary
- [X] T004 [P] Capture the live ratchet baseline: `bun scripts/hir-ratchet.ts` into `specs/002-hir-self-compile/baseline.md`; confirm total is 115 or record the new number
- [X] T005 [P] Capture the live corpus baseline into the same file: `grep -vc '^#\|^$' tests/selfhost-manifest.txt` and `ls tests/fixtures/*.milo | wc -l` (expect 637 / 658; the denominator moves as the other session lands fixtures)

**Checkpoint**: Isolated tree, own compiler, baselines written down rather than remembered.

---

## Phase 2: Foundational (delivers US4 — the gates) ⚠️ BLOCKING

**Purpose**: Make the instruments trustworthy before trusting them. Four silent-success failures in one prior session, and six regressions shipped under green gates, are why this phase precedes all migration.

**⚠️ CRITICAL**: No expression kind is migrated until T010 and T011 have been observed to FAIL.

- [X] T006 [US4] Create `scripts/hir-cover.ts` generating a kind → fixtures index by running `bun run src/main.ts emit-hir <fixture> --all --json` over `tests/fixtures/*.milo` and inverting the result; cache to `tests/hir-cover.json`
- [X] T007 [US4] Add `--for <Kind>...` to `scripts/hir-cover.ts` listing every fixture whose HIR contains those kinds
- [X] T008 [US4] Add `--check --for <Kind>...` to `scripts/hir-cover.ts`: build and run each covering fixture through milo-self, exit non-zero on any failure
- [X] T009 [US4] Make `scripts/hir-cover.ts` print its input count on every run and **exit non-zero when that count is zero** — a gate reporting success over zero inputs is the recorded silent-success defect, not a pass (FR-023)
- [X] T010 [US4] Falsify G1: add a throwaway `hintTy` call to `src-milo/codegen/expr.milo`, confirm `bun scripts/hir-ratchet.ts --check` exits 1 naming `hintTy`, then revert with `git checkout src-milo/codegen/expr.milo`
- [X] T011 [US4] Falsify G2: break a codegen arm for a kind with known coverage, confirm `bun scripts/hir-cover.ts --check --for <Kind>` exits 1 naming a fixture, then revert
- [X] T012 [US4] Record in `specs/002-hir-self-compile/baseline.md` which kinds have **zero** covering fixtures; each is a kind whose migration proves nothing until a fixture exists
- [ ] T013 [US4] Commit and merge to `main`: gates before migration

**Checkpoint**: Both fast gates have been seen to fail on a real defect. Migration may begin.

---

## Phase 3: User Story 1a — Retire `placeTypeStr` (Priority: P1) 🎯 MVP

**Goal**: Remove the silent-accept path. `placeTypeStr` returns `""` when it cannot derive a type; nine consumers read `""` as "skip the ownership decision". Every one of the twelve sites feeds a drop-or-move decision.

**Independent Test**: `bun scripts/hir-ratchet.ts` reports `placeTypeStr 0` (SC-010), corpus green. Delivers value alone: the unsoundness is gone whether or not `hintTy` is ever touched.

**Why MVP**: 12 sites against `hintTy`'s 87, chosen first because these 12 are unsound rather than untidy — and unsoundness is what the endgame verdict reads.

### Understand the blast radius

- [X] T014 [P] [US1] Document in `specs/002-hir-self-compile/baseline.md` that `placeTypeStr` handles only `Ident`, `FieldAccess`, `IndexAccess`, `UnaryOp`, and that its `_ => return ""` catch-all (`src-milo/codegen/expr.milo:369`) is itself a silent accept for every other place expression
- [X] T015 [P] [US1] List the nine external consumers with their line numbers in the same file: `markReceiverMoved:407`, `genOwnedArg:460,480,512,547`, `genAsCast:3329`, `genIndex:6541`, `genCall:8288`, `genLvalueWithHint:8717` (331/342/358 are internal recursion)

### Convert the seams to take HIR (DISCOVERED PREREQUISITE — see baseline.md)

Kinds cannot be lowered until the seams that receive them accept `&HExprNode`. Attempting
`IntLit` proved this: `let x = 5` aborts with *"'hit' initializer reached the untyped
backend as a lowered IntLit"*. Seams first, then kinds — the reverse of the order below.

- [ ] T016a [US1] Convert `genLetBinding` in `src-milo/codegen/stmt.milo` to take `&HExprNode`, calling `genHExpr` for the value and matching `Unlowered` inline only where it needs syntax
- [ ] T016b [US1] Convert `genReturnValue` in `src-milo/codegen/stmt.milo` to take `&HExprNode`
- [ ] T016c [US1] Convert `genAssignAst` in `src-milo/codegen/stmt.milo` to take `&HExprNode` for the VALUE only; the target stays `&ExprNode` until place kinds are lowered. Seven `genOwnedArg(cg, value, …)` sites each need the dispatch inlined (`Unlowered` → `genOwnedArg(cg, *av, …)`, otherwise → `genHExpr(cg, value, locs, sigs, "")`), plus two `lvalueMatches(target, value)` self-assignment checks (lowered → false) and the `Expr.BinOp` string-append fast path (lowered → skip). **Do not factor this into a shared wrapper**: `genOwnedArg`'s parameter is named `hintTy`, so a wrapper adds two to that counter, and dodging it by renaming the parameter would be gaming the gate rather than passing it
- [ ] T016d [US1] Convert `constFoldBool`'s seam in `genIf` — it folds on the WRITTEN form, so it keeps an inline `Unlowered` match and returns "cannot fold" for a lowered node rather than aborting
- [ ] T016e [US1] Convert `emitGlobalStatic`'s seam in `src-milo/codegen/emit.milo:1271` — it decides whether an initializer can be a static constant by reading syntax, so a lowered literal needs a typed path that emits the constant directly. The second seam at `:1307` already has a safe `_ => {}` default (a lowered node contributes no ident references) and needs no change
- [ ] T016f [US1] Add `IntLit` arms to the four analysis pre-scans in `src-milo/codegen/stmt.milo` (`collectIdentsHExpr`, `collectReturnEscapedIdentsInto`, `collectVecPushHintsInto`, `collectMovedOutIdentsHExpr`); `trailingIdentName`, `isOwnedTempNode` and `pushIfBareIdentH` need no change, their defaults already answer correctly for a literal
- [ ] T016g [US1] Lower `IntLit` in `src-milo/lower.milo` and add its `genHExpr` arm using `genIntLitVal(cg, v, tyStr(cg, hirType(n), ...))`; this is the end-to-end proof that the seams are ready

### Lower the four place kinds

- [ ] T015a [US1] Add `movedExprs: HashMap<u32, bool>` to the `Checker` in `src-milo/checker/state.milo` and record into it beside `setVarMoved(ck, name, true)` at `src-milo/checker/expr.milo:156` and in `tryMoveField` — `HExpr.Ident(name, isMove)` carries this flag and `src-milo`'s checker computes it but discards it, while the oracle keeps it (`src/checker.ts:6154`) and codegen reads it for every drop decision
- [ ] T016 [US1] Read `src/lower.ts` for the `Ident` arm, then add the `Expr.Ident` arm to `lowerExpr` in `src-milo/lower.milo`, taking the type from the `Checker` rather than re-deriving it (contract C1)
- [ ] T017 [US1] Add the `Expr.FieldAccess` arm to `lowerExpr` in `src-milo/lower.milo` against `src/lower.ts`
- [ ] T018 [US1] Add the `Expr.IndexAccess` arm to `lowerExpr` in `src-milo/lower.milo` against `src/lower.ts`
- [ ] T019 [US1] Add the `Expr.UnaryOp` arm to `lowerExpr` in `src-milo/lower.milo` against `src/lower.ts`
- [ ] T020 [US1] Run `bun scripts/hir-ratchet.ts --check` and `bun scripts/hir-cover.ts --check --for Ident FieldAccess IndexAccess UnaryOp` after each of T016–T019; both must pass and the fixture count must be non-zero

### Convert the consumers

- [ ] T021 [US1] Rewrite `markReceiverMoved` in `src-milo/codegen/expr.milo:407` to take the type from `hirType(node)`; **delete the `if tyStr.len == 0 { return }` early-return** — the ownership decision is no longer conditional on a derivation succeeding
- [ ] T022 [US1] Convert the four `genOwnedArg` sites (`src-milo/codegen/expr.milo:460,480,512,547`) to read the type from the node
- [ ] T023 [P] [US1] Convert `genAsCast` (`src-milo/codegen/expr.milo:3329`) to read the type from the node
- [ ] T024 [P] [US1] Convert `genIndex` (`src-milo/codegen/expr.milo:6541`) to read the type from the node
- [ ] T025 [P] [US1] Convert `genCall` (`src-milo/codegen/expr.milo:8288`) to read the type from the node
- [ ] T026 [P] [US1] Convert `genLvalueWithHint` (`src-milo/codegen/expr.milo:8717`) to read the type from the node

### Prove the sites are dead, then delete

- [ ] T027 [US1] Before deleting `placeTypeStr`, make its body abort instead of returning `""`, run the corpus, and confirm it is never reached — a site that is unreferenced is not the same as a site that is dead
- [ ] T028 [US1] Delete `placeTypeStr` from `src-milo/codegen/expr.milo` and confirm `bun scripts/hir-ratchet.ts` reports `placeTypeStr 0`
- [ ] T029 [US1] Add a fixture to `tests/fixtures/` exercising a receiver move through a place kind that previously hit the `_ => return ""` catch-all, with `// @expect:` annotations proving the drop happens exactly once
- [ ] T030 [US1] Full pre-push gate set: `sh scripts/selfhost.sh`, `sh scripts/selfhost-fixpoint.sh`, `bun scripts/selfhost-rejects.ts --check`, then `MILO_SWEEP_CONCURRENCY=1 bun scripts/selfhost-sweep.ts --check` (~48 min, not optional — it is the only gate that runs the corpus)
- [ ] T031 [US1] Rebase onto `main`, fast-forward merge, push. Stage named files only; never `git add -A`

**Checkpoint**: SC-010 met. The ownership decisions no longer depend on a type derivation that can silently fail. **This is a shippable increment** even if nothing below is ever done.

---

## Phase 4: User Story 1b — Retire `hintTy`, `astTypeStr`, `resolveAstTy` (Priority: P1)

**Goal**: The remaining 102 reconstruction sites. Bulk transcription against the oracle, one kind per step.

**Independent Test**: `bun scripts/hir-ratchet.ts` shows all four derivation counters at 0.

- [ ] T032 [US1] Order the remaining ~99 expression kinds by fixture coverage descending using `bun scripts/hir-cover.ts`; write the order into `specs/002-hir-self-compile/baseline.md`. High-coverage kinds first: evidence per step is what makes deferring the 48-minute sweep to push time defensible
- [ ] T033 [US1] Add the `Forget` kind to `src-milo/hir.milo` — the one genuine taxonomy gap against `src/hir.ts` (research.md Finding 6)
- [ ] T034 [US1] For each kind in the T032 order: read its arm in `src/lower.ts`, add the `lowerExpr` arm in `src-milo/lower.milo`, read its consumption in `src/codegen.ts`, add the HIR arm in `src-milo/codegen/expr.milo`, delete the AST walk behind it, then run G1 + G2. Repeat until `hintTy` reaches 0
- [ ] T035 [US1] Write a fixture into `tests/fixtures/` for every kind T012 recorded as having zero coverage, before that kind counts as migrated
- [ ] T036 [US1] Retire the 5 `astTypeStr` sites in `src-milo/codegen/types.milo` and the remainder in `emit.milo` / `expr.milo`
- [ ] T037 [US1] Retire the 5 `resolveAstTy` sites in `src-milo/codegen/expr.milo` and `src-milo/codegen/stmt.milo`
- [ ] T038 [US1] Run the full pre-push gate set and merge to `main` at every green step, not once at the end

**Checkpoint**: All four derivation counters at 0. Only the bridge itself remains.

---

## Phase 5: User Story 1c — Delete the bridge (Priority: P1)

**Goal**: SC-002. The type checker retires the escape hatch; no script has to agree.

**Independent Test**: The edit in T041 compiles. That is the proof.

- [ ] T039 [US1] Remove the last `mkUnlowered` construction site from `src-milo/lower.milo` so `lowerExpr` returns a typed node on every path
- [ ] T040 [US1] Delete every `HExpr.Unlowered(...)` seam arm from `src-milo/codegen/stmt.milo` (15 sites), `src-milo/codegen/emit.milo` (2 sites), and `src-milo/codegen/expr.milo`
- [ ] T041 [US1] In `src-milo/hir.milo`, change `HExprNode.ty` from `Option<TypeKind>` to a bare `TypeKind`, delete the `Unlowered` variant, delete `mkUnlowered`, and delete `hexprAbort`. **If this compiles, the migration is complete** — it cannot compile while a single construction site survives
- [ ] T042 [US1] Simplify `hirType` in `src-milo/hir.milo` now that `ty` cannot be absent, keeping the function as the blessed accessor
- [ ] T043 [US1] Confirm `bun scripts/hir-ratchet.ts` reports TOTAL 0, then retire the ratchet's counters or the script itself — a gate that can no longer fail must be fixed or deleted, never left green (Constitution III)
- [ ] T044 [US1] Full pre-push gate set, merge, push

**Checkpoint**: SC-001 and SC-002 met. `codegen/expr.milo` consumes only typed HIR.

---

## Phase 6: User Story 2 — Close the corpus gap (Priority: P1)

**Goal**: The 21 fixtures outside the manifest are inside it, or each has a written reason.

**Independent Test**: `bun scripts/selfhost-sweep.ts --check` passes with a manifest above 637, and every fixture still outside carries a classification.

**Sequencing note**: This phase runs last but partially resolves itself during Phases 3–5. Several of the 21 fail *because* the backend re-derives a type and gets it wrong.

- [ ] T045 [US2] Re-run `MILO_SWEEP_CONCURRENCY=1 bun scripts/selfhost-sweep.ts` and record which of the 21 closed for free during the migration — do not plan against the stale 637
- [ ] T046 [P] [US2] Fix the 5 drop-glue output mismatches: `closureCaptureDropMatrix`, `dropBehindTraitObject`, `taskCaptureDropped`, `tempFieldReadDrop`, and the `saturatingMulSign` sign bug (a genuine arithmetic defect, not a drop issue)
- [ ] T047 [P] [US2] Fix the 4 parse errors: `deriveTemplate`, `deriveTemplateJson` (`@` in derive templates), `genericMethodTrait`, `ifLetOwnedInspect` (`<` in generic method traits)
- [ ] T048 [P] [US2] Work the remaining one-offs: `blanketImpl`, `blanketImplHashMap`, `deriveJsonFixedArray`, `deriveJsonHashMap`, `genericMethod`, `flybyGeometry`, `globalRuntimeInitScalar`, `sealSpan`, `shardParallelMap`, `arrayOfGenericElements`, plus `sealShared` and `shardMapWith` from the other session
- [ ] T049 [US2] Ratchet each newly-passing fixture in with `bun scripts/selfhost-sweep.ts --write`; the repeat-pass requirement guards against a flaky pass entering the baseline (FR-011)
- [ ] T050 [US2] Write a classification for every fixture still outside the manifest into `docs/self-hosting.md`, naming what blocks it. A recorded reason is an acceptable outcome; silence is not (FR-012)

**Checkpoint**: SC-003 and SC-004 met.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T051 [P] Update `docs/self-hosting.md` with the post-migration architecture: codegen consumes typed HIR, and the bridge is gone
- [ ] T052 [P] Bump `last-verified` on `docs/src.md` and any doc made stale by the migration, in the same commit as the change that staled it
- [ ] T053 Verify SC-007: `git -C /Users/csmith/git/milo status --short` matches `primary-before.txt` from T001 exactly
- [ ] T054 Run the `quickstart.md` "Done" table end to end and record each measured value against its target
- [ ] T055 Ethos review per the Constitution: argue the change violates "a memory-safe systems language that guides you to correct, readable programs" on each clause, answering with evidence from the diff. Write the strongest objection and its answer into `.agents/worksheets/`. "No objections" means the review did not happen
- [ ] T056 Cross-model review: `scripts/agent_review.sh implementation`
- [ ] T057 Remove the worktree: `git worktree remove ../milo-hir && git branch -d 002-hir-self-compile`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup / US3)**: No dependencies. Start immediately.
- **Phase 2 (Foundational / US4)**: Depends on Phase 1. **BLOCKS every migration task.** T010 and T011 must be observed failing.
- **Phase 3 (US1a)**: Depends on Phase 2. Independently shippable.
- **Phase 4 (US1b)**: Depends on Phase 3 — the four place kinds lowered there are prerequisites for many kinds here.
- **Phase 5 (US1c)**: Depends on Phase 4. Cannot begin while any construction site survives.
- **Phase 6 (US2)**: Depends on Phase 5 for the free closures, but T046–T048 can begin any time.
- **Phase 7**: Depends on all desired phases.

### Story Dependencies

- **US3 (isolation)** is a precondition for everything — without it, the evidence US1 and US2 produce is not trustworthy.
- **US4 (gates)** is a precondition for everything — without it, the evidence is not believable.
- **US1** is strictly sequential (a → b → c): each stage removes what the next depends on.
- **US2** is largely independent and partially resolved by US1.

### Parallel Opportunities

- T004, T005 (baseline capture, different measurements)
- T014, T015 (documentation of blast radius)
- T023–T026 (four consumers, independent call sites)
- T046, T047, T048 (three disjoint fixture clusters)
- T051, T052 (separate docs)

**Not parallel, despite appearances**: T016–T019 all edit `lowerExpr` in `src-milo/lower.milo`. T021–T022 and T023–T026 all edit `src-milo/codegen/expr.milo`; only the latter group is marked [P] because those four sites are far apart and independent, while T021/T022 restructure shared control flow.

**Never parallel**: any two tasks running the 48-minute sweep. milo-self is nondeterministic under parallel load, and the sweep already saturates its own worker budget.

---

## Parallel Example: Phase 3 consumers

```bash
# After T016-T022 land, these four are independent call sites:
Task: "Convert genAsCast in src-milo/codegen/expr.milo:3329"
Task: "Convert genIndex in src-milo/codegen/expr.milo:6541"
Task: "Convert genCall in src-milo/codegen/expr.milo:8288"
Task: "Convert genLvalueWithHint in src-milo/codegen/expr.milo:8717"
```

---

## Implementation Strategy

### MVP: Phase 3 alone

1. Phase 1 (worktree + baselines)
2. Phase 2 (gates, **observed failing**)
3. Phase 3 (`placeTypeStr` → 0)
4. **STOP and VALIDATE**: full gate set, including the sweep
5. Merge and push

That is a complete, defensible increment: the ownership decisions no longer hinge on a type derivation that can fail silently. The remaining 102 sites are ugly but sound.

### Incremental Delivery

Phase 3 → merge → Phase 4 → merge → Phase 5 → merge → Phase 6 → merge. Each phase leaves the compiler green. Merge to `main` at every green step; the branch is a worktree artifact, not a place to accumulate work.

### Sequencing risk

Phase 4 is ~99 kinds and is where a long migration historically dies — the previous HIR attempt reached 1,210 lines, was never imported, and was deleted in `04738180`. The counters exist to make that failure mode visible: if `hintTy` stops falling, the migration has stalled, and stalling is visible the same week rather than at the end.

---

## Notes

- `src/` is the oracle. Read `src/lower.ts` and `src/codegen.ts` for every kind; never modify them.
- Commit after each task or logical group; one lowercase line per commit.
- Empty output with **exit 137** is a memory-guard kill, not a miscompile. Never record it as a fixture failure.
- Never run `.selfhost/milo-self.bin` bare. Never commit `MILO_RUN_UNGUARDED=1`. Never raise sweep concurrency without redoing the arithmetic in `scripts/guard.ts`.
- Never `git add -A` — a concurrent session's indiscriminate stage has eaten work in this repo.
