<!-- doc-meta
system: language-docs-index
purpose: landing page for /language/: how the docs are organized and the Learn pages in reading order
key-files: docs/site/.vitepress/config.mts
update-when: the docsSidebar Learn group gains, loses, or reorders a page
last-verified: 2026-09-22
-->

# Language

The docs are split by what you came to do. **Learn Milo** teaches the language in order, each page building on the one before. **How-to** pages solve one task each. **Why Milo** explains the design, and **Reference** is for lookup.

## Learn Milo, in order

1. [Variables & control flow](/language/variables): `let` and `var`, primitive types, casts, `if`, loops.
2. [Functions](/language/functions): signatures, generic functions, built-ins, reference parameters.
3. [Ownership & borrowing](/language/ownership): moves, cloning, `&T` and `&mut T` parameters.
4. [Structs](/language/structs): fields, methods, generic structs, visibility, `Drop`.
5. [Enums & matching](/language/enums): variants with data, `match`, `Option`, `if let`.
6. [Collections](/language/collections): arrays, `Vec`, `HashMap`, `Heap`, and when to use an arena.
7. [Strings](/language/strings): owned UTF-8 strings, methods, building, iterating.
8. [Error handling](/language/error-handling): `Result`, `?`, `!`, `??`, typed errors.
9. [Traits](/language/traits): shared behavior, bounds, operator overloading, interfaces.
10. [Closures](/language/closures): capture by reference, `move` closures, the escape rule.
11. [Modules](/language/modules): explicit imports, project layout, visibility.
12. [Packages](/packages): third-party packages and publishing your own.

Then see [How-to](/language/patterns) for task guides, [Reference](/reference) for syntax lookup, and the [Standard library](/stdlib/) for every module.
