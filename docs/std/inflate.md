# std/inflate

## std/inflate

### `gzipDecompress`

```milo
pub fn gzipDecompress(src: &string): Result<string, string>
```

Inflate a gzip stream (RFC 1952): 10-byte header, optional extra/name/comment/
hcrc fields, DEFLATE body, then CRC-32 + ISIZE trailer. Both are verified.

### `inflate`

```milo
pub fn inflate(src: &string): Result<string, string>
```

Inflate a raw DEFLATE stream (no gzip/zlib wrapper).

### `zlibDecompress`

```milo
pub fn zlibDecompress(src: &string): Result<string, string>
```

Inflate a zlib stream (RFC 1950): 2-byte header, DEFLATE body, Adler-32 trailer.
