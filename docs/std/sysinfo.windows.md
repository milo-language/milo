# std/sysinfo.windows

## std/sysinfo.windows

### `cpuCount`

```milo
pub fn cpuCount(): i64
```

_Undocumented._

### `cpuModel`

```milo
pub fn cpuModel(): string
```

Windows has no unprivileged, non-registry brand-string source, so report the
processor architecture (honest and label-accurate) rather than a fabricated model.

### `cwd`

```milo
pub fn cwd(): string
```

_Undocumented._

### `egid`

```milo
pub fn egid(): u32
```

_Undocumented._

### `euid`

```milo
pub fn euid(): u32
```

_Undocumented._

### `freeMem`

```milo
pub fn freeMem(): i64
```

_Undocumented._

### `gid`

```milo
pub fn gid(): u32
```

_Undocumented._

### `hostname`

```milo
pub fn hostname(): string
```

_Undocumented._

### `loadAvg`

```milo
pub fn loadAvg(): [f64; 3]
```

Windows has no load-average metric; the darwin/linux arms return this array too, so
keep the shape and report zeros rather than inventing a number.

### `osRelease`

```milo
pub fn osRelease(): string
```

The reliable OS version lives behind the registry (RtlGetVersion needs ntdll and a
manifest to be truthful), which this arm deliberately avoids. Empty matches the POSIX
failure return rather than reporting a version the API is known to lie about.

### `pid`

```milo
pub fn pid(): i32
```

_Undocumented._

### `ppid`

```milo
pub fn ppid(): i32
```

No getppid on Windows without a Toolhelp process walk; degrade to 0 like a failed
/proc read rather than returning a fabricated parent.

### `setCwd`

```milo
pub fn setCwd(path: string): bool
```

_Undocumented._

### `totalMem`

```milo
pub fn totalMem(): i64
```

_Undocumented._

### `uid`

```milo
pub fn uid(): u32
```

Windows identities are SIDs, not numeric ids — there is no uid/gid/euid/egid to
report. 0 matches the darwin/linux failure return; it does NOT mean "root".

### `uptime`

```milo
pub fn uptime(): i64
```

_Undocumented._
