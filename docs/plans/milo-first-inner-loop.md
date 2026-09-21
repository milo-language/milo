<!-- doc-meta
system: milo-first-inner-loop
purpose: whether a Milo-hosted compiler can have a fast edit/test loop, and the prerequisites that decide it
key-files: src/main.ts, src/codegen.ts, tests/run.test.ts, src-milo/, docs/plans/compiler-host-language.md
update-when: `src-milo` is un-rotted, the IR differential harness lands, or a port slice actually starts
last-verified: 2026-09-21 (STATUS: paused. The self-host endgame was decided proof-only and src-milo frozen on 2026-09-20, roadmap.md §Self-Hosting; nothing here is scheduled, and the ratchets it names are not to be resumed by accident. Previous: 2026-08-04)
-->

# Milo-first: can the inner loop survive it?

Companion to [compiler-host-language.md](compiler-host-language.md), which asked whether a
rewrite makes the compiler *more correct* (answer: no). This asks the different question:
**if we go Milo-first anyway — for dogfooding and proof — does the edit/test loop hold up,
or is it a tarpit?**

Not a parity gate. Nothing here blocks on `src-milo` keeping up with `src/`; per
`feedback_no_selfhost_gate` that stays banned.

**Verdict: achievable, but conditional.** The test cycle is fine and gets *better*. The
compiler-rebuild step is the whole risk, it is 95% clang, and it is only survivable if
parallel codegen units land first. Two of the three prerequisites pay for themselves for
every Milo user whether or not the port ever finishes.

**Status 2026-08-04: prerequisites 1–4 all shipped.** Parallel codegen units (1.2–2.0x
end-to-end, 5x on the clang step), a real `milo test`, `src-milo` compiling again, and the
IR differential harness. **The harness immediately changed the estimate for prerequisite 5
— see "What the differential says" below.** The inner-loop question is answered: rebuilding
the 20.8k-line Milo compiler went from **8.01s to 2.06s**. The port's cost is now the open
question, not its iteration speed.

---

## What the loop costs today (TS host)

Measured 2026-08-04, 10-core M-series, this checkout.

| step | cost |
|---|---|
| rebuild the compiler after an edit | **0s** — bun runs `src/*.ts` directly |
| `bun run src/main.ts --help` (interpreter floor) | 0.028s |
| `build examples/hello.milo` end to end | 0.109s |
| `bun test tests/run.test.ts -t "arithmetic"` | 1.06s (was 33.9s — see below) |

Zero rebuild is the number a Milo port has to answer for. Everything else is noise.

## What the loop would cost (Milo host)

The frontend is not the problem. Measured over real programs:

| program | LOC | IR lines | frontend |
|---|---|---|---|
| `examples/tools/java-dap` | 2,950 | 115,813 | 0.21s |
| `examples/games/neon` | — | 54,671 | 0.17s |
| `examples/cli-tools/fmt.milo` | 1,321 | 55,780 | 0.15s |
| `examples/games/flight` | 10,635 | 135,056 | **9.68s** |

The `flight` outlier is not frontend scaling — it embeds four `@embedFile` city assets, and
that time is byte-string emission, the hot loop the backend has to chunk.
Read the other three rows: the frontend does ~100k IR lines in ~0.2s.

clang is the problem, and it is the *only* problem:

| stage | 115,813-line module |
|---|---|
| clang `-O0` | 0.49s |
| clang `-O1` | 0.92s |
| clang `-O2` | 1.02s |

Scaling across module sizes: 50k → 0.6s, 115k → 1.0s, 135k → 1.66s. The historical
self-host data point (2026-07-16, `src-milo` at 20k LOC → 240,583 IR lines) is **0.38s
frontend + 7.3s clang -O2 = 95% clang**.

**Extrapolated cost of one edit to a 40k-LOC Milo compiler: ~0.8s frontend + ~15s clang
-O2.** That is the tarpit, stated as a number. Fifteen seconds before a single test runs,
on every edit, is not a loop anyone iterates in.

---

## The lever that decides it: parallel codegen units — SHIPPED

**Landed 2026-08-04** (`src/cgu.ts`, wired through `linkIR`). Auto-enabled above 20k IR
lines; `--cgus=<n>` forces a count, `--cgus=1` restores the single module. Release (`-O3`)
and `-g` builds keep one unit deliberately — see the gates below.

