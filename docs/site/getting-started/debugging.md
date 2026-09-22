<!-- doc-meta
system: debugging
purpose: runtime bug hunting — sanitizers, DWARF, overflow traps, and what each build flag does
key-files: src/main.ts, src/target.ts
update-when: a build flag changes what it enables, or a new debugging tool ships
last-verified: 2026-08-23
-->

# Debugging

Milo emits standard DWARF debug info, so any DWARF-aware debugger — `lldb`, `gdb`, or [dapweb](https://github.com/milo-language/dapweb) — can set breakpoints on Milo source lines and inspect Milo values.

## VS Code

The [Milo extension](https://marketplace.visualstudio.com/items?itemName=milo-language.milo-lang) puts a **🐞 Debug** CodeLens above `fn main()`, next to **▶ Run**. Clicking it saves the file, builds it with `-g --debug`, and launches it under `lldb-dap` — breakpoints, stepping, call stack, and locals, with no `launch.json` to write.

Set breakpoints by clicking the gutter in any `.milo` file. Pressing <kbd>F5</kbd> on an open `.milo` file does the same thing as the lens.

The adapter is `lldb-dap`, which ships with LLVM and with the Xcode Command Line Tools; the extension finds it in Homebrew's LLVM, `/Library/Developer/CommandLineTools`, `PATH`, `/usr/lib/llvm-*/bin`, then via `xcrun`. Point `milo.lldbDapPath` at it if yours lives elsewhere. Debug builds go to a scratch directory (`$TMPDIR/milo-debug`) so the `.dSYM` bundle stays beside its binary and out of your source tree.

For a checked-in configuration — arguments, a working directory, or debugging a prebuilt binary — add a `milo` launch config:

```json
{
  "type": "milo",
  "request": "launch",
  "name": "Debug Milo file",
  "program": "${file}",
  "args": ["--verbose"],
  "stopOnEntry": false,
  "runInTerminal": false
}
```

`program` accepts either a `.milo` source (compiled with `-g --debug` first) or an already-built executable, which is passed through untouched. Set `runInTerminal` for programs that read stdin — the Debug Console is output-only.

## Graphical debugging with dapweb

<video src="/showcase/dapweb.mp4" poster="/showcase/dapweb.png" autoplay muted loop playsinline style="width:100%;border-radius:8px" aria-label="dapweb debugging a Milo program: a breakpoint in addBonus, the Vec of Player structs in the locals, an agent evaluating from the CLI and a person typing an lldb command in the same session"></video>

*A Milo program in dapweb: a source breakpoint, Milo structs in the locals, an agent driving from the CLI while a person types in the same session.*

[dapweb](https://github.com/milo-language/dapweb) is a web + AI debugger written in Milo itself. It drives any DAP backend (`lldb-dap`, `debugpy`, `delve`), so it debugs Milo binaries directly — same DWARF, no plugin.

```bash
milo build app.milo -o app -g --debug     # DWARF at -O0
dapweb ./app                                 # opens the UI in your browser
```

`dapweb web` serves a React + Monaco + xterm.js front-end from a Milo HTTP/WebSocket server: click a source line to set a breakpoint, step, inspect the call stack, expand locals and watch expressions, view an ARM64/x86 disassembly pane, and type into a real PTY terminal while the program runs.

`dapweb api` drives that same session from the command line — every verb is the JSON the browser sends, so an agent or a shell script can set breakpoints, step, and evaluate against the debuggee you are watching in the UI. When a graphical or AI-assisted view beats `frame variable`, reach for dapweb; the `lldb` recipes below still work for scripted/CI triage.

## Build with debug info

Pass `-g`:

```bash
milo build app.milo -o app -g --debug
lldb ./app
```

`-g` is independent of the optimization level and composes with any of them:

| Flags | Result |
|-------|--------|
| `-g --debug` | `-O0` + DWARF. **Use this for interactive debugging.** |
| `-g` | `-O2` + DWARF. Line table is accurate; locals are often optimized away. |
| `-g --release` | `-O3` + DWARF. For profilers and crash symbolication, not stepping. |
| _(no `-g`)_ | No debug metadata at all. |

Without `-g` the compiler emits zero debug metadata, so there is no size or speed cost to leaving it off.

`-g` works with `run`, `build`, and `emit-ir`. Use `emit-ir app.milo -g` to inspect the `!DICompileUnit` / `!DISubprogram` / `!DILocation` nodes directly.

## Inspecting the compiler's intermediate forms

To see how a program looks at each stage of the pipeline (`Source → AST → HIR → LLVM IR`):

| Command | Stage | What it shows |
|---------|-------|---------------|
| `emit-ast app.milo` | Parsed AST (JSON) | The parser's output, **before types exist** — a `BinOp` here has no type field. |
| `emit-hir app.milo` | Typed HIR (JSON) | The lowered form codegen consumes — **every expression carries its `type`**, and sugar (`??`, `?`, string interpolation) is desugared. |
| `emit-ir app.milo` | LLVM IR | The final text handed to `clang`. |

`emit-ast` and `emit-hir` default to the **entry file only** so the stdlib doesn't drown your code; add `--all` for the full merged module (imports, monomorphized instantiations, structs, enums, globals). Spans are stripped by default — pass `--spans` to keep them. Diffing `emit-ast` against `emit-hir` for the same function is the quickest way to see exactly what type-checking and lowering added.

Prefer `-g --debug` for stepping. At `-O0` every local lives in an `alloca` that the debug metadata binds to by name; at higher optimization levels LLVM promotes those to registers and `frame variable` reports them as unavailable.

## macOS: the `.dSYM` bundle

Mach-O does not store DWARF inside the linked executable — it stores a debug map pointing back into the object files. Building with `-g` on macOS therefore also produces an `app.dSYM` directory next to the binary:

```
app
app.dSYM/
```

`lldb` finds it automatically as long as it sits beside the executable. Ship the binary without it; keep it for symbolication. ELF targets (Linux) embed DWARF in the binary and produce no extra artifact.

## Breakpoints and variables

```
$ milo build compute.milo -o compute -g --debug
$ lldb ./compute
(lldb) b compute.milo:6
Breakpoint 1: where = compute`compute + 148 at compute.milo:6:5, address = 0x1000062e0
(lldb) run
(lldb) frame variable
(int) a = 7
(int) b = 8
(int) sum = 15
(bool) flag = true
(Point) p = {
  x = 3
  y = 4
}
```

Scripted, for CI or a quick crash triage:

```bash
lldb -b -o run -o bt ./app
```

## What is described

| Milo type | Debugger view |
|-----------|---------------|
| `i8`…`i64`, `u8`…`u64` | native integer (`lldb` prints an `i32` as `int`) |
| `f32`, `f64` | native float |
| `bool` | `true` / `false` |
| `struct` | named-field aggregate; member offsets match the emitted layout |
| `string` | `(data = "milo", len = 4, cap = 0)` |
| `Vec<T>` | `data` / `len` / `cap` fields; `data` is a typed `T*` you can dereference |
| `HashMap` | `entries` / `cap` / `len` / `tombstones` fields |
| Fixed-size arrays | indexable array |
| References, `Heap<T>` | typed pointer |

Current gaps:

- **Enums** appear as their raw representation — an `i32` `tag` field plus a `payload` blob of `i64` slots. Rust-style pretty-printing needs `DW_TAG_variant_part`, which is not emitted yet.
- **Closure bodies** carry no debug info. A breakpoint on a line inside a closure does not warn — `lldb` silently slides it forward to the next line that *does* have debug info, which is in the enclosing function. Break on the closure's call site instead.
- **Slices** (arrays with no fixed extent), function values, and interface values have no variable-level type info, so `frame variable` omits them. The line table still covers the code.

## Related tools

Runtime bug hunting, before you reach for a debugger:

```bash
milo build app.milo -o app --debug     # -O0, no optimisation
milo build app.milo -o app --sanitize  # link with AddressSanitizer (clang only)
```

Arithmetic traps on overflow in **every** build mode, `--release` included — it is a language law, not a debug aid, so there is no mode in which a release binary quietly wraps. `--no-overflow-checks` (or `--fast`) opts back into wrapping for a perf-critical build; `wrappingAdd`/`saturatingAdd`/`checkedAdd` name it per operation. See [Warnings & Errors](/language/warnings-and-errors) for compile-time diagnostics.
