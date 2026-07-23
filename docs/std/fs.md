# std/fs

## std/fs

### `appendFile`

```milo
fn appendFile(path: &string, data: &string): Result<i64, IoError>
```

Append a string to a file, creating it if absent (writes go to the end).

### `changeDir`

```milo
fn changeDir(path: &string): Result<bool, IoError>
```

_Undocumented._

### `currentDir`

```milo
fn currentDir(): Result<string, IoError>
```

_Undocumented._

### `dataSyncFd`

```milo
fn dataSyncFd(fd: i32): Result<bool, IoError>
```

_Undocumented._

### `devNull`

```milo
fn devNull(): string
```

Path of the OS bit-bucket device — /dev/null on POSIX, NUL on Windows. Use this
instead of hard-coding "/dev/null", which does not exist on Windows.

### `fileInfo`

```milo
fn fileInfo(path: &string): FileInfo
```

Get file metadata. Returns FileInfo with exists=false if path doesn't exist.

### `fileSizePath`

```milo
fn fileSizePath(path: &string): i64
```

Get file size in bytes. Returns -1 if file doesn't exist.

### `hardLink`

```milo
fn hardLink(existing: &string, newPath: &string): Result<bool, IoError>
```

_Undocumented._

### `isDir`

```milo
fn isDir(path: &string): bool
```

Check if a path is a directory.

### `isFile`

```milo
fn isFile(path: &string): bool
```

Check if a path is a regular file. Defined as "exists and is not a directory"
so it, like isDir, avoids the struct-stat S_IFREG bit whose offset is
arch-specific (see isDir). This treats a socket/fifo/device as a file too, but
those do not appear in the file trees these helpers walk; the file-vs-directory
distinction the callers actually need is exact.

### `isSymlink`

```milo
fn isSymlink(path: &string): bool
```

_Undocumented._

### `lstatInfo`

```milo
fn lstatInfo(path: &string): FileInfo
```

_Undocumented._

### `makeDir`

```milo
fn makeDir(path: &string, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `makeTempDir`

```milo
fn makeTempDir(prefix: &string): Result<string, IoError>
```

_Undocumented._

### `pathExists`

```milo
fn pathExists(path: &string): bool
```

Check if a path exists.

### `readDir`

```milo
fn readDir(path: &string): Vec<DirEntry>
```

List directory contents. Returns empty vec on error.

### `readLink`

```milo
fn readLink(path: &string): Result<string, IoError>
```

_Undocumented._

### `realPath`

```milo
fn realPath(path: &string): Result<string, IoError>
```

_Undocumented._

### `removeDir`

```milo
fn removeDir(path: &string): Result<bool, IoError>
```

_Undocumented._

### `removeFile`

```milo
fn removeFile(path: &string): Result<bool, IoError>
```

_Undocumented._

### `renameFile`

```milo
fn renameFile(oldPath: &string, newPath: &string): Result<bool, IoError>
```

_Undocumented._

### `setFdMode`

```milo
fn setFdMode(fd: i32, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `setFdOwner`

```milo
fn setFdOwner(fd: i32, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `setLinkOwner`

```milo
fn setLinkOwner(path: &string, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `setMode`

```milo
fn setMode(path: &string, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `setOwner`

```milo
fn setOwner(path: &string, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `softLink`

```milo
fn softLink(target: &string, path: &string): Result<bool, IoError>
```

_Undocumented._

### `syncFd`

```milo
fn syncFd(fd: i32): Result<bool, IoError>
```

_Undocumented._

### `truncateFd`

```milo
fn truncateFd(fd: i32, length: i64): Result<bool, IoError>
```

_Undocumented._

### `truncateFile`

```milo
fn truncateFile(path: &string, length: i64): Result<bool, IoError>
```

_Undocumented._

### `writeFile`

```milo
fn writeFile(path: &string, data: &string): Result<i64, IoError>
```

Write a string to a file, creating or truncating it.