| program | IR lines | single | split | |
|---|---|---|---|---|
| `examples/hello.milo` | 5,755 | 0.14s | 0.14s | not split, no overhead |
| `examples/cli-tools/fmt.milo` | 55,780 | 0.53s | 0.44s | 1.2x |
| `examples/games/neon` | 54,671 | 0.85s | 0.52s | 1.6x |
| `examples/games/volt` | 49,496 | 0.92s | 0.51s | 1.8x |
| `examples/tools/java-dap` | 115,813 | 1.41s | 0.70s | **2.0x** |

Those are whole-`milo build` times, frontend included; the clang step alone goes 1.02s →
0.20s (5x) on java-dap. **Verified by running all 824 fixture/error/runtime-error tests
with `MILO_CGUS=4` forcing every single compile through the splitter: 824 pass, 0 fail.**

Three findings worth keeping:

- **Unit count must track cores, not module size.** Sizing units as `lines/25k` starved a
  55k-line module to 2 units and made it *slower* than not splitting. More units was
  uniformly better on every program measured, including small ones.
- **Never scan byte-string payloads.** `examples/games/flight` emits a 147MB module with a
  single 37MB line from `@embedFile` assets; a char-at-a-time symbol walk over it cost
  708ms, more than the parallelism it was enabling. Both the reference scan and the rename
  now skip `c"..."` payloads.
- **Promotion must rename, not just unhide.** An `internal` Milo function can share a name
  with a libc symbol (`read`, `open`); making it globally visible under that name would let
  the linker resolve someone else's call into it. Promoted symbols become
  `@__milo_cgu.<name>` consistently across every unit.

The split path also falls back: any failure inside it re-runs the single-module build, so
it can cost time but can never turn a buildable program into a failed one.

### Porting it: the 18 undefined-handling decisions the TS original deferred

`src/cgu.ts` has to reach src-milo before milo-self can be the daily compiler — today
every self-build hands clang one 572k-line module (`scripts/selfhost-irsize.ts`). Harvested
here before `tests/uncheckedIndexRatchet.test.ts` was retired: 18 non-null assertions in 377
lines, the densest `!` concentration in the codebase. Each one is a place the TS author
chose not to answer "what if this is missing", and the Milo port has to — as an `Option`
handled at the use site, or an explicit panic that names what was absent. A wrong `!` in TS
is a TypeError at runtime; the same spot in Milo is either a clean handle or an `unwrap`
that aborts, so silence is not an option the port has.

| kind | sites | what the port must decide |
|---|---|---|
| index inside a loop over the same array (`lines[i]!`, `text[i]!`, `mod.funcs[i]!`, `home[i]!`, `funcs[b]!`, `load[u]!`, `load[best]!`) | 123, 133, 179, 184, 186, 227, 266, 278, 357 | Mostly dissolves: `for x in xs` binds by reference and needs no index at all. Where the index is genuinely needed (parallel arrays: `home[i]` alongside `funcs[i]`), Milo's bounds check makes it safe but the *pairing invariant* is still unstated — the port should carry both in one struct rather than two Vecs. |
| regex capture group (`m[0]!`, `m[1]!`, `m[2]!`) | 137, 141, 157, 159, 161, 241, 243 | The group that matters. A group that did not participate is absent, not empty, and the difference decides whether an unnamed `define` is skipped or mis-parsed as a symbol. Needs a real `match` per capture, with the "IR line we could not parse" case named — silently treating it as a non-function is how a whole CGU loses a symbol. |
| map/set lookup (`globalHome.get(g.name)!`, `[...seen][0]!`) | 295, 345 | `HashMap.get` is already `Option<V>` in Milo. Both sites assert an invariant established elsewhere ("every global was assigned a home"); the port should either return the invariant as a type (a total map built in one pass) or panic with the symbol name, which is the one message that makes a mis-partition debuggable. |

The two other `!` matches in that file (lines 56 and 148) are a regex literal and a string
compare, not assertions.

### The original measurement

The compiler emits **one** LLVM module and shells out to **one** clang. Measured, clang
parallelises across processes almost linearly on this box:

```
4 × clang -O2 -c (115k-line module), serial:    3.89s
4 × clang -O2 -c (115k-line module), parallel:  1.13s   → 3.4x
```

