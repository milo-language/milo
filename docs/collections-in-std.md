<!-- doc-meta
system: collections-in-std-plan
purpose: plan for moving HashMap, Vec and string method bodies out of hand-emitted IR in codegen and into std Milo code
key-files: src/codegen-map.ts, src/codegen-vec.ts, src/codegen-string.ts, src/runtime/str.ll, src/builtin-members.ts, std/prelude.milo
update-when: a phase lands, a gate changes, or the type/body split is revisited
last-verified: 2026-11-01 (phase 1 done: every HashMap method, new and withCapacity are std/hashmap code)
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

## Phase 2: Vec method bodies (plan, 2026-11-01)

Same split as HashMap: the `vec` tag, layout `{ptr, len, cap}`, indexing, slicing, views,
`len`, `ptr`, literals and for-in stay builtin; method bodies move to `impl Vec<T>` in
`std/vec.milo`, one method (or one shared-helper family) per commit, with the HashMap gates.

Step 0, slice receivers. A `&[T]` / `&mut [T]` carries the Vec layout, and today's read-only
builtins work on it (types.ts, the slice-readable list). A std `impl Vec<T>` method does not:
`fn f(s: &[i64]) { s.firstOr(0) }` fails with "type '[i64]' has no method". Rule: a slice
receiver may call an `impl Vec<T>` method whose receiver is `self: &Self`; never a
`&mut Self` one (a view cannot grow or shrink its owner). Lands with a fixture before any
read-only method moves.

Order (cheapest and least coupled first; growth last, as with HashMap insert):

1. Read-only scans: isEmpty, first, last, get, contains, indexOf, position, any, all, find,
   each, enumerate, fold/reduce, sum, min, max. Equality for contains/indexOf must match the
   builtin's element comparison (it is restricted to int, float, string, bool).
2. In-place, no growth: swap, reverse, truncate, clear, pop, remove, retain. Drops must match
   (leak gate).
3. Allocating: map, filter, join, clone. `map` needs a method-level type parameter (std may
   use them, AGENTS.md).
4. Sorting: sort, sortBy, sortByKey. Read the builtin's algorithm first; std must be stable
   if it is, and the benchmark gate matters most here.
5. Growth: reserve, push, insert, extend, plus `Vec.new`/`withCapacity`/`filled`. push is the
   hottest method in the corpus: it must inline to the same fast path (capacity check,
   store, len bump) or stay builtin.

Stays builtin: len, capacity, ptr, slice, indexing, for-in, drop, display, deep clone.

The std-only machinery phase 1 added (`@inline`, the `@pure` exemption, the `_map*`
intrinsics) is gated on `isHashMapModule`; step 0 widens the gate to the std collection
modules (`std/hashmap.milo`, `std/vec.milo`, later `std/string.milo`) so Vec can use it.

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
- 2026-10-31: `getOrDefault` moved, with a `_mapCopyOut` intrinsic: the builtin's
  structural deep copy (emitDeepCloneFromPtr),
  not `.clone()`, which would run a user Clone impl. The resource copy-out rule stays in
  the checker's hashmap chain (`@copyOut` would also withhold it for a Drop key, which the
  builtin allowed). Fixed in passing: a generic method taking `T` instantiated with a
  ranged int refused every plain int instead of range-checking it (`typeKindToMiloType`).
  Probes use wrapping arithmetic (the checked `+`/`-` added an overflow branch per step).
  contains goes through a shared `mapFind` (parity, 1.22s vs 1.22s on 600M lookups); the
  copying lookups probe inline, since mapFind's slot-then-test measured about 4% slower.
  Planted probe step `+ 2` turns `hashMapGetOrDefaultStd` red; 0 leaks; 600M lookups
  1.31s builtin vs 1.32s std.
- 2026-10-31: `get` moved (inline probe, `Some(_mapCopyOut(...))`). The pinned copy-out
  message (`dropElementHashMapGet`) still comes from the checker's hashmap chain. Planted
  tombstone match and probe step `+ 2` each turn `hashMapGetStd` red; 0 leaks; 600M i64
  lookups 1.32s builtin vs 1.34s std. builtinMembers.test checks with the prelude since the
  getOrDefault commit, so a row whose body moved to std resolves (red since `contains`).
