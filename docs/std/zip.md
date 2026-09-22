# std/zip

## std/zip

### `Zip.read`

```milo
fn Zip.read(src: &string): Result<Vec<ZipEntry>, string>
```

Read every entry, decompressing and CRC-checking each. Errs on a malformed
archive, an unsupported compression method, or a CRC mismatch.
