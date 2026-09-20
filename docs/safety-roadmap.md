<!-- doc-meta
system: safety-roadmap
purpose: shipped safety mechanisms, explicit trust boundaries, and remaining soundness work
key-files: src/checker.ts, src/codegen.ts, std/arena.milo, std/runtime.milo, std/sync.milo, tests/errors/, tests/runtime-errors/
update-when: a safety check ships, a trust boundary changes, or a roadmap gap closes
last-verified: 2026-08-24
-->

# Safety Roadmap: Closing the Gaps

Goal: approach Rust's safe-code guarantees with a smaller reference model. Static analysis first; always-on dynamic checks where the chosen arena/bounds model requires them. No lifetime annotations.

Enforced today: moves, second-class references, bounds checks, `Option`, structural Send/Sync, explicit unsafe manual Send/Sync implementations, all-mode overflow traps (`--no-overflow-checks` to opt out), coercion checks, intraprocedural borrow invalidation, call-site exclusivity, and arena identity/generation validation. Remaining work is concentrated at explicit trust boundaries (FFI and audited unsafe implementations) and richer interprocedural reasoning.

Where a rule is enforced by more than one mechanism it drifts. "Cannot move a
non-Copy element out of a borrow" lived in `checker.ts` for fields and in
`codegen.ts` for indices, and the two disagreed until a sized array of strings
double-freed in safe code (fixed 2026-08-01). `tests/aliasing-matrix.golden.md`
pins one cell per container × operation so the next divergence shows up as a
diff instead of as a crash.

## Phase 1: `unsafe` Blocks + Safe FFI Surface — DONE

`unsafe { }` is required for: pointer deref (`*ptr`), pointer indexing (`ptr[i]`), address-of (`x.addrOf()`), casting to pointer types (except the null literal `0 as *T`), `zeroed<T>()`, and extern calls with unsafe signatures.

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

Done: mutating builtins (push/pop/insert/remove/reverse/swap/sort\*) and `&mut self` methods are rejected on a receiver with a live borrow — a string-slice binding or an active for-in iteration. Frozen vars are also rejected as `&mut` args at any call site, and callback receivers are frozen during the callback check (`v.each(fn(x){ v.push(x) })` errors). Slice bindings release their freeze at scope pop; for-in at loop end; non-ref bindings (`let x = s[0..n].clone()`) release immediately. In-place element assignment (`v[i] = x`) stays legal — never reallocs.

Arena handles use always-on identity and generation checks, so stale or wrong-arena access returns `None`/`false` without checker-specific tainting.

### 2a: Ref-While-Frozen

While a ref into a collection is live, the collection is frozen — mutation is a compile error until the ref goes out of scope.

```
var text: string = "hello world"
let r = text[0..5]    // &string view — borrows are implicit, there is no `&x`
text.push('!')        // COMPILE ERROR: cannot call 'push' on 'text' because it is borrowed
print(r)
```

### 2b: Use-After-Invalidate

Use of a ref after its source was potentially modified (`.clear()`, `.push()` may realloc, reassignment, anything marked `@invalidates_refs`) is an error. Reuses the move checker's tainted-variable infrastructure — a ref taints like a variable after a move.

```
var items: Vec<i64> = [1, 2, 3]
let r = items[0..2]    // &[i64] view into items
items.clear()          // invalidates all views into items
print(r[0])            // COMPILE ERROR: r invalidated by items.clear()
```

### 2c: Arena Scope Tainting — superseded by dynamic identity/generation checks

After `arena.clear()`, handles derived from that arena are tainted on that control-flow path. Handles tracked like refs; the arena is the source.

```
var a: Arena<Node> = Arena<Node>.new()
let handle = a.alloc(Node { value: 42 })
a.clear()              // invalidates all handles from a
a.get(handle)          // COMPILE ERROR: handle invalidated by a.clear()
```

Shipped instead as a dynamic check: `clear()` takes a fresh arena identity, so
`a.get(handle)` returns `None` rather than aliasing a slot allocated after the
clear. There is no `destroy()` — an arena is an ordinary owned value and its
scope exit frees everything it holds.

### Scope decisions

- Intraprocedural only — no interprocedural alias analysis
- Method annotations (`@invalidates_refs`, `@borrows_from(self)`) mark invalidating operations; stdlib annotated first, user types opt in
- False negatives acceptable (dynamic checks catch the rest); false positives are not — don't reject correct code

## Phase 3: Interprocedural Static Analysis — 3a shipped

### 3a: Exclusivity at Call Sites — done

At any call site, a variable cannot appear as both a `&var` argument and the source of a `&` argument. No interprocedural dataflow needed — just argument-origin tracking.

```
fn grow(v: &mut Vec<i64>, s: &[i64]) {
    v.push(999)          // reallocates — would invalidate s
    print(s[0])
}
grow(v, v[0..2])         // COMPILE ERROR: v is borrowed mutably and shared in the same call
```

### 3b: Purity Inference for Safe Overlap

3a is conservative — it rejects `fn read(items: &Vec<string>, first: &string)` even though `read` can't mutate. If a function takes only `&T` params, overlapping refs are provably safe. For `&mut` params, infer whether the function actually mutates; if proven non-mutating, allow the overlap.

### 3c: Arena Lifetime Scoping — not required for memory safety today

Any call passing `&mut Arena<T>` invalidates all handles derived from that arena before the call — the callee could `.clear()` it. Sound, no annotations, some false positives; users restructure to create handles after the call.

```
fn resetArena(a: &mut Arena<Node>) { a.clear() }

var a: Arena<Node> = Arena<Node>.new()
let h = a.alloc(Node { value: 42 })
resetArena(a)
a.get(h)               // COMPILE ERROR: h invalidated (a passed as &mut after h created)
```

