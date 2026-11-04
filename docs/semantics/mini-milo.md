<!-- doc-meta
system: semantics
purpose: Mini-Milo, the core calculus: operational rules for moves, borrows and drops, the typing rules that keep programs out of stuck states, and the safety theorem; the spec src/interp.ts is built against
key-files: docs/spec.md, docs/plans/core-hir.md, docs/ownership-model.md
update-when: a rule changes, the interpreter adds a rule, or a MILO-O rule moves into the core
last-verified: 2026-11-03 (draft; no interpreter implements it yet)
-->

# Mini-Milo: the core calculus

Mini-Milo is the smallest language that still has Milo's ownership model: integers, structs,
`let`/`var`, moves, `&`/`&mut` parameters, calls and drops. Generics, closures, tasks, strings
and `match` are left out on purpose. They are extensions, each listed at the end with the
`MILO-O` rule it becomes.

Three things are defined here:

1. **How a program runs**: small rules, each one step (operational semantics).
2. **Which programs the checker accepts** (typing rules).
3. **The theorem connecting them**: an accepted program never gets stuck, never touches freed
   memory, and frees everything exactly once.

The interpreter (`src/interp.ts`, planned) implements section 2 one function per rule, and each
function names its rule ID. A difference between the interpreter and a compiled binary is a
compiler bug, or a rule that is wrong.

## 1. Syntax

```
n  ::= integer literal          b ::= true | false
x  ::= variable                 f ::= field name       S ::= struct name
p  ::= x | p.f                                          -- a place: something that holds a value
e  ::= n | b | p | S { f: e, ... } | e op e | g(a, ...)
a  ::= e | &p | &mut p                                  -- a call argument
s  ::= let x = e | var x = e | p = e | e
     | if e { s* } else { s* } | while e { s* } | return e
fn ::= fn g(x: τ, ...): τ { s* }
τ  ::= i64 | bool | S | &τ | &mut τ                     -- &τ, &mut τ: parameter types only
```

In source, a shared borrow is implicit (`f(x)` for a `&T` parameter); the core writes it `&p`.

## 2. How a program runs

**State.** A program is in a state `⟨F, H⟩`:
- `F` is a stack of frames. A frame maps each variable to a *slot*: a value `v`, `moved`, or
  a *place reference* `ref(k, p)` / `mut(k, p)`, which names place `p` in frame `k` below it.
- `H` is the heap: a finite map from locations `ℓ` to values. In the core, only boxes
  (`Heap<T>`, a `Vec` buffer) live in `H`. Structs live in their slot.

**Values.** `v ::= n | b | S { f: v, ... } | box(ℓ)`. A type is *Copy* if it holds no `box`
(i64, bool, and structs of only those). Everything else is *owned*.

### Reading and moving

```
                 F(x) = v    v is Copy
[E-COPY]       ───────────────────────────            reading a Copy value leaves it
                 ⟨x, F, H⟩ ⇓ ⟨v, F, H⟩

                 F(x) = v    v is owned
[E-MOVE]       ──────────────────────────────────     reading an owned value moves it out
                 ⟨x, F, H⟩ ⇓ ⟨v, F[x ↦ moved], H⟩

                 F(x) = moved
[E-STUCK]      ────────────────────────               a moved slot has no meaning
                 ⟨x, F, H⟩ ⇓ stuck

                 F(p) = S { ..., f: v, ... }    v is owned
[E-FIELD-MOVE] ──────────────────────────────────────────────    MILO-O-fieldMove
                 ⟨p.f, F, H⟩ ⇓ ⟨v, F[p.f ↦ moved], H⟩
```

A place reached through a reference reads the slot it names:
`F(x) = ref(k, q)` or `mut(k, q)` means `F(x.f…) = F_k(q.f…)`. Reading through a reference
never moves: an owned value read through `&` is a type error (rule T-NO-MOVE-OUT).

### Statements

```
[S-LET]     ⟨let x = e⟩: evaluate e to v, then bind x ↦ v (the checker forbids assigning x later)
[S-VAR]     ⟨var x = e⟩: the same, and x may be assigned later

                 ⟨e, F, H⟩ ⇓ ⟨v, F', H'⟩    F'(p) = old
[S-ASSIGN]     ────────────────────────────────────────────────────
                 ⟨p = e, F, H⟩ → ⟨F'[p ↦ v], drop(old, H')⟩     (drop(moved, H) = H)
```

Assigning first drops what the place held, unless it was moved out. That is why reassigning a
moved field or variable "makes it owned again" (MILO-O-fieldMove).

`if` and `while` are standard: evaluate the condition to `true` or `false`, then run the
chosen block. A block is a scope; [S-SCOPE-END] below runs when it is left by any path.

### Drops

```
drop(n or b, H)          = H
drop(S { f1: v1, ..., fk: vk }, H) = drop(v1, ... drop(vk, H))   -- fields last-first
drop(box(ℓ), H)          = drop(H(ℓ), H \ ℓ)                    -- free the cell, then its contents
drop(moved, H)           = H
```

