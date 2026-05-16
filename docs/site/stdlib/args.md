# std/args

Raw CLI argument access.

```milo
from "std/args" import { args, getFlag, hasFlag }
```

## Functions

### args

```milo
fn args(): Vec<string>
```

Returns all command-line arguments (including the program name at index 0).

### getFlag

```milo
fn getFlag(name: &string): Option<string>
```

Returns the value of a `--name value` or `--name=value` flag, or `None` if not present.

### hasFlag

```milo
fn hasFlag(name: &string): bool
```

Returns true if `--name` appears in the arguments.

```milo
let verbose = hasFlag(&"verbose")
let output = getFlag(&"output")
match output {
    Some(path) => print(fmt1(&"Writing to {}", &path)),
    None => print("Writing to stdout"),
}
```
