# Hades Design

Vision: web + AI (MCP) interface for any DAP debugger, written in Milo.

Shipped (detail erased; git history + code are the record): M4 event-driven core / pty /
bottom panel, M5 MCP stdio server, M6 debugpy, M8 capabilities-driven features (conditional
bps, frame nav, setVariable, completions, exception bps, native restart, disasm split view,
launch passthrough, multi-file tabs, optional --source, merged terminal + output replay,
memory viewer, threads panel), M9 co-debug shared session, M9b lifecycle
(auto-reconnect/replay, session id, idle-ttl). Suites: e2e 15, e2e-m8 14, e2e-session 13,
mcp 10, mcp-attach 10, multifile 12.

**Design principle (M8j): map to the DAP spec as closely as possible.** The config object
converges on a verbatim launch/attach request body (VS Code launch.json shape); hades-only
keys (`source`, `adapter`, `stopAtMain`) stay clearly separated and lower to DAP-native
constructs. No invented protocol.

---

## Open work

- **M11 session management** — spec in `session.md`: server lifecycle log, launch.json as
  THE config (type/request/name + verbatim passthrough), staged mid-session edits, target
  bar UI, adapter dialect registry (no hardcoded lldb), server-side XDG history + boot
  restore, `hades <program>` positional. Folds in **M5a** (shared session module; MCP
  standalone currently hardcodes lldb dialect + duplicates ~150 lines of JSON helpers).
- **M10 js-debug (node)**: TCP DAP transport + `startDebugging` child sessions. js-debug's
  `dapDebugServer.js` is a TCP server; parent session immediately spawns a child session via
  the `startDebugging` reverse request → needs DapClient over TcpStream (readFrame already
  takes a bare fd) + multi-session handling.
- **M8i remainder**: bidirectional source↔asm highlight polish, instruction breakpoints
  (`supportsInstructionBreakpoints`).
- **M8j remainder**: vendor per-adapter launch schemas for drawer validation (lldb-dap:
  `llvm-project/lldb/tools/lldb-dap/package.json`; debugpy: ms-python extension). DAP defines
  no launch-body schema by design; fall back permissive for unknown adapters.
- **pty resize**: UI sends `{cmd:"resize"}`; server drops it — wire to `Pty.resize`.
- **hades-side parse-once**: DAP frames re-parsed up to 5× per message
  (bodyStr/bodyI64/framesJson/localsJson); parse once, pass `&Json` to extractors.

## Milo papercuts still open (fix upstream in milo repo, isolated commits)

- **Concurrency unification (headline)**: pthread world and green world don't communicate.
  `Channel.recv` from a green task freezes the scheduler; green-aware IO is per-call-site;
  no `select` (fd-OR-channel needs the self-pipe hack); `Promise.await` from a green task
  deadlocks by construction. Fix = Go's factoring: Channel parks green tasks, std/os IO
  green-aware by default, `select` over channels+fds, Thread/Mutex demoted to escape hatch.
  When it lands, delete hades' wsWriterLoop self-pipe machinery.
- **std shadows local definitions**: locally-defined fn lost to an unimported std fn of the
  same name; must be a hard error or locals win.
- **Option ergonomics**: no if-let/`as_mut`/`take` → session structs fall back to sentinel
  values (-1 fds, placeholder structs).
- **Compile time**: ~1m40s for ~900 lines (post-embedFile fix) — needs profiling; embedFile
  needs a binary-blob fast path before embeds can return.
- **No JSON builder**: every payload is string concat (escape-unsafe). std/json needs a
  `JsonValue` tree builder with proper escaping; then delete hades' ~15 hand-concat helpers.
- **std/http can't host hades**: needs `serveDir(root)` + an upgrade hook that hands the raw
  fd over for WebSocket takeover; then delete hades' hand-rolled HTTP plumbing.

---

## Hard-won operational facts

- **Adapter must be spawned by absolute path.** lldb-dap builds its runInTerminal launcher
  argv from its own argv[0]; spawn it bare and the pty launcher exits 127 while the adapter
  blocks on its comm-file forever, zero error surfaced. Server resolves against PATH at
  startup (`resolveInPath`).
- **Breakpoint source path must match the debuggee's DWARF path.** `clang -g examples/foo.c
  -o /tmp/foo` records `examples/foo.c`; a bp on `/tmp/foo.c` silently never binds (lldb
  full-path match). Compile from the path you'll reference, or use lldb `target.source-map`.
- **lldb-dap runInTerminal args**: `[<lldb-dap-abs-path>, --comm-file <fifo>,
  --debugger-pid <pid>, --launch-target <program>]` — launcher waits on the comm-file, then
  execs the target.
- **Stdin before the pty exists must be buffered** (adapter launch ~1s; keystrokes would
  vanish) — R buffers, flushes on pty arrival.
- **restart emits `exited` for the old process** — only `terminated`/EOF may end the session.
  lldb-dap handles `restart` but never advertises `supportsRestartRequest`; try-then-fallback
  beats capability gating.
- **lldb-dap fills its thread list lazily after a stop** — immediate `threads` response
  usually has only the stopping thread; server re-polls 3× at 300ms.
- **readMemory at unmapped pages**: lldb-dap replies success-but-empty (no error, no data) —
  surface failure in the Memory pane, not the terminal.
- **Same-named fns in two modules merge via linkonce_odr** (milo): one body silently wins —
  rename to avoid collisions (broke asm/ipRef once already).
- **Green tasks only run after main yields**; wsConnect fds are blocking by default
  (setNonblocking or the reader stalls the scheduler); id-correlated broadcasts require
  peers to ignore foreign ids.
- **Idle-ttl time source**: green scheduler blocks in kevent with no timeout and `sleepMs`
  busy-yields — the reaper is an OS ticker thread (raw `usleep` + pipe write ONLY; the
  scheduler pointer is a plain global, any runtime call off-thread corrupts it) poking a
  green task parked on the pipe.
- **Module-scope non-const initializers** used to silently produce `""` — now a milo checker
  error (35d2c70).
