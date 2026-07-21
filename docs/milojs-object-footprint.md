<!-- doc-meta
system: milojs-object-footprint
purpose: measured per-object memory cost in milojs and the plan to shrink JSObj by moving rare capabilities to a side table
key-files: examples/apps/milojs/runtime.milo
update-when: JSObj gains or loses fields, or the side-table split lands
last-verified: 2026-07-20
-->

# milojs: object footprint

## Measured

Measured with `/usr/bin/time -l`, 50,000 iterations each, differences against a
baseline of 50,000 numbers pushed into an array:

| what | cost |
|------|------|
| baseline (50k numbers in an array) | 19.1 MB |
| per empty object `{}` | **1008 bytes** |
| per added property `{a:1}` | 145 bytes |

The per-property figure was 1044 bytes before the Vec first-allocation fix
(`ced9ad0`, size the first allocation in bytes rather than elements). It is no
longer the problem. The **object header is**: an object with no properties at
all costs a kilobyte.

## Why

`JSObj` has 42 fields, because every optional capability is inline: promise
state, bound-function state, proxy target/handler, Map/Set backing, typed-array
view, ArrayBuffer bytes, regex id, date, node-api wrapper. A plain `{}` pays for
all of them.

Rough sizing of the struct (Vec 24, JSValue 32, string 24, i64 8):

| | |
|---|---|
| total | ~465 bytes |
| fields a plain object actually uses | ~74 bytes |
| fields that could move to a side table | **~391 bytes across 28 fields** |

Largest movable: `promiseValue`, `boundTarget`, `boundThis`, `proxyTarget`,
`proxyHandler` (32 each), then `bytes`, `reactions`, `boundArgs`, `boundMethod`,
`mapKeys`, `mapVals` (24 each).

The measured 1008 bytes exceeds the ~465-byte struct because the object arena
grows by doubling, so live objects sit in an array with up to 2× headroom.

## Plan

Move the 28 rare fields into a side table keyed by object index, leaving the hot
header: `props`, `elems`, `proto`, `ctor`, and the flags a plain object needs.
Objects that never become a promise, a proxy, a Map, a typed array or a bound
function then pay ~74 bytes plus arena headroom instead of ~465.

Expected: roughly 3-4× less per empty object. Verify by re-running the
measurements above rather than by inspection.

Note the ordering constraint: the promise waiter table added for await
suspension already lives outside `JSObj` for this reason — see
[milojs-async-suspension.md](milojs-async-suspension.md).


## Measured 2026-07-20, engine built from main (bf294dc)

`/usr/bin/time -l`, maximum resident set, baseline (3.6 MB for a
`console.log(0)` script) subtracted:

| program | RSS | per object |
|---|---|---|
| 50k `{}`      | 64.6 MB | **1279 B** |
| 50k `{a:1}`   | 71.5 MB | **1424 B** |

The often-quoted figure for this work is ~968 B per empty object. The real
number is **1279 B**, about 32% worse, so the case for the side table is
stronger than the plan assumed, not weaker. One property costs a further 145 B.

Whoever picks this up should re-measure rather than trust either number: both
are RSS deltas over a 50k-object loop, which also pays for the backing array and
allocator slack, and neither is a direct `sizeof`.

### Where it goes

`JSObj` carries 28 scalar fields, 5 `Vec` fields and 3 `JSValue` fields inline.
Every object pays for every optional capability: promise state and reactions,
bound-function target/this/args, proxy target/handler, Map/Set key and value
vectors, typed-array view fields, ArrayBuffer bytes.

An empty object uses none of them. The plan stands: move the rare groups
(promise, bound, proxy, map/set, typed-array, arraybuffer) to side tables keyed
by object index, leaving the common object — props, elems, proto, ctor and the
handful of flags — in the inline struct.

### Sequencing note

This is a wide refactor of the hottest struct in the engine, touching allocation,
the collector's mark phase and every capability check. The await-suspension work
this week produced two changes that passed the full fixture suite and still
broke the real app, so the order that actually catches things is: change, then
`tests/run.sh`, then GC stress, then tahoeroads — before believing any of it.

## Execution design (added 2026-07-20, for the fresh session that lands this)

Concrete finding: the Map/Set group alone is **73 accessor sites** (63 in
eval.milo, 10 in runtime.milo). Every rare field is like this — moving one to a
side table is a mechanical but large rewrite of its access sites. Milo has no
property getters, so `st.objects[o].mapKeys` cannot transparently redirect; each
site must change. Budget for it; don't expect a small diff.

**Side table shape.** One `HashMap<i64, CapData>` per capability, keyed by object
index (sparse — only objects that use the capability have an entry). E.g.
`mapData: HashMap<i64, MapData>` with `struct MapData { keys: Vec<JSValue>, vals:
Vec<JSValue> }`. The old `isMap` boolean becomes `st.mapData.has(o)`.

**Accessors.** Add helper fns so sites change uniformly and once: `mapDataOf(st,
o): &mut MapData` (inserts an empty entry on first use for a set-path), and
read-only `isMapObj(st, o): bool`. Convert each site to the helper — grep-driven,
one capability at a time.

**GC (the one subtle part).** The collector currently marks the JSValue-bearing
rare fields (`mapKeys/mapVals`, `boundTarget/boundThis/boundArgs`, `proxyTarget/
proxyHandler`, `promiseValue/reactions`) from inside `JSObj`. After the move it
must instead iterate each side table and mark the entries of LIVE (marked)
objects. Miss one table and you get a use-after-free that only shows under GC
stress — so run `MILOJS_GC_THRESHOLD=1` on every slice.

