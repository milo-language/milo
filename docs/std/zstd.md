# std/zstd

## std/zstd

### `zstdDecompress`

```milo
fn zstdDecompress(src: &string): Result<string, string>
```

Decompress a single zstd frame. Multi-frame concatenation is not handled — one
frame per call, like `zstd`'s default single-frame output.
