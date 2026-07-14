# std/sort

## std/sort

### `reverseI64`

```milo
fn reverseI64(v: &mut Vec<i64>): void
```

Reverse a Vec<i64> in place.

### `sortI32`

```milo
fn sortI32(v: &mut Vec<i32>): void
```

Sort Vec<i32> in ascending order.

### `sortI64`

```milo
fn sortI64(v: &mut Vec<i64>): void
```

Sort Vec<i64> in ascending order.

### `sortStrings`

```milo
fn sortStrings(v: &mut Vec<string>): void
```

Sort Vec<string> in lexicographic order.

### `sortStringsByFreq`

```milo
fn sortStringsByFreq(keys: &mut Vec<string>, vals: &mut Vec<i64>): void
```

Sort Vec<string> + parallel Vec<i64> by values descending, then keys ascending (for top-N).
