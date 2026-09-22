# std/inflate

## std/inflate

### `Inflate.gzip`

```milo
fn Inflate.gzip(src: &string): Result<string, string>
```

Unwrap a gzip stream and decompress its body. Errs on malformed input or a
checksum mismatch.

### `Inflate.raw`

```milo
fn Inflate.raw(src: &string): Result<string, string>
```

Decompress a raw DEFLATE stream (no container header). Malformed input is an
`Err`, not a crash.

### `Inflate.zlib`

```milo
fn Inflate.zlib(src: &string): Result<string, string>
```

Unwrap a zlib stream and decompress its body. Errs on malformed input or a
checksum mismatch.
