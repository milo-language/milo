<!-- doc-meta
system: planning
purpose: friction found writing dapweb, each with a repro, to be fixed at the root rather than per instance
key-files: src/checker.ts (expectedTypeOf, checkExprWithHint, tailHints, move-state snapshot/merge, closure capture), std/os.milo, std/runtime.milo (Task)
update-when: an item is analysed, fixed, or found not to reproduce
last-verified: 2026-10-06 (repros for items 1, 2, 5 checked on main; item 7 checked: literal casts unnecessary)
-->

# Friction found writing dapweb (2026-10-05/06)

A night of large refactors in dapweb (server split, state struct, zero `unsafe`, UI
rewrite, five features) by several agents. Below is every place Milo cost time or let a
bug through, with a minimal repro checked against main on 2026-10-06. Goal: fix each at
its root so the class cannot recur, not patch the instance.

## Fixed the same night (context, not work)

- `if`/`match` bound to `Option<T>` could not infer `Option.None` in a branch (39a46ee7,
  71bc6293). Patched by queuing the expected type for branch tails (`tailHints`) and
  skipping the Option-unwrap for if/match in `checkExprWithHint`. See item 3: this is the
  second patch to the same side channel.
- False "use of moved variable" after a diverging `let ... else` (281d0774).
- Green IO on a closed fd exited the process (771dd722).
- Same-named private fns/globals in two modules: already per-module; clashing `pub fn`s
  are an error. Types are not (item 1).

## Open

### 1. Type names share one namespace across modules

Functions and globals are per-module now; struct/enum names are not. A type you never
imported still blocks your own declaration of that name.

```milo
from "std/process" import {
    Command
}

struct Process {     // error: 'Process' is defined as a struct in '<this file>'
    pid: i64,        //        and as a struct in 'std/process.milo'
}
```

Hit by dapweb (renamed its `Process` to `RunState`). Every new pub type in std can break
any program that happens to use the name.

### 2. Closures cannot capture references, including `self`

```milo
impl Conn {
    fn send(self: &Self, s: &string): i32 {
        return apply(s, (b: &string): i32 => self.fd + (b.len as i32))  // error: cannot capture 'self' in a closure
    }
}
fn apply(s: &string, f: (&string) => i32): i32 { return f(s) }
```

Forced std/ws's frame writer out of `WsConn` into a free function taking copies of the
fields, just so `sendSealed` could call it from inside `sealedWith`'s callback. The
closure here never escapes `apply`; a non-escaping callback borrowing its caller's locals
is the common case (sealedWith, sharedWith, iterators, sort comparators).

### 3. Expected-type propagation is a side channel

The expected type reaches an expression through `returnHint`/`returnHintExpr` (exact node
match in `expectedTypeOf`), plus `tailHints` (added for if/match branch tails), plus a
special case in `checkExprWithHint` that unwraps an `Option<T>` hint to `T` for
non-enum expressions (the cause of the if/match bug). Each new syntactic position that
should see the hint needs another patch. Positions to audit: call arguments, struct
literal fields, array literal elements, closure bodies/returns, `return` of an if/match,
`??` right side, nested if inside match inside a call argument. The root question: should
`checkExpr` take the expected type as a parameter (bidirectional checking) so every
position gets it by construction?

### 4. Move-state merging at control-flow joins

The let-else bug was move state from a diverging block leaking past the join. if/match
arms that `return` are handled correctly (checked). Audit every join point
systematically rather than one construct at a time: loops with `break`/`continue`, `?`,
match nested in let-else, early return inside a closure body, `while let`. Is there one
place joins happen that divergence can be handled in?

### 5. Error cascades

```milo
let args = 5
var args: Vec<string> = []   // error: variable 'args' already declared in this scope
args.push("a")               // error: type 'i64' has no method 'push'      (cascade)
print(args.len.toString())   // error: cannot access field 'len' on type i64 (cascade)
```

The first error is right; the rest come from uses resolving to the first binding. An
agent (and a person) reads the cascade as the problem. General question: what is the
recovery policy after an error (bind the new declaration? poison to `unknown` and stay
quiet?).

### 6. Resource ownership is not typed

The one real crash: a websocket writer task wrote to a socket fd after its owner closed
it (closed fd, or a reused fd number belonging to another connection). Causes:
- fds are plain `i32` in app code and std's lower layers;
- raw externs (`close`, `kill`) compile without `unsafe` (being fixed now: extern calls
  need `unsafe`, std grows owning types; branch `extern-unsafe`);
- `Task.spawn` needs a `move` closure, so a helper task cannot borrow the connection it
  serves; the writer got the fd by value and its lifetime was not tied to the owner.
  Fixed in dapweb by `Task.join` before the owner drops. Structured concurrency (a
  `Task.scope` whose tasks must finish before it returns, so they may borrow) would make
  this a compile error.

### 7. Stale idioms the compiler could teach

dapweb and agent-written code is full of `(0 as i64)`, `?? (-1 as i64)`, `(-1 as i64)`
casts that are no longer needed (int literals default to i64 and `?? -1` works). Code is
written from old examples. A lint with a `milo fix` rewrite for redundant literal casts
would stop the drift. Same question for other idioms that changed (e.g. `if let` exists
now; dapweb still has sentinel-value patterns from before it did).

### 8. Imported names collide with builtins (found landing extern-call)

`exit` is a builtin, and std/os also exports an extern `exit`. A file that imports
std/os's `exit` turns every builtin `exit(n)` call elsewhere (std/argparse) into the
extern, because the namespace is flat. The extern-call rule had to exempt `exit` to
avoid warnings users cannot fix. Same family as item 1: what an import brings into scope
leaks past the importing file.

### 9. Ownership holes the extern-call work exposed

- `Child` has public fields, so `Child { pid: anyPid }.signal(9)` compiles in safe code:
  a forged handle is as dangerous as a raw `kill`.
- Windows std/platform exports `close` as a safe pub fn.
- The extern-call rule exempts `@pure` externs (libm); `@pure` is trusted, not checked.

## What the analysis should produce

Per item: confirm the repro; find the root cause in `src/` (file:line); propose the fix at
the root (not another special case), with the alternatives considered; blast radius
(fixtures, examples, the external packages sweep); effort; and whether it is a language
design decision that needs the owner's call. Then rank by (bugs prevented x how often it
is hit) / cost.
