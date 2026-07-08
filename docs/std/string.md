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

_Undocumented._

### `strContains`

```milo
fn strContains(haystack: &string, needle: &string): bool
```

_Undocumented._

### `strEndsWith`

```milo
fn strEndsWith(s: &string, suffix: &string): bool
```

_Undocumented._

### `strIndexOf`

```milo
fn strIndexOf(haystack: &string, needle: &string): i64
```

_Undocumented._

### `strIndexOfFrom`

```milo
fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64
```

_Undocumented._

### `strIsEmpty`

```milo
fn strIsEmpty(s: &string): bool
```

_Undocumented._

### `strLastIndexOf`

```milo
fn strLastIndexOf(haystack: &string, needle: &string): i64
```

_Undocumented._

### `strPadEnd`

```milo
fn strPadEnd(s: &string, targetLen: i64, padStr: &string): string
```

_Undocumented._

### `strPadStart`

```milo
fn strPadStart(s: &string, targetLen: i64, padStr: &string): string
```

_Undocumented._

### `strParseInt`

```milo
fn strParseInt(s: &string): i64
```

_Undocumented._

### `strRepeat`

```milo
fn strRepeat(s: &string, n: i64): string
```

_Undocumented._

### `strReplace`

```milo
fn strReplace(s: &string, old: &string, newVal: &string): string
```

_Undocumented._

### `strReplaceFirst`

```milo
fn strReplaceFirst(s: &string, old: &string, newVal: &string): string
```

_Undocumented._

### `strReverse`

```milo
fn strReverse(s: &string): string
```

UTF-8 aware: scans backward past continuation bytes to reverse whole codepoints

### `strSplit`

```milo
fn strSplit(s: &string, sep: &string): Vec<string>
```

_Undocumented._

### `strSplitWhitespace`

```milo
fn strSplitWhitespace(s: &string): Vec<string>
```

_Undocumented._

### `strSplitWords`

```milo
fn strSplitWords(s: &string): Vec<string>
```

_Undocumented._

### `strStartsWith`

```milo
fn strStartsWith(s: &string, prefix: &string): bool
```

_Undocumented._

### `strToLower`

```milo
fn strToLower(s: &string): string
```

_Undocumented._

### `strToUpper`

```milo
fn strToUpper(s: &string): string
```

_Undocumented._

### `strTrim`

```milo
fn strTrim(s: &string): string
```

_Undocumented._

### `strTrimEnd`

```milo
fn strTrimEnd(s: &string): string
```

_Undocumented._

### `strTrimStart`

```milo
fn strTrimStart(s: &string): string
```

_Undocumented._

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
