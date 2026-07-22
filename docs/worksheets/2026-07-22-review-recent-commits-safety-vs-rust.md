# Worksheet: review recent commits and safety claims vs Rust

- **Slug / tag:** `ws/review-recent-commits-safety-vs-rust`
- **Started:** 2026-07-22
- **Status:** done
- **Related:** `docs/memory-safety-vs-rust.md`, `rust-comparison/`, last 15 commits

## Goal
Audit the last 15 commits for cross-cutting regressions and verify the published Milo-versus-Rust safety claims against runnable evidence and the current compiler. Report only confirmed findings with concrete fixes.

## Plan
1. Map the combined diff and identify affected safety, compiler, tooling, docs, and test surfaces.
2. Run repository lint and inspect commit interactions for regressions, guard drift, stale docs, weak tests, and abandoned TODOs.
3. Reproduce the Rust/Milo receipts and the broader threat-matrix probes; trace disputed claims to code and authoritative Rust behavior.
4. Run cross-model review, confirm or reject its findings, and deliver a severity-ranked review.

## Current state
Audit and fixes complete. The receipt suite now asserts both languages' outcomes with Rust 1.96.1, includes a dependency-free generational-key steelman, and retains the new safety probes. Cross-arena handles carry arena identity. Thread-transfer overrides use explicit `unsafe impl` marker declarations; structural derivation remains the default, and generic overrides still require every concrete type argument to satisfy the marker. CI action tags and review tooling were repaired, the browser compiler was regenerated, and the comparison/design docs now state tested scope and trust boundaries.

## Log
- 2026-07-22 — Loaded the workflow, commit-sweep procedure, hard rules, testing guidance, and safety comparison. Noted unrelated pre-existing untracked files and left them untouched.
- 2026-07-22 — Ran the repo linter and both receipt modes. Rust was absent; the runner mislabeled command-not-found as a blank compile error and still exited zero.
- 2026-07-22 — Verified every newly selected GitHub Action major tag against upstream refs; all seven are absent.
- 2026-07-22 — Read checker, arena, concurrency, overflow, and contract implementation paths and their tests. Reproduced cross-arena handle confusion (`carol`) and the unchecked `@send` override in executable Milo programs.
- 2026-07-22 — Attempted minimal Rust installation; DNS resolution was unavailable. Subsequently located fbsource Rust 1.96.1 and ran both release and debug receipts.
- 2026-07-22 — Ran focused affected tests. Overflow release-wrap and `--overflow-checks` trap tests passed. The combined fixture invocation produced 560 empty-stderr bulk build failures, so it is recorded as an invalid/overloaded verification run rather than evidence about individual features.
- 2026-07-22 — Located fbsource Rust 1.96.1 and compiled every committed Rust receipt with `-C linker-features=-lld` to use the host linker. Release/debug outcomes match the receipt table; the arena receipt remains a deliberately naive baseline rather than a Rust steelman.
- 2026-07-22 — Added concise observed Rust/Milo diagnostics to the VitePress comparison table and softened the cyclic-data Rust result to depend on representation. Docs build could not run because dependencies are absent and package downloads are connection-refused.
- 2026-07-22 — Replaced the raw-index Rust example's steelman claim with an explicit baseline and added a typed generational-key Rust implementation. Both implementations reject stale access.
- 2026-07-22 — Replaced unchecked `@send` / `@sync` attributes with empty `unsafe impl Send` / `Sync` marker declarations and retained structural checking for ordinary types. Independent review found blanket generic propagation; fixed it so `Wrapper<*u8>` remains non-Send and added a rejection fixture.
- 2026-07-22 — Added per-arena identity to `std/arena` handles and a retained cross-arena rejection fixture. Public handle fields remain forgeable as logic capabilities, but all accesses remain bounds/generation/arena checked and cannot produce memory UB in safe code.
- 2026-07-22 — Added retained array-bounds, signed-division-overflow, heap-use-after-move, and nullability probes. Updated Vite and repository docs to distinguish compile-time rejection, runtime traps, and explicit unsafe/FFI trust boundaries.
- 2026-07-22 — Cleaned self-host compiler unused-result warnings and updated its syntax compatibility, although the TS compiler remains authoritative. Self-host manifest and bootstrap convergence passed.
- 2026-07-22 — Fixed sparse-address-space guard failures without weakening RSS limits, capped compile parallelism, and repaired deterministic Genesis/gzip/embedded example issues found by the executable sweep.
- 2026-07-22 — Ran all review personas after fixing the review script. The only reported high-severity finding was unconditional generic marker propagation; confirmed and fixed with a regression test.

## Decisions
- Use the commit-sweep default `HEAD~15..HEAD`; the user did not specify a different range.
- Treat marketing/comparative claims as reviewable correctness claims, not merely prose.

## Blockers / open questions
- VitePress build remains unavailable locally: `docs/site/node_modules` is incomplete and network installation is connection-refused. Markdown snippets pass the repository docs test, and the checked-in playground compiler bundle was regenerated.
- Native executable sweep compiled 77 examples and ran 24; 12 SDL2/JavaScriptCore-dependent targets could not link in this environment. The compiler-only examples suite passes all 47 selected entries.

## Verification
- [x] targeted tests: guards, docs, examples, native dl/embedded, formatter, prover, safety fixtures
- [x] ran the app / fixture: both Rust receipt modes, arena and thread-transfer probes, executable-example sweep
- [x] full `bun test`: 1141 pass, 8 skip; 9 failures found (formatter plus sparse-VM prover guard), all fixed and focused reruns pass
- [x] agent review: all personas completed; generic marker finding fixed and retained
- [x] docs updated (last-verified bumped): repository docs, Vite docs, safety roadmap, and playground compiler
