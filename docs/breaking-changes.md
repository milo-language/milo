<!-- doc-meta
system: breaking-changes
purpose: source-level breaks users have to act on, with the migration and the reason a compat shim was impossible
key-files: std/arena.milo, std/set.milo, std/platform.*.milo, std/mem.milo, std/os.milo, std/string.milo, std/strconv.milo, std/uuid.milo, std/ws.milo, std/fetch.milo, std/zstd.milo, std/base64.milo, std/base32.milo, std/hex.milo, std/csv.milo
update-when: a public stdlib name moves, is renamed, or changes signature
last-verified: 2026-09-19
-->

# Breaking changes

Source-level breaks, newest first. Milo is pre-1.0 and does not promise
compatibility, but every break belongs here with the migration spelled out.

Below 1.0 the MINOR is the breaking position: everything in this file shipped in
**v0.2.0**, and a package that wants to stay on the previous surface pins
`"milo": "^0.1.0"` in its `milo.json` (see
[the package manager plan](plans/package-manager.md#the-milo-constraint)). A release
marker is added here each time a version is cut.

## Copying accessors are absent for an element that carries Drop or @noCopy (2026-09-19)

Reading an element out of a container **by value** is a structural copy that never runs
a Drop, so for a resource type it was a second owner released twice (soundness sweep
H5: `Option.Some(v[0])` on a `Vec<Res>` ran `Res`'s destructor three times). The rule
that already rejected `let x = v[0]` for such an element now applies at every by-value
consumption, and the accessors built on that copy are withheld for such a `T`:

| API | for a `T` carrying Drop or `@noCopy` | use instead |
|---|---|---|
| `Arena.get` / `arenaGet`, `Arena.modify` / `arenaModify` | absent (`@copyOut`); the call is the error, naming the reason | `read` / `arenaRead` / `arenaWith` to borrow, `modifyMut` to mutate in place, `set` to overwrite |
| `FrozenArena.get` / `frozenGet`, `GrowOnlyArena.get` | absent | `read` / `frozenRead` |
| builtin `Vec.clone`, `Vec.get`/`first`/`last` | rejected | `for x in v`, `v[i].field`, `remove`/`pop`; clone element by element where `T`'s own `Clone` impl runs |
| builtin `HashMap.clone`, `keys`, `values`, `get`, `getOrDefault` | rejected | `for k, v in m`, `remove`; clone entry by entry |
| `HashSet.clone`, `HashSet.toVec` | unchanged surface; now run `T.clone()` per element instead of the builtin structural copy | |

Every one of the arena's borrowing forms, `alloc`, `free`, `valid`, `handles`,
`freeze` and `sealGrowth` still exist on `Arena<Res>`; only the two copying methods are
missing. `Arena.get` returning a copy of a Drop `T` was never sound, which is why this
is a removal for that `T` rather than a rename. A `T` with no resource inside it
(scalars, `string`, plain structs, `Vec`, enums of those) is untouched.

The attribute that expresses this, `@copyOut`, is public: a user generic that copies a
`T` out of a container marks the method or fn, and that method is withheld from an
instantiation whose `T` carries a resource while the rest of the type stays usable
(`tests/fixtures/copyOutUserGeneric.milo`). See `@copyOut` in
[language-reference.md](language-reference.md).

## `std/shard`'s manual divide/weld path is private; the closed forms are infallible (2026-09-19)

**`shatter`, `shatterStr`, `Shards<T>`, `StrShards`, `WeldRejected<T>`,
`StrWeldRejected` and `WeldReason` are gone from the public surface**, and with them
the methods `windows`, `weld`, `reclaim`, `count` and `len` on the two owners.
Dividing a buffer across threads is now only possible through a closed form that
awaits every worker before the owner can go away:

| removed | use instead |
|---|---|
| `shatter(v, n)` / `owner.windows()` / `owner.weld(back)` | `parallelMap(v, n, f)`, or `parallelMapWith(v, windows, states, f)` when the workers need state or the windows outnumber the workers |
| `shatterStr(s, n)` / `owner.windows(overlap)` / `owner.weld(back)` | `parallelScanStr(s, n, overlap, f)` with `f: (&StrShard) => R`; the string comes back in `.text`, the per-window results in `.results` |
| `Shards.reclaim()` after a `NoWorkers` refusal | `rej.data` on the new `NoWorkers<T>` |
| `WeldRejected.message()` / `.reason` / `.index` | nothing to replace: a weld inside a closed form cannot fail, so the error no longer exists |
| `parallelMap(v, n, f)!` | `parallelMap(v, n, f)` (it returns `Vec<T>` now; the `!` is a compile error) |
| `parallelMapWith(...)` refusing with `WeldRejected<T>` | refuses with `NoWorkers<T>`, which carries the caller's `Vec<T>` back as `data` |

Why it is a removal and not a rule: a window is a raw pointer into the owner's
buffer. Handing windows to a worker by hand and returning from the function
before the worker finished dropped the `Shards` owner under a live window, and the
worker then wrote into freed memory (H2 in
[the soundness sweep](plans/soundness-sweep-2026-09.md); heap-use-after-free under
`--sanitize`). The move checker cannot see it because nothing is moved twice; the
`weld` check could only notice the miss after the fact, and a program that never
welds never reaches it. No caller in-tree needed the pieces apart, so the pieces
are no longer offered. The residue paragraph in `docs/residue-vs-rust.md` §2 is
withdrawn: there is no "keep the owner alive" obligation left to document.

## `std/json` cursors are branded with their document (2026-08-28)

**Cursor values from `curRoot`/`curChild`/`curField`/`curValueAt`/`curPath` are no
longer bare node indices.** The document's identity now rides in the high 31 bits
of the same `i64`, and every cursor accessor checks it: resolving a cursor
against a `Json` other than the one that produced it aborts with
`json: cursor belongs to a different document` instead of silently reading a
wrong-but-in-bounds node of the other document. This is the runtime brand
`seal.Span` already carries as `_bufferId`, applied to the other zero-copy
handle in std (see docs/residue-vs-rust.md).

No signature changed and `-1` still means "nothing here" everywhere, so code
that navigates a document it parsed itself (every caller found in-tree and in
downstream users) compiles and behaves identically. What does break:

- A cursor invented by arithmetic (`0` for the root, `cur + 1`, a stored small
  integer) now aborts when resolved: hand-built cursors carry brand 0, which no
  document ever has. Navigate from `curRoot()` instead.
- A cursor held across `get`/`at`/`path` never resolved to the extracted
  document correctly (extraction renumbers the node pool); doing so now aborts
  instead of returning plausible garbage.
- Cursor values are no longer small integers when printed or stored; only `-1`
  is stable. Nothing found in-tree relied on the numeric value.

To branch on a cursor of unknown origin instead of aborting, use the new
`curHolds(cur)`, the analogue of `Sealed.holds`. One new limit: a single
document is capped at 2^32 nodes (enforced at parse, like seal's 2GB span cap).

## `std/net.gSigpipeIgnored` is no longer public (2026-08-22)

**The `gSigpipeIgnored` global is now private to `std/net`.** Nothing outside that module
referenced it, so the migration for almost everyone is nothing.

It was never a useful thing to reach: reading it told you only whether some earlier call
had already installed the SIGPIPE handler, and writing it could suppress the install
entirely. `ignoreSigpipe()` remains public and is the whole supported surface. If you were
reading the flag to decide whether to call `ignoreSigpipe()`, just call it; it is a
one-shot and the repeat calls are free.

It went private as part of fixing a real race. The old guard was

```milo
if gSigpipeIgnored { return }
gSigpipeIgnored = true
```

which is a read-modify-write that two threads can both pass. `TcpStream.connect` calls it,
and `connect` is reachable from a `Promise.blocking` worker, so this was reachable
concurrently in practice (milojs gets there through `fetch`). It is now a
compare-and-swap, and a mutable global that must only be touched atomically has no
business being public.

## `std/sysinfo`'s identity calls return u32 MAX on Windows, not 0 (2026-08-16)

**`uid`, `gid`, `euid` and `egid` return `4294967295` on Windows** where they previously
returned `0`.

Windows identities are SIDs, so there is no numeric id to report and some sentinel is
unavoidable. `0` was the wrong one: the comment defending it said 0 "matches the
darwin/linux failure return", and there is no such return — `getuid()` cannot fail, so on
the POSIX arms `0` means the process IS root. The standard portable guard therefore took
the root branch unconditionally on Windows:

    if uid() == 0 {
        // refuse to run as root, or unlock a privileged path
    }

u32 MAX is not an id any system issues, so a caller that ignores the platform gets an
answer that looks wrong rather than one that looks like root. If you compare against a
sentinel, compare against `4294967295`; if you branch on privilege, do it per-platform.

## Closure parameters that take ownership say `move` (2026-08-15)

**`spawnOsThreadDetached`, `Task.spawn`, `Task.spawnWithStack` and `Promise.blocking`
now take `move () => T` rather than `() => T`.**

    pub fn spawnOsThreadDetached(f: () => void): void        // was
    pub fn spawnOsThreadDetached(f: move () => void): void   // now

**Existing call sites do not change.** A `move` parameter accepts every value a plain
one did — a bare function, a by-reference closure, a `move` closure — because
transferring something that owns nothing loses nothing. The spelling is what these four
always meant: each hands the closure to a task or a thread that outlives the call.

What DOES change is your own signatures, if you wrote a function that stores a closure
and lives past the call. `move (T) => R` is a distinct type from `(T) => R` and is not
`Copy`: an owning closure holds a heap environment, so there is exactly one of it, and
duplicating one would give two owners of that environment. Passing it on transfers it,
and using it afterwards is a use-after-move error rather than a silent second owner.
That restriction is what makes it possible to release a closure's captures at all —
before it, every capturing closure leaked them.

## `std/pty`'s command-line helpers are private (2026-08-15)

**`std/pty`'s `buildCmdLine` and `quoteArg` are now `_ptyBuildCmdLine` and
`_ptyQuoteArg`, and no longer public.** They were internal helpers of the Windows arm
that happened to be `pub`, and in a flat namespace that made them collide with the
identically-named helpers in `std/process` — the two modules could not be imported into
one program. Nothing in the toolchain called them from outside `std/pty`. If you did,
build the command line yourself: `_ptyQuoteArg` wrapped an argument in quotes and
escaped embedded quotes and backslashes per the MSVCRT rules.

## `std/fetch`'s response type is `FetchResponse` (2026-08-14)

**`fetch`/`fetchPost`/`fetchPut`/`fetchPatch`/`fetchDelete`/`fetchForm` now return
`Result<FetchResponse, NetError>`**, not `Result<Response, NetError>`.

    from "std/fetch" import { fetchGet, Response }        // was
    from "std/fetch" import { fetchGet, FetchResponse }   // now

`std/http` already exported a `Response`, and std is one flat namespace, so the two
definitions shadowed each other: no program could serve HTTP and fetch HTTPS at once.
Only the type name changed — the fields and methods are the same.

## `std/toml` moved to the `milo-toml` package (2026-08-14)

**`std/toml` and its `Toml` type are no longer in the standard library.** Add the
package instead — in `milo.json`:

    "dependencies": {
        "toml": "github.com/milo-language/milo-toml@v0.1.0"
    }

then `milo pkg install`, and change the import:

    from "std/toml" import { Toml }   // was
    from "toml" import { Toml }       // now

Nothing in the toolchain reads TOML, so the module was shipping on the compiler's
release cadence for no reason; as a package it ships on its own tags.

## `std/mem`'s bump allocator is renamed `Bump` (2026-08-14)

**`std/mem`'s `Arena` is now `Bump`**, and its private helpers move with it
(`arenaNew`/`arenaAlloc`/`arenaReset`/`arenaRemaining` → `bumpNew`/`bumpAlloc`/
`bumpReset`/`bumpRemaining`). The methods keep their names, so only the type does:

    from "std/mem" import { Arena }        // was
    var a = Arena.new(1024)!

    from "std/mem" import { Bump }         // now
    var a = Bump.new(1024)!

`std/arena` owns the name `Arena` for its generational `Arena<T>` + `Handle<T>`,
which is the blessed one for cyclic data. Milo merges every module into one flat
namespace, so the two could not coexist: a program importing both got whichever
definition the merge happened to keep, silently. The resolver now rejects that
outright (`duplicate-type`), which is what forced the rename rather than a shim —
there is no namespace to hide a compat alias in.

## `std/json` drops its fixed-shape accessors (2026-08-04)

**Deleted: `Json.strAt` `i64At` `f64At` `boolAt` `getAt` `childStrAt` `childI64At`
`childF64At` `childBoolAt` `childLen`.** These were ten hard-coded *navigation shapes* —
"array index then key", "key then array index then key" — one method per shape per value
type. The family was never closable: there is no `childChildStrAt`, so any walk three
levels deep already had to leave it.

Two replacements, both already present. For a walk over an owned value, chain with the new
`Option.andThen`:

    doc.strAt(i, "name")                        // was
    doc.at(i).andThen((j) => j.str("name"))     // now

    doc.childI64At("items", i, "id")            // was
    doc.get("items").andThen((a) => a.at(i)).andThen((e) => e.i64("id"))   // now

Each hop deep-clones the subtree, which the deleted methods did not. For a hot loop or a
large document use the cursor API instead — same shapes, zero allocation:

    let items = doc.curField(doc.curRoot(), "items")
    doc.curInt(doc.curField(doc.curChild(items, i), "id"))

`childLen(k)` is `curLen(curField(curRoot(), k))`. When the path is literal,
`strPath("items[0].name")` is shorter than both.

Not deleted: `get`/`str`/`i64`/`f64`/`bool`/`at`, the `*Path` family, the `cur*` cursors,
`as*`, and the type checks. Those are one method per *value type*, not per *shape*, and
`andThen` cannot collapse them.

## `Option` and `Result` gain `andThen`, `orElse`, `unwrapOrElse` (2026-08-04)

Additive, with one behavioral sharp edge worth knowing: **`Option.orElse` and `Result.orElse`
consume a non-Copy receiver**, because the success side is the one they forward. Before this
change there was no way to accidentally consume an `Option`. The use-after-move error fires at
the *next* use of the variable, not at the `orElse` call.

`Result.unwrapOrElse` is Copy-`T`-only, the same gate `unwrapOr` already has, because it loads
the Ok payload out. `andThen` has no such gate — it takes the payload by reference.

## `std/strconv` gains `parseBool`, `quoteString`, `unquoteString` (2026-08-04)

Additive, but Milo compiles every module into one flat namespace, so a program that imports
`std/strconv` **and** defines its own top-level `fn parseBool`, `fn quoteString` or
`fn unquoteString` now fails to compile with "defined in two modules with different bodies".

Rename yours, or delete it and use the std one: `parseBool` is `Option<bool>` over
`true`/`t`/`1`/`false`/`f`/`0`, ASCII-case-insensitive, with no trimming.

## `pub` on structs is now actually enforced across files (2026-08-04)

A non-`pub` struct used from another file has always been an error by the rules. It was
never *reported*, because `checkVisibility` attributes a declaration to its file via
`decl.span?.file` and `StructDecl` was the one declaration kind the parser built without a
span — so `s.span?.file` was `undefined`, the struct was filed under no file at all, and
the cross-file check could not fire. Every non-`pub` struct in every project was silently
importable from anywhere.

`StructDecl` gained a span (added so `@derive(Json)` could point diagnostics at a struct),
which turned the existing check on. Functions, enums, traits, interfaces and type aliases
were unaffected — they always carried spans and were always enforced.

Migration: mark the struct `pub` where it is defined. The error names the struct and the
file. In this org, `milo-emulators` was the only repo affected — `Ppu`, `Apu` and `Fx`
were being imported across files without `pub`.

## `std/json` integer reads are exact; bare literals are validated (2026-08-04)

**`Json.i64` / `i64At` / `i64Path` / `asI64` / `curInt` now answer `None` where they used
to answer a wrong number.** The parser accumulates every JSON number into an `f64` and
these read through it, so anything past 2^53 came back truncated
(`18446744073709551615` → `9223372036854775807`) and `1.5` came back as `1`. An integer
read now re-scans the literal's own source span and answers `Some` only for a literal that
is an integer and fits `i64`; fractional values, exponent forms (`1e2`) and out-of-range
values are `None`. Migration for callers that want the old leniency: read `f64` and cast —
`(doc.f64(k) ?? 0.0) as i64`. `std/jwt`'s `exp`/`nbf`/`iat` were migrated that way, because
RFC 7519 NumericDate permits a fraction. New: `Json.curUint(cur): Option<u64>` for values
above `i64::MAX`.

**`Json.parse` rejects malformed bare literals.** `true`/`false`/`null` were matched on
their first byte alone, so `nope` parsed as `null`, `trux` as `true` and `fals3` as
`false`. All three are now `Err`.

**A method literally named `json` no longer auto-stringifies a scalar argument.**
`ctx.json(42)` type-checked and then crashed codegen; it is now an ordinary type error —
write `ctx.json(n.toString())`. The same call site now also errors when the struct has a
field the built-in stringifier cannot serialize; it previously emitted `"tags":` with no
value at all, i.e. invalid JSON. Add `@derive(Json)` and the call routes through the
derived `toJson`.

**`@json` is now a reserved struct-field attribute** — it renames a field on the wire for
`@derive(Json)`, and is an error on a struct that does not derive it.

## `fs.isSymlink` now answers correctly on arm64 Linux (2026-08-04)

Not a source-level break — no signature changed — but the answer changed on one platform.

`isSymlink` tested the `S_IFLNK` bit at a fixed `st_mode` offset inside `struct stat`. That
offset is 24 on x86_64 and 16 on arm64, and `std/platform` splits by **OS only**, with no
arch axis — so on arm64 Linux it read a different field entirely and returned `false` for
every symlink. It now uses `readlink` (EINVAL on a non-link), which is arch- and
libc-independent. Code that accidentally relied on the always-false answer there will now
take the symlink branch.

`FileInfo.mode` / `lstatInfo(...).mode` still has the underlying offset bug and reads 0 on
arm64 Linux. Do not build on that field until the platform split grows an arch dimension.

## `Duration` accessors became methods, and `Duration` is now nanoseconds (2026-08-04)

`durationSecs(d)` / `durationMillis(d)` / `durationMicros(d)` are **removed**. They are
`d.toSecs()` / `d.toMillis()` / `d.toMicros()`, and they now have the siblings the
free-function shape could never grow: `toNanos`, `toMins`, `toHours`, `toSecsF64`,
`toMillisF64`. Three free functions in a flat namespace could not become nine.

The representation changed with them: `Duration` was `{ totalUsec: i64 }` and is now i64
**nanoseconds** — ±292.47 years at 1 ns resolution. The field is private (`_nanos`), so
code that read `d.totalUsec` fails to compile rather than silently reading a value 1000×
larger. Overflow past the range traps like any other checked i64 arithmetic;
`Duration.parse` returns `None` instead, because it takes untrusted text.

No compat shim is possible — the flat namespace has no place to put an old spelling — and
none is wanted: the old names were the only accessors, so every call site is a one-line
mechanical edit.

    // before
    let ms = durationMillis(since(start))
    print("took " + ms.toString() + "ms")

    // after
    print("took ", since(start).toString())        // "1.5s", "2m3.5s", "1h30m0s"
    let ms = since(start).toMillis()               // when you want the number

New in the same change: `Duration` construction (`Duration.zero/nanos/micros/millis/secs/
mins/hours/days`), `Duration.parse` (Go-style `"1h30m"`, `"-1.5h"`, `"300ms"`, `"7d"` →
`Option<Duration>`), `+`/`-`/`==`, `times`/`dividedBy`/`ratio`/`negated`/`abs`,
`compare`/`isLess`/`isGreater`, `toString`, `sleepFor`, `ensureTimersLive`, and the new
module `std/timer` (`Timer`, `Ticker`, `recvTimeout`, `waitReadable`/`waitWritable`). No
other existing name changed.

Behavioral change, not source-level: a green `sleepMs` used to busy-yield for the whole
span and now parks on a select timer arm, so other green tasks get the CPU; and `sleepMs`
no longer truncates its argument to `u32` (sleeps past ~71 minutes used to silently
return early).

## `Jwt.verifyHS256` returns the validated claims, not a bool (2026-08-03)

`Jwt.verifyHS256(token, secret) -> bool` checked the signature and nothing else: no
`exp`, no `nbf`, no `aud`, and no way to read the payload at all. Every caller writing
`if Jwt.verifyHS256(…)` accepted tokens that expired years ago. `httpmw.verifyBearer`
inherited the same hole.

Verification now returns `Result<JwtClaims, JwtError>` and validates the registered
time claims (`exp`, `nbf`, `iat`) with 60 s of clock-skew leeway. The `alg` header must
equal the algorithm the *verifier* asked for, so `alg: none` and algorithm confusion are
`JwtError.UnsupportedAlg` rather than a success. Signature comparison moved to
`std/subtle`'s `constantTimeEq` over the raw MAC, and a non-canonical base64url
signature — same MAC bytes, different token text — is rejected instead of accepted.

There is no compat shim: the point of the break is that `if verify(...)` must stop
compiling. `.isOk()` is a caller who saw the claims and chose to discard them; the old
spelling was a caller who never knew there were claims.

```milo
// before
if Jwt.verifyHS256(token, secret) {
    handle(request)                      // token may have expired in 2021
}
if verifyBearer(ctx, secret) { … }

// after
match Jwt.verifyHS256(token, secret) {
    Result.Ok(claims) => { handle(request, claims.subject()) }
    Result.Err(e) => { log(jwtErrorMessage(e)) }   // Expired vs BadSignature vs WrongAudience
}
if verifyBearer(ctx, secret).isOk() { … }          // when the claims genuinely are not needed

// audience, issuer, a fixed clock, or a mandatory exp
let claims = JwtVerifier.new(JwtAlg.HS256, secret)
    .audience("api.example")
    .issuer("auth.example")
    .requireExpiry()
    .verify(token)?
```

`httpmw.verifyBearer` returns the same `Result`, and now distinguishes "no
Authorization header" from "an Authorization header that is not a Bearer token".

New in the same change: `std/subtle` (`constantTimeEq`), `std/sha512` (`Sha512`,
`Sha384`), `std/hkdf` (RFC 5869), `std/pbkdf2` (RFC 8018), `Hmac.sha384Bytes` /
`.sha512Bytes` / `.sha512`, `Jwt.signHS384` / `.signHS512` / `.verifyHS384` /
`.verifyHS512`, and `Totp.verify`. No existing name in those modules changed, and
HS256 token output is byte-identical to before.

## HTTP, fetch and argparse lookups return `Option<string>` (2026-08-03)

"Absent" and "present with an empty value" were the same value (`""`) across the
whole HTTP stack, so `?q=` was indistinguishable from no `?q=`, and a
`Cookie: session=` from no cookie at all. `std/env` already answered this with
`Option`; now the rest of the stdlib gives the same answer. Affects
`Context.query/param/header/cookie`, `fetch.findHeader`, `Response.header` and
`ParsedArgs.getString`.

`fetch.hasHeader` is **removed** — it existed only to work around `findHeader`
returning `""` for both cases, and is now exactly `findHeader(...).isSome()`.

`findHeader` also no longer misses a value-less header at the very end of a block
(`"A: b\r\nX-Empty:"` used to report absent).

Note `unwrapOr` is Copy-only, so the collapse spelling is `??`, not `.unwrapOr("")`.

```milo
// before
let q = ctx.query("q")
if q.len == 0 { return badRequest() }
let out = args.getString("output")
if !hasHeader(hdrs, "Accept") { … }

// after
let Option.Some(q) = ctx.query("q") else { return badRequest() }  // absent
if q.len == 0 { return badRequest() }                             // present but empty
let out = args.getString("output") ?? ""
if findHeader(hdrs, "Accept").isNone() { … }
```

`ParsedArgs.getString` is `None` when the name was never declared, or was declared
with no default and not supplied; `--flag ""` is `Some("")`, and a declared default
comes back as `Some(default)`. `has(name)` still answers "was it on the command line".

## `std/zip` and `std/png` report corrupt input instead of aborting (2026-08-03)

A truncated or corrupt archive/image previously ran a header read off the end of the
buffer and hit the bounds-check abort. Both now return `Result.Err` ("zip: truncated
archive", "png: truncated chunk"). Code that relied on the process dying on malformed
input must handle the `Err` arm.

No public name changed — `Zip.read` and `Png.decode` already returned `Result`; they
just could not reach the `Err` arm for this class of input.

## `std/log` — namespace object, levels, fields, sinks (2026-08-03)

The four free functions are replaced by the `Log` namespace object. Logging is
now filtered (default threshold `Info`, so debug records need an explicit
`setLevel`), can carry structured fields, and can be redirected off stderr.

```milo
// before
from "std/log" import { logDebug, logInfo, logWarn, logError }
logInfo("server starting")
logDebug("trace info")            // always printed

// after
from "std/log" import { Log, LogLevel }
Log.info("server starting")
Log.setLevel(LogLevel.Debug)      // debug is below the default threshold
Log.debug("trace info")
Log.str("path", p).int("bytes", n).warn("upload retried")
```

`logDebug`/`logInfo`/`logWarn`/`logError` are removed with no alias: two
spellings for one operation is the coherence defect this change exists to fix.

Also new: `Log.setLevel`/`level`/`isEnabled`, `Log.setFormat(LogFormat.Json)`,
`Log.setTimestamps(false)`, `Log.setSinkFd(fd)`, `Log.setSinkPath(path)`, and
`Logger.new(name)` for per-subsystem tagging. Records now carry an ISO-8601 UTC
timestamp by default; the old format printed a bare epoch-seconds integer.

Configure at startup, before spawning tasks: the config globals are single-word
and unsynchronized, and `setSinkPath` can close a descriptor under an in-flight
write. Records themselves never tear — each renders once and reaches the sink in
one `write(2)`, with control bytes escaped so a newline cannot fake a boundary.

## `Base64.decode`, `Base32.decode`, `Hex.decode`, `Csv.parse` return `Result` (2026-08-03)

All four silently produced plausible output from malformed input: a bad character
decoded as bit pattern 0, a wrong length truncated the payload, an unterminated CSV
quote swallowed the rest of the file into one field. A corrupt auth header became a
real-looking string with no signal. They are now fallible and report the byte offset.

`Hex`'s `pub _hexVal` (which mapped any non-digit to 0) is removed; it is now a
private helper returning -1.

```milo
// before
let bytes = Base64.decode(header)
let rows  = Csv.parse(text)

// after — propagate
let bytes = Base64.decode(header)?
let rows  = Csv.parse(text)?
// or abort at the decode site
let bytes = Base64.decode(header)!
```

`Base32.decode` is now strict RFC 4648. The old tolerance for whitespace, `-` and
missing padding — the "secret pasted from an authenticator app" case — moved to
`Base32.decodeLoose`, which still rejects non-alphabet bytes:

```milo
// before
let key = Base32.decode("JBSW Y3DP EHPK 3PXP")
// after
let key = Base32.decodeLoose("JBSW Y3DP EHPK 3PXP")!
```

`Base64.decode` no longer accepts whitespace or newlines. MIME/PEM-wrapped base64
must be unwrapped by the caller — previously it "worked" only by decoding `\n` as
symbol 0 and producing corrupt bytes.

New: `Base64.urlDecode` — the inverse of `Base64.urlEncode`, which had none.

## `s.parseInt()` / `s.parseF64()` return `Option` (2026-08-03)

| Before | After |
|---|---|
| `let n: i64 = s.parseInt()` | `let Option.Some(n) = s.parseInt() else { … }` |
| `let x: f64 = s.parseF64()` | `let x = s.parseF64().unwrapOr(0.0)` |

`match` and `?` work too. The compiler names the fix in the hint on the type
mismatch, so the migration is mechanical.

No compat shim was possible: the break IS the fix. The old builtins returned a
bare `i64`/`f64` and answered `0` for garbage — `"42x".parseInt()` was `42`,
`"abc".parseF64()` was `0` and indistinguishable from parsing the string `"0"`.
Meanwhile `std/strconv.parseInt` returned `Option<i64>` off a second, stricter
implementation, so the language shipped two parsers with opposite failure models
and the total-*looking* spelling was the lossy one. There is one parser now:
`std/string.strParseInt` / `strParseF64` back the builtins, and
`strconv.parseInt` / `parseFloat` are named aliases for them.

Three behaviour changes ride along. `parseInt` rejects out-of-range input
(`"9223372036854775808"` → `None`) instead of wrapping or trapping.
`strconv.parseIntRadix` now validates every digit against the base:
`parseIntRadix("zz", 16)` was `Some(0)`, now `None`. And `enum Option` / `enum
Result` are now rejected outright — *"'Option' is a builtin enum and cannot be
redeclared"*. Redeclaring one used to be allowed but never rebound the `T?`/`!`/
`??`/`?` sugar; now that prelude signatures name `Option`, it also broke `std`
three files away. Delete the declaration, or rename it if you meant a different
type.

## `Uuid.v4()` returns a `Uuid`, not a `string` (2026-08-03)

`std/uuid` grew a real value type: `Uuid` is 16 bytes (Copy, no heap), with
`Uuid.v4()`, `Uuid.v7()`, `Uuid.parse()`, `Uuid.nil()`, `toString()`, `isNil()`,
`version()`, `variant()`, `timestampMs()`, and `Eq`. Migration: append
`.toString()` where a string was wanted (`Uuid.v4().toString()`).

No compat shim was possible under the one-spelling rule: a `Uuid.v4(): string`
alongside `Uuid.v4(): Uuid` cannot coexist, and keeping the string spelling for
v4 while v7 returned a value would make the module's two constructors disagree
about what a UUID is. The private `uuidV4()` free function is gone with it.

## `std/ws` opcodes are an enum, not six functions (2026-08-03)

`WS_CONTINUATION()`, `WS_TEXT()`, `WS_BINARY()`, `WS_CLOSE()`, `WS_PING()` and
`WS_PONG()` are gone. They were zero-argument functions returning a `u8` —
constants faked with a call, in a language that has integer-repr enums.

| Before | After |
|---|---|
| `WS_CONTINUATION()` | `WsOpcode.Continuation` |
| `WS_TEXT()` | `WsOpcode.Text` |
| `WS_BINARY()` | `WsOpcode.Binary` |
| `WS_CLOSE()` | `WsOpcode.Close` |
| `WS_PING()` | `WsOpcode.Ping` |
| `WS_PONG()` | `WsOpcode.Pong` |

`WsMessage.opcode` is now a `WsOpcode` rather than a `u8`. Compare it against a
variant (`msg.opcode == WsOpcode.Text`) or `match` on it; `msg.opcode as i32`
still gives the RFC 6455 wire nibble, and `WsOpcode.tryFrom(n)` is the partial
reverse.

**Behaviour change.** `WsConn.recv()` now returns `Err("reserved opcode")` when
a frame carries an opcode with no variant (3–7, 11–15). Previously those were
handed to the caller as if they were data frames, which RFC 6455 §5.2 forbids —
the type change is what forced the case to be considered at all.

**Why no shim.** A `u8` opcode and a `WsOpcode` opcode cannot both be the type
of `WsMessage.opcode`, and Milo's flat namespace has no deprecation attribute
for a function name. Hard break.

**Failure mode if you miss one.** A build error: `'WS_TEXT' not found in
'std/ws'`, or a type mismatch on the comparison. Nothing silently keeps working.

## `std/fetch` and `std/zstd` internals are file-private (2026-08-03)

Both modules were exporting their implementation. They now export only their API.

`std/fetch` no longer exports `startsWith` (deleted — use the builtin
`s.startsWith(prefix)` method), nor `strEqNocase`, `hexDigit`, `parseStatus`,
`parseRawHeaders`, `parseBody`, `decodeChunked`, `schemeOffset`, `httpDo`,
`httpsDo`, `doFetch`, `SSL_VERIFY_PEER`, `X509_V_OK`. Migration: `doFetch(url,
opts)` is `fetchWith(url, opts)`; raw responses still parse via `parseResponse`,
requests still serialize via `buildRequest`, and `findHeader`/`hasHeader`/
`isHttps`/`parseHost`/`parsePort`/`parsePath`/`urlEncode`/`formEncode` are
unchanged. The rest were bytes-level steps of those, with no standalone contract.

`std/zstd` no longer exports `BitCS`, `BlockResult`, `FseCTable`, `FseHdr`,
`FseTable`, `HufTable`, `HufTableResult`, `LzResult`, `Rev`, `Seq`, `Seq3`,
`SeqCodes`, `StreamPlan`, `ZDec`, `ZstdHeader` — FSE/Huffman coder state, not an
API. `Zstd.compress` / `.compressRaw` / `.decompress` are the whole module.

No compat shim was possible: `pub` is the only visibility knob, so re-exporting
these would be the bug this change fixes.

## Shadowing is rejected (2026-08-01)

A binding may no longer reuse a name already in scope in the same function —
nested block, loop binding, and match binding included. Migration: rename the
inner binding (`for si in 0..shots.len`), or prefix it with `_` if nothing reads
it.

No compat shim was possible: the old behaviour was not merely permissive, it was
wrong. Codegen's locals map is keyed by name with no scope, so a shadowing
binding leaked past its scope — `let row = 5; for row in nums { … }; print(row)`
printed the LAST ELEMENT, and mutated a `let` to do it. When the types differed
the same leak emitted invalid LLVM IR. Blast radius across std, tests and
examples was one file (`examples/games/flight/shot.milo`).

## Stdlib API coherence migrations (2026-07-30)

Several APIs now have one supported spelling that follows the standard-library
design rules:

| Before | After |
|---|---|
| `newParser(name, description)` | `ArgParser.new(name, description)` |
| `regexNew(pattern)` | `Regex.compile(pattern)` |
| `regexNewFlags(pattern, flags)` | `Regex.compileFlags(pattern, flags)` |
| `regexMatch(re, input)` | `re.isMatch(input)` |
| `regexFind(re, input)` | `re.find(input)` |
| `regexFindAll(re, input)` | `re.findAll(input)` |
| `arenaNew(capacity)` from `std/mem` | `Arena.new(capacity)` — since renamed `Bump.new(capacity)`, see 2026-08-14 above |
| `poolNew(size, count)` | `Pool.new(size, count)` |
| `charIsDigit`, `charIsAlpha`, and related byte helpers | `asciiIsDigit`, `asciiIsAlpha`, and the `asciiIs*` family |
| `toLowerChar`, `toUpperChar` | `asciiToLower`, `asciiToUpper` |

String `indexOf`, `indexOfFrom`, and `lastIndexOf` now return `Option<i64>`
rather than the `-1` sentinel. Use `if let Option.Some(index)`, `!` when presence
is already established, or `??` for an intentional fallback.

Regex compilation now returns `Result<Regex>` rather than `Option<Regex>`;
`Option<RegexMatch>` remains the ordinary no-match result. This separates an
invalid expression from a valid expression that happens not to match.

The old aliases were removed rather than retaining two permanent ways to spell
one operation. `milo api` now shows public types and their methods, excludes
file-private and `@internal` plumbing, and resolves the host platform arm under
the importable module name (for example, `std/regex` rather than
`std/regex.linux`).

## Filesystem operations report failures consistently (2026-07-30)

**What changed.** `std/fs` no longer encodes failed metadata and size probes as
zero-filled records or `-1`: `fileInfo`, `lstatInfo`, and `fileSizePath` return
`Option`. `readDir` returns `Result<Vec<DirEntry>, IoError>`, so a failed read is
distinct from a successful empty directory. Convenience predicates remain
simple booleans. Commands such as `removeFile`, `makeDir`,
`renameFile`, `setMode`, `syncFd`, and `changeDir` now return
`Result<Unit, IoError>` instead of a success boolean that was always true.

`Unit` is auto-imported from the prelude and has one value, `Unit {}`. It is the
success payload for a fallible command that produces no data.

**Migration.** Handle or propagate filesystem errors explicitly:

```milo
let entries = readDir(path)!
if isDir(path) { ... }
removeFile(path)?
```

Code that matched `Result.Ok(true)` from a command now matches
`Result.Ok(_unit)`. Use `fileInfo(path)` when absence is meaningful and an
open/read operation when the exact failure reason matters.

**Why there is no compatibility shim.** The old return values erased the exact
information the new contract preserves. Keeping differently named lossy copies
would leave two filesystem mental models permanently.

## Private by default, `pub` to export (2026-07-23)

**What changed.** Top-level declarations are now **file-private by default**.
Previously every declaration was visible everywhere; now a name is visible only
inside the file that declares it unless it is marked `pub`. Referencing a
non-`pub` declaration from a different file is a compile error. `pub` applies to
`fn`, `struct`, `enum`, `trait`, `type`, `interface`, and globals (`let`, `var`,
`thread_local`).

This is a prerequisite for packages: without a private/public boundary, every
internal helper is somebody's dependency and no library can change anything
without breaking consumers.

**Migration.** Mechanical — mark the public surface of each multi-file project
`pub`. A name used only within its own file needs nothing. A name referenced from
another file gets a `pub` prefix on its declaration:

```milo
fn parse(s: string): Doc { ... }        // before
pub fn parse(s: string): Doc { ... }    // after — if another file imports it
```

Single-file programs are unaffected: nothing crosses a file boundary, so nothing
needs `pub`. Examples and tests are leaves (nothing imports them) and need no
annotation.

**Why there is no compatibility shim.** The break is the point — the old behavior
(everything public) is exactly what the new default removes. There is no setting
that restores it without defeating the feature.

**Failure mode if you miss one.** A compile error naming the private declaration
and the file it lives in, at the cross-file reference site. Nothing silently
resolves to a different symbol.

## `std/os` → `std/platform` (Windows port)

**What moved.** The syscall-shaped bindings that need a per-OS implementation
left `std/os` (and `std/dl`) for the platform split
(`std/platform.darwin.milo`, `std/platform.linux.milo`,
`std/platform.windows.milo`):

- `pipe`
- `mmap`, `munmap`, `mprotect`
- `gettimeofday`, `usleep`
- the 17 `pthread_*` bindings (mutex, condvar, thread create/join)
- `read`, `write`, `open`, `close`, `lseek`, `access`, `getpid`
- `dlopen`, `dlsym`, `dlclose`, `dlerror` (were in `std/dl`)

The fd calls moved because their C shape differs, not just their spelling: the
UCRT declares `int _read(int, void *, unsigned int)` where POSIX has
`ssize_t read(int, void *, size_t)`. Declaring the POSIX widths linked on Windows
(the oldnames shim resolves the symbol) and then miscompiled — a 64-bit return
declared over a 32-bit C `int` return reads undefined high bits, so `-1` could
surface as a large positive `i64`. The rule this establishes: **when a C
declaration differs by platform, it belongs in the platform split, not in a
conditional annotation.** The file name states which C library is described, so
the claim in it is unconditionally true and needs no OS qualifier.

**Migration.** Change the import path; the names and signatures are unchanged:

```milo
from "std/os" import { pipe }        // before
from "std/platform" import { pipe }  // after
```

**Why there is no compatibility shim.** Milo has a flat namespace and no
re-export: a module cannot forward a name it does not define, and defining
`pipe` in both `std/os` and `std/platform` is a duplicate-symbol error, not a
shadow. So the choice was a hard break or two names that can never coexist.
Hard break.

**Why the move at all.** Windows has no `pipe`, no `mmap`, no `pthread_*`. The
platform split is the only conditional-compilation mechanism in the language —
the filename suffix *is* the mechanism, there is no `#[cfg]` — so anything with
a per-OS body has to live there. Leaving them in `std/os` would have meant
`std/os` itself becoming POSIX-only, which is the same break with worse
ergonomics.

**Failure mode if you miss one.** A build error naming the symbol and the
module it is no longer in — `error[import]: 1:1: 'pipe' not found in 'std/os'`.
Nothing silently resolves to a different symbol.
