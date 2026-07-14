# std/mem

## std/mem

### `Drop.arenaAlloc`

```milo
fn Drop.arenaAlloc(a: &mut Arena, size: i64): Result<i64>
```

Allocate size bytes from the arena (8-byte aligned).
Returns Err if the arena doesn't have enough space.

### `Drop.arenaNew`

```milo
fn Drop.arenaNew(capacity: i64): Result<Arena>
```

Create a new arena with the given capacity in bytes.

### `Drop.arenaRemaining`

```milo
fn Drop.arenaRemaining(a: &Arena): i64
```

_Undocumented._

### `Drop.arenaReset`

```milo
fn Drop.arenaReset(a: &mut Arena): void
```

Reset the arena, making all previously allocated memory available for reuse.

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

Allocate an anonymous (non-file-backed) memory-mapped region.

### `Drop.mmapFile`

```milo
fn Drop.mmapFile(fFd: i32, size: i64): Result<MappedMemory>
```

Memory-map a file descriptor for reading.
