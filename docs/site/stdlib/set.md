# std/set

Hash set collection for unique values.

```milo
from "std/set" import { HashSet, setNew, setAdd, setContains, setRemove, setLen }
```

## Types

### HashSet

```milo
struct HashSet<T>
```

An unordered collection of unique values.

## Functions

### setNew

```milo
fn setNew<T>(): HashSet<T>
```

Creates an empty hash set.

### setAdd

```milo
fn setAdd<T>(set: &mut HashSet<T>, value: T)
```

Inserts `value` into the set. No-op if already present.

### setContains

```milo
fn setContains<T>(set: &HashSet<T>, value: T): bool
```

Returns true if the set contains `value`.

### setRemove

```milo
fn setRemove<T>(set: &mut HashSet<T>, value: T)
```

Removes `value` from the set if present.

### setLen

```milo
fn setLen<T>(set: &HashSet<T>): i64
```

Returns the number of elements in the set.

```milo
var seen = setNew<string>()
setAdd(&mut seen, "alice")
setAdd(&mut seen, "bob")
setAdd(&mut seen, "alice")  // no-op
print(intToString(setLen(&seen)))  // 2
```
