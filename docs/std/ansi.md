# std/ansi

## std/ansi

### `ansiReset`

```milo
fn ansiReset(): string
```

Reset all attributes to the terminal default.

### `bg24`

```milo
fn bg24(r: i64, g: i64, b: i64): string
```

_Undocumented._

### `bg256`

```milo
fn bg256(code: i64): string
```

xterm-256 background SGR.

### `clearLine`

```milo
fn clearLine(): string
```

Erase from the cursor to the end of the line.

### `clearScreen`

```milo
fn clearScreen(): string
```

Erase the entire screen.

### `cursorHome`

```milo
fn cursorHome(): string
```

Cursor to home (row 1, col 1).

### `cursorTo`

```milo
fn cursorTo(row: i64, col: i64): string
```

Move the cursor to a 1-based (row, col).

### `fg24`

```milo
fn fg24(r: i64, g: i64, b: i64): string
```

Truecolor (24-bit) foreground / background — smooth gradients on terminals
that support it (most modern ones). r/g/b are 0–255.

### `fg256`

```milo
fn fg256(code: i64): string
```

xterm-256 foreground select-graphic-rendition for a palette index (0–255).

### `hideCursor`

```milo
fn hideCursor(): string
```

Hide / show the cursor — hide while drawing a full-screen UI, show on exit.

### `pushBg24`

```milo
fn pushBg24(buf: &mut string, r: i64, g: i64, b: i64): void
```

_Undocumented._

### `pushFg24`

```milo
fn pushFg24(buf: &mut string, r: i64, g: i64, b: i64): void
```

Append a 24-bit foreground / background SGR directly into buf (no allocation).

### `showCursor`

```milo
fn showCursor(): string
```

_Undocumented._