Not shipped, and not required: `clear()` gives the arena a fresh identity, so a
pre-clear handle fails the identity check and reads `None` at runtime rather than
aliasing a recycled slot. This phase would move that from a runtime `None` to a
compile error.

## Phase 4: Dynamic Safety (Fallback Layer) — partial

Dynamic checks are the fallback, not the strategy — they cover patterns static analysis would need annotations to prove (callbacks, trait objects, deeply indirect mutation). Shrink this category over time.

### 4a: Debug Ref Counting — planned, not implemented

While a `&T` is live, bump a refcount on the source; mutation with refcount > 0 panics with a clear diagnostic. Codegen emits inc/dec around ref lifetimes; sources get a hidden `_borrow_count: u32`. Debug builds only — stripped in release. Covers e.g. a trait-object callback mutating a collection something else holds a ref into.

### 4b: Generational Index Hardening

Implemented for arenas in debug and release. Handles carry arena identity, slot, and generation; invalid access returns `None`/`false` rather than panicking.

### 4c: Sanitizer Mode

`milo build --sanitize`: bounds checks on all access even in release, use-after-free via poisoned memory patterns, stack overflow via guard pages. Since Milo controls codegen these are more targeted than ASan — only Milo-allocated memory.

## Phase 5: Safety Profiles (Stretch)

| Profile | Static checks | Dynamic checks | Use case |
|---------|--------------|----------------|----------|
| `default` | Moves + invalidation tracking | Debug refcounts + gen indices | Most programs |
| `strict` | + `--deny-unsafe` + `--strict-ranges` + `--no-unwrap` | + sanitizer always-on | Safety-critical (GNC, medical, financial) |
| `performance` | Moves + invalidation tracking | None | Hot paths, benchmarks |

Via `milo build --profile strict` or per-module annotation.

## Closed gap: a `pub struct` cannot protect its own fields

Found 2026-08-24, closed 2026-09-20: a field named with a leading `_` is now private to
the file that declares the struct (reference, "Private fields"), so the literal below is
`error: field '_ptr' of 'CStr' is private to 'std/cstr.milo'`. The record of the gap:
safe code with no `unsafe` block anywhere could segfault:

```milo
from "std/cstr" import { CStr }

pub fn main(): i32 {
    let c = CStr { _ptr: 0 as *u8, _len: 5 }   // forged, in safe code
    print(c.toString())                        // std derefs it internally
    return 0
}
```

```
exit 139 (SIGSEGV)
```

Each step is individually defensible, which is why it went unnoticed:

| Step | Allowed in safe code | Correct on its own |
|---|---|---|
| `0 as *u8` | yes | a pointer that cannot be dereferenced is inert |
| `p[0]` on it | **no**, `unsafe` required | yes, this is the check working |
| `CStr { _ptr: … }` | yes | **the gap** |
| `c.toString()` derefs `_ptr` in its own `unsafe` | yes | yes, a module may trust its own invariant |

The break was the third row. `pub struct` exposed every field, so a struct literal or a
field assignment from another file could put anything into a field the module's `unsafe`
blocks then trust.

The fix chosen over a `pub`-per-field spelling: the `_` prefix that std already used on
44 fields across 25 `pub struct`s to mean "do not touch" became the rule. A `_` field may
be read, written, or named in a literal only in the declaring file; derived methods are
generated in that file's scope. No existing `pub struct` changed meaning, and the sweep
that landed it found four cross-file sites (all struct literals building std types) and
gave each a constructor in its own module (`WsConn.view`, `Task.raw`, `AtomicBool.clone`).

## Design Principles

1. **Static first** — dynamic checks are fallback for patterns that genuinely need annotations to prove; shrink that category over time.
2. **No annotations** — if it requires the user to write something Rust doesn't require, reject the design.
3. **Conservative is OK** — rejecting some correct programs is fine if the workaround is 2–3 lines of restructuring.
4. **Incremental** — each phase ships independently.
5. **Match guarantees, not mechanisms** — same compile-time guarantee as Rust via simpler analysis; where analysis can't reach, dynamic checks fill in as a gap to close, not a permanent choice.

## Contract Verification Gaps

Contracts (`requires`/`ensures`/`invariant`) are parsed, type-checked, enforced at call sites for compile-time-constant args, and asserted at runtime in debug builds: `requires` at entry, `ensures` at every return (`result` bound), `invariant` at the loop header (entry, every back-edge, exit). Violations print `runtime error: <kind> clause violated at file:line` and exit 1. Release builds compile contracts out.

`milo prove` now discharges a bounded linear-integer fragment through SMT, and constant-argument precondition violations are ordinary compile errors. Remaining gaps:

- **Unknown proofs leave release builds unprotected.** Nonlinear/bitwise expressions, collection lengths reached through builders, and richer struct invariants report `unknown`; debug builds still assert them, while release compiles contracts out.
- **Loop/heap reasoning is bounded.** Rich inductive invariants, aliasing heap state, and general functional correctness remain outside the prover's supported fragment.
- **No opt-in release assertion mode.** An explicit `--contracts=on` mode would preserve unknown clauses in production when policy requires it.

## Open Questions

- How far should invalidation tracking go? Some patterns (ref + source passed to the same function) need at least call-site analysis. Is "ref + source can't go to the same function" too restrictive?
- Should `@invalidates_refs` be inferred for stdlib types, or always explicit?
- Debug ref counting costs on every ref creation. Cheaper scheme catching 90%? (e.g. only track refs into heap data, not stack locals)
- Should `unsafe` propagate? Rust requires `unsafe` at `unsafe fn` call sites. Simpler option: require `unsafe` around extern calls, let `unsafe fn` be advisory.
