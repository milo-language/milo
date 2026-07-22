<!-- doc-meta
system: memory-safety-vs-rust
purpose: adversarial retained probes of Milo's safe-language behavior compared with Rust
key-files: src/checker.ts, src/codegen.ts, std/arena.milo, docs/ownership-model.md
update-when: a safety check is added/moved between compile-time and runtime, a new threat class is probed, or the overflow default changes
last-verified: 2026-07-22
-->

# Memory safety: Milo vs Rust, battle-tested

Memory safety is the whole reason a safe systems language exists, so this doc doesn't argue it — it *probes* selected threats with retained regression fixtures and both-sides receipts. The bar is simple: **no silent undefined behavior in safe code.** A threat is handled if it is caught at compile time or trapped at runtime. `unsafe`, FFI declarations, and manual `unsafe impl Send` / `Sync` are explicit trust boundaries, as they are in Rust.

Result of the retained sweep (2026-07-22): **zero silent-UB misses in the tested safe-language cases.** The sweep did find and fix cross-arena handle confusion, which returned the wrong value without memory UB, and it made manual thread-safety overrides explicitly unsafe. Overflow still wraps by default in release; see below.

## Threat matrix

`compile` = rejected before codegen · `runtime` = defined trap/abort · `n/a` = the pattern can't be written

| Threat class | Rust catches at | Milo catches at | How Milo does it |
|---|---|---|---|
| Use-after-move | compile | **compile** | move checker: `error: use of moved variable` |
| Double-free | compile | **compile** | second move is use-after-move |
| Use-after-free, owned (`Heap`/`Box`) | compile | **compile** | move checker — `Heap<T>` is single-owner |
| Dangling return (`return &local`) | compile | **compile** | refs are second-class: `error: cannot return a reference` |
| Stored borrow in a struct | compile (with `<'a>`) | n/a → **compile** | `error: references cannot be stored in structs` |
| Iterator invalidation (mutate while iterating) | compile | **compile** | borrow tracker: `error: cannot call 'push' on 'v' because it is borrowed` |
| Aliasing `&mut` + `&` to one place | compile | **compile** | exclusivity check at call site |
| Use-before-init | compile | **compile** | declaration requires an initializer (parse) |
| Null deref | compile (no null; `Option`) | **compile** | no null type; `Option<T>` must be matched |
| Out-of-bounds read (array) | runtime panic | **runtime** | `milo: array index out of bounds: 5/3` |
| Out-of-bounds index (`Vec`) | runtime panic | **runtime** | `milo: array index out of bounds: 7/1` |
| Use-after-free, cyclic (arena handle) | n/a (`&'a` rejected) → runtime | **runtime** | generational `Handle`: stale handle → `get` returns `None` |
| Divide-by-zero | runtime panic | **runtime (all modes)** | `milo: division by zero` |
| `INT_MIN / -1` | runtime panic | **runtime (all modes)** | same guard as div-by-zero |
| Integer overflow | debug panic / **release wrap** | debug trap / **release wrap** | ⚠ see finding — Rust-parity today, not the decided default |
| Contract violation (pre/post/invariant) | runtime (unstable) / external tools | **compile-time (SMT) + runtime** | different axis — see below |

The last row is *not* memory safety — it's functional correctness. It's here because it's where Milo pulls decisively ahead, and it's easy to conflate the two.

## The cyclic-data nuance (why "runtime" isn't a downgrade there)

For a mutable cyclic graph — doubly-linked list, parent-pointer tree, DOM — Rust's `&'a` borrow checker **rejects the aliasing outright**; there is no compile-time `&'a` version to be "worse than." Real Rust reaches for one of:

- **`Rc<RefCell<T>>`** — use-after-free impossible (refcount), but `borrow_mut()` aliasing violations **panic at runtime**, plus a heap alloc + refcount per node (and cycles can leak).
- **arena + raw `usize` index** — a stale index is not caught: slot reuse can return the wrong value.
- **generational arena** (`slotmap`, `generational-arena`, or a domain-specific equivalent) — a `(slot, generation)` key rejects stale access, the same mechanism Milo uses.

Milo's `Arena<T>` + generational `Handle<T>` is safer than a raw-index arena and at parity with Rust's generational arena designs. Milo's differentiator is that this abstraction ships in `std/arena`; Rust normally uses a crate or a project-specific arena. The runnable `steelman_arena` receipt implements the same typed generational-key design on both sides.

