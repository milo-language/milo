<!-- doc-meta
system: mlir-prototype
purpose: prototype milo MLIR dialect: Vec and bounds-check semantics as IR, loop versioning that removes checks a range test proves, lowering to LLVM with TBAA
key-files: mlir/Milo.td, mlir/Passes.cpp, mlir/test/kernels.mlir, mlir/test/version.mlir, mlir/bench/harness.c, mlir/run.sh
update-when: a pass, the lowering, a gate or the measured numbers change
last-verified: 2026-10-31 (prototype; hand-written input, no TS emitter yet)
-->

# milo MLIR prototype

Question: does a Milo dialect in MLIR raise the optimization ceiling over today's
LLVM IR codegen, on the loops where bounds checks matter?

## What LLVM cannot see today

`a[i] = a[i] + k * b[i]` compiled by today's codegen stays scalar at `-O3`, with a
bounds check every iteration. LLVM is missing three Milo facts:

1. An element store never changes a Vec header, so `b`'s data pointer and len need
   not be reloaded after every store to `a`.
2. A failed check is a panic a task can recover from, so writes made before it are
   observable: the check cannot simply be hoisted above the loop. The legal transform
   is loop versioning, which the default LLVM pipeline does not do here.
3. Distinct Vecs own disjoint buffers (not yet used; LLVM still emits a runtime
   overlap check).

## The dialect

- `!milo.vec<T>`: a Vec by reference (address of its `{ptr, len, cap}` header).
- `milo.vec.len`, `milo.vec.load`, `milo.vec.store`, `milo.bounds_check`.
- Effects use separate resources for header memory, element memory and panics, so
  fact 1 is ordinary MLIR side-effect data that passes query.

## Passes (`Passes.cpp`)

| Pass | Does |
|---|---|
| `milo-hoist-vec-reads` | moves `vec.len` out of a loop when nothing in it may write a header |
| `milo-version-bounds-checks` | for checks on `iv + c` against an invariant len: one up-front i128 range test, a check-free loop copy when it passes, the original loop otherwise |
| `milo-expand-checks` | `bounds_check` -> compare + call to the noreturn panic routine |
| `convert-milo-to-llvm` | full lowering; header and element accesses get sibling TBAA types |

Upstream passes do the rest: `loop-invariant-code-motion`, `cse`, `canonicalize`,
`convert-scf-to-cf`, then LLVM `-O3`.

## Results (`./run.sh`, Apple arm64, Homebrew LLVM 23.1.3)

| Kernel | Milo today | today + `noalias` on `b` | milo dialect |
|---|---|---|---|
| axpy, 4096 f64 | 0.276 ns/elem, scalar | 0.133 | **0.095**, vectorized |
| grid 1024x1024 stencil | 0.157 | 0.154 | 0.152 |

grid was already vectorized by LLVM; it is memory-bound and stays at parity.

## Gates (`./run.sh`, one command)

- FileCheck tests on the passes (`test/version.mlir`).
- Differential: 19 sizes, result bits identical across the milo-dialect pipeline,
  the same pipeline without versioning, and today's codegen.
- Panic: a short `b` fails at index `b.len` after exactly `b.len` writes, identical
  with and without versioning, including at the edge `b.len = a.len - 1`.
- Each was proven live by a planted bug: `slt` -> `sle` on the upper bound (panic
  gate red), dropping the lower-bound guard (FileCheck red), hoisting `len` past a
  call that may grow the Vec (FileCheck red).

## Not done

- Input is hand-written MLIR shaped like the frontend's output; no MIR -> MLIR emitter.
- Index forms beyond `iv + invariant`; steps other than 1 are accepted but bounded
  conservatively.
- Buffer disjointness (fact 3), DWARF, the C ABI, everything outside these kernels.

Build: `cmake -G Ninja -B build -DMLIR_DIR=/opt/homebrew/opt/llvm/lib/cmake/mlir`, then `./run.sh`.