Splitting the emitted IR into N codegen units, compiling them concurrently, and linking the
objects turns the dominant 95% term into wall-clock `total/N`. This is exactly what rustc's
CGUs do, and it is a **backend** split — it happens after monomorphization, when the full
function list is already in hand, so it does *not* require the resolver rework that
`project_compile_time` correctly ruled out for per-module incremental compilation.

What it does require, from the emitted IR of `java-dap`:

- 921 `define`s, of which **865 are `internal`**. Anything referenced across a CGU boundary
  has to lose `internal` linkage (or be duplicated into each CGU that calls it).
- 1,415 module-level `@` globals and 129 `%T = type` declarations to partition or replicate.
- Stable mangling to keep cross-CGU references resolvable — `src/mangle.ts` already provides
  this.

Bounded, well-understood work with a real precedent. **Highest-leverage item on this page,
and it speeds up every Milo build in the repo, port or no port.**

With CGUs at 8-way plus `--fast` (`-O0` + no overflow/contract checks, already shipped,
measured 2.5x), the 15s edit becomes **~1–2s**. That is a loop.

### The escape hatch, if ~1–2s still isn't enough

The JS backend that this section once proposed as the loop (a
Milo-hosted compiler running itself on bun) was removed 2026-09-21: a second
implementation of the language's semantics cost a parity fix on most changes. The
remaining escape hatch is LLVM's `--target=wasm64` running under a wasm runtime, which
shares the one backend and so cannot drift from the native build.

---

## The test cycle: fine, and probably better

Two things matter here and only one is about the host language.

**Fixed today (this change): the targeted-test path.** `tests/run.test.ts` fanned out
compiles for *all* 577 fixtures in `beforeAll` regardless of `bun test -t`, so running one
test cost 33.9s. The lanes now mirror the `-t` pattern into the compile pool, so only what
will execute gets built:

| command | before | after |
|---|---|---|
| `-t "arithmetic"` (1 test) | 33.9s | **1.06s** |
| `-t "closure"` (17 tests) | 33.9s | 3.74s |
| `-t "zzzNoSuchFixture"` (0 tests) | 33.9s | 0.03s |

Bun scrubs `-t` from `process.argv` before a test file loads (verified on bun 1.3.10), so
the pattern is read back off the process's real command line, with `MILO_TEST_FILTER` as an
explicit override. It fails open — any trouble reading it means "compile everything", which
is slow, never wrong. This is a today-win, independent of any port.

**Host-language effect on the suite: mildly positive.** After a compiler change every
fixture must recompile no matter what language the compiler is written in, so the 577-fixture
sweep costs the same modulo per-invocation overhead — where a native Milo binary starts in
~1ms against bun's ~28ms, across 577 invocations. The test cycle is not an argument against
the port.

**The runner — SHIPPED 2026-08-04.** `milo test` was previously a regex scrape of
`fn testX(` plus a generated `main` that ran every test in one process, serially, with no
name filter: one trap ended the file and the count was papered over with
`totalPassed += Math.max(0, testFns.length - 1)`. It is now:

- **Discovery from the parsed AST**, not the source text — a `fn testFoo(` in a comment or
  string is not a test, and one written unusually is not missed. A `test*` function that
  cannot run (takes parameters, is generic) is **reported as skipped with a reason**.
- **One compile per file, one process per test.** That is what buys isolation: a failed
  assert, overflow, out-of-bounds or unwrap-on-`None` fails only its own test. Locked by
  `tests/miloTestRunner.test.ts`, which asserts a trapping file still reports 2 pass / 2 fail.
- **Parallel**, pool sized like the rest of the repo's fan-out (`MILO_TEST_JOBS`), every
  child guarded with a memory cap and a 30s timeout.
- **`-t <pattern>`**, substring or regex, and a pattern matching nothing exits 1 rather
  than reporting a vacuous green run.
- **Generic assertions** in `std/testing`: `assertEq`/`assertNe` work on any type `==`
  accepts and print both sides, `assertNear` for floats, `assertVecEq` for containers,
  plus `assertTrue`/`assertFalse`/`assertContains`. All take `&T`, so asserting on a value
  does not move it.

