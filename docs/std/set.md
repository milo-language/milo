# std/set

## std/set

### `setAdd`

```milo
fn setAdd<T>(s: &mut HashSet<T>, val: T): void
```

Add a value to the set.

### `setContains`

```milo
fn setContains<T>(s: &HashSet<T>, val: T): bool
```

Check if the set contains a value.

### `setLen`

```milo
fn setLen<T>(s: &HashSet<T>): i64
```

Number of elements in the set.

### `setNew`

```milo
fn setNew<T>(): HashSet<T>
```

Create an empty HashSet.

### `setRemove`

```milo
fn setRemove<T>(s: &mut HashSet<T>, val: T): void
```

Remove a value from the set.
