<!-- doc-meta
system: planning
purpose: ranked findings from the 2026-09-19 system-design review (dup unifier, dead code, abstraction police, split seam, useless tests) and which became work
key-files: src/checker.ts, src/types.ts, src/builtin-members.ts, std/crypto.milo, std/cryptosys.*.milo, scripts/check-api-docs.ts, tests/apiDocsSite.test.ts
update-when: a finding ships or is declined
last-verified: 2026-09-20 (F1-F3 and the checker unused-locals follow-up shipped in WP12)
-->

# Design pass, September 2026

Read-only review run alongside the soundness sweep. Motivating shape: H5 was one
judgment ("may this element be read by value") made at one site and not another.

| id | lens | location | finding | fix | status |
|---|---|---|---|---|---|
| F1 | dup | `checker.ts` `unwrapOr`/`unwrapOrElse` (4 sites) vs 22 `isCopy(` sites | bare `isCopy(inner)` without struct/enum callbacks: an all-scalar struct is Copy at `let e = d`, "non-Copy" at `a.unwrapOr(d)` | one `isCopyType()` chokepoint; make `types.ts:isCopy` callbacks required | shipped (WP12): `tests/fixtures/unwrapOrCopyStruct.milo`; codegen already loaded the payload as a first-class aggregate |
| F2 | dup | `checker.ts` thread/global/purity/closure passes | `rootOf` x3, `callTarget` x4 (purity's lacks the `resolvedMethods` fallback), `fns` x4, `pretty` x2 rebuilt per pass; `rootNameOf` is the declared chokepoint | one `ProgramView` built in `checkProgram`; purity fixture for the late-resolved method | shipped (WP12): `ProgramView { fns, calleeOf, rootOf, pretty }`; `rootOf` is `rootNameOf`. Purity's `callTarget` was only used for `Call` nodes and its `MethodCall` arm read `resolvedMethods` directly, so the "missing fallback" was textual, not a reachable miss; no fixture |
| F3 | dup | `checker.ts:3913,4084`, `safety.ts:336` | "builtin retains its argument" as three literal lists | `retainsArg`/`grows` flags on `BUILTIN_MEMBERS` | shipped (WP12): `RETAINING_MEMBERS` / `GROWING_MEMBERS`; `set` and `append` in the old literals named no builtin, `pushStr`/`reserve` were missing from the growth list |
| F4 | dup (std) | `std/crypto.{darwin,linux,windows}.milo` | facade (`AesGcmResult`, `impl Crypto`, `aesGcm*` wrappers, `bytesToHex`) triplicated, darwin/linux byte-identical | shared `std/crypto.milo`, arms keep externs + `*Raw` | WP13 |
| F5 | split | `checker.ts` | cheapest seam: thread/global passes, 5 methods, 793 lines, 12 fields + 7 methods, 4 inbound | `checker-program-passes.ts` behind a narrow interface | shipped: `src/checker-program-passes.ts` (the five, plus their private helpers `retainsParam` and `mutatesReceiver`) behind `ProgramPassHost`, 12 recorded maps + 6 methods, built as a literal by `TypeChecker.programPassHost` so the fields stay private; `ProgramView` moved with them; `MUTATING_COLLECTION_METHODS` moved to `builtin-members.ts` so the two files do not import each other |
| F6 | dead | `tsc --noUnusedLocals --noUnusedParameters` | 65 unused locals/imports (codegen 21, checker 8, lower 8, lsp 5, visibility 7, scripts 7, tests 4) | fix and make it a gate | WP13 |
| F7 | dead | `check-api-docs.ts:200`, `release-meta.ts:23` | 2 dead exports; 51 `export` keywords with no external reference | delete 2, drop 51 | WP13 |
| F8 | abstraction | `lower.ts` embedFile host I/O, `checker.ts` `process.env` | host detail in lowering/checking | declined for now: works, low value | declined |
| F9 | abstraction | the browser bundle of the JS backend | imports `src/*` | moot: removed with the JS backend 2026-09-21 | done |
| F10 | test | `tests/apiDocsSite.test.ts` | passes on 0 compared signatures; floor only in the CLI half | assert `comparedCount >= FLOOR` | WP13 |
| F11 | dead (API) | 55 `pub fn` in std, zero callers in-repo and across 13 sibling repos | public API, not dead | feed `docs/stdlib-audit-2026-08.md` | note |

The WP13 follow-up (8 `noUnusedLocals` diagnostics and 9 in-file-only `export`s in
`src/checker.ts`, plus the carve-out in `tests/typecheck.test.ts`) shipped with WP12; the
typecheck gate now covers `src/checker.ts` like every other file.

Nothing found: dead warnings (`src/warnings.ts`), dead attributes, marker-less fixtures,
tautological asserts in `tests/*.test.ts`.
