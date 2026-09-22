# std/deflate

## std/deflate

### `Deflate.gzip`

```milo
fn Deflate.gzip(src: &string): string
```

Compress to a gzip stream: 10-byte header, DEFLATE body, CRC-32 + length trailer.

### `Deflate.raw`

```milo
fn Deflate.raw(src: &string): string
```

Compress to a single fixed-Huffman DEFLATE stream (no container header).

### `Deflate.zlib`

```milo
fn Deflate.zlib(src: &string): string
```

Compress to a zlib stream: 2-byte header, DEFLATE body, Adler-32 trailer.
