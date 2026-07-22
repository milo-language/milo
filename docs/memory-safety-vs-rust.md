<!-- doc-meta
system: memory-safety-vs-rust
purpose: adversarial battle-test of Milo's memory safety vs Rust — every threat class, whether it's caught at compile time, trapped at runtime, or a silent hole
key-files: src/checker.ts, src/codegen.ts, std/arena.milo, docs/ownership-model.md
update-when: a safety check is added/moved between compile-time and runtime, a new threat class is probed, or the overflow default changes
last-verified: 2026-07-22
-->

# Memory safety: Milo vs Rust, battle-tested

Memory safety is the whole reason a safe systems language exists, so this doc doesn't argue it — it *probes* it. Each row below is a real program (`scratchpad/safety/*.milo` during the sweep) that tries to trigger the unsafe outcome, run through the shipped compiler. The bar is simple: **no silent undefined behavior.** A threat is handled if it's caught at compile time (best) or trapped at runtime (fine — a defined abort, not UB). A *miss* is a program that runs clean and produces the corrupt result.

Result of the first sweep (13 probes, 2026-07-22): **zero silent-UB misses.** One finding, and it's a documentation/policy gap (overflow wrap in release), not a soundness hole — see below.

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
- **arena + `usize` index** (rustc's own choice, petgraph, most compilers) — a stale index is **not caught at all**: you silently read the wrong slot.

Milo's `Arena<T>` + generational `Handle<T>` is **strictly better than the raw-`usize` arena** (the generation catches the stale access Rust's index silently returns) and **comparable to `Rc<RefCell>`** (both runtime) without the refcount/leak cost. So apples-to-apples — arena vs arena — Milo is equal-or-better, not worse. Runtime detection here is the *ceiling for the data shape*, in both languages.

## The one place Rust is genuinely ahead: stored borrows

A type that *stores a borrow* of data owned elsewhere:

```rust
struct Parser<'a> { input: &'a [u8], pos: usize }   // Rust: compile-time view↔buffer tie
```

Milo can't express this — refs are second-class. You own the buffer and hold an integer offset instead (`std/json` does exactly this). Still memory-safe (bounds-checked), but you lose the compile-time guarantee that a view can't outlive or mismatch its buffer — a *logic* bug Rust's `'a` would catch. This is the single, fenced tradeoff. See [ownership-model.md](ownership-model.md).

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

**Rust, from its own source:** `core::contracts` exists (`requires`/`ensures`, issue #128044, RFC 3484) but is **unstable**, and it lowers to **runtime** assertions (`-Z contract-checks`) — rustc ships no SMT solver. Static, compile-time proof of Rust contracts requires **external** tools outside the compiler: Kani (CBMC), Creusot (Why3), Prusti (Viper). So Milo's built-in `milo prove` ≈ "Creusot/Kani in the box," and Milo's runtime-assert mode ≈ Rust's shipped contract behavior.

**Honest frontier.** Milo's prover is not a general verifier. It discharges **linear scalar** arithmetic over integers at call sites and returns; it reports **`unknown`** (not `proven`) for nonlinear/bitwise expressions (`*` of two variables, `&`, `<<`), `Vec.len()` reached through a builder, and struct-field loop invariants. `unknown` ≠ `failed` — it means "not discharged statically," and in `--debug` that clause still holds the line at runtime. The win is real but bounded: simple numeric contracts are proven away for free; richer ones fall back to runtime. See [prover-frontier](design.md) notes.

## Finding #1: overflow wraps in release, docs claim otherwise

- **Observed:** `2147483647 + 1` at `i32` → `-2147483648` (silent wrap) under `milo run`, default `build` (-O2), and `--release`. Only `--debug` traps (`runtime error: integer overflow`).
- **Cause:** the checked-arith emission (`llvm.sadd.with.overflow` → abort) is gated behind `this.debugOverflow` in `src/codegen.ts` (~line 3425), set only in debug mode.
- **Severity:** not a memory-safety hole — wrapping is defined behavior, no UB. It's a **policy/doc mismatch**: design.md's decided default is "trap in all build modes," but the shipped default is Rust-parity (debug trap, release wrap). design.md §Overflow now states the shipped status honestly.
- **To close:** ungate `emitCheckedArith` to all modes, leaning on range analysis so the release cost stays near zero (the machinery already exists). Div-by-zero and `INT_MIN/-1` are already always-on; overflow is the last case.

## How to extend this battle-test

Add a probe to `scratchpad/safety/`, or a runnable Rust↔Milo receipt to `rust-comparison/` (with a `rust.rs` + `milo.milo` pair and `./run.sh`), or promote the compile-caught ones into `tests/errors/*.milo` with an `// @error:` annotation to lock them as regressions. Each probe should trigger exactly one unsafe outcome. Classify by running it: a compile error or a runtime trap is a pass; a clean run with the corrupt result is a miss to file here. Candidate threats not yet probed: data races across green tasks (channels vs shared `var`), `Promise.blocking` `Send` enforcement, FFI boundary (`extern` returning a freed pointer), slice-into-wrong-buffer (the span↔buffer tie gap), and reentrancy of a module-scope arena.

## See also

- [ownership-model.md](ownership-model.md) — why no lifetimes; the Rust→Milo pattern table
- [design.md](design.md) — §Overflow (shipped status), §Ethos (principle ordering)
