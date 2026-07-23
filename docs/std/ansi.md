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

### `clearToEnd`

```milo
fn clearToEnd(): string
```

Erase from the cursor to the end of the screen — used to clear a shrinking
live region without repainting rows that are already correct.

### `cursorColumn`

```milo
fn cursorColumn(col: i64): string
```

Move to column `col` on the current row (1-based).

### `cursorDown`

```milo
fn cursorDown(n: i64): string
```

_Undocumented._

### `cursorHome`

```milo
fn cursorHome(): string
```

Cursor to home (row 1, col 1).

### `cursorLeft`

```milo
fn cursorLeft(n: i64): string
```

_Undocumented._

### `cursorRight`

```milo
fn cursorRight(n: i64): string
```

_Undocumented._

### `cursorTo`

```milo
fn cursorTo(row: i64, col: i64): string
```

Move the cursor to a 1-based (row, col).

### `cursorUp`

```milo
fn cursorUp(n: i64): string
```

Relative cursor motion. A frame renderer moving between nearby cells emits
far fewer bytes with these than by re-addressing absolutely via cursorTo.

### `disableBracketedPaste`

```milo
fn disableBracketedPaste(): string
```

_Undocumented._

### `enableBracketedPaste`

```milo
fn enableBracketedPaste(): string
```

Bracketed paste: with this on, pasted text arrives wrapped in
ESC[200~ / ESC[201~ so it is never mistaken for typed key chords.

### `enterAltScreen`

```milo
fn enterAltScreen(): string
```

Alternate screen buffer: a full-screen app switches to it on start and back
on exit, so the user's scrollback and prompt are restored untouched rather
than overwritten by the app's output.

### `exitAltScreen`

```milo
fn exitAltScreen(): string
```

_Undocumented._

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

### `restoreCursor`

```milo
fn restoreCursor(): string
```

_Undocumented._

### `saveCursor`

```milo
fn saveCursor(): string
```

Cursor position save/restore, for writing outside the live region (a log
line, a status write) and returning without recomputing coordinates.

### `showCursor`

```milo
fn showCursor(): string
```

_Undocumented._
