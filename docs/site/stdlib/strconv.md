# std/strconv

String-to-number and number-to-string conversions.

```milo
from "std/strconv" import { parseInt, parseFloat, formatFloat, i64ToHex, quoteString }
```

## Functions

### parseInt

```milo
fn parseInt(s: string): Option<i64>
```

Parses a decimal integer string. Returns `None` on invalid input.

### parseIntRadix

```milo
fn parseIntRadix(s: string, radix: i32): Option<i64>
```

Parses an integer in the given radix (2-36).

### parseFloat

```milo
fn parseFloat(s: string): Option<f64>
```

Parses a floating-point string. Returns `None` on invalid input.

### parseBool

```milo
fn parseBool(s: &string): Option<bool>
```

Accepted, ASCII-case-insensitively and with no surrounding whitespace: `true`,
`t`, `1` for true and `false`, `f`, `0` for false. Nothing else — `yes`, `on`,
`""` and `" true"` are all `None`. Trim before calling if your input can carry
whitespace; a parser that silently trims cannot tell you that the field it read
had a stray space in a config file.

### quoteString

```milo
fn quoteString(s: &string): string
```

A double-quoted string literal whose escapes are exactly Milo's: `\\`, `\"`,
`\n`, `\r`, `\t`, `\0`, and `\xHH` for every other byte below `0x20` or equal to
`0x7F`. Bytes at or above `0x80` are copied through, so valid UTF-8 stays
readable instead of becoming a wall of hex.

The result always parses back to `s` through `unquoteString`. It is a *literal*,
not an escaping function for a document format — HTML, shell and SQL each need
their own escaper.

```milo
print(quoteString("tab\there"))   // "tab\there"
```

### unquoteString

```milo
fn unquoteString(s: &string): Option<string>
```

The inverse of `quoteString`, or `None` if `s` is not a double-quoted literal.

Strict on purpose: `s` must start and end with `"`, contain no unescaped `"` and
no raw byte below `0x20`, and use only the escapes `quoteString` emits. An
unknown escape such as `\q` is `None`, not a literal `q` — the compiler's own
lexer is lenient there, but a decoder over untrusted text should not be, because
the lenient reading silently deletes a backslash the author meant to keep.

### i64ToHex

```milo
fn i64ToHex(n: i64): string
```

Formats an integer as a lowercase hexadecimal string (no `0x` prefix).

### i64ToOct

```milo
fn i64ToOct(n: i64): string
```

Formats an integer as an octal string.

### i64ToBin

```milo
fn i64ToBin(n: i64): string
```

Formats an integer as a binary string.

### formatFloat

```milo
fn formatFloat(n: f64, precision: i32): string
```

Formats a float with the given number of decimal places.

```milo
let s = formatFloat(3.14159, 2)
// "3.14"
```
