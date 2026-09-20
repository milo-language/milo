<!-- doc-meta
system: planning
purpose: canonical status — what shipped, what is in flight, what is planned, what was retired
key-files: docs/backlog.md (ROI ordering over the open items), docs/safety-roadmap.md, docs/self-hosting.md, docs/verification-roadmap.md
update-when: a feature ships, a track is abandoned, or a new track opens
last-verified: 2026-08-23 (self-host endgame decided proof-only and src-milo frozen; packages ecosystem at 8 published with an install-and-build gate; green main; counts re-measured)
-->

# Milo Roadmap

Status source of truth. [backlog.md](backlog.md) ranks the *open* items by return-on-investment; this file records what is true.

Shipped items are one-liners here — git history and the linked design docs keep the debugging record.

---

## Completed

### Core Language

Primitive types, `let`/`var`, if/else, while/for, functions, structs, enums with exhaustiveness-checked pattern matching, generics with monomorphization and inference, move semantics with use-after-move detection, second-class references (`&T`/`&mut T` in params only), closures (including escaping/move closures), traits with static dispatch and `@derive(Eq)`, operator overloading, Go-style interfaces (structural typing, vtable dispatch), `Heap<T>`, `Option<T>`, `Result<T,E>` with `!`/`?`/`??`, auto-`From` error conversion through `?`, `let`-else, string interpolation, bitwise ops, hex/binary literals, `as` casts, for-in over ranges/Vec/array/string/HashMap and any type with `next(&mut Self): Option<T>`, slicing on Vec/array/string, `pub`/private visibility with per-file enforcement, `@embedFile`, `@externalLinkage`, `@targetOs()`, HIR-based typed IR.

Diagnostics carry "did you mean" suggestions on a missed method, field, or name — from an alias table for other languages' spellings (`length`, `toUpperCase`, `forEach`, `unwrap`) as well as edit distance — and a failed static call reports the real mistake (unknown type / no such static method / missing import, with the `from "std/x" import { Y }` line written out) instead of the old blanket "unknown enum". A plain string holding `${name}` warns (`missing-interpolation`) rather than silently emitting the characters.

### Type System & Safety

