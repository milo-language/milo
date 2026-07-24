# std/png

## std/png

### `be32`

```milo
fn be32(src: &string, p: i64): i64
```

_Undocumented._

### `decodePng`

```milo
pub fn decodePng(src: &string): Result<PngImage, string>
```

_Undocumented._

### `paeth`

```milo
fn paeth(a: i64, b: i64, c: i64): i64
```

Paeth predictor (RFC 2083 §6.6): pick whichever of a/b/c the initial estimate
a+b-c is closest to.
