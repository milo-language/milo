# std/sysinfo.windows

## std/sysinfo.windows

### `cpuCount`

```milo
fn cpuCount(): i64
```

_Undocumented._

### `cpuModel`

```milo
fn cpuModel(): string
```

Windows has no unprivileged, non-registry brand-string source, so report the
processor architecture (honest and label-accurate) rather than a fabricated model.

### `cwd`

```milo
fn cwd(): string
```

_Undocumented._

### `egid`

```milo
fn egid(): u32
```

_Undocumented._

### `euid`

```milo
fn euid(): u32
```

_Undocumented._

### `freeMem`

```milo
fn freeMem(): i64
```

_Undocumented._

### `gid`

```milo
fn gid(): u32
```

_Undocumented._

### `hostname`

```milo
fn hostname(): string
```

_Undocumented._

### `loadAvg`

```milo
fn loadAvg(): [f64; 3]
```

Windows has no load-average metric; the darwin/linux arms return this array too, so
keep the shape and report zeros rather than inventing a number.

### `osRelease`

```milo
fn osRelease(): string
```

The reliable OS version lives behind the registry (RtlGetVersion needs ntdll and a
manifest to be truthful), which this arm deliberately avoids. Empty matches the POSIX
failure return rather than reporting a version the API is known to lie about.

### `pid`

```milo
fn pid(): i32
```

_Undocumented._

### `ppid`

```milo
fn ppid(): i32
```

No getppid on Windows without a Toolhelp process walk; degrade to 0 like a failed
/proc read rather than returning a fabricated parent.

### `setCwd`

```milo
fn setCwd(path: string): bool
```

_Undocumented._

### `totalMem`

```milo
fn totalMem(): i64
```

_Undocumented._

### `uid`

```milo
fn uid(): u32
```

Windows identities are SIDs, not numeric ids — there is no uid/gid/euid/egid to
report. 0 matches the darwin/linux failure return; it does NOT mean "root".

### `uptime`

```milo
fn uptime(): i64
```

_Undocumented._
