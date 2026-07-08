# std/string

## std/string

### `charIsAlpha`

```milo
fn charIsAlpha(ch: u8): bool
```

_Undocumented._

### `charIsAlphanumeric`

```milo
fn charIsAlphanumeric(ch: u8): bool
```

_Undocumented._

### `charIsDigit`

```milo
fn charIsDigit(ch: u8): bool
```

_Undocumented._

### `charIsWhitespace`

```milo
fn charIsWhitespace(ch: u8): bool
```

_Undocumented._

### `strCharAt`

```milo
fn strCharAt(s: &string, idx: i64): string
```

The single byte at `idx` as a length-1 string. Requires 0 <= idx < s.len
(byte index, not codepoint).

### `strContains`

```milo
fn strContains(haystack: &string, needle: &string): bool
```

True if `needle` occurs anywhere in `haystack` (empty needle → true).

### `strEndsWith`

```milo
fn strEndsWith(s: &string, suffix: &string): bool
```

True if `s` ends with `suffix`.

### `strIndexOf`

```milo
fn strIndexOf(haystack: &string, needle: &string): i64
```

Byte index of the first occurrence of `needle`, or -1 if not found.

### `strIndexOfFrom`

```milo
fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64
```

Byte index of the first occurrence of `needle` at or after `pos`, or -1.

### `strIsEmpty`

```milo
fn strIsEmpty(s: &string): bool
```

True if `s` has zero length.

### `strLastIndexOf`

```milo
fn strLastIndexOf(haystack: &string, needle: &string): i64
```

Byte index of the last occurrence of `needle`, or -1 if not found.

### `strPadEnd`

```milo
fn strPadEnd(s: &string, targetLen: i64, padStr: &string): string
```

Right-pad `s` with repeated `padStr` until it reaches `targetLen` bytes
(returned unchanged if already at least that long).

### `strPadStart`

```milo
fn strPadStart(s: &string, targetLen: i64, padStr: &string): string
```

Left-pad `s` with repeated `padStr` until it reaches `targetLen` bytes
(returned unchanged if already at least that long).

### `strParseInt`

```milo
fn strParseInt(s: &string): i64
```

Parse a leading (optionally '-' signed) run of ASCII digits to i64. Stops at
the first non-digit; returns 0 for empty/non-numeric input (no error — use a
stricter parser if you must distinguish "0" from invalid).

### `strRepeat`

```milo
fn strRepeat(s: &string, n: i64): string
```

`s` concatenated `n` times (n <= 0 → empty string).

### `strReplace`

```milo
fn strReplace(s: &string, old: &string, newVal: &string): string
```

Copy of `s` with every occurrence of `old` replaced by `newVal`.

### `strReplaceFirst`

```milo
fn strReplaceFirst(s: &string, old: &string, newVal: &string): string
```

Copy of `s` with only the first occurrence of `old` replaced by `newVal`.

### `strReverse`

```milo
fn strReverse(s: &string): string
```

UTF-8 aware: scans backward past continuation bytes to reverse whole codepoints

### `strSplit`

```milo
fn strSplit(s: &string, sep: &string): Vec<string>
```

Split `s` on every occurrence of `sep` into a Vec of pieces (adjacent
separators yield empty pieces; keeps them, unlike strSplitWhitespace).

### `strSplitWhitespace`

```milo
fn strSplitWhitespace(s: &string): Vec<string>
```

Split on runs of whitespace into non-empty tokens (no empty pieces, unlike
strSplit). Leading/trailing whitespace is ignored.

### `strSplitWords`

```milo
fn strSplitWords(s: &string): Vec<string>
```

Extract maximal runs of ASCII letters as lowercased words, dropping all
other characters (digits, punctuation, whitespace). For tokenizing prose.

### `strStartsWith`

```milo
fn strStartsWith(s: &string, prefix: &string): bool
```

True if `s` begins with `prefix`.

### `strToLower`

```milo
fn strToLower(s: &string): string
```

ASCII-lowercased copy (A–Z → a–z; other bytes unchanged).

### `strToUpper`

```milo
fn strToUpper(s: &string): string
```

ASCII-uppercased copy (a–z → A–Z; other bytes unchanged).

### `strTrim`

```milo
fn strTrim(s: &string): string
```

Copy with leading and trailing ASCII whitespace removed.

### `strTrimEnd`

```milo
fn strTrimEnd(s: &string): string
```

Copy with trailing ASCII whitespace removed.

### `strTrimStart`

```milo
fn strTrimStart(s: &string): string
```

Copy with leading ASCII whitespace removed.

### `trim`

```milo
fn trim(s: &string): string
```

_Undocumented._

### `vecJoin`

```milo
fn vecJoin(parts: &Vec<string>, sep: &string): string
```

_Undocumented._
