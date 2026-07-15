# hades

Web + AI interface for any DAP debugger. Written in [Milo](https://github.com/cs01/milo).

One binary, two subcommands:

- **`hades web`** — React + Monaco + xterm.js served by a Milo HTTP/WebSocket server that drives a DAP adapter (lldb-dap, debugpy, delve). Breakpoints (Monaco glyph gutter), stepping, threads, call stack, expandable locals, watch expressions, a debug console (full lldb command access), and a real PTY terminal — type into your program *while it runs*. Fully self-hosted: no CDN assets. Boots idle: open the UI and set the target in the ⚙ drawer — a VS Code launch-configuration JSON with per-debugger schema autocomplete (templates seed a starter config; the last 10 targets are one click away).
- **`hades mcp`** — the same debugger driven by an AI: launch, step, inspect, evaluate, all over MCP stdio.
- **Co-debug** — `hades web` hosts ONE shared session; every browser tab and every `hades mcp --attach` peer sees and drives the same debuggee. Stop in the browser, ask Claude what it sees, watch it step.

## Build

```sh
src/web/ui/build.sh                                  # bundle UI → src/web/ui/dist (bun)
bun run ../milo/src/main.ts build src/main.milo -o hades
```

The server serves the UI from disk (`--webroot`, default `src/web/ui/dist` relative to the cwd) — UI changes only need `build.sh` + a browser refresh, no server rebuild.

## Run

```sh
# The 90% invocation: a path implies `web`, trailing tokens are the debuggee's argv.
clang -g -O0 examples/interactive.c -o /tmp/demo
./hades /tmp/demo alpha --beta

# Boots idle — open http://localhost:8080 and configure the target in the ⚙ drawer.
./hades web --port 8080

# Name the target with flags. --source is optional: the first stop's DWARF
# frame path auto-loads the editor. Type is inferred (.py → debugpy, .go → delve).
./hades web --program /tmp/demo --port 8080
./hades web --program demo.py

# --launch takes a VS Code launch configuration (inline JSON or a file path;
# any launch.json keys pass through to the adapter — args/env/cwd/initCommands/…)
./hades web --launch '{"type":"lldb","program":"/tmp/demo","args":["alpha"],"env":{"K":"V"}}'
./hades web --launch '{"type":"lldb","request":"attach","pid":12345}'
# …or a whole .vscode/launch.json; pick an entry by name
./hades web --launch .vscode/launch.json --config "debug tests"

# AI standalone: register with Claude Code
claude mcp add hades -- $PWD/hades mcp --program /tmp/demo

# AI co-debug: join the web session above as a second peer — you debug in the
# browser, Claude reads/drives the same session over MCP
claude mcp add hades-live -- $PWD/hades mcp --attach localhost:8080
```

Run `hades <command> --help` for a command's options.

## Tests

```sh
bun tests/e2e.ts        # full web-session flow against a live server (start one on 8091 first)
bun tests/e2e-config.ts # launch-config redesign: inline run config, force-kill, history (self-spawns)
bun tests/mcp.ts        # MCP stdio flow (spawns ./hades mcp)
```

Architecture and roadmap: `docs/design.md`.
