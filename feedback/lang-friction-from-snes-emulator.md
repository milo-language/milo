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

## 1. RUNTIME MEMORY-SAFETY HOLE — string realloc corrupts a live Vec (serious) [RESOLVED 2026-07-14]

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

**RESOLVED (verified 2026-07-14):** fixed by drop-old-value + in-place
string-append codegen; locked by `tests/fixtures/vecStringLiveGrow.milo`.
Re-verified this session — 100+ runs (serial / 24-way parallel / under the guard,
`-O0`/`-O2`/`-O3`), all clean and correct. NB the fixture *looks* red under
`bun test -t vecStringLiveGrow` — that's a harness artifact (guard pressure-kill +
lost stdout, see the README entry), **not** a regression; it's green in the full
suite.

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

## 8. `&` is overloaded — borrow in types, address-of in expressions (clarity; must fix)

`&T` in a **param type** means *borrow*; `&x` in an **expression** means
*address-of* → a raw `*T` that needs `unsafe`. Borrowing at a call site is
implicit (pass bare):
```milo
fn peek(m: &Mem, addrs: &Vec<i64>): void { ... }
peek(m, &peekAddrs)   // error: expected &Vec<i64>, got *Vec<i64>; address-of needs unsafe
peek(m, peekAddrs)    // correct — auto-borrow
```
Same sigil, two meanings, split by position — this is the C++ `&` mess (address-of
/ reference-declarator / bitwise-and) we don't want. A first-pass "fix" of *accept
`&x` as a borrow when a `&T` is expected* was **rejected (cs01):** it makes `&`
mean borrow-or-pointer by context — strictly worse.

**The requirement: `&` gets exactly ONE meaning, no context-sensitivity.**

**DECISION — Design A (2026-07-13, red-teamed by a Fable subagent that swept every
`&`-address-of site in `examples/` + `std/`):** `&` is *only* the borrow marker and
*only* appears in types. `&x` in expression position is a hard error:
*"borrows are implicit — pass `x` bare. For a raw pointer use `v.ptr()` (buffer)
or `addrOf(x)` (any value, unsafe)."*

Raw pointers (FFI only) get **two named ops, split by meaning — the split is
load-bearing, not pedagogy:**
- **`v.ptr(): *T`** on `Vec<T>` → the backing **data** pointer. **Safe to call**
  (mirrors the existing `string.cstr()`, which already returns `*u8` with no
  `unsafe`). May be **null when `len==0`** — strictly safer than today's
  `(&v[0])`, which bounds-panics or is UB on an empty Vec. `string` keeps
  `.cstr()` (its contract is NUL-termination); do **not** add `string.ptr()`.
- **`x.addrOf(): *T`** — **method** (cs01 chose method over free-fn, 2026-07-13, to
  stay uniform with `.ptr()`), lvalue-only (Ident / field / index; **temporaries
  rejected** — kills the dangling-rvalue hazard), and **requires `unsafe` to call**
  (taking a stack/field address is the escape-prone op, unlike `.ptr()` into an
  owned heap buffer). It feeds `memcpy`/ioctl out-params/generic byte-surgery;
  every current site is already in an `unsafe` block → zero migration churn.
- **DECIDED (cs01, 2026-07-13): passing a raw `*T` to an extern requires `unsafe`.**
  Resolves the doc/impl contradiction below in favor of the doc: obtaining a
  pointer (`.ptr()`, `.cstr()`) is safe, but handing a real `*T` to C — even a
  read like `strlen(p)` — needs an `unsafe` block; `0 as *T` stays safe. So
  `unsafe { memcpy(dst.ptr(), src.ptr(), n) }` — the dangerous boundary can no
  longer hide as safe code. (`.addrOf()` already forces `unsafe`, so its extern
  uses are covered by the same block.)
- **Why not one unified name:** `std/sync`'s generic `addrOf(v)` needs *header*
  semantics when `T = Vec` ("address of the slot"), while `.ptr()` means the
  *buffer*. A single "collections mean the buffer" rule would be incoherent in
  generics. Rust (`as_ptr` + `addr_of!`), C++ (`.data()` + `std::addressof`), Zig
  (`.ptr` + `&x`) all keep both — nobody unified them.
- **Pointer→pointer casts stay `unsafe`** (type punning deserves the marker). So
  `texBuf.ptr() as *u8` (a `Vec<u32>` fed to an SDL `*u8`) **keeps its `unsafe`
  block** — only same-typed buffers (`Vec<u8>`→`*u8`) actually shed it. Don't
  oversell the ergonomic win.
