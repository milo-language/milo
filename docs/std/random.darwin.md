# std/random.darwin

## std/random.darwin

### `randBool`

```milo
pub fn randBool(): bool
```

Random bool (coin flip).

### `randBytes`

```milo
pub fn randBytes(buf: *u8, n: i64): void
```

Fill a buffer with random bytes.

### `randFloat`

```milo
pub fn randFloat(): f64
```

Random f64 in [0.0, 1.0).

### `randFloatRange`

```milo
pub fn randFloatRange(min: f64, max: f64): f64
```

Random f64 in [min, max).

### `randInt`

```milo
pub fn randInt(max: i64): i64
```

Random i64 in [0, max). Panics if max <= 0.

### `randRange`

```milo
pub fn randRange(min: i64, max: i64): i64
```

Random i64 in [min, max]. Panics if min > max.

### `randU32`

```milo
pub fn randU32(): u32
```

Random u32 in [0, 2^32).

### `shuffleI64`

```milo
pub fn shuffleI64(v: &mut Vec<i64>, n: i64): void
```

Shuffle a Vec<i64> in place using Fisher-Yates. Pass v.len() as n.
