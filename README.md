# Milo

**A memory-safe systems language that guides you to correct, readable programs.**

**Learn more at [milo-language.github.io/milo](https://milo-language.github.io/milo/)** — docs, language tour, playground, and demos you can play in the browser.

**What Milo is.** A systems language built for local reasoning: the function you are reading is the whole story of the values it touches. References are second-class (never stored, so no lifetimes), every value has one owner, mutation happens only through a `&mut` parameter that cannot outlive the call, and every effect is declared where it happens (`@unsafe`, `@thread`, `@parks`, `@mustUse`). It is verbose on purpose: an extra `clone()` or `let _ =` where you are already looking is cheaper than reasoning about state you cannot see.

**What Milo is not.** Not functional: `var`, `for` and in-place mutation are the idiom; it gets functional programming's "nothing else can change this" guarantee by scoping mutation, not by banning it. Not garbage collected and not reference counted. Not Rust: no lifetimes, no stored references, no `Send`/`Sync`; the price is that a view cannot be returned or kept, so you copy, or hold an arena handle. Not a scripting language: it compiles through LLVM to a static binary.

**Measured, not claimed.** We have written over 250k lines of Milo across the compiler (self-hosted), a JS engine, three emulator cores, a debugger and a dozen packages. Nearly every `unsafe` block in them is the C boundary, and not one exists because the ownership model rejected a program (see [memory safety vs Rust](docs/memory-safety-vs-rust.md)).
