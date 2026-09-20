<!-- doc-meta
system: stdlib
purpose: action-item tracker for the 2026-08-03 stdlib audit (Milo vs Go/Rust/Node); each box is a fix in flight
key-files: std/*.milo, src/suggest.ts (builtin member tables), src/checker.ts, docs/stdlib-design.md, docs/stdlib-coherence-migration.md
update-when: an item's fix lands (check the box), a finding is refuted (delete it and say why), or a new one is triaged
last-verified: 2026-08-03 (initial sweep: all 67 modules via `milo api --module`, plus the builtin surface in src/suggest.ts; behavioral claims probed against a live build)
-->

# stdlib audit — 2026-08-03

Comparative sweep of `std/` (67 modules, ~26k LOC) plus the builtin container surface,
against Go's stdlib, Rust's `std` + the de-facto crate set, and Node's core modules.

**Breadth is not the problem.** zstd, PNG, TLS client, WebSocket, PTY, SQLite, regex and
JWT are all present, which beats Go's and Rust's *core* libraries outright. What the sweep
found is **five unresolved conventions running side by side**, plus a short list of gaps
that are semantic rather than cosmetic.

**Verify before working an entry.** Findings are written from a point-in-time probe and rot
as code lands. Every behavioral claim below has its probe recorded — re-run it before
starting, and correct the entry when it lies.

**This file ranks by convention violation, not by use — weigh that yourself.** An in-repo
consumer count (excluding each module's own fixtures) puts these at **zero**: `base32`, `dl`,
`environ`, `keys`, `pool`, `sqlite`, `testing`, `toml`, `unix`, `url`, `zip`, `zstd`; and these
at **one**: `csv`, `cstr`, `httpmw`, `log`, `set`, `sha1`, `smt`, `sort`, `totp`, `uuid`. It is
a weak signal — std exists for users, not this repo, and the sibling repos (emulators, milojs,
yaml, dapweb) consume some of these — but it is the only dogfooding evidence available. So the
Tier 5 "sharpest case" (`std/unix` and `std/net` disagreeing on error types) is a fight between
a module with no callers and one with several. Prefer items that block programs from being
written (struct⇄JSON, `Reader`/`Writer`, UDP, timers, enumerable `HashSet`) over convention debt
in modules nobody calls.

**`std/csv` is explicitly parked** (decision 2026-08-03). One consumer, its own fixture. Not
worth extracting to a package, not worth further investment; it stays where it is at whatever
state the Tier 1 decoder pass leaves it. Do not re-propose work on it.

**Checked items stay** with a one-line note on what landed (unlike `backlog.md`, where
shipped entries are deleted). This file is a record of a single audit, not a live queue.

---

## Tier 1 — correctness. Cheap, and they change the language's character

- [x] **`"…".parseInt()` / `.parseF64()` silently return junk.** *Landed b46ce593: both builtins
  return `Option<T>`, strict + range-checked; `strconv.parseInt`/`parseFloat` now forward to them
  (one parser); redeclaring builtin `Option`/`Result` is now a checker error. Also fixed a
  pre-existing read-past-the-view in `parseF64` on `&string` views.* Probed: `"42x".parseInt()`
  → `42`; `"abc".parseF64()` → `0`, indistinguishable from a real `0`. Meanwhile
  `strconv.parseInt` returns `Option<i64>`. Two parsers, opposite failure models, and the
  builtin — the spelling everyone reaches for first — is the JS `parseInt` wart. Go returns
  `(int, error)`, Rust returns `Result`. This contradicts the ethos memo directly
  (*total by default, weird is opt-in*): the total-**looking** spelling is the lossy one.
  Breaking change; worth it. Ref: `src/checker.ts` (`method === "parseInt"` / `"parseF64"`),
  `std/strconv.milo`.

- [x] **Decoders that cannot report failure.** *All four now return `Result` with a byte offset.
  Probed pre-fix: `Base64.decode("!!!!")` → 3 NUL bytes; `Base32.decode("MZXW6YT1")` → `"foob"`,
  a silently shortened secret; `Csv.parse` on an unterminated quote swallowed the rest of the
  file into one field. `Base64.decode` no longer accepts whitespace (MIME/PEM never worked — it
  decoded `\n` as symbol 0); `Base32.decodeLoose` keeps the pasted-authenticator-secret case
  under a name that advertises it. `Hex`'s `pub _hexVal` footgun removed. New `Base64.urlDecode`
  — `urlEncode` had no inverse. Ragged CSV rows deliberately still accepted (not a syntax error;
  indexing already bounds-checks). Note: the audit's implication that `std/jwt` base64url-decodes
  is **false** — jwt only encodes and verifies by recompute.* Original finding:
  `Base64.decode`, `Base32.decode`, `Hex.decode`
  return bare `string`; `Csv.parse` returns `Vec<Vec<string>>`. Malformed input yields
  garbage with no signal — an auth header that fails to decode becomes a plausible-looking
  string. Go returns `([]byte, error)`, Rust returns `Result`. Should be `Result` on all four.
  Ref: `std/base64.milo`, `std/base32.milo`, `std/hex.milo`, `std/csv.milo`.

- [x] **"Absent" collapses into "empty" across the HTTP stack.** *All eight accessors now return
  `Option<string>`; `?foo=` is `Some("")` and a missing `?foo` is `None`. `fetch.hasHeader`
  deleted — it existed **only** because `findHeader` couldn't answer this, and said so in its own
  doc comment. Found and fixed a latent bug the conflation had been hiding: `findHeader` missed a
  value-less header at the end of a block (`"A: b\r\nX-Empty:"` read as absent). No `queryOr`
  family added — `??` is the collapse spelling (`unwrapOr` is Copy-only, so `.unwrapOr("")` does
  not compile on `Option<string>`). Two follow-ups left behind: `std/ws` has a **third** private
  copy of header lookup returning bare `string`. (The second follow-up — `std/http`'s `Response`
  enum colliding with `std/fetch`'s `Response` struct in the flat namespace, so no file could
  import both — is fixed: the client struct is now `FetchResponse`.)*
  Original finding: `Context.query/param/header/cookie`,
  `fetch.findHeader`, `Response.header` and `ParsedArgs.getString` all return bare `string`.
  Milo *has* `Option` and `Env.get` already uses it — so the same concept has two answers in
  one stdlib. Rust returns `Option`, Node returns `undefined`; only Go shares this wart, and
  Go regrets it. Ref: `std/http.milo`, `std/fetch.milo`, `std/argparse.milo`.

- [x] **`Option` and `Result` are asymmetric, and it is damaging `std/json`.** *Closed by
  adding `Option.andThen`, `Option.orElse`, `Result.unwrapOrElse` and `Result.orElse`. The
  two surfaces are now identical on the seven shared combinators; `mapErr` stays Result-only
  because `None` carries no payload to map. `Result.unwrapOrElse` takes the error (`&E`),
  Option's takes nothing — the one asymmetry that reflects a real difference between the
  types. **Declined:** `ok()`/`err()` (they discard the other variant's payload, which with
  no GC must be dropped — a combinator that silently frees half its input is wrong;
  `match` stays the conversion), `okOr()` (`let else` does it already, without `unwrapOr`'s
  Copy gate), `expect()` (`!` plus a message, but it loads the payload out, so it would be
  rejected on exactly the owned payloads where `!` works), `filter()` (one-sided, no Result
  analogue, and it forwards the payload so it would consume a non-Copy receiver — `match`
  is clearer). **Audit corrections, both to this entry's own claims:** (1) "half of
  `json.milo`'s public surface becomes deletable" was wrong — the real number is **10 of
  `Json`'s 49 methods (20%)**: `strAt`/`i64At`/`f64At`/`boolAt`/`getAt` and
  `childStrAt`/`childI64At`/`childF64At`/`childBoolAt`/`childLen`, all deleted. The other
  families are not navigation-shape combinatorics and stay. (2) `andThen` alone is not what
  made them deletable — the zero-copy cursor API (`curField`/`curChild`/`curStr`, added after
  those accessors) already covered every shape at zero allocation. `andThen` supplies the
  readable owned-value spelling and, more importantly, removes the pressure to keep adding
  shapes, which is the actual wart: there is no `childChildStrAt`, so anything 3 deep already
  had to leave the family. Also closed a pre-existing leak found on the way: `Option.map` over
  a temporary receiver (`doc.get(k).map(f)`) never dropped the receiver's payload — 400 B per
  hop for a 23-byte document. Ref: `src/suggest.ts OPTION_MEMBERS`/`RESULT_MEMBERS`,
  `docs/language-reference.md` §Option Combinators.*

  **Top follow-up: that leak fix is deliberately partial, and unpredictably so.** It covers
  `map`/`andThen` only (gated on `optionOpDropsReceiver`) — the two whose result provably shares
  no buffer with the receiver. `orElse` and every `Result` combinator forward a payload, so
  dropping there would double-free; they still leak an owned temporary. Narrow was the right call
  under time pressure (a double-free is a safety bug, a leak is not), but the result is one
  combinator clean and its neighbour not, with no rule a reader could infer. **Finish it.**

  Two smaller sharp edges, both pre-existing and both shared with already-shipped `mapErr`: an
  explicitly-typed by-value callback param (`(e: string) => …`) bypasses the `&E` hint on every
  error-side combinator, and `?? <owned>` into `print` leaks the collapsed string.
  ```
  Option: isSome isNone unwrapOr unwrapOrElse map
  Result: isOk   isErr  unwrapOr               map mapErr andThen
  ```
  `Option` has `unwrapOrElse` but **no `andThen`**; `Result` has `andThen` but **no
  `unwrapOrElse`**. Neither has `ok()`/`err()`/`okOr()`/`filter()`/`orElse()`/`expect()`.
  Not cosmetic: missing `Option.andThen` is *why* `std/json` carries ~20 accessor variants —
  `Json.get`/`at`/`path` all return `Option<Json>` but cannot be chained, so every navigation
  shape needs a bespoke method. Add `andThen` and half of `json.milo`'s public surface becomes
  deletable.

- [x] **JWT verification does not validate claims.** *`verifyHS256/384/512` now return
  `Result<JwtClaims, JwtError>` — 10 variants, no `Other(string)` catch-all — validating
  `exp`/`nbf`/`iat` with 60 s leeway, plus a `JwtVerifier` builder for `aud`/`iss`/fixed clock/
  `requireExpiry`. Algorithm comes from the verifier, never the token, so algorithm confusion is
  `UnsupportedAlg`. Signature compared constant-time on raw bytes, and a **non-canonical
  base64url signature** (same MAC, different token text — walks past a replay blocklist) is now
  rejected. Verified against RFC 7515 A.1's literal token. **Audit correction:** `alg: none` was
  already rejected, but incidentally — the old code recomputed the MAC over the token's own
  header bytes; nothing checked `alg`, so an HS512 token would have verified as HS256.* `Jwt.verifyHS256(token, secret) -> bool`
  checks the signature and nothing else — no `exp`, no `nbf`, no `aud`, and no way to read the
  payload at all. Every user writing `if Jwt.verifyHS256(…)` accepts expired tokens forever.
  `httpmw.verifyBearer` inherits it. HS256 is also the only algorithm. Ref: `std/jwt.milo`,
  `std/httpmw.milo`.

- [x] **No constant-time comparison.** *`std/subtle.constantTimeEq` (own module so "I'm comparing
  a secret" shows at the import line), `std/sha512` (Sha512+Sha384), `std/hkdf` (RFC 5869),
  `std/pbkdf2` (RFC 8018), `Hmac.sha384Bytes`/`sha512Bytes`, `Totp.verify`. All verified against
  published vectors (FIPS 180-4, RFC 4231, 5869, 6070, 7914), cross-checked against Python
  hashlib. A correct `constEq` already existed inside `std/jwt` but was unexported — every other
  user was on their own. **bcrypt/argon2/scrypt deliberately declined**: eksblowfish, the
  `$2a`/`$2b` sign-extension bug, 72-byte truncation, and memory-hard cores all weaken silently
  when wrong, and a wrong password hash is worse than none. PBKDF2 is the answer, documented with
  OWASP iteration floors and its honest weakness (compute-hard, not memory-hard).* Ships HMAC, JWT and AES-GCM, but `constantTimeEq` does
  not exist — so every user-written MAC check will be `==`. Also missing: sha512, HKDF,
  PBKDF2/bcrypt/argon2. A stdlib with an HTTP server, cookies and JWT has no password hashing.
  Ref: `std/crypto.milo`, `std/hmac.milo`.

---

## Tier 2 — the architectural one

- [x] **No `Reader`/`Writer` abstraction.** *Shipped in `std/io`: `trait Reader { read(max) }`
  and `trait Writer { write(data); flush() }`, both over `IoError`. Traits, not `interface`s —
  an interface value is a fat pointer that has to be stored somewhere, and second-class
  references make a stored `&Reader` inexpressible, so the wrapper owns its source instead:
  `BufReader<File>` is a real struct containing a real `File`. Adapters: `FdStream` (a
  non-owning view of any descriptor, with the socket/CRT-fd split Windows needs),
  `BytesReader`/`BytesWriter` (in-memory), `File` itself (both traits), and
  `TcpStream.stream()`. `BufReader<R>` gives `readByte`/`readLine`/`readUntil`/`readExact`/
  `readAll` over one syscall per 64 KiB; `BufWriter<W>` buffers and **flushes on drop** —
  unflushed bytes are never silently lost, and a failed drop-flush goes to stderr rather
  than nowhere. Both re-implement their own trait, so they stack. `copyStream(src, dst)` is
  the pipe. `File` also grew `read(n)`/`seek`/`tell`/`close`/`rawFd`/`stream`, closing the
  streaming-file-IO half of this item. Two compiler fixes came with it: a trait bound on a
  generic struct's type param (`struct BufReader<R: Reader>`) was parsed and thrown away —
  it is now enforced, with the bodies of a violating instantiation suppressed so the one
  useful error is not buried under "type 'i64' has no method 'read'" pointing inside std;
  and the formatter emitted `fn f < T: Bound > (...)` for any bounded type param. NOT done,
  and still worth doing: `TlsStream`, `Child`, `WsConn`, and `deflate`/`inflate` are
  unretrofitted — TLS needs an SSL_read-aware adapter rather than an fd one.*

  **`FdStream` is an unchecked lifetime, and it is the weakest part of this change.** Verified
  by probe: `BufReader<FdStream>.new(File.openRead(p)!.stream())` compiles and then reads a
  **closed** descriptor — EBADF today, but with fd reuse it would silently read a different
  file. The compiler cannot help: a descriptor is an integer, not a reference, so nothing ties
  the stream's life to the `File` it came from. Mitigated, not closed — `File` and `TcpStream`
  implement the traits directly so the owning form is available and preferred, the doc comment
  puts the broken spelling next to the correct one, and the error names the fd. Same hazard
  class as the pre-existing `rawFd()` / `fdChannel(fd)` / `FdReader`, so this widens an existing
  hole rather than opening a new one.

  Also honest: **there are now three ways to read a file** — `fs.readFile`, `File.readAll`,
  `BufReader<File>` — and this item's own complaint was too many shapes. The new one is the only
  *streaming* one; the two slurps were left un-deduplicated.

  Constructors were turbofish (`BufReader<FdStream>.new(...)`) because bare `Type.new()` on a
  generic struct was the known Tier-1 backlog gap. **Closed 2026-08-16**: the type arguments are
  now inferred from the argument types, so `BufReader.new(f)` compiles. The turbofish still
  resolves the same call, and is still required where no argument mentions the parameter
  (`HashSet.new()`), which the hint continues to teach. Free-function constructors
  were rejected — they would permanently violate the constructors-live-on-the-type convention to
  work around a temporary hole.

  Original finding: Go's `io.Reader`/`io.Writer` and Rust's
  `Read`/`Write` are the spine their stdlibs hang on. Milo has interfaces *and* traits and
  uses neither here. Every source has a bespoke shape:
  ```
  File.readAll()          TcpStream.recv()        Child.readStdout(ptr, len)
  FdReader.readByte()     TlsStream.recv()        WsConn.recv()
  ```
  Three consequences, each independently worth fixing:
  - **No buffering.** `FdReader.readByte` is literally one `read(2)` syscall per byte
    (`std/io.milo:178`). `bufio` exists in Go for exactly this. Anyone writing a parser over
    a pipe hits it.
  - **No streaming file IO.** `File` is `openRead`/`openWrite`/`openAppend`/`readAll`/`size`/
    `writeAll` — no `read(n)`, no `seek`, no `close`, no `flush`, no line iteration. Every file
    read slurps whole; a 4 GB file has no API. `fs.readFile` duplicates the slurp from the other
    direction.
  - **Nothing composes.** Can't gzip-wrap a socket, tee a stream, or hash while copying. It is
    also why `std/deflate` (compress) and `std/inflate` (decompress) are split across modules
    when Go and Rust unify them behind Reader/Writer.

  Retrofit order once the interfaces exist: `File`, `TcpStream`, `TlsStream`, `Child`,
  `deflate`/`inflate`. Everything downstream composes after this.

---

## Tier 3 — hard gaps vs Go / Rust / Node

Ranked by how often real programs hit them.

- [ ] **No UDP.** Zero `SOCK_DGRAM` anywhere in `std/` (grepped). Go `net.UDPConn`, Rust
  `UdpSocket`, Node `dgram`. Blocks DNS, QUIC, game netcode, syslog, mDNS.

- [x] **No struct ⇄ JSON.** *`@derive(Json)` shipped — `toJson` / `fromJson` /
  `fromJsonNode`, typed `JsonError` (Syntax / Missing / Mismatch) carrying a dotted path
  built bottom-up so a correct decode allocates none. Covers scalars, payload-free enums,
  `Option`, `Vec`, nested derived structs, all nesting freely, plus `@json("wire_name")`
  renaming. The derive emits Milo **source** which the checker parses back, so generated
  code obeys exactly the rules hand-written code does. Hand-written `toJson`/`fromJsonNode`
  satisfy the nested-field requirement, so a type with a non-object wire form is still
  embeddable. The `json`-named-method hack is retained but retargeted: a struct with a
  codec routes through `toJson`, and the built-in fallback now **errors** on a field it
  cannot serialize (it used to emit `"tags":` with no value — silently invalid JSON) and no
  longer accepts scalars, which crashed codegen. Three latent std/json bugs fixed on the way:
  `nope` parsed as `null` (bare literals were accepted on their first byte alone), integer
  reads went through the parser's f64 so anything past 2^53 was silently truncated and `1.5`
  read as `1` (now exact, re-scanning the literal's source span; `curUint` added for the top
  half of u64), and `Json.i64` on a fractional value now answers `None` — `std/jwt`'s
  `exp`/`nbf`/`iat` read as f64 because RFC 7519 NumericDate permits a fraction.
  Deliberately out: `HashMap` fields (needs cursor key enumeration), payload-carrying enums
  (no encoding the derive is entitled to pick), serde-style `default`, deny-unknown-keys.
  `Option<Option<T>>` is **rejected**, not supported: `Some(None)` and an absent field both
  encode as `null`, so it cannot round-trip — serde has the same hole, and refusing beats
  collapsing.*

  **Two hazards inherent to the design, worth knowing before leaning on it:** the derive
  turns private field *names* into a wire contract, and renaming one changes the wire format
  with no diagnostic (`@json` is the escape hatch, but you have to remember to reach for it).
  And "absent = `None`" is a silent default, so a typo in a `@json` rename on an `Option`
  field decodes to `None` forever rather than failing. Both are how every derive-based codec
  works; neither is visible at the call site.

- [x] **No binary / byte-order helpers.** *`std/binary` shipped — `Bytes` namespace, 37 methods:
  `read`/`write` × u8/i8/{u,i}{16,32,64} × Le/Be, f32/f64, plus `Bytes.has`. Out-of-bounds is
  `Option.None`, not a trap: `src[i]` is a programmer's claim about a position, but a decode at
  an offset that came out of the untrusted data is ordinary truncation. No cursor type — second-class
  refs mean a cursor can't hold the buffer, so it degrades to passing `(pos, src)` anyway.
  Migrated `std/zip` (13 header fields read at archive-supplied offsets with **no bounds check** —
  a truncated `.docx` killed the process from inside a function whose type promised `Result`) and
  `std/png`. Two audit details were stale: `examples/emulators/` has moved to its own repo, and
  the hand-rolling was worse inside `std/` than in `examples/`.*

- [x] **No child-process env or cwd, and no `setenv` at all.** *`Command` shipped on both
  arms: `new/arg/args/dir/env/envRemove/envClear/stdin/stdout/stderr/spawn`, with a `Stdio`
  enum (`Pipe`/`Inherit`/`Null`/`Merge`/`Read`/`Write`/`Append`). `mergeStderr` is folded in
  as `Stdio.Merge`, and `Child.spawn(program, args, mergeStderr)` is now a three-line shim
  over it — one spawn implementation, not two. Direction-specific variants pointed at the
  wrong stream are a spawn error naming the stream, and no child is created. `Env.set` /
  `Env.remove` mutate the process's own environment, with the libc thread-safety limit
  stated in the doc comment rather than papered over. New platform seam:
  `envSet`/`envUnset`/`environBlock`/`execvpWithEnv` (macOS has no execvpe, Windows has
  neither setenv nor unsetenv, and Linux's `environ` needed a dlsym because Milo has no
  extern-variable syntax — `/proc/self/environ` is frozen at exec and would have gone stale
  the moment `Env.set` ran). Found and fixed alongside: the Windows arm's `read`/`write`/
  `close` handed a negative fd to the UCRT, whose invalid-parameter handler kills the
  process where POSIX returns -1. Also fixed: `std/environ` on Linux read `/proc/self/environ`,
  which is **frozen at exec** — harmless before, a lie the moment `Env.set` exists. **Deliberately
  not shipped**: `detached`/`setsid`, and `output()`/`status()` convenience runners.*

  **Design debt shipped with it — one `Stdio` enum can spell states the operation rejects.**
  `stdin(Stdio.Merge)` and `stdout(Stdio.Read)` type-check and fail at *runtime*. That is
  structurally the same wart Tier 1 of this audit is deleting — the total-**looking** spelling
  being the lossy one — just moved up a level. Three direction-specific enums, or `Stdio::from(File)`
  once a `File` can be moved into a `Command`, would make it a compile error; the latter is the
  better follow-up because it deletes `Read`/`Write`/`Append` outright. Mitigated for now by an
  error that names the stream and creates no child. Related: the new `requires` contracts on
  `writeStdin`/`readStdout` only fire in `--debug`, so in release a read of a redirected-away
  stream is still a silent -1. Original finding: `Child.spawn(program, args,
  mergeStderr)` is the whole surface (`std/process.milo:109`) — no cwd, no env, no stdio
  redirection, no detached. And `setenv`/`putenv` appear nowhere in `std/`, so a program cannot
  mutate even its own environment. Go `exec.Cmd{Dir,Env}`, Rust `Command::env/current_dir`,
  Node `spawn(opts)`.

- [x] **`Duration` is read-only; no timers, tickers or timeouts.** *`Duration` is now i64
  nanoseconds (±292.47 years, documented range; construction/arithmetic past it traps like
  any other checked i64 overflow) with `+`/`-` via the Add/Sub traits, `==` via
  `@derive(Eq)`, `times`/`dividedBy`/`ratio`/`negated`/`abs`, `compare`/`isLess`/
  `isGreater`, eight constructors (`zero`/`nanos`/`micros`/`millis`/`secs`/`mins`/`hours`/
  `days`), `toNanos`…`toHours` plus `toSecsF64`/`toMillisF64`, Go-style `toString`
  ("1h30m0s", "1.5ms") and `Duration.parse` → `Option` (ns/us/µs/ms/s/m/h/d, fractions,
  sign; overflow is None, never an abort — it takes untrusted text). The three free
  `durationSecs`/`Millis`/`Micros` accessors are **removed** in favor of methods.
  New `std/timer`: `Timer.after`, `Ticker.every` (one-slot buffer, ticks dropped not
  queued, Drop cancels the task), `recvTimeout<T>`, `waitReadable`/`waitWritable`.
  All of it is a layer over the existing green task + Channel + Select timer arm — no new
  runtime machinery. Two things fixed on the way: a green `sleepMs` **busy-yielded** the
  whole span (it now parks on a select timer arm, so the sleeper is off the run queue), and
  `sleepMs` truncated its `usleep` arg to u32 (silently short-slept past ~71 min). Every
  `std/timer` entry point calls `ensureTimersLive()` first, which closes the trap
  `std/select` documents — a timeout on a main context that never spawned a green task used
  to be armed and inert.* Left out: monotonic clock, `sendTimeout`, `context.Context`-style
  cancellation (its own audit entry), `Instant` arithmetic.

  **Two hazards shipped with it — fix before anyone builds on this:**
  1. **`sleepFor`'s resolution depends on invisible global state.** With no scheduler it is a
     `usleep` honoring microseconds; once *anything* in the process has spawned a green task,
     sub-millisecond spans round **up to 1 ms**. So `sleepFor(Duration.micros(100))` is 100 µs
     or 1 ms depending on whether an unrelated library spawned a task — a 10× timing swing by
     action at a distance, which is precisely what "guides you to correct programs" forbids. It
     is only *documented*, the weakest mitigation. Real fix: sub-millisecond deadlines in the
     event loop (it stores epoch ms today), a scheduler change.
  2. **One green task per timer**, each with a 1 MB reserved stack. A server arming a
     per-request timeout at 10k rps creates 10k tasks and nothing at the call site warns. Go
     multiplexes every timer onto one heap. `recvTimeout`/`waitReadable` are task-free select
     arms and are the correct hot-path answer, but the API does not say so loudly enough. Real
     fix: a timer wheel on the scheduler.

  Also open: `sleepMs` and `sleepFor` are now two spellings of one act (kept to avoid churning
  a dozen examples, but it is exactly the convention debt Tier 5 complains about); `toString`
  emits `"us"` where Go emits `"µs"` (parse accepts both); a `Ticker` drops ticks under a slow
  receiver, so counting ticks under-counts elapsed time — observable only because the tick
  carries its `Instant`.

- [ ] **No cancellation.** No `context.Context` analogue. `select.onTimeout(ms)` exists but
  nothing propagates cancellation down a call tree.

- [x] **No filesystem walk, glob, `mkdir -p`, `rm -rf`, or `copyFile`.** *Shipped in `std/fs`:
  `walkDir`, `globMatch`, `glob`, `mkdirAll`, `removeAll`, `copyFile`, `makeTempFile`.
  `walkDir` is eager (Vec of `WalkEntry`) — no lazy iterators, and every entry name is an owned
  string either way, so a cursor would save the result Vec and none of the syscalls. `globMatch`
  is pure and usable on any `/`-separated string; `**` is special only as a whole segment.
  `removeAll` never follows symlinks and stops at the first entry it cannot delete (not
  all-or-nothing — documented). Found and fixed on the way: `isSymlink` read the `S_IFLNK` bit
  out of `lstat` at an arch-specific `st_mode` offset, so it answered wrong on arm64 Linux — it
  now uses `readlink`, which is arch-independent. That bug would have made `removeAll` follow
  links there. `copyFile` cannot preserve mode verbatim for the same reason, so it propagates
  only the executable bit via `access(X_OK)`.*

  **Left live, and worth its own entry: `FileInfo.mode` is still wrong on arm64 Linux.** The
  `isSymlink` fix routed around the bad field rather than fixing it — `st_mode` sits at offset 24
  on x86_64 and 16 on arm64, while `std/platform` splits by **OS only**, with no arch axis. So
  `lstatInfo(p).mode` reads 0 on arm64 Linux and nothing warns. Any other `struct stat` field
  read at a fixed offset has the same defect. The real fix is an arch dimension in the platform
  split (or `@cLayout`-derived offsets), not another one-off.

  Two hazards shipped with it: **`walkDir`'s allocation is bounded by the filesystem, not the
  program** — `walkDir("/")` is an unbounded allocation with no signal, which on macOS is the
  failure mode the guard rules exist for; a `maxEntries` cap was considered and rejected (silent
  truncation is exactly what `readDir`'s `Result` exists to prevent, and erroring at a cap is a
  knob no caller can set correctly). And **the arm64 fix has no CI fence** — `test-linux` runners
  are x86_64, where old and new code both pass; arm64 was verified by hand under podman only.

- [ ] **No HTTPS server.** *Mostly fixed. `std/tls` adds the server transport (`TlsListener`
  with cert/key loading + `SSL_accept`) and `std/https` adds `serveTls`/`serveRouterTls` over
  std/http's wire format; `std/fetch` gains `TlsStream.fromFd` for upgrading an already-connected
  socket (Postgres `SSLRequest`, STARTTLS) and `connectWithCA` for trusting a private CA without
  turning verification off. `http.serve` itself stays plaintext and OpenSSL-free, which is the
  point of the split.* Still missing on the server: multipart/form-data, static file serving,
  body size limits, request timeouts, chunked response streaming, keep-alive.

- [x] **Concurrency primitives are thin.** *Fixed. `std/sync` gains `Once` (three-branch wait
  matching `WaitGroup`: a green waiter parks, an OS-thread waiter cond-waits, main with a live
  scheduler bounded-polls — so it is correct under green tasks AND `Promise.blocking` threads),
  plus `AtomicI32` and `AtomicU64`, plus the fill-ins that made the existing matrix ragged
  (`AtomicI64.swap`, `AtomicBool.cas`). Ordering is now stated rather than discovered: every
  operation is `seq_cst` on both cmpxchg orderings, there is no ordering parameter, and
  `add`/`sub` wrap where ordinary Milo arithmetic traps.*

  *Three deliberate non-ships.* **`AtomicPtr`**: a raw pointer is only dereferenceable in
  `unsafe`, so it would be `AtomicI64` plus a cast with no safety added — and Milo cannot state
  that the pointee outlives the load, so a safe-looking `AtomicPtr` is a lifetime claim nothing
  checks. **`Lazy<T>`/`OnceCell<T>`**: a getter cannot return `&T` (references are
  second-class), so every `get()` would deep-copy the cached value — a cache that allocates per
  access. **Eager lazy-statics**: nothing was needed. A module-level `var` already runs a real
  initializer in dependency order before `main`, so `Once` is only for work deferred past the
  start of `main`; the expressible shape is a global plus a guard function, documented as such.

  Reentrancy — an initializer calling `run` on its own `Once` — aborts with the reason instead
  of hanging, since waiting is the only other option and a hang has no stack to read.

  Found and fixed on the way: **the generated module-global initializer ran `Drop` on the
  zeroinitializer it was about to overwrite.** Latent because `Vec`/`String` drop through
  `free(NULL)`; a `Drop` that dereferences (`Once`, `WaitGroup`) segfaulted before `main`.
  `HIRStmt.Assign` now carries `isInit`.

  **Found and NOT fixed — a compiler bug worth its own ticket.** A nested closure that captures
  an *outer closure's* capture emits invalid IR (`use of undefined value '%n.addr'`):
  ```milo
  fn callIt(f: () => void): void { f() }
  pub fn main(): i32 {
      let n: i64 = 7
      let outer = move(): void => { callIt((): void => { print(n) }) }
      outer(); return 0
  }
  ```
  Unrelated to `std/sync`, but it bounds it: `Once.run` inside a `Task`/`Promise.blocking`
  closure is limited to initializers that touch globals rather than the worker's own captures —
  which is the shape the docs recommend anyway, so the bug is currently invisible.

  Two hazards left standing: **`add`/`sub` wrap silently** in a checked-arithmetic language
  (`x + 1` traps, `counter.add(1)` does not, and nothing in the source shows the difference —
  there is no checked atomic RMW instruction, so the alternatives were a `cas`-loop `Option` API
  nobody would use for a counter, or not shipping the types; `addChecked -> Option` can be added
  later without breaking anything). And **the documented lazy-static idiom is not compiler-guided**:
  reading `gTable` without first calling `ensureTable()` silently yields an empty `Vec`. `Lazy<T>`
  would catch it but cannot be expressed; the real fix is lazily-initialized globals in the
  language.

  Original finding:
  ```
  No `Once`/lazy statics. Atomics are `AtomicBool` and `AtomicI64` only — no `AtomicI32`,
  `AtomicU64`, `AtomicPtr`.
  ```
  (Mutex/RwLock are *deliberately* absent per the concurrency-simplification decision — not a
  gap, do not re-add.)

- [ ] **No BigInt / arbitrary-precision decimal.** Node and Go have both; Rust punts to crates.

- [ ] **Smaller absences:** ~~HTML escaping~~, ~~MIME type table~~, ~~multipart parsing~~,
  zip *write* (read only today), cookie jar, ~~`strconv` quote/unquote~~,
  ~~`strconv.parseBool`~~.

  *Four of the six shipped. `std/html` — `Html.escapeText` (element text and quoted
  attributes), `Html.escapeAttr` (safe under any quoting, including none, which costs
  `&#32;` for spaces), `Html.unescape` (five predefined entities plus numeric refs only —
  `&nbsp;` stays literal), `Html.isSafeUrl` (scheme allowlist; rejects any C0/DEL byte
  outright because browsers strip some of them before resolving the scheme). Every doc
  comment states the contexts the function is **not** safe for, and there is deliberately no
  function for `<script>`/`<style>`/URL-component contexts, where escaping is the wrong tool.
  `std/mime` — extension → type, `contentType` appending `; charset=utf-8` for textual types,
  unknown = `Option.None` rather than a built-in `octet-stream` default. `std/multipart` —
  `Multipart.parse`/`parseWithLimits`/`boundary`/`field`, `Part.isFile`/`safeFilename`, a
  `Limits` struct (256 parts, 8 MiB per body, 16 KiB per header block) applied by default, and
  an 11-variant `MultipartError` carrying byte offsets. `Part.filename` is left raw and named
  as untrusted; `safeFilename` rejects rather than repairs (last path component only, no
  `.`/`..`, no controls or Windows-special bytes, no trailing dot or space, no DOS device
  names). `strconv` gained `parseBool` (`true`/`t`/`1`/`false`/`f`/`0`, ASCII-case-insensitive,
  no trimming) and `quoteString`/`unquoteString` — `Option`, matching the module's existing
  convention; `unquoteString` is strict where the compiler's own lexer is lenient, because a
  decoder over untrusted text must not silently delete a backslash.*

  **Not shipped, with reasons.** Zip *write* was left alone deliberately — `std/zip` was being
  touched by concurrent work. The **cookie jar** is a design blocker, not a time one: a
  client-side jar's whole security job is deciding whether a `Set-Cookie` may claim a domain,
  and without a public-suffix list the best available rule is the pre-PSL "must be a suffix of
  the request host and contain a dot" heuristic, which happily lets a site set a cookie for
  `.co.uk`. Shipping that under the name "cookie jar" is exactly the failure mode this tier's
  HTML entry exists to avoid. Go's answer — make the caller inject a `PublicSuffixList` and
  document that `nil` means no protection — is the precedent to copy, but that is an API
  decision worth making on purpose rather than as the tail of a six-item bullet.

---

## Tier 4 — container gaps

- [x] **`HashSet` is unusable as a set.** *Fixed by a new language feature rather than a set
  method: `@iter` on a struct field delegates `for x in wrapper` to that field, so `HashSet`
  enumerates through its backing `HashMap` with nothing allocated and no snapshot. A set could
  not have written a `next` method at all — the iterator would have to hold a reference into the
  set, and references are second-class. At most one `@iter` field per struct (two makes the loop
  ambiguous; `tests/errors/iterDelegateTwoFields.milo`). Plus union/intersect/difference,
  `fromVec`/`toVec`. Documented in `docs/language-reference.md` and `docs/grammar.ebnf`.*

  Original finding:
  ```
  for x in s      → error: cannot iterate over type 'HashSet_i64': no 'next' method found
  HashSet.new()   → error: 'HashSet' is generic — spell its type arguments
  ```
  (`HashSet.new()` still needs the turbofish after the 2026-08-16 inference change: it takes no
  arguments, so there is nothing to infer the element type from. `BufReader.new(f)` does not.)
  Five methods total (`add`/`contains`/`len`/`remove`/`new`). No iteration, no
  union/intersect/difference, no `fromVec`/`toVec`. Rust `HashSet`, Node `Set` (with ES2025 set
  ops) and Go's `map[T]struct{}` idiom all enumerate. A set you cannot enumerate is a bloom
  filter. The turbofish half is `backlog.md` Tier 1 #5. Ref: `std/set.milo`.

- [x] **`HashMap` is missing `keys()`, `values()`, `entry`/`getOrInsert`, `withCapacity`,
  `retain`, and `clear()`** — `Vec` has `clear`, `HashMap` does not. Ref:
  `src/suggest.ts HASHMAP_MEMBERS`. *Shipped `keys`, `values`, `clear`, `clone`, `isEmpty`,
  `withCapacity`. Still missing: `retain`, and `entry`/`getOrInsert` — the latter's whole value
  is handing back a reference into the map that stays live across an insert, which second-class
  references forbid, so it needs a different shape (a `getOrInsertWith(k, f)` that returns a
  value, not a handle) before it can ship.*

- [x] **`for k, v in map` works but is undocumented.** *Documented in
  `docs/language-reference.md` §HashMap (new "Iteration" subsection). Probing it turned up a
  real codegen bug, now fixed: a **second** `for k, v in map` in the same function bound `v` to
  the key — the value store went through a hardcoded `%<name>.addr` while reads resolved to the
  uniqued `%<name>.N.addr`. Silent wrong values, no diagnostic. Fixture `mapIterTwoLoops.milo`.
  Also documented that iteration order is deliberately unstable run-to-run (per-process
  `getentropy` hash seed, HashDoS defense) — an entry-by-entry test of a map is a CI flake.*

- [x] **`Vec` gaps:** *Shipped `get`, `first`, `last`, `min`, `max`, `indexOf`, `position`,
  `extend`, `retain` (in place), `capacity`, `reserve`. Remaining and not shipped: `dedup`,
  `binarySearch`, `swapRemove`, `chunks`/`windows`, `zip`, `flatMap`, `resize`.* Original list:
  `extend`/`append`, `dedup`, `retain` (in place — `filter` allocates),
  `first`/`last`, `min`/`max` (**`sum` exists**, which makes the omission an asymmetry rather
  than a scope decision), `indexOf`/`position` (`find` returns the value, not the index),
  `binarySearch`, `swapRemove`, `chunks`/`windows`, `zip`, `flatMap`, `capacity`/`reserve`,
  `resize`. Ref: `src/suggest.ts VEC_MEMBERS`.

- [ ] **No lazy iterators.** `v.map(f).filter(g)` allocates two intermediate `Vec`s. Rust
  `Iterator`, Node generators and Go 1.23 `iter.Seq` all avoid it; it also blocks `rev()`,
  `take`, `skip` and infinite sequences. **Note the standing decision** — `backlog.md` Tier 2 #6
  records lazy/fusing adapters as *declined* (Graydon review #2: laziness pays only with
  aggressive inlining and drags associated types into the trait system). Left here as a measured
  cost, not a proposal; reopen only with allocation numbers.

- [x] **Slices do not print.** `print(v.slice(0,1))` → `<unprintable>` while `print(v)` →
  `[1, 3]`. Inconsistent with the container-printing work that just shipped. *Fixed — a slice
  now prints like the Vec it views. Fixture `printSlice.milo`.*

---

## Tier 5 — cleanup, convention debt

- [ ] **Five error conventions for one job.** `IoError` (fs, io) · `NetError` (net, fetch) ·
  bare `string` (unix, ws, zip, zstd, png, crypto, dl) · `Result<T>` defaulting to string
  (process, sqlite, toml, url, regex, arena) · `bool` (`sysinfo.setCwd`, `Jwt.verifyHS256`).
  Sharpest case: **`std/unix` and `std/net` do literally the same operations** —
  accept/connect/recv/send — with different error types. Pick the enum convention, retire
  bare-`string` errors.

- [ ] **The namespace-object migration is ~50% done.** Namespace-object: `Math`, `Path`, `Env`,
  `Json`, `DateTime`, `Base64`, `Crypto`, `Regex`, `Url`, `Zstd`, `Png`, … Free functions:
  `fs.readFile`, `sort.sortI64`, `strconv.parseInt`, `time.now`, `sysinfo.*`, `unicode.*`,
  `signal.*`, `log.*`, `testing.*`, `os.*`. Ref: `docs/stdlib-coherence-migration.md`.

- [ ] **Three modules ship both APIs at once.**
  - `std/arena` — 13 `Arena.method()` **and** 13 `arenaAlloc<T>(a, …)` free fns. Full
    duplication. (Blocked in part by the generic-static turbofish gap, `backlog.md` Tier 1 #5.)
  - `std/png` — `Png.encode` **and** `encodePng`.
  - `std/sqlite` — `Database`/`Statement` structs exist but the entire API is C-style free fns
    (`dbOpen`, `dbBindText`, `dbStep`, `dbFinalize`). Never migrated.

- [ ] **Hand-monomorphization where generics already exist.**

  | Module | Symptom | Superseded by |
  |---|---|---|
  | `std/fmt` | `fmt1`/`fmt2`/`fmt3`/`fmt4` | `$"…{x}…"` — probed, works |
  | `std/fmt` | `join`, `padLeft`, `padRight` | `Vec.join`, `str.padStart`/`padEnd` |
  | `std/sort` | `sortI32`/`sortI64`/`sortStrings`/`reverseI64` | `Vec.sort`/`sortBy`/`sortByKey` |
  | `std/testing` | `assertEqual`(i32)/`assertEqual64`/`assertStrEqual`/`assertBool` | nothing — needs one generic `assertEq` |
  | `std/math` | `maxI32`/`maxI64`/`maxF64`/`minI32`/… | nothing — needs a bounded generic |
  | `std/random`, `std/rng` | `shuffleI64` only | nothing — cannot shuffle `Vec<string>` at all |
  | `std/json` | ~~`bool`/`boolAt`/`boolPath`/`childBoolAt`/`curBool` × 4 types ≈ 20 accessors~~ | partly done: the `*At`/`child*At` shapes (10 methods) are deleted, see Tier 1. `bool`/`boolPath`/`curBool` × 4 types remain — one per *value type* per *addressing mode*, which `andThen` cannot collapse; that needs a generic `Json.as<T>()` |

  `std/fmt` is now ~100% redundant. `std/sort` is redundant except `sortStringsByFreq`.

- [ ] **`std/testing` is too thin to test with.** Six assertions, all hand-monomorphized. No
  generic `assertEq`, no subtests/table tests, no failure diffing, no benchmark harness.
  Compare Go `testing.T` (`t.Run`, benchmarks), Rust `assert_eq!` over any `Debug`, Node
  `node:test` `describe`/`it`.

- [x] **`std/log` has no levels, fields, or sinks.** *Now `Log` namespace object: `LogLevel`
  threshold (default `Info`), fluent structured fields (`Log.str(k,v).int(k,n).info(msg)`),
  text/JSON formats, `setSinkFd`/`setSinkPath`, `Logger.new(name)`. Old free functions removed,
  no alias. No `Mutex` re-added: a record renders once and lands in one `write(2)` with control
  bytes escaped, so concurrent records interleave whole — verified 600/600 across 3 concurrent
  tasks. Config mutation is documented startup-only; `setSinkFd` takes an fd whose lifetime the
  type system can't check (second-class refs), documented as the caller's obligation.* `logDebug`/`logInfo`/`logWarn`/`logError`
  and nothing else — no `setLevel`, no structured fields, no output redirection, no logger
  instances. Compare Go `log/slog`, Rust `log`/`tracing`.

- [x] **Encapsulation leaks.** *Landed: `std/fetch` public surface 34 → 29 (13 internals now
  file-private), `fetch.startsWith` deleted for the builtin, `std/zstd` down to `Zstd` + 3
  methods from 19 exports. `strEqNocase` and `hexDigit` were **not** builtin duplicates and
  stayed (offset-anchored compare; `-1` sentinel that `hex._hexVal` maps to `0`) — private now,
  with comments saying why. Nothing needed package-scoped `pub`, so #1b stayed unbuilt.*
  Original finding: `std/fetch` exports `hexDigit`, `startsWith`, `strEqNocase`,
  `schemeOffset`, `parseRawHeaders`, `parseStatus` as `pub` — and `fetch.startsWith` duplicates
  the builtin `string.startsWith`. `std/zstd` exports 15 internal structs (`BitCS`, `FseCTable`,
  `HufTableResult`, `Rev`, `Seq3`, …). Interacts with `backlog.md` Tier 2 #1b (package-scoped
  `pub`): several of these want package visibility, not private and not public.

- [x] **`std/ws` constants are functions.** *Replaced by `enum WsOpcode: i32`;
  `WsMessage.opcode` is now `WsOpcode`, not `u8`. The type change surfaced a real bug: reserved
  opcodes (3–7, 11–15) used to be handed to the caller as data frames, which RFC 6455 §5.2
  forbids — `recv()` now returns `Err("reserved opcode")`. Wire-level round-trip fixture locks
  the discriminants to the actual header byte.*

- [ ] **Duplicated functionality across modules.**
  - `sysinfo.cwd`/`setCwd` vs `fs.currentDir`/`changeDir` — and different error models
    (`bool` vs `Result<Unit, IoError>`).
  - `std/env` (`Env.get`, method-style) vs `std/environ` (`envVars()`, free fn).
  - `term.readKey` vs the whole `std/keys` decoder.
  - `fs.readFile` vs `io.File.openRead().readAll()`.

- [ ] **`std/argparse` gaps:** no subcommands, no choice/enum validation, no repeated flags
  (`Vec`), no f64 flag, and `getString` returns bare `string` (see Tier 1). Compare Go
  `flag`/cobra, Rust clap, Node commander.

- [x] **`Uuid` is a namespace with one function.** *Now a 16-byte Copy value type with `v4`,
  `v7` (RFC 9562 §6.2 monotonic-random, counter reseeds per millisecond), `parse -> Option<Uuid>`,
  `nil`, `toString`, `isNil`, `version`, `variant`, `timestampMs`, `Eq`. `Uuid.v4()` returns
  `Uuid` not `string` — breaking. Known bound: the v7 monotonic counter is unsynchronized global
  state, so concurrent green tasks can lose **ordering** (never uniqueness — 62 random bits
  remain); documented in-source and in the reference.*

---

## Method

- Module surface: `bun run src/main.ts api --module std/<m>` over every module (67 total,
  1003 signatures).
- Builtin surface: `src/suggest.ts` — `VEC_MEMBERS`, `HASHMAP_MEMBERS`, `STRING_MEMBERS`,
  `OPTION_MEMBERS`, `RESULT_MEMBERS` are the checker's own member tables and therefore
  authoritative.
- Behavioral claims (parseInt, parseF64, HashSet iteration, `for k, v in map`, string
  interpolation, slice printing, `Vec.find`) were probed against a live build, not read off
  the docs.
