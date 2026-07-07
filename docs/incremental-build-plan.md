# Fix slow -O2 builds: aggregate zero-store pathology

> **DONE** (codegen.ts `zeroStore`/`valStore` helpers, threshold 128B). Large
> zero-inits now emit `llvm.memset`. Measured: a program that just calls
> `readFile` went **102.8s → 0.165s** at -O2 (600×); `serve.milo` builds in
> 0.35s. Regression coverage: `tests/zeroStore.test.ts` (IR asserts memset for
> 64KB, plain store for 8B) + `tests/fixtures/bigZeroBuffer.milo`. The enum
> zero-store sites were left as plain stores (always < threshold). Aggregate
> *loads* (see below) still unguarded — none > 16B in-tree yet.

## Root cause

The whole-program-in-one-module / no-incrementality framing is a red herring. The
slow -O2 build (~110s for hades) is **one function**: `File$readAll` in the std lib.

Milo zero-inits a 64KB stack buffer (`let buf: [65536]u8`) with a first-class
aggregate store:

```llvm
%buf.addr = alloca [65536 x i8]
store [65536 x i8] zeroinitializer, ptr %buf.addr
```

Clang's `InstCombinePass` chokes on the giant aggregate store — 86% of pass time,
~5.3B instructions retired on that one function.

## Measurements (hades, Apple M1)

| build | time |
|---|---|
| frontend only (emit-ir) | 0.22s |
| -O0 (`--debug`) full | 0.86s |
| -O2 full (today) | 110s |
| -O1 full (today) | 104s — **opt level is not the lever** |
| 10-way IR split + parallel clang -O2 | 105s — one chunk carries the whole cost (107% CPU, no parallel win) |
| `File$readAll` alone, -O2 | ~105s |
| `File$readAll` with `store` → `llvm.memset` | **0.03s** |
| full single-module -O2, all 48 big zero-stores → memset | **1.1s**, binary works |

IR is deterministic (byte-identical across runs) — content-hash caching is available
later if ever needed.

## The pathology

`store [N x i8] zeroinitializer, ptr %p` for large N. LLVM keeps it as a scalar
aggregate store through InstCombine instead of lowering to memset early; cost is
superlinear in N. hades has 48 such sites; sizes 1B–65536B. Only the 64KB one is
catastrophic, but everything ≥ a few KB contributes.

## Fix (codegen.ts)

Emit `llvm.memset` instead of an aggregate zero-store above a size threshold. LLVM
auto-recognizes the intrinsic — **no `declare` needed** (verified).

1. Helper: given `(ty, ptr)`, if `this.typeSize(ty) >= THRESHOLD` (typeSize exists,
   codegen.ts:159) emit
   ```
   call void @llvm.memset.p0.i64(ptr <p>, i8 0, i64 <size>, i1 false)
   ```
   else emit the existing `store <ty> zeroinitializer, ptr <p>`.

2. Route zero-store sites through the helper:
   - codegen.ts:794 — entry-alloca drop-glue zero-init
   - codegen.ts:802 / :845 — Let init / Assign stores (only when value is
     `zeroinitializer`)
   - codegen.ts:2041, 2483, 2658, 2904, 3154, 7315 — struct/local/loop zero-inits
   - The drop-glue sites are small types today, but the guard is free and
     future-proofs against large droppable locals.

3. Threshold: 128B is a safe guess. Real blowup is ≥ few KB. Tune if desired —
   memset is never *worse* than an aggregate store, so a low threshold is fine.

## Regression test

Milo test compiling a fn with a `[65536]u8` local under a wall-clock budget
(e.g. assert < 5s), or golden-IR check asserting large zero-stores emit `memset`
not `store ... zeroinitializer`.

## Explicitly out of scope (unnecessary at 1.1s)

- per-milo-file modules / separate translation units
- object-file caching
- parallel clang invocation
- default dev builds to -O1

All were proposed to work around the symptom. With the codegen fix the full -O2
build is ~1.3s (0.22s frontend + ~1.1s clang), so none are needed. Revisit only if
program size grows ~100x.

## Watch: aggregate loads

Big by-value array **loads** (`load [N x i8]`) hit the same InstCombine pathology
(array copy → should be memcpy). hades has none > 16B, so not triggered today. Guard
it in the same helper if cheap.
