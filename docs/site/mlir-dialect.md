---
title: MLIR dialect
---

Milo compiles through [MLIR](https://mlir.llvm.org) with its own dialect, `milo`. The
compiler parses and type-checks Milo, then emits milo dialect IR. `milo-opt` runs Milo's
passes on it (drop elaboration, bounds-check versioning, lowering of structured control
flow) and lowers it to LLVM, which produces the binary.

This page is the dialect reference, generated from
[`mlir/Milo.td`](https://github.com/milo-language/milo/blob/main/mlir/Milo.td) by
`mlir-tblgen`. The design and milestones are in
[docs/mlir-backend.md](https://github.com/milo-language/milo/blob/main/docs/mlir-backend.md).

::: warning Unstable (v0)
Ops and types still change between commits.
:::

<!--@include: ../dialect/milo.md-->
