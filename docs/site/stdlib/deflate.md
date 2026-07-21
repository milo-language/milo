# std/deflate

Pure-Milo DEFLATE compression (RFC 1951) plus the gzip (RFC 1952) and zlib (RFC 1950) container framings. No external codec dependency. Decompress with [`std/inflate`](inflate).

```milo
from "std/deflate" import { deflate, gzipCompress, zlibCompress }
```

## Functions

### deflate

```milo
fn deflate(src: &string): string
```

Compresses raw bytes to a single fixed-Huffman DEFLATE stream (no container header).

### gzipCompress

```milo
fn gzipCompress(src: &string): string
```

Compresses to a gzip stream: 10-byte header, DEFLATE body, CRC-32 + length trailer.

### zlibCompress

```milo
fn zlibCompress(src: &string): string
```

Compresses to a zlib stream: 2-byte header, DEFLATE body, Adler-32 trailer.

```milo
from "std/inflate" import { gzipDecompress }

let gz = gzipCompress(&"hello, hello, hello")
let back = gzipDecompress(&gz)!   // "hello, hello, hello"
```
