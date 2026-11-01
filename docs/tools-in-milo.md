<!-- doc-meta
system: tools-in-milo-plan
purpose: plan for rewriting the standalone CLI tools (package manager first) in Milo instead of TypeScript
key-files: src/pkg.ts, src/pkgcli.ts, src/api-search.ts, src/skill.ts, src/hot.ts, src/headergen.ts, src/fmtbin.ts, examples/cli-tools/fmt.milo
update-when: a tool moves, the driver/bootstrap scheme changes, or a gate changes
last-verified: 2026-11-01 (plan written; nothing moved)
-->

# Standalone tools in Milo

Decided 2026-11-01: anything that is a standalone CLI tool, rather than part of the
compiler proper, is written in Milo. The compiler (parser, checker, dialect emitter) stays
in TypeScript until self-hosting; the tools do not have to wait for that. Each one is a real
Milo program that exercises std (fs, process, crypto, http, json) and a public proof that
the language builds the tools it ships with. The formatter already is one
(`examples/cli-tools/fmt.milo`).

## Order

| Tool | TypeScript today | Notes |
|---|---|---|
| package manager | `src/pkg.ts`, `src/pkgcli.ts` (~2k lines) | first: largest, fully standalone, uses fs, hashing, subprocesses |
| API search (`milo api`) | `src/api-search.ts` (472) | reads std/**/*.milo; pure text work |
| skill installer (`milo skill`) | `src/skill.ts` (509) | |
| header generator (`build-lib`) | `src/headergen.ts` (169) | reads the checker's output: needs `check --json`/`api --json`, not `src/` |
| formatter driver | `src/fmtbin.ts` (157) | thin wrapper over fmt.milo |
| hot reload | `src/hot.ts` (680) | last: tied to the build pipeline |

A tool that needs compiler knowledge reads it through the JSON surfaces (`milo api --json`,
`lang --json`, `check --json`), never by importing `src/`, as AGENTS.md already requires.

## Driver and bootstrap

`milo <tool> ...` keeps its spelling. The driver execs a Milo-built binary (`milo-pkg`, ...)
that install builds once with the TypeScript compiler and caches next to it; a missing or
stale binary is rebuilt, never silently replaced by the old TypeScript path. The TypeScript
implementation is deleted in the same commit that switches the driver over.

## Gates

- **Differential**: the Milo tool and the TypeScript tool produce identical stdout, stderr,
  exit codes and file-system effects over a scripted scenario set (for pkg: init, add,
  install from a local registry fixture, lockfile round trip, offline cache hit, a corrupt
  archive, a hash mismatch). The scenario set lands first, run against the TypeScript tool.
- **Planted bug** in the Milo tool turns a scenario red.
- **The package suites** (`sh scripts/check-packages.sh`) pass with the Milo package manager.
