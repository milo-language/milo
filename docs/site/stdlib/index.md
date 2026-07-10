# Standard Library

Import modules with `from "std/<name>" import { symbols }`.

## I/O & Filesystem

| Module | What it provides |
|--------|-----------------|
| [`std/io`](io) | `readFile`, `readStdin`, `File.openRead`/`.openWrite`/`.openAppend`, `f.readAll()`, `f.writeAll()`, RAII file handles |
| [`std/fs`](fs) | `readDir`, `fileInfo`, `isDir`/`isFile`, `pathExists`, `writeFile` |
| [`std/path`](path) | `pathJoin`, `pathBasename`, `pathDirname`, `pathExt`, `pathStem` |
| [`std/env`](env) | `getEnv`, `getEnvOr` |

## Networking

| Module | What it provides |
|--------|-----------------|
| [`std/net`](net) | TCP, DNS, `fetch` with TLS |
| [`std/http`](http) | HTTP server with Hono-style router, context, middleware |

## Data

| Module | What it provides |
|--------|-----------------|
| [`std/json`](json) | Zero-copy JSON parser — `jsonParse`, keyed accessors (`.str()`, `.i64()`, `.f64()`, `.bool()`), `jsonStringify` |
| [`std/arena`](arena) | Generational arena for cyclic/graph data with safe `Handle<T>` |
| [`std/set`](set) | `HashSet<T>` — add, contains, remove |

## CLI & System

| Module | What it provides |
|--------|-----------------|
| [`std/argparse`](argparse) | CLI argument parsing with typed getters and `--help` generation |
| [`std/args`](args) | Raw CLI arguments — `args()`, `getFlag`, `hasFlag` |
| [`std/process`](process) | Command execution, `Process.spawn`/`.wait()`/`.signal()`, `run`, `capture` |
| [`std/signal`](signal) | POSIX signal handling — `onSignal`, `ignoreSignal` |

## Data Formats

| Module | What it provides |
|--------|-----------------|
| [`std/csv`](csv) | CSV parsing with header support |
| [`std/toml`](toml) | TOML config parsing — `tomlParse`, `.str()`, `.i64()`, `.table()` |
| [`std/base64`](base64) | Base64 encode/decode |
| [`std/hex`](hex) | Hex encode/decode |

## Date, Time & IDs

| Module | What it provides |
|--------|-----------------|
| [`std/time`](time) | Wall clock, monotonic timing, sleep |
| [`std/datetime`](datetime) | Date/time from epoch — `dateTimeNow`, `dateTimeFormat`, `weekdayName` |
| [`std/uuid`](uuid) | UUID v4 generation |

## Concurrency

| Module | What it provides |
|--------|-----------------|
| `std/runtime` | `Task.spawn`, `Promise` / `Promise.blocking`, green scheduler |
| [`std/sync`](sync) | `Channel`, `WaitGroup`, `AtomicI64`, `AtomicBool` — all method-based |

## Database & Network

| Module | What it provides |
|--------|-----------------|
| [`std/sqlite`](sqlite) | SQLite3 bindings — `dbOpen`, `dbQuery`, `dbExec`, prepared statements |
| [`std/url`](url) | URL parsing — `urlParse`, `urlQueryGet` |

## Strings & Formatting

| Module | What it provides |
|--------|-----------------|
| [`std/string`](string) | `strContains`, `strSplit`, `strReplace`, `strTrim`, case conversion |
| [`std/fmt`](fmt) | Template formatting (`fmt1`–`fmt4`), `padLeft`/`padRight`, `join` |
| [`std/strconv`](strconv) | `parseInt`, `parseFloat`, radix conversions, `formatFloat` |
| [`std/unicode`](unicode) | Character classification — `isDigit`, `isAlpha`, `toLowerChar` |

## Math & Random

| Module | What it provides |
|--------|-----------------|
| [`std/math`](math) | `abs`, `min`, `max`, `pow`, `sqrt`, `log`, trig functions |
| [`std/random`](random) | `randInt`, `randFloat`, `randRange`, `shuffleI64` |

## Utilities

| Module | What it provides |
|--------|-----------------|
| [`std/color`](color) | ANSI terminal colors — `red`, `green`, `bold`, etc. |
| [`std/regex`](regex) | Regular expression matching — `regexNew`, `regexMatch`, `regexFind` |
| [`std/sort`](sort) | Sorting for Vec — `sortI32`, `sortI64`, `sortStrings` |
| [`std/testing`](testing) | `assert`, `assertEqual`, `assertStrEqual` |
| [`std/log`](log) | Leveled logging to stderr — `logDebug`, `logInfo`, `logWarn`, `logError` |
| [`std/crypto`](crypto) | `sha256`, `md5` hashing |
| [`std/mem`](mem) | `mmapAnon`, `mmapFile`, bump-allocator arena |

## HTTP Server Example

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn homeHandler(ctx: &mut Context): Response {
    return ctx.html("<h1>Hello!</h1>")
}

fn jsonHandler(ctx: &mut Context): Response {
    let name = ctx.query("name")
    return ctx.json($"\{\"hello\": \"{name}\"}")
}

fn main(): i32 {
    var r: Router = Router.new()
    r.get("/", homeHandler)
    r.get("/api", jsonHandler)
    serveRouter(8080, r)
    return 0
}
```

## Arena Example

For cyclic data (graphs, doubly-linked lists), use `std/arena`. Nodes reference each other via `Handle<T>` — typed indices — instead of pointers:

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaModify }

struct DLNode {
    value: i64,
    prev: Option<Handle<DLNode>>,
    next: Option<Handle<DLNode>>,
}

fn main(): i32 {
    var arena: Arena<DLNode> = arenaNew()
    let a = arenaAlloc(arena, DLNode { value: 1, prev: Option.None, next: Option.None })
    let b = arenaAlloc(arena, DLNode { value: 2, prev: Option.Some(a), next: Option.None })
    arenaModify(arena, a, (n: DLNode) => {
        var updated = n
        updated.next = Option.Some(b)
        return updated
    })
    return 0
}
```
