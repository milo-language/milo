# std/regex.linux

## std/regex.linux

### `readMatchI32`

```milo
fn readMatchI32(buf: &[u8; 80], off: i64): i32
```

read i32 from byte buffer at given offset

### `regexFind`

```milo
pub fn regexFind(re: &Regex, input: &string): Option<RegexMatch>
```

Find the first match in a string. Returns None if no match.

### `regexFindAll`

```milo
pub fn regexFindAll(re: &Regex, input: &string): Vec<RegexMatch>
```

Find all non-overlapping matches in a string.

### `regexMatch`

```milo
pub fn regexMatch(re: &Regex, input: &string): bool
```

Test if a string matches the pattern.

### `regexNew`

```milo
pub fn regexNew(pattern: string): Option<Regex>
```

Compile a POSIX extended regular expression. Returns None on invalid pattern.

### `regexNewFlags`

```milo
pub fn regexNewFlags(pattern: string, cflags: i32): Option<Regex>
```

Compile a POSIX extended regex with explicit cflags. REG_EXTENDED=1, REG_ICASE=2.
