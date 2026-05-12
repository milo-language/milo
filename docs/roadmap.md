# Milo Roadmap

## Phase 1 — Minimal Viable Language

- [x] Primitive types, let, var, arithmetic, comparisons
- [x] Functions with return values
- [x] while loops, if/else
- [x] String literals, extern fn for FFI to C
- [ ] Structs (value types, move semantics)
- [ ] Arrays with bounds checking
- [ ] Second-class references (&T in function params only)
- [ ] Move checking (use-after-move = compile error)
- [ ] Type checker pass (between parser and codegen)

Milestone: FizzBuzz, Fibonacci, simple file I/O via FFI

## Phase 2 — Real Programs

- [ ] Enums / sum types
- [ ] Option<T>, Result<T, E>
- [ ] Pattern matching (match, if-let)
- [ ] Generics
- [ ] Small standard library (print, array utils, string basics)
- [ ] Error messages — invest heavily here

Milestone: JSON parser, simple HTTP server, a toy compiler

## Phase 3 — Self-Hosting

- [ ] Write the compiler in Milo itself
- [ ] Arena system designed based on real needs from self-hosting
- [ ] Semantic analysis / HIR / MIR layers

Milestone: Compiler compiles itself

## Phase 4 — Ecosystem

- [ ] LSP for editor support
- [ ] Package manager (or convention)
- [ ] Documentation, tutorials, "the book"
- [ ] Error messages that make people recommend the language
