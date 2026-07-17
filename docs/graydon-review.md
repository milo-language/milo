<!-- doc-meta
system: design
purpose: Milo design audited against Graydon Hoare's "The Rust I Wanted Had No Future" (graydon2.dreamwidth.org/307291.html); records where Milo sides with him vs Rust-as-shipped, and the decisions that fell out
key-files: docs/design.md (not-adopted list), docs/backlog.md (action items), docs/roadmap.md
update-when: one of the open decisions below is made (overflow default, lazy adapters, decimal, tail calls)
last-verified: 2026-07-16
-->

# Milo vs the Rust Graydon wanted

Graydon Hoare (Rust's creator) published a list of places where the Rust he
wanted diverged from the Rust that shipped. Milo's design goals — simpler than
Rust, no footguns, readable structure, contracts built in — overlap heavily
with his side of that list. This is the point-by-point audit (2026-07-16).

## Scorecard

| Graydon wanted | Rust shipped | Milo |
|---|---|---|
| Green threads, no async/await coloring | library async/await | ✅ green scheduler, no coloring, plus heterogeneous `select` (the one async benefit he conceded) |
| Second-class `&` — parameter mode only | first-class references | ✅ his position verbatim: `&T` in params, never stored or returned |
| Inferred lifetimes or none | explicit lifetime variables | ✅ no lifetime syntax exists |
| Local-only inference, no unification | HM-style "type tetris" | ✅ statement-local; generic args inferred at call site only |
| No variable shadowing | shadowing allowed | ✅ checker rejects redeclaration in a scope |
| Compiler-builtin containers, open-coded | library containers needing aggressive inlining | ✅ Vec/string/HashMap are compiler-known |
| Simple grammar | complex grammar | ~✅ recursive descent; inherited the angle-bracket turbofish backtracking he lost the argument on |
| Swift-style ergonomic errors | `?` bolted on in 2018 | ~✅ `!`/`?`/`??` + auto-From wrapping; no throws-ABI |
| ML modules over global traits | global type-directed traits | ⚠️ Milo has traits, but capped: no where-clauses, no HKT/GAT, no associated types |
| Runtime existentials (`obj`), more dyn | `dyn` discouraged | ~✅ Go-style structural interfaces, fat-pointer dispatch |
| Interior iteration (stack coroutines) | exterior `Iterator` | ⚠️ exterior `for-in` + duck-typed `next()`; interior only via callbacks |
| Tail calls | rejected for perf parity with C++ | ❌ not adopted (design.md) |
| Auto-bignum integers | wrap or trap | ❌ trap in debug, **silent wrap at -O2/-O3** |
| Built-in decimal float | deferred to libraries | ❌ not adopted |
| Reflection, quasiquotes | half-done macro system | ❌ none at all — simpler than both answers |
| No environment capture ("I hate lambda") | capturing closures | ❌ Milo captures; move-capture-copies + Send checks bound the damage |

His core trade — give up performance and expressivity for simplicity, land in
the Ada/Pascal tier — is Milo's stated ethos. Milo goes further into Ada than
he proposed: ranged types (`i32(0..50000)`) and `requires`/`ensures` contracts.

## Decisions taken from this review

1. **Overflow: silent wrap in release is the one Rust wart Milo kept.**
   A no-footgun language that traps in debug and wraps at -O2 has Rust's exact
   behavior. Swift traps in all modes for a few percent cost — inside the
   accepted perf budget. `wrappingAdd`/`saturatingAdd` already exist for hot
   paths; ranged types and the SMT lane can provably delete checks later.
   → backlog Tier 2 (benchmark, then flip the default).

2. **Do not build lazy iterator adapters.** Associated types drag in the
   inference complexity and library coupling Graydon blames traits for, and
   lazy adapters are the poster child of "library code that only performs via
   aggressive inlining" — his compile-time complaint. Eager Vec-returning
   combinators + the structural `next()` protocol are the coherent
   simplicity-first answer. → backlog #6 amended.

3. **Two polymorphism systems is fine, but frozen.** Traits = compile-time
   capability constraints (bounds, operators); interfaces = runtime shape.
   Clean split, and the interface side is the one Graydon wanted. Guardrail:
   traits stay at current scope permanently (no associated types, no where, no
   HKT); heterogeneous-collection needs route through `Heap<Interface>`.

4. **Cheap adoptions from his missing-features list:**
   - **Decimal**: "every language discovers the long way that financial math is
     special." A stdlib `Decimal` over scaled i128 needs no compiler change.
   - **Tail calls**: "a great primitive for simple, composable state machines";
     LLVM `musttail` works now, Milo has no ABI-stability constraint, and the
     dogfood apps (emulators, parsers) are state machines. Explicit `become`
     only, never implicit TCO. Low priority.

5. **Skip the rest.** Auto-bignum, reflection, quasiquotes, structural records:
   each buys expressivity by making the language harder to reason about — the
   opposite of Milo's trade. Zero metaprogramming is a cleaner position than
   either his or Rust's; contracts + `@derive` cover the real use cases so far.

## Why his conclusion doesn't apply

He concluded his Rust had no future because 2010 needed a C++ replacement and
simplicity couldn't win that fight. Milo isn't in that fight: the contracts/SMT
lane and Ada-tier positioning make the comparison SPARK ergonomics, not C++
benchmarks. The post functions as a favorable design review of Milo's core
choices — green threads, second-class refs, no lifetimes, local inference, no
shadowing — with one correction (overflow default) and one warning heeded
(iterator adapters).
