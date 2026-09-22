# std/random.darwin

## std/random.darwin

### `Random.bool`

```milo
fn Random.bool(): bool
```

`true` or `false` with equal probability.

### `Random.bytes`

```milo
fn Random.bytes(buf: *u8, n: i64): void
```

Fill `buf` with `n` random bytes.

### `Random.float`

```milo
fn Random.float(): f64
```

A random float in [0.0, 1.0).

### `Random.floatRange`

```milo
fn Random.floatRange(min: f64, max: f64): f64
```

A random float in [min, max).

### `Random.int`

```milo
fn Random.int(max: i64): i64
```

A random integer in [0, max). `max` must be positive.

### `Random.range`

```milo
fn Random.range(min: i64, max: i64): i64
```

A random integer in [min, max], both ends inclusive.

### `Random.shuffleI64`

```milo
fn Random.shuffleI64(v: &mut Vec<i64>, n: i64): void
```

Shuffle the first `n` elements of `v` in place (Fisher-Yates). Pass `v.len()` for
all.

### `Random.u32`

```milo
fn Random.u32(): u32
```

A random u32 in [0, 2^32).
