<!-- doc-meta
system: collections-in-std-plan
purpose: plan for moving HashMap, Vec and string method bodies out of hand-emitted IR in codegen and into std Milo code
key-files: src/codegen-map.ts, src/codegen-vec.ts, src/codegen-string.ts, src/runtime/str.ll, src/builtin-members.ts, std/prelude.milo
update-when: a phase lands, a gate changes, or the type/body split is revisited
last-verified: 2026-10-31 (plan written; no phase started)
-->

# Collections in std

## Goal

Delete hand-emitted IR. Today `codegen-map.ts` (1173 lines), `codegen-vec.ts` (1850),
`codegen-string.ts` (533) and `src/runtime/str.ll` (348) build every collection operation
instruction by instruction. A bug there is invisible to the checker, the safety passes and
the move checker, because none of them see IR. The same logic written as Milo in `std` is
type-checked, move-checked, monomorphized like any generic, and optimized by LLVM. The
compiler shrinks; collection bugs become ordinary Milo bugs.

MLIR is not the route to less backend code: it replaces the builder and some passes (about
1.5k lines), not the Milo semantics that make up the bulk of codegen. It is the route to a
higher optimization ceiling; see the prototype in `mlir/README.md` (axpy 2.9x faster than
today, with bounds checks proven away by loop versioning).

## The split: the checker keeps the type, std owns the bodies

Rust's `Vec` is library code, but Rust has lifetimes to express what Vec does to borrows.
Milo has none, by design: its soundness rests on the checker knowing what Vec and string
are. Views of a Vec are invalidated by a growing call, `v[i]` is a place, `&[T]` shares the
Vec layout, `Vec<i32(0..9)>` refines elements, `verify.ts` reasons about `len`, and
bounds-check elision targets Vec indexing. Re-expressing those as library attributes would
mean new language machinery and pressure on the second-class reference rule.

So:

- **Vec and string**: the type tag, layout (`{ptr, len, cap}`), indexing, slicing, views,
  `len`, `ptr`, literals and for-in stay builtin. Method bodies (`push` growth, `insert`,
  `remove`, `sort`, `dedup`, `contains`, `split`, `trim`, ...) move to `impl Vec<T>` /
  `impl string` in std. The checker keeps each method's row in `builtin-members.ts` for its
  safety flags (`grows`, `retainsArg`); only the body moves.
- **HashMap**: becomes a plain std struct. Its checker coupling is shallow (drops, display,
  for-in, `len`, `new`/`withCapacity`, mangling), and a generic struct with a `Drop` impl
  gets all of that from the ordinary struct paths. The `hashmap` tag is deleted.

Precedent: `std/prelude.milo` already defines `impl HashMap<K, V>` (`upsert`,
`getOrInsert`) and `std/string.milo` defines `impl string`. Builtin methods win over
inherent ones, so a body moves by deleting the builtin and adding the impl in one commit.

## Primitives std needs (phase 0)

A spike (generic `RawVec<T>` over `realloc`, `sizeOf<T>()`, `*p = x`, `*p` read) compiles
and runs today for `i64`, `string` and a `Drop` struct. `*p = x` is a raw write that does not
drop the old slot (right for uninitialized storage); `*p` is a bitwise move-out (right for
pop/remove and for dropping elements in a container's `Drop`). Missing:

1. **Pointer offset on `*T`**, scaled by `sizeOf<T>()`, in place of `as i64` arithmetic.
2. **Borrow through a pointer**: pass `&T` / `&mut T` of `*p` to a callback or method
   without moving out (unsafe). Needed by every borrowing read (`each`, `modify`, `get`
   with `@copyOut` clone).
3. **`hashOf<K>(k: &K, seed: u64): u64`**: the structural FNV-1a hash codegen already emits
   (`fnvHash` in `codegen-map.ts`), exposed as a generic intrinsic, so std hashing matches
   today's byte for byte.

Each lands with a fixture and an error test (outside `unsafe` must fail).

## Phases

| Phase | Work | Deletes |
|---|---|---|
| 0 | the three primitives above | nothing; unblocks 1-3 |
| 1 | `std/hashmap.milo`: open-addressing table (same probe, seed and tombstone scheme), behind `MILO_STD_MAP=1`; flip the default; delete the old path | `codegen-map.ts`, the `hashmap` tag and its checker/lower/codegen cases |
| 2 | Vec method bodies to `impl Vec<T>`, a cluster per commit, largest first | most of `codegen-vec.ts` |
| 3 | string method bodies to `impl string` | most of `codegen-string.ts`, `runtime/str.ll` |

MIR drop elaboration (phase 2c) pauses until phase 1 lands: both
edit codegen, and every body moved to std becomes ordinary Milo that MIR covers without
special cases.

## Gates (every phase, every commit)

- **Fixture corpus**: `bun test tests/run.test.ts` green, and under the phase's flag. Proven
  live by a planted bug (wrong probe step in std HashMap) that must turn fixtures red.
- **Leaks**: a missing drop is invisible to stdout. Run the corpus under the leak checker
  the repo already uses for drop work; a moved collection must not add a leak.
- **Runtime**: `./benchmarks/run.sh` map/vec/string benchmarks within noise of the
  pre-change numbers. Library code inlined by LLVM should match hand-emitted IR; measured,
  not assumed.
- **Compile time**: std HashMap is monomorphized per `<K, V>`; record fixture-corpus compile
  time before and after.
- **The number**: lines deleted from `src/`, reported per phase.

## Invariants

- HashMap iteration order stays per-process randomized (seeded); `derive-json` sorts keys
  and must keep doing so.
- A moved method keeps its `builtin-members.ts` safety flags until the checker can read them
  from the std signature; `tests/builtinMembers.test.ts` stays green.
- No phase changes surface syntax or program output.

## Progress log

- 2026-10-31: plan written. MLIR route evaluated and parked. RawVec spike passes.
