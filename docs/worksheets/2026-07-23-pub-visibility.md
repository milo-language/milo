# Worksheet: `pub` visibility — private by default

- **Slug / tag:** `ws/pub-visibility`
- **Started:** 2026-07-23
- **Status:** DONE (landed on main 2026-07-24, CI green)
- **Related:** [docs/plans/package-manager.md](../plans/package-manager.md) §P-1

## Goal

Milo declarations are file-private by default. `pub` exports them. Referencing a non-`pub` declaration from another file is a compile error naming both files. Prerequisite for packages: without it every internal helper is somebody's dependency.

Observably done: a fixture in `tests/errors/` that references a private fn across files fails to check with a clear message; all of `std/` carries `pub` on its public surface; full `bun test` + `run-examples.ts` green.

## Research findings

1. **`pub` collides with nothing.** Only occurrence in any `.milo` file is inside a *string literal* (`examples/cli-tools/cat.milo:106`, a Rust keyword list for syntax highlighting).
2. **Soft keyword, not reserved.** `parser.ts:41` `atSoftKw` already backs `from` (disambiguated by lookahead: `from` + String = import). Same trick for `pub` + decl-starter token. Keeps `pub` legal as an identifier — zero breaking change. Do NOT add to `KEYWORDS` (`tokens.ts:111`).
3. **Imports do not scope.** `resolver.ts:175`: *"merge everything — named imports validate but don't restrict (flat compilation)"*. Every declaration from every transitively-imported file lands in one namespace. So enforcing `pub` at the import site is only half the guarantee — a reference to a never-imported private name still resolves.
4. **Enforcement is therefore a checker pass**, and it is tractable: `Span` carries `file` (`ast.ts:1`, set at `parser.ts:34`), and decls carry `sourceFile` (set at `resolver.ts:176`). Both sides of "is this reference in the declaring file?" already exist.
5. **Unit of privacy = the file.** Matches how the resolver already thinks (`sourceFile`, `preludeFiles`).
6. **`@export` is unrelated** — it forces C external linkage (`checker.ts:1169`). Reason `pub` beats `export` as the spelling.
7. Scale: 1312 top-level decls in `std/`; examples+tests hold ~3327 but are leaves (nothing imports them) so need no annotation.

## Plan

Two passes. Pass 1 is behavior-preserving, which is what makes pass 2 safe to do slowly.

1. **`tokens.ts` / `parser.ts` / `ast.ts`** — parse `pub` as a soft keyword before a decl starter; `isPub?: boolean` on FnDecl/StructDecl/EnumDecl/TraitDecl/InterfaceDecl/TypeAlias/GlobalDecl. Verify: parse-only fixture.
2. **`formatter` (`examples/cli-tools/fmt.milo`)** — print `pub` and round-trip it. Non-negotiable per repo definition-of-done.
3. **Codemod `pub` onto every top-level decl in `std/`** — pure insertion, semantically identical to today. Verify: full `bun test` green with enforcement still off.
4. **`checker.ts` enforcement** — on name resolution, if the resolved decl is non-`pub` and `decl.sourceFile !== ref.span.file`, error. Off for prelude/std-internal paths initially. Verify: new `tests/errors/` fixture.
5. **`lsp.ts`** — completions must not offer private names from other files; hover shows visibility.
6. **Docs** — `docs/language-reference.md`, `docs/grammar.ebnf`, `docs/breaking-changes.md` (AGENTS.md routes any public-name change there).
7. Pass 2 (incremental, later): strip `pub` where nothing outside the module references the name.

## Current state

**All steps done.** `pub` parses on struct/enum/type/global/trait/fn/interface/extern, is rejected on `impl` and `import` with a diagnostic naming the rule, and remains usable as an ordinary identifier. **It carries no meaning yet** — nothing enforces it, so this is a pure parse-and-record change and every existing program behaves identically.

Next: formatter (step 2) before anything else — `fmt` will currently drop `pub` on reformat, which would silently strip visibility from source. Do not codemod std (step 3) until the formatter round-trips `pub`.

## Log

