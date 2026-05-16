# std/fs

Filesystem metadata and directory listing.

```milo
from "std/fs" import { fileInfo, readDir, pathExists, writeFile }
```

## Types

### FileInfo

```milo
struct FileInfo {
    size: i64,
    mode: i32,
    exists: bool,
}
```

### DirEntry

```milo
struct DirEntry {
    name: string,
    isDir: bool,
    isFile: bool,
}
```

## Functions

### fileInfo

```milo
fn fileInfo(path: &string): FileInfo
```

Get metadata for a path. If the path doesn't exist, `exists` is `false`.

### pathExists

```milo
fn pathExists(path: &string): bool
```

Check whether a path exists.

### isDir

```milo
fn isDir(path: &string): bool
```

Check whether a path is a directory.

### isFile

```milo
fn isFile(path: &string): bool
```

Check whether a path is a regular file.

### fileSizePath

```milo
fn fileSizePath(path: &string): i64
```

Get file size in bytes by path.

### readDir

```milo
fn readDir(path: &string): Vec<DirEntry>
```

List entries in a directory.

```milo
let entries = readDir(".")
for entry in entries {
    if entry.isFile {
        writeStdout(&entry.name)
        writeStr("\n")
    }
}
```

### writeFile

```milo
fn writeFile(path: &string, data: &string): Result<i64, IoError>
```

Write a string to a file (creates or truncates). Returns bytes written.
