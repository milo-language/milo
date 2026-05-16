# std/strconv

String-to-number and number-to-string conversions.

```milo
from "std/strconv" import { parseInt, parseFloat, formatFloat, i64ToHex }
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
