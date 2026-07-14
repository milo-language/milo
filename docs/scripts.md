<!-- doc-meta
system: dev-scripts
purpose: index of agent-facing scripts and how to write new ones well; agents should keep building these out
key-files: scripts/, bin/, .githooks/, scripts/lint.ts, scripts/agent_review.sh
update-when: a script is added/removed/changed, or the scripting conventions change
last-verified: 2026-07-11
-->

# Dev Scripts & Tools

`scripts/` holds the tools that make agent work faster: things you'd otherwise re-derive the incantation for every time. **Build these out constantly** — the moment you find yourself running the same 3-command dance twice, or memorizing a tool's flags, write a script and add it here. A good script turns tribal knowledge into a one-liner.

## When to write one
- A multi-step operation you've now done twice (bundle, sweep, regenerate).
- A tool with an obscure/verbose invocation you keep looking up.
- Anything a review persona or the sweep skill needs to run consistently.
- Wrapping *other* tools so the agent doesn't need to know their particular flags (that's exactly what `agent_review.sh` does for review CLIs).

## How to write one well
- **Self-documenting.** `--help` prints usage; the file's top comment says what/why. First line is a one-sentence purpose.
- **Bun for TS, POSIX `sh` for glue.** TS scripts: `bun run scripts/foo.ts`. Match the existing style in this dir.
- **Safe by default.** Anything that runs a compiled milo binary must go through `scripts/guard.ts` (mem/timeout watchdog) — never invoke a milo-self binary bare (CLAUDE.md). Read-only by default; mutation behind an explicit flag.
- **Composable exit codes.** 0 = ok, non-zero = fail, so hooks/CI can chain them. Print machine-parseable output when a script feeds another.
- **`--fix` where it makes sense.** A checker that can also repair is worth far more than one that only complains (see `lint.ts`).
- **No secrets in the file.** Read from env; document required vars in the header.

## Index
| Script | Purpose |
|---|---|
| `scripts/lint.ts` | repo linter — smells + auto-`--fix`; run by the pre-commit hook (`--staged`) and manually (`--all`) |
| `scripts/run-examples.ts` | compiles every example entrypoint (hard gate) + runs those annotated `// @run:` — the "always run the app" gate |
| `scripts/agent_review.sh` | cross-model / multi-persona review driver ([docs/agent-review.md](docs/agent-review.md)) |
| `scripts/guard.ts` | mem/timeout watchdog wrapper for running milo binaries safely |
| `scripts/selfhost.sh` | rebuild `milo-self` (required before selfhost work; `.bin` is gitignored) |
| `scripts/selfhost-sweep.ts` | guarded selfhost divergence sweep |
| `scripts/js-sweep.ts` | JS-backend fixture sweep |
| `scripts/build.sh` | build entry |
| `scripts/bundle-stdlib.ts` | bundle stdlib into the compiler |
| `scripts/gen-std-docs.ts` | regenerate stdlib API docs |
| `scripts/gen-json-conformance.ts` | generate JSON conformance fixtures |
| `scripts/migrate-imports.ts` | codemod for import-syntax migration |
| `.githooks/pre-commit` | formats staged `.milo`, then runs `lint.ts --staged --fix` |

Keep this table current — it's how agents discover what already exists before writing a duplicate.
