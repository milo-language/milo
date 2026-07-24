# std/term.linux

## std/term.linux

### `enableRawMode`

```milo
pub fn enableRawMode(): TermState
```

_Undocumented._

### `enableRawModeBlocking`

```milo
pub fn enableRawModeBlocking(): TermState
```

Like enableRawMode but VMIN=1: read(0,…) blocks until one byte arrives instead
of returning immediately. For an input-driven loop (a line editor) this waits on
the keyboard without busy-spinning, which VMIN=0 would force.

### `readKey`

```milo
pub fn readKey(): i32
```

read a keypress without blocking; returns KEY_* constant

### `restoreTerminal`

```milo
pub fn restoreTerminal(state: &TermState): void
```

_Undocumented._

### `terminalSize`

```milo
pub fn terminalSize(): TermSize
```

_Undocumented._
