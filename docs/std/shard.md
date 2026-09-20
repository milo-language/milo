# std/shard

## std/shard

### `NoWorkers.message`

```milo
fn NoWorkers.message(self: &NoWorkers): string
```

A sentence for a human, for a caller that only wants to log.

### `parallelMap`

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

### `parallelMapWith`

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

### `parallelScanStr`

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

### `Shard.get`

```milo
fn Shard.get(self: &Shard, i: i64): T
```

The element at `i` within THIS window. Bounds-checked against the window's own
length, so a stray index cannot reach a sibling window's elements.

### `Shard.index`

```milo
fn Shard.index(self: &Shard): i64
```

Which window of the division this is, counting from 0.

### `Shard.len`

```milo
fn Shard.len(self: &Shard): i64
```

Elements in this window.

### `Shard.set`

```milo
fn Shard.set(self: &mut Shard, i: i64, val: T): void
```

Overwrite the element at `i` within this window. Bounds-checked the same way.

### `Shard.start`

```milo
fn Shard.start(self: &Shard): i64
```

Where this window begins in the ORIGINAL buffer. Without it a worker can only
do position-independent work: a filter that needs to know which pixel, row or
sample it is looking at has no way to find out, because a window's own indices
all start at 0. Global position of element `i` is `start() + i`.

### `StrShard.byteAt`

```milo
fn StrShard.byteAt(self: &StrShard, i: i64): u8
```

The byte at `i` within this window, bounds-checked against its length.

### `StrShard.index`

```milo
fn StrShard.index(self: &StrShard): i64
```

Which window of the division this is, counting from 0.

### `StrShard.len`

```milo
fn StrShard.len(self: &StrShard): i64
```

Bytes in this window, including any overlap it was given.

### `StrShard.matchesAt`

```milo
fn StrShard.matchesAt(self: &StrShard, i: i64, needle: &string): bool
```

Whether this window's bytes at `i` match `needle`. Bounded by the window, so a
needle running past the end is simply not a match here; give the window an
overlap if you need to catch one that straddles the boundary.

### `StrShard.ownLen`

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

### `StrShard.start`

```milo
fn StrShard.start(self: &StrShard): i64
```

Where this window begins in the original string.
