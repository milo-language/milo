# Standard Library

Import modules with `from "std/<name>" import { symbols }`.

## I/O & Filesystem

| Module | What it provides |
|--------|-----------------|
| `std/io` | `readFile`, `readStdin`, `openRead`/`openWrite`/`openAppend`, `readAll`, `writeAll`, RAII file handles |
| `std/fs` | `readDir`, `fileInfo`, `isDir`/`isFile`, `pathExists`, `writeFile` |
| `std/path` | `pathJoin`, `pathBasename`, `pathDirname`, `pathExt`, `pathStem` |
| `std/env` | `getEnv`, `getEnvOr` |

## Networking

| Module | What it provides |
|--------|-----------------|
| `std/net` | TCP, DNS, `fetch` with TLS |
| `std/http` | HTTP server with routing, response types |

## Data

| Module | What it provides |
|--------|-----------------|
| `std/json` | Zero-copy JSON parser — `jsonParse`, keyed accessors (`.str()`, `.i64()`, `.f64()`, `.bool()`), `jsonStringify` |
| `std/arena` | Generational arena for cyclic/graph data with safe `Handle<T>` |

## CLI & System

| Module | What it provides |
|--------|-----------------|
| `std/argparse` | CLI argument parsing with typed getters and `--help` generation |
| `std/process` | Command execution, `spawn`/`waitFor`/`signal` |
| `std/signal` | POSIX signal handling — `onSignal`, `ignoreSignal` |

## Data Formats

| Module | What it provides |
|--------|-----------------|
| `std/csv` | CSV parsing with header support |
| `std/toml` | TOML config parsing — `tomlParse`, `.str()`, `.i64()`, `.table()` |
| `std/base64` | Base64 encode/decode |
| `std/hex` | Hex encode/decode |

## Date, Time & IDs

| Module | What it provides |
|--------|-----------------|
| `std/time` | Wall clock, monotonic timing, sleep |
| `std/datetime` | Date/time from epoch — `dateTimeNow`, `dateTimeFormat`, `weekdayName` |
| `std/uuid` | UUID v4 generation |

## Concurrency

| Module | What it provides |
|--------|-----------------|
| `std/thread` | `spawn`, `threadJoin` |
| `std/sync` | `Mutex`, `Channel` — thread-safe primitives |

## Database & Network

| Module | What it provides |
|--------|-----------------|
| `std/sqlite` | SQLite3 bindings — `dbOpen`, `dbQuery`, `dbExec`, prepared statements |
| `std/url` | URL parsing — `urlParse`, `urlQueryGet` |

## Utilities

| Module | What it provides |
|--------|-----------------|
| `std/color` | ANSI terminal colors — `red`, `green`, `bold`, etc. |
| `std/math` | `abs`, `min`, `max`, `pow`, `sqrt`, `log`, trig functions |
| `std/random` | `randomInt`, `randomFloat`, `randomRange` |
| `std/regex` | Regular expression matching |
| `std/sort` | Sorting for Vec — `sortI32`, `sortF64`, `sortStrings` |
| `std/testing` | `assert`, `assertEqual`, `assertStrEqual` |

## HTTP Server Example

```milo
from "std/http" import { Request, Response, serve }

struct Route {
    method: string,
    prefix: string,
    handler: (&Request) => Response,
}

fn dispatch(routes: &Vec<Route>, req: &Request): Response {
    for r in routes {
        if r.method == req.method && r.prefix == req.path {
            return r.handler(req)
        }
    }
    return Response.NotFound
}

fn main(): i32 {
    let routes: Vec<Route> = [
        Route { method: "GET", prefix: "/",     handler: (r: &Request) => Response.Html("<h1>Hello!</h1>") },
        Route { method: "GET", prefix: "/json", handler: (r: &Request) => Response.Json("{\"ok\": true}") },
    ]
    serve(8080, (req: &Request) => {
        return dispatch(routes, req)
    })
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
