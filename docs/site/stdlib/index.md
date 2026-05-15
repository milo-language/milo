# Standard Library

All modules are imported with `import "std/<name>"`.

## I/O & Filesystem

| Module | What it provides |
|--------|-----------------|
| `std/io` | `read_file`, `read_stdin`, `open_read`/`open_write`/`open_append`, `read_all`, `write_all`, RAII file handles |
| `std/fs` | `read_dir`, `file_info`, `is_dir`/`is_file`, `path_exists`, `write_file` |
| `std/path` | `path_join`, `path_basename`, `path_dirname`, `path_ext`, `path_stem` |
| `std/env` | `get_env`, `get_env_or` |

## Networking

| Module | What it provides |
|--------|-----------------|
| `std/net` | TCP, DNS, `fetch` with TLS |
| `std/http` | HTTP server with routing, response types |

## Data

| Module | What it provides |
|--------|-----------------|
| `std/json` | View-based JSON parser |
| `std/arena` | Generational arena for cyclic/graph data with safe `Handle<T>` |

## CLI & System

| Module | What it provides |
|--------|-----------------|
| `std/argparse` | CLI argument parsing with typed getters and `--help` generation |
| `std/process` | Command execution, `spawn`/`wait_for`/`signal` |

## HTTP Server Example

```milo
from "std/http" import { Request, Response, serve }

struct Route {
    method: string,
    prefix: string,
    handler: (&Request) => Response,
}

fn dispatch(routes: &Vec<Route>, req: &Request): Response {
    var i: i64 = 0
    while i < routes.len {
        let r = routes[i]
        if req.method == r.method && req.path == r.prefix {
            return r.handler(req)
        }
        i = i + 1
    }
    return Response.NotFound
}

fn main(): i32 {
    let routes: Vec<Route> = [
        Route { method: "GET", prefix: "/",     handler: (r: &Request) => Response.Html("<h1>Hello!</h1>") },
        Route { method: "GET", prefix: "/json", handler: (r: &Request) => Response.Json("{\"ok\": true}") },
    ]
    serve(8080, (req: &Request) => dispatch(routes, req))
    return 0
}
```

## Arena Example

For cyclic data (graphs, doubly-linked lists), use `std/arena`. Nodes reference each other via `Handle<T>` — typed indices — instead of pointers:

```milo
import "std/arena"

struct DLNode {
    value: i64,
    prev: Option<Handle<DLNode>>,
    next: Option<Handle<DLNode>>,
}

fn main(): i32 {
    var arena: Arena<DLNode> = arena_new()
    let a = arena_alloc(arena, DLNode { value: 1, prev: Option.None, next: Option.None })
    let b = arena_alloc(arena, DLNode { value: 2, prev: Option.Some(a), next: Option.None })
    arena_modify(arena, a, (n: DLNode) => {
        var updated = n
        updated.next = Option.Some(b)
        return updated
    })
    return 0
}
```