- **Ownership**: single-owner moves, compiler-tracked drops, no GC, no RC
- **Null safety**: `Option<T>` — no null in safe code
- **Race safety**: structural `Send`/`Sync`, checked at `spawn()`/`Promise.blocking` boundaries
- **Overflow safety**: compile-time range proof + runtime traps on `+ - * -x` (and shift-out-of-range, div-by-zero, `INT_MIN / -1`) in **all** build modes; `--no-overflow-checks` / `--fast` opt back into wrapping for `+ - *`, `.wrappingAdd`/`.saturatingAdd`/`.checkedAdd` name it per op. The silent release wrap was the one inherited footgun (Ethos #1). Cost measured across the benchmark suite on 2026-08-23, macOS/aarch64 (reproduce with `sh benchmarks/run-overflow.sh`; results land in a gitignored `benchmarks/results-*.md`): **0–2%** on float, parsing and allocation-bound work, **~19%** on byte scanning, and **up to 1.30x** on tight loops over unconstrained integers. The earlier "~+8% worst case, `matmul` emits zero traps" note was wrong on both halves — `matmul` emits 100 overflow intrinsics (they are dwarfed by the f64 work, which is why it still times at 1.01x), and `fib` measures 1.30x. The range prover discharges what it can, but an unconstrained `i64` parameter cannot be discharged, and branch narrowing (ranged integers L3, planned) is what would close the rest: `n - 1` guarded by `if n < 2` is provably safe and still emits a check. A trap `abort()`s for a supervisor-visible abnormal exit and a core dump
- **`unsafe` blocks**: required for deref, pointer indexing, address-of, pointer casts, `zeroed<T>()`, unsafe-signature extern calls; unused-`unsafe` lint on by default
- **Borrow invalidation**: ref-while-frozen and use-after-invalidate for built-in borrows; call-site exclusivity (`f(&mut v, &v[0])` rejected)
- **Arena safety**: identity + generation validation at runtime for `Arena<T>`/`Handle<T>`
- **No implicit coercion**: explicit `as` casts only
- **Ranged integers (L1+L2)**: `type Altitude = i32(0..50000)`, range propagation through arithmetic
- **Off-by-default warnings** promotable with `--deny=`: `unused-move`, `unused-import`, `unverified-extern`, `large-stack-array`

See [safety-roadmap.md](safety-roadmap.md) for the enforced-vs-remaining breakdown and the explicit trust boundaries; [memory-safety-vs-rust.md](memory-safety-vs-rust.md) for the 13-probe battle test (0 UB misses **on those probes** — that is the scope of the claim, not a general one).

### Contracts & Proving

- `requires` / `ensures` on functions, `invariant` on `while` **and** `for in` loops and on structs, `decreases` termination measures, and `old(e)` for a parameter's entry value; runtime asserts at `--debug`, forced either way with `--contract-checks` / `--no-contract-checks` (`decreases` is static-only — there is nothing for a runtime check to assert)
- The compiler rejects violations it can see statically
- **`milo prove`** discharges obligations through **`std/smt`** — a solver written *in Milo* (Fourier-Motzkin over linear scalar arithmetic), dogfooding the language on its own verification. `--solver=z3` swaps in Z3 for non-linear arithmetic; `--emit-smt` prints SMT-LIB2 instead of solving; `--all` includes imported stdlib
- Loop invariants proved by induction, on both loop forms. A `for` loop needs no invariant about its own index: the range supplies `lo <= i < hi` inside the body and the invariant is carried to the final index on exit
- **Struct invariants** are two-sided — assumed wherever a value of the type is observed, and owed at every struct literal and every `&mut` function that could break one. A use-site proof resting on an invariant this run could not establish everywhere is reported as conditional, not clean
- **Frame conditions**: `ensures h.count.len == old(h.count.len)` survives across a call. A `&mut` argument is havoced at the call site (keeping the walker sound), and the callee's contract is what puts the information back — without it a mutating callee taught its caller nothing
- **Termination**: a self-recursive call is modelled by assuming the function's own `ensures`, which is induction; `decreases` discharges the well-foundedness it needs. Without a measure the proof is reported as conditional on a termination nothing checked
- Callee `ensures` are assumed only under the callee's `requires` (the bare form let a call-site precondition prove itself)
- `unknown` is reported as unknown, never as proven — an i64 overflow inside the elimination degrades the verdict rather than producing a false proof

This is roughly SPARK's contract vocabulary (`Pre`/`Post`/`Loop_Invariant`/`Type_Invariant`/`Loop_Variant`/`Subprogram_Variant`/`'Old`) and lands at their "silver" level: absence of runtime error, plus termination and simple data invariants — not functional correctness.

Known frontier (tracked in backlog Tier 1 #1–#3 and Tier 2 #2/#3/#12): **no quantifiers** — `forall`/`exists` over container contents is unstateable, so sortedness cannot be specified and binary search cannot be verified; no bitvector theory (`&`, `<<`); no `IndexAccess` reasoning; no `Vec.len` through a builder; and *intermediate* arithmetic carries no range, so derived values can be refuted by inputs no real i32 could produce. `milo verify` remains as a deprecated alias for `prove`.

### Safety Profiles, WCET, Bare Metal

- **`milo safety --list` / `--safety=<profile>`**: DO-178C DAL A/B/C, ISO 26262 ASIL A–D, NASA Class A/B, IEC 61508 SIL 3
- **`milo wcet`**: OTAWA flow facts (loop bounds) plus cycle estimates
- **Bare-metal targets**: `cortex-m0/m3/m4/m4f/m7` (plus `rp2040`/STM32 aliases) — freestanding, QEMU machine per target, `--heap-size=<N>` cap, working heap (`Vec`/`String` over a bump allocator), OOM surfaces as `ENOMEM`. A reclaiming allocator is deliberately not planned.
- **Bare metal is integer-only.** The link is `-nostdlib` with no compiler-rt, so float arithmetic and 64-bit division — which clang lowers to helper calls (`__aeabi_dmul`, `__aeabi_ldivmod`) — have no library to resolve them. Both are refused with a named diagnostic pointing at fixed-point; `examples/embedded/pidStep.milo` is a Q16.16 PID kernel. Linking a builtins library is deliberately not planned: integer-only is what makes the WCET story clean.
- **`--target=wasm64`**: freestanding, like bare-metal (`tools/wasm/runtime.c` is the wasm64 analog of `startup.c`: bump allocator w/ `--heap-size`, `__multi3`, a narrow printf-family), but with a real growable heap and JS-host I/O (`env.fd_write`/`env.get_random`/`env.proc_exit`) instead of a linker script + semihosting. `tools/wasm/run.mjs` is the loader (`milo run --target=wasm64` shells out to it); needs Node, not Bun — Bun 1.3.10 (JavaScriptCore) rejects memory64 modules outright, Node 25 (V8) runs them unflagged. wasm32 is out of scope: Milo's codegen assumes an 8-byte size_t/pointer everywhere, which only wasm64 matches. Floats print and parse with the same shortest-round-trip output as a native build — `runtime.c` carries an exact big-integer dtoa (Steele & White) and a correctly-rounded strtod, because codegen's `@milo.fmt.f64` prints with `snprintf("%.*g")` and re-parses with `strtod` until the text reads back bit-identical, so an approximate converter would silently pick the wrong digit count. `tools/wasm/float-diff.sh` is the proof: two probes diffed byte for byte against the host libc. Still missing: threads/async/net/fs/sockets (std/runtime's coroutine scheduler has no wasm equivalent short of an Asyncify/CPS rewrite) and struct-by-value extern calls — `std/platform.wasm.milo` fails loudly on all of it.

### Concurrency

Green-tier concurrency with one OS-thread escape hatch:

- **Green threads** (`std/runtime`): stackful coroutines (ucontext / Win32 fibers), 64KB stacks with guard pages, kqueue/epoll/Win32-event backends, transparent async I/O — `recv`/`send` auto-yield on EAGAIN
- **Promises**: `Promise<T>.run()`, `.await()`, `Promise.all()`, `Promise.race()`, `p.channel()` to arm one in a `Select`
- **Tasks**: `Task.spawn()`, `Task.join()`, `WaitGroup`, Go-style exit semantics
- **`Promise.blocking()`**: the one OS-thread escape hatch for CPU-bound work or blocking FFI, `Send`-checked captures
- **`std/sync`**: `Channel<T>` (bounded FIFO, multi-producer, blocking + non-blocking), `AtomicI64`, `AtomicBool`
- **`std/select`**: fd, timer, channel, promise and child-exit arms
- **No async/await** — blocking-shaped code yields automatically in green context
- **`main` is itself a green task** wherever the program can reach `spawn`. Before this, a blocking call in `main` starved the very tasks that would satisfy it — `main` ran on the OS thread and nothing else could progress. Codegen decides this per program, so a program with no spawn keeps a plain `main`. Std APIs that block must therefore branch on `schedulerCurrent()` rather than assume they are off-scheduler
- Public `Thread`/`Mutex`/`RwLock`/`parallel` were **removed** 2026-07-10 (green tier only — see [concurrency-simplification.md](concurrency-simplification.md))

### Standard Library (<!-- stat:std-modules -->83<!-- /stat --> modules)

I/O & system: `io`, `fs`, `path`, `env`, `environ`, `args`, `process`, `signal`, `dl`, `sysinfo`, `mem`, `os`, `platform`, `term`, `pty`, `keys`, `ansi`, `foreign` (views over memory C allocated)
Networking: `net` (TCP + DNS), `unix` (AF_UNIX), `fetch` (HTTPS client + TLS), `tls` (TLS server transport), `https` (HTTPS server), `http`, `httpmw`, `multipart`, `mime`, `html`, `ws`, `url`
Data: `json`, `csv`, `base64`, `base32`, `hex`, `binary`, `sqlite`, `arena`, `seal`, `shard`, `set`, `pool`, `png`
Compression: `deflate`, `inflate`, `zip`, `zstd`
Crypto & auth: `crypto`, `sha256`, `sha512`, `sha1`, `hmac`, `hkdf`, `pbkdf2`, `subtle`, `jwt`, `totp`, `checksum`, `xxhash`
Concurrency: `runtime`, `sync`, `select`, `event`, `timer`
Strings: `string`, `fmt`, `strconv`, `unicode`, `regex`, `cstr`
Math & verification: `math`, `random`, `rng`, `sort`, `smt`

The supported surface follows [the stdlib design](stdlib-design.md): `milo api`
hides private/internal plumbing, commands use `Result<Unit>`, ordinary absence
uses `Option`, constructors and receiver operations have one discoverable shape,
and ASCII byte APIs state their representation.
CLI: `argparse`, `color`, `log`
Time: `time`, `datetime`, `uuid`
Testing: `testing`
Prelude: `prelude`

(100 files — several modules are platform splits.) Discover signatures with `milo api <terms>`; dump a module with `milo api --module std/<name>`.

TLS clients verify certificates (`SSL_VERIFY_PEER` + hostname binding), and `std/https` serves HTTPS over the same OpenSSL binding; JSON parsing is RFC 8259-strict with a lenient `jsonParseJsonc` and a `jsonPull` streaming tokenizer.

### Self-Hosting — Bootstrap Converges, and the Endgame Is Decided

`milo0` (`src-milo/`, ~37.9K lines across 32 files) — the Milo compiler written in Milo — compiles its own source to a **byte-identical fixed point at the production `-O2` level**: `stage1 == stage2 == stage3`. 590 fixtures pass under `milo-self` (`tests/selfhost-manifest.txt` is the ratchet); 118 of 255 negative tests behave correctly under it.

**The endgame was decided 2026-08-09: proof-only. `src-milo/` is frozen at the fixpoint and `src/` is not going away.** The rule was precommitted in [selfhost-endgame-decision.md](selfhost-endgame-decision.md) *before* the census that feeds it, precisely so a histogram read afterwards could not be narrated into whichever answer was already wanted. It measured N = 99 silent accepts (unsoundness — programs milo-self compiles that it must reject), of which misscoped-plus-uncalled came in at **14 of 99 where the replacement rule needed 50%**. So the fixpoint is the deliverable, banked; the sync tax stops.

That freeze is why `src-milo/` has had no commits since 2026-08-09, and it is deliberate — not neglect.

See [self-hosting.md](self-hosting.md) for the M0–M5 milestone log and the eight oracle miscompiles the self-compile exposed and fixed.

Reproduce: `sh scripts/selfhost.sh` (builds stage1 via the oracle — required; `.selfhost/milo-self.bin` is gitignored), then `bun test tests/selfhost.test.ts`. CI runs the fixpoint and the soundness/HIR ratchets on any commit touching `src-milo/`, `std/`, or the selfhost scripts, and sweeps every fixture nightly. **Never run `.selfhost/milo-self.bin` bare** — see the memory guards in CLAUDE.md.

### Platforms

- **darwin + linux**, aarch64 + x86_64 — full support, both CI-tested
- **Windows x64/arm64** — partial; core language, `std/io`, process, crypto hashing, ConPTY, plain TCP and the non-fd/socket green tiers all run as native PEs, CI-verified on `windows-latest`. Shipped pieces: COFF via `lld-link`, UCRT divergences (`_write`/`__acrt_iob_func`), Microsoft x64 struct ABI, platform splits for `platform`/`event`/`random`/`term`/`environ`/`sysinfo`/`crypto`/`pty`/`os` fd calls, pthreads over `SRWLOCK`/`CONDITION_VARIABLE`, green scheduler over `CreateFiber`, sockets over Winsock with `WSAEventSelect` readiness, `CreateProcess` for `fork`/`waitpid`/`kill`, cross-target `@cLayout`/`@cSig` verification against the xwin SDK, and the `std/net`→`std/fetch` split that lets a plain-TCP program link without OpenSSL. Remaining tiers are in In Progress. Dev loop: `xwin splat` + `MILO_WINDOWS_SDK`, sweep under Wine with `bun scripts/windows-sweep.ts` — but CI's `test-windows` job is the authority on real-OS execution. See [breaking-changes.md](breaking-changes.md) for the `std/os` → `std/platform` relocation it required.
- Remaining `// @skip-os: win32` fixtures carry their reason inline — the skip list *is* the remaining port work, item by item.

### C Interop

- Safe extern calls when args coerce safely and the return is scalar/void; `string.cstr()`, `extern type` opaque handles, pointer-to-struct field access, typed fn-pointer params, `std/cstr`
- **`@cLayout` / `@cSig`** verify extern struct layouts and function signatures against the real system headers by compiling a throwaway TU at build time — cross-target too, when a sysroot is available. `@cSig` checks each parameter's width and, for a pointer, its **pointee's** width, which is what an out-param's contract actually is (`*u8` is the documented opt-out for `void *` and pointees Milo doesn't model). Each header is included behind its own `__has_include` and can name per-platform alternates, so an absent header skips only its own claims, by name, instead of silently unverifying the whole program. `--deny=unverified-extern` reports every unannotated extern struct *and* fn. `scripts/audit-extern-returns.ts` sweeps return types with no annotations required; std is clean on macOS and Linux
- Variadic externs are checked against libc's real fixed-param count (a wrong arity miscompiles silently on AArch64 — it found a live `execl` bug in our own `std/process`)
- Struct-by-value across the C ABI (`abi.ts`) for System V and Microsoft x64
- **Consuming Milo from C**: `emit-obj`, `build-lib` (static `.a`), and generated C headers declaring the `pub` surface
- **Foreign memory** ([foreign-memory.md](foreign-memory.md)): `std/foreign`'s `withRaw`/`withRawMut` lend a closure a real `&[T]`/`&mut [T]` over a `(ptr, len)` C pair, and `?&mut T` / `?&T` is the nullable extern reference — a parameter of an `extern` / `@externalLinkage` fn whose ABI is exactly `T *`, unwrapped with `let g = p else { … }` and an ordinary second-class `&mut T` after that. Neither adds a reference kind, a lifetime or a rule. Still unbuilt from that doc: `adopt` (the inverse of `forget`) and typed extern fn-pointer values

