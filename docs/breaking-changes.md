<!-- doc-meta
system: breaking-changes
purpose: source-level breaks users have to act on, with the migration and the reason a compat shim was impossible
key-files: std/platform.*.milo, std/os.milo
update-when: a public stdlib name moves, is renamed, or changes signature
last-verified: 2026-07-23
-->

# Breaking changes

Source-level breaks, newest first. Milo is pre-1.0 and does not promise
compatibility, but every break belongs here with the migration spelled out.

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
