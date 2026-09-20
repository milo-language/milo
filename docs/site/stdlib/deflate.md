# std/deflate

Pure-Milo DEFLATE compression (RFC 1951) plus the gzip (RFC 1952) and zlib (RFC 1950) container framings. No external codec dependency. Decompress with [`std/inflate`](inflate).

```milo
from "std/deflate" import { Deflate }
```

## Functions

### Deflate.raw

```milo
fn Deflate.raw(src: &string): string
```

Compresses raw bytes to a single fixed-Huffman DEFLATE stream (no container header).

### Deflate.gzip

```milo
fn Deflate.gzip(src: &string): string
```

Compresses to a gzip stream: 10-byte header, DEFLATE body, CRC-32 + length trailer.

### Deflate.zlib

```milo
fn Deflate.zlib(src: &string): string
```

Compresses to a zlib stream: 2-byte header, DEFLATE body, Adler-32 trailer.

```milo
from "std/inflate" import { Inflate }

let gz = Deflate.gzip("hello, hello, hello")
let back = Inflate.gzip(gz)!   // "hello, hello, hello"
```
