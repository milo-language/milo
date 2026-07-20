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
