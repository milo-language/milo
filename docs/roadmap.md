# Milo Roadmap

## Completed

### Core Language

The foundation is complete: primitive types, let/var bindings, if/else, while/for loops, functions, structs, enums with pattern matching (exhaustiveness checked), generics with monomorphization and type inference, move semantics with use-after-move detection, second-class references (`&T`/`&mut T` in params only), closures (including escaping/move closures), traits with static dispatch and `@derive(Eq)`, operator overloading via traits, `Heap<T>`, `Option<T>`, `Result<T,E>` with `!`/`?`/`??` operators, string interpolation, bitwise operators, hex/binary literals, type casts, for-in loops over ranges/Vec/array/string/HashMap, HIR-based typed IR, and Go-style interfaces with structural typing and vtable-based dynamic dispatch.

### Type System & Safety

- **Ownership**: single-owner move semantics, compiler-tracked drops, no GC
- **Null safety**: `Option<T>` — no null pointers in safe code
- **Race safety**: `Send`/`Sync` traits — compiler rejects data races at `spawn()` boundaries
- **Overflow safety**: compile-time range checks + debug-mode traps via LLVM overflow intrinsics
- **No implicit coercion**: explicit `as` casts only
- **Ranged integers (L1+L2)**: `type Altitude = i32(0..50000)` with range propagation through arithmetic

### Concurrency

Full concurrency stack, from OS threads to lightweight green threads to structured promises:

- **OS threads** (`std/thread`): `Thread.spawn()` with move closures, `Thread.join()`
- **Synchronization** (`std/sync`): `Mutex`, `RwLock`, `Channel<T>` (bounded FIFO, multi-producer, blocking + non-blocking), `AtomicI64`, `AtomicBool`
- **Green threads** (`std/runtime`): stackful coroutines via ucontext (64KB stacks, guard pages, kqueue/epoll), cooperative scheduling, transparent async I/O — `stream.recv()`/`stream.send()` auto-yield on EAGAIN
- **Promises** (`std/runtime`): `Promise<T>.run()`, `.await()`, `Promise.all()`, `Promise.race()` — structured concurrency over green threads
- **Task API** (`std/runtime`): `Task.spawn()` for fire-and-forget lightweight concurrency
- **No async/await**: write normal blocking code — it yields automatically in green thread context

### Standard Library (44 modules)

I/O & system: io, fs, path, env, args, process, signal
Networking: net, http, url
Data: json, csv, toml, base64, hex, sqlite, arena, set
Concurrency: thread, sync, runtime, event
Strings: string, fmt, strconv, unicode, regex
Math: math, random, sort
CLI: argparse, color, log
Crypto: crypto
Time: time, datetime, uuid
Testing: testing
Memory: mem

### Developer Experience

- **LSP server**: diagnostics, hover, go-to-definition, completions, code lens
- **VS Code extension**: syntax highlighting + LSP client
- **Formatter** (`milo-fmt`): context-sensitive formatting, LSP integration (written in Milo)
- **Package manager** (`milo-pkg`): init, new, add, install, git-based cache with lockfile (written in Milo)
- **Test framework**: `@expect:`/`@error:` annotations, `milo test` runner
- **Example apps**: web servers (7), CLI tools (jq, grep, rg, cat, wc, tree, calc, hex, timeout, fmt)
- **GitHub Actions CI**: build + test on push/PR, release pipeline
- **Playground**: browser-based compiler via JS backend (in progress)

### Self-Hosting (Stage-0 Complete)

`milo0` — a Milo compiler written in Milo — compiles a substantial subset: primitives, functions, let/var, if/else/while, structs (construct + field access + mutation), enums (payload-free + single/multi-field payloads + match), `Heap<T>` with deref, strings (literals, slice, index, concat, clone, len, eq), closures, `as` casts, bitwise ops. Verified on `examples/fib.milo`, `examples/fizzbuzz.milo`, `examples/hello.milo`.

---

## In Progress

### Self-Hosting — Stage-1

Blocking full milo0-on-milo0:

- [ ] `Vec<T>` in milo0 — 84 use sites, biggest blocker
- [ ] `String.push` in milo0 — needs mutation-through-self + realloc
- [ ] Port type checker, HIR, lower, codegen to Milo

End goal: compiler compiles itself, producing equivalent IR for the full Milo source set.

---

## Planned

### Runtime Maturity — `node-milo`

`node-milo` is the current stress test for Milo as an implementation language. If a missing feature keeps runtime logic in C++ or forces raw pointer arithmetic in Milo, it moves up the roadmap.

