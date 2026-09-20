# std/platform.wasm

## std/platform.wasm

### `addrinfoAddrOffset`

```milo
pub fn addrinfoAddrOffset(): i64
```

_Undocumented._

### `afInet6`

```milo
pub fn afInet6(): i32
```

_Undocumented._

### `closeSocket`

```milo
pub fn closeSocket(fd: i32): i32
```

_Undocumented._

### `devNullPath`

```milo
pub fn devNullPath(): string
```

_Undocumented._

### `direntNameOffset`

```milo
pub fn direntNameOffset(): i64
```

_Undocumented._

### `direntTypeOffset`

```milo
pub fn direntTypeOffset(): i64
```

_Undocumented._

### `eagain`

```milo
pub fn eagain(): i32
```

_Undocumented._

### `einprogress`

```milo
pub fn einprogress(): i32
```

_Undocumented._

### `ensureNetInit`

```milo
pub fn ensureNetInit(): void
```

_Undocumented._

### `environBlock`

```milo
pub fn environBlock(): **u8
```

_Undocumented._

### `envSet`

```milo
pub fn envSet(name: *u8, value: *u8): i32
```

_Undocumented._

### `envUnset`

```milo
pub fn envUnset(name: *u8): i32
```

_Undocumented._

### `evAdd`

```milo
pub fn evAdd(): u16
```

_Undocumented._

### `evClear`

```milo
pub fn evClear(): u16
```

_Undocumented._

### `evDelete`

```milo
pub fn evDelete(): u16
```

_Undocumented._

### `evEnable`

```milo
pub fn evEnable(): u16
```

_Undocumented._

### `evfiltRead`

```milo
pub fn evfiltRead(): i16
```

_Undocumented._

### `evfiltUser`

```milo
pub fn evfiltUser(): i16
```

_Undocumented._

### `evfiltWrite`

```milo
pub fn evfiltWrite(): i16
```

_Undocumented._

### `evOneshot`

```milo
pub fn evOneshot(): u16
```

_Undocumented._

### `execvpWithEnv`

```milo
pub fn execvpWithEnv(file: *u8, argv: *u8, envp: *u8): i32
```

_Undocumented._

### `exePathInto`

```milo
pub fn exePathInto(buf: *u8, bufsize: i64): i64
```

_Undocumented._

### `fGetfl`

```milo
pub fn fGetfl(): i32
```

_Undocumented._

### `fSetfl`

```milo
pub fn fSetfl(): i32
```

_Undocumented._

### `getcontext`

```milo
pub fn getcontext(ucp: *u8): i32
```

_Undocumented._

### `getErrno`

```milo
pub fn getErrno(): i32
```

_Undocumented._

### `makecontext`

```milo
pub fn makecontext(ucp: *u8, func: *u8, argc: i32,...): void
```

_Undocumented._

### `makeSockaddr`

```milo
pub fn makeSockaddr(port: u16, addr: u32): SockAddrIn
```

_Undocumented._

### `makeSockaddr6`

```milo
pub fn makeSockaddr6(port: u16, addr: [u8; 16], scopeId: u32): SockAddrIn6
```

_Undocumented._

### `makeSockaddrUn`

```milo
pub fn makeSockaddrUn(path: &string): SockAddrUn
```

_Undocumented._

### `makeZeroedSockaddr`

```milo
pub fn makeZeroedSockaddr(): SockAddrIn
```

_Undocumented._

### `makeZeroedSockaddrStorage`

```milo
pub fn makeZeroedSockaddrStorage(): SockAddrStorage
```

_Undocumented._

### `mapAnon`

```milo
pub fn mapAnon(): i32
```

_Undocumented._

### `mapPrivate`

```milo
pub fn mapPrivate(): i32
```

_Undocumented._

### `mapPrivateAnon`

```milo
pub fn mapPrivateAnon(): i32
```

_Undocumented._

### `netEagain`

```milo
pub fn netEagain(): i32
```

_Undocumented._

### `netEinprogress`

```milo
pub fn netEinprogress(): i32
```

_Undocumented._

### `netErrno`

```milo
pub fn netErrno(): i32
```

_Undocumented._

### `noteTrigger`

```milo
pub fn noteTrigger(): u32
```

_Undocumented._

### `oNonblock`

```milo
pub fn oNonblock(): i32
```

_Undocumented._

### `oWriteCreateAppend`

```milo
pub fn oWriteCreateAppend(): i32
```

_Undocumented._

### `oWriteCreateTrunc`

```milo
pub fn oWriteCreateTrunc(): i32
```

_Undocumented._

### `protNone`

```milo
pub fn protNone(): i32
```

_Undocumented._

### `protRead`

```milo
pub fn protRead(): i32
```

_Undocumented._

### `protWrite`

```milo
pub fn protWrite(): i32
```

_Undocumented._

### `sigchldNum`

```milo
pub fn sigchldNum(): i32
```

_Undocumented._

### `sockAddrIn6Len`

```milo
pub fn sockAddrIn6Len(): u32
```

_Undocumented._

### `sockAddrInLen`

```milo
pub fn sockAddrInLen(): u32
```

_Undocumented._

### `sockAddrStorageLen`

```milo
pub fn sockAddrStorageLen(): u32
```

_Undocumented._

### `sockAddrUnLen`

```milo
pub fn sockAddrUnLen(): u32
```

_Undocumented._

### `sockAddrUnMaxPath`

```milo
pub fn sockAddrUnMaxPath(): i64
```

_Undocumented._

### `sockRead`

```milo
pub fn sockRead(fd: i32, buf: *u8, nbyte: i64): i64
```

_Undocumented._

### `sockWrite`

```milo
pub fn sockWrite(fd: i32, buf: *u8, nbyte: i64): i64
```

_Undocumented._

### `soError`

```milo
pub fn soError(): i32
```

_Undocumented._

### `solSocket`

```milo
pub fn solSocket(): i32
```

_Undocumented._

### `soReuseaddr`

```milo
pub fn soReuseaddr(): i32
```

_Undocumented._

### `statBufSize`

```milo
pub fn statBufSize(): i64
```

_Undocumented._

### `statModeOffset`

```milo
pub fn statModeOffset(): i64
```

_Undocumented._

### `statSizeOffset`

```milo
pub fn statSizeOffset(): i64
```

_Undocumented._

### `swapcontext`

```milo
pub fn swapcontext(oucp: *u8, ucp: *u8): i32
```

@parks: same surface as the POSIX extern, so the checker's park summary roots
here on every target.

### `uctxLinkOffset`

```milo
pub fn uctxLinkOffset(): i64
```

_Undocumented._

### `uctxSize`

```milo
pub fn uctxSize(): i64
```

_Undocumented._

### `uctxStackPtrOffset`

```milo
pub fn uctxStackPtrOffset(): i64
```

_Undocumented._

### `uctxStackSizeOffset`

```milo
pub fn uctxStackSizeOffset(): i64
```

_Undocumented._
