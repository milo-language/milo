# std/io

File I/O, stdin/stdout, and line reading.

```milo
from "std/io" import { readFile, writeStdout, openRead, readAll, splitLines }
```

## Types

### File

```milo
struct File {
    fd: i32,
}
```

An owned file descriptor. Closed automatically when dropped.

### IoError

```milo
enum IoError {
    NotFound(string),
    PermissionDenied(string),
    IsDirectory(string),
    AlreadyExists(string),
    Other(string),
}
```

## Functions

### writeStdout

```milo
fn writeStdout(s: &string)
```

Write a string to stdout.

### writeStr

```milo
fn writeStr(s: &string)
```

Write a string to stdout (alias).

### putChar

```milo
fn putChar(c: u8)
```

Write a single byte to stdout.

### readStdin

```milo
fn readStdin(): string
```

Read all of stdin to a string.

### readLine

```milo
fn readLine(): Option<string>
```

Read a single line from stdin. Returns `None` at EOF.

### openRead

```milo
fn openRead(path: &string): Result<File, IoError>
```

Open a file for reading.

### openWrite

```milo
fn openWrite(path: &string): Result<File, IoError>
```

Open a file for writing (creates or truncates).

### openAppend

```milo
fn openAppend(path: &string): Result<File, IoError>
```

Open a file for appending (creates if missing).

### fileSize

```milo
fn fileSize(f: &File): i64
```

Get the size of an open file in bytes.

### readAll

```milo
fn readAll(f: &File): Result<string, IoError>
```

Read the entire contents of an open file.

### writeAll

```milo
fn writeAll(f: &File, data: &string): Result<i64, IoError>
```

Write a string to an open file. Returns bytes written.

### readFile

```milo
fn readFile(path: &string): Result<string, IoError>
```

Read an entire file by path. Convenience wrapper around `openRead` + `readAll`.

```milo
let contents = readFile("config.txt")!
writeStdout(&contents)
```

### readLines

```milo
fn readLines(path: &string): Result<Vec<string>, IoError>
```

Read a file and split into lines.

### splitLines

```milo
fn splitLines(s: &string): Vec<string>
```

Split a string on newlines.

```milo
let lines = splitLines(&"one\ntwo\nthree")
// lines[0] == "one", lines[1] == "two", lines[2] == "three"
```
