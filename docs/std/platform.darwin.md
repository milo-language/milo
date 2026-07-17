# std/platform.darwin

## std/platform.darwin

### `addrinfoAddrOffset`

```milo
fn addrinfoAddrOffset(): i64
```

offset of aiAddr field in struct addrinfo

### `direntNameOffset`

```milo
fn direntNameOffset(): i64
```

_Undocumented._

### `direntTypeOffset`

```milo
fn direntTypeOffset(): i64
```

struct dirent layout

### `eagain`

```milo
fn eagain(): i32
```

_Undocumented._

### `einprogress`

```milo
fn einprogress(): i32
```

_Undocumented._

### `evAdd`

```milo
fn evAdd(): u16
```

_Undocumented._

### `evClear`

```milo
fn evClear(): u16
```

_Undocumented._

### `evDelete`

```milo
fn evDelete(): u16
```

_Undocumented._

### `evEnable`

```milo
fn evEnable(): u16
```

_Undocumented._

### `evfiltRead`

```milo
fn evfiltRead(): i16
```

_Undocumented._

### `evfiltUser`

```milo
fn evfiltUser(): i16
```

_Undocumented._

### `evfiltWrite`

```milo
fn evfiltWrite(): i16
```

_Undocumented._

### `evOneshot`

```milo
fn evOneshot(): u16
```

_Undocumented._

### `fGetfl`

```milo
fn fGetfl(): i32
```

_Undocumented._

### `fSetfl`

```milo
fn fSetfl(): i32
```

_Undocumented._

### `getErrno`

```milo
fn getErrno(): i32
```

_Undocumented._

### `makeSockaddr`

```milo
fn makeSockaddr(port: u16, addr: u32): SockAddrIn
```

_Undocumented._

### `makeZeroedSockaddr`

```milo
fn makeZeroedSockaddr(): SockAddrIn
```

_Undocumented._

### `mapAnon`

```milo
fn mapAnon(): i32
```

_Undocumented._

### `mapPrivate`

```milo
fn mapPrivate(): i32
```

_Undocumented._

### `mapPrivateAnon`

```milo
fn mapPrivateAnon(): i32
```

_Undocumented._

### `noteTrigger`

```milo
fn noteTrigger(): u32
```

_Undocumented._

### `oNonblock`

```milo
fn oNonblock(): i32
```

_Undocumented._

### `oWriteCreateAppend`

```milo
fn oWriteCreateAppend(): i32
```

_Undocumented._

### `oWriteCreateTrunc`

```milo
fn oWriteCreateTrunc(): i32
```

_Undocumented._

### `protNone`

```milo
fn protNone(): i32
```

_Undocumented._

### `protRead`

```milo
fn protRead(): i32
```

_Undocumented._

### `protWrite`

```milo
fn protWrite(): i32
```

_Undocumented._

### `sigchldNum`

```milo
fn sigchldNum(): i32
```

SIGCHLD is 20 here and 17 on linux (verified against sys/signal.h and
asm-generic/signal.h respectively), which is why it lives in the platform split rather
than beside the `let SIGx` constants in std/signal — those all happen to agree across
both platforms.

### `sockAddrIn6Len`

```milo
fn sockAddrIn6Len(): u32
```

_Undocumented._

### `sockAddrInLen`

```milo
fn sockAddrInLen(): u32
```

_Undocumented._

### `sockAddrStorageLen`

```milo
fn sockAddrStorageLen(): u32
```

_Undocumented._

### `soError`

```milo
fn soError(): i32
```

_Undocumented._

### `solSocket`

```milo
fn solSocket(): i32
```

_Undocumented._

### `soReuseaddr`

```milo
fn soReuseaddr(): i32
```

_Undocumented._

### `statBufSize`

```milo
fn statBufSize(): i64
```

_Undocumented._

### `statModeOffset`

```milo
fn statModeOffset(): i64
```

struct stat layout (macOS aarch64/x8664)

### `statSizeOffset`

```milo
fn statSizeOffset(): i64
```

_Undocumented._

### `uctxLinkOffset`

```milo
fn uctxLinkOffset(): i64
```

_Undocumented._

### `uctxSize`

```milo
fn uctxSize(): i64
```

_Undocumented._

### `uctxStackPtrOffset`

```milo
fn uctxStackPtrOffset(): i64
```

_Undocumented._

### `uctxStackSizeOffset`

```milo
fn uctxStackSizeOffset(): i64
```

_Undocumented._
