# Rust vs Milo — memory-safety receipts

Runnable proof behind the [Memory Safety vs Rust](https://cs01.github.io/milo/language/vs-rust) page. Each folder holds the **same bug written twice** — `rust.rs` and `milo.milo` — so you can watch both compilers handle it instead of taking our word.

```bash
./run.sh            # release mode (the shipped default for both languages)
./run.sh --debug    # debug mode (overflow + contract checks turn on)
```

Requires `rustc` (release uses `-O`) and the repo's `./milo` wrapper. Set `RUSTC=/path/to/rustc` for a non-PATH toolchain. The runner asserts every classification and a stable diagnostic/output substring, prints the observed result, and exits nonzero on drift.

## What each row proves

| Folder | rust | milo | Takeaway |
|---|---|---|---|
| `use_after_move` | compile-error | compile-error | **parity** — moved-value use rejected before codegen |
| `dangling_ref` | compile-error | compile-error | **parity** — can't return a reference to a local |
| `oob_index` | runtime-panic | runtime-trap | **parity** — no compile proof here, both trap (no UB) |
| `overflow` | wrap / debug-panic | wrap / debug-trap | **parity, honestly** — Milo's default matches Rust today |
| `stale_handle` | **ran clean → wrong value** | **caught → `None`** | baseline only — raw indices need hardening |
| `steelman_arena` | **caught → `None`** | **caught → `None`** | **parity** — generational keys close the stale-slot bug |
| `contract` | runtime-panic (assert) | **compile-error** | **Milo ahead** — contracts proven at compile time |

## The comparisons that matter

**`stale_handle`** is a baseline, not the Rust steelman. It shows why a raw
`Vec<T>` index is insufficient: after slot reuse, the old index reads a different
value. **`steelman_arena`** then uses the typed `(slot, generation)` key design of
Rust's `slotmap` / `generational-arena` ecosystem and catches the stale access,
just as Milo does. The honest difference is packaging: Milo ships this abstraction
in `std/arena`; Rust normally gets it from a crate or a small domain-specific arena.

**`contract`** shows Milo's built-in advantage: `requires`/`ensures` are in the language and `milo prove` discharges its supported linear fragment at compile time. Stable Rust has no built-in stable contract facility; an ordinary call commonly uses `assert!`, while const assertions, newtypes/typestate, and external verification tools cover stronger Rust designs when code is structured for them.

## Honesty notes

- **`overflow` is deliberately a tie.** Milo's *decided* default is trap-in-all-modes, but as shipped the trap is gated to `--debug`; release wraps, exactly like Rust. We show the real behavior, not the aspiration.
- **Not shown here:** the case where Rust genuinely leads — a struct that *stores a borrow* (`Parser<'a> { input: &'a [u8] }`). Milo can't express it (own the buffer + an index instead). That's the real cost of having no lifetimes; see the site page.
