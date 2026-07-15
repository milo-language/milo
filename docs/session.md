# Session management spec (M11)

Fixes: silent server (no connection/lifecycle log), whacky target config UX (raw JSON drawer,
preset tabs, placeholder paths, capability dump), client-local duplicated history, hardcoded
adapter strings. Reference points: gdbgui's "Load Binary" bar (one obvious input, everything
else secondary) and VS Code's launch.json (the config dialect every debugger user already knows).

## Vocabulary (use these words everywhere — code, UI, log)

- **server** — one `hades web` process. Owns exactly one *session*.
- **session** — the shared debug context (id = `gSessionId` uuid, target config, breakpoints,
  peers). Lives as long as the server, or until idle-ttl reaps it.
- **run** — one adapter launch inside the session (`gStarted` window: spawn → terminated).
  Config + bps persist across runs.
- **peer** — one WS connection: browser tab or `hades mcp --attach`. N peers, identical state.

## 1. Server log

A server should read like a server. One line per lifecycle event, timestamped, to **stdout**
(errors stay on stderr). Format: `HH:MM:SS <event> <details>`.

```
hades web UI → http://localhost:8080
  target: /tmp/hades_nested   (lldb)
  co-debug: hades mcp --attach localhost:8080

14:02:11 peer connected    browser  (1 peer)
14:02:15 run started       /tmp/hades_nested  pid 4242  adapter lldb-dap
14:03:02 run exited        code 0  (51s)
14:05:40 peer connected    mcp      (2 peers)
14:09:12 peer disconnected browser  (1 peer)
14:09:12 target changed    /tmp/other  (by mcp peer)
15:00:00 session idle      no peers for 24h — terminating debuggee
```

Events: `peer connected/disconnected` (kind + count), `run started/exited/terminated`
(pid, exit code, duration), `target changed` (who applied it), `session idle` (reap).
Stops/steps are NOT logged (matches VS Code/lldb-dap: stops are UI state, not server events);
`--verbose` adds them plus DAP request tracing for debugging hades itself. `--quiet` = banner
only. Peer kind is known: MCP peers identify themselves in their WS hello (add `client:"mcp"`;
absent = browser). Banner says `target:`, not `program:` (vocabulary).

## 2. Target config = a launch.json configuration

The config object IS a VS Code launch-configuration object. Users paste real-world configs
(VS Code docs, Stack Overflow, their own `.vscode/launch.json`) and they work:

```jsonc
{
  "type": "lldb",                  // dialect key → adapter registry (§3)
  "request": "launch",             // launch | attach (default launch)
  "name": "debug-launcher",        // optional label; shown in history
  "program": "/build/debug/bin/foo_exe",
  "args": [], "cwd": "...", "env": {"MY_VERSION": "2.4.0"},
  "preRunCommands": ["breakpoint name configure --disable cpp_exception"]
  // ...every other key passes through VERBATIM into the DAP launch/attach body:
  // skipFiles/outFiles (node), justMyCode (python), initCommands (lldb), pid (attach), etc.
}
```

- **No invented schema.** Hades strips its own keys (below) + `type`/`request`/`name`, merges
  dialect launch defaults, then user keys win — the existing M8j passthrough, promoted from
  escape hatch to THE config.
- **Hades-only keys**, clearly separated, stripped before the DAP request:
  `adapter` (explicit adapter command, overrides registry probe), `source` (optional,
  auto-detect default), `stopAtMain` (bool, replaces the toolbar checkbox's localStorage +
  per-run arg plumbing).
- **Full launch.json files accepted**: a `{version, configurations:[...]}` wrapper is
  recognized everywhere a config is (drawer paste, `--launch` file); pick by `name`
  (`--config <name>` / drawer dropdown), default first entry. `${workspaceFolder}`/`${file}`
  have no workspace here: substitute cwd for `${workspaceFolder}`, error on others with a
  clear message.
- MCP standalone launches through this exact same path — **no hardcoded lldb anywhere**
  (today `adapterID:"lldb"` + lldb-only launch args live in `src/mcp/main.milo`; that dies
  via the M5a shared-session extraction, folded into this milestone).

### UI: target bar, not a JSON ceremony

Primary UX = **gdbgui-style target bar** at the top of the drawer: one text input holding
`program + args` shell-style (`/tmp/a.out --foo bar`), shell-split client-side, Run button
next to it. Recent targets dropdown under the input (focus/↓), newest first — pick one, Run.
The bar is a projection of the config's `program`+`args`; editing it edits the config.

Below the bar, collapsed **Advanced**: the full launch-config JSON in Monaco (validated
against vendored per-type schemas where we have them — lldb-dap, debugpy — permissive
otherwise). Preset tabs die; `type` is inferred (§3) or set in the JSON. The toolbar's
read-only program span dies too — the bar is the one place a target is shown/edited.