`assertVecEq` needed a checker fix to be callable at all: generic inference only matched
the top level of a parameter type, so `fn f<T>(v: &Vec<T>)` could not infer `T` from a
`Vec<i32>` and every call site needed a turbofish. The structural unifier the checker
already used for return hints is now applied to arguments too (fixture
`genericContainerInfer`).

---

## Prerequisites, in order

1. ~~**Parallel codegen units.**~~ **DONE 2026-08-04** — 1.2–2.0x end-to-end, 5x on the
   clang step alone, 824/824 tests green with it forced on every compile.
2. ~~**A real `milo test`.**~~ **DONE 2026-08-04** — process-per-test isolation, parallel,
   `-t`, generic assertions; locked by `tests/miloTestRunner.test.ts`.
3. ~~**Un-rot `src-milo`.**~~ **DONE 2026-08-04, and it was 7 errors, not a rewrite.** The
   damage was one API drift (`parseInt`/`parseF64` now return `Option<T>`), one borrow that
   outlived a field move, and one loop variable shadowing an outer `var i`. It builds in
   2.06s and the resulting binary compiles and runs a program correctly.
4. ~~**A differential harness before any porting.**~~ **DONE 2026-08-04** —
   `scripts/ir-diff.ts`, byte-exact plus a canonical-reorder comparison, baseline recorded
   in `tests/ir-diff.baseline.json`, regressions fail the run by name rather than by count.
5. **Then port, codegen first, checker last.** Codegen is the most mechanical, least
   graph-shaped stage and it is the one with an exact oracle. The checker is the most
   reference-heavy and the worst fit for second-class refs; it goes last, when everything
   else is proven.

Items 1–4 landed 2026-08-04. Items 1–2 were useful unconditionally, exactly as argued: both
ship to every Milo user whether or not a port follows. Item 4 then did its job immediately —
it repriced item 5 before any porting effort was spent on it.

## What the differential says — read this before funding the port

First census, 578 fixtures, `src-milo` against the current `src/codegen.ts`:

| bucket | count |
|---|---|
| byte-identical | **0** |
| agree after canonical reordering | **0** |
| differ | 336 |
| `src-milo` cannot compile it | 242 |

`src-milo` compiles **336/578 (58%)** of the corpus, and **none** of those 336 produce IR
the current backend agrees with — not even after normalizing top-level ordering. The
divergences are structural, not cosmetic: no `target triple` line at all, string constants
labelled `@.str0` vs `@.str.0`, and 3,727 emitted lines against the oracle's 5,760 on a
single arithmetic fixture.

This matters because the historical record is easy to misread. `src-milo` **did** reach a
byte-identical fixed point — on 2026-07-10, against the TS compiler *as it stood then*. The
TS backend has moved a long way since, and `src-milo` has not. So the honest reading of
"20,826 lines already written" is **coverage, not convergence**: the port is much closer to
starting over than the line count suggests, and re-converging is a real project rather than
the resync the parked-port framing implies.

That is exactly the number the harness existed to produce, and it cost one afternoon
instead of the months a port would have spent discovering it. Whatever is decided about
item 5, it should be decided against 0/578, not against 20,826.

## SELF-HOSTING REACHED — 2026-08-05

**milo0 compiles itself.** Verified end to end:

1. the TS oracle compiles `src-milo/main.milo` → stage 1
2. stage 1 compiles its own source → 343,806 lines of IR, exit 0
3. that IR links → a 2.29 MB stage-2 binary
4. stage 2 compiles `examples/hello.milo`, and the program runs and prints correctly

Three fixes separated "almost" from "working", and all three were the same species this
page has been cataloguing — a generated name or an internal disagreement, not a missing
feature:

- **`parseF64` was typed `f64` by the checker and `Option<f64>` by codegen.** `?? 0.0` on
  the result was rejected as "`??` on an f64". Self-inflicted, from an earlier fix that
  changed one side only.
- **`Vec.contains` / `Vec.clone` missing from codegen.** `clone` needed a real deep copy —
  a header copy aliases the buffer and double-frees it.
- **A parameter named `entry` collided with the `entry:` block label**, and LLVM refuses the
  module. Identical in kind to the `%t0` temp collision fixed earlier the same day; the
  oracle already emits `entry.bb` for exactly this reason. Any generated name must be one
  the source language cannot produce.

