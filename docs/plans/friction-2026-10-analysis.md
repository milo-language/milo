<!-- doc-meta
system: planning
purpose: root-cause analysis of each item in friction-2026-10.md, with the root fix, blast radius, gate, effort, and an execution order
key-files: src/checker.ts (expectedTypeOf, checkExprWithHint, checkIfExprExpr, bodyAlwaysReturns, mergeMoveState, checkClosureExpr, declare), src/checker-program-passes.ts (closure escape pass), src/resolver.ts (per-module rename, duplicate-type), std/process.milo, std/runtime.milo
update-when: an item is fixed, a step of the execution order lands, or the owner decides one of the open questions
last-verified: 2026-10-06 (every repro below run on main 5ea6e0b5; execution-order steps 1-4 landed on branch friction-1, steps 5-6 on friction-2, steps 7-9 on friction-3)
-->

# Friction 2026-10: analysis and root fixes

Item numbers are those of [friction-2026-10.md](friction-2026-10.md). Repros live in
`/private/tmp/fr` while this was written; each one that should become a fixture says so.
Line numbers are main at 5ea6e0b5. Effort: S hours, M a day, L several days.

Two items turned up bugs worse than the friction they were filed for:

- **Item 4: a move on a path that ends in `break` or `continue` is invisible.** Use after
  move and double move through a loop compile clean and run with an empty value.
- **Item 2: a by-reference closure assigned to an outer-scope local outlives its captures**
  (prints `0` for `40`). This has to be closed before captures of references are allowed.

## Ranking

Score = (bugs prevented x how often hit) / cost. Highest first.

| rank | item | root cause | root fix | effort | owner decision |
|---|---|---|---|---|---|
| 1 | 4 | divergence is a syntactic predicate (`bodyAlwaysReturns`) that counts `break`/`continue` as "never falls through" and that 6 join sites each call | one control-flow `Flow` record (fallthrough state or unreachable, plus break/continue states per loop) and one `join()`; a `never` type for diverging blocks | step A S, full M-L | no (the `never` type is a small yes/no) |
| 2 | 3 | the expected type travels in mutable fields (`returnHint`, `returnHintExpr`, `tailHints`, `closureParamHints`, `closureRetHint`); 4 readers bypass `expectedTypeOf` and see a hint meant for an ancestor | `checkExpr(expr, expected)`: expected type as a parameter; Option unwrap becomes a pure `hintFor(kind, expected)` | leak fix S, refactor M | no |
| 3 | 5 | `declare()` returns without binding on a same-scope redeclaration (checker.ts:2578); separately ~650 `this.error` sites each have to remember `isPoisoned` | bind the redeclaration; suppress at the `error()` sink any diagnostic that renders `<unknown>` once an error exists | S | no |
| 4 | 2 | `checkClosureExpr` rejects every reference capture (checker.ts:10459) because closure literals passed to fn params are auto-promoted to `move` (9446, 9681) | plain fn-typed params are non-escaping (second-class, like refs); only `move` params escape; a by-ref closure may capture refs and `self` | M (+S prerequisite) | **yes** |
| 5 | 1 | resolver renames a private user name only when another USER module declares it (resolver.ts:598-646); std pub types are never in the collision index | count non-prelude std pub type names in the index; rename the user's private type when its file does not import the std one | S-M | **yes** (scope: types only now, std pub per-module later) |
| 6 | 9 | `Child` fields not `_`-private; Windows `close` safe pub fn; `@pure` exemption unchecked | `_`-prefix the fields + constructor; make Windows `close` an `unsafe`-requiring extern wrapper like the others; `@pure` exempt only for all-scalar signatures | S | no |
| 7 | 8 | builtins and program fns share one `functions` map (checker.ts:3050, 3101); a pub std decl named like a builtin replaces it program-wide | rename std/os `exit` extern (`@cName("exit")`), and gate: no std `pub` name equals a builtin | S | no |
| 8 | 7 | no lint; the redundancy test needs the expected type at the cast, which only item 3 makes available | `redundant-cast` warning + `milo fix` rewrite, after item 3 | S after item 3 | no |
| 9 | 6 | fds are `i32` (Copy) through 69 std pub fns; `Task.spawn` takes `move () => void`, so a task cannot borrow its owner | short term: owning fd types end to end (OwnedFd landed 6e01a631); long term: `Task.scope` | S-M per API; scope L | **yes** |

## Item 1: type names share one namespace across modules

**Repro** (main, `check p1.milo`; the user file never imports `Process`):

```
error: 'Process' is defined as a struct in 'p1.milo' and as a struct in 'std/process.milo'
  ──> std/process.milo:99:5
  hint: Milo merges every module into one flat namespace, so a type name has exactly one meaning program-wide ...
```

