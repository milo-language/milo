# std/unicode

Character classification and case conversion for ASCII/UTF-8 bytes.

```milo
from "std/unicode" import { isAlpha, isDigit, isWhitespace, toLowerChar, toUpperChar, isNumeric }
```

## Functions

### isAscii

```milo
fn isAscii(c: u8): bool
```

Returns true if `c` is in the ASCII range (0-127).

### isDigit

```milo
fn isDigit(c: u8): bool
```

Returns true if `c` is an ASCII digit (0-9).

### isLower

```milo
fn isLower(c: u8): bool
```

Returns true if `c` is a lowercase ASCII letter.

### isUpper

```milo
fn isUpper(c: u8): bool
```

Returns true if `c` is an uppercase ASCII letter.

### isAlpha

```milo
fn isAlpha(c: u8): bool
```

Returns true if `c` is an ASCII letter (a-z, A-Z).

### isAlphanumeric

```milo
fn isAlphanumeric(c: u8): bool
```

Returns true if `c` is an ASCII letter or digit.

### isWhitespace

```milo
fn isWhitespace(c: u8): bool
```

Returns true if `c` is an ASCII whitespace character (space, tab, newline, etc.).

### isPunctuation

```milo
fn isPunctuation(c: u8): bool
```

Returns true if `c` is an ASCII punctuation character.

### isHexDigit

```milo
fn isHexDigit(c: u8): bool
```

Returns true if `c` is a hexadecimal digit (0-9, a-f, A-F).

### isPrintable

```milo
fn isPrintable(c: u8): bool
```

Returns true if `c` is a printable ASCII character (0x20-0x7E).

### isControl

```milo
fn isControl(c: u8): bool
```

Returns true if `c` is an ASCII control character (0x00-0x1F, 0x7F).

### toLowerChar

```milo
fn toLowerChar(c: u8): u8
```

Converts an uppercase ASCII letter to lowercase. Non-letters pass through unchanged.

### toUpperChar

```milo
fn toUpperChar(c: u8): u8
```

Converts a lowercase ASCII letter to uppercase. Non-letters pass through unchanged.

### isNumeric

```milo
fn isNumeric(s: &string): bool
```

Returns true if every byte in the string is an ASCII digit.

### isAlphaStr

```milo
fn isAlphaStr(s: &string): bool
```

Returns true if every byte in the string is an ASCII letter.
