# std/term.linux

## std/term.linux

### `enableRawMode`

```milo
fn enableRawMode(): TermState
```

_Undocumented._

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
