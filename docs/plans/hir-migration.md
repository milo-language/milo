<!-- doc-meta
system: src-milo-hir-migration
purpose: why src-milo's backend needs a typed HIR instead of re-deriving types from the AST, the slice order, and the terms the Unlowered bridge lands on
key-files: src-milo/ast.milo, src-milo/checker/expr.milo, src-milo/codegen/expr.milo, src/hir.ts, src/lower.ts, scripts/hir-ratchet.ts
update-when: a slice lands, the ratchet baseline moves, or the Unlowered bridge changes terms
last-verified: 2026-09-21 (STATUS: paused. The self-host endgame was decided proof-only and src-milo frozen on 2026-09-20, roadmap.md §Self-Hosting; nothing here is scheduled, and the ratchets it names are not to be resumed by accident. Previous: 2026-08-07)
-->

# Putting a typed HIR between src-milo's checker and its backend

## The problem

`src-milo/main.milo` ends type-checking like this:

```milo
return Compiled { ir: genProgram(finalProg, sourceDir), linkLibs: libs }
```

`genProgram` takes the AST. The `Checker` — every type it inferred, every method it
resolved, every borrow it decided to insert — goes out of scope one line later. Nothing
it proved reaches the backend.

So the backend re-derives all of it, in a weaker model:

| | checker | codegen |
|---|---|---|
| type representation | `TypeKind` union | strings (`Local.ty: string`) |
| type of an expression | `checkExpr → TypeKind`, total | `placeTypeStr → string`, **`""` when it fails** |
| method dispatch | 99 name comparisons | 82 name comparisons |

Three consequences, in order of how much they cost:

**`""` means "unknown", and callers read it as "skip".** `markReceiverMoved` opens with
`if tyStr.len == 0 { return }`. Fail to re-derive a type and the ownership bookkeeping is
silently skipped — no diagnostic, just a program that doesn't drop or doesn't move-zero.
There are 33 `return ""` sites feeding that. The three aliasing bugs found by the ASan
lane in `717573c6` are this shape, and finding them needed a sanitizer because the
compiler itself had nothing to say.

**80 method names are dispatched on in both walks.** Two independent re-implementations
of the same decision. Nothing forces them to agree; when they disagree the result is a
miscompile, not an error.

**The string encoding has already lost information that had to be patched back.** `[T; N]`
and `Vec<T>` produce the same type string, so `Local.isArr: bool` exists purely to recover
a distinction the checker never lost.

The AST has 30 expression kinds. `src/hir.ts` has 124. That gap is the measure of how much
gets re-decided: `MethodCall(obj, name, args)` is one node the backend fans out 82 ways
every time it sees one, where the oracle resolved it once into `VecPush`, `HashMapGet`,
`StringFind`, and so on.

## The target

`src/` already has the architecture, and it is clean: `src/codegen.ts` contains **zero**
references to `CheckResult` or any of its 16 `Map<Expr,…>`/`Set<Expr>` tables. All 20 live
in `src/lower.ts`. Checker facts die at the lowering boundary; codegen consumes HIR only.

`src/` is the spec, held hard — same taxonomy, variant for variant. Divergence buys nothing
and costs the differential-debugging property (compare milo-self against the oracle on the
same input) that drives fix velocity here.

## Why the last attempt died

`src-milo/hir.milo` + `src-milo/lower.milo` existed once: 1210 lines, deleted in `04738180`.
Nothing imported them, so nothing type-checked them, and they rotted against a moving AST.

The rule that follows: **replace, never parallel.** codegen reads HIR or it doesn't compile.
No file may exist that isn't on the build path.

## Slice 0 — done (`ede7acb6`)

`lower.milo` needs to key side tables by node. Milo has no object identity to key on, and
`Heap<ExprNode>` addresses can't stand in: deep-clone (`717573c6`, `77f90535`) exists
precisely so values read out of containers they don't own get fresh addresses.

`Expr` is a tuple-variant enum, so no field could be added without changing all 26 arities.
Wrapped instead:

```milo
pub struct ExprNode { id: u32, kind: Expr, span: Option<Span> }
```

`Heap<Expr>` → `Heap<ExprNode>`; the trailing `Option<Span>` deleted from all 26 variants
(the arity change is the forcing function — the compiler enumerates every site rather than
letting a missed one keep a stale duplicate span).

Ids are structural, not audited. `freshExprId` lives in one file with exactly two callers,
`mkExpr` and `ExprNode::clone`. **`Clone` allocates a new id** — a copied node is a new node,
and every caller (monomorphization instantiating a generic body, `renameExpr`,
derive-generated code) wants a fresh subtree, never an alias. `ExprNode` holds heap fields,
so it is non-Copy and plain assignment moves. No path yields two live nodes with one id.

Verification: pure refactor, so the type-re-derivation ratchet had to stay at 140 (it did),
and the fixpoint had to stay byte-identical (it did — stage2 == stage3, 573,003 lines).

