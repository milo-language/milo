<!-- doc-meta
system: mlir-backend
purpose: replace HIR (src/hir.ts, src/lower.ts) with a source-faithful top layer of the milo dialect emitted straight from the checked AST; desugaring becomes MLIR passes
key-files: src/emit-mlir.ts, src/lower.ts, src/hir.ts, src/checker.ts, mlir/Milo.td, mlir/Passes.cpp
update-when: a step below lands, or the op set changes
last-verified: 2026-11-04 (plan; nothing built)
-->

# Top dialect: HIR goes away

## Why

Today: checker → `lower.ts` (desugars into HIR: for-in, `?`, interpolation, temporaries, forks)
→ `emit-mlir.ts` (HIR → milo dialect). HIR is a second typed tree that duplicates facts the
checker already has, and its desugaring throws away the source shape that three upcoming
features need:

- **traceability**: an object range should map back to the source construct (`for x in v`,
  `a?`), not to a desugared loop;
- **raising** (`milo harden` rewrites) needs the source-level shape to print back;
- **requirements**: `@req` on clauses and items rides as op attributes from the source op.

## End state

- `emit-mlir.ts` reads the merged AST plus the checker's `CheckResult` (types per expression,
  resolved callees and methods, monomorphized instances, move and `&mut` facts). No `lower.ts`,
  no `hir.ts`.
- The milo dialect gains a **source-faithful top layer**: one op per source construct that HIR
  used to desugar (`milo.for_in`, `milo.try` for `?`, `milo.interp` for `$"..."`,
  `milo.if_expr`/`milo.match` as value-producing regions, statement-temporary scopes). Each op
  carries its source location and any `@req` attributes.
- **Desugaring is a C++ pass** (`milo-desugar`) that lowers the top layer to the existing core
  ops before every current pass runs. The semantics live in one place, docs/semantics/milo.md,
  and the pass cites the rule IDs (E-FORK-*, S-TEMP-*, E-PROPAGATE, MILO-O-consumedForIn, ...)
  the way the interpreter does.
- The 16 other importers of `hir.ts` (layout, noalias, startup, scaffold, mlir-debug, const-fold,
  owned-temp, track-caller, lazy-globals, headergen, c-guards, ...) take checker types
  (`src/types.ts`) and AST nodes instead.

## Gates

- Targeted fixtures per construct while porting; the reference interpreter is the oracle
  (`mlir-same --filter`).
- `scripts/gen-programs.ts --n 50` on a few seeds after the switch: random ownership programs,
  interpreter vs compiled.
- CI is the full gate. No local full runs (a hook blocks them).

## Risks

- `lower.ts` encodes ownership decisions (temporaries, forks, drop points) that tests pin only
  indirectly. The desugar pass must cite a semantics rule per decision; a decision with no rule
  is a gap to write down, not to copy silently.
- Compile time: one more pass. Measure once; not a blocker.