**Root cause.** Name resolution is already per-module; the merge is not. The per-module
rename pass (resolver.ts:596-646) builds `declCount` from `userUnits` only and renames a
private user name only when `declCount >= 2`. std pub names are deliberately left out (the
`stdNames` comment at 612: user-vs-std shadowing keeps the `shadows-stdlib` diagnostics).
So the user's private `Process` is not renamed, and the duplicate-type check
(resolver.ts:832-848) fires on the flat names. That rationale is about fns, where
"override a std fn" is a real (warned) behaviour; a type has no override semantics, any
body difference is already a hard error.

**Root fix.** In the rename plan, add to `declCount` the TYPE names of every non-prelude
std unit. A private user type whose name a std type also declares is renamed (same
`restrictToDecls` path stage 1 uses), unless the user file imports that std name (then it
is a genuine ambiguity and the current error stays). Prelude types (`Option`, `Result`,
`Vec`, ...) stay errors (`redeclareBuiltinOption` fixture). Display names already map
mangled names back (stage 3), so diagnostics and `print` are unaffected. Roughly 15 lines
in resolver.ts.

Not covered by that: a user `pub` type of the same name (needs importer bindings rewritten;
`manglePackage` can do it, stage-1 chose not to) and std pub FNS (a new std pub fn can
still break a user private fn of the same name via `shadows-stdlib`).

**Alternatives.** (a) Mangle std pub names per module (stage 5 of module-namespaces.md):
removes the class for fns, types and item 8 together, but `milo api`, `milo doc` and
docs/breaking-changes.md index std by flat names; L. (b) Status quo plus rename hint: no.

**Owner decision.** Whether std pub names stay flat. Recommendation: land the type-only
rename now (it removes the case that bites: std adding a type), and schedule stage 5 only
when a std pub FN collision is actually reported.

**Blast radius.** None for programs that compile today (only previously rejected programs
change). Gate: `tests/fixtures/userTypeNamedLikeStd.milo` (p1, `@expect: 1`, fails today);
an error fixture where the user file imports `Process` AND declares it (must stay an
error); the `MILO_MANGLE_ALL=1` fixture run. **Effort** S-M.

## Item 2: closures cannot capture references, including `self`

**Repro** (`check p2.milo`):

```
error: cannot capture 'self' in a closure
  ──> p2.milo:4:25
  hint: 'self' is a reference ... a closure can outlive the storage this points into; capture an owned value (.clone() it) instead
```

Related behaviour found while mapping the rule:

```
// p2d: non-move closure that only READS v, passed to apply(f: () => i64)
let n = apply((): i64 => v.len)
print(v.len.toString())        // error: use of moved variable 'v'
```

**Mechanism.** Two halves:

- checker.ts:10455-10462 (`checkClosureExpr`): any capture whose binding type is `ref`
  errors, for move AND by-ref closures.
- checker.ts:9681-9684 (plain call) and 9446-9452 (generic call): a closure LITERAL passed
  to any fn-typed param is silently made `move` (unless it mutates a capture). So the
  checker cannot know whether a closure will be stored, and treats every argument closure
  as owning storage. That is why the p2d read moves `v`.

Escape of by-ref closures is already analysed separately, after checking, in
checker-program-passes.ts:195-345 (`retainsParam`, `check`): returning, storing in a
struct/array/field/global, or passing to a retaining callee is rejected. So a by-ref
closure provably lives no longer than its frame, and a reference capture into it would be
sound, except for the hole below.

**Hole found (must fix first).** checker-program-passes.ts:266-268: "Assigning to a bare
local is fine, the local dies with the same frame". Scope, not frame, is the lifetime:

```milo
var f: () => i64 = (): i64 => 0
if cond() {
    let s = "a string long enough to live on the heap".clone()
    f = (): i64 => s.len
}
print(f().toString())     // prints 0; same program without the `if` prints 40
```

Compiles clean, runs with a dropped capture (silent wrong value; `--sanitize` quiet because
the slot is zeroed, not freed). Fix: in the `Assign` arm, a by-ref closure assigned to a
local declared in a scope enclosing a captured binding's scope is `cannotStore`. Fixture:
`tests/errors/byRefClosureOutlivesScope.milo`, fails today. S.

**Root fix.** Make escape a property of the parameter type, Swift-style, which Milo already
half has: `move (A) => R` (owning, std/runtime.milo:432 `Task.spawn`) vs `(A) => R`.

