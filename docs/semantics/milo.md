<!-- doc-meta
system: semantics
purpose: Milo Semantics: the executable definition of Milo, with Core Milo (the proved core): operational rules for moves, borrows and drops, the typing rules that keep programs out of stuck states, and the safety theorem; the spec src/interp.ts is built against
key-files: docs/spec.md, docs/plans/core-hir.md, docs/ownership-model.md
update-when: a rule changes, the interpreter adds a rule, or a MILO-O rule moves into the core
last-verified: 2026-11-04 (scripts/trace-semantics.ts traces rules and interpreter both ways; src/interp.ts implements §2 and the rules added at the end, src/interp-co.ts the task rules, src/interp-mem.ts the R-MEM rules and src/interp-sys.ts the R-SYS rules; scripts/interp-vs-golden.ts is its gate)
-->

# Milo Semantics

This document defines what Milo programs mean. It starts with **Core Milo**, the smallest language that still has Milo's ownership model: integers, structs,
`let`/`var`, moves, `&`/`&mut` parameters, calls and drops. Generics, closures, tasks, strings
and `match` are left out of the core on purpose: they are extensions, defined after it (§5), each with the
`MILO-O` rule it becomes.

Three things are defined here:

1. **How a program runs**: small rules, each one step (operational semantics).
2. **Which programs the checker accepts** (typing rules).
3. **The theorem connecting them**: an accepted program never gets stuck, never touches freed
   memory, and frees everything exactly once.

The interpreter (`src/interp.ts`) implements section 2 one function per rule, and each
function names its rule ID. It runs the merged AST on the checker's facts (types, resolved
callees, move and borrow marks), never on the HIR. A difference between the interpreter and a compiled binary is a
compiler bug, or a rule that is wrong.

The trace runs both ways and is gated (`scripts/trace-semantics.ts`, `tests/traceSemantics.test.ts`): every rule ID
defined here (a `[ID]` line in a code block, or the first cell of a table row) is cited by an interpreter function and
exercised by a test whose title names it or a fixture tagged `// @rule: ID`; every interpreter function cites a rule
or sits in the script's allowlist with a reason; every ID the interpreter cites is defined here.

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

Status: stated, not yet proved. The plan is a paper proof for the core, then Lean. The Lean
project exists ([proofs/](../../proofs/README.md)) and so far proves the contract rules of
section 5 over integer state; this theorem needs frames, moves and references added to that
model and is the next target for it.

## 5. Extensions to the core

Each full-language feature becomes rules added here. The `MILO-O` rules in `docs/spec.md` are
the informal versions:

| Feature | Rules it adds | Informal version |
|---|---|---|
| temporaries in expressions | tempFieldRead: an owning field of a temporary is cloned, the temporary dropped right after | MILO-O-tempFieldRead |
| `if`/`match` as expressions | a fork owns its result iff some arm yields an owned value | MILO-O-forkOwnership |
| struct update `..base` | the base's listed fields drop, unlisted ones move | MILO-O-structUpdate |
| closures | lent vs. owned environments; an env-owning closure under a plain fn type is rejected, so no env is ever left without an owner | MILO-O-lentClosure, MILO-O-returnedPlainClosure |
| `?`, Option/Result combinators | consume the receiver iff an owned payload is forwarded | MILO-O-propagate, MILO-O-combinatorReceiver |
| `for in` | a consumed iterable is dropped at loop exit | MILO-O-consumedForIn |
| `swap`/`replace` | two places exchange values with no drop | MILO-O-replaceSwap |
| strings | a shared, counted buffer: copy shares, last use moves | (no MILO-O rule yet) |
| green tasks | a frame stack per task, a scheduler choosing which steps; T-REF-PARAM makes cross-task references impossible | the R-TASK, R-CHAN, R-WG, R-ONCE rules below |
| globals | the thread-global rule: a task may not read a global another task writes | checker thread pass |

### Rules the interpreter added

Each is implemented in `src/interp.ts` under its ID, and was needed to match a recorded golden.

