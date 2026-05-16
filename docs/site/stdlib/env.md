# std/env

Environment variable access.

```milo
from "std/env" import { getEnv, getEnvOr }
```

## Functions

### getEnv

```milo
fn getEnv(name: string): Option<string>
```

Look up an environment variable. Returns `None` if unset.

```milo
match getEnv("HOME") {
    Some(home) => writeStdout(&home),
    None => writeStdout("HOME not set"),
}
```

### getEnvOr

```milo
fn getEnvOr(name: string, fallback: string): string
```

Look up an environment variable with a default.

```milo
let port = getEnvOr("PORT", "8080")
```
