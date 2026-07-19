# std/dl

## std/dl

### `dlLastError`

```milo
fn dlLastError(): string
```

The most recent loader error, or a generic message when the loader has none.
dlerror() also CLEARS the error, so this must be read exactly once per failure.

### `dlOpen`

```milo
fn dlOpen(path: &string): Result<Lib, string>
```

Load a shared library. `path` may be a filename resolved via the loader search
path, or an explicit path.

### `dlSelf`

```milo
fn dlSelf(): Result<Lib, string>
```

A handle to the running program itself, for looking up symbols the executable
exports. Requires linking with `-Wl,-export_dynamic`, same as letting a loaded
library resolve against the host.

### `Lib.close`

```milo
fn Lib.close(self: &Lib): bool
```

Release the handle. Pointers obtained from sym() dangle afterwards, and any
still-running thread the library started keeps running — closing does not
stop it.

### `Lib.has`

```milo
fn Lib.has(self: &Lib, name: &string): bool
```

Whether a symbol is present, without treating absence as an error.

### `Lib.sym`

```milo
fn Lib.sym(self: &Lib, name: &string): Result<*u8, string>
```

Address of a symbol, for casting to an `extern` function-pointer type or
reading as data. A symbol whose value is legitimately zero is
indistinguishable from an error here, as with plain dlsym.