**Capabilities**: gone from the main drawer. One line — `adapter: lldb-dap
(/opt/homebrew/…/lldb-dap)` — with a collapsed `<details>` for the raw caps list.
Diagnostics, not config.

### Mid-session edits

Current split brain: server hard-rejects `setConfig` mid-session while the UI
debounce-applies and shows "edits apply after it ends". Replace with **staged config**:

- `setConfig` accepted any time. Idle → applies immediately. Running → stored as
  `gStagedConfig`, broadcast `{type:"configStaged"}`, UI badges the bar "applies on next run".
- Run / Restart (↻) always consume staged-if-present. "Edit args, hit restart" just works —
  today it's impossible.
- Drop the 600ms debounced auto-apply of arbitrary edits; apply on target-bar Enter/blur and
  explicit Advanced apply. Debounced half-typed JSON is where the placeholder-suppression
  hacks came from.

## 3. Adapters: registry keyed by `type`, not substring

```
struct Dialect { types: Vec<string>, probeCmds: Vec<string>, launchDefaults, adapterID }
lldb   ← types [lldb, cppdbg, lldb-dap]      probe [lldb-dap, xcrun -f lldb-dap]
python ← types [python, debugpy]             probe [python3 -m debugpy.adapter]
node   ← types [node, pwa-node]              (M10 — registered, errors "not yet supported")
go     ← types [go]                          (delve — future, same error)
```

- `type` unset → inferred from `program`: `.py` → python, `.js`/`.ts` → node, else lldb.
- `adapter` key overrides the probe with an explicit command; `type` still picks launch
  defaults + adapterID (warn when both absent and we guessed).
- Probe at config-apply time, resolve to absolute path (runInTerminal constraint —
  design.md operational facts), fail fast with actionable error
  (`lldb-dap not found — brew install llvm or set "adapter": "/path/to/lldb-dap"`).
- Kills all three hardcoded `"lldb-dap"` strings (server ×2, mcp ×1) and the `"debugpy"`
  substring scan.

## 4. History: server-side, one writer

- Server persists history at `$XDG_STATE_HOME/hades/history.json`
  (default `~/.local/state/hades/history.json`; create dirs on demand): array of canonical
  config objects + `lastRunAt`, cap 20, newest first.
- **Single writer**: server appends on successful `run` launch (adapter spawned + launch
  ack'd). Both client-side `saveHist` call sites (drawer apply + hello echo) are deleted —
  that's the dupe bug.
- Dedup by identity key `(type, program, args, adapter)` after canonicalization (sorted keys,
  empties stripped) — not raw stringify. Match → move to front, update stamp.
- `hello` carries `history: [...]`; `historyChanged` broadcast on append. Any browser, any
  machine sees the same list. localStorage `hades.configHistory` retired (read-once
  migration: merge into server file on first connect, then ignore).
- **Boot restore, unconditional**: server boots with no `--program` → `history[0]` becomes
  the session config (staged, not launched). Banner:
  `target: /tmp/hades_nested (restored — Run to launch)`. No flag; good defaults over config.
  Replaces the client-driven drawer-fallback + debounced auto-apply resurrection.

## 5. CLI parity

- `hades <program> [args...]` works: top-level positional = implicit
  `web --program …` with args; `type` inferred. The 90% invocation is `hades /tmp/a.out`.
- `hades web` keeps current flags; `--launch` now also accepts full launch.json files with
  `--config <name>` selection. Add `--quiet`, `--verbose`.
- `hades mcp` (standalone) gains the same config path via the shared session module (M5a).

## Non-goals (this milestone)

- Multi-session routing (registry keyed on session id) — id stays identity-only.
- Auth / non-loopback binding.
- pty `resize` wiring (separate small fix; UI already sends it, server drops it).
- Actual node/go adapter support (M10) — registry slots exist, launch blocked with a clear error.

## Implementation order

1. §1 log lines (small, immediate payoff) + MCP peer self-identification.
2. §2 config canonicalization (launch.json shape, `type`/`request`/`name`, hades keys
   separated, `stopAtMain` into config) + staged-config semantics server-side.
3. M5a extraction: shared session/launch module consumed by web + mcp; delete mcp's
   hardcoded lldb dialect.
4. §4 server-side history (XDG state dir) + unconditional boot restore + delete client
   saveHist paths.
5. §3 dialect registry + probing.
6. §2 UI: target bar + Advanced collapse + capabilities demotion + remove toolbar program span.
7. §5 `hades <program>` positional + launch.json file support.

Each step lands independently; e2e-session suite extends per step (log-line assertions via
stdout capture; history via temp $XDG_STATE_HOME).
