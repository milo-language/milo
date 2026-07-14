# std/regex.linux

## std/regex.linux

### `regexFind`

```milo
fn regexFind(re: &Regex, input: &string): Option<RegexMatch>
```

Find the first match in a string. Returns None if no match.

### `regexFindAll`

```milo
fn regexFindAll(re: &Regex, input: &string): Vec<RegexMatch>
```

Find all non-overlapping matches in a string.

### `regexMatch`

```milo
fn regexMatch(re: &Regex, input: &string): bool
```

Test if a string matches the pattern.

### `regexNew`

```milo
fn regexNew(pattern: string): Option<Regex>
```

Compile a POSIX extended regular expression. Returns None on invalid pattern.

### `regexNewFlags`

```milo
fn regexNewFlags(pattern: string, cflags: i32): Option<Regex>
```

Compile a POSIX extended regex with explicit cflags. REG_EXTENDED=1, REG_ICASE=2.
