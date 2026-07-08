# std/cstr

## std/cstr

### `CStr.byte`

```milo
fn CStr.byte(self: &CStr, i: i64): u8
```

Bounds-checked byte access. Panics if i >= len.

### `CStr.eq`

```milo
fn CStr.eq(self: &CStr, other: CStr): bool
```

_Undocumented._

### `CStr.len`

```milo
fn CStr.len(self: &CStr): i64
```

_Undocumented._

### `CStr.ptr`

```milo
fn CStr.ptr(self: &CStr): *u8
```

_Undocumented._

### `CStr.toString`

```milo
fn CStr.toString(self: &CStr): string
```

_Undocumented._

### `CStr.wrap`

```milo
fn CStr.wrap(ptr: *u8): Option<CStr>
```

_Undocumented._
