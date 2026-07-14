# std/args

## std/args

### `args`

```milo
fn args(): Vec<string>
```

Return all command-line arguments as a Vec<string>.
Index 0 is the program name.

### `getFlag`

```milo
fn getFlag(name: &string): string?
```

Get the value following a --name flag.
Returns null if the flag is not present.
Example: getFlag("port") returns the value after --port.

### `hasFlag`

```milo
fn hasFlag(name: &string): bool
```

Check if a --name flag is present in the arguments.
