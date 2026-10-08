<!-- doc-meta
system: enum-niche-plan
purpose: implementation plan for null-pointer niche optimization of eligible enums
key-files: src/codegen.ts, src/checker.ts, src/types.ts, tests/rangedSoundness.test.ts, tests/fixtures/enumNicheInt*.milo
update-when: enum layout, niche eligibility, or the implementation sequence changes
last-verified: 2026-10-08 (integer niche and packed tagged layout shipped; null-pointer niche still planned)
-->

# Enum niche optimization (null-pointer niche) — implementation plan

**Goal.** Shrink `enum` with a fieldless variant + a single non-null-pointer payload variant from 24 B (i32 tag + 4 pad + ptr) to 8 B (just the ptr; `null` encodes the fieldless variant). This is Rust's NPO. Measured to be the *entire* Milo-vs-C gap on `benchmarks/binarytrees` (backlog Tier-2 #15). Payoff is broad: every `Option<Heap<T>>`, `Option<&T>`, pointer-payload enum in std + the self-hosted compiler shrinks.

**Confirmed baseline (2026-07-30):** `enum Tree { Leaf(i32), Node(Heap<Tree>, Heap<Tree>) }` → `sizeOf` = 24. Non-niche.

## Eligibility (start narrow, prove it, then widen)
First slice: enum with EXACTLY 2 variants where
- one variant is fieldless (the "none" side), and
- the other has EXACTLY ONE field whose type is a **non-null pointer** — `Heap<T>` first (its `null` bit pattern is unused: a live `Heap` is never null). Later: `&T` views, then `ptr`-payload, then multi-field where a niche field exists.

Do NOT niche when the payload could legitimately be null, or when there are 3+ variants (no room in one niche), until a niche-tracking model handles it.

## Encoding
- LLVM type of a niche enum = `ptr` (not `{ i32, [payload] }`).
- Fieldless variant  = `null`.
- Payload variant    = the (non-null) pointer value.
- Tag read (match / IsCheck): `icmp eq ptr %v, null` → fieldless; else payload.
- Payload extract: the pointer IS the payload (no GEP past a tag).

## Touch points (all in src/codegen.ts unless noted)
1. **Layout build** (~1042–1077): add a `niche?: { fieldVariant, noneVariant, payloadType }` to `EnumLayout`; detect eligibility here. `payloadSlots`/tag stop applying when `niche` is set.
2. **LLVM type emission** (llvmType `enum` / the `%EnumName = type {…}` decl): emit `ptr` for niche enums.
3. **Construction** (`EnumLit` codegen): fieldless → store `null`; payload → store the pointer directly (no tag write).
4. **Tag read** (`IsCheck`, `MatchExpr` arm dispatch): `icmp eq null` instead of loading a tag word.
5. **Payload extract** (match binding): bind the pointer as the payload; no tag-offset GEP.
6. **Drop glue** (`emitDropGlue`/`droppableEnums`, ~1070): if ptr != null, drop the payload (the `Heap`); null is a no-op. MUST agree with construction on the encoding.
7. **sizeOf / typeSize** (~576, 746): niche enum size = 8.
8. **`@cLayout`/FFI**: niche enums must NOT be exposed to C as-is (or document the ptr repr). Check no extern surface breaks.

## Risk — this is the memory-safety-critical part
A wrong encoding = silent corruption (a null read as a live pointer, or a tag mismatch between construct and match/drop). Every one of the 8 touch points must agree. **Test at each step**, do not batch.

## Test strategy
- `sizeOf<Tree>() == 8` (was 24) — the headline assertion.
- Round-trip: construct both variants, `match`, extract payload, verify values (recursive `Tree` sum, `Option<Heap<i64>>` get).
- Drop: a niche enum holding a `Heap` in a loop must free exactly once, no double-free, no leak (ASAN).
- Regression: full `bun test tests/run.test.ts` (enums are everywhere).
- Benchmark: `benchmarks/binarytrees` before/after — expect ~15–18% (the measured node-size gap) on a quiet box.
- Non-eligible enums (3+ variants, nullable payload) MUST stay tag-encoded — pin with a fixture.

## Sequencing (one PR-sized slice per step, test between)
1. Layout detection + `niche` field on EnumLayout (no codegen change yet; just compute + log).
2. LLVM type = ptr + sizeOf = 8, for niche enums; construction (store null / ptr).
3. Tag read + match + payload extract.
4. Drop glue.
5. Benchmark + widen eligibility (&T, ptr) once Heap<T> is proven.

## Integer niche (shipped 2026-10-08)

**Status.** Done for ranged-int payloads. The null-pointer niche above is still planned.

**Why first.** A BST whose links are `Option<NodeId>` with `struct NodeId { at: i32 }` has
40-byte nodes (each link is a 16-byte tagged Option). Hand-packing the links as `i32` with a
`-1` sentinel was 2x faster and 4x smaller. With `at: i32(0..2147483646)` the idiomatic
Option version gets the packed layout automatically: `Option<NodeId>` is 4 bytes, the node 16.
Measured on `bst_big` (500k inserts, macOS arm64, `--release`, best of 3): 0.60 s / 73 MB
before, 0.32 s / 29.5 MB after, same checksum.

