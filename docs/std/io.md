# std/io

## std/io

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `File.openAppend`

```milo
fn File.openAppend(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.openRead`

```milo
fn File.openRead(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.openWrite`

```milo
fn File.openWrite(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.putChar`

```milo
fn File.putChar(ch: u8): void
```

_Undocumented._

### `File.readAll`

```milo
fn File.readAll(self: &File): Result<string, IoError>
```

_Undocumented._

### `File.readFile`

```milo
fn File.readFile(path: &string): Result<string, IoError>
```

Read an entire file into a string. Returns an IoError (NotFound, permission,
etc.) rather than throwing; propagate with `?` or match on it.

### `File.readLine`

```milo
fn File.readLine(): Option<string>
```

_Undocumented._

### `File.readLines`

```milo
fn File.readLines(path: &string): Result<Vec<string>, IoError>
```

_Undocumented._

### `File.readStdin`

```milo
fn File.readStdin(): string
```

_Undocumented._

### `File.size`

```milo
fn File.size(self: &File): i64
```

_Undocumented._

### `File.splitLines`

```milo
fn File.splitLines(content: &string): Vec<string>
```

_Undocumented._

### `File.writeAll`

```milo
fn File.writeAll(self: &File, data: &string): Result<i64, IoError>
```

_Undocumented._

### `File.writeStr`

```milo
fn File.writeStr(s: &string): void
```

_Undocumented._

### `writeStdout`

```milo
fn writeStdout(s: &string): void
```

_Undocumented._
