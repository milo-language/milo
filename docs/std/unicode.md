# std/unicode

## std/unicode

### `codepointCount`

```milo
fn codepointCount(s: &string): i64
```

Number of Unicode codepoints in a string (not bytes).

### `codepoints`

```milo
fn codepoints(s: &string): Vec<i32>
```

Decode UTF-8 string into Unicode codepoints.

### `isAlpha`

```milo
fn isAlpha(ch: u8): bool
```

_Undocumented._

### `isAlphanumeric`

```milo
fn isAlphanumeric(ch: u8): bool
```

_Undocumented._

### `isAlphaStr`

```milo
fn isAlphaStr(s: &string): bool
```

Check if an entire string is alphabetic.

### `isAscii`

```milo
fn isAscii(ch: u8): bool
```

Classify ASCII bytes.

### `isControl`

```milo
fn isControl(ch: u8): bool
```

_Undocumented._

### `isDigit`

```milo
fn isDigit(ch: u8): bool
```

_Undocumented._

### `isHexDigit`

```milo
fn isHexDigit(ch: u8): bool
```

_Undocumented._

### `isLower`

```milo
fn isLower(ch: u8): bool
```

_Undocumented._

### `isNumeric`

```milo
fn isNumeric(s: &string): bool
```

Check if an entire string is numeric (all digits).

### `isPrintable`

```milo
fn isPrintable(ch: u8): bool
```

_Undocumented._

### `isPunctuation`

```milo
fn isPunctuation(ch: u8): bool
```

_Undocumented._

### `isUpper`

```milo
fn isUpper(ch: u8): bool
```

_Undocumented._

### `isWhitespace`

```milo
fn isWhitespace(ch: u8): bool
```

_Undocumented._

### `toLowerChar`

```milo
fn toLowerChar(ch: u8): u8
```

Case conversion for ASCII bytes.

### `toUpperChar`

```milo
fn toUpperChar(ch: u8): u8
```

_Undocumented._