A user `Drop` runs before the fields are dropped (an extension; the core has none).

```
[S-SCOPE-END]   Leaving a scope drops its variables in reverse declaration order, skipping
                moved slots and place references (a reference owns nothing).

[S-TEMP]        A temporary that owns something lives until the end of the statement that
                made it, and is dropped there.                       MILO-O-tempStatement
```

### Calls

```
[E-CALL]  ⟨g(a1, ..., an)⟩ with  fn g(x1: τ1, ..., xn: τn) { body }:
            1. evaluate the arguments left to right:
                 by value  e      →  the value (E-COPY or E-MOVE: the caller loses an owned one)
                 shared    &p     →  ref(k, p), k = the caller's frame
                 exclusive &mut p →  mut(k, p)
            2. push a frame { x1 ↦ a1', ..., xn ↦ an' } and run body
            3. on return v: [S-SCOPE-END] on the frame, pop it, the call evaluates to v
```

Writing through a reference changes the caller's slot:

```
                 F(x) = mut(k, q)
[S-ASSIGN-REF] ──────────────────────────────────────────
                 ⟨x.f… = e⟩ assigns place q.f… in frame k (by S-ASSIGN)
```

There is no rule for writing through `ref(k, q)`: the program gets stuck. T-SHARED-READONLY
makes that unreachable.

## 3. Which programs are accepted

The checker's job is to reject every program that could reach `stuck`, use a freed heap cell,
or free one twice. Each rule names what it prevents.

| Rule | Statement | Prevents |
|---|---|---|
| T-REF-PARAM | `&τ` and `&mut τ` appear only as parameter types: no variable, field or return value has one | a reference outliving the frame it names (no lifetimes needed) |
| T-NO-MOVE-OUT | an owned value cannot be moved out through a reference (read by value from `ref`/`mut`) | the caller's slot holding a value someone else will drop |
| T-SHARED-READONLY | no assignment through a `&τ` parameter | the stuck write in §2 |
| T-EXCL | in one call, a place passed `&mut p` overlaps no other argument (`p` and `p.f` overlap; `p.f` and `p.g` do not) | two names for one place, one of them writing |
| T-MOVED | a variable or field that is moved on *some* path into a point is not read there (flow-sensitive) | E-STUCK |
| T-LET | a `let` variable is never assigned | (a design rule; nothing is unsafe without it) |
| T-ASSIGN-MOVED-OK | assigning a moved place is allowed and makes it owned again | (makes S-ASSIGN's drop of `moved` reachable) |

## 4. The theorem

**Safety.** If the checker accepts a program, then every run of it:
1. never reaches `stuck`;
2. never reads, writes or frees a heap location after it was freed;
3. frees every heap location it allocates exactly once, by the time `main` returns.

The proof is the standard pair of lemmas (Pierce, *Types and Programming Languages*, ch. 8):
**progress** (an accepted state either has finished or can take a step) and **preservation**
(a step from an accepted state leads to an accepted state).

The key invariant is short, and it is the one thing Milo's design buys. **A place reference
always names a frame below the current one, and frames are popped in stack order, so the frame
it names is alive.** T-REF-PARAM guarantees a reference only ever sits in a parameter slot, and
a parameter slot dies with its own frame, before the frame it points into. Rust needs lifetimes
to prove this because its references can be stored. Here it follows from the stack.

For (3): every `box(ℓ)` has exactly one owning slot at any time. E-MOVE transfers it and marks
the source `moved`, and T-NO-MOVE-OUT means a reference never takes it. So [S-SCOPE-END] and
S-ASSIGN drop each box from its single owner, once.

Status: stated, not yet proved. The plan is a paper proof for the core, then Lean when a
customer, a paper or the certificate-checker work needs it.

## 5. Extensions to the core

Each full-language feature becomes rules added here. The `MILO-O` rules in `docs/spec.md` are
the informal versions:

| Feature | Rules it adds | Informal version |
|---|---|---|
| temporaries in expressions | tempFieldRead: an owning field of a temporary is cloned, the temporary dropped right after | MILO-O-tempFieldRead |
| `if`/`match` as expressions | a fork owns its result iff some arm yields an owned value | MILO-O-forkOwnership |
| struct update `..base` | the base's listed fields drop, unlisted ones move | MILO-O-structUpdate |
| closures | lent vs. owned environments | MILO-O-lentClosure, MILO-O-returnedPlainClosure |
| `?`, Option/Result combinators | consume the receiver iff an owned payload is forwarded | MILO-O-propagate, MILO-O-combinatorReceiver |
| `for in` | a consumed iterable is dropped at loop exit | MILO-O-consumedForIn |
| `swap`/`replace` | two places exchange values with no drop | MILO-O-replaceSwap |
| strings | a shared, counted buffer: copy shares, last use moves | (no MILO-O rule yet) |
| green tasks | a frame stack per task, a scheduler choosing which steps; T-REF-PARAM makes cross-task references impossible | (no MILO-O rule yet) |
| globals | the thread-global rule: a task may not read a global another task writes | checker thread pass |