## Where Rust is genuinely ahead: stored borrows

A type that *stores a borrow* of data owned elsewhere:

```rust
struct Parser<'a> { input: &'a [u8], pos: usize }   // Rust: compile-time view↔buffer tie
```

Milo can't express this — refs are second-class. You own the buffer and hold an integer offset instead (`std/json` does exactly this). Still memory-safe (bounds-checked), but you lose the compile-time guarantee that a view can't outlive or mismatch its buffer — a logic bug Rust's `'a` would catch. This is the central tradeoff of Milo's reference model, not a claim that Rust has no other ecosystem or expressivity advantages. See [ownership-model.md](ownership-model.md).

## Beyond memory safety: contracts (where Milo pulls ahead)

Memory safety stops corruption; contracts stop *logic* errors — a function fed inputs it forbids, or returning a value it promised it wouldn't. Milo has them built in:

```milo
fn clamp(x: i32, lo: i32, hi: i32): i32
  requires lo <= hi
  ensures result >= lo && result <= hi
{ if x < lo { return lo }  if x > hi { return hi }  return x }
```

- **`milo prove`** discharges these at **compile time** via an SMT solver. On the above: `proven: 2 failed: 0 unknown: 0` — the postcondition and the caller's precondition are *proven*, not tested.
- A precondition violated with **compile-time-constant arguments** is a hard compile error (`clamp(5, 100, 0)` → `error: requires clause 'lo <= hi' violated`), no prover run needed.
- In **`--debug`**, every clause becomes a runtime assert (entry/return/loop). **Release** compiles them out.

**Rust, from its own source:** `core::contracts` exists (`requires`/`ensures`, issue #128044, RFC 3484) but is **unstable**, and it lowers to **runtime** assertions (`-Z contract-checks`) — rustc ships no SMT solver. Rust can encode some invariants through newtypes/typestate and selected const assertions; general static proof uses external tools such as Kani (CBMC), Creusot (Why3), or Prusti (Viper). Milo's advantage is an integrated path for its bounded linear-arithmetic fragment.

**Honest frontier.** Milo's prover is not a general verifier. It discharges **linear scalar** arithmetic over integers at call sites and returns; it reports **`unknown`** (not `proven`) for nonlinear/bitwise expressions (`*` of two variables, `&`, `<<`), `Vec.len()` reached through a builder, and struct-field loop invariants. `unknown` ≠ `failed` — it means "not discharged statically," and in `--debug` that clause still holds the line at runtime. The win is real but bounded: simple numeric contracts are proven away for free; richer ones fall back to runtime. See [prover-frontier](design.md) notes.

## Finding #1: overflow wraps in release, docs claim otherwise

- **Observed:** `2147483647 + 1` at `i32` → `-2147483648` (silent wrap) under `milo run`, default `build` (-O2), and `--release`. Only `--debug` traps (`runtime error: integer overflow`).
- **Cause:** the checked-arith emission (`llvm.sadd.with.overflow` → abort) is gated behind `this.debugOverflow` in `src/codegen.ts` (~line 3425), set only in debug mode.
- **Severity:** not a memory-safety hole — wrapping is defined behavior, no UB. It's a **policy/doc mismatch**: design.md's decided default is "trap in all build modes," but the shipped default is Rust-parity (debug trap, release wrap). design.md §Overflow now states the shipped status honestly.
- **To close:** ungate `emitCheckedArith` to all modes, leaning on range analysis so the release cost stays near zero (the machinery already exists). Div-by-zero and `INT_MIN/-1` are already always-on; overflow is the last case.

## How to extend this battle-test

Add a runnable Rust↔Milo receipt to `rust-comparison/` or a focused fixture under `tests/errors`, `tests/runtime-errors`, or `tests/fixtures`. Each probe should trigger exactly one outcome, and the receipt runner must assert its classification and diagnostic text. Remaining trust-boundary work includes adversarial FFI receipts, auditing each stdlib `unsafe impl Send` / `Sync` invariant, and explicit wrong-buffer span tests (a logic-integrity gap rather than memory UB).

## See also

- [ownership-model.md](ownership-model.md) — why no lifetimes; the Rust→Milo pattern table
- [design.md](design.md) — §Overflow (shipped status), §Ethos (principle ordering)
