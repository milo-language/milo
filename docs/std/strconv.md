# std/strconv

## std/strconv

### `formatFloat`

```milo
pub fn formatFloat(n: f64, decimals: i32): string
```

Format `n` with exactly `decimals` digits after the decimal point.

### `i64ToBin`

```milo
pub fn i64ToBin(n: i64): string
```

Binary text for `n`, no prefix.

### `i64ToHex`

```milo
pub fn i64ToHex(n: i64): string
```

Lowercase hexadecimal text for `n`, no "0x" prefix.

### `i64ToOct`

```milo
pub fn i64ToOct(n: i64): string
```

Octal text for `n`, no prefix.

### `parseFloat`

```milo
pub fn parseFloat(s: string): Option<f64>
```

Parse a floating-point number, or None if the string isn't a valid float.

### `parseInt`

```milo
pub fn parseInt(s: string): Option<i64>
```

Parse a base-10 integer strictly: Some(n) only if the whole string is an
optionally-signed run of digits, else None. (Contrast str.strParseInt, which
is lenient and returns 0 on bad input.)

### `parseIntRadix`

```milo
pub fn parseIntRadix(s: string, base: i32): Option<i64>
```

Parse an integer in `base` (2, 8, 10, or 16), or None if invalid.