1. A plain `(A) => R` parameter is second-class, like a `&T`: the callee may call it or
   pass it to another plain fn param; storing, returning, pushing it, or capturing it in a
   `move` closure is an error IN THE CALLEE (local check, replaces `retainsParam`'s
   whole-program walk for params).
2. At the call site, a closure literal passed to a plain fn param stays by-reference; the
   auto-move at 9446/9681 applies only to `move` params.
3. The ref-capture error at 10459 applies only to `move` closures. A by-ref closure may
   capture `self`, `&T` params and views; the existing escape pass plus the scope fix keep
   it inside the borrow's lifetime. The capture freezes the referent as a ref binding does.

Size: ~150 lines across checker.ts (call paths, closure check, a new "fn param escapes"
check) and checker-program-passes.ts (param retention becomes a signature fact).

**Alternatives.** (a) Keep inference: call `retainsParam` during checking to decide
auto-move. Non-local (a callee edit changes the caller's ownership), and unsound when the
callee is not yet checked (`closureCaptures` empty for it). (b) Allow ref capture only for
closure literals directly in argument position: covers the dapweb case, leaves `let f =`
bindings and sort comparators stored in locals out, and is one more special case.

**Owner decision.** Whether plain fn params become non-escaping by default (the language
answer to "may closures capture borrows"). Recommendation: yes. It matches
local-reasoning-2026-09.md (signatures, not bodies, decide ownership) and refs being
second-class.

**Blast radius.** std has 43 fns with fn-typed params, 5 already `move`. Retaining ones
need `move` in the signature: the std/http router registration fns (http.milo:677-707),
`serve`/`serveTls` if they store the handler, std/sync.milo:1264, runtime.milo:683
(each to be confirmed by the new callee check, which lists them). Callers are unaffected
(literals to a `move` param are already moved). Behaviour change: closures passed to
non-retaining params stop moving their captures (p2d becomes legal; the env goes on the
stack, not the heap). Gates: fixtures p2 (`self` capture through `apply`), a sort
comparator capturing a `&Vec`, std/ws reverted to a method using `sealedWith`; error
fixtures: storing a plain fn param, `move` closure capturing a ref (still an error);
`bun run scripts/run-examples.ts`, `fuzz:tasks`, ASan sweep. **Effort** M, plus S for the
scope hole.

## Item 3: expected-type propagation is a side channel

**State today.** The hint is passed in five mutable fields:

| channel | where set | where read |
|---|---|---|
| `returnHint` + `returnHintExpr` | `checkExprWithHint` (checker.ts:8646-8652), saved and restored around `checkExpr` | `expectedTypeOf` (7287, exact node match): generic static calls 7232, 7268; if 11889; match 11946. **Raw `this.returnHint`** (no node match): generic method inference 2445, generic fn inference 9421, if-arm int retype 11922, match-arm int retype 11959 |
| `tailHints: Map<Expr,TypeKind>` | if 11893, match 11950 (queue the if/match's expected type on each branch tail) | top of `checkExpr` 8682: pops it and re-enters `checkExprWithHint` |
| `closureParamHints`, `closureRetHint` | `checkExprWithHint` 8641-8644 | `checkClosureExpr` 10386-10389 |
| Option unwrap | `checkExprWithHint` 8506-8509: an `Option<T>` hint becomes `T` unless the expr is EnumLit, IfExpr, MatchExpr | |

`checkExprWithHint` is called from 73 sites (let/var 6070/6126, assign 6257, return 6303,
call args 5500/9495/9606/10032, struct fields 9745/9847, enum payloads 8616/10253, array
elements 8579/8590, `??` rhs 10332, every Vec/HashMap/Option builtin method arg 10573-11534).

**Positions probed** (`Option.None` and generic `makeVec<T>()` need the hint; u8 literals
show retyping):

| position | today |
|---|---|
| call arg, method arg, struct field, enum payload, array/Vec element, `??` rhs, assign, field/index assign | ok |
| closure expr body, closure block `return`, closure passed as arg, closure returned | ok |
| `return if`, `return match`, if/else-if chain, match inside if, if inside array/struct/`Some` | ok |
| nested if inside match inside call arg | ok |
| generic call in if arm, match arm in call arg, `??` rhs, struct field | ok |
| binop sibling: `let b = a + (if c { 1 } else { 2 })`, `a: u8` | `error: type mismatch in '+': u8 vs i64` |
| comparison sibling: `o == Option.None` | `error: cannot infer type parameter(s) 'T' for Option.None` |
| **hint leak**: `let n: u8 = (if c { 300 } else { 1 }).toString().len as u8` | `error: integer literal 300 overflows u8 (range 0..255)` (false positive) |

So coverage is good because 73 call sites each pass the hint by hand; the defects are the
four raw `this.returnHint` readers (the leak above is 11922: the `u8` belongs to the `let`,
three levels up) and positions where the expected type comes from a sibling, not a parent.

**Root fix.** `checkExpr(expr: Expr, expected: TypeKind | null = null)`; `checkExprWithHint`
becomes `checkExpr` (the 73 sites already pass a hint, so they are a rename). Delete
`returnHint`, `returnHintExpr`, `tailHints`, `closureParamHints`, `closureRetHint`,
`expectedTypeOf`. The dispatcher hands `expected` to the arms that consume it: Call
(9421), MethodCall (2445), EnumLit (7232, 7268), IfExpr/MatchExpr (pass to
`checkValueBody` -> tail expr, replacing tailHints), Closure (param/ret hints), literals,
ArrayLit/ArrayRepeat, StructLit. The Option rule becomes a pure function
`hintFor(expr.kind, expected)` applied in exactly one place, at the leaf, so if/match no
longer need an exemption. A child checked with plain `checkExpr(child)` gets `null` by
construction: no leak is possible. Binop/comparison: check the non-literal side first and
pass its type as `expected` to the other (synthesis then check); this is what
`isConstIntExpr` retyping approximates today. ~300 lines touched, mostly mechanical.

**Alternatives.** (a) Replace the 4 raw reads with `expectedTypeOf` only: fixes the leak
(S), keeps the side channels; the right first commit, not the end state. (b) Full
constraint-based inference: out of proportion for a language that annotates fn signatures.

**Blast radius.** Intended zero behaviour change apart from the leak and the two sibling
positions. Gate: the full fixture suite, `run-examples`, error fixtures unchanged; new
fixtures `ifHintNoLeakThroughCast.milo` (fails today), `binopSiblingHint.milo`,
`eqOptionNone.milo`. **Effort** S (leak) then M.

## Item 4: move-state merging at control-flow joins

**Repros.** Accepted today, and run with the moved value empty:

```milo
// a2: move on the break path, use after the loop. Prints "" for s.
while n < 3 { n = n + 1
    if n == 1 { take(s)
        break } }
print(s)
// b2: move on the continue path runs twice. Second take prints "".
for i in 0..3 { if i < 2 { take(s)
    continue } }
```

Same for `while let ... { take(s); break }`, `if c { take(s); if c { break } else { break } }`
and a `match` arm `{ take(s); break }` inside a loop. `--sanitize` is quiet (moved-from
slots are zeroed), so this is "wrong value, no diagnostic", not a crash.

False positive: `if !cond() { take(s); exit(1) }; print(s)` gives `use of moved variable 's'`
(a call that does not return is not divergence). Related typing gap:
`let n = if c { take(s); return 0 } else { 1 }` is `if-else branches have mismatched
types: 'void' vs 'i64'`.

Correct today: if/match arms that `return`, let-else, match nested in let-else, `if let`
with return, match-expression arm returning, return inside a loop, `return` inside a
closure body (not counted as the outer fn's).

**Join sites.** Each is hand-written snapshot/restore/merge with its own divergence test:

| site | lines | divergence handled |
|---|---|---|
| if stmt | 6334-6356 | `bodyAlwaysReturns` per branch |
| if-let stmt | 6684-6692 | `bodyAlwaysReturns` |
| let-else | 6697-6720 | `bodyAlwaysReturns` (fixed 281d0774) |
| match stmt/expr (`checkMatchLike`) | 12372-12411, 12429-12515 | `bodyAlwaysReturns` per arm |
| if expr | 11888-11913 | **none** (both arms merged; unreachable today only because a diverging arm does not type) |
| while / for range / for-in variants / while-let | 6365-6373, 6397-6406, 6439-6510, 6562-6571, 5864-5880 | `checkLoopMoves` + `returnOnlyMovesStack`/`inReturnInLoop`; no break or continue state |

**Root cause.** `bodyAlwaysReturns` (checker.ts:6934) answers "does control fall through
to the statement after this block", and returns true for `break`/`continue` (6937). That
is right for the if-statement's join, but the moves on that path are then DISCARDED: a
`break` path's state never reaches the loop's exit join, and a `continue` path's state never
reaches `checkLoopMoves` (the next-iteration check). The predicate is also syntactic: no
calls (`exit`), no nested blocks beyond if/match.

**Root fix.** One place for joins:

- `this.reachable: boolean` and, per loop, `breakStates[]` and `continueStates[]` on a
  loop frame stack. `return` sets `reachable = false`. `break` pushes the current
  snapshot to `breakStates` then sets `reachable = false`; `continue` likewise. A call
  whose return type is `never` (builtin `exit`, a `@noreturn` fn) sets it too.
- `join(states)` merges only reachable states; if none, the result is unreachable. Every
  site in the table becomes: snapshot, check each arm, collect `(state, reachable)`,
  `join`.
- Loop exit state = `join(condition-false state, ...breakStates)`. The re-entry check
  (`checkLoopMoves`) compares `join(end-of-body, ...continueStates)` against the pre-state;
  `returnOnlyMovesStack`/`inReturnInLoop` disappear (a return path is simply unreachable).
- A block whose end is unreachable has type `never`, which unifies with any arm type: the
  if-expression typing gap closes with the same flag.
- `bodyAlwaysReturns` remains only for non-move uses (fall-off-the-end diagnostics), or is
  replaced by the same flag.

**Alternatives.** (a) Patch: give `bodyAlwaysReturns` an `exitsLoop` mode and add break
merging to each loop: that is step A below, worth landing alone because it closes the
wrong-value bug in S. (b) A real CFG over the AST (dataflow on basic blocks): more general,
L, and the structured AST makes it unnecessary.

**Owner decision.** Only whether `never` becomes a (possibly internal-only) type and
`exit` is declared to return it. Recommendation: internal `never`, no surface syntax yet.

**Blast radius.** Programs that move on a break/continue path and use after become
errors (they were wrong). Grep cannot find these reliably; `run-examples` and the org
corpus (`bun scripts/corpus-census.ts` sweep) are the estimate. Gate: error fixtures
`moveOnBreakUsedAfterLoop.milo`, `moveOnContinueLoopsAgain.milo`,
`whileLetBreakMove.milo` (all three accepted today); fixtures `exitDivergesMoves.milo`,
`ifExprReturnArm.milo`. **Effort** step A S, full M-L.

## Item 5: error cascades

**Repro** (`check p5.milo`):

```
error: variable 'args' already declared in this scope   (p5.milo:3:5)
error: type 'i64' has no method 'push'                  (cascade)
error: cannot access field 'len' on type i64            (cascade)
```

**Root cause.** checker.ts:2574-2579: `declare()` reports a same-scope redeclaration and
`return`s before `scope.set`, so later uses bind to the FIRST declaration. The
outer-shadowing branch just below (2594-2601) reports and then binds, and produces no
cascade: the same function already has the right policy on one branch.

General recovery: poisoning to `unknown` exists (`isPoisoned`, 904), but each of ~650
`this.error` sites must remember to check it. Measured over the 453 error fixtures: 392
report exactly 1 error, 48 report 2 or more, 5 of them cascade on `<unknown>` (e.g.
genericVoidArg: 9 errors, `'?' requires Option or Result type, got <unknown>`;
nullableRefNotUnwrapped: `cannot access field on non-struct type <unknown>`).

**Root fix.** (1) Bind the new declaration after reporting (move `scope.set` above the
`return`, keep the diagnostic). (2) Enforce the poison policy at the sink, not at 650
sites: `show(t)` of an `unknown` sets a per-diagnostic flag; `error()` drops a diagnostic
whose message or hint rendered `<unknown>` when an error was already reported. (3) Policy
stated in the checker header: an erroneous declaration still binds; an erroneous
expression is `unknown`; nothing reports about `unknown`.

**Alternatives.** Per-site `isPoisoned` checks (status quo, does not scale); a
`TypeKind` `error` tag distinct from `unknown`: cleaner but touches every switch.

**Blast radius.** Fixtures pin one message with `@error:` (contains), so dropping
cascades breaks none; the error catalog may lose a cascaded message (regenerate). Gate:
p5 as `tests/errors/redeclareSameScopeNoCascade.milo` plus a test asserting it reports
exactly 1 error (fails today: 3); a count in `checkerRecovery.test.ts` that the number of
error fixtures with >1 error does not grow (48 today). **Effort** S.

## Item 6: resource ownership is not typed

**State.** `Task.spawn(f: move () => void)` (std/runtime.milo:432) requires an owning
closure, so a helper task gets copies; an fd is `i32` (Copy) and 69 std pub fns take
`fd: i32`. The extern-unsafe work landed (f77bdc93) and `OwnedFd` (std/io.milo:545,
`_fd` private, closes on drop) exists since 6e01a631. Nothing makes "writer task outlives
owner" a compile error: the dapweb crash was a Copy `i32` in a `move` closure.

**Root fix, two layers.**
1. Ownership: an fd held by app code is an `OwnedFd` (non-Copy); sharing it with a task
   is either a move (owner gives it up) or an explicit `dup()` (two real fds, no reuse
   race). Migrate std's pub socket/pipe APIs from `i32` to owning types, keeping `i32`
   only behind `unsafe`. This makes the dapweb bug a "use of moved variable" or a
   harmless second fd. S-M per module (net, ws, process, pty).
2. Structured concurrency: `Task.scope((s) => { s.spawn(() => ...) })` joins every task
   before returning, so spawned closures may borrow locals from outside the scope. Needs:
   a closure kind whose env is heap-owned (outlives the body frame) but may hold
   references to bindings declared outside the `Task.scope` call; the checker must also
   treat a borrow shared with a task on another OS thread (M:N scheduler) as needing a
   Sync-like check, which Milo does not have. L.

**Owner decision.** Whether to add `Task.scope` (and a thread-sharing rule) or stay with
`move` + owning handles + `join`. Recommendation: do layer 1 now; defer `Task.scope`
until item 2's non-escaping params land, since a scoped spawn is the same "callback may
borrow, cannot escape" rule extended to a join point.

**Blast radius.** Layer 1: every std caller of the migrated APIs (grep `fd: i32` in 26 std
files) and dapweb. Gate: a fixture that moves an `OwnedFd` into a task and uses it after
(error), and the dapweb writer pattern rebuilt on OwnedFd under `--sanitize`. **Effort**
S-M per module; scope L.

## Item 7: stale idioms the compiler could teach

**Repro.** `(0 as i64)` and `?? (-1 as i64)` compile and are no-ops. Counts: 43 literal
`as i64` casts in dapweb, 12 in std+examples, 49 more literal casts to other widths in
std+examples (some of which are the only type source and are needed).

**Root cause.** No lint. A cast of a literal is redundant iff the literal would get the
same type without it: target is `i64` (the default) with no expected type, or the
expected type at the cast equals the target. Today the expected type at an arbitrary
position is not reliably available (item 3).

**Root fix.** After item 3: in the `as` arm, `if (isLiteral(expr.expr) && (expected ? typeEq(expected, target) : isI64(target)))`
warn `redundant-cast` with a `fix` in src/fixes.ts (delete `(`, ` as T`, `)`), so `milo fix`
rewrites it. Same pattern for sentinel idioms later (each needs its own detector; not
worth a framework).

**Blast radius.** Warnings only; std is held to zero warnings, so the first commit runs
`milo fix` over std/examples. Gate: a fixture with the warning, a `milo fix` test that
rewrites it and re-checks clean. **Effort** S after item 3.

## Item 8: imported names collide with builtins

**Root cause.** Builtins are entries in the same `this.functions` map as program fns
(checker.ts:3050 registers `exit`); `builtinFnNames` (3101) exists only to exempt them in
the visibility pass. A std pub decl with a builtin's name replaces the builtin for the
whole program. Comparing the builtin registrations with std pub fn names finds two:
`exit` (std/os.milo:269 `pub extern fn exit`) and `assert` (std/testing). The extern-call
rule special-cases `exit` (checker.ts:1381).

**Root fix.** (1) std/os: `@cName("exit") pub extern fn osExit` or drop the pub extern
(the builtin covers it); remove the `name === "exit"` exemption. (2) A gate test: no std
`pub` name equals a builtin name (fails today on `exit`). `assert` in std/testing:
decide whether it IS the builtin (then delete the std one) or rename. The general fix
(builtins as a lowest-precedence scope consulted after a file's own decls and imports) is
the same per-module change as stage 5 of item 1 and should ride with it, not before.

**Blast radius.** Callers of std/os `exit` by import (grep `import` lists naming `exit`).
**Effort** S.

## Item 9: ownership holes the extern-call work exposed

- `Child` (std/process.milo:164) fields are not `_`-prefixed, so
  `Child { pid: 999999, stdinFd: -1, stdoutFd: -1, stderrFd: -1 }` checks clean from
  another file (`p9.milo: ok`). Field privacy exists (`checkFieldPrivacy`, checker.ts:9875,
  `_` prefix). Fix: rename to `_pid` etc., add accessors. Class fix: a struct that owns an
  OS resource has `_` fields; enforce with a std lint "pub struct with a Drop impl or an
  unsafe-consumed handle field has a non-private field" (Child has no Drop today, so it
  should get one or be marked). S.
- std/platform.windows.milo:748 `pub fn close(fd: i32): i32` is safe and pub while the
  POSIX arms export `pub extern fn close` (which now needs `unsafe`). Fix: make the Windows
  arm match (private wrapper behind an unsafe extern), and gate: every platform arm exports
  the same pub surface with the same safety (a test comparing arms). S.
- `@pure` externs are exempt from the extern-call rule (checker.ts:1381) on trust. All 18
  `@pure` externs in std/math are all-scalar today. Fix: the exemption applies only when
  every param and the return are scalar; a `@pure` extern taking a pointer needs `unsafe`
  like any other. Zero blast radius today; gate: an error fixture with a pointer-taking
  `@pure` extern called outside `unsafe`. S.

## Execution order

Small landable steps, each with its gate, highest score first.

1. **Done debc39dd.** Item 4 step A: break/continue states. Loop frames collect break/continue snapshots;
   loop exit joins break states; `checkLoopMoves` sees continue states. Three error
   fixtures above (fail today). S. As landed: `loopFrames` + `beginLoopMoves`/`endLoopMoves`
   in checker.ts. The exit state also joins the pre-loop state (the condition can end the
   loop before the body runs; `while true`/`while let` excepted), so a re-assignment inside
   a `for` body no longer revives a value moved before the loop
   (`moveReassignedOnlyInLoopBody`). `bodyAlwaysReturns` still drops break/continue paths at
   if/match joins, which is right there now that each break/continue records its state at
   the statement. Also removes the false positive "cannot move out of a loop" on a move
   right before a top-level `break` (`moveThenLeaveLoop`). Fixtures: `moveOnBreakUsedAfterLoop`,
   `moveOnContinueLoopsAgain`, `whileLetBreakMove`, `moveOnBreakInMatchArm`.
2. **Done 6c1084f5.** Item 3 leak: the four raw `this.returnHint` reads go through the expected-type
   accessor. Fixture `ifHintNoLeakThroughCast` (fails today). S.
3. **Done 505e484b.** Item 5: bind on redeclare; `<unknown>` sink suppression; cascade-count test. S.
   As landed: the sink keys on `UNKNOWN_TYPE_NAME` (types.ts) in message or hint. The
   cascade ratchet lives in tests/run.test.ts's error lane (it reuses that lane's compiles),
   `MAX_MULTI_ERROR_FIXTURES = 45` (48 before: aliasTakesNoTypeArgs, cyclicTypeAlias and
   cyclicGenericAlias dropped to one error, genericVoidArg 9 to 3, nullableRefNotUnwrapped
   3 to 2). Exactly-one-error checks in tests/checkerRecovery.test.ts.
4. **Done 66bdf9f3.** Item 2 prerequisite: scope-level escape in the `Assign` arm. Fixture
   `byRefClosureOutlivesScope` (fails today). S. As landed: the escape pass tracks the block
   depth of locals (let/var, loop vars, closure params, pattern bindings). It found a real
   instance in std: `Router.handle` (std/http.milo) built its middleware chain from
   by-reference closures over loop-body locals, so two or more middleware recursed forever.
   The links are `move` now (fixtures `httpRouterMiddlewareChain`, `byRefClosureOutlivesLoopBody`).
5. **Done 9b7ac2bb (item 9), 3047871c (item 8).** Item 9 as landed: `Child` and `Process`
   (both arms) have `_`-private fields and `pid()`/`stdinFd()`/`stdoutFd()`/`stderrFd()`
   accessors (error fixtures `childForgedFromPid`, `childForgedPrivateFields`; java-dap's
   placeholder `Child` went in 5cd52b5b, dapweb's three forged ones in its own
   `friction-2` branch). Windows `close` is `@unsafe`; tests/platformParity.test.ts now
   requires a Windows Milo shim of a posix `pub extern` to be `@unsafe`, with the 36 shims
   not yet aligned (read, write, mmap, the pthread family, ...) in a shrink-only
   `SAFE_WINDOWS_SHIMS` ratchet. `@pure` exempts an extern only when every param and the
   return are scalar (tests/externCall.test.ts). Found on the way, not fixed: `Child` is
   Copy (all-`i32` fields), so a copy can `close()` fds the original still uses; it wants
   a Drop or a non-Copy marker. Item 8 as landed: `std/os.exit` and `std/testing.assert`
   are removed rather than renamed (the builtins are the same operation), the extern-call
   `exit` exemption is gone, and tests/stdBuiltinNames.test.ts gates std pub fn names
   against the checker's builtins. The observable bug was `assert`: importing anything
   from std/testing turned the builtin `assert(cond, msg)` into a bare "assertion failed"
   (runtime-error fixture `builtinAssertWithStdTesting`).
6. **Done 4bb78061.** Item 1 type-only rename of private user types colliding with std
   types. As landed: `stdPubTypes` in resolver.ts (non-prelude std type names minus the
   ones stage 4 renamed); a private user type in it is renamed unless the file imports
   that name. Fixtures `userTypeNamedLikeStd` (passes under `MILO_MANGLE_ALL=1` too),
   errors `pubUserTypeNamedLikeStd` and `userTypeShadowsImportedStd`.
7. **Done 8b999fc6.** Item 3 refactor: `checkExpr(expr, expected)`, delete the five side
   channels, sibling hints for binop/comparison. M. As landed: `checkExprWithHint` is
   `checkExpr`; `returnHint`, `returnHintExpr`, `tailHints`, `closureParamHints`,
   `closureRetHint`, `expectedTypeOf` and `valueTails` are gone. The dispatcher
   (`checkExprKind`) hands `expected` to Call, MethodCall, EnumLit, Closure, IfExpr,
   MatchExpr (and, since step 9, CastExpr and UnaryOp); `hintFor` is the one Option-unwrap
   rule; an if/match passes it to each arm tail through `checkValueBody` -> `checkStmt`'s
   `valueTail`. Binop: an if/match/enum-literal operand is checked against the other
   operand's type (an argument-less enum literal on the left is checked second). Making
   `o == Option.None` type was not enough, since `==` on an enum with payloads was an
   error; it is now the tag test `o is Option.None` when one side is a payload-free
   variant literal (`variantTagCompares`, lowered to `IsCheck`). Fixtures
   `binopSiblingHint`, `eqOptionNone` (both fail on 083b5a34); error `eqPayloadVariant`.
8. **Done 5374137b.** Item 4 full: `reachable` flag, single `join`, internal `never`, `exit`
   diverges, if-expression arms may diverge. M. As landed: `this.reachable`, cleared by
   return/break/continue, a `never`-typed expression (builtins `exit` and `todo` return
   `never`) and a loop with no reachable exit; `joinPaths`/`checkPath` are the one join for
   if, if-let, match (stmt and expr) and the if expression, and `endLoopMoves` uses the
   flag for the end of the body. `returnOnlyMovesStack`/`inReturnInLoop` are deleted.
   `never` is a `TypeKind` tag the checker uses only: lowering's `typeOf` maps it to `void`,
   and an if whose arms both diverge stays `void`. `bodyAlwaysReturns` stays for the
   unreachable-code error and the let-else "must diverge" rule (so `let … else { exit(1) }`
   is still rejected). Fixtures `exitDivergesMoves`, `ifExprReturnArm` (both fail on
   083b5a34), error `moveOnArmBesideExit`.
9. **Done a99d99cb (lint), 650602c2 (std/examples).** Item 7 `redundant-cast` lint + fix,
   run over std/examples/dapweb. S. As landed: fires for an int/float literal (or its
   negation) cast to exactly the expected type, in range; not in a manifest dependency
   (std is held to zero, as for extern-call), not in a generic instance body, not on a cast
   first checked with no expected type (generic inference). `milo fix` drops the cast and
   its own parentheses, never a call's. Counts before/after: std 145/0, examples 84/0,
   dapweb 131/0 (dapweb branch `friction-3`; 8 of its hits sit inside `$"…{…}"`
   interpolations, whose diagnostics point at the string start, so `milo fix` declines
   them and they were edited by hand), src-milo 27 (left alone: a src-milo change is
   gated by the self-host fixpoint). Tests: tests/redundantCastLint.test.ts.
10. Item 2 non-escaping fn params (after owner decision). M.
11. Item 6 layer 1 per std module; `Task.scope` after 10 if the owner wants it. S-M each; L.

## Decisions for the owner

1. **Item 2: may closures capture borrows?** Recommend yes, via non-escaping plain fn
   params (escape only through `move` params), checked in the callee.
2. **Item 1/8: do std pub names stay flat?** Recommend flat for now; rename only private
   user types that collide with an unimported std type; revisit per-module std pub
   (stage 5) when a fn collision is reported.
3. **Item 6: structured concurrency?** Recommend owning fd types now; `Task.scope` after
   item 2, and only with a thread-sharing rule for the M:N scheduler.
4. **Item 4: internal `never` type and `exit` returning it?** Recommend yes, no surface
   syntax.

## Owner decisions (2026-10-06)

- Closures capturing references: yes, Swift-style. Plain fn params are non-escaping (a
  closure passed there may borrow locals and `self`); params that store or spawn the
  closure are marked `move`.
- Type names: rename a private user type that collides with an unimported std type; std
  pub names stay flat until a real function clash is reported.
- `never` type: yes, internal only (not user-writable syntax).
- `Task.scope`: after borrow-capturing closures land, with a rule for borrows across the
  M:N scheduler's OS threads designed first. Owned fd types now.
