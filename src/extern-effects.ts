// The extern effect catalog: what every C function std declares does to the world, so
// record/replay can capture it (docs/record-replay.md §The extern catalog).
//
// rr keeps the same table for Linux syscalls. Each entry says what the call returns, which
// pointer params it writes and how many bytes, and whether its answer comes from outside
// the process (recorded, and answered from the trace under replay) or is decided by the
// process alone (left alone). src/replay-externs.ts turns an entry into the wrapper a call
// is redirected to under MILO_RECORD / MILO_REPLAY. tests/externEffects.test.ts fails when
// std declares an extern this table does not describe.
//
// Effects:
//   pure    the answer depends only on the arguments and the memory they point at
//           (strlen, sqrt, regexec). Never recorded.
//   local   changes or reads state only this process owns and decides the same way every
//           run (the allocator, signal dispositions, stdio buffers, fibers). Never recorded.
//   sync    a raw lock, condition variable or thread primitive. std/sync and std/runtime
//           order these themselves (thread ordering in std/replay); a call from anywhere
//           else is unordered shared memory, which is a hole.
//   input   the answer comes from outside the process (the clock, a file, the network, the
//           kernel's process table). Recorded: return value, errno and every output buffer;
//           under replay the call is not made and the recorded answer is copied back.
//   effect  changes the world outside the process (writes, unlinks, signals another
//           process, closes a descriptor). Recorded the same way; under replay the call is
//           not made, so a replay touches nothing.
//   sched   an event-loop wait (kevent, epoll_wait). std/runtime records the scheduler's
//           decisions instead (sched.pick); a call from anywhere else is a hole.
//   hole    cannot be recorded by copying bytes: it builds a pointer-linked structure,
//           replaces the process image, or loads code whose calls are invisible. Reported
//           when called (see `why`).
//
// Output specs (`out`, and the `@records` attribute, which uses the same grammar):
//   "buf[ret]"          `ret` bytes (the return value, when positive) through buf
//   "buf[len]"          as many bytes as the value of param `len`
//   "buf[16]"           a fixed byte count
//   "buf[8*ret]"        a multiple of the return value or a param
//   "buf[*lenp]"        the count the call stored in the integer `lenp` points at
//   "buf[4**lenp]"      a multiple of that count
//   "buf[cstr]"         a NUL-terminated string, terminator included
//   "buf[cstr:len]"     a NUL-terminated string within `len` bytes
//   "buf[sizeof(struct stat)]"  a C type's size on the target (SIZES below)
//   "buf[deep]"         a pointer to a structure the call allocated: not recordable, so a
//                       call with this param non-null is reported as a hole
// A null output pointer is skipped. `ret` names how a pointer return is replayed:
//   "cstr"              a NUL-terminated string (replay hands back a heap copy)
//   "handle"            an opaque handle only ever passed back to recorded calls
//   "param:<p>"         param `p` (or null)
//   "static:<size>"     a pointer to a structure of that size (replay hands back a copy)
// `in` names pointer params whose contents identify the call (a path, a variable name),
// so a replay that asks for a different one diverges instead of answering it.
// `errno` is the error channel the call reports through ("errno", or "net" for the
// Windows socket calls that report through WSAGetLastError).
// `va` gives the variadic tail the wrapper accepts, each passed as an i64.

export type ExternEffectKind = "pure" | "local" | "sync" | "input" | "effect" | "sched" | "hole";
export type ExternOs = "darwin" | "linux" | "windows" | "wasm";

export interface ExternEffect {
  effect: ExternEffectKind;
  out?: string[];
  ret?: string;
  in?: string[];
  errno?: "errno" | "net";
  va?: string[];
  /** Record kind; defaults to `x.<name>`. */
  kind?: string;
  /** Why a hole cannot be recorded. */
  why?: string;
  /** Where the description comes from: a man page section, a vendor reference page. */
  src: string;
  /** Per-target differences. */
  os?: Partial<Record<ExternOs, Partial<ExternEffect>>>;
}

