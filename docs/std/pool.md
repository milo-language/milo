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

_Undocumented._

### `Drop.poolAvailable`

```milo
fn Drop.poolAvailable(p: &Pool): i64
```

_Undocumented._

### `Drop.poolEmpty`

```milo
fn Drop.poolEmpty(p: &Pool): bool
```

_Undocumented._

### `Drop.poolFree`

```milo
fn Drop.poolFree(p: &mut Pool, block: i64): void
```

_Undocumented._

### `Drop.poolFull`

```milo
fn Drop.poolFull(p: &Pool): bool
```

_Undocumented._

### `Drop.poolLive`

```milo
fn Drop.poolLive(p: &Pool): i64
```

_Undocumented._

### `Drop.poolNew`

```milo
fn Drop.poolNew(size: i64, count: i64): Result<Pool>
```

_Undocumented._

### `Drop.poolReset`

```milo
fn Drop.poolReset(p: &mut Pool): void
```

_Undocumented._

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
