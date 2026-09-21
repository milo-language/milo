# std/prelude

## std/prelude

### `ErrorContext.message`

```milo
fn ErrorContext.message(self: &ErrorContext): string
```

The note, a colon, and the cause's own message.

### `ErrorMessage.message`

```milo
fn ErrorMessage.message(self: &ErrorMessage): string
```

The string the error was raised with.
