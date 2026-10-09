// Gate: no safe pub std fn takes or returns a raw pointer unless it is on the allowlist.
//
// Safe code can make a raw pointer (`0 as *u8` needs no unsafe, and std hands pointers
// out through `Channel.rawPtr()`, `Task.raw()` and friends), so a safe fn that reads,
// writes, frees or hands its pointer parameter to C is an unchecked dereference reachable
// from safe code: `rtWriteI64(0 as *u8, 4096, 7)` was an arbitrary write, and
// `replayHeapFree(p)` twice a double free. Such a fn must be `@unsafe` (or not pub).
//
// A fn that only RETURNS a pointer, or only stores or compares one, can stay safe, as
// Rust's `as_ptr` is: every way to use the pointer (a deref, a pointer cast, an extern
// call, CStr.wrap, the `_cstrToString`-style builtins) needs unsafe. Each such fn is
// listed below with the reason it is safe, so a new pointer API is a decision on the
// record rather than a silence.
//
// Read through `milo api --json --internal` (tooling reads the JSON surface, not src/):
// `--internal` adds the `// @internal` fns, which are pub and so reachable from any
// program. Known blind spot: names starting with `_` are left out of the api listing,
// though methods spelled that way are callable (`Select._node`, which only returns one).
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// "module name" -> why it is safe. Platform arms are listed per arm, as the JSON names them.
const ALLOWED: Record<string, string> = {
  "std/cstr CStr.ptr": "returns the address of a CStr made by the @unsafe CStr.wrap; using it needs unsafe",
  "std/dl Lib.sym": "returns a symbol's address; calling it needs a cast to an extern fn type, which needs unsafe",
  "std/platform.darwin environBlock": "returns libc's environ block; reading it needs unsafe",
  "std/platform.linux environBlock": "returns libc's environ block; reading it needs unsafe",
  "std/platform.wasm environBlock": "returns null on wasm; reading it needs unsafe",
  "std/platform.windows environBlock": "returns the CRT's environ block; reading it needs unsafe",
  "std/process.windows buildCmdLine": "returns a fresh malloc'd command line built from strings; using it needs unsafe",
  "std/replay ReplayCall.outCopy": "returns a fresh malloc'd copy of a recorded output; using it needs unsafe",
  "std/replay replayHeapMalloc": "returns a fresh allocation, like malloc; using it needs unsafe",
  "std/replay replayHeapMap": "returns fresh pages or null; using them needs unsafe",
  "std/runtime Task.raw": "returns the task's opaque handle for the @unsafe schedulerUnpark",
  "std/runtime schedulerCurrent": "returns the running task's opaque handle (or null) for the @unsafe schedulerUnpark",
  "std/runtime selectStateNew": "returns a fresh SelectState; every fn that reads one is @unsafe",
  "std/sqlite Database.handle": "returns the sqlite3* for C; using it needs an extern call, which needs unsafe",
  "std/sqlite Statement.handle": "returns the sqlite3_stmt* for C; using it needs an extern call, which needs unsafe",
  "std/sync Channel.rawPtr": "returns the queue's address for std/select; every fn that reads one is @unsafe",
};

// A raw pointer type anywhere in the text: `*u8`, `**u8`, `Result<*u8, string>`.
const RAW_PTR = /(^|[<(,&\s\[])\*/;

interface Entry { kind: string; module: string; name: string; params?: { name: string; type: string }[]; returns?: string; attributes?: string[] }

function pointerFns(): Entry[] {
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "api", "--json", "--internal"], {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  const entries: Entry[] = JSON.parse(out).entries;
  return entries.filter(e => e.kind === "function"
    && ((e.params ?? []).some(p => RAW_PTR.test(p.type)) || RAW_PTR.test(e.returns ?? "")));
}

test("every safe pub std fn with a raw-pointer parameter or return is allowlisted", () => {
  const fns = pointerFns();
  // The listing reaching the pointer fns at all: an attribute or param parse that broke
  // would otherwise pass this gate by finding nothing.
  expect(fns.length).toBeGreaterThan(50);
  expect(fns.some(e => e.name === "rtWriteI64" && e.attributes?.includes("unsafe"))).toBe(true);

  const unlisted = fns
    .filter(e => !e.attributes?.includes("unsafe"))
    .map(e => `${e.module} ${e.name}`)
    .filter(k => !(k in ALLOWED));
  expect(unlisted).toEqual([]);
});

test("no allowlist entry is stale", () => {
  const safe = new Set(pointerFns().filter(e => !e.attributes?.includes("unsafe")).map(e => `${e.module} ${e.name}`));
  expect(Object.keys(ALLOWED).filter(k => !safe.has(k))).toEqual([]);
});

test("an allowlisted fn takes no raw-pointer parameter", () => {
  // The allowlist is for fns that hand a pointer OUT. One that takes a pointer in has to
  // read, write, free or pass it on, and belongs behind @unsafe.
  const takers = pointerFns()
    .filter(e => `${e.module} ${e.name}` in ALLOWED)
    .filter(e => (e.params ?? []).some(p => RAW_PTR.test(p.type)))
    .map(e => `${e.module} ${e.name}`);
  expect(takers).toEqual([]);
});
