<!-- doc-meta
system: roadmap
purpose: staged plan to grow examples/apps/minibun.milo from an eval+console.log MVP into a runtime that boots a real Node CJS Express backend
key-files: examples/apps/minibun.milo, std/net.milo, std/http.milo, std/io.milo, std/path.milo
update-when: a milestone lands (check the box, note the commit) or the acceptance target changes
last-verified: 2026-07-17
-->

# minibun roadmap — from `console.log` to a booting Node backend

**Acceptance target:** `minibun ~/git/digitalocean/tahoeroads/backend/dist/index.js` serves HTTP.
That entry is a 123-line CommonJS bundle: `exports`/`require`×13/`__dirname`, requires the
builtins `path` + `fs`, the npm packages `express` + `cookie-parser` + `compression`, plus
local route modules, and reads `process.env`. Each thing it touches is a milestone below.

**The thesis this proves:** JS executes on JavaScriptCore (C++), but the *runtime* — module
loader, timers, the HTTP server, the event loop — is memory-safe Milo. Node's architecture
is a synchronous event loop (the audit found **zero** async in 1M lines of bun-rs); Milo's
green scheduler *is* that loop. So the network milestones aren't a stretch — they're the
part Milo is uniquely suited for.

## Milestones (critical-path order)

### M0 — eval + console.log + exceptions ✅ (c484a47)
Context, `console.log` via a Milo callback, uncaught-exception reporting, file loader.

### M1 — CommonJS module system ✅  ⟶ kills the `exports` error
Module system (require/cache/resolution) in a JS bootstrap over two Milo natives
(`__readFileSync`, `__fileExists`); `new Function` supplies the CJS wrapper. Resolves
`.js`/`.json`/`/index.js`/`package.json#main` and walks `node_modules`. Verified: multi-file
relative + nested + JSON `require`, both `exports.x` and `module.exports=` styles, `__dirname`.
The tahoeroads backend now advances past `exports`/`require` to `Cannot find module events`
(a builtin — M2/M5). Circular requires handled (partial-exports via pre-cache).

### M2 — global scaffolding + builtin-module registry ✅ (partial)
Shipped: a `builtins` registry in the bootstrap (`require('events'/'path'/'util'/'assert')`,
`node:` prefix handled), all pure JS. `EventEmitter` (on/once/emit/removeListener/…), `path`
(join/dirname/basename/extname/resolve/parse), `util` (format/inherits/promisify/inspect),
`assert`. Globals: `process` (env/argv/platform/cwd/nextTick/stdout.write), `global`, timer
stubs. Verified against a local builtins test; the tahoeroads backend now clears `events`.
**Next wall it hit:** `Error.captureStackTrace`/`prepareStackTrace` + V8 CallSite API
(`callSite.getFileName`) — a dependency uses V8-only stack introspection JSC lacks. Needs a
CallSite shim (M2.5, compat-tail).
- **Deferred:** real `process.env` (needs a `__getenv` native), `Buffer` (Node's own API,
  not JSC typed arrays — stub `from`/`toString` first), `queueMicrotask`.

### M3 — the event loop (the showcase)
- `setTimeout`/`setInterval`/`clearTimeout`/`setImmediate`, and **draining** — after top-level
  eval returns, pump timers + microtasks until quiescent (Node's actual model).
- Back timers with `Task.spawn` + a timer heap on the green scheduler; drain via the
  `schedulerRunToCompletion` pattern already in `std/runtime`.
- async/await + Promises: JSC runs them natively — the runtime only has to drain the
  microtask queue, no `Future` machinery.
- Effort: **1 session.** This is where "the event loop is Milo's" stops being a slogan.

### M4 — core sync builtins: `fs`, `path`, `os`
- `require('fs')` / `require('path')` return native modules backed by `std/fs` / `std/path`.
- `readFileSync`, `existsSync`, `writeFileSync`, `path.join/resolve/dirname/extname`.
- Effort: **1 session**, mostly mechanical mapping. Sync first; async fs waits on M3.

### M5 — EventEmitter + minimal streams
- `EventEmitter` (on/emit/once) — foundational for http and streams.
- `Readable`/`Writable` shim — enough for `req`/`res`. Node streams are a large API; build the
  10% express uses, log what's stubbed (no silent truncation).
- Effort: **1–2 sessions.** The likeliest place express surprises us.

### M6 — the network stack: `net` + `http`
- `require('net')` ⟶ `std/net` TCP; `require('http').createServer(cb)` ⟶ listener where each
  connection is a **green task** and the request/response objects wrap `std/http`'s parser.
- Milo pieces: `std/net` (TCP; note IPv4-only today — backlog #9) + `std/http` (parser) shipped.
- Effort: **2 sessions.** Binding, not building — the hard parts already exist in std.

### M7 — express boots
- With M1–M6, `express`/`cookie-parser`/`compression` are large *pure-JS* packages requiring
  only what now exists. Boot, bind a route, serve a request from the tahoeroads bundle.
- **Wall:** whatever express reaches for that M5's stream shim didn't cover — iterate against
  real failures, not guesses.
- Effort: **2–3 sessions**, dominated by stream/EventEmitter gaps surfacing under a real load.

## Critical path & honesty

M1 → M2 → M3 → (M4 ∥ M5) → M6 → M7. M4 and M5 parallelize. Rough total **10–14 sessions** to a
booting backend — but each milestone is independently demoable (M3 alone runs any timer-driven
JS; M6 alone serves a hand-written `http.createServer` with no express).

**Reuse, don't rebuild:** the network and IO layers exist in std. minibun is a *binding* effort,
not a from-scratch runtime — that's why it's tractable. Related: the user's [[node-milo]] work
binds a Node fork *from* Milo (opposite direction); its std-shim experience transfers.

**Where it could genuinely stall:** Node streams (M5) and the long tail of `Buffer` (M2). Both
are big APIs where "expressible" and "complete" diverge; scope to what the target hits and log
the rest. Everything else is mechanical or already built.

## Open questions
- Scope `Buffer` to target-driven subset, or bite the full API early? (lean: subset)
- macOS-only (system JSC) for the whole roadmap, or add Linux `libjavascriptcoregtk` at M6 when
  the network demo wants a server box? (lean: macOS through M7, Linux after)
- Reuse node-milo's std bindings where they overlap, or keep minibun a clean pure-Milo host?
