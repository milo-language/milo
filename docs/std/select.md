# std/select

## std/select

### `Select.armChan`

```milo
fn Select.armChan(self: &mut Select, kind: i64, ptr: *u8): void
```

_Undocumented._

### `Select.destroy`

```milo
fn Select.destroy(self: &Select): void
```

_Undocumented._

### `Select.new`

```milo
fn Select.new(): Select
```

_Undocumented._

### `Select.onRead`

```milo
fn Select.onRead(self: &mut Select, fd: i32): void
```

_Undocumented._

### `Select.onTimeout`

```milo
fn Select.onTimeout(self: &mut Select, ms: i64): void
```

_Undocumented._

### `Select.onWrite`

```milo
fn Select.onWrite(self: &mut Select, fd: i32): void
```

_Undocumented._

### `Select.wait`

```milo
fn Select.wait(self: &mut Select): i64
```

Arm every source, park until one fires, tear down the rest, return the
winning arm index.

### `selectRecv`

```milo
fn selectRecv<T>(sel: &mut Select, ch: &Channel<T>): void
```

Channel arms — free functions so they can be generic over the element type.

### `selectSend`

```milo
fn selectSend<T>(sel: &mut Select, ch: &Channel<T>): void
```

_Undocumented._
