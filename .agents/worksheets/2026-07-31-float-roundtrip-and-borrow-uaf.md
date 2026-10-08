# Worksheet: shortest-round-trip float printing + move-out-of-borrow UAF

- **Slug / tag:** `ws/float-roundtrip-and-borrow-uaf`
- **Started:** 2026-07-31
- **Status:** done
- **Related:** docs/memory-safety-vs-rust.md finding #2, docs/backlog.md Tier-2 #16/#17/#18

## Goal

Floats print the shortest decimal that reads back as the same value, everywhere
(`toString`, interpolation, struct display, `jsonStringify`, and the JS backend). Plus:
whatever the red tests on `main` turn out to be, fixed rather than baselined.

## Plan

1. `src/codegen.ts` — replace the three `%g` sites with a round-trip search helper. Verify by
   probe program + a retained fixture.
2. `src/codegen-js.ts` — mirror it so the playground matches the binary. Verify by diffing
   native vs `emit-js` output.
3. Fixture expectations that legitimately change; a `memoryGrowth` case for the new buffers.
4. Whatever the pre-existing red tests are.
5. Docs: language-reference, memory-safety, backlog, stale `last-verified`.

## Current state

Done. All of the above landed, plus three unplanned fixes found on the way (see Log).

## Log

- 2026-07-31 — Probed: `1/3` → `0.333333`, `123456789.123456` → `1.23457e+08`, `0.1+0.2` → `0.3`.
  Confirmed real data loss, not a display nicety.
- 2026-07-31 — First helper attempt searched precision upward from 1 and was *wrong in a new
  way*: `100.0` came out `1e+02`. `%g` goes exponential once the exponent reaches the
  precision, so shortest-precision alone is not shortest-*readable*. Reworked to start the
  search at the integer-digit count, computed by walking powers of ten (no libm, so no `-lm`
  question on Linux).
- 2026-07-31 — Added a real `f32` variant (`strtof`, 9-digit cap). Without it an `f32` printed
  the promoted double's digits: `0.3333333432674408` instead of `0.33333334`.
- 2026-07-31 — **Unplanned #1:** `struct P { y: f32 }` + `P { y: 0.1 }` did not compile at all
  on `main` — the literal emitted its *double* bit pattern for a `float` operand, which LLVM
  rejects outright. Fixed in `formatFloatBits` by rounding through `Math.fround`.
- 2026-07-31 — **Unplanned #2 (the big one):** the two red `tests/mangle.test.ts` tests were
  not a package-manager bug and not the known guard false-positive. The program printed 19 NUL
  bytes and was SIGKILLed. Root cause reproduced in plain Milo with no package system: returning
  a non-`Copy` field out of a `&T` was accepted and use-after-freed. See Decisions.
- 2026-07-31 — **Unplanned #3:** `examples/simulation/windtunnel/{cavity,windtunnel,lbm}.milo`
  still imported `mathAbs`/`mathSqrt`/… from before the stdlib coherence rename, so 2 examples
  had been failing to compile. Migrated to the `Math` namespace.

## Decisions

- **Digit search starts at the integer-digit count, not at 1.** Shortest round-tripping
  *precision* is not the same as shortest readable output; `%.1g` of `100.0` round-trips and is
  unreadable. Starting at the magnitude gives `100`, and costs nothing (it strictly reduces
  iterations).
- **Powers-of-ten walk instead of `log10`.** Avoids a libm dependency entirely — `log10` would
  need `-lm` on Linux, which is already a known CI trap.
- **The move-out-of-borrow fix rejects rather than clones implicitly.** An implicit deep copy
  at a `return` would be a hidden allocation in a hot path, which is exactly what the ownership
  model exists to make visible. It matches the rule already applied to a whole `&T` binding.
- **Closure bodies are exempt from that rule.** `users.sortByKey((u: &User) => u.name)` is the
  documented way to sort by a string field and is sound because the sort builtins never drop
  the extracted key. Deciding this in general needs the callee's contract, which the checker
  does not have at that point. This leaves a narrower hole, recorded in
  memory-safety-vs-rust.md finding #2 as the next thing to probe — *not* silently.
- **`.clone()` now exists on `Copy` scalars as the identity.** Forced by the rule: a generic
  `fn get<T>(w: &Wrapper<T>): T` has to have one spelling that compiles for `T = i64` and
  `T = string`. Matches Rust, where `Copy: Clone`.
- **Did not implement per-module namespaces** despite verifying it is cheap and
  source-compatible. Its carve-outs (`extern` symbols, `@cName`, `main`) fail *silently*, so it
  wants its own diff and its own link-level test pass. Written up instead:
  `docs/plans/module-namespaces.md`, backlog Tier-2 #18.

## Blockers / open questions

- Closure bodies returning a borrowed field to a *user* function that drops it is still
  unsound. Narrower than what was fixed; recorded as the next probe.
- `jsonStringify` emits `nan`/`inf` for non-finite floats, which no JSON parser accepts. Noted
  in the language reference; not fixed here (it is a JSON-semantics decision, not a formatting
  one).
- Bounds-check elision and SIMD are planned, not started — `docs/plans/bounds-check-elision.md`
  and `docs/plans/simd.md`. Both start with "measure first"; neither number is in hand.

## Verification

- [x] targeted tests: `tests/run.test.ts -t floatRoundTrip` / `-t f32Literal` pass;
      `tests/mangle.test.ts` 4/4 (was 2/4 on `main`); `tests/docs.test.ts` 140 pass, 0 fail
      (was 2 failing on `main`).
- [x] ran the app / fixture: native vs `emit-js` float output diffed **identical**;
      `scripts/run-examples.ts` → **57 compiled, 0 failed** (was 2 failed on `main`).
- [x] full `bun test`: see final run in the commit; started at 7 failures (5 caused by this
      change, 2 pre-existing), ended at 0.
- [x] leak gate: new `floatFormatBuffers` case in `tests/memoryGrowth.test.ts` — 200k
      iterations across all three float-formatting paths, flat at ~1.5 MB.
- [ ] agent review: not run.
- [x] docs updated (last-verified bumped): language-reference, memory-safety-vs-rust, backlog,
      AGENTS.md.
