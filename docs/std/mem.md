# std/mem

## std/mem

### `Bump.alloc`

```milo
fn Bump.alloc(self: &mut Bump, size: i64): Result<i64>
```

Bump-allocate `size` bytes (8-byte aligned) and return the address. Errs when the
region is full.

### `Bump.new`

```milo
fn Bump.new(capacity: i64): Result<Bump>
```

Create a bump allocator over `capacity` bytes of heap. The whole region is freed
when the Bump drops.

### `Bump.remaining`

```milo
fn Bump.remaining(self: &Bump): i64
```

Bytes still available.

### `Bump.reset`

```milo
fn Bump.reset(self: &mut Bump): void
```

Reclaim every allocation at once by resetting the used count to zero.

### `mmapAnon`

```milo
pub fn mmapAnon(size: i64): Result<MappedMemory>
```

Allocate an anonymous (non-file-backed) memory-mapped region.

### `mmapFile`

```milo
pub fn mmapFile(fFd: i32, size: i64): Result<MappedMemory>
```

Memory-map a file descriptor for reading.
