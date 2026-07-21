# Hylo comparison — outcome

Full graft plan rejected 2026-07-21: features failed the app-driven bar (no papercut list ever asked for them). What survives:

## Do now: design fence

Add to `docs/design.md` (near Ethos): **`&T` never gains storage, return, or generic-storage rights. Ergonomic pressure on references routes to spans/arenas, not first-class refs.** Rationale: Hylo's `let`/`inout` conventions compile to the same frame-confined references — Milo keeps the Rust-familiar spelling with MVS-equivalent semantics; the fence closes the lifetime slippery slope structurally.

## Backlog entries (add to docs/backlog.md, build only on trigger)

- **`@mustConsume` linear types** — trigger: a real app needs commit-vs-abort cleanup ambiguity (transactions, two-phase protocols) where Drop can't pick. Not before: Drop already covers plain cleanup. Sketch: upgrade the "param never moved" lint (`src/checker.ts:2152`) to a scope-exit error for annotated types; invert branch-merge polarity (consumed on ALL paths).
- **`prop` get/set sugar** — trigger: a third independent app complains about setter-method spelling. Sketch: pure desugar in `lower.ts` to method pairs; codegen untouched; hard-error `&x.p`.