// C type sizes per target, for `sizeof(...)` output specs. Darwin values were measured with
// clang on arm64 and x86_64 (identical); Linux values are glibc's (struct stat differs by
// architecture); Windows values are the x64 SDK's.
export const SIZES: Record<string, Partial<Record<string, number>>> = {
  "struct stat": { darwin: 144, "linux-x86_64": 144, "linux-aarch64": 128, linux: 144, wasm: 144 },
  "struct timeval": { darwin: 16, linux: 16, wasm: 16 },
  "struct tm": { darwin: 56, linux: 56, windows: 36, wasm: 56 },
  "struct termios": { darwin: 72, linux: 60, wasm: 72 },
  "struct dirent": { darwin: 1048, linux: 280, wasm: 1048 },
  "SYSTEM_INFO": { windows: 48 },
  "MEMORYSTATUSEX": { windows: 64 },
  "FILETIME": { windows: 8 },
  "CONSOLE_SCREEN_BUFFER_INFO": { windows: 22 },
  "PROCESS_INFORMATION": { windows: 24 },
  "WSANETWORKEVENTS": { windows: 44 },
};

const mk = (effect: ExternEffectKind) => (src: string, x: Omit<Partial<ExternEffect>, "effect" | "src"> = {}): ExternEffect => ({ effect, src, ...x });
const pure = mk("pure");
const local = mk("local");
const sync = mk("sync");
const input = mk("input");
const effect = mk("effect");
const sched = mk("sched");
const hole = (src: string, why: string, x: Omit<Partial<ExternEffect>, "effect" | "src" | "why"> = {}): ExternEffect => ({ effect: "hole", src, why, ...x });

const E = "errno" as const;
// Declared by the shared std/os for every target, but the MSVC CRT has no such layout
// (no dirent, no termios) or a different one this table does not describe.
const noWinLayout = { windows: { effect: "hole" as const, why: "the MSVC CRT layout of what it writes is not described" } };
const man = (sec: number, name: string) => `man ${sec} ${name}`;
const win = (name: string) => `learn.microsoft.com ${name}`;
const sqlite = (page: string) => `sqlite.org/c3ref/${page}`;
const ossl = (name: string) => `openssl ${name}(3)`;

