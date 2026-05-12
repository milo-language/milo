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

Done:
- [x] Enums / sum types (tagged unions, LLVM `{i32, [N x i64]}`)
- [x] Pattern matching (match + exhaustiveness checking)
- [x] Generics — enums (monomorphization)
- [x] Generics — functions (monomorphization, type inference from args)
- [x] Built-in functions (print, println, exit)
- [x] Option<T>, Result<T,E> — definable, no convenience methods yet
- [x] Unsigned integer types (u8/u16/u32/u64, udiv/urem/ult)
- [x] Literal type hint propagation (return, struct fields, fn args, assignment)
- [x] Source spans on all AST nodes; line:col in all errors
- [x] Elm-style error messages (source context, carets, hints)
- [x] Parser/lexer throw instead of process.exit
- [x] UUID tmp filenames

Remaining (priority order):
- [x] **P0: String type** — owned UTF-8 `{ ptr, len, cap }`, ops: len, concat (+), eq (==, !=), byte index, auto-coercion to `*u8` for FFI
- [x] **P1: Imports / modules** — `import "path.milo"`, recursive resolution, dedup, transitive
- [x] **P2: Generics — structs** — monomorphization, type inference from field values
- [x] **P3: Option/Result ergonomics** — `!` (unwrap with panic + span), `?` (propagate), `??` (default value)
- [x] **P4: Logical operators** — `&&` / `||` with short-circuit evaluation
- [x] **P5: break / continue** — loop control flow
- [x] **P6: Char literals** — `'x'`, i8 representation
- [x] **P7: Type casts** — `expr as Type`, checked in sema
- [x] **P8: Integer literal coercion** — auto-coerce int literals in binary ops
- [ ] **P9: if-let / guard-let** — `if let Some(n) = opt { ... }`, `guard let Ok(n) = expr else { return ... }`
- [ ] Array utilities (push, slice, etc. — needs runtime/heap)

Milestone: JSON parser ✅, simple HTTP server, a toy compiler

## Phase 2.5 — Developer Experience

- [x] LSP server (milod) — diagnostics, hover, go-to-definition
- [x] VS Code extension — syntax highlighting + LSP client
- [x] GitHub Actions CI — build + test on push/PR
- [ ] LSP: completions, rename, find references
- [ ] REPL / playground

## Phase 3 — Self-Hosting

- [x] HIR — typed intermediate representation (every expr carries TypeKind)
- [x] Drop semantics — compiler emits free on scope exit for heap-owned values (String)
- [x] Box\<T\> — single-owner heap pointer, auto-drop, recursive enum drop glue
- [x] Recursive enums via boxed payload (linked list, tree, AST)
- [x] Vec\<T\> — dynamic array with push/pop/len, bounds-checked indexing, drop glue
- [ ] MIR — lower-level IR for optimization passes
- [ ] Arena system designed based on real needs from self-hosting
- [ ] Write the compiler in Milo itself

Milestone: Compiler compiles itself

## Phase 4 — Ecosystem

- [ ] Package manager (or convention)
- [ ] Documentation, tutorials, "the book"
- [ ] Formatter (milofmt)