### What still blocks the fixed point

`stage2 == stage3` (stage 2 compiling itself byte-identically) is NOT reached. Stage 3
exceeded a 4 GB guard cap.

**Diagnosed, with measurements.** Stage-2 peak RSS against input size:

| input | source lines | peak RSS |
|---|---|---|
| `examples/hello.milo` | 5 | 27 MB |
| `tests/fixtures/arithmetic.milo` | 7 | 27 MB |
| `examples/cli-tools/fmt.milo` | 1,321 | **1,081 MB** |

That is ~0.8 MB retained per source line, which extrapolates to roughly 17 GB for
`src-milo`'s 21k lines — hence the cap kill.

**Root cause: milo0 never frees owned string temporaries.** The oracle does (`tempBufs` in
`src/codegen.ts`, each followed by `call void @free`); `src-milo/codegen/` has no equivalent
— zero matches for any temp-tracking. Every `emit(cg, "  " + a + " = " + b + "\n")` builds
several intermediate buffers and leaks all of them, and codegen runs that pattern millions
of times during a self-compile.

Ruled out first, so nobody re-checks them: the `s = s + x` append peephole DOES fire, including
for a field target through a `&mut` param (verified: emitted IR uses `realloc`, not
malloc+copy), so the historical O(n²) accumulator bug is not the cause.

**The fix is the oracle's shape**: track owned temporaries per site and free them once
consumed. It is a real ownership feature across codegen, not a patch — which is why it was
left rather than attempted at the end of a session.

### The number that actually matters: behaviour, not byte-identity

`scripts/ir-diff.ts --exec` links what milo-self emitted and runs it against each fixture's
`@expect` lines — the same contract `tests/run.test.ts` holds the TS compiler to.

| | |
|---|---|
| **behave correctly** | **468 / 578 (81%)** |
| wrong output | 3 |
| fails to link | **3** |
| cannot be compiled at all | **99** |

Started this sweep at 324 correct / 219 uncompilable / 19 link failures.

### What parallel agents changed about the method

Nine Sonnet subagents, each in an isolated git worktree owning a disjoint cluster, with the
orchestrator integrating serially and running the full behaviour census after every merge.
That split matters: the expensive part (reading emitted IR, bisecting to minimal repros) is
genuinely parallel, while shared-file merges and whole-corpus verification are not.

Findings worth keeping from that round:

- **Two single defects each unblocked ~70 fixtures**, and both had the same shape: one
  missing piece in a widely-imported std path cascading into every program downstream.
  First, a missing `_atomicSwapI64` — and behind the same fallthrough, the entire
  `_atomic*I32` family — silently absent from codegen, blocking 70 fixtures through
  `std/sync`. Second:
- **`MiloType.isPtr` being a `bool`.** `**u8` collapsed to
  `*u8`, which broke `std/platform` → `std/os` → most of the standard library. Compounded by
  a raw-pointer deref that silently loaded `i64` regardless of the real pointee type. One
  fix, ~75 fixtures.
- **A user function named `flush` was being hijacked by the `fflush` builtin.** Every call to
  `std/deflate`'s private bit-writer flush silently became `fflush(NULL)`, dropping the last
  byte of every compressed stream — gzip output that looked plausible and was corrupt.
- **Returned closures had stack-allocated captures** — a use-after-return, confirmed under
  lldb.
- **`llTypeBytes` defaulted to 8 bytes** for any struct it did not recognise, silently
  truncating a 32-byte struct copy inside a sort.

Every one of those is the same species this page has been cataloguing: a fallback or
sentinel that yields a plausible wrong value rather than failing.

**Cost worth recording:** the worktrees branched from `main`, which was 52 commits behind the
working branch, so one agent spent its entire budget re-fixing work that already existed and
six others had to merge mid-flight. Agents also share the git stash stack — two reported work
vanishing, one recovered it via `git fsck`. Brief every parallel agent to use WIP commits, and
make sure `main` is current before spawning any worktree.

### Earlier: the feature tail

The feature tail finally moved, and how it moved is the lesson: adding `Vec.clear` /
`HashMap.clear` unblocked **zero** fixtures, while two things that were not on the
missing-method list at all unblocked twelve. Rank by what a fix actually releases, not by
how often a symbol appears in the error log.

