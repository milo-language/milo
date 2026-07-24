# std/fs

## std/fs

### `appendFile`

```milo
pub fn appendFile(path: &string, data: &string): Result<i64, IoError>
```

Append a string to a file, creating it if absent (writes go to the end).

### `changeDir`

```milo
pub fn changeDir(path: &string): Result<bool, IoError>
```

_Undocumented._

### `currentDir`

```milo
pub fn currentDir(): Result<string, IoError>
```

_Undocumented._

### `dataSyncFd`

```milo
pub fn dataSyncFd(fd: i32): Result<bool, IoError>
```

_Undocumented._

### `devNull`

```milo
pub fn devNull(): string
```

Path of the OS bit-bucket device — /dev/null on POSIX, NUL on Windows. Use this
instead of hard-coding "/dev/null", which does not exist on Windows.

### `fileInfo`

```milo
pub fn fileInfo(path: &string): FileInfo
```

Get file metadata. Returns FileInfo with exists=false if path doesn't exist.

### `fileSizePath`

```milo
pub fn fileSizePath(path: &string): i64
```

Get file size in bytes. Returns -1 if file doesn't exist.

### `hardLink`

```milo
pub fn hardLink(existing: &string, newPath: &string): Result<bool, IoError>
```

_Undocumented._

### `isDir`

```milo
pub fn isDir(path: &string): bool
```

Check if a path is a directory.

### `isFile`

```milo
pub fn isFile(path: &string): bool
```

Check if a path is a regular file. Defined as "exists and is not a directory"
so it, like isDir, avoids the struct-stat S_IFREG bit whose offset is
arch-specific (see isDir). This treats a socket/fifo/device as a file too, but
those do not appear in the file trees these helpers walk; the file-vs-directory
distinction the callers actually need is exact.

### `isSymlink`

```milo
pub fn isSymlink(path: &string): bool
```

_Undocumented._

### `lstatInfo`

```milo
pub fn lstatInfo(path: &string): FileInfo
```

_Undocumented._

### `makeDir`

```milo
pub fn makeDir(path: &string, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `makeTempDir`

```milo
pub fn makeTempDir(prefix: &string): Result<string, IoError>
```

_Undocumented._

### `pathExists`

```milo
pub fn pathExists(path: &string): bool
```

Check if a path exists.

### `readDir`

```milo
pub fn readDir(path: &string): Vec<DirEntry>
```

List directory contents. Returns empty vec on error.

### `readLink`

```milo
pub fn readLink(path: &string): Result<string, IoError>
```

_Undocumented._

### `realPath`

```milo
pub fn realPath(path: &string): Result<string, IoError>
```

_Undocumented._

### `removeDir`

```milo
pub fn removeDir(path: &string): Result<bool, IoError>
```

_Undocumented._

### `removeFile`

```milo
pub fn removeFile(path: &string): Result<bool, IoError>
```

_Undocumented._

### `renameFile`

```milo
pub fn renameFile(oldPath: &string, newPath: &string): Result<bool, IoError>
```

_Undocumented._

### `setFdMode`

```milo
pub fn setFdMode(fd: i32, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `setFdOwner`

```milo
pub fn setFdOwner(fd: i32, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `setLinkOwner`

```milo
pub fn setLinkOwner(path: &string, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `setMode`

```milo
pub fn setMode(path: &string, mode: i32): Result<bool, IoError>
```

_Undocumented._

### `setOwner`

```milo
pub fn setOwner(path: &string, uid: u32, gid: u32): Result<bool, IoError>
```

_Undocumented._

### `softLink`

```milo
pub fn softLink(target: &string, path: &string): Result<bool, IoError>
```

_Undocumented._

### `syncFd`

```milo
pub fn syncFd(fd: i32): Result<bool, IoError>
```

_Undocumented._

### `truncateFd`

```milo
pub fn truncateFd(fd: i32, length: i64): Result<bool, IoError>
```

_Undocumented._

### `truncateFile`

```milo
pub fn truncateFile(path: &string, length: i64): Result<bool, IoError>
```

_Undocumented._

### `writeFile`

```milo
pub fn writeFile(path: &string, data: &string): Result<i64, IoError>
```

Write a string to a file, creating or truncating it.
