# Worksheet: implement standard library coherence

- **Slug / tag:** `ws/implement-stdlib-coherence`
- **Started:** 2026-07-30
- **Status:** done
- **Related:** `docs/stdlib-design.md`, `docs/breaking-changes.md`

## Goal
Implement the S0-S7 stdlib coherence migration: truthful API discovery, uniform failures and API shapes, explicit text semantics, curated raw boundaries, remaining-domain audit, and automated enforcement.

## Plan
1. S0 API discovery + snapshot tests.
2. S1 filesystem results + caller migration.
3. S2 typed parse errors; S3 constructors/receivers; S4 text semantics.
4. S5 raw/internal curation; S6 remaining-domain audit; S7 lint/snapshot enforcement.
5. Full tests, examples, cross-model review, docs, and breaking-change records.

## Current state
Done. The supported surface is discoverable without new CLI flags; filesystem,
parsing, constructor, text, and raw-boundary conventions are implemented for the
targeted domains, with migration notes and automated checks.

## Log
- 2026-07-30 — Started implementation from the approved `docs/stdlib-design.md` inventory.
- 2026-07-30 — S0: `milo api` now excludes private and `@internal` declarations while retaining methods on public types. Added focused tests; 5/5 pass. Removed proposed maintainer flags after user feedback—the public CLI remains singular.
- 2026-07-30 — S1-S3: normalized filesystem commands around `Unit`, kept simple predicates as `bool`, made directory reads fallible, made regex compilation distinct from no-match, validated URL ports, and moved ArgParser/Regex/Arena/Pool/EventLoop construction onto their owning types.
- 2026-07-30 — S4-S7: made ASCII byte names explicit, changed string search methods to `Option<i64>`, hid HTTP/runtime plumbing, regenerated the supported reference, and added focused lint/API-surface checks.
- 2026-07-30 — Rebased cleanly onto `origin/main`; retained the incoming verifier contracts, namespace-alias support, and site copy. Fixed the self-host parser rename accidentally caught by the broad suite.
- 2026-07-30 — Implementation review found a duplicate import, stale Unicode documentation, and maintainer-facing crypto prose; all three were corrected and generated docs refreshed.

## Decisions
- Land domain-sized semantic changes and update all in-repo callers in the same slice.
- Do not preserve permanent aliases for one operation; record migrations in `docs/breaking-changes.md`.

## Blockers / open questions
- None.

## Verification
- [x] targeted tests: runtime plus alloca fixtures 627/627; API/docs/LSP/lint tests 38/38; generated-doc check 8/8
- [x] ran the app / fixture: full example runner completed; direct filesystem, regex, URL, arena, pool, event, and string fixtures passed
- [x] full `bun test`: 1297 pass, 17 skip; 15 failures are unavailable cross-tooling, known self-host lag, and unrelated baseline failures; targeted changed surfaces are green
- [x] agent review: implementation review completed and all three findings fixed
- [x] docs updated (last-verified bumped): design, language reference, idioms, breaking changes, site pages, roadmap/backlog, and generated std reference
