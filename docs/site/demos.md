# Demos & Showcase

Real programs written in Milo — from retro-console emulators running in your browser to native CLI tools. Everything here compiles from the same memory-safe source: the emulators to WebAssembly-free JavaScript via `milo emit-js`, the CLI tools to small native binaries.

## Emulators in the browser

Three full retro-console cores, written in Milo and compiled to JavaScript. No plugins — drop a ROM and play.

### <a href="/milo/nes/" target="_self">NES →</a>

Cycle-stepped 6502, PPU, and APU with DMC audio and multiple mappers. Ships six free homebrew games you can play in one click: **Blade Buster**, **Battle Kid**, **Super PakPak**, **Sir Ababol**, **Lawn Mower**, **Mad Wizard**. Drag in your own `.nes` ROM to play anything else.

### <a href="/milo/genesis/" target="_self">Genesis / Mega Drive →</a>

Motorola 68000 + Z80 dual-CPU core with the VDP graphics processor and FM/PSG audio. Preset homebrew: **Headship**, **Astro Perdido**, **Gravity Pig**, **Dragon's Castle**. Accepts `.md` / `.bin` / `.gen` / `.smd` ROMs.

### <a href="/milo/snes/" target="_self">SNES →</a>

65C816 CPU core plus the SNES PPU. Boots commercial titles to their title screens — load an `.sfc` / `.smc` ROM to try it. The newest and most in-progress of the three cores.

> All three run natively too — `examples/apps/arcade.sh <rom>` builds the right core with SDL video, audio, and input, auto-detecting the console from the ROM extension.

## CLI tools & apps

Native command-line programs, each a single `.milo` file. See the full list on the [Examples](/examples) page.

| Program | What it is |
|---------|-----------|
| [grep](https://github.com/cs01/milo/blob/main/examples/cli-tools/grep.milo) | Pattern search with color, `-i` / `-n` / `-c` / `-v` |
| [jq](https://github.com/cs01/milo/blob/main/examples/cli-tools/jq.milo) | JSON query tool |
| [tree](https://github.com/cs01/milo/blob/main/examples/cli-tools/tree.milo) | Recursive directory tree |
| [serve](https://github.com/cs01/milo/blob/main/examples/apps/serve.milo) | Static file server with directory listing |
| [webserver](https://github.com/cs01/milo/blob/main/examples/apps/webserver.milo) | HTTP server with routing |

## Playground

Compile and run Milo entirely in your browser — no install — on the [Playground](/playground).
