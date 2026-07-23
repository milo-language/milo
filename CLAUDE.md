# Milo Compiler

Memory-safe systems language → LLVM IR. TypeScript compiler, Bun runtime.

**Agent entry point:** start at [AGENTS.md](AGENTS.md) — the router to skills, docs, scripts, conventions, and the [workflow](AGENT_WORKFLOW.md). This file holds the hard operational rules below; when the two conflict, this file wins.

## Quick Reference

`./milo <args>` is a repo-root wrapper for `bun run src/main.ts <args>` — use either.

```bash
bun run src/main.ts run examples/hello.milo               # compile + run (no artifacts)
bun run src/main.ts build examples/hello.milo -o hello    # compile to binary
bun run src/main.ts emit-ir examples/hello.milo           # emit LLVM IR
bun run src/main.ts build foo.milo --release              # -O3 (default -O2; --debug for -O0)
bun run src/main.ts build foo.milo -o foo -g --debug      # DWARF for lldb/hades (-g composes with any -O)
bun test                                                  # full test suite
bun test tests/run.test.ts -t "arithmetic"                # single fixture by name
./benchmarks/run.sh                                       # reproduce perf numbers
bun run src/main.ts api <terms>                           # search std signatures (name + doc, ranked)
bun run src/main.ts doc <file|dir> [-o out]               # reference markdown from doc-comments
bun run src/main.ts api --module std/json                 # dump one module's full API
```

**Finding stdlib APIs:** before writing stdlib-adjacent code, run `milo api <terms>` to find existing signatures — don't roll your own. Grep-backed and auto-discovered: it scans `std/**/*.milo` fresh each call, so new/edited `.milo` files appear with no registration. Lexical only (no generics/re-exports/visibility) — good for discovery, not a spec.

## Tests

`tests/run.test.ts` is a single driver that walks two directories:
- `tests/fixtures/*.milo` — compiled + executed; stdout must match `// @expect: <line>` annotations (one per expected output line).
- `tests/errors/*.milo` — must fail type-check; error output must contain the `// @error: <substring>` annotation.

Add a new test by dropping a `.milo` file with the appropriate annotation in the right directory. No code changes needed.

## Architecture

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

## Language Design

- `let` = immutable (SSA register), `var` = mutable (alloca)
- Move semantics: single owner, use-after-move = compile error
- Second-class references: `&T` only in function params, never stored/returned
- User-defined generics: `fn foo<T>`, `struct Pair<A,B>`, `enum Maybe<T>` — monomorphization with type inference
- No GC, no RC, no pointers in safe code
- Arenas for cyclic data via `std/arena` (`Arena<T>` + generational `Handle<T>`)
- Strings: owned UTF-8 byte buffers (like Rust's String)

## Key Rules

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
  Wine validates the link and the CRT calls but is not the OS — CI's `test-windows` job is the authority on whether generated code actually runs. With `MILO_WINDOWS_SDK` set, `verifyCDecls` DOES run the `@cLayout`/`@cSig` guards on a Windows cross-compile (it compiles the guard TU with `--target=<triple>` against xwin's headers), so a wrong layout is caught on the dev host, not only in CI. Other target≠host crosses still skip (no sysroot to read).

## Layout

- `std/` — Milo-language standard library (`.milo` files: io, fs, net, http, json, argparse, arena, …). Auto-discovered via `from "std/<name>" import { ... }` (or `import *`); bare `import "std/<name>"` is no longer accepted.
- `examples/` — runnable Milo programs, grouped by domain (`basics/`, `cli-tools/`, `graphics/`, `simulation/`, `terminal/`, `net/`, `emulators/`, `embedded/`, `runtimes/`, `tools/`); see `examples/README.md`. Treat as integration smoke tests for stdlib changes.
- `docs/language-reference.md`, `docs/grammar.ebnf`, `docs/design.md`, `docs/roadmap.md` — authoritative refs. Check `roadmap.md` before proposing new language features.
- `editors/vscode/` — LSP client; server entry is `src/lsp.ts` invoked via `bun run src/main.ts lsp`.