### Developer Experience

- **LSP**: diagnostics, hover, go-to-definition, completions, code lens, document symbols, workspace symbols, code actions, signature help, inlay hints, references, document highlight, rename, formatting
- **VS Code extension**: syntax highlighting + LSP client
- **Formatter**: `milo fmt` — written in Milo (`fmt.milo` is the only implementation)
- **Package manager**: `milo init/new/add/remove/install/update/tree/why/vendor/publish` plus `tool install/uninstall/list/run`, git-based cache with a lockfile, GitHub repos as the registry, per-package name mangling. Folded into the one `milo` binary. See [plans/package-manager.md](plans/package-manager.md)
- **Published packages (8)**: postgres, redis, markdown, toml, yaml, json-rpc, gl, sdl — indexed on [the packages page](site/packages.md), each graded against something that is *not itself* (CommonMark's 655 spec examples and `cmark`, Python's `tomllib`, a real PostgreSQL requiring SCRAM, a real Redis, `ruamel.yaml`). `scripts/ecosystem-check.ts` is the gate that installs each one from GitHub and builds it against this checkout — added after two packages shipped green in-repo and uninstallable to everyone else, for two different reasons (a string global invisible to its own package's functions, and a capitalised global parsing as an enumlit and recovering by a value lookup that mangling had already renamed away)
- **Docs from source**: `milo doc <file|dir>` generates reference markdown from doc-comments; `milo api <terms>` searches std signatures
- **Test framework**: `@expect:`/`@error:` annotations, `milo test` runner — <!-- stat:fixtures -->692<!-- /stat --> fixtures, <!-- stat:error-fixtures -->337<!-- /stat --> error fixtures, <!-- stat:prove-fixtures -->33<!-- /stat --> prove fixtures
- **Fuzzers**: `scripts/fuzz-frontend.ts` (2 bugs per 150k mutants) and `scripts/fuzz-ownership.ts`, which grades ownership bugs under a *real* ASan oracle. Two silent-success bugs were found in the harness itself before it graded anything: `--sanitize` linked the ASan runtime but instrumented nothing, so every use-after-free read passed while the interceptors kept the sanitizer looking alive; and the fuzzer graded a UAF by whether the freed bytes happened to be reused. Surface coverage is 27 of 39 expression and statement forms, now composed at depth 5–7 rather than emitted alone at the top level of `main` — a generator can reach 39/39 wide and still test nothing about how the rules compose
- **Benchmarks**: `benchmarks/run.sh` with per-benchmark `results-*.md` (fib, binarytrees, grep, json, matmul, maplookup)
- **JS target**: `milo emit-js` — the playground on the docs site runs the compiler output in-browser
- **CI**: build + test on push/PR across macOS-arm64, linux-x64 and Windows-x64 (**no linux-arm64 — see In Progress**); release pipeline with `--static-deps` static linking (built on ubuntu-22.04 runners for glibc compatibility, never musl)
- **Ratchets** — monotone gates that fail the build on a regression rather than on a threshold someone has to remember: the leak baseline (`tests/leak-clean.txt`, via `leaks -atExit`; no LSan on macOS), the `src-milo` HIR re-derivation count (115 sites, monotone to zero, and raising it needs an explicit flag *and* a written reason), the proven-contract floor (losing a proof fails the build, so a contract silently degrading from `proven` to `unknown` is caught), the selfhost fixture manifest, and the emit-js parity baseline. Every one of these keys fixtures by filename, so renaming a fixture reads as a regression and a new fixture at once
- **Examples**: 160 `.milo` files over nine domains — `basics/` (9), `cli-tools/` (16), `net/` (10), `graphics/` (8), `games/` (99, mostly the multi-file apsis/neon/flight projects), `simulation/` (6), `terminal/` (6), `embedded/` (2), `tools/` (3). Treated as integration smoke tests for stdlib changes. The census grades what **ran**, not what compiled, and names the unverified rest — it used to report building as passing
- **Debugging**: `-g` emits DWARF that composes with any `-O`; the DAP debugger lives in [milo-language/dapweb](https://github.com/milo-language/dapweb)

---

## In Progress

### Platform Coverage — the linux-arm64 hole

- [ ] **CI has no linux-arm64 runner.** The matrix is macOS-arm64, linux-x64 and Windows-x64. Nothing in this repo exercises linux-arm64 codegen, and the gap is not theoretical: milojs's release job — which builds against this compiler's rolling `latest` — has aborted on that target since 2026-08-15 with `free(): invalid pointer` on a hello-world, while linux-x64 and darwin-arm64 are clean. A `ubuntu-22.04-arm` runner belongs in `ci.yml`, and the failure should be reproduced here rather than diagnosed downstream

### Windows — Remaining Tiers

- [ ] **Pipe readiness** (~3 fixtures) — `WSAEventSelect` is sockets-only and a `CreatePipe` handle is not a SOCKET, so green readiness on a pipe fd genuinely needs overlapped IO / IOCP. Until then green IO on a non-socket fd fails loud rather than deadlocking
- [ ] **TLS backend** — SChannel, or OpenSSL built for `windows-msvc`; blocks HTTPS and `wsBasic`
- [ ] **AES-GCM over CNG** — hashing landed; `BCryptEncrypt` with `BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO` is the remaining piece
- [ ] **`std/regex`** — no C-linkable regex exists on Windows, so the Windows arm is a fail-loud stub. The real fix is a pure-Milo engine (which would drop the libc dependency everywhere)
- [ ] **fd width** — `socket`/`accept` return `SOCKET` (`UINT_PTR`) but `std/os` declares `i32`; the audit script correctly flags it and stays off the Windows CI job until the fd layer goes i64
- [ ] Unskip `tcpIpv6` / `tcpGreenConnectRefused` once real Windows confirms them (they link; Wine can't emulate `AF_INET6` or a refused `FD_CONNECT`)

---

## Planned

### Language

- [x] **`@pure`** — a function may read and write only its parameters and its own locals: no I/O, no module state, no raw memory, no impure callee. Works on fns, methods, generics, and (as an unchecked assertion) on `extern`. `std/math` is annotated throughout. The prover uses it for framing — a `@pure` call with no `&mut` parameter needs no havoc — which turns refutations into proofs (`tests/prove/pureMethodNoHavoc.milo`). Design and the unbuilt capability stage: [effects-and-capabilities.md](effects-and-capabilities.md)
- [ ] **Dynamic `splitMut`** — `&mut [T]` param views and *literal-range* disjoint windows shipped (`two(v[0..2], v[2..4])` works; an overlapping pair is rejected). What remains is the runtime-`n` split, which second-class refs can't return as a tuple and so wants a callback form plus prover-discharged disjointness (backlog Tier 2 #9). The concrete case is now in the tree: `examples/games/flight` rasterises on every core by cutting the frame into `cpuCount()` scanline bands, and since a band count is a runtime number and a `&mut [f32]` cannot cross a thread boundary, the split is made by hand — base addresses in a `Job` struct, ~30 lines of `unsafe` in `raster.bandRaster`, disjointness argued in a comment instead of checked. That is the code a dynamic `splitMut` has to be able to replace
- [ ] **Borrowed byte views** — `Buffer`/`ArrayBuffer`-shaped interop and zero-copy protocol parsing; gates the zero-copy form of the JSON byte-feed
- [ ] **Named enum-variant fields** — `ForEach { varName: string, … }` instead of an 8-slot positional payload. Greenlit as a language feature; hits the self-hosted compiler hardest. Parser + checker + formatter + LSP
- [ ] **Tuple binding in for-in** — `for (i, x) in vec.enumerate()`; converts most `while i < len()` loops. match already destructures tuples
- [ ] **Combinators on slices and arrays** — `map`/`filter`/`each`/`enumerate`/`find`/`any`/`all`/`sum` ship on `Vec` but are gated on it, so `&[T]` and `[T; N]` get none of them (`s.sum()` on a `&[i64]` param is an error). The gate is the work, not the adapter count; `fold` is the one adapter genuinely missing. `take`/`skip`/`zip` are declined — see Retired. Lazy/fusing adapters are deliberately out
- [ ] **Error boxing** — the `?` half of error conversion shipped; `anyhow`-style boxing builds on `Heap<Interface>`, which now works
- [ ] **Ranged integers L3** — branch narrowing: after `if x < 50`, `x` is `(min..49)` in the then-branch
- [ ] **Structured OS / syscall errors** — `OsError` carrying `errno` plus syscall/path context
- [ ] **C ABI layout control** — packed structs, alignment. `extern struct`, `sizeOf`/`offsetOf` already work
- [ ] **`void` as a value (zero-sized types)** — `void` is a type tag with no runtime representation, so it cannot inhabit a generic. The checker now rejects that outright (`Vec<void>`, `Promise<void>`, an inferred `identity(nothing())`, a `let x: void`) where it used to reach LLVM and die at the link step with "void type only allowed for function results" against a temp `.ll` file and no span. std's answer is `Unit`, an empty struct in the prelude, and `Result<Unit, E>` is how every fallible command in `std/fs` spells "returns no data". That works, but it is two spellings for one idea, and it is the C++ mistake in miniature: `"void"` is special-cased 69 times in `checker.ts` and 59 in `codegen.ts`, and every one of those branches exists only because void is not a value. Making `void` a zero-sized value type with `Unit` as its alias would delete most of them. The cost is at the boundaries: ABI for zero-sized params and fields, `ret void` vs `ret {}`, closure return types, and `extern` decls where `void` must stay C's `void`
- [ ] **Const / value generic params** — generics are type-only. The bun-rs audit found 1,120 `const B: bool` sites; the only real language gap that audit surfaced. Weigh against Ethos #3 when a concrete Milo need appears
- [ ] **MIR** — lower-level IR for optimization passes, post self-hosting

### Standard Library

- [ ] **JSON incremental byte-feed** — `jsonPull` is string-backed; unbounded input (socket, multi-GB) wants a reader layer over the same tokenizer
- [ ] **JSON builder ergonomics** — the read side is clean; hand-constructing a document is clunky, and `JsonObj.build()` returns `string` rather than `Json`
- [ ] **Pure-Milo regex engine** — unblocks Windows and drops a libc dependency everywhere
- [ ] **`std/decimal`** — scaled-i128 for financial math; stdlib only, no compiler change
- [ ] **Missing bindings** — `alarm`/`setitimer`, `setpgid`/`killpg` (`execvp` shipped)

### Tooling

- [ ] **Cross-compilation for hosted targets** — `--target` reaches clang and fails loudly with a hint, but a real cross needs a target linker + sysroot; the compiler has no `-isysroot`/`--sysroot` notion. Bare-metal and Windows crosses already work
- [ ] **Compile-time reduction** — profiled: the frontend is 0.38s and clang `-O2` is **7.3s, 95% of a self-host build**. Not generics (only 8 monomorphized instances). Levers, in order: interned method IDs instead of `src-milo/codegen`'s string-compare dispatch chains, `String`-by-value struct shredding, then MIR. `--fast` (~2x) exists as the edit-loop workaround
- [ ] **`@bench` annotations + `milo bench`** — the harness exists as a shell script; the in-language form does not
- [ ] **"The book"** — documentation and tutorials beyond the reference

### Safety Hardening

Phases 1–3a are done (see Type System & Safety). Remaining, from [safety-roadmap.md](safety-roadmap.md):

- [ ] **3b — purity inference** for safe overlap at call sites
- [ ] **4a — debug ref counting** for patterns static analysis can't reach (`--sanitize` already links ASAN)
- [ ] **`unsafe fn` declarations** and `--deny-unsafe` for user code; `unsafe` visibility in the LSP
- [x] **Closure escape — the direct store.** A non-`move` closure with captures can no longer be written into a struct literal, an array literal, or `push`/`insert`/`set` on a collection; `move` heap-owns the captures and is what the diagnostic points at. Closes the use-after-return that read a dead stack frame (silent garbage at `--debug`, a hang at `-O2`, invisible to ASAN). **The rule is reject, not promote** — the first attempt auto-promoted the closure to `move` at the return, which fired *after* the checker had already walked the body, so a read of the capture printed empty with no diagnostic. A retroactive rule is invisible to the pass that has to see it
- [x] **Closure escape — the residual, closed 2026-08-16.** Two spellings were still live use-after-frees, and both went through `move` — the escape hatch every other diagnostic in this pass names. (a) A `move` closure that captures a *borrowing* closure: moving a `{fn, env}` pair copies the pointer, it does not own what the pointer points at, so `let f = (x) => x + n; return move () => f(3)` returned a closure reading a dead frame (printed -1 for 8). The escape walk now resolves through move captures instead of returning early at `isMove`. (b) The same reached through a parameter: `retainsParam` answers "does the callee keep this argument?" by looking for the parameter as an `Ident`, and a capture is invisible to that — the body spells the use `f(3)`, a `Call` with a string callee and no `Ident` node — so a wrapper that captured its fn-typed parameter reported "not retained" and the call site handed it a borrowing closure. Locked by `tests/errors/escapingClosureMoveLaunder{,Store}.milo`, `tests/errors/escapingClosureCapturedParam.milo`, and the accepted spelling `tests/fixtures/closureMoveNested.milo`

---

## Retired / Not Planned

- **`node-milo`** (the Node.js fork) — **frozen 2026-07-22, abandoned.** It was the runtime stress test that shaped the FFI and binary-data ordering above; that role now belongs to **milojs**, our own JS engine and runtime, which lives in [milo-language/milojs](https://github.com/milo-language/milojs) with its own roadmap and backlog. The V8-C-API-wrapper plan died with the fork. `docs/node-milo.md` is kept as the retrospective (the kqueue connect-failure and IPv6 gotchas generalize to any Milo runtime)
- **Emulators (NES/SNES/Genesis), milojs, and the DAP debugger** moved out of this repo 2026-07-24 — [milo-language/emulators](https://github.com/milo-language/milo-emulators), [milo-language/milojs](https://github.com/milo-language/milojs), [milo-language/dapweb](https://github.com/milo-language/dapweb). The docs site builds the browser emulator cores from the emulators repo
- **`Thread`/`Mutex`/`RwLock`/`parallel`** — removed 2026-07-10 in favour of the green tier; re-add on demand
- **Lazy / fusing iterator adapters** — laziness buys performance only through aggressive inlining and would pull associated types into the trait system (Graydon review decision #2). Eager `Vec`-returning stages stay
- **`take` / `skip` / `zip` as iterator adapters** — declined 2026-07-31, do not re-pitch. `take(n)`/`skip(n)` are already spelled `v[0..n]` and `v[n..v.len]`, which slicing gives zero-copy and in `&mut` form, so an eager adapter would allocate and clone what a view hands back for free (the only behavioural difference is that an out-of-range slice traps where `take` would clamp — a slice-bounds question, not a missing method). `zip` has no type to return: there is no tuple type, so it would mean either making tuples first-class or a callback form that is a `for` loop with extra steps. Revisit `zip` only if tuples land for `for (i, x) in`. This is the boundary that kept Rust's `Iterator` from reproducing itself here
- **Dependent types + proof terms** — re-examined 2026-09-01 against the Curry-Howard encoding, which already compiles in Milo, and declined with the evidence written down in [proofs-vs-contracts.md](proofs-vs-contracts.md): the termination checking a proof system needs is already built on the contract side, there is no positivity check (a negative occurrence compiles today, so the system would be inconsistent), proofs are values and values move, and the witness form buys no runtime anything. Milo's lane is SMT-discharged contracts with no proof terms. Four revisit triggers are named in that document
- **Reclaiming bare-metal allocator** — the bump allocator plus `--heap-size` closed the safety-critical story
- **Lowercase type aliases, script mode, let-chains, an `any` type** — considered and declined
