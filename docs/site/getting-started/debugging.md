# Debugging

Milo emits standard DWARF debug info, so any DWARF-aware debugger — `lldb`, `gdb`, or [hades](https://github.com/milo-language/milo/tree/main/examples/apps/hades) — can set breakpoints on Milo source lines and inspect Milo values.

## Graphical debugging with hades

[hades](https://github.com/milo-language/milo/tree/main/examples/apps/hades) is a web + AI debugger written in Milo itself. It drives any DAP backend (`lldb-dap`, `debugpy`), so it debugs Milo binaries directly — same DWARF, no plugin.

```bash
./milo build app.milo -o app -g --debug     # DWARF at -O0
hades web ./app                              # opens the UI in your browser
```

`hades web` serves a React + Monaco + xterm.js front-end from a Milo HTTP/WebSocket server: click a source line to set a breakpoint, step, inspect the call stack, expand locals and watch expressions, view an ARM64/x86 disassembly pane, and type into a real PTY terminal while the program runs.

`hades mcp` exposes the same live session to an AI over MCP: you and the model see and drive the same debuggee, so you can ask it to find the fault while you watch. When a graphical or AI-assisted view beats `frame variable`, reach for hades; the `lldb` recipes below still work for scripted/CI triage.

## Build with debug info

Pass `-g`:

```bash
./milo build app.milo -o app -g --debug
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
$ ./milo build compute.milo -o compute -g --debug
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
./milo build app.milo -o app --debug     # -O0 traps on integer overflow
./milo build app.milo -o app --sanitize  # link with AddressSanitizer (clang only)
```

`--debug` (`-O0`) enables overflow traps; the default `-O2` and `--release` builds use wrapping arithmetic. See [Warnings & Errors](/language/warnings-and-errors) for compile-time diagnostics.
