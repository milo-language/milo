<!-- doc-meta
system: coding-conventions
purpose: the specific code conventions review agents enforce (beyond what the linter catches)
key-files: scripts/lint.ts, docs/agent-review.md, .githooks/pre-commit
update-when: a convention is added/changed, or a review keeps flagging the same un-documented thing
last-verified: 2026-07-30
-->

# Coding Conventions

The rules reviewers check by hand. Anything mechanically checkable lives in `scripts/lint.ts` instead — if you find yourself repeating a note in review, move it there. This doc is for judgment calls a grep can't make.

## Milo language code (`.milo`, `std/`, `examples/`, `tests/`)
- **camelCase** for identifiers — functions, methods, locals, fields. Repo-wide, no exceptions.
- `let` by default; `var` only when you actually mutate. A `var` that's never reassigned is a smell.
- Move semantics: single owner. Don't clone to dodge a borrow error — understand the ownership first, clone only when a real copy is intended. Equally, don't strip a clone without checking: moving a field out of a container element is a compile error, and moving a field out of a plain struct leaves that struct partially moved.
- Iterate with `for` (it binds by reference); a manual `while i < x.len` cursor is a smell. Strings iterate as bytes; use `s.codePoints()` when the value is text. See [docs/milo-idioms.md](docs/milo-idioms.md).
- Build strings with `pushStr`/`push`, not `s = s + t` in a loop — the latter reallocates the whole accumulator per concat.
- Prefer existing stdlib. Run `milo api <terms>` before adding an API. A new capability lands *alongside* an existing API (e.g. `greenSpawn` next to `spawn`) rather than silently changing its contract. Deliberate pre-1.0 coherence migrations follow [docs/stdlib-design.md](docs/stdlib-design.md): migrate the whole domain, document the break, and do not retain permanent aliases for one operation.
- Errors are `Result<T,E>` with typed variants and auto-`From` wrapping; don't reach for panics/aborts in library code.
- Don't market Milo as "like TypeScript" in docs/comments — it's a Rust+TS blend.

## TypeScript compiler code (`src/`)
- Semantic errors are caught in `checker.ts` **before** codegen. If codegen can hit an invalid state, the checker missed it — fix the checker.
- LLVM IR uses opaque `ptr` (LLVM 15+), never `i8*`.
- New language feature = checker + lower + codegen **+ formatter + LSP**. The last two are part of done, not a follow-up.
- Match the file's existing structure. The checker splits only along a measured seam: a cluster whose transitive closure needs the fewest host members (`src/checker-program-passes.ts` took the five whole-program passes behind an 18-member host, 2026-09-20). A split that needs a wide interface, or that a prior attempt showed was dead code, is not a split; do not move code for tidiness alone.
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

## Docs that describe code
- Generate it or gate it — never restate it. A count, list, signature, table or index that
  describes the code must come from the code (`scripts/gen-*.ts`) or be compared to it by a
  test. See **Generate it, don't restate it** in [AGENTS.md](AGENTS.md) for the mechanism per
  claim type. Adding a hand-typed second copy of anything the compiler already knows is the
  defect, not the documentation gap it fills.

## Commits
- One line, all lowercase. No "coded with Claude". Commit worksheets + feedback with the work. Tag with `ws/<slug>`.
- Commit directly to `main` (Milo convention). Never force-push shared history.