export const EXTERN_EFFECTS: Record<string, ExternEffect> = {
  // ── memory, strings, math: pure or process-local ──
  malloc: local(man(3, "malloc")),
  realloc: local(man(3, "realloc")),
  free: local(man(3, "free")),
  memcpy: pure(man(3, "memcpy")),
  memmove: pure(man(3, "memmove")),
  memset: pure(man(3, "memset")),
  memchr: pure(man(3, "memchr")),
  memcmp: pure(man(3, "memcmp")),
  strlen: pure(man(3, "strlen")),
  strcmp: pure(man(3, "strcmp")),
  strncmp: pure(man(3, "strncmp")),
  strtoll: pure(man(3, "strtoll")),
  atof: pure(man(3, "atof")),
  strerror: pure(man(3, "strerror")),
  snprintf: pure(man(3, "snprintf")),
  htons: pure(man(3, "htons")),
  ntohs: pure(man(3, "ntohs")),
  inet_pton: pure(man(3, "inet_pton")),
  acos: pure(man(3, "acos")), asin: pure(man(3, "asin")), atan: pure(man(3, "atan")), atan2: pure(man(3, "atan2")),
  ceil: pure(man(3, "ceil")), cos: pure(man(3, "cos")), exp: pure(man(3, "exp")), fabs: pure(man(3, "fabs")),
  floor: pure(man(3, "floor")), fmod: pure(man(3, "fmod")), log: pure(man(3, "log")), log10: pure(man(3, "log10")),
  log2: pure(man(3, "log2")), pow: pure(man(3, "pow")), round: pure(man(3, "round")), sin: pure(man(3, "sin")),
  sqrt: pure(man(3, "sqrt")), tan: pure(man(3, "tan")),
  mmap: local(man(2, "mmap")),
  munmap: local(man(2, "munmap")),
  mprotect: local(man(2, "mprotect")),
  madvise: local(man(2, "madvise")),
  VirtualAlloc: local(win("VirtualAlloc")),
  VirtualFree: local(win("VirtualFree")),
  VirtualProtect: local(win("VirtualProtect")),
  // Hashes and ciphers compute over their arguments; the context objects are process memory.
  CC_SHA256_Init: pure("man 3 CC_SHA256_Init"), CC_SHA256_Update: pure("man 3 CC_SHA256_Update"),
  CC_SHA256_Final: pure("man 3 CC_SHA256_Final"),
  CC_MD5_Init: pure("man 3 CC_MD5_Init"), CC_MD5_Update: pure("man 3 CC_MD5_Update"), CC_MD5_Final: pure("man 3 CC_MD5_Final"),
  CC_SHA1_Init: pure("man 3 CC_SHA1_Init"), CC_SHA1_Update: pure("man 3 CC_SHA1_Update"), CC_SHA1_Final: pure("man 3 CC_SHA1_Final"),
  CCCryptorGCMOneshotEncrypt: pure("CommonCrypto CommonCryptorSPI.h"),
  CCCryptorGCMOneshotDecrypt: pure("CommonCrypto CommonCryptorSPI.h"),
  MD5: pure(ossl("MD5")), SHA1: pure(ossl("SHA1")), SHA256: pure(ossl("SHA256")),
  EVP_CIPHER_CTX_new: local(ossl("EVP_CIPHER_CTX_new")), EVP_CIPHER_CTX_free: local(ossl("EVP_CIPHER_CTX_free")),
  EVP_CIPHER_CTX_ctrl: pure(ossl("EVP_CIPHER_CTX_ctrl")),
  EVP_EncryptInit_ex: pure(ossl("EVP_EncryptInit_ex")), EVP_EncryptUpdate: pure(ossl("EVP_EncryptUpdate")),
  EVP_EncryptFinal_ex: pure(ossl("EVP_EncryptFinal_ex")), EVP_DecryptInit_ex: pure(ossl("EVP_DecryptInit_ex")),
  EVP_DecryptUpdate: pure(ossl("EVP_DecryptUpdate")), EVP_DecryptFinal_ex: pure(ossl("EVP_DecryptFinal_ex")),
  EVP_aes_128_gcm: pure(ossl("EVP_aes_128_gcm")), EVP_aes_256_gcm: pure(ossl("EVP_aes_256_gcm")),
  BCryptCreateHash: local(win("BCryptCreateHash")), BCryptDestroyHash: local(win("BCryptDestroyHash")),
  BCryptHashData: pure(win("BCryptHashData")), BCryptFinishHash: pure(win("BCryptFinishHash")),
  regcomp: local(man(3, "regcomp")),
  regexec: pure(man(3, "regexec")),
  regfree: local(man(3, "regfree")),
  // Changes the process locale, which regex matching then depends on: performing it under
  // replay is what keeps the replayed matches identical.
  setlocale: local(man(3, "setlocale")),

  // ── process-local plumbing ──
  __error: local("man 2 intro (errno)"),
  __errno_location: local("glibc errno.h"),
  _errno: local(win("_errno")),
  WSAGetLastError: local(win("WSAGetLastError")),
  WSASetLastError: local(win("WSASetLastError")),
  WSAStartup: local(win("WSAStartup")),
  atexit: local(man(3, "atexit")),
  _exit: local(man(2, "_exit")),
  signal: local(man(3, "signal")),
  raise: local(man(3, "raise")),
  DebugBreak: local(win("DebugBreak")),
  // Output through C stdio is performed under replay, like `print`.
  printf: local(man(3, "printf")),
  puts: local(man(3, "puts")),
  fflush: local(man(3, "fflush")),
  setenv: local(man(3, "setenv")),
  unsetenv: local(man(3, "unsetenv")),
  _putenv_s: local(win("_putenv_s")),
  FreeEnvironmentStringsA: local(win("FreeEnvironmentStringsA")),
  // Reads TZ and the zone file into libc's state; the conversions it feeds (localtime_r)
  // are recorded.
  tzset: local(man(3, "tzset")),
  getcontext: local(man(3, "getcontext")),
  makecontext: local(man(3, "makecontext")),
  swapcontext: local(man(3, "swapcontext")),
  ConvertThreadToFiber: local(win("ConvertThreadToFiber")),
  CreateFiber: local(win("CreateFiber")),
  DeleteFiber: local(win("DeleteFiber")),
  SwitchToFiber: local(win("SwitchToFiber")),
  IsThreadAFiber: local(win("IsThreadAFiber")),
  mach_host_self: local("mach/mach_init.h mach_host_self"),
  GetStdHandle: local(win("GetStdHandle")),
  InitializeProcThreadAttributeList: local(win("InitializeProcThreadAttributeList")),
  UpdateProcThreadAttribute: local(win("UpdateProcThreadAttribute")),
  DeleteProcThreadAttributeList: local(win("DeleteProcThreadAttributeList")),
  // TLS configuration is process memory; the handshake and the bytes are recorded below.
  TLS_client_method: local(ossl("TLS_client_method")),
  TLS_server_method: local(ossl("TLS_server_method")),
  SSL_CTX_new: local(ossl("SSL_CTX_new")),
  SSL_CTX_free: local(ossl("SSL_CTX_free")),
  SSL_CTX_set_verify: local(ossl("SSL_CTX_set_verify")),
  SSL_CTX_set_default_verify_paths: local(ossl("SSL_CTX_set_default_verify_paths")),
  SSL_CTX_load_verify_locations: local(ossl("SSL_CTX_load_verify_locations")),
  SSL_CTX_use_certificate_chain_file: local(ossl("SSL_CTX_use_certificate_chain_file")),
  SSL_CTX_use_PrivateKey_file: local(ossl("SSL_CTX_use_PrivateKey_file")),
  SSL_CTX_check_private_key: local(ossl("SSL_CTX_check_private_key")),
  SSL_new: local(ossl("SSL_new")),
  SSL_free: local(ossl("SSL_free")),
  SSL_set_fd: local(ossl("SSL_set_fd")),
  SSL_set1_host: local(ossl("SSL_set1_host")),
  SSL_ctrl: local(ossl("SSL_ctrl")),

  // ── threads and locks: ordered by std/sync, a hole anywhere else ──
  pthread_create: sync(man(3, "pthread_create")),
  pthread_detach: sync(man(3, "pthread_detach")),
  pthread_join: sync(man(3, "pthread_join")),
  pthread_self: sync(man(3, "pthread_self")),
  pthread_mutex_init: sync(man(3, "pthread_mutex_init")),
  pthread_mutex_destroy: sync(man(3, "pthread_mutex_destroy")),
  pthread_mutex_lock: sync(man(3, "pthread_mutex_lock")),
  pthread_mutex_unlock: sync(man(3, "pthread_mutex_unlock")),
  pthread_cond_init: sync(man(3, "pthread_cond_init")),
  pthread_cond_destroy: sync(man(3, "pthread_cond_destroy")),
  pthread_cond_wait: sync(man(3, "pthread_cond_wait")),
  pthread_cond_signal: sync(man(3, "pthread_cond_signal")),
  pthread_cond_broadcast: sync(man(3, "pthread_cond_broadcast")),
  pthread_rwlock_init: sync(man(3, "pthread_rwlock_init")),
  pthread_rwlock_destroy: sync(man(3, "pthread_rwlock_destroy")),
  pthread_rwlock_rdlock: sync(man(3, "pthread_rwlock_rdlock")),
  pthread_rwlock_wrlock: sync(man(3, "pthread_rwlock_wrlock")),
  pthread_rwlock_unlock: sync(man(3, "pthread_rwlock_unlock")),
  CreateThread: sync(win("CreateThread")),
  GetCurrentThreadId: sync(win("GetCurrentThreadId")),
  InitializeSRWLock: sync(win("InitializeSRWLock")),
  AcquireSRWLockExclusive: sync(win("AcquireSRWLockExclusive")),
  AcquireSRWLockShared: sync(win("AcquireSRWLockShared")),
  ReleaseSRWLockExclusive: sync(win("ReleaseSRWLockExclusive")),
  ReleaseSRWLockShared: sync(win("ReleaseSRWLockShared")),
  InitializeConditionVariable: sync(win("InitializeConditionVariable")),
  SleepConditionVariableSRW: sync(win("SleepConditionVariableSRW")),
  WakeConditionVariable: sync(win("WakeConditionVariable")),
  WakeAllConditionVariable: sync(win("WakeAllConditionVariable")),

  // ── event loops: std/runtime records the scheduler's decisions ──
  kqueue: sched(man(2, "kqueue")),
  kevent: sched(man(2, "kevent")),
  epoll_create1: sched(man(2, "epoll_create1")),
  epoll_ctl: sched(man(2, "epoll_ctl")),
  epoll_wait: sched(man(2, "epoll_wait")),
  eventfd: sched(man(2, "eventfd")),
  CreateEventA: sched(win("CreateEventA")),
  SetEvent: sched(win("SetEvent")),
  WSACreateEvent: sched(win("WSACreateEvent")),
  WSACloseEvent: sched(win("WSACloseEvent")),
  WSAEventSelect: sched(win("WSAEventSelect")),
  WSAEnumNetworkEvents: sched(win("WSAEnumNetworkEvents")),
  WaitForMultipleObjects: sched(win("WaitForMultipleObjects")),
  ioctlsocket: sched(win("ioctlsocket")),

  // ── time and identity ──
  gettimeofday: input(man(2, "gettimeofday"), { out: ["tv[sizeof(struct timeval)]"], errno: E }),
  GetSystemTimeAsFileTime: input(win("GetSystemTimeAsFileTime"), { out: ["ft[sizeof(FILETIME)]"] }),
  GetTickCount64: input(win("GetTickCount64")),
  localtime_r: input(man(3, "localtime_r"), { in: ["timep[8]"], out: ["result[sizeof(struct tm)]"], ret: "param:result" }),
  getpid: input(man(2, "getpid")),
  _getpid: input(win("_getpid")),
  getppid: input(man(2, "getppid")),
  getuid: input(man(2, "getuid")),
  geteuid: input(man(2, "geteuid")),
  getgid: input(man(2, "getgid")),
  getegid: input(man(2, "getegid")),
  GetCurrentProcessId: input(win("GetCurrentProcessId")),
  gethostname: input(man(3, "gethostname"), { out: ["name[cstr:len]"], errno: E }),
  GetComputerNameA: input(win("GetComputerNameA"), { out: ["name[cstr:*size]", "size[4]"] }),
  sysconf: input(man(3, "sysconf"), { errno: E }),
  getloadavg: input(man(3, "getloadavg"), { out: ["loadavg[8*ret]"] }),
  sysctl: input(man(3, "sysctl"), { in: ["name[4*namelen]"], out: ["oldp[*oldlenp]", "oldlenp[8]"], errno: E }),
  sysctlbyname: input(man(3, "sysctlbyname"), { in: ["name"], out: ["oldp[*oldlenp]", "oldlenp[8]"], errno: E }),
  host_statistics64: input("mach/host_info.h host_statistics64", { out: ["info[4**count]", "count[4]"] }),
  GetSystemInfo: input(win("GetSystemInfo"), { out: ["info[sizeof(SYSTEM_INFO)]"] }),
  GlobalMemoryStatusEx: input(win("GlobalMemoryStatusEx"), { out: ["buf[sizeof(MEMORYSTATUSEX)]"] }),
  proc_pidpath: input("libproc.h proc_pidpath", { out: ["buf[ret]"], errno: E }),
  GetModuleFileNameA: input(win("GetModuleFileNameA"), { out: ["buf[cstr:size]"] }),
  // Sleeping is waiting on the world; a replay takes no time.
  usleep: effect(man(3, "usleep"), { errno: E }),
  Sleep: effect(win("Sleep")),

  // ── entropy ──
  arc4random: input(man(3, "arc4random")),
  arc4random_uniform: input(man(3, "arc4random_uniform")),
  arc4random_buf: input(man(3, "arc4random_buf"), { out: ["buf[nbytes]"] }),
  getentropy: input(man(2, "getentropy"), { out: ["_buf[_len]"], errno: E }),
  BCryptGenRandom: input(win("BCryptGenRandom"), { out: ["buf[len]"] }),

  // ── environment ──
  getenv: input(man(3, "getenv"), { in: ["name"], ret: "cstr" }),
  _NSGetEnviron: hole("crt_externs.h _NSGetEnviron", "returns the environment as a pointer array; std/environ records it (env.vars)"),
  __p__environ: hole(win("__p__environ"), "returns the environment as a pointer array; std/environ records it (env.vars)"),
  GetEnvironmentStringsA: hole(win("GetEnvironmentStringsA"), "returns the environment as a block of strings; std/environ records it (env.vars)"),

  // ── files and descriptors ──
  open: input(man(2, "open"), { in: ["path"], va: ["i64"], errno: E }),
  read: input(man(2, "read"), { out: ["buf[ret]"], errno: E }),
  _read: input(win("_read"), { out: ["buf[ret]"], errno: E }),
  write: effect(man(2, "write"), { errno: E }),
  _write: effect(win("_write"), { errno: E }),
  close: effect(man(2, "close"), { errno: E }),
  _close: effect(win("_close"), { errno: E }),
  lseek: input(man(2, "lseek"), { errno: E }),
  _lseeki64: input(win("_lseeki64"), { errno: E }),
  dup: input(man(2, "dup"), { errno: E }),
  dup2: effect(man(2, "dup2"), { errno: E }),
  pipe: input(man(2, "pipe"), { out: ["fds[8]"], errno: E }),
  _pipe: input(win("_pipe"), { out: ["fds[8]"], errno: E }),
  fcntl: input(man(2, "fcntl"), { va: ["i64"], errno: E }),
  ioctl: hole(man(2, "ioctl"), "what it writes depends on the request code"),
  isatty: input(man(3, "isatty"), { errno: E }),
  stat: input(man(2, "stat"), { in: ["path"], out: ["buf[sizeof(struct stat)]"], errno: E, os: noWinLayout }),
  lstat: input(man(2, "lstat"), { in: ["path"], out: ["buf[sizeof(struct stat)]"], errno: E, os: noWinLayout }),
  fstat: input(man(2, "fstat"), { out: ["buf[sizeof(struct stat)]"], errno: E, os: noWinLayout }),
  access: input(man(2, "access"), { in: ["path"], errno: E }),
  _access: input(win("_access"), { in: ["path"], errno: E }),
  readlink: input(man(2, "readlink"), { in: ["path"], out: ["buf[ret]"], errno: E }),
  realpath: input(man(3, "realpath"), { in: ["path"], out: ["resolved[cstr]"], ret: "cstr", errno: E }),
  getcwd: input(man(3, "getcwd"), { out: ["buf[cstr:size]"], ret: "param:buf", errno: E }),
  GetCurrentDirectoryA: input(win("GetCurrentDirectoryA"), { out: ["buf[cstr:len]"] }),
  opendir: input(man(3, "opendir"), { in: ["path"], ret: "handle", errno: E }),
  readdir: input(man(3, "readdir"), { ret: "static:sizeof(struct dirent)", errno: E, os: noWinLayout }),
  closedir: effect(man(3, "closedir"), { errno: E }),
  mkdir: effect(man(2, "mkdir"), { in: ["path"], errno: E }),
  rmdir: effect(man(2, "rmdir"), { in: ["path"], errno: E }),
  unlink: effect(man(2, "unlink"), { in: ["path"], errno: E }),
  rename: effect(man(2, "rename"), { in: ["old_path", "new_path"], errno: E }),
  link: effect(man(2, "link"), { in: ["existing", "new_path"], errno: E }),
  symlink: effect(man(2, "symlink"), { in: ["target", "path"], errno: E }),
  chmod: effect(man(2, "chmod"), { in: ["path"], errno: E }),
  fchmod: effect(man(2, "fchmod"), { errno: E }),
  chown: effect(man(2, "chown"), { in: ["path"], errno: E }),
  fchown: effect(man(2, "fchown"), { errno: E }),
  lchown: effect(man(2, "lchown"), { in: ["path"], errno: E }),
  truncate: effect(man(2, "truncate"), { in: ["path"], errno: E }),
  ftruncate: effect(man(2, "ftruncate"), { errno: E }),
  fsync: effect(man(2, "fsync"), { errno: E }),
  fdatasync: effect(man(2, "fdatasync"), { errno: E }),
  chdir: effect(man(2, "chdir"), { in: ["path"], errno: E }),
  SetCurrentDirectoryA: effect(win("SetCurrentDirectoryA"), { in: ["path"] }),
  mkdtemp: effect(man(3, "mkdtemp"), { out: ["template[cstr]"], ret: "param:template", errno: E }),
  mkstemp: effect(man(3, "mkstemp"), { out: ["template[cstr]"], errno: E }),
  tcgetattr: input(man(3, "tcgetattr"), { out: ["termios[sizeof(struct termios)]"], errno: E, os: noWinLayout }),
  tcsetattr: effect(man(3, "tcsetattr"), { errno: E }),
  GetFileType: input(win("GetFileType")),
  GetConsoleMode: input(win("GetConsoleMode"), { out: ["mode[4]"] }),
  SetConsoleMode: effect(win("SetConsoleMode")),
  GetConsoleScreenBufferInfo: input(win("GetConsoleScreenBufferInfo"), { out: ["info[sizeof(CONSOLE_SCREEN_BUFFER_INFO)]"] }),
  _get_osfhandle: input(win("_get_osfhandle"), { errno: E }),
  _open_osfhandle: input(win("_open_osfhandle"), { errno: E }),
  CloseHandle: effect(win("CloseHandle")),
  SetHandleInformation: effect(win("SetHandleInformation")),
  CreatePipe: input(win("CreatePipe"), { out: ["readPipe[8]", "writePipe[8]"] }),

  // ── sockets and DNS ──
  socket: input(man(2, "socket"), { errno: E }),
  bind: effect(man(2, "bind"), { in: ["addr[addrlen]"], errno: E }),
  listen: effect(man(2, "listen"), { errno: E }),
  connect: effect(man(2, "connect"), { in: ["addr[addrlen]"], errno: E }),
  accept: input(man(2, "accept"), { out: ["addr[*addrlen]", "addrlen[4]"], errno: E }),
  getsockname: input(man(2, "getsockname"), { out: ["addr[*addrlen]", "addrlen[4]"], errno: E }),
  getsockopt: input(man(2, "getsockopt"), { out: ["val[*len]", "len[4]"], errno: E }),
  setsockopt: effect(man(2, "setsockopt"), { errno: E }),
  recv: input(win("recv"), { out: ["buf[ret]"], errno: "net" }),
  send: effect(win("send"), { errno: "net" }),
  closesocket: effect(win("closesocket"), { errno: "net" }),
  getaddrinfo: hole(man(3, "getaddrinfo"), "it returns a linked list of addrinfo it allocated; std/net records the resolved address (net.resolve)",
    { in: ["node", "service"], out: ["res[deep]"] }),
  freeaddrinfo: local(man(3, "freeaddrinfo")),

  // ── TLS: OpenSSL does the socket IO, so the plaintext is the answer ──
  SSL_connect: effect(ossl("SSL_connect")),
  SSL_accept: effect(ossl("SSL_accept")),
  SSL_shutdown: effect(ossl("SSL_shutdown")),
  SSL_read: input(ossl("SSL_read"), { out: ["buf[ret]"] }),
  SSL_write: effect(ossl("SSL_write")),
  SSL_get_error: input(ossl("SSL_get_error")),
  SSL_get_verify_result: input(ossl("SSL_get_verify_result")),

  // ── processes and ptys ──
  fork: hole(man(2, "fork"), "the child would write into the parent's trace; std/process records spawns (proc.spawn)"),
  execvp: hole(man(3, "execvp"), "replaces the process image, ending the recording"),
  execvpe: hole(man(3, "execvpe"), "replaces the process image, ending the recording"),
  execl: hole(man(3, "execl"), "replaces the process image, ending the recording"),
  // std/replay's restart with ASLR off (std/platform: aslrReexec), which runs before
  // anything is recorded.
  posix_spawnattr_init: local(man(3, "posix_spawnattr_init")),
  posix_spawnattr_setflags: local(man(3, "posix_spawnattr_setflags")),
  posix_spawn: hole(man(2, "posix_spawn"), "starts or becomes another program, whose calls are not this trace's"),
  personality: local(man(2, "personality")),
  execve: hole(man(2, "execve"), "replaces the process image, ending the recording"),
  waitpid: effect(man(2, "waitpid"), { out: ["status[4]"], errno: E }),
  kill: effect(man(2, "kill"), { errno: E }),
  setsid: effect(man(2, "setsid"), { errno: E }),
  system: effect(man(3, "system"), { in: ["cmd"], errno: E }),
  posix_openpt: input(man(3, "posix_openpt"), { errno: E }),
  grantpt: effect(man(3, "grantpt"), { errno: E }),
  unlockpt: effect(man(3, "unlockpt"), { errno: E }),
  ptsname: input(man(3, "ptsname"), { ret: "cstr", errno: E }),
  CreateProcessA: effect(win("CreateProcessA"), { in: ["cmdLine"], out: ["pi[sizeof(PROCESS_INFORMATION)]"] }),
  OpenProcess: input(win("OpenProcess"), { ret: "handle" }),
  TerminateProcess: effect(win("TerminateProcess")),
  WaitForSingleObject: input(win("WaitForSingleObject")),
  GetExitCodeProcess: input(win("GetExitCodeProcess"), { out: ["code[4]"] }),
  CreatePseudoConsole: effect(win("CreatePseudoConsole"), { out: ["hpc[8]"] }),
  ResizePseudoConsole: effect(win("ResizePseudoConsole")),
  ClosePseudoConsole: effect(win("ClosePseudoConsole")),

  // ── dynamic loading: the loaded code's calls are invisible ──
  dlopen: hole(man(3, "dlopen"), "loads code whose calls through dlsym'd pointers are not recorded"),
  dlsym: hole(man(3, "dlsym"), "hands out a function pointer whose calls are not recorded"),
  dlclose: local(man(3, "dlclose")),
  dlerror: local(man(3, "dlerror")),
  LoadLibraryA: hole(win("LoadLibraryA"), "loads code whose calls through GetProcAddress pointers are not recorded"),
  GetProcAddress: hole(win("GetProcAddress"), "hands out a function pointer whose calls are not recorded"),
  GetModuleHandleA: local(win("GetModuleHandleA")),
  FreeLibrary: local(win("FreeLibrary")),

  // ── SQLite: the library does its own file IO, so every call is recorded and a replay
  // needs no database at all; handles are synthetic under replay, like descriptors ──
  sqlite3_open: input(sqlite("open"), { in: ["filename"], out: ["db[8]"] }),
  sqlite3_close: effect(sqlite("close")),
  sqlite3_close_v2: effect(sqlite("close")),
  sqlite3_exec: effect(sqlite("exec"), { in: ["sql"], out: ["errmsg[deep]"] }),
  sqlite3_prepare_v2: input(sqlite("prepare"), { in: ["sql"], out: ["stmt[8]", "tail[deep]"] }),
  sqlite3_step: input(sqlite("step")),
  sqlite3_reset: effect(sqlite("reset")),
  sqlite3_finalize: effect(sqlite("finalize")),
  sqlite3_bind_int: effect(sqlite("bind_blob")),
  sqlite3_bind_int64: effect(sqlite("bind_blob")),
  sqlite3_bind_double: effect(sqlite("bind_blob")),
  sqlite3_bind_null: effect(sqlite("bind_blob")),
  sqlite3_bind_text: effect(sqlite("bind_blob"), { in: ["text"] }),
  sqlite3_column_count: input(sqlite("column_count")),
  sqlite3_column_type: input(sqlite("column_blob")),
  sqlite3_column_int: input(sqlite("column_blob")),
  sqlite3_column_int64: input(sqlite("column_blob")),
  sqlite3_column_double: input(sqlite("column_blob")),
  sqlite3_column_text: input(sqlite("column_blob"), { ret: "cstr" }),
  sqlite3_changes: input(sqlite("changes")),
  sqlite3_last_insert_rowid: input(sqlite("last_insert_rowid")),
  sqlite3_errmsg: input(sqlite("errcode"), { ret: "cstr" }),
};

