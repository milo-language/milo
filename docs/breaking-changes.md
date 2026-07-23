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

## `std/os` → `std/platform` (Windows port)

**What moved.** The syscall-shaped bindings that need a per-OS implementation
left `std/os` for the platform split (`std/platform.darwin.milo`,
`std/platform.linux.milo`, `std/platform.windows.milo`):

- `pipe`
- `mmap`, `munmap`, `mprotect`
- `gettimeofday`, `usleep`
- the 17 `pthread_*` bindings (mutex, condvar, thread create/join)

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
