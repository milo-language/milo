# Pending QuickJS correctness fixes (validated, not yet landed)

Three wrong-answer bug fixes root-caused and validated by a subagent against a
working copy (full milojs suite green + fuzzed vs bun), preserved here to land
carefully — each touches the shared `eval.milo` and one touches the engine's
program model, so they were deferred rather than landed hastily. `proposed.diff`
is the full 6-fix patch; the first three (number-to-string, string escapes) are
ALREADY LANDED (`bb7628c`, `37e7e67`) — apply only the hunks for the three below.

## Landing caveats (from the subagent)
- The diff was taken against a copy: it rewrites `from "examples/apps/milojs/…"`
  imports to `./…` so the copy built standalone — **do NOT land those import
  lines** (~17 of them, in eval.milo/napi.milo).
- Apply, then build BOTH binaries, run `tests/run.sh` (76+ fixtures incl. the
  tahoeroads self-fetch guard) AND the app smoke, per fix.

## Remaining pending fixes (#3 Map.forEach LANDED, #5 array holes LANDED)

### #6 Proxy ownKeys/getOwnPropertyDescriptor for for-in and Object.keys
Adds `proxyOwnEnumKeys` wired into for-in + NATIVE_OBJECT_KEYS. **Requires the
engine (`milojs-engine.milo`) to run on the global `gProg`** (like the runtime
already does) so a native can invoke the user trap callback. That engine change
is adjacent to the reverted R1b attempt — verify the full async/fetch fixtures
AND the tahoeroads self-fetch guard do not hang. **Highest risk.** Fixture:
fixtures/proxyOwnKeys.