- 2026-11-01: `remove` moved. The slot's key and value are moved out and dropped in place
  (`mapDropAt`, key first, as genHashMapRemove did); `_len` and `_tombs` updated. The
  checker keeps "cannot remove from immutable HashMap" (a `&mut Self` receiver does not
  refuse a `let` binding, a `&HashMap` or a temporary on its own), and a std mutating
  method no longer reports a live loop twice. Planted: no value drop gives 303 leaks and
  a red fixture; probe step `+ 2` and a missing `_tombs` increment (insert/remove churn
  then hangs) turn `hashMapRemoveStd` red. Bench: i64 churn 0.29s vs 0.29s, string/Vec
  churn 0.11s builtin vs 0.09s std.
- 2026-11-01: `modify` moved (`f(&mut data[slot].value)`). The builtin's callback borrow
  stays: `dispatchMangledMethod(..., borrowsForCallback)` freezes the receiver while the
  callback is checked and skips the call-site exclusivity rule, which would refuse any
  capture of the map (a callback reading `m.len` was accepted and still is), so
  `hashMapModifyReentrant` keeps its message. One program class is now rejected: a
  callback declaring its `&mut V` parameter by value (`(v: i64)`), which the builtin
  accepted and miscompiled (it printed the slot's address). Planted: tombstone match and
  probe step `+ 2` turn `hashMapModifyStd` red; dropping the flag turns
  `hashMapModifyReentrant` red. 0 leaks; 600M lookups 1.27s builtin vs 1.26s std.
- 2026-11-01: `getOrInsertWith` moved, key now BY VALUE. The builtin never moved the key
  but stored it on a miss: a heap string key was freed by the caller while the map held
  it (ASan: heap-use-after-free; the old compiler's run of `hashMapGetOrInsertWithStd` is
  killed). A reused non-Copy, non-string key is now a use after move
  (`getOrInsertWithKeyMoved`). A miss probes twice (inline probe, then the builtin insert)
  until insert moves; `init` keeps the callback borrow (`getOrInsertWithReentrant`).
  Planted always-insert turns the fixture red. ASan clean, 0 leaks. Bench: miss path
  0.37s vs 0.37s; hit path 0.58s builtin vs 0.61s std. Both inline fully and keep the map
  in registers; the -O2 loops differ in shape (the builtin's state test is one `switch`,
  the std loop two compares plus a rotated loop), which is the remaining ~4%.
- 2026-11-01: a `&mut Self` method from a container impl (std `impl HashMap<K, V>`, a user
  `impl Vec<T>` or `impl string`) now requires a mutable receiver, one rule in
  `refuseImmutableContainer` for both dispatch paths (it replaces remove's special
  case and keeps remove's wording). `let m = HashMap.new(); m.upsert(...)` compiled and
  wrote through the `let` (`hashMapUpsertImmutable`). modify on a temporary is refused
  now, as insert and remove already were. Not changed: a user struct's `&mut self`
  method on a `let` still compiles.
- 2026-11-01: the container-impl mutability rule is now the general receiver rule
  (`refuseImmutableReceiver`): any `&mut self` method, in every dispatch path, needs a
  receiver a `&mut` argument could take (`unwritableMutTarget`, shared with the argument
  check). Heap receivers, temporaries and by-value match bindings stay legal.
- 2026-11-01: `keys` and `values` moved: slot-order loop, `out.push(_mapCopyOut(...))` into
  a `Vec.withCapacity(len)` (same capacity as the builtin's exact allocation). The
  interface/closure and resource copy-out refusals stay at the call in the checker.
  Fixture checks keys() against the builtin for-in order. Planted tombstone match and
  reversed slot order turn `hashMapKeysValuesStd` red; 0 leaks; bench 0.38s builtin vs
  0.32s std (100k-entry keys+values x1000, 2k string keys x2000).
- 2026-11-01: `clear` moved: slot loop dropping each live key then value (`mapDropAt`),
  every state set to empty, `_len`/`_tombs` zeroed; capacity and seed kept, as
  genHashMapClear did (it also memset the dead key/value bytes, which nothing reads once
  the state is empty). "cannot clear an immutable HashMap" kept via the receiver rule.
  Planted: no value drop gives 600 leaks and a red fixture; not resetting the states turns
  `hashMapClearStd` red (and the churn case hangs). 0 leaks; bench 0.83s vs 0.80s.
- 2026-11-01: `clone` moved as `return _mapCopyOut(self)`: the builtin method was already
  `emitDeepCloneFromPtr` on the whole map (memcpy of the slot array with seed and
  tombstones, then a structural copy of each live key/value), the same code that copies a
  map nested in a struct or Vec, so std calls that one implementation instead of
  re-deriving malloc + slot loop + seed handling. Lost: the builtin's shortcut handing a
  temporary receiver back uncopied (`mk().clone()` now copies). Interface/closure/
  resource refusals stay at the call. Same keys() order as the source; planted
  remove-one-entry turns `hashMapCloneStd` red; 0 leaks; bench 1.15s vs 1.15s.
- 2026-11-01: `insert` moved, with two intrinsics: `_mapSeed` (a call of codegen's
  `__milo_hash_seed`, so record/replay still fixes the seed sequence) and `_mapAlloc`
  (zeroed slots through `emitAllocBytes`, so the allocation keeps its overflow and null
  checks and the allocChokePoint gate stays honest). Same policy: seed drawn on the first
  insert (0 becomes FNV's offset basis), grow when `(len + tombs + 1) * 4 >= cap * 3`,
  always doubling, rehash with the same seed, first tombstone on the probe reused, overwrite
  keeps the old key (old value dropped, then the new key). The checker keeps the builtin
  insert's own rules (key moved before the value is checked, no call-site exclusivity, so
  `m.insert(k, m.getOrDefault(k, 0) + 1)` stays legal) and records the std method for
  lowering. getOrInsertWith now probes once (`mapProbeInsert` returns the slot or the
  vacant slot) and re-probes only after seeding or growth. Iteration order under
  `MILO_RECORD` is byte-identical to the builtin's. A called insert was 45% slower on an
  overwrite loop (cost 450 vs LLVM's 225 threshold), so `@inline` (std/hashmap only,
  `alwaysinline`) marks insert and its grow step, and the rehash takes the fields rather
  than the map so the map's address never escapes (an escaped map stayed in memory).
  OOM or size overflow while growing now reports a std/hashmap.milo line, not the caller's.
  Planted: doubling by 4 and not counting tombstones (churn hangs) turn
  `hashMapInsertStd` red; skipping the re-probe after growth turns it and
  `hashMapGetOrInsertWithStd` red. 0 leaks, ASan clean. Bench (median of 5, builtin vs
  std): 200M overwrites 1.03s vs 1.07s; 20x (1M inserts + 1M overwrites) 1.05s vs 1.08s;
  200 maps grown to 100k 0.68s vs 0.69s; mixed counting/churn/getOrInsertWith 0.17s vs
  0.17s. The rest of the overwrite gap is loop shape, not memory traffic (both keep the
  map's fields in registers).
- 2026-11-01: `HashMap.new` and `HashMap.withCapacity` are calls of std's `mapNew` /
  `mapWithCapacity`. The checker keeps its inference (`let m: HashMap<K, V> =
  HashMap.new()`, the spelled `HashMap<K, V>.withCapacity(n)`) and records the instance as
  a static call, so lowering emits an ordinary Call and the whole-program passes see a
  callee. The map is built as `zeroed<HashMap<K, V>>()` with data and cap written through
  the MapRaw view (len, seed, tombs stay 0; HashMap has no Drop to run on the zeroed
  value). withCapacity rounds in u64 as the builtin's udiv did; the negative check stays
  at the caller's line through a `NonNegative` HIR node on the argument (same panic text
  and location; pinned by `runtime-errors/hashMapWithCapacityNegative`). A non-i64 int
  capacity, which reached clang as an i64/i32 mismatch, is now widened. Fixed in passing:
  a `@pure` fn could not call any moved method (`contains`, `get`, ... since the first
  commit of this phase, and insert/new would have joined them); the purity pass now treats
  std/hashmap callees as the builtin it was (`hashMapPureStd`; its bodies are unsafe, so
  they cannot say @pure). A HashMap global initializer is now a lazy init (a call), not a
  constant. Planted: `/ 4` for `/ 3` in the rounding turns `hashMapNewStd` red; dropping
  the NonNegative wrapper turns the runtime-error test red ("integer overflow at
  std/hashmap.milo"). Iteration order under MILO_RECORD unchanged, 0 leaks, ASan clean.
  Bench: 3M new + 1M withCapacity(20) maps 2.12s vs 2.12s.
- 2026-11-01: phase 1 done. `codegen-map.ts` is 1173 -> 211 lines: what remains is the
  intrinsics std/hashmap calls (fnvHash/hashInto behind `_mapHash`, keysEqual behind
  `_mapKeyEq`, `_mapCopyOut`, `_mapSeed`, `_mapAlloc`) and the %HashMap field indices
  drop, clone and DWARF still read. For-in, drop, display, `len` and the deep clone stay
  in codegen.ts / codegen-drop.ts. The unused ctx members and the never-read HM_LEN /
  HM_SEED went with this commit. `emitHashMapInsertValues` had no caller left besides
  the builtin insert: std/set, derive(Json) and std/json all insert through Milo code,
  which is the std method now.
- 2026-11-01: phase 2 step 0. `@inline` and the `@pure` exemption are gated on
  `isStdCollectionModule` (std/hashmap.milo, std/vec.milo; anchored path match); the
  `_map*` intrinsics stay std/hashmap only. Pinned wording is now "only the std
  collection modules may force inlining" (`inlineOutsideStdCollections`). A slice
  receiver (`&[T]`, `&mut [T]`) may call any `impl Vec<T>` method taking `self: &Self`,
  passed as the same `{ptr, len, cap}` the builtins read; a `&mut Self` one is refused
  ("'pushTwice' needs an owned Vec; a slice is a view", `sliceReceiverMutVecImpl`; with
  the check removed that program compiles and pushes through the view).
- 2026-11-01: std/vec.milo created (prelude `from "std/vec" import {}`); `isEmpty` moved
  (`self.len() == 0`). A fixed array receiver of a moved method gets the builtin's
  full-range VecSlice (lower.ts, the resolved-method path). Planted `== 1` turns
  `vecIsEmptyStd` red; old and new output identical; 0 leaks; 300M calls 0.10s vs 0.10s.
- 2026-11-01: `first` and `last` moved as calls of the builtin `get` (`get(0)`,
  `get(len.wrappingSub(1))`), so the copy-out is still emitDeepCloneFromPtr. The resource
  refusal stays at the call in the checker (`dropElementVecLast`). Two builtin bugs gone:
  `last` lowered its receiver twice (`mk().last()` called `mk` twice), and a fixed-array
  receiver (`[9, 4, 8].first()`) reached clang as `[3 x i64]` where `%Vec` was read.
  Planted `wrappingSub(2)` turns `vecFirstLastStd` red; output identical to the old
  compiler apart from those two; 0 leaks; bench 0.07s builtin vs 0.05s std.
- 2026-11-01: `contains` moved: `for e in self { if e == x { return true } }`, needle
  taken as `&T` (no refcount round trip for a string needle, nothing moved). The
  element-type gate (`vecContainsStruct`) stays at the call. A ranged element
  (`Vec<i32(0..9)>`) dispatches to the plain-int instantiation, so `r.contains(12)` stays
  legal and false; a `&i32(0..9)` needle would have refused any plain i32. `==` gives the
  builtin's semantics (string by content, float `oeq`: NaN never found, -0.0 finds 0.0).
  Arity/type messages now come from the generic method path ("'contains' argument 1:
  expected i64, got string"). Planted `!=` turns `vecContainsStd` red; output identical
  to the old compiler; 0 leaks; bench 3M int + string searches 1.03s builtin vs 1.00s std.
- 2026-11-01: container impl methods are instantiated on demand (the commit before
  isEmpty): an inherent `impl Vec<T>` method is checked for a `T` only when called, a
  trait impl still whole and once. Without it, any std/vec call on a `Vec<Vec<i64>>`
  instantiated `contains` and failed on its `==`, and `Option<HashMap<K, V>>` from a
  container instance got a type name with spaces (`typeKindToMiloType` now keeps the
  map's type arguments). Pinned by `containerImplOnDemand`.
- 2026-11-01: `indexOf` moved: the contains loop with a wrapping counter, `Some(i)` /
  `None`. Same gate and ranged-int dispatch as contains. Planted `wrappingAdd(2)` turns
  `vecIndexOfStd` red; output identical; 0 leaks; bench 3M int + string searches 1.06s
  builtin vs 1.03s std.
- 2026-11-01: milo fmt no longer spaces a ranged type argument (`Vec < i32(0..9) >`, which
  then failed to parse) or a minus after a postfix unwrap (`x! -2`); round-trip cases in
  tests/fmt.test.ts, the `type Digit` workarounds removed, two mangled fixtures healed.
- 2026-11-01: callback coercion, a general call rule: where `(&T, ...) => R` is expected and
  T is Copy, `(T, ...) => R` is accepted (a closure literal's parameter is retyped to `&T`,
  a named fn is wrapped in a thunk). Non-Copy stays refused with the builtins' message
  (`callbackByValueNamedNonCopy`, `vecCallbackMovesOwned`). A generic method's callback
  mismatch now reports through checkCallbackSig ("callback parameter 1 is declared ...").
- 2026-11-01: each, enumerate, any, all, position, find, fold and reduce moved. All are
  dispatched with the callback borrow (receiver frozen while the callback is checked;
  `borrowNoteCallback` unchanged). fold is `fold<A>` with A from the seed, and the seed is
  retyped to the closure's annotated int accumulator first (`checkVecFold`). find copies
  out through get; a resource element is now refused at the call (the builtin find copied
  a Drop element out structurally, the double release first/last already refused). Fixed in
  passing: a second registration of an inherent impl (now routine, with on-demand container
  methods) dropped generic methods and @sql attributes; the two copies are one loop. The
  callback methods are `@inline`: called, the bench was 3.4% slower (1.49s vs 1.54s);
  inlined it is at parity (1.93s vs 1.94s, 2.23s vs 2.12s under load). Planted `if f(e)` for
  `if !f(e)` in all turns `vecCallbacksStd` red; output identical to the old compiler; 0 leaks.
- 2026-11-01: `min` and `max` moved, over a std/vec-only intrinsic `_natLess(a, b)`:
  emitElemOrd's `a < b` (ints by signedness, float `olt`, string byte order, bool
  false < true, which the language's `<` lacks). Same scan as genVecMinMax: best index from
  0, replaced only on a strict win, so the first of equals wins and a leading NaN stays the
  answer; the winner is copied out through get. The element gate stays at the call. Old
  bug gone: a fixed-array receiver (`[4, 2, 8].min()`) failed in clang. Planted swapped
  operands in min turn `vecMinMaxStd` red; output identical to the old compiler without the
  fixed-array line; 0 leaks; bench 0.76s builtin vs 0.70s std.
- 2026-11-01: `@trackCaller` (std collection modules only, the @inline gate): a panic
  inside the fn reports its caller's file:line. Implemented as per-call-site
  specialization after lowering (src/track-caller.ts): each direct call of a tracked fn
  gets a copy stamped with the call's span, and codegen's panicAt / panicLine /
  emitCheckFilePtr use the stamp; a tracked call inside a copy passes the stamp on. Chosen
  over a hidden location argument because every panic message bakes its location into a
  constant string, and the attribute's users are @inline anyway, so the copies cost what
  inlining does. Applied to insert, getOrInsertWith, mapGrow, mapNew, mapWithCapacity and
  mapWithSlots; mapGrow now allocates the new slots itself so mapRehash (which cannot
  panic) stays one copy. Pinned by `runtime-errors/hashMapWithCapacityHuge` (size overflow
  at the caller's line 13; with mapWithSlots untracked it reports std/hashmap.milo:211) and
  `trackCallerOutsideStd`. Insert growth's OOM cannot be provoked in a test; it rides the
  same mapGrow stamp. Bench 200 maps grown to 100k: 0.65s before vs 0.64s.
- 2026-11-01: `sum` moved: `acc = acc + e` from `0 as T`, `@trackCaller`, so an overflow
  reports the caller's line (`runtime-errors/vecSumOverflow`, the same line the builtin
  named; with the attribute dropped it reports std/vec.milo:96). Inside a @wrapping fn (or
  module) the checker dispatches an int `v.sum()` to std's `wrappingSum`, as the builtin
  wrapped there. Decided: `wrappingSum` is public and user-callable, the explicit spelling
  next to `wrappingAdd`; ints only. A ranged element sums as its plain int (the builtin
  typed the result as the ranged element though the total leaves the range; same output).
  Planted `acc = e` turns `vecSumStd` red; output identical to the old compiler; 0 leaks;
  bench 300k sums of 1000 i64 + 1000 f64 1.03s builtin vs 1.01s std.
