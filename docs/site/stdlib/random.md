# std/random

Random number generation.

```milo
from "std/random" import { randInt, randRange, randFloat, randBool, shuffleI64 }
```

## Functions

### randU32

```milo
fn randU32(): u32
```

Returns a random 32-bit unsigned integer.

### randInt

```milo
fn randInt(max: i64): i64
```

Returns a random integer in `[0, max)`.

### randRange

```milo
fn randRange(min: i64, max: i64): i64
```

Returns a random integer in `[min, max)`.

### randFloat

```milo
fn randFloat(): f64
```

Returns a random float in `[0.0, 1.0)`.

### randFloatRange

```milo
fn randFloatRange(min: f64, max: f64): f64
```

Returns a random float in `[min, max)`.

### randBool

```milo
fn randBool(): bool
```

Returns `true` or `false` with equal probability.

### shuffleI64

```milo
fn shuffleI64(v: &mut Vec<i64>, len: i64)
```

Shuffles the first `len` elements of a vector in-place.

### randBytes

```milo
fn randBytes(buf: *u8, len: i64)
```

Fills a buffer with `len` random bytes.
