<!-- doc-meta
system: dev-scripts
purpose: index of agent-facing scripts and how to write new ones well; agents should keep building these out
key-files: scripts/, bin/, .githooks/, scripts/lint.ts, scripts/agent_review.sh
update-when: a script is added/removed/changed, or the scripting conventions change
last-verified: 2026-08-15
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

Generated from each script's own first comment line by `scripts/gen-scripts-doc.ts`.
To change an entry, change that line — this table is a projection of it.

<!-- BEGIN GENERATED INDEX -->
| Script | Purpose |
|---|---|
| `scripts/abstraction-scan.ts` | Abstraction scanner: finds indirection that is not paying for itself — helpers with exactly one caller, and forwarders whose whole body is a call to something else. |
| `scripts/agent_review.sh` | Cross-model / multi-persona code review driver. |
| `scripts/asan-sweep.ts` | Is the code the MAIN compiler generates memory-safe? |
| `scripts/audit-extern-returns.ts` | Audit every `extern fn` in std/ against the real C headers — no annotations needed. |
| `scripts/build.sh` | Build a standalone, self-contained milo binary. |
| `scripts/bundle-stdlib.ts` | Generates src/stdlib-bundle.ts, embedding every std/*.milo file as a string. |
| `scripts/check-api-docs.ts` | Checks the signature listings on the docs-site stdlib pages against the real std API. |
| `scripts/check-breaking.ts` | Detects source-level breaks in the public std surface since the last release tag, and requires each one to be written up in docs/breaking-changes.md. |
| `scripts/check-packages.sh` | Run the sibling Milo packages' OWN test suites against this checkout's compiler. |
| `scripts/count-implicit-mut.ts` | Counts every bare non-receiver argument bound to a `&mut` parameter across the corpus: std, examples, src-milo, tests/fixtures, and the sibling repos under ~/git/milo-language. |
| `scripts/dup-scan.ts` | Duplicate-code scanner: finds maximal runs of identical normalized lines shared by two or more places, within or across files. |
| `scripts/ecosystem-check.ts` | Compile every published milo-language package against THIS checkout. |
| `scripts/explicit-mut.ts` | Rewrites `f(x)` to `f(&mut x)` wherever `x` is bound to a `&mut` parameter. |
| `scripts/fetch-assets.sh` | Regenerates the game assets that are deliberately NOT in git: the FLYBY city files (82 MB of terrain, footprints and aerial drape) and the APSIS planet maps. |
| `scripts/fuzz-arena.ts` | Differential falsifier for the GENERATIONAL ARENA — std/arena's Handle<T>. |
| `scripts/fuzz-check.ts` | The frontend contract the fuzzer tests, in one place so the Worker and the main-thread confirmation stage run byte-identical logic. |
| `scripts/fuzz-confirm.ts` | Re-runs one fuzz case on a fresh process's MAIN thread and reports the verdict as JSON on stdout. |
| `scripts/fuzz-coverage.ts` | Which surface forms can the ownership fuzzer actually emit? |
| `scripts/fuzz-drops.ts` | Destructor accounting as a falsifiable invariant: every value constructed must be destroyed exactly once. |
| `scripts/fuzz-frontend.ts` | Token-mutation fuzzer for the Milo frontend (lexer → parser → [resolver] → checker). |
| `scripts/fuzz-generic-drop.ts` | Is every generic std body sound for a `T` that owns heap? |
| `scripts/fuzz-hashmap.ts` | Differential falsifier for the built-in HASHMAP — the open-addressing table codegen.ts emits, not a .milo file. |
| `scripts/fuzz-int.ts` | Differential falsifier for INTEGER arithmetic across every width. |
| `scripts/fuzz-ownership.ts` | Differential falsifier for the OWNERSHIP checker. |
| `scripts/fuzz-scan.ts` | Raw lexical splitter used by the frontend fuzzer for mutation and reduction. |
| `scripts/fuzz-string.ts` | Differential falsifier for the built-in STRING methods codegen.ts emits. |
| `scripts/fuzz-tasks.ts` | Differential falsifier for SHARED STATE ACROSS TASKS: hunts for programs with zero `unsafe` that the checker accepts and AddressSanitizer then rejects. |
| `scripts/fuzz-vec.ts` | Differential falsifier for the built-in VEC — the growable array codegen.ts emits. |
| `scripts/fuzz-worker.ts` | Case runner for scripts/fuzz-frontend.ts. |
| `scripts/gen-benchmarks.ts` | Renders the benchmark table in benchmarks/README.md and the docs-site chart data from benchmarks/results.json, the one place the numbers live. |
| `scripts/gen-error-catalog.ts` | Generates docs/errors.md — every compile error the test suite pins, with the program that provokes it. |
| `scripts/gen-json-conformance.ts` | Generates a JSON conformance fixture from the canonical json.org JSON_checker suite (fail1..33, pass1..3) as vendored by CPython's test_json. |
| `scripts/gen-scripts-doc.ts` | Regenerates the Index table in docs/scripts.md from each script's own first comment line, so the index cannot fall behind the directory. |
| `scripts/gen-spec.ts` | Generates docs/spec.md — the normative language specification, from the suites that already decide what the compiler does. |
| `scripts/gen-src-doc.ts` | Regenerates the compiler-source index in docs/src.md from each src/*.ts file's own first comment line, so the map of the compiler cannot fall behind the directory. |
| `scripts/gen-stats.ts` | Fills in the corpus counts quoted in prose, so a doc cannot claim a number the repo stopped matching. |
| `scripts/gen-std-docs.ts` | Regenerate docs/std/<module>.md from the std doc-comments (source of truth). |
| `scripts/gen-tmlanguage.ts` | Regenerates editors/vscode/syntaxes/milo.tmLanguage.json from the compiler's own keyword and primitive-type lists. |
| `scripts/gen-vscode-icon.ts` | Renders the mascot to editors/vscode/icon.png. |
| `scripts/guard.ts` | Guarded child execution: hard memory + wall-clock + CPU caps for every process the test harnesses spawn. |
| `scripts/hir-cover.ts` | Which fixtures exercise which HIR expression kinds? |
| `scripts/hir-ratchet.ts` | How much of src-milo's backend still re-derives what the frontend already knew? |
| `scripts/ir-diff.ts` | Byte-exact IR differential: emit LLVM IR for every fixture with BOTH compilers and compare the bytes. |
| `scripts/js-sweep.ts` | codegen-js coverage sweep: how many fixtures run byte-identical under `emit-js`. |
| `scripts/leak-check.ts` | Leak gate: compile every stdout-comparable fixture, run it, and fail if the process exits still holding heap it allocated. |
| `scripts/lint.ts` | Repo linter: deterministic smell checks with auto-fix. |
| `scripts/lsp-probe.ts` | Differential + crash-safety probe for the Milo language server. |
| `scripts/mascot.ts` | The Milo mascot as a char grid — the single source for every rendering of it (docs/site/scripts/gen-logo.ts → logo.svg, scripts/gen-vscode-icon.ts → the extension's icon.png). |
| `scripts/migrate-imports.ts` | Migration script: convert `from "X" import *` to explicit imports Usage: bun run scripts/migrate-imports.ts |
| `scripts/napi-probe.ts` | Generate a Milo host that can load a Node-API (.node) addon, and trace which napi_* entry points the addon actually calls. |
| `scripts/prove-soundness-fuzz.ts` | Differential falsifier for `milo prove`. |
| `scripts/release-meta.ts` | Shared facts about a release: the target list and how a git tag maps to a version string. |
| `scripts/render-formula.ts` | Renders the Homebrew formula for a release and prints it to stdout. |
| `scripts/rgbench.sh` | rgbench — compare our rg against real ripgrep, honestly. |
| `scripts/rgdiff.sh` | Differential test: our Milo port of ripgrep (examples/cli-tools/rg.milo) vs real `rg`. |
| `scripts/run-examples.ts` | Compiles every example entrypoint and runs the ones marked runnable. |
| `scripts/selfhost-asan.ts` | Is the code milo-self GENERATES memory-safe? |
| `scripts/selfhost-examples.ts` | Compile every examples/ entrypoint with milo-self (the Milo compiler written in Milo) and bucket the failures — the examples-side counterpart to scripts/selfhost-sweep.ts. |
| `scripts/selfhost-fixpoint.sh` | Verify the self-hosting FIXED POINT: milo0 compiled by the oracle and milo0 compiled by itself must emit byte-identical IR. |
| `scripts/selfhost-irsize.ts` | How much IR does milo-self emit for its own source, and is that number drifting? |
| `scripts/selfhost-rejects.ts` | Does milo-self REJECT the programs it is supposed to reject? |
| `scripts/selfhost-selfcheck.sh` | Can milo-self still type-check src-milo? |
| `scripts/selfhost-stamp.ts` | Provenance for .selfhost/milo-self.bin: which source built it. |
| `scripts/selfhost-sweep.ts` | Differential sweep: run every tests/fixtures/*.milo through milo-self and bucket the failures. |
| `scripts/selfhost.sh` | Build milo-self (the Milo compiler written in Milo) with the TS compiler. |
| `scripts/stamp-version.ts` | Stamps the current commit into src/version.ts so a released binary can report which commit built it. |
| `scripts/verify-contracts.baseline.ts` | Accepted (baselined) contract refutations. |
| `scripts/verify-contracts.expected.ts` | Per-file prove-verdict ratchet. |
| `scripts/verify-contracts.ts` | Static contract gate: run `milo prove` over every contract-bearing .milo in std/ and examples/ and FAIL if any contract is *refuted* (the solver found a counterexample proving it false). |
| `scripts/windows-sweep.ts` | Cross-compiles every tests/fixtures/*.milo to windows-x64 and runs the PE under Wine, comparing stdout to the fixture's `// @expect:` lines. |
| `.githooks/pre-commit` | Format staged .milo files with bin/milo-fmt (built on demand by `milo fmt`). |
<!-- END GENERATED INDEX -->

This table is regenerated, not maintained — it is how agents discover what already exists before writing a duplicate.
