<!-- doc-meta
system: worksheet
purpose: implementation trace for a generational arena sweep primitive needed by MiloJS GC migration
key-files: std/arena.milo, tests/fixtures/arenaHandles.milo, docs/std/arena.md
update-when: research, implementation, verification, or blockers change
last-verified: 2026-07-30
-->

# Worksheet: arena sweep

- **Slug / tag:** `ws/arena-sweep`
- **Started:** 2026-07-30
- **Status:** complete
- **Related:** MiloJS `e9143fb`, `docs/milojs-arena-safety.md`

## Goal

Add public live-handle enumeration to `std/arena` so a collector can inspect,
clean, and free selected slots through existing generation-checked APIs without
reconstructing handles from raw indices.

## Plan

1. Review API shape and ownership constraints; resolve how live slots are found.
2. Implement `arenaHandles` plus method API and focused lifecycle/reuse fixture.
3. Update generated/user docs and the MiloJS dependency note.
4. Run targeted fixture, `bun test`, examples, lint, and implementation review.
5. Commit with worksheet and tag `ws/arena-sweep`.

## Current state

Implementation and focused fixture are complete. `Arena<T>` now encodes live,
free, and retired state in its generation vector, validates that state on every
access, guards compact slot-index conversion, retires maximum-generation slots
instead of wrapping, and exposes free-function/method live-handle snapshots.
Generated and user docs are updated. The focused gate is green; full
repository failures are recorded below and are unrelated environment/baseline
failures.

## Log

- 2026-07-30 — Read repo workflow, stdlib design, tests, `std/arena`, and all
  existing arena guidance. Found `docs/ownership-model.md` currently endorses a
  hand-rolled MiloJS GC heap and calls generation checks pure overhead; later
  migration must update that claim and carry a performance gate.
- 2026-07-30 — Research review rejected the mutable callback design: a global
  alias can structurally mutate the arena while an element reference is live.
  Switched to a live-handle snapshot, which holds no element borrow across user
  code. Added planned empty/mixed/all-free and stale-reuse coverage.
- 2026-07-30 — Implemented lifecycle tracking and `arenaHandles`/`.handles()`.
  Plan review
  found generation wrap could eventually revalidate a stale handle; maximum-
  generation slots now become permanently retired. Focused
  `arenaHandles` fixture passes all snapshot/reuse/empty/all-free cases.
- 2026-07-30 — Correctness review found the pre-existing `i32` handle index
  narrowed the arena's `i64` Vec index. Added an explicit capacity assertion
  before the conversion, retaining the compact 16-byte handle representation.
- 2026-07-30 — Performance review found a separate occupancy vector added a hot
  access load and enumeration did not reserve known capacity. Free/retired state
  now uses non-positive generations, and snapshots reserve `live` handles.
- 2026-07-30 — Final testing review requested adversarial coverage for forged
  negative-generation handles and retired-slot enumeration. The fixture now
  checks every accessor rejects the forged handle without invoking callbacks,
  and confirms a retired slot is absent from `handles()`.

## Decisions

- Reuse `Handle<T>` generation and arena identity; do not expose raw indices or
  a handle-reconstruction API.
- `arenaHandles<T>(arena: &Arena<T>): Vec<Handle<T>>` returns a snapshot; the
  method spelling is the preferred API and the free function matches the
  existing `std/arena` compatibility surface.
- Positive generations are live, negative generations are reusable free slots,
  and zero is permanently retired. This keeps enumeration O(capacity) without a
  second per-slot allocation or load on hot access paths.
- Raw cleanup happens through `modifyMut` before `free`. User/native finalizers
  capable of allocation or re-entry are queued and drained after the caller's
  structural sweep.

## Blockers / open questions

- `Arena.free` retains the old `T` payload until reuse today. The MiloJS caller
  must clear owned payload before free; generic immediate destruction remains a
  separate storage-design question.
- Measure snapshot allocation cost when MiloJS adopts this API; a reusable
  caller-provided output buffer can follow if collection profiles justify it.

## Verification

- [x] targeted tests: `bun test tests/run.test.ts -t arenaHandles`
- [x] arena regression tests: `bun test tests/run.test.ts -t arena` (7 pass)
- [x] ran the app / fixture: fixture compiled and executed by targeted test
- [x] full `bun test`: 1299 pass, 17 skip, 14 fail, 1 error; failures are
  unrelated baseline/toolchain issues including missing `clang`, existing
  self-host/import-warning failures, and the project contract baseline
- [x] all examples: 42 compiled and 23 ran; five SDL examples could not link
  because this environment lacks `libSDL2`
- [x] lint: exits 0 with existing repository documentation warnings
- [x] agent review: correctness and security found no remaining issues;
  performance findings fixed; final testing findings fixed and covered
- [x] docs updated (last-verified bumped): generated API and user guide updated