Mismatches started at 15 and link failures at 19; both buckets are now essentially closed.
Everything remaining is either the 219 that do not compile, or three named behaviour bugs.

Link failures started at 19 and are down to two. They were the cheapest bucket by a wide
margin — every one was a concrete codegen defect with a one-line reproduction, not a missing
feature.

A caution about this table's own history: the first version of the harness did not link a
fixture's companion `<name>.c` ABI peer, so all nine `externStruct*` fixtures reported as
link failures that were entirely an artifact of the measurement. Every figure below 341 that
this page previously quoted was understated by about eight. A harness is code and gets the
same scrutiny as the compiler.

Read that against **0/578 byte-identical IR**. Two independently written backends emitting
different IR is expected and says nothing; the same program producing different *answers* is
a bug. By the metric that matters the port is far healthier than byte-identity implied — but
57% is not close to done either, and this is the number to track from here.

Two real defects fell out of chasing the wrong-output list, both of the same shape:

- **`lookupVariantTag` returned -1 for "no such variant"** — a discriminant that legitimately
  *is* -1 (`enum Signed: i32 { Neg = -1, … }`) was then indistinguishable from absent, so the
  constructor compiled to a call to an undefined function. Fixed by making existence an
  `Option`, not the sign of a number. The first attempt at this added a second `hasVariant`
  predicate alongside the sentinel — smaller diff, same trap, and it left twelve call sites
  still asking the wrong question. The type is what makes the mistake unrepresentable.
- **Integer literals fell back to `0`** when they exceeded i64 (`18446744073709551615`, and
  the magnitude of i64 MIN). A `?? 0` had turned a compile error into a silent wrong answer.
  Now accumulated in u64, which covers every literal the language admits; the checker still
  decides whether the value fits the annotated type.

A third of the same kind, found by chasing link failures: **struct `==` compared only field
zero.** The aggregate-comparison path assumed field 0 was an enum's i32 tag and applied that
to every `%Struct`, so `Vec2{1,2} == Vec2{1,9}` was true. It passed the existing fixtures
only because their unequal values happened to differ in the first field — a test suite
agreeing with a bug. Now every field is compared and ANDed, recursing into strings; a field
milo0 cannot compare fails loudly instead of silently answering.

Chasing the rest of the link failures turned up four more defects of the same family:

- **`_strDataPtr` on a `&string` parameter** GEP'd the loaded aggregate instead of its
  address — the fixture's own header comment had already diagnosed it.
- **Block-scope drops did not exist.** A value declared inside an `if` branch was dropped at
  the function epilogue, whose alloca lives in a conditional block that does not dominate it
  — invalid IR as well as the wrong drop point. Now if-branches and loop bodies drop what
  they declared, which also stops a loop body accumulating one live alloca per iteration.
- **A parameter named `t0` collided with the temp counter's `%t0`.** Temps are now `%.t<n>`,
  a name Milo's own identifier grammar cannot produce.
- **Global initializers did no constant folding**, so `let A: f64 = 3.0 / 2.0` fell through
  to a zero fallback — which additionally spelled the zero as the integer `0`, invalid for a
  `double`. Literal arithmetic now folds, and the fallback zero is typed.

Three more of the same species turned up finishing the list:

- **Printing a float used a bare `%g`** — six significant digits — while `.toString()` used
  the round-trip helper. The two paths disagreed about the same value. f32 also needed its
  own helper: the shortest string that round-trips a `float` is not the shortest that
  round-trips the `double` it widens to (9 significant digits, read back through `strtof`).
- **Narrow signed integers zero-extended when printed**, so an `i8` of -128 printed 128.
- **A float-to-int cast returned the LLVM spelling instead of the surface type**, so
  `x as u8` was indistinguishable from a signed `i8` downstream and 255 printed as -1. That
  one only became visible *because* the sign-extension fix above was correct — the two bugs
  had been cancelling.

Two structural gaps closed after those:

- **Globals had no runtime initializer at all.** Anything not expressible as an LLVM
  constant — `pub let TAIL: string = "tail"`, or `FRAG = "head|" + TAIL` — stayed
  `zeroinitializer` forever and printed empty. There is now an init pass that runs from
  main before user code, ordered by dependency rather than source position, so a global may
  reference one declared below it.
