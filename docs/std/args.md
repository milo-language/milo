# std/args

## std/args

### `args`

```milo
pub fn args(): Vec<string>
```

Return all command-line arguments as a Vec<string>.
Index 0 is the program name.

### `getFlag`

```milo
pub fn getFlag(name: &string): string?
```

Get the value following a --name flag.
None if the flag is absent or is the last argument. Only the `--name value`
form is recognised, not `--name=value`.
Example: getFlag("port") returns the value after --port.

### `hasFlag`

```milo
pub fn hasFlag(name: &string): bool
```

Check if a --name flag is present in the arguments.
