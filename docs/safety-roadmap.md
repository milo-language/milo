# Safety Roadmap: Closing the Gaps

Goal: match Rust's compile-time safety guarantees without Rust's complexity. Static analysis first — reject bad programs at compile time. Dynamic checks only for patterns static analysis genuinely can't reach. No lifetime annotations. No borrow checker. No annotation burden.

Enforced today: memory safety (moves), null safety (Option), race safety (Send/Sync), overflow safety, coercion safety, intraprocedural aliased-mutation tracking (Phase 2). Remaining gaps: arena use-after-free, interprocedural aliasing.

## Phase 1: `unsafe` Blocks + Safe FFI Surface — DONE

`unsafe { }` is required for: pointer deref (`*ptr`), pointer indexing (`ptr[i]`), address-of (`&var x`), casting to pointer types (except the null literal `0 as *T`), `zeroed<T>()`, and extern calls with unsafe signatures.

Implemented:

- **Safe extern call expansion** — no `unsafe` when all pointer params receive auto-coerced args (`string`→`*u8`, `[T;N]`→`*T`, matching `*T`), fn-typed params receive matching Milo fns, and the return is scalar or `void`. Calls returning `*T` still require `unsafe` (unknown provenance).
- **`string.cstr()`** — safe non-owning `*u8` borrow; string stays alive in caller scope.
- **`extern type`** — opaque foreign handles, only behind `*T`; distinct types prevent handle mixups.
- **Pointer-to-struct field access** — `ptr.field` auto-derefs `*Struct` (requires `unsafe`); no manual byte-offset arithmetic.
- **Typed function pointers in extern decls** — `(*u8, *u8) => i32` params take Milo fns with no cast.
- **Unused-`unsafe` lint** — on by default, scoped to user code (stdlib's permissive safe-extern blocks exempt).

Remaining: `unsafe fn` declarations (callers must wrap), `unsafe` visibility in LSP (code lens, hover), `--deny-unsafe` flag for user code.

## Phase 2: Flow-Sensitive Invalidation Tracking — 2a/2b done for built-in borrows

Same dataflow framework as the move checker: track which variables are "borrowed from" and reject mutation while borrows are live. Intraprocedural only.

Done: mutating builtins (push/pop/insert/remove/reverse/swap/sort\*) and `&var self` methods are rejected on a receiver with a live borrow — a string-slice binding or an active for-in iteration. Frozen vars are also rejected as `&mut` args at any call site, and callback receivers are frozen during the callback check (`v.each(fn(x){ v.push(x) })` errors). Slice bindings release their freeze at scope pop; for-in at loop end; non-ref bindings (`let x = s[0..n].clone()`) release immediately. In-place element assignment (`v[i] = x`) stays legal — never reallocs.

Remaining: 2c arena scope tainting — needs an `@invalidates_refs`-style annotation since `Arena` is a library type the checker doesn't know.

### 2a: Ref-While-Frozen

While a ref into a collection is live, the collection is frozen — mutation is a compile error until the ref goes out of scope.

```
var items: Vec<string> = Vec.new()
items.push("hello")
let r: &string = &items[0]
items.push("world")   // COMPILE ERROR: items is frozen while r is live
print(r)
```

### 2b: Use-After-Invalidate

Use of a ref after its source was potentially modified (`.clear()`, `.push()` may realloc, reassignment, anything marked `@invalidates_refs`) is an error. Reuses the move checker's tainted-variable infrastructure — a ref taints like a variable after a move.

```
var items: Vec<string> = Vec.new()
let r: &string = &items[0]
items.clear()          // invalidates all refs into items
print(r)               // COMPILE ERROR: r invalidated by items.clear()
```

### 2c: Arena Scope Tainting

After `arena.clear()`/`arena.destroy()`, handles derived from that arena are tainted on that control-flow path. Handles tracked like refs; the arena is the source.

```
var a: Arena<Node> = Arena.new()
let handle = a.alloc(Node { value: 42 })
a.clear()              // invalidates all handles from a
a.get(handle)          // COMPILE ERROR: handle invalidated by a.clear()
```

### Scope decisions

- Intraprocedural only — no interprocedural alias analysis
- Method annotations (`@invalidates_refs`, `@borrows_from(self)`) mark invalidating operations; stdlib annotated first, user types opt in
- False negatives acceptable (dynamic checks catch the rest); false positives are not — don't reject correct code

## Phase 3: Interprocedural Static Analysis — not started

### 3a: Exclusivity at Call Sites

At any call site, a variable cannot appear as both a `&var` argument and the source of a `&` argument. No interprocedural dataflow needed — just argument-origin tracking.

```
fn update(items: &var Vec<string>, first: &string) {
    items.push("boom")   // would invalidate first
}
update(&var items, &items[0])  // COMPILE ERROR: items as both &var and & source
```

### 3b: Purity Inference for Safe Overlap

3a is conservative — it rejects `fn read(items: &Vec<string>, first: &string)` even though `read` can't mutate. If a function takes only `&T` params, overlapping refs are provably safe. For `&var` params, infer whether the function actually mutates; if proven non-mutating, allow the overlap.

### 3c: Arena Lifetime Scoping

Any call passing `&var Arena<T>` invalidates all handles derived from that arena before the call — the callee could `.clear()` it. Sound, no annotations, some false positives; users restructure to create handles after the call.

```
fn resetArena(a: &var Arena<Node>) { a.clear() }

var a = Arena.new()
let h = a.alloc(Node { value: 42 })
resetArena(&var a)
a.get(h)               // COMPILE ERROR: h invalidated (a passed as &var after h created)
```

## Phase 4: Dynamic Safety (Fallback Layer) — partial

Dynamic checks are the fallback, not the strategy — they cover patterns static analysis would need annotations to prove (callbacks, trait objects, deeply indirect mutation). Shrink this category over time.

### 4a: Debug Ref Counting

While a `&T` is live, bump a refcount on the source; mutation with refcount > 0 panics with a clear diagnostic. Codegen emits inc/dec around ref lifetimes; sources get a hidden `_borrow_count: u32`. Debug builds only — stripped in release. Covers e.g. a trait-object callback mutating a collection something else holds a ref into.

### 4b: Generational Index Hardening

Already implemented for arenas. Requirements: always-on in debug *and* release (it's a safety check, not a debug aid — one integer comparison), and clear panics: "use-after-free: handle generation 3, slot generation 5".

### 4c: Sanitizer Mode

`milo build --sanitize`: bounds checks on all access even in release, use-after-free via poisoned memory patterns, stack overflow via guard pages. Since Milo controls codegen these are more targeted than ASan — only Milo-allocated memory.

## Phase 5: Safety Profiles (Stretch)

| Profile | Static checks | Dynamic checks | Use case |
|---------|--------------|----------------|----------|
| `default` | Moves + invalidation tracking | Debug refcounts + gen indices | Most programs |
| `strict` | + `--deny-unsafe` + `--strict-ranges` + `--no-unwrap` | + sanitizer always-on | Safety-critical (GNC, medical, financial) |
| `performance` | Moves + invalidation tracking | None | Hot paths, benchmarks |

Via `milo build --profile strict` or per-module annotation.

## Design Principles

1. **Static first** — dynamic checks are fallback for patterns that genuinely need annotations to prove; shrink that category over time.
2. **No annotations** — if it requires the user to write something Rust doesn't require, reject the design.
3. **Conservative is OK** — rejecting some correct programs is fine if the workaround is 2–3 lines of restructuring.
4. **Incremental** — each phase ships independently.
5. **Match guarantees, not mechanisms** — same compile-time guarantee as Rust via simpler analysis; where analysis can't reach, dynamic checks fill in as a gap to close, not a permanent choice.

## Contract Verification Gaps

Contracts (`requires`/`ensures`/`invariant`) are parsed, type-checked, enforced at call sites for compile-time-constant args, and asserted at runtime in debug builds: `requires` at entry, `ensures` at every return (`result` bound), `invariant` at the loop header (entry, every back-edge, exit). Violations print `runtime error: <kind> clause violated at file:line` and exit 1. Release builds compile contracts out.

Remaining gaps:

- **No static proof — release builds unprotected.** A function can claim `ensures result > 0`, return negative on an untested path, and ship. Options, in order: (1) symbolic range tracking — propagate known ranges through assignments/arithmetic (`n = 42; n = n - 100` → violates `x > 0` at compile time), covers many cases without a solver; (2) SMT integration — `milo verify` in the pipeline for `--safety` profiles, complete for linear arithmetic; (3) opt-in release assertions via `--contracts=on`.
- **`invariant` is runtime-checked, not proven inductive.** Nothing verifies statically that iterations preserve the invariant or that it implies the postcondition on exit — that requires SMT.

Priority: symbolic range tracking next; SMT is the long game for `--safety=do178c-a/b` profiles.

## Open Questions

- How far should invalidation tracking go? Some patterns (ref + source passed to the same function) need at least call-site analysis. Is "ref + source can't go to the same function" too restrictive?
- Should `@invalidates_refs` be inferred for stdlib types, or always explicit?
- Debug ref counting costs on every ref creation. Cheaper scheme catching 90%? (e.g. only track refs into heap data, not stack locals)
- Should `unsafe` propagate? Rust requires `unsafe` at `unsafe fn` call sites. Simpler option: require `unsafe` around extern calls, let `unsafe fn` be advisory.
