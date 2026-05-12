# Milo Roadmap

## Phase 1 — Minimal Viable Language ✅

- [x] Primitive types, let, var, arithmetic, comparisons
- [x] Functions with return values
- [x] while loops, if/else
- [x] String literals, extern fn for FFI to C
- [x] Structs (value types, move semantics)
- [x] Arrays with bounds checking
- [x] Second-class references (&T, &mut T in function params only)
- [x] Move checking (use-after-move = compile error)
- [x] Type checker pass (between parser and codegen)

Milestone: FizzBuzz, Fibonacci, simple file I/O via FFI ✅

## Phase 2 — Real Programs (in progress)

- [x] Enums / sum types (tagged unions, LLVM `{i32, [N x i64]}`)
- [x] Pattern matching (match + exhaustiveness checking)
- [x] Generics — enums (monomorphization)
- [x] Generics — functions (monomorphization, type inference from args)
- [ ] Generics — structs
- [x] Built-in functions (print, println, exit)
- [x] Option<T>, Result<T,E> — definable, no convenience methods yet
- [ ] Option/Result ergonomics (unwrap, map, ? operator)
- [ ] if-let syntax
- [x] Unsigned integer types (u8/u16/u32/u64, udiv/urem/ult)
- [x] Literal type hint propagation (return, struct fields, fn args, assignment)
- [x] Source spans on all AST nodes; line:col in all errors
- [x] Elm-style error messages (source context, carets, hints)
- [x] Parser/lexer throw instead of process.exit
- [x] UUID tmp filenames
- [ ] String type (owned UTF-8 with basic ops)
- [ ] Array utilities
- [ ] Imports / modules (multi-file)

Milestone: JSON parser, simple HTTP server, a toy compiler

## Phase 2.5 — Developer Experience

- [x] LSP server (milod) — diagnostics, hover, go-to-definition
- [x] VS Code extension — syntax highlighting + LSP client
- [ ] LSP: completions, rename, find references
- [ ] REPL / playground

## Phase 3 — Self-Hosting

- [x] HIR — typed intermediate representation (every expr carries TypeKind)
- [ ] MIR — lower-level IR for optimization passes
- [ ] Arena system designed based on real needs from self-hosting
- [ ] Write the compiler in Milo itself

Milestone: Compiler compiles itself

## Phase 4 — Ecosystem

- [ ] Package manager (or convention)
- [ ] Documentation, tutorials, "the book"
- [ ] Formatter (milofmt)
