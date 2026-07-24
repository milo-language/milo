# std/string

## std/string

### `charIsAlpha`

```milo
pub fn charIsAlpha(ch: u8): bool
```

Check if a byte is an ASCII letter.

### `charIsAlphanumeric`

```milo
pub fn charIsAlphanumeric(ch: u8): bool
```

Check if a byte is an ASCII letter or digit.

### `charIsDigit`

```milo
pub fn charIsDigit(ch: u8): bool
```

Check if a byte is an ASCII digit.

### `charIsWhitespace`

```milo
pub fn charIsWhitespace(ch: u8): bool
```

Check if a byte is ASCII whitespace.

### `strCharAt`

```milo
pub fn strCharAt(s: &string, idx: i64): string
```

The single byte at `idx` as a length-1 string. Requires 0 <= idx < s.len
(byte index, not codepoint).

### `strContains`

```milo
pub fn strContains(haystack: &string, needle: &string): bool
```

True if `needle` occurs anywhere in `haystack` (empty needle → true).

### `strEndsWith`

```milo
pub fn strEndsWith(s: &string, suffix: &string): bool
```

True if `s` ends with `suffix`.

### `strIndexOf`

```milo
pub fn strIndexOf(haystack: &string, needle: &string): i64
```

Byte index of the first occurrence of `needle`, or -1 if not found.

### `strIndexOfFrom`

```milo
pub fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64
```

Byte index of the first occurrence of `needle` at or after `pos`, or -1.

### `strIsEmpty`

```milo
pub fn strIsEmpty(s: &string): bool
```

True if `s` has zero length.

### `strLastIndexOf`

```milo
pub fn strLastIndexOf(haystack: &string, needle: &string): i64
```

Byte index of the last occurrence of `needle`, or -1 if not found.

### `strPadEnd`

```milo
pub fn strPadEnd(s: &string, targetLen: i64, padStr: &string): string
```

Right-pad `s` with repeated `padStr` until it reaches `targetLen` bytes
(returned unchanged if already at least that long).

### `strPadStart`

```milo
pub fn strPadStart(s: &string, targetLen: i64, padStr: &string): string
```

Left-pad `s` with repeated `padStr` until it reaches `targetLen` bytes
(returned unchanged if already at least that long).

### `strParseInt`

```milo
pub fn strParseInt(s: &string): i64
```

Parse a leading (optionally '-' signed) run of ASCII digits to i64. Stops at
the first non-digit; returns 0 for empty/non-numeric input (no error — use a
stricter parser if you must distinguish "0" from invalid).

### `strRepeat`

```milo
pub fn strRepeat(s: &string, n: i64): string
```

`s` concatenated `n` times (n <= 0 → empty string).

### `strReplace`

```milo
pub fn strReplace(s: &string, old: &string, newVal: &string): string
```

Copy of `s` with every occurrence of `old` replaced by `newVal`.

### `strReplaceFirst`

```milo
pub fn strReplaceFirst(s: &string, old: &string, newVal: &string): string
```

Copy of `s` with only the first occurrence of `old` replaced by `newVal`.

### `strReverse`

```milo
pub fn strReverse(s: &string): string
```

UTF-8 aware: scans backward past continuation bytes to reverse whole codepoints

### `strSplit`

```milo
pub fn strSplit(s: &string, sep: &string): Vec<string>
```

Split `s` on every occurrence of `sep` into a Vec of pieces (adjacent
separators yield empty pieces; keeps them, unlike strSplitWhitespace).

### `strSplitWhitespace`

```milo
pub fn strSplitWhitespace(s: &string): Vec<string>
```

Split on runs of whitespace into non-empty tokens (no empty pieces, unlike
strSplit). Leading/trailing whitespace is ignored.

### `strSplitWords`

```milo
pub fn strSplitWords(s: &string): Vec<string>
```

Extract maximal runs of ASCII letters as lowercased words, dropping all
other characters (digits, punctuation, whitespace). For tokenizing prose.

### `strStartsWith`

```milo
pub fn strStartsWith(s: &string, prefix: &string): bool
```

True if `s` begins with `prefix`.

### `strToLower`

```milo
pub fn strToLower(s: &string): string
```

ASCII-lowercased copy (A–Z → a–z; other bytes unchanged).

### `strToUpper`

```milo
pub fn strToUpper(s: &string): string
```

ASCII-uppercased copy (a–z → A–Z; other bytes unchanged).

### `strTrim`

```milo
pub fn strTrim(s: &string): string
```

Copy with leading and trailing ASCII whitespace removed.

### `strTrimEnd`

```milo
pub fn strTrimEnd(s: &string): string
```

Copy with trailing ASCII whitespace removed.

### `strTrimStart`

```milo
pub fn strTrimStart(s: &string): string
```

Copy with leading ASCII whitespace removed.

### `trim`

```milo
pub fn trim(s: &string): string
```

Remove leading and trailing whitespace (spaces, tabs, newlines, carriage returns).

### `vecJoin`

```milo
pub fn vecJoin(parts: &Vec<string>, sep: &string): string
```

_Undocumented._
