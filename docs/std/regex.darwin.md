# std/regex.darwin

## std/regex.darwin

### `Regex.compile`

```milo
fn Regex.compile(pattern: string): Result<Regex>
```

Compile a POSIX extended regular expression.

### `Regex.compileFlags`

```milo
fn Regex.compileFlags(pattern: string, flags: i32): Result<Regex>
```

Compile with explicit POSIX cflags: REG_EXTENDED=1, REG_ICASE=2.

### `Regex.find`

```milo
fn Regex.find(self: &Regex, input: &string): Option<RegexMatch>
```

The first match, or None. `start` and `end` are byte offsets into `input`.

### `Regex.findAll`

```milo
fn Regex.findAll(self: &Regex, input: &string): Vec<RegexMatch>
```

Every non-overlapping match, left to right.

### `Regex.isMatch`

```milo
fn Regex.isMatch(self: &Regex, input: &string): bool
```

Whether the pattern matches anywhere in `input`.
