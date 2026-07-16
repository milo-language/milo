# JavaScript target (`emit-js`)

Milo's compiler is built around **pluggable codegen**. The front-end — lexer, parser, type checker, HIR lowering — is shared. After it produces typed HIR, the pipeline forks to a backend:

```
Source → Lexer → Parser → Checker → HIR Lowering → HIR
                                                     ├─→ codegen.ts     → LLVM IR → clang → native binary
                                                     └─→ codegen-js.ts  → JavaScript
```

`src/codegen.ts` (LLVM IR) and `src/codegen-js.ts` (JavaScript) are two independent backends over the same HIR. The JS path is a real second codegen — not a transpile of the LLVM output, and not LLVM's wasm target. Because both start from the same HIR, the JS output is **byte-identical in behavior** to the native binary: the emulators verify this with CPU-trace and framebuffer checksums that match across native and JS.

## Usage

```bash
milo emit-js app.milo              # write JavaScript to stdout
milo emit-js app.milo -o app.js    # write to a file
```

Run the result with any JS engine:

```bash
node app.js
bun app.js
```

## What runs

The JS backend targets **pure computation plus stdout**. Supported:

- structs, enums, generics (monomorphized), closures
- `Vec<T>`, `HashMap<K, V>`, strings, string interpolation
- `Result` / `Option` / `?`
- `match`, `if let`, `let else`
- contracts (`requires` / `ensures`) — lowered to runtime assertions
- integer arithmetic with correct width and wrapping, bitwise and shift ops

## What does not run

The JS runtime binds only `print` (stdout) and stderr. There is **no runtime for the operating system**:

- no filesystem, no sockets or `fetch`, no processes
- no green threads, channels, or `select`
- no PTY, no SDL

A program that uses these compiles fine natively but has nothing to call in JS. Unsupported HIR nodes **fail at compile time** with an error rather than emitting broken JS.

## Where it is used

- **[Playground](/playground)** — the whole compiler is bundled to a single `compiler.js` and runs in the browser. It compiles the Milo source you type live, emits JS, and evaluates it. There is no native toolchain in a browser tab, so JS is the only output it can produce.
- **[Emulators](/demos)** — the NES, Genesis, and SNES cores are compiled ahead of time in CI (`milo emit-js …webcore.milo -o …-core.js`) to a static `.js` file. The browser runs the pre-generated JS plus a canvas / WebAudio / gamepad driver. No compiler ships to the browser for these.

## Why JavaScript and not wasm

wasm is LLVM's target, so wasm output would ride the existing LLVM path — no new codegen. It was still the wrong tool for the two jobs above:

- **The playground compiles live, in the browser.** Emitting wasm needs LLVM and `wasm-ld` at compile time, and neither exists in a browser tab. A JS compiler emitting JS and `eval`-ing it is the only path for in-browser compilation.
- **Readable, debuggable output.** `emit-js` produces human JS you can open in devtools and breakpoint. wasm is an opaque binary.
- **Emulator I/O is all JS APIs** (canvas, WebAudio, gamepad). JS output calls them directly; wasm would marshal every framebuffer and audio buffer across the JS/wasm boundary. Browsers also have no native WASI, so a wasm build ships a JS shim anyway.

wasm still wins for ahead-of-time builds that want near-native speed or real syscalls (fs, net) via WASI — a standalone runtime, an edge worker, a faster emulator. It complements `emit-js`; it does not replace it.
