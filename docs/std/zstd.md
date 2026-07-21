# std/zstd

## std/zstd

### `zstdCompressRaw`

```milo
fn zstdCompressRaw(src: &string): string
```

Encode `src` as a zstd frame of Raw blocks (RFC 8878). No entropy stage — this is
valid, `zstd -d`-decodable output at zero compression; the compressing path (LZ77 +
FSE-coded sequences) builds on this frame scaffolding. Single-segment header carries
the content size, and an XXH64 content checksum is appended.

### `zstdDecompress`

```milo
fn zstdDecompress(src: &string): Result<string, string>
```

Decompress a single zstd frame. Multi-frame concatenation is not handled — one
frame per call, like `zstd`'s default single-frame output.
