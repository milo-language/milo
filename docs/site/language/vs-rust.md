# Memory Safety vs Rust

Rust is the bar for safe systems programming, so the honest question is: what does Milo actually catch, and where does each language win? Every row below is a real program run through the shipped compiler. The rule is **no silent undefined behavior** — a bug is either rejected at compile time (best) or trapped at runtime (a defined abort, never corruption).

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

**Cyclic data — runtime isn't a downgrade.** For a mutable graph, doubly-linked list, or parent-pointer tree, Rust's borrow checker rejects the aliasing outright — there is no compile-time `&'a` version. Real Rust uses `Rc<RefCell>` (runtime `borrow_mut()` panic, refcount cost) or an arena with `usize` indices (a stale index is caught *not at all* — you silently read the wrong slot). Milo's generational `Handle` catches that stale access, so arena-vs-arena, Milo is equal-or-better.

**The one place Rust is genuinely ahead — stored borrows.** A type that holds a view into memory it doesn't own — `struct Parser<'a> { input: &'a [u8] }` — Milo can't express. You own the buffer and hold an integer offset instead (`std/json` does exactly this). Still memory-safe via bounds checks; what you give up is the compile-time tie between a view and its buffer, a *logic* bug Rust's `'a` would catch. This is the whole cost of having no lifetimes. See [Ownership](/language/ownership).

## Beyond memory safety: contracts

Milo has `requires` / `ensures` / `invariant` built in, and `milo prove` discharges them at **compile time** with an SMT solver — a violated precondition with constant arguments is a compile error, not a test that might miss. Rust's `core::contracts` exists but is unstable and **runtime-only**; compile-time proof needs external tools (Kani, Creusot, Prusti). Milo's prover is bounded — it proves linear scalar arithmetic and reports `unknown` for the rest, falling back to runtime asserts in `--debug` — but for the contracts it covers, they're proven away for free. See [Contracts & Safety](/language/safety).

::: tip Note on integer overflow
Milo's decided default is to trap overflow in every build mode. As shipped today the trap is gated to `--debug`; `run`, default `build`, and `--release` wrap silently — Rust-parity, not yet the target. Wrapping is defined (memory-safe, no UB); closing the gap is ungating the check to all modes. Div-by-zero and `INT_MIN / -1` already trap everywhere.
:::
