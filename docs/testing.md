<!-- doc-meta
system: testing
purpose: how to write/run tests, what to avoid, and an index of every test file and what it covers
key-files: tests/run.test.ts, tests/fixtures/, tests/errors/, tests/*.test.ts
update-when: a test file is added/removed/repurposed, or the fixture protocol changes
last-verified: 2026-07-11
-->

# Testing

Run targeted subsets while iterating; run the full suite before commit.

```bash
bun test                                        # everything
bun test tests/run.test.ts -t "arithmetic"      # one fixture by @name/description
bun test tests/safety.test.ts                   # one file
```

## The fixture protocol (no code changes to add a test)
`tests/run.test.ts` walks two directories:
- `tests/fixtures/*.milo` — **compiled + executed.** stdout must match the `// @expect: <line>` annotations, one per expected output line.
- `tests/errors/*.milo` — **must fail type-check.** Error output must contain the `// @error: <substring>` annotation.

Add a test by dropping a `.milo` file in the right directory with the right annotation. That's it. (339 fixtures, 73 error cases as of last-verified.)

There's also `tests/runtime-errors/` for programs that compile but must fail at runtime.

## Examples as smoke tests
`bun run scripts/run-examples.ts` compiles **every** example entrypoint (`examples/**/*.milo` with a `fn main`) — a hard gate — and runs the ones that opt in:
- `// @run: <args>` near the top → runs with those args, must exit 0. Bare `// @run:` = no args.
- `// @stdin: <text>` → fed on stdin (a trailing newline is added).
- No annotation → compile-only (right for servers, TUIs, and tools needing setup). Library modules (no `main`) are skipped automatically.

When you add or change an example, add a `// @run:` if it can run deterministically, so it's exercised and not just built. This is part of the mandatory Run gate ([AGENT_WORKFLOW.md](../AGENT_WORKFLOW.md)).

## How to write a good test
- **Assert the thing the test names.** A test called `move_after_use_errors` must fail if move-checking breaks — not pass because of an unrelated compile error. Prefer `tests/errors/` with a specific `@error:` substring over a vague one.
- **Minimal fixture.** Smallest program that exercises the behavior; unrelated code hides the signal.
- **One concept per fixture.** Easier to name, easier to bisect when it breaks.
- Feature work touches checker + lower + codegen + **formatter + LSP** — so a feature usually needs fixtures *and* a `formatter.test.ts` / `lsp.test.ts` case.

## What to avoid (false-confidence smells)
- A fixture whose `@expect` would pass even if the feature it names were deleted. If deleting the feature keeps it green, it tests nothing.
- Asserting a coincidence (an output that happens to match for the wrong reason).
- `test.only` / `.skip` committed — the linter blocks these; they silently shrink the suite.
- Testing only the happy path when the interesting behavior is the error/edge path.
- Periodically run a false-confidence audit: pick a claim, break the code that should satisfy it, confirm a test goes red. If none do, the coverage is a mirage.

## Test file index
| File | Covers |
|---|---|
| `run.test.ts` | fixture driver — compiles+runs `fixtures/`, checks `errors/` fail-to-typecheck |
| `safety.test.ts` | memory-safety / move-checking / borrow rules |
| `unsafeLint.test.ts` | `unsafe` block linting |
| `abi.test.ts` | struct-by-value C FFI / native ABI lowering |
| `modules.test.ts` | import resolution + cross-file merge |
| `formatter.test.ts` | `milo fmt` output stability |
| `lsp.test.ts` / `lspProject.test.ts` | LSP diagnostics/hover/go-to-def; project-wide LSP |
| `selfhost.test.ts` | milo-self bootstrap convergence (guarded) |
| `debugInfo.test.ts` | DWARF emission (`-g`) |
| `wcet.test.ts` / `wcetCycles.test.ts` | worst-case-execution-time analysis |
| `allocaHoist.test.ts` / `zeroStore.test.ts` | codegen optimizations |
| `guard.test.ts` | memory/timeout guard wrapper |
| `docs.test.ts` / `stdDocs.test.ts` / `apiDocs.test.ts` | doc + stdlib-API-doc consistency |
| `header.test.ts` | generated C header correctness |
| `embedded.test.ts` | embedded/no-runtime target |

Keep this table current — it's the map reviewers and the sweep skill use to reason about coverage.
