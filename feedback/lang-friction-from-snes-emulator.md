# Milo language/runtime friction — from building the SNES emulator

Collected building `examples/apps/snes/` (two CPU cores — 65C816 + SPC700, all
opcodes Harte-validated — plus bus, cartridge, MMIO, DMA, and a BG1 renderer;
~3500 lines). Complements `lang-friction-from-genesis-emulator.md`; where they
overlap I note it (those are now confirmed recurring, i.e. higher priority).

## Honest overall assessment (keep this — it's the point)

Milo was the *right* tool for this. Reads like Rust-with-less-ceremony (borrow
checker, moves, Result/Option, match) and that's exactly what a cycle-exact
emulator wants. The **i64-masked-register trick** (hold every CPU register as an
i64, `& 0xFF`/`& 0xFFFF` at width) sidestepped all the u8/u16 wrapping friction
you'd fight in C. Never once wished for C — C would've handed me the exact memory
bugs Milo prevented (DMA reentrancy, the SPC port latches, 24-bit address math)
with no safety net.

Is it memory-safe? Mostly yes, and it earned trust. The borrow checker caught
real mistakes (see #4). **Nearly every bug in the whole build was logic, and the
Harte single-step tests — not crashes — found them:** decimal-BCD carry-capping,
the emulation stack page-1 wrap, SPC700 DIV's overflow quirk. Debugging behavior
instead of segfaults is the tell of a safe language. One real asterisk (#1).

---

## 1. RUNTIME MEMORY-SAFETY HOLE — string realloc corrupts a live Vec (serious)

Growing a `string` via `.push()` across many iterations **while a large
`Vec<i64>` is simultaneously live** corrupts the heap → SIGTRAP/SIGSEGV
(exit 133/139). This should be impossible under the safety guarantees — it's an
allocator bug, not a logic bug.

Repro shape (SNES PPU → PPM export):
```milo
var fb: Vec<i64> = Vec.new()
var i = 0
while i < 256*224 { fb.push(0) i = i + 1 }   // ~57k-elem Vec, ~459 KB
renderFrame(p, fb)
var out = ""
i = 0
while i < 256*224 {                           // ~172k pushes onto `out`
  let px = fb[i]
  out.push(((px>>16)&0xFF) as u8) ...          // <-- faults partway through
}
```
Each piece works **in isolation**: 172k string pushes alone — fine; `writeFile`
of a 172 KB string with embedded nulls — fine; reading `fb[i]` after render —
fine. Only the *combination* faults, i.e. a `String` realloc appears to clobber
the `Vec`'s buffer (or vice-versa).

**Workaround:** pre-size the string so it never reallocs —
`var out = String.withCapacity(200000)`. That fixed it.

**Fix:** this is a real allocator/GC bug in the runtime; a memory-safe language
must not let one heap object's growth corrupt another. High priority.

## 2. Debugging hazard — buffered stdout is discarded on a crash

When #1 (or any trap) hits, all buffered `print` output is lost, so under a pipe
it looks like a **silent `exit 0`** — deeply misleading (I first thought main was
being optimized away). Had to bisect with `writeFile("/tmp/mark.txt", "stage N")`
marker files because prints never flushed.
**Fix:** flush stdout on abnormal termination (signal handler / atexit), or make
`print` line-buffered to a TTY and flush before any `abort`.

## 3. std/json accessors clone the whole source per call → OOM (sharp edge)

`Json.at`/`Json.get` call `jsonExtractSubtree`, which does `src.source.clone()`
— copies the *entire* input string (3.8 MB here) on **every** accessor call.
Navigating one large doc a few thousand times → tens of GB → OOM kill. Safe, but
a trap. Workaround: don't use the tree accessors on big docs — flatten to a
whitespace int-stream with a tiny TS preprocessor and tokenize in Milo (the
`harteConv.ts` + `runHarte.milo` pattern; same trick the genesis build used).
**Fix:** zero-copy accessors that return a lightweight `{doc, nodeIdx}` view
instead of deep-copying the source. This is the single biggest stdlib papercut.

## 4. No split-borrow of distinct struct fields across a call (ergonomic)

```milo
spcReset(mem.apuSpc, mem.apuMem)   // apuSpc: &mut Spc, apuMem: &SpcMem
// error: 'mem' is borrowed mutably and shared in the same call
```
Two *different* fields of the same struct, one `&mut` one `&`, is rejected — the
borrow checker treats the whole `mem` as one borrow. Correct-but-conservative;
Rust allows this via field-level borrow splitting. Had to inline the reset. Minor
but recurred anywhere a fn takes `&mut` one sub-object and `&` another from the
same parent (common in a "bus owns CPU+PPU+APU" design).

## 5. `Vec` has no bulk-fill / `withCapacity` / `resize` (ergonomic + perf)

To make a zeroed 64 KiB/128 KiB buffer I wrote `vecZeros(n)` helpers that `push`
in a loop — verbose, and slow at -O0 (one-time, tolerable, but every module grew
its own copy: `vecZeros`, `spcZeros`, `ppuZeros`, `spcZerosI64`, `ppuZerosI64`).
**Fix:** `Vec.filled(n, v)` / `Vec.withCapacity(n)` / `Vec.resize(n, v)`.
(`String.withCapacity` exists — the Vec equivalents don't, which is also why #1
had no clean escape for the Vec side.)

## 6. `if`-expression integer literals still default to i32 (CONFIRMED recurring)

Already in the genesis doc; hit it again several times, e.g.
```milo
let mask = if wide { 0xFFFF } else { 0xFF }   // inferred i32
let a = reg & mask                             // i64 & i32 -> compile error
```
Fixed with `let mask: i64 = if ...`. Recurring across two independent emulators →
worth prioritizing context-directed int-literal inference. Hit it AGAIN this
session (`var end = 21` then `off + end`; `if mapMode==1 {0xFFC0} else {0x7FC0}`).

**DECISION (2026-07-13, with cs01): default context-free int literals to i64.**
Rationale: this codebase is i64-dominant (all arithmetic, every Vec/string index,
every loop counter); i32 is the annotated exception (FFI/widths). Keep target-type
coercion where there IS context (`let x: i32 = 5`, i32 fn params) — only the
no-context literal flips to i64. Won't hide bugs: a literal that truly needed i32
still errors at its typed use site. Rejected "require an annotation" (too much
ceremony — `var i: i64 = 0` on every loop). The strictly-better-but-more-work
option is real usage inference (defer the literal's type, unify across uses,
Rust-style) — ship the i64 default first, reach for full inference only if
papercuts persist.

## 7. Inconsistent `.len` (ergonomic)

`array.len` is **i32** (forces `while i < ops.len as i64`); `Vec.len` and
`string.len` are i64 field-style; `Json.len()` is a method. Four shapes for
"length". Pick one type (i64) and one syntax.

## 8. `&x` at a call site is address-of, not borrow (ergonomic; Rust-muscle-memory trap)

`&T` in a **param type** means borrow, but `&x` in an **expression** means
*address-of* → a raw `*T` that needs `unsafe`. Borrowing at a call site is
implicit — you pass the value bare and Milo borrows per the param signature.
```milo
fn peek(m: &Mem, addrs: &Vec<i64>): void { ... }
peek(m, &peekAddrs)   // error: expected &Vec<i64>, got *Vec<i64>; address-of needs unsafe
peek(m, peekAddrs)    // correct — auto-borrow
```
So the same `&` sigil means "borrow" in types but "raw pointer" in expressions.
Anyone with Rust reflexes writes `&x` and gets a confusing `*T`/unsafe error.
**Fix:** when the expected param type is `&T`, accept `&x` as a borrow (identical
to bare) — only treat `&x` as address-of in a `*T`/`unsafe` context. Then `f(x)`
and `f(&x)` both work; raw address-of still lives in the unsafe path. Small
call-site coercion change; non-breaking.

## 9. No function-local reuse of a borrow to a nested field (ergonomic; the big one)

Can't alias a deep path for repeated reads:
```milo
let p = &m.ppu      // rejected — refs are second-class (params only)
p.m7a; p.m7b; ...   // wanted; instead I wrote m.ppu.m7a / m.ppu.m7b dozens of times
```
This is the deliberate "no lifetimes" bargain (a stored borrow would need one).
But you don't need lifetime *syntax* to allow a **function-local** borrow: Milo
already infers borrow validity for params with no annotation — extend exactly
that to a `let`, legal **iff `p` provably doesn't escape** (can't be returned,
stored in a struct, or outlive `m`). That's a plain escape check, no lifetime
annotations, because the borrow never crosses an API boundary — lifetimes stay
banished from signatures (the whole design goal), they're just not needed for
something scoped to one function body (this is what Rust NLL already does *inside*
a fn; you only write `'a` at boundaries). Highest-value ergonomic unlock of the
three; it's an escape analysis, not a borrow checker. Related to #4 (both are
"the borrow model is more conservative than it needs to be inside one function").

(Deliberately NOT filed: "moves need manual reorder" — `busNew(rom)` consuming
`rom` then failing on reuse is *correct* ownership, identical to Rust, and the
diagnostic already suggests `.clone()`. Working as intended, not friction.)

---

## What worked well (so future agents lean into it)

- **i64-masked registers** — model 8/16/24-bit hardware as i64 + explicit masks.
  Zero wrapping bugs. Do this for any CPU core.
- **Borrow checker as a design aid** — the `&mut`/`&` conflicts it flagged were
  all real aliasing hazards in the bus/DMA/port-latch wiring.
- **External test suites gate correctness** — Harte SingleStepTests (`65816/`,
  `spc700/`) caught every subtle flag/quirk bug. Wire the oracle *first*, then
  fill opcodes. `testMode` flag on the memory struct kept the same core usable by
  both the test harness (flat sparse RAM) and the real bus.
- **Keep -O0 for big `match` dispatch** — the 256-arm opcode `match` is slow to
  compile at -O2 (known; prebuild binaries for the gates).
