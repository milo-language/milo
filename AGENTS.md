<!-- doc-meta
system: agent-router
purpose: single agent entry point: the hard operational rules, then routes to the right skill, doc, script, or convention
key-files: .agents/workflow.md, CONVENTIONS.md, docs/, scripts/, .agents/worksheets/
update-when: an operational rule changes, a new skill/doc/script/convention is added, or a routing entry goes stale
last-verified: 2026-10-07 (operational rules merged in; earlier: milo explain + the generated language reference; earlier: milo fix route, the milojs clone path; earlier: memory-safety row, sweep findings #3-#9 and the fuzzer gates)
-->

# AGENTS.md: Milo Compiler

Memory-safe systems language → LLVM IR. TypeScript compiler, Bun runtime.

**Read this first.** This is the single agent entry point (Claude Code reads it too). [Operational rules](#operational-rules) holds the hard rules (memory guards, build commands, architecture); everything after it is the map, which routes you to the work rather than being the work. **When anything else in this file, or a doc it routes to, conflicts with the operational rules, the operational rules win.**

Every doc in this repo starts with a 7-line `<!-- doc-meta ... -->` block. To find the doc for a system, grep it: `grep -rl "system: <name>" docs AGENTS.md *.md`. Keep meta blocks true — see [docs/doc-standards.md](docs/doc-standards.md).

## Operational rules

These take precedence over the rest of this file.

### Quick Reference

`./milo <args>` is a repo-root wrapper for `bun run src/main.ts <args>` — use either.

```bash
bun run src/main.ts run examples/hello.milo               # compile + run (no artifacts)
bun run src/main.ts build examples/hello.milo -o hello    # compile to binary
bun run src/main.ts emit-ir examples/hello.milo           # emit LLVM IR
bun run src/main.ts emit-ast foo.milo                     # parsed AST as JSON (--all imports; --spans keep spans)
bun run src/main.ts emit-hir foo.milo                     # typed HIR as JSON (--all full module; every expr carries its type)
bun run src/main.ts build foo.milo --release              # -O3 (default -O2; --debug for -O0)
bun run src/main.ts build foo.milo -o foo -g --debug      # DWARF for lldb/hades (-g composes with any -O)
bun test                                                  # full test suite
bun test tests/run.test.ts -t "arithmetic"                # single fixture by name
./benchmarks/run.sh                                       # reproduce perf numbers
bun run src/main.ts api <terms>                           # search std signatures (name + doc, ranked)
bun run src/main.ts api --json                            # every std symbol as JSON (docs/json-api.md)
bun run src/main.ts lang --json                           # keywords/types/operators/builtins/warnings as JSON
bun run src/main.ts explain <warning|@attr|kw>            # one name: doc, example, fix, which flag silences it
bun run src/main.ts check foo.milo --json                 # type-check only; diagnostics as JSON
bun run src/main.ts doc <file|dir> [-o out]               # reference markdown from doc-comments
bun run src/main.ts api --module std/json                 # dump one module's full API
```

**Tooling reads JSON, not `src/`:** anything that needs compiler knowledge (a doc gate, an
editor grammar, a linter, an agent) goes through `milo api --json` / `lang --json` /
`check --json` — see [docs/json-api.md](docs/json-api.md). Importing `src/*.ts` pins the
tool to the host language; the JSON survives a Rust or self-hosted rewrite.

**Finding stdlib APIs:** before writing stdlib-adjacent code, run `milo api <terms>` to find existing signatures — don't roll your own. Grep-backed and auto-discovered: it scans `std/**/*.milo` fresh each call, so new/edited `.milo` files appear with no registration. Lexical only (no generics/re-exports/visibility) — good for discovery, not a spec.

### Tests

`tests/run.test.ts` is a single driver that walks two directories:
- `tests/fixtures/*.milo` — compiled + executed; stdout must match `// @expect: <line>` annotations (one per expected output line).
- `tests/errors/*.milo` — must fail type-check; error output must contain the `// @error: <substring>` annotation.

Add a new test by dropping a `.milo` file with the appropriate annotation in the right directory. No code changes needed.

### Architecture

```
Source → Lexer → Parser → AST → Resolver (imports) → AST (merged) → TypeChecker → HIR Lowering → Codegen → LLVM IR → clang → Binary
```

| File | Purpose |
|------|---------|
| `src/tokens.ts` | Token types and keywords |
| `src/lexer.ts` | Tokenizer |
| `src/parser.ts` | Recursive descent parser → AST |
| `src/ast.ts` | AST node types |
| `src/types.ts` | Internal type representations (`TypeKind` tagged union) |
| `src/resolver.ts` | Import resolution — recursive parse + merge of imported files |
| `src/checker.ts` | Type checking, move checking, scope validation → `CheckResult` |
| `src/hir.ts` | Typed HIR node types (every expr carries `TypeKind`) |
| `src/lower.ts` | AST + CheckResult → HIRModule lowering |
| `src/codegen.ts` | HIR → LLVM IR emission |
| `src/diagnostics.ts` | Elm-style error formatting with source context and carets |
| `src/target.ts` | Host platform detection, target triple resolution |
| `src/lsp.ts` | LSP server (diagnostics, hover, go-to-definition) |
| `src/main.ts` | CLI driver |

The pipeline files above are the map most changes need. [docs/src.md](docs/src.md) indexes
**every** file in `src/` (abi, cgu, pkg, safety, suggest, verify, wcet, …),
generated from each file's own header comment — check there before assuming a subsystem
has no home.

### Language Design

- `let` = immutable (SSA register), `var` = mutable (alloca)
- Move semantics: single owner, use-after-move = compile error
- Second-class references: `&T`/`&mut T` only in function params, never stored/returned
- **Shared borrows are implicit — there is no `&x` expression.** A `&T` param is fed the value *bare* at the call site (`foo(x)`, not `foo(&x)`); the compiler auto-borrows. `&x` as an expression is a hard error (`checker.ts` UnaryOp `&`). A raw pointer comes from `v.ptr()` / `x.addrOf()` (unsafe), never `&`.
- **A `&mut T` argument is spelled `foo(&mut x)`** (non-receiver arguments only; `v.push(1)` stays implicit). The marker is stripped by the checker before the argument is checked (`takeExplicitMutArgs`), so borrow rules and codegen never see it. The bare form is the hard error `implicit-mut-borrow` (no flag silences it); `bun scripts/explicit-mut.ts [--closure] <file>` rewrites a file from the checker's resolved signatures. See `docs/plans/local-reasoning-2026-09.md`.
- User-defined generics: `fn foo<T>`, `struct Pair<A,B>`, `enum Maybe<T>` — monomorphization with type inference
- No GC, no RC, no pointers in safe code
- Arenas for cyclic data via `std/arena` (`Arena<T>` + generational `Handle<T>`)
- Strings: owned UTF-8 byte buffers (like Rust's String)

### Key Rules

- **Self-host never gates a `src/` change.** Blocking work in `src/` on self-host parity is a tar pit and is what got `src-milo/` parked for months. A new language/stdlib feature lands in `src/` + `bun test tests/run.test.ts`; `src-milo/` may lag it, and that is fine.

  Nor a `std/` change (decided 2026-09-20: std uses whatever `src/` supports, e.g. a method's own type parameter, and milo-self lags until someone chooses to catch it up; the sweep is red meanwhile and that is accepted). It DOES gate a `src-milo/` change. `.github/workflows/selfhost.yml` runs the fixpoint, the soundness ratchet and the HIR ratchet on any commit touching `src-milo/` or the selfhost scripts, and sweeps all <!-- stat:fixtures -->794<!-- /stat --> fixtures nightly — scoped by path precisely so a `src/`-only commit never triggers it. So when you change `src-milo/`, run the gates before pushing:
  `sh scripts/selfhost.sh`, `sh scripts/selfhost-fixpoint.sh`, `bun scripts/selfhost-rejects.ts --check`, `bun scripts/selfhost-sweep.ts --check` (the sweep is ~48 min — run it once, at the end). The fixpoint is the real one.

  (The memory-guard rules below still stand — they're OS-safety, not self-host.)

- **Memory guards (macOS enforces no rlimits — a runaway allocation crashes the OS):**
  - `.selfhost/milo-self` is a self-guarding wrapper (RSS/timeout watchdog built in);
    the real binary is `.selfhost/milo-self.bin` — **NEVER run the `.bin` bare**, and
    never build/copy other bare milo-self binaries. Manual guarded runs of anything:
    `bun scripts/guard.ts [--mem-mb N] [--timeout-s N] -- <cmd> <args>`.
  - Guards enforce caps against phys_footprint (not just RSS — the compressor
    hides a runaway's RSS exactly when the machine is dying) and shed guarded
    trees on system memory pressure. Pressure kills are fail-closed by design.
  - `milo run` / `milo test` / `milo fmt` guard their child binaries by default
    (`MILO_RUN_MEM_MB` to raise, `MILO_RUN_UNGUARDED=1` to disable — don't, for
    milo-self or anything it compiled).
  - A guarded child is SIGKILLed, and a SIGKILL cannot flush stdio — so on a piped
    stdout a killed program used to print NOTHING. `guard.ts` now sets
    `MILO_LINE_BUFFERED=1` for its children, which makes the compiled binary
    line-buffer stdout at startup, so you see output up to the hang. Set it yourself
    for any un-guarded run you may kill; `MILO_GUARD_NO_LINE_BUFFER=1` opts back out.
  - `bun test tests/selfhost.test.ts`, `scripts/selfhost.sh`, and
    `scripts/selfhost-sweep.ts` are already guarded — prefer them.
  - Do not raise sweep/test concurrency or per-child mem caps without checking the
    math in `scripts/guard.ts` (N workers × cap must stay under half of RAM).

- Use Bun for everything (not Node)
- Type checker runs before codegen — semantic errors must be caught there, not in codegen
- LLVM IR uses opaque `ptr` (not `i8*`) — LLVM 15+ requirement
- Target triple auto-detected via `src/target.ts` (supports darwin + linux, aarch64 + x86_64)
- Platform-specific stdlib uses suffix split: `std/platform.darwin.milo` vs `std/platform.linux.milo` vs `std/platform.windows.milo` (resolver picks per target OS). There is no `#[cfg]`/`#ifdef` — the filename suffix is the whole mechanism, so every arm must export the *same* surface. A name only some platforms can provide still has to exist on all of them; the Windows arm's convention is to implement what it can and let the rest fail loudly (missing `extern` → link error naming the symbol, or an explicit abort), never to return a plausible-looking value.
- **Windows is a partial target** (core language + std/io yes, IOCP async no — see `docs/roadmap.md`). To build for it from macOS/Linux you need the MSVC CRT + Windows SDK, which `xwin` fetches from Microsoft:
  ```bash
  cargo install xwin && xwin --accept-license --arch x86_64 splat --output ~/.xwin
  MILO_WINDOWS_SDK=~/.xwin PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
    ./milo build examples/hello.milo --target=windows-x64 -o hello   # needs lld-link
  WINEDEBUG=-all wine hello.exe                                       # optional: run it locally
  ```
  Once `~/.xwin` exists, `bun test tests/hostTarget.test.ts` picks it up with no env var
  and — if `wine` is installed — RUNS the cross-built exe rather than only linking it.
  That distinction matters: a `setvbuf` call MSVC rejects at startup linked cleanly and
  killed every Windows binary, and only CI caught it.
  Wine validates the link and the CRT calls but is not the OS — CI's `test-windows` job is the authority on whether generated code actually runs. With `MILO_WINDOWS_SDK` set, `verifyCDecls` DOES run the `@cLayout`/`@cSig` guards on a Windows cross-compile (it compiles the guard TU with `--target=<triple>` against xwin's headers), so a wrong layout is caught on the dev host, not only in CI. Other target≠host crosses still skip (no sysroot to read).

### Layout

- `std/` — Milo-language standard library (`.milo` files: io, fs, net, http, json, argparse, arena, …). Auto-discovered via `from "std/<name>" import { ... }` (optionally `import { x as y }`); there is no glob-import form, and bare `import "std/<name>"` is not accepted.
- `examples/` — runnable Milo programs, grouped by domain (`basics/`, `cli-tools/`, `graphics/`, `simulation/`, `terminal/`, `net/`, `emulators/`, `embedded/`, `runtimes/`, `tools/`); see `examples/README.md`. Treat as integration smoke tests for stdlib changes.
- `docs/language-reference.md`, `docs/grammar.ebnf`, `docs/design.md`, `docs/roadmap.md` — authoritative refs. Check `roadmap.md` before proposing new language features.
- `editors/vscode/` — LSP client, published to the VS Code Marketplace + Open VSX as `milo-language.milo-lang` (CI publishes on a `vscode-v*` tag). It launches the installed `milo` binary's `lsp` subcommand; the `bun run src/main.ts lsp` path is only the fallback for a checkout with no `milo` on PATH. Server entry is `src/lsp.ts`.

## Start every session here

1. **What am I doing?** → open a worksheet: [.agents/worksheets/README.md](.agents/worksheets/README.md). Autonomous/async work: the worksheet is mandatory — another agent must be able to finish from it alone.
2. **How do I work in this repo?** → [.agents/workflow.md](.agents/workflow.md) (the loop: research → plan → implement → run → review → wrap-up).
3. **What are the rules?** → [Operational rules](#operational-rules) below (guards, commands) + [CONVENTIONS.md](CONVENTIONS.md) (code style reviewers enforce).

## Route by intent

| I want to… | Go to |
|---|---|
| Understand the workflow / how to approach a task | [.agents/workflow.md](.agents/workflow.md) |
| Know the coding conventions reviewers check | [CONVENTIONS.md](CONVENTIONS.md) |
| Write idiomatic Milo (text handling, ownership, control flow) | [docs/milo-idioms.md](docs/milo-idioms.md) |
| Do a lifetime-shaped thing (linked list, graph, tree, recursive type, zero-copy) | [docs/ownership-model.md](docs/ownership-model.md) §Rust→Milo — slices, `Heap<T>`, `std/arena` all exist; check here before assuming a gap |
| Know what memory-safety Milo catches (compile vs runtime) vs Rust, or what it deliberately does not check | [docs/memory-safety-vs-rust.md](docs/memory-safety-vs-rust.md): battle-test matrix, 13 probes; finding #2 (move-out-of-borrow UAF) closed 2026-07-31, findings #3-#9 (the September soundness sweep: shard copy, owner-under-worker, global across a park, `ptr()` past a realloc, Drop copy-out, channel leak, impl-vs-trait signature) closed 2026-09-19/20. The sweep is fuzzer-gated now (`fuzz:tasks`, `fuzz:generic-drop` and the ASan sweep run in CI), scoped, not a no-UB proof; its last section is the three gaps Rust's stored references cover and Milo does not |
| Write or run tests, or find what's covered | [docs/testing.md](docs/testing.md) |
| Changing `src/verify.ts` or `src/prove-milo.ts` | ALWAYS run `bun test tests/verify-contracts.test.ts` before merging, whatever else is skipped: it is the only gate that notices a lost proof (WP6 lost four in `std/inflate.milo` and three merges went by) |
| Find out what a warning means, or which flag silences it | `milo explain <warning \| @attribute \| keyword>` — doc, example, fix and flags, the same text the site and the LSP show. Warnings print their name (`warning[index-clone]: …`) |
| A program fails with a mechanical diagnostic (`'x' is not imported`, a missing `&mut`, an unused `unsafe`, a bare `embedFile`) | `milo fix <entry.milo>` applies every fix `check --json` reports, in the imported modules too |
| Changing `src/checker.ts` rules | ALWAYS run `bun run scripts/run-examples.ts` before merging: a false positive on a real program is a rule not finished |
| Measure what the ownership model costs real programs (non-FFI `unsafe`, clones, friction comments) | `bun scripts/corpus-census.ts` over every `.milo` in the org; `--check` is the shrink-only gate on non-FFI `unsafe`, `--comments` lists each block's reason. Findings in [docs/memory-safety-vs-rust.md](docs/memory-safety-vs-rust.md) §What the corpus says |
| Hunt for compiler crashes / hangs on hostile input | `bun scripts/fuzz-frontend.ts` — token-mutation fuzzer over the fixture corpus, ddmin-reduced findings; `bun scripts/prove-soundness-fuzz.ts` for false proofs out of `milo prove`; `bun run fuzz:tasks` for unsafe-free programs the checker accepts that ASan then rejects (globals across parks, Shards windows past their owner, `ptr()` past a realloc) |
| Reproduce a run exactly (record clock, entropy, env, argv, file/socket/subprocess IO and green-task order; replay them), stop a replay at a record, or add a std call that reads the OS | [docs/record-replay.md](docs/record-replay.md): `MILO_RECORD`/`MILO_REPLAY` or `milo run --record/--replay`, `MILO_REPLAY_STOP`, `milo trace`; a new OS call in std goes through `std/replay` (descriptor IO through the `sys*` calls in std/os) |
| Run the compiler / prove a change works | [.agents/workflow.md](.agents/workflow.md) §Run, `bun run scripts/run-examples.ts`, `/verify`, `/run` |
| Get my work reviewed by a different model | [.agents/review.md](.agents/review.md) → `scripts/agent_review.sh` |
| Add a helper script / bin tool | [docs/scripts.md](docs/scripts.md) |
| Write or update a system doc | [docs/doc-standards.md](docs/doc-standards.md) |
| Track / hand off in-progress work | [.agents/worksheets/README.md](.agents/worksheets/README.md) |
| Sweep recent commits for regressions | skill `/commit-sweep` |
| Debug an emulator bug (black screen, garbled gfx, freeze) | skill `/emu-debug` |
| Write or talk about Milo externally (blog, talk, README pitch) | [docs/design-insights.md](docs/design-insights.md) (the arguments, each with its falsifier) |
| Understand the compiler internals | [§Architecture](#architecture) below, [docs/design.md](docs/design.md) |
| The language spec / grammar | [docs/language-reference.md](docs/language-reference.md) (prose), [docs/spec.md](docs/spec.md) (normative requirements, generated), [docs/grammar.ebnf](docs/grammar.ebnf) (syntax) |
| Look up a compile error, or see what a rule rejects | [docs/site/language/errors.md](docs/site/language/errors.md) — every pinned message with the program that provokes it (generated from `tests/errors/`) |
| What's planned / allowed to build | [docs/roadmap.md](docs/roadmap.md) — check before proposing features |
| Move or rename a public stdlib name | record it in [docs/breaking-changes.md](docs/breaking-changes.md) — the flat namespace makes compat shims impossible, so the doc is the only migration path users get |
| Find an stdlib API | `bun run src/main.ts api <terms>` (see [Quick Reference](#quick-reference)) |
| Design or review a public stdlib API | [docs/stdlib-design.md](docs/stdlib-design.md) |

## Org layout (`milo-language`)

This repo is one of five in the `milo-language` GitHub org. They are **independent repos, not
submodules** — there is no `.gitmodules` and nothing here builds from their source. Don't add
submodules for them; they are separate products that happen to be written in Milo.

| Repo | Contents | Local clone |
|---|---|---|
| `milo` | Compiler, stdlib, docs, examples (this repo) | `~/git/milo` |
| `milojs` | JS engine + runtime written in Milo | `~/git/milojs` (`~/git/milo-language/milojs` is a stale second clone) |
| `emulators` | NES/SNES/Genesis cores + console front-end | `~/git/milo-language/emulators` |
| `dapweb` | DAP debugger + web UI (formerly named `hades`) | `~/git/milo-language/dapweb` |
| `.github` | Org profile README = the org homepage | `~/git/milo-language/.github` |

Push to main is allowed org-wide. Note `milo` itself sits at `~/git/milo`, *outside*
`~/git/milo-language/` — it predates the layout and has live worktrees under
`.claude/worktrees/`, so moving it would break them.

**After a compiler or std change, run the packages' own suites** —
`sh scripts/check-packages.sh` (one arg runs a single package). It runs the sibling Milo
packages' test suites — yaml, toml, markdown, aws, milo-json-rpc and friends — against
this checkout. Those were written by people solving a different problem and reach std
through APIs no fixture here calls: 72 tests that this repo's own suite says nothing
about. Missing checkouts skip, so it is safe to run anywhere; suites needing a live
service (postgres, redis, aws/s3) skip by name rather than by guessing from the error.

**After a compiler change to codegen, closures, the scheduler or `std/runtime`, run
milojs's app check** — `tools/check-apps.sh` in `~/git/milojs` (one arg
runs a single app). It boots real applications (an express + Prisma + tRPC server, and an
express + ws chat) under node and under milojs and diffs the served bytes. Three defects
have reached it that BOTH repos' fixture suites missed, which is the point: this repo's
874 fixtures exercise a few dozen concurrency shapes, and a closure or scheduler change
touches every capturing closure in every program. A missing app checkout skips rather
than fails, so it is safe to run anywhere.

Three traps in the paths above:

- The emulators and the debugger were deleted from `examples/` once they got their own repos —
  `examples/emulators` and `examples/tools/hades` are gone from `main`, so work on them in the
  clones above. Untracked leftovers (ROMs, `node_modules`, built binaries) may still sit at the
  old paths on this machine; they are not the source.
- `~/git/milo-blackhat` is a second clone of `milo-language/milo`, not a separate project.
- `~/git/hades` is a local-only leftover from before the `hades` → `dapweb` rename. It has
  **no git remote** and carries commits whose subjects appear nowhere in `dapweb`. It is not
  a clone of `dapweb`, and `dapweb` has since been reworked past it (mcp → api). Don't treat
  the two as interchangeable.

### Marketing copy lives in five places

The tagline is **"A memory-safe systems language with second-class references: no
lifetimes, no GC, one owner per value."** Changing it means changing all four places that carry it. Note the last entry is
GitHub metadata, not a file, so grep will never find it:

1. `README.md` (this repo)
2. `docs/site/index.md` — hero `text:`, plus the intro paragraph. The hero `tagline:` field
   below it carries the verification pitch, not the tagline.
3. `docs/site/.vitepress/config.mts` — `description:` (drives SEO + social cards)
4. `profile/README.md` in the `.github` repo (org homepage) — deliberately minimal: tagline
   plus a docs link, nothing else. GitHub already lists the org's repos below it, so a repo
   table there is redundant.
5. **Repo description metadata is deliberately NOT the tagline.** It is the bare
   `The Milo Programming Language` (Odin's convention — bare repo description, pitch lives on
   the site). Don't "fix" it to match the tagline.
   Set via `gh repo edit milo-language/milo --description "..."`.

## Skills (`.claude/skills/`)

| Skill | Use when |
|---|---|
| `/workflow` | starting a task and you want the standard loop pulled in |
| `/commit-sweep` | periodically auditing recent commits for gotchas/regressions |
| `/emu-debug` | diagnosing NES/SNES/Genesis emulator bugs — headless harnesses, triage ladder, oracles |

Built-in skills worth knowing: `/verify` (drive a change end-to-end), `/run` (launch the app), `/code-review` (diff review).

## Persona → doc ownership

Review personas own the docs for their domain and keep them current (see [.agents/review.md](.agents/review.md)):

- **correctness / compiler** → `docs/design.md`, `docs/language-reference.md`, `AGENTS.md` §Operational rules
- **testing** → `docs/testing.md`
- **performance** → `benchmarks/`, perf notes in `docs/design.md`
- **safety / memory** → `docs/safety-roadmap.md`, guard rules in `AGENTS.md` §Operational rules
- **maintainability / DX** → `CONVENTIONS.md`, `docs/scripts.md`

## Self-healing rule

If you touch a system and its doc is wrong or missing, **fix the doc in the same change**. A stale doc is a bug. Update the `last-verified` line when you confirm a doc still matches reality.

## Generate it, don't restate it

**A fact stated in prose is a fact that will be wrong.** Every count, list, signature,
table and index in this repo that describes the code must either be *generated from the
code* or *gated by a test that compares it to the code*. Hand-synced copies always drift,
and they drift silently — the docs site shipped a syntax grammar that highlighted three
keywords Milo does not have, the argparse page documented a free-function API that never
existed, and the front-page benchmark table disagreed with the hyperfine output sitting
next to it in the same directory.

Before you add a claim about the code to any doc, ask which of these it is:

| Claim | Mechanism | Example |
|---|---|---|
| a count | `<!-- stat:<name> -->N<!-- /stat -->` marker | `scripts/gen-stats.ts`, gated by `tests/docStats.test.ts` |
| a list of files | project it from the files' own headers | `scripts/gen-src-doc.ts`, `scripts/gen-scripts-doc.ts` |
| an API signature | generate it from the doc-comments into the page's `generated:api` region | `scripts/gen-std-docs.ts`, gated by `tests/stdDocs.test.ts` |
| a measured number | one source file, rendered into every place it appears | `benchmarks/results.json` → `scripts/gen-benchmarks.ts` |
| a code snippet | make it compile in the doc-test harness | `tests/docs.test.ts` (```` ```milo ```` fences) |
| a keyword/token list | derive it from `src/tokens.ts` | `scripts/gen-tmlanguage.ts`, `tests/grammar.test.ts` |
| a published reference for a warning, attribute or keyword | write it on the compiler's own row and render every surface from there | `src/warnings.ts` + `src/attributes.ts` + `src/keyword-docs.ts` → `scripts/gen-lang-docs.ts`, gated by `tests/langDocs.test.ts` |
| a link to a file | `tests/docLinks.test.ts` checks it resolves | — |

If none fits, write the gate before you write the claim. Two rules that follow from this:

- **One copy.** If a value has to appear twice, the second copy is generated from the
  first. Never two hand-edited copies of the same table (that is how the docs site ran on
  a stale grammar for months).
- **A generator's CLI half must be behind `if (import.meta.main)`** — a test that imports
  it and thereby rewrites the file it is checking proves nothing.

And the corollary for *tools*: read the compiler through its machine-readable surfaces
(`milo api --json`, `milo lang --json`, `milo check --json`, `emit-ast`, `emit-hir`), not
by importing `src/*.ts`. An importer can only ever be a file inside this repo written in
this repo's current host language — which is TypeScript today and is planned to be Rust or
Milo. See [docs/json-api.md](docs/json-api.md) for the payloads and the rules that keep
them honest.
