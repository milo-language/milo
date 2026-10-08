<!-- doc-meta
system: worksheet-fix-commit-sweep-findings
purpose: implementation trace for the 2026-07-30 two-day commit sweep fixes
key-files: src/checker.ts, src/codegen.ts, tests/, docs/testing.md
update-when: the task state, implementation decisions, or verification results change
last-verified: 2026-07-30
-->

# Worksheet: Fix two-day commit sweep findings

- **Slug / tag:** `ws/fix-commit-sweep-findings`
- **Started:** 2026-07-30
- **Status:** done
- **Related:** review of commits since `47d3165`

## Goal
Fix the three compiler correctness defects and two documentation-drift findings from the two-day commit sweep, with focused regression coverage.

## Plan
1. Validate repr-enum declarations and preserve the compiler's intentional i32 tag representation.
2. Make integer `Vec.sum()` obey normal overflow policy and make large aggregate self-swap defined.
3. Add regression fixtures, repair doc metadata/counts, then run targeted and repository gates.

## Current state
All findings are fixed and focused verification passes. Broad validation completed with three unrelated/environment failures recorded below.

## Log
- 2026-07-30 — Confirmed `Vec.sum()` bypasses `emitCheckedArith`, large `swap` uses non-overlap-safe memcpy without an equality guard, and repr enums lack name/range validation.
- 2026-07-30 — Enforced the documented i32 enum repr, added discriminant range checks, routed integer `Vec.sum()` through checked arithmetic, and guarded large aggregate memcpy swaps against equal pointers.
- 2026-07-30 — Added checker, release-runtime, and emitted-IR regressions; repaired doc metadata and refreshed the testing index/counts.
- 2026-07-30 — Secondary review found generic repr enums bypass the non-generic registration checks and lose repr data during monomorphization; rejected that unsupported form with a regression fixture.
- 2026-07-30 — Targeted tests and typechecking pass. Broad non-self-host suite: 1,110 pass, 14 skip, 3 unrelated/environment failures (missing clang header check, existing TLS link-dependency failure, contract gate produced no reports). Example runner: 42 compiled/23 ran with five SDL2 link failures because SDL2 is unavailable.

## Decisions
- Repr enums remain stored as i32 tags; accept only integer reprs whose full declared range fits that representation, and reject individual discriminants outside the declared repr.
- Large aggregate swap will branch on runtime pointer equality because indexed operands can alias dynamically.

## Blockers / open questions
- None.

## Verification
- [x] targeted tests: repr-enum errors, swap IR, overflow checks, and compiler typecheck pass (8 tests total)
- [x] ran the app / fixture: release `Vec.sum()` overflow binary traps as required
- [x] full non-self-host test selection: 1,110 pass, 14 skip, 3 unrelated/environment failures documented above
- [x] agent review: generic repr bypass found and fixed; no remaining reported finding
- [x] docs updated (last-verified bumped): `docs/testing.md`, kernel/niche doc metadata
