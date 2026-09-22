<!-- doc-meta
system: ai-coding
purpose: how Milo's guarantees map onto the failure modes of machine-generated code
key-files: docs/site/language/safety.md, docs/language-reference.md, docs/json-api.md
update-when: a safety guarantee changes, the list of covered failure modes moves, or the agent tooling (skill, api, lang, check, explain) changes
last-verified: 2026-09-22
-->

# AI-Assisted Development

Milo is designed so that **wrong code fails to compile, not fails silently at runtime**. When a model writes a bug, the compiler rejects it with an error pointing at the problem. There is no middle ground where code compiles, appears to work, and hides a memory-safety bug.

## The precision floor

Every language has a **precision floor**: the minimum level of detail a programmer must get right for correct code.

- **Python / TypeScript:** low floor, and models work comfortably above it. No memory safety, so not a systems language.
- **C++:** the highest floor of any mainstream language: move semantics, implicit conversions, undefined behavior, template instantiation and header order, all at once. Models work **below** it.
- **Rust:** high in a different way. The borrow checker rejects correct-in-spirit code that breaks lifetime rules, and models spend iterations fighting the compiler.
- **Milo:** low for a systems language. Get the types and ownership right and the compiler handles the rest: no implicit conversions, no UB, no lifetime annotations, no header files.

## Local reasoning, for an agent

The precision floor is how often a model gets rejected. The more useful property is how
much of a program it has to hold in context to be *right*. In Milo the state a function
can touch is its parameter list, and every argument a call may change is marked `&mut` at
the call site. A model editing a function, or a reviewer reading its diff, needs that
function and the signatures it calls, not the rest of the program.
[Why There Are No Lifetimes](/language/why-no-lifetimes#local-reasoning) has the general
argument.

It shows in the fix loop too. A borrow-checker error often needs a global fix, such as
restructuring ownership three call frames up. A Milo aliasing error names one call, so
the fix a model makes is a local edit:

```
error: 'v' is borrowed mutably twice in the same call
  ──> main.milo:13:14
   │
13 │     two(&mut v[0..2], &mut v[1..3])
   │              ^
```

### What a signature does not tell you

A signature says what a function may mutate. It does not say whether the function
printed, read a file, opened a socket, or touched module state. `@pure` closes that for
the functions that opt in:

```milo error
from "std/math" import { Math }

@pure
fn hypot(a: f64, b: f64): f64 {
    return Math.sqrt(a * a + b * b)     // the whole Math namespace is @pure
}

@pure
fn logged(x: i64): i64 {
    print(x)                            // error: 'logged' is @pure but calls
    return x                            //        'print', which is not
}
```

A `@pure` function reads and writes only its parameters and its own locals: no I/O, no
module state, no raw memory, and no calls that could reach any of those. It can still
trap: purity is not totality.

For generated code that changes what a reviewer has to do. A `@pure` signature whose
parameters are all by-value or `&T` is a compiler-checked claim that the call is safe to
skip, reorder, cache, or retry, so scrutiny goes to the effectful code. A model that
writes I/O where the type says it cannot gets a compile error, not a silent behavioral
difference.

Effect annotations were always a hard sell as boilerplate. That objection weakens when a
model writes the code and a person audits it, though a design that is easier to *verify*
is not automatically easier to *generate*. See
[Effects and capabilities](https://github.com/milo-language/milo/blob/main/docs/effects-and-capabilities.md)
for what is shipped and what is only proposed.

## Tooling an agent can read

Everything an agent needs to know about the language comes out of the compiler as text or
JSON, so it never has to scrape the docs or guess an API:

```bash
milo skill                 # a language guide sized for a context window
milo api <terms>           # search std signatures by name and doc comment
milo api --json            # every std symbol as JSON
milo lang --json           # keywords, types, operators, builtins, warnings, attributes
milo check app.milo --json # diagnostics as JSON, each with its fix when one is mechanical
milo fix app.milo          # apply those mechanical fixes (&mut markers, imports, @ sigils)
milo explain index-clone   # what one warning, @attribute or keyword means, with an example
```

`milo skill` is the one to paste into a system prompt. The JSON formats are described in
[json-api.md](https://github.com/milo-language/milo/blob/main/docs/json-api.md).

## vs. C++: silent bugs

C++ lets wrong code compile, and models write plausible C++ that passes testing and fails
in production. The six most common failure modes, and what Milo does with each:

1. **Implicit conversions**: `char`/`int` blurring, `bool` arithmetic, unsigned wraparound in comparisons. Milo has no implicit coercions.
2. **Use-after-move**: a moved-from C++ object is "valid but unspecified". In Milo it is a [compile error](/language/ownership#moves).
3. **Dangling references**: models routinely return a reference to a local. Milo [cannot express it](/language/ownership#borrowing).
4. **Null deref**: Milo has `Option<T>` with exhaustive match, or an explicit `!`.
5. **Data races**: a closure that starts an OS thread must have [`Send`](/features/concurrency#thread-safety-send-sync) captures, and green tasks share one thread.
6. **Integer overflow**: signed overflow is UB in C++. Milo checks constants at compile time and traps at runtime in every build mode, with `wrappingAdd`/`saturatingAdd` to opt out per operation.

## vs. Rust: borrow checker fights

Rust catches more at compile time than Milo does, but models cannot reliably satisfy its
lifetime rules. A model writes reasonable code that will not compile:

```rust
struct Parser {
    source: &str,  // needs Parser<'a> { source: &'a str }
}
```

then forgets the annotations, adds them wrong, or reaches for `'static` and `.clone()`
everywhere. "Compiler rejects, model fixes lifetimes, makes it worse" is a well-documented
loop. Milo has no lifetimes to get wrong: `fn parse(input: &string): Vec<string>` returns
owned strings, and a struct owns what it holds.

Generic Rust also hits bound cascades: `T: Clone`, then `T: Debug`, then `T: Send`, each
fix revealing the next. Milo monomorphizes, so a `T` without `.clone()` is one error
naming the concrete type, not a chain of bounds to add.

| | C++ | Rust | Milo | For a model |
|---|---|---|---|---|
| Undefined behavior | 200+ categories | none in safe code | none in safe code | wrong code crashes loud, not silent |
| Lifetime annotations | n/a | required | none | no borrow-checker loops |
| Effects visible in the signature | nothing | `&mut`, `unsafe` | `&mut`, `unsafe`, `@pure` | a `@pure` call needs no review |

Where each language catches each memory bug is in [Memory Safety vs Rust](/language/vs-rust).
