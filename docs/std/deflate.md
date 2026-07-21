# std/deflate

## std/deflate

### `deflate`

```milo
fn deflate(src: &string): string
```

Compress raw bytes to a single fixed-Huffman DEFLATE stream.

### `gzipCompress`

```milo
fn gzipCompress(src: &string): string
```

Compress to a gzip stream (RFC 1952): fixed 10-byte header, DEFLATE body,
CRC-32 + ISIZE trailer. Output is accepted by system gunzip and std/inflate.

### `zlibCompress`

```milo
fn zlibCompress(src: &string): string
```

Compress to a zlib stream (RFC 1950): 2-byte header, DEFLATE body, Adler-32.
