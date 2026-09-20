<!-- doc-meta
system: planning
purpose: ranked findings from the 2026-09-19 system-design review (dup unifier, dead code, abstraction police, split seam, useless tests) and which became work
key-files: src/checker.ts, src/types.ts, src/builtin-members.ts, std/crypto.*.milo, scripts/check-api-docs.ts, tests/apiDocsSite.test.ts
update-when: a finding ships or is declined
last-verified: 2026-09-19 (review at 61c80c6e)
-->

# Design pass, September 2026

Read-only review run alongside the soundness sweep. Motivating shape: H5 was one
judgment ("may this element be read by value") made at one site and not another.

| id | lens | location | finding | fix | status |
|---|---|---|---|---|---|
| F1 | dup | `checker.ts` `unwrapOr`/`unwrapOrElse` (4 sites) vs 22 `isCopy(` sites | bare `isCopy(inner)` without struct/enum callbacks: an all-scalar struct is Copy at `let e = d`, "non-Copy" at `a.unwrapOr(d)` | one `isCopyType()` chokepoint; make `types.ts:isCopy` callbacks required | WP12 |
| F2 | dup | `checker.ts` thread/global/purity/closure passes | `rootOf` x3, `callTarget` x4 (purity's lacks the `resolvedMethods` fallback), `fns` x4, `pretty` x2 rebuilt per pass; `rootNameOf` is the declared chokepoint | one `ProgramView` built in `checkProgram`; purity fixture for the late-resolved method | WP12 |
| F3 | dup | `checker.ts:3913,4084`, `safety.ts:336` | "builtin retains its argument" as three literal lists | `retainsArg`/`grows` flags on `BUILTIN_MEMBERS` | WP12 |
| F4 | dup (std) | `std/crypto.{darwin,linux,windows}.milo` | facade (`AesGcmResult`, `impl Crypto`, `aesGcm*` wrappers, `bytesToHex`) triplicated, darwin/linux byte-identical | shared `std/crypto.milo`, arms keep externs + `*Raw` | WP13 |
| F5 | split | `checker.ts` | cheapest seam: thread/global passes, 5 methods, 793 lines, 12 fields + 7 methods, 4 inbound | `checker-program-passes.ts` behind a narrow interface | after WP12 |
| F6 | dead | `tsc --noUnusedLocals --noUnusedParameters` | 65 unused locals/imports (codegen 21, checker 8, lower 8, lsp 5, visibility 7, scripts 7, tests 4) | fix and make it a gate | WP13 |
| F7 | dead | `check-api-docs.ts:200`, `release-meta.ts:23` | 2 dead exports; 51 `export` keywords with no external reference | delete 2, drop 51 | WP13 |
| F8 | abstraction | `lower.ts` embedFile host I/O, `checker.ts` `process.env` | host detail in lowering/checking | declined for now: works, low value | declined |
| F9 | abstraction | `scripts/playground/compiler.ts` | imports `src/*` | doc fix: sanction it in `docs/json-api.md` | WP13 |
| F10 | test | `tests/apiDocsSite.test.ts` | passes on 0 compared signatures; floor only in the CLI half | assert `comparedCount >= FLOOR` | WP13 |
| F11 | dead (API) | 55 `pub fn` in std, zero callers in-repo and across 13 sibling repos | public API, not dead | feed `docs/stdlib-audit-2026-08.md` | note |

Nothing found: dead warnings (`src/warnings.ts`), dead attributes, marker-less fixtures,
tautological asserts in `tests/*.test.ts`.
