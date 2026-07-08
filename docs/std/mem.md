# std/mem

## std/mem

### `Drop.arenaAlloc`

```milo
fn Drop.arenaAlloc(a: &mut Arena, size: i64): Result<i64>
```

_Undocumented._

### `Drop.arenaNew`

```milo
fn Drop.arenaNew(capacity: i64): Result<Arena>
```

_Undocumented._

### `Drop.arenaRemaining`

```milo
fn Drop.arenaRemaining(a: &Arena): i64
```

_Undocumented._

### `Drop.arenaReset`

```milo
fn Drop.arenaReset(a: &mut Arena): void
```

_Undocumented._

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.mmapAnon`

```milo
fn Drop.mmapAnon(size: i64): Result<MappedMemory>
```

_Undocumented._

### `Drop.mmapFile`

```milo
fn Drop.mmapFile(fFd: i32, size: i64): Result<MappedMemory>
```

_Undocumented._
