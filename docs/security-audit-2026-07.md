<!-- doc-meta
system: security
purpose: action-item tracker for the 2026-07-20 adversarial memory-safety audit; each box is a fix in flight
key-files: src/checker.ts, src/codegen.ts, src/parser.ts, src/main.ts
update-when: an item's fix lands (check the box) or a new finding is triaged
last-verified: 2026-07-20
-->

# Security audit — adversarial memory-safety review (2026-07-20)

Black-hat audit of the compiler and its output. Goal was to break the memory-safety
guarantee, segfault binaries, and crash the compiler. Every finding was reproduced on the
repo-source compiler (`bun run src/main.ts`). This file is the action-item tracker; each box
is worked one at a time, its own commit, with a regression fixture.

Verdict: sound architecture, bugs cluster in the closure subsystem plus one aliasing gap and
one unsigned-length mistake. Index bounds (signed/negative/i64/u64), refined ranges, slice
checks, second-class references, struct/enum layout, generic monomorphization, and the
AArch64 struct-by-value ABI all held up; ~110 pathological compiler inputs were handled
gracefully.

## Action items (priority: memory-safety first)

- [x] **C2 — `Vec.filled(negativeCount, x)` → negative len → OOB.** `Vec.filled`/`withCapacity`
  store `count` verbatim as `len`; the index bounds check is unsigned (`icmp ult`), so a
  negative len becomes a huge bound and every index passes → OOB → SIGSEGV. Reachable at
  `--release` via overflow-wrapped count; a literal `-1` also compiles clean.
  Fix: runtime trap on `count < 0` (and size-overflow) in the Vec/String allocators; static
  reject of a negative constant where a length is expected. Consider `u64` length params at
  the constructor boundary (Rust/C++ use unsigned size + a capacity-overflow guard).

- [x] **C1 — mutable-aliasing use-after-free.** No aliasing check between `&mut` params;
  `bad(v[0], v)` passes an element ref and the container, inner `push` reallocs → dangling.
  Fix: reject a call where two `&mut` args provably overlap (`v[i]` and `v`).

- [x] **C3 — escaping non-`move` closure captures by reference.** Returned/stored non-`move`
  closure captures a local by reference into the dead frame. `checker.ts:1151` assumes
  escaping closures are `move` but never enforces it. Fix: the Return path promotes an
  escaping closure to `move` so its captures are heap-owned — both when the closure literal
  is returned directly (`return (…) => …`) and when it is bound to a local and returned by
  name (`let f = …; return f`), tracked via `VarInfo.boundClosure`.
  Still open (not this pass): a closure that escapes *indirectly* — stored into a struct or
  Vec that is then returned, or returned by a caller after being passed in — is not yet
  promoted. Those need general escape analysis; tracked as follow-up, workaround is explicit
  `move`.

- [ ] **H1 — `f()(x)` / `arr[i](x)` callee never invoked.** Call-result / index callee is
  mis-codegen'd: closure computed then discarded, arg printed raw with wrong format
  (`<unprintable>`). Only plain-variable and struct-field callees work.

- [x] **M1 — i32 slice bounds emit invalid IR.** `s[a..b]` with `i32` a/b → `icmp slt i64`
  on an i32 value. Checker accepts i32; codegen must widen bounds to i64.

- [ ] **M2 — deep nested `match` emits invalid GEP.** `getelementptr i64, ptr, i32 0, i32 0`.

- [x] **M3 — unchecked non-arithmetic UB.** div/mod by zero, `INT_MIN / -1`, shift ≥ width,
  float→int out-of-range never trap; garbage at `--release`. Trap div0 (and design shift/
  fptosi: mask vs trap vs `llvm.fptosi.sat`).

- [x] **D1 — parser stack overflow.** No recursion-depth guard; ~4000-deep nesting →
  `RangeError: Maximum call stack`. Add a depth limit with a clean diagnostic.

- [x] **D2 — infinite monomorphization.** Recursive generic (`grow<Wrap<T>>`) has no
  instantiation-depth cap → stack overflow in `monomorphizeFn`. Add a recursion limit.

- [x] **D3 — `prove`/`verify`/`wcet` don't catch `ParseError`.** They dump a raw JS stack
  trace on syntax errors while `build` renders a clean diagnostic. Add the error boundary.

- [ ] **L1 — self-referential struct by value** (`struct Node { next: Node }`, infinite size)
  compiles with no error.
- [ ] **L2 — duplicate `fn` definitions** — no redefinition error.
- [ ] **L3 — huge stack array** (`[i32; 10000000]`) silently compiles → runtime SIGSEGV.
- [ ] **L4 — UTF-8 mid-codepoint byte-slice** → silent invalid UTF-8 (no char-boundary check).
- [ ] **L5 — moved struct-field use** accepted statically (runtime-masked; static gap only).
- [ ] **L6 — monomorph name collision** (`struct Box_i64` vs `Box<i64>`) → spurious field
  errors (fail-closed).
