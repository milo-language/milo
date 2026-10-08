# Worksheet: one place walker, total and fail-closed

- **Slug / tag:** `ws/fail-closed-places`
- **Started:** 2026-08-03
- **Status:** done
- **Related:** backlog Tier 1 #6/#7, `docs/memory-safety-vs-rust.md`, memory `project-milo-field-move-uaf`, `project-ripgrep-port-probe`

## Goal

Stop the recurring defect class where an aliasing rule matches one expression
shape and the same operation spelled another way walks past it. Concretely: make
the checker answer "what storage does this expression reach" in **one** place,
total over the expression grammar, failing closed on anything it cannot name.

## What was wrong

Eight separate walkers each asked that question with its own set of node kinds
and its own fall-through, and five of them returned "no place" — which every
caller read as "nothing to check":

| walker | fall-through | direction |
|---|---|---|
| `accessSteps` | `null` for unlisted kinds | open |
| `accessPath` | `null` | open |
| `borrowBasePath` | `null` if root not `Ident` | open |
| `errorIfFrozen` root walk | `return` if root not `Ident` | **open** |
| `setAutoBorrowChecked` root walk | skip if root not `Ident` | **open** |
| `checkViewProvenance` root walk | `return` if root not `Ident` | **open** |
| `isRootMutable` | `false` | closed (fine) |
| `freezeViewSource` | errors | closed (fine) |
| `tryMove` | 4 kinds matched, rest ignored | **open** |

`tryMove` was the expensive one. It branched on `Ident`, `FieldAccess`,
`IndexAccess` and a move `Closure`. No branch matched a fork, so:

```milo
fn pick(d: &Doc): string { return d.a }                    // compile error (correct)
fn pick(d: &Doc, c: bool): string {
    return if c { d.a } else { d.b }                        // compiled. exit 133.
}
```

Two distinct double-frees, both live on `main` at 2c86317c, both silent:

1. **move out of a borrow through a fork** — the tails were never checked.
2. **use-after-move through a fork** — `let s = if c { a } else { b }` marked
   neither `a` nor `b` moved, so both slots were dropped again at scope exit.

## What landed

`placesOf(e: Expr): Place[]` — total over all 25 `Expr` kinds, **no `default:`**;
the `const _exhaustive: never = e` at the end means a new AST node is a tsc error
until someone classifies it. A `Place` is `path` (reached from a named binding by
a chain of steps), `value` (fresh, aliases nothing), or `opaque` (unnameable —
callers must read it as *may be any place*). It returns a **set** because control
flow forks, and every caller must satisfy its rule for all of them.

`moveTargets(e): Expr[]` — the same treatment for consumption. Forks forward to
their tails, `!`/`?` forward to the operand, fresh values consume nothing.

Ported onto it: `accessSteps`, `accessPath`, `borrowBasePath`, `errorIfFrozen`,
`setAutoBorrowChecked`'s mutability walk, `checkViewProvenance`. `isRootMutable`
and `freezeViewSource` already failed closed and were left alone.

## Decisions

- **`placesOf` and `moveTargets` are two functions on purpose, and `CastExpr` is
  where they disagree.** `s as *u8` on a `&string` takes the buffer's address: it
  *reaches* the operand's storage (so `placesOf` forwards — the aliasing rules
  have to see the pointer alias) but *consumes nothing* (so `moveTargets` does
  not). Collapsing them into one walker made 12 std fixtures fail with a bogus
  "cannot move the borrowed value out of 'program'".
- **A fork moves every candidate tail, not the taken one.** Which arm ran is a
  runtime fact, so a binding consumed on either path is unusable after. Codegen
  still only zeroes the slot the taken branch actually moved, so the untaken
  arm's value is dropped normally — no leak, no double free.
- **An arm with no value tail contributes no place.** It diverges (`return`,
  `break`, abort) and consumes nothing on that path. Verified with
  `matchDiverge` — compiles, runs, no false rejection.