## Slice 1 — done

`hir.milo` (transcribed from `src/hir.ts`), `checkExpr` recording `exprTypes`, and
`lower.milo`: statements become real `HStmt`, every expression rides `Unlowered`.

Three things this slice had to settle that the plan above did not anticipate.

**Lowering consumes the AST.** `impl Clone for ExprNode` mints a fresh id — deliberately,
per slice 0. But `exprTypes` and `forIns` are keyed by that id, so a cloned node is a node
with no recorded type and every lookup silently misses. Lowering therefore takes
`prog: Program` by value and moves: fields out with `replace`, payloads out by matching an
OWNED enum, vectors drained through a scratch Vec to keep source order. Nothing in
`lower.milo` clones an `ExprNode`. A pleasant consequence: after lowering, the AST is gone
except inside `Unlowered`, so nothing can accidentally read it.

Two live bugs fell out of that rule, both the same shape. `compile()` merged the
checker's monomorphized decls with `.clone()`, and `checkProgram`'s phase 4 *type-checked
a throwaway copy* (`let monoFn = ck.monomorphizedFns[i].clone()`) — so every type and loop
shape recorded for an impl method or a monomorphized body was keyed to nodes that died
with that local. Both now move.

**The checker records the for-in shape it picked.** `checkForIn` already decides between
range / vec / string / hashmap / array / iterator / channel / string-view in order to
declare the binding's type; the backend then decided it a second time from the syntax.
`Checker.forIns: HashMap<u32, ForInInfo>` records the answer, keyed by the ITERABLE
expression's node id — statements carry no id, and the iterable is unique per loop.
A missing entry is fatal at lowering. It is never a default: the four loop shapes iterate
different memory, so a wrong guess is a miscompile (walking a HashMap's slot array as a
Vec), not a diagnostic.

`ForInKind.FChannel` has no counterpart in `src/hir.ts`, which has no channel loop at all.
It lowers onto `ForIterator` with a trailing `okVariant`, since the sentinel meaning "kept
going" is `Result.Ok` for a channel and `Option.Some` for a `next()` iterator.

**`tyStr(cg, &TypeKind, what)`** is the replacement for `resolveTyStr(astTypeStr(...))`:
same output vocabulary, read off the checker's type instead of reconstructed from syntax.
It aborts on `TUnknown` rather than returning `""` — the empty string is the failure value
33 sites in this backend produce and callers read as "skip", and reintroducing it here
would carry that silent-skip class straight into the typed pipeline.

`HIRModule` carries a transitional block (`astTypeAliases`, `astTraits`, `astStructs`)
because the backend still resolves types as strings and that path needs syntax a
`TypeKind` no longer has. It goes when `tyStr` displaces `resolveTyStr(astTypeStr(...))`.

## Remaining slices

2. Literals, `Ident`, `BinOp`/`UnaryOp` — kills `hintTy` at the leaves.
3. `FieldAccess`/`IndexAccess` — kills `placeTypeStr`.
4. `Call` + `HIRArg{passByRef, refMut}` — auto-borrow decided once.
5. `MethodCall`, sub-sliced: Vec → HashMap → string → Option/Result → user methods.
6. `Closure`, `MatchExpr`/`IfExpr`, statements.
7. Delete `Unlowered`, `astTypeStr`, `placeTypeStr`, `hintTy`.

## The `Unlowered` bridge, on terms

One escape hatch, never two — a second means neither ever closes.

- **No `ty` field.** Structurally impossible to mistake for a lowered node.
- **Counted.** `scripts/hir-ratchet.ts` censuses construction sites; monotone to zero.
- **Deleted in the migration's final commit.** Surviving in the final enum is the failure.
- **Fail-closed.** Any codegen path that meets an `Unlowered` where it wants a type aborts
  naming the node kind. Never defaults, never falls through. A defaulting bridge is how a
  migration ships silently wrong code instead of failing loudly.

## Gates

Every slice: `scripts/selfhost.sh`, `selfhost-sweep.ts --check`, `selfhost-rejects.ts
--check`, `selfhost-fixpoint.sh`, `hir-ratchet.ts --check`. The fixpoint is the real one.

The ratchet is zero-tolerance, not a percentage: `--check` fails on any increase, and
`--write` refuses to raise a counter without `--allow-raise --reason "<why>"`, which is
recorded in `tests/hir-ratchet.json` where review can see it. Introducing the bridge in
slice 1 is the one expected raise.

Baseline at slice 0:

| counter | count | what it is |
|---|---|---|
| `hintTy` | 87 | an expected type threaded *down* the tree, standing in for a typed node |
| `resolveAstTy` | 21 | AST type → backend type string |
| `astTypeStr` | 19 | type string re-derived from syntax |
| `placeTypeStr` | 13 | place type re-derived; `""` on failure, read as "skip" |
| `Unlowered` | 0 | the bridge |
