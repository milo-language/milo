# Standard Library

Import modules with `from "std/<name>" import { symbols }`.

Most utilities are **namespaced**: call a static on the namespace (`Path.join`, `Json.parse`,
`Math.sqrt`) or a method on the value (`s.trim()`, `dt.format()`).

## I/O & Filesystem

| Module | What it provides |
|--------|-----------------|
| [`std/io`](io) | `readStdin`, `writeStdout`, `File.openRead`/`.openWrite`/`.openAppend`, `f.readAll()`, `f.writeAll()`, RAII file handles |
| [`std/fs`](fs) | `readFile`, `readLines`, `readDir`, `fileInfo`, `isDir`/`isFile`, `pathExists`, `writeFile` |
| [`std/path`](path) | `Path.join`, `Path.basename`, `Path.dirname`, `Path.ext`, `Path.stem` |
| [`std/env`](env) | `Env.get`, `Env.getOr` |

## Networking

| Module | What it provides |
|--------|-----------------|
| [`std/net`](net) | TCP, DNS |
| [`std/fetch`](fetch) | HTTP client: `fetch`, `fetchWith`, redirects, and the TLS client socket `TlsStream` |
| [`std/tls`](tls) | TLS server transport: `TlsListener.bind`, `accept` |
| [`std/https`](https) | HTTPS server: `serveTls`, `serveRouterTls` |
| [`std/ws`](ws) | WebSocket client and server: `wsAccept`, `wsConnect`, `WsConn` |
| [`std/unix`](unix) | Unix-domain sockets: `UnixListener`, `UnixStream` |
| [`std/http`](http) | HTTP server with Hono-style router, context, middleware |
| [`std/httpmw`](httpmw) | Optional HTTP middleware: `gzip`, `verifyBearer` |
| [`std/html`](html) | HTML escaping — `Html.escapeText`, `Html.escapeAttr`, `Html.isSafeUrl` |
| [`std/mime`](mime) | Media types by extension — `Mime.fromPath`, `Mime.contentType` |
| [`std/multipart`](multipart) | `multipart/form-data` parsing — `Multipart.parse`, `Part.safeFilename` |

## Data

