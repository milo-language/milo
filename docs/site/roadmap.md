# Milo Roadmap

## Completed

### Core Language

The foundation is complete: primitive types, let/var bindings, if/else, while/for loops, functions, structs, enums with pattern matching (exhaustiveness checked), generics with monomorphization and type inference, move semantics with use-after-move detection, second-class references (`&T`/`&mut T` in params only), closures (including escaping/move closures), traits with static dispatch and `@derive(Eq)`, operator overloading via traits, `Heap<T>`, `Option<T>`, `Result<T,E>` with `!`/`?`/`??` operators, string interpolation, bitwise operators, hex/binary literals, type casts, for-in loops over ranges/Vec/array/string/HashMap, and HIR-based typed IR.

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
- **Example apps**: web servers (7), CLI tools (jq, grep, cat, wc, tree, calc, hex)
- **GitHub Actions CI**: build + test on push/PR, release pipeline
- **Playground**: browser-based compiler via JS backend (in progress)

### Self-Hosting (Stage-0 Complete)

`milo0` — a Milo compiler written in Milo — compiles a substantial subset: primitives, functions, let/var, if/else/while, structs (construct + field access + mutation), enums (payload-free + single/multi-field payloads + match), `Heap<T>` with deref, strings (literals, slice, index, concat, clone, len, eq), closures, `as` casts, bitwise ops. Verified on `examples/fib.milo`, `examples/fizzbuzz.milo`, `examples/hello.milo`.

---

## In Progress

### Self-Hosting — Stage-1

Pivoted from growing milo0 to a bottom-up port of the full compiler (`src-milo/`):

- [x] Lexer + parser ported to Milo
- [ ] Type checker — expr + stmt done; generics + traits remaining
- [ ] HIR + codegen — partial
- [ ] Bootstrap: compiler compiles itself, producing equivalent IR for the full Milo source set

---

## Planned

### Runtime Maturity — `node-milo`

`node-milo` is the current stress test for Milo as an implementation language. If a missing feature keeps runtime logic in C++ or forces raw pointer arithmetic in Milo, it moves up the roadmap.

- [ ] Move more `internalBinding()` implementations out of C++ and into Milo
- [ ] Track success by Node compat %, shrinking C++ glue, and keeping `unsafe` contained to binding seams

### Language

Runtime pressure from `node-milo` changes the order here: binary data and FFI safety land before more expressive abstractions.

- [ ] **Borrowed slices / byte views** — `&[T]` / `&mut [T]`, with slicing generalized beyond `string`. Unblocks offset/length I/O, `Buffer`/`ArrayBuffer` interop, and zero-copy protocol parsing.
- [x] **Opaque foreign handle types** — `extern type sqlite3`, `extern type SSL` instead of raw `*u8`. Zero-cost FFI, no handle mixups.
- [ ] **C ABI / layout control** — `repr(c)`, packed structs, `sizeof`, `offsetof` (`extern struct` landed). Needed for `epoll_event`, `kevent`, `stat`, `addrinfo`, V8 glue, and other platform/FFI structs.
- [ ] **Structured OS / syscall errors** — `OsError`/`SysError` carrying `errno`/code plus syscall/path context. Needed for runtime bindings, better diagnostics, and Node-compatible error surfacing.

- [x] **Interfaces (runtime polymorphism)** — Go-style interfaces with structural typing and vtable dispatch. `interface Shape { fn area(self: &Self): f64 }` — any type with matching methods satisfies the interface. Separate from traits (which remain compile-time only).
- [ ] **Heap\<Interface\> + heterogeneous collections** — `Vec<Heap<Shape>>` for mixed-type collections via heap-allocated interface values.
- [ ] **Iterators** — iterator trait, `.map().filter().collect()` chains, lazy evaluation. Needs associated types.
- [ ] **Error conversion** — `From` trait for automatic error conversion in `?`, `anyhow`-style boxing.
- [ ] **Ranged integers L3** — branch narrowing: after `if x < 50`, x is known `(min..49)` in the then-branch.
- [ ] **Safety profiles** — `--strict-ranges` (require ranged types on all integers), `--no-unwrap` (ban `!` — force exhaustive error handling). Aircraft-grade opt-in.
- [ ] **MIR** — lower-level IR for optimization passes (post self-hosting)

### Tooling

- [ ] **LSP: rename + find references**
- [ ] **Doc comments + generation** — `///` comments, `milo doc` to generate HTML/markdown
- [ ] **Cross-compilation** — `--target aarch64-linux` etc. (infrastructure exists in target.ts, needs CLI flag + sysroot handling)
- [ ] **Benchmarking** — `@bench` annotations, `milo bench` runner
- [ ] **Documentation / tutorials / "the book"**
