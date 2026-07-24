# std/sort

## std/sort

### `reverseI64`

```milo
pub fn reverseI64(v: &mut Vec<i64>): void
```

Reverse a Vec<i64> in place.

### `sortI32`

```milo
pub fn sortI32(v: &mut Vec<i32>): void
```

Sort Vec<i32> in ascending order.

### `sortI64`

```milo
pub fn sortI64(v: &mut Vec<i64>): void
```

Sort Vec<i64> in ascending order.

### `sortStrings`

```milo
pub fn sortStrings(v: &mut Vec<string>): void
```

Sort Vec<string> in lexicographic order.

### `sortStringsByFreq`

```milo
pub fn sortStringsByFreq(keys: &mut Vec<string>, vals: &mut Vec<i64>): void
```

Sort Vec<string> + parallel Vec<i64> by values descending, then keys ascending (for top-N).
