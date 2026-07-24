# std/platform.windows

## std/platform.windows

### `access`

```milo
pub fn access(path: *u8, mode: i32): i32
```

_Undocumented._

### `addrinfoAddrOffset`

```milo
pub fn addrinfoAddrOffset(): i64
```

_Undocumented._

### `afInet6`

```milo
pub fn afInet6(): i32
```

23 here, against 30 on darwin and 10 on linux — no two of the three agree.

### `clampCount`

```milo
fn clampCount(nbyte: i64): u32
```

A count that doesn't fit in the CRT's 32-bit parameter is clamped, not truncated:
a short read/write is a contract every caller already handles, whereas truncation
would silently transfer the low 32 bits of the requested length.

### `close`

```milo
pub fn close(fd: i32): i32
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

The bit-bucket device. Windows spells it NUL (case-insensitive, no path); the CRT's
fd layer opens it just like a file.

### `direntNameOffset`

```milo
pub fn direntNameOffset(): i64
```

_Undocumented._

### `direntTypeOffset`

```milo
pub fn direntTypeOffset(): i64
```

Windows has no dirent/opendir; directory iteration is FindFirstFileW/FindNextFileW.

### `dlclose`

```milo
pub fn dlclose(_handle: *u8): i32
```

POSIX dlclose returns 0 on success; FreeLibrary returns nonzero on success.

### `dlerror`

```milo
pub fn dlerror(): *u8
```

_Undocumented._

### `dlopen`

```milo
pub fn dlopen(_path: *u8, _flags: i32): *u8
```

_Undocumented._

### `dlsym`

```milo
pub fn dlsym(_handle: *u8, _symbol: *u8): *u8
```

_Undocumented._

### `eagain`

```milo
pub fn eagain(): i32
```

C errno values (errno.h), NOT the Winsock ones. Socket calls on Windows do not set
errno at all — they report through WSAGetLastError(), where the corresponding codes are
WSAEWOULDBLOCK 10035 and WSAEINPROGRESS 10036. std/net therefore cannot work by reading
these; wiring that up is part of the net tier, not this one.

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

### `getpid`

```milo
pub fn getpid(): i32
```

_Undocumented._

### `gettimeofday`

```milo
pub fn gettimeofday(tv: *u8, _tz: *u8): i32
```

Fills a POSIX `struct timeval` — two i64s, seconds then microseconds — because that is
the layout std/time reads back out of the buffer it passes.

### `lseek`

```milo
pub fn lseek(fd: i32, offset: i64, whence: i32): i64
```

_Undocumented._

### `makecontext`

```milo
pub fn makecontext(ucp: *u8, func: *u8, _argc: i32): void
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

### `mmap`

```milo
pub fn mmap(_addr: *u8, len: i64, _prot: i32, _flags: i32, fd: i32, _offset: i64): *u8
```

MEM_COMMIT|MEM_RESERVE = 0x3000, PAGE_READWRITE = 0x04.

### `mprotect`

```milo
pub fn mprotect(addr: *u8, len: i64, _prot: i32): i32
```

PAGE_NOACCESS = 0x01, used for the runtime's stack guard page. VirtualProtect must be
given somewhere to write the previous protection or it fails.

### `munmap`

```milo
pub fn munmap(addr: *u8, _len: i64): i32
```

MEM_RELEASE (0x8000) requires the size to be 0 and the address to be the exact base
returned by VirtualAlloc — it always frees the whole reservation, unlike munmap.

### `netEagain`

```milo
pub fn netEagain(): i32
```

The Winsock analogue of EAGAIN: a non-blocking socket op that cannot complete now.

### `netEinprogress`

```milo
pub fn netEinprogress(): i32
```