- 2026-07-23 — Researched: soft-keyword approach chosen, flat-namespace enforcement gap found (finding 3), worksheet opened.
- 2026-07-23 — Implemented step 1: `isPub?: boolean` on 7 decl types (`ast.ts`), soft-keyword parse + `startsDecl` lookahead (`parser.ts`). tsc clean (0 `src/` errors). Verified by running real programs, not just parsing.
- 2026-07-23 — Full `bun test` is NOT usable as a gate right now: a concurrent agent is building in the main clone (12 live `bun`/`clang` procs, load ~7), and the memory guard sheds test builds fail-closed (`[guard] SIGKILL: system memory pressure`). Counts are noise-dominated — baseline with my changes *stashed* was worse (321 pass/258 fail) than with them applied (468/111). CI is green on `485affbc`, the fork point. Full-suite validation deferred to a quiet machine.

## Decisions

- **Soft keyword, not reserved word.** Zero breaking change; matches the `from` precedent. Reserved-word status can come later if it ever earns it.
- **`pub`, not `export`.** `@export` already means C external linkage; two exports one sigil apart is worse than a new word.
- **Not `_name`.** The underscore prefix already means *deliberately unused*; overloading it makes both meanings ambiguous.
- **File is the privacy unit**, matching the resolver's existing `sourceFile` model.
- **Pass 1 marks everything `pub`** rather than auditing as it goes — a pure-insertion diff is reviewable, and it decouples the risky part (removing) from the mechanical part.

## Blockers / open questions

- Struct field visibility: recommend deferring (a `pub struct` exposes its fields). Per-field is a much larger checker change and is additive later.
- `pub` on trait methods: recommend implied by the trait's visibility, not separately spelled.
- Does enforcement apply *within* `std/` (module-to-module), or is std exempt until pass 2? Leaning exempt-then-tighten, so pass 3 doesn't have to land atomically.

## Verification

- [x] tsc gate: `bunx tsc --noEmit -p tsconfig.json` → 0 errors under `src/`. (Worktree needed `node_modules` symlinked from the main clone first — a fresh worktree install lacks bun-types and yields ~331 phantom errors. This is the known worktree-tsc false-fail.)
- [x] ran real programs (not just parsed):
  - `pub` on struct/enum/type/global/trait/fn → compiles and prints `24` (= `helper(7) + limit`)
  - `pub` still legal as an identifier: `fn pub(...)` + `var pub` → prints `6`. Soft keyword confirmed, zero breaking change.
  - `pub impl P` → `'pub' cannot mark an impl block — an impl's visibility follows the type it implements`
  - `pub from "std/io" import {...}` → `'pub' cannot mark an import — it applies to declarations, and an import is not re-exported`
- [x] targeted subset: `bun test tests/run.test.ts -t "arithmetic"` → 1 pass, 0 fail
- [ ] full `bun test` — **BLOCKED on machine contention, not on the code.** Rerun on a quiet box before committing beyond this branch.
- [ ] `bun run scripts/run-examples.ts`
- [ ] agent review: `scripts/agent_review.sh implementation`
- [ ] docs updated (language-reference, grammar.ebnf, breaking-changes; bump `last-verified`)

## Outcome (2026-07-24)

Landed on main, CI green (macOS + Linux + Windows). Full suite 1251 pass / 7 skip / 0 fail.

Shipped beyond the original plan:
- `import { x as y }` aliasing (needed as the collision fix for P0).
- **`declOrigins`** — the plan assumed visibility could be derived from the merged
  program. It cannot: the flat namespace discards definitions (identical-body dedup,
  and user override of a std fn), so a name still defined in the referencing file
  looked "private to somewhere else". The resolver now records every decl's origin
  file + pub-ness as each file is parsed, pre-merge.
- The `_name` privacy convention is retired: 225 helpers renamed, 212 made genuinely
  private. 43 keep the underscore — an `extern fn` binds its C symbol BY NAME
  (`_get_osfhandle`, `__errno_location`), so renaming one breaks the link; the rest
  would collide. **Never rename an extern.**

Corrections to the plan's assumptions:
- "Examples and tests are leaves, so they need no annotation" is false for any
  multi-file project: `src-milo/` (175 failures), the import fixtures, and
  `modules.test.ts`'s inline sources all needed `pub` on cross-file names.
- Any tool that parses decl lines needs to accept an optional `pub ` prefix.
  `scripts/audit-extern-returns.ts` silently dropped from 199 checked externs to 0;
  it only failed CI because it self-guards with "verified nothing — the audit is
  broken, not the code". Worth copying that guard pattern into other audits.