- **An integer literal forced its operand to i64.** `0 - b` on an `i32` computed at i64
  width, so a wrapping subtraction printed 2147483648 instead of INT_MIN. The literal now
  takes its width from the other operand.

All are `feedback_silent_success` in miniature: a sentinel or fallback that reads as valid
data. Worth noting the second one was introduced *during this work* and caught only because
the behaviour harness existed — the IR-diff alone reported it as "compiles fine."

### The work list the harness produced

`scripts/ir-diff.ts` buckets every `self-failed` fixture by cause, so "what does milo0 still
need" is a ranked list rather than a guess. First pass closed four of them:

| fixed | was blocking | what it was |
|---|---|---|
| 64-bit hex in the lexer | 10 | `hexToDecStr` accumulated in `i64`, so `0x…` constants in `std/sha512` **trapped the lexer itself** — a crash instead of the checker's range diagnostic. Now `u64`. |
| `@!wrapping` module directive | ~10 | Unparseable, and one parse error cascades into dozens of bogus `<unknown>` type errors. Dropping it is correct for milo0 *specifically*: it emits no overflow traps, so wrapping is already its semantics. |
| `string.pushStr` | 43 | The single most-cited missing method. `genStringAppendInPlace` already existed for the `s = s + x` peephole, so this was wiring. |
| `bool.toString`, integer `rotateLeft`/`rotateRight` | 23 | `select` over two string literals; `llvm.fshl`/`fshr` with both operands equal. |

Second round went after the *parse* failures instead, because one parse error desyncs
milo0's parser and cascades into hundreds of bogus `<unknown>` type errors — so a single
parse gap can hide a whole file's worth of real signal:

| fixed | what it was |
|---|---|
| Option/Result queries | milo0 had **none** — `Option` was reachable only through `match`. Added `isSome`/`isNone`/`isOk`/`isErr`/`unwrapOr` (tag compare + a phi). The closure-taking combinators (`map`/`andThen`/`orElse`) are deliberately still absent rather than half-supported. |
| `from` as a soft keyword | milo0 lexed it as a hard keyword, so every `fn slice(src, from, to)` in std was a parse error. Now it introduces an import only when a string literal follows — exactly the TS compiler's rule. |
| let-else | `let Option.Some(v) = e else { … }`. Desugars in the PARSER to `let tmp = e` / `if tmp.isNone() { … }` / `let v = tmp!` — three forms milo0 already had, so no new node threaded through checker, lowering and codegen. |
| if-expression conditions | `let maxLen = if n - pos < MAX { … }` — the expression form forgot the no-struct-literal rule the statement form uses, so `MAX { n - pos }` parsed as a struct literal and died on the `-`. |

Third round found the same shape again — a parse gap masquerading as a missing feature:
milo0's parser did not accept an attribute on an **impl method**, so `std/math.milo` never
parsed and every `Math.*` call anywhere reported `unknown enum 'Math'`. Also fixed a genuine
silent-success bug in milo0's resolver: an unreadable import merged an EMPTY module instead
of failing, so a bad import path surfaced hundreds of lines later as a bogus "unknown struct"
against the caller. It now reports and exits.

Fourth round finished the parse tail: `in` as a soft keyword (same treatment `from` got —
`fn pick(from: i64, in: i64)` is legal), float exponent literals (`1e16`, `1.5e-3`, `2E+8`;
the lexer stopped at the digits and handed the parser a stray `e16` identifier), and
`@targetOs()` folded to a literal at codegen time. **Parse-blocked files: 52 → 8**, and the
last eight are each a distinct real feature (if-expression arms holding statements,
unqualified enum variants in patterns and calls, import aliases, ranged types `i32(0..100)`).

An earlier note here said milo0 could not parse the coherence-era `Some(...)` constructor.
Re-measured: std uses `Option.Some(...)` everywhere and the only bare `Some(` in std are in
comments. That blocker is gone from std; it survives only in the fixture corpus.

