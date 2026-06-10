# Milo Compiler

Memory-safe systems language → LLVM IR. TypeScript compiler, Bun runtime.

## Quick Reference

```bash
bun run src/main.ts run examples/hello.milo               # compile + run (no artifacts)
bun run src/main.ts build examples/hello.milo -o hello    # compile to binary
bun run src/main.ts emit-ir examples/hello.milo           # emit LLVM IR
bun run src/main.ts build foo.milo --release              # -O3 (default -O2; --debug for -O0)
bun test                                                  # full test suite
bun test tests/run.test.ts -t "arithmetic"                # single fixture by name
./benchmarks/run.sh                                       # reproduce perf numbers
```

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
- Arenas for cyclic data (deferred)
- Strings: owned UTF-8 byte buffers (like Rust's String)

## Key Rules

- Use Bun for everything (not Node)
- Type checker runs before codegen — semantic errors must be caught there, not in codegen
- LLVM IR uses opaque `ptr` (not `i8*`) — LLVM 15+ requirement
- Target triple auto-detected via `src/target.ts` (supports darwin + linux, aarch64 + x86_64)
- Platform-specific stdlib uses suffix split: `std/platform.darwin.milo` vs `std/platform.linux.milo` (resolver picks per host)

## Layout

- `std/` — Milo-language standard library (`.milo` files: io, fs, net, http, json, argparse, arena, …). Auto-discovered via `from "std/<name>" import { ... }` (or `import *`); bare `import "std/<name>"` is no longer accepted.
- `examples/cli-tools/` and `examples/apps/` — runnable Milo programs; treat as integration smoke tests for stdlib changes.
- `docs/language-reference.md`, `docs/grammar.ebnf`, `docs/design.md`, `docs/roadmap.md` — authoritative refs. Check `roadmap.md` before proposing new language features.
- `editors/vscode/` — LSP client; server entry is `src/lsp.ts` invoked via `bun run src/main.ts lsp`.