- **Fixed arrays already coerce** (`[T;N]`→`*T` at call sites), so the current
  `(&ev[0]) as *u8` for a `[u8;64]` is *redundant* — migrate those to a **bare
  pass**, not `.ptr()`. The only genuine `.ptr()` customer is `Vec`.

Coverage: the sweep found exactly 6 address-taking shapes, all covered; **zero**
uses of `&buf[k]` at nonzero index, `&struct.scalarField`, or address-of-temporary.

**Must-fix holes (pre-existing, but this proposal makes them load-bearing):**
- Doc/impl contradiction: lang-ref says "unsafe when a param takes a raw `*T` not
  from auto-coercion," but the checker treats any `*T`→`*T` arg as safe (the
  `strlen(ptr)` example relies on it). With safe `.ptr()`, `memcpy(a.cstr(),
  b.cstr(), n)` — a raw write — type-checks with **zero `unsafe`**. Decide and
  align before shipping safe `.ptr()`.

Rejected alt (Design B): `&x` = borrow everywhere (Rust-familiar), address-of →
`&raw`/named, borrows become explicit. Also single-meaning, but (a) flips borrows
implicit→explicit (ecosystem-wide churn) and (b) puts `&` back in expression
position, so raw pointers next to it reintroduce position-blindness. **A wins:
after A, `&` appears in exactly ONE syntactic position (types) — nothing left to
confuse.**

## 9. No function-local reuse of a borrow to a nested field (ergonomic; the big one)

Can't alias a deep path for repeated reads — I wrote `m.ppu.m7a`, `m.ppu.m7b`, …
dozens of times because a local alias is rejected (refs are second-class, params
only). This is the deliberate "no lifetimes" bargain (a stored borrow would need one).

**Reframe (from the red-team): this is NOT a new borrow system — it's extending
the EXISTING slice-local machinery.** Slice locals already work: `let h = s[0..5]`
binds a `&string`-typed local that **freezes its source** (rejects mutation /
reassignment of `s` while `h` is live) and releases at scope pop (checker.ts slice
handling). Milo already has ref-typed locals with source-freezing; #9 just extends
slice-binding from `[a..b]` expressions to **field paths**. Smaller feature, and it
needs *conflict* checking (freeze the root against move/mutation/`&mut` while the
alias lives), not merely escape checking.

Syntax must respect #8 — **no `&` in expression position.** Two candidates:
```milo
ref p = m.ppu          // keyword form (terse); ref mut q = m.ppu for mutable
let p: &Ppu = m.ppu    // annotation form: the receiving TYPE requests the borrow
p.m7a; p.m7b           // read many fields, no repetition
```
The annotation form is the "one model" purist choice (borrows always requested by a
`&T` on the receiving side, never in expressions — identical to the call-site
rule). The `ref` keyword is terser but adds a third borrow-introduction form (after
param types and slice `let`s). **Pick one, don't ship both.**

**Granularity decision — MUST resolve, jointly with #4:** if `ref p = m.ppu`
freezes **all of `m`**, any later `m.apu` write or `render(m)` errors — that's
friction #4 (no split borrows) in a new costume, and it guts the m7a/m7b use case.
If it freezes **only the path `m.ppu`**, you need field-path-granular borrow
tracking — which *is* the #4 fix. So **#9-done-right subsumes #4; #9-done-cheap
(whole-root freeze) will disappoint.** Decide the granularity before locking.

Soundness traps to spec explicitly: `ref p = v[i]` then `v.push()` (must freeze the
Vec — slice pattern); a `ref` captured by a closure passed to `spawn` (escape —
must reject; confirm slice rules already cover closure capture, unverified);
moving the root while the ref is live; `ref mut` exclusivity vs reads through the
original path. Highest-value ergonomic unlock of the three.

(Deliberately NOT filed: "moves need manual reorder" — `busNew(rom)` consuming
`rom` then failing on reuse is *correct* ownership, identical to Rust, and the
diagnostic already suggests `.clone()`. Working as intended, not friction.)

---

## One-sentence mental model for pointers/borrows (from the red-team — memorize this)

**"A `&T` in a type means the receiver borrows it — you always pass values bare;
when C needs a real pointer, ask the collection for its buffer with `.ptr()`, or
take any value's address with `addrOf(x)` inside `unsafe`."**

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
