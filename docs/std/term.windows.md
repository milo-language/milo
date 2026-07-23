# std/term.windows

## std/term.windows

### `enableRawMode`

```milo
fn enableRawMode(): TermState
```

_Undocumented._

### `enableRawModeBlocking`

```milo
fn enableRawModeBlocking(): TermState
```

The Windows console has no VMIN/VTIME: ReadFile on a console handle in raw mode
already blocks until at least one record is available, which is the blocking
behaviour this variant asks for. The two entry points therefore agree here.

### `getConsoleModeOf`

```milo
fn getConsoleModeOf(handle: i64): u32
```

_Undocumented._

### `rawModeFrom`

```milo
fn rawModeFrom(saved: u32): u32
```

ENABLE_PROCESSED_INPUT 0x1 | ENABLE_LINE_INPUT 0x2 | ENABLE_ECHO_INPUT 0x4 cleared,
ENABLE_VIRTUAL_TERMINAL_INPUT 0x200 set.

### `readKey`

```milo
fn readKey(): i32
```

read a keypress without blocking; returns KEY_* constant.
Identical decoding to the POSIX arms because ENABLE_VIRTUAL_TERMINAL_INPUT makes the
console emit the same ANSI sequences.

### `restoreTerminal`

```milo
fn restoreTerminal(state: &TermState): void
```

_Undocumented._

### `stdinHandle`

```milo
fn stdinHandle(): i64
```

_Undocumented._

### `terminalSize`

```milo
fn terminalSize(): TermSize
```

Queried on stdout, matching the POSIX arms, so it still works with piped input.
Falls back to 80x24 when stdout is not a console (redirected, or under a harness).
