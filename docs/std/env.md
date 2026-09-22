# std/env

## std/env

### `Env.get`

```milo
fn Env.get(name: string): Option<string>
```

Look up an environment variable. None if it is unset.

### `Env.getOr`

```milo
fn Env.getOr(name: string, defaultVal: string): string
```

Look up an environment variable, or `defaultVal` if it is unset:
`Env.getOr("PORT", "8080")`.

### `Env.remove`

```milo
fn Env.remove(name: &string): Result<Unit, EnvError>
```

Remove `name` from THIS process's environment. Removing a name that is not set
succeeds. Carries the same thread-safety caveat as `set` — see there.

### `Env.set`

```milo
fn Env.set(name: &string, value: &string): Result<Unit, EnvError>
```

Set `name` to `value` in THIS process's environment, replacing any current value.
Children spawned afterwards inherit it; the parent shell never sees it.

NOT thread-safe, and the platform gives no way to make it so. C's setenv may free
the block a concurrent getenv is reading, so a getenv on another OS thread can read
freed memory — a real crash, not a stale read. What Milo does and does not promise:

 - Safe from a single-threaded program, and from anywhere in a program whose green
   tasks all run on the scheduler's one OS thread: green tasks only switch at await
   points, and this call contains none.
 - NOT safe concurrently with Promise.blocking work, which runs on real OS threads
   and may call Env.get (or any C library that calls getenv) at the same instant.
 - Env.get itself copies the value out before returning, so a value already read is
   never invalidated; the window is only the read *in progress*.

The safe pattern is the one Go and Rust also recommend: set the environment during
startup, before spawning anything.

To give one child a variable without changing your own environment, use
`Command.env` in std/process instead.
