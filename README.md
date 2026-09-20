# Milo

**A memory-safe systems language that guides you to correct, readable programs.**

**Learn more at [milo-language.github.io/milo](https://milo-language.github.io/milo/)** — docs, language tour, playground, and demos you can play in the browser.

**What Milo is.** A systems language built for local reasoning: the function you are reading is the whole story of the values it touches. References are second-class (never stored, so no lifetimes), every value has one owner, mutation happens only through a `&mut` parameter that cannot outlive the call, and every effect is declared where it happens (`@unsafe`, `@thread`, `@parks`, `@mustUse`). It is verbose on purpose: an extra `clone()` or `let _ =` where you are already looking is cheaper than state you have to look up. That is what makes a Milo function reviewable by a person and generatable by a model in one pass.

**What Milo is not.** Not functional: `var`, `for` and in-place mutation are the idiom; it gets FP's "nothing else can change this" by scoping mutation, not by banning it. Not garbage collected and not reference counted. Not Rust: no lifetimes, no stored references, no `Send`/`Sync`; the price is that a view cannot be returned or kept, so you copy, or hold an arena handle. Not a scripting language: it compiles through LLVM to a static binary.

**Measured, not claimed.** Over 250k lines of Milo exist across the compiler (self-hosted), a JS engine, three emulator cores, a debugger and a dozen packages. Nearly every `unsafe` block in them is the C boundary, and not one exists because the ownership model rejected a program (see [memory safety vs Rust](docs/memory-safety-vs-rust.md)).
