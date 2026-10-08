# Worksheet: `@embedFile` sigil spelling

- **Slug / tag:** `ws/embedfile-sigil`
- **Started:** 2026-07-23
- **Status:** in-progress
- **Related:** branch `embedfile-sigil`

## Goal
`@embedFile("path")` is the preferred spelling of the compile-time embed builtin;
bare `embedFile(...)` still works but emits the `bare-embedfile` warning (on by
default). Whole tree migrated except one fixture that proves the warning fires.

## Plan
1. `src/ast.ts` — `Call.sigil?: boolean`.
2. `src/parser.ts` — parsePrimary accepts `@name(...)` for compile-time builtins.
3. `src/checker.ts` — warn `bare-embedfile` when `!sigil`.
4. `src/lsp.ts` — completion for `@embedFile`.
5. `src-milo/parser.milo` — accept + drop the sigil (self-host parity).
6. Migrate `std/`, `examples/`, `tests/` call sites; keep one bare fixture.
7. Docs: language-reference (3 spots), grammar.ebnf, site warnings table, `--help`.
8. Tests: `tests/embedFileLint.test.ts` + fixtures; fmt round-trip.

## Current state
DONE. `@embedFile` parses, type-checks, lowers and codegens identically to the bare
form. Bare form warns `bare-embedfile` (on by default, `--allow`/`--deny` honored).
Whole tree migrated except `tests/fixtures/embedFileBare.milo`. Formatter, LSP
(completion + quickfix), self-host parser, docs and grammar all updated.

## Log
- 2026-07-23 — branch `embedfile-sigil` created; researched warning system
  (`checker.warn(code, ...)` + `WarningConfig{denied,allowed}`), formatter is
  `examples/cli-tools/fmt.milo` (token-based, `@` already hugs its name).
- 2026-07-23 — implemented parser sigil branch, checker warning, LSP completion +
  quickfix, self-host parser passthrough. Formatter needed a fix: `@` lexes as an
  Ident, so the statement-boundary reflow split `@ embedFile(...)` onto two lines
  (same class of bug as the `@cOpaque` field-attribute one) — added `prevWasAt`.
- 2026-07-23 — migrated 45 call sites across 5 example files + 2 test files.
  Added `embedFile`/`embedFileBare` to the self-host ratchet manifest.

## Decisions
- Sigil is parsed in `parsePrimary`, not the lexer: `@` is otherwise unused in
  expression position, so there's no ambiguity with attributes (decl/field-level).
- Self-host (`src-milo`) only *accepts* the sigil and drops it — no `sigil` field
  in its `Expr.Call`, which would ripple through every clone/match arm for no gain.
  The TS compiler owns the deprecation warning.

- Rust-style `embedFile!(...)` was rejected: postfix `!` is already the try operator
  (`readFile(p)!`), so `!` would mean two things in one expression.
- The warning duplicates once per monomorphization of a generic fn that calls the
  bare form. That is how every warning in this checker behaves (`unused-variable`
  does the same) — not worth a special case here.

## Blockers / open questions
- `docs/site/public/playground/compiler.js` is a hand-refreshed bundle snapshot of
  the compiler; it was already many features stale, so it was left alone. The
  browser playground has no filesystem, so `embedFile` is unusable there anyway.

## Verification
- [x] targeted tests: `tests/embedFileLint.test.ts` 7/7; `tests/run.test.ts -t
      embedFile` 3/3; `tests/fmt.test.ts` 15/15; `tests/formatter.test.ts` 21/21;
      `tests/lsp.test.ts` 22/22; `tests/selfhost.test.ts` 175/175 (+2 new manifest
      entries); `tests/typecheck.test.ts` (tsc gate) 1/1; docs/std/api docs 126/126;
      parser/modules/abi 18/18; all five lint suites 28/28;
      `tests/examples.test.ts` for webserver/weather/termpair/fmt/minibun 5/5.
- [x] ran the app / fixture: built + ran webserver, weather, termpair/server,
      milojs, minibun (`--fast`, zero warnings); ran both fixtures; verified
      binary-safe embedding (10-byte file with 0x00/0x80/0xff bytes, byte sum 1010
      identical for both spellings); verified milo-self compiles + runs both.
- [ ] full `bun test`: SKIPPED by instruction (memory pressure / guard sheds)
- [x] docs updated: language-reference (3 spots), grammar.ebnf, site ffi /
      functions / reference / warnings-and-errors, `--help`
