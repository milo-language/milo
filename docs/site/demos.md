<!-- doc-meta
system: demos-showcase
purpose: showcase page listing runnable Milo demos (browser emulators, debugger, TUIs, servers)
key-files: examples/apps, examples/cli-tools, docs/site/.vitepress/config.mts
update-when: a demo is added/removed or its capabilities change
last-verified: 2026-07-15
-->

# Showcase

Real programs written in Milo. Every one is a single `.milo` file. Clone the repo and [run or build any of them yourself](#run-these-yourself) with the `./milo` wrapper. They double as integration tests for the standard library.

## Emulators: desktop and browser

Three retro-console cores. Same Milo source runs two ways: native binary on desktop (SDL video/audio/input) or JavaScript in the browser via `milo emit-js`. No plugins. Drop a ROM and play.

### <a href="/milo/nes/" target="_self">NES</a>

Cycle-stepped 6502, PPU, and APU with DMC audio and multiple mappers. Ships six free homebrew games playable in one click: **Blade Buster**, **Battle Kid**, **Super PakPak**, **Sir Ababol**, **Lawn Mower**, **Mad Wizard**. Drag in your own `.nes` ROM to play anything else.

### <a href="/milo/genesis/" target="_self">Genesis / Mega Drive</a>

Motorola 68000 + Z80 dual-CPU core with the VDP graphics processor and FM/PSG audio. Preset homebrew: **Headship**, **Astro Perdido**, **Gravity Pig**, **Dragon's Castle**. Accepts `.md` / `.bin` / `.gen` / `.smd` ROMs.

### <a href="/milo/snes/" target="_self">SNES</a>

65C816 CPU plus the SNES PPU, including a Super FX (GSU) coprocessor core. Plays Super Mario World and Donkey Kong Country; Star Fox boots with GSU-rendered 3D. Load an `.sfc` / `.smc` ROM.

> All three run natively too: `examples/apps/arcade.sh <rom>` builds the right core with SDL video, audio, and input. [`examples/apps/retro/`](https://github.com/cs01/milo/tree/main/examples/apps/retro) turns them into a Raspberry Pi couch console with a gamepad-driven menu.

## Debugger

### <a href="https://github.com/cs01/milo/tree/main/examples/apps/hades" target="_blank">hades</a>

[![hades web UI stopped at a breakpoint inside classify(), showing the source view, call stack, locals, and a live lldb terminal](/hades/debugging.png)](https://github.com/cs01/milo/tree/main/examples/apps/hades)

A web + AI interface for any DAP debugger (lldb-dap, debugpy), written in Milo. One binary, two subcommands: `hades web` serves a React + Monaco + xterm.js debugging UI from a Milo HTTP/WebSocket server: breakpoints, stepping, call stacks, expandable locals, watch expressions, an ARM64/x86 disassembly pane, and a real PTY terminal you can type into while your program runs. `hades mcp` exposes the same session to an AI over MCP: both you and the model see and drive the same debuggee. Debugs Milo binaries too; the compiler emits standard DWARF.

### <a href="https://github.com/cs01/milo/tree/main/examples/apps/java-dap" target="_blank">java-dap</a>

A standalone Debug Adapter Protocol server for the JVM, written in Milo. No Eclipse, no jdt.ls, no JVM-side code: the whole adapter is a DAP-to-JDWP protocol translator in about 1300 lines. Works with any DAP client, and hades finds it automatically, so you can debug Java the same way you debug Milo.

## Terminal & graphics apps

TUIs in [`examples/apps/`](https://github.com/cs01/milo/tree/main/examples/apps), built on the standard library's terminal, PTY, SDL, and green-thread APIs.

| Program | What it is |
|---------|-----------|
| [tetris](https://github.com/cs01/milo/blob/main/examples/apps/tetris.milo) | Event-driven terminal Tetris; one green task parked on a Select, no polling |
| [sysmon](https://github.com/cs01/milo/blob/main/examples/apps/sysmon.milo) | htop-style live system monitor |
| [donut](https://github.com/cs01/milo/blob/main/examples/apps/donut.milo) | The classic spinning 3D torus, truecolor-shaded |
| [plasma](https://github.com/cs01/milo/blob/main/examples/apps/plasma.milo) | Full-screen truecolor animation; doubles as a render-throughput benchmark |
| [aquarium](https://github.com/cs01/milo/blob/main/examples/apps/aquarium.milo) | Truecolor pixel aquarium: fish, bubbles, swaying seaweed |
| [chihuahua](https://github.com/cs01/milo/blob/main/examples/apps/chihuahua.milo) | DVD-logo-style bouncing screensaver with a shaded pixel-art sprite |
| [splitPty](https://github.com/cs01/milo/blob/main/examples/apps/splitPty.milo) | Two commands side-by-side in real PTYs; a mini tmux |
| [flightController](https://github.com/cs01/milo/blob/main/examples/apps/flightController.milo) | Single-axis PID altitude controller with an interactive TUI |
| [menu](https://github.com/cs01/milo/blob/main/examples/apps/menu.milo) | Fullscreen SDL retro-console front-end with a gamepad/keyboard ROM picker |

## Servers & network apps

| Program | What it is |
|---------|-----------|
| [termpair](https://github.com/cs01/milo/tree/main/examples/apps/termpair) | Share your terminal in the browser: WebSocket relay with end-to-end AES encryption, client and server both in Milo |
| [weather](https://github.com/cs01/milo/tree/main/examples/apps/weather) | weather.gov frontend served from a single static binary |
| [serve](https://github.com/cs01/milo/blob/main/examples/apps/serve.milo) | Static file server with directory listing |
| [webserver](https://github.com/cs01/milo/blob/main/examples/apps/webserver.milo) | HTTP server with routing, path params, middleware |
| [httpClient](https://github.com/cs01/milo/blob/main/examples/apps/httpClient.milo) | HTTP client for fetching URLs |
| [fetch](https://github.com/cs01/milo/blob/main/examples/apps/fetch.milo) | Fetch an HTTP API over TLS and parse the JSON response |

## Data & interpreters

| Program | What it is |
|---------|-----------|
| [milojs](https://github.com/cs01/milo/tree/main/examples/apps/milojs) | A JavaScript engine in Milo: parser, evaluator, mark-sweep GC. Runs express |
| [kvstore](https://github.com/cs01/milo/blob/main/examples/apps/kvstore.milo) | Page-based key-value store with cursors, in the sled/buffer-pool style |
| [minilang](https://github.com/cs01/milo/blob/main/examples/apps/minilang.milo) | Tree-walking interpreter for a small expression language |

## The language, feeding itself

| Program | What it is |
|---------|-----------|
| [src-milo](https://github.com/cs01/milo/tree/main/src-milo) | The Milo compiler, in Milo. Self-hosting, rebuilds itself byte-for-byte identical |
| [smtSolve](https://github.com/cs01/milo/blob/main/tools/smtSolve.milo) | The SMT solver behind `milo prove`. Milo's contracts are discharged by a Milo binary |
| [fmt](https://github.com/cs01/milo/blob/main/examples/cli-tools/fmt.milo) | The Milo source formatter, in Milo |

## CLI tools

Coreutils-style tools in [`examples/cli-tools/`](https://github.com/cs01/milo/tree/main/examples/cli-tools), each a single `.milo` file.

| Program | What it is |
|---------|-----------|
| [grep](https://github.com/cs01/milo/blob/main/examples/cli-tools/grep.milo) | Pattern search with color, `-i` / `-n` / `-c` / `-v` |
| [rg](https://github.com/cs01/milo/blob/main/examples/cli-tools/rg.milo) | ripgrep-lite: regex-powered recursive search |
| [jq](https://github.com/cs01/milo/blob/main/examples/cli-tools/jq.milo) | JSON query tool |
| [tree](https://github.com/cs01/milo/blob/main/examples/cli-tools/tree.milo) | Recursive directory tree with depth limiting |
| [cat](https://github.com/cs01/milo/blob/main/examples/cli-tools/cat.milo) | File viewer with line numbers and syntax highlighting |
| [wc](https://github.com/cs01/milo/blob/main/examples/cli-tools/wc.milo) | Line/word/char counter |
| [hex](https://github.com/cs01/milo/blob/main/examples/cli-tools/hex.milo) | Hex dump viewer with ASCII column |
| [shuf](https://github.com/cs01/milo/blob/main/examples/cli-tools/shuf.milo) | Shuffle input lines |
| [calc](https://github.com/cs01/milo/blob/main/examples/cli-tools/calc.milo) | Expression evaluator |
| [parallel](https://github.com/cs01/milo/blob/main/examples/cli-tools/parallel.milo) | Run shell commands in parallel across input lines (fork-based) |
| [timeout](https://github.com/cs01/milo/blob/main/examples/cli-tools/timeout.milo) | Run a command with a time limit |
| [pkg](https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo) | Milo's own package manager: install and publish packages over git, with a lockfile and GitHub registry |

## Run these yourself

Every program above is a single `.milo` file. Clone the repo and run or build any of them with the `./milo` wrapper:

```bash
./milo run examples/cli-tools/grep.milo -- "hello" myfile.txt
./milo build examples/apps/serve.milo -o serve && ./serve
```

### A taste: grep in Milo

```milo
from "std/argparse" import { newParser }
from "std/io" import { readFile }

fn main(): i32 {
    var parser = newParser("grep", "search for a string pattern in files")
    parser.addPositional("pattern", "string pattern to search for")
    parser.addPositional("file", "file to search")
    parser.addBool("ignore-case", "i", "case-insensitive search")
    parser.addBool("line-number", "n", "show line numbers")
    parser.addBool("count", "c", "only print count of matching lines")
    let args = parser.parse()

    let pattern = args.getString("pattern")
    let filePath = args.getString("file")

    let content = readFile(filePath)!
    let lines = content.split("\n")

    for line in lines {
        if line.contains(pattern) {
            print(line)
        }
    }
    return 0
}
```

Prefer no install? Compile and run Milo in your browser on the [Playground](/playground).