| Module | What it provides |
|--------|-----------------|
| [`std/json`](json) | Zero-copy JSON parser: `Json.parse`, keyed accessors (`.str()`, `.i64()`, `.f64()`, `.bool()`). Serializing a struct is the built-in `jsonStringify`, no import |
| [`std/arena`](arena) | Generational arena for cyclic/graph data with safe `Handle<T>`; the how-to is [Patterns](/language/patterns#build-a-tree-or-graph-whose-nodes-refer-to-each-other) |
| [`std/set`](set) | `HashSet<T>` — `s.add`, `s.contains`, `s.remove` |

## CLI & System

| Module | What it provides |
|--------|-----------------|
| [`std/argparse`](argparse) | CLI argument parsing with typed getters and `--help` generation |
| [`std/args`](args) | Raw CLI arguments — `args()`, `getFlag`, `hasFlag` |
| [`std/process`](process) | Command execution, `Process.spawn`/`.wait()`/`.signal()`, `run`, `capture` |
| [`std/signal`](signal) | POSIX signal handling — `onSignal`, `ignoreSignal` |
| [`std/term`](term) | Terminal raw mode and size: `enableRawMode`, `terminalSize` |
| [`std/keys`](keys) | Decode terminal input bytes into keys: `decodeKey`, `KeyCode` |
| [`std/ansi`](ansi) | Cursor, screen and 256/24-bit color escapes: `Ansi.cursorTo`, `Ansi.fg256` |
| [`std/pty`](pty) | Pseudoterminals: `Pty.open`, `openAndSpawn` |
| [`std/sysinfo`](sysinfo) | Host and process info: `hostname`, `cpuCount`, `totalMem`, `cwd` |
| [`std/environ`](environ) | The whole environment: `envVars` |
| [`std/os`](os) | Typed libc bindings the rest of std is built on |
| [`std/dl`](dl) | Load shared libraries at run time: `dlOpen`, `Lib.sym` |

## Data Formats

| Module | What it provides |
|--------|-----------------|
| [`std/csv`](csv) | CSV parsing with header support — `Csv.parse`, `Csv.stringify` |
| [`std/base64`](base64) | Base64 encode/decode — `Base64.encode`, `Base64.decode` |
| [`std/hex`](hex) | Hex encode/decode — `Hex.encode`, `Hex.decode` |
| [`std/binary`](binary) | Fixed-width int/float codecs — `Bytes.readU32Le`, `Bytes.writeI16Be`, both byte orders |
| [`std/png`](png) | PNG encode/decode: `Png.encode`, `Png.decode` |

## Date, Time & IDs

| Module | What it provides |
|--------|-----------------|
| [`std/time`](time) | Wall clock, elapsed time, `Duration` arithmetic/parse/format, sleep |
| [`std/timer`](timer) | `Timer`, `Ticker`, `recvTimeout`, `waitReadable`/`waitWritable` |
| [`std/datetime`](datetime) | Date/time — `DateTime.now`/`.fromEpoch`, then `dt.format()`, `weekdayName` |
| [`std/uuid`](uuid) | UUIDs — `Uuid.v4`, `Uuid.v7`, `Uuid.parse` |

## Concurrency

| Module | What it provides |
|--------|-----------------|
| [`std/runtime`](runtime) | `Task.spawn`, `Promise` / `Promise.blocking`, green scheduler |
| [`std/event`](event) | kqueue/epoll/IOCP readiness polling — the layer `std/runtime` drives |
| [`std/sync`](sync) | `Channel`, `WaitGroup`, `AtomicI64`, `AtomicBool` — all method-based |
| [`std/select`](select) | Wait on the first ready channel, fd or timeout: `Select` |
| [`std/shard`](shard) | `parallelMap`, `parallelScanStr` — divide a buffer's ownership across cores, no copy, nothing shared |

## Database & Network

| Module | What it provides |
|--------|-----------------|
| [`std/sqlite`](sqlite) | SQLite3 bindings — `dbOpen`, `dbQuery`, `dbExec`, prepared statements |
| [`std/url`](url) | URL parsing — `Url.parse`, then `u.queryGet`, `u.toString` |

## Strings & Formatting

| Module | What it provides |
|--------|-----------------|
| [`std/string`](string) | String **methods** — `s.contains`, `s.split`, `s.replace`, `s.trim`, case conversion |
| [`std/seal`](seal) | `Sealed` — freeze a string so stored `Span`s can never be invalidated |
| [`std/fmt`](fmt) | Template formatting (`fmt1`–`fmt4`), `padLeft`/`padRight`, `join` |
| [`std/strconv`](strconv) | `parseInt`, `parseFloat`, `parseBool`, radix conversions, `formatFloat`, `quoteString`/`unquoteString` |
| [`std/unicode`](unicode) | UTF-8 decoding, code points, display width: `codepoints`, `displayWidth` |

## Math & Random

| Module | What it provides |
|--------|-----------------|
| [`std/math`](math) | `Math.abs`, `Math.min`, `Math.max`, `Math.pow`, `Math.sqrt`, `Math.log`, trig |
| [`std/random`](random) | `Random.int`, `Random.float`, `Random.range`, `Random.shuffleI64` |
| [`std/rng`](rng) | Seedable, reproducible generator: `Rng.new(seed)` |

## Utilities

| Module | What it provides |
|--------|-----------------|
| [`std/color`](color) | SGR text styling — `Color.red`, `Color.green`, `Color.bold`, etc. |
| [`std/regex`](regex) | Regular expression matching — `Regex.compile`, `.isMatch`, `.find` |
| [`std/sort`](sort) | Sorting for Vec — `sortI32`, `sortI64`, `sortStrings` |
| [`std/testing`](testing) | `assert`, `assertEqual`, `assertStrEqual` |
| [`std/log`](log) | Leveled structured logging — `Log`, `Logger`, `LogLevel`, `LogFormat` |
| [`std/mem`](mem) | `mmapAnon`, `mmapFile`, `Bump` bump allocator |
| [`std/pool`](pool) | Fixed-size block pool allocator: `Pool` |
| [`std/foreign`](foreign) | Borrow and adopt foreign memory: `withRaw`, `adopt` |
| [`std/cstr`](cstr) | NUL-terminated C string view: `CStr.wrap` |
| [`std/smt`](smt) | The QF_LIA decision procedure behind `milo prove` |
| [`std/prelude`](prelude) | Auto-imported: `Error`, `Unit`, `ErrorContext` |

## Cryptography

OpenSSL-backed hashing plus pure-Milo hashing, MAC, and token modules (no C codec dependency; constant-time and WCET-analyzable).

| Module | What it provides |
|--------|-----------------|
| [`std/crypto`](crypto) | `Crypto.sha256`, `Crypto.sha1`, `Crypto.md5`, and `Crypto.aesGcmEncrypt`/`.aesGcmDecrypt` (128/256-bit AES-GCM) |
| [`std/sha256`](sha256) | Pure-Milo SHA-256 — `Sha256.hash`, `Sha256.bytes` |
| [`std/sha512`](sha512) | Pure-Milo SHA-512 / SHA-384 — `Sha512.hash`, `Sha384.bytes` |
| [`std/sha1`](sha1) | Pure-Milo SHA-1 — `Sha1.hash`, `Sha1.bytes` |
| [`std/hmac`](hmac) | HMAC-SHA256 / 384 / 512 / SHA-1 — `Hmac.sha256`, `Hmac.sha512Bytes` |
| [`std/subtle`](subtle) | Constant-time comparison — `constantTimeEq` |
| [`std/hkdf`](hkdf) | HKDF extract-and-expand (RFC 5869) — `Hkdf.sha256` |
| [`std/pbkdf2`](pbkdf2) | Password-based KDF (RFC 8018) — `Pbkdf2.sha256` |
| [`std/jwt`](jwt) | JWT sign/verify (HS256/384/512) with claim validation — `Jwt.signHS256`, `Jwt.verifyHS256`, `JwtVerifier` |
| [`std/totp`](totp) | RFC 6238 TOTP / RFC 4226 HOTP one-time passwords — `Totp.generate`, `Totp.hotp` |
| [`std/base32`](base32) | Base32 encode/decode (RFC 4648) — `Base32.encode`, `Base32.decode` |

## Compression

Pure-Milo DEFLATE (RFC 1951) and the gzip / zlib / zip containers built on it.

| Module | What it provides |
|--------|-----------------|
| [`std/deflate`](deflate) | Compress — `Deflate.raw`, `Deflate.gzip`, `Deflate.zlib` |
| [`std/inflate`](inflate) | Decompress — `Inflate.raw`, `Inflate.gzip`, `Inflate.zlib` |
| [`std/zip`](zip) | Read ZIP archives — `Zip.read` (`.zip`/`.jar`/`.epub`/`.docx`) |
| [`std/zstd`](zstd) | Zstandard: `Zstd.compress`, `Zstd.decompress` |
| [`std/checksum`](checksum) | CRC-32 and Adler-32: `Checksum.crc32` |
| [`std/xxhash`](xxhash) | XXH64: `Xxhash.hash64` |
