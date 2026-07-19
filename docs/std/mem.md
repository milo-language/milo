# std/mem

## std/mem

### `arenaAlloc`

```milo
fn arenaAlloc(a: &mut Arena, size: i64): Result<i64>
```

Allocate size bytes from the arena (8-byte aligned).
Returns Err if the arena doesn't have enough space.

### `arenaNew`

```milo
fn arenaNew(capacity: i64): Result<Arena>
```

Create a new arena with the given capacity in bytes.

### `arenaRemaining`

```milo
fn arenaRemaining(a: &Arena): i64
```

_Undocumented._

### `arenaReset`

```milo
fn arenaReset(a: &mut Arena): void
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

### `mmapAnon`

```milo
fn mmapAnon(size: i64): Result<MappedMemory>
```

Allocate an anonymous (non-file-backed) memory-mapped region.

### `mmapFile`

```milo
fn mmapFile(fFd: i32, size: i64): Result<MappedMemory>
```

Memory-map a file descriptor for reading.
