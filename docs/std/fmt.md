# std/fmt

## std/fmt

### `fmt1`

```milo
pub fn fmt1(template: &string, a: &string): string
```

Replace the first {} with val.

### `fmt2`

```milo
pub fn fmt2(template: &string, a: &string, b: &string): string
```

Replace the first two {} with a and b.

### `fmt3`

```milo
pub fn fmt3(template: &string, a: &string, b: &string, c: &string): string
```

Replace the first three {} with a, b, and c.

### `fmt4`

```milo
pub fn fmt4(template: &string, a: &string, b: &string, c: &string, d: &string): string
```

Replace the first four {} with a, b, c, and d.

### `join`

```milo
pub fn join(parts: &Vec<string>, sep: &string): string
```

Join a Vec<string> with a separator.

### `padLeft`

```milo
pub fn padLeft(s: &string, width: i64, ch: u8): string
```

Left-pad a string to a minimum width.

### `padRight`

```milo
pub fn padRight(s: &string, width: i64, ch: u8): string
```

Right-pad a string to a minimum width.

### `zeroPad`

```milo
pub fn zeroPad(n: i64, width: i64): string
```

Zero-pad an integer to a minimum width.
