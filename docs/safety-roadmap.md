# Safety Roadmap: Closing the Gaps

Goal: match Rust's compile-time safety guarantees without Rust's complexity. Static analysis first — reject bad programs at compile time. Dynamic checks only as fallback for patterns static analysis genuinely can't reach. No lifetime annotations. No borrow checker. No annotation burden.

Current state: Milo enforces memory safety (moves), null safety (Option), race safety (Send/Sync), overflow safety (compile-time + debug traps), coercion safety (no implicit casts). The gaps are aliased mutation, arena use-after-free, and no unsafe boundary.

## Phase 1: `unsafe` Blocks + Safe FFI Surface

**Status:** Complete
**Complexity:** Low–Medium
**Impact:** High — auditability + dramatically reduced unsafe surface

`unsafe { }` blocks are implemented. The compiler requires `unsafe` for pointer deref, pointer indexing, address-of, casting to pointer types, and extern calls with unsafe signatures.

### What's implemented

**`unsafe` blocks** — quarantine for dangerous operations:
- Pointer deref (`*ptr`), pointer indexing (`ptr[i]`), address-of (`&var x`)
- Casting to pointer type (`x as *T`) — except `0 as *T` (null literal)
- `zeroed<T>()`

**Safe extern call expansion** — extern calls do NOT need `unsafe` when:
- All pointer params receive auto-coerced args: `string`→`*u8`, `[T;N]`→`*T`, matching `*T`→`*T`
- Function params match: `fn` type arg → `fn` type param
- Return type is scalar or `void`
- If return is `*T` → still requires `unsafe` (unknown provenance)

**`string.cstr()` builtin** — returns `*u8` data pointer without `unsafe`. Non-owning borrow; string stays alive in caller scope.

**`extern type`** — opaque foreign handle types (`extern type sqlite3`). Can only exist behind `*T`. Prevents handle mixups between different FFI types.

**Pointer-to-struct field access** — `ptr.field` auto-derefs `*Struct` for field access (requires `unsafe`). Eliminates manual byte-offset pointer arithmetic.

**Typed function pointers in extern decls** — extern fns accept `(*u8, *u8) => i32` params directly. Passing a matching Milo function needs no cast.

### Remaining Phase 1 items
- `unsafe fn` declarations — callers must wrap in `unsafe { }`
- Lint: warn on `unsafe` outside `std/` (configurable)
- `unsafe` visible in LSP (code lens, hover)
- `--deny-unsafe` flag for user code (aircraft-grade opt-in)

## Phase 2: Flow-Sensitive Invalidation Tracking

**Status:** Not started
**Complexity:** Medium — extends existing move checker
**Impact:** High — catches most aliasing bugs without annotations

### 2a: Ref-While-Frozen

If a `&T` or `&var` ref exists into a collection, the collection is frozen — mutation is a compile error until the ref goes out of scope.

```
var items: Vec<string> = Vec.new()
items.push("hello")
let r: &string = &items[0]
items.push("world")   // COMPILE ERROR: items is frozen while r is live
print(r)
```

Scope: intraprocedural (single function body). Same dataflow framework as the move checker. Track which variables are "borrowed from" and reject mutation of those variables while borrows are live.

### 2b: Use-After-Invalidate

Detect use of a ref/index after the source was potentially modified. Covers `.clear()`, `.push()` (may realloc), reassignment, and any method marked `@invalidates_refs`.

```
var items: Vec<string> = Vec.new()
let r: &string = &items[0]
items.clear()          // invalidates all refs into items
print(r)               // COMPILE ERROR: r invalidated by items.clear()
```

This reuses the move checker's "tainted variable" infrastructure. A ref becomes tainted when its source is mutated, same way a variable becomes tainted after a move.

### 2c: Arena Scope Tainting

After `arena.clear()` or `arena.destroy()`, any handle derived from that arena is tainted on that control-flow path.

```
var a: Arena<Node> = Arena.new()
let handle = a.alloc(Node { value: 42 })
a.clear()              // invalidates all handles from a
a.get(handle)          // COMPILE ERROR: handle invalidated by a.clear()
```

Same dataflow machinery. Handles are tracked like refs — the arena is the "source."

### Phase 2 scope decisions