| Rule | Statement |
|---|---|
| S-TEMP-CALL | A call is a scope of its own: a temporary lent to a by-ref parameter (or made while evaluating the arguments) is dropped, last first, when the call returns, before the result is used. Refines S-TEMP. |
| S-TEMP-FIELD | Reading an owned field out of a temporary moves the field out and drops the rest of the temporary at once, before the statement goes on (MILO-O-tempFieldRead). |
| S-PENDING | An owned operand evaluated before its siblings (call argument, struct field, array element, enum payload) is held until the op takes them all; a `return`, `break`, `continue` or `?` out of a later operand drops the held ones, last first. |
| E-FORK-VIEW, E-FORK-OWN | An `if`/`match` expression whose arms all name unmoved places yields a view of the chosen one (dropping it does nothing). If some arm yields an owned value, the fork owns its result and a place arm is deep-copied (MILO-O-forkOwnership). |
| E-INDEX-COPY | Reading a Vec or array element by value copies it (a deep copy if it owns); it never moves out of the container. `get(i)` yields a view. |
| E-STRING-SHARE | A string is a counted buffer. A copy out of a borrow shares it (count + 1), a drop decrements it and the last one frees it; a push on a shared buffer first copies it. A literal, a slice and an empty string own no buffer. |
| E-ARRAY-DROP | The elements of an array or Vec drop first to last; the fields of a struct last to first. |
| E-VEC | A Vec is a header (buffer, start, len, cap) over a heap buffer of its elements; a Vec with cap 0 owns no block. A slice is a header marked view. |
| E-PROPAGATE | `e?` on `Some(x)`/`Ok(x)` evaluates to x; on `None`/`Err(c)` it returns `None`/`Err(conv(c))` from the enclosing fn or closure after the usual scope drops. |
| E-MATCH | An owned, moved subject goes into a holder the match owns, and an arm's bindings move their payloads out of it (a Copy payload is copied). A borrowed subject binds references (`&mut` when the checker says so). The first arm that matches wins; a binding marked escaping (let-else) is declared in the enclosing scope. |
| E-CLOSURE | A closure value holds an environment: a reference to each lent capture, the moved or shared value for a `move`, consumed or shared-string capture. Dropping an owning closure drops the moved captures. |
| E-IFACE | An interface value is the concrete value with its type name, and a method call dispatches on that name. A `&T` given to `&Interface` makes a view pair borrowing the place. |
| E-MATCH-INDEX | A `match` on a container element (`w[i]`) matches a view of the element, so an arm may overwrite the element and its bindings stay valid. |
| E-GLOBAL | A module global with a non-constant initializer runs at its first mention; one no function mentions runs before `main`, in declaration order. |
| E-HASHMAP | A HashMap owns one table block while non-empty and its entries (key, then value, dropped in that order). Iteration order is unspecified; `get`/`m[k]` yield copies. |
| E-FOR-IN | `for x in c` over a Vec, slice, fixed array or string reads the length once, then binds `x` at each index 0..len-1 in order to a view of that element (a byte, for a string); the container is borrowed for the whole loop. |
| S-IF-CHAIN | `if let P = a && c && let Q = b { T } else { E }`: the clauses run left to right, each inside the scopes (and with the bindings) of the ones before it, and stop at the first that fails; `T` runs inside all of them. `E` runs at most once, when some clause failed, after every clause's scope has ended, so none of their bindings is live in it. |
| E-TARGET | `@targetOs()` and `@targetArch()` are the build target's names (`"darwin"`, `"linux"`, `"windows"`; `"aarch64"`, `"x86_64"`, ...), constants of the build. An `if` whose condition is made only of them, literals, `==`, `!=`, `!`, `&&` and `||` has a value known at build time: only the taken arm is compiled, so the other may name what this target lacks (both are still type-checked). |
| E-INTERP | An interpolated string `$"..."` evaluates its parts left to right, then appends each part's text in order to a fresh string: an int in decimal, a float as its shortest round-trip digits, a bool as true/false, a string as its bytes, a struct or enum through its display. The result is owned. |
| E-NEW-ITER | The iterator temporary of a `next()` for-in (`for x in gen()`) is dropped once, when the scope around the loop ends. |
| S-PANIC-ABORT | A panic, failed assert, `exit` or trap stops the run at once: no drops run and no live count is reported. Every runtime failure ends the process the way the compiled runtime does (`panicTail` in `src/scaffold.ts`): the message goes to stderr, stdout is flushed, then `abort()`. The process dies of SIGABRT, which a shell reports as status 134 (128 + 6) and which `milo interp` exits with. Nothing in the runtime exits with status 1 for a failure; a driver that reports 1 for a signal death (as `scripts/guard.ts` does when it has no exit code) is reporting its own default, so a comparison maps a signal to 128 + its number first. `exit(n)` is the one failure-free stop: status `n & 255`, stdout flushed, and the live count still reported. The table below gives the message per kind. |
| T-STUCK | Reading a moved slot, writing through a shared reference, two overlapping `&mut` arguments, a dangling reference or a double free stop the interpreter, naming the rule that failed. |

