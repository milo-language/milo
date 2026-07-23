# std/term.linux

## std/term.linux

### `enableRawMode`

```milo
fn enableRawMode(): TermState
```

_Undocumented._

### `enableRawModeBlocking`

```milo
fn enableRawModeBlocking(): TermState
```

Like enableRawMode but VMIN=1: read(0,…) blocks until one byte arrives instead
of returning immediately. For an input-driven loop (a line editor) this waits on
the keyboard without busy-spinning, which VMIN=0 would force.

### `readKey`

```milo
fn readKey(): i32
```

read a keypress without blocking; returns KEY_* constant

### `restoreTerminal`

```milo
fn restoreTerminal(state: &TermState): void
```

_Undocumented._

### `terminalSize`

```milo
fn terminalSize(): TermSize
```

_Undocumented._