**Slicing order (each slice: change → run.sh → GC-stress → app smoke → commit).**
1. **Proxy first** — rarest, self-contained, only get/set/has/ownKeys touch it.
   Proves the pattern with the least blast radius.
2. typed-array + arraybuffer (`bytes`, `taBuf/taKind/taOffset/taLen`, `abMax*`).
3. bound-function (`boundTarget/boundThis/boundArgs/boundMethod`).
4. Map/Set (the 73-site one).
5. date, regexId, napi — small, easy.
6. **promise LAST** — the most common capability and the most entangled (await
   suspension, reactions, the resolver-native id scheme). Most care, do it once
   everything else is proven.

Re-measure `50k {}` after each slice; the empty-object number should fall toward
the ~74-byte hot header as promise/bound/proxy/map/ta drop out.

### GC lifecycle of a side table (subtle — do not skip)

A side table `HashMap<i64, CapData>` keyed by object index has TWO GC duties, not
one:

1. **Mark**: iterate the table and mark the JSValues (target/handler, keys/vals,
   promiseValue/reactions…) of entries whose object is live. (The obvious one.)
2. **Sweep-remove**: when the collector FREES an object index `o`, it must delete
   `sideTable[o]`. Object indices are recycled from the free-list, so a stale
   entry left behind makes the NEXT object allocated at `o` silently inherit the
   freed object's capability — a plain `{}` reusing a proxy's old slot would test
   as a proxy. This only manifests under GC + allocation churn (a recycled index
   that happens to reacquire a rare capability), so it passes casual testing and
   fails under `MILOJS_GC_THRESHOLD=1` with a workload that frees and reallocates
   rare-capability objects. Every slice's GC-stress test MUST exercise that.

Also confirm the language has a usable `HashMap<i64, T>` (the design assumes one);
if not, a parallel `Vec` indexed by object id with an `Option`/sentinel works but
wastes the sparsity — prefer the map.

### Refinement: keep the 1-byte flags inline, move only the large fields

The sweep-remove hazard above is AVOIDABLE. Keep the capability booleans
(`isProxy`, `isMap`, `isBound`, `isDataView`, `promiseState` sentinel…) INLINE on
JSObj — they are 1 byte and are reset to their empty value by the newObject
literal when an index is recycled, so they correctly gate access. Move only the
LARGE fields to side tables: the 32-byte JSValues (`promiseValue`,
`boundTarget/boundThis`, `proxyTarget/proxyHandler`) and 24-byte Vecs
(`reactions`, `boundArgs`, `mapKeys/mapVals`, `bytes`). Those are ~90% of the
movable bytes; the flags are noise.

Why this is safer:
- A stale side-table entry (dead proxy's index not yet reused) is never READ,
  because the inline `isProxy` flag on whatever now occupies that index is false.
  When the index is reused as a new proxy, `setProxy` overwrites the entry. So
  **no sweep-remove is required for correctness** — the flag does the gating.
- GC still marks LIVE entries only: iterate each side table, and for an entry
  whose object is currently marked, push its JSValues onto the existing mark
  worklist (same as today's inline `pushMarkTargets(proxyTarget)`, just sourced
  from the table). A stale entry's object is unmarked, so its value is not marked
  and is free to collect; the dangling handle in the stale entry is never read.

Net: the per-slice work becomes mechanical field-access rewrites + one
mark-worklist pass per table, with NO new sweep logic. Sweep-removing stale
entries is then a pure memory optimization (bound the tables), not a correctness
requirement — do it later if the tables grow.

### Slice-order caveat: several rare capabilities are app-critical

The proxy mark path is load-bearing for the integration app — prisma wraps its
client in a Proxy, and the existing comment on the proxy mark records that
dropping it "silently lost every property the moment a second client was
constructed." So a subtle GC error in the proxy slice breaks priority-1, and GC
bugs of that kind can pass a smoke test and only surface under specific
alloc/collect timing. Same goes for bound (zod pre-binds) and likely Map. So:
run the FULL app (not just the self-fetch guard) under the moved slice, and run
GC stress with a workload that constructs/drops many of that capability. Given
the stakes, the memory refactor is best done with fresh context, one slice at a
time, app-verified — not rushed.

### CRITICAL: weigh access FREQUENCY, not just object count (found before coding the proxy slice)

A HashMap side table is sparse (memory win) but every access to a moved field
costs a hash lookup + a copy of the CapData struct out of the map. So moving a
field trades a per-OBJECT memory saving for a per-ACCESS time cost. That is only
a win when the capability is rarely ACCESSED, not merely rare in count.

Two capabilities are rare in count but HOT in access, and must NOT be
naively side-tabled:
- **proxy** — prisma wraps its client in a Proxy, so every client property read
  goes through the proxy get trap; a hash lookup + 64-byte copy per property
  access would slow the app's hottest path.
- **promise** — async-heavy code touches promiseState/promiseValue constantly.

A Vec-indexed side table (O(1), no hash) does NOT fix this: indexing by object id
needs one slot per id including non-proxies, which re-inflates every object — the
opposite of the goal. Sparse storage inherently requires a lookup.

Revised guidance: side-table the rare-AND-cold capabilities first — typed-array
view fields, ArrayBuffer `bytes`, `date`, `regexId`, `napi` — and MEASURE the
empty-object win those alone buy. Only consider proxy/promise/bound after
measuring their access-cost hit on the FULL app (not a microbench), and be
prepared to leave the hot ones inline. The headline "1.3 KB → ~350 B" assumed
moving all 28 fields; if the hot ones stay, the realistic target is higher but
the app stays fast. Net: this refactor needs a measure-first spike, not a
blind move-everything pass.