| Failure | Status | Compiled message (stderr) | Interpreter message |
|---|---|---|---|
| index out of bounds (Vec, array, slice) | 134 | `milo: array index out of bounds: I/LEN at FILE:LINE` | `array index out of bounds: I/LEN` |
| slice or string range out of bounds | 134 | `milo: slice range out of bounds: A..B (len LEN) at FILE:LINE:COL` | `string range A..B out of bounds (len LEN)` |
| integer overflow, negation overflow | 134 | `runtime error: integer overflow at FILE:LINE` | `integer overflow` |
| value out of range (checked cast, ranged type) | 134 | `runtime error: value out of range at FILE:LINE` | `T out of range` |
| division or remainder by zero | 134 | `milo: division by zero at FILE:LINE:COL` | `division by zero` |
| shift amount out of range | 134 | `milo: shift amount out of range (>= BITS) at FILE:LINE:COL` | `shift amount out of range` |
| `x!` on None or Err | 134 | `error at FILE:LINE:COL: unwrap called on None` (the error's text for Err) | `unwrap called on None` / `unwrap called on Err` |
| `assert` | 134 | `assertion failed at FILE:LINE:COL: MSG` | `assertion failed: MSG` |
| `todo` | 134 | `todo: 'FN' is not implemented (FILE:LINE:COL)` | `not yet implemented` |
| contract clause (R-CONTRACT-FAIL) | 134 | `runtime error: requires clause violated at FILE:LINE` | the same text |
| call stack too deep | 139 | none: the process dies of SIGSEGV | none, status 139 (the depth limit is 2000 frames, not the OS stack) |
| `exit(n)` | `n & 255` | none | none |

Only the status and stdout are compared between a compiled run and the interpreter; the stderr text is
the runtime's and is not (the interpreter leaves out the source position, except for contracts).

### Tasks, channels and atomics

A program that reaches a task operation runs in `src/interp-co.ts` (the plain interpreter stops at the
first one and the run starts over, which is invisible: a run is deterministic and its output is held
until the end). Each task is a generator running the interpreter's generator twins
(`src/interp-gen.ts`, generated from `src/interp.ts` by `scripts/gen-interp-co.ts`), so a task can stop in
the middle of an expression. A task has its own frames, temporaries and pending operands. The library's
Task, TaskScope, Channel, WaitGroup, Once and atomics are natives (`src/interp-co-natives.ts`) because
std keeps them in raw memory under pthread locks. One task runs at a time and keeps the CPU until it
parks, yields or ends: nothing preempts it, so no operation needs a lock.

| Rule | Statement |
|---|---|
| R-TASK-MAIN | `main` is the first task. The program ends when it returns and every other task is abandoned where it stands: no drops run for it. |
| R-TASK-ABANDON | Tasks left when main returns, or when `exit` is called in any task, keep the library's own blocks allocated, because it leaves its scheduler up: four for the scheduler, three per task still there (main too when it is the one that called `exit`; a main that returned is gone), four more for one asleep (the Select behind `sleepMs`), one per idle stack context in its cache (at most 64; every finished default-stack task leaves one), one for the environment of each task whose closure captured something (freed when the task ends), one per open `Task.scope`, and one for the table of fd waiters once a task has waited on a descriptor. With no task left the scheduler is torn down and none remain, but only when the compiled `main` is a green task (`Task.spawn` reachable from it); a program that only uses `Task.scope` keeps its four scheduler blocks, plus the idle stack contexts. Counted (against allocation traces of compiled programs) so the live-block comparison holds. |
| R-TASK-SPAWN | A spawned task is ready at the back of the run queue. It does not run until the spawner parks, yields or ends. |
| R-TASK-PICK | Which ready task runs next is one method, `pickNext(ready)`, the hook for exploring schedules. The default is the front of the queue (FIFO, as std/runtime's run queue). Like the library's scheduler, the front task moves to the back after 32 task turns in a row. |
| R-TASK-YIELD | `schedulerYield` puts the caller at the back of the queue. |
| R-TASK-PARK, R-TASK-UNPARK | `schedulerPark` takes the caller off the queue; `schedulerUnpark` puts a parked task at the back. Unparking a task that is not parked does nothing (the library calls that a bug). |
| R-TASK-JOIN | `join` parks the caller until the task has ended; a task already ended returns at once. |
| R-TASK-SCOPE | `Task.scope` runs its body, then parks the caller until every task spawned on the scope has ended. |
| R-TASK-DRAIN | `schedulerRunToCompletion` parks the caller until it is the only task left. |
| R-TASK-PANIC | A panic in a task that is not main and is inside no `Task.scope` retires that task (its message goes to stderr, its frames are abandoned) and the program goes on; any other panic aborts the program. |
| R-TASK-BLOCKING | A blocking-pool job or OS thread (`Promise.blocking`) runs as one more task: the interpreter has no second thread. The first blocking-pool job allocates the pool, one heap block that stays live until the program exits. A blocking-pool job starts with no scheduler: `schedulerExists()` is false in it until the job starts one itself (arming a timer does), and the next job starts without one again. |
| R-TIME | Time is a virtual clock in milliseconds. `sleepMs` parks the task until the clock reaches now + ms; the clock moves only when no task is ready, to the earliest wake time. `sleepMs(0)` yields. |
| S-DEADLOCK | If no task is ready and none sleeps, the run stops with a stuck error naming each parked task and what it waits for. |
| R-CHAN | A Channel is a queue of at most `capacity` values. `send` on a full channel parks the sender, `recv` on an empty one parks the receiver. A task that parks joins the head of its wait list and a wake takes the head (the library's lists are stacks), so the latest waiter wakes first. A wake only readies the waiter, which rechecks its condition when it runs; `send` does not switch tasks. `close` wakes every waiter; queued values are still delivered, then `recv` returns Err. The last owner to drop destroys the queued values. |
| R-WG | `add` and `done` move a counter; `done` leaving it at zero or below wakes every waiter; `wait` parks while it is positive. |
| R-ONCE | The first `run` calls its closure; a caller that arrives meanwhile parks until it finishes. |
| R-ATOMIC | An atomic operation is a plain read-modify-write, since one task runs at a time. `add` and `sub` wrap at the width. The `_atomic*` intrinsics do the same through a pointer. |
| R-EXPLORE-CHOICE | A choice point is a `pickNext` call with two or more tasks ready. A schedule is the list of indices taken at the choice points, in order; a run past the end of the list picks the front (FIFO). A run is a pure function of the program and its schedule. |
| R-EXPLORE-REPLAY | `milo interp --schedule a,b,c` runs under the task interpreter with exactly that schedule (contract checks on). An index that does not fit the ready list picks the front. |
| R-EXPLORE-FAIL | `milo interp --explore` runs the program under many schedules (a fresh run each, contract checks on) and reports, per kind, the first schedule that ends in: S-DEADLOCK, a panic (including one that only retires a task, R-TASK-PANIC), an assertion failure, a contract failure, any other stuck error, or, for a run that ends normally, stdout different from the FIFO run (`nondeterministic-output`, accepted by `--allow-nondeterministic-output`). Each report carries the schedule, the task and source line of every switch, and the replay command. Exit code 5 when anything is reported. A run longer than 200000 scheduling steps, or with one step that makes over 500000 shared accesses without switching (a spin-wait on an atomic for a task that cannot run: nothing preempts), is cut and counts as neither good nor bad. |
| R-EXPLORE-DFS | The default search is depth-first over choice sequences from the FIFO run, bounded by `--max-schedules N` (default 1000; the FIFO run counts). A run reached by a prefix owns the choice points past it and adds one prefix per alternative task, except where R-EXPLORE-INDEP lets it skip. |
| R-EXPLORE-RANDOM | `--random N --seed S` runs N schedules by probabilistic concurrency testing: every task gets a random priority, the highest-priority ready task runs, and at two random steps within the FIFO run's length the running task drops to the lowest priority. The seed fixes the report. |
| R-EXPLORE-INDEP | Choosing task B at a choice point where the run chose A is skipped when B's next step (its first step after the choice point in the run) shares nothing with the steps that ran from the choice point up to it: the swapped run is then an equivalent reordering. A step's footprint is the set of channels, WaitGroups, Onces, atomics, task handles and scopes its natives touched, non-const globals it read or wrote, heap blocks it loaded from or stored to through a pointer, the clock (`sleepMs`), standard output or error if it wrote any, task creation, and the end of main. An alternative that never runs again in the run (the program ended first) is never skipped. This is a reduction, not a proof: it assumes those are the only shared things. |
| R-REPLAY-OFF | Record/replay is off, as in a binary run with neither MILO_RECORD nor MILO_REPLAY set. |

A task operation that would park cannot run where the interpreter is not on a task's own stack: in a
global's initializer, a user `Drop`, or a closure a library call runs (`map`, `sort_by`). That is reported
as unsupported, never run wrongly.

### Contracts

| Rule | Statement |
|---|---|
| R-CONTRACT-ENTRY | With contract checks on (the default for `milo interp`, as in a build; `--no-contract-checks` turns them off), a call first snapshots every `old(e)` of its `ensures` clauses, then checks each `requires` clause in order. |
| R-CONTRACT-EXIT | At every return, with `result` naming the value returned and before the frame's variables drop, each `ensures` clause is checked. |
| R-CONTRACT-LOOP | With loop invariant checks on (`milo interp --contract-checks` or `--debug`; off by default, as in a release build), a `while` loop's `invariant` clauses are checked before its condition each time, so also when it exits; a `for` loop's at the top of each iteration. `decreases` is static only. |
| R-CONTRACT-FAIL | A failed clause is a panic that prints `runtime error: <kind> clause violated at file:line` (the clause's own line, the path relative to the working directory) and aborts like any panic. |
| R-CONTRACT-IMPLIES | `a ==> b` (contracts and `assert` only) evaluates `a`; when it is false the result is true and `b` is not evaluated, otherwise the result is `b`. It is `!a \|\| b`. |

Struct `invariant` clauses are proved statically and have no runtime check in a compiled binary, so the
interpreter does not check them either.

These rules have a machine-checked soundness proof for the integer core of the language
([proofs/](../../proofs/README.md), Lean): a program whose verification conditions hold never reaches
R-CONTRACT-FAIL at any check level and runs the same with the checks off, and with entry and exit
checks on, a call returns only when its `requires` and `ensures` held, proven or not. The proof covers
the rules as stated here, not the verifier that implements them.

### Raw memory

`unsafe` code is run the way WASI or Emscripten run compiled C: memory is bytes, and only the bottom
layer of C functions is implemented (next section). Nothing here knows what a std module is for.
`src/interp-mem.ts` implements these rules; every violation is a stuck state naming the rule, so the
interpreter doubles as a Miri-style undefined-behaviour checker for the unsafe code in std.

**Pointers.** A raw pointer `*T` is `null` (the integer 0) or `ptr(a, off)`: an allocation `a` and a byte
offset. An allocation is a byte array (`malloc`), or a *byte view* of a value the interpreter keeps
structured (a Vec buffer, a fixed array, a variable, a string's bytes). A view encodes its elements to
bytes when read and decodes them when written, using the layout of `src/layout.ts` (the sizes, alignments
and field offsets the compiled program has), so the structured value stays the single copy. Each allocation
owns a range of one virtual address space, which gives `ptr as i64` a number and lets `n as *T` recover the
allocation it came from.

| Rule | Statement |
|---|---|
| R-MEM-ALLOC | `malloc(n)` makes a zeroed allocation of n bytes and counts as one live block, as in a compiled run; `calloc` is `malloc(c*n)`. |
| R-MEM-REALLOC | `realloc(p, n)` always moves: a new allocation holds the first min(n, old size) bytes and the old one is freed. `realloc(null, n)` is `malloc(n)`. |
| R-MEM-FREE | `free(null)` does nothing. `free(p)` frees an allocation that `malloc` made, when p is its start. |
| R-MEM-LOAD, R-MEM-STORE | `*p`, `p[i]` (at p + i * sizeOf T) read or write a value of type T at the pointer. Scalars, pointers, structs of those and fixed arrays of those have bytes; a field written through `p.f` is read-modified-written. |
| R-MEM-ADDROF | `x.addrOf()` is a pointer to the bytes of the place x (a fixed array is its elements). Taking it twice gives equal pointers. A place with no byte layout (a string, Vec, enum) is unsupported. |
| R-MEM-VECPTR | `v.ptr()` points at element 0 of a slice; an empty Vec, owning no block, gives null. A string's `_strDataPtr` points at its bytes. |
| R-MEM-CSTR | `s.cstr()` is a pointer to a NUL-terminated copy of the string's bytes; the copy is never freed and is not a live block. A string argument for a `*u8` parameter decays to the same (string and array decay), and so does a fixed array for a `*T` parameter, as a pointer to the array itself. |
| R-MEM-ADDR | `p as i64` is the allocation's base + offset; `n as *T` is the allocation whose range holds n, with that offset, or null for 0. Comparing pointers compares addresses. An address no allocation of this run owns can be held and compared but not followed. |
| R-MEM-COPY | `memcpy`, `memmove` and `memset` act on bytes, with the bounds of R-MEM-OOB at both ends. `sizeOf<T>()`, `offsetOf<T>("f")` and `zeroed<T>()` use the compiled layout. |
| R-MEM-OOB | stuck: an access of n bytes at offset o of an allocation of size s with o < 0 or o + n > s (a view's size is its element count times the element size). |
| R-MEM-UAF | stuck: any access, `realloc` or view access to an allocation that was freed (a Vec buffer or string buffer is freed when its owner drops). |
| R-MEM-DOUBLE-FREE | stuck: `free` of an allocation already freed. |
| R-MEM-FREE-INVALID | stuck: `free` or `realloc` of a pointer that is not the start of a `malloc` block (a view, a `cstr`, an interior pointer). |
| R-MEM-NULL | stuck: a load, store or C-string read through null. |
| R-MEM-ALIGN | stuck: a load or store of a scalar of size k (at most 8) at an address that is not a multiple of k. The compiled program emits aligned accesses, so a misaligned one is undefined there. |
| R-MEM-OVERLAP | stuck: `memcpy` whose source and destination ranges overlap (`memmove` allows it). |
| R-MEM-WRITE-RO | stuck: a store into a read-only allocation (a string literal's bytes, a `strerror` message). |
| R-MEM-PROVENANCE | stuck: following an address no allocation owns, or asking the address of something that is not a pointer. |
| R-MEM-LAYOUT | stuck: `offsetOf` of a field that does not exist. |

Not checked: reads of bytes `malloc` never wrote (the allocation is zeroed, as `calloc`'s would be), and a
pointer to a stack variable that outlives its frame is only caught when the variable's slot has died.

### The C layer

An `extern fn` call runs `src/interp-sys.ts`, keyed by the C symbol. The set is what std calls, not
libc: `malloc calloc realloc free memcpy memmove memset memcmp memchr strlen strcmp strncmp strerror`,
`read write open close lseek fstat stat lstat access ftruncate truncate fsync fdatasync fcntl isatty dup
dup2 unlink rmdir mkdir rename getcwd chdir mkdtemp opendir readdir closedir`, `getenv setenv unsetenv
getpid getppid getuid geteuid getgid getegid sysconf tzset __error __errno_location`, `gettimeofday
clock_gettime time usleep sleep nanosleep`, `arc4random arc4random_uniform arc4random_buf getentropy
getrandom`, `exit _exit`, and the libm functions `sqrt fabs floor ceil round sin cos tan asin acos atan atan2
exp log log2 log10 pow fmod`. A call to any other extern is `InterpUnsupported` naming the function;
sockets, threads and locks, process spawning, dynamic loading, terminals, TLS and the wrapped C libraries
(sqlite, openssl) are in that group.

| Rule | Statement |
|---|---|
| R-SYS-FD | Descriptors 0, 1 and 2 are stdin (empty, or the host's under `milo interp`), stdout and stderr, which append to the same buffers `print` and `eprint` use, so the order of mixed output holds. `open` returns the lowest free descriptor ≥ 3, with the host OS's flag values (std's platform arm chose them). A failed call returns -1 and sets errno (read through `__error` / `__errno_location`, a pointer into memory). |
| R-SYS-FS | Files live in an in-memory filesystem: a path is made absolute against the working directory, `..` and `.` fold, a file is a growable byte array. `struct stat` and `struct dirent` are filled at the offsets std's own `statSizeOffset`, `direntNameOffset` and the like report. The host filesystem is reachable only through a read-only `HostFs` handed in by the driver: `milo interp` seeds the in-memory filesystem lazily, read-only, from the program's own directory (the working directory starts there), or from all of `/` with `--host-fs`. A host file is copied in when first touched, writes go to the copy and never reach the host, and an `unlink` hides the host file for the rest of the run. The browser playground passes no `HostFs`. |
| R-SYS-CLOCK | The wall clock is the host's, plus the time the program has slept: `usleep`, `sleep` and `nanosleep` advance the clock and return at once, so a sleep costs nothing and a busy-wait on the clock still ends. (The task scheduler's own clock, R-TIME, is separate.) |
| R-SYS-ENV | `getenv` reads the environment the driver passed in (the host's under `milo interp`); `setenv` and `unsetenv` change the program's copy only. |
| R-SYS-RANDOM | Entropy calls return host random bytes (a run is not reproducible through them). |
| R-SYS-EXIT | `exit` and `_exit` stop the run at once like the `exit` builtin (S-PANIC-ABORT's no-drops rule). |

Two Vec and string representations meet here. The interpreter keeps a Vec's buffer as an array of values and a
string as a counted byte array, so std's own bodies that walk their raw header (`VecHead`, `StrHead`) run only
as far as the header is a view: `v.addrOf()` as `*VecHead` reads `_data`, `_len` and `_cap` and writes length and
capacity back, and a pointer to a Vec of strings moves the string values whole. A header whose `_data` is aimed at
a buffer of raw bytes (what `_vecGrowBuf` and `_strAlloc` make) is not modelled, so the std functions that do it
stay replaced by the natives in `src/interp-natives.ts`.

Not modelled (reported as `InterpUnsupported`): the extern functions above not in the list, `atexit`,
`embedFile`, `jsonStringify`, record/replay wrappers, and a raw view of a value with no byte layout
(strings, Vecs, HashMaps, enums, closures).

### Interpreter gaps: library behaviour and the C layer, continued

Rules added while closing the programs the interpreter reported as unsupported. The
interpreter behaviour of `_natLess`, string pieces (`lines`, `splitView`), `?` boxing and `context`
is the compiled one and is covered by E-VEC, E-NEW-ITER and E-IFACE above.

| Rule | Statement |
|---|---|
| R-INT-BITS | `x.rotateLeft(n)` and `x.rotateRight(n)` rotate the bits of the integer's width by n mod width. `x.reverseBits()` reverses them. `x.checkedNeg()` is `Some(-x)`, or `None` when -x does not fit (any non-zero unsigned value, or the minimum of a signed width). |
| R-JSON-STRINGIFY | `jsonStringify(s)` of a struct whose fields are strings, integers, floats and bools is `{"field":value,...}` in field order: a string is escaped as RFC 8259 (`"`, `\`, newline, tab, return, other bytes below 0x20 as `\u00xx`), numbers print as `print` shows them. A struct given to a `json(body: string)` method parameter is its `toJson()` when it has one, else the same text. |
| R-EMBED-FILE | `@embedFile("p")` is the bytes of the file `p`, relative to the source file that names it, read when the call runs. Only a driver that hands in a host file reader (`milo interp`) can run it; elsewhere it is unsupported. A file that cannot be opened is stuck. |

### Interpreter gaps: memory and C layer additions

| Rule | Statement |
|---|---|
| R-MEM-ADOPT | `h.ptr()` of a `Heap<T>` is a pointer to the box's contents, a block of its own that `free` or `adopt` accepts. `h.addrOf()` is the address of the slot that holds the box: reading `*slot` gives `h.ptr()`. `adopt(p)` of a pointer a Heap gave out is that same box taken back; of a `malloc` block it is a box whose contents are the memory at p and whose drop frees the block. `adoptSlice(p, n)` of a pointer a Vec gave out is that Vec cut to n elements (capacity n); of a `malloc` block it is a Vec over the memory whose drop frees it. Any other pointer is R-MEM-FREE-INVALID. A user method named `ptr` on T wins over `Heap.ptr()`. |
| R-MEM-NULLREF | `let g = p else { ... }` over a `?&T` or `?&mut T` parameter runs the else block when p is null, and otherwise binds g to a reference to the memory p names (a Milo caller's reference is bound as it is). |
| R-SYS-LIBC | `strtoll`, `strtol` (64-bit), `strtoul`, `strtoull` skip leading space, take a sign, a `0x` prefix for base 16 (or 0) and digits of the base, set `*endptr` to the first byte not used (the start when there is no number) and saturate with errno ERANGE. `strtod` reads a decimal, `inf`, `nan` or `0x` integer prefix the same way. `setlocale` succeeds for the names "C", "POSIX", "" and any UTF-8 name and returns that name (the locale itself is always C); any other name returns null. `uname` fills `struct utsname` (256-byte fields on darwin, 65 on linux) with the host OS name, "milo", "0.0", "milo interpreter" and the architecture. `ioctl` fails with ENOTTY, since no descriptor is a terminal (`isatty` is 0). `proc_pidpath` writes the absolute path of the program file the driver was given. |
| R-SYS-TIME | `localtime_r`, `gmtime_r`, `mktime` and `strftime` use a time zone that is UTC unless the program's `TZ` (its own environment, R-SYS-ENV) names another: "UTC", a POSIX `NAMEhh[:mm]` (hours west of Greenwich; a DST rule after it is ignored, there is no DST) or an IANA name resolved by the host's `Intl`. `struct tm` is the nine leading ints, `tm_gmtoff` at offset 40 and `tm_zone` at 48. `strftime` implements `%Y %y %C %m %d %e %H %I %M %S %j %a %A %b %B %h %p %u %w %Z %z %s %F %T %R %D %c %x %X %n %t %%` in the C locale, and returns 0 when the result and its NUL do not fit. |
| R-SYS-PRINTF | `printf` writes to the stdout buffer (R-SYS-FD) and `snprintf` / `sprintf` to memory, with the conversions `d i u x X o c s p f F e E g G %`, flags `- + space # 0`, width, precision (both may be `*`) and the length modifiers `hh h l ll z j t`. A string passed where C takes `char *` (also as a variadic argument) is its NUL-terminated bytes. The result is the number of bytes the full output has. |
| R-SYS-SYMLINK | The in-memory filesystem has symbolic links: `symlink(target, path)` makes a node holding the target path, `readlink` reads it back (EINVAL for anything else), `lstat` reports `S_IFLNK` and `readdir` reports `DT_LNK` for it, `unlink` removes the link itself. `stat`, `open`, `access`, `opendir`, `chdir` and `chmod` follow a chain of up to 8 links, a relative target being relative to the link's directory. `chmod(path, mode)` sets the permission bits `stat` reports. |

### Foreign code (CLI only)

Under `milo interp` (Bun) some externs run in the real library instead of being modelled: the sqlite3 C API, the
CommonCrypto `CC_*` calls, and the functions of a `foo.c` beside `foo.milo`. The driver injects the foreign layer
(`src/interp-ffi.ts`, which imports `bun:ffi`); the browser bundle has none, and there those externs are
`InterpUnsupported` as before. An extern the interpreter models itself (R-SYS-*) is never sent to the foreign layer.
Not supported through it: a struct passed or returned by value, a variadic call, a callback (a function pointer
argument), OpenSSL, CoreFoundation.

| Rule | Statement |
|---|---|
| R-FFI-LIB | The foreign layer handles `sqlite3_*` (the system libsqlite3), `CC_*` / `CCCrypt*` (libSystem, darwin) and, when a `foo.c` sits beside the program, every other extern symbol, looked up in that file compiled to a shared library with the system C compiler the first time one of its functions is called. A symbol the library does not have is unsupported. |
| R-FFI-CALL | A foreign call passes integers, floats and bools by value. A pointer argument that is an interpreter pointer is copied, from the pointer to the end of its allocation, into a native buffer for the call and copied back afterwards when the library changed it (an out-parameter, a context struct); a null pointer or an address no allocation owns (a `sqlite3*`, a statement, `SQLITE_TRANSIENT`) goes through as the integer it is. A pointer result that points into an argument's buffer is a pointer into that argument; a C string result (`sqlite3_column_text`, `sqlite3_errmsg`, `sqlite3_column_name`) is a read-only interpreter copy, as long as `sqlite3_column_bytes` says for text; any other pointer result is an opaque address, held and compared but never followed (R-MEM-PROVENANCE). `sqlite3_bind_text` and `_blob` are always told the value is transient. |
| R-FFI-SQLITE-PATH | The interpreter's filesystem is in memory, so a database file that `sqlite3_open*`, `ATTACH` or `VACUUM INTO` names by a path of it is made at the same path under a private directory of the host's temp directory, removed when the process exits. The file shows in the interpreter's filesystem (`stat`, read) once it exists, and deleting it there deletes it. `:memory:`, the empty name and `file:` URIs go to sqlite unchanged. |
| R-FFI-COMPANION | The companion C file is compiled with `xcrun clang` (darwin) or `cc` to a shared library in a fresh temp directory; a compile error is reported as the run's failure. |

### Regular expressions

| Rule | Statement |
|---|---|
| R-SYS-REGEX | `regcomp` translates a POSIX extended regular expression to a JavaScript one in unicode mode (a character is a code point, as in the UTF-8 locale std/regex asks for; bracket classes such as `[[:alpha:]]`, `\<` and `\>`, `{n,m}`, REG_ICASE and REG_NEWLINE are translated), keeps it under an id written into the first 8 bytes of the `regex_t` (so a copy of the `regex_t` still works), and answers REG_BADPAT (2) for a pattern it cannot translate. `regexec` searches the byte range in `pmatch[0]` when REG_STARTEND is set and the bytes up to the NUL otherwise, with REG_NOTBOL keeping `^` from matching at the start of the range; it fills `pmatch` with byte offsets (-1 for a group that did not take part) and answers REG_NOMATCH (1) when nothing matches. JavaScript tries alternatives left to right where POSIX takes the longest match, so a pattern whose alternatives overlap can match shorter here. `regfree` forgets the expression. |

### The network, pipes, signals and threads

`src/interp-net.ts` adds to the C layer the descriptors that are not files, the process's signals and
`pthread_*`. Everything is memory inside the run: no host socket, pipe, signal or thread exists. The calls
are `pipe pipe2 socketpair socket bind listen accept connect shutdown getsockname getpeername setsockopt
getsockopt send recv sendto recvfrom htons ntohs inet_pton getaddrinfo freeaddrinfo poll signal raise kill
sigprocmask sched_yield`, `pthread_create pthread_join pthread_detach pthread_self` and the
`pthread_mutex_*`, `pthread_cond_*` and `pthread_rwlock_*` families, plus `read write close dup dup2 fcntl
ioctl usleep sleep nanosleep` when the descriptor or the program is one of these. The two plain interpreters
share it: a call that cannot return yet is a generator the task interpreter (`src/interp-co.ts`) drives, and
under the plain interpreter, where no other task exists to change anything, it is a stuck state. Left out on
purpose, and reported as unsupported with the function's name: `fork exec* waitpid posix_spawn system`
(there are no other processes), `epoll_* eventfd select` (std's green IO reaches readiness
through natives, R-NET-BLOCK), `dlopen`, pty calls and TLS.

| Rule | Statement |
|---|---|
| R-FNPTR | A function used as a value of pointer type (`f as *u8`) is a read-only 8-byte allocation, one per function, so its address is stable and equal to itself; C-layer calls that take a callback (`signal`, `pthread_create`, `qsort`) find the function from the pointer, or take the function value itself when the parameter has a function type, and call it by name. `p as extern (..) => R` gives back the function a pointer was made from (a pointer that is no function's is unsupported), and a C function pointer in a variable or field is called like a closure. The pointer of a closure (`f as *u8`) is one allocation per lambda and is not callable from C. `a[i].addrOf()` of an array element is a pointer into the array, not to a lone cell. |
| R-NET-FD | A pipe end or a socket is a descriptor in the same table as files, lowest free number from 3; `/dev/fd` and `/proc/self/fd` list the table. The object behind it (an open file description) is shared by `dup`, `dup2` and `fcntl(F_DUPFD)`; the last `close` of it ends the endpoint, which every task waiting on the network then rechecks. `O_NONBLOCK` is a flag of the object. |
| R-NET-PIPE | `pipe` and `pipe2` make a read end and a write end over one bounded byte queue (64 KiB). A read of an empty queue returns 0 once no write end is open; a write after the last read end closed is EPIPE and raises SIGPIPE (R-NET-SIG). |
| R-NET-SOCK | `socket` accepts AF_UNIX, AF_INET, AF_INET6 with SOCK_STREAM or SOCK_DGRAM. `bind` records the address (port 0 takes the next free port from 49152; EADDRINUSE when another socket of the same type holds an overlapping address, unless both set SO_REUSEADDR and neither listens; AF_UNIX binds create an entry in the in-memory filesystem, EADDRINUSE if the path exists). `listen` readies the socket (an unbound one gets a wildcard address and a port). `connect` to an address a listening socket of the run accepts makes the connected pair at once and queues the server end for `accept`; with the backlog full a blocking connect parks and a non-blocking one fails ECONNREFUSED. An accepted socket has the listener's local address and inherits `O_NONBLOCK` as BSD does. `socketpair` makes two connected AF_UNIX sockets. `getsockopt(SO_ERROR)` reports and clears a pending error; other options read back what `setsockopt` stored. |
| R-NET-ADDR | The world is closed: the loopback interface (127.0.0.0/8, ::1) and the wildcard addresses are all that exist. A bind to any other address is EADDRNOTAVAIL; a connect to a loopback or wildcard address nobody listens on is ECONNREFUSED, to any other address ENETUNREACH. A listener bound to an IPv4 or IPv6 wildcard accepts a connect to any local address of its family, and an IPv6 wildcard also accepts IPv4. `getaddrinfo` knows `localhost` (`::1` then `127.0.0.1`) and numeric addresses; any other name is EAI_NONAME. `sockaddr` bytes use the host OS's layout (std chose the platform arm). |
| R-NET-IO | A stream socket is two bounded byte queues (64 KiB each). A read returns what is queued, up to the count, never waiting for more; 0 when the queue is empty and the peer has closed or shut down its write side; a write queues as much as fits and, on a blocking socket, goes on after each wake until all of it is queued, on a non-blocking one returns the part written or EAGAIN. A write when the peer's end is closed is EPIPE (R-NET-SIG). `shutdown` ends one direction. |
| R-NET-DGRAM | A datagram socket delivers each `sendto` whole to the datagram socket bound to the destination, or drops it when there is none; `recvfrom` returns the oldest datagram, cut to the buffer, with the sender's address. |
| R-NET-BLOCK | A call that cannot finish (an empty read, a full write, `accept` with nothing queued, `poll` with nothing ready, `pthread_join` of a running thread, a held mutex, a condition wait, a sleep once the program has threads) parks the calling task (R-TASK-PARK) on the network's wait list and is woken by any change to a descriptor, then rechecks. A non-blocking descriptor returns EAGAIN instead. The std functions green IO calls to wait (`schedulerWaitRead`, `schedulerWaitWrite`) park the same way until the descriptor is ready; the first such wait makes the scheduler allocate its table of fd waiters, one more block it leaves behind when main returns or exits with tasks left (R-TASK-ABANDON), and `exit` from a task leaves the scheduler and the other tasks as main returning does. Without the task interpreter the call is S-DEADLOCK, except one with a timeout, which moves the clock by it and times out. |
| R-NET-POLL | A descriptor is readable when it has queued bytes, is at end of file, has a pending connection (a listener) or a datagram; writable when its outgoing queue has room (a pipe or socket whose reader is gone is an error, and writable); a file is always ready. `poll` reports these in `revents` (POLLIN 1, POLLOUT 4, POLLERR 8, POLLHUP 16, POLLNVAL 32) and, with nothing ready, parks until some descriptor changes or the timeout (virtual milliseconds, R-TIME) ends. |
| R-NET-SIG | `signal` records a handler (a function pointer, SIG_DFL 0 or SIG_IGN 1) and returns the previous one; SIGKILL and SIGSTOP cannot be set. `raise` and `kill` to this process (pid 4242, 0 or its negative) run the handler at once, in the sending task, with the signal number; with SIG_IGN or a default that ignores (SIGCHLD, SIGURG, SIGWINCH, SIGCONT) nothing happens; any other default ends the program as killed by the signal, exit status 128 + the signal, with no drops (S-PANIC-ABORT). `kill` of another pid is ESRCH. `sigprocmask` keeps a mask; a masked signal waits and is delivered when it is unmasked. |
| R-NET-THREAD | `pthread_create` runs the start routine, called by name with its argument, as one more task (R-TASK-BLOCKING): it does not run until the creator parks, yields or ends (R-TASK-SPAWN), and a panic in it ends the program. The `pthread_t` is the task's number. `pthread_join` parks until it has ended and stores its return value; a thread nobody joins is abandoned when main returns. Under the plain interpreter `pthread_create` asks for the task interpreter. |
| R-NET-MUTEX | A `pthread_mutex_t` is an interpreter object keyed by the address of the memory the program gave (a zeroed one is an unlocked mutex). `lock` takes it or parks while another task holds it; `unlock` releases and wakes the waiters, who recheck in the order they parked; `trylock` returns EBUSY. `pthread_rwlock_*` is the same with many readers or one writer. |
| R-NET-COND | `pthread_cond_wait` releases the mutex, parks until a signal or broadcast reaches it (`signal` wakes the longest waiter, `broadcast` all), then takes the mutex again. The timed forms give up after the span (darwin: relative `timespec`; linux: absolute against the wall clock, R-SYS-CLOCK) and return ETIMEDOUT, still holding the mutex. |
| R-NET-SLEEP | `usleep`, `sleep` and `nanosleep` park the task for that many virtual milliseconds (R-TIME) once the program has created a thread, so others run meanwhile; before that they advance the clock and return (R-SYS-CLOCK). |
| R-NET-KQUEUE | `kqueue` makes a descriptor holding a set of watches; `kevent` applies its change list (EV_ADD, EV_DELETE, EV_CLEAR, EV_ONESHOT) and returns up to `nevents` watches that are ready: EVFILT_READ and EVFILT_WRITE by the readiness of R-NET-POLL (level-triggered), EVFILT_USER once NOTE_TRIGGER has fired it (reset on delivery). With none ready it parks as R-NET-BLOCK until a change or the timeout; `ident` and `udata` come back as given. |
| R-SELECT | `Select` is a native. Arms are kept in the order armed. `wait` returns the index of the first ready arm and parks until one is: a recv arm is ready when its channel holds a value or is closed, a send arm when it has room or is closed, an fd arm when a read (write) would not block (R-NET-POLL), a timer arm when the virtual clock has reached its deadline (set when armed, R-TIME). The value is fetched afterwards by the caller; an arm keeps its channel alive until the Select is dropped. A Select owns four heap blocks (three for its state, one for its nodes) and each channel arm one more, as in a compiled run (R-TASK-ABANDON counts them when a task is left in one). `ensureTimersLive` does nothing: the task interpreter always has a scheduler. |
