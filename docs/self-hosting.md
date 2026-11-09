<!-- doc-meta
system: self-hosting
purpose: how Milo becomes self-hosted: a Milo frontend generated from src/*.ts by a thin transpiler, on the shared MLIR backend
key-files: scripts/ts2milo.ts, scripts/ts2milo/subset.ts, scripts/ts-portable.ts, docs/plans/ts2milo.md
update-when: a frontend file becomes generated, the portable subset changes, or the approach is dropped
last-verified: 2026-11-08 (hand-written src-milo/ deleted; generated port is the only self-host path)
-->

# Self-hosting

There is one compiler: `src/` (TypeScript) emitting the milo MLIR dialect, lowered by
`milo-opt` (C++). Self-hosting means generating a Milo copy of the frontend from `src/*.ts`
with a thin transpiler (`scripts/ts2milo.ts`), never maintaining a second hand-written one.
The plan, the portable subset and the stop rule are in [plans/ts2milo.md](plans/ts2milo.md).

- **The Milo is output.** It is rebuilt from the TypeScript and never edited, so there is no
  sync tax. When a construct does not map, the TypeScript changes, not the transpiler.
- **The gate** for each generated file is identical behavior over the corpus (for the whole
  frontend: byte-identical `emit-mlir` text). `bun scripts/ts-portable.ts --check` keeps the
  count of non-portable constructs per file shrinking.
- **The backend stays shared.** `milo-opt` is C++ and stays that way: the result is a Milo
  frontend on the same MLIR backend, not a second codegen.

## History

The hand-written self-hosted compiler (`src-milo/`, ~39K lines, its own LLVM-text codegen)
reached a byte-identical bootstrap fixed point in August 2026 and was frozen on 2026-08-09,
because keeping a hand port in sync with a moving `src/` never ends. It was deleted on
2026-11-08 together with its scripts, CI workflow and ratchets; the last commit that has it
is the parent of the deleting commit (`git log --diff-filter=D -- src-milo/main.milo`).