- **`errorIfFrozen` no longer runs on an argument that is already a reference.**
  A slice like `v[0..2]` is not competing with a freeze, it *is* one, and whether
  two may coexist is `checkCallSiteExclusivity`'s call — it compares access paths
  and knows `v[0..2]` and `v[2..4]` are disjoint, which the freeze check cannot
  see (any index collapses its path to "may alias"). Asking both meant the blunt
  one always won and the supported disjoint split stopped compiling
  (`mutSliceDisjointArgs`).

## Ethos review — the case against this change

Per .agents/workflow.md §5, argued against each clause of *"a memory-safe systems
language that guides you to correct, readable programs."*

**memory-safe — what spelling still gets through?** Probed twelve compositions:
nested forks, a fork as a call argument, as a struct-literal field, as a
`Vec.push` argument, a match arm that is itself a fork, an arm that is a block
with a value tail, `!` on a borrowed Option field, and a fork over `&T` idents.
All eight rejected correctly. **One did not:** `if c { v[0] } else { v[1] }` on a
`&Vec<string>` compiles.

That is the strongest objection and it stands. It is *not* a hole this change
opened — it is backlog Tier 1 #7 reaching one more spelling. `v[i]` on a borrowed
container silently deep-clones where the identical operation on a field errors,
so the fork inherits the clone. Memory-safe, but the language still teaches one
rule three ways depending on the container, and now there is one more way to ask.
Recorded, not fixed here: making the matrix uniform is a deliberate breaking
change and belongs with Tier 1 #7, not smuggled into a walker refactor.

**guides you — what does a user see when they get it wrong?** The diagnostic
names the tail that offends (`cannot move 'd.a' out of the borrowed 'd'`) and
points at it, once per offending arm, with the `.clone()` hint. Before, they saw
nothing at compile time and `exit 133` with no output at runtime — stdout is
block-buffered and the abort discards it (backlog Tier 1 #1c). Strict improvement.

**correct — where does this fail open?** Every unknown path returns `opaque`, and
no caller treats `opaque` as "no place". The one deliberate relaxation is the
`errorIfFrozen` skip for already-reference arguments, justified above: the
authority for that question is the check with more information, not less.

**readable — could someone infer the rule?** The switch is the rule: one case per
`Expr` kind, grouped by what the form does to storage. The comment states the
defect it exists to prevent so the next reader knows why there is no `default:`.

## Verification

- `bun test` — 1300 pass, 187 skip, 0 fail (238s).
- `tsc` on `src/` — 0 errors, gate held at zero.
- Repro fixtures added under `tests/errors/`: `moveFieldOutOfBorrow{IfExpr,
  MatchExpr,DefaultValue}.milo`, `useAfterMove{IfExpr,MatchExpr}.milo`.
- Minimal repro proving the class was live on `main`: `let s = if c { a } else
  { b }; print(s); print(a)` builds clean at 2c86317c and aborts 133.

## Found on the way

`examples/net/termpair/client.milo` had the second bug for real: the `then` arm
of `let authority = if port == defaultPort { host } else { host + ":" + … }`
hands `host`'s buffer to `authority` while `host` is still read three times below
(resolve, the error message, the TLS handshake name). Fixed with `.clone()` on
that arm only — the other arm concatenates, which copies. The checker found it;
the path was not executed to observe the abort.

## Blockers / open questions

- Tier 1 #7 (one aliasing rule, three answers by container) is now reachable
  through one more spelling. Needs the breaking-change decision — error
  everywhere, or clone everywhere — before it can be closed.
- `checker.error()` still returns `void`. A `fatal(): never` would delete the
  report-and-continue class, but it changes error *recovery*: today the checker
  reports many diagnostics per run, and throwing at the first would report one.
  Wants a catch at the function boundary so multi-error reporting survives.
  Separate change, not folded in here.
- Pre-existing and unrelated (confirmed identical on `main`): a diverging arm in
  an **if**-expression types as `void` and fails unification, so
  `if c { x } else { return "" }` is rejected. Match arms handle it correctly.
