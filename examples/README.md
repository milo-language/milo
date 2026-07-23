# Examples

Runnable Milo programs. They double as integration smoke tests for the standard library.

```bash
./milo run examples/hello.milo
./milo build examples/graphics/donut.milo -o /tmp/donut
```

| Folder | What's in it |
|--------|--------------|
| [`hello.milo`](hello.milo) | The canonical first program |
| [`basics/`](basics) | Language and stdlib fundamentals: fib, fizzbuzz, json, arenas, a small interpreter |
| [`cli-tools/`](cli-tools) | Coreutils-style tools, one `.milo` file each: grep, jq, tree, fmt, pkg |
| [`graphics/`](graphics) | Truecolor terminal rendering: donut, plasma, aquarium, raytracers |
| [`simulation/`](simulation) | Physics and numerical simulation: cloth, rigid bodies, phase space |
| [`terminal/`](terminal) | TUIs and PTY work: tetris, sysmon, a mini tmux |
| [`net/`](net) | HTTP servers and clients, plus the weather and termpair apps |
| [`emulators/`](emulators) | NES, SNES, and Genesis cores, a shared SDL layer, and the retro console front-end |
| [`embedded/`](embedded) | Bare-metal and control code: PID step, flight controller |
| [`runtimes/`](runtimes) | Language runtimes written in Milo: milojs (a JS engine), minibun |
| [`tools/`](tools) | Developer tools: hades (DAP debugger), java-dap (JVM adapter) |

Emulators need ROMs (not included) and SDL2. Network examples need an internet connection.
