# Milo Compiler

Memory-safe systems language → LLVM IR. TypeScript compiler, Bun runtime.

## Quick Reference

```bash
bun run src/main.ts build examples/hello.milo -o hello    # compile
bun run src/main.ts emit-ir examples/hello.milo            # emit LLVM IR
bun test                                                    # run tests
```

## Architecture

```
Source → Lexer → Parser → AST → TypeChecker → HIR Lowering → Codegen → LLVM IR → clang → Binary
```

| File | Purpose |
|------|---------|
| `src/tokens.ts` | Token types and keywords |
| `src/lexer.ts` | Tokenizer |
| `src/parser.ts` | Recursive descent parser → AST |
| `src/ast.ts` | AST node types |
| `src/types.ts` | Internal type representations (`TypeKind` tagged union) |
| `src/checker.ts` | Type checking, move checking, scope validation → `CheckResult` |
| `src/hir.ts` | Typed HIR node types (every expr carries `TypeKind`) |
| `src/lower.ts` | AST + CheckResult → HIRModule lowering |
| `src/codegen.ts` | HIR → LLVM IR emission |
| `src/main.ts` | CLI driver |

## Language Design

- `let` = immutable (SSA register), `var` = mutable (alloca)
- Move semantics: single owner, use-after-move = compile error
- Second-class references: `&T` only in function params, never stored/returned
- No GC, no RC, no pointers in safe code
- Arenas for cyclic data (deferred)
- Strings: owned UTF-8 byte buffers (like Rust's String)

## Key Rules

- Use Bun for everything (not Node)
- Type checker runs before codegen — semantic errors must be caught there, not in codegen
- LLVM IR uses opaque `ptr` (not `i8*`) — LLVM 15+ requirement
- Target triple: arm64-apple-darwin25.3.0