- Intraprocedural only (single function body) — no interprocedural alias analysis
- Method annotations (`@invalidates_refs`, `@borrows_from(self)`) mark which operations invalidate which refs
- Standard library annotated first; user types opt in
- False negatives are acceptable (dynamic checks catch the rest); false positives are not (don't reject correct code)

## Phase 3: Interprocedural Static Analysis

**Status:** Not started
**Complexity:** High — requires call graph analysis
**Impact:** Closes the remaining static gaps without annotations

### 3a: Exclusivity at Call Sites

When a function receives both `&T` (read ref) and `&var T` (write ref) that alias the same source, reject at compile time. No annotation needed — the compiler sees both arguments at the call site.

```
fn update(items: &var Vec<string>, first: &string) {
    items.push("boom")   // would invalidate first
}

var items = Vec.new()
items.push("hello")
update(&var items, &items[0])  // COMPILE ERROR: items passed as both &var and & source
```

Rule: at any call site, a variable cannot appear as both a `&var` argument and the source of a `&` argument. Simple check — no interprocedural dataflow needed, just argument origin tracking at the call site.

### 3b: Purity Inference for Safe Overlap

Phase 3a is conservative — it rejects `fn read(items: &Vec<string>, first: &string)` even though `read` can't mutate. Purity inference relaxes this: if a function only takes `&T` params (no `&var`), it's provably safe to pass overlapping refs.

For `&var` params, infer whether the function actually mutates the collection (vs just reading through it). If proven non-mutating, allow the overlap.

### 3c: Arena Lifetime Scoping

Static rule: an arena handle cannot outlive the scope in which the arena is accessible. If the arena is passed to a function that could `.clear()` it, handles from before the call are invalidated.

```
fn resetArena(a: &var Arena<Node>) {
    a.clear()
}

var a = Arena.new()
let h = a.alloc(Node { value: 42 })
resetArena(&var a)     // a passed as &var — could mutate
a.get(h)               // COMPILE ERROR: h invalidated (a passed as &var after h created)
```

Conservative rule: any `&var Arena<T>` call invalidates all handles derived from that arena before the call. Sound, no annotations, some false positives (the function might not clear). Users can restructure to create handles after the call.

## Phase 4: Dynamic Safety (Fallback Layer)

**Status:** Partially done (generational indices exist for arenas)
**Complexity:** Medium — codegen changes, zero-cost in release
**Impact:** Catches the long tail that static analysis can't reach

Dynamic checks are the fallback, not the strategy. They exist for patterns where static analysis would need annotations to prove safety (callbacks, trait objects, deeply indirect mutation). The goal is to shrink this category over time via better static analysis.

### 4a: Debug Ref Counting

When a `&T` is live, bump a refcount on the source. If the source mutates while refcount > 0, panic with a clear diagnostic. Strip entirely in release builds.

```
// Aliasing through a trait object — static analysis can't see the concrete type
fn processAny(handler: &dyn Handler, items: &var Vec<string>) {
    handler.handle(items)   // does handle() read items? mutate? static can't know
}

var items = Vec.new()
let r = &items[0]
processAny(handler, &var items)  // DEBUG PANIC if handler mutates while r is live
```

Implementation: codegen emits refcount inc/dec around ref creation/destruction. Source objects get a hidden `_borrow_count: u32` field in debug builds. Mutation paths check `_borrow_count == 0`.

### 4b: Generational Index Hardening

Already implemented for arenas. Ensure:
- Always-on (debug and release) — this is a safety check, not a debug aid
- Clear panic messages: "use-after-free: handle generation 3, slot generation 5 (freed 2 generations ago)"
- Generational checks are cheap (one integer comparison) — no reason to strip them

### 4c: Sanitizer Mode

`milo build --sanitize` inserts additional checks at IR level:
- Bounds checks on all array/vec access (even in release)
- Use-after-free detection via poisoned memory patterns
- Stack buffer overflow detection via guard pages

Since Milo controls codegen, these can be more targeted than ASan — check only Milo-allocated memory, not the entire address space.

## Phase 5: Safety Profiles (Stretch)

Combine phases 1-4 into named profiles:

| Profile | Static checks | Dynamic checks | Use case |
|---------|--------------|----------------|----------|
| `default` | Moves + invalidation tracking | Debug refcounts + gen indices | Most programs |
| `strict` | + `--deny-unsafe` + `--strict-ranges` + `--no-unwrap` | + sanitizer always-on | Safety-critical (GNC, medical, financial) |
| `performance` | Moves + invalidation tracking | None (all checks stripped) | Hot paths, benchmarks |

Configured via `milo build --profile strict` or per-module annotation.

## Design Principles

1. **Static first** — reject bad programs at compile time. Dynamic checks are the fallback for patterns that genuinely need annotations to prove statically. Shrink the dynamic category over time.
2. **No annotations** — if it requires the user to write something Rust doesn't require, reject the design. The compiler should infer what Rust makes you spell out.
3. **Conservative is OK** — a static check that rejects some correct programs is acceptable if the workaround is simple (2-3 lines of restructuring). Better to reject and restructure than to silently allow a bug.
4. **Incremental adoption** — each phase ships independently and improves safety on its own
5. **Match guarantees, not mechanisms** — the goal is the same compile-time guarantee Rust provides, achieved through different (simpler) analysis. Where the analysis can't reach, dynamic checks fill in — but that's a gap to close, not a permanent design choice.

## Contract Verification Gaps

Contracts (`requires`/`ensures`/`invariant`) are parsed, type-checked, and enforced at call sites when arguments are compile-time constants. Current gaps:

### Non-constant `requires` — silently unenforced

When a call site passes computed values, `requires` clauses are not checked. No error, no warning, no runtime assertion. The contract exists in source but provides no guarantee.

```milo
fn positive(x: i64): i64
  requires x > 0
{ return x }

var n: i64 = 42
n = n - 100
positive(n)   // compiles, runs, returns -58 — contract ignored
```

**Options (pick one or layer):**
1. **Runtime assertion fallback** — emit a branch + panic for non-constant args. Always-on in debug, configurable in release. Cheap and catches most violations.
2. **Symbolic range tracking** — propagate known ranges through assignments/arithmetic. `n = 42; n = n - 100` → `n ∈ {-58}` → violates `x > 0`. Covers many practical cases without a solver.
3. **SMT integration** — wire `milo verify` into the compile pipeline for `--safety` profiles. Heavyweight but complete for linear arithmetic.
4. **Mandatory warning** — if a `requires` clause can't be statically checked, emit a warning so the programmer knows the contract is unchecked. Lowest effort, highest honesty.

### `ensures` — never verified

Postconditions are type-checked as boolean expressions but never proven against the function body. A function can claim `ensures result > 0` and return a negative value without complaint.

```milo
fn alwaysPositive(x: i64): i64
  ensures result > 0
{ return x }    // compiles fine, postcondition is a lie
```

**Options:**
1. **Runtime assertion on return** — rewrite `return expr` to `let result = expr; assert(postcondition); return result`. Same debug/release strategy as `requires`.
2. **Body-level constant eval** — for simple bodies (single return of clamped value), prove the postcondition holds. Covers the `clampF64` pattern in `pidUpdate`.
3. **SMT verification** — generate verification conditions from the function body. `milo verify` already does this externally; integrate for `--safety` profiles.

### `invariant` — checked for presence, not for inductive validity

`requireBoundedLoops` in safety profiles checks that `while` loops have `invariant` clauses. It does not verify that (a) the invariant holds on loop entry, (b) each iteration preserves it, or (c) it implies the desired postcondition on exit.

### Priority recommendation

Runtime assertions (#1 for both requires and ensures) give the most safety per effort. They turn contracts from documentation into enforcement. Symbolic range tracking is a natural second step. SMT integration is the long game for `--safety=do178c-a/b` profiles where compile-time proof is the goal.

## Open Questions

- How far should invalidation tracking go? Intraprocedural is the starting point, but some patterns (passing a ref and the source to the same function) need at least call-site analysis. Is "ref + source can't be passed to the same function" too restrictive?
- Should `@invalidates_refs` be inferred for standard library types, or always explicit?
- Debug ref counting adds overhead to every ref creation. Is there a cheaper scheme that catches 90% of bugs? (e.g., only track refs into heap-allocated data, not stack locals)
- Should `unsafe` propagate? (i.e., calling an `unsafe fn` from a non-unsafe context — error? warning? nothing?) Rust requires `unsafe` at the call site. Simpler option: just require `unsafe` blocks around `extern` calls and let `unsafe fn` be advisory.
