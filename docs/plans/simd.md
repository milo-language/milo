<!-- doc-meta
system: simd-plan
purpose: implementation plan for portable SIMD vector types in Milo
key-files: src/types.ts, src/codegen.ts, src/checker.ts, src/lower.ts, std/simd.milo
update-when: the vector type surface, the lowering, or the staging changes
last-verified: 2026-07-31
-->

# SIMD — implementation plan

**Goal.** Let a Milo program shade 4–8 pixels per instruction. Today there is no way to
express it: `grep -n 'SIMD\|<4 x ' src/` returns nothing, so a rasteriser inner loop runs one
lane at a time and gives up a real 3–5× against a C++/Rust renderer using NEON. This is the
one gap where another language is currently the right answer for a hot loop, and it is an
**intrinsics gap, not a design one** — nothing about ownership, second-class refs, or the
proof story is in the way.

## Shape: portable vectors, not target intrinsics

Take Zig's `@Vector` / Rust's `std::simd` model, **not** `vld1q_f32`-style NEON intrinsics.

- One type constructor, `Simd<T, N>` (`f32x4` etc. as aliases), lowering directly to LLVM's
  native `<N x T>`. LLVM then selects NEON on aarch64 and SSE/AVX on x86-64 from the same
  source.
- Elementwise `+ - * /`, comparisons yielding a mask vector, `select(mask, a, b)`, shuffles,
  and horizontal reductions.
- **No target-specific intrinsic surface in the language.** A `neon.milo` / `sse.milo` split
  would multiply the platform-suffix problem (`AGENTS.md` §platform split) across hundreds of
  names, and every arm would have to export the same surface anyway — which is exactly what a
  portable vector type already is.

This also keeps the safety story intact: a `Simd<f32, 4>` is a value type, `Copy`, with no
pointers and no aliasing. It needs no new checker rules, which is why this is a codegen and
type-plumbing job rather than a language-design one.

## Why LLVM makes this cheaper than it looks

LLVM IR has first-class vector types. `fadd <4 x float>`, `insertelement`,
`extractelement`, and `shufflevector` are all already legal in the IR we emit, and the
backend does instruction selection. So the work is:

1. `TypeKind` gains a `simd` tag (`{ tag: "simd", elem, lanes }`), and `llvmType` maps it to
   `<N x T>`.
2. Arithmetic in `codegen.ts` already switches on `int`/`float`; the vector cases emit the
   same opcodes with a vector operand type. Most binops need no new code path, only a type
   that answers "is float".
3. Load/store/alloca need alignment right (`align 16` for a 128-bit vector) — the one place a
   wrong answer is a real miscompile rather than just slow code.

## Sequence

**Stage 1 — the type and elementwise math.** `Simd<T, N>` for `T` in
{f32, f64, i8, i16, i32, i64, u*} and `N` a power of two, lanes 2–16. Construction from a
splat (`Simd.splat(1.0)`) and from a literal (`Simd.of(a, b, c, d)`); `+ - * /`, and
`extract(i)`/`insert(i, v)` with a **compile-time-constant** index. Rejecting a non-constant
lane index is what keeps this away from bounds checks entirely.

**Stage 2 — load/store against a slice.** `Simd.load(v, i)` / `Simd.store(v, i, x)` reading
`N` contiguous elements. This is where a rasteriser actually gets its speed, and where the
bounds question lands: the check is `i + N <= v.len`, a single check per *vector*, not per
lane. Shares the length reasoning with `docs/plans/bounds-check-elision.md` — worth landing
that plan's stage 1 first so a vector load in a loop is not paying a check per iteration.

**Stage 3 — masks, select, reductions.** Comparisons return `Simd<bool, N>` (LLVM `<N x i1>`);
`select(mask, a, b)` is the branchless conditional that makes a shader loop worth
vectorising at all. Reductions (`sum()`, `min()`, `max()`) map to `llvm.vector.reduce.*`.
Without masks stage 1+2 cannot express a z-buffer test, so this is not optional polish — it
is the stage that makes the rasteriser case work.

**Stage 4 — `std/simd.milo`.** Thin, documented aliases (`f32x4`, `i32x8`) plus the handful of
things worth writing once: dot product, clamp, lerp, transpose4x4. Nothing clever; the point
is discoverability via `milo api simd`.

## Deliberately out of scope

- **Auto-vectorisation.** LLVM's loop vectoriser already runs at `-O2`. Explicit `Simd<T, N>`
  is for the cases it cannot prove; do not build a second one.
- **Runtime feature detection / dynamic dispatch on AVX-512.** Build for the target you name.
  A multiversioning story can come later if anyone asks; it interacts badly with the
  reproducible-build property.
- **Scalable vectors (SVE, RISC-V V).** Fixed lane counts only. Scalable vectors are a
  different type system question (the lane count is not a constant) and would leak into the
  prover.
- **Prover support.** A contract mentioning a `Simd` value should degrade to `unknown`, not
  error. Vector lanes in the SMT translation are not worth it.

## Risks

- **Alignment.** An under-aligned vector load is a real crash on some targets and silent
  slowness on others. Get `align` right on every alloca/load/store from day one and add an IR
  test asserting it, rather than discovering it on a non-x86 CI runner.
- **ABI.** Passing a `Simd<T, N>` across an `extern` boundary must go through `src/abi.ts`
  classification, and vector arguments have their own rules on both SysV and AArch64. Simplest
  first move: **reject `Simd` in `extern` signatures** in stage 1 and revisit, rather than
  emitting a wrong-ABI call that works on one platform.
- **Measuring.** The claim to beat is 3–5× on the software rasteriser. It is no longer in
  flyby — that renderer moved to the GPU on 2026-08-02 — so the subject is now
  `benchmarks/softraster/`, which runs the same `bandRaster`, `spot`, `blurPass` and
  composite loops against synthetic geometry and reports the two halves separately.
  Benchmark that specific
  loop, on a quiet box, and report the honest number — including if it turns out LLVM's
  auto-vectoriser was already getting most of it.
