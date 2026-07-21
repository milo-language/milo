# std/zip

Read PKZIP archives (APPNOTE.TXT), pure Milo over [`std/inflate`](inflate). Reads the central directory, then for each entry inflates the payload — stored (method 0) is copied, deflate (method 8) is inflated — and verifies each entry's CRC-32 against the directory.

Read-only and whole-archive (no streaming, no zip64, no encryption) — enough to open `.zip` / `.jar` / `.epub` / `.docx`.

```milo
from "std/zip" import { zipRead, ZipEntry }
```

## Types

```milo
struct ZipEntry {
    name: string,
    data: string,   // decompressed contents
}
```

## Functions

### zipRead

```milo
fn zipRead(src: &string): Result<Vec<ZipEntry>, string>
```

Reads every entry, decompressing and CRC-checking each. Returns an error on a malformed archive, an unsupported method, or a CRC mismatch.

```milo
from "std/io" import { readFile }

let bytes = readFile("archive.zip")!
for entry in zipRead(&bytes)! {
    print($"{entry.name}: {entry.data.len} bytes")
}
```
