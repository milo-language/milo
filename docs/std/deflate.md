# std/deflate

## std/deflate

### `deflate`

```milo
pub fn deflate(src: &string): string
```

Compress raw bytes to a single fixed-Huffman DEFLATE stream.

### `distBase`

```milo
pub fn distBase(): [i64; 30]
```

_Undocumented._

### `distExtra`

```milo
pub fn distExtra(): [i64; 30]
```

_Undocumented._

### `emitMatch`

```milo
fn emitMatch(w: &mut BitW, len: i64, dist: i64)
```

Emit a back-reference: length symbol (257..285) + extra, then distance code + extra.

### `emitSym`

```milo
fn emitSym(w: &mut BitW, s: i64)
```

Emit a literal/length symbol (0..287) with the fixed-Huffman code table.

### `flush`

```milo
fn flush(w: &mut BitW)
```

Pad the final partial byte with zero bits and flush it.

### `gzipCompress`

```milo
pub fn gzipCompress(src: &string): string
```

Compress to a gzip stream (RFC 1952): fixed 10-byte header, DEFLATE body,
CRC-32 + ISIZE trailer. Output is accepted by system gunzip and std/inflate.

### `hash3`

```milo
fn hash3(src: &string, p: i64): i64
```

Hash of the 3 bytes at position p (p+2 must be in range).

### `lenBase`

```milo
pub fn lenBase(): [i64; 29]
```

_Undocumented._

### `lenExtra`

```milo
pub fn lenExtra(): [i64; 29]
```

_Undocumented._

### `matchLen`

```milo
fn matchLen(src: &string, a: i64, b: i64, maxLen: i64): i64
```

Length of the byte run shared by positions a and b (a < b), capped at maxLen.

### `push32BE`

```milo
fn push32BE(out: &mut string, v: i64)
```

_Undocumented._

### `push32LE`

```milo
fn push32LE(out: &mut string, v: i64)
```

_Undocumented._

### `putBit`

```milo
fn putBit(w: &mut BitW, bit: i64)
```

_Undocumented._

### `putBits`

```milo
fn putBits(w: &mut BitW, val: i64, n: i64)
```

LSB-first: bit 0 of val first. Used for the block header and extra bits.

### `putCode`

```milo
fn putCode(w: &mut BitW, code: i64, n: i64)
```

MSB-first: bit (n-1) of code first. Used for Huffman codes (RFC 1951 §3.1.1).

### `zlibCompress`

```milo
pub fn zlibCompress(src: &string): string
```

Compress to a zlib stream (RFC 1950): 2-byte header, DEFLATE body, Adler-32.
