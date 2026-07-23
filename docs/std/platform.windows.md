# std/platform.windows

## std/platform.windows

### `addrinfoAddrOffset`

```milo
fn addrinfoAddrOffset(): i64
```

_Undocumented._

### `afInet6`

```milo
fn afInet6(): i32
```

23 here, against 30 on darwin and 10 on linux — no two of the three agree.

### `direntNameOffset`

```milo
fn direntNameOffset(): i64
```

_Undocumented._

### `direntTypeOffset`

```milo
fn direntTypeOffset(): i64
```

Windows has no dirent/opendir; directory iteration is FindFirstFileW/FindNextFileW.

### `eagain`

```milo
fn eagain(): i32
```

C errno values (errno.h), NOT the Winsock ones. Socket calls on Windows do not set
errno at all — they report through WSAGetLastError(), where the corresponding codes are
WSAEWOULDBLOCK 10035 and WSAEINPROGRESS 10036. std/net therefore cannot work by reading
these; wiring that up is part of the net tier, not this one.

### `einprogress`

```milo
fn einprogress(): i32
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

### `getcontext`

```milo
fn getcontext(ucp: *u8): i32
```

_Undocumented._

### `getErrno`

```milo
fn getErrno(): i32
```

_Undocumented._

### `gettimeofday`

```milo
fn gettimeofday(tv: *u8, _tz: *u8): i32
```

Fills a POSIX `struct timeval` — two i64s, seconds then microseconds — because that is
the layout std/time reads back out of the buffer it passes.

### `makecontext`

```milo
fn makecontext(ucp: *u8, func: *u8, _argc: i32): void
```

_Undocumented._

### `makeSockaddr`

```milo
fn makeSockaddr(port: u16, addr: u32): SockAddrIn
```

_Undocumented._

### `makeSockaddr6`

```milo
fn makeSockaddr6(port: u16, addr: [u8; 16], scopeId: u32): SockAddrIn6
```

_Undocumented._

### `makeSockaddrUn`

```milo
fn makeSockaddrUn(path: &string): SockAddrUn
```

_Undocumented._

### `makeZeroedSockaddr`

```milo
fn makeZeroedSockaddr(): SockAddrIn
```

_Undocumented._

### `makeZeroedSockaddrStorage`

```milo
fn makeZeroedSockaddrStorage(): SockAddrStorage
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

### `mmap`

```milo
fn mmap(_addr: *u8, len: i64, _prot: i32, _flags: i32, fd: i32, _offset: i64): *u8
```

MEM_COMMIT|MEM_RESERVE = 0x3000, PAGE_READWRITE = 0x04.

### `mprotect`

```milo
fn mprotect(addr: *u8, len: i64, _prot: i32): i32
```

PAGE_NOACCESS = 0x01, used for the runtime's stack guard page. VirtualProtect must be
given somewhere to write the previous protection or it fails.

### `munmap`

```milo
fn munmap(addr: *u8, _len: i64): i32
```

MEM_RELEASE (0x8000) requires the size to be 0 and the address to be the exact base
returned by VirtualAlloc — it always frees the whole reservation, unlike munmap.

### `oNonblock`

```milo
fn oNonblock(): i32
```

_Undocumented._

### `oWriteCreateAppend`

```milo
fn oWriteCreateAppend(): i32
```

_O_WRONLY|_O_CREAT|_O_APPEND|_O_BINARY

### `oWriteCreateTrunc`

```milo
fn oWriteCreateTrunc(): i32
```

_O_BINARY (0x8000) is in both: without it the UCRT translates every \n written through
a CRT fd into \r\n, so a file written by Milo would not match its own bytes.
_O_WRONLY|_O_CREAT|_O_TRUNC|_O_BINARY

### `pipe`

```milo
fn pipe(fds: *u8): i32
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

The mmap wrappers above translate these into Win32 page-protection flags themselves,
so the values only need to be distinct — they are not a POSIX ABI here.

### `protWrite`

```milo
fn protWrite(): i32
```

_Undocumented._

### `pthread_cond_broadcast`

```milo
fn pthread_cond_broadcast(cond: *u8): i32
```

_Undocumented._

### `pthread_cond_destroy`

```milo
fn pthread_cond_destroy(_cond: *u8): i32
```

_Undocumented._

### `pthread_cond_init`

```milo
fn pthread_cond_init(cond: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_cond_signal`

```milo
fn pthread_cond_signal(cond: *u8): i32
```

_Undocumented._

### `pthread_cond_wait`

```milo
fn pthread_cond_wait(cond: *u8, mutex: *u8): i32
```

INFINITE (0xFFFFFFFF) and flags 0 = wait on the lock held exclusively, matching the
SRWLOCK acquired by pthread_mutex_lock above.

### `pthread_create`

```milo
fn pthread_create(thread: *u8, _attr: *u8, start: *u8, arg: *u8): i32
```

pthread_t is a HANDLE here. The start routine's signature differs — pthread wants
void*(*)(void*) and Win32 wants DWORD(*)(LPVOID) — but on x64 both take their argument
in RCX and return in RAX, and the return value is discarded by every caller in std, so
the mismatch is confined to a wider return register than Win32 reads back.

### `pthread_detach`

```milo
fn pthread_detach(thread: i64): i32
```

_Undocumented._

### `pthread_join`

```milo
fn pthread_join(thread: i64, _retval: *u8): i32
```

_Undocumented._

### `pthread_mutex_destroy`

```milo
fn pthread_mutex_destroy(_mutex: *u8): i32
```

An SRWLOCK owns no resources, so there is nothing to release.

### `pthread_mutex_init`

```milo
fn pthread_mutex_init(mutex: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_mutex_lock`

```milo
fn pthread_mutex_lock(mutex: *u8): i32
```

_Undocumented._

### `pthread_mutex_unlock`

```milo
fn pthread_mutex_unlock(mutex: *u8): i32
```

_Undocumented._

### `pthread_rwlock_destroy`

```milo
fn pthread_rwlock_destroy(_rwlock: *u8): i32
```

_Undocumented._

### `pthread_rwlock_init`

```milo
fn pthread_rwlock_init(rwlock: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_rwlock_rdlock`

```milo
fn pthread_rwlock_rdlock(rwlock: *u8): i32
```

_Undocumented._

### `pthread_rwlock_unlock`

```milo
fn pthread_rwlock_unlock(rwlock: *u8): i32
```

SRWLOCK has separate release calls per mode and no way to ask which one is held, so a
single unlock cannot serve both. std/sync only ever takes these exclusively; a shared
reader that reached here would corrupt the lock state, which is why this is exclusive.

### `pthread_rwlock_wrlock`

```milo
fn pthread_rwlock_wrlock(rwlock: *u8): i32
```

_Undocumented._

### `sigchldNum`

```milo
fn sigchldNum(): i32
```

SIGCHLD does not exist: Windows has no SIGCHLD/wait() model, process exit is observed
by waiting on the process HANDLE.

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

Longest path that still leaves room for the NUL.

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

struct _stat64 — 56 bytes, against darwin's 144. st_mode is a 16-bit field at 6.

### `statSizeOffset`

```milo
fn statSizeOffset(): i64
```

_Undocumented._

### `swapcontext`

```milo
fn swapcontext(oucp: *u8, ucp: *u8): i32
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

### `usleep`

```milo
fn usleep(usec: u32): i32
```

Sleep() has millisecond resolution, so sub-millisecond requests round up to 1ms rather
than to 0 — a busy-wait caller asking for 100us should yield, not spin.
