# std/fmt

String formatting and padding utilities.

```milo
from "std/fmt" import { fmt1, fmt2, join, padLeft, zeroPad }
```

## Functions

### fmt1

```milo
fn fmt1(template: &string, a: &string): string
```

Replaces the first `{}` in `template` with `a`.

### fmt2

```milo
fn fmt2(template: &string, a: &string, b: &string): string
```

Replaces the first two `{}` placeholders with `a` and `b`.

```milo
let msg = fmt2(&"Hello, {}! You have {} messages.", &name, &intToString(count))
// "Hello, Alice! You have 3 messages."
```

### fmt3

```milo
fn fmt3(template: &string, a: &string, b: &string, c: &string): string
```

Replaces the first three `{}` placeholders.

### fmt4

```milo
fn fmt4(template: &string, a: &string, b: &string, c: &string, d: &string): string
```

Replaces the first four `{}` placeholders.

### padLeft

```milo
fn padLeft(s: &string, width: i64, fill: u8): string
```

Pads `s` on the left with `fill` until it reaches `width`.

### padRight

```milo
fn padRight(s: &string, width: i64, fill: u8): string
```

Pads `s` on the right with `fill` until it reaches `width`.

### zeroPad

```milo
fn zeroPad(n: i64, width: i64): string
```

Formats integer `n` as a string, zero-padded to `width` digits.

```milo
let s = zeroPad(42, 5)
// "00042"
```

### join

```milo
fn join(parts: &Vec<string>, separator: &string): string
```

Joins all strings in `parts` with `separator` between them.

```milo
let csv = join(&names, &", ")
```