The Winsock analogue of EINPROGRESS. On POSIX a non-blocking connect() reports EINPROGRESS;
on Windows it reports WSAEWOULDBLOCK (10035), NOT WSAEINPROGRESS (10036, which means "a
blocking call is already in progress" — a different condition). So the in-progress-connect
code here is 10035, the same value as netEagain(); std/os.connectFd checks against this to
decide whether to park for the connect to finish.

### `netErrno`

```milo
pub fn netErrno(): i32
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

_O_WRONLY|_O_CREAT|_O_APPEND|_O_BINARY

### `oWriteCreateTrunc`

```milo
pub fn oWriteCreateTrunc(): i32
```

_O_BINARY (0x8000) is in both: without it the UCRT translates every \n written through
a CRT fd into \r\n, so a file written by Milo would not match its own bytes.
_O_WRONLY|_O_CREAT|_O_TRUNC|_O_BINARY

### `pipe`

```milo
pub fn pipe(fds: *u8): i32
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

The mmap wrappers above translate these into Win32 page-protection flags themselves,
so the values only need to be distinct — they are not a POSIX ABI here.

### `protWrite`

```milo
pub fn protWrite(): i32
```

_Undocumented._

### `pthread_cond_broadcast`

```milo
pub fn pthread_cond_broadcast(cond: *u8): i32
```

_Undocumented._

### `pthread_cond_destroy`

```milo
pub fn pthread_cond_destroy(_cond: *u8): i32
```

_Undocumented._

### `pthread_cond_init`

```milo
pub fn pthread_cond_init(cond: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_cond_signal`

```milo
pub fn pthread_cond_signal(cond: *u8): i32
```

_Undocumented._

### `pthread_cond_wait`

```milo
pub fn pthread_cond_wait(cond: *u8, mutex: *u8): i32
```

INFINITE (0xFFFFFFFF) and flags 0 = wait on the lock held exclusively, matching the
SRWLOCK acquired by pthread_mutex_lock above.

### `pthread_create`

```milo
pub fn pthread_create(thread: *u8, _attr: *u8, start: *u8, arg: *u8): i32
```

pthread_t is a HANDLE here. The start routine's signature differs — pthread wants
void*(*)(void*) and Win32 wants DWORD(*)(LPVOID) — but on x64 both take their argument
in RCX and return in RAX, and the return value is discarded by every caller in std, so
the mismatch is confined to a wider return register than Win32 reads back.

### `pthread_detach`

```milo
pub fn pthread_detach(thread: i64): i32
```

_Undocumented._

### `pthread_join`

```milo
pub fn pthread_join(thread: i64, _retval: *u8): i32
```

_Undocumented._

### `pthread_mutex_destroy`

```milo
pub fn pthread_mutex_destroy(_mutex: *u8): i32
```

An SRWLOCK owns no resources, so there is nothing to release.

### `pthread_mutex_init`

```milo
pub fn pthread_mutex_init(mutex: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_mutex_lock`

```milo
pub fn pthread_mutex_lock(mutex: *u8): i32
```

_Undocumented._

### `pthread_mutex_unlock`

```milo
pub fn pthread_mutex_unlock(mutex: *u8): i32
```

_Undocumented._

### `pthread_rwlock_destroy`

```milo
pub fn pthread_rwlock_destroy(_rwlock: *u8): i32
```

_Undocumented._

### `pthread_rwlock_init`

```milo
pub fn pthread_rwlock_init(rwlock: *u8, _attr: *u8): i32
```

_Undocumented._

### `pthread_rwlock_rdlock`

```milo
pub fn pthread_rwlock_rdlock(rwlock: *u8): i32
```

_Undocumented._

### `pthread_rwlock_unlock`

```milo
pub fn pthread_rwlock_unlock(rwlock: *u8): i32
```

SRWLOCK has separate release calls per mode and no way to ask which one is held, so a
single unlock cannot serve both. std/sync only ever takes these exclusively; a shared
reader that reached here would corrupt the lock state, which is why this is exclusive.

### `pthread_rwlock_wrlock`

```milo
pub fn pthread_rwlock_wrlock(rwlock: *u8): i32
```

_Undocumented._

### `read`

```milo
pub fn read(fd: i32, buf: *u8, nbyte: i64): i64
```

_Undocumented._

### `sigchldNum`

```milo
pub fn sigchldNum(): i32
```

SIGCHLD does not exist: Windows has no SIGCHLD/wait() model, process exit is observed
by waiting on the process HANDLE.

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

Longest path that still leaves room for the NUL.

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

struct _stat64 — 56 bytes, against darwin's 144. st_mode is a 16-bit field at 6.

### `statSizeOffset`

```milo
pub fn statSizeOffset(): i64
```

_Undocumented._

### `swapcontext`

```milo
pub fn swapcontext(oucp: *u8, ucp: *u8): i32
```

_Undocumented._

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

### `usleep`

```milo
pub fn usleep(usec: u32): i32
```

Sleep() has millisecond resolution, so sub-millisecond requests round up to 1ms rather
than to 0 — a busy-wait caller asking for 100us should yield, not spin.

### `write`

```milo
pub fn write(fd: i32, buf: *u8, nbyte: i64): i64
```

_Undocumented._
