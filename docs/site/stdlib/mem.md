# std/mem

Memory mapping and bump allocation primitives.

> This is the raw memory arena (bump allocator). For a generational arena with typed `Handle<T>`, see `std/arena`.

```milo
from "std/mem" import { MappedMemory, Arena, mmapAnon, arenaNew, arenaAlloc, arenaReset }
```

## Types

### MappedMemory

```milo
struct MappedMemory {
    ptr: i64,
    len: i64,
}
```

A region of memory-mapped address space.

### Arena

```milo
struct Arena {
    base: i64,
    cap: i64,
    used: i64,
}
```

A bump allocator backed by a contiguous memory region.

## Functions

### mmapAnon

```milo
fn mmapAnon(len: i64): Result<MappedMemory>
```

Maps `len` bytes of anonymous (zero-filled) memory.

### mmapFile

```milo
fn mmapFile(fd: i32, len: i64): Result<MappedMemory>
```

Memory-maps `len` bytes from file descriptor `fd`.

### arenaNew

```milo
fn arenaNew(capacity: i64): Result<Arena>
```

Creates a new arena with the given byte capacity (backed by `mmapAnon`).

### arenaAlloc

```milo
fn arenaAlloc(arena: &mut Arena, size: i64): Result<i64>
```

Bump-allocates `size` bytes from the arena, returning a pointer. Fails if the arena is full.

### arenaReset

```milo
fn arenaReset(arena: &mut Arena)
```

Resets the arena's used counter to zero, reclaiming all allocations.
