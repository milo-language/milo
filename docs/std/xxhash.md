# std/xxhash

## std/xxhash

### `mergeRound`

```milo
fn mergeRound(acc: u64, val: u64): u64
```

Fold one 64-bit lane into the digest after the main loop.

### `p1`

```milo
fn p1(): u64
```

_Undocumented._

### `p2`

```milo
fn p2(): u64
```

_Undocumented._

### `p3`

```milo
fn p3(): u64
```

_Undocumented._

### `p4`

```milo
fn p4(): u64
```

_Undocumented._

### `p5`

```milo
fn p5(): u64
```

_Undocumented._

### `read32`

```milo
fn read32(src: &string, p: i64): u64
```

_Undocumented._

### `read64`

```milo
fn read64(src: &string, p: i64): u64
```

_Undocumented._

### `rotl`

```milo
pub fn rotl(x: u64, r: u64): u64
```

_Undocumented._

### `xxh64`

```milo
pub fn xxh64(src: &string, seed: u64): u64
```

XXH64 digest of `src` with the given seed. `xxhsum -H64` uses seed 0.

### `xxh64Hex`

```milo
pub fn xxh64Hex(src: &string, seed: u64): string
```

16-char lowercase hex of the digest, matching `xxhsum -H64` output.
