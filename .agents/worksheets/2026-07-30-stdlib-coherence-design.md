# Worksheet: standard library coherence design

- **Slug / tag:** `ws/stdlib-coherence-design`
- **Started:** 2026-07-30
- **Status:** done
- **Related:** `docs/roadmap.md`, `docs/backlog.md`, `docs/breaking-changes.md`

## Goal
Define a predictable public API model for Milo's standard library and record a prioritized, independently verifiable migration inventory for bringing existing modules into conformance.

## Plan
1. Audit representative and cross-cutting stdlib surfaces for naming, API shape, errors, and visibility.
2. Get research and plan reviews; resolve material objections.
3. Add the canonical design policy, route it from `AGENTS.md`, and add the migration track to planning docs.
4. Run docs lint and review the resulting diff.

## Current state
Done. `docs/stdlib-design.md` is the canonical policy and S0-S7 migration inventory; it is routed from `AGENTS.md`, tracked in the roadmap, ranked in the backlog, and reconciled with `CONVENTIONS.md`.

## Log
- 2026-07-30 — Read workflow, conventions, documentation standards, roadmap, breaking-change policy, idioms, and representative stdlib implementations. Mapped all 88 stdlib files and sampled core, filesystem, I/O, networking, parsing, text, concurrency, and utility APIs.
- 2026-07-30 — Research review returned no correctness or security findings. Audited planning docs and quantified representative inconsistencies: 18 filesystem commands return meaningless `Result<bool, IoError>`; `milo api` is lexical and displays private helpers; some cross-file runtime plumbing must remain `pub` because Milo has no package-private visibility.
- 2026-07-30 — Plan review returned no correctness findings. Added `docs/stdlib-design.md` with normative decision tables and the S0-S7 migration inventory; routed it from `AGENTS.md` and added one umbrella entry to the roadmap and ranked backlog.
- 2026-07-30 — Docs lint found only pre-existing repository warnings. Implementation review exposed no finding in the design material; reconciled `CONVENTIONS.md` so additive capability work remains backward-compatible while deliberate pre-1.0 coherence migrations can replace one spelling with another.
- 2026-07-30 — Targeted documentation tests passed 134/134 with five existing skips. Marked the design task done; no stdlib behavior changed.

## Decisions
- Treat this as an API design and migration-planning task; do not change runtime behavior in the same change.
- Prefer one intentional pre-1.0 migration over compatibility aliases that leave two permanent idioms.
- Define supported API separately from raw cross-file visibility until the language has package-private visibility.
- Use `Result<Unit, E>` for fallible commands with no success payload; `Result<void, E>` cannot represent a successful value.
- Put the detailed inventory in the canonical design doc and only one ranked umbrella item in `docs/backlog.md` to avoid duplicated lists drifting apart.

## Blockers / open questions
- None.

## Verification
- [x] targeted tests: `bun test tests/docs.test.ts` — 134 pass, 5 skip, 0 fail; `bun run scripts/lint.ts --all` — completed with pre-existing warnings only
- [x] ran the app / fixture: not applicable (documentation-only design task)
- [ ] full `bun test`: not run; no source or runtime behavior changed
- [x] agent review: research, plan, and implementation reviews completed; no finding against the design material
- [x] docs updated (last-verified bumped): `AGENTS.md`, `CONVENTIONS.md`, `docs/roadmap.md`, `docs/backlog.md`
