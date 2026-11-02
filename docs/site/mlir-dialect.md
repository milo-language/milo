---
title: MLIR dialect
---

::: warning v0, unstable
The `milo` dialect is the compiler's middle layer: the frontend prints it, `milo-opt`
lowers it to LLVM. Ops and types still change between commits. This page is generated
from [`mlir/Milo.td`](https://github.com/milo-language/milo/blob/main/mlir/Milo.td) by
`mlir-tblgen`; the design and its milestones are in
[docs/mlir-backend.md](https://github.com/milo-language/milo/blob/main/docs/mlir-backend.md).
:::

<!--@include: ../dialect/milo.md-->