Third round went after the remaining parse gaps, since each blocks a whole file:
`f64.INF`/`NEG_INF`/`NAN` (a FieldAccess whose object is a TYPE name — mirrors
`floatNamespaceConst` in the oracle's `ast.ts`, and LLVM needs the hex IEEE forms),
attributes on struct fields (`@iter inner: …` in std/set), integer-repr enums
(`enum LogLevel: i32 { … }`) with explicit discriminants, and `enum as i32/i64` (the
discriminant IS the i32 tag milo0 already stores in field 0).

Net: **242 → 219 fixtures milo0 cannot compile; 336 → 359 it can. Fixtures dying at the
parser: 52 → 8.**

That last ratio is the useful one: **parse gaps were 44 of the 52 blocked files and they were
cheap**; what remains is the long tail of real semantics, where the rate is much worse.

Read that ratio carefully — it is the most useful thing on this page. Four features, one of
them the *most-cited* blocker in the corpus, moved the needle by nine fixtures. The reason
is that the per-method counts are "fixtures where this method appears among the errors",
not "fixtures unblocked by fixing it": most failing fixtures are blocked by several
independent gaps at once. Measured distribution over the 94 fixtures failing on missing
methods: **40 blocked by exactly one, 27 by two, 17 by three, and 10 by four or more.**

So the port does not have a lucky-fix shape. The remaining ranked head:

| fixtures | gap |
|---|---|
| 29 | still die at the parser, now on a long tail: `@` attributes in member position, `:` in several spots, `targetOs()` comptime, float exponents like `1e16` |
| ~20 | `<unknown>.*` — cascades from an earlier failure in the same file |
| 12 | `Vec.clear`, `insert`, `remove`, `keys`, `sort` |
| ~10 | string views: `lines`, `splitView`, `repeat`, `indexOfFrom` |
| — | Option/Result closure combinators: `map`, `andThen`, `orElse`, `mapErr` |
| — | Option/Result closure combinators: `map`, `andThen`, `orElse`, `mapErr` |

**Correction to an earlier reading of this page:** the `Receiver.method()` namespace model
was recorded here as unimplemented in milo0, on the strength of `Math.absI64(x)` reporting
`unknown enum 'Math'`. That was wrong twice over. milo0 already had the static-method path;
what actually broke was that its parser rejected an attribute on an *impl method*
(`@pure fn sqrt`), so `std/math.milo` never parsed and `struct Math` never registered — one
missing attribute loop, not a missing feature. The residual `unknown enum` in hand probes was
a third thing again: `MILO_ROOT` unset, so the import could not be read at all. The model
works; the port is that much cheaper than the previous revision of this page claimed.

**Rate, measured over four rounds: roughly 3 fixtures per feature, and falling.** Nineteen
features moved 242 to 219 — but the last three bought almost nothing, because the cheap
file-blocking parse gaps are now spent. At that rate the remaining 219 is dozens of features — and the ones left are
individually larger than the ones already done, because the cheap and highly-cited ones went
first. That is the number to plan against.

---

## The pitfalls, named so they can be avoided

- **Parity gating.** Already banned (`feedback_no_selfhost_gate`); it froze `milojs`'s
  release once. The differential harness reports a number, it does not gate a merge.
- **Resync churn.** `src-milo`'s recent commits are all chasing stdlib renames, not feature
  progress. A port must pin its own std snapshot and update deliberately, or it bleeds time
  to churn it did not cause.
- **Bootstrap paradox with live bugs.** Currently open and directly in the blast radius:
  `let m = v[i]` on a struct with heap fields silently deep-clones (AST/HIR nodes are exactly
  that shape), the for-in loop-var shadow that emits invalid IR with no diagnostic, and
  generic-struct statics needing a turbofish (backlog T1 #5 — every generic collection in a
  compiler). Fix these *before* the checker port, not during it.
- **Debuggability regression.** TS gives `console.log` plus an instant re-run. Milo gives
  `eprint` plus a rebuild — which is the whole reason item 1 comes first — or `hades` over
  DWARF. Budget for it rather than discovering it.
- **The operational hazard is real.** Unguarded `milo-self` has crashed this machine twice
  (`project_selfhost_guard`). Every self-host run stays guarded, no exceptions.

---

## Standing note

Nothing here changes the [host-language decision](compiler-host-language.md): a rewrite is
still not justified on correctness grounds, and the dominant defect class — incomplete
traversal reporting success — is invariant under host language. What this page adds is that
the *feasibility* objection is smaller than it looks, and it reduces almost entirely to one
buildable thing: stop handing clang a single 500k-line module.
