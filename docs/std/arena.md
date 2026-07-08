# std/arena

## std/arena

### `Arena.alloc`

```milo
fn Arena.alloc(self: &mut Arena, val: T): Handle<T>
```

_Undocumented._

### `Arena.free`

```milo
fn Arena.free(self: &mut Arena, h: Handle<T>): bool
```

_Undocumented._

### `Arena.get`

```milo
fn Arena.get(self: &Arena, h: Handle<T>): Option<T>
```

_Undocumented._

### `Arena.modify`

```milo
fn Arena.modify(self: &mut Arena, h: Handle<T>, f: (T) => T): bool
```

_Undocumented._

### `Arena.modifyMut`

```milo
fn Arena.modifyMut(self: &mut Arena, h: Handle<T>, f: (&mut T) => void): bool
```

_Undocumented._

### `Arena.set`

```milo
fn Arena.set(self: &mut Arena, h: Handle<T>, val: T): bool
```

_Undocumented._

### `Arena.valid`

```milo
fn Arena.valid(self: &Arena, h: Handle<T>): bool
```

_Undocumented._

### `arenaAlloc`

```milo
fn arenaAlloc<T> (a: &mut Arena<T>, val: T): Handle<T>
```

_Undocumented._

### `arenaFree`

```milo
fn arenaFree<T> (a: &mut Arena<T>, h: Handle<T>): bool
```

_Undocumented._

### `arenaGet`

```milo
fn arenaGet<T> (a: &Arena<T>, h: Handle<T>): Option<T>
```

_Undocumented._

### `arenaLen`

```milo
fn arenaLen<T> (a: &Arena<T>): i64
```

_Undocumented._

### `arenaModify`

```milo
fn arenaModify<T> (a: &mut Arena<T>, h: Handle<T>, f: (T) => T): bool
```

_Undocumented._

### `arenaModifyMut`

```milo
fn arenaModifyMut<T> (a: &mut Arena<T>, h: Handle<T>, f: (&mut T) => void): bool
```

_Undocumented._

### `arenaNew`

```milo
fn arenaNew<T> (): Arena<T>
```

_Undocumented._

### `arenaSet`

```milo
fn arenaSet<T> (a: &mut Arena<T>, h: Handle<T>, val: T): bool
```

_Undocumented._

### `arenaValid`

```milo
fn arenaValid<T> (a: &Arena<T>, h: Handle<T>): bool
```

_Undocumented._

### `arenaWith`

```milo
fn arenaWith<T, R> (a: &Arena<T>, h: Handle<T>, f: (&T) => R): Option<R>
```

_Undocumented._
