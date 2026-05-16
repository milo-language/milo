# std/sort

In-place sorting for common types.

```milo
from "std/sort" import { sortI64, sortStrings, reverseI64 }
```

## Functions

### sortI64

```milo
fn sortI64(v: &mut Vec<i64>)
```

Sorts a vector of `i64` in ascending order.

### sortI32

```milo
fn sortI32(v: &mut Vec<i32>)
```

Sorts a vector of `i32` in ascending order.

### sortStrings

```milo
fn sortStrings(v: &mut Vec<string>)
```

Sorts a vector of strings lexicographically.

### reverseI64

```milo
fn reverseI64(v: &mut Vec<i64>)
```

Reverses a vector of `i64` in-place.

## Example

```milo
var nums = [3, 1, 4, 1, 5]
sortI64(&mut nums)
// nums is now [1, 1, 3, 4, 5]

reverseI64(&mut nums)
// nums is now [5, 4, 3, 1, 1]
```