**Eligibility** (`Codegen.enumNiche` / `nicheOf`). Two variants, one fieldless, the other with
exactly one field whose type has a niche:
- a ranged int `iN(lo..hi)`: the niche is `hi + 1` if the width holds it, else `lo - 1`; none
  when the range covers the width, or a bound is not a safe JS integer (the range itself is
  stored as a JS number);
- a struct with exactly one field that has a niche, and no `Drop` impl (recursive; the field
  is at offset 0).
Plain `i32`, 3+ variants, multi-field payloads and `Option<Option<R>>` (the inner Option's
niche is used) stay tag-encoded.

**Encoding.** `%Option_X = type { P }` (the payload's own LLVM type, wrapped so the name and
`sizeOf` path are unchanged); size and alignment are P's. None = the niche value stored in the
leading integer; Some(x) = x. All tag and payload access goes through three helpers,
`loadEnumTag` (load, compare with the niche, select the tag), `storeEnumTag` (None writes the
niche, Some writes nothing because its payload store is the whole value) and `enumPayloadPtr`
(the enum's own address). Every former `getelementptr %Enum, ..., i32 0, i32 {0,1}` site in
codegen was routed through them: construction (EnumLit, auto-wrap), match / if let /
while let / let-else (one switch on the loaded tag), `?`, `!`, `??`, isSome/isNone, map,
andThen, orElse, unwrapOr(Else), for-in over `next()`, Vec pop/get/first/last/min/max/find/
indexOf/position, HashMap get, `tryFrom`, the clone and drop glue, and the `?`
conversion paths. `assertNicheAccessRouted` scans the finished module and throws if any
niche enum is still indexed as `{ i32, payload }` (or used with extract/insertvalue), so a
missed site is a compile-time error, not a miscompile. Zero bytes are `Some(0)` in both
encodings, so code that zeroes a moved-from enum is unaffected.

Other touch points: `typeSize`/`typeAlign` (so struct fields, Vec elements, HashMap values and
`sizeOf` all agree), the `%T = type` emission, and DWARF (a struct with one member named like
`Some (None = 2147483647)`, since a debugger has no other way to learn the encoding). `==` on a
payload-bearing enum is rejected by the checker, so there is no enum-equality path to change.
Printing and `@derive(Json)` are Milo-level code over `match`, so they follow automatically.
Enums cannot cross the C ABI by value (`externSigError`, `isValidExternStructField`), so the
layout never reaches C; `tests/errors/nicheOptionExtern.milo` pins it.

**Soundness.** The niche value must be unreachable from safe code, or a `Some` reads back as
`None`. That turned out to need real checker work, because a range was enforced at `let`,
assignment, call arguments and `return` only. Closed (each with a case in
`tests/rangedSoundness.test.ts`):
- flows that were unchecked: struct-literal fields, enum and Option payloads, the
  `T -> Option<T>` auto-wrap, Vec push/insert/literal/filled, HashMap insert/getOrDefault,
  method and static-call arguments, `??` defaults;
- `x as R` is now a checked conversion;
- a generic instance keeps the range in its name (`Option_i32r0_2147483646`), so `Option<R>`
  and `Option<i32>` are different types; under a container, pointer, borrow or fn type the
  range must match exactly (`typeEq` is range-strict when nested), so `Vec<i32>` cannot be
  passed off as `Vec<R>`; a `&R` / `&mut R` parameter takes only an argument whose range fits /
  matches;
- operator results carry the width only (`r | 1`, `-r`, `~r`, `r + x`), unless range
  propagation proves a range, and propagation now gives up (no range) where the op could
  overflow instead of clamping, because a `@wrapping` fn or `--no-overflow-checks` wraps;
- if/match results join their branch ranges; a constant operand or branch gets the width, not
  the other side's range; a constant expression is folded before the range check, and one
  that cannot be folded is checked at run time;
- `wrapping*`/`saturating*`/`checked*` methods return the width (`r.checkedAdd(1)` is an
  `Option<i32>`, whose Some may hold the niche value);
- `@derive(Json)` decode reports an out-of-range number as a decode error.
Left to the user: raw-pointer writes in `unsafe`, and integers that come from C (an
`extern fn` returning `R`, an `extern struct` field of type `R`).

**Gates.** `tests/fixtures/enumNicheInt.milo` and `enumNicheIntOps.milo` (sizes, then every
operation above; the non-size output equals the same program with the ranges removed, run on
the tag-encoded compiler), `tests/rangedSoundness.test.ts`, the debugInfo niche case.

**Packed tagged layout (2026-10-08).** A non-niche enum is `{ i32, [size/align x i<align*8>] }`:
the payload union is sized to the largest variant's field struct and aligned to its most-aligned
field, so `Option<i32>` is 8 (was 16) and `enum E { A(i32, i32), B }` 12 (was 16). Payload
fields were already reached through the variant's own `{ fields }` struct off
`enumPayloadPtr`, so only `typeSize`/`typeAlign`, the `%T = type` emission and DWARF changed.
`assertEnumPayloadPacked` rejects any IR that indexes into the union, extracts it as a value,
or steps an `i64`/`[N x i64]` GEP off a payload address (the old slot math).
`tests/fixtures/enumPackSizes.milo` and `enumPackRoundTrip.milo` pin it.

**Left out of this slice.** Niches in multi-field structs (a field other than the first),
payloads with a `Drop` impl, the null-pointer niche, bool/char niches, and using several
excluded values for enums with more than one fieldless variant.
