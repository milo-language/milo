# Memory Safety vs Rust

Rust is the industry standard for safe systems code. The table below compares how Rust and Milo each handle the same memory-safety hazards — the rule for both being **no silent corruption**: every bug is either rejected at compile time (best) or trapped at runtime (a defined abort), never undefined behavior. Every row is a real program run through the shipped compiler; the runnable both-sides proofs live in [`rust-comparison/`](https://github.com/cs01/milo/tree/main/rust-comparison).

## What gets caught

`compile` = rejected before codegen · `runtime` = defined trap · `n/a` = the pattern can't be written

| Threat | Rust | Milo | How Milo does it |
|---|---|---|---|
| Use-after-move / double-free | compile | **compile** | move checker |
| Use-after-free (owned, `Box`/`Heap`) | compile | **compile** | `Heap<T>` is single-owner; second use is a moved-value error |
| Dangling return (`return &local`) | compile | **compile** | references are param-only, never returned |
| Stored borrow in a struct | compile (`<'a>`) | **compile** | rejected: references can't be struct fields |
| Iterator invalidation | compile | **compile** | borrow tracker rejects mutation while borrowed |
| Aliasing `&mut` + `&` | compile | **compile** | exclusivity check at the call site |
| Null deref | compile | **compile** | no null; `Option<T>` must be matched |
| Out-of-bounds (array / `Vec`) | runtime | **runtime** | bounds check, all build modes |
| Use-after-free (cyclic / graph) | n/a → runtime | **runtime** | generational `Handle` — a stale handle reads back `None` |
| Divide-by-zero, `INT_MIN / -1` | runtime | **runtime** (all modes) | always-on guard |
| Integer overflow | debug trap / release wrap | debug trap / release wrap | at parity today — see note |

No silent-UB holes: across the sweep, every unsafe pattern is caught at compile time or trapped at runtime.

## Where the two differ

| Pattern | Rust | Milo | Verdict |
|---|---|---|---|
| Mutable cyclic data (graph, doubly-linked list, parent pointers) | `&'a` rejected; use `Rc<RefCell>` (runtime panic + refcount) or arena+`usize` (**stale index caught not at all**) | arena + generational `Handle` — stale access reads `None` | **Milo equal-or-better** arena-vs-arena |
| Stored borrow (`struct Parser<'a> { input: &'a [u8] }`) | expressible, compile-time view↔buffer tie | can't store a borrow — own the buffer + integer offset (`std/json` does this) | **Rust ahead** — the one real cost of no lifetimes |

The stored-borrow row is the whole trade: Milo forbids the pattern (still memory-safe via bounds checks) and loses the compile-time tie Rust's `'a` gives — a *logic* bug, not a safety one. See [Ownership](/language/ownership).

## Beyond memory safety: contracts

Memory safety stops corruption; contracts stop *logic* errors — a function fed inputs it forbids, or breaking a promise about its result. This is where Milo pulls ahead: they're in the language, and the prover discharges them at compile time.

| Capability | Rust | Milo |
|---|---|---|
| Contracts in the language (`requires` / `ensures` / `invariant`) | `core::contracts`, **unstable** | **yes**, stable |
| Checked at **compile time** | no — needs external Kani / Creusot / Prusti | **yes** — `milo prove`, SMT solver |
| Constant-arg precondition violation | not caught | **compile error** |
| Checked at **runtime** | `-Z contract-checks` (unstable) | `--debug` asserts entry/return/loop |
| Compiled out in release | yes | yes |

Milo's prover is bounded — it proves linear scalar arithmetic and reports `unknown` for the rest (nonlinear, bitwise, collection lengths), falling back to runtime asserts in `--debug`. But for the contracts it covers, they're proven away for free, no external toolchain. See [Contracts & Safety](/language/safety).

::: tip Note on integer overflow
Milo's decided default is to trap overflow in every build mode. As shipped today the trap is gated to `--debug`; `run`, default `build`, and `--release` wrap silently — Rust-parity, not yet the target. Wrapping is defined (memory-safe, no UB); closing the gap is ungating the check to all modes. Div-by-zero and `INT_MIN / -1` already trap everywhere.
:::
