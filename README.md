# hades

Web + AI interface for any DAP debugger. Written in [Milo](https://github.com/cs01/milo).

One binary, two subcommands:

- **`hades web`** — React + Monaco + xterm.js served by a Milo HTTP/WebSocket server that drives a DAP adapter (lldb-dap, debugpy). Breakpoints (Monaco glyph gutter), stepping, threads, call stack, expandable locals, watch expressions, a debug console (full lldb command access), and a real PTY terminal — type into your program *while it runs*. Fully self-hosted: no CDN assets. Boots idle: open the UI and pick a target in the ⚙ drawer (presets fill the JSON for you).
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
# Boots idle — open http://localhost:8080 and configure the target in the ⚙ drawer.
./hades web --port 8080

# Or name the target up front. --source is optional: the first stop's DWARF
# frame path auto-loads the editor.
clang -g -O0 examples/interactive.c -o /tmp/demo
./hades web --program /tmp/demo --port 8080

# python (needs pip install debugpy)
./hades web --program demo.py --adapter "python3 -m debugpy.adapter"

# launch attributes: argv, env, cwd, lldb hook commands — merged verbatim into
# the DAP launch request; "request":"attach" attaches to a pid instead
./hades web --program /tmp/demo --launch '{"args":["alpha"],"env":{"K":"V"}}'
./hades web --program /tmp/demo --launch '{"request":"attach","pid":12345}'

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
bun tests/mcp.ts        # MCP stdio flow (spawns ./hades mcp)
```

Architecture and roadmap: `docs/design.md`.
