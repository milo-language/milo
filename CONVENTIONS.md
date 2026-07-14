<!-- doc-meta
system: coding-conventions
purpose: the specific code conventions review agents enforce (beyond what the linter catches)
key-files: scripts/lint.ts, docs/agent-review.md, .githooks/pre-commit
update-when: a convention is added/changed, or a review keeps flagging the same un-documented thing
last-verified: 2026-07-11
-->

# Coding Conventions

The rules reviewers check by hand. Anything mechanically checkable lives in `scripts/lint.ts` instead — if you find yourself repeating a note in review, move it there. This doc is for judgment calls a grep can't make.

## Milo language code (`.milo`, `std/`, `examples/`, `tests/`)
- **camelCase** for identifiers — functions, methods, locals, fields. Repo-wide, no exceptions.
- `let` by default; `var` only when you actually mutate. A `var` that's never reassigned is a smell.
- Move semantics: single owner. Don't clone to dodge a borrow error — understand the ownership first, clone only when a real copy is intended.
- Prefer existing stdlib. Run `milo api <terms>` before adding an API. New APIs land *alongside* old ones (e.g. `greenSpawn` next to `spawn`) — don't change semantics of a shipped API to add a capability.
- Errors are `Result<T,E>` with typed variants and auto-`From` wrapping; don't reach for panics/aborts in library code.
- Don't market Milo as "like TypeScript" in docs/comments — it's a Rust+TS blend.

## TypeScript compiler code (`src/`)
- Semantic errors are caught in `checker.ts` **before** codegen. If codegen can hit an invalid state, the checker missed it — fix the checker.
- LLVM IR uses opaque `ptr` (LLVM 15+), never `i8*`.
- New language feature = checker + lower + codegen **+ formatter + LSP**. The last two are part of done, not a follow-up.
- Match the file's existing structure; the checker is a monolith by design (a prior split was dead code and deleted — don't re-split).
- Platform-specific code splits by filename suffix (`*.darwin.ts` / `*.linux.ts`), resolved per host — don't branch on `process.platform` inline where a suffix split fits.

## Comments
- Comment the **why**, not the what: hidden constraints, invariants, workarounds, surprises. Well-named identifiers cover the what.
- File-level one-line purpose comments are welcome.
- No commented-out code in commits. No `debugger;`, no stray `console.log` debugging.

## Tests
- Add a fixture by dropping a `.milo` file with `// @expect:` / `// @error:` annotations — no driver changes. See [docs/testing.md](docs/testing.md).
- No focused/skipped tests committed (`test.only`, `.skip` without a reason). The linter blocks these.
- A test must fail if the behavior it names breaks. Assert the real thing, not a coincidence — see the false-confidence guidance in [docs/testing.md](docs/testing.md).

## Safety / guards (hard rules — see CLAUDE.md)
- Never run `.selfhost/milo-self.bin` bare. Never commit `MILO_RUN_UNGUARDED=1`.
- Don't raise sweep/test concurrency or per-child mem caps without redoing the math in `scripts/guard.ts`.

## Commits
- One line, all lowercase. No "coded with Claude". Commit worksheets + feedback with the work. Tag with `ws/<slug>`.
- Commit directly to `main` (Milo convention). Never force-push shared history.
