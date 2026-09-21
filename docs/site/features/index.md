<!-- doc-meta
system: features-index
purpose: entry page for the platform capabilities that sit on top of the core language
key-files: docs/site/.vitepress/config.mts
update-when: a capability page is added to /features/ or moved out of it
last-verified: 2026-08-24
-->

# Features

The core language is documented under [Language](/language/): syntax, types, ownership, and
the reasoning behind them. This section is the layer above that — what the toolchain can
do once the code type-checks.

| Page | What it covers |
|---|---|
| [Concurrency](/features/concurrency) | Green tasks, `Promise`, channels, `Select`, `Promise.blocking` for real threads, and CPU parallelism over disjoint bands |
| [C FFI](/features/ffi) | `extern` declarations, `@cLayout`/`@cSig` layout verification, struct-by-value calls, `@noCopy` handles |
| [Annotations & Builtins](/features/annotations) | Every `@annotation` the compiler understands, and the builtin functions available without an import |
| [Packages](/packages) | `milo add`, the GitHub-as-registry model, `milo.lock`, and publishing your own |
| [AI-assisted development](/ai-coding) | Why the compiler catches machine-generated bugs at compile time, and how to drive it from an agent |
| [Benchmarks](/benchmarks) | Measured against C, Rust, and Go, with the reproduction script |

Tooling lives with onboarding: [IDE setup](/getting-started/ide-setup) for the LSP and
editor extensions, [Debugging](/getting-started/debugging) for DWARF, `lldb`, and the
guard wrappers.
