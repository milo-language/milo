---
layout: home
hero:
  name: Milo
  text: "Rust's safety. Go's simplicity."
  tagline: "A native systems language with ownership, green threads, and zero lifetime annotations. Within 5% of C. 10K concurrent connections without async/await."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/

features:
  - title: One Rule Replaces Lifetimes
    details: "References can't escape the function they're passed to. That's the entire ownership model. No borrow checker fights, no 'a: 'b, no lifetime annotations anywhere."
  - title: Faster Than Go, Tracks C
    details: "Beats C on 3/9 benchmarks (binary trees, matmul, startup). Within 3-5% on the rest. Sub-millisecond startup, binaries under 300KB. LLVM backend."
  - title: 10K Connections, No async/await
    details: "Green threads with 64KB stacks. I/O automatically yields in green thread context — same read() call works everywhere. No function coloring, no Future types."
  - title: Five Safety Guarantees
    details: "Memory (ownership + bounds checks), null (Option<T>), races (Send/Sync), overflow (compile-time + runtime), coercion (no implicit conversions). All enforced at compile time."
---

### Familiar syntax, serious guarantees

```milo
fn main(): i32 {
    var names: Vec<string> = Vec.new()
    names.push("alice")
    names.push("bob")

    let loud = names.map((n: &string) => n.toUpper())
    for name in loud {
        print(name)
    }

    return 0
}   // names and loud freed here — no GC, no manual free
```

### Concurrent I/O without colored functions

```milo
from "std/runtime" import { greenSpawn, schedulerWaitRead }
from "std/event" import { setNonblocking }

// Accept loop in a green thread — yields on EAGAIN, resumes when fd is ready
greenSpawn(move (): void => {
    setNonblocking(serverFd)
    while true {
        let clientFd = accept(serverFd, ...)
        if clientFd < 0 && getErrno() == eagain() {
            schedulerWaitRead(serverFd)   // yield, not block
            continue
        }
        greenSpawn(move (): void => {
            handleClient(clientFd)        // each client in its own green thread
        })
    }
})
```

No `async`, no `await`, no `Future<T>`. The same `read()` call blocks in an OS thread and yields in a green thread. Your code doesn't change.

### Real programs

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r: Router = Router.new()
    r.use((ctx: &mut Context, next: (&mut Context) => Response) => {
        print(ctx.req.method + " " + ctx.req.path)
        return next(ctx)
    })
    r.get("/", (ctx: &mut Context) => ctx.html("<h1>Hello!</h1>"))
    r.get("/users/:id", (ctx: &mut Context) => {
        return ctx.json($"\{\"id\": \"{ctx.param(\"id\")}\"}")
    })
    serveRouter(8080, r)
    return 0
}
```

Router, middleware, path params, string interpolation — a full web server in 15 lines.

### Where Milo fits

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native | Async w/o coloring |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | no |
| Rust | no | yes | yes | yes | no |
| Zig | no | no | no | yes | no |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

</div>
