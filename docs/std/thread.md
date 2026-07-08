# std/thread

## std/thread

### `Thread.join`

```milo
fn Thread.join(self: &Thread): Result<i32>
```

_Undocumented._

### `Thread.sleep`

```milo
fn Thread.sleep(ms: i64): void
```

_Undocumented._

### `Thread.spawn`

```milo
fn Thread.spawn(f: () => void): Result<Thread>
```

_Undocumented._

### `threadSpawn`

```milo
fn threadSpawn(func: *u8, arg: *u8): Result<Thread>
```

_Undocumented._

### `threadSpawnFn`

```milo
fn threadSpawnFn(func: (*u8) => *u8): Result<Thread>
```

_Undocumented._
