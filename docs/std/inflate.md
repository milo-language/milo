# std/inflate

## std/inflate

### `bits`

```milo
fn bits(st: &mut InfState, src: &string, need: i64): i64
```

Pull `need` bits LSB-first. On exhausted input, latches err and returns 0 so
callers unwind via their err checks rather than looping forever.
Contract note: `result >= 0` and the bit-accumulator invariants are true but not
stated — Milo's VC translator has no bitvector theory (`&`/`<<`), and loop
invariants over struct fields aren't yet modelled. The linear precondition below
is what the prover discharges at every call site, pinning `need` to the range the
mask/shift math is valid for.

### `clcOrder`

```milo
fn clcOrder(): [i64; 19]
```

Order in which code-length-code lengths appear (RFC 1951 §3.2.7).

### `codes`

```milo
fn codes(st: &mut InfState, src: &string, lencode: &Huff, distcode: &Huff): i64
```

Decode length/literal + distance codes for one compressed block.

### `construct`

```milo
fn construct(h: &mut Huff, length: &Vec<i64>, off: i64, n: i64): i64
```

Build a canonical Huffman table from code lengths length[off .. off+n].
Returns 0 for a complete code, >0 for an incomplete (under-subscribed) code,
<0 if over-subscribed (invalid).

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

### `dynamic`

```milo
fn dynamic(st: &mut InfState, src: &string): i64
```

Dynamic Huffman block: read the two code tables from the stream, then decode.

### `fixed`

```milo
fn fixed(st: &mut InfState, src: &string): i64
```

Fixed Huffman block (RFC 1951 §3.2.6): lengths are defined by the spec.

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

### `le32`

```milo
pub fn le32(src: &string, p: i64): i64
```

Little-endian 32-bit read at offset `p`, as a value in [0, 2^32).

### `le32BE`

```milo
fn le32BE(src: &string, p: i64): i64
```

zlib's Adler trailer is big-endian, unlike gzip's little-endian fields.

### `lenBase`

```milo
pub fn lenBase(): [i64; 29]
```

Length base + extra-bit tables for length symbols 257..285.

### `lenExtra`

```milo
pub fn lenExtra(): [i64; 29]
```

_Undocumented._

### `stored`

```milo
fn stored(st: &mut InfState, src: &string): i64
```

A stored (uncompressed) block: byte-align, LEN, ~LEN, then LEN raw bytes.

### `zeros`

```milo
fn zeros(n: i64): Vec<i64>
```

_Undocumented._

### `zlibDecompress`

```milo
pub fn zlibDecompress(src: &string): Result<string, string>
```

Inflate a zlib stream (RFC 1950): 2-byte header, DEFLATE body, Adler-32 trailer.
