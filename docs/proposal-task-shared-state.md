<!-- doc-meta
system: proposal-task-shared-state
purpose: language options for sharing long-lived state across green tasks without lifetimes, and why milojs needs global singletons today
key-files: std/runtime.milo, src/checker.ts (milojs itself lives in https://github.com/milo-language/milojs)
update-when: any of these options is adopted, rejected, or the second-class reference rule changes
last-verified: 2026-09-19 (Option 1 shipped as @parks + the cross-task freeze rule)
-->

# Proposal: sharing long-lived state across green tasks

Status: proposal, nothing implemented. Written from a concrete case rather than
in the abstract.

## The case

milojs runs each async activation on its own green task (see
[milojs-async-suspension.md](https://github.com/milo-language/milojs/blob/main/docs/milojs-async-suspension.md)). Such an activation
outlives the call that started it, and its body needs the program and the
interpreter.

Neither can be captured. A task closure cannot hold a `&Prog` or `&mut Interp`
belonging to a caller's frame, and a raw pointer back to a local is rejected
too. Milo has second-class references and no lifetimes or refcounting, so there
is no way to say "this outlives the frame".

The workaround is mutable global singletons — `gInterp`, and now `gProg`. That
costs re-entrancy (one process can only ever run one program) and clarity
(functions take `prog: &Prog` while a global must be the same object). It is a
concession to the language, and anything in Milo needing long-lived state shared
across tasks lands in the same place.

## Option 1 — forbid borrows across a park point (shipped 2026-09-19)

Green tasks are cooperative: they switch only at explicit park points. A mutable
global is therefore never *racing* across tasks, but it was not "already safe"
either: a for-in binding, a slice, or a `&` into an element is a reference into
the global's buffer, and holding one *across* a yield let another task push to
the global, realloc the buffer, and leave the reference reading freed memory
(`for x in g { schedulerYield() }` printed garbage; `tests/errors/globalForInAcrossYield.milo`).

That is a checkable rule, the same shape as the existing second-class reference
rule, and it is now enforced: **an element view of a mutable global may not be
live across a call that may park.** `@parks` is the effect annotation, rooted at
`swapcontext` and declared on the runtime's park primitives; the checker derives
"may park" transitively over the call graph, so `Channel.recv`, `Select.wait`,
`sleepMs`, `Task.join` and a blocking fd read all count without being listed.
See "Thread boundaries" in [language-reference.md](language-reference.md).

- No lifetimes appear, no runtime cost, and the dangerous case is a compile
  error rather than a documented convention.
- A `&mut` to the global's *header* (`grow(g)` with `fn grow(v: &mut Vec<T>)`)
  stays legal: the header survives a realloc, only the buffer does not.

What it does not yet give: a task body still cannot *borrow* long-lived state
directly (references remain second-class), so the global singletons milojs uses
are still the spelling for shared state. Option 1 makes them safe to use; it
does not remove them.

## Option 2 — scoped tasks

`Task.scope` guarantees every task spawned inside joins before the scope exits,
so capturing frame references is sound (Rust's `thread::scope` is the reference
point).

- Fixes the common case cleanly and is well proven.
- Does **not** fix milojs: an async activation deliberately outlives its caller.

Worth having regardless — most green-task code does not outlive its spawner.

## Option 3 — generational arena handles

Hold `index + generation` (a Copy value, not a borrow) and check the generation
on access.

- Works when sharing is genuinely unbounded, which is when options 1 and 2 do
  not apply.
- Costs a checked lookup per access, and turns a compile error into a runtime
  one.

Milo already leans on arenas, and the same idea has been suggested for the GC's
object slots: `Scope` currently carries a hand-written comment promising that a
recycled slot cannot surface a dead closure's statics. Generations make that
checkable instead of documented.

## Recommendation

Option 1 first — highest leverage, smallest surface, most in keeping with
guardrails-not-magic. Option 2 alongside it for ordinary structured concurrency.
Option 3 only where sharing really is unbounded.
