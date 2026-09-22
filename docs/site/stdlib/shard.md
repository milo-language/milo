# std/shard

A `Shard` is an owned window over part of a `Vec`. Splitting a buffer into disjoint shards lets several threads transform it in place, with no copies and no shared references.

A shard holds a pointer into the original buffer and a length, which is the same representation a mutable slice has in any other language. Milo gives it the *type* of an owned value, so the move checker decides who may touch each range and no lifetime has to be written down. The buffer is allocated once and is never copied and never split. What moves is the right to write a range.

`parallelMap` runs that whole cycle in one call. `parallelMapWith` is the same cycle with per-worker state and a window queue, and `parallelScanStr` is the read-only version over a `string`. There is no way to hold the windows apart from the call that made them, and that is deliberate (see [why there is no manual path](#why-there-is-no-manual-path)).

## Why this module exists

Milo has no stored references. A `&T` or `&mut T` exists only as a function parameter, never in a struct field, a `Vec` element, or a return value. That restriction is what keeps lifetimes out of the language: a reference that cannot outlive the call it was passed to needs no annotation to prove it, so there is nothing to name and nothing to thread through a signature.

Parallel transforms are where that restriction costs something. The standard move is to split a buffer into mutable slices and give one to each worker, which Rust spells `split_at_mut`. It works because the type system can state that the slices borrow one buffer over disjoint regions, and can check that claim. Milo cannot state it, and adding lifetimes so that it could would give back exactly what the restriction bought. That leaves copying a chunk per worker and stitching the copies together, and on a 20M-element buffer the copy costs more than the parallelism saves.

So this module divides the *ownership* instead of the borrow. `parallelMap` consumes the `Vec` and hands out windows, each an ordinary owned value that a worker receives by move like anything else. No reference crosses a thread because no reference exists, and the aliasing argument is the move checker that already shipped rather than a new rule to trust.

```milo
from "std/shard" import { Shard, parallelMap, parallelMapWith, StrShard, parallelScanStr }
```

## Quick start

```milo
from "std/shard" import { Shard, parallelMap }

fn double(w: Shard<f64>): Shard<f64> {
    for i in 0..w.len() {
        w.set(i, w.get(i) * 2.0)
    }
    return w
}

pub fn main(): i32 {
    let n = 16
    var data: Vec<f64> = Vec.withCapacity(n)
    for i in 0..n {
        data.push(1.0)
    }

    let out = parallelMap(data, 4, double)     // divide, run on 4 threads, reassemble
    print(out[0].toString())
    return 0
}
```

`data` is moved into `parallelMap` and comes back transformed, in the same allocation.
No element was copied and no reference crossed a thread.

`f` is a plain function rather than a closure because every worker needs its own copy:
a capturing closure is moved into the first task and gone for the rest. Everything the
work depends on therefore travels in the window, which is also what stops workers
sharing anything. The ergonomics and the safety property are the same choice.

## Why this is safe

The three things that make it safe are all rules Milo already had:

- **`parallelMap` consumes the `Vec`.** While the buffer is divided there is no binding through which it can be reached except the windows. Touching the original is `error: use of moved variable`.
- **The windows are disjoint by construction.** Window `i` covers exactly `[i*chunk, (i+1)*chunk)`, computed inside the module, never supplied by you.
- **`Shard` is `@noCopy`.** Handing the same window to two workers is a compile error, not a race. A struct of a pointer and three integers would otherwise be `Copy`, and a copyable window would make the race representable again.

So the aliasing argument is the move checker that already shipped. Nothing new had to be proven.

## Why there is no manual path

A window is a raw pointer into the buffer. The module used to offer the pieces of the
cycle separately (`shatter` to divide, `windows` to take the set, `weld` to reassemble),
with one obligation attached: keep the owner alive until `weld`. That obligation was the
hole. A function that divided a buffer, handed a window to a `Promise.blocking` worker
and returned, dropped the owner while the worker was still writing through the window:
a heap-use-after-free that no checker rule could see, because nothing was moved twice,
and that `weld` could only have noticed afterwards, in a program that never welded.

So the pieces are private now. Every public form creates every window, hands out every
window, awaits every worker and reassembles inside one call, and none of your code runs
between those steps. That is the same guarantee Rust's scoped threads get from
lifetimes, reached by closing the cycle inside one function rather than by proving a
lifetime. What it costs is expressiveness: a worker pool you drive yourself, or windows
kept for something other than one task each, are not expressible here. See
[how Milo compares to Rust](/language/vs-rust).

The one refusal a closed form can make is `parallelMapWith` being handed no states,
which means no worker to run on. `pixels` was already moved in, so a refusal that was
only a message would destroy the buffer over an empty `Vec`. Instead it comes back
whole in the `NoWorkers<T>` error:

```milo
from "std/shard" import { Shard, parallelMapWith }

pub struct Tally { n: i64 }

fn shade(w: Shard<f64>, t: &mut Tally): Shard<f64> {
    t.n = t.n + 1
    return w
}

pub fn main(): i32 {
    var pixels: Vec<f64> = Vec.filled(64, 0.5)
    var noStates: Vec<Tally> = Vec.new()
    match parallelMapWith(pixels, 16, noStates, shade) {
        Result.Ok(m) => {
            print(m.data.len.toString())
        }
        Result.Err(rej) => {
            let recovered = rej.data
            print("no workers, and the buffer came home: " + recovered.len.toString())
        }
    }
    return 0
}
```

`parallelMap` and `parallelScanStr` have no refusal at all and return their result
directly.

## What it costs

Measured on a 10-core machine, 20M `f64`, `a[i] = a[i] * 1.0000001 + 0.5`, 4 workers, `--release`:

| | time | peak memory |
|---|---|---|
| sequential, in place | 6 ms | 153.9 MiB |
| `parallelMap`, 4 workers | 3 ms | 163.0 MiB |
| C, pthreads over one shared buffer | 3 ms | 154.0 MiB |

Reproduce with `sh benchmarks/shard/run.sh`.

Read the time column loosely: this loop is memory-bandwidth-bound, so at 20M elements every row
lands somewhere in 3-7 ms run to run and four workers buy less than four times anything. The memory
column is the stable number and it is the one being claimed here.

## What it actually buys on more cores

The table above measures the absence of a copy, not speedup. For speedup you need work per element
high enough that the memory bus is not the limit. `sh benchmarks/shard/scale.sh`, 2M `f64` with 200
rounds of arithmetic each, on a 10-core M-series:

| workers | time | speedup |
|---|---|---|
| 1 | 292 ms | 1.00x |
| 2 | 146 ms | 2.00x |
| 4 | 82 ms | 3.56x |
| 8 | 60 ms | 4.87x |
| 10 | 58 ms | 5.03x |

Linear to 2, close to it at 4, then flattening as the efficiency cores take a share.

**Equal-sized windows are not equal-work windows.** `examples/graphics/mandelbrotParallel.milo`
renders the Mandelbrot set, where a pixel inside the set costs the full iteration budget and one
outside escapes almost at once. With one window per core the worker holding the black interior is
still grinding while the rest sit idle:

| windows | time |
|---|---|
| 1 | 108 ms |
| 4 | 57 ms |
| 8 | 36 ms |
| 16 | 26 ms |
| 64 | 19 ms |

It keeps improving well past the core count, because smaller units even out the finishing times.
The caveat is that `parallelMap` spawns one OS thread per window, so 64 windows is 64 threads on a
ten-core machine. `parallelMapWith` below fixes the worker count and queues the windows instead.

The point is the memory column. The copying approach this replaces roughly doubles peak memory; `parallelMap` adds a flat 9.1 MiB, which is the worker stacks and is the same fixed cost at 40M elements. As a percentage that is 5.9% at 20M and 3.0% at 40M.

Build the `Vec` with `Vec.withCapacity` if you know the size. Growing one by pushing peaks at roughly 2.7x the final size during the doubling reallocs, which dwarfs anything this module does.

## Uneven work and per-worker state

`parallelMap` cannot express two things: more windows than workers, and state that belongs to one
worker. `parallelMapWith` adds both:

```milo
from "std/shard" import { Shard, parallelMapWith }

pub struct Env { scale: f64, sum: f64 }

fn scale(w: Shard<f64>, e: &mut Env): Shard<f64> {
    for i in 0..w.len() {
        let x = w.get(i) * e.scale
        w.set(i, x)
        e.sum = e.sum + x
    }
    return w
}

pub fn main(): i32 {
    var data: Vec<f64> = Vec.filled(1000, 1.0)
    var envs: Vec<Env> = Vec.new()
    for k in 0..4 {
        envs.push(Env { scale: 2.0, sum: 0.0 })
    }
    let r = parallelMapWith(data, 16, envs, scale)!   // 16 windows, 4 workers; ! unwraps NoWorkers
    var total: f64 = 0.0
    for e in r.states { total = total + e.sum }
    print(total.toString())                           // 2000
    return 0
}
```

`states.len` is the worker count and the windows go into a queue the workers pull from, so a worker
that drew a cheap window pulls another while one that drew the expensive window keeps grinding. On
2M elements where the first quarter costs 40x the rest, 10 workers: `parallelMap` 34 ms, 40 pooled
windows 19 ms. Reproduce with `benchmarks/shard/shard_balance.milo`.

The environments are the answer to "why must `f` be a plain function". A closure cannot be copied
to N workers, so whatever it would have captured travels as an explicit owned value instead: each
worker moves one `S` in, threads it through every window it processes, and hands it back through
`r.states`, in the order the environments were given. Configuration rides in, accumulators ride
out, and an `S` is on exactly one thread at a time, which is the same move-checker argument the
windows use.

That makes reduction a recipe rather than a primitive: put the accumulator in `S`, leave the window
unchanged, and merge `r.states` sequentially when they come home.

One rule: pooling makes the worker/window assignment scheduling-dependent, so state you read back
must not encode which worker got which window. Per-worker tallies that merge into totals are
deterministic; "worker 0 saw window 5" is not.

## Scanning a string

`parallelMap` is map-shaped: a `Vec<T>` goes in and a `Vec<T>` comes back. A scan is a
different shape: it reads, and returns counts, offsets, or whatever you accumulate. And
the buffer is almost always a `string`, because that is what `readFile` hands back;
converting it to a `Vec<u8>` first is a full copy that eats the parallelism it was
bought for. `parallelScanStr` is the read-only cycle: the string goes in, `f` runs over
every window on its own thread, and the string comes back whole with one result per
window, in window order.

```milo
from "std/shard" import { StrShard, parallelScanStr }

fn countMilo(w: &StrShard): i64 {
    let needle: string = "milo"
    var n: i64 = 0
    var i: i64 = 0
    while i < w.ownLen() {
        if w.matchesAt(i, needle) {
            n = n + 1
        }
        i = i + 1
    }
    return n
}

pub fn main(): i32 {
    let text: string = "milo..............milo..............milo"
    let scanned = parallelScanStr(text, 4, 3, countMilo)   // 4 windows, 3 bytes of overlap
    var total: i64 = 0
    for n in scanned.results {
        total = total + n
    }
    print(total.toString())                                // 3
    print(scanned.text.len.toString())                     // 40, the same string
    return 0
}
```

Because nothing writes, the windows may overlap: an overlap of `needle.len - 1` finds a
match straddling a boundary without a second pass over the seams. Count only matches that
BEGIN inside a window's own range, which is `w.ownLen()`, the window's length before the
overlap was added. Ask it rather than recomputing `total / count`: the last window takes
the remainder of an uneven division, so the derived figure is wrong for exactly one
window and the miscount is silent.

`f` borrows the window and is a plain function for the reason `parallelMap`'s is; the
needle lives inside it (or in a global) rather than in a capture.

See `benchmarks/strscan/` for the worked example: 51.3 MiB, 35 ms sequential against
10 ms on eight windows, with the runner failing if any windowing disagrees with the
sequential count.

## Not for shared state

This divides data. It is not a concurrent map and not a substitute for a lock: two workers that need to touch the *same* element are outside what ownership can separate. Channels and atomics remain the answer there.

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/shard*.milo. -->

## API reference

### `Mapped`

```milo
pub struct Mapped<T, S>
```

The result of a stateful parallel map: the transformed buffer, plus every
worker's environment handed back in the order the environments were given.

Fields: `data: Vec<T>`, `states: Vec<S>`.

### `NoWorkers`

```milo
pub struct NoWorkers<T>
```

`parallelMapWith` was given no states, so there would be no worker to run on.

Why a refusal is a struct and not a message: `v` was moved in at the call, so a
`Result<Mapped, string>` would destroy a 20M-element buffer over an empty Vec of
states. This module exists so that buffer is never copied, which makes dropping it
the one failure it cannot afford. The refusal carries it home untouched, and
nothing else: `states` is empty by definition of this refusal, so there is nothing
of the caller's in it to return. Same shape, and the same reason, as
`FreezeRejected` in std/arena and `ThawRejected` in std/seal.

Fields:

- `data: Vec<T>`: The caller's buffer, whole. It was never divided.

#### `NoWorkers.message`

```milo
fn NoWorkers.message(self: &NoWorkers): string
```

A sentence for a human, for a caller that only wants to log.

### `Scanned`

```milo
pub struct Scanned<R>
```

The result of a parallel scan: the string, whole and untouched, plus what each
window's scan returned, in window order (results[i] is for the window whose
`index()` is i, so results[0] covers the start of the string).

Fields: `text: string`, `results: Vec<R>`.

### `Shard`

```milo
pub struct Shard<T>
```

A disjoint, owned window over part of one Vec's storage.

A struct of a pointer and three integers is move-tracked because of the pointer:
a Copy window could be handed to two workers at once, which is exactly the race
the design claims to make unrepresentable. (It carried `@noCopy` before a pointer
field made every struct move-only by default.)

@copyOnly closes the other half: `get` reads `self.base[i]` through
a raw pointer, which is a bitwise copy of the element. For a Copy `T` that is the
value; for a `string` it is a second owner of the same heap block, freed once by the
caller and once more when the buffer is welded back and dropped. A `Shard<string>`
is therefore rejected at the instantiation, where the element type is written.

Fields: `base: *T`, `len: i64`, `start: i64`, `shatterId: i64`, `index: i64`.

#### `Shard.get`

```milo
fn Shard.get(self: &Shard, i: i64): T
```

The element at `i` within THIS window. Bounds-checked against the window's own
length, so a stray index cannot reach a sibling window's elements.

#### `Shard.index`

```milo
fn Shard.index(self: &Shard): i64
```

Which window of the division this is, counting from 0.

#### `Shard.len`

```milo
fn Shard.len(self: &Shard): i64
```

Elements in this window.

#### `Shard.set`

```milo
fn Shard.set(self: &mut Shard, i: i64, val: T): void
```

Overwrite the element at `i` within this window. Bounds-checked the same way.

#### `Shard.start`

```milo
fn Shard.start(self: &Shard): i64
```

Where this window begins in the ORIGINAL buffer. Without it a worker can only
do position-independent work: a filter that needs to know which pixel, row or
sample it is looking at has no way to find out, because a window's own indices
all start at 0. Global position of element `i` is `start() + i`.

### `StrShard`

```milo
pub struct StrShard
```

Fields: `base: *u8`, `len: i64`, `own: i64`, `start: i64`, `shatterId: i64`, `index: i64`.

#### `StrShard.byteAt`

```milo
fn StrShard.byteAt(self: &StrShard, i: i64): u8
```

The byte at `i` within this window, bounds-checked against its length.

#### `StrShard.index`

```milo
fn StrShard.index(self: &StrShard): i64
```

Which window of the division this is, counting from 0.

#### `StrShard.len`

```milo
fn StrShard.len(self: &StrShard): i64
```

Bytes in this window, including any overlap it was given.

#### `StrShard.matchesAt`

```milo
fn StrShard.matchesAt(self: &StrShard, i: i64, needle: &string): bool
```

Whether this window's bytes at `i` match `needle`. Bounded by the window, so a
needle running past the end is simply not a match here; give the window an
overlap if you need to catch one that straddles the boundary.

#### `StrShard.ownLen`

```milo
fn StrShard.ownLen(self: &StrShard): i64
```

Bytes in this window BEFORE the overlap was added: the range no other window
owns. A scanner must count only matches beginning below this, or the two
neighbours that can both see a match in the overlap will both count it.

It is a field rather than something the caller derives because the last
window is the odd one out: it takes the remainder of an uneven division, so
`total / count` is wrong for exactly one window and a caller that re-derives
it silently miscounts there instead of failing.

#### `StrShard.start`

```milo
fn StrShard.start(self: &StrShard): i64
```

Where this window begins in the original string.

### Functions

#### `parallelMap`

```milo
pub fn parallelMap<T>(v: Vec<T>, workers: i64, f: (Shard<T>) => Shard<T>): Vec<T>
```

Divide, run on `workers` threads, reassemble. The whole cycle in one call.

    let out = parallelMap(pixels, 4, shade)

Infallible: this function creates every window, hands out every window, awaits
every worker and welds the set itself, so there is no way for a window to be
missing at the weld. Workers that need to differ from each other, or more windows
than workers, are `parallelMapWith`.

`f` is a plain function rather than a closure because each worker needs its own
copy: a capturing closure would be moved into the first task and gone for the rest.
Everything the work depends on therefore travels in the window itself, which is
also what keeps the workers from sharing anything.

#### `parallelMapWith`

```milo
pub fn parallelMapWith<T, S>(v: Vec<T>, windows: i64, states: Vec<S>, f: (Shard<T>, &mut S) => Shard<T>): Result<Mapped<T, S>, NoWorkers<T>>
```

parallelMap with two things it cannot express: more windows than workers, and
per-worker state.

More windows than workers is how uneven work balances out. parallelMap spawns
one thread per window, so over-partitioning a 64-window render costs 64 OS
threads. Here `states.len` fixes the worker count and the windows go into a
queue the workers pull from: a worker that drew a cheap window pulls another,
and one that drew the expensive window keeps grinding without idling the rest.

The states are the answer to "why must `f` be a plain function": a closure
cannot be copied to N workers, so whatever it would have captured travels as an
explicit owned value instead. Each worker moves one `S` in, threads it through
every window it processes, and hands it back through the result. Configuration
rides in, accumulators ride out, and nothing is shared: an S is on exactly one
thread at a time, which is the same move-checker argument the windows use.

Which worker processes which window is scheduling, so state a caller reads back
must not encode the assignment: per-worker tallies merge into totals that are
deterministic even though each worker's share is not.

#### `parallelScanStr`

```milo
pub fn parallelScanStr<R>(s: string, windows: i64, overlap: i64, f: (&StrShard) => R): Scanned<R>
```

Divide a string into `windows` read-only windows, each extended `overlap` bytes into
the next, run `f` over every window on its own OS thread, and hand back the string
with the per-window results. The whole read-only cycle in one call; `parallelMap`
is the writing equivalent.

    let scanned = parallelScanStr(text, 4, needle.len - 1, countMilo)
    for n in scanned.results { total = total + n }

`f` borrows the window and returns whatever the scan produced: a count, a position
list, a checksum. It is a plain function for the reason `parallelMap`'s is: each
worker needs its own copy, and a capturing closure would be moved into the first
task and gone for the rest. Anything the scan depends on beyond the bytes travels
as a global or a constant inside `f`.

A match that begins inside a window's overlap is also visible to the next window,
so a counting `f` must stop at `w.ownLen()`, not `w.len()`.

<!-- /generated:api -->