/** The entry for `name` on `os`, with that target's overrides applied. */
export function externEffect(name: string, os?: string): ExternEffect | undefined {
  const e = Object.prototype.hasOwnProperty.call(EXTERN_EFFECTS, name) ? EXTERN_EFFECTS[name] : undefined;
  if (!e) return undefined;
  const o = os ? e.os?.[os as ExternOs] : undefined;
  return o ? { ...e, ...o } : e;
}

// ── output spec grammar (shared with the `@records` attribute) ──

export type SizeSpec =
  | { tag: "bytes"; n: number }
  | { tag: "ret"; k: number }
  | { tag: "param"; name: string; k: number }
  | { tag: "deref"; name: string; k: number }
  | { tag: "cstr"; cap?: SizeSpec }
  | { tag: "sizeof"; ctype: string }
  | { tag: "deep" };

export interface OutSpec { param: string; size: SizeSpec }

function parseSize(s: string): SizeSpec | string {
  s = s.trim();
  if (s === "deep") return { tag: "deep" };
  if (s === "cstr") return { tag: "cstr" };
  if (s.startsWith("cstr:")) {
    const cap = parseSize(s.slice(5));
    if (typeof cap === "string") return cap;
    return { tag: "cstr", cap };
  }
  const so = s.match(/^sizeof\((.+)\)$/);
  if (so) return { tag: "sizeof", ctype: so[1].trim() };
  if (/^\d+$/.test(s)) return { tag: "bytes", n: Number(s) };
  const m = s.match(/^(?:(\d+)\*)?(\*)?([A-Za-z_]\w*)$/);
  if (!m) return `cannot read the size '${s}'`;
  const k = m[1] ? Number(m[1]) : 1;
  if (m[3] === "ret" && !m[2]) return { tag: "ret", k };
  return m[2] ? { tag: "deref", name: m[3], k } : { tag: "param", name: m[3], k };
}

/** `buf[ret]` → { param: "buf", size: ret }, or an error message. */
export function parseOutSpec(spec: string): OutSpec | string {
  const m = spec.trim().match(/^([A-Za-z_]\w*)\[(.+)\]$/);
  if (!m) return `'${spec}' is not '<param>[<size>]'`;
  const size = parseSize(m[2]);
  if (typeof size === "string") return size;
  return { param: m[1], size };
}

/** A C type's size on a target, or undefined when the table has none. */
export function cTypeSize(ctype: string, os: string, arch: string): number | undefined {
  const row = SIZES[ctype];
  if (!row) return undefined;
  return row[`${os}-${arch}`] ?? row[os];
}
