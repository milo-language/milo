# std/platform.linux

## std/platform.linux

### `addrinfoAddrOffset`

```milo
fn addrinfoAddrOffset(): i64
```

offset of aiAddr field in struct addrinfo (swapped with aiCanonname vs macOS)

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

### `epollCtlAdd`

```milo
fn epollCtlAdd(): i32
```

_Undocumented._

### `epollCtlDel`

```milo
fn epollCtlDel(): i32
```

_Undocumented._

### `epollCtlMod`

```milo
fn epollCtlMod(): i32
```

_Undocumented._

### `epollErr`

```milo
fn epollErr(): u32
```

_Undocumented._

### `epollHup`

```milo
fn epollHup(): u32
```

_Undocumented._

### `epollIn`

```milo
fn epollIn(): u32
```

_Undocumented._

### `epollOneshot`

```milo
fn epollOneshot(): u32
```

_Undocumented._

### `epollOut`

```milo
fn epollOut(): u32
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

### `makeSockaddrUn`

```milo
fn makeSockaddrUn(path: &string): SockAddrUn
```

Whole-struct length; bind/connect want it for AF_UNIX.
AF_UNIX address for `path`. Truncates at sockAddrUnMaxPath so the kernel always sees a
NUL-terminated path; callers should reject longer paths rather than connect to a
silently shortened one (UnixListener/UnixStream do).

### `makeZeroedSockaddr`

```milo
fn makeZeroedSockaddr(): SockAddrIn
```

_Undocumented._

### `makeZeroedSockaddrStorage`

```milo
fn makeZeroedSockaddrStorage(): SockAddrStorage
```

128 bytes of zeroes; the kernel fills in whichever family the peer used.

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

17 here, 20 on darwin (verified against asm-generic/signal.h and sys/signal.h
respectively). The only signal std/signal needs that isn't same-numbered on both.

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

### `sockAddrUnLen`

```milo
fn sockAddrUnLen(): u32
```

_Undocumented._

### `sockAddrUnMaxPath`

```milo
fn sockAddrUnMaxPath(): i64
```

Longest path that still leaves room for the NUL the kernel expects.

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

struct stat layout (Linux x8664)

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

sizeof(ucontext_t) on linux x86_64

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
