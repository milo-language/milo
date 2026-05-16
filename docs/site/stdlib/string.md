# std/string

String manipulation utilities for searching, transforming, and inspecting strings.

```milo
from "std/string" import { strContains, strSplit, strReplace, strTrim, strToLower }
```

## Functions

### strContains

```milo
fn strContains(haystack: &string, needle: &string): bool
```

Returns true if `haystack` contains `needle`.

### strIndexOf

```milo
fn strIndexOf(haystack: &string, needle: &string): i64
```

Returns the index of the first occurrence of `needle`, or -1 if not found.

### strIndexOfFrom

```milo
fn strIndexOfFrom(haystack: &string, needle: &string, start: i64): i64
```

Like `strIndexOf`, but begins searching from byte offset `start`.

### strStartsWith

```milo
fn strStartsWith(s: &string, prefix: &string): bool
```

Returns true if `s` starts with `prefix`.

### strEndsWith

```milo
fn strEndsWith(s: &string, suffix: &string): bool
```

Returns true if `s` ends with `suffix`.

### strToLower

```milo
fn strToLower(s: &string): string
```

Returns a new string with all ASCII characters lowercased.

### strToUpper

```milo
fn strToUpper(s: &string): string
```

Returns a new string with all ASCII characters uppercased.

### strTrim

```milo
fn strTrim(s: &string): string
```

Returns a new string with leading and trailing whitespace removed.

### strTrimStart

```milo
fn strTrimStart(s: &string): string
```

Returns a new string with leading whitespace removed.

### strTrimEnd

```milo
fn strTrimEnd(s: &string): string
```

Returns a new string with trailing whitespace removed.

### strSplit

```milo
fn strSplit(s: &string, delimiter: &string): Vec<string>
```

Splits `s` by `delimiter` and returns the parts.

```milo
let parts = strSplit(&"a,b,c", &",")
// parts == ["a", "b", "c"]
```

### strRepeat

```milo
fn strRepeat(s: &string, count: i64): string
```

Returns `s` repeated `count` times.

### strReplace

```milo
fn strReplace(s: &string, old: &string, new: &string): string
```

Replaces all occurrences of `old` with `new` in `s`.

### charIsWhitespace

```milo
fn charIsWhitespace(c: u8): bool
```

Returns true if `c` is an ASCII whitespace character.

### charIsDigit

```milo
fn charIsDigit(c: u8): bool
```

Returns true if `c` is an ASCII digit (0-9).

### charIsAlpha

```milo
fn charIsAlpha(c: u8): bool
```

Returns true if `c` is an ASCII letter (a-z, A-Z).

### charIsAlphanumeric

```milo
fn charIsAlphanumeric(c: u8): bool
```

Returns true if `c` is an ASCII letter or digit.

### trim

```milo
fn trim(s: &string): string
```

Alias for `strTrim`. Returns a new string with leading and trailing whitespace removed.
