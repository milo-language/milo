# Milo language/tooling friction — from building the NES emulator

Collected while writing `examples/apps/nes/` (6502 CPU core, PPU with per-scanline
renderer, APU with all 5 channels incl. DMC, mappers 0/2/4/9/227, SDL2 frontend;
~3000 lines). Consistent with the Genesis-emulator report: **every bug in the
whole build was logic/correctness, never memory unsafety.** I indexed
`[u8; 2048]` RAM, `[u32; 61440]` framebuffers, grew `Vec<i16>` sample buffers, and
did raw-pointer SDL FFI — the failure mode was always "wrong value," never
"corrupted heap." The safety is load-bearing and got out of the way. These are the
papercuts worth fixing, ordered by how much they cost.

## 1. `-O2` compile blowup on the large `match` (biggest — shapes the whole dev loop)

`step()` is a ~250-arm opcode dispatch. At `-O2` it takes **>3 min** to compile;
at `-O0` (`--debug`) it's ~6s. I built the entire emulator `--debug` and only paid
`-O2` when forced. For a systems language, "you can't afford optimizations during
iteration" is the dominant papercut — it dictates the workflow. This is pathological
LLVM switch lowering on one huge function, not fundamental.
**Suggestion:** emit a jump table / computed-goto for large dense `match` on an
integer, or split the match in codegen so the optimizer doesn't choke; failing that,
document/auto-tune an opt level that keeps big dispatchers cheap.

## 2. `match` is statement-only, not an expression (hit constantly)

```milo
// wanted:
let romPath = match argv.len > 1 { true => argv[1], false => pickRom() }
// reality: match can't be in expression position, so main()'s whole body
// lives inside the `Result.Ok(cart) =>` arm ("match is statement-only in Milo").
```
Corroborates the Genesis report (#3) — it bit again on a second project, on nearly
every `Option`/`Result` unwrap. Highest-value ergonomic add.
**Suggestion:** allow `match` in expression position (arms already have values).

## 3. Global `let: f64` initializer silently folds to 0 (an actual bug, not a nicety)

```milo
let CYCLES_PER_SAMPLE: f64 = 1789773.0 / 44100.0
// emitted: @CYCLES_PER_SAMPLE = internal global double 0   ← wrong, silently
```
A top-level const with a division expression became `0` at runtime with **no error**.
Had to precompute the literal (`40.58442176870748`). The silence is the danger — it
looks fine and produces wrong output. (Integer-literal errors like the Genesis
"integer constant must have integer type" surface loudly; this one doesn't.)
**Suggestion:** constant-fold const-expr initializers at module scope (or reject
non-foldable ones with an error instead of emitting 0).

## 4. References can't be bound to a local (recurring readability tax)

```milo
fn dmcFill(apu: &mut Apu, byte: i64): void {
    let d = &mut apu.dmc   // rejected — refs are second-class, params only
    d.bufferByte = byte
    ...
}
// workaround: change the signature to take &mut Dmc and pass apu.dmc through.
```
The second-class-reference rule is *correct* — it's exactly why I never fought a
borrow checker over lifetimes on the interconnected CPU/PPU/APU bus (`bus.ppu`,
`bus.apu` into `&mut` fns all day, zero friction). But a local `&mut` alias that
provably can't escape its scope feels like it should be allowed for readability.
**Suggestion:** permit non-escaping local reference bindings (scope-limited, can't
be returned/stored in a struct).

## 5. No `if let` / `while let` (verbosity on the common path)

Every "unwrap or bail" is a full `match` with qualified variants
(`Result.Ok(x) =>` / `Option.Some(line) =>`). For the frequent one-arm case
(`if let Some(x) = ...`) this is a lot of ceremony.
**Suggestion:** `if let` / `while let` sugar over single-variant matches.

## 6. No cheap runtime introspection — drove ~10 throwaway probe files

To answer "what's the APU writing?", "which CHR bank per scanline?", "how many IRQs
per frame?", the only tool was: add a debug field to a struct, `print`, rebuild
(~6s), run, revert. I did this ~10 times this session (`sndprobe`, `m227t`, `e.milo`,
…). With no way to introspect a running program cheaply, I leaned on **jsnes as an
external oracle** to compare output. A REPL, a `dbg!`-style value dump, or an
interpreter/`milo run`-interpreted mode for fast iteration would collapse this.
**Suggestion:** an interpreted fast-path (skip LLVM for iteration), and/or a
built-in `dbg!(expr)` that prints `file:line expr = value`.

## 7. Minor

- `print` always appends `\n`; needed `writeStdout` for exact byte output (nestest
  trace). A `print`/`println` split is the obvious fix.
- No incremental compilation — each probe rebuild is a full ~5-6s compile; adds up
  across dozens of diagnostic iterations.

## Not gaps (kept honest)

- `unsafe {}` being statement-only (bindings live inside it) — mild, correct design;
  everything memory-unsafe (SDL FFI, `*u8`, `SDL_GetKeyboardState` indexing,
  address-of casts) stayed contained there.
- Second-class references — a feature, not a gap (see #4).
- Generics, struct-by-value, FFI, fixed arrays, `Vec<i16>` growth, `f64` math —
  all just worked.

**If I could fix one thing:** the `-O2` match blowup (taxes every build).
**One *language* thing:** expression-`match`.
**The one real *bug*:** the silent `f64` const-fold-to-zero (#3) — worth attention
precisely because it fails silently.
