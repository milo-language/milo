# Milo language/runtime friction — from building milojs

Collected building `examples/apps/milojs/` (a pure-Milo JS engine: lexer, parser,
AST, tree-walking evaluator with closures, mark-sweep GC, CommonJS module loader —
targeting the express/tRPC bundle). Complements the emulator friction docs; where
an item there also bit here I note it as recurring (higher priority).

---

## 1. Flat namespace is a footgun that scales badly (bit me 3×, once broke std internally)

Every top-level `fn` shares one global namespace, so a name I picked collided with
an existing one and the *later* definition silently won — no error at the def site.
Hit it three times:
- `strIndexOf` / `strTrim` vs the same names in `std/string`
- `charAt` vs `charAt` in `repl.milo`
- and the dangerous one: my function **rebound a name std itself calls internally**,
  so std's own call resolved to *my* body → std broke from the inside, far from any
  code I wrote.

The eventual diagnostic is excellent, but you only see it after the collision
already changed behavior; in the std case the failure surfaced nowhere near the
cause. This gets worse as a program grows and as it pulls in more std.
**Cost:** repeated debugging of "std is misbehaving" that was really my shadow.
**Proposed fix:** at minimum a **shadowing warning** when a user def has the same
name as a std/imported symbol (or any prior top-level def). Better: real
module-scoped namespacing so a local `charAt` can't rebind std's. A warning alone
would have caught all three.

## 2. No `break` / `continue` — the single biggest readability hit — ✅ SHIPPED (already landed in 8e7b4c8)

Without loop control I write `var going = true` flag-loops everywhere, which is
exactly the unstructured pattern the flags are meant to avoid. Ironic: I hit this
hardest *while implementing* `break`/`continue` for the JS engine — Milo can't
express what its own guest language now can.
**Cost:** every non-trivial loop is longer and less readable; early-exit intent is
buried in a sentinel var.
**Proposed fix:** `break` / `continue` (labeled optional). Highest-value ergonomic
item in this doc.

**RESOLVED (verified 2026-07-18):** `break`/`continue` are fully wired through the
compiler (lexer→parser→ast→checker→hir→lower→codegen) and work in `while`,
`for`-range, and `for`-in loops, incl. nested loops (break/continue target the
*innermost* loop) and correct iterator-advance on `continue`. Checker rejects them
outside a loop (`'break' outside of loop`). Covered by fixtures `breakContinue`,
`forBreak`, `forContinue`, `break_drop`, `loopBreakDrop`, and error fixtures
`breakOutsideLoop`/`continueOutsideLoop`; formatter round-trips them. This session
closed the one remaining definition-of-done gap: added `break`/`continue`/`for`
productions to `docs/grammar.ebnf` (they were undocumented). Labeled break/continue
not implemented and not needed so far. Nothing more to do here.

## 3. `from` / `in` as reserved words collide with parameter names (papercut)

`from` and `in` are reserved (import syntax / for-in), so natural parameter and
variable names like `from`, `in` are rejected. Surprising because they read as
ordinary identifiers everywhere except the two constructs that use them.
**Cost:** rename churn (`from` → `src`/`start`) with no semantic reason.
**Proposed fix:** make them contextual keywords (reserved only in import / for-in
position), or at least list them in the reference's reserved-word set so it's not a
surprise.

## 4. Formatter puts `}` / `)` on their own line after a struct literal (reads oddly)

After a struct literal the formatter breaks the closing `}` / `)` onto its own line
in cases where the inline form read fine, producing dangling-bracket layout that
looks off.
**Cost:** cosmetic, but it's every struct literal, so it's constant low-grade noise.
**Proposed fix:** keep the closer on the same line for short/inline struct literals
(match the threshold the rest of the formatter uses for collapsing). Needs a repro
snippet — capture one next time it triggers.