- [ ] Move more `internalBinding()` implementations out of C++ and into Milo
- [ ] Track success by Node compat %, shrinking C++ glue, and keeping `unsafe` contained to binding seams
- [ ] **V8 C API wrapper — eliminate bridge/*.cpp entirely**. Currently `bridge/core.cpp`, `bridge/fs.cpp`, `bridge/timers.cpp` (1235 lines of C++) exist solely because V8 has no C API — every binding must extract V8 args and return V8 values through C++ types (`FunctionCallbackInfo<Value>&`, `HandleScope`, etc.). The fix: write a single `v8_c_api.cpp` that wraps V8's C++ API in `extern "C"` functions (`v8c_get_string_arg`, `v8c_return_int`, `v8c_throw_error`, etc.), then `declare` those in Milo and move all binding orchestration into `.milo` files. This collapses the three-layer architecture (JS → C++ glue → Milo) into two layers (JS → Milo via V8 C wrapper). For reference, even bun (which uses JSC's C API from Zig/Rust) still has 153K lines of C++ — our 1.2K line bridge is already thin, but eliminating it makes the codebase purely Milo + one mechanical C wrapper.

### Safety Hardening

See **[docs/safety-roadmap.md](safety-roadmap.md)** for the full plan. Summary:

1. `unsafe` blocks — quarantine FFI and low-level code behind a grep target
2. Flow-sensitive invalidation tracking — catch aliased mutation at compile time (ref-while-frozen, use-after-invalidate, arena scope tainting)
3. Interprocedural exclusivity — reject aliasing `&var` + `&` at call sites, purity inference, arena lifetime scoping
4. Dynamic fallback — debug ref counting and sanitizer mode for patterns static analysis can't reach
5. Safety profiles — `default`, `strict` (aircraft-grade), `performance`
### Language

Runtime pressure from `node-milo` changes the order here: binary data and FFI safety land before more expressive abstractions.

- [ ] **CStr / fromCStr** — safe wrapper for NUL-terminated C strings (`*u8`). `CStr.from(ptr): CStr` + `.toString(): String` + safe indexed access with bounds checking against the NUL terminator. Eliminates raw pointer arithmetic in FFI code — currently every `node-milo` binding uses `unsafe` just to read C strings (e.g. `_isDotEntry` byte checks, `env.milo` manual copy loops).
- [ ] **Unused import warnings** — compiler should warn (or error) on imported symbols that are never used in the module. Currently `main.milo` imports all binding symbols just so they link, but ideally re-exports or `pub` declarations in binding modules would handle this without polluting the import list.
- [ ] **Borrowed slices / byte views** — `&[T]` / `&mut [T]`, with slicing generalized beyond `string`. Unblocks offset/length I/O, `Buffer`/`ArrayBuffer` interop, and zero-copy protocol parsing.
- [ ] **Opaque foreign handle types** — `extern type sqlite3`, `extern type SSL`, `extern type NmRuntime` instead of raw `*u8`. Keeps FFI zero-cost while preventing handle mixups.
- [ ] **C ABI / layout control** — `repr(c)`, packed structs, `sizeof`, `offsetof`, `extern struct`. Needed for `epoll_event`, `kevent`, `stat`, `addrinfo`, V8 glue, and other platform/FFI structs.
- [ ] **Structured OS / syscall errors** — `OsError`/`SysError` carrying `errno`/code plus syscall/path context. Needed for runtime bindings, better diagnostics, and Node-compatible error surfacing.

- [x] **Interfaces (runtime polymorphism)** — Go-style interfaces with structural typing and vtable dispatch. `interface Shape { fn area(self: &Self): f64 }` — any type with matching methods satisfies the interface. Separate from traits (which remain compile-time only).
- [ ] **Heap\<Interface\> + heterogeneous collections** — `Vec<Heap<Shape>>` for mixed-type collections via heap-allocated interface values.
- [ ] **Iterators** — iterator trait, `.map().filter().collect()` chains, lazy evaluation. Needs associated types.
- [ ] **Error conversion** — `From` trait for automatic error conversion in `?`, `anyhow`-style boxing.
- [ ] **Ranged integers L3** — branch narrowing: after `if x < 50`, x is known `(min..49)` in the then-branch.
- [ ] **MIR** — lower-level IR for optimization passes (post self-hosting)

### Tooling

- [ ] **LSP: rename + find references**
- [ ] **Doc comments + generation** — `///` comments, `milo doc` to generate HTML/markdown
- [ ] **Cross-compilation** — `--target aarch64-linux` etc. (infrastructure exists in target.ts, needs CLI flag + sysroot handling)
- [ ] **Benchmarking** — `@bench` annotations, `milo bench` runner
- [ ] **Documentation / tutorials / "the book"**

---

## Known Bugs

- [x] ~~**Missing `linkonce_odr` linkage**~~ — fixed: all non-main functions now emit `define linkonce_odr`, eliminating duplicate symbol errors when the same monomorphized generic or prelude function appears in multiple compilation units.
- [x] ~~**Duplicate symbol errors from prelude**~~ — resolved by `linkonce_odr` fix above.
- [x] ~~**No module-level state**~~ — fixed: `let` and `var` at module scope now work everywhere. Parser, checker, lower, and codegen all handle `GlobalDecl` nodes. Emitted as LLVM `internal global`. Supports int/float/bool literal initializers.
- [x] ~~**Large array codegen crash (>=65536 bytes)**~~ — fixed: aggregate types (arrays, structs) no longer fall through to the scalar trunc/ext cast path in genCast.
- [x] ~~**Codegen: `break`/`continue` skip drop cleanup**~~ — fixed: break and continue now emit `emitLoopDropGlue()` for loop-local owned values before branching. All 6 loop variants (while, for-range, for-each vec/string/array/hashmap) track `loopDropStart`.
- [x] ~~**No `string` → `*u8` cast**~~ — fixed: `"literal" as *u8` and `myString as *u8` now work in unsafe blocks. Codegen extracts the data pointer from the String struct.
- [x] ~~**`string` not coercing to `*u8` in all positions**~~ — fixed: string→`*u8` coercion now works in let/var declarations, assignments, and return statements, in addition to function call arguments.
- ~~**Variadic ABI corruption on ARM64**~~ — investigated: variadic support already implemented (parser, AST, codegen all handle `...`). Not a bug.

## Missing Stdlib Bindings

- [ ] **`execvp`** — needed for tools that exec subcommands with argument arrays (timeout, xargs, env). Currently must route through `system()` which double-forks through `/bin/sh`.
- [ ] **`alarm` / `setitimer`** — enables signal-based timeouts without polling loops
- [ ] **`setpgid` / `killpg`** — process group control for proper job management in tools like timeout
