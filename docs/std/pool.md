# std/pool

## std/pool

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.poolAlloc`

```milo
fn Drop.poolAlloc(p: &mut Pool): Result<i64>
```

Allocate one block. O(1). Returns Err when pool is exhausted.

### `Drop.poolAvailable`

```milo
fn Drop.poolAvailable(p: &Pool): i64
```

Number of blocks available.

### `Drop.poolEmpty`

```milo
fn Drop.poolEmpty(p: &Pool): bool
```

Check if pool has no live allocations.

### `Drop.poolFree`

```milo
fn Drop.poolFree(p: &mut Pool, block: i64): void
```

Free one block back to pool. O(1).
Caller must pass a pointer previously returned by poolAlloc.

### `Drop.poolFull`

```milo
fn Drop.poolFull(p: &Pool): bool
```

Check if pool is fully exhausted.

### `Drop.poolLive`

```milo
fn Drop.poolLive(p: &Pool): i64
```

Number of blocks currently in use.

### `Drop.poolNew`

```milo
fn Drop.poolNew(size: i64, count: i64): Result<Pool>
```

Create a pool of `count` blocks, each `size` bytes (minimum 8 for free-list pointer).
Single malloc at init — no further heap allocation.

### `Drop.poolReset`

```milo
fn Drop.poolReset(p: &mut Pool): void
```

Reset pool to initial state — all blocks free.
Existing pointers become invalid.

### `Pool.alloc`

```milo
fn Pool.alloc(self: &mut Pool): Result<i64>
```

_Undocumented._

### `Pool.available`

```milo
fn Pool.available(self: &Pool): i64
```

_Undocumented._

### `Pool.empty`

```milo
fn Pool.empty(self: &Pool): bool
```

_Undocumented._

### `Pool.free`

```milo
fn Pool.free(self: &mut Pool, block: i64): void
```

_Undocumented._

### `Pool.full`

```milo
fn Pool.full(self: &Pool): bool
```

_Undocumented._

### `Pool.live`

```milo
fn Pool.live(self: &Pool): i64
```

_Undocumented._

### `Pool.reset`

```milo
fn Pool.reset(self: &mut Pool): void
```

_Undocumented._
