<!-- doc-meta
system: collections-in-std-plan
purpose: plan for moving HashMap, Vec and string method bodies out of hand-emitted IR in codegen and into std Milo code
key-files: src/codegen-map.ts, src/codegen-vec.ts, src/codegen-string.ts, src/runtime/str.ll, src/builtin-members.ts, std/prelude.milo
update-when: a phase lands, a gate changes, or the type/body split is revisited
last-verified: 2026-10-31 (phase 1 in progress: contains, isEmpty moved)
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
- **HashMap**: the same split. A plain std struct was the first plan, but it needs three
  language features nothing else wants: a `.len` property on a struct, generic statics
  inferred from the expected type (`let m: HashMap<K, V> = HashMap.new()`), and borrowed
  two-variable for-in over a struct. Decided 2026-10-31: keep the `hashmap` tag; move the
  method bodies into `impl HashMap<K, V>` in `std/hashmap.milo`, one method per commit.
  The std code reaches the table through `self.addrOf() as *MapRaw<K, V>`, a struct with
  the `%HashMap` layout (`{data, len, cap, seed, tombs}`, slots `{i8 state, K, V}`), so
  the parts still in codegen (for-in, drop, display, unmoved methods) keep reading the
  same memory. Hashing goes through a std-only `hashOf` intrinsic that reuses
  `fnvHash`, so the two sides cannot hash a key differently.

Precedent: `std/prelude.milo` already defines `impl HashMap<K, V>` (`upsert`,
`getOrInsert`) and `std/string.milo` defines `impl string`. Builtin methods win over
inherent ones, so a body moves by deleting the builtin and adding the impl in one commit.

## Primitives std needs (phase 0)

A spike (generic `RawVec<T>` over `realloc`, `sizeOf<T>()`, `*p = x`, `*p` read) compiles
and runs today for `i64`, `string` and a `Drop` struct. `*p = x` is a raw write that does not
drop the old slot (right for uninitialized storage); `*p` is a bitwise move-out (right for
pop/remove and for dropping elements in a container's `Drop`). Checked 2026-10-31, most of it already exists:

1. **Pointer offset**: `p[i]` on a `*T` is a read and a place; `p[i].addrOf()` is the
   slot address.
2. **Borrow through a pointer**: `f(p[i])` passes `&T`, `f(&mut p[i])` passes `&mut T`.
3. **Move out of a slot**: `*p[i].addrOf()`.
4. **Store into a fresh slot**: `p[i] = x` used to drop the slot's old contents first,
   running drop on uninitialized memory. Fixed: a raw-pointer store never drops, the same
   as `*p = x` (fixture `rawSlotStoreNoDrop`).
5. **`hashOf`**: lands with phase 1, its only caller.

## Phases

| Phase | Work | Deletes |
|---|---|---|
| 0 | the three primitives above | nothing; unblocks 1-3 |
| 1 | `hashOf`, then HashMap method bodies into `impl HashMap<K, V>` in `std/hashmap.milo`, one method per commit, smallest first | the method half of `codegen-map.ts` |
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
- 2026-10-31: phase 0 closed (primitives exist; raw-pointer index store no longer drops
  the old slot, c0a3d294). Phase 1 started: `_mapHash`/`_mapKeyEq` intrinsics and
  `contains` moved to `std/hashmap.milo`. Corpus 1774/1774; planted probe-step bug turns
  `hashMapContainsStd` red; contains benchmark at parity (0.10s vs 0.10s). Also fixed
  `p as *P<i64>` (a pointer to a generic struct lost its `*` in `resolve`).
- 2026-10-31: `isEmpty` moved (`self.len == 0`). Planted `== 1` turns `hashMapIsEmptyStd` red.
