# std/env

## std/env

### `getEnv`

```milo
fn getEnv(name: string): Option<string>
```

Value of environment variable `name`, or None if it isn't set.

### `getEnvOr`

```milo
fn getEnvOr(name: string, defaultVal: string): string
```

Value of environment variable `name`, or `defaultVal` if it isn't set.
