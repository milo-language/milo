# std/zip

## std/zip

### `zipRead`

```milo
fn zipRead(src: &string): Result<Vec<ZipEntry>, string>
```

Read every entry, decompressing and CRC-checking each.
