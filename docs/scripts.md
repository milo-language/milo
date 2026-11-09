<!-- doc-meta
system: dev-scripts
purpose: index of dev scripts and how to write new ones well
key-files: scripts/, bin/, .githooks/, scripts/lint.ts
update-when: a script is added/removed/changed, or the scripting conventions change
last-verified: 2026-11-02
-->

# Dev Scripts & Tools

`scripts/` holds the tools that make repo work faster: things you'd otherwise re-derive the incantation for every time. **Build these out constantly** — the moment you find yourself running the same 3-command dance twice, or memorizing a tool's flags, write a script and add it here. A good script turns tribal knowledge into a one-liner.

## When to write one
- A multi-step operation you've now done twice (bundle, sweep, regenerate).
- A tool with an obscure/verbose invocation you keep looking up.
- Anything a reviewer or CI needs to run consistently.
- Wrapping *other* tools so callers don't need to know their particular flags.

## How to write one well
- **Self-documenting.** `--help` prints usage; the file's top comment says what/why. First line is a one-sentence purpose.
- **Bun for TS, POSIX `sh` for glue.** TS scripts: `bun run scripts/foo.ts`. Match the existing style in this dir.
- **Safe by default.** Anything that runs a compiled milo binary must go through `scripts/guard.ts` (mem/timeout watchdog) — never invoke a milo-self binary bare (AGENTS.md). Read-only by default; mutation behind an explicit flag.
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
| `scripts/api-sweep.ts` | API sweep before deploy: build a web app with an old and a new compiler, run both on copies of the same data, request every GET route and byte-diff status + body. |
| `scripts/asan-sweep.ts` | Is the code the MAIN compiler generates memory-safe? |
| `scripts/audit-extern-returns.ts` | Audit every `extern fn` in std/ against the real C headers — no annotations needed. |
| `scripts/build-playground.ts` | Builds docs/site/public/playground/milo-playground.js: the frontend plus the reference interpreter for the browser, with std/*.milo embedded. |
| `scripts/build.sh` | Build a standalone, self-contained milo binary. |
| `scripts/bundle-stdlib.ts` | Generates src/stdlib-bundle.ts, embedding every std/*.milo file as a string. |
| `scripts/check-breaking.ts` | Detects source-level breaks in the public std surface since the last release tag, and requires each one to be written up in docs/breaking-changes.md. |
| `scripts/check-packages.sh` | Run the sibling Milo packages' OWN test suites against this checkout's compiler. |
| `scripts/corpus-census.ts` | Census of every .milo file in the org: what the ownership model costs real programs. |
| `scripts/dialect-hygiene.ts` | Hygiene gate for the milo MLIR dialect (mlir/Milo.td): docs on every op, type and attribute, and no hygiene count below its baseline. |
| `scripts/differential.ts` | Differential gate: builds every runtime fixture and `// @run:` example twice (A and B flags or checkouts) and compares stdout and exit code; any difference is a finding. |
| `scripts/dup-scan.ts` | Duplicate-code scanner: finds maximal runs of identical normalized lines shared by two or more places, within or across files. |
| `scripts/ecosystem-check.ts` | Compile every published milo-language package against THIS checkout. |
| `scripts/edit-loop.ts` | Edit-loop benchmark: build time for cold, unchanged-rebuild, one-line-edit and repeat-edit scenarios over a fixed set of real programs, with the MILO_TIMING phase breakdown per build. |
| `scripts/explicit-mut.ts` | Rewrites `f(x)` to `f(&mut x)` wherever `x` is bound to a `&mut` parameter. |
| `scripts/fetch-assets.sh` | Regenerates the game assets that are deliberately NOT in git: the FLYBY city files (82 MB of terrain, footprints and aerial drape) and the APSIS planet maps. |
| `scripts/file-size-ratchet.ts` | File-size ratchet for src/*.ts: no file may grow past its recorded line count. |
| `scripts/fuzz-arena.ts` | Differential falsifier for the GENERATIONAL ARENA — std/arena's Handle<T>. |
| `scripts/fuzz-check.ts` | The frontend contract the fuzzer tests, in one place so the Worker and the main-thread confirmation stage run byte-identical logic. |
| `scripts/fuzz-confirm.ts` | Re-runs one fuzz case on a fresh process's MAIN thread and reports the verdict as JSON on stdout. |
| `scripts/fuzz-coverage.ts` | Which surface forms can the ownership fuzzer actually emit? |
| `scripts/fuzz-drops.ts` | Destructor accounting as a falsifiable invariant: every value constructed must be destroyed exactly once, on every path, through generated compositions of ownership forms. |
| `scripts/fuzz-frontend.ts` | Token-mutation fuzzer for the Milo frontend (lexer → parser → [resolver] → checker). |
| `scripts/fuzz-generic-drop.ts` | Is every generic std body sound for a `T` that owns heap? |
| `scripts/fuzz-hashmap.ts` | Differential falsifier for the built-in HASHMAP — the open-addressing table codegen-map.ts emits, not a .milo file. |
| `scripts/fuzz-int.ts` | Differential falsifier for INTEGER arithmetic across every width. |
| `scripts/fuzz-jpeg.ts` | Crash fuzzer for std/jpeg's decoder: mutated and truncated JPEGs must come back as Ok or Err, never a trap, a hang or a runaway allocation. |
| `scripts/fuzz-ownership.ts` | Differential falsifier for the OWNERSHIP checker. |
| `scripts/fuzz-scan.ts` | Raw lexical splitter used by the frontend fuzzer for mutation and reduction. |
| `scripts/fuzz-shared-string.ts` | Differential falsifier for shared (reference-counted, copy-on-write) strings. |
| `scripts/fuzz-string.ts` | Differential falsifier for the built-in STRING methods codegen.ts emits. |
| `scripts/fuzz-tasks.ts` | Differential falsifier for SHARED STATE ACROSS TASKS: hunts for programs with zero `unsafe` that the checker accepts and AddressSanitizer then rejects. |
| `scripts/fuzz-vec.ts` | Differential falsifier for the built-in VEC — the growable array codegen.ts emits. |
| `scripts/fuzz-worker.ts` | Case runner for scripts/fuzz-frontend.ts. |
| `scripts/gen-ast-walk.ts` | Generates the explicit AST traversal from the types in src/ast.ts, so a hand-written walk over about 60 node kinds cannot drift from the tree. |
| `scripts/gen-benchmarks.ts` | Renders the benchmark table in benchmarks/README.md and the docs-site chart data from benchmarks/results.json, the one place the numbers live. |
| `scripts/gen-case-map.ts` | Regenerates the simple case mapping tables at the bottom of std/unicode.milo from the Unicode Character Database. |
| `scripts/gen-error-catalog.ts` | Generates docs/site/language/errors.md, every compile error the test suite pins, with the program that provokes it. |
| `scripts/gen-html-entities.ts` | Regenerates the named character reference table at the bottom of std/html.milo from the WHATWG HTML entity list. |
| `scripts/gen-interp-co.ts` | Generates src/interp-gen.ts: a generator twin (`name$g`) of every interpreter function that can reach a task switch. |
| `scripts/gen-json-conformance.ts` | Generates a JSON conformance fixture from the canonical json.org JSON_checker suite (fail1..33, pass1..3) as vendored by CPython's test_json. |
| `scripts/gen-lang-docs.ts` | Renders the published language reference from `milo lang --json`. |
| `scripts/gen-language-requirements.ts` | Generates docs/semantics/requirements.json: Milo's language requirements, one per semantics rule in docs/semantics/milo.md (grouped under its section) plus the MILO-O ownership rules in docs/spec.md. |
| `scripts/gen-programs-grammar.ts` | Random Milo program generator for scripts/gen-programs.ts, deterministic from a seed. |
| `scripts/gen-programs.ts` | Differential fuzzer over random well-typed Milo programs (scripts/gen-programs-grammar.ts). |
| `scripts/gen-scripts-doc.ts` | Regenerates the Index table in docs/scripts.md from each script's own first comment line, so the index cannot fall behind the directory. |
| `scripts/gen-spec.ts` | Generates docs/spec.md — the normative language specification, from the suites that already decide what the compiler does. |
| `scripts/gen-src-doc.ts` | Regenerates the compiler-source index in docs/src.md from each src/*.ts file's own first comment line, so the map of the compiler cannot fall behind the directory. |
| `scripts/gen-stats.ts` | Fills in the corpus counts quoted in prose, so a doc cannot claim a number the repo stopped matching. |
| `scripts/gen-std-docs.ts` | Renders the API reference on every docs-site stdlib page from `milo api --json`. |
| `scripts/gen-tmlanguage.ts` | Regenerates editors/vscode/syntaxes/milo.tmLanguage.json from the compiler's own keyword and primitive-type lists. |
| `scripts/gen-vscode-icon.ts` | Renders the mascot to editors/vscode/icon.png. |
| `scripts/guard.ts` | Guarded child execution: hard memory + wall-clock + CPU caps for every process the test harnesses spawn. |
| `scripts/interp-coverage.ts` | What the reference interpreter (src/interp.ts, `milo interp`) can run, and whether what it prints is what the fixture's author wrote down. |
| `scripts/ir-same.ts` | Byte-identical IR gate: proves a codegen refactor changed no emitted LLVM IR, by emitting IR for every fixture and example in both a base commit and the working tree and comparing the bytes. |
| `scripts/jpeg-grade.ts` | Grades std/jpeg against libjpeg-turbo: decoder pixels vs djpeg, encoder bytes vs cjpeg, and decode/encode speed. |
| `scripts/leak-check.ts` | Leak gate: compile every stdout-comparable fixture, run it, and fail if the process exits still holding heap it allocated. |
| `scripts/lint.ts` | Repo linter: deterministic smell checks with auto-fix. |
| `scripts/lsp-probe.ts` | Crash-safety probe for the Milo language server (src/lsp.ts). |
| `scripts/mascot.ts` | The Milo mascot as a char grid — the single source for every rendering of it (docs/site/scripts/gen-logo.ts → logo.svg, scripts/gen-vscode-icon.ts → the extension's icon.png). |
| `scripts/mlir-census.ts` | Compile-only MLIR coverage census: emit-ir with MILO_MLIR_LOG over every fixture and example with a main plus milojs's two entry points, then the function-instance coverage and the top legacy reasons. |
| `scripts/mlir-cross.ts` | Cross-target gate for the MLIR backend: each program's LLVM IR for a non-host target must be for that target. |
| `scripts/mlir-same.ts` | Conformance gate for the MLIR backend: every fixture's stdout, exit code and live heap blocks must equal what the reference interpreter (`milo interp`, docs/semantics/milo.md) computes for it. |
| `scripts/mutability-census.ts` | Corpus census for the mutability hard errors (`var-never-reassigned`, `unwritten-mut-param`): hits per rule. |
| `scripts/napi-probe.ts` | Generate a Milo host that can load a Node-API (.node) addon, and trace which napi_* entry points the addon actually calls. |
| `scripts/ownership-rules.ts` | The ownership rules of Milo: when a value is moved, cloned, lent or dropped, and in what order. |
| `scripts/plant.ts` | Planted-bug check: does a gate fail when the code it guards is broken? |
| `scripts/prove-soundness-fuzz.ts` | Differential falsifier for `milo prove`. |
| `scripts/release-meta.ts` | Shared facts about a release: the target list and how a git tag maps to a version string. |
| `scripts/render-formula.ts` | Renders the Homebrew formula for a release and prints it to stdout. |
| `scripts/rgbench.sh` | rgbench — compare our rg against real ripgrep, honestly. |
| `scripts/rgdiff.sh` | Differential test: our Milo port of ripgrep (examples/cli-tools/rg.milo) vs real `rg`. |
| `scripts/rte-census.ts` | Silver-progress number: `milo prove --rte` over examples/embedded and std, tallied per runtime-error site and kind (overflow / bounds / division) as proven / failed / unknown(+error). |
| `scripts/run-examples.ts` | Compiles every example entrypoint and runs the ones marked runnable. |
| `scripts/stamp-version.ts` | Stamps the current commit into src/version.ts so a released binary can report which commit built it. |
| `scripts/strip-string-clones.ts` | Deletes `.clone()` calls on strings: strings are values (copy on write, shared by count where the code reads them again), so every string clone is redundant and removing one changes no behaviour. |
| `scripts/trace-semantics.ts` | Two-way trace between docs/semantics/milo.md and the reference interpreter (src/interp*.ts). |
| `scripts/ts-closure-tiers.ts` | Sorts every closure in the frontend files by how hard it is to make portable, using the TypeScript checker's symbols for what each one captures (scripts/ts-portable.ts only counts them). |
| `scripts/ts-portable.ts` | Counts, per frontend file, the TypeScript constructs outside the portable subset that scripts/ts2milo.ts can translate (rule list: scripts/ts2milo/subset.ts, shared with it). |
| `scripts/ts2milo-identity-census.ts` | How many places a real rollout of node ids would touch: collections keyed by an AST node, and assignments to AST fields, counted with the TypeScript checker (not by pattern) per frontend file. |
| `scripts/ts2milo-lexer-diff.ts` | Differential token gate for the ts2milo spike: lex every corpus file with src/lexer.ts and with the transpiled Milo lexer (compiled by `milo build`), compare the dumps byte for byte. |
| `scripts/ts2milo-mut-diff.ts` | Differential gate for the stage 3 probe (docs/plans/ts2milo.md): the mutability pass run from TypeScript and from its generated Milo over every corpus program that reaches it. |
| `scripts/ts2milo-nonescaping-diff.ts` | Differential gate for the generated non-escaping parameter pass (same shape as ts2milo-mut-diff.ts): the pass run from TypeScript and from its generated Milo over the exact input the checker builds f… |
| `scripts/ts2milo-purity-diff.ts` | Differential gate for the generated @pure body pass (same shape as ts2milo-mut-diff.ts): the pass run from TypeScript and from its generated Milo over the exact input the checker builds for every cor… |
| `scripts/ts2milo.ts` | TypeScript -> Milo transpiler for the portable subset (scripts/ts2milo/subset.ts). |
| `scripts/value-rules.ts` | The value-semantics rules of Milo: how a value prints, how it is cloned, in what order it is dropped, and how HashMap keys compare. |
| `scripts/verify-contracts.baseline.ts` | Accepted (baselined) contract refutations. |
| `scripts/verify-contracts.expected.ts` | Per-file prove-verdict ratchet. |
| `scripts/verify-contracts.ts` | Static contract gate: run `milo prove` over every contract-bearing .milo in std/ and examples/ and FAIL if any contract is *refuted* (the solver found a counterexample proving it false). |
| `scripts/windows-sweep.ts` | Cross-compiles every tests/fixtures/*.milo to windows-x64 and runs the PE, comparing stdout to the fixture's `// @expect:` lines. |
| `.githooks/commit-msg` | Reject commit subjects that read like changelog paragraphs. |
| `.githooks/pre-commit` | Format staged .milo files with bin/milo-fmt (built on demand by `milo fmt`). |
<!-- END GENERATED INDEX -->

This table is regenerated, not maintained — it is how contributors discover what already exists before writing a duplicate.

## API sweep before deploy

`scripts/api-sweep.ts` builds a web app with the deployed compiler and the new one, starts both on free ports against separate copies of the same data, requests every GET route (found by scanning `r.get("/...")`, `r.stream`, `addRoute("GET", ...)`) and byte-diffs status and body. A parameterised route is compared only if `--routes` lists a concrete path for it, otherwise it is reported as skipped. `--ignore REGEX` (repeatable) masks matches before diffing. Exit 0 only if no route differs.

For tahoeroads (the deployed checkout is the compiler the last deploy was built from, e.g. a worktree at the deployed commit):

```sh
bun scripts/api-sweep.ts --app ~/git/tahoeroads/app.milo \
  --old-compiler ~/git/milo-deployed --new-compiler ~/git/milo \
  --data-dir ~/git/tahoeroads/data --data-env TAHOEROADS_DATA \
  --routes ~/git/tahoeroads/sweep-routes.txt \
  --ignore '\d{4}-\d\d-\d\dT[\d:.]+Z?' --ignore 'localhost:\d+'
```

The paths, env var names and the routes file above are placeholders: use the app's own data-dir variable and keep `sweep-routes.txt` (one concrete path per line, `#` comments) beside the app. `--db FILE` copies a single database file (with `-wal` and `-shm`) into each instance's working directory instead, and `--env K=V` sets other variables. `--new-app B.milo` builds the new side from a different source, to check a source edit rather than a compiler change.
