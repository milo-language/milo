# std/random.linux

## std/random.linux

### `randBool`

```milo
fn randBool(): bool
```

Random bool (coin flip).

### `randBytes`

```milo
fn randBytes(buf: *u8, n: i64): void
```

Fill a buffer with random bytes.

### `randFloat`

```milo
fn randFloat(): f64
```

Random f64 in [0.0, 1.0).

### `randFloatRange`

```milo
fn randFloatRange(min: f64, max: f64): f64
```

Random f64 in [min, max).

### `randInt`

```milo
fn randInt(max: i64): i64
```

Random i64 in [0, max). Panics if max <= 0.

### `randRange`

```milo
fn randRange(min: i64, max: i64): i64
```

Random i64 in [min, max]. Panics if min > max.

### `randU32`

```milo
fn randU32(): u32
```

Random u32 in [0, 2^32).

### `shuffleI64`

```milo
fn shuffleI64(v: &mut Vec<i64>, n: i64): void
```

Shuffle a Vec<i64> in place using Fisher-Yates. Pass v.len() as n.
