# Milo language/stdlib friction — from building the Genesis emulator

Collected while writing `examples/apps/genesis/` (two CPU cores — 68000 + Z80 —
plus a VDP, bus, and SDL frontend; ~2500 lines). Every *bug* in the whole build
was logic/correctness, never memory unsafety — the language held up well for
systems work. These are the papercuts worth fixing. Ordered by how often they bit.

## 1. `if`-expression integer literals default to i32 (hit repeatedly)

```milo
let size = if opmode == 3 { 1 } else { 2 }   // inferred i32
resolveEa(cpu, m, mode, reg, size)            // param is i64 -> compile error
```
Fix each time with an explicit annotation (`let size: i64 = if ...`). Happened
~a dozen times across the codebase. **Suggestion:** when an `if`/`else` expression
flows into a known-i64 context (param, annotated binding, i64 arithmetic), default
its integer literals to i64 — or make int-literal inference context-directed
rather than defaulting to i32 early.

## 2. Nested `if`-expressions evaluate to `void`

```milo
var fc = if cond1 { if cond2 { 6 } else { 2 } } else { if cond2 { 5 } else { 1 } }
// fc is void; later `fc | 0x10` fails: "operator '|' requires integer type, got void"
```
The inner `if` wasn't treated as its block's value expression. Had to rewrite as
statement form with a pre-declared `var`. **Suggestion:** a block whose final
statement is an `if`-expression should yield that if's value, recursively.

## 3. `match` is not an expression

```milo
var root = match doc { Result.Ok(j) => { j } Result.Err(e) => { return 1 } }
// error: unexpected token 'match'
```
Worked around with `var root = jsonNull()` then a `match` statement assigning into
it. Given the Rust lineage this was surprising. **Suggestion:** allow `match` in
expression position (it already has arm values).

## 4. Whole-program single namespace — no module-private functions

`fetch16`/`fetch32` were defined in both `m68k.milo` and `z80.milo`; merging both
into one program collided ("defined with different bodies"). Had to prefix the Z80
ones (`zfetch16`). **Suggestion:** module-private visibility (functions not
`export`ed are file-local), or at least a namespacing scheme so two independent
CPU cores can each have a `fetch16`.

## 5. `type` is a reserved word

Used `type` as a parameter name for a shift-operation selector; parser error.
Renamed to `sty`. Minor, but `type` is a natural identifier in emulators/compilers.

## 6. `std/json` clones subtrees on navigation → O(n²), OOM

`Json.at(i)` / `Json.get(key)` return an owned `Json` (deep clone of the subtree).
Navigating a 6 MB test file (8065 array elements, each accessed once) blew up to
5.8 GB and got killed by the memory guard. Had to abandon `std/json` and write a
flat whitespace-separated-int stream format + a hand tokenizer for the Harte test
harnesses (`harteConv.ts` + `runHarte.milo`). **Suggestion:** a borrowing / cursor
API (`at`/`get` returning a lightweight handle into the parsed doc) or a streaming
reader. This is the one place the stdlib actively forced a redesign.

## Tooling (not the language, but slowed edits)

- The formatter rewrites on save: collapses `arr[i] as i64` → `arr[i]as i64` and
  expands single-line struct literals to multiline. Exact-match code edits kept
  failing because the on-disk text mutated between read and edit. Re-reading before
  each edit near a struct literal became a habit. A stable/idempotent format (or a
  formatter that leaves `x as T` spacing alone) would help agentic editing.

## What worked well (so the next agent keeps it)

- `i64` + explicit-mask style for 8/16/32-bit wrapping arithmetic: fast to write
  correctly, no width-conversion bugs.
- Real tagged enums (`Ea.MemAddr(addr)`, `Result.Ok`, `Option.Some`) + exhaustive
  `match`: decode/dispatch code reads cleanly.
- Second-class `&mut` threaded through `step(cpu, m)`: emulators alias cpu/mem
  constantly; this avoided the borrow-checker gymnastics Rust would demand, with no
  lifetime annotations. Big ergonomic win for this domain.
- Memory safety is real: the only crash was an out-of-bounds that *panicked with a
  clear index/count* (buffer sized for H32/256, overflowed at H40/320) instead of
  silently corrupting — a one-line fix, not a heisenbug.
