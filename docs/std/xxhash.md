# std/xxhash

## std/xxhash

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
